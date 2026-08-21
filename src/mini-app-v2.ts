import { getContainer } from "@cloudflare/containers";
import { MINI_APP_HTML } from "./mini-app-ui";

type MiniAppEnv = {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<any>;
};
type TelegramIdentity = { userId: number };
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

const MINI_APP_PATH = "/mini-app";
const SESSION_RE = /^[A-Za-z0-9_-]{12,64}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;
const WATCH_TTL_SECONDS = 30 * 60;
const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;
const WATCH_QUALITY_VALUES = [144, 240, 360, 480, 720, 1080] as const;
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

async function validateTelegramInitData(initData: string, botToken: string): Promise<TelegramIdentity | null> {
  if (!initData || initData.length > 16_384) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date") || "0");
  if (!/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isSafeInteger(authDate) || authDate <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 300 || now - authDate > INIT_DATA_MAX_AGE_SECONDS) return null;

  const all = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));
  const secret = await hmacSha256(encoder.encode("WebAppData"), botToken);
  const compute = async (entries: Array<[string, string]>) => {
    const check = entries.map(([key, value]) => `${key}=${value}`).join("\n");
    return bytesToHex(await hmacSha256(secret, check));
  };

  let expected = await compute(all);
  let valid = constantTimeEqual(expected.toLowerCase(), receivedHash.toLowerCase());
  if (!valid && params.has("signature")) {
    expected = await compute(all.filter(([key]) => key !== "signature"));
    valid = constantTimeEqual(expected.toLowerCase(), receivedHash.toLowerCase());
  }
  if (!valid) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}") as { id?: unknown };
    const userId = Number(user.id);
    return Number.isSafeInteger(userId) && userId > 0 ? { userId } : null;
  } catch {
    return null;
  }
}

function miniContainerId(userId: number, sessionId: string): string {
  return `mini-${userId}-${sessionId}`;
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
      if (isYoutube && (parsed.protocol === "https:" || parsed.protocol === "http:")) return parsed.toString();
    } catch {
      // Continue scanning URLs in the input.
    }
  }
  return null;
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

async function signValue(botToken: string, payload: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(botToken), payload));
}

function downloadSignaturePayload(userId: number, sessionId: string, fileId: string, expires: number): string {
  return `${userId}|${sessionId}|${fileId}|${expires}`;
}

function watchSignaturePayload(userId: number, sessionId: string, streamId: string, expires: number): string {
  return `watch|${userId}|${sessionId}|${streamId}|${expires}`;
}

function makeDownloadUrl(
  request: Request,
  userId: number,
  sessionId: string,
  fileId: string,
  expires: number,
  sig: string,
): string {
  const url = new URL(`${MINI_APP_PATH}/file`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
  url.searchParams.set("f", fileId);
  url.searchParams.set("e", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}

function makeWatchUrl(
  request: Request,
  userId: number,
  sessionId: string,
  streamId: string,
  expires: number,
  sig: string,
): string {
  const url = new URL(`${MINI_APP_PATH}/stream`, request.url);
  url.searchParams.set("u", String(userId));
  url.searchParams.set("s", sessionId);
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
        .filter(
          (item) =>
            Number.isInteger(item) &&
            WATCH_QUALITY_VALUES.includes(item as (typeof WATCH_QUALITY_VALUES)[number]),
        ),
    ),
  ).sort((a, b) => b - a);
}

async function authenticate(
  body: Record<string, unknown>,
  env: MiniAppEnv,
): Promise<{ identity: TelegramIdentity; sessionId: string } | null> {
  const identity = await validateTelegramInitData(String(body.initData || ""), env.BOT_TOKEN);
  const sessionId = String(body.sessionId || "");
  return identity && SESSION_RE.test(sessionId) ? { identity, sessionId } : null;
}

async function handleMetadata(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const source = youtubeUrlFromInput(String(body.url || ""));
  if (!source) return json({ ok: false, message: "Paste a valid YouTube link." }, 400);

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
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
      ? metadata.qualities.filter((quality) => [360, 480, 720, 1080].includes(Number(quality)))
      : [],
    audioAvailable: Boolean(metadata.audioAvailable),
  });
}

async function handleStart(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);

  const videoId = String(body.videoId || "");
  const quality = body.quality == null ? null : Number(body.quality);
  const audioMode = body.audioMode == null ? null : String(body.audioMode);
  if (!VIDEO_ID_RE.test(videoId)) {
    return json({ ok: false, message: "This download session is invalid." }, 400);
  }
  const validQuality = quality != null && [360, 480, 720, 1080].includes(quality);
  const validAudio = audioMode === "low" || audioMode === "hq";
  if (validQuality === validAudio) {
    return json({ ok: false, message: "Choose one download format." }, 400);
  }

  const fileId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
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

async function handleStatus(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);
  const jobId = String(body.jobId || "");
  if (!FILE_ID_RE.test(jobId)) return json({ ok: false, message: "Invalid download job." }, 400);

  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
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
    downloadSignaturePayload(auth.identity.userId, auth.sessionId, result.fileId, expires),
  );
  return json({
    ok: true,
    state: "ready",
    fileName: result.fileName,
    size: Number(result.size || 0),
    mime: result.mime || "application/octet-stream",
    downloadUrl: makeDownloadUrl(
      request,
      auth.identity.userId,
      auth.sessionId,
      result.fileId,
      expires,
      sig,
    ),
  });
}

async function handleWatchStart(request: Request, env: MiniAppEnv): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json({ ok: false, message: "Invalid request." }, 400);
  const auth = await authenticate(body, env);
  if (!auth) return json({ ok: false, message: "Open this Mini App from Telegram." }, 401);

  const videoId = String(body.videoId || "");
  const rawQuality = body.quality;
  const quality = rawQuality == null || rawQuality === "" ? null : Number(rawQuality);
  if (!VIDEO_ID_RE.test(videoId)) {
    return json({ ok: false, message: "This watch session is invalid." }, 400);
  }
  if (
    quality != null &&
    (!Number.isInteger(quality) ||
      !WATCH_QUALITY_VALUES.includes(quality as (typeof WATCH_QUALITY_VALUES)[number]))
  ) {
    return json({ ok: false, message: "This watch quality is invalid." }, 400);
  }

  const streamId = crypto.randomUUID().replace(/-/g, "");
  const container = getContainer(
    env.YOUTUBE_DOWNLOADER_CONTAINER,
    miniContainerId(auth.identity.userId, auth.sessionId),
  );
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
    watchSignaturePayload(auth.identity.userId, auth.sessionId, result.streamId, expires),
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
    streamUrl: makeWatchUrl(
      request,
      auth.identity.userId,
      auth.sessionId,
      result.streamId,
      expires,
      sig,
    ),
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
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !SESSION_RE.test(sessionId) ||
    !FILE_ID_RE.test(fileId) ||
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + DOWNLOAD_TTL_SECONDS + 60 ||
    !/^[a-f0-9]{64}$/i.test(sig)
  ) {
    return new Response("Download link expired or invalid.", { status: 403 });
  }
  const expected = await signValue(
    env.BOT_TOKEN,
    downloadSignaturePayload(userId, sessionId, fileId, expires),
  );
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) {
    return new Response("Download link expired or invalid.", { status: 403 });
  }

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(userId, sessionId));
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const source = await container.fetch(
    new Request(`http://container/mini/file?fileId=${encodeURIComponent(fileId)}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    }),
  );
  if (!source.ok && source.status !== 206) {
    return new Response("File is no longer available. Prepare it again.", { status: 404 });
  }

  const outgoing = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("access-control-allow-origin", "https://web.telegram.org");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, {
    status: source.status,
    headers: outgoing,
  });
}

async function handleWatchStream(request: Request, env: MiniAppEnv): Promise<Response> {
  const url = new URL(request.url);
  const userId = Number(url.searchParams.get("u") || "0");
  const sessionId = url.searchParams.get("s") || "";
  const streamId = url.searchParams.get("w") || "";
  const expires = Number(url.searchParams.get("e") || "0");
  const sig = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !SESSION_RE.test(sessionId) ||
    !FILE_ID_RE.test(streamId) ||
    !Number.isSafeInteger(expires) ||
    expires < now ||
    expires > now + WATCH_TTL_SECONDS + 60 ||
    !/^[a-f0-9]{64}$/i.test(sig)
  ) {
    return new Response("Stream link expired or invalid.", { status: 403 });
  }
  const expected = await signValue(
    env.BOT_TOKEN,
    watchSignaturePayload(userId, sessionId, streamId, expires),
  );
  if (!constantTimeEqual(expected.toLowerCase(), sig.toLowerCase())) {
    return new Response("Stream link expired or invalid.", { status: 403 });
  }

  const container = getContainer(env.YOUTUBE_DOWNLOADER_CONTAINER, miniContainerId(userId, sessionId));
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const ifRange = request.headers.get("if-range");
  if (ifRange) headers.set("if-range", ifRange);
  const source = await container.fetch(
    new Request(`http://container/mini/watch?streamId=${encodeURIComponent(streamId)}`, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
    }),
  );
  if (!source.ok && source.status !== 206) {
    return new Response("Stream is no longer available.", { status: 404 });
  }

  const outgoing = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = source.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  outgoing.set("cache-control", "private, no-store");
  outgoing.set("cross-origin-resource-policy", "cross-origin");
  outgoing.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, {
    status: source.status,
    headers: outgoing,
  });
}

function htmlResponse(): Response {
  return new Response(MINI_APP_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleMiniAppRequestV2(
  request: Request,
  env: MiniAppEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === MINI_APP_PATH || url.pathname === `${MINI_APP_PATH}/`) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    return request.method === "HEAD"
      ? new Response(null, { headers: htmlResponse().headers })
      : htmlResponse();
  }
  if (url.pathname === `${MINI_APP_PATH}/api/metadata` && request.method === "POST") {
    return handleMetadata(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/api/start` && request.method === "POST") {
    return handleStart(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/api/status` && request.method === "POST") {
    return handleStatus(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/api/watch` && request.method === "POST") {
    return handleWatchStart(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/file` && (request.method === "GET" || request.method === "HEAD")) {
    return handleFile(request, env);
  }
  if (url.pathname === `${MINI_APP_PATH}/stream` && (request.method === "GET" || request.method === "HEAD")) {
    return handleWatchStream(request, env);
  }
  if (url.pathname.startsWith(`${MINI_APP_PATH}/`)) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}
