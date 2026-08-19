import re
import shutil
import subprocess
from pathlib import Path

import youtube_app as app
import youtube_pipeline as pipeline


def _friendly_ytdlp_error(stderr: str) -> str:
    """Map the most specific yt-dlp failures first.

    `Requested format is not available` contains the generic phrase
    `not available`, so it must be checked before video availability errors.
    """
    value = stderr.lower()
    if "requested format is not available" in value:
        return "❌ این کیفیت در این مسیر YouTube در دسترس نبود. دوباره امتحان می‌کنم."
    if "private video" in value or "this video is private" in value:
        return "❌ این ویدیو Private هست و بدون دسترسی به اکانت قابل دانلود نیست."
    if "members-only" in value or "join this channel" in value:
        return "❌ این ویدیو فقط برای اعضای کانال قابل مشاهده است."
    if (
        "video unavailable" in value
        or "this video is unavailable" in value
        or "not available in your country" in value
        or "not available in your region" in value
    ):
        return "❌ این ویدیو واقعاً در دسترس نیست یا برای این منطقه محدود شده."
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
    return "❌ نتونستم این فایل رو از YouTube بگیرم. دوباره همین لینک یا یک لینک دیگه رو امتحان کن."


# Fix the misleading error mapping for every request handled by this container.
app.friendly_ytdlp_error = _friendly_ytdlp_error


def _clean_workdir(workdir: Path) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    for path in workdir.iterdir():
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


def _expected_ratio(metadata: dict) -> float | None:
    try:
        return pipeline._source_ratio(metadata)
    except Exception:
        return None


def _video_output_is_correct(path: Path, quality: int, expected_ratio: float | None) -> bool:
    probed = pipeline._probe_geometry(path)
    if probed is None:
        return False
    width, height, actual_ratio = probed
    short_side = min(width, height)
    if abs(short_side - quality) > pipeline.QUALITY_TOLERANCE:
        print(
            f"mini live quality mismatch: requested={quality} got={width}x{height}",
            flush=True,
        )
        return False
    if expected_ratio is not None:
        relative_error = abs(actual_ratio - expected_ratio) / expected_ratio
        if relative_error > 0.08:
            print(
                "mini live aspect mismatch: "
                f"expected={expected_ratio:.4f} actual={actual_ratio:.4f} size={width}x{height}",
                flush=True,
            )
            return False
    return True


def _live_video_attempt(
    url: str,
    client: str,
    workdir: Path,
    quality: int,
    expected_ratio: float | None,
) -> Path:
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")

    # yt-dlp documents `res` as the video's smallest dimension. This means
    # res:720 works for both 1280x720 landscape and 720x1280 portrait videos.
    # Crucially, extraction, format selection and download happen in THIS one
    # yt-dlp process with one forced player client. We do not feed a previous
    # --dump-single-json result back through --load-info-json.
    result = app.run_command(
        [
            app.REAL_YTDLP,
            *pipeline._client_args(client),
            "--force-overwrites",
            "--no-simulate",
            "--concurrent-fragments",
            "2",
            "--format",
            "bv*+ba/b",
            "--format-sort-force",
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
        timeout=app.DOWNLOAD_TIMEOUT_SECONDS,
    )
    path = app.result_path(result, workdir)
    if path is None:
        raise app.UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")
    if not _video_output_is_correct(path, quality, expected_ratio):
        path.unlink(missing_ok=True)
        raise app.UserVisibleError(f"❌ کیفیت دقیق {quality}p از این مسیر YouTube دریافت نشد.")
    print(
        f"mini live video success client={client} quality={quality} file={path.name}",
        flush=True,
    )
    return path


def download_video_live(url: str, workdir: Path, quality: int, metadata: dict) -> Path:
    preferred = pipeline._load_session_client(metadata)
    expected_ratio = _expected_ratio(metadata)
    errors: list[str] = []

    for client in pipeline._client_order(preferred):
        _clean_workdir(workdir)
        try:
            return _live_video_attempt(url, client, workdir, quality, expected_ratio)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"mini live video client={client} failed: {exc}", flush=True)

    raise app.UserVisibleError(
        errors[-1] if errors else f"❌ کیفیت {quality}p برای این ویدیو قابل دریافت نیست."
    )


def _audio_selector(mode: str) -> tuple[str, str]:
    if mode == "low":
        return (
            "ba[abr<=80][ext=m4a]/ba[abr<=80]/worstaudio[ext=m4a]/worstaudio",
            "64k",
        )
    return "ba[ext=m4a]/ba", "128k"


def _live_audio_attempt(url: str, client: str, workdir: Path, mode: str) -> Path:
    selector, fallback_bitrate = _audio_selector(mode)
    source_template = str(workdir / "audio-source.%(ext)s")
    result = app.run_command(
        [
            app.REAL_YTDLP,
            *pipeline._client_args(client),
            "--force-overwrites",
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
        timeout=app.DOWNLOAD_TIMEOUT_SECONDS,
    )
    source = app.result_path(result, workdir, prefix="audio-source.")
    if source is None:
        raise app.UserVisibleError("❌ فایل صوتی بعد از دانلود پیدا نشد.")

    target = workdir / "Vexa.m4a"
    if source.suffix.lower() == ".m4a":
        source.replace(target)
        print(f"mini live audio success client={client} mode={mode}", flush=True)
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
            text=True,
            capture_output=True,
            check=True,
            timeout=1_200,
        )
    except subprocess.TimeoutExpired as exc:
        raise app.UserVisibleError("❌ تبدیل فایل صوتی بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        print(f"mini audio conversion failed: {(exc.stderr or '')[-1200:]}", flush=True)
        raise app.UserVisibleError("❌ تبدیل فایل صوتی به M4A انجام نشد.") from exc

    if not target.exists() or target.stat().st_size <= 0:
        raise app.UserVisibleError("❌ فایل صوتی نهایی ساخته نشد.")
    print(f"mini live audio success client={client} mode={mode}", flush=True)
    return target


def download_audio_live(url: str, workdir: Path, mode: str) -> Path:
    metadata = app.load_metadata_cache(url)
    preferred = pipeline._load_session_client(metadata)
    errors: list[str] = []

    for client in pipeline._client_order(preferred):
        _clean_workdir(workdir)
        try:
            return _live_audio_attempt(url, client, workdir, mode)
        except app.UserVisibleError as exc:
            errors.append(str(exc))
            print(f"mini live audio client={client} failed: {exc}", flush=True)

    raise app.UserVisibleError(
        errors[-1] if errors else "❌ فایل صوتی قابل دانلود پیدا نشد."
    )


# Mini App only: replace the cached info-json download stage. The existing
# Telegram bot workflow keeps its own source files and public behavior intact.
pipeline.download_video = download_video_live
pipeline.download_audio = download_audio_live

# Import after monkey-patching. mini_pipeline calls pipeline.install() while
# importing, so the app-level hooks are installed with the live functions too.
import mini_pipeline  # noqa: E402


if __name__ == "__main__":
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), mini_pipeline.MiniAppHandler)
    print(
        f"youtube downloader listening on :{app.PORT} "
        "(mini app live single-client downloads; no load-info-json)",
        flush=True,
    )
    server.serve_forever()
