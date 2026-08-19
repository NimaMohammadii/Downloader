import appWorker from "./story-main";
import {
  ADMIN_USER_ID,
  recordUserActivity,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";
import {
  enqueueYouTubeDownload,
  extractYouTubeUrl,
  type YouTubeEnv,
} from "./youtube";

export { AdminStatsStore } from "./admin";
export { YouTubeDownloaderContainer, YouTubeDownloadWorkflow } from "./youtube";

type Env = AdminStatsEnv & YouTubeEnv & {
  BOT_TOKEN: string;
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

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";

function trackedUser(message: TelegramMessage): TrackedUser | null {
  const source = message.from;
  const id = source?.id ?? (message.chat.id > 0 ? message.chat.id : 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username: source?.username,
    firstName: source?.first_name,
    lastName: source?.last_name,
  };
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

async function handleStart(env: Env, message: TelegramMessage): Promise<Response> {
  const user = trackedUser(message);
  if (user && user.id !== ADMIN_USER_ID) {
    await recordUserActivity(env, user, false);
  }

  await telegramCall(env.BOT_TOKEN, "sendMessage", {
    chat_id: message.chat.id,
    text: "لینک YouTube یا Instagram رو بفرست؛ ویدیو رو دانلود می‌کنم و همین‌جا می‌فرستم ⚡️",
  });
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/telegram/webhook" &&
      request.headers.get("x-telegram-bot-api-secret-token") === WEBHOOK_SECRET
    ) {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        return appWorker.fetch(request, env as any, ctx);
      }

      const message = update.message;
      if (message) {
        const text = (message.text || message.caption || "").trim();
        if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
          return handleStart(env, message);
        }

        if (extractYouTubeUrl(text)) {
          const user = trackedUser(message);
          if (user && user.id !== ADMIN_USER_ID) {
            await recordUserActivity(env, user, true);
          }
          return enqueueYouTubeDownload(update, env);
        }
      }
    }

    return appWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
