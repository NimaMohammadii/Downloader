import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile('src/web-app.ts', 'utf8');
const bundle = await build({ external: ['node:async_hooks'],stdin:{contents:source,resolveDir:process.cwd()+'/src',loader:'ts'},
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
        'data: '+JSON.stringify({ok:true,state:'ready',fileId:id,title:'Fixture',quality:720,qualities:[360,720],fileName:'Fixture.mp4',size:8192,mime:'video/mp4',subtitles:[{id:'a'.repeat(16),language:'en',label:'English',kind:'manual',url:'https://www.youtube.com/api/timedtext?secret=hidden'},{id:'b'.repeat(16),language:'fa',label:'Persian',kind:'translated'},{id:'../secret',language:'en',label:'invalid',kind:'manual'}]})+'\n\n'];
      // Split across JSON, UTF-8 decoder and event boundaries.
      const bytes=encoder.encode(frames.join(''));
      return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
    }
    if(path==='/mini/subtitle')return new Response(request.method==='HEAD'?null:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n',{headers:{'content-type':'text/vtt'}});
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
  const {outputFiles}=await build({ external: ['node:async_hooks'],entryPoints:['src/web-ui.ts'],bundle:true,write:false,format:'esm'});
  const {WEB_APP_HTML:html}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  assert.doesNotMatch(script,/api\/status|function poll\(|setInterval\(/);
  assert.match(html,/id="analyze"[^>]*>Watch/);
  const fn=script.slice(script.indexOf('async function readApiResponse'),script.indexOf('function iconPlay'));
  const read=vm.runInNewContext(fn+';readApiResponse',{TextDecoder,Error});
  const response=new Response(new ReadableStream({start(c){for(const value of ['data: {"ok":true,"state":"preparing"}\n', '\n: alive\n\ndata: {"ok":true,', '"streamUrl":"/web/stream"}\n\n'])c.enqueue(encoder.encode(value));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  assert.equal((await read(response)).streamUrl,'/web/stream');
});


test('subtitle URLs are signed per track, browser session and video, never exposing source URLs',async()=>{
  const {env,calls}=setup(),cookie=await session(env);
  const response=await route(api('/web/api/watch',{videoId},cookie),env);
  const text=await response.text(),result=finalEvent(text);
  assert.doesNotMatch(text,/secret=hidden/);
  assert.equal(result.subtitles.length,2);
  const subtitle=result.subtitles[0];assert.equal(subtitle.kind,'manual');
  const loaded=await route(new Request(subtitle.url,{headers:{cookie}}),env);
  assert.equal(loaded.status,200);assert.match(loaded.headers.get('content-type'),/^text\/vtt/);
  assert.equal(loaded.headers.get('x-content-type-options'),'nosniff');
  assert.match(await loaded.text(),/^WEBVTT/);
  assert.match(calls.at(-1).url,/trackId=aaaaaaaaaaaaaaaa/);
  const head=await route(new Request(subtitle.url,{method:'HEAD',headers:{cookie}}),env);
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  const count=calls.length,secondCookie=await session(env);
  assert.equal((await route(new Request(subtitle.url,{headers:{cookie:secondCookie}}),env)).status,403);
  for(const [key,value] of [['track','b'.repeat(16)],['track','../secret'],['w','0'.repeat(32)],['e','1']]){
    const tampered=new URL(subtitle.url);tampered.searchParams.set(key,value);
    assert.equal((await route(new Request(tampered,{headers:{cookie}}),env)).status,403);
  }
  const wrongKind=new URL(result.streamUrl);wrongKind.pathname='/web/subtitle';wrongKind.searchParams.set('track','a'.repeat(16));
  assert.equal((await route(new Request(wrongKind,{headers:{cookie}}),env)).status,403);
  assert.equal(calls.length,count);
});

test('subtitle fetch failures stay separate from the video stream',async()=>{
  const {env,stub}=setup(),cookie=await session(env);
  const result=finalEvent(await (await route(api('/web/api/watch',{videoId},cookie),env)).text());
  const original=stub.webRequest;
  stub.webRequest=async request=>new URL(request.url).pathname==='/mini/subtitle'?new Response('<html>untrusted</html>',{status:502}):original(request);
  const response=await route(new Request(result.subtitles[0].url,{headers:{cookie}}),env);
  assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/<html>/);
  assert.equal((await route(new Request(result.streamUrl,{headers:{cookie}}),env)).status,206);
  stub.webRequest=async()=>Response.json({message:'YouTube could not provide this subtitle track (HTTP 429).'},{status:502});
  const limited=await route(new Request(result.subtitles[0].url,{headers:{cookie}}),env);
  assert.match((await limited.json()).message,/HTTP 429/);
  stub.webRequest=async()=>Response.json({message:'YouTube temporarily limited subtitles. Try again in 120 seconds.'},{status:502});
  const cooldown=await route(new Request(result.subtitles[0].url,{headers:{cookie}}),env);
  assert.match((await cooldown.json()).message,/120 seconds/);
  stub.webRequest=async()=>Response.json({message:'Cookie: private-secret https://private.example/token'},{status:502});
  const untrusted=await route(new Request(result.subtitles[0].url,{headers:{cookie}}),env);
  assert.doesNotMatch((await untrusted.json()).message,/private-secret|private.example/);
});

test('CC stays off by default, loads only the chosen track, preserves selection across quality changes and ignores stale events',async()=>{
  const {outputFiles}=await build({ external: ['node:async_hooks'],entryPoints:['src/web-ui.ts'],bundle:true,write:false,format:'esm'});
  const {WEB_APP_HTML:html}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const helpers=script.slice(script.indexOf('function subtitlesOpen()'),script.indexOf('function settingsOpen()'));
  const classList=()=>{const values=new Set();return {contains:k=>values.has(k),remove:k=>values.delete(k),toggle:(k,on)=>on?values.add(k):values.delete(k)}};
  const elements=[];
  function element(tag){return {tag,attributes:{},children:[],track:{mode:'disabled'},events:{},classList:classList(),
    setAttribute(k,v){this.attributes[k]=v},appendChild(e){this.children.push(e)},addEventListener(k,fn){this.events[k]=fn},
    remove(){const i=elements.indexOf(this);if(i>=0)elements.splice(i,1)}};}
  const subtitleRequests=[];
  const context={URL,Blob,AbortController,subtitleObjectUrl:null,subtitleFetchController:null,fetch:async(url,options)=>{subtitleRequests.push({url,options});return new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFixture\n',{headers:{'content-type':'text/vtt'}});},location:{href:origin+'/',origin},document:{createElement:element},subtitleTracks:[],selectedSubtitleId:'',subtitleVersion:0,
    video:{querySelectorAll(){return [...elements]},appendChild(e){elements.push(e)}},playerShell:{classList:classList()},
    subtitleButton:element('button'),subtitleMenu:element('div'),subtitleStatus:element('div'),playerSettings:element('button'),
    controlsTimer:null,showControls(){},clearTimeout(){}};
  vm.createContext(context);vm.runInContext(helpers,context);
  const tracks=[{id:'a'.repeat(16),label:'English',language:'en-orig',kind:'automatic',url:origin+'/web/subtitle?track=a'},
    {id:'b'.repeat(16),label:'فارسی <script>alert(1)</script>',language:'fa',kind:'translated',url:origin+'/web/subtitle?track=b'}];
  await context.setSubtitleTracks(tracks,false);assert.equal(elements.length,0);assert.equal(context.selectedSubtitleId,'');
  await context.selectSubtitle(tracks[0].id);assert.equal(elements.length,1);
  const first=elements[0];assert.equal(first.default,true);assert.equal(first.kind,'subtitles');assert.equal(first.srclang,'en');assert.equal(first.track.mode,'showing');
  await context.selectSubtitle(tracks[1].id);assert.equal(first.track.mode,'disabled');assert.equal(elements.length,1);
  const second=elements[0];assert.equal(second.label,tracks[1].label);assert.equal(second.srclang,'fa');
  assert.match(context.subtitleStatus.textContent,/Loading/);
  first.events.load();assert.match(context.subtitleStatus.textContent,/Loading/,'old load event must not change current track state');
  second.events.load();assert.equal(context.subtitleStatus.textContent,'');
  await context.setSubtitleTracks(tracks.map(t=>({...t,url:t.url+'&new-video-file=1'})),true);
  assert.equal(context.selectedSubtitleId,tracks[1].id);assert.equal(elements.length,1);assert.match(elements[0].src,/^blob:/);assert.match(subtitleRequests.at(-1).url,/new-video-file/);assert.equal(subtitleRequests.at(-1).options.credentials,'same-origin');
  elements[0].events.error();assert.equal(elements.length,0);assert.equal(context.selectedSubtitleId,'');assert.match(context.subtitleStatus.textContent,/unaffected/);
  await context.selectSubtitle(tracks[0].id);await context.selectSubtitle('');assert.equal(elements.length,0);assert.equal(context.subtitleButton.attributes['aria-pressed'],'false');
  await context.setSubtitleTracks([{...tracks[0],url:'https://evil.test/subtitles.vtt'}],false);
  assert.equal(context.subtitleButton.disabled,true);assert.equal(elements.length,0);
  context.fetch=async()=>Response.json({ok:false,message:'YouTube returned an empty subtitle track.'},{status:502});
  await context.setSubtitleTracks(tracks,false);await context.selectSubtitle(tracks[0].id);assert.equal(elements.length,0);assert.equal(context.selectedSubtitleId,'');assert.match(context.subtitleStatus.textContent,/empty subtitle/);
  let complete;context.fetch=()=>new Promise(resolve=>{complete=resolve;});const pending=context.selectSubtitle(tracks[0].id),signal=context.subtitleFetchController.signal;await context.selectSubtitle('');assert.equal(signal.aborted,true);complete(new Response('WEBVTT\n\n',{headers:{'content-type':'text/vtt'}}));await pending;assert.equal(elements.length,0);assert.equal(context.selectedSubtitleId,'');
});
