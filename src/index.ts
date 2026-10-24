import { recordMediaDelivery, telegramCustomEmoji, telegramTextMotion, telegramFileCache, recordDownload, recordSuccessfulDelivery, type AdminStatsEnv } from "./admin";

type Env = Partial<AdminStatsEnv> & {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
  INSTAGRAM_MID?: string;
  INSTAGRAM_IG_DID?: string;
  uploadInstagramPost?: (post: InstagramPostUpload) => Promise<void>;
};

type TelegramMessage = {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  caption?: string;
  video?: { file_id: string };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

class TelegramApiError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

function acknowledgeKickedChat(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.code !== 403 ||
      !/bot was kicked from (?:the )?(?:supergroup|group|channel) chat/i.test(error.message)) return false;
  console.warn("telegram chat unavailable", { code: error.code, reason: "bot_kicked" });
  return true;
}

type InstagramThrottle = {
  source: "http" | "graphql" | "api" | "feedback";
  httpStatus: number;
  endpoint: string;
  retryAfterSeconds?: number;
  graphqlCode?: number;
};

class InstagramThrottleError extends Error {
  constructor(readonly throttle: InstagramThrottle, message = "INSTAGRAM_RATE_LIMIT_429") { super(message); }
}

function instagramThrottle(response: Response, url: string, source: InstagramThrottle["source"]): InstagramThrottle {
  const info: InstagramThrottle = { source, httpStatus: response.status, endpoint: new URL(url).pathname };
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = /^\d+$/.test(value) ? Number(value)
      : /[a-z]/i.test(value) ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000)) : NaN;
    if (Number.isSafeInteger(seconds) && seconds >= 0) info.retryAfterSeconds = seconds;
  }
  return info;
}

type InstagramTarget =
  | { kind: "post"; url: string; shortcode: string }
  | { kind: "story"; url: string; username: string; storyId: string | null }
  | { kind: "highlight"; url: string; highlightId: string };

type MediaKind = "video" | "photo";

type MediaCandidate = {
  kind: MediaKind;
  url: string;
  width: number;
  height: number;
};

type ResolvedMedia = MediaCandidate & { size: number | null };
export type InstagramPostUpload = {
  shortcode: string;
  storyId?: string;
  url: string;
  chatId: number;
  requestMessageId: number;
  userId: number;
  statusMessageId: number;
  media: ResolvedMedia[];
};
type CookieJar = Map<string, string>;

export type InstagramProfilePost = { shortcode: string; storyId?: string; url: string; groups: MediaCandidate[][] };

// Use the logged-in web profile query used by Instaloader's get_posts(). Each
// Workflow step reads one page; security failures retain the existing classifier.
export async function instagramProfilePage(username: string, after: string | null, env: Env): Promise<{
  posts: InstagramProfilePost[]; next: string | null;
}> {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(username)) throw new Error("INSTAGRAM_PROFILE_INVALID");
  const jar = secretCookies(env);
  if (!jar.get("sessionid")) throw new Error("INSTAGRAM_SESSION_LOGIN_REQUIRED");
  const referer = `https://www.instagram.com/${username}/`;
  const headers = webHeaders(jar, referer);
  headers.set("origin", "https://www.instagram.com");
  headers.set("content-type", "application/x-www-form-urlencoded");
  const variables = { data: { count: 12, include_reel_media_seen_timestamp: true,
    include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
    first: 12, ...(after ? { after } : {}), include_multi_captions: true, username,
    __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false };
  const body = new URLSearchParams({ doc_id: "28975909992013618", variables: JSON.stringify(variables) });
  const { data } = await fetchJson("https://www.instagram.com/graphql/query", headers, jar,
    { method: "POST", body: body.toString() });
  const feed = data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!Array.isArray(feed?.edges) || typeof feed?.page_info?.has_next_page !== "boolean") {
    throw new Error("INSTAGRAM_PROFILE_UNAVAILABLE");
  }
  const posts: InstagramProfilePost[] = [];
  for (const edge of feed.edges) {
    const item = edge?.node;
    const shortcode = String(item?.code || item?.shortcode || "");
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(shortcode)) throw new Error("INSTAGRAM_PROFILE_UNAVAILABLE");
    const nodes = Array.isArray(item?.carousel_media) ? item.carousel_media : [item];
    const groups = candidatesFromProduct(item);
    const incomplete = groups.length !== nodes.length || nodes.some((node: any) =>
      (node?.media_type === 2 || node?.is_video === true) && !node?.video_versions?.length && !node?.video_url);
    posts.push({ shortcode, url: `https://www.instagram.com/p/${shortcode}/`, groups: incomplete ? [] : groups });
  }
  const next = feed.page_info.has_next_page ? feed.page_info.end_cursor : null;
  if (next !== null && (typeof next !== "string" || !next || next.length > 4096 || next === after)) {
    throw new Error("INSTAGRAM_PROFILE_PAGINATION");
  }
  return { posts, next };
}

export async function instagramProfilePostMedia(post: InstagramProfilePost, env: Env): Promise<ResolvedMedia[]> {
  const groups = post.groups.length ? post.groups : await resolvePost({ kind: "post", url: post.url, shortcode: post.shortcode }, env.ADMIN_STATS);
  if (!groups.length || groups.length > 20) throw new Error("INSTAGRAM_NO_MEDIA");
  const media: ResolvedMedia[] = [];
  for (const group of groups) media.push(await chooseCandidate(group, true));
  return media;
}

export function instagramProfileErrorText(error: unknown): string {
  const detail = error instanceof Error ? error.message : "INSTAGRAM_PROFILE_UNAVAILABLE";
  if (/^INSTAGRAM_PROFILE_/.test(detail)) return "❌ فهرست پست‌های این حساب کامل دریافت نشد؛ وجود حساب و دسترسی نشست متصل به آن را بررسی کن.";
  return friendlyError(detail.replace(/^INSTAGRAM_(CHALLENGE_REQUIRED|CONSENT_REQUIRED|LOGIN_REQUIRED)/, "INSTAGRAM_SESSION_$1"),
    error instanceof InstagramThrottleError ? error.throttle : undefined);
}

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const WEB_APP_ID = "936619743392459";
const IOS_APP_ID = "124024574287414";
const POST_WEB_INFO_DOC_ID = "27128499623469141";
const STORY_GRAPHQL_DOC_ID = "25317500907894419";
const IG_WWW_CLAIM_STATE_KEY = "__ig_www_claim";
const MEDIA_LINK_TTL_SECONDS = 10 * 60;
const TELEGRAM_VIDEO_URL_LIMIT = 19_000_000;
const TELEGRAM_VIDEO_UPLOAD_LIMIT = 2_000_000_000;
const TELEGRAM_PHOTO_URL_LIMIT = 4_800_000;
const IG_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const WEB_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const IOS_UA =
  "Instagram 361.0.0.35.82 (iPad13,8; iOS 18_0; en_US; en-US; scale=2.00; 2048x2732; 674117118) AppleWebKit/420+";

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
  if (!response.ok || !data.ok) throw new TelegramApiError(data.description || `Telegram ${method} failed`, data.error_code || response.status);
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
    console.warn(`Telegram ${method} failed`, error);
  }
}

function parseInstagramTarget(text: string): InstagramTarget | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/[),.!?\]}]+$/g, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com" && !host.endsWith(".instagram.com")) continue;

      const parts = url.pathname.split("/").filter(Boolean);
      const storiesIndex = parts.indexOf("stories");
      if (storiesIndex >= 0) {
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
      }

      for (const marker of ["reel", "reels", "p", "tv"]) {
        const markerIndex = parts.indexOf(marker);
        const shortcode = markerIndex >= 0 ? parts[markerIndex + 1] : "";
        if (shortcode && /^[A-Za-z0-9_-]+$/.test(shortcode)) {
          return { kind: "post", url: url.toString(), shortcode };
        }
      }
    } catch {
      // Try next URL.
    }
  }
  return null;
}

function shortcodeToMediaId(shortcode: string): string {
  const normalized = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let value = 0n;
  for (const char of normalized) {
    const digit = IG_SHORTCODE_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("INVALID_INSTAGRAM_SHORTCODE");
    value = value * 64n + BigInt(digit);
  }
  return value.toString();
}

function secretCookies(env: Env): CookieJar {
  const jar: CookieJar = new Map();
  const session = env.INSTAGRAM_SESSIONID?.trim();
  if (session) {
    jar.set("sessionid", session);
    if (!env.INSTAGRAM_DS_USER_ID?.trim()) {
      try {
        const possibleUserId = decodeURIComponent(session).split(":")[0];
        if (/^\d+$/.test(possibleUserId)) jar.set("ds_user_id", possibleUserId);
      } catch {
        // Keep encoded value untouched.
      }
    }
  }
  if (env.INSTAGRAM_CSRFTOKEN?.trim()) jar.set("csrftoken", env.INSTAGRAM_CSRFTOKEN.trim());
  if (env.INSTAGRAM_DS_USER_ID?.trim()) jar.set("ds_user_id", env.INSTAGRAM_DS_USER_ID.trim());
  if (env.INSTAGRAM_MID?.trim()) jar.set("mid", env.INSTAGRAM_MID.trim());
  if (env.INSTAGRAM_IG_DID?.trim()) jar.set("ig_did", env.INSTAGRAM_IG_DID.trim());
  return jar;
}

function cookieHeader(jar: CookieJar): string | null {
  const cookies = Array.from(jar.entries())
    .filter(([name]) => name !== IG_WWW_CLAIM_STATE_KEY)
    .map(([name, value]) => `${name}=${value}`);
  return cookies.length ? cookies.join("; ") : null;
}

function decodePrivateAuthorization(value: string, jar: CookieJar): void {
  const prefix = "Bearer IGT:2:";
  if (!value.startsWith(prefix)) return;
  try {
    const parsed = JSON.parse(atob(value.slice(prefix.length)));
    if (typeof parsed?.sessionid === "string" && parsed.sessionid) jar.set("sessionid", parsed.sessionid);
    if (/^\d+$/.test(String(parsed?.ds_user_id || ""))) jar.set("ds_user_id", String(parsed.ds_user_id));
  } catch {
    // Ignore malformed or changed authorization payloads.
  }
}

function absorbSetCookies(headers: Headers, jar: CookieJar): void {
  const wwwClaim = headers.get("x-ig-set-www-claim")?.trim();
  if (wwwClaim) jar.set(IG_WWW_CLAIM_STATE_KEY, wwwClaim);

  const xMid = headers.get("ig-set-x-mid")?.trim();
  if (xMid) jar.set("mid", xMid);

  const authorization = headers.get("ig-set-authorization")?.trim();
  if (authorization) decodePrivateAuthorization(authorization, jar);

  const routedRur = headers.get("ig-set-ig-u-rur")?.trim();
  if (routedRur) jar.set("rur", routedRur);

  const routedUserId = headers.get("ig-set-ig-u-ds-user-id")?.trim();
  if (routedUserId && /^\d+$/.test(routedUserId)) jar.set("ds_user_id", routedUserId);

  const extended = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  // Workers exposes getAll("Set-Cookie"); get() can lose later cookies.
  // Keep getSetCookie for standard runtimes and a bounded legacy fallback.
  const values = typeof extended.getAll === "function" ? extended.getAll("Set-Cookie")
    : typeof extended.getSetCookie === "function" ? extended.getSetCookie()
    : [headers.get("set-cookie") || ""];

  for (const combined of values) {
    // A comma inside an Expires date is not a new cookie. Only split before
    // an actual name=value pair, including on runtimes with combined fields.
    for (const value of combined.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/)) {
      const first = /^\s*([A-Za-z0-9_!#$%&'*+.^`|~-]+)=([^;]*)/.exec(value);
      if (!first) continue;
      const maxAge = /;\s*max-age\s*=\s*(-?\d+)\s*(?:;|$)/i.exec(value)?.[1];
      const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(value)?.[1];
      const expired = maxAge !== undefined ? Number(maxAge) <= 0
        : expires !== undefined && Date.parse(expires) <= Date.now();
      const cookie = first[2].trim().replace(/^"(.*)"$/, "$1");
      if (!cookie || expired) jar.delete(first[1]);
      else jar.set(first[1], cookie);
    }
  }
}

function webHeaders(jar: CookieJar, referer = "https://www.instagram.com/"): Headers {
  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US,en;q=0.8",
    referer,
    "user-agent": WEB_UA,
    "x-ig-app-id": WEB_APP_ID,
    "x-ig-www-claim": jar.get(IG_WWW_CLAIM_STATE_KEY) || "0",
  });
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  return headers;
}

function browserHeaders(jar: CookieJar, referer = "https://www.instagram.com/"): Headers {
  const headers = webHeaders(jar, referer);
  headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
  headers.set("upgrade-insecure-requests", "1");
  return headers;
}

function mobileHeaders(jar: CookieJar): Headers {
  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US",
    "user-agent": IOS_UA,
    "x-ads-opt-out": "1",
    "x-fb-client-ip": "True",
    "x-fb-connection-type": "wifi",
    "x-fb-http-engine": "Liger",
    "x-fb-server-cluster": "True",
    "x-ig-app-id": IOS_APP_ID,
    "x-ig-app-locale": "en-US",
    "x-ig-connection-type": "WiFi",
    "x-ig-device-locale": "en-US",
    "x-ig-mapped-locale": "en-US",
    "x-ig-www-claim": jar.get(IG_WWW_CLAIM_STATE_KEY) || "0",
  });
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function mediaHeaders(range?: string | null): Headers {
  const headers = new Headers({ accept: "*/*", referer: "https://www.instagram.com/" });
  if (range) headers.set("range", range);
  return headers;
}

function throwForInstagramStatus(status: number): void {
  if (status === 429) throw new Error("INSTAGRAM_RATE_LIMIT_429");
  if (status === 403) throw new Error("INSTAGRAM_ACCESS_403");
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function candidatesFromProduct(product: any): MediaCandidate[][] {
  const legacyNodes = Array.isArray(product?.edge_sidecar_to_children?.edges)
    ? product.edge_sidecar_to_children.edges.map((edge: any) => edge?.node).filter(Boolean)
    : [];
  const nodes = Array.isArray(product?.carousel_media)
    ? product.carousel_media
    : legacyNodes.length
      ? legacyNodes
      : [product];
  const groups: MediaCandidate[][] = [];

  for (const node of nodes) {
    const videos = Array.isArray(node?.video_versions) ? node.video_versions : [];
    const videoCandidates = videos
      .filter((item: any) => typeof item?.url === "string" && item.url.startsWith("https://"))
      .map((item: any) => ({
        kind: "video" as const,
        url: item.url,
        width: numberOrZero(item.width),
        height: numberOrZero(item.height),
      }));
    if (videoCandidates.length) {
      groups.push(videoCandidates);
      continue;
    }

    if (typeof node?.video_url === "string" && node.video_url.startsWith("https://")) {
      groups.push([{ kind: "video", url: node.video_url, width: numberOrZero(node.width), height: numberOrZero(node.height) }]);
      continue;
    }

    // A video's cover is not a successful video download.
    if (node?.is_video === true || node?.media_type === 2 || node?.__typename === "GraphVideo") continue;

    const images = Array.isArray(node?.image_versions2?.candidates) ? node.image_versions2.candidates : [];
    const imageCandidates = images
      .filter((item: any) => typeof item?.url === "string" && item.url.startsWith("https://"))
      .map((item: any) => ({
        kind: "photo" as const,
        url: item.url,
        width: numberOrZero(item.width),
        height: numberOrZero(item.height),
      }));
    if (imageCandidates.length) {
      groups.push(imageCandidates);
      continue;
    }

    const displayUrl = node?.display_url || node?.display_src;
    if (typeof displayUrl === "string" && displayUrl.startsWith("https://")) {
      groups.push([{ kind: "photo", url: displayUrl, width: numberOrZero(node.width), height: numberOrZero(node.height) }]);
    }
  }

  return groups;
}

function decodeEscapedUrl(value: string): string | null {
  const decoded = value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&#x26;/gi, "&");
  return decoded.startsWith("https://") ? decoded : null;
}

function candidatesFromHtmlMeta(html: string): MediaCandidate[][] {
  const found: MediaCandidate[] = [];
  const videoPatterns = [
    /<meta[^>]+property=["']og:video(?::(?:url|secure_url))?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::(?:url|secure_url))?["'][^>]*>/gi,
  ];
  for (const pattern of videoPatterns) {
    for (const match of html.matchAll(pattern)) {
      const url = decodeEscapedUrl(match[1] || "");
      if (url) found.push({ kind: "video", url, width: 0, height: 0 });
    }
  }
  const unique = Array.from(new Map(found.map((item) => [item.url, item])).values());
  return unique.map((item) => [item]);
}

function extractCsrfFromHtml(html: string): string | null {
  return (
    /"csrf_token":"([^"]+)"/.exec(html)?.[1] ||
    /\["InstagramSecurityConfig",\[\],\{"csrf_token":"([^"]+)"/.exec(html)?.[1] ||
    null
  );
}

function extractDtsgToken(html: string): string | null {
  return (
    /"dtsg":\{"token":"([^"]+)"/.exec(html)?.[1] ||
    /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ||
    null
  );
}

async function fetchPostResponse(
  url: string, headers: Headers, jar: CookieJar,
  init: Pick<RequestInit, "method" | "body"> = {},
): Promise<Response> {
  let current = new URL(url);
  const shortcode = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/.exec(current.pathname)?.[1];
  const visited = new Set<string>();
  const signal = AbortSignal.timeout(12_000);
  for (let hop = 0; ; hop++) {
    visited.add(current.href);
    const requestHeaders = new Headers(headers);
    const cookie = cookieHeader(jar);
    if (cookie) requestHeaders.set("cookie", cookie);
    else requestHeaders.delete("cookie");
    if (jar.get("csrftoken")) requestHeaders.set("x-csrftoken", jar.get("csrftoken")!);
    else requestHeaders.delete("x-csrftoken");
    let response: Response;
    try {
      response = await fetch(current.href, { ...init, headers: requestHeaders, redirect: "manual", signal });
    } catch {
      throw new Error("INSTAGRAM_NETWORK_ERROR");
    }
    absorbSetCookies(response.headers, jar);
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new InstagramThrottleError(instagramThrottle(response, current.href, "http"));
    }
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => undefined);
    let location: URL;
    try {
      const next = response.headers.get("location");
      if (!next) throw new Error();
      location = new URL(next, current);
    } catch {
      throw new Error("INSTAGRAM_REDIRECT_INVALID");
    }
    if (location.protocol !== "https:" || !["www.instagram.com", "instagram.com", "i.instagram.com"].includes(location.hostname)
        || location.username || location.password || location.port) throw new Error("INSTAGRAM_REDIRECT_UNSAFE");
    if (/^\/(?:challenge|checkpoint)(?:\/|$)/.test(location.pathname)) throw new Error("INSTAGRAM_CHALLENGE_REQUIRED");
    if (/^\/accounts\/login(?:\/|$)/.test(location.pathname)) throw new Error("INSTAGRAM_LOGIN_REQUIRED");
    if (/^\/(?:accounts\/)?consent(?:\/|$)/.test(location.pathname)) throw new Error("INSTAGRAM_CONSENT_REQUIRED");
    if (location.pathname === "/") throw new Error("INSTAGRAM_REDIRECT_HOME");
    if (location.pathname.startsWith("/accounts/")) throw new Error("INSTAGRAM_REDIRECT_ACCOUNT");
    const destination = /^\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1];
    if (!shortcode || destination !== shortcode || location.hostname === "i.instagram.com") throw new Error("INSTAGRAM_REDIRECT_UNSUPPORTED");
    if (visited.has(location.href)) throw new Error("INSTAGRAM_REDIRECT_LOOP");
    if (hop >= 2) throw new Error("INSTAGRAM_REDIRECT_LIMIT");
    current = location;
  }
}

async function fetchJson(
  url: string, headers: Headers, jar: CookieJar,
  init: Pick<RequestInit, "method" | "body"> = {},
): Promise<{ data: any }> {
  const response = await fetchPostResponse(url, headers, jar, init);
  return readPostJson(response, url);
}

async function readPostJson(response: Response, url: string): Promise<{ data: any }> {
  let data: any = null;
  try { data = await response.json(); } catch (error) {
    if (!(error instanceof SyntaxError)) throw new Error("INSTAGRAM_NETWORK_ERROR");
  }
  // Instagram often returns a precise login/challenge rejection with HTTP 400
  // or 403. Classify it before reducing the response to its status alone.
  try { throwPostAccessFailure(data); } catch (error) {
    if (error instanceof Error && ["INSTAGRAM_RATE_LIMIT_429", "INSTAGRAM_FEEDBACK_REQUIRED"].includes(error.message)) {
      const graphql = Array.isArray(data?.errors) ? data.errors.find((item: any) =>
        item?.code === 1675004 || /rate limit exceeded/i.test(String(item?.message || ""))) : undefined;
      const source = error.message === "INSTAGRAM_FEEDBACK_REQUIRED" ? "feedback" : graphql ? "graphql" : "api";
      const info = instagramThrottle(response, url, source);
      if (Number.isSafeInteger(graphql?.code)) info.graphqlCode = graphql.code;
      throw new InstagramThrottleError(info, error.message);
    }
    throw error;
  }
  throwForInstagramStatus(response.status);
  if (!response.ok) throw new Error(response.status === 401 ? "INSTAGRAM_LOGIN_REQUIRED" : `INSTAGRAM_HTTP_${response.status}`);
  if (!data || typeof data !== "object") throw new Error(`INSTAGRAM_NON_JSON_HTTP_${response.status}`);
  return { data };
}

function throwPostAccessFailure(data: any): void {
  if (Array.isArray(data?.errors) && data.errors.some((error: any) =>
    error?.code === 1675004 || /rate limit exceeded/i.test(String(error?.message || "")))) {
    throw new Error("INSTAGRAM_RATE_LIMIT_429");
  }
  const marker = String(data?.message || data?.error_type || "").toLowerCase();
  if (/^(?:login_required|session_expired|user_has_logged_out)$/.test(marker)) throw new Error("INSTAGRAM_LOGIN_REQUIRED");
  if (data?.challenge || data?.checkpoint_url || /^(?:challenge_required|checkpoint_required)$/.test(marker)) {
    throw new Error("INSTAGRAM_CHALLENGE_REQUIRED");
  }
  if (marker === "consent_required") throw new Error("INSTAGRAM_CONSENT_REQUIRED");
  if (marker === "feedback_required") throw new Error("INSTAGRAM_FEEDBACK_REQUIRED");
  if (/please wait|rate_limit|too many requests/.test(marker)) throw new Error("INSTAGRAM_RATE_LIMIT_429");
  if (data?.status === "fail" || data?.errors?.length) throw new Error("INSTAGRAM_API_REJECTED");
}

async function fetchHtml(
  url: string,
  headers: Headers,
  jar: CookieJar,
): Promise<string> {
  const response = await fetchPostResponse(url, headers, jar);
  // Webpage requests can also return a JSON security/activity rejection. Use
  // the same classifier and stop before another authenticated endpoint runs.
  if (response.headers.get("content-type")?.includes("application/json")) {
    await readPostJson(response, url);
    return "";
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throwForInstagramStatus(response.status);
    throw new Error(response.status === 401 ? "INSTAGRAM_LOGIN_REQUIRED" : `INSTAGRAM_HTTP_${response.status}`);
  }
  let html: string;
  try { html = await response.text(); } catch { throw new Error("INSTAGRAM_NETWORK_ERROR"); }
  if (/<form\b[^>]*(?:action=["'][^"']*\/accounts\/login|id=["']loginForm["'])/i.test(html)) throw new Error("INSTAGRAM_LOGIN_REQUIRED");
  if (/<form\b[^>]*action=["'][^"']*\/(?:challenge|checkpoint)(?:\/|["'])/i.test(html)) throw new Error("INSTAGRAM_CHALLENGE_REQUIRED");
  return html;
}

async function resolveViaMobileMediaInfo(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  // The ID is encoded in the shortcode. oEmbed is a separate access-controlled
  // endpoint: its 403 must never prevent requesting the actual media info.
  const mediaId = shortcodeToMediaId(target.shortcode);

  const media = await fetchJson(
    `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
    mobileHeaders(jar),
    jar,
  );
  const product = media.data?.items?.[0];
  if (!product) return null;

  const groups = candidatesFromProduct(product);
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "public-mobile-api" });
    return groups;
  }
  return null;
}

function exactPostGroups(value: unknown, shortcode: string, mediaId: string, depth = 0): MediaCandidate[][] {
  if (depth > 18 || !value || typeof value !== "object") return [];
  if (!Array.isArray(value)) {
    const item = value as Record<string, any>;
    const code = item.shortcode || item.code;
    if (code && code !== shortcode) return [];
    if (code === shortcode || String(item.pk || item.id || "").split("_")[0] === mediaId) {
      const groups = candidatesFromProduct(item);
      if (groups.length) return groups;
    }
  }
  for (const child of Object.values(value)) {
    const groups = exactPostGroups(child, shortcode, mediaId, depth + 1);
    if (groups.length) return groups;
  }
  return [];
}

async function resolveViaPostPage(
  target: Extract<InstagramTarget, { kind: "post" }>, jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  // Reuse the requested page's state for web-info when Instagram sends only
  // its app shell. The media-info API can require login for a public post.
  const page = await fetchHtml(`https://www.instagram.com/p/${target.shortcode}/`, browserHeaders(jar), jar);
  // Reuse anonymous page cookies/CSRF for the exact-post web-info query.
  const csrf = extractCsrfFromHtml(page);
  if (csrf) jar.set("csrftoken", csrf);
  const groups = exactPostGroups(safeJsonScripts(page), target.shortcode, shortcodeToMediaId(target.shortcode));
  if (groups.length) return groups;
  const meta = page.match(/<meta\b[^>]*\bproperty=["']og:video(?::(?:url|secure_url))?["'][^>]*>/gi) || [];
  const fromMeta = candidatesFromHtmlMeta(meta.join("\n"));
  if (fromMeta.length) return fromMeta;
  if (!jar.get("csrftoken")) return null;

  // The shortcode web-info query returns media omitted from the HTML app shell.
  // Reuse page tokens rather than requiring another homepage bootstrap.
  const headers = webHeaders(jar, target.url);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("origin", "https://www.instagram.com");
  headers.set("x-requested-with", "XMLHttpRequest");
  const lsd = /\["LSD",\[\],\{"token":"([^"]+)"/.exec(page)?.[1];
  if (lsd) headers.set("x-fb-lsd", lsd);
  const response = await fetchJson("https://www.instagram.com/graphql/query", headers, jar, {
    method: "POST",
    body: new URLSearchParams({
      doc_id: POST_WEB_INFO_DOC_ID,
      variables: JSON.stringify({
        shortcode: target.shortcode,
        __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
      }),
      server_timestamps: "true",
    }).toString(),
  });
  const items = response.data?.data?.xdt_api__v1__media__shortcode__web_info?.items;
  const fromWebInfo = exactPostGroups(items, target.shortcode, shortcodeToMediaId(target.shortcode));
  if (fromWebInfo.length) {
    console.log("instagram resolver success", { resolver: "public-graphql-web-info" });
    return fromWebInfo;
  }
  return null;
}

function safeJsonScripts(html: string): unknown[] {
  const values: unknown[] = [];
  const pattern = /<script\b[^>]*\bdata-sjs(?:=["'][^"']*["'])?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1] || "";
    if (!raw.includes("video") && !raw.includes("xig_polaris_media") && !raw.includes("image_versions2")) continue;
    try {
      values.push(JSON.parse(raw));
    } catch {
      // Ignore malformed script.
    }
  }
  return values;
}

// Reject login cookies if a logged-out Instagram response unexpectedly sets them.
class PublicPostCookieJar extends Map<string, string> {
  override set(name: string, value: string): this {
    if (/^(?:sessionid|ds_user_id)$/i.test(name)) return this;
    return super.set(name, value);
  }
}

// The existing AdminStats Durable Object stores one global backoff across
// stateless Worker instances. A store outage cannot break ordinary downloads.
async function publicInstagramCooldown(
  store: AdminStatsEnv["ADMIN_STATS"] | undefined,
  seconds?: number,
): Promise<number> {
  if (!store) return 0;
  try {
    const request = new Request("https://admin-stats/instagram-public-cooldown", seconds === undefined
      ? { method: "GET", signal: AbortSignal.timeout(1500) }
      : { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ seconds }), signal: AbortSignal.timeout(1500) });
    const response = await store.getByName("global").fetch(request);
    if (!response.ok) return 0;
    const result = await response.json() as { remainingSeconds?: number };
    const remaining = result.remainingSeconds;
    return Number.isSafeInteger(remaining) && remaining! >= 0 && remaining! <= 86400 ? remaining! : 0;
  } catch {
    console.warn("instagram public cooldown storage unavailable");
    return 0;
  }
}

// Public posts and Reels never read or send configured Instagram account secrets.
async function resolvePost(
  target: Extract<InstagramTarget, { kind: "post" }>,
  store?: AdminStatsEnv["ADMIN_STATS"],
): Promise<MediaCandidate[][]> {
  const remaining = await publicInstagramCooldown(store);
  if (remaining) throw new Error(`INSTAGRAM_PUBLIC_COOLDOWN_${remaining}`);
  const anonymous: CookieJar = new PublicPostCookieJar();
  const attempts: Array<[string, () => Promise<MediaCandidate[][] | null>]> = [
    ["public/webpage", () => resolveViaPostPage(target, anonymous)],
    ["public/mobile-api", () => resolveViaMobileMediaInfo(target, anonymous)],
  ];
  const diagnostics: string[] = [];
  const failure = (code: string) => new Error(`${code} [${diagnostics.join(",")}]`);
  for (const [name, run] of attempts) {
    let code = "EMPTY";
    let throttle: InstagramThrottle | undefined;
    try {
      const groups = await run();
      if (groups?.length) return groups;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      code = /^INSTAGRAM_[A-Z0-9_]+$/.test(detail) ? detail : "INSTAGRAM_REQUEST_ERROR";
      if (error instanceof InstagramThrottleError) throttle = error.throttle;
    }
    diagnostics.push(`${name}:${code}`);
    // Stop on a restriction rather than trying another route or account.
    if (["INSTAGRAM_RATE_LIMIT_429", "INSTAGRAM_FEEDBACK_REQUIRED",
         "INSTAGRAM_CHALLENGE_REQUIRED", "INSTAGRAM_CONSENT_REQUIRED"].includes(code)) {
      if (code === "INSTAGRAM_RATE_LIMIT_429" || code === "INSTAGRAM_FEEDBACK_REQUIRED") {
        // This is OUR conservative pause, not Instagram's promised unblock time.
        // Respect an explicit Retry-After; otherwise avoid repeat traffic for 15 min.
        const wait = throttle?.retryAfterSeconds;
        const seconds = Number.isSafeInteger(wait) && wait! > 0
          ? Math.min(wait!, 86400) : 15 * 60;
        await publicInstagramCooldown(store, seconds);
      }
      const error = failure(code);
      throw throttle ? new InstagramThrottleError(throttle, error.message) : error;
    }
  }
  throw failure("INSTAGRAM_POST_UNAVAILABLE");
}

function cobaltStoryHeaders(jar: CookieJar): Headers {
  const headers = new Headers({
    "user-agent": WEB_UA,
    "sec-gpc": "1",
    "sec-fetch-site": "same-origin",
    "x-ig-app-id": WEB_APP_ID,
    "x-ig-www-claim": jar.get(IG_WWW_CLAIM_STATE_KEY) || "0",
  });
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

type CobaltStoryResponse = {
  data: any | null;
  status: number;
  finalPath: string;
  contentType: string;
};

async function cobaltStoryJson(
  url: string,
  jar: CookieJar,
  init: { method?: "GET" | "POST"; body?: string } = {},
): Promise<CobaltStoryResponse> {
  const headers = cobaltStoryHeaders(jar);
  if (init.method === "POST") headers.set("content-type", "application/x-www-form-urlencoded");

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method || "GET",
      headers,
      body: init.body,
      redirect: "follow",
    });
  } catch (error) {
    console.warn("instagram cobalt story request failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { data: null, status: 0, finalPath: new URL(url).pathname, contentType: "" };
  }

  absorbSetCookies(response.headers, jar);
  throwForInstagramStatus(response.status);
  const finalUrl = new URL(response.url || url);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let data: any | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    console.warn("instagram cobalt story non-json", {
      path: new URL(url).pathname,
      status: response.status,
      finalPath: finalUrl.pathname,
      contentType,
    });
  }

  if (!response.ok) {
    console.warn("instagram cobalt story request rejected", {
      path: new URL(url).pathname,
      status: response.status,
      finalPath: finalUrl.pathname,
      contentType,
    });
  }

  return { data, status: response.status, finalPath: finalUrl.pathname, contentType };
}

async function cobaltStoryDtsg(jar: CookieJar): Promise<string | null> {
  const headers = cobaltStoryHeaders(jar);
  let response: Response;
  try {
    response = await fetch("https://www.instagram.com/", {
      headers,
      redirect: "follow",
    });
  } catch (error) {
    console.warn("instagram cobalt story dtsg failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  absorbSetCookies(response.headers, jar);
  throwForInstagramStatus(response.status);
  const html = await response.text();
  const dtsg = extractDtsgToken(html);
  console.log("instagram cobalt story dtsg", {
    status: response.status,
    finalPath: new URL(response.url || "https://www.instagram.com/").pathname,
    found: Boolean(dtsg),
  });
  return dtsg;
}

function userIdFromApiUser(user: any): string | null {
  const id = String(user?.pk || user?.id || user?.profile_id || "");
  return /^\d+$/.test(id) ? id : null;
}

async function cobaltStoryUserId(
  target: Extract<InstagramTarget, { kind: "story" }>,
  jar: CookieJar,
): Promise<string | null> {
  const profile = await cobaltStoryJson(
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(target.username)}`,
    jar,
  );
  const profileId = userIdFromApiUser(profile.data?.data?.user || profile.data?.user);
  if (profileId) {
    console.log("instagram cobalt story user resolved", {
      resolver: "web-profile-info",
      status: profile.status,
    });
    return profileId;
  }

  const search = await cobaltStoryJson(
    `https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(target.username)}`,
    jar,
  );
  const users = Array.isArray(search.data?.users) ? search.data.users : [];
  const match = users.find(
    (entry: any) => String(entry?.user?.username || "").toLowerCase() === target.username.toLowerCase(),
  );
  const searchId = userIdFromApiUser(match?.user);
  if (searchId) {
    console.log("instagram cobalt story user resolved", {
      resolver: "topsearch-fallback",
      status: search.status,
    });
    return searchId;
  }

  console.warn("instagram cobalt story user unresolved", {
    profileStatus: profile.status,
    profileFinalPath: profile.finalPath,
    searchStatus: search.status,
    searchFinalPath: search.finalPath,
  });
  return null;
}

function findStoryReel(data: any, reelKey: string): any | null {
  const direct = data?.reels?.[reelKey];
  if (direct && typeof direct === "object") return direct;

  const arrays = [
    data?.reels_media,
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

async function cobaltStoryGraphql(userId: string, jar: CookieJar): Promise<any | null> {
  const dtsg = await cobaltStoryDtsg(jar);
  if (!dtsg) {
    console.warn("instagram cobalt story graphql skipped", { reason: "dtsg-missing", userId });
    return null;
  }

  const body = new URLSearchParams({
    fb_dtsg: dtsg,
    jazoest: "26438",
    variables: JSON.stringify({ reel_ids_arr: [userId] }),
    server_timestamps: "true",
    doc_id: STORY_GRAPHQL_DOC_ID,
  }).toString();

  const response = await cobaltStoryJson(
    "https://www.instagram.com/api/graphql/",
    jar,
    { method: "POST", body },
  );
  const reel = findStoryReel(response.data, userId);
  console.log("instagram cobalt story graphql", {
    status: response.status,
    finalPath: response.finalPath,
    found: Boolean(reel),
    itemCount: Array.isArray(reel?.items) ? reel.items.length : 0,
  });
  return reel;
}

async function cobaltHighlightRest(reelKey: string, jar: CookieJar): Promise<any | null> {
  const response = await cobaltStoryJson(
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelKey)}`,
    jar,
  );
  const reel = findStoryReel(response.data, reelKey);
  console.log("instagram cobalt highlight rest", {
    status: response.status,
    finalPath: response.finalPath,
    found: Boolean(reel),
  });
  return reel;
}

function mediaGroupsFromStoryReel(reel: any, exactStoryId: string | null): MediaCandidate[][] {
  const items = Array.isArray(reel?.items) ? reel.items : [];
  const selectedItems = exactStoryId
    ? items.filter((item: any) => String(item?.pk || item?.id || "").split("_")[0] === exactStoryId)
    : items;
  const groups: MediaCandidate[][] = [];
  for (const item of selectedItems) groups.push(...candidatesFromProduct(item));
  return groups;
}

async function resolveStory(
  target: Extract<InstagramTarget, { kind: "story" | "highlight" }>,
  env: Env,
): Promise<MediaCandidate[][]> {
  if (!env.INSTAGRAM_SESSIONID?.trim()) throw new Error("INSTAGRAM_STORY_SESSION_REQUIRED");

  const jar = secretCookies(env);

  if (target.kind === "highlight") {
    const reelKey = `highlight:${target.highlightId}`;
    const reel = await cobaltHighlightRest(reelKey, jar);
    if (!reel) throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
    const groups = mediaGroupsFromStoryReel(reel, null);
    if (groups.length) {
      console.log("instagram story resolver success", { resolver: "cobalt-highlight-rest", count: groups.length });
      return groups;
    }
    throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
  }

  const userId = await cobaltStoryUserId(target, jar);
  if (!userId) throw new Error("INSTAGRAM_STORY_USER_NOT_FOUND");

  const reel = await cobaltStoryGraphql(userId, jar);
  if (!reel) throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");

  const groups = mediaGroupsFromStoryReel(reel, target.storyId);
  if (groups.length) {
    console.log("instagram story resolver success", { resolver: "cobalt-story-graphql", count: groups.length });
    return groups;
  }

  if (target.storyId) throw new Error("INSTAGRAM_STORY_EXPIRED");
  throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");
}

async function probeSize(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, { method: "HEAD", headers: mediaHeaders(), redirect: "follow" });
    if (head.ok) {
      const size = Number(head.headers.get("content-length"));
      if (Number.isSafeInteger(size) && size > 0) return size;
    }
    await head.body?.cancel().catch(() => undefined);
  } catch {
    // Some CDN hosts reject HEAD.
  }

  try {
    const response = await fetch(url, { headers: mediaHeaders("bytes=0-0"), redirect: "follow" });
    const range = response.headers.get("content-range") || "";
    const match = /\/(\d+)$/.exec(range);
    const size = match ? Number(match[1]) : Number(response.headers.get("content-length"));
    await response.body?.cancel().catch(() => undefined);
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch {
    return null;
  }
}

async function chooseCandidate(group: MediaCandidate[], uploadVideo = false): Promise<ResolvedMedia> {
  const sorted = [...group].sort((a, b) => b.width * b.height - a.width * a.height);
  const limit = sorted[0]?.kind === "photo" ? TELEGRAM_PHOTO_URL_LIMIT
    : uploadVideo ? TELEGRAM_VIDEO_UPLOAD_LIMIT : TELEGRAM_VIDEO_URL_LIMIT;
  let unknown: MediaCandidate | null = null;

  for (const candidate of sorted) {
    const size = await probeSize(candidate.url);
    if (size !== null && size <= limit) return { ...candidate, size };
    if (size === null) unknown = candidate;
  }
  if (unknown) return { ...unknown, size: null };
  if (uploadVideo && sorted[0]?.kind === "video") throw new Error("INSTAGRAM_VIDEO_UPLOAD_TOO_LARGE");
  throw new Error(sorted[0]?.kind === "photo" ? "INSTAGRAM_PHOTO_TOO_LARGE" : "INSTAGRAM_VIDEO_TOO_LARGE");
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function createMediaProxyUrl(token: string, source: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + MEDIA_LINK_TTL_SECONDS;
  const value = `${expires}.${source}`;
  const signature = await signValue(token, value);
  const url = new URL(`${BASE_URL}/media`);
  url.searchParams.set("exp", String(expires));
  url.searchParams.set("src", source);
  url.searchParams.set("sig", signature);
  return url.toString();
}

function allowedMediaHost(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === "cdninstagram.com" ||
    value.endsWith(".cdninstagram.com") ||
    value === "fbcdn.net" ||
    value.endsWith(".fbcdn.net") ||
    value === "instagram.com" ||
    value.endsWith(".instagram.com")
  );
}

async function handleMediaProxy(request: Request, env: Env, url: URL): Promise<Response> {
  const expires = Number(url.searchParams.get("exp"));
  const source = url.searchParams.get("src") || "";
  const signature = url.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isSafeInteger(expires) || expires < now || expires > now + MEDIA_LINK_TTL_SECONDS + 120) {
    return new Response("Expired", { status: 403 });
  }
  const expected = await signValue(env.BOT_TOKEN, `${expires}.${source}`);
  if (!constantTimeEqual(signature, expected)) return new Response("Forbidden", { status: 403 });

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    return new Response("Bad media URL", { status: 400 });
  }
  if (sourceUrl.protocol !== "https:" || !allowedMediaHost(sourceUrl.hostname)) {
    return new Response("Bad media host", { status: 400 });
  }

  const upstream = await fetch(sourceUrl.toString(), {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: mediaHeaders(request.headers.get("range")),
    redirect: "follow",
  });
  if (!upstream.ok && upstream.status !== 206) {
    console.warn("instagram media proxy failed", { status: upstream.status, host: sourceUrl.hostname });
    await upstream.body?.cancel().catch(() => undefined);
    return new Response("Instagram media unavailable", { status: 502 });
  }

  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "video/mp4");
  responseHeaders.set("cache-control", "private, no-store");
  responseHeaders.set("content-disposition", "inline");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function resolveTarget(target: InstagramTarget, env: Env): Promise<ResolvedMedia[]> {
  const groups = target.kind === "post" ? await resolvePost(target, env.ADMIN_STATS) : await resolveStory(target, env);
  const resolved: ResolvedMedia[] = [];
  for (const group of groups) resolved.push(await chooseCandidate(group, target.kind === "post" && Boolean(env.uploadInstagramPost)));
  return resolved;
}

function friendlyError(detail: string, throttle?: InstagramThrottle): string {
  const value = detail.toLowerCase();
  const cooldown = /^instagram_public_cooldown_(\d+)$/.exec(value);
  if (cooldown) return `❌ اینستاگرام درخواست‌های عمومی را محدود کرده؛ ربات برای جلوگیری از تشدید محدودیت، ${cooldown[1]} ثانیه دیگر درخواست جدید نمی‌فرستد.`;
  if (value.startsWith("instagram_session_challenge_required")) {
    return "❌ حساب اینستاگرام متصل نیاز به تأیید امنیتی دارد؛ ابتدا در خود اینستاگرام تأیید شود.";
  }
  if (value.startsWith("instagram_session_consent_required")) {
    return "❌ اینستاگرام برای حساب متصل پذیرش شرایط می‌خواهد؛ این مرحله باید داخل خود اینستاگرام کامل شود.";
  }
  if (value.startsWith("instagram_session_login_required")) {
    return "❌ اینستاگرام نشست حساب متصل را برای دریافت این پست نپذیرفت؛ ورود حساب و دسترسی آن به پست باید بررسی شود.";
  }
  if (value.startsWith("instagram_post_unavailable")) {
    return "❌ اطلاعات قابل دانلود این پست از اینستاگرام دریافت نشد؛ دوباره امتحان کن.";
  }
  if (value.includes("rate_limit_429")) {
    return throttle?.retryAfterSeconds
      ? `❌ اینستاگرام دریافت محتوا را موقتاً محدود کرده؛ حداقل ${throttle.retryAfterSeconds} ثانیه بعد دوباره امتحان کن.`
      : "❌ اینستاگرام دریافت محتوا را موقتاً محدود کرده؛ زمان دقیق رفع محدودیت اعلام نشده است.";
  }
  if (value.includes("feedback_required")) return "❌ اینستاگرام این درخواست را به دلیل محدودیت فعالیت نپذیرفت؛ وضعیت حساب و دسترسی آن باید بررسی شود.";
  if (value.includes("access_403")) {
    return "❌ Instagram یکی از مسیرهای دانلود رو با 403 بست؛ مسیرهای بعدی هم جواب ندادن.";
  }
  if (value.includes("story_session_required")) {
    return "❌ برای دانلود Story باید Session اینستاگرام به Cloudflare وصل باشه.";
  }
  if (value.includes("story_user_not_found")) {
    return "❌ نتونستم شناسه‌ی این اکانت رو برای Story پیدا کنم. لاگ story user resolver رو بفرست.";
  }
  if (value.includes("story_login_required") || value.includes("login_required")) {
    return "❌ Instagram برای این Story/Highlight لاگین معتبر می‌خواد یا همه‌ی مسیرهای Session رو رد کرده.";
  }
  if (value.includes("story_expired")) {
    return "❌ این Story دیگه در دسترس نیست یا منقضی شده.";
  }
  if (value.includes("video_upload_too_large")) return "❌ حجم ویدیو از سقف ارسال ۲ گیگابایت بیشتر است.";
  if (value.includes("too_large") || value.includes("too big")) {
    return "❌ حجم این فایل برای ارسال مستقیم با Bot API تلگرام زیادی بالاست.";
  }
  if (value.includes("wrong file identifier/http url specified") || value.includes("failed to get http url content")) {
    return "❌ فایل پیدا شد، ولی Telegram نتونست اون رو از Worker بگیره.";
  }
  if (value.includes("no_media")) return "❌ توی این لینک فایل قابل دانلود پیدا نکردم.";
  return `❌ دانلود Instagram شکست خورد: ${detail.slice(0, 140)}`;
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== (env.WEBHOOK_SECRET || WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message) return Response.json({ ok: true });
  const text = (message.text || message.caption || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "لینک Reel، پست ویدیویی یا Story اینستاگرام رو بفرست؛ فایلش رو همین‌جا می‌فرستم ⚡️",
    });
    return Response.json({ ok: true });
  }

  const target = parseInstagramTarget(text);
  if (!target) {
    await telegramCall(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "یه لینک معتبر Instagram بفرست 👇",
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
    return Response.json({ ok: true });
  }

  const history = { key: `ig:${message.chat.id}:${message.message_id}:${message.from?.id || message.chat.id}`,
    userId: message.from?.id || message.chat.id, source: `Instagram ${target.kind}`, request: target.url };
  let delivered = 0;
  await recordDownload(env, { ...history, status: "processing" });
  let statusMessageId: number | undefined;
  try {
    const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⏳ لینک اینستاگرام رو گرفتم، دارم فایل رو آماده می‌کنم…",
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
    statusMessageId = status.message_id;

    const media = await resolveTarget(target, env);
    if (!media.length) throw new Error("INSTAGRAM_NO_MEDIA");

    // Hand off the entire ordered post before publishing any item. Small posts
    // retain URL delivery; unknown video sizes need the bounded file uploader.
    if (target.kind === "post" && env.uploadInstagramPost && media.some(item =>
      item.kind === "video" && (item.size === null || item.size > TELEGRAM_VIDEO_URL_LIMIT))) {
      await env.uploadInstagramPost({ shortcode: target.shortcode, url: target.url,
        chatId: message.chat.id, requestMessageId: message.message_id,
        userId: message.from?.id || message.chat.id, statusMessageId, media });
      return Response.json({ ok: true });
    }

    for (let index = 0; index < media.length; index++) {
      const item = media[index];
      const proxyUrl = await createMediaProxyUrl(env.BOT_TOKEN, item.url);
      const caption = media.length > 1 ? `Instagram • ${index + 1}/${media.length}` : "Instagram";

      let usageSent: unknown;
      let usageCached = false;
      if (item.kind === "photo") {
        usageSent = await telegramCall(env.BOT_TOKEN, "sendPhoto", {
          chat_id: message.chat.id,
          photo: proxyUrl,
          caption,
          reply_parameters: index === 0 ? { message_id: message.message_id, allow_sending_without_reply: true } : undefined,
        });
      } else {
        const cacheKey = target.kind === "post" ? `ig:${message.from?.id || message.chat.id}:${target.shortcode}:${index}:video` : undefined;
        const cached = cacheKey ? await telegramFileCache(env, "get", cacheKey) : null;
        const payload = {
          chat_id: message.chat.id,
          video: cached?.method === "sendVideo" ? cached.fileId : proxyUrl,
          caption,
          width: item.width || undefined,
          height: item.height || undefined,
          supports_streaming: true,
          reply_markup: target.kind === "post" && message.from?.id ? { inline_keyboard: [[{
            text: "🎵 فقط صدا", callback_data: `iga|p|${target.shortcode}|${index}|${message.from.id}`,
          }, { text: "🔎 پیداکردن آهنگ", callback_data: `igm|p|${target.shortcode}|${index}|${message.from.id}` }]] } : undefined,
          reply_parameters: index === 0 ? { message_id: message.message_id, allow_sending_without_reply: true } : undefined,
        };
        usageCached = Boolean(cached?.method === "sendVideo");
        let sent: TelegramMessage;
        try { sent = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendVideo", payload); }
        catch (error) {
          if (!cached || !/wrong.*file|file.*(?:invalid|expired)|file_reference|failed to get.*file/i.test(String(error))) throw error;
          usageCached = false;
          await telegramFileCache(env, "delete", cacheKey!);
          sent = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendVideo", { ...payload, video: proxyUrl });
        }
        usageSent = sent;
        if (cacheKey && sent.video?.file_id) await telegramFileCache(env, "put", cacheKey, {
          method: "sendVideo", fileId: sent.video.file_id, data: { caption, supports_streaming: true },
        });
      }
      await recordMediaDelivery(env, message.from?.id || message.chat.id, message.chat.id, usageSent, usageCached);
      delivered++;
      if (env.ADMIN_STATS) await recordSuccessfulDelivery(env as AdminStatsEnv, `${history.key}:${index}`);
    }
    await recordDownload(env, { ...history, status: "success", delivered });

    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "deleteMessage", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
      });
    }
  } catch (error) {
    await recordDownload(env, { ...history, status: delivered ? "partial" : "failed", delivered, detail: "دریافت یا ارسال کامل محتوا تأیید نشد." });
    if (acknowledgeKickedChat(error)) return Response.json({ ok: true });
    const detail = error instanceof Error ? error.message : String(error);
    const throttle = error instanceof InstagramThrottleError ? error.throttle : undefined;
    if (/^INSTAGRAM_PUBLIC_COOLDOWN_\d+$/.test(detail)) {
      console.info("instagram public cooldown active", { target: target.kind, remainingSeconds: Number(detail.split("_").at(-1)) });
    } else {
      console.error("instagram download failed", { target: target.kind, detail, ...(throttle ? { throttle } : {}) });
    }
    const friendly = friendlyError(detail, throttle);
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
        text: friendly, _errorDetail: detail,
      });
    } else {
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: friendly, _errorDetail: detail,
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
    }
  }

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-instagram-downloader",
          mode: "cloudflare-only",
          resolver: "instagram-multistrategy-v11-cobalt-story-graphql",
          botConfigured: Boolean(env.BOT_TOKEN),
          webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET),
          instagramSessionConfigured: Boolean(env.INSTAGRAM_SESSIONID?.trim()),
          instagramMidConfigured: Boolean(env.INSTAGRAM_MID?.trim()),
          instagramIgDidConfigured: Boolean(env.INSTAGRAM_IG_DID?.trim()),
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Instagram Downloader is running on Cloudflare.");
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      try { return await handleTelegramWebhook(request, env); } catch (error) {
        if (acknowledgeKickedChat(error)) return Response.json({ ok: true });
        throw error;
      }
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/media") {
      return handleMediaProxy(request, env, url);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
