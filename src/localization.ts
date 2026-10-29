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
  const selection = /^lang:(fa|en|ru):([1-9]\d*)$/.exec(query?.data || '');
  if (!command && !selection) return null;
  if (!Number.isSafeInteger(userId) || userId <= 0 || !message?.chat?.id) return Response.json({ ok: true });
  const send = async (method: string, payload: object) => {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await response.json() as { ok?: boolean };
    if (!response.ok || !body.ok) throw new Error('LANGUAGE_TELEGRAM_UNAVAILABLE');
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
  const language = choice || await userLanguage(env, userId);
  if (query) await send('answerCallbackQuery', { callback_query_id: query.id });
  const text = choice ? { fa: '✅ زبانت فارسی شد!', en: '✅ All set! Let’s chat in English.', ru: '✅ Готово! Теперь общаемся по-русски.' }[language]
    : { fa: '🌐 زبان دلخواهت رو انتخاب کن:', en: '🌐 Pick your language:', ru: '🌐 Выбери язык:' }[language];
  await send('sendMessage', { chat_id: message.chat.id, text, entities: [{ type: 'bold', offset: 0, length: text.length }],
    reply_markup: { inline_keyboard: [[['fa', 'فارسی 🇮🇷'], ['en', 'English 🇬🇧'], ['ru', 'Русский 🇷🇺']].map(([code, label]) => ({ text: label, callback_data: `lang:${code}:${userId}` }))] } });
  return Response.json({ ok: true });
}
