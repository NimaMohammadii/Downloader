"""Reddit-only public post, gallery and native video downloads.

Uses the existing job lifecycle and Telegram transport, never another downloader.
"""
import asyncio
import html
import json
import math
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

from curl_cffi import requests as browser_requests

import youtube_app as app

MAX_ITEMS = 20
MAX_BYTES = 2_000_000_000
PAGE_HOSTS = {'reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'm.reddit.com', 'redd.it'}
ACCESS_ERROR = '❌ Reddit اجازهٔ دسترسی به این پست را نداد؛ ممکن است پست خصوصی، حذف‌شده یا دسترسی IP سرور محدود باشد.'


def checked_url(value, hosts):
    try:
        url = urlparse(html.unescape(value))
        if (url.scheme not in {'http', 'https'} or url.username or url.password or url.port
                or (url.hostname or '').lower() not in hosts or '\\' in value):
            raise ValueError('invalid URL')
        return url._replace(scheme='https', fragment='').geturl()
    except (ValueError, TypeError, AttributeError) as exc:
        raise app.UserVisibleError('❌ لینک Reddit معتبر نیست.') from exc


def canonical_url(value):
    url = urlparse(checked_url(value, PAGE_HOSTS | {'v.redd.it', 'i.redd.it'}))
    host, path = url.hostname.lower(), url.path
    if host in PAGE_HOSTS:
        post = re.fullmatch(r'/(?:(?:r|user)/[^/]+/)?comments/([a-z0-9]+)(?:/.*)?', path, re.I)
        post = post or re.fullmatch(r'/gallery/([a-z0-9]+)/?', path, re.I)
        post = post or (re.fullmatch(r'/([a-z0-9]+)/?', path, re.I) if host == 'redd.it' else None)
        if post:
            return f'https://www.reddit.com/comments/{post[1].lower()}'
        if re.fullmatch(r'/(?:r/[^/]+/)?s/[A-Za-z0-9]+/?', path):
            return f'https://www.reddit.com{path.rstrip("/")}'
    if host == 'v.redd.it' and re.fullmatch(r'/[a-z0-9]+(?:/DASH_[A-Za-z0-9_.-]+\.mp4)?/?', path, re.I):
        return f'https://v.redd.it/{path.split("/")[1]}'
    if host == 'i.redd.it' and re.fullmatch(r'/[a-z0-9]+\.(?:jpe?g|png|gif|webp)', path, re.I):
        return f'https://i.redd.it{path}'
    raise app.UserVisibleError('❌ لینک یک پست، گالری یا ویدیوی Reddit را بفرست؛ لینک پروفایل و انجمن پشتیبانی نمی‌شود.')


def page(session, url):
    """Bound redirects and response size; account cookies stay on Reddit."""
    for _ in range(5):
        url = checked_url(url, PAGE_HOSTS)
        response = session.get(url, allow_redirects=False, timeout=20, stream=True)
        try:
            if response.status_code in {301, 302, 303, 307, 308}:
                url = urljoin(url, response.headers.get('location', ''))
                continue
            if response.status_code != 200:
                raise app.UserVisibleError(ACCESS_ERROR)
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > 4_000_000:
                    raise app.UserVisibleError('❌ اطلاعات پست Reddit بیش از حد بزرگ است.')
                chunks.append(chunk)
            return b''.join(chunks), url
        finally:
            response.close()
    raise app.UserVisibleError('❌ تغییر مسیر لینک Reddit بیش از حد بود.')


def post_data(url, cookie_json=''):
    with browser_requests.Session(impersonate='chrome') as session:
        # Optional browser-exported cookies: no global session, credentials or logging.
        if cookie_json:
            try:
                cookies = json.loads(cookie_json)
                if not isinstance(cookies, list) or len(cookies) > 100:
                    raise ValueError('invalid cookies')
                for cookie in cookies:
                    domain = str(cookie.get('domain') or '').lstrip('.')
                    name, value = cookie.get('name'), cookie.get('value')
                    if (domain not in PAGE_HOSTS or not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', name)
                            or not isinstance(value, str) or len(value) > 16000 or any(ord(c) < 32 for c in value)):
                        raise ValueError('invalid cookie')
                    session.cookies.set(name, value, domain=cookie['domain'], path='/')
            except (ValueError, TypeError, AttributeError, KeyError) as exc:
                raise app.UserVisibleError('❌ تنظیمات نشست Reddit معتبر نیست؛ مدیر ربات باید آن را بررسی کند.') from exc
        try:
            if '/s/' in url:
                _, resolved = page(session, url)
                url = canonical_url(resolved)
                if '/comments/' not in url:
                    raise app.UserVisibleError('❌ لینک اشتراک‌گذاری Reddit به یک پست معتبر نرسید.')
            else:
                # Reddit's anonymous API requires a session cookie on some networks.
                try:
                    page(session, 'https://old.reddit.com/')
                except Exception:
                    pass
            raw, _ = page(session, f'{url}/.json?raw_json=1&limit=1')
            data = json.loads(raw)
            post = data[0]['data']['children'][0]['data']
            if not isinstance(post, dict) or post.get('removed_by_category'):
                raise ValueError('unavailable post')
            return post, url
        except app.UserVisibleError:
            raise
        except Exception as exc:
            # Never expose upstream bodies, signed URLs or session data.
            raise app.UserVisibleError(ACCESS_ERROR) from exc


def media_items(post):
    """Native media only. External YouTube/etc links never trigger extraction."""
    parents = post.get('crosspost_parent_list') or []
    if not isinstance(parents, list) or len(parents) > 10:
        raise app.UserVisibleError('❌ اطلاعات بازنشر Reddit معتبر نیست.')
    for data in [post, *parents]:
        if not isinstance(data, dict):
            continue
        for key in ('secure_media', 'media'):
            video = (data.get(key) or {}).get('reddit_video')
            if isinstance(video, dict):
                fallback = checked_url(video.get('fallback_url'), {'v.redd.it'})
                base = re.match(r'https://v\.redd\.it/([a-z0-9]+)/', fallback, re.I)
                if not base:
                    raise app.UserVisibleError('❌ آدرس ویدیوی Reddit معتبر نیست.')
                manifest = video.get('dash_url') or video.get('hls_url') or f'https://v.redd.it/{base[1]}/DASHPlaylist.mpd'
                return [{'kind': 'video', 'url': checked_url(manifest, {'v.redd.it'}),
                         'audio': not video.get('is_gif') and video.get('has_audio') is not False,
                         'duration': video.get('duration') or 0}]
        gallery = (data.get('gallery_data') or {}).get('items')
        if gallery is not None:
            if not isinstance(gallery, list) or not 1 <= len(gallery) <= MAX_ITEMS:
                raise app.UserVisibleError('❌ گالری‌های Reddit باید حداکثر ۲۰ فایل داشته باشند؛ گالری ناقص ارسال نمی‌شود.')
            result = []
            for item in gallery:
                media = (data.get('media_metadata') or {}).get(item.get('media_id'), {})
                source = media.get('s') or {}
                if media.get('status') != 'valid' or media.get('e') not in {'Image', 'AnimatedImage'}:
                    raise app.UserVisibleError('❌ یکی از فایل‌های گالری Reddit در دسترس نیست؛ گالری ناقص ارسال نمی‌شود.')
                result.append({'kind': 'image', 'url': checked_url(source.get('gif') or source.get('u'), {'i.redd.it', 'preview.redd.it'})})
            return result
        image = data.get('url_overridden_by_dest') or data.get('url') or ''
        if urlparse(image).hostname == 'i.redd.it':
            return [{'kind': 'image', 'url': checked_url(image, {'i.redd.it'})}]
    raise app.UserVisibleError('❌ این پست فایل مستقیمِ میزبانی‌شده روی Reddit ندارد؛ لینک سایت‌های دیگر را جدا بفرست.')


def image_file(item, path, limit, deadline):
    url = item['url']
    for _ in range(4):
        url = checked_url(url, {'i.redd.it', 'preview.redd.it'})
        with app.requests.get(url, stream=True, allow_redirects=False, timeout=(15, 30)) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                url = urljoin(url, response.headers.get('location', ''))
                continue
            if response.status_code != 200:
                raise app.UserVisibleError(ACCESS_ERROR)
            expected = int(response.headers.get('content-length') or 0)
            if expected > limit:
                raise app.UserVisibleError('❌ حجم فایل‌های Reddit از سقف ۲ گیگابایت بیشتر است.')
            size = 0
            with path.open('wb') as output:
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > limit or time.monotonic() > deadline:
                        raise app.UserVisibleError('❌ دریافت Reddit به سقف حجم یا زمان رسید؛ فایل ناقص ارسال نشد.')
                    output.write(chunk)
            if not size or expected and size != expected:
                raise app.UserVisibleError('❌ فایل Reddit ناقص دریافت شد؛ ارسال انجام نشد.')
            return
    raise app.UserVisibleError('❌ تغییر مسیر فایل Reddit بیش از حد بود.')


def video_file(job, item, directory, deadline):
    manifest = checked_url(item['url'], {'v.redd.it'})
    if item['audio'] is None:
        # A direct CDN link has no post metadata: keep audio whenever the manifest has it.
        selector = 'bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv[ext=mp4]'
    else:
        selector = 'bv[ext=mp4]+ba[ext=m4a]/b[ext=mp4][acodec!=none]' if item['audio'] else 'bv[ext=mp4]/b[ext=mp4]'
    command = [app.REAL_YTDLP, '--ignore-config', '--no-cache-dir', '--force-ipv4', '--no-playlist',
               '--use-extractors', 'Generic', '--no-warnings', '--no-progress', '--socket-timeout', '15',
               '--retries', '1', '--fragment-retries', '1', '--extractor-retries', '1',
               '--abort-on-unavailable-fragments', '--concurrent-fragments', '1', '--max-filesize', str(MAX_BYTES),
               '--format', selector, '--merge-output-format', 'mp4', '--remux-video', 'mp4',
               '--output', str(directory / 'Reddit.%(ext)s'), '--', manifest]
    # Monitor only this job's child process; the shared event-driven queue is unchanged.
    with (directory / 'download.log').open('wb') as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        with job.lock:
            job.process = process
        try:
            while process.poll() is None:
                files = list(directory.glob('*'))
                total = sum(file.stat().st_size for file in files if file.is_file())
                if job.cleanup_requested or time.monotonic() > deadline or total > MAX_BYTES * 2 + 1_000_000:
                    raise app.UserVisibleError('❌ دریافت ویدیوی Reddit متوقف شد یا به سقف حجم/زمان رسید؛ فایل ناقص ارسال نشد.')
                job.stop_event.wait(.25)
                if job.stop_event.is_set():
                    raise app.UserVisibleError('❌ دریافت ویدیوی Reddit متوقف شد.')
            if process.returncode:
                raise app.UserVisibleError('❌ ویدیوی کامل Reddit دریافت نشد؛ ممکن است صدا یا دسترسی فایل محدود باشد. خروجی ناقص ارسال نشد.')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=20)
            with job.lock:
                job.process = None
    return directory / 'Reddit.mp4'


def probe_file(path, item):
    try:
        if not 0 < path.stat().st_size <= MAX_BYTES:
            raise ValueError('invalid size')
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(path)],
                                capture_output=True, text=True, check=True, timeout=30)
        probe = json.loads(result.stdout)
        streams = probe.get('streams') or []
        video = next((stream for stream in streams if stream.get('codec_type') == 'video'), None)
        if not video:
            raise ValueError('not media')
        duration = float(probe.get('format', {}).get('duration') or 0)
        if item['kind'] == 'video':
            expected = float(item.get('duration') or 0)
            if (not math.isfinite(duration) or duration <= 0 or (expected > 0 and duration + max(2, expected * .02) < expected)
                    or item['audio'] and not any(stream.get('codec_type') == 'audio' for stream in streams)):
                raise ValueError('incomplete or missing audio')
        return {'duration': max(0, int(duration)), 'width': int(video.get('width') or 0), 'height': int(video.get('height') or 0)}
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
        raise app.UserVisibleError('❌ فایل سالم و کامل Reddit آماده نشد؛ فایل ناقص یا ویدیوی بدون صدای لازم ارسال نشد.') from exc


def prepare(job):
    url = canonical_url(job.source['reddit'].get('url') or '')
    if url.startswith('https://v.redd.it/'):
        items, title = [{'kind': 'video', 'url': url + '/DASHPlaylist.mpd', 'audio': None}], 'Reddit'
    elif url.startswith('https://i.redd.it/'):
        items, title = [{'kind': 'image', 'url': url}], 'Reddit'
    else:
        post, url = post_data(url, job.payload.get('redditCookies') or '')
        items, title = media_items(post), ' '.join(str(post.get('title') or 'Reddit').split())[:180]
    job.reddit_items, job.reddit_sent = [], 0
    job.reddit_title, job.reddit_url = title, url
    deadline, size = time.monotonic() + 20 * 60, 0
    for index, item in enumerate(items, 1):
        if job.cleanup_requested or job.stop_event.is_set() or time.monotonic() > deadline:
            raise app.UserVisibleError('❌ آماده‌سازی Reddit متوقف شد یا به سقف زمان رسید.')
        job.safe_status(f'⬇️ Reddit؛ آماده‌سازی فایل {index} از {len(items)}…')
        directory = job.workdir / f'reddit-{index}'
        directory.mkdir()
        if item['kind'] == 'video':
            path = video_file(job, item, directory, deadline)
        else:
            suffix = Path(urlparse(item['url']).path).suffix.lower()
            path = directory / ('Reddit' + (suffix if suffix in {'.jpg', '.jpeg', '.png', '.gif', '.webp'} else '.jpg'))
            image_file(item, path, MAX_BYTES - size, deadline)
        probe = probe_file(path, item)
        size += path.stat().st_size
        if size > MAX_BYTES:
            raise app.UserVisibleError('❌ حجم مجموع فایل‌های Reddit از سقف ۲ گیگابایت بیشتر است.')
        job.reddit_items.append({**item, **probe, 'path': path, 'index': index})
    job.result = {'ok': True}
    with job.lock:
        job.state = 'ready'


def send(job):
    deadline = time.monotonic() + 25 * 60
    try:
        for item in job.reddit_items[job.reddit_sent:]:
            if job.cleanup_requested or time.monotonic() >= deadline:
                raise app.UserVisibleError('Reddit sending stopped')
            path = item['path']
            # Images are sent as original documents, preserving quality and GIF animation.
            method = 'sendVideo' if item['kind'] == 'video' else 'sendDocument'
            data = {'chat_id': str(job.payload['chatId']),
                    'caption': f"{job.reddit_title}\nReddit • {item['index']}\n{job.reddit_url}"[:1024],
                    'reply_parameters': json.dumps({'message_id': job.payload['requestMessageId'], 'allow_sending_without_reply': True})}
            if method == 'sendVideo':
                data.update({key: str(item[key]) for key in ('duration', 'width', 'height')})
            with path.open('rb') as handle:
                asyncio.run(asyncio.wait_for(app.upload_complete_file(job.payload['botToken'], method, data,
                    (path.name, handle, 'video/mp4' if method == 'sendVideo' else 'application/octet-stream')),
                    timeout=max(1, min(10 * 60, deadline - time.monotonic()))))
            job.reddit_sent += 1
            path.unlink(missing_ok=True)
        job.result = {'ok': True, 'parts': job.reddit_sent, 'title': job.reddit_title}
        with job.lock:
            job.state = 'sent'
        app.delete_status(job.payload['botToken'], job.payload['chatId'], job.payload['statusMessageId'])
        return job.result
    except Exception as exc:
        print(f'Reddit upload failed: {type(exc).__name__}', flush=True)
        with job.lock:
            job.state = 'failed'
        job.result = {'ok': False, 'parts': job.reddit_sent, 'title': job.reddit_title,
                      'message': f'❌ ارسال Reddit کامل نشد؛ {job.reddit_sent} فایل تأیید شده است. برای جلوگیری از تکرار، ارسال متوقف شد؛ چت را بررسی کن.'}
        return job.result
