import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const story = await readFile(new URL('../src/story-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source + '\nexport {parseInstagramVideoTarget,parseInstagramAudioTarget,resolveInstagramVideo,instagramVideoErrorText,parsePlaylist,mediaCacheKey};', loader: 'ts' },
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
          onError(error){throw error;}
        }
        export const getContainer=(_env,id)=>{globalThis.containerIds.push(id);return globalThis.container;};` };
      if (a.path === 'cloudflare:workers') return { contents: 'export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}' };
      if (a.path === './admin') return { contents: `
        export const telegramFileCache=async(...args)=>globalThis.testFileCache ? globalThis.testFileCache(...args) : null; export class AdminStatsStore{} export const ADMIN_USER_ID=1;
        export const recordUserActivity=async()=>{};
        export const recordSuccessfulDelivery=async()=>{globalThis.delivered++;};` };
      throw Error(a.path);
    });
  } }],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const env = { BOT_TOKEN: 'fictional-bot-token', API_ID: '123', API_HASH: 'fictional-api-hash', INSTAGRAM_SESSIONID: '42%3Afictional-session' };
const liveUrl = 'https://scontent.cdninstagram.com/live.mpd';
const job = { id: 'igdl-42-7-42', chatId: 42, requestMessageId: 7, userId: 42, url: '', instagram: {kind:'live',broadcastId:'17900000000000001'} };
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

async function workflow(ready = {ok:true}) {
  const calls=[],steps=[],messages=[];
  globalThis.delivered=0; globalThis.containerIds=[];
  globalThis.container={
    async startAndWaitForPorts(){calls.push('start');},
    async instagramRequest(action,payload){calls.push(action);if(action==='start') globalThis.startedPayload=payload;return {ok:true};},
    async releaseInstagram(){calls.push('release');},
  };
  globalThis.fetch=async(url,init)=>{
    if(String(url).includes('api.telegram.org')){messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});}
    return Response.json({broadcast_status:'active',dash_playback_url:liveUrl});
  };
  const step={async do(name,options,fn){if(typeof options==='function'){fn=options;options={};}steps.push({name,options});return fn();},
    async waitForEvent(name,options){steps.push({name,options});return {payload:ready};}};
  await new mod.YoutubeDownloadWorkflow({},env).run({payload:job},step);
  return {calls,steps,messages};
}

test('recording waits for a completion event and sends one whole file', async()=>{
  const r=await workflow();
  assert.deepEqual(r.calls,['start','start','send','cleanup','release']);
  assert.equal(globalThis.delivered,1);
  assert.ok(r.steps.some(s=>s.options.type==='instagram-ready'&&s.options.timeout==='150 minutes'));
  assert.ok(r.steps.every(s=>!s.options.timeout?.endsWith('minutes')||s.options.type||parseInt(s.options.timeout)<=30));
  assert.ok(!JSON.stringify(globalThis.startedPayload).includes(env.INSTAGRAM_SESSIONID));
  assert.ok(Buffer.byteLength(globalThis.startedPayload.stopData)<=64);
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
  const map=new Map([['instagramJob',{id:job.id,until:Date.now()+7_200_000}]]);
  const storage={get:async key=>map.get(key),delete:async key=>map.delete(key)};
  globalThis.renewed=0;globalThis.expired=0;
  const container=new mod.YoutubeDownloaderContainer({storage},env);
  await container.onActivityExpired();assert.equal(globalThis.expired,0);assert.ok(globalThis.renewed);
  await container.releaseInstagram();assert.equal(container.sleepAfter,'5m');
  await container.onActivityExpired();assert.equal(globalThis.expired,1);
});

test('container restart wakes the recording workflow with an explicit failure',async()=>{
  const events=[];
  const storage={get:async()=>({id:job.id,until:Date.now()+1000})};
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
    async startAndWaitForPorts(){calls.push('boot');},
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

test('cache keys separate quality, bot-facing music query and private Instagram owners',async()=>{
  assert.notEqual(await mod.mediaCacheKey({...job,instagram:undefined,url:'https://www.youtube.com/watch?v=abcdefghijk',quality:720}),await mod.mediaCacheKey({...job,instagram:undefined,url:'https://www.youtube.com/watch?v=abcdefghijk',quality:1080}));
  const a=await mod.mediaCacheKey({...job,instagram:{kind:'music',query:'  ADELE   Hello '}});
  const b=await mod.mediaCacheKey({...job,instagram:{kind:'music',query:'Adele Hello'}});
  assert.equal(a,b);
  assert.equal(a,'mq:d1a0fb389cfe7ce8610222f4fa46b0ea5260d847374dcc8f446b4cde23e0eb43');
  assert.notEqual(await mod.mediaCacheKey({...job,instagram:{kind:'audio',mediaId:'123'}}),await mod.mediaCacheKey({...job,userId:99,instagram:{kind:'audio',mediaId:'123'}}));
});

test('a cache hit sends the Telegram file without booting the container',async()=>{
  const messages=[];globalThis.delivered=0;globalThis.containerIds=[];
  globalThis.fetch=async(url,init)=>{messages.push({url:String(url),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:10}});};
  globalThis.testFileCache=async(_env,op)=>op==='get'?{method:'sendAudio',fileId:'stored_id',data:{caption:'Hello'}}:null;
  const step={async do(name,options,fn){return (typeof options==='function'?options:fn)();}};
  try {
    await new mod.YoutubeDownloadWorkflow({},env).run({payload:{...job,instagram:{kind:'music',query:'Adele Hello'}}},step);
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
