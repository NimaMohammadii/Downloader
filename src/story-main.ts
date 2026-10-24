import appWorker from "./main";
import type { InstagramProfilePost } from "./index";
import {
  telegramTextMotion,
  telegramCustomEmoji,
  recordMediaDelivery,
  recordDownload,
  recordSuccessfulDelivery,
  telegramFileCache,
  type AdminStatsEnv,
} from "./admin";

export { AdminStatsStore } from "./admin";

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
  APIFY_API_TOKEN?: string;
  INSTAGRAM_STORY_PROVIDER?: "apify" | "brightdata";
  queueInstagramStory?: (target: StoryTarget, message: TelegramMessage) => Promise<void>;
  resolvePublicStory?: (target: StoryTarget) => Promise<MediaCandidate[]>;
};

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  video?: { file_id: string };
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type TelegramApiResponse<T> = { ok: boolean; result?: T; description?: string };
export type StoryTarget =
  | { kind: "story"; url: string; username: string; storyId: string | null }
  | { kind: "highlight"; url: string; highlightId: string };
type MediaCandidate = { kind: "video" | "photo"; url: string; width: number; height: number; storyId?: string; variants?: MediaCandidate[] };
type CookieJar = Map<string, string>;

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const WEB_APP_ID = "936619743392459";
const PRIVATE_APP_ID = "567067343352427";
const WWW_CLAIM_KEY = "__www_claim";
const MEDIA_TTL = 10 * 60;
const VIDEO_LIMIT = 19_000_000;
const PHOTO_LIMIT = 4_800_000;
const PRIVATE_BLOKS_VERSION_ID = "7189b949425f9bf80ea8bd880cf5a3080b292d9b1c4b38a18d112f7c4b71e7a8";
const PRIVATE_UA =
  "Instagram 428.0.0.47.67 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 961145276)";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const PRIVATE_SUPPORTED_CAPABILITIES = [
  {
    value: "119.0,120.0,121.0,122.0,123.0,124.0,125.0,126.0,127.0,128.0,129.0,130.0,131.0,132.0,133.0,134.0,135.0,136.0,137.0,138.0,139.0,140.0,141.0,142.0",
    name: "SUPPORTED_SDK_VERSIONS",
  },
  { value: "14", name: "FACE_TRACKER_VERSION" },
  { value: "ETC2_COMPRESSION", name: "COMPRESSION" },
  { value: "gyroscope_enabled", name: "gyroscope" },
];

async function telegramCall<T = unknown>(token: string, method: string, payload: Record<string, unknown>): Promise<T> {
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

async function safeTelegramCall(token: string, method: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await telegramCall(token, method, payload);
  } catch (error) {
    console.warn("Telegram private Story call failed", {
      method,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseInstagramProfileCommand(text: string): { kind: "story" | "posts"; username: string } | null {
  const match = /^(?:اینستاگرام\s+(استوری|پست)|\/(instastory|instapost)(?:@[A-Za-z0-9_]+)?)\s+@?([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)$/i.exec(text.trim());
  if (!match || match[3].includes("..")) return null;
  return { kind: match[1] === "استوری" || match[2]?.toLowerCase() === "instastory" ? "story" : "posts", username: match[3] };
}

export function parseStoryTarget(text: string): StoryTarget | null {
  const links = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of links) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) continue;
      const parts = url.pathname.split("/").filter(Boolean);
      const i = parts.indexOf("stories");
      if (i < 0) continue;
      const username = parts[i + 1] || "";
      const id = parts[i + 2] || "";
      if (username === "highlights" && /^\d+$/.test(id)) {
        return { kind: "highlight", url: url.toString(), highlightId: id };
      }
      if (username) {
        return { kind: "story", url: url.toString(), username, storyId: /^\d+$/.test(id) ? id : null };
      }
    } catch {
      // Keep scanning.
    }
  }
  return null;
}


function createJar(env: Env): CookieJar {
  const jar: CookieJar = new Map();
  const session = env.INSTAGRAM_SESSIONID?.trim();
  if (session) {
    jar.set("sessionid", session);
    if (!env.INSTAGRAM_DS_USER_ID?.trim()) {
      try {
        const id = decodeURIComponent(session).match(/^\d+/)?.[0];
        if (id) jar.set("ds_user_id", id);
      } catch {
        const id = session.match(/^\d+/)?.[0];
        if (id) jar.set("ds_user_id", id);
      }
    }
  }
  if (env.INSTAGRAM_CSRFTOKEN?.trim()) jar.set("csrftoken", env.INSTAGRAM_CSRFTOKEN.trim());
  if (env.INSTAGRAM_DS_USER_ID?.trim()) jar.set("ds_user_id", env.INSTAGRAM_DS_USER_ID.trim());
  if (env.INSTAGRAM_MID?.trim()) jar.set("mid", env.INSTAGRAM_MID.trim());
  if (env.INSTAGRAM_IG_DID?.trim()) jar.set("ig_did", env.INSTAGRAM_IG_DID.trim());
  return jar;
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()]
    .filter(([name]) => name !== WWW_CLAIM_KEY)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function absorbState(headers: Headers, jar: CookieJar): void {
  const claim = headers.get("x-ig-set-www-claim")?.trim();
  if (claim) jar.set(WWW_CLAIM_KEY, claim);
  const mid = headers.get("ig-set-x-mid")?.trim();
  if (mid) jar.set("mid", mid);
  const rur = headers.get("ig-set-ig-u-rur")?.trim();
  if (rur) jar.set("rur", rur);
  const uid = headers.get("ig-set-ig-u-ds-user-id")?.trim();
  if (uid && /^\d+$/.test(uid)) jar.set("ds_user_id", uid);

  const h = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof h.getSetCookie === "function" ? h.getSetCookie() : [headers.get("set-cookie") || ""];
  for (const raw of setCookies) {
    if (!raw) continue;
    for (const name of ["csrftoken", "sessionid", "ds_user_id", "mid", "ig_did", "rur"]) {
      const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`, "i").exec(raw);
      if (match?.[1]) jar.set(name, match[1]);
    }
  }
}

function authParts(jar: CookieJar): { userId: string; sessionId: string } | null {
  const sessionId = jar.get("sessionid")?.trim() || "";
  let userId = jar.get("ds_user_id")?.trim() || "";
  if (!userId && sessionId) {
    try {
      userId = decodeURIComponent(sessionId).match(/^\d+/)?.[0] || "";
    } catch {
      userId = sessionId.match(/^\d+/)?.[0] || "";
    }
  }
  return sessionId && /^\d+$/.test(userId) ? { userId, sessionId } : null;
}

function stableHex(seed: string, length: number): string {
  let state = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < length; round++) {
    state ^= round + 0x9e3779b9;
    for (let i = 0; i < seed.length; i++) {
      state ^= seed.charCodeAt(i) + i;
      state = Math.imul(state, 0x01000193);
      state ^= state >>> 13;
    }
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

function stableUuid(seed: string): string {
  const c = stableHex(seed, 32).split("");
  c[12] = "4";
  c[16] = ((parseInt(c[16], 16) & 0x3) | 0x8).toString(16);
  const h = c.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function privateHeaders(jar: CookieJar): Headers | null {
  const auth = authParts(jar);
  if (!auth) return null;
  const deviceId = stableUuid(`story-device:${auth.userId}`);
  const familyId = stableUuid(`story-family:${auth.userId}`);
  const androidId = `android-${stableHex(`story-android:${auth.userId}`, 16)}`;
  const authorization = `Bearer IGT:2:${btoa(JSON.stringify({
    ds_user_id: auth.userId,
    sessionid: auth.sessionId,
    should_use_header_over_cookies: true,
  }))}`;

  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US",
    "accept-encoding": "gzip, deflate",
    "user-agent": PRIVATE_UA,
    authorization,
    cookie: cookieHeader(jar),
    "x-ig-app-id": PRIVATE_APP_ID,
    "x-ig-app-locale": "en_US",
    "x-ig-device-locale": "en_US",
    "x-ig-mapped-locale": "en_US",
    "x-ig-device-id": deviceId,
    "x-ig-family-device-id": familyId,
    "x-ig-android-id": androidId,
    "x-ig-www-claim": jar.get(WWW_CLAIM_KEY) || "0",
    "x-ig-timezone-offset": "0",
    "x-ig-connection-type": "WIFI",
    "x-ig-capabilities": "3brTv10=",
    "x-ig-app-startup-country": "US",
    "x-bloks-version-id": PRIVATE_BLOKS_VERSION_ID,
    "x-bloks-is-layout-rtl": "false",
    "x-bloks-is-panorama-enabled": "true",
    "x-pigeon-session-id": `UFS-${crypto.randomUUID()}-1`,
    "x-pigeon-rawclienttime": (Date.now() / 1000).toFixed(3),
    "x-ig-bandwidth-speed-kbps": "2750.000",
    "x-ig-bandwidth-totalbytes-b": "24000000",
    "x-ig-bandwidth-totaltime-ms": "4500",
    "x-fb-http-engine": "Tigon/MNS/TCP",
    "x-tigon-is-retry": "False",
    "x-zero-balance": "INIT",
    "x-zero-state": "unknown",
    "zero-http-network-interface": "wifi",
    "x-fb-client-ip": "True",
    "x-fb-server-cluster": "True",
    "ig-intended-user-id": auth.userId,
    "ig-u-ds-user-id": auth.userId,
  });
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  const mid = jar.get("mid");
  if (mid) headers.set("x-mid", mid);
  const rur = jar.get("rur");
  if (rur) headers.set("ig-u-rur", rur);
  return headers;
}

type StoryFailure = "session_missing" | "login_required" | "challenge_required" | "rate_limited" | "network" | "user_lookup" | "unavailable" | "no_media"
  | "apify_auth" | "apify_quota" | "apify_failed" | "apify_timeout" | "apify_invalid_input"
  | "apify_pending" | "apify_still_running" | "apify_run_failed" | "apify_workflow_required" | "apify_actor_missing" | "apify_server_error" | "apify_invalid_response"
  | "apify_wrong_target" | "apify_invalid_media" | "apify_no_media" | "apify_too_many" | "apify_unavailable";

type StoryProviderDiagnostic = {
  stage: "request" | "status" | "dataset";
  runId?: string;
  status?: number;
  reason?: "timeout" | "network_or_redirect" | "unparseable_json";
  providerCode?: string;
  durationMs: number;
};

class StoryError extends Error {
  constructor(readonly code: StoryFailure, readonly diagnostic?: StoryProviderDiagnostic) {
    super(code);
  }
}

function storyErrorText(error: unknown): string {
  const code = error instanceof StoryError ? error.code
    : error instanceof Error && /^apify_[a-z_]+$/.test(error.message) ? error.message : "network";
  if (code === "apify_auth") return "❌ توکن Apify برای دریافت استوری معتبر نیست یا دسترسی استخراج‌کننده فعال نشده است.";
  if (code === "apify_quota") return "❌ اعتبار یا محدودیت حساب Apify اجازه دریافت استوری را نمی‌دهد.";
  if (code === "apify_invalid_input") return "❌ Apify ورودی استخراج‌کننده استوری را نپذیرفت (HTTP 400/422). وضعیت اجرای Rowfinch را بررسی کن.";
  if (code === "apify_actor_missing") return "❌ استخراج‌کننده Rowfinch در Apify پیدا نشد یا برای حساب قابل دسترسی نیست (HTTP 404).";
  if (code === "apify_timeout") return "❌ پاسخ استخراج استوری در مهلت مقرر نرسید؛ اجرا ممکن است در Apify ادامه داشته باشد. قبل از تکرار، اجرای قبلی را بررسی کن.";
  if (code === "apify_server_error") return "❌ خود سرویس Apify پاسخ سرور ناموفق برگرداند. وضعیت اجرا را در داشبورد بررسی کن.";
  if (code === "apify_invalid_response") return "❌ Apify پاسخ قابل‌خواندن به‌صورت JSON برنگرداند.";
  if (code === "apify_run_failed") return "❌ خود اجرای استخراج استوری در Apify ناموفق تمام شد؛ لاگ اجرای ثبت‌شده را بررسی کن.";
  if (code === "apify_still_running") return "❌ اجرای استوری هنوز در Apify ادامه دارد؛ اجرای جدیدی شروع نشد.";
  if (code === "apify_pending") return "❌ نتیجهٔ اجرای استوری هنوز آماده یا قابل دریافت نیست؛ اجرای جدیدی شروع نشد.";
  if (code === "apify_workflow_required") return "❌ مسیر پردازش پایدار استوری تنظیم نشده؛ تنظیمات Workflow همین Worker را بررسی کن.";
  if (code === "apify_failed") return "❌ اجرای استخراج‌کننده Apify کامل نشد؛ قبل از تلاش دوباره، وضعیت اجرا را در داشبورد بررسی کن.";
  if (code === "apify_wrong_target") return "❌ نتیجه استخراج با لینک استوری/هایلایت مطابقت نداشت؛ فایل اشتباه ارسال نشد.";
  if (code === "apify_invalid_media") return "❌ استخراج‌کننده Apify لینک معتبر برای فایل استوری برنگرداند.";
  if (code === "apify_no_media") return "❌ استخراج‌کننده Apify هیچ فایل قابل دانلودی برای این استوری پیدا نکرد.";
  if (code === "apify_too_many") return "❌ تعداد فایل‌های استوری/هایلایت بیشتر از سقف یک درخواست است؛ ارسال ناقص انجام نشد.";
  if (code === "apify_unavailable") return "❌ این استوری در Apify قابل دسترسی نبود، خصوصی یا منقضی شده است.";
  if (code === "session_missing") return "❌ سشن اینستاگرام تنظیم نشده یا معتبر نیست؛ INSTAGRAM_SESSIONID باید در Secretهای همین Worker تنظیم شود.";
  if (code === "login_required") return "❌ اینستاگرام سشن ذخیره‌شده را قبول نکرد؛ سشن نیاز به ورود دوباره دارد.";
  if (code === "challenge_required") return "❌ اکانت اینستاگرام نیاز به تأیید امنیتی دارد؛ ابتدا داخل خود اینستاگرام تأییدش کن.";
  if (code === "rate_limited") return "❌ اینستاگرام درخواست‌های این اکانت یا سرور را محدود کرده؛ کمی بعد دوباره امتحان کن.";
  if (code === "user_lookup") return "❌ شناسه اکانت استوری دریافت نشد؛ لینک کامل همان استوری را بفرست.";
  if (code === "unavailable") return "❌ این استوری منقضی شده یا برای اکانت متصل قابل مشاهده نیست.";
  if (code === "no_media") return "❌ فایل قابل ارسال برای این استوری پیدا نشد؛ ممکن است حجم فایل از سقف ارسال مستقیم بیشتر باشد.";
  return "❌ ارتباط با اینستاگرام کامل نشد؛ دوباره لینک استوری را بفرست.";
}

async function jsonRequest(url: string, headers: Headers, jar: CookieJar): Promise<{ data: any | null; status: number }> {
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    absorbState(response.headers, jar);
    // Authentication errors are frequently JSON on HTTP 400/401/403. Preserve
    // their meaning instead of turning them into an empty story response.
    const raw = await response.text();
    let data: any = null;
    try {
      // Instagram media IDs exceed Number.MAX_SAFE_INTEGER. Protect integer
      // tokens before parsing; quoted strings, decimals and exponents stay intact.
      const exactJson = raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
        /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token,
      );
      data = JSON.parse(exactJson);
    } catch {
      // Non-JSON errors are handled by the response status below.
    }
    const message = String(data?.message || data?.error_type || "").toLowerCase();
    const location = response.headers.get("location") || "";
    let failure: StoryFailure | null = null;
    if (data?.challenge || /challenge_required|checkpoint_required|checkpoint_url|consent_required/.test(message) || /\/(challenge|checkpoint)\//.test(location)) failure = "challenge_required";
    else if (response.status === 429 || /please wait|rate_limit|too many requests|feedback_required/.test(message)) failure = "rate_limited";
    else if (response.status === 401 || /login_required|user_has_logged_out|session_expired/.test(message) || /\/accounts\/login/.test(location)) failure = "login_required";
    console.log("instagram story response", { path: new URL(url).pathname, status: response.status, failure, json: Boolean(data) });
    if (failure) throw new StoryError(failure);
    return { data: response.ok ? data : null, status: response.status };
  } catch (error) {
    if (error instanceof StoryError) throw error;
    console.warn("instagram story network failure", { path: new URL(url).pathname });
    throw new StoryError("network");
  }
}

function userIdFrom(value: any): string | null {
  const id = String(value?.pk || value?.id || value?.profile_id || "");
  return /^\d+$/.test(id) ? id : null;
}

async function privateStoryOwnerId(storyId: string, jar: CookieJar): Promise<string | null> {
  const headers = privateHeaders(jar);
  if (!headers) return null;
  const result = await jsonRequest(
    `https://i.instagram.com/api/v1/media/${encodeURIComponent(storyId)}/info/`, headers, jar,
  );
  const items = Array.isArray(result.data?.items) ? result.data.items : [];
  const item = items.find((value: any) => [value?.pk, value?.id].some((id) => String(id || "").split("_")[0] === storyId));
  return userIdFrom(item?.user);
}

async function privateUserId(username: string, jar: CookieJar): Promise<string | null> {
  const headers = privateHeaders(jar);
  if (!headers) return null;
  const result = await jsonRequest(
    `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`,
    headers,
    jar,
  );
  const id = userIdFrom(result.data?.user);
  console.log("instagram private story user lookup", { status: result.status, found: Boolean(id) });
  return id;
}

async function webUserId(username: string, jar: CookieJar): Promise<string | null> {
  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US,en;q=0.8",
    "user-agent": CHROME_UA,
    "x-ig-app-id": WEB_APP_ID,
    "sec-fetch-site": "same-origin",
  });
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  if (jar.get("csrftoken")) headers.set("x-csrftoken", jar.get("csrftoken")!);
  headers.set("referer", `https://www.instagram.com/${encodeURIComponent(username)}/`);
  const result = await jsonRequest(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    headers,
    jar,
  );
  const id = userIdFrom(result.data?.data?.user || result.data?.user);
  console.log("instagram private story web user fallback", { status: result.status, found: Boolean(id) });
  return id;
}

function findReel(data: any, key: string): any | null {
  const direct = data?.reels?.[key] || data?.data?.reels?.[key];
  if (direct && typeof direct === "object") return direct;
  for (const list of [data?.reels_media, data?.data?.reels_media]) {
    if (!Array.isArray(list)) continue;
    const exact = list.find((item: any) => String(item?.id || item?.pk || "") === key);
    if (exact) return exact;
    if (list.length === 1) return list[0];
  }
  return null;
}

async function privateStoryReel(userId: string, jar: CookieJar): Promise<any | null> {
  const headers = privateHeaders(jar);
  if (!headers) return null;
  const url = new URL(`https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/story/`);
  url.searchParams.set("supported_capabilities_new", JSON.stringify(PRIVATE_SUPPORTED_CAPABILITIES));
  const result = await jsonRequest(url.toString(), headers, jar);
  const reel = result.data?.reel || null;
  console.log("instagram private story feed", {
    status: result.status,
    found: Boolean(reel),
    itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
  });
  if (reel && Array.isArray(reel.items) && reel.items.length) return reel;
  const fallbackHeaders = privateHeaders(jar);
  if (!fallbackHeaders) return reel;
  const fallbackUrl = new URL("https://i.instagram.com/api/v1/feed/reels_media/");
  fallbackUrl.searchParams.set("reel_ids", userId);
  const fallback = await jsonRequest(fallbackUrl.toString(), fallbackHeaders, jar);
  return findReel(fallback.data, userId) || reel;
}

async function privateHighlightReel(highlightId: string, jar: CookieJar): Promise<any | null> {
  const headers = privateHeaders(jar);
  if (!headers) return null;
  const key = `highlight:${highlightId}`;
  const url = new URL("https://i.instagram.com/api/v1/feed/reels_media/");
  url.searchParams.set("reel_ids", key);
  const result = await jsonRequest(url.toString(), headers, jar);
  const reel = findReel(result.data, key);
  console.log("instagram private highlight feed", {
    status: result.status,
    found: Boolean(reel),
    itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
  });
  return reel;
}

function itemCandidates(item: any): MediaCandidate[] {
  const videos = Array.isArray(item?.video_versions) ? item.video_versions : [];
  if (videos.length) {
    return videos
      .filter((v: any) => typeof v?.url === "string" && v.url.startsWith("https://"))
      .map((v: any) => ({ kind: "video" as const, url: v.url, width: Number(v.width) || 0, height: Number(v.height) || 0 }));
  }
  const images = Array.isArray(item?.image_versions2?.candidates) ? item.image_versions2.candidates : [];
  return images
    .filter((v: any) => typeof v?.url === "string" && v.url.startsWith("https://"))
    .map((v: any) => ({ kind: "photo" as const, url: v.url, width: Number(v.width) || 0, height: Number(v.height) || 0 }));
}

async function probeSize(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, { method: "HEAD", headers: { accept: "*/*", referer: "https://www.instagram.com/" }, redirect: "follow" });
    if (head.ok) {
      const size = Number(head.headers.get("content-length"));
      await head.body?.cancel().catch(() => undefined);
      if (Number.isSafeInteger(size) && size > 0) return size;
    } else {
      await head.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Try range below.
  }
  try {
    const response = await fetch(url, {
      headers: { accept: "*/*", referer: "https://www.instagram.com/", range: "bytes=0-0" },
      redirect: "follow",
    });
    const match = /\/(\d+)$/.exec(response.headers.get("content-range") || "");
    const size = match ? Number(match[1]) : Number(response.headers.get("content-length"));
    await response.body?.cancel().catch(() => undefined);
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

async function chooseCandidate(item: any, upload = false): Promise<MediaCandidate | null> {
  const candidates = itemCandidates(item).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!candidates.length) return null;
  if (upload) return candidates[0];
  const limit = candidates[0].kind === "photo" ? PHOTO_LIMIT : VIDEO_LIMIT;
  let unknown: MediaCandidate | null = null;
  for (const candidate of candidates) {
    const size = await probeSize(candidate.url);
    if (size !== null && size <= limit) return candidate;
    if (size === null && !unknown) unknown = candidate;
  }
  return unknown;
}

// Start once, persist the run in the existing Workflow, then receive completion
// through an authenticated Apify webhook. No synchronous extraction or polling.
export type InstagramStoryRun = { id: string; status: string };
const apifyId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9]{6,40}$/.test(value);

async function storyProviderRequest(url: URL, env: Env, stage: StoryProviderDiagnostic["stage"],
  init: RequestInit = {}, runId?: string): Promise<unknown> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: {
      authorization: "Bearer " + env.APIFY_API_TOKEN!.trim(),
      accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}),
    }, redirect: "manual", signal: AbortSignal.timeout(25_000) });
  } catch (error) {
    const timeout = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    const diagnostic: StoryProviderDiagnostic = { stage, reason: timeout ? "timeout" : "network_or_redirect",
      durationMs: Date.now() - started, ...(runId ? { runId } : {}) };
    console.warn("instagram apify story request failed", diagnostic);
    throw new StoryError(stage === "request" ? timeout ? "apify_timeout" : "apify_failed" : "apify_pending", diagnostic);
  }
  const payload: any = await response.json().catch(() => null);
  const diagnostic: StoryProviderDiagnostic = { stage, status: response.status,
    durationMs: Date.now() - started, ...(runId ? { runId } : {}) };
  if (!response.ok) {
    const raw = payload?.error?.type;
    if (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) diagnostic.providerCode = raw;
    console.warn("instagram apify story rejected", diagnostic);
    if ([401, 403].includes(response.status)) throw new StoryError("apify_auth", diagnostic);
    if ([402, 429].includes(response.status)) throw new StoryError("apify_quota", diagnostic);
    if ([400, 422].includes(response.status)) throw new StoryError("apify_invalid_input", diagnostic);
    if (response.status === 404) throw new StoryError(stage === "request" ? "apify_actor_missing" : "apify_pending", diagnostic);
    if ([408, 504].includes(response.status)) throw new StoryError("apify_timeout", diagnostic);
    throw new StoryError(response.status >= 500 ? "apify_server_error" : "apify_failed", diagnostic);
  }
  if (payload === null) {
    diagnostic.reason = "unparseable_json";
    console.warn("instagram apify story invalid response", diagnostic);
    throw new StoryError("apify_invalid_response", diagnostic);
  }
  return payload;
}

export async function startInstagramStoryRun(target: StoryTarget, env: Env,
  callback: { url: string; token: string }): Promise<InstagramStoryRun> {
  const isHighlight = target.kind === "highlight";
  if (!isHighlight && !/^[A-Za-z0-9_.]{1,30}$/.test(target.username)) throw new StoryError("user_lookup");
  if (isHighlight && !/^\d{1,24}$/.test(target.highlightId)) throw new StoryError("user_lookup");
  const canonical = isHighlight
    ? "https://www.instagram.com/stories/highlights/" + target.highlightId + "/"
    : "https://www.instagram.com/stories/" + target.username + "/" + (target.storyId ? target.storyId + "/" : "");
  const url = new URL("https://api.apify.com/v2/actors/rowfinch~instagram-stories-scraper/runs");
  url.search = new URLSearchParams({ waitForFinish: "0", restartOnError: "false", timeout: "600",
    webhooks: btoa(JSON.stringify([{
      eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.ABORTED", "ACTOR.RUN.TIMED_OUT"],
      requestUrl: callback.url,
      headersTemplate: JSON.stringify({ "x-instagram-event-token": callback.token }),
      payloadTemplate: '{"runId":{{resource.id}},"status":{{resource.status}}}',
    }])) }).toString();
  const payload: any = await storyProviderRequest(url, env, "request", { method: "POST",
    body: JSON.stringify({ usernames: [canonical], stories: !isHighlight, highlights: isHighlight,
      ...(isHighlight ? { highlightsLimit: 1 } : {}) }) });
  const run = payload?.data;
  if (!apifyId(run?.id) || typeof run?.status !== "string") throw new StoryError("apify_invalid_response");
  console.log("instagram apify story run started", { runId: run.id, status: run.status, kind: target.kind });
  return { id: run.id, status: run.status };
}

export async function readInstagramStoryRun(runId: string, target: StoryTarget, env: Env): Promise<MediaCandidate[]> {
  if (!apifyId(runId)) throw new StoryError("apify_invalid_response");
  const payload: any = await storyProviderRequest(new URL("https://api.apify.com/v2/actor-runs/" + runId), env, "status", {}, runId);
  const run = payload?.data;
  if (run?.id !== runId) throw new StoryError("apify_invalid_response");
  if (run.status !== "SUCCEEDED") {
    const terminal = ["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status);
    console.warn("instagram apify story run incomplete", { runId, status: run.status });
    throw new StoryError(terminal ? "apify_run_failed" : "apify_still_running");
  }
  if (!apifyId(run.defaultDatasetId)) throw new StoryError("apify_invalid_response");
  const rows = await storyProviderRequest(new URL("https://api.apify.com/v2/datasets/" + run.defaultDatasetId + "/items?format=json"), env, "dataset", {}, runId);
  return instagramStoryItems(rows, target);
}

export function instagramStoryItems(rows: unknown, target: StoryTarget): MediaCandidate[] {
  const isHighlight = target.kind === "highlight";
  if (!Array.isArray(rows)) throw new StoryError("apify_invalid_response");
  if (!rows.length) throw new StoryError("apify_no_media");
  if (rows.some((row: any) => row?.error || row?.error_type)) throw new StoryError("apify_unavailable");

  // An exact story link selects only its own ID, even if the provider returns
  // the whole tray. Do not send a neighboring story by accident.
  const selected = !isHighlight && target.storyId
    ? rows.filter((row: any) => String(row?.id ?? "") === target.storyId)
    : rows;
  if (!selected.length) throw new StoryError("apify_no_media");
  if (selected.length > 20) throw new StoryError("apify_too_many");

  const resolved: MediaCandidate[] = [];
  for (const item of selected) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new StoryError("apify_invalid_media");
    const row = item as Record<string, any>;
    const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
    if (type !== (isHighlight ? "highlight" : "story")) throw new StoryError("apify_wrong_target");
    const storyId = String(row.id ?? "");
    if (!/^\d{1,24}$/.test(storyId)) throw new StoryError("apify_invalid_media");
    if (isHighlight) {
      if (String(row.highlightId ?? "") !== target.highlightId) throw new StoryError("apify_wrong_target");
    } else {
      const owner = String(row.ownerUsername || "").toLowerCase();
      if (owner && owner !== target.username.toLowerCase()) throw new StoryError("apify_wrong_target");
      if (typeof row.url === "string") {
        const match = /\/stories\/([A-Za-z0-9_.]+)\//.exec(row.url);
        if (match && match[1].toLowerCase() !== target.username.toLowerCase()) throw new StoryError("apify_wrong_target");
      }
    }
    const mediaType = typeof row.mediaType === "string" ? row.mediaType.toLowerCase() : "";
    if (mediaType !== "image" && mediaType !== "video") throw new StoryError("apify_invalid_media");
    // Video previews must never be substituted for a missing video file.
    const value = mediaType === "video" ? row.videoUrl : row.displayUrl;
    if (typeof value !== "string") throw new StoryError("apify_no_media");
    let media: URL;
    try { media = new URL(value); }
    catch { throw new StoryError("apify_invalid_media"); }
    const host = media.hostname.toLowerCase();
    if (media.protocol !== "https:" || media.username || media.password || media.port
        || !["cdninstagram.com", "fbcdn.net", "instagram.com"].some(suffix =>
          host === suffix || host.endsWith("." + suffix))) throw new StoryError("apify_invalid_media");

    const candidate: MediaCandidate = {
      kind: mediaType === "video" ? "video" : "photo",
      url: media.toString(), width: Number(row.width) || 0, height: Number(row.height) || 0,
      storyId,
    };
    resolved.push({ ...candidate, variants: [candidate] });
  }
  console.log("instagram story resolver success", {
    resolver: "apify-public-stories", kind: isHighlight ? "highlight" : "story",
    count: resolved.length,
  });
  return resolved;
}

async function privateResolve(target: StoryTarget, env: Env, upload = false): Promise<MediaCandidate[] | null> {
  if (env.INSTAGRAM_STORY_PROVIDER === "brightdata") throw new Error("❌ Bright Data برای استوری/هایلایت پشتیبانی نمی‌شود.");
  if (env.INSTAGRAM_STORY_PROVIDER === "apify" || env.APIFY_API_TOKEN?.trim()) {
    if (!env.APIFY_API_TOKEN?.trim()) throw new StoryError("apify_auth");
    if (!env.resolvePublicStory) throw new StoryError("apify_workflow_required");
    return env.resolvePublicStory(target);
  }
  if (!env.INSTAGRAM_SESSIONID?.trim()) throw new StoryError("session_missing");
  const jar = createJar(env); // One jar for the entire private resolver chain.
  if (!authParts(jar)) throw new StoryError("session_missing");
  let reel: any | null = null;
  let storyId: string | null = null;

  if (target.kind === "highlight") {
    reel = await privateHighlightReel(target.highlightId, jar);
  } else {
    storyId = target.storyId;
    let userId = storyId ? await privateStoryOwnerId(storyId, jar) : null;
    if (!userId) userId = await privateUserId(target.username, jar);
    if (!userId) userId = await webUserId(target.username, jar);
    if (!userId) throw new StoryError("user_lookup");
    reel = await privateStoryReel(userId, jar);
  }
  if (!reel) throw new StoryError("unavailable");

  const allItems = Array.isArray(reel.items) ? reel.items : [];
  const items = storyId
    ? allItems.filter((item: any) => [item?.pk, item?.id].some((id) => String(id || "").split("_")[0] === storyId))
    : allItems;
  console.log("instagram story selection", { itemCount: allItems.length, matchedCount: items.length });
  if (!items.length) throw new StoryError("unavailable");

  const media: MediaCandidate[] = [];
  for (const item of items) {
    const candidate = await chooseCandidate(item, upload);
    if (upload && !candidate) throw new StoryError("no_media");
    if (candidate) media.push(upload ? { ...candidate, variants: itemCandidates(item),
      storyId: String(item?.pk || item?.id || "").split("_")[0] } : candidate);
  }
  if (!media.length) throw new StoryError("no_media");
  return media;
}

export async function instagramProfileStories(username: string, env: Env): Promise<InstagramProfilePost[]> {
  const media = await privateResolve({ kind: "story", username, storyId: null,
    url: `https://www.instagram.com/stories/${username}/` }, env, true);
  if (!media?.length) throw new StoryError("unavailable");
  return media.map(item => {
    if (!/^\d{1,24}$/.test(item.storyId || "")) throw new StoryError("unavailable");
    return { shortcode: item.storyId!, storyId: item.storyId,
      url: `https://www.instagram.com/stories/${username}/${item.storyId}/`, groups: [item.variants || [item]] };
  });
}

// Live/replay resolution shares the working Story session and exact-ID parser.
export type InstagramVideoTarget = {
  kind: "live" | "replay" | "audio" | "music";
  username?: string;
  broadcastId?: string;
  shortcode?: string;
  mediaId?: string;
  videoIndex?: number;
  query?: string;
  musicVideoId?: string;
  recognizeMusic?: boolean;
};
export type InstagramVideoSource = {
  mode: "live" | "replay";
  url?: string;
  manifest?: string;
  title: string;
  duration?: number;
  audioOnly?: boolean;
  musicQuery?: string;
  musicSearch?: boolean;
  musicVideoId?: string;
  recognizeMusic?: boolean;
};

export function parseInstagramAudioTarget(text: string): InstagramVideoTarget | null {
  for (const raw of text.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== "instagram.com") continue;
      const parts = url.pathname.split("/").filter(Boolean);
      if (["p", "reel", "reels", "tv"].includes(parts[0]) && /^[A-Za-z0-9_-]{1,20}$/.test(parts[1] || "")) {
        const index = Number(url.searchParams.get("img_index"));
        return { kind: "audio", shortcode: parts[1], ...(Number.isSafeInteger(index) && index > 0 && index <= 100 ? { videoIndex: index - 1 } : {}) };
      }
      if (parts[0] === "stories" && /^\d+$/.test(parts[2] || "")) return { kind: "audio", mediaId: parts[2] };
    } catch { /* Keep scanning. */ }
  }
  return null;
}

export function parseInstagramVideoTarget(text: string): InstagramVideoTarget | null {
  const command = /^\/(live|replay)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i.exec(text.trim());
  const mode = command?.[1].toLowerCase();
  const input = (command?.[2] || text).trim();
  if (command && /^@?[A-Za-z0-9_.]{1,30}$/.test(input)) {
    return { kind: mode as "live" | "replay", username: input.replace(/^@/, "") };
  }
  for (const raw of input.match(/https?:\/\/[^\s<>"']+/gi) || []) {
    try {
      const url = new URL(raw.replace(/[),.!?\]}]+$/g, ""));
      if (url.hostname.toLowerCase().replace(/^www\./, "") !== "instagram.com") continue;
      const parts = url.pathname.split("/").filter(Boolean);
      const live = parts.indexOf("live");
      if (live === 0 || live === 1) {
        const username = live === 1 ? parts[0] : undefined;
        const broadcastId = /^\d+$/.test(parts[live + 1] || "") ? parts[live + 1] : undefined;
        if (parts[live + 1] && !broadcastId) continue;
        if (username || broadcastId) return { kind: mode === "replay" ? "replay" : "live", username, broadcastId };
      }
      if ((parts[0] === "tv" || (mode === "replay" && ["p", "reel", "reels"].includes(parts[0]))) && /^[A-Za-z0-9_-]{1,20}$/.test(parts[1] || "")) {
        return { kind: "replay", shortcode: parts[1] };
      }
      if (command && parts.length === 1 && /^[A-Za-z0-9_.]{1,30}$/.test(parts[0])) {
        return { kind: mode as "live" | "replay", username: parts[0] };
      }
    } catch { /* Keep scanning. */ }
  }
  return null;
}

class InstagramVideoError extends Error {}

export function instagramVideoErrorText(error: unknown): string {
  if (error instanceof InstagramVideoError) return error.message;
  return storyErrorText(error);
}

function instagramMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["cdninstagram.com", "fbcdn.net"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return value;
  } catch { /* Invalid upstream URL. */ }
}

async function instagramVideoRequest(path: string, jar: CookieJar): Promise<any> {
  const headers = privateHeaders(jar);
  if (!headers) throw new StoryError("session_missing");
  const result = await jsonRequest(`https://i.instagram.com/api/v1/${path}`, headers, jar);
  if (!result.data || result.data.status === "fail") {
    throw new InstagramVideoError("❌ اینستاگرام اطلاعات این لایو را برنگرداند؛ دسترسی حساب یا لینک را بررسی کن.");
  }
  return result.data;
}

function replayMediaSource(item: any): InstagramVideoSource | null {
  const videos = Array.isArray(item?.video_versions) ? item.video_versions : [];
  const best = videos.filter((v: any) => instagramMediaUrl(v?.url))
    .sort((a: any, b: any) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0))[0];
  if (!best) return null;
  return { mode: "replay", url: best.url, title: String(item?.caption?.text || "Instagram Live Replay").slice(0, 180), duration: Number(item?.video_duration) || undefined };
}

export async function resolveInstagramVideo(target: InstagramVideoTarget, env: Env): Promise<InstagramVideoSource> {
  if (target.kind === "music" && (target.query || target.musicVideoId)) {
    return { mode: "replay", title: target.query || "Music", audioOnly: true,
      ...(target.musicVideoId ? { musicVideoId: target.musicVideoId } : { musicQuery: target.query, musicSearch: true }) };
  }
  const jar = createJar(env);
  if (!authParts(jar)) throw new StoryError("session_missing");
  if (target.shortcode || (target.kind === "audio" && target.mediaId)) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = 0n;
    for (const char of target.shortcode || "") id = id * 64n + BigInt(alphabet.indexOf(char));
    if (target.mediaId) id = BigInt(target.mediaId);
    const data = await instagramVideoRequest(`media/${id}/info/`, jar);
    const item = (Array.isArray(data.items) ? data.items : []).find((v: any) => [v.pk, v.id].some(value => String(value || "").split("_")[0] === String(id)));
    const children = Array.isArray(item?.carousel_media) ? item.carousel_media : null;
    const video = children ? (target.videoIndex === undefined ? children.find((v: any) => v?.video_versions?.length) : children[target.videoIndex]) : item;
    if (target.kind === "audio" && video?.has_audio === false) throw new InstagramVideoError("❌ این ویدیو صدا ندارد.");
    const source = replayMediaSource(video);
    if (source && target.kind === "audio") return { ...source, audioOnly: true, title: "Instagram Audio", ...(target.recognizeMusic ? { recognizeMusic: true } : {}) };
    if (source) return source;
    throw new InstagramVideoError(target.kind === "audio" ? "❌ این لینک ویدیوی دارای صدا ندارد؛ عکس به فایل صوتی تبدیل نمی‌شود." : "❌ این لینک ویدیوی بازپخش قابل دانلود ندارد؛ لینک بازپخش منتشرشده را بفرست.");
  }
  let feed: any = null;
  let broadcast: any = null;
  if (target.username && (!target.broadcastId || target.kind === "replay")) {
    const userId = await privateUserId(target.username, jar) || await webUserId(target.username, jar);
    if (!userId) throw new StoryError("user_lookup");
    feed = await instagramVideoRequest(`feed/user/${userId}/story/`, jar);
    if (target.kind === "replay") {
      const broadcasts = Array.isArray(feed?.post_live_item?.broadcasts) ? feed.post_live_item.broadcasts : [];
      broadcast = target.broadcastId
        ? broadcasts.find((v: any) => String(v.id || v.broadcast_id) === target.broadcastId)
        : [...broadcasts].sort((a: any, b: any) => Number(b.published_time || 0) - Number(a.published_time || 0))[0];
    } else broadcast = feed?.broadcast;
  }
  const id = target.broadcastId || String(broadcast?.id || broadcast?.broadcast_id || "");
  if (!/^\d+$/.test(id)) {
    throw new InstagramVideoError(target.kind === "live"
      ? "❌ این اکانت الان لایو فعالِ قابل مشاهده ندارد. برای بازپخش، لینک منتشرشده یا /replay username را بفرست."
      : "❌ بازپخش منتشرشده‌ای برای این حساب پیدا نشد؛ لینک پست، Reel یا TV بازپخش را بفرست.");
  }
  // Archived broadcasts in post_live_item may no longer expose /live/{id}/info/.
  if (!broadcast || target.kind === "live") broadcast = await instagramVideoRequest(`live/${id}/info/`, jar);
  const active = ["active", "interrupted"].includes(String(broadcast?.broadcast_status || "").toLowerCase());
  if (active && target.kind === "replay") throw new InstagramVideoError("❌ این لایو هنوز در حال پخش است؛ برای ضبطش /live username را بفرست.");
  const mode = active ? "live" : "replay";
  const url = instagramMediaUrl(broadcast?.dash_abr_playback_url) || instagramMediaUrl(broadcast?.dash_playback_url);
  const manifest = typeof broadcast?.dash_manifest === "string" ? broadcast.dash_manifest : undefined;
  if (url || manifest) return { mode, url, manifest, title: String(broadcast?.broadcast_message || `${target.username || "Instagram"} Live${active ? "" : " Replay"}`).slice(0, 180) };
  if (!active && /^\d+(?:_\d+)?$/.test(String(broadcast?.media_id || ""))) {
    const data = await instagramVideoRequest(`media/${broadcast.media_id}/info/`, jar);
    const source = replayMediaSource(data.items?.[0]);
    if (source) return source;
  }
  throw new InstagramVideoError("❌ فایل پخش این لایو در دسترس حساب متصل نیست؛ برای لایو پایان‌یافته لینک بازپخش منتشرشده لازم است.");
}

async function signValue(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function proxyUrl(token: string, source: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_TTL;
  const signature = await signValue(token, `${expires}.${source}`);
  const url = new URL(`${BASE_URL}/media`);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("src", source);
  url.searchParams.set("sig", signature);
  return url.toString();
}

export async function sendResolvedStory(env: Env, target: StoryTarget, update: TelegramUpdate, media: MediaCandidate[], existingStatusId?: number): Promise<Response> {
  const message = update.message!;
  const history = { key: `ig:${message.chat.id}:${message.message_id}:${message.from?.id || message.chat.id}`,
    userId: message.from?.id || message.chat.id, source: `Instagram ${target.kind}`, request: target.url };
  let delivered = 0;
  let statusMessageId = existingStatusId;
  try {
    if (!statusMessageId) {
      const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: "⏳ لینک Instagram رو گرفتم، دارم Story رو آماده می‌کنم…",
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
      statusMessageId = status.message_id;
    }

    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      const mediaUrl = await proxyUrl(env.BOT_TOKEN, item.url);
      const caption = media.length > 1 ? `Instagram • ${i + 1}/${media.length}` : "Instagram";
      let usageSent: unknown;
      let usageCached = false;
      if (item.kind === "photo") {
        usageSent = await telegramCall(env.BOT_TOKEN, "sendPhoto", {
          chat_id: message.chat.id,
          photo: mediaUrl,
          caption,
          reply_parameters: i === 0 ? { message_id: message.message_id, allow_sending_without_reply: true } : undefined,
        });
      } else {
        const cacheKey = target.kind === "story" && target.storyId ? `ig:${message.from?.id || message.chat.id}:${target.storyId}:0:video` : undefined;
        const cached = cacheKey ? await telegramFileCache(env, "get", cacheKey) : null;
        const payload = {
          chat_id: message.chat.id,
          video: cached?.method === "sendVideo" ? cached.fileId : mediaUrl,
          caption,
          width: item.width || undefined,
          height: item.height || undefined,
          supports_streaming: true,
          reply_markup: target.kind === "story" && target.storyId && message.from?.id ? { inline_keyboard: [[{
            text: "🎵 فقط صدا", callback_data: `iga|s|${target.storyId}|0|${message.from.id}`,
          }, { text: "🔎 پیداکردن آهنگ", callback_data: `igm|s|${target.storyId}|0|${message.from.id}` }]] } : undefined,
          reply_parameters: i === 0 ? { message_id: message.message_id, allow_sending_without_reply: true } : undefined,
        };
        usageCached = Boolean(cached?.method === "sendVideo");
        let sent: TelegramMessage;
        try { sent = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendVideo", payload); }
        catch (error) {
          if (!cached || !/wrong.*file|file.*(?:invalid|expired)|file_reference|failed to get.*file/i.test(String(error))) throw error;
          usageCached = false;
          await telegramFileCache(env, "delete", cacheKey!);
          sent = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendVideo", { ...payload, video: mediaUrl });
        }
        usageSent = sent;
        if (cacheKey && sent.video?.file_id) await telegramFileCache(env, "put", cacheKey, {
          method: "sendVideo", fileId: sent.video.file_id, data: { caption, supports_streaming: true },
        });
      }
      await recordMediaDelivery(env, message.from?.id || message.chat.id, message.chat.id, usageSent, usageCached);
      delivered++;
      await recordSuccessfulDelivery(env, `${history.key}:${i}`);
    }
    await recordDownload(env, { ...history, status: "success", delivered });
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", { chat_id: message.chat.id, message_id: statusMessageId });
    }
  } catch (error) {
    await recordDownload(env, { ...history, status: delivered ? "partial" : "failed", delivered, detail: "ارسال کامل استوری تأیید نشد." });
    const detail = error instanceof Error ? error.message : String(error);
    console.error("instagram private story send failed", { target: target.kind, detail });
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
        text: `❌ دانلود Story شکست خورد: ${detail.slice(0, 120)}`,
      });
    }
  }
  return Response.json({ ok: delivered === media.length, delivered });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/telegram/webhook" &&
      request.headers.get("x-telegram-bot-api-secret-token") === (env.WEBHOOK_SECRET || WEBHOOK_SECRET)
    ) {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        // Existing worker keeps malformed-update behavior.
      }
      const message = update?.message;
      const text = (message?.text || message?.caption || "").trim();
      const target = parseStoryTarget(text);
      if (update && message && target) {
        if ((env.INSTAGRAM_STORY_PROVIDER || env.APIFY_API_TOKEN?.trim()) && env.queueInstagramStory) {
          await env.queueInstagramStory(target, message);
          return Response.json({ ok: true });
        }
        const history = { key: `ig:${message.chat.id}:${message.message_id}:${message.from?.id || message.chat.id}`,
          userId: message.from?.id || message.chat.id, source: `Instagram ${target.kind}`, request: target.url };
        await recordDownload(env, { ...history, status: "processing" });
        try {
          const media = await privateResolve(target, env);
          if (media?.length) {
            return sendResolvedStory(env, target, update, media);
          }
          throw new Error("INSTAGRAM_NO_MEDIA");
        } catch (error) {
          await recordDownload(env, { ...history, status: "failed", detail: "دریافت محتوای استوری ناموفق بود." });
          console.warn("instagram story resolution failed", {
            target: target.kind, code: error instanceof StoryError ? error.code : "network",
            ...(error instanceof StoryError && error.diagnostic ? { provider: error.diagnostic } : {}),
          });
          await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
            chat_id: message.chat.id,
            text: storyErrorText(error),
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
          });
        }
        return Response.json({ ok: true });
      }
    }

    // Non-Story requests keep their existing route.
    return appWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
