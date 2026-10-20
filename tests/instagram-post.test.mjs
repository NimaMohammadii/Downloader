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
const mediaId = '4011640241882342185';
const pagePath = `/p/${shortcode}/`;
const apiPath = `/api/v1/media/${mediaId}/info/`;
const video = { code: shortcode, video_versions: [{ url: 'https://scontent.cdninstagram.com/video.mp4', width: 1080, height: 1920 }] };
const html = product => `<script data-sjs>${JSON.stringify(product)}</script>`;
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });
const report = result => result.diagnostics.find(item => item.message === 'instagram download failed')?.info?.detail;
const files = result => result.sent.filter(item => ['sendPhoto', 'sendVideo'].includes(item.method));
const errorText = result => result.sent.findLast(item => item.method === 'editMessageText')?.payload.text;

async function run({ session = '12345%3Afixture-session', env = {}, respond } = {}) {
  const calls = [], sent = [], diagnostics = [];
  globalThis.history = [];
  const previous = { error: console.error, warn: console.warn, log: console.log };
  for (const level of Object.keys(previous)) console[level] = (message, info) => diagnostics.push({ message, info });
  try {
    globalThis.fetch = async (url, init = {}) => {
      const target = new URL(typeof url === 'string' ? url : url.url);
      const headers = new Headers(init.headers);
      if (target.hostname === 'api.telegram.org') {
        const method = target.pathname.split('/').at(-1);
        sent.push({ method, payload: JSON.parse(init.body) });
        return Response.json({ ok: true, result: { message_id: 99,
          ...(method === 'sendVideo' ? { video: { file_id: 'video-file-id' } } : {}) } });
      }
      if (target.hostname === 'scontent.cdninstagram.com') return new Response(null, { headers: { 'content-length': '1000000' } });
      const call = { path: target.pathname, url: target, hostname: target.hostname, headers, signal: init.signal };
      calls.push(call);
      const custom = respond?.(call);
      if (custom) return custom;
      if (target.pathname === apiPath) {
        if (target.hostname === 'i.instagram.com' && headers.get('authorization')?.startsWith('Bearer IGT:2:')) {
          return Response.json({ items: [video] });
        }
        return Response.json({}, { status: target.hostname === 'i.instagram.com' ? 403 : 401 });
      }
      if (target.pathname === pagePath) return new Response('<html></html>');
      throw Error('Unmocked endpoint');
    };
    const response = await worker.fetch(new Request('https://worker/telegram/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-webhook' },
      body: JSON.stringify({ update_id: 9, message: { message_id: 8, from: { id: 42 }, chat: { id: 42 },
        text: `https://www.instagram.com/reel/${shortcode}/?mdxt=test` } }),
    }), { BOT_TOKEN: 'test-telegram-token', WEBHOOK_SECRET: 'test-webhook', INSTAGRAM_SESSIONID: session, ...env }, {});
    assert.equal(response.status, 200);
  } finally { Object.assign(console, previous); }
  return { calls, sent, diagnostics, history: globalThis.history };
}

function noObsoleteRequests(result) {
  assert.ok(!result.calls.some(call => /graphql|oembed|embed/.test(call.path) || call.path === '/'));
  assert.ok(result.calls.length <= 5, 'at most two public and three session operations');
}

test('the existing native API remains a bounded fallback with no legacy GraphQL/embed requests', async () => {
  const result = await run();
  assert.equal(files(result).length, 1);
  assert.equal(result.history.at(-1).status, 'success');
  assert.deepEqual(result.calls.map(call => `${call.hostname}:${call.path}`), [
    `i.instagram.com:${apiPath}`, `www.instagram.com:${pagePath}`, `www.instagram.com:${pagePath}`,
    `www.instagram.com:${apiPath}`, `i.instagram.com:${apiPath}`,
  ]);
  assert.equal(result.calls[0].headers.get('authorization'), null);
  assert.match(result.calls.at(-1).headers.get('authorization'), /^Bearer IGT:2:/);
  noObsoleteRequests(result);
});

test('public mobile media sends without authentication or oEmbed', async () => {
  const result = await run({ respond(call) {
    if (call.hostname === 'i.instagram.com') return Response.json({ items: [video] });
  } });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].headers.get('cookie'), null);
  assert.equal(files(result).length, 1);
});

test('canonical redirects follow only the same requested reel', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return redirect(`/reel/${shortcode}/`);
    if (call.path === `/reel/${shortcode}/`) return new Response(html(video));
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.at(-1).path, `/reel/${shortcode}/`);
  noObsoleteRequests(result);
});

test('a canonical redirect retains response cookies and updates the following request', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return redirect(`https://instagram.com/reel/${shortcode}/`, { 'set-cookie': 'mid=fresh-mid; Path=/' });
    if (call.path === `/reel/${shortcode}/`) {
      assert.match(call.headers.get('cookie'), /mid=fresh-mid/);
      return new Response(html(video));
    }
  } });
  assert.equal(files(result).length, 1);
});

test('session CSRF from the page reaches the media request instead of being lost in a jar clone', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) {
      return new Response('<html></html>', { headers: { 'set-cookie': 'csrftoken=fresh-csrf; Path=/' } });
    }
    if (call.path === apiPath && call.hostname === 'www.instagram.com') {
      assert.equal(call.headers.get('x-csrftoken'), 'fresh-csrf');
      assert.match(call.headers.get('cookie'), /csrftoken=fresh-csrf/);
      return Response.json({ items: [video] });
    }
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 4);
});

test('a fresh HTML CSRF token replaces the stale configured value in both cookie and header', async () => {
  const result = await run({ env: { INSTAGRAM_CSRFTOKEN: 'stale-csrf' }, respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) {
      return new Response('<script>{"csrf_token":"html-csrf"}</script>');
    }
    if (call.path === apiPath && call.hostname === 'www.instagram.com') {
      assert.equal(call.headers.get('x-csrftoken'), 'html-csrf');
      assert.match(call.headers.get('cookie'), /csrftoken=html-csrf/);
      assert.ok(!call.headers.get('cookie').includes('stale-csrf'));
      return Response.json({ items: [video] });
    }
  } });
  assert.equal(files(result).length, 1);
  const webRequest = result.calls.find(call => call.hostname === 'www.instagram.com' && call.path === apiPath);
  assert.equal(webRequest.headers.get('x-csrftoken'), 'html-csrf');
  assert.match(webRequest.headers.get('cookie'), /csrftoken=html-csrf/);
  assert.equal(result.calls.length, 4);
});

test('anonymous cookies never become part of the configured account session', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath && !call.headers.get('cookie')?.includes('sessionid=')) {
      return new Response('<html></html>', { headers: { 'set-cookie': 'mid=anonymous-mid; Path=/' } });
    }
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) {
      assert.ok(!call.headers.get('cookie').includes('anonymous-mid'));
    }
  } });
  assert.equal(files(result).length, 1);
  const authenticated = result.calls.filter(call => call.headers.get('cookie')?.includes('sessionid='));
  assert.ok(authenticated.length > 0);
  assert.ok(authenticated.every(call => !call.headers.get('cookie').includes('anonymous-mid')));
});

test('explicit session login, challenge or consent redirects stop without retrying rejected endpoints', async () => {
  for (const [path, code, text] of [
    ['/accounts/login/?private=redirect-secret', 'LOGIN_REQUIRED', /نشست/],
    ['/challenge/?private=redirect-secret', 'CHALLENGE_REQUIRED', /تأیید امنیتی/],
    ['/consent/?private=redirect-secret', 'CONSENT_REQUIRED', /پذیرش شرایط/],
  ]) {
    const result = await run({ respond(call) {
      if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return redirect(path);
    } });
    assert.match(report(result), new RegExp(`^INSTAGRAM_SESSION_${code}`));
    assert.equal(result.calls.length, 3);
    assert.equal(files(result).length, 0);
    assert.match(errorText(result), text);
    assert.ok(!JSON.stringify(result.diagnostics).includes('redirect-secret'));
    noObsoleteRequests(result);
  }
});

test('a home or generic account redirect must not claim consent or block the existing media APIs', async () => {
  for (const destination of ['/?secret=redirect-secret', '/accounts/onetap/?secret=redirect-secret', '/accounts/unknown/?secret=redirect-secret']) {
    for (const webWorks of [true, false]) {
      const result = await run({ respond(call) {
        if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return redirect(destination);
        if (webWorks && call.path === apiPath && call.hostname === 'www.instagram.com') return Response.json({ items: [video] });
      } });
      assert.equal(files(result).length, 1, `${destination}: the supported API is still accessible`);
      assert.equal(result.calls.length, webWorks ? 4 : 5);
      assert.equal(result.history.at(-1).status, 'success');
      assert.ok(!JSON.stringify(result.sent).includes('پذیرش شرایط'));
      assert.ok(!JSON.stringify(result.diagnostics).includes('redirect-secret'));
      noObsoleteRequests(result);
    }
  }
});

test('non-2xx API JSON preserves the specific security or login rejection', async () => {
  for (const [payload, status, code] of [
    [{ message: 'challenge_required', challenge: {} }, 400, 'SESSION_CHALLENGE_REQUIRED'],
    [{ message: 'consent_required' }, 403, 'SESSION_CONSENT_REQUIRED'],
    [{ message: 'session_expired' }, 403, 'SESSION_LOGIN_REQUIRED'],
  ]) {
    const result = await run({ respond(call) {
      if (call.path === apiPath && call.headers.get('cookie')?.includes('sessionid=')) return Response.json(payload, { status });
    } });
    assert.match(report(result), new RegExp(`^INSTAGRAM_${code}`));
    assert.equal(files(result).length, 0);
    noObsoleteRequests(result);
  }
});

test('HTTP 200 login forms are classified without mistaking a normal login link for rejection', async () => {
  const rejected = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<form id="loginForm" action="/accounts/login/"></form>');
  } });
  assert.match(report(rejected), /^INSTAGRAM_SESSION_LOGIN_REQUIRED/);
  assert.equal(rejected.calls.length, 3);
  const accessible = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response('<a href="/accounts/login/">Log in</a>' + html(video));
  } });
  assert.equal(files(accessible).length, 1);
});

test('public page data needs no homepage bootstrap, LSD or fixed GraphQL document', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response(html({ data: { item: video } }));
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 2);
  noObsoleteRequests(result);
});

test('post JSON matches the exact carousel and never a recommendation', async () => {
  const other = { ...video, code: 'AnotherPost', video_versions: [{ url: 'https://scontent.cdninstagram.com/wrong.mp4' }] };
  const carousel = { code: shortcode, carousel_media: [video, { ...video, video_versions: [{ url: 'https://scontent.cdninstagram.com/second.mp4' }] }] };
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response(html({ recommendations: [other], post: carousel }));
  } });
  assert.equal(files(result).length, 2);
  assert.deepEqual(files(result).map(item => new URL(item.payload.video).searchParams.get('src')), [
    'https://scontent.cdninstagram.com/video.mp4', 'https://scontent.cdninstagram.com/second.mp4',
  ]);
  const absent = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response(html({ recommendations: [other] }));
  } });
  assert.equal(files(absent).length, 0);
});

test('OpenGraph metadata and ordinary photo posts still resolve without the removed paths', async () => {
  for (const [page, method] of [
    ['<meta content="https://scontent.cdninstagram.com/video.mp4?a=1&amp;b=2" property="og:video:secure_url">', 'sendVideo'],
    [html({ code: shortcode, media_type: 1, image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/photo.jpg' }] } }), 'sendPhoto'],
  ]) {
    const result = await run({ session: '', respond(call) { if (call.path === pagePath) return new Response(page); } });
    assert.equal(files(result).length, 1);
    assert.equal(files(result)[0].method, method);
  }
});

test('a video cover is not substituted for missing video bytes', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response(html({ code: shortcode, media_type: 2, is_video: true,
      image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/cover.jpg' }] } }));
  } });
  assert.equal(files(result).length, 0);
  assert.equal(result.history.at(-1).status, 'failed');
});

test('rate-limit responses stop immediately, including feedback errors with HTTP 400', async () => {
  for (const [status, payload] of [[429, {}], [400, { message: 'feedback_required' }], [200, { message: 'Please wait a few minutes' }]]) {
    const result = await run({ respond() { return Response.json(payload, { status }); } });
    assert.match(report(result), /^INSTAGRAM_RATE_LIMIT_429/);
    assert.equal(result.calls.length, 1);
    assert.equal(files(result).length, 0);
  }
});

test('redirect loops are bounded and unsafe or unrelated destinations are never requested', async () => {
  for (const [location, code] of [
    [pagePath, 'LOOP'], ['https://attacker.test/private?secret=hidden', 'UNSAFE'],
    [`http://www.instagram.com/reel/${shortcode}/`, 'UNSAFE'],
    [`https://user:password@www.instagram.com/reel/${shortcode}/`, 'UNSAFE'],
    [`https://www.instagram.com:444/reel/${shortcode}/`, 'UNSAFE'],
    ['/reel/AnotherPost/', 'UNSUPPORTED'], ['/unknown/?secret=hidden', 'UNSUPPORTED'],
  ]) {
    const result = await run({ session: '', respond(call) { if (call.path === pagePath) return redirect(location); } });
    assert.match(report(result), new RegExp(`INSTAGRAM_REDIRECT_${code}`));
    assert.equal(result.calls.length, 2);
    assert.equal(files(result).length, 0);
    assert.ok(!JSON.stringify(result.diagnostics).includes('hidden'));
    assert.ok(!JSON.stringify(result.diagnostics).includes('password'));
  }
});

test('a chain of distinct canonical redirects is bounded by the existing request transport', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return redirect(`/reel/${shortcode}/?step=1`);
    if (call.path.startsWith('/reel/')) return redirect(`/reel/${shortcode}/?step=${Number(call.url.searchParams.get('step')) + 1}`);
  } });
  assert.match(report(result), /INSTAGRAM_REDIRECT_LIMIT/);
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.every(call => call.signal instanceof AbortSignal));
});

test('non-JSON and network diagnostics never contain response bodies, cookies or credential URLs', async () => {
  for (const network of [false, true]) {
    const result = await run({ session: '', respond(call) {
      if (network) throw Error('test-telegram-token fixture-session https://private.test/?secret=hidden');
      if (call.path === apiPath) return new Response('<html>fixture-session hidden</html>');
    } });
    assert.match(report(result), network ? /INSTAGRAM_NETWORK_ERROR/ : /INSTAGRAM_NON_JSON_HTTP_200/);
    for (const value of ['fixture-session', 'test-telegram-token', 'private.test', 'hidden']) assert.ok(!JSON.stringify(result.diagnostics).includes(value));
    noObsoleteRequests(result);
  }
});

function sessionResponse(cookies, mode, location = '/') {
  const response = redirect(location);
  // Match Workers' Set-Cookie API and runtimes that expose one combined field.
  Object.defineProperty(response.headers, 'getSetCookie', { value: undefined });
  if (mode === 'workers') {
    Object.defineProperty(response.headers, 'getAll', { value: name => {
      assert.equal(name.toLowerCase(), 'set-cookie');
      return cookies;
    } });
    const originalGet = response.headers.get.bind(response.headers);
    response.headers.get = name => name.toLowerCase() === 'set-cookie' ? cookies[0] : originalGet(name);
  } else {
    response.headers.set('set-cookie', cookies.join(', '));
  }
  return response;
}

test('session rotation survives the reported home redirect and reaches media info on Workers', async () => {
  for (const mode of ['workers', 'combined']) {
    const cookies = [
      'csrftoken=fresh-csrf; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/',
      'sessionid=12345%3Arenewed-session; Path=/; Secure; HttpOnly',
      'ds_user_id=12345; Path=/',
    ];
    const result = await run({ respond(call) {
      if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse(cookies, mode);
      if (call.path === apiPath) {
        if (call.hostname === 'www.instagram.com' && call.headers.get('cookie')?.includes('sessionid=12345%3Arenewed-session')) {
          assert.equal(call.headers.get('x-csrftoken'), 'fresh-csrf');
          assert.match(call.headers.get('cookie'), /ds_user_id=12345/);
          return Response.json({ items: [video] });
        }
        return Response.json({ message: 'login_required' }, { status: 401 });
      }
    } });
    assert.equal(files(result).length, 1, mode);
    assert.equal(result.calls.length, 4);
    assert.equal(result.history.at(-1).status, 'success');
    for (const secret of ['renewed-session', 'fresh-csrf']) assert.ok(!JSON.stringify(result.diagnostics).includes(secret));
  }
});

test('all valid response cookies survive combined fields without turning attributes into cookies', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
      'csrftoken=fresh-csrf; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/',
      'sessionid=12345%3Arenewed-session; Path=/; HttpOnly',
      'ds_user_id=12345; Path=/', 'ig_nrcb=1; Path=/',
    ], 'combined');
    if (call.path === apiPath && call.hostname === 'www.instagram.com') {
      const cookie = call.headers.get('cookie');
      assert.match(cookie, /sessionid=12345%3Arenewed-session/);
      assert.match(cookie, /ds_user_id=12345/);
      assert.match(cookie, /ig_nrcb=1/);
      assert.ok(!/Expires=|Path=|GMT/.test(cookie));
      return Response.json({ items: [video] });
    }
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 4);
});

test('deleted cookies are removed and Max-Age takes precedence over Expires', async () => {
  for (const expired of ['Max-Age=0', 'Max-Age=-1', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']) {
    const result = await run({ env: { INSTAGRAM_CSRFTOKEN:'old-csrf', INSTAGRAM_MID:'old-mid' }, respond(call) {
      if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
        `csrftoken=old-csrf; ${expired}; Path=/`,
        'mid=; Max-Age=0; Path=/',
        'ig_did=fresh-device; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
      ], 'combined');
      if (call.path === apiPath && call.hostname === 'www.instagram.com') {
        const cookie = call.headers.get('cookie');
        assert.equal(call.headers.get('x-csrftoken'), null);
        assert.ok(!cookie.includes('csrftoken='));
        assert.ok(!/(?:^|; )mid=/.test(cookie));
        assert.match(cookie, /ig_did=fresh-device/);
        return Response.json({ items: [video] });
      }
    } });
    assert.equal(files(result).length, 1, expired);
    assert.equal(result.calls.length, 4, expired);
  }
});

test('an explicitly cleared session stops before retrying more endpoints with rejected credentials', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
      'csrftoken=fresh-csrf; Path=/', 'sessionid=; Max-Age=0; Path=/',
    ], 'workers');
  } });
  assert.equal(result.calls.length, 3);
  assert.equal(files(result).length, 0);
  assert.match(report(result), /^INSTAGRAM_SESSION_LOGIN_REQUIRED/);
  assert.ok(!result.calls.some(call => call.hostname === 'www.instagram.com' && call.path === apiPath));
  assert.ok(!JSON.stringify(result.diagnostics).includes('fresh-csrf'));
});

test('rotated cookies remain isolated from the next independent download request', async () => {
  await run({ respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
      'sessionid=12345%3Arenewed-session; Path=/', 'csrftoken=fresh-csrf; Path=/',
    ], 'workers');
  } });
  const next = await run();
  const authenticated = next.calls.find(call => call.path === pagePath && call.headers.get('cookie')?.includes('sessionid='));
  assert.match(authenticated.headers.get('cookie'), /sessionid=12345%3Afixture-session/);
  assert.ok(!authenticated.headers.get('cookie').includes('renewed-session'));
});
