import json
import re
import subprocess
from pathlib import Path
from typing import Any

import youtube_app as app

ASPECT_CLUSTER_TOLERANCE = 0.035
ASPECT_MATCH_TOLERANCE = 0.07
OUTPUT_ASPECT_TOLERANCE = 0.08


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result > 0 else default


def _dimensions(format_info: dict[str, Any]) -> tuple[int, int] | None:
    try:
        width = int(format_info.get("width") or 0)
        height = int(format_info.get("height") or 0)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


def _aspect_ratio(format_info: dict[str, Any]) -> float | None:
    dimensions = _dimensions(format_info)
    if dimensions:
        width, height = dimensions
        return width / height
    value = _number(format_info.get("aspect_ratio"))
    return value or None


def _is_storyboard(format_info: dict[str, Any]) -> bool:
    format_id = str(format_info.get("format_id") or "").lower()
    format_note = str(format_info.get("format_note") or "").lower()
    format_text = str(format_info.get("format") or "").lower()
    protocol = str(format_info.get("protocol") or "").lower()
    ext = str(format_info.get("ext") or "").lower()
    vcodec = str(format_info.get("vcodec") or "none").lower()

    return (
        protocol == "mhtml"
        or ext == "mhtml"
        or vcodec in {"images", "image"}
        or "storyboard" in format_note
        or "storyboard" in format_text
        or bool(re.fullmatch(r"sb\d+", format_id))
    )


def video_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []

    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict) or _is_storyboard(item):
            continue
        vcodec = str(item.get("vcodec") or "none").lower()
        if vcodec in {"none", "images", "image"}:
            continue
        if _dimensions(item) is None:
            continue
        result.append(item)
    return result


def short_side(format_info: dict[str, Any]) -> int | None:
    dimensions = _dimensions(format_info)
    if not dimensions:
        return None
    return min(dimensions)


def source_aspect_ratio(metadata: dict[str, Any]) -> float | None:
    formats = video_formats(metadata)
    ratios = [ratio for item in formats if (ratio := _aspect_ratio(item)) is not None]
    if not ratios:
        return None

    best_ratio = ratios[0]
    best_count = 0
    best_area = 0
    for ratio in ratios:
        matching = [
            item
            for item in formats
            if (item_ratio := _aspect_ratio(item)) is not None
            and abs(item_ratio - ratio) / ratio <= ASPECT_CLUSTER_TOLERANCE
        ]
        count = len(matching)
        area = max(
            (dims[0] * dims[1] for item in matching if (dims := _dimensions(item)) is not None),
            default=0,
        )
        if count > best_count or (count == best_count and area > best_area):
            best_ratio = ratio
            best_count = count
            best_area = area
    return best_ratio


def _matches_source_aspect(format_info: dict[str, Any], source_ratio: float | None) -> bool:
    if source_ratio is None:
        return True
    ratio = _aspect_ratio(format_info)
    if ratio is None:
        return False
    return abs(ratio - source_ratio) / source_ratio <= ASPECT_MATCH_TOLERANCE


def available_qualities(metadata: dict[str, Any]) -> list[int]:
    source_ratio = source_aspect_ratio(metadata)
    found: set[int] = set()
    for format_info in video_formats(metadata):
        if not _matches_source_aspect(format_info, source_ratio):
            continue
        resolution = short_side(format_info)
        if resolution is None:
            continue
        for quality in app.SUPPORTED_QUALITIES:
            if abs(resolution - quality) <= 16:
                found.add(quality)
    return [quality for quality in app.SUPPORTED_QUALITIES if quality in found]


def is_portrait(metadata: dict[str, Any]) -> bool:
    ratio = source_aspect_ratio(metadata)
    return bool(ratio is not None and ratio < 1.0)


def _format_score(format_info: dict[str, Any], quality: int) -> tuple[float, int, int, int, int, float, float]:
    resolution = short_side(format_info) or 0
    ext = str(format_info.get("ext") or "").lower()
    vcodec = str(format_info.get("vcodec") or "").lower()
    protocol = str(format_info.get("protocol") or "").lower()
    acodec = str(format_info.get("acodec") or "none").lower()
    fps = _number(format_info.get("fps"))
    tbr = _number(format_info.get("tbr"))
    return (
        -abs(resolution - quality),
        1 if ext == "mp4" else 0,
        1 if vcodec.startswith("avc1") else 0,
        1 if protocol in {"https", "http"} else 0,
        1 if acodec != "none" else 0,
        fps,
        tbr,
    )


def select_video_format(metadata: dict[str, Any], quality: int) -> tuple[dict[str, Any], float]:
    source_ratio = source_aspect_ratio(metadata)
    candidates = [
        item
        for item in video_formats(metadata)
        if _matches_source_aspect(item, source_ratio)
        and (resolution := short_side(item)) is not None
        and abs(resolution - quality) <= 16
        and str(item.get("format_id") or "").strip()
    ]
    if not candidates:
        raise app.UserVisibleError(f"❌ کیفیت {quality}p با نسبت تصویر اصلی این ویدیو موجود نیست.")

    selected = max(candidates, key=lambda item: _format_score(item, quality))
    expected_ratio = _aspect_ratio(selected) or source_ratio
    if expected_ratio is None:
        raise app.UserVisibleError("❌ نسبت تصویر این ویدیو قابل تشخیص نیست.")
    return selected, expected_ratio


def _safe_format_id(format_info: dict[str, Any]) -> str:
    format_id = str(format_info.get("format_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._+:-]+", format_id):
        raise app.UserVisibleError("❌ فرمت ویدیوی YouTube نامعتبر بود.")
    return format_id


def _format_selector(format_info: dict[str, Any]) -> str:
    format_id = _safe_format_id(format_info)
    acodec = str(format_info.get("acodec") or "none").lower()
    if acodec != "none":
        return format_id
    return f"{format_id}+ba[ext=m4a]/{format_id}+ba/{format_id}"


def _fraction(value: str) -> float | None:
    if not value or value in {"0:1", "N/A"}:
        return None
    try:
        left, right = value.split(":", 1)
        denominator = float(right)
        if denominator == 0:
            return None
        result = float(left) / denominator
        return result if result > 0 else None
    except (ValueError, TypeError):
        return None


def probe_video_aspect(path: Path) -> tuple[int, int, float] | None:
    try:
        result = subprocess.run(
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
            text=True,
            capture_output=True,
            check=True,
            timeout=60,
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
        display_ratio = _fraction(str(stream.get("display_aspect_ratio") or ""))
        if display_ratio is None:
            sample_ratio = _fraction(str(stream.get("sample_aspect_ratio") or "")) or 1.0
            display_ratio = (width / height) * sample_ratio
        return width, height, display_ratio
    except Exception as exc:
        print(f"video geometry probe failed: {type(exc).__name__}: {exc}", flush=True)
        return None


def _valid_output_geometry(path: Path, expected_ratio: float) -> bool:
    probed = probe_video_aspect(path)
    if probed is None:
        return False
    width, height, actual_ratio = probed
    relative_error = abs(actual_ratio - expected_ratio) / expected_ratio
    expected_portrait = expected_ratio < 0.95
    expected_landscape = expected_ratio > 1.05
    orientation_ok = not (
        (expected_portrait and width >= height)
        or (expected_landscape and width <= height)
    )
    if relative_error > OUTPUT_ASPECT_TOLERANCE or not orientation_ok:
        print(
            "video aspect validation failed: "
            f"expected={expected_ratio:.4f} actual={actual_ratio:.4f} size={width}x{height}",
            flush=True,
        )
        return False
    return True


def _remove_video_outputs(workdir: Path) -> None:
    for path in workdir.iterdir():
        if not path.is_file():
            continue
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


def _download_from_info(
    metadata: dict[str, Any],
    workdir: Path,
    quality: int,
) -> tuple[Path | None, float]:
    selected, expected_ratio = select_video_format(metadata, quality)
    selector = _format_selector(selected)
    app.save_metadata_cache(metadata)
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")
    result = app.run_cached_command(
        [
            app.REAL_YTDLP,
            "--load-info-json",
            str(app.METADATA_CACHE_PATH),
            "--force-overwrites",
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
        timeout=app.DOWNLOAD_TIMEOUT_SECONDS,
    )
    if result is None:
        return None, expected_ratio
    path = app.result_path(result, workdir)
    if path is None or not _valid_output_geometry(path, expected_ratio):
        if path is not None:
            path.unlink(missing_ok=True)
        return None, expected_ratio
    return path, expected_ratio


def download_video(url: str, workdir: Path, quality: int, metadata: dict[str, Any]) -> Path:
    path, _ = _download_from_info(metadata, workdir, quality)
    if path is not None:
        return path

    _remove_video_outputs(workdir)

    fresh_metadata = app.fetch_metadata(url)
    app.validate_video_metadata(fresh_metadata)
    app.save_metadata_cache(fresh_metadata)
    path, expected_ratio = _download_from_info(fresh_metadata, workdir, quality)
    if path is not None:
        return path

    _remove_video_outputs(workdir)

    selected, expected_ratio = select_video_format(fresh_metadata, quality)
    selector = _format_selector(selected)
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")
    result = app.run_command(
        [
            "yt-dlp",
            *app.ytdlp_common_args(),
            "--no-simulate",
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
            url,
        ],
        timeout=app.DOWNLOAD_TIMEOUT_SECONDS,
    )
    path = app.result_path(result, workdir)
    if path is None:
        raise app.UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")
    if not _valid_output_geometry(path, expected_ratio):
        path.unlink(missing_ok=True)
        raise app.UserVisibleError("❌ نسبت تصویر فایل خروجی درست نبود؛ دانلود متوقف شد.")
    return path


def install() -> None:
    app.video_formats = video_formats
    app.short_side = short_side
    app.available_qualities = available_qualities
    app.is_portrait = is_portrait
    app.download_video = download_video


if __name__ == "__main__":
    install()
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), app.Handler)
    print(f"youtube downloader listening on :{app.PORT} (aspect guard enabled)", flush=True)
    server.serve_forever()
