import { getContainer } from "@cloudflare/containers";

type MiniAppEnv = { BOT_TOKEN: string; YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any> };
type TelegramIdentity = { userId: number };
type MetadataResult = { ok: boolean; message?: string; title?: string; videoId?: string; qualities?: number[]; audioAvailable?: boolean };
type JobResult = { ok: boolean; state?: "preparing" | "ready" | "error"; message?: string; fileId?: string; fileName?: string; mime?: string; size?: number };
type WatchResult = { ok: boolean; message?: string; streamId?: string; title?: string; mime?: string };

const MINI_APP_PATH = "/mini-app";
const SESSION_RE = /^[A-Za-z0-9_-]{12,64}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
const WATCH_TTL_SECONDS = 30 * 60;
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
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
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
}
async function validateTelegramInitData(initData: string, botToken: string): Promise<TelegramIdentity | null> {
  if (!initData || initData.length > 16_384) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date") || "0");
  if (!/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isSafeInteger(authDate) || authDate <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 300 || now - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const all = [...params.entries()].filter(([k]) => k !== "hash").sort(([a], [b]) => a.localeCompare(b));
  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const compute = async (entries: Array<[string, string]>) => {
    const check = entries.map(([k, v]) => `${k}=${v}`).join("\n");
    return bytesToHex(await hmacSha256(secret, check));
  };
  let expected = await compute(all);
  let valid = constantTimeEqual(expected.toLowerCase(), receivedHash.toLowerCase());
  if (!valid && params.has("signature")) {
    expected = await compute(all.filter(([k]) => k !== "signature"));
    valid = constantTimeEqual(expected.toLowerCase(), receivedHash.toLowerCase());
  }
  if (!valid) return null;
  try {
    const user = JSON.parse(params.get("user") || "{}") as { id?: unknown };
    const userId = Number(user.id);
    return Number.isSafeInteger(userId) && userId > 0 ? { userId } : null;
  } catch { return null; }
}

function miniContainerId(userId: number, sessionId: string): string { return `mini-${userId}-${sessionId}`; }
function youtubeUrlFromInput(value: string): string | null {
  const matches = value.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const parsed = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if ((host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")) && (parsed.protocol === "https:" || parsed.protocol === "http:")) return parsed.toString();
    } catch {}
  }
  return null;
}
async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 32_768) return null;
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
async function signValue(botToken: string, payload: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(botToken), payload));
}
function downloadSignaturePayload(userId: number, sessionId: string, fileId: string, expires: number): string {
  return `${userId}|${sessionId}|${fileId}|${expires}`;
}
function watchSignaturePayload(userId: number, sessionId: string, streamId: string, expires: number): string {
  return `watch|${userId}|${sessionId}|${streamId}|${expires}`;
}
function makeDownloadUrl(request: Request, userId: number, sessionId: string, fileId: string, expires: number, sig: string): string {
  const url = new URL(`${MINI_APP_PATH}/file`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
  url.searchParams.set("f", fileId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}
function makeWatchUrl(request: Request, userId: number, sessionId: string, streamId: string, expires: number, sig: string): string {
  const url = new URL(`${MINI_APP_PATH}/stream`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
  url.searchParams.set("w", streamId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}
async function authenticate(body: Record<string, unknown>, env: MiniAppEnv): Promise<{ identity: TelegramIdentity; sessionId: string } | null> {
  const identity = await validateTelegramInitData(String(body.initData || ""), env.BOT_TOKEN);
  const sessionId = String(body.sessionId || "");
  return identity && SESSION_RE.test(sessionId) ? { identity, sessionId } : null;
}

async function handleMetadata(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request); if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env); if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const source = youtubeUrlFromInput(String(body.url || "")); if (!source) return json({ ok: false, message: "Paste a valid YouTube link." }, 400);
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(auth.identity.userId, auth.sessionId));
  const response = await container.fetch(new Request("http://container/metadata", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: source }) }));
  if (!response.ok) return json({ ok: false, message: "Could not read this video." }, 502);
  const metadata = await response.json() as MetadataResult;
  if (!metadata.ok || !metadata.videoId) return json({ ok: false, message: metadata.message || "Could not read this video." });
  return json({ ok: true, title: metadata.title || "YouTube video", videoId: metadata.videoId, qualities: Array.isArray(metadata.qualities) ? metadata.qualities.filter((q) => [360, 480, 720, 1080].includes(Number(q))) : [], audioAvailable: Boolean(metadata.audioAvailable) });
}

async function handleStart(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request); if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env); if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const videoId = String(body.videoId || ""); const quality = body.quality == null ? null : Number(body.quality); const audioMode = body.audioMode == null ? null : String(body.audioMode);
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This download session is invalid." }, 400);
  const validQuality = quality != null && [360, 480, 720, 1080].includes(quality); const validAudio = audioMode === "low" || audioMode === "hq";
  if (validQuality === validAudio) return json({ ok: false, message: "Choose one download format." }, 400);
  const fileId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(auth.identity.userId, auth.sessionId));
  const response = await container.fetch(new Request("http://container/mini/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, fileId, quality: validQuality ? quality : undefined, audioMode: validAudio ? audioMode : undefined }) }));
  const result = await response.json().catch(() => ({ ok: false, message: "Could not start this download." })) as JobResult;
  if (!response.ok && response.status !== 202) return json({ ok: false, message: result.message || "Could not start this download." }, response.status === 409 ? 409 : 502);
  return json({ ok: true, state: "preparing", jobId: fileId });
}

async function handleStatus(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request); if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env); if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const jobId = String(body.jobId || ""); if (!FILE_ID_RE.test(jobId)) return json({ ok: false, message: "Invalid download job." }, 400);
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(auth.identity.userId, auth.sessionId));
  const response = await container.fetch(new Request(`http://container/mini/status?fileId=${encodeURIComponent(jobId)}`));
  const result = await response.json().catch(() => ({ ok: false, state: "error", message: "Could not check this download." })) as JobResult;
  if (!result.ok || result.state === "error") return json({ ok: false, state: "error", message: result.message || "Could not prepare this file." });
  if (result.state !== "ready" || !result.fileId || !result.fileName) return json({ ok: true, state: "preparing" });
  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const sig = await signValue(env.BOT_TOKEN, downloadSignaturePayload(auth.identity.userId, auth.sessionId, result.fileId, expires));
  return json({ ok: true, state: "ready", fileName: result.fileName, size: Number(result.size || 0), mime: result.mime || "application/octet-stream", downloadUrl: makeDownloadUrl(request, auth.identity.userId, auth.sessionId, result.fileId, expires, sig) });
}

async function handleWatchStart(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request); if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env); if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const videoId = String(body.videoId || "");
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This watch session is invalid." }, 400);

  const streamId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(auth.identity.userId, auth.sessionId));
  const response = await container.fetch(new Request("http://container/mini/watch/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, streamId }),
  }));
  const result = await response.json().catch(() => ({ ok: false, message: "Could not open this stream." })) as WatchResult;
  if (!response.ok || !result.ok || !result.streamId) {
    return json({ ok: false, message: result.message || "Could not open this stream." }, response.status >= 500 ? 502 : 200);
  }

  const expires = Math.floor(Date.now() / 1000) + WATCH_TTL_SECONDS;
  const sig = await signValue(env.BOT_TOKEN, watchSignaturePayload(auth.identity.userId, auth.sessionId, result.streamId, expires));
  return json({
    ok: true,
    title: result.title || "YouTube video",
    mime: result.mime || "video/mp4",
    streamUrl: makeWatchUrl(request, auth.identity.userId, auth.sessionId, result.streamId, expires, sig),
  });
}

async function handleFile(request: Request, env: MiniAppEnv): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("u") || "0");
  const sessionId = url.searchParams.get("s") || "";
  const fileId = url.searchParams.get("f") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !SESSION_RE.test(sessionId) || !FILE_ID_RE.test(fileId) || !Number.isSafeInteger(expires) || expires < now || expires > now + DOWNLOAD_TTL_SECONDS + 60 || !/^[a-f0-9]{64}$/i.test(sig)) return new Response("Download link expired or invalid.", { status: 403 });
  const expected = await signValue(env.BOT_TOKEN, downloadSignaturePayload(userId, sessionId, fileId, expires));
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) return new Response("Download link expired or invalid.", { status: 403 });

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(userId, sessionId));
  const headers = new Headers();
  const range = request.headers.get("range"); if (range) headers.set("range", range);
  const source = await container.fetch(new Request(`http://container/mini/file?fileId=${encodeURIComponent(fileId)}`, { method: request.method === "HEAD" ? "HEAD" : "GET", headers }));
  if (!source.ok && source.status !== 206) return new Response("File is no longer available. Prepare it again.", { status: 404 });

  const outgoing = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
    const value = source.headers.get(name); if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("access-control-allow-origin", "https://web.telegram.org");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, { status: source.status, headers: outgoing });
}

async function handleWatchStream(request: Request, env: MiniAppEnv): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("u") || "0");
  const sessionId = url.searchParams.get("s") || "";
  const streamId = url.searchParams.get("w") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isSafeInteger(userId) || userId <= 0 || !SESSION_RE.test(sessionId) || !FILE_ID_RE.test(streamId) || !Number.isSafeInteger(expires) || expires < now || expires > now + WATCH_TTL_SECONDS + 60 || !/^[a-f0-9]{64}$/i.test(sig)) {
    return new Response("Stream link expired or invalid.", { status: 403 });
  }
  const expected = await signValue(env.BOT_TOKEN, watchSignaturePayload(userId, sessionId, streamId, expires));
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) return new Response("Stream link expired or invalid.", { status: 403 });

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(userId, sessionId));
  const headers = new Headers();
  const range = request.headers.get("range"); if (range) headers.set("range", range);
  const ifRange = request.headers.get("if-range"); if (ifRange) headers.set("if-range", ifRange);
  const source = await container.fetch(new Request(`http://container/mini/watch?streamId=${encodeURIComponent(streamId)}`, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
  }));
  if (!source.ok && source.status !== 206) return new Response("Stream is no longer available.", { status: 404 });

  const outgoing = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = source.headers.get(name); if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, { status: source.status, headers: outgoing });
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="theme-color" content="#050505">
<title>Vexa Downloader</title>
<script src="https://telegram.org/js/telegram-web-app.js?63"></script>
<style>
:root{color-scheme:dark;--bg:#050505;--text:#f5f5f5;--muted:#888;--line:#222;--panel:#0a0a0a;--soft:#111}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif;min-height:100%;overflow-x:hidden}
body:before{content:"";position:fixed;inset:-25%;pointer-events:none;background:radial-gradient(circle at 50% 8%,rgba(255,255,255,.07),transparent 28%);animation:drift 10s ease-in-out infinite alternate}
body.playerFullscreen{overflow:hidden;overscroll-behavior:none}
.app{position:relative;max-width:720px;margin:0 auto;padding:max(24px,env(safe-area-inset-top)) 18px max(30px,env(safe-area-inset-bottom));min-height:100vh}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px;animation:rise .55s ease both}
.brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:750;letter-spacing:.22em}.mark{width:28px;height:28px;border:1px solid #292929;border-radius:50%;display:grid;place-items:center;font-weight:800}
.live{color:#777;font-size:12px;display:flex;gap:7px;align-items:center}.dot{width:6px;height:6px;border-radius:50%;background:#eee;animation:pulse 2s ease infinite}
h1{font-size:clamp(38px,10vw,64px);line-height:.94;letter-spacing:-.055em;margin:0 0 18px;font-weight:680;animation:rise .6s .05s ease both}
.sub{color:var(--muted);font-size:15px;line-height:1.6;margin:0 0 24px;max-width:540px;min-height:48px}
.modeSwitch{position:relative;display:grid;grid-template-columns:1fr 1fr;max-width:390px;height:56px;padding:5px;margin:0 0 20px;border:1px solid #242424;border-radius:19px;background:#090909;isolation:isolate;box-shadow:inset 0 1px rgba(255,255,255,.025);animation:rise .6s .1s ease both}
.modeThumb{position:absolute;z-index:0;left:5px;top:5px;width:calc(50% - 5px);height:46px;border-radius:14px;background:#f2f2f2;box-shadow:0 8px 26px rgba(0,0,0,.28);transition:transform .32s cubic-bezier(.22,.85,.28,1)}
.modeSwitch.watch .modeThumb{transform:translateX(100%)}
.modeButton{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:#666;font-size:13px;font-weight:750;letter-spacing:-.01em;transition:color .25s,transform .18s}.modeButton:active{transform:scale(.97)}.modeButton.active{color:#080808}
.modeButton svg{width:19px;height:19px;stroke-width:2.7}
.inputShell{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);background:#0a0a0a;border-radius:22px;transition:border-color .2s,transform .2s}.inputShell:focus-within{border-color:#3a3a3a;transform:translateY(-1px)}
.linkIcon{width:42px;height:42px;border-radius:15px;background:#111;display:grid;place-items:center;color:#aaa;flex:0 0 auto}input{min-width:0;flex:1;background:transparent;color:#fff;border:0;outline:0;font:inherit;font-size:15px;padding:12px 0}input::placeholder{color:#555}
button{font:inherit;border:0;cursor:pointer}.go{height:46px;border-radius:16px;padding:0 18px;background:#fff;color:#050505;font-weight:700;transition:transform .18s}.go:active,.primary:active,.save:active{transform:scale(.975)}button:disabled{opacity:.35;cursor:default}
.message{min-height:22px;margin:12px 4px 0;color:#777;font-size:13px}.message:empty{min-height:0;margin-top:6px}.message.error{color:#eee}
.card{margin-top:26px;border:1px solid var(--line);border-radius:26px;background:#0a0a0a;overflow:hidden;opacity:0;transform:translateY(12px);pointer-events:none;transition:.3s}.card.show{opacity:1;transform:none;pointer-events:auto}
.head{padding:22px;border-bottom:1px solid var(--line)}.eyebrow{color:#666;font-size:11px;letter-spacing:.14em;margin-bottom:10px}.title{font-size:18px;line-height:1.35;font-weight:600}.section{padding:20px 22px}.label{font-size:12px;color:#777;margin-bottom:12px}
.formats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.format{text-align:left;padding:15px;border:1px solid #222;border-radius:17px;background:#0d0d0d;color:#ddd}.format .name{display:block;font-size:14px;font-weight:650}.format .desc{display:block;font-size:11px;color:#666;margin-top:4px}.format.selected{background:#f3f3f3;color:#090909;border-color:#eee}.format.selected .desc{color:#555}
.primary,.save{width:100%;height:54px;border-radius:18px;background:#fff;color:#050505;font-weight:720;margin-top:18px}
.progress,.ready{display:none;margin-top:26px;border:1px solid var(--line);border-radius:26px;padding:22px;background:#090909}.progress.show,.ready.show{display:block;animation:rise .3s ease both}.progressTop{display:flex;align-items:center;gap:15px}.orb{position:relative;width:42px;height:42px;border-radius:50%;border:1px solid #262626;flex:0 0 auto}.orb:before{content:"";position:absolute;inset:5px;border-radius:50%;border:2px solid transparent;border-top-color:#fff;animation:spin 1s linear infinite}.progressTitle,.readyTitle{font-size:15px;font-weight:650}.progressSub,.readyMeta{font-size:12px;color:#666;margin-top:5px}.rail{height:2px;background:#171717;margin-top:20px;overflow:hidden}.rail:after{content:"";display:block;width:35%;height:100%;background:#eee;animation:scan 1.3s ease-in-out infinite}.readyRow{display:flex;align-items:center;gap:14px}.readyIcon{width:44px;height:44px;border-radius:50%;background:#fff;color:#050505;display:grid;place-items:center;font-size:20px;font-weight:800}.readyText{min-width:0;flex:1}.readyMeta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.playerCard{display:none;margin-top:8px}.playerCard.show{display:block;animation:rise .32s ease both}.playerShell{position:relative;width:100%;aspect-ratio:16/9;border-radius:22px;overflow:hidden;background:#000;border:1px solid #1f1f1f;box-shadow:0 12px 38px rgba(0,0,0,.28);touch-action:manipulation}
.playerShell video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.playerShade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 48%,rgba(0,0,0,.68));pointer-events:none;opacity:.9}
.playerCenter{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:rgba(8,8,8,.64);color:#fff;border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(12px);box-shadow:0 10px 28px rgba(0,0,0,.28);transition:opacity .2s,transform .2s}.playerCenter:active{transform:translate(-50%,-50%) scale(.95)}.playerCenter svg{width:30px;height:30px;stroke-width:2.1}.playerShell.playing .playerCenter{opacity:0;pointer-events:none}
.playerLoading{position:absolute;left:50%;top:50%;width:42px;height:42px;margin:-21px;border:2px solid rgba(255,255,255,.14);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;opacity:0;pointer-events:none}.playerShell.loading .playerLoading{opacity:1}.playerShell.loading .playerCenter{opacity:0}
.playerControls{position:absolute;left:0;right:0;bottom:0;padding:32px 14px 13px;opacity:1;transform:translateY(0);transition:opacity .22s,transform .22s;background:linear-gradient(to top,rgba(0,0,0,.82),rgba(0,0,0,.24),transparent)}.playerShell.controlsHidden .playerControls{opacity:0;transform:translateY(8px);pointer-events:none}
.seekWrap{position:relative;height:18px;display:flex;align-items:center}.seekBase{position:absolute;left:2px;right:2px;height:4px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden}.bufferedBar,.playedBar{position:absolute;inset:0 auto 0 0;width:0;border-radius:99px}.bufferedBar{background:rgba(255,255,255,.23)}.playedBar{background:#fff}
.seek{position:relative;width:100%;height:18px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}.seek::-webkit-slider-runnable-track{height:4px;background:transparent}.seek::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#fff;margin-top:-5px;box-shadow:0 1px 6px rgba(0,0,0,.38)}.seek::-moz-range-track{height:4px;background:transparent}.seek::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff}
.controlRow{display:flex;align-items:center;gap:4px;margin-top:5px}.controlButton{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:transparent;color:#fff;transition:background .18s,transform .18s}.controlButton:active{transform:scale(.93);background:rgba(255,255,255,.08)}.controlButton svg{width:21px;height:21px;stroke-width:2.1}.skipButton svg{width:22px;height:22px}.playerTime{font-size:11px;font-variant-numeric:tabular-nums;color:#d8d8d8;margin-left:2px;white-space:nowrap}.controlSpacer{flex:1}
.watchMeta{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:12px 4px 0}.watchTitle{font-size:14px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.watchBadge{flex:0 0 auto;font-size:10px;font-weight:700;letter-spacing:.07em;color:#080808;background:#eee;border-radius:99px;padding:5px 8px}
.playerCard.fullscreenHost{display:block;position:fixed;z-index:2147483647;inset:0;margin:0;padding:0;background:#000;animation:none!important;transform:none!important}
.playerCard.fullscreenHost .playerShell{width:100%;height:100%;aspect-ratio:auto;border:0;border-radius:0;box-shadow:none}
.playerCard.fullscreenHost .watchMeta{display:none}
.playerCard.fullscreenHost .playerControls{padding-left:max(14px,var(--tg-content-safe-area-inset-left,0px));padding-right:max(14px,var(--tg-content-safe-area-inset-right,0px));padding-bottom:max(14px,var(--tg-safe-area-inset-bottom,0px))}
.playerCard.fullscreenHost .playerCenter{margin-top:calc((var(--tg-content-safe-area-inset-top,0px) - var(--tg-content-safe-area-inset-bottom,0px))/2)}
.playerShell:fullscreen{border-radius:0;border:0}.playerShell:fullscreen .playerControls{padding-bottom:max(14px,env(safe-area-inset-bottom))}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{opacity:.35}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(390%)}}@keyframes drift{to{transform:translateY(-2%) scale(1.03)}}
@media(max-width:420px){.app{padding-left:14px;padding-right:14px}.top{margin-bottom:36px}.head,.section{padding-left:18px;padding-right:18px}.playerControls{padding-left:10px;padding-right:10px}.controlButton{width:36px;height:36px}.playerTime{font-size:10px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<main class="app">
<h1>Paste.<br>Pick. Save.</h1>
<p id="sub" class="sub">Drop a YouTube link, choose the quality you want, then save the file directly to your device.</p>

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
  <div class="linkIcon">↗</div>
  <input id="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste YouTube link">
  <button id="analyze" class="go" type="button">Analyze</button>
</div>
<div id="message" class="message" aria-live="polite"></div>

<section id="result" class="card">
  <div class="head"><div class="eyebrow">YOUTUBE</div><div id="videoTitle" class="title"></div></div>
  <div class="section"><div class="label">Choose format</div><div id="formats" class="formats"></div><button id="prepare" class="primary" type="button" disabled>Prepare download</button></div>
</section>

<section id="playerCard" class="playerCard" aria-live="polite">
  <div id="playerShell" class="playerShell">
    <video id="video" playsinline webkit-playsinline preload="metadata"></video>
    <div class="playerShade"></div>
    <div id="playerLoading" class="playerLoading"></div>
    <button id="centerPlay" class="playerCenter" type="button" aria-label="Play">
      <svg id="centerPlayIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div id="playerControls" class="playerControls">
      <div class="seekWrap">
        <div class="seekBase"><div id="bufferedBar" class="bufferedBar"></div><div id="playedBar" class="playedBar"></div></div>
        <input id="seek" class="seek" type="range" min="0" max="100" value="0" step="0.05" aria-label="Seek video">
      </div>
      <div class="controlRow">
        <button id="playPause" class="controlButton" type="button" aria-label="Play or pause">
          <svg id="playIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button id="back10" class="controlButton skipButton" type="button" aria-label="Back 10 seconds">
          <svg viewBox="0 0 24 24" fill="none"><path d="M8 8H4V4M4.5 8.5A8 8 0 1 1 4 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg>
        </button>
        <button id="forward10" class="controlButton skipButton" type="button" aria-label="Forward 10 seconds">
          <svg viewBox="0 0 24 24" fill="none"><path d="M16 8h4V4m-.5 4.5A8 8 0 1 0 20 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg>
        </button>
        <div id="playerTime" class="playerTime">0:00 / 0:00</div>
        <div class="controlSpacer"></div>
        <button id="mute" class="controlButton" type="button" aria-label="Mute or unmute">
          <svg id="muteIcon" viewBox="0 0 24 24" fill="none"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/></svg>
        </button>
        <button id="fullscreen" class="controlButton" type="button" aria-label="Fullscreen">
          <svg viewBox="0 0 24 24" fill="none"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4m12 4h4v-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
  </div>
  <div class="watchMeta"><div id="watchTitle" class="watchTitle"></div><span class="watchBadge">ONLINE</span></div>
</section>

<section id="progress" class="progress"><div class="progressTop"><div class="orb"></div><div><div class="progressTitle">Preparing your file</div><div id="progressSub" class="progressSub">Starting download…</div></div></div><div class="rail"></div></section>
<section id="ready" class="ready"><div class="readyRow"><div class="readyIcon">↓</div><div class="readyText"><div class="readyTitle">Ready to save</div><div id="readyMeta" class="readyMeta"></div></div></div><button id="save" class="save" type="button">Save to Files</button></section>
</main>

<script>
(function(){
var tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null,$=function(i){return document.getElementById(i)};
var url=$('url'),analyze=$('analyze'),message=$('message'),result=$('result'),title=$('videoTitle'),formats=$('formats'),prepare=$('prepare'),progress=$('progress'),progressSub=$('progressSub'),ready=$('ready'),readyMeta=$('readyMeta'),save=$('save');
var modeSwitch=$('modeSwitch'),modeDownload=$('modeDownload'),modeWatch=$('modeWatch'),sub=$('sub');
var playerCard=$('playerCard'),playerShell=$('playerShell'),video=$('video'),centerPlay=$('centerPlay'),playPause=$('playPause'),playIcon=$('playIcon'),centerPlayIcon=$('centerPlayIcon'),back10=$('back10'),forward10=$('forward10'),seek=$('seek'),bufferedBar=$('bufferedBar'),playedBar=$('playedBar'),playerTime=$('playerTime'),mute=$('mute'),muteIcon=$('muteIcon'),fullscreen=$('fullscreen'),watchTitle=$('watchTitle');
var sessionId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2)),current=null,selected=null,prepared=null,pollToken=0,mode='download',controlsTimer=null,telegramFullscreenRequested=false,fullscreenFallbackTimer=null,cssFullscreenFallback=false;

function initData(){return tg&&tg.initData?tg.initData:''}
function msg(t,e){message.textContent=t||'';message.classList.toggle('error',!!e)}
function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}
function size(b){if(!b)return'File ready';var u=['B','KB','MB','GB'],i=Math.min(Math.floor(Math.log(b)/Math.log(1024)),3),v=b/Math.pow(1024,i);return(v>=100||i===0?Math.round(v):v.toFixed(1))+' '+u[i]}
function hap(k){try{if(tg&&tg.HapticFeedback){if(k==='success'||k==='error')tg.HapticFeedback.notificationOccurred(k);else tg.HapticFeedback.selectionChanged()}}catch(e){}}
function iconPlay(){return '<path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'}
function iconPause(){return '<path d="M9 7v10M15 7v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'}
function syncPlayIcons(){var html=video.paused?iconPlay():iconPause();playIcon.innerHTML=html;centerPlayIcon.innerHTML=html;playerShell.classList.toggle('playing',!video.paused)}
function fmtTime(value){if(!isFinite(value)||value<0)return'0:00';var total=Math.floor(value),h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;return h>0?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0')}
function updateTimeline(){var d=video.duration||0,c=video.currentTime||0,p=d?Math.max(0,Math.min(100,c/d*100)):0;seek.value=String(p);playedBar.style.width=p+'%';playerTime.textContent=fmtTime(c)+' / '+fmtTime(d);if(video.buffered&&video.buffered.length&&d){try{bufferedBar.style.width=Math.min(100,video.buffered.end(video.buffered.length-1)/d*100)+'%'}catch(e){}}}
function showControls(){playerShell.classList.remove('controlsHidden');if(controlsTimer)clearTimeout(controlsTimer);if(!video.paused){controlsTimer=setTimeout(function(){playerShell.classList.add('controlsHidden')},2400)}}
function setLoading(on){playerShell.classList.toggle('loading',!!on)}
function clearFullscreenFallbackTimer(){if(fullscreenFallbackTimer){clearTimeout(fullscreenFallbackTimer);fullscreenFallbackTimer=null}}
function setPlayerFullscreen(on){playerCard.classList.toggle('fullscreenHost',!!on);document.body.classList.toggle('playerFullscreen',!!on);fullscreen.setAttribute('aria-label',on?'Exit fullscreen':'Fullscreen');showControls()}
function exitPlayerFullscreen(){clearFullscreenFallbackTimer();telegramFullscreenRequested=false;cssFullscreenFallback=false;setPlayerFullscreen(false);if(tg&&tg.isFullscreen&&typeof tg.exitFullscreen==='function'){try{tg.exitFullscreen()}catch(e){}}else if(!tg&&document.fullscreenElement&&document.exitFullscreen){try{document.exitFullscreen()}catch(e){}}}
function resetPlayer(){if(controlsTimer)clearTimeout(controlsTimer);exitPlayerFullscreen();video.pause();video.removeAttribute('src');video.load();playerCard.classList.remove('show');playerShell.classList.remove('playing','loading','controlsHidden');seek.value='0';playedBar.style.width='0%';bufferedBar.style.width='0%';playerTime.textContent='0:00 / 0:00'}
function choose(v,b){selected=v;formats.querySelectorAll('.format').forEach(function(x){x.classList.remove('selected')});b.classList.add('selected');prepare.disabled=false;prepared=null;ready.classList.remove('show');hap('select')}
function add(n,d,v){var b=document.createElement('button');b.type='button';b.className='format';b.innerHTML='<span class="name"></span><span class="desc"></span>';b.querySelector('.name').textContent=n;b.querySelector('.desc').textContent=d;b.addEventListener('click',function(){choose(v,b)});formats.appendChild(b);return b}
function render(d){formats.textContent='';selected=null;var pref=null;(d.qualities||[]).forEach(function(q){var b=add(q+'p',q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD',{quality:q});if(q===720)pref=b});if(d.audioAvailable){add('Audio Lite','Smaller M4A',{audioMode:'low'});add('Audio HQ','Best M4A',{audioMode:'hq'})}if(!pref)pref=formats.querySelector('.format');if(pref)pref.click()}
async function api(p,b){var r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}),d=await r.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(!r.ok)d.ok=false;return d}
function setMode(next){if(next===mode)return;mode=next;pollToken++;current=null;selected=null;prepared=null;result.classList.remove('show');progress.classList.remove('show');ready.classList.remove('show');resetPlayer();modeSwitch.classList.toggle('watch',mode==='watch');modeDownload.classList.toggle('active',mode==='download');modeWatch.classList.toggle('active',mode==='watch');modeDownload.setAttribute('aria-selected',mode==='download'?'true':'false');modeWatch.setAttribute('aria-selected',mode==='watch'?'true':'false');if(mode==='watch'){sub.textContent='Paste a YouTube link and watch it instantly with a clean in-app player.';analyze.textContent='Watch'}else{sub.textContent='Drop a YouTube link, choose the quality you want, then save the file directly to your device.';analyze.textContent='Analyze'}msg('');hap('select')}
async function openWatch(d){msg('Opening stream…');var w=await api('/mini-app/api/watch',{initData:initData(),sessionId:sessionId,videoId:d.videoId});if(!w.ok||!w.streamUrl)throw new Error(w.message||'Could not open this stream.');watchTitle.textContent=w.title||d.title||'YouTube video';playerCard.classList.add('show');setLoading(true);video.src=w.streamUrl;video.load();showControls();msg('');hap('success')}
async function analyzeLink(){var v=url.value.trim();if(!v)return msg('Paste a YouTube link first.',true);if(!initData())return msg('Open this page from the Vexa bot in Telegram.',true);pollToken++;analyze.disabled=true;result.classList.remove('show');progress.classList.remove('show');ready.classList.remove('show');resetPlayer();msg('Reading video…');try{var d=await api('/mini-app/api/metadata',{initData:initData(),sessionId:sessionId,url:v});if(!d.ok)throw new Error(d.message||'Could not read this video.');current=d;if(mode==='watch'){await openWatch(d)}else{title.textContent=d.title||'YouTube video';render(d);result.classList.add('show');msg('Choose a format below.');hap('success')}}catch(e){msg(e.message||'Could not read this video.',true);hap('error')}finally{analyze.disabled=false}}
async function poll(jobId,token){var started=Date.now();while(token===pollToken){await wait(1500);var d=await api('/mini-app/api/status',{initData:initData(),sessionId:sessionId,jobId:jobId});if(token!==pollToken)return;if(d.ok&&d.state==='ready'){prepared=d;progress.classList.remove('show');readyMeta.textContent=size(d.size)+' · '+d.fileName;ready.classList.add('show');msg('Your file is ready.');prepare.disabled=false;analyze.disabled=false;hap('success');return}if(!d.ok||d.state==='error')throw new Error(d.message||'Could not prepare this file.');var sec=Math.round((Date.now()-started)/1000);progressSub.textContent=sec>45?'Still preparing — large videos can take a few minutes. Keep this Mini App open.':'Downloading and packaging the selected quality…';if(sec>1800)throw new Error('This download took too long. Please try again.')}}
async function prepareFile(){if(!current||!selected||mode!=='download')return;var token=++pollToken;prepare.disabled=true;analyze.disabled=true;ready.classList.remove('show');progress.classList.add('show');progressSub.textContent='Starting download…';msg('');try{var body={initData:initData(),sessionId:sessionId,videoId:current.videoId};if(selected.quality)body.quality=selected.quality;else body.audioMode=selected.audioMode;var d=await api('/mini-app/api/start',body);if(!d.ok||!d.jobId)throw new Error(d.message||'Could not start this download.');await poll(d.jobId,token)}catch(e){if(token===pollToken){progress.classList.remove('show');prepare.disabled=false;analyze.disabled=false;msg(e.message||'Could not prepare this file.',true);hap('error')}}}
function saveFile(){if(!prepared||!prepared.downloadUrl)return;if(tg&&typeof tg.downloadFile==='function'){tg.downloadFile({url:prepared.downloadUrl,file_name:prepared.fileName},function(ok){msg(ok?'Download started.':'Telegram did not start the download. Tap Save again.',!ok)});return}if(tg&&typeof tg.openLink==='function'){tg.openLink(prepared.downloadUrl);return}location.href=prepared.downloadUrl}
function togglePlay(){if(!video.src)return;if(video.paused){var p=video.play();if(p&&p.catch)p.catch(function(){msg('Tap play again to start the video.',true)})}else video.pause();showControls()}
async function toggleFullscreen(){showControls();if(tg&&typeof tg.requestFullscreen==='function'){if(tg.isFullscreen){clearFullscreenFallbackTimer();telegramFullscreenRequested=false;cssFullscreenFallback=false;try{tg.exitFullscreen&&tg.exitFullscreen()}catch(e){setPlayerFullscreen(false)}return}if(cssFullscreenFallback||playerCard.classList.contains('fullscreenHost')){clearFullscreenFallbackTimer();telegramFullscreenRequested=false;cssFullscreenFallback=false;setPlayerFullscreen(false);return}telegramFullscreenRequested=true;try{tg.requestFullscreen();clearFullscreenFallbackTimer();fullscreenFallbackTimer=setTimeout(function(){if(telegramFullscreenRequested&&!tg.isFullscreen){cssFullscreenFallback=true;setPlayerFullscreen(true)}},700);return}catch(e){telegramFullscreenRequested=false;cssFullscreenFallback=true;setPlayerFullscreen(true);return}}if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen();return}catch(e){}}if(playerShell.requestFullscreen){try{await playerShell.requestFullscreen();return}catch(e){}}if(video.webkitEnterFullscreen){try{video.webkitEnterFullscreen()}catch(e){}}}
function syncMuteIcon(){muteIcon.innerHTML=video.muted?'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="m17 9 4 6m0-6-4 6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>':'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/>'}

modeDownload.addEventListener('click',function(){setMode('download')});modeWatch.addEventListener('click',function(){setMode('watch')});
analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);
url.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();analyzeLink()}});url.addEventListener('input',function(){pollToken++;prepared=null;ready.classList.remove('show');result.classList.remove('show');resetPlayer()});
centerPlay.addEventListener('click',function(e){e.stopPropagation();togglePlay()});playPause.addEventListener('click',function(e){e.stopPropagation();togglePlay()});
back10.addEventListener('click',function(e){e.stopPropagation();video.currentTime=Math.max(0,(video.currentTime||0)-10);showControls()});forward10.addEventListener('click',function(e){e.stopPropagation();video.currentTime=Math.min(video.duration||Infinity,(video.currentTime||0)+10);showControls()});
seek.addEventListener('input',function(e){e.stopPropagation();if(video.duration)video.currentTime=(Number(seek.value)/100)*video.duration;updateTimeline();showControls()});
mute.addEventListener('click',function(e){e.stopPropagation();video.muted=!video.muted;syncMuteIcon();showControls()});fullscreen.addEventListener('click',function(e){e.stopPropagation();toggleFullscreen()});
video.addEventListener('click',togglePlay);playerShell.addEventListener('mousemove',showControls);playerShell.addEventListener('touchstart',showControls,{passive:true});
video.addEventListener('play',function(){syncPlayIcons();setLoading(false);showControls()});video.addEventListener('pause',function(){syncPlayIcons();showControls()});video.addEventListener('ended',function(){syncPlayIcons();showControls()});
video.addEventListener('timeupdate',updateTimeline);video.addEventListener('progress',updateTimeline);video.addEventListener('durationchange',updateTimeline);video.addEventListener('loadedmetadata',function(){setLoading(false);updateTimeline();showControls()});video.addEventListener('canplay',function(){setLoading(false)});video.addEventListener('waiting',function(){setLoading(true)});video.addEventListener('stalled',function(){setLoading(true)});video.addEventListener('playing',function(){setLoading(false)});
video.addEventListener('error',function(){setLoading(false);msg('This stream stopped. Tap Watch to reconnect.',true);showControls()});
document.addEventListener('fullscreenchange',function(){if(!tg&&!document.fullscreenElement)setPlayerFullscreen(false);showControls()});
if(tg){try{tg.ready();tg.expand();tg.setHeaderColor&&tg.setHeaderColor('#050505');tg.setBackgroundColor&&tg.setBackgroundColor('#050505');tg.setBottomBarColor&&tg.setBottomBarColor('#050505');tg.onEvent&&tg.onEvent('fileDownloadRequested',function(e){if(e&&e.status==='downloading')msg('Download started.');else if(e&&e.status==='cancelled')msg('Download was cancelled.',true)});tg.onEvent&&tg.onEvent('fullscreenChanged',function(){clearFullscreenFallbackTimer();var on=!!tg.isFullscreen&&mode==='watch'&&playerCard.classList.contains('show');telegramFullscreenRequested=false;cssFullscreenFallback=false;setPlayerFullscreen(on)});tg.onEvent&&tg.onEvent('fullscreenFailed',function(){clearFullscreenFallbackTimer();var canFallback=telegramFullscreenRequested&&mode==='watch'&&playerCard.classList.contains('show');telegramFullscreenRequested=false;if(canFallback){cssFullscreenFallback=true;setPlayerFullscreen(true)}else{cssFullscreenFallback=false;setPlayerFullscreen(false)}})}catch(e){}}else msg('Open this page from the Vexa bot in Telegram.',true);
syncPlayIcons();syncMuteIcon();
})();
</script>
</body>
</html>`;

function htmlResponse(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleMiniAppRequestV2(request: Request, env: MiniAppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === MINI_APP_PATH || url.pathname === `${MINI_APP_PATH}/`) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    return request.method === "HEAD" ? new Response(null, { headers: htmlResponse().headers }) : htmlResponse();
  }
  if (url.pathname === `${MINI_APP_PATH}/api/metadata` && request.method === "POST") return handleMetadata(request, env);
  if (url.pathname === `${MINI_APP_PATH}/api/start` && request.method === "POST") return handleStart(request, env);
  if (url.pathname === `${MINI_APP_PATH}/api/status` && request.method === "POST") return handleStatus(request, env);
  if (url.pathname === `${MINI_APP_PATH}/api/watch` && request.method === "POST") return handleWatchStart(request, env);
  if (url.pathname === `${MINI_APP_PATH}/file` && (request.method === "GET" || request.method === "HEAD")) return handleFile(request, env);
  if (url.pathname === `${MINI_APP_PATH}/stream` && (request.method === "GET" || request.method === "HEAD")) return handleWatchStream(request, env);
  if (url.pathname.startsWith(`${MINI_APP_PATH}/`)) return new Response("Not found", { status: 404 });
  return null;
}