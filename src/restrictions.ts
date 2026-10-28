import { telegramTextMotion, isAdmin, type AdminStatsEnv } from "./admin";

type RestrictionEnv = Partial<AdminStatsEnv> & { BOT_TOKEN?: string; WEBHOOK_SECRET?: string };
export type Restriction = { restricted: boolean; until: number | null };
const EMOJI = "5260293700088511294";
const durations = [[1800, "۳۰ دقیقه"], [3600, "۱ ساعت"], [21600, "۶ ساعت"], [86400, "۱ روز"], [604800, "۷ روز"], [-1, "دائمی"], [0, "رفع محدودیت"]] as const;

export async function userRestriction(env: RestrictionEnv, id: number): Promise<Restriction> {
  if (!env.ADMIN_STATS || isAdmin(env, id)) return { restricted: false, until: null };
  const response = await env.ADMIN_STATS.getByName("global").fetch(`https://admin-stats/restriction?id=${id}`);
  if (!response.ok) throw new Error("RESTRICTION_STATE_UNAVAILABLE");
  return response.json();
}

export function parseRestrictionDuration(text: string): number | null {
  const normalized = text.trim().replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/٫/g, ".");
  const match = /^(\d+(?:\.\d+)?)\s*(دقیقه|ساعت|روز|هفته|minutes?|mins?|m|hours?|h|days?|d|weeks?|w)$/i.exec(normalized);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const factor = /^(دقیقه|minutes?|mins?|m)$/.test(unit) ? 60
    : /^(ساعت|hours?|h)$/.test(unit) ? 3600 : /^(روز|days?|d)$/.test(unit) ? 86400 : 604800;
  const seconds = Number(match[1]) * factor;
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 365 * 86400 ? seconds : null;
}

function date(value: number): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(value);
}

export function restrictionNotice(state: Restriction): { text: string; entities: Record<string, unknown>[] } {
  const title = "دسترسی دانلودت محدود شده";
  let remaining = "بدون زمان پایان";
  if (state.until !== null) {
    let seconds = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
    const parts: string[] = [];
    for (const [unit, size] of [["روز", 86400], ["ساعت", 3600], ["دقیقه", 60], ["ثانیه", 1]] as const) {
      const count = Math.floor(seconds / size);
      seconds %= size;
      if (count) parts.push(`${count.toLocaleString("fa-IR", { useGrouping: false })} ${unit}`);
    }
    remaining = parts.join(" و ") || "۰ ثانیه";
  }
  const label = state.until === null ? "مدت محدودیت:" : "زمان باقی‌مانده:";
  const footer = state.until === null
    ? "فعلاً امکان ثبت دانلود تازه برات فعال نیست."
    : "بعد از پایان این زمان، دسترسی دانلودت خودکار فعال می‌شه.";
  const text = `⏹ ${title}\n\nیه مکث توی دانلودها؛ هنوز اینجاییم و همراهتیم.\n\n${label} ${remaining}\n${footer}\n\nمرسی از همراهی و صبوری‌ات 💜`;
  const entities: Record<string, unknown>[] = [
    { type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: EMOJI },
    ...[title, label, remaining].map(value => ({ type: "bold", offset: text.indexOf(value), length: value.length })),
    { type: "custom_emoji", offset: text.indexOf("💜"), length: "💜".length, custom_emoji_id: "5442678635909621223" },
  ];
  return { text, entities };
}

async function telegram(env: RestrictionEnv, method: string, payload: Record<string, unknown>): Promise<void> {
  // Keep the friendly restriction notice and its explicit emoji intact.
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  const result = await response.json() as { ok: boolean; description?: string };
  if (method === "editMessageText" && /message is not modified/i.test(result.description || "")) return;
  if (!response.ok || !result.ok) throw new Error("RESTRICTION_TELEGRAM_UNAVAILABLE");
}

// Gate the trusted webhook before membership, caches, download commands and quality callbacks.
export async function enforceRestriction(request: Request, env: RestrictionEnv): Promise<Response | null> {
  if (!env.ADMIN_STATS || !env.BOT_TOKEN || request.method !== "POST" || new URL(request.url).pathname !== "/telegram/webhook"
      || request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1")) return null;
  const update = await request.clone().json().catch(() => null) as any;
  const query = update?.callback_query;
  const actor = query?.from || update?.message?.from;
  if (!Number.isSafeInteger(actor?.id) || actor.id <= 0) return null;
  if (isAdmin(env, actor.id)) {
    const restrictedPage = /^admin:restricted:(\d{1,8})$/.exec(query?.data || "");
    if (restrictedPage && query.message) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
      const response = await env.ADMIN_STATS.getByName("global").fetch(`https://admin-stats/restricted-users?page=${restrictedPage[1]}`);
      if (!response.ok) throw new Error("RESTRICTED_USERS_UNAVAILABLE");
      const list = await response.json() as { users: { id: string; name: string; until: number | null }[]; total: number; page: number; totalPages: number };
      const nav = [];
      if (list.page > 0) nav.push({ text: "‹ قبلی", callback_data: `admin:restricted:${list.page - 1}` });
      if (list.page + 1 < list.totalPages) nav.push({ text: "بعدی ›", callback_data: `admin:restricted:${list.page + 1}` });
      await telegram(env, "editMessageText", {
        chat_id: query.message.chat.id, message_id: query.message.message_id,
        text: `⏹ کاربران محدودشده (${list.total})\nصفحه ${list.page + 1}/${list.totalPages}\n\n` +
          (list.users.length ? list.users.map(user => `${user.id} • ${user.until === null ? "دائمی" : `تا ${date(user.until)} (تهران)`}`).join("\n") + "\n\nبرای مشاهده و تغییر محدودیت، کاربر را انتخاب کن." : "هیچ کاربری محدودیت فعال ندارد."),
        reply_markup: { inline_keyboard: [
          ...list.users.map(user => [{ text: `${user.name.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 35)} • ${user.id}`, callback_data: `admin:restriction:${user.id}:0:0` }]),
          ...(nav.length ? [nav] : []),
          [{ text: "🔄 بروزرسانی", callback_data: `admin:restricted:${list.page}` }],
          [{ text: "بازگشت به پنل", callback_data: "admin:stats" }],
        ] },
      });
      return Response.json({ ok: true });
    }
    const message = update?.message;
    const reply = message?.reply_to_message;
    // Force-reply prompts carry their target, so restarts and parallel admin sessions
    // cannot redirect a duration to a different user. Only replies to this bot count.
    const target = reply?.from?.id === Number(env.BOT_TOKEN.split(":")[0]) && reply?.from?.is_bot
      ? /^مدت محدودیت کاربر ([1-9]\d{0,15})\n/.exec(reply.text || "") : null;
    if (target) {
      const seconds = parseRestrictionDuration(String(message.text || ""));
      if (seconds === null) {
        await telegram(env, "sendMessage", { chat_id: message.chat.id,
          text: "مدت را با عدد و واحد بفرست؛ مثلاً ۴۵ دقیقه، ۲ ساعت یا ۳ روز. بازهٔ مجاز بیشتر از صفر تا ۳۶۵ روز است. دوباره به پیام درخواست زمان پاسخ بده.",
          reply_parameters: { message_id: reply.message_id } });
        return Response.json({ ok: true });
      }
      const response = await env.ADMIN_STATS.getByName("global").fetch(`https://admin-stats/restriction?id=${target[1]}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorId: actor.id, seconds }),
      });
      const state = response.ok ? await response.json() as Restriction : null;
      await telegram(env, "sendMessage", { chat_id: message.chat.id,
        text: state ? `محدودیت کاربر ${target[1]} تا ${date(state.until!)} (تهران) ثبت شد.` : "تنظیم محدودیت انجام نشد؛ کاربر باید در فهرست کاربران باشد و ادمین نباشد.",
        reply_markup: { inline_keyboard: [[{ text: "بازگشت به محدودیت کاربر", callback_data: `admin:restriction:${target[1]}:0:0` }]] } });
      return Response.json({ ok: true });
    }
    const custom = /^admin:customlimit:([1-9]\d{0,15})$/.exec(query?.data || "");
    if (custom && query.message) {
      await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
      await telegram(env, "sendMessage", { chat_id: query.message.chat.id,
        text: `مدت محدودیت کاربر ${custom[1]}\nبه همین پیام پاسخ بده و زمان دلخواهت را بنویس؛ مثلاً ۴۵ دقیقه، ۲ ساعت، ۱٫۵ ساعت یا ۳ روز.\nحداکثر ۳۶۵ روز. برای انصراف، پاسخ نده و به پنل برگرد.`,
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "مثلاً ۲ ساعت یا ۳ روز" },
        reply_parameters: { message_id: query.message.message_id } });
      return Response.json({ ok: true });
    }
    const menu = /^admin:restriction:([1-9]\d{0,15}):(\d{1,8}):(\d{1,8})(:used)?(?::(day|week))?$/.exec(query?.data || "");
    const action = /^admin:limit:([1-9]\d{0,15}):(-?\d{1,8})$/.exec(query?.data || "");
    if ((!menu && !action) || !query.message) return null;
    await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
    const id = (menu || action)![1];
    if (action) {
      const seconds = Number(action[2]);
      if (!durations.some(([value]) => value === seconds)) return Response.json({ ok: true });
      const response = await env.ADMIN_STATS.getByName("global").fetch(`https://admin-stats/restriction?id=${id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actorId: actor.id, seconds }),
      });
      if (!response.ok) {
        await telegram(env, "sendMessage", { chat_id: query.message.chat.id, text: "تنظیم محدودیت انجام نشد؛ کاربر باید در فهرست کاربران باشد و ادمین نباشد." });
        return Response.json({ ok: true });
      }
    }
    const state = await userRestriction(env, Number(id));
    const back = menu ? query.data.replace("admin:restriction:", "admin:user:") : `admin:user:${id}:0:0`;
    await telegram(env, "editMessageText", {
      chat_id: query.message.chat.id, message_id: query.message.message_id,
      text: `محدودیت دانلود کاربر ${id}\nوضعیت: ${state.restricted ? state.until === null ? "محدودیت دائمی" : `محدود تا ${date(state.until)} (تهران)` : "بدون محدودیت"}\n\nمدت محدودیت را انتخاب کن؛ محدودیت موقت خودکار تمام می‌شود.`,
      reply_markup: { inline_keyboard: [
        [{ text: "زمان دلخواه ✍️", callback_data: `admin:customlimit:${id}` }],
        ...durations.map(([seconds, label]) => [{ text: label, callback_data: `admin:limit:${id}:${seconds}` }]),
        [{ text: "بازگشت به کاربر", callback_data: back }],
        [{ text: "کاربران محدودشده", callback_data: "admin:restricted:0" }],
      ] },
    });
    return Response.json({ ok: true });
  }
  // Leave onboarding/help available; all download inputs and callbacks are checked.
  const text = String(update?.message?.text || "").trim();
  if (/^\/(?:start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return null;
  const state = await userRestriction(env, actor.id);
  if (!state.restricted) return null;
  if (query?.id) await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
  const chat = query?.message?.chat?.id || update?.message?.chat?.id;
  if (chat) {
    const payload = { chat_id: chat, ...restrictionNotice(state) };
    await telegramTextMotion(env.BOT_TOKEN, "sendMessage", payload, { adminEnv: env });
    await telegram(env, "sendMessage", payload);
  }
  return Response.json({ ok: true });
}
