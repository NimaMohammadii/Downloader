import asyncio
import json
import wave
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline


class SearchTests(unittest.TestCase):
    def search(self, query, entries):
        with patch.object(pipeline, '_run', return_value=subprocess.CompletedProcess([], 0, json.dumps({'entries':entries}))) as run:
            result=pipeline.music_candidates(query)
            self.command=run.call_args.args[0]
            return result

    def test_official_audio_preferred_over_unsolicited_cover(self):
        result=self.search('Adele Hello',[
            {'id':'aaaaaaaaaaa','title':'Adele Hello cover'},
            {'id':'bbbbbbbbbbb','title':'Adele Hello Official Audio'},
        ])
        self.assertEqual(result[0]['id'],'bbbbbbbbbbb')

    def test_explicit_cover_is_respected(self):
        result=self.search('Adele Hello cover',[
            {'id':'bbbbbbbbbbb','title':'Adele Hello Official Audio'},
            {'id':'aaaaaaaaaaa','title':'Adele Hello cover'},
        ])
        self.assertEqual(result[0]['id'],'aaaaaaaaaaa')

    def test_artist_match_outweighs_official_label_for_another_artist(self):
        result=self.search('Adele Hello',[
            {'id':'bbbbbbbbbbb','title':'Lionel Richie Hello Official Audio'},
            {'id':'aaaaaaaaaaa','title':'Adele Hello cover'},
        ])
        self.assertEqual(result[0]['id'],'aaaaaaaaaaa')

    def test_live_duplicate_and_invalid_results_filtered(self):
        result=self.search('song',[
            {'id':'aaaaaaaaaaa','title':'song','is_live':True},
            {'id':'bbbbbbbbbbb','title':'song'},
            {'id':'bbbbbbbbbbb','title':'song'},
            {'id':'invalid!','title':'song'},
        ])
        self.assertEqual([v['id'] for v in result],['bbbbbbbbbbb'])

    def test_query_is_an_argument_and_cannot_inject_options(self):
        query='--exec $(touch /tmp/not-executed) song'
        self.search(query,[])
        self.assertEqual(self.command[-2: ],['--','ytsearch5:'+query])
        self.assertIn('--flat-playlist',self.command)

    def test_search_timeout_is_friendly(self):
        with patch.object(pipeline,'_run',side_effect=subprocess.TimeoutExpired('yt-dlp',60)):
            with self.assertRaisesRegex(app.UserVisibleError,'جست‌وجوی آهنگ'):
                pipeline.music_candidates('song')


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg required')
class MusicFileTests(unittest.TestCase):
    def test_music_is_real_mp3_with_title_artist_and_complete_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory)
            source=workdir/'source.m4a'
            subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',
                            'sine=frequency=440:sample_rate=44100','-t','2','-c:a','aac',str(source)],check=True)
            metadata={'title':'Original title','track':'Hello','artist':'Adele','duration':2,
                      'formats':[{'vcodec':'none','acodec':'aac','url':'https://example.test/audio'}]}
            with patch.object(pipeline,'music_candidates',return_value=[{'id':'abcdefghijk'}]), \
                 patch.object(pipeline,'fetch_metadata',return_value=metadata), \
                 patch.object(pipeline,'download_audio',return_value=source):
                path,title,artist,url=pipeline.prepare_music('Adele Hello',workdir)
            self.assertEqual((title,artist),('Hello','Adele'))
            self.assertEqual(url,'https://www.youtube.com/watch?v=abcdefghijk')
            self.assertEqual(path.suffix,'.mp3')
            info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))
            self.assertEqual(info['streams'][0]['codec_name'],'mp3')
            self.assertEqual(info['format']['tags']['title'],'Hello')
            self.assertEqual(info['format']['tags']['artist'],'Adele')
            self.assertGreater(float(info['format']['duration']),1.9)

    def test_missing_music_result_never_starts_download(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(pipeline,'music_candidates',return_value=[]), \
             patch.object(pipeline,'download_audio') as download:
            with self.assertRaisesRegex(app.UserVisibleError,'پیدا نشد'):
                pipeline.prepare_music('unknown song',Path(directory))
            download.assert_not_called()

    def test_music_capture_sends_audio_once_with_song_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'Music.mp3'
            path.write_bytes(b'fictional-upload-data')
            payload={'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,'musicQuery':'Adele Hello'},
                     'botToken':'fictional-token','chatId':42,'requestMessageId':7,'statusMessageId':10,
                     'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
                     'completionToken':'0'*64}
            job=app.InstagramCapture(payload)
            sent=[]
            async def upload(token,method,data,file):
                sent.append((method,data,file[0],file[2]))
                return {'message_id':123}
            try:
                with patch.object(pipeline,'prepare_music',return_value=(path,'Hello','Adele','https://www.youtube.com/watch?v=abcdefghijk')), \
                     patch.object(job,'safe_status'),patch.object(job,'notify') as notify:
                    job.run()
                    notify.assert_called_once()
                self.assertEqual(job.state,'ready')
                with patch.object(app,'upload_complete_file',side_effect=upload), \
                     patch.object(job,'safe_status'),patch.object(app,'delete_status'):
                    self.assertTrue(job.send()['ok'])
                    self.assertTrue(job.send()['ok'])
                self.assertEqual(len(sent),1)
                self.assertEqual(sent[0][0],'sendAudio')
                self.assertEqual(sent[0][1]['title'],'Hello')
                self.assertEqual(sent[0][1]['performer'],'Adele')
                self.assertEqual(sent[0][2: ],('Music.mp3','audio/mpeg'))
            finally:
                job.cleanup()


class MusicSelectionTests(unittest.TestCase):
    def job(self, source, suffix=''):
        job_id = 'igdl-42-7-42' + suffix
        return app.InstagramCapture({'id':job_id,'source':{'mode':'replay','audioOnly':True,**source},
            'botToken':'fictional','chatId':42,'userId':42,'requestMessageId':7,'statusMessageId':10,
            'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/'+job_id,'completionToken':'0'*64})

    def test_search_only_lists_five_choices_without_metadata_download_upload_or_cache_shortcut(self):
        import hashlib,hmac,time
        entries=[{'id':str(i)*11,'title':f'Track {i}','channel':'Artist','duration':125} for i in range(6)]
        job=self.job({'musicQuery':'Artist Track','musicSearch':True})
        try:
            with patch.object(pipeline,'music_candidates',return_value=entries),patch.object(pipeline,'prepare_music') as download, \
                 patch.object(app,'reuse_cached_file',return_value=True) as cache,patch.object(job,'notify'),patch.object(app,'upload_complete_file') as upload:
                job.run()
                self.assertEqual(job.state,'ready')
                with patch.object(app,'telegram_call') as send:
                    self.assertEqual(job.send(),{'ok':True,'parts':0})
                    job.send()
                download.assert_not_called();cache.assert_not_called();upload.assert_not_called()
                send.assert_called_once()
                body=send.call_args.kwargs['json_payload']
                self.assertIn('2:05',body['text']);self.assertIn('Artist',body['text'])
                buttons=body['reply_markup']['inline_keyboard'];self.assertEqual(len(buttons),5)
                for i,row in enumerate(buttons):
                    action,video,owner,expiry,signature=row[0]['callback_data'].split('|')
                    self.assertEqual((action,video,owner),('msc',entries[i]['id'],'42'))
                    expected=hmac.new(b'fictional',f'music-select:42:42:{video}:{expiry}'.encode(),hashlib.sha256).hexdigest()[:16]
                    self.assertEqual(signature,expected);self.assertGreater(int(expiry),time.time())
                    self.assertLessEqual(len(row[0]['callback_data'].encode()),64)
        finally:job.cleanup()

    def test_selected_song_uses_exact_video_and_mp3_cache_key_without_running_search(self):
        job=self.job({'musicVideoId':'abcdefghijk'},'-music-abcdefghijk')
        try:
            path=job.workdir/'Music.mp3';path.write_bytes(b'full fixture')
            with patch.object(app,'reuse_cached_file',return_value=False) as cache,patch.object(pipeline,'prepare_music') as search, \
                 patch.object(pipeline,'prepare_music_url',return_value=(path,'Chosen','Artist','https://www.youtube.com/watch?v=abcdefghijk')) as exact, \
                 patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            search.assert_not_called();exact.assert_called_once_with('https://www.youtube.com/watch?v=abcdefghijk',job.workdir)
            self.assertIn('yt:abcdefghijk:mp3',[c.args[1] for c in cache.call_args_list])
            self.assertEqual(job.source['title'],'Chosen');self.assertEqual(job.state,'ready')
        finally:job.cleanup()

    def test_failed_selection_never_substitutes_another_search_result(self):
        job=self.job({'musicVideoId':'abcdefghijk'},'-music-abcdefghijk')
        try:
            with patch.object(pipeline,'prepare_music_url',side_effect=app.UserVisibleError('unavailable')), \
                 patch.object(pipeline,'prepare_music') as search,patch.object(job,'notify'),patch.object(job,'safe_status'):
                job.run()
            search.assert_not_called();self.assertEqual(job.state,'failed')
        finally:job.cleanup()

    def test_empty_search_is_friendly_and_never_becomes_ready(self):
        job=self.job({'musicQuery':'Missing Track','musicSearch':True})
        try:
            with patch.object(pipeline,'music_candidates',return_value=[]),patch.object(job,'notify'),patch.object(job,'safe_status'):
                job.run()
            self.assertEqual(job.state,'failed');self.assertIn('پیدا نشد',job.result['message'])
        finally:job.cleanup()


class TextMotionTests(unittest.TestCase):
    def setUp(self):app.TEXT_MOTION_CHATS.clear()

    def test_native_private_draft_is_followed_by_complete_message_with_original_buttons(self):
        from unittest.mock import MagicMock
        reply=MagicMock();reply.ok=True;reply.json.return_value={'ok':True,'result':{'message_id':8}}
        body={'chat_id':42,'text':'متن کامل تست برای نمایش نرم و درست پیام 🎵','reply_markup':{'inline_keyboard':[[{'text':'Download','callback_data':'test'}]]}}
        with patch.object(app.requests,'post',return_value=reply) as post,patch.object(app.time,'sleep'):
            result=app.telegram_call('fictional','sendMessage',json_payload=body)
        self.assertEqual(result,{'message_id':8});self.assertEqual(len(post.call_args_list),2)
        self.assertTrue(post.call_args_list[0].args[0].endswith('/sendMessageDraft'))
        self.assertEqual(post.call_args_list[0].kwargs['json']['text'],body['text'])
        self.assertEqual(post.call_args_list[-1].kwargs['json'],body)

    def test_failed_motion_still_sends_final_and_back_to_back_messages_skip_effect(self):
        from unittest.mock import MagicMock
        reply=MagicMock();reply.ok=True;reply.json.return_value={'ok':True,'result':True}
        body={'chat_id':42,'message_id':8,'text':'Complete text for the edited message, unchanged.'}
        with patch.object(app.requests,'post',side_effect=[app.requests.Timeout(),reply,reply]) as post:
            app.telegram_call('fictional','editMessageText',json_payload=body)
            app.telegram_call('fictional','editMessageText',json_payload=body)
        self.assertEqual(len(post.call_args_list),3)
        self.assertEqual(post.call_args_list[1].kwargs['json'],body)
        self.assertEqual(post.call_args_list[2].kwargs['json'],body)

    def test_formatted_edits_callbacks_and_group_sends_are_not_rewritten(self):
        with patch.object(app.requests,'post') as post:
            app.telegram_text_motion('a','answerCallbackQuery',{'text':'Very long callback notification text','chat_id':42})
            app.telegram_text_motion('a','editMessageText',{'chat_id':42,'message_id':3,'text':'<b>A complete formatted message for editing</b>','parse_mode':'HTML'})
            app.telegram_text_motion('b','sendMessage',{'chat_id':-42,'text':'Group message with a complete original body.'})
        post.assert_not_called()

    def test_preview_rate_limit_disables_optional_effect_until_retry_after(self):
        from unittest.mock import MagicMock
        reply=MagicMock();reply.ok=False;reply.status_code=429
        reply.json.return_value={'ok':False,'parameters':{'retry_after':30}}
        body={'chat_id':42,'text':'A complete message for optional preview rate limiting.'}
        with patch.object(app.requests,'post',return_value=reply) as post:
            with patch.object(app.time,'monotonic',return_value=100):app.telegram_text_motion('fictional','sendMessage',body)
            with patch.object(app.time,'monotonic',return_value=104):app.telegram_text_motion('fictional','sendMessage',body)
        post.assert_called_once()


class RecognitionDownloadTests(unittest.TestCase):
    def response(self, chunks, headers=None, status=200):
        from unittest.mock import MagicMock
        response=MagicMock()
        response.__enter__.return_value=response
        response.status_code=status
        response.headers=headers or {}
        response.iter_content.return_value=chunks
        return response

    def test_input_is_streamed_from_telegram_without_redirects(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(app,'telegram_call',return_value={'file_path':'voice/file_1.oga','file_size':6}), \
             patch.object(app.requests,'get',return_value=self.response([b'abc',b'def'])) as get:
            path=app.download_recognition_input('fictional-token',{'fileId':'a_valid_id'},Path(directory))
            self.assertEqual(path.read_bytes(),b'abcdef')
            self.assertFalse(get.call_args.kwargs['allow_redirects'])
            self.assertTrue(get.call_args.kwargs['stream'])
            self.assertEqual(get.call_args.args[0],'https://api.telegram.org/file/botfictional-token/voice/file_1.oga')

    def test_metadata_oversize_and_path_traversal_never_download(self):
        for info in [{'file_path':'voice/file.oga','file_size':20_000_001},
                     {'file_path':'../private','file_size':10},
                     {'file_path':'https://attacker.example/file','file_size':10}]:
            with self.subTest(info=info), tempfile.TemporaryDirectory() as directory, \
                 patch.object(app,'telegram_call',return_value=info), patch.object(app.requests,'get') as get:
                with self.assertRaises(app.UserVisibleError):
                    app.download_recognition_input('secret',{'fileId':'valid'},Path(directory))
                get.assert_not_called()

    def test_stream_size_truncation_and_redirect_are_rejected(self):
        cases=[self.response([b'x'*11]), self.response([],status=302),
               self.response([b'x'*4],headers={'content-length':'20000001'})]
        for response in cases:
            with self.subTest(response=response), tempfile.TemporaryDirectory() as directory, \
                 patch.object(app,'telegram_call',return_value={'file_path':'voice/file.oga','file_size':12}), \
                 patch.object(app.requests,'get',return_value=response):
                with self.assertRaises(app.UserVisibleError):
                    app.download_recognition_input('secret',{'fileId':'valid'},Path(directory))
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(app,'telegram_call',return_value={'file_path':'voice/file.oga'}), \
             patch.object(app.requests,'get',return_value=self.response([b'x'*20,b'y'])), \
             patch.object(app,'RECOGNITION_FILE_LIMIT',20):
            with self.assertRaises(app.UserVisibleError):
                app.download_recognition_input('secret',{'fileId':'valid'},Path(directory))

    def test_telegram_exception_never_exposes_token_or_url(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(app,'telegram_call',side_effect=RuntimeError('https://api.telegram.org/botSENSITIVE/getFile')):
            with self.assertRaises(app.UserVisibleError) as error:
                app.download_recognition_input('SENSITIVE',{'fileId':'valid'},Path(directory))
            self.assertNotIn('SENSITIVE',str(error.exception))


class RecognitionServiceTests(unittest.TestCase):
    def recognize(self, answers, count=3):
        from shazamio import Shazam
        samples=[Path(f'/tmp/sample-{i}.wav') for i in range(count)]
        with patch.object(Shazam,'recognize',new=AsyncMock(side_effect=answers)) as recognize:
            result=asyncio.run(app.recognize_samples(samples))
            return result,recognize.await_count

    def test_no_match_tries_next_window_then_stops_on_match(self):
        match={'matches':[{'id':'1'}],'track':{'title':' Hello\n','subtitle':' Adele '}}
        result,count=self.recognize([{'matches':[]},match])
        self.assertEqual(result,{'title':'Hello','artist':'Adele'})
        self.assertEqual(count,2)

    def test_no_match_does_not_invent_a_title(self):
        with self.assertRaisesRegex(app.UserVisibleError,'شناسایی نشد'):
            self.recognize([{'matches':[]}]*3)
        with self.assertRaisesRegex(app.UserVisibleError,'شناسایی نشد'):
            self.recognize([{'matches':[],'track':{'title':'wrong','subtitle':'wrong'}}],count=1)

    def test_rate_limit_timeout_and_invalid_response_are_distinct_from_no_match(self):
        from shazamio.exceptions import RateLimited
        for answer,pattern in [(RateLimited('rate limited'),'محدود'),(asyncio.TimeoutError(),'پاسخ نداد'),({},'پاسخ نداد')]:
            with self.subTest(answer=answer),self.assertRaisesRegex(app.UserVisibleError,pattern):
                self.recognize([answer],count=1)

    def test_user_clip_and_samples_removed_even_when_recognition_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory)
            for name in ['recognition-input','recognition-pcm.wav','recognition-0.wav']:
                (workdir/name).write_bytes(b'test')
            with patch.object(app,'download_recognition_input',return_value=workdir/'recognition-input'), \
                 patch.object(app,'recognition_samples',return_value=[workdir/'recognition-0.wav']), \
                 patch.object(app,'recognize_samples',new=AsyncMock(side_effect=app.UserVisibleError('no match'))):
                with self.assertRaises(app.UserVisibleError):
                    app.recognize_telegram_music('secret',{'fileId':'valid'},workdir)
            self.assertEqual(list(workdir.iterdir()),[])

    def test_capture_keeps_identified_song_if_full_download_fails(self):
        payload={'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,'recognition':{'fileId':'valid'}},
                 'botToken':'fictional-token','chatId':42,'requestMessageId':7,'statusMessageId':10,
                 'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
                 'completionToken':'0'*64}
        job=app.InstagramCapture(payload)
        try:
            with patch.object(app,'recognize_telegram_music',return_value={'title':'Hello','artist':'Adele'}), \
                 patch.object(pipeline,'prepare_music',side_effect=app.UserVisibleError('❌ فایل کامل پیدا نشد')), \
                 patch.object(job,'safe_status'),patch.object(job,'notify') as notify:
                job.run()
            self.assertEqual(job.state,'failed')
            self.assertIn('Hello',job.result['message']); self.assertIn('Adele',job.result['message'])
            self.assertIn('فایل کامل',job.result['message']); notify.assert_called_once()
        finally: job.cleanup()

    def test_recognized_song_uses_existing_mp3_sender_once(self):
        payload={'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,'recognition':{'fileId':'valid'}},
                 'botToken':'fictional-token','chatId':42,'requestMessageId':7,'statusMessageId':10,
                 'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
                 'completionToken':'0'*64}
        job=app.InstagramCapture(payload)
        path=job.workdir/'Music.mp3';path.write_bytes(b'upload fixture')
        upload=AsyncMock(return_value={'message_id':123})
        try:
            with patch.object(app,'recognize_telegram_music',return_value={'title':'Hello','artist':'Adele'}), \
                 patch.object(pipeline,'prepare_music',return_value=(path,'Hello Official Audio','Adele','https://www.youtube.com/watch?v=abcdefghijk')) as prepare, \
                 patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            self.assertEqual(prepare.call_args.args[0],'Adele Hello')
            with patch.object(app,'upload_complete_file',new=upload),patch.object(job,'safe_status'),patch.object(app,'delete_status'):
                self.assertTrue(job.send()['ok']);self.assertTrue(job.send()['ok'])
            upload.assert_awaited_once()
            self.assertEqual(upload.call_args.args[1],'sendAudio')
            self.assertIn('🎵 Hello',upload.call_args.args[2]['caption'])
            self.assertIn('👤 Adele',upload.call_args.args[2]['caption'])
            self.assertEqual(upload.call_args.args[3][2],'audio/mpeg')
        finally: job.cleanup()

    def test_no_match_never_searches_youtube(self):
        payload={'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,'recognition':{'fileId':'valid'}},
                 'botToken':'fictional-token','chatId':42,'requestMessageId':7,'statusMessageId':10,
                 'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
                 'completionToken':'0'*64}
        job=app.InstagramCapture(payload)
        try:
            with patch.object(app,'recognize_telegram_music',side_effect=app.UserVisibleError('شناسایی نشد')), \
                 patch.object(pipeline,'prepare_music') as prepare,patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            self.assertEqual(job.state,'failed'); prepare.assert_not_called()
        finally: job.cleanup()


@unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
class RecognitionSampleTests(unittest.TestCase):
    def make_media(self,workdir,seconds=40,silent=False,video=False):
        target=workdir/('input.mp4' if video else 'input.ogg')
        command=['ffmpeg','-y','-hide_banner','-loglevel','error']
        if video: command+=['-f','lavfi','-i','color=size=32x32:rate=5']
        command+=['-f','lavfi','-i','anullsrc=r=44100:cl=stereo' if silent else 'sine=frequency=440:sample_rate=44100',
                  '-t',str(seconds)]
        command+=['-c:v','libx264','-c:a','aac'] if video else ['-c:a','libopus']
        subprocess.run(command+[str(target)],check=True)
        return target

    def test_long_audio_is_bounded_to_three_mono_twelve_second_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory)
            samples=app.recognition_samples(self.make_media(workdir),workdir)
            self.assertEqual(len(samples),3)
            for sample in samples:
                with wave.open(str(sample),'rb') as wav:
                    self.assertEqual((wav.getnchannels(),wav.getsampwidth(),wav.getframerate()),(1,2,16000))
                    self.assertLessEqual(wav.getnframes()/wav.getframerate(),12)

    def test_video_audio_is_extracted_without_video_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory)
            samples=app.recognition_samples(self.make_media(workdir,seconds=5,video=True),workdir)
            self.assertEqual(len(samples),1)
            with wave.open(str(samples[0]),'rb') as wav:
                self.assertGreater(wav.getnframes(),4*16000)

    def test_silence_and_too_short_clip_rejected_before_service_call(self):
        for seconds,silent in [(1,False),(12,True)]:
            with self.subTest(seconds=seconds),tempfile.TemporaryDirectory() as directory:
                workdir=Path(directory)
                with self.assertRaisesRegex(app.UserVisibleError,'صدای کافی'):
                    app.recognition_samples(self.make_media(workdir,seconds,silent),workdir)

    def test_real_rust_fingerprint_reaches_injected_http_transport(self):
        from shazamio import Shazam
        from shazamio.client import HTTPClient
        answer={'matches':[{'id':'1'}],'track':{'title':'Fixture song','subtitle':'Fixture artist'}}
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory)
            samples=app.recognition_samples(self.make_media(workdir,seconds=12),workdir)
            with patch.object(HTTPClient,'request',new=AsyncMock(return_value=answer)) as request:
                result=asyncio.run(app.recognize_samples(samples))
            self.assertEqual(result['title'],'Fixture song')
            request.assert_awaited_once()
            self.assertTrue(request.call_args.args[1].startswith('https://amp.shazam.com/'))
            signature=request.call_args.kwargs['json']['signature']
            self.assertTrue(signature['uri'].startswith('data:audio/vnd.shazam.sig;base64,'))
            self.assertGreater(len(signature['uri']),100)

    def test_video_without_audio_has_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory);source=workdir/'silent.mp4'
            subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',
                            'color=size=32x32:rate=5','-t','1',str(source)],check=True)
            with self.assertRaisesRegex(app.UserVisibleError,'صدادار'):
                app.recognition_samples(source,workdir)


class PlaylistAndCacheTests(unittest.TestCase):
    def payload(self, **source):
        return {'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,**source},
                'botToken':'fictional-token','chatId':42,'requestMessageId':7,'statusMessageId':10,
                'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42',
                'completionToken':'0'*64}

    def test_playlist_extraction_is_bounded_and_preserves_positions(self):
        data={'title':'Playlist','entries':[
            {'id':'aaaaaaaaaaa','playlist_index':21,'title':'First'},
            {'id':'bad-id!','playlist_index':22},
            {'id':'bbbbbbbbbbb','playlist_index':23,'is_live':True},
            {'id':'ccccccccccc','playlist_index':24,'title':'Fourth'},
        ]}
        with patch.object(pipeline,'_run',return_value=subprocess.CompletedProcess([],0,json.dumps(data))) as run:
            title,entries=pipeline.playlist_entries('https://www.youtube.com/playlist?list=PLabcdef',21,40)
        self.assertEqual([e['index'] for e in entries],[21,22,23,24])
        self.assertEqual([e['id'] for e in entries],['aaaaaaaaaaa',None,None,'ccccccccccc'])
        command=run.call_args.args[0]
        self.assertEqual(command[command.index('--playlist-items')+1],'21:40')
        self.assertNotIn('--no-playlist',command)
        self.assertEqual(command[-2],'--')
        self.assertEqual(title,'Playlist')
        with self.assertRaises(app.UserVisibleError):
            pipeline.playlist_entries('https://attacker.example/list',1,20)
        with self.assertRaises(app.UserVisibleError):
            pipeline.playlist_entries('https://www.youtube.com/playlist?list=PLabcdef',1,21)

    def test_cached_file_uses_current_chat_and_invalid_id_is_evicted(self):
        entry={'method':'sendAudio','fileId':'cached_id','data':{'caption':'Hello','title':'Hello'}}
        payload=self.payload()
        with patch.object(app,'file_cache',return_value=entry) as cache,patch.object(app,'telegram_call',return_value={'message_id':1}) as telegram:
            self.assertTrue(app.reuse_cached_file(payload,'yt:aaaaaaaaaaa:mp3'))
            data=telegram.call_args.kwargs['json_payload']
            self.assertEqual(data['chat_id'],42);self.assertEqual(data['audio'],'cached_id')
            self.assertEqual(data['reply_parameters'],{'message_id':7})
        with patch.object(app,'file_cache',return_value=entry) as cache,patch.object(app,'telegram_call',side_effect=RuntimeError('Bad Request: wrong file identifier')):
            self.assertFalse(app.reuse_cached_file(payload,'yt:aaaaaaaaaaa:mp3'))
            self.assertEqual(cache.call_args.args[1],'delete')
        with patch.object(app,'file_cache',return_value=entry) as cache,patch.object(app,'telegram_call',side_effect=RuntimeError('timeout after sending')):
            with self.assertRaisesRegex(app.UserVisibleError,'تکراری'):
                app.reuse_cached_file(payload,'yt:aaaaaaaaaaa:mp3')
            self.assertEqual(cache.call_count,1)

    def test_successful_upload_cache_has_no_chat_or_reply_context(self):
        payload=self.payload()
        with patch.object(app,'file_cache') as cache:
            app.store_uploaded_file(payload,['yt:aaaaaaaaaaa:mp3','yt:aaaaaaaaaaa:mp3'], 'sendAudio',
                                    {'chat_id':'42','reply_parameters':'private','caption':'Hello','title':'Hello'},
                                    {'message_id':10,'file_id':'valid_id'})
            cache.assert_called_once()
            record=cache.call_args.args[3]
            self.assertEqual(record['data'],{'caption':'Hello','title':'Hello'})
        with patch.object(app,'file_cache') as cache:
            app.store_uploaded_file(payload,['key'],'sendAudio',{}, {'ok':False})
            cache.assert_not_called()

    def test_cached_youtube_download_does_not_extract_or_download_again(self):
        payload={**self.payload(),'url':'https://www.youtube.com/watch?v=aaaaaaaaaaa','audioMode':'hq'}
        with patch.object(app,'reuse_cached_file',return_value=True),patch.object(app,'fetch_metadata') as metadata, \
             patch.object(app,'download_audio') as download,patch.object(app,'delete_status'):
            result=app.process_job(payload)
        self.assertTrue(result['cached']);metadata.assert_not_called();download.assert_not_called()

    def test_cache_transport_is_signed_and_does_not_accept_arbitrary_hosts(self):
        payload={**self.payload(),'cacheUrl':'https://downloader.vexaagent.workers.dev/media-cache/igdl-42-7-42','cacheToken':'signed-token'}
        with patch.object(app.requests,'post') as post:
            post.return_value.ok=True;post.return_value.json.return_value={'value':{'fileId':'cached'}}
            self.assertEqual(app.file_cache(payload,'get','yt:test:mp3')['fileId'],'cached')
            self.assertFalse(post.call_args.kwargs['allow_redirects'])
            self.assertEqual(post.call_args.kwargs['headers']['x-media-cache-token'],'signed-token')
        with patch.object(app.requests,'post') as post:
            app.file_cache({**payload,'cacheUrl':'https://attacker.example/'},'get','yt:test:mp3')
            post.assert_not_called()

    def test_playlist_sends_in_order_skips_unavailable_and_reuses_cached_track(self):
        playlist={'url':'https://www.youtube.com/playlist?list=PLabcdef','start':1,'end':20}
        entries=[{'id':'aaaaaaaaaaa','index':1,'title':'First'}, {'id':None,'index':2,'title':'Private'},
                 {'id':'bbbbbbbbbbb','index':3,'title':'Third'}]
        job=app.InstagramCapture(self.payload(playlist=playlist));calls=[]
        def reuse(payload,key,caption=None):
            calls.append(('cache',key))
            return key=='yt:aaaaaaaaaaa:mp3'
        def prepare(url,workdir):
            calls.append(('prepare',url));path=workdir/'Music.mp3';path.write_bytes(b'complete')
            return path,'Third','Artist',url
        async def upload(token,method,data,file):
            calls.append(('upload',data['caption']));return {'message_id':3,'file_id':'stored'}
        try:
            with patch.object(pipeline,'playlist_entries',return_value=('Playlist',entries)), \
                 patch.object(pipeline,'prepare_music_url',side_effect=prepare),patch.object(app,'reuse_cached_file',side_effect=reuse), \
                 patch.object(app,'upload_complete_file',side_effect=upload),patch.object(app,'store_uploaded_file') as store, \
                 patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            self.assertEqual(job.result['parts'],2)
            self.assertIn('دریافت نشد: 2',job.result['message'])
            self.assertEqual([c[0] for c in calls],['cache','cache','prepare','upload'])
            self.assertNotIn('Playlist',store.call_args.args[3]['caption'])
            with patch.object(app,'upload_complete_file') as upload:
                self.assertEqual(job.send()['parts'],2);job.send();upload.assert_not_called()
            self.assertEqual(list(job.workdir.glob('track-*')),[])
        finally: job.cleanup()

    def test_uncertain_playlist_send_stops_without_retrying_next_track(self):
        playlist={'url':'https://www.youtube.com/playlist?list=PLabcdef','start':1,'end':20}
        entries=[{'id':'aaaaaaaaaaa','index':1,'title':'First'},{'id':'bbbbbbbbbbb','index':2,'title':'Second'}]
        job=app.InstagramCapture(self.payload(playlist=playlist))
        def prepare(url,workdir):
            path=workdir/'Music.mp3';path.write_bytes(b'data');return path,'First','Artist',url
        try:
            with patch.object(pipeline,'playlist_entries',return_value=('Playlist',entries)), \
                 patch.object(pipeline,'prepare_music_url',side_effect=prepare) as prepare_mock,patch.object(app,'reuse_cached_file',return_value=False), \
                 patch.object(app,'upload_complete_file',new=AsyncMock(side_effect=asyncio.TimeoutError())) as upload, \
                 patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            upload.assert_awaited_once();prepare_mock.assert_called_once()
            self.assertFalse(job.result['ok']);self.assertIn('تأیید نشد',job.result['message'])
        finally: job.cleanup()

    def test_playlist_stop_reports_resume_without_sending_pending_tracks(self):
        playlist={'url':'https://www.youtube.com/playlist?list=PLabcdef','start':21,'end':40}
        entries=[{'id':'aaaaaaaaaaa','index':21,'title':'First'},{'id':'bbbbbbbbbbb','index':22,'title':'Second'}]
        job=app.InstagramCapture(self.payload(playlist=playlist))
        def reuse(payload,key,caption=None):
            self.assertTrue(job.stop())
            return True
        try:
            with patch.object(pipeline,'playlist_entries',return_value=('Playlist',entries)), \
                 patch.object(app,'reuse_cached_file',side_effect=reuse) as cached, \
                 patch.object(pipeline,'prepare_music_url') as prepare,patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            cached.assert_called_once();prepare.assert_not_called()
            self.assertEqual(job.result['parts'],1)
            self.assertIn('22-41',job.result['message'])
        finally: job.cleanup()

    def test_instagram_capture_identifies_before_searching_and_sends_mp3(self):
        job=app.InstagramCapture(self.payload(recognizeMusic=True,url='https://scontent.cdninstagram.com/video.mp4'))
        def prepare(query,workdir):
            self.assertEqual(query,'Adele Hello')
            path=workdir/'Music.mp3';path.write_bytes(b'complete')
            return path,'Hello','Adele','https://www.youtube.com/watch?v=abcdefghijk'
        try:
            with patch.object(app,'recognize_instagram_music',return_value={'title':'Hello','artist':'Adele'}) as identify, \
                 patch.object(app,'reuse_cached_file',return_value=False),patch.object(pipeline,'prepare_music',side_effect=prepare), \
                 patch.object(job,'safe_status'),patch.object(job,'notify'):
                job.run()
            identify.assert_called_once()
            self.assertEqual(job.state,'ready');self.assertEqual(job.path.suffix,'.mp3')
            with patch.object(app,'upload_complete_file',new=AsyncMock(return_value={'file_id':'stored'})) as upload, \
                 patch.object(job,'safe_status'),patch.object(app,'delete_status'),patch.object(app,'store_uploaded_file'):
                job.send()
            self.assertEqual(upload.call_args.args[1],'sendAudio')
            self.assertIn('Adele',upload.call_args.args[2]['caption'])
        finally: job.cleanup()

    def test_instagram_song_resolution_uses_short_remote_sample_and_cleans_it(self):
        with tempfile.TemporaryDirectory() as directory:
            workdir=Path(directory);sample=workdir/'recognition-0.wav';sample.write_bytes(b'fixture')
            with patch.object(app,'recognition_samples',return_value=[sample]) as samples, \
                 patch.object(app,'recognize_samples',new=AsyncMock(return_value={'title':'Hello','artist':'Adele'})):
                result=app.recognize_instagram_music('https://scontent.cdninstagram.com/video.mp4',workdir)
            self.assertEqual(result['title'],'Hello');self.assertTrue(samples.call_args.kwargs['remote'])
            self.assertFalse(sample.exists())
            with patch.object(app,'recognition_samples') as samples:
                with self.assertRaises(app.UserVisibleError):
                    app.recognize_instagram_music('https://attacker.example/video.mp4',workdir)
                samples.assert_not_called()


if __name__=='__main__':
    unittest.main()
