import { presentationLocale } from "./localization";
import { LANGUAGE_LABELS } from "./language-admin-store";
import { isAdmin, getAdminUserDetail, formatAdminDownloadHistory, ADMIN_USERS_PAGE_SIZE, type AdminStatsEnv, type AdminSubtitleUsers } from './admin';
import { SUBTITLE_LOCK_EMOJI, type SubtitleAccess, type SubtitleButton } from './youtube-subtitles';

type Panel = { text: string; entities: { type: 'bold'; offset: number; length: number }[];
  reply_markup: { inline_keyboard: SubtitleButton[][] }; link_preview_options: { is_disabled: true } };
const ACTIVE = '5206607081334906820';
const clean = (text: string, limit = 70) => text.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, limit);
const date = (value: number) => new Intl.DateTimeFormat(presentationLocale(), {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tehran',
}).format(value);
const button = (text: string, callback_data: string, icon_custom_emoji_id?: string): SubtitleButton =>
  ({ text, callback_data, ...(icon_custom_emoji_id ? { icon_custom_emoji_id } : {}) });
function panel(title: string, lines: string[], rows: SubtitleButton[][]): Panel {
  const text = [title, '', ...lines].join('\n');
  const entities: Panel['entities'] = [{ type: 'bold', offset: 0, length: title.length }];
  let offset = title.length + 2;
  for (const line of lines) {
    if (/^(دسترسی سراسری:|دسترسی فعلی:|قفل اختصاصی این کاربر:|قفل سراسری:|دانلودهای زیرنویس‌دار •)/.test(line))
      entities.push({ type: 'bold', offset, length: line.length });
    offset += line.length + 1;
  }
  return { text, entities,
    reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } };
}
async function access(env: AdminStatsEnv, actorId: number, userId?: number, locked?: boolean): Promise<SubtitleAccess> {
  const response = await env.ADMIN_STATS.getByName('global').fetch('https://admin-stats/youtube-subtitle-access', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId, userId, locked }),
  });
  if (!response.ok) throw new Error(`SUBTITLE_ACCESS_${response.status}`);
  return response.json();
}
async function users(env: AdminStatsEnv, page: number): Promise<AdminSubtitleUsers> {
  const response = await env.ADMIN_STATS.getByName('global').fetch(`https://admin-stats/subtitle-users?page=${page}`);
  if (!response.ok) throw new Error(`SUBTITLE_USERS_${response.status}`);
  return response.json();
}

// Called only from the existing admin callback handler; also reject unauthorized callers here.
export async function adminSubtitlePanel(env: AdminStatsEnv, actorId: number, data: string): Promise<Panel | null> {
  if (!isAdmin(env, actorId)) return null;
  const home = /^admin:subtitles(?::(lock|unlock))?$/.exec(data);
  if (home) {
    const state = await access(env, actorId, undefined, home[1] ? home[1] === 'lock' : undefined);
    const summary = await users(env, 0);
    return panel('مدیریت زیرنویس یوتیوب', [
      `دسترسی سراسری: ${state.globalLocked ? 'قفل برای همه' : 'باز'}`, '',
      `کاربران دارای سابقهٔ زیرنویس: ${summary.totalUsers}`,
      `درخواست‌های زیرنویس: ${summary.requests}`,
      `درخواست‌های دارای فایل تحویل‌شده: ${summary.delivered}`,
      `درخواست‌های ناموفق: ${summary.failed}`, '',
      'قفل سراسری، شروع زیرنویس تازه را برای همه می‌بندد؛ دانلود معمولی در دسترس می‌ماند.',
      'دانلودهای شروع‌شده ادامه پیدا می‌کنند. زبان و تنظیمات ذخیره‌شده حفظ می‌شوند.',
      'قفل اختصاصی کاربران، مستقل از قفل سراسری است.',
    ], [
      [button(state.globalLocked ? 'بازکردن زیرنویس برای همه' : 'قفل زیرنویس برای همه',
        `admin:subtitles:${state.globalLocked ? 'unlock' : 'lock'}`, state.globalLocked ? ACTIVE : SUBTITLE_LOCK_EMOJI)],
      [button('کاربران و دانلودهای زیرنویس', 'admin:subusers:0', ACTIVE)],
      [button('بروزرسانی', 'admin:subtitles'), button('بازگشت به پنل', 'admin:stats')],
    ]);
  }
  const list = /^admin:subusers:(\d{1,8})$/.exec(data);
  if (list) {
    const page = await users(env, Number(list[1]));
    const rows = page.users.map(user => [button(`${clean(user.name, 32)} • ${user.delivered}/${user.requests}`,
      `admin:subuser:${user.id}:${page.page}:0`)]);
    const nav: SubtitleButton[] = [];
    if (page.page > 0) nav.push(button('‹ جدیدتر', `admin:subusers:${page.page - 1}`));
    if (page.page + 1 < page.totalPages) nav.push(button('قدیمی‌تر ›', `admin:subusers:${page.page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([button('بروزرسانی', `admin:subusers:${page.page}`), button('بازگشت', 'admin:subtitles')]);
    return panel('کاربران زیرنویس', [
      `کاربران: ${page.totalUsers} • صفحه ${page.page + 1}/${page.totalPages}`, '',
      ...(page.users.length ? page.users.flatMap((u, i) => [
        `${page.page * ADMIN_USERS_PAGE_SIZE + i + 1}. ${clean(u.name)}${u.username && !u.name.startsWith('@') ? ` • @${clean(u.username, 32)}` : ''}`,
        `شناسه: ${u.id} • درخواست: ${u.requests} • دارای تحویل: ${u.delivered}`,
        `آخرین درخواست: ${date(u.lastAt)}`, '',
      ]) : ['هنوز درخواست زیرنویس ثبت نشده است.', '']),
      'عدد روی دکمه: دارای تحویل / همهٔ درخواست‌ها.',
      'هر کاربر را برای دیدن دانلودها یا قفل اختصاصی انتخاب کن.',
      `فقط سوابق دارای زبان ثبت‌شده نمایش داده می‌شوند؛ شروع ثبت هزینه‌ها: ${date(page.trackingSince)}. ساعت‌ها: تهران.`,
    ], rows);
  }
  const target = /^admin:subuser:([1-9]\d{0,15}):(\d{1,8}):(\d{1,8})(?::(lock|unlock))?$/.exec(data);
  if (!target || !Number.isSafeInteger(Number(target[1]))) return null;
  const [id, usersPage, historyPage] = [target[1], Number(target[2]), Number(target[3])] as const;
  const detail = await getAdminUserDetail(env, id, historyPage, true);
  if (!detail) return panel('زیرنویس کاربر', ['این کاربر پیدا نشد.'], [[button('بازگشت', `admin:subusers:${usersPage}`)]]);
  const state = await access(env, actorId, Number(id), target[4] ? target[4] === 'lock' : undefined);
  const callback = (page: number) => `admin:subuser:${id}:${usersPage}:${page}`;
  const nav: SubtitleButton[] = [];
  if (detail.page > 0) nav.push(button('‹ جدیدتر', callback(detail.page - 1)));
  if (detail.page + 1 < detail.totalPages) nav.push(button('قدیمی‌تر ›', callback(detail.page + 1)));
  return panel('زیرنویس کاربر؛ دسترسی و دانلودها', [
    `کاربر: ${clean([detail.user.firstName, detail.user.lastName].filter(Boolean).join(' ') || detail.user.username || id)}`,
    `زبان ربات: ${LANGUAGE_LABELS[detail.language || "fa"]}${detail.languageSelected === false ? " (پیش‌فرض؛ انتخاب نشده)" : ""}`,
    `شناسه: ${id}`, ...(detail.user.username ? [`نام کاربری: @${clean(detail.user.username, 40)}`] : []), '',
    `دسترسی فعلی: ${state.locked ? 'قفل' : 'باز'}`,
    `قفل اختصاصی این کاربر: ${state.userLocked ? 'فعال' : 'ندارد'}`,
    `قفل سراسری: ${state.globalLocked ? 'فعال' : 'ندارد'}`,
    ...(state.globalLocked ? ['تا بازشدن قفل سراسری، دسترسی این کاربر هم بسته می‌ماند.'] : []), '',
    `درخواست‌های زیرنویس: ${detail.counts.total} • فایل‌های تحویل‌شده: ${detail.counts.delivered}`,
    `موفق: ${detail.counts.success} • ناموفق: ${detail.counts.failed} • ناقص: ${detail.counts.partial}`,
    `باز: ${detail.counts.active} • نتیجه نامشخص: ${detail.counts.stale}`, '',
    `دانلودهای زیرنویس‌دار • صفحه ${detail.page + 1}/${detail.totalPages}`,
    'هر مورد: زمان تهران، زبان، نتیجهٔ دانلود و هزینهٔ API ثبت‌شده.',
    ...formatAdminDownloadHistory(detail),
  ], [
    [button(state.userLocked ? 'رفع قفل اختصاصی کاربر' : 'قفل زیرنویس برای این کاربر',
      `${callback(detail.page)}:${state.userLocked ? 'unlock' : 'lock'}`, state.userLocked ? ACTIVE : SUBTITLE_LOCK_EMOJI)],
    ...(nav.length ? [nav] : []),
    [button('بروزرسانی', callback(detail.page)), button('پروفایل کامل کاربر', `admin:user:${id}:0:0`)],
    [button('بازگشت به کاربران زیرنویس', `admin:subusers:${usersPage}`), button('مدیریت زیرنویس', 'admin:subtitles')],
  ]);
}
