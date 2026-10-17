import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const story = await readFile(new URL('../src/story-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source + '\nexport {parseInstagramVideoTarget,resolveInstagramVideo,instagramVideoErrorText};', loader: 'ts' },
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
        export class AdminStatsStore{} export const ADMIN_USER_ID=1;
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
