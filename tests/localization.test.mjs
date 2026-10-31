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
   if(parsed.pathname==='/language-presence') return Response.json({ok:true});
   if(parsed.pathname==='/record') return Response.json({ok:true});
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
 const store=()=>Object.assign(Object.create(api.AdminStatsStore.prototype),{ctx:{storage:{sql:{exec(){}},async get(key){return values.get(key);},async put(key,value){values.set(key,value);}}}});
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


function telegramSimulator({ failDrafts = false, failPreview = false, failFinalSend = false, stickerEmoji = '🌐' } = {}) {
 const messages = new Map([[40, {text:'https://example.org/download',document:{file_id:'download'}}]]);
 const calls = []; let next = 900, editCalls = 0;
 return { messages, calls, async fetch(url, init) {
  const method = url.split('/').at(-1), body = JSON.parse(init.body);
  calls.push({method,...body});
  const ok = result => Response.json({ok:true,result});
  const fail = description => Response.json({ok:false,description},{status:400});
  if (method === 'getCustomEmojiStickers') return ok([{custom_emoji_id:body.custom_emoji_ids[0],emoji:body.custom_emoji_ids[0]==='5282843764451195532'?stickerEmoji:'✅'}]);
  if (method === 'sendMessageDraft') return failDrafts ? fail('drafts unavailable') : ok(true);
  if (method === 'answerCallbackQuery') return ok(true);
  if (method === 'deleteMessage') { messages.delete(body.message_id);return ok(true); }
  if (method === 'sendMessage') {
   if(failFinalSend)return fail('send failed');
   const message_id = next++; messages.set(message_id,body); return ok({message_id});
  }
  if (method === 'editMessageText') {
   editCalls++;
   if(failPreview && editCalls===1)return fail('temporary edit failure');
   if(!messages.has(body.message_id))return fail('message to edit not found');
   messages.set(body.message_id,body);return ok({message_id:body.message_id});
  }
  throw Error('unexpected method '+method);
 }};
}
const privateCommand=(f,id=100)=>f.request({message:{message_id:id,chat:{id:42},from:{id:42},text:'/lang'}});
const selection=(f,id,code='ru')=>f.request({callback_query:{id:'cb',from:{id:42},message:{message_id:id,chat:{id:42}},data:`lang:${code}:42`}});
test('reopening /lang delivers a fresh full menu before removing the old one and the command',async()=>{
 const f=fixture(),tg=telegramSimulator(),previous=globalThis.fetch;
 globalThis.fetch=tg.fetch;
 try{
  tg.messages.set(100,{text:'/lang'});
  await api.handleLanguageUpdate(privateCommand(f),f.env);
  const first=tg.calls.find(c=>c.method==='sendMessage');
  assert.match(first.text,/زبان دلخواهت/); // first persistent message is complete, never a prefix
  tg.messages.set(101,{text:'/lang'});
  await api.handleLanguageUpdate(privateCommand(f,101),f.env);
  assert.equal(tg.calls.filter(c=>c.method==='sendMessage').length,2);
  assert.deepEqual([...tg.messages.keys()],[40,901]); // newest menu stays at the current chat position
  const sends=tg.calls.map((c,i)=>c.method==='sendMessage'?i:-1).filter(i=>i>=0);
  const deletion=tg.calls.findIndex(c=>c.method==='deleteMessage'&&c.message_id===900);
  assert.ok(deletion>sends[1]);
  assert.deepEqual(tg.messages.get(40),{text:'https://example.org/download',document:{file_id:'download'}});
 }finally{globalThis.fetch=previous;}
});
test('language buttons edit the visible menu; failed motion still delivers complete text',async()=>{
 const f=fixture(),tg=telegramSimulator({failPreview:true}),previous=globalThis.fetch;
 globalThis.fetch=tg.fetch;
 try{
  await api.handleLanguageUpdate(privateCommand(f),f.env);
  await api.handleLanguageUpdate(selection(f,900),f.env);
  assert.equal(tg.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.match(tg.messages.get(900).text,/Готово/);
  assert.equal(tg.calls.filter(c=>c.method==='editMessageText').length,2); // failed preview then complete final
  assert.equal(tg.messages.get(900).entities.find(e=>e.type==='custom_emoji').custom_emoji_id,'5352871660024246779');
 }finally{globalThis.fetch=previous;}
});
test('draft failures cannot hide the full menu; emoji text matches Telegram metadata with valid UTF-16 entities',async()=>{
 const f=fixture(),tg=telegramSimulator({failDrafts:true,stickerEmoji:'🗺️'}),previous=globalThis.fetch;
 globalThis.fetch=tg.fetch;
 try{
  await api.handleLanguageUpdate(privateCommand(f),f.env);
  const menu=tg.messages.get(900);
  assert.match(menu.text,/زبان دلخواهت/);
  const entity=menu.entities.find(e=>e.type==='custom_emoji');
  assert.equal(menu.text.slice(entity.offset,entity.offset+entity.length),'🗺️');
  assert.equal(entity.custom_emoji_id,'5282843764451195532');
  assert.ok(menu.entities.every(e=>e.offset+e.length<=menu.text.length));
  const bold=menu.entities.find(e=>e.type==='bold');
  assert.ok(bold.offset>=entity.length); // no overlapping emoji and bold entities
  assert.equal(menu.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,'5352871660024246779');
 }finally{globalThis.fetch=previous;}
});
test('a failed final send preserves both the command and the existing menu',async()=>{
 const f=fixture(),tg=telegramSimulator({failFinalSend:true}),previous=globalThis.fetch;
 await f.env.ADMIN_STATS.getByName('global').fetch('https://admin-stats/language-menu?user=42&chat=42',{method:'POST',body:JSON.stringify({messageId:850})});
 tg.messages.set(850,{text:'old language menu'});tg.messages.set(100,{text:'/lang'});
 globalThis.fetch=tg.fetch;
 try{
  await assert.rejects(api.handleLanguageUpdate(privateCommand(f),f.env));
  assert.equal(tg.calls.filter(c=>c.method==='deleteMessage').length,0);
  assert.deepEqual([...tg.messages.keys()],[40,850,100]);
 }finally{globalThis.fetch=previous;}
});
test('a deleted callback menu is replaced only after Telegram confirms it is missing',async()=>{
 const f=fixture(),tg=telegramSimulator(),previous=globalThis.fetch;globalThis.fetch=tg.fetch;
 try{
  await api.handleLanguageUpdate(selection(f,800),f.env);
  assert.match(tg.messages.get(900).text,/Готово/);
  assert.deepEqual([...tg.messages.keys()],[40,900]);
 }finally{globalThis.fetch=previous;}
});
test('both requested emoji are fully converted in general text and buttons',()=>{
 const out=api.telegramCustomEmoji('sendMessage',{text:'🌐 ✅',reply_markup:{inline_keyboard:[[{text:'🌐 Languages',callback_data:'lang'}, {text:'✅ Done',callback_data:'done'}]]}});
 assert.deepEqual(out.entities.map(e=>[e.offset,e.length,e.custom_emoji_id]),[[0,2,'5282843764451195532'],[3,1,'5352871660024246779']]);
 assert.deepEqual(out.reply_markup.inline_keyboard[0].map(b=>[b.text,b.icon_custom_emoji_id]),[['Languages','5282843764451195532'],['Done','5352871660024246779']]);
});

test('/start asks for a language first, then replaces that same picker with the existing localized start text',async()=>{
 const previous=globalThis.fetch;
 try{
  for(const language of ['fa','en','ru']){
   const f=fixture(),tg=telegramSimulator();globalThis.fetch=tg.fetch;
   f.saved.set('42','ru'); // choosing Persian must override the previous request's language too
   const request=f.request({update_id:1,message:{message_id:100,chat:{id:42},from:{id:42},text:'/start@MyBot referral'}});
   await api.worker.fetch(request,f.env,{});
   const picker=tg.messages.get(900);
   assert.ok(picker.reply_markup.inline_keyboard[0].every(button=>button.callback_data.startsWith('startlang:')));
   assert.ok(!picker.text.includes('/playlist'));
   assert.equal(tg.calls.filter(c=>c.method==='sendMessage').length,1);
   const callback=f.request({update_id:2,callback_query:{id:'start-select',from:{id:42},message:{message_id:900,chat:{id:42}},data:`startlang:${language}:42`}});
   await api.worker.fetch(callback,f.env,{});
   const welcome=tg.messages.get(900);
   assert.ok(welcome.text.includes('/playlist'));
   assert.ok(welcome.text.includes('/music'));
   assert.deepEqual(welcome.reply_markup.inline_keyboard,[]);
   assert.equal(tg.calls.filter(c=>c.method==='sendMessage').length,1);
   assert.equal(f.saved.get('42'),language);
   if(language==='fa')assert.match(welcome.text,/لینک رو بفرست/);
   if(language==='en')assert.match(welcome.text,/Send a link/);
   if(language==='ru')assert.match(welcome.text,/Пришли ссылку/);
   assert.ok(welcome.entities.some(entity=>entity.type==='bold'));
   assert.ok(welcome.entities.some(entity=>entity.type==='custom_emoji'));
   assert.deepEqual(tg.messages.get(40),{text:'https://example.org/download',document:{file_id:'download'}});
  }
 }finally{globalThis.fetch=previous;}
});
test('another user cannot select the language on a start picker in a group',async()=>{
 const f=fixture(),tg=telegramSimulator(),previous=globalThis.fetch;globalThis.fetch=tg.fetch;
 try{
  await api.worker.fetch(f.request({callback_query:{id:'foreign',from:{id:43},message:{message_id:900,chat:{id:-100}},data:'startlang:ru:42'}}),f.env,{});
  assert.equal(f.saved.size,0);
  assert.deepEqual(tg.calls.map(c=>c.method),['answerCallbackQuery']);
 }finally{globalThis.fetch=previous;}
});
