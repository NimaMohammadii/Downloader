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


if __name__=='__main__':
    unittest.main()
