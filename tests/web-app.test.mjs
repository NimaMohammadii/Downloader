import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile('src/web-app.ts', 'utf8');
const bundle = await build({stdin:{contents:source,resolveDir:process.cwd()+'/src',loader:'ts'},
  bundle:true,write:false,format:'esm',plugins:[{name:'runtime',setup(b){
    b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
    b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'
      ? 'export class DurableObject{};export class WorkflowEntrypoint{};'
      : `export class Container {constructor(ctx,env){this.ctx=ctx;this.env=env;} async startAndWaitForPorts(options){this.options=options;} async containerFetch(request){this.forwarded=request;return new Response('forwarded');}}
         export function getContainer(namespace,name){return namespace.getByName(name);}`}));
  }}]});
const {handleWebAppRequest:route,WebAppContainer:WebContainer} = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const origin='https://vexa.test', videoId='abcdefghijk', tabId='test-tab-00000001';
const encoder=new TextEncoder();
function setup(){
  const calls=[];
  const stub={async webRequest(request){calls.push(request);const path=new URL(request.url).pathname;
    if(path==='/metadata')return Response.json({ok:true,videoId,title:'Fixture',qualities:[360,720],audioAvailable:true});
    if(path.endsWith('/start')){const body=await request.json(),id=body.streamId||body.fileId;
      const frames=['data: {"ok":true,"state":"preparing"}\n\n',': preparing\n\n',
        'data: '+JSON.stringify({ok:true,state:'ready',fileId:id,title:'Fixture',quality:720,qualities:[360,720],fileName:'Fixture.mp4',size:8192,mime:'video/mp4'})+'\n\n'];
      // Split across JSON, UTF-8 decoder and event boundaries.
      const bytes=encoder.encode(frames.join(''));
      return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
    }
    if(path==='/mini/watch'||path==='/mini/file')return new Response(request.method==='HEAD'?null:'abcd',{
      status:request.headers.get('range')==='bytes=999-'?416:206,
      headers:{'content-type':'video/mp4','content-range':request.headers.get('range')==='bytes=999-'?'bytes */8192':'bytes 0-3/8192','accept-ranges':'bytes','content-length':request.method==='HEAD'?'8192':'4'}});
    throw Error('unexpected route '+path);
  }};
  const env={BOT_TOKEN:'fictional-web-session-key',WEB_APP_CONTAINER:{getByName(name){assert.match(name,/^web-/);return stub;}}};
  return {env,calls,stub};
}
async function session(env){const response=await route(new Request(origin),env);return response.headers.get('set-cookie').split(';')[0];}
function api(path,body,cookie){return new Request(origin+path,{method:'POST',headers:{'content-type':'application/json','x-vexa-app':'web',origin,cookie},body:JSON.stringify({tabId,...body})});}
function finalEvent(text){return text.split('\n\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6))).at(-1);}

test('web transport uses its own binding and leaves the original bot class untouched',async()=>{
  const entry=await readFile('src/app-main.ts','utf8');
  assert.match(entry,/export \{ AdminStatsStore, DownloadPool, YoutubeDownloaderContainer, YoutubeDownloadWorkflow \} from "\.\/youtube-main"/);
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  assert.equal(config.durable_objects.bindings.find(b=>b.name==='YOUTUBE_DOWNLOADER_CONTAINER').class_name,'YoutubeDownloaderContainer');
  assert.equal(config.durable_objects.bindings.find(b=>b.name==='WEB_APP_CONTAINER').class_name,'WebAppContainer');
  const docker=await readFile('Dockerfile','utf8'), startup=await readFile('container/start.sh','utf8');
  assert.match(docker,/CMD \[\"\/app\/start\.sh\"\]/);
  assert.match(startup,/exec \/opt\/venv\/bin\/python \/app\/youtube_pipeline\.py/);
  const web=new WebContainer({},{});
  const response=await web.webRequest(new Request('http://container/metadata',{method:'POST'}));
  assert.equal(await response.text(),'forwarded');
  assert.deepEqual(web.entrypoint,['/opt/venv/bin/python','/app/mini_async_entry.py']);
});

test('HTML establishes the signed HttpOnly browser session before video requests',async()=>{
  const {env,calls}=setup();const html=await route(new Request(origin),env);
  assert.match(html.headers.get('set-cookie'),/__Host-vexa_session=.*Secure; HttpOnly; SameSite=Lax/);
  assert.equal(calls.length,0);
  const head=await route(new Request(origin+'/app',{method:'HEAD'}),env);assert.equal(await head.text(),'');
});

test('web metadata rejects missing auth and cross-site requests before container access',async()=>{
  const {env,calls}=setup(),cookie=await session(env);
  assert.equal((await route(api('/web/api/metadata',{url:'https://youtu.be/'+videoId},''),env)).status,401);
  const request=api('/web/api/metadata',{url:'https://youtu.be/'+videoId},cookie);request.headers.set('origin','https://evil.test');
  assert.equal((await route(request,env)).status,401);assert.equal(calls.length,0);
  const result=await route(api('/web/api/metadata',{url:'https://youtu.be/'+videoId},cookie),env);
  assert.equal((await result.json()).videoId,videoId);assert.equal(new URL(calls[0].url).pathname,'/metadata');
});

test('watch signs only the completed file and supports Range, HEAD and 416',async()=>{
  const {env,calls}=setup(),cookie=await session(env);
  const response=await route(api('/web/api/watch',{videoId},cookie),env);
  assert.match(response.headers.get('content-type'),/event-stream/);
  const result=finalEvent(await response.text());assert.equal(result.ok,true);assert.deepEqual(result.qualities,[720,360]);
  const request=new Request(result.streamUrl,{headers:{cookie,range:'bytes=0-3'}});
  const media=await route(request,env);assert.equal(media.status,206);assert.equal(await media.text(),'abcd');
  assert.equal(calls.at(-1).headers.get('range'),'bytes=0-3');
  const head=await route(new Request(result.streamUrl,{method:'HEAD',headers:{cookie}}),env);assert.equal(await head.text(),'');
  const badRange=await route(new Request(result.streamUrl,{headers:{cookie,range:'bytes=999-'}}),env);assert.equal(badRange.status,416);assert.equal(badRange.headers.get('content-range'),'bytes */8192');
  const secondCookie=await session(env);const count=calls.length;
  assert.equal((await route(new Request(result.streamUrl,{headers:{cookie:secondCookie}}),env)).status,403);
  const tampered=new URL(result.streamUrl);tampered.searchParams.set('w','a'.repeat(32));
  assert.equal((await route(new Request(tampered,{headers:{cookie}}),env)).status,403);assert.equal(calls.length,count);
});

test('download uses the same preparation response without status polling',async()=>{
  const {env,calls}=setup(),cookie=await session(env);
  const response=await route(api('/web/api/start',{videoId,quality:360},cookie),env);
  const result=finalEvent(await response.text());assert.equal(result.state,'ready');assert.ok(result.downloadUrl);
  assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).pathname,'/mini/start');
  assert.equal((await route(api('/web/api/status',{jobId:'a'.repeat(32)},cookie),env)).status,404);
});

test('unavailable quality and invalid video IDs cannot start a web job',async()=>{
  const {env,calls}=setup(),cookie=await session(env);
  for(const body of [{videoId,quality:144},{videoId:'short'},{videoId,audioMode:'hq'}])
    assert.equal((await route(api('/web/api/watch',body,cookie),env)).status,400);
  assert.equal(calls.length,0);
});

test('incomplete preparation fails explicitly and never exposes an unsigned stream',async()=>{
  const {env,stub}=setup(),cookie=await session(env);
  stub.webRequest=async()=>new Response('data: {"ok":true,"state":"preparing"}\n\n',{headers:{'content-type':'text/event-stream'}});
  const response=await route(api('/web/api/watch',{videoId},cookie),env);
  const result=finalEvent(await response.text());assert.equal(result.ok,false);assert.match(result.message,/interrupted/);assert.equal(result.streamUrl,undefined);
});

test('browser event reader handles chunked completion without polling and UI scripts parse',async()=>{
  const {outputFiles}=await build({entryPoints:['src/web-ui.ts'],bundle:true,write:false,format:'esm'});
  const {WEB_APP_HTML:html}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  assert.doesNotMatch(script,/api\/status|function poll\(|setInterval\(/);
  assert.match(html,/id="analyze"[^>]*>Watch/);
  const fn=script.slice(script.indexOf('async function readApiResponse'),script.indexOf('function iconPlay'));
  const read=vm.runInNewContext(fn+';readApiResponse',{TextDecoder,Error});
  const response=new Response(new ReadableStream({start(c){for(const value of ['data: {"ok":true,"state":"preparing"}\n', '\n: alive\n\ndata: {"ok":true,', '"streamUrl":"/web/stream"}\n\n'])c.enqueue(encoder.encode(value));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  assert.equal((await read(response)).streamUrl,'/web/stream');
});
