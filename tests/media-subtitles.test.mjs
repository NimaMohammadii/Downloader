import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const source=await readFile('src/youtube-main.ts','utf8');
import assert from 'node:assert/strict';
import test from 'node:test';
const bundle=await build({stdin:{contents:source+'\nexport {handleMediaSubtitleDownload,openDeliveredSubtitles,handleSubtitleCallback,mediaCacheKey}; export * from "./youtube-subtitles"; export {sendInstagramPostDirect} from "./index";',resolveDir:process.cwd()+'/src',loader:'ts'},
 bundle:true,format:'esm',write:false,external:['node:async_hooks'],plugins:[{name:'runtime',setup(b){
 b.onResolve({filter:/^(cloudflare:workers|@cloudflare\/containers)$/},a=>({path:a.path,namespace:'runtime'}));
 b.onLoad({filter:/.*/,namespace:'runtime'},a=>({contents:a.path==='cloudflare:workers'?'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkflowEntrypoint{constructor(ctx,env){this.env=env;}}':'export class Container {} export const getContainer=()=>globalThis.mediaContainer;'}));
 }}]});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture(){
 const values=new Map(),calls=[],jobs=new Map();let serial=Promise.resolve();
 const storage={async get(k){return structuredClone(values.get(k));},async put(k,v){values.set(k,structuredClone(v));},async delete(k){values.delete(k);},transaction(f){const p=serial.then(()=>f(storage));serial=p.catch(()=>{});return p;}};
 const old=globalThis.fetch;globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});return Response.json({ok:true,result:{message_id:10,video:{file_id:'file',file_size:100}}});};
 const env={BOT_TOKEN:'fake',ELEVEN_API:'fake-eleven',GPT_API:'fake-gpt',ADMIN_STATS:{getByName(){return{fetch:(url,init)=>String(url).endsWith('/youtube-subtitles')?api.subtitleSettings(new Request(url,init),storage):Promise.resolve(Response.json({ok:true})),};}},YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){if(jobs.has(job.id))throw Error('already exists');jobs.set(job.id,job);}}};
 const message={message_id:10,chat:{id:42},video:{file_id:'file'},reply_markup:{inline_keyboard:[[{text:'Audio',callback_data:'iga|p|abc|2|42'},{text:'Song',callback_data:'igm|p|abc|2|42'}]]}};
 const click=(data,id=42,msg=message)=>({id:'click',from:{id},data,message:msg});
 return {env,calls,jobs,storage,message,click,close(){globalThis.fetch=old;}};
}
function controls(f,prefix){return f.calls.filter(c=>c.method==='editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard.flat().find(b=>b.callback_data.startsWith(prefix)).callback_data;}

test('delivered Instagram video has subtitles below audio/song; controls edit its keyboard and start only the requested subtitle copy',async()=>{
 const f=fixture();try{
 await api.sendInstagramPostDirect(f.env,{kind:'post',shortcode:'abc',url:'https://www.instagram.com/p/abc/'},{message_id:7,chat:{id:42},from:{id:42}},[{kind:'video',url:'https://scontent.cdninstagram.com/a.mp4',width:640,height:360,size:100}],'ig:42:7:42');
 const sent=f.calls.find(c=>c.method==='sendVideo').body;
 assert.equal(sent.reply_markup.inline_keyboard[0].length,2);assert.match(sent.reply_markup.inline_keyboard[1][0].callback_data,/^mss\|p\|abc\|0\|42\|/);
 assert.equal(f.jobs.size,0);
 f.message.reply_markup=sent.reply_markup;
 await api.openDeliveredSubtitles(f.env,f.click(sent.reply_markup.inline_keyboard[1][0].callback_data));
 assert.deepEqual(f.calls.filter(c=>c.method==='editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard[0],sent.reply_markup.inline_keyboard[0]);
 await api.handleSubtitleCallback(f.env,f.click(controls(f,'ytst|')));
 const languages=f.calls.filter(c=>c.method==='editMessageReplyMarkup').at(-1).body.reply_markup.inline_keyboard;
 assert.equal(languages.flat().filter(b=>b.callback_data.startsWith('ytsl|')).length,12);
 await api.handleSubtitleCallback(f.env,f.click(languages.flat().find(b=>b.callback_data.endsWith('|de')).callback_data));
 const download=controls(f,'msd|');await api.handleMediaSubtitleDownload(f.env,f.click(download));await api.handleMediaSubtitleDownload(f.env,f.click(download));
 assert.equal(f.jobs.size,1);const job=[...f.jobs.values()][0].params;assert.equal(job.subtitle,'de');assert.equal(job.subtitlePostIndex,0);assert.equal(job.requestMessageId,10);
 assert.ok(!f.calls.some(c=>c.method==='editMessageText'),'the video caption stays intact');
 }finally{f.close();}
});

test('locked, tampered and foreign entry buttons cannot start subtitle work',async()=>{
 const f=fixture();try{
 await f.storage.put('youtube-subtitle-lock:global',true);
 const row=await api.instagramSubtitleEntry(f.env,42,42,'p','abc',2);assert.equal(row[0].icon_custom_emoji_id,'5296369303661067030');
 for(const [data,owner] of [[row[0].callback_data,43],[row[0].callback_data.replace('|abc|','|xyz|'),42]]) await api.openDeliveredSubtitles(f.env,f.click(data,owner));
 assert.equal(f.calls.filter(c=>c.method==='editMessageReplyMarkup').length,0);
 await api.openDeliveredSubtitles(f.env,f.click(row[0].callback_data));
 assert.ok(f.calls.some(c=>c.method==='answerCallbackQuery'&&c.body.show_alert&&c.body.text.includes('مدیریت')));
 await api.handleMediaSubtitleDownload(f.env,f.click(controls(f,'msd|')));assert.equal(f.jobs.size,0);
 }finally{f.close();}
});

test('Pinterest entry binds the original delivered pin and item; selecting a language requests that video only',async()=>{
 const f=fixture();try{
 const {createHmac}=await import('node:crypto');const url='https://www.pinterest.com/pin/123/';
 const sig=createHmac('sha256','fake').update(`social-audio:42:42:2:${url}`).digest('hex').slice(0,16);
 f.message.caption='Pinterest\n'+url;
 await api.openDeliveredSubtitles(f.env,f.click(`mss|n|2|42|${sig}`));
 await api.handleSubtitleCallback(f.env,f.click(controls(f,'ytst|')));
 await api.handleSubtitleCallback(f.env,f.click(controls(f,'ytsl|')));
 await api.handleMediaSubtitleDownload(f.env,f.click(controls(f,'msd|')));
 assert.deepEqual([...f.jobs.values()][0].params.social,{platform:'pinterest',url,itemIndex:2});
 }finally{f.close();}
});

test('ordinary Pinterest request no longer waits for a subtitle choice before sending',async()=>{
 const f=fixture(),requests=[],waits=[];try{
 f.env.API_ID='123';f.env.API_HASH='fixture';f.env.DOWNLOAD_POOL={getByName(){return{async acquire(){return{instance:0,token:'lease'};},async release(){}};}};
 globalThis.mediaContainer={async startShared(){},async instagramRequest(action,payload){requests.push(action);return{ok:true,parts:1};},async releaseInstagram(){}};
 const step={async do(_name,config,action){return(action||config)();},async waitForEvent(_name,config){waits.push(config.type);return{payload:{ok:true}};}};
 const result=await new api.YoutubeDownloadWorkflow({},f.env).runInstagram({id:'igdl-42-7-42',userId:42,chatId:42,requestMessageId:7,url:'',social:{platform:'pinterest',url:'https://www.pinterest.com/pin/123/'}},step);
 assert.equal(result.ok,true);assert.deepEqual(waits,['instagram-ready']);assert.deepEqual(requests,['start','send','cleanup']);
 }finally{f.close();}
});

test('container subtitle-state read is capability protected and bound to its job owner',async()=>{
 const f=fixture();try{
 await f.storage.put('youtube-subtitle-lock:user:42',true);
 const {createHmac}=await import('node:crypto');const id='igdl-42-7-42';
 const request=token=>new Request(`https://worker/media-cache/${id}`,{method:'POST',headers:{'x-media-cache-token':token},body:JSON.stringify({op:'subtitle-state',key:'subtitle',userId:43})});
 assert.equal((await api.default.fetch(request('wrong'),f.env,{})).status,403);
 const r=await api.default.fetch(request(createHmac('sha256','fake').update(`cache:${id}`).digest('hex')),f.env,{});
 assert.equal(r.status,200);assert.equal((await r.json()).value.locked,true);
 }finally{f.close();}
});
