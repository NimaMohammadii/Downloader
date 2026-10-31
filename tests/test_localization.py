import concurrent.futures
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
from localization import localize_payload, localized_job, translate

class LocalizationTests(unittest.TestCase):
    def test_public_errors_have_both_translations(self):
        errors = json.loads((Path(__file__).resolve().parents[1] / 'container/public_errors.json').read_text())
        for error in errors:
            for language in ('en', 'ru'):
                self.assertNotEqual(translate(error['message'], language), error['message'])

    def test_dynamic_status(self):
        self.assertEqual(translate('⬇️ دارم ویدیو رو با کیفیت 720p دانلود می‌کنم…', 'en'), '⬇️ Downloading your video in 720p…')
        self.assertEqual(translate('📤 در حال ارسال فایل 2/5 اینستاگرام…', 'ru'), '📤 Отправляю файл Instagram 2/5…')

    def test_context_is_per_job_and_resets(self):
        @localized_job
        def job(payload):
            return localize_payload({'text': '🎵 فقط صدا'})['text']
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(list(pool.map(job, [{'language': 'en'}, {'language': 'ru'}])), ['🎵 Audio only', '🎵 Только звук'])
        self.assertEqual(localize_payload({'text': '🎵 فقط صدا'})['text'], '🎵 فقط صدا')

    def test_buttons_keep_callbacks_and_persian_payload_is_untouched(self):
        payload = {'text': 'سلام', 'reply_markup': {'inline_keyboard': [[{'text': '🎵 فقط صدا', 'callback_data': 'iga|p|code|0|42'}]]}}
        self.assertIs(localize_payload(payload, 'fa'), payload)
        result = localize_payload(payload, 'ru')
        button = result['reply_markup']['inline_keyboard'][0][0]
        self.assertEqual(button['text'], '🎵 Только звук')
        self.assertEqual(button['callback_data'], 'iga|p|code|0|42')

class EmojiPresentationTests(unittest.TestCase):
    def test_requested_custom_emoji_are_used_in_container_text_and_buttons(self):
        import youtube_app
        result = youtube_app.telegram_custom_emoji('sendMessage', {
            'text': '🌐 ✅',
            'reply_markup': {'inline_keyboard': [[{'text': '🌐 Languages', 'callback_data': 'lang'}, {'text': '✅ Done', 'callback_data': 'done'}]]},
        })
        self.assertEqual([(e['offset'], e['length'], e['custom_emoji_id']) for e in result['entities']],
                         [(0, 2, '5282843764451195532'), (3, 1, '5352871660024246779')])
        self.assertEqual([b['icon_custom_emoji_id'] for b in result['reply_markup']['inline_keyboard'][0]],
                         ['5282843764451195532', '5352871660024246779'])


class CompletePresentationTests(unittest.TestCase):
    def test_bot_container_copy_has_no_untranslated_persian(self):
        import ast
        import re
        root = Path(__file__).resolve().parents[1]
        letters = re.compile(r'[\u0621-\u064a\u067e\u0686\u0698\u06a9\u06af\u06cc]')
        for filename in ('youtube_app.py', 'youtube_pipeline.py', 'ai_subtitles.py', 'bandcamp.py', 'reddit.py', 'pornhub.py'):
            tree = ast.parse((root / 'container' / filename).read_text())
            parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
            for node in ast.walk(tree):
                source = None
                if isinstance(node, ast.JoinedStr):
                    source = ''.join(str(v.value) if isinstance(v, ast.Constant) else '7' for v in node.values)
                elif isinstance(node, ast.Constant) and isinstance(node.value, str) and not isinstance(parents.get(node), ast.JoinedStr):
                    source = node.value
                if not source or not letters.search(source):
                    continue
                # Input-normalization tokens and error-classification regexes are protocol data.
                if filename == 'youtube_pipeline.py' and source in {'ريمیکس', 'ریمیکس', 'کاور', 'ي', 'ی', 'ك', 'ک'}:
                    continue
                if source.startswith(r'(?:^|\n)'):
                    continue
                for language in ('en', 'ru'):
                    with self.subTest(file=filename, line=node.lineno, language=language):
                        self.assertFalse(letters.search(translate(source, language)), source)

    def test_form_entities_keep_serialization_offsets_and_custom_progress_icon(self):
        text = '🎬 دارم زیرنویس فارسی رو روی ویدیو قرار می‌دم…\n\n⏳ ~3 min • 20%'
        value = '~3 min • 20%'
        size = lambda s: len(s.encode('utf-16-le')) // 2
        entities = [{'type': 'bold', 'offset': size(text[:text.index(value)]), 'length': size(value)},
                    {'type': 'custom_emoji', 'offset': size(text[:text.index('⏳')]), 'length': 1, 'custom_emoji_id': '5386367538735104399'}]
        payload = {'caption': text, 'caption_entities': json.dumps(entities),
                   'reply_markup': json.dumps({'inline_keyboard': [[{'text': 'فارسی', 'callback_data': 'ytsl|id|8|42|fa'}]]})}
        result = localize_payload(payload, 'ru')
        self.assertIsInstance(result['caption_entities'], str)
        rebuilt = json.loads(result['caption_entities'])
        bold = next(e for e in rebuilt if e['type'] == 'bold')
        raw = result['caption'].encode('utf-16-le')
        self.assertEqual(raw[bold['offset'] * 2:(bold['offset'] + bold['length']) * 2].decode('utf-16-le'), '~3 мин. • 20%')
        self.assertEqual(next(e for e in rebuilt if e['type'] == 'custom_emoji')['custom_emoji_id'], '5386367538735104399')
        self.assertEqual(json.loads(result['reply_markup'])['inline_keyboard'][0][0]['callback_data'], 'ytsl|id|8|42|fa')
        self.assertEqual(payload['caption'], text)

    def test_html_and_content_values_remain_intact(self):
        result = localize_payload({'text': '<b>اینستاگرام — مجموع: 2</b>', 'parse_mode': 'HTML'}, 'en')
        self.assertEqual(result['text'], '<b>Instagram — total: 2</b>')
        self.assertNotIn('entities', result)
        self.assertEqual(translate('عنوان: زیرنویس: فعال', 'ru'), 'Название: زیرنویس: فعال')
        self.assertEqual(translate('نام کاربری: @فارسی', 'en'), 'Username: @فارسی')

class BackgroundStatusLanguageTests(unittest.TestCase):
    def test_actual_music_status_uses_job_language_outside_the_download_thread(self):
        from unittest.mock import patch, Mock
        import youtube_app as app
        for language in ('en', 'ru'):
            job = object.__new__(app.InstagramCapture)
            job.payload = {'botToken': 'fake', 'chatId': 42, 'statusMessageId': 10, 'language': language}
            response = Mock(ok=True)
            response.json.return_value = {'ok': True, 'result': True}
            with patch.object(app.requests, 'post', return_value=response) as post:
                job.status('⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…')
                sent = post.call_args.kwargs['json']
            self.assertEqual(sent['text'], translate('⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…', language))
            self.assertEqual(localize_payload({'text': 'سلام'})['text'], 'سلام')

if __name__ == '__main__':
    unittest.main()
