import asyncio
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline


class BudgetTests(unittest.TestCase):
    def test_expired_job_cannot_start_a_new_process_or_upload(self):
        token = app.JOB_DEADLINE.set(time.monotonic() - 1)
        try:
            with patch.object(pipeline.subprocess, 'Popen') as process:
                with self.assertRaises(app.UserVisibleError):
                    pipeline._run([sys.executable, '-c', 'pass'], 1500)
                process.assert_not_called()
            with patch.object(app, 'upload_complete_file') as upload:
                with self.assertRaises(app.UserVisibleError):
                    app.telegram_call('fictional', 'sendVideo', files={'video': ('name', None, 'video/mp4')})
                upload.assert_not_called()
        finally:
            app.JOB_DEADLINE.reset(token)

    def test_timeout_stops_the_downloader_and_its_child_process(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'orphan-finished'
            child = f'import time;from pathlib import Path;time.sleep(.6);Path({str(marker)!r}).write_text("orphan")'
            parent = f'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c",{child!r}]);time.sleep(10)'
            token = app.JOB_DEADLINE.set(time.monotonic() + .25)
            try:
                with self.assertRaises(subprocess.TimeoutExpired):
                    pipeline._run([sys.executable, '-c', parent], 1500)
                time.sleep(.7)
                self.assertFalse(marker.exists(), 'a child must not continue after the job timeout')
            finally:
                app.JOB_DEADLINE.reset(token)

    def test_mtproto_upload_is_cancelled_within_remaining_job_time(self):
        cancelled = []
        async def upload(*args):
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.append(True)
        token = app.JOB_DEADLINE.set(time.monotonic() + .05)
        try:
            with patch.object(app, 'upload_complete_file', side_effect=upload):
                with self.assertRaises(TimeoutError):
                    app.telegram_call('fictional', 'sendVideo', files={'video': ('name', None, 'video/mp4')}, timeout=1800)
            self.assertEqual(cancelled, [True])
        finally:
            app.JOB_DEADLINE.reset(token)

    def test_expiry_prevents_publish_and_restores_context_for_the_next_job(self):
        def expire(*args):
            app.JOB_DEADLINE.set(time.monotonic() - 1)
            app.job_timeout(1500)
        with patch.object(app, 'reuse_cached_file', return_value=False), \
             patch.object(app, 'load_metadata_cache', return_value={'id':'abcdefghijk','title':'fixture'}), \
             patch.object(app, 'available_qualities', return_value=[720]), \
             patch.object(app, 'download_video', side_effect=expire), \
             patch.object(app, 'send_media_file') as send, patch.object(app, 'edit_status') as status:
            result = app.process_job({'botToken':'fictional','url':'https://www.youtube.com/watch?v=abcdefghijk',
                'chatId':42,'requestMessageId':7,'statusMessageId':10,'quality':720})
        self.assertFalse(result['ok'])
        self.assertIn('زمان', result['message'])
        send.assert_not_called()
        self.assertIn('زمان', status.call_args.args[-1])
        self.assertIsNone(app.JOB_DEADLINE.get())

    def test_independent_instagram_action_ids_retain_completion_and_cache_routes(self):
        for suffix in ['-audio', '-song']:
            job_id = 'igdl--42-7-42' + suffix
            payload = {'id':job_id,'source':{'mode':'replay','audioOnly':True},
                       'completionUrl':f'https://downloader.vexaagent.workers.dev/instagram/events/{job_id}',
                       'completionToken':'a'*64,'cacheToken':'b'*64,
                       'cacheUrl':f'https://downloader.vexaagent.workers.dev/media-cache/{job_id}'}
            capture = app.InstagramCapture(payload)
            try:
                with patch.object(app.requests, 'post') as post:
                    post.return_value.ok = True
                    post.return_value.json.return_value = {'value':{'fileId':'fixture'}}
                    self.assertEqual(app.file_cache(payload,'get','ig:42:123:0:audio'), {'fileId':'fixture'})
                    self.assertEqual(post.call_args.args[0],payload['cacheUrl'])
            finally:
                capture.cleanup()


if __name__ == '__main__':
    unittest.main()
