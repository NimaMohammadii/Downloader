import asyncio
import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import shutil
import threading
import unittest
from unittest.mock import patch, AsyncMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'container'))
import youtube_app as app
import ai_subtitles as subs
import youtube_pipeline as pipeline

def payload(platform='instagram'):
    p={'id':'igdl-42-7-42','userId':42,'chatId':42,'requestMessageId':7,'statusMessageId':10,
       'botToken':'fixture-token','subtitle':'fa','subtitleSource':platform,'subtitleIdentity':'https://example.test/video',
       'subtitleBillingKey':'ig:42:7:42','elevenApiKey':'fake-eleven','gptApiKey':'fake-gpt',
       'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42','completionToken':'0'*64,
       'source':{'mode':'replay',**({'social':{'platform':'pinterest','url':'https://pinterest.com/pin/123/'}} if platform=='pinterest' else {})}}
    m=f"media-subtitle-fa-v1|{p['id']}|42|{platform}|{p['subtitleIdentity']}|{p['subtitleBillingKey']}"
    p['subtitleAuthorization']=hmac.new(p['botToken'].encode(),m.encode(),hashlib.sha256).hexdigest()
    return p

class MediaSubtitles(unittest.TestCase):
    def test_source_language_identity_user_and_billing_are_bound_to_authorization(self):
        for platform in ['instagram','pinterest']:
            p=payload(platform);subs.authorize_media(p)
            for field,value in [('subtitle','de'),('subtitleSource','tiktok'),('subtitleIdentity','other'),('userId',43),('subtitleBillingKey','another')]:
                with self.subTest(platform=platform,field=field),self.assertRaises(app.UserVisibleError):
                    subs.authorize_media({**p,field:value})
            with self.assertRaises(app.UserVisibleError):subs.authorize_media({**p,'source':{'mode':'live'}})
            with self.assertRaises(app.UserVisibleError):subs.authorize_media({**p,'source':{'mode':'replay','audioOnly':True}})

    def test_all_platforms_call_the_same_engine_with_isolated_item_identity_and_cost_owner(self):
        p=payload();before=app.JOB_DEADLINE.get()
        with patch.object(subs,'_prepare',return_value=Path('/tmp/result.mp4')) as prepare:
            for index in ['p:abc:0','p:abc:1']:
                self.assertEqual(subs.prepare_media(Path('input.mp4'),p,lambda *a,**k:None,index),Path('/tmp/result.mp4'))
            identities=[c.args[3] for c in prepare.call_args_list]
            self.assertNotEqual(*identities)
            self.assertTrue(all(c.args[4]=='ig:42:7:42' for c in prepare.call_args_list))
        self.assertEqual(app.JOB_DEADLINE.get(),before)

    def test_formatted_progress_is_preserved_in_instagram_capture_status(self):
        p=payload();job=app.InstagramCapture(p)
        try:
            with patch.object(app,'telegram_call') as call:
                job.safe_status('⏳ ~2 min • 50%',entities=[{'type':'bold','offset':3,'length':5}])
            self.assertEqual(call.call_args.kwargs['json_payload']['entities'][0]['type'],'bold')
        finally:job.cleanup()

    def test_carousel_only_renders_video_and_caches_subtitle_separately(self):
        p=payload();p['source']['instagramPost']={'shortcode':'abc','media':[{'kind':'photo','url':'https://scontent.cdninstagram.com/a.jpg'},
          {'kind':'video','url':'https://scontent.cdninstagram.com/b.mp4'}]}
        job=app.InstagramCapture(p);job.post_sent=0;job.state='ready'
        def download(item,path,deadline):path.write_bytes(b'input')
        def render(path,*a):out=path.parent/'captioned.mp4';out.write_bytes(b'captioned');return out
        def probe(*a,**k):
            class Result:stdout=json.dumps({'streams':[{'codec_type':'video','width':640,'height':360}],'format':{'duration':'10'}})
            return Result()
        try:
            with patch.object(job,'download_post_item',side_effect=download),patch.object(job,'safe_status'),\
                 patch.object(app,'reuse_cached_file',return_value=False),patch.object(app,'store_uploaded_file') as cache,\
                 patch.object(app,'upload_complete_file',new=AsyncMock(return_value={})),patch.object(app,'delete_status'),\
                 patch.object(app.subprocess,'run',side_effect=probe),patch.object(subs,'prepare_media',side_effect=render) as prep:
                result=job.send_instagram_post()
            self.assertTrue(result['ok']);self.assertEqual(result['parts'],2);prep.assert_called_once()
            self.assertEqual(prep.call_args.args[3],'p:abc:1')
            self.assertEqual(cache.call_args.args[1],['ig:42:abc:1:video:sub-fa-v1'])
        finally:job.cleanup()

    def test_pinterest_selection_updates_existing_job_and_never_reuses_plain_cache(self):
        selected=payload('pinterest')
        initial={k:v for k,v in selected.items() if not k.startswith('subtitle') and k not in ('elevenApiKey','gptApiKey')}
        job=app.InstagramCapture(initial);job.state='ready'
        job.social_items=[{'method':'sendPhoto','cacheKey':'photo'}, {'method':'sendVideo','cacheKey':'original','cached':{'fileId':'plain'}}]
        try:
            with patch.dict(app.INSTAGRAM_JOBS,{job.id:job}),patch.object(app,'file_cache',return_value=None) as cache:
                self.assertTrue(app.instagram_action('start',selected)['ok'])
                self.assertTrue(app.instagram_action('start',selected)['ok'])
                self.assertEqual(job.social_items[0]['cacheKey'],'photo')
                self.assertEqual(job.social_items[1]['cacheKey'],'original:sub-fa-v1')
                self.assertIsNone(job.social_items[1]['cached'])
                cache.assert_called_once()
        finally:job.cleanup()

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg unavailable')
    def test_real_shared_renderer_preserves_video_audio_and_emits_formatted_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);video=root/'input.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=black:s=320x180:d=1',
                '-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',str(video)],check=True)
            status=[]
            transcript={'language_code':'fa','words':[{'type':'word','text':'سلام','start':0,'end':0.8}]}
            with patch.object(subs,'CACHE_ROOT',root/'cache'),patch.object(subs,'_paid_post',return_value=transcript) as paid:
                output=subs.prepare_media(video,payload(),lambda text,**kwargs:status.append((text,kwargs)),'0')
            self.assertNotEqual(output,video);self.assertTrue(output.is_file());self.assertTrue(video.is_file())
            self.assertAlmostEqual(app.probe_duration(output),1,delta=0.2)
            self.assertEqual(paid.call_args.kwargs['billing']['downloadKey'],'ig:42:7:42')
            self.assertTrue(any(v.get('entities') for _,v in status))

    def test_pinterest_upload_receives_captioned_video_and_keeps_audio_metadata(self):
        p=payload('pinterest');job=app.InstagramCapture(p);job.state='ready';job.social_sent=0
        job.social_url=p['source']['social']['url'];original=job.workdir/'video.mp4';original.write_bytes(b'original')
        rendered=job.workdir/'captioned.mp4';rendered.write_bytes(b'captioned')
        job.social_items=[{'method':'sendVideo','data':{'width':640,'height':360,'duration':1},'path':original,'fileSize':8,
          'cacheKey':'video:sub-fa-v1','cached':None,'index':0,'caption':'Pinterest','hasAudio':True}]
        try:
            with patch.object(job,'safe_status'),patch.object(app,'delete_status'),patch.object(subs,'prepare_media',return_value=rendered) as prepare,                 patch.object(app,'store_uploaded_file') as cache,patch.object(app,'upload_complete_file',new=AsyncMock(return_value={})) as upload:
                result=job.send_social()
            self.assertTrue(result['ok']);prepare.assert_called_once();self.assertEqual(upload.call_args.args[3][0],'captioned.mp4')
            self.assertEqual(cache.call_args.args[1],['video:sub-fa-v1']);self.assertTrue(cache.call_args.kwargs['has_audio'])
        finally:job.cleanup()

    def test_invalid_authorization_never_starts_capture_or_paid_work(self):
        p=payload();p['subtitleAuthorization']='invalid'
        with patch.object(subs,'_paid_post') as paid,self.assertRaises(app.UserVisibleError):app.InstagramCapture(p)
        paid.assert_not_called()

if __name__=='__main__':unittest.main()
