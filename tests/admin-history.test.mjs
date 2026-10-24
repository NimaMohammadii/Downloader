import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: 'export {default as worker, YoutubeDownloadWorkflow} from "./src/app-main"; export * from "./src/admin";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'cloudflare-runtime', setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/containers)$/ }, a => ({ path: a.path, namespace: 'runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'runtime' }, a => ({ contents: a.path === 'cloudflare:workers'
      ? 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }'
      : 'export class Container {} export function getContainer(){throw Error("unexpected container startup");}' }));
  } }],
});
const admin = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const user = { id: 42, firstName: 'کاربر نمونه', username: 'example' };
const base = { key: 'youtube:42:7:42', userId: 42, source: 'YouTube', request: 'https://youtube.com/watch?v=abcdefghijk' };
const realNow = Date.now;

function fixture(legacy = false) {
  const db = new DatabaseSync(':memory:');
  if (legacy) db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT,
    links_sent INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    INSERT INTO users VALUES ('42','old','نام قدیمی',NULL,12,1000,2000);
    CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER NOT NULL DEFAULT 0);
    INSERT INTO counters VALUES ('successful_downloads',27);`);
  const sql = { exec(query, ...params) {
    let rows = [], changes = 0;
    if (/^\s*SELECT/i.test(query)) rows = db.prepare(query).all(...params);
    else if (params.length) changes = Number(db.prepare(query).run(...params).changes);
    else db.exec(query);
    return { toArray: () => rows, one: () => rows[0], rowsWritten: changes };
  } };
  const storage = { sql, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  let store = new admin.AdminStatsStore({ storage }, {});
  const request = (path, body) => store.fetch(new Request(`https://store${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
  const record = (eventId, values = {}) => request('/record', { user, eventId, linkSent: false, ...values });
  const detail = async (id = '42', page = 0) => (await request(`/user?id=${id}&page=${page}`)).json();
  const env = { BOT_TOKEN: 'fictional-token', WEBHOOK_SECRET: 'private-test-secret', ADMIN_STATS: { getByName() {
    return { fetch: (input, init) => store.fetch(new Request(input, init)) };
  } } };
  return { db, request, record, detail, env, restart() { store = new admin.AdminStatsStore({ storage }, {}); }, close() { Date.now = realNow; db.close(); } };
}

test('existing users and counters survive migration; historical visits remain explicitly unavailable', async () => {
  const f = fixture(true);
  try {
    const before = await f.detail();
    assert.equal(before.user.linksSent, 12);
    assert.equal(before.activity, null);
    assert.equal(before.counts.total, 0);
    assert.match(admin.formatAdminUserDetail(before), /در دسترس نیست/);
    assert.deepEqual(await (await f.request('/summary')).json(), { totalUsers: 1, linksSent: 12, successfulDownloads: 27, active24h: 0, active7d: 0, linkUsers24h: 0, linkUsers7d: 0, linksTrackingSince: Number(f.db.prepare("SELECT value FROM counters WHERE key = 'links_tracking_since'").get().value) });
    await f.record(1);
    const after = await f.detail();
    assert.equal(after.user.firstSeen, 1000);
    assert.equal(after.user.linksSent, 12);
    assert.equal(after.activity.visits, 1);
    assert.equal(after.activity.interactions, 1);
  } finally { f.close(); }
});

test('messages, callbacks, starts and 30-minute return visits count once across webhook redelivery', async () => {
  const f = fixture();
  try {
    let now = 1_800_000_000_000; Date.now = () => now;
    await f.record(1, { start: true });
    await f.record(1, { start: true });
    now += 1000;
    await f.record(2, { linkSent: true });
    now += admin.VISIT_IDLE_MS - 1;
    await f.record(3);
    now += admin.VISIT_IDLE_MS;
    await f.record(4, { start: true });
    const lastSeen = now;
    now += admin.VISIT_IDLE_MS;
    await f.record(4, { start: true });
    const d = await f.detail();
    assert.deepEqual(d.activity, { visits: 2, interactions: 4, starts: 2, trackingSince: 1_800_000_000_000 });
    assert.equal(d.user.lastSeen, lastSeen);
    assert.equal(d.user.linksSent, 1);
    assert.match(admin.formatAdminUserDetail(d), /برگشت‌ها: 1/);
  } finally { f.close(); }
});

test('one YouTube request moves from inspection to selection and delivery without replay regression or double counts', async () => {
  const f = fixture();
  try {
    await f.record(1);
    const track = (status, extra = {}) => f.request('/download', { ...base, status, ...extra });
    await track('pending');
    await track('awaiting_selection', { title: 'ویدیوی نمونه' });
    assert.equal((await f.detail()).downloads[0].status, 'awaiting_selection');
    await track('processing');
    await track('awaiting_selection');
    assert.equal((await f.detail()).downloads[0].status, 'processing');
    await track('success', { delivered: 1 });
    await track('processing'); await track('failed'); await track('success', { delivered: 1 });
    const d = await f.detail();
    assert.equal(d.counts.total, 1); assert.equal(d.counts.success, 1); assert.equal(d.counts.delivered, 1);
    assert.equal(d.downloads[0].title, 'ویدیوی نمونه');
    assert.equal(d.downloads[0].status, 'success');
    // A confirmed delivery also resolves a previous queue-creation failure.
    await f.request('/download', { ...base, key: 'queue-retry', status: 'failed' });
    await f.request('/download', { ...base, key: 'queue-retry', status: 'success', delivered: 1 });
    assert.equal((await f.detail()).counts.success, 2);
  } finally { f.close(); }
});

test('partial batches, failed downloads, search-only results and abandoned requests have distinct totals', async () => {
  const f = fixture();
  try {
    let now = 1_800_000_000_000; Date.now = () => now;
    await f.record(1);
    await f.request('/download', { ...base, key: 'old', status: 'processing' });
    now += 4 * 3600_000 + 1;
    for (const [key, status, delivered] of [['batch','partial',2],['bad','failed',0],['search','results',0],['new','processing',0]])
      await f.request('/download', { ...base, key, status, delivered });
    const d = await f.detail();
    assert.deepEqual(d.counts, { total: 5, success: 0, failed: 1, partial: 1, results: 1, active: 1, stale: 1, delivered: 2 });
    assert.equal(d.downloads.find(x => x.key === 'old').stale, true);
    assert.match(admin.formatAdminUserDetail(d), /نتیجه نهایی ثبت نشده/);
    await f.request('/download', { ...base, key: 'waiting-for-user', status: 'awaiting_selection' });
    now += 4 * 3600_000 + 1;
    const waiting = await f.detail();
    assert.equal(waiting.downloads.find(x => x.key === 'waiting-for-user').stale, false);
    assert.equal(waiting.counts.active, 1);
    await f.record(2, { user: { id: 99, firstName: 'کاربر دیگر' } });
    assert.equal((await f.detail('99')).downloads.length, 0);
  } finally { f.close(); }
});

test('user buttons and per-user download pagination remain bounded and isolated', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) await f.record(i, { user: { id: 42 + i, firstName: `نام ${i}` } });
    const page = await (await f.request('/users?page=0')).json();
    const buttons = admin.adminUsersKeyboard(page).inline_keyboard;
    assert.equal(page.users.length, 8);
    assert.equal(buttons.length, 9);
    assert.ok(buttons.slice(0, 8).every(row => /^admin:user:\d+:0:0$/.test(row[0].callback_data)));
    assert.ok(!admin.formatAdminUsers(page).includes('نام 0'));
    for (let i = 0; i < 13; i++) await f.request('/download', { ...base, key: `request-${String(i).padStart(2,'0')}`,
      source: 'س'.repeat(128), request: 'ل'.repeat(500), title: 'ع'.repeat(180), detail: 'خ'.repeat(240), status: 'failed' });
    const first = await f.detail(), second = await f.detail('42', 1), last = await f.detail('42', 1000000);
    assert.equal(first.totalPages, 3); assert.equal(first.downloads.length, 5);
    assert.equal(last.page, 2); assert.equal(last.downloads.length, 3);
    assert.ok(!first.downloads.some(x => second.downloads.some(y => x.key === y.key)));
    assert.ok(admin.formatAdminUserDetail(first).length < 4096);
    for (const row of admin.adminUserDetailKeyboard(second, 1).inline_keyboard)
      for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    assert.equal((await f.request('/user?id=missing')).status, 400);
    assert.equal((await f.request('/user?id=777')).status, 404);
  } finally { f.close(); }
});

test('usage list includes legacy links and non-link requests, excludes start-only users and counts each user once', async () => {
  const f = fixture(true);
  try {
    await f.record(1, { user: { id: 99 }, start: true });
    await f.record(2, { user: { id: 77, firstName: 'جست‌وجوی آهنگ' } });
    await f.record(3, { user: { id: 88 }, start: true });
    await f.record(4, { user: { id: 66 }, start: false });
    await f.request('/download', { ...base, key: 'music-search', userId: 77, source: 'Music', request: 'song name', status: 'results' });
    await f.request('/download', { ...base, key: 'music-download', userId: 77, source: 'Music', request: 'song name', status: 'success', delivered: 1 });
    await f.request('/download', { ...base, key: 'failed-shazam', userId: 88, source: 'Shazam', request: 'voice', status: 'failed' });
    const used = await admin.getAdminUsersPage(f.env, 0, true);
    assert.equal(used.usedOnly, true); assert.equal(used.totalUsers, 3);
    assert.deepEqual(used.users.map(u => u.id).sort(), ['42','77','88']);
    assert.equal(used.users.find(u => u.id === '42').linksSent, 12);
    assert.equal((await f.detail()).counts.total, 0);
    assert.equal((await admin.getAdminUsersPage(f.env, 0)).totalUsers, 5);
    assert.match(admin.formatAdminUsers(used), /کاربران استفاده‌کننده \(3\)/);
    assert.ok(admin.adminDashboardKeyboard().inline_keyboard.flat().some(b => b.callback_data === 'admin:used:0'));
  } finally { f.close(); }
});

test('usage pagination and detail navigation retain their filter without changing the ordinary user list', async () => {
  const f = fixture();
  try {
    const empty = await admin.getAdminUsersPage(f.env, 500, true);
    assert.equal(empty.page, 0); assert.equal(empty.totalPages, 1); assert.equal(empty.users.length, 0);
    assert.match(admin.formatAdminUsers(empty), /هنوز استفاده‌ای/);
    for (let i = 0; i < 13; i++) await f.record(i, { user: { id: 42 + i }, linkSent: i < 10 });
    const first = await admin.getAdminUsersPage(f.env, 0, true);
    const last = await admin.getAdminUsersPage(f.env, 500, true);
    assert.equal(first.totalUsers, 10); assert.equal(first.users.length, 8);
    assert.equal(last.page, 1); assert.equal(last.users.length, 2);
    assert.ok(!first.users.some(a => last.users.some(b => a.id === b.id)));
    const buttons = admin.adminUsersKeyboard(first).inline_keyboard.flat();
    assert.ok(buttons.some(b => b.callback_data === 'admin:used:1'));
    assert.ok(buttons.some(b => /^admin:user:\d+:0:0:used$/.test(b.callback_data)));
    const detail = await f.detail();
    assert.ok(admin.adminUserDetailKeyboard(detail, 1, true).inline_keyboard.flat().some(b => b.callback_data === 'admin:used:1'));
    const ordinary = await admin.getAdminUsersPage(f.env, 0);
    assert.equal(ordinary.totalUsers, 13); assert.equal(ordinary.usedOnly, undefined);
    assert.ok(admin.adminUsersKeyboard(ordinary).inline_keyboard.flat().some(b => b.callback_data === 'admin:users:1'));
  } finally { f.close(); }
});

test('production admin callbacks open the usage list and return to it; non-admins cannot access it', async () => {
  const f = fixture(); const calls = []; const previousFetch = globalThis.fetch;
  try {
    await f.record(1, { linkSent: true });
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 10 } });
    };
    const callback = (id, data) => ({ update_id: 2, callback_query: { id: 'panel', from: { id }, data,
      message: { message_id: 10, chat: { id } } } });
    await admin.worker.fetch(webhook(callback(99, 'admin:used:0')), f.env, {});
    assert.equal(calls.length, 0);
    await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID, 'admin:used:0')), f.env, {});
    let edit = calls.filter(c => c.url.endsWith('/editMessageText')).at(-1).body;
    assert.match(edit.text, /کاربران استفاده‌کننده \(1\)/);
    assert.ok(edit.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'admin:user:42:0:0:used'));
    await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID, 'admin:user:42:0:0:used')), f.env, {});
    edit = calls.filter(c => c.url.endsWith('/editMessageText')).at(-1).body;
    assert.match(edit.text, /شناسه: 42/);
    assert.ok(edit.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'admin:used:0'));
  } finally { globalThis.fetch = previousFetch; f.close(); }
});

test('production webhook still responds when the original request message has been deleted', async () => {
  const f=fixture(),sent=[],previousFetch=globalThis.fetch;
  try{
    globalThis.fetch=async(input,init)=>{
      const method=String(input).split('/').at(-1),body=JSON.parse(init.body);
      if(method==='sendMessage'){
        sent.push(body);
        if(body.reply_parameters?.message_id && !body.reply_parameters.allow_sending_without_reply)
          return Response.json({ok:false,description:'Bad Request: message to be replied not found'},{status:400});
      }
      return Response.json({ok:true,result:{message_id:10}});
    };
    const response=await admin.worker.fetch(webhook({update_id:3,message:{message_id:7,from:{id:42},chat:{id:42},text:'https://example.org/unsupported'}}),f.env,{});
    assert.equal(response.status,200);assert.equal(sent.length,1);
    assert.equal(sent[0].reply_parameters.message_id,7);
    assert.equal(sent[0].reply_parameters.allow_sending_without_reply,true);
  }finally{globalThis.fetch=previousFetch;f.close();}
});

const webhook = (update, secret = 'private-test-secret') => new Request('https://worker/telegram/webhook', {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update),
});

test('production entry counts delegated and callback interactions once and never records forged updates', async () => {
  const f = fixture();
  const calls = [];
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 10 } });
    };
    const start = { update_id: 10, message: { message_id: 1, from: { id: 42 }, chat: { id: 42 }, text: '/start' } };
    await admin.worker.fetch(webhook(start), f.env, {});
    await admin.worker.fetch(webhook(start), f.env, {});
    const callback = { update_id: 11, callback_query: { id: 'button', from: { id: 42 }, data: 'ytq|invalid', message: { message_id: 10, chat: { id: 42 } } } };
    await admin.worker.fetch(webhook(callback), f.env, {});
    await admin.worker.fetch(webhook({ ...start, update_id: 12 }), f.env, {});
    assert.equal((await f.detail()).activity.interactions, 3);
    const forged = await admin.worker.fetch(webhook({ ...start, update_id: 13 }, 'wrong'), f.env, {});
    assert.equal(forged.status, 403);
    assert.equal((await f.detail()).activity.interactions, 3);
  } finally { globalThis.fetch = previousFetch; f.close(); }
});

test('admin-only drill-down works through the production entry; other users cannot read history', async () => {
  const f = fixture();
  const calls = [];
  const previousFetch = globalThis.fetch;
  try {
    await f.record(1);
    await f.request('/download', { ...base, status: 'success', delivered: 1 });
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 10 } });
    };
    const callback = id => ({ update_id: 2, callback_query: { id: 'panel', from: { id },
      data: 'admin:user:42:0:0', message: { message_id: 10, chat: { id } } } });
    await admin.worker.fetch(webhook(callback(99)), f.env, {});
    assert.equal(calls.length, 0);
    await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID)), f.env, {});
    const edit = calls.filter(c => c.url.endsWith('/editMessageText')).at(-1).body;
    assert.match(edit.text, /شناسه: 42/); assert.match(edit.text, /موفق؛ فایل تحویل تلگرام شد/);
    assert.equal(edit.link_preview_options.is_disabled, true);
    assert.ok(edit.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'admin:users:0'));
    assert.equal((await f.detail()).activity.interactions, 1);
  } finally { globalThis.fetch = previousFetch; f.close(); }
});


test('rolling activity and link senders count distinct users with independent timestamps and exact boundaries', async () => {
  const f = fixture();
  try {
    const end = 1_800_000_000_000, day = 86400_000;
    const record = async (id, time, linkSent = false, eventId = id) => {
      Date.now = () => time;
      await f.record(eventId, { user: { id, firstName: `User ${id}` }, linkSent });
    };
    await record(40, end - 7 * day - 1, true);
    await record(41, end - 7 * day, true);
    await record(42, end - day, true);
    await record(43, end - day - 1, true);
    await record(44, end, false);
    await record(43, end, false, 100);
    // A duplicate link update must not move its original link timestamp.
    await record(42, end, true, 42);
    await record(45, end, true);
    await record(45, end, true, 101);
    // Non-link searches and download completion do not count as a new sent link.
    await f.request('/download', { ...base, userId: 44, status: 'results' });
    const summary = await (await f.request('/summary')).json();
    assert.equal(summary.active24h, 4);
    assert.equal(summary.active7d, 5);
    assert.equal(summary.linkUsers24h, 2);
    assert.equal(summary.linkUsers7d, 4);
    for (const [used, period, expected] of [
      [false, 'day', ['42','43','44','45']], [false, 'week', ['41','42','43','44','45']],
      [true, 'day', ['42','45']], [true, 'week', ['41','42','43','45']],
    ]) {
      const page = await admin.getAdminUsersPage(f.env, 0, used, period);
      assert.deepEqual(page.users.map(u => u.id).sort(), expected);
      assert.equal(page.totalUsers, expected.length);
      assert.equal(page.period, period);
    }
    const text = admin.formatAdminDashboard(summary);
    assert.match(text, /کاربران فعال در ۲۴ ساعت گذشته: 4/);
    assert.match(text, /ارسال‌کنندگان لینک در ۷ روز گذشته: 4/);
    // Rolling windows expire while lifetime counters remain unchanged.
    Date.now = () => end + 7 * day + 1;
    const expired = await (await f.request('/summary')).json();
    assert.equal(expired.active7d, 0); assert.equal(expired.linkUsers7d, 0);
    assert.equal(expired.totalUsers, 6);
  } finally { f.close(); }
});

test('period lists paginate and retain their filter throughout user detail navigation', async () => {
  const f = fixture(); const calls = [], previousFetch = globalThis.fetch;
  try {
    for (let i = 0; i < 10; i++) await f.record(i, { user: { id: 42 + i }, linkSent: true });
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 10 } });
    };
    const callback = (id, data) => ({ update_id: 20, callback_query: { id: 'period', from: { id }, data,
      message: { message_id: 10, chat: { id } } } });
    const edit = () => calls.filter(c => c.url.endsWith('/editMessageText')).at(-1).body;
    for (const kind of ['users', 'used']) for (const period of ['day','week']) {
      calls.length = 0;
      await admin.worker.fetch(webhook(callback(99, `admin:${kind}:0:${period}`)), f.env, {});
      assert.equal(calls.length, 0);
      await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID, `admin:${kind}:0:${period}`)), f.env, {});
      assert.ok(edit().reply_markup.inline_keyboard.flat().some(b => b.callback_data === `admin:${kind}:1:${period}`));
      await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID, `admin:${kind}:1:${period}`)), f.env, {});
      assert.match(edit().text, /صفحه 2\/2/);
      const button = edit().reply_markup.inline_keyboard[0][0];
      assert.ok(button.callback_data.endsWith(`${kind === 'used' ? ':used' : ''}:${period}`));
      await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID, button.callback_data)), f.env, {});
      assert.ok(edit().reply_markup.inline_keyboard.flat().some(b => b.callback_data === `admin:${kind}:1:${period}`));
    }
    const buttons = admin.adminDashboardKeyboard().inline_keyboard.flat();
    for (const kind of ['users','used']) for (const period of ['day','week'])
      assert.ok(buttons.some(b => b.callback_data === `admin:${kind}:0:${period}`));
  } finally { globalThis.fetch = previousFetch; f.close(); }
});

test('usage batches are durable, idempotent, isolated per user and split across rolling boundaries', async () => {
  const f = fixture(true);
  try {
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const hour = 3600000;
    const sample = { key: 'u:run:1:0', userId: 0, start: now - 25 * hour, end: now - 23 * hour,
      runtimeMs: 2 * hour, cpuSeconds: 100, ingressBytes: 2000000000, egressBytes: 1000000000 };
    const body = { samples: [sample, { ...sample, key: 'u:run:1:42', userId: 42, runtimeMs: hour, cpuSeconds: 50,
      ingressBytes: 1000000000, egressBytes: 500000000 }], deliveries: [
        { key: 'tg:1:42:7', userId: 42, at: now - hour, bytes: 500000000 },
        { key: 'tg:1:43:8', userId: 43, at: now - 25 * hour, bytes: null, cached: true },
        { key: 'tg:1:42:9', userId: 42, at: now - 8 * 24 * hour, bytes: 1000000 },
      ] };
    assert.equal((await f.request('/usage', body)).status, 200);
    assert.equal((await f.request('/usage', body)).status, 200);
    const usage = await admin.getAdminUsage(f.env);
    assert.equal(usage.all.downloads, 3);
    assert.equal(usage.all.bytes, 501000000);
    assert.equal(usage.all.unknownSizes, 1);
    assert.equal(usage.day.downloads, 1);
    assert.equal(usage.week.downloads, 2);
    assert.equal(usage.day.runtimeMs, hour);
    assert.equal(usage.day.cpuSeconds, 50);
    assert.equal(usage.day.egressBytes, 500000000);
    const user = await admin.getAdminUsage(f.env, '42');
    assert.equal(user.all.downloads, 2);
    assert.equal(user.all.unknownSizes, 0);
    assert.equal(user.day.runtimeMs, hour / 2);
    assert.equal((await f.detail()).usage.bytes, 501000000);
    assert.equal((await admin.getAdminSummary(f.env)).successfulDownloads, 27);
    const text = admin.formatAdminUsage(usage);
    assert.ok(text.length < 4096);
    assert.match(text, /ناخالص/);
    assert.match(text, /۲۴ ساعت/);
    assert.match(text, /۷ روز/);
    assert.match(text, /حجم نامشخص/);
  } finally { f.close(); }
});

test('invalid usage batches fail atomically, missing measurements remain unknown and delivery failures are harmless', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    const s = { key: 'u:run:0', userId: 0, start: now - 10000, end: now,
      runtimeMs: 10000, cpuSeconds: null, ingressBytes: null, egressBytes: null };
    assert.equal((await f.request('/usage', { samples: [s, { ...s, key: 'bad', runtimeMs: -1 }], deliveries: [] })).status, 400);
    assert.equal((await admin.getAdminUsage(f.env)).all.runtimeMs, 0);
    await admin.recordUsage(f.env, [s]);
    const usage = await admin.getAdminUsage(f.env);
    assert.equal(usage.all.cpuMeasuredMs, 0);
    assert.match(admin.formatAdminUsage(usage), /برآورد ناقص/);
    assert.equal((await f.request('/usage', { samples: [], deliveries: [{ key: 'd:1', userId: 42, at: now, bytes: -100 }] })).status, 400);
    await admin.recordMediaDelivery(f.env, 42, -123, { message_id: 77, video: { file_size: 1234 } });
    await admin.recordMediaDelivery(f.env, 42, -123, { message_id: 77, video: { file_size: 1234 } });
    await admin.recordMediaDelivery(f.env, 42, 42, { message_id: 78, photo: [{ file_size: 100 }, { file_size: 1000 }] });
    await admin.recordMediaDelivery(f.env, 42, 42, { message_id: 79 }, true, 55);
    await admin.recordMediaDelivery(f.env, 42, 42, { message_id: 80 });
    const total = (await admin.getAdminUsage(f.env, '42')).all;
    assert.equal(total.downloads, 4);
    assert.equal(total.bytes, 2289);
    assert.equal(total.unknownSizes, 1);
    assert.equal(total.cached, 1);
    const unavailable = { BOT_TOKEN: 'fake', ADMIN_STATS: { getByName() { throw Error('offline'); } } };
    await admin.recordMediaDelivery(unavailable, 42, 42, { message_id: 1 });
    assert.equal(await admin.recordUsage(unavailable), false);
  } finally { f.close(); }
});

test('production usage reports require admin access and preserve user-list navigation', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (input, init) => {
    messages.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: true });
  };
  try {
    const callback = (id, data) => new Request('https://worker/telegram/webhook', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': f.env.WEBHOOK_SECRET },
      body: JSON.stringify({ update_id: 101, callback_query: { id: 'usage', from: { id }, data,
        message: { message_id: 10, chat: { id } } } }) });
    await admin.worker.fetch(callback(99, 'admin:usage'), f.env, {});
    assert.equal(messages.length, 0);
    await admin.worker.fetch(callback(admin.ADMIN_USER_ID, 'admin:usage'), f.env, {});
    assert.ok(messages.at(-1).text.includes('مصرف، ترافیک'));
    await admin.worker.fetch(callback(admin.ADMIN_USER_ID, 'admin:usage:42:3:2:used:week'), f.env, {});
    assert.equal(messages.at(-1).reply_markup.inline_keyboard[1][0].callback_data, 'admin:user:42:3:2:used:week');
    const token = await crypto.subtle.importKey('raw', new TextEncoder().encode(f.env.BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', token, new TextEncoder().encode('usage:0')))].map(b => b.toString(16).padStart(2, '0')).join('');
    const request = secret => new Request('https://worker/container-usage/0', { method: 'POST',
      headers: { 'x-admin-usage-token': secret }, body: JSON.stringify({ samples: [], deliveries: [] }) });
    assert.equal((await admin.worker.fetch(request('forged'), f.env, {})).status, 403);
    assert.equal((await admin.worker.fetch(request(signature), f.env, {})).status, 200);
    assert.equal((await admin.worker.fetch(new Request('https://worker/container-usage/0', { method: 'POST',
      headers: { 'x-admin-usage-token': signature }, body: 'x'.repeat(200001) }), f.env, {})).status, 413);
  } finally { globalThis.fetch = originalFetch; f.close(); }
});

test('container lifetimes include idle and live runtime without duplicate starts or replay reopening a stopped run', async () => {
  const f = fixture();
  try {
    const now = Date.now(), hour = 3600000;
    Date.now = () => now;
    const run = { key: 'run:abc', start: now - 2 * hour, end: null };
    await admin.recordUsage(f.env, [], [], [run]);
    await admin.recordUsage(f.env, [], [], [run]);
    assert.equal((await admin.getAdminUsage(f.env)).all.runtimeMs, 2 * hour);
    await admin.recordUsage(f.env, [], [], [{ ...run, end: now - hour }]);
    await admin.recordUsage(f.env, [], [], [run]); // delayed start cannot reopen a run
    assert.equal((await admin.getAdminUsage(f.env)).all.runtimeMs, hour);
    const crossing = { key: 'run:previous', start: now - 25 * hour, end: now - 23 * hour };
    await admin.recordUsage(f.env, [], [], [crossing]);
    const usage = await admin.getAdminUsage(f.env);
    assert.equal(usage.day.runtimeMs, 2 * hour);
    assert.equal(usage.all.runtimeMs, 3 * hour);
    assert.equal((await admin.getAdminUsage(f.env, '42')).all.runtimeMs, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM container_runs').get().n, 2);
  } finally { f.close(); }
});

test('gross cost estimate uses actual CPU and standard-2 memory/disk rates with regional egress range', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    await admin.recordUsage(f.env, [{ key: 'u:cost:0', userId: 0, start: now - 3600000, end: now,
      runtimeMs: 3600000, cpuSeconds: 50, ingressBytes: 0, egressBytes: 1000000000 }]);
    // 6 GiB RAM + 12 GB disk for one hour = $0.057024; 50 CPU-s = $0.001;
    // 1 GB egress adds $0.025 to $0.05 before account-wide monthly credits.
    assert.match(admin.formatAdminUsage(await admin.getAdminUsage(f.env)), /\$0\.08302 تا \$0\.10802/);
  } finally { f.close(); }
});

test('API settings migrate the previous account and persist independent selections; both is atomic',async()=>{
  const f=fixture();
  try {
    // Simulate the old deployed selection before the new schema is initialized.
    f.db.prepare("UPDATE counters SET value=3 WHERE key='apify_account'").run();
    f.db.exec("DELETE FROM counters WHERE key LIKE 'ig_%'");f.restart();
    assert.deepEqual(await admin.instagramApiSettings(f.env),{posts:{provider:'apify',account:3},stories:{provider:'apify',account:3}});
    const env={...f.env,APIFY_API_TOKEN_4:'apify-four',BRIGHTDATA_API_KEY_2:'bright-two'};
    await admin.setInstagramApi(env,'posts',{provider:'brightdata',account:2});f.restart();
    assert.deepEqual(await admin.instagramApiSettings(env),{posts:{provider:'brightdata',account:2},stories:{provider:'apify',account:3}});
    await admin.setInstagramApi(env,'both',{provider:'apify',account:4});
    const state=await admin.instagramApiSettings(env);
    for(const payload of [{scope:'both',provider:'brightdata',account:2},{scope:'stories',provider:'brightdata',account:2},
      {scope:'posts',provider:'other',account:1},{scope:'invalid',provider:'apify',account:1},
      ...[0,5,-1,1.5,'3',null].map(account=>({scope:'posts',provider:'apify',account}))]){
      assert.equal((await f.request('/instagram-api',payload)).status,400);
      assert.deepEqual(await admin.instagramApiSettings(env),state);
    }
  } finally{f.close();}
});

test('both services map four Secrets, preserve legacy slot one and reject missing or unsupported selections',async()=>{
  const f=fixture();
  try {
    const env={...f.env,APIFY_API_TOKEN:'legacy-apify',BRIGHTDATA_API_KEY:'legacy-bright'};
    for(const provider of ['apify','brightdata']){
      const prefix=provider==='apify'?'APIFY_API_TOKEN':'BRIGHTDATA_API_KEY';
      assert.equal(admin.instagramApiToken(env,{provider,account:1}),provider==='apify'?'legacy-apify':'legacy-bright');
      for(const account of [1,2,3,4]){
        env[prefix+'_'+account]='private-'+provider+'-'+account;
        assert.equal(admin.instagramApiToken(env,{provider,account}),env[prefix+'_'+account]);
        await admin.setInstagramApi(env,'posts',{provider,account});
      }
      await assert.rejects(()=>admin.setInstagramApi({...env,[prefix+'_4']:''},'posts',{provider,account:4}),/SECRET_MISSING/);
    }
    await assert.rejects(()=>admin.setInstagramApi(env,'both',{provider:'brightdata',account:1}),/STORIES_UNSUPPORTED/);
    assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM counters').all()).includes('private-'));
    assert.ok(!JSON.stringify(await admin.instagramApiSettings(env)).includes('token'));
  }finally{f.close();}
});

test('admin panel exposes separate purposes and all eight post choices; only admin can change configured selections',async()=>{
  const f=fixture(),calls=[],previous=globalThis.fetch;
  const env={...f.env,APIFY_API_TOKEN:'legacy-apify',BRIGHTDATA_API_KEY_2:'private-bright-two'};
  const callback=(id,data)=>({update_id:800,callback_query:{id:'api-selection',from:{id},data,message:{message_id:20,chat:{id}}}});
  const visit=data=>admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID,data)),env,{});
  const panel=()=>calls.filter(c=>c.url.endsWith('/editMessageText')).at(-1).body;
  globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:20}});};
  try {
    await admin.worker.fetch(webhook(callback(99,'admin:igapi:posts:brightdata:2')),env,{});
    assert.equal(calls.length,0);assert.equal((await admin.instagramApiSettings(env)).posts.provider,'apify');
    await visit('admin:igapi');
    for(const scope of ['posts','stories','both'])assert.ok(panel().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:igapi:'+scope));
    await visit('admin:igapi:posts');
    for(const provider of ['apify','brightdata'])for(const account of [1,2,3,4])
      assert.ok(panel().reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`admin:igapi:posts:${provider}:${account}`));
    await visit('admin:igapi:posts:brightdata:2');
    assert.deepEqual((await admin.instagramApiSettings(env)).posts,{provider:'brightdata',account:2});
    await visit('admin:igapi:posts:brightdata:3');assert.match(panel().text,/تنظیم نشده/);
    assert.equal((await admin.instagramApiSettings(env)).posts.account,2);
    await visit('admin:igapi:both:brightdata:2');assert.match(panel().text,/استوری/);
    assert.deepEqual((await admin.instagramApiSettings(env)).stories,{provider:'apify',account:1});
    await visit('admin:igapi:both:apify:1');
    assert.equal((await admin.instagramApiSettings(env)).posts.provider,'apify');
    assert.ok(!JSON.stringify(calls).includes('private-bright-two'));assert.ok(!JSON.stringify(calls).includes('legacy-apify'));
    assert.ok(admin.adminDashboardKeyboard().inline_keyboard.flat().some(b=>b.callback_data==='admin:igapi'));
    // A removed active Secret does not block opening or repairing settings.
    await visit('admin:igapi:posts:brightdata:2');
    await admin.worker.fetch(webhook(callback(admin.ADMIN_USER_ID,'admin:igapi:posts:apify:1')),{...env,BRIGHTDATA_API_KEY_2:''},{});
    assert.equal((await admin.instagramApiSettings(env)).posts.provider,'apify');
  }finally{globalThis.fetch=previous;f.close();}
});

test('all 32 supported combinations pin separate post and Story choices without credentials in queues',async()=>{
  const f=fixture(),previous=globalThis.fetch,created=[];
  const env={...f.env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(value){created.push(value);}}};
  for(const account of [1,2,3,4]){env['APIFY_API_TOKEN_'+account]='private-apify-'+account;env['BRIGHTDATA_API_KEY_'+account]='private-bright-'+account;}
  globalThis.fetch=async()=>{throw Error('No external requests before the Workflow starts');};
  try {
    for(const provider of ['apify','brightdata'])for(const account of [1,2,3,4])for(const storyAccount of [1,2,3,4]){
      const posts={provider,account},stories={provider:'apify',account:storyAccount};
      await admin.setInstagramApi(env,'posts',posts);await admin.setInstagramApi(env,'stories',stories);
      for(const [text,selection] of [['https://instagram.com/reel/Abc123/',posts],['https://instagram.com/p/Abc123/',posts],
        ['https://instagram.com/stories/example/999/',stories],['https://instagram.com/stories/highlights/17950000000123456/',stories],['/instastory example',stories],['/instapost example',posts]]){
        const before=created.length;
        await admin.worker.fetch(webhook({update_id:900+before,message:{message_id:30+before,chat:{id:admin.ADMIN_USER_ID},from:{id:admin.ADMIN_USER_ID},text}}),env,{});
        assert.equal(created.length,before+1);assert.deepEqual(created.at(-1).params.instagramApi,selection);
      }
    }
    assert.deepEqual(created[0].params.instagramApi,{provider:'apify',account:1});
    assert.ok(!JSON.stringify(created).includes('private-'));
    // Selected slots remain pinned even if their Secret is removed before a new request.
    await admin.worker.fetch(webhook({update_id:2000,message:{message_id:2000,chat:{id:admin.ADMIN_USER_ID},from:{id:admin.ADMIN_USER_ID},text:'https://instagram.com/reel/Abc123/'}}),{...env,BRIGHTDATA_API_KEY_4:''},{});
    assert.deepEqual(created.at(-1).params.instagramApi,{provider:'brightdata',account:4});
  }finally{globalThis.fetch=previous;f.close();}
});

test('reselecting the same API is idempotent when Telegram reports an unchanged panel',async()=>{
  const f=fixture(),previous=globalThis.fetch;
  globalThis.fetch=async(input)=>String(input).endsWith('/editMessageText')
    ?Response.json({ok:false,description:'Bad Request: message is not modified'},{status:400}):Response.json({ok:true,result:true});
  try{
    const response=await admin.worker.fetch(webhook({update_id:1001,callback_query:{id:'again',from:{id:admin.ADMIN_USER_ID},
      data:'admin:igapi:both:apify:1',message:{message_id:20,chat:{id:admin.ADMIN_USER_ID}}}}),{...f.env,APIFY_API_TOKEN:'private-one'},{});
    assert.equal(response.status,200);assert.equal((await admin.instagramApiSettings(f.env)).posts.account,1);
  }finally{globalThis.fetch=previous;f.close();}
});

test('Bright Data counters persist per account, deduplicate concurrent events and reset at UTC month boundaries',async()=>{
 const f=fixture();
 try{
  Date.now=()=>Date.parse('2026-10-31T23:59:59Z');
  await Promise.all(Array.from({length:10},()=>admin.recordBrightDataExtraction(f.env,2,'igdl-42-1-42')));
  await admin.recordBrightDataExtraction(f.env,2,'igdl-42-2-42');
  await admin.recordBrightDataExtraction(f.env,3,'igdl-42-3-42');f.restart();
  let usage=await (await f.request('/instagram-api-usage')).json();
  assert.equal(usage.month,'2026-10');assert.deepEqual(usage.accounts.map(x=>x.used),[0,2,1,0]);
  Date.now=()=>Date.parse('2026-11-01T00:00:00Z');
  usage=await (await f.request('/instagram-api-usage')).json();assert.equal(usage.month,'2026-11');
  assert.deepEqual(usage.accounts.map(x=>x.used),[0,0,0,0]);
  await admin.recordBrightDataExtraction(f.env,2,'igdl-42-1-42'); // replay from last month
  await admin.recordBrightDataExtraction(f.env,2,'igdl-42-4-42');
  usage=await (await f.request('/instagram-api-usage')).json();assert.equal(usage.accounts[1].used,1);
  for(const payload of [{account:5,key:'valid'},{account:1,key:''},{account:2,key:'credential?bad'}])
    assert.equal((await f.request('/instagram-api-usage',payload)).status,400);
 }finally{f.close();}
});

test('eight-account budget reads real API fields, marks derived credit separately and preserves partial failures',async()=>{
 const f=fixture(),previous=globalThis.fetch,requests=[];
 const env={...f.env};for(const account of [1,2,3,4]){env['APIFY_API_TOKEN_'+account]='apify-secret-'+account;env['BRIGHTDATA_API_KEY_'+account]='bright-secret-'+account;}
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input),auth=new Headers(init.headers).get('authorization');requests.push({url,auth});
  assert.equal(init.redirect,'error');assert.ok(init.signal);assert.equal(init.method,undefined);
  if(url.hostname==='api.brightdata.com')return Response.json({balance:3,credit:999,prepayment:80,pending_costs:0.25});
  if(auth==='Bearer apify-secret-2')return Response.json({error:'secret should not be exposed'},{status:403});
  if(url.pathname.endsWith('/monthly'))return Response.json({data:{totalUsageCreditsUsdAfterVolumeDiscount:1.2345,usageCycle:{endAt:'2026-11-01T23:59:59.999Z'}}});
  return Response.json({data:{plan:auth==='Bearer apify-secret-3'?{}:{monthlyUsageCreditsUsd:5},proxy:{password:'private-proxy-password'}}});
 };
 try{
  await admin.recordBrightDataExtraction(f.env,2,'igdl-fixture');
  const text=await admin.instagramAccountBudget(env);
  assert.equal(requests.length,12);assert.match(text,/\$1\.2345/);assert.match(text,/\$3\.7655/);
  assert.match(text,/مصرف ثبت‌شده: 1 کردیت \| باقی تخمینی: 4999/);
  assert.match(text,/\$0\.0015/);assert.match(text,/موجودی دلاری: \$3\.0000/);
  assert.match(text,/اطلاعات دریافت نشد/);assert.match(text,/باقی اعتبار پلن: نامشخص/);
  assert.ok(!text.includes('$999'));assert.ok(!text.includes('password'));assert.ok(!text.includes('secret'));
  assert.ok(text.length<4096);
  for(const account of [1,2,3,4])assert.equal(requests.filter(x=>x.auth==='Bearer apify-secret-'+account).length,2);
  assert.equal((await admin.instagramApiSettings(env)).posts.account,1,'report never switches accounts');
 }finally{globalThis.fetch=previous;f.close();}
});

test('budget panel is admin-only, missing secrets make no paid/API requests and refresh leaves selections intact',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:20}});};
 const visit=id=>admin.worker.fetch(webhook({callback_query:{id:'budget',from:{id},data:'admin:igbudget',message:{message_id:20,chat:{id}}}}),f.env,{});
 try{
  await visit(99);assert.equal(calls.length,0);
  await visit(admin.ADMIN_USER_ID);
  const panel=calls.find(x=>x.url.endsWith('/editMessageText')).body;
  assert.equal((panel.text.match(/کلید تنظیم نشده/g)||[]).length,8);
  assert.ok(panel.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='admin:igbudget'));
  assert.ok(calls.every(x=>x.url.includes('api.telegram.org')));
 }finally{globalThis.fetch=previous;f.close();}
});

test('a Bright Data extraction is counted once for the pinned account across Workflow replay, even when Telegram fails',async()=>{
 const f=fixture(),previous=globalThis.fetch;let paid=0;
 const env={...f.env,BRIGHTDATA_API_KEY_2:'private-bright-two',APIFY_API_TOKEN:'other-account'};
 const job={id:'igdl-42-55-42',chatId:42,requestMessageId:55,userId:42,url:'https://instagram.com/reel/Abc123/',instagramPostRequest:{shortcode:'Abc123'},instagramApi:{provider:'brightdata',account:2}};
 const checkpoints=new Map();const step={async do(name,opts,fn){if(typeof opts==='function')fn=opts;if(checkpoints.has(name))return structuredClone(checkpoints.get(name));const value=await fn();checkpoints.set(name,structuredClone(value));return value;}};
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input);
  if(url.hostname==='api.brightdata.com'){paid++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-bright-two');return Response.json([{shortcode:'Abc123',video_url:'https://cdn.instagram.com/video.mp4'}]);}
  if(url.hostname==='cdn.instagram.com')return new Response(null,{headers:{'content-length':'1000000'}});
  if(url.hostname==='api.telegram.org')return url.pathname.endsWith('/sendVideo')?Response.json({ok:false,description:'Forbidden: cannot send video'},{status:403}):Response.json({ok:true,result:{message_id:33}});
  throw Error('Unexpected request');
 };
 try{
  await f.record(1);
  const replay=()=>new admin.YoutubeDownloadWorkflow({},env).run({payload:job},step);
  await replay();await replay();
  const usage=await (await f.request('/instagram-api-usage')).json();
  assert.equal(paid,1);assert.deepEqual(usage.accounts.map(x=>x.used),[0,1,0,0]);
 }finally{globalThis.fetch=previous;f.close();}
});
