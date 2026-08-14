import { Container, getContainer } from "@cloudflare/containers";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

type Env = {
  BOT_TOKEN: string;
  DOWNLOAD_WORKFLOW: Workflow<DownloadJob>;
  DOWNLOADER_CONTAINER: DurableObjectNamespace<DownloaderContainer>;
};

type DownloadJob = {
  id: string;
  chatId: number;
  requestMessageId: number;
  url: string;
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

type ContainerResult = {
  ok: boolean;
  message?: string;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";

export class DownloaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
}

export class DownloadWorkflow extends WorkflowEntrypoint<Env, DownloadJob> {
  async run(event: WorkflowEvent<DownloadJob>, step: WorkflowStep) {
    const job = event.payload;
    let statusMessageId: number | undefined;

    try {
      statusMessageId = await step.do(
        "show download status",
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
              text: "⏳ لینک گرفتم، دارم آماده‌ش می‌کنم…",
              reply_parameters: { message_id: job.requestMessageId },
            },
          );
          return message.message_id;
        },
      );

      await step.do(
        "download and send video",
        {
          // A retry after a partial Telegram upload could duplicate a video part,
          // so the end-to-end media step is intentionally single-attempt.
          retries: { limit: 1, delay: "1 second", backoff: "constant" },
          timeout: "2 hours",
        },
        async () => {
          const container = getContainer(this.env.DOWNLOADER_CONTAINER, job.id);
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
            throw new Error(`Container returned HTTP ${response.status}`);
          }

          const result = await response.json<ContainerResult>();
          return result;
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error("download workflow failed", { jobId: job.id, detail });

      await step.do(
        "notify unexpected failure",
        {
          retries: { limit: 3, delay: "3 seconds", backoff: "linear" },
          timeout: "1 minute",
        },
        async () => {
          if (statusMessageId) {
            await telegramCall(this.env.BOT_TOKEN, "editMessageText", {
              chat_id: job.chatId,
              message_id: statusMessageId,
              text: "❌ دانلود انجام نشد. یک‌بار دیگه لینک رو بفرست.",
            });
          } else {
            await telegramCall(this.env.BOT_TOKEN, "sendMessage", {
              chat_id: job.chatId,
              text: "❌ دانلود انجام نشد. یک‌بار دیگه لینک رو بفرست.",
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

  const data = await response.json<TelegramApiResponse<T>>();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }

  return data.result as T;
}

function extractYouTubeUrl(text: string): string | null {
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

      if (isYouTube && (url.protocol === "https:" || url.protocol === "http:")) {
        return url.toString();
      }
    } catch {
      // Ignore malformed URLs and continue searching the message.
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
  if (!message) {
    return Response.json({ ok: true });
  }

  const text = (message.text || message.caption || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "لینک ویدیوی YouTube یا Shorts رو بفرست؛ خودم دانلودش می‌کنم و همین‌جا می‌فرستم. ⚡️",
    });
    return Response.json({ ok: true });
  }

  const youtubeUrl = extractYouTubeUrl(text);
  if (!youtubeUrl) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "یه لینک معتبر YouTube برام بفرست 👇",
      reply_parameters: { message_id: message.message_id },
    });
    return Response.json({ ok: true });
  }

  const workflowId = `tg-${update.update_id}`;
  const job: DownloadJob = {
    id: workflowId,
    chatId: message.chat.id,
    requestMessageId: message.message_id,
    url: youtubeUrl,
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
    // Telegram retries webhooks when it does not receive a successful response.
    // Reusing update_id as the Workflow ID makes duplicate updates idempotent.
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.toLowerCase().includes("already")) {
      console.error("failed to create workflow", { workflowId, detail });
      return new Response("Failed to enqueue", { status: 500 });
    }
  }

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-youtube-downloader",
          domain: "downloader.vexaagent.workers.dev",
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
