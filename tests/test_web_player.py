import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
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


if __name__ == '__main__':
    unittest.main()
