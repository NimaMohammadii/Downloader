"""Test the real pinned extractor plugin in an isolated Python process."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


class PornhubDiagnosticsTests(unittest.TestCase):
    def test_actual_plugin_reports_fixed_categories_and_original_cookie_scope(self):
        root = Path(__file__).resolve().parents[1] / 'container' / 'plugins'
        script = r'''
import json, sys
from types import SimpleNamespace
from unittest.mock import patch
from yt_dlp import YoutubeDL
from yt_dlp.globals import plugin_dirs
plugin_dirs.value = [sys.argv[1]]
from yt_dlp.plugins import load_all_plugins
load_all_plugins()
from yt_dlp_plugins.extractor.pornhub_diagnostics import PornHubIE
from yt_dlp.utils import ExtractorError
from http.cookiejar import Cookie

def run(final, domain=None):
    with YoutubeDL({'quiet': True, 'allowed_extractors': ['PornHub']}) as ydl:
        ie = ydl.get_info_extractor('PornHub')
        assert ie.IE_NAME == 'PornHub+session_diagnostics'
        ie._real_initialize()
        if domain:
            ydl.cookiejar.set_cookie(Cookie(0, 'session', 'PRIVATE_COOKIE', None, False,
                domain, True, True, '/', True, True, None, True, None, None, {'HTTPOnly': ''}))
        result = ('PRIVATE_RESPONSE_BODY', SimpleNamespace(url=final))
        with patch('yt_dlp.extractor.common.InfoExtractor._download_webpage_handle', return_value=result):
            try:
                ie._real_extract('https://www.pornhub.com/view_video.php?viewkey=ph123')
            except ExtractorError as exc:
                value = str(exc)
                assert all(secret not in value for secret in ('PRIVATE_COOKIE', 'PRIVATE_RESPONSE_BODY', 'PRIVATE_QUERY', 'PRIVATE_PATH'))
                return value
        raise AssertionError('expected redirect error')

cases = [
    ('https://www.pornhub.com/login?secret=PRIVATE_QUERY', None, 'login', 'suppliedCookies=0;', 'matchingCookies=no;'),
    ('https://www.pornhub.com/login', '.pornhub.org', 'login', 'suppliedCookies=1;', 'matchingCookies=no;'),
    ('https://www.pornhub.com/login', '.pornhub.com', 'login', 'suppliedCookies=1;', 'matchingCookies=yes;'),
    ('https://www.pornhub.com/age-verification?token=PRIVATE_QUERY', '.pornhub.com', 'age_verification', 'httpOnlyCookies=1;', 'matchingCookies=yes;'),
    ('https://www.pornhub.com/blocked', '.pornhub.com', 'access_restricted', 'suppliedCookies=1;', 'matchingCookies=yes;'),
    ('https://www.pornhub.com/?next=/login', '.pornhub.com', 'homepage', 'suppliedCookies=1;', 'matchingCookies=yes;'),
    ('https://external.test/PRIVATE_PATH?token=PRIVATE_QUERY', '.pornhub.com', 'external', 'suppliedCookies=1;', 'matchingCookies=yes;'),
]
for final, domain, kind, count, matched in cases:
    result = run(final, domain)
    assert f'redirectKind={kind};' in result and count in result and matched in result, result

# A normal response is passed through exactly, without adding requests.
with YoutubeDL({'quiet': True}) as ydl:
    ie = PornHubIE(ydl)
    original = ('UNCHANGED', SimpleNamespace(url='https://www.pornhub.com/view_video.php?viewkey=ph123'))
    with patch('yt_dlp.extractor.common.InfoExtractor._download_webpage_handle', return_value=original) as request:
        assert ie._download_webpage_handle('https://www.pornhub.com/view_video.php?viewkey=ph123', 'ph123') == original
        assert request.call_count == 1
print(json.dumps({'cases': len(cases), 'passed': True}))
'''
        result = subprocess.run([sys.executable, '-c', script, str(root)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'cases': 7, 'passed': True})


if __name__ == '__main__':
    unittest.main()
