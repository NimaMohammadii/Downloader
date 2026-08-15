import { Innertube } from "youtubei.js/cf-worker";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

type Env = {
  BOT_TOKEN: string;
  DOWNLOAD_WORKFLOW: Workflow<DownloadJob>;
};

type DownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  videoId: string;
  sourceUrl: string;
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

type YoutubeClient = "ANDROID_VR" | "IOS" | "WEB" | "ANDROID";

type ResolvedVideo = {
  title: string;
  duration: number | null;
  itag: number;
  height: number | null;
  size: number | null;
  client: YoutubeClient;
  canSendByTelegramUrl: boolean;
};

type CandidateFormat = {
  itag: number;
  height: number | null;
  size: number | null;
  bitrate: number;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const TELEGRAM_REMOTE_FILE_LIMIT = 18_500_000;
const MEDIA_LINK_TTL_SECONDS = 60 * 60;
const YOUTUBE_CLIENTS: YoutubeClient[] = ["ANDROID_VR", "IOS", "WEB", "ANDROID"];
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export class DownloadWorkflow extends WorkflowEntrypoint<Env, DownloadJob> {
  async run(event: WorkflowEvent<DownloadJob>, step: WorkflowStep) {
    const job = event.payload;
    let statusMessageId: number | undefined;

    try {
      statusMessageId = await step.do(
        "show status",
        {
          retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          const message = await telegramCall<TelegramMessage>(
            this.env.BOT_TOKEN,
            "sendMessage",
            {
              chat_id: job.chatId,
              text: "⏳ لینک گرفتم، دارم ویدیو رو آماده می‌کنم…",
              reply_parameters: { message_id: job.requestMessageId },
            },
          );
          return message.message_id;
        },
      );

      const video = await step.do(
        "resolve youtube stream",
        {
          retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
          timeout: "2 minutes",
        },
        async (): Promise<ResolvedVideo> => resolveYoutubeVideo(job.videoId),
      );

      const mediaUrl = await step.do(
        "create secure media link",
        { timeout: "1 minute", retries: { limit: 1, delay: "1 second", backoff: "constant" } },
        async () => createSignedMediaUrl(
          this.env.BOT_TOKEN,
          job.videoId,
          video.itag,
          video.client,
        ),
      );

      await step.do(
        "deliver video",
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
          timeout: "2 hours",
        },
        async () => {
          if (video.canSendByTelegramUrl) {
            try {
              await telegramCall(this.env.BOT_TOKEN, "sendVideo", {
                chat_id: job.chatId,
                video: mediaUrl,
                caption: video.title.slice(0, 1024),
                supports_streaming: true,
                ...(video.duration ? { duration: Math.round(video.duration) } : {}),
                reply_parameters: { message_id: job.requestMessageId },
              });

              if (statusMessageId) {
                await safeTelegramCall(this.env.BOT_TOKEN, "deleteMessage", {
                  chat_id: job.chatId,
                  message_id: statusMessageId,
                });
              }
              return true;
            } catch (error) {
              console.warn("Telegram remote video fetch failed; falling back to link", error);
            }
          }

          const quality = video.height ? `${video.height}p` : "best available";
          const sizeText = video.size ? ` • ${formatBytes(video.size)}` : "";
          const text = `✅ آماده‌ست\n${video.title}\n\nکیفیت: ${quality}${sizeText}\nبرای دانلود روی دکمه بزن 👇`;

          if (statusMessageId) {
            await telegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text,
              reply_markup: {
                inline_keyboard: [[{ text: "⬇️ دانلود ویدیو", url: mediaUrl }]],
              },
            });
          } else {
            await telegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text,
              reply_parameters: { message_id: job.requestMessageId },
              reply_markup: {
                inline_keyboard: [[{ text: "⬇️ دانلود ویدیو", url: mediaUrl }]],
              },
            });
          }

          return true;
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("download workflow failed", { jobId: job.id, detail });

      const friendly = friendlyError(detail);
      await step.do(
        "show failure",
        {
          retries: { limit: 2, delay: "2 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          if (statusMessageId) {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: friendly,
            });
          } else {
            await safeTelegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: friendly,
              reply_parameters: { message_id: job.requestMessageId },
            });
          }
          return true;
        },
      );
    }
  }
}

async function resolveYoutubeVideo(videoId: string): Promise<ResolvedVideo> {
  const youtube = await Innertube.create();
  const failures: string[] = [];

  for (const client of YOUTUBE_CLIENTS) {
    try {
      const info = await youtube.getBasicInfo(videoId, { client });

      if (info.basic_info.is_private) {
        throw new Error("PRIVATE_VIDEO");
      }
      if (info.basic_info.is_live || info.basic_info.is_upcoming) {
        throw new Error("LIVE_VIDEO");
      }

      const formats = collectMuxedFormats(info);
      if (!formats.length) {
        throw new Error("NO_MUXED_FORMAT");
      }

      const preferredFormats = formats.some((format) => (format.height ?? 0) <= 720)
        ? formats.filter((format) => (format.height ?? 0) <= 720)
        : formats;

      preferredFormats.sort((a, b) => {
        const heightDiff = (b.height ?? 0) - (a.height ?? 0);
        return heightDiff || b.bitrate - a.bitrate;
      });

      const telegramCandidate = preferredFormats.find(
        (format) => format.size !== null && format.size <= TELEGRAM_REMOTE_FILE_LIMIT,
      );
      const selected = telegramCandidate ?? preferredFormats[0];

      console.log("youtube stream resolved", {
        videoId,
        client,
        itag: selected.itag,
        height: selected.height,
        size: selected.size,
      });

      return {
        title: (info.basic_info.title || "YouTube video").trim(),
        duration: Number.isFinite(Number(info.basic_info.duration))
          ? Number(info.basic_info.duration)
          : null,
        itag: selected.itag,
        height: selected.height,
        size: selected.size,
        client,
        canSendByTelegramUrl: Boolean(telegramCandidate),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "PRIVATE_VIDEO" || detail === "LIVE_VIDEO") throw error;
      failures.push(`${client}: ${detail}`);
      console.warn("youtube client failed", { videoId, client, detail });
    }
  }

  throw new Error(`YOUTUBE_CLIENTS_FAILED | ${failures.join(" | ")}`);
}

function collectMuxedFormats(info: any): CandidateFormat[] {
  const allFormats = [
    ...(info.streaming_data?.formats ?? []),
    ...(info.streaming_data?.adaptive_formats ?? []),
  ];
  const seen = new Set<number>();
  const formats: CandidateFormat[] = [];

  for (const format of allFormats) {
    if (!format?.has_audio || !format?.has_video) continue;
    if (!String(format.mime_type || "").toLowerCase().includes("video/mp4")) continue;

    const itag = Number(format.itag);
    if (!Number.isInteger(itag) || seen.has(itag)) continue;
    seen.add(itag);

    const rawSize = Number(format.content_length);
    const rawHeight = Number(format.height);
    const rawBitrate = Number(format.bitrate);

    formats.push({
      itag,
      height: Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : null,
      size: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null,
      bitrate: Number.isFinite(rawBitrate) ? rawBitrate : 0,
    });
  }

  return formats;
}

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
      // Continue to the next URL in the Telegram message.
    }
  }

  return null;
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
      text: "لینک YouTube یا Shorts رو بفرست؛ برات آماده‌ش می‌کنم ⚡️",
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

  const workflowId = `tg-${update.update_id}`;
  const job: DownloadJob = {
    id: workflowId,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    videoId: youtube.videoId,
    sourceUrl: youtube.url,
  };

  try {
    await env.DOWNLOAD_WORKFLOW.create({
      id: workflowId,
      params: job,
      retention: {
        successRetention: "1 day",
        errorRetention: "3 days",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.toLowerCase().includes("already")) {
      console.error("failed to create workflow", { workflowId, detail });
      return new Response("Failed to enqueue", { status: 500 });
    }
  }

  return Response.json({ ok: true });
}

async function resolveMediaInfo(videoId: string, itag: number, preferredClient: YoutubeClient) {
  const youtube = await Innertube.create();
  const clients = [preferredClient, ...YOUTUBE_CLIENTS.filter((client) => client !== preferredClient)];
  const failures: string[] = [];

  for (const client of clients) {
    try {
      const info = await youtube.getBasicInfo(videoId, { client });
      const allFormats = [
        ...(info.streaming_data?.formats ?? []),
        ...(info.streaming_data?.adaptive_formats ?? []),
      ];
      const format = allFormats.find((candidate: any) => Number(candidate?.itag) === itag);
      if (!format) throw new Error(`ITAG_${itag}_MISSING`);
      if (!format.has_audio || !format.has_video) throw new Error("FORMAT_NOT_MUXED");
      return { info, format, client };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${client}: ${detail}`);
      console.warn("media client failed", { videoId, itag, client, detail });
    }
  }

  throw new Error(`MEDIA_CLIENTS_FAILED | ${failures.join(" | ")}`);
}

function parseRangeHeader(rangeHeader: string | null, totalSize: number | null) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return undefined;

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || start < 0) return undefined;

  const end = requestedEnd !== null
    ? requestedEnd
    : totalSize !== null
      ? totalSize - 1
      : start + 10 * 1024 * 1024 - 1;

  if (!Number.isSafeInteger(end) || end < start) return undefined;
  if (totalSize !== null && start >= totalSize) return undefined;

  return {
    start,
    end: totalSize !== null ? Math.min(end, totalSize - 1) : end,
  };
}

async function handleMedia(request: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const videoId = parts[1] || "";
  const itag = Number(url.searchParams.get("itag"));
  const client = url.searchParams.get("client") as YoutubeClient;
  const expires = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";

  if (
    !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
    !Number.isInteger(itag) ||
    !YOUTUBE_CLIENTS.includes(client)
  ) {
    return new Response("Bad media link", { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expires) || expires < now || expires > now + MEDIA_LINK_TTL_SECONDS + 120) {
    return new Response("Media link expired", { status: 403 });
  }

  const expected = await signMediaToken(env.BOT_TOKEN, `${videoId}.${itag}.${client}.${expires}`);
  if (!constantTimeEqual(signature, expected)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const { info, format } = await resolveMediaInfo(videoId, itag, client);
    const rawSize = Number(format.content_length);
    const totalSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null;
    const mime = String(format.mime_type || "video/mp4").split(";")[0];
    const range = parseRangeHeader(request.headers.get("range"), totalSize);

    if (range === undefined) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: totalSize !== null ? { "content-range": `bytes */${totalSize}` } : undefined,
      });
    }

    const headers = new Headers();
    headers.set("content-type", mime);
    headers.set("cache-control", "private, no-store");
    headers.set("accept-ranges", "bytes");
    headers.set("content-disposition", `attachment; filename="youtube-${videoId}.mp4"`);

    if (request.method === "HEAD") {
      if (totalSize !== null) headers.set("content-length", String(totalSize));
      return new Response(null, { status: 200, headers });
    }

    if (range) {
      const contentLength = range.end - range.start + 1;
      headers.set("content-length", String(contentLength));
      if (totalSize !== null) {
        headers.set("content-range", `bytes ${range.start}-${range.end}/${totalSize}`);
      }

      const stream = await info.download({
        itag,
        range: { start: range.start, end: range.end },
      });
      return new Response(stream, { status: 206, headers });
    }

    if (totalSize !== null) headers.set("content-length", String(totalSize));
    const stream = await info.download({ itag });
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("media proxy failed", { videoId, itag, client, detail });
    return new Response("Media unavailable", { status: 502 });
  }
}

async function createSignedMediaUrl(
  token: string,
  videoId: string,
  itag: number,
  client: YoutubeClient,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_SECONDS;
  const payload = `${videoId}.${itag}.${client}.${expires}`;
  const signature = await signMediaToken(token, payload);
  const url = new URL(`${BASE_URL}/media/${videoId}`);
  url.searchParams.set("itag", String(itag));
  url.searchParams.set("client", client);
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

function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
}

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("private_video") || value.includes("private")) {
    return "❌ این ویدیو Private هست و قابل دانلود نیست.";
  }
  if (value.includes("live_video") || value.includes("live")) {
    return "❌ دانلود Live فعلاً پشتیبانی نمی‌شه.";
  }
  if (value.includes("login_required") || value.includes("sign in")) {
    return "❌ یوتیوب برای این ویدیو ورود به حساب می‌خواد و فعلاً قابل دانلود نیست.";
  }
  if (value.includes("unavailable") || value.includes("playability")) {
    return "❌ این ویدیو در دسترس نیست یا محدود شده.";
  }
  if (value.includes("youtube_clients_failed") || value.includes("no_muxed_format")) {
    return "❌ یوتیوب فعلاً استریم قابل دانلود این ویدیو رو به سرور نداد. یه لینک دیگه امتحان کن.";
  }
  return "❌ نتونستم این ویدیو رو آماده کنم. یک‌بار دیگه لینک رو بفرست.";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-youtube-downloader",
          mode: "worker-streaming",
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
