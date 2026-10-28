import {build} from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';
const parser = await build({entryPoints:['src/bandcamp.ts'],bundle:true,format:'esm',write:false});
const {parseBandcampUrl} = await import(`data:text/javascript;base64,${Buffer.from(parser.outputFiles[0].text).toString('base64')}`);
const bundle = await build({entryPoints:['src/app-main.ts'],bundle:true,format:'esm',write:false,plugins:[{name:'runtime',setup(b){
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
 assert.equal(jobs.length,1);assert.deepEqual(jobs[0].params.bandcamp,{url:'https://artist.bandcamp.com/track/song'});
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
