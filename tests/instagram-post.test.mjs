import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';

const { outputFiles } = await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'instagram-post-bindings', setup(build) {
    build.onResolve({ filter: /^\.\/admin$/ }, args => ({ path: args.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export const telegramCustomEmoji = (_method, payload) => payload;
      export const telegramTextMotion = async () => {};
      export const telegramFileCache = async () => null;
      export const recordDownload = async (_env, value) => { (globalThis.history ||= []).push(value); };
      export const recordSuccessfulDelivery = async () => {};
    ` }));
  } }],
});
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

async function run({ session = '12345%3Afixture-session', mobileAllowsAuth = true, graphqlErrorCode = 4630001 } = {}) {
  const calls = [], sent = [], diagnostics = [];
  globalThis.history = [];
  const originalError = console.error;
  console.error = (message, info) => diagnostics.push({ message, info });
  const shortcode = 'DesNYugDyMp';
  try {
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(typeof url === 'string' ? url : url.url);
      const headers = new Headers(init.headers);
      if (target.hostname === 'api.telegram.org') {
        const method = target.pathname.split('/').at(-1);
        const payload = JSON.parse(init.body);
        sent.push({ method, payload });
        return Response.json({ ok: true, result: { message_id: 99,
          ...(method === 'sendVideo' ? { video: { file_id: 'video-file-id' } } : {}) } });
      }
      calls.push({ path: target.pathname, hostname: target.hostname, headers });
      if (target.hostname === 'scontent.cdninstagram.com') {
        return new Response(null, { headers: { 'content-length': '1000000' } });
      }
      if (target.pathname === '/api/v1/oembed/') {
        return Response.json({ media_id: '3700000000000000001_12345' });
      }
      if (target.pathname === '/api/v1/media/3700000000000000001/info/') {
        const allowed = mobileAllowsAuth && headers.get('authorization')?.startsWith('Bearer IGT:2:')
          && headers.get('x-ig-app-id') === '567067343352427'
          && headers.get('cookie')?.includes('sessionid=');
        return allowed
          ? Response.json({ items: [{ video_versions: [{ url: 'https://scontent.cdninstagram.com/video.mp4', width: 1080, height: 1920 }] }] })
          : Response.json({ message: 'login_required' }, { status: 401 });
      }
      if (target.pathname === '/graphql/query' || target.pathname === '/api/graphql') {
        return Response.json({ data: null, errors: [{ message: graphqlErrorCode === 1675004
          ? 'Rate limit exceeded' : 'execution error', code: graphqlErrorCode }] });
      }
      if (target.pathname.startsWith('/api/v1/media/')) {
        return Response.json({ items: [] }, { status: 404 });
      }
      if (target.pathname === '/' || target.pathname.includes('/p/') || target.pathname.includes('/embed/')) {
        return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      }
      throw Error('Unmocked endpoint ' + target.pathname);
    };
    const request = new Request('https://worker/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-webhook' },
      body: JSON.stringify({ update_id: 9, message: { message_id: 8, from: { id: 42 }, chat: { id: 42 },
        text: `https://www.instagram.com/reel/${shortcode}/?mdxt=test` } }),
    });
    const response = await worker.fetch(request, {
      BOT_TOKEN: 'test-telegram-token', WEBHOOK_SECRET: 'test-webhook',
      INSTAGRAM_SESSIONID: session,
    }, {});
    assert.equal(response.status, 200);
  } finally { console.error = originalError; }
  return { calls, sent, diagnostics, history: globalThis.history };
}

test('existing mobile resolver authenticates the same reel after anonymous access is rejected', async () => {
  const result = await run();
  const mobile = result.calls.filter(call => call.path === '/api/v1/media/3700000000000000001/info/');
  assert.equal(mobile.length, 2);
  assert.equal(mobile[0].headers.get('authorization'), null, 'public fallback stays anonymous');
  assert.match(mobile[1].headers.get('authorization'), /^Bearer IGT:2:/);
  assert.equal(mobile[1].headers.get('x-ig-app-id'), '567067343352427');
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
});

test('all failed post resolvers report sanitized per-resolver failure causes in the final error', async () => {
  const result = await run({ mobileAllowsAuth: false });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
  const report = result.diagnostics.find(item => item.message === 'instagram download failed')?.info?.detail;
  assert.match(report, /INSTAGRAM_ALL_RESOLVERS_FAILED/);
  assert.match(report, /session\/mobile-api:INSTAGRAM_MOBILE_HTTP_401/);
  assert.match(report, /graphql-web-info:INSTAGRAM_GRAPHQL_ERROR_4630001/);
  assert.doesNotMatch(report, /fixture-session|test-telegram-token/);
});

test('GraphQL rate-limit error carried with HTTP 200 is not disguised as an empty result', async () => {
  const result = await run({ graphqlErrorCode: 1675004 });
  const report = result.diagnostics.find(item => item.message === 'instagram download failed')?.info?.detail;
  assert.equal(report, 'INSTAGRAM_RATE_LIMIT_429');
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
});
