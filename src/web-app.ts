import { getContainer } from "@cloudflare/containers";
import { WEB_APP_HTML } from "./web-ui";

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
  quality?: number;
  qualities?: number[];
};

type BrowserSession = { id: string; expires: number };
type BrowserAuth = BrowserSession & { tabId: string };

const COOKIE_NAME = "__Host-vexa_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
const WATCH_TTL_SECONDS = 30 * 60;
const WATCH_QUALITY_VALUES = [144, 240, 360, 480, 720, 1080] as const;
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

function normalizeWatchQualities(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && WATCH_QUALITY_VALUES.includes(item as (typeof WATCH_QUALITY_VALUES)[number])),
    ),
  ).sort((a, b) => b - a);
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
  const rawQuality = body.quality;
  const quality = rawQuality == null || rawQuality === "" ? null : Number(rawQuality);
  if (!VIDEO_ID_RE.test(videoId)) return json({ ok: false, message: "This watch session is invalid." }, 400);
  if (
    quality != null &&
    (!Number.isInteger(quality) || !WATCH_QUALITY_VALUES.includes(quality as (typeof WATCH_QUALITY_VALUES)[number]))
  ) {
    return json({ ok: false, message: "This watch quality is invalid." }, 400);
  }

  const streamId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, containerId(auth));
  const response = await container.fetch(
    new Request("http://container/mini/watch/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        streamId,
        quality: quality ?? undefined,
      }),
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
  const resolvedQuality = Number(result.quality || 0);
  return json({
    ok: true,
    title: result.title || "YouTube video",
    mime: result.mime || "video/mp4",
    quality: WATCH_QUALITY_VALUES.includes(resolvedQuality as (typeof WATCH_QUALITY_VALUES)[number])
      ? resolvedQuality
      : null,
    qualities: normalizeWatchQualities(result.qualities),
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
  return new Response(request.method === "HEAD" ? null : WEB_APP_HTML, { headers });
}

export async function handleWebAppRequest(
  request: Request,
  env: WebAppEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/") &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
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
