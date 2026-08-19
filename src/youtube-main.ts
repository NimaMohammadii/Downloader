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

type YoutubeDownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  url: string;
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

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
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
    let statusMessageId: number | undefined;

    try {
      statusMessageId = await step.do(
        "show youtube download status",
        {
          retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
            chat_id: job.chatId,
            text: "⏳ لینک YouTube رو گرفتم، دارم ویدیو رو آماده می‌کنم…",
            reply_parameters: { message_id: job.requestMessageId },
          });
          return status.message_id;
        },
      );

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
      console.error("youtube download workflow failed", { jobId: job.id, detail });

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

async function createYoutubeWorkflow(env: Env, update: TelegramUpdate, url: string): Promise<Response> {
  const message = update.message!;
  const user = trackedUser(message);
  if (user && user.id !== ADMIN_USER_ID) {
    await recordUserActivity(env, user, true);
  }

  const job: YoutubeDownloadJob = {
    id: `yt-${update.update_id}`,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    url,
  };

  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({
      id: job.id,
      params: job,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Telegram can retry the same webhook. Reusing update_id makes the workflow idempotent.
    if (!/already|exists|duplicate|conflict/i.test(detail)) {
      console.error("youtube workflow create failed", { jobId: job.id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "❌ نتونستم دانلود YouTube رو شروع کنم. دوباره لینک رو بفرست.",
        reply_parameters: { message_id: message.message_id },
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
          return createYoutubeWorkflow(env, update, youtubeUrl);
        }
      }
    }

    // Instagram, admin panel and media proxy remain on the existing worker unchanged.
    return storyWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
