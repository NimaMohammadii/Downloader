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
from unittest.mock import patch

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


if __name__ == '__main__':
    unittest.main()
