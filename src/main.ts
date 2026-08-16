import downloaderWorker from "./entry";
import {
  ADMIN_USER_ID,
  AdminStatsStore,
  adminDashboardKeyboard,
  adminUsersKeyboard,
  formatAdminDashboard,
  formatAdminUsers,
  getAdminSummary,
  getAdminUsersPage,
  isInstagramDownloadLink,
  recordSuccessfulDelivery,
  recordUserActivity,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore };

type Env = AdminStatsEnv & {
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

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
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

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";

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
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
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
    console.warn("admin telegram call failed", {
      method,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function trackedUserFromMessage(message: TelegramMessage): TrackedUser | null {
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

function isAdminCommand(text: string): boolean {
  return /^\/admin(?:@[A-Za-z0-9_]+)?$/i.test(text.trim());
}

async function sendAdminDashboard(env: Env, chatId: number): Promise<void> {
  const summary = await getAdminSummary(env);
  await telegramCall(env.BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: formatAdminDashboard(summary),
    reply_markup: adminDashboardKeyboard(),
  });
}

async function handleAdminCallback(env: Env, query: TelegramCallbackQuery): Promise<Response> {
  if (query.from.id !== ADMIN_USER_ID) return Response.json({ ok: true });

  const message = query.message;
  const data = query.data || "";
  if (!message) {
    await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
    return Response.json({ ok: true });
  }

  await safeTelegramCall(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });

  try {
    if (data === "admin:stats") {
      const summary = await getAdminSummary(env);
      await telegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: formatAdminDashboard(summary),
        reply_markup: adminDashboardKeyboard(),
      });
      return Response.json({ ok: true });
    }

    const usersMatch = /^admin:users:(\d+)$/.exec(data);
    if (usersMatch) {
      const page = await getAdminUsersPage(env, Number(usersMatch[1]));
      await telegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: message.message_id,
        text: formatAdminUsers(page),
        reply_markup: adminUsersKeyboard(page),
      });
      return Response.json({ ok: true });
    }
  } catch (error) {
    console.error("admin panel callback failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: "❌ آمار پنل ادمین فعلاً در دسترس نیست.",
      reply_markup: adminDashboardKeyboard(),
    });
  }

  return Response.json({ ok: true });
}

async function handleAdminCommand(env: Env, message: TelegramMessage): Promise<Response> {
  if (message.from?.id !== ADMIN_USER_ID) {
    return Response.json({ ok: true });
  }

  try {
    await sendAdminDashboard(env, message.chat.id);
  } catch (error) {
    console.error("admin panel open failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "❌ آمار پنل ادمین فعلاً در دسترس نیست.",
    });
  }

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
        return downloaderWorker.fetch(request, env);
      }

      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        return downloaderWorker.fetch(request, env);
      }

      const callback = update.callback_query;
      if (callback?.data?.startsWith("admin:")) {
        return handleAdminCallback(env, callback);
      }

      const message = update.message;
      if (message) {
        const text = (message.text || message.caption || "").trim();
        if (isAdminCommand(text)) return handleAdminCommand(env, message);

        const user = trackedUserFromMessage(message);
        if (user && user.id !== ADMIN_USER_ID) {
          await recordUserActivity(env, user, isInstagramDownloadLink(text));
        }
      }

      return downloaderWorker.fetch(request, env);
    }

    if (request.method === "GET" && url.pathname === "/media") {
      const response = await downloaderWorker.fetch(request, env);
      if (response.ok) {
        const signature = url.searchParams.get("sig") || "";
        const expires = url.searchParams.get("exp") || "";
        if (signature) {
          ctx.waitUntil(recordSuccessfulDelivery(env, `${expires}:${signature}`));
        }
      }
      return response;
    }

    return downloaderWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
