import json
import hashlib
import hmac
import os
import io
from contextlib import redirect_stderr, redirect_stdout
from http.cookiejar import MozillaCookieJar
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
    def cookies(self):
        return ('# Netscape HTTP Cookie File\n'
                '#HttpOnly_.pornhub.com\tTRUE\t/\tTRUE\t0\tsession\tfictional-ph-session\n'
                '.pornhub.com\tTRUE\t/\tTRUE\t1\told\tfictional-expired\n'
                '.other.test\tTRUE\t/\tTRUE\t0\tsession\tfictional-unrelated\n')

    def json_cookies(self):
        return [{'domain': '.pornhub.com', 'hostOnly': False, 'path': '/', 'secure': True,
                 'httpOnly': True, 'session': True, 'name': 'session', 'value': 'fictional-ph-session'},
                {'domain': '.pornhub.com', 'path': '/', 'expirationDate': 1,
                 'name': 'old', 'value': 'fictional-expired'},
                {'domain': '.other.test', 'name': 'session', 'value': 'fictional-unrelated'}]

    def payload(self):
        return {'id': 'ytdl-42-7-42', 'source': 'pornhub', 'url': 'https://pornhub.com/embed/ph123',
                'botToken': 'fictional', 'chatId': 42, 'requestMessageId': 7, 'statusMessageId': 10}

    def test_stale_container_session_is_rejected_before_extraction_or_upload(self):
        expected = hmac.new(b'fictional', ('pornhub-session:' + self.cookies()).encode(), hashlib.sha256).hexdigest()
        for tag in [expected, 'not-a-tag', 'غیرمعتبر']:
            with self.subTest(tag=tag), patch.dict(os.environ, {'PORNHUB_COOKIES': 'old-session'}), \
                 patch.object(pornhub, 'download') as download, patch.object(app, 'edit_status'), \
                 patch.object(app, 'send_media_file') as send:
                result = app.process_job({**self.payload(), 'pornhubSessionTag': tag})
            self.assertEqual(result['errorCode'], 'SOURCE_SESSION_STALE')
            self.assertEqual(result['phase'], 'configuration')
            download.assert_not_called()
            send.assert_not_called()

    def test_current_worker_and_container_session_tags_allow_download(self):
        tag = hmac.new(b'fictional', ('pornhub-session:' + self.cookies()).encode(), hashlib.sha256).hexdigest()
        with patch.dict(os.environ, {'PORNHUB_COOKIES': self.cookies()}), \
             patch.object(pornhub, 'download', return_value=(Path('/fixture.mp4'), 'Example')) as download, \
             patch.object(app, 'edit_status'), patch.object(app, 'delete_status'), patch.object(app, 'send_media_file'):
            result = app.process_job({**self.payload(), 'pornhubSessionTag': tag})
        self.assertTrue(result['ok'])
        download.assert_called_once()

    def test_redirect_observation_survives_short_cookie_value_redaction(self):
        raw = self.cookies() + '.pornhub.com\tTRUE\t/\tTRUE\t0\tflag\t1\n'
        error = ('ERROR: [PornHub+session_diagnostics] ph123: Redirection detected; redirectKind=homepage; '
                 'suppliedCookies=12; matchingCookies=yes; httpOnlyCookies=1; probe=ph-session-v1')
        with patch.dict(os.environ, {'PORNHUB_COOKIES': raw}), patch.object(app, 'edit_status'), \
             patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(1, 'yt-dlp', stderr=error)):
            result = app.process_job(self.payload())
        self.assertEqual(result['errorCode'], 'SOURCE_REDIRECTED')
        self.assertEqual(result['sourceDiagnostics'], {'probeVersion': 'ph-session-v1', 'redirectKind': 'homepage',
                         'suppliedCookieCount': 12, 'matchingCookies': True, 'httpOnlyCookieCount': 1})
        self.assertNotIn('fictional-ph-session', json.dumps(result))

    def test_probe_versions_survive_parsing_and_unknown_versions_are_ignored(self):
        prefix = ('Redirection detected; redirectKind=homepage; '
                  'suppliedCookies=38; matchingCookies=yes; httpOnlyCookies=2; probe=')
        for version in ('ph-session-v1', 'ph-session-v2'):
            self.assertEqual(pornhub.source_diagnostics(prefix + version + '\n'),
                             {'probeVersion': version, 'redirectKind': 'homepage',
                              'suppliedCookieCount': 38, 'matchingCookies': True, 'httpOnlyCookieCount': 2})
        for version in ('ph-session-v3', 'ph-session-v20', 'PRIVATE_COOKIE'):
            self.assertIsNone(pornhub.source_diagnostics(prefix + version))

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

    def download(self, directory, duration=60, metadata=None):
        path = Path(directory) / 'Pornhub.mp4'
        path.write_bytes(b'fictional-video')
        results = [subprocess.CompletedProcess([], 0, json.dumps(metadata or {'title': 'Example', 'duration': 60})),
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
                self.assertEqual(command[command.index('--compat-options') + 1], 'no-certifi')
            self.assertEqual(calls[0].args[0][-2], '--')
            self.assertIn('--load-info-json', calls[1].args[0])
            self.assertNotIn('https://pornhub.com/view_video.php?viewkey=ph123', calls[1].args[0])
            self.assertIn('--abort-on-unavailable-fragments', calls[1].args[0])
            self.assertIn(str(app.DIRECT_TELEGRAM_LIMIT), calls[1].args[0])

    def test_cookie_file_is_private_scoped_and_removed_on_metadata_failure(self):
        paths = []
        def run(command, timeout):
            path = Path(command[command.index('--cookies') + 1])
            paths.append(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            jar = MozillaCookieJar(str(path))
            jar.load(ignore_discard=True)
            self.assertEqual([(c.name, c.value) for c in jar], [('session', 'fictional-ph-session')])
            self.assertNotIn('fictional-ph-session', ' '.join(command))
            raise subprocess.CalledProcessError(1, command, stderr='ERROR: Login required')
        with patch.dict(os.environ, {'PORNHUB_COOKIES': self.cookies()}), \
             patch.object(pipeline, '_run', side_effect=run):
            for _ in range(2):
                with tempfile.TemporaryDirectory() as directory:
                    with self.assertRaises(pornhub.DownloadError):
                        pornhub.download(self.payload()['url'], Path(directory))
                    self.assertFalse(paths[-1].exists())
        self.assertNotEqual(*paths)

    def test_cookie_file_is_used_for_metadata_and_download_then_removed(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {'PORNHUB_COOKIES': self.cookies()}):
            _, calls = self.download(directory)
            for call in calls:
                self.assertEqual(call.args[0][call.args[0].index('--cookies') + 1],
                                 str(Path(directory) / 'source.cookies.txt'))
            self.assertFalse((Path(directory) / 'source.cookies.txt').exists())
            self.assertEqual((Path(directory) / 'source.info.json').stat().st_mode & 0o777, 0o600)

    def test_mobile_exports_preserve_cookie_values_flags_and_scope(self):
        exports = ['\ufeff\r\n' + self.cookies().replace('\n', '\r\n'),
                   json.dumps(self.json_cookies()), '\ufeff \t\n' + json.dumps({'cookies': self.json_cookies()})]
        for raw in exports:
            with self.subTest(format=raw[:1]), tempfile.TemporaryDirectory() as directory, \
                 patch.dict(os.environ, {'PORNHUB_COOKIES': raw}):
                with pornhub.source_cookie_args(Path(directory)) as args:
                    path = Path(args[1])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    jar = MozillaCookieJar(str(path))
                    jar.load(ignore_discard=True)
                    cookies = list(jar)
                    self.assertEqual(len(cookies), 1)
                    cookie = cookies[0]
                    self.assertEqual((cookie.name, cookie.value, cookie.domain),
                                     ('session', 'fictional-ph-session', '.pornhub.com'))
                    self.assertTrue(cookie.secure)
                    self.assertTrue(cookie.has_nonstandard_attr('HTTPOnly'))
                    self.assertIsNone(cookie.expires)
                self.assertFalse(path.exists())

    def test_json_expiry_and_host_only_scope_are_preserved(self):
        expires = int(time.time()) + 600
        entries = [{'domain': '.www.pornhub.org', 'hostOnly': True, 'path': '/',
                    'name': 'host-session', 'value': 'host-value', 'expires': expires},
                   {'domain': 'pornhub.net', 'hostOnly': False, 'path': '/',
                    'name': 'domain-session', 'value': 'domain-value', 'expirationDate': 0}]
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, {'PORNHUB_COOKIES': json.dumps(entries)}):
            with pornhub.source_cookie_args(Path(directory)) as args:
                jar = MozillaCookieJar(args[1])
                jar.load(ignore_discard=True)
                host, domain = list(jar)
                self.assertEqual((host.domain, host.domain_specified, host.expires),
                                 ('www.pornhub.org', False, expires))
                self.assertEqual((domain.domain, domain.domain_specified, domain.expires),
                                 ('.pornhub.net', True, None))

    def test_invalid_session_never_runs_extractor_or_leaks_cookie_rows(self):
        cases = [('not a cookie file', 'format_unknown'),
                 ('session=fictional-ph-session;', 'format_unknown'),
                 ('{"session": "fictional-ph-session"}', 'json_invalid'),
                 ('[{"domain": ".pornhub.com", "value": "fictional-ph-session"}]', 'json_invalid'),
                 (json.dumps([{**self.json_cookies()[0], 'value': 'fictional-ph-session\nInjected'}]), 'json_invalid'),
                 (json.dumps([{**self.json_cookies()[0], 'session': False, 'expires': 'bad', 'expirationDate': 'NaN'}]), 'json_invalid'),
                 ('[]', 'no_pornhub_cookies'),
                 (json.dumps([self.json_cookies()[1]]), 'all_expired'),
                 ('# Netscape HTTP Cookie File\n', 'no_pornhub_cookies'),
                 ('# Netscape HTTP Cookie File\n.pornhub.com\tFALSE\t/\tTRUE\t0\tsession\tfictional-ph-session\n', 'netscape_invalid'),
                 ('# Netscape HTTP Cookie File\n.other.test\tTRUE\t/\tTRUE\t0\tsession\tfictional-unrelated\n', 'no_pornhub_cookies'),
                 ('# Netscape HTTP Cookie File\n.pornhub.com\tTRUE\t/\tTRUE\t1\tsession\tfictional-expired\n', 'all_expired')]
        for raw, reason in cases:
            output = io.StringIO()
            with self.subTest(raw=raw), patch.dict(os.environ, {'PORNHUB_COOKIES': raw}), \
                 patch.object(pipeline, '_run') as run, patch.object(app, 'edit_status'), \
                 patch.object(app, 'send_media_file') as send, redirect_stdout(output), redirect_stderr(output):
                result = app.process_job(self.payload())
            self.assertEqual(result['errorCode'], 'SOURCE_SESSION_INVALID')
            self.assertEqual(result['phase'], 'configuration')
            self.assertEqual(result['diagnostic'], f'cookieExportReason={reason}')
            for secret in ['fictional-ph-session', 'fictional-unrelated', 'fictional-expired']:
                self.assertNotIn(secret, output.getvalue() + json.dumps(result))
            run.assert_not_called()
            send.assert_not_called()

    def test_session_values_are_redacted_from_error_logs_and_result(self):
        for raw in [self.cookies(), json.dumps(self.json_cookies()), '\ufeff' + json.dumps({'cookies': self.json_cookies()})]:
            output = io.StringIO()
            with self.subTest(format=raw[:1]), patch.dict(os.environ, {'PORNHUB_COOKIES': raw}), \
                 patch.object(pipeline, '_run', side_effect=subprocess.CalledProcessError(1, 'yt-dlp',
                              stderr='ERROR: failed fictional-ph-session fictional-unrelated fictional-expired')), \
                 patch.object(app, 'edit_status'), redirect_stdout(output):
                result = app.process_job(self.payload())
            for secret in ['fictional-ph-session', 'fictional-unrelated', 'fictional-expired']:
                self.assertNotIn(secret, output.getvalue() + json.dumps(result))
            self.assertIn('[redacted]', result['diagnostic'])

    def test_cookie_storage_failure_is_not_reported_as_an_invalid_export(self):
        output = io.StringIO()
        with patch.dict(os.environ, {'PORNHUB_COOKIES': self.cookies()}), \
             patch('builtins.open', side_effect=PermissionError('fictional-ph-session')), \
             patch.object(pipeline, '_run') as run, patch.object(app, 'edit_status'), redirect_stdout(output):
            result = app.process_job(self.payload())
        self.assertEqual(result['errorCode'], 'SOURCE_SESSION_STORAGE_ERROR')
        self.assertEqual(result['phase'], 'configuration')
        self.assertNotIn('fictional-ph-session', output.getvalue() + json.dumps(result))
        run.assert_not_called()

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
                 ('Redirection detected; redirectKind=login; suppliedCookies=0; matchingCookies=no;', 'SOURCE_SESSION_MISSING'),
                 ('Redirection detected; redirectKind=login; suppliedCookies=2; matchingCookies=no;', 'SOURCE_SESSION_DOMAIN_MISMATCH'),
                 ('Redirection detected; redirectKind=login; suppliedCookies=2; matchingCookies=yes;', 'SOURCE_AUTH_REQUIRED'),
                 ('Redirection detected; redirectKind=age_verification; suppliedCookies=2; matchingCookies=yes;', 'SOURCE_AGE_VERIFICATION_REQUIRED'),
                 ('Redirection detected; redirectKind=access_restricted; suppliedCookies=2; matchingCookies=yes;', 'SOURCE_ACCESS_RESTRICTED'),
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

    def test_invalid_metadata_is_a_metadata_failure(self):
        for value in ['not json', '[]', 'null']:
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
                cookie_path = Path(command[command.index('--cookies') + 1])
                self.assertIn('fictional-ph-session', cookie_path.read_text())
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
                 patch.dict(os.environ, {'PORNHUB_COOKIES': self.cookies()}), \
                 patch.object(app, 'probe_duration', return_value=60), \
                 patch.object(pipeline, '_probe_geometry', return_value=(1280, 720, 16/9)):
                pornhub.download(self.payload()['url'], folder)
            self.assertEqual(len(calls), 4)
            self.assertFalse((folder / 'source.cookies.txt').exists())

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
                     patch.dict(os.environ, {'PORNHUB_COOKIES': json.dumps(self.json_cookies())}), \
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
