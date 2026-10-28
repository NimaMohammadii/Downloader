import asyncio
import concurrent.futures
import hashlib
import hmac
import json
import secrets
import os
import re
import signal
import shutil
import subprocess
import tempfile
import threading
import time
import wave
import unicodedata
from array import array
from contextvars import ContextVar
from contextlib import contextmanager
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, urljoin

import requests

USAGE_USER: ContextVar[int] = ContextVar("usage_user", default=0)


class UsageMeter:
    """One event-driven ledger for this container, including child-process CPU.

    Global counters are measured once. Concurrent jobs share each interval in
    proportion to active scopes; user shares are estimates, never billing data.
    Telemetry uses a bounded queue and a single nonblocking reporter, no polling.
    """
    def __init__(self):
        self.url = os.environ.get("ADMIN_USAGE_URL", "")
        self.token = os.environ.get("ADMIN_USAGE_TOKEN", "")
        self.enabled = bool(re.fullmatch(r"https://downloader\.vexaagent\.workers\.dev/container-usage/\d+", self.url)
                            and re.fullmatch(r"[a-f0-9]{64}", self.token))
        self.lock = threading.RLock()
        self.session = secrets.token_hex(16)
        self.sequence = 0
        self.active: dict[int, int] = {}
        self.samples: dict[str, dict] = {}
        self.deliveries: dict[str, dict] = {}
        self.reporting = False
        self.last_clock = time.monotonic()
        self.last_at = time.time() * 1000
        self.last_cpu, self.last_network = self.counters() if self.enabled else (None, None)

    @staticmethod
    def counters():
        cpu, network = None, None
        try:
            values = dict(line.split() for line in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines())
            cpu = int(values["usage_usec"]) / 1_000_000
        except (OSError, ValueError, KeyError):
            try:
                cpu = int(Path("/sys/fs/cgroup/cpuacct/cpuacct.usage").read_text()) / 1_000_000_000
            except (OSError, ValueError):
                pass
        try:
            rx, tx = 0, 0
            for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
                interface, raw = line.split(":", 1)
                if interface.strip() != "lo":
                    values = raw.split()
                    rx += int(values[0])
                    tx += int(values[8])
            network = (rx, tx)
        except (OSError, ValueError, IndexError):
            pass
        return cpu, network

    def sample(self):
        if not self.enabled:
            return
        with self.lock:
            clock = time.monotonic()
            elapsed = max(0, (clock - self.last_clock) * 1000)
            cpu, network = self.counters()
            start, end = self.last_at, self.last_at + elapsed
            cpu_delta = max(0, cpu - self.last_cpu) if cpu is not None and self.last_cpu is not None else None
            rx = max(0, network[0] - self.last_network[0]) if network is not None and self.last_network is not None else None
            tx = max(0, network[1] - self.last_network[1]) if network is not None and self.last_network is not None else None
            self.last_clock, self.last_at, self.last_cpu, self.last_network = clock, end, cpu, network
            if elapsed <= 0:
                return
            self.sequence += 1
            shares = {0: 1.0}
            total = sum(self.active.values())
            shares.update({user: count / total for user, count in self.active.items() if user > 0})
            for user, share in shares.items():
                key = f"u:{self.session}:{self.sequence}:{user}"
                self.samples[key] = {"key": key, "userId": user, "start": start, "end": end,
                    "runtimeMs": elapsed * share,
                    "cpuSeconds": cpu_delta * share if cpu_delta is not None else None,
                    "ingressBytes": rx * share if rx is not None else None,
                    "egressBytes": tx * share if tx is not None else None}
            if len(self.samples) > 10000:
                # Keep memory bounded during prolonged stats-service outages.
                for key in list(self.samples)[:len(self.samples) - 10000]:
                    del self.samples[key]
                print("admin usage queue overflow: some measurements unavailable", flush=True)

    def report(self):
        if not self.enabled:
            return
        with self.lock:
            if self.reporting:
                return
            self.reporting = True
        def send():
            try:
                self.flush()
            finally:
                with self.lock:
                    self.reporting = False
        try:
            threading.Thread(target=send, daemon=True).start()
        except Exception:
            with self.lock:
                self.reporting = False

    def flush(self):
        if not self.enabled:
            return
        try:
            # Batches are idempotent by key, including simultaneous final flush.
            for _ in range(4):
                with self.lock:
                    samples = list(self.samples.values())[:250]
                    deliveries = list(self.deliveries.values())[:250]
                if not samples and not deliveries:
                    return
                response = requests.post(self.url, headers={"x-admin-usage-token": self.token},
                    json={"samples": samples, "deliveries": deliveries}, timeout=(1, 2), allow_redirects=False)
                if not response.ok:
                    return
                with self.lock:
                    for item in samples:
                        self.samples.pop(item["key"], None)
                    for item in deliveries:
                        self.deliveries.pop(item["key"], None)
        except Exception:
            pass  # The next work event or idle exit retries the same keys.

    @contextmanager
    def scope(self, user):
        user = user if type(user) is int and user > 0 else 0
        context = USAGE_USER.set(user)
        try:
            if self.enabled:
                with self.lock:
                    self.sample()
                    self.active[user] = self.active.get(user, 0) + 1
                self.report()
            yield
        finally:
            if self.enabled:
                with self.lock:
                    self.sample()
                    self.active[user] -= 1
                    if not self.active[user]:
                        del self.active[user]
                self.report()
            USAGE_USER.reset(context)

    def delivery(self, token, chat, result, size=None, cached=False):
        if not self.enabled or not USAGE_USER.get() or not isinstance(result, dict):
            return
        message_id = result.get("message_id")
        if type(message_id) is not int:
            return
        if type(size) is not int or size < 0 or size > 2_000_000_000:
            size = None
        key = f"tg:{token.split(':')[0]}:{chat}:{message_id}"
        with self.lock:
            if len(self.deliveries) >= 10000 and key not in self.deliveries:
                print("admin delivery queue overflow: some measurements unavailable", flush=True)
                return
            self.deliveries[key] = {"key": key, "userId": USAGE_USER.get(), "at": int(time.time() * 1000),
                                    "bytes": size, "cached": cached}
        self.report()


USAGE = UsageMeter()


class JobCapacity:
    """Nonblocking admission shared by metadata, downloads and background jobs."""

    def __init__(self, limit: int = 5) -> None:
        self.limit = limit
        self.lock = threading.Lock()
        self.jobs: set[str] = set()

    def acquire(self, key: str) -> bool:
        with self.lock:
            if key in self.jobs or len(self.jobs) >= self.limit:
                return False
            self.jobs.add(key)
            return True

    def release(self, key: str) -> None:
        with self.lock:
            self.jobs.discard(key)


JOB_CAPACITY = JobCapacity()
REQUEST_CACHE: ContextVar[Path | None] = ContextVar("request_cache", default=None)
CATALOG_CACHE: dict[str, tuple[float, str, str]] = {}
CATALOG_LOCK = threading.Lock()


@contextmanager
def request_cache(url: str = ""):
    # Every extraction owns its metadata and selected-client files. Concurrent
    # requests must never load another video's --load-info-json input.
    with tempfile.TemporaryDirectory(prefix="youtube-request-") as directory:
        folder = Path(directory)
        with CATALOG_LOCK:
            now = time.monotonic()
            for key, cached in list(CATALOG_CACHE.items()):
                if cached[0] <= now:
                    del CATALOG_CACHE[key]
            cached = CATALOG_CACHE.get(url) if url else None
        if cached:
            (folder / "info.json").write_text(cached[1], encoding="utf-8")
            (folder / "session.json").write_text(cached[2], encoding="utf-8")
        token = REQUEST_CACHE.set(folder)
        try:
            yield
        finally:
            REQUEST_CACHE.reset(token)
            try:
                info = (folder / "info.json").read_text(encoding="utf-8")
                session = (folder / "session.json").read_text(encoding="utf-8")
                if url and len(info.encode("utf-8")) + len(session.encode("utf-8")) <= 2_000_000:
                    with CATALOG_LOCK:
                        if url not in CATALOG_CACHE and len(CATALOG_CACHE) >= 20:
                            del CATALOG_CACHE[next(iter(CATALOG_CACHE))]
                        # Reuse cannot extend signed source URLs indefinitely.
                        CATALOG_CACHE[url] = (cached[0] if cached else time.monotonic() + 300, info, session)
            except (OSError, UnicodeError):
                pass


def metadata_cache_path() -> Path:
    directory = REQUEST_CACHE.get()
    return directory / "info.json" if directory is not None else METADATA_CACHE_PATH


class IdleExit:
    """One-shot inactivity timer independent of the Container SDK's counters."""

    def __init__(self, seconds: float, busy, exit_process=os._exit) -> None:
        self.seconds, self.busy, self.exit_process = seconds, busy, exit_process
        self.lock = threading.RLock()
        self.active = 0
        self.generation = 0
        self.timer = None

    def begin(self) -> None:
        with self.lock:
            self.active += 1
            self._cancel()

    def end(self) -> None:
        with self.lock:
            self.active -= 1
            if self.active == 0:
                self.refresh()

    def _cancel(self) -> None:
        self.generation += 1
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    def refresh(self) -> None:
        with self.lock:
            self._cancel()
            if self.active:
                return
            self.timer = threading.Timer(self.seconds, self._expire, args=(self.generation,))
            self.timer.daemon = True
            self.timer.start()

    def _expire(self, generation: int) -> None:
        with self.lock:
            if generation != self.generation or self.active or self.busy():
                return
        # Do not hold the admission lock during telemetry I/O. A new request
        # changes the generation and cancels this pending idle exit as before.
        try:
            USAGE.sample()
            USAGE.flush()
        except Exception:
            pass  # Stats failures cannot keep an idle container running.
        with self.lock:
            if generation != self.generation or self.active or self.busy():
                return
            print("youtube downloader idle: exiting to release container capacity", flush=True)
            self.exit_process(0)


SERVER_IDLE: IdleExit | None = None


@contextmanager
def server_activity():
    guard = SERVER_IDLE
    if guard is not None:
        guard.begin()
    try:
        yield
    finally:
        if guard is not None:
            guard.end()

PORT = int(os.environ.get("PORT", "8080"))
DIRECT_TELEGRAM_LIMIT = 2_000_000_000
METADATA_TIMEOUT_SECONDS = 90
DOWNLOAD_TIMEOUT_SECONDS = 1_500
POT_PROVIDER_URL = os.environ.get("POT_PROVIDER_URL", "http://127.0.0.1:4416")
SUPPORTED_QUALITIES = (360, 480, 720, 1080)
SUPPORTED_AUDIO_MODES = ("low", "hq")
REAL_YTDLP = shutil.which("yt-dlp") or "yt-dlp"
METADATA_CACHE_PATH = Path("/tmp/vexa-youtube-info.json")
YOUTUBE_JOB_SECONDS = 25 * 60  # Leave cleanup/error reporting time within the 30-minute Workflow step.
JOB_DEADLINE: ContextVar[float | None] = ContextVar("youtube_job_deadline", default=None)


class UserVisibleError(Exception):
    pass


def upload_error_diagnostic(exc: BaseException, token: str) -> dict[str, Any]:
    if isinstance(exc, BaseExceptionGroup):
        children = [upload_error_diagnostic(child, token) for child in exc.exceptions[:3]]
        return {**(children[0] if children else {"errorCode": type(exc).__name__}),
                "diagnostic": "; ".join(f"{child['errorCode']}: {child['diagnostic']}" for child in children)[:1200]}
    detail = str(getattr(exc, "message", None) or str(exc))
    if isinstance(exc, subprocess.SubprocessError):
        detail = "subprocess failed"  # Commands can contain signed URLs and account headers.
    secrets_to_redact = (token, os.environ.get("API_HASH", ""), os.environ.get("INSTAGRAM_SESSIONID", ""),
                        os.environ.get("TELEGRAM_BOT_SESSION", ""), os.environ.get("TELEGRAM_SESSION_TOKEN", ""))
    for secret in sorted(set(secrets_to_redact), key=len, reverse=True):
        if secret:
            detail = detail.replace(secret, "[redacted]")
    detail = re.sub(r"https?://[^\s\"'<>]+", "[url]", detail)
    detail = re.sub(r"(?i)\b(authorization|cookie|sessionid)\b[\"']?\s*[:=]\s*[^\r\n]+", r"\1=[redacted]", detail)
    detail = re.sub(r"[\x00-\x1f\x7f]", " ", detail)
    code = detail if re.fullmatch(r"[A-Z][A-Z0-9_]{1,95}", detail) else type(exc).__name__
    diagnostic: dict[str, Any] = {"errorCode": code, "diagnostic": detail[:1200], "errorType": type(exc).__name__}
    # Never serialize the request itself: auth requests contain the bot token.
    request = getattr(exc, "request", None)
    # receive_updates=False wraps every RPC, not just connection setup. Expose
    # the actual method, never the request arguments or authorization string.
    for _ in range(8):
        if type(request).__name__ not in {"InvokeWithoutUpdatesRequest", "InvokeWithLayerRequest", "InitConnectionRequest"}:
            break
        nested = getattr(request, "query", None)
        if nested is None:
            break
        request = nested
    if request is not None:
        diagnostic["rpcMethod"] = type(request).__name__
    if getattr(exc, "code", None) == 420:
        diagnostic["rpcCode"] = 420
        seconds = getattr(exc, "seconds", None)
        if type(seconds) is int and seconds >= 0:
            diagnostic["retryAfterSeconds"] = seconds
            diagnostic["errorCode"] = "SLOWMODE_WAIT" if type(exc).__name__ == "SlowModeWaitError" else "FLOOD_WAIT"
            diagnostic["diagnostic"] = f"{type(exc).__name__}: wait {seconds} seconds"
    return diagnostic


def telegram_flood_message(diagnostic: dict[str, Any]) -> str | None:
    if diagnostic.get("rpcCode") != 420:
        return None
    subject = "این گفت‌وگو" if diagnostic.get("errorCode") == "SLOWMODE_WAIT" else "تلگرام"
    seconds = diagnostic.get("retryAfterSeconds")
    if type(seconds) is int:
        return f"❌ {subject} ارسال فایل را موقتاً محدود کرده؛ {max(1, seconds)} ثانیه بعد دوباره امتحان کن."
    return f"❌ {subject} ارسال فایل را موقتاً محدود کرده؛ زمان رفع محدودیت را اعلام نکرده است."


def job_timeout(seconds: float) -> float:
    deadline = JOB_DEADLINE.get()
    if deadline is None:
        return seconds
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise UserVisibleError("❌ زمان دریافت و ارسال این فایل تمام شد؛ کیفیت پایین‌تر یا فایل کوتاه‌تری را انتخاب کن.")
    return min(seconds, remaining)


ADMIN_USER_ID = 7138547731
PUBLIC_ERROR_CATALOG = json.loads(Path(__file__).with_name("public_errors.json").read_text())
PUBLIC_ERROR_MESSAGE = PUBLIC_ERROR_CATALOG[-1]["message"]
PUBLIC_ERROR_MESSAGES = {row["message"] for row in PUBLIC_ERROR_CATALOG}


def public_error(text: str, detail: str = "") -> dict[str, Any]:
    known = next((row for row in PUBLIC_ERROR_CATALOG if row["message"] == text), None)
    if known:
        return known
    value = re.sub(r"https?://\S+", "[URL]", detail + "\n" + text, flags=re.I)
    value = re.sub(r"(?:token|secret|cookie|sessionid|authorization|api_hash)\s*[:=]\s*\S+", "[REDACTED]", value, flags=re.I)
    return next((row for row in PUBLIC_ERROR_CATALOG if any(re.search(pattern, value, re.I) for pattern in row["patterns"])), PUBLIC_ERROR_CATALOG[-1])


ERROR_NOTICE_PATTERN = re.compile(r"(?:^|\n)\s*(?:❌|⚠)|ناموفق|ممکن نیست|نامعتبر|دکمه برای|تأیید نشد|ارسال نشد|کامل نشد|معتبر نیست|منقضی|برای شما نیست|درخواست‌کننده|محدود کرده|موقتاً.*(?:متوقف|محدود)|قابل دسترسی.*ندارد|قبلاً.*(?:شروع|تمام)|آمادهٔ ارسال نیست|صف متوقف شد")


def private_error_payload(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = dict(payload)
    result.pop("_publicErrorFrame", None)
    text = payload.get("text")
    if (payload.get("_publicErrorFrame") is True and method in {"sendMessageDraft", "editMessageText"}
            and isinstance(text, str) and any(row["message"].startswith(text) for row in PUBLIC_ERROR_CATALOG)):
        return result
    if (method in {"sendMessage", "sendMessageDraft", "editMessageText", "answerCallbackQuery"}
            and isinstance(text, str)
            and (text in PUBLIC_ERROR_MESSAGES or
                 (str(payload.get("chat_id")) != str(ADMIN_USER_ID) and ERROR_NOTICE_PATTERN.search(text)))):
        notice = public_error(text)
        result["text"] = notice["message"]
        for key in ("entities", "parse_mode", "reply_markup", "link_preview_options"):
            result.pop(key, None)
        if method != "answerCallbackQuery":
            result["entities"] = [{"type": "custom_emoji", "offset": 0, "length": 2,
                                   "custom_emoji_id": "5447644880824181073"}]
            for phrase in notice["bold"]:
                offset = notice["message"].index(phrase)
                result["entities"].append({"type": "bold", "offset": len(notice["message"][:offset].encode("utf-16-le")) // 2,
                                           "length": len(phrase.encode("utf-16-le")) // 2})
    return result


TEXT_MOTION_CHATS: dict[tuple[str, int], float] = {}
TEXT_MOTION_LOCK = threading.Lock()

TELEGRAM_EMOJI_IDS = {
    "❌": "5210952531676504517", "✅": "5352871660024246779", "⚠": "5447644880824181073",
    "🔎": "5231012545799666522", "⬇": "5271604874419647061", "📤": "5445355530111437729",
    "⏳": "5386367538735104399", "🎵": "5463107823946717464", "🎧": "5424818078833715060",
    "🎼": "5253997827788385948", "🎬": "5427168083074628963", "⭐": "5438496463044752972",
    "🔴": "5264919878082509254", "⏹": "5260293700088511294", "👤": "5397866377367268054",
    "⚡": "5210956306952758910", "👇": "5231102735817918643",
}
TELEGRAM_EMOJI_PATTERN = re.compile("(?:" + "|".join(map(re.escape, TELEGRAM_EMOJI_IDS)) + ")\\ufe0f?")


def telegram_custom_emoji(method: str, payload: dict[str, Any], *, form: bool = False) -> dict[str, Any]:
    payload = private_error_payload(method, payload)
    if method not in {"sendMessage", "sendMessageDraft", "editMessageText", "editMessageCaption", "editMessageReplyMarkup",
                      "sendVideo", "sendAudio", "sendDocument", "sendPhoto", "sendAnimation", "sendMediaGroup"}:
        return payload

    def decorate(body: dict[str, Any]) -> dict[str, Any]:
        result = dict(body)
        for field, entity_field in (("text", "entities"), ("caption", "caption_entities")):
            text = body.get(field)
            if not isinstance(text, str) or body.get("parse_mode"):
                continue
            original = body.get(entity_field, [])
            entities = list(json.loads(original) if isinstance(original, str) else original)
            for match in TELEGRAM_EMOJI_PATTERN.finditer(text):
                offset = len(text[:match.start()].encode("utf-16-le")) // 2
                length = len(match[0].encode("utf-16-le")) // 2
                if any(e.get("type") in {"code", "pre", "url", "custom_emoji"} and
                       e["offset"] < offset + length and e["offset"] + e["length"] > offset for e in entities):
                    continue
                entities.append({"type": "custom_emoji", "offset": offset, "length": length,
                                 "custom_emoji_id": TELEGRAM_EMOJI_IDS[match[0].replace("\ufe0f", "")]})
            if entities:
                entities.sort(key=lambda e: e["offset"])
                result[entity_field] = json.dumps(entities) if form or isinstance(original, str) else entities
        return result

    result = decorate(payload)
    if isinstance(payload.get("media"), list):
        result["media"] = [decorate(item) for item in payload["media"]]
    markup = payload.get("reply_markup")
    if isinstance(markup, str):
        markup = json.loads(markup)
    if isinstance(markup, dict):
        converted = dict(markup)
        for field in ("inline_keyboard", "keyboard"):
            if not isinstance(markup.get(field), list):
                continue
            rows = []
            for row in markup[field]:
                buttons = []
                for button in row:
                    text = button.get("text") if isinstance(button, dict) else None
                    match = TELEGRAM_EMOJI_PATTERN.match(text) if isinstance(text, str) else None
                    if match and not button.get("icon_custom_emoji_id") and text[match.end():].lstrip():
                        button = {**button, "text": text[match.end():].lstrip(),
                                  "icon_custom_emoji_id": TELEGRAM_EMOJI_IDS[match[0].replace("\ufe0f", "")]}
                    buttons.append(button)
                rows.append(buttons)
            converted[field] = rows
        result["reply_markup"] = json.dumps(converted, ensure_ascii=False) if form or isinstance(payload.get("reply_markup"), str) else converted
    return result


def telegram_text_motion(token: str, method: str, payload: dict[str, Any]) -> None:
    payload = private_error_payload(method, payload)
    text = payload.get("text")
    editing = method == "editMessageText" and text in PUBLIC_ERROR_MESSAGES and bool(payload.get("message_id"))
    if (method != "sendMessage" and not editing) or not isinstance(text, str) or len(text) < 2 or payload.get("parse_mode"):
        return
    if payload.get("inline_message_id") or payload.get("business_connection_id"):
        return
    try:
        chat = int(payload["chat_id"])
        if chat <= 0:
            return
        key, now = (token.split(":")[0] + (":edit" if editing else ""), chat), time.monotonic()
        with TEXT_MOTION_LOCK:
            if now < TEXT_MOTION_CHATS.get(key, -10):
                return
            if len(TEXT_MOTION_CHATS) >= 512:
                TEXT_MOTION_CHATS.pop(next(iter(TEXT_MOTION_CHATS)))
            TEXT_MOTION_CHATS[key] = now + (1.5 if editing else 10)
        # Keep Persian combining marks, joiners and animated emoji together.
        chars: list[str] = []
        for char in text:
            if chars and (unicodedata.combining(char) or char in "\ufe0f\ufe0e\u200d\u200c" or
                          chars[-1].endswith(("\u200d", "\u200c")) or 0x1F3FB <= ord(char) <= 0x1F3FF or
                          (0x1F1E6 <= ord(char) <= 0x1F1FF and len(chars[-1]) == 1 and 0x1F1E6 <= ord(chars[-1]) <= 0x1F1FF)):
                chars[-1] += char
            else:
                chars.append(char)
        if len(chars) < 2:
            return
        draft_id, deadline = secrets.randbelow(2147483646) + 1, now + 4.5
        # Seed once, then let Telegram animate the full append without restarts.
        for frame in range(3 if editing else 2):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            end = max(1, len(chars) * (frame + 1) // 4) if editing else 1 if frame == 0 else len(chars)
            prefix = "".join(chars[:end])
            if not prefix.strip():
                continue
            body = {"chat_id": chat, "text": prefix, "_publicErrorFrame": text in PUBLIC_ERROR_MESSAGES}
            if editing:
                body["message_id"] = payload["message_id"]
            else:
                body["draft_id"] = draft_id
            if "message_thread_id" in payload:
                body["message_thread_id"] = payload["message_thread_id"]
            length = len(prefix.encode("utf-16-le")) // 2
            original = payload.get("entities", [])
            entities = json.loads(original) if isinstance(original, str) else original
            body["entities"] = [{**e, "length": min(e["length"], length - e["offset"])} for e in entities
                                if e["offset"] < length and (e.get("type") != "custom_emoji" or e["offset"] + e["length"] <= length)]
            request_timeout = min(0.4, remaining / 2, job_timeout(0.4))
            action = "editMessageText" if editing else "sendMessageDraft"
            response = requests.post(f"https://api.telegram.org/bot{token}/{action}",
                                     json=telegram_custom_emoji(action, body), timeout=(request_timeout, request_timeout))
            result = response.json()
            if response.status_code == 429:
                retry = max(3, min(3600, float(result.get("parameters", {}).get("retry_after") or 30)))
                with TEXT_MOTION_LOCK:
                    TEXT_MOTION_CHATS[key] = time.monotonic() + retry
            if not response.ok or not result.get("ok"):
                break
            # Give the client time after acknowledgement before final persistence.
            pause = 0.45 if editing else 0.12 if frame == 0 else min(1.0, max(0.5, len(chars) * 0.012))
            time.sleep(max(0, min(pause, deadline - time.monotonic(), job_timeout(pause))))
    except Exception:
        pass  # Optional effect must never prevent the complete message.


def telegram_reply_payload(payload: dict[str, Any], *, form: bool = False) -> dict[str, Any]:
    reply = payload.get("reply_parameters")
    if isinstance(reply, str):
        reply = json.loads(reply)
    if not isinstance(reply, dict) or not reply.get("message_id") or reply.get("chat_id"):
        return payload
    reply = {"allow_sending_without_reply": True, **reply}
    return {**payload, "reply_parameters": json.dumps(reply) if form else reply}


def telegram_call(
    token: str,
    method: str,
    *,
    json_payload: dict[str, Any] | None = None,
    data: dict[str, Any] | None = None,
    files: dict[str, Any] | None = None,
    timeout: int = 900,
) -> Any:
    if json_payload is not None:
        json_payload = private_error_payload(method, telegram_reply_payload(json_payload))
    if data is not None:
        data = private_error_payload(method, telegram_reply_payload(data, form=True))
    if files:
        upload_timeout = job_timeout(timeout)
        return asyncio.run(asyncio.wait_for(
            upload_complete_file(token, method, data or {}, next(iter(files.values()))), timeout=upload_timeout))
    telegram_text_motion(token, method, json_payload or data or {})
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        json=telegram_custom_emoji(method, json_payload) if json_payload is not None else None,
        data=telegram_custom_emoji(method, data, form=True) if data is not None else None,
        files=files,
        timeout=(min(20, job_timeout(timeout)), job_timeout(timeout)),
    )
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError(f"Telegram {method} returned invalid JSON") from exc
    if not response.ok or not payload.get("ok"):
        raise RuntimeError(payload.get("description") or f"Telegram {method} failed")
    return payload.get("result")


def edit_status(token: str, chat_id: int, message_id: int | None, text: str) -> None:
    if not message_id:
        return
    telegram_call(
        token,
        "editMessageText",
        json_payload={"chat_id": chat_id, "message_id": message_id, "text": text},
        timeout=60,
    )


def delete_status(token: str, chat_id: int, message_id: int | None) -> None:
    if not message_id:
        return
    try:
        telegram_call(
            token,
            "deleteMessage",
            json_payload={"chat_id": chat_id, "message_id": message_id},
            timeout=60,
        )
    except Exception:
        pass


def friendly_ytdlp_error(stderr: str) -> str:
    # One classifier for the HTTP server and the active YouTube pipeline.
    from youtube_pipeline import _classify_ytdlp_error
    return _classify_ytdlp_error(stderr)[1]


def run_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise UserVisibleError("❌ ارتباط با YouTube بیشتر از حد معمول طول کشید. دوباره امتحان کن.") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        raise UserVisibleError(friendly_ytdlp_error(stderr)) from exc


def run_cached_command(command: list[str], timeout: int) -> subprocess.CompletedProcess[str] | None:
    """Try cached direct media URLs once; never turn a stale cache into a user error."""
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        print("cached yt-dlp attempt timed out; falling back to fresh extraction", flush=True)
        return None
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        print(f"cached yt-dlp attempt failed; refreshing extraction: {detail[-1200:]}", flush=True)
        return None


def ytdlp_common_args() -> list[str]:
    return [
        "--no-playlist",
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=default,mweb",
        "--extractor-args",
        f"youtubepot-bgutilhttp:base_url={POT_PROVIDER_URL}",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--extractor-retries",
        "1",
        "--socket-timeout",
        "15",
    ]


def fetch_metadata(url: str) -> dict[str, Any]:
    result = run_command(
        [
            "yt-dlp",
            *ytdlp_common_args(),
            "--skip-download",
            "--dump-single-json",
            "--no-warnings",
            url,
        ],
        timeout=METADATA_TIMEOUT_SECONDS,
    )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise UserVisibleError("❌ اطلاعات ویدیو از YouTube دریافت نشد.") from exc


def save_metadata_cache(metadata: dict[str, Any]) -> None:
    try:
        path = metadata_cache_path()
        temp_path = path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        temp_path.replace(path)
    except Exception as exc:
        print(f"metadata cache write failed: {type(exc).__name__}: {exc}", flush=True)


def youtube_video_id(url: str) -> str | None:
    try:
        parsed = urlparse(url)
        host = parsed.hostname.lower().replace("www.", "") if parsed.hostname else ""
        if host == "youtu.be":
            value = parsed.path.strip("/").split("/")[0]
            return value or None
        if host.endswith("youtube.com") or host.endswith("youtube-nocookie.com"):
            if parsed.path == "/watch":
                return (parse_qs(parsed.query).get("v") or [None])[0]
            pieces = [part for part in parsed.path.split("/") if part]
            if len(pieces) >= 2 and pieces[0] in {"shorts", "embed", "live"}:
                return pieces[1]
    except Exception:
        return None
    return None


def load_metadata_cache(url: str) -> dict[str, Any] | None:
    path = metadata_cache_path()
    if not path.exists():
        return None
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            return None
        expected = youtube_video_id(url)
        cached = str(metadata.get("id") or "")
        if expected and cached and expected != cached:
            return None
        return metadata
    except Exception as exc:
        print(f"metadata cache read failed: {type(exc).__name__}: {exc}", flush=True)
        return None


def validate_video_metadata(metadata: dict[str, Any]) -> None:
    if metadata.get("_type") == "playlist" or metadata.get("entries"):
        raise UserVisibleError("❌ لینک مستقیم یک ویدیو یا Shorts رو بفرست، نه Playlist یا کانال.")

    live_status = str(metadata.get("live_status") or "").lower()
    if metadata.get("is_live") or live_status in {"is_live", "is_upcoming"}:
        raise UserVisibleError("❌ دانلود Live در حال پخش فعلاً پشتیبانی نمی‌شه.")


def video_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []
    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        if str(item.get("vcodec") or "none").lower() == "none":
            continue
        result.append(item)
    return result


def audio_formats(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    formats = metadata.get("formats")
    if not isinstance(formats, list):
        return []
    result: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        if str(item.get("vcodec") or "none").lower() != "none":
            continue
        if str(item.get("acodec") or "none").lower() == "none":
            continue
        result.append(item)
    return result


def short_side(format_info: dict[str, Any]) -> int | None:
    width_raw = format_info.get("width")
    height_raw = format_info.get("height")
    try:
        width = int(width_raw) if width_raw else 0
        height = int(height_raw) if height_raw else 0
    except (TypeError, ValueError):
        return None
    if width > 0 and height > 0:
        return min(width, height)
    return height or width or None


def available_qualities(metadata: dict[str, Any]) -> list[int]:
    found: set[int] = set()
    for format_info in video_formats(metadata):
        resolution = short_side(format_info)
        if not resolution:
            continue
        for quality in SUPPORTED_QUALITIES:
            if abs(resolution - quality) <= 16:
                found.add(quality)
    return [quality for quality in SUPPORTED_QUALITIES if quality in found]


def is_portrait(metadata: dict[str, Any]) -> bool:
    best: tuple[int, int, int] | None = None
    for format_info in video_formats(metadata):
        try:
            width = int(format_info.get("width") or 0)
            height = int(format_info.get("height") or 0)
        except (TypeError, ValueError):
            continue
        if width <= 0 or height <= 0:
            continue
        area = width * height
        if best is None or area > best[0]:
            best = (area, width, height)
    if best is None:
        return False
    return best[1] < best[2]


def inspect_video(url: str) -> dict[str, Any]:
    try:
        metadata = fetch_metadata(url)
        validate_video_metadata(metadata)
        qualities = available_qualities(metadata)
        has_audio = len(audio_formats(metadata)) > 0
        if not qualities and not has_audio:
            raise UserVisibleError("❌ کیفیت قابل دانلود برای این ویدیو پیدا نشد.")
        video_id = str(metadata.get("id") or "").strip()
        if not video_id:
            raise UserVisibleError("❌ شناسه ویدیوی YouTube دریافت نشد.")
        save_metadata_cache(metadata)
        return {
            "ok": True,
            "videoId": video_id,
            "title": str(metadata.get("title") or "YouTube video").strip(),
            "qualities": qualities,
            "audioAvailable": has_audio,
        }
    except UserVisibleError as exc:
        return {"ok": False, "message": str(exc)}


def result_path(result: subprocess.CompletedProcess[str], workdir: Path, *, prefix: str | None = None) -> Path | None:
    printed = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if printed:
        candidate = Path(printed[-1])
        if candidate.exists() and candidate.is_file():
            return candidate

    candidates = []
    for path in workdir.iterdir():
        if not path.is_file() or path.suffix.lower() in {".part", ".ytdl", ".json"}:
            continue
        if path.name.startswith("part_"):
            continue
        if prefix and not path.name.startswith(prefix):
            continue
        candidates.append(path)
    return max(candidates, key=lambda path: path.stat().st_size) if candidates else None


def download_video(url: str, workdir: Path, quality: int, metadata: dict[str, Any]) -> Path:
    output_template = str(workdir / "%(title).100B [%(id)s].%(ext)s")
    dimension = "width" if is_portrait(metadata) else "height"
    format_selector = (
        f"bv*[{dimension}<={quality}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
        f"bv*[{dimension}<={quality}][ext=mp4]+ba[ext=m4a]/"
        f"bv*[{dimension}<={quality}]+ba/"
        f"b[{dimension}<={quality}][ext=mp4]/b[{dimension}<={quality}]/b"
    )

    if metadata_cache_path().exists():
        cached = run_cached_command(
            [
                REAL_YTDLP,
                "--load-info-json",
                str(metadata_cache_path()),
                "--no-simulate",
                "--retries",
                "1",
                "--fragment-retries",
                "1",
                "--socket-timeout",
                "12",
                "--concurrent-fragments",
                "2",
                "--format",
                format_selector,
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
                "--output",
                output_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )
        if cached is not None:
            path = result_path(cached, workdir)
            if path is not None:
                return path

    result = run_command(
        [
            "yt-dlp",
            *ytdlp_common_args(),
            "--no-simulate",
            "--concurrent-fragments",
            "2",
            "--format",
            format_selector,
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
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    )
    path = result_path(result, workdir)
    if path is None:
        raise UserVisibleError("❌ فایل ویدیو بعد از دانلود پیدا نشد.")
    return path


def download_audio(url: str, workdir: Path, audio_mode: str) -> Path:
    if audio_mode == "low":
        format_selector = "ba[abr<=80][ext=m4a]/ba[abr<=80]/worstaudio[ext=m4a]/worstaudio"
        fallback_bitrate = "64k"
    else:
        format_selector = "ba[ext=m4a]/ba"
        fallback_bitrate = "128k"

    source_template = str(workdir / "audio-source.%(ext)s")
    result: subprocess.CompletedProcess[str] | None = None

    if metadata_cache_path().exists():
        result = run_cached_command(
            [
                REAL_YTDLP,
                "--load-info-json",
                str(metadata_cache_path()),
                "--no-simulate",
                "--retries",
                "1",
                "--fragment-retries",
                "1",
                "--socket-timeout",
                "12",
                "--format",
                format_selector,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )

    source = result_path(result, workdir, prefix="audio-source.") if result is not None else None
    if source is None:
        result = run_command(
            [
                "yt-dlp",
                *ytdlp_common_args(),
                "--no-simulate",
                "--format",
                format_selector,
                "--output",
                source_template,
                "--quiet",
                "--print",
                "after_move:%(filepath)s",
                url,
            ],
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        )
        source = result_path(result, workdir, prefix="audio-source.")

    if source is None:
        raise UserVisibleError("❌ فایل صوتی بعد از دانلود پیدا نشد.")

    target = workdir / "Vexa.m4a"
    if source.suffix.lower() == ".m4a":
        source.replace(target)
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
            check=True,
            text=True,
            capture_output=True,
            timeout=1_200,
        )
    except subprocess.TimeoutExpired as exc:
        raise UserVisibleError("❌ تبدیل فایل صوتی بیشتر از حد معمول طول کشید.") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip()
        print(f"audio conversion failed: {detail}", flush=True)
        raise UserVisibleError("❌ تبدیل فایل صوتی به M4A انجام نشد.") from exc

    if not target.exists() or target.stat().st_size <= 0:
        raise UserVisibleError("❌ فایل صوتی نهایی ساخته نشد.")
    return target


def probe_duration(path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            text=True,
            capture_output=True,
            check=True,
            timeout=job_timeout(60),
        )
        return max(0.0, float(result.stdout.strip()))
    except Exception:
        return 0.0


def validate_file_size(path: Path) -> None:
    if path.stat().st_size > DIRECT_TELEGRAM_LIMIT:
        raise UserVisibleError("❌ حجم فایل از سقف ۲ گیگابایت بیشتره؛ کیفیت پایین‌تر رو انتخاب کن.")


class TelegramUploader:
    """One event loop and authorized bot connection per Container process."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.loop = None
        self.thread = None
        self.client = None
        self.session = None
        self.credentials = None
        self.start_lock = None
        self.startup_not_before = 0.0
        self.startup_flood = None
        self.persisted_session = os.environ.get("TELEGRAM_BOT_SESSION", "")

    def event_loop(self):
        with self.lock:
            if self.loop is None:
                self.loop = asyncio.new_event_loop()
                self.thread = threading.Thread(target=self.loop.run_forever, daemon=True, name="telegram-upload")
                self.thread.start()
            return self.loop

    async def get_client(self, token: str):
        from telethon import TelegramClient
        from telethon.errors import FloodWaitError, FloodPremiumWaitError, SlowModeWaitError
        from telethon.sessions import StringSession

        api_id, api_hash = os.environ.get("API_ID", ""), os.environ.get("API_HASH", "")
        if not api_id.isdecimal() or not api_hash:
            raise UserVisibleError("❌ تنظیمات API_ID و API_HASH برای ارسال فایل آماده نیست.")
        if self.start_lock is None:
            self.start_lock = asyncio.Lock()
        async with self.start_lock:
            credentials = (token, api_id, api_hash)
            if self.credentials is not None and self.credentials != credentials:
                raise RuntimeError("Telegram uploader credentials changed; restart the Container")
            self.credentials = credentials
            if self.client is not None and self.client.is_connected():
                await self.persist_session()
                return self.client
            if self.session is None:
                self.session = StringSession(os.environ.get("TELEGRAM_BOT_SESSION", ""))
            client = self.client or TelegramClient(self.session, int(api_id), api_hash,
                receive_updates=False, flood_sleep_threshold=60, raise_last_call_error=True)
            try:
                while True:
                    delay = self.startup_not_before - time.monotonic()
                    if delay > 60 and self.startup_flood is not None:
                        raise type(self.startup_flood)(self.startup_flood.request, capture=int(delay) + 1)
                    if delay > 0:
                        await asyncio.sleep(delay)
                    try:
                        await client.start(bot_token=token)
                        break
                    except (FloodWaitError, FloodPremiumWaitError, SlowModeWaitError) as exc:
                        # connect() sends its initialization RPC directly, outside
                        # Telethon's normal flood handling. No file can be sent yet.
                        await client.disconnect()
                        delay = max(1, exc.seconds)
                        self.startup_not_before = time.monotonic() + delay
                        self.startup_flood = exc
                        if delay > 60 or job_timeout(YOUTUBE_JOB_SECONDS) <= delay:
                            raise
                await self.persist_session()
                self.client = client
                return client
            except BaseException:
                await client.disconnect()
                raise

    async def persist_session(self) -> None:
        session = self.session.save()
        if not session or session == self.persisted_session or not os.environ.get("TELEGRAM_SESSION_URL"):
            return
        try:
            await asyncio.to_thread(self.save_session, session)
            self.persisted_session = session
        except Exception:
            # Keep the healthy connection; retry persistence on the next real
            # upload, without a timer or logging authorization material.
            print("telegram session persistence deferred", flush=True)

    @staticmethod
    def save_session(session: str) -> None:
        url = os.environ["TELEGRAM_SESSION_URL"]
        if not re.fullmatch(r"https://downloader\.vexaagent\.workers\.dev/telegram-session/\d{1,2}", url):
            raise RuntimeError("Invalid Telegram session store")
        try:
            response = requests.post(url,
                headers={"x-telegram-session-token": os.environ["TELEGRAM_SESSION_TOKEN"]},
                json={"session": session}, timeout=(5, 10), allow_redirects=False)
            if response.status_code != 200:
                raise RuntimeError("Telegram session storage unavailable")
        except requests.RequestException:
            raise RuntimeError("Telegram session storage unavailable") from None

    async def upload(self, token: str, method: str, data: dict[str, Any], file: tuple):
        done = threading.Event()
        loop = self.event_loop()
        future = concurrent.futures.Future()

        def begin():
            task = loop.create_task(_upload_complete_file(self, token, method, data, file))

            def finished(task):
                try:
                    if task.cancelled():
                        future.cancel()
                    elif task.exception() is not None:
                        future.set_exception(task.exception())
                    else:
                        future.set_result(task.result())
                except concurrent.futures.InvalidStateError:
                    pass  # The caller cancelled while the task was completing.
                finally:
                    done.set()

            task.add_done_callback(finished)
            future.add_done_callback(lambda result: loop.call_soon_threadsafe(task.cancel) if result.cancelled() else None)

        loop.call_soon_threadsafe(begin)
        try:
            return await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            future.cancel()
            # Wait for the task's done callback even if cancellation happened
            # before its first instruction, then permit source-file cleanup.
            await asyncio.to_thread(done.wait)
            raise


TELEGRAM_UPLOADER = TelegramUploader()


async def upload_complete_file(token: str, method: str, data: dict[str, Any], file: tuple) -> Any:
    # Observe only confirmed delivery; retries and failed uploads retain their
    # existing behavior and never become successful-download statistics.
    try:
        size = Path(file[1].name).stat().st_size
    except (OSError, AttributeError, TypeError):
        size = None
    result = await TELEGRAM_UPLOADER.upload(token, method, data, file)
    try:
        USAGE.delivery(token, data.get("chat_id"), result, size)
    except Exception:
        pass  # A confirmed send must remain successful if metering is unavailable.
    return result


async def _upload_complete_file(uploader: TelegramUploader, token: str, method: str, data: dict[str, Any], file: tuple) -> Any:
    from telethon import Button, functions, types, utils
    from telethon.errors import RPCError

    filename, handle, mime = file
    path = Path(handle.name)
    validate_file_size(path)
    client = await uploader.get_client(token)
    # Keep the existing complete-file sender and its per-file state. Only the
    # connection is shared; destinations, parts and checksums remain isolated.
    size = path.stat().st_size
    part_size = 512 * 1024
    count = (size + part_size - 1) // part_size
    file_id = secrets.randbits(63)
    digest = hashlib.md5()
    big = size > 10 * 1024 * 1024

    async def save_part(index: int, chunk: bytes) -> None:
        job_timeout(YOUTUBE_JOB_SECONDS)
        # Short waits stay inside Telethon's RPC retry mechanism. Long waits
        # are returned to the Workflow for durable sleep with no active host.
        request = (functions.upload.SaveBigFilePartRequest(file_id, index, count, chunk)
                   if big else functions.upload.SaveFilePartRequest(file_id, index, chunk))
        if not await client(request):
            raise RuntimeError("Telegram rejected an upload part")

    # Keep eight parts in flight without a batch barrier: a slow part must
    # not leave completed slots idle. Read/hash in file order before await,
    # and finish every worker before publishing the complete media file.
    with path.open("rb") as source:
        indices = iter(range(count))

        async def upload_worker() -> None:
            for index in indices:
                chunk = source.read(part_size)
                if not big:
                    digest.update(chunk)
                await save_part(index, chunk)

        async with asyncio.TaskGroup() as group:
            for _ in range(min(8, count)):
                group.create_task(upload_worker())
    uploaded = (types.InputFileBig(file_id, count, filename) if big
                else types.InputFile(file_id, count, filename, digest.hexdigest()))
    attributes = [types.DocumentAttributeFilename(filename)]
    if method == "sendVideo":
        attributes.append(types.DocumentAttributeVideo(
            duration=float(data.get("duration", 0)),
            w=int(data.get("width", 0)), h=int(data.get("height", 0)),
            supports_streaming=True,
        ))
    elif method == "sendAudio":
        attributes.append(types.DocumentAttributeAudio(
            duration=int(probe_duration(path)), title=str(data.get("title") or path.stem),
            performer=str(data.get("performer") or "") or None,
        ))
    elif method == "sendAnimation":
        attributes.append(types.DocumentAttributeAnimated())
    reply = json.loads(data.get("reply_parameters", "{}"))
    decorated = telegram_custom_emoji(method, data)
    markup = decorated.get("reply_markup")
    if isinstance(markup, str):
        markup = json.loads(markup)
    buttons = [[Button.inline(button["text"], data=button["callback_data"].encode(),
                              icon=int(button["icon_custom_emoji_id"]) if button.get("icon_custom_emoji_id") else None) for button in row]
               for row in markup["inline_keyboard"]] if markup else None
    caption_entities = decorated.get("caption_entities", [])
    if isinstance(caption_entities, str):
        caption_entities = json.loads(caption_entities)
    formatting_entities = [types.MessageEntityCustomEmoji(e["offset"], e["length"], int(e["custom_emoji_id"]))
                           for e in caption_entities if e.get("type") == "custom_emoji"]
    options = dict(caption=data.get("caption", ""), parse_mode=None,
                   formatting_entities=formatting_entities or None,
                   mime_type=mime, attributes=attributes,
                   supports_streaming=method == "sendVideo",
                   force_document=method == "sendDocument",
                   reply_to=reply.get("message_id"), buttons=buttons)
    try:
        job_timeout(YOUTUBE_JOB_SECONDS)
        message = await client.send_file(int(data["chat_id"]), uploaded, **options)
    except RPCError as exc:
        # A definitive reply rejection has not published a message. Reuse the uploaded file once.
        if (not options["reply_to"] or not reply.get("allow_sending_without_reply", True) or reply.get("chat_id") or
                exc.code != 400 or exc.message != "REPLY_MESSAGE_ID_INVALID"):
            raise
        options["reply_to"] = None
        message = await client.send_file(int(data["chat_id"]), uploaded, **options)
    return {"message_id": message.id, "file_id": utils.pack_bot_file_id(getattr(message, "document", None))}


def send_media_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
    *,
    reply: bool,
) -> Any:
    data: dict[str, Any] = {"chat_id": str(chat_id), "caption": caption[:1024]}
    if reply:
        data["reply_parameters"] = json.dumps({"message_id": request_message_id})
    with path.open("rb") as handle:
        return telegram_call(
            token, "sendVideo", data=data,
            files={"video": (path.name, handle, "video/mp4")}, timeout=1800,
        )


def send_audio_file(
    token: str,
    chat_id: int,
    request_message_id: int,
    path: Path,
    caption: str,
) -> Any:
    if path.stat().st_size > DIRECT_TELEGRAM_LIMIT:
        raise UserVisibleError("❌ فایل صوتی برای ارسال مستقیم در تلگرام بیش از حد بزرگه.")

    data: dict[str, Any] = {
        "chat_id": str(chat_id),
        "caption": caption[:1024],
        "title": "Vexa",
        "reply_parameters": json.dumps({"message_id": request_message_id}),
    }

    with path.open("rb") as handle:
        return telegram_call(
            token, "sendAudio", data=data,
            files={"audio": (path.name, handle, "audio/mp4")}, timeout=1800,
        )


def process_job(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("source") == "pornhub":
        from pornhub import process_job as process_pornhub_job
        return process_pornhub_job(payload)
    token = str(payload.get("botToken") or "")
    url = str(payload.get("url") or "")
    chat_id = int(payload.get("chatId"))
    request_message_id = int(payload.get("requestMessageId"))
    quality_raw = payload.get("quality")
    quality = int(quality_raw) if quality_raw is not None else None
    audio_mode = str(payload.get("audioMode") or "").lower() or None
    status_raw = payload.get("statusMessageId")
    status_message_id = int(status_raw) if status_raw else None

    if not token or not url:
        raise ValueError("Missing bot token or URL")
    if quality is not None and quality not in SUPPORTED_QUALITIES:
        raise ValueError("Unsupported YouTube quality")
    if audio_mode is not None and audio_mode not in SUPPORTED_AUDIO_MODES:
        raise ValueError("Unsupported YouTube audio mode")
    if (quality is None) == (audio_mode is None):
        raise ValueError("Choose exactly one YouTube download mode")

    workdir = Path(tempfile.mkdtemp(prefix="youtube-download-"))
    deadline_token = JOB_DEADLINE.set(time.monotonic() + YOUTUBE_JOB_SECONDS)
    phase = "cache"
    def status(text: str) -> None:
        try:
            edit_status(token, chat_id, status_message_id, text)
        except Exception as exc:
            print(json.dumps({"message": "youtube status update failed", "jobId": payload.get("id"),
                              "phase": phase, **upload_error_diagnostic(exc, token)}, ensure_ascii=False), flush=True)
    try:
        if reuse_cached_file(payload, payload.get("mediaCacheKey")):
            delete_status(token, chat_id, status_message_id)
            return {"ok": True, "parts": 1, "cached": True}
        phase = "metadata"
        metadata = load_metadata_cache(url)
        if metadata is None:
            status("🔎 دارم اطلاعات ویدیو رو تازه می‌کنم…")
            metadata = fetch_metadata(url)
            save_metadata_cache(metadata)
        validate_video_metadata(metadata)
        title = str(metadata.get("title") or "YouTube video").strip()

        if audio_mode:
            if not audio_formats(metadata):
                raise UserVisibleError("❌ این ویدیو فایل صوتی قابل دانلود نداره.")

            mode_label = "کم‌حجم" if audio_mode == "low" else "HQ"
            phase = "download"
            status(f"⬇️ دارم صدای ویدیو رو با حالت {mode_label} دانلود می‌کنم…")
            audio_path = download_audio(url, workdir, audio_mode)
            phase = "upload"
            status("📤 فایل صوتی آماده شد؛ دارم می‌فرستم…")
            sent = send_audio_file(
                token,
                chat_id,
                request_message_id,
                audio_path,
                f"{title}\nAudio {mode_label}",
            )
            store_uploaded_file(payload, [payload.get("mediaCacheKey")], "sendAudio", {"caption": f"{title}\nAudio {mode_label}", "title": title}, sent)
            delete_status(token, chat_id, status_message_id)
            return {"ok": True, "parts": 1, "title": title, "audioMode": audio_mode}

        assert quality is not None
        if quality not in available_qualities(metadata):
            raise UserVisibleError(f"❌ کیفیت {quality}p برای این ویدیو موجود نیست. دوباره لینک رو بفرست.")

        phase = "download"
        status(f"⬇️ دارم ویدیو رو با کیفیت {quality}p دانلود می‌کنم…")
        video_path = download_video(url, workdir, quality, metadata)
        validate_file_size(video_path)
        phase = "upload"
        status("📤 ویدیو کامل آماده شد؛ دارم می‌فرستم…")
        sent = send_media_file(
            token, chat_id, request_message_id, video_path,
            f"{title}\n{quality}p", reply=True,
        )
        store_uploaded_file(payload, [payload.get("mediaCacheKey")], "sendVideo", {"caption": f"{title}\n{quality}p", "supports_streaming": True}, sent)
        delete_status(token, chat_id, status_message_id)
        return {"ok": True, "parts": 1, "title": title, "quality": quality}

    except UserVisibleError as exc:
        JOB_DEADLINE.set(None)  # Error reporting has the Workflow's reserved cleanup time.
        try:
            edit_status(token, chat_id, status_message_id, str(exc))
        except Exception:
            pass
        return {"ok": False, "message": str(exc)}
    except Exception as exc:
        JOB_DEADLINE.set(None)
        diagnostic = upload_error_diagnostic(exc, token)
        retry_safe = (phase == "upload" and diagnostic.get("rpcCode") == 420
                      and diagnostic.get("errorCode") in {"FLOOD_WAIT", "SLOWMODE_WAIT"}
                      and type(diagnostic.get("retryAfterSeconds")) is int)
        if retry_safe:
            # Single-file sends raise this definitive server rejection before
            # delivery; all part workers have already stopped. Ambiguous
            # network failures never enter this resumable path.
            message = "⏳ تلگرام موقتاً ارسال را متوقف کرده؛ درخواست محفوظ است و خودکار ادامه پیدا می‌کند. نیازی به درخواست دوباره نیست."
            status(message)
            return {"ok": False, "message": message, "phase": phase, "retrySafe": True, **diagnostic}
        print(json.dumps({"message": "youtube job failed", "jobId": payload.get("id"),
                          "phase": phase, **diagnostic}, ensure_ascii=False), flush=True)
        message = telegram_flood_message(diagnostic) or ("❌ ارسال فایل در تلگرام تأیید نشد؛ اگر فایلی دریافت کرده‌ای، پیش از درخواست دوباره بررسی کن."
                   if phase in {"upload", "cache"} else "❌ دریافت اطلاعات ویدیو کامل نشد؛ دوباره امتحان کن."
                   if phase == "metadata" else "❌ دریافت فایل از منبع کامل نشد؛ دوباره امتحان کن.")
        status(message)
        return {"ok": False, "message": message, "phase": phase, **diagnostic}
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        JOB_DEADLINE.reset(deadline_token)


INSTAGRAM_RECORD_SECONDS = 2 * 60 * 60
INSTAGRAM_FILE_LIMIT = 1_900_000_000  # Leave room for the finalized MP4 below Telegram's cap.
INSTAGRAM_JOBS: dict[str, "InstagramCapture"] = {}
INSTAGRAM_LOCK = threading.Lock()

RECOGNITION_FILE_LIMIT = 20_000_000
RECOGNITION_WINDOW_SECONDS = 12
RECOGNITION_SAMPLE_SECONDS = 120


def music_query_key(query: str, *, recognition: bool = False) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", query).lower().split())
    return ("mq:r2:" if recognition else "mq:") + hashlib.sha256(normalized.encode()).hexdigest()


def file_cache(payload: dict[str, Any], op: str, key: str | None, value: dict[str, Any] | None = None) -> dict[str, Any] | None:
    if not key or not re.fullmatch(r"[A-Za-z0-9:_-]{1,180}", key):
        return None
    url = str(payload.get("cacheUrl") or "")
    if not re.fullmatch(r"https://downloader\.vexaagent\.workers\.dev/media-cache/(?:igdl|ytdl)--?\d+-\d+-\d+(?:-(?:audio|song))?", url):
        return None
    try:
        response = requests.post(url, headers={"x-media-cache-token": payload["cacheToken"]},
                                 json={"op": op, "key": key, "value": value}, timeout=(5, 10), allow_redirects=False)
        if response.ok:
            return response.json().get("value")
    except Exception:
        print("telegram file cache unavailable", flush=True)
    return None


def reuse_cached_file(payload: dict[str, Any], key: str | None, caption: str | None = None, *, reply_markup: dict[str, Any] | None = None, cached: dict[str, Any] | None = None) -> bool:
    cached = cached if cached is not None else file_cache(payload, "get", key)
    if not isinstance(cached, dict) or cached.get("method") not in {"sendAudio", "sendVideo"} or not cached.get("fileId"):
        return False
    data = dict(cached.get("data") or {})
    if caption is not None:
        data["caption"] = caption[:1024]
    if reply_markup is not None:
        data["reply_markup"] = reply_markup
    data.update({"chat_id": payload["chatId"], "reply_parameters": {"message_id": payload["requestMessageId"]},
                 "audio" if cached["method"] == "sendAudio" else "video": cached["fileId"]})
    try:
        sent = telegram_call(payload["botToken"], cached["method"], json_payload=data, timeout=90)
        media = (sent.get("video") or sent.get("audio") or {}) if isinstance(sent, dict) else {}
        try:
            USAGE.delivery(payload["botToken"], payload["chatId"], sent, media.get("file_size", cached.get("fileSize")), cached=True)
        except Exception:
            pass
        return True
    except Exception as exc:
        if re.search(r"wrong.*file|file.*(?:invalid|expired)|file_reference|failed to get.*file", str(exc), re.I):
            file_cache(payload, "delete", key)
            return False
        raise UserVisibleError("❌ ارسال فایل ذخیره‌شده کامل نشد؛ برای جلوگیری از ارسال تکراری، آپلود دوباره شروع نشد.") from exc


def store_uploaded_file(payload: dict[str, Any], keys: list[str | None], method: str, data: dict[str, Any], result: Any, *, file_size: int | None = None, has_audio: bool | None = None) -> None:
    if not isinstance(result, dict) or not result.get("file_id"):
        return
    allowed = {key: data[key] for key in ("caption", "title", "performer", "width", "height", "duration", "supports_streaming") if key in data}
    value = {"method": method, "fileId": result["file_id"], "data": allowed}
    if type(file_size) is int and 0 < file_size <= DIRECT_TELEGRAM_LIMIT:
        value["fileSize"] = file_size
    if type(has_audio) is bool:
        value["hasAudio"] = has_audio
    for key in dict.fromkeys(keys):
        if key:
            file_cache(payload, "put", key, value)


def download_recognition_input(token: str, media: dict[str, Any], workdir: Path) -> Path:
    file_id = str(media.get("fileId") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", file_id):
        raise UserVisibleError("❌ شناسهٔ فایل معتبر نیست؛ فایل را دوباره بفرست.")
    try:
        info = telegram_call(token, "getFile", json_payload={"file_id": file_id}, timeout=30)
        size = int(info.get("file_size") or media.get("fileSize") or 0)
        if size > RECOGNITION_FILE_LIMIT:
            raise UserVisibleError("❌ فایل برای تشخیص آهنگ بزرگ است؛ یک تکهٔ کوتاه با حجم حداکثر 20 MB بفرست.")
        file_path = str(info.get("file_path") or "")
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", file_path) or any(part in {"", ".", ".."} for part in file_path.split("/")):
            raise UserVisibleError("❌ دریافت آدرس فایل از تلگرام کامل نشد؛ فایل را دوباره بفرست.")
        target = workdir / "recognition-input"
        deadline = time.monotonic() + 120
        with requests.get(f"https://api.telegram.org/file/bot{token}/{file_path}",
                          stream=True, allow_redirects=False, timeout=(15, 30)) as response:
            if response.status_code != 200:
                raise UserVisibleError("❌ دریافت فایل از تلگرام انجام نشد؛ یک تکهٔ کوتاه‌تر بفرست.")
            if int(response.headers.get("content-length") or 0) > RECOGNITION_FILE_LIMIT:
                raise UserVisibleError("❌ برای تشخیص آهنگ فایل باید حداکثر 20 MB باشد.")
            total = 0
            with target.open("wb") as handle:
                for chunk in response.iter_content(64 * 1024):
                    total += len(chunk)
                    if total > RECOGNITION_FILE_LIMIT or time.monotonic() > deadline:
                        raise UserVisibleError("❌ دریافت فایل کامل نشد؛ یک تکهٔ کوتاه‌تر با حجم حداکثر 20 MB بفرست.")
                    handle.write(chunk)
        if not total or (size and total != size):
            raise UserVisibleError("❌ فایل صوتی کامل دریافت نشد؛ دوباره بفرست.")
        return target
    except UserVisibleError:
        raise
    except Exception as exc:
        # Telegram errors can contain the token-bearing download URL. Never expose them.
        raise UserVisibleError("❌ دریافت فایل از تلگرام انجام نشد؛ یک تکهٔ کوتاه‌تر با حجم حداکثر 20 MB بفرست.") from exc


def recognition_samples(source: Path | str, workdir: Path, *, remote: bool = False) -> list[Path]:
    decoded = workdir / "recognition-pcm.wav"
    try:
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                        "-rw_timeout", "15000000", "-protocol_whitelist", "https,tls,tcp" if remote else "file,pipe", "-format_whitelist", "mov,matroska,webm,mp3,ogg,wav,aac,flac,asf,aiff",
                        "-i", str(source), "-t", str(RECOGNITION_SAMPLE_SECONDS), "-map", "0:a:0", "-vn",
                        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(decoded)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=45)
    except subprocess.SubprocessError as exc:
        raise UserVisibleError("❌ صدای قابل خواندن داخل این فایل نیست؛ یک ویس یا ویدیوی صدادار بفرست.") from exc
    # Decode once, then choose audible windows across the bounded clip, rather
    # than spending every request on its intro. Never lengthen Shazam's 12s window.
    windows = []
    with wave.open(str(decoded), "rb") as audio:
        while frames := audio.readframes(16000 * RECOGNITION_WINDOW_SECONDS):
            if len(frames) < 16000 * 2 * 3:
                continue
            values = array("h", frames)
            energy = sum(value * value for value in values) / len(values)
            if energy >= 64:
                windows.append((frames, energy))
    samples = []
    count = min(3, len(windows))
    for index in range(count):
        group = windows[index * len(windows) // count:(index + 1) * len(windows) // count]
        frames, _ = max(group, key=lambda window: window[1])
        sample = workdir / f"recognition-{index}.wav"
        with wave.open(str(sample), "wb") as output:
            output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            output.writeframes(frames)
        samples.append(sample)
    if not samples:
        raise UserVisibleError("❌ صدای کافی برای تشخیص ندارم؛ حداقل 3 ثانیه و ترجیحاً 10 تا 30 ثانیه از آهنگ را بفرست.")
    return samples


async def recognize_samples(samples: list[Path]) -> dict[str, str]:
    from shazamio import Shazam
    from shazamio.client import HTTPClient
    from shazamio.exceptions import RateLimited
    from aiohttp_retry import ExponentialRetry

    # The upstream default retries twenty times. Bound this interactive request instead.
    try:
        async with HTTPClient(retry_options=ExponentialRetry(attempts=1)) as client:
            async with Shazam(http_client=client, segment_duration_seconds=12) as recognizer:
                votes: dict[str, tuple[int, dict[str, str]]] = {}
                service_error = None
                for sample in samples[:3]:
                    try:
                        result = await asyncio.wait_for(recognizer.recognize(str(sample)), timeout=25)
                        if not isinstance(result, dict) or not isinstance(result.get("matches"), list):
                            raise ValueError("Invalid recognition response")
                        track = result.get("track")
                        if not result["matches"] or not isinstance(track, dict):
                            continue
                        title = " ".join(str(track.get("title") or "").split())[:180]
                        artist = " ".join(str(track.get("subtitle") or "").split())[:120]
                        if not title or not artist:
                            continue
                        key = str(track.get("key") or unicodedata.normalize("NFKC", f"{artist}|{title}").casefold())
                        count = votes.get(key, (0, {}))[0] + 1
                        votes[key] = (count, {"title": title, "artist": artist})
                        if count >= 2:
                            return votes[key][1]
                    except RateLimited:
                        raise  # Respect an explicit service limit; no further requests.
                    except Exception as exc:
                        service_error = exc
                        print(f"music recognition sample failed: {type(exc).__name__}", flush=True)
                if len(votes) == 1:
                    return next(iter(votes.values()))[1]
                if len(votes) > 1:
                    raise UserVisibleError("❌ بخش‌های فایل به آهنگ‌های متفاوتی تطبیق خوردند؛ یک تکهٔ واضح‌تر از آهنگ موردنظر بفرست.")
                if service_error is not None:
                    raise service_error
    except UserVisibleError:
        raise
    except Exception as exc:
        print(f"music recognition service failed: {type(exc).__name__}", flush=True)
        message = "❌ سرویس تشخیص آهنگ موقتاً پاسخ نداد؛ کمی بعد دوباره امتحان کن."
        if isinstance(exc, RateLimited):
            message = "❌ سرویس Shazam فعلاً درخواست‌ها را محدود کرده؛ کمی بعد دوباره امتحان کن."
        raise UserVisibleError(message) from exc
    raise UserVisibleError("❌ آهنگ شناسایی نشد؛ یک بخش واضح‌تر با موسیقی بیشتر و صحبت کمتر بفرست.")


def recognize_telegram_music(token: str, media: dict[str, Any], workdir: Path) -> dict[str, str]:
    try:
        source = download_recognition_input(token, media, workdir)
        samples = recognition_samples(source, workdir)
        return asyncio.run(recognize_samples(samples))
    finally:
        # Keep only the final song, never the user's source clip or fingerprints.
        for path in workdir.glob("recognition-*"):
            path.unlink(missing_ok=True)


def recognize_instagram_music(url: str, workdir: Path) -> dict[str, str]:
    try:
        samples = recognition_samples(instagram_safe_url(url), workdir, remote=True)
        return asyncio.run(recognize_samples(samples))
    finally:
        for path in workdir.glob("recognition-*"):
            path.unlink(missing_ok=True)


def instagram_safe_url(value: str) -> str:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port
            or not any(host == domain or host.endswith("." + domain) for domain in ("cdninstagram.com", "fbcdn.net"))):
        raise UserVisibleError("❌ آدرس فایل لایو معتبر نیست.")
    return value


def instagram_manifest(xml: str, origin: str | None, live: bool) -> str:
    if len(xml) > 2_000_000 or "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
        raise UserVisibleError("❌ اطلاعات پخش لایو معتبر نیست.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise UserVisibleError("❌ اطلاعات پخش لایو دریافت نشد.") from exc
    tag = lambda node: node.tag.rsplit("}", 1)[-1]
    if tag(root) != "MPD" or any(tag(node) == "ContentProtection" for node in root.iter()):
        raise UserVisibleError("❌ این فایل پخش قابل دانلود نیست.")
    if root.tag.startswith("{"):
        ET.register_namespace("", root.tag[1:].split("}", 1)[0])
    if not live and root.get("type", "static") == "dynamic":
        raise UserVisibleError("❌ این لینک بازپخش منتشرشده نیست؛ لینک پست یا Reel بازپخش را بفرست.")

    def rewrite(node: ET.Element, base: str) -> None:
        bases = [child for child in node if tag(child) == "BaseURL"]
        for child in bases:
            child.text = instagram_safe_url(urljoin(base, (child.text or "").strip()))
        current = bases[0].text if bases else base
        for key, value in list(node.attrib.items()):
            if key.rsplit("}", 1)[-1] in {"media", "initialization", "sourceURL", "href"}:
                node.set(key, instagram_safe_url(urljoin(current or "", value)))
        for child in node:
            if tag(child) == "Location":
                child.text = instagram_safe_url(urljoin(current or "", (child.text or "").strip()))
            elif tag(child) != "BaseURL":
                rewrite(child, current or "")
    rewrite(root, origin or "")
    # A local static MPD needs a network base for relative segment URLs.
    if origin and not any(tag(child) == "BaseURL" for child in root):
        namespace = root.tag[:-3] if root.tag.endswith("MPD") else ""
        child = ET.Element(namespace + "BaseURL")
        child.text = instagram_safe_url(urljoin(origin, "."))
        root.insert(0, child)
    if not any(tag(node) == "Representation" for node in root.iter()):
        raise UserVisibleError("❌ فایل ویدیو داخل اطلاعات پخش وجود ندارد.")
    return ET.tostring(root, encoding="unicode")


def instagram_read_manifest(url: str) -> tuple[str, str]:
    # Validate each redirect; never forward Instagram account cookies to a CDN.
    for _ in range(4):
        instagram_safe_url(url)
        with requests.get(url, headers={"Referer": "https://www.instagram.com/"}, timeout=(15, 30), stream=True, allow_redirects=False) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                url = urljoin(url, response.headers.get("location", ""))
                continue
            if response.status_code in {401, 403, 404}:
                raise UserVisibleError("❌ آدرس پخش لایو منقضی شده یا دسترسی سرور رد شده؛ لینک را دوباره بفرست.")
            response.raise_for_status()
            chunks, size = [], 0
            for chunk in response.iter_content(64 * 1024):
                size += len(chunk)
                if size > 2_000_000:
                    raise UserVisibleError("❌ اطلاعات پخش لایو بیش از حد بزرگ است.")
                chunks.append(chunk)
            return b"".join(chunks).decode("utf-8"), url
    raise UserVisibleError("❌ آدرس پخش لایو بیش از حد تغییر مسیر داد.")


class InstagramCapture:
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        self.id = str(payload.get("id") or "")
        if not re.fullmatch(r"igdl--?\d+-\d+-\d+(?:-(?:audio|song|music-[A-Za-z0-9_-]{11}|profile-\d+))?", self.id):
            raise ValueError("Invalid Instagram job ID")
        self.source = payload.get("source") or {}
        self.live = self.source.get("mode") == "live"
        self.audio_only = bool(self.source.get("audioOnly"))
        if self.source.get("mode") not in {"live", "replay"}:
            raise ValueError("Invalid Instagram mode")
        if payload.get("completionUrl") != f"https://downloader.vexaagent.workers.dev/instagram/events/{self.id}":
            raise ValueError("Invalid completion destination")
        if not re.fullmatch(r"[a-f0-9]{64}", str(payload.get("completionToken") or "")):
            raise ValueError("Invalid event token")
        self.workdir = Path(tempfile.mkdtemp(prefix="instagram-capture-"))
        self.path = self.workdir / ("Instagram.m4a" if self.audio_only else "Instagram.mp4")
        self.process: subprocess.Popen | None = None
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.cleanup_requested = False
        self.reason = ""
        self.cached = False
        self.state = "starting"
        self.result: dict[str, Any] = {"ok": False}
        self.thread = threading.Thread(target=self.run_active, daemon=True)
        self.expiry = threading.Timer(3 * 60 * 60, self.cleanup)
        self.expiry.daemon = True

    def status(self, text: str, *, button: bool = False) -> None:
        telegram_call(self.payload["botToken"], "editMessageText", json_payload={
            "chat_id": self.payload["chatId"], "message_id": self.payload["statusMessageId"], "text": text,
            "reply_markup": {"inline_keyboard": [[{"text": "⏹ توقف پلی‌لیست" if self.source.get("playlist") else "⏹ توقف ضبط و ارسال", "callback_data": self.payload["stopData"]}]] if button else []},
        }, timeout=30)

    def safe_status(self, text: str, *, button: bool = False) -> None:
        try:
            self.status(text, button=button)
        except Exception:
            print("instagram status delivery failed", flush=True)

    def stop(self, reason: str = "user") -> bool:
        with self.lock:
            if self.state not in {"starting", "recording"} or (reason == "user" and not self.live and not self.source.get("playlist")):
                return False
            if not self.reason:
                self.reason = reason
            self.stop_event.set()
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    return True
                killer = threading.Timer(15, self.kill)
                killer.daemon = True
                killer.start()
            return True

    def kill(self) -> None:
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.kill()

    def notify(self) -> None:
        for attempt in range(3):
            try:
                response = requests.post(self.payload["completionUrl"], headers={"x-instagram-event-token": self.payload["completionToken"]}, json=self.result, timeout=(10, 20))
                if response.ok:
                    return
            except requests.RequestException:
                pass
            if attempt < 2:
                self.stop_event.wait(2 ** (attempt + 1))
        self.safe_status("❌ اعلام نتیجهٔ پلی‌لیست به ربات کامل نشد؛ پیش از درخواست دوباره، فایل‌های ارسال‌شده را بررسی کن." if self.source.get("playlist") else "❌ فایل دریافت شد ولی اعلام نتیجه به ربات کامل نشد؛ لینک را دوباره بفرست.")

    def run_active(self) -> None:
        with server_activity(), request_cache(), USAGE.scope(getattr(self, "payload", {}).get("userId")):
            self.run()

    def run(self) -> None:
        watchdog = wall_timer = None
        try:
            if self.source.get("bandcamp"):
                from bandcamp import prepare
                prepare(self)
                return
            if self.source.get("instagramPost"):
                post = self.source["instagramPost"]
                if post.get("storyId") and (not re.fullmatch(r"\d{1,24}", str(post["storyId"]))
                                             or post["storyId"] != post.get("shortcode") or len(post.get("media") or []) != 1):
                    raise UserVisibleError("❌ اطلاعات استوری اینستاگرام معتبر نیست.")
                items = post.get("media")
                if (not re.fullmatch(r"[A-Za-z0-9_-]{1,20}", str(post.get("shortcode") or ""))
                        or not isinstance(items, list) or not 1 <= len(items) <= 20):
                    raise UserVisibleError("❌ اطلاعات پست اینستاگرام معتبر نیست.")
                for item in items:
                    instagram_safe_url(item["url"])
                    if item.get("kind") not in {"photo", "video"}:
                        raise UserVisibleError("❌ نوع فایل اینستاگرام معتبر نیست.")
                    size = item.get("size")
                    if size is not None and (type(size) is not int or not 0 < size <= DIRECT_TELEGRAM_LIMIT):
                        raise UserVisibleError("❌ حجم فایل از سقف ارسال ۲ گیگابایت بیشتر است.")
                self.post_sent = 0
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                return
            if self.source.get("musicSearch"):
                from youtube_pipeline import music_candidates
                results = music_candidates(str(self.source.get("musicQuery") or ""))[:5]
                if not results:
                    raise UserVisibleError("❌ آهنگی با این نام پیدا نشد؛ نام خواننده را هم بنویس.")
                self.source["musicResults"] = results
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                return
            if self.source.get("playlist"):
                self.run_playlist()
                return
            if self.source.get("social"):
                from youtube_pipeline import prepare_social_media
                credentials = ({"pinterest_cookies": self.payload.pop("pinterestCookies", "")}
                               if self.source["social"].get("platform") == "pinterest" else {})
                self.social_url, self.social_items = prepare_social_media(self.source["social"], self.workdir, cache_payload=self.payload, **credentials)
                self.social_sent = 0
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                self.safe_status(f"📤 {len(self.social_items)} فایل آمادهٔ ارسال است…")
                return
            if reuse_cached_file(self.payload, self.payload.get("mediaCacheKey")):
                self.cached = True
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                return
            if self.source.get("recognition") or self.source.get("recognizeMusic"):
                self.safe_status("🎧 دارم صدای فایل را با Shazam بررسی می‌کنم…")
                match = (recognize_instagram_music(self.source.get("url", ""), self.workdir) if self.source.get("recognizeMusic")
                         else recognize_telegram_music(self.payload["botToken"], self.source["recognition"], self.workdir))
                self.source.update({"recognizedTitle": match["title"], "recognizedArtist": match["artist"],
                                    "musicQuery": f"{match['artist']} {match['title']}"})
                self.safe_status(f"✅ آهنگ شناسایی شد\n🎵 {match['title']}\n👤 {match['artist']}\n⬇️ دارم فایل کاملش را پیدا می‌کنم…")
            if self.source.get("musicQuery") or self.source.get("musicVideoId"):
                from youtube_pipeline import prepare_music, prepare_music_url
                selected_id = self.source.get("musicVideoId")
                cache_key = f"yt:{selected_id}:mp3" if selected_id else music_query_key(self.source["musicQuery"], recognition=bool(self.source.get("recognition") or self.source.get("recognizeMusic")))
                if reuse_cached_file(self.payload, cache_key):
                    self.cached = True
                    self.result = {"ok": True}
                    with self.lock:
                        self.state = "ready"
                    return
                if not self.source.get("recognition") and not self.source.get("recognizeMusic"):
                    self.safe_status("⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…")
                recognition_options = ({"recognized": {"title": self.source["recognizedTitle"],
                    "artist": self.source["recognizedArtist"]}} if self.source.get("recognizedTitle") else {})
                self.path, title, artist, url = (prepare_music_url(f"https://www.youtube.com/watch?v={selected_id}", self.workdir)
                    if selected_id else prepare_music(self.source["musicQuery"], self.workdir, **recognition_options))
                self.source.update({"title": title, "performer": artist, "musicUrl": url})
                video_id = parse_qs(urlparse(url).query).get("v", [""])[0]
                self.source["musicFileKey"] = f"yt:{video_id}:mp3"
                self.video = {"title": title, "performer": artist}
                self.result = {"ok": True}
                with self.lock:
                    self.state = "ready"
                self.safe_status(f"🎵 {title}\n📤 آهنگ پیدا شد؛ دارم فایل MP3 را آمادهٔ ارسال می‌کنم…")
                return
            source_url = self.source.get("url")
            xml = self.source.get("manifest")
            if source_url:
                instagram_safe_url(source_url)
            if self.live or xml or (source_url and urlparse(source_url).path.lower().endswith(".mpd")):
                origin = source_url
                if not xml:
                    xml, origin = instagram_read_manifest(source_url)
                xml = instagram_manifest(xml, origin, self.live)
                if self.live:
                    # FFmpeg must reload the remote dynamic MPD to receive new segments.
                    if not source_url:
                        raise UserVisibleError("❌ آدرس زندهٔ پخش موجود نیست؛ لینک Live را دوباره بفرست.")
                    input_url = instagram_safe_url(origin)
                else:
                    manifest_path = self.workdir / "replay.mpd"
                    manifest_path.write_text(xml, encoding="utf-8")
                    input_url = str(manifest_path)
            elif source_url:
                input_url = source_url
            else:
                raise UserVisibleError("❌ فایل پخش این لایو در دسترس نیست.")
            if self.stop_event.is_set():
                raise UserVisibleError("ضبط پیش از دریافت تصویر متوقف شد؛ فایلی برای ارسال وجود ندارد.")
            raw_path = self.workdir / ("capture.m4a" if self.audio_only else "capture.mp4")
            command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                       "-rw_timeout", "45000000", "-protocol_whitelist", "file,https,tls,tcp",
                       "-i", input_url]
            command += (["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k"] if self.audio_only
                        else ["-sn", "-dn", "-c", "copy"])
            if self.live:
                command += ["-t", str(INSTAGRAM_RECORD_SECONDS)]
            command += ["-fs", str(INSTAGRAM_FILE_LIMIT), "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
                        "-progress", "pipe:1", str(raw_path)]
            with self.lock:
                self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                self.state = "recording"
                if self.stop_event.is_set():
                    self.stop()
            self.safe_status("🔴 ضبط Live شروع شد.\nاز این لحظه تا پایان پخش یا توقف ضبط ذخیره می‌شود.\nسقف هر ضبط: 2 ساعت یا 1.9 GB." if self.live else "🎧 دارم صدا را از ویدیوی اینستاگرام جدا می‌کنم…" if self.audio_only else "⬇️ دارم بازپخش کامل لایو را دانلود می‌کنم…", button=self.live)
            wall_timer = threading.Timer(INSTAGRAM_RECORD_SECONDS + 60 if self.live else 25 * 60, lambda: self.stop("time_limit"))
            wall_timer.daemon = True
            wall_timer.start()
            last_progress = None
            # FFmpeg's progress stream drives the stall watchdog; no status polling.
            assert self.process.stdout is not None
            watchdog = threading.Timer(90, lambda: self.stop("interrupted"))
            watchdog.daemon = True
            watchdog.start()
            for line in self.process.stdout:
                if line.startswith("out_time_us=") and line.strip() != last_progress:
                    last_progress = line.strip()
                    watchdog.cancel()
                    watchdog = threading.Timer(90, lambda: self.stop("interrupted"))
                    watchdog.daemon = True
                    watchdog.start()
            self.process.stdout.close()
            returncode = self.process.wait()
            watchdog.cancel()
            wall_timer.cancel()
            with self.lock:
                self.state = "finalizing"
            if not raw_path.exists() or raw_path.stat().st_size < 100:
                raise UserVisibleError("❌ فایل صوتی دریافت نشد؛ این ویدیو ممکن است بی‌صدا یا فایل آن منقضی شده باشد." if self.audio_only else "❌ تصویری از لایو دریافت نشد؛ ممکن است پخش پایان یافته یا آدرس آن منقضی شده باشد.")
            capped = raw_path.stat().st_size >= INSTAGRAM_FILE_LIMIT
            if not self.live and (returncode != 0 or self.reason or capped):
                raise UserVisibleError("❌ فایل صوتی کامل دریافت نشد یا حجم آن از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد." if self.audio_only else "❌ بازپخش کامل دریافت نشد یا حجم آن از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد.")
            if self.live and not self.reason:
                self.reason = "size_limit" if capped else ("interrupted" if returncode != 0 else "ended")
            mapping = ["-map", "0:a:0", "-vn"] if self.audio_only else ["-map", "0:v:0", "-map", "0:a:0?"]
            subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(raw_path),
                            *mapping, "-c", "copy", "-movflags", "+faststart", str(self.path)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=180)
            raw_path.unlink(missing_ok=True)
            validate_file_size(self.path)
            info = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(self.path)],
                                  capture_output=True, text=True, check=True, timeout=45)
            metadata = json.loads(info.stdout)
            video = next((stream for stream in metadata.get("streams", []) if stream.get("codec_type") == ("audio" if self.audio_only else "video")), None)
            duration = float(metadata.get("format", {}).get("duration") or 0)
            if not video or duration <= 0:
                raise UserVisibleError("❌ فایل صوتی سالم برای ارسال ساخته نشد." if self.audio_only else "❌ فایل ویدیوی سالم برای ارسال ساخته نشد.")
            expected = float(self.source.get("duration") or 0)
            if not self.live and expected and duration < expected - 2:
                raise UserVisibleError("❌ صدا ناقص دریافت شد؛ فایل ناقص ارسال نشد." if self.audio_only else "❌ بازپخش ناقص دریافت شد؛ فایل ناقص ارسال نشد.")
            if self.live and self.reason == "ended" and duration >= INSTAGRAM_RECORD_SECONDS - 1:
                self.reason = "time_limit"
            self.video = {"width": str(video.get("width", 0)), "height": str(video.get("height", 0)), "duration": str(duration), "title": str(self.source.get("title") or "Instagram Audio")}
            self.result = {"ok": True}
            self.safe_status("📤 فایل آماده شد؛ در حال آماده‌سازی ارسال…")
            with self.lock:
                self.state = "ready"
        except Exception as exc:
            # Never print commands, signed stream URLs, bot tokens or account data.
            print(f"instagram capture failed: {type(exc).__name__}", flush=True)
            self.result = {"ok": False, "message": str(exc) if isinstance(exc, UserVisibleError) else "❌ دریافت یا آماده‌سازی لایو کامل نشد؛ لینک را دوباره بفرست."}
            if self.source.get("bandcamp") and not isinstance(exc, UserVisibleError):
                self.result["message"] = "❌ دریافت یا آماده‌سازی Bandcamp کامل نشد؛ دوباره لینک آهنگ را بفرست."
            if self.source.get("playlist") and not isinstance(exc, UserVisibleError):
                self.result["message"] = "❌ پردازش پلی‌لیست کامل نشد؛ فایل‌های ارسال‌شده را قبل از درخواست دوباره بررسی کن."
            if self.source.get("social") and not isinstance(exc, UserVisibleError):
                self.result["message"] = "❌ دریافت یا آماده‌سازی فایل کامل نشد؛ لینک عمومی پست یا آهنگ را دوباره بفرست."
            if self.source.get("recognition") or self.source.get("recognizeMusic"):
                self.result["message"] = str(exc) if isinstance(exc, UserVisibleError) else "❌ دریافت فایل آهنگ کامل نشد؛ دوباره امتحان کن."
                if self.source.get("recognizedTitle"):
                    self.result["message"] = f"✅ آهنگ شناسایی شد\n🎵 {self.source['recognizedTitle']}\n👤 {self.source['recognizedArtist']}\n" + self.result["message"]
            with self.lock:
                self.state = "failed"
        finally:
            if self.process is not None:
                if self.process.poll() is None:
                    self.kill()
                    self.process.wait(timeout=20)
                if self.process.stdout is not None:
                    self.process.stdout.close()
            if watchdog:
                watchdog.cancel()
            if wall_timer:
                wall_timer.cancel()
            self.notify()
            if self.cleanup_requested:
                shutil.rmtree(self.workdir, ignore_errors=True)
                JOB_CAPACITY.release(self.id)
                with INSTAGRAM_LOCK:
                    INSTAGRAM_JOBS.pop(self.id, None)

    def run_playlist(self) -> None:
        from youtube_pipeline import playlist_entries, prepare_music_url
        playlist = self.source["playlist"]
        title, entries = playlist_entries(playlist["url"], int(playlist["start"]), int(playlist["end"]))
        sent, failed, uncertain = 0, [], None
        processed: set[int] = set()
        deadline = time.monotonic() + 90 * 60
        with self.lock:
            self.state = "recording"
        for entry in entries:
            if self.stop_event.is_set() or time.monotonic() > deadline:
                break
            index = entry["index"]
            self.safe_status(f"🎵 {title}\nآهنگ {index} از بازهٔ {playlist['start']}-{playlist['end']}\nارسال‌شده: {sent}", button=True)
            if not entry["id"]:
                failed.append(index)
                processed.add(index)
                continue
            key = f"yt:{entry['id']}:mp3"
            caption = f"{title}\n{index}. {entry['title']}"
            trackdir = self.workdir / f"track-{index}"
            trackdir.mkdir(exist_ok=True)
            try:
                if reuse_cached_file(self.payload, key, caption):
                    sent += 1
                    processed.add(index)
                    continue
                try:
                    path, track, artist, url = prepare_music_url(f"https://www.youtube.com/watch?v={entry['id']}", trackdir)
                except UserVisibleError:
                    failed.append(index)
                    processed.add(index)
                    continue
                if self.stop_event.is_set():
                    break
                data = {"chat_id": str(self.payload["chatId"]), "caption": f"{title}\n{index}. {track}\n{url}"[:1024],
                        "title": track, "performer": artist,
                        "reply_parameters": json.dumps({"message_id": self.payload["requestMessageId"]})}
                with path.open("rb") as handle:
                    result = asyncio.run(asyncio.wait_for(upload_complete_file(self.payload["botToken"], "sendAudio", data, ("Music.mp3", handle, "audio/mpeg")), timeout=10 * 60))
                sent += 1
                processed.add(index)
                # The shared cache caption must not retain a different user's playlist name.
                store_uploaded_file(self.payload, [key], "sendAudio", {**data, "caption": f"{track}\n{artist}\n{url}"[:1024]}, result)
            except Exception:
                # A send may have reached Telegram before its response was lost. Stop; never retry it.
                uncertain = index
                processed.add(index)
                break
            finally:
                shutil.rmtree(trackdir, ignore_errors=True)
        summary = f"🎵 {title}\n✅ ارسال‌شده: {sent} از {len(entries)}"
        if failed:
            summary += "\n❌ دریافت نشد: " + ", ".join(map(str, failed))
        if uncertain:
            summary += f"\n⚠️ ارسال مورد {uncertain} تأیید نشد؛ برای جلوگیری از تکرار، صف متوقف شد."
        if self.stop_event.is_set() or time.monotonic() > deadline:
            summary += "\nصف متوقف شد؛ فایل‌های باقی‌مانده ارسال نشدند."
        pending = next((item["index"] for item in entries if item["index"] not in processed), None)
        resume = pending if pending is not None else playlist["end"] + 1
        if resume <= 10000 and (pending is not None or len(entries) == playlist["end"] - playlist["start"] + 1):
            summary += f"\nادامه: /playlist {playlist['url']} {resume}-{min(10000, resume + 19)}"
        self.playlist_result = {"ok": sent > 0, "parts": sent, "partial": sent < len(entries), "title": title, "message": summary[:1000]}
        self.result = self.playlist_result
        self.safe_status(summary[:3000])
        with self.lock:
            self.state = "ready" if sent else "failed"

    def send(self) -> dict[str, Any]:
        with self.lock:
            if self.state == "sent":
                if self.source.get("bandcamp"):
                    return self.result
                if self.source.get("instagramPost"):
                    return {"ok": True, "parts": self.post_sent}
                return {"ok": True, "parts": self.social_sent} if self.source.get("social") else {"ok": True}
            if self.state != "ready":
                return {"ok": False, "message": "فایل آمادهٔ ارسال نیست یا قبلاً ارسال آن شروع شده است."}
            if self.source.get("playlist"):
                self.state = "sent"
                return self.playlist_result
            if self.cached:
                self.state = "sent"
                delete_status(self.payload["botToken"], self.payload["chatId"], self.payload["statusMessageId"])
                return {"ok": True}
            self.state = "sending"
        uploading = False
        try:
            if self.source.get("bandcamp"):
                from bandcamp import send
                return send(self)
            if self.source.get("instagramPost"):
                return self.send_instagram_post()
            if self.source.get("musicSearch"):
                expiry = int(time.time()) + 86400
                owner = int(self.payload["userId"])
                lines, buttons = ["🎵 نتیجه‌های جست‌وجو\nآهنگ موردنظرت را انتخاب کن:\n"], []
                for index, item in enumerate(self.source["musicResults"], 1):
                    title = " ".join(str(item.get("title") or "Music").split())[:110]
                    artist = " ".join(str(item.get("channel") or item.get("uploader") or "").split())[:70]
                    duration = int(float(item.get("duration") or 0))
                    length = f"{duration // 60}:{duration % 60:02d}" if duration > 0 else ""
                    lines.append(f"{index}. {title}\n" + " | ".join(part for part in [artist, length] if part))
                    video_id = item["id"]
                    signature = hmac.new(self.payload["botToken"].encode(),
                        f"music-select:{self.payload['chatId']}:{owner}:{video_id}:{expiry}".encode(), hashlib.sha256).hexdigest()[:16]
                    buttons.append([{"text": f"{index}. {title}"[:64], "callback_data": f"msc|{video_id}|{owner}|{expiry}|{signature}"}])
                telegram_call(self.payload["botToken"], "editMessageText", json_payload={
                    "chat_id": self.payload["chatId"], "message_id": self.payload["statusMessageId"],
                    "text": "\n\n".join(lines), "reply_markup": {"inline_keyboard": buttons},
                    "link_preview_options": {"is_disabled": True}}, timeout=30)
                with self.lock:
                    self.state = "sent"
                return {"ok": True, "parts": 0}
            if self.source.get("social"):
                return self.send_social()
            notes = {"user": "ضبط با درخواست شما متوقف شد.", "time_limit": "ضبط به سقف زمانی رسید.", "size_limit": "ضبط به سقف حجم رسید.", "interrupted": "ارتباط پخش قطع شد؛ بخش دریافت‌شده ارسال شد."}
            caption = str(self.source.get("title") or "Instagram Live")[:180]
            if self.source.get("recognizedTitle"):
                caption = f"🎵 {self.source['recognizedTitle']}\n👤 {self.source['recognizedArtist']}"
            caption += "\n" + ("Music" if self.source.get("musicQuery") or self.source.get("musicVideoId") else "Instagram Audio" if self.audio_only else "Live Recording" if self.live else "Live Replay")
            if self.source.get("musicUrl"):
                caption += "\n" + self.source["musicUrl"]
            if self.live and self.reason in notes:
                caption += "\n" + notes[self.reason]
            data = {"chat_id": str(self.payload["chatId"]), "caption": caption,
                    "reply_parameters": json.dumps({"message_id": self.payload["requestMessageId"]}), **self.video}
            self.safe_status("📤 دارم فایل صوتی را کامل در تلگرام ارسال می‌کنم…" if self.audio_only else "📤 دارم فایل ویدیو را کامل در تلگرام ارسال می‌کنم…")
            with self.path.open("rb") as handle:
                method = "sendAudio" if self.audio_only else "sendVideo"
                mime = "audio/mpeg" if self.path.suffix == ".mp3" else "audio/mp4" if self.audio_only else "video/mp4"
                uploading = True
                sent = asyncio.run(asyncio.wait_for(upload_complete_file(self.payload["botToken"], method, data, (self.path.name, handle, mime)), timeout=25 * 60))
                uploading = False
            store_uploaded_file(self.payload, [self.payload.get("mediaCacheKey"), self.source.get("musicFileKey"),
                music_query_key(self.source["musicQuery"], recognition=bool(self.source.get("recognition") or self.source.get("recognizeMusic"))) if self.source.get("musicQuery") else None], method, data, sent)
            with self.lock:
                self.state = "sent"
            delete_status(self.payload["botToken"], self.payload["chatId"], self.payload["statusMessageId"])
            return {"ok": True, "title": self.source.get("recognizedTitle") or self.source.get("title")}
        except Exception as exc:
            diagnostic = upload_error_diagnostic(exc, self.payload["botToken"])
            retry_safe = (uploading and diagnostic.get("rpcCode") == 420
                          and diagnostic.get("errorCode") in {"FLOOD_WAIT", "SLOWMODE_WAIT"}
                          and type(diagnostic.get("retryAfterSeconds")) is int
                          and not self.cleanup_requested and self.path.is_file())
            if retry_safe:
                # The upload was definitively rejected, not ambiguously delivered.
                # Keep the prepared file and job for the same Workflow to resume.
                with self.lock:
                    self.state = "ready"
                message = "⏳ تلگرام موقتاً ارسال را متوقف کرده؛ فایل آماده محفوظ است و ارسال خودکار ادامه پیدا می‌کند. نیازی به درخواست دوباره نیست."
                self.safe_status(message)
                return {"ok": False, "phase": "upload", "retrySafe": True, "message": message, **diagnostic}
            print(json.dumps({"message": "instagram upload failed", "jobId": self.id, **diagnostic}, ensure_ascii=False), flush=True)
            with self.lock:
                self.state = "failed"
            return {"ok": False, **diagnostic}

    def social_delivery_options(self, item: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        markup = None
        if item["method"] == "sendVideo" and item.get("hasAudio"):
            owner = int(self.payload.get("userId") or self.id.rsplit("-", 1)[-1])
            index = int(item.get("index", 0))
            signature = hmac.new(self.payload["botToken"].encode(),
                f"social-audio:{self.payload['chatId']}:{owner}:{index}:{self.social_url}".encode(), hashlib.sha256).hexdigest()[:16]
            markup = {"inline_keyboard": [[{"text": "🎵 فقط صدا", "callback_data": f"soa|{index}|{owner}|{signature}"}]]}
        data = {"chat_id": str(self.payload["chatId"]), "caption": item["caption"][:1024],
                "reply_parameters": json.dumps({"message_id": self.payload["requestMessageId"]}), **item["data"]}
        if markup:
            data["reply_markup"] = json.dumps(markup)
        return data, markup

    def download_post_item(self, item: dict[str, Any], path: Path, deadline: float) -> None:
        url = item["url"]
        limit = DIRECT_TELEGRAM_LIMIT if item["kind"] == "video" else 4_800_000
        for _ in range(4):
            instagram_safe_url(url)
            with requests.get(url, headers={"Referer": "https://www.instagram.com/", "Accept-Encoding": "identity"},
                              stream=True, allow_redirects=False, timeout=(15, 30)) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    url = urljoin(url, response.headers.get("location", ""))
                    continue
                if response.status_code != 200:
                    raise UserVisibleError("❌ دریافت فایل اینستاگرام کامل نشد؛ آدرس فایل ممکن است منقضی شده باشد.")
                length = int(response.headers.get("content-length") or 0)
                if length > limit:
                    raise UserVisibleError("❌ حجم فایل از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد.")
                size = 0
                with path.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        size += len(chunk)
                        if size > limit or self.cleanup_requested or time.monotonic() >= deadline:
                            raise UserVisibleError("❌ دریافت فایل کامل نشد یا از سقف ارسال بیشتر است؛ فایل ناقص ارسال نشد.")
                        output.write(chunk)
                if not size or (length and size != length) or (item.get("size") and size != item["size"]):
                    raise UserVisibleError("❌ فایل اینستاگرام ناقص دریافت شد؛ فایل ناقص ارسال نشد.")
                return
        raise UserVisibleError("❌ آدرس فایل اینستاگرام بیش از حد تغییر مسیر داد.")

    def send_instagram_post(self) -> dict[str, Any]:
        post = self.source["instagramPost"]
        source_kind = "s" if post.get("storyId") else "p"
        items = post["media"]
        deadline = time.monotonic() + 25 * 60
        uploading = False
        path = None
        try:
            while self.post_sent < len(items):
                index = self.post_sent
                item = items[index]
                if self.cleanup_requested or time.monotonic() >= deadline:
                    raise UserVisibleError("❌ ارسال پست به سقف زمان رسید.")
                video = item["kind"] == "video"
                method = "sendVideo" if video else "sendPhoto"
                caption = f"Instagram • {index + 1}/{len(items)}" if len(items) > 1 else "Instagram"
                data = {"chat_id": str(self.payload["chatId"]), "caption": caption}
                if index == 0:
                    data["reply_parameters"] = json.dumps({"message_id": self.payload["requestMessageId"], "allow_sending_without_reply": True})
                key = f"ig:{self.payload['userId']}:{post['shortcode']}:{index}:video" if video else None
                markup = {"inline_keyboard": [[
                    {"text": "🎵 فقط صدا", "callback_data": f"iga|{source_kind}|{post['shortcode']}|{index}|{self.payload['userId']}"},
                    {"text": "🔎 پیداکردن آهنگ", "callback_data": f"igm|{source_kind}|{post['shortcode']}|{index}|{self.payload['userId']}"},
                ]]} if video else None
                if key and reuse_cached_file(self.payload, key, caption, reply_markup=markup):
                    self.post_sent += 1
                    continue
                path = self.workdir / f"Instagram-{index}.{'mp4' if video else 'jpg'}"
                if not path.exists():
                    self.safe_status(f"⬇️ در حال دریافت فایل {index + 1}/{len(items)} اینستاگرام…")
                    self.download_post_item(item, path, deadline)
                if video:
                    info = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                                          capture_output=True, text=True, check=True, timeout=45)
                    metadata = json.loads(info.stdout)
                    stream = next((s for s in metadata.get("streams", []) if s.get("codec_type") == "video"), None)
                    duration = float(metadata.get("format", {}).get("duration") or 0)
                    if not stream or duration <= 0:
                        raise UserVisibleError("❌ فایل ویدیوی سالم برای ارسال دریافت نشد.")
                    data.update(width=stream.get("width", item.get("width", 0)), height=stream.get("height", item.get("height", 0)),
                                duration=duration, supports_streaming=True, reply_markup=json.dumps(markup))
                self.safe_status(f"📤 در حال ارسال فایل {index + 1}/{len(items)} اینستاگرام…")
                with path.open("rb") as handle:
                    uploading = True
                    sent = asyncio.run(asyncio.wait_for(upload_complete_file(self.payload["botToken"], method, data,
                        (path.name, handle, "video/mp4" if video else "image/jpeg")), timeout=max(1, deadline - time.monotonic())))
                    uploading = False
                self.post_sent += 1
                if key:
                    store_uploaded_file(self.payload, [key], method, data, sent, file_size=path.stat().st_size)
                path.unlink(missing_ok=True)
            with self.lock:
                self.state = "sent"
            delete_status(self.payload["botToken"], self.payload["chatId"], self.payload["statusMessageId"])
            return {"ok": True, "parts": self.post_sent}
        except Exception as exc:
            diagnostic = upload_error_diagnostic(exc, self.payload["botToken"])
            if (uploading and diagnostic.get("rpcCode") == 420
                    and diagnostic.get("errorCode") in {"FLOOD_WAIT", "SLOWMODE_WAIT"}
                    and type(diagnostic.get("retryAfterSeconds")) is int and not self.cleanup_requested
                    and path is not None and path.is_file()):
                with self.lock:
                    self.state = "ready"
                return {"ok": False, "phase": "upload", "parts": self.post_sent, "retrySafe": True,
                        "message": "⏳ تلگرام ارسال را موقتاً متوقف کرده؛ ارسال فایل خودکار ادامه پیدا می‌کند.", **diagnostic}
            print(json.dumps({"message": "instagram post upload failed", "jobId": self.id, **diagnostic}, ensure_ascii=False), flush=True)
            with self.lock:
                self.state = "failed"
            detail = str(exc) if isinstance(exc, UserVisibleError) else "❌ دریافت یا ارسال پست اینستاگرام کامل نشد."
            return {"ok": False, "parts": self.post_sent,
                    "message": f"{detail}\n{self.post_sent} فایل تأیید شده است؛ پیش از درخواست دوباره چت را بررسی کن."}

    def send_social(self) -> dict[str, Any]:
        # Resolve every item and prepare cache misses before publishing. An
        # explicitly rejected cached ID can be replaced from its fresh metadata;
        # an ambiguous send stops the batch without another publish attempt.
        deadline = time.monotonic() + 25 * 60
        try:
            for item in self.social_items:
                if self.cleanup_requested or time.monotonic() >= deadline:
                    raise UserVisibleError("ارسال به سقف زمان رسید.")
                method = item["method"]
                data, markup = self.social_delivery_options(item)
                cached = item.get("cached")
                reused = cached is not None and reuse_cached_file(self.payload, item["cacheKey"], item["caption"], reply_markup=markup, cached=cached)
                if not reused:
                    if "path" not in item:
                        from youtube_pipeline import social_prepare_entry
                        remaining_size = DIRECT_TELEGRAM_LIMIT - sum(other.get("fileSize", 0) for other in self.social_items if other is not item)
                        if remaining_size <= 0:
                            raise UserVisibleError("❌ مجموع حجم فایل‌های پست از سقف 2 گیگابایت بیشتر است.")
                        social = self.source["social"]
                        item.update(social_prepare_entry(item["entry"], social["platform"], item["directory"], remaining_size, deadline,
                                                         audio_only=bool(social.get("audioOnly"))))
                        item["fileSize"] = item["path"].stat().st_size
                        method = item["method"]
                        data, markup = self.social_delivery_options(item)
                    mime = "image/gif" if item["path"].suffix.lower() == ".gif" else {"sendPhoto": "image/jpeg", "sendDocument": "image/jpeg", "sendAnimation": "image/gif", "sendAudio": "audio/mpeg", "sendVideo": "video/mp4"}[method]
                    self.safe_status(f"📤 در حال ارسال فایل {self.social_sent + 1}/{len(self.social_items)}…")
                    with item["path"].open("rb") as handle:
                        sent = asyncio.run(asyncio.wait_for(upload_complete_file(self.payload["botToken"], method, data,
                            (item["path"].name, handle, mime)), timeout=max(1, deadline - time.monotonic())))
                    if method in {"sendAudio", "sendVideo"}:
                        store_uploaded_file(self.payload, [item["cacheKey"]], method, data, sent,
                                            file_size=item.get("fileSize") or item["path"].stat().st_size,
                                            has_audio=item.get("hasAudio"))
                self.social_sent += 1
                if "path" in item:
                    item["path"].unlink(missing_ok=True)
            with self.lock:
                self.state = "sent"
            delete_status(self.payload["botToken"], self.payload["chatId"], self.payload["statusMessageId"])
            return {"ok": True, "parts": self.social_sent}
        except Exception as exc:
            print(f"social upload failed: {type(exc).__name__}", flush=True)
            with self.lock:
                self.state = "failed"
            # Preserve this message for the Workflow, including confirmed count.
            return {"ok": False, "parts": self.social_sent,
                    "message": f"❌ ارسال کامل نشد؛ {self.social_sent} فایل تأیید شده است. برای جلوگیری از تکرار، ارسال متوقف شد؛ پیش از درخواست دوباره چت را بررسی کن."}

    def cleanup(self) -> None:
        self.cleanup_requested = True
        self.stop("cleanup")
        if self.thread.is_alive() and threading.current_thread() is not self.thread:
            self.thread.join(timeout=20)
        if not self.thread.is_alive():
            shutil.rmtree(self.workdir, ignore_errors=True)
            JOB_CAPACITY.release(self.id)
        self.expiry.cancel()
        if SERVER_IDLE is not None:
            SERVER_IDLE.refresh()


def instagram_action(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    job_id = str(payload.get("id") or "")
    with INSTAGRAM_LOCK:
        job = INSTAGRAM_JOBS.get(job_id)
        if action == "start":
            if job:
                # Workflow start retries reuse the same process and file.
                return {"ok": True}
            if not JOB_CAPACITY.acquire(job_id):
                return {"ok": False, "message": "ظرفیت هم‌زمان این سرور پر است."}
            try:
                job = InstagramCapture(payload)
                INSTAGRAM_JOBS[job_id] = job
                job.expiry.start()
                job.thread.start()
            except Exception:
                INSTAGRAM_JOBS.pop(job_id, None)
                JOB_CAPACITY.release(job_id)
                if job:
                    job.expiry.cancel()
                    shutil.rmtree(job.workdir, ignore_errors=True)
                raise
            return {"ok": True}
    if not job:
        return {"ok": action == "cleanup", "message": "ضبط قبلاً تمام شده یا سرور ری‌استارت شده است."}
    if action == "stop":
        return {"ok": job.stop(), "message": "ضبط تمام شده یا در حال ارسال است."}
    if action == "send":
        with USAGE.scope(job.payload.get("userId")):
            return job.send()
    if action == "cleanup":
        job.cleanup()
        with INSTAGRAM_LOCK:
            if not job.thread.is_alive():
                INSTAGRAM_JOBS.pop(job_id, None)
        return {"ok": True}
    raise ValueError("Invalid Instagram action")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/admin-usage":
            # A stats read is not download activity and must not postpone sleep.
            USAGE.sample()
            with USAGE.lock:
                payload = {"samples": list(USAGE.samples.values())[-250:],
                           "deliveries": list(USAGE.deliveries.values())[-250:]}
            self._send_json(200, payload)
            USAGE.report()
            return
        with server_activity():
            self.handle_get()

    def handle_get(self) -> None:
        if self.path in {"/", "/health", "/ping"}:
            self._send_json(200, {"ok": True, "service": "youtube-yt-dlp-container"})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        with server_activity():
            self.handle_post()

    def handle_post(self) -> None:
        if self.path not in {"/metadata", "/download", "/instagram/start", "/instagram/stop", "/instagram/send", "/instagram/cleanup"}:
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        try:
            content_length = int(self.headers.get("content-length", "0"))
            if content_length <= 0 or content_length > 1_000_000:
                self._send_json(400, {"ok": False, "error": "invalid body"})
                return
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            if self.path.startswith("/instagram/"):
                result = instagram_action(self.path.rsplit("/", 1)[-1], payload)
            else:
                key = str(payload.get("id") or secrets.token_hex(16))
                if not JOB_CAPACITY.acquire(key):
                    self._send_json(429, {"ok": False, "message": "ظرفیت هم‌زمان این سرور پر است."})
                    return
                try:
                    with request_cache(str(payload.get("url") or "")), USAGE.scope(payload.get("userId")):
                        if self.path == "/metadata":
                            url = str(payload.get("url") or "")
                            if not url:
                                self._send_json(400, {"ok": False, "message": "❌ لینک YouTube نامعتبره."})
                                return
                            result = inspect_video(url)
                        else:
                            result = process_job(payload)
                finally:
                    JOB_CAPACITY.release(key)
            self._send_json(200, result)
        except Exception as exc:
            print(f"youtube container request failed: {type(exc).__name__}", flush=True)
            self._send_json(500, {"ok": False, "error": "internal error"})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"youtube-container: {fmt % args}", flush=True)


def serve() -> None:
    global SERVER_IDLE
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    def pending_media() -> bool:
        with INSTAGRAM_LOCK:
            return any(not job.cleanup_requested and job.state not in {"sent", "failed"}
                       for job in INSTAGRAM_JOBS.values())
    SERVER_IDLE = IdleExit(300, pending_media)
    SERVER_IDLE.refresh()
    print(f"youtube downloader listening on :{server.server_port} (pool-five-v1)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    serve()
