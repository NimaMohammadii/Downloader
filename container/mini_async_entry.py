"""Browser transport around the unchanged Telegram download engine."""
import json
import threading
from urllib.parse import parse_qs, urlencode, urlparse

import mini_pipeline

app = mini_pipeline.app
pipeline = mini_pipeline.pipeline


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

    def do_HEAD(self) -> None:
        with app.server_activity():
            if urlparse(self.path).path == "/mini/watch":
                self._serve_watch(True)
            else:
                super().do_HEAD()

    def do_GET(self) -> None:
        with app.server_activity():
            if urlparse(self.path).path == "/mini/watch":
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
