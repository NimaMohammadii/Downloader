import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline
import pornhub


class PornhubTests(unittest.TestCase):
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
        with patch.object(pornhub.subprocess, 'run', side_effect=results) as run, \
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
                self.assertEqual(command[-2], '--')
            self.assertIn('--abort-on-unavailable-fragments', calls[1].args[0])
            self.assertIn(str(app.DIRECT_TELEGRAM_LIMIT), calls[1].args[0])

    def test_short_or_unreadable_file_is_rejected(self):
        for duration in [0, 40, float('nan')]:
            with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(app.UserVisibleError, 'ناقص'):
                self.download(directory, duration=duration)

    def test_unavailable_or_timed_out_source_has_friendly_pornhub_error(self):
        errors = [subprocess.CalledProcessError(1, 'yt-dlp', stderr='private video secret-url'),
                  subprocess.TimeoutExpired('yt-dlp', 90)]
        for error in errors:
            with tempfile.TemporaryDirectory() as directory, \
                 patch.object(pornhub.subprocess, 'run', side_effect=error), \
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
