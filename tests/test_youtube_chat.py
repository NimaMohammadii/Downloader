import asyncio
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline
from telethon import types


class FakeClient:
    instances = []

    def __init__(self, *args, **kwargs):
        self.parts = {}
        self.sent = None
        self.active = self.peak = 0
        self.__class__.instances.append(self)

    async def start(self, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def __call__(self, request):
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(0)
        self.parts[request.file_part] = request.bytes
        self.active -= 1
        return True

    async def send_file(self, *args, **kwargs):
        self.sent = (args, kwargs)
        return type('Message', (), {'id': 123})()


class ChatTests(unittest.TestCase):
    def upload(self, size):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'video.mp4'
            content = (bytes(range(256)) * ((size + 255) // 256))[:size]
            path.write_bytes(content)
            with patch.dict(os.environ, {'API_ID': '123', 'API_HASH': 'test'}), \
                 patch('telethon.TelegramClient', FakeClient), path.open('rb') as handle:
                result = app.telegram_call('token', 'sendVideo', data={
                    'chat_id': '42', 'caption': 'literal *title*', 'width': '1280',
                    'height': '720', 'duration': '31',
                    'reply_parameters': '{"message_id": 7}',
                }, files={'video': (path.name, handle, 'video/mp4')})
        client = FakeClient.instances[-1]
        self.assertEqual(result['message_id'], 123)
        self.assertEqual(b''.join(client.parts[i] for i in sorted(client.parts)), content)
        self.assertLessEqual(client.peak, 8)
        args, options = client.sent
        self.assertEqual(options['reply_to'], 7)
        self.assertIsNone(options['parse_mode'])
        self.assertEqual(options['attributes'][1].w, 1280)
        return args[1], content

    def test_large_video_is_one_message_with_complete_ordered_bytes(self):
        uploaded, _ = self.upload(51_000_001)
        self.assertIsInstance(uploaded, types.InputFileBig)
        self.assertEqual(uploaded.parts, 98)

    def test_small_video_has_correct_checksum(self):
        uploaded, content = self.upload(600_001)
        self.assertIsInstance(uploaded, types.InputFile)
        self.assertEqual(uploaded.md5_checksum, hashlib.md5(content).hexdigest())

    def test_animation_upload_sets_native_animated_attribute_and_preserves_complete_bytes(self):
        content=b'GIF89a-complete-animation-fixture'
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'Animation.gif';path.write_bytes(content)
            with patch.dict(os.environ,{'API_ID':'123','API_HASH':'test'}),patch('telethon.TelegramClient',FakeClient),path.open('rb') as handle:
                asyncio.run(app.upload_complete_file('token','sendAnimation',{'chat_id':'42'},(path.name,handle,'image/gif')))
        client=FakeClient.instances[-1]
        self.assertEqual(b''.join(client.parts[i] for i in sorted(client.parts)),content)
        options=client.sent[1]
        self.assertTrue(any(isinstance(a,types.DocumentAttributeAnimated) for a in options['attributes']))
        self.assertEqual(options['mime_type'],'image/gif')
        self.assertFalse(options['force_document'])

    def test_slow_part_does_not_block_refilling_upload_slots(self):
        original_call = FakeClient.__call__
        original_send = FakeClient.send_file

        async def delayed_call(client, request):
            if not hasattr(client, 'later_part_started'):
                client.later_part_started = asyncio.Event()
                client.first_part_done = False
            if request.file_part == 0:
                # Part 8 must start while part 0 is still pending. A batch
                # barrier deadlocks here instead of keeping free slots busy.
                await asyncio.wait_for(client.later_part_started.wait(), timeout=1)
            elif request.file_part == 8:
                client.later_part_started.set()
            result = await original_call(client, request)
            if request.file_part == 0:
                client.first_part_done = True
            return result

        async def checked_send(client, *args, **kwargs):
            self.assertTrue(client.first_part_done, 'publish must await the slow part too')
            self.assertEqual(len(client.parts), 11)
            return await original_send(client, *args, **kwargs)

        with patch.object(FakeClient, '__call__', delayed_call), \
             patch.object(FakeClient, 'send_file', checked_send):
            uploaded, content = self.upload(10 * 512 * 1024 + 123)
        self.assertEqual(uploaded.md5_checksum, hashlib.md5(content).hexdigest())

    def test_failure_after_refill_cancels_pending_parts_without_publishing(self):
        original_call = FakeClient.__call__

        async def failing_call(client, request):
            if request.file_part == 0:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    client.pending_part_cancelled = True
                    raise
            if request.file_part == 8:
                raise RuntimeError('part rejected after upload slot refill')
            return await original_call(client, request)

        with patch.object(FakeClient, '__call__', failing_call), \
             self.assertRaises(ExceptionGroup):
            self.upload(10 * 512 * 1024 + 123)
        client = FakeClient.instances[-1]
        self.assertTrue(client.pending_part_cancelled)
        self.assertIsNone(client.sent)

    def test_uploaded_document_returns_reusable_bot_file_id(self):
        from datetime import datetime, timezone
        from telethon import utils
        from types import SimpleNamespace
        class DocumentClient(FakeClient):
            async def send_file(self,*args,**kwargs):
                await super().send_file(*args,**kwargs)
                document=types.Document(id=12345,access_hash=67890,file_reference=b'',
                    date=datetime.now(timezone.utc),mime_type='video/mp4',size=100,dc_id=2,
                    attributes=[types.DocumentAttributeFilename('video.mp4'),types.DocumentAttributeVideo(duration=1,w=32,h=32)])
                return SimpleNamespace(id=123,document=document)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'video.mp4';path.write_bytes(b'complete fixture')
            with patch.dict(os.environ,{'API_ID':'123','API_HASH':'test'}),patch('telethon.TelegramClient',DocumentClient),path.open('rb') as handle:
                result=asyncio.run(app.upload_complete_file('token','sendVideo',{'chat_id':'42'},(path.name,handle,'video/mp4')))
        self.assertEqual(utils.resolve_bot_file_id(result['file_id']).id,12345)

    def test_oversized_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'big.mp4'
            with path.open('wb') as handle:
                handle.truncate(app.DIRECT_TELEGRAM_LIMIT + 1)
            with self.assertRaises(app.UserVisibleError):
                app.validate_file_size(path)

    def test_status_uses_existing_bot_api(self):
        with patch.object(app.requests, 'post') as post:
            post.return_value.ok = True
            post.return_value.json.return_value = {'ok': True, 'result': True}
            app.edit_status('token', 42, 7, 'ready')
            self.assertEqual(post.call_args.args[0], 'https://api.telegram.org/bottoken/editMessageText')

    def test_missing_upload_part_never_publishes_file(self):
        with patch.object(FakeClient, '__call__', AsyncMock(return_value=False)), \
             self.assertRaises(ExceptionGroup):
            self.upload(600_001)
        self.assertIsNone(FakeClient.instances[-1].sent)

    def test_download_aborts_missing_fragments(self):
        args = pipeline._download_args('web_embedded')
        self.assertIn('--abort-on-unavailable-fragments', args)
        self.assertIn(str(app.DIRECT_TELEGRAM_LIMIT), args)

    def test_no_reextraction_after_download(self):
        with patch.object(pipeline, 'available_qualities', return_value=[720]), \
             patch.object(pipeline, '_load_session_client', return_value='web_embedded'), \
             patch.object(pipeline, '_source_ratio', return_value=None), \
             patch.object(pipeline, '_download_video_with_client', return_value=Path('/tmp/video.mp4')), \
             patch.object(pipeline, '_fetch_metadata_for_client') as fetch:
            self.assertEqual(pipeline.download_video('url', Path('/tmp'), 720, {}), Path('/tmp/video.mp4'))
            fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
