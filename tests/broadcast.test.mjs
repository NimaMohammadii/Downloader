import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const bundle = await build({stdin:{contents:'export {default as worker} from "./src/app-main"; export * from "./src/admin"; export * from "./src/broadcast";',resolveDir:process.cwd(),loader:'ts'},
  bundle:true,format:'esm',write:false,plugins:[{name:'cloudflare-runtime',setup(b){
    b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
    b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'
      ? 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }'
      : 'export class Container {} export function getContainer(){throw Error("unexpected container");}'}));
  }}]});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const textValue = 'متن بولد و لینک و ایموجی ✅';
const text = {kind:'text',text:textValue,entities:[{type:'bold',offset:0,length:3},{type:'text_link',offset:textValue.indexOf('لینک'),length:4,url:'https://example.com'},{type:'custom_emoji',offset:textValue.indexOf('✅'),length:1,custom_emoji_id:'5400130177319580649'}]};
function fixture(adminConfig = {}, legacyDraft = false) {
  const db = new DatabaseSync(':memory:'), calls = [], alarms = [], originalFetch = globalThis.fetch, originalNow = Date.now;
  let now = 1_800_000_000_000, nextMessage = 100, responder;
  Date.now = () => now;
  const sql = {exec(query,...params){
    let rows=[],changes=0;
    if(/^\s*SELECT/i.test(query)) rows=db.prepare(query).all(...params);
    else if(params.length) changes=Number(db.prepare(query).run(...params).changes);
    else db.exec(query);
    return {toArray:()=>rows,one:()=>rows[0],rowsWritten:changes};
  }};
  const ctx={storage:{sql,async setAlarm(at){alarms.push(Number(at));},transactionSync(fn){
    db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
  }}};
  const storeEnv = {BOT_TOKEN:'fixture-token', ...adminConfig};
  if (legacyDraft) db.exec(`CREATE TABLE broadcast_draft (id INTEGER PRIMARY KEY CHECK(id = 1), waiting INTEGER NOT NULL, version INTEGER, content TEXT); INSERT INTO broadcast_draft VALUES (1,1,NULL,NULL);`);
  let store=new api.AdminStatsStore(ctx,storeEnv);
  globalThis.fetch=async(input,init)=>{
    const method=String(input).split('/').at(-1),body=JSON.parse(init.body);
    calls.push({method,body});
    if(method==='sendMessageDraft')return Response.json({ok:false});
    if(responder){const result=await responder(method,body);if(result)return result;}
    return Response.json({ok:true,result:{message_id:nextMessage++}});
  };
  const env={...storeEnv,WEBHOOK_SECRET:'test-secret',ADMIN_STATS:{getByName(){return {fetch:(input,init)=>store.fetch(new Request(input,init))};}}};
  const request=(body,id)=>store.fetch(new Request('https://store/broadcast'+(id?'?id='+id:''),body?{method:'POST',body:JSON.stringify(body)}:{}));
  const state=async id=>(await (await request(undefined,id)).json()).status;
  const addUsers=count=>{for(let i=0;i<count;i++)sql.exec('INSERT INTO users(id,first_seen,last_seen) VALUES (?,?,?)',String(42+i),now,now);};
  const start=async(content=text,version=7)=>{
    await request({action:'compose'});await request({action:'capture',version,content});
    return (await (await request({action:'start',version,messageId:90})).json()).status;
  };
  const webhook=(message,callback,user=api.ADMIN_USER_ID,secret='test-secret')=>new Request('https://worker/telegram/webhook',{method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:9,
      ...(callback?{callback_query:{id:'callback',from:{id:user},data:callback,message:{message_id:90,chat:{id:user}}}}
        :{message:{message_id:7,from:{id:user},chat:{id:user},...message}})})});
  return {db,env,calls,alarms,request,state,addUsers,start,webhook,
    async alarm(){await store.alarm();},advance(ms){now+=ms;},restart(){store=new api.AdminStatsStore(ctx,storeEnv);},
    respond(fn){responder=fn;},close(){globalThis.fetch=originalFetch;Date.now=originalNow;db.close();}};
}

test('native formatting is preserved byte for byte; snapshot recipients exclude admin and duplicate starts never send twice',async()=>{
  const f=fixture();try{
    f.addUsers(3);
    f.db.prepare('INSERT INTO users(id,first_seen,last_seen) VALUES (?,?,?)').run(String(api.ADMIN_USER_ID),Date.now(),Date.now());
    const status=await f.start();assert.equal(status.total,3);assert.equal(status.pending,3);
    const duplicate=await (await f.request({action:'start',version:7,messageId:90})).json();assert.equal(duplicate.status.id,status.id);
    assert.equal(f.calls.length,0);assert.ok(f.alarms.length);
    // New users arriving after the snapshot belong to the next broadcast.
    f.db.prepare('INSERT INTO users(id,first_seen,last_seen) VALUES (?,?,?)').run('99',Date.now(),Date.now());
    await f.alarm();
    const messages=f.calls.filter(c=>c.method==='sendMessage' && c.body.chat_id!==api.ADMIN_USER_ID);
    assert.equal(messages.length,3);
    for(const {body} of messages){assert.equal(body.text,text.text);assert.deepEqual(body.entities,text.entities);assert.equal(body.parse_mode,undefined);}
    assert.deepEqual(await f.state(),{id:'7',status:'completed',total:3,sent:3,failed:0,unknown:0,pending:0,nextAt:0});
    await f.alarm();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,3);
    assert.match(f.calls.filter(c=>c.method==='editMessageText').at(-1).body.text,/ارسال موفق: 3/);
  }finally{f.close();}
});

test('photos support native captions and caption formatting as well as image-only messages',async()=>{
  const f=fixture();try{
    f.addUsers(2);
    for(const [version,content] of [[7,{kind:'photo',photo:'telegram-file-id',caption:'توضیح بولد',caption_entities:[{type:'bold',offset:0,length:5}]}],
      [8,{kind:'photo',photo:'telegram-file-id'}]]){
      await f.start(content,version);await f.alarm();
      const photos=f.calls.filter(c=>c.method==='sendPhoto').slice(-2);
      assert.equal(photos.length,2);for(const {body}of photos){assert.equal(body.photo,content.photo);assert.equal(body.caption,content.caption);assert.deepEqual(body.caption_entities,content.caption_entities);assert.equal(body.parse_mode,undefined);}
      assert.equal((await f.state(String(version))).sent,2);
    }
  }finally{f.close();}
});

test('batches report live counts, persist across restart and distinguish blocked users from ambiguous network outcomes',async()=>{
  const f=fixture();try{
    f.addUsers(12);await f.start();
    f.respond((method,body)=>{
      if(method==='sendMessage'&&body.chat_id===42)return Response.json({ok:false,error_code:403},{status:403});
      if(method==='sendMessage'&&body.chat_id===43)throw Error('connection reset after sending');
    });
    await f.alarm();let state=await f.state();
    assert.equal(state.status,'running');assert.equal(state.sent,8);assert.equal(state.failed,1);assert.equal(state.unknown,1);assert.equal(state.pending,2);
    assert.match(f.calls.filter(c=>c.method==='editMessageText').at(-1).body.text,/باقی‌مانده: 2/);
    f.restart();f.advance(2000);await f.alarm();state=await f.state();
    assert.equal(state.status,'completed');assert.equal(state.sent,10);assert.equal(state.failed,1);assert.equal(state.unknown,1);
    assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&c.body.chat_id===43).length,1);
  }finally{f.close();}
});

test('Telegram retry_after pauses durably and resumes the same recipient without skipping or duplicating others',async()=>{
  const f=fixture();try{
    f.addUsers(2);await f.start();let throttled=false;
    f.respond((method,body)=>{if(method==='sendMessage'&&body.chat_id===42&&!throttled){throttled=true;return Response.json({ok:false,error_code:429,parameters:{retry_after:17}},{status:429});}});
    await f.alarm();assert.equal((await f.state()).pending,2);assert.equal(f.alarms.at(-1),Date.now()+17000);
    f.restart();await f.alarm();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
    f.advance(17000);await f.alarm();assert.equal((await f.state()).sent,2);assert.equal((await f.state()).status,'completed');
    assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&c.body.chat_id===43).length,1);
  }finally{f.close();}
});

test('stop takes effect between recipients and an interrupted in-flight send is never replayed on restart',async()=>{
  const f=fixture();try{
    f.addUsers(3);await f.start();
    f.db.prepare("UPDATE broadcast_recipients SET state='sending' WHERE user_id='42'").run();
    f.restart();
    f.respond(async(method,body)=>{if(method==='sendMessage'&&body.chat_id===43)await f.request({action:'stop',id:'7'});});
    await f.alarm();const state=await f.state();assert.equal(state.status,'stopped');assert.equal(state.unknown,1);assert.equal(state.sent,1);assert.equal(state.pending,1);
    assert.ok(!f.calls.some(c=>c.method==='sendMessage'&&[42,44].includes(c.body.chat_id)));
    await f.alarm();assert.equal(f.calls.filter(c=>c.method==='sendMessage').length,1);
  }finally{f.close();}
});

test('composer previews native text and photo captions; only the administrator can start a broadcast',async()=>{
  const f=fixture();try{
    f.addUsers(2);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose',99),f.env,{});assert.equal(f.calls.length,0);
    assert.equal((await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose',api.ADMIN_USER_ID,'forged'),f.env,{})).status,403);
    assert.equal(f.calls.length,0);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose'),f.env,{});
    const content={text:text.text,entities:text.entities};
    await api.worker.fetch(f.webhook(content),f.env,{});
    const preview=f.calls.filter(c=>c.method==='sendMessage'&&c.body.text===text.text).at(-1).body;
    assert.deepEqual(preview.entities,text.entities);assert.equal(preview.parse_mode,undefined);
    assert.equal(await f.state(),null);
    const controls=f.calls.filter(c=>c.method==='sendMessage'&&c.body.reply_markup).at(-1).body;
    assert.ok(controls.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:broadcast:start:7'));
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:start:7'),f.env,{});
    assert.equal((await f.state()).pending,2);
    await f.alarm();assert.equal((await f.state()).sent,2);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose'),f.env,{});
    await api.worker.fetch(f.webhook({message_id:8,photo:[{file_id:'small'},{file_id:'large'}],caption:'تیتر',caption_entities:[{type:'bold',offset:0,length:4}]}),f.env,{});
    const photo=f.calls.filter(c=>c.method==='sendPhoto').at(-1).body;
    assert.equal(photo.photo,'large');assert.deepEqual(photo.caption_entities,[{type:'bold',offset:0,length:4}]);
    assert.ok(api.adminDashboardKeyboard().inline_keyboard.flat().some(b=>b.callback_data==='admin:broadcast'));
  }finally{f.close();}
});

test('empty audience finishes immediately; stale drafts and concurrent campaigns cannot create extra sends',async()=>{
  const f=fixture();try{
    assert.equal((await f.request({action:'start',version:7,messageId:90})).status,409);
    assert.equal((await f.start()).status,'completed');assert.equal(f.alarms.length,0);
    f.addUsers(1);await f.start(text,8);
    const compose=await (await f.request({action:'compose'})).json();assert.equal(compose.status.id,'8');
    const other=await (await f.request({action:'start',version:9,messageId:90})).json();assert.equal(other.status.id,'8');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM broadcast_jobs').get().n,2);
  }finally{f.close();}
});


test('a failed content preview never starts a campaign and cancelling composer discards its draft',async()=>{
  const f=fixture();try{
    f.addUsers(1);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose'),f.env,{});
    f.respond((method,body)=>method==='sendPhoto'?Response.json({ok:false,error_code:400},{status:400}):undefined);
    await api.worker.fetch(f.webhook({photo:[{file_id:'invalid-photo'}]}),f.env,{});
    assert.equal(await f.state(),null);assert.equal(f.alarms.length,0);
    assert.ok(!f.calls.some(c=>c.method==='sendMessage'&&c.body.chat_id===42));
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:cancel'),f.env,{});
    assert.equal((await f.request({action:'start',version:7,messageId:90})).status,409);
  }finally{f.close();}
});

test('progress is published before deliveries and continues during slow batches without claiming messages were read',async()=>{
  const f=fixture();try{
    f.addUsers(3);await f.start();
    f.respond((method,body)=>{if(method==='sendMessage'&&body.chat_id!==api.ADMIN_USER_ID)f.advance(2500);});
    await f.alarm();
    const firstEdit=f.calls.findIndex(c=>c.method==='editMessageText'),firstSend=f.calls.findIndex(c=>c.method==='sendMessage');
    assert.ok(firstEdit>=0&&firstEdit<firstSend);
    const updates=f.calls.filter(c=>c.method==='editMessageText');
    assert.ok(updates.some(c=>c.body.text.includes('ارسال موفق: 1')));
    assert.match(updates.at(-1).body.text,/وضعیت خواندن مشخص نیست/);
  }finally{f.close();}
});

test('ADMIN_IDS adds validated administrators without replacing the owner or leaking between environments',()=>{
  const env={ADMIN_IDS:'123456789, 123456789\n987654321 bad 1e3 -42 0 9007199254740992 0x2a 12.5 @admin'};
  assert.deepEqual(api.getAdminIds(env),[api.ADMIN_USER_ID,123456789,987654321]);
  assert.equal(api.isAdmin(env,123456789),true);
  for(const id of [42,'123456789',undefined,null,NaN]) assert.equal(api.isAdmin(env,id),false);
  assert.equal(api.isAdmin({},123456789),false);
  assert.equal(api.isAdmin({ADMIN_IDS:'invalid'},api.ADMIN_USER_ID),true);
});

test('additional admin opens the real panel and changes settings; outsiders and revoked admins cannot',async()=>{
  const second=123456789,f=fixture({ADMIN_IDS:String(second)});
  try{
    await api.worker.fetch(f.webhook({text:'/admin'},undefined,second),f.env,{});
    assert.ok(f.calls.some(c=>c.body.chat_id===second&&c.body.reply_markup?.inline_keyboard.flat().some(b=>b.callback_data==='admin:broadcast')));
    await api.worker.fetch(f.webhook(undefined,'admin:membership:disable',second),f.env,{});
    assert.equal((await (await f.env.ADMIN_STATS.getByName('global').fetch('https://store/membership')).json()).enabled,false);
    const before=f.calls.length;
    await api.worker.fetch(f.webhook(undefined,'admin:membership:enable',99),f.env,{});
    await api.worker.fetch(f.webhook(undefined,'admin:membership:enable',second),{...f.env,ADMIN_IDS:''},{});
    assert.equal(f.calls.length,before);
    assert.equal((await (await f.env.ADMIN_STATS.getByName('global').fetch('https://store/membership')).json()).enabled,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
    const payload={chat_id:second,text:'❌ خطای پنل',_errorDetail:'private diagnostic'};
    assert.match(api.telegramCustomEmoji('sendMessage',payload,f.env).text,/private diagnostic/);
    assert.ok(!api.telegramCustomEmoji('sendMessage',{...payload,chat_id:-100},f.env).text.includes('private diagnostic'));
  }finally{f.close();}
});

test('two admins keep separate drafts and colliding message IDs; progress returns to the sender after restart',async()=>{
  const second=123456789,f=fixture({ADMIN_IDS:String(second)});
  const visit=(id,message,callback)=>api.worker.fetch(f.webhook(message,callback,id),f.env,{});
  try{
    f.addUsers(2);
    for(const id of [api.ADMIN_USER_ID,second]) f.db.prepare('INSERT INTO users(id,first_seen,last_seen) VALUES (?,?,?)').run(String(id),Date.now(),Date.now());
    for(const id of [api.ADMIN_USER_ID,second]) await visit(id,undefined,'admin:broadcast:compose');
    await visit(api.ADMIN_USER_ID,{text:'پیام مالک'});
    await visit(second,{text:text.text,entities:text.entities});
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM broadcast_draft').get().n,2);
    await visit(second,undefined,'admin:broadcast:start:7');
    assert.equal((await f.state()).id,`${second}-7`);
    assert.equal((await f.state()).total,2);
    f.restart();await f.alarm();
    const sent=f.calls.filter(c=>c.method==='sendMessage'&&[42,43].includes(c.body.chat_id));
    assert.equal(sent.length,2);for(const c of sent) assert.deepEqual(c.body.entities,text.entities);
    const progress=f.calls.filter(c=>c.method==='editMessageText'&&c.body.chat_id===second).at(-1).body;
    assert.match(progress.text,/ارسال موفق: 2/);assert.ok(progress.reply_markup);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM broadcast_draft').get().n,1);
    await visit(api.ADMIN_USER_ID,undefined,'admin:broadcast:start:7');
    await f.alarm();
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM broadcast_jobs').get().n,2);
    assert.equal((await f.state('7')).sent,2);
    assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&[42,43].includes(c.body.chat_id)&&c.body.text==='پیام مالک').length,2);
    await visit(second,undefined,'admin:broadcast:start:7');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM broadcast_jobs').get().n,2);
  }finally{f.close();}
});

test('legacy draft migrates without loss and private composer cannot be driven from a group',async()=>{
  const second=123456789,f=fixture({ADMIN_IDS:String(second)},true);
  try{
    assert.equal(f.db.prepare('SELECT id,waiting FROM broadcast_draft').get().id,api.ADMIN_USER_ID);
    f.restart();assert.equal(f.db.prepare('SELECT waiting FROM broadcast_draft').get().waiting,1);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:compose',second),f.env,{});
    await api.worker.fetch(f.webhook({text:'group text',chat:{id:-100}},undefined,second),f.env,{});
    assert.equal(f.db.prepare('SELECT waiting FROM broadcast_draft WHERE id=?').get(second).waiting,1);
    const denied=await f.env.ADMIN_STATS.getByName('global').fetch('https://store/broadcast?adminId=99',{method:'POST',body:JSON.stringify({action:'compose'})});
    assert.equal(denied.status,403);
    await api.worker.fetch(f.webhook(undefined,'admin:broadcast:cancel',second),f.env,{});
    assert.equal(f.db.prepare('SELECT waiting FROM broadcast_draft WHERE id=?').get(api.ADMIN_USER_ID).waiting,1);
  }finally{f.close();}
});
