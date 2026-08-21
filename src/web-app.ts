import { getContainer } from "@cloudflare/containers";

type WebAppEnv = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};

type MetadataResult = {
  ok: boolean;
  message?: string;
  title?: string;
  videoId?: string;
  qualities?: number[];
  audioAvailable?: boolean;
};

type JobResult = {
  ok: boolean;
  state?: "preparing" | "ready" | "error";
  message?: string;
  fileId?: string;
  fileName?: string;
  mime?: string;
  size?: number;
};

type WatchResult = {
  ok: boolean;
  message?: string;
  streamId?: string;
  title?: string;
  mime?: string;
};

type BrowserSession = { id: string; expires: number };
type BrowserAuth = BrowserSession & { tabId: string };

const COOKIE_NAME = "__Host-vexa_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
const WATCH_TTL_SECONDS = 30 * 60;
const SESSION_ID_RE = /^[a-f0-9]{32}$/;
const TAB_ID_RE = /^[A-Za-z0-9_-]{12,64}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const encoder = new TextEncoder();

function bytesToHex(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}

async function signValue(secret: string, payload: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(secret), payload));
}

function parseCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

function sessionPayload(id: string, expires: number): string {
  return `web-session|${id}|${expires}`;
}

async function createBrowserSession(env: WebAppEnv): Promise<{ session: BrowserSession; cookie: string }> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sig = await signValue(env.BOT_TOKEN, sessionPayload(id, expires));
  const value = `${id}.${expires}.${sig}`;
  return {
    session: { id, expires },
    cookie: `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
  };
}

async function readBrowserSession(request: Request, env: WebAppEnv): Promise<BrowserSession | null> {
  const value = parseCookie(request, COOKIE_NAME);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [id, expiresText, sig] = parts;
  const expires = Number(expiresText);
  const now = Math.floor(Date.now() / 1000);
  if (
    !SESSION_ID_RE.test(id) ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + SESSION_TTL_SECONDS + 60 ||
    !/^[a-f0-9]{64}$/i.test(sig)
  ) {
    return null;
  }
  const expected = await signValue(env.BOT_TOKEN, sessionPayload(id, expires));
  return constantTimeEqual(expected.toLowerCase(), sig.toLowerCase()) ? { id, expires } : null;
}

function sameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  return request.headers.get("x-vexa-app") === "web";
}

async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 32_768) return null;
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function authenticateBrowser(
  request: Request,
  env: WebAppEnv,
  body: Record<string, unknown>,
): Promise<BrowserAuth | null> {
  if (!sameOriginRequest(request)) return null;
  const session = await readBrowserSession(request, env);
  const tabId = String(body.tabId || "");
  return session && TAB_ID_RE.test(tabId) ? { ...session, tabId } : null;
}

function containerId(auth: BrowserAuth): string {
  return `web-${auth.id.slice(0, 16)}-${auth.tabId.slice(0, 32)}`;
}

function youtubeUrlFromInput(value: string): string | null {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const parsed = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const isYoutube =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");
      if (isYoutube && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
        return parsed.toString();
      }
    } catch {
      // Continue scanning URLs in the input.
    }
  }
  return null;
}

function downloadSignaturePayload(
  sessionId: string,
  tabId: string,
  fileId: string,
  expires: number,
): string {
  return `web-download|${sessionId}|${tabId}|${fileId}|${expires}`;
}

function watchSignaturePayload(
  sessionId: string,
  tabId: string,
  streamId: string,
  expires: number,
): string {
  return `web-watch|${sessionId}|${tabId}|${streamId}|${expires}`;
}

function makeDownloadUrl(
  request: Request,
  auth: BrowserAuth,
  fileId: string,
  expires: number,
  sig: string,
): string {
  const url = new URL("/web/file", request.url);
  url.searchParams.set("sid", auth.id);
  url.searchParams.set("tab", auth.tabId);
  url.searchParams.set("f", fileId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}

function makeWatchUrl(
  request: Request,
  auth: BrowserAuth,
  streamId: string,
  expires: number,
  sig: string,
): string {
  const url = new URL("/web/stream", request.url);
  url.searchParams.set("sid", auth.id);
  url.searchParams.set("tab", auth.tabId);
  url.searchParams.set("w", streamId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}

async function handleMetadata(request: Request, env: WebAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticateBrowser(request, env, body);
  if (!auth) return json({ ok: false, message: "Your browser session expired. Reload the page." }, 401);
  const source = youtubeUrlFromInput(String(body.url || ""));
  if (!source) return json({ ok: false, message: "Paste a valid YouTube link." }, 400);

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(auth));
  const response = await container.fetch(
    new Request("http://container/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: source }),
    }),
  );
  if (!response.ok) return json({ ok: false, message: "Could not read this video." }, 502);
  const metadata = (await response.json()) as MetadataResult;
  if (!metadata.ok || !metadata.videoId) {
    return json({ ok: false, message: metadata.message || "Could not read this video." });
  }
  return json({
    ok: true,
    title: metadata.title || "YouTube video",
    videoId: metadata.videoId,
    qualities: Array.isArray(metadata.qualities)
      ? metadata.qualities.filter((q) => [360, 480, 720, 1080].includes(Number(q)))
      : [],
    audioAvailable: Boolean(metadata.audioAvailable),
  });
}

async function handleStart(request: Request, env: WebAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticateBrowser(request, env, body);
  if (!auth) return json({ ok: false, message: "Your browser session expired. Reload the page." }, 401);

  const videoId = String(body.videoId || "");
  const quality = body.quality == null ? null : Number(body.quality);
  const audioMode = body.audioMode == null ? null : String(body.audioMode);
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This download session is invalid." }, 400);
  const validQuality = quality != null && [360, 480, 720, 1080].includes(quality);
  const validAudio = audioMode === "low" || audioMode === "hq";
  if (validQuality === validAudio) return json({ ok: false, message: "Choose one download format." }, 400);

  const fileId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(auth));
  const response = await container.fetch(
    new Request("http://container/mini/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        fileId,
        quality: validQuality ? quality : undefined,
        audioMode: validAudio ? audioMode : undefined,
      }),
    }),
  );
  const result = (await response.json().catch(() => ({
    ok: false,
    message: "Could not start this download.",
  }))) as JobResult;
  if (!response.ok && response.status !== 202) {
    return json(
      { ok: false, message: result.message || "Could not start this download." },
      response.status === 409 ? 409 : 502,
    );
  }
  return json({ ok: true, state: "preparing", jobId: fileId });
}

async function handleStatus(request: Request, env: WebAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticateBrowser(request, env, body);
  if (!auth) return json({ ok: false, message: "Your browser session expired. Reload the page." }, 401);
  const jobId = String(body.jobId || "");
  if (!FILE_ID_RE.test(jobId)) return json({ ok: false, message: "Invalid download job." }, 400);

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(auth));
  const response = await container.fetch(
    new Request(`http://container/mini/status?fileId=${encodeURIComponent(jobId)}`),
  );
  const result = (await response.json().catch(() => ({
    ok: false,
    state: "error",
    message: "Could not check this download.",
  }))) as JobResult;
  if (!result.ok || result.state === "error") {
    return json({ ok: false, state: "error", message: result.message || "Could not prepare this file." });
  }
  if (result.state !== "ready" || !result.fileId || !result.fileName) {
    return json({ ok: true, state: "preparing" });
  }

  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const sig = await signValue(
    env.BOT_TOKEN,
    downloadSignaturePayload(auth.id, auth.tabId, result.fileId, expires),
  );
  return json({
    ok: true,
    state: "ready",
    fileName: result.fileName,
    size: Number(result.size || 0),
    mime: result.mime || "application/octet-stream",
    downloadUrl: makeDownloadUrl(request, auth, result.fileId, expires, sig),
  });
}

async function handleWatchStart(request: Request, env: WebAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticateBrowser(request, env, body);
  if (!auth) return json({ ok: false, message: "Your browser session expired. Reload the page." }, 401);
  const videoId = String(body.videoId || "");
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This watch session is invalid." }, 400);

  const streamId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(auth));
  const response = await container.fetch(
    new Request("http://container/mini/watch/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, streamId }),
    }),
  );
  const result = (await response.json().catch(() => ({
    ok: false,
    message: "Could not open this stream.",
  }))) as WatchResult;
  if (!response.ok || !result.ok || !result.streamId) {
    return json(
      { ok: false, message: result.message || "Could not open this stream." },
      response.status >= 500 ? 502 : 200,
    );
  }

  const expires = Math.floor(Date.now() / 1000) + WATCH_TTL_SECONDS;
  const sig = await signValue(
    env.BOT_TOKEN,
    watchSignaturePayload(auth.id, auth.tabId, result.streamId, expires),
  );
  return json({
    ok: true,
    title: result.title || "YouTube video",
    mime: result.mime || "video/mp4",
    streamUrl: makeWatchUrl(request, auth, result.streamId, expires, sig),
  });
}

async function validateSignedMediaRequest(
  request: Request,
  env: WebAppEnv,
  kind: "download" | "watch",
): Promise<{ auth: BrowserAuth; mediaId: string } | null> {
  const session = await readBrowserSession(request, env);
  if (!session) return null;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sid") || "";
  const tabId = url.searchParams.get("tab") || "";
  const mediaId = url.searchParams.get(kind === "download" ? "f" : "w") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  const ttl = kind === "download" ? DOWNLOAD_TTL_SECONDS : WATCH_TTL_SECONDS;
  if (
    session.id !== sessionId ||
    !SESSION_ID_RE.test(sessionId) ||
    !TAB_ID_RE.test(tabId) ||
    !FILE_ID_RE.test(mediaId) ||
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + ttl + 60 ||
    !/^[a-f0-9]{64}$/i.test(sig)
  ) {
    return null;
  }
  const payload =
    kind === "download"
      ? downloadSignaturePayload(sessionId, tabId, mediaId, expires)
      : watchSignaturePayload(sessionId, tabId, mediaId, expires);
  const expected = await signValue(env.BOT_TOKEN, payload);
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) return null;
  return { auth: { ...session, tabId }, mediaId };
}

async function handleFile(request: Request, env: WebAppEnv): Promise<Response> {
  const verified = await validateSignedMediaRequest(request, env, "download");
  if (!verified) return new Response("Download link expired or invalid.", { status: 403 });
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(verified.auth));
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const source = await container.fetch(
    new Request(`http://container/mini/file?fileId=${encodeURIComponent(verified.mediaId)}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    }),
  );
  if (!source.ok && source.status !== 206) {
    return new Response("File is no longer available. Prepare it again.", { status: 404 });
  }
  const outgoing = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "content-disposition",
  ]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, {
    status: source.status,
    headers: outgoing,
  });
}

async function handleWatchStream(request: Request, env: WebAppEnv): Promise<Response> {
  const verified = await validateSignedMediaRequest(request, env, "watch");
  if (!verified) return new Response("Stream link expired or invalid.", { status: 403 });
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(verified.auth));
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers.set("if-range", ifRange);
  const source = await container.fetch(
    new Request(`http://container/mini/watch?streamId=${encodeURIComponent(verified.mediaId)}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    }),
  );
  if (!source.ok && source.status !== 206) {
    return new Response("Stream is no longer available.", { status: 404 });
  }
  const outgoing = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, {
    status: source.status,
    headers: outgoing,
  });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#050505">
<meta name="description" content="Watch YouTube videos online or prepare a direct download in a clean browser-based player.">
<meta name="robots" content="index,follow">
<title>Video Downloader</title>
<style>
:root{color-scheme:dark;--bg:#050505;--surface:#0a0a0a;--surface2:#0e0e0e;--text:#f5f5f5;--muted:#8b8b8b;--dim:#5f5f5f;--line:#232323;--soft:#151515;--white:#f4f4f4;--black:#060606;--radius:24px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:var(--bg);scroll-behavior:smooth}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,ui-sans-serif,system-ui,sans-serif;overflow-x:hidden}
body:before{content:"";position:fixed;z-index:-1;inset:-30%;pointer-events:none;background:radial-gradient(circle at 20% 5%,rgba(255,255,255,.06),transparent 24%),radial-gradient(circle at 84% 34%,rgba(255,255,255,.035),transparent 26%)}
button,input{font:inherit}
button{border:0;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid #fff;outline-offset:3px}
.page{width:min(100%,1220px);margin:0 auto;padding:clamp(22px,4vw,56px) clamp(16px,4vw,48px) max(34px,env(safe-area-inset-bottom))}
.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
.intro{min-width:0}
.kicker{display:inline-flex;align-items:center;gap:8px;margin:0 0 24px;color:#777;font-size:11px;font-weight:650;letter-spacing:.16em;text-transform:uppercase}
.kicker:before{content:"";width:7px;height:7px;border-radius:50%;background:#ececec;box-shadow:0 0 0 5px rgba(255,255,255,.045)}
h1{max-width:760px;margin:0;font-size:clamp(42px,8vw,78px);line-height:.92;letter-spacing:-.058em;font-weight:690}
.sub{max-width:630px;margin:20px 0 28px;color:var(--muted);font-size:clamp(14px,1.8vw,17px);line-height:1.65}
.modeSwitch{position:relative;display:grid;grid-template-columns:1fr 1fr;width:min(100%,420px);height:58px;padding:5px;margin-bottom:18px;border:1px solid var(--line);border-radius:19px;background:#090909;isolation:isolate}
.modeThumb{position:absolute;z-index:0;left:5px;top:5px;width:calc(50% - 5px);height:48px;border-radius:14px;background:var(--white);box-shadow:0 8px 28px rgba(0,0,0,.28);transition:transform .3s cubic-bezier(.22,.85,.28,1)}
.modeSwitch.watch .modeThumb{transform:translateX(100%)}
.modeButton{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;min-width:0;background:transparent;color:#666;font-size:13px;font-weight:700;transition:color .2s,transform .16s}
.modeButton.active{color:#080808}.modeButton:active{transform:scale(.98)}.modeButton svg{width:19px;height:19px;stroke-width:2.15}
.inputShell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:8px;border:1px solid var(--line);border-radius:21px;background:rgba(10,10,10,.92);transition:border-color .2s,transform .2s,box-shadow .2s}
.inputShell:focus-within{border-color:#3b3b3b;transform:translateY(-1px);box-shadow:0 15px 50px rgba(0,0,0,.22)}
.linkIcon{width:42px;height:42px;border-radius:14px;background:#111;display:grid;place-items:center;color:#aaa;font-size:18px}
.url{min-width:0;width:100%;border:0;outline:0;background:transparent;color:#fff;padding:11px 0;font-size:15px}
.url::placeholder{color:#555}
.go{height:46px;padding:0 18px;border-radius:15px;background:#fff;color:#050505;font-weight:720;transition:transform .16s,opacity .16s}.go:active{transform:scale(.975)}.go:disabled{opacity:.38;cursor:default}
.message{min-height:22px;margin:11px 4px 0;color:#777;font-size:13px;line-height:1.45}.message:empty{min-height:0;margin-top:0}.message.error{color:#e7e7e7}
.workspace{min-width:0;border:1px solid var(--line);border-radius:28px;background:linear-gradient(180deg,rgba(14,14,14,.96),rgba(8,8,8,.96));overflow:hidden;box-shadow:0 28px 90px rgba(0,0,0,.28)}
.empty{display:grid;place-items:center;min-height:320px;padding:34px;text-align:center;color:#555}.emptyInner{max-width:270px}.emptyIcon{width:54px;height:54px;margin:0 auto 16px;border:1px solid #252525;border-radius:18px;display:grid;place-items:center;color:#777}.emptyIcon svg{width:24px;height:24px;stroke-width:1.7}.emptyTitle{color:#aaa;font-size:14px;font-weight:640}.emptyText{margin-top:7px;font-size:12px;line-height:1.55}
.result,.progress,.ready,.playerCard{display:none}.result.show,.progress.show,.ready.show,.playerCard.show{display:block}
.resultHead{padding:22px 24px 18px;border-bottom:1px solid var(--line)}.eyebrow{color:#666;font-size:10px;font-weight:650;letter-spacing:.16em;margin-bottom:9px}.videoTitle{font-size:17px;line-height:1.4;font-weight:620;overflow-wrap:anywhere}
.resultBody{padding:21px 24px 24px}.label{margin-bottom:12px;color:#777;font-size:12px}.formats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.format{text-align:left;padding:14px;border:1px solid #222;border-radius:16px;background:#0d0d0d;color:#ddd;transition:background .18s,border-color .18s,transform .16s}.format:active{transform:scale(.985)}.format.selected{background:#f1f1f1;color:#080808;border-color:#ededed}.formatName{display:block;font-size:14px;font-weight:670}.formatDesc{display:block;margin-top:4px;color:#666;font-size:11px}.format.selected .formatDesc{color:#555}
.primary,.save{width:100%;min-height:52px;margin-top:16px;border-radius:16px;background:#fff;color:#050505;font-weight:720;transition:transform .16s,opacity .16s}.primary:active,.save:active{transform:scale(.98)}.primary:disabled{opacity:.35;cursor:default}
.progress,.ready{padding:26px}.statusRow{display:flex;align-items:center;gap:15px}.orb{position:relative;width:42px;height:42px;border:1px solid #262626;border-radius:50%;flex:0 0 auto}.orb:before{content:"";position:absolute;inset:5px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;animation:spin .85s linear infinite}.statusTitle{font-size:15px;font-weight:650}.statusSub{margin-top:5px;color:#6c6c6c;font-size:12px;line-height:1.45}.rail{height:2px;margin-top:21px;background:#171717;overflow:hidden}.rail:after{content:"";display:block;width:36%;height:100%;background:#eee;animation:scan 1.25s ease-in-out infinite}
.readyIcon{width:44px;height:44px;border-radius:50%;background:#fff;color:#050505;display:grid;place-items:center;font-size:20px;font-weight:800}.readyText{min-width:0;flex:1}.readyMeta{margin-top:5px;color:#707070;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.playerCard{padding:12px}.playerShell{position:relative;width:100%;aspect-ratio:16/9;border-radius:20px;overflow:hidden;background:#000;border:1px solid #1f1f1f;box-shadow:0 16px 50px rgba(0,0,0,.3);touch-action:manipulation}.playerShell video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}.playerShade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 46%,rgba(0,0,0,.68));pointer-events:none}.playerCenter{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:62px;height:62px;border-radius:50%;display:grid;place-items:center;background:rgba(7,7,7,.66);color:#fff;border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(12px);transition:opacity .2s,transform .16s}.playerCenter:active{transform:translate(-50%,-50%) scale(.95)}.playerCenter svg{width:29px;height:29px;stroke-width:2}.playerShell.playing .playerCenter{opacity:0;pointer-events:none}.playerLoading{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px;border:2px solid rgba(255,255,255,.14);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;opacity:0;pointer-events:none}.playerShell.loading .playerLoading{opacity:1}.playerShell.loading .playerCenter{opacity:0}.playerControls{position:absolute;left:0;right:0;bottom:0;padding:32px 14px 13px;background:linear-gradient(to top,rgba(0,0,0,.84),rgba(0,0,0,.24),transparent);transition:opacity .2s,transform .2s}.playerShell.controlsHidden .playerControls{opacity:0;transform:translateY(8px);pointer-events:none}.seekWrap{position:relative;height:18px;display:flex;align-items:center}.seekBase{position:absolute;left:2px;right:2px;height:4px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden}.bufferedBar,.playedBar{position:absolute;inset:0 auto 0 0;width:0;border-radius:99px}.bufferedBar{background:rgba(255,255,255,.22)}.playedBar{background:#fff}.seek{position:relative;width:100%;height:18px;margin:0;appearance:none;-webkit-appearance:none;background:transparent}.seek::-webkit-slider-runnable-track{height:4px;background:transparent}.seek::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.4)}.seek::-moz-range-track{height:4px;background:transparent}.seek::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff}.controlRow{display:flex;align-items:center;gap:4px;margin-top:5px}.controlButton{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:transparent;color:#fff;transition:background .16s,transform .16s}.controlButton:active{transform:scale(.93);background:rgba(255,255,255,.08)}.controlButton svg{width:21px;height:21px;stroke-width:2}.skipButton svg{width:22px;height:22px}.playerTime{margin-left:2px;color:#d5d5d5;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.controlSpacer{flex:1}.watchMeta{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:13px 4px 3px}.watchTitle{font-size:14px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.watchBadge{flex:0 0 auto;padding:5px 8px;border-radius:99px;background:#eee;color:#080808;font-size:10px;font-weight:700;letter-spacing:.07em}
.playerShell:fullscreen{border:0;border-radius:0}.playerShell:fullscreen .playerControls{padding-bottom:max(14px,env(safe-area-inset-bottom))}
.note{margin-top:18px;color:#4c4c4c;font-size:11px;line-height:1.55}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(390%)}}
@media (min-width:44rem){.page{padding-top:clamp(30px,5vw,58px)}.formats{grid-template-columns:repeat(3,minmax(0,1fr))}.empty{min-height:390px}.resultHead{padding:24px 28px 20px}.resultBody{padding:22px 28px 28px}.playerCard{padding:14px}.playerShell{border-radius:22px}}
@media (min-width:56rem){.layout{grid-template-columns:minmax(300px,.82fr) minmax(440px,1.18fr);gap:clamp(28px,4vw,54px);align-items:start}.intro{padding-top:clamp(8px,3vw,34px)}.workspace{position:sticky;top:clamp(22px,4vw,48px)}.empty{min-height:min(64vh,590px)}.formats{grid-template-columns:repeat(2,minmax(0,1fr))}.playerCard{padding:16px}.playerShell{max-height:68vh}.note{max-width:520px}}
@media (min-width:74rem){.layout{grid-template-columns:minmax(360px,.78fr) minmax(560px,1.22fr)}.workspace{border-radius:30px}.empty{min-height:600px}.resultHead{padding:28px 32px 22px}.resultBody{padding:24px 32px 32px}.playerCard{padding:18px}.playerShell{border-radius:24px}}
@media (max-width:29rem){.page{padding-left:13px;padding-right:13px}.inputShell{grid-template-columns:auto minmax(0,1fr);gap:8px}.go{grid-column:1/-1;width:100%}.modeSwitch{height:56px}.modeThumb{height:46px}.formats{grid-template-columns:repeat(2,minmax(0,1fr))}.controlButton{width:35px;height:36px}.skipButton{display:none}.playerTime{font-size:10px}.playerCard{padding:8px}}
@media (any-pointer:coarse){.modeButton,.go,.primary,.save,.format,.controlButton{min-height:48px}.controlButton{width:48px}.inputShell{padding:7px}.url{min-height:48px}.seekWrap,.seek{height:24px}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style>
</head>
<body>
<main class="page">
  <div class="layout">
    <section class="intro" aria-labelledby="mainTitle">
      <div class="kicker">Browser app</div>
      <h1 id="mainTitle">Paste.<br>Pick. Play.</h1>
      <p id="sub" class="sub">Paste a YouTube link, choose whether to download it or watch it online, and stay inside the same app.</p>

      <div id="modeSwitch" class="modeSwitch" role="tablist" aria-label="Choose action">
        <span class="modeThumb" aria-hidden="true"></span>
        <button id="modeDownload" class="modeButton active" type="button" role="tab" aria-selected="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download
        </button>
        <button id="modeWatch" class="modeButton" type="button" role="tab" aria-selected="false">
          <svg viewBox="0 0 24 24" fill="none"><path d="m9 7 8 5-8 5V7Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Watch online
        </button>
      </div>

      <div class="inputShell">
        <div class="linkIcon" aria-hidden="true">↗</div>
        <input id="url" class="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste YouTube link" aria-label="YouTube link">
        <button id="analyze" class="go" type="button">Analyze</button>
      </div>
      <div id="message" class="message" aria-live="polite"></div>
      <p class="note">Runs directly in your browser. Telegram is optional, not required.</p>
    </section>

    <section id="workspace" class="workspace" aria-live="polite">
      <div id="empty" class="empty">
        <div class="emptyInner">
          <div class="emptyIcon"><svg viewBox="0 0 24 24" fill="none"><path d="M8 6h8M6 10h12M8 14h8M10 18h4" stroke="currentColor" stroke-linecap="round"/></svg></div>
          <div class="emptyTitle">Ready when you are</div>
          <div id="emptyText" class="emptyText">Paste a link to see formats or open the in-app player.</div>
        </div>
      </div>

      <div id="result" class="result">
        <div class="resultHead"><div class="eyebrow">YOUTUBE</div><div id="videoTitle" class="videoTitle"></div></div>
        <div class="resultBody"><div class="label">Choose format</div><div id="formats" class="formats"></div><button id="prepare" class="primary" type="button" disabled>Prepare download</button></div>
      </div>

      <div id="playerCard" class="playerCard">
        <div id="playerShell" class="playerShell">
          <video id="video" playsinline preload="metadata"></video>
          <div class="playerShade"></div>
          <div class="playerLoading"></div>
          <button id="centerPlay" class="playerCenter" type="button" aria-label="Play">
            <svg id="centerPlayIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="playerControls">
            <div class="seekWrap"><div class="seekBase"><div id="bufferedBar" class="bufferedBar"></div><div id="playedBar" class="playedBar"></div></div><input id="seek" class="seek" type="range" min="0" max="100" value="0" step="0.05" aria-label="Seek video"></div>
            <div class="controlRow">
              <button id="playPause" class="controlButton" type="button" aria-label="Play or pause"><svg id="playIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <button id="back10" class="controlButton skipButton" type="button" aria-label="Back 10 seconds"><svg viewBox="0 0 24 24" fill="none"><path d="M8 8H4V4M4.5 8.5A8 8 0 1 1 4 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <button id="forward10" class="controlButton skipButton" type="button" aria-label="Forward 10 seconds"><svg viewBox="0 0 24 24" fill="none"><path d="M16 8h4V4m-.5 4.5A8 8 0 1 0 20 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <div id="playerTime" class="playerTime">0:00 / 0:00</div><div class="controlSpacer"></div>
              <button id="mute" class="controlButton" type="button" aria-label="Mute or unmute"><svg id="muteIcon" viewBox="0 0 24 24" fill="none"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <button id="fullscreen" class="controlButton" type="button" aria-label="Fullscreen"><svg viewBox="0 0 24 24" fill="none"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4m12 4h4v-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
        </div>
        <div class="watchMeta"><div id="watchTitle" class="watchTitle"></div><span class="watchBadge">ONLINE</span></div>
      </div>

      <div id="progress" class="progress"><div class="statusRow"><div class="orb"></div><div><div class="statusTitle">Preparing your file</div><div id="progressSub" class="statusSub">Starting download…</div></div></div><div class="rail"></div></div>
      <div id="ready" class="ready"><div class="statusRow"><div class="readyIcon">↓</div><div class="readyText"><div class="statusTitle">Ready to save</div><div id="readyMeta" class="readyMeta"></div></div></div><button id="save" class="save" type="button">Download file</button></div>
    </section>
  </div>
</main>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var mode='download',current=null,selected=null,prepared=null,pollToken=0,controlsTimer=null;
var tabId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));
var modeSwitch=$('modeSwitch'),modeDownload=$('modeDownload'),modeWatch=$('modeWatch'),sub=$('sub'),url=$('url'),analyze=$('analyze'),message=$('message'),empty=$('empty'),emptyText=$('emptyText'),result=$('result'),videoTitle=$('videoTitle'),formats=$('formats'),prepare=$('prepare'),progress=$('progress'),progressSub=$('progressSub'),ready=$('ready'),readyMeta=$('readyMeta'),save=$('save'),playerCard=$('playerCard'),playerShell=$('playerShell'),video=$('video'),centerPlay=$('centerPlay'),centerPlayIcon=$('centerPlayIcon'),playPause=$('playPause'),playIcon=$('playIcon'),back10=$('back10'),forward10=$('forward10'),seek=$('seek'),bufferedBar=$('bufferedBar'),playedBar=$('playedBar'),playerTime=$('playerTime'),mute=$('mute'),muteIcon=$('muteIcon'),fullscreen=$('fullscreen'),watchTitle=$('watchTitle');
function msg(text,error){message.textContent=text||'';message.classList.toggle('error',!!error)}
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
function size(bytes){if(!bytes)return'File ready';var units=['B','KB','MB','GB'],i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3),value=bytes/Math.pow(1024,i);return(value>=100||i===0?Math.round(value):value.toFixed(1))+' '+units[i]}
function showOnly(name){empty.style.display=name==='empty'?'grid':'none';result.classList.toggle('show',name==='result');playerCard.classList.toggle('show',name==='player');progress.classList.toggle('show',name==='progress');ready.classList.toggle('show',name==='ready')}
async function api(path,body){body=Object.assign({},body,{tabId:tabId});var response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-vexa-app':'web'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(response.status===401)data.message='Your browser session expired. Reload the page.';if(!response.ok)data.ok=false;return data}
function iconPlay(){return '<path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'}
function iconPause(){return '<path d="M9 7v10M15 7v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'}
function syncPlayIcons(){var html=video.paused?iconPlay():iconPause();playIcon.innerHTML=html;centerPlayIcon.innerHTML=html;playerShell.classList.toggle('playing',!video.paused)}
function syncMuteIcon(){muteIcon.innerHTML=video.muted?'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="m17 9 4 6m0-6-4 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>':'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/>'}
function fmtTime(value){if(!isFinite(value)||value<0)return'0:00';var total=Math.floor(value),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;return hours>0?hours+':'+String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0'):minutes+':'+String(seconds).padStart(2,'0')}
function updateTimeline(){var duration=video.duration||0,currentTime=video.currentTime||0,percent=duration?Math.max(0,Math.min(100,currentTime/duration*100)):0;seek.value=String(percent);playedBar.style.width=percent+'%';playerTime.textContent=fmtTime(currentTime)+' / '+fmtTime(duration);if(video.buffered&&video.buffered.length&&duration){try{bufferedBar.style.width=Math.min(100,video.buffered.end(video.buffered.length-1)/duration*100)+'%'}catch(e){}}}
function showControls(){playerShell.classList.remove('controlsHidden');if(controlsTimer)clearTimeout(controlsTimer);if(!video.paused)controlsTimer=setTimeout(function(){playerShell.classList.add('controlsHidden')},2400)}
function setLoading(on){playerShell.classList.toggle('loading',!!on)}
function resetPlayer(){if(controlsTimer)clearTimeout(controlsTimer);video.pause();video.removeAttribute('src');video.load();playerShell.classList.remove('playing','loading','controlsHidden');seek.value='0';playedBar.style.width='0%';bufferedBar.style.width='0%';playerTime.textContent='0:00 / 0:00';syncPlayIcons()}
function setMode(next){if(next===mode)return;mode=next;pollToken++;current=null;selected=null;prepared=null;resetPlayer();showOnly('empty');modeSwitch.classList.toggle('watch',mode==='watch');modeDownload.classList.toggle('active',mode==='download');modeWatch.classList.toggle('active',mode==='watch');modeDownload.setAttribute('aria-selected',mode==='download'?'true':'false');modeWatch.setAttribute('aria-selected',mode==='watch'?'true':'false');if(mode==='watch'){sub.textContent='Paste a YouTube link and watch it online in the built-in player.';analyze.textContent='Watch';emptyText.textContent='Paste a link to open the in-app player.'}else{sub.textContent='Paste a YouTube link, choose the quality you want, and download it directly in your browser.';analyze.textContent='Analyze';emptyText.textContent='Paste a link to see the available download formats.'}msg('')}
function choose(value,button){selected=value;formats.querySelectorAll('.format').forEach(function(item){item.classList.remove('selected')});button.classList.add('selected');prepare.disabled=false;prepared=null}
function addFormat(name,desc,value){var button=document.createElement('button');button.type='button';button.className='format';button.innerHTML='<span class="formatName"></span><span class="formatDesc"></span>';button.querySelector('.formatName').textContent=name;button.querySelector('.formatDesc').textContent=desc;button.addEventListener('click',function(){choose(value,button)});formats.appendChild(button);return button}
function renderFormats(data){formats.textContent='';selected=null;var preferred=null;(data.qualities||[]).forEach(function(q){var b=addFormat(q+'p',q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD',{quality:q});if(q===720)preferred=b});if(data.audioAvailable){addFormat('Audio Lite','Smaller M4A',{audioMode:'low'});addFormat('Audio HQ','Best M4A',{audioMode:'hq'})}if(!preferred)preferred=formats.querySelector('.format');if(preferred)preferred.click()}
async function openWatch(data){msg('Opening stream…');var watch=await api('/web/api/watch',{videoId:data.videoId});if(!watch.ok||!watch.streamUrl)throw new Error(watch.message||'Could not open this stream.');watchTitle.textContent=watch.title||data.title||'YouTube video';showOnly('player');setLoading(true);video.src=watch.streamUrl;video.load();showControls();msg('')}
async function analyzeLink(){var value=url.value.trim();if(!value)return msg('Paste a YouTube link first.',true);pollToken++;analyze.disabled=true;prepared=null;resetPlayer();msg('Reading video…');try{var data=await api('/web/api/metadata',{url:value});if(!data.ok)throw new Error(data.message||'Could not read this video.');current=data;if(mode==='watch'){await openWatch(data)}else{videoTitle.textContent=data.title||'YouTube video';renderFormats(data);showOnly('result');msg('Choose a format below.')}}catch(error){showOnly('empty');msg(error.message||'Could not read this video.',true)}finally{analyze.disabled=false}}
async function poll(jobId,token){var started=Date.now();while(token===pollToken){await wait(1500);var data=await api('/web/api/status',{jobId:jobId});if(token!==pollToken)return;if(data.ok&&data.state==='ready'){prepared=data;readyMeta.textContent=size(data.size)+' · '+data.fileName;showOnly('ready');msg('Your file is ready.');analyze.disabled=false;return}if(!data.ok||data.state==='error')throw new Error(data.message||'Could not prepare this file.');var seconds=Math.round((Date.now()-started)/1000);progressSub.textContent=seconds>45?'Still preparing — large videos can take a few minutes. Keep this page open.':'Downloading and packaging the selected quality…';if(seconds>1800)throw new Error('This download took too long. Please try again.')}}
async function prepareFile(){if(!current||!selected||mode!=='download')return;var token=++pollToken;prepare.disabled=true;analyze.disabled=true;progressSub.textContent='Starting download…';showOnly('progress');msg('');try{var body={videoId:current.videoId};if(selected.quality)body.quality=selected.quality;else body.audioMode=selected.audioMode;var data=await api('/web/api/start',body);if(!data.ok||!data.jobId)throw new Error(data.message||'Could not start this download.');await poll(data.jobId,token)}catch(error){if(token===pollToken){showOnly('result');prepare.disabled=false;analyze.disabled=false;msg(error.message||'Could not prepare this file.',true)}}}
function saveFile(){if(!prepared||!prepared.downloadUrl)return;var anchor=document.createElement('a');anchor.href=prepared.downloadUrl;anchor.download=prepared.fileName||'';anchor.rel='noopener';document.body.appendChild(anchor);anchor.click();anchor.remove();msg('Download started.')}
function togglePlay(){if(!video.src)return;if(video.paused){var promise=video.play();if(promise&&promise.catch)promise.catch(function(){msg('Tap play again to start the video.',true)})}else video.pause();showControls()}
async function toggleFullscreen(){showControls();if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen();return}catch(e){}}if(playerShell.requestFullscreen){try{await playerShell.requestFullscreen();return}catch(e){}}if(video.webkitEnterFullscreen){try{video.webkitEnterFullscreen()}catch(e){}}}
modeDownload.addEventListener('click',function(){setMode('download')});modeWatch.addEventListener('click',function(){setMode('watch')});analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);url.addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();analyzeLink()}});url.addEventListener('input',function(){pollToken++;prepared=null;resetPlayer();showOnly('empty');msg('')});centerPlay.addEventListener('click',function(event){event.stopPropagation();togglePlay()});playPause.addEventListener('click',function(event){event.stopPropagation();togglePlay()});back10.addEventListener('click',function(event){event.stopPropagation();video.currentTime=Math.max(0,(video.currentTime||0)-10);showControls()});forward10.addEventListener('click',function(event){event.stopPropagation();video.currentTime=Math.min(video.duration||Infinity,(video.currentTime||0)+10);showControls()});seek.addEventListener('input',function(event){event.stopPropagation();if(video.duration)video.currentTime=(Number(seek.value)/100)*video.duration;updateTimeline();showControls()});mute.addEventListener('click',function(event){event.stopPropagation();video.muted=!video.muted;syncMuteIcon();showControls()});fullscreen.addEventListener('click',function(event){event.stopPropagation();toggleFullscreen()});video.addEventListener('click',togglePlay);playerShell.addEventListener('mousemove',showControls);playerShell.addEventListener('touchstart',showControls,{passive:true});video.addEventListener('play',function(){syncPlayIcons();setLoading(false);showControls()});video.addEventListener('pause',function(){syncPlayIcons();showControls()});video.addEventListener('ended',function(){syncPlayIcons();showControls()});video.addEventListener('timeupdate',updateTimeline);video.addEventListener('progress',updateTimeline);video.addEventListener('durationchange',updateTimeline);video.addEventListener('loadedmetadata',function(){setLoading(false);updateTimeline();showControls()});video.addEventListener('canplay',function(){setLoading(false)});video.addEventListener('waiting',function(){setLoading(true)});video.addEventListener('stalled',function(){setLoading(true)});video.addEventListener('playing',function(){setLoading(false)});video.addEventListener('error',function(){setLoading(false);msg('This stream stopped. Press Watch to reconnect.',true);showControls()});document.addEventListener('fullscreenchange',showControls);syncPlayIcons();syncMuteIcon();showOnly('empty');
})();
</script>
</body>
</html>`;

function htmlHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "fullscreen=(self)",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'",
  });
}

async function handleHtml(request: Request, env: WebAppEnv): Promise<Response> {
  let session = await readBrowserSession(request, env);
  let cookie: string | null = null;
  if (!session) {
    const created = await createBrowserSession(env);
    session = created.session;
    cookie = created.cookie;
  }
  const headers = htmlHeaders();
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(request.method === "HEAD" ? null : HTML, { headers });
}

export async function handleWebAppRequest(
  request: Request,
  env: WebAppEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if ((url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") && (request.method === "GET" || request.method === "HEAD")) {
    return handleHtml(request, env);
  }
  if (url.pathname === "/robots.txt" && request.method === "GET") {
    return new Response("User-agent: *\nAllow: /\nDisallow: /web/\n", {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }
  if (url.pathname === "/web/api/metadata" && request.method === "POST") return handleMetadata(request, env);
  if (url.pathname === "/web/api/start" && request.method === "POST") return handleStart(request, env);
  if (url.pathname === "/web/api/status" && request.method === "POST") return handleStatus(request, env);
  if (url.pathname === "/web/api/watch" && request.method === "POST") return handleWatchStart(request, env);
  if (url.pathname === "/web/file" && (request.method === "GET" || request.method === "HEAD")) return handleFile(request, env);
  if (url.pathname === "/web/stream" && (request.method === "GET" || request.method === "HEAD")) return handleWatchStream(request, env);
  if (url.pathname.startsWith("/web/")) return new Response("Not found", { status: 404 });
  return null;
}
