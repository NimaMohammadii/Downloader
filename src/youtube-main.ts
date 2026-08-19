import { Container, getContainer } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import storyWorker from "./story-main";
import {
  ADMIN_USER_ID,
  recordSuccessfulDelivery,
  recordUserActivity,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore } from "./admin";

const SUPPORTED_QUALITIES = [360, 480, 720, 1080] as const;
type YoutubeQuality = (typeof SUPPORTED_QUALITIES)[number];

type YoutubeDownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  userId: number;
  url: string;
  quality?: YoutubeQuality;
  statusMessageId?: number;
};

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOAD_WORKFLOW: Workflow<YoutubeDownloadJob>;
  YOUTUBE_DOWNLOADER_CONTAINER: DurableObjectNamespace<YoutubeDownloaderContainer>;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type ContainerResult = {
  ok: boolean;
  message?: string;
  title?: string;
  parts?: number;
  quality?: number;
};

type YoutubeMetadataResult = {
  ok: boolean;
  message?: string;
  title?: string;
  videoId?: string;
  qualities?: number[];
};

type ParsedQualityCallback = {
  videoId: string;
  quality: YoutubeQuality;
  requestMessageId: number;
  userId: number;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";

export class YoutubeDownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

export class YoutubeDownloadWorkflow extends WorkflowEntrypoint<Env, YoutubeDownloadJob> {
  async run(event: WorkflowEvent<YoutubeDownloadJob>, step: WorkflowStep) {
    const job = event.payload;
    let statusMessageId = job.statusMessageId;

    try {
      if (!job.quality) {
        statusMessageId = await step.do(
          "show youtube quality status",
          {
            retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
            timeout: "1 minute",
          },
          async () => {
            const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: "🔎 دارم کیفیت‌های موجود این ویدیو رو بررسی می‌کنم…",
              reply_parameters: { message_id: job.requestMessageId },
            });
            return status.message_id;
          },
        );

        const metadata = await step.do(
          "inspect youtube qualities",
          {
            retries: { limit: 1, delay: "1 second", backoff: "constant" },
            timeout: "5 minutes",
          },
          async () => {
            const container = getContainer(this.env.YOUTUBE_DOWNLOADER_CONTAINER, `meta-${job.id}`);
            const response = await container.fetch(
              new Request("http://container/metadata", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: job.url }),
              }),
            );
            if (!response.ok) {
              throw new Error(`YouTube metadata container returned HTTP ${response.status}`);
            }
            return (await response.json()) as YoutubeMetadataResult;
          },
        );

        if (!metadata.ok || !metadata.videoId) {
          await step.do("show youtube metadata error", async () => {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: metadata.message || "❌ کیفیت‌های این ویدیو دریافت نشد. دوباره لینک رو بفرست.",
            });
            return true;
          });
          return;
        }

        const qualities = normalizeQualities(metadata.qualities);
        if (qualities.length === 0) {
          await step.do("show no youtube qualities", async () => {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: "❌ برای این ویدیو کیفیت 360p تا 1080p قابل دانلود پیدا نشد.",
            });
            return true;
          });
          return;
        }

        await step.do("show youtube quality buttons", async () => {
          await telegramCall(this.env.BOT_TOKEN, "editMessageText", {
            chat_id: job.chatId,
            message_id: statusMessageId,
            text: `${formatVideoTitle(metadata.title)}\n\nکیفیت ویدیو رو انتخاب کن:`,
            reply_markup: {
              inline_keyboard: buildQualityKeyboard(
                qualities,
                metadata.videoId!,
                job.requestMessageId,
                job.userId,
              ),
            },
          });
          return true;
        });
        return;
      }

      if (!statusMessageId) {
        statusMessageId = await step.do(
          "show youtube download status",
          {
            retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
            timeout: "1 minute",
          },
          async () => {
            const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: `⏳ کیفیت ${job.quality}p انتخاب شد؛ دانلود شروع شد…`,
              reply_parameters: { message_id: job.requestMessageId },
            });
            return status.message_id;
          },
        );
      }

      const result = await step.do(
        "download and send youtube video",
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
          timeout: "30 minutes",
        },
        async () => {
          const container = getContainer(this.env.YOUTUBE_DOWNLOADER_CONTAINER, job.id);
          const response = await container.fetch(
            new Request("http://container/download", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...job,
                statusMessageId,
                botToken: this.env.BOT_TOKEN,
              }),
            }),
          );

          if (!response.ok) {
            throw new Error(`YouTube container returned HTTP ${response.status}`);
          }

          return (await response.json()) as ContainerResult;
        },
      );

      if (result.ok) {
        await step.do("record youtube delivery", async () => {
          await recordSuccessfulDelivery(this.env, `youtube:${job.id}`);
          return true;
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("youtube workflow failed", { jobId: job.id, detail });

      await step.do(
        "notify youtube workflow failure",
        {
          retries: { limit: 3, delay: "3 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          if (statusMessageId) {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: "❌ دانلود YouTube انجام نشد. یک‌بار دیگه لینک رو بفرست.",
            });
          } else {
            await safeTelegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: "❌ دانلود YouTube انجام نشد. یک‌بار دیگه لینک رو بفرست.",
              reply_parameters: { message_id: job.requestMessageId },
            });
          }
          return true;
        },
      );
    }
  }
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
  const data = (await response.json()) as TelegramApiResponse<T>;
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
    console.warn("youtube telegram call failed", {
      method,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function isYoutubeQuality(value: number): value is YoutubeQuality {
  return SUPPORTED_QUALITIES.includes(value as YoutubeQuality);
}

function normalizeQualities(values: number[] | undefined): YoutubeQuality[] {
  if (!Array.isArray(values)) return [];
  return SUPPORTED_QUALITIES.filter((quality) => values.includes(quality));
}

function formatVideoTitle(title: string | undefined): string {
  const clean = (title || "YouTube video").replace(/\s+/g, " ").trim();
  const truncated = clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
  return `🎬 ${truncated}`;
}

function qualityLabel(quality: YoutubeQuality): string {
  if (quality === 360) return "360p • کم‌حجم";
  if (quality === 480) return "480p • معمولی";
  if (quality === 720) return "⭐ 720p HD";
  return "1080p Full HD";
}

function buildQualityKeyboard(
  qualities: YoutubeQuality[],
  videoId: string,
  requestMessageId: number,
  userId: number,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons = qualities.map((quality) => ({
    text: qualityLabel(quality),
    callback_data: `ytq|${videoId}|${quality}|${requestMessageId}|${userId}`,
  }));
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return rows;
}

function parseQualityCallback(data: string | undefined): ParsedQualityCallback | null {
  if (!data) return null;
  const match = /^ytq\|([A-Za-z0-9_-]{6,20})\|(360|480|720|1080)\|(\d+)\|(\d+)$/.exec(data);
  if (!match) return null;

  const quality = Number(match[2]);
  const requestMessageId = Number(match[3]);
  const userId = Number(match[4]);
  if (
    !isYoutubeQuality(quality) ||
    !Number.isSafeInteger(requestMessageId) ||
    requestMessageId <= 0 ||
    !Number.isSafeInteger(userId) ||
    userId <= 0
  ) {
    return null;
  }

  return {
    videoId: match[1],
    quality,
    requestMessageId,
    userId,
  };
}

function extractYouTubeUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const isYoutube =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");

      if (isYoutube && (url.protocol === "https:" || url.protocol === "http:")) {
        return url.toString();
      }
    } catch {
      // Keep scanning URLs in the message.
    }
  }

  return null;
}

function isStartCommand(text: string): boolean {
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text.trim());
}

function trackedUser(message: TelegramMessage): TrackedUser | null {
  const id = message.from?.id ?? (message.chat.id > 0 ? message.chat.id : 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username: message.from?.username,
    firstName: message.from?.first_name,
    lastName: message.from?.last_name,
  };
}

async function createYoutubeInspectWorkflow(
  env: Env,
  update: TelegramUpdate,
  url: string,
): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  if (user && user.id !== ADMIN_USER_ID) {
    await recordUserActivity(env, user, true);
  }

  const userId = user?.id ?? message.chat.id;
  const job: YoutubeDownloadJob = {
    id: `ytq-${update.update_id}`,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    userId,
    url,
  };

  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already|exists|duplicate|conflict/i.test(detail)) {
      console.error("youtube inspect workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "❌ نتونستم کیفیت‌های YouTube رو بررسی کنم. دوباره لینک رو بفرست.",
        reply_parameters: { message_id: message.message_id },
      });
    }
  }

  return Response.json({ ok: true });
}

async function handleQualityCallback(
  env: Env,
  update: TelegramUpdate,
  callback: TelegramCallbackQuery,
): Promise<Response> {
  const parsed = parseQualityCallback(callback.data);
  if (!parsed || !callback.message) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "این انتخاب دیگه معتبر نیست.",
      show_alert: false,
    });
    return Response.json({ ok: true });
  }

  if (callback.from.id !== parsed.userId) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "این دکمه برای شما نیست.",
      show_alert: true,
    });
    return Response.json({ ok: true });
  }

  const job: YoutubeDownloadJob = {
    id: `ytdl-${update.update_id}`,
    chatId: callback.message.chat.id,
    requestMessageId: parsed.requestMessageId,
    userId: parsed.userId,
    url: `https://www.youtube.com/watch?v=${parsed.videoId}`,
    quality: parsed.quality,
    statusMessageId: callback.message.message_id,
  };

  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({ id: job.id, params: job });
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: `${parsed.quality}p انتخاب شد`,
      show_alert: false,
    });
    await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
      chat_id: job.chatId,
      message_id: job.statusMessageId,
      text: `⏳ کیفیت ${parsed.quality}p انتخاب شد؛ دانلود شروع شد…`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already|exists|duplicate|conflict/i.test(detail)) {
      console.error("youtube download workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "شروع دانلود ناموفق بود. دوباره لینک رو بفرست.",
        show_alert: true,
      });
    }
  }

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/telegram/webhook" &&
      request.headers.get("x-telegram-bot-api-secret-token") === WEBHOOK_SECRET
    ) {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        // Let the existing worker keep its current malformed-update behavior.
      }

      if (update?.callback_query?.data?.startsWith("ytq|")) {
        return handleQualityCallback(env, update, update.callback_query);
      }

      const message = update?.message;
      if (update && message) {
        const text = (message.text || message.caption || "").trim();

        if (isStartCommand(text)) {
          const user = trackedUser(message);
          if (user && user.id !== ADMIN_USER_ID) {
            await recordUserActivity(env, user, false);
          }
          await telegramCall(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: "لینک ویدیوی YouTube، Shorts، Reel، پست یا Story اینستاگرام رو بفرست؛ فایلش رو همین‌جا برات می‌فرستم ⚡️",
          });
          return Response.json({ ok: true });
        }

        const youtubeUrl = extractYouTubeUrl(text);
        if (youtubeUrl) {
          return createYoutubeInspectWorkflow(env, update, youtubeUrl);
        }
      }
    }

    // Instagram, admin panel and media proxy remain on the existing worker unchanged.
    return storyWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
