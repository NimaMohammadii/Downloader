import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
const result = await build({ external: ['node:async_hooks'],entryPoints:['src/admin.ts'], bundle:true,format:'esm',write:false,
  plugins:[{name:'runtime',setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},a=>({path:a.path,namespace:'runtime'}));
    b.onLoad({filter:/.*/,namespace:'runtime'},()=>({contents:'export class DurableObject {}'}));
  }}]});
const { telegramTextMotion, telegramCustomEmoji, privateErrorPayload, PUBLIC_ERROR_MESSAGE, ADMIN_USER_ID } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('details reach only the private admin chat, including admin requests in groups', async()=>{
  const calls=[];
  globalThis.fetch=async(url,init)=>{ calls.push({url,body:JSON.parse(init.body)});return Response.json({ok:true}); };
  for(const chat of [42,-123,ADMIN_USER_ID]) {
    const body={chat_id:chat,message_id:8,text:'❌ unknown internal failure',entities:[{type:'bold',offset:0,length:3}],reply_markup:{inline_keyboard:[]}};
    await telegramTextMotion('fake-token','editMessageText',body);
    const outgoing=telegramCustomEmoji('editMessageText',body);
    assert.equal(outgoing.text,chat===ADMIN_USER_ID?'❌ unknown internal failure':PUBLIC_ERROR_MESSAGE);
    if(chat!==ADMIN_USER_ID) assert.equal(outgoing.reply_markup,undefined);
  }
  assert.ok(calls.length > 0);
  assert.ok(calls.every(c=>c.body.chat_id!==ADMIN_USER_ID && PUBLIC_ERROR_MESSAGE.startsWith(c.body.text)), 'animation must stay in the user chat');
  assert.ok(calls.every(c=>c.body.text.length<PUBLIC_ERROR_MESSAGE.length), 'edit frames must reveal partial text');
});

test('user drafts stay generic and never notify the admin',async()=>{
  const calls=[];
  globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);if(body.chat_id===ADMIN_USER_ID)throw Error('offline');return Response.json({ok:true});};
  const body={chat_id:43,text:'❌ session rejected fake-token https://secret.example/token',parse_mode:'HTML'};
  await telegramTextMotion('fake-token','sendMessage',body);
  assert.equal(body.text,PUBLIC_ERROR_MESSAGE);
  assert.equal(body.parse_mode,undefined);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(b=>b.chat_id===43 && PUBLIC_ERROR_MESSAGE.startsWith(b.text)));
  assert.ok(calls.every(b=>!b.text.includes('fake-token')&&!b.text.includes('secret.example')));
});

test('callbacks preserve actor visibility through preparation without notifications',async()=>{
  const calls=[];
  globalThis.fetch=async(...args)=>{calls.push(args);throw Error('unexpected notification');};
  for(const user of [42,ADMIN_USER_ID,undefined]) {
    const original={callback_query_id:'x',_errorUserId:user,text:'شروع دانلود ناموفق بود.'};
    await telegramTextMotion('fake-token','answerCallbackQuery',original);
    const body=telegramCustomEmoji('answerCallbackQuery',original);
    assert.equal(body.text,user===ADMIN_USER_ID?'شروع دانلود ناموفق بود.':'⚠️ دریافت یا آماده‌سازی این فایل انجام نشد؛ لینک را بررسی کن و کمی بعد دوباره بفرست.');
    assert.equal(body._errorUserId,undefined);
  }
  assert.equal(calls.length,0);
});

test('partial failure and retry notices are hidden; successful media captions remain intact',()=>{
  for(const text of ['🎵 playlist\n❌ دریافت نشد: 2','⏳ تلگرام موقتاً ارسال را متوقف کرده','این فهرست منقضی یا نامعتبر است'])
    assert.notEqual(privateErrorPayload('editMessageText',{chat_id:42,text}).text,text);
  const body={chat_id:42,caption:'❌ a song title',video:'file'};
  assert.deepEqual(privateErrorPayload('sendVideo',body),body);
  assert.equal(privateErrorPayload('sendMessage',{chat_id:42,text:'✅ فایل ارسال شد'}).text,'✅ فایل ارسال شد');
});


test('public error message matches the requested text exactly',()=>{
  assert.equal(PUBLIC_ERROR_MESSAGE,'⚠️ مثل اینکه خطایی پیش اومده، در حال بررسی و پیگیری است، به زودی رفع می‌شود.');
});


test('public error entities use the requested custom emoji and bold phrases',()=>{
  const body=telegramCustomEmoji('editMessageText',{chat_id:42,text:'❌ source failed'});
  assert.equal(body.text,PUBLIC_ERROR_MESSAGE);
  assert.deepEqual(body.entities.filter(e=>e.type==='custom_emoji'),[
    {type:'custom_emoji',offset:0,length:2,custom_emoji_id:'5447644880824181073'},
  ]);
  assert.deepEqual(body.entities.filter(e=>e.type==='bold').map(e=>body.text.slice(e.offset,e.offset+e.length)),
    ['خطایی پیش اومده','در حال بررسی و پیگیری','به زودی رفع می‌شود']);
  assert.deepEqual(telegramCustomEmoji('editMessageText',body),body,'repeated decoration must be stable');
  const callback=privateErrorPayload('answerCallbackQuery',{text:'❌ error'});
  assert.equal(callback.entities,undefined,'Telegram callback alerts support plain text only');
});
