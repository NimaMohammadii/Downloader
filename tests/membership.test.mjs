import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const bundle = await build({
  stdin: { contents: 'export {default as worker} from "./src/app-main"; export * from "./src/admin"; export * from "./src/membership";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'cloudflare-runtime', setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/containers)$/ }, a => ({ path: a.path, namespace: 'runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'runtime' }, a => ({ contents: a.path === 'cloudflare:workers'
      ? 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }'
      : 'export class Container {} export function getContainer(){throw Error("unexpected container startup");}' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const download = { key: 'trial', userId: 42, source: 'YouTube', request: 'https://youtube.com/watch?v=abcdefghijk', status: 'success', delivered: 1 };
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) {
    let rows = [], changes = 0;
    if (/^\s*SELECT/i.test(query)) rows = db.prepare(query).all(...params);
    else if (params.length) changes = Number(db.prepare(query).run(...params).changes);
    else db.exec(query);
    return { toArray: () => rows, one: () => rows[0], rowsWritten: changes };
  } };
  const ctx = { storage: { sql, transactionSync(fn) {
    db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  } } };
  let store = new api.AdminStatsStore(ctx, {});
  const calls = [], jobs = [], originalFetch = globalThis.fetch;
  let member = { status: 'left' }, unavailable = false;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'getChatMember') {
      assert.equal(body.chat_id, '@fixture_channel');
      if (unavailable) return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, result: member });
    }
    return Response.json({ ok: true, result: { message_id: 80 } });
  };
  const env = { BOT_TOKEN: 'fixture-token', WEBHOOK_SECRET: 'test-secret', MEMBERSHIP_CHANNEL: '@fixture_channel',
    ADMIN_STATS: { getByName() { return { fetch: (input, init) => store.fetch(new Request(input, init)) }; } },
    YOUTUBE_DOWNLOAD_WORKFLOW: { async create(job) { jobs.push(job); return { id: job.id }; } },
  };
  const request = (path, body) => store.fetch(new Request(`https://store${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
  const webhook = (text = '/start', user = 42, data, secret = 'test-secret') => new Request('https://worker/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(data ? { update_id: 8, callback_query: { id: 'check', data, from: { id: user }, message: { message_id: 70, chat: { id: user } } } }
      : { update_id: 7, message: { message_id: 7, from: { id: user }, chat: { id: user }, text } }),
  });
  return { db, env, calls, jobs, request, webhook,
    setMember(value) { member = value; }, setUnavailable(value) { unavailable = value; },
    restart() { store = new api.AdminStatsStore(ctx, {}); },
    close() { globalThis.fetch = originalFetch; db.close(); },
  };
}

test('only delivered media consumes the trial; settings and first-download state survive restart', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await api.membershipState(f.env, 42), { enabled: true, downloaded: false });
    for (const status of ['pending', 'failed', 'results']) {
      await f.request('/download', { ...download, key: status, status, delivered: 0 });
      assert.equal((await api.membershipState(f.env, 42)).downloaded, false);
    }
    const result = await (await f.request('/download', download)).json();
    assert.equal(result.firstDownload, true);
    assert.equal((await (await f.request('/download', download)).json()).firstDownload, false);
    await api.setMembershipEnabled(f.env, false);
    f.restart();
    assert.deepEqual(await api.membershipState(f.env, 42), { enabled: false, downloaded: true });
    await api.setMembershipEnabled(f.env, true);
    assert.equal((await api.membershipState(f.env, 42)).enabled, true);
    await f.request('/download', { ...download, key: 'partial', userId: 43, status: 'partial' });
    assert.equal((await api.membershipState(f.env, 43)).downloaded, true);
  } finally { f.close(); }
});

test('first successful download sends one compact bold gate with original custom emoji and two working buttons', async () => {
  const f = fixture();
  try {
    await api.recordDownload(f.env, download);
    await api.recordDownload(f.env, download);
    const prompts = f.calls.filter(c => c.method === 'sendMessage');
    assert.equal(prompts.length, 1);
    const body = prompts[0].body;
    assert.equal(body.chat_id, 42);
    assert.ok(body.text.length < 200);
    assert.ok(body.entities.some(e => e.type === 'bold'));
    assert.ok(body.entities.some(e => e.type === 'custom_emoji' && e.custom_emoji_id === '5210956306952758910'));
    const buttons = body.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 2);
    assert.ok(buttons.some(b => b.url === 'https://t.me/fixture_channel'));
    assert.ok(buttons.some(b => b.callback_data === 'membership:check'));
    // A member needs no extra prompt after their first download.
    f.setMember({ status: 'member' });
    await api.recordDownload(f.env, { ...download, key: 'other-user', userId: 43 });
    assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
  } finally { f.close(); }
});

test('production boundary gates every command, media update and old callback after trial without creating work', async () => {
  const f = fixture();
  try {
    assert.equal(await api.enforceMembership(f.webhook(), f.env), null);
    await f.request('/download', download);
    for (const text of ['/start', '/music Hello', '/live example', '/audio https://instagram.com/reel/abc/',
      'https://youtube.com/watch?v=abcdefghijk', 'https://instagram.com/reel/abc/', 'https://x.com/example/status/123', '']) {
      f.calls.length = 0;
      assert.equal((await api.worker.fetch(f.webhook(text), f.env, {})).status, 200);
      assert.ok(f.calls.some(c => c.method === 'getChatMember'));
      assert.equal(f.calls.filter(c => c.method === 'sendMessage').length, 1);
      assert.equal(f.jobs.length, 0);
    }
    for (const data of ['ytq|old', 'msc|old', 'iga|old', 'igs|old']) {
      f.calls.length = 0;
      assert.equal((await api.worker.fetch(f.webhook('', 42, data), f.env, {})).status, 200);
      assert.ok(f.calls.some(c => c.method === 'answerCallbackQuery'));
      assert.ok(f.calls.some(c => c.method === 'sendMessage'));
    }
  } finally { f.close(); }
});

test('joining unlocks, leaving locks again, and only real members pass the check button', async () => {
  const f = fixture();
  try {
    await f.request('/download', download);
    for (const member of [{status:'member'}, {status:'administrator'}, {status:'creator'}, {status:'restricted', is_member:true}]) {
      f.setMember(member);
      assert.equal(await api.enforceMembership(f.webhook(), f.env), null);
    }
    f.setMember({ status: 'left' });
    await api.enforceMembership(f.webhook('', 42, 'membership:check'), f.env);
    assert.match(f.calls.at(-1).body.text, /هنوز عضو/);
    f.setMember({ status: 'restricted', is_member: false });
    assert.ok(await api.enforceMembership(f.webhook(), f.env));
    f.setMember({ status: 'member' });
    await api.enforceMembership(f.webhook('', 42, 'membership:check'), f.env);
    assert.equal(f.calls.at(-1).method, 'editMessageText');
    assert.match(f.calls.at(-1).body.text, /دسترسی فعاله/);
    f.setMember({ status: 'kicked' });
    assert.ok(await api.enforceMembership(f.webhook(), f.env));
  } finally { f.close(); }
});

test('verification failures block work without falsely claiming the user is not a member', async () => {
  const f = fixture();
  try {
    await f.request('/download', download);
    f.setUnavailable(true);
    await api.worker.fetch(f.webhook('https://youtube.com/watch?v=abcdefghijk'), f.env, {});
    assert.equal(f.jobs.length, 0);
    assert.match(f.calls.at(-1).body.text, /بررسی عضویت فعلاً ممکن نیست/);
    assert.equal(f.calls.at(-1).body.reply_markup, undefined);
    f.calls.length = 0;
    assert.equal((await api.worker.fetch(f.webhook('/start', 42, undefined, 'forged'), f.env, {})).status, 403);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('admin can disable and reenable globally; non-admin callbacks cannot change settings', async () => {
  const f = fixture();
  try {
    await f.request('/download', download);
    assert.equal(await api.enforceMembership(f.webhook('/admin', api.ADMIN_USER_ID), f.env), null);
    for (const [action, enabled] of [['disable',false], ['enable',true]]) {
      // Non-admins cannot bypass either the gate or admin authorization.
      await api.worker.fetch(f.webhook('', 99, `admin:membership:${action}`), f.env, {});
      assert.equal((await api.membershipState(f.env)).enabled, !enabled);
      await api.worker.fetch(f.webhook('', api.ADMIN_USER_ID, `admin:membership:${action}`), f.env, {});
      assert.equal((await api.membershipState(f.env)).enabled, enabled);
      const edit = f.calls.filter(c => c.method === 'editMessageText').at(-1).body;
      assert.ok(edit.entities.some(e => e.type === 'bold'));
      assert.match(edit.text, enabled ? /وضعیت: فعال/ : /وضعیت: غیرفعال/);
      if (!enabled) {
        f.calls.length = 0;
        assert.equal(await api.enforceMembership(f.webhook(), f.env), null);
        assert.equal(f.calls.length, 0);
      }
    }
    assert.ok(api.adminDashboardKeyboard().inline_keyboard.flat().some(b => b.callback_data === 'admin:membership'));
  } finally { f.close(); }
});


test('legacy delivered downloads require membership and ignored records cannot consume another user trial', async () => {
  const f = fixture();
  try {
    // Simulate history from before membership was installed.
    await f.request('/download', { ...download, key: 'legacy' });
    f.db.exec('DELETE FROM membership_access');
    f.restart();
    assert.equal((await api.membershipState(f.env, 42)).downloaded, true);
    await f.request('/download', { ...download, key: 'legacy', userId: 99 });
    assert.equal((await api.membershipState(f.env, 99)).downloaded, false);
    await f.request('/download', { ...download, key: 'search-only', userId: 43, status: 'results', delivered: 0 });
    await f.request('/download', { ...download, key: 'search-only', userId: 43 });
    assert.equal((await api.membershipState(f.env, 43)).downloaded, false);
    assert.equal((await f.request('/membership', { enabled: 'false' })).status, 400);
    assert.equal((await api.membershipState(f.env)).enabled, true);
  } finally { f.close(); }
});

