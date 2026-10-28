import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import reddit as rd
import youtube_app as app

URL = 'https://www.reddit.com/comments/abc123'
VIDEO = {'fallback_url':'https://v.redd.it/native/DASH_720.mp4', 'dash_url':'https://v.redd.it/native/DASHPlaylist.mpd', 'duration':3}


class RedditTests(unittest.TestCase):
    def job(self):
        job=app.InstagramCapture({'id':'igdl-42-7-42','source':{'mode':'replay','reddit':{'url':URL}},
            'botToken':'fictional','chatId':42,'requestMessageId':7,'statusMessageId':10,
            'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42','completionToken':'0'*64})
        self.addCleanup(job.cleanup)
        return job

    def test_inputs_do_not_allow_external_hosts_credentials_ports_or_profiles(self):
        for value in [URL, 'https://old.reddit.com/r/videos/comments/abc123/title', 'https://redd.it/abc123', 'https://www.reddit.com/gallery/abc123']:
            self.assertEqual(rd.canonical_url(value),URL)
        for value in ['https://reddit.com/r/videos','https://reddit.com/user/example','https://reddit.com.evil.test/comments/a','https://u:p@reddit.com/comments/a','https://reddit.com:99/comments/a','https://127.0.0.1/comments/a']:
            with self.subTest(value=value),self.assertRaises(app.UserVisibleError):rd.canonical_url(value)

    def test_native_video_requires_audio_unless_explicitly_silent_and_handles_crossposts(self):
        for data in [{'secure_media':{'reddit_video':VIDEO}}, {'crosspost_parent_list':[{'media':{'reddit_video':VIDEO}}]}]:
            self.assertTrue(rd.media_items(data)[0]['audio'])
        for flag in [{'is_gif':True},{'has_audio':False}]:
            self.assertFalse(rd.media_items({'media':{'reddit_video':{**VIDEO,**flag}}})[0]['audio'])
        with self.assertRaises(app.UserVisibleError):rd.media_items({'media':{'reddit_video':{**VIDEO,'dash_url':'http://127.0.0.1/private'}}})

    def test_external_post_never_delegates_to_youtube_or_generic_downloaders(self):
        with patch.object(rd,'video_file') as video:
            with self.assertRaises(app.UserVisibleError):rd.media_items({'url':'https://youtube.com/watch?v=abcdefghijk'})
            video.assert_not_called()

    def gallery(self, ids=('second','first')):
        return {'gallery_data':{'items':[{'media_id':i} for i in ids]},'media_metadata':{
            i:{'status':'valid','e':'Image','s':{'u':f'https://preview.redd.it/{i}.jpg?x=1&amp;y=2'}} for i in ids}}

    def test_gallery_preserves_order_and_decodes_escaped_native_urls(self):
        items=rd.media_items(self.gallery())
        self.assertEqual([x['url'] for x in items],['https://preview.redd.it/second.jpg?x=1&y=2','https://preview.redd.it/first.jpg?x=1&y=2'])

    def test_gallery_over_limit_or_missing_item_is_never_silently_truncated(self):
        for data in [self.gallery(tuple(str(i) for i in range(21))), self.gallery(())]:
            with self.assertRaises(app.UserVisibleError):rd.media_items(data)
        data=self.gallery();del data['media_metadata']['first']
        with self.assertRaises(app.UserVisibleError):rd.media_items(data)

    def response(self, status=200, body=b'abc', headers=None):
        response=MagicMock();response.status_code=status;response.headers=headers or {};response.iter_content.return_value=[body]
        response.__enter__.return_value=response
        return response

    def test_share_redirect_cannot_leave_reddit_and_api_size_is_bounded(self):
        session=MagicMock();response=self.response(302,headers={'location':'http://127.0.0.1/private'});session.get.return_value=response
        with self.assertRaises(app.UserVisibleError):rd.page(session,'https://www.reddit.com/r/videos/s/AbCd')
        self.assertEqual(session.get.call_count,1);response.close.assert_called_once()
        session.get.return_value=self.response(body=b'a'*4_000_001)
        with self.assertRaises(app.UserVisibleError):rd.page(session,URL)

    def test_post_session_uses_only_reddit_cookie_domains_and_returns_public_metadata(self):
        post={'id':'abc123','title':'Title','url':'https://i.redd.it/abc123.png'}
        raw=json.dumps([{'data':{'children':[{'data':post}]}}]).encode()
        session=MagicMock();session.__enter__.return_value=session
        with patch.object(rd.browser_requests,'Session',return_value=session),patch.object(rd,'page',side_effect=[(b'', 'https://old.reddit.com/'),(raw,URL)]):
            self.assertEqual(rd.post_data(URL,json.dumps([{'domain':'.reddit.com','name':'reddit_session','value':'private-session'}]))[0],post)
            session.cookies.set.assert_called_once_with('reddit_session','private-session',domain='.reddit.com',path='/')
        with patch.object(rd.browser_requests,'Session',return_value=session),patch.object(rd,'page') as page:
            with self.assertRaises(app.UserVisibleError):rd.post_data(URL,json.dumps([{'domain':'.evil.test','name':'reddit_session','value':'private-session'}]))
            page.assert_not_called()

    def test_api_denial_is_friendly_and_does_not_leak_body_or_cookie(self):
        session=MagicMock();session.__enter__.return_value=session
        with patch.object(rd.browser_requests,'Session',return_value=session),patch.object(rd,'page',side_effect=RuntimeError('private signed URL cookie')):
            with self.assertRaises(app.UserVisibleError) as error:rd.post_data(URL)
        self.assertEqual(str(error.exception),rd.ACCESS_ERROR)

    def test_image_redirects_and_content_length_are_checked(self):
        response=self.response(302,headers={'location':'http://127.0.0.1/private'})
        with tempfile.TemporaryDirectory() as d,patch.object(app.requests,'get',return_value=response) as get:
            with self.assertRaises(app.UserVisibleError):rd.image_file({'url':'https://i.redd.it/a.jpg'},Path(d)/'a',100,time.monotonic()+10)
            self.assertEqual(get.call_count,1)
        for body,headers in [(b'abc',{'content-length':'8'}),(b'abcde',{}),(b'',{})]:
            with tempfile.TemporaryDirectory() as d,patch.object(app.requests,'get',return_value=self.response(body=body,headers=headers)):
                with self.assertRaises(app.UserVisibleError):rd.image_file({'url':'https://i.redd.it/a.jpg'},Path(d)/'a',4,time.monotonic()+10)

    def test_failed_gallery_preparation_never_reaches_ready_or_upload(self):
        job=self.job()
        with patch.object(rd,'post_data',return_value=(self.gallery(),URL)),patch.object(rd,'image_file',side_effect=app.UserVisibleError('not available')),patch.object(job,'safe_status'),patch.object(job,'notify'),patch.object(app,'upload_complete_file',new=AsyncMock()) as upload:
            job.run()
        self.assertEqual(job.state,'failed');self.assertFalse(job.result['ok']);upload.assert_not_called()

    def ready(self):
        job=self.job();job.reddit_sent=0;job.reddit_title='Title';job.reddit_url=URL;job.state='ready';job.reddit_items=[]
        for i in [1,2]:
            path=job.workdir/f'item{i}.png';path.write_bytes(b'complete')
            job.reddit_items.append({'path':path,'kind':'image','index':i})
        return job

    def test_sender_preserves_original_images_and_repeated_send_is_idempotent(self):
        job=self.ready()
        with patch.object(app,'upload_complete_file',new=AsyncMock(return_value={'file_id':'confirmed'})) as upload,patch.object(app,'delete_status'):
            result=job.send();self.assertEqual(job.send(),result)
        self.assertEqual(result['parts'],2);self.assertEqual(upload.await_count,2);self.assertEqual(upload.call_args.args[1],'sendDocument')
        self.assertFalse(any(job.workdir.glob('*.png')))

    def test_ambiguous_upload_stops_without_retry_and_retains_confirmed_count(self):
        job=self.ready()
        with patch.object(app,'upload_complete_file',new=AsyncMock(side_effect=[{'file_id':'confirmed'},asyncio.TimeoutError()])) as upload:
            result=job.send();job.send()
        self.assertFalse(result['ok']);self.assertEqual(result['parts'],1);self.assertEqual(upload.await_count,2);self.assertEqual(job.state,'failed')

    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
    def test_real_probe_rejects_missing_audio_or_truncated_video(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'silent.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=160x120:d=2','-c:v','libx264','-y',str(path)],check=True)
            for item in [{'kind':'video','audio':True,'duration':2},{'kind':'video','audio':False,'duration':40}]:
                with self.assertRaises(app.UserVisibleError):rd.probe_file(path,item)
            self.assertEqual(rd.probe_file(path,{'kind':'video','audio':False,'duration':2})['width'],160)

    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
    def test_real_probe_accepts_muxed_audio_and_video(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'complete.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=160x120:d=3','-f','lavfi','-i','sine=duration=3','-c:v','libx264','-c:a','aac','-shortest','-y',str(path)],check=True)
            probe=rd.probe_file(path,{'kind':'video','audio':True,'duration':3})
            self.assertEqual((probe['duration'],probe['width'],probe['height']),(3,160,120))

    def test_downloader_is_reddit_manifest_only_and_requires_audio_formats(self):
        job=self.job();directory=job.workdir/'video';directory.mkdir();process=MagicMock();process.poll.return_value=0;process.returncode=0
        with patch.object(rd.subprocess,'Popen',return_value=process) as popen:
            rd.video_file(job,{'url':VIDEO['dash_url'],'audio':True},directory,time.monotonic()+10)
        args=popen.call_args.args[0]
        self.assertEqual(args[args.index('--use-extractors')+1],'Generic');self.assertIn('[acodec!=none]',args[args.index('--format')+1])
        self.assertIn('--abort-on-unavailable-fragments',args);self.assertEqual(args[-2:],['--',VIDEO['dash_url']]);self.assertNotIn('--cookies',args)
        self.assertIsNone(job.process)

    def test_download_deadline_kills_and_reaps_only_the_job_process(self):
        job=self.job();directory=job.workdir/'video';directory.mkdir();process=MagicMock();process.poll.return_value=None
        with patch.object(rd.subprocess,'Popen',return_value=process):
            with self.assertRaises(app.UserVisibleError):rd.video_file(job,{'url':VIDEO['dash_url'],'audio':True},directory,time.monotonic()-1)
        process.kill.assert_called_once();process.wait.assert_called_once();self.assertIsNone(job.process)

    @unittest.skipUnless(shutil.which('ffmpeg'),'FFmpeg required')
    def test_gallery_prepares_all_original_images_in_order_before_marking_ready(self):
        job=self.job();fixture=job.workdir/'fixture.png'
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=s=64x48','-frames:v','1','-y',str(fixture)],check=True)
        prepared=[]
        def download(item,path,limit,deadline):
            self.assertEqual(job.state,'starting')
            prepared.append(item['url']);shutil.copyfile(fixture,path)
        with patch.object(rd,'post_data',return_value=(self.gallery(),URL)),patch.object(rd,'image_file',side_effect=download),patch.object(job,'safe_status'),patch.object(job,'notify'):
            job.run()
        self.assertEqual(job.state,'ready');self.assertEqual(len(job.reddit_items),2)
        self.assertEqual([x['index'] for x in job.reddit_items],[1,2])
        self.assertEqual([x['width'] for x in job.reddit_items],[64,64]);self.assertIn('/second.jpg',prepared[0])
