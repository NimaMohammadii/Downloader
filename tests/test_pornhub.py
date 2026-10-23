import json
import os
import io
from contextlib import redirect_stderr, redirect_stdout
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline
import pornhub

class PornhubTests(unittest.TestCase):

    def payload(self):
        return {'id': 'ytdl-42-7-42', 'source': 'pornhub', 'url': 'https://pornhub.com/embed/ph123',
                'botToken': 'fictional', 'chatId': 42, 'requestMessageId': 7, 'statusMessageId': 10}

    def test_status_failure_must_not_discard_a_ready_video(self):
        with patch.object(pornhub, 'download', return_value=(Path('/fixture.mp4'), 'Example')), \
             patch.object(app, 'edit_status', side_effect=RuntimeError('message to edit not found')), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'delete_status'):
            result = app.process_job(self.payload())
        self.assertTrue(result['ok'])
        send.assert_called_once()

    def test_upload_failure_retains_exact_cause_and_is_never_replayed(self):
        from telethon import functions
        from telethon.errors import FloodWaitError
        request = functions.auth.ImportBotAuthorizationRequest(flags=0, api_id=123,
                   api_hash='api-secret', bot_auth_token='fictional')
        failure = FloodWaitError(request, capture=137)
        with patch.object(pornhub, 'download', return_value=(Path('/fixture.mp4'), 'Example')), \
             patch.object(app, 'send_media_file', side_effect=failure) as send, \
             patch.object(app, 'edit_status'), patch.dict(os.environ, {'API_HASH': 'api-secret'}):
            result = app.process_job(self.payload())
        self.assertFalse(result['ok'])
        self.assertEqual(result['phase'], 'upload')
        self.assertEqual(result['errorCode'], 'FLOOD_WAIT')
        self.assertEqual(result['rpcMethod'], 'ImportBotAuthorizationRequest')
        self.assertEqual(result['retryAfterSeconds'], 137)
        self.assertIn('137', result['message'])
        self.assertNotIn('api-secret', json.dumps(result))
        self.assertNotIn('fictional', json.dumps(result))
        send.assert_called_once()

    def test_unexpected_download_failure_is_diagnostic_and_redacted(self):
        with patch.object(pornhub, 'download', side_effect=RuntimeError('fictional https://cdn.test/v?secret=value')), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'edit_status'):
            result = app.process_job(self.payload())
        self.assertEqual(result['phase'], 'download')
        self.assertEqual(result['errorCode'], 'RuntimeError')
        self.assertNotIn('fictional', result['diagnostic'])
        self.assertNotIn('cdn.test', result['diagnostic'])
        send.assert_not_called()

    def test_download_and_upload_share_a_deadline_and_restore_context(self):
        inherited = app.JOB_DEADLINE.set(time.monotonic() + 5000)
        try:
            deadlines = []
            def expire(*args):
                deadlines.append(app.JOB_DEADLINE.get())
                app.JOB_DEADLINE.set(time.monotonic() - 1)
                return Path('/fixture.mp4'), 'Example'
            with patch.object(pornhub, 'download', side_effect=expire), \
                 patch.object(app, 'edit_status'), patch.object(app, 'send_media_file') as send:
                result = app.process_job(self.payload())
            self.assertFalse(result['ok'])
            self.assertLessEqual(deadlines[0], time.monotonic() + app.YOUTUBE_JOB_SECONDS)
            send.assert_not_called()
            self.assertGreater(app.JOB_DEADLINE.get(), time.monotonic() + 4000)
        finally:
            app.JOB_DEADLINE.reset(inherited)

    def test_video_urls_and_untrusted_hosts(self):
        self.assertEqual(pornhub.video_url('http://fr.pornhub.org/embed/ph123'),
                         'https://fr.pornhub.org/view_video.php?viewkey=ph123')
        for value in ['https://pornhub.com.attacker.test/view_video.php?viewkey=ph123',
                      'https://evilpornhub.com/view_video.php?viewkey=ph123',
                      'https://pornhub.com/playlist/123', 'https://pornhub.com/video/search',
                      'https://user:pass@pornhub.com/view_video.php?viewkey=ph123',
                      'https://pornhub.com:444/view_video.php?viewkey=ph123',
                      'https://pornhub.com/view_video.php?viewkey=../../bad']:
            with self.subTest(value=value), self.assertRaises(app.UserVisibleError):
                pornhub.video_url(value)

    def download(self, directory, duration=60, metadata=None, metadata_stdout=None):
        path = Path(directory) / 'Pornhub.mp4'
        path.write_bytes(b'fictional-video')
        results = [subprocess.CompletedProcess([], 0, metadata_stdout if metadata_stdout is not None
                                               else json.dumps(metadata or {'title': 'Example', 'duration': 60})),
                   subprocess.CompletedProcess([], 0, str(path))]
        with patch.object(pipeline, '_run', side_effect=results) as run, \
             patch.object(app, 'probe_duration', return_value=duration), \
             patch.object(pipeline, '_probe_geometry', return_value=(1280, 720, 16/9)):
            value = pornhub.download('https://pornhub.com/view_video.php?viewkey=ph123', Path(directory))
        return value, run.call_args_list

    def test_generic_extractor_download_reuses_sender_without_youtube_client_args(self):
        with tempfile.TemporaryDirectory() as directory:
            (path, title), calls = self.download(directory)
            self.assertEqual(title, 'Example')
            self.assertEqual(path.suffix, '.mp4')
            for call in calls:
                command = call.args[0]
                self.assertEqual(command[command.index('--use-extractors') + 1], 'PornHub')
                self.assertNotIn('--extractor-args', command)
                self.assertNotIn('--cookies', command)
                self.assertNotIn('--cookies-from-browser', command)
                self.assertIn('--no-plugin-dirs', command)
                self.assertNotIn('--plugin-dirs', command)
                self.assertEqual(command[command.index('--compat-options') + 1], 'no-certifi')
            self.assertEqual(calls[0].args[0][-2], '--')
            self.assertIn('--load-info-json', calls[1].args[0])
            self.assertNotIn('https://pornhub.com/view_video.php?viewkey=ph123', calls[1].args[0])
            self.assertIn('--abort-on-unavailable-fragments', calls[1].args[0])
            self.assertIn(str(app.DIRECT_TELEGRAM_LIMIT), calls[1].args[0])

    def test_obsolete_cookie_secret_does_not_affect_anonymous_download(self):
        for raw in ('', 'invalid-export', '[{"name":"session","value":"obsolete-secret"}]'):
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as directory, \
                 patch.dict(os.environ, {'PORNHUB_COOKIES': raw}):
                (_, title), calls = self.download(directory)
                self.assertEqual(title, 'Example')
                self.assertEqual(len(calls), 2)
                self.assertNotIn('obsolete-secret', str(calls))
                self.assertEqual({p.name for p in Path(directory).iterdir()}, {'Pornhub.mp4', 'source.info.json'})

    def test_selector_accepts_best_quality_above_1080_and_unknown_dimensions(self):
        from yt_dlp import YoutubeDL
        with tempfile.TemporaryDirectory() as directory:
            _, calls = self.download(directory)
        command = calls[1].args[0]
        selector = command[command.index('--format') + 1]
        sort = command[command.index('--format-sort') + 1].split(',')
        with YoutubeDL({'quiet': True, 'format': selector, 'format_sort': sort}) as ydl:
            for height in (2160, None):
                formats = [{'format_id': 'high', 'url': 'https://fixture.invalid/video.mp4',
                            'ext': 'mp4', 'vcodec': 'avc1', 'acodec': 'mp4a', 'height': height}]
                if height:
                    formats.insert(0, {**formats[0], 'format_id': 'low', 'height': 1080})
                result = ydl.process_ie_result({'id': 'fixture', 'title': 'Example', 'formats': formats}, download=False)
                self.assertEqual(result['format_id'], 'high')

    def test_missing_source_duration_does_not_reject_a_readable_complete_download(self):
        with tempfile.TemporaryDirectory() as directory:
            (path, _), _ = self.download(directory, metadata={'title': 'Example'})
            self.assertTrue(path.exists())

    def test_extractor_failures_report_the_stage_without_guessing_login_or_replaying(self):
        cases = [('HTTP Error 429: Too Many Requests', 'SOURCE_RATE_LIMITED'),
                 ('Requested format is not available', 'SOURCE_FORMAT_UNAVAILABLE'),
                 ('This video is private', 'SOURCE_UNAVAILABLE'),
                 ('Login required', 'SOURCE_AUTH_REQUIRED'),
                 ('Redirection detected; the video may be deleted or require login', 'SOURCE_REDIRECTED'),
                 ('CERTIFICATE_VERIFY_FAILED', 'SOURCE_TLS_ERROR')]
        for detail, code in cases:
            with self.subTest(code=code), \
                 patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(1, 'yt-dlp',
                              stderr=detail + ' fictional https://secret.test/file?token=hidden')) as run, \
                 patch.object(app, 'edit_status'), patch.object(app, 'send_media_file') as send:
                result = app.process_job(self.payload())
            self.assertEqual(result['phase'], 'metadata')
            self.assertEqual(result['errorCode'], code)
            self.assertNotIn('secret.test', json.dumps(result))
            self.assertNotIn('fictional', json.dumps(result))
            run.assert_called_once()
            send.assert_not_called()

    def test_redirect_trace_safely_reports_destination_category(self):
        cases = [
            ("https://www.pornhub.com/", "homepage"),
            ("https://www.pornhub.com/login?session=never-log-this", "login"),
            ("/age-verification?token=never-log-this", "verification"),
            ("/unavailable", "restricted"),
            ("https://external.example/secret?token=never-log-this", "external"),
        ]
        for location, expected in cases:
            trace = (
                "reply: 'HTTP/2 302\\r\\nLocation: " + location
                + "\\r\\nSet-Cookie: session=never-log-this\\r\\n'\n"
                + "ERROR: [PornHub] 66c7283d71138: Redirection detected; the video may be deleted or require login"
            )
            with self.subTest(expected=expected), \
                 patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(
                     1, 'yt-dlp', stderr=trace)) as run, \
                 self.assertRaises(pornhub.DownloadError) as caught:
                pornhub.run_source(['yt-dlp', '--print-traffic'], 90, 'metadata')
            self.assertEqual(run.call_count, 1)
            self.assertEqual(caught.exception.error_code, "SOURCE_REDIRECTED")
            self.assertIn("redirectTarget=" + expected, caught.exception.detail)
            self.assertNotIn("never-log-this", caught.exception.detail)
            self.assertNotIn("never-log-this", str(caught.exception))

    def test_redirect_error_survives_escaped_cookie_trace(self):
        trace = (
            r"reply: HTTP/2 302\r\nLocation: /\r\nSet-Cookie: session=never-log-this"
            r"\r\nERROR: [PornHub] 66c7283d71138: Redirection detected"
        )
        self.assertEqual(pornhub.source_error(trace)[0], "SOURCE_REDIRECTED")
        self.assertEqual(pornhub.redirect_category(trace), "homepage")

    def test_metadata_traffic_trace_stays_out_of_download_request(self):
        with tempfile.TemporaryDirectory() as directory:
            _, calls = self.download(directory)
        self.assertIn('--print-traffic', calls[0].args[0])
        self.assertNotIn('--print-traffic', calls[1].args[0])
        self.assertEqual(calls[0].args[0][calls[0].args[0].index('--impersonate') + 1], 'chrome')
        self.assertNotIn('--impersonate', calls[1].args[0])

    def test_temporary_metadata_http_errors_retry_then_succeed(self):
        for status in (502, 503, 504):
            failure = subprocess.CalledProcessError(1, 'yt-dlp',
                stderr=f'ERROR: Unable to download webpage: HTTP Error {status}: Service Unavailable')
            success = subprocess.CompletedProcess([], 0, '{}')
            with self.subTest(status=status), \
                 patch.object(pipeline, '_run', side_effect=[failure, success]) as run, \
                 patch.object(pornhub.time, 'sleep') as sleep:
                self.assertIs(pornhub.run_source(['yt-dlp'], 90, 'metadata'), success)
            self.assertEqual(run.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_temporary_metadata_failure_is_bounded_and_preserves_safe_error(self):
        failure = subprocess.CalledProcessError(1, 'yt-dlp',
            stderr='response body must not be logged\nERROR: HTTP Error 503: Service Unavailable')
        with patch.object(pipeline, '_run', side_effect=failure) as run, \
             patch.object(pornhub.time, 'sleep') as sleep, \
             self.assertRaises(pornhub.DownloadError) as caught:
            pornhub.run_source(['yt-dlp'], 90, 'metadata')
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
        self.assertEqual(caught.exception.error_code, 'SOURCE_TEMPORARILY_UNAVAILABLE')
        self.assertEqual(caught.exception.phase, 'metadata')
        self.assertEqual(caught.exception.detail, 'ERROR: HTTP Error 503: Service Unavailable')

    def test_recovered_metadata_failure_downloads_and_sends_only_once(self):
        calls = []
        def run(command, timeout):
            calls.append(command)
            if len(calls) == 1:
                raise subprocess.CalledProcessError(1, 'yt-dlp', stderr='ERROR: HTTP Error 503: Service Unavailable')
            if '--dump-single-json' in command:
                return subprocess.CompletedProcess(command, 0, json.dumps({'title': 'Example', 'duration': 60}))
            path = Path(command[command.index('--output') + 1].replace('%(ext)s', 'mp4'))
            path.write_bytes(b'complete-fixture')
            return subprocess.CompletedProcess(command, 0, str(path))
        with patch.object(pipeline, '_run', side_effect=run), patch.object(pornhub.time, 'sleep'), \
             patch.object(app, 'probe_duration', return_value=60), \
             patch.object(pipeline, '_probe_geometry', return_value=(640, 360, 16/9)), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'edit_status'), \
             patch.object(app, 'delete_status'):
            result = app.process_job(self.payload())
        self.assertTrue(result['ok'])
        self.assertEqual(len(calls), 3)
        self.assertEqual(sum('--load-info-json' in command for command in calls), 1)
        send.assert_called_once()

    def test_metadata_retry_uses_remaining_budget_including_job_deadline(self):
        failure = subprocess.CalledProcessError(1, 'yt-dlp', stderr='ERROR: HTTP Error 503: Service Unavailable')
        success = subprocess.CompletedProcess([], 0, '{}')
        with patch.object(app, 'job_timeout', return_value=8), \
             patch.object(pornhub.time, 'monotonic', side_effect=[100, 100, 106, 107]), \
             patch.object(pipeline, '_run', side_effect=[failure, success]) as run, \
             patch.object(pornhub.time, 'sleep'):
            self.assertIs(pornhub.run_source(['yt-dlp'], 90, 'metadata'), success)
        self.assertEqual([call.args[1] for call in run.call_args_list], [8, 1])
        with patch.object(pornhub.time, 'monotonic', side_effect=[100, 100, 189.5]), \
             patch.object(pipeline, '_run', side_effect=failure) as run, \
             patch.object(pornhub.time, 'sleep') as sleep, \
             self.assertRaises(pornhub.DownloadError):
            pornhub.run_source(['yt-dlp'], 90, 'metadata')
        run.assert_called_once()
        sleep.assert_not_called()

    def test_temporary_download_errors_and_unrelated_numbers_do_not_retry(self):
        for phase, detail in [('download', 'HTTP Error 503: Service Unavailable'),
                              ('metadata', 'ERROR: video 503 is unavailable'),
                              ('metadata', 'ERROR: failed https://example.test/HTTP Error 503')]:
            with self.subTest(phase=phase, detail=detail), \
                 patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(1, 'yt-dlp', stderr=detail)) as run, \
                 patch.object(pornhub.time, 'sleep') as sleep, \
                 self.assertRaises(pornhub.DownloadError):
                pornhub.run_source(['yt-dlp'], 90, phase)
            run.assert_called_once()
            sleep.assert_not_called()

    def test_metadata_traffic_prefix_does_not_corrupt_json(self):
        trace = ("director: sending request via CurlCFFI\n"
                 "send: GET https://www.pornhub.com/view_video.php?viewkey=ph123\n"
                 "reply: HTTP/2 200 OK\n"
                 + json.dumps({'title': 'Example', 'duration': 60}) + "\n")
        with tempfile.TemporaryDirectory() as directory:
            (path, title), calls = self.download(directory, metadata_stdout=trace)
        self.assertEqual(title, 'Example')
        self.assertEqual(path.suffix, '.mp4')
        self.assertEqual(len(calls), 2)
        self.assertIn('--print-traffic', calls[0].args[0])

    def test_invalid_metadata_is_a_metadata_failure(self):
        for value in ['', 'not json', '[]', 'null']:
            with self.subTest(value=value), \
                 patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, value)), \
                 patch.object(app, 'edit_status'), patch.object(app, 'send_media_file') as send:
                result = app.process_job(self.payload())
            self.assertEqual(result['phase'], 'metadata')
            self.assertEqual(result['errorCode'], 'SOURCE_INVALID_METADATA')
            send.assert_not_called()

    def test_unknown_extractor_error_keeps_a_redacted_error_line_for_diagnosis(self):
        detail = ('provider response must not be logged\n'
                  'ERROR: extractor parse failed fictional api-secret https://cdn.test/v?signature=hidden Cookie: private')
        with patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(1, 'yt-dlp', stderr=detail)), \
             patch.object(app, 'edit_status'), patch.dict(os.environ, {'API_HASH': 'api-secret'}):
            result = app.process_job(self.payload())
        self.assertEqual(result['phase'], 'metadata')
        self.assertEqual(result['errorCode'], 'SOURCE_DOWNLOAD_FAILED')
        self.assertIn('extractor parse failed', result['diagnostic'])
        for secret in ['provider response', 'fictional', 'api-secret', 'cdn.test', 'signature=hidden', 'private']:
            self.assertNotIn(secret, result['diagnostic'])

    def test_rejected_download_link_refreshes_catalog_once_and_discards_partial_files(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            calls = []
            def run(command, timeout):
                calls.append(command)
                if '--dump-single-json' in command:
                    if len(calls) == 3:
                        self.assertFalse((folder / 'Pornhub.mp4.part').exists())
                    return subprocess.CompletedProcess(command, 0, json.dumps({'duration': 60, 'title': 'Example'}))
                if len(calls) == 2:
                    (folder / 'Pornhub.mp4.part').write_bytes(b'incomplete')
                    raise subprocess.CalledProcessError(1, command, stderr='HTTP Error 403: Forbidden')
                path = folder / 'Pornhub.mp4'
                path.write_bytes(b'complete fixture')
                return subprocess.CompletedProcess(command, 0, str(path))
            with patch.object(pipeline, '_run', side_effect=run), \
                 patch.object(app, 'probe_duration', return_value=60), \
                 patch.object(pipeline, '_probe_geometry', return_value=(1280, 720, 16/9)):
                pornhub.download(self.payload()['url'], folder)
            self.assertEqual(len(calls), 4)

    def test_repeated_rejected_download_links_stop_after_one_refresh(self):
        info = subprocess.CompletedProcess([], 0, json.dumps({'duration': 60}))
        error = subprocess.CalledProcessError(1, 'yt-dlp', stderr='HTTP Error 410: Gone')
        with patch.object(pipeline, '_run', side_effect=[info, error, info, error]) as run, \
             patch.object(app, 'edit_status'), patch.object(app, 'send_media_file') as send:
            result = app.process_job(self.payload())
        self.assertEqual(run.call_count, 4)
        self.assertEqual(result['phase'], 'download')
        self.assertEqual(result['errorCode'], 'SOURCE_LINK_REJECTED')
        send.assert_not_called()

    def test_real_ytdlp_and_ffprobe_deliver_complete_bytes_despite_a_missing_status_message(self):
        cookie_headers = []
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                cookie_headers.append(self.headers.get('Cookie'))
                super().do_GET()

        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / 'fixture.mp4'
            subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=32x32:r=10',
                            '-t', '3', '-c:v', 'mpeg4', str(video)], check=True, capture_output=True, timeout=15)
            server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=directory))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            metadata = {'id': 'fixture', 'title': 'Example', 'duration': 3, 'extractor': 'PornHub',
                        'extractor_key': 'PornHub', 'webpage_url': self.payload()['url'],
                        'formats': [{'format_id': 'mp4', 'ext': 'mp4', 'vcodec': 'mp4v', 'acodec': 'none',
                                     'url': f'http://127.0.0.1:{server.server_port}/fixture.mp4'}]}
            original_run = pornhub.run_source
            sent = []
            def run(command, timeout, phase):
                if phase == 'metadata':
                    return subprocess.CompletedProcess(command, 0, json.dumps(metadata))
                return original_run(command, timeout, phase)
            def telegram(token, method, **kwargs):
                self.assertEqual(method, 'sendVideo')
                sent.append(kwargs['files']['video'][1].read())
                self.assertEqual(kwargs['data']['width'], '32')
                self.assertEqual(kwargs['data']['duration'], '3')
                return {'message_id': 123}
            try:
                with patch.object(pornhub, 'run_source', side_effect=run), \
                     patch.object(app, 'REAL_YTDLP', str(Path(sys.executable).with_name('yt-dlp'))), \
                     patch.object(app, 'send_media_file', wraps=pipeline.send_media_file), \
                     patch.object(app, 'telegram_call', side_effect=telegram), \
                     patch.object(app, 'edit_status', side_effect=RuntimeError('message to edit not found')), \
                     patch.object(app, 'delete_status'):
                    result = app.process_job(self.payload())
                self.assertTrue(result['ok'], result)
                self.assertEqual(sent, [video.read_bytes()])
                self.assertTrue(cookie_headers)
                self.assertTrue(all(header is None for header in cookie_headers))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_short_or_unreadable_file_is_rejected(self):
        for duration in [0, 40, float('nan')]:
            with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(app.UserVisibleError, 'ناقص'):
                self.download(directory, duration=duration)

    def test_unavailable_or_timed_out_source_has_friendly_pornhub_error(self):
        errors = [subprocess.CalledProcessError(1, 'yt-dlp', stderr='private video secret-url'),
                  subprocess.TimeoutExpired('yt-dlp', 90)]
        for error in errors:
            with tempfile.TemporaryDirectory() as directory, \
                 patch.object(pipeline, '_run', side_effect=error), \
                 self.assertRaisesRegex(app.UserVisibleError, 'Pornhub') as caught:
                pornhub.download('https://pornhub.com/embed/ph123', Path(directory))
            self.assertNotIn('secret-url', str(caught.exception))

    def test_job_dispatch_sends_one_file_and_cleans_up(self):
        payload = {'source': 'pornhub', 'url': 'https://pornhub.com/embed/ph123', 'botToken': 'fictional',
                   'chatId': 42, 'requestMessageId': 7, 'statusMessageId': 10}
        directories = []
        def download(url, workdir):
            directories.append(workdir)
            path = workdir / 'Pornhub.mp4'
            path.write_bytes(b'fictional-video')
            return path, 'Example'
        with patch.object(pornhub, 'download', side_effect=download), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'edit_status'), patch.object(app, 'delete_status'):
            self.assertTrue(app.process_job(payload)['ok'])
            send.assert_called_once()
            self.assertEqual(send.call_args.args[:3], ('fictional', 42, 7))
        self.assertFalse(directories[0].exists())
        with patch.object(pornhub, 'download', side_effect=app.UserVisibleError('incomplete')), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'edit_status'):
            self.assertFalse(app.process_job(payload)['ok'])
            send.assert_not_called()

if __name__ == '__main__':
    unittest.main()
