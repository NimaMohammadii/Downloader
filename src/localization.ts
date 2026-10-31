import { startMessage } from "./start-message";
import { AsyncLocalStorage } from 'node:async_hooks';
import messages from '../locales/messages.json';

export type Language = 'fa' | 'en' | 'ru';
type LanguageEnv = { ADMIN_STATS?: { getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> } }; BOT_TOKEN?: string; WEBHOOK_SECRET?: string };
const context = new AsyncLocalStorage<{ language: Language; userId?: number }>();
export const isLanguage = (value: unknown): value is Language => value === 'fa' || value === 'en' || value === 'ru';
export async function userLanguage(env: LanguageEnv, userId?: number): Promise<Language> {
  if (!env.ADMIN_STATS || !Number.isSafeInteger(userId) || userId! <= 0) return 'fa';
  try {
    const response = await env.ADMIN_STATS.getByName('global').fetch(`https://admin-stats/language?user=${userId}`);
    if (!response.ok) return 'fa';
    const body = await response.json() as { language?: unknown };
    return isLanguage(body.language) ? body.language : 'fa';
  } catch { return 'fa'; } // A settings outage must not block an existing download.

}
export async function withUserLanguage<T>(env: LanguageEnv, userId: number | undefined, action: () => Promise<T>): Promise<T> {
  return context.run({ language: await userLanguage(env, userId), userId }, action);
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ordered = [...messages].filter(row => !row.fa.includes('{0}')).sort((a, b) => b.fa.length - a.fa.length);
const terms = new Set(['صدای ویدیوی', 'هایلایت', 'استوری', 'پست', 'فایل', 'روز', 'ساعت', 'دقیقه', 'ثانیه', ' و ']);
const literals = ordered.filter(row => !terms.has(row.fa));
const pattern = new RegExp(literals.map(row => escape(row.fa)).join('|'), 'gu');
const templates = messages.filter(row => row.fa.includes('{0}')).map(row => ({ row,
  pattern: new RegExp('^' + escape(row.fa).replace(/\\\{\d+\\\}/g, '(.+?)') + '$', 'u') }));
const translatedErrors = new Set(messages.filter(row => row.fa.startsWith('⚠️')).flatMap(row => [row.en, row.ru]));
export function isTranslatedErrorFrame(text: unknown): boolean { return typeof text === "string" && [...translatedErrors].some(value => value.startsWith(text)); }
export function isTranslatedError(text: unknown): boolean { return typeof text === 'string' && translatedErrors.has(text); }
export function translate(text: string, language: Language): string {
  if (language === 'fa') return text;
  const bySource = new Map(ordered.map(row => [row.fa, row[language]]));
  return text.split('\n').map(line => {
    for (const item of templates) {
      const match = item.pattern.exec(line);
      if (match) return item.row[language].replace(/\{(\d+)\}/g, (_, index) => {
        const value = match[Number(index) + 1];
        return bySource.get(value) || value;
      });
    }
    if (/^(?:زمان باقی‌مانده:|مدت محدودیت:|[۰-۹٠-٩0-9]+\s+(?:روز|ساعت|دقیقه|ثانیه))/.test(line)) {
      line = line.replace(/[۰-۹٠-٩]/g, digit => String(digit.charCodeAt(0) - (digit >= '۰' ? 1776 : 1632)))
        .replace(/روز|ساعت|دقیقه|ثانیه| و /g, value => bySource.get(value) || value);
    }
    return line;
  }).join('\n').replace(pattern, value => bySource.get(value)!);
}
export function localizePayload(payload: Record<string, unknown>, language = context.getStore()?.language || 'fa'): Record<string, unknown> {
  if (language === 'fa') return payload;
  const result = { ...payload };
  for (const [field, entityField] of [['text', 'entities'], ['caption', 'caption_entities']]) {
    const source = payload[field];
    if (typeof source !== 'string') continue;
    const text = translate(source, language);
    result[field] = text;
    if (text === source) continue;
    // Rebuild UTF-16 offsets after translation. Never reuse Persian offsets.
    const entities = Array.isArray(payload[entityField]) ? payload[entityField] as Record<string, unknown>[] : [];
    result[entityField] = entities.filter(e => e.type !== 'custom_emoji').flatMap(e => {
      const phrase = translate(source.slice(Number(e.offset), Number(e.offset) + Number(e.length)), language);
      const offset = text.indexOf(phrase);
      return offset < 0 ? [] : [{ ...e, offset, length: phrase.length }];
    });
    if (!entities.length && field === 'text' && text.includes('\n')) {
      const title = text.split('\n')[0];
      result[entityField] = [{ type: 'bold', offset: 0, length: title.length }];
    }
  }
  if (Array.isArray(payload.media)) result.media = payload.media.map(item => localizePayload(item as Record<string, unknown>, language));
  const markup = payload.reply_markup as Record<string, unknown> | undefined;
  if (markup && typeof markup === 'object') {
    result.reply_markup = { ...markup };
    for (const key of ['inline_keyboard', 'keyboard']) if (Array.isArray(markup[key])) {
      (result.reply_markup as Record<string, unknown>)[key] = (markup[key] as Record<string, unknown>[][]).map(row => row.map(button => ({ ...button,
        ...(typeof button.text === 'string' ? { text: translate(button.text, language) } : {}) })));
    }
  }
  return result;
}

export async function handleLanguageUpdate(request: Request, env: LanguageEnv): Promise<Response | null> {
  if (!env.BOT_TOKEN || request.method !== 'POST' || new URL(request.url).pathname !== '/telegram/webhook' ||
      request.headers.get('x-telegram-bot-api-secret-token') !== (env.WEBHOOK_SECRET || 'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1')) return null;
  const update = await request.clone().json().catch(() => null) as any;
  const query = update?.callback_query;
  const message = query?.message || update?.message;
  const userId = (query?.from || update?.message?.from)?.id;
  const command = /^\/lang(?:@[A-Za-z0-9_]+)?(?:\s+(fa|en|ru))?\s*$/i.exec(update?.message?.text || '');
  const startCommand = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test((update?.message?.text || '').trim());
  const selection = /^(?:lang|startlang):(fa|en|ru):([1-9]\d*)$/.exec(query?.data || '');
  if (!command && !selection && !startCommand) return null;
  if (!Number.isSafeInteger(userId) || userId <= 0 || !message?.chat?.id) return Response.json({ ok: true });
  const send = async (method: string, payload: object) => {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
    });
    const body = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };
    if (method === 'editMessageText' && /message is not modified/i.test(body.description || '')) return body.result;
    if (!response.ok || !body.ok) {
      if (method === 'editMessageText' && /message to edit not found|message can't be edited/i.test(body.description || '')) throw new Error('LANGUAGE_MENU_MISSING');
      throw new Error('LANGUAGE_TELEGRAM_UNAVAILABLE');
    }
    return body.result;
  };
  if (selection && Number(selection[2]) !== userId) {
    await send('answerCallbackQuery', { callback_query_id: query.id });
    return Response.json({ ok: true });
  }
  const choice = (selection?.[1] || command?.[1]?.toLowerCase()) as Language | undefined;
  if (choice) {
    if (!env.ADMIN_STATS) throw new Error('LANGUAGE_STORAGE_UNAVAILABLE');
    const response = await env.ADMIN_STATS.getByName('global').fetch(`https://admin-stats/language?user=${userId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: choice }),
    });
    if (!response.ok) throw new Error('LANGUAGE_SAVE_FAILED');
  }
  if (startCommand && env.ADMIN_STATS) {
    const { recordUserActivity } = await import('./admin');
    await recordUserActivity(env as import('./admin').AdminStatsEnv, {
      id: userId, username: message.from?.username, firstName: message.from?.first_name, lastName: message.from?.last_name,
    }, false, update.update_id, true);
  }
  const language = choice || await userLanguage(env, userId);
  if (query) await send('answerCallbackQuery', { callback_query_id: query.id });
  if (selection && query?.data?.startsWith('startlang:') && choice) {
    const { telegramCustomEmoji, telegramTextMotion } = await import('./admin');
    return context.run({ language: choice, userId }, async () => {
      const payload = localizePayload({ chat_id: message.chat.id, message_id: message.message_id,
        ...startMessage(), reply_markup: { inline_keyboard: [] } }, choice);
      // Replace the language picker itself, keeping the existing reveal and emoji formatting.
      await telegramTextMotion(env.BOT_TOKEN, 'editMessageText', payload, { animateEdits: true });
      await send('editMessageText', telegramCustomEmoji('editMessageText', payload));
      return Response.json({ ok: true });
    });
  }
  const text = choice ? { fa: '✅ زبانت فارسی شد!', en: '✅ All set! Let’s chat in English.', ru: '✅ Готово! Теперь общаемся по-русски.' }[language]
    : { fa: '🌐 زبان دلخواهت رو انتخاب کن:', en: '🌐 Pick your language:', ru: '🌐 Выбери язык:' }[language];
  const chatId = message.chat.id;
  const menuUrl = `https://admin-stats/language-menu?user=${userId}&chat=${chatId}`;
  const stub = env.ADMIN_STATS?.getByName('global');
  const saved = stub ? await stub.fetch(menuUrl) : null;
  const previous = saved?.ok ? await saved.json() as { messageId?: number } : {};
  const validMessageId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  const previousId = validMessageId(previous.messageId) ? previous.messageId : undefined;
  const callbackId = selection && validMessageId(query?.message?.message_id) ? query.message.message_id as number : undefined;
  const keyboard = { inline_keyboard: [[['fa', 'فارسی 🇮🇷'], ['en', 'English 🇬🇧'], ['ru', 'Русский 🇷🇺']].map(([code, label]) => ({
    text: label, callback_data: `${startCommand ? 'startlang' : 'lang'}:${code}:${userId}`,
    ...(code === language ? { icon_custom_emoji_id: '5352871660024246779' } : {}),
  }))] };
  // Telegram requires the text under a custom-emoji entity to match its sticker's emoji.
  const emojiId = choice ? '5352871660024246779' : '5282843764451195532';
  let emoji = choice ? '✅' : '🌐';
  try {
    const stickers = await send('getCustomEmojiStickers', { custom_emoji_ids: [emojiId] }) as unknown;
    if (Array.isArray(stickers)) {
      const sticker = stickers.find(item => item.custom_emoji_id === emojiId && typeof item.emoji === 'string');
      if (sticker?.emoji) emoji = sticker.emoji;
    }
  } catch { /* Metadata lookup must not prevent opening the menu. */ }
  const menuText = emoji + text.slice(choice ? '✅'.length : '🌐'.length);
  const chars = Array.from(new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(menuText), part => part.segment);
  const payload = (frame: string) => ({ chat_id: chatId, text: frame,
    entities: [
      ...(frame.length > emoji.length + 1 ? [{ type: 'bold', offset: emoji.length + 1, length: frame.length - emoji.length - 1 }] : []),
      { type: 'custom_emoji', offset: 0, length: emoji.length, custom_emoji_id: emojiId }],
    reply_markup: keyboard,
  });
  // Optional previews never decide whether the full menu is delivered.
  const draftId = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
  for (let frame = 0; frame < 2; frame++) {
    const prefix = chars.slice(0, Math.max(1, Math.ceil(chars.length * (frame + 1) / 3))).join('');
    try {
      if (callbackId) await send('editMessageText', { ...payload(prefix), message_id: callbackId });
      else await send('sendMessageDraft', { ...payload(prefix), draft_id: draftId });
      await new Promise(resolve => setTimeout(resolve, 120));
    } catch { break; }
  }
  let messageId = callbackId;
  if (messageId) {
    try { await send('editMessageText', { ...payload(menuText), message_id: messageId }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'LANGUAGE_MENU_MISSING') throw error;
      messageId = undefined;
    }
  }
  if (!messageId) {
    const result = await send('sendMessage', payload(menuText));
    if (!validMessageId(result?.message_id)) throw new Error('LANGUAGE_MENU_MESSAGE_ID_MISSING');
    messageId = result.message_id;
  }
  // A /lang command always presents a fresh, complete menu at the current chat position.
  // Only after delivery succeeds may the old language menu and command be removed.
  if (stub) {
    const response = await stub.fetch(menuUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }) });
    if (!response.ok) throw new Error('LANGUAGE_MENU_SAVE_FAILED');
  }
  const obsolete = new Set([previousId, callbackId].filter(id => id !== undefined && id !== messageId));
  for (const id of obsolete) {
    try { await send('deleteMessage', { chat_id: chatId, message_id: id }); } catch { /* Only known language menus are cleanup targets. */ }
  }
  if (command && chatId === userId && validMessageId(message.message_id)) {
    try { await send('deleteMessage', { chat_id: chatId, message_id: message.message_id }); } catch { /* Cosmetic cleanup is optional. */ }
  }
  return Response.json({ ok: true });
}
