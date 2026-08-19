import json
import threading
from urllib.parse import parse_qs, urlparse

import mini_live_entry as live

app = live.app
mini_pipeline = live.mini_pipeline
mini_pipeline.MINI_FILE_TTL_SECONDS = 2 * 60 * 60

JOBS: dict[str, dict[str, object]] = {}
JOBS_LOCK = threading.Lock()


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

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/mini/status":
            self._send_status()
            return
        super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path == "/mini/start":
            self._start_prepare()
            return
        super().do_POST()


if __name__ == "__main__":
    server = app.ThreadingHTTPServer(("0.0.0.0", app.PORT), MiniAsyncHandler)
    print(
        f"youtube downloader listening on :{app.PORT} "
        "(async Mini App prepare + streaming large files)",
        flush=True,
    )
    server.serve_forever()
