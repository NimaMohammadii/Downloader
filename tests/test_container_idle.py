import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "container"))
import youtube_app as app


class IdleExitTests(unittest.TestCase):
    def test_cancelled_timer_cannot_exit_an_active_or_newer_request(self):
        exits = []
        guard = app.IdleExit(60, lambda: False, exits.append)
        try:
            guard.refresh()
            old = guard.generation
            guard.begin()
            guard._expire(old)
            guard._expire(guard.generation)
            self.assertEqual(exits, [])
            guard.end()
            guard._expire(old)
            self.assertEqual(exits, [])
            guard._expire(guard.generation)
            self.assertEqual(exits, [0])
        finally:
            guard._cancel()

    def test_pending_media_protects_files_between_preparation_and_send(self):
        exits, pending = [], [True]
        guard = app.IdleExit(60, lambda: pending[0], exits.append)
        try:
            guard.refresh()
            guard._expire(guard.generation)
            self.assertEqual(exits, [])
            pending[0] = False
            guard.refresh()
            guard._expire(guard.generation)
            self.assertEqual(exits, [0])
        finally:
            guard._cancel()

    def test_capture_thread_holds_activity_until_its_work_finishes(self):
        guard = app.IdleExit(60, lambda: False, lambda code: self.fail("active capture exited"))
        entered, release = threading.Event(), threading.Event()
        capture = object.__new__(app.InstagramCapture)
        def work():
            entered.set()
            release.wait(2)
        capture.run = work
        previous, app.SERVER_IDLE = app.SERVER_IDLE, guard
        thread = threading.Thread(target=capture.run_active)
        try:
            thread.start()
            self.assertTrue(entered.wait(1))
            self.assertEqual(guard.active, 1)
            guard._expire(guard.generation)
            release.set()
            thread.join(2)
            self.assertEqual(guard.active, 0)
        finally:
            release.set()
            thread.join(2)
            guard._cancel()
            app.SERVER_IDLE = previous


class ServerExitTests(unittest.TestCase):
    def start_server(self, extra="", *, accelerated=True):
        script = "import youtube_app as app\nimport time, threading\napp.PORT = 0\n"
        if accelerated:
            script += "OriginalIdleExit = app.IdleExit\napp.IdleExit = lambda seconds, busy: OriginalIdleExit(0.35, busy)\n"
        script += extra + "\napp.serve()\n"
        child = subprocess.Popen([sys.executable, "-u", "-c", script],
            env={**os.environ, "PYTHONPATH": str(Path(app.__file__).parent)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_server, child)
        line = child.stdout.readline()
        self.assertIn("idle-exit-v2", line)
        port = int(line.split("listening on :")[1].split()[0])
        return child, port

    @staticmethod
    def stop_server(child):
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=3)

    def test_real_server_exits_after_ten_seconds_without_sdk_activity(self):
        child, _ = self.start_server(accelerated=False)
        started = time.monotonic()
        child.communicate(timeout=13)
        self.assertEqual(child.returncode, 0)
        self.assertGreaterEqual(time.monotonic() - started, 9)

    def test_real_slow_http_request_outlives_idle_timeout(self):
        child, port = self.start_server('''original_get = app.Handler.handle_get
def slow_get(self):
    if self.path == "/slow":
        print("slow request entered", flush=True)
        time.sleep(1.2)
    original_get(self)
app.Handler.handle_get = slow_get
''')
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(app.requests.get, f"http://127.0.0.1:{port}/slow", timeout=3)
            self.assertIn("slow request entered", child.stdout.readline())
            time.sleep(0.6)
            self.assertIsNone(child.poll())
            self.assertEqual(future.result().status_code, 404)
        child.communicate(timeout=3)
        self.assertEqual(child.returncode, 0)

    def test_real_server_keeps_ready_media_until_cleanup(self):
        child, _ = self.start_server('''from types import SimpleNamespace
job = SimpleNamespace(state="ready", cleanup_requested=False)
def cleanup():
    job.cleanup_requested = True
    app.SERVER_IDLE.refresh()
job.cleanup = cleanup
app.INSTAGRAM_JOBS["pending"] = job
def release():
    input()
    app.instagram_action("cleanup", {"id": "pending"})
threading.Thread(target=release, daemon=True).start()
''')
        time.sleep(0.7)
        self.assertIsNone(child.poll())
        child.stdin.write("release\n")
        child.stdin.flush()
        child.communicate(timeout=3)
        self.assertEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
