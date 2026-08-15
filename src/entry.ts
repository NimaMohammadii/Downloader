import legacyWorker from "./index";

type Env = {
  BOT_TOKEN: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
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

type StoryTarget =
  | { kind: "story"; url: string; username: string; storyId: string | null }
  | { kind: "highlight"; url: string; highlightId: string };

type MediaCandidate = {
  kind: "video" | "photo";
  url: string;
  width: number;
  height: number;
};

type CookieJar = Map<string, string>;

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const WEB_APP_ID = "936619743392459";
const STORY_QUERY_HASH = "303a4ae99711322310f25250d988f3b7";
const STORY_DOC_ID = "25317500907894419";
const WWW_CLAIM_KEY = "__www_claim";
const MEDIA_TTL = 10 * 60;
const VIDEO_LIMIT = 19_000_000;
const PHOTO_LIMIT = 4_800_000;

const CHROME_PUBLIC_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const IG_IPHONE_PUBLIC_UA =
  "Instagram 273.0.0.16.70 (iPhone15,2; iOS 17_5_1; en_US; en-US; scale=3.00; 1290x2796; 470085518)";

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
    console.warn("Telegram Story call failed", {
      method,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseStoryTarget(text: string): StoryTarget | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) continue;

      const parts = url.pathname.split("/").filter(Boolean);
      const storiesIndex = parts.indexOf("stories");
      if (storiesIndex < 0) continue;

      const username = parts[storiesIndex + 1] || "";
      const id = parts[storiesIndex + 2] || "";
      if (username === "highlights" && /^\d+$/.test(id)) {
        return { kind: "highlight", url: url.toString(), highlightId: id };
      }
      if (username) {
        return {
          kind: "story",
          url: url.toString(),
          username,
          storyId: /^\d+$/.test(id) ? id : null,
        };
      }
    } catch {
      // Ignore malformed URLs and keep scanning the Telegram message.
    }
  }
  return null;
}

function sessionJar(env: Env): CookieJar {
  const jar: CookieJar = new Map();
  const session = env.INSTAGRAM_SESSIONID?.trim();
  if (session) {
    jar.set("sessionid", session);
    if (!env.INSTAGRAM_DS_USER_ID?.trim()) {
      try {
        const candidate = decodeURIComponent(session).split(":")[0];
        if (/^\d+$/.test(candidate)) jar.set("ds_user_id", candidate);
      } catch {
        const candidate = session.match(/^\d+/)?.[0];
        if (candidate) jar.set("ds_user_id", candidate);
      }
    }
  }
  if (env.INSTAGRAM_CSRFTOKEN?.trim()) jar.set("csrftoken", env.INSTAGRAM_CSRFTOKEN.trim());
  if (env.INSTAGRAM_DS_USER_ID?.trim()) jar.set("ds_user_id", env.INSTAGRAM_DS_USER_ID.trim());
  if (env.INSTAGRAM_MID?.trim()) jar.set("mid", env.INSTAGRAM_MID.trim());
  if (env.INSTAGRAM_IG_DID?.trim()) jar.set("ig_did", env.INSTAGRAM_IG_DID.trim());
  return jar;
}

function fullCookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .filter(([name]) => name !== WWW_CLAIM_KEY)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function instagrapiCookieHeader(jar: CookieJar): string {
  return ["sessionid", "ds_user_id"]
    .map((name) => {
      const value = jar.get(name);
      return value ? `${name}=${value}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

function absorbInstagramState(headers: Headers, jar: CookieJar): void {
  const claim = headers.get("x-ig-set-www-claim")?.trim();
  if (claim) jar.set(WWW_CLAIM_KEY, claim);

  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof extended.getSetCookie === "function"
    ? extended.getSetCookie()
    : [headers.get("set-cookie") || ""];

  for (const raw of values) {
    if (!raw) continue;
    for (const name of ["csrftoken", "sessionid", "ds_user_id", "mid", "ig_did", "rur"]) {
      const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`, "i").exec(raw);
      if (match?.[1]) jar.set(name, match[1]);
    }
  }
}

function userIdFromUser(user: any): string | null {
  const id = String(user?.pk || user?.id || user?.profile_id || "");
  return /^\d+$/.test(id) ? id : null;
}

async function readJsonResponse(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function findReel(data: any, reelKey: string): any | null {
  const direct = data?.reels?.[reelKey];
  if (direct && typeof direct === "object") return direct;

  const arrays = [
    data?.reels_media,
    data?.data?.reels_media,
    data?.data?.xdt_api__v1__feed__reels_media?.reels_media,
  ];
  for (const value of arrays) {
    if (!Array.isArray(value)) continue;
    const exact = value.find((reel: any) => String(reel?.id || reel?.pk || "") === reelKey);
    if (exact) return exact;
    if (value.length === 1) return value[0];
  }
  return null;
}

async function resolveUserId(target: Extract<StoryTarget, { kind: "story" }>, jar: CookieJar): Promise<string | null> {
  const cookie = fullCookieHeader(jar);
  const common = new Headers({
    accept: "*/*",
    "accept-language": "en-US,en;q=0.8",
    "user-agent": CHROME_PUBLIC_UA,
    "x-ig-app-id": WEB_APP_ID,
    "sec-fetch-site": "same-origin",
  });
  if (cookie) common.set("cookie", cookie);
  const csrf = jar.get("csrftoken");
  if (csrf) common.set("x-csrftoken", csrf);
  common.set("x-ig-www-claim", jar.get(WWW_CLAIM_KEY) || "0");

  try {
    const response = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(target.username)}`,
      { headers: common, redirect: "manual" },
    );
    absorbInstagramState(response.headers, jar);
    const data = response.status >= 200 && response.status < 300 ? await readJsonResponse(response) : null;
    const id = userIdFromUser(data?.data?.user || data?.user);
    if (id) {
      console.log("instagram story user resolved", { resolver: "web-profile-info", status: response.status });
      return id;
    }
    console.warn("instagram story user id empty", {
      resolver: "web-profile-info",
      status: response.status,
      redirected: response.status >= 300 && response.status < 400,
    });
  } catch (error) {
    console.warn("instagram story user id failed", {
      resolver: "web-profile-info",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const response = await fetch(
      `https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(target.username)}`,
      { headers: common, redirect: "manual" },
    );
    absorbInstagramState(response.headers, jar);
    const data = response.status >= 200 && response.status < 300 ? await readJsonResponse(response) : null;
    const users = Array.isArray(data?.users) ? data.users : [];
    const hit = users.find(
      (entry: any) => String(entry?.user?.username || "").toLowerCase() === target.username.toLowerCase(),
    );
    const id = userIdFromUser(hit?.user);
    if (id) {
      console.log("instagram story user resolved", { resolver: "topsearch", status: response.status });
      return id;
    }
    console.warn("instagram story user id empty", {
      resolver: "topsearch",
      status: response.status,
      redirected: response.status >= 300 && response.status < 400,
    });
  } catch (error) {
    console.warn("instagram story user id failed", {
      resolver: "topsearch",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const headers = new Headers({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.8",
      "user-agent": CHROME_PUBLIC_UA,
    });
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(target.url, { headers, redirect: "manual" });
    absorbInstagramState(response.headers, jar);
    if (response.ok) {
      const html = await response.text();
      const escaped = target.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(`"pk":"?(\\d+)"?[^{}]{0,1200}"username":"${escaped}"`, "i"),
        new RegExp(`"username":"${escaped}"[^{}]{0,1200}"pk":"?(\\d+)"?`, "i"),
        new RegExp(`"id":"?(\\d+)"?[^{}]{0,1200}"username":"${escaped}"`, "i"),
        new RegExp(`"username":"${escaped}"[^{}]{0,1200}"id":"?(\\d+)"?`, "i"),
      ];
      for (const pattern of patterns) {
        const id = pattern.exec(html)?.[1];
        if (id && /^\d+$/.test(id)) {
          console.log("instagram story user resolved", { resolver: "story-html", status: response.status });
          return id;
        }
      }
    }
  } catch (error) {
    console.warn("instagram story user id failed", {
      resolver: "story-html",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const headers = new Headers({
      accept: "*/*",
      "accept-language": "en-US",
      "user-agent": "Instagram 361.0.0.35.82 (iPad13,8; iOS 18_0; en_US; en-US; scale=2.00; 2048x2732; 674117118) AppleWebKit/420+",
      "x-ig-app-id": "124024574287414",
    });
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(
      `https://i.instagram.com/api/v1/users/${encodeURIComponent(target.username)}/usernameinfo/`,
      { headers, redirect: "manual" },
    );
    const data = response.ok ? await readJsonResponse(response) : null;
    const id = userIdFromUser(data?.user);
    if (id) {
      console.log("instagram story user resolved", { resolver: "usernameinfo-no-fake-auth", status: response.status });
      return id;
    }
  } catch (error) {
    console.warn("instagram story user id failed", {
      resolver: "usernameinfo-no-fake-auth",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

function publicGraphqlHeaders(jar: CookieJar, userAgent: string, withAppId: boolean): Headers {
  const headers = new Headers({
    connection: "Keep-Alive",
    accept: "*/*",
    "accept-encoding": "gzip,deflate",
    "accept-language": "en-US",
    "user-agent": userAgent,
  });
  const cookie = instagrapiCookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  if (withAppId) {
    headers.set("x-ig-app-id", WEB_APP_ID);
    headers.set("x-ig-www-claim", jar.get(WWW_CLAIM_KEY) || "0");
  }
  return headers;
}

async function resolveViaInstagrapiStoryHash(userId: string, jar: CookieJar): Promise<any | null> {
  const variables = JSON.stringify({ reel_ids: [userId], precomposed_overlay: false });
  const url = new URL("https://www.instagram.com/graphql/query/");
  url.searchParams.set("query_hash", STORY_QUERY_HASH);
  url.searchParams.set("variables", variables);

  const variants: Array<[string, string, boolean]> = [
    ["chrome136", CHROME_PUBLIC_UA, false],
    ["iphone-ig", IG_IPHONE_PUBLIC_UA, false],
    ["iphone-ig-appid", IG_IPHONE_PUBLIC_UA, true],
  ];

  for (const [variant, userAgent, withAppId] of variants) {
    try {
      const response = await fetch(url.toString(), {
        headers: publicGraphqlHeaders(jar, userAgent, withAppId),
        redirect: "manual",
      });
      absorbInstagramState(response.headers, jar);

      if (response.status >= 300 && response.status < 400) {
        console.warn("instagram instagrapi story redirected", {
          variant,
          status: response.status,
          to: response.headers.get("location") ? new URL(response.headers.get("location")!, url).pathname : null,
        });
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      const body = await readJsonResponse(response);
      const data = body?.data || body;
      const reel = findReel(data, userId);
      console.log("instagram instagrapi story hash", {
        variant,
        status: response.status,
        apiStatus: typeof body?.status === "string" ? body.status : null,
        found: Boolean(reel),
        itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
        errorCount: Array.isArray(body?.errors) ? body.errors.length : 0,
      });
      if (reel) return reel;
    } catch (error) {
      console.warn("instagram instagrapi story hash failed", {
        variant,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

async function resolveViaWebReelsMedia(reelKey: string, jar: CookieJar): Promise<any | null> {
  const headers = publicGraphqlHeaders(jar, CHROME_PUBLIC_UA, true);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  headers.set("x-requested-with", "XMLHttpRequest");
  headers.set("sec-fetch-site", "same-origin");

  try {
    const response = await fetch(
      `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelKey)}`,
      { headers, redirect: "manual" },
    );
    absorbInstagramState(response.headers, jar);
    if (!response.ok) {
      console.warn("instagram story reels_media rejected", { status: response.status, reelKey });
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await readJsonResponse(response);
    const reel = findReel(body, reelKey);
    console.log("instagram story reels_media", {
      status: response.status,
      found: Boolean(reel),
      itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
    });
    return reel;
  } catch (error) {
    console.warn("instagram story reels_media failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function extractDtsg(html: string): string | null {
  return (
    /"dtsg":\{"token":"([^"]+)"/.exec(html)?.[1] ||
    /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ||
    null
  );
}

async function resolveViaCobaltStory(userId: string, jar: CookieJar): Promise<any | null> {
  const cookie = fullCookieHeader(jar);
  const headers = new Headers({
    "user-agent": CHROME_PUBLIC_UA,
    "sec-gpc": "1",
    "sec-fetch-site": "same-origin",
    "x-ig-app-id": WEB_APP_ID,
    "x-ig-www-claim": jar.get(WWW_CLAIM_KEY) || "0",
  });
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);

  try {
    const home = await fetch("https://www.instagram.com/", { headers, redirect: "manual" });
    absorbInstagramState(home.headers, jar);
    if (!home.ok) {
      console.warn("instagram cobalt story home rejected", { status: home.status });
      await home.body?.cancel().catch(() => undefined);
      return null;
    }
    const dtsg = extractDtsg(await home.text());
    if (!dtsg) {
      console.warn("instagram cobalt story dtsg missing", { status: home.status });
      return null;
    }

    const postHeaders = new Headers(headers);
    postHeaders.set("content-type", "application/x-www-form-urlencoded");
    const body = new URLSearchParams({
      fb_dtsg: dtsg,
      jazoest: "26438",
      variables: JSON.stringify({ reel_ids_arr: [userId] }),
      server_timestamps: "true",
      doc_id: STORY_DOC_ID,
    }).toString();

    const response = await fetch("https://www.instagram.com/api/graphql/", {
      method: "POST",
      headers: postHeaders,
      body,
      redirect: "manual",
    });
    absorbInstagramState(response.headers, jar);
    const data = response.ok ? await readJsonResponse(response) : null;
    const reel = findReel(data, userId);
    console.log("instagram cobalt story fallback", {
      status: response.status,
      found: Boolean(reel),
      itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
    });
    return reel;
  } catch (error) {
    console.warn("instagram cobalt story fallback failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function itemCandidates(item: any): MediaCandidate[] {
  const videos = Array.isArray(item?.video_versions) ? item.video_versions : [];
  if (videos.length) {
    return videos
      .filter((entry: any) => typeof entry?.url === "string" && entry.url.startsWith("https://"))
      .map((entry: any) => ({
        kind: "video" as const,
        url: entry.url,
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0,
      }));
  }

  const images = Array.isArray(item?.image_versions2?.candidates) ? item.image_versions2.candidates : [];
  return images
    .filter((entry: any) => typeof entry?.url === "string" && entry.url.startsWith("https://"))
    .map((entry: any) => ({
      kind: "photo" as const,
      url: entry.url,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
    }));
}

async function probeSize(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: { accept: "*/*", referer: "https://www.instagram.com/" },
      redirect: "follow",
    });
    if (head.ok) {
      const size = Number(head.headers.get("content-length"));
      await head.body?.cancel().catch(() => undefined);
      if (Number.isSafeInteger(size) && size > 0) return size;
    } else {
      await head.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Fall through to a range probe.
  }

  try {
    const response = await fetch(url, {
      headers: {
        accept: "*/*",
        referer: "https://www.instagram.com/",
        range: "bytes=0-0",
      },
      redirect: "follow",
    });
    const range = response.headers.get("content-range") || "";
    const match = /\/(\d+)$/.exec(range);
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

function selectItems(reel: any, storyId: string | null): any[] {
  const items = Array.isArray(reel?.items) ? reel.items : [];
  if (!storyId) return items;
  return items.filter((item: any) => String(item?.pk || item?.id || "").split("_")[0] === storyId);
}

async function resolveStoryMedia(target: StoryTarget, env: Env): Promise<MediaCandidate[]> {
  if (!env.INSTAGRAM_SESSIONID?.trim()) throw new Error("INSTAGRAM_STORY_SESSION_REQUIRED");
  const jar = sessionJar(env);

  let reel: any | null = null;
  let storyId: string | null = null;

  if (target.kind === "highlight") {
    const key = `highlight:${target.highlightId}`;
    reel = await resolveViaWebReelsMedia(key, jar);
    if (!reel) throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
  } else {
    storyId = target.storyId;
    const userId = await resolveUserId(target, jar);
    if (!userId) throw new Error("INSTAGRAM_STORY_USER_NOT_FOUND");

    reel = await resolveViaInstagrapiStoryHash(userId, new Map(jar));
    if (!reel) reel = await resolveViaWebReelsMedia(userId, new Map(jar));
    if (!reel) reel = await resolveViaCobaltStory(userId, new Map(jar));
    if (!reel) throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
  }

  const items = selectItems(reel, storyId);
  if (!items.length) {
    if (storyId) throw new Error("INSTAGRAM_STORY_EXPIRED");
    throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
  }

  const result: MediaCandidate[] = [];
  for (const item of items) {
    const candidate = await chooseCandidate(item);
    if (candidate) result.push(candidate);
  }
  if (!result.length) throw new Error("INSTAGRAM_NO_MEDIA");
  return result;
}

async function signValue(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function legacyMediaProxyUrl(token: string, source: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_TTL;
  const signature = await signValue(token, `${expires}.${source}`);
  const url = new URL(`${BASE_URL}/media`);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("src", source);
  url.searchParams.set("sig", signature);
  return url.toString();
}

function friendlyStoryError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("story_session_required")) return "❌ برای دانلود Story باید Session اینستاگرام به Cloudflare وصل باشه.";
  if (value.includes("story_user_not_found")) return "❌ شناسه‌ی این اکانت برای Story پیدا نشد.";
  if (value.includes("story_expired")) return "❌ این Story دیگه در دسترس نیست یا منقضی شده.";
  if (value.includes("story_login_required")) return "❌ Instagram این Session رو برای Story نپذیرفت؛ لاگ instagrapi story hash رو بفرست.";
  if (value.includes("no_media")) return "❌ فایل Story پیدا شد ولی مدیای قابل ارسال داخلش نبود.";
  return `❌ دانلود Story شکست خورد: ${detail.slice(0, 120)}`;
}

async function handleStoryWebhook(
  request: Request,
  env: Env,
  target: StoryTarget,
  update: TelegramUpdate,
): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const message = update.message;
  if (!message) return Response.json({ ok: true });

  let statusMessageId: number | undefined;
  try {
    const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⏳ لینک Instagram رو گرفتم، دارم Story رو آماده می‌کنم…",
      reply_parameters: { message_id: message.message_id },
    });
    statusMessageId = status.message_id;

    const media = await resolveStoryMedia(target, env);
    for (let index = 0; index < media.length; index++) {
      const item = media[index];
      const proxyUrl = await legacyMediaProxyUrl(env.BOT_TOKEN, item.url);
      const caption = media.length > 1 ? `Instagram • ${index + 1}/${media.length}` : "Instagram";
      if (item.kind === "photo") {
        await telegramCall(env.BOT_TOKEN, "sendPhoto", {
          chat_id: message.chat.id,
          photo: proxyUrl,
          caption,
          reply_parameters: index === 0 ? { message_id: message.message_id } : undefined,
        });
      } else {
        await telegramCall(env.BOT_TOKEN, "sendVideo", {
          chat_id: message.chat.id,
          video: proxyUrl,
          caption,
          width: item.width || undefined,
          height: item.height || undefined,
          supports_streaming: true,
          reply_parameters: index === 0 ? { message_id: message.message_id } : undefined,
        });
      }
    }

    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("instagram story v12 failed", { target: target.kind, detail });
    const text = friendlyStoryError(detail);
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
        text,
      });
    } else {
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text,
        reply_parameters: { message_id: message.message_id },
      });
    }
  }

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "telegram-instagram-downloader",
        mode: "cloudflare-only",
        resolver: "instagram-v12-instagrapi-story-hash",
        botConfigured: Boolean(env.BOT_TOKEN),
        instagramSessionConfigured: Boolean(env.INSTAGRAM_SESSIONID?.trim()),
      });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      let update: TelegramUpdate | null = null;
      try {
        update = (await request.clone().json()) as TelegramUpdate;
      } catch {
        // Let the existing worker return its normal bad-request behavior.
      }

      const message = update?.message;
      const text = (message?.text || message?.caption || "").trim();
      const target = parseStoryTarget(text);
      if (update && target) return handleStoryWebhook(request, env, target, update);
    }

    return legacyWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
