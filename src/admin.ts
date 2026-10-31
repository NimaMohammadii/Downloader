import { createLanguageTables, importLanguagePreferences, membershipLanguages, languageStatistics, LANGUAGE_LABELS } from "./language-admin-store";
import type { Language } from "./localization";
import { localizePayload, isTranslatedError, isTranslatedErrorFrame, isLanguage } from "./localization";
import { PUBLIC_ERROR_MESSAGE, isPublicErrorMessage, isPublicErrorFrame, publicError } from "./public-errors";
export { PUBLIC_ERROR_MESSAGE } from "./public-errors";
import { BroadcastManager } from "./broadcast";
import { DurableObject } from "cloudflare:workers";
import { subtitleSettings, subtitleAccessSettings, isSubtitleLanguage, type SubtitleLanguage } from "./youtube-subtitles";
import { createSubtitleLedger, saveSubtitleCharge, subtitleCosts, subtitleCostLines, subtitleDollars, subtitleChoiceLabel,
  validSubtitleCharge, type SubtitleCharge, type SubtitleCosts } from "./subtitle-usage";

// Error visibility is enforced before both drafts and final Telegram messages.
export function isErrorNotice(text: string): boolean {
  return !isPublicErrorMessage(text) && /(?:^|\n)\s*(?:❌|⚠)|ناموفق|ممکن نیست|نامعتبر|دکمه برای|تأیید نشد|ارسال نشد|کامل نشد|معتبر نیست|معتبر نیستند|منقضی|برای شما نیست|درخواست‌کننده|محدود کرده|موقتاً.*(?:متوقف|محدود)|قابل دسترسی.*ندارد|قبلاً.*(?:شروع|تمام)|آمادهٔ ارسال نیست|صف متوقف شد/.test(text);
}
export function privateErrorPayload(method: string, payload: Record<string, unknown>, env: AdminAccessEnv = {}): Record<string, unknown> {
  const result = { ...payload };
  delete result._errorUserId;
  delete result._errorDetail;
  delete result._publicErrorFrame;
  if (isTranslatedError(payload.text) || (payload._publicErrorFrame === true && isTranslatedErrorFrame(payload.text))) return result;
  if (payload._publicErrorFrame === true && /^(sendMessageDraft|editMessageText)$/.test(method) &&
      typeof payload.text === "string" && isPublicErrorFrame(payload.text)) return result;
  if (!/^(sendMessage|sendMessageDraft|editMessageText|answerCallbackQuery)$/.test(method) ||
      typeof payload.text !== "string" || (!isPublicErrorMessage(payload.text) && !isErrorNotice(payload.text) && !payload._errorDetail)) return result;
  // A group is never an admin-only destination, even when the requester is admin.
  const admin = isAdmin(env, Number(method === "answerCallbackQuery" ? payload._errorUserId : payload.chat_id));
  if (admin && !isPublicErrorMessage(payload.text)) {
    if (payload._errorDetail && method !== "answerCallbackQuery") result.text = `${payload.text}\n${payload._errorDetail}`;
    return result;
  }
  const notice = publicError(payload.text, String(payload._errorDetail || ""));
  result.text = notice.message;
  for (const key of ["entities", "parse_mode", "reply_markup", "link_preview_options"]) delete result[key];
  if (method !== "answerCallbackQuery") result.entities = [
    { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: "5447644880824181073" },
    ...notice.bold.map(text => ({
      type: "bold", offset: notice.message.indexOf(text), length: text.length,
    })),
  ];
  return result;
}
function prepareErrorNotice(method: string, payload: Record<string, unknown>, env: AdminAccessEnv): void {
  const actor = payload._errorUserId;
  const safe = privateErrorPayload(method, payload, env);
  for (const key of Object.keys(payload)) delete payload[key];
  Object.assign(payload, localizePayload(safe));
  if (method === "answerCallbackQuery" && actor !== undefined) payload._errorUserId = actor;
}

const telegramEmojiIds: Record<string, string> = {
  "🌐": "5282843764451195532", "❌": "5210952531676504517", "✅": "5352871660024246779", "⚠": "5447644880824181073",
  "🔎": "5231012545799666522", "⬇": "5271604874419647061", "📤": "5445355530111437729",
  "⏳": "5386367538735104399", "🎵": "5463107823946717464", "🎧": "5424818078833715060",
  "🎼": "5253997827788385948", "🎬": "5427168083074628963", "⭐": "5438496463044752972",
  "🔴": "5264919878082509254", "⏹": "5260293700088511294", "👤": "5397866377367268054",
  "⚡": "5210956306952758910", "👇": "5231102735817918643",
  "👑": "5217822164362739968", "👥": "5461117441612462242", "🔗": "5271604874419647061",
};
const telegramEmojiPattern = /(?:🌐|❌|✅|⚠|🔎|⬇|📤|⏳|🎵|🎧|🎼|🎬|⭐|🔴|⏹|👤|⚡|👇|👑|👥|🔗)\uFE0F?/gu;

// Keep literal text and UTF-16 offsets intact; button icons use Telegram's own field.
export function telegramCustomEmoji(method: string, payload: Record<string, unknown>, env: AdminAccessEnv = {}): Record<string, unknown> {
  payload = localizePayload(privateErrorPayload(method, payload, env));
  if (!/^(sendMessage|sendMessageDraft|editMessageText|editMessageCaption|editMessageReplyMarkup|sendVideo|sendAudio|sendDocument|sendPhoto|sendAnimation|sendMediaGroup)$/.test(method)) return payload;
  const decorate = (body: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...body };
    for (const [field, entityField] of [["text", "entities"], ["caption", "caption_entities"]]) {
      if (typeof body[field] !== "string" || body.parse_mode) continue;
      const entities = Array.isArray(body[entityField]) ? [...body[entityField] as Record<string, unknown>[]] : [];
      for (const match of (body[field] as string).matchAll(telegramEmojiPattern)) {
        const offset = match.index!;
        if (entities.some(e => ["code", "pre", "url", "custom_emoji"].includes(String(e.type)) &&
            Number(e.offset) < offset + match[0].length && Number(e.offset) + Number(e.length) > offset)) continue;
        entities.push({ type: "custom_emoji", offset, length: match[0].length,
          custom_emoji_id: match[0] === "✅" && (body[field] as string).startsWith("✅ زیرنویس:", offset)
            ? "5206607081334906820" : telegramEmojiIds[match[0].replace(/\uFE0F/g, "")] });
      }
      if (entities.length) result[entityField] = entities.sort((a, b) => Number(a.offset) - Number(b.offset));
    }
    return result;
  };
  const result = decorate(payload);
  if (Array.isArray(payload.media)) result.media = payload.media.map(item => decorate(item as Record<string, unknown>));
  const markup = payload.reply_markup as { inline_keyboard?: Record<string, unknown>[][]; keyboard?: Record<string, unknown>[][] } | undefined;
  if (markup && typeof markup === "object") {
    const converted = { ...markup };
    for (const field of ["inline_keyboard", "keyboard"] as const) {
      if (!Array.isArray(markup[field])) continue;
      converted[field] = markup[field]!.map(row => row.map(button => {
        if (typeof button.text !== "string" || button.icon_custom_emoji_id) return button;
        const match = [...button.text.matchAll(telegramEmojiPattern)][0];
        if (!match || match.index !== 0) return button;
        const text = button.text.slice(match[0].length).trimStart();
        return text ? { ...button, text, icon_custom_emoji_id: telegramEmojiIds[match[0].replace(/\uFE0F/g, "")] } : button;
      }));
    }
    result.reply_markup = converted;
  }
  return result;
}

const textMotionChats = new Map<string, number>();

// Drafts use Telegram’s native append animation. Public errors and panel edits
// reveal text on the existing message; other edits keep their current behavior.
export async function telegramTextMotion(
  token: string, method: string, payload: Record<string, unknown>, options: { animateEdits?: boolean; adminEnv?: AdminAccessEnv } = {},
): Promise<void> {
  prepareErrorNotice(method, payload, options.adminEnv || {});
  const editing = method === "editMessageText" && (options.animateEdits || isPublicErrorMessage(payload.text)) && Number.isSafeInteger(payload.message_id);
  if ((method !== "sendMessage" && !editing) || typeof payload.text !== "string" || payload.parse_mode ||
      payload.text.length < 2 || payload.inline_message_id || payload.business_connection_id) return;
  const chat = Number(payload.chat_id);
  if (!Number.isSafeInteger(chat) || chat <= 0) return;
  const key = `${token.split(":")[0]}:${chat}${editing ? ":edit" : ""}`;
  const now = Date.now();
  if (now < (textMotionChats.get(key) || 0)) return;
  if (textMotionChats.size >= 512) textMotionChats.delete(textMotionChats.keys().next().value!);
  textMotionChats.set(key, now + (editing ? 1500 : 10000));
  const deadline = performance.now() + 4500;
  const post = async (action: string, body: Record<string, unknown>) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(telegramCustomEmoji(action, body, options.adminEnv)),
      signal: AbortSignal.timeout(Math.max(1, Math.min(800, Math.ceil(deadline - performance.now())))),
    });
    const result = await response.json() as { ok?: boolean; parameters?: { retry_after?: number } };
    if (response.status === 429) textMotionChats.set(key, Date.now() + Math.max(3000, Math.min(3600, Number(result.parameters?.retry_after) || 30) * 1000));
    if (!response.ok || !result.ok) throw new Error("TEXT_MOTION_UNAVAILABLE");
  };
  try {
    const chars = Array.from(new Intl.Segmenter("fa", { granularity: "grapheme" }).segment(payload.text), part => part.segment);
    if (chars.length < 2) return;
    const draft_id = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
    for (let frame = 0; frame < (editing ? 3 : 2); frame++) {
      if (performance.now() >= deadline) break;
      const end = editing ? Math.max(1, Math.floor(chars.length * (frame + 1) / 4)) : frame === 0 ? 1 : chars.length;
      const text = chars.slice(0, end).join("");
      if (!text.trim()) continue;
      const entities = Array.isArray(payload.entities) ? (payload.entities as Record<string, unknown>[])
        .filter(e => Number(e.offset) < text.length && (e.type !== "custom_emoji" || Number(e.offset) + Number(e.length) <= text.length))
        .map(e => ({ ...e, length: Math.min(Number(e.length), text.length - Number(e.offset)) })) : undefined;
      await post(editing ? "editMessageText" : "sendMessageDraft", editing
        ? { chat_id: chat, message_id: payload.message_id, text, entities, reply_markup: payload.reply_markup, _publicErrorFrame: isPublicErrorMessage(payload.text) }
        : { chat_id: chat, message_thread_id: payload.message_thread_id, draft_id, text, entities, _publicErrorFrame: isPublicErrorMessage(payload.text) });
      // Wait after acknowledgement: network time must not consume the reveal time.
      // Persisting immediately would replace the draft before its animation finishes.
      const pause = editing ? 450 : frame === 0 ? 120 : Math.min(1000, Math.max(500, chars.length * 12));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pause, deadline - performance.now()))));
    }
  } catch { /* Motion is optional; the complete original send/edit must always run. */ }
}

export const ADMIN_USER_ID = 7138547731;
export type AdminAccessEnv = { ADMIN_IDS?: string };
// Additional administrators never replace the original owner. Reject malformed IDs.
export function getAdminIds(env: AdminAccessEnv): number[] {
  const ids = (env.ADMIN_IDS || "").split(/[,\s]+/).filter(id => /^[1-9]\d*$/.test(id))
    .map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return [...new Set([ADMIN_USER_ID, ...ids])];
}
export function isAdmin(env: AdminAccessEnv, userId: unknown): userId is number {
  return typeof userId === "number" && Number.isSafeInteger(userId) && getAdminIds(env).includes(userId);
}
export const ADMIN_USERS_PAGE_SIZE = 8;
export const ADMIN_DOWNLOADS_PAGE_SIZE = 5;
export const VISIT_IDLE_MS = 30 * 60_000;

export const DOWNLOAD_CATEGORIES = ["ig_story", "ig_post", "ig_reel", "ig_other", "tiktok", "x", "youtube", "music", "other"] as const;
export type DownloadCategory = typeof DOWNLOAD_CATEGORIES[number];
// Aggregate profile rows repeat their children's deliveries and must be skipped.
export function downloadCategory(source: string, request: string, detail = ""): DownloadCategory | null {
  if (["Instagram profile stories", "Instagram profile posts"].includes(source)) return null;
  if (["SoundCloud", "YouTube Playlist", "تشخیص آهنگ", "جست‌وجو و دانلود آهنگ", "Instagram audio", "Instagram music"].includes(source)
      || (source === "YouTube" && /Audio (Low|HQ)/.test(detail))) return "music";
  if (["Instagram story", "Instagram highlight"].includes(source)) return "ig_story";
  if (source === "Instagram post") return /\/reels?\//i.test(request) ? "ig_reel" : "ig_post";
  if (source.startsWith("Instagram ")) return "ig_other";
  return source === "TikTok" ? "tiktok" : source === "X" ? "x" : source === "YouTube" ? "youtube" : "other";
}

type DownloadStatistics = { since: number; periods: Record<"day" | "week" | "all", Record<DownloadCategory, number>> };
export async function getDownloadStatistics(env: AdminStatsEnv): Promise<DownloadStatistics> {
  const response = await statsStub(env).fetch("https://admin-stats/download-statistics");
  if (!response.ok) throw new Error("DOWNLOAD_STATISTICS_UNAVAILABLE");
  return response.json();
}
export function formatDownloadStatistics(stats: DownloadStatistics): string {
  const blocks = (["day", "week", "all"] as const).map(period => {
    const counts = stats.periods[period];
    const instagram = counts.ig_story + counts.ig_post + counts.ig_reel + counts.ig_other;
    const total = DOWNLOAD_CATEGORIES.reduce((sum, key) => sum + counts[key], 0);
    return [ `<b>${period === "day" ? "🕐 ۲۴ ساعت گذشته" : period === "week" ? "📅 ۷ روز گذشته" : "📚 کل سوابق ثبت‌شده"}</b>`,
      `<b>اینستاگرام — مجموع: ${instagram}</b>`,
      `استوری و هایلایت: <b>${counts.ig_story}</b>  |  پست: <b>${counts.ig_post}</b>  |  ریلز: <b>${counts.ig_reel}</b>`,
      ...(counts.ig_other ? [`لایو و بازپخش اینستاگرام: <b>${counts.ig_other}</b>`] : []),
      `تیک‌تاک: <b>${counts.tiktok}</b>  |  ایکس: <b>${counts.x}</b>`,
      `یوتیوب: <b>${counts.youtube}</b>  |  موزیک و صوت: <b>${counts.music}</b>`,
      ...(counts.other ? [`سایر سرویس‌ها: <b>${counts.other}</b>`] : []),
      `<b>مجموع همه: ${total}</b>`,
    ].join("\n");
  });
  return `<b>📥 آمار دانلودهای ارسال‌شده</b>\n\n${blocks.join("\n\n")}\n\nهر محتوای کامل یک مورد؛ پست چنداسلایدی یک مورد و هر استوری/آهنگ یک مورد است. استوری‌ها و آهنگ‌های ارسال‌شده از درخواست ناقص هم حساب می‌شوند.\nثبت زمان هر مورد از ${dateLabel(stats.since)}؛ سوابق قدیمی بر اساس زمان ثبت نهایی و نوع قابل شناسایی هستند. سوابق پیش از تاریخچه قابل تفکیک نیستند. موزیک از یوتیوب جداست.`;
}

export type DownloadStatus = "pending" | "awaiting_selection" | "processing" | "success" | "failed" | "partial" | "results";
export type DownloadRecord = {
  key: string;
  userId: number;
  source: string;
  request: string;
  status: DownloadStatus;
  title?: string;
  detail?: string;
  delivered?: number;
  category?: DownloadCategory;
  excludeFromStats?: boolean;
  subtitleLanguage?: SubtitleLanguage | null;
};
export type AdminDownload = DownloadRecord & { createdAt: number; updatedAt: number; stale: boolean; subtitleCosts?: SubtitleCosts };
export type AdminUserDetail = {
  language?: Language;
  languageSelected?: boolean;
  user: AdminUserRow;
  usage?: UsageTotals;
  activity: { visits: number; interactions: number; starts: number; trackingSince: number } | null;
  counts: { total: number; success: number; failed: number; partial: number; active: number; stale: number; results: number; delivered: number };
  downloads: AdminDownload[];
  page: number;
  totalPages: number;
};
export type AdminSubtitleUsers = {
  users: { id: string; name: string; username: string | null; requests: number; delivered: number; lastAt: number }[];
  totalUsers: number; requests: number; delivered: number; failed: number;
  page: number; totalPages: number; trackingSince: number;
};

// Container measurements are event-driven. User resource shares are estimates
// when jobs overlap; global measurements include idle time and unattributed work.
export type UsageSample = {
  key: string; userId: number; start: number; end: number;
  runtimeMs: number; cpuSeconds: number | null; ingressBytes: number | null; egressBytes: number | null;
};
export type ContainerRun = { key: string; start: number; end: number | null };
export type MediaUsage = { key: string; userId: number; at: number; bytes: number | null; cached?: boolean };
export type UsageTotals = {
  downloads: number; bytes: number; unknownSizes: number; cached: number;
  runtimeMs: number; cpuSeconds: number; ingressBytes: number; egressBytes: number;
  cpuMeasuredMs: number; networkMeasuredMs: number;
  subtitles?: SubtitleCosts;
};
export type AdminUsage = {
  trackingSince: number; now: number; lastMeasured: number | null; userId?: string;
  all: UsageTotals; day: UsageTotals; week: UsageTotals;
  subtitleTrackingSince?: number;
};

type StoreEnv = AdminAccessEnv & { BOT_TOKEN?: string };

export type AdminStatsEnv = AdminAccessEnv & {
  ADMIN_STATS: DurableObjectNamespace<AdminStatsStore>;
};

export type ApifyAccount = 1 | 2 | 3 | 4;
export type InstagramProvider = "apify" | "brightdata";
export type InstagramApiSelection = { provider: InstagramProvider; account: ApifyAccount };
export type InstagramApiSettings = { posts: InstagramApiSelection; stories: InstagramApiSelection };
export type InstagramApiSecrets = {
  APIFY_API_TOKEN?: string;
  APIFY_API_TOKEN_1?: string;
  APIFY_API_TOKEN_2?: string;
  APIFY_API_TOKEN_3?: string;
  APIFY_API_TOKEN_4?: string;
  BRIGHTDATA_API_KEY?: string;
  BRIGHTDATA_API_KEY_1?: string;
  BRIGHTDATA_API_KEY_2?: string;
  BRIGHTDATA_API_KEY_3?: string;
  BRIGHTDATA_API_KEY_4?: string;
};
export const INSTAGRAM_API_ACCOUNTS: readonly ApifyAccount[] = [1, 2, 3, 4];

export function instagramApiToken(env: InstagramApiSecrets, selection: InstagramApiSelection): string | undefined {
  const prefix = selection.provider === "apify" ? "APIFY_API_TOKEN" : "BRIGHTDATA_API_KEY";
  return env[`${prefix}_${selection.account}`]?.trim()
    || (selection.account === 1 ? env[prefix]?.trim() : undefined) || undefined;
}

export async function instagramApiSettings(env: Partial<AdminStatsEnv>): Promise<InstagramApiSettings> {
  if (!env.ADMIN_STATS) return { posts: { provider: "apify", account: 1 }, stories: { provider: "apify", account: 1 } };
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/instagram-api");
  if (!response.ok) throw new Error("INSTAGRAM_API_SETTING_UNAVAILABLE");
  const value = await response.json() as InstagramApiSettings;
  if (![value.posts, value.stories].every(item => item && ["apify", "brightdata"].includes(item.provider)
      && INSTAGRAM_API_ACCOUNTS.includes(item.account)) || value.stories.provider !== "apify")
    throw new Error("INSTAGRAM_API_SETTING_INVALID");
  return value;
}

export async function setInstagramApi(env: AdminStatsEnv & InstagramApiSecrets,
  scope: "posts" | "stories" | "both", selection: InstagramApiSelection): Promise<void> {
  if (!["posts", "stories", "both"].includes(scope) || !["apify", "brightdata"].includes(selection.provider)
      || !INSTAGRAM_API_ACCOUNTS.includes(selection.account)) throw new Error("INSTAGRAM_API_SETTING_INVALID");
  if (scope !== "posts" && selection.provider === "brightdata") throw new Error("BRIGHTDATA_STORIES_UNSUPPORTED");
  if (!instagramApiToken(env, selection)) throw new Error("INSTAGRAM_API_SECRET_MISSING");
  const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/instagram-api", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, ...selection }),
  });
  if (!response.ok) throw new Error("INSTAGRAM_API_SETTING_UNAVAILABLE");
}

// One entry per successful Bright Data extraction, independently of Telegram
// delivery. Workflow replays and duplicate messages use the same stable key.
export async function recordBrightDataExtraction(env: Partial<AdminStatsEnv>, account: ApifyAccount, key: string): Promise<void> {
  if (!env.ADMIN_STATS) return;
  try {
    const response = await env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/instagram-api-usage", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account, key }),
    });
    if (!response.ok) throw new Error("USAGE_WRITE_FAILED");
  } catch {
    // A statistics outage must never restart a paid extraction or lose a file.
    console.warn("instagram brightdata usage recording failed", { account });
  }
}

type BrightDataUsage = { month: string; trackedSince: number; accounts: { account: ApifyAccount; used: number }[] };

export async function instagramAccountBudget(env: AdminStatsEnv & InstagramApiSecrets): Promise<string> {
  const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const usd = (value: unknown): number | undefined => number(value) !== undefined && Number(value) >= 0 ? Number(value) : undefined;
  const money = (value: number | undefined) => value === undefined ? "نامشخص" : `$${value.toFixed(4)}`;
  async function read(url: string, token: string): Promise<any> {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "BILLING_ACCESS" : "BILLING_UNAVAILABLE");
    return response.json();
  }
  const [settings, usageResponse] = await Promise.all([
    instagramApiSettings(env),
    env.ADMIN_STATS.getByName("global").fetch("https://admin-stats/instagram-api-usage"),
  ]);
  if (!usageResponse.ok) throw new Error("INSTAGRAM_API_USAGE_UNAVAILABLE");
  const usage = await usageResponse.json() as BrightDataUsage;
  const jobs = (["apify", "brightdata"] as const).flatMap(provider => INSTAGRAM_API_ACCOUNTS.map(async account => {
    const selection = { provider, account };
    const active = [settings.posts.provider === provider && settings.posts.account === account ? "پست/ریلز" : "",
      settings.stories.provider === provider && settings.stories.account === account ? "استوری" : ""].filter(Boolean);
    const heading = `${provider === "apify" ? "Apify" : "Bright Data"} ${account}${active.length ? " ✅ " + active.join("، ") : ""}`;
    const token = instagramApiToken(env, selection);
    if (!token) return `${heading}\nکلید تنظیم نشده`;
    if (provider === "brightdata") {
      const used = usage.accounts.find(item => item.account === account)?.used;
      const lines = [heading, used === undefined ? "شمارنده: نامشخص"
        : `مصرف ثبت‌شده: ${used} کردیت | باقی تخمینی: ${Math.max(0, 5000 - used)} از ۵۰۰۰`,
        ...(used === undefined ? [] : [`معادل مصرف با نرخ $1.50/1000: ${money(used * 0.0015)}`])];
      try {
        const balance = await read("https://api.brightdata.com/customer/balance", token);
        // These are USD fields, never the number of free-tier credits.
        lines.push(`موجودی دلاری: ${money(number(balance.balance))} | هزینه در انتظار: ${money(number(balance.pending_costs))}`);
      } catch (error) {
        lines.push(error instanceof Error && error.message === "BILLING_ACCESS" ? "دسترسی اطلاعات مالی مجاز نیست" : "اطلاعات دلاری دریافت نشد");
      }
      return lines.join("\n");
    }
    const result = await Promise.allSettled([
      read("https://api.apify.com/v2/users/me", token),
      read("https://api.apify.com/v2/users/me/usage/monthly", token),
    ]);
    const profile = result[0].status === "fulfilled" ? result[0].value?.data : undefined;
    const monthly = result[1].status === "fulfilled" ? result[1].value?.data : undefined;
    const included = usd(profile?.plan?.monthlyUsageCreditsUsd);
    const spent = usd(monthly?.totalUsageCreditsUsdAfterVolumeDiscount);
    const remaining = included !== undefined && spent !== undefined ? Math.max(0, included - spent) : undefined;
    const end = monthly?.usageCycle?.endAt;
    const lines = [heading, `مصرف دوره: ${money(spent)} | اعتبار پلن: ${money(included)}`,
      `باقی اعتبار پلن: ${money(remaining)}`];
    if (typeof end === "string" && Number.isFinite(Date.parse(end))) lines.push(`پایان دوره (UTC): ${new Date(end).toISOString().slice(0, 10)}`);
    if (result.some(item => item.status === "rejected")) lines.push("بخشی از اطلاعات دریافت نشد؛ دسترسی مالی توکن را بررسی کن.");
    return lines.join("\n");
  }));
  const accounts = await Promise.all(jobs);
  return `💳 مصرف و اعتبار اکانت‌ها\nبروزرسانی: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC\n\n${accounts.join("\n\n")}\n\nBright Data: ماه ${usage.month}؛ ریست اول ماه میلادی UTC. شمارش از ${new Date(usage.trackedSince).toISOString().slice(0, 10)}؛ مصرف قبلی، بیرون ربات و نتایج نامشخص لحاظ نشده. موجودی دلاری با کردیت رایگان متفاوت است.\nApify: باقی اعتبار پلن از سهمیهٔ پلن منهای مصرف گزارش‌شده محاسبه می‌شود؛ موجودی نقدی نیست. اطلاعات مالی سرویس ممکن است با تأخیر ثبت شود.`;
}

export type TrackedUser = {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
};

export type AdminPeriod = "day" | "week";

export type AdminSummary = {
  totalUsers: number;
  linksSent: number;
  successfulDownloads: number;
  active24h: number;
  active7d: number;
  linkUsers24h: number;
  linkUsers7d: number;
  linksTrackingSince: number;
};

export type AdminUserRow = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  linksSent: number;
  firstSeen: number;
  lastSeen: number;
};

export type AdminUsersPage = {
  users: AdminUserRow[];
  totalUsers: number;
  page: number;
  pageSize: number;
  totalPages: number;
  usedOnly?: boolean;
  period?: AdminPeriod;
};

type RecordPayload = {
  user: TrackedUser;
  linkSent: boolean;
  eventId?: number;
  start?: boolean;
};

export type CachedTelegramFile = {
  method: "sendAudio" | "sendVideo";
  fileId: string;
  data: Record<string, string | number | boolean>;
  fileSize?: number;
  hasAudio?: boolean;
};

function cleanCachedFile(value: any): CachedTelegramFile | null {
  if (!value || !["sendAudio", "sendVideo"].includes(value.method)
      || typeof value.fileId !== "string" || !/^[A-Za-z0-9_-]{1,1024}$/.test(value.fileId)) return null;
  const data: CachedTelegramFile["data"] = {};
  for (const key of ["caption", "title", "performer", "width", "height", "duration", "supports_streaming"]) {
    const item = value.data?.[key];
    if (typeof item === "string") data[key] = item.slice(0, key === "caption" ? 1024 : 180);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) data[key] = item;
  }
  return { method: value.method, fileId: value.fileId, data,
    ...(Number.isSafeInteger(value.fileSize) && value.fileSize > 0 && value.fileSize <= 2_000_000_000 ? { fileSize: value.fileSize } : {}),
    ...(typeof value.hasAudio === "boolean" ? { hasAudio: value.hasAudio } : {}),
  };
}

type SummarySqlRow = {
  total_users: number | string;
  links_sent: number | string;
};

type CounterSqlRow = {
  value: number | string;
};

type CountSqlRow = {
  total_users: number | string;
};

type UserSqlRow = {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  links_sent: number | string;
  first_seen: number | string;
  last_seen: number | string;
};

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\r\n\t]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 128) : null;
}

export class AdminStatsStore extends DurableObject<StoreEnv> {
  private broadcasts: BroadcastManager;
  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
    this.broadcasts = new BroadcastManager(ctx, env);
    createLanguageTables(this.ctx.storage.sql);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS membership_instagram_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS membership_instagram_clicks (
        event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_membership_ig_click_time ON membership_instagram_clicks(recorded_at, user_id);
      CREATE TABLE IF NOT EXISTS user_restrictions (
        user_id TEXT PRIMARY KEY, until_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        links_sent INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);

      CREATE TABLE IF NOT EXISTS counters (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO counters(key, value) VALUES ('successful_downloads', 0);
      INSERT OR IGNORE INTO counters(key,value) VALUES ('membership_instagram_enabled',1);

      CREATE TABLE IF NOT EXISTS delivered_media (
        delivery_key TEXT PRIMARY KEY,
        delivered_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivered_media_at ON delivered_media(delivered_at);

      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT PRIMARY KEY,
        visits INTEGER NOT NULL DEFAULT 0,
        interactions INTEGER NOT NULL DEFAULT 0,
        starts INTEGER NOT NULL DEFAULT 0,
        tracking_since INTEGER NOT NULL,
        last_activity INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_link_activity (
        user_id TEXT PRIMARY KEY, last_link_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_link_activity_at ON user_link_activity(last_link_at);
      CREATE TABLE IF NOT EXISTS activity_events (
        event_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_events_at ON activity_events(recorded_at);
      CREATE TABLE IF NOT EXISTS download_history (
        key TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL,
        request TEXT NOT NULL, status TEXT NOT NULL, title TEXT, detail TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_download_history_user ON download_history(user_id, created_at DESC, key);
      CREATE TABLE IF NOT EXISTS download_stat_events (
        download_key TEXT NOT NULL, item_index INTEGER NOT NULL, category TEXT NOT NULL, delivered_at INTEGER NOT NULL,
        PRIMARY KEY(download_key, item_index)
      );
      CREATE INDEX IF NOT EXISTS idx_download_stat_events_time ON download_stat_events(delivered_at, category);

      CREATE TABLE IF NOT EXISTS membership_access (
        user_id TEXT PRIMARY KEY, first_download_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO membership_access(user_id, first_download_at)
        SELECT user_id, MIN(created_at) FROM download_history WHERE delivered > 0 GROUP BY user_id;
      INSERT OR IGNORE INTO counters(key, value) VALUES ('membership_enabled', 1);
      INSERT OR IGNORE INTO counters(key, value) VALUES ('membership_mode', 0);
      CREATE TABLE IF NOT EXISTS membership_link_triggers (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS membership_pending (
        user_id TEXT PRIMARY KEY, request_key TEXT NOT NULL, payload TEXT,
        update_id INTEGER, created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO counters(key, value) VALUES ('apify_account', 1);
      CREATE TABLE IF NOT EXISTS instagram_api_extractions (
        event_key TEXT NOT NULL, account INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY (event_key, account)
      );
      CREATE INDEX IF NOT EXISTS idx_instagram_api_extractions_at ON instagram_api_extractions(recorded_at, account);
      INSERT OR IGNORE INTO counters(key, value) VALUES ('bd_tracking_since', ${Date.now()});
      INSERT OR IGNORE INTO counters(key, value) VALUES ('ig_posts_provider', 1), ('ig_stories_provider', 1);
      INSERT OR IGNORE INTO counters(key, value) SELECT 'ig_posts_account', value FROM counters WHERE key = 'apify_account';
      INSERT OR IGNORE INTO counters(key, value) SELECT 'ig_stories_account', value FROM counters WHERE key = 'apify_account';

      CREATE TABLE IF NOT EXISTS telegram_file_cache (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_file_cache_at ON telegram_file_cache(created_at);
    `);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO counters(key, value) VALUES ('links_tracking_since', ?)", Date.now());
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS container_runs (key TEXT PRIMARY KEY, start_at REAL NOT NULL, end_at REAL);
      CREATE TABLE IF NOT EXISTS usage_samples (
        key TEXT PRIMARY KEY, user_id TEXT NOT NULL, start_at REAL NOT NULL, end_at REAL NOT NULL,
        runtime_ms REAL NOT NULL, cpu_seconds REAL, ingress_bytes REAL, egress_bytes REAL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_samples_user_time ON usage_samples(user_id, end_at);
      CREATE TABLE IF NOT EXISTS media_usage (
        key TEXT PRIMARY KEY, user_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        bytes INTEGER, cached INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_media_usage_user_time ON media_usage(user_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_media_usage_time ON media_usage(recorded_at);
    `);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO counters(key,value) VALUES ('usage_tracking_since',?)", Date.now());
    createSubtitleLedger(this.ctx.storage.sql);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO counters(key,value) VALUES ('subtitle_tracking_since',?)", Date.now());
    // One-time, set-based import. No timer or polling and no repeated full scan.
    if (!this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key = 'download_stats_since'").toArray().length) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`
          INSERT OR IGNORE INTO download_stat_events(download_key,item_index,category,delivered_at)
          WITH RECURSIVE items(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM items WHERE n < 99),
          history AS (SELECT *, CASE
            WHEN source IN ('SoundCloud','YouTube Playlist','تشخیص آهنگ','جست‌وجو و دانلود آهنگ','Instagram audio','Instagram music')
              OR (source='YouTube' AND (detail LIKE '%Audio Low%' OR detail LIKE '%Audio HQ%')) THEN 'music'
            WHEN source IN ('Instagram story','Instagram highlight') THEN 'ig_story'
            WHEN source='Instagram post' AND (request LIKE '%/reel/%' OR request LIKE '%/reels/%') THEN 'ig_reel'
            WHEN source='Instagram post' THEN 'ig_post'
            WHEN source LIKE 'Instagram %' THEN 'ig_other'
            WHEN source='TikTok' THEN 'tiktok' WHEN source='X' THEN 'x'
            WHEN source='YouTube' THEN 'youtube' ELSE 'other' END AS category
            FROM download_history AS parent WHERE source NOT IN ('Instagram profile stories','Instagram profile posts')
              AND NOT (parent.key LIKE 'ig:%' AND EXISTS (SELECT 1 FROM download_history AS child
                WHERE child.key LIKE 'igdl-' || replace(substr(parent.key,4),':','-') || '-profile-%'))
              AND delivered > 0 AND status IN ('success','partial'))
          SELECT key,n,category,updated_at FROM history JOIN items
            ON n < CASE WHEN category IN ('ig_story','music') THEN MIN(delivered,100)
                       WHEN status='success' THEN 1 ELSE 0 END
        `);
        this.ctx.storage.sql.exec("INSERT INTO counters(key,value) VALUES ('download_stats_since',?)", Date.now());
      });
    }
  }

  private usageTotals(since: number, until: number, userId?: string): UsageTotals {
    const sql = this.ctx.storage.sql;
    // Split intervals at rolling-window boundaries. Resource samples are taken
    // at events, so allocation inside each interval assumes uniform consumption.
    const resource = sql.exec(`SELECT
      COALESCE(SUM(runtime_ms * fraction),0) AS runtimeMs,
      COALESCE(SUM(cpu_seconds * fraction),0) AS cpuSeconds,
      COALESCE(SUM(ingress_bytes * fraction),0) AS ingressBytes,
      COALESCE(SUM(egress_bytes * fraction),0) AS egressBytes,
      COALESCE(SUM(CASE WHEN cpu_seconds IS NOT NULL THEN runtime_ms * fraction ELSE 0 END),0) AS cpuMeasuredMs,
      COALESCE(SUM(CASE WHEN ingress_bytes IS NOT NULL AND egress_bytes IS NOT NULL THEN runtime_ms * fraction ELSE 0 END),0) AS networkMeasuredMs
      FROM (SELECT *, MAX(0, MIN(end_at, ?) - MAX(start_at, ?)) / (end_at - start_at) AS fraction
        FROM usage_samples WHERE user_id = ? AND end_at > ? AND start_at < ?)`,
      until, since, userId || "0", since, until).one();
    if (!userId) {
      const runs = sql.exec(`SELECT COUNT(*) AS count,
        COALESCE(SUM(MAX(0, MIN(COALESCE(end_at, ?), ?) - MAX(start_at, ?))),0) AS ms
        FROM container_runs`, until, until, since).one();
      if (asNumber(runs.count)) resource.runtimeMs = asNumber(runs.ms);
    }
    const media = sql.exec(`SELECT COUNT(*) AS downloads, COALESCE(SUM(bytes),0) AS bytes,
      COALESCE(SUM(bytes IS NULL),0) AS unknownSizes, COALESCE(SUM(cached),0) AS cached
      FROM media_usage WHERE recorded_at >= ? AND recorded_at <= ? ${userId ? "AND user_id = ?" : ""}`,
      since, until, ...(userId ? [userId] : [])).one();
    return { ...Object.fromEntries(Object.entries({ ...resource, ...media }).map(([key, value]) => [key, asNumber(value)])),
      subtitles: subtitleCosts(sql, since, until, userId) } as UsageTotals;
  }

  async alarm(): Promise<void> { await this.broadcasts.alarm(); }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/youtube-subtitles") return subtitleSettings(request, this.ctx.storage);
    if (new URL(request.url).pathname === "/youtube-subtitle-access")
      return subtitleAccessSettings(request, this.ctx.storage, id => isAdmin(this.env, id));
    const languageUrl = new URL(request.url);
    if (languageUrl.pathname === "/language-menu") {
      const user = languageUrl.searchParams.get("user") || "";
      const chat = languageUrl.searchParams.get("chat") || "";
      if (!/^[1-9]\d{0,15}$/.test(user) || !/^-?[1-9]\d{0,15}$/.test(chat) ||
          !Number.isSafeInteger(Number(user)) || !Number.isSafeInteger(Number(chat))) return new Response("Invalid destination", { status: 400 });
      const key = `language-menu:${chat}:${user}`;
      if (request.method === "POST") {
        const body = await request.json() as { messageId?: number };
        if (!Number.isSafeInteger(body.messageId) || body.messageId! <= 0) return new Response("Invalid menu", { status: 400 });
        await this.ctx.storage.put(key, body.messageId);
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return Response.json({ messageId: await this.ctx.storage.get(key) });
    }
    if (languageUrl.pathname === "/language") {
      const user = languageUrl.searchParams.get("user") || "";
      if (!/^[1-9]\d{0,15}$/.test(user) || !Number.isSafeInteger(Number(user))) return new Response("Invalid user", { status: 400 });
      const key = `language:${user}`;
      if (request.method === "POST") {
        const body = await request.json() as { language?: unknown };
        if (!isLanguage(body.language)) return new Response("Invalid language", { status: 400 });
        await this.ctx.storage.put(key, body.language);
        this.ctx.storage.sql.exec("INSERT INTO user_languages(user_id,language) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET language=excluded.language", user, body.language);
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return Response.json({ language: await this.ctx.storage.get(key) || "fa" });
    }

    const url = new URL(request.url);
    if (url.pathname === "/language-presence" && request.method === "POST") {
      const user = await request.json() as TrackedUser;
      if (!Number.isSafeInteger(user.id) || user.id <= 0) return new Response("Invalid user", { status: 400 });
      if (isAdmin(this.env, user.id)) return Response.json({ ok: true });
      const now = Date.now();
      this.ctx.storage.sql.exec(`INSERT INTO users(id,username,first_name,last_name,first_seen,last_seen)
        VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        username=COALESCE(excluded.username,users.username), first_name=COALESCE(excluded.first_name,users.first_name),
        last_name=COALESCE(excluded.last_name,users.last_name), last_seen=MAX(users.last_seen,excluded.last_seen)`,
        String(user.id), cleanText(user.username), cleanText(user.firstName), cleanText(user.lastName), now, now);
      return Response.json({ ok: true });
    }
    if ((url.pathname === "/language-stats" || url.pathname === "/language-users") && request.method === "GET") {
      await importLanguagePreferences(this.ctx.storage);
      return languageStatistics(url, this.ctx.storage.sql, getAdminIds(this.env));
    }
    if (url.pathname === "/membership-languages") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body = await request.json().catch(() => null) as { actorId?: number; language?: unknown; enabled?: unknown } | null;
      if (!body) return new Response("Invalid setting", { status: 400 });
      if (!isAdmin(this.env, body.actorId)) return new Response("Forbidden", { status: 403 });
      if (!isLanguage(body.language) || typeof body.enabled !== "boolean") return new Response("Invalid setting", { status: 400 });
      this.ctx.storage.sql.exec("UPDATE membership_languages SET enabled=? WHERE language=?", body.enabled ? 1 : 0, body.language);
      return Response.json({ languages: membershipLanguages(this.ctx.storage.sql) });
    }
    if (url.pathname === "/broadcast") return this.broadcasts.fetch(request);

    if (request.method === "POST" && url.pathname === "/usage") {
      const body = await request.json() as { samples?: UsageSample[]; deliveries?: MediaUsage[]; runs?: ContainerRun[]; subtitleCharges?: SubtitleCharge[] };
      const runs = body.runs ?? [];
      const charges = body.subtitleCharges ?? [];
      const validId = (id: number) => Number.isSafeInteger(id) && id >= 0;
      const metric = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e15);
      const validKey = (key: string) => typeof key === "string" && /^[A-Za-z0-9:_-]{1,180}$/.test(key);
      const now = Date.now();
      if (!Array.isArray(body.samples) || !Array.isArray(body.deliveries) || !Array.isArray(runs) || !Array.isArray(charges)
        || charges.length > 100 || charges.some(v => !validSubtitleCharge(v, now))
        || runs.length > 250 || body.samples.length > 250 || body.deliveries.length > 250
        || runs.some(v => !v || !validKey(v.key) || !Number.isFinite(v.start) || v.start < 0 || v.start > now + 60000
          || !(v.end === null || (Number.isFinite(v.end) && v.end >= v.start && v.end <= now + 60000)))
        || body.samples.some(v => !v || !validKey(v.key) || !validId(v.userId)
          || !Number.isFinite(v.start) || !Number.isFinite(v.end) || v.start < 0 || v.end <= v.start || v.end > now + 60000
          || typeof v.runtimeMs !== "number" || !Number.isFinite(v.runtimeMs) || v.runtimeMs < 0 || v.runtimeMs > v.end - v.start + 1
          || !metric(v.cpuSeconds) || !metric(v.ingressBytes) || !metric(v.egressBytes))
        || body.deliveries.some(v => !v || !validKey(v.key) || !validId(v.userId) || v.userId === 0
          || !Number.isSafeInteger(v.at) || v.at < 0 || v.at > now + 60000
          || !(v.bytes === null || (Number.isSafeInteger(v.bytes) && v.bytes >= 0 && v.bytes <= 2_000_000_000)))) {
        return new Response("Invalid usage", { status: 400 });
      }
      this.ctx.storage.transactionSync(() => {
        for (const v of charges) saveSubtitleCharge(this.ctx.storage.sql, v);
        for (const v of runs) this.ctx.storage.sql.exec(`INSERT INTO container_runs VALUES (?,?,?)
          ON CONFLICT(key) DO UPDATE SET end_at = COALESCE(container_runs.end_at, excluded.end_at)
          WHERE container_runs.start_at = excluded.start_at`, v.key, v.start, v.end);
        for (const v of body.samples!) this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO usage_samples VALUES (?,?,?,?,?,?,?,?)",
          v.key, String(v.userId), v.start, v.end, v.runtimeMs, v.cpuSeconds, v.ingressBytes, v.egressBytes);
        for (const v of body.deliveries!) this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO media_usage VALUES (?,?,?,?,?)", v.key, String(v.userId), v.at, v.bytes, v.cached ? 1 : 0);
      });
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/usage") {
      const id = url.searchParams.get("id") || undefined;
      if (id && !/^[1-9]\d{0,15}$/.test(id)) return new Response("Invalid user", { status: 400 });
      const now = Date.now();
      const tracking = this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key = 'usage_tracking_since'").one();
      const latest = this.ctx.storage.sql.exec("SELECT MAX(end_at) AS at FROM usage_samples WHERE user_id = ?", id || "0").one();
      return Response.json({ trackingSince: asNumber(tracking.value), now,
        subtitleTrackingSince: asNumber(this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key='subtitle_tracking_since'").one().value),
        lastMeasured: latest.at === null ? null : asNumber(latest.at), userId: id,
        all: this.usageTotals(0, now, id), day: this.usageTotals(now - 86400_000, now, id),
        week: this.usageTotals(now - 7 * 86400_000, now, id),
      } satisfies AdminUsage);
    }

    if (url.pathname === "/instagram-api-usage") {
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const payload = await request.json().catch(() => null) as { account?: ApifyAccount; key?: string } | null;
        if (!payload || !INSTAGRAM_API_ACCOUNTS.includes(payload.account!) || typeof payload.key !== "string"
            || !/^[A-Za-z0-9:_-]{1,200}$/.test(payload.key)) return new Response("Invalid extraction", { status: 400 });
        sql.exec("INSERT OR IGNORE INTO instagram_api_extractions(event_key, account, recorded_at) VALUES (?, ?, ?)",
          payload.key, payload.account!, Date.now());
        return Response.json({ ok: true });
      }
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const now = new Date(Date.now());
      const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
      const rows = sql.exec("SELECT account, COUNT(*) AS used FROM instagram_api_extractions WHERE recorded_at >= ? AND recorded_at < ? GROUP BY account", start, end).toArray();
      return Response.json({ month: now.toISOString().slice(0, 7),
        trackedSince: asNumber(sql.exec("SELECT value FROM counters WHERE key = 'bd_tracking_since'").one().value),
        accounts: INSTAGRAM_API_ACCOUNTS.map(account => ({ account,
          used: asNumber(rows.find(row => asNumber(row.account) === account)?.used || 0) })),
      } satisfies BrightDataUsage);
    }

    if (url.pathname === "/instagram-api") {
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const payload = await request.json().catch(() => null) as {
          scope?: string; provider?: string; account?: ApifyAccount;
        } | null;
        if (!payload || !["posts", "stories", "both"].includes(payload.scope!)
            || !["apify", "brightdata"].includes(payload.provider!)
            || !INSTAGRAM_API_ACCOUNTS.includes(payload.account!)
            || (payload.scope !== "posts" && payload.provider === "brightdata"))
          return new Response("Invalid API selection", { status: 400 });
        this.ctx.storage.transactionSync(() => {
          for (const scope of payload.scope === "both" ? ["posts", "stories"] : [payload.scope!]) {
            sql.exec("UPDATE counters SET value = ? WHERE key = ?", payload.provider === "apify" ? 1 : 2, `ig_${scope}_provider`);
            sql.exec("UPDATE counters SET value = ? WHERE key = ?", payload.account!, `ig_${scope}_account`);
          }
        });
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const read = (scope: string): InstagramApiSelection => ({
        provider: asNumber(sql.exec("SELECT value FROM counters WHERE key = ?", `ig_${scope}_provider`).one().value) === 2 ? "brightdata" : "apify",
        account: asNumber(sql.exec("SELECT value FROM counters WHERE key = ?", `ig_${scope}_account`).one().value) as ApifyAccount,
      });
      return Response.json({ posts: read("posts"), stories: read("stories") } satisfies InstagramApiSettings);
    }

    if (url.pathname === "/membership-pending" && request.method === "POST") {
      const input = await request.json() as { op?: string; userId?: number; update?: any };
      if (!Number.isSafeInteger(input.userId) || input.userId! <= 0 || !["save", "take"].includes(input.op || ""))
        return new Response("Invalid request", { status: 400 });
      const user = String(input.userId), now = Date.now(), cutoff = now - 24 * 3600_000;
      const sql = this.ctx.storage.sql;
      if (input.op === "save") {
        const update = input.update;
        const actor = update?.callback_query?.from || update?.message?.from;
        const message = update?.message || update?.callback_query?.message;
        if (actor?.id !== input.userId || !Number.isSafeInteger(message?.chat?.id) ||
            !Number.isSafeInteger(message?.message_id) || update?.callback_query?.data === "membership:check")
          return new Response("Invalid request", { status: 400 });
        const payload = JSON.stringify(update);
        if (payload.length > 64_000) return new Response("Request too large", { status: 413 });
        const updateId = Number.isSafeInteger(update.update_id) ? update.update_id : null;
        const key = updateId !== null ? `update:${updateId}` : update.callback_query
          ? `callback:${update.callback_query.id}` : `message:${message.chat.id}:${message.message_id}`;
        this.ctx.storage.transactionSync(() => {
          const saved = sql.exec("SELECT request_key, update_id, created_at FROM membership_pending WHERE user_id = ?", user).toArray()[0];
          // Retain the newest gated request, and remember consumed keys so webhook
          // redelivery cannot schedule the same action again.
          if (saved && asNumber(saved.created_at) >= cutoff && (saved.request_key === key ||
              (updateId !== null && saved.update_id !== null && updateId <= asNumber(saved.update_id)))) return;
          sql.exec(`INSERT INTO membership_pending(user_id, request_key, payload, update_id, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
            request_key = excluded.request_key, payload = excluded.payload,
            update_id = excluded.update_id, created_at = excluded.created_at`, user, key, payload, updateId, now);
        });
        return Response.json({ ok: true });
      }
      const update = this.ctx.storage.transactionSync(() => {
        const saved = sql.exec("SELECT payload, created_at FROM membership_pending WHERE user_id = ?", user).toArray()[0];
        if (!saved?.payload) return null;
        // Consume atomically before dispatch: duplicate confirmation callbacks
        // must never replay a download whose delivery may already have started.
        sql.exec("UPDATE membership_pending SET payload = NULL WHERE user_id = ?", user);
        return JSON.parse(String(saved.payload));
      });
      return Response.json({ update });
    }

    if (url.pathname === "/membership-instagram") {
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const body = await request.json() as { actorId?: number; enabled?: boolean; eventId?: string; userId?: number; origin?: string };
        if (body.origin !== undefined) {
          let origin: URL;
          try { origin = new URL(body.origin); } catch { return new Response("Invalid origin", { status: 400 }); }
          if (origin.protocol !== "https:" || origin.origin !== body.origin) return new Response("Invalid origin", { status: 400 });
          sql.exec("INSERT INTO membership_instagram_config(key,value) VALUES ('origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", body.origin);
        } else if (body.enabled !== undefined) {
          if (!isAdmin(this.env, body.actorId)) return new Response("Forbidden", { status: 403 });
          if (typeof body.enabled !== "boolean") return new Response("Invalid setting", { status: 400 });
          sql.exec("UPDATE counters SET value=? WHERE key='membership_instagram_enabled'", body.enabled ? 1 : 0);
        } else {
          if (!Number.isSafeInteger(body.userId) || body.userId! <= 0 || !/^[A-Za-z0-9_-]{1,128}$/.test(body.eventId || "")) return new Response("Invalid click", { status: 400 });
          if (!isAdmin(this.env, body.userId) && asNumber(sql.exec("SELECT value FROM counters WHERE key='membership_instagram_enabled'").one().value) === 1)
            sql.exec("INSERT OR IGNORE INTO membership_instagram_clicks(event_id,user_id,recorded_at) VALUES (?,?,?)", body.eventId!, String(body.userId), Date.now());
        }
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const now = Date.now();
      const counts = sql.exec(`SELECT COUNT(DISTINCT user_id) AS total,
        COUNT(DISTINCT CASE WHEN recorded_at >= ? THEN user_id END) AS day,
        COUNT(DISTINCT CASE WHEN recorded_at >= ? THEN user_id END) AS week
        FROM membership_instagram_clicks`, now - 86400_000, now - 7 * 86400_000).one();
      return Response.json({ enabled: asNumber(sql.exec("SELECT value FROM counters WHERE key='membership_instagram_enabled'").one().value) === 1,
        total: asNumber(counts.total), day: asNumber(counts.day), week: asNumber(counts.week),
        ...Object.fromEntries(sql.exec("SELECT key,value FROM membership_instagram_config WHERE key='origin'").toArray().map(row => [String(row.key),String(row.value)])) });
    }

    if (url.pathname === "/membership") {
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const payload = await request.json() as { enabled?: boolean; mode?: string; triggerLink?: boolean; userId?: number };
        const modes = ["after_download", "start", "first_link"];
        if ((payload.enabled !== undefined && typeof payload.enabled !== "boolean") ||
            (payload.mode !== undefined && !modes.includes(payload.mode)) ||
            (payload.triggerLink !== undefined && (payload.triggerLink !== true || !Number.isSafeInteger(payload.userId) || payload.userId! <= 0)) ||
            (payload.enabled === undefined && payload.mode === undefined && !payload.triggerLink)) return new Response("Invalid setting", { status: 400 });
        this.ctx.storage.transactionSync(() => {
          if (payload.enabled !== undefined) sql.exec("UPDATE counters SET value = ? WHERE key = 'membership_enabled'", payload.enabled ? 1 : 0);
          if (payload.mode !== undefined) sql.exec("UPDATE counters SET value = ? WHERE key = 'membership_mode'", modes.indexOf(payload.mode));
          if (payload.triggerLink) sql.exec("INSERT OR IGNORE INTO membership_link_triggers(user_id) VALUES (?)", String(payload.userId));
        });
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const user = url.searchParams.get("user");
      if (user !== null && !/^[1-9]\d{0,15}$/.test(user)) return new Response("Invalid user", { status: 400 });
      const enabled = sql.exec("SELECT value FROM counters WHERE key = 'membership_enabled'").one();
      const access = user ? sql.exec("SELECT user_id FROM membership_access WHERE user_id = ?", user).toArray() : [];
      const mode = ["after_download", "start", "first_link"][asNumber(sql.exec("SELECT value FROM counters WHERE key = 'membership_mode'").one().value)] || "after_download";
      const triggered = user ? sql.exec("SELECT user_id FROM membership_link_triggers WHERE user_id = ?", user).toArray() : [];
      const languages = membershipLanguages(sql);
      const selected = user ? await this.ctx.storage.get(`language:${user}`) : undefined;
      const language = isLanguage(selected) ? selected : "fa";
      return Response.json({ enabled: asNumber(enabled.value) === 1 && (!user || languages[language]),
        ...(!user ? { languages } : {}),
        downloaded: access.length > 0, mode, linkTriggered: triggered.length > 0 });
    }

    if (request.method === "POST" && url.pathname === "/file-cache") {
      const payload = await request.json() as { op: string; key: string; value?: CachedTelegramFile };
      if (!/^[A-Za-z0-9:_-]{1,180}$/.test(payload.key || "")) return new Response("Invalid key", { status: 400 });
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      if (payload.op === "get") {
        const rows = sql.exec("SELECT value FROM telegram_file_cache WHERE key = ? AND created_at > ?", payload.key, now - 30 * 86400_000).toArray();
        return Response.json({ value: rows.length ? JSON.parse(String(rows[0].value)) : null });
      }
      if (payload.op === "delete") sql.exec("DELETE FROM telegram_file_cache WHERE key = ?", payload.key);
      else if (payload.op === "put") {
        const value = cleanCachedFile(payload.value);
        if (!value) return new Response("Invalid file", { status: 400 });
        sql.exec("INSERT INTO telegram_file_cache(key,value,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,created_at=excluded.created_at", payload.key, JSON.stringify(value), now);
        sql.exec("DELETE FROM telegram_file_cache WHERE created_at <= ?", now - 30 * 86400_000);
        sql.exec("DELETE FROM telegram_file_cache WHERE key IN (SELECT key FROM telegram_file_cache ORDER BY created_at DESC LIMIT -1 OFFSET 10000)");
      } else return new Response("Invalid operation", { status: 400 });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/record") {
      const payload = (await request.json()) as RecordPayload;
      const user = payload?.user;
      if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
        return Response.json({ ok: false, error: "invalid-user" }, { status: 400 });
      }

      const now = Date.now();
      const id = String(user.id);
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        if (Number.isSafeInteger(payload.eventId)) {
          const inserted = sql.exec("INSERT OR IGNORE INTO activity_events(event_id, recorded_at) VALUES (?, ?)", String(payload.eventId), now);
          if (!inserted.rowsWritten) return;
        }
        sql.exec(
          `INSERT INTO users(id, username, first_name, last_name, links_sent, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET username = excluded.username,
             first_name = excluded.first_name, last_name = excluded.last_name,
             links_sent = users.links_sent + excluded.links_sent, last_seen = excluded.last_seen`,
          id, cleanText(user.username), cleanText(user.firstName), cleanText(user.lastName),
          payload.linkSent ? 1 : 0, now, now,
        );
        sql.exec(
          `INSERT INTO user_activity(user_id, visits, interactions, starts, tracking_since, last_activity)
           VALUES (?, 1, 1, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             visits = visits + CASE WHEN excluded.last_activity - last_activity >= ? THEN 1 ELSE 0 END,
             interactions = interactions + 1, starts = starts + excluded.starts,
             last_activity = excluded.last_activity`,
          id, payload.start ? 1 : 0, now, now, VISIT_IDLE_MS,
        );
        if (payload.linkSent) sql.exec(
          `INSERT INTO user_link_activity(user_id, last_link_at) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_link_at = excluded.last_link_at`, id, now,
        );
        sql.exec("DELETE FROM activity_events WHERE recorded_at < ?", now - 7 * 86400_000);
      });

      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/download-statistics") {
      const now = Date.now();
      const rows = this.ctx.storage.sql.exec(`SELECT category, COUNT(*) AS all_count,
        SUM(delivered_at >= ?) AS day_count, SUM(delivered_at >= ?) AS week_count
        FROM download_stat_events WHERE delivered_at <= ? GROUP BY category`, now - 86400_000, now - 7 * 86400_000, now).toArray();
      const periods = Object.fromEntries((["day", "week", "all"] as const).map(period => [period,
        Object.fromEntries(DOWNLOAD_CATEGORIES.map(category => [category,
          asNumber(rows.find(row => row.category === category)?.[`${period}_count`] || 0)])),
      ])) as DownloadStatistics["periods"];
      return Response.json({ periods, since: asNumber(this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key = 'download_stats_since'").one().value) });
    }

    if (request.method === "POST" && url.pathname === "/download") {
      const payload = await request.json() as DownloadRecord;
      const statuses: DownloadStatus[] = ["pending", "awaiting_selection", "processing", "success", "failed", "partial", "results"];
      if (!/^[A-Za-z0-9:_-]{1,180}$/.test(payload.key || "") || !Number.isSafeInteger(payload.userId)
          || payload.userId <= 0 || !statuses.includes(payload.status)
          || (Object.hasOwn(payload, 'subtitleLanguage') && (payload.source !== 'YouTube'
            || payload.subtitleLanguage !== null && !isSubtitleLanguage(payload.subtitleLanguage)))) return new Response("Invalid download", { status: 400 });
      const now = Date.now();
      const terminal = ["success", "failed", "partial", "results"].includes(payload.status);
      this.ctx.storage.transactionSync(() => {
      if (Object.hasOwn(payload, 'subtitleLanguage')) {
        this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO users(id,first_seen,last_seen) VALUES (?,?,?)`,
          String(payload.userId),now,now);
        this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO youtube_subtitle_choices
          SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM download_history WHERE key=? AND user_id!=?)`,
          payload.key,String(payload.userId),payload.subtitleLanguage ?? null,now,payload.key,String(payload.userId));
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO download_history(key,user_id,source,request,status,title,detail,delivered,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
           status = excluded.status, title = COALESCE(excluded.title, download_history.title),
           detail = excluded.detail, delivered = MAX(download_history.delivered, excluded.delivered),
           updated_at = excluded.updated_at
         WHERE download_history.user_id = excluded.user_id
           AND download_history.status NOT IN ('success','results')
           AND (download_history.status NOT IN ('failed','partial') OR excluded.status = 'success')
           AND (excluded.status NOT IN ('pending','awaiting_selection') OR download_history.status = 'pending')`,
        payload.key, String(payload.userId), cleanText(payload.source) || "نامشخص",
        displayText(payload.request, 500) || "بدون لینک", payload.status, displayText(payload.title, 180),
        terminal ? displayText(payload.detail, 240) : null,
        Math.max(0, Math.min(100, Math.floor(Number(payload.delivered) || 0))), now, now,
      );
      const saved = this.ctx.storage.sql.exec("SELECT * FROM download_history WHERE key = ? AND user_id = ?", payload.key, String(payload.userId)).toArray()[0];
      if (!payload.excludeFromStats && saved && ["success", "partial"].includes(String(saved.status))) {
        const inferred = downloadCategory(String(saved.source), String(saved.request), String(saved.detail || ""));
        const category = inferred === null ? null : DOWNLOAD_CATEGORIES.includes(payload.category!) ? payload.category! : inferred;
        const count = category === null ? 0 : ["ig_story", "music"].includes(category)
          ? asNumber(saved.delivered) : saved.status === "success" && asNumber(saved.delivered) > 0 ? 1 : 0;
        for (let index = 0; index < Math.min(100, count); index++) this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO download_stat_events(download_key,item_index,category,delivered_at) VALUES (?,?,?,?)",
          payload.key, index, category!, now);
      }
      });
      let firstDownload = false;
      if ((payload.status === "success" || payload.status === "partial") && Number(payload.delivered) > 0) {
        const access = this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO membership_access(user_id, first_download_at)
           SELECT user_id, ? FROM download_history
           WHERE key = ? AND user_id = ? AND status IN ('success','partial') AND delivered > 0`,
          now, payload.key, String(payload.userId),
        );
        firstDownload = access.rowsWritten > 0;
      }
      return Response.json({ ok: true, firstDownload });
    }

    if (request.method === "GET" && url.pathname === "/user") {
      const id = url.searchParams.get("id") || "";
      if (!/^[1-9]\d{0,15}$/.test(id)) return new Response("Invalid user", { status: 400 });
      const sql = this.ctx.storage.sql;
      const rows = sql.exec("SELECT * FROM users WHERE id = ?", id).toArray();
      if (!rows.length) return new Response("User not found", { status: 404 });
      const rawUser = rows[0] as unknown as UserSqlRow;
      const selectedLanguage = await this.ctx.storage.get(`language:${id}`);
      const activityRows = sql.exec("SELECT * FROM user_activity WHERE user_id = ?", id).toArray();
      const activity = activityRows[0];
      const staleBefore = Date.now() - 4 * 3600_000;
      const subtitleFilter = url.searchParams.get("subtitles") === "1"
        ? "AND source='YouTube' AND EXISTS (SELECT 1 FROM youtube_subtitle_choices s WHERE s.download_key=download_history.key AND s.user_id=download_history.user_id AND s.language IS NOT NULL)" : "";
      const counts = sql.exec(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'success'),0) AS success, COALESCE(SUM(status = 'failed'),0) AS failed,
        COALESCE(SUM(status = 'partial'),0) AS partial, COALESCE(SUM(status = 'results'),0) AS results,
        COALESCE(SUM(status = 'awaiting_selection' OR (status IN ('pending','processing') AND updated_at >= ?)),0) AS active,
        COALESCE(SUM(status IN ('pending','processing') AND updated_at < ?),0) AS stale,
        COALESCE(SUM(delivered),0) AS delivered FROM download_history WHERE user_id = ? ${subtitleFilter}`, staleBefore, staleBefore, id).one();
      const totalPages = Math.max(1, Math.ceil(asNumber(counts.total) / ADMIN_DOWNLOADS_PAGE_SIZE));
      const rawPage = Number(url.searchParams.get("page") || 0);
      const page = Math.min(Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0, totalPages - 1);
      const downloads = sql.exec(`SELECT h.*, s.download_key AS subtitle_recorded, s.language AS subtitle_language
        FROM download_history h LEFT JOIN youtube_subtitle_choices s ON s.download_key=h.key AND s.user_id=h.user_id
        WHERE h.user_id = ? ${subtitleFilter ? "AND h.source='YouTube' AND s.language IS NOT NULL" : ""}
        ORDER BY h.created_at DESC, h.key DESC LIMIT ? OFFSET ?`,
        id, ADMIN_DOWNLOADS_PAGE_SIZE, page * ADMIN_DOWNLOADS_PAGE_SIZE).toArray().map(row => ({
          key: String(row.key), userId: Number(id), source: String(row.source), request: String(row.request),
          status: row.status as DownloadStatus, title: row.title ? String(row.title) : undefined,
          detail: row.detail ? String(row.detail) : undefined, delivered: asNumber(row.delivered),
          createdAt: asNumber(row.created_at), updatedAt: asNumber(row.updated_at),
          stale: ["pending", "processing"].includes(String(row.status)) && asNumber(row.updated_at) < staleBefore,
          ...(row.subtitle_recorded ? { subtitleLanguage: row.subtitle_language as SubtitleLanguage | null,
            subtitleCosts: subtitleCosts(sql,0,Date.now(),id,String(row.key)) } : {}),
        }));
      return Response.json({
        language: isLanguage(selectedLanguage) ? selectedLanguage : "fa", languageSelected: isLanguage(selectedLanguage),
        user: { id, username: rawUser.username, firstName: rawUser.first_name, lastName: rawUser.last_name,
          linksSent: asNumber(rawUser.links_sent), firstSeen: asNumber(rawUser.first_seen), lastSeen: asNumber(rawUser.last_seen) },
        activity: activity ? { visits: asNumber(activity.visits), interactions: asNumber(activity.interactions),
          starts: asNumber(activity.starts), trackingSince: asNumber(activity.tracking_since) } : null,
        counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, asNumber(value)])),
        usage: this.usageTotals(0, Date.now(), id),
        downloads, page, totalPages,
      });
    }

    if (request.method === "POST" && url.pathname === "/delivery") {
      const payload = (await request.json()) as { key?: string };
      const key = cleanText(payload?.key);
      if (!key) return Response.json({ ok: false, error: "invalid-key" }, { status: 400 });

      const now = Date.now();
      const insert = this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO delivered_media(delivery_key, delivered_at) VALUES (?, ?)",
        key,
        now,
      );
      const inserted = insert.rowsWritten > 0;
      if (inserted) {
        this.ctx.storage.sql.exec(
          "UPDATE counters SET value = value + 1 WHERE key = 'successful_downloads'",
        );
      }

      this.ctx.storage.sql.exec(
        "DELETE FROM delivered_media WHERE delivered_at < ?",
        now - 24 * 60 * 60 * 1000,
      );

      return Response.json({ ok: true, inserted });
    }

    if (request.method === "GET" && url.pathname === "/restricted-users") {
      const sql = this.ctx.storage.sql;
      const rawPage = Number(url.searchParams.get("page") || 0);
      const admins = getAdminIds(this.env).map(String);
      const filter = `(r.until_ms IS NULL OR r.until_ms > ?) AND u.id NOT IN (${admins.map(() => "?").join(",")})`;
      const params = [Date.now(), ...admins];
      const total = asNumber(sql.exec(`SELECT COUNT(*) AS total FROM user_restrictions r JOIN users u ON u.id=r.user_id WHERE ${filter}`, ...params).one().total);
      const totalPages = Math.max(1, Math.ceil(total / ADMIN_USERS_PAGE_SIZE));
      const page = Math.min(Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0, totalPages - 1);
      const users = sql.exec(`SELECT u.id, u.username, u.first_name, u.last_name, r.until_ms
        FROM user_restrictions r JOIN users u ON u.id=r.user_id WHERE ${filter}
        ORDER BY r.until_ms IS NOT NULL, r.until_ms, u.id LIMIT ? OFFSET ?`,
        ...params, ADMIN_USERS_PAGE_SIZE, page * ADMIN_USERS_PAGE_SIZE).toArray().map(row => ({
          id: String(row.id), name: [row.first_name, row.last_name].filter(Boolean).join(" ") || row.username || String(row.id),
          until: row.until_ms === null ? null : asNumber(row.until_ms),
        }));
      return Response.json({ users, total, page, totalPages });
    }

    if (url.pathname === "/restriction") {
      const id = url.searchParams.get("id") || "";
      if (!/^[1-9]\d{0,15}$/.test(id)) return new Response("Invalid user", { status: 400 });
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const body = await request.json() as { actorId?: number; seconds?: number };
        if (!isAdmin(this.env, body.actorId) || isAdmin(this.env, Number(id))) return new Response("Forbidden", { status: 403 });
        if (!Number.isSafeInteger(body.seconds) || body.seconds! < -1 || body.seconds! > 365 * 86400) return new Response("Invalid duration", { status: 400 });
        if (!sql.exec("SELECT id FROM users WHERE id = ?", id).toArray().length) return new Response("User not found", { status: 404 });
        if (body.seconds === 0) sql.exec("DELETE FROM user_restrictions WHERE user_id = ?", id);
        else sql.exec("INSERT INTO user_restrictions(user_id,until_ms) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET until_ms=excluded.until_ms",
          id, body.seconds === -1 ? null : Date.now() + body.seconds! * 1000);
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const row = sql.exec("SELECT until_ms FROM user_restrictions WHERE user_id = ?", id).toArray()[0];
      const until = row?.until_ms == null ? null : Number(row.until_ms);
      return Response.json({ restricted: !!row && (until === null || until > Date.now()), until });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      const summary = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS total_users, COALESCE(SUM(links_sent), 0) AS links_sent FROM users",
      ).one() as SummarySqlRow;
      const success = this.ctx.storage.sql.exec(
        "SELECT value FROM counters WHERE key = 'successful_downloads'",
      ).one() as CounterSqlRow;

      const now = Date.now();
      const active = this.ctx.storage.sql.exec(
        "SELECT COALESCE(SUM(last_seen >= ?),0) AS day, COALESCE(SUM(last_seen >= ?),0) AS week FROM users",
        now - 86400_000, now - 7 * 86400_000,
      ).one();
      const links = this.ctx.storage.sql.exec(
        "SELECT COALESCE(SUM(last_link_at >= ?),0) AS day, COALESCE(SUM(last_link_at >= ?),0) AS week FROM user_link_activity",
        now - 86400_000, now - 7 * 86400_000,
      ).one();
      const tracking = this.ctx.storage.sql.exec("SELECT value FROM counters WHERE key = 'links_tracking_since'").one();
      return Response.json({
        active24h: asNumber(active.day), active7d: asNumber(active.week),
        linkUsers24h: asNumber(links.day), linkUsers7d: asNumber(links.week),
        linksTrackingSince: asNumber(tracking.value),
        totalUsers: asNumber(summary.total_users),
        linksSent: asNumber(summary.links_sent),
        successfulDownloads: asNumber(success.value),
      } satisfies AdminSummary);
    }

    if (request.method === "GET" && url.pathname === "/subtitle-users") {
      const sql = this.ctx.storage.sql;
      const from = `FROM download_history h JOIN youtube_subtitle_choices s ON s.download_key=h.key AND s.user_id=h.user_id
        WHERE h.source='YouTube' AND s.language IS NOT NULL`;
      const totals = sql.exec(`SELECT COUNT(DISTINCT h.user_id) AS totalUsers, COUNT(*) AS requests,
        COALESCE(SUM(h.delivered>0),0) AS delivered, COALESCE(SUM(h.status='failed'),0) AS failed ${from}`).one();
      const totalPages = Math.max(1, Math.ceil(asNumber(totals.totalUsers) / ADMIN_USERS_PAGE_SIZE));
      const requested = Number(url.searchParams.get("page") || 0);
      const page = Math.min(Number.isSafeInteger(requested) && requested >= 0 ? requested : 0, totalPages - 1);
      const users = sql.exec(`SELECT h.user_id AS id, COUNT(*) AS requests, SUM(h.delivered>0) AS delivered,
        MAX(h.created_at) AS lastAt ${from} GROUP BY h.user_id
        ORDER BY lastAt DESC, h.user_id ASC LIMIT ? OFFSET ?`, ADMIN_USERS_PAGE_SIZE, page * ADMIN_USERS_PAGE_SIZE).toArray().map(row => {
        const user = sql.exec("SELECT * FROM users WHERE id=?", row.id).toArray()[0] as UserSqlRow | undefined;
        return { id: String(row.id), name: user ? userDisplayName({ id: user.id, username: user.username,
          firstName: user.first_name, lastName: user.last_name, linksSent: asNumber(user.links_sent),
          firstSeen: asNumber(user.first_seen), lastSeen: asNumber(user.last_seen) }) : String(row.id),
          username: user?.username || null, requests: asNumber(row.requests), delivered: asNumber(row.delivered), lastAt: asNumber(row.lastAt) };
      });
      return Response.json({ ...Object.fromEntries(Object.entries(totals).map(([k,v]) => [k,asNumber(v)])), users, page, totalPages,
        trackingSince: asNumber(sql.exec("SELECT value FROM counters WHERE key='subtitle_tracking_since'").one().value) });
    }

    if (request.method === "GET" && url.pathname === "/users") {
      const rawPage = Number(url.searchParams.get("page") || "0");
      const page = Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
      const usedOnly = url.searchParams.get("used") === "1";
      const requestedPeriod = url.searchParams.get("period");
      const period: AdminPeriod | undefined = requestedPeriod === "day" || requestedPeriod === "week" ? requestedPeriod : undefined;
      const since = Date.now() - (period === "day" ? 1 : 7) * 86400_000;
      // Include legacy link counters as well as newer non-link requests; /start alone is not usage.
      const filter = period
        ? usedOnly ? "WHERE EXISTS (SELECT 1 FROM user_link_activity WHERE user_id = users.id AND last_link_at >= ?)" : "WHERE last_seen >= ?"
        : usedOnly ? "WHERE links_sent > 0 OR EXISTS (SELECT 1 FROM download_history WHERE user_id = users.id)" : "";
      const params = period ? [since] : [];
      const count = this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS total_users FROM users ${filter}`, ...params,
      ).one() as CountSqlRow;
      const totalUsers = asNumber(count.total_users);
      const totalPages = Math.max(1, Math.ceil(totalUsers / ADMIN_USERS_PAGE_SIZE));
      const safePage = Math.min(page, totalPages - 1);
      const offset = safePage * ADMIN_USERS_PAGE_SIZE;
      const rows = this.ctx.storage.sql.exec(
        `SELECT id, username, first_name, last_name, links_sent, first_seen, last_seen
         FROM users
         ${filter}
         ORDER BY last_seen DESC, id ASC
         LIMIT ? OFFSET ?`,
        ...params, ADMIN_USERS_PAGE_SIZE,
        offset,
      ).toArray() as unknown as UserSqlRow[];

      const users: AdminUserRow[] = rows.map((row) => ({
        id: String(row.id),
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        linksSent: asNumber(row.links_sent),
        firstSeen: asNumber(row.first_seen),
        lastSeen: asNumber(row.last_seen),
      }));

      return Response.json({
        users,
        totalUsers,
        page: safePage,
        pageSize: ADMIN_USERS_PAGE_SIZE,
        totalPages,
        ...(usedOnly ? { usedOnly: true } : {}),
        ...(period ? { period } : {}),
      } satisfies AdminUsersPage);
    }

    return new Response("Not Found", { status: 404 });
  }
}

function statsStub(env: AdminStatsEnv) {
  return env.ADMIN_STATS.getByName("global");
}

export async function telegramFileCache(env: Partial<AdminStatsEnv> & { BOT_TOKEN: string }, op: "get" | "put" | "delete", key: string, value?: CachedTelegramFile): Promise<CachedTelegramFile | null> {
  try {
    if (!env.ADMIN_STATS) return null;
    // A file_id belongs to one bot. Never share cached IDs across bot identities.
    const store = env.ADMIN_STATS.getByName(`telegram-files-${env.BOT_TOKEN.split(":")[0]}`);
    const response = await store.fetch(new Request("https://store/file-cache", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, key, value }),
    }));
    if (!response.ok) return null;
    const result = await response.json() as { value?: CachedTelegramFile };
    return result.value || null;
  } catch { return null; } // Cache outages must not block ordinary downloads.
}

export async function recordUserActivity(
  env: AdminStatsEnv,
  user: TrackedUser,
  linkSent: boolean,
  eventId?: number,
  start = false,
): Promise<void> {
  if (!env.ADMIN_STATS || isAdmin(env, user.id)) return;
  try {
    const response = await statsStub(env).fetch("https://admin-stats/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, linkSent, eventId, start } satisfies RecordPayload),
    });
    if (!response.ok) {
      console.warn("admin stats record rejected", { status: response.status });
    }
  } catch (error) {
    console.warn("admin stats record failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordSuccessfulDelivery(env: AdminStatsEnv, deliveryKey: string): Promise<void> {
  try {
    const response = await statsStub(env).fetch("https://admin-stats/delivery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: deliveryKey }),
    });
    if (!response.ok) {
      console.warn("admin delivery stats rejected", { status: response.status });
    }
  } catch (error) {
    console.warn("admin delivery stats failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getAdminSummary(env: AdminStatsEnv): Promise<AdminSummary> {
  const response = await statsStub(env).fetch("https://admin-stats/summary");
  if (!response.ok) throw new Error(`ADMIN_SUMMARY_${response.status}`);
  return (await response.json()) as AdminSummary;
}

export async function getAdminUsersPage(env: AdminStatsEnv, page: number, usedOnly = false, period?: AdminPeriod): Promise<AdminUsersPage> {
  const url = new URL("https://admin-stats/users");
  url.searchParams.set("page", String(Math.max(0, Math.floor(page))));
  if (usedOnly) url.searchParams.set("used", "1");
  if (period) url.searchParams.set("period", period);
  const response = await statsStub(env).fetch(url.toString());
  if (!response.ok) throw new Error(`ADMIN_USERS_${response.status}`);
  return (await response.json()) as AdminUsersPage;
}

export function isInstagramDownloadLink(text: string): boolean {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) continue;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.includes("stories")) return true;
      if (["reel", "reels", "p", "tv"].some((marker) => parts.includes(marker))) return true;
    } catch {
      // Keep scanning URLs in the message.
    }
  }
  return false;
}

function userDisplayName(user: AdminUserRow): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return "بدون نام";
}

export function formatAdminDashboard(summary: AdminSummary): string {
  return [
    "👑 پنل ادمین",
    "",
    `👥 کاربران: ${summary.totalUsers}`,
    `🔗 لینک‌های ارسال‌شده: ${summary.linksSent}`,
    `✅ دانلودهای موفق: ${summary.successfulDownloads}`,
    "",
    `👤 کاربران فعال در ۲۴ ساعت گذشته: ${summary.active24h}`,
    `👤 کاربران فعال در ۷ روز گذشته: ${summary.active7d}`,
    "",
    `🔗 ارسال‌کنندگان لینک در ۲۴ ساعت گذشته: ${summary.linkUsers24h}`,
    `🔗 ارسال‌کنندگان لینک در ۷ روز گذشته: ${summary.linkUsers7d}`,
    ...(Date.now() - summary.linksTrackingSince < 7 * 86400_000
      ? [`ثبت زمان ارسال لینک از ${dateLabel(summary.linksTrackingSince)}`] : []),
  ].join("\n");
}

export function adminDashboardKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "📤 پیام همگانی", callback_data: "admin:broadcast" }],
      [{ text: "مصرف، ترافیک و هزینه", icon_custom_emoji_id: "5231200819986047254", callback_data: "admin:usage" }],
      [{ text: "آمار دانلود سرویس‌ها", icon_custom_emoji_id: "5443127283898405358", callback_data: "admin:downloads" }],
      [{ text: "مدیریت زیرنویس", icon_custom_emoji_id: "5206607081334906820", callback_data: "admin:subtitles" }],
      [{ text: "👥 لیست کاربران", callback_data: "admin:users:0" },
        { text: "⏹ کاربران محدودشده", callback_data: "admin:restricted:0" }],
      [{ text: "کاربران استفاده‌کننده", icon_custom_emoji_id: "5427168083074628963", callback_data: "admin:used:0" }],
      [{ text: "🌐 آمار و کاربران زبان‌ها", callback_data: "admin:languages:all" }],
      [{ text: "👤 فعالیت کاربران", callback_data: "admin:activity" }],
      [{ text: "API اینستاگرام", icon_custom_emoji_id: "5278573677900752088", callback_data: "admin:igapi" },
        { text: "عضویت اجباری چنل", callback_data: "admin:membership" }],
      [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
    ],
  };
}

export function adminActivityKeyboard(): Record<string, unknown> {
  return { inline_keyboard: [
    [{ text: "فعال‌های ۲۴ ساعت", callback_data: "admin:users:0:day" },
      { text: "فعال‌های ۷ روز", callback_data: "admin:users:0:week" }],
    [{ text: "لینک‌فرستاده‌های ۲۴ ساعت", callback_data: "admin:used:0:day" },
      { text: "لینک‌فرستاده‌های ۷ روز", callback_data: "admin:used:0:week" }],
    [{ text: "بازگشت به پنل", callback_data: "admin:stats" }],
  ] };
}

export function formatAdminUsers(page: AdminUsersPage): string {
  if (page.period) return [
    `${page.usedOnly ? "ارسال‌کنندگان لینک" : "کاربران فعال"} در ${page.period === "day" ? "۲۴ ساعت" : "۷ روز"} گذشته (${page.totalUsers})`,
    `صفحه ${page.page + 1}/${page.totalPages}`, "",
    page.users.length ? "برای مشاهده آمار و سابقه دانلود، کاربر را انتخاب کنید:" : "کاربری در این بازه ثبت نشده.",
  ].join("\n");
  return [page.usedOnly ? `کاربران استفاده‌کننده (${page.totalUsers})` : `👥 لیست کاربران (${page.totalUsers})`,
    `صفحه ${page.page + 1}/${page.totalPages}`, "",
    ...(page.usedOnly ? ["ارسال لینک یا درخواست ثبت‌شدهٔ دانلود، جست‌وجو، استخراج صدا یا تشخیص آهنگ.",
      "کاربران قدیمی بر اساس اطلاعات ذخیره‌شده نمایش داده می‌شوند؛ صرفاً /start کافی نیست.", ""] : []),
    page.users.length ? "برای مشاهده آمار و سابقه دانلود، کاربر را انتخاب کنید:"
      : page.usedOnly ? "هنوز استفاده‌ای در اطلاعات ذخیره‌شده یافت نشد." : "هنوز کاربری ثبت نشده."].join("\n");
}

export function adminUsersKeyboard(page: AdminUsersPage): Record<string, unknown> {
  const list = page.usedOnly ? "used" : "users";
  const periodSuffix = page.period ? `:${page.period}` : "";
  const suffix = (page.usedOnly ? ":used" : "") + periodSuffix;
  const rows = page.users.map(user => [{
    text: `${displayText(userDisplayName(user), 35)} • ${user.id}`,
    callback_data: `admin:user:${user.id}:${page.page}:0${suffix}`,
  }]);
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page.page > 0) nav.push({ text: "‹ قبلی", callback_data: `admin:${list}:${page.page - 1}${periodSuffix}` });
  nav.push({ text: "🏠 آمار", callback_data: "admin:stats" });
  if (page.page + 1 < page.totalPages) nav.push({ text: "بعدی ›", callback_data: `admin:${list}:${page.page + 1}${periodSuffix}` });
  return { inline_keyboard: [...rows, nav] };
}

function displayText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

export async function recordDownload(env: Partial<AdminStatsEnv> & { BOT_TOKEN?: string }, record: DownloadRecord): Promise<void> {
  // Administrator subtitle downloads also need visible history and costs.
  // Preserve exclusions for every other admin activity.
  if (!env.ADMIN_STATS || isAdmin(env, record.userId) && !Object.hasOwn(record, 'subtitleLanguage')) return;
  try {
    const response = await statsStub(env as AdminStatsEnv).fetch("https://admin-stats/download", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
    });
    if (!response.ok) console.warn("download history rejected", { status: response.status });
    else {
      const result = await response.json() as { firstDownload?: boolean };
      if (result.firstDownload && env.BOT_TOKEN && !isAdmin(env, record.userId)) {
        try {
          const { notifyFirstDownload } = await import("./membership");
          await notifyFirstDownload(env, record.userId);
        } catch { console.warn("first-download membership prompt unavailable"); }
      }
    }
  } catch { console.warn("download history unavailable"); }
}

export async function getAdminUserDetail(env: AdminStatsEnv, id: string, page: number, subtitlesOnly = false): Promise<AdminUserDetail | null> {
  const url = new URL("https://admin-stats/user");
  url.searchParams.set("id", id);
  url.searchParams.set("page", String(page));
  if (subtitlesOnly) url.searchParams.set("subtitles", "1");
  const response = await statsStub(env).fetch(url.toString());
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ADMIN_USER_${response.status}`);
  return await response.json() as AdminUserDetail;
}

const STATUS_LABELS: Record<DownloadStatus, string> = {
  pending: "⏳ در صف یا بررسی درخواست", awaiting_selection: "🎛 منتظر انتخاب کاربر", processing: "⏳ در حال دریافت یا ارسال",
  success: "✅ موفق؛ فایل تحویل تلگرام شد", failed: "❌ ناموفق", partial: "⚠️ بخشی ارسال شد", results: "🔎 نتایج جست‌وجو؛ بدون دانلود فایل",
};
function dateLabel(value: number): string {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(value);
}

export function formatAdminUserDetail(detail: AdminUserDetail): string {
  const { user, activity, counts } = detail;
  const lines = [`👤 ${displayText(userDisplayName(user), 80)}`, `شناسه: ${user.id}`,
    ...(user.username ? [`نام کاربری: @${displayText(user.username, 40)}`] : []),
    `🌐 زبان: ${LANGUAGE_LABELS[detail.language || "fa"]}${detail.languageSelected === false ? " (پیش‌فرض؛ انتخاب نشده)" : ""}`,
    `اولین مشاهده: ${dateLabel(user.firstSeen)}`, `آخرین استفاده: ${dateLabel(user.lastSeen)}`, "",
    ...(activity ? [`🚪 مراجعه‌ها: ${activity.visits} • برگشت‌ها: ${Math.max(0, activity.visits - 1)}`,
      `💬 تعامل‌ها (پیام و دکمه): ${activity.interactions} • /start: ${activity.starts}`,
      `شروع ثبت آمار مراجعه: ${dateLabel(activity.trackingSince)}`] : ["آمار مراجعه: هنوز از زمان فعال‌شدن ثبت جدید استفاده نکرده است."]),
    "هر مراجعه: استفاده پس از حداقل ۳۰ دقیقه بی‌فعالیتی. ساعت‌ها: تهران.",
    `🔗 لینک‌های ارسالی: ${user.linksSent}`, `📥 درخواست‌های ثبت‌شده: ${counts.total} • فایل‌های تحویل‌شده: ${counts.delivered}`,
    `✅ موفق: ${counts.success} • ❌ ناموفق: ${counts.failed} • ⚠️ ناقص: ${counts.partial}`,
    `⏳ باز: ${counts.active} • ❔ نتیجه نامشخص: ${counts.stale} • 🔎 جست‌وجو: ${counts.results}`, "",
    ...(detail.usage ? [`📦 حجم تحویل ثبت‌شده: ${bytesLabel(detail.usage.bytes)} • سهم تخمینی زمان کانتینر: ${durationLabel(detail.usage.runtimeMs)}`,
      `سهم ترافیک ↓ ${bytesLabel(detail.usage.ingressBytes)} • ↑ ${bytesLabel(detail.usage.egressBytes)}`,
      `هزینهٔ تخمینی ناخالص کانتینر: ${usageCostLabel(detail.usage)}`,
      ...(detail.usage.subtitles ? subtitleCostLines(detail.usage.subtitles) : []), ""] : []),
    `📋 سابقه • صفحه ${detail.page + 1}/${detail.totalPages}`,
    "سابقه و تعداد برگشت‌های پیش از فعال‌شدن ثبت جدید در دسترس نیست.",
  ];
  lines.push(...formatAdminDownloadHistory(detail));
  return lines.join("\n");
}

export function formatAdminDownloadHistory(detail: Pick<AdminUserDetail, 'downloads' | 'page'>): string[] {
  const lines: string[] = [];
  if (!detail.downloads.length) lines.push("هنوز درخواست جدیدی ثبت نشده.");
  detail.downloads.forEach((item, index) => {
    lines.push("", `${detail.page * ADMIN_DOWNLOADS_PAGE_SIZE + index + 1}. ${displayText(item.source, 32)} • ${dateLabel(item.createdAt)}`,
      item.stale ? "❔ نتیجه نهایی ثبت نشده (بیش از ۴ ساعت)" : STATUS_LABELS[item.status],
      ...(item.title ? [`عنوان: ${displayText(item.title, 90)}`] : []),
      ...(item.source === 'YouTube' ? [subtitleChoiceLabel(item.subtitleLanguage),
        ...(item.subtitleLanguage !== undefined && item.subtitleCosts ? [
          `API زیرنویس این دانلود: ${subtitleDollars(item.subtitleCosts.transcriptionNano + item.subtitleCosts.translationNano)}${item.subtitleCosts.unknown ? ' + هزینهٔ نامشخص' : ''}`,
        ] : [])] : []),
      `درخواست: ${displayText(item.request, 180)}`,
      ...(item.delivered ? [`فایل تحویل‌شده: ${item.delivered}`] : []),
      ...(item.detail ? [`توضیح: ${displayText(item.detail, 100)}`] : []));
  });
  return lines;
}

export function adminUserDetailKeyboard(detail: AdminUserDetail, usersPage: number, usedOnly = false, period?: AdminPeriod): Record<string, unknown> {
  const periodSuffix = period ? `:${period}` : "";
  const callback = (page: number) => `admin:user:${detail.user.id}:${usersPage}:${page}${usedOnly ? ":used" : ""}${periodSuffix}`;
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (detail.page > 0) nav.push({ text: "‹ جدیدتر", callback_data: callback(detail.page - 1) });
  if (detail.page + 1 < detail.totalPages) nav.push({ text: "قدیمی‌تر ›", callback_data: callback(detail.page + 1) });
  return { inline_keyboard: [
    ...(nav.length ? [nav] : []),
    [{ text: "زیرنویس؛ دسترسی و دانلودها", icon_custom_emoji_id: "5206607081334906820", callback_data: `admin:subuser:${detail.user.id}:0:0` }],
    [{ text: "مصرف و هزینهٔ این کاربر", icon_custom_emoji_id: "5231200819986047254", callback_data: `admin:usage:${detail.user.id}:${usersPage}:${detail.page}${usedOnly ? ":used" : ""}${periodSuffix}` },
      { text: "⏹ محدودیت دانلود", callback_data: callback(detail.page).replace("admin:user:", "admin:restriction:") }],
    [{ text: "🔄 بروزرسانی", callback_data: callback(detail.page) }],
    [{ text: usedOnly ? "بازگشت به استفاده‌کنندگان" : "👥 بازگشت به کاربران", callback_data: `admin:${usedOnly ? "used" : "users"}:${usersPage}${periodSuffix}` }, { text: "🏠 آمار", callback_data: "admin:stats" }],
  ] };
}

// Telemetry failures must never reject a download or replay a Telegram send.
export async function recordUsage(env: Partial<AdminStatsEnv>, samples: UsageSample[] = [], deliveries: MediaUsage[] = [], runs: ContainerRun[] = [], subtitleCharges: SubtitleCharge[] = []): Promise<boolean> {
  if (!env.ADMIN_STATS) return false;
  try {
    const response = await statsStub(env as AdminStatsEnv).fetch("https://admin-stats/usage", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples, deliveries, runs, subtitleCharges }),
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch { console.warn("admin usage unavailable"); return false; }
}

export function telegramMediaBytes(result: unknown): number | null {
  const message = result as Record<string, any> | null;
  if (!message || typeof message !== "object") return null;
  const media = message.video || message.audio || message.document || message.animation || (Array.isArray(message.photo) ? message.photo.at(-1) : null);
  const size = media?.file_size;
  return Number.isSafeInteger(size) && size >= 0 && size <= 2_000_000_000 ? size : null;
}

export async function getAdminUsage(env: AdminStatsEnv, userId?: string): Promise<AdminUsage> {
  const response = await statsStub(env).fetch(`https://admin-stats/usage${userId ? `?id=${userId}` : ""}`);
  if (!response.ok) throw new Error(`ADMIN_USAGE_${response.status}`);
  return await response.json() as AdminUsage;
}

function bytesLabel(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = value > 0 ? Math.max(0, Math.min(4, Math.floor(Math.log(value) / Math.log(1000)))) : 0;
  return `${(value / 1000 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}
function durationLabel(ms: number): string {
  return `${(ms / 3600000).toFixed(3)} ساعت`;
}

function usageCostLabel(value: UsageTotals, subtitleNano = 0): string {
  // standard-2: 6 GiB RAM, 12 GB disk. CPU is measured from the container
  // cgroup, never inferred from elapsed time. Gross rates verified 2026-10-20.
  const fixed = value.runtimeMs / 1000 * (6 * 0.0000025 + 12 * 0.00000007) + subtitleNano / 1e9;
  const cpu = value.cpuSeconds * 0.000020;
  const low = fixed + cpu + value.egressBytes / 1e9 * 0.025;
  const high = fixed + cpu + value.egressBytes / 1e9 * 0.05;
  return `$${low.toFixed(5)} تا $${high.toFixed(5)}`;
}

export function formatAdminUsage(usage: AdminUsage): string {
  const lines = [usage.userId ? `📊 مصرف کاربر ${usage.userId}` : "📊 مصرف، ترافیک و هزینهٔ دانلودر",
    `شروع ثبت: ${dateLabel(usage.trackingSince)}`, ""];
  for (const [label, value] of [["کل از شروع ثبت", usage.all], ["۲۴ ساعت گذشته", usage.day], ["۷ روز گذشته", usage.week]] as const) {
    lines.push(`• ${label}`, `فایل تحویل‌شده: ${value.downloads} • از کش تلگرام: ${value.cached}`,
      `حجم فایل‌های تحویل‌شده: ${bytesLabel(value.bytes)}${value.unknownSizes ? ` + ${value.unknownSizes} فایل با حجم نامشخص` : ""}`,
      `${usage.userId ? "سهم تخمینی زمان کانتینر" : "زمان روشن ثبت‌شدهٔ کانتینرها"}: ${durationLabel(value.runtimeMs)}`,
      `CPU ثبت‌شده: ${value.cpuSeconds.toFixed(3)} vCPU-s`,
      `ترافیک کانتینر ↓ ${bytesLabel(value.ingressBytes)} • ↑ ${bytesLabel(value.egressBytes)}`,
      `هزینهٔ تخمینی ناخالص کانتینر: ${usageCostLabel(value)}`,
      ...(value.subtitles ? [...subtitleCostLines(value.subtitles),
        `جمع کانتینر و API ثبت‌شده: ${usageCostLabel(value,value.subtitles.transcriptionNano + value.subtitles.translationNano)}`] : []),
      ...(value.cpuMeasuredMs + 1 < value.runtimeMs || value.networkMeasuredMs + 1 < value.runtimeMs
        ? ["⚠️ بخشی از اندازه‌گیری CPU یا شبکه در دسترس نیست؛ برآورد ناقص است."] : []), "");
  }
  lines.push("نوع فعلی: standard-2؛ تعرفه‌ها: ۲۰ اکتبر ۲۰۲۶.",
    ...(usage.subtitleTrackingSince ? [`ثبت هزینهٔ زیرنویس از ${dateLabel(usage.subtitleTrackingSince)}؛ سوابق قبل از آن هزینهٔ قابل بازیابی ندارند.`,
      "API: مدت صدای ارسال‌شده و توکن واقعی پاسخ؛ تعرفهٔ عمومی 2026-10-29، پیش از مالیات، تخفیف و سهمیه. استفاده از کش هزینهٔ API جدید ندارد. هزینهٔ نامشخص در جمع نیست."] : []),
    "هزینه تخمینی است؛ سهمیهٔ رایگان/ماهانه و هزینهٔ Workers، DO، لاگ و پلن لحاظ نشده. ترافیک شبکه الزاماً برابر ترافیک قابل‌صورتحساب نیست.",
    usage.userId ? "مصرف هم‌زمان بر اساس تعداد کارهای فعال تقسیم می‌شود؛ بیکاری و کارهای بدون شناسه فقط در آمار کل است." : "آمار کل شامل بیکاری و کارهای بدون شناسه است؛ جمع سهم کاربران ممکن است کمتر باشد.",
    "نمونه‌برداری در رویدادهای کار است؛ سهم هر بازه بین نمونه‌ها تقریبی است. توقف ناگهانی ممکن است آخرین نمونه را از دست بدهد.",
    usage.lastMeasured ? `آخرین نمونه: ${dateLabel(usage.lastMeasured)}` : "هنوز نمونهٔ مصرف کانتینر ثبت نشده.",
    "آمار پیش از شروع ثبت قابل بازیابی نیست؛ حجم تحویل فایل با ترافیک کانتینر متفاوت است.");
  return lines.join("\n");
}

export async function recordMediaDelivery(env: Partial<AdminStatsEnv> & { BOT_TOKEN: string }, userId: number, chatId: number,
  result: unknown, cached = false, fallbackBytes?: number): Promise<void> {
  const messageId = (result as { message_id?: number } | null)?.message_id;
  if (!Number.isSafeInteger(messageId)) return;
  const bytes = telegramMediaBytes(result) ?? (Number.isSafeInteger(fallbackBytes) && fallbackBytes! >= 0 ? fallbackBytes! : null);
  await recordUsage(env, [], [{ key: `tg:${env.BOT_TOKEN.split(":")[0]}:${chatId}:${messageId}`,
    userId, at: Date.now(), bytes, cached }]);
}
