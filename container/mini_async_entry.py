"""Browser transport around the unchanged Telegram download engine."""
import hashlib
import json
import re
import time
import threading
from urllib.parse import parse_qs, urlencode, urlparse

import mini_pipeline

app = mini_pipeline.app
pipeline = mini_pipeline.pipeline


SUBTITLE_ID_RE = re.compile(r"^[a-f0-9]{16}$")
SUBTITLE_MAX_BYTES = 2 * 1024 * 1024
SUBTITLE_LOCK = threading.Lock()


def _subtitle_url_allowed(value: str, video_id: str) -> bool:
    try:
        parsed = urlparse(value)
        return (len(value) <= 8192 and parsed.scheme == "https"
                and parsed.hostname in {"www.youtube.com", "youtube.com"}
                and parsed.port in {None, 443} and not parsed.username and not parsed.password
                and not parsed.fragment and parsed.path == "/api/timedtext"
                and parse_qs(parsed.query).get("v") == [video_id]
                and parse_qs(parsed.query).get("fmt") == ["vtt"])
    except (TypeError, ValueError):
        return False


def _save_subtitle_catalog(metadata: dict, file_id: str) -> list[dict]:
    """Use the existing engine's catalog; do not run another extractor."""
    catalog = {}
    video_id = str(metadata.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return []
    for field, kind in (("subtitles", "manual"), ("automatic_captions", "automatic")):
        languages = metadata.get(field)
        if not isinstance(languages, dict):
            continue
        for language, formats in languages.items():
            if (not isinstance(language, str) or language == "live_chat"
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", language)
                    or not isinstance(formats, list)):
                continue
            chosen = next((item for item in reversed(formats)
                           if isinstance(item, dict) and item.get("ext") == "vtt"
                           and isinstance(item.get("url"), str)
                           and _subtitle_url_allowed(item["url"], video_id)), None)
            if chosen is None:
                continue
            actual_kind = "translated" if parse_qs(urlparse(chosen["url"]).query).get("tlang") else kind
            track_id = hashlib.sha256(f"{kind}:{language}".encode()).hexdigest()[:16]
            label = re.sub(r"[\x00-\x1f\x7f]", " ", str(chosen.get("name") or language))[:100]
            headers = chosen.get("http_headers") or metadata.get("http_headers") or {}
            agent = headers.get("User-Agent") if isinstance(headers, dict) else None
            catalog[track_id] = {"id": track_id, "language": language, "label": label,
                                 "kind": actual_kind, "url": chosen["url"], "videoId": video_id}
            if isinstance(agent, str) and len(agent) <= 1024 and "\r" not in agent and "\n" not in agent:
                catalog[track_id]["userAgent"] = agent
            if len(catalog) >= 200:
                break
        if len(catalog) >= 200:
            break
    path = mini_pipeline.MINI_ROOT / file_id / "subtitles.json"
    path.write_text(json.dumps(catalog), encoding="utf-8")
    return [{key: item[key] for key in ("id", "language", "label", "kind")} for item in catalog.values()]


def _subtitle_bytes(file_id: str, track_id: str) -> bytes:
    if not mini_pipeline.FILE_ID_RE.fullmatch(file_id) or not SUBTITLE_ID_RE.fullmatch(track_id):
        raise FileNotFoundError("Unknown subtitles")
    loaded = mini_pipeline._load_manifest(file_id)
    if loaded is None:
        raise FileNotFoundError("Video expired")
    _, video_path = loaded
    directory = video_path.parent
    with SUBTITLE_LOCK:
        catalog = json.loads((directory / "subtitles.json").read_text(encoding="utf-8"))
        item = catalog.get(track_id) if isinstance(catalog, dict) else None
        if not isinstance(item, dict) or not _subtitle_url_allowed(str(item.get("url") or ""), str(item.get("videoId") or "")):
            raise FileNotFoundError("Unknown subtitles")
        path = directory / f"subtitle-{track_id}.vtt"
        if path.is_file() and path.stat().st_size <= SUBTITLE_MAX_BYTES:
            directory.touch()
            return path.read_bytes()
        headers = {"Accept": "text/vtt"}
        if item.get("userAgent"):
            headers["User-Agent"] = item["userAgent"]
        # Restrict every fetch to the video's validated YouTube timed-text URL.
        # No redirects, arbitrary browser URL, cookies or automatic retries.
        with app.requests.get(item["url"], headers=headers, timeout=(5, 15),
                              allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                print(f"web subtitle source rejected status={response.status_code}", flush=True)
                raise app.UserVisibleError("YouTube did not provide this subtitle track.")
            if int(response.headers.get("content-length") or 0) > SUBTITLE_MAX_BYTES:
                raise app.UserVisibleError("Subtitle file is too large.")
            content = bytearray()
            deadline = time.monotonic() + 20
            for chunk in response.iter_content(chunk_size=16 * 1024):
                content.extend(chunk)
                if len(content) > SUBTITLE_MAX_BYTES or time.monotonic() > deadline:
                    raise app.UserVisibleError("Subtitle response exceeded its limit.")
        text = bytes(content).decode("utf-8-sig")
        if not re.match(r"^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)", text) or "\x00" in text:
            raise app.UserVisibleError("YouTube returned an invalid subtitle file.")
        data = text.encode("utf-8")
        temp = path.with_suffix(".tmp")
        temp.write_bytes(data)
        temp.replace(path)
        directory.touch()
        return data


class MiniAsyncHandler(mini_pipeline.MiniAppHandler):
    def _prepare_response(self, watch: bool) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            if not 0 < length <= 32_768:
                raise ValueError("body size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("body type")
            url = str(payload.get("url") or "")
            file_id = str(payload.get("streamId" if watch else "fileId") or "")
            if not app.youtube_video_id(url) or not mini_pipeline.FILE_ID_RE.fullmatch(file_id):
                raise ValueError("video or media ID")
        except (ValueError, TypeError):
            self._send_json(400, {"ok": False, "message": "Invalid request."})
            return

        # This web session has one preparation at a time. Bot pool admission,
        # upload jobs and Telegram destinations are never invoked here.
        if not app.JOB_CAPACITY.acquire("web-prepare"):
            self._send_json(409, {"ok": False, "message": "A video is still being prepared."})
            return

        done = threading.Event()
        result = {}

        def prepare():
            try:
                with app.server_activity(), app.request_cache(url):
                    metadata = pipeline.fetch_metadata(url)
                    app.validate_video_metadata(metadata)
                    qualities = pipeline.available_qualities(metadata)
                    quality = payload.get("quality")
                    if watch:
                        if not qualities:
                            raise app.UserVisibleError("No playable video quality is available.")
                        if quality is None:
                            quality = next((q for q in (720, 480, 360, 1080) if q in qualities), qualities[0])
                        if isinstance(quality, bool) or quality not in qualities:
                            raise app.UserVisibleError("This quality is not available.")
                    prepared = mini_pipeline._prepare_file({
                        **payload, "fileId": file_id,
                        **({"quality": quality, "audioMode": None} if watch else {}),
                    })
                    result.update(prepared, state="ready")
                    if watch:
                        result.update(streamId=file_id, quality=quality, qualities=qualities)
                        try:
                            result["subtitles"] = _save_subtitle_catalog(metadata, file_id)
                        except Exception as exc:
                            # Optional captions never invalidate a playable video.
                            print(f"web subtitle catalog unavailable: {type(exc).__name__}", flush=True)
                            result["subtitles"] = []
            except app.UserVisibleError as exc:
                result.update(ok=False, message=str(exc))
            except Exception as exc:
                # Do not log source URLs, cookies or signed CDN links.
                print(f"web prepare failed: {type(exc).__name__}", flush=True)
                result.update(ok=False, message="Could not prepare this video.")
            finally:
                app.JOB_CAPACITY.release("web-prepare")
                done.set()

        started = False
        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("connection", "close")
            self.end_headers()
            self.close_connection = True
            self._event({"ok": True, "state": "preparing"})
            thread = threading.Thread(target=prepare, daemon=True)
            thread.start()
            started = True
            # One open response, awakened by completion. These comments keep
            # the transport alive; no repeated HTTP status requests are made.
            while not done.wait(15):
                self.wfile.write(b": preparing\n\n")
                self.wfile.flush()
            self._event(result)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            # A disconnected browser must not start another job over the
            # worker that is still preparing its file.
            if not started:
                app.JOB_CAPACITY.release("web-prepare")

    def _event(self, payload: dict) -> None:
        self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode())
        self.wfile.flush()

    def _serve_watch(self, head_only: bool) -> None:
        stream_id = (parse_qs(urlparse(self.path).query).get("streamId") or [""])[0]
        self.path = "/mini/file?" + urlencode({"fileId": stream_id})
        self.file_disposition = "inline"
        self._serve_mini_file(head_only=head_only)

    def _serve_subtitle(self, head_only: bool) -> None:
        query = parse_qs(urlparse(self.path).query)
        file_id = (query.get("streamId") or [""])[0]
        track_id = (query.get("trackId") or [""])[0]
        try:
            data = _subtitle_bytes(file_id, track_id)
        except (FileNotFoundError, KeyError):
            self._send_json(404, {"ok": False, "message": "Subtitles are no longer available."})
            return
        except Exception as exc:
            print(f"web subtitle fetch failed: {type(exc).__name__}", flush=True)
            self._send_json(502, {"ok": False, "message": "Could not load subtitles. Video playback is unaffected."})
            return
        self.send_response(200)
        self.send_header("content-type", "text/vtt; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "private, no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_HEAD(self) -> None:
        with app.server_activity():
            if urlparse(self.path).path == "/mini/subtitle":
                self._serve_subtitle(True)
            elif urlparse(self.path).path == "/mini/watch":
                self._serve_watch(True)
            else:
                super().do_HEAD()

    def do_GET(self) -> None:
        with app.server_activity():
            if urlparse(self.path).path == "/mini/subtitle":
                self._serve_subtitle(False)
            elif urlparse(self.path).path == "/mini/watch":
                self._serve_watch(False)
            else:
                super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path in {"/mini/start", "/mini/watch/start"}:
            with app.server_activity():
                self._prepare_response(path == "/mini/watch/start")
        else:
            super().do_POST()


if __name__ == "__main__":
    # The image still starts youtube_pipeline.py for bot containers. Only the
    # web RPC selects this adapter as its per-instance entrypoint.
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), MiniAsyncHandler)
    app.SERVER_IDLE = app.IdleExit(300, lambda: bool(app.JOB_CAPACITY.jobs))
    app.SERVER_IDLE.refresh()
    print(f"web video transport listening on :{app.PORT}; shared bot engine", flush=True)
    server.serve_forever()
