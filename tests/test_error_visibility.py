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
            self.assertEqual(safe['text'], body['text'] if str(chat) == str(app.ADMIN_USER_ID) else app.PUBLIC_ERROR_MESSAGE)
            self.assertEqual(body['text'], '❌ نشست منقضی شده')

    def test_report_failure_does_not_leak_and_report_is_redacted(self):
        with patch.object(app.requests, 'post', side_effect=RuntimeError('offline')) as post:
            safe = app.prepare_error_notice('private-token', 'editMessageText',
                {'chat_id': 42, 'text': '❌ private-token https://signed.example/private'})
            report = post.call_args.kwargs['json']
            self.assertEqual(report['chat_id'], app.ADMIN_USER_ID)
            self.assertNotIn('private-token', report['text'])
            self.assertNotIn('signed.example', report['text'])
            self.assertEqual(safe['text'], app.PUBLIC_ERROR_MESSAGE)

    def test_partial_and_retry_errors_but_not_media_captions(self):
        for text in ('🎵 list\n❌ دریافت نشد: 2', '⏳ تلگرام موقتاً ارسال را متوقف کرده'):
            self.assertEqual(app.private_error_payload('editMessageText', {'chat_id': 42, 'text': text})['text'], app.PUBLIC_ERROR_MESSAGE)
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
            self.assertEqual(post.call_args_list[0].kwargs['json']['chat_id'], app.ADMIN_USER_ID)
