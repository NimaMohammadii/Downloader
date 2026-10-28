import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import bandcamp as bc
import youtube_app as app

URL = 'https://artist.bandcamp.com/track/song'
ALBUM = 'https://artist.bandcamp.com/album/album'

class BandcampTests(unittest.TestCase):
    def job(self):
        job=app.InstagramCapture({'id':'igdl-42-7-42','source':{'mode':'replay','audioOnly':True,'bandcamp':{'url':URL}},
            'botToken':'fictional','chatId':42,'requestMessageId':7,'statusMessageId':10,
            'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42','completionToken':'0'*64})
        self.addCleanup(job.cleanup)
        return job

    def test_url_validation_blocks_credentials_profiles_and_host_confusion(self):
        self.assertEqual(bc.canonical_url(URL+'/?foo=bar'),URL)
        for url in ['https://bandcamp.com','https://artist.bandcamp.com.evil.test/track/a','https://127.0.0.1/track/a','https://artist.bandcamp.com/music','https://u:p@artist.bandcamp.com/track/a','https://daily.bandcamp.com/track/a']:
            with self.subTest(url=url),self.assertRaises(app.UserVisibleError):bc.canonical_url(url)
        for url in ['https://127.0.0.1/a','https://evil.test/a','https://t4.bcbits.com.evil.test/a']:
            with self.assertRaises(app.UserVisibleError):bc.media_url(url)

    def test_extractor_is_bounded_and_does_not_use_other_platform_clients(self):
        with patch.object(bc.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'{"entries":[]}')) as run:
            bc.metadata(ALBUM,album=True)
        args=run.call_args.args[0]
        self.assertEqual(args[-2:],['--',ALBUM]);self.assertIn('--flat-playlist',args)
        self.assertEqual(args[args.index('--playlist-end')+1],'21')
        self.assertNotIn('--cookies',args);self.assertNotIn('--extractor-args',args)

    def test_no_public_audio_never_downloads(self):
        with patch.object(bc,'metadata',return_value={'formats':[]}),patch.object(bc,'download') as download:
            with self.assertRaises(app.UserVisibleError):bc.prepare_track(URL,Path('/tmp'),100,time.monotonic()+1)
            download.assert_not_called()

    def test_album_limit_never_silently_truncates(self):
        job=self.job();job.source['bandcamp']['url']=ALBUM
        with patch.object(bc,'metadata',return_value={'entries':[{'url':URL}]*21}),patch.object(bc,'prepare_track') as prepare:
            with self.assertRaises(app.UserVisibleError):bc.prepare(job)
            prepare.assert_not_called()

    def test_album_order_partial_failure_and_existing_sender_idempotence(self):
        job=self.job();job.source['bandcamp']['url']=ALBUM
        def prepare(url,directory,limit,deadline):
            if url.endswith('/two'):raise app.UserVisibleError('unavailable')
            directory.mkdir();path=directory/'Bandcamp.mp3';path.write_bytes(b'complete')
            return {'path':path,'title':url.rsplit('/',1)[1],'artist':'Artist','url':url,'size':8}
        entries=[{'url':URL},{'url':'https://artist.bandcamp.com/track/two'},{'url':'https://artist.bandcamp.com/track/three'}]
        with patch.object(bc,'metadata',return_value={'title':'Album','entries':entries}),patch.object(bc,'prepare_track',side_effect=prepare),patch.object(job,'safe_status'),patch.object(job,'notify'):
            job.run()
        self.assertEqual([x['index'] for x in job.bandcamp_items],[1,3])
        with patch.object(app,'upload_complete_file',new=AsyncMock(return_value={'file_id':'stored'})) as upload,patch.object(job,'safe_status'):
            result=job.send();self.assertEqual(job.send(),result)
        self.assertEqual(upload.await_count,2);self.assertTrue(result['partial']);self.assertEqual(result['parts'],2)
        self.assertEqual(upload.call_args.args[1],'sendAudio')

    def test_ambiguous_send_stops_without_replaying_or_next_track(self):
        job=self.job();path=job.workdir/'Bandcamp.mp3';path.write_bytes(b'complete')
        job.bandcamp_items=[{'path':path,'title':'Song','artist':'Artist','index':i,'url':URL} for i in [1,2]]
        job.bandcamp_sent=0;job.bandcamp_title='Album';job.bandcamp_failed=[];job.state='ready'
        with patch.object(app,'upload_complete_file',new=AsyncMock(side_effect=asyncio.TimeoutError())) as upload:
            result=job.send();job.send()
        self.assertFalse(result['ok']);self.assertEqual(upload.await_count,1);self.assertEqual(result['parts'],0)

    def test_stream_checks_length_and_redirect_destination(self):
        response=MagicMock();response.__enter__.return_value=response;response.status_code=302
        response.headers={'location':'http://127.0.0.1/private'}
        with tempfile.TemporaryDirectory() as d,patch.object(app.requests,'get',return_value=response) as get:
            with self.assertRaises(app.UserVisibleError):bc.download('https://t4.bcbits.com/a',Path(d)/'a',100,time.monotonic()+10)
            self.assertEqual(get.call_count,1)
        response.status_code=200;response.headers={'content-length':'8'};response.iter_content.return_value=[b'abc']
        with tempfile.TemporaryDirectory() as d,patch.object(app.requests,'get',return_value=response):
            with self.assertRaises(app.UserVisibleError):bc.download('https://t4.bcbits.com/a',Path(d)/'a',100,time.monotonic()+10)

    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
    def test_duration_shortfall_rejects_truncated_audio(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d);fixture=directory/'fixture.mp3'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=2','-y',str(fixture)],check=True)
            data={'duration':40,'formats':[{'url':'https://t4.bcbits.com/a','vcodec':'none','ext':'mp3'}]}
            with patch.object(bc,'metadata',return_value=data),patch.object(bc,'download',side_effect=lambda url,path,*args:shutil.copyfile(fixture,path)):
                with self.assertRaises(app.UserVisibleError):bc.prepare_track(URL,directory/'track',1000000,time.monotonic()+20)
            self.assertFalse((directory/'track'/'Bandcamp.mp3').exists())

    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
    def test_real_mp3_preserves_duration_and_tags_without_reencoding(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d);fixture=directory/'fixture.mp3'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','sine=duration=2','-y',str(fixture)],check=True)
            data={'track':'Song','artist':'Artist','album':'Album','duration':2,'formats':[{'url':'https://t4.bcbits.com/a','vcodec':'none','ext':'mp3','abr':128}]}
            with patch.object(bc,'metadata',return_value=data),patch.object(bc,'download',side_effect=lambda url,path,*args:shutil.copyfile(fixture,path)):
                item=bc.prepare_track(URL,directory/'track',1000000,time.monotonic()+20)
            probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-of','json',str(item['path'])]))
            self.assertGreater(float(probe['format']['duration']),1.9)
            self.assertEqual(probe['format']['tags']['artist'],'Artist');self.assertEqual(probe['format']['tags']['album'],'Album')
            self.assertFalse((directory/'track'/'input').exists())
