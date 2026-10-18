"""Single-video Pornhub downloads using the shared complete-file Telegram sender."""
import json
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import youtube_app as app


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
    args = [app.REAL_YTDLP, "--ignore-config", "--no-playlist", "--use-extractors", "PornHub",
            "--force-ipv4", "--socket-timeout", "15", "--retries", "2", "--fragment-retries", "2"]
    try:
        info = subprocess.run([*args, "--skip-download", "--dump-single-json", "--", url],
                              capture_output=True, text=True, check=True, timeout=app.METADATA_TIMEOUT_SECONDS)
        metadata = json.loads(info.stdout)
        app.validate_video_metadata(metadata)
        expected = float(metadata.get("duration") or 0)
        if not math.isfinite(expected) or expected <= 0:
            raise app.UserVisibleError("❌ مدت ویدیوی Pornhub مشخص نیست؛ دانلود کامل قابل بررسی نیست.")
        result = subprocess.run([
            *args, "--abort-on-unavailable-fragments", "--max-filesize", str(app.DIRECT_TELEGRAM_LIMIT),
            "--concurrent-fragments", "8", "--format", "bv*[height<=1080]+ba/b[height<=1080]", "--format-sort", "res:1080,+codec:avc:m4a,ext:mp4:m4a",
            "--merge-output-format", "mp4", "--remux-video", "mp4", "--no-simulate", "--quiet",
            "--output", str(workdir / "Pornhub.%(ext)s"), "--print", "after_move:%(filepath)s", "--", url,
        ], capture_output=True, text=True, check=True, timeout=app.DOWNLOAD_TIMEOUT_SECONDS)
        path = app.result_path(result, workdir)
        if path is None or path.suffix.lower() != ".mp4":
            raise app.UserVisibleError("❌ فایل ویدیوی Pornhub دریافت نشد؛ ممکن است حجم آن بیش از سقف ۲ گیگابایت باشد.")
        app.validate_file_size(path)
        from youtube_pipeline import _probe_geometry
        duration = app.probe_duration(path)
        if not _probe_geometry(path) or not math.isfinite(duration) or duration <= 0 or duration < expected - 2:
            raise app.UserVisibleError("❌ ویدیوی Pornhub کامل دریافت نشد؛ فایل ناقص ارسال نشد.")
        return path, str(metadata.get("title") or "Pornhub video").strip()
    except subprocess.TimeoutExpired as exc:
        raise app.UserVisibleError("❌ دریافت ویدیو از Pornhub بیش از حد طول کشید؛ دوباره امتحان کن.") from exc
    except subprocess.CalledProcessError as exc:
        # Do not expose extractor output, signed URLs or authentication details.
        detail = str(exc.stderr or "").lower()
        if "filesize" in detail or "max-filesize" in detail:
            message = "❌ حجم این ویدیو از سقف ارسال ۲ گیگابایت بیشتر است."
        elif any(word in detail for word in ("private", "removed", "not available", "404")):
            message = "❌ این ویدیوی Pornhub خصوصی، حذف‌شده یا در دسترس نیست."
        else:
            message = "❌ دریافت ویدیو از Pornhub ممکن نشد؛ ممکن است سایت ورود یا تأیید دسترسی بخواهد."
        raise app.UserVisibleError(message) from exc


def process_job(payload: dict) -> dict:
    token = str(payload.get("botToken") or "")
    chat_id = int(payload["chatId"])
    message_id = int(payload["requestMessageId"])
    status_id = payload.get("statusMessageId")
    workdir = Path(tempfile.mkdtemp(prefix="pornhub-download-"))
    try:
        if not token:
            raise ValueError("Missing bot token")
        path, title = download(str(payload.get("url") or ""), workdir)
        app.edit_status(token, chat_id, status_id, "📤 ویدیوی Pornhub آماده شد؛ دارم می‌فرستم…")
        app.send_media_file(token, chat_id, message_id, path, title, reply=True)
        app.delete_status(token, chat_id, status_id)
        return {"ok": True, "parts": 1, "title": title}
    except Exception as exc:
        message = str(exc) if isinstance(exc, app.UserVisibleError) else "❌ دانلود یا ارسال ویدیوی Pornhub کامل نشد؛ دوباره لینک را بفرست."
        try:
            app.edit_status(token, chat_id, status_id, message)
        except Exception:
            pass
        return {"ok": False, "message": message}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
