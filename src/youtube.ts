import { Container, getContainer } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  recordSuccessfulDelivery,
  type AdminStatsEnv,
} from "./admin";

export type YouTubeDownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  url: string;
};

type ContainerResult = {
  ok: boolean;
  title?: string;
  parts?: number;
  message?: string;
};

export type YouTubeEnv = AdminStatsEnv & {
  BOT_TOKEN: string;
  YOUTUBE_DOWNLOAD_WORKFLOW: Workflow<YouTubeDownloadJob>;
  YOUTUBE_DOWNLOADER: DurableObjectNamespace<YouTubeDownloaderContainer>;
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

export class YouTubeDownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
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

export function extractYouTubeUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const isYouTube =
        host === "youtu.be" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com") ||
        host === "youtube-nocookie.com" ||
        host.endsWith(".youtube-nocookie.com");
      if (!isYouTube) continue;
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      return url.toString();
    } catch {
      // Keep scanning URLs in the message.
    }
  }
  return null;
}

export function isYouTubeDownloadLink(text: string): boolean {
  return extractYouTubeUrl(text) !== null;
}

export async function enqueueYouTubeDownload(
  update: TelegramUpdate,
  env: YouTubeEnv,
): Promise<Response> {
  const message = update.message;
  if (!message) return Response.json({ ok: true });

  const text = (message.text || message.caption || "").trim();
  const url = extractYouTubeUrl(text);
  if (!url) return Response.json({ ok: true });

  const id = `yt-${update.update_id}`;
  const job: YouTubeDownloadJob = {
    id,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    url,
  };

  try {
    await env.YOUTUBE_DOWNLOAD_WORKFLOW.create({
      id,
      params: job,
      retention: {
        successRetention: "1 day",
        errorRetention: "3 days",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/already|exists|duplicate/i.test(detail)) {
      console.error("youtube workflow create failed", { id, detail });
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "❌ نتونستم دانلود YouTube رو شروع کنم. دوباره لینک رو بفرست.",
        reply_parameters: { message_id: message.message_id },
      });
    }
  }

  return Response.json({ ok: true });
}

export class YouTubeDownloadWorkflow extends WorkflowEntrypoint<YouTubeEnv, YouTubeDownloadJob> {
  async run(event: WorkflowEvent<YouTubeDownloadJob>, step: WorkflowStep) {
    const job = event.payload;
    let statusMessageId: number | undefined;

    try {
      statusMessageId = await step.do(
        "show youtube status",
        {
          retries: { limit: 3, delay: "2 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          const status = await telegramCall<TelegramMessage>(this.env.BOT_TOKEN, "sendMessage", {
            chat_id: job.chatId,
            text: "⏳ لینک YouTube گرفتم؛ دارم ویدیو رو آماده می‌کنم…",
            reply_parameters: { message_id: job.requestMessageId },
          });
          return status.message_id;
        },
      );

      const result = await step.do(
        "download youtube and upload telegram",
        {
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
        },
        async () => {
          const container = getContainer(this.env.YOUTUBE_DOWNLOADER, job.id);
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
            throw new Error(`YOUTUBE_CONTAINER_HTTP_${response.status}`);
          }
          return (await response.json()) as ContainerResult;
        },
      );

      if (result.ok) {
        await step.do("record youtube delivery", async () => {
          await recordSuccessfulDelivery(this.env, job.id);
          return true;
        });
      }

      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("youtube workflow failed", { id: job.id, detail });

      await step.do(
        "notify youtube failure",
        {
          retries: { limit: 2, delay: "3 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          if (statusMessageId) {
            await safeTelegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: "❌ دانلود YouTube انجام نشد. دوباره لینک رو بفرست.",
            });
          } else {
            await safeTelegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: "❌ دانلود YouTube انجام نشد. دوباره لینک رو بفرست.",
              reply_parameters: { message_id: job.requestMessageId },
            });
          }
          return true;
        },
      );

      return { ok: false, message: detail } satisfies ContainerResult;
    }
  }
}
