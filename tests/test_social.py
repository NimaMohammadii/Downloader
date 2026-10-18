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
        with patch.object(p.requests,'get',return_value=response(location='https://127.0.0.1/private')) as get:
            with self.assertRaises(app.UserVisibleError):p.resolve_social_url('https://pin.it/ABC123','pinterest')
            self.assertEqual(get.call_count,1)

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

    def test_metadata_output_error_rows_and_invalid_json_are_not_success(self):
        def command(data,code=0):return [sys.executable,'-c',f'import sys;print({data!r});sys.exit({code})']
        self.assertEqual(p.social_json(command('{"ok":true}'),'x'),{'ok':True})
        for data in ['not json',json.dumps([[-1,{'error':'AuthorizationError','message':'login required'}]])]:
            with self.assertRaises(app.UserVisibleError):p.social_json(command(data),'pinterest')
        with self.assertRaises(app.UserVisibleError):p.social_json(command('{}',1),'x')
        with self.assertRaises(app.UserVisibleError):p.social_json([sys.executable,'-c','print("a"*12000001)'],'x')


class SocialExtractorTests(unittest.TestCase):
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


class SocialLifecycleTests(unittest.TestCase):
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
            captured=[]
            async def upload(token,method,data,file):captured.append(json.loads(data['reply_markup']));return {'message_id':10}
            try:
                with patch.object(app,'reuse_cached_file',return_value=cached) as reuse,patch.object(app,'upload_complete_file',side_effect=upload) as up,patch.object(app,'delete_status'),patch.object(job,'safe_status'):
                    self.assertTrue(job.send()['ok'])
                markup=reuse.call_args.kwargs['reply_markup'];button=markup['inline_keyboard'][0][0]
                sig=hmac.new(b'fake',f'social-audio:42:42:1:{url}'.encode(),hashlib.sha256).hexdigest()[:16]
                self.assertEqual(button['callback_data'],f'soa|1|42|{sig}');self.assertLessEqual(len(button['callback_data'].encode()),64)
                self.assertEqual(up.call_count,0 if cached else 1)
                if not cached:self.assertEqual(captured,[markup])
            finally:job.cleanup()

    def test_mtproto_sender_attaches_actual_inline_button_markup(self):
        from test_youtube_chat import FakeClient
        from telethon import types
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'Video.mp4';path.write_bytes(b'fixture')
            markup={'inline_keyboard':[[{'text':'🎵 فقط صدا','callback_data':'soa|0|42|0123456789abcdef'}]]}
            with patch.dict(os.environ,{'API_ID':'123','API_HASH':'test'}),patch('telethon.TelegramClient',FakeClient),path.open('rb') as handle:
                asyncio.run(app.upload_complete_file('fake','sendVideo',{'chat_id':'42','reply_markup':json.dumps(markup)},(path.name,handle,'video/mp4')))
            button=FakeClient.instances[-1].sent[1]['buttons'][0][0]
            self.assertIsInstance(button,types.KeyboardInlineButton)
            self.assertIsInstance(button.type,types.InlineButtonTypeCallback)
            self.assertEqual(button.type.data,b'soa|0|42|0123456789abcdef')


if __name__=='__main__':unittest.main()
