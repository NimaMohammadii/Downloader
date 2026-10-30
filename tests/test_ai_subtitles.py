import hashlib
import hmac
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

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
        message = f"subtitle-{p['subtitle']}-v1|{p['id']}|{p['userId']}|abcdefghijk|{p['quality']}"
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
            output = subs.prepare(self.path, self.payload, lambda text, **kwargs: None)
            second = subs.prepare(self.path, self.payload, lambda text, **kwargs: None)
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
                    subs.prepare(self.path, {**self.payload, **changed}, lambda text, **kwargs: None)
                post.assert_not_called()

    def test_all_twelve_languages_have_distinct_authorized_cache_keys(self):
        self.assertEqual(len(subs.LANGUAGES), 12)
        keys = set()
        for language in subs.LANGUAGES:
            self.payload['subtitle'] = language
            self.payload['mediaCacheKey'] = f'yt:abcdefghijk:v360:sub-{language}-v1'
            self.sign()
            subs.authorize(self.payload)
            keys.add(self.payload['mediaCacheKey'])
            with self.assertRaises(app.UserVisibleError):
                subs.authorize({**self.payload, 'subtitle': 'de' if language != 'de' else 'fa'})
        self.assertEqual(len(keys), 12)

    def test_translation_target_and_paid_receipts_are_isolated_by_language(self):
        cues = subs._source_cues(self.transcript(), 4)
        receipts = set()
        for language, details in subs.LANGUAGES.items():
            with patch.object(subs, '_paid_post', return_value=self.translation()) as paid:
                translated = subs._translate(cues, 'key', self.directory, lambda text: None, language)
            call = paid.call_args
            self.assertIn(f"concise {details['target']}.", call.kwargs['json']['instructions'])
            receipts.add(call.args[3])
            self.assertEqual([(c['start'], c['end']) for c in translated], [(c['start'], c['end']) for c in cues])
        self.assertEqual(len(receipts), 12)
        self.assertIn(self.directory / 'translate-0.pending', receipts)

    def test_switching_target_reuses_transcript_but_not_translation(self):
        with patch.object(app.requests, 'post', side_effect=[self.Response(self.transcript()),
                self.Response(self.translation()), self.Response(self.translation())]) as post:
            outputs = []
            for language in ('de', 'hi', 'en'):
                self.payload['subtitle'] = language
                self.payload['mediaCacheKey'] = f'yt:abcdefghijk:v360:sub-{language}-v1'
                self.sign()
                outputs.append(subs.prepare(self.path, self.payload, lambda text, **kwargs: None))
        self.assertEqual(post.call_count, 3, 'One transcript, two translations; English source needs no translation')
        self.assertEqual(len(set(outputs)), 3)
        self.assertEqual(sum('speech-to-text' in c.args[0] for c in post.call_args_list), 1)

    def test_chinese_and_hindi_fonts_render_without_missing_glyphs(self):
        for language, family, text in [('zh', 'CJK', '你好，欢迎观看视频。'),
                                       ('hi', 'Devanagari', 'नमस्ते आपका स्वागत है')]:
            matched = subprocess.check_output(['fc-list', f':lang={language}', 'family'], text=True)
            if family not in matched:
                self.skipTest('Noto fonts are verified by the production image build')
            subtitle = self.directory / f'{language}.ass'
            subs._ass([{'start': 0, 'end': 3, 'text': text}], subtitle, language)
            result = subprocess.run(['ffmpeg', '-v', 'info', '-i', str(self.path), '-vf', f'ass={subtitle}',
                                     '-frames:v', '1', '-f', 'null', '-'], capture_output=True, text=True, check=True)
            self.assertNotIn('not found', result.stderr)
            self.assertIn(family, result.stderr)

    def test_chinese_without_spaces_wraps_within_video_width(self):
        subtitle = self.directory / 'zh.ass'
        subs._ass([{'start': 0, 'end': 3, 'text': '这是一个没有空格的中文字幕测试。' * 4}], subtitle, 'zh')
        line = next(line for line in subtitle.read_text().splitlines() if line.startswith('Dialogue:'))
        text = line.split(',', 9)[-1]
        self.assertGreater(len(text.split(r'\N')), 1)
        self.assertTrue(all(len(part) <= 24 for part in text.split(r'\N')))

    def test_ambiguous_paid_failure_is_not_retried_and_keys_are_not_exposed(self):
        receipt = self.directory / 'request.pending'
        with patch.object(app.requests, 'post', side_effect=RuntimeError('private-eleven private-gpt')) as post:
            for _ in range(2):
                with self.assertRaises(app.UserVisibleError) as failure:
                    subs._paid_post('ElevenLabs', 'https://api.elevenlabs.io/v1/speech-to-text', {}, receipt)
                self.assertNotIn('private-', str(failure.exception))
            post.assert_called_once()

    def test_accounting_measures_only_new_calls_and_keeps_original_owner_on_cache_replay(self):
        from subtitle_usage import replay_charges
        response=self.translation()
        response.update({'model':'gpt-6-luna','service_tier':'default','usage':{'input_tokens':200,
            'input_tokens_details':{'cached_tokens':50,'cache_write_tokens':100},'output_tokens':80}})
        billing={'downloadKey':'youtube:42:7:42','userId':42,'language':'fa'}
        receipt=self.directory/'translate.pending'
        with patch.object(app.USAGE,'subtitle_charge') as publish, patch.object(app.requests,'post',return_value=self.Response(response)) as post:
            first=subs._paid_post('OpenAI','https://api.openai.com/v1/responses',{},receipt,billing=billing,json={'model':'gpt-6-luna'})
            second=subs._paid_post('OpenAI','https://api.openai.com/v1/responses',{},receipt,billing={**billing,'userId':99},json={'model':'gpt-6-luna'})
            post.assert_called_once();self.assertEqual(first,second)
            replay_charges(self.directory)
        events=[c.args[0] for c in publish.call_args_list]
        self.assertEqual([e['state'] for e in events],['pending','measured','measured'])
        self.assertEqual(len({e['key'] for e in events}),1)
        self.assertTrue(all(e['userId']==42 for e in events))
        self.assertEqual(events[-1]['cachedInputTokens'],50)
        self.assertEqual(events[-1]['cacheWriteTokens'],100)
        self.assertNotIn('cues',json.dumps(events))

    def test_accounting_reports_unknown_failure_and_does_not_block_success(self):
        billing={'downloadKey':'youtube:42:7:42','userId':42,'language':'fa'}
        with patch.object(app.USAGE,'subtitle_charge') as publish, patch.object(app.requests,'post',side_effect=OSError('private-key')) as post:
            for _ in range(2):
                with self.assertRaises(app.UserVisibleError):
                    subs._paid_post('OpenAI','https://api.openai.com/v1/responses',{},self.directory/'bad.pending',billing=billing,json={'model':'gpt-6-luna'})
            post.assert_called_once()
            self.assertEqual(publish.call_args.args[0]['state'],'unknown')
            self.assertNotIn('private-key',json.dumps(publish.call_args.args[0]))
        with patch.object(app.USAGE,'subtitle_charge',side_effect=RuntimeError('telemetry unavailable')), \
             patch.object(app.requests,'post',return_value=self.Response({'ok':True})):
            self.assertEqual(subs._paid_post('OpenAI','https://api.openai.com/v1/responses',{},self.directory/'good.pending',billing=billing,json={'model':'gpt-6-luna'}),{'ok':True})

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
                with self.assertRaises(app.UserVisibleError): subs._translate(cues, 'key', self.directory, lambda text, **kwargs: None)

    def test_translation_failure_diagnostics_identify_reason_without_logging_dialogue_or_keys(self):
        cues = subs._source_cues(self.transcript(), 4)
        def output(items):
            return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'cues':items})}]}]}
        cases=[({'status':'incomplete'},'response_not_completed'),
            ({'status':'completed','output':[]},'missing_output_text'),
            ({'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':'PRIVATE-DIALOGUE'}]}]},'refusal'),
            (output([]),'cue_count'),(output([{'id':1,'text':'PRIVATE-DIALOGUE'},{'id':0,'text':'x'}]),'cue_id'),
            (output([{'id':0,'text':''},{'id':1,'text':'PRIVATE-DIALOGUE'}]),'cue_text')]
        for response,reason in cases:
            with self.subTest(reason=reason),patch.object(subs,'_paid_post',return_value=response),patch('builtins.print') as log:
                with self.assertRaises(app.UserVisibleError):
                    subs._translate(cues,'PRIVATE-API-KEY',self.directory,lambda text:None)
                event=json.loads(log.call_args.args[0])
                self.assertEqual(event['reason'],reason)
                self.assertEqual(event['expectedCues'],len(cues))
                self.assertNotIn('PRIVATE',json.dumps(event))

    def test_invalid_timestamps_silence_and_nonfinite_values_are_rejected(self):
        for words in ([], [{'type': 'word', 'text': 'x', 'start': -1, 'end': 2}],
                      [{'type': 'word', 'text': 'x', 'start': 0, 'end': float('nan')}],
                      [{'type': 'word', 'text': 'x', 'start': 0, 'end': 100}]):
            with self.assertRaises(app.UserVisibleError): subs._source_cues({'words': words}, 4)

    def test_progress_uses_measured_speed_every_15_seconds_and_exact_entities(self):
        status = Mock()
        with patch.object(subs.time, 'monotonic', return_value=100) as clock:
            report = subs._RenderProgress(600, status)
            clock.return_value = 101
            report({'out_time_us': '0'})
            clock.return_value = 114
            report({'out_time_us': '14000000'})
            status.assert_not_called()
            clock.return_value = 115
            report({'out_time_us': '15000000'})
            self.assertEqual(status.call_count, 1)
            text = status.call_args.args[0]
            self.assertTrue(text.endswith('⏳ ~10 min • 2%'))
            for e in status.call_args.kwargs['entities']:
                part = text.encode('utf-16-le')[e['offset'] * 2:(e['offset'] + e['length']) * 2].decode('utf-16-le')
                if e['type'] == 'bold': self.assertEqual(part, '~10 min • 2%')
                else:
                    self.assertEqual(part, '⏳')
                    self.assertEqual(e['custom_emoji_id'], '5386367538735104399')
            clock.return_value = 129
            report({'out_time_us': '29000000'})
            self.assertEqual(status.call_count, 1)
            clock.return_value = 130
            report({'out_time_us': '30000000'})
            self.assertEqual(status.call_count, 2)
            # Slower processing revises the estimate, rather than counting down.
            clock.return_value = 190
            report({'out_time_us': '31000000'})
            self.assertNotIn('~10 min', status.call_args.args[0])
            clock.return_value = 205
            report({'out_time_us': '600000000', 'progress': 'end'})
            self.assertIn('99%', status.call_args.args[0])
            self.assertNotIn('100%', status.call_args.args[0])
            count = status.call_count
            for value in ('nan', 'inf', '-1', 'bad', '1000'):
                report({'out_time_us': value})
            self.assertEqual(status.call_count, count)

    def test_native_progress_preserves_job_context_and_edit_errors_do_not_stop_encoding(self):
        seen = []
        token = app.JOB_DEADLINE.set(12345)
        try:
            def progress(record):
                seen.append((record['out_time_us'], app.JOB_DEADLINE.get()))
                raise RuntimeError('status failure')
            with patch('builtins.print'):
                subs._run_progress([sys.executable, '-c',
                    "import time; print('out_time_us=1000000\\nprogress=continue', flush=True); time.sleep(.1)"], 2, progress)
            self.assertEqual(seen, [('1000000', 12345)])
        finally:
            app.JOB_DEADLINE.reset(token)

    def test_native_progress_timeout_kills_and_reaps_child(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            subs._run_progress([sys.executable, '-c', 'import time; time.sleep(30)'], .1, lambda record: None)
        self.assertLess(time.monotonic() - started, 2)

    def test_real_ffmpeg_emits_native_media_timestamps(self):
        records = []
        subs._ffmpeg(['-re', '-i', str(self.path), '-t', '0.5', '-vf', 'null',
                      '-f', 'null', '-'], 5, progress=records.append)
        self.assertTrue(any('out_time_us' in record for record in records))

    def test_analysis_message_has_requested_custom_emoji_and_no_provider_branding(self):
        status = Mock()
        with patch.object(app.requests, 'post', side_effect=[self.Response(self.transcript()), self.Response(self.translation())]):
            subs.prepare(self.path, self.payload, status)
        texts = [c.args[0] for c in status.call_args_list]
        self.assertFalse(any('Eleven' in text or 'تبدیل می‌کنم' in text for text in texts))
        first = status.call_args_list[0]
        self.assertIn('تحلیل', first.args[0])
        self.assertEqual(first.kwargs['entities'][0]['custom_emoji_id'], '5271604874419647061')
        self.assertIn('در حال محاسبه', next(t for t in texts if 'محاسبه' in t))

    def test_ffmpeg_timeout_and_encoder_failure_are_distinct_without_exposing_output(self):
        for error, reason, text in (
            (subprocess.TimeoutExpired(['private-command'], 1, stderr=b'private-key'), 'timeout', 'زمان آماده'),
            (subprocess.CalledProcessError(1, ['private-command'], stderr=b'private-key'), 'CalledProcessError', 'کامل نشد'),
        ):
            with self.subTest(reason=reason), patch.object(subprocess, 'run', side_effect=error) as run, \
                 patch('builtins.print') as log:
                with self.assertRaisesRegex(app.UserVisibleError, text):
                    subs._ffmpeg(['-vf', 'ass=private-path'], 1)
                run.assert_called_once()
                entries = [json.loads(c.args[0]) for c in log.call_args_list]
                self.assertEqual(entries[-1]['reason'], reason)
                self.assertNotIn('private-', str(log.call_args_list))

    def test_render_uses_remaining_job_budget_and_reserves_upload_time(self):
        saved = subs.CACHE_ROOT / hashlib.sha256(b'abcdefghijk').hexdigest()
        saved.mkdir(parents=True)
        subs._atomic_json(saved / 'transcript.json', {'language': 'fa', 'cues': [
            {'id': 0, 'start': 0, 'end': 3, 'text': 'سلام'}]})
        def render(args, timeout, **kwargs):
            self.assertEqual(timeout, 420)
            self.assertEqual(args[args.index('-preset') + 1], 'superfast')
            self.assertEqual(args[args.index('-crf') + 1], '23')
            shutil.copyfile(self.path, args[-1])
        with patch.object(app, 'job_timeout', return_value=600), patch.object(subs, '_ffmpeg', side_effect=render), \
             patch.object(app.requests, 'post') as post:
            subs.prepare(self.path, self.payload, lambda text, **kwargs: None)
        post.assert_not_called()

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
            output = subs.prepare(self.path, self.payload, lambda text, **kwargs: None)
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
        def prepare(path, request, status):
            events.append('subtitle')
            status('⏳ ~8 min • 42%', entities=[{'type': 'custom_emoji', 'offset': 0, 'length': 1,
                                               'custom_emoji_id': subs.RENDER_EMOJI}])
            return self.path
        def send(*args, **kwargs): events.append('upload'); return {'video': {'file_id': 'final'}}
        with patch.object(app, 'reuse_cached_file', return_value=False), \
             patch.object(app, 'load_metadata_cache', return_value={'title': 'Fixture'}), \
             patch.object(app, 'validate_video_metadata'), patch.object(app, 'available_qualities', return_value=[360]), \
             patch.object(app, 'download_video', side_effect=download) as existing_download, \
             patch.object(subs, 'prepare', side_effect=prepare), patch.object(app, 'send_media_file', side_effect=send) as upload, \
             patch.object(app, 'edit_status'), patch.object(app, 'delete_status'), \
             patch.object(app, 'telegram_call') as formatted_status, patch.object(app, 'store_uploaded_file') as cache:
            result = app.process_job(payload)
        self.assertTrue(result['ok'])
        self.assertEqual(events, ['download', 'subtitle', 'upload'] if expect_subtitles else ['download', 'upload'])
        existing_download.assert_called_once()
        self.assertEqual('زیرنویس فارسی' in upload.call_args.args[4], expect_subtitles)
        self.assertEqual(cache.call_args.args[1], [payload['mediaCacheKey']])
        if expect_subtitles:
            formatted_status.assert_called_once()
            self.assertEqual(formatted_status.call_args.args[1], 'editMessageText')
            self.assertEqual(formatted_status.call_args.kwargs['timeout'], 5)
            body = formatted_status.call_args.kwargs['json_payload']
            self.assertEqual(body['message_id'], payload['statusMessageId'])
            self.assertEqual(body['entities'][0]['custom_emoji_id'], subs.RENDER_EMOJI)
        else:
            formatted_status.assert_not_called()


if __name__ == '__main__': unittest.main()
