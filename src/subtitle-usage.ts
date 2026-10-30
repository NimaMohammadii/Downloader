import { isSubtitleLanguage, subtitleName, type SubtitleLanguage } from './youtube-subtitles';

// Public direct-API rates verified 2026-10-29. Preserve the calculated amount
// on ingestion: a future rate change must not reprice historical requests.
// https://elevenlabs.io/pricing/api
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/guides/prompt-caching
export const SUBTITLE_PRICE_VERSION = '2026-10-29';
export type SubtitleCharge = {
  key: string; downloadKey: string; userId: number; at: number; language: SubtitleLanguage;
  provider: 'elevenlabs' | 'openai'; model: string;
  state: 'pending' | 'measured' | 'unknown' | 'rejected';
  audioSeconds?: number; inputTokens?: number; cachedInputTokens?: number;
  cacheWriteTokens?: number; outputTokens?: number; serviceTier?: string;
  requestId?: string;
};
export type SubtitleCosts = { transcriptionNano: number; translationNano: number; calls: number; unknown: number };
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const key = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(v);
export function validSubtitleCharge(v: SubtitleCharge, now: number): boolean {
  return Boolean(v && key(v.key) && key(v.downloadKey) && id(v.userId) && isSubtitleLanguage(v.language)
    && Number.isSafeInteger(v.at) && v.at >= 0 && v.at <= now + 60000
    && ['elevenlabs','openai'].includes(v.provider) && ['pending','measured','unknown','rejected'].includes(v.state)
    && typeof v.model === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(v.model)
    && (v.serviceTier === undefined || typeof v.serviceTier === 'string' && /^[a-z_]{1,30}$/.test(v.serviceTier))
    && (v.requestId === undefined || typeof v.requestId === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(v.requestId))
    && (v.audioSeconds === undefined || typeof v.audioSeconds === 'number' && Number.isFinite(v.audioSeconds) && v.audioSeconds > 0 && v.audioSeconds <= 36002)
    && [v.inputTokens,v.cachedInputTokens,v.cacheWriteTokens,v.outputTokens].every(n => n === undefined || Number.isSafeInteger(n) && n! >= 0 && n! <= 2000000));
}
export function subtitleChargeNano(v: SubtitleCharge): number | null {
  if (v.state === 'rejected') return 0;
  if (v.state !== 'measured') return null;
  if (v.provider === 'elevenlabs') return v.model === 'scribe_v2' && v.audioSeconds !== undefined
    ? Math.round(v.audioSeconds * 0.22 / 3600 * 1e9) : null;
  if (!/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(v.model)) return null;
  const factor = v.serviceTier === 'default' ? 1 : v.serviceTier === 'flex' ? 0.5
    : ['priority','fast'].includes(v.serviceTier || '') ? 2 : null;
  const { inputTokens: input, cachedInputTokens: cached, cacheWriteTokens: written, outputTokens: output } = v;
  if (factor === null || [input,cached,written,output].some(n => n === undefined) || cached! + written! > input!) return null;
  // Cache writes are a total rate, not a surcharge. Reasoning tokens are already
  // included in output_tokens; never add them a second time.
  return Math.round(((input! - cached! - written!) * 0.10 + cached! * 0.01 + written! * 0.125 + output! * 0.50) * factor * 1000);
}
export function createSubtitleLedger(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS youtube_subtitle_choices (
    download_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, language TEXT, recorded_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subtitle_api_usage (
    key TEXT PRIMARY KEY, download_key TEXT NOT NULL, user_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
    provider TEXT NOT NULL, state TEXT NOT NULL, cost_nano INTEGER, price_version TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_subtitle_usage_user_time ON subtitle_api_usage(user_id,recorded_at);
    CREATE INDEX IF NOT EXISTS idx_subtitle_usage_download ON subtitle_api_usage(download_key,user_id);`);
}
export function saveSubtitleCharge(sql: SqlStorage, v: SubtitleCharge): void {
  sql.exec(`INSERT INTO subtitle_api_usage VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET state=excluded.state, cost_nano=excluded.cost_nano, data=excluded.data
    WHERE subtitle_api_usage.state='pending' AND excluded.state!='pending'
      AND subtitle_api_usage.user_id=excluded.user_id AND subtitle_api_usage.download_key=excluded.download_key
      AND subtitle_api_usage.provider=excluded.provider AND subtitle_api_usage.recorded_at=excluded.recorded_at`,
    v.key,v.downloadKey,String(v.userId),v.at,v.provider,v.state,subtitleChargeNano(v),SUBTITLE_PRICE_VERSION,JSON.stringify(v));
}
export function subtitleCosts(sql: SqlStorage, since: number, until: number, userId?: string, downloadKey?: string): SubtitleCosts {
  const row = sql.exec(`SELECT COALESCE(SUM(CASE WHEN provider='elevenlabs' THEN cost_nano ELSE 0 END),0) AS transcriptionNano,
    COALESCE(SUM(CASE WHEN provider='openai' THEN cost_nano ELSE 0 END),0) AS translationNano,
    COUNT(*) AS calls, COALESCE(SUM(cost_nano IS NULL),0) AS unknown
    FROM subtitle_api_usage WHERE recorded_at>=? AND recorded_at<=?
    ${userId ? 'AND user_id=?' : ''} ${downloadKey ? 'AND download_key=?' : ''}`,
    since,until,...(userId ? [userId] : []),...(downloadKey ? [downloadKey] : [])).one();
  return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)])) as SubtitleCosts;
}
export const subtitleDollars = (n: number): string => `$${(n / 1e9).toFixed(6)}`;
export function subtitleCostLines(v: SubtitleCosts): string[] {
  return [`زیرنویس • Scribe v2: ${subtitleDollars(v.transcriptionNano)} • GPT-6 Luna: ${subtitleDollars(v.translationNano)}`,
    `جمع API زیرنویس: ${subtitleDollars(v.transcriptionNano + v.translationNano)} • درخواست‌ها: ${v.calls}`,
    ...(v.unknown ? [`⚠️ هزینهٔ ${v.unknown} درخواست نامشخص است؛ در جمع دلاری حساب نشده.`] : [])];
}
export function subtitleChoiceLabel(language: SubtitleLanguage | null | undefined): string {
  return language === undefined ? 'زیرنویس: در سابقهٔ قدیمی ثبت نشده'
    : language === null ? 'زیرنویس: غیرفعال' : `✅ زیرنویس: فعال • ${subtitleName(language)}`;
}
