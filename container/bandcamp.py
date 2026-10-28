"""Isolated anonymous Bandcamp track/album downloads; shared Telegram sender only."""
import asyncio
import json
import math
import re
import shutil
import subprocess
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import youtube_app as app

MAX_TRACKS = 20
MAX_BYTES = 2_000_000_000
MAX_SECONDS = 20 * 60
BANDCAMP_FIX_VERSION = 'bandcamp-quality-v4'
SELECTION_SECONDS = 10 * 60
EXTENSIONS = {'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'aiff'}


def audio_formats(data: dict) -> list[dict]:
    result = {}
    for item in data.get('formats') or []:
        if not isinstance(item, dict) or item.get('vcodec') != 'none' or not item.get('url'):
            continue
        ext = {'aif': 'aiff', 'alac': 'm4a'}.get(item.get('ext'), item.get('ext'))
        identifier = str(item.get('format_id') or ext or '')
        if ext not in EXTENSIONS or not re.fullmatch(r'[A-Za-z0-9_-]{1,24}', identifier):
            continue
        result[identifier] = {**item, 'ext': ext, 'format_id': identifier}
    return list(result.values())


def format_label(item: dict) -> str:
    identifier, ext = item['format_id'], item['ext']
    if ext in {'flac', 'wav', 'aiff'} or identifier in {'alac', 'falac'}:
        return f'{"ALAC" if identifier in {"alac", "falac"} else ext.upper()} • بدون افت کیفیت'
    if identifier == 'mp3-v0':
        return 'MP3 V0 • بیت‌ریت متغیر'
    rate = format_bitrate(item)
    name = 'AAC (M4A)' if identifier.startswith('aac') and ext == 'm4a' else ext.upper()
    return name + (f' • {round(rate)} kbps' if math.isfinite(rate) and rate > 0 else '')


def format_bitrate(item: dict) -> float:
    match = re.fullmatch(r'mp3-(\d+)', item['format_id'])
    try:
        value = float(item.get('abr') or (match[1] if match else 0))
        return value if math.isfinite(value) and value > 0 else 0
    except (ValueError, TypeError):
        return 0


def best_format(items: list[dict]) -> dict:
    return max(items, key=lambda item: (item['ext'] in {'flac', 'wav', 'aiff'} or item['format_id'] in {'alac', 'falac'},
               item['ext'] == 'flac',
               format_bitrate(item) or (250 if item['format_id'] == 'mp3-v0' else 0),
               item['format_id'] == 'mp3-v0', item['ext'] == 'mp3'))


def choose(job, identifier: str) -> dict:
    """Resume the current Bandcamp job; never create a second download."""
    with job.lock:
        options = getattr(job, 'bandcamp_options', [])
        if (not isinstance(identifier, str) or not job.source.get('bandcamp') or job.cleanup_requested
                or identifier not in {item['id'] for item in options}):
            return {'ok': False, 'message': 'انتخاب کیفیت Bandcamp معتبر نیست یا منقضی شده است.'}
        selected = getattr(job, 'bandcamp_format', None)
        if selected:
            return {'ok': selected == identifier}
        if job.state != 'starting':
            return {'ok': False, 'message': 'انتخاب کیفیت Bandcamp منقضی شده است.'}
        job.bandcamp_format = identifier
        # Reuse the job's cancellation event so cleanup also wakes this wait.
        job.stop_event.set()
        return {'ok': True}


def await_quality(job, url: str, entries: list) -> str:
    common, representatives = None, {}
    deadline = time.monotonic() + MAX_SECONDS
    for entry in entries:
        if job.cleanup_requested or time.monotonic() >= deadline:
            raise app.UserVisibleError('❌ بررسی کیفیت‌های Bandcamp متوقف شد یا به سقف زمان رسید.')
        try:
            if not isinstance(entry, dict):
                raise app.UserVisibleError('❌ اطلاعات آهنگ آلبوم معتبر نیست.')
            track = canonical_url(entry.get('webpage_url') or entry.get('url') or '')
            if '/track/' not in track or urlparse(track).hostname != urlparse(url).hostname:
                raise app.UserVisibleError('❌ لینک آهنگ آلبوم معتبر نیست.')
            formats = audio_formats(metadata(track))
            if not formats:
                continue
            ids = {item['format_id'] for item in formats}
            common = ids if common is None else common & ids
            representatives.update({item['format_id']: item for item in formats})
        except app.UserVisibleError:
            if '/album/' not in url:
                raise
            continue  # Existing album preparation reports unavailable tracks.
    if not representatives:
        raise app.UserVisibleError('❌ هیچ فایل عمومی قابل‌دریافتی از Bandcamp پیدا نشد.')
    options = [{'id': identifier, 'label': format_label(representatives[identifier])}
               for identifier in sorted(common or set())][:9]
    if '/album/' in url:
        options.insert(0, {'id': 'best', 'label': 'بهترین کیفیت موجودِ هر آهنگ'})
    if not options:
        raise app.UserVisibleError('❌ کیفیت عمومی قابل‌دریافتی پیدا نشد.')
    with job.lock:
        job.bandcamp_options, job.bandcamp_format = options, None
        job.result = {'ok': True, 'bandcampOptions': options}
    job.notify()
    if not job.stop_event.wait(SELECTION_SECONDS):
        raise app.UserVisibleError('❌ انتخاب کیفیت منقضی شد؛ لینک Bandcamp را دوباره بفرست.')
    with job.lock:
        if job.cleanup_requested or not job.bandcamp_format:
            raise app.UserVisibleError('❌ انتخاب کیفیت Bandcamp متوقف شد.')
        job.stop_event.clear()
        job.result = {'ok': False}
        return job.bandcamp_format


def failure(phase: str, exc: Exception) -> app.UserVisibleError:
    """Classify provider failures without treating every failure as private content."""
    raw = getattr(exc, 'stderr', '') or ''
    if isinstance(raw, bytes):
        raw = raw.decode('utf-8', errors='replace')
    # Examine provider errors only; subprocess reprs contain commands and URLs.
    detail = str(raw) if isinstance(exc, subprocess.SubprocessError) else str(exc)
    detail = re.sub(r'https?://\S+', '[URL]', detail, flags=re.I)
    response = getattr(exc, 'response', None)
    status = response.status_code if response is not None else None
    match = re.search(r'HTTP(?:\s+Error)?\s*:?\s*(\d{3})\b', detail, re.I)
    if status is None and match:
        status = int(match[1])
    category, code = 'download_failed', 'SOURCE_FAILED'
    if isinstance(exc, (subprocess.TimeoutExpired, app.requests.Timeout)) or re.search(r'timed?\s*out|timeout', detail, re.I):
        category, code = 'timeout', 'TIMEOUT'
    elif isinstance(exc, app.requests.exceptions.SSLError) or re.search(r'certificate.verify.failed|CERTIFICATE_VERIFY_FAILED|SSL.*certificate', detail, re.I):
        category, code = 'network', 'TLS_FAILED'
    elif status == 429:
        category, code = 'rate_limit', 'RATE_LIMITED'
    elif status in {401, 403}:
        category, code = 'access_unavailable', 'ACCESS_DENIED'
    elif status in {404, 410}:
        category, code = 'content_unavailable', 'NOT_FOUND'
    elif isinstance(status, int) and status >= 500:
        category, code = 'service_unavailable', 'SOURCE_UNAVAILABLE'
    elif isinstance(exc, FileNotFoundError):
        category, code = 'service_unavailable', 'DEPENDENCY_MISSING'
    elif re.search(r'client challenge|impersonate target.*not available|no impersonate target', detail, re.I):
        category, code = ('access_unavailable', 'CLIENT_CHALLENGE') if 'client challenge' in detail.lower() else ('service_unavailable', 'IMPERSONATION_UNAVAILABLE')
    elif isinstance(exc, app.requests.ConnectionError) or re.search(r'connection (?:reset|refused)|name.*resol|network is unreachable|unable to resolve', detail, re.I):
        category, code = 'network', 'CONNECTION_FAILED'
    elif re.search(r'(?:this (?:track|album|content) is private|private (?:track|album))\b', detail, re.I):
        category, code = 'content_private', 'CONTENT_PRIVATE'
    elif re.search(r'no (?:video |audio )?formats|no free songs|not available for streaming', detail, re.I):
        category, code = 'content_unavailable', 'NO_PUBLIC_AUDIO'
    elif isinstance(exc, (ValueError, TypeError)):
        category, code = ('output_invalid', 'INVALID_OUTPUT') if phase in {'probe', 'remux'} else ('download_failed', 'INVALID_METADATA')
    diagnostic = {**app.upload_error_diagnostic(exc, ''), 'message': 'bandcamp request failed',
                  'phase': phase, 'category': category, 'errorCode': f'BANDCAMP_{code}',
                  'bandcampFixVersion': BANDCAMP_FIX_VERSION}
    if isinstance(status, int):
        diagnostic['httpStatus'] = status
    if isinstance(getattr(exc, 'returncode', None), int):
        diagnostic['exitCode'] = exc.returncode
    if isinstance(getattr(exc, 'errno', None), int):
        diagnostic['errno'] = exc.errno
    print(json.dumps(diagnostic, ensure_ascii=False), flush=True)
    # Use an existing fixed public message so later visibility filters cannot
    # infer privacy from a generic provider error or a signed URL.
    return app.UserVisibleError(next(row['message'] for row in app.PUBLIC_ERROR_CATALOG if row['id'] == category))


def canonical_url(value: str) -> str:
    try:
        url = urlparse(value)
        host = (url.hostname or '').lower()
        if (url.scheme not in {'http', 'https'} or url.username or url.password or url.port
                or not re.fullmatch(r'(?!www\.|daily\.|get\.|support\.|help\.)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bandcamp\.com', host)
                or not re.fullmatch(r'/(track|album)/[A-Za-z0-9_-]+/?', url.path)):
            raise ValueError('invalid link')
        return f'https://{host}{url.path.rstrip("/")}'
    except (ValueError, TypeError, AttributeError) as exc:
        raise app.UserVisibleError('❌ لینک یک آهنگ یا آلبوم Bandcamp را بفرست.') from exc


def media_url(value: str) -> str:
    try:
        url = urlparse(value)
        host = (url.hostname or '').lower()
        if (url.scheme not in {'http', 'https'} or url.username or url.password or url.port
                or not (host.endswith('.bcbits.com') or host.endswith('.bandcamp.com'))):
            raise ValueError('invalid media')
        return url._replace(scheme='https').geturl()
    except (ValueError, TypeError, AttributeError) as exc:
        raise app.UserVisibleError('❌ آدرس فایل Bandcamp معتبر نیست.') from exc


def metadata(url: str, *, album: bool = False) -> dict:
    # Bandcamp's Client Challenge rejects the default Chrome fingerprint on
    # some networks (yt-dlp #17822). Use one verified target for this provider.
    command = [app.REAL_YTDLP, '--ignore-config', '--force-ipv4', '--skip-download',
               '--dump-single-json', '--no-warnings', '--socket-timeout', '15',
               '--retries', '1', '--extractor-retries', '1', '--impersonate', 'firefox']
    command += ['--flat-playlist', '--playlist-end', str(MAX_TRACKS + 1)] if album else ['--no-playlist']
    try:
        result = subprocess.run(command + ['--', canonical_url(url)], capture_output=True, text=True, timeout=90, check=True)
        data = json.loads(result.stdout)
        if not isinstance(data, dict):
            raise ValueError('invalid metadata')
        return data
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        raise failure('metadata', exc) from exc


def download(url: str, path: Path, limit: int, deadline: float) -> None:
    try:
        _download(url, path, limit, deadline)
    except app.requests.RequestException as exc:
        raise failure('download', exc) from exc


def _download(url: str, path: Path, limit: int, deadline: float) -> None:
    current = media_url(url)
    for _ in range(4):
        with app.requests.get(current, stream=True, allow_redirects=False, timeout=(15, 30)) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                current = media_url(urljoin(current, response.headers.get('location', '')))
                continue
            if response.status_code != 200:
                raise app.requests.HTTPError(f'HTTP {response.status_code}', response=response)
            length = int(response.headers.get('content-length') or 0)
            if length > limit:
                raise app.UserVisibleError('❌ حجم مجموع فایل‌های Bandcamp از سقف ۲ گیگابایت بیشتر است.')
            size = 0
            with path.open('wb') as output:
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > limit or time.monotonic() > deadline:
                        raise app.UserVisibleError('❌ دریافت Bandcamp به سقف حجم یا زمان رسید؛ فایل ناقص ارسال نشد.')
                    output.write(chunk)
            if not size or (length and size != length):
                raise app.UserVisibleError('❌ فایل Bandcamp ناقص دریافت شد؛ فایل ناقص ارسال نشد.')
            return
    raise app.UserVisibleError('❌ تغییر مسیر فایل Bandcamp بیش از حد بود.')


def prepare_track(url: str, directory: Path, limit: int, deadline: float, identifier: str = 'best') -> dict:
    data = metadata(url)
    candidates = audio_formats(data)
    if not candidates:
        raise failure('formats', ValueError('not available for streaming'))
    chosen = best_format(candidates) if identifier == 'best' else next((item for item in candidates if item['format_id'] == identifier), None)
    if not chosen:
        raise app.UserVisibleError('❌ کیفیت انتخاب‌شده دیگر در دسترس نیست؛ لینک را دوباره بفرست و کیفیت موجود را انتخاب کن.')
    directory.mkdir(parents=True, exist_ok=True)
    source = directory / 'input'
    download(chosen['url'], source, limit, deadline)
    phase = 'probe'
    try:
        info = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)], capture_output=True, text=True, check=True, timeout=30)
        probe = json.loads(info.stdout)
        duration = float(probe.get('format', {}).get('duration') or 0)
        expected = float(data.get('duration') or 0)
        if (not math.isfinite(duration) or duration <= 0 or not any(stream.get('codec_type') == 'audio' for stream in probe.get('streams', []))
                or (expected > 0 and duration + max(2, expected * .02) < expected)):
            raise ValueError('incomplete audio')
        title = ' '.join(str(data.get('track') or data.get('title') or 'Bandcamp').split())[:180]
        artist = ' '.join(str(data.get('artist') or data.get('uploader') or '').split())[:120]
        output = directory / f'Bandcamp.{chosen["ext"]}'
        phase = 'remux'
        subprocess.run(['ffmpeg', '-y', '-nostdin', '-v', 'error', '-i', str(source), '-map', '0:a:0', '-vn', '-c:a', 'copy',
                        '-fs', str(limit + 1), '-metadata', f'title={title}', '-metadata', f'artist={artist}', '-metadata', f'album={str(data.get("album") or "")[:180]}',
                        str(output)], check=True, capture_output=True, timeout=max(1, min(300, deadline - time.monotonic())))
        if not 0 < output.stat().st_size <= limit:
            raise ValueError('output size')
        return {'path': output, 'title': title, 'artist': artist, 'url': url, 'size': output.stat().st_size,
                'quality': format_label(chosen),
                'method': 'sendAudio' if chosen['ext'] in {'mp3', 'm4a'} and chosen['format_id'] not in {'alac', 'falac'} else 'sendDocument'}
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        raise failure(phase, exc) from exc
    finally:
        source.unlink(missing_ok=True)


def prepare(job) -> None:
    url = canonical_url(str(job.source['bandcamp'].get('url') or ''))
    album = '/album/' in url
    data = metadata(url, album=True) if album else None
    entries = data.get('entries') if album else [{'url': url}]
    if not isinstance(entries, list) or not entries:
        raise app.UserVisibleError('❌ این آلبوم Bandcamp آهنگ عمومی قابل‌دریافت ندارد.')
    if len(entries) > MAX_TRACKS:
        raise app.UserVisibleError('❌ فعلاً آلبوم‌های حداکثر ۲۰ آهنگی پشتیبانی می‌شوند؛ لینک آهنگ‌ها را جدا بفرست.')
    identifier = await_quality(job, url, entries) if job.source['bandcamp'].get('selectQuality') else 'best'
    job.bandcamp_items, job.bandcamp_failed, job.bandcamp_sent = [], [], 0
    deadline, size = time.monotonic() + MAX_SECONDS, 0
    for index, entry in enumerate(entries, 1):
        if job.cleanup_requested or time.monotonic() > deadline:
            raise app.UserVisibleError('❌ آماده‌سازی Bandcamp متوقف شد یا به سقف زمان رسید.')
        try:
            if not isinstance(entry, dict):
                raise app.UserVisibleError('❌ اطلاعات آهنگ آلبوم معتبر نیست.')
            track_url = canonical_url(entry.get('webpage_url') or entry.get('url') or '')
            if '/track/' not in track_url or urlparse(track_url).hostname != urlparse(url).hostname:
                raise app.UserVisibleError('❌ لینک آهنگ آلبوم معتبر نیست.')
            job.safe_status(f'🎵 Bandcamp؛ آماده‌سازی آهنگ {index} از {len(entries)}…')
            args = (track_url, job.workdir / f'bandcamp-{index}', MAX_BYTES - size, deadline)
            item = prepare_track(*args, identifier) if identifier != 'best' else prepare_track(*args)
            size += item['size']
            item['index'] = index
            job.bandcamp_items.append(item)
        except app.UserVisibleError:
            shutil.rmtree(job.workdir / f'bandcamp-{index}', ignore_errors=True)
            if not album:
                raise
            job.bandcamp_failed.append(index)
    if not job.bandcamp_items:
        raise app.UserVisibleError('❌ هیچ آهنگ عمومی و سالمی از این آلبوم Bandcamp دریافت نشد.')
    job.bandcamp_title = str((data or {}).get('title') or job.bandcamp_items[0]['title'])[:180]
    job.result = {'ok': True}
    with job.lock:
        job.state = 'ready'


def send(job) -> dict:
    deadline = time.monotonic() + 25 * 60
    try:
        for item in job.bandcamp_items[job.bandcamp_sent:]:
            if job.cleanup_requested or time.monotonic() >= deadline:
                raise app.UserVisibleError('❌ ارسال Bandcamp متوقف شد یا به سقف زمان رسید.')
            data = {'chat_id': str(job.payload['chatId']), 'title': item['title'], 'performer': item['artist'],
                    'caption': f"🎵 {item['title']}\n👤 {item['artist']}\n{item.get('quality', '')}\nBandcamp • {item['index']}\n{item['url']}"[:1024],
                    'reply_parameters': json.dumps({'message_id': job.payload['requestMessageId'], 'allow_sending_without_reply': True})}
            with item['path'].open('rb') as handle:
                ext = item['path'].suffix.lower()
                method = item.get('method') or ('sendAudio' if ext in {'.mp3', '.m4a'} else 'sendDocument')
                mime = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
                        '.aiff': 'audio/aiff', '.ogg': 'audio/ogg', '.aac': 'audio/aac'}.get(ext, 'application/octet-stream')
                asyncio.run(asyncio.wait_for(app.upload_complete_file(job.payload['botToken'], method, data,
                            (item['path'].name, handle, mime)), timeout=max(1, min(10 * 60, deadline - time.monotonic()))))
            job.bandcamp_sent += 1
            item['path'].unlink(missing_ok=True)
        result = {'ok': True, 'parts': job.bandcamp_sent, 'title': job.bandcamp_title,
                  'partial': bool(job.bandcamp_failed)}
        if job.bandcamp_failed:
            result['message'] = '⚠️ آهنگ‌های غیرقابل‌دریافت Bandcamp: ' + ', '.join(map(str, job.bandcamp_failed))
            job.safe_status(result['message'])
        else:
            app.delete_status(job.payload['botToken'], job.payload['chatId'], job.payload['statusMessageId'])
        job.result = result
        with job.lock:
            job.state = 'sent'
        return result
    except Exception as exc:
        print(f'Bandcamp upload failed: {type(exc).__name__}', flush=True)
        with job.lock:
            job.state = 'failed'
        return {'ok': False, 'parts': job.bandcamp_sent,
                'message': f'❌ ارسال Bandcamp کامل نشد؛ {job.bandcamp_sent} فایل تأیید شده است. برای جلوگیری از تکرار، ارسال متوقف شد؛ چت را بررسی کن.'}
