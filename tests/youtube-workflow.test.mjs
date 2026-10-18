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
        export class Container { constructor(ctx, env) { this.env = env; } }
        export const getContainer = () => globalThis.container;
      ` };
      if (args.path === 'cloudflare:workers') return { contents: `
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
const { YoutubeDownloadWorkflow, extractPornhubUrl, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

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

async function run({ inspect = false, startupError, httpError, sizes, credentials = true, pornhub = false } = {}) {
  const messages = [];
  const calls = [];
  const steps = [];
  globalThis.delivered = 0;
  globalThis.fetch = async (_url, init) => {
    messages.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 10 } });
  };
  globalThis.container = {
    async startAndWaitForPorts(options) {
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
  await new YoutubeDownloadWorkflow({}, { BOT_TOKEN: 'secret-token', ...(credentials ? { API_ID: '123', API_HASH: 'secret-hash' } : {}) }).run({ payload: job }, step);
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
