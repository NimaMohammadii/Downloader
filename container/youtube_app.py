import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import requests

PORT = int(os.environ.get("PORT", "8080"))
DIRECT_TELEGRAM_LIMIT = 47_000_000
TARGET_PART_SIZE = 42_000_000
METADATA_TIMEOUT_SECONDS = 90
DOWNLOAD_TIMEOUT_SECONDS = 1_500
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://127.0.0.1:4416")
SUPPORTED_QUALITIES = (360, 480, 720, 1080)
SUPPORTED_AUDIO_MODES = ("low", "hq")
REAL_YTDLP = "/opt/venv/bin/yt-dlp-real"
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


def split_for_telegram(path: Path, workdir: Path) -> list[Path]:
    size = path.stat().st_size
    if size <= DIRECT_TELEGRAM_LIMIT:
        return [path]

    duration = probe_duration(path)
    if duration <= 0:
        raise UserVisibleError("❌ فایل خیلی بزرگه و نتونستم به پارت‌های امن تقسیمش کنم.")

    base_seconds = max(4.0, duration * TARGET_PART_SIZE / size)
    for attempt in range(8):
        for old_part in workdir.glob("part_*.mp4"):
            old_part.unlink(missing_ok=True)

        segment_seconds = max(3.0, base_seconds * (0.78**attempt))
        pattern = str(workdir / "part_%03d.mp4")
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(path),
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a?",
                    "-c",
                    "copy",
                    "-f",
                    "segment",
                    "-segment_time",
                    f"{segment_seconds:.3f}",
                    "-reset_timestamps",
                    "1",
                    "-avoid_negative_ts",
                    "make_zero",
                    pattern,
                ],
                check=True,
                text=True,
                capture_output=True,
                timeout=1_200,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue

        parts = sorted(workdir.glob("part_*.mp4"))
        if parts and all(part.stat().st_size <= DIRECT_TELEGRAM_LIMIT for part in parts):
            return parts

    raise UserVisibleError("❌ ویدیو برای ارسال مستقیم در تلگرام بیش از حد بزرگه.")


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> None:
    common_data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
    }
    if reply:
        common_data["reply_parameters"] = json.dumps({"message_id": request_message_id})

    try:
        with path.open("rb") as handle:
            telegram_call(
                token,
                "sendVideo",
                data={**common_data, "supports_streaming": "true"},
                files={"video": (path.name, handle, "video/mp4")},
                timeout=1_800,
            )
        return
    except Exception as video_error:
        try:
            with path.open("rb") as handle:
                telegram_call(
                    token,
                    "sendDocument",
                    data=common_data,
                    files={"document": (path.name, handle, "application/octet-stream")},
                    timeout=1_800,
                )
            return
        except Exception as document_error:
            raise RuntimeError(
                f"Telegram upload failed: {video_error}; document fallback: {document_error}"
            ) from document_error


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

    try:
        with path.open("rb") as handle:
            telegram_call(
                token,
                "sendAudio",
                data=data,
                files={"audio": ("Vexa.m4a", handle, "audio/mp4")},
                timeout=1_800,
            )
        return
    except Exception as audio_error:
        try:
            with path.open("rb") as handle:
                telegram_call(
                    token,
                    "sendDocument",
                    data={
                        "chat_id": str(chat_id),
                        "caption": caption[:1024],
                        "reply_parameters": json.dumps({"message_id": request_message_id}),
                    },
                    files={"document": ("Vexa.m4a", handle, "audio/mp4")},
                    timeout=1_800,
                )
            return
        except Exception as document_error:
            raise RuntimeError(
                f"Telegram audio upload failed: {audio_error}; document fallback: {document_error}"
            ) from document_error


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
        parts = split_for_telegram(video_path, workdir)

        if len(parts) > 1 and video_path.exists() and video_path not in parts:
            video_path.unlink(missing_ok=True)

        if len(parts) > 1:
            edit_status(
                token,
                chat_id,
                status_message_id,
                f"📦 فایل بزرگه؛ دارم توی {len(parts)} پارت برات می‌فرستم…",
            )
        else:
            edit_status(token, chat_id, status_message_id, "📤 دانلود شد؛ دارم می‌فرستم…")

        for index, part in enumerate(parts, start=1):
            base_caption = f"{title}\n{quality}p"
            caption = base_caption if len(parts) == 1 else f"{base_caption}\nPart {index}/{len(parts)}"
            send_media_file(
                token,
                chat_id,
                request_message_id,
                part,
                caption,
                reply=index == 1,
            )
            if len(parts) > 1:
                part.unlink(missing_ok=True)

        delete_status(token, chat_id, status_message_id)
        return {"ok": True, "parts": len(parts), "title": title, "quality": quality}

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
        if self.path not in {"/metadata", "/download"}:
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
            if content_length <= 0 or content_length > 1_000_000:
                self._send_json(400, {"ok": False, "error": "invalid body"})
                return
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if self.path == "/metadata":
                url = str(payload.get("url") or "")
                if not url:
                    self._send_json(400, {"ok": False, "message": "❌ لینک YouTube نامعتبره."})
                    return
                result = inspect_video(url)
            else:
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
