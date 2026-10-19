import asyncio
import concurrent.futures
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "container"))
import youtube_app as app
import youtube_pipeline as pipeline
from telethon.sessions import StringSession
from test_youtube_chat import isolated_uploader


class ConcurrentJobsTests(unittest.TestCase):
    def test_bounded_catalog_reuse_copies_metadata_and_client_into_an_isolated_request(self):
        url = "https://www.youtube.com/watch?v=abcdefghijk"
        with patch.object(app, "CATALOG_CACHE", {}):
            with app.request_cache(url):
                pipeline._save_session({"id": "abcdefghijk"}, "web_safari")
                first = app.metadata_cache_path()
            self.assertFalse(first.exists())
            expires = app.CATALOG_CACHE[url][0]
            with app.request_cache(url):
                self.assertNotEqual(app.metadata_cache_path(), first)
                metadata = app.load_metadata_cache(url)
                self.assertEqual(metadata["id"], "abcdefghijk")
                self.assertEqual(pipeline._load_session_client(metadata), "web_safari")
            self.assertEqual(app.CATALOG_CACHE[url][0], expires)
            for i in range(25):
                with app.request_cache(f"https://youtu.be/{i}"):
                    pipeline._save_session({"id": str(i)}, "web_embedded")
            self.assertLessEqual(len(app.CATALOG_CACHE), 20)
            app.CATALOG_CACHE[url] = (0, "{}", "{}")
            with app.request_cache(url):
                self.assertIsNone(app.load_metadata_cache(url))

    def test_five_real_http_downloads_overlap_and_sixth_is_rejected_without_waiting(self):
        barrier, release = threading.Barrier(6), threading.Event()
        paths = []
        capacity = app.JobCapacity()

        def download(payload):
            key = payload["id"]
            client = "web_embedded" if int(key) % 2 else "web_safari"
            pipeline._save_session({"id": key}, client)
            paths.append(app.metadata_cache_path())
            barrier.wait(timeout=4)
            if not release.wait(5):
                raise RuntimeError("test did not release active downloads")
            metadata = app.load_metadata_cache(f"https://youtu.be/{key}")
            self.assertEqual(metadata["id"], key)
            self.assertEqual(pipeline._load_session_client(metadata), client)
            return {"ok": True, "owner": key}

        with patch.object(app, "JOB_CAPACITY", capacity), patch.object(app, "process_job", download):
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/download"
                with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
                    futures = [pool.submit(app.requests.post, url, json={"id": str(i)}, timeout=8) for i in range(5)]
                    try:
                        barrier.wait(timeout=4)  # All five handlers entered process_job together.
                        self.assertEqual(len(capacity.jobs), 5)
                        sixth = app.requests.post(url, json={"id": "overflow"}, timeout=1)
                        self.assertEqual(sixth.status_code, 429)
                    finally:
                        release.set()
                    for i, future in enumerate(futures):
                        response = future.result(timeout=4)
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.json(), {"ok": True, "owner": str(i)})
                self.assertEqual(capacity.jobs, set())
                self.assertEqual(len(set(paths)), 5)
                self.assertTrue(all(not path.exists() for path in paths))
                with patch.object(app, "process_job", side_effect=RuntimeError("failed job")):
                    self.assertEqual(app.requests.post(url, json={"id": "failure"}, timeout=2).status_code, 500)
                self.assertEqual(capacity.jobs, set(), "exceptions must release admission")
            finally:
                release.set()
                server.shutdown()
                server.server_close()
                thread.join(2)

    def test_background_and_http_jobs_share_five_slots_and_cleanup_is_per_job(self):
        capacity = app.JobCapacity()
        with patch.object(app, "JOB_CAPACITY", capacity), patch.object(app, "INSTAGRAM_JOBS", {}), \
                patch.object(threading.Thread, "start"), patch.object(threading.Timer, "start"):
            def payload(index):
                key = f"igdl-42-{index}-42"
                return {"id": key, "source": {"mode": "live"},
                    "completionUrl": f"https://downloader.vexaagent.workers.dev/instagram/events/{key}",
                    "completionToken": "0" * 64}
            try:
                for i in range(2):
                    self.assertTrue(app.instagram_action("start", payload(i))["ok"])
                for i in range(3):
                    self.assertTrue(capacity.acquire(f"http-{i}"))
                self.assertFalse(app.instagram_action("start", payload(2))["ok"])
                self.assertTrue(app.instagram_action("start", payload(0))["ok"], "start retries are idempotent")
                self.assertEqual(len(capacity.jobs), 5)
                app.instagram_action("stop", {"id": payload(0)["id"]})
                self.assertTrue(app.INSTAGRAM_JOBS[payload(0)["id"]].stop_event.is_set())
                self.assertFalse(app.INSTAGRAM_JOBS[payload(1)["id"]].stop_event.is_set())
                app.instagram_action("cleanup", {"id": payload(0)["id"]})
                self.assertIn(payload(1)["id"], app.INSTAGRAM_JOBS)
                self.assertTrue(app.instagram_action("start", payload(2))["ok"])
                with self.assertRaises(ValueError):
                    invalid = payload(3)
                    invalid["completionToken"] = "invalid"
                    capacity.release("http-0")
                    app.instagram_action("start", invalid)
                self.assertNotIn(payload(3)["id"], capacity.jobs)
            finally:
                for key in list(app.INSTAGRAM_JOBS):
                    app.instagram_action("cleanup", {"id": key})

    def test_five_uploads_share_one_connection_with_independent_bytes_and_destinations(self):
        clients = []

        class Client:
            def __init__(self, session, *args, **kwargs):
                self.session, self.parts, self.sends = session, {}, []
                self.starts = 0
                self.all_sending = asyncio.Event()
                clients.append(self)

            def is_connected(self):
                return True

            async def start(self, **kwargs):
                self.starts += 1
                await asyncio.sleep(0)
                return self

            async def disconnect(self):
                self.disconnected = True

            async def __call__(self, request):
                self.parts.setdefault(request.file_id, {})[request.file_part] = request.bytes
                await asyncio.sleep(0)
                return True

            async def send_file(self, destination, file, **kwargs):
                self.sends.append((destination, file.id))
                if len(self.sends) == 5:
                    self.all_sending.set()
                await asyncio.wait_for(self.all_sending.wait(), 3)
                return SimpleNamespace(id=destination)

        def upload(index, directory):
            path = Path(directory) / f"video-{index}.mp4"
            path.write_bytes(bytes([index]) * 600_001)
            with path.open("rb") as handle:
                result = asyncio.run(app.upload_complete_file("test-token", "sendVideo", {"chat_id": str(index)}, (path.name, handle, "video/mp4")))
            self.assertEqual(result["message_id"], index)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"API_ID": "123", "API_HASH": "test"}), \
                patch("telethon.TelegramClient", Client), isolated_uploader(), concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(upload, i, directory) for i in range(5)]
            for future in futures:
                future.result(timeout=6)
        self.assertEqual(len(clients), 1)
        client = clients[0]
        self.assertIsInstance(client.session, StringSession)
        self.assertEqual(client.starts, 1)
        self.assertTrue(client.disconnected)
        self.assertEqual(len(client.parts), 5)
        for destination, file_id in client.sends:
            parts = client.parts[file_id]
            self.assertEqual(b"".join(parts[i] for i in sorted(parts)), bytes([destination]) * 600_001)


if __name__ == "__main__":
    unittest.main()
