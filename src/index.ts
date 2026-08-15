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

type SelectedFormat = {
  url: string;
  mime: string;
  size: number;
  height: number | null;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const MEDIA_LINK_TTL_SECONDS = 10 * 60;
const TELEGRAM_URL_FILE_LIMIT = 19_000_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const ANDROID_VR = {
  name: "ANDROID_VR",
  version: "1.65.10",
  clientId: "28",
  sdkVersion: 32,
  deviceMake: "Oculus",
  deviceModel: "Quest 3",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
} as const;

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

async function fetchPlayer(videoId: string): Promise<PlayerResponse> {
  const response = await fetch(
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        origin: "https://www.youtube.com",
        referer: "https://www.youtube.com/",
        "user-agent": ANDROID_VR.userAgent,
        "x-youtube-client-name": ANDROID_VR.clientId,
        "x-youtube-client-version": ANDROID_VR.version,
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: "en",
            gl: "US",
            clientName: ANDROID_VR.name,
            clientVersion: ANDROID_VR.version,
            androidSdkVersion: ANDROID_VR.sdkVersion,
            deviceMake: ANDROID_VR.deviceMake,
            deviceModel: ANDROID_VR.deviceModel,
            osName: "Android",
            osVersion: "12L",
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
    throw new Error(`YOUTUBE_PLAYER_HTTP_${response.status}`);
  }

  const player = await response.json<PlayerResponse>();
  const status = player.playabilityStatus?.status || "UNKNOWN";
  if (status !== "OK") {
    const reason = player.playabilityStatus?.reason || status;
    throw new Error(`YOUTUBE_PLAYABILITY:${status}:${reason}`);
  }
  if (player.videoDetails?.isLiveContent) {
    throw new Error("LIVE_VIDEO");
  }

  return player;
}

function chooseTelegramFormat(player: PlayerResponse): SelectedFormat {
  const formats = player.streamingData?.formats ?? [];
  const candidates: Array<SelectedFormat & { bitrate: number }> = [];

  for (const format of formats) {
    if (!format.url) continue;
    const mime = String(format.mimeType || "").toLowerCase();
    if (!mime.startsWith("video/mp4")) continue;
    if (!format.audioQuality) continue;

    const size = Number(format.contentLength);
    if (!Number.isSafeInteger(size) || size <= 0 || size > TELEGRAM_URL_FILE_LIMIT) continue;

    candidates.push({
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

    const mediaUrl = await createSignedMediaUrl(env.BOT_TOKEN, youtube.videoId);
    await telegramCall(env.BOT_TOKEN, "sendVideo", {
      chat_id: message.chat.id,
      video: mediaUrl,
      supports_streaming: true,
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
    const player = await fetchPlayer(videoId);
    const selected = chooseTelegramFormat(player);

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

    const upstreamHeaders = new Headers({
      accept: "*/*",
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/",
      "user-agent": ANDROID_VR.userAgent,
    });
    const range = request.headers.get("range");
    if (range) upstreamHeaders.set("range", range);

    const upstream = await fetch(selected.url, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error("youtube stream fetch failed", { videoId, status: upstream.status });
      return new Response("YouTube stream unavailable", { status: 502 });
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
    return new Response("Media unavailable", { status: 502 });
  }
}

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("wrong file identifier/http url specified") || value.includes("failed to get http url content")) {
    return "❌ نتونستم فایل این ویدیو رو از YouTube بگیرم. یه لینک دیگه امتحان کن.";
  }
  if (value.includes("too big") || value.includes("file is too big")) {
    return "❌ این ویدیو برای ارسال مستقیم داخل تلگرام زیادی حجیمه.";
  }
  return "❌ نتونستم این ویدیو رو دانلود کنم. یه لینک دیگه امتحان کن.";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-youtube-downloader",
          mode: "free-worker-direct-stream",
          domain: "downloader.vexaagent.workers.dev",
          botConfigured: Boolean(env.BOT_TOKEN),
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
