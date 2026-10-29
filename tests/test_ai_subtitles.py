import hashlib
import hmac
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_pipeline as pipeline
import youtube_app as app
import ai_subtitles as subs


class SubtitleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.video = cls.root / 'original.mp4'
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=10',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '4',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(cls.video)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.directory = Path(self.work.name)
        self.path = self.directory / 'video.mp4'
        shutil.copyfile(self.video, self.path)
        self.cache = patch.object(subs, 'CACHE_ROOT', self.directory / 'cache')
        self.cache.start()
        self.payload = {'id': 'test-job', 'userId': 42, 'chatId': 42, 'requestMessageId': 7,
                        'statusMessageId': 8, 'botToken': 'private-bot', 'quality': 360, 'subtitle': 'fa',
                        'url': 'https://www.youtube.com/watch?v=abcdefghijk',
                        'mediaCacheKey': 'yt:abcdefghijk:v360:sub-fa-v1',
                        'elevenApiKey': 'private-eleven', 'gptApiKey': 'private-gpt'}
        self.sign()

    def sign(self):
        p = self.payload
        message = f"subtitle-fa-v1|{p['id']}|{p['userId']}|abcdefghijk|{p['quality']}"
        p['subtitleAuthorization'] = hmac.new(p['botToken'].encode(), message.encode(), hashlib.sha256).hexdigest()

    def tearDown(self):
        self.cache.stop()
        self.work.cleanup()

    class Response:
        def __init__(self, data, status=200):
            self.data = json.dumps(data).encode()
            self.status_code = status
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_content(self, size): yield self.data

    def transcript(self):
        return {'language_code': 'en', 'words': [
            {'type': 'word', 'text': 'Hello!', 'start': 0.2, 'end': 1.5},
            {'type': 'word', 'text': 'Welcome.', 'start': 2, 'end': 3.8}]}

    def translation(self):
        return {'status': 'completed', 'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': json.dumps({'cues': [
                {'id': 0, 'text': 'سلام عزیزم!'}, {'id': 1, 'text': 'به وکسا خوش آمدی.'}]})}]}]}

    def test_real_video_burns_persian_keeps_original_geometry_duration_audio_and_caches_apis(self):
        original = self.path.read_bytes()
        with patch.object(app.requests, 'post', side_effect=[self.Response(self.transcript()), self.Response(self.translation())]) as post:
            output = subs.prepare(self.path, self.payload, lambda text: None)
            second = subs.prepare(self.path, self.payload, lambda text: None)
        self.assertEqual(output, second)
        self.assertEqual(post.call_count, 2)
        calls = post.call_args_list
        self.assertEqual(calls[0].args[0], 'https://api.elevenlabs.io/v1/speech-to-text')
        self.assertEqual(calls[0].kwargs['data']['model_id'], 'scribe_v2')
        self.assertEqual(calls[1].kwargs['json']['model'], 'gpt-6-luna')
        self.assertEqual(calls[1].kwargs['json']['reasoning'], {'effort': 'none'})
        self.assertFalse(calls[1].kwargs['json']['store'])
        for call in calls:
            self.assertFalse(call.kwargs['allow_redirects'])
        self.assertEqual(self.path.read_bytes(), original)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
        self.assertEqual({s['codec_type'] for s in info['streams']}, {'video', 'audio'})
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        self.assertEqual((video['width'], video['height']), (640, 360))
        self.assertLess(abs(float(info['format']['duration']) - 4), 0.1)
        raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', '1', '-i', str(output), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        bright = sum(1 for i in range(0, len(raw), 3) if min(raw[i:i + 3]) > 180)
        self.assertGreater(bright, 100, 'Persian glyphs must be visible on the otherwise blue frame')
        for cache in (self.directory / 'cache').rglob('*'):
            if cache.is_file():
                self.assertNotIn('private-', cache.read_text())

    def test_authorization_and_mode_are_checked_before_download_cache_or_paid_api(self):
        for changed in ({'userId': 43}, {'quality': 720}, {'subtitleAuthorization': '0' * 64},
                        {'audioMode': 'hq'}, {'source': 'pornhub'}, {'subtitle': True},
                        {'mediaCacheKey': 'yt:abcdefghijk:v360'}, {'gptApiKey': ''}):
            with self.subTest(changed=changed), patch.object(app.requests, 'post') as post:
                with self.assertRaises(app.UserVisibleError):
                    subs.prepare(self.path, {**self.payload, **changed}, lambda text: None)
                post.assert_not_called()

    def test_ambiguous_paid_failure_is_not_retried_and_keys_are_not_exposed(self):
        receipt = self.directory / 'request.pending'
        with patch.object(app.requests, 'post', side_effect=RuntimeError('private-eleven private-gpt')) as post:
            for _ in range(2):
                with self.assertRaises(app.UserVisibleError) as failure:
                    subs._paid_post('ElevenLabs', 'https://api.elevenlabs.io/v1/speech-to-text', {}, receipt)
                self.assertNotIn('private-', str(failure.exception))
            post.assert_called_once()

    def test_http_error_reports_only_status_no_provider_body_and_does_not_retry(self):
        for status in (401, 429, 500):
            with self.subTest(status=status), patch.object(app.requests, 'post', return_value=self.Response({'secret': 'private-gpt'}, status)) as post:
                with self.assertRaisesRegex(app.UserVisibleError, f'HTTP {status}') as failure:
                    subs._paid_post('OpenAI', 'https://api.openai.com/v1/responses', {}, self.directory / f'{status}.pending')
                self.assertNotIn('private-', str(failure.exception))
                post.assert_called_once()

    def test_translation_rejects_missing_reordered_ids_refusals_and_incomplete_outputs(self):
        cues = subs._source_cues(self.transcript(), 4)
        for response in ({'status': 'incomplete'}, {'status': 'completed', 'output': []},
                         {'status': 'completed', 'output': [{'type': 'message', 'content': [
                             {'type': 'output_text', 'text': json.dumps({'cues': [{'id': 1, 'text': 'متن'}, {'id': 0, 'text': 'متن'}]})}]}]}):
            with patch.object(subs, '_paid_post', return_value=response):
                with self.assertRaises(app.UserVisibleError): subs._translate(cues, 'key', self.directory, lambda text: None)

    def test_invalid_timestamps_silence_and_nonfinite_values_are_rejected(self):
        for words in ([], [{'type': 'word', 'text': 'x', 'start': -1, 'end': 2}],
                      [{'type': 'word', 'text': 'x', 'start': 0, 'end': float('nan')}],
                      [{'type': 'word', 'text': 'x', 'start': 0, 'end': 100}]):
            with self.assertRaises(app.UserVisibleError): subs._source_cues({'words': words}, 4)

    def test_coincident_sentence_boundaries_preserve_all_words_and_renderable_times(self):
        for second_start in (0.2, 0.201):
            with self.subTest(second_start=second_start):
                words = [
                    {'type': 'word', 'text': 'Hello!', 'start': 0.2, 'end': 1.7},
                    {'type': 'word', 'text': 'Yes.', 'start': second_start, 'end': 0.5},
                    {'type': 'word', 'text': 'Welcome.', 'start': 2, 'end': 3.8},
                ]
                cues = subs._source_cues({'words': words}, 4)
                self.assertEqual([c['text'] for c in cues], ['Hello! Yes.', 'Welcome.'])
                self.assertEqual([c['id'] for c in cues], [0, 1])
                self.assertEqual(cues[0]['end'], 1.7)
                for cue in cues:
                    self.assertLess(round(cue['start'] * 100), round(cue['end'] * 100))
                self.assertLessEqual(cues[0]['end'], cues[1]['start'])

    def test_overlapping_words_keep_longest_end_without_shifting_later_speech(self):
        words = [
            {'type': 'word', 'text': 'Hello', 'start': 0.2, 'end': 1.7},
            {'type': 'word', 'text': 'world.', 'start': 0.3, 'end': 0.5},
            {'type': 'word', 'text': 'Next.', 'start': 2, 'end': 3},
        ]
        cues = subs._source_cues({'words': words}, 4)
        self.assertEqual(cues[0]['end'], 1.7)
        self.assertEqual(cues[1]['start'], 2)

    def test_cached_paid_transcript_can_recover_timing_without_another_scribe_charge(self):
        transcript = self.transcript()
        transcript['words'][1]['start'] = 0.2
        directory = subs.CACHE_ROOT / hashlib.sha256(b'abcdefghijk').hexdigest()
        directory.mkdir(parents=True)
        subs._atomic_json(directory / 'transcribe.json', transcript)
        translated = self.translation()
        translated['output'][0]['content'][0]['text'] = json.dumps(
            {'cues': [{'id': 0, 'text': 'سلام! خوش آمدی.'}]})
        with patch.object(app.requests, 'post', return_value=self.Response(translated)) as post:
            output = subs.prepare(self.path, self.payload, lambda text: None)
        self.assertTrue(output.is_file())
        post.assert_called_once()
        self.assertEqual(post.call_args.args[0], 'https://api.openai.com/v1/responses')

    def test_terminal_timestamp_rounding_keeps_trailing_words_inside_the_video(self):
        for start in (3.999, 4, 4.05):
            with self.subTest(start=start):
                cues = subs._source_cues({'words': [
                    {'type': 'word', 'text': 'Good', 'start': 3, 'end': 3.8},
                    {'type': 'word', 'text': 'bye.', 'start': start, 'end': 4.1},
                ]}, 4)
                self.assertEqual(cues, [{'id': 0, 'start': 3.0, 'end': 4, 'text': 'Good bye.'}])
        with self.assertRaises(app.UserVisibleError):
            subs._source_cues({'words': [
                {'type': 'word', 'text': 'Outside.', 'start': 4, 'end': 4.1}]}, 4)

    def test_ass_cannot_execute_commands_or_load_external_resources(self):
        path = self.directory / 'safe.ass'
        subs._ass([{'start': 0, 'end': 2, 'text': r'{\pos(0,0)} سلام <b>دنیا</b>'}], path)
        output = path.read_text()
        self.assertNotIn(r'\pos', output)
        self.assertNotIn('{', output)
        self.assertNotIn('<b>', output)
        self.assertIn('سلام', output)

    def test_normal_download_never_calls_subtitle_processor(self):
        payload = {k: v for k, v in self.payload.items() if k not in ('subtitle', 'subtitleAuthorization', 'elevenApiKey', 'gptApiKey')}
        payload['mediaCacheKey'] = 'yt:abcdefghijk:v360'
        self._process(payload, expect_subtitles=False)

    def test_subtitles_are_applied_after_existing_download_before_existing_upload(self):
        self._process(self.payload, expect_subtitles=True)

    def test_failed_subtitle_never_uploads_or_caches_the_original_video(self):
        with patch.object(app, 'reuse_cached_file', return_value=False), \
             patch.object(app, 'load_metadata_cache', return_value={'title':'Fixture'}), \
             patch.object(app, 'validate_video_metadata'), patch.object(app, 'available_qualities', return_value=[360]), \
             patch.object(app, 'download_video', return_value=self.path), \
             patch.object(subs, 'prepare', side_effect=app.UserVisibleError('subtitle failed')), \
             patch.object(app, 'send_media_file') as upload, patch.object(app, 'store_uploaded_file') as cache, \
             patch.object(app, 'edit_status'):
            result=app.process_job(self.payload)
        self.assertFalse(result['ok'])
        upload.assert_not_called(); cache.assert_not_called()

    def _process(self, payload, expect_subtitles):
        events = []
        def download(*args): events.append('download'); return self.path
        def prepare(path, request, status): events.append('subtitle'); return self.path
        def send(*args, **kwargs): events.append('upload'); return {'video': {'file_id': 'final'}}
        with patch.object(app, 'reuse_cached_file', return_value=False), \
             patch.object(app, 'load_metadata_cache', return_value={'title': 'Fixture'}), \
             patch.object(app, 'validate_video_metadata'), patch.object(app, 'available_qualities', return_value=[360]), \
             patch.object(app, 'download_video', side_effect=download) as existing_download, \
             patch.object(subs, 'prepare', side_effect=prepare), patch.object(app, 'send_media_file', side_effect=send) as upload, \
             patch.object(app, 'edit_status'), patch.object(app, 'delete_status'), patch.object(app, 'store_uploaded_file') as cache:
            result = app.process_job(payload)
        self.assertTrue(result['ok'])
        self.assertEqual(events, ['download', 'subtitle', 'upload'] if expect_subtitles else ['download', 'upload'])
        existing_download.assert_called_once()
        self.assertEqual('زیرنویس فارسی' in upload.call_args.args[4], expect_subtitles)
        self.assertEqual(cache.call_args.args[1], [payload['mediaCacheKey']])


if __name__ == '__main__': unittest.main()
