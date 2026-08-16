import appWorker from "./main";
import {
  ADMIN_USER_ID,
  recordUserActivity,
  type AdminStatsEnv,
  type TrackedUser,
} from "./admin";

export { AdminStatsStore } from "./admin";

type Env = AdminStatsEnv & {
  BOT_TOKEN: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
};

type TelegramUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
  caption?: string;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };
type TelegramApiResponse<T> = { ok: boolean; result?: T; description?: string };
type StoryTarget =
  | { kind: "story"; url: string; username: string; storyId: string | null }
  | { kind: "highlight"; url: string; highlightId: string };
type MediaCandidate = { kind: "video" | "photo"; url: string; width: number; height: number };
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
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
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

function parseStoryTarget(text: string): StoryTarget | null {
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

function trackedUser(message: TelegramMessage): TrackedUser | null {
  const id = message.from?.id ?? (message.chat.id > 0 ? message.chat.id : 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    username: message.from?.username,
    firstName: message.from?.first_name,
    lastName: message.from?.last_name,
  };
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

async function jsonRequest(url: string, headers: Headers, jar: CookieJar): Promise<{ data: any | null; status: number }> {
  try {
    const response = await fetch(url, { headers, redirect: "manual" });
    absorbState(response.headers, jar);
    const data = response.ok ? await response.json().catch(() => null) : null;
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    return { data, status: response.status };
  } catch (error) {
    console.warn("instagram private story request failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { data: null, status: 0 };
  }
}

function userIdFrom(value: any): string | null {
  const id = String(value?.pk || value?.id || value?.profile_id || "");
  return /^\d+$/.test(id) ? id : null;
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
  const cookie = jar.get("sessionid");
  if (cookie) headers.set("cookie", `sessionid=${cookie}`);
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
  const direct = data?.reels?.[key];
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
  return reel;
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

async function chooseCandidate(item: any): Promise<MediaCandidate | null> {
  const candidates = itemCandidates(item).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!candidates.length) return null;
  const limit = candidates[0].kind === "photo" ? PHOTO_LIMIT : VIDEO_LIMIT;
  let unknown: MediaCandidate | null = null;
  for (const candidate of candidates) {
    const size = await probeSize(candidate.url);
    if (size !== null && size <= limit) return candidate;
    if (size === null && !unknown) unknown = candidate;
  }
  return unknown;
}

async function privateResolve(target: StoryTarget, env: Env): Promise<MediaCandidate[] | null> {
  if (!env.INSTAGRAM_SESSIONID?.trim()) return null;
  const jar = createJar(env); // One jar for the entire private resolver chain.
  let reel: any | null = null;
  let storyId: string | null = null;

  if (target.kind === "highlight") {
    reel = await privateHighlightReel(target.highlightId, jar);
  } else {
    storyId = target.storyId;
    let userId = await privateUserId(target.username, jar);
    if (!userId) userId = await webUserId(target.username, jar);
    if (!userId) return null;
    reel = await privateStoryReel(userId, jar);
  }
  if (!reel) return null;

  const allItems = Array.isArray(reel.items) ? reel.items : [];
  const items = storyId
    ? allItems.filter((item: any) => String(item?.pk || item?.id || "").split("_")[0] === storyId)
    : allItems;
  if (!items.length) return null;

  const media: MediaCandidate[] = [];
  for (const item of items) {
    const candidate = await chooseCandidate(item);
    if (candidate) media.push(candidate);
  }
  return media.length ? media : null;
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

async function sendResolvedStory(env: Env, target: StoryTarget, update: TelegramUpdate, media: MediaCandidate[]): Promise<Response> {
  const message = update.message!;
  let statusMessageId: number | undefined;
  try {
    const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⏳ لینک Instagram رو گرفتم، دارم Story رو آماده می‌کنم…",
      reply_parameters: { message_id: message.message_id },
    });
    statusMessageId = status.message_id;

    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      const mediaUrl = await proxyUrl(env.BOT_TOKEN, item.url);
      const caption = media.length > 1 ? `Instagram • ${i + 1}/${media.length}` : "Instagram";
      if (item.kind === "photo") {
        await telegramCall(env.BOT_TOKEN, "sendPhoto", {
          chat_id: message.chat.id,
          photo: mediaUrl,
          caption,
          reply_parameters: i === 0 ? { message_id: message.message_id } : undefined,
        });
      } else {
        await telegramCall(env.BOT_TOKEN, "sendVideo", {
          chat_id: message.chat.id,
          video: mediaUrl,
          caption,
          width: item.width || undefined,
          height: item.height || undefined,
          supports_streaming: true,
          reply_parameters: i === 0 ? { message_id: message.message_id } : undefined,
        });
      }
    }
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", { chat_id: message.chat.id, message_id: statusMessageId });
    }
  } catch (error) {
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
        // Existing worker keeps malformed-update behavior.
      }
      const message = update?.message;
      const text = (message?.text || message?.caption || "").trim();
      const target = parseStoryTarget(text);
      if (update && message && target) {
        const media = await privateResolve(target, env);
        if (media?.length) {
          const user = trackedUser(message);
          if (user && user.id !== ADMIN_USER_ID) await recordUserActivity(env, user, true);
          return sendResolvedStory(env, target, update, media);
        }
        console.warn("instagram private story fallback to existing resolver", { target: target.kind });
      }
    }

    // Reels, posts, admin panel, media proxy, and public Story fallbacks remain untouched.
    return appWorker.fetch(request, env as any, ctx);
  },
} satisfies ExportedHandler<Env>;
