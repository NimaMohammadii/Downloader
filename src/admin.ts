import { BroadcastManager } from "./broadcast";
import { DurableObject } from "cloudflare:workers";

// Error visibility is enforced before both drafts and final Telegram messages.
export const PUBLIC_ERROR_MESSAGE = "مثل اینکه خطایی پیش اومده، در حال بررسی و پیگیری است، به زودی رفع می‌شود.";
export function isErrorNotice(text: string): boolean {
  return text !== PUBLIC_ERROR_MESSAGE && /(?:^|\n)\s*(?:❌|⚠)|ناموفق|ممکن نیست|نامعتبر|دکمه برای|تأیید نشد|ارسال نشد|کامل نشد|معتبر نیست|معتبر نیستند|منقضی|برای شما نیست|درخواست‌کننده|محدود کرده|موقتاً.*(?:متوقف|محدود)|قابل دسترسی.*ندارد|قبلاً.*(?:شروع|تمام)|آمادهٔ ارسال نیست|صف متوقف شد/.test(text);
}
export function privateErrorPayload(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  delete result._errorUserId;
  delete result._errorDetail;
  if (!/^(sendMessage|sendMessageDraft|editMessageText|answerCallbackQuery)$/.test(method) ||
      typeof payload.text !== "string" || !isErrorNotice(payload.text) && !payload._errorDetail) return result;
  // A group is never an admin-only destination, even when the requester is admin.
  const admin = method === "answerCallbackQuery" ? Number(payload._errorUserId) === ADMIN_USER_ID
    : Number(payload.chat_id) === ADMIN_USER_ID;
  if (admin) {
    if (payload._errorDetail && method !== "answerCallbackQuery") result.text = `${payload.text}\n${payload._errorDetail}`;
    return result;
  }
  result.text = PUBLIC_ERROR_MESSAGE;
  for (const key of ["entities", "parse_mode", "reply_markup", "link_preview_options"]) delete result[key];
  return result;
}
function prepareErrorNotice(method: string, payload: Record<string, unknown>): void {
  const actor = payload._errorUserId;
  const safe = privateErrorPayload(method, payload);
  for (const key of Object.keys(payload)) delete payload[key];
  Object.assign(payload, safe);
  if (method === "answerCallbackQuery" && actor !== undefined) payload._errorUserId = actor;
}

const telegramEmojiIds: Record<string, string> = {
  "❌": "5210952531676504517", "✅": "5352871660024246779", "⚠": "5447644880824181073",
  "🔎": "5231012545799666522", "⬇": "5271604874419647061", "📤": "5445355530111437729",
  "⏳": "5386367538735104399", "🎵": "5463107823946717464", "🎧": "5424818078833715060",
  "🎼": "5253997827788385948", "🎬": "5427168083074628963", "⭐": "5438496463044752972",
  "🔴": "5264919878082509254", "⏹": "5260293700088511294", "👤": "5397866377367268054",
  "⚡": "5210956306952758910", "👇": "5231102735817918643",
};
const telegramEmojiPattern = /(?:❌|✅|⚠|🔎|⬇|📤|⏳|🎵|🎧|🎼|🎬|⭐|🔴|⏹|👤|⚡|👇)\uFE0F?/gu;

// Keep literal text and UTF-16 offsets intact; button icons use Telegram's own field.
export function telegramCustomEmoji(method: string, payload: Record<string, unknown>): Record<string, unknown> {
  payload = privateErrorPayload(method, payload);
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
          custom_emoji_id: telegramEmojiIds[match[0].replace(/\uFE0F/g, "")] });
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

// Drafts use Telegram’s native append animation. Panel edits opt into a bounded
// reveal on the existing message; other edit callers keep their current behavior.
export async function telegramTextMotion(
  token: string, method: string, payload: Record<string, unknown>, options: { animateEdits?: boolean } = {},
): Promise<void> {
  prepareErrorNotice(method, payload);
  const editing = method === "editMessageText" && options.animateEdits && Number.isSafeInteger(payload.message_id);
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
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(telegramCustomEmoji(action, body)),
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
        ? { chat_id: chat, message_id: payload.message_id, text, entities, reply_markup: payload.reply_markup }
        : { chat_id: chat, message_thread_id: payload.message_thread_id, draft_id, text, entities });
      // Wait after acknowledgement: network time must not consume the reveal time.
      // Persisting immediately would replace the draft before its animation finishes.
      const pause = editing ? 450 : frame === 0 ? 120 : Math.min(1000, Math.max(500, chars.length * 12));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pause, deadline - performance.now()))));
    }
  } catch { /* Motion is optional; the complete original send/edit must always run. */ }
}

export const ADMIN_USER_ID = 7138547731;
export const ADMIN_USERS_PAGE_SIZE = 8;
export const ADMIN_DOWNLOADS_PAGE_SIZE = 5;
export const VISIT_IDLE_MS = 30 * 60_000;

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
};
export type AdminDownload = DownloadRecord & { createdAt: number; updatedAt: number; stale: boolean };
export type AdminUserDetail = {
  user: AdminUserRow;
  usage?: UsageTotals;
  activity: { visits: number; interactions: number; starts: number; trackingSince: number } | null;
  counts: { total: number; success: number; failed: number; partial: number; active: number; stale: number; results: number; delivered: number };
  downloads: AdminDownload[];
  page: number;
  totalPages: number;
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
};
export type AdminUsage = {
  trackingSince: number; now: number; lastMeasured: number | null; userId?: string;
  all: UsageTotals; day: UsageTotals; week: UsageTotals;
};

type StoreEnv = { BOT_TOKEN?: string };

export type AdminStatsEnv = {
  ADMIN_STATS: DurableObjectNamespace<AdminStatsStore>;
};

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
    this.ctx.storage.sql.exec(`
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

      CREATE TABLE IF NOT EXISTS membership_access (
        user_id TEXT PRIMARY KEY, first_download_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO membership_access(user_id, first_download_at)
        SELECT user_id, MIN(created_at) FROM download_history WHERE delivered > 0 GROUP BY user_id;
      INSERT OR IGNORE INTO counters(key, value) VALUES ('membership_enabled', 1);

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
    return Object.fromEntries(Object.entries({ ...resource, ...media }).map(([key, value]) => [key, asNumber(value)])) as UsageTotals;
  }

  async alarm(): Promise<void> { await this.broadcasts.alarm(); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/broadcast") return this.broadcasts.fetch(request);

    // One shared cooldown for anonymous Instagram Post/Reel resolution across
    // stateless Workers. Reuse the existing counters table and Durable Object.
    if (url.pathname === "/instagram-public-cooldown") {
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      if (request.method === "GET") {
        const row = sql.exec("SELECT value FROM counters WHERE key = 'instagram_public_cooldown_until'").toArray()[0];
        const until = Number(row?.value) || 0;
        return Response.json({ remainingSeconds: Math.max(0, Math.ceil((until - now) / 1000)) });
      }
      if (request.method === "POST") {
        const payload = await request.json().catch(() => null) as { seconds?: number } | null;
        const seconds = payload?.seconds;
        if (!Number.isSafeInteger(seconds) || seconds! < 1 || seconds! > 86400) {
          return new Response("Invalid cooldown", { status: 400 });
        }
        const until = now + seconds! * 1000;
        sql.exec(`INSERT INTO counters(key,value) VALUES ('instagram_public_cooldown_until', ?)
          ON CONFLICT(key) DO UPDATE SET value = MAX(counters.value, excluded.value)`, until);
        const row = sql.exec("SELECT value FROM counters WHERE key = 'instagram_public_cooldown_until'").one();
        return Response.json({ remainingSeconds: Math.max(0, Math.ceil((Number(row.value) - now) / 1000)) });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (request.method === "POST" && url.pathname === "/usage") {
      const body = await request.json() as { samples?: UsageSample[]; deliveries?: MediaUsage[]; runs?: ContainerRun[] };
      const runs = body.runs ?? [];
      const validId = (id: number) => Number.isSafeInteger(id) && id >= 0;
      const metric = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e15);
      const validKey = (key: string) => typeof key === "string" && /^[A-Za-z0-9:_-]{1,180}$/.test(key);
      const now = Date.now();
      if (!Array.isArray(body.samples) || !Array.isArray(body.deliveries) || !Array.isArray(runs) || runs.length > 250 || body.samples.length > 250 || body.deliveries.length > 250
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
        lastMeasured: latest.at === null ? null : asNumber(latest.at), userId: id,
        all: this.usageTotals(0, now, id), day: this.usageTotals(now - 86400_000, now, id),
        week: this.usageTotals(now - 7 * 86400_000, now, id),
      } satisfies AdminUsage);
    }

    if (url.pathname === "/membership") {
      const sql = this.ctx.storage.sql;
      if (request.method === "POST") {
        const payload = await request.json() as { enabled?: boolean };
        if (typeof payload.enabled !== "boolean") return new Response("Invalid setting", { status: 400 });
        sql.exec("UPDATE counters SET value = ? WHERE key = 'membership_enabled'", payload.enabled ? 1 : 0);
      } else if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const user = url.searchParams.get("user");
      if (user !== null && !/^[1-9]\d{0,15}$/.test(user)) return new Response("Invalid user", { status: 400 });
      const enabled = sql.exec("SELECT value FROM counters WHERE key = 'membership_enabled'").one();
      const access = user ? sql.exec("SELECT user_id FROM membership_access WHERE user_id = ?", user).toArray() : [];
      return Response.json({ enabled: asNumber(enabled.value) === 1, downloaded: access.length > 0 });
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

    if (request.method === "POST" && url.pathname === "/download") {
      const payload = await request.json() as DownloadRecord;
      const statuses: DownloadStatus[] = ["pending", "awaiting_selection", "processing", "success", "failed", "partial", "results"];
      if (!/^[A-Za-z0-9:_-]{1,180}$/.test(payload.key || "") || !Number.isSafeInteger(payload.userId)
          || payload.userId <= 0 || !statuses.includes(payload.status)) return new Response("Invalid download", { status: 400 });
      const now = Date.now();
      const terminal = ["success", "failed", "partial", "results"].includes(payload.status);
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
      const activityRows = sql.exec("SELECT * FROM user_activity WHERE user_id = ?", id).toArray();
      const activity = activityRows[0];
      const staleBefore = Date.now() - 4 * 3600_000;
      const counts = sql.exec(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'success'),0) AS success, COALESCE(SUM(status = 'failed'),0) AS failed,
        COALESCE(SUM(status = 'partial'),0) AS partial, COALESCE(SUM(status = 'results'),0) AS results,
        COALESCE(SUM(status = 'awaiting_selection' OR (status IN ('pending','processing') AND updated_at >= ?)),0) AS active,
        COALESCE(SUM(status IN ('pending','processing') AND updated_at < ?),0) AS stale,
        COALESCE(SUM(delivered),0) AS delivered FROM download_history WHERE user_id = ?`, staleBefore, staleBefore, id).one();
      const totalPages = Math.max(1, Math.ceil(asNumber(counts.total) / ADMIN_DOWNLOADS_PAGE_SIZE));
      const rawPage = Number(url.searchParams.get("page") || 0);
      const page = Math.min(Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0, totalPages - 1);
      const downloads = sql.exec("SELECT * FROM download_history WHERE user_id = ? ORDER BY created_at DESC, key DESC LIMIT ? OFFSET ?",
        id, ADMIN_DOWNLOADS_PAGE_SIZE, page * ADMIN_DOWNLOADS_PAGE_SIZE).toArray().map(row => ({
          key: String(row.key), userId: Number(id), source: String(row.source), request: String(row.request),
          status: row.status as DownloadStatus, title: row.title ? String(row.title) : undefined,
          detail: row.detail ? String(row.detail) : undefined, delivered: asNumber(row.delivered),
          createdAt: asNumber(row.created_at), updatedAt: asNumber(row.updated_at),
          stale: ["pending", "processing"].includes(String(row.status)) && asNumber(row.updated_at) < staleBefore,
        }));
      return Response.json({
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
  if (!env.ADMIN_STATS) return;
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
      [{ text: "📊 مصرف، ترافیک و هزینه", callback_data: "admin:usage" }],
      [{ text: "👥 لیست کاربران", callback_data: "admin:users:0" }],
      [{ text: "کاربران استفاده‌کننده", callback_data: "admin:used:0" }],
      [{ text: "فعال‌های ۲۴ ساعت", callback_data: "admin:users:0:day" },
        { text: "فعال‌های ۷ روز", callback_data: "admin:users:0:week" }],
      [{ text: "لینک‌فرستاده‌های ۲۴ ساعت", callback_data: "admin:used:0:day" },
        { text: "لینک‌فرستاده‌های ۷ روز", callback_data: "admin:used:0:week" }],
      [{ text: "عضویت اجباری چنل", callback_data: "admin:membership" }],
      [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
    ],
  };
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
  if (!env.ADMIN_STATS || record.userId === ADMIN_USER_ID) return;
  try {
    const response = await statsStub(env as AdminStatsEnv).fetch("https://admin-stats/download", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
    });
    if (!response.ok) console.warn("download history rejected", { status: response.status });
    else {
      const result = await response.json() as { firstDownload?: boolean };
      if (result.firstDownload && env.BOT_TOKEN) {
        try {
          const { notifyFirstDownload } = await import("./membership");
          await notifyFirstDownload(env, record.userId);
        } catch { console.warn("first-download membership prompt unavailable"); }
      }
    }
  } catch { console.warn("download history unavailable"); }
}

export async function getAdminUserDetail(env: AdminStatsEnv, id: string, page: number): Promise<AdminUserDetail | null> {
  const url = new URL("https://admin-stats/user");
  url.searchParams.set("id", id);
  url.searchParams.set("page", String(page));
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
      `هزینهٔ تخمینی ناخالص: ${usageCostLabel(detail.usage)}`, ""] : []),
    `📋 سابقه • صفحه ${detail.page + 1}/${detail.totalPages}`,
    "سابقه و تعداد برگشت‌های پیش از فعال‌شدن ثبت جدید در دسترس نیست.",
  ];
  if (!detail.downloads.length) lines.push("هنوز درخواست جدیدی ثبت نشده.");
  detail.downloads.forEach((item, index) => {
    lines.push("", `${detail.page * ADMIN_DOWNLOADS_PAGE_SIZE + index + 1}. ${displayText(item.source, 32)} • ${dateLabel(item.createdAt)}`,
      item.stale ? "❔ نتیجه نهایی ثبت نشده (بیش از ۴ ساعت)" : STATUS_LABELS[item.status],
      ...(item.title ? [`عنوان: ${displayText(item.title, 90)}`] : []),
      `درخواست: ${displayText(item.request, 180)}`,
      ...(item.delivered ? [`فایل تحویل‌شده: ${item.delivered}`] : []),
      ...(item.detail ? [`توضیح: ${displayText(item.detail, 100)}`] : []));
  });
  return lines.join("\n");
}

export function adminUserDetailKeyboard(detail: AdminUserDetail, usersPage: number, usedOnly = false, period?: AdminPeriod): Record<string, unknown> {
  const periodSuffix = period ? `:${period}` : "";
  const callback = (page: number) => `admin:user:${detail.user.id}:${usersPage}:${page}${usedOnly ? ":used" : ""}${periodSuffix}`;
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (detail.page > 0) nav.push({ text: "‹ جدیدتر", callback_data: callback(detail.page - 1) });
  if (detail.page + 1 < detail.totalPages) nav.push({ text: "قدیمی‌تر ›", callback_data: callback(detail.page + 1) });
  return { inline_keyboard: [
    ...(nav.length ? [nav] : []),
    [{ text: "📊 مصرف و هزینهٔ این کاربر", callback_data: `admin:usage:${detail.user.id}:${usersPage}:${detail.page}${usedOnly ? ":used" : ""}${periodSuffix}` }],
    [{ text: "🔄 بروزرسانی", callback_data: callback(detail.page) }],
    [{ text: usedOnly ? "بازگشت به استفاده‌کنندگان" : "👥 بازگشت به کاربران", callback_data: `admin:${usedOnly ? "used" : "users"}:${usersPage}${periodSuffix}` }, { text: "🏠 آمار", callback_data: "admin:stats" }],
  ] };
}

// Telemetry failures must never reject a download or replay a Telegram send.
export async function recordUsage(env: Partial<AdminStatsEnv>, samples: UsageSample[] = [], deliveries: MediaUsage[] = [], runs: ContainerRun[] = []): Promise<boolean> {
  if (!env.ADMIN_STATS) return false;
  try {
    const response = await statsStub(env as AdminStatsEnv).fetch("https://admin-stats/usage", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples, deliveries, runs }),
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

function usageCostLabel(value: UsageTotals): string {
  // standard-2: 6 GiB RAM, 12 GB disk. CPU is measured from the container
  // cgroup, never inferred from elapsed time. Gross rates verified 2026-10-20.
  const fixed = value.runtimeMs / 1000 * (6 * 0.0000025 + 12 * 0.00000007);
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
      `هزینهٔ تخمینی ناخالص: ${usageCostLabel(value)}`,
      ...(value.cpuMeasuredMs + 1 < value.runtimeMs || value.networkMeasuredMs + 1 < value.runtimeMs
        ? ["⚠️ بخشی از اندازه‌گیری CPU یا شبکه در دسترس نیست؛ برآورد ناقص است."] : []), "");
  }
  lines.push("نوع فعلی: standard-2؛ تعرفه‌ها: ۲۰ اکتبر ۲۰۲۶.",
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
