// Only the displayed catalog is persisted. Never store source URLs, cookies or formats.
export type YoutubeCatalog = { ok: true; videoId: string; title?: string; qualities: number[];
  audioAvailable: boolean; sizes?: Record<string, { bytes: number; estimated: boolean }> };
export const CATALOG_TTL_MS = 5 * 60_000;

export function cleanYoutubeCatalog(value: any, videoId: string): YoutubeCatalog | null {
  if (!value || value.ok !== true || value.videoId !== videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      !Array.isArray(value.qualities) || value.qualities.length > 4 ||
      !value.qualities.every((q: unknown) => [360,480,720,1080].includes(q as number)) ||
      typeof value.audioAvailable !== 'boolean' || (!value.qualities.length && !value.audioAvailable)) return null;
  const sizes: NonNullable<YoutubeCatalog['sizes']> = {};
  for (const key of ['360','480','720','1080','low','hq']) {
    const size = value.sizes?.[key];
    if (size && Number.isSafeInteger(size.bytes) && size.bytes > 0 && typeof size.estimated === 'boolean')
      sizes[key] = { bytes: size.bytes, estimated: size.estimated };
  }
  return { ok: true, videoId, ...(typeof value.title === 'string' ? { title: value.title.slice(0,1000) } : {}),
    qualities: [...new Set<number>(value.qualities)], audioAvailable: value.audioAvailable, sizes };
}

type Sql = { exec(query: string, ...args: any[]): { toArray(): any[] } };
export function youtubeCatalogRequest(body: any, sql: Sql, now = Date.now()): Response {
  if (!/^yt:[A-Za-z0-9_-]{11}:[a-f0-9]{64}$/.test(body?.key || '') || !['get','put'].includes(body?.op))
    return new Response('Invalid catalog', { status: 400 });
  const videoId = body.key.split(':')[1];
  if (body.op === 'get') {
    const row = sql.exec('SELECT value FROM youtube_catalog_cache WHERE key = ? AND created_at > ?', body.key, now-CATALOG_TTL_MS).toArray()[0];
    let value = null;
    try { if (row) value = cleanYoutubeCatalog(JSON.parse(row.value), videoId); } catch { /* Miss on corruption. */ }
    return Response.json({ value });
  }
  const value = cleanYoutubeCatalog(body.value, videoId);
  if (!value) return new Response('Invalid catalog', { status: 400 });
  sql.exec('INSERT INTO youtube_catalog_cache(key,value,created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,created_at=excluded.created_at', body.key, JSON.stringify(value), now);
  sql.exec('DELETE FROM youtube_catalog_cache WHERE created_at <= ?', now-CATALOG_TTL_MS);
  sql.exec('DELETE FROM youtube_catalog_cache WHERE key IN (SELECT key FROM youtube_catalog_cache ORDER BY created_at DESC LIMIT -1 OFFSET 10000)');
  return Response.json({ ok: true });
}

type Env = { BOT_TOKEN: string; ADMIN_STATS?: { getByName(name: string): { fetch(input: Request): Promise<Response> } } };
export async function youtubeCatalogCache(env: Env, op: 'get'|'put', key: string, value?: unknown): Promise<YoutubeCatalog | null> {
  try {
    if (!env.ADMIN_STATS) return null;
    const response = await env.ADMIN_STATS.getByName(`telegram-files-${env.BOT_TOKEN.split(':')[0]}`).fetch(new Request('https://store/youtube-catalog-cache', {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ op, key, value }), signal: AbortSignal.timeout(1500),
    }));
    if (!response.ok) return null;
    const result = await response.json() as { value?: unknown };
    return cleanYoutubeCatalog(result.value, key.split(':')[1]);
  } catch { return null; } // Catalog storage outages use the existing extraction path.
}
