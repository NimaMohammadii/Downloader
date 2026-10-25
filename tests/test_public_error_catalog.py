import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'container'))
import youtube_app as app

class PublicErrorCatalogTests(unittest.TestCase):
    def test_shared_examples_have_the_same_classification_in_python(self):
        cases = json.loads(Path(__file__).with_name('public-error-cases.json').read_text())
        for case in cases:
            with self.subTest(**case):
                notice = app.public_error(case['input'])
                self.assertEqual(notice['id'], case['category'])
                self.assertEqual(app.public_error(notice['message'])['id'], notice['id'])
                self.assertTrue(all(phrase in notice['message'] for phrase in notice['bold']))
                safe = app.private_error_payload('editMessageText', {'chat_id': 42, 'text': '❌ '+case['input']})
                self.assertEqual(safe['text'], notice['message'])
                self.assertEqual(app.private_error_payload('editMessageText', {'chat_id': app.ADMIN_USER_ID, 'text': '❌ '+case['input']})['text'], '❌ '+case['input'])
