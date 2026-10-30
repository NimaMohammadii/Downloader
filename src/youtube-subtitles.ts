import languages from '../locales/subtitle-languages.json';

export type SubtitleLanguage = keyof typeof languages;
export const isSubtitleLanguage = (v: unknown): v is SubtitleLanguage => typeof v === 'string' && Object.hasOwn(languages, v);
export const subtitleName = (v: SubtitleLanguage): string => languages[v].name;
export type SubtitlePreference = { enabled: boolean; language?: SubtitleLanguage };
export type SubtitleMenu = {
  videoId: string; requestMessageId: number; userId: number; chatId: number; messageId: number;
  title?: string; qualities: number[]; audioAvailable: boolean;
  sizes?: Record<string, { bytes: number; estimated: boolean }>;
  preference: SubtitlePreference; createdAt: number; consumed?: boolean; locked?: boolean;
};
const ON = '5206607081334906820', OFF = '5210952531676504517';
export const SUBTITLE_LOCK_EMOJI = '5296369303661067030';
export const SUBTITLE_LOCK_NOTICE = '🔒 زیرنویس، کمی بعد\n\nدسترسی به زیرنویس فعلاً از طرف مدیریت بسته شده است.\nدانلود ویدیو بدون زیرنویس همچنان در دسترس توست.';
export type SubtitleAccess = { globalLocked: boolean; userLocked: boolean; locked: boolean };
export type SubtitleButton = { text: string; callback_data: string; icon_custom_emoji_id?: string };

export function subtitleButtons(menu: SubtitleMenu, picker = false): SubtitleButton[][] {
  const p = menu.preference;
  const suffix = `${menu.videoId}|${menu.requestMessageId}|${menu.userId}`;
  if (menu.locked) return [[{ text: 'زیرنویس: قفل', icon_custom_emoji_id: SUBTITLE_LOCK_EMOJI,
    callback_data: `ytst|${suffix}|1` }]];
  if (picker) {
    const buttons = Object.entries(languages).map(([code, l]) => ({
      text: l.name, callback_data: `ytsl|${suffix}|${code}`,
      ...(p.language === code ? { icon_custom_emoji_id: ON } : {}),
    }));
    const rows: SubtitleButton[][] = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    rows.push([{ text: 'غیرفعال کردن زیرنویس', icon_custom_emoji_id: OFF, callback_data: `ytst|${suffix}|0` }]);
    rows.push([{ text: 'بازگشت', callback_data: `ytsp|${suffix}|back` }]);
    return rows;
  }
  const row: SubtitleButton[] = [{ text: `زیرنویس: ${p.enabled ? 'فعال' : 'غیرفعال'}`,
    icon_custom_emoji_id: p.enabled ? ON : OFF, callback_data: `ytst|${suffix}|${p.enabled ? 0 : 1}` }];
  if (p.language) row.unshift({ text: subtitleName(p.language), callback_data: `ytsp|${suffix}|open` });
  return [row];
}

type Store = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'transaction'>;
const validId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const validChat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v !== 0;
const validPreference = (p: SubtitlePreference) => typeof p.enabled === 'boolean' &&
  (p.language === undefined || isSubtitleLanguage(p.language));

async function subtitleAccess(storage: Pick<Store, 'get'>, userId?: number): Promise<SubtitleAccess> {
  const globalLocked = await storage.get<boolean>('youtube-subtitle-lock:global') === true;
  const userLocked = userId !== undefined && await storage.get<boolean>(`youtube-subtitle-lock:user:${userId}`) === true;
  return { globalLocked, userLocked, locked: globalLocked || userLocked };
}

// Internal binding only; admin identity is checked again at the storage boundary.
export async function subtitleAccessSettings(request: Request, storage: Store, authorized: (id: number) => boolean): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.json().catch(() => null) as { actorId?: number; userId?: number; locked?: boolean } | null;
  if (!body || !validId(body.actorId) || !authorized(body.actorId)) return new Response('Forbidden', { status: 403 });
  if ((body.userId !== undefined && !validId(body.userId)) || (body.locked !== undefined && typeof body.locked !== 'boolean'))
    return new Response('Invalid access setting', { status: 400 });
  return storage.transaction(async s => {
    if (body.locked !== undefined) await s.put(body.userId === undefined ? 'youtube-subtitle-lock:global'
      : `youtube-subtitle-lock:user:${body.userId}`, body.locked);
    return Response.json(await subtitleAccess(s, body.userId));
  });
}

// Internal AdminStatsStore endpoint. Settings never change an in-flight job.
export async function subtitleSettings(request: Request, storage: Store): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.json().catch(() => null) as { op?: string; menu?: SubtitleMenu; userId?: number;
    chatId?: number; messageId?: number; videoId?: string; requestMessageId?: number;
    enabled?: boolean; language?: SubtitleLanguage; expected?: SubtitlePreference } | null;
  if (!body || !validId(body.userId) || !validChat(body.chatId) || !validId(body.messageId))
    return new Response('Invalid menu', { status: 400 });
  const userId = body.userId, chatId = body.chatId, messageId = body.messageId;
  const key = `youtube-subtitle-menu:${userId}:${chatId}:${messageId}`, prefKey = `youtube-subtitles:${userId}`;
  return storage.transaction(async s => {
    const access = await subtitleAccess(s, userId);
    const visible = (menu: SubtitleMenu): SubtitleMenu => ({ ...menu, locked: access.locked,
      preference: access.locked ? { ...menu.preference, enabled: false } : menu.preference });
    if (body.op === 'open') {
      const m = body.menu;
      if (!m || m.userId !== userId || m.chatId !== chatId || m.messageId !== messageId ||
          !/^[A-Za-z0-9_-]{11}$/.test(m.videoId) || !validId(m.requestMessageId) ||
          !Array.isArray(m.qualities) || !m.qualities.length || m.qualities.length > 4 ||
          !m.qualities.every(q => [360,480,720,1080].includes(q)) || typeof m.audioAvailable !== 'boolean')
        return new Response('Invalid menu', { status: 400 });
      const existing = await s.get<SubtitleMenu>(key);
      if (existing) return Response.json(visible(existing));
      const preference = await s.get<SubtitlePreference>(prefKey) || { enabled: false };
      const menu: SubtitleMenu = { ...m, preference: validPreference(preference) ? preference : { enabled: false }, createdAt: Date.now() };
      await s.put(key, menu);
      return Response.json(visible(menu));
    }
    const menu = await s.get<SubtitleMenu>(key);
    if (!menu || menu.videoId !== body.videoId || menu.requestMessageId !== body.requestMessageId ||
        Date.now() - menu.createdAt > 24 * 60 * 60 * 1000) {
      if (menu && Date.now() - menu.createdAt > 24 * 60 * 60 * 1000) await s.delete(key);
      return new Response('Expired menu', { status: 410 });
    }
    if (menu.consumed) return new Response('Download already started', { status: 409 });
    if (access.locked && (body.op === 'enable' || body.op === 'language' || body.op === 'take' && body.expected?.enabled))
      return new Response('Subtitles locked', { status: 423 });
    if (body.op === 'take') {
      const effective = visible(menu);
      if (body.expected && (body.expected.enabled !== effective.preference.enabled || body.expected.language !== effective.preference.language))
        return new Response('Menu changed', { status: 412 });
      if (effective.preference.enabled && !isSubtitleLanguage(effective.preference.language)) return new Response('Select language', { status: 422 });
      menu.consumed = true;
      await s.put(key, menu);
      return Response.json(visible(menu));
    }
    if (body.op === 'enable') {
      if (typeof body.enabled !== 'boolean') return new Response('Invalid state', { status: 400 });
      menu.preference.enabled = body.enabled;
    } else if (body.op === 'language') {
      if (!isSubtitleLanguage(body.language)) return new Response('Invalid language', { status: 400 });
      menu.preference = { enabled: true, language: body.language };
    } else if (body.op !== 'get') return new Response('Invalid operation', { status: 400 });
    if (body.op !== 'get') {
      await s.put(prefKey, menu.preference);
      await s.put(key, menu);
    }
    return Response.json(visible(menu));
  });
}
