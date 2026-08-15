type Env = {
  BOT_TOKEN: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type PlayerFormat = {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  contentLength?: string;
  audioQuality?: string;
  drmFamilies?: string[];
};

type PlayerResponse = {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    title?: string;
    lengthSeconds?: string;
    isLiveContent?: boolean;
  };
  streamingData?: {
    formats?: PlayerFormat[];
  };
};

type YoutubeClient = {
  key: "VISIONOS" | "ANDROID_VR";
  name: string;
  version: string;
  clientId: string;
  userAgent: string;
  context: Record<string, string | number>;
};

type SelectedFormat = {
  itag: number;
  url: string;
  mime: string;
  size: number;
  height: number | null;
  bitrate: number;
};

type ResolvedMedia = {
  client: YoutubeClient;
  format: SelectedFormat;
  title: string;
  duration: number | null;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const MEDIA_LINK_TTL_SECONDS = 10 * 60;
const TELEGRAM_URL_FILE_LIMIT = 19_000_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const VISIONOS: YoutubeClient = {
  key: "VISIONOS",
  name: "VISIONOS",
  version: "1.02",
  clientId: "101",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  context: {
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    platform: "MOBILE",
  },
};

const ANDROID_VR: YoutubeClient = {
  key: "ANDROID_VR",
  name: "ANDROID_VR",
  version: "1.65.10",
  clientId: "28",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  context: {
    androidSdkVersion: 32,
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    osName: "Android",
    osVersion: "12L",
    platform: "MOBILE",
    clientFormFactor: "SMALL_FORM_FACTOR",
  },
};

const YOUTUBE_CLIENTS: YoutubeClient[] = [VISIONOS, ANDROID_VR];

async function telegramCall<T = unknown>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json<TelegramApiResponse<T>>();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result as T;
}

async function safeTelegramCall(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await telegramCall(token, method, payload);
  } catch (error) {
    console.warn(`Telegram ${method} failed`, error);
  }
}

function extractYouTubeVideo(text: string): { url: string; videoId: string } | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      let videoId: string | null = null;

      if (host === "youtu.be") {
        videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
      } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
        if (url.pathname === "/watch") {
          videoId = url.searchParams.get("v");
        } else {
          const parts = url.pathname.split("/").filter(Boolean);
          if (["shorts", "embed", "live", "v"].includes(parts[0] || "")) {
            videoId = parts[1] ?? null;
          }
        }
      }

      if (videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return { url: url.toString(), videoId };
      }
    } catch {
      // Continue to the next URL in the message.
    }
  }

  return null;
}

function youtubeStreamHeaders(client: YoutubeClient): Headers {
  return new Headers({
    accept: "*/*",
    origin: "https://www.youtube.com",
    referer: "https://www.youtube.com/",
    "user-agent": client.userAgent,
  });
}

async function fetchPlayer(videoId: string, client: YoutubeClient): Promise<PlayerResponse> {
  const response = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false&alt=json",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        origin: "https://www.youtube.com",
        "user-agent": client.userAgent,
        "x-youtube-client-name": client.clientId,
        "x-youtube-client-version": client.version,
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: "en",
            gl: "US",
            clientName: client.name,
            clientVersion: client.version,
            ...client.context,
          },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
          },
        },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`${client.key}_PLAYER_HTTP_${response.status}`);
  }

  const player = await response.json<PlayerResponse>();
  const status = player.playabilityStatus?.status || "UNKNOWN";
  if (status !== "OK") {
    const reason = player.playabilityStatus?.reason || status;
    throw new Error(`${client.key}_PLAYABILITY:${status}:${reason}`);
  }
  if (player.videoDetails?.isLiveContent) {
    throw new Error("LIVE_VIDEO");
  }

  return player;
}

function chooseTelegramFormat(player: PlayerResponse): SelectedFormat {
  const formats = player.streamingData?.formats ?? [];
  const candidates: SelectedFormat[] = [];

  for (const format of formats) {
    if (!format.url) continue;
    if (format.drmFamilies?.length) continue;

    const mime = String(format.mimeType || "").toLowerCase();
    if (!mime.startsWith("video/mp4")) continue;
    if (!format.audioQuality) continue;

    const itag = Number(format.itag);
    const size = Number(format.contentLength);
    if (!Number.isInteger(itag)) continue;
    if (!Number.isSafeInteger(size) || size <= 0 || size > TELEGRAM_URL_FILE_LIMIT) continue;

    candidates.push({
      itag,
      url: format.url,
      mime: String(format.mimeType || "video/mp4").split(";")[0],
      size,
      height: Number.isFinite(Number(format.height)) ? Number(format.height) : null,
      bitrate: Number.isFinite(Number(format.bitrate)) ? Number(format.bitrate) : 0,
    });
  }

  if (!candidates.length) {
    throw new Error("NO_TELEGRAM_URL_FORMAT");
  }

  candidates.sort((a, b) => {
    const heightDiff = (b.height ?? 0) - (a.height ?? 0);
    return heightDiff || b.bitrate - a.bitrate;
  });

  return candidates[0];
}

async function probeYoutubeStream(format: SelectedFormat, client: YoutubeClient): Promise<void> {
  const probeUrl = new URL(format.url);
  probeUrl.searchParams.set("range", "0-1023");

  const response = await fetch(probeUrl.toString(), {
    method: "GET",
    headers: youtubeStreamHeaders(client),
    redirect: "follow",
  });

  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${client.key}_GVS_HTTP_${response.status}`);
  }

  await response.body?.cancel().catch(() => undefined);
}

async function resolvePlayableMedia(videoId: string): Promise<ResolvedMedia> {
  const failures: string[] = [];

  for (const client of YOUTUBE_CLIENTS) {
    try {
      const player = await fetchPlayer(videoId, client);
      const format = chooseTelegramFormat(player);
      await probeYoutubeStream(format, client);

      console.log("youtube media resolved", {
        videoId,
        client: client.key,
        itag: format.itag,
        height: format.height,
        size: format.size,
      });

      return {
        client,
        format,
        title: (player.videoDetails?.title || "YouTube video").trim(),
        duration: Number.isFinite(Number(player.videoDetails?.lengthSeconds))
          ? Number(player.videoDetails?.lengthSeconds)
          : null,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "LIVE_VIDEO") throw error;
      failures.push(detail);
      console.warn("youtube client failed", { videoId, client: client.key, detail });
    }
  }

  throw new Error(`YOUTUBE_ALL_CLIENTS_FAILED:${failures.join(" | ")}`);
}

function parseTelegramRange(rangeHeader: string | null): { start: number; end: string } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  return { start, end: match[2] || "" };
}

async function createSignedMediaUrl(token: string, videoId: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_SECONDS;
  const payload = `${videoId}.${expires}`;
  const signature = await signMediaToken(token, payload);
  const url = new URL(`${BASE_URL}/media/${videoId}`);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("sig", signature);
  return url.toString();
}

async function signMediaToken(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  const bytes = new Uint8Array(signed);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message) return Response.json({ ok: true });

  const text = (message.text || message.caption || "").trim();
  if (text === "/start" || text.startsWith("/start ")) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "لینک YouTube یا Shorts رو بفرست؛ خود ویدیو رو همین‌جا می‌فرستم ⚡️",
    });
    return Response.json({ ok: true });
  }

  const youtube = extractYouTubeVideo(text);
  if (!youtube) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "یه لینک معتبر YouTube یا Shorts بفرست 👇",
      reply_parameters: { message_id: message.message_id },
    });
    return Response.json({ ok: true });
  }

  let statusMessageId: number | undefined;
  try {
    const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⏳ لینک گرفتم، دارم ویدیو رو می‌فرستم…",
      reply_parameters: { message_id: message.message_id },
    });
    statusMessageId = status.message_id;

    // Resolve and actually probe the Google Video stream before asking Telegram to fetch it.
    // This catches YouTube client / PO-token / GVS failures instead of hiding them behind
    // Telegram's generic "failed to get HTTP URL content" message.
    const resolved = await resolvePlayableMedia(youtube.videoId);
    const mediaUrl = await createSignedMediaUrl(env.BOT_TOKEN, youtube.videoId);

    await telegramCall(env.BOT_TOKEN, "sendVideo", {
      chat_id: message.chat.id,
      video: mediaUrl,
      caption: resolved.title.slice(0, 1024),
      supports_streaming: true,
      ...(resolved.duration ? { duration: Math.round(resolved.duration) } : {}),
      reply_parameters: { message_id: message.message_id },
    });

    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("telegram delivery failed", { videoId: youtube.videoId, detail });
    const friendly = friendlyError(detail);

    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
        text: friendly,
      });
    } else {
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: friendly,
        reply_parameters: { message_id: message.message_id },
      });
    }
  }

  return Response.json({ ok: true });
}

async function handleMedia(request: Request, env: Env, url: URL): Promise<Response> {
  const videoId = url.pathname.split("/").filter(Boolean)[1] || "";
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return new Response("Bad media link", { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expires) || expires < now || expires > now + MEDIA_LINK_TTL_SECONDS + 120) {
    return new Response("Media link expired", { status: 403 });
  }

  const expected = await signMediaToken(env.BOT_TOKEN, `${videoId}.${expires}`);
  if (!constantTimeEqual(signature, expected)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const resolved = await resolvePlayableMedia(videoId);
    const selected = resolved.format;

    const headers = new Headers({
      "content-type": selected.mime,
      "content-length": String(selected.size),
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="youtube-${videoId}.mp4"`,
    });

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const upstreamUrl = new URL(selected.url);
    const telegramRange = parseTelegramRange(request.headers.get("range"));
    if (telegramRange) {
      upstreamUrl.searchParams.set("range", `${telegramRange.start}-${telegramRange.end}`);
    }

    const upstream = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: youtubeStreamHeaders(resolved.client),
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error("youtube stream fetch failed", {
        videoId,
        client: resolved.client.key,
        status: upstream.status,
      });
      return new Response(`YouTube stream unavailable: ${upstream.status}`, { status: 502 });
    }

    const responseHeaders = new Headers(headers);
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const upstreamType = upstream.headers.get("content-type");
    if (upstreamType) responseHeaders.set("content-type", upstreamType);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("media resolve failed", { videoId, detail });

    if (detail.includes("NO_TELEGRAM_URL_FORMAT")) {
      return new Response("No Telegram-sized format", { status: 413 });
    }
    if (detail.includes("LIVE_VIDEO")) {
      return new Response("Live video unsupported", { status: 422 });
    }
    return new Response(`Media unavailable: ${detail.slice(0, 160)}`, { status: 502 });
  }
}

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();

  if (value.includes("live_video")) {
    return "❌ دانلود Live فعلاً پشتیبانی نمی‌شه.";
  }
  if (value.includes("no_telegram_url_format")) {
    return "❌ نسخه‌ی MP4 مناسب برای ارسال مستقیم داخل تلگرام پیدا نشد یا حجمش بیشتر از 20MB بود.";
  }
  if (value.includes("gvs_http_403")) {
    return "❌ YouTube استریم این ویدیو رو برای سرور Cloudflare با خطای 403 بسته. این محدودیت خود YouTube هست.";
  }
  if (value.includes("youtube_all_clients_failed")) {
    return "❌ YouTube به هیچ‌کدوم از مسیرهای مستقیم اجازه‌ی گرفتن این ویدیو رو نداد.";
  }
  if (
    value.includes("wrong file identifier/http url specified") ||
    value.includes("failed to get http url content")
  ) {
    return "❌ استریم از YouTube تست شد ولی Telegram نتونست فایل رو از Worker دریافت کنه.";
  }
  if (value.includes("too big") || value.includes("file is too big")) {
    return "❌ این ویدیو برای ارسال مستقیم داخل تلگرام زیادی حجیمه.";
  }

  return "❌ دانلود ویدیو انجام نشد. خطای دقیق توی لاگ Cloudflare ثبت شد.";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-youtube-downloader",
          mode: "free-worker-direct-stream-v2",
          domain: "downloader.vexaagent.workers.dev",
          botConfigured: Boolean(env.BOT_TOKEN),
          youtubeClients: YOUTUBE_CLIENTS.map((client) => client.key),
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram YouTube Downloader is running.");
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
      return handleMedia(request, env, url);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
