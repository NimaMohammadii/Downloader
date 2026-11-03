import copy
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app
import youtube_pipeline as pipeline
import bandcamp
import reddit
import pornhub


class SharedMediaCacheTests(unittest.TestCase):
    def payload(self, source):
        return {'id': 'igdl-99-8-99', 'userId': 99, 'chatId': 99, 'requestMessageId': 8,
                'statusMessageId': 10, 'botToken': 'fixture', 'source': source,
                'completionUrl': 'https://downloader.vexaagent.workers.dev/instagram/events/igdl-99-8-99', 'completionToken': '0'*64,
                'cacheSource': 'Instagram', 'cacheHistoryKey': 'ig:99:8:99', 'cacheVisibility': 'public'}

    def test_public_instagram_mixed_post_reuses_shared_ids_in_order_with_new_recipient_buttons(self):
        payload = self.payload({'mode': 'replay', 'instagramPost': {'shortcode': 'ExamplePost', 'media': [
            {'kind': 'photo', 'url': 'https://scontent.cdninstagram.com/photo.jpg', 'width': 100, 'height': 100},
            {'kind': 'video', 'url': 'https://scontent.cdninstagram.com/video.mp4', 'width': 100, 'height': 100}]}})
        payload['postCacheKey'] = 'ready:ig:ExamplePost:plain:all'
        values = {app.instagram_file_cache_key(payload, 'ExamplePost', i, mode):
                  {'method': method, 'fileId': f'cached_{i}', 'data': {'caption': 'Instagram'}, 'fileSize': 100}
                  for i, (mode, method) in enumerate([('photo', 'sendPhoto'), ('video', 'sendVideo')])}
        sent = []

        def cache(_payload, op, key, value=None):
            if op == 'put': values[key] = copy.deepcopy(value)
            return values.get(key)

        def send(_token, method, **kwargs):
            sent.append((method, kwargs['json_payload']))
            return {'message_id': len(sent)}

        job = app.InstagramCapture(payload)
        try:
            with patch.object(app, 'file_cache', side_effect=cache), patch.object(app, 'telegram_call', side_effect=send), \
                 patch.object(app, 'delete_status'), patch.object(app.USAGE, 'delivery') as usage, \
                 patch.object(job, 'download_post_item') as download, patch.object(app, 'upload_complete_file') as upload, patch.object(job, 'notify'):
                job.run()
                self.assertEqual(job.state, 'ready', job.result)
                result = job.send()
                self.assertTrue(result['ok'], result)
                download.assert_not_called(); upload.assert_not_called()
                self.assertEqual([row[0] for row in sent], ['sendPhoto', 'sendVideo'])
                self.assertEqual(sent[0][1]['photo'], 'cached_0')
                self.assertEqual(sent[1][1]['video'], 'cached_1')
                self.assertTrue(all(row[1]['chat_id'] == 99 for row in sent))
                self.assertIn('|99|', sent[1][1]['reply_markup']['inline_keyboard'][-1][0]['callback_data'])
                self.assertIsNone(usage.call_args_list[0].kwargs['cache_video'])
                self.assertEqual(usage.call_args_list[1].kwargs['cache_video']['downloadKey'], 'ig:99:8:99')
            post = values[payload['postCacheKey']]
            self.assertEqual([file['index'] for file in post['files']], [0, 1])
            self.assertNotIn('reply_markup', str(post))
            other = {**payload, 'userId': 42}
            self.assertEqual(app.instagram_file_cache_key(payload, 'ExamplePost', 1, 'video'),
                             app.instagram_file_cache_key(other, 'ExamplePost', 1, 'video'))
            self.assertNotEqual(app.instagram_file_cache_key(payload, 'ExamplePost', 1, 'video'),
                                app.instagram_file_cache_key({**payload, 'cacheVisibility': 'access'}, 'ExamplePost', 1, 'video'))
        finally:
            job.cleanup()

    def test_incomplete_or_duplicate_receipts_never_publish_a_complete_post(self):
        payload = {'postCacheKey': 'ready:test'}
        file = {'method': 'sendVideo', 'fileId': 'fixture', 'data': {}}
        with patch.object(app, 'file_cache') as cache:
            app.remember_post_file(payload, file, {'message_id': 1}, 0)
            app.remember_post_file(payload, file, {'message_id': 1}, 0)
            app.complete_post_cache(payload, 2)
            cache.assert_not_called()
            app.remember_post_file(payload, file, {}, 1)
            app.complete_post_cache(payload, 2)
            cache.assert_not_called()
            app.remember_post_file(payload, file, {'message_id': 2}, 1)
            app.complete_post_cache(payload, 2)
            self.assertEqual(len(cache.call_args.args[3]['files']), 2)

    def test_confirmed_photo_without_file_id_uses_copy_message_and_missing_reference_is_a_cache_miss(self):
        payload = {'botToken': 'fixture', 'chatId': 99, 'requestMessageId': 8, 'postCacheKey': 'ready:ig:photo:plain:all'}
        with patch.object(app, 'file_cache') as cache:
            app.store_uploaded_file(payload, ['ig:v2:public:p:photo:0:photo'], 'sendPhoto',
                                    {'chat_id': '42', 'caption': 'public photo'}, {'message_id': 7, 'file_id': None}, file_size=200)
            value = cache.call_args.args[3]
            self.assertEqual(value['sourceMessage'], {'chatId': 42, 'messageId': 7})
            self.assertNotIn('fileId', value)
        with patch.object(app, 'telegram_call', return_value={'message_id': 9}) as send:
            self.assertTrue(app.reuse_cached_file(payload, 'photo', 'new caption', cached=value))
            self.assertEqual(send.call_args.args[1], 'copyMessage')
            self.assertEqual(send.call_args.kwargs['json_payload']['from_chat_id'], 42)
            self.assertEqual(send.call_args.kwargs['json_payload']['chat_id'], 99)
            self.assertNotIn('photo', send.call_args.kwargs['json_payload'])
        with patch.object(app, 'telegram_call', side_effect=RuntimeError('Bad Request: message to copy not found')), patch.object(app, 'file_cache') as cache:
            self.assertFalse(app.reuse_cached_file(payload, 'photo', cached=value))
            self.assertEqual(cache.call_args.args[1:3], ('delete', 'photo'))

    def test_social_photos_reuse_exact_file_type_after_the_existing_source_check(self):
        entry = {'url': 'https://i.pinimg.com/originals/photo.jpg', 'image': True, 'id': '123'}
        for identity in [{'fileId': 'photo_fixture'}, {'sourceMessage': {'chatId': 42, 'messageId': 7}}]:
            cached = {'method': 'sendPhoto', **identity, 'data': {}, 'fileSize': 100}
            with tempfile.TemporaryDirectory() as directory, patch.object(pipeline, 'social_gallery_entries', return_value=[entry]), \
                 patch.object(app, 'file_cache', return_value=cached), patch.object(pipeline, 'social_prepare_entry') as prepare:
                _, items = pipeline.prepare_social_media({'platform': 'pinterest', 'url': 'https://www.pinterest.com/pin/123/'},
                                                         Path(directory), cache_payload={'cacheUrl': 'fixture'})
                prepare.assert_not_called()
                self.assertEqual(items[0]['method'], 'sendPhoto')
        with tempfile.TemporaryDirectory() as directory, patch.object(pipeline, 'social_gallery_entries', side_effect=app.UserVisibleError('access rejected')), \
             patch.object(app, 'file_cache') as cache:
            with self.assertRaises(app.UserVisibleError):
                pipeline.prepare_social_media({'platform': 'pinterest', 'url': 'https://www.pinterest.com/pin/123/'},
                                              Path(directory), cache_payload={'cacheUrl': 'fixture'})
            cache.assert_not_called()

    def test_reddit_cached_video_skips_download_upload_but_not_access_validation(self):
        payload = self.payload({'mode': 'replay', 'reddit': {'url': 'https://www.reddit.com/comments/abc'}})
        cached = {'method': 'sendVideo', 'fileId': 'reddit_fixture', 'data': {'duration': 2, 'width': 100, 'height': 100}, 'fileSize': 100}
        job = app.InstagramCapture(payload)
        try:
            with patch.object(reddit, 'post_data', return_value=({}, payload['source']['reddit']['url'])), \
                 patch.object(reddit, 'media_items', return_value=[{'kind': 'video', 'url': 'https://v.redd.it/abc/DASHPlaylist.mpd', 'audio': True}]), \
                 patch.object(app, 'file_cache', return_value=cached), patch.object(reddit, 'video_file') as download, \
                 patch.object(app, 'upload_complete_file') as upload, patch.object(app, 'telegram_call', return_value={'message_id': 1}) as send, \
                 patch.object(app, 'delete_status'), patch.object(job, 'safe_status'):
                reddit.prepare(job)
                self.assertTrue(reddit.send(job)['ok'])
                download.assert_not_called(); upload.assert_not_called()
                self.assertEqual(send.call_args.kwargs['json_payload']['video'], 'reddit_fixture')
            with patch.object(reddit, 'post_data', side_effect=app.UserVisibleError('private')), patch.object(app, 'file_cache') as cache:
                with self.assertRaises(app.UserVisibleError): reddit.prepare(job)
                cache.assert_not_called()
        finally:
            job.cleanup()

    def test_bandcamp_reuses_selected_format_only_after_current_public_metadata_validation(self):
        metadata = {'title': 'Song', 'duration': 2, 'formats': [{'format_id': 'mp3-128', 'url': 'https://t4.bcbits.com/stream.mp3',
                    'vcodec': 'none', 'ext': 'mp3', 'abr': 128}]}
        cached = {'method': 'sendAudio', 'fileId': 'audio_fixture', 'data': {}, 'fileSize': 100}
        with tempfile.TemporaryDirectory() as directory, patch.object(bandcamp, 'metadata', return_value=metadata), \
             patch.object(app, 'file_cache', return_value=cached), patch.object(bandcamp, 'download') as download:
            item = bandcamp.prepare_track('https://artist.bandcamp.com/track/song', Path(directory), 1000, time.monotonic()+10,
                                          'mp3-128', cache_payload={'cacheUrl': 'fixture'})
            download.assert_not_called(); self.assertEqual(item['cached']['fileId'], 'audio_fixture')
            with self.assertRaises(app.UserVisibleError):
                bandcamp.prepare_track('https://artist.bandcamp.com/track/song', Path(directory), 1000, time.monotonic()+10,
                                       'flac', cache_payload={'cacheUrl': 'fixture'})
        with tempfile.TemporaryDirectory() as directory, patch.object(bandcamp, 'metadata', side_effect=app.UserVisibleError('private')), \
             patch.object(app, 'file_cache') as cache:
            with self.assertRaises(app.UserVisibleError):
                bandcamp.prepare_track('https://artist.bandcamp.com/track/song', Path(directory), 1000, time.monotonic()+10,
                                       cache_payload={'cacheUrl': 'fixture'})
            cache.assert_not_called()

    def test_pornhub_cache_hit_uses_existing_sender_without_downloading(self):
        payload = {**self.payload({}), 'source': 'pornhub', 'url': 'https://www.pornhub.com/view_video.php?viewkey=phfixture',
                   'mediaCacheKey': 'ph:fixture'}
        with patch.object(app, 'reuse_cached_file', return_value=True), patch.object(pornhub, 'download') as download, \
             patch.object(app, 'send_media_file') as upload, patch.object(app, 'delete_status'):
            self.assertTrue(pornhub.process_job(payload)['cached'])
            download.assert_not_called(); upload.assert_not_called()


if __name__ == '__main__':
    unittest.main()
