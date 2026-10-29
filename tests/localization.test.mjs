import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const { outputFiles } = await build({stdin:{contents:'export * from "./src/localization"; export * from "./src/admin"; export { default as worker } from "./src/app-main";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false,
 plugins:[{name:'runtime',setup(b){
  b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
  b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject {} export class WorkflowEntrypoint {}':'export class Container {} export function getContainer(){throw Error("unexpected download");}'}));
 }}]});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const catalog = JSON.parse(readFileSync('locales/messages.json','utf8'));
const errors = JSON.parse(readFileSync('container/public_errors.json','utf8'));
function fixture(){
 const saved=new Map(), menus=new Map(), calls=[];
 const env={BOT_TOKEN:'fake',WEBHOOK_SECRET:'test',ADMIN_STATS:{getByName(){return {async fetch(url,init){
   const parsed=new URL(url);
   if(parsed.pathname==='/language-menu'){
     const key=parsed.search;
     if(init?.method==='POST')menus.set(key,JSON.parse(init.body).messageId);
     return Response.json({messageId:menus.get(key)});
   }
   const id=parsed.searchParams.get('user');
   if(init?.method==='POST')saved.set(id,JSON.parse(init.body).language);
   return Response.json({language:saved.get(id)||'fa'});
 }}}}};
 const request=update=>new Request('https://bot/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test'},body:JSON.stringify(update)});
 return {saved,calls,env,request};
}
test('every public error has friendly English and Russian translations',()=>{
 assert.equal(new Set(catalog.map(r=>r.fa)).size,catalog.length);
 for(const error of errors)for(const lang of ['en','ru']){
  const result=api.translate(error.message,lang);
  assert.notEqual(result,error.message); assert.ok(!/\p{Script=Arabic}/u.test(result));
 }
});
test('dynamic statuses preserve numbers and formatting uses UTF-16 offsets',()=>{
 for(const lang of ['en','ru']){
  assert.ok(!/\p{Script=Arabic}/u.test(api.translate('📤 در حال ارسال فایل 2/5 اینستاگرام…',lang)));
  const text='⚡️ ادامه با عضویت در چنل\nبعد از عضویت در چنل، «عضو شدم» رو بزن.';
  const phrase='ادامه با عضویت در چنل';
  const out=api.localizePayload({text,entities:[{type:'bold',offset:text.indexOf(phrase),length:phrase.length}],reply_markup:{inline_keyboard:[[{text:'✅ عضو شدم',callback_data:'membership:check'}]]}},lang);
  assert.equal(out.text.slice(out.entities[0].offset,out.entities[0].offset+out.entities[0].length),api.translate(phrase,lang));
  assert.equal(out.reply_markup.inline_keyboard[0][0].callback_data,'membership:check');
 }
});
test('Persian payloads remain unchanged',()=>{
 const payload={text:'سلام',entities:[],reply_markup:{inline_keyboard:[]}};
 assert.equal(api.localizePayload(payload,'fa'),payload);
});
test('/lang persists per user, supports bot mentions and protects group buttons',async()=>{
 const f=fixture(),previous=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{f.calls.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:900}});};
 try{
  const command=(id,text)=>({message:{message_id:1,chat:{id:-100},from:{id},text}});
  await api.handleLanguageUpdate(f.request(command(42,'/lang@MyBot ru')),f.env);
  assert.equal(await api.userLanguage(f.env,42),'ru');
  assert.equal(await api.userLanguage(f.env,43),'fa');
  assert.match(f.calls.at(-1).text,/Готово/);
  await api.handleLanguageUpdate(f.request({callback_query:{id:'cb',from:{id:43},message:{chat:{id:-100}},data:'lang:en:42'}}),f.env);
  assert.equal(await api.userLanguage(f.env,42),'ru');
  assert.equal(await api.userLanguage(f.env,43),'fa');
  await api.handleLanguageUpdate(f.request(command(42,'/lang fa')),f.env);
  assert.equal(await api.userLanguage(f.env,42),'fa');
  const bad=f.request(command(42,'/lang en'));bad.headers.set('x-telegram-bot-api-secret-token','bad');
  assert.equal(await api.handleLanguageUpdate(bad,f.env),null);
 }finally{globalThis.fetch=previous;}
});
test('concurrent requests keep their own language across awaits',async()=>{
 const f=fixture();f.saved.set('42','en');f.saved.set('43','ru');
 const result=await Promise.all([42,43].map(id=>api.withUserLanguage(f.env,id,async()=>{
  await new Promise(r=>setTimeout(r,id===42?10:1));
  return api.localizePayload({text:'🎵 فقط صدا'}).text;
 })));
 assert.deepEqual(result,['🎵 Audio only','🎵 Только звук']);
});

test('language preferences survive store instances without changing existing records',async()=>{
 const values=new Map([['other-setting','untouched']]);
 const store=()=>Object.assign(Object.create(api.AdminStatsStore.prototype),{ctx:{storage:{async get(key){return values.get(key);},async put(key,value){values.set(key,value);}}}});
 const request=(method='GET',language)=>new Request('https://admin-stats/language?user=42',{method,...(language?{body:JSON.stringify({language})}:{})});
 assert.equal((await (await store().fetch(request())).json()).language,'fa');
 await store().fetch(request('POST','ru'));
 assert.equal((await (await store().fetch(request())).json()).language,'ru');
 assert.equal(values.get('other-setting'),'untouched');
 assert.equal((await store().fetch(request('POST','xx'))).status,400);
});
test('final error decoration keeps translated errors and strips internal diagnostics',async()=>{
 const f=fixture();f.saved.set('42','ru');
 await api.withUserLanguage(f.env,42,async()=>{
   const out=api.telegramCustomEmoji('sendMessage',{chat_id:42,text:errors.at(-1).message});
   assert.equal(out.text,api.translate(errors.at(-1).message,'ru'));
   assert.equal(api.telegramCustomEmoji('sendMessage',out).text,out.text);
   assert.ok(out.entities.every(e=>e.offset+e.length<=out.text.length));
   const clean=api.privateErrorPayload('sendMessage',{...out,_errorDetail:'PRIVATE'});
   assert.ok(!JSON.stringify(clean).includes('PRIVATE'));
 });
});
test('the production boundary handles /lang before membership and download gates',async()=>{
 const f=fixture(),previous=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:900}});
 try{
  const result=await api.worker.fetch(f.request({message:{chat:{id:42},from:{id:42},text:'/lang en'}}),f.env,{});
  assert.equal(result.status,200);
  assert.equal(f.saved.get('42'),'en');
 }finally{globalThis.fetch=previous;}
});
test('multiline prompts, bold help labels and restriction durations translate completely',()=>{
 for(const lang of ['en','ru']){
  for(const source of [
   '🎵 کیفیت صدای Bandcamp را انتخاب کن:\nفقط فرمت‌های قابل‌دریافت نمایش داده می‌شوند. انتخاب تا ۸ دقیقه فعال است.',
   '🔴 ضبط Live شروع شد.\nاز این لحظه تا پایان پخش یا توقف ضبط ذخیره می‌شود.\nسقف هر ضبط: 2 ساعت یا 1.9 GB.',
   'زمان باقی‌مانده: ۱ ساعت و ۳ دقیقه',
  ]) assert.ok(!/\p{Script=Arabic}/u.test(api.translate(source,lang)));
  assert.notEqual(api.translate('دانلود:',lang),'دانلود:');
 }
});

test('language clicks and repeated commands animate one saved menu with custom emoji',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
  const method=url.split('/').at(-1),body=JSON.parse(init.body);
  calls.push({method,...body});
  return Response.json({ok:true,result:{message_id:900}});
 };
 try{
  const command=id=>f.request({message:{message_id:id,chat:{id:42},from:{id:42},text:'/lang'}});
  await api.handleLanguageUpdate(command(100),f.env);
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
  const first=calls.filter(c=>c.method==='sendMessage'||c.method==='editMessageText');
  assert.equal(first.length,4);
  assert.ok(first[0].text.length<first.at(-1).text.length);
  assert.equal(first.at(-1).entities.find(e=>e.type==='custom_emoji').custom_emoji_id,'5282843764451195532');
  await api.handleLanguageUpdate(f.request({callback_query:{id:'cb',from:{id:42},message:{message_id:900,chat:{id:42}},data:'lang:ru:42'}}),f.env);
  const last=calls.filter(c=>c.method==='editMessageText').at(-1);
  assert.equal(last.message_id,900);assert.match(last.text,/Готово/);
  assert.equal(last.entities.find(e=>e.type==='custom_emoji').custom_emoji_id,'5352871660024246779');
  await api.handleLanguageUpdate(command(101),f.env);
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
  assert.deepEqual(calls.filter(c=>c.method==='deleteMessage').map(c=>c.message_id),[100,101]);
  assert.ok(calls.filter(c=>c.method==='editMessageText').every(c=>c.message_id===900));
 }finally{globalThis.fetch=previous;}
});
test('deleted language menus are recreated, but temporary edit failures never duplicate them',async()=>{
 const f=fixture(),previous=globalThis.fetch,calls=[];
 let failure='';
 globalThis.fetch=async(url,init)=>{
  const method=url.split('/').at(-1),body=JSON.parse(init.body);calls.push({method,...body});
  if(method==='editMessageText'&&failure)return Response.json({ok:false,description:failure},{status:400});
  return Response.json({ok:true,result:{message_id:901}});
 };
 const command=()=>f.request({message:{chat:{id:42},from:{id:42},text:'/lang'}});
 try{
  await api.handleLanguageUpdate(command(),f.env);
  failure='Too Many Requests';
  await assert.rejects(api.handleLanguageUpdate(command(),f.env));
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
  failure='message to edit not found';
  // Let the replacement menu animate normally once Telegram returns its new ID.
  const mock=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
   if(url.endsWith('/sendMessage')){const result=await mock(url,init);failure='';return result;}
   return mock(url,init);
  };
  await api.handleLanguageUpdate(command(),f.env);
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,2);
  assert.deepEqual(calls.filter(c=>c.method==='deleteMessage').map(c=>c.message_id),[901]);
 }finally{globalThis.fetch=previous;}
});
