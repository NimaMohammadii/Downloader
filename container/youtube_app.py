import asyncio
import hashlib
import json
import secrets
import os
import re
import signal
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from array import array
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, urljoin

import requests

JOB_LOCK = threading.Lock()

PORT = int(os.environ.get("PORT", "8080"))
DIRECT_TELEGRAM_LIMIT = 2_000_000_000
METADATA_TIMEOUT_SECONDS = 90
DOWNLOAD_TIMEOUT_SECONDS = 1_500
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://127.0.0.1:4416")
SUPPORTED_QUALITIES = (360, 480, 720, 1080)
SUPPORTED_AUDIO_MODES = ("low", "hq")
REAL_YTDLP = shutil.which("yt-dlp") or "yt-dlp"
METADATA_CACHE_PATH = Path("/tmp/vexa-youtube-info.json")


class UserVisibleError(Exception):
    pass


def telegram_call(
    token: str,
    method: str,
    *,
    json_payload: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
    timeout: int = 900,
) -> Any:
    if files:
        return asyncio.run(upload_complete_file(token, method, data or {}, next(iter(files.values()))))
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        json=json_payload,
        data=data,
        files=files,
        timeout=(20, timeout),
    )
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Telegram {method} returned invalid JSON") from exc
    if not response.ok or not payload.get("ok"):
        raise RuntimeError(payload.get("description") or f"Telegram {method} failed")
    return payload.get("result")


def edit_status(token: str, chat_id: int, message_id: int | None, text: str) -> None:
    if not message_id:
        return
    telegram_call(
        token,
        "editMessageText",
        json_payload={"chat_id": chat_id, "message_id": message_id, "text": text},
        timeout=60,
    )


def delete_status(token: str, chat_id: int, message_id: int | None) -> None:
    if not message_id:
        return
    try:
        telegram_call(
            token,
            "deleteMessage",
            json_payload={"chat_id": chat_id, "message_id": message_id},
            timeout=60,
        )
    except Exception:
        pass


def friendly_ytdlp_error(stderr: str) -> str:
    value = stderr.lower()
    if "private video" in value or "this video is private" in value:
        return "❌ این ویدیو Private هست و بدون دسترسی به اکانت قابل دانلود نیست."
    if "members-only" in value or "join this channel" in value:
        return "❌ این ویدیو فقط برای اعضای کانال قابل مشاهده است."
    if "video unavailable" in value or "not available" in value:
        return "❌ این ویدیو در دسترس نیست یا برای این منطقه محدود شده."
    if "sign in to confirm" in value or "not a bot" in value:
        return "❌ YouTube این IP رو موقتاً محدود کرده. چند لحظه بعد دوباره امتحان کن."
    if "http error 403" in value or "403: forbidden" in value:
        return "❌ YouTube دسترسی دانلود این ویدیو رو موقتاً بسته. دوباره امتحان کن."
    if "age" in value and ("restricted" in value or "confirm" in value or "sign in" in value):
        return "❌ این ویدیو محدودیت سنی داره و بدون ورود به YouTube قابل دانلود نیست."
    if "copyright" in value:
        return "❌ این ویدیو به‌خاطر محدودیت صاحب محتوا قابل دانلود نیست."
    if "unsupported url" in value:
        return "❌ این لینک YouTube قابل دانلود نیست. لینک مستقیم ویدیو یا Shorts رو بفرست."
    if "requested format is not available" in value:
        return "❌ این کیفیت برای این ویدیو موجود نیست. یک گزینه دیگه رو انتخاب کن."
    return "❌ نتونستم این فایل رو از YouTube بگیرم. دوباره همین لینک یا یک لینک دیگه رو امتحان کن."


def run_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise UserVisibleError("❌ ارتباط با YouTube بیشتر از حد معمول طول کشید. دوباره امتحان کن.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        raise UserVisibleError(friendly_ytdlp_error(stderr)) from exc


def run_cached_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[str] | None:
    """Try cached direct media URLs once; never turn a stale cache into a user error."""
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        print("cached yt-dlp attempt timed out; falling back to fresh extraction", flush=True)
        return None
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        print(f"cached yt-dlp attempt failed; refreshing extraction: {detail[-1200:]}", flush=True)
        return None


def ytdlp_common_args() -> list[str]:
    return [
        "--no-playlist",
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=default,mweb",
        "--extractor-args",
        f"youtubepot-bgutilhttp:base_url={POT_PROVIDER_URL}",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--extractor-retries",
        "1",
        "--socket-timeout",
        "15",
    ]


def fetch_metadata(url: str) -> dict[str, Any]:
    result = run_command(
        [
            "yt-dlp",
            *ytdlp_common_args(),
            "--skip-download",
            "--dump-single-json",
            "--no-warnings",
            url,
        ],
        timeout=METADATA_TIMEOUT_SECONDS,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise UserVisibleError("❌ اطلاعات ویدیو از YouTube دریافت نشد.") from exc


def save_metadata_cache(metadata: dict[str, Any]) -> None:
    try:
        temp_path = METADATA_CACHE_PATH.with_suffix(".tmp")
        temp_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        temp_path.replace(METADATA_CACHE_PATH)
    except Exception as exc:
        print(f"metadata cache write failed: {type(exc).__name__}: {exc}", flush=True)


def youtube_video_id(url: str) -> str | None:
    try:
        parsed = urlparse(url)
        host = parsed.hostname.lower().replace("www.", "") if parsed.hostname else ""
        if host == "youtu.be":
            value = parsed.path.strip("/").split("/")[0]
            return value or None
        if host.endswith("youtube.com") or host.endswith("youtube-nocookie.com"):
            if parsed.path == "/watch":
                return (parse_qs(parsed.query).get("v") or [None])[0]
            pieces = [part for part in parsed.path.split("/") if part]
            if len(pieces) >= 2 and pieces[0] in {"shorts", "embed", "live"}:
                return pieces[1]
    except Exception:
        return None
    return None


def load_metadata_cache(url: str) -> dict[str, Any] | None:
    if not METADATA_CACHE_PATH.exists():
        return None
    try:
        metadata = json.loads(METADATA_CACHE_PATH.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            return None
        expected = youtube_video_id(url)
        cached = str(metadata.get("id") or "")
        if expected and cached and expected != cached:
            return None
        return metadata
    except Exception as exc:
        print(f"metadata cache read failed: {type(exc).__name__}: {exc}", flush=True)
        return None


def validate_video_metadata(metadata: dict[str, Any]) -> None:
    if metadata.get("_type") == "playlist" or metadata.get("entries"):
        raise UserVisibleError("❌ لینک مستقیم یک ویدیو یا Shorts رو بفرست، نه Playlist یا کانال.")

    live_status = str(metadata.get("live_status") or "").lower()
    if metadata.get("is_live") or live_status in {"is_live", "is_upcoming"}:
        raise UserVisibleError("❌ دانلود Live در حال پخش فعلاً پشتیبانی نمی‌شه.")


def video_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []
    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        if str(item.get("vcodec") or "none").lower() == "none":
            continue
        result.append(item)
    return result


def audio_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []
    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        if str(item.get("vcodec") or "none").lower() != "none":
            continue
        if str(item.get("acodec") or "none").lower() == "none":
            continue
        result.append(item)
    return result


def short_side(format_info: dict[str, Any]) -> int | None:
    width_raw = format_info.get("width")
    height_raw = format_info.get("height")
    try:
        width = int(width_raw) if width_raw else 0
        height = int(height_raw) if height_raw else 0
    except (TypeError, ValueError):
        return None
    if width > 0 and height > 0:
        return min(width, height)
    return height or width or None


def available_qualities(metadata: dict[str, Any]) -> list[int]:
    found: set[int] = set()
    for format_info in video_formats(metadata):
        resolution = short_side(format_info)
        if not resolution:
            continue
        for quality in SUPPORTED_QUALITIES:
            if abs(resolution - quality) <= 16:
                found.add(quality)
    return [quality for quality in SUPPORTED_QUALITIES if quality in found]


def is_portrait(metadata: dict[str, Any]) -> bool:
    best: tuple[int, int, int] | None = None
    for format_info in video_formats(metadata):
        try:
            width = int(format_info.get("width") or 0)
            height = int(format_info.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if width <= 0 or height <= 0:
            continue
        area = width * height
        if best is None or area > best[0]:
            best = (area, width, height)
    if best is None:
        return False
    return best[1] < best[2]


def inspect_video(url: str) -> dict[str, Any]:
    try:
        metadata = fetch_metadata(url)
        validate_video_metadata(metadata)
        qualities = available_qualities(metadata)
        has_audio = len(audio_formats(metadata)) > 0
        if not qualities and not has_audio:
            raise UserVisibleError("❌ کیفیت قابل دانلود برای این ویدیو پیدا نشد.")
        video_id = str(metadata.get("id") or "").strip()
        if not video_id:
            raise UserVisibleError("❌ شناسه ویدیوی YouTube دریافت نشد.")
        save_metadata_cache(metadata)
        return {
            "ok": True,
            "videoId": video_id,
            "title": str(metadata.get("title") or "YouTube video").strip(),
            "qualities": qualities,
            "audioAvailable": has_audio,
        }
    except UserVisibleError as exc:
        return {"ok": False, "message": str(exc)}


def result_path(result: subprocess.CompletedProcess[str], workdir: Path, *, prefix: str | None = None) -> Path | None:
    printed = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if printed:
        candidate = Path(printed[-1])
        if candidate.exists() and candidate.is_file():
            return candidate

    candidates = []
    for path in workdir.iterdir():
        if not path.is_file() or path.suffix.lower() in {".part", ".ytdl", ".json"}:
            continue
        if path.name.startswith("part_"):
            continue
        if prefix and not path.name.startswith(prefix):
            continue
        candidates.append(path)
    return max(candidates, key=lambda path: path.stat().st_size) if candidates else None


def download_video(url: str, workdir: Path, quality: int, metadata: dict[str, Any]) -> Path:
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")
    dimension = "width" if is_portrait(metadata) else "height"
    format_selector = (
        f"bv*[{dimension}<={quality}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
        f"bv*[{dimension}<={quality}][ext=mp4]+ba[ext=m4a]/"
        f"bv*[{dimension}<={quality}]+ba/"
        f"b[{dimension}<={quality}][ext=mp4]/b[{dimension}<={quality}]/b"
    )

    if METADATA_CACHE_PATH.exists():
        cached = run_cached_command(
            [
                REAL_YTDLP,
                "--load-info-json",
                str(METADATA_CACHE_PATH),
                "--no-simulate",
                "--retries",
                "1",
                "--fragment-retries",
                "1",
                "--socket-timeout",
                "12",
                "--concurrent-fragments",
                "2",
                "--format",
                format_selector,
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
                "--output",
                output_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )
        if cached is not None:
            path = result_path(cached, workdir)
            if path is not None:
                return path

    result = run_command(
        [
            "yt-dlp",
            *ytdlp_common_args(),
            "--no-simulate",
            "--concurrent-fragments",
            "2",
            "--format",
            format_selector,
            "--merge-output-format",
            "mp4",
            "--remux-video",
            "mp4",
            "--output",
            output_template,
            "--quiet",
            "--print",
            "after_move:%(filepath)s",
            url,
        ],
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    )
    path = result_path(result, workdir)
    if path is None:
        raise UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")
    return path


def download_audio(url: str, workdir: Path, audio_mode: str) -> Path:
    if audio_mode == "low":
        format_selector = "ba[abr<=80][ext=m4a]/ba[abr<=80]/worstaudio[ext=m4a]/worstaudio"
        fallback_bitrate = "64k"
    else:
        format_selector = "ba[ext=m4a]/ba"
        fallback_bitrate = "128k"

    source_template = str(workdir / "audio-source.%(ext)s")
    result: subprocess.CompletedProcess[str] | None = None

    if METADATA_CACHE_PATH.exists():
        result = run_cached_command(
            [
                REAL_YTDLP,
                "--load-info-json",
                str(METADATA_CACHE_PATH),
                "--no-simulate",
                "--retries",
                "1",
                "--fragment-retries",
                "1",
                "--socket-timeout",
                "12",
                "--format",
                format_selector,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )

    source = result_path(result, workdir, prefix="audio-source.") if result is not None else None
    if source is None:
        result = run_command(
            [
                "yt-dlp",
                *ytdlp_common_args(),
                "--no-simulate",
                "--format",
                format_selector,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
                url,
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )
        source = result_path(result, workdir, prefix="audio-source.")

    if source is None:
        raise UserVisibleError("❌ فایل صوتی بعد از دانلود پیدا نشد.")

    target = workdir / "Vexa.m4a"
    if source.suffix.lower() == ".m4a":
        source.replace(target)
        return target

    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source),
                "-vn",
                "-c:a",
                "aac",
                "-b:a",
                fallback_bitrate,
                "-movflags",
                "+faststart",
                str(target),
            ],
            check=True,
            text=True,
            capture_output=True,
            timeout=1_200,
        )
    except subprocess.TimeoutExpired as exc:
        raise UserVisibleError("❌ تبدیل فایل صوتی بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        print(f"audio conversion failed: {detail}", flush=True)
        raise UserVisibleError("❌ تبدیل فایل صوتی به M4A انجام نشد.") from exc

    if not target.exists() or target.stat().st_size <= 0:
        raise UserVisibleError("❌ فایل صوتی نهایی ساخته نشد.")
    return target


def probe_duration(path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
        )
        return max(0.0, float(result.stdout.strip()))
    except Exception:
        return 0.0


def validate_file_size(path: Path) -> None:
    if path.stat().st_size > DIRECT_TELEGRAM_LIMIT:
        raise UserVisibleError("❌ حجم فایل از سقف ۲ گیگابایت بیشتره؛ کیفیت پایین‌تر رو انتخاب کن.")


async def upload_complete_file(token: str, method: str, data: dict[str, Any], file: tuple) -> Any:
    from telethon import TelegramClient, functions, types
    from telethon.errors import FloodWaitError

    filename, handle, mime = file
    path = Path(handle.name)
    validate_file_size(path)
    api_id = os.environ.get("API_ID", "")
    api_hash = os.environ.get("API_HASH", "")
    if not api_id.isdecimal() or not api_hash:
        raise UserVisibleError("❌ تنظیمات API_ID و API_HASH برای ارسال فایل آماده نیست.")

    # This MTProto bot session leaves the existing Bot API webhook intact.
    async with await TelegramClient(
        "/tmp/youtube-uploader", int(api_id), api_hash,
        receive_updates=False, flood_sleep_threshold=60,
    ).start(bot_token=token) as client:
        size = path.stat().st_size
        part_size = 512 * 1024
        count = (size + part_size - 1) // part_size
        file_id = secrets.randbits(63)
        digest = hashlib.md5()
        big = size > 10 * 1024 * 1024

        async def save_part(index: int, chunk: bytes) -> None:
            for attempt in range(3):
                try:
                    request = (functions.upload.SaveBigFilePartRequest(file_id, index, count, chunk)
                               if big else functions.upload.SaveFilePartRequest(file_id, index, chunk))
                    if not await client(request):
                        raise RuntimeError("Telegram rejected an upload part")
                    return
                except FloodWaitError as exc:
                    if attempt == 2 or exc.seconds > 60:
                        raise
                    await asyncio.sleep(exc.seconds)

        # Bound memory to eight chunks, await every part before publishing media.
        with path.open("rb") as source:
            for first in range(0, count, 8):
                batch = []
                for index in range(first, min(first + 8, count)):
                    chunk = source.read(part_size)
                    if not big:
                        digest.update(chunk)
                    batch.append(save_part(index, chunk))
                async with asyncio.TaskGroup() as group:
                    for task in batch:
                        group.create_task(task)
        uploaded = (types.InputFileBig(file_id, count, filename) if big
                    else types.InputFile(file_id, count, filename, digest.hexdigest()))
        attributes = [types.DocumentAttributeFilename(filename)]
        if method == "sendVideo":
            attributes.append(types.DocumentAttributeVideo(
                duration=float(data.get("duration", 0)),
                w=int(data.get("width", 0)), h=int(data.get("height", 0)),
                supports_streaming=True,
            ))
        elif method == "sendAudio":
            attributes.append(types.DocumentAttributeAudio(
                duration=int(probe_duration(path)), title=str(data.get("title") or path.stem),
                performer=str(data.get("performer") or "") or None,
            ))
        reply = json.loads(data.get("reply_parameters", "{}"))
        message = await client.send_file(
            int(data["chat_id"]), uploaded,
            caption=data.get("caption", ""), parse_mode=None,
            mime_type=mime, attributes=attributes,
            supports_streaming=method == "sendVideo",
            force_document=method == "sendDocument",
            reply_to=reply.get("message_id"),
        )
        return {"message_id": message.id}


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> None:
    data: dict[str, Any] = {"chat_id": str(chat_id), "caption": caption[:1024]}
    if reply:
        data["reply_parameters"] = json.dumps({"message_id": request_message_id})
    with path.open("rb") as handle:
        telegram_call(
            token, "sendVideo", data=data,
            files={"video": (path.name, handle, "video/mp4")}, timeout=1800,
        )


def send_audio_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
) -> None:
    if path.stat().st_size > DIRECT_TELEGRAM_LIMIT:
        raise UserVisibleError("❌ فایل صوتی برای ارسال مستقیم در تلگرام بیش از حد بزرگه.")

    data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
        "title": "Vexa",
        "reply_parameters": json.dumps({"message_id": request_message_id}),
    }

    with path.open("rb") as handle:
        telegram_call(
            token, "sendAudio", data=data,
            files={"audio": (path.name, handle, "audio/mp4")}, timeout=1800,
        )


def process_job(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("botToken") or "")
    url = str(payload.get("url") or "")
    chat_id = int(payload.get("chatId"))
    request_message_id = int(payload.get("requestMessageId"))
    quality_raw = payload.get("quality")
    quality = int(quality_raw) if quality_raw is not None else None
    audio_mode = str(payload.get("audioMode") or "").lower() or None
    status_raw = payload.get("statusMessageId")
    status_message_id = int(status_raw) if status_raw else None

    if not token or not url:
        raise ValueError("Missing bot token or URL")
    if quality is not None and quality not in SUPPORTED_QUALITIES:
        raise ValueError("Unsupported YouTube quality")
    if audio_mode is not None and audio_mode not in SUPPORTED_AUDIO_MODES:
        raise ValueError("Unsupported YouTube audio mode")
    if (quality is None) == (audio_mode is None):
        raise ValueError("Choose exactly one YouTube download mode")

    workdir = Path(tempfile.mkdtemp(prefix="youtube-download-"))
    try:
        metadata = load_metadata_cache(url)
        if metadata is None:
            edit_status(token, chat_id, status_message_id, "🔎 دارم اطلاعات ویدیو رو تازه می‌کنم…")
            metadata = fetch_metadata(url)
            save_metadata_cache(metadata)
        validate_video_metadata(metadata)
        title = str(metadata.get("title") or "YouTube video").strip()

        if audio_mode:
            if not audio_formats(metadata):
                raise UserVisibleError("❌ این ویدیو فایل صوتی قابل دانلود نداره.")

            mode_label = "کم‌حجم" if audio_mode == "low" else "HQ"
            edit_status(
                token,
                chat_id,
                status_message_id,
                f"⬇️ دارم صدای ویدیو رو با حالت {mode_label} دانلود می‌کنم…",
            )
            audio_path = download_audio(url, workdir, audio_mode)
            edit_status(token, chat_id, status_message_id, "📤 فایل صوتی آماده شد؛ دارم می‌فرستم…")
            send_audio_file(
                token,
                chat_id,
                request_message_id,
                audio_path,
                f"{title}\nAudio {mode_label}",
            )
            delete_status(token, chat_id, status_message_id)
            return {"ok": True, "parts": 1, "title": title, "audioMode": audio_mode}

        assert quality is not None
        if quality not in available_qualities(metadata):
            raise UserVisibleError(f"❌ کیفیت {quality}p برای این ویدیو موجود نیست. دوباره لینک رو بفرست.")

        edit_status(token, chat_id, status_message_id, f"⬇️ دارم ویدیو رو با کیفیت {quality}p دانلود می‌کنم…")
        video_path = download_video(url, workdir, quality, metadata)
        validate_file_size(video_path)
        edit_status(token, chat_id, status_message_id, "📤 ویدیو کامل آماده شد؛ دارم می‌فرستم…")
        send_media_file(
            token, chat_id, request_message_id, video_path,
            f"{title}\n{quality}p", reply=True,
        )
        delete_status(token, chat_id, status_message_id)
        return {"ok": True, "parts": 1, "title": title, "quality": quality}

    except UserVisibleError as exc:
        try:
            edit_status(token, chat_id, status_message_id, str(exc))
        except Exception:
            pass
        return {"ok": False, "message": str(exc)}
    except Exception as exc:
        print(f"youtube job failed: {type(exc).__name__}: {exc}", flush=True)
        try:
            edit_status(
                token,
                chat_id,
                status_message_id,
                "❌ یه خطای موقت پیش اومد. دوباره لینک رو بفرست.",
            )
        except Exception:
            pass
        return {"ok": False, "message": "unexpected error"}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


INSTAGRAM_RECORD_SECONDS = 2 * 60 * 60
INSTAGRAM_FILE_LIMIT = 1_900_000_000  # Leave room for the finalized MP4 below Telegram's cap.
INSTAGRAM_JOBS: dict[str, "InstagramCapture"] = {}
INSTAGRAM_LOCK = threading.Lock()

RECOGNITION_FILE_LIMIT = 20_000_000
RECOGNITION_WINDOW_SECONDS = 12
RECOGNITION_SAMPLE_SECONDS = 36


def download_recognition_input(token: str, media: dict[str, Any], workdir: Path) -> Path:
    file_id = str(media.get("fileId") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", file_id):
        raise UserVisibleError("❌ شناسهٔ فایل معتبر نیست؛ فایل را دوباره بفرست.")
    try:
        info = telegram_call(token, "getFile", json_payload={"file_id": file_id}, timeout=30)
        size = int(info.get("file_size") or media.get("fileSize") or 0)
        if size > RECOGNITION_FILE_LIMIT:
            raise UserVisibleError("❌ فایل برای تشخیص آهنگ بزرگ است؛ یک تکهٔ کوتاه با حجم حداکثر 20 MB بفرست.")
        file_path = str(info.get("file_path") or "")
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", file_path) or any(part in {"", ".", ".."} for part in file_path.split("/")):
            raise UserVisibleError("❌ دریافت آدرس فایل از تلگرام کامل نشد؛ فایل را دوباره بفرست.")
        target = workdir / "recognition-input"
        deadline = time.monotonic() + 120
        with requests.get(f"https://api.telegram.org/file/bot{token}/{file_path}",
                          stream=True, allow_redirects=False, timeout=(15, 30)) as response:
            if response.status_code != 200:
                raise UserVisibleError("❌ دریافت فایل از تلگرام انجام نشد؛ یک تکهٔ کوتاه‌تر بفرست.")
            if int(response.headers.get("content-length") or 0) > RECOGNITION_FILE_LIMIT:
                raise UserVisibleError("❌ برای تشخیص آهنگ فایل باید حداکثر 20 MB باشد.")
            total = 0
            with target.open("wb") as handle:
                for chunk in response.iter_content(64 * 1024):
                    total += len(chunk)
                    if total > RECOGNITION_FILE_LIMIT or time.monotonic() > deadline:
                        raise UserVisibleError("❌ دریافت فایل کامل نشد؛ یک تکهٔ کوتاه‌تر با حجم حداکثر 20 MB بفرست.")
                    handle.write(chunk)
        if not total or (size and total != size):
            raise UserVisibleError("❌ فایل صوتی کامل دریافت نشد؛ دوباره بفرست.")
        return target
    except UserVisibleError:
        raise
    except Exception as exc:
        # Telegram errors can contain the token-bearing download URL. Never expose them.
        raise UserVisibleError("❌ دریافت فایل از تلگرام انجام نشد؛ یک تکهٔ کوتاه‌تر با حجم حداکثر 20 MB بفرست.") from exc


def recognition_samples(source: Path, workdir: Path) -> list[Path]:
    decoded = workdir / "recognition-pcm.wav"
    try:
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                        "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,mp3,ogg,wav,aac,flac,asf,aiff",
                        "-i", str(source), "-t", str(RECOGNITION_SAMPLE_SECONDS), "-map", "0:a:0", "-vn",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(decoded)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=45)
    except subprocess.SubprocessError as exc:
        raise UserVisibleError("❌ صدای قابل خواندن داخل این فایل نیست؛ یک ویس یا ویدیوی صدادار بفرست.") from exc
    samples = []
    with wave.open(str(decoded), "rb") as audio:
        while len(samples) < 3:
            frames = audio.readframes(16000 * RECOGNITION_WINDOW_SECONDS)
            if len(frames) < 16000 * 2 * 3:
                break
            # Ignore digital silence rather than spend a recognition request on it.
            if max(map(abs, array("h", frames)), default=0) < 8:
                continue
            sample = workdir / f"recognition-{len(samples)}.wav"
            with wave.open(str(sample), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(frames)
            samples.append(sample)
    if not samples:
        raise UserVisibleError("❌ صدای کافی برای تشخیص ندارم؛ حداقل 3 ثانیه و ترجیحاً 10 تا 30 ثانیه از آهنگ را بفرست.")
    return samples


async def recognize_samples(samples: list[Path]) -> dict[str, str]:
    from shazamio import Shazam
    from shazamio.client import HTTPClient
    from shazamio.exceptions import RateLimited
    from aiohttp_retry import ExponentialRetry

    # The upstream default retries twenty times. Bound this interactive request instead.
    try:
        async with HTTPClient(retry_options=ExponentialRetry(attempts=1)) as client:
            async with Shazam(http_client=client, segment_duration_seconds=12) as recognizer:
                for sample in samples[:3]:
                    result = await asyncio.wait_for(recognizer.recognize(str(sample)), timeout=25)
                    if not isinstance(result, dict):
                        raise ValueError("Invalid recognition response")
                    if not isinstance(result.get("matches"), list):
                        raise ValueError("Invalid recognition matches")
                    track = result.get("track")
                    if not result.get("matches") or not isinstance(track, dict):
                        continue
                    title = " ".join(str(track.get("title") or "").split())[:180]
                    artist = " ".join(str(track.get("subtitle") or "").split())[:120]
                    if title and artist:
                        return {"title": title, "artist": artist}
    except Exception as exc:
        print(f"music recognition service failed: {type(exc).__name__}", flush=True)
        message = "❌ سرویس تشخیص آهنگ موقتاً پاسخ نداد؛ کمی بعد دوباره امتحان کن."
        if isinstance(exc, RateLimited):
            message = "❌ سرویس Shazam فعلاً درخواست‌ها را محدود کرده؛ کمی بعد دوباره امتحان کن."
        raise UserVisibleError(message) from exc
    raise UserVisibleError("❌ آهنگ شناسایی نشد؛ یک بخش واضح‌تر با موسیقی بیشتر و صحبت کمتر بفرست.")


def recognize_telegram_music(token: str, media: dict[str, Any], workdir: Path) -> dict[str, str]:
    try:
        source = download_recognition_input(token, media, workdir)
        samples = recognition_samples(source, workdir)
        return asyncio.run(recognize_samples(samples))
    finally:
        # Keep only the final song, never the user's source clip or fingerprints.
        for path in workdir.glob("recognition-*"):
            path.unlink(missing_ok=True)


def instagram_safe_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or not any(host == domain or host.endswith("." + domain) for domain in ("cdninstagram.com", "fbcdn.net"))):
        raise UserVisibleError("❌ آدرس فایل لایو معتبر نیست.")
    return value


def instagram_manifest(xml: str, origin: str | None, live: bool) -> str:
    if len(xml) > 2_000_000 or "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise UserVisibleError("❌ اطلاعات پخش لایو معتبر نیست.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise UserVisibleError("❌ اطلاعات پخش لایو دریافت نشد.") from exc
    tag = lambda node: node.tag.rsplit("}", 1)[-1]
    if tag(root) != "MPD" or any(tag(node) == "ContentProtection" for node in root.iter()):
        raise UserVisibleError("❌ این فایل پخش قابل دانلود نیست.")
    if root.tag.startswith("{"):
        ET.register_namespace("", root.tag[1:].split("}", 1)[0])
    if not live and root.get("type", "static") == "dynamic":
        raise UserVisibleError("❌ این لینک بازپخش منتشرشده نیست؛ لینک پست یا Reel بازپخش را بفرست.")

    def rewrite(node: ET.Element, base: str) -> None:
        bases = [child for child in node if tag(child) == "BaseURL"]
        for child in bases:
            child.text = instagram_safe_url(urljoin(base, (child.text or "").strip()))
        current = bases[0].text if bases else base
        for key, value in list(node.attrib.items()):
            if key.rsplit("}", 1)[-1] in {"media", "initialization", "sourceURL", "href"}:
                node.set(key, instagram_safe_url(urljoin(current or "", value)))
        for child in node:
            if tag(child) == "Location":
                child.text = instagram_safe_url(urljoin(current or "", (child.text or "").strip()))
            elif tag(child) != "BaseURL":
                rewrite(child, current or "")
    rewrite(root, origin or "")
    # A local static MPD needs a network base for relative segment URLs.
    if origin and not any(tag(child) == "BaseURL" for child in root):
        namespace = root.tag[:-3] if root.tag.endswith("MPD") else ""
        child = ET.Element(namespace + "BaseURL")
        child.text = instagram_safe_url(urljoin(origin, "."))
        root.insert(0, child)
    if not any(tag(node) == "Representation" for node in root.iter()):
        raise UserVisibleError("❌ فایل ویدیو داخل اطلاعات پخش وجود ندارد.")
    return ET.tostring(root, encoding="unicode")


def instagram_read_manifest(url: str) -> tuple[str, str]:
    # Validate each redirect; never forward Instagram account cookies to a CDN.
    for _ in range(4):
        instagram_safe_url(url)
        with requests.get(url, headers={"Referer": "https://www.instagram.com/"}, timeout=(15, 30), stream=True, allow_redirects=False) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                url = urljoin(url, response.headers.get("location", ""))
                continue
            if response.status_code in {401, 403, 404}:
                raise UserVisibleError("❌ آدرس پخش لایو منقضی شده یا دسترسی سرور رد شده؛ لینک را دوباره بفرست.")
            response.raise_for_status()
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > 2_000_000:
                    raise UserVisibleError("❌ اطلاعات پخش لایو بیش از حد بزرگ است.")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8"), url
    raise UserVisibleError("❌ آدرس پخش لایو بیش از حد تغییر مسیر داد.")


class InstagramCapture:
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        self.id = str(payload.get("id") or "")
        if not re.fullmatch(r"igdl--?\d+-\d+-\d+", self.id):
            raise ValueError("Invalid Instagram job ID")
        self.source = payload.get("source") or {}
        self.live = self.source.get("mode") == "live"
        self.audio_only = bool(self.source.get("audioOnly"))
        if self.source.get("mode") not in {"live", "replay"}:
            raise ValueError("Invalid Instagram mode")
        if payload.get("completionUrl") != f"https://downloader.vexaagent.workers.dev/instagram/events/{self.id}":
            raise ValueError("Invalid completion destination")
        if not re.fullmatch(r"[a-f0-9]{64}", str(payload.get("completionToken") or "")):
            raise ValueError("Invalid event token")
        self.workdir = Path(tempfile.mkdtemp(prefix="instagram-capture-"))
        self.path = self.workdir / ("Instagram.m4a" if self.audio_only else "Instagram.mp4")
        self.process: subprocess.Popen | None = None
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.cleanup_requested = False
        self.reason = ""
        self.state = "starting"
        self.result: dict[str, Any] = {"ok": False}
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.expiry = threading.Timer(3 * 60 * 60, self.cleanup)
        self.expiry.daemon = True

    def status(self, text: str, *, button: bool = False) -> None:
        telegram_call(self.payload["botToken"], "editMessageText", json_payload={
            "chat_id": self.payload["chatId"], "message_id": self.payload["statusMessageId"], "text": text,
            "reply_markup": {"inline_keyboard": [[{"text": "⏹ توقف ضبط و ارسال", "callback_data": self.payload["stopData"]}]] if button else []},
        }, timeout=30)

    def safe_status(self, text: str, *, button: bool = False) -> None:
        try:
            self.status(text, button=button)
        except Exception:
            print("instagram status delivery failed", flush=True)

    def stop(self, reason: str = "user") -> bool:
        with self.lock:
            if self.state not in {"starting", "recording"} or (reason == "user" and not self.live):
                return False
            if not self.reason:
                self.reason = reason
            self.stop_event.set()
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    return True
                killer = threading.Timer(15, self.kill)
                killer.daemon = True
                killer.start()
            return True

    def kill(self) -> None:
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.kill()

    def notify(self) -> None:
        for attempt in range(3):
            try:
                response = requests.post(self.payload["completionUrl"], headers={"x-instagram-event-token": self.payload["completionToken"]}, json=self.result, timeout=(10, 20))
                if response.ok:
                    return
            except requests.RequestException:
                pass
            if attempt < 2:
                self.stop_event.wait(2 ** (attempt + 1))
        self.safe_status("❌ فایل دریافت شد ولی اعلام نتیجه به ربات کامل نشد؛ لینک را دوباره بفرست.")

    def run(self) -> None:
        watchdog = wall_timer = None
        try:
            if self.source.get("recognition"):
                self.safe_status("🎧 دارم صدای فایل را با Shazam بررسی می‌کنم…")
                match = recognize_telegram_music(self.payload["botToken"], self.source["recognition"], self.workdir)
                self.source.update({"recognizedTitle": match["title"], "recognizedArtist": match["artist"],
                                    "musicQuery": f"{match['artist']} {match['title']}"})
                self.safe_status(f"✅ آهنگ شناسایی شد\n🎵 {match['title']}\n👤 {match['artist']}\n⬇️ دارم فایل کاملش را پیدا می‌کنم…")
            if self.source.get("musicQuery"):
                from youtube_pipeline import prepare_music
                if not self.source.get("recognition"):
                    self.safe_status("🔎 دارم نتیجهٔ مناسب آهنگ را از YouTube پیدا و دانلود می‌کنم…")
                self.path, title, artist, url = prepare_music(self.source["musicQuery"], self.workdir)
                self.source.update({"title": title, "performer": artist, "musicUrl": url})
                self.video = {"title": title, "performer": artist}
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                self.safe_status(f"🎵 {title}\n📤 آهنگ پیدا شد؛ دارم فایل MP3 را آمادهٔ ارسال می‌کنم…")
                return
            source_url = self.source.get("url")
            xml = self.source.get("manifest")
            if source_url:
                instagram_safe_url(source_url)
            if self.live or xml or (source_url and urlparse(source_url).path.lower().endswith(".mpd")):
                origin = source_url
                if not xml:
                    xml, origin = instagram_read_manifest(source_url)
                xml = instagram_manifest(xml, origin, self.live)
                if self.live:
                    # FFmpeg must reload the remote dynamic MPD to receive new segments.
                    if not source_url:
                        raise UserVisibleError("❌ آدرس زندهٔ پخش موجود نیست؛ لینک Live را دوباره بفرست.")
                    input_url = instagram_safe_url(origin)
                else:
                    manifest_path = self.workdir / "replay.mpd"
                    manifest_path.write_text(xml, encoding="utf-8")
                    input_url = str(manifest_path)
            elif source_url:
                input_url = source_url
            else:
                raise UserVisibleError("❌ فایل پخش این لایو در دسترس نیست.")
            if self.stop_event.is_set():
                raise UserVisibleError("ضبط پیش از دریافت تصویر متوقف شد؛ فایلی برای ارسال وجود ندارد.")
            raw_path = self.workdir / ("capture.m4a" if self.audio_only else "capture.mp4")
            command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                       "-rw_timeout", "45000000", "-protocol_whitelist", "file,https,tls,tcp",
                       "-i", input_url]
            command += (["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k"] if self.audio_only
                        else ["-sn", "-dn", "-c", "copy"])
            if self.live:
                command += ["-t", str(INSTAGRAM_RECORD_SECONDS)]
            command += ["-fs", str(INSTAGRAM_FILE_LIMIT), "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                        "-progress", "pipe:1", str(raw_path)]
            with self.lock:
                self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                self.state = "recording"
                if self.stop_event.is_set():
                    self.stop()
            self.safe_status("🔴 ضبط Live شروع شد.\nاز این لحظه تا پایان پخش یا توقف ضبط ذخیره می‌شود.\nسقف هر ضبط: 2 ساعت یا 1.9 GB." if self.live else "🎧 دارم صدا را از ویدیوی اینستاگرام جدا می‌کنم…" if self.audio_only else "⬇️ دارم بازپخش کامل لایو را دانلود می‌کنم…", button=self.live)
            wall_timer = threading.Timer(INSTAGRAM_RECORD_SECONDS + 60 if self.live else 25 * 60, lambda: self.stop("time_limit"))
            wall_timer.daemon = True
            wall_timer.start()
            last_progress = None
            # FFmpeg's progress stream drives the stall watchdog; no status polling.
            assert self.process.stdout is not None
            watchdog = threading.Timer(90, lambda: self.stop("interrupted"))
            watchdog.daemon = True
            watchdog.start()
            for line in self.process.stdout:
                if line.startswith("out_time_us=") and line.strip() != last_progress:
                    last_progress = line.strip()
                    watchdog.cancel()
                    watchdog = threading.Timer(90, lambda: self.stop("interrupted"))
                    watchdog.daemon = True
                    watchdog.start()
            self.process.stdout.close()
            returncode = self.process.wait()
            watchdog.cancel()
            wall_timer.cancel()
            with self.lock:
                self.state = "finalizing"
            if not raw_path.exists() or raw_path.stat().st_size < 100:
                raise UserVisibleError("❌ فایل صوتی دریافت نشد؛ این ویدیو ممکن است بی‌صدا یا فایل آن منقضی شده باشد." if self.audio_only else "❌ تصویری از لایو دریافت نشد؛ ممکن است پخش پایان یافته یا آدرس آن منقضی شده باشد.")
            capped = raw_path.stat().st_size >= INSTAGRAM_FILE_LIMIT
            if not self.live and (returncode != 0 or self.reason or capped):
                raise UserVisibleError("❌ فایل صوتی کامل دریافت نشد یا حجم آن از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد." if self.audio_only else "❌ بازپخش کامل دریافت نشد یا حجم آن از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد.")
            if self.live and not self.reason:
                self.reason = "size_limit" if capped else ("interrupted" if returncode != 0 else "ended")
            mapping = ["-map", "0:a:0", "-vn"] if self.audio_only else ["-map", "0:v:0", "-map", "0:a:0?"]
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(raw_path),
                            *mapping, "-c", "copy", "-movflags", "+faststart", str(self.path)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=180)
            raw_path.unlink(missing_ok=True)
            validate_file_size(self.path)
            info = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(self.path)],
                                  capture_output=True, text=True, check=True, timeout=45)
            metadata = json.loads(info.stdout)
            video = next((stream for stream in metadata.get("streams", []) if stream.get("codec_type") == ("audio" if self.audio_only else "video")), None)
            duration = float(metadata.get("format", {}).get("duration") or 0)
            if not video or duration <= 0:
                raise UserVisibleError("❌ فایل صوتی سالم برای ارسال ساخته نشد." if self.audio_only else "❌ فایل ویدیوی سالم برای ارسال ساخته نشد.")
            expected = float(self.source.get("duration") or 0)
            if not self.live and expected and duration < expected - 2:
                raise UserVisibleError("❌ صدا ناقص دریافت شد؛ فایل ناقص ارسال نشد." if self.audio_only else "❌ بازپخش ناقص دریافت شد؛ فایل ناقص ارسال نشد.")
            if self.live and self.reason == "ended" and duration >= INSTAGRAM_RECORD_SECONDS - 1:
                self.reason = "time_limit"
            self.video = {"width": str(video.get("width", 0)), "height": str(video.get("height", 0)), "duration": str(duration), "title": str(self.source.get("title") or "Instagram Audio")}
            self.result = {"ok": True}
            self.safe_status("📤 فایل آماده شد؛ در حال آماده‌سازی ارسال…")
            with self.lock:
                self.state = "ready"
        except Exception as exc:
            # Never print commands, signed stream URLs, bot tokens or account data.
            print(f"instagram capture failed: {type(exc).__name__}", flush=True)
            self.result = {"ok": False, "message": str(exc) if isinstance(exc, UserVisibleError) else "❌ دریافت یا آماده‌سازی لایو کامل نشد؛ لینک را دوباره بفرست."}
            if self.source.get("recognition"):
                self.result["message"] = str(exc) if isinstance(exc, UserVisibleError) else "❌ دریافت فایل آهنگ کامل نشد؛ دوباره امتحان کن."
                if self.source.get("recognizedTitle"):
                    self.result["message"] = f"✅ آهنگ شناسایی شد\n🎵 {self.source['recognizedTitle']}\n👤 {self.source['recognizedArtist']}\n" + self.result["message"]
            with self.lock:
                self.state = "failed"
        finally:
            if self.process is not None:
                if self.process.poll() is None:
                    self.kill()
                    self.process.wait(timeout=20)
                if self.process.stdout is not None:
                    self.process.stdout.close()
            if watchdog:
                watchdog.cancel()
            if wall_timer:
                wall_timer.cancel()
            self.notify()
            if self.cleanup_requested:
                shutil.rmtree(self.workdir, ignore_errors=True)

    def send(self) -> dict[str, Any]:
        with self.lock:
            if self.state == "sent":
                return {"ok": True}
            if self.state != "ready":
                return {"ok": False, "message": "فایل آمادهٔ ارسال نیست یا قبلاً ارسال آن شروع شده است."}
            self.state = "sending"
        try:
            notes = {"user": "ضبط با درخواست شما متوقف شد.", "time_limit": "ضبط به سقف زمانی رسید.", "size_limit": "ضبط به سقف حجم رسید.", "interrupted": "ارتباط پخش قطع شد؛ بخش دریافت‌شده ارسال شد."}
            caption = str(self.source.get("title") or "Instagram Live")[:180]
            if self.source.get("recognizedTitle"):
                caption = f"🎵 {self.source['recognizedTitle']}\n👤 {self.source['recognizedArtist']}"
            caption += "\n" + ("Music" if self.source.get("musicQuery") else "Instagram Audio" if self.audio_only else "Live Recording" if self.live else "Live Replay")
            if self.source.get("musicUrl"):
                caption += "\n" + self.source["musicUrl"]
            if self.live and self.reason in notes:
                caption += "\n" + notes[self.reason]
            data = {"chat_id": str(self.payload["chatId"]), "caption": caption,
                    "reply_parameters": json.dumps({"message_id": self.payload["requestMessageId"]}), **self.video}
            self.safe_status("📤 دارم فایل صوتی را کامل در تلگرام ارسال می‌کنم…" if self.audio_only else "📤 دارم فایل ویدیو را کامل در تلگرام ارسال می‌کنم…")
            with self.path.open("rb") as handle:
                method = "sendAudio" if self.audio_only else "sendVideo"
                mime = "audio/mpeg" if self.path.suffix == ".mp3" else "audio/mp4" if self.audio_only else "video/mp4"
                asyncio.run(asyncio.wait_for(upload_complete_file(self.payload["botToken"], method, data, (self.path.name, handle, mime)), timeout=25 * 60))
            with self.lock:
                self.state = "sent"
            delete_status(self.payload["botToken"], self.payload["chatId"], self.payload["statusMessageId"])
            return {"ok": True}
        except Exception as exc:
            print(f"instagram upload failed: {type(exc).__name__}", flush=True)
            with self.lock:
                self.state = "failed"
            return {"ok": False}

    def cleanup(self) -> None:
        self.cleanup_requested = True
        self.stop("cleanup")
        if self.thread.is_alive() and threading.current_thread() is not self.thread:
            self.thread.join(timeout=20)
        if not self.thread.is_alive():
            shutil.rmtree(self.workdir, ignore_errors=True)
        self.expiry.cancel()


def instagram_action(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    job_id = str(payload.get("id") or "")
    with INSTAGRAM_LOCK:
        job = INSTAGRAM_JOBS.get(job_id)
        if action == "start":
            if job:
                # Workflow start retries reuse the same process and file.
                return {"ok": True}
            if INSTAGRAM_JOBS:
                return {"ok": False, "message": "ضبط دیگری در حال انجام است."}
            job = InstagramCapture(payload)
            INSTAGRAM_JOBS[job_id] = job
            job.expiry.start()
            job.thread.start()
            return {"ok": True}
    if not job:
        return {"ok": action == "cleanup", "message": "ضبط قبلاً تمام شده یا سرور ری‌استارت شده است."}
    if action == "stop":
        return {"ok": job.stop(), "message": "ضبط تمام شده یا در حال ارسال است."}
    if action == "send":
        return job.send()
    if action == "cleanup":
        job.cleanup()
        with INSTAGRAM_LOCK:
            INSTAGRAM_JOBS.pop(job_id, None)
        return {"ok": True}
    raise ValueError("Invalid Instagram action")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in {"/", "/health", "/ping"}:
            self._send_json(200, {"ok": True, "service": "youtube-yt-dlp-container"})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path not in {"/metadata", "/download", "/instagram/start", "/instagram/stop", "/instagram/send", "/instagram/cleanup"}:
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
            if content_length <= 0 or content_length > 1_000_000:
                self._send_json(400, {"ok": False, "error": "invalid body"})
                return
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if self.path.startswith("/instagram/"):
                result = instagram_action(self.path.rsplit("/", 1)[-1], payload)
            elif self.path == "/metadata":
                url = str(payload.get("url") or "")
                if not url:
                    self._send_json(400, {"ok": False, "message": "❌ لینک YouTube نامعتبره."})
                    return
                result = inspect_video(url)
            else:
                with JOB_LOCK:
                    result = process_job(payload)
            self._send_json(200, result)
        except Exception as exc:
            print(f"youtube container request failed: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal error"})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"youtube-container: {fmt % args}", flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"youtube downloader listening on :{PORT}", flush=True)
    server.serve_forever()
