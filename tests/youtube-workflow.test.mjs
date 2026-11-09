import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';

const reddit = await readFile(new URL('../src/reddit.ts', import.meta.url), 'utf8');
const bandcamp = await readFile(new URL('../src/bandcamp.ts', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const startSource = await readFile(new URL('../src/start-message.ts', import.meta.url), 'utf8');
const widgetSource = await readFile(new URL('../src/video-download-widget.ts', import.meta.url), 'utf8');
const subtitleSource = await readFile(new URL('../src/youtube-subtitles.ts', import.meta.url), 'utf8');
const subtitleLanguages = await readFile(new URL('../locales/subtitle-languages.json', import.meta.url), 'utf8');
const fileCacheSource = await readFile(new URL('../src/telegram-file-cache.ts', import.meta.url), 'utf8');
const cacheUsageSource = await readFile(new URL('../src/cache-usage.ts', import.meta.url), 'utf8');
const catalogSource = await readFile(new URL('../src/youtube-catalog.ts', import.meta.url), 'utf8');
const instagram = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({ external: ['node:async_hooks'],
  stdin: { contents: source + '\nexport {telegramFileCache as actualFileCache} from "./telegram-file-cache"; export {sendInstagramPostDirect} from "./index"; export {sendCachedPost,postCacheKey,buildCachedQualityKeyboard,extractPornhubUrl,handleQualityCallback,handleSubtitleCallback,parseQualityCallback,mediaCacheKey,subtitleButtons}; export {subtitleSettings,subtitleAccessSettings} from "./youtube-subtitles";', loader: 'ts', resolveDir: process.cwd() },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'cloudflare-test-bindings', setup(build) {
    build.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, args => {
      if (args.path === './telegram-file-cache') return {contents:fileCacheSource,loader:'ts'};
      if (args.path === './cache-usage') return { contents: cacheUsageSource, loader: 'ts' };
      if (args.path === './youtube-catalog') return { contents: catalogSource, loader: 'ts' };
      if (args.path === './start-message') return { contents: startSource, loader: 'ts' };
      if (args.path === './video-download-widget') return { contents: widgetSource, loader: 'ts' };
      if (args.path === './youtube-subtitles') return { contents: subtitleSource, loader: 'ts' };
      if (args.path === '../locales/subtitle-languages.json') return { contents: subtitleLanguages, loader: 'json' };
      if (args.path === '@cloudflare/containers') return { contents: `
        export class Container {
          constructor(ctx, env) { this.ctx = ctx; this.env = env; }
          renewActivityTimeout() { this.renewed = (this.renewed || 0) + 1; }
          async onActivityExpired() { this.stopped = true; }
          async destroy() { this.stopped = true; this.destroyed = true; }
          onError(error) { throw error; }
        }
        export const getContainer = () => globalThis.container;
      ` };
      if (args.path === 'cloudflare:workers') return { contents: `
        export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
        export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }
      ` };
      if (args.path === './localization') return {contents:'export const currentLanguage=()=>"fa"; export const isLanguage=v=>["fa","en","ru"].includes(v); export const withUserLanguage=async(_env,_id,action)=>action(); export const userLanguage=async()=>"fa"; export const translate=text=>text;'};
      if (args.path === './reddit') return {contents:reddit,loader:'ts'};
      if (args.path === './bandcamp') return {contents:bandcamp,loader:'ts'};
      if (args.path === './story-main') return { contents: 'export default { fetch() {} }; export const resolveInstagramSessionPost = async () => {throw Error("Unexpected session fallback")}; export const instagramSessionFailure = () => ({code:"unexpected",message:"error"}); export const startInstagramStoryRun = async () => {throw Error("Unexpected Story start")}; export const readInstagramStoryRun = async () => {throw Error("Unexpected Story read")}; export const sendResolvedStory = async () => {throw Error("Unexpected Story send")}; export const instagramProfileStories = async () => []; export const parseStoryTarget = () => null; export const parseInstagramProfileCommand = () => null; export const parseInstagramVideoTarget = () => null; export const parseInstagramAudioTarget = () => null; export const resolveInstagramVideo = () => {}; export const instagramVideoErrorText = () => "error";' };
      if (args.path === './index') return { contents: instagram, loader: 'ts' };
      if (args.path === './admin') return { contents: `
        export const recordDownload = async(_env,record)=>{(globalThis.downloadHistory ||= []).push(record);};
        export const isInstagramDownloadLink = text=>/instagram.com\\//.test(text);
        export const telegramTextMotion=async()=>{};
        export const instagramApiToken=(env,{provider,account})=>{
          const key=provider==='apify'?'APIFY_API_TOKEN':'BRIGHTDATA_API_KEY';
          return env[key+'_'+account]?.trim()||(account===1?env[key]?.trim():undefined);
        };
        export const recordBrightDataExtraction=async(...args)=>globalThis.brightUsage?.(...args);
        export const instagramApiSettings=async()=>({posts:{provider:'apify',account:1},stories:{provider:'apify',account:1}});

        export const recordUsage=async(...args)=>globalThis.usageTelemetry ? globalThis.usageTelemetry(...args) : true; export const recordMediaDelivery=async()=>{}; export const telegramCustomEmoji=(_method,payload)=>payload;
        export const telegramFileCache=async(...args)=>globalThis.testFileCache ? globalThis.testFileCache(...args) : null; export class AdminStatsStore {}
        export const ADMIN_USER_ID = 1;
        export const recordSuccessfulDelivery = async () => { globalThis.delivered++; };
        export const isAdmin=(_env,id)=>id===ADMIN_USER_ID;
        export const recordUserActivity = async () => {};
      ` };
      throw Error('Unexpected import ' + args.path);
    });
  } }],
});
const { actualFileCache,sendInstagramPostDirect,sendCachedPost,postCacheKey,buildCachedQualityKeyboard, DownloadPool, YoutubeDownloaderContainer, YoutubeDownloadWorkflow, extractPornhubUrl, handleQualityCallback, handleSubtitleCallback, parseQualityCallback, mediaCacheKey, subtitleButtons, subtitleSettings, subtitleAccessSettings, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

function subtitleBinding(storage = memoryStorage()) {
  return { getByName() { return { fetch: (url, init) => new URL(url).pathname === '/youtube-subtitle-access'
    ? subtitleAccessSettings(new Request(url, init), storage, id => id === 1)
    : subtitleSettings(new Request(url, init), storage) }; } };
}
function menuFixture(changes={}) {
  return {videoId:'dQw4w9WgXcQ',requestMessageId:7,userId:1,chatId:1,messageId:10,
    title:'Fixture',qualities:[360,480,720,1080],audioAvailable:true,
    preference:{enabled:false},createdAt:Date.now(),...changes};
}
async function settings(binding, op, extra={}) {
  const menu=menuFixture();
  return binding.getByName('global').fetch('https://admin-stats/youtube-subtitles', {method:'POST',
    body:JSON.stringify({...menu,op,...(op==='open'?{menu}:{}),...extra})});
}
function setSubtitleAccess(binding, values={}) {
  return binding.getByName('global').fetch('https://admin-stats/youtube-subtitle-access', {method:'POST',
    body:JSON.stringify({actorId:1,...values})});
}

function memoryStorage() {
  const values = new Map();
  let serial = Promise.resolve();
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    transaction(fn) { const result = serial.then(() => fn(storage)); serial = result.catch(() => {}); return result; },
  };
  return storage;
}

function poolBinding() {
  const storage = memoryStorage();
  const pool = new DownloadPool({ storage }, {});
  return { getByName() { return pool; } };
}

test('Pinterest requests receive current secrets on a running container, including rotation and removal', async () => {
  const raw=JSON.stringify([{domain:'.pinterest.com',name:'_pinterest_sess',value:'fixture-pinterest-session'}]);
  const env={PINTEREST_COOKIES:raw,API_ID:'123',API_HASH:'fixture-hash'};
  const instance=new YoutubeDownloaderContainer({storage:memoryStorage()},env);
  const received=[],logs=[],previous=console.info;
  instance.containerFetch=async(_url,init)=>{received.push(JSON.parse(init.body));return Response.json({ok:true});};
  console.info=(message,data)=>logs.push({message,data});
  const payload={id:'igdl-42-7-42',source:{mode:'replay',social:{platform:'pinterest',url:'https://www.pinterest.com/pin/123/'}}};
  try {
    await instance.instagramRequest('start',payload);
    env.PINTEREST_COOKIES=raw.replace('fixture-pinterest-session','rotated-private-session');
    await instance.instagramRequest('start',payload);
    delete env.PINTEREST_COOKIES;
    await instance.instagramRequest('start',payload);
    assert.deepEqual(received.map(r=>r.pinterestCookies),[raw,raw.replace('fixture-pinterest-session','rotated-private-session'),'']);
    assert.equal(payload.pinterestCookies,undefined);
    await instance.instagramRequest('start',{...payload,source:{mode:'replay',social:{platform:'x',url:'https://x.com/i/status/123'}}});
    assert.equal(received.at(-1).pinterestCookies,undefined);
    assert.deepEqual(logs.map(l=>l.data.configured),[true,true,false]);
    assert.ok(!JSON.stringify(logs).includes('private-session')&&!JSON.stringify(logs).includes('fixture-pinterest-session'));
  } finally {console.info=previous;}
  assert.equal(instance.envVars.PINTEREST_COOKIES,undefined);
  assert.equal(instance.envVars.API_ID,'123');
  assert.equal(instance.envVars.API_HASH,'fixture-hash');
});

test('100 simultaneous admissions use exactly 20 hosts and five slots per host', async () => {
  const storage = memoryStorage();
  const pool = new DownloadPool({ storage }, {});
  const leases = await Promise.all(Array.from({ length: 100 }, (_, i) => pool.acquire(`job-${i}`)));
  const counts = new Map();
  for (const lease of leases) {
    assert.ok(lease);
    counts.set(lease.instance, (counts.get(lease.instance) || 0) + 1);
  }
  assert.equal(counts.size, 20);
  assert.ok([...counts.values()].every(count => count === 5));
  assert.equal(await pool.acquire('overflow'), null);
  const revived = new DownloadPool({ storage }, {});
  assert.deepEqual(await revived.acquire('job-0'), leases[0], 'replay must not consume another slot');
  await revived.release('job-0', 'wrong-token');
  assert.equal(await revived.acquire('overflow'), null);
  await revived.release('job-0', leases[0].token);
  const replacement = await revived.acquire('overflow');
  assert.equal(replacement.instance, leases[0].instance);
  assert.equal(await revived.lookup('job-0'), null);
  assert.equal((await revived.lookup('job-1')).token, leases[1].token);
});

test('YouTube cookie secret reaches the container environment without changing API credentials', () => {
  const container = new YoutubeDownloaderContainer({ storage: memoryStorage() },
    { YOUTUBE_COOKIES: 'private-cookie-fixture', API_ID: '123', API_HASH: 'fixture-hash' });
  assert.equal(container.envVars.YOUTUBE_COOKIES, 'private-cookie-fixture');
  assert.equal(container.envVars.API_ID, '123');
  assert.equal(container.envVars.API_HASH, 'fixture-hash');
  const anonymous = new YoutubeDownloaderContainer({ storage: memoryStorage() }, {});
  assert.equal(anonymous.envVars.YOUTUBE_COOKIES, '');
});

test('five simultaneous cold starts share one startup and a failed startup can be retried', async () => {
  const container = new YoutubeDownloaderContainer({ storage: memoryStorage() }, { BOT_TOKEN: "fake" });
  let finish, starts = 0;
  let boot;
  const booted = new Promise(resolve => { boot = resolve; });
  container.startAndWaitForPorts = async () => { starts++; await new Promise(resolve => { finish = resolve; boot(); }); };
  const requests = Array.from({ length: 5 }, () => container.startShared(0));
  await booted;
  assert.equal(starts, 1);
  finish();
  await Promise.all(requests);
  container.startAndWaitForPorts = async () => { starts++; throw Error('startup failed'); };
  await assert.rejects(container.startShared(0), /startup failed/);
  container.startAndWaitForPorts = async () => { starts++; };
  await container.startShared(0);
  assert.equal(starts, 3);
});

test('Pornhub runs anonymously even when an obsolete secret is configured', async () => {
  const container = new YoutubeDownloaderContainer({ storage: memoryStorage() },
    { BOT_TOKEN: 'fake', PORNHUB_COOKIES: 'obsolete-secret' });
  assert.equal(Object.hasOwn(container.envVars, 'PORNHUB_COOKIES'), false);
  await run({ pornhub: true });
});

test('authorized sessions survive cold starts only on their own Container and matching credentials', async () => {
  const storage = memoryStorage();
  const env = { BOT_TOKEN: 'bot-token', API_ID: '123', API_HASH: 'api-hash' };
  const session = '1' + 'a'.repeat(352);
  const first = new YoutubeDownloaderContainer({ storage }, env);
  await first.saveTelegramSession(session);
  const revived = new YoutubeDownloaderContainer({ storage }, env);
  revived.startAndWaitForPorts = async () => {};
  await revived.startShared(4);
  assert.equal(revived.envVars.TELEGRAM_BOT_SESSION, session);
  assert.equal(revived.envVars.TELEGRAM_SESSION_URL, 'https://downloader.vexaagent.workers.dev/telegram-session/4');
  assert.equal(revived.envVars.TELEGRAM_SESSION_TOKEN,
    createHmac('sha256', env.BOT_TOKEN).update('telegram-session:4:123:api-hash').digest('hex'));
  const other = new YoutubeDownloaderContainer({ storage: memoryStorage() }, env);
  other.startAndWaitForPorts = async () => {};
  await other.startShared(5);
  assert.equal(other.envVars.TELEGRAM_BOT_SESSION, '');
  assert.notEqual(other.envVars.TELEGRAM_SESSION_TOKEN, revived.envVars.TELEGRAM_SESSION_TOKEN);
  for (const changed of [{ BOT_TOKEN:'new-token' }, { API_ID:'456' }, { API_HASH:'new-hash' }]) {
    const rotated = new YoutubeDownloaderContainer({ storage }, { ...env, ...changed });
    rotated.startAndWaitForPorts = async () => {};
    await rotated.startShared(4);
    assert.equal(rotated.envVars.TELEGRAM_BOT_SESSION, '');
  }
  await assert.rejects(first.saveTelegramSession('invalid'), /Invalid Telegram session/);
  await assert.rejects(first.startShared(20), /DOWNLOAD_POOL_ASSIGNMENT/);
});

test('session storage requires the host-specific capability and never returns a session', async () => {
  const writes = [];
  globalThis.container = { async saveTelegramSession(session) { writes.push(session); } };
  const env = { BOT_TOKEN:'bot-token', API_ID:'123', API_HASH:'api-hash' };
  const session = '1' + 'a'.repeat(352);
  const capability = index => createHmac('sha256', env.BOT_TOKEN).update(`telegram-session:${index}:123:api-hash`).digest('hex');
  const request = (index, signature, body) => new Request(`https://worker/telegram-session/${index}`, {
    method:'POST', headers:{'x-telegram-session-token':signature}, body,
  });
  assert.equal((await worker.fetch(request(0, 'wrong', JSON.stringify({session})), env, {})).status, 403);
  assert.equal((await worker.fetch(request(1, capability(0), JSON.stringify({session})), env, {})).status, 403);
  assert.equal((await worker.fetch(request(20, capability(20), JSON.stringify({session})), env, {})).status, 400);
  assert.equal((await worker.fetch(request(0, capability(0), 'a'.repeat(1025)), env, {})).status, 413);
  assert.equal((await worker.fetch(request(0, capability(0), JSON.stringify({session:'invalid'})), env, {})).status, 400);
  assert.deepEqual(writes, []);
  const response = await worker.fetch(request(0, capability(0), JSON.stringify({session})), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {ok:true});
  assert.deepEqual(writes, [session]);
});

test('expired reservations are reclaimed on demand and stale releases cannot delete a new lease', async () => {
  const storage = memoryStorage();
  const pool = new DownloadPool({ storage }, {});
  const old = await pool.acquire('job');
  const jobs = await storage.get('jobs');
  jobs.job.until = Date.now() - 1;
  await storage.put('jobs', jobs);
  assert.equal(await pool.lookup('job'), null);
  const current = await pool.acquire('job');
  assert.notEqual(current.token, old.token);
  await pool.release('job', old.token);
  assert.deepEqual(await pool.lookup('job'), current);
});

test('finishing one background job does not expire other jobs and crash notification reaches all of them', async () => {
  const storage = memoryStorage();
  const events = [];
  const container = new YoutubeDownloaderContainer({ storage }, {
    YOUTUBE_DOWNLOAD_WORKFLOW: { async get(id) { return { async sendEvent(event) { events.push([id, event]); } }; } },
  });
  container.containerFetch = async () => Response.json({ ok: true });
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => container.instagramRequest('start', { id })));
  await container.releaseInstagram('a');
  await container.onActivityExpired();
  assert.equal(container.destroyed, undefined);
  await container.onStop();
  assert.deepEqual(events.map(([id]) => id).sort(), ['b', 'c', 'd', 'e']);
  for (const id of ['b', 'c', 'd', 'e']) await container.releaseInstagram(id);
  await container.onActivityExpired();
  assert.equal(container.destroyed, true);
});

test('full pool rejects immediately without starting or retrying a transfer', async () => {
  let admitted = 0;
  const pool = { getByName() { return { async acquire() { admitted++; return null; } }; } };
  const result = await run({ pool });
  assert.equal(admitted, 1);
  assert.deepEqual(result.calls, []);
  assert.match(result.messages.at(-1).text, /ظرفیت/);
  assert.equal(result.steps.find(([name]) => name === 'reserve download capacity')[1].retries.limit, 0);
});

test('startup failures, metadata completion and ambiguous transfers all release only their own reservation', async () => {
  for (const options of [{ startupError: 'failed' }, { inspect: true }, { httpError: { status: 502, body: 'uncertain' } }]) {
    const binding = poolBinding();
    const pool = binding.getByName();
    const unrelated = await pool.acquire('unrelated');
    await run({ ...options, pool: binding });
    assert.equal(await pool.lookup('test-job'), null);
    assert.deepEqual(await pool.lookup('unrelated'), unrelated);
  }
});

const sdkBuild = await build({ external: ['node:async_hooks'],
  stdin: { contents: 'export { Container } from "@cloudflare/containers";', loader: 'js', resolveDir: process.cwd() },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'sdk-workers-binding', setup(build) {
    build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'sdk-test' }));
    build.onLoad({ filter: /.*/, namespace: 'sdk-test' }, () => ({ contents: 'export class DurableObject {}; export class WorkerEntrypoint {};' }));
  } }],
});
const { Container: SDKContainer } = await import(`data:text/javascript;base64,${Buffer.from(sdkBuild.outputFiles[0].text).toString('base64')}`);

test('real SDK signals cannot retain an idle instance whose PID 1 ignores SIGTERM', async () => {
  const runtime = { running: true, signal() {}, async destroy() { this.running = false; } };
  const sdk = Object.create(SDKContainer.prototype);
  sdk.container = runtime;
  sdk.syncPendingStoppedEvents = async () => {};
  await sdk.onActivityExpired();
  assert.equal(runtime.running, true, 'the default stop only signals the process');
  const container = new YoutubeDownloaderContainer({ storage: { async get() {} } }, {});
  container.destroy = () => sdk.destroy();
  await container.onActivityExpired();
  assert.equal(runtime.running, false, 'idle destruction must actually release the instance');
});

test('real SDK does not expire an active HTTP transfer', () => {
  const sdk = Object.create(SDKContainer.prototype);
  sdk.sleepAfter = '5m';
  sdk.sleepAfterMs = 0;
  sdk.inflightRequests = 1;
  assert.equal(sdk.isActivityExpired(), false);
  assert.ok(sdk.sleepAfterMs > Date.now());
  sdk.inflightRequests = 0;
  sdk.sleepAfterMs = 0;
  assert.equal(sdk.isActivityExpired(), true);
});

test('idle containers stop after five minutes and completed background jobs restore that timeout', async () => {
  const ctx = { storage: memoryStorage() };
  const container = new YoutubeDownloaderContainer(ctx, {});
  assert.equal(container.sleepAfter, '5m');
  container.containerFetch = async () => {
    assert.ok((await ctx.storage.get('instagramJobs'))['active-job'] > Date.now());
    return Response.json({ ok: true });
  };
  await container.instagramRequest('start', { id: 'active-job' });
  await container.onActivityExpired();
  assert.equal(container.stopped, undefined, 'background preparation/live capture must stay running');
  assert.equal(container.destroyed, undefined, 'an active background lease must never be destroyed');
  assert.ok(container.sleepAfter > 0);
  await container.releaseInstagram('active-job');
  assert.deepEqual(await ctx.storage.get('instagramJobs'), {});
  assert.equal(container.sleepAfter, '5m');
  assert.equal(container.renewed, 2);
  await container.onActivityExpired();
  assert.equal(container.stopped, true);
  assert.equal(container.destroyed, true, 'idle shutdown must release capacity even if SIGTERM is ignored');
});

test('an expired background lease no longer prevents idle shutdown', async () => {
  const container = new YoutubeDownloaderContainer({ storage: {
    async get() { return { 'expired-job': Date.now() - 1 }; },
  } }, {});
  await container.onActivityExpired();
  assert.equal(container.stopped, true);
  assert.equal(container.destroyed, true);
});

test('real SDK monitor treats our idle destroy notification as an expected stop', async () => {
  const logs=[],previous=console.info;
  try {
    console.info=(...args)=>logs.push(args);
    const container=new YoutubeDownloaderContainer({
      storage:memoryStorage(),async blockConcurrencyWhile(fn){return fn();},
    },{});
    let rejectMonitor;
    container.monitor=new Promise((_resolve,reject)=>{rejectMonitor=reject;});
    let stopped=0;
    container.state={async setStopped(){stopped++;}};
    container.destroy=async()=>rejectMonitor(new Error('The RPC call destroy() was called'));
    SDKContainer.prototype.setupMonitorCallbacks.call(container);
    await container.onActivityExpired();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(stopped,1);assert.equal(container.monitor,undefined);
    assert.ok(logs.some(([message])=>message==='container stopped after idle timeout'));
  } finally {console.info=previous;}
});

test('unexpected destroy, crashes and failed shutdowns are never hidden as idle stops', async () => {
  const container=new YoutubeDownloaderContainer({storage:memoryStorage()},{});
  const destroyError=new Error('The RPC call destroy() was called');
  await assert.rejects(container.onError(destroyError),error=>error===destroyError);
  await container.onActivityExpired();
  const crash=new Error('container crashed with exit code 137');
  await assert.rejects(container.onError(crash),error=>error===crash);
  await container.onActivityExpired();
  container.onStart();
  await assert.rejects(container.onError(destroyError),error=>error===destroyError);
  container.destroy=async()=>{throw new Error('destroy failed');};
  await assert.rejects(container.onActivityExpired(),/destroy failed/);
  await assert.rejects(container.onError(destroyError),error=>error===destroyError);
});

test('cleanup of a stopped container does not allocate a new instance', async () => {
  const container = new YoutubeDownloaderContainer({ container: { running: false } }, {});
  container.containerFetch = async () => { throw Error('cleanup must not restart a stopped container'); };
  assert.deepEqual(await container.instagramRequest('cleanup', { id: 'finished-job' }), { ok: true });
});

test('cleanup still removes temporary files in a running container', async () => {
  const calls = [];
  const container = new YoutubeDownloaderContainer({ container: { running: true } }, {});
  container.containerFetch = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return Response.json({ ok: true });
  };
  assert.deepEqual(await container.instagramRequest('cleanup', { id: 'finished-job' }), { ok: true });
  assert.deepEqual(calls, [['http://container/instagram/cleanup', { id: 'finished-job' }]]);
});

test('Pornhub URLs normalize direct, mobile, language and embed links', () => {
  for (const host of ['www.pornhub.com', 'm.pornhub.org', 'fr.pornhub.net']) {
    assert.equal(extractPornhubUrl(`download (http://${host}/view_video.php?viewkey=ph123&tracking=x).`), `https://${host}/view_video.php?viewkey=ph123`);
    assert.equal(extractPornhubUrl(`https://${host}/embed/ph123`), `https://${host}/view_video.php?viewkey=ph123`);
  }
  for (const url of ['https://pornhub.com.attacker.test/view_video.php?viewkey=ph123',
    'https://evilpornhub.com/view_video.php?viewkey=ph123', 'https://pornhub.com/video/search',
    'https://user:pass@pornhub.com/view_video.php?viewkey=ph123', 'https://pornhub.com:444/view_video.php?viewkey=ph123',
    'https://pornhub.com/view_video.php?viewkey=../../bad']) assert.equal(extractPornhubUrl(url), null);
});

test('Pornhub starts download without YouTube inspection or quality buttons', async () => {
  const r = await run({ pornhub: true });
  assert.deepEqual(r.calls.map(c => c[0]), ['start', '/download']);
  assert.equal(r.delivered, 1);
  assert.ok(r.messages.some(m => m.text?.includes('Pornhub')));
  assert.ok(!r.messages.some(m => m.reply_markup?.inline_keyboard?.length));
});

test('Pornhub failure preserves the container stage and Telegram cause without replaying delivery', async () => {
  const logs = [], previous = console.error;
  try {
    console.error = (message, detail) => logs.push({ message, detail });
    const result = await run({ pornhub: true, result: { ok: false, phase: 'upload',
      errorCode: 'FLOOD_WAIT', errorType: 'FloodWaitError', rpcMethod: 'ImportBotAuthorizationRequest',
      rpcCode: 420, retryAfterSeconds: 137, diagnostic: 'secret-token secret-hash https://cdn.test/file?secret=value',
      message: 'تلگرام ارسال فایل را موقتاً محدود کرده' } });
    const failure = logs.find(x => x.message === 'pornhub download rejected');
    assert.equal(failure.detail.source, 'pornhub');
    assert.equal(failure.detail.phase, 'upload');
    assert.equal(failure.detail.code, 'FLOOD_WAIT');
    assert.equal(failure.detail.rpcMethod, 'ImportBotAuthorizationRequest');
    assert.equal(failure.detail.retryAfterSeconds, 137);
    for (const secret of ['secret-token', 'secret-hash', 'cdn.test', 'secret=value']) {
      assert.ok(!JSON.stringify(failure).includes(secret));
    }
    assert.equal(result.calls.filter(x => x[0] === '/download').length, 1);
    assert.equal(result.delivered, 0);
    assert.equal(result.steps.find(([name]) => name === 'download and send youtube video')[1].retries.limit, 0);
    assert.ok(result.steps.some(([name]) => name === 'release download capacity'));
    assert.equal(globalThis.downloadHistory.at(-1).source, 'Pornhub');
    assert.equal(globalThis.downloadHistory.at(-1).status, 'failed');
  } finally {
    console.error = previous;
  }
});

test('text and caption Pornhub links queue a deterministic direct-download job', async () => {
  const jobs = [];
  const env = { BOT_TOKEN: 'fictional', YOUTUBE_DOWNLOAD_WORKFLOW: { async create(job) { jobs.push(job); } } };
  for (const field of ['text', 'caption']) {
    const request = new Request('https://worker/telegram/webhook', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1' },
      body: JSON.stringify({ update_id: 100, message: { message_id: 7, from: { id: 42 }, chat: { id: -42 },
        [field]: 'https://pornhub.com/embed/ph123' } }),
    });
    assert.equal((await worker.fetch(request, env, {})).status, 200);
  }
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, 'ytdl--42-7-42');
  assert.equal(jobs[0].id, jobs[1].id);
  assert.equal(jobs[0].params.source, 'pornhub');
  assert.equal(jobs[0].params.url, 'https://pornhub.com/view_video.php?viewkey=ph123');
  assert.equal(jobs[0].params.quality, undefined);
});

async function run({ catalogBinding, inspect = false, startupError, httpError, result, sizes, credentials = true, pornhub = false, pool = poolBinding(), results, onSleep, checkpoints = new Map(), jobChanges = {}, aiSecrets = true, subtitleVersion = 1, rejectWidget = false } = {}) {
  const messages = [];
  const calls = [];
  const steps = [];
  globalThis.delivered = 0;
  globalThis.downloadHistory = [];
  globalThis.fetch = async (url, init) => {
    messages.push(JSON.parse(init.body));
    if (String(url).endsWith('/sendWidget')) {
      if (rejectWidget) return Response.json({ ok: false }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 88 } });
    }
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  globalThis.container = {
    async startShared(options) {
      calls.push(['start', options]);
      if (startupError) throw Error(startupError);
    },
    async fetch(request) {
      calls.push([new URL(request.url).pathname]);
      if (new URL(request.url).pathname === '/health') return Response.json({ok:true,subtitleVersion});
      if (new URL(request.url).pathname === '/download') globalThis.lastDownloadPayload=await request.clone().json();
      if (pornhub && new URL(request.url).pathname === '/download') {
        const body = await request.clone().json();
        assert.equal(Object.hasOwn(body, 'pornhubSessionTag'), false);
        assert.equal(Object.hasOwn(body, 'PORNHUB_COOKIES'), false);
      }
      if (httpError) return new Response(httpError.body, { status: httpError.status });
      if (results?.length && new URL(request.url).pathname === "/download") return Response.json(results.shift());
      if (result) return Response.json(result);
      return Response.json(inspect ? { ok: true, videoId: 'dQw4w9WgXcQ', qualities: [360, 480, 720, 1080], audioAvailable: true, sizes } : { ok: true });
    },
  };
  const step = { async do(name, config, callback) {
    if (typeof config === 'function') { callback = config; config = {}; }
    steps.push([name, config]);
    if (config.timeout?.endsWith('minutes') && parseInt(config.timeout) > 30) throw Error('Workflow step timeout exceeds 30 minutes');
    if (checkpoints.has(name)) return structuredClone(checkpoints.get(name));
    const value = await callback();
    checkpoints.set(name, structuredClone(value));
    return value;
  }, async sleep(name, duration) {
    steps.push([name, { sleep: duration }]);
    if (!checkpoints.has(name)) {
      if (onSleep) await onSleep(name, duration);
      checkpoints.set(name, true);
    }
  } };
  const job = { id: 'test-job', chatId: 42, userId: 42, requestMessageId: 7,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ...(pornhub ? { source: 'pornhub', url: 'https://www.pornhub.com/view_video.php?viewkey=ph123' } : inspect ? {} : { quality: 720, statusMessageId: 10 }),
  };
  Object.assign(job,jobChanges);
  await new YoutubeDownloadWorkflow({}, { BOT_TOKEN: 'secret-token', ADMIN_STATS: catalogBinding || subtitleBinding(), DOWNLOAD_POOL: pool, PORNHUB_COOKIES: 'obsolete-secret',
    ...(aiSecrets?{ELEVEN_API:'private-eleven',GPT_API:'private-gpt'}:{}),
    ...(credentials ? { API_ID: '123', API_HASH: 'secret-hash' } : {}) }).run({ payload: job }, step);
  return { calls, messages, steps, delivered: globalThis.delivered };
}

test('the optional widget observes delivery without replacing the downloader status or retrying a rejected widget', async () => {
  const jobChanges = { downloadWidget: { threadId: 9 } };
  for (const [result, expected] of [[{ ok: true }, 'sent'], [{ ok: false }, 'failed']]) {
    const { messages, calls } = await run({ jobChanges, result });
    const [sent, edited] = messages.filter(message => message.chat_data);
    assert.equal(sent.message_thread_id, 9);
    assert.equal(sent.caption, undefined);
    assert.equal(sent.reply_parameters, undefined);
    assert.equal(JSON.parse(sent.chat_data).state, 'preparing');
    assert.equal(edited.message_id, 88);
    assert.equal(JSON.parse(edited.chat_data).state, expected);
    assert.equal(globalThis.lastDownloadPayload.statusMessageId, 10);
    assert.equal(Object.hasOwn(globalThis.lastDownloadPayload, 'downloadWidget'), false);
    assert.equal(calls.filter(([path]) => path === '/download').length, 1);
  }
  const rejected = await run({ jobChanges, rejectWidget: true });
  assert.equal(rejected.delivered, 1);
  assert.equal(rejected.messages.filter(message => message.chat_data).length, 1);
});

test('download executes within the platform step timeout limit', async () => {
  const result = await run();
  assert.equal(result.delivered, 1);
  assert.ok(result.calls.some(call => call[0] === '/download'));
});

test('container is ready before metadata is requested', async () => {
  const result = await run({ inspect: true });
  assert.equal(result.calls[0][0], 'start');
  assert.equal(result.calls[1][0], '/metadata');
  assert.ok(result.messages.some(message => message.reply_markup?.inline_keyboard));
});

test('metadata timeout covers every client attempt and cold startup', async () => {
  const result = await run({ inspect: true });
  const config = result.steps.find(([name]) => name === 'inspect youtube qualities')[1];
  assert.ok(parseInt(config.timeout) >= 5);
});

test('startup failure is identified without exposing configuration', async () => {
  const result = await run({ inspect: true, startupError: 'secret-hash port not ready' });
  assert.equal(result.calls.length, 1);
  assert.match(result.messages.at(-1).text, /راه‌اندازی/);
  assert.doesNotMatch(result.messages.at(-1).text, /secret/);
});

test('unavailable container is reported as provisioning or capacity', async () => {
  const result = await run({ inspect: true, httpError: { status: 503, body: 'No instance available' } });
  assert.match(result.messages.at(-1).text, /ظرفیت|آماده/);
});


test('missing API credentials fails before download with an actionable error', async () => {
  const result = await run({ credentials: false });
  assert.equal(result.calls.length, 0);
  assert.match(result.messages.at(-1).text, /API_ID.*API_HASH/);
});

test('transfer is not automatically replayed after an ambiguous HTTP failure', async () => {
  const result = await run({ httpError: { status: 502, body: 'upstream reset' } });
  const config = result.steps.find(([name]) => name === 'download and send youtube video')[1];
  assert.equal(config.retries.limit, 0);
  assert.equal(result.delivered, 0);
  assert.match(result.messages.at(-1).text, /ارتباط.*قطع/);
});


test('quality buttons use English labels and show video plus audio sizes', async () => {
  const result = await run({ inspect: true, sizes: {
    '720': { bytes: 123400000, estimated: true },
    '1080': { bytes: 1500000000, estimated: true },
    low: { bytes: 3200000, estimated: false },
  } });
  const buttons = result.messages.find(m => m.reply_markup)?.reply_markup.inline_keyboard.flat().filter(b=>b.callback_data.startsWith('ytq|'));
  assert.ok(buttons.some(b => b.text === '⭐ 720p HD 123.4 MB'));
  assert.ok(buttons.some(b => b.text === '1080p Full HD 1.50 GB'));
  assert.ok(buttons.some(b => b.text === '🎵 Audio Low 3.2 MB'));
  assert.ok(buttons.every(b => !/[\u0600-\u06ff]/u.test(b.text)));
});

test('older metadata without a size still offers working quality buttons', async () => {
  const result = await run({ inspect: true });
  const buttons = result.messages.find(m => m.reply_markup)?.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.text === '360p Low Size unknown'));
  assert.equal(buttons.filter(b=>b.callback_data.startsWith('ytq|')).length,6);
  assert.equal(buttons.at(-1).callback_data,'ytst|dQw4w9WgXcQ|7|42|1');
});


test('download history associates quality inspection and final delivery with one user request', async () => {
  await run({ inspect: true });
  const waiting = globalThis.downloadHistory.at(-1);
  assert.equal(waiting.status, 'awaiting_selection');
  assert.equal(waiting.delivered, undefined);
  await run();
  const delivered = globalThis.downloadHistory.at(-1);
  assert.equal(delivered.key, waiting.key);
  assert.equal(delivered.userId, 42);
  assert.equal(delivered.status, 'success');
  assert.equal(delivered.delivered, 1);
  await run({ httpError: { status: 502, body: 'uncertain' } });
  assert.equal(globalThis.downloadHistory.at(-1).status, 'failed');
  assert.ok(!globalThis.downloadHistory.some(item => item.status === 'success'));
});

test('a rejected YouTube job reports the exact stage and safe cause without replaying the download',async()=>{
  const logs=[],previous=console.error;
  try{
    console.error=(message,detail)=>logs.push({message,detail});
    const result=await run({result:{ok:false,phase:'upload',errorCode:'TimeoutError',
      diagnostic:'delivery unknown secret-token secret-hash https://signed.example/file?token=private',message:'ارسال تأیید نشد'}});
    const failure=logs.find(x=>x.message==='youtube download rejected');
    assert.equal(failure.detail.phase,'upload');assert.equal(failure.detail.code,'TimeoutError');
    for(const secret of ['secret-token','secret-hash','signed.example','token=private'])assert.ok(!JSON.stringify(failure).includes(secret));
    assert.equal(result.calls.filter(x=>x[0]==='/download').length,1);assert.equal(result.delivered,0);
    assert.equal(globalThis.downloadHistory.at(-1).status,'failed');
  }finally{console.error=previous;}
});

test('Telegram flood preserves the RPC method and server wait without replaying the job',async()=>{
  const logs=[],previous=console.error;
  try{
    console.error=(message,detail)=>logs.push({message,detail});
    const result=await run({result:{ok:false,phase:'upload',errorCode:'FLOOD_WAIT',errorType:'FloodWaitError',
      rpcMethod:'ImportBotAuthorizationRequest',rpcCode:420,retryAfterSeconds:137,
      diagnostic:'FloodWaitError: wait 137 seconds',message:'تلگرام ارسال را محدود کرده'}});
    const failure=logs.find(x=>x.message==='youtube download rejected');
    assert.equal(failure.detail.rpcMethod,'ImportBotAuthorizationRequest');
    assert.equal(failure.detail.rpcCode,420);assert.equal(failure.detail.retryAfterSeconds,137);
    assert.equal(failure.detail.type,'FloodWaitError');assert.equal(failure.detail.code,'FLOOD_WAIT');
    assert.equal(result.calls.filter(x=>x[0]==='/download').length,1);assert.equal(result.delivered,0);
    assert.equal(globalThis.downloadHistory.at(-1).status,'failed');
  }finally{console.error=previous;}
});


test('1158-second and longer confirmed Telegram waits release capacity and automatically resume without a retry cap', async () => {
  const pool = poolBinding();
  const unrelated = await pool.getByName().acquire('unrelated');
  const checkpoints = new Map();
  const results = [1158, 7200, 1158].map(seconds => ({ok:false, retrySafe:true, phase:'upload',
    errorCode:'FLOOD_WAIT', rpcCode:420, rpcMethod:'SendMediaRequest', retryAfterSeconds:seconds,
    message:'Telegram waiting; automatic continuation'}));
  results.push({ok:true});
  const waits = [];
  const result = await run({pool, results, checkpoints, async onSleep(_name, duration) {
    waits.push(duration);
    assert.equal(await pool.getByName().lookup('test-job'), null);
    assert.deepEqual(await pool.getByName().lookup('unrelated'), unrelated);
  }});
  assert.deepEqual(waits, ['1158 seconds', '7200 seconds', '1158 seconds']);
  assert.equal(result.calls.filter(call => call[0] === '/download').length, 4);
  assert.equal(result.delivered, 1);
  assert.equal(globalThis.downloadHistory.at(-1).status, 'success');
  assert.ok(!globalThis.downloadHistory.some(record => record.status === 'failed'));
  assert.equal(new Set(result.steps.map(([name]) => name)).size, result.steps.length, 'every checkpoint must have a distinct name');
  assert.equal(await pool.getByName().lookup('test-job'), null);
  const replay = await run({pool, checkpoints});
  assert.deepEqual(replay.calls, [], 'Workflow replay must not repeat a transfer or boot');
  assert.equal(replay.delivered, 0, 'the delivery accounting step is checkpointed too');
});

test('unknown, invalid and ambiguous results never take the Telegram continuation path', async () => {
  for (const changed of [{retrySafe:false}, {rpcCode:500}, {retryAfterSeconds:-1},
    {retryAfterSeconds:1.5}, {retryAfterSeconds:undefined}, {errorCode:'TimeoutError'}, {phase:'download'}]) {
    const result = await run({result:{ok:false,retrySafe:true,phase:'upload',rpcCode:420,errorCode:'FLOOD_WAIT',
      retryAfterSeconds:1158,...changed}, onSleep() { throw Error('unexpected continuation'); }});
    assert.equal(result.calls.filter(call => call[0] === '/download').length, 1);
    assert.ok(!result.steps.some(([,config]) => config.sleep));
    assert.equal(result.delivered, 0);
  }
});

test('usage refresh never starts a sleeping container or renews activity; lifecycle starts remain idempotent', async () => {
  const storage = memoryStorage();
  const calls = [];
  globalThis.usageTelemetry = async (...args) => { calls.push(args); return true; };
  const host = { running: false, getTcpPort() { throw Error('sleeping container must not be contacted'); } };
  const container = new YoutubeDownloaderContainer({ storage, container: host }, { BOT_TOKEN: 'bot' });
  container.startAndWaitForPorts = async () => { throw Error('stats must never start a container'); };
  try {
    await container.refreshUsage();
    assert.equal(calls.length, 0);
    await container.onStart();
    const first = await storage.get('adminUsageRun');
    await container.onStart();
    assert.equal((await storage.get('adminUsageRun')).key, first.key);
    const samples = [{ key: 'u:abc:1:0', userId: 0, start: 1000, end: 2000,
      runtimeMs: 1000, cpuSeconds: 1, ingressBytes: 100, egressBytes: 50 }];
    host.running = true;
    host.getTcpPort = port => {
      assert.equal(port, 8080);
      return { async fetch(url) { assert.equal(url, 'http://container/admin-usage'); return Response.json({ samples, deliveries: [] }); } };
    };
    await container.refreshUsage();
    assert.deepEqual(calls.at(-1)[1], samples);
    assert.equal(container.renewed, undefined);
    host.running = false;
    await container.onStop();
    const closed = await storage.get('adminUsageRun');
    assert.equal(closed.key, first.key);
    assert.ok(closed.end >= first.start);
    await container.onStart();
    assert.notEqual((await storage.get('adminUsageRun')).key, first.key);
  } finally { delete globalThis.usageTelemetry; }
});


async function subtitleChoice(data, actor=1, extra={}, chatType) {
  const messages=[],jobs=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);messages.push(body);return Response.json({ok:true,result:{message_id:10}});};
  const env={BOT_TOKEN:'secret-token',ELEVEN_API:'private-eleven',GPT_API:'private-gpt',
    ADMIN_STATS:subtitleBinding(),YOUTUBE_DOWNLOAD_WORKFLOW:{async create(job){jobs.push(job);}},...extra};
  await settings(env.ADMIN_STATS,'open',{userId:actor,chatId:actor,menu:menuFixture({userId:actor,chatId:actor})});
  const callback={id:'callback',from:{id:actor},data,message:{message_id:10,chat:{id:actor,type:chatType}}};
  if (/^(ytst|ytsl|ytsp)\|/.test(data)) await handleSubtitleCallback(env,callback);
  else await handleQualityCallback(env,{},callback);
  return {messages,jobs,env};
}

test('quality selection starts immediately and all users have subtitle controls',async()=>{
  const displayed=await run({inspect:true,jobChanges:{userId:1,chatId:1}});
  const rows=displayed.messages.find(m=>m.reply_markup?.inline_keyboard).reply_markup.inline_keyboard;
  assert.equal(rows.at(-1)[0].icon_custom_emoji_id,'5210952531676504517');
  assert.ok(rows.at(-1)[0].callback_data.startsWith('ytst|'));
  const noAdmin=await run({inspect:true});
  assert.ok(JSON.stringify(noAdmin.messages).includes('ytst|'));
  const disabled=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1');
  assert.equal(disabled.jobs.length,1);assert.ok(!disabled.jobs[0].params.subtitle);
  assert.ok(!disabled.messages.some(m=>String(m.text).includes('می‌خواهی')));
  const normal=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|42',42);
  assert.equal(normal.jobs.length,1);assert.ok(!Object.hasOwn(normal.jobs[0].params,'subtitle'));
  const audio=await subtitleChoice('ytq|dQw4w9WgXcQ|ah|7|1');
  assert.equal(audio.jobs.length,1);assert.equal(audio.jobs[0].params.audioMode,'hq');
});

test('the widget sample is requested only for a private admin video selection', async () => {
  const admin = await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1', 1, {}, 'private');
  assert.ok(admin.jobs[0].params.downloadWidget);
  const regular = await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|42', 42, {}, 'private');
  assert.equal(regular.jobs[0].params.downloadWidget, undefined);
  const group = await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1', 1, {}, 'group');
  assert.equal(group.jobs[0].params.downloadWidget, undefined);
  const audio = await subtitleChoice('ytq|dQw4w9WgXcQ|ah|7|1', 1, {}, 'private');
  assert.equal(audio.jobs[0].params.downloadWidget, undefined);
});

test('first enable opens twelve languages in four rows; selection persists and edits the same menu',async()=>{
  const on=await subtitleChoice('ytst|dQw4w9WgXcQ|7|1|1');
  const rows=on.messages.find(m=>m.reply_markup).reply_markup.inline_keyboard;
  assert.deepEqual(rows.slice(0,4).map(r=>r.length),[3,3,3,3]);
  assert.equal(rows.flat().filter(b=>b.callback_data.startsWith('ytsl|')).length,12);
  assert.ok(rows.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
  const binding=on.env.ADMIN_STATS;
  const selected=await subtitleChoice('ytsl|dQw4w9WgXcQ|7|1|de',1,{ADMIN_STATS:binding});
  const restored=selected.messages.find(m=>m.reply_markup);
  assert.equal(restored.message_id,10);
  assert.equal(restored.reply_markup.inline_keyboard.at(-1)[1].icon_custom_emoji_id,'5206607081334906820');
  assert.equal(restored.reply_markup.inline_keyboard.at(-1)[0].text,'Deutsch');
  const reopened=await subtitleChoice('ytsp|dQw4w9WgXcQ|7|1|open',1,{ADMIN_STATS:binding});
  assert.equal(reopened.messages.find(m=>m.reply_markup).reply_markup.inline_keyboard.slice(0,4).flat().length,12);
  const next=menuFixture({messageId:11,requestMessageId:8});
  const response=await settings(binding,'open',{messageId:11,menu:next});
  assert.deepEqual((await response.json()).preference,{enabled:true,language:'de'});
  const job=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1',1,{ADMIN_STATS:binding});
  assert.equal(job.jobs[0].params.subtitle,'de');
  assert.ok(!JSON.stringify(job.jobs).includes('private-'));
  const stale=await subtitleChoice('ytst|dQw4w9WgXcQ|7|1|0',1,{ADMIN_STATS:binding});
  assert.ok(!stale.messages.some(m=>m.reply_markup));
});

test('subtitle locks are durable, independent, admin-only and preserve the stored language and enabled preference',async()=>{
  const storage=memoryStorage(),binding=subtitleBinding(storage);
  assert.equal((await setSubtitleAccess(binding,{actorId:42,locked:true})).status,403);
  assert.equal((await setSubtitleAccess(binding,{userId:0,locked:true})).status,400);
  assert.equal((await setSubtitleAccess(binding,{locked:'true'})).status,400);
  await settings(binding,'open');await settings(binding,'language',{language:'fr'});
  await setSubtitleAccess(binding,{userId:1,locked:true});
  await setSubtitleAccess(binding,{locked:true});
  await setSubtitleAccess(binding,{locked:false});
  const restarted=subtitleBinding(storage);
  assert.deepEqual(await (await setSubtitleAccess(restarted,{userId:1})).json(),{globalLocked:false,userLocked:true,locked:true});
  const locked=await (await settings(restarted,'get')).json();
  assert.equal(locked.locked,true);assert.deepEqual(locked.preference,{enabled:false,language:'fr'});
  assert.deepEqual(await storage.get('youtube-subtitles:1'),{enabled:true,language:'fr'});
  const rows=subtitleButtons(locked,true);
  assert.equal(rows.flat().length,1);assert.equal(rows[0][0].icon_custom_emoji_id,'5296369303661067030');
  assert.equal((await settings(restarted,'language',{language:'de'})).status,423);
  assert.equal((await settings(restarted,'enable',{enabled:true})).status,423);
  const other=menuFixture({userId:2,chatId:2});
  assert.equal((await (await settings(restarted,'open',{userId:2,chatId:2,menu:other})).json()).locked,false);
  await setSubtitleAccess(restarted,{userId:1,locked:false});
  assert.deepEqual((await (await settings(restarted,'get')).json()).preference,{enabled:true,language:'fr'});
});

test('all old subtitle controls show a modal and refresh the same locked menu without sending chat messages',async()=>{
  for(const data of ['ytst|dQw4w9WgXcQ|7|1|1','ytst|dQw4w9WgXcQ|7|1|0',
    'ytsl|dQw4w9WgXcQ|7|1|de','ytsp|dQw4w9WgXcQ|7|1|open','ytsp|dQw4w9WgXcQ|7|1|back']) {
    const binding=subtitleBinding();await settings(binding,'open');await setSubtitleAccess(binding,{locked:true});
    const result=await subtitleChoice(data,1,{ADMIN_STATS:binding});
    assert.equal(result.jobs.length,0);
    const alert=result.messages.find(m=>m.callback_query_id);
    assert.equal(alert.show_alert,true);assert.match(alert.text,/از طرف مدیریت/);assert.ok(alert.text.length<=200);
    assert.ok(!result.messages.some(m=>m.chat_id&&!m.message_id));
    const edit=result.messages.find(m=>m.reply_markup);
    assert.equal(edit.message_id,10);
    assert.equal(edit.reply_markup.inline_keyboard.at(-1)[0].icon_custom_emoji_id,'5296369303661067030');
    assert.ok(!JSON.stringify(edit).includes('ytsl|'));
  }
});

test('locking between preference read and take blocks paid work atomically and does not consume the menu',async()=>{
  const binding=subtitleBinding();await settings(binding,'open');await settings(binding,'language',{language:'de'});
  const race={getByName(){const stub=binding.getByName('global');return {async fetch(url,init){
    if(JSON.parse(init.body).op==='take') await setSubtitleAccess(binding,{locked:true});
    return stub.fetch(url,init);
  }};}};
  const blocked=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1',1,{ADMIN_STATS:race});
  assert.equal(blocked.jobs.length,0);
  assert.ok(blocked.messages.some(m=>m.show_alert&&m.text.includes('از طرف مدیریت')));
  assert.equal((await settings(binding,'get')).status,200);
  // Plain video and audio keep the current download path, with no subtitle capability.
  const plain=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1',1,{ADMIN_STATS:binding});
  assert.equal(plain.jobs.length,1);assert.equal(plain.jobs[0].params.subtitle,undefined);
  const audio=await subtitleChoice('ytq|dQw4w9WgXcQ|ah|7|1',1,{ADMIN_STATS:binding});
  assert.equal(audio.jobs.length,1);assert.equal(audio.jobs[0].params.audioMode,'hq');
});

test('failure to refresh a locked menu never replaces the modal with a new chat message or starts a download',async()=>{
  const binding=subtitleBinding(),calls=[];
  await settings(binding,'open');await setSubtitleAccess(binding,{locked:true});
  globalThis.fetch=async(url,init)=>{calls.push({method:String(url).split('/').at(-1),body:JSON.parse(init.body)});
    if(String(url).endsWith('/editMessageText')) throw Error('Telegram unavailable');
    return Response.json({ok:true,result:true});};
  await handleSubtitleCallback({BOT_TOKEN:'fictional-token',ADMIN_STATS:binding},{id:'locked-offline',from:{id:1},
    data:'ytst|dQw4w9WgXcQ|7|1|1',message:{message_id:10,chat:{id:1}}});
  assert.equal(calls.filter(c=>c.method==='answerCallbackQuery').length,1);
  assert.equal(calls.find(c=>c.method==='answerCallbackQuery').body.show_alert,true);
  assert.ok(!calls.some(c=>c.method==='sendMessage'));
});

test('disabling retains default language; first-time back cancels enabling and users are isolated',async()=>{
  const binding=subtitleBinding();await settings(binding,'open');
  await settings(binding,'language',{language:'fr'});
  await settings(binding,'enable',{enabled:false});
  const menu=await (await settings(binding,'get')).json();
  assert.deepEqual(menu.preference,{enabled:false,language:'fr'});
  const other=menuFixture({userId:2,chatId:2});
  const response=await settings(binding,'open',{userId:2,chatId:2,menu:other});
  assert.deepEqual((await response.json()).preference,{enabled:false});
  const first=await subtitleChoice('ytst|dQw4w9WgXcQ|7|1|1');
  await subtitleChoice('ytsp|dQw4w9WgXcQ|7|1|back',1,{ADMIN_STATS:first.env.ADMIN_STATS});
  assert.deepEqual((await (await settings(first.env.ADMIN_STATS,'get')).json()).preference,{enabled:false});
});

test('menu storage rejects invalid values, stale preferences and duplicate takes atomically',async()=>{
  const binding=subtitleBinding();await settings(binding,'open');
  assert.equal((await settings(binding,'language',{language:'__proto__'})).status,400);
  await settings(binding,'language',{language:'en'});
  assert.equal((await settings(binding,'take',{expected:{enabled:false}})).status,412);
  const results=await Promise.all([settings(binding,'take'),settings(binding,'take')]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await settings(binding,'language',{language:'ru'})).status,409);
  assert.equal((await settings(binding,'get',{videoId:'abcdefghijk'})).status,410);
});

test('expired menus cannot start downloads; callbacks fit Telegram limits with maximum safe IDs',async()=>{
  const storage=memoryStorage(),binding=subtitleBinding(storage);
  await settings(binding,'open');
  const key='youtube-subtitle-menu:1:1:10';
  const old=await storage.get(key);old.createdAt-=24*60*60*1000+1;await storage.put(key,old);
  assert.equal((await settings(binding,'take')).status,410);
  assert.equal(await storage.get(key),undefined);
  const max=Number.MAX_SAFE_INTEGER;
  for(const picker of [true,false]){
    const rows=subtitleButtons(menuFixture({userId:max,requestMessageId:max,preference:{enabled:true,language:'zh'}}),picker);
    assert.ok(rows.flat().every(b=>Buffer.byteLength(b.callback_data)<=64));
  }
});

test('forged subtitle buttons, other users and missing API keys cannot start paid work',async()=>{
  for(const [data,actor,extra] of [
    ['yts|dQw4w9WgXcQ|720|7|42|1',42,{}],
    ['yts|dQw4w9WgXcQ|720|7|1|1',42,{}],
    ['yts|dQw4w9WgXcQ|720|7|1|1',1,{GPT_API:''}],
    ['yts|dQw4w9WgXcQ|720|7|1|1',1,{ELEVEN_API:''}],
    ['yts|dQw4w9WgXcQ|ah|7|1|1',1,{}],
  ]) assert.equal((await subtitleChoice(data,actor,extra)).jobs.length,0);
  for(const data of ['ytst|dQw4w9WgXcQ|7|1|1','ytsl|dQw4w9WgXcQ|7|1|de'])
    assert.equal((await subtitleChoice(data,42)).jobs.length,0);
  const binding=subtitleBinding();await settings(binding,'open');await settings(binding,'language',{language:'hi'});
  assert.equal((await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|1',1,{ADMIN_STATS:binding,GPT_API:''})).jobs.length,0);
  for(const data of ['yts|dQw4w9WgXcQ|720|7|1|true','yts|dQw4w9WgXcQ|720|0|1|1','yts|dQw4w9WgXcQ|720|7|9007199254740992|1'])
    assert.equal(parseQualityCallback(data),null);
});

test('subtitle Telegram cache keys are isolated from original quality and audio keys',async()=>{
  const base={url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',quality:720};
  assert.equal(await mediaCacheKey(base),'yt:dQw4w9WgXcQ:v720');
  assert.equal(await mediaCacheKey({...base,subtitle:'fa'}),'yt:dQw4w9WgXcQ:v720:sub-fa-v1');
  assert.equal(await mediaCacheKey({...base,subtitle:'de'}),'yt:dQw4w9WgXcQ:v720:sub-de-v1');
  assert.equal(await mediaCacheKey({...base,audioMode:'hq'}),'yt:dQw4w9WgXcQ:ah');
});


test('subtitle validation is checked in Workflow before cache, container boot or API work',async()=>{
  for(const options of [{jobChanges:{subtitle:'invalid',userId:42}},{jobChanges:{subtitle:'fa',userId:42,audioMode:'hq'}},
      {jobChanges:{subtitle:'fa',userId:42},aiSecrets:false}]){
    const result=await run(options);
    assert.equal(result.calls.length,0);assert.equal(result.delivered,0);
  }
});

test('non-admin users can enable, select a language and start signed subtitles on their own menu',async()=>{
  const on=await subtitleChoice('ytst|dQw4w9WgXcQ|7|42|1',42);
  assert.equal(on.messages.find(m=>m.reply_markup).reply_markup.inline_keyboard.slice(0,4).flat().length,12);
  const binding=on.env.ADMIN_STATS;
  await subtitleChoice('ytsl|dQw4w9WgXcQ|7|42|fr',42,{ADMIN_STATS:binding});
  const selected=await subtitleChoice('ytq|dQw4w9WgXcQ|720|7|42',42,{ADMIN_STATS:binding});
  assert.equal(selected.jobs[0].params.subtitle,'fr');
  const result=await run({jobChanges:{subtitle:'fr',userId:42},subtitleVersion:2});
  assert.equal(result.delivered,1);
  assert.equal(globalThis.lastDownloadPayload.subtitleAuthorization,createHmac('sha256','secret-token')
    .update('subtitle-fr-v1|test-job|42|dQw4w9WgXcQ|720').digest('hex'));
});

test('YouTube history carries explicit subtitle mode and language while other source history stays unchanged',async()=>{
  await run();assert.equal(globalThis.downloadHistory.at(-1).subtitleLanguage,null);
  await run({jobChanges:{subtitle:'hi',userId:1},subtitleVersion:2});
  assert.equal(globalThis.downloadHistory.at(-1).subtitleLanguage,'hi');
  await run({pornhub:true});assert.ok(!Object.hasOwn(globalThis.downloadHistory.at(-1),'subtitleLanguage'));
});

test('ordinary jobs never receive AI credentials; signed admin subtitle payload stays on the same download endpoint',async()=>{
  await run();
  assert.ok(!Object.hasOwn(globalThis.lastDownloadPayload,'elevenApiKey'));
  assert.ok(!Object.hasOwn(globalThis.lastDownloadPayload,'gptApiKey'));
  const result=await run({jobChanges:{subtitle:'fa',userId:1}});
  assert.equal(result.delivered,1);
  const body=globalThis.lastDownloadPayload;
  assert.equal(body.elevenApiKey,'private-eleven');assert.equal(body.gptApiKey,'private-gpt');
  assert.equal(body.mediaCacheKey,'yt:dQw4w9WgXcQ:v720:sub-fa-v1');
  const expected=createHmac('sha256','secret-token').update('subtitle-fa-v1|test-job|1|dQw4w9WgXcQ|720').digest('hex');
  assert.equal(body.subtitleAuthorization,expected);
  assert.deepEqual(result.calls.map(c=>c[0]),['start','/health','/download']);
});

test('old container images cannot silently return plain video for a subtitle request',async()=>{
  const result=await run({jobChanges:{subtitle:'fa',userId:1},subtitleVersion:null});
  assert.ok(!result.calls.some(c=>c[0]==='/download'));assert.equal(result.delivered,0);
});

test('all twelve targets use the existing transfer with language-bound signatures and modern runtime checks',async()=>{
  for(const language of Object.keys(JSON.parse(subtitleLanguages))){
    const result=await run({jobChanges:{subtitle:language,userId:1},subtitleVersion:2});
    assert.equal(result.delivered,1,language);
    const body=globalThis.lastDownloadPayload;
    assert.equal(body.mediaCacheKey,`yt:dQw4w9WgXcQ:v720:sub-${language}-v1`);
    assert.equal(body.subtitleAuthorization,createHmac('sha256','secret-token')
      .update(`subtitle-${language}-v1|test-job|1|dQw4w9WgXcQ|720`).digest('hex'));
    assert.deepEqual(result.calls.map(c=>c[0]),['start','/health','/download']);
  }
  const old=await run({jobChanges:{subtitle:'hi',userId:1},subtitleVersion:1});
  assert.equal(old.delivered,0);assert.ok(!old.calls.some(c=>c[0]==='/download'));
});

test('subtitle jobs do not replay paid preparation automatically after Telegram flood waits',async()=>{
  const result=await run({jobChanges:{subtitle:'fa',userId:1},result:{ok:false,retrySafe:true,phase:'upload',rpcCode:420,
    errorCode:'FLOOD_WAIT',retryAfterSeconds:300},onSleep(){throw Error('paid work must not be replayed');}});
  assert.equal(result.calls.filter(c=>c[0]==='/download').length,1);
  assert.ok(!result.steps.some(([,config])=>config.sleep));
});



test('warm catalog skips Container admission and extraction while preserving the quality menu',async()=>{
 const values=new Map(), storage=memoryStorage();
 const binding={getByName(){return{async fetch(input,init){
  const request=new Request(input,init);
  const body=await request.json();
  if(new URL(request.url).pathname==='/youtube-catalog-cache'){
   if(body.op==='put')values.set(body.key,body.value);
   return Response.json({value:body.op==='get'?values.get(body.key):null});
  }
  return subtitleSettings(new Request(request.url,{method:'POST',body:JSON.stringify(body)}),storage);
 }}}};
 const first=await run({inspect:true,catalogBinding:binding});
 assert.ok(first.calls.some(c=>c[0]==='/metadata'));
 const second=await run({inspect:true,catalogBinding:binding,startupError:'must never start'});
 assert.deepEqual(second.calls,[]);
 assert.deepEqual(second.messages.find(m=>m.reply_markup).reply_markup,first.messages.find(m=>m.reply_markup).reply_markup);
 const cold=await run({inspect:true,catalogBinding:{getByName(){return{fetch(){throw Error('storage unavailable');}}}}});
 assert.ok(cold.calls.some(c=>c[0]==='/metadata'));
});


test('quality cache icons follow the current subtitle language and preserve callback payloads',async()=>{
 const menu=menuFixture({userId:42,chatId:42});const env={BOT_TOKEN:'fixture'};const reads=[];
 globalThis.testFileCache=async(_env,op,key)=>{reads.push(key);return ['yt:dQw4w9WgXcQ:v720','yt:dQw4w9WgXcQ:v360:sub-de-v1'].includes(key)?{method:'sendVideo',fileId:'fixture',data:{}}:null;};
 try{
 const plain=await buildCachedQualityKeyboard(env,menu);
 assert.equal(plain.flat().filter(b=>b.icon_custom_emoji_id).length,1);
 assert.ok(plain.flat().find(b=>b.icon_custom_emoji_id).callback_data.includes('|720|'));
 const translated=await buildCachedQualityKeyboard(env,{...menu,preference:{enabled:true,language:'de'}});
 assert.ok(translated.flat().find(b=>b.icon_custom_emoji_id).callback_data.includes('|360|'));
 assert.equal(translated.flat().find(b=>b.icon_custom_emoji_id).icon_custom_emoji_id,'5372917041193828849');
 const before=reads.length;await buildCachedQualityKeyboard(env,{...menu,preference:{enabled:true}});assert.equal(reads.length,before);
 }finally{delete globalThis.testFileCache;}
});

function sharedCacheFixture(){
 const values=new Map();const calls=[];
 const env={BOT_TOKEN:'123:fixture',ADMIN_STATS:{getByName(){return{async fetch(input,init){
  const request=new Request(input,init),body=await request.json();
  if(new URL(request.url).pathname==='/youtube-subtitles')return Response.json({locked:false,preference:{enabled:false}});
  if(new URL(request.url).pathname!=='/file-cache')throw Error('Unexpected storage endpoint');
  if(body.op==='put'||body.op==='import')values.set(body.key,structuredClone(body.value));
  if(body.op==='delete')values.set(body.key,null);
  return Response.json({value:values.get(body.key)||null,known:values.has(body.key)});
 }}}}};
 const job={sharedCacheVersion:1,id:'igdl-99-8-99',userId:99,chatId:99,requestMessageId:8,url:'https://www.instagram.com/p/ExamplePost/',instagramPostRequest:{shortcode:'ExamplePost'}};
 globalThis.downloadHistory=[];globalThis.delivered=0;
 const previous=globalThis.fetch,previousCache=globalThis.testFileCache;globalThis.testFileCache=actualFileCache;
 globalThis.fetch=async(url,init)=>{
  assert.equal(new URL(url).hostname,'api.telegram.org','warm cache must not resolve or download source media');
  const method=String(url).split('/').at(-1),body=JSON.parse(init.body);calls.push({method,body});
  const id=calls.length;
  return Response.json({ok:true,result:{message_id:id,...(method==='sendVideo'?{video:{file_id:'video_fixture',file_size:1000}}:{}),
   ...(method==='sendPhoto'?{photo:[{file_id:'photo_fixture',file_size:200}]}:{})}});
 };
 return{env,job,values,calls,close(){globalThis.fetch=previous;globalThis.testFileCache=previousCache;}};
}

test('a complete public Instagram carousel is reused by another user before provider or Container work',async()=>{
 const f=sharedCacheFixture();try{
 await sendInstagramPostDirect(f.env,{kind:'post',shortcode:'ExamplePost',url:f.job.url},
  {chat:{id:42},from:{id:42},message_id:7},[
   {kind:'photo',url:'https://scontent.cdninstagram.com/photo.jpg',width:100,height:100,size:200},
   {kind:'video',url:'https://scontent.cdninstagram.com/video.mp4',width:100,height:100,size:1000}], 'ig:42:7:42');
 const key=await postCacheKey(f.env,f.job);assert.equal(f.values.get(key).files.length,2);
 assert.ok(!JSON.stringify(f.values.get(key)).includes('callback_data'));
 f.calls.length=0;const steps=[];
 await new YoutubeDownloadWorkflow({},f.env).run({payload:f.job},{async do(name,...args){steps.push(name);return args.at(-1)();}});
 const media=f.calls.filter(c=>['sendPhoto','sendVideo'].includes(c.method));
 assert.deepEqual(media.map(c=>c.method),['sendPhoto','sendVideo']);
 assert.equal(media[0].body.photo,'photo_fixture');assert.equal(media[1].body.video,'video_fixture');
 assert.ok(media.every(c=>c.body.chat_id===99&&c.body.reply_parameters.message_id===8));
 const buttons=media[1].body.reply_markup.inline_keyboard.flat();
 assert.ok(buttons.some(b=>b.callback_data==='iga|p|ExamplePost|1|99'));
 assert.ok(buttons.some(b=>b.callback_data.startsWith('mss|p|ExamplePost|1|99|')));
 assert.ok(!steps.some(s=>/resolve public|start.*container|reserve download/.test(s)));
 assert.equal(globalThis.downloadHistory.at(-1).delivered,2);
 assert.equal(globalThis.downloadHistory.at(-1).status,'success');
 }finally{f.close();}
});

test('private Instagram results never become public posts and subtitle variants cannot reuse plain output',async()=>{
 const f=sharedCacheFixture();try{
 await sendInstagramPostDirect(f.env,{kind:'post',shortcode:'ExamplePost',url:f.job.url},{chat:{id:42},from:{id:42},message_id:7},
  [{kind:'video',url:'https://scontent.cdninstagram.com/video.mp4',width:100,height:100,size:1000}], 'ig:42:7:42',false);
 assert.equal(f.values.has(await postCacheKey(f.env,f.job)),false);
 assert.ok(f.values.has('ig:v2:access:p:ExamplePost:0:video'));
 const plain=await postCacheKey(f.env,f.job),fa=await postCacheKey(f.env,{...f.job,subtitle:'fa',subtitlePostIndex:0}),de=await postCacheKey(f.env,{...f.job,subtitle:'de',subtitlePostIndex:0});
 assert.equal(new Set([plain,fa,de]).size,3);
 assert.equal(await sendCachedPost(f.env,f.job,10),null);
 assert.equal(await sendCachedPost(f.env,{...f.job,subtitle:'fa',subtitlePostIndex:0},10),null);
 }finally{f.close();}
});

test('invalid first cached IDs fall back; partial or ambiguous cached sends stop without duplicate uploads',async()=>{
 for(const failAt of [1,2])for(const invalid of [true,false]){
  const f=sharedCacheFixture();try{
   const key=await postCacheKey(f.env,f.job);f.values.set(key,{kind:'post',files:[0,1].map(index=>({index,method:'sendVideo',fileId:'fixture_'+index,data:{caption:'Instagram'}}))});
   let sends=0;globalThis.fetch=async(url,init)=>{
    const method=String(url).split('/').at(-1),body=JSON.parse(init.body);f.calls.push({method,body});
    if(method==='sendVideo'&&++sends===failAt){if(!invalid)throw Error('ambiguous timeout');return Response.json({ok:false,description:'wrong file identifier'});}
    return Response.json({ok:true,result:{message_id:sends,video:{file_id:'fixture'}}});
   };
   const result=await sendCachedPost(f.env,f.job,10);
   assert.equal(sends,failAt);
   if(invalid&&failAt===1){assert.equal(result,null);assert.equal(f.values.get(key),null);}
   else{assert.equal(result.ok,false);assert.equal(result.parts,failAt-1);assert.equal(globalThis.downloadHistory.at(-1).delivered,failAt-1);}
  }finally{f.close();}
 }
});

test('shared keys preserve access checks, request modes, indices and credential isolation',async()=>{
 const f=sharedCacheFixture();try{
  const base={...f.job,instagramPostRequest:undefined,social:{platform:'x',url:'https://x.com/i/status/123'}};
  const key=await postCacheKey(f.env,base);
  assert.equal(key,await postCacheKey(f.env,{...base,userId:42,chatId:42}));
  assert.notEqual(key,await postCacheKey(f.env,{...base,social:{...base.social,audioOnly:true}}));
  assert.notEqual(key,await postCacheKey(f.env,{...base,social:{...base.social,itemIndex:1}}));
  assert.equal(await postCacheKey(f.env,{...base,social:{platform:'pinterest',url:'https://www.pinterest.com/pin/123/'}}),undefined);
  const reddit={...base,social:undefined,reddit:{url:'https://www.reddit.com/comments/abc'}};
  assert.ok(await postCacheKey(f.env,reddit));assert.equal(await postCacheKey({...f.env,REDDIT_COOKIES:'private'},reddit),undefined);
  assert.equal(await sendCachedPost(f.env,{...base,instagram:{kind:'replay',shortcode:'ExamplePost'}},10),null);
  assert.equal(await mediaCacheKey({userId:42,instagram:{kind:'replay',shortcode:'ExamplePost'},url:''}),await mediaCacheKey({userId:99,instagram:{kind:'replay',shortcode:'ExamplePost'},url:''}));
 }finally{f.close();}
});

test('photo references copy the confirmed media without exposing old messages or re-uploading',async()=>{
 const f=sharedCacheFixture();try{
  const photo={method:'sendPhoto',sourceMessage:{chatId:42,messageId:7},data:{caption:'Instagram'},fileSize:200};
  f.values.set('ig:v2:public:p:ExamplePost:0:photo',photo);
  await sendInstagramPostDirect(f.env,{kind:'post',shortcode:'ExamplePost',url:f.job.url},
   {chat:{id:99},from:{id:99},message_id:8},[{kind:'photo',url:'https://scontent.cdninstagram.com/photo.jpg',width:100,height:100,size:200}], 'ig:99:8:99');
  assert.equal(f.calls[0].method,'copyMessage');assert.equal(f.calls[0].body.from_chat_id,42);
  assert.equal(f.calls[0].body.message_id,7);assert.equal(f.calls[0].body.chat_id,99);assert.equal(f.calls[0].body.photo,undefined);
  f.calls.length=0;
  const result=await sendCachedPost(f.env,{...f.job,userId:77,chatId:77},10);
  assert.equal(result.ok,true);assert.equal(f.calls[0].method,'copyMessage');assert.equal(f.calls[0].body.chat_id,77);
  globalThis.fetch=async()=>Response.json({ok:false,description:'Bad Request: message to copy not found'});
  assert.equal(await sendCachedPost(f.env,f.job,10),null);
 }finally{f.close();}
});

test('legacy in-flight Instagram jobs never enter newly added fast-cache steps after deployment',async()=>{
 const f=sharedCacheFixture();try{
  const job={...f.job,sharedCacheVersion:undefined},steps=[];
  f.values.set(await postCacheKey(f.env,job),{kind:'post',files:[{method:'sendVideo',fileId:'already_sent',index:0,data:{}}]});
  const checkpoints={
   'track download request':undefined,'show public Instagram post status once':10,
   'resolve public Instagram post once':{media:[{kind:'photo',url:'https://scontent.cdninstagram.com/old.jpg',size:100,width:10,height:10}]},
   'deliver public Instagram post once':1,'record public Instagram post delivery':undefined,'clear public Instagram post status':undefined,
  };
  await new YoutubeDownloadWorkflow({},f.env).run({payload:job},{async do(name){steps.push(name);
   assert.ok(Object.hasOwn(checkpoints,name),'old workflow must resume its existing checkpoints');return checkpoints[name];}});
  assert.ok(!steps.some(name=>name.includes('reuse complete')));
  assert.equal(f.calls.length,0);
 }finally{f.close();}
});

test('cached social audio buttons remain signed for the actual source when a title contains another URL',async()=>{
 const f=sharedCacheFixture();try{
  const job={...f.job,instagramPostRequest:undefined,social:{platform:'x',url:'https://x.com/i/status/123'}};
  f.values.set(await postCacheKey(f.env,job),{kind:'post',files:[{index:0,method:'sendVideo',fileId:'fixture',hasAudio:true,
   data:{caption:'Title with https://x.com/i/status/999\nX 1/1\nhttps://x.com/i/status/123'}}]});
  assert.equal((await sendCachedPost(f.env,job,10)).ok,true);
  const data=f.calls.find(c=>c.method==='sendVideo').body.reply_markup.inline_keyboard[0][0].callback_data;
  const signature=createHmac('sha256',f.env.BOT_TOKEN).update('social-audio:99:99:0:https://x.com/i/status/123').digest('hex').slice(0,16);
  assert.equal(data,'soa|0|99|'+signature);
 }finally{f.close();}
});
