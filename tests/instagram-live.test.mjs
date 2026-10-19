import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const story = await readFile(new URL('../src/story-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source + '\nexport {parseInstagramVideoTarget,parseInstagramAudioTarget,resolveInstagramVideo,instagramVideoErrorText,parsePlaylist,mediaCacheKey,parseSocialUrl,extractYouTubeUrl};', loader: 'ts' },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'instagram-platform', setup(build) {
    build.onResolve({ filter: /.*/ }, a => ({ path: a.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, a => {
      if (a.path === './story-main') return { contents: story, loader: 'ts' };
      if (a.path === './main') return { contents: 'export default {fetch(){return Response.json({delegated:true})}};' };
      if (a.path === '@cloudflare/containers') return { contents: `
        export class Container {
          constructor(ctx,env){this.ctx=ctx;this.env=env;}
          renewActivityTimeout(){globalThis.renewed++;}
          async onActivityExpired(){globalThis.expired++;}
          async destroy(){globalThis.expired++;}
          onError(error){throw error;}
        }
        export const getContainer=(_env,id)=>{globalThis.containerIds.push(id);return globalThis.container;};` };
      if (a.path === 'cloudflare:workers') return { contents: 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}' };
      if (a.path === './admin') return { contents: `
        export const recordDownload = async(_env,record)=>{(globalThis.downloadHistory ||= []).push(record);};
        export const isInstagramDownloadLink = text=>/instagram.com\\//.test(text);
        export const telegramTextMotion=async()=>{};
        export const telegramCustomEmoji=(_method,payload)=>payload;
        export const telegramFileCache=async(...args)=>globalThis.testFileCache ? globalThis.testFileCache(...args) : null; export class AdminStatsStore{} export const ADMIN_USER_ID=1;
        export const recordUserActivity=async()=>{};
        export const recordSuccessfulDelivery=async()=>{globalThis.delivered++;};` };
      throw Error(a.path);
    });
  } }],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const env = { BOT_TOKEN: 'fictional-bot-token', API_ID: '123', API_HASH: 'fictional-api-hash', INSTAGRAM_SESSIONID: '42%3Afictional-session',
  DOWNLOAD_POOL: {getByName(){return {async acquire(){return {instance:0,token:'test-lease'};},async release(){},async lookup(){return {instance:0};}};}} };
const liveUrl = 'https://scontent.cdninstagram.com/live.mpd';
const job = { id: 'igdl-42-7-42', chatId: 42, requestMessageId: 7, userId: 42, url: '', instagram: {kind:'live',broadcastId:'17900000000000001'} };

test('Pinterest shared Pin links normalize before creating jobs while boards and internal API URLs stay rejected',()=>{
  for(const url of ['https://www.pinterest.com/pin/266556871689003952/sent/?sender=42',
                   'https://de.pinterest.com/pin/title--266556871689003952/sent/']) {
    assert.deepEqual(mod.parseSocialUrl(url),{platform:'pinterest',url:'https://www.pinterest.com/pin/266556871689003952/'});
    assert.deepEqual(mod.parseSocialUrl('/audio '+url),{platform:'pinterest',url:'https://www.pinterest.com/pin/266556871689003952/',audioOnly:true});
  }
  for(const url of ['https://pinterest.com/name/board/','https://pinterest.com/name/',
                   'https://pinterest.com/pin/123/sent/extra/','https://pinterest.com.evil/pin/123/sent/',
                   'https://api.pinterest.com/url_shortener/Example123/redirect/']) {
    assert.equal(mod.parseSocialUrl(url),null);
  }
});
function api(routes) {
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'i.instagram.com');
    assert.match(new Headers(init.headers).get('cookie'), /sessionid=/);
    assert.ok(routes[parsed.pathname], parsed.pathname);
    return routes[parsed.pathname]();
  };
}

test('native live links, TV replay and explicit commands have deterministic routes', () => {
  assert.deepEqual(mod.parseInstagramVideoTarget('/live @example'), {kind:'live',username:'example'});
  assert.deepEqual(mod.parseInstagramVideoTarget('https://www.instagram.com/example/live/17900000000000001/'), {kind:'live',username:'example',broadcastId:'17900000000000001'});
  assert.equal(mod.parseInstagramVideoTarget('/live@exampleBot https://instagram.com/example/').username, 'example');
  assert.equal(mod.parseInstagramVideoTarget('/replay https://instagram.com/reel/B/').shortcode, 'B');
  assert.equal(mod.parseInstagramVideoTarget('https://instagram.com/tv/B/').kind, 'replay');
  assert.equal(mod.parseInstagramVideoTarget('https://instagram.com/reel/B/'), null);
  assert.equal(mod.parseInstagramVideoTarget('https://instagram.com/stories/example/123/'), null);
  assert.equal(mod.parseInstagramVideoTarget('https://instagram.com.attacker/live/123'), null);
});

test('active live discovery uses top-level broadcast and preserves its integer ID', async () => {
  api({
    '/api/v1/users/example/usernameinfo/': () => Response.json({user:{pk:'77'}}),
    '/api/v1/feed/user/77/story/': () => new Response('{"broadcast":{"id":17900000000000001},"reel":{"items":[]}}'),
    '/api/v1/live/17900000000000001/info/': () => Response.json({broadcast_status:'active',dash_playback_url:liveUrl}),
  });
  const source = await mod.resolveInstagramVideo({kind:'live',username:'example'}, env);
  assert.equal(source.mode, 'live'); assert.equal(source.url, liveUrl);
  assert.ok(!JSON.stringify(source).includes(env.INSTAGRAM_SESSIONID));
});

test('published replay chooses highest resolution without Story size limits', async () => {
  api({'/api/v1/media/1/info/':()=>Response.json({items:[{pk:'1',video_duration:3600,video_versions:[
    {url:'https://scontent.cdninstagram.com/low.mp4',width:360,height:640},
    {url:'https://scontent.cdninstagram.com/high.mp4',width:1080,height:1920},
  ]}]})});
  const source = await mod.resolveInstagramVideo({kind:'replay',shortcode:'B'}, env);
  assert.equal(source.url, 'https://scontent.cdninstagram.com/high.mp4');
  assert.equal(source.duration, 3600); assert.equal(source.mode, 'replay');
});

test('archived replay uses exact broadcast from post_live_item', async () => {
  api({
    '/api/v1/users/example/usernameinfo/':()=>Response.json({user:{pk:'77'}}),
    '/api/v1/feed/user/77/story/':()=>Response.json({post_live_item:{broadcasts:[
      {id:'123',published_time:2,dash_manifest:'first'}, {id:'124',published_time:1,dash_manifest:'second'},
    ]}}),
  });
  const source = await mod.resolveInstagramVideo({kind:'replay',username:'example',broadcastId:'124'},env);
  assert.equal(source.manifest,'second');
});

test('offline and rejected sessions have clear failures without retry loops', async () => {
  api({
    '/api/v1/users/example/usernameinfo/':()=>Response.json({user:{pk:'77'}}),
    '/api/v1/feed/user/77/story/':()=>Response.json({broadcast:null}),
  });
  await assert.rejects(()=>mod.resolveInstagramVideo({kind:'live',username:'example'},env), /لایو فعال/);
  api({'/api/v1/live/123/info/':()=>Response.json({message:'login_required'},{status:401})});
  try { await mod.resolveInstagramVideo({kind:'live',broadcastId:'123'},env); assert.fail(); }
  catch(e){ assert.match(mod.instagramVideoErrorText(e), /ورود دوباره/); }
});

test('untrusted stream URLs never reach the recorder', async () => {
  api({'/api/v1/live/123/info/':()=>Response.json({broadcast_status:'active',dash_playback_url:'https://localhost/private'})});
  await assert.rejects(()=>mod.resolveInstagramVideo({kind:'live',broadcastId:'123'},env), /در دسترس/);
});

async function workflow(ready = {ok:true}, input = job) {
  const calls=[],steps=[],messages=[];
  globalThis.delivered=0; globalThis.containerIds=[]; globalThis.downloadHistory=[];
  globalThis.container={
    async startShared(){calls.push('start');},
    async instagramRequest(action,payload){calls.push(action);if(action==='start') globalThis.startedPayload=payload;return {ok:true};},
    async releaseInstagram(){calls.push('release');},
  };
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('api.telegram.org')){messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});}
    return Response.json({broadcast_status:'active',dash_playback_url:liveUrl});
  };
  const step={async do(name,options,fn){if(typeof options==='function'){fn=options;options={};}steps.push({name,options});return fn();},
    async waitForEvent(name,options){steps.push({name,options});return {payload:ready};}};
  await new mod.YoutubeDownloadWorkflow({},env).run({payload:input},step);
  return {calls,steps,messages};
}

test('recording waits for a completion event and sends one whole file', async()=>{
  const r=await workflow();
  assert.deepEqual(r.calls,['start','start','send','cleanup','release']);
  assert.equal(globalThis.delivered,1);
  assert.equal(globalThis.downloadHistory.at(-1).status,'success');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,1);
  assert.ok(r.steps.some(s=>s.options.type==='instagram-ready'&&s.options.timeout==='150 minutes'));
  assert.ok(r.steps.every(s=>!s.options.timeout?.endsWith('minutes')||s.options.type||parseInt(s.options.timeout)<=30));
  assert.ok(!JSON.stringify(globalThis.startedPayload).includes(env.INSTAGRAM_SESSIONID));
  assert.ok(Buffer.byteLength(globalThis.startedPayload.stopData)<=64);
});

test('music search releases its container after listing results and never records a file delivery',async()=>{
  const result=await workflow({ok:true},{...job,instagram:{kind:'music',query:'Artist Title'}});
  assert.ok(result.calls.includes('cleanup'));assert.ok(result.calls.includes('release'));
  assert.equal(globalThis.downloadHistory.at(-1).status,'results');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,0);
  assert.equal(globalThis.startedPayload.source.musicSearch,true);
  assert.equal(globalThis.startedPayload.source.musicQuery,'Artist Title');
  assert.equal(globalThis.delivered,0);
  assert.deepEqual(globalThis.startedPayload.source,{mode:'replay',title:'Artist Title',audioOnly:true,musicQuery:'Artist Title',musicSearch:true});
});

test('music buttons bind chat, owner, exact video and expiry before creating an idempotent download',async()=>{
  const jobs=[],messages=[];
  const workerEnv={...env,WEBHOOK_SECRET:'fictional-secret',YOUTUBE_DOWNLOAD_WORKFLOW:{async create(value){jobs.push(value);}}};
  globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:true});};
  const expiry=String(Math.floor(Date.now()/1000)+3600),video='abcdefghijk',owner='42';
  const sign=async(chat,id,user,until)=>{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.BOT_TOKEN),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`music-select:${chat}:${user}:${id}:${until}`));
    return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
  };
  const data=`msc|${video}|${owner}|${expiry}|${await sign(42,video,owner,expiry)}`;
  const click=(value,user=42,chat=42)=>mod.default.fetch(new Request('https://worker/telegram/webhook',{method:'POST',
    headers:{'x-telegram-bot-api-secret-token':'fictional-secret'},body:JSON.stringify({update_id:99,
      callback_query:{id:'callback',from:{id:user},data:value,message:{message_id:10,chat:{id:chat}}}})}),workerEnv,{});
  await click(data,99);await click(data,42,43);await click(data.replace(video,'bbbbbbbbbbb'));
  const old=String(Math.floor(Date.now()/1000)-10);
  await click(`msc|${video}|${owner}|${old}|${await sign(42,video,owner,old)}`);
  assert.equal(jobs.length,0);
  await click(data);await click(data);
  assert.equal(jobs.length,2);assert.equal(jobs[0].id,jobs[1].id);
  assert.equal(jobs[0].id,'igdl-42-10-42-music-abcdefghijk');
  assert.deepEqual(jobs[0].params.instagram,{kind:'music',musicVideoId:video});
  const source=await mod.resolveInstagramVideo(jobs[0].params.instagram,env);
  assert.equal(source.musicSearch,undefined);assert.equal(source.musicVideoId,video);assert.equal(source.audioOnly,true);
});

test('native text motion is bounded, preserves formatting and final delivery survives preview failures',async()=>{
  const text=await readFile(new URL('../src/admin.ts',import.meta.url),'utf8');
  const result=await build({stdin:{contents:text,loader:'ts'},bundle:true,format:'esm',write:false,
    plugins:[{name:'motion-runtime',setup(b){b.onResolve({filter:/^cloudflare:workers$/},a=>({path:a.path,namespace:'runtime'}));
      b.onLoad({filter:/.*/,namespace:'runtime'},()=>({contents:'export class DurableObject {}'}));}}]});
  const {telegramTextMotion,telegramCustomEmoji}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const icons='❌ ✅ ⚠️ 🔎 ⬇️ 📤 ⏳ 🎵 🎧 🎼 🎬 ⭐️ 🔴 ⏹️ 👤 ⚡️ 👇';
  const ids=['5210952531676504517','5352871660024246779','5447644880824181073','5231012545799666522','5271604874419647061','5445355530111437729','5386367538735104399','5463107823946717464','5424818078833715060','5253997827788385948','5427168083074628963','5438496463044752972','5264919878082509254','5260293700088511294','5397866377367268054','5210956306952758910','5231102735817918643'];
  const original={chat_id:42,text:`سلام 😀 ${icons}`,reply_markup:{inline_keyboard:[[{text:'⏹ توقف',callback_data:'signed|unchanged'},{text:'👑 ادمین',callback_data:'admin'}]]}};
  const copy=structuredClone(original);const converted=telegramCustomEmoji('sendMessage',original);
  assert.deepEqual(original,copy);assert.equal(converted.text,original.text);
  assert.deepEqual(converted.entities.map(e=>e.custom_emoji_id),ids);
  assert.deepEqual(converted.entities.map(e=>original.text.slice(e.offset,e.offset+e.length)),icons.split(' '));
  assert.equal(converted.reply_markup.inline_keyboard[0][0].text,'توقف');
  assert.equal(converted.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,ids[13]);
  assert.equal(converted.reply_markup.inline_keyboard[0][0].callback_data,'signed|unchanged');
  assert.deepEqual(converted.reply_markup.inline_keyboard[0][1],original.reply_markup.inline_keyboard[0][1]);
  assert.deepEqual(telegramCustomEmoji('sendMessage',converted),converted);
  assert.deepEqual(telegramCustomEmoji('answerCallbackQuery',original),original);
  const formatted=telegramCustomEmoji('editMessageText',{text:'🎵 ✅',entities:[{type:'code',offset:0,length:2},{type:'bold',offset:3,length:1}]});
  assert.equal(formatted.entities.length,3);assert.equal(formatted.entities.at(-1).custom_emoji_id,ids[1]);
  const media=telegramCustomEmoji('sendMediaGroup',{media:[{type:'video',media:'file-id',caption:'🎬 title'}]});
  assert.equal(media.media[0].caption_entities[0].custom_emoji_id,ids[10]);
  const calls=[];globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,result:true});};
  const body={chat_id:444,text:'متن کامل آهنگ و خواننده برای نمایش نرم 🎵',reply_markup:{inline_keyboard:[]}};
  await telegramTextMotion('fictional','sendMessage',body);
  assert.ok(calls.length>1 && calls.length<=6);assert.ok(calls.every(c=>c.method==='sendMessageDraft'));
  assert.equal(calls[0].body.text,'م');assert.equal(calls.at(-1).body.text,body.text);
  assert.equal(new Set(calls.map(c=>c.body.draft_id)).size,1);assert.ok(calls[0].body.draft_id>0);
  assert.ok(calls.every((c,i)=>body.text.startsWith(c.body.text) && (!i || c.body.text.length>calls[i-1].body.text.length)));
  const count=calls.length;
  await telegramTextMotion('fictional','sendMessage',body);assert.equal(calls.length,count);
  await telegramTextMotion('fictional','editMessageText',{...body,chat_id:445,message_id:7});assert.equal(calls.length,count);
  await telegramTextMotion('fictional','sendMessage',{...body,chat_id:445,parse_mode:'HTML'});assert.equal(calls.length,count);
  await telegramTextMotion('fictional','sendAudio',{chat_id:446,text:body.text});assert.equal(calls.length,count);
  await telegramTextMotion('fictional','sendMessage',{...body,chat_id:-447});assert.equal(calls.length,count);
  const plain={chat_id:449,message_thread_id:5,text:'👩‍💻 ⚠️ می‌روم و متن فارسی با اَعراب برای نمایش نرم 🎵'};
  const limit=plain.text.length;plain.entities=[{type:'bold',offset:0,length:limit}];
  await telegramTextMotion('fictional','sendMessage',plain);
  const unicode=calls.slice(count);assert.equal(unicode[0].body.text,'👩‍💻');
  assert.equal(unicode.at(-1).body.text,plain.text);assert.ok(unicode.length<=6);
  for(const frame of unicode){
    assert.equal(frame.body.message_thread_id,5);assert.ok(!/[\u200c\u200d]$/u.test(frame.body.text));
    assert.ok(frame.body.entities.every(e=>e.offset+e.length<=frame.body.text.length));
  }
  assert.deepEqual(calls.at(-1).body.entities,telegramCustomEmoji('sendMessage',plain).entities);
  globalThis.fetch=async()=>{throw Error('draft unavailable');};
  await assert.doesNotReject(()=>telegramTextMotion('fictional','sendMessage',{...body,chat_id:448}));
  let limited=0;globalThis.fetch=async()=>{limited++;return Response.json({ok:false,parameters:{retry_after:30}},{status:429});};
  await telegramTextMotion('fictional','sendMessage',{...body,chat_id:450});
  await telegramTextMotion('fictional','sendMessage',{...body,chat_id:450});assert.equal(limited,1);
});

test('a restart event does not upload a missing or partial replay',async()=>{
  const r=await workflow({ok:false,message:'❌ سرور ری‌استارت شد'});
  assert.ok(!r.calls.includes('send')); assert.equal(globalThis.delivered,0);
  assert.match(r.messages.at(-1).text,/ری‌استارت/);
  assert.ok(r.calls.includes('release'));
});

async function webhook(callback){return mod.default.fetch(new Request('https://worker/telegram/webhook',{
  method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1'},
  body:JSON.stringify({update_id:1,callback_query:callback}),
}),env,{});}

test('stop is signed, owner-bound and chat-bound',async()=>{
  await workflow();
  const valid=globalThis.startedPayload.stopData;
  const stops=[];globalThis.container.instagramRequest=async(action)=>{stops.push(action);return {ok:true};};
  await webhook({id:'wrong-user',from:{id:99},data:valid,message:{chat:{id:42},message_id:10}});
  await webhook({id:'wrong-chat',from:{id:42},data:valid,message:{chat:{id:43},message_id:10}});
  await webhook({id:'tampered',from:{id:42},data:valid.replace('|7|','|8|'),message:{chat:{id:42},message_id:10}});
  assert.deepEqual(stops,[]);
  await webhook({id:'valid',from:{id:42},data:valid,message:{chat:{id:42},message_id:10}});
  assert.deepEqual(stops,['stop']);
});

test('completion endpoint rejects forged events and delivers authenticated events',async()=>{
  await workflow();const events=[];
  const workflowEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async get(id){assert.equal(id,job.id);return {async sendEvent(event){events.push(event);}};}}};
  const request=token=>new Request(`https://worker/instagram/events/${job.id}`,{method:'POST',headers:{'x-instagram-event-token':token},body:JSON.stringify({ok:true})});
  assert.equal((await mod.default.fetch(request('wrong'),workflowEnv,{})).status,403);
  assert.equal(events.length,0);
  assert.equal((await mod.default.fetch(request(globalThis.startedPayload.completionToken),workflowEnv,{})).status,200);
  assert.equal(events[0].type,'instagram-ready');
});

test('only leased Instagram containers stay awake and release clears the lease',async()=>{
  const map=new Map([['instagramJobs',{[job.id]:Date.now()+7_200_000}]]);
  const storage={get:async key=>map.get(key),put:async(key,value)=>map.set(key,value),transaction:async fn=>fn(storage)};
  globalThis.renewed=0;globalThis.expired=0;
  const container=new mod.YoutubeDownloaderContainer({storage},env);
  await container.onActivityExpired();assert.equal(globalThis.expired,0);assert.ok(globalThis.renewed);
  await container.releaseInstagram(job.id);assert.equal(container.sleepAfter,'10s');
  await container.onActivityExpired();assert.equal(globalThis.expired,1);
});

test('container restart wakes the recording workflow with an explicit failure',async()=>{
  const events=[];
  const storage={get:async()=>({[job.id]:Date.now()+1000})};
  const interruptedEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async get(id){assert.equal(id,job.id);return {async sendEvent(event){events.push(event);}};}}};
  const container=new mod.YoutubeDownloaderContainer({storage},interruptedEnv);
  await container.onStop();
  assert.equal(events[0].type,'instagram-ready');
  assert.equal(events[0].payload.ok,false);
  assert.match(events[0].payload.message,/ری‌استارت/);
});

test('live webhook creates one deterministic job while ordinary Reels keep the original route',async()=>{
  const jobs=[];
  const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  const request=text=>new Request('https://worker/telegram/webhook',{method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1'},
    body:JSON.stringify({update_id:12,message:{message_id:7,chat:{id:42},from:{id:42},text}})});
  await mod.default.fetch(request('/live example'),workerEnv,{});
  assert.equal(jobs[0].id,job.id);assert.equal(jobs[0].params.instagram.username,'example');
  const response=await mod.default.fetch(request('https://instagram.com/reel/B/'),workerEnv,{});
  assert.equal((await response.json()).delegated,true);assert.equal(jobs.length,1);
});

test('Instagram audio links resolve the requested carousel child or Story',async()=>{
  assert.deepEqual(mod.parseInstagramAudioTarget('/audio https://instagram.com/reel/B/?img_index=2'),{kind:'audio',shortcode:'B',videoIndex:1});
  assert.deepEqual(mod.parseInstagramAudioTarget('/audio https://instagram.com/stories/example/123/'),{kind:'audio',mediaId:'123'});
  assert.equal(mod.parseInstagramAudioTarget('/audio https://attacker.example/reel/B/'),null);
  api({'/api/v1/media/1/info/':()=>Response.json({items:[{pk:'1',carousel_media:[
    {video_versions:[{url:'https://scontent.cdninstagram.com/first.mp4'}]},
    {video_duration:40,video_versions:[{url:'https://scontent.cdninstagram.com/second.mp4'}]},
  ]}]})});
  const result=await mod.resolveInstagramVideo({kind:'audio',shortcode:'B',videoIndex:1},env);
  assert.equal(result.audioOnly,true);assert.equal(result.url,'https://scontent.cdninstagram.com/second.mp4');
});

test('silent Instagram videos are rejected and music does not require an Instagram session',async()=>{
  api({'/api/v1/media/123/info/':()=>Response.json({items:[{pk:'123',has_audio:false,video_versions:[{url:liveUrl}]}]})});
  await assert.rejects(()=>mod.resolveInstagramVideo({kind:'audio',mediaId:'123'},env),/صدا ندارد/);
  const source=await mod.resolveInstagramVideo({kind:'music',query:'Adele Hello'},{BOT_TOKEN:'test'});
  assert.equal(source.musicQuery,'Adele Hello');assert.equal(source.audioOnly,true);
});

test('song names and music commands queue music while URLs and admin commands keep their routes',async()=>{
  const jobs=[];
  const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  const request=(text,id)=>new Request('https://worker/telegram/webhook',{method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1'},
    body:JSON.stringify({update_id:id,message:{message_id:id,chat:{id:42},from:{id:42},text}})});
  await mod.default.fetch(request('Adele Hello',1),workerEnv,{});
  await mod.default.fetch(request('/music آهنگ فارسی',2),workerEnv,{});
  await mod.default.fetch(request('/audio https://instagram.com/reel/B/',3),workerEnv,{});
  assert.deepEqual(jobs.map(j=>j.params.instagram.kind),['music','music','audio']);
  assert.equal(jobs[0].params.instagram.query,'Adele Hello');
  assert.equal((await (await mod.default.fetch(request('/admin',4),workerEnv,{})).json()).delegated,true);
  assert.equal(jobs.length,3);
});

test('Instagram audio button enforces ownership and replies to the selected video',async()=>{
  const jobs=[];
  const original=env.YOUTUBE_DOWNLOAD_WORKFLOW;
  env.YOUTUBE_DOWNLOAD_WORKFLOW={async create(job){jobs.push(job);}};
  try {
    await webhook({id:'other',from:{id:99},data:'iga|p|B|1|42',message:{message_id:55,chat:{id:42}}});
    assert.equal(jobs.length,0);
    await webhook({id:'owner',from:{id:42},data:'iga|p|B|1|42',message:{message_id:55,chat:{id:42}}});
    assert.equal(jobs[0].params.requestMessageId,55);
    assert.equal(jobs[0].params.instagram.videoIndex,1);
  } finally {env.YOUTUBE_DOWNLOAD_WORKFLOW=original;}
});

test('audio and song buttons on one video create independent, individually deduplicated jobs', async()=>{
  const original=env.YOUTUBE_DOWNLOAD_WORKFLOW, ids=new Set(), jobs=[];
  env.YOUTUBE_DOWNLOAD_WORKFLOW={async create(job){
    if(ids.has(job.id)) throw Error('already exists');
    ids.add(job.id);jobs.push(job);
  }};
  globalThis.fetch=async()=>Response.json({ok:true,result:true});
  try {
    const message={message_id:55,chat:{id:42}};
    for(const data of ['iga|p|B|1|42','igm|p|B|1|42','iga|p|B|1|42','igm|p|B|1|42'])
      await webhook({id:data,from:{id:42},data,message});
    assert.equal(jobs.length,2);
    assert.notEqual(jobs[0].id,jobs[1].id);
    assert.equal(jobs[0].params.requestMessageId,55);
    assert.equal(jobs[1].params.instagram.recognizeMusic,true);
  } finally {env.YOUTUBE_DOWNLOAD_WORKFLOW=original;}
});

test('Instagram cache reuse requires a fresh successful source access check', async()=>{
  const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();}};
  try {
    for(const allowed of [false,true]) {
      const sent=[],lookups=[];globalThis.containerIds=[];
      globalThis.testFileCache=async()=>({method:'sendAudio',fileId:'stored_id',data:{caption:'Audio'}});
      globalThis.fetch=async(url,init)=>{
        if(String(url).includes('api.telegram.org')) {
          sent.push({method:new URL(url).pathname.split('/').at(-1),body:JSON.parse(init.body)});
          return Response.json({ok:true,result:{message_id:10}});
        }
        lookups.push(String(url));
        return allowed ? Response.json({items:[{pk:'1',video_versions:[{url:liveUrl}],has_audio:true}]})
          : Response.json({message:'login_required'}, {status:401});
      };
      await new mod.YoutubeDownloadWorkflow({},env).run({payload:{...job,instagram:{kind:'audio',shortcode:'B'}}},step);
      assert.ok(lookups.length>0,'source must be checked even on a cache hit');
      assert.equal(sent.filter(x=>x.method==='sendAudio').length,allowed?1:0);
      assert.equal(globalThis.containerIds.length,0);
    }
  } finally {delete globalThis.testFileCache;}
});

async function mediaWebhook(message, workerEnv) {
  return mod.default.fetch(new Request('https://worker/telegram/webhook', { method:'POST',
    headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1'},
    body:JSON.stringify({update_id:20,message:{message_id:20,chat:{id:42,type:'private'},from:{id:42},...message}}),
  }),workerEnv,{});
}

test('voice, audio, video notes and audio documents queue recognition without treating captions as song names',async()=>{
  const jobs=[];
  const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  for (const field of ['voice','audio','video','video_note','document']) {
    await mediaWebhook({[field]:{file_id:'valid_'+field,file_size:1000,mime_type:'audio/ogg'},caption:'an unrelated caption'},workerEnv);
  }
  assert.equal(jobs.length,5);
  assert.deepEqual(jobs.map(j=>j.params.recognition.fileId),['valid_voice','valid_audio','valid_video','valid_video_note','valid_document']);
  assert.ok(jobs.every(j=>!j.params.instagram));
  assert.ok(jobs.every(j=>j.id==='igdl-42-20-42'));
});

test('group media keeps its route until /shazam or /recognize is explicitly requested',async()=>{
  const jobs=[]; const messages=[];
  globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
  const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  const group={chat:{id:-42,type:'supergroup'},voice:{file_id:'valid',file_size:2000}};
  assert.equal((await (await mediaWebhook(group,workerEnv)).json()).delegated,true);
  assert.equal(jobs.length,0);
  await mediaWebhook({chat:group.chat,text:'/shazam@ExampleBot',reply_to_message:{message_id:5,chat:group.chat,voice:group.voice}},workerEnv);
  assert.equal(jobs[0].params.recognition.fileId,'valid');
  assert.equal(jobs[0].params.requestMessageId,20);
  await mediaWebhook({...group,caption:'/recognize'},workerEnv);
  assert.equal(jobs.length,2);
  await mediaWebhook({text:'/shazam'},workerEnv);
  assert.equal(jobs.length,2);assert.match(messages.at(-1).text,/ریپلای/);
});

test('oversized recognition files are rejected before starting a container; unrelated documents retain their route',async()=>{
  const jobs=[];const messages=[];
  globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
  const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  await mediaWebhook({video:{file_id:'valid',file_size:20_000_001}},workerEnv);
  assert.equal(jobs.length,0);assert.match(messages.at(-1).text,/20 MB/);
  const response=await mediaWebhook({document:{file_id:'valid',mime_type:'application/pdf',file_name:'report.pdf'}},workerEnv);
  assert.equal((await response.json()).delegated,true);assert.equal(jobs.length,0);
});

test('recognition uses the same completion event and upload path without requiring an Instagram session',async()=>{
  const calls=[];const steps=[];
  globalThis.containerIds=[];globalThis.delivered=0;
  globalThis.container={
    async startShared(){calls.push('boot');},
    async instagramRequest(action,payload){calls.push(action);if(action==='start')globalThis.recognitionPayload=payload;return {ok:true};},
    async releaseInstagram(){calls.push('release');},
  };
  globalThis.fetch=async(url)=>{
    assert.ok(String(url).startsWith('https://api.telegram.org/'));
    return Response.json({ok:true,result:{message_id:10}});
  };
  const step={async do(name,options,fn){if(typeof options==='function')fn=options;return fn();},
    async waitForEvent(name,options){steps.push(options);return {payload:{ok:true}};}};
  await new mod.YoutubeDownloadWorkflow({},{...env,INSTAGRAM_SESSIONID:undefined}).run({payload:{...job,instagram:undefined,recognition:{fileId:'valid',fileSize:1000}}},step);
  assert.deepEqual(calls,['boot','start','send','cleanup','release']);
  assert.equal(globalThis.recognitionPayload.source.recognition.fileId,'valid');
  assert.equal(globalThis.recognitionPayload.source.audioOnly,true);
  assert.ok(steps.some(s=>s.type==='instagram-ready'));
  assert.equal(globalThis.delivered,1);
});

test('playlist links and explicit ranges preserve watch-link single-video behavior',()=>{
  const url='https://www.youtube.com/playlist?list=PLabcdef1234';
  assert.deepEqual(mod.parsePlaylist(url),{url,start:1,end:20});
  assert.deepEqual(mod.parsePlaylist('این پلی‌لیست '+url+'،'),{url,start:1,end:20});
  assert.deepEqual(mod.parsePlaylist('/playlist '+url+' 21-40'),{url,start:21,end:40});
  assert.equal(mod.parsePlaylist('/playlist '+url+' 1-21'),null);
  assert.equal(mod.parsePlaylist('/playlist '+url+' 0-19'),null);
  assert.equal(mod.parsePlaylist('/playlist https://attacker.example/playlist?list=PLabcdef'),null);
  assert.equal(mod.parsePlaylist('https://www.youtube.com/watch?v=abcdefghijk&list=PLabcdef'),null);
  assert.equal(mod.parsePlaylist('/playlist https://www.youtube.com/watch?v=abcdefghijk&list=PLabcdef').url,'https://www.youtube.com/playlist?list=PLabcdef');
});

test('Instagram music buttons bind owner and selected carousel item; link commands queue recognition',async()=>{
  const jobs=[];const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:10}});
  await mediaWebhook({text:'/findmusic https://instagram.com/reel/B/?img_index=2'},workerEnv);
  assert.equal(jobs[0].params.instagram.recognizeMusic,true);
  assert.equal(jobs[0].params.instagram.videoIndex,1);
  const req=from=>new Request('https://worker/telegram/webhook',{method:'POST',
    headers:{'x-telegram-bot-api-secret-token':'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1'},
    body:JSON.stringify({update_id:20,callback_query:{id:'button',from:{id:from},data:'igm|s|123|0|42',message:{message_id:55,chat:{id:42}}}})});
  await mod.default.fetch(req(99),workerEnv,{});assert.equal(jobs.length,1);
  await mod.default.fetch(req(42),workerEnv,{});assert.equal(jobs[1].params.instagram.mediaId,'123');
  assert.equal(jobs[1].params.instagram.recognizeMusic,true);
  api({'/api/v1/media/1/info/':()=>Response.json({items:[{pk:'1',video_versions:[{url:liveUrl}]}]})});
  assert.equal((await mod.resolveInstagramVideo({kind:'audio',shortcode:'B',recognizeMusic:true},env)).recognizeMusic,true);
});

test('playlist webhook uses the event-driven MP3 queue, not the individual quality route',async()=>{
  const jobs=[];const workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  await mediaWebhook({text:'https://www.youtube.com/playlist?list=PLabcdef'},workerEnv);
  assert.equal(jobs[0].params.playlist.start,1);assert.equal(jobs[0].params.playlist.end,20);
  assert.equal(jobs[0].params.instagram,undefined);
});

test('cache keys separate exact music choices, quality and private Instagram owners; searches never reuse a song',async()=>{
  assert.notEqual(await mod.mediaCacheKey({...job,instagram:undefined,url:'https://www.youtube.com/watch?v=abcdefghijk',quality:720}),await mod.mediaCacheKey({...job,instagram:undefined,url:'https://www.youtube.com/watch?v=abcdefghijk',quality:1080}));
  const a=await mod.mediaCacheKey({...job,instagram:{kind:'music',query:'  ADELE   Hello '}});
  const b=await mod.mediaCacheKey({...job,instagram:{kind:'music',query:'Adele Hello'}});
  assert.equal(a,b);
  assert.equal(a,undefined);
  assert.equal(await mod.mediaCacheKey({...job,instagram:{kind:'music',musicVideoId:'abcdefghijk'}}),'yt:abcdefghijk:mp3');
  assert.equal(await mod.mediaCacheKey({...job,instagram:{kind:'music',musicVideoId:'bbbbbbbbbbb'}}),'yt:bbbbbbbbbbb:mp3');
  assert.notEqual(await mod.mediaCacheKey({...job,instagram:{kind:'audio',mediaId:'123'}}),await mod.mediaCacheKey({...job,userId:99,instagram:{kind:'audio',mediaId:'123'}}));
});

test('a cache hit sends the Telegram file without booting the container',async()=>{
  const messages=[];globalThis.delivered=0;globalThis.containerIds=[];
  globalThis.fetch=async(url,init)=>{messages.push({url:String(url),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:10}});};
  globalThis.testFileCache=async(_env,op)=>op==='get'?{method:'sendAudio',fileId:'stored_id',data:{caption:'Hello'}}:null;
  const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();}};
  try {
    await new mod.YoutubeDownloadWorkflow({},env).run({payload:{...job,instagram:{kind:'music',musicVideoId:'abcdefghijk'}}},step);
    assert.equal(globalThis.containerIds.length,0);assert.equal(globalThis.delivered,1);
    assert.equal(messages.find(m=>m.url.endsWith('/sendAudio')).body.audio,'stored_id');
  } finally {delete globalThis.testFileCache;}
});

test('cache endpoint rejects forged writes and validates signed operations',async()=>{
  await workflow();const token=globalThis.startedPayload.cacheToken;const ops=[];
  globalThis.testFileCache=async(_env,op,key)=>{ops.push({op,key});return null;};
  const req=(token,body)=>new Request('https://worker/media-cache/'+job.id,{method:'POST',headers:{'x-media-cache-token':token},body:JSON.stringify(body)});
  try {
    assert.equal((await mod.default.fetch(req('bad',{op:'put',key:'yt:test:mp3'}),env,{})).status,403);
    assert.equal(ops.length,0);
    assert.equal((await mod.default.fetch(req(token,{op:'get',key:'yt:test:mp3'}),env,{})).status,200);
    assert.deepEqual(ops,[{op:'get',key:'yt:test:mp3'}]);
    assert.equal((await mod.default.fetch(req(token,{op:'get',key:'../../private'}),env,{})).status,400);
  } finally {delete globalThis.testFileCache;}
});

test('persistent Telegram cache sanitizes context, expires entries, bounds storage and leaves admin counters intact',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  const sql={exec(query,...params){
    let rows=[],changes=0;
    if(/^\s*SELECT/i.test(query)) rows=db.prepare(query).all(...params);
    else if(params.length) changes=Number(db.prepare(query).run(...params).changes);
    else db.exec(query);
    return {toArray:()=>rows,one:()=>rows[0],rowsWritten:changes};
  }};
  const adminSource=await readFile(new URL('../src/admin.ts',import.meta.url),'utf8');
  const result=await build({stdin:{contents:adminSource,loader:'ts'},bundle:true,format:'esm',write:false,
    plugins:[{name:'durable-object',setup(b){b.onResolve({filter:/cloudflare:workers/},a=>({path:a.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}'}));}}]});
  const admin=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const instance=new admin.AdminStatsStore({storage:{sql}},{});
  const req=body=>instance.fetch(new Request('https://store/file-cache',{method:'POST',body:JSON.stringify(body)}));
  const key='yt:abcdefghijk:mp3';
  try {
    assert.equal((await req({op:'put',key,value:{method:'sendAudio',fileId:'valid_id',data:{caption:'Hello',chat_id:99,reply_parameters:'private'}}})).status,200);
    const hit=(await (await req({op:'get',key})).json()).value;
    assert.deepEqual(hit.data,{caption:'Hello'});
    await req({op:'put',key,value:{...hit,fileSize:12345,hasAudio:false}});
    const reusable=(await (await req({op:'get',key})).json()).value;
    assert.equal(reusable.fileSize,12345);assert.equal(reusable.hasAudio,false);
    await req({op:'put',key,value:{...hit,fileSize:-1,hasAudio:'true'}});
    const incomplete=(await (await req({op:'get',key})).json()).value;
    assert.equal(incomplete.fileSize,undefined);assert.equal(incomplete.hasAudio,undefined);
    db.prepare('UPDATE telegram_file_cache SET created_at=0 WHERE key=?').run(key);
    assert.equal((await (await req({op:'get',key})).json()).value,null);
    assert.equal((await req({op:'put',key,value:{method:'sendMessage',fileId:'valid'}})).status,400);
    assert.equal((await req({op:'put',key:'../private'})).status,400);
    const insert=db.prepare('INSERT OR REPLACE INTO telegram_file_cache VALUES (?,?,?)');
    for(let i=0;i<10002;i++)insert.run('test:'+i,JSON.stringify(hit),Date.now()+i);
    await req({op:'put',key,value:hit});
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM telegram_file_cache').get().n),10000);
    assert.equal(Number(db.prepare("SELECT value FROM counters WHERE key='successful_downloads'").get().value),0);
    await req({op:'delete',key});
    assert.equal((await (await req({op:'get',key})).json()).value,null);
    const names=[];
    await admin.telegramFileCache({BOT_TOKEN:'123:secret',ADMIN_STATS:{getByName(name){names.push(name);return {fetch:async()=>Response.json({value:hit})};}}},'get',key);
    assert.deepEqual(names,['telegram-files-123']);
    assert.equal(await admin.telegramFileCache({BOT_TOKEN:'123:secret'},'get',key),null);
  } finally {db.close();}
});

test('four social services accept individual links, normalize hosts and preserve exact IDs',()=>{
  const cases=[
    ['https://twitter.com/name/status/1234567890123456789?s=20','x','https://x.com/i/status/1234567890123456789'],
    ['https://x.com/i/web/status/123/video/2','x','https://x.com/i/status/123/video/2'],
    ['https://de.pinterest.com/pin/some-title--123456789/','pinterest','https://www.pinterest.com/pin/123456789/'],
    ['https://pin.it/AbC123','pinterest','https://pin.it/AbC123'],
    ['https://vm.tiktok.com/ABC123/','tiktok','https://vm.tiktok.com/ABC123/'],
    ['https://www.tiktok.com/t/ABC123/','tiktok','https://www.tiktok.com/t/ABC123/'],
    ['https://www.tiktok.com/@creator/photo/1234567890123456789?x=1','tiktok','https://www.tiktok.com/@creator/photo/1234567890123456789'],
    ['https://www.tiktok.com/@creator/video/1234567890123456789','tiktok','https://www.tiktok.com/@creator/video/1234567890123456789'],
    ['/soundcloud https://m.soundcloud.com/artist/track?utm=x','soundcloud','https://soundcloud.com/artist/track'],
    ['https://on.soundcloud.com/AbC123','soundcloud','https://on.soundcloud.com/AbC123'],
  ];
  for(const [text,platform,url] of cases) assert.deepEqual(mod.parseSocialUrl(text),{platform,url});
  assert.equal(mod.parseSocialUrl('این رو بفرست https://x.com/name/status/123،').platform,'x');
});

test('social parser rejects credentials, lookalike hosts, profiles, boards and other command routes',()=>{
  for(const text of [
    'https://x.com.evil/name/status/123','https://x.com@evil/name/status/123',
    'https://user:pass@x.com/name/status/123','https://x.com:8443/name/status/123',
    'https://x.com/name','https://x.com/i/spaces/123','https://www.pinterest.com/name/board/',
    'https://www.tiktok.com/@creator','https://www.tiktok.com/@creator/live',
    'https://soundcloud.com/artist/sets','https://soundcloud.com/artist/sets/playlist',
    'https://soundcloud.com/artist/tracks','https://soundcloud.com/search/sounds',
    'https://www.pinterest.evil/pin/123','https://vm.tiktok.com.evil/ABC123',
    '/findmusic https://x.com/name/status/123',
    'https://www.youtube.com/watch?v=abcdefghijk','https://www.instagram.com/reel/B/'
  ]) assert.equal(mod.parseSocialUrl(text),null,text);
});

test('YouTube video extraction normalizes individual videos and never scans a channel or search page',()=>{
  for(const url of ['https://youtu.be/abcdefghijk?si=tracking','http://m.youtube.com/shorts/abcdefghijk',
    'https://www.youtube-nocookie.com/embed/abcdefghijk','https://www.youtube.com/live/abcdefghijk',
    'https://music.youtube.com/watch?v=abcdefghijk&list=PLabcdef'])
    assert.equal(mod.extractYouTubeUrl('لینک '+url+'،'),'https://www.youtube.com/watch?v=abcdefghijk');
  for(const url of ['https://youtube.com/@creator','https://youtube.com/channel/UCabcdef',
    'https://youtube.com/results?search_query=hello','https://youtube.com/playlist?list=PLabcdef',
    'https://user:pass@youtube.com/watch?v=abcdefghijk','https://youtube.com:8443/watch?v=abcdefghijk',
    'https://youtube.com.evil/watch?v=abcdefghijk','https://youtube.com/watch?v=short'])
    assert.equal(mod.extractYouTubeUrl(url),null,url);
});

test('social webhook dispatches all providers into existing media job without music or YouTube substitution',async()=>{
  const jobs=[],workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:10}});
  for(const text of ['https://x.com/name/status/123','https://pin.it/ABC123','https://www.tiktok.com/@name/photo/123','https://soundcloud.com/artist/song']) await mediaWebhook({text},workerEnv);
  assert.deepEqual(jobs.map(j=>j.params.social.platform),['x','pinterest','tiktok','soundcloud']);
  assert.ok(jobs.every(j=>j.id.startsWith('igdl-')&&!j.params.instagram&&!j.params.quality&&!j.params.playlist));
  await mediaWebhook({text:'/soundcloud artist song'},workerEnv);
  assert.equal(jobs.length,4);
});

test('social workflow sends signed source, waits for event and uploads batch without publish retries',async()=>{
  const calls=[],messages=[],steps=[];globalThis.delivered=0;globalThis.containerIds=[];
  const social={platform:'pinterest',url:'https://www.pinterest.com/pin/123/'};
  globalThis.container={async startShared(){calls.push('boot');},
    async instagramRequest(action,payload){calls.push(action);if(action==='start')globalThis.startedPayload=payload;return {ok:true,parts:3};},
    async releaseInstagram(){calls.push('release');}};
  globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
  const step={async do(name,options,fn){if(typeof options==='function'){fn=options;options={};}steps.push({name,options});return fn();},
    async waitForEvent(name,options){steps.push({name,options});return {payload:{ok:true}};}};
  await new mod.YoutubeDownloadWorkflow({},{...env,INSTAGRAM_SESSIONID:undefined}).run({payload:{...job,instagram:undefined,social}},step);
  assert.deepEqual(calls,['boot','start','send','cleanup','release']);
  assert.deepEqual(globalThis.startedPayload.source.social,social);
  assert.match(globalThis.startedPayload.completionToken,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(globalThis.startedPayload.source).includes(env.INSTAGRAM_SESSIONID));
  assert.ok(steps.some(s=>s.options.type==='instagram-ready'));
  assert.equal(steps.find(s=>s.name==='send complete instagram recording').options.retries.limit,0);
  assert.equal(globalThis.delivered,3);assert.match(messages[0].text,/Pinterest/);
});

test('social batch failure preserves confirmed count and warns against duplicate sends',async()=>{
  const messages=[];globalThis.delivered=0;globalThis.containerIds=[];
  globalThis.container={async startShared(){},async instagramRequest(action){return action==='send'?{ok:false,parts:1,message:'1 file confirmed; check chat before repeating'}:{ok:true};},async releaseInstagram(){}};
  globalThis.fetch=async(url,init)=>{messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
  const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();},async waitForEvent(){return {payload:{ok:true}};}};
  await new mod.YoutubeDownloadWorkflow({},env).run({payload:{...job,instagram:undefined,social:{platform:'x',url:'https://x.com/i/status/123'}}},step);
  assert.ok(messages.some(m=>m.text==='1 file confirmed; check chat before repeating'));
  assert.equal(globalThis.delivered,1);
  assert.equal(globalThis.downloadHistory.at(-1).status,'partial');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,1);
});

test('Aparat video/embed links and social audio commands have exact routes',()=>{
  for(const url of ['https://www.aparat.com/v/wP8On?playlist=123','http://aparat.com/v/wP8On/title','https://www.aparat.com/video/video/embed/videohash/wP8On/vt/frame'])
    assert.deepEqual(mod.parseSocialUrl(url),{platform:'aparat',url:'https://www.aparat.com/v/wP8On'});
  for(const url of ['https://aparat.com/name','https://aparat.com/live/name','https://aparat.com.evil/v/test','https://user@aparat.com/v/test']) assert.equal(mod.parseSocialUrl(url),null);
  for(const url of ['https://x.com/name/status/123','https://www.tiktok.com/@name/video/123','https://www.pinterest.com/pin/123/','https://www.aparat.com/v/abc123'])
    assert.equal(mod.parseSocialUrl('/audio '+url).audioOnly,true);
});

test('Aparat and /audio queue source jobs without changing Instagram audio routing',async()=>{
  const jobs=[],workerEnv={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:10}});
  await mediaWebhook({text:'https://www.aparat.com/v/abc123'},workerEnv);
  await mediaWebhook({text:'/audio https://www.aparat.com/v/abc123'},workerEnv);
  await mediaWebhook({text:'/audio https://www.tiktok.com/@name/video/123'},workerEnv);
  await mediaWebhook({text:'/audio https://instagram.com/reel/B/'},workerEnv);
  assert.deepEqual(jobs.slice(0,3).map(j=>j.params.social.platform),['aparat','aparat','tiktok']);
  assert.equal(jobs[0].params.social.audioOnly,undefined);assert.equal(jobs[1].params.social.audioOnly,true);
  assert.equal(jobs[3].params.instagram.kind,'audio');
});

test('social audio callback is signed for the owner, chat, canonical URL and exact item',async()=>{
  const {createHmac}=await import('node:crypto');
  const jobs=[],original=env.YOUTUBE_DOWNLOAD_WORKFLOW;
  env.YOUTUBE_DOWNLOAD_WORKFLOW={async create(job){jobs.push(job);}};
  const url='https://www.pinterest.com/pin/123/';
  const sig=createHmac('sha256',env.BOT_TOKEN).update(`social-audio:42:42:1:${url}`).digest('hex').slice(0,16);
  const callback={id:'audio',from:{id:42},data:`soa|1|42|${sig}`,message:{message_id:55,chat:{id:42},caption:`Fixture\nPinterest 2/3\n${url}`}};
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:10}});
  try {
    for(const invalid of [
      {...callback,from:{id:99}}, {...callback,data:`soa|0|42|${sig}`},
      {...callback,message:{...callback.message,chat:{id:99}}},
      {...callback,message:{...callback.message,caption:'Fixture\nhttps://www.pinterest.com/pin/999/'}},
      {...callback,message:{...callback.message,caption:'https://evil.example/video'}},
    ]) await webhook(invalid);
    assert.equal(jobs.length,0);
    await webhook(callback);
    assert.equal(jobs[0].params.requestMessageId,55);
    assert.deepEqual(jobs[0].params.social,{platform:'pinterest',url,audioOnly:true,itemIndex:1});
    assert.ok(callback.data.length<=64);
  } finally {env.YOUTUBE_DOWNLOAD_WORKFLOW=original;}
});


test('partly delivered playlist is retained as partial history with its requested range',async()=>{
  globalThis.delivered=0;globalThis.containerIds=[];globalThis.downloadHistory=[];
  globalThis.container={async startShared(){},async instagramRequest(action){return action==='send'
    ?{ok:true,parts:2,partial:true,title:'Playlist',message:'2 of 3 tracks sent'}:{ok:true};},async releaseInstagram(){}};
  globalThis.fetch=async()=>Response.json({ok:true,result:{message_id:10}});
  const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();},async waitForEvent(){return {payload:{ok:true}};}};
  await new mod.YoutubeDownloadWorkflow({},env).run({payload:{...job,instagram:undefined,
    playlist:{url:'https://www.youtube.com/playlist?list=PLabcdef',start:1,end:3}}},step);
  assert.equal(globalThis.downloadHistory.at(-1).status,'partial');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,2);
  assert.match(globalThis.downloadHistory.at(-1).request,/1-3/);
  assert.equal(globalThis.delivered,2);
});
