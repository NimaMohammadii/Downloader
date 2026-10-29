import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import types
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_pipeline as pipeline
original_video = pipeline.download_video
original_audio = pipeline.download_audio
import mini_async_entry as web


class WebPlayerTests(unittest.TestCase):
    url = 'https://www.youtube.com/watch?v=abcdefghijk'

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.fixture = cls.root / 'source.mp4'
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=10',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(cls.fixture)], check=True)
        cls.server = web.app.ThreadingHTTPServer(('127.0.0.1', 0), web.MiniAsyncHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
        cls.temp.cleanup()

    def metadata(self):
        return {'id': 'abcdefghijk', 'title': 'Shared engine fixture', 'duration': 1,
                'formats': [{'format_id': '18', 'url': 'https://cdn.example/fixture.mp4', 'ext': 'mp4',
                             'width': 640, 'height': 360, 'vcodec': 'h264', 'acodec': 'aac', 'protocol': 'https'}]}

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        data = json.dumps(body) if body is not None else None
        connection.request(method, path, body=data, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def final_event(self, data):
        return json.loads([event[6:] for event in data.decode().split('\n\n') if event.startswith('data: ')][-1])

    def test_import_keeps_original_download_functions(self):
        self.assertIs(original_video, pipeline.download_video)
        self.assertIs(original_audio, pipeline.download_audio)
        self.assertIs(web.pipeline, pipeline)
        self.assertIs(web.app.download_video, pipeline.download_video)
        self.assertIs(web.app.download_audio, pipeline.download_audio)

    def test_real_http_prepares_using_bot_engine_and_serves_decodable_ranges(self):
        commands = []
        def run(command, timeout):
            if command[0] == "ffprobe":
                return subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
            commands.append(command)
            output = Path(command[command.index('--output') + 1]).parent / 'downloaded.mp4'
            shutil.copyfile(self.fixture, output)
            return subprocess.CompletedProcess(command, 0, str(output), '')
        media_id = '1' * 32
        with patch.object(web.mini_pipeline, 'MINI_ROOT', self.root / 'web-files'), \
             patch.object(web.app, 'CATALOG_CACHE', {}), \
             patch.object(pipeline, '_fetch_metadata_for_client', return_value=self.metadata()) as metadata, \
             patch.object(pipeline, '_run', side_effect=run), \
             patch.object(web.app, 'telegram_call', side_effect=AssertionError('web must not send Telegram messages')):
            status, headers, body = self.call('POST', '/mini/watch/start', {'url': self.url, 'streamId': media_id})
            self.assertEqual(status, 200)
            self.assertIn('text/event-stream', headers['content-type'])
            result = self.final_event(body)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['quality'], 360)
            metadata.assert_called_once()
            self.assertEqual(len(commands), 1)
            self.assertIn('--load-info-json', commands[0])
            self.assertIn('--abort-on-unavailable-fragments', commands[0])
            self.assertEqual(commands[0][commands[0].index('--format') + 1], 'bv*+ba/b')
            self.assertIn('res:360,+codec:avc:m4a,ext:mp4:m4a', commands[0])
            status, headers, full = self.call('GET', '/mini/watch?streamId=' + media_id)
            self.assertEqual(status, 200)
            self.assertEqual(full, self.fixture.read_bytes())
            self.assertTrue(headers['content-disposition'].startswith('inline;'))
            self.assertEqual(headers['accept-ranges'], 'bytes')
            for value, expected in [('bytes=0-31', full[:32]), ('bytes=32-', full[32:]), ('bytes=-16', full[-16:])]:
                status, headers, data = self.call('GET', '/mini/watch?streamId=' + media_id, headers={'Range': value})
                self.assertEqual(status, 206); self.assertEqual(data, expected)
            status, headers, data = self.call('HEAD', '/mini/watch?streamId=' + media_id)
            self.assertEqual(status, 200); self.assertEqual(data, b''); self.assertEqual(int(headers['content-length']), len(full))
            status, headers, data = self.call('GET', '/mini/watch?streamId=' + media_id, headers={'Range': 'bytes=999999-'})
            self.assertEqual(status, 416); self.assertEqual(headers['content-range'], f'bytes */{len(full)}')
            served = self.root / 'served.mp4'; served.write_bytes(full)
            self.assertGreater(web.app.probe_duration(served), 0)

    def test_errors_use_original_engine_and_do_not_create_playable_manifest(self):
        media_id = '2' * 32
        error = pipeline.ClientAttemptError('default', 'private', 'Private fixture')
        with patch.object(web.mini_pipeline, 'MINI_ROOT', self.root / 'rejected'), \
             patch.object(web.app, 'CATALOG_CACHE', {}), \
             patch.object(pipeline, '_fetch_metadata_for_client', side_effect=error) as metadata:
            status, _, body = self.call('POST', '/mini/watch/start', {'url': self.url, 'streamId': media_id})
            result = self.final_event(body)
            self.assertFalse(result['ok']); self.assertIn('Private fixture', result['message'])
            metadata.assert_called_once()
            self.assertEqual(self.call('GET', '/mini/watch?streamId=' + media_id)[0], 404)
            self.assertNotIn('web-prepare', web.app.JOB_CAPACITY.jobs)

    def test_concurrent_preparation_is_rejected_without_replacing_running_job(self):
        entered, finish = threading.Event(), threading.Event()
        def blocked(url):
            entered.set(); finish.wait(5)
            raise web.app.UserVisibleError('deliberate stop')
        results = []
        with patch.object(pipeline, 'fetch_metadata', side_effect=blocked):
            thread = threading.Thread(target=lambda: results.append(self.call('POST', '/mini/watch/start', {'url': self.url, 'streamId': '3' * 32})))
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.call('POST', '/mini/watch/start', {'url': self.url, 'streamId': '4' * 32})[0], 409)
                self.assertIn('web-prepare', web.app.JOB_CAPACITY.jobs)
            finally:
                finish.set(); thread.join()
            self.assertFalse(self.final_event(results[0][2])['ok'])
            self.assertNotIn('web-prepare', web.app.JOB_CAPACITY.jobs)

    def test_invalid_watch_payload_and_unknown_media_never_reach_engine(self):
        with patch.object(pipeline, 'fetch_metadata') as metadata:
            self.assertEqual(self.call('POST', '/mini/watch/start', {'url': 'https://example.com', 'streamId': '5' * 32})[0], 400)
            self.assertEqual(self.call('GET', '/mini/watch?streamId=../../secret')[0], 404)
            metadata.assert_not_called()


class SubtitleTests(unittest.TestCase):
    file_id = '6' * 32
    video_id = 'abcdefghijk'
    vtt = b'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.object(web.mini_pipeline, 'MINI_ROOT', self.root)
        self.patch.start()
        self.cooldown = patch.object(web, 'SUBTITLE_RETRY_AT', 0.0)
        self.cooldown.start()
        directory = self.root / self.file_id; directory.mkdir()
        (directory / 'video.mp4').write_bytes(b'video')
        (directory / 'manifest.json').write_text(json.dumps({'fileId': self.file_id, 'fileName': 'video.mp4'}))

    def tearDown(self):
        self.cooldown.stop(); self.patch.stop(); self.temp.cleanup()

    def track(self, language='en', **extra):
        return {'ext': 'vtt', 'name': language, 'url': f'https://www.youtube.com/api/timedtext?v={self.video_id}&lang=en&fmt=vtt', **extra}

    def catalog(self):
        return {'id': self.video_id, 'http_headers': {'User-Agent': 'fixture-agent', 'Cookie': 'private-secret'},
                'subtitles': {'en': [self.track()]},
                'automatic_captions': {'en-orig': [self.track()], 'fa': [self.track('Persian', url=self.track()['url']+'&tlang=fa')]}}

    class Response:
        def __init__(self, data, status=200, headers=None):
            self.data, self.status_code, self.headers = data, status, headers or {}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_content(self, chunk_size):
            yield self.data

    def test_catalog_uses_existing_metadata_and_does_not_expose_source_urls(self):
        with patch.object(pipeline, '_fetch_metadata_for_client') as extract:
            tracks = web._save_subtitle_catalog(self.catalog(), self.file_id)
        extract.assert_not_called()
        self.assertEqual([item['kind'] for item in tracks], ['manual', 'automatic', 'translated'])
        self.assertEqual({item['language'] for item in tracks}, {'en', 'en-orig', 'fa'})
        self.assertTrue(all(set(item) == {'id', 'language', 'label', 'kind'} for item in tracks))
        self.assertNotIn('private-secret', (self.root / self.file_id / 'subtitles.json').read_text())
        self.assertEqual(web._save_subtitle_catalog({'id': self.video_id}, self.file_id), [])

    def test_untrusted_urls_cross_video_redirect_targets_and_paths_are_not_catalogued(self):
        bad = ['http://www.youtube.com/api/timedtext?v=abcdefghijk&fmt=vtt',
               'https://127.0.0.1/api/timedtext?v=abcdefghijk&fmt=vtt',
               'https://www.youtube.com.evil.test/api/timedtext?v=abcdefghijk&fmt=vtt',
               'https://www.youtube.com@127.0.0.1/api/timedtext?v=abcdefghijk&fmt=vtt',
               'https://www.youtube.com:8443/api/timedtext?v=abcdefghijk&fmt=vtt',
               'https://www.youtube.com/admin?v=abcdefghijk&fmt=vtt',
               'https://www.youtube.com/api/timedtext?v=other_video&fmt=vtt',
               'https://www.youtube.com/api/timedtext?v=abcdefghijk&v=other_video&fmt=vtt',
               'https://www.youtube.com/api/timedtext?v=abcdefghijk&fmt=json3']
        for url in bad:
            self.assertEqual(web._save_subtitle_catalog({'id':self.video_id,'subtitles':{'en':[self.track(url=url)]}},self.file_id), [], url)
        self.assertEqual(web._save_subtitle_catalog({'id':self.video_id,'subtitles':{'live_chat':[self.track()],'../../secret':[self.track()]}},self.file_id), [])

    def test_only_selected_track_is_fetched_once_and_cached_without_credentials_or_redirects(self):
        tracks=web._save_subtitle_catalog(self.catalog(), self.file_id)
        with patch.object(web, '_subtitle_request', return_value=self.Response(self.vtt)) as fetch:
            self.assertEqual(web._subtitle_bytes(self.file_id, tracks[0]['id']), self.vtt)
            self.assertEqual(web._subtitle_bytes(self.file_id, tracks[0]['id']), self.vtt)
        fetch.assert_called_once()
        item, headers=fetch.call_args.args
        self.assertNotIn('Cookie',headers); self.assertNotIn('Authorization',headers)
        self.assertEqual(headers['User-Agent'],'fixture-agent')

    def test_existing_browser_transport_flag_is_preserved_and_request_is_restricted(self):
        metadata=self.catalog()
        metadata['subtitles']['en'][0]['impersonate']=True
        track=web._save_subtitle_catalog(metadata,self.file_id)[0]
        response=self.Response(self.vtt)
        response.close=unittest.mock.Mock()
        session=unittest.mock.MagicMock()
        session.__enter__.return_value=session
        session.get.return_value=response
        module=types.ModuleType('curl_cffi')
        module.requests=types.SimpleNamespace(Session=unittest.mock.Mock(return_value=session))
        with patch.dict(sys.modules, {'curl_cffi':module}):
            self.assertEqual(web._subtitle_bytes(self.file_id,track['id']),self.vtt)
        session.get.assert_called_once()
        options=session.get.call_args.kwargs
        self.assertEqual(options['impersonate'],'chrome')
        self.assertFalse(options['allow_redirects'])
        self.assertTrue(options['verify'])
        self.assertEqual(options['timeout'],(5,15))
        self.assertNotIn('User-Agent',options['headers'])
        self.assertNotIn('Cookie',options['headers'])
        response.close.assert_called_once()

    def test_translations_wait_once_for_extraction_age_original_captions_do_not(self):
        with patch.object(web.time,'time',return_value=1000):
            tracks=web._save_subtitle_catalog(self.catalog(),self.file_id,extracted_at=980)
        with patch.object(web.time,'time',return_value=1000), \
             patch.object(web.time,'sleep') as wait, \
             patch.object(web,'_subtitle_request',return_value=self.Response(self.vtt)) as fetch:
            self.assertEqual(web._subtitle_bytes(self.file_id,tracks[0]['id']),self.vtt)
            wait.assert_not_called()
            self.assertEqual(web._subtitle_bytes(self.file_id,tracks[2]['id']),self.vtt)
            self.assertEqual(web._subtitle_bytes(self.file_id,tracks[2]['id']),self.vtt)
            wait.assert_called_once_with(40)
            self.assertEqual(fetch.call_count,2)

    def test_429_cooldown_applies_across_languages_then_expires_without_retries(self):
        tracks=web._save_subtitle_catalog(self.catalog(),self.file_id,extracted_at=0)
        with patch.object(web.time,'monotonic',return_value=1000), \
             patch.object(web,'_subtitle_request',return_value=self.Response(b'',429,{'retry-after':'120'})) as fetch:
            with self.assertRaisesRegex(web.app.UserVisibleError,'120 seconds'):
                web._subtitle_bytes(self.file_id,tracks[0]['id'])
            with self.assertRaisesRegex(web.app.UserVisibleError,'120 seconds'):
                web._subtitle_bytes(self.file_id,tracks[1]['id'])
            fetch.assert_called_once()
        with patch.object(web.time,'monotonic',return_value=1121), \
             patch.object(web,'_subtitle_request',return_value=self.Response(self.vtt)) as fetch:
            self.assertEqual(web._subtitle_bytes(self.file_id,tracks[1]['id']),self.vtt)
            fetch.assert_called_once()

    def test_unknown_or_traversal_track_never_causes_a_network_request(self):
        web._save_subtitle_catalog(self.catalog(),self.file_id)
        with patch.object(web,'_subtitle_request') as fetch:
            for file_id,track_id in [(self.file_id,'../secret'),('../secret','a'*16),(self.file_id,'0'*16)]:
                with self.assertRaises(FileNotFoundError): web._subtitle_bytes(file_id,track_id)
        fetch.assert_not_called()

    def test_http_errors_empty_html_oversized_and_invalid_utf8_are_not_cached_or_retried(self):
        track=web._save_subtitle_catalog(self.catalog(),self.file_id)[0]
        responses=[self.Response(self.vtt,status=302,headers={'location':'http://127.0.0.1/secret'}),
                   self.Response(b'<html>denied</html>'),
                   self.Response(b''), self.Response(b'WEBVTT\n\xff'),
                   self.Response(self.vtt,headers={'content-length':str(web.SUBTITLE_MAX_BYTES+1)}),
                   self.Response(b'WEBVTT\n'+b'x'*web.SUBTITLE_MAX_BYTES)]
        for response in responses:
            with patch.object(web,'_subtitle_request',return_value=response) as fetch:
                with self.assertRaises((web.app.UserVisibleError, UnicodeError)):
                    web._subtitle_bytes(self.file_id,track['id'])
                fetch.assert_called_once()
            self.assertFalse((self.root/self.file_id/f"subtitle-{track['id']}.vtt").exists())

    def test_http_subtitle_error_does_not_prevent_subsequent_video_range_request(self):
        track=web._save_subtitle_catalog(self.catalog(),self.file_id)[0]
        server=web.app.ThreadingHTTPServer(('127.0.0.1',0),web.MiniAsyncHandler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.object(web,'_subtitle_request',return_value=self.Response(b'',status=403)):
                c=http.client.HTTPConnection('127.0.0.1',server.server_port)
                c.request('GET',f"/mini/subtitle?streamId={self.file_id}&trackId={track['id']}")
                response=c.getresponse();self.assertEqual(response.status,502);response.read();c.close()
                c=http.client.HTTPConnection('127.0.0.1',server.server_port)
                c.request('GET',f'/mini/watch?streamId={self.file_id}',headers={'Range':'bytes=0-1'})
                response=c.getresponse();self.assertEqual(response.status,206);self.assertEqual(response.read(),b'vi');c.close()
        finally: server.shutdown();server.server_close();thread.join()

    def test_catalog_is_bounded_and_metadata_is_not_mutated(self):
        metadata=self.catalog();original=json.dumps(metadata,sort_keys=True)
        web._save_subtitle_catalog(metadata,self.file_id)
        self.assertEqual(json.dumps(metadata,sort_keys=True),original)
        many={'id':self.video_id,'subtitles':{f'x{i}':[self.track()] for i in range(300)}}
        self.assertEqual(len(web._save_subtitle_catalog(many,self.file_id)),200)


if __name__ == '__main__':
    unittest.main()
