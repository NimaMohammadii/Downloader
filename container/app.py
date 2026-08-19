import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import requests

PORT = int(os.environ.get("PORT", "8080"))
DIRECT_TELEGRAM_LIMIT = 47_000_000
TARGET_PART_SIZE = 42_000_000
DOWNLOAD_TIMEOUT_SECONDS = 7_000
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://127.0.0.1:4416").rstrip("/")


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


def is_permanent_youtube_error(stderr: str) -> bool:
    value = stderr.lower()
    return any(
        marker in value
        for marker in (
            "private video",
            "this video is private",
            "members-only",
            "members only",
            "video unavailable",
            "this video is unavailable",
            "copyright",
            "premiere will begin",
        )
    )


def friendly_ytdlp_error(stderr: str) -> str:
    value = stderr.lower()
    if "private video" in value or "this video is private" in value:
        return "❌ این ویدیو Private هست و قابل دانلود نیست."
    if "members-only" in value or "members only" in value or "join this channel" in value:
        return "❌ این ویدیو فقط برای اعضای کانال قابل مشاهده است."
    if "age" in value and ("restricted" in value or "confirm" in value or "sign in" in value):
        return "❌ این ویدیو محدودیت سنی دارد و بدون ورود به YouTube قابل دانلود نیست."
    if "video unavailable" in value or "this video is unavailable" in value or "not available in your country" in value:
        return "❌ این ویدیو در دسترس نیست یا برای این منطقه محدود شده."
    if "copyright" in value:
        return "❌ این ویدیو به‌خاطر محدودیت صاحب محتوا قابل دانلود نیست."
    if "live event will begin" in value or "premiere will begin" in value:
        return "❌ این Live/Premiere هنوز شروع نشده."
    if "sign in to confirm" in value or "not a bot" in value:
        return "❌ YouTube فعلاً این درخواست را ضدبات تشخیص داده. دوباره امتحان کن."
    if "http error 403" in value or "403: forbidden" in value or "po token" in value:
        return "❌ YouTube موقتاً دسترسی به استریم این ویدیو را محدود کرده. دوباره امتحان کن."
    if "unsupported url" in value:
        return "❌ این نوع لینک YouTube قابل دانلود نیست. لینک مستقیم ویدیو یا Shorts رو بفرست."
    return "❌ نتونستم این ویدیو رو از YouTube بگیرم. یک‌بار دیگه همین لینک یا لینک دیگه‌ای رو امتحان کن."


def ytdlp_command(extra_args: list[str], player_clients: str) -> list[str]:
    return [
        "yt-dlp",
        "--no-playlist",
        "--js-runtimes",
        "node",
        "--extractor-args",
        f"youtube:player_client={player_clients}",
        "--extractor-args",
        f"youtubepot-bgutilhttp:base_url={POT_PROVIDER_URL}",
        "--no-warnings",
        *extra_args,
    ]


def run_ytdlp(extra_args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    errors: list[str] = []
    # mweb + a normal web client gives the PO-token provider a useful primary path.
    # web_safari is a fallback for videos where the default client is temporarily restricted.
    for player_clients in ("default,mweb", "web_safari,mweb"):
        try:
            return subprocess.run(
                ytdlp_command(extra_args, player_clients),
                text=True,
                capture_output=True,
                check=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise UserVisibleError("❌ دانلود بیشتر از حد معمول طول کشید. دوباره امتحان کن.") from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            errors.append(stderr)
            if is_permanent_youtube_error(stderr):
                break
    detail = "\n--- fallback ---\n".join(errors)
    raise UserVisibleError(friendly_ytdlp_error(detail))


def fetch_metadata(url: str) -> dict[str, Any]:
    result = run_ytdlp(
        ["--skip-download", "--dump-single-json", url],
        timeout=180,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise UserVisibleError("❌ اطلاعات ویدیو از YouTube دریافت نشد.") from exc


def download_video(url: str, workdir: Path) -> Path:
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")
    format_selector = (
        "bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
        "bv*[height<=720][ext=mp4]+ba[ext=m4a]/"
        "b[height<=720][ext=mp4]/b[height<=720]"
    )
    result = run_ytdlp(
        [
            "--no-simulate",
            "--concurrent-fragments",
            "4",
            "--retries",
            "5",
            "--fragment-retries",
            "5",
            "--extractor-retries",
            "3",
            "--socket-timeout",
            "30",
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

    printed = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if printed:
        candidate = Path(printed[-1])
        if candidate.exists() and candidate.is_file():
            return candidate

    media_files = [
        path
        for path in workdir.iterdir()
        if path.is_file()
        and not path.name.startswith("part_")
        and path.suffix.lower() not in {".part", ".ytdl"}
    ]
    if not media_files:
        raise UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")
    return max(media_files, key=lambda path: path.stat().st_size)


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
    for attempt in range(7):
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
                timeout=900,
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


def process_job(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("botToken") or "")
    url = str(payload.get("url") or "")
    chat_id = int(payload.get("chatId"))
    request_message_id = int(payload.get("requestMessageId"))
    status_raw = payload.get("statusMessageId")
    status_message_id = int(status_raw) if status_raw else None

    if not token or not url:
        raise ValueError("Missing bot token or URL")

    workdir = Path(tempfile.mkdtemp(prefix="youtube-download-"))
    try:
        edit_status(token, chat_id, status_message_id, "🔎 دارم ویدیوی YouTube رو بررسی می‌کنم…")
        metadata = fetch_metadata(url)

        if metadata.get("_type") == "playlist" or metadata.get("entries"):
            raise UserVisibleError("❌ فعلاً لینک یک ویدیو یا Shorts رو بفرست، نه Playlist.")

        live_status = str(metadata.get("live_status") or "").lower()
        if metadata.get("is_live") or live_status in {"is_live", "is_upcoming"}:
            raise UserVisibleError("❌ دانلود Live در حال پخش فعلاً پشتیبانی نمی‌شه. لینک ویدیوی عادی رو بفرست.")

        title = str(metadata.get("title") or "YouTube video").strip() or "YouTube video"
        edit_status(token, chat_id, status_message_id, "⬇️ دارم ویدیو رو تا 720p دانلود می‌کنم…")
        video_path = download_video(url, workdir)
        parts = split_for_telegram(video_path, workdir)

        if len(parts) > 1:
            edit_status(
                token,
                chat_id,
                status_message_id,
                f"📦 فایل بزرگه؛ دارم توی {len(parts)} پارت می‌فرستم…",
            )
        else:
            edit_status(token, chat_id, status_message_id, "📤 دانلود شد؛ دارم می‌فرستم…")

        for index, part in enumerate(parts, start=1):
            caption = title if len(parts) == 1 else f"{title}\nPart {index}/{len(parts)}"
            send_media_file(
                token,
                chat_id,
                request_message_id,
                part,
                caption,
                reply=index == 1,
            )

        delete_status(token, chat_id, status_message_id)
        return {"ok": True, "parts": len(parts), "title": title}

    except UserVisibleError as exc:
        try:
            edit_status(token, chat_id, status_message_id, str(exc))
        except Exception:
            pass
        return {"ok": False, "message": str(exc)}
    except Exception as exc:
        print(f"job failed: {type(exc).__name__}: {exc}", flush=True)
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

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"container http: {fmt % args}", flush=True)

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
        if self.path != "/download":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid content length"})
            return
        if length <= 0 or length > 128_000:
            self._send_json(400, {"ok": False, "error": "invalid body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("body must be object")
            result = process_job(payload)
            self._send_json(200, result)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:
            print(f"request failed: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal error"})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"YouTube downloader listening on 0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
