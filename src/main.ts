import downloaderWorker from "./entry";
import {
  telegramTextMotion,
  telegramCustomEmoji,
  ADMIN_USER_ID,
  AdminStatsStore,
  adminDashboardKeyboard,
  adminUsersKeyboard,
  adminUserDetailKeyboard,
  formatAdminUserDetail,
  getAdminUserDetail,
  formatAdminDashboard,
  formatAdminUsers,
  getAdminUsage,
  formatAdminUsage,
  getAdminSummary,
  getAdminUsersPage,
  isInstagramDownloadLink,
  recordUserActivity,
  type AdminStatsEnv,
  type AdminPeriod,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore };

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
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
  await telegramTextMotion(token, method, payload);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramCustomEmoji(method, payload)),
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

    const usageMatch = /^admin:usage(?::([1-9]\d{0,15}):(\d{1,8}):(\d{1,8})(:used)?(?::(day|week))?)?$/.exec(data);
    if (usageMatch) {
      const usage = await getAdminUsage(env, usageMatch[1]);
      const back = usageMatch[1] ? `admin:user:${usageMatch[1]}:${usageMatch[2]}:${usageMatch[3]}${usageMatch[4] || ""}${usageMatch[5] ? `:${usageMatch[5]}` : ""}` : "admin:stats";
      await telegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id, text: formatAdminUsage(usage),
        reply_markup: { inline_keyboard: [[{ text: "🔄 بروزرسانی", callback_data: data }], [{ text: "بازگشت", callback_data: back }]] },
      });
      return Response.json({ ok: true });
    }

    const userMatch = /^admin:user:([1-9]\d{0,15}):(\d{1,8}):(\d{1,8})(:used)?(?::(day|week))?$/.exec(data);
    if (userMatch) {
      const detail = await getAdminUserDetail(env, userMatch[1], Number(userMatch[3]));
      await telegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id,
        text: detail ? formatAdminUserDetail(detail) : "این کاربر پیدا نشد.",
        reply_markup: detail ? adminUserDetailKeyboard(detail, Number(userMatch[2]), Boolean(userMatch[4]), userMatch[5] as AdminPeriod | undefined) : adminDashboardKeyboard(),
        link_preview_options: { is_disabled: true },
      });
      return Response.json({ ok: true });
    }

    const usersMatch = /^admin:(users|used):(\d+)(?::(day|week))?$/.exec(data);
    if (usersMatch) {
      const page = await getAdminUsersPage(env, Number(usersMatch[2]), usersMatch[1] === "used", usersMatch[3] as AdminPeriod | undefined);
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
      if (request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || WEBHOOK_SECRET)) {
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
          await recordUserActivity(env, user, isInstagramDownloadLink(text), update.update_id, /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text));
        }
      }

      return downloaderWorker.fetch(request, env);
    }

    return downloaderWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
