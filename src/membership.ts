import { ADMIN_USER_ID, telegramCustomEmoji, type AdminStatsEnv } from "./admin";

// The channel must be public and this bot must be a channel administrator.
export const MEMBERSHIP_CHANNEL = "@VexaOrder";

type MembershipEnv = Partial<AdminStatsEnv> & { BOT_TOKEN?: string; WEBHOOK_SECRET?: string; MEMBERSHIP_CHANNEL?: string };
export type MembershipState = { enabled: boolean; downloaded: boolean };

export async function membershipState(env: Partial<AdminStatsEnv>, userId?: number): Promise<MembershipState> {
  if (!env.ADMIN_STATS) return { enabled: false, downloaded: false };
  const url = new URL("https://admin-stats/membership");
  if (userId !== undefined) url.searchParams.set("user", String(userId));
  const response = await env.ADMIN_STATS.getByName("global").fetch(url.toString());
  if (!response.ok) throw new Error("MEMBERSHIP_STATE_UNAVAILABLE");
  return await response.json() as MembershipState;
}

export async function setMembershipEnabled(env: AdminStatsEnv, enabled: boolean): Promise<void> {
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/membership", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error("MEMBERSHIP_SETTING_UNAVAILABLE");
}

async function telegram(env: MembershipEnv, method: string, payload: Record<string, unknown>): Promise<any> {
  if (!env.BOT_TOKEN) throw new Error("MEMBERSHIP_BOT_UNAVAILABLE");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramCustomEmoji(method, payload)), signal: AbortSignal.timeout(8000),
  });
  const body = await response.json() as { ok: boolean; result?: unknown; error_code?: number; description?: string };
  if (!response.ok || !body.ok) {
    const description = typeof body.description === "string" ? body.description : "";
    // Repeated check callbacks can try to edit an already-updated message.
    if (method === "editMessageText" && /message is not modified/i.test(description)) return;
    // Log bounded classifications, never the request URL, bot token or raw response.
    const reason = /chat not found|chat_id.*invalid|username.*not found/i.test(description) ? "channel_not_found"
      : /CHAT_ADMIN_REQUIRED|not enough rights|not an administrator|member list is inaccessible|bot is not a member|bot was kicked/i.test(description) ? "bot_channel_access"
      : body.error_code === 429 ? "rate_limited" : "telegram_error";
    console.warn("membership Telegram request failed", { method, status: response.status,
      errorCode: body.error_code, reason });
    throw new Error("MEMBERSHIP_TELEGRAM_UNAVAILABLE");
  }
  return body.result;
}

export async function isChannelMember(env: MembershipEnv, userId: number): Promise<boolean> {
  const channel = env.MEMBERSHIP_CHANNEL || MEMBERSHIP_CHANNEL;
  if (!channel) throw new Error("MEMBERSHIP_CHANNEL_UNAVAILABLE");
  const member = await telegram(env, "getChatMember", { chat_id: channel, user_id: userId });
  return ["creator", "administrator", "member"].includes(member?.status)
    || (member?.status === "restricted" && member?.is_member === true);
}

export function membershipPrompt(channel = MEMBERSHIP_CHANNEL): Record<string, unknown> {
  const title = "ادامه با عضویت در کانال";
  const text = `⚡️ ${title}\nعضو کانالمون شو؛ ابزارها و قابلیت‌های جدید هم اونجاست!\nبعد از عضویت، «عضو شدم» رو بزن.`;
  return { text, entities: [{ type: "bold", offset: text.indexOf(title), length: title.length }],
    reply_markup: { inline_keyboard: [[
      { text: "ورود به کانال", url: `https://t.me/${channel.replace(/^@/, "")}` },
      { text: "✅ عضو شدم", callback_data: "membership:check" },
    ]] },
  };
}

export async function notifyFirstDownload(env: MembershipEnv, userId: number): Promise<void> {
  if (!env.BOT_TOKEN || userId === ADMIN_USER_ID) return;
  const state = await membershipState(env, userId);
  if (!state.enabled || !state.downloaded || await isChannelMember(env, userId)) return;
  await telegram(env, "sendMessage", { chat_id: userId, ...membershipPrompt(env.MEMBERSHIP_CHANNEL || MEMBERSHIP_CHANNEL) });
}

// Run once at the production webhook boundary, before any delegated command or callback.
export async function enforceMembership(request: Request, env: MembershipEnv): Promise<Response | null> {
  if (!env.ADMIN_STATS || !env.BOT_TOKEN || request.method !== "POST"
      || new URL(request.url).pathname !== "/telegram/webhook"
      || request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1")) return null;
  let update: any;
  try { update = await request.clone().json(); } catch { return null; }
  const callback = update?.callback_query;
  const actor = callback?.from || update?.message?.from;
  if (!Number.isSafeInteger(actor?.id) || actor.id <= 0 || actor.id === ADMIN_USER_ID) return null;
  const checking = callback?.data === "membership:check";
  let state: MembershipState;
  let member = false;
  try {
    state = await membershipState(env, actor.id);
    if (state.enabled && state.downloaded) member = await isChannelMember(env, actor.id);
  } catch {
    if (callback?.id) await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, text: "بررسی عضویت فعلاً ممکن نیست؛ کمی بعد دوباره امتحان کن.", show_alert: true,
    });
    else await telegram(env, "sendMessage", { chat_id: update.message.chat.id,
      text: "بررسی عضویت فعلاً ممکن نیست؛ کمی بعد دوباره امتحان کن." });
    return Response.json({ ok: true });
  }
  if (!state.enabled || !state.downloaded || member) {
    if (!checking) return null;
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "✅ دسترسی فعاله؛ درخواستت رو بفرست." });
    // Remove the gate only in the user's private chat; shared messages belong to everyone.
    if (callback.message?.chat?.id === actor.id) await telegram(env, "editMessageText", {
      chat_id: actor.id, message_id: callback.message.message_id,
      text: "✅ دسترسی فعاله؛ درخواستت رو بفرست.", reply_markup: { inline_keyboard: [] },
    });
    return Response.json({ ok: true });
  }
  if (callback?.id) await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id,
    text: checking ? "هنوز عضو کانال نیستی؛ اول عضو شو و دوباره بررسی کن." : "برای ادامه، اول عضو کانال شو.", show_alert: true });
  const prompt = membershipPrompt(env.MEMBERSHIP_CHANNEL || MEMBERSHIP_CHANNEL);
  if (checking && callback.message?.chat?.id === actor.id) {
    // Refresh old prompts too, so channel corrections fix their existing join button.
    await telegram(env, "editMessageText", {
      chat_id: actor.id, message_id: callback.message.message_id, ...prompt,
    });
  } else if (!checking) await telegram(env, "sendMessage", {
    chat_id: update.message?.chat?.id || callback.message?.chat?.id || actor.id, ...prompt,
  });
  return Response.json({ ok: true });
}
