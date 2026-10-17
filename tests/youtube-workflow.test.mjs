import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = await readFile(new URL('../src/youtube-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source, loader: 'ts', resolveDir: process.cwd() },
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
      if (args.path === './story-main') return { contents: 'export default { fetch() {} };' };
      if (args.path === './admin') return { contents: `
        export class AdminStatsStore {}
        export const ADMIN_USER_ID = 1;
        export const recordSuccessfulDelivery = async () => { globalThis.delivered++; };
        export const recordUserActivity = async () => {};
      ` };
      throw Error('Unexpected import ' + args.path);
    });
  } }],
});
const { YoutubeDownloadWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

async function run({ inspect = false, startupError, httpError, sizes, credentials = true } = {}) {
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
    ...(inspect ? {} : { quality: 720, statusMessageId: 10 }),
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
