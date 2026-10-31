import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const bundle = await build({ external: ['node:async_hooks'],
  stdin: { contents: 'export {default as worker, YoutubeDownloadWorkflow} from "./src/app-main"; export * from "./src/admin"; export * from "./src/restrictions"; export * from "./src/subtitle-usage";', resolveDir: process.cwd(), loader: 'ts' },
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

test('subtitle users and histories use only recorded subtitle requests, paginate correctly and keep plain downloads separate',async()=>{
  const f=fixture();
  try{
    await f.record(1);
    for(let i=0;i<7;i++) await f.request('/download',{...base,key:`sub-history-${i}`,subtitleLanguage:i%2?'de':'fa',
      status:i===0?'failed':'success',delivered:i===0?0:1,title:'زیرنویس'});
    await f.request('/download',{...base,key:'plain',subtitleLanguage:null,status:'success',delivered:1});
    await f.request('/download',{...base,key:'legacy',status:'success',delivered:1});
    for(let i=0;i<9;i++) await f.request('/download',{...base,key:`other-${i}`,userId:100+i,subtitleLanguage:'fr',status:'failed'});
    const first=await (await f.request('/subtitle-users?page=0')).json();
    const last=await (await f.request('/subtitle-users?page=999')).json();
    assert.equal(first.totalUsers,10);assert.equal(first.requests,16);assert.equal(first.delivered,6);assert.equal(first.failed,10);
    assert.equal(first.users.length,8);assert.equal(last.users.length,2);assert.equal(last.page,1);
    assert.ok(!first.users.some(u=>last.users.some(v=>u.id===v.id)));
    const own=[...first.users,...last.users].find(u=>u.id==='42');
    assert.equal(own.requests,7);assert.equal(own.delivered,6);assert.equal(own.username,'example');
    const detail=await admin.getAdminUserDetail(f.env,'42',99,true);
    assert.equal(detail.counts.total,7);assert.equal(detail.counts.success,6);assert.equal(detail.totalPages,2);
    assert.equal(detail.page,1);assert.equal(detail.downloads.length,2);
    assert.ok(detail.downloads.every(d=>d.subtitleLanguage));
    assert.equal((await f.detail()).counts.total,9);
    f.restart();assert.equal((await (await f.request('/subtitle-users')).json()).requests,16);
  }finally{f.close();}
});

test('production subtitle admin panels enforce permissions, persist independent locks and provide filtered histories',async()=>{
  const f=fixture(),previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(input,init)=>{calls.push({method:String(input).split('/').at(-1),body:JSON.parse(init.body)});
    return Response.json({ok:true,result:{message_id:10}});};
  const click=(data,id=admin.ADMIN_USER_ID)=>admin.worker.fetch(webhook({callback_query:{id:'subtitle-admin',from:{id},data,
    message:{message_id:10,chat:{id}}}}),f.env,{});
  const access=(values={})=>f.request('/youtube-subtitle-access',{actorId:admin.ADMIN_USER_ID,...values});
  const edit=()=>calls.filter(c=>c.method==='editMessageText').at(-1)?.body;
  try{
    await f.record(1);
    await f.request('/download',{...base,subtitleLanguage:'de',status:'failed',title:'زیرنویس آزمایشی'});
    assert.equal((await access({actorId:42,locked:true})).status,403);
    for(const data of ['admin:subtitles:lock','admin:subusers:0','admin:subuser:42:0:0:lock']) {
      calls.length=0;await click(data,42);assert.equal(calls.length,0);
    }
    assert.equal((await (await access()).json()).globalLocked,false);
    calls.length=0;await click('admin:subtitles');
    assert.match(edit().text,/مدیریت زیرنویس یوتیوب/);assert.match(edit().text,/کاربران دارای سابقهٔ زیرنویس: 1/);
    assert.equal(edit().entities[0].type,'bold');
    await click('admin:subtitles:lock');await click('admin:subtitles:lock');
    assert.equal((await (await access()).json()).globalLocked,true);
    await click('admin:subuser:42:0:0:lock');
    assert.match(edit().text,/زیرنویس آزمایشی/);assert.match(edit().text,/Deutsch/);assert.match(edit().text,/قفل اختصاصی این کاربر: فعال/);
    await click('admin:subtitles:unlock');
    assert.deepEqual(await (await access({userId:42})).json(),{globalLocked:false,userLocked:true,locked:true});
    await click('admin:subuser:42:0:0:unlock');
    assert.equal((await (await access({userId:42})).json()).locked,false);
    await click('admin:subusers:0');
    assert.ok(edit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:subuser:42:0:0'));
    assert.ok(admin.adminDashboardKeyboard().inline_keyboard.flat().some(b=>b.callback_data==='admin:subtitles'));
    assert.ok(admin.adminUserDetailKeyboard(await f.detail(),0).inline_keyboard.flat().some(b=>b.callback_data==='admin:subuser:42:0:0'));
    f.restart();assert.equal((await (await access({userId:42})).json()).locked,false);
  }finally{globalThis.fetch=previous;f.close();}
});

test('subtitle admin history stays within Telegram limits and locked notices survive real privacy and localization processing',async()=>{
  const f=fixture(),previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
  try{
    await f.record(1,{user:{id:Number.MAX_SAFE_INTEGER,firstName:'نام '.repeat(100)}});
    for(let i=0;i<6;i++) await f.request('/download',{...base,key:`long-subtitle-${i}`,userId:Number.MAX_SAFE_INTEGER,
      subtitleLanguage:'zh',status:'failed',title:'عنوان'.repeat(100),request:'https://youtube.com/'.padEnd(500,'a'),detail:'توضیح'.repeat(100)});
    await admin.worker.fetch(webhook({callback_query:{id:'subtitle-limits',from:{id:admin.ADMIN_USER_ID},
      data:`admin:subuser:${Number.MAX_SAFE_INTEGER}:99999999:0:lock`,message:{message_id:10,chat:{id:admin.ADMIN_USER_ID}}}}),f.env,{});
    const edit=calls.filter(c=>c.reply_markup).at(-1);
    assert.ok(edit.text.length<4096);
    assert.ok(edit.reply_markup.inline_keyboard.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
    assert.ok(edit.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.includes(':1')));
    const notice='🔒 زیرنویس، کمی بعد\n\nدسترسی به زیرنویس فعلاً از طرف مدیریت بسته شده است.\nدانلود ویدیو بدون زیرنویس همچنان در دسترس توست.';
    const safe=admin.telegramCustomEmoji('answerCallbackQuery',{callback_query_id:'locked',text:notice,show_alert:true,_errorUserId:42});
    assert.equal(safe.text,notice);assert.equal(safe.show_alert,true);assert.ok(safe.text.length<=200);
  }finally{globalThis.fetch=previous;f.close();}
});

test('production locked subtitle click displays a localized modal with the requested icon and no new chat message',async()=>{
  const f=fixture(),previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(input,init)=>{calls.push({method:String(input).split('/').at(-1),body:JSON.parse(init.body)});
    return Response.json({ok:true,result:{message_id:10}});};
  try{
    await f.request('/language?user=42',{language:'en'});
    await f.request('/youtube-subtitle-access',{actorId:admin.ADMIN_USER_ID,userId:42,locked:true});
    const menu={videoId:'abcdefghijk',requestMessageId:7,userId:42,chatId:42,messageId:10,qualities:[360],audioAvailable:true,
      preference:{enabled:false},createdAt:Date.now()};
    await f.request('/youtube-subtitles',{op:'open',...menu,menu});
    await admin.worker.fetch(webhook({callback_query:{id:'locked-user',from:{id:42},
      data:'ytst|abcdefghijk|7|42|1',message:{message_id:10,chat:{id:42}}}}),f.env,{});
    const alert=calls.find(c=>c.method==='answerCallbackQuery'&&c.body.show_alert)?.body;
    assert.ok(alert);assert.match(alert.text,/Subtitles are paused by the admin/);
    assert.ok(!/[\u0600-\u06ff]/.test(alert.text));assert.ok(alert.text.length<=200);
    assert.ok(!calls.some(c=>c.method==='sendMessage'||c.method==='sendMessageDraft'));
    const edit=calls.filter(c=>c.body.reply_markup).at(-1).body;
    assert.equal(edit.message_id,10);assert.equal(edit.reply_markup.inline_keyboard.at(-1)[0].icon_custom_emoji_id,'5296369303661067030');
  }finally{globalThis.fetch=previous;f.close();}
});

const charge = (extra={}) => ({key:'sub:test',downloadKey:base.key,userId:42,at:Date.now(),language:'fa',
  provider:'openai',model:'gpt-6-luna',state:'measured',serviceTier:'default',
  inputTokens:10000,cachedInputTokens:2000,cacheWriteTokens:4000,outputTokens:3000,...extra});

test('subtitle public prices use measured units, cache writes and actual service tier without guessing unknown usage',()=>{
  assert.equal(admin.subtitleChargeNano(charge()),2420000);
  assert.equal(admin.subtitleChargeNano(charge({serviceTier:'flex'})),1210000);
  assert.equal(admin.subtitleChargeNano(charge({serviceTier:'priority'})),4840000);
  assert.equal(admin.subtitleChargeNano(charge({provider:'elevenlabs',model:'scribe_v2',audioSeconds:3600})),220000000);
  for(const extra of [{state:'unknown'},{state:'pending'},{model:'other-model'},{serviceTier:undefined},
      {cacheWriteTokens:undefined},{cachedInputTokens:9000},{provider:'elevenlabs',model:'scribe_v2'}])
    assert.equal(admin.subtitleChargeNano(charge(extra)),null);
  assert.equal(admin.subtitleChargeNano(charge({state:'rejected'})),0);
});

test('subtitle ledger persists failed-job costs, rejects malformed batches, deduplicates and never regresses final events',async()=>{
  const f=fixture();
  try{
    const at=Date.now();Date.now=()=>at;
    const stt=charge({key:'sub:stt',provider:'elevenlabs',model:'scribe_v2',audioSeconds:3600});
    const post=events=>f.request('/usage',{samples:[],deliveries:[],subtitleCharges:events});
    await post([charge({state:'pending'}),stt]);await post([charge()]);
    await post([charge(),stt,charge({state:'pending'})]);
    await post([charge({key:'sub:unknown',state:'unknown',userId:43})]);
    const all=await admin.getAdminUsage(f.env),own=await admin.getAdminUsage(f.env,'42');
    assert.deepEqual(own.all.subtitles,{transcriptionNano:220000000,translationNano:2420000,calls:2,unknown:0});
    assert.equal(all.all.subtitles.unknown,1);
    await post([charge({userId:99})]);
    assert.equal((await admin.getAdminUsage(f.env,'99')).all.subtitles.calls,0);
    assert.equal((await post([charge({key:'sub:bad',inputTokens:-1})])).status,400);
    f.restart();assert.equal((await admin.getAdminUsage(f.env,'42')).all.subtitles.translationNano,2420000);
    const text=admin.formatAdminUsage(await admin.getAdminUsage(f.env));
    assert.match(text,/\$0\.222420/);assert.match(text,/نامشخص/);assert.ok(text.length<4096);
  }finally{f.close();}
});

test('YouTube subtitle history keeps the active custom emoji and has no disabled subtitle emoji',async()=>{
  const f=fixture();
  try{
    await f.record(1);
    await f.request('/download',{...base,status:'pending',subtitleLanguage:'de'});
    await f.request('/download',{...base,status:'failed',subtitleLanguage:'de'});
    await f.request('/usage',{samples:[],deliveries:[],subtitleCharges:[charge({language:'de'})]});
    await f.request('/download',{...base,key:'no-subtitle',status:'success',delivered:1,subtitleLanguage:null});
    await f.request('/download',{...base,key:'legacy',status:'success',delivered:1});
    // A stale replay must not change the originally selected language.
    await f.request('/download',{...base,status:'pending',subtitleLanguage:'ru'});
    const d=await f.detail(),text=admin.formatAdminUserDetail(d);
    assert.equal(d.downloads.find(v=>v.key===base.key).subtitleLanguage,'de');
    assert.match(text,/زیرنویس: فعال • Deutsch/);assert.match(text,/زیرنویس: غیرفعال/);
    assert.match(text,/قدیمی ثبت نشده/);assert.match(text,/\$0\.002420/);assert.ok(text.length<4096);
    const decorated=admin.telegramCustomEmoji('editMessageText',{text,chat_id:admin.ADMIN_USER_ID});
    const subtitleEntities=decorated.entities.filter(e=>text.slice(e.offset,e.offset+e.length+10).includes('زیرنویس:'));
    assert.ok(subtitleEntities.some(e=>e.custom_emoji_id==='5206607081334906820'));
    assert.ok(!text.includes('❌ زیرنویس: غیرفعال'));
    assert.ok(!subtitleEntities.some(e=>e.custom_emoji_id==='5210952531676504517'));
  }finally{f.close();}
});

test('administrator YouTube subtitle requests are visible without enabling unrelated admin activity tracking',async()=>{
  const f=fixture();
  try{
    await admin.recordDownload(f.env,{...base,userId:admin.ADMIN_USER_ID,status:'success',delivered:1});
    assert.equal((await f.request(`/user?id=${admin.ADMIN_USER_ID}`)).status,404);
    await admin.recordDownload(f.env,{...base,userId:admin.ADMIN_USER_ID,status:'success',delivered:1,subtitleLanguage:'fa'});
    const d=await f.detail(String(admin.ADMIN_USER_ID));assert.equal(d.downloads[0].subtitleLanguage,'fa');
    assert.equal(d.activity,null);
  }finally{f.close();}
});

test('subtitle costs respect rolling time windows and remain attributed to the original user',async()=>{
  const f=fixture();
  try{
    const now=Date.now();Date.now=()=>now;
    const events=[charge({key:'sub:today',at:now-1000}),charge({key:'sub:week',at:now-2*86400000}),
      charge({key:'sub:old',at:now-8*86400000,userId:43})];
    await f.request('/usage',{samples:[],deliveries:[],subtitleCharges:events});
    const all=await admin.getAdminUsage(f.env),own=await admin.getAdminUsage(f.env,'42');
    assert.equal(all.day.subtitles.translationNano,2420000);
    assert.equal(all.week.subtitles.translationNano,4840000);
    assert.equal(all.all.subtitles.translationNano,7260000);
    assert.equal(own.all.subtitles.translationNano,4840000);
  }finally{f.close();}
});

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
  const values=new Map();let serial=Promise.resolve();
  const storage = { sql,
    async get(key){return structuredClone(values.get(key));},
    async put(key,value){values.set(key,structuredClone(value));},
    async delete(key){values.delete(key);},
    transaction(fn){const result=serial.then(()=>fn(storage));serial=result.catch(()=>{});return result;},
    transactionSync(fn) {
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
    const buttons = admin.adminActivityKeyboard().inline_keyboard.flat();
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

test('download statistics count content rather than carousel files, exclude search/failures and deduplicate replays',async()=>{
 const f=fixture();const write=(key,source,request,delivered,status='success',extra={})=>f.request('/download',{key,userId:42,source,request,delivered,status,...extra});
 try{
  await write('carousel','Instagram post','https://instagram.com/p/Abc/',6);
  await write('reel','Instagram post','https://instagram.com/reel/Abc/',1);
  await write('stories','Instagram story','https://instagram.com/stories/example/',3,'partial');
  await write('stories','Instagram story','https://instagram.com/stories/example/',5);
  await write('stories','Instagram story','https://instagram.com/stories/example/',5);
  await write('group','Instagram profile stories','https://instagram.com/example/',10);
  await write('parent','Instagram story','https://instagram.com/stories/example/123/',1,'success',{excludeFromStats:true});
  await write('child','Instagram story','https://instagram.com/stories/example/123/',1);
  await write('tiktok','TikTok','https://tiktok.com/x',8);
  await write('x','X','https://x.com/x/status/1',2);
  await write('yt','YouTube','https://youtube.com/watch?v=1',1);
  await write('mp3','YouTube','https://youtube.com/watch?v=2',1,'success',{category:'music'});
  await write('playlist','YouTube Playlist','https://youtube.com/playlist?list=1',4,'partial');
  await write('results','جست‌وجو و دانلود آهنگ','music query',0,'results');
  await write('failed','Instagram post','https://instagram.com/p/Fail/',1,'partial');
  const stats=await admin.getDownloadStatistics(f.env);
  assert.deepEqual(stats.periods.all,{ig_story:6,ig_post:1,ig_reel:1,ig_other:0,tiktok:1,x:1,youtube:1,music:5,other:0});
  assert.deepEqual(stats.periods.day,stats.periods.all);f.restart();
  assert.deepEqual((await admin.getDownloadStatistics(f.env)).periods.all,stats.periods.all);
  const html=admin.formatDownloadStatistics(stats);assert.match(html,/<b>اینستاگرام — مجموع: 8<\/b>/);
  assert.match(html,/<b>مجموع همه: 16<\/b>/);assert.ok(html.length<4096);
 }finally{f.close();}
});

test('rolling download windows use delivery events and do not move old stories forward when a partial job finishes',async()=>{
 const f=fixture();let now=Date.parse('2026-10-25T12:00:00Z');Date.now=()=>now;
 const write=(key,source,delivered,status='success')=>f.request('/download',{key,userId:42,source,request:'fixture',delivered,status});
 try{
  await write('old','YouTube',1);now+=8*86400_000;
  await write('week','X',1);now+=2*86400_000;
  await write('stories','Instagram story',2,'partial');now+=86400_000;
  let stats=await admin.getDownloadStatistics(f.env);assert.equal(stats.periods.day.ig_story,2,'inclusive 24-hour boundary');
  now++;await write('stories','Instagram story',3);
  stats=await admin.getDownloadStatistics(f.env);
  assert.equal(stats.periods.day.ig_story,1);assert.equal(stats.periods.week.ig_story,3);
  assert.equal(stats.periods.day.x,0);assert.equal(stats.periods.week.x,1);
  assert.equal(stats.periods.week.youtube,0);assert.equal(stats.periods.all.youtube,1);
  await write('old','YouTube',1);assert.equal((await admin.getDownloadStatistics(f.env)).periods.day.youtube,0);
 }finally{f.close();}
});

test('one-time history import preserves known types and excludes grouped parents including large Story parents',async()=>{
 const f=fixture();
 try{
  f.db.exec("DELETE FROM counters WHERE key='download_stats_since'; DELETE FROM download_stat_events;");
  const add=(key,source,request,delivered,detail=null)=>f.db.prepare('INSERT INTO download_history VALUES (?,?,?,?,?,?,?,?,?,?)').run(key,'42',source,request,'success',null,detail,delivered,Date.now(),Date.now());
  add('old-reel','Instagram post','https://instagram.com/reel/A/',2);
  add('old-audio','YouTube','https://youtube.com/watch?v=A',1,'🎧 Audio HQ');
  add('old-group','Instagram profile posts','https://instagram.com/user/',10);
  add('ig:42:7:42','Instagram story','https://instagram.com/stories/user/1/',1);
  add('igdl-42-7-42-profile-1','Instagram story','https://instagram.com/stories/user/1/',1);
  f.restart();let stats=await admin.getDownloadStatistics(f.env);
  assert.equal(stats.periods.all.ig_reel,1);assert.equal(stats.periods.all.ig_story,1);
  assert.equal(stats.periods.all.music,1);assert.equal(stats.periods.all.ig_post,0);
  f.restart();assert.deepEqual((await admin.getDownloadStatistics(f.env)).periods,stats.periods);
 }finally{f.close();}
});

test('download statistics panel is admin-only and uses HTML bold with refresh and back controls',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 const visit=id=>admin.worker.fetch(webhook({callback_query:{id:'download-stats',from:{id},data:'admin:downloads',message:{message_id:20,chat:{id}}}}),f.env,{});
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:20}});};
 try{
  await visit(99);assert.equal(calls.length,0);await visit(admin.ADMIN_USER_ID);
  const panel=calls.find(x=>x.url.endsWith('/editMessageText')).body;
  assert.equal(panel.parse_mode,'HTML');assert.match(panel.text,/<b>📥 آمار/);
  assert.ok(panel.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='admin:downloads'));
  assert.ok(admin.adminDashboardKeyboard().inline_keyboard.flat().some(x=>x.callback_data==='admin:downloads'));
 }finally{globalThis.fetch=previous;f.close();}
});


test('download restrictions persist, expire at the boundary, support permanent and manual removal, and require admin', async () => {
 const f=fixture();
 try {
  await f.record(9001);
  const set=(seconds,actorId=admin.ADMIN_USER_ID)=>f.request('/restriction?id=42',{actorId,seconds});
  assert.equal((await set(3600,42)).status,403);
  assert.equal((await set(-2)).status,400);
  assert.equal((await f.request(`/restriction?id=${admin.ADMIN_USER_ID}`,{actorId:admin.ADMIN_USER_ID,seconds:-1})).status,403);
  const now=Date.now(); Date.now=()=>now;
  assert.equal((await set(3600)).status,200); f.restart();
  assert.deepEqual(await admin.userRestriction(f.env,42),{restricted:true,until:now+3600000});
  Date.now=()=>now+3600000;
  assert.equal((await admin.userRestriction(f.env,42)).restricted,false);
  await set(-1); f.restart(); Date.now=()=>now+365*86400000;
  assert.deepEqual(await admin.userRestriction(f.env,42),{restricted:true,until:null});
  await set(0); assert.equal((await admin.userRestriction(f.env,42)).restricted,false);
  assert.equal((await f.request('/restriction?id=999',{actorId:admin.ADMIN_USER_ID,seconds:3600})).status,404);
 } finally { f.close(); }
});

test('restricted webhook blocks links, music, media and old quality buttons before membership or downloads; notices keep the requested emoji',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 try {
  await f.record(9002); await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:3600});
  globalThis.fetch=async(input,init)=>{calls.push({url:String(input),body:JSON.parse(init.body)});return Response.json({ok:true,result:true});};
  const updates=[
   {message:{message_id:1,from:{id:42},chat:{id:42},text:'https://youtu.be/abcdefghijk'}},
   {message:{message_id:2,from:{id:42},chat:{id:42},text:'/music Hello'}},
   {message:{message_id:3,from:{id:42},chat:{id:42},voice:{file_id:'clip'}}},
   {callback_query:{id:'old',from:{id:42},data:'ytq|old-quality',message:{message_id:4,chat:{id:42}}}},
   {callback_query:{id:'member',from:{id:42},data:'membership:check',message:{message_id:4,chat:{id:42}}}},
  ];
  for(const update of updates) assert.equal((await admin.worker.fetch(webhook(update),f.env,{})).status,200);
  const notices=calls.filter(c=>c.url.endsWith('/sendMessage'));
  assert.equal(notices.length,updates.length);
  assert.ok(calls.every(c=>!/getChatMember/.test(c.url)));
  for(const {body} of notices){
   assert.match(body.text,/محدود شده/);assert.doesNotMatch(body.text,/ادمین/);
   assert.deepEqual(body.entities.filter(e=>e.type==='custom_emoji'),[
    {type:'custom_emoji',offset:0,length:1,custom_emoji_id:'5260293700088511294'},
    {type:'custom_emoji',offset:body.text.indexOf('💜'),length:2,custom_emoji_id:'5442678635909621223'}]);
   assert.ok(body.entities.some(e=>e.type==='bold'));
  }
  assert.equal(await admin.enforceRestriction(webhook(updates[0],'wrong'),f.env),null);
  assert.equal(await admin.enforceRestriction(webhook({message:{from:{id:42},chat:{id:42},text:'/start'}}),f.env),null);
  assert.equal(await admin.enforceRestriction(webhook({message:{from:{id:43},chat:{id:43},text:'/music Hello'}}),f.env),null);
  await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:0});
  assert.equal(await admin.enforceRestriction(webhook(updates[0]),f.env),null);
 }finally{globalThis.fetch=previous;f.close();}
});

test('admin user restriction controls save temporary/permanent settings and lift them; forged callbacks cannot change settings',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
 try{
  await f.record(9003);
  const keyboard=admin.adminUserDetailKeyboard(await f.detail(),0);
  assert.match(JSON.stringify(keyboard),/admin:restriction:42:0:0/);
  const visit=(data,id=admin.ADMIN_USER_ID)=>admin.enforceRestriction(webhook({callback_query:{id:'limit',from:{id},data,message:{message_id:5,chat:{id}}}}),f.env);
  await visit('admin:restriction:42:0:0');
  assert.match(calls.at(-1).text,/بدون محدودیت/);
  assert.match(JSON.stringify(calls.at(-1).reply_markup),/admin:limit:42:3600/);
  await visit('admin:limit:42:3600');assert.equal((await admin.userRestriction(f.env,42)).restricted,true);
  await visit('admin:limit:42:-1');assert.deepEqual(await admin.userRestriction(f.env,42),{restricted:true,until:null});
  await visit('admin:limit:42:0',43);assert.equal((await admin.userRestriction(f.env,42)).restricted,true);
  await visit('admin:limit:42:0');assert.equal((await admin.userRestriction(f.env,42)).restricted,false);
 }finally{globalThis.fetch=previous;f.close();}
});

test('custom restriction duration accepts Persian/Arabic digits and units and rejects invalid ranges',()=>{
 for(const [text,seconds] of [['۴۵ دقیقه',2700],['٢ ساعت',7200],['۱٫۵ ساعت',5400],['3 days',259200],['۲ هفته',1209600]])
  assert.equal(admin.parseRestrictionDuration(text),seconds);
 for(const text of ['0 ساعت','-1 روز','بی نهایت','400 روز','2','1e9 ساعت','0.001 دقیقه'])
  assert.equal(admin.parseRestrictionDuration(text),null);
});

test('custom time is applied only by an admin replying to the bot prompt, with durable expiry and invalid-input feedback',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 const env={...f.env,BOT_TOKEN:'123:fictional'};
 globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
 try{
  await f.record(9100);
  await admin.enforceRestriction(webhook({callback_query:{id:'custom',from:{id:admin.ADMIN_USER_ID},data:'admin:customlimit:42',message:{message_id:5,chat:{id:admin.ADMIN_USER_ID}}}}),env);
  const prompt=calls.at(-1);
  assert.equal(prompt.reply_markup.force_reply,true);
  const reply=(text,id=admin.ADMIN_USER_ID,bot=123)=>webhook({message:{message_id:7,chat:{id},from:{id},text,
   reply_to_message:{message_id:6,from:{id:bot,is_bot:true},text:prompt.text}}});
  assert.equal(await admin.enforceRestriction(reply('۲ ساعت',43),env),null);
  assert.equal(await admin.enforceRestriction(reply('۲ ساعت',admin.ADMIN_USER_ID,999),env),null);
  await admin.enforceRestriction(reply('400 روز'),env);
  assert.match(calls.at(-1).text,/بازهٔ مجاز/);
  assert.equal((await admin.userRestriction(env,42)).restricted,false);
  const now=Date.now();Date.now=()=>now;
  await admin.enforceRestriction(reply('۱٫۵ ساعت'),env);f.restart();
  assert.deepEqual(await admin.userRestriction(env,42),{restricted:true,until:now+5400000});
  assert.match(calls.at(-1).text,/ثبت شد/);
  Date.now=()=>now+5400000;
  assert.equal((await admin.userRestriction(env,42)).restricted,false);
 }finally{globalThis.fetch=previous;f.close();}
});

test('restricted user list paginates only active restrictions, excludes expired/lifted/admin accounts and clamps pages',async()=>{
 const f=fixture();
 try{
  const now=Date.now();Date.now=()=>now;
  const insert=f.db.prepare('INSERT INTO users VALUES (?,NULL,?,NULL,0,?,?)');
  for(let id=1;id<=12;id++){
   insert.run(String(id),`User ${id}`,now,now);
   await f.request(`/restriction?id=${id}`,{actorId:admin.ADMIN_USER_ID,seconds:id===1?-1:id===2?1:3600});
  }
  await f.request('/restriction?id=12',{actorId:admin.ADMIN_USER_ID,seconds:0});
  // A previously restricted user who has become an admin must not appear.
  insert.run(String(admin.ADMIN_USER_ID),'Owner',now,now);
  f.db.prepare('INSERT INTO user_restrictions VALUES (?,NULL)').run(String(admin.ADMIN_USER_ID));
  Date.now=()=>now+1000;
  const get=async page=>(await f.request(`/restricted-users?page=${page}`)).json();
  const first=await get(0),second=await get(1);
  assert.equal(first.total,10);assert.equal(first.totalPages,2);assert.equal(first.users.length,8);assert.equal(second.users.length,2);
  assert.equal(first.users[0].id,'1');assert.equal(first.users[0].until,null);
  assert.equal(new Set([...first.users,...second.users].map(u=>u.id)).size,10);
  assert.ok([...first.users,...second.users].every(u=>!['2','12',String(admin.ADMIN_USER_ID)].includes(u.id)));
  assert.equal((await get(999)).page,1);
  await f.request('/restriction?id=1',{actorId:admin.ADMIN_USER_ID,seconds:0});
  Date.now=()=>now+3600000;
  assert.deepEqual(await get(0),{users:[],total:0,page:0,totalPages:1});
 }finally{f.close();}
});

test('restricted-users panel is admin-only and links to restriction management with refresh and back controls',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
 try{
  await f.record(9200);await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:-1});
  assert.match(JSON.stringify(admin.adminDashboardKeyboard()),/admin:restricted:0/);
  const visit=id=>admin.enforceRestriction(webhook({callback_query:{id:'restricted',from:{id},data:'admin:restricted:0',message:{message_id:5,chat:{id}}}}),f.env);
  assert.equal(await visit(43),null);assert.equal(calls.length,0);
  await visit(admin.ADMIN_USER_ID);
  assert.match(calls.at(-1).text,/کاربران محدودشده \(1\)/);assert.match(calls.at(-1).text,/دائمی/);
  assert.match(JSON.stringify(calls.at(-1).reply_markup),/admin:restriction:42:0:0/);
  assert.match(JSON.stringify(calls.at(-1).reply_markup),/admin:stats/);
  await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:0});
  await visit(admin.ADMIN_USER_ID);assert.match(calls.at(-1).text,/هیچ کاربری محدودیت فعال ندارد/);
 }finally{globalThis.fetch=previous;f.close();}
});


test('restriction notices use bold sections and a live remaining duration per request without dates',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 try{
  const now=Date.now();Date.now=()=>now;
  await f.record(9300);await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:3600});
  globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
  const visit=()=>admin.enforceRestriction(webhook({message:{message_id:1,from:{id:42},chat:{id:42},text:'https://youtu.be/abcdefghijk'}}),f.env);
  await visit();const first=calls.at(-1);
  assert.match(first.text,/زمان باقی‌مانده: ۱ ساعت/);
  Date.now=()=>now+61000;await visit();const second=calls.at(-1);
  assert.match(second.text,/زمان باقی‌مانده: ۵۸ دقیقه و ۵۹ ثانیه/);
  assert.doesNotMatch(second.text,/تهران|تاریخ|\//);
  for(const body of [first,second,admin.restrictionNotice({restricted:true,until:null})]){
   const bold=body.entities.filter(e=>e.type==='bold').map(e=>body.text.slice(e.offset,e.offset+e.length));
   assert.ok(bold.includes('دسترسی دانلودت محدود شده'));
   assert.ok(body.text.includes('\n\n'));
   assert.equal(body.entities.at(-1).custom_emoji_id,'5442678635909621223');
   assert.equal(body.text.slice(body.entities.at(-1).offset,body.entities.at(-1).offset+body.entities.at(-1).length),'💜');
  }
  assert.match(admin.restrictionNotice({restricted:true,until:null}).text,/بدون زمان پایان/);
 }finally{globalThis.fetch=previous;f.close();}
});

test('admin menus group related buttons and activity submenu remains admin-only',async()=>{
 const rows=admin.adminDashboardKeyboard().inline_keyboard;
 const together=(a,b)=>rows.some(row=>row.some(x=>x.callback_data===a)&&row.some(x=>x.callback_data===b));
 assert.ok(together('admin:users:0','admin:restricted:0'));
 assert.ok(together('admin:igapi','admin:membership'));
 assert.ok(rows.flat().some(b=>b.callback_data==='admin:activity'));
 assert.ok(!rows.flat().some(b=>/admin:(users|used):0:(day|week)/.test(b.callback_data)));
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
 try{
  const detailRows=admin.adminUserDetailKeyboard(await (async()=>{await f.record(9400);return f.detail();})(),0).inline_keyboard;
  assert.ok(detailRows.some(row=>row.some(b=>b.callback_data.startsWith('admin:usage:42:'))&&row.some(b=>b.callback_data.startsWith('admin:restriction:42:'))));
  const visit=id=>admin.worker.fetch(webhook({callback_query:{id:'activity',from:{id},data:'admin:activity',message:{message_id:7,chat:{id}}}}),f.env,{});
  await visit(43);assert.equal(calls.length,0);
  await visit(admin.ADMIN_USER_ID);
  const panel=calls.filter(c=>c.reply_markup).at(-1);
  for(const kind of ['users','used'])for(const period of ['day','week'])
   assert.ok(panel.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===`admin:${kind}:0:${period}`));
 }finally{globalThis.fetch=previous;f.close();}
});

test('restriction motion uses native draft reveal, preserves final bold and custom emojis, and survives draft failure',async()=>{
 const f=fixture(),previous=globalThis.fetch,previousTimeout=globalThis.setTimeout,calls=[];
 try{
  await f.record(9401);await f.request('/restriction?id=42',{actorId:admin.ADMIN_USER_ID,seconds:3600});
  globalThis.setTimeout=(fn)=>previousTimeout(fn,0);
  let fail=false;
  globalThis.fetch=async(input,init)=>{
   const method=String(input).split('/').at(-1);calls.push({method,body:JSON.parse(init.body)});
   return method==='sendMessageDraft'&&fail ? Response.json({ok:false},{status:429}) : Response.json({ok:true,result:true});
  };
  const visit=token=>admin.enforceRestriction(webhook({message:{message_id:1,from:{id:42},chat:{id:42},text:'https://youtu.be/abcdefghijk'}}),{...f.env,BOT_TOKEN:token});
  await visit('restriction-motion-first:fixture');
  const drafts=calls.filter(c=>c.method==='sendMessageDraft'),final=calls.at(-1).body;
  assert.equal(drafts.length,2);assert.ok(drafts[0].body.text.length<drafts[1].body.text.length);
  assert.equal(drafts[1].body.text,final.text);
  assert.ok(final.entities.some(e=>e.type==='bold'));
  assert.equal(final.entities.at(-1).custom_emoji_id,'5442678635909621223');
  fail=true;await visit('restriction-motion-failure:fixture');
  assert.equal(calls.at(-1).method,'sendMessage');assert.match(calls.at(-1).body.text,/زمان باقی‌مانده/);
 }finally{globalThis.fetch=previous;globalThis.setTimeout=previousTimeout;f.close();}
});

test('Instagram membership control persists, counts unique clickers per rolling window and ignores duplicate callbacks',async()=>{
 const f=fixture();
 try{
  const now=Date.now();Date.now=()=>now-8*86400000;
  const click=(id,event)=>f.request('/membership-instagram',{userId:id,eventId:event});
  await click(41,'old');Date.now=()=>now-2*86400000;await click(42,'week');
  Date.now=()=>now-1000;await click(43,'today');await click(43,'today-again');await click(43,'today');
  await click(admin.ADMIN_USER_ID,'admin');Date.now=()=>now;
  let state=await (await f.request('/membership-instagram')).json();
  assert.deepEqual(state,{enabled:true,total:3,day:1,week:2});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM membership_instagram_clicks').get().n,4);
  assert.equal((await f.request('/membership-instagram',{actorId:43,enabled:false})).status,403);
  await f.request('/membership-instagram',{actorId:admin.ADMIN_USER_ID,enabled:false});f.restart();
  await click(44,'hidden');state=await (await f.request('/membership-instagram')).json();
  assert.deepEqual(state,{enabled:false,total:3,day:1,week:2});
  await f.request('/membership-instagram',{actorId:admin.ADMIN_USER_ID,enabled:true});
  assert.equal((await (await f.request('/membership-instagram')).json()).enabled,true);
 }finally{f.close();}
});

test('Instagram membership button click delivers the page link and admin can hide it without losing counters',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push({method:String(input).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,result:{status:'left'}});};
 try{
  const click=id=>admin.worker.fetch(webhook({callback_query:{id:'ig-click',from:{id},data:'membership:instagram',message:{message_id:5,chat:{id}}}}),f.env,{});
  await click(42);
  const visitUrl=calls.at(-1).body.reply_markup.inline_keyboard[0][0].url;
  assert.equal(visitUrl,'https://www.instagram.com/vexa.order/');
  assert.equal((await (await f.request('/membership-instagram')).json()).total,0);
  const panel=(data,id=admin.ADMIN_USER_ID)=>admin.worker.fetch(webhook({callback_query:{id:'ig-panel',from:{id},data,message:{message_id:5,chat:{id}}}}),f.env,{});
  await panel('admin:membership:instagram_off');
  assert.equal((await (await f.request('/membership-instagram')).json()).enabled,false);
  assert.match(calls.at(-1).body.text,/کل: 0 نفر/);
  calls.length=0;await click(42);
  assert.doesNotMatch(JSON.stringify(calls),/membership:instagram|instagram.com|@Vexa.Order/);
  await panel('admin:membership:instagram_on',43);
  assert.equal((await (await f.request('/membership-instagram')).json()).enabled,false);
 }finally{globalThis.fetch=previous;f.close();}
});


test('Instagram entry button uses the direct page URL without a callback or tracking intermediary',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(input,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{status:'left'}});};
 try{
  await f.request('/membership',{mode:'start'});
  await admin.worker.fetch(webhook({message:{message_id:1,chat:{id:42},from:{id:42},text:'/start'}}),f.env,{});
  const prompt=calls.at(-1),button=prompt.reply_markup.inline_keyboard.flat().find(b=>b.url==='https://www.instagram.com/vexa.order/');
  assert.ok(button);assert.ok(!button.callback_data);assert.doesNotMatch(prompt.text,/@Vexa\.Order/);
  assert.doesNotMatch(JSON.stringify(prompt),/membership\/instagram\/visit/);
 }finally{globalThis.fetch=previous;f.close();}
});
