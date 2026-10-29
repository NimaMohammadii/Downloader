import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { setWebhook } from '../scripts/set-webhook.mjs';

const result=await build({ external: ['node:async_hooks'],entryPoints:['src/app-main.ts'],bundle:true,format:'esm',write:false,
  plugins:[{name:'cloudflare-runtime',setup(b){
    b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
    b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'
      ? 'export class DurableObject{};export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}};'
      : 'export class Container{};export function getContainer(){throw Error("unexpected container startup");}'}));
  }}]});
const {default:worker,YoutubeDownloadWorkflow}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const secret='fictional-private-webhook-secret-32';
const legacy='dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1';

test('health identifies the deployed download fix without starting a container',async()=>{
  const response=await worker.fetch(new Request('https://worker/health'),{BOT_TOKEN:'fictional'},{});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.downloadFixVersion,'pool-five-v1');
  assert.equal(body.botConfigured,true);
});
const request=(text,value)=>new Request('https://worker/telegram/webhook',{method:'POST',
  headers:{'x-telegram-bot-api-secret-token':value,'content-type':'application/json'},
  body:JSON.stringify({update_id:1,message:{message_id:7,from:{id:42},chat:{id:42},text}})});

test('configured webhook secret rejects the former public value on every active route',async()=>{
  const calls=[],env={BOT_TOKEN:'fictional',WEBHOOK_SECRET:secret,
    YOUTUBE_DOWNLOAD_WORKFLOW:{async create(){calls.push('job');}}};
  globalThis.fetch=async()=>{calls.push('network');throw Error('unexpected network');};
  for(const text of ['/start','/admin','/music Hello','https://youtube.com/watch?v=abcdefghijk',
    'https://instagram.com/reel/B/','https://instagram.com/stories/example/123/','/live example']) {
    assert.equal((await worker.fetch(request(text,legacy),env,{})).status,403,text);
    assert.equal((await worker.fetch(request(text,'wrong'),env,{})).status,403,text);
  }
  assert.deepEqual(calls,[]);
});

test('configured webhook secret reaches YouTube, music and delegated Instagram handlers',async()=>{
  const jobs=[],calls=[],env={BOT_TOKEN:'fictional',WEBHOOK_SECRET:secret,
    YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  globalThis.fetch=async(url)=>{
    calls.push(String(url));
    if(String(url).includes('api.telegram.org')) return Response.json({ok:true,result:{message_id:10}});
    return Response.json({message:'login_required'},{status:401});
  };
  for(const text of ['/start','/music Hello','https://youtube.com/watch?v=abcdefghijk',
    'https://instagram.com/reel/B/','https://instagram.com/stories/example/123/'])
    assert.equal((await worker.fetch(request(text,secret),env,{})).status,200,text);
  assert.equal(jobs.length,4);
  assert.deepEqual(jobs.slice(2).map(job=>job.params.instagramApi),[{provider:'apify',account:1},{provider:'apify',account:1}]);
  assert.ok(!calls.some(url=>url.includes('instagram.com')),'Instagram extraction is deferred until the authenticated Workflow runs');
});

test('the production entrypoint queues and downloads an Instagram reel through the selected API without oEmbed', async () => {
  const sent = [], instagram = [], jobs=[];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.hostname === 'api.telegram.org') {
      const method = target.pathname.split('/').at(-1);
      sent.push({ method, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 99, ...(method === 'sendVideo' ? { video: { file_id: 'fixture-video' } } : {}) } });
    }
    if (target.hostname === 'scontent.cdninstagram.com') return new Response(null, { headers: { 'content-length': '1000000' } });
    instagram.push(target.pathname);
    if(target.hostname==='api.apify.com'){
      if(target.pathname.endsWith('/runs'))return Response.json({data:{id:'auditRun00001',status:'SUCCEEDED',defaultDatasetId:'auditDataset00001'}});
      return Response.json([{type:'Video',shortCode:'B',videoUrl:'https://scontent.cdninstagram.com/fixture.mp4',width:720,height:1280}]);
    }
    if (target.pathname === '/reel/B/') return new Response('<html></html>');
    if (target.pathname === '/api/v1/oembed/') return new Response(null, { status: 403 });
    if (target.pathname === '/api/v1/media/1/info/') return Response.json({ items: [{
      code: 'B', video_versions: [{ url: 'https://scontent.cdninstagram.com/fixture.mp4', width: 720, height: 1280 }],
    }] });
    throw Error('Unexpected Instagram endpoint');
  };
  const bindings={BOT_TOKEN:'fixture',WEBHOOK_SECRET:secret,APIFY_API_TOKEN:'private-audit-token',YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
  const response = await worker.fetch(new Request('https://worker/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ update_id: 92, message: { message_id: 8, from: { id: 42 }, chat: { id: -42 },
      text: 'https://www.instagram.com/reel/B/' } }),
  }), bindings, {});
  assert.equal(response.status, 200);
  assert.equal(jobs.length,1);assert.deepEqual(jobs[0].params.instagramApi,{provider:'apify',account:1});
  assert.deepEqual(instagram,[]);assert.equal(sent.length,0);
  await new YoutubeDownloadWorkflow({},bindings).run({payload:jobs[0].params},{async do(name,opts,fn){return (typeof opts==='function'?opts:fn)();}});
  assert.deepEqual(instagram,['/v2/actors/topapi~instagram-scraper/runs','/v2/datasets/auditDataset00001/items']);
  assert.equal(sent.filter(item => item.method === 'sendVideo').length, 1);
  assert.equal(sent.find(item => item.method === 'sendVideo').body.width, 720);
});

test('independent Instagram action completion events and cache calls retain HMAC authentication',async()=>{
  const events=[],stores=[],token='fictional',env={BOT_TOKEN:token,
    YOUTUBE_DOWNLOAD_WORKFLOW:{async get(id){return {async sendEvent(event){events.push({id,event});}};}},
    ADMIN_STATS:{getByName(){return {async fetch(req){stores.push(await req.json());return Response.json({value:null});}};}}};
  for(const suffix of ['audio','song']) {
    const id=`igdl--42-55-42-${suffix}`;
    const signature=value=>createHmac('sha256',token).update(value).digest('hex');
    const event=new Request(`https://worker/instagram/events/${id}`,{method:'POST',
      headers:{'x-instagram-event-token':signature(`event:${id}`)},body:JSON.stringify({ok:true})});
    assert.equal((await worker.fetch(event,env,{})).status,200);
    const cache=new Request(`https://worker/media-cache/${id}`,{method:'POST',
      headers:{'x-media-cache-token':signature(`cache:${id}`)},body:JSON.stringify({op:'get',key:'ig:42:123:0:audio'})});
    assert.equal((await worker.fetch(cache,env,{})).status,200);
  }
  assert.equal(events.length,2);assert.equal(stores.length,2);
  assert.notEqual(events[0].id,events[1].id);
});

test('webhook rotation keeps pending updates and never exposes token-bearing failures',async()=>{
  const env={BOT_TOKEN:'123:fictional-token',WEBHOOK_SECRET:secret};
  let payload;
  await setWebhook(env,async(url,init)=>{
    assert.equal(new URL(url).hostname,'api.telegram.org');
    assert.equal(init.redirect,'error');payload=JSON.parse(init.body);
    return Response.json({ok:true,result:true});
  });
  assert.equal(payload.secret_token,secret);
  assert.equal(payload.drop_pending_updates,false);
  assert.equal(payload.url,'https://downloader.vexaagent.workers.dev/telegram/webhook');
  await assert.rejects(()=>setWebhook(env,async()=>{throw Error(env.BOT_TOKEN);}),error=>{
    assert.ok(!error.message.includes(env.BOT_TOKEN));return true;
  });
  await assert.rejects(()=>setWebhook({BOT_TOKEN:env.BOT_TOKEN,WEBHOOK_SECRET:''},()=>{throw Error('must not call');}),/Set BOT_TOKEN/);
});

test('unexpected request failures return only the public error message', async()=>{
  const response=await worker.fetch(new Request('https://worker/health'),{
    get BOT_TOKEN(){throw Error('PRIVATE_INTERNAL_CAUSE');}
  },{});
  assert.equal(response.status,500);
  const body=await response.json();
  assert.equal(body.ok,false);
  assert.ok(body.message.includes('بررسی و پیگیری'));
  assert.ok(!JSON.stringify(body).includes('PRIVATE_INTERNAL_CAUSE'));
});
