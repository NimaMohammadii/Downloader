"""Anonymous Pornhub downloads through the official yt-dlp extractor."""
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import youtube_app as app
import youtube_pipeline as pipeline


class DownloadError(app.UserVisibleError):
    def __init__(self, code: str, phase: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.error_code, self.phase, self.detail = code, phase, detail


def redirect_category(stderr: str) -> str:
    """Describe the HTTP landing page without exposing locations or request headers."""
    # yt-dlp's built-in traffic trace captures Location even when the extractor
    # rejects the final URL. Only an allowlisted category leaves this process.
    locations = re.findall(r"\blocation:\s*([^\s\\'\"<>]+)", stderr, re.I)
    if not locations:
        return ""
    try:
        target = urlparse(locations[-1])
        if target.hostname and not re.fullmatch(
                r"(?:[a-z0-9-]+\.)*pornhub\.(?:com|org|net)", target.hostname, re.I):
            return "external"
        path = target.path.lower()
    except ValueError:
        return "other"
    if path in {"", "/"}:
        return "homepage"
    if any(word in path for word in ("login", "signin", "sign-in")):
        return "login"
    if any(word in path for word in ("age", "verify", "verification", "consent")):
        return "verification"
    if any(word in path for word in ("blocked", "unavailable", "country", "region")):
        return "restricted"
    if "404" in path or "removed" in path:
        return "unavailable"
    return "other"


REDIRECT_MESSAGES = {
    "homepage": "❌ Pornhub این سرور را به صفحهٔ اصلی منتقل کرد؛ ممکن است ویدیو حذف شده یا دسترسی IP سرور محدود باشد.",
    "login": "❌ Pornhub این ویدیو را به صفحهٔ ورود هدایت کرد؛ دسترسی بدون ورود ممکن نیست.",
    "verification": "❌ Pornhub درخواست تأیید دسترسی یا سن دارد؛ دریافت بدون انجام تأیید ممکن نیست.",
    "restricted": "❌ Pornhub دسترسی این سرور یا منطقه به ویدیو را محدود کرده است.",
    "unavailable": "❌ Pornhub ویدیو را به صفحهٔ محتوای حذف‌شده یا ناموجود هدایت کرد.",
    "external": "❌ Pornhub درخواست را به سایت دیگری هدایت کرد؛ دانلود متوقف شد.",
}


def source_error(detail: str) -> tuple[str, str]:
    """Classify extractor output without returning signed URLs or credentials."""
    detail = re.sub(r"https?://[^\s\"'<>]+", "[url]", detail.lower())
    detail = re.sub(r"\b(?:authorization|cookie|sessionid)\b[\"']?\s*[:=]\s*[^\r\n]+", "[redacted]", detail)
    if "redirection detected" in detail:
        return "SOURCE_REDIRECTED", "❌ Pornhub درخواست را به صفحهٔ دیگری هدایت کرد؛ ممکن است تأیید سن یا ورود لازم باشد، یا ویدیو در دسترس نباشد."
    if "filesize" in detail or "max-filesize" in detail:
        return "TELEGRAM_FILE_TOO_LARGE", "❌ حجم این ویدیو از سقف ارسال ۲ گیگابایت تلگرام بیشتر است."
    if "429" in detail or "too many requests" in detail:
        return "SOURCE_RATE_LIMITED", "❌ Pornhub درخواست‌های این سرور را موقتاً محدود کرده؛ کمی بعد امتحان کن."
    if re.search(r"\bhttp error (?:502|503|504)\b", detail):
        return "SOURCE_TEMPORARILY_UNAVAILABLE", "❌ سرویس دریافت از Pornhub موقتاً پاسخ نمی‌دهد؛ کمی بعد امتحان کن."
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
    # yt-dlp's download retries do not cover Pornhub's metadata webpage request.
    # Retry only temporary HTTP failures there, within the original total budget.
    deadline = time.monotonic() + app.job_timeout(timeout)
    for attempt in range(3):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            # Shared runner bounds the process group, including FFmpeg children.
            return pipeline._run(command, remaining)
        except subprocess.TimeoutExpired as exc:
            raise DownloadError("SOURCE_TIMEOUT", phase, "❌ دریافت ویدیو از Pornhub بیش از حد طول کشید؛ دوباره امتحان کن.") from exc
        except subprocess.CalledProcessError as exc:
            stderr = str(exc.stderr or "")
            code, message = source_error(stderr)
            if phase == "metadata" and code == "SOURCE_TEMPORARILY_UNAVAILABLE" and attempt < 2:
                delay = attempt + 1
                if deadline - time.monotonic() > delay:
                    time.sleep(delay)
                    continue
            # Keep one extractor error line; never expose raw HTTP traffic.
            errors = [line.strip() for line in stderr.splitlines() if line.lstrip().startswith("ERROR:")]
            detail = errors[-1] if errors else ""
            if phase == "metadata" and code == "SOURCE_REDIRECTED":
                category = redirect_category(stderr)
                message = REDIRECT_MESSAGES.get(category, message)
                if category:
                    detail = f"{detail} [redirectTarget={category}]"
            raise DownloadError(code, phase, message, detail) from exc


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


def download(url: str, workdir: Path) -> tuple[Path, str]:
    url = video_url(url)
    args = [app.REAL_YTDLP, "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--use-extractors", "PornHub",
            "--compat-options", "no-certifi",
            "--force-ipv4", "--socket-timeout", "15", "--retries", "2", "--fragment-retries", "2"]
    info_path = workdir / "source.info.json"
    for attempt in range(2):
        info = run_source([*args, "--skip-download", "--print-traffic", "--dump-single-json", "--", url],
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
                if path.is_file():
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
