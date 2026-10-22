import asyncio
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as p


def response(url='', status=200, location=None, content=b'complete media'):
    r=MagicMock()
    r.__enter__.return_value=r
    r.status_code=status
    r.is_redirect=bool(location)
    r.ok=status<400
    r.headers={'Content-Length':str(len(content))}
    if location:r.headers['Location']=location
    r.iter_content.return_value=[content]
    return r


def metadata(platform='x',duration=1):
    return {'id':'123','title':'Fixture','duration':duration,
            'extractor_key':{'x':'Twitter','tiktok':'TikTok','soundcloud':'Soundcloud'}[platform],
            'formats':[{'format_id':'mp4' if platform!='soundcloud' else 'http_mp3',
                        'url':{'x':'https://video.twimg.com/a.mp4','tiktok':'https://v.tiktokcdn.com/a.mp4','soundcloud':'https://cf-media.sndcdn.com/a.mp3'}[platform],
                        'vcodec':'none' if platform=='soundcloud' else 'h264','acodec':'aac','ext':'mp4'}]}


def payload(platform='x'):
    return {'id':'igdl-42-7-42','source':{'mode':'replay','social':{'platform':platform,'url':'https://x.com/i/status/123'}},
            'botToken':'fake','chatId':42,'requestMessageId':7,'statusMessageId':10,
            'completionUrl':'https://downloader.vexaagent.workers.dev/instagram/events/igdl-42-7-42','completionToken':'0'*64}


class SocialBoundaryTests(unittest.TestCase):
    def test_canonical_individual_urls_and_large_ids(self):
        cases=[('x','https://mobile.twitter.com/name/status/1234567890123456789/video/2?s=20','https://x.com/i/status/1234567890123456789/video/2'),
               ('pinterest','https://de.pinterest.com/pin/title--123456789/','https://www.pinterest.com/pin/123456789/'),
               ('pinterest','https://www.pinterest.com/pin/266556871689003952/sent/?invite_code=example&sender=42','https://www.pinterest.com/pin/266556871689003952/'),
               ('tiktok','https://m.tiktok.com/@creator/photo/123?tracking=1','https://www.tiktok.com/@creator/photo/123'),
               ('soundcloud','https://m.soundcloud.com/artist/track?tracking=1','https://soundcloud.com/artist/track')]
        for platform,url,expected in cases:self.assertEqual(p.social_url(url,platform),expected)

    def test_bad_hosts_local_credentials_profiles_and_playlists_rejected(self):
        cases=[('x','https://x.com.evil/name/status/123'),('x','https://user:pass@x.com/name/status/123'),
               ('x','https://x.com:443/name/status/123'),('x','file:///tmp/private'),('x','https://x.com/name'),
               ('pinterest','https://pinterest.com/name/board/'),('tiktok','https://www.tiktok.com/@name/live'),
               ('soundcloud','https://soundcloud.com/artist/sets/playlist'),('soundcloud','https://soundcloud.com/artist/likes'),
               ('soundcloud','https://soundcloud.com/search/sounds')]
        for platform,url in cases:
            with self.subTest(url=url),self.assertRaises((app.UserVisibleError,ValueError)):p.social_url(url,platform)

    def test_short_url_hops_are_revalidated_before_network_and_tracking_removed(self):
        with patch.object(p.requests,'get',side_effect=[response(location='https://www.tiktok.com/@name/video/123?token=secret'),response()]) as get:
            self.assertEqual(p.resolve_social_url('https://vm.tiktok.com/ABC123','tiktok'),'https://www.tiktok.com/@name/video/123')
            self.assertEqual(get.call_count,2)
            self.assertTrue(all(c.kwargs['allow_redirects'] is False for c in get.call_args_list))
        with patch.object(p.requests,'head',return_value=response(location='https://127.0.0.1/private')) as get:
            with self.assertRaises(app.UserVisibleError):p.resolve_social_url('https://pin.it/ABC123','pinterest')
            self.assertEqual(get.call_count,1)

    def test_pinterest_shortener_uses_official_head_endpoint_and_canonicalizes_sent_pin(self):
        destination='https://de.pinterest.com/pin/266556871689003952/sent/?invite_code=example&sender=42'
        with patch.object(p.requests,'head',return_value=response(location=destination)) as head, \
                patch.object(p.requests,'get',side_effect=AssertionError('no share-page GET')):
            self.assertEqual(p.resolve_social_url('https://pin.it/Example123?tracking=1','pinterest'),
                             'https://www.pinterest.com/pin/266556871689003952/')
            self.assertEqual(head.call_count,1)
            self.assertEqual(head.call_args.args[0],'https://api.pinterest.com/url_shortener/Example123/redirect/')
            self.assertFalse(head.call_args.kwargs['allow_redirects'])

    def test_pinterest_allows_only_exact_official_intermediate_redirect_paths(self):
        endpoint='https://api.pinterest.com/url_shortener/Example456/redirect/'
        destination='https://www.pinterest.com/pin/123/sent/?sender=example'
        with patch.object(p.requests,'head',side_effect=[response(location=endpoint),response(location=destination)]) as head:
            self.assertEqual(p.resolve_social_url('https://pin.it/Example123','pinterest'),'https://www.pinterest.com/pin/123/')
            self.assertEqual([c.args[0] for c in head.call_args_list],
                             ['https://api.pinterest.com/url_shortener/Example123/redirect/',endpoint])
        for target in ['https://api.pinterest.com.evil/url_shortener/Example456/redirect/',
                       'https://api.pinterest.com/other/path',
                       'https://api.pinterest.com/url_shortener/../redirect/',
                       'https://user:pass@api.pinterest.com/url_shortener/Example456/redirect/',
                       'https://api.pinterest.com:443/url_shortener/Example456/redirect/',
                       'http://api.pinterest.com/url_shortener/Example456/redirect/',
                       'https://www.pinterest.com/name/board/',
                       'https://www.pinterest.com/name/',
                       'https://www.pinterest.com/pin/123/sent/extra/']:
            with self.subTest(target=target), patch.object(p.requests,'head',return_value=response(location=target)) as head:
                with self.assertRaises((app.UserVisibleError,ValueError)):
                    p.resolve_social_url('https://pin.it/Example123','pinterest')
                self.assertEqual(head.call_count,1,'invalid redirect must never be fetched')
        with self.assertRaises(app.UserVisibleError):
            p.social_url(endpoint,'pinterest')  # Internal API URLs are not public Pin inputs.

    def test_pinterest_shortener_loop_missing_redirect_and_http_errors_are_bounded(self):
        with patch.object(p.requests,'head',return_value=response(location='https://pin.it/Example123')) as head:
            with self.assertRaisesRegex(app.UserVisibleError,'بیش از حد'):
                p.resolve_social_url('https://pin.it/Example123','pinterest')
            self.assertEqual(head.call_count,6)
        for status, pattern in [(200,'لینک کوتاه'),(404,'دسترس'),(403,'نپذیرفت')]:
            with self.subTest(status=status),patch.object(p.requests,'head',return_value=response(status=status)) as head:
                with self.assertRaisesRegex(app.UserVisibleError,pattern):
                    p.resolve_social_url('https://pin.it/Example123','pinterest')
                self.assertEqual(head.call_count,1)

    def test_shared_pinterest_photo_and_video_reach_existing_preparation_with_exact_pin(self):
        canonical='https://www.pinterest.com/pin/266556871689003952/'
        for image in (True,False):
            entry={'id':'266556871689003952','url':'https://i.pinimg.com/fixture.jpg' if image else 'https://v.pinimg.com/fixture.mp4',
                   'title':'Pin fixture','ext':'jpg' if image else 'mp4','image':image}
            def prepare(item,platform,directory,budget,deadline,*,audio_only):
                path=directory/'fixture';path.write_bytes(b'complete fixture')
                return {'path':path,'method':'sendPhoto' if image else 'sendVideo','data':{},'title':'Pin fixture'}
            with self.subTest(image=image),tempfile.TemporaryDirectory() as directory, \
                    patch.object(p.requests,'head',return_value=response(location=canonical+'sent/?sender=42')), \
                    patch.object(p,'social_gallery_entries',return_value=[entry]) as gallery, \
                    patch.object(p,'social_prepare_entry',side_effect=prepare):
                url,items=p.prepare_social_media({'platform':'pinterest','url':'https://pin.it/Example123'},Path(directory))
                gallery.assert_called_once_with(canonical,'pinterest')
                self.assertEqual(url,canonical)
                self.assertEqual(items[0]['method'],'sendPhoto' if image else 'sendVideo')
                self.assertEqual(items[0]['path'].read_bytes(),b'complete fixture')
                self.assertIn(canonical,items[0]['caption'])
                self.assertNotIn('sender=',items[0]['caption'])

    def test_cdn_redirect_to_another_service_never_fetched(self):
        with tempfile.TemporaryDirectory() as d,patch.object(p.requests,'get',return_value=response(location='https://evil.example/video')) as get:
            with self.assertRaises(app.UserVisibleError):p.social_download_http('https://video.twimg.com/a.mp4',Path(d)/'source','x',1000,time.monotonic()+60)
            self.assertEqual(get.call_count,1)

    def test_streaming_limit_deadline_and_length_are_enforced(self):
        with tempfile.TemporaryDirectory() as d:
            for r,budget,deadline in [(response(content=b'12345'),4,time.monotonic()+60),
                                      (response(content=b'12345'),100,time.monotonic()-1)]:
                with patch.object(p.requests,'get',return_value=r),self.assertRaises(app.UserVisibleError):
                    p.social_download_http('https://i.pinimg.com/a.jpg',Path(d)/'source','pinterest',budget,deadline)
            r=response();r.headers['Content-Length']='100'
            with patch.object(p.requests,'get',return_value=r),self.assertRaises(app.UserVisibleError):
                p.social_download_http('https://i.pinimg.com/a.jpg',Path(d)/'source','pinterest',1000,time.monotonic()+60)

    def test_http_access_failure_is_not_mislabeled_as_deleted(self):
        with tempfile.TemporaryDirectory() as d,patch.object(p.requests,'get',return_value=response(status=403)):
            with self.assertRaisesRegex(app.UserVisibleError,'دسترسی'):
                p.social_download_http('https://video.twimg.com/a.mp4',Path(d)/'source','x',1000,time.monotonic()+60)

    def test_reported_pinterest_not_found_row_is_not_a_file_download_failure(self):
        # Captured gallery-dl 1.32.17 output for pin.it/6CNqhwjOg: the Pin
        # metadata API returns HTTP 404/code 50 before any media is downloaded.
        data=[[-1,{'error':'NotFoundError','message':'Requested pin could not be found'}]]
        command=[sys.executable,'-c',f'print({json.dumps(data)!r})']
        with self.assertRaisesRegex(app.UserVisibleError,'پست Pinterest حذف شده، در دسترس نیست'):
            p.social_json(command,'pinterest')
        self.assertIn('دریافت فایل',str(p.social_error('pinterest','TimeoutExpired')))
        self.assertIn('دسترسی',str(p.social_error('pinterest','NotFoundError: private pin, login required')))

    def test_metadata_output_error_rows_and_invalid_json_are_not_success(self):
        def command(data,code=0):return [sys.executable,'-c',f'import sys;print({data!r});sys.exit({code})']
        self.assertEqual(p.social_json(command('{"ok":true}'),'x'),{'ok':True})
        for data in ['not json',json.dumps([[-1,{'error':'AuthorizationError','message':'login required'}]])]:
            with self.assertRaises(app.UserVisibleError):p.social_json(command(data),'pinterest')
        with self.assertRaises(app.UserVisibleError):p.social_json(command('{}',1),'x')
        with self.assertRaises(app.UserVisibleError):p.social_json([sys.executable,'-c','print("a"*12000001)'],'x')


class SocialExtractorTests(unittest.TestCase):
    def test_pinterest_gif_from_reported_pin_is_kept_as_animation(self):
        rows=[[3,'https://i.pinimg.com/originals/94/3c/9f/943c9f351186f1b98e3ed3bfb855c8e0.gif',
               {'category':'pinterest','extension':'gif','id':'794674296784100176'}]]
        with patch.object(p,'social_json',return_value=rows):
            entry=p.social_gallery_entries('https://www.pinterest.com/pin/794674296784100176/','pinterest')[0]
        self.assertEqual(entry['ext'],'gif')
        self.assertTrue(entry['animation'])
        self.assertTrue(entry['image'],'GIF must not be offered as an audio source')
        with tempfile.TemporaryDirectory() as directory,patch.object(p,'social_gallery_entries',return_value=[entry]), \
                patch.object(p,'social_prepare_entry') as prepare:
            with self.assertRaisesRegex(app.UserVisibleError,'صدا'):
                p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/794674296784100176/','audioOnly':True},Path(directory))
            prepare.assert_not_called()

    def test_x_multi_video_and_explicit_order_are_kept(self):
        entries=[metadata(),metadata()];entries[1]['id']='124'
        with patch.object(p,'social_json',return_value={'_type':'playlist','extractor_key':'Twitter','entries':entries}) as run:
            result=p.social_ytdlp_entries('https://x.com/i/status/123','x')
            self.assertEqual([e['id'] for e in result],['123','124'])
            self.assertIn('Twitter,TikTok,Soundcloud',run.call_args.args[0])
            self.assertNotIn('youtube:player_client',str(run.call_args.args))

    def test_x_uses_only_one_bounded_syndication_fallback(self):
        with patch.object(p,'social_json',side_effect=[app.UserVisibleError('restricted'),metadata()]) as run:
            p.social_ytdlp_entries('https://x.com/i/status/123','x')
            self.assertEqual(run.call_count,2)
            self.assertIn('twitter:api=syndication',run.call_args.args[0])

    def test_soundcloud_preview_only_rejected_and_full_format_preserved(self):
        data=metadata('soundcloud');data['formats'][0]['format_id']='hls_mp3_preview'
        with patch.object(p,'social_json',return_value=copy.deepcopy(data)),self.assertRaisesRegex(app.UserVisibleError,'پیش‌نمایش'):
            p.social_ytdlp_entries('https://soundcloud.com/artist/song','soundcloud')
        data['formats'].append({**data['formats'][0],'format_id':'http_mp3'})
        with patch.object(p,'social_json',return_value=data):
            self.assertEqual(len(p.social_ytdlp_entries('https://soundcloud.com/artist/song','soundcloud')[0]['formats']),1)

    def test_live_drm_external_formats_and_external_extractors_are_rejected(self):
        cases=[]
        a=metadata();a['is_live']=True;cases.append(a)
        a=metadata();a['formats'][0]['has_drm']=True;cases.append(a)
        a=metadata();a['formats'][0]['url']='https://127.0.0.1/video';cases.append(a)
        a=metadata();a['extractor_key']='Generic';cases.append(a)
        for a in cases:
            with patch.object(p,'social_json',return_value=a),self.assertRaises(app.UserVisibleError):p.social_ytdlp_entries('https://x.com/i/status/123','x')

    def test_gallery_preserves_photo_order_hls_and_private_fallback_metadata(self):
        rows=[[2,{}],[3,'https://i.pinimg.com/originals/a.jpg',{'category':'pinterest','extension':'jpg','id':'123'}],
              [3,'ytdl:https://v.pinimg.com/a.m3u8',{'category':'pinterest','extension':'mp4','id':'123','_ytdl_manifest':'hls','_fallback':['https://v.pinimg.com/a.mp4']}]]
        with patch.object(p,'social_json',return_value=rows) as run:
            entries=p.social_gallery_entries('https://www.pinterest.com/pin/123/','pinterest')
            self.assertEqual([e['image'] for e in entries],[True,False])
            self.assertEqual(entries[1]['ext'],'mp4')
            self.assertEqual(entries[1]['url'],'https://v.pinimg.com/a.mp4')
            self.assertIn('output.private=true',run.call_args.args[0])

    def test_soundcloud_official_new_playback_domain_allowed_but_lookalike_blocked(self):
        self.assertEqual(p.social_cdn_url('https://playback.media-streaming.soundcloud.cloud/a','soundcloud'),'https://playback.media-streaming.soundcloud.cloud/a')
        with self.assertRaises(app.UserVisibleError):p.social_cdn_url('https://playback.media-streaming.soundcloud.cloud.evil/a','soundcloud')

    def test_hls_without_direct_alternative_keeps_manifest_route(self):
        rows=[[3,'ytdl:https://v.pinimg.com/a.m3u8',{'category':'pinterest','extension':'mp4','_ytdl_manifest':'hls'}]]
        with patch.object(p,'social_json',return_value=rows):
            self.assertEqual(p.social_gallery_entries('https://www.pinterest.com/pin/123/','pinterest')[0]['ext'],'m3u8')

    def test_gallery_more_than_twenty_is_explicit_failure(self):
        rows=[[3,'https://p16.tiktokcdn.com/a.jpg',{'category':'tiktok','extension':'jpg'}]]*21
        with patch.object(p,'social_json',return_value=rows),self.assertRaisesRegex(app.UserVisibleError,'20'):
            p.social_gallery_entries('https://www.tiktok.com/@a/photo/123','tiktok')

    def test_pinned_native_extractors_match_canonical_urls(self):
        from yt_dlp import YoutubeDL
        with YoutubeDL({'quiet':True,'allowed_extractors':['Twitter','TikTok','Soundcloud']}) as y:
            for url in ['https://x.com/i/status/123/video/2','https://www.tiktok.com/@a/video/123','https://soundcloud.com/artist/song']:
                self.assertEqual(len([ie for ie in y._ies.values() if ie.suitable(url)]),1,url)
        from gallery_dl.extractor import find
        for url in ['https://www.tiktok.com/@a/photo/123','https://www.pinterest.com/pin/123/']:
            self.assertIsNotNone(find(url))

    def test_actual_pinterest_data_job_emits_original_and_hls_schema_used_by_pipeline(self):
        from gallery_dl import config
        from gallery_dl.job import DataJob
        from gallery_dl.extractor.pinterest import PinterestAPI
        config.clear();config.set(('output',),'private',True)
        pin={'id':'123','images':{'orig':{'url':'https://i.pinimg.com/originals/a.jpg'}},'description':'Fixture'}
        with patch.object(PinterestAPI,'pin',return_value=pin):
            job=DataJob('https://www.pinterest.com/pin/123/',file=io.StringIO());job.run()
        self.assertIsNone(job.exception)
        self.assertEqual(job.data_urls,['https://i.pinimg.com/originals/a.jpg'])
        pin={'id':'124','videos':{'video_list':{'V_HLSV4':{'url':'https://v.pinimg.com/a.m3u8'},'V_720P':{'url':'https://v.pinimg.com/a.mp4'}}}}
        with patch.object(PinterestAPI,'pin',return_value=pin):
            job=DataJob('https://www.pinterest.com/pin/124/',file=io.StringIO());job.run()
        with patch.object(p,'social_json',return_value=json.loads(job.file.getvalue())):
            entry=p.social_gallery_entries('https://www.pinterest.com/pin/124/','pinterest')[0]
        self.assertEqual(entry['ext'],'mp4');self.assertEqual(entry['url'],'https://v.pinimg.com/a.mp4')
        config.clear()

    def test_actual_tiktok_data_job_emits_all_slides_without_audio_or_cover(self):
        from gallery_dl import config
        from gallery_dl.job import DataJob
        from gallery_dl.extractor.tiktok import TiktokExtractor
        config.clear();config.set(('extractor','tiktok'),'audio',False)
        post={'id':'123','author':{'uniqueId':'example'},'createTime':'1700000000','desc':'Fixture','imagePost':{'images':[
            {'imageURL':{'urlList':[f'https://p16.tiktokcdn.com/{i}.jpg']},'imageWidth':100,'imageHeight':100} for i in range(3)]}}
        data={'webapp.video-detail':{'statusCode':0,'itemInfo':{'itemStruct':post}}}
        with patch.object(TiktokExtractor,'_extract_rehydration_data',return_value=data):
            job=DataJob('https://www.tiktok.com/@example/photo/123',file=io.StringIO());job.run()
        self.assertIsNone(job.exception)
        with patch.object(p,'social_json',return_value=json.loads(job.file.getvalue())):
            entries=p.social_gallery_entries('https://www.tiktok.com/@example/photo/123','tiktok')
        self.assertEqual([e['url'] for e in entries],[f'https://p16.tiktokcdn.com/{i}.jpg' for i in range(3)])
        config.clear()


class AparatTests(unittest.TestCase):
    def api(self,**changes):
        attributes={'uid':'abc123','title':'Fixture','duration':'10','can_download':True,'deleted':False,
                    'file_link_all':[{'profile':'360p','urls':['https://a.cdn.asset.aparat.com/360.mp4']},
                                     {'profile':'1080p','urls':['https://a.cdn.asset.aparat.com/1080.mp4']}]}
        attributes.update(changes)
        return response(content=json.dumps({'data':{'attributes':attributes}}).encode())

    def test_canonical_embed_and_renditions_use_only_first_party_https_api(self):
        self.assertEqual(p.social_url('https://aparat.com/video/video/embed/videohash/abc123/vt/frame','aparat'),'https://www.aparat.com/v/abc123')
        with patch.object(p.requests,'get',return_value=self.api()) as get:
            entry=p.aparat_entries('https://www.aparat.com/v/abc123')[0]
        self.assertEqual([f['height'] for f in entry['formats']],[360,1080]);self.assertEqual(entry['duration'],10)
        self.assertEqual(get.call_args.args[0],'https://www.aparat.com/api/fa/v1/video/video/show/videohash/abc123')
        self.assertFalse(get.call_args.kwargs['allow_redirects'])

    def test_deleted_disabled_download_mismatched_id_and_external_media_are_rejected(self):
        for changes in [{'deleted':True},{'can_download':False},{'uid':'different'},
                        {'file_link_all':[{'urls':['https://evil.example/video.mp4']}]},{'file_link_all':[]}]:
            with self.subTest(changes=changes),patch.object(p.requests,'get',return_value=self.api(**changes)),self.assertRaises(app.UserVisibleError):
                p.aparat_entries('https://www.aparat.com/v/abc123')
        for url in ['https://aparat.com/channel','https://aparat.com/live/name','https://aparat.com.evil/v/abc123']:
            with self.assertRaises(app.UserVisibleError):p.social_url(url,'aparat')

    def test_api_limits_errors_and_redirects_do_not_become_success(self):
        for r in [response(status=403),response(status=302,location='https://evil.example'),response(content=b'invalid JSON'),response(content=b'x'*2000001)]:
            with patch.object(p.requests,'get',return_value=r),self.assertRaises(app.UserVisibleError):p.aparat_entries('https://www.aparat.com/v/abc123')

    def test_audio_selection_keeps_exact_gallery_item_and_distinct_cache_key(self):
        entries=[{'image':True},{'title':'First'},{'title':'Second'}]
        with tempfile.TemporaryDirectory() as d:
            def prepare(entry,platform,directory,budget,deadline,*,audio_only):
                self.assertTrue(audio_only);self.assertEqual(entry['title'],'Second')
                path=directory/'Music.mp3';path.write_bytes(b'audio')
                return {'path':path,'method':'sendAudio','title':entry['title'],'data':{}}
            with patch.object(p,'social_gallery_entries',return_value=entries),patch.object(p,'social_prepare_entry',side_effect=prepare) as prep:
                _,items=p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/123/','audioOnly':True,'itemIndex':2},Path(d))
            self.assertEqual(items[0]['index'],2);prep.assert_called_once()
            self.assertNotEqual(items[0]['cacheKey'],'social:'+__import__('hashlib').sha256(b'pinterest:https://www.pinterest.com/pin/123/:2:v1').hexdigest())
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_gallery_entries',return_value=entries):
            with self.assertRaises(app.UserVisibleError):p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/123/','audioOnly':True,'itemIndex':3},Path(d))

    def test_photo_only_audio_request_fails_before_downloading(self):
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_gallery_entries',return_value=[{'image':True}]),patch.object(p,'social_prepare_entry') as prepare:
            with self.assertRaisesRegex(app.UserVisibleError,'ویدیویی'):
                p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/123/','audioOnly':True},Path(d))
            prepare.assert_not_called()


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg required')
class SocialFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory=tempfile.TemporaryDirectory();cls.root=Path(cls.directory.name)
        subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','color=blue:s=64x48:r=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:v','libx264','-c:a','aac',str(cls.root/'fixture.mp4')],check=True)
        subprocess.run(['ffmpeg','-y','-v','error','-i',str(cls.root/'fixture.mp4'),'-frames:v','1',str(cls.root/'fixture.jpg')],check=True)
        subprocess.run(['ffmpeg','-y','-v','error','-i',str(cls.root/'fixture.mp4'),'-an','-c:v','copy',str(cls.root/'silent.mp4')],check=True)
        subprocess.run(['ffmpeg','-y','-v','error','-i',str(cls.root/'fixture.mp4'),'-vf','fps=5',str(cls.root/'fixture.gif')],check=True)
    @classmethod
    def tearDownClass(cls):cls.directory.cleanup()

    def prepare(self,entry,platform,fixture):
        with tempfile.TemporaryDirectory() as d:
            def download(url,target,*args):shutil.copyfile(self.root/fixture,target)
            with patch.object(p,'social_download_http',side_effect=download):
                item=p.social_prepare_entry(entry,platform,Path(d),1_000_000,time.monotonic()+60)
            self.assertTrue(item['path'].exists())
            probe=json.loads(subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(item['path'])],capture_output=True,text=True,check=True).stdout)
            return item,probe

    def test_real_video_has_audio_geometry_duration_and_streamable_mp4(self):
        item,probe=self.prepare({'url':'https://video.twimg.com/a.mp4','title':'Fixture','duration':1},'x','fixture.mp4')
        self.assertEqual(item['method'],'sendVideo');self.assertEqual(item['data']['width'],64)
        self.assertEqual({s['codec_type'] for s in probe['streams']},{'audio','video'})
        self.assertGreater(float(probe['format']['duration']),0.9)

    def test_soundcloud_output_is_tagged_complete_mp3(self):
        item,probe=self.prepare({'url':'https://cf-media.sndcdn.com/a.mp3','title':'Song','artist':'Artist','duration':1},'soundcloud','fixture.mp4')
        self.assertEqual(item['method'],'sendAudio');self.assertEqual(probe['streams'][0]['codec_name'],'mp3')
        self.assertEqual(probe['format']['tags']['title'],'Song');self.assertEqual(probe['format']['tags']['artist'],'Artist')

    def test_photo_is_readable_jpeg_for_telegram_photo_message(self):
        item,probe=self.prepare({'url':'https://i.pinimg.com/a.jpg','ext':'jpg','image':True,'title':'Fixture'},'pinterest','fixture.jpg')
        self.assertEqual(item['method'],'sendPhoto');self.assertEqual(probe['streams'][0]['codec_name'],'mjpeg')

    def test_gif_keeps_every_original_byte_and_frame_instead_of_becoming_a_still_photo(self):
        with tempfile.TemporaryDirectory() as directory:
            original=(self.root/'fixture.gif').read_bytes()
            entry={'url':'https://i.pinimg.com/fixture.gif','ext':'gif','image':True,'animation':True,'title':'GIF fixture'}
            def download(url,target,*args):target.write_bytes(original)
            with patch.object(p,'social_download_http',side_effect=download):
                item=p.social_prepare_entry(entry,'pinterest',Path(directory),1_000_000,time.monotonic()+60)
            self.assertEqual(item['method'],'sendAnimation')
            self.assertEqual(item['path'].suffix,'.gif')
            self.assertEqual(item['path'].read_bytes(),original)
            probe=json.loads(subprocess.run(['ffprobe','-v','error','-count_frames','-show_streams','-of','json',str(item['path'])],capture_output=True,text=True,check=True).stdout)
            self.assertGreater(int(probe['streams'][0]['nb_read_frames']),1)
            self.assertFalse(item['hasAudio'])

    def test_non_gif_bytes_are_never_published_as_animation(self):
        entry={'url':'https://i.pinimg.com/fixture.gif','ext':'gif','image':True,'animation':True}
        with self.assertRaises(app.UserVisibleError):
            self.prepare(entry,'pinterest','fixture.jpg')

    def test_short_video_is_rejected_instead_of_sending_partial(self):
        with self.assertRaisesRegex(app.UserVisibleError,'ناقص'):
            self.prepare({'url':'https://video.twimg.com/a.mp4','duration':50},'x','fixture.mp4')

    def test_real_ytdlp_download_from_validated_info_file_then_remux(self):
        from functools import partial
        from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
        import threading
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=self.root))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            entry=metadata();entry['formats'][0].update({'url':f'http://127.0.0.1:{server.server_port}/fixture.mp4','width':64,'height':48,'protocol':'http'})
            # Local fixture replaces only the already-validated CDN transport.
            with tempfile.TemporaryDirectory() as d,patch.object(app,'REAL_YTDLP',shutil.which('yt-dlp')):
                item=p.social_prepare_entry(entry,'x',Path(d),1_000_000,time.monotonic()+60)
                self.assertEqual(item['method'],'sendVideo');self.assertEqual(item['data']['duration'],1)
            entry['formats'][0].update({'url':f'http://127.0.0.1:{server.server_port}/silent.mp4','acodec':'none'})
            with tempfile.TemporaryDirectory() as d,patch.object(app,'REAL_YTDLP',shutil.which('yt-dlp')):
                item=p.social_prepare_entry(entry,'x',Path(d),1_000_000,time.monotonic()+60)
                self.assertEqual(item['method'],'sendVideo');self.assertEqual(item['data']['duration'],1)
        finally:server.shutdown();server.server_close();thread.join()


    def test_master_hls_is_expanded_before_downloading_media(self):
        from functools import partial
        from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
        import threading
        with tempfile.TemporaryDirectory() as fixture_dir,tempfile.TemporaryDirectory() as output_dir:
            root=Path(fixture_dir)
            subprocess.run(['ffmpeg','-y','-v','error','-i',str(self.root/'fixture.mp4'),'-c','copy','-hls_time','0.4','-hls_playlist_type','vod',str(root/'variant.m3u8')],check=True)
            (root/'master.m3u8').write_text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=64x48\nvariant.m3u8\n')
            class Quiet(SimpleHTTPRequestHandler):
                def log_message(self,*args):pass
            server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=root))
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                entry={'id':'123','title':'HLS fixture','ext':'m3u8','duration':1,'url':f'http://127.0.0.1:{server.server_port}/master.m3u8'}
                with patch.object(p,'social_cdn_url',side_effect=lambda url,platform:url),patch.object(app,'REAL_YTDLP',shutil.which('yt-dlp')):
                    item=p.social_prepare_entry(entry,'pinterest',Path(output_dir),1_000_000,time.monotonic()+60)
                self.assertEqual(item['method'],'sendVideo');self.assertEqual(item['data']['duration'],1)
                self.assertGreater(item['path'].stat().st_size,1000)
            finally:server.shutdown();server.server_close();thread.join()


    def test_social_audio_outputs_real_tagged_mp3_for_all_video_services(self):
        for platform,host in [('x','video.twimg.com'),('tiktok','v.tiktokcdn.com'),('pinterest','v.pinimg.com'),('aparat','a.asset.aparat.com')]:
            with self.subTest(platform=platform),tempfile.TemporaryDirectory() as d:
                def download(url,target,*args):shutil.copyfile(self.root/'fixture.mp4',target)
                with patch.object(p,'social_download_http',side_effect=download):
                    item=p.social_prepare_entry({'url':f'https://{host}/a.mp4','title':'Clip audio','duration':1},platform,Path(d),1000000,time.monotonic()+60,audio_only=True)
                self.assertEqual(item['method'],'sendAudio');self.assertEqual(item['data']['duration'],1)
                probe=json.loads(subprocess.run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(item['path'])],capture_output=True,text=True,check=True).stdout)
                self.assertEqual([x['codec_type'] for x in probe['streams']],['audio'])
                self.assertEqual(probe['streams'][0]['codec_name'],'mp3');self.assertEqual(probe['format']['tags']['title'],'Clip audio')

    def test_silent_video_and_selected_photo_do_not_create_fake_audio(self):
        with tempfile.TemporaryDirectory() as d:
            def download(url,target,*args):shutil.copyfile(self.root/'silent.mp4',target)
            with patch.object(p,'social_download_http',side_effect=download),self.assertRaisesRegex(app.UserVisibleError,'صدا ندارد'):
                p.social_prepare_entry({'url':'https://video.twimg.com/a.mp4'},'x',Path(d),1000000,time.monotonic()+60,audio_only=True)
            with self.assertRaisesRegex(app.UserVisibleError,'عکس'):
                p.social_prepare_entry({'image':True},'pinterest',Path(d),1000000,time.monotonic()+60,audio_only=True)


class SocialEarlyCacheTests(unittest.TestCase):
    @staticmethod
    def cached(**changes):
        return {'method':'sendVideo','fileId':'cached_id','fileSize':1234,'hasAudio':True,
                'data':{'duration':1,'caption':'old'},**changes}

    @staticmethod
    def prepare(entry,platform,directory,budget,deadline,*,audio_only):
        method='sendAudio' if audio_only or platform=='soundcloud' else 'sendPhoto' if entry.get('image') else 'sendVideo'
        path=directory/'fixture';path.write_bytes(b'complete')
        return {'path':path,'method':method,'data':{},'title':entry.get('title','Fixture'),'hasAudio':method=='sendVideo'}

    def test_fresh_metadata_cache_hit_skips_media_download_for_every_service(self):
        cases=[('x','https://x.com/i/status/123','social_ytdlp_entries'),
               ('tiktok','https://www.tiktok.com/@a/video/123','social_ytdlp_entries'),
               ('pinterest','https://www.pinterest.com/pin/123/','social_gallery_entries'),
               ('aparat','https://www.aparat.com/v/abc123','aparat_entries'),
               ('soundcloud','https://soundcloud.com/artist/song','social_ytdlp_entries')]
        for platform,url,extractor in cases:
            with self.subTest(platform=platform),tempfile.TemporaryDirectory() as d:
                cached={'method':'sendAudio' if platform=='soundcloud' else 'sendVideo','fileId':'cached_id',
                        'fileSize':1234,'hasAudio':True,'data':{'duration':1}}
                with patch.object(p,extractor,return_value=[metadata('x')]) as resolve, \
                     patch.object(app,'file_cache',return_value=cached) as cache, \
                     patch.object(p,'social_prepare_entry') as prepare:
                    _,items=p.prepare_social_media({'platform':platform,'url':url},Path(d),cache_payload=payload())
                resolve.assert_called_once();cache.assert_called_once();prepare.assert_not_called()
                self.assertEqual(items[0]['cached']['fileId'],'cached_id')
                self.assertNotIn('path',items[0]);self.assertEqual(items[0]['fileSize'],1234)

    def test_source_rejection_is_checked_before_reading_a_cached_file(self):
        with tempfile.TemporaryDirectory() as d, \
             patch.object(p,'aparat_entries',side_effect=app.UserVisibleError('download disabled')) as resolve, \
             patch.object(app,'file_cache',return_value=self.cached()) as cache,patch.object(p,'social_prepare_entry') as prepare:
            with self.assertRaisesRegex(app.UserVisibleError,'download disabled'):
                p.prepare_social_media({'platform':'aparat','url':'https://www.aparat.com/v/abc123'},Path(d),cache_payload=payload())
            resolve.assert_called_once();cache.assert_not_called();prepare.assert_not_called()

    def test_a_previously_cached_song_cannot_bypass_a_current_preview_only_restriction(self):
        entry=metadata('soundcloud');entry['formats'][0]['format_id']='hls_mp3_preview'
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_json',return_value=entry), \
             patch.object(app,'file_cache',return_value=self.cached(method='sendAudio')) as cache, \
             patch.object(p,'social_prepare_entry') as prepare:
            with self.assertRaisesRegex(app.UserVisibleError,'پیش‌نمایش'):
                p.prepare_social_media({'platform':'soundcloud','url':'https://soundcloud.com/artist/song'},Path(d),cache_payload=payload())
            cache.assert_not_called();prepare.assert_not_called()

    def test_source_identity_modes_and_indices_control_reuse_but_rotating_signatures_do_not(self):
        entry=metadata();entry['formats'][0]['url']='https://video.twimg.com/play.mp4?item=first&token=old&Expires=1'
        key=lambda e,**kw:p.social_cache_key('x','https://x.com/i/status/123',kw.get('index',0),e,kw.get('audio',False))
        original=key(entry)
        rotated=copy.deepcopy(entry);rotated['formats'][0]['url']='https://video.twimg.com/play.mp4?Expires=2&token=new&item=first'
        self.assertEqual(original,key(rotated))
        changed=copy.deepcopy(entry);changed['formats'][0]['url']='https://video.twimg.com/play.mp4?item=second&token=old'
        self.assertNotEqual(original,key(changed))
        for changes in [{'id':'124'},{'title':'Updated title'},{'duration':2}]:
            self.assertNotEqual(original,key({**entry,**changes}))
        silent=copy.deepcopy(entry);silent['formats'][0]['acodec']='none'
        self.assertNotEqual(original,key(silent))
        self.assertNotEqual(original,key(entry,index=1));self.assertNotEqual(original,key(entry,audio=True))

    def test_old_incomplete_wrong_type_and_unavailable_cache_entries_download_normally(self):
        old=self.cached();old.pop('fileSize')
        old_audio=self.cached();old_audio.pop('hasAudio')
        for cached in [None,old,old_audio,self.cached(fileSize=True),self.cached(hasAudio='true'),
                       self.cached(fileId='../invalid'),self.cached(method='sendAudio'),self.cached(data=None)]:
            with self.subTest(cached=cached),tempfile.TemporaryDirectory() as d, \
                 patch.object(p,'social_ytdlp_entries',return_value=[metadata()]), \
                 patch.object(app,'file_cache',return_value=cached), \
                 patch.object(p,'social_prepare_entry',side_effect=self.prepare) as prepare:
                _,items=p.prepare_social_media({'platform':'x','url':'https://x.com/i/status/123'},Path(d),cache_payload=payload())
                prepare.assert_called_once();self.assertTrue(items[0]['path'].is_file());self.assertNotIn('cached',items[0])

    def test_gallery_keeps_original_order_and_prepares_only_misses_and_photos(self):
        entries=[{'id':str(i),'title':f'item {i}','url':f'https://v.pinimg.com/{i}.mp4','image':i==1} for i in range(4)]
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_gallery_entries',return_value=entries), \
             patch.object(app,'file_cache',side_effect=[self.cached(),None,self.cached()]) as cache, \
             patch.object(p,'social_prepare_entry',side_effect=self.prepare) as prepare:
            _,items=p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/123/'},Path(d),cache_payload=payload())
            self.assertEqual([i['index'] for i in items],[0,1,2,3]);self.assertEqual(cache.call_count,3)
            self.assertEqual([c.args[0]['id'] for c in prepare.call_args_list],['1','2'])
            self.assertEqual(['cached' in i for i in items],[True,False,False,True])

    def test_cached_sizes_preserve_the_combined_post_limit_before_any_send(self):
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_ytdlp_entries',return_value=[metadata(),metadata()]), \
             patch.object(app,'file_cache',return_value=self.cached(fileSize=1_500_000_000)), \
             patch.object(p,'social_prepare_entry') as prepare,patch.object(app,'telegram_call') as send:
            with self.assertRaisesRegex(app.UserVisibleError,'2 گیگابایت'):
                p.prepare_social_media({'platform':'x','url':'https://x.com/i/status/123'},Path(d),cache_payload=payload())
            prepare.assert_not_called();send.assert_not_called()

    def test_selected_gallery_audio_cache_never_prepares_neighboring_items(self):
        entries=[{'id':str(i),'title':f'item {i}','url':f'https://v.pinimg.com/{i}.mp4'} for i in range(3)]
        with tempfile.TemporaryDirectory() as d,patch.object(p,'social_gallery_entries',return_value=entries), \
             patch.object(app,'file_cache',return_value=self.cached(method='sendAudio')) as cache, \
             patch.object(p,'social_prepare_entry') as prepare:
            _,items=p.prepare_social_media({'platform':'pinterest','url':'https://www.pinterest.com/pin/123/',
                                            'audioOnly':True,'itemIndex':2},Path(d),cache_payload=payload())
            self.assertEqual([i['index'] for i in items],[2]);prepare.assert_not_called();cache.assert_called_once()
            self.assertEqual(cache.call_args.args[2],items[0]['cacheKey'])

    def run_cached_job(self, *, rejection=None, mixed=False, has_audio=True):
        job=app.InstagramCapture({**payload(),'userId':42})
        calls=[];puts=[];prepares=[]
        entries=[metadata(),{**metadata(),'id':'124','title':'Second'}] if mixed else [metadata()]
        def cache(payload,op,key,value=None):
            if op=='get':
                if mixed and key==p.social_cache_key('x','https://x.com/i/status/123',1,entries[1],False):return None
                return self.cached(hasAudio=has_audio)
            puts.append((op,key,value));return None
        def prepare(*args,**kwargs):
            prepares.append(args[0]['id']);return self.prepare(*args,**kwargs)
        def telegram(token,method,*,json_payload,timeout):
            calls.append(('cached',json_payload))
            if rejection:raise rejection
            return {'message_id':10}
        async def upload(token,method,data,file):
            calls.append(('upload',data));return {'message_id':11,'file_id':'new_id'}
        try:
            with patch.object(p,'social_ytdlp_entries',return_value=entries),patch.object(app,'file_cache',side_effect=cache), \
                 patch.object(p,'social_prepare_entry',side_effect=prepare),patch.object(job,'notify'), \
                 patch.object(job,'safe_status'),patch.object(app,'delete_status'), \
                 patch.object(app,'telegram_call',side_effect=telegram),patch.object(app,'upload_complete_file',side_effect=upload):
                job.run();self.assertEqual(job.state,'ready');result=job.send();again=job.send()
            return result,again,calls,puts,prepares,job.social_items
        finally:job.cleanup()

    def test_valid_cache_sends_without_files_and_refreshes_owner_bound_audio_button(self):
        import hashlib,hmac
        result,again,calls,puts,prepares,items=self.run_cached_job()
        self.assertTrue(result['ok']);self.assertTrue(again['ok']);self.assertEqual(prepares,[])
        self.assertEqual([x[0] for x in calls],['cached']);self.assertNotIn('path',items[0])
        data=calls[0][1];self.assertEqual(data['chat_id'],42);self.assertEqual(data['reply_parameters'],{'message_id':7})
        signature=hmac.new(b'fake',b'social-audio:42:42:0:https://x.com/i/status/123',hashlib.sha256).hexdigest()[:16]
        self.assertEqual(data['reply_markup']['inline_keyboard'][0][0]['callback_data'],f'soa|0|42|{signature}')
        result,_,calls,_,prepares,_=self.run_cached_job(has_audio=False)
        self.assertTrue(result['ok']);self.assertEqual(prepares,[]);self.assertNotIn('reply_markup',calls[0][1])

    def test_explicit_invalid_id_evicts_and_prepares_only_that_item_then_refreshes_cache(self):
        result,again,calls,puts,prepares,_=self.run_cached_job(rejection=RuntimeError('wrong file identifier'))
        self.assertTrue(result['ok']);self.assertTrue(again['ok']);self.assertEqual(prepares,['123'])
        self.assertEqual([x[0] for x in calls],['cached','upload'])
        self.assertEqual([x[0] for x in puts],['delete','put'])
        refreshed=puts[-1][2];self.assertEqual(refreshed['fileId'],'new_id');self.assertEqual(refreshed['fileSize'],8)
        self.assertTrue(refreshed['hasAudio']);self.assertNotIn('chat_id',refreshed['data'])

    def test_ambiguous_cached_send_never_downloads_uploads_or_repeats(self):
        result,again,calls,puts,prepares,_=self.run_cached_job(rejection=TimeoutError('ambiguous'))
        self.assertFalse(result['ok']);self.assertFalse(again['ok']);self.assertEqual(result['parts'],0)
        self.assertEqual([x[0] for x in calls],['cached']);self.assertEqual(prepares,[]);self.assertEqual(puts,[])

    def test_mixed_cached_and_new_items_deliver_in_order_without_repreparing_the_hit(self):
        result,again,calls,puts,prepares,_=self.run_cached_job(mixed=True)
        self.assertTrue(result['ok']);self.assertTrue(again['ok']);self.assertEqual(result['parts'],2)
        self.assertEqual(prepares,['124']);self.assertEqual([x[0] for x in calls],['cached','upload'])
        self.assertTrue(calls[0][1]['caption'].startswith('Fixture'))
        self.assertTrue(calls[1][1]['caption'].startswith('Second'))

    def test_first_request_warms_cache_and_later_users_reuse_video_and_audio_independently(self):
        stored={};delivered=[]
        def cache(payload,op,key,value=None):
            if op=='get':return copy.deepcopy(stored.get(key))
            if op=='put':stored[key]=copy.deepcopy(value)
        async def upload(token,method,data,file):
            delivered.append(('upload',method,data));return {'message_id':10,'file_id':'stored_'+method}
        def telegram(token,method,*,json_payload,timeout):
            delivered.append(('cached',method,json_payload));return {'message_id':11}
        with patch.object(app,'file_cache',side_effect=cache), \
             patch.object(p,'social_ytdlp_entries',side_effect=lambda *args:[metadata()]) as resolve, \
             patch.object(p,'social_prepare_entry',side_effect=self.prepare) as prepare, \
             patch.object(app,'upload_complete_file',side_effect=upload),patch.object(app,'telegram_call',side_effect=telegram), \
             patch.object(app,'delete_status'):
            for index,audio in enumerate([False,True,False,True]):
                owner=42 if index<2 else 99;chat=42 if index<2 else 77
                job_id=f'igdl-{chat}-{index+7}-{owner}'
                request={**payload(),'id':job_id,'userId':owner,'chatId':chat,'requestMessageId':index+7,
                         'completionUrl':f'https://downloader.vexaagent.workers.dev/instagram/events/{job_id}'}
                request['source']['social']['audioOnly']=audio
                job=app.InstagramCapture(request)
                try:
                    with patch.object(job,'notify'),patch.object(job,'safe_status'):
                        job.run();self.assertEqual(job.state,'ready');self.assertTrue(job.send()['ok'])
                finally:job.cleanup()
        self.assertEqual(resolve.call_count,4);self.assertEqual(prepare.call_count,2);self.assertEqual(len(stored),2)
        self.assertEqual([(x[0],x[1]) for x in delivered],[('upload','sendVideo'),('upload','sendAudio'),('cached','sendVideo'),('cached','sendAudio')])
        self.assertEqual(delivered[2][2]['chat_id'],77)
        self.assertEqual(delivered[2][2]['reply_parameters'],{'message_id':9})
        self.assertIn('|99|',delivered[2][2]['reply_markup']['inline_keyboard'][0][0]['callback_data'])


class SocialLifecycleTests(unittest.TestCase):
    def test_gif_is_sent_through_existing_social_upload_with_correct_mime_and_without_audio_button(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'Animation.gif';path.write_bytes(b'GIF89a-complete-fixture')
            job=app.InstagramCapture(payload('pinterest'))
            job.state='ready';job.social_sent=0;job.social_url='https://www.pinterest.com/pin/794674296784100176/'
            job.social_items=[{'method':'sendAnimation','path':path,'data':{},'caption':'GIF','index':0,'hasAudio':False}]
            async def upload(token,method,data,file):
                self.assertEqual(method,'sendAnimation');self.assertEqual(file[2],'image/gif')
                self.assertEqual(file[1].read(),b'GIF89a-complete-fixture')
                self.assertNotIn('reply_markup',data)
                return {'message_id':1}
            try:
                with patch.object(app,'upload_complete_file',side_effect=upload),patch.object(job,'safe_status'),patch.object(app,'delete_status'):
                    self.assertTrue(job.send()['ok'])
                self.assertEqual(job.social_sent,1);self.assertEqual(job.state,'sent')
                self.assertFalse(path.exists())
            finally:job.cleanup()

    def test_social_prepare_uses_existing_completion_event_and_no_instagram_session(self):
        job=app.InstagramCapture(payload())
        try:
            with patch.object(p,'prepare_social_media',return_value=('https://x.com/i/status/123',[{'path':Path('unused')}])) as prepare,patch.object(job,'notify') as notify,patch.object(job,'safe_status'):
                job.run()
            self.assertEqual(job.state,'ready');self.assertTrue(job.result['ok']);notify.assert_called_once()
            prepare.assert_called_once();self.assertEqual(job.social_sent,0)
        finally:job.cleanup()

    def test_batch_upload_is_ordered_idempotent_and_stops_after_ambiguous_publish(self):
        for failure in [False,True]:
            job=app.InstagramCapture(payload());job.state='ready';job.social_sent=0
            job.social_items=[]
            for index in range(3):
                path=job.workdir/f'{index}.jpg';path.write_bytes(b'photo fixture')
                job.social_items.append({'path':path,'method':'sendPhoto','data':{},'caption':str(index),'cacheKey':'test:'+str(index)})
            sent=[]
            async def upload(token,method,data,file):
                sent.append(data['caption'])
                if failure and len(sent)==2:raise TimeoutError('ambiguous')
                return {'message_id':len(sent)}
            try:
                with patch.object(app,'upload_complete_file',side_effect=upload),patch.object(app,'delete_status'),patch.object(job,'safe_status'):
                    result=job.send();again=job.send()
                self.assertEqual(sent,['0','1'] if failure else ['0','1','2'])
                self.assertEqual(result['parts'],1 if failure else 3)
                self.assertEqual(again['ok'],not failure)
                self.assertEqual(job.state,'failed' if failure else 'sent')
                if failure:self.assertIn('چت را بررسی',result['message'])
            finally:job.cleanup()

    def test_preparation_error_notifies_failure_without_entering_upload(self):
        job=app.InstagramCapture(payload('pinterest'))
        try:
            with patch.object(p,'prepare_social_media',side_effect=app.UserVisibleError('fixture failure')),patch.object(job,'notify') as notify,patch.object(app,'upload_complete_file') as send:
                job.run()
            self.assertEqual(job.state,'failed');self.assertEqual(job.result['message'],'fixture failure')
            notify.assert_called_once();send.assert_not_called()
        finally:job.cleanup()


    def test_audio_button_is_owner_chat_item_and_url_signed_on_upload_and_cache_hits(self):
        import hashlib,hmac
        url='https://www.pinterest.com/pin/123/'
        for cached in [False,True]:
            job=app.InstagramCapture(payload('pinterest'));job.state='ready';job.social_sent=0;job.social_url=url
            path=job.workdir/'Video.mp4';path.write_bytes(b'fixture')
            job.social_items=[{'path':path,'method':'sendVideo','title':'Fixture','data':{},'caption':f'Fixture\n{url}','cacheKey':'test:video','hasAudio':True,'index':1}]
            if cached:
                job.social_items[0]['cached']={'fileId':'cached_id'}
            captured=[]
            async def upload(token,method,data,file):captured.append(json.loads(data['reply_markup']));return {'message_id':10}
            try:
                with patch.object(app,'reuse_cached_file',return_value=cached) as reuse,patch.object(app,'upload_complete_file',side_effect=upload) as up,patch.object(app,'delete_status'),patch.object(job,'safe_status'):
                    self.assertTrue(job.send()['ok'])
                markup=reuse.call_args.kwargs['reply_markup'] if cached else captured[0];button=markup['inline_keyboard'][0][0]
                sig=hmac.new(b'fake',f'social-audio:42:42:1:{url}'.encode(),hashlib.sha256).hexdigest()[:16]
                self.assertEqual(button['callback_data'],f'soa|1|42|{sig}');self.assertLessEqual(len(button['callback_data'].encode()),64)
                self.assertEqual(up.call_count,0 if cached else 1)
                if not cached:self.assertEqual(captured,[markup])
            finally:job.cleanup()

    def test_mtproto_sender_attaches_actual_inline_button_markup(self):
        from test_youtube_chat import FakeClient, isolated_uploader
        from telethon import types
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'Video.mp4';path.write_bytes(b'fixture')
            markup={'inline_keyboard':[[{'text':'🎵 فقط صدا','callback_data':'soa|0|42|0123456789abcdef'}]]}
            with patch.dict(os.environ,{'API_ID':'123','API_HASH':'test'}),patch('telethon.TelegramClient',FakeClient),isolated_uploader(),path.open('rb') as handle:
                asyncio.run(app.upload_complete_file('fake','sendVideo',{'chat_id':'42','reply_markup':json.dumps(markup)},(path.name,handle,'video/mp4')))
            button=FakeClient.instances[-1].sent[1]['buttons'][0][0]
            self.assertIsInstance(button,types.KeyboardInlineButton)
            self.assertIsInstance(button.type,types.InlineButtonTypeCallback)
            self.assertEqual(button.type.data,b'soa|0|42|0123456789abcdef')


if __name__=='__main__':unittest.main()
