"""Single-video Pornhub downloads using the shared complete-file Telegram sender."""
import json
import hashlib
import hmac
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import warnings
from contextlib import contextmanager
from http.cookiejar import Cookie, LoadError, MozillaCookieJar
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import youtube_app as app
import youtube_pipeline as pipeline

_COOKIE_LOAD_LOCK = threading.Lock()


class DownloadError(app.UserVisibleError):
    def __init__(self, code: str, phase: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.error_code, self.phase, self.detail = code, phase, detail
        self.source_diagnostics = None


def source_diagnostics(stderr: str) -> dict | None:
    match = re.search(
        r"Redirection detected; redirectKind=(login|age_verification|access_restricted|homepage|external|other); "
        r"suppliedCookies=(\d{1,6}); matchingCookies=(yes|no); httpOnlyCookies=(\d{1,6}); probe=(ph-session-v[12])(?:\s|$)", stderr)
    if not match:
        return None
    kind, count, matching, http_only, probe_version = match.groups()
    return {"probeVersion": probe_version, "redirectKind": kind,
            "suppliedCookieCount": int(count), "matchingCookies": matching == "yes",
            "httpOnlyCookieCount": int(http_only)}


def source_error(detail: str) -> tuple[str, str]:
    """Classify extractor output without returning signed URLs or credentials."""
    detail = re.sub(r"https?://[^\s\"'<>]+", "[url]", detail.lower())
    detail = re.sub(r"\b(?:authorization|cookie|sessionid)\b[\"']?\s*[:=]\s*[^\r\n]+", "[redacted]", detail)
    if "filesize" in detail or "max-filesize" in detail:
        return "TELEGRAM_FILE_TOO_LARGE", "❌ حجم این ویدیو از سقف ارسال ۲ گیگابایت تلگرام بیشتر است."
    if "429" in detail or "too many requests" in detail:
        return "SOURCE_RATE_LIMITED", "❌ Pornhub درخواست‌های این سرور را موقتاً محدود کرده؛ کمی بعد امتحان کن."
    if "redirection detected" in detail:
        if "suppliedcookies=0;" in detail:
            return "SOURCE_SESSION_MISSING", "❌ سرور دانلود بدون کوکی نشست به Pornhub وصل شد؛ تنظیمات نشست باید روی همین سرور اعمال شود."
        if "matchingcookies=no;" in detail:
            return "SOURCE_SESSION_DOMAIN_MISMATCH", "❌ کوکی‌های ذخیره‌شده برای دامنه یا مسیر این لینک ارسال نمی‌شوند؛ از همان دامنهٔ لینک خروجی کوکی بگیر."
        if "redirectkind=age_verification;" in detail:
            return "SOURCE_AGE_VERIFICATION_REQUIRED", "❌ Pornhub سرور را به صفحهٔ تأیید سن هدایت کرد؛ تأیید نشست از این سرور پذیرفته نشده است."
        if "redirectkind=login;" in detail:
            return "SOURCE_AUTH_REQUIRED", "❌ Pornhub سرور را به صفحهٔ ورود هدایت کرد؛ نشست ورود از این سرور پذیرفته نشده است."
        if "redirectkind=access_restricted;" in detail:
            return "SOURCE_ACCESS_RESTRICTED", "❌ Pornhub سرور را به صفحهٔ محدودیت دسترسی هدایت کرد؛ ممکن است محدودیت منطقه یا دسترسی سرور باشد."
        return "SOURCE_REDIRECTED", "❌ Pornhub درخواست را به صفحهٔ دیگری هدایت کرد؛ ممکن است تأیید سن یا ورود لازم باشد، یا ویدیو در دسترس نباشد."
    if any(word in detail for word in ("requested format is not available", "no video formats", "only images")):
        return "SOURCE_FORMAT_UNAVAILABLE", "❌ فرمت قابل دانلود این ویدیوی Pornhub دریافت نشد."
    if any(word in detail for word in ("private", "removed", "video unavailable", "404", "not available")):
        return "SOURCE_UNAVAILABLE", "❌ این ویدیوی Pornhub خصوصی، حذف‌شده یا در دسترس نیست."
    if "403" in detail or "410" in detail:
        return "SOURCE_LINK_REJECTED", "❌ Pornhub دسترسی این سرور به فایل ویدیو را نپذیرفت."
    if any(word in detail for word in ("login", "sign in", "age verification", "confirm your age")):
        return "SOURCE_AUTH_REQUIRED", "❌ Pornhub برای این ویدیو ورود یا تأیید دسترسی می‌خواهد."
    if "certificate_verify_failed" in detail or "certificate verify failed" in detail:
        return "SOURCE_TLS_ERROR", "❌ برقراری ارتباط امن با Pornhub انجام نشد."
    return "SOURCE_DOWNLOAD_FAILED", "❌ دریافت ویدیو از Pornhub کامل نشد؛ دوباره امتحان کن."


def run_source(command: list[str], timeout: int, phase: str) -> subprocess.CompletedProcess[str]:
    try:
        # Shared runner bounds the entire process group, including FFmpeg children.
        return pipeline._run(command, timeout)
    except subprocess.TimeoutExpired as exc:
        raise DownloadError("SOURCE_TIMEOUT", phase, "❌ دریافت ویدیو از Pornhub بیش از حد طول کشید؛ دوباره امتحان کن.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = str(exc.stderr or "")
        code, message = source_error(stderr)
        # Keep one extractor error line for diagnosis, never its command or a
        # provider response dump. The job boundary redacts secrets and URLs.
        errors = [line.strip() for line in stderr.splitlines() if line.lstrip().startswith("ERROR:")]
        error = DownloadError(code, phase, message, errors[-1] if errors else "")
        error.source_diagnostics = source_diagnostics(stderr)
        raise error from exc


def video_url(value: str) -> str:
    try:
        url = urlparse(value)
        if (url.scheme not in {"http", "https"} or url.username or url.password or url.port
                or not re.fullmatch(r"(?:[a-z0-9-]+\.)*pornhub\.(?:com|org|net)", url.hostname or "", re.I)):
            raise ValueError()
        embed = re.fullmatch(r"/embed/([A-Za-z0-9_-]+)/?", url.path)
        key = parse_qs(url.query).get("viewkey", [""])[0] if url.path == "/view_video.php" else embed[1] if embed else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key):
            raise ValueError()
        return f"https://{url.hostname.lower()}/view_video.php?viewkey={key}"
    except ValueError as exc:
        raise app.UserVisibleError("❌ لینک مستقیم ویدیوی Pornhub معتبر نیست.") from exc


def session_error(reason: str, message: str) -> DownloadError:
    # Only fixed reason tags leave this parser; exceptions may contain cookie rows.
    return DownloadError("SOURCE_SESSION_INVALID", "configuration", message,
                         f"cookieExportReason={reason}")


def cookie_domain(domain: str) -> bool:
    return bool(re.fullmatch(r"(?:[a-z0-9-]+\.)*pornhub\.(?:com|org|net)", domain.removeprefix("."), re.I))


def json_cookie_jar(raw: str, path: Path) -> MozillaCookieJar:
    """Convert browser exports locally, preserving domain scope and real expiry."""
    try:
        entries = json.loads(raw)
        if isinstance(entries, dict):
            entries = entries.get("cookies")
        if not isinstance(entries, list):
            raise ValueError()
        jar = MozillaCookieJar(str(path))
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("domain"), str):
                raise ValueError()
            domain = entry["domain"].lower()
            if not cookie_domain(domain):
                continue
            name, value, cookie_path = entry.get("name"), entry.get("value"), entry.get("path", "/")
            if (not all(isinstance(field, str) for field in (name, value, cookie_path))
                    or not name or not cookie_path.startswith("/")
                    or any(re.search(r"[\x00-\x1f\x7f]", field) for field in (name, value, cookie_path))):
                raise ValueError()
            for flag in ("hostOnly", "secure", "httpOnly", "session"):
                if flag in entry and not isinstance(entry[flag], bool):
                    raise ValueError()
            if "hostOnly" in entry:
                domain = domain.removeprefix(".") if entry["hostOnly"] else "." + domain.removeprefix(".")
            expires = entry.get("expirationDate", entry.get("expires"))
            if isinstance(expires, bool):
                raise ValueError()
            if entry.get("session") or expires is None or expires == "" or expires == 0:
                expires = None
            else:
                if not math.isfinite(float(expires)):
                    raise ValueError()
                expires = int(float(expires))
            jar.set_cookie(Cookie(0, name, value, None, False, domain, domain.startswith("."),
                                  domain.startswith("."), cookie_path, True, entry.get("secure", False),
                                  expires, expires is None, None, None,
                                  {"HTTPOnly": ""} if entry.get("httpOnly") else {}))
        return jar
    except (ValueError, TypeError, OverflowError):
        raise session_error("json_invalid", "❌ خروجی JSON کوکی Pornhub ناقص یا نامعتبر است؛ محتوای کامل خروجی کوکی‌ها را در PORNHUB_COOKIES قرار بده.") from None


@contextmanager
def source_cookie_args(workdir: Path):
    """Use an operator-provided session; never synthesize verification cookies."""
    raw = os.environ.get("PORNHUB_COOKIES", "")
    if not raw.strip():
        yield []
        return
    # Clipboard exports can include a BOM and leading blank lines. Preserve
    # trailing tabs/values: stripping the whole file corrupts empty values.
    raw = raw.lstrip("\ufeff \t\r\n")
    path = workdir / "source.cookies.txt"
    try:
        try:
            # Each concurrent job owns its cookie jar, including yt-dlp updates.
            with open(path, "x", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
                if not raw.startswith(("[", "{")):
                    handle.write(raw)
            if raw.startswith(("[", "{")):
                jar = json_cookie_jar(raw, path)
            else:
                if not raw.startswith("#"):
                    raise session_error("format_unknown", "❌ قالب کوکی Pornhub شناخته نشد؛ محتوای کامل خروجی Netscape cookies.txt یا JSON را در PORNHUB_COOKIES قرار بده.")
                jar = MozillaCookieJar(str(path))
                try:
                    # cookiejar's malformed-input warning can contain a full secret row.
                    with _COOKIE_LOAD_LOCK, warnings.catch_warnings():
                        warnings.simplefilter("ignore", UserWarning)
                        jar.load(ignore_discard=True, ignore_expires=True)
                except (LoadError, ValueError):
                    raise session_error("netscape_invalid", "❌ قالب فایل cookies.txt معتبر نیست؛ محتوای کامل فایل با خط اول و جداکننده‌های اصلی را وارد کن، یا خروجی JSON بگیر.") from None
            for cookie in list(jar):
                if not cookie_domain(cookie.domain):
                    jar.clear(cookie.domain, cookie.path, cookie.name)
                elif cookie.expires == 0:
                    # Browser exports and yt-dlp also use zero for session cookies.
                    cookie.expires, cookie.discard = None, True
            if not list(jar):
                raise session_error("no_pornhub_cookies", "❌ کوکیِ دامنه‌های Pornhub در این خروجی پیدا نشد؛ پس از ورود و تأیید سن، از همان سایت خروجی تازه بگیر.")
            if not any(not cookie.is_expired() for cookie in jar):
                raise session_error("all_expired", "❌ همهٔ کوکی‌های Pornhub در این خروجی منقضی شده‌اند؛ از نشست فعلی مرورگر خروجی تازه بگیر.")
            jar.save(ignore_discard=True, ignore_expires=False)
        except OSError:
            raise DownloadError("SOURCE_SESSION_STORAGE_ERROR", "configuration",
                                "❌ آماده‌سازی فایل موقت نشست Pornhub روی سرور ناموفق بود.") from None
        yield ["--cookies", str(path)]
    finally:
        path.unlink(missing_ok=True)


def download(url: str, workdir: Path) -> tuple[Path, str]:
    url = video_url(url)
    with source_cookie_args(workdir) as cookies:
        return _download(url, workdir, cookies)


def _download(url: str, workdir: Path, cookies: list[str]) -> tuple[Path, str]:
    args = [app.REAL_YTDLP, "--ignore-config", "--no-playlist", "--use-extractors", "PornHub",
            "--plugin-dirs", str(Path(__file__).resolve().parent / "plugins"),
            "--compat-options", "no-certifi",
            "--force-ipv4", "--socket-timeout", "15", "--retries", "2", "--fragment-retries", "2", *cookies]
    info_path = workdir / "source.info.json"
    for attempt in range(2):
        info = run_source([*args, "--skip-download", "--dump-single-json", "--", url],
                          app.METADATA_TIMEOUT_SECONDS, "metadata")
        try:
            metadata = json.loads(info.stdout)
            if not isinstance(metadata, dict):
                raise ValueError("metadata must be an object")
        except ValueError as exc:
            raise DownloadError("SOURCE_INVALID_METADATA", "metadata", "❌ اطلاعات ویدیوی Pornhub کامل دریافت نشد.") from exc
        app.validate_video_metadata(metadata)
        # Keep the exact catalog/headers just extracted; do not hit the webpage twice.
        with open(info_path, "w", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
            json.dump(metadata, handle)
        try:
            result = run_source([
                *args, "--abort-on-unavailable-fragments", "--max-filesize", str(app.DIRECT_TELEGRAM_LIMIT),
                "--concurrent-fragments", "8", "--format", "bv*+ba/b",
                "--format-sort", "res,+codec:avc:m4a,ext:mp4:m4a",
                "--merge-output-format", "mp4", "--remux-video", "mp4", "--no-simulate", "--quiet",
                "--output", str(workdir / "Pornhub.%(ext)s"), "--print", "after_move:%(filepath)s",
                "--load-info-json", str(info_path),
            ], app.DOWNLOAD_TIMEOUT_SECONDS, "download")
            break
        except DownloadError as exc:
            # Refresh rejected/expired CDN links once, before any Telegram publish.
            if attempt or exc.error_code != "SOURCE_LINK_REJECTED":
                raise
            for path in workdir.iterdir():
                if path.is_file() and path.name != "source.cookies.txt":
                    path.unlink()

    path = app.result_path(result, workdir)
    if path is None or path.suffix.lower() != ".mp4":
        code, message = source_error(str(result.stderr or ""))
        if code != "TELEGRAM_FILE_TOO_LARGE":
            code, message = "SOURCE_MISSING_FILE", "❌ فایل ویدیوی Pornhub پس از دانلود پیدا نشد."
        raise DownloadError(code, "validation", message)
    size = path.stat().st_size
    if not 0 < size <= app.DIRECT_TELEGRAM_LIMIT:
        raise DownloadError("TELEGRAM_FILE_TOO_LARGE" if size else "SOURCE_EMPTY_FILE", "validation",
                            "❌ فایل ویدیو خالی است یا از سقف ارسال ۲ گیگابایت تلگرام بیشتر است.")
    try:
        expected = float(metadata.get("duration") or 0)
    except (TypeError, ValueError):
        expected = 0
    duration = app.probe_duration(path)
    if (not pipeline._probe_geometry(path) or not math.isfinite(duration) or duration <= 0
            or (math.isfinite(expected) and expected > 0 and duration < expected - 2)):
        raise DownloadError("SOURCE_INCOMPLETE_FILE", "validation", "❌ ویدیوی Pornhub کامل دریافت نشد؛ فایل ناقص ارسال نشد.")
    return path, str(metadata.get("title") or "Pornhub video").strip()


def process_job(payload: dict) -> dict:
    token = str(payload.get("botToken") or "")
    chat_id = int(payload["chatId"])
    message_id = int(payload["requestMessageId"])
    status_id = payload.get("statusMessageId")
    workdir = Path(tempfile.mkdtemp(prefix="pornhub-download-"))
    deadline = time.monotonic() + app.YOUTUBE_JOB_SECONDS
    inherited_deadline = app.JOB_DEADLINE.get()
    deadline_token = app.JOB_DEADLINE.set(min(deadline, inherited_deadline) if inherited_deadline is not None else deadline)
    phase = "download"

    def status(message: str) -> None:
        try:
            app.edit_status(token, chat_id, status_id, message)
        except Exception as exc:
            print(json.dumps({"message": "pornhub status update failed", "jobId": payload.get("id"),
                              "phase": phase, **app.upload_error_diagnostic(exc, token)}, ensure_ascii=False), flush=True)

    try:
        if not token:
            raise ValueError("Missing bot token")
        expected_tag = payload.get("pornhubSessionTag")
        if expected_tag is not None:
            actual_tag = hmac.new(token.encode(),
                                  ("pornhub-session:" + os.environ.get("PORNHUB_COOKIES", "")).encode(),
                                  hashlib.sha256).hexdigest()
            if (not isinstance(expected_tag, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_tag)
                    or not hmac.compare_digest(expected_tag, actual_tag)):
                raise DownloadError("SOURCE_SESSION_STALE", "configuration",
                                    "❌ نشست جدید هنوز به سرور دانلود نرسیده؛ پس از پایان کارها و راه‌اندازی مجدد سرور، دوباره امتحان کن.",
                                    "cookieExportReason=runtime_session_stale")
        path, title = download(str(payload.get("url") or ""), workdir)
        status("📤 ویدیوی Pornhub آماده شد؛ دارم می‌فرستم…")
        app.job_timeout(1800)  # Expired downloads must never start publishing.
        phase = "upload"
        app.send_media_file(token, chat_id, message_id, path, title, reply=True)
        app.delete_status(token, chat_id, status_id)
        return {"ok": True, "parts": 1, "title": title}
    except Exception as exc:
        app.JOB_DEADLINE.set(None)  # Use the Workflow's reserved error-reporting time.
        phase = getattr(exc, "phase", phase)
        diagnostic = app.upload_error_diagnostic(exc, token)
        if isinstance(exc, DownloadError):
            diagnostic["errorCode"] = exc.error_code
            if exc.source_diagnostics:
                diagnostic["sourceDiagnostics"] = exc.source_diagnostics
            if exc.detail:
                diagnostic["diagnostic"] = app.upload_error_diagnostic(RuntimeError(exc.detail), token)["diagnostic"]
        print(json.dumps({"message": "pornhub job failed", "jobId": payload.get("id"),
                          "phase": phase, **diagnostic}, ensure_ascii=False), flush=True)
        message = (str(exc) if isinstance(exc, app.UserVisibleError) else app.telegram_flood_message(diagnostic)
                   or ("❌ ارسال فایل در تلگرام تأیید نشد؛ اگر فایلی دریافت کرده‌ای، پیش از درخواست دوباره بررسی کن."
                       if phase == "upload" else "❌ دریافت ویدیوی Pornhub کامل نشد؛ دوباره امتحان کن."))
        status(message)
        return {"ok": False, "message": message, "phase": phase, **diagnostic}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        app.JOB_DEADLINE.reset(deadline_token)
