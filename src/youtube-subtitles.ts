import languages from '../locales/subtitle-languages.json';

export type SubtitleLanguage = keyof typeof languages;
export const isSubtitleLanguage = (v: unknown): v is SubtitleLanguage => typeof v === 'string' && Object.hasOwn(languages, v);
export const subtitleName = (v: SubtitleLanguage): string => languages[v].name;
export type SubtitlePreference = { enabled: boolean; language?: SubtitleLanguage };
export type SubtitleMenu = {
  videoId: string; requestMessageId: number; userId: number; chatId: number; messageId: number;
  title?: string; qualities: number[]; audioAvailable: boolean;
  sizes?: Record<string, { bytes: number; estimated: boolean }>;
  preference: SubtitlePreference; createdAt: number; consumed?: boolean;
};
const ON = '5206607081334906820', OFF = '5210952531676504517';
export type SubtitleButton = { text: string; callback_data: string; icon_custom_emoji_id?: string };

export function subtitleButtons(menu: SubtitleMenu, picker = false): SubtitleButton[][] {
  const p = menu.preference;
  const suffix = `${menu.videoId}|${menu.requestMessageId}|${menu.userId}`;
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
  if (p.language) row.push({ text: subtitleName(p.language), callback_data: `ytsp|${suffix}|open` });
  return [row];
}

type Store = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'transaction'>;
const validId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const validChat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v !== 0;
const validPreference = (p: SubtitlePreference) => typeof p.enabled === 'boolean' &&
  (p.language === undefined || isSubtitleLanguage(p.language));

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
    if (body.op === 'open') {
      const m = body.menu;
      if (!m || m.userId !== userId || m.chatId !== chatId || m.messageId !== messageId ||
          !/^[A-Za-z0-9_-]{11}$/.test(m.videoId) || !validId(m.requestMessageId) ||
          !Array.isArray(m.qualities) || !m.qualities.length || m.qualities.length > 4 ||
          !m.qualities.every(q => [360,480,720,1080].includes(q)) || typeof m.audioAvailable !== 'boolean')
        return new Response('Invalid menu', { status: 400 });
      const existing = await s.get<SubtitleMenu>(key);
      if (existing) return Response.json(existing);
      const preference = await s.get<SubtitlePreference>(prefKey) || { enabled: false };
      const menu: SubtitleMenu = { ...m, preference: validPreference(preference) ? preference : { enabled: false }, createdAt: Date.now() };
      await s.put(key, menu);
      return Response.json(menu);
    }
    const menu = await s.get<SubtitleMenu>(key);
    if (!menu || menu.videoId !== body.videoId || menu.requestMessageId !== body.requestMessageId ||
        Date.now() - menu.createdAt > 24 * 60 * 60 * 1000) {
      if (menu && Date.now() - menu.createdAt > 24 * 60 * 60 * 1000) await s.delete(key);
      return new Response('Expired menu', { status: 410 });
    }
    if (menu.consumed) return new Response('Download already started', { status: 409 });
    if (body.op === 'take') {
      if (body.expected && (body.expected.enabled !== menu.preference.enabled || body.expected.language !== menu.preference.language))
        return new Response('Menu changed', { status: 412 });
      if (menu.preference.enabled && !isSubtitleLanguage(menu.preference.language)) return new Response('Select language', { status: 422 });
      menu.consumed = true;
      await s.put(key, menu);
      return Response.json(menu);
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
    return Response.json(menu);
  });
}
