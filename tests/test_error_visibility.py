import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app


class ErrorVisibilityTests(unittest.TestCase):
    def test_private_admin_only_and_groups_fail_closed(self):
        for chat in (42, -123, app.ADMIN_USER_ID, str(app.ADMIN_USER_ID)):
            body = {'chat_id': chat, 'text': '❌ نشست منقضی شده', 'parse_mode': 'HTML', 'entities': []}
            safe = app.private_error_payload('editMessageText', body)
            self.assertEqual(safe['text'], body['text'] if str(chat) == str(app.ADMIN_USER_ID) else '⚠️ این قابلیت موقتاً در دسترس نیست؛ مشکل سرویس در حال پیگیری است. کمی بعد دوباره تلاش کن.')
            self.assertEqual(body['text'], '❌ نشست منقضی شده')

    def test_public_message_matches_requested_text(self):
        self.assertEqual(app.PUBLIC_ERROR_MESSAGE, '⚠️ مثل اینکه خطایی پیش اومده، در حال بررسی و پیگیری است، به زودی رفع می‌شود.')

    def test_partial_and_retry_errors_but_not_media_captions(self):
        for text in ('🎵 list\n❌ دریافت نشد: 2', '⏳ تلگرام موقتاً ارسال را متوقف کرده'):
            self.assertNotEqual(app.private_error_payload('editMessageText', {'chat_id': 42, 'text': text})['text'], text)
        body = {'chat_id': 42, 'caption': '❌ song title'}
        self.assertEqual(app.telegram_custom_emoji('sendAudio', body)['caption'], body['caption'])

    def test_telegram_call_masks_before_motion_and_final_send(self):
        class Response:
            ok = True
            def json(self): return {'ok': True, 'result': {}}
        with patch.object(app.requests, 'post', return_value=Response()) as post, patch.object(app, 'telegram_text_motion') as motion:
            app.telegram_call('token', 'editMessageText', json_payload={'chat_id': 42, 'text': '❌ login required'})
            self.assertEqual(motion.call_args.args[2]['text'], app.PUBLIC_ERROR_MESSAGE)
            self.assertEqual(post.call_args.kwargs['json']['text'], app.PUBLIC_ERROR_MESSAGE)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs['json']['chat_id'], 42)

    def test_admin_own_request_keeps_original_error_without_extra_messages(self):
        class Response:
            ok = True
            def json(self): return {'ok': True, 'result': {}}
        with patch.object(app.requests, 'post', return_value=Response()) as post, patch.object(app, 'telegram_text_motion'):
            app.telegram_call('token', 'editMessageText', json_payload={'chat_id': app.ADMIN_USER_ID, 'text': '❌ login required'})
            self.assertEqual(post.call_count, 1)
            self.assertEqual(post.call_args.kwargs['json']['text'], '❌ login required')
            self.assertEqual(post.call_args.kwargs['json']['chat_id'], app.ADMIN_USER_ID)

    def test_style_and_animation_keep_partial_frames_and_final_message(self):
        import json
        body = app.telegram_custom_emoji('editMessageText', {'chat_id': 8484, 'message_id': 77, 'text': '❌ source failed'})
        self.assertEqual(body['text'], app.PUBLIC_ERROR_MESSAGE)
        self.assertEqual([e['custom_emoji_id'] for e in body['entities'] if e['type'] == 'custom_emoji'], ['5447644880824181073'])
        self.assertEqual([body['text'][e['offset']:e['offset']+e['length']] for e in body['entities'] if e['type'] == 'bold'],
                         ['خطایی پیش اومده', 'در حال بررسی و پیگیری', 'به زودی رفع می‌شود'])
        self.assertEqual(app.telegram_custom_emoji('editMessageText', body), body)
        class Response:
            ok = True
            status_code = 200
            def json(self): return {'ok': True, 'result': {}}
        with patch.object(app.requests, 'post', return_value=Response()) as post, patch.object(app.time, 'sleep'):
            app.telegram_call('motion-test-token', 'editMessageText', json_payload=body)
            messages = [c.kwargs['json'] for c in post.call_args_list]
            self.assertEqual(len(messages), 4)
            self.assertTrue(all(m['chat_id'] == 8484 for m in messages))
            self.assertTrue(all(app.PUBLIC_ERROR_MESSAGE.startswith(m['text']) and len(m['text']) < len(app.PUBLIC_ERROR_MESSAGE) for m in messages[:-1]))
            self.assertEqual(messages[-1]['text'], app.PUBLIC_ERROR_MESSAGE)
            self.assertTrue(all('_publicErrorFrame' not in m for m in messages))
        form = app.telegram_custom_emoji('editMessageText', body, form=True)
        self.assertEqual(json.loads(form['entities']), body['entities'])
