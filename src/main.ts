import { membershipState, setMembershipEnabled, setMembershipMode, MEMBERSHIP_MODES, MEMBERSHIP_MODE_LABELS, type MembershipMode } from "./membership";
import downloaderWorker from "./entry";
import {
  telegramTextMotion,
  telegramCustomEmoji,
  isAdmin,
  INSTAGRAM_API_ACCOUNTS,
  instagramApiToken,
  instagramApiSettings,
  instagramAccountBudget,
  setInstagramApi,
  type InstagramProvider,
  type ApifyAccount,
  type InstagramApiSecrets,
  AdminStatsStore,
  adminDashboardKeyboard,
  adminUsersKeyboard,
  adminUserDetailKeyboard,
  formatAdminUserDetail,
  getAdminUserDetail,
  formatAdminDashboard,
  formatAdminUsers,
  getAdminUsage,
  getDownloadStatistics,
  formatDownloadStatistics,
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

type Env = AdminStatsEnv & InstagramApiSecrets & {
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
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  await telegramTextMotion(env.BOT_TOKEN, method, payload, { animateEdits: true, adminEnv: env });
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramCustomEmoji(method, payload, env)),
  });
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result as T;
}

async function safeTelegramCall(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await telegramCall(env, method, payload);
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
  await telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text: formatAdminDashboard(summary),
    reply_markup: adminDashboardKeyboard(),
  });
}

async function handleAdminCallback(env: Env, query: TelegramCallbackQuery): Promise<Response> {
  if (!isAdmin(env, query.from.id)) return Response.json({ ok: true });

  const message = query.message;
  const data = query.data || "";
  if (!message) {
    await safeTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id });
    return Response.json({ ok: true });
  }

  await safeTelegramCall(env, "answerCallbackQuery", { callback_query_id: query.id });

  try {
    if (data === "admin:downloads") {
      const stats = await getDownloadStatistics(env);
      await telegramCall(env, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id,
        text: formatDownloadStatistics(stats), parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "🔄 بروزرسانی آمار دانلود", callback_data: "admin:downloads" }],
          [{ text: "بازگشت به پنل", callback_data: "admin:stats" }],
        ] },
      }).catch(error => {
        if (!(error instanceof Error) || !/message is not modified/i.test(error.message)) throw error;
      });
      return Response.json({ ok: true });
    }

    if (data === "admin:igbudget") {
      const text = await instagramAccountBudget(env);
      await telegramCall(env, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id, text,
        reply_markup: { inline_keyboard: [
          [{ text: "🔄 بروزرسانی موجودی", callback_data: "admin:igbudget" }],
          [{ text: "انتخاب سرویس و اکانت", callback_data: "admin:igapi" }],
        ] },
      }).catch(error => {
        if (!(error instanceof Error) || !/message is not modified/i.test(error.message)) throw error;
      });
      return Response.json({ ok: true });
    }

    const apiMatch = /^admin:igapi(?::(posts|stories|both)(?::(apify|brightdata):([1-4]))?)?$/.exec(data);
    // Old dashboard buttons open the current settings, without changing them.
    if (apiMatch || /^admin:apify(?::[1-4])?$/.test(data)) {
      const scope = apiMatch?.[1] as "posts" | "stories" | "both" | undefined;
      let notice = "";
      if (scope && apiMatch?.[2]) {
        const selection = { provider: apiMatch[2] as InstagramProvider, account: Number(apiMatch[3]) as ApifyAccount };
        if (scope !== "posts" && selection.provider === "brightdata")
          notice = "Bright Data فعلاً مسیر مستند و متصل برای استوری/هایلایت ندارد؛ انتخاب تغییر نکرد.\n\n";
        else if (!instagramApiToken(env, selection)) notice = "کلید این اکانت هنوز در Secrets تنظیم نشده است.\n\n";
        else await setInstagramApi(env, scope, selection);
      }
      const settings = await instagramApiSettings(env);
      const label = (item: typeof settings.posts) => `${item.provider === "apify" ? "Apify" : "Bright Data"} — اکانت ${item.account}`;
      const title = scope === "posts" ? "پست و ریلز" : scope === "stories" ? "استوری و هایلایت" : "هر دو";
      const rows = scope ? ["apify", "brightdata"].flatMap(provider => {
        if (provider === "brightdata" && scope !== "posts") return [[{
          text: "Bright Data — استوری پشتیبانی نمی‌شود", callback_data: `admin:igapi:${scope}:brightdata:1`,
        }]];
        return INSTAGRAM_API_ACCOUNTS.map(account => {
          const selection = { provider: provider as InstagramProvider, account };
          const active = (scope === "both" ? [settings.posts, settings.stories] : [settings[scope]])
            .every(item => item.provider === provider && item.account === account);
          return [{ text: `${active ? "✅ " : ""}${label(selection)} — ${instagramApiToken(env, selection) ? "تنظیم شده" : "تنظیم نشده"}`,
            callback_data: `admin:igapi:${scope}:${provider}:${account}` }];
        });
      }) : [
        [{ text: "پست و ریلز", callback_data: "admin:igapi:posts" }],
        [{ text: "استوری و هایلایت", callback_data: "admin:igapi:stories" }],
        [{ text: "اعمال یک انتخاب برای هر دو", callback_data: "admin:igapi:both" }],
      ];
      await telegramCall(env, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id,
        text: `${notice}🔑 API اینستاگرام${scope ? " — " + title : ""}\n\nپست و ریلز: ${label(settings.posts)}\nاستوری و هایلایت: ${label(settings.stories)}\n\nتغییر فقط برای دانلودهای جدید است. جایگزینی خودکار سرویس یا اکانت وجود ندارد.`,
        reply_markup: { inline_keyboard: [...rows, [{ text: "💳 مصرف و اعتبار اکانت‌ها", callback_data: "admin:igbudget" }], [{ text: scope ? "بازگشت به تنظیمات API" : "بازگشت به پنل",
          callback_data: scope ? "admin:igapi" : "admin:stats" }]] },
      }).catch(error => {
        if (!(error instanceof Error) || !/message is not modified/i.test(error.message)) throw error;
      });
      return Response.json({ ok: true });
    }

    const membershipMatch = /^admin:membership(?::(enable|disable|after_download|start|first_link))?$/.exec(data);
    if (membershipMatch) {
      if (membershipMatch[1] === "enable" || membershipMatch[1] === "disable") await setMembershipEnabled(env, membershipMatch[1] === "enable");
      else if (membershipMatch[1]) await setMembershipMode(env, membershipMatch[1] as MembershipMode);
      const state = await membershipState(env);
      const title = "عضویت اجباری چنل";
      const status = `وضعیت: ${state.enabled ? "فعال ✅" : "غیرفعال"}`;
      const text = `${title}\n\n${status}\nزمان درخواست عضویت: ${MEMBERSHIP_MODE_LABELS[state.mode]}\nزمان دلخواه را از دکمه‌های زیر انتخاب کن.`;
      await telegramCall(env, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id, text,
        entities: [{ type: "bold", offset: 0, length: title.length },
          { type: "bold", offset: text.indexOf(status), length: status.length }],
        reply_markup: { inline_keyboard: [
          [{ text: state.enabled ? "غیرفعال کردن عضویت اجباری" : "فعال کردن عضویت اجباری",
            callback_data: `admin:membership:${state.enabled ? "disable" : "enable"}` }],
          ...MEMBERSHIP_MODES.map(mode => [{ text: `${state.mode === mode ? "✅ " : ""}${MEMBERSHIP_MODE_LABELS[mode]}`, callback_data: `admin:membership:${mode}` }]),
          [{ text: "بازگشت به پنل", callback_data: "admin:stats" }],
        ] },
      });
      return Response.json({ ok: true });
    }

    if (data === "admin:stats") {
      const summary = await getAdminSummary(env);
      await telegramCall(env, "editMessageText", {
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
      await telegramCall(env, "editMessageText", {
        chat_id: message.chat.id, message_id: message.message_id, text: formatAdminUsage(usage),
        reply_markup: { inline_keyboard: [[{ text: "🔄 بروزرسانی", callback_data: data }], [{ text: "بازگشت", callback_data: back }]] },
      });
      return Response.json({ ok: true });
    }

    const userMatch = /^admin:user:([1-9]\d{0,15}):(\d{1,8}):(\d{1,8})(:used)?(?::(day|week))?$/.exec(data);
    if (userMatch) {
      const detail = await getAdminUserDetail(env, userMatch[1], Number(userMatch[3]));
      await telegramCall(env, "editMessageText", {
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
      await telegramCall(env, "editMessageText", {
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
    await safeTelegramCall(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: "❌ آمار پنل ادمین فعلاً در دسترس نیست.",
      reply_markup: adminDashboardKeyboard(),
    });
  }

  return Response.json({ ok: true });
}

async function handleAdminCommand(env: Env, message: TelegramMessage): Promise<Response> {
  if (!isAdmin(env, message.from?.id)) {
    return Response.json({ ok: true });
  }

  try {
    await sendAdminDashboard(env, message.chat.id);
  } catch (error) {
    console.error("admin panel open failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    await safeTelegramCall(env, "sendMessage", {
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
        if (user && !isAdmin(env, user.id)) {
          await recordUserActivity(env, user, isInstagramDownloadLink(text), update.update_id, /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text));
        }
      }

      return downloaderWorker.fetch(request, env);
    }

    return downloaderWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
