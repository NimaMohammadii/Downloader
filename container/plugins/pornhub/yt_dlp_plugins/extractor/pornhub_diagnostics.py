"""Observe Pornhub redirects without exposing URLs, page contents or cookies."""
import os
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
    def _imported_http_only_count(self, cookies):
        flagged = {(c.domain, c.path, c.name) for c in cookies if c.has_nonstandard_attr('HTTPOnly')}
        # yt-dlp strips #HttpOnly_ when loading Netscape files. The cookie is
        # still sent; recover only its diagnostic flag from the private file.
        cookiefile = self._downloader.params.get('cookiefile')
        if isinstance(cookiefile, (str, os.PathLike)):
            try:
                with open(cookiefile, encoding='utf-8') as handle:
                    for line in handle:
                        if line.startswith('#HttpOnly_'):
                            fields = line[len('#HttpOnly_'):].rstrip('\r\n').split('\t')
                            if len(fields) == 7:
                                flagged.add((fields[0], fields[2], fields[5]))
            except (OSError, UnicodeError):
                # Diagnostics must never break extraction or expose file data.
                pass
        return sum((c.domain, c.path, c.name) in flagged for c in cookies)

    def _real_extract(self, url):
        host = self._match_valid_url(url).group('host') or 'pornhub.com'
        target = f'https://www.{host}/view_video.php'
        cookies = list(self.cookiejar)
        # Snapshot BEFORE upstream adds its own disclaimer/platform cookies.
        self._session_summary = (
            f"suppliedCookies={len(cookies)}; "
            f"matchingCookies={'yes' if self.cookiejar.get_cookie_header(target) else 'no'}; "
            f"httpOnlyCookies={self._imported_http_only_count(cookies)}"
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
