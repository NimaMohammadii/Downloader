"""Observe Pornhub redirects without exposing URLs, page contents or cookies."""
import re
from urllib.parse import parse_qs, urlparse

from yt_dlp.extractor.pornhub import PornHubIE as UpstreamPornHubIE
from yt_dlp.utils import ExtractorError


def redirect_kind(url: str) -> str:
    parsed = urlparse(url)
    # Report only a fixed category, never the host/path/query from a response.
    if not re.fullmatch(r"(?:[a-z0-9-]+\.)*pornhub\.(?:com|org|net)", parsed.hostname or "", re.I):
        return "external"
    path = parsed.path.lower().rstrip("/")
    if re.search(r"(?:age[-_]?verif|verify[-_]?age|age[-_]?gate)", path):
        return "age_verification"
    if re.search(r"(?:^|/)(?:login|signin|sign-in)(?:/|$)", path):
        return "login"
    if re.search(r"(?:^|/)(?:blocked|restricted|geo-blocked|disallowed)(?:/|$)", path):
        return "access_restricted"
    return "homepage" if not path else "other"


class PornHubIE(UpstreamPornHubIE, plugin_name="session_diagnostics"):
    def _real_extract(self, url):
        host = self._match_valid_url(url).group('host') or 'pornhub.com'
        target = f'https://www.{host}/view_video.php'
        cookies = list(self.cookiejar)
        # Snapshot BEFORE upstream adds its own disclaimer/platform cookies.
        self._session_summary = (
            f"suppliedCookies={len(cookies)}; "
            f"matchingCookies={'yes' if self.cookiejar.get_cookie_header(target) else 'no'}; "
            f"httpOnlyCookies={sum(c.has_nonstandard_attr('HTTPOnly') for c in cookies)}"
        )
        return super()._real_extract(url)

    def _download_webpage_handle(self, *args, **kwargs):
        result = super()._download_webpage_handle(*args, **kwargs)
        if not result:
            return result
        requested = args[0] if args else kwargs.get('url_or_request', '')
        requested = requested if isinstance(requested, str) else requested.url
        expected = parse_qs(urlparse(requested).query).get('viewkey', [None])[-1]
        final = result[1].url
        if expected and parse_qs(urlparse(final).query).get('viewkey', [None])[-1] != expected:
            kind = redirect_kind(final)
            summary = getattr(self, '_session_summary', 'suppliedCookies=unknown; matchingCookies=unknown')
            raise ExtractorError(
                f'Redirection detected; redirectKind={kind}; {summary}; probe=ph-session-v1', expected=True)
        return result
