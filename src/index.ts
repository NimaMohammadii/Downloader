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
type CookieJar = Map<string, string>;

type FetchJsonResult = {
  data: any | null;
  status: number;
  redirectedTo: string | null;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const WEB_APP_ID = "936619743392459";
const IOS_APP_ID = "124024574287414";
const PRIVATE_APP_ID = "567067343352427";
const WEB_ASBD_ID = "129477";
const LEGACY_ASBD_ID = "359341";
const INSTALOADER_POST_DOC_ID = "27128499623469141";
const COBALT_POST_DOC_ID = "8845758582119845";
const COBALT_POST_FRIENDLY_NAME = "PolarisPostActionLoadPostQueryQuery";
const LEGACY_POST_DOC_ID = "27130156389949648";
const LEGACY_POST_FRIENDLY_NAME = "PolarisLoggedOutDesktopWWWPostRootContentQuery";
const STORY_GRAPHQL_DOC_ID = "25317500907894419";
const IG_WWW_CLAIM_STATE_KEY = "__ig_www_claim";
const PRIVATE_BLOKS_VERSION_ID = "7189b949425f9bf80ea8bd880cf5a3080b292d9b1c4b38a18d112f7c4b71e7a8";
const MEDIA_LINK_TTL_SECONDS = 10 * 60;
const TELEGRAM_VIDEO_URL_LIMIT = 19_000_000;
const TELEGRAM_PHOTO_URL_LIMIT = 4_800_000;
const IG_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const PRIVATE_SUPPORTED_CAPABILITIES = [
  {
    value: "119.0,120.0,121.0,122.0,123.0,124.0,125.0,126.0,127.0,128.0,129.0,130.0,131.0,132.0,133.0,134.0,135.0,136.0,137.0,138.0,139.0,140.0,141.0,142.0",
    name: "SUPPORTED_SDK_VERSIONS",
  },
  { value: "14", name: "FACE_TRACKER_VERSION" },
  { value: "ETC2_COMPRESSION", name: "COMPRESSION" },
  { value: "gyroscope_enabled", name: "gyroscope" },
];

const WEB_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const IOS_UA =
  "Instagram 361.0.0.35.82 (iPad13,8; iOS 18_0; en_US; en-US; scale=2.00; 2048x2732; 674117118) AppleWebKit/420+";
const PRIVATE_UA =
  "Instagram 428.0.0.47.67 Android (34/14; 480dpi; 1344x2992; Google/google; Pixel 8 Pro; husky; husky; en_US; 961145276)";

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

function cloneJar(jar: CookieJar): CookieJar {
  return new Map(jar);
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

  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof extended.getSetCookie === "function"
    ? extended.getSetCookie()
    : [headers.get("set-cookie") || ""];

  for (const value of values) {
    if (!value) continue;
    const first = /^\s*([A-Za-z0-9_]+)=([^;]*)/.exec(value);
    if (first?.[1]) jar.set(first[1], first[2] || "");
    for (const name of ["csrftoken", "mid", "ig_did", "datr", "dpr", "wd", "ig_nrcb", "rur"]) {
      const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`, "i").exec(value);
      if (match?.[1]) jar.set(name, match[1]);
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

function privateAuthParts(jar: CookieJar): { userId: string; sessionId: string } | null {
  const sessionId = jar.get("sessionid")?.trim() || "";
  let userId = jar.get("ds_user_id")?.trim() || "";
  if (!userId && sessionId) {
    try {
      userId = decodeURIComponent(sessionId).match(/^\d+/)?.[0] || sessionId.match(/^\d+/)?.[0] || "";
    } catch {
      userId = sessionId.match(/^\d+/)?.[0] || "";
    }
  }
  if (!sessionId || !/^\d+$/.test(userId)) return null;
  return { userId, sessionId };
}

function privateAuthorization(jar: CookieJar): string | null {
  const auth = privateAuthParts(jar);
  if (!auth) return null;
  const payload = JSON.stringify({
    ds_user_id: auth.userId,
    sessionid: auth.sessionId,
    should_use_header_over_cookies: true,
  });
  return `Bearer IGT:2:${btoa(payload)}`;
}

function stableHex(seed: string, length: number): string {
  let state = 0x811c9dc5;
  let output = "";
  for (let round = 0; output.length < length; round++) {
    state ^= round + 0x9e3779b9;
    for (let index = 0; index < seed.length; index++) {
      state ^= seed.charCodeAt(index) + index;
      state = Math.imul(state, 0x01000193);
      state ^= state >>> 13;
    }
    output += (state >>> 0).toString(16).padStart(8, "0");
  }
  return output.slice(0, length);
}

function stableUuid(seed: string): string {
  const chars = stableHex(seed, 32).split("");
  chars[12] = "4";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function privateMobileHeaders(jar: CookieJar): Headers {
  const auth = privateAuthParts(jar);
  const userId = auth?.userId || "0";
  const deviceUuid = stableUuid(`ig-device:${userId}`);
  const familyUuid = stableUuid(`ig-family:${userId}`);
  const androidId = `android-${stableHex(`ig-android:${userId}`, 16)}`;
  const bandwidth = (2500 + Math.random() * 500).toFixed(3);
  const totalBytes = String(Math.floor(5_000_000 + Math.random() * 85_000_000));
  const totalTime = String(Math.floor(2_000 + Math.random() * 7_000));

  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US",
    "user-agent": PRIVATE_UA,
    "x-ig-app-locale": "en_US",
    "x-ig-device-locale": "en_US",
    "x-ig-mapped-locale": "en_US",
    "x-pigeon-session-id": `UFS-${crypto.randomUUID()}-1`,
    "x-pigeon-rawclienttime": (Date.now() / 1000).toFixed(3),
    "x-ig-bandwidth-speed-kbps": bandwidth,
    "x-ig-bandwidth-totalbytes-b": totalBytes,
    "x-ig-bandwidth-totaltime-ms": totalTime,
    "x-ig-app-startup-country": "US",
    "x-bloks-version-id": PRIVATE_BLOKS_VERSION_ID,
    "x-bloks-is-layout-rtl": "false",
    "x-bloks-is-panorama-enabled": "true",
    "x-ig-www-claim": jar.get(IG_WWW_CLAIM_STATE_KEY) || "0",
    "x-ig-device-id": deviceUuid,
    "x-ig-family-device-id": familyUuid,
    "x-ig-android-id": androidId,
    "x-ig-timezone-offset": "0",
    "x-ig-connection-type": "WIFI",
    "x-ig-capabilities": "3brTv10=",
    "x-ig-app-id": PRIVATE_APP_ID,
    priority: "u=3",
    "x-fb-http-engine": "Tigon/MNS/TCP",
    "x-tigon-is-retry": "False",
    "x-zero-balance": "INIT",
    "x-zero-state": "unknown",
    "zero-http-network-interface": "wifi",
    "x-fb-client-ip": "True",
    "x-fb-server-cluster": "True",
    "ig-intended-user-id": userId,
    "ig-u-ds-user-id": userId,
  });

  const authorization = privateAuthorization(jar);
  if (authorization) headers.set("authorization", authorization);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  const mid = jar.get("mid");
  if (mid) headers.set("x-mid", mid);
  const rur = jar.get("rur");
  if (rur) headers.set("ig-u-rur", rur);
  return headers;
}

function mediaHeaders(range?: string | null): Headers {
  const headers = new Headers({ accept: "*/*", referer: "https://www.instagram.com/" });
  if (range) headers.set("range", range);
  return headers;
}

function redirectLocation(response: Response, requestUrl: string): URL | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, requestUrl);
  } catch {
    return null;
  }
}

function isAuthRedirect(location: URL | null): boolean {
  if (!location) return false;
  return (
    location.pathname.startsWith("/accounts/login") ||
    location.pathname.startsWith("/challenge") ||
    location.pathname === "/"
  );
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

function firstCandidateGroups(value: unknown, depth = 0): MediaCandidate[][] {
  if (depth > 18 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const groups = firstCandidateGroups(item, depth + 1);
      if (groups.length) return groups;
    }
    return [];
  }

  const object = value as Record<string, any>;
  for (const key of ["xdt_shortcode_media", "shortcode_media", "xig_polaris_media", "if_not_gated_logged_out"]) {
    if (object[key] && typeof object[key] === "object") {
      const groups = candidatesFromProduct(object[key]);
      if (groups.length) return groups;
    }
  }

  if (
    object.video_versions ||
    object.image_versions2 ||
    object.video_url ||
    object.carousel_media ||
    object.edge_sidecar_to_children
  ) {
    const groups = candidatesFromProduct(object);
    if (groups.length) return groups;
  }

  for (const child of Object.values(object)) {
    const groups = firstCandidateGroups(child, depth + 1);
    if (groups.length) return groups;
  }
  return [];
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
    /["']video_url["']\s*:\s*["']([^"']+)["']/gi,
    /["']contentUrl["']\s*:\s*["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["'][^>]*>/gi,
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

function extractLsdToken(html: string): string | null {
  const eqmc = /<script\b[^>]*\bid=["']__eqmc["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (eqmc?.[1]) {
    try {
      const parsed = JSON.parse(eqmc[1]);
      if (typeof parsed?.l === "string" && parsed.l) return parsed.l;
    } catch {
      // Continue.
    }
  }
  return /\["LSD",\[\],\{"token":"([^"]+)"/i.exec(html)?.[1] || null;
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

async function fetchJson(
  url: string,
  headers: Headers,
  jar: CookieJar,
  init: { method?: string; body?: string } = {},
): Promise<FetchJsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method || "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
  } catch (error) {
    console.warn("instagram fetch failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { data: null, status: 0, redirectedTo: null };
  }

  absorbSetCookies(response.headers, jar);
  const location = redirectLocation(response, url);
  if (location) {
    console.warn("instagram request redirected", {
      path: new URL(url).pathname,
      status: response.status,
      to: location.pathname,
      authenticated: jar.has("sessionid"),
    });
    await response.body?.cancel().catch(() => undefined);
    return { data: null, status: response.status, redirectedTo: location.pathname };
  }

  throwForInstagramStatus(response.status);
  if (!response.ok) {
    console.warn("instagram request failed", { path: new URL(url).pathname, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    return { data: null, status: response.status, redirectedTo: null };
  }

  try {
    return { data: await response.json(), status: response.status, redirectedTo: null };
  } catch {
    return { data: null, status: response.status, redirectedTo: null };
  }
}

async function fetchHtml(
  url: string,
  headers: Headers,
  jar: CookieJar,
): Promise<{ html: string | null; status: number; redirectedTo: string | null }> {
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "manual" });
  } catch (error) {
    console.warn("instagram html fetch failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { html: null, status: 0, redirectedTo: null };
  }

  absorbSetCookies(response.headers, jar);
  const location = redirectLocation(response, url);
  if (location) {
    console.warn("instagram html redirected", {
      path: new URL(url).pathname,
      status: response.status,
      to: location.pathname,
      authenticated: jar.has("sessionid"),
    });
    await response.body?.cancel().catch(() => undefined);
    return { html: null, status: response.status, redirectedTo: location.pathname };
  }

  throwForInstagramStatus(response.status);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { html: null, status: response.status, redirectedTo: null };
  }
  return { html: await response.text(), status: response.status, redirectedTo: null };
}

async function ensureWebCsrf(jar: CookieJar): Promise<{ html: string | null; ok: boolean }> {
  if (jar.get("csrftoken")) return { html: null, ok: true };
  const home = await fetchHtml("https://www.instagram.com/", browserHeaders(jar), jar);
  if (home.redirectedTo && isAuthRedirect(new URL(home.redirectedTo, "https://www.instagram.com"))) {
    return { html: home.html, ok: false };
  }
  if (home.html && !jar.get("csrftoken")) {
    const csrf = extractCsrfFromHtml(home.html);
    if (csrf) jar.set("csrftoken", csrf);
  }
  return { html: home.html, ok: Boolean(home.status === 200) };
}

async function resolveViaOembedMobile(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const oembedUrl = new URL("https://i.instagram.com/api/v1/oembed/");
  oembedUrl.searchParams.set("url", `https://www.instagram.com/p/${target.shortcode}/`);

  const oembed = await fetchJson(oembedUrl.toString(), mobileHeaders(jar), jar);
  let mediaId = String(oembed.data?.media_id || "").match(/^\d+/)?.[0] || "";
  if (!mediaId) mediaId = shortcodeToMediaId(target.shortcode);

  const media = await fetchJson(
    `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
    mobileHeaders(jar),
    jar,
  );
  const product = media.data?.items?.[0];
  if (!product) return null;

  const groups = candidatesFromProduct(product);
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "mobile-api", authenticated: jar.has("sessionid") });
    return groups;
  }
  return null;
}

async function resolveViaInstaloaderGraphql(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const session = await ensureWebCsrf(jar);
  if (!session.ok) return null;

  const headers = webHeaders(jar, target.url);
  headers.set("content-type", "application/x-www-form-urlencoded");
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);

  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode: target.shortcode,
      __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
    }),
    doc_id: INSTALOADER_POST_DOC_ID,
    server_timestamps: "true",
  }).toString();

  const response = await fetchJson(
    "https://www.instagram.com/graphql/query",
    headers,
    jar,
    { method: "POST", body },
  );
  const product = response.data?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0];
  if (!product) return null;

  const groups = candidatesFromProduct(product);
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "graphql-web-info", authenticated: jar.has("sessionid") });
    return groups;
  }
  return null;
}

async function resolveViaCobaltGraphql(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const page = await fetchHtml(
    `https://www.instagram.com/p/${target.shortcode}/`,
    browserHeaders(jar),
    jar,
  );
  if (!page.html || page.redirectedTo) return null;

  const lsd = extractLsdToken(page.html);
  if (!lsd) return null;
  if (!jar.get("csrftoken")) {
    const csrf = extractCsrfFromHtml(page.html);
    if (csrf) jar.set("csrftoken", csrf);
  }

  const headers = webHeaders(jar, target.url);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("x-fb-friendly-name", COBALT_POST_FRIENDLY_NAME);
  headers.set("x-fb-lsd", lsd);
  headers.set("x-requested-with", "XMLHttpRequest");
  headers.set("x-asbd-id", WEB_ASBD_ID);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);

  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: COBALT_POST_FRIENDLY_NAME,
    variables: JSON.stringify({
      shortcode: target.shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    server_timestamps: "true",
    doc_id: COBALT_POST_DOC_ID,
  }).toString();

  const response = await fetchJson(
    "https://www.instagram.com/graphql/query",
    headers,
    jar,
    { method: "POST", body },
  );
  const groups = firstCandidateGroups(response.data?.data);
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "graphql-post-action", authenticated: jar.has("sessionid") });
    return groups;
  }
  return null;
}

function parseEmbedContext(html: string): any | null {
  const match = /"init",\[\],\[(.*?)\]\],/s.exec(html);
  if (!match?.[1]) return null;
  try {
    const init = JSON.parse(match[1]);
    if (!init?.contextJSON || typeof init.contextJSON !== "string") return null;
    return JSON.parse(init.contextJSON);
  } catch {
    return null;
  }
}

async function resolveViaEmbed(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const url = `https://www.instagram.com/p/${target.shortcode}/embed/captioned/`;
  const page = await fetchHtml(url, browserHeaders(jar), jar);
  if (!page.html || page.redirectedTo) return null;

  const context = parseEmbedContext(page.html);
  const fromContext = firstCandidateGroups(context);
  if (fromContext.length) {
    console.log("instagram resolver success", { resolver: "embed-context", authenticated: jar.has("sessionid") });
    return fromContext;
  }

  const fromMeta = candidatesFromHtmlMeta(page.html);
  if (fromMeta.length) {
    console.log("instagram resolver success", { resolver: "embed-meta", authenticated: jar.has("sessionid") });
    return fromMeta;
  }
  return null;
}

async function resolveViaLegacyGraphql(
  target: Extract<InstagramTarget, { kind: "post" }>,
  mediaId: string,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const session = await ensureWebCsrf(jar);
  if (!session.ok) return null;

  let lsd = session.html ? extractLsdToken(session.html) : null;
  if (!lsd) {
    const page = await fetchHtml(target.url, browserHeaders(jar), jar);
    if (page.redirectedTo || !page.html) return null;
    const direct = candidatesFromHtmlMeta(page.html);
    if (direct.length) return direct;
    const nested = firstCandidateGroups(safeJsonScripts(page.html));
    if (nested.length) return nested;
    lsd = extractLsdToken(page.html);
  }
  if (!lsd) return null;

  const headers = webHeaders(jar, target.url);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("x-fb-friendly-name", LEGACY_POST_FRIENDLY_NAME);
  headers.set("x-fb-lsd", lsd);
  headers.set("x-requested-with", "XMLHttpRequest");
  headers.set("x-asbd-id", LEGACY_ASBD_ID);

  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: LEGACY_POST_FRIENDLY_NAME,
    server_timestamps: "true",
    variables: JSON.stringify({ media_id: mediaId }),
    doc_id: LEGACY_POST_DOC_ID,
  }).toString();

  const response = await fetchJson(
    "https://www.instagram.com/api/graphql",
    headers,
    jar,
    { method: "POST", body },
  );
  const media = response.data?.data?.xig_polaris_media;
  const product = media?.if_not_gated_logged_out || media;
  const groups = product ? candidatesFromProduct(product) : [];
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "legacy-graphql", authenticated: jar.has("sessionid") });
    return groups;
  }
  return null;
}

function safeJsonScripts(html: string): unknown[] {
  const values: unknown[] = [];
  const pattern = /<script\b[^>]*\bdata-sjs(?:=["'][^"']*["'])?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1] || "";
    if (!raw.includes("video") && !raw.includes("xig_polaris_media")) continue;
    try {
      values.push(JSON.parse(raw));
    } catch {
      // Ignore malformed script.
    }
  }
  return values;
}

async function resolveAuthenticatedMediaInfo(
  target: Extract<InstagramTarget, { kind: "post" }>,
  mediaId: string,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const headers = webHeaders(jar, target.url);
  headers.set("origin", "https://www.instagram.com");
  headers.set("x-asbd-id", LEGACY_ASBD_ID);
  headers.set("x-ig-www-claim", jar.get(IG_WWW_CLAIM_STATE_KEY) || "0");

  const response = await fetchJson(
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
    headers,
    jar,
  );
  if (response.redirectedTo && isAuthRedirect(new URL(response.redirectedTo, "https://www.instagram.com"))) {
    return null;
  }
  const product = response.data?.items?.[0];
  if (!product) return null;
  const groups = candidatesFromProduct(product);
  if (groups.length) {
    console.log("instagram resolver success", { resolver: "authenticated-media-info" });
    return groups;
  }
  return null;
}

async function tryPublicResolvers(
  target: Extract<InstagramTarget, { kind: "post" }>,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const mediaId = shortcodeToMediaId(target.shortcode);
  const resolvers: Array<[string, () => Promise<MediaCandidate[][] | null>]> = [
    ["mobile-api", () => resolveViaOembedMobile(target, cloneJar(jar))],
    ["graphql-web-info", () => resolveViaInstaloaderGraphql(target, cloneJar(jar))],
    ["graphql-post-action", () => resolveViaCobaltGraphql(target, cloneJar(jar))],
    ["embed", () => resolveViaEmbed(target, cloneJar(jar))],
    ["legacy-graphql", () => resolveViaLegacyGraphql(target, mediaId, cloneJar(jar))],
  ];

  for (const [name, run] of resolvers) {
    try {
      const result = await run();
      if (result?.length) return result;
      console.warn("instagram resolver empty", { resolver: name, authenticated: jar.has("sessionid") });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn("instagram resolver failed", { resolver: name, authenticated: jar.has("sessionid"), detail });
      if (detail === "INSTAGRAM_RATE_LIMIT_429") throw error;
    }
  }
  return null;
}

async function resolvePost(
  target: Extract<InstagramTarget, { kind: "post" }>,
  env: Env,
): Promise<MediaCandidate[][]> {
  const anonymous = await tryPublicResolvers(target, new Map());
  if (anonymous?.length) return anonymous;

  if (env.INSTAGRAM_SESSIONID?.trim()) {
    const sessionJar = secretCookies(env);

    const withSession = await tryPublicResolvers(target, sessionJar);
    if (withSession?.length) return withSession;

    const mediaId = shortcodeToMediaId(target.shortcode);
    const authenticatedInfo = await resolveAuthenticatedMediaInfo(target, mediaId, cloneJar(sessionJar));
    if (authenticatedInfo?.length) return authenticatedInfo;
  }

  throw new Error("INSTAGRAM_ALL_RESOLVERS_FAILED");
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

async function chooseCandidate(group: MediaCandidate[]): Promise<ResolvedMedia> {
  const sorted = [...group].sort((a, b) => b.width * b.height - a.width * a.height);
  const limit = sorted[0]?.kind === "photo" ? TELEGRAM_PHOTO_URL_LIMIT : TELEGRAM_VIDEO_URL_LIMIT;
  let unknown: MediaCandidate | null = null;

  for (const candidate of sorted) {
    const size = await probeSize(candidate.url);
    if (size !== null && size <= limit) return { ...candidate, size };
    if (size === null) unknown = candidate;
  }
  if (unknown) return { ...unknown, size: null };
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
  const groups = target.kind === "post" ? await resolvePost(target, env) : await resolveStory(target, env);
  const resolved: ResolvedMedia[] = [];
  for (const group of groups) resolved.push(await chooseCandidate(group));
  return resolved;
}

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("all_resolvers_failed")) {
    return "❌ Instagram از همه‌ی مسیرهای دانلود جواب قابل استفاده نداد. لاگ resolverها رو بفرست.";
  }
  if (value.includes("session_rejected")) {
    return "❌ Session اینستاگرام برای این محتوا معتبر شناخته نشد.";
  }
  if (value.includes("rate_limit_429")) {
    return "❌ Instagram فعلاً درخواست‌های این سرور رو محدود کرده (429).";
  }
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
  if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
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
      reply_parameters: { message_id: message.message_id },
    });
    return Response.json({ ok: true });
  }

  let statusMessageId: number | undefined;
  try {
    const status = await telegramCall<TelegramMessage>(env.BOT_TOKEN, "sendMessage", {
      chat_id: message.chat.id,
      text: "⏳ لینک اینستاگرام رو گرفتم، دارم فایل رو آماده می‌کنم…",
      reply_parameters: { message_id: message.message_id },
    });
    statusMessageId = status.message_id;

    const media = await resolveTarget(target, env);
    if (!media.length) throw new Error("INSTAGRAM_NO_MEDIA");

    for (let index = 0; index < media.length; index++) {
      const item = media[index];
      const proxyUrl = await createMediaProxyUrl(env.BOT_TOKEN, item.url);
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
    console.error("instagram download failed", { target: target.kind, detail });
    const friendly = friendlyError(detail);
    if (statusMessageId) {
      await safeTelegramCall(env.BOT_TOKEN, "editMessageText", {
        chat_id: message.chat.id,
        message_id: statusMessageId,
        text: friendly,
      });
    } else {
      await safeTelegramCall(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id,
        text: friendly,
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
      return new Response(
        JSON.stringify({
          ok: true,
          service: "telegram-instagram-downloader",
          mode: "cloudflare-only",
          resolver: "instagram-multistrategy-v11-cobalt-story-graphql",
          botConfigured: Boolean(env.BOT_TOKEN),
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
      return handleTelegramWebhook(request, env);
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/media") {
      return handleMediaProxy(request, env, url);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
