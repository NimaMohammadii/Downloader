type Env = {
  BOT_TOKEN: string;
  INSTAGRAM_SESSIONID?: string;
  INSTAGRAM_CSRFTOKEN?: string;
  INSTAGRAM_DS_USER_ID?: string;
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

type ResolvedMedia = MediaCandidate & {
  size: number | null;
};

type CookieJar = Map<string, string>;

type IgJsonResult = {
  data: any | null;
  status: number;
  authRedirect: boolean;
};

const WEBHOOK_SECRET = "dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1";
const BASE_URL = "https://downloader.vexaagent.workers.dev";
const IG_APP_ID = "936619743392459";
const IG_ASBD_ID = "359341";
const IG_GRAPHQL_DOC_ID = "27130156389949648";
const IG_GRAPHQL_FRIENDLY_NAME = "PolarisLoggedOutDesktopWWWPostRootContentQuery";
const MEDIA_LINK_TTL_SECONDS = 10 * 60;
const TELEGRAM_VIDEO_URL_LIMIT = 19_000_000;
const TELEGRAM_PHOTO_URL_LIMIT = 4_800_000;
const IG_SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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
  const data = await response.json<TelegramApiResponse<T>>();
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram ${method} failed`);
  }
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
      // Try the next URL.
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
        // The session cookie can stay percent-encoded.
      }
    }
  }
  if (env.INSTAGRAM_CSRFTOKEN?.trim()) jar.set("csrftoken", env.INSTAGRAM_CSRFTOKEN.trim());
  if (env.INSTAGRAM_DS_USER_ID?.trim()) jar.set("ds_user_id", env.INSTAGRAM_DS_USER_ID.trim());
  return jar;
}

function cookieHeader(jar: CookieJar): string | null {
  if (!jar.size) return null;
  return Array.from(jar.entries(), ([name, value]) => `${name}=${value}`).join("; ");
}

function absorbSetCookies(headers: Headers, jar: CookieJar): void {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof extended.getSetCookie === "function"
    ? extended.getSetCookie()
    : [headers.get("set-cookie") || ""];

  for (const value of values) {
    if (!value) continue;
    const first = /^\s*([A-Za-z0-9_]+)=([^;]*)/.exec(value);
    if (first?.[1]) jar.set(first[1], first[2] || "");
    for (const name of ["csrftoken", "mid", "ig_did", "datr", "dpr", "wd"]) {
      const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,\\s]+)`, "i").exec(value);
      if (match?.[1]) jar.set(name, match[1]);
    }
  }
}

function browserHeaders(jar: CookieJar, referer = "https://www.instagram.com/"): Headers {
  const headers = new Headers({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    "user-agent": BROWSER_UA,
    "upgrade-insecure-requests": "1",
  });
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function apiHeaders(jar: CookieJar, referer: string): Headers {
  const headers = new Headers({
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.instagram.com",
    referer,
    "user-agent": BROWSER_UA,
    "x-asbd-id": IG_ASBD_ID,
    "x-ig-app-id": IG_APP_ID,
    "x-ig-www-claim": "0",
  });
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("csrftoken");
  if (csrf) headers.set("x-csrftoken", csrf);
  return headers;
}

function mediaHeaders(range?: string | null): Headers {
  const headers = new Headers({
    accept: "*/*",
    referer: "https://www.instagram.com/",
    "user-agent": BROWSER_UA,
  });
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
  return location.pathname.startsWith("/accounts/login") || location.pathname.startsWith("/challenge");
}

async function instagramJsonWithJar(
  url: string,
  jar: CookieJar,
  referer = "https://www.instagram.com/",
): Promise<IgJsonResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiHeaders(jar, referer),
      redirect: "manual",
    });
  } catch (error) {
    console.warn("instagram api fetch failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { data: null, status: 0, authRedirect: false };
  }

  absorbSetCookies(response.headers, jar);
  const location = redirectLocation(response, url);
  if (location) {
    const authRedirect = isAuthRedirect(location) || location.pathname === "/";
    console.warn("instagram api redirected", {
      path: new URL(url).pathname,
      status: response.status,
      to: location.pathname,
      authRedirect,
    });
    await response.body?.cancel().catch(() => undefined);
    return { data: null, status: response.status, authRedirect };
  }

  if (!response.ok) {
    console.warn("instagram api failed", { path: new URL(url).pathname, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    return { data: null, status: response.status, authRedirect: false };
  }

  try {
    return { data: await response.json(), status: response.status, authRedirect: false };
  } catch {
    return { data: null, status: response.status, authRedirect: false };
  }
}

async function instagramPage(
  url: string,
  jar: CookieJar,
  referer = "https://www.instagram.com/",
): Promise<{ html: string | null; status: number; authRedirect: boolean }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: browserHeaders(jar, referer),
      redirect: "manual",
    });
  } catch (error) {
    console.warn("instagram page fetch failed", {
      path: new URL(url).pathname,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { html: null, status: 0, authRedirect: false };
  }

  absorbSetCookies(response.headers, jar);
  const location = redirectLocation(response, url);
  if (location) {
    const authRedirect = isAuthRedirect(location);
    console.warn("instagram page redirected", {
      path: new URL(url).pathname,
      status: response.status,
      to: location.pathname,
      authRedirect,
    });
    await response.body?.cancel().catch(() => undefined);
    return { html: null, status: response.status, authRedirect };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { html: null, status: response.status, authRedirect: false };
  }
  return { html: await response.text(), status: response.status, authRedirect: false };
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function candidatesFromProduct(product: any): MediaCandidate[][] {
  const nodes = Array.isArray(product?.carousel_media) ? product.carousel_media : [product];
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

    const images = Array.isArray(node?.image_versions2?.candidates)
      ? node.image_versions2.candidates
      : [];
    const imageCandidates = images
      .filter((item: any) => typeof item?.url === "string" && item.url.startsWith("https://"))
      .map((item: any) => ({
        kind: "photo" as const,
        url: item.url,
        width: numberOrZero(item.width),
        height: numberOrZero(item.height),
      }));
    if (imageCandidates.length) groups.push(imageCandidates);
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

function candidatesFromHtml(html: string): MediaCandidate[][] {
  const found: MediaCandidate[] = [];
  const patterns = [
    /["']video_url["']\s*:\s*["']([^"']+)["']/gi,
    /["']contentUrl["']\s*:\s*["']([^"']+)["']/gi,
    /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::url)?["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
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
      // Continue with the normal LSD pattern.
    }
  }
  const match = /\["LSD",\[\],\{"token":"([^"]+)"/i.exec(html);
  return match?.[1] || null;
}

function throwForInstagramStatus(status: number): void {
  if (status === 429) throw new Error("INSTAGRAM_RATE_LIMIT_429");
  if (status === 403) throw new Error("INSTAGRAM_ACCESS_403");
}

async function resolvePostViaWeb(
  target: Extract<InstagramTarget, { kind: "post" }>,
  mediaId: string,
  jar: CookieJar,
): Promise<MediaCandidate[][] | null> {
  const home = await instagramPage("https://www.instagram.com/", jar);
  throwForInstagramStatus(home.status);
  if (home.authRedirect) return null;

  let lsd = home.html ? extractLsdToken(home.html) : null;

  const page = await instagramPage(target.url, jar, "https://www.instagram.com/");
  throwForInstagramStatus(page.status);
  if (page.authRedirect) return null;
  if (page.html) {
    const direct = candidatesFromHtml(page.html);
    if (direct.length) return direct;
    lsd ||= extractLsdToken(page.html);
  }

  if (!lsd) return null;

  const rulingUrl = new URL("https://www.instagram.com/api/v1/web/get_ruling_for_content/");
  rulingUrl.searchParams.set("content_type", "MEDIA");
  rulingUrl.searchParams.set("target_id", mediaId);
  const ruling = await instagramJsonWithJar(rulingUrl.toString(), jar, target.url);
  throwForInstagramStatus(ruling.status);

  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: IG_GRAPHQL_FRIENDLY_NAME,
    server_timestamps: "true",
    variables: JSON.stringify({ media_id: mediaId }),
    doc_id: IG_GRAPHQL_DOC_ID,
  });
  const headers = apiHeaders(jar, target.url);
  headers.set("content-type", "application/x-www-form-urlencoded");
  headers.set("x-fb-friendly-name", IG_GRAPHQL_FRIENDLY_NAME);
  headers.set("x-fb-lsd", lsd);
  headers.set("x-requested-with", "XMLHttpRequest");

  let response: Response;
  try {
    response = await fetch("https://www.instagram.com/api/graphql", {
      method: "POST",
      headers,
      body: body.toString(),
      redirect: "manual",
    });
  } catch {
    return null;
  }
  absorbSetCookies(response.headers, jar);
  const location = redirectLocation(response, "https://www.instagram.com/api/graphql");
  if (location) {
    console.warn("instagram graphql redirected", {
      status: response.status,
      to: location.pathname,
    });
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  throwForInstagramStatus(response.status);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  try {
    const data = await response.json<any>();
    const media = data?.data?.xig_polaris_media;
    const product = media?.if_not_gated_logged_out || media;
    if (!product) return null;
    const groups = candidatesFromProduct(product);
    return groups.length ? groups : null;
  } catch {
    return null;
  }
}

async function resolvePost(
  target: Extract<InstagramTarget, { kind: "post" }>,
  env: Env,
): Promise<MediaCandidate[][]> {
  const mediaId = shortcodeToMediaId(target.shortcode);
  const hasSession = Boolean(env.INSTAGRAM_SESSIONID?.trim());

  if (hasSession) {
    const jar = secretCookies(env);

    // First open Instagram with the same jar so csrf/mid/etc. are retained for the API call.
    const bootstrap = await instagramPage("https://www.instagram.com/", jar);
    throwForInstagramStatus(bootstrap.status);

    const api = await instagramJsonWithJar(
      `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
      jar,
      target.url,
    );
    throwForInstagramStatus(api.status);

    const product = api.data?.items?.[0];
    if (product) {
      const groups = candidatesFromProduct(product);
      if (groups.length) return groups;
    }

    // Some Instagram sessions are redirected on the media-info endpoint while the web flow still works.
    const webGroups = await resolvePostViaWeb(target, mediaId, jar);
    if (webGroups?.length) return webGroups;

    // Last fallback: check if the post itself is still accessible anonymously.
    const anonymousGroups = await resolvePostViaWeb(target, mediaId, new Map());
    if (anonymousGroups?.length) return anonymousGroups;

    if (api.authRedirect || bootstrap.authRedirect) {
      throw new Error("INSTAGRAM_SESSION_REJECTED");
    }
    throw new Error("INSTAGRAM_SESSION_NO_MEDIA");
  }

  const groups = await resolvePostViaWeb(target, mediaId, new Map());
  if (groups?.length) return groups;
  throw new Error("INSTAGRAM_ANONYMOUS_EMPTY_MEDIA");
}

async function resolveStory(
  target: Extract<InstagramTarget, { kind: "story" | "highlight" }>,
  env: Env,
): Promise<MediaCandidate[][]> {
  if (!env.INSTAGRAM_SESSIONID?.trim()) {
    throw new Error("INSTAGRAM_STORY_SESSION_REQUIRED");
  }

  const jar = secretCookies(env);
  const bootstrap = await instagramPage("https://www.instagram.com/", jar);
  throwForInstagramStatus(bootstrap.status);
  if (bootstrap.authRedirect) throw new Error("INSTAGRAM_SESSION_REJECTED");

  let reelKey: string;
  let exactStoryId: string | null = null;

  if (target.kind === "highlight") {
    reelKey = `highlight:${target.highlightId}`;
  } else {
    exactStoryId = target.storyId;
    const profile = await instagramJsonWithJar(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(target.username)}`,
      jar,
      target.url,
    );
    throwForInstagramStatus(profile.status);
    if (profile.authRedirect) throw new Error("INSTAGRAM_SESSION_REJECTED");
    const userId = String(profile.data?.data?.user?.id || profile.data?.user?.pk || "");
    if (!/^\d+$/.test(userId)) throw new Error("INSTAGRAM_STORY_USER_NOT_FOUND");
    reelKey = userId;
  }

  const response = await instagramJsonWithJar(
    `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelKey)}`,
    jar,
    target.url,
  );
  throwForInstagramStatus(response.status);
  if (response.authRedirect) throw new Error("INSTAGRAM_SESSION_REJECTED");

  const reel = response.data?.reels?.[reelKey];
  const items = Array.isArray(reel?.items) ? reel.items : [];
  if (!items.length) throw new Error("INSTAGRAM_STORY_LOGIN_REQUIRED");

  const selectedItems = exactStoryId
    ? items.filter((item: any) => String(item?.pk || item?.id || "").split("_")[0] === exactStoryId)
    : items;
  if (!selectedItems.length) throw new Error("INSTAGRAM_STORY_EXPIRED");

  const groups: MediaCandidate[][] = [];
  for (const item of selectedItems) groups.push(...candidatesFromProduct(item));
  if (!groups.length) throw new Error("INSTAGRAM_NO_MEDIA");
  return groups;
}

async function probeSize(url: string): Promise<number | null> {
  try {
    const head = await fetch(url, {
      method: "HEAD",
      headers: mediaHeaders(),
      redirect: "follow",
    });
    if (head.ok) {
      const size = Number(head.headers.get("content-length"));
      if (Number.isSafeInteger(size) && size > 0) return size;
    }
    await head.body?.cancel().catch(() => undefined);
  } catch {
    // Some Instagram CDN hosts reject HEAD.
  }

  try {
    const response = await fetch(url, {
      headers: mediaHeaders("bytes=0-0"),
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
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
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
  const groups = target.kind === "post"
    ? await resolvePost(target, env)
    : await resolveStory(target, env);
  const resolved: ResolvedMedia[] = [];
  for (const group of groups.slice(0, 10)) resolved.push(await chooseCandidate(group));
  return resolved;
}

function friendlyError(detail: string): string {
  const value = detail.toLowerCase();
  if (value.includes("session_rejected")) {
    return "❌ Instagram این Session رو قبول نکرد. sessionid رو دوباره از اکانتی که داخل Safari لاگین هست بگیر و Secret رو جایگزین کن.";
  }
  if (value.includes("session_no_media")) {
    return "❌ Session وصل شده، ولی Instagram برای این Reel فایل ویدیو برنگردوند.";
  }
  if (value.includes("rate_limit_429")) {
    return "❌ Instagram فعلاً این IP رو محدود کرده (429). چند دقیقه بعد دوباره امتحان کن.";
  }
  if (value.includes("access_403")) {
    return "❌ Instagram درخواست سرور رو رد کرد (403).";
  }
  if (value.includes("story_session_required")) {
    return "❌ برای دانلود Story باید Session اینستاگرام به Cloudflare وصل باشه.";
  }
  if (value.includes("story_login_required") || value.includes("login_required")) {
    return "❌ Instagram برای این محتوا لاگین می‌خواد یا Session فعلی معتبر نیست.";
  }
  if (value.includes("anonymous_empty_media")) {
    return "❌ Instagram این Reel رو برای سرور بدون Session محدود کرده.";
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
  if (value.includes("no_media")) {
    return "❌ توی این لینک فایل قابل دانلود پیدا نکردم.";
  }
  return `❌ دانلود Instagram شکست خورد: ${detail.slice(0, 140)}`;
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json<TelegramUpdate>();
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
          resolver: "instagram-session-v2",
          botConfigured: Boolean(env.BOT_TOKEN),
          instagramSessionConfigured: Boolean(env.INSTAGRAM_SESSIONID?.trim()),
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
