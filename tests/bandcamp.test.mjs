import {build} from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
const parser = await build({ external: ['node:async_hooks'],entryPoints:['src/bandcamp.ts'],bundle:true,format:'esm',write:false});
const {parseBandcampUrl,bandcampFailureDiagnostic,BANDCAMP_FIX_VERSION} = await import(`data:text/javascript;base64,${Buffer.from(parser.outputFiles[0].text).toString('base64')}`);
const bundle = await build({ external: ['node:async_hooks'],entryPoints:['src/app-main.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'runtime',setup(b){
 b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
 b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject{}; export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}}':'export class Container{}; export const getContainer=()=>globalThis.container;'}));
}}]});
const {default:worker,YoutubeDownloadWorkflow}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const secret='fictional-private-webhook-secret-32';
const env={BOT_TOKEN:'fictional',WEBHOOK_SECRET:secret,API_ID:'1',API_HASH:'fictional',DOWNLOAD_POOL:{getByName(){return {async acquire(){return {instance:0,token:'lease'};},async release(){}};}}};
const message=text=>new Request('https://worker/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:8,message:{message_id:7,chat:{id:42,type:'private'},from:{id:42},text}})});

test('Bandcamp parser recognizes only track and album URLs on artist subdomains',()=>{
 assert.deepEqual(parseBandcampUrl('/bandcamp https://Artist.bandcamp.com/album/example/?from=search'),{url:'https://artist.bandcamp.com/album/example'});
 for(const url of ['https://bandcamp.com','https://artist.bandcamp.com/music','https://daily.bandcamp.com/track/news','https://artist.bandcamp.com.evil.test/track/a','https://evil.test/track/a','https://artist.bandcamp.com:99/track/a','https://u:p@artist.bandcamp.com/track/a'])assert.equal(parseBandcampUrl(url),null,url);
});

test('production webhook queues Bandcamp separately and keeps other job fields absent',async()=>{
 const jobs=[];const bindings={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
 globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:9}});
 await worker.fetch(message('https://artist.bandcamp.com/track/song'),bindings,{});
 assert.equal(jobs.length,1);assert.deepEqual(jobs[0].params.bandcamp,{url:'https://artist.bandcamp.com/track/song',selectQuality:true});
 for(const field of ['instagram','recognition','social','playlist','quality'])assert.equal(jobs[0].params[field],undefined);
});

test('Bandcamp command rejects unrelated links without invoking other downloaders',async()=>{
 const jobs=[],sent=[];
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:9}});};
 await worker.fetch(message('/bandcamp https://youtube.com/watch?v=abcdefghijk'),{...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}},{});
 assert.equal(jobs.length,0);assert.ok(sent.some(x=>x.text?.includes('Bandcamp')));
});

test('Bandcamp reuses completion events and complete-file transport without Instagram access',async()=>{
 const calls=[],payloads=[];
 globalThis.container={async startShared(){calls.push('boot');},async instagramRequest(action,payload){calls.push(action);payloads.push(payload);return action==='send'?{ok:true,parts:2,title:'Album'}:{ok:true};},async releaseInstagram(){calls.push('release');}};
 globalThis.fetch=async(url)=>{assert.ok(String(url).startsWith('https://api.telegram.org/'));return Response.json({ok:true,result:{message_id:10}});};
 const step={async do(name,opts,fn){return (typeof opts==='function'?opts:fn)();},async waitForEvent(name,opts){assert.equal(opts.type,'instagram-ready');return {payload:{ok:true}};}};
 await new YoutubeDownloadWorkflow({},env).run({payload:{id:'igdl-42-7-42',chatId:42,userId:42,requestMessageId:7,url:'',bandcamp:{url:'https://artist.bandcamp.com/album/example'}}},step);
 assert.deepEqual(calls,['boot','start','send','cleanup','release']);
 assert.deepEqual(payloads.find(x=>x.source).source,{mode:'replay',title:'Bandcamp',audioOnly:true,bandcamp:{url:'https://artist.bandcamp.com/album/example'}});
});

test('Bandcamp diagnostics retain failure reason and stack without credentials or URLs',()=>{
 const secrets={BOT_TOKEN:'123456:private-token-value-1234567890',WEBHOOK_SECRET:'fictional-webhook-secret',API_HASH:'fictional-api-hash'};
 const error=new Error(`storage handshake failed ${secrets.BOT_TOKEN} ${secrets.API_HASH} https://signed.example/private?token=hidden\nCookie: session-value`);
 const result=bandcampFailureDiagnostic(error,secrets),serialized=JSON.stringify(result);
 assert.equal(result.source,'Bandcamp');assert.ok(result.detail.includes('storage handshake failed'));assert.ok(result.stack.includes('Error:'));
 for(const secret of [...Object.values(secrets),'signed.example','session-value'])assert.ok(!serialized.includes(secret),secret);
 assert.ok(bandcampFailureDiagnostic(new Error('x'.repeat(10000))).detail.length<=1500);
 assert.ok(bandcampFailureDiagnostic(new Error('x'.repeat(10000))).stack.length<=2500);
});

test('failed Bandcamp workflow creation logs its cause once without retrying or exposing diagnostics',async()=>{
 const logs=[],sent=[];const previous=console.error;
 console.error=(message,detail)=>logs.push({message,detail});
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:9}});};
 let creates=0;
 try{
  const response=await worker.fetch(message('https://essence-music.bandcamp.com/track/munus'),{...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(){creates++;throw new Error(`binding unavailable ${env.BOT_TOKEN} https://internal.example/private`);}}},{});
  assert.equal(response.status,200);assert.equal(creates,1);assert.equal(logs.length,1);
  assert.equal(logs[0].detail.phase,'workflow_create');assert.ok(logs[0].detail.detail.includes('binding unavailable'));
  assert.ok(!JSON.stringify(logs).includes('internal.example'));assert.ok(!JSON.stringify(sent).includes('binding unavailable'));
 }finally{console.error=previous;}
});

test('Bandcamp webhook exceptions log a sanitized cause while other requests keep their current logging',async()=>{
 const logs=[],sent=[];const previous=console.error;
 console.error=(message,detail)=>logs.push({message,detail});
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:9}});};
 const bindings={...env,API_HASH:'confidential-api-hash',ADMIN_STATS:{getByName(){throw new Error('private storage unavailable confidential-api-hash https://internal.example/secret');}}};
 try{
  await worker.fetch(message('https://essence-music.bandcamp.com/track/munus'),bindings,{});
  assert.equal(logs[0].message,'request failed');assert.equal(logs[0].detail.phase,'webhook');assert.equal(logs[0].detail.source,'Bandcamp');
  assert.ok(logs[0].detail.detail.includes('storage unavailable'));assert.ok(logs[0].detail.stack);
  assert.ok(!JSON.stringify(logs).includes('confidential-api-hash'));assert.ok(!JSON.stringify(logs).includes('internal.example'));
  const final=sent.filter(x=>x.text&&!x.draft_id).at(-1);
  assert.ok(final.text.includes('دریافت یا آماده‌سازی'));assert.ok(!final.text.includes('خصوصی'));assert.ok(!JSON.stringify(sent).includes('storage unavailable'));
  logs.length=0;
  await worker.fetch(message('https://youtube.com/watch?v=abcdefghijk'),bindings,{});
  assert.deepEqual(logs[0],{message:'request failed',detail:{type:'Error'}});
 }finally{console.error=previous;}
});

test('Bandcamp failure diagnostics work with the deployed fallback configuration without changing other handlers',async()=>{
 const logs=[],sent=[];const previous=console.error;let queued=0;
 console.error=(message,detail)=>logs.push({message,detail});
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:9}});};
 const bindings={...env,WEBHOOK_SECRET:undefined,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(){queued++;}},ADMIN_STATS:{getByName(){throw new Error('storage request failed');}}};
 const fallback='dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1';
 const request=(text,key)=>new Request('https://worker/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':key},body:JSON.stringify({message:{message_id:7,chat:{id:42,type:'private'},from:{id:42},text}})});
 try{
  const response=await worker.fetch(request('https://essence-music.bandcamp.com/track/munus',fallback),bindings,{});
  assert.equal(response.status,200);assert.equal(logs[0].detail.source,'Bandcamp');assert.equal(logs[0].detail.bandcampFixVersion,BANDCAMP_FIX_VERSION);
  assert.ok(logs[0].detail.detail.includes('storage request failed'));assert.equal(queued,0);assert.ok(sent.length>0);
  logs.length=0;sent.length=0;
  const other=await worker.fetch(request('https://youtube.com/watch?v=abcdefghijk',fallback),bindings,{});
  assert.equal(other.status,500);assert.deepEqual(logs[0],{message:'request failed',detail:{type:'Error'}});assert.equal(sent.length,0);
  logs.length=0;
  for(const key of ['wrong',secret]){
   const rejected=await worker.fetch(request('https://essence-music.bandcamp.com/track/munus',key),bindings,{});
   assert.equal(rejected.status,403);assert.equal(logs.length,0);assert.equal(sent.length,0);
  }
  // A configured secret continues to reject the old fallback, including errors.
  const rejected=await worker.fetch(request('https://essence-music.bandcamp.com/track/munus',fallback),{...bindings,WEBHOOK_SECRET:secret},{});
  assert.equal(rejected.status,403);assert.equal(sent.length,0);assert.equal(queued,0);
 }finally{console.error=previous;}
});

test('existing health route exposes the Bandcamp fix version without starting a Container',async()=>{
 globalThis.container={async startShared(){throw new Error('unexpected startup');}};
 const response=await worker.fetch(new Request('https://worker/health'),env,{});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.bandcampFixVersion,BANDCAMP_FIX_VERSION);
 assert.equal(body.downloadFixVersion,'pool-five-v1');
});

test('Bandcamp workflow waits for a signed audio quality choice before preparing and sending',async()=>{
 const calls=[],messages=[],options=[{id:'mp3-128',label:'MP3 • 128 kbps'},{id:'flac',label:'FLAC • بدون افت کیفیت'}];let reads=0;
 globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
 globalThis.container={async startShared(){},async instagramRequest(action,payload){calls.push({action,payload});return action==='send'?{ok:true,parts:1}:{ok:true};},async releaseInstagram(){}};
 const step={async do(name,opts,fn){return (typeof opts==='function'?opts:fn)();},async waitForEvent(name,opts){
  if(opts.type==='bandcamp-quality'){assert.ok(!calls.some(x=>x.action==='send'));return {payload:{index:1}};}
  assert.equal(opts.type,reads===0?'instagram-ready':'bandcamp-prepared');
  return {payload:++reads===1?{ok:true,bandcampOptions:options}:{ok:true}};
 }};
 await new YoutubeDownloadWorkflow({},env).run({payload:{id:'igdl-42-7-42',chatId:42,userId:42,requestMessageId:7,url:'',bandcamp:{url:'https://artist.bandcamp.com/track/song',selectQuality:true}}},step);
 const selected=calls.find(x=>x.payload.bandcampFormatId);assert.equal(selected.payload.bandcampFormatId,'flac');
 assert.equal(calls.filter(x=>x.action==='send').length,1);assert.equal(reads,2);
 const menu=messages.find(x=>x.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('bcq|'));
 assert.deepEqual(menu.reply_markup.inline_keyboard.map(row=>row[0].text),options.map(x=>x.label));
 for(const row of menu.reply_markup.inline_keyboard){
  const data=row[0].callback_data;assert.ok(Buffer.byteLength(data)<=64);
  const [,request,owner,index,expires,signature]=data.split('|');
  assert.equal(signature,createHmac('sha256',env.BOT_TOKEN).update(`bandcamp:42:${request}:${owner}:${index}:${expires}`).digest('hex').slice(0,16));
 }
});

const callbackRequest=(data,owner=42,chat=42)=>new Request('https://worker/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({callback_query:{id:'quality-click',from:{id:owner},data,message:{message_id:10,chat:{id:chat,type:'private'}}}})});
const qualityData=(expires=Math.floor(Date.now()/1000)+60)=>{
 const value=`bandcamp:42:7:42:0:${expires}`;
 return `bcq|7|42|0|${expires}|${createHmac('sha256',env.BOT_TOKEN).update(value).digest('hex').slice(0,16)}`;
};
test('quality callback resumes the current workflow and rejects foreign, expired or modified choices',async()=>{
 const events=[];let creates=0;globalThis.fetch=async()=>Response.json({ok:true});
 const bindings={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(){creates++;},async get(id){assert.equal(id,'igdl-42-7-42');return {async sendEvent(event){events.push(event);}};}}};
 await worker.fetch(callbackRequest(qualityData()),bindings,{});
 assert.deepEqual(events,[{type:'bandcamp-quality',payload:{index:0}}]);
 for(const request of [callbackRequest(qualityData(),99),callbackRequest(qualityData(),42,-10042),callbackRequest(qualityData(Math.floor(Date.now()/1000)-1)),callbackRequest(qualityData().replace('|0|','|1|'))])await worker.fetch(request,bindings,{});
 assert.equal(events.length,1);assert.equal(creates,0);
});

test('completion events forward only validated public format choices without media URLs',async()=>{
 const events=[];const id='igdl-42-7-42',token=createHmac('sha256',env.BOT_TOKEN).update('event:'+id).digest('hex');
 const send=(options,stage)=>worker.fetch(new Request('https://worker/instagram/events/'+id,{method:'POST',headers:{'content-type':'application/json','x-instagram-event-token':token},body:JSON.stringify({ok:true,bandcampOptions:options,bandcampStage:stage})}),{...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async get(){return {async sendEvent(event){events.push(event);}};}}},{});
 assert.equal((await send([{id:'flac',label:'FLAC',url:'https://signed.example/private'}])).status,200);
 assert.deepEqual(events[0].payload.bandcampOptions,[{id:'flac',label:'FLAC'}]);
 assert.equal((await send([{id:'flac',label:'FLAC'},{id:'flac',label:'duplicate'}])).status,400);
 assert.equal(events.length,1);
 assert.equal((await send(undefined,'prepared')).status,200);
 assert.equal(events[1].type,'bandcamp-prepared');assert.equal(events[0].type,'instagram-ready');
 assert.equal((await send([{id:'flac',label:'FLAC'}],'prepared')).status,400);
});

test('membership gate covers Bandcamp quality callbacks before resuming a download',async()=>{
 let resumed=0,triggered=false;const messages=[];
 globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{status:'left',message_id:9}});};
 const bindings={...env,ADMIN_STATS:{getByName(){return {async fetch(url,init){
  if(init?.body&&JSON.parse(init.body).triggerLink)triggered=true;
  return Response.json(String(url).includes('/membership')?{enabled:true,mode:'first_link',downloaded:false,linkTriggered:triggered}:{ok:true,restricted:false});
 }}}},YOUTUBE_DOWNLOAD_WORKFLOW:{async get(){resumed++;return {async sendEvent(){}};}}};
 await worker.fetch(callbackRequest(qualityData()),bindings,{});
 assert.equal(resumed,0);assert.equal(triggered,true);assert.ok(messages.some(x=>x.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='membership:check')));
});
