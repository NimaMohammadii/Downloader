export type CachedVideo = { source: string; downloadKey: string };
const SOURCES = ['YouTube','Instagram','Pinterest','TikTok','X','Aparat','SoundCloud','Reddit','Bandcamp','Pornhub'] as const;
export function cacheSource(source: string): string {
  return source.startsWith('Instagram') ? 'Instagram' : SOURCES.includes(source as typeof SOURCES[number]) ? source : 'Other';
}
export function validCachedVideo(value: any): value is CachedVideo {
  return !!value && typeof value.source === 'string' && [...SOURCES,'Other'].includes(value.source) &&
    typeof value.downloadKey === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(value.downloadKey);
}
type Sql = { exec(query: string, ...args: any[]): { toArray(): any[] } };
export function createCacheUsage(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS cached_video_deliveries (
    event_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, download_key TEXT NOT NULL, source TEXT NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cached_video_history ON cached_video_deliveries(user_id,download_key);
    CREATE INDEX IF NOT EXISTS cached_video_time ON cached_video_deliveries(recorded_at,source);`);
  sql.exec("INSERT OR IGNORE INTO counters(key,value) VALUES ('cached_video_tracking_since',?)",Date.now());
}
export function saveCachedVideo(sql: Sql, event: {key:string;userId:number;at:number;cached?:boolean;cachedVideo?:CachedVideo}): void {
  if (!event.cached || !validCachedVideo(event.cachedVideo)) return;
  sql.exec(`INSERT OR IGNORE INTO cached_video_deliveries
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM media_usage WHERE key=? AND user_id=? AND cached=1)`,
    event.key,String(event.userId),event.cachedVideo.downloadKey,event.cachedVideo.source,event.at,event.key,String(event.userId));
}
export type CacheStatistics = { since:number; all:number; day:number; week:number;
  sources:{source:string;all:number;day:number;week:number}[]; legacyUnclassifiedMedia:number };
export function cacheStatistics(sql: Sql, now=Date.now()): CacheStatistics {
  const rows=sql.exec(`SELECT source,COUNT(*) AS total,SUM(recorded_at>=?) AS day,SUM(recorded_at>=?) AS week
    FROM cached_video_deliveries WHERE recorded_at<=? GROUP BY source ORDER BY total DESC,source`,now-86400_000,now-7*86400_000,now).toArray();
  const sources=rows.map(r=>({source:String(r.source),all:Number(r.total),day:Number(r.day),week:Number(r.week)}));
  const tracking=sql.exec("SELECT value FROM counters WHERE key='cached_video_tracking_since'").toArray()[0];
  const legacy=sql.exec(`SELECT COUNT(*) AS n FROM media_usage m WHERE cached=1 AND NOT EXISTS
    (SELECT 1 FROM cached_video_deliveries c WHERE c.event_key=m.key)`).toArray()[0];
  return {since:Number(tracking?.value||now),all:sources.reduce((n,r)=>n+r.all,0),day:sources.reduce((n,r)=>n+r.day,0),
    week:sources.reduce((n,r)=>n+r.week,0),sources,legacyUnclassifiedMedia:Number(legacy?.n||0)};
}
export function formatCacheStatistics(stats: CacheStatistics): string {
  return ['<b>📦 ویدیوهای ارسال‌شده از Cache</b>','',
    `<b>کل ارسال‌ها: ${stats.all}</b>`,`۲۴ ساعت گذشته: <b>${stats.day}</b>`,`۷ روز گذشته: <b>${stats.week}</b>`,'',
    `<b>شروع ثبت تفکیکی:</b> ${new Intl.DateTimeFormat('en-GB',{dateStyle:'short',timeZone:'Asia/Tehran'}).format(stats.since)}`,'',
    '<b>تفکیک سرویس‌ها</b>',...stats.sources.map(r=>`• <b>${r.source}</b> — کل: <b>${r.all}</b> | 24h: <b>${r.day}</b> | 7d: <b>${r.week}</b>`),
    ...(stats.sources.length?[]:['هنوز ویدیوی کش‌شده‌ای در این بخش ثبت نشده.']),'',
    'هر ارسال موفق یک بار شمرده می‌شود؛ این عدد تعداد ویدیوهای یکتا نیست.',
    `ارسال‌های کش بدون تشخیص ویدیو یا سرویس: <b>${stats.legacyUnclassifiedMedia}</b>`,
    'آمار تفکیکی ویدیو از فعال‌شدن ثبت جدید است؛ موارد بدون تفکیک ممکن است شامل صدا هم باشند.'].join('\n');
}
