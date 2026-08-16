import { DurableObject } from "cloudflare:workers";

export const ADMIN_USER_ID = 7138547731;
export const ADMIN_USERS_PAGE_SIZE = 8;

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
};

type RecordPayload = {
  user: TrackedUser;
  linkSent: boolean;
};

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
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/record") {
      const payload = (await request.json()) as RecordPayload;
      const user = payload?.user;
      if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
        return Response.json({ ok: false, error: "invalid-user" }, { status: 400 });
      }

      const now = Date.now();
      const id = String(user.id);
      this.ctx.storage.sql.exec(
        `INSERT INTO users(id, username, first_name, last_name, links_sent, first_seen, last_seen)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           first_name = excluded.first_name,
           last_name = excluded.last_name,
           last_seen = excluded.last_seen`,
        id,
        cleanText(user.username),
        cleanText(user.firstName),
        cleanText(user.lastName),
        now,
        now,
      );

      if (payload.linkSent) {
        this.ctx.storage.sql.exec(
          "UPDATE users SET links_sent = links_sent + 1, last_seen = ? WHERE id = ?",
          now,
          id,
        );
      }

      return Response.json({ ok: true });
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
      const count = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS total_users FROM users",
      ).one() as CountSqlRow;
      const totalUsers = asNumber(count.total_users);
      const totalPages = Math.max(1, Math.ceil(totalUsers / ADMIN_USERS_PAGE_SIZE));
      const safePage = Math.min(page, totalPages - 1);
      const offset = safePage * ADMIN_USERS_PAGE_SIZE;
      const rows = this.ctx.storage.sql.exec(
        `SELECT id, username, first_name, last_name, links_sent, first_seen, last_seen
         FROM users
         ORDER BY last_seen DESC
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
      } satisfies AdminUsersPage);
    }

    return new Response("Not Found", { status: 404 });
  }
}

function statsStub(env: AdminStatsEnv) {
  return env.ADMIN_STATS.getByName("global");
}

export async function recordUserActivity(
  env: AdminStatsEnv,
  user: TrackedUser,
  linkSent: boolean,
): Promise<void> {
  try {
    const response = await statsStub(env).fetch("https://admin-stats/record", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user, linkSent } satisfies RecordPayload),
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

export async function getAdminUsersPage(env: AdminStatsEnv, page: number): Promise<AdminUsersPage> {
  const url = new URL("https://admin-stats/users");
  url.searchParams.set("page", String(Math.max(0, Math.floor(page))));
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
      [{ text: "🔄 بروزرسانی آمار", callback_data: "admin:stats" }],
    ],
  };
}

export function formatAdminUsers(page: AdminUsersPage): string {
  const lines = [
    `👥 لیست کاربران (${page.totalUsers})`,
    `صفحه ${page.page + 1}/${page.totalPages}`,
    "",
  ];

  if (!page.users.length) {
    lines.push("هنوز کاربری ثبت نشده.");
    return lines.join("\n");
  }

  page.users.forEach((user, index) => {
    const number = page.page * page.pageSize + index + 1;
    const username = user.username ? ` • @${user.username}` : "";
    lines.push(`${number}. ${userDisplayName(user)}${username}`);
    lines.push(`ID: ${user.id} • 🔗 ${user.linksSent}`);
    if (index !== page.users.length - 1) lines.push("");
  });

  return lines.join("\n");
}

export function adminUsersKeyboard(page: AdminUsersPage): Record<string, unknown> {
  const nav: Array<Record<string, string>> = [];
  if (page.page > 0) nav.push({ text: "‹ قبلی", callback_data: `admin:users:${page.page - 1}` });
  nav.push({ text: "🏠 آمار", callback_data: "admin:stats" });
  if (page.page + 1 < page.totalPages) nav.push({ text: "بعدی ›", callback_data: `admin:users:${page.page + 1}` });

  return { inline_keyboard: [nav] };
}
