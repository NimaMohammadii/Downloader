import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';

const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source + '\nexport {extractPornhubUrl};', loader: 'ts', resolveDir: process.cwd() },
  bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'cloudflare-test-bindings', setup(build) {
    build.onResolve({ filter: /.*/ }, args => ({ path: args.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, args => {
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
      if (args.path === './story-main') return { contents: 'export default { fetch() {} }; export const parseInstagramVideoTarget = () => null; export const parseInstagramAudioTarget = () => null; export const resolveInstagramVideo = () => {}; export const instagramVideoErrorText = () => "error";' };
      if (args.path === './admin') return { contents: `
        export const recordDownload = async(_env,record)=>{(globalThis.downloadHistory ||= []).push(record);};
        export const isInstagramDownloadLink = text=>/instagram.com\\//.test(text);
        export const telegramTextMotion=async()=>{};
        export const recordUsage=async(...args)=>globalThis.usageTelemetry ? globalThis.usageTelemetry(...args) : true; export const recordMediaDelivery=async()=>{}; export const telegramCustomEmoji=(_method,payload)=>payload;
        export const telegramFileCache=async(...args)=>globalThis.testFileCache ? globalThis.testFileCache(...args) : null; export class AdminStatsStore {}
        export const ADMIN_USER_ID = 1;
        export const recordSuccessfulDelivery = async () => { globalThis.delivered++; };
        export const recordUserActivity = async () => {};
      ` };
      throw Error('Unexpected import ' + args.path);
    });
  } }],
});
const { DownloadPool, YoutubeDownloaderContainer, YoutubeDownloadWorkflow, extractPornhubUrl, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

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

test('Pornhub session is supplied only through the container environment', async () => {
  const entries = [{ domain: '.pornhub.com', name: 'session', value: 'fictional-ph-session' }];
  const exports = ['# Netscape HTTP Cookie File\n.pornhub.com\tTRUE\t/\tTRUE\t0\tsession\tfictional-ph-session\n',
    JSON.stringify(entries), '\uFEFF' + JSON.stringify({ cookies: entries }).replace('fictional-ph-session', 'fictional-ph-\\u0073ession')];
  for (const raw of exports) {
    const container = new YoutubeDownloaderContainer({ storage: memoryStorage() }, { BOT_TOKEN: 'fake', PORNHUB_COOKIES: raw });
    container.startAndWaitForPorts = async () => {};
    await container.startShared(0);
    assert.equal(container.envVars.PORNHUB_COOKIES, raw);
    const logs = [], previous = console.error;
    try {
      console.error = (message, detail) => logs.push({ message, detail });
      await run({ pornhub: true, pornhubCookies: raw, result: { ok: false, phase: 'metadata',
        errorCode: 'SOURCE_REDIRECTED', diagnostic: `ERROR: fictional-ph-session ${raw}` } });
      const failure = logs.find(x => x.message === 'pornhub download rejected');
      assert.equal(failure.detail.code, 'SOURCE_REDIRECTED');
      assert.ok(!JSON.stringify(logs).includes('fictional-ph-session'));
      assert.ok(failure.detail.detail.includes('[redacted]'));
    } finally { console.error = previous; }
  }
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

const sdkBuild = await build({
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

async function run({ inspect = false, startupError, httpError, result, sizes, credentials = true, pornhub = false, pornhubCookies, pool = poolBinding(), results, onSleep, checkpoints = new Map() } = {}) {
  const messages = [];
  const calls = [];
  const steps = [];
  globalThis.delivered = 0;
  globalThis.downloadHistory = [];
  globalThis.fetch = async (_url, init) => {
    messages.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  globalThis.container = {
    async startShared(options) {
      calls.push(['start', options]);
      if (startupError) throw Error(startupError);
    },
    async fetch(request) {
      calls.push([new URL(request.url).pathname]);
      if (pornhubCookies && new URL(request.url).pathname === '/download') {
        const body = await request.clone().text();
        assert.ok(!body.includes('PORNHUB_COOKIES') && !body.includes('fictional-ph-session'));
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
  await new YoutubeDownloadWorkflow({}, { BOT_TOKEN: 'secret-token', DOWNLOAD_POOL: pool, PORNHUB_COOKIES: pornhubCookies,
    ...(credentials ? { API_ID: '123', API_HASH: 'secret-hash' } : {}) }).run({ payload: job }, step);
  return { calls, messages, steps, delivered: globalThis.delivered };
}

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
  const buttons = result.messages.find(m => m.reply_markup)?.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.text === '⭐ 720p HD 123.4 MB'));
  assert.ok(buttons.some(b => b.text === '1080p Full HD 1.50 GB'));
  assert.ok(buttons.some(b => b.text === '🎵 Audio Low 3.2 MB'));
  assert.ok(buttons.every(b => !/[\u0600-\u06ff]/u.test(b.text)));
});

test('older metadata without a size still offers working quality buttons', async () => {
  const result = await run({ inspect: true });
  const buttons = result.messages.find(m => m.reply_markup)?.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(b => b.text === '360p Low Size unknown'));
  assert.ok(buttons.every(b => b.callback_data.startsWith('ytq|')));
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
