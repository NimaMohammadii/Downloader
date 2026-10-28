import {build} from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
const parser = await build({entryPoints:['src/reddit.ts'],bundle:true,format:'esm',write:false});
const {parseRedditUrl} = await import(`data:text/javascript;base64,${Buffer.from(parser.outputFiles[0].text).toString('base64')}`);
const bundle = await build({entryPoints:['src/app-main.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'runtime',setup(b){
 b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
 b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}; export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}}':'export class Container{constructor(ctx,env){this.ctx=ctx;this.env=env;} renewActivityTimeout(){}}; export const getContainer=()=>globalThis.container;'}));
}}]});
const {default:worker,YoutubeDownloadWorkflow,YoutubeDownloaderContainer}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const secret='fictional-private-webhook-secret-32';
const env={BOT_TOKEN:'fictional',WEBHOOK_SECRET:secret,API_ID:'1',API_HASH:'fictional',DOWNLOAD_POOL:{getByName(){return {async acquire(){return {instance:0,token:'lease'};},async release(){}};}}};
const request=text=>new Request('https://worker/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify({update_id:8,message:{message_id:7,chat:{id:42,type:'private'},from:{id:42},text}})});
const job={id:'igdl-42-7-42',chatId:42,userId:42,requestMessageId:7,url:'',reddit:{url:'https://www.reddit.com/comments/abc123'}};

test('Reddit parser normalizes post, user post, gallery, share, short and native media links',()=>{
 for(const input of ['https://old.reddit.com/r/videos/comments/abc123/title/?share_id=x','https://reddit.com/user/example/comments/abc123/title','https://redd.it/abc123','https://www.reddit.com/gallery/abc123'])
  assert.deepEqual(parseRedditUrl(input),{url:'https://www.reddit.com/comments/abc123'},input);
 assert.deepEqual(parseRedditUrl('/reddit@Bot https://www.reddit.com/r/videos/s/AbC123'),{url:'https://www.reddit.com/r/videos/s/AbC123'});
 assert.deepEqual(parseRedditUrl('https://v.redd.it/abc123/DASH_720.mp4?source=fallback'),{url:'https://v.redd.it/abc123'});
 assert.deepEqual(parseRedditUrl('عکس https://i.redd.it/abc123.png،'),{url:'https://i.redd.it/abc123.png'});
});

test('Reddit parser rejects profiles, feeds, credentials, ports and deceptive hosts',()=>{
 for(const input of ['https://reddit.com/r/videos','https://reddit.com/user/example','https://reddit.com','https://reddit.com.evil.test/comments/abc123','https://u:p@reddit.com/comments/abc123','https://reddit.com:99/comments/abc123','https://evil.test/comments/abc123','https://v.redd.it/abc123/other','https://127.0.0.1/comments/abc123'])assert.equal(parseRedditUrl(input),null,input);
});

test('production webhook creates only a Reddit job and its command cannot delegate to another downloader',async()=>{
 const jobs=[],sent=[];
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:9}});};
 const bindings={...env,YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
 await worker.fetch(request('https://redd.it/abc123'),bindings,{});
 assert.equal(jobs.length,1);assert.deepEqual(jobs[0].params.reddit,job.reddit);
 for(const field of ['instagram','recognition','social','playlist','quality','bandcamp'])assert.equal(jobs[0].params[field],undefined);
 await worker.fetch(request('/reddit https://youtube.com/watch?v=abcdefghijk'),bindings,{});
 assert.equal(jobs.length,1);assert.ok(sent.some(x=>x.text?.includes('Reddit')));
 await worker.fetch(request('/bandcamp https://redd.it/abc123'),bindings,{});
 assert.equal(jobs.length,1);assert.ok(sent.some(x=>x.text?.includes('Bandcamp')));
});

test('Reddit uses the existing capacity lease and completion event without Instagram resolution',async()=>{
 const calls=[],payloads=[];
 globalThis.container={async startShared(){calls.push('boot');},async instagramRequest(action,payload){calls.push(action);payloads.push(payload);return action==='send'?{ok:true,parts:2,title:'Gallery'}:{ok:true};},async releaseInstagram(){calls.push('release');}};
 globalThis.fetch=async(url)=>{assert.ok(String(url).startsWith('https://api.telegram.org/'));return Response.json({ok:true,result:{message_id:10}});};
 const step={async do(name,opts,fn){return (typeof opts==='function'?opts:fn)();},async waitForEvent(name,opts){assert.equal(opts.type,'instagram-ready');return {payload:{ok:true}};}};
 await new YoutubeDownloadWorkflow({},env).run({payload:job},step);
 assert.deepEqual(calls,['boot','start','send','cleanup','release']);
 assert.deepEqual(payloads.find(x=>x.source).source,{mode:'replay',title:'Reddit',reddit:job.reddit});
});

test('Reddit ambiguous upload failure is reported with confirmed count and never retried',async()=>{
 const calls=[],sent=[];
 globalThis.container={async startShared(){},async instagramRequest(action){calls.push(action);return action==='send'?{ok:false,parts:1,message:'Reddit: one confirmed; delivery uncertain'}:{ok:true};},async releaseInstagram(){}};
 globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:10}});};
 const step={async do(name,opts,fn){if(name.startsWith('send complete'))assert.equal(opts.retries.limit,0);return (typeof opts==='function'?opts:fn)();},async waitForEvent(){return {payload:{ok:true}};}};
 await new YoutubeDownloadWorkflow({},env).run({payload:job},step);
 assert.equal(calls.filter(x=>x==='send').length,1);
 assert.ok(sent.some(x=>x.text==='Reddit: one confirmed; delivery uncertain'));
});

test('Reddit session refreshes per start and never reaches another platform or persisted state',async()=>{
 const stored=new Map(),bodies=[];const storage={async get(k){return stored.get(k);},async put(k,v){stored.set(k,v);},async transaction(fn){return fn(storage);}};
 const bindings={...env,REDDIT_COOKIES:'private-initial'};
 const container=new YoutubeDownloaderContainer({storage},bindings);
 container.containerFetch=async(url,init)=>{bodies.push(JSON.parse(init.body));return Response.json({ok:true});};
 const payload={id:job.id,source:{mode:'replay',reddit:job.reddit}};
 await container.instagramRequest('start',payload);
 bindings.REDDIT_COOKIES='private-rotated';await container.instagramRequest('start',payload);
 delete bindings.REDDIT_COOKIES;await container.instagramRequest('start',payload);
 await container.instagramRequest('start',{id:job.id,source:{mode:'replay',bandcamp:{url:'https://artist.bandcamp.com/track/song'}}});
 assert.deepEqual(bodies.slice(0,3).map(x=>x.redditCookies),['private-initial','private-rotated','']);
 assert.equal(bodies[3].redditCookies,undefined);assert.equal(payload.redditCookies,undefined);
 assert.ok(!JSON.stringify([...stored]).includes('private-'));
});

test('first-link membership gate applies to Reddit before any downloader is queued',async()=>{
 const jobs=[],links=[];
 const bindings={...env,ADMIN_STATS:{getByName(){return {async fetch(url,init){
  if(String(url).includes('/membership')){links.push(init?.body?JSON.parse(init.body):{});return Response.json({enabled:true,mode:'first_link',downloaded:false,linkTriggered:links.some(x=>x.triggerLink===true)});}
  return Response.json({ok:true});
 }}}},YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}}};
 globalThis.fetch=async()=>Response.json({ok:true,result:{status:'left',message_id:9}});
 await worker.fetch(request('https://redd.it/abc123'),bindings,{});
 assert.equal(jobs.length,0);assert.ok(links.some(x=>x.triggerLink===true));
});
