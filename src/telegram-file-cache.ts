// Increase this duration in place when retention changes; keep shard mapping stable.
export const FILE_CACHE_RETENTION_MS = 365 * 86400_000;
export const FILE_CACHE_SHARDS = 64;
export type CachedTelegramFile = {
  method: "sendAudio" | "sendVideo" | "sendPhoto" | "sendDocument" | "sendAnimation";
  fileId?: string;
  sourceMessage?: { chatId: number; messageId: number }; // Confirmed photo upload without a Bot API file_id.
  data: Record<string, string | number | boolean>;
  fileSize?: number;
  hasAudio?: boolean;
};
export type CachedTelegramPost = { kind: "post"; files: (CachedTelegramFile & { index: number })[] };
export type TelegramCacheValue = CachedTelegramFile | CachedTelegramPost;

// Public anonymous results and access-checked results never share a cache namespace.
export function instagramFileCacheKey(id: string, index: number, mode: string, publicPost = false, story = false): string {
  return `ig:v2:${publicPost ? "public" : "access"}:${story ? "s" : "p"}:${id}:${index}:${mode}`;
}
export function instagramPostCacheKey(shortcode: string, language?: string, index?: number): string {
  return `ready:ig:${shortcode}:${language ? `sub-${language}-v1` : "plain"}:${index ?? "all"}`;
}

function cleanCachedFile(value: any): CachedTelegramFile | null {
  if (!value || !["sendAudio", "sendVideo", "sendPhoto", "sendDocument", "sendAnimation"].includes(value.method)) return null;
  const fileId = typeof value.fileId === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(value.fileId) ? value.fileId : undefined;
  const reference = value.sourceMessage;
  const sourceMessage = value.method === "sendPhoto" && Number.isSafeInteger(reference?.chatId) && reference.chatId !== 0 &&
    Number.isSafeInteger(reference?.messageId) && reference.messageId > 0 ? { chatId: reference.chatId, messageId: reference.messageId } : undefined;
  if (!fileId && !sourceMessage) return null;
  const data: CachedTelegramFile["data"] = {};
  for (const key of ["caption", "title", "performer", "width", "height", "duration", "supports_streaming"]) {
    const item = value.data?.[key];
    if (typeof item === "string") data[key] = item.slice(0, key === "caption" ? 1024 : 180);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) data[key] = item;
  }
  return { method: value.method, ...(fileId ? {fileId} : {sourceMessage}), data,
    ...(Number.isSafeInteger(value.fileSize) && value.fileSize > 0 && value.fileSize <= 2_000_000_000 ? { fileSize: value.fileSize } : {}),
    ...(typeof value.hasAudio === "boolean" ? { hasAudio: value.hasAudio } : {}),
  };
}

function cleanCacheValue(value: any): TelegramCacheValue | null {
  if (value?.kind !== "post") return cleanCachedFile(value);
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 20) return null;
  const files: CachedTelegramPost["files"] = [];
  for (const item of value.files) {
    const file = cleanCachedFile(item);
    if (!file || !Number.isSafeInteger(item.index) || item.index < 0 || item.index > 19 || files.some(f => f.index === item.index)) return null;
    files.push({ ...file, index: item.index });
  }
  if (files.reduce((sum, f) => sum + (f.fileSize || 0), 0) > 2_000_000_000) return null;
  return { kind: "post", files };
}

type Sql = { exec(query: string, ...args: any[]): { toArray(): any[] } };
export function telegramFileCacheRequest(body: any, sql: Sql, now = Date.now()): Response {
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(body?.key || '') || !['get','put','delete','import'].includes(body?.op))
    return new Response('Invalid cache request', { status: 400 });
  if (body.op === 'get') {
    const row = sql.exec('SELECT value,created_at FROM telegram_file_cache WHERE key = ?', body.key).toArray()[0];
    let value = null;
    try { if (row && row.created_at > now-FILE_CACHE_RETENTION_MS) value = cleanCacheValue(JSON.parse(row.value)); } catch { /* Corrupt entries are misses. */ }
    return Response.json({ value, known: Boolean(row), ...(row ? { createdAt: row.created_at } : {}) });
  }
  const value = body.op === 'delete' ? null : cleanCacheValue(body.value);
  if (body.op !== 'delete' && !value) return new Response('Invalid file', { status: 400 });
  const createdAt = body.op === 'import' ? body.createdAt : now;
  if (!Number.isSafeInteger(createdAt) || createdAt > now || createdAt <= now-FILE_CACHE_RETENTION_MS)
    return new Response('Invalid cache timestamp', { status: 400 });
  if (body.op === 'import') {
    // Lazy migration must not overwrite a concurrent upload or invalidation.
    sql.exec('INSERT OR IGNORE INTO telegram_file_cache(key,value,created_at) VALUES (?,?,?)', body.key, JSON.stringify(value), createdAt);
  } else {
    // Keep invalidation markers so a legacy entry cannot resurrect an invalid file_id.
    sql.exec('INSERT INTO telegram_file_cache(key,value,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,created_at=excluded.created_at', body.key, JSON.stringify(value), createdAt);
  }
  // Indexed, bounded cleanup; no full-cache count/offset scan on each upload.
  sql.exec('DELETE FROM telegram_file_cache WHERE key IN (SELECT key FROM telegram_file_cache WHERE created_at <= ? ORDER BY created_at LIMIT 200)', now-FILE_CACHE_RETENTION_MS);
  return Response.json({ ok: true });
}

type Store = { fetch(input: Request): Promise<Response> };
type Env = { BOT_TOKEN: string; ADMIN_STATS?: { getByName(name: string): Store } };
type Reply = { value?: TelegramCacheValue | null; known?: boolean; createdAt?: number };
async function cacheCall(store: Store, body: Record<string, unknown>, signal: AbortSignal): Promise<Reply> {
  const response = await store.fetch(new Request('https://store/file-cache', {
    method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body), signal,
  }));
  if (!response.ok) throw new Error('FILE_CACHE_UNAVAILABLE');
  return response.json();
}

async function cacheValue(env: Env, op: 'get'|'put'|'delete', key: string, value?: TelegramCacheValue): Promise<TelegramCacheValue | null> {
  try {
    if (!env.ADMIN_STATS || !/^[A-Za-z0-9:_-]{1,180}$/.test(key)) return null;
    const signal = AbortSignal.timeout(5000);
    const call = (store: Store, body: Record<string, unknown>) => cacheCall(store, body, signal);
    const bot = env.BOT_TOKEN.split(':')[0];
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
    const shard = env.ADMIN_STATS.getByName(`telegram-files-${bot}-v2-${digest[0] % FILE_CACHE_SHARDS}`);
    const legacy = () => env.ADMIN_STATS!.getByName(`telegram-files-${bot}`);
    if (op === 'delete') {
      await Promise.allSettled([call(shard,{op,key}),call(legacy(),{op,key})]);
      return null;
    }
    if (op === 'put') { await call(shard,{op,key,value}); return null; }
    const current = await call(shard,{op,key});
    if (current.known || current.value) return current.value ? cleanCacheValue(current.value) : null;
    const old = await call(legacy(),{op,key});
    if (!old.value) return null;
    if (old.createdAt === undefined) return cleanCacheValue(old.value); // Rolling deployment: do not invent the old record's age.
    await call(shard,{op:'import',key,value:old.value,createdAt:old.createdAt});
    const migrated = await call(shard,{op:'get',key});
    return migrated.value ? cleanCacheValue(migrated.value) : null;
  } catch { return null; } // Cache outages never block the existing download path.
}

export async function telegramFileCache(env: Env, op: 'get'|'put'|'delete', key: string, value?: CachedTelegramFile): Promise<CachedTelegramFile | null> {
  const result = await cacheValue(env, op, key, value);
  return result && !("kind" in result) ? result : null;
}
export async function telegramPostCache(env: Env, op: 'get'|'put'|'delete', key: string, value?: CachedTelegramPost): Promise<CachedTelegramPost | null> {
  const result = await cacheValue(env, op, key, value);
  return result && "kind" in result ? result : null;
}
