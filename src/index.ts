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
  size: number;
  client: YoutubeClient;
};

type CandidateFormat = {
  itag: number;
  height: number | null;
  size: number | null;
  bitrate: number;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const TELEGRAM_UPLOAD_FILE_LIMIT = 49_000_000;
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

      await step.do(
        "upload video to telegram",
        {
          retries: { limit: 1, delay: "2 seconds", backoff: "constant" },
          timeout: "2 hours",
        },
        async () => {
          const { info } = await resolveMediaInfo(job.videoId, video.itag, video.client);
          const stream = await info.download({ itag: video.itag });

          await telegramUploadVideo(
            this.env.BOT_TOKEN,
            {
              chatId: job.chatId,
              replyMessageId: job.requestMessageId,
              videoId: job.videoId,
              title: video.title,
              duration: video.duration,
              size: video.size,
            },
            stream,
          );

          return true;
        },
      );

      if (statusMessageId) {
        await step.do(
          "remove status",
          {
            retries: { limit: 2, delay: "1 second", backoff: "linear" },
            timeout: "1 minute",
          },
          async () => {
            await safeTelegramCall(this.env.BOT_TOKEN, "deleteMessage", {
              chat_id: job.chatId,
              message_id: statusMessageId,
            });
            return true;
          },
        );
      }
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
  let sawOversizedFormat = false;

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

      const telegramFormats = formats.filter(
        (format) => format.size !== null && format.size <= TELEGRAM_UPLOAD_FILE_LIMIT,
      );

      if (!telegramFormats.length) {
        if (formats.some((format) => format.size !== null)) sawOversizedFormat = true;
        throw new Error("NO_TELEGRAM_SIZED_FORMAT");
      }

      const preferredFormats = telegramFormats.some((format) => (format.height ?? 0) <= 720)
        ? telegramFormats.filter((format) => (format.height ?? 0) <= 720)
        : telegramFormats;

      preferredFormats.sort((a, b) => {
        const heightDiff = (b.height ?? 0) - (a.height ?? 0);
        return heightDiff || b.bitrate - a.bitrate;
      });

      const selected = preferredFormats[0];
      if (!selected || selected.size === null) {
        throw new Error("NO_TELEGRAM_SIZED_FORMAT");
      }

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
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "PRIVATE_VIDEO" || detail === "LIVE_VIDEO") throw error;
      failures.push(`${client}: ${detail}`);
      console.warn("youtube client failed", { videoId, client, detail });
    }
  }

  if (sawOversizedFormat) {
    throw new Error("VIDEO_TOO_LARGE_FOR_TELEGRAM");
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

async function telegramUploadVideo(
  token: string,
  options: {
    chatId: number;
    replyMessageId: number;
    videoId: string;
    title: string;
    duration: number | null;
    size: number;
  },
  videoStream: ReadableStream<Uint8Array>,
): Promise<TelegramMessage> {
  if (!Number.isSafeInteger(options.size) || options.size <= 0) {
    throw new Error("VIDEO_SIZE_UNKNOWN");
  }
  if (options.size > TELEGRAM_UPLOAD_FILE_LIMIT) {
    throw new Error("VIDEO_TOO_LARGE_FOR_TELEGRAM");
  }

  const boundary = `----tg-${crypto.randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const fields: Array<[string, string]> = [
    ["chat_id", String(options.chatId)],
    ["caption", options.title.slice(0, 1024)],
    ["supports_streaming", "true"],
    ["reply_parameters", JSON.stringify({ message_id: options.replyMessageId })],
  ];
  if (options.duration) fields.push(["duration", String(Math.round(options.duration))]);

  let prefix = "";
  for (const [name, value] of fields) {
    prefix += `--${boundary}\r\n`;
    prefix += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
    prefix += `${value}\r\n`;
  }
  prefix += `--${boundary}\r\n`;
  prefix += `Content-Disposition: form-data; name="video"; filename="youtube-${options.videoId}.mp4"\r\n`;
  prefix += "Content-Type: video/mp4\r\n\r\n";

  const suffix = `\r\n--${boundary}--\r\n`;
  const prefixBytes = encoder.encode(prefix);
  const suffixBytes = encoder.encode(suffix);
  const totalLength = prefixBytes.byteLength + options.size + suffixBytes.byteLength;
  const { readable, writable } = new FixedLengthStream(totalLength);
  const writer = writable.getWriter();

  const uploadPromise = fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: readable,
  });

  const pumpPromise = (async () => {
    const reader = videoStream.getReader();
    let transferred = 0;
    try {
      await writer.write(prefixBytes);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        transferred += value.byteLength;
        if (transferred > options.size) {
          throw new Error("YOUTUBE_STREAM_SIZE_MISMATCH");
        }
        await writer.write(value);
      }
      if (transferred !== options.size) {
        throw new Error(`YOUTUBE_STREAM_SIZE_MISMATCH:${transferred}/${options.size}`);
      }
      await writer.write(suffixBytes);
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  })();

  const [response] = await Promise.all([uploadPromise, pumpPromise]);
  const data = await response.json<TelegramApiResponse<TelegramMessage>>();
  if (!response.ok || !data.ok || !data.result) {
    throw new Error(data.description || "Telegram sendVideo upload failed");
  }

  return data.result;
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

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("private_video") || value.includes("private")) {
    return "❌ این ویدیو Private هست و قابل دانلود نیست.";
  }
  if (value.includes("live_video") || value.includes("live")) {
    return "❌ دانلود Live فعلاً پشتیبانی نمی‌شه.";
  }
  if (value.includes("video_too_large_for_telegram") || value.includes("no_telegram_sized_format")) {
    return "❌ حجم این ویدیو برای ارسال مستقیم داخل تلگرام بیشتر از حد مجازه.";
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
          mode: "telegram-direct-upload",
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

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
