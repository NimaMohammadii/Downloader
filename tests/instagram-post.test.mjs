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

const shortcode = 'DesNYugDyMp';
const mediaId = [...shortcode].reduce((value, char) => value * 64n + BigInt('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(char)), 0n).toString();
const video = { code: shortcode, video_versions: [{ url: 'https://scontent.cdninstagram.com/video.mp4', width: 1080, height: 1920 }] };

async function run({ session = '12345%3Afixture-session', mobileAllowsAuth = true, graphqlErrorCode = 4630001,
  oembedStatus = 200, graphqlData, pageHtml = '<html></html>', homeRedirect, webInfo, mobileStatus = 401,
  pageRedirect, graphqlRaw, graphqlFailure, mobilePayload } = {}) {
  const calls = [], sent = [], diagnostics = [];
  globalThis.history = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (message, info) => diagnostics.push({ message, info });
  console.warn = (message, info) => diagnostics.push({ message, info });
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
        return Response.json({ media_id: `${mediaId}_12345` }, { status: oembedStatus });
      }
      if (target.pathname === `/api/v1/media/${mediaId}/info/`) {
        if (target.hostname === 'www.instagram.com' && webInfo) return Response.json({ items: [webInfo] });
        if (mobilePayload) return Response.json(mobilePayload, { status: mobileStatus });
        const allowed = mobileAllowsAuth && headers.get('authorization')?.startsWith('Bearer IGT:2:')
          && headers.get('x-ig-app-id') === '567067343352427'
          && headers.get('cookie')?.includes('sessionid=');
        return allowed
          ? Response.json({ items: [video] })
          : Response.json({ message: 'login_required' }, { status: mobileStatus });
      }
      if (target.pathname === '/graphql/query' || target.pathname === '/api/graphql') {
        if (graphqlFailure) throw Error(graphqlFailure);
        if (graphqlRaw) return new Response(graphqlRaw);
        if (graphqlData) return Response.json(graphqlData);
        return Response.json({ data: null, errors: [{ message: graphqlErrorCode === 1675004
          ? 'Rate limit exceeded' : 'execution error', code: graphqlErrorCode }] });
      }
      if (target.pathname.startsWith('/api/v1/media/')) {
        return Response.json({ items: [] }, { status: 404 });
      }
      if (target.pathname === '/' && homeRedirect) return new Response(null, { status: 302, headers: { location: homeRedirect } });
      if (target.pathname === `/p/${shortcode}/` && pageRedirect) {
        return new Response(null, { status: 302, headers: { location: pageRedirect } });
      }
      if (target.pathname === '/' || target.pathname.includes('/p/') || target.pathname.includes('/reel/') || target.pathname.includes('/embed/')) {
        return new Response(target.pathname === `/p/${shortcode}/` ? pageHtml : '<html></html>', { headers: { 'content-type': 'text/html' } });
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
  } finally { console.error = originalError; console.warn = originalWarn; }
  return { calls, sent, diagnostics, history: globalThis.history };
}

test('existing mobile resolver authenticates the same reel after anonymous access is rejected', async () => {
  const result = await run();
  const mobile = result.calls.filter(call => call.hostname === 'i.instagram.com' && call.path === `/api/v1/media/${mediaId}/info/`);
  assert.equal(mobile.length, 2);
  assert.equal(mobile[0].headers.get('authorization'), null, 'public fallback stays anonymous');
  assert.match(mobile[1].headers.get('authorization'), /^Bearer IGT:2:/);
  assert.equal(mobile[1].headers.get('x-ig-app-id'), '567067343352427');
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
});

test('a forbidden oEmbed endpoint must not prevent fetching media info from the shortcode', async () => {
  const result = await run({ oembedStatus: 403 });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
  assert.equal(result.calls.filter(call => call.path === '/api/v1/oembed/').length, 0);
});

test('GraphQL shortcode media responses are accepted without the mobile-only wrapper', async () => {
  for (const data of [{ xdt_shortcode_media: video }, { shortcode_media: video },
    { xdt_api__v1__media__shortcode__web_info: { items: [video] } }]) {
    const result = await run({ mobileAllowsAuth: false, graphqlData: { data } });
    assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  }
});

test('public post data is read even when homepage bootstrap redirects to login and LSD is absent', async () => {
  const result = await run({ session: '', mobileAllowsAuth: false, homeRedirect: '/accounts/login/?private=secret',
    pageHtml: `<html><script type="application/json" data-sjs>${JSON.stringify({ data: { item: video } })}</script></html>` });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
});

test('all failed post resolvers report sanitized per-resolver failure causes in the final error', async () => {
  const result = await run({ mobileAllowsAuth: false });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
  const report = result.diagnostics.find(item => item.message === 'instagram download failed')?.info?.detail;
  assert.match(report, /INSTAGRAM_ALL_RESOLVERS_FAILED/);
  assert.match(report, /session\/mobile-api:INSTAGRAM_LOGIN_REQUIRED/);
  assert.match(report, /graphql-web-info:INSTAGRAM_GRAPHQL_ERROR_4630001/);
  assert.doesNotMatch(report, /fixture-session|test-telegram-token/);
});

test('web media info remains available when the native mobile API returns 403', async () => {
  const result = await run({ mobileAllowsAuth: false, mobileStatus: 403, webInfo: video });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  const web = result.calls.find(call => call.hostname === 'www.instagram.com' && call.path === `/api/v1/media/${mediaId}/info/`);
  assert.match(web.headers.get('cookie'), /sessionid=/);
  assert.equal(result.history.at(-1).status, 'success');
});

test('post JSON selects the exact carousel and ignores recommendations', async () => {
  const other = { ...video, code: 'AnotherPost', video_versions: [{ url: 'https://scontent.cdninstagram.com/wrong.mp4' }] };
  const carousel = { code: shortcode, carousel_media: [video, { ...video, video_versions: [{ url: 'https://scontent.cdninstagram.com/second.mp4' }] }] };
  const result = await run({ mobileAllowsAuth: false,
    pageHtml: `<script data-sjs>${JSON.stringify({ recommendations: [other], post: carousel })}</script>` });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 2);
  assert.equal(result.history.at(-1).delivered, 2);
  assert.ok(!result.calls.some(call => call.path === '/wrong.mp4'));
  const absent = await run({ session: '', mobileAllowsAuth: false,
    pageHtml: `<script data-sjs>${JSON.stringify({ recommendations: [other] })}</script>` });
  assert.equal(absent.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.ok(!absent.calls.some(call => call.path === '/wrong.mp4'));
});

test('post OpenGraph video works without JSON, CSRF or LSD tokens', async () => {
  const result = await run({ session: '', mobileAllowsAuth: false,
    pageHtml: '<meta content="https://scontent.cdninstagram.com/video.mp4?a=1&amp;b=2" property="og:video:secure_url">' });
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
});

test('a video cover without video bytes is not delivered as a successful photo download', async () => {
  const cover = { code: shortcode, is_video: true, media_type: 2, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/cover.jpg' }] } };
  const result = await run({ session: '', mobileAllowsAuth: false, graphqlData: { data: { xdt_shortcode_media: cover } },
    pageHtml: `<script data-sjs>${JSON.stringify(cover)}</script>` });
  assert.equal(result.sent.filter(call => ['sendPhoto', 'sendVideo'].includes(call.method)).length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
});

test('ordinary photo posts still deliver as photos', async () => {
  const photo = { code: shortcode, is_video: false, media_type: 1,
    image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/photo.jpg' }] } };
  const result = await run({ session: '', mobileAllowsAuth: false, graphqlData: { data: { xdt_shortcode_media: photo } } });
  assert.equal(result.sent.filter(call => call.method === 'sendPhoto').length, 1);
  assert.equal(result.history.at(-1).status, 'success');
});

test('login and challenge redirects have explicit causes without logging redirect secrets', async () => {
  for (const [path, code] of [['/accounts/login/?next=private-session', 'INSTAGRAM_LOGIN_REQUIRED'], ['/challenge/?secret=private-session', 'INSTAGRAM_CHALLENGE_REQUIRED']]) {
    const result = await run({ mobileAllowsAuth: false, mobileStatus: 403, homeRedirect: path, pageRedirect: path });
    const report = result.diagnostics.find(item => item.message === 'instagram download failed').info.detail;
    assert.match(report, new RegExp(`session/webpage:${code}`));
    assert.match(report, new RegExp(`graphql-web-info:${code}`));
    assert.ok(!JSON.stringify(result.diagnostics).includes('private-session'));
    const message = result.sent.findLast(call => call.method === 'editMessageText').payload.text;
    assert.doesNotMatch(message, /resolver|لاگ/);
    assert.match(message, code === 'INSTAGRAM_CHALLENGE_REQUIRED' ? /تأیید امنیتی/ : /نشست/);
  }
});

test('HTTP 200 access failures are not hidden as EMPTY', async () => {
  for (const [data, code] of [[{ message: 'login_required' }, 'INSTAGRAM_LOGIN_REQUIRED'],
    [{ message: 'challenge_required' }, 'INSTAGRAM_CHALLENGE_REQUIRED'],
    [{ status: 'fail', message: 'feedback_required' }, 'INSTAGRAM_FEEDBACK_REQUIRED']]) {
    const result = await run({ mobileAllowsAuth: false, mobileStatus: 200, mobilePayload: data });
    const report = result.diagnostics.find(item => item.message === 'instagram download failed').info.detail;
    assert.match(report, new RegExp(`session/mobile-api:${code}`));
    assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  }
});

test('non-JSON and network failures preserve safe causes rather than provider responses or secrets', async () => {
  for (const [options, code] of [[{ graphqlRaw: '<html>private-session</html>' }, 'INSTAGRAM_NON_JSON_HTTP_200'],
    [{ graphqlFailure: 'test-telegram-token fixture-session https://private.test/?token=private-session' }, 'INSTAGRAM_NETWORK_ERROR']]) {
    const result = await run({ mobileAllowsAuth: false, ...options });
    const report = result.diagnostics.find(item => item.message === 'instagram download failed').info.detail;
    assert.match(report, new RegExp(`graphql-web-info:${code}`));
    for (const secret of ['private-session', 'fixture-session', 'test-telegram-token', 'private.test']) {
      assert.ok(!JSON.stringify(result.diagnostics).includes(secret));
    }
  }
});

test('a real 429 stops resolver retries instead of multiplying requests', async () => {
  const result = await run({ session: '', mobileAllowsAuth: false, mobileStatus: 429 });
  assert.equal(result.calls.length, 1);
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.equal(result.diagnostics.find(item => item.message === 'instagram download failed').info.detail, 'INSTAGRAM_RATE_LIMIT_429');
});

test('a GraphQL rate limit in an API fail envelope is still treated as rate limiting', async () => {
  const result = await run({ session: '', mobileAllowsAuth: false,
    graphqlData: { status: 'fail', errors: [{ code: 1675004, message: 'Rate limit exceeded' }] } });
  assert.equal(result.diagnostics.find(item => item.message === 'instagram download failed').info.detail, 'INSTAGRAM_RATE_LIMIT_429');
  assert.equal(result.calls.filter(call => call.path === '/graphql/query').length, 1);
});

test('GraphQL rate-limit error carried with HTTP 200 is not disguised as an empty result', async () => {
  const result = await run({ graphqlErrorCode: 1675004 });
  const report = result.diagnostics.find(item => item.message === 'instagram download failed')?.info?.detail;
  assert.equal(report, 'INSTAGRAM_RATE_LIMIT_429');
  assert.equal(result.sent.filter(call => call.method === 'sendVideo').length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
});
