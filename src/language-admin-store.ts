import { isLanguage, type Language } from './localization';

export const BOT_LANGUAGES = ['fa', 'en', 'ru'] as const;
export const LANGUAGE_LABELS: Record<Language, string> = { fa: 'فارسی 🇮🇷', en: 'انگلیسی 🇬🇧', ru: 'روسی 🇷🇺' };
export const LANGUAGE_PERIODS = { '4h': 4 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, all: 0 } as const;
export type LanguagePeriod = keyof typeof LANGUAGE_PERIODS;
export type LanguageCounts = Record<Language, number>;
export type LanguageSummary = { periods: Record<LanguagePeriod, LanguageCounts>; asOf: number };
export type LanguageUsers = { language: Language; period: LanguagePeriod; page: number; totalPages: number; totalUsers: number;
  users: { id: string; username: string | null; firstName: string | null; lastName: string | null; lastSeen: number; selected: boolean }[] };

export function createLanguageTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS user_languages (
    user_id TEXT PRIMARY KEY, language TEXT NOT NULL CHECK(language IN ('fa','en','ru'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_languages_language ON user_languages(language,user_id);
  CREATE TABLE IF NOT EXISTS membership_languages (
    language TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
  );
  INSERT OR IGNORE INTO membership_languages(language,enabled) VALUES ('fa',1),('en',1),('ru',1);`);
}

// Import existing KV preferences once, in bounded batches. New choices are indexed immediately;
// INSERT OR IGNORE keeps a concurrent new choice ahead of an older import snapshot.
export async function importLanguagePreferences(storage: DurableObjectStorage): Promise<void> {
  if (storage.sql.exec("SELECT value FROM counters WHERE key='language_index_imported'").toArray().length) return;
  let startAfter: string | undefined;
  for (;;) {
    const batch = await storage.list<unknown>({ prefix: 'language:', limit: 500, ...(startAfter ? { startAfter } : {}) });
    storage.transactionSync(() => {
      for (const [key, language] of batch) {
        const id = key.slice('language:'.length);
        if (/^[1-9]\d{0,15}$/.test(id) && isLanguage(language))
          storage.sql.exec('INSERT OR IGNORE INTO user_languages(user_id,language) VALUES (?,?)', id, language);
      }
    });
    if (batch.size < 500) break;
    startAfter = [...batch.keys()].at(-1);
  }
  storage.sql.exec("INSERT OR IGNORE INTO counters(key,value) VALUES ('language_index_imported',1)");
}

export function membershipLanguages(sql: SqlStorage): Record<Language, boolean> {
  const result = { fa: true, en: true, ru: true };
  for (const row of sql.exec('SELECT language,enabled FROM membership_languages').toArray())
    if (isLanguage(row.language)) result[row.language] = Number(row.enabled) === 1;
  return result;
}

export function languageStatistics(url: URL, sql: SqlStorage, adminIds: number[], now = Date.now()): Response {
  const periodValue = url.searchParams.get('period') || 'all';
  if (!Object.hasOwn(LANGUAGE_PERIODS, periodValue)) return new Response('Invalid period', { status: 400 });
  const period = periodValue as LanguagePeriod;
  const admins = adminIds.map(String);
  const exclusion = admins.length ? `AND u.id NOT IN (${admins.map(() => '?').join(',')})` : '';
  const from = `FROM users u LEFT JOIN user_languages l ON l.user_id=u.id`;
  const active = `u.last_seen >= ? AND u.last_seen <= ? ${exclusion}`;
  const since = (p: LanguagePeriod) => LANGUAGE_PERIODS[p] ? now - LANGUAGE_PERIODS[p] : 0;
  if (url.pathname === '/language-stats') {
    const periods = {} as LanguageSummary['periods'];
    for (const p of Object.keys(LANGUAGE_PERIODS) as LanguagePeriod[]) {
      const counts: LanguageCounts = { fa: 0, en: 0, ru: 0 };
      for (const row of sql.exec(`SELECT COALESCE(l.language,'fa') AS language, COUNT(*) AS count ${from}
        WHERE ${active} GROUP BY COALESCE(l.language,'fa')`, since(p), now, ...admins).toArray())
        if (isLanguage(row.language)) counts[row.language] = Number(row.count);
      periods[p] = counts;
    }
    return Response.json({ periods, asOf: now } satisfies LanguageSummary);
  }
  const language = url.searchParams.get('language');
  const rawPage = Number(url.searchParams.get('page') || 0);
  if (!isLanguage(language) || !Number.isSafeInteger(rawPage) || rawPage < 0) return new Response('Invalid list', { status: 400 });
  const filter = `${active} AND COALESCE(l.language,'fa')=?`;
  const params = [since(period), now, ...admins, language];
  const totalUsers = Number(sql.exec(`SELECT COUNT(*) AS count ${from} WHERE ${filter}`, ...params).one().count);
  const totalPages = Math.max(1, Math.ceil(totalUsers / 8));
  const page = Math.min(rawPage, totalPages - 1);
  const users = sql.exec(`SELECT u.*, l.language AS selected_language ${from} WHERE ${filter}
    ORDER BY u.last_seen DESC,u.id ASC LIMIT 8 OFFSET ?`, ...params, page * 8).toArray().map(row => ({
      id: String(row.id), username: row.username as string | null, firstName: row.first_name as string | null,
      lastName: row.last_name as string | null, lastSeen: Number(row.last_seen), selected: row.selected_language !== null,
    }));
  return Response.json({ language, period, page, totalPages, totalUsers, users } satisfies LanguageUsers);
}

// Presence for language reports includes interactions stopped by membership and language menus.
// It does not change link, visit, download or delivery counters.
export async function recordLanguagePresence(env: Partial<import('./admin').AdminStatsEnv>, user: import('./admin').TrackedUser): Promise<void> {
  if (!env.ADMIN_STATS) return;
  try {
    const response = await env.ADMIN_STATS.getByName('global').fetch('https://admin-stats/language-presence', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user),
    });
    if (!response.ok) console.warn('language presence unavailable', { status: response.status });
  } catch { console.warn('language presence unavailable'); }
}
