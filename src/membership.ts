import { parseRedditUrl } from "./reddit";
import { parseBandcampUrl } from "./bandcamp";
import { isAdmin, telegramCustomEmoji, telegramTextMotion, type AdminStatsEnv } from "./admin";

// The channel must be public and this bot must be a channel administrator.
export const MEMBERSHIP_CHANNEL = "@VexaOrder";

type MembershipEnv = Partial<AdminStatsEnv> & { BOT_TOKEN?: string; WEBHOOK_SECRET?: string; MEMBERSHIP_CHANNEL?: string };
export const MEMBERSHIP_MODES = ["after_download", "start", "first_link"] as const;
export type MembershipMode = typeof MEMBERSHIP_MODES[number];
export const MEMBERSHIP_MODE_LABELS: Record<MembershipMode, string> = {
  after_download: "بعد از اولین دانلود موفق", start: "هنگام استارت", first_link: "با اولین لینک",
};
export type MembershipState = { enabled: boolean; downloaded: boolean; mode: MembershipMode; linkTriggered: boolean };

export async function membershipState(env: Partial<AdminStatsEnv>, userId?: number, linkRequest = false): Promise<MembershipState> {
  if (!env.ADMIN_STATS) return { enabled: false, downloaded: false, mode: "after_download", linkTriggered: false };
  const url = new URL("https://admin-stats/membership");
  if (userId !== undefined) url.searchParams.set("user", String(userId));
  const response = await env.ADMIN_STATS.getByName("global").fetch(url.toString(), linkRequest ? {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ triggerLink: true, userId }),
  } : undefined);
  if (!response.ok) throw new Error("MEMBERSHIP_STATE_UNAVAILABLE");
  const state = await response.json() as MembershipState;
  return { ...state, mode: MEMBERSHIP_MODES.includes(state.mode) ? state.mode : "after_download", linkTriggered: !!state.linkTriggered };
}

export async function setMembershipEnabled(env: AdminStatsEnv, enabled: boolean): Promise<void> {
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/membership", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error("MEMBERSHIP_SETTING_UNAVAILABLE");
}

export async function setMembershipMode(env: AdminStatsEnv, mode: MembershipMode): Promise<void> {
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/membership", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error("MEMBERSHIP_SETTING_UNAVAILABLE");
}

function requiresMembership(state: MembershipState): boolean {
  return state.enabled && (state.mode === "start" || state.downloaded || (state.mode === "first_link" && state.linkTriggered));
}

// Only download links/commands activate first-link mode. Plain text and /start do not.
function isDownloadRequest(message: any): boolean {
  const text = String(message?.text || message?.caption || "");
  if (parseRedditUrl(text) || /^\/reddit(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return true;
  if (parseBandcampUrl(text) || /^\/bandcamp(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return true;
  if (/^\/(?:music|live|replay|audio|playlist|instastory|instapost|findmusic|shazam)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) return true;
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
      if (["instagram.com", "youtube.com", "youtu.be", "x.com", "twitter.com", "tiktok.com", "pinterest.com", "pin.it", "soundcloud.com", "aparat.com", "pornhub.com"].some(domain => host === domain || host.endsWith(`.${domain}`))) return true;
    } catch { /* Invalid links do not consume the first-link trigger. */ }
  }
  return !!(message?.voice || message?.audio || message?.video || message?.video_note ||
    /^(audio|video)\//i.test(message?.document?.mime_type || "") ||
    /\.(mp3|m4a|wav|ogg|opus|flac|aac|aiff|mp4|mov|mkv|webm|avi|wma)$/i.test(message?.document?.file_name || ""));
}

async function pendingRequest(env: MembershipEnv, userId: number, op: "save" | "take", update?: unknown): Promise<any | null> {
  const response = await env.ADMIN_STATS!.getByName("global").fetch("https://admin-stats/membership-pending", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, userId, update }),
  });
  if (!response.ok) throw new Error("MEMBERSHIP_PENDING_UNAVAILABLE");
  return (await response.json() as { update?: unknown }).update || null;
}

async function telegram(env: MembershipEnv, method: string, payload: Record<string, unknown>): Promise<any> {
  if (!env.BOT_TOKEN) throw new Error("MEMBERSHIP_BOT_UNAVAILABLE");
  await telegramTextMotion(env.BOT_TOKEN, method, payload, { animateEdits: true, adminEnv: env });
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(telegramCustomEmoji(method, payload, env)), signal: AbortSignal.timeout(8000),
  });
  const body = await response.json() as { ok: boolean; result?: unknown; error_code?: number; description?: string };
  if (!response.ok || !body.ok) {
    const description = typeof body.description === "string" ? body.description : "";
    // Repeated check callbacks can try to edit an already-updated message.
    if (method === "editMessageText" && /message is not modified/i.test(description)) return;
    if (method === "deleteMessage" && /message to delete not found/i.test(description)) return;
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

export type MembershipInstagram = { enabled: boolean; total: number; day: number; week: number; origin?: string };
export async function membershipInstagram(env: MembershipEnv, enabled?: boolean, actorId?: number): Promise<MembershipInstagram> {
  if (!env.ADMIN_STATS) return { enabled: true, total: 0, day: 0, week: 0 };
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/membership-instagram", enabled === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, actorId }),
  });
  if (!response.ok) throw new Error("MEMBERSHIP_INSTAGRAM_UNAVAILABLE");
  return response.json();
}
async function instagramVisitKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function handleInstagramVisit(request: Request, env: MembershipEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/membership/instagram/visit") return null;
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
  const user = url.searchParams.get("user") || "", event = url.searchParams.get("event") || "", signature = url.searchParams.get("signature") || "";
  if (!env.BOT_TOKEN || !env.ADMIN_STATS || !/^[1-9]\d{0,15}$/.test(user) || !Number.isSafeInteger(Number(user)) ||
      !/^[a-f0-9-]{36}$/.test(event) || !/^[a-f0-9]{64}$/.test(signature)) return new Response("Invalid link", { status: 403, headers });
  const valid = await crypto.subtle.verify("HMAC", await instagramVisitKey(env.BOT_TOKEN),
    Uint8Array.from(signature.match(/../g)!, hex => parseInt(hex,16)), new TextEncoder().encode(`${user}:${event}`));
  if (!valid) return new Response("Invalid link", { status: 403, headers });
  if (!(await membershipInstagram(env)).enabled) return new Response("این لینک فعلاً فعال نیست؛ به ربات برگرد.", { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/membership-instagram", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: Number(user), eventId: `${event}-${Math.floor(Date.now() / 60000)}` }),
  });
  // A metering failure must not strand the user on the way to the page.
  if (!response.ok) console.warn("Instagram visit measurement unavailable");
  return new Response(null, { status: 302, headers: { ...headers, location: "https://www.instagram.com/vexa.order/" } });
}
async function configuredMembershipPrompt(env: MembershipEnv): Promise<Record<string, unknown>> {
  const settings = await membershipInstagram(env);
  return membershipPrompt(env.MEMBERSHIP_CHANNEL || MEMBERSHIP_CHANNEL, settings.enabled);
}

export function membershipPrompt(channel = MEMBERSHIP_CHANNEL, instagramEnabled = true): Record<string, unknown> {
  const title = "ادامه با عضویت در چنل";
  const text = `⚡️ ${title}\n${instagramEnabled ? "عضو چنلمون شو و پیج اینستاگراممون رو هم فالو کن؛ خبرهای تازه اونجاست!" : "عضو چنلمون شو؛ ابزارها و قابلیت‌های جدید هم اونجاست!"}\nبعد از عضویت در چنل، «عضو شدم» رو بزن.`;
  return { text, entities: [{ type: "bold", offset: text.indexOf(title), length: title.length }],
    reply_markup: { inline_keyboard: [[
      { text: "ورود به چنل", icon_custom_emoji_id: "5260285114448891086", url: `https://t.me/${channel.replace(/^@/, "")}` },
      ...(instagramEnabled ? [{ text: "ورود به پیج اینستاگرام", icon_custom_emoji_id: "5278573677900752088", url: "https://www.instagram.com/vexa.order/" }] : []),
      ...(!instagramEnabled ? [{ text: "✅ عضو شدم", callback_data: "membership:check" }] : []),
    ], ...(instagramEnabled ? [[{ text: "✅ عضو شدم", callback_data: "membership:check" }]] : [])] },
  };
}

export async function notifyFirstDownload(env: MembershipEnv, userId: number): Promise<void> {
  if (!env.BOT_TOKEN || isAdmin(env, userId)) return;
  const state = await membershipState(env, userId);
  if (!state.enabled || state.mode !== "after_download" || !state.downloaded || await isChannelMember(env, userId)) return;
  await telegram(env, "sendMessage", { chat_id: userId, ...await configuredMembershipPrompt(env) });
}

// Run once at the production webhook boundary, before any delegated command or callback.
export async function enforceMembership(request: Request, env: MembershipEnv, ctx?: Pick<ExecutionContext, "waitUntil">, resume?: (update: any) => Promise<void>): Promise<Response | null> {
  if (!env.ADMIN_STATS || !env.BOT_TOKEN || request.method !== "POST"
      || new URL(request.url).pathname !== "/telegram/webhook"
      || request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1")) return null;
  let update: any;
  try { update = await request.clone().json(); } catch { return null; }
  const callback = update?.callback_query;
  const actor = callback?.from || update?.message?.from;
  if (!Number.isSafeInteger(actor?.id) || actor.id <= 0) return null;
  if (callback?.data === "membership:instagram") {
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
    const settings = await membershipInstagram(env);
    if (settings.enabled) {
      await telegram(env, "sendMessage", { chat_id: actor.id, text: "پیج اینستاگراممون منتظرته؛ وارد شو و فالو کن 💜",
        reply_markup: { inline_keyboard: [[{ text: "باز کردن پیج اینستاگرام", icon_custom_emoji_id: "5278573677900752088", url: "https://www.instagram.com/vexa.order/" }]] } });
    } else await telegram(env, "sendMessage", { chat_id: actor.id, ...await configuredMembershipPrompt(env) });
    return Response.json({ ok: true });
  }
  if (isAdmin(env, actor.id)) return null;
  const checking = callback?.data === "membership:check";
  let state: MembershipState;
  let member = false;
  try {
    state = await membershipState(env, actor.id);
    if (state.enabled && state.mode === "first_link" && !state.linkTriggered &&
        (isDownloadRequest(update.message) || /^(?:ytq|msc|iga|igm|igs|soa|bcq)\|/.test(callback?.data || ""))) {
      state = await membershipState(env, actor.id, true);
    }
    if (requiresMembership(state) || (checking && state.enabled)) member = await isChannelMember(env, actor.id);
  } catch (error) {
    if (callback?.id) await telegram(env, "answerCallbackQuery", {
      callback_query_id: callback.id, _errorUserId: callback.from?.id, _errorDetail: String(error), text: "بررسی عضویت فعلاً ممکن نیست؛ کمی بعد دوباره امتحان کن.", show_alert: true,
    });
    else await telegram(env, "sendMessage", { chat_id: update.message.chat.id,
      _errorDetail: String(error), text: "بررسی عضویت فعلاً ممکن نیست؛ کمی بعد دوباره امتحان کن." });
    return Response.json({ ok: true });
  }
  if (!requiresMembership(state) || member) {
    if (!checking) return null;
    await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, _errorUserId: callback.from?.id, text: "✅ دسترسی فعاله؛ درخواستت رو بفرست." });
    // Shared group prompts stay available to other users; confirmation is private.
    if (callback.message?.chat?.id === actor.id) await telegram(env, "deleteMessage", {
      chat_id: actor.id, message_id: callback.message.message_id,
    });
    const confirmation = await telegram(env, "sendMessage", {
      chat_id: actor.id, text: "✅",
      entities: [{ type: "custom_emoji", offset: 0, length: 1, custom_emoji_id: "5400130177319580649" }],
    });
    if (Number.isSafeInteger(confirmation?.message_id)) {
      const cleanup = (async () => {
        await new Promise(resolve => setTimeout(resolve, 4000));
        try {
          await telegram(env, "deleteMessage", { chat_id: actor.id, message_id: confirmation.message_id });
        } catch {
          console.warn("membership confirmation cleanup unavailable");
          // Keep the request pending until Telegram confirms the emoji is gone.
          try { await telegram(env, "sendMessage", { chat_id: actor.id, ...await configuredMembershipPrompt(env) }); } catch {}
          return;
        }
        if (!resume) return;
        try {
          const latest = await membershipState(env, actor.id);
          if (requiresMembership(latest) && !await isChannelMember(env, actor.id)) {
            await telegram(env, "sendMessage", { chat_id: actor.id, ...await configuredMembershipPrompt(env) });
            return;
          }
          const pending = await pendingRequest(env, actor.id, "take");
          if (pending) await resume(pending);
        } catch {
          console.warn("membership request continuation unavailable");
          try { await telegram(env, "sendMessage", { chat_id: actor.id,
            text: "❌ پردازش درخواست کامل نشد؛ لینک یا درخواست را دوباره بفرست." }); } catch {}
        }
      })();
      if (typeof ctx?.waitUntil === "function") ctx.waitUntil(cleanup);
      else await cleanup;
    }
    return Response.json({ ok: true });
  }
  if (!checking) await pendingRequest(env, actor.id, "save", update);
  if (callback?.id) await telegram(env, "answerCallbackQuery", { callback_query_id: callback.id, _errorUserId: callback.from?.id,
    text: checking ? "هنوز عضو چنل نیستی؛ اول عضو شو و دوباره بررسی کن." : "برای ادامه، اول عضو چنل شو.", show_alert: true });
  const prompt = await configuredMembershipPrompt(env);
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
