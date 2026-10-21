"""Test the real pinned extractor plugin in an isolated Python process."""
import json
from pathlib import Path
import subprocess
import sys
import unittest


class PornhubDiagnosticsTests(unittest.TestCase):
    def test_http_only_count_survives_real_cookie_file_import(self):
        root = Path(__file__).resolve().parents[1] / 'container' / 'plugins'
        script = r'''
import json, os, sys, tempfile, time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(sys.argv[1]).parent))
import pornhub
from yt_dlp import YoutubeDL
from yt_dlp.globals import plugin_dirs
plugin_dirs.value = [sys.argv[1]]
from yt_dlp.plugins import load_all_plugins
load_all_plugins()
from yt_dlp.utils import ExtractorError

entries = [
    {'domain': '.pornhub.com', 'path': '/', 'name': 'session1', 'value': 'PRIVATE_ONE', 'httpOnly': True},
    {'domain': '.pornhub.com', 'path': '/', 'name': 'session2', 'value': 'PRIVATE_TWO', 'httpOnly': True},
    {'domain': '.pornhub.com', 'path': '/', 'name': 'preference', 'value': 'PRIVATE_THREE'},
    {'domain': '.pornhub.com', 'path': '/', 'name': 'expired', 'value': 'PRIVATE_EXPIRED',
     'httpOnly': True, 'expirationDate': int(time.time()) - 60},
    {'domain': '.example.com', 'path': '/', 'name': 'unrelated', 'value': 'PRIVATE_UNRELATED', 'httpOnly': True},
]
netscape = '# Netscape HTTP Cookie File\n' + ''.join(
    '{}{}\tTRUE\t/\tFALSE\t{}\t{}\t{}\n'.format(
        '#HttpOnly_' if entry.get('httpOnly') else '', entry['domain'],
        entry.get('expirationDate', 0), entry['name'], entry['value']) for entry in entries)

for raw in (json.dumps(entries), netscape):
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'PORNHUB_COOKIES': raw}):
        with pornhub.source_cookie_args(Path(directory)) as args:
            with YoutubeDL({'quiet': True, 'allowed_extractors': ['PornHub'], 'cookiefile': args[1]}) as ydl:
                # Exercise the actual file loader, which strips HttpOnly markers.
                assert len(list(ydl.cookiejar)) == 3
                assert not any(c.has_nonstandard_attr('HTTPOnly') for c in ydl.cookiejar)
                header = ydl.cookiejar.get_cookie_header('https://www.pornhub.com/view_video.php')
                assert 'session1=PRIVATE_ONE' in header and 'session2=PRIVATE_TWO' in header
                ie = ydl.get_info_extractor('PornHub')
                ie._real_initialize()
                response = ('PRIVATE_BODY', SimpleNamespace(url='https://www.pornhub.com/'))
                with patch('yt_dlp.extractor.common.InfoExtractor._download_webpage_handle', return_value=response):
                    try:
                        ie._real_extract('https://www.pornhub.com/view_video.php?viewkey=ph123')
                    except ExtractorError as exc:
                        message = str(exc)
                        assert 'httpOnlyCookies=2;' in message, message
                        assert 'suppliedCookies=3;' in message and 'matchingCookies=yes;' in message, message
                        assert 'PRIVATE_' not in message
                    else:
                        raise AssertionError('expected redirect error')
print('passed')
'''
        result = subprocess.run([sys.executable, '-c', script, str(root)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'passed')

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
