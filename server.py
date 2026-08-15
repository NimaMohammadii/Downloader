import asyncio
import hashlib
import hmac
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
import yt_dlp
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request

app = FastAPI(title="Instagram Telegram Downloader")

BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
INSTAGRAM_SESSIONID = os.environ.get("INSTAGRAM_SESSIONID", "").strip()
INSTAGRAM_CSRFTOKEN = os.environ.get("INSTAGRAM_CSRFTOKEN", "").strip()
INSTAGRAM_DS_USER_ID = os.environ.get("INSTAGRAM_DS_USER_ID", "").strip()

TELEGRAM_UPLOAD_LIMIT = 48_000_000
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v"}
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)


class DownloadFailure(RuntimeError):
    pass


def telegram_url(method: str) -> str:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")
    return f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"


def telegram_call(method: str, data: dict[str, Any], files=None, timeout=(20, 900)) -> dict[str, Any]:
    response = requests.post(telegram_url(method), data=data, files=files, timeout=timeout)
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"Telegram {method} returned invalid JSON ({response.status_code})") from exc

    if not response.ok or not payload.get("ok"):
        raise RuntimeError(payload.get("description") or f"Telegram {method} failed ({response.status_code})")
    return payload.get("result") or {}


def safe_telegram_call(method: str, data: dict[str, Any]) -> None:
    try:
        telegram_call(method, data, timeout=(15, 60))
    except Exception as exc:
        print(f"telegram {method} failed: {exc}", flush=True)


def extract_instagram_url(text: str) -> str | None:
    for raw in URL_RE.findall(text or ""):
        candidate = raw.rstrip("),.!?]}>")
        try:
            parsed = urlparse(candidate)
        except Exception:
            continue
        host = (parsed.hostname or "").lower().removeprefix("www.")
        if host == "instagram.com" or host.endswith(".instagram.com"):
            return candidate
    return None


def is_story_url(url: str) -> bool:
    return "/stories/" in urlparse(url).path.lower()


def write_cookie_file(directory: Path) -> Path | None:
    if not INSTAGRAM_SESSIONID:
        return None

    cookie_path = directory / "instagram-cookies.txt"
    rows = [
        "# Netscape HTTP Cookie File",
        f".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\t{INSTAGRAM_SESSIONID}",
    ]
    if INSTAGRAM_CSRFTOKEN:
        rows.append(f".instagram.com\tTRUE\t/\tTRUE\t2147483647\tcsrftoken\t{INSTAGRAM_CSRFTOKEN}")
    if INSTAGRAM_DS_USER_ID:
        rows.append(f".instagram.com\tTRUE\t/\tTRUE\t2147483647\tds_user_id\t{INSTAGRAM_DS_USER_ID}")

    cookie_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return cookie_path


def clean_media_files(directory: Path) -> None:
    for path in directory.iterdir():
        if path.name == "instagram-cookies.txt":
            continue
        if path.is_file():
            path.unlink(missing_ok=True)


def ydl_options(directory: Path, cookie_file: Path | None, app_id: str | None) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "outtmpl": str(directory / "%(id)s.%(ext)s"),
        "format": "bv*+ba/b",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "nopart": True,
        "overwrites": True,
        "retries": 4,
        "fragment_retries": 4,
        "socket_timeout": 30,
        "concurrent_fragment_downloads": 4,
        "http_headers": {
            "Referer": "https://www.instagram.com/",
            "Origin": "https://www.instagram.com",
        },
    }
    if cookie_file:
        opts["cookiefile"] = str(cookie_file)
    if app_id:
        opts["extractor_args"] = {"instagram": {"app_id": [app_id]}}
    return opts


def collect_video_files(directory: Path) -> list[Path]:
    files = [
        path for path in directory.iterdir()
        if path.is_file()
        and path.name != "instagram-cookies.txt"
        and path.suffix.lower() in VIDEO_EXTENSIONS
        and path.stat().st_size > 0
    ]
    return sorted(files, key=lambda p: (p.stat().st_mtime_ns, p.name))


def run_ytdlp(url: str, directory: Path, cookie_file: Path | None, app_id: str | None) -> list[Path]:
    clean_media_files(directory)
    with yt_dlp.YoutubeDL(ydl_options(directory, cookie_file, app_id)) as ydl:
        ydl.download([url])
    return collect_video_files(directory)


def download_instagram(url: str, directory: Path) -> list[Path]:
    cookie_file = write_cookie_file(directory)
    story = is_story_url(url)

    if story and not cookie_file:
        raise DownloadFailure("STORY_LOGIN_REQUIRED")

    attempts: list[tuple[Path | None, str | None]] = []
    if story:
        attempts = [(cookie_file, None), (cookie_file, "ios")]
    else:
        attempts = [(None, None), (None, "ios")]
        if cookie_file:
            attempts.extend([(cookie_file, None), (cookie_file, "ios")])

    failures: list[str] = []
    for cookies, app_id in attempts:
        try:
            files = run_ytdlp(url, directory, cookies, app_id)
            if files:
                return files
            failures.append(f"cookies={bool(cookies)},app={app_id or 'web'}:no-media")
        except yt_dlp.utils.DownloadError as exc:
            failures.append(f"cookies={bool(cookies)},app={app_id or 'web'}:{exc}")
        except Exception as exc:
            failures.append(f"cookies={bool(cookies)},app={app_id or 'web'}:{exc}")

    raise DownloadFailure("INSTAGRAM_DOWNLOAD_FAILED | " + " | ".join(failures)[-5000:])


def ffprobe_duration(path: Path) -> float | None:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    try:
        duration = float(result.stdout.strip())
        return duration if duration > 0 else None
    except Exception:
        return None


def transcode_for_telegram(source: Path, output: Path, target_bytes: int = 42_000_000) -> Path:
    duration = ffprobe_duration(source)
    if not duration:
        video_kbps = 900
        audio_kbps = 96
    else:
        total_kbps = max(210, int((target_bytes * 8) / duration / 1000))
        audio_kbps = 64 if total_kbps < 500 else 96
        video_kbps = max(120, min(2200, total_kbps - audio_kbps - 24))

    command = [
        "ffmpeg", "-y", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", "scale=w=min(iw\\,1280):h=-2",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-b:v", f"{video_kbps}k", "-maxrate", f"{video_kbps}k", "-bufsize", f"{video_kbps * 2}k",
        "-c:a", "aac", "-b:a", f"{audio_kbps}k",
        "-movflags", "+faststart",
        str(output),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
    if result.returncode != 0 or not output.exists() or output.stat().st_size <= 0:
        raise DownloadFailure("FFMPEG_TRANSCODE_FAILED:" + result.stderr[-1500:])
    return output


def normalize_video(source: Path, directory: Path, index: int) -> Path:
    if source.suffix.lower() == ".mp4" and source.stat().st_size <= TELEGRAM_UPLOAD_LIMIT:
        return source

    output = directory / f"telegram-{index:02d}.mp4"
    transcode_for_telegram(source, output)
    if output.stat().st_size > TELEGRAM_UPLOAD_LIMIT:
        smaller = directory / f"telegram-small-{index:02d}.mp4"
        transcode_for_telegram(output, smaller, target_bytes=34_000_000)
        output = smaller

    if output.stat().st_size > TELEGRAM_UPLOAD_LIMIT:
        raise DownloadFailure("VIDEO_TOO_LARGE_AFTER_TRANSCODE")
    return output


def send_video(chat_id: int, reply_message_id: int, path: Path, caption: str) -> None:
    with path.open("rb") as handle:
        telegram_call(
            "sendVideo",
            {
                "chat_id": str(chat_id),
                "caption": caption[:1024],
                "supports_streaming": "true",
                "reply_parameters": json.dumps({"message_id": reply_message_id}),
            },
            files={"video": (path.name, handle, "video/mp4")},
            timeout=(30, 1200),
        )


def friendly_error(detail: str, story: bool) -> str:
    value = detail.lower()
    if "story_login_required" in value:
        return "❌ برای دانلود Story باید Session اکانت Instagram به سرویس وصل بشه."
    if "login required" in value or "login_required" in value or "log in" in value:
        return "❌ Instagram برای این محتوا لاگین می‌خواد. Session اکانت ربات باید وصل باشه."
    if "private" in value:
        return "❌ این محتوا Private هست و اکانت ربات بهش دسترسی نداره."
    if "429" in value or "rate" in value or "too many" in value:
        return "❌ Instagram موقتاً دانلودها رو محدود کرده. یکم بعد دوباره امتحان کن."
    if "video_too_large" in value:
        return "❌ حجم این ویدیو برای ارسال مستقیم داخل تلگرام خیلی زیاده."
    if "unsupported url" in value:
        return "❌ این نوع لینک Instagram فعلاً پشتیبانی نمی‌شه."
    if story:
        return "❌ نتونستم این Story رو بگیرم. ممکنه منقضی شده باشه یا لاگین بخواد."
    return "❌ نتونستم این ویدیو رو از Instagram دانلود کنم."


def process_update(payload: dict[str, Any]) -> None:
    update = payload.get("update") or {}
    status_message_id = payload.get("statusMessageId")
    message = update.get("message") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    message_id = message.get("message_id")
    text = (message.get("text") or message.get("caption") or "").strip()
    instagram_url = extract_instagram_url(text)

    if not chat_id or not message_id or not instagram_url:
        return

    story = is_story_url(instagram_url)
    try:
        with tempfile.TemporaryDirectory(prefix="instagram-") as temp_name:
            directory = Path(temp_name)
            downloaded = download_instagram(instagram_url, directory)
            prepared: list[Path] = []
            for index, source in enumerate(downloaded, start=1):
                prepared.append(normalize_video(source, directory, index))

            total = len(prepared)
            for index, path in enumerate(prepared, start=1):
                label = "Instagram Story" if story else "Instagram"
                caption = label if total == 1 else f"{label} • {index}/{total}"
                send_video(int(chat_id), int(message_id), path, caption)

        if status_message_id:
            safe_telegram_call("deleteMessage", {
                "chat_id": chat_id,
                "message_id": status_message_id,
            })
    except Exception as exc:
        detail = str(exc)
        print(f"instagram job failed: {detail}", flush=True)
        text = friendly_error(detail, story)
        if status_message_id:
            safe_telegram_call("editMessageText", {
                "chat_id": chat_id,
                "message_id": status_message_id,
                "text": text,
            })
        else:
            safe_telegram_call("sendMessage", {
                "chat_id": chat_id,
                "text": text,
                "reply_parameters": json.dumps({"message_id": message_id}),
            })


def verify_signature(raw: bytes, provided: str | None) -> bool:
    if not BOT_TOKEN or not provided:
        return False
    expected = hmac.new(BOT_TOKEN.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided)


@app.get("/")
def root():
    return {"ok": True, "service": "instagram-downloader"}


@app.get("/health")
def health():
    return {
        "ok": True,
        "botConfigured": bool(BOT_TOKEN),
        "instagramSessionConfigured": bool(INSTAGRAM_SESSIONID),
        "ytDlp": yt_dlp.version.__version__,
        "ffmpeg": bool(shutil.which("ffmpeg")),
    }


@app.post("/telegram/update", status_code=202)
async def telegram_update(request: Request, background_tasks: BackgroundTasks):
    raw = await request.body()
    if not verify_signature(raw, request.headers.get("x-downloader-signature")):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Bad JSON") from exc

    background_tasks.add_task(process_update, payload)
    return {"ok": True, "queued": True}
