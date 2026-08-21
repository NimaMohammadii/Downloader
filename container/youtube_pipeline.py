import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import youtube_app as app

# web_safari is intentionally excluded. In current YouTube/yt-dlp behavior its
# HLS formats are intermittent and can disappear between otherwise identical
# requests. Keep every actual download bound to one explicit client from start
# to finish instead of reusing a format_id/direct URL extracted by another run.
CLIENTS = ("mweb", "android_vr", "web_embedded")
SESSION_STATE_PATH = Path("/tmp/vexa-youtube-session.json")
ASPECT_TOLERANCE = 0.06
QUALITY_TOLERANCE = 18


class ClientAttemptError(Exception):
    def __init__(self, client: str, category: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.client = client
        self.category = category
        self.message = message
        self.detail = detail


def _client_args(client: str) -> list[str]:
    return [
        "--no-playlist",
        "--force-ipv4",
        "--js-runtimes",
        "node",
        "--extractor-args",
        f"youtube:player_client={client}",
        "--extractor-args",
        f"youtubepot-bgutilhttp:base_url={app.POT_PROVIDER_URL}",
        "--extractor-args",
        "youtubepot-wpc:browser_path=/usr/bin/chromium",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--extractor-retries",
        "1",
        "--socket-timeout",
        "15",
        "--sleep-requests",
        "1",
    ]


def _run(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        text=True,
        capture_output=True,
        check=True,
        timeout=timeout,
    )


def _classify_ytdlp_error(stderr: str) -> tuple[str, str]:
    value = (stderr or "").lower()

    # Specific format errors MUST be checked before generic "not available".
    if "requested format is not available" in value or "only images are available" in value:
        return "format", "❌ این کیفیت از مسیر فعلی YouTube قابل دریافت نبود."
    if "private video" in value or "this video is private" in value:
        return "private", "❌ این ویدیو Private هست و بدون دسترسی به اکانت قابل دانلود نیست."
    if "members-only" in value or "join this channel" in value:
        return "members", "❌ این ویدیو فقط برای اعضای کانال قابل مشاهده است."
    if "age" in value and ("restricted" in value or "confirm" in value or "sign in" in value):
        return "age", "❌ این ویدیو محدودیت سنی داره و بدون ورود به YouTube قابل دانلود نیست."
    if "copyright" in value:
        return "copyright", "❌ این ویدیو به‌خاطر محدودیت صاحب محتوا قابل دانلود نیست."
    if "unsupported url" in value:
        return "unsupported", "❌ این لینک YouTube قابل دانلود نیست. لینک مستقیم ویدیو یا Shorts رو بفرست."
    if "sign in to confirm" in value or "not a bot" in value:
        return "botcheck", "❌ YouTube این IP رو موقتاً محدود کرده. چند لحظه بعد دوباره امتحان کن."
    if "http error 403" in value or "403: forbidden" in value:
        return "forbidden", "❌ YouTube دسترسی دانلود این ویدیو رو موقتاً بسته. دوباره امتحان کن."

    unavailable_markers = (
        "video unavailable",
        "this video is not available",
        "not available in your country",
        "not available in your region",
        "the uploader has not made this video available",
    )
    if any(marker in value for marker in unavailable_markers):
        return "unavailable", "❌ این ویدیو در دسترس نیست یا برای این منطقه محدود شده."

    return "generic", "❌ نتونستم این فایل رو از YouTube بگیرم. دوباره امتحان کن."


def _attempt_error(client: str, exc: subprocess.CalledProcessError) -> ClientAttemptError:
    detail = (exc.stderr or "").strip()
    category, message = _classify_ytdlp_error(detail)
    return ClientAttemptError(client, category, message, detail)


def _fetch_metadata_for_client(url: str, client: str) -> dict[str, Any]:
    try:
        result = _run(
            [
                app.REAL_YTDLP,
                *_client_args(client),
                "--extractor-args",
                "youtube:player_skip=webpage,configs",
                "--extractor-retries",
                "0",
                "--skip-download",
                "--dump-single-json",
                "--no-warnings",
                "--format",
                "all",
                url,
            ],
            app.METADATA_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ClientAttemptError(
            client,
            "timeout",
            "❌ ارتباط با YouTube بیشتر از حد معمول طول کشید. دوباره امتحان کن.",
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise _attempt_error(client, exc) from exc

    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ClientAttemptError(
            client,
            "metadata",
            "❌ اطلاعات ویدیو از YouTube دریافت نشد.",
            result.stdout[-1000:],
        ) from exc
    if not isinstance(metadata, dict):
        raise ClientAttemptError(client, "metadata", "❌ اطلاعات ویدیو از YouTube دریافت نشد.")
    return metadata


def _save_session(metadata: dict[str, Any], client: str) -> None:
    app.save_metadata_cache(metadata)
    state = {
        "client": client,
        "videoId": str(metadata.get("id") or ""),
    }
    try:
        temp = SESSION_STATE_PATH.with_suffix(".tmp")
        temp.write_text(json.dumps(state), encoding="utf-8")
        temp.replace(SESSION_STATE_PATH)
    except Exception as exc:
        print(f"youtube session state write failed: {type(exc).__name__}: {exc}", flush=True)


def _load_session_client(metadata: dict[str, Any] | None = None) -> str | None:
    try:
        state = json.loads(SESSION_STATE_PATH.read_text(encoding="utf-8"))
        if not isinstance(state, dict):
            return None
        client = str(state.get("client") or "")
        if client not in CLIENTS:
            return None
        if metadata is not None:
            expected = str(metadata.get("id") or "")
            cached = str(state.get("videoId") or "")
            if expected and cached and expected != cached:
                return None
        return client
    except Exception:
        return None


def _dimensions(item: dict[str, Any]) -> tuple[int, int] | None:
    try:
        width = int(item.get("width") or 0)
        height = int(item.get("height") or 0)
    except (TypeError, ValueError):
        return None
    return (width, height) if width > 0 and height > 0 else None


def _is_storyboard(item: dict[str, Any]) -> bool:
    format_id = str(item.get("format_id") or "").lower()
    vcodec = str(item.get("vcodec") or "none").lower()
    protocol = str(item.get("protocol") or "").lower()
    ext = str(item.get("ext") or "").lower()
    note = str(item.get("format_note") or "").lower()
    format_text = str(item.get("format") or "").lower()
    return (
        protocol == "mhtml"
        or ext == "mhtml"
        or vcodec in {"images", "image"}
        or bool(re.fullmatch(r"sb\d+", format_id))
        or "storyboard" in note
        or "storyboard" in format_text
    )


def video_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []
    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict) or _is_storyboard(item):
            continue
        if str(item.get("vcodec") or "none").lower() == "none":
            continue
        if item.get("has_drm"):
            continue
        if _dimensions(item) is None:
            continue
        if not str(item.get("url") or "").strip():
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
        if item.get("has_drm"):
            continue
        if not str(item.get("url") or "").strip():
            continue
        result.append(item)
    return result


def _ratio(item: dict[str, Any]) -> float | None:
    dims = _dimensions(item)
    if not dims:
        return None
    width, height = dims
    return width / height


def _short_side(item: dict[str, Any]) -> int | None:
    dims = _dimensions(item)
    return min(dims) if dims else None


def _source_ratio(metadata: dict[str, Any]) -> float | None:
    formats = video_formats(metadata)
    if not formats:
        return None

    best_ratio: float | None = None
    best_count = -1
    best_area = -1
    for candidate in formats:
        ratio = _ratio(candidate)
        if ratio is None:
            continue
        cluster: list[dict[str, Any]] = []
        for item in formats:
            item_ratio = _ratio(item)
            if item_ratio is None:
                continue
            if abs(item_ratio - ratio) / ratio <= ASPECT_TOLERANCE:
                cluster.append(item)
        area = max(
            (dims[0] * dims[1] for item in cluster if (dims := _dimensions(item))),
            default=0,
        )
        if len(cluster) > best_count or (len(cluster) == best_count and area > best_area):
            best_ratio = ratio
            best_count = len(cluster)
            best_area = area
    return best_ratio


def _matches_ratio(item: dict[str, Any], source_ratio: float | None) -> bool:
    if source_ratio is None:
        return True
    ratio = _ratio(item)
    return bool(ratio and abs(ratio - source_ratio) / source_ratio <= ASPECT_TOLERANCE)


def available_qualities(metadata: dict[str, Any]) -> list[int]:
    source_ratio = _source_ratio(metadata)
    found: set[int] = set()
    for item in video_formats(metadata):
        if not _matches_ratio(item, source_ratio):
            continue
        resolution = _short_side(item)
        if resolution is None:
            continue
        for quality in app.SUPPORTED_QUALITIES:
            if abs(resolution - quality) <= QUALITY_TOLERANCE:
                found.add(quality)
    return [quality for quality in app.SUPPORTED_QUALITIES if quality in found]


def is_portrait(metadata: dict[str, Any]) -> bool:
    ratio = _source_ratio(metadata)
    return bool(ratio is not None and ratio < 1.0)


def _clean_workdir(workdir: Path) -> None:
    if not workdir.exists():
        return
    for path in workdir.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
        elif path.is_dir():
            shutil.rmtree(path, ignore_errors=True)


def _client_order(cached: str | None) -> list[str]:
    return ([cached] if cached in CLIENTS else []) + [client for client in CLIENTS if client != cached]


def _log_attempt_failure(kind: str, error: ClientAttemptError) -> None:
    detail = error.detail.replace("\n", " ")[-1200:]
    print(
        f"youtube {kind} client={error.client} failed category={error.category}: "
        f"{error.message} detail={detail}",
        flush=True,
    )


def _terminal_category(category: str) -> bool:
    return category in {"private", "members", "age", "copyright", "unsupported"}


def _final_attempt_message(errors: list[ClientAttemptError], fallback: str) -> str:
    if not errors:
        return fallback

    for error in errors:
        if _terminal_category(error.category):
            return error.message

    categories = {error.category for error in errors}
    if categories and categories <= {"unavailable"}:
        return "❌ این ویدیو در دسترس نیست یا برای این منطقه محدود شده."
    if "botcheck" in categories:
        return "❌ YouTube این IP رو موقتاً محدود کرده. چند لحظه بعد دوباره امتحان کن."
    if "forbidden" in categories:
        return "❌ YouTube دسترسی دانلود این ویدیو رو موقتاً بسته. دوباره امتحان کن."
    if "timeout" in categories:
        return "❌ ارتباط با YouTube بیشتر از حد معمول طول کشید. دوباره امتحان کن."
    if "format" in categories:
        return "❌ کیفیت انتخاب‌شده این بار از YouTube دریافت نشد. دوباره امتحان کن."
    return fallback


def fetch_metadata(url: str) -> dict[str, Any]:
    errors: list[ClientAttemptError] = []
    for client in CLIENTS:
        try:
            metadata = _fetch_metadata_for_client(url, client)
            app.validate_video_metadata(metadata)
            if not available_qualities(metadata) and not audio_formats(metadata):
                print(f"youtube metadata client={client} returned no playable formats", flush=True)
                continue
            _save_session(metadata, client)
            print(f"youtube metadata selected client={client}", flush=True)
            return metadata
        except ClientAttemptError as exc:
            errors.append(exc)
            _log_attempt_failure("metadata", exc)
        except app.UserVisibleError:
            raise

    raise app.UserVisibleError(
        _final_attempt_message(errors, "❌ اطلاعات ویدیو از YouTube دریافت نشد. دوباره امتحان کن.")
    )


def inspect_video(url: str) -> dict[str, Any]:
    try:
        metadata = fetch_metadata(url)
        video_id = str(metadata.get("id") or "").strip()
        if not video_id:
            raise app.UserVisibleError("❌ شناسه ویدیوی YouTube دریافت نشد.")
        return {
            "ok": True,
            "videoId": video_id,
            "title": str(metadata.get("title") or "YouTube video").strip(),
            "qualities": available_qualities(metadata),
            "audioAvailable": bool(audio_formats(metadata)),
        }
    except app.UserVisibleError as exc:
        return {"ok": False, "message": str(exc)}


def _fraction(value: str) -> float | None:
    try:
        if not value or value in {"N/A", "0:1"}:
            return None
        left, right = value.split(":", 1)
        denominator = float(right)
        return float(left) / denominator if denominator else None
    except Exception:
        return None


def _probe_geometry(path: Path) -> tuple[int, int, float] | None:
    try:
        result = _run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,display_aspect_ratio,sample_aspect_ratio",
                "-of",
                "json",
                str(path),
            ],
            60,
        )
        payload = json.loads(result.stdout)
        streams = payload.get("streams") if isinstance(payload, dict) else None
        if not isinstance(streams, list) or not streams:
            return None
        stream = streams[0]
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        if width <= 0 or height <= 0:
            return None
        dar = _fraction(str(stream.get("display_aspect_ratio") or ""))
        if dar is None:
            sar = _fraction(str(stream.get("sample_aspect_ratio") or "")) or 1.0
            dar = (width / height) * sar
        return width, height, dar
    except Exception as exc:
        print(f"video geometry probe failed: {type(exc).__name__}: {exc}", flush=True)
        return None


def _verify_video(path: Path, quality: int, expected_ratio: float | None) -> tuple[bool, str]:
    probed = _probe_geometry(path)
    if probed is None:
        return False, "ffprobe could not read video geometry"
    width, height, actual_ratio = probed
    resolution = min(width, height)
    if abs(resolution - quality) > QUALITY_TOLERANCE:
        return False, f"expected {quality}p but got {width}x{height}"
    if expected_ratio is not None:
        ratio_error = abs(actual_ratio - expected_ratio) / expected_ratio
        if ratio_error > 0.08:
            return False, f"expected aspect {expected_ratio:.4f} but got {actual_ratio:.4f} ({width}x{height})"
    return True, f"{width}x{height}"


def _download_video_with_client(
    url: str,
    client: str,
    workdir: Path,
    quality: int,
    expected_ratio: float | None,
) -> Path:
    _clean_workdir(workdir)
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")

    try:
        result = _run(
            [
                app.REAL_YTDLP,
                *_client_args(client),
                "--no-simulate",
                "--concurrent-fragments",
                "2",
                "--format",
                "bv*+ba/b",
                "--format-sort",
                f"res:{quality},+codec:avc:m4a,ext:mp4:m4a",
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
            app.DOWNLOAD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ClientAttemptError(client, "timeout", "❌ دانلود بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        raise _attempt_error(client, exc) from exc

    path = app.result_path(result, workdir)
    if path is None:
        raise ClientAttemptError(client, "missing-file", "❌ فایل ویدیو بعد از دانلود پیدا نشد.")

    valid, detail = _verify_video(path, quality, expected_ratio)
    if not valid:
        path.unlink(missing_ok=True)
        raise ClientAttemptError(client, "verification", "❌ کیفیت یا نسبت تصویر خروجی درست نبود.", detail)

    print(
        f"youtube video downloaded client={client} quality={quality} output={detail}",
        flush=True,
    )
    return path


def download_video(url: str, workdir: Path, quality: int, metadata: dict[str, Any]) -> Path:
    if quality not in app.SUPPORTED_QUALITIES:
        raise app.UserVisibleError("❌ کیفیت انتخاب‌شده پشتیبانی نمی‌شه.")
    if quality not in available_qualities(metadata):
        raise app.UserVisibleError(f"❌ کیفیت {quality}p برای این ویدیو موجود نیست.")

    cached_client = _load_session_client(metadata)
    expected_ratio = _source_ratio(metadata)
    errors: list[ClientAttemptError] = []

    for client in _client_order(cached_client):
        try:
            path = _download_video_with_client(url, client, workdir, quality, expected_ratio)
            try:
                fresh = _fetch_metadata_for_client(url, client)
                if available_qualities(fresh) or audio_formats(fresh):
                    _save_session(fresh, client)
            except Exception:
                pass
            return path
        except ClientAttemptError as exc:
            errors.append(exc)
            _log_attempt_failure("download", exc)
            if _terminal_category(exc.category):
                break

    _clean_workdir(workdir)
    raise app.UserVisibleError(
        _final_attempt_message(
            errors,
            "❌ نتونستم این کیفیت رو از YouTube دریافت کنم. دوباره امتحان کن.",
        )
    )


def _download_audio_with_client(url: str, client: str, workdir: Path, mode: str) -> Path:
    _clean_workdir(workdir)
    if mode == "low":
        selector = "ba[abr<=80][ext=m4a]/ba[abr<=80]/worstaudio[ext=m4a]/worstaudio"
        fallback_bitrate = "64k"
    else:
        selector = "ba[ext=m4a]/ba"
        fallback_bitrate = "128k"

    source_template = str(workdir / "audio-source.%(ext)s")
    try:
        result = _run(
            [
                app.REAL_YTDLP,
                *_client_args(client),
                "--no-simulate",
                "--format",
                selector,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
                url,
            ],
            app.DOWNLOAD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ClientAttemptError(client, "timeout", "❌ دانلود صدا بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        raise _attempt_error(client, exc) from exc

    source = app.result_path(result, workdir, prefix="audio-source.")
    if source is None:
        raise ClientAttemptError(client, "missing-file", "❌ فایل صوتی بعد از دانلود پیدا نشد.")

    target = workdir / "Vexa.m4a"
    if source.suffix.lower() == ".m4a":
        source.replace(target)
        print(f"youtube audio downloaded client={client} mode={mode} native=m4a", flush=True)
        return target

    try:
        _run(
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
            1200,
        )
    except subprocess.TimeoutExpired as exc:
        raise ClientAttemptError(client, "timeout", "❌ تبدیل فایل صوتی بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        raise ClientAttemptError(client, "conversion", "❌ تبدیل فایل صوتی به M4A انجام نشد.", detail) from exc

    if not target.exists() or target.stat().st_size <= 0:
        raise ClientAttemptError(client, "missing-file", "❌ فایل صوتی نهایی ساخته نشد.")
    print(f"youtube audio downloaded client={client} mode={mode} converted=m4a", flush=True)
    return target


def download_audio(url: str, workdir: Path, mode: str) -> Path:
    if mode not in app.SUPPORTED_AUDIO_MODES:
        raise app.UserVisibleError("❌ حالت صوتی انتخاب‌شده پشتیبانی نمی‌شه.")

    cached_metadata = app.load_metadata_cache(url)
    cached_client = _load_session_client(cached_metadata)
    errors: list[ClientAttemptError] = []

    for client in _client_order(cached_client):
        try:
            return _download_audio_with_client(url, client, workdir, mode)
        except ClientAttemptError as exc:
            errors.append(exc)
            _log_attempt_failure("audio", exc)
            if _terminal_category(exc.category):
                break

    _clean_workdir(workdir)
    raise app.UserVisibleError(
        _final_attempt_message(errors, "❌ فایل صوتی قابل دانلود پیدا نشد. دوباره امتحان کن.")
    )


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> None:
    geometry = _probe_geometry(path)
    data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
        "supports_streaming": "true",
    }
    if geometry:
        width, height, _ = geometry
        data["width"] = str(width)
        data["height"] = str(height)
        duration = int(round(app.probe_duration(path)))
        if duration > 0:
            data["duration"] = str(duration)
    if reply:
        data["reply_parameters"] = json.dumps({"message_id": request_message_id})

    try:
        with path.open("rb") as handle:
            app.telegram_call(
                token,
                "sendVideo",
                data=data,
                files={"video": (path.name, handle, "video/mp4")},
                timeout=1800,
            )
    except Exception as video_error:
        try:
            with path.open("rb") as handle:
                doc_data: dict[str, Any] = {
                    "chat_id": str(chat_id),
                    "caption": caption[:1024],
                }
                if reply:
                    doc_data["reply_parameters"] = json.dumps({"message_id": request_message_id})
                app.telegram_call(
                    token,
                    "sendDocument",
                    data=doc_data,
                    files={"document": (path.name, handle, "video/mp4")},
                    timeout=1800,
                )
        except Exception as document_error:
            raise RuntimeError(
                f"Telegram upload failed: {video_error}; document fallback: {document_error}"
            ) from document_error


def install() -> None:
    app.video_formats = video_formats
    app.audio_formats = audio_formats
    app.available_qualities = available_qualities
    app.is_portrait = is_portrait
    app.fetch_metadata = fetch_metadata
    app.inspect_video = inspect_video
    app.download_video = download_video
    app.download_audio = download_audio
    app.send_media_file = send_media_file


if __name__ == "__main__":
    install()
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), app.Handler)
    print(
        f"youtube downloader listening on :{app.PORT} "
        "(fresh single-client extraction/download pipeline)",
        flush=True,
    )
    server.serve_forever()