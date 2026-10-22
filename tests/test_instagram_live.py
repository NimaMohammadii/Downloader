import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import ssl
import sys
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app

CDN = 'https://scontent.cdninstagram.com/'
STATIC = '''<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"><Period>
<AdaptationSet><Representation id="video"><BaseURL>https://scontent.cdninstagram.com/video.mp4</BaseURL></Representation></AdaptationSet>
</Period></MPD>'''


def payload(mode='live'):
    return {'id': 'igdl-42-7-42', 'source': {'mode': mode, 'url': CDN + 'video.mp4', 'title': 'Test live'},
            'botToken': 'fictional-token', 'chatId': 42, 'requestMessageId': 7, 'statusMessageId': 10,
            'stopData': 'igs|7|42|0000000000000000',
            'completionUrl': 'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
            'completionToken': '0' * 64}


class ManifestTests(unittest.TestCase):
    def test_static_inline_manifest_has_only_network_sources(self):
        xml = app.instagram_manifest(STATIC, None, False)
        self.assertIn(CDN + 'video.mp4', xml)

    def test_relative_segments_get_absolute_cdn_urls(self):
        xml = STATIC.replace('<BaseURL>' + CDN + 'video.mp4</BaseURL>',
                             '<SegmentTemplate initialization="init.mp4" media="$Number$.m4s"/>')
        result = app.instagram_manifest(xml, CDN + 'live.mpd', False)
        self.assertIn(CDN + 'init.mp4', result)
        self.assertIn(CDN + '$Number$.m4s', result)

    def test_drm_dynamic_replay_entities_and_local_urls_are_rejected(self):
        cases = [STATIC.replace('type="static"', 'type="dynamic"'),
                 STATIC.replace('<Period>', '<Period><ContentProtection/>'),
                 '<!DOCTYPE a>' + STATIC,
                 STATIC.replace(CDN + 'video.mp4', 'file:///etc/passwd'),
                 STATIC.replace(CDN + 'video.mp4', 'https://localhost/private')]
        for xml in cases:
            with self.subTest(xml=xml), self.assertRaises(app.UserVisibleError):
                app.instagram_manifest(xml, None, False)

    def test_unsafe_destinations_rejected(self):
        for url in ['http://cdninstagram.com/a', 'https://cdninstagram.com.evil/a',
                    'https://user@cdninstagram.com/a', 'https://127.0.0.1/a']:
            with self.subTest(url=url), self.assertRaises(app.UserVisibleError):
                app.instagram_safe_url(url)


class LifecycleTests(unittest.TestCase):
    def tearDown(self):
        for job in list(app.INSTAGRAM_JOBS.values()):
            job.cleanup()
        app.INSTAGRAM_JOBS.clear()

    def test_start_retry_never_starts_another_recorder(self):
        with patch.object(app.InstagramCapture, 'run'), patch.object(threading.Thread, 'start') as start, \
                patch.object(threading.Timer, 'start'):
            self.assertTrue(app.instagram_action('start', payload())['ok'])
            self.assertTrue(app.instagram_action('start', payload())['ok'])
            self.assertEqual(start.call_count, 1)

    def test_stop_before_spawn_is_retained_and_stop_does_not_touch_instagram_broadcast(self):
        job = app.InstagramCapture(payload())
        try:
            self.assertTrue(job.stop())
            self.assertTrue(job.stop_event.is_set())
            self.assertEqual(job.reason, 'user')
        finally:
            job.cleanup()

    def test_callback_destination_is_fixed(self):
        data = payload()
        data['completionUrl'] = 'https://attacker.example/'
        with self.assertRaises(ValueError):
            app.InstagramCapture(data)

    def test_send_is_not_replayed_after_ambiguous_failure(self):
        job = app.InstagramCapture(payload())
        job.state = 'sending'
        try:
            with patch.object(app, 'upload_complete_file') as upload:
                self.assertFalse(job.send()['ok'])
                upload.assert_not_called()
        finally:
            job.cleanup()


    def test_confirmed_telegram_flood_reuses_prepared_file_and_never_duplicates_delivery(self):
        class Flood(Exception):
            code = 420
            seconds = 231

        job = app.InstagramCapture(payload('replay'))
        job.path.write_bytes(b'prepared recording fixture')
        job.video = {'width': '160', 'height': '120', 'duration': '2'}
        job.state = 'ready'
        calls = []

        async def upload(token, method, data, file):
            calls.append(file[1].read())
            if len(calls) == 1:
                raise Flood('wait 231 seconds')
            return {'message_id': 42, 'file_id': 'cached-id'}

        try:
            with patch.object(app, 'upload_complete_file', side_effect=upload), \
                 patch.object(job, 'safe_status'), patch.object(app, 'store_uploaded_file'), \
                 patch.object(app, 'delete_status'):
                rejected = job.send()
                self.assertFalse(rejected['ok'])
                self.assertTrue(rejected['retrySafe'])
                self.assertEqual(rejected['phase'], 'upload')
                self.assertEqual(rejected['errorCode'], 'FLOOD_WAIT')
                self.assertEqual(rejected['retryAfterSeconds'], 231)
                self.assertEqual(job.state, 'ready')
                self.assertTrue(job.path.exists())
                self.assertTrue(job.send()['ok'])
                self.assertTrue(job.send()['ok'])
            self.assertEqual(calls, [b'prepared recording fixture'] * 2)
            self.assertEqual(job.state, 'sent')
        finally:
            job.cleanup()

    def test_ambiguous_upload_and_post_delivery_flood_are_never_replayed(self):
        class Flood(Exception):
            code = 420
            seconds = 231

        for fail_after_delivery in (False, True):
            job = app.InstagramCapture(payload('replay'))
            job.path.write_bytes(b'prepared recording fixture')
            job.video = {'width': '160', 'height': '120', 'duration': '2'}
            job.state = 'ready'
            calls = []

            async def upload(token, method, data, file):
                calls.append(method)
                if not fail_after_delivery:
                    raise TimeoutError('ambiguous telegram send')
                return {'message_id': 42, 'file_id': 'cached-id'}

            try:
                with patch.object(app, 'upload_complete_file', side_effect=upload), \
                     patch.object(job, 'safe_status'), patch.object(app, 'delete_status'), \
                     patch.object(app, 'store_uploaded_file', side_effect=Flood('post delivery')) if fail_after_delivery else patch.object(app, 'store_uploaded_file'):
                    failed = job.send()
                    self.assertFalse(failed['ok'])
                    self.assertNotIn('retrySafe', failed)
                    self.assertEqual(job.state, 'failed')
                    self.assertFalse(job.send()['ok'])
                    self.assertEqual(calls, ['sendVideo'])
            finally:
                job.cleanup()


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class FFmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.fixture = Path(cls.directory.name) / 'source.mp4'
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                        '-f', 'lavfi', '-i', 'color=c=blue:size=160x120:rate=10',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
                        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(cls.fixture)], check=True)
        cls.real_popen = subprocess.Popen

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_post_larger_than_url_limit_streams_complete_mp4_and_keeps_its_original_bytes(self):
        # A legal MP4 free box makes a real playable fixture exceed 20 MB.
        import hashlib
        large = Path(self.directory.name) / 'large-post.mp4'
        with large.open('wb') as out:
            out.write(self.fixture.read_bytes())
            padding = 24_000_000
            out.write((padding + 8).to_bytes(4, 'big') + b'free')
            for _ in range(24):
                out.write(b'\0' * 1_000_000)
        size = large.stat().st_size
        expected = hashlib.sha256(large.read_bytes()).hexdigest()

        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=self.directory.name))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        data = payload('replay')
        data['userId'] = 42
        data['source'] = {'mode': 'replay', 'title': 'Instagram', 'instagramPost': {'shortcode': 'B', 'media': [
            {'kind': 'video', 'url': CDN + 'large-post.mp4', 'width': 160, 'height': 120, 'size': size},
        ]}}
        job = app.InstagramCapture(data)
        real_get = app.requests.get
        uploaded = []

        async def upload(token, method, fields, file):
            digest = hashlib.sha256()
            total = 0
            for chunk in iter(lambda: file[1].read(1024 * 1024), b''):
                total += len(chunk)
                digest.update(chunk)
            uploaded.append((total, digest.hexdigest()))
            self.assertEqual(method, 'sendVideo')
            self.assertGreater(float(fields['duration']), 0)
            return {'message_id': 12, 'file_id': 'test-large-file'}

        try:
            with patch.object(app.requests, 'get', side_effect=lambda url, **kw: real_get(
                    f'http://127.0.0.1:{server.server_port}/large-post.mp4', **kw)), \
                    patch.object(job, 'safe_status'), patch.object(job, 'notify'), \
                    patch.object(app, 'reuse_cached_file', return_value=False), patch.object(app, 'store_uploaded_file'), \
                    patch.object(app, 'delete_status'), patch.object(app, 'upload_complete_file', side_effect=upload):
                job.run()
                self.assertEqual(job.send(), {'ok': True, 'parts': 1})
                self.assertEqual(uploaded, [(size, expected)])
                self.assertGreater(size, 20_000_000)
        finally:
            job.cleanup()
            server.shutdown()
            server.server_close()
            thread.join(5)

    def capture(self, mode, stop=False, expected=None, fail=False, audio=False):
        data = payload(mode)
        data['source']['duration'] = expected
        data['source']['audioOnly'] = audio
        job = app.InstagramCapture(data)
        recording = threading.Event()

        def status(text, **kwargs):
            if 'شروع شد' in text:
                recording.set()

        def popen(command, *args, **kwargs):
            command = list(command)
            # Replace only the remote fixture with a generated local H.264/AAC file.
            if command[0] == 'ffmpeg' and '-progress' in command:
                index = command.index('-i')
                command[index + 1] = str(self.fixture)
                if mode == 'live':
                    command[index:index] = ['-re', '-stream_loop', '-1']
                if fail:
                    command[index + 1] = '/nonexistent/file.mp4'
            return self.real_popen(command, *args, **kwargs)

        with patch.object(app, 'instagram_read_manifest', return_value=(STATIC.replace('static', 'dynamic'), CDN + 'live.mpd')), \
             patch.object(app.subprocess, 'Popen', side_effect=popen), \
             patch.object(job, 'safe_status', side_effect=status), patch.object(job, 'notify'):
            if stop:
                job.thread.start()
                self.assertTrue(recording.wait(5))
                threading.Event().wait(1.3)  # Capture actual audio/video packets before SIGINT.
                self.assertTrue(job.stop())
                job.thread.join(15)
                self.assertFalse(job.thread.is_alive())
            else:
                job.run()
        return job

    def assert_video(self, job):
        self.assertTrue(job.result['ok'], job.result)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(job.path)]))
        self.assertEqual({stream['codec_type'] for stream in info['streams']}, {'audio', 'video'})
        self.assertGreater(float(job.video['duration']), 0)

    def test_user_stop_finalizes_a_playable_file_with_audio(self):
        job = self.capture('live', stop=True)
        try:
            self.assert_video(job)
            self.assertEqual(job.reason, 'user')
        finally:
            job.cleanup()

    def test_replay_is_complete_and_preserves_audio(self):
        job = self.capture('replay', expected=2)
        try:
            self.assert_video(job)
        finally:
            job.cleanup()

    def test_instagram_audio_extraction_has_audio_without_video(self):
        job = self.capture('replay', expected=2, audio=True)
        try:
            self.assertTrue(job.result['ok'], job.result)
            self.assertEqual(job.path.suffix, '.m4a')
            info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(job.path)]))
            self.assertEqual([s['codec_type'] for s in info['streams']], ['audio'])
        finally:
            job.cleanup()

    def test_short_replay_is_rejected_instead_of_sending_partial(self):
        job = self.capture('replay', expected=120)
        try:
            self.assertFalse(job.result['ok'])
            self.assertIn('ناقص', job.result['message'])
        finally:
            job.cleanup()

    def test_ffmpeg_failure_never_becomes_ready(self):
        job = self.capture('replay', fail=True)
        try:
            self.assertFalse(job.result['ok'])
            self.assertEqual(job.state, 'failed')
        finally:
            job.cleanup()

    def test_replay_size_cap_rejects_the_truncated_file(self):
        with patch.object(app, 'INSTAGRAM_FILE_LIMIT', 1000):
            job = self.capture('replay')
        try:
            self.assertFalse(job.result['ok'])
            self.assertIn('ناقص', job.result['message'])
        finally:
            job.cleanup()

    def test_live_time_cap_finalizes_the_recording(self):
        with patch.object(app, 'INSTAGRAM_RECORD_SECONDS', 1):
            job = self.capture('live')
        try:
            self.assert_video(job)
            self.assertEqual(job.reason, 'time_limit')
        finally:
            job.cleanup()

    def test_static_dash_replay_downloads_and_muxes_separate_audio_and_video(self):
        directory = Path(self.directory.name) / 'dash'
        directory.mkdir(exist_ok=True)
        subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(self.fixture),
                        '-map', '0', '-c', 'copy', '-f', 'dash', str(directory / 'replay.mpd')], check=True)
        key, cert = directory / 'key.pem', directory / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(key), '-out', str(cert), '-subj', '/CN=localhost'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        class QuietHandler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(directory)))
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        server.socket = tls.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'https://127.0.0.1:{server.server_port}/replay.mpd'
        data = payload('replay')
        data['source']['url'] = url
        job = app.InstagramCapture(data)
        real_get = app.requests.get
        try:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            with patch.object(app, 'instagram_safe_url', side_effect=lambda value: value), \
                 patch.object(app.requests, 'get', side_effect=lambda *args, **kw: real_get(*args, **kw, verify=False)), \
                 patch.object(job, 'safe_status'), patch.object(job, 'notify'):
                job.run()
            self.assert_video(job)
        finally:
            job.cleanup()
            server.shutdown()
            server.server_close()


class PostUploadTests(unittest.TestCase):
    def test_profile_story_uses_existing_complete_sender_with_story_callbacks(self):
        data = payload('replay')
        data['id'] += '-profile-1'
        data['completionUrl'] += '-profile-1'
        data['userId'] = 42
        data['source'] = {'mode': 'replay', 'title': 'Instagram', 'instagramPost': {
            'shortcode': '999', 'storyId': '999', 'media': [
                {'kind': 'video', 'url': CDN + 'story.mp4', 'size': 4}]}}
        job = app.InstagramCapture(data)
        sent = []

        async def upload(token, method, body, file):
            sent.append(body)
            return {'message_id': 10, 'video': {'file_id': 'story-file'}}

        def download(item, path, deadline):
            path.write_bytes(b'abcd')
            return 4

        try:
            with patch.object(job, 'notify'), patch.object(job, 'safe_status'), \
                 patch.object(job, 'download_post_item', side_effect=download), \
                 patch.object(app, 'reuse_cached_file', return_value=False), \
                 patch.object(app, 'upload_complete_file', side_effect=upload), \
                 patch.object(app, 'store_uploaded_file'), patch.object(app, 'delete_status'), \
                 patch.object(app.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                     json.dumps({'streams': [{'codec_type': 'video', 'width': 720, 'height': 1280}], 'format': {'duration': '1'}}), '')):
                job.run()
                self.assertEqual(job.state, 'ready')
                self.assertTrue(job.send()['ok'])
            markup = json.loads(sent[0]['reply_markup'])
            self.assertEqual(markup['inline_keyboard'][0][0]['callback_data'], 'iga|s|999|0|42')
            self.assertEqual(markup['inline_keyboard'][0][1]['callback_data'], 'igm|s|999|0|42')
        finally:
            job.cleanup()

    def setUp(self):
        data = payload('replay')
        data['userId'] = 42
        data['source'] = {'mode': 'replay', 'title': 'Instagram', 'instagramPost': {'shortcode': 'B', 'media': [
            {'kind': 'photo', 'url': CDN + 'photo.jpg', 'size': 4},
            {'kind': 'video', 'url': CDN + 'video.mp4', 'size': 4},
        ]}}
        self.job = app.InstagramCapture(data)
        self.status = patch.object(self.job, 'safe_status').start()
        self.notify = patch.object(self.job, 'notify').start()
        self.addCleanup(patch.stopall)
        self.addCleanup(self.job.cleanup)
        self.info = json.dumps({'streams': [{'codec_type': 'video', 'width': 1080, 'height': 1920}],
                                'format': {'duration': '12.5'}})

    def response(self, body=b'abcd', length='4', status=200, location=None):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = status
        response.headers = {'content-length': length} if length else {}
        if location:
            response.headers['location'] = location
        response.iter_content.return_value = [body]
        return response

    def test_mixed_album_uploads_in_order_without_transcoding_and_retrying_send_does_not_duplicate(self):
        calls = []

        async def upload(token, method, data, file):
            calls.append((method, data, file[1].read()))
            return {'message_id': len(calls), 'file_id': 'sent-file'}

        with patch.object(app.requests, 'get', side_effect=lambda *args, **kwargs: self.response()) as get, \
                patch.object(app, 'reuse_cached_file', return_value=False), \
                patch.object(app.subprocess, 'run', return_value=MagicMock(stdout=self.info)) as probe, \
                patch.object(app, 'upload_complete_file', side_effect=upload), \
                patch.object(app, 'store_uploaded_file') as cache, patch.object(app, 'delete_status'):
            self.job.run()
            self.assertEqual(self.job.state, 'ready')
            self.assertEqual(get.call_count, 0)
            self.assertEqual(self.job.send(), {'ok': True, 'parts': 2})
            self.assertEqual(self.job.send(), {'ok': True, 'parts': 2})
            self.assertEqual([c[0] for c in calls], ['sendPhoto', 'sendVideo'])
            self.assertEqual([c[2] for c in calls], [b'abcd', b'abcd'])
            self.assertEqual(calls[0][1]['caption'], 'Instagram • 1/2')
            self.assertIn('reply_parameters', calls[0][1])
            self.assertNotIn('reply_parameters', calls[1][1])
            self.assertEqual(json.loads(calls[1][1]['reply_markup'])['inline_keyboard'][0][0]['callback_data'], 'iga|p|B|1|42')
            self.assertEqual(cache.call_args.args[1], ['ig:42:B:1:video'])
            self.assertEqual(probe.call_args.args[0][0], 'ffprobe')
            self.assertEqual(get.call_count, 2)
            self.assertFalse(get.call_args.kwargs['allow_redirects'])
            self.assertNotIn('Cookie', get.call_args.kwargs['headers'])
            self.assertEqual(list(self.job.workdir.iterdir()), [])

    def test_partial_or_over_limit_download_is_never_uploaded(self):
        cases = [self.response(body=b'a'), self.response(length='2000000001'),
                 self.response(body=b'abcde', length=None)]
        for response in cases:
            with self.subTest(response=response):
                path = self.job.workdir / 'download.mp4'
                with patch.object(app.requests, 'get', return_value=response), self.assertRaises(app.UserVisibleError):
                    self.job.download_post_item({'kind': 'video', 'url': CDN + 'video.mp4', 'size': 4}, path, app.time.monotonic() + 60)
                path.unlink(missing_ok=True)

    def test_stream_enforces_limit_even_without_a_content_length(self):
        with patch.object(app.requests, 'get', return_value=self.response(body=b'abcde', length=None)), \
                patch.object(app, 'DIRECT_TELEGRAM_LIMIT', 4), self.assertRaises(app.UserVisibleError):
            self.job.download_post_item({'kind': 'video', 'url': CDN + 'video.mp4'}, self.job.workdir / 'download.mp4', app.time.monotonic() + 60)

    def test_video_reuses_telegram_cache_only_after_the_current_post_was_resolved(self):
        self.job.source['instagramPost']['media'] = [self.job.source['instagramPost']['media'][1]]
        with patch.object(app, 'reuse_cached_file', return_value=True) as cache, \
                patch.object(app.requests, 'get') as get, patch.object(app, 'upload_complete_file') as upload, \
                patch.object(app, 'delete_status'):
            self.job.run()
            self.assertEqual(self.job.send(), {'ok': True, 'parts': 1})
            self.assertEqual(cache.call_args.args[1], 'ig:42:B:0:video')
            get.assert_not_called()
            upload.assert_not_called()

    def test_redirects_cannot_escape_instagram_cdn(self):
        with patch.object(app.requests, 'get', return_value=self.response(status=302, location='http://127.0.0.1/private')) as get, \
                self.assertRaises(app.UserVisibleError):
            self.job.download_post_item({'kind': 'video', 'url': CDN + 'video.mp4'}, self.job.workdir / 'download.mp4', app.time.monotonic() + 60)
        self.assertEqual(get.call_count, 1)

    def test_incomplete_file_after_an_earlier_delivery_records_only_confirmed_items(self):
        with patch.object(app.requests, 'get', side_effect=[self.response(), self.response(body=b'a')]), \
                patch.object(app, 'reuse_cached_file', return_value=False), \
                patch.object(app, 'upload_complete_file', new_callable=AsyncMock) as upload, \
                patch.object(app, 'delete_status'):
            self.job.run()
            result = self.job.send()
            self.assertFalse(result['ok'])
            self.assertEqual(result['parts'], 1)
            self.assertEqual(upload.await_count, 1)
            self.assertEqual(self.job.state, 'failed')
            self.assertFalse(self.job.send()['ok'])

    def test_flood_wait_keeps_current_file_and_resumes_without_resending_previous_items(self):
        class Flood(Exception):
            code = 420
            seconds = 1158
            message = 'FLOOD_WAIT_1158'
        calls = []

        async def upload(token, method, data, file):
            calls.append((method, file[1].read()))
            if len(calls) == 2:
                raise Flood('wait 1158 seconds')
            return {'message_id': len(calls), 'file_id': 'sent-file'}

        with patch.object(app.requests, 'get', side_effect=lambda *args, **kwargs: self.response()) as get, \
                patch.object(app, 'reuse_cached_file', return_value=False), \
                patch.object(app.subprocess, 'run', return_value=MagicMock(stdout=self.info)), \
                patch.object(app, 'upload_complete_file', side_effect=upload), \
                patch.object(app, 'store_uploaded_file'), patch.object(app, 'delete_status'):
            self.job.run()
            result = self.job.send()
            self.assertTrue(result['retrySafe'])
            self.assertEqual(result['retryAfterSeconds'], 1158)
            self.assertEqual(result['parts'], 1)
            self.assertEqual(self.job.state, 'ready')
            self.assertEqual(self.job.send(), {'ok': True, 'parts': 2})
            self.assertEqual([c[0] for c in calls], ['sendPhoto', 'sendVideo', 'sendVideo'])
            self.assertEqual(get.call_count, 2)

    def test_ambiguous_send_failure_never_reuploads(self):
        with patch.object(app.requests, 'get', return_value=self.response()), \
                patch.object(app, 'upload_complete_file', new_callable=AsyncMock, side_effect=TimeoutError('ambiguous')) as upload:
            self.job.run()
            result = self.job.send()
            self.assertFalse(result['ok'])
            self.assertNotIn('retrySafe', result)
            self.assertEqual(result['parts'], 0)
            self.assertFalse(self.job.send()['ok'])
            self.assertEqual(upload.await_count, 1)


if __name__ == '__main__':
    unittest.main()
