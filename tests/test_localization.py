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

if __name__ == '__main__':
    unittest.main()
