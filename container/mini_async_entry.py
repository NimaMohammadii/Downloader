import json
import threading
import time
from urllib.parse import parse_qs, urlparse

import mini_live_entry as live

app = live.app
mini_pipeline = live.mini_pipeline
mini_pipeline.MINI_FILE_TTL_SECONDS = 2 * 60 * 60

JOBS: dict[str, dict[str, object]] = {}
JOBS_LOCK = threading.Lock()

WATCH_STREAMS: dict[str, dict[str, object]] = {}
WATCH_STREAMS_LOCK = threading.Lock()
WATCH_STREAM_TTL_SECONDS = 30 * 60
WATCH_QUALITY_VALUES = {144, 240, 360, 480, 720, 1080}
WATCH_AUTO_FORMAT = (
    "b[protocol=https][ext=mp4][height<=720]/"
    "b[protocol=https][ext=mp4]/"
    "b[protocol=https]"
)


def _set_job(file_id: str, payload: dict[str, object]) -> None:
    with JOBS_LOCK:
        JOBS[file_id] = payload


def _get_job(file_id: str) -> dict[str, object] | None:
    with JOBS_LOCK:
        value = JOBS.get(file_id)
        return dict(value) if value is not None else None


def _job_worker(payload: dict[str, object]) -> None:
    file_id = str(payload.get("fileId") or "")
    try:
        result = mini_pipeline._prepare_file(payload)
        _set_job(file_id, {"ok": True, "state": "ready", **result})
        print(
            f"mini async prepare ready file={file_id} size={result.get('size', 0)}",
            flush=True,
        )
    except app.UserVisibleError as exc:
        _set_job(file_id, {"ok": False, "state": "error", "message": str(exc)})
        print(f"mini async prepare user error file={file_id}: {exc}", flush=True)
    except Exception as exc:
        _set_job(
            file_id,
            {
                "ok": False,
                "state": "error",
                "message": "❌ آماده‌سازی فایل انجام نشد. دوباره امتحان کن.",
            },
        )
        print(
            f"mini async prepare failed file={file_id}: {type(exc).__name__}: {exc}",
            flush=True,
        )


def _cleanup_watch_streams() -> None:
    cutoff = time.time() - WATCH_STREAM_TTL_SECONDS
    with WATCH_STREAMS_LOCK:
        stale = [
            stream_id
            for stream_id, stream in WATCH_STREAMS.items()
            if float(stream.get("createdAt") or 0) < cutoff
        ]
        for stream_id in stale:
            WATCH_STREAMS.pop(stream_id, None)


def _set_watch_stream(stream_id: str, payload: dict[str, object]) -> None:
    _cleanup_watch_streams()
    with WATCH_STREAMS_LOCK:
        WATCH_STREAMS[stream_id] = payload


def _get_watch_stream(stream_id: str) -> dict[str, object] | None:
    _cleanup_watch_streams()
    with WATCH_STREAMS_LOCK:
        value = WATCH_STREAMS.get(stream_id)
        return dict(value) if value is not None else None


def _watch_http_headers(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    headers: dict[str, str] = {}
    blocked = {"host", "content-length", "range", "connection", "transfer-encoding"}
    for key, item in value.items():
        name = str(key).strip()
        text = str(item).strip()
        if not name or not text or name.lower() in blocked:
            continue
        headers[name] = text
    return headers


def _is_progressive_watch_format(item: object) -> bool:
    if not isinstance(item, dict):
        return False
    direct_url = str(item.get("url") or "").strip()
    protocol = str(item.get("protocol") or "").lower()
    vcodec = str(item.get("vcodec") or "none").lower()
    acodec = str(item.get("acodec") or "none").lower()
    return (
        direct_url.startswith("https://")
        and protocol in {"https", "http"}
        and vcodec != "none"
        and acodec != "none"
    )


def _selected_progressive_format(metadata: object) -> dict[str, object] | None:
    if not isinstance(metadata, dict):
        return None

    candidates: list[dict[str, object]] = []
    requested = metadata.get("requested_downloads")
    if isinstance(requested, list):
        candidates.extend(item for item in requested if isinstance(item, dict))
    candidates.append(metadata)

    for item in candidates:
        if _is_progressive_watch_format(item):
            return item
    return None


def _progressive_watch_qualities(metadata: object) -> list[int]:
    if not isinstance(metadata, dict):
        return []
    candidates: list[dict[str, object]] = []
    formats = metadata.get("formats")
    if isinstance(formats, list):
        candidates.extend(item for item in formats if isinstance(item, dict))
    requested = metadata.get("requested_downloads")
    if isinstance(requested, list):
        candidates.extend(item for item in requested if isinstance(item, dict))
    candidates.append(metadata)

    qualities: set[int] = set()
    for item in candidates:
        if not _is_progressive_watch_format(item):
            continue
        try:
            height = int(item.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if height in WATCH_QUALITY_VALUES:
            qualities.add(height)
    return sorted(qualities, reverse=True)


def _watch_format_selector(quality: int | None) -> str:
    if quality is None:
        return WATCH_AUTO_FORMAT
    return (
        f"b[protocol=https][ext=mp4][height={quality}]/"
        f"b[protocol=https][height={quality}]"
    )


def _resolve_watch_stream(url: str, stream_id: str, quality: int | None) -> dict[str, object]:
    metadata_cache = app.load_metadata_cache(url)
    preferred = live.pipeline._load_session_client(metadata_cache)
    errors: list[str] = []
    format_selector = _watch_format_selector(quality)

    for client in live.pipeline._client_order(preferred):
        try:
            result = app.run_command(
                [
                    app.REAL_YTDLP,
                    *live.pipeline._client_args(client),
                    "--skip-download",
                    "--dump-single-json",
                    "--no-warnings",
                    "--format",
                    format_selector,
                    url,
                ],
                timeout=app.METADATA_TIMEOUT_SECONDS,
            )
            metadata = json.loads(result.stdout)
            selected = _selected_progressive_format(metadata)
            if selected is None:
                errors.append(f"{client}: no progressive combined format")
                continue

            try:
                selected_quality = int(selected.get("height") or 0) or None
            except (TypeError, ValueError):
                selected_quality = None
            if quality is not None and selected_quality != quality:
                errors.append(f"{client}: requested {quality}p but selected {selected_quality or 'unknown'}p")
                continue

            direct_url = str(selected.get("url") or "").strip()
            mime = "video/mp4" if str(selected.get("ext") or "").lower() == "mp4" else "video/mp4"
            title = str(metadata.get("title") or "YouTube video").strip()
            headers = _watch_http_headers(selected.get("http_headers") or metadata.get("http_headers"))
            qualities = _progressive_watch_qualities(metadata)
            if selected_quality in WATCH_QUALITY_VALUES and selected_quality not in qualities:
                qualities.append(selected_quality)
                qualities.sort(reverse=True)
            payload: dict[str, object] = {
                "streamId": stream_id,
                "url": direct_url,
                "mime": mime,
                "title": title,
                "quality": selected_quality,
                "qualities": qualities,
                "headers": headers,
                "createdAt": time.time(),
                "client": client,
            }
            _set_watch_stream(stream_id, payload)
            print(
                f"mini watch stream ready stream={stream_id[:8]} client={client} quality={selected_quality or 'auto'}",
                flush=True,
            )
            return payload
        except app.UserVisibleError as exc:
            errors.append(f"{client}: {exc}")
            print(f"mini watch resolve client={client} failed: {exc}", flush=True)
        except Exception as exc:
            errors.append(f"{client}: {type(exc).__name__}: {exc}")
            print(
                f"mini watch resolve client={client} failed: {type(exc).__name__}: {exc}",
                flush=True,
            )

    detail = errors[-1] if errors else "no compatible progressive stream"
    raise app.UserVisibleError(
        "❌ پخش آنلاین برای این ویدیو از مسیر سازگار پیدا نشد. "
        "می‌تونی حالت Download رو استفاده کنی."
    ) from RuntimeError(detail)


class MiniAsyncHandler(mini_pipeline.MiniAppHandler):
    def _read_payload(self) -> dict[str, object] | None:
        try:
            content_length = int(self.headers.get("content-length", "0"))
            if content_length <= 0 or content_length > 100_000:
                return None
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            return payload if isinstance(payload, dict) else None
        except Exception:
            return None

    def _start_prepare(self) -> None:
        payload = self._read_payload()
        if payload is None:
            self._send_json(400, {"ok": False, "message": "❌ درخواست نامعتبره."})
            return

        file_id = str(payload.get("fileId") or "").strip()
        if not mini_pipeline.FILE_ID_RE.fullmatch(file_id):
            self._send_json(400, {"ok": False, "message": "❌ درخواست دانلود نامعتبره."})
            return

        current = _get_job(file_id)
        if current is not None:
            self._send_json(200, current)
            return

        # A Mini App session maps to one Container. Keep one prepare active at a
        # time because the yt-dlp metadata/session cache is scoped to that session.
        with JOBS_LOCK:
            if any(job.get("state") == "preparing" for job in JOBS.values()):
                self._send_json(
                    409,
                    {"ok": False, "message": "یک دانلود دیگه هنوز در حال آماده‌سازیه."},
                )
                return
            JOBS[file_id] = {"ok": True, "state": "preparing", "fileId": file_id}

        thread = threading.Thread(
            target=_job_worker,
            args=(payload,),
            name=f"mini-prepare-{file_id[:8]}",
            daemon=True,
        )
        thread.start()
        self._send_json(202, {"ok": True, "state": "preparing", "fileId": file_id})

    def _start_watch(self) -> None:
        payload = self._read_payload()
        if payload is None:
            self._send_json(400, {"ok": False, "message": "❌ درخواست نامعتبره."})
            return

        stream_id = str(payload.get("streamId") or "").strip()
        url = str(payload.get("url") or "").strip()
        raw_quality = payload.get("quality")
        quality: int | None = None
        if raw_quality not in {None, ""}:
            try:
                quality = int(raw_quality)
            except (TypeError, ValueError):
                self._send_json(400, {"ok": False, "message": "❌ کیفیت پخش نامعتبره."})
                return
            if quality not in WATCH_QUALITY_VALUES:
                self._send_json(400, {"ok": False, "message": "❌ کیفیت پخش نامعتبره."})
                return
        if not mini_pipeline.FILE_ID_RE.fullmatch(stream_id) or not app.youtube_video_id(url):
            self._send_json(400, {"ok": False, "message": "❌ درخواست پخش نامعتبره."})
            return

        existing = _get_watch_stream(stream_id)
        if existing is not None:
            self._send_json(
                200,
                {
                    "ok": True,
                    "streamId": stream_id,
                    "title": existing.get("title"),
                    "mime": existing.get("mime"),
                    "quality": existing.get("quality"),
                    "qualities": existing.get("qualities") or [],
                },
            )
            return

        try:
            stream = _resolve_watch_stream(url, stream_id, quality)
            self._send_json(
                200,
                {
                    "ok": True,
                    "streamId": stream_id,
                    "title": stream.get("title"),
                    "mime": stream.get("mime"),
                    "quality": stream.get("quality"),
                    "qualities": stream.get("qualities") or [],
                },
            )
        except app.UserVisibleError as exc:
            self._send_json(200, {"ok": False, "message": str(exc)})
        except Exception as exc:
            print(f"mini watch start failed: {type(exc).__name__}: {exc}", flush=True)
            self._send_json(500, {"ok": False, "message": "❌ پخش آنلاین شروع نشد."})

    def _send_status(self) -> None:
        parsed = urlparse(self.path)
        file_id = (parse_qs(parsed.query).get("fileId") or [""])[0]
        if not mini_pipeline.FILE_ID_RE.fullmatch(file_id):
            self._send_json(
                400,
                {"ok": False, "state": "error", "message": "❌ شناسه دانلود نامعتبره."},
            )
            return

        loaded = mini_pipeline._load_manifest(file_id)
        if loaded is not None:
            manifest, _ = loaded
            self._send_json(200, {"ok": True, "state": "ready", **manifest})
            return

        current = _get_job(file_id)
        if current is None:
            self._send_json(
                404,
                {
                    "ok": False,
                    "state": "error",
                    "message": "❌ این دانلود دیگه فعال نیست. دوباره Prepare رو بزن.",
                },
            )
            return
        self._send_json(200, current)

    def _serve_watch(self, *, head_only: bool) -> None:
        parsed = urlparse(self.path)
        stream_id = (parse_qs(parsed.query).get("streamId") or [""])[0]
        if not mini_pipeline.FILE_ID_RE.fullmatch(stream_id):
            self._send_json(400, {"ok": False, "message": "invalid stream"})
            return

        stream = _get_watch_stream(stream_id)
        if stream is None:
            self._send_json(404, {"ok": False, "message": "stream expired"})
            return

        direct_url = str(stream.get("url") or "")
        headers = _watch_http_headers(stream.get("headers"))
        requested_range = self.headers.get("range")
        if requested_range:
            headers["Range"] = requested_range

        response = None
        response_started = False
        try:
            if head_only:
                response = app.requests.head(
                    direct_url,
                    headers=headers,
                    allow_redirects=True,
                    timeout=(20, 90),
                )
                if response.status_code >= 400:
                    response.close()
                    fallback_headers = dict(headers)
                    fallback_headers.setdefault("Range", "bytes=0-0")
                    response = app.requests.get(
                        direct_url,
                        headers=fallback_headers,
                        allow_redirects=True,
                        stream=True,
                        timeout=(20, 90),
                    )
            else:
                response = app.requests.get(
                    direct_url,
                    headers=headers,
                    allow_redirects=True,
                    stream=True,
                    timeout=(20, 900),
                )

            if response.status_code not in {200, 206}:
                print(
                    f"mini watch upstream rejected stream={stream_id[:8]} status={response.status_code}",
                    flush=True,
                )
                self._send_json(502, {"ok": False, "message": "stream unavailable"})
                return

            self.send_response(response.status_code)
            for name in (
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "etag",
                "last-modified",
            ):
                value = response.headers.get(name)
                if value:
                    self.send_header(name, value)
            if not response.headers.get("content-type"):
                self.send_header("content-type", str(stream.get("mime") or "video/mp4"))
            self.send_header("cache-control", "private, no-store")
            self.send_header("cross-origin-resource-policy", "cross-origin")
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            response_started = True

            if head_only:
                return

            try:
                for chunk in response.iter_content(chunk_size=512 * 1024):
                    if chunk:
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        except Exception as exc:
            print(
                f"mini watch proxy failed stream={stream_id[:8]}: {type(exc).__name__}: {exc}",
                flush=True,
            )
            if not response_started:
                try:
                    self._send_json(502, {"ok": False, "message": "stream failed"})
                except Exception:
                    pass
        finally:
            if response is not None:
                response.close()

    def do_HEAD(self) -> None:
        if urlparse(self.path).path == "/mini/watch":
            self._serve_watch(head_only=True)
            return
        super().do_HEAD()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/mini/status":
            self._send_status()
            return
        if path == "/mini/watch":
            self._serve_watch(head_only=False)
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/mini/start":
            self._start_prepare()
            return
        if path == "/mini/watch/start":
            self._start_watch()
            return
        super().do_POST()


if __name__ == "__main__":
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), MiniAsyncHandler)
    print(
        f"youtube downloader listening on :{app.PORT} "
        "(async Mini App prepare + in-app watch streaming)",
        flush=True,
    )
    server.serve_forever()
