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
test('additional administrators bypass channel membership without exposing controls to regular users',async()=>{
  const f=fixture();
  try{
    f.env.ADMIN_IDS='123456789';
    await api.setMembershipMode(f.env,'start');
    assert.equal(await api.enforceMembership(f.webhook('/admin',123456789),f.env),null);
    await api.notifyFirstDownload(f.env,123456789);
    assert.equal(f.calls.length,0);
    assert.ok(await api.enforceMembership(f.webhook('/admin',42),f.env) instanceof Response);
    assert.ok(f.calls.some(c=>c.method==='getChatMember'));
  }finally{f.close();}
});
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
  let member = { status: 'left' }, unavailable = false, failure = {}, editUnchanged = false;
  globalThis.fetch = async (input, init) => {
    const method = String(input).split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === 'getChatMember') {
      assert.equal(body.chat_id, env.MEMBERSHIP_CHANNEL || api.MEMBERSHIP_CHANNEL);
      if (unavailable) return Response.json({ ok: false, ...failure }, { status: 403 });
      return Response.json({ ok: true, result: member });
    }
    if (method === 'editMessageText' && editUnchanged) return Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, {status:400});
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
    setMember(value) { member = value; }, setUnavailable(value, details = {}) { unavailable = value; failure = details; },
    setEditUnchanged(value) { editUnchanged = value; },
    restart() { store = new api.AdminStatsStore(ctx, {}); },
    close() { globalThis.fetch = originalFetch; db.close(); },
  };
}

test('only delivered media consumes the trial; settings and first-download state survive restart', async () => {
  const f = fixture();
  try {
    assert.deepEqual(await api.membershipState(f.env, 42), { enabled: true, downloaded: false, mode: "after_download", linkTriggered: false });
    for (const status of ['pending', 'failed', 'results']) {
      await f.request('/download', { ...download, key: status, status, delivered: 0 });
      assert.equal((await api.membershipState(f.env, 42)).downloaded, false);
    }
    const result = await (await f.request('/download', download)).json();
    assert.equal(result.firstDownload, true);
    assert.equal((await (await f.request('/download', download)).json()).firstDownload, false);
    await api.setMembershipEnabled(f.env, false);
    f.restart();
    assert.deepEqual(await api.membershipState(f.env, 42), { enabled: false, downloaded: true, mode: "after_download", linkTriggered: false });
    await api.setMembershipEnabled(f.env, true);
    assert.equal((await api.membershipState(f.env, 42)).enabled, true);
    await f.request('/download', { ...download, key: 'partial', userId: 43, status: 'partial' });
    assert.equal((await api.membershipState(f.env, 43)).downloaded, true);
  } finally { f.close(); }
});

test('first successful download sends one compact bold gate with original custom emoji and channel, Instagram and verification buttons', async () => {
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
    assert.equal(buttons.length, 3);
    assert.ok(buttons.some(b => b.url === 'https://www.instagram.com/vexa.order/'));
    assert.doesNotMatch(body.text, /@Vexa\.Order/);
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
    assert.match(f.calls.filter(c => c.method === 'answerCallbackQuery').at(-1).body.text, /هنوز عضو/);
    f.setMember({ status: 'restricted', is_member: false });
    assert.ok(await api.enforceMembership(f.webhook(), f.env));
    f.setMember({ status: 'member' });
    await api.enforceMembership(f.webhook('', 42, 'membership:check'), f.env);
    assert.equal(f.calls.at(-1).method, 'deleteMessage');
    const confirmation = f.calls.filter(c => c.method === 'sendMessage').at(-1).body;
    assert.ok(confirmation.entities.some(e => e.custom_emoji_id === '5400130177319580649'));
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
    assert.ok(!f.calls.some(c => c.body.chat_id === 7138547731), "user errors must not notify the admin");
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



test('corrected default channel is used for real checks and old private prompt buttons are refreshed', async () => {
  const f = fixture();
  try {
    delete f.env.MEMBERSHIP_CHANNEL;
    await f.request('/download', download);
    await api.worker.fetch(f.webhook('', 42, 'membership:check'), f.env, {});
    const check = f.calls.find(c => c.method === 'getChatMember');
    assert.equal(check.body.chat_id, '@VexaOrder');
    const updated = f.calls.find(c => c.method === 'editMessageText').body;
    assert.equal(updated.message_id, 70);
    assert.ok(updated.reply_markup.inline_keyboard.flat().some(b => b.url === 'https://t.me/VexaOrder'));
    // A duplicate callback still acknowledges the update when its message is already identical.
    f.setEditUnchanged(true);
    assert.equal((await api.worker.fetch(f.webhook('', 42, 'membership:check'), f.env, {})).status, 200);
    f.calls.length = 0;
    f.setMember({ status: 'member' });
    await api.worker.fetch(f.webhook('', 42, 'membership:check'), f.env, {});
    assert.match(f.calls.find(c => c.method === 'answerCallbackQuery').body.text, /دسترسی فعاله/);
    assert.equal(await api.enforceMembership(f.webhook('/start'), f.env), null);
  } finally { f.close(); }
});

test('channel lookup and missing admin rights have distinct safe diagnostics without granting access', async () => {
  const f = fixture(), warnings = [], warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await f.request('/download', download);
    for (const [description, reason] of [
      ['Bad Request: chat not found', 'channel_not_found'],
      ['Bad Request: member list is inaccessible', 'bot_channel_access'],
      ['Forbidden: bot is not a member of the channel chat', 'bot_channel_access'],
    ]) {
      f.setUnavailable(true, { error_code: 400, description });
      assert.equal((await api.worker.fetch(f.webhook('https://youtube.com/watch?v=abcdefghijk'), f.env, {})).status, 200);
      assert.equal(f.jobs.length, 0);
      assert.equal(warnings.at(-1)[1].reason, reason);
      assert.ok(!JSON.stringify(warnings).includes(f.env.BOT_TOKEN));
    }
  } finally { console.warn = warn; f.close(); }
});


test('member confirmation deletes the prompt, sends the requested emoji and removes it after exactly four seconds', async t => {
  const f = fixture(), pending = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await f.request('/download', download);
    f.setMember({ status: 'member' });
    const response = await api.enforceMembership(f.webhook('', 42, 'membership:check'), f.env,
      { waitUntil(promise) { pending.push(promise); } });
    assert.equal(response.status, 200);
    assert.equal(pending.length, 1);
    const sent = f.calls.filter(c => ['deleteMessage','sendMessage'].includes(c.method));
    assert.deepEqual(sent.map(c => c.method), ['deleteMessage','sendMessage']);
    assert.equal(sent[0].body.message_id, 70);
    const confirmation = sent[1].body;
    assert.equal(confirmation.chat_id, 42);
    assert.deepEqual(confirmation.entities, [{ type:'custom_emoji', offset:0, length:1, custom_emoji_id:'5400130177319580649' }]);
    assert.ok(!f.calls.some(c => c.method === 'editMessageText'));
    t.mock.timers.tick(3999);
    await Promise.resolve();
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 1);
    t.mock.timers.tick(1);
    await Promise.all(pending);
    assert.equal(f.calls.at(-1).method, 'deleteMessage');
    assert.equal(f.calls.at(-1).body.message_id, 80);
  } finally { t.mock.timers.reset(); f.close(); }
});

test('membership prompt uses channel wording and the explicit join-button icon', () => {
  const prompt = api.membershipPrompt();
  assert.ok(!prompt.text.includes('کانال'));
  const join = prompt.reply_markup.inline_keyboard.flat().find(button => button.url);
  assert.equal(join.text, 'ورود به چنل');
  assert.equal(join.icon_custom_emoji_id, '5260285114448891086');
});

test('panel text motion progressively reveals edits without splitting graphemes or bold entities', async () => {
  const calls = [], pauses = [], previousFetch = globalThis.fetch, previousTimeout = globalThis.setTimeout;
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ method:String(input).split('/').at(-1), body:JSON.parse(init.body) });
      return Response.json({ ok:true, result:true });
    };
    globalThis.setTimeout = (callback, delay) => { pauses.push(delay); return previousTimeout(callback, 0); };
    const text = '⚡️ عضویت اجباری چنل\n\nوضعیت: فعال ✅\nادامهٔ استفاده پس از دانلود اول نیازمند عضویت در چنل است.';
    const payload = { chat_id:7138547731, message_id:70, text, entities:[{type:'bold',offset:0,length:text.length}],
      reply_markup: { inline_keyboard:[] } };
    await api.telegramTextMotion('panel-motion-test', 'editMessageText', payload, { animateEdits:true });
    assert.equal(calls.length, 3);
    assert.deepEqual(pauses, [450,450,450]);
    const boundaries = new Set(Array.from(new Intl.Segmenter('fa',{granularity:'grapheme'}).segment(text), s => s.index + s.segment.length));
    for (const [index, frame] of calls.entries()) {
      assert.equal(frame.method, 'editMessageText');
      assert.equal(frame.body.message_id, 70);
      assert.ok(text.startsWith(frame.body.text));
      assert.ok(boundaries.has(frame.body.text.length));
      assert.ok(frame.body.entities.every(e => e.offset + e.length <= frame.body.text.length));
      if (index) assert.ok(frame.body.text.length > calls[index-1].body.text.length);
    }
    assert.ok(calls.at(-1).body.text.length < text.length);
  } finally { globalThis.fetch = previousFetch; globalThis.setTimeout = previousTimeout; }
});


test('start mode gates the first start and prevents bypass by sending a direct link', async()=>{
  const f=fixture();
  try {
    await api.setMembershipMode(f.env,'start');
    for(const text of ['/start','https://youtube.com/watch?v=abcdefghijk']) {
      f.calls.length=0;
      assert.ok(await api.enforceMembership(f.webhook(text),f.env));
      assert.ok(f.calls.some(c=>c.method==='getChatMember'));
      assert.ok(f.calls.some(c=>c.body.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='membership:check')));
    }
    assert.equal(f.jobs.length,0);
    f.setMember({status:'member'});
    assert.equal(await api.enforceMembership(f.webhook('/start'),f.env),null);
    f.setMember({status:'left'});
    assert.ok(await api.enforceMembership(f.webhook('/start'),f.env));
    assert.equal(await api.enforceMembership(f.webhook('/start',7138547731),f.env),null);
  } finally {f.close();}
});

test('first-link mode leaves start/help open, gates the first link, and remains durable after restart',async()=>{
  const f=fixture();
  try {
    await api.setMembershipMode(f.env,'first_link');
    assert.equal(await api.enforceMembership(f.webhook('/start'),f.env),null);
    assert.equal(await api.enforceMembership(f.webhook('سلام'),f.env),null);
    assert.equal((await api.membershipState(f.env,42)).linkTriggered,false);
    assert.ok(await api.enforceMembership(f.webhook('https://instagram.com/reel/example/'),f.env));
    assert.equal((await api.membershipState(f.env,42)).linkTriggered,true);
    f.restart();
    assert.equal((await api.membershipState(f.env,42)).mode,'first_link');
    assert.ok(await api.enforceMembership(f.webhook('/start'),f.env));
    f.setMember({status:'member'});
    assert.equal(await api.enforceMembership(f.webhook('https://youtu.be/abcdefghijk'),f.env),null);
    f.setMember({status:'left'});
    assert.ok(await api.enforceMembership(f.webhook('https://youtu.be/abcdefghijk'),f.env));
    await api.setMembershipEnabled(f.env,false);
    assert.equal(await api.enforceMembership(f.webhook('/start'),f.env),null);
    assert.equal((await api.membershipState(f.env,42)).mode,'first_link');
    await api.setMembershipEnabled(f.env,true);
    assert.ok(await api.enforceMembership(f.webhook('/start'),f.env));
  } finally {f.close();}
});

test('first-link mode gates old download callbacks and link requests across supported services',async()=>{
  const f=fixture();
  try {
    await api.setMembershipMode(f.env,'first_link');
    for(const [i,text] of ['https://x.com/user/status/123','/music Hello','https://pin.it/example','https://aparat.com/v/test'].entries())
      assert.ok(await api.enforceMembership(f.webhook(text,100+i),f.env));
    for (const [i,data] of ['ytq|old','soa|old','igm|old'].entries())
      assert.ok(await api.enforceMembership(f.webhook('',200+i,data),f.env));
    assert.equal(await api.enforceMembership(f.webhook('https://unrelated.example',301),f.env),null);
    assert.equal((await api.membershipState(f.env,301)).linkTriggered,false);
  } finally {f.close();}
});

test('mode selection is admin-only, persists independently of enablement, and rejects invalid settings',async()=>{
  const f=fixture();
  try {
    await api.worker.fetch(f.webhook('',42,'admin:membership:start'),f.env,{});
    assert.equal((await api.membershipState(f.env)).mode,'after_download');
    for(const mode of ['start','first_link','after_download']) {
      await api.worker.fetch(f.webhook('',7138547731,`admin:membership:${mode}`),f.env,{});
      assert.equal((await api.membershipState(f.env)).mode,mode);
      const panel=f.calls.filter(c=>c.method==='editMessageText').at(-1).body;
      const choices=panel.reply_markup.inline_keyboard.flat().filter(b=>/admin:membership:(start|first_link|after_download)$/.test(b.callback_data||''));
      assert.equal(choices.length,3);
      assert.equal(choices.find(b=>b.callback_data===`admin:membership:${mode}`).icon_custom_emoji_id,'5352871660024246779');
    }
    const before=await api.membershipState(f.env);
    for(const body of [{mode:'bad'},{enabled:false,mode:'bad'},{triggerLink:true,userId:-1}])
      assert.equal((await f.request('/membership',body)).status,400);
    assert.deepEqual(await api.membershipState(f.env),before);
    await api.setMembershipMode(f.env,'start');
    await api.recordDownload(f.env,download);
    assert.ok(!f.calls.some(c=>c.method==='sendMessage' && c.body.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='membership:check')));
  } finally {f.close();}
});

async function gateRequest(f, text = '/start', user = 42, updateId = 700) {
  const body = { update_id: updateId, message: { message_id: updateId, from: { id: user }, chat: { id: user }, text } };
  const request = new Request('https://worker/telegram/webhook', { method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'test-secret'},body:JSON.stringify(body) });
  await api.worker.fetch(request, f.env, {});
  return body;
}

test('a blocked start resumes through production only after the confirmation emoji is deleted', async t=>{
  const f=fixture(), tasks=[];
  try {
    await api.setMembershipMode(f.env,'start');
    await gateRequest(f);
    f.restart();
    f.setMember({status:'member'});
    f.calls.length=0;
    t.mock.timers.enable({apis:['setTimeout']});
    await api.worker.fetch(f.webhook('',42,'membership:check'),f.env,{waitUntil(p){tasks.push(p);}});
    assert.equal(tasks.length,1);
    assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1,'only the emoji is sent before its removal');
    t.mock.timers.tick(3999);
    await Promise.resolve();
    assert.equal(f.calls.filter(c=>c.method==='deleteMessage').length,1,'only the old prompt is deleted');
    t.mock.timers.tick(1);
    t.mock.timers.reset();
    await Promise.all(tasks);
    const removed=f.calls.findIndex(c=>c.method==='deleteMessage'&&c.body.message_id===80);
    const next=f.calls.findIndex(c=>c.method==='sendMessage'&&c.body.text!=='✅');
    assert.ok(removed>=0 && next>removed,'the original start response must follow successful emoji deletion');
    assert.equal(f.calls[next].body.chat_id,42);
    assert.equal(f.jobs.length,0);
  } finally {t.mock.timers.reset();f.close();}
});

test('a blocked YouTube link resumes with its original IDs only after emoji deletion',async t=>{
  const f=fixture(),tasks=[];
  try {
    await api.setMembershipMode(f.env,'first_link');
    const original=await gateRequest(f,'https://youtube.com/watch?v=abcdefghijk',42,701);
    assert.equal(f.jobs.length,0);
    f.setMember({status:'member'});
    f.calls.length=0;
    f.env.YOUTUBE_DOWNLOAD_WORKFLOW.create=async job=>{
      assert.ok(f.calls.some(c=>c.method==='deleteMessage'&&c.body.message_id===80));
      f.jobs.push(job);return {id:job.id};
    };
    t.mock.timers.enable({apis:['setTimeout']});
    await api.worker.fetch(f.webhook('',42,'membership:check'),f.env,{waitUntil(p){tasks.push(p);}});
    assert.equal(f.jobs.length,0);
    t.mock.timers.tick(4000);
    t.mock.timers.reset();
    await Promise.all(tasks);
    assert.equal(f.jobs.length,1);
    assert.equal(f.jobs[0].params.requestMessageId,original.message.message_id);
    assert.equal(f.jobs[0].params.userId,42);
    assert.ok(f.jobs[0].params.url.includes('abcdefghijk'));
  } finally {t.mock.timers.reset();f.close();}
});

test('pending actions are isolated, retain the latest request, and cannot be consumed twice',async()=>{
  const f=fixture();
  const message=(id,user=42,text='/start')=>({update_id:id,message:{message_id:id,chat:{id:user},from:{id:user},text}});
  try {
    for(const update of [message(800),message(802,42,'https://youtu.be/abcdefghijk'),message(801)])
      assert.equal((await f.request('/membership-pending',{op:'save',userId:42,update})).status,200);
    assert.equal((await (await f.request('/membership-pending',{op:'take',userId:43})).json()).update,null);
    const taken=await Promise.all([1,2].map(async()=> (await (await f.request('/membership-pending',{op:'take',userId:42})).json()).update));
    assert.equal(taken.filter(Boolean).length,1);
    assert.equal(taken.find(Boolean).update_id,802);
    await f.request('/membership-pending',{op:'save',userId:42,update:message(802)});
    f.restart();
    assert.equal((await (await f.request('/membership-pending',{op:'take',userId:42})).json()).update,null,'webhook redelivery must not restore consumed work');
    assert.equal((await f.request('/membership-pending',{op:'save',userId:42,update:message(803,43)})).status,400);
  } finally {f.close();}
});

test('failed emoji removal keeps the original request pending and never resumes it',async t=>{
  const f=fixture(),tasks=[],resumed=[];
  try {
    await api.setMembershipMode(f.env,'start');
    const original=await gateRequest(f,'/start',42,810);
    f.setMember({status:'member'});
    const currentFetch=globalThis.fetch;
    globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/deleteMessage')&&JSON.parse(init.body).message_id===80)
        return Response.json({ok:false,description:'message cannot be deleted'},{status:400});
      return currentFetch(url,init);
    };
    t.mock.timers.enable({apis:['setTimeout']});
    await api.enforceMembership(f.webhook('',42,'membership:check'),f.env,{waitUntil(p){tasks.push(p);}},async update=>resumed.push(update));
    t.mock.timers.tick(4000);t.mock.timers.reset();
    await Promise.all(tasks);
    assert.equal(resumed.length,0);
    assert.equal((await (await f.request('/membership-pending',{op:'take',userId:42})).json()).update.update_id,original.update_id);
  } finally {t.mock.timers.reset();f.close();}
});

test('leaving during confirmation preserves pending work instead of resuming without membership',async t=>{
  const f=fixture(),tasks=[],resumed=[];
  try {
    await api.setMembershipMode(f.env,'start');
    await gateRequest(f,'/start',42,820);
    f.setMember({status:'member'});
    t.mock.timers.enable({apis:['setTimeout']});
    await api.enforceMembership(f.webhook('',42,'membership:check'),f.env,{waitUntil(p){tasks.push(p);}},async update=>resumed.push(update));
    f.setMember({status:'left'});
    t.mock.timers.tick(4000);t.mock.timers.reset();
    await Promise.all(tasks);
    assert.equal(resumed.length,0);
    assert.equal((await (await f.request('/membership-pending',{op:'take',userId:42})).json()).update.update_id,820);
  } finally {t.mock.timers.reset();f.close();}
});

test('repeated membership confirmations resume the saved request once',async t=>{
  const f=fixture(),tasks=[],resumed=[];
  try {
    await api.setMembershipMode(f.env,'start');
    await gateRequest(f,'/start',42,830);
    f.setMember({status:'member'});
    t.mock.timers.enable({apis:['setTimeout']});
    for(let i=0;i<2;i++) await api.enforceMembership(f.webhook('',42,'membership:check'),f.env,
      {waitUntil(p){tasks.push(p);}},async update=>resumed.push(update));
    assert.equal(resumed.length,0);
    t.mock.timers.tick(4000);t.mock.timers.reset();
    await Promise.all(tasks);
    assert.equal(resumed.length,1);
    assert.equal(resumed[0].update_id,830);
  } finally {t.mock.timers.reset();f.close();}
});

test('a gated quality button resumes its original download selection after confirmation',async t=>{
  const f=fixture(),tasks=[];
  try {
    await api.setMembershipMode(f.env,'first_link');
    await api.worker.fetch(f.webhook('',42,'ytq|abcdefghijk|720|7|42'),f.env,{});
    assert.equal(f.jobs.length,0);
    f.setMember({status:'member'});
    f.calls.length=0;
    t.mock.timers.enable({apis:['setTimeout']});
    await api.worker.fetch(f.webhook('',42,'membership:check'),f.env,{waitUntil(p){tasks.push(p);}});
    assert.equal(f.jobs.length,0);
    t.mock.timers.tick(4000);t.mock.timers.reset();
    await Promise.all(tasks);
    assert.equal(f.jobs.length,1);
    assert.equal(f.jobs[0].params.quality,720);
    assert.equal(f.jobs[0].params.requestMessageId,7);
    assert.equal(f.jobs[0].params.statusMessageId,70,'the original button message remains the status target');
    assert.equal(f.jobs[0].params.userId,42);
  } finally {t.mock.timers.reset();f.close();}
});

test('continuation waits for Telegram to acknowledge deletion, not just for the timer',async t=>{
  const f=fixture(),tasks=[],resumed=[];
  let acknowledge, deletionRequested=false;
  const deletion=new Promise(resolve=>{acknowledge=resolve;});
  try {
    await api.setMembershipMode(f.env,'start');
    await gateRequest(f,'/start',42,840);
    f.setMember({status:'member'});
    const currentFetch=globalThis.fetch;
    globalThis.fetch=async(url,init)=>{
      if(String(url).endsWith('/deleteMessage')&&JSON.parse(init.body).message_id===80) {
        deletionRequested=true;
        return deletion;
      }
      return currentFetch(url,init);
    };
    t.mock.timers.enable({apis:['setTimeout']});
    await api.enforceMembership(f.webhook('',42,'membership:check'),f.env,
      {waitUntil(p){tasks.push(p);}},async update=>resumed.push(update));
    t.mock.timers.tick(4000);t.mock.timers.reset();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(deletionRequested,true);
    assert.equal(resumed.length,0,'elapsed time and a pending delete request do not permit continuation');
    acknowledge(Response.json({ok:true,result:true}));
    await Promise.all(tasks);
    assert.equal(resumed.length,1);
  } finally {t.mock.timers.reset();f.close();}
});
