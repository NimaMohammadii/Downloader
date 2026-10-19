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

    async def disconnect(self):
        self.disconnected = True

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
    def upload(self, size, client_type=FakeClient, expected_reply=7):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'video.mp4'
            content = (bytes(range(256)) * ((size + 255) // 256))[:size]
            path.write_bytes(content)
            with patch.dict(os.environ, {'API_ID': '123', 'API_HASH': 'test'}), \
                 patch('telethon.TelegramClient', client_type), path.open('rb') as handle:
                result = app.telegram_call('token', 'sendVideo', data={
                    'chat_id': '42', 'caption': 'literal *title*', 'width': '1280',
                    'height': '720', 'duration': '31',
                    'reply_parameters': '{"message_id": 7}',
                }, files={'video': (path.name, handle, 'video/mp4')})
        client = client_type.instances[-1]
        self.assertEqual(result['message_id'], 123)
        self.assertEqual(b''.join(client.parts[i] for i in sorted(client.parts)), content)
        self.assertLessEqual(client.peak, 8)
        args, options = client.sent
        self.assertEqual(options['reply_to'], expected_reply)
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

    def test_missing_reply_reuses_uploaded_file_once_without_reuploading_parts(self):
        from telethon.errors import RPCError
        class MissingReplyClient(FakeClient):
            async def send_file(self,*args,**kwargs):
                self.attempts=getattr(self,'attempts',[])+[(args,kwargs)]
                if kwargs.get('reply_to'):
                    raise RPCError(None,'REPLY_MESSAGE_ID_INVALID',400)
                return await super().send_file(*args,**kwargs)
        self.upload(600_001,MissingReplyClient,None)
        client=MissingReplyClient.instances[-1]
        self.assertEqual(len(client.attempts),2)
        self.assertEqual(client.attempts[0][1]['reply_to'],7);self.assertIsNone(client.attempts[1][1]['reply_to'])
        self.assertIs(client.attempts[0][0][1],client.attempts[1][0][1])
        self.assertEqual(len(client.parts),2)
        self.assertEqual(client.attempts[0][1]['caption'],client.attempts[1][1]['caption'])

    def test_upload_does_not_retry_ambiguous_or_unrelated_send_failures(self):
        from telethon.errors import RPCError
        for error in [TimeoutError('delivery unknown'),RPCError(None,'BUTTON_DATA_INVALID',400),RPCError(None,'MSG_ID_INVALID',400)]:
            class FailedClient(FakeClient):
                async def send_file(self,*args,**kwargs):
                    self.attempts=getattr(self,'attempts',0)+1
                    raise error
            with self.subTest(error=type(error).__name__),self.assertRaises(type(error)):
                self.upload(600_001,FailedClient)
            self.assertEqual(FailedClient.instances[-1].attempts,1)

    def test_bot_api_replies_allow_deleted_request_without_mutating_the_original_payload(self):
        import json
        from unittest.mock import MagicMock
        response=MagicMock();response.ok=True;response.json.return_value={'ok':True,'result':{'message_id':8}}
        for use_form in [False,True]:
            body={'chat_id':42,'audio':'cached-file','reply_parameters':json.dumps({'message_id':7}) if use_form else {'message_id':7}}
            with patch.object(app.requests,'post',return_value=response) as post:
                result=app.telegram_call('fake','sendAudio',**({'data':body} if use_form else {'json_payload':body}))
            sent=post.call_args.kwargs['data' if use_form else 'json']
            reply=json.loads(sent['reply_parameters']) if use_form else sent['reply_parameters']
            self.assertEqual(reply,{'message_id':7,'allow_sending_without_reply':True})
            original=json.loads(body['reply_parameters']) if use_form else body['reply_parameters']
            self.assertEqual(original,{'message_id':7});self.assertEqual(result,{'message_id':8})
            post.assert_called_once()

    def test_upload_diagnostics_preserve_nested_rpc_cause_without_exposing_credentials(self):
        from telethon.errors import RPCError
        diagnostic=app.upload_error_diagnostic(ExceptionGroup('parts failed',[RPCError(None,'AUTH_KEY_UNREGISTERED',401)]),'bot-secret')
        self.assertEqual(diagnostic['errorCode'],'AUTH_KEY_UNREGISTERED')
        with patch.dict(os.environ,{'API_HASH':'api-secret','INSTAGRAM_SESSIONID':'session-secret'}):
            diagnostic=app.upload_error_diagnostic(RuntimeError('bot-secret api-secret session-secret https://cdn.example/private?token=secret cookie=hidden'),'bot-secret')
        for secret in ['bot-secret','api-secret','session-secret','cdn.example','token=secret','hidden']:
            self.assertNotIn(secret,diagnostic['diagnostic'])
        with patch.dict(os.environ,{'API_HASH':'SUPER_SECRET'}):
            self.assertNotIn('SUPER_SECRET',str(app.upload_error_diagnostic(RuntimeError('SUPER_SECRET'),'bot-secret')))

    def test_flood_retains_method_and_wait_without_serializing_the_request(self):
        from telethon import functions
        from telethon.errors import FloodWaitError
        request=functions.auth.ImportBotAuthorizationRequest(flags=0,api_id=123,api_hash='api-secret',bot_auth_token='bot-secret')
        error=FloodWaitError(request,capture=137)
        diagnostic=app.upload_error_diagnostic(ExceptionGroup('upload failed',[error]),'bot-secret')
        self.assertEqual(diagnostic['errorCode'],'FLOOD_WAIT')
        self.assertEqual(diagnostic['errorType'],'FloodWaitError')
        self.assertEqual(diagnostic['rpcMethod'],'ImportBotAuthorizationRequest')
        self.assertEqual(diagnostic['retryAfterSeconds'],137)
        for secret in ['api-secret','bot-secret']:
            self.assertNotIn(secret,str(diagnostic))

    def test_upload_starts_once_and_disconnects_even_when_login_is_rate_limited(self):
        from telethon import functions
        from telethon.errors import FloodWaitError
        class AuthClient(FakeClient):
            failure=None
            async def start(self,**kwargs):
                self.starts=getattr(self,'starts',0)+1
                if self.failure:raise self.failure
                return self
            async def __aenter__(self):
                # Match Telethon's context manager, which starts the client again.
                return await self.start()
        self.upload(600_001,AuthClient)
        client=AuthClient.instances[-1]
        self.assertEqual(client.starts,1);self.assertTrue(client.disconnected)
        AuthClient.failure=FloodWaitError(functions.auth.ImportBotAuthorizationRequest(flags=0,api_id=123,api_hash='hash',bot_auth_token='token'),capture=137)
        with self.assertRaises(FloodWaitError):self.upload(600_001,AuthClient)
        client=AuthClient.instances[-1]
        self.assertEqual(client.starts,1);self.assertTrue(client.disconnected)
        self.assertEqual(client.parts,{});self.assertIsNone(client.sent)

    def test_part_flood_is_not_retried_by_a_second_application_retry_loop(self):
        from telethon.errors import FloodWaitError
        class FloodClient(FakeClient):
            async def __call__(self,request):
                self.attempts=getattr(self,'attempts',{})
                self.attempts[request.file_part]=self.attempts.get(request.file_part,0)+1
                raise FloodWaitError(request,capture=1)
        with patch.object(app.asyncio,'sleep',new_callable=AsyncMock),self.assertRaises(ExceptionGroup):
            self.upload(600_001,FloodClient)
        client=FloodClient.instances[-1]
        self.assertTrue(all(count==1 for count in client.attempts.values()))
        self.assertIsNone(client.sent);self.assertTrue(client.disconnected)

    def test_file_caption_and_button_use_native_custom_emoji_without_changing_media(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'song.mp3';path.write_bytes(b'complete media fixture')
            caption='🎵 Song\n👤 Artist'
            markup={'inline_keyboard':[[{'text':'🎧 فقط صدا','callback_data':'signed|unchanged'}]]}
            with patch.dict(os.environ,{'API_ID':'123','API_HASH':'test'}),patch('telethon.TelegramClient',FakeClient),path.open('rb') as handle:
                asyncio.run(app.upload_complete_file('token','sendDocument',{'chat_id':'42','caption':caption,'reply_markup':json.dumps(markup)},(path.name,handle,'audio/mpeg')))
            client=FakeClient.instances[-1];options=client.sent[1]
            self.assertEqual(options['caption'],caption)
            self.assertEqual(b''.join(client.parts[i] for i in sorted(client.parts)),b'complete media fixture')
            self.assertTrue(all(isinstance(e,types.MessageEntityCustomEmoji) for e in options['formatting_entities']))
            self.assertEqual([e.document_id for e in options['formatting_entities']],[5463107823946717464,5397866377367268054])
            button=options['buttons'][0][0]
            self.assertEqual(button.text,'فقط صدا');self.assertEqual(button.style.icon,5424818078833715060)
            self.assertEqual(button.type.data,b'signed|unchanged')

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


class YouTubeJobTests(unittest.TestCase):
    def run_job(self, mode='video', status_error=None, download_error=None, send_error=None):
        from contextlib import ExitStack
        self.addCleanup(app.JOB_DEADLINE.set,None)
        body={'id':'yt-test-42','botToken':'bot-secret','url':'https://youtube.com/watch?v=abcdefghijk',
              'chatId':42,'requestMessageId':7,'statusMessageId':8,
              **({'quality':360} if mode=='video' else {'audioMode':'hq'})}
        metadata={'id':'abcdefghijk','title':'Fixture','duration':1}
        def prepare(url,directory,*args):
            if download_error:raise download_error
            path=directory/('Video.mp4' if mode=='video' else 'Audio.m4a');path.write_bytes(b'complete file');return path
        with ExitStack() as stack:
            for name,value in [('reuse_cached_file',False),('load_metadata_cache',metadata),('available_qualities',[360]),('audio_formats',[{}])]:
                stack.enter_context(patch.object(app,name,return_value=value))
            self.download=stack.enter_context(patch.object(app,'download_video' if mode=='video' else 'download_audio',side_effect=prepare))
            self.send=stack.enter_context(patch.object(app,'send_media_file' if mode=='video' else 'send_audio_file',
                                                     side_effect=send_error,return_value={'message_id':10}))
            self.status=stack.enter_context(patch.object(app,'edit_status',side_effect=status_error))
            stack.enter_context(patch.object(app,'store_uploaded_file'))
            stack.enter_context(patch.object(app,'delete_status'))
            stack.enter_context(patch('builtins.print'))
            return app.process_job(body)

    def test_failed_optional_status_edit_does_not_abort_video_or_audio_delivery(self):
        for mode in ['video','audio']:
            for reason in ['Bad Request: message to edit not found','Bad Request: message is not modified','Too Many Requests: retry after 30']:
                with self.subTest(mode=mode,reason=reason):
                    result=self.run_job(mode,status_error=RuntimeError(reason))
                    self.assertTrue(result['ok']);self.download.assert_called_once();self.send.assert_called_once()

    def test_download_and_upload_failures_have_distinct_phases_and_never_replay_delivery(self):
        result=self.run_job(download_error=RuntimeError('decoder failed bot-secret https://signed.example/private?token=secret'))
        self.assertFalse(result['ok']);self.assertEqual(result['phase'],'download');self.send.assert_not_called()
        self.assertNotIn('bot-secret',str(result));self.assertNotIn('signed.example',str(result))
        self.assertIn('دریافت',result['message']);self.assertNotIn('یه خطای موقت',result['message'])
        result=self.run_job(send_error=TimeoutError('delivery unknown'))
        self.assertEqual(result['phase'],'upload');self.send.assert_called_once();self.download.assert_called_once()
        self.assertIn('تأیید',result['message'])

    def test_flood_reports_telegram_wait_instead_of_ambiguous_delivery(self):
        from telethon import functions
        from telethon.errors import FloodWaitError,RPCError
        error=FloodWaitError(functions.upload.SaveFilePartRequest(1,0,b'private bytes'),capture=137)
        result=self.run_job(send_error=ExceptionGroup('upload parts',[error]))
        self.assertEqual(result['errorCode'],'FLOOD_WAIT')
        self.assertEqual(result['retryAfterSeconds'],137)
        self.assertIn('137',result['message']);self.assertIn('تلگرام',result['message'])
        self.assertNotIn('تأیید نشد',result['message']);self.send.assert_called_once()
        result=self.run_job(send_error=RPCError(None,'FLOOD',420))
        self.assertNotIn('retryAfterSeconds',result)
        self.assertIn('محدود',result['message']);self.send.assert_called_once()


if __name__ == '__main__':
    unittest.main()
