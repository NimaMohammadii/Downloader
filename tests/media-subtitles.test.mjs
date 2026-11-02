import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const source=await readFile('src/youtube-main.ts','utf8');
import assert from 'node:assert/strict';
import test from 'node:test';
const bundle=await build({stdin:{contents:source+'\nexport {handleMediaSubtitleDownload,mediaCacheKey}; export * from "./youtube-subtitles";',resolveDir:process.cwd()+'/src',loader:'ts'},
 bundle:true,format:'esm',write:false,external:['node:async_hooks'],plugins:[{name:'runtime',setup(b){
 b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
 b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}}':'export class Container {} export const getContainer=()=>globalThis.mediaContainer;'}));
 }}]});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture(){
 const values=new Map(),calls=[],events=[];let serial=Promise.resolve();
 const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async delete(k){values.delete(k);},transaction(f){const p=serial.then(()=>f(storage));serial=p.catch(()=>{});return p;}};
 const request=body=>api.subtitleSettings(new Request('https://store/youtube-subtitles',{method:'POST',body:JSON.stringify(body)}),storage);
 const old=globalThis.fetch;globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:10}});};
 const env={BOT_TOKEN:'fake',ELEVEN_API:'fake-eleven',GPT_API:'fake-gpt',ADMIN_STATS:{getByName(){return{fetch:(url,init)=>request(JSON.parse(init.body))};}},YOUTUBE_DOWNLOAD_WORKFLOW:{async get(id){return {async sendEvent(e){events.push({id,...e});}};}}};
 const base={userId:42,chatId:42,messageId:10,videoId:'abcdefghijk',requestMessageId:7};
 const open=(source='instagram')=>request({...base,op:'open',menu:{...base,mediaJobId:'igdl-42-7-42',mediaSource:source,qualities:[],audioAvailable:false,preference:{enabled:false},createdAt:Date.now()}});
 const click=(id=42)=>api.handleMediaSubtitleDownload(env,{id:'c',from:{id},data:'msd|abcdefghijk|7|42',message:{message_id:10,chat:{id:42}}});
 return {env,calls,events,storage,request,base,open,click,close(){globalThis.fetch=old;}};
}
test('Instagram and Pinterest share language defaults, locks and atomic menu consumption',async()=>{
 const f=fixture();try{
 await f.open();await f.request({...f.base,op:'language',language:'de'});
 await f.click(43);assert.equal(f.events.length,0);
 await f.click();assert.deepEqual(f.events,[{id:'igdl-42-7-42',type:'media-subtitle-choice',payload:{subtitle:'de'}}]);
 // Event transport redelivery sends the same saved choice, even if an administrator locks after acceptance.
 await f.storage.put('youtube-subtitle-lock:global',true);await f.click();assert.equal(f.events[1].payload.subtitle,'de');
 const next={...f.base,messageId:11};
 const m=await (await f.request({...next,op:'open',menu:{...next,mediaSource:'pinterest',mediaJobId:'igdl-42-8-42',qualities:[],audioAvailable:false,createdAt:Date.now()}})).json();
 assert.equal(m.locked,true);assert.equal(m.preference.language,'de');assert.equal(m.preference.enabled,false);
 assert.equal(api.subtitleButtons(m)[0][0].icon_custom_emoji_id,'5296369303661067030');
 }finally{f.close();}
});
test('unselected language, missing keys and locked stale controls cannot start paid preparation',async()=>{
 const f=fixture();try{
 await f.open('pinterest');await f.request({...f.base,op:'enable',enabled:true});await f.click();assert.equal(f.events.length,0);
 await f.request({...f.base,op:'language',language:'fa'});f.env.GPT_API='';await f.click();assert.equal(f.events.length,0);
 await f.storage.put('youtube-subtitle-lock:user:42',true);await f.click();assert.equal(f.events[0].payload.subtitle,undefined);
 }finally{f.close();}
});
test('Workflow menu pauses the existing job and uses the shared controls; original Instagram cache remains isolated',async()=>{
 const f=fixture();try{
 const job={id:'igdl-42-7-42',userId:42,chatId:42,requestMessageId:7};
 const step={async do(_name,config,action){return (action||config)();},async waitForEvent(_name,config){assert.equal(config.type,'media-subtitle-choice');return {payload:{subtitle:'fr'}};}};
 await new api.YoutubeDownloadWorkflow({},f.env).chooseMediaSubtitles(job,step,10,'pinterest');assert.equal(job.subtitle,'fr');
 const edit=f.calls.filter(c=>c.body.reply_markup).at(-1).body;
 assert.ok(edit.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.startsWith('msd|')));
 assert.ok(!JSON.stringify(edit).includes('ytq|'));assert.ok(JSON.stringify(edit).includes('ytst|'));
 const plain={userId:42,instagram:{kind:'replay',shortcode:'abc',videoIndex:0}};
 assert.notEqual(await api.mediaCacheKey(plain),await api.mediaCacheKey({...plain,subtitle:'fr'}));
 }finally{f.close();}
});

test('Pinterest Workflow preserves the capture/send sequence and signs only the selected subtitle job',async()=>{
 for(const selected of [undefined,'fa','photo']) {
 const subtitle=selected==='photo'?undefined:selected,eligible=selected!=='photo';
 const f=fixture(),requests=[];try{
 const fetchStore=f.env.ADMIN_STATS.getByName;
 f.env.ADMIN_STATS={getByName(){const stub=fetchStore();return {fetch:(url,init)=>String(url).endsWith('/youtube-subtitles')?stub.fetch(url,init):Promise.resolve(Response.json({ok:true})),};}};
 f.env.API_ID='123';f.env.API_HASH='fixture-hash';f.env.DOWNLOAD_POOL={getByName(){return {async acquire(){return {instance:0,token:'lease'};},async release(){}};}};
 globalThis.mediaContainer={async startShared(){},async fetch(){return Response.json({ok:true,subtitleVersion:3});},async instagramRequest(action,payload){requests.push({action,payload});return {ok:true,parts:1};},async releaseInstagram(){}};
 const step={async do(_name,config,action){return (action||config)();},async waitForEvent(_name,config){return {payload:config.type==='media-subtitle-choice'?{subtitle}:{ok:true,subtitleEligible:eligible}};}};
 const job={id:'igdl-42-7-42',userId:42,chatId:42,requestMessageId:7,url:'',social:{platform:'pinterest',url:'https://www.pinterest.com/pin/123/'}};
 const result=await new api.YoutubeDownloadWorkflow({},f.env).runInstagram(job,step);
 assert.equal(result.ok,true);if(!eligible) assert.ok(!JSON.stringify(f.calls).includes('msd|'));assert.deepEqual(requests.map(x=>x.action),subtitle?['start','start','send','cleanup']:['start','send','cleanup']);
 const body=requests[subtitle?1:0].payload;
 assert.equal(body.subtitle,subtitle);
 if(subtitle){assert.equal(body.subtitleSource,'pinterest');assert.equal(body.subtitleBillingKey,job.id);assert.match(body.subtitleAuthorization,/^[a-f0-9]{64}$/);}
 else {assert.ok(!body.elevenApiKey);assert.ok(!body.gptApiKey);}
 }finally{f.close();}
 }
});
