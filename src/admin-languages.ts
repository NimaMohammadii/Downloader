import { isAdmin, getAdminUserDetail, formatAdminUserDetail, type AdminStatsEnv } from './admin';
import { BOT_LANGUAGES, LANGUAGE_LABELS, type LanguagePeriod, type LanguageSummary, type LanguageUsers } from './language-admin-store';

const PERIOD_LABELS: Record<LanguagePeriod, string> = { '4h': '۴ ساعت گذشته', '7d': '۷ روز گذشته', '30d': '۳۰ روز گذشته', all: 'کل کاربران' };
const escapeName = (value: string) => value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

export async function adminLanguagePanel(env: AdminStatsEnv, actorId: number, data: string): Promise<Record<string, unknown> | null> {
  if (!isAdmin(env, actorId)) return null;
  const overview = /^admin:languages(?::(4h|7d|30d|all))?$/.exec(data);
  const list = /^admin:langusers:(fa|en|ru):(4h|7d|30d|all):(\d{1,8})$/.exec(data);
  const detail = /^admin:languser:([1-9]\d{0,15}):(fa|en|ru):(4h|7d|30d|all):(\d{1,8}):(\d{1,8})$/.exec(data);
  if (!overview && !list && !detail) return null;
  const read = async <T>(path: string): Promise<T> => {
    const response = await env.ADMIN_STATS.getByName('global').fetch(`https://admin-stats${path}`);
    if (!response.ok) throw new Error(`ADMIN_LANGUAGES_${response.status}`);
    return response.json() as Promise<T>;
  };
  const periods = (selected: LanguagePeriod) => [
    (['4h', '7d'] as const).map(p => ({ text: `${selected === p ? '✅ ' : ''}${PERIOD_LABELS[p]}`, callback_data: `admin:languages:${p}` })),
    (['30d', 'all'] as const).map(p => ({ text: `${selected === p ? '✅ ' : ''}${PERIOD_LABELS[p]}`, callback_data: `admin:languages:${p}` })),
  ];
  if (overview) {
    const selected = (overview[1] || 'all') as LanguagePeriod;
    const summary = await read<LanguageSummary>('/language-stats');
    const lines = ['🌐 آمار کاربران زبان‌ها', '', 'افراد یکتا بر اساس زبان فعلی انتخاب‌شده در ربات.', 'بازه‌ها بر اساس آخرین فعالیت کاربر هستند؛ ماه یعنی ۳۰ روز گذشته.', 'کاربران بدون انتخاب زبان، فارسی پیش‌فرض حساب می‌شوند.', ''];
    for (const period of ['4h', '7d', '30d', 'all'] as const) {
      lines.push(PERIOD_LABELS[period]);
      const ranked = [...BOT_LANGUAGES].sort((a, b) => summary.periods[period][b] - summary.periods[period][a]);
      for (const language of ranked) lines.push(`${LANGUAGE_LABELS[language]}: ${summary.periods[period][language]} نفر`);
      lines.push(`جمع: ${BOT_LANGUAGES.reduce((sum, language) => sum + summary.periods[period][language], 0)} نفر`, '');
    }
    lines.push(`برای دیدن افراد، بازه را انتخاب کن و بعد زبان را بزن.\nبازهٔ فهرست: ${PERIOD_LABELS[selected]}`);
    const text = lines.join('\n');
    return { text, entities: [{ type: 'bold', offset: 0, length: lines[0].length }], reply_markup: { inline_keyboard: [
      ...periods(selected),
      ...BOT_LANGUAGES.map(language => [{ text: `${LANGUAGE_LABELS[language]} • ${summary.periods[selected][language]} نفر`, callback_data: `admin:langusers:${language}:${selected}:0` }]),
      [{ text: '🔄 بروزرسانی', callback_data: `admin:languages:${selected}` }],
      [{ text: 'بازگشت به پنل', callback_data: 'admin:stats' }],
    ] } };
  }
  if (list) {
    const language = list[1], period = list[2] as LanguagePeriod;
    const page = await read<LanguageUsers>(`/language-users?language=${language}&period=${period}&page=${list[3]}`);
    const title = `کاربران ${LANGUAGE_LABELS[page.language]} • ${PERIOD_LABELS[period]}`;
    const text = `${title}\n${page.totalUsers} نفر • صفحه ${page.page + 1}/${page.totalPages}\n\n` +
      (page.users.length ? page.users.map((user, index) => `${page.page * 8 + index + 1}. ${escapeName([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id)}${user.username ? ` • @${escapeName(user.username)}` : ''}\nشناسه: ${user.id}${user.selected ? '' : ' • فارسی پیش‌فرض؛ انتخاب نشده'}`).join('\n\n') : 'در این بازه کاربری نیست.');
    const callback = (p: number) => `admin:langusers:${language}:${period}:${p}`;
    const nav = [];
    if (page.page > 0) nav.push({ text: '‹ قبلی', callback_data: callback(page.page - 1) });
    if (page.page + 1 < page.totalPages) nav.push({ text: 'بعدی ›', callback_data: callback(page.page + 1) });
    return { text, entities: [{ type: 'bold', offset: 0, length: title.length }], link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [
      ...page.users.map(user => [{ text: `${escapeName([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || user.id).slice(0, 35)} • ${user.id}`, callback_data: `admin:languser:${user.id}:${language}:${period}:${page.page}:0` }]),
      ...(nav.length ? [nav] : []),
      [{ text: '🔄 بروزرسانی', callback_data: callback(page.page) }],
      [{ text: 'بازگشت به آمار زبان‌ها', callback_data: `admin:languages:${period}` }],
    ] } };
  }
  const [, id, language, period, usersPage, historyPage] = detail!;
  const user = await getAdminUserDetail(env, id, Number(historyPage));
  const back = `admin:langusers:${language}:${period}:${usersPage}`;
  if (!user) return { text: 'این کاربر پیدا نشد.', reply_markup: { inline_keyboard: [[{ text: 'بازگشت به فهرست', callback_data: back }]] } };
  const callback = (p: number) => `admin:languser:${id}:${language}:${period}:${usersPage}:${p}`;
  const nav = [];
  if (user.page > 0) nav.push({ text: '‹ جدیدتر', callback_data: callback(user.page - 1) });
  if (user.page + 1 < user.totalPages) nav.push({ text: 'قدیمی‌تر ›', callback_data: callback(user.page + 1) });
  return { text: formatAdminUserDetail(user), link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [
    ...(nav.length ? [nav] : []),
    [{ text: 'پنل کامل این کاربر', callback_data: `admin:user:${id}:0:0` }],
    [{ text: '🔄 بروزرسانی', callback_data: callback(user.page) }],
    [{ text: 'بازگشت به فهرست زبان', callback_data: back }],
  ] } };
}
