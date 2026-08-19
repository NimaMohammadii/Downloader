import json
import mimetypes
import re
import shutil
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import youtube_app as app
import youtube_pipeline as pipeline

pipeline.install()

MINI_ROOT = Path('/tmp/vexa-miniapp-downloads')
MINI_FILE_TTL_SECONDS = 20 * 60
FILE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{16,64}$')


def _clean_title(value: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', value)
    clean = re.sub(r'\s+', ' ', clean).strip(' .')
    if not clean:
        clean = 'YouTube'
    return clean[:72].rstrip()


def _cleanup_old_files() -> None:
    if not MINI_ROOT.exists():
        return
    cutoff = time.time() - MINI_FILE_TTL_SECONDS
    for child in MINI_ROOT.iterdir():
        if not child.is_dir():
            continue
        try:
            if child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            pass


def _prepare_file(payload: dict[str, object]) -> dict[str, object]:
    url = str(payload.get('url') or '').strip()
    file_id = str(payload.get('fileId') or '').strip()
    quality_raw = payload.get('quality')
    audio_mode = str(payload.get('audioMode') or '').strip().lower() or None

    if not url or not FILE_ID_RE.fullmatch(file_id):
        raise app.UserVisibleError('❌ درخواست دانلود نامعتبره.')

    quality: int | None = None
    if quality_raw is not None:
        try:
            quality = int(quality_raw)
        except (TypeError, ValueError) as exc:
            raise app.UserVisibleError('❌ کیفیت انتخاب‌شده نامعتبره.') from exc

    if (quality is None) == (audio_mode is None):
        raise app.UserVisibleError('❌ فقط یک حالت دانلود انتخاب کن.')
    if quality is not None and quality not in app.SUPPORTED_QUALITIES:
        raise app.UserVisibleError('❌ کیفیت انتخاب‌شده پشتیبانی نمی‌شه.')
    if audio_mode is not None and audio_mode not in app.SUPPORTED_AUDIO_MODES:
        raise app.UserVisibleError('❌ حالت صوتی انتخاب‌شده پشتیبانی نمی‌شه.')

    _cleanup_old_files()
    workdir = MINI_ROOT / file_id
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)

    metadata = app.load_metadata_cache(url)
    if metadata is None:
        metadata = pipeline.fetch_metadata(url)
        app.save_metadata_cache(metadata)
    app.validate_video_metadata(metadata)

    title = str(metadata.get('title') or 'YouTube video').strip()
    safe_title = _clean_title(title)

    try:
        if quality is not None:
            if quality not in pipeline.available_qualities(metadata):
                raise app.UserVisibleError(f'❌ کیفیت {quality}p برای این ویدیو موجود نیست.')
            source = pipeline.download_video(url, workdir, quality, metadata)
            target = workdir / f'Vexa - {safe_title} - {quality}p.mp4'
            mime = 'video/mp4'
        else:
            assert audio_mode is not None
            source = pipeline.download_audio(url, workdir, audio_mode)
            mode_label = 'HQ' if audio_mode == 'hq' else 'Lite'
            target = workdir / f'Vexa - {safe_title} - Audio {mode_label}.m4a'
            mime = 'audio/mp4'

        if source.resolve() != target.resolve():
            source.replace(target)
        if not target.exists() or target.stat().st_size <= 0:
            raise app.UserVisibleError('❌ فایل نهایی ساخته نشد.')

        manifest = {
            'fileId': file_id,
            'fileName': target.name,
            'mime': mime,
            'size': target.stat().st_size,
            'title': title,
        }
        (workdir / 'manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False),
            encoding='utf-8',
        )
        return {'ok': True, **manifest}
    except Exception:
        if not (workdir / 'manifest.json').exists():
            shutil.rmtree(workdir, ignore_errors=True)
        raise


def _load_manifest(file_id: str) -> tuple[dict[str, object], Path] | None:
    if not FILE_ID_RE.fullmatch(file_id):
        return None
    workdir = MINI_ROOT / file_id
    manifest_path = workdir / 'manifest.json'
    if not manifest_path.exists():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if not isinstance(manifest, dict) or str(manifest.get('fileId') or '') != file_id:
            return None
        file_name = str(manifest.get('fileName') or '')
        if not file_name or Path(file_name).name != file_name:
            return None
        path = workdir / file_name
        if not path.exists() or not path.is_file():
            return None
        return manifest, path
    except Exception:
        return None


def _range_bounds(value: str | None, size: int) -> tuple[int, int] | None:
    if not value:
        return 0, size - 1
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
    if not match:
        return None
    start_raw, end_raw = match.groups()
    if not start_raw and not end_raw:
        return None
    if not start_raw:
        suffix = int(end_raw)
        if suffix <= 0:
            return None
        start = max(0, size - suffix)
        return start, size - 1
    start = int(start_raw)
    end = int(end_raw) if end_raw else size - 1
    if start < 0 or start >= size or end < start:
        return None
    return start, min(end, size - 1)


class MiniAppHandler(app.Handler):
    def _send_file_headers(
        self,
        status: int,
        path: Path,
        manifest: dict[str, object],
        start: int,
        end: int,
    ) -> None:
        size = path.stat().st_size
        length = end - start + 1
        file_name = str(manifest.get('fileName') or path.name)
        mime = str(manifest.get('mime') or mimetypes.guess_type(file_name)[0] or 'application/octet-stream')
        ascii_name = 'Vexa-download' + (path.suffix or '')
        encoded_name = quote(file_name, safe='')

        self.send_response(status)
        self.send_header('content-type', mime)
        self.send_header('content-length', str(length))
        self.send_header('accept-ranges', 'bytes')
        self.send_header('cache-control', 'private, no-store')
        self.send_header(
            'content-disposition',
            f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded_name}',
        )
        if status == 206:
            self.send_header('content-range', f'bytes {start}-{end}/{size}')
        self.end_headers()

    def _serve_mini_file(self, *, head_only: bool) -> None:
        parsed = urlparse(self.path)
        values = parse_qs(parsed.query)
        file_id = (values.get('fileId') or [''])[0]
        loaded = _load_manifest(file_id)
        if loaded is None:
            self._send_json(404, {'ok': False, 'error': 'file not found'})
            return

        manifest, path = loaded
        size = path.stat().st_size
        bounds = _range_bounds(self.headers.get('range'), size)
        if bounds is None:
            self.send_response(416)
            self.send_header('content-range', f'bytes */{size}')
            self.send_header('content-length', '0')
            self.end_headers()
            return

        start, end = bounds
        status = 206 if self.headers.get('range') else 200
        self._send_file_headers(status, path, manifest, start, end)
        if head_only:
            return

        remaining = end - start + 1
        try:
            with path.open('rb') as handle:
                handle.seek(start)
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self) -> None:
        if urlparse(self.path).path == '/mini/file':
            self._serve_mini_file(head_only=True)
            return
        self.send_response(404)
        self.send_header('content-length', '0')
        self.end_headers()

    def do_GET(self) -> None:
        if urlparse(self.path).path == '/mini/file':
            self._serve_mini_file(head_only=False)
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path != '/mini/prepare':
            super().do_POST()
            return
        try:
            content_length = int(self.headers.get('content-length', '0'))
            if content_length <= 0 or content_length > 100_000:
                self._send_json(400, {'ok': False, 'message': '❌ درخواست نامعتبره.'})
                return
            payload = json.loads(self.rfile.read(content_length).decode('utf-8'))
            if not isinstance(payload, dict):
                self._send_json(400, {'ok': False, 'message': '❌ درخواست نامعتبره.'})
                return
            result = _prepare_file(payload)
            self._send_json(200, result)
        except app.UserVisibleError as exc:
            self._send_json(200, {'ok': False, 'message': str(exc)})
        except Exception as exc:
            print(f'mini app prepare failed: {type(exc).__name__}: {exc}', flush=True)
            self._send_json(500, {'ok': False, 'message': '❌ آماده‌سازی فایل انجام نشد.'})


if __name__ == '__main__':
    server = app.ThreadingHTTPServer(('0.0.0.0', app.PORT), MiniAppHandler)
    print(
        f'youtube downloader listening on :{app.PORT} '
        '(single-client pipeline + mini app file streaming)',
        flush=True,
    )
    server.serve_forever()
