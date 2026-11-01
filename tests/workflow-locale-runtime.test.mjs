import { build } from 'esbuild';
import * as runtime from 'miniflare';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('real Workers Workflow steps preserve the request language at the Telegram presentation boundary', async () => {
  const {outputFiles} = await build({stdin:{contents:`
    import {WorkflowEntrypoint} from 'cloudflare:workers';
    import {withUserLanguage,currentLanguage} from './src/localization';
    import {telegramCall,YoutubeDownloadWorkflow} from './src/youtube-main';
    export class LocaleProbe extends WorkflowEntrypoint {
      async run(event,step) {
        if(event.payload.actual) {
          const job=Object.create(YoutubeDownloadWorkflow.prototype);
          Object.defineProperty(job,'env',{value:{BOT_TOKEN:'LOCAL_TEST_ONLY'}});
          const chatId={en:1001,ru:1002,fa:1003}[event.payload.language];
          // Missing API credentials intentionally stop before reserving a container
          // or performing any download. The production status and failure sends run.
          await job.run({payload:{id:'local-'+event.payload.language,userId:42,chatId,
            requestMessageId:7,url:'',language:event.payload.language,
            instagram:{kind:'music',query:'Local test only'}}},step);
          return {production:true};
        }
        return withUserLanguage({},42,async()=> {
          const before=currentLanguage();
          const sent=await step.do('show download status',async()=>{
            const ambient=currentLanguage();
            const result=await telegramCall('LOCAL_TEST_ONLY','editMessageText',
              {chat_id:42,message_id:10,text:'⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…'},event.payload.language);
            return {ambient,text:result.text};
          });
          return {before,sent,after:currentLanguage()};
        },event.payload.language);
      }
    }
    export default {async fetch(req,env) {
      const url=new URL(req.url);const id=url.searchParams.get('language');
      if(url.pathname==='/start') {await env.PROBE.create({id,params:{language:id.startsWith('actual-')?id.slice(7):id,actual:id.startsWith('actual-')}});return Response.json({id});}
      return Response.json(await (await env.PROBE.get(id)).status());
    }};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',external:['cloudflare:workers','node:async_hooks'],write:false,
    plugins:[{name:'export-tested-presentation-helper',setup(b){b.onLoad({filter:/youtube-main\.ts$/},a=>({contents:readFileSync(a.path,'utf8')+'\nexport {telegramCall};',loader:'ts'}));}}]});
  const calls=[];
  // cf:false disables Miniflare's optional external cf.json lookup. Every outbound
  // Worker request is intercepted locally; no Telegram or Cloudflare network is used.
  const options={cf:false,workers:[{name:'locale-probe',modules:true,script:outputFiles[0].text,
    compatibilityDate:'2026-08-14',compatibilityFlags:['nodejs_compat'],
    workflows:{PROBE:{name:'locale-probe',className:'LocaleProbe'}},
    outboundService:async request=>{
      assert.match(request.url,/^https:\/\/api\.telegram\.org\/botLOCAL_TEST_ONLY\/(?:sendMessage|editMessageText|sendMessageDraft)$/);
      const payload=await request.json();calls.push(payload);
      return Response.json({ok:true,result:{message_id:10,text:payload.text}});
    }}]};
  const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(options) : options);
  try {
    for(const language of ['en','ru','fa','actual-en','actual-ru','actual-fa']) await mf.dispatchFetch('http://test/start?language='+language);
    await new Promise(resolve=>setTimeout(resolve,3500));
    const expected={en:'⬇️ Downloading your chosen song…',ru:'⬇️ Скачиваю выбранную песню…',fa:'⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…'};
    for(const language of ['en','ru','fa']) {
      const result=await (await mf.dispatchFetch('http://test/result?language='+language)).json();
      assert.equal(result.status,'complete',JSON.stringify(result));
      assert.equal(result.output.before,language);
      assert.ok(['fa',language].includes(result.output.sent.ambient)); // The current engine drops the outer scope here.
      assert.equal(result.output.sent.text,expected[language]);
      assert.equal(result.output.after,language);
    }
    const direct=calls.filter(c=>c.chat_id===42);
    assert.equal(direct.length,3);
    assert.ok(direct.every(c=>c.message_id===10));
    for(const [language,chatId] of [['en',1001],['ru',1002],['fa',1003]]) {
      const result=await (await mf.dispatchFetch('http://test/result?language=actual-'+language)).json();
      assert.equal(result.status,'complete',JSON.stringify(result));
      const messages=calls.filter(c=>c.chat_id===chatId&&typeof c.text==='string');
      assert.ok(messages.length>=2);
      const first=messages.find(c=>c.reply_parameters?.message_id===7);
      assert.ok(first);
      if(language!=='fa')assert.ok(messages.every(c=>!/[\u0621-\u064a\u067e\u0686\u0698\u06a9\u06af\u06cc]/u.test(c.text)),JSON.stringify(messages));
      assert.ok(first.text.includes(language==='en'?'Looking for your song':language==='ru'?'Ищу песню':'دارم آهنگ'));
    }
  } finally {await mf.dispose();}
});
