import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

import youtube_app as app

CLIENTS = ("mweb", "android_vr", "web_embedded", "web_safari")
SESSION_STATE_PATH = Path("/tmp/vexa-youtube-session.json")
ASPECT_TOLERANCE = 0.06
QUALITY_TOLERANCE = 18


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


def _friendly(stderr: str) -> str:
    return app.friendly_ytdlp_error(stderr or "")


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
        raise app.UserVisibleError("❌ ارتباط با YouTube بیشتر از حد معمول طول کشید. دوباره امتحان کن.") from exc
    except subprocess.CalledProcessError as exc:
        raise app.UserVisibleError(_friendly((exc.stderr or "").strip())) from exc
    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise app.UserVisibleError("❌ اطلاعات ویدیو از YouTube دریافت نشد.") from exc
    if not isinstance(metadata, dict):
        raise app.UserVisibleError("❌ اطلاعات ویدیو از YouTube دریافت نشد.")
    return metadata


def _save_session(metadata: dict[str, Any], client: str) -> None:
    app.save_metadata_cache(metadata)
    state = {
        "client": client,
        "videoId": str(metadata.get("id") or ""),
    }
    temp = SESSION_STATE_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(state), encoding="utf-8")
    temp.replace(SESSION_STATE_PATH)


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
    return (
        protocol == "mhtml"
        or ext == "mhtml"
        or vcodec in {"images", "image"}
        or bool(re.fullmatch(r"sb\d+", format_id))
        or "storyboard" in note
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
        if not str(item.get("format_id") or "").strip():
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
        if not str(item.get("format_id") or "").strip():
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
        cluster = []
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
    return [q for q in app.SUPPORTED_QUALITIES if q in found]


def is_portrait(metadata: dict[str, Any]) -> bool:
    ratio = _source_ratio(metadata)
    return bool(ratio is not None and ratio < 1.0)


def _video_score(item: dict[str, Any], quality: int) -> tuple[int, int, int, float, float]:
    resolution = _short_side(item) or 0
    ext = str(item.get("ext") or "").lower()
    vcodec = str(item.get("vcodec") or "").lower()
    acodec = str(item.get("acodec") or "none").lower()
    try:
        fps = float(item.get("fps") or 0)
    except (TypeError, ValueError):
        fps = 0.0
    try:
        tbr = float(item.get("tbr") or 0)
    except (TypeError, ValueError):
        tbr = 0.0
    return (
        -abs(resolution - quality),
        1 if ext == "mp4" else 0,
        1 if vcodec.startswith("avc1") else 0,
        fps,
        tbr + (1 if acodec != "none" else 0),
    )


def _select_video(metadata: dict[str, Any], quality: int) -> dict[str, Any] | None:
    source_ratio = _source_ratio(metadata)
    candidates = [
        item
        for item in video_formats(metadata)
        if _matches_ratio(item, source_ratio)
        and (resolution := _short_side(item)) is not None
        and abs(resolution - quality) <= QUALITY_TOLERANCE
    ]
    return max(candidates, key=lambda item: _video_score(item, quality)) if candidates else None


def _select_audio(metadata: dict[str, Any], mode: str) -> dict[str, Any] | None:
    formats = audio_formats(metadata)
    if not formats:
        return None

    def abr(item: dict[str, Any]) -> float:
        try:
            return float(item.get("abr") or item.get("tbr") or 0)
        except (TypeError, ValueError):
            return 0.0

    if mode == "low":
        under = [item for item in formats if 0 < abr(item) <= 80]
        pool = under or formats
        return max(
            pool,
            key=lambda item: (
                1 if str(item.get("ext") or "").lower() == "m4a" else 0,
                abr(item) if under else -abr(item),
            ),
        )

    return max(
        formats,
        key=lambda item: (
            abr(item),
            1 if str(item.get("ext") or "").lower() == "m4a" else 0,
        ),
    )


def _safe_format_id(item: dict[str, Any]) -> str:
    format_id = str(item.get("format_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._+:-]+", format_id):
        raise app.UserVisibleError("❌ فرمت ویدیوی YouTube نامعتبر بود.")
    return format_id


def _write_info(metadata: dict[str, Any]) -> None:
    app.save_metadata_cache(metadata)


def _clean_workdir(workdir: Path) -> None:
    for path in workdir.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)


def _download_video_from_metadata(
    metadata: dict[str, Any],
    client: str,
    workdir: Path,
    quality: int,
) -> Path:
    selected = _select_video(metadata, quality)
    if selected is None:
        raise app.UserVisibleError(f"❌ کیفیت {quality}p برای این ویدیو روی این مسیر موجود نیست.")

    video_id = _safe_format_id(selected)
    has_audio = str(selected.get("acodec") or "none").lower() != "none"
    selector = video_id if has_audio else f"{video_id}+ba[ext=m4a]/{video_id}+ba/{video_id}"
    _write_info(metadata)
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")

    try:
        result = _run(
            [
                app.REAL_YTDLP,
                "--load-info-json",
                str(app.METADATA_CACHE_PATH),
                "--force-overwrites",
                "--force-ipv4",
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
                selector,
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
            app.DOWNLOAD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise app.UserVisibleError("❌ دانلود بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        raise app.UserVisibleError(_friendly((exc.stderr or "").strip())) from exc

    path = app.result_path(result, workdir)
    if path is None:
        raise app.UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")

    expected = _ratio(selected)
    if expected:
        probed = _probe_geometry(path)
        if probed is None:
            raise app.UserVisibleError("❌ مشخصات فایل ویدیوی نهایی قابل خواندن نبود.")
        width, height, actual = probed
        if abs(actual - expected) / expected > 0.08:
            raise app.UserVisibleError(f"❌ نسبت تصویر خروجی نادرست شد ({width}×{height}).")
    print(
        f"youtube video downloaded with client={client} format={video_id} quality={quality}",
        flush=True,
    )
    return path


def _download_audio_from_metadata(
    metadata: dict[str, Any],
    client: str,
    workdir: Path,
    mode: str,
) -> Path:
    selected = _select_audio(metadata, mode)
    if selected is None:
        raise app.UserVisibleError("❌ این ویدیو فایل صوتی قابل دانلود نداره.")
    format_id = _safe_format_id(selected)
    _write_info(metadata)
    source_template = str(workdir / "audio-source.%(ext)s")
    try:
        result = _run(
            [
                app.REAL_YTDLP,
                "--load-info-json",
                str(app.METADATA_CACHE_PATH),
                "--force-overwrites",
                "--force-ipv4",
                "--no-simulate",
                "--retries",
                "1",
                "--fragment-retries",
                "1",
                "--socket-timeout",
                "12",
                "--format",
                format_id,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
            ],
            app.DOWNLOAD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise app.UserVisibleError("❌ دانلود صدا بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        raise app.UserVisibleError(_friendly((exc.stderr or "").strip())) from exc

    source = app.result_path(result, workdir, prefix="audio-source.")
    if source is None:
        raise app.UserVisibleError("❌ فایل صوتی بعد از دانلود پیدا نشد.")

    target = workdir / "Vexa.m4a"
    if source.suffix.lower() == ".m4a":
        source.replace(target)
        return target

    bitrate = "64k" if mode == "low" else "128k"
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
                bitrate,
                "-movflags",
                "+faststart",
                str(target),
            ],
            1200,
        )
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
        raise app.UserVisibleError("❌ تبدیل فایل صوتی به M4A انجام نشد.") from exc
    return target


def _client_order(cached: str | None) -> list[str]:
    return ([cached] if cached in CLIENTS else []) + [c for c in CLIENTS if c != cached]


def fetch_metadata(url: str) -> dict[str, Any]:
    errors: list[str] = []
    for client in CLIENTS:
        try:
            metadata = _fetch_metadata_for_client(url, client)
            app.validate_video_metadata(metadata)
            if not available_qualities(metadata) and not audio_formats(metadata):
                continue
            _save_session(metadata, client)
            print(f"youtube metadata selected client={client}", flush=True)
            return metadata
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"youtube metadata client={client} failed: {exc}", flush=True)
    raise app.UserVisibleError(errors[-1] if errors else "❌ اطلاعات ویدیو از YouTube دریافت نشد.")


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


def download_video(url: str, workdir: Path, quality: int, metadata: dict[str, Any]) -> Path:
    cached_client = _load_session_client(metadata)
    errors: list[str] = []

    if cached_client:
        try:
            return _download_video_from_metadata(metadata, cached_client, workdir, quality)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"cached youtube client={cached_client} failed: {exc}", flush=True)
            _clean_workdir(workdir)

    for client in _client_order(cached_client):
        try:
            fresh = _fetch_metadata_for_client(url, client)
            app.validate_video_metadata(fresh)
            if quality not in available_qualities(fresh):
                continue
            _save_session(fresh, client)
            return _download_video_from_metadata(fresh, client, workdir, quality)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"youtube full attempt client={client} failed: {exc}", flush=True)
            _clean_workdir(workdir)

    raise app.UserVisibleError(errors[-1] if errors else f"❌ کیفیت {quality}p برای این ویدیو در دسترس نیست.")


def download_audio(url: str, workdir: Path, mode: str) -> Path:
    cached_metadata = app.load_metadata_cache(url)
    cached_client = _load_session_client(cached_metadata)
    errors: list[str] = []

    if cached_metadata is not None and cached_client:
        try:
            return _download_audio_from_metadata(cached_metadata, cached_client, workdir, mode)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"cached audio client={cached_client} failed: {exc}", flush=True)
            _clean_workdir(workdir)

    for client in _client_order(cached_client):
        try:
            fresh = _fetch_metadata_for_client(url, client)
            app.validate_video_metadata(fresh)
            if not audio_formats(fresh):
                continue
            _save_session(fresh, client)
            return _download_audio_from_metadata(fresh, client, workdir, mode)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"youtube audio full attempt client={client} failed: {exc}", flush=True)
            _clean_workdir(workdir)

    raise app.UserVisibleError(errors[-1] if errors else "❌ فایل صوتی قابل دانلود پیدا نشد.")


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
        stream = payload["streams"][0]
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        if width <= 0 or height <= 0:
            return None
        dar = _fraction(str(stream.get("display_aspect_ratio") or ""))
        if dar is None:
            sar = _fraction(str(stream.get("sample_aspect_ratio") or "")) or 1.0
            dar = (width / height) * sar
        return width, height, dar
    except Exception:
        return None


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
        "(single-client end-to-end pipeline)",
        flush=True,
    )
    server.serve_forever()
