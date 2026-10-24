import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/story-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source, loader: 'ts' }, bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'test-story-bindings', setup(build) {
    build.onResolve({ filter: /.*/ }, a => ({ path: a.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, a => ({ contents: a.path === './main'
      ? 'export default { fetch() { globalThis.legacy++; return Response.json({delegated: true}); } };'
      : 'export const recordUsage=async()=>true; export const recordMediaDelivery=async()=>{}; export const telegramCustomEmoji=(_method,payload)=>payload; export const telegramTextMotion=async()=>{}; export const telegramFileCache=async(...args)=>globalThis.storyFileCache ? globalThis.storyFileCache(...args) : null; export class AdminStatsStore {} export const ADMIN_USER_ID = 1; export async function recordDownload(_env,record) {(globalThis.downloadHistory ||= []).push(record);} export async function recordSuccessfulDelivery() {}' }));
  } }],
});
const { default: worker, parseInstagramProfileCommand, instagramProfileStories, startInstagramStoryRun, readInstagramStoryRun, instagramStoryItems, instagramVideoErrorText } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const session = '12345%3Afictional-test-session';
const media = { pk: '999', user: { pk: '77' }, video_versions: [{ url: 'https://cdn.instagram.com/test.mp4', width: 720, height: 1280 }] };

test('Persian and English profile commands accept usernames with or without @ and reject other messages', () => {
  assert.deepEqual(parseInstagramProfileCommand('اینستاگرام استوری @example.name'), {kind:'story',username:'example.name'});
  assert.deepEqual(parseInstagramProfileCommand('اینستاگرام پست example_123'), {kind:'posts',username:'example_123'});
  assert.deepEqual(parseInstagramProfileCommand('/instastory @example.name'), {kind:'story',username:'example.name'});
  assert.deepEqual(parseInstagramProfileCommand('/instapost example_123'), {kind:'posts',username:'example_123'});
  assert.deepEqual(parseInstagramProfileCommand('/INSTASTORY@ExampleBot example'), {kind:'story',username:'example'});
  assert.deepEqual(parseInstagramProfileCommand('/instapost@ExampleBot @example'), {kind:'posts',username:'example'});
  for (const value of ['example', 'استوری example', 'اینستاگرام استوری', 'اینستاگرام پست ../example',
    'اینستاگرام پست user extra', 'اینستاگرام استوری @a..b', 'اینستاگرام پست '+ 'a'.repeat(31),
    '/instapost', '/instastory@ExampleBot', '/instapostextra example', '/instastory ../example',
    '/instapost @a..b', '/instapost user extra', '/instastory '+ 'a'.repeat(31)]) {
    assert.equal(parseInstagramProfileCommand(value), null, value);
  }
});

async function run({ routes = {}, env = {}, link = 'https://www.instagram.com/stories/example/999/' } = {}) {
  const requests = [], telegram = [];
  globalThis.legacy = 0; globalThis.downloadHistory = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers);
    if (url.hostname === 'api.telegram.org') {
      const body = JSON.parse(init.body); telegram.push({ method: url.pathname.split('/').at(-1), body });
      return Response.json({ ok: true, result: { message_id: 10, ...(url.pathname.endsWith('/sendVideo') ? { video: { file_id: 'genuine_story_file' } } : {}) } });
    }
    requests.push({ url, headers });
    if (url.hostname === 'cdn.instagram.com') return new Response(null, { headers: { 'content-length': '1000000' } });
    const handler = routes[url.pathname];
    if (handler) return handler({ url, headers });
    throw Error('Unexpected request ' + url.pathname);
  };
  const request = new Request('https://worker/telegram/webhook', { method: 'POST', headers: {
    'x-telegram-bot-api-secret-token': 'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1', 'content-type': 'application/json',
  }, body: JSON.stringify({ update_id: 123, message: { message_id: 7, from: { id: 1 }, chat: { id: 1 }, text: link } }) });
  const response = await worker.fetch(request, { BOT_TOKEN: 'fictional-token', INSTAGRAM_SESSIONID: session, ...env }, {});
  assert.equal(response.status, 200);
  return { requests, telegram, legacy: globalThis.legacy };
}


const target = {kind:'story',username:'example',storyId:'999',url:'https://www.instagram.com/stories/example/999/'};
const publicEnv = {BOT_TOKEN:'fictional-token', APIFY_API_TOKEN:'private-apify-token',INSTAGRAM_SESSIONID:''};
const publicVideo = {type:'story',id:'999',ownerUsername:'example',mediaType:'Video',
  videoUrl:'https://cdn.instagram.com/video.mp4',displayUrl:'https://cdn.instagram.com/poster.jpg',width:1080,height:1920};
const runId='storyRun00001',datasetId='storyDataset00001';

test('public Story webhook queues work before provider requests or Telegram sends',async()=>{
  const queued=[];
  const result=await run({env:{...publicEnv,queueInstagramStory:async(t,m)=>queued.push({t,m})}});
  assert.equal(result.requests.length,0);assert.equal(result.telegram.length,0);
  assert.equal(queued.length,1);assert.deepEqual(queued[0].t,target);
});

test('public Story without the Workflow capability never starts an untracked paid run or personal-session fallback',async()=>{
  const result=await run({env:publicEnv});
  assert.equal(result.requests.length,0);assert.match(result.telegram[0].body.text,/Workflow/);
});

test('Story starts once asynchronously with authenticated terminal webhooks and no session',async()=>{
  const calls=[];const previous=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push({url:new URL(url),init});return Response.json({data:{id:runId,status:'RUNNING'}});};
  try {
    const result=await startInstagramStoryRun(target,publicEnv,{url:'https://worker/instagram/apify-events/igdl-1-7-1',token:'signed-callback'});
    assert.deepEqual(result,{id:runId,status:'RUNNING'});assert.equal(calls.length,1);
    const {url,init}=calls[0];assert.equal(init.method,'POST');
    assert.equal(url.pathname,'/v2/actors/rowfinch~instagram-stories-scraper/runs');
    assert.equal(url.searchParams.get('waitForFinish'),'0');assert.equal(url.searchParams.get('restartOnError'),'false');
    assert.equal(url.searchParams.get('timeout'),'600');
    assert.equal(init.headers.authorization,'Bearer private-apify-token');assert.equal(init.headers.cookie,undefined);
    assert.deepEqual(JSON.parse(init.body),{usernames:[target.url],stories:true,highlights:false});
    const hooks=JSON.parse(atob(url.searchParams.get('webhooks')));
    assert.deepEqual(hooks[0].eventTypes,['ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED','ACTOR.RUN.ABORTED','ACTOR.RUN.TIMED_OUT']);
    assert.equal(JSON.parse(hooks[0].headersTemplate)['x-instagram-event-token'],'signed-callback');
    assert.equal(hooks[0].payloadTemplate,'{"runId":{{resource.id}},"status":{{resource.status}}}');
  } finally {globalThis.fetch=previous;}
});

test('ambiguous Story network failure or timeout never repeats the paid start',async()=>{
  const previous=globalThis.fetch;
  try {for(const [failure,code] of [[new TypeError('secret-network-detail'),'apify_failed'],
    [Object.assign(new Error('deadline'),{name:'TimeoutError'}),'apify_timeout']]) {
    let calls=0;globalThis.fetch=async()=>{calls++;throw failure;};
    await assert.rejects(()=>startInstagramStoryRun(target,publicEnv,{url:'https://worker/event',token:'signed'}),e=>e.code===code);
    assert.equal(calls,1);
  }} finally {globalThis.fetch=previous;}
});

test('Story start classifies HTTP failures and logs only safe machine diagnostics',async()=>{
  const previous=globalThis.fetch,oldWarn=console.warn;const logs=[];console.warn=(message,info)=>logs.push({message,info});
  try {for(const [status,code] of [[401,'apify_auth'],[403,'apify_auth'],[402,'apify_quota'],[429,'apify_quota'],
    [400,'apify_invalid_input'],[422,'apify_invalid_input'],[404,'apify_actor_missing'],[408,'apify_timeout'],[500,'apify_server_error']]) {
    globalThis.fetch=async()=>Response.json({error:{type:'safe-code',message:'private-apify-token'}},{status});
    await assert.rejects(()=>startInstagramStoryRun(target,publicEnv,{url:'https://worker/event',token:'signed'}),e=>e.code===code&&e.diagnostic.status===status);
  }assert.ok(!JSON.stringify(logs).includes('private-apify-token'));} finally {globalThis.fetch=previous;console.warn=oldWarn;}
});

test('Story start refuses an unparseable response or missing run ID without retrying',async()=>{
  const previous=globalThis.fetch;
  try {for(const fixture of [new Response('NOT JSON'),Response.json({data:{status:'RUNNING'}})]) {
    let calls=0;globalThis.fetch=async()=>{calls++;return fixture;};
    await assert.rejects(()=>startInstagramStoryRun(target,publicEnv,{url:'https://worker/event',token:'signed'}),e=>e.code==='apify_invalid_response');
    assert.equal(calls,1);
  }}finally{globalThis.fetch=previous;}
});

test('Story completion reads only the saved run and its verified dataset, selecting the exact ID',async()=>{
  const previous=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return String(url).includes('/actor-runs/')
    ?Response.json({data:{id:runId,status:'SUCCEEDED',defaultDatasetId:datasetId}})
    :Response.json([{...publicVideo,id:'998'},publicVideo]);};
  try {
    const items=await readInstagramStoryRun(runId,target,publicEnv);
    assert.equal(items.length,1);assert.equal(items[0].storyId,'999');assert.equal(items[0].kind,'video');
    assert.deepEqual(calls.map(x=>new URL(x.url).pathname),['/v2/actor-runs/'+runId,'/v2/datasets/'+datasetId+'/items']);
    assert.ok(calls.every(x=>!x.init.method&&!new URL(x.url).searchParams.has('waitForFinish')));
  }finally{globalThis.fetch=previous;}
});

test('failed, still-running and mismatched runs never read dataset or launch a replacement',async()=>{
  const previous=globalThis.fetch;
  try {for(const [record,code] of [[{id:runId,status:'FAILED'},'apify_run_failed'],[{id:runId,status:'RUNNING'},'apify_still_running'],
    [{id:'wrongRun00001',status:'SUCCEEDED',defaultDatasetId:datasetId},'apify_invalid_response']]) {
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:record});};
    await assert.rejects(()=>readInstagramStoryRun(runId,target,publicEnv),e=>e.code===code);assert.equal(calls,1);
  }}finally{globalThis.fetch=previous;}
});

test('Story media validation retains exact IDs, owners, highlight IDs, full video files and the twenty-item limit',()=>{
  assert.equal(instagramStoryItems([publicVideo],target)[0].url,publicVideo.videoUrl);
  for(const rows of [[{...publicVideo,ownerUsername:'different'}],[{...publicVideo,videoUrl:'https://example.com/file.mp4'}],
    [{...publicVideo,videoUrl:null}],[{...publicVideo,id:'998'}],[],{},[{error:'private profile'}]]) {
    assert.throws(()=>instagramStoryItems(rows,target));
  }
  const highlight={kind:'highlight',highlightId:'17950000000123456',url:'https://www.instagram.com/stories/highlights/17950000000123456/'};
  assert.equal(instagramStoryItems([{...publicVideo,type:'highlight',highlightId:highlight.highlightId}],highlight).length,1);
  assert.throws(()=>instagramStoryItems([{...publicVideo,type:'highlight',highlightId:'17950000000999999'}],highlight));
  assert.throws(()=>instagramStoryItems(Array.from({length:21},(_,i)=>({...publicVideo,id:String(i+1000)})),{...target,storyId:null}),e=>e.code==='apify_too_many');
});

test('profile Story grouping shares the Workflow result without another extraction',async()=>{
  const items=instagramStoryItems([publicVideo],target);let calls=0;
  const posts=await instagramProfileStories('example',{...publicEnv,resolvePublicStory:async()=>{calls++;return items;}});
  assert.equal(calls,1);assert.equal(posts[0].storyId,'999');assert.equal(posts[0].groups[0][0].kind,'video');
  assert.match(instagramVideoErrorText(new Error('apify_pending')),/اجرای جدیدی شروع نشد/);
});

test('missing session fails explicitly without Instagram requests or legacy retries', async () => {
  const r = await run({ env: { INSTAGRAM_SESSIONID: '' } });
  assert.equal(r.requests.length, 0); assert.equal(r.legacy, 0);
  assert.match(r.telegram[0].body.text, /INSTAGRAM_SESSIONID/);
  assert.equal(globalThis.downloadHistory.at(-1).status,'failed');
});

test('expired-session JSON is recognized on non-2xx and stops the resolver chain', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'login_required' }, { status: 401 }) } });
  assert.equal(r.requests.length, 1); assert.equal(r.legacy, 0);
  assert.match(r.telegram[0].body.text, /ورود دوباره/);
  assert.ok(!JSON.stringify(r.telegram).includes(session));
});

test('security challenge is distinguished from a missing story', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'challenge_required', challenge: {} }, { status: 400 }) } });
  assert.match(r.telegram[0].body.text, /تأیید امنیتی/); assert.equal(r.requests.length, 1);
});

test('rate limiting stops instead of issuing more fallback requests', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'Please wait a few minutes' }, { status: 429 }) } });
  assert.match(r.telegram[0].body.text, /محدود/); assert.equal(r.requests.length, 1);
});

test('story ID resolves owner and sends only the matching story without username lookup', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [{ ...media, pk: '998' }, media] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
  assert.ok(!r.requests.some(r => r.url.pathname.includes('usernameinfo')));
  assert.equal(r.legacy, 0);
  assert.equal(globalThis.downloadHistory.at(-1).status,'success');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,1);
});

test('empty story-feed response falls back to authenticated reels with the same cookie jar', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: null }, { headers: { 'set-cookie': 'mid=fresh-mid; Path=/' } }),
    '/api/v1/feed/reels_media/': ({ url, headers }) => {
      assert.equal(url.searchParams.get('reel_ids'), '77');
      assert.match(headers.get('cookie'), /mid=fresh-mid/);
      return Response.json({ reels: { '77': { items: [media] } } });
    },
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('a missing requested story never sends a different story', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [{ ...media, pk: '998' }] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 0);
  assert.match(r.telegram[0].body.text, /منقضی|قابل مشاهده/);
});

test('username fallback retains full session cookies and CSRF on the web endpoint', async () => {
  const r = await run({ env: { INSTAGRAM_CSRFTOKEN: 'test-csrf', INSTAGRAM_MID: 'test-mid' }, routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [] }),
    '/api/v1/users/example/usernameinfo/': () => Response.json({ status: 'fail' }, { status: 404 }),
    '/api/v1/users/web_profile_info/': ({ headers }) => {
      assert.match(headers.get('cookie'), /mid=test-mid/);
      assert.equal(headers.get('x-csrftoken'), 'test-csrf');
      return Response.json({ data: { user: { id: '77' } } });
    },
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [media] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('non-story posts retain the existing route', async () => {
  const r = await run({ link: 'https://www.instagram.com/reel/example/' });
  assert.equal(r.legacy, 1); assert.equal(r.requests.length, 0);
});

test('raw 64-bit media IDs remain exact and select only the requested story', async () => {
  const wanted = '3490123456789012345', sibling = '3490123456789012346';
  assert.equal(Number(wanted), Number(sibling)); // Both collapse with response.json().
  const exactResponse = (items, wrapper) => new Response(
    JSON.stringify(wrapper(items)).replace(/"pk":"(\d{19})"/g, '"pk":$1'),
    { headers: { 'content-type': 'application/json' } },
  );
  const wantedMedia = { ...media, pk: wanted, caption: { text: 'Keep 3490123456789012345 and "quotes" intact' } };
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => exactResponse([wantedMedia], items => ({ items })),
    '/api/v1/feed/user/77/story/': () => exactResponse([
      { ...media, pk: sibling, video_versions: [{ url: 'https://cdn.instagram.com/wrong.mp4' }] }, wantedMedia,
    ], items => ({ reel: { items } })),
  } });
  const sent = r.telegram.filter(t => t.method === 'sendVideo');
  assert.equal(sent.length, 1);
  assert.equal(new URL(sent[0].body.video).searchParams.get('src'), media.video_versions[0].url);
  assert.ok(!r.requests.some(r => r.url.pathname.includes('usernameinfo')));
});

test('a composite string ID can match when pk is already rounded upstream', async () => {
  const wanted = '3490123456789012345';
  const item = { ...media, pk: Number(wanted), id: `${wanted}_77` };
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => Response.json({ items: [item] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [item] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('neighboring large ID is never mistaken for a missing requested story', async () => {
  const wanted = '3490123456789012345';
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => Response.json({ items: [{ ...media, pk: wanted }] }),
    '/api/v1/feed/user/77/story/': () => new Response(
      '{"reel":{"items":[{"pk":3490123456789012346}]}}',
    ),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 0);
  assert.match(r.telegram[0].body.text, /منقضی|قابل مشاهده/);
});

test('Story video reuse keeps source access checks and owner-bound song buttons',async()=>{
  const operations=[];
  globalThis.storyFileCache=async(_env,op,key,value)=>{
    operations.push({op,key,value});
    return op==='get'?{method:'sendVideo',fileId:'cached_story_id',data:{caption:'Instagram'}}:null;
  };
  try {
    const r=await run({routes:{
      '/api/v1/media/999/info/':()=>Response.json({items:[media]}),
      '/api/v1/feed/user/77/story/':()=>Response.json({reel:{items:[media]}}),
    }});
    const sent=r.telegram.find(t=>t.method==='sendVideo').body;
    assert.equal(sent.video,'cached_story_id');
    assert.ok(r.requests.some(r=>r.url.pathname.includes('/feed/user/')));
    assert.equal(sent.reply_markup.inline_keyboard[0][1].callback_data,'igm|s|999|0|1');
    assert.equal(operations[0].key,'ig:1:999:0:video');
    assert.equal(operations.at(-1).value.fileId,'genuine_story_file');
  } finally {delete globalThis.storyFileCache;}
});
