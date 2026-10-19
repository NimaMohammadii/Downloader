import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

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
        }
        export const getContainer = () => globalThis.container;
      ` };
      if (args.path === 'cloudflare:workers') return { contents: `
        export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
        export class WorkflowEntrypoint { constructor(ctx, env) { this.env = env; } }
      ` };
      if (args.path === './story-main') return { contents: 'export default { fetch() {} }; export const parseInstagramVideoTarget = () => null; export const parseInstagramAudioTarget = () => null; export const resolveInstagramVideo = () => {}; export const instagramVideoErrorText = () => "error";' };
      if (args.path === './admin') return { contents: `
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
  const container = new YoutubeDownloaderContainer({}, {});
  let finish, starts = 0;
  container.startAndWaitForPorts = async () => { starts++; await new Promise(resolve => { finish = resolve; }); };
  const requests = Array.from({ length: 5 }, () => container.startShared());
  assert.equal(starts, 1);
  finish();
  await Promise.all(requests);
  container.startAndWaitForPorts = async () => { starts++; throw Error('startup failed'); };
  await assert.rejects(container.startShared(), /startup failed/);
  container.startAndWaitForPorts = async () => { starts++; };
  await container.startShared();
  assert.equal(starts, 3);
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
  sdk.sleepAfter = '10s';
  sdk.sleepAfterMs = 0;
  sdk.inflightRequests = 1;
  assert.equal(sdk.isActivityExpired(), false);
  assert.ok(sdk.sleepAfterMs > Date.now());
  sdk.inflightRequests = 0;
  sdk.sleepAfterMs = 0;
  assert.equal(sdk.isActivityExpired(), true);
});

test('idle containers stop after ten seconds and completed background jobs restore that timeout', async () => {
  const ctx = { storage: memoryStorage() };
  const container = new YoutubeDownloaderContainer(ctx, {});
  assert.equal(container.sleepAfter, '10s');
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
  assert.equal(container.sleepAfter, '10s');
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

async function run({ inspect = false, startupError, httpError, sizes, credentials = true, pornhub = false, pool = poolBinding() } = {}) {
  const messages = [];
  const calls = [];
  const steps = [];
  globalThis.delivered = 0;
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
      if (httpError) return new Response(httpError.body, { status: httpError.status });
      return Response.json(inspect ? { ok: true, videoId: 'dQw4w9WgXcQ', qualities: [360, 480, 720, 1080], audioAvailable: true, sizes } : { ok: true });
    },
  };
  const step = { async do(name, config, callback) {
    if (typeof config === 'function') { callback = config; config = {}; }
    steps.push([name, config]);
    if (config.timeout?.endsWith('minutes') && parseInt(config.timeout) > 30) throw Error('Workflow step timeout exceeds 30 minutes');
    return callback();
  } };
  const job = { id: 'test-job', chatId: 42, userId: 42, requestMessageId: 7,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ...(pornhub ? { source: 'pornhub', url: 'https://www.pornhub.com/view_video.php?viewkey=ph123' } : inspect ? {} : { quality: 720, statusMessageId: 10 }),
  };
  await new YoutubeDownloadWorkflow({}, { BOT_TOKEN: 'secret-token', DOWNLOAD_POOL: pool, ...(credentials ? { API_ID: '123', API_HASH: 'secret-hash' } : {}) }).run({ payload: job }, step);
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
