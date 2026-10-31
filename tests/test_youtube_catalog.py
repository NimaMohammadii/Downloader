import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
import os
import warnings
from http.cookiejar import MozillaCookieJar

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_pipeline as pipeline


class YoutubeCookieTests(unittest.TestCase):
    raw = ('# Netscape HTTP Cookie File\n'
           '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-session-fixture\n'
           '.example.com\tTRUE\t/\tTRUE\t0\tSID\tunrelated-fixture\n')

    def command(self):
        return [pipeline.app.REAL_YTDLP, '--extractor-args', 'youtube:player_client=default',
                '--', 'https://www.youtube.com/watch?v=fixture']

    def test_private_netscape_jar_is_scoped_to_youtube_and_removed(self):
        original = self.command()
        with patch.dict(os.environ, {'YOUTUBE_COOKIES': self.raw}):
            with pipeline.youtube_cookie_command(original) as command:
                path = Path(command[command.index('--cookies') + 1])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                jar = MozillaCookieJar(str(path)); jar.load(ignore_discard=True)
                self.assertEqual([(c.name, c.value) for c in jar], [('SID', 'private-session-fixture')])
                self.assertLess(command.index('--cookies'), command.index('--'))
                self.assertNotIn('private-session-fixture', ' '.join(command))
            self.assertFalse(path.exists())
        self.assertNotIn('--cookies', original)

    def test_missing_cookie_and_other_downloaders_keep_their_arguments(self):
        for raw, command in [('', self.command()), (self.raw, [pipeline.app.REAL_YTDLP, '--use-extractors', 'Generic']),
                             (self.raw, ['ffprobe', 'file.mp4'])]:
            with patch.dict(os.environ, {'YOUTUBE_COOKIES': raw}), pipeline.youtube_cookie_command(command) as result:
                self.assertIs(result, command)

    def test_invalid_cookie_error_does_not_disclose_the_secret(self):
        for raw in ['bad-private-secret', '# Netscape HTTP Cookie File\n.youtube.com\tINVALID\tprivate-secret',
                    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tprivate-secret\n']:
            with patch.dict(os.environ, {'YOUTUBE_COOKIES': raw}), warnings.catch_warnings(record=True) as emitted:
                with self.assertRaises(pipeline.app.UserVisibleError) as error:
                    with pipeline.youtube_cookie_command(self.command()):
                        self.fail('invalid cookies accepted')
                self.assertNotIn('private-secret', str(error.exception))
                self.assertEqual(emitted, [])

    def test_overlapping_calls_have_independent_jars_and_cleanup_on_failure(self):
        with patch.dict(os.environ, {'YOUTUBE_COOKIES': self.raw}):
            with pipeline.youtube_cookie_command(self.command()) as first:
                a = Path(first[first.index('--cookies') + 1])
                with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                    with pipeline.youtube_cookie_command(self.command()) as second:
                        b = Path(second[second.index('--cookies') + 1])
                        self.assertNotEqual(a, b)
                        b.write_text('modified by yt-dlp')
                        self.assertIn('private-session-fixture', a.read_text())
                        raise RuntimeError('fixture failure')
                self.assertFalse(b.exists())
                self.assertTrue(a.exists())
            self.assertFalse(a.exists())

    def test_extension_domain_flag_is_preserved_when_leading_dot_disagrees(self):
        raw = ('# Netscape HTTP Cookie File\r'
               '#HttpOnly_youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-secret\r'
               '.www.youtube.com\tFALSE\t/\tTRUE\t0\tHOST\thost-secret\r')
        with patch.dict(os.environ, {'YOUTUBE_COOKIES': raw}), warnings.catch_warnings(record=True) as emitted:
            with pipeline.youtube_cookie_command(self.command()) as command:
                jar = MozillaCookieJar(command[command.index('--cookies') + 1])
                jar.load(ignore_discard=True)
                self.assertEqual([(c.domain, c.domain_specified) for c in jar],
                                 [('.youtube.com', True), ('www.youtube.com', False)])
                self.assertEqual(emitted, [])

    def test_errors_distinguish_format_domain_expiry_and_storage_without_secrets(self):
        fixtures = [
            ('[{"value":"private-secret"}]', 'reason=json', 'قالب'),
            ('# Netscape HTTP Cookie File\n.youtube.com private-secret', 'reason=columns', 'خط 2'),
            ('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tSID\tprivate-secret', 'reason=no_youtube_cookies', 'پیدا نشد'),
            ('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tprivate-secret', 'reason=expired', 'منقضی'),
        ]
        for raw, reason, message in fixtures:
            output = io.StringIO()
            with patch.dict(os.environ, {'YOUTUBE_COOKIES': raw}), redirect_stdout(output):
                with self.assertRaises(pipeline.app.UserVisibleError) as error:
                    with pipeline.youtube_cookie_command(self.command()):
                        self.fail('invalid cookie accepted')
            self.assertIn(reason, output.getvalue())
            self.assertIn(message, str(error.exception))
            self.assertNotIn('private-secret', output.getvalue() + str(error.exception))

    def test_startup_reports_configuration_without_contacting_youtube_or_leaking_values(self):
        for raw, status in [('', 'missing'), (self.raw, 'ready'), ('private-secret', 'invalid')]:
            with patch.dict(os.environ, {'YOUTUBE_COOKIES': raw}), \
                 redirect_stdout(io.StringIO()) as output, patch.object(subprocess, 'Popen') as process:
                pipeline.report_youtube_cookie_status()
            self.assertIn(f'status={status} validator=2', output.getvalue())
            self.assertNotIn('private-secret', output.getvalue())
            self.assertNotIn('private-session-fixture', output.getvalue())
            process.assert_not_called()
        with patch.dict(os.environ, {'YOUTUBE_COOKIES': self.raw}), \
             patch.object(Path, 'write_text', side_effect=OSError('private-secret')), redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(pipeline.app.UserVisibleError) as error:
                with pipeline.youtube_cookie_command(self.command()):
                    self.fail('storage failure ignored')
            self.assertIn('reason=storage', output.getvalue())
            self.assertNotIn('private-secret', output.getvalue() + str(error.exception))


class CatalogTests(unittest.TestCase):
    def test_normal_page_and_deno_are_used_for_quality_catalog(self):
        # ai-configa inspects the normal page with Deno; skipping webpage/configs
        # without matching visitor data removes session setup used by extraction.
        with patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, '{"id":"video"}', '')) as run:
            pipeline._fetch_metadata_for_client('https://www.youtube.com/watch?v=video', 'web_embedded')
        command = run.call_args.args[0]
        self.assertIn('--ignore-config', command)
        self.assertEqual(command[command.index('--js-runtimes') + 1], 'deno')
        self.assertIn('youtube:player_client=web_embedded', command)
        self.assertFalse(any('player_skip' in arg or 'youtubepot' in arg for arg in command))
        self.assertNotIn('--max-filesize', command)

    def test_bot_check_does_not_prevent_trying_bounded_compatibility_client(self):
        metadata = {'id': 'video', 'title': 'test'}
        first = pipeline.ClientAttemptError('default', 'botcheck', 'verification required')
        with patch.object(pipeline, '_fetch_metadata_for_client', side_effect=[first, metadata]) as fetch, \
             patch.object(pipeline.app, 'validate_video_metadata'), \
             patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, '_save_session') as save:
            result = pipeline.inspect_video('https://www.youtube.com/watch?v=video')
        self.assertTrue(result['ok'])
        self.assertEqual(result['qualities'], [720])
        self.assertEqual([call.args[1] for call in fetch.call_args_list], ['default', 'web_embedded'])
        save.assert_called_once_with(metadata, 'web_embedded')

    def test_private_video_is_not_retried_as_bot_check(self):
        error = pipeline.ClientAttemptError('web_embedded', 'private', 'Private video')
        with patch.object(pipeline, '_fetch_metadata_for_client', side_effect=error) as fetch:
            result = pipeline.inspect_video('url')
        self.assertFalse(result['ok'])
        self.assertEqual(fetch.call_count, 1)

    def test_webpage_warning_does_not_turn_bot_check_into_age_restriction(self):
        category, _ = pipeline._classify_ytdlp_error("Downloading webpage\nSign in to confirm you're not a bot")
        self.assertEqual(category, 'botcheck')
        category, _ = pipeline._classify_ytdlp_error('Sign in to confirm your age. Age-restricted video')
        self.assertEqual(category, 'age')

    def test_download_reuses_catalog_client(self):
        with patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, '_load_session_client', return_value='web_safari'), \
             patch.object(pipeline, '_source_ratio', return_value=None), \
             patch.object(pipeline, '_download_video_with_client', return_value=Path('/tmp/video.mp4')) as download:
            pipeline.download_video('url', Path('/tmp'), 720, {})
        self.assertEqual(download.call_args.args[1], 'web_safari')

    def test_download_flags_keep_whole_file_integrity_and_cap(self):
        command = pipeline._download_args('web_safari')
        self.assertIn('--abort-on-unavailable-fragments', command)
        self.assertEqual(command[command.index('--max-filesize') + 1], '2000000000')


    def test_muxed_size_includes_audio_and_is_marked_as_estimate(self):
        size = pipeline._selection_size({'duration': 60, 'requested_formats': [
            {'filesize': 20_000_000}, {'filesize': 1_000_000},
        ]})
        self.assertEqual(size, {'bytes': 21_000_000, 'estimated': True})

    def test_converted_audio_uses_output_bitrate_instead_of_source_size(self):
        size = pipeline._selection_size({'duration': 60, 'ext': 'webm', 'filesize': 9_000_000}, 'low')
        self.assertEqual(size, {'bytes': 480_000, 'estimated': True})
        self.assertIsNone(pipeline._selection_size({'duration': 60}))

    def test_size_selection_uses_cached_metadata_without_network_checks(self):
        selected = {'duration': 60, 'filesize': 12_000_000}
        with patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, 'audio_formats', return_value=[]), \
             patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, json.dumps(selected), '')) as run:
            sizes = pipeline.quality_sizes({'id': 'video'})
        command = run.call_args.args[0]
        self.assertIn('--load-info-json', command)
        self.assertIn('--no-check-formats', command)
        self.assertIn('res:720,+codec:avc:m4a,ext:mp4:m4a', command)
        self.assertEqual(sizes['720']['bytes'], 12_000_000)


class RecoveryTests(unittest.TestCase):
    url = 'https://www.youtube.com/watch?v=abcdefghijk'

    def metadata(self):
        return {'id':'abcdefghijk','title':'Fixture','duration':1,'extractor_key':'Youtube',
                'formats':[{'format_id':'18','url':'https://rr.example.googlevideo.com/video?expire=1',
                            'ext':'mp4','protocol':'https','width':640,'height':360,'vcodec':'h264','acodec':'aac'}]}

    def test_maintained_upstream_policy_is_first_and_tls_verification_is_preserved(self):
        self.assertEqual(pipeline.CLIENTS[0],'default')
        args=pipeline._client_args('default')
        self.assertIn('youtube:player_client=default',args)
        self.assertEqual(args[args.index('--extractor-retries')+1],'1')
        self.assertNotIn('--no-check-certificates',args)

    def test_warm_catalog_reuses_only_matching_video_and_client_without_player_requests(self):
        with patch.object(pipeline.app,'CATALOG_CACHE',{}):
            with pipeline.app.request_cache(self.url):pipeline._save_session(self.metadata(),'default')
            expires=pipeline.app.CATALOG_CACHE[self.url][0]
            with pipeline.app.request_cache(self.url),patch.object(pipeline,'_fetch_metadata_for_client') as fetch:
                self.assertEqual(pipeline.fetch_metadata(self.url)['id'],'abcdefghijk')
                fetch.assert_not_called()
                with tempfile.TemporaryDirectory() as directory:
                    args=pipeline._download_input(self.url,'default',Path(directory),False)
                    self.assertEqual(args[0],'--load-info-json')
                    self.assertEqual(pipeline._download_input(self.url,'web_embedded',Path(directory),False),[self.url])
                    self.assertEqual(pipeline._download_input(self.url.replace('abcdefghijk','bbbbbbbbbbb'),'default',Path(directory),False),[self.url.replace('abcdefghijk','bbbbbbbbbbb')])
            self.assertEqual(pipeline.app.CATALOG_CACHE[self.url][0],expires)

    def test_cached_403_refreshes_once_then_falls_back_without_reusing_stale_catalog(self):
        commands=[]
        def fail(command,timeout):
            commands.append(command)
            raise subprocess.CalledProcessError(1,command,stderr='HTTP Error 403: Forbidden')
        with patch.object(pipeline.app,'CATALOG_CACHE',{}):
            with pipeline.app.request_cache(self.url):pipeline._save_session(self.metadata(),'default')
            with pipeline.app.request_cache(self.url),tempfile.TemporaryDirectory() as directory,patch.object(pipeline,'_run',side_effect=fail):
                with self.assertRaises(pipeline.ClientAttemptError):
                    pipeline._download_video_with_client(self.url,'default',Path(directory),360,None)
                self.assertFalse(pipeline.app.metadata_cache_path().exists())
            self.assertNotIn(self.url,pipeline.app.CATALOG_CACHE)
        self.assertEqual(len(commands),2);self.assertIn('--load-info-json',commands[0]);self.assertNotIn('--load-info-json',commands[1]);self.assertEqual(commands[1][-1],self.url)

    def test_cached_audio_403_refreshes_once_and_never_publishes_partial_audio(self):
        calls=[]
        def fail(command,timeout):
            calls.append(command)
            raise subprocess.CalledProcessError(1,command,stderr='HTTP Error 403: Forbidden')
        with pipeline.app.request_cache(),tempfile.TemporaryDirectory() as directory,patch.object(pipeline,'_run',side_effect=fail):
            pipeline._save_session(self.metadata(),'default')
            with self.assertRaises(pipeline.ClientAttemptError):pipeline._download_audio_with_client(self.url,'default',Path(directory),'hq')
            self.assertFalse((Path(directory)/'Vexa.m4a').exists())
        self.assertEqual(len(calls),2);self.assertIn('--load-info-json',calls[0]);self.assertEqual(calls[1][-1],self.url)

    def test_real_rate_limit_stops_immediate_client_retries(self):
        error=pipeline.ClientAttemptError('default','rate_limit','rate limited')
        with patch.object(pipeline,'_fetch_metadata_for_client',side_effect=error) as fetch:
            with self.assertRaisesRegex(pipeline.app.UserVisibleError,'rate limited'):pipeline.fetch_metadata(self.url)
        fetch.assert_called_once()

    def test_classification_does_not_mislabel_formats_age_or_403_as_ip_block(self):
        for error,expected in [('No video formats found!','format'),('HTTP Error 429: Too Many Requests','rate_limit'),
                               ("This content isn't available, try again later",'session_limit'),
                               ('Signature extraction failed. Requested format is not available','challenge'),
                               ('Sign in to confirm your age','age'),('HTTP Error 403: Forbidden','forbidden')]:
            category,message=pipeline._classify_ytdlp_error(error)
            self.assertEqual(category,expected);self.assertNotIn('IP',message)
            self.assertEqual(pipeline.app.friendly_ytdlp_error(error),message)
        mixed=[pipeline.ClientAttemptError('default','botcheck','needs login'),pipeline.ClientAttemptError('web_embedded','format','missing format')]
        self.assertNotIn('تأیید ورود',pipeline._final_attempt_message(mixed,'fallback'))

    def test_diagnostic_logs_never_contain_signed_urls_or_cookie_values(self):
        error=pipeline.ClientAttemptError('default','forbidden','denied','HTTP Error 403 https://cdn.example/file?token=hidden\nCookie: session=secret; other=private')
        with patch('builtins.print') as output:pipeline._log_attempt_failure('download',error)
        text=' '.join(str(c.args) for c in output.call_args_list)
        self.assertIn('category=forbidden',text)
        for value in ['token=hidden','session=secret','other=private']:self.assertNotIn(value,text)

    def test_real_cli_downloads_cached_video_and_audio_without_youtube_reextraction(self):
        if not shutil.which('yt-dlp'):self.skipTest('yt-dlp is required')
        app=pipeline.app
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/'fixture.mp4';audio=root/'fixture.m4a'
            subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','color=c=blue:s=640x360:r=10',
                '-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',str(video)],check=True)
            subprocess.run(['ffmpeg','-y','-v','error','-i',str(video),'-vn','-c:a','copy',str(audio)],check=True)
            class Quiet(SimpleHTTPRequestHandler):
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=root))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                data=self.metadata();data['formats'][0]['url']=f'http://127.0.0.1:{server.server_port}/fixture.mp4';data['formats'][0]['protocol']='http'
                data['formats'].append({'format_id':'140','url':f'http://127.0.0.1:{server.server_port}/fixture.m4a',
                    'protocol':'http','ext':'m4a','vcodec':'none','acodec':'aac','abr':128})
                with app.request_cache(),patch.object(app,'REAL_YTDLP',shutil.which('yt-dlp')):
                    pipeline._save_session(data,'default')
                    out=root/'out';out.mkdir()
                    file=pipeline.download_video(self.url,out,360,data)
                    self.assertGreater(app.probe_duration(file),0)
                    file=pipeline.download_audio(self.url,out,'hq')
                    self.assertEqual(file.read_bytes(),audio.read_bytes())
            finally:server.shutdown();server.server_close();thread.join()


if __name__ == '__main__':
    unittest.main()
