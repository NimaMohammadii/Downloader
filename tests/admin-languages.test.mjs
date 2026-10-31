import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const {outputFiles}=await build({stdin:{contents:'export * from "./src/admin"; export * from "./src/membership"; export * from "./src/admin-languages"; export {default as worker} from "./src/app-main";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,
 plugins:[{name:'runtime',setup(b){
  b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
  b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}}':'export class Container{} export function getContainer(){throw Error("download must not start");}'}));
 }}]});
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const PERIODS=['4h','7d','30d','all'],LANGUAGES=['fa','en','ru'];
function fixture(){
 const db=new DatabaseSync(':memory:'),values=new Map();
 const sql={exec(query,...params){
  let rows=[],changes=0;
  if(/^\s*SELECT/i.test(query))rows=db.prepare(query).all(...params);
  else if(params.length)changes=Number(db.prepare(query).run(...params).changes);
  else db.exec(query);
  return {toArray:()=>rows,one:()=>rows[0],rowsWritten:changes};
 }};
 const storage={sql,async get(key){return values.get(key);},async put(key,value){values.set(key,structuredClone(value));},async delete(key){values.delete(key);},
  async list({prefix='',startAfter='',limit=1000}={}){return new Map([...values].filter(([key])=>key.startsWith(prefix)&&key>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));},
  transactionSync(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
  async transaction(fn){return fn(storage);},async getAlarm(){return null;},async setAlarm(){},async deleteAlarm(){},
 };
 const storeEnv={ADMIN_IDS:'123456789'};
 let store=new api.AdminStatsStore({storage},storeEnv);
 const request=(path,body,method)=>store.fetch(new Request(`https://store${path}`,body===undefined?{method:method||'GET'}:{method:method||'POST',body:JSON.stringify(body)}));
 const env={...storeEnv,BOT_TOKEN:'language-test',WEBHOOK_SECRET:'test-secret',ADMIN_STATS:{getByName(){return {fetch:(input,init)=>store.fetch(new Request(input,init))};}}};
 const add=(id,lastSeen=Date.now())=>sql.exec('INSERT INTO users(id,username,first_name,last_seen,first_seen) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',String(id),`user${id}`,`User ${id}`,lastSeen,lastSeen);
 const language=(id,language)=>request(`/language?user=${id}`,{language});
 const setting=(language,enabled,actorId=api.ADMIN_USER_ID)=>request('/membership-languages',{language,enabled,actorId});
 const webhook=(id,data,text)=>new Request('https://worker/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test-secret'},body:JSON.stringify(data?{callback_query:{id:'cb',from:{id},data,message:{message_id:70,chat:{id}}}}:{update_id:1,message:{message_id:10,from:{id},chat:{id},text}})});
 return {env,sql,db,values,request,add,language,setting,webhook,restart(){store=new api.AdminStatsStore({storage},storeEnv);},close(){db.close();}};
}

test('all eight language combinations, global switch and existing membership modes persist independently',async()=>{
 const f=fixture();
 try{
  for(let i=0;i<3;i++){f.add(40+i);await f.language(40+i,LANGUAGES[i]);}
  for(let mask=0;mask<8;mask++){
   for(let i=0;i<3;i++)assert.equal((await f.setting(LANGUAGES[i],Boolean(mask&(1<<i)))).status,200);
   for(const mode of ['start','first_link','after_download']){
    await f.request('/membership',{enabled:true,mode});
    for(let i=0;i<3;i++){
     const state=await api.membershipState(f.env,40+i);
     assert.equal(state.enabled,Boolean(mask&(1<<i)));assert.equal(state.mode,mode);
    }
   }
   f.restart();
   assert.deepEqual((await api.membershipState(f.env)).languages,Object.fromEntries(LANGUAGES.map((l,i)=>[l,Boolean(mask&(1<<i))])));
   await f.request('/membership',{enabled:false});
   for(let i=0;i<3;i++)assert.equal((await api.membershipState(f.env,40+i)).enabled,false);
  }
  await f.request('/membership',{enabled:true});await f.setting('fa',false);
  assert.equal((await api.membershipState(f.env,999)).enabled,false); // no preference = Persian
  await f.setting('ru',true);await f.language(40,'ru');
  assert.equal((await api.membershipState(f.env,40)).enabled,true);
 }finally{f.close();}
});
test('invalid/unauthorized settings cannot mutate language policy',async()=>{
 const f=fixture();try{
  assert.equal((await f.setting('ru',false,42)).status,403);
  assert.equal((await f.setting('xx',false)).status,400);
  assert.equal((await f.setting('ru','false')).status,400);
  assert.equal((await f.request('/membership-languages',undefined,'GET')).status,405);
  assert.deepEqual((await api.membershipState(f.env)).languages,{fa:true,en:true,ru:true});
  assert.equal((await f.setting('ru',false,123456789)).status,200);
 }finally{f.close();}
});
test('membership checks and first-download notices apply only to enabled user languages',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
  const method=String(url).split('/').at(-1);calls.push({method,body:JSON.parse(init.body)});
  if(method==='sendMessageDraft')throw Error('draft unsupported in fixture');
  return Response.json({ok:true,result:method==='getChatMember'?{status:'left'}:{message_id:80}});
 };
 try{
  await f.request('/membership',{enabled:true,mode:'start'});
  for(const language of LANGUAGES)await f.setting(language,language==='ru');
  for(let i=0;i<3;i++){
   const id=40+i;f.add(id);await f.language(id,LANGUAGES[i]);calls.length=0;
   const result=await api.enforceMembership(f.webhook(id,undefined,'https://youtube.com/watch?v=abcdefghijk'),f.env);
   assert.equal(result instanceof Response,LANGUAGES[i]==='ru');
   assert.equal(calls.some(c=>c.method==='getChatMember'),LANGUAGES[i]==='ru');
  }
  await f.request('/membership',{mode:'after_download'});
  for(let i=0;i<3;i++){
   f.sql.exec('INSERT INTO membership_access(user_id,first_download_at) VALUES (?,?)',String(40+i),Date.now());
   calls.length=0;await api.notifyFirstDownload(f.env,40+i);
   assert.equal(calls.some(c=>c.method==='sendMessage'),LANGUAGES[i]==='ru');
  }
  await f.language(42,'en');calls.length=0;
  assert.equal(await api.enforceMembership(f.webhook(42,undefined,'/music hello'),f.env),null);
  assert.equal(calls.length,0);
 }finally{globalThis.fetch=previous;f.close();}
});
test('statistics count unique active users at exact rolling boundaries and match every filtered list',async()=>{
 const f=fixture(),realNow=Date.now,now=1_800_000_000_000;Date.now=()=>now;
 try{
  for(const [id,age,lang]of [[40,0,'ru'],[41,4*3600_000,'en'],[42,4*3600_000+1,'fa'],[43,7*86400_000,'ru'],[44,7*86400_000+1,'en'],[45,30*86400_000,'fa'],[46,30*86400_000+1,'ru'],[47,-1,'en']]){
   f.add(id,now-age);await f.language(id,lang);
  }
  f.add(48,now); // implicit Persian, distinct from an explicit selection
  f.add(api.ADMIN_USER_ID,now);f.add(123456789,now);
  let summary=await(await f.request('/language-stats')).json();
  assert.deepEqual(summary.periods['4h'],{fa:1,en:1,ru:1});
  assert.deepEqual(summary.periods['7d'],{fa:2,en:1,ru:2});
  assert.deepEqual(summary.periods['30d'],{fa:3,en:2,ru:2});
  assert.deepEqual(summary.periods.all,{fa:3,en:2,ru:3});
  for(const period of PERIODS)for(const language of LANGUAGES){
   const list=await(await f.request(`/language-users?period=${period}&language=${language}`)).json();
   assert.equal(list.totalUsers,summary.periods[period][language]);
   assert.equal(list.users.length,list.totalUsers);
  }
  const defaults=await(await f.request('/language-users?language=fa&period=4h')).json();
  assert.equal(defaults.users[0].id,'48');assert.equal(defaults.users[0].selected,false);
  await f.language(40,'en');f.restart();
  summary=await(await f.request('/language-stats')).json();
  assert.deepEqual(summary.periods['4h'],{fa:1,en:2,ru:0});
  for(const [id,lang,selected]of [[40,'en',true],[48,'fa',false]]){
   const detail=await api.getAdminUserDetail(f.env,String(id),0);
   assert.equal(detail.language,lang);assert.equal(detail.languageSelected,selected);
   assert.match(api.formatAdminUserDetail(detail),/🌐 زبان:/);
  }
 }finally{Date.now=realNow;f.close();}
});
test('old preferences import in batches without overwriting new choices; user pagination is stable',async()=>{
 const f=fixture();try{
  for(let i=0;i<510;i++){f.add(1000+i,Date.now()-i);f.values.set(`language:${1000+i}`,'ru');}
  await f.language(1000,'en');
  const counts=await(await f.request('/language-stats')).json();
  assert.deepEqual(counts.periods.all,{fa:0,en:1,ru:509});
  const first=await(await f.request('/language-users?language=ru&page=0')).json();
  const second=await(await f.request('/language-users?language=ru&page=1')).json();
  const last=await(await f.request('/language-users?language=ru&page=999999')).json();
  assert.equal(first.users.length,8);assert.equal(first.totalPages,64);assert.equal(last.page,63);assert.equal(last.users.length,5);
  assert.ok(!first.users.some(u=>second.users.some(v=>v.id===u.id)));
  f.restart();assert.deepEqual((await(await f.request('/language-stats')).json()).periods,counts.periods);
  for(const path of ['/language-users?language=xx','/language-users?language=ru&page=-1','/language-stats?period=__proto__'])assert.equal((await f.request(path)).status,400);
 }finally{f.close();}
});
test('real admin callbacks edit in place, support language lists/details/back, and reject outsiders',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[],realPerformance=performance.now;
 let clock=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>clock+=10000});
 globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:70}});};
 const click=(data,id=api.ADMIN_USER_ID)=>api.worker.fetch(f.webhook(id,data),f.env,{});
 const edit=()=>calls.filter(c=>c.method==='editMessageText').at(-1)?.body;
 try{
  f.add(42);await f.language(42,'ru');
  await click('admin:languages:4h');assert.match(edit().text,/۴ ساعت گذشته/);assert.match(edit().text,/روسی/);
  const list=edit().reply_markup.inline_keyboard.flat().find(b=>b.callback_data==='admin:langusers:ru:4h:0');assert.ok(list);
  await click(list.callback_data);assert.match(edit().text,/شناسه: 42/);
  const detail=edit().reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith('admin:languser:42:'));assert.ok(detail);
  await click(detail.callback_data);assert.match(edit().text,/زبان: روسی/);
  assert.ok(edit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:langusers:ru:4h:0'));
  await click('admin:subuser:42:0:0');assert.match(edit().text,/زبان ربات: روسی/);
  await click('admin:membership:language:ru:off');assert.equal((await api.membershipState(f.env,42)).enabled,false);
  assert.ok(edit().reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:membership:language:ru:on'));
  await click('admin:membership:language:en:off',123456789);assert.equal((await api.membershipState(f.env)).languages.en,false);
  const before=calls.length;
  await click('admin:languages:all',42);await click('admin:membership:language:ru:on',42);
  assert.equal(calls.length,before);assert.equal((await api.membershipState(f.env,42)).enabled,false);
  assert.ok(calls.filter(c=>c.method==='editMessageText').every(c=>c.body.message_id===70));
  assert.ok(!calls.some(c=>c.method==='sendMessage'));
 }finally{Object.defineProperty(performance,'now',{configurable:true,value:realPerformance});globalThis.fetch=previous;f.close();}
});
test('active language reports include gated users and menu interactions without changing download/link counters',async()=>{
 const f=fixture(),previous=globalThis.fetch,realNow=Date.now,now=1_800_000_000_000;Date.now=()=>now;
 globalThis.fetch=async(url)=>{
  const method=String(url).split('/').at(-1);
  if(method==='sendMessageDraft')throw Error('no drafts');
  return Response.json({ok:true,result:method==='getChatMember'?{status:'left'}:{message_id:70}});
 };
 try{
  f.add(42,now-40*86400_000);await f.language(42,'ru');
  f.sql.exec('UPDATE users SET links_sent=5 WHERE id=?','42');
  await f.request('/membership',{mode:'start',enabled:true});
  assert.equal((await(await f.request('/language-stats')).json()).periods['4h'].ru,0);
  await api.worker.fetch(f.webhook(42,undefined,'/music hello'),f.env,{});
  assert.equal((await(await f.request('/language-stats')).json()).periods['4h'].ru,1);
  assert.equal(f.sql.exec('SELECT links_sent FROM users WHERE id=?','42').one().links_sent,5);
  assert.equal(f.sql.exec('SELECT COUNT(*) AS count FROM download_history').one().count,0);
  assert.equal(f.sql.exec('SELECT COUNT(*) AS count FROM user_activity').one().count,0);
  const bad=f.webhook(99,undefined,'/lang');bad.headers.set('x-telegram-bot-api-secret-token','forged');
  await api.worker.fetch(bad,f.env,{});
  assert.equal(f.sql.exec('SELECT COUNT(*) AS count FROM users WHERE id=?','99').one().count,0);
 }finally{Date.now=realNow;globalThis.fetch=previous;f.close();}
});
