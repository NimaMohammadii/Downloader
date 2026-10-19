import { DurableObject } from "cloudflare:workers";

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

// Telegram animates newly appended draft characters. Never truncate a delivered message.
export async function telegramTextMotion(token: string, method: string, payload: Record<string, unknown>): Promise<void> {
  if (method !== "sendMessage" || typeof payload.text !== "string" || payload.parse_mode ||
      payload.text.length < 2 || payload.inline_message_id || payload.business_connection_id) return;
  const chat = Number(payload.chat_id);
  if (!Number.isSafeInteger(chat) || chat <= 0) return;
  const key = `${token.split(":")[0]}:${chat}`;
  const now = Date.now();
  if (now < (textMotionChats.get(key) || 0)) return;
  if (textMotionChats.size >= 512) textMotionChats.delete(textMotionChats.keys().next().value!);
  textMotionChats.set(key, now + 10000);
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
    const frames = Math.min(6, Math.max(2, Math.ceil(chars.length / 8)));
    const draft_id = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
    for (let frame = 0; frame < frames; frame++) {
      if (performance.now() >= deadline) break;
      const end = frame === 0 ? 1 : Math.ceil(chars.length * frame / (frames - 1));
      const text = chars.slice(0, end).join("");
      if (!text.trim()) continue;
      const entities = Array.isArray(payload.entities) ? (payload.entities as Record<string, unknown>[])
        .filter(e => Number(e.offset) < text.length && (e.type !== "custom_emoji" || Number(e.offset) + Number(e.length) <= text.length))
        .map(e => ({ ...e, length: Math.min(Number(e.length), text.length - Number(e.offset)) })) : undefined;
      const sentAt = performance.now();
      await post("sendMessageDraft", { chat_id: chat, message_thread_id: payload.message_thread_id, draft_id, text, entities });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(400 - (performance.now() - sentAt), deadline - performance.now()))));
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
  activity: { visits: number; interactions: number; starts: number; trackingSince: number } | null;
  counts: { total: number; success: number; failed: number; partial: number; active: number; stale: number; results: number; delivered: number };
  downloads: AdminDownload[];
  page: number;
  totalPages: number;
};

type StoreEnv = Record<string, never>;

export type AdminStatsEnv = {
  ADMIN_STATS: DurableObjectNamespace<AdminStatsStore>;
};

export type TrackedUser = {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
};

export type AdminSummary = {
  totalUsers: number;
  linksSent: number;
  successfulDownloads: number;
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
  constructor(ctx: DurableObjectState, env: StoreEnv) {
    super(ctx, env);
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

      CREATE TABLE IF NOT EXISTS telegram_file_cache (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_file_cache_at ON telegram_file_cache(created_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
      return Response.json({ ok: true });
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

      return Response.json({
        totalUsers: asNumber(summary.total_users),
        linksSent: asNumber(summary.links_sent),
        successfulDownloads: asNumber(success.value),
      } satisfies AdminSummary);
    }

    if (request.method === "GET" && url.pathname === "/users") {
      const rawPage = Number(url.searchParams.get("page") || "0");
      const page = Number.isSafeInteger(rawPage) && rawPage >= 0 ? rawPage : 0;
      const usedOnly = url.searchParams.get("used") === "1";
      // Include legacy link counters as well as newer non-link requests; /start alone is not usage.
      const filter = usedOnly ? "WHERE links_sent > 0 OR EXISTS (SELECT 1 FROM download_history WHERE user_id = users.id)" : "";
      const count = this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS total_users FROM users ${filter}`,
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
        ADMIN_USERS_PAGE_SIZE,
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

export async function getAdminUsersPage(env: AdminStatsEnv, page: number, usedOnly = false): Promise<AdminUsersPage> {
  const url = new URL("https://admin-stats/users");
  url.searchParams.set("page", String(Math.max(0, Math.floor(page))));
  if (usedOnly) url.searchParams.set("used", "1");
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
  ].join("\n");
}

export function adminDashboardKeyboard(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [{ text: "👥 لیست کاربران", callback_data: "admin:users:0" }],
      [{ text: "کاربران استفاده‌کننده", callback_data: "admin:used:0" }],
      [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
    ],
  };
}

export function formatAdminUsers(page: AdminUsersPage): string {
  return [page.usedOnly ? `کاربران استفاده‌کننده (${page.totalUsers})` : `👥 لیست کاربران (${page.totalUsers})`,
    `صفحه ${page.page + 1}/${page.totalPages}`, "",
    ...(page.usedOnly ? ["ارسال لینک یا درخواست ثبت‌شدهٔ دانلود، جست‌وجو، استخراج صدا یا تشخیص آهنگ.",
      "کاربران قدیمی بر اساس اطلاعات ذخیره‌شده نمایش داده می‌شوند؛ صرفاً /start کافی نیست.", ""] : []),
    page.users.length ? "برای مشاهده آمار و سابقه دانلود، کاربر را انتخاب کنید:"
      : page.usedOnly ? "هنوز استفاده‌ای در اطلاعات ذخیره‌شده یافت نشد." : "هنوز کاربری ثبت نشده."].join("\n");
}

export function adminUsersKeyboard(page: AdminUsersPage): Record<string, unknown> {
  const list = page.usedOnly ? "used" : "users";
  const suffix = page.usedOnly ? ":used" : "";
  const rows = page.users.map(user => [{
    text: `${displayText(userDisplayName(user), 35)} • ${user.id}`,
    callback_data: `admin:user:${user.id}:${page.page}:0${suffix}`,
  }]);
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page.page > 0) nav.push({ text: "‹ قبلی", callback_data: `admin:${list}:${page.page - 1}` });
  nav.push({ text: "🏠 آمار", callback_data: "admin:stats" });
  if (page.page + 1 < page.totalPages) nav.push({ text: "بعدی ›", callback_data: `admin:${list}:${page.page + 1}` });
  return { inline_keyboard: [...rows, nav] };
}

function displayText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

export async function recordDownload(env: Partial<AdminStatsEnv>, record: DownloadRecord): Promise<void> {
  if (!env.ADMIN_STATS || record.userId === ADMIN_USER_ID) return;
  try {
    const response = await statsStub(env as AdminStatsEnv).fetch("https://admin-stats/download", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
    });
    if (!response.ok) console.warn("download history rejected", { status: response.status });
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

export function adminUserDetailKeyboard(detail: AdminUserDetail, usersPage: number, usedOnly = false): Record<string, unknown> {
  const callback = (page: number) => `admin:user:${detail.user.id}:${usersPage}:${page}${usedOnly ? ":used" : ""}`;
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (detail.page > 0) nav.push({ text: "‹ جدیدتر", callback_data: callback(detail.page - 1) });
  if (detail.page + 1 < detail.totalPages) nav.push({ text: "قدیمی‌تر ›", callback_data: callback(detail.page + 1) });
  return { inline_keyboard: [
    ...(nav.length ? [nav] : []),
    [{ text: "🔄 بروزرسانی", callback_data: callback(detail.page) }],
    [{ text: usedOnly ? "بازگشت به استفاده‌کنندگان" : "👥 بازگشت به کاربران", callback_data: `admin:${usedOnly ? "used" : "users"}:${usersPage}` }, { text: "🏠 آمار", callback_data: "admin:stats" }],
  ] };
}
