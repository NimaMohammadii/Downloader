import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

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


if __name__=='__main__':
    unittest.main()
