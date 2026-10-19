import json
import hashlib
import math
import os
import tempfile
import re
import shutil
import signal
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urljoin, parse_qsl, urlencode

import requests

import youtube_app as app

# Match ai-configa's pinned runtime and client strategy. Keep the client that
# produced the quality catalog for the subsequent download as well.
CLIENTS = ("web_embedded", "android_vr")
SESSION_STATE_PATH = Path("/tmp/vexa-youtube-session.json")
ASPECT_TOLERANCE = 0.06
QUALITY_TOLERANCE = 18


def session_state_path() -> Path:
    directory = app.REQUEST_CACHE.get()
    return directory / "session.json" if directory is not None else SESSION_STATE_PATH


class ClientAttemptError(Exception):
    def __init__(self, client: str, category: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.client = client
        self.category = category
        self.message = message
        self.detail = detail


def _client_args(client: str) -> list[str]:
    if client not in CLIENTS:
        raise ValueError("Unsupported YouTube client")
    return [
        "--ignore-config",
        "--no-playlist",
        "--force-ipv4",
        "--js-runtimes", "deno",
        "--extractor-args", f"youtube:player_client={client}",
        "--socket-timeout", "15",
        "--retries", "2",
        "--fragment-retries", "2",
    ]


def _download_args(client: str) -> list[str]:
    # File caps apply to downloads, not metadata: a large best format must not
    # prevent listing smaller quality choices for the same video.
    return [*_client_args(client), "--abort-on-unavailable-fragments",
            "--max-filesize", str(app.DIRECT_TELEGRAM_LIMIT)]


def _run(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    timeout = app.job_timeout(timeout)
    # yt-dlp can spawn FFmpeg. Stop the whole process group on timeout so an
    # expired Workflow cannot leave a child downloading/converting in the VM.
    with subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)
            raise
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command, stdout, stderr)
        return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _classify_ytdlp_error(stderr: str) -> tuple[str, str]:
    value = (stderr or "").lower()

    # Specific format errors MUST be checked before generic "not available".
    if "requested format is not available" in value or "only images are available" in value:
        return "format", "❌ این کیفیت از مسیر فعلی YouTube قابل دریافت نبود."
    if "private video" in value or "this video is private" in value:
        return "private", "❌ این ویدیو Private هست و بدون دسترسی به اکانت قابل دانلود نیست."
    if "members-only" in value or "join this channel" in value:
        return "members", "❌ این ویدیو فقط برای اعضای کانال قابل مشاهده است."
    if any(marker in value for marker in ("age-restricted", "age restricted", "confirm your age", "inappropriate for some users")):
        return "age", "❌ این ویدیو محدودیت سنی داره و بدون ورود به YouTube قابل دانلود نیست."
    if "copyright" in value:
        return "copyright", "❌ این ویدیو به‌خاطر محدودیت صاحب محتوا قابل دانلود نیست."
    if "unsupported url" in value:
        return "unsupported", "❌ این لینک YouTube قابل دانلود نیست. لینک مستقیم ویدیو یا Shorts رو بفرست."
    if "sign in to confirm" in value or "not a bot" in value:
        return "botcheck", "❌ YouTube برای این درخواست تأیید ورود می‌خواهد؛ دریافت ویدیو از این سرور فعلاً ممکن نیست."
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
                "--skip-download",
                "--dump-single-json",
                "--no-warnings",
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
        path = session_state_path()
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(state), encoding="utf-8")
        temp.replace(path)
    except Exception as exc:
        print(f"youtube session state write failed: {type(exc).__name__}: {exc}", flush=True)


def _load_session_client(metadata: dict[str, Any] | None = None) -> str | None:
    try:
        state = json.loads(session_state_path().read_text(encoding="utf-8"))
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
        return "❌ YouTube برای این درخواست تأیید ورود می‌خواهد؛ دریافت ویدیو از این سرور فعلاً ممکن نیست."
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
            if _terminal_category(exc.category):
                break
        except app.UserVisibleError:
            raise

    raise app.UserVisibleError(
        _final_attempt_message(errors, "❌ اطلاعات ویدیو از YouTube دریافت نشد. دوباره امتحان کن.")
    )


def _format_size(item: dict[str, Any], duration: float) -> tuple[int, bool] | None:
    for key in ("filesize", "filesize_approx"):
        value = item.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
            return round(value), key != "filesize"
    bitrate = item.get("tbr") or item.get("abr")
    if isinstance(bitrate, (int, float)) and math.isfinite(bitrate) and bitrate > 0 and duration > 0:
        return round(duration * bitrate * 1000 / 8), True
    return None


def _selection_size(selected: dict[str, Any], audio_mode: str | None = None) -> dict[str, Any] | None:
    duration = float(selected.get("duration") or 0)
    if audio_mode and selected.get("ext") != "m4a":
        # Match the existing AAC conversion bitrate.
        if duration <= 0:
            return None
        return {"bytes": round(duration * (64_000 if audio_mode == "low" else 128_000) / 8), "estimated": True}
    formats = selected.get("requested_formats") or [selected]
    sizes = [_format_size(item, duration) for item in formats]
    if not sizes or any(size is None for size in sizes):
        return None
    # Video is remuxed/merged, so container overhead makes the final size approximate.
    return {"bytes": sum(size[0] for size in sizes),
            "estimated": not audio_mode or any(size[1] for size in sizes)}


def quality_sizes(metadata: dict[str, Any]) -> dict[str, Any]:
    """Resolve the same selectors locally, using cached metadata without network requests."""
    result: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="youtube-sizes-") as directory:
        info = Path(directory) / "info.json"
        info.write_text(json.dumps(metadata), encoding="utf-8")
        choices = [(str(q), "bv*+ba/b", f"res:{q},+codec:avc:m4a,ext:mp4:m4a", None)
                   for q in available_qualities(metadata)]
        if audio_formats(metadata):
            choices += [("low", "ba[abr<=80][ext=m4a]/ba[abr<=80]/worstaudio[ext=m4a]/worstaudio", None, "low"),
                        ("hq", "ba[ext=m4a]/ba", None, "hq")]
        for key, selector, sort, mode in choices:
            command = [app.REAL_YTDLP, "--ignore-config", "--load-info-json", str(info),
                       "--skip-download", "--no-check-formats", "--dump-single-json", "--no-warnings",
                       "--format", selector]
            if sort:
                command += ["--format-sort", sort]
            try:
                selected = json.loads(_run(command, 10).stdout)
                size = _selection_size(selected, mode)
                if size:
                    result[key] = size
            except (subprocess.SubprocessError, OSError, ValueError, TypeError):
                # A missing size must not block the working quality catalog.
                continue
    return result


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
            "sizes": quality_sizes(metadata),
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
                *_download_args(client),
                "--no-simulate",
                "--concurrent-fragments",
                "8",
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
                *_download_args(client),
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


def music_candidates(query: str) -> list[dict[str, Any]]:
    query = " ".join(query.split())
    if not 2 <= len(query) <= 200:
        raise app.UserVisibleError("❌ نام آهنگ و خواننده را دقیق‌تر بنویس.")
    try:
        result = _run([app.REAL_YTDLP, "--ignore-config", "--force-ipv4", "--flat-playlist",
                       "--skip-download", "--dump-single-json", "--no-warnings", "--socket-timeout", "15",
                       "--retries", "1", "--extractor-retries", "1", "--playlist-end", "5", "--", f"ytsearch5:{query}"], 60)
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise ValueError("Invalid search metadata")
        entries = data.get("entries") or []
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        raise app.UserVisibleError("❌ جست‌وجوی آهنگ از YouTube کامل نشد؛ نام آهنگ و خواننده را دوباره بفرست.") from exc

    def normalized(value: str) -> str:
        return unicodedata.normalize("NFKC", value).casefold().replace("ي", "ی").replace("ك", "ک")

    terms = set(re.findall(r"\w+", normalized(query)))
    def score(item: dict[str, Any]) -> float:
        title = normalized(str(item.get("title") or ""))
        uploader = normalized(str(item.get("channel") or item.get("uploader") or ""))
        words = set(re.findall(r"\w+", title + " " + uploader))
        value = 20 * len(terms & words) / max(1, len(terms))
        value += 2 if "official audio" in title else 1 if "official" in title or "topic" in uploader else 0
        for variant in ("cover", "karaoke", "remix", "slowed", "sped", "live", "ریمیکس", "کاور"):
            if variant not in terms and variant in words:
                value -= 5
        return value

    seen, candidates = set(), []
    for item in entries:
        if not isinstance(item, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", str(item.get("id") or "")):
            continue
        if item.get("is_live") or item.get("live_status") in {"is_live", "is_upcoming"} or item["id"] in seen:
            continue
        seen.add(item["id"])
        candidates.append(item)
    # Preserve YouTube's order for ties; explicit remix/cover requests retain their variants.
    return sorted(candidates, key=score, reverse=True)


def prepare_music(query: str, workdir: Path) -> tuple[Path, str, str, str]:
    candidates = music_candidates(query)
    if not candidates:
        raise app.UserVisibleError("❌ آهنگی با این نام پیدا نشد؛ نام خواننده را هم بنویس.")
    selected = None
    last_error = None
    for item in candidates[:3]:
        url = f"https://www.youtube.com/watch?v={item['id']}"
        try:
            metadata = fetch_metadata(url)
            if not audio_formats(metadata):
                continue
            selected = metadata, url
            break
        except app.UserVisibleError as exc:
            last_error = exc
    if not selected:
        raise last_error or app.UserVisibleError("❌ فایل صوتی قابل دریافت برای این آهنگ پیدا نشد.")
    metadata, url = selected
    return prepare_music_file(metadata, url, workdir, query)


def prepare_music_url(url: str, workdir: Path) -> tuple[Path, str, str, str]:
    match = re.fullmatch(r"https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})", url)
    if not match:
        raise app.UserVisibleError("❌ لینک آهنگ پلی‌لیست معتبر نیست.")
    metadata = fetch_metadata(url)
    if not audio_formats(metadata):
        raise app.UserVisibleError("❌ این مورد فایل صوتی قابل دانلود ندارد.")
    return prepare_music_file(metadata, url, workdir, "Music")


def playlist_entries(url: str, start: int, end: int) -> tuple[str, list[dict[str, Any]]]:
    if not re.fullmatch(r"https://www\.youtube\.com/playlist\?list=[A-Za-z0-9_-]{6,150}", url) or not (1 <= start <= end <= 10000 and end - start < 20):
        raise app.UserVisibleError("❌ لینک یا بازهٔ پلی‌لیست معتبر نیست؛ هر درخواست حداکثر 20 آهنگ.")
    try:
        result = _run([app.REAL_YTDLP, "--ignore-config", "--force-ipv4", "--flat-playlist", "--yes-playlist",
                       "--skip-download", "--dump-single-json", "--ignore-errors", "--no-warnings", "--socket-timeout", "15",
                       "--retries", "1", "--extractor-retries", "1", "--playlist-items", f"{start}:{end}", "--", url], 90)
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
            raise ValueError("Missing playlist entries")
        entries = []
        for offset, item in enumerate(data["entries"][:20]):
            if not isinstance(item, dict):
                entries.append({"id": None, "index": start + offset, "title": "Unavailable"})
                continue
            index = int(item.get("playlist_index") or start + offset)
            # Keep unavailable rows so their positions can be reported without sending another track.
            valid = re.fullmatch(r"[A-Za-z0-9_-]{11}", str(item.get("id") or ""))
            available = bool(valid) and not item.get("is_live") and item.get("live_status") not in {"is_live", "is_upcoming"}
            if start <= index <= end:
                entries.append({"id": item.get("id") if available else None, "index": index,
                                "title": str(item.get("title") or "Unavailable")[:180]})
        if not entries:
            raise ValueError("Empty playlist range")
        return str(data.get("title") or "YouTube Playlist")[:180], entries
    except (subprocess.SubprocessError, ValueError, TypeError, OSError) as exc:
        raise app.UserVisibleError("❌ پلی‌لیست یا این بازه قابل دریافت نیست؛ لینک عمومی و بازهٔ درست را بفرست.") from exc


def prepare_music_file(metadata: dict[str, Any], url: str, workdir: Path, query: str) -> tuple[Path, str, str, str]:
    source = download_audio(url, workdir, "hq")
    title = str(metadata.get("track") or metadata.get("title") or query)[:180]
    artist = str(metadata.get("artist") or metadata.get("creator") or metadata.get("uploader") or "").removesuffix(" - Topic")[:120]
    target = workdir / "Music.mp3"
    try:
        _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(source),
              "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "192k",
              "-metadata", f"title={title}", "-metadata", f"artist={artist}", str(target)], 600)
    except subprocess.SubprocessError as exc:
        raise app.UserVisibleError("❌ آماده‌سازی فایل MP3 انجام نشد.") from exc
    app.validate_file_size(target)
    duration = app.probe_duration(target)
    expected = float(metadata.get("duration") or 0)
    if duration <= 0 or (expected and duration < expected - 2):
        raise app.UserVisibleError("❌ فایل آهنگ کامل دریافت نشد؛ فایل ناقص ارسال نشد.")
    return target, title, artist, url


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> Any:
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

    with path.open("rb") as handle:
        return app.telegram_call(
            token, "sendVideo", data=data,
            files={"video": (path.name, handle, "video/mp4")}, timeout=1800,
        )


SOCIAL_NAMES = {"x": "X", "pinterest": "Pinterest", "tiktok": "TikTok", "soundcloud": "SoundCloud", "aparat": "Aparat"}
SOCIAL_MAX_ITEMS = 20
PINTEREST_DOMAINS = "com fr de ch jp cl ca it co.uk nz ru com.au at pt co.kr es com.mx dk ph th com.uy co nl info kr ie vn com.vn ec mx in pe co.at hu co.in co.nz id com.ec com.py tw be uk com.bo com.pe".split()


def social_url(value: str, platform: str) -> str:
    """Validate the same individual-post contract at both trust boundaries."""
    p = urlparse(value)
    if platform not in SOCIAL_NAMES or p.scheme not in {"http", "https"} or p.username or p.password or p.port:
        raise app.UserVisibleError("❌ لینک معتبر این سرویس را بفرست.")
    host, path = (p.hostname or "").lower(), p.path
    if platform == "aparat" and host in {"aparat.com", "www.aparat.com"}:
        m = re.fullmatch(r"/(?:v/|video/video/embed/videohash/)([A-Za-z0-9]{1,32})(?:/[^?#]*)?", path)
        if m:
            return f"https://www.aparat.com/v/{m[1]}"
    if platform == "x" and host in {"x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"}:
        m = re.fullmatch(r"/(?:[A-Za-z0-9_]+/status|i/web/status|statuses)/(\d{1,25})(?:/video/([1-9]\d?))?/?", path)
        if m:
            return f"https://x.com/i/status/{m[1]}" + (f"/video/{m[2]}" if m[2] else "")
    if platform == "pinterest" and any(host in {f"pinterest.{d}", f"www.pinterest.{d}"} or re.fullmatch(r"[a-z]{2}\.pinterest\." + re.escape(d), host) for d in PINTEREST_DOMAINS):
        m = re.fullmatch(r"/pin/(?:[\w-]+--)?(\d{1,25})(?:/sent)?/?", path)
        if m:
            return f"https://www.pinterest.com/pin/{m[1]}/"
    short_hosts = {"pinterest": {"pin.it"}, "tiktok": {"vm.tiktok.com", "vt.tiktok.com"}, "soundcloud": {"on.soundcloud.com"}}
    if host in short_hosts.get(platform, set()) and re.fullmatch(r"/[A-Za-z0-9_-]{3,128}/?", path):
        return f"https://{host}{path}"
    if platform == "tiktok" and host in {"tiktok.com", "www.tiktok.com", "m.tiktok.com"}:
        m = re.fullmatch(r"/@([\w.-]+)/(video|photo)/(\d{1,25})/?", path)
        if m:
            return f"https://www.tiktok.com/@{m[1]}/{m[2]}/{m[3]}"
        if re.fullmatch(r"/t/[A-Za-z0-9_-]{3,128}/?", path):
            return f"https://www.tiktok.com{path}"
    if platform == "soundcloud" and host in {"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"}:
        if (re.fullmatch(r"/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/?", path)
            and not re.match(r"/(?:discover|search|you|stations|charts|stream|upload)/", path, re.I)
            and not re.search(r"/(?:sets|tracks|albums|likes|reposts|popular-tracks|spotlight|comments)/?$", path, re.I)):
            return "https://soundcloud.com" + path.rstrip("/")
    raise app.UserVisibleError("❌ لینک یک پست یا آهنگ را بفرست؛ پروفایل، بورد و پلی‌لیست پشتیبانی نمی‌شود.")


def social_error(platform: str, detail: str) -> app.UserVisibleError:
    name = SOCIAL_NAMES[platform]
    s = detail.lower()
    if any(x in s for x in ("429", "rate limit", "ip address is blocked", "captcha", "challenge", "403", "sign in", "login", "log in", "authorization", "private")):
        return app.UserVisibleError(f"❌ {name} دسترسی این سرور به پست را نپذیرفت یا پست نیاز به ورود دارد؛ دانلود انجام نشد.")
    if any(x in s for x in ("404", "not found", "deleted", "unavailable", "no video", "empty")):
        return app.UserVisibleError(f"❌ پست {name} حذف شده، در دسترس نیست یا رسانهٔ قابل دانلود ندارد.")
    return app.UserVisibleError(f"❌ دریافت فایل {name} کامل نشد؛ لینک عمومی پست یا آهنگ را دوباره بفرست.")


def pinterest_redirect_url(value: str) -> str:
    """Allow Pinterest's exact shortener endpoint only within redirect resolution."""
    p = urlparse(value)
    if (p.scheme == "https" and p.hostname == "api.pinterest.com"
            and not p.username and not p.password and not p.port
            and re.fullmatch(r"/url_shortener/[A-Za-z0-9_-]{3,128}/redirect/?", p.path)):
        return f"https://api.pinterest.com{p.path}"
    result = social_url(value, "pinterest")
    p = urlparse(result)
    if p.hostname == "pin.it":
        # Match the pinned gallery-dl PinterestPinitExtractor. The share website
        # can return an app landing page instead of a usable HTTP redirect.
        return f"https://api.pinterest.com/url_shortener/{p.path.strip('/')}/redirect/"
    return result


def resolve_social_url(value: str, platform: str) -> str:
    current = social_url(value, platform)
    p = urlparse(current)
    if p.hostname not in {"pin.it", "vm.tiktok.com", "vt.tiktok.com", "on.soundcloud.com"} and not p.path.startswith("/t/"):
        return current
    if platform == "pinterest":
        current = pinterest_redirect_url(current)
    try:
        for _ in range(6):
            # Validate every hop before requesting it; requests must not follow redirects.
            request = requests.head if platform == "pinterest" else requests.get
            with request(current, stream=True, allow_redirects=False, timeout=(10, 15),
                              headers={"User-Agent": "Mozilla/5.0"}) as response:
                if response.is_redirect:
                    destination = urljoin(current, response.headers.get("Location", ""))
                    current = pinterest_redirect_url(destination) if platform == "pinterest" else social_url(destination, platform)
                    if platform == "pinterest" and urlparse(current).hostname == "www.pinterest.com":
                        return current  # Already an exact Pin; do not fetch the share/login HTML.
                elif response.ok:
                    if platform == "pinterest":
                        raise app.UserVisibleError("❌ لینک کوتاه پینترست باز نشد؛ لینک کامل همان پست را بفرست.")
                    result = social_url(current, platform)
                    if urlparse(result).hostname in {"pin.it", "vm.tiktok.com", "vt.tiktok.com", "on.soundcloud.com"} or urlparse(result).path.startswith("/t/"):
                        raise app.UserVisibleError("❌ لینک کوتاه باز نشد؛ لینک کامل پست را بفرست.")
                    return result
                else:
                    raise social_error(platform, str(response.status_code))
        raise app.UserVisibleError("❌ لینک کوتاه بیش از حد تغییر مسیر دارد؛ لینک کامل را بفرست.")
    except requests.RequestException as exc:
        raise social_error(platform, type(exc).__name__) from exc


def social_cdn_url(value: str, platform: str) -> str:
    p = urlparse(value)
    roots = {"x": ("twimg.com",), "pinterest": ("pinimg.com",),
             "aparat": ("aparat.com",),
             "soundcloud": ("sndcdn.com", "soundcloud.com", "media-streaming.soundcloud.cloud"),
             "tiktok": ("tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-in.com", "tiktokv.com", "tiktok.com", "byteoversea.com", "ibytedtos.com", "ibyteimg.com", "byteimg.com", "muscdn.com")}
    host = (p.hostname or "").lower()
    if p.scheme != "https" or p.username or p.password or p.port or not any(host == root or host.endswith("." + root) for root in roots[platform]):
        raise app.UserVisibleError("❌ آدرس فایل خارج از میزبان‌های معتبر این سرویس بود؛ دانلود متوقف شد.")
    return value


def social_json(command: list[str], platform: str, timeout: int = 90) -> Any:
    # Metadata can contain signed URLs; keep it bounded and never log stdout/stderr.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            result = subprocess.run(command, stdout=output, stderr=errors, timeout=timeout, check=False)
            errors.seek(0)
            detail = errors.read(16384).decode("utf-8", "replace")
            if result.returncode:
                raise social_error(platform, detail)
            if output.tell() > 12_000_000:
                raise app.UserVisibleError("❌ اطلاعات این پست بیش از حد بزرگ است.")
            output.seek(0)
            data = json.load(output)
            if isinstance(data, list):
                for row in data:
                    if isinstance(row, list) and row and row[0] == -1:
                        raise social_error(platform, str(row[-1]))
                if not any(isinstance(row, list) and len(row) == 3 and row[0] == 3 for row in data) and detail:
                    raise social_error(platform, detail)
            return data
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            raise social_error(platform, type(exc).__name__) from exc


def social_ytdlp_entries(url: str, platform: str) -> list[dict[str, Any]]:
    # Honor the runtime's OS/SSL_CERT_FILE trust store; TLS verification stays on.
    common = [app.REAL_YTDLP, "--ignore-config", "--compat-options", "no-certifi", "--no-playlist", "--playlist-end", str(SOCIAL_MAX_ITEMS + 1),
              "--use-extractors", "Twitter,TikTok,Soundcloud", "--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1",
              "--skip-download", "--dump-single-json", "--no-warnings"]
    try:
        data = social_json([*common, "--", url], platform)
    except app.UserVisibleError:
        if platform != "x":
            raise
        # A second official extractor mode, not an untrusted third-party proxy.
        data = social_json([*common, "--extractor-args", "twitter:api=syndication", "--", url], platform)
    entries = data.get("entries") if data.get("_type") in {"playlist", "multi_video"} else [data]
    if not isinstance(entries, list) or not entries:
        raise social_error(platform, "empty")
    if len(entries) > SOCIAL_MAX_ITEMS:
        raise app.UserVisibleError("❌ این پست بیش از 20 فایل دارد؛ فایل‌ها ارسال نشدند.")
    expected = {"x": "Twitter", "tiktok": "TikTok", "soundcloud": "Soundcloud"}[platform]
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("extractor_key", data.get("extractor_key")) != expected or not entry.get("formats"):
            raise social_error(platform, "no video")
        if entry.get("is_live") or entry.get("live_status") in {"is_live", "is_upcoming"}:
            raise app.UserVisibleError("❌ این مسیر برای پست منتشرشده است؛ لایو این سرویس پشتیبانی نمی‌شود.")
        formats = [f for f in entry["formats"] if not f.get("has_drm")]
        if platform == "soundcloud":
            formats = [f for f in formats if "preview" not in str(f.get("format_id", "")).lower() and not f.get("is_preview")
                       and "/preview/" not in str(f.get("url", "")) and not re.search(r"/(?:preview|playlist)/0/30/", str(f.get("url", "")))]
        if not formats:
            raise app.UserVisibleError("❌ فقط پیش‌نمایش یا نسخهٔ محدود آهنگ در دسترس است؛ فایل کامل ارسال نشد." if platform == "soundcloud" else "❌ نسخهٔ قابل دریافت این ویدیو محدود است؛ فایل ارسال نشد.")
        for fmt in formats:
            social_cdn_url(fmt["url"], platform)
            for fragment in fmt.get("fragments") or []:
                social_cdn_url(urljoin(fmt["url"], fragment.get("url", "")), platform)
            fmt["http_headers"] = {"User-Agent": "Mozilla/5.0"}
        entry["formats"] = formats
        entry["http_headers"] = {"User-Agent": "Mozilla/5.0"}
        entry.pop("requested_downloads", None)
        entry.pop("requested_formats", None)
    return entries


def aparat_entries(url: str) -> list[dict[str, Any]]:
    """Use Aparat's current first-party rendition API; legacy embed extraction is broken."""
    uid = social_url(url, "aparat").rsplit("/", 1)[-1]
    try:
        with requests.get(f"https://www.aparat.com/api/fa/v1/video/video/show/videohash/{uid}",
                          stream=True, allow_redirects=False, timeout=(10, 20), headers={"User-Agent": "Mozilla/5.0"}) as response:
            if response.status_code != 200:
                raise social_error("aparat", str(response.status_code))
            chunks, size, deadline = [], 0, time.monotonic() + 45
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > 2_000_000 or time.monotonic() > deadline:
                    raise app.UserVisibleError("❌ اطلاعات ویدیوی آپارات بیش از سقف حجم یا زمان بود.")
                chunks.append(chunk)
            attributes = json.loads(b"".join(chunks))["data"]["attributes"]
        if str(attributes.get("uid")) != uid or attributes.get("deleted") in {True, 1, "1", "true"}:
            raise social_error("aparat", "unavailable")
        if attributes.get("can_download") not in {True, 1, "1", "true"}:
            raise app.UserVisibleError("❌ دانلود این ویدیوی آپارات فعال نیست یا به دسترسی بیشتری نیاز دارد.")
        formats = []
        for item in attributes.get("file_link_all") or []:
            if not isinstance(item, dict):
                continue
            label = str(item.get("profile") or item.get("text") or "")
            height = re.search(r"(\d{3,4})[pP]?", label)
            for candidate in item.get("urls") or []:
                media_url = social_cdn_url(candidate, "aparat")
                formats.append({"format_id": f"http-{len(formats)}", "url": media_url, "ext": "mp4", "protocol": "https",
                                "height": int(height[1]) if height else None, "http_headers": {"User-Agent": "Mozilla/5.0"}})
        if not formats:
            raise social_error("aparat", "no video")
        return [{"id": uid, "extractor_key": "Aparat", "title": str(attributes.get("title") or "Aparat")[:180],
                 "duration": float(attributes.get("duration") or 0), "formats": formats}]
    except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
        raise social_error("aparat", type(exc).__name__) from exc


def social_gallery_entries(url: str, platform: str) -> list[dict[str, Any]]:
    data = social_json([sys.executable, "-m", "gallery_dl", "--config-ignore", "--no-input", "--dump-json",
                        "--range", f"1-{SOCIAL_MAX_ITEMS + 1}", "--retries", "1", "--http-timeout", "15",
                        "-o", "extractor.tiktok.audio=false", "-o", "extractor.tiktok.covers=false",
                        "-o", "output.private=true", "--", url], platform)
    entries = []
    for row in data if isinstance(data, list) else []:
        if not isinstance(row, list) or len(row) != 3 or row[0] != 3 or not isinstance(row[2], dict):
            continue
        media_url, info = str(row[1]).removeprefix("ytdl:"), row[2]
        ext = str(info.get("extension") or "").lower()
        if ext not in {"jpg", "jpeg", "png", "webp", "avif", "mp4", "m3u8", "webm", "mov"}:
            continue
        if info.get("category") != platform:
            raise social_error(platform, "invalid extractor")
        social_cdn_url(media_url, platform)
        fallbacks = [social_cdn_url(f, platform) for f in info.get("_fallback", []) if isinstance(f, str)]
        manifest = info.get("_ytdl_manifest") == "hls"
        # Prefer Pinterest's native MP4 alternative over fetching many HLS parts.
        # Keep HLS only when no complete MP4 rendition is exposed by the extractor.
        if platform == "pinterest" and manifest:
            direct = next((f for f in fallbacks if urlparse(f).path.lower().endswith(".mp4")), None)
            if direct:
                media_url, fallbacks, manifest = direct, [], False
        entries.append({"url": media_url, "fallbacks": fallbacks, "ext": "m3u8" if manifest else ext,
                        "image": ext in {"jpg", "jpeg", "png", "webp", "avif"},
                        "title": str(info.get("title") or info.get("description") or SOCIAL_NAMES[platform])[:180],
                        "id": str(info.get("id") or ""), "duration": info.get("duration", 0) if platform == "tiktok" else 0})
    if not entries:
        raise social_error(platform, "empty")
    if len(entries) > SOCIAL_MAX_ITEMS:
        raise app.UserVisibleError("❌ این پست بیش از 20 فایل دارد؛ فایل‌ها ارسال نشدند.")
    return entries


def social_download_http(url: str, target: Path, platform: str, budget: int, deadline: float) -> None:
    current = social_cdn_url(url, platform)
    try:
        for _ in range(6):
            with requests.get(current, stream=True, timeout=(10, 30), allow_redirects=False,
                              headers={"User-Agent": "Mozilla/5.0"}) as response:
                if response.is_redirect:
                    current = social_cdn_url(urljoin(current, response.headers.get("Location", "")), platform)
                    continue
                if not response.ok:
                    raise social_error(platform, str(response.status_code))
                if int(response.headers.get("Content-Length") or 0) > budget:
                    raise app.UserVisibleError("❌ مجموع حجم فایل‌های پست از سقف 2 گیگابایت بیشتر است.")
                received = 0
                with target.open("wb") as output:
                    for chunk in response.iter_content(256 * 1024):
                        received += len(chunk)
                        if received > budget or time.monotonic() > deadline:
                            raise app.UserVisibleError("❌ دریافت فایل از سقف حجم یا زمان گذشت؛ فایل ناقص ارسال نشد.")
                        output.write(chunk)
                if not received or (response.headers.get("Content-Length") and not response.headers.get("Content-Encoding") and received != int(response.headers["Content-Length"])):
                    raise app.UserVisibleError("❌ فایل کامل دریافت نشد؛ فایل ناقص ارسال نشد.")
                return
        raise social_error(platform, "redirect limit")
    except (requests.RequestException, ValueError) as exc:
        raise social_error(platform, type(exc).__name__) from exc


def social_prepare_entry(entry: dict[str, Any], platform: str, workdir: Path, budget: int, deadline: float, *, audio_only: bool = False) -> dict[str, Any]:
    audio_request = audio_only or platform == "soundcloud"
    if audio_request and entry.get("image"):
        raise app.UserVisibleError("❌ این آیتم عکس است و صدای ویدیو ندارد.")
    target = workdir / ("Image.jpg" if entry.get("image") else "Music.mp3" if audio_request else "Video.mp4")
    source = workdir / ("source." + (entry.get("ext", "bin") if entry.get("image") else "bin"))
    remaining = lambda: max(1, min(1200, int(deadline - time.monotonic())))
    try:
        if "formats" in entry or entry.get("ext") == "m3u8":
            info_path = workdir / "media.json"
            info = entry
            if "formats" not in entry:
                # A master playlist must be expanded, not downloaded as a media
                # fragment. This Generic extraction is limited to a validated CDN
                # manifest, never a user-supplied webpage or embedded provider.
                info = social_json([app.REAL_YTDLP, "--ignore-config", "--compat-options", "no-certifi", "--no-playlist",
                                    "--use-extractors", "Generic", "--socket-timeout", "15", "--retries", "1",
                                    "--skip-download", "--dump-single-json", "--no-warnings", "--", social_cdn_url(entry["url"], platform)], platform)
                if not isinstance(info, dict) or not info.get("formats"):
                    raise social_error(platform, "empty HLS")
                for fmt in info["formats"]:
                    social_cdn_url(fmt["url"], platform)
                    if fmt.get("has_drm"):
                        raise app.UserVisibleError("❌ نسخهٔ قابل دریافت این فایل محدود است؛ دانلود انجام نشد.")
            info_path.write_text(json.dumps(info), encoding="utf-8")
            fmt = "bestaudio/best" if audio_request else "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/bv[height<=1080][ext=mp4]/bv[height<=1080]/b/bv"
            _run([app.REAL_YTDLP, "--ignore-config", "--compat-options", "no-certifi", "--no-playlist", "--quiet", "--no-progress", "--socket-timeout", "15",
                  "--retries", "1", "--fragment-retries", "1", "--abort-on-unavailable-fragments", "--concurrent-fragments", "8",
                  "--max-filesize", str(budget), "--merge-output-format", "mp4", "--format", fmt,
                  "--output", str(workdir / "download.%(ext)s"), "--load-info-json", str(info_path)], remaining())
            files = [p for p in workdir.glob("download.*") if p.suffix not in {".part", ".ytdl", ".json"} and ".f" not in p.stem]
            if len(files) != 1:
                raise app.UserVisibleError("❌ فایل کامل پیدا نشد؛ ممکن است حجم آن از سقف ارسال بیشتر باشد.")
            source = files[0]
        else:
            urls = [entry["url"], *entry.get("fallbacks", [])]
            for index, url in enumerate(dict.fromkeys(urls)):
                try:
                    social_download_http(url, source, platform, budget, deadline)
                    break
                except app.UserVisibleError:
                    if index + 1 == len(dict.fromkeys(urls)):
                        raise
                    source.unlink(missing_ok=True)
        if not source.is_file() or not 0 < source.stat().st_size <= budget:
            raise app.UserVisibleError("❌ فایل خالی یا بیش از حد بزرگ بود؛ ارسال نشد.")
        title = str(entry.get("track") or entry.get("title") or SOCIAL_NAMES[platform])[:180]
        artist = str(entry.get("artist") or entry.get("uploader") or "")[:120]
        if entry.get("image"):
            _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                  "-format_whitelist", "image2,jpeg_pipe,png_pipe,webp_pipe,avif,mov",
                  "-i", str(source), "-frames:v", "1", "-vf", "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease", "-q:v", "2", str(target)], remaining())
            method, details = "sendPhoto", {}
            geometry = _probe_geometry(target)
            if not geometry:
                raise app.UserVisibleError("❌ تصویر سالم برای ارسال ساخته نشد.")
            if target.stat().st_size > 10_000_000 or max(geometry[:2]) / min(geometry[:2]) > 20:
                method = "sendDocument"
        elif audio_request:
            probe = json.loads(_run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", str(source)], 45).stdout)
            if not any(s.get("codec_type") == "audio" for s in probe.get("streams", [])):
                raise app.UserVisibleError("❌ این ویدیو صدا ندارد؛ فایل صوتی ساخته نشد.")
            _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", str(source),
                  "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-metadata", f"title={title}", "-metadata", f"artist={artist}", str(target)], remaining())
            method, details = "sendAudio", {"title": title, "performer": artist}
        else:
            probe = json.loads(_run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", str(source)], 45).stdout)
            streams = probe.get("streams", [])
            video = next((s for s in streams if s.get("codec_type") == "video"), None)
            if not video:
                raise social_error(platform, "no video")
            audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
            codecs = ["-c:v", "copy"] if video.get("codec_name") == "h264" else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
            codecs += ["-c:a", "copy"] if audio.get("codec_name") in {None, "aac"} else ["-c:a", "aac", "-b:a", "192k"]
            _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", str(source),
                  "-map", "0:v:0", "-map", "0:a:0?", *codecs, "-movflags", "+faststart", str(target)], remaining())
            method, details = "sendVideo", {"width": int(video["width"]), "height": int(video["height"]), "supports_streaming": "true"}
        if not 0 < target.stat().st_size <= min(budget, app.DIRECT_TELEGRAM_LIMIT):
            raise app.UserVisibleError("❌ حجم خروجی بیش از سقف ارسال است؛ فایل ارسال نشد.")
        if method in {"sendAudio", "sendVideo"}:
            duration = app.probe_duration(target)
            expected = float(entry.get("duration") or 0)
            if duration <= 0 or (expected and duration < expected - 2):
                raise app.UserVisibleError("❌ فایل کامل دریافت نشد؛ فایل ناقص ارسال نشد.")
            details["duration"] = int(round(duration))
        source.unlink(missing_ok=True)
        (workdir / "media.json").unlink(missing_ok=True)
        return {"path": target, "method": method, "data": details, "title": title,
                "hasAudio": bool(audio) if method == "sendVideo" else False}
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as exc:
        raise social_error(platform, type(exc).__name__) from exc


def social_cache_key(platform: str, url: str, index: int, entry: dict[str, Any], audio_only: bool) -> str:
    # Bind reuse to the freshly extracted item, not just its position in a post.
    # Ignore signing parameters, but keep content selectors in query strings.
    def asset_key(value: str) -> str:
        parsed = urlparse(value)
        auth_keys = {"token", "sig", "signature", "expires", "expire", "policy", "key-pair-id", "x-signature", "x-expires"}
        query = sorted((key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True)
                       if key.lower() not in auth_keys and not key.lower().startswith(("x-amz-", "x-goog-")))
        return parsed._replace(query=urlencode(query), fragment="").geturl()
    urls = [str(f.get("url") or "") for f in entry.get("formats", [])] if entry.get("formats") else [str(entry.get("url") or "")]
    assets = sorted({asset_key(value) for value in urls if value})
    formats = sorted(json.dumps({key: fmt.get(key) for key in ("format_id", "vcodec", "acodec", "ext", "width", "height", "filesize")}, sort_keys=True)
                     for fmt in entry.get("formats", []))
    identity = {"platform": platform, "url": url, "index": index, "assets": assets,
                "id": str(entry.get("id") or ""), "image": bool(entry.get("image")),
                "title": str(entry.get("track") or entry.get("title") or SOCIAL_NAMES[platform])[:180],
                "artist": str(entry.get("artist") or entry.get("uploader") or "")[:120],
                "duration": entry.get("duration") or 0, "formats": formats, "hasAudio": entry.get("has_audio"),
                "mode": "audio" if audio_only or platform == "soundcloud" else "video", "version": 2}
    return "social:" + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def prepare_social_media(social: dict[str, Any], workdir: Path, *, cache_payload: dict[str, Any] | None = None) -> tuple[str, list[dict[str, Any]]]:
    platform = str(social.get("platform") or "")
    url = resolve_social_url(str(social.get("url") or ""), platform)
    deadline = time.monotonic() + 1500
    if platform == "aparat":
        entries = aparat_entries(url)
    elif platform == "pinterest" or (platform == "tiktok" and "/photo/" in url):
        entries = social_gallery_entries(url, platform)
    else:
        try:
            entries = social_ytdlp_entries(url, platform)
        except app.UserVisibleError:
            if platform != "tiktok":
                raise
            entries = social_gallery_entries(url, platform)
    audio_only = bool(social.get("audioOnly"))
    indexed = list(enumerate(entries))
    if "itemIndex" in social:
        index = social["itemIndex"]
        if not audio_only or type(index) is not int or not 0 <= index < len(entries):
            raise app.UserVisibleError("❌ آیتم انتخاب‌شده در این پست وجود ندارد.")
        indexed = [(index, entries[index])]
    elif audio_only:
        indexed = [(index, entry) for index, entry in indexed if not entry.get("image")]
    if not indexed:
        raise app.UserVisibleError("❌ این پست ویدیویی برای استخراج صدا ندارد.")
    prepared, total = [], 0
    for index, entry in indexed:
        if time.monotonic() >= deadline:
            raise app.UserVisibleError("❌ دریافت پست بیش از حد طول کشید؛ فایل‌ها ارسال نشدند.")
        if total >= app.DIRECT_TELEGRAM_LIMIT:
            raise app.UserVisibleError("❌ مجموع حجم فایل‌های پست از سقف 2 گیگابایت بیشتر است.")
        directory = workdir / f"item-{index + 1}"
        directory.mkdir()
        key = social_cache_key(platform, url, index, entry, audio_only)
        expected_method = "sendAudio" if audio_only or platform == "soundcloud" else "sendVideo"
        cached = app.file_cache(cache_payload, "get", key) if cache_payload and not entry.get("image") else None
        if (isinstance(cached, dict) and cached.get("method") == expected_method
                and isinstance(cached.get("fileId"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", cached["fileId"])
                and isinstance(cached.get("data"), dict)
                and type(cached.get("fileSize")) is int and 0 < cached["fileSize"] <= app.DIRECT_TELEGRAM_LIMIT
                and (expected_method != "sendVideo" or type(cached.get("hasAudio")) is bool)):
            item = {"cached": cached, "method": expected_method, "data": cached["data"], "fileSize": cached["fileSize"],
                    "hasAudio": cached.get("hasAudio", False),
                    "title": str(entry.get("track") or entry.get("title") or SOCIAL_NAMES[platform])[:180]}
        else:
            item = social_prepare_entry(entry, platform, directory, app.DIRECT_TELEGRAM_LIMIT - total, deadline, audio_only=audio_only)
            item["fileSize"] = item["path"].stat().st_size
        total += item["fileSize"]
        if total > app.DIRECT_TELEGRAM_LIMIT:
            raise app.UserVisibleError("❌ مجموع حجم فایل‌های پست از سقف 2 گیگابایت بیشتر است.")
        item["caption"] = f"{item['title']}\n{SOCIAL_NAMES[platform]} {index + 1}/{len(entries)}\n{url}"
        item["index"] = index
        item.update({"cacheKey": key, "entry": entry, "directory": directory})
        prepared.append(item)
    return url, prepared


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
    app.serve()
