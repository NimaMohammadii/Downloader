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

async function run({ session = '12345%3Afixture-session', env = {}, respond, telegramRespond, nativeAllowsAuth = true,
  text = `https://www.instagram.com/reel/${shortcode}/?mdxt=test` } = {}) {
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
        const custom = telegramRespond?.(sent.at(-1));
        if (custom) return custom;
        return Response.json({ ok: true, result: { message_id: 99,
          ...(method === 'sendVideo' ? { video: { file_id: 'video-file-id' } } : {}) } });
      }
      if (target.hostname === 'scontent.cdninstagram.com') return new Response(null, { headers: { 'content-length': '1000000' } });
      const call = { path: target.pathname, url: target, hostname: target.hostname, headers, signal: init.signal,
        method: init.method || 'GET', body: init.body };
      calls.push(call);
      const custom = respond?.(call);
      if (custom) return custom;
      if (target.pathname === apiPath) {
        if (nativeAllowsAuth && target.hostname === 'i.instagram.com' && headers.get('authorization')?.startsWith('Bearer IGT:2:')) {
          return Response.json({ items: [video] });
        }
        return Response.json({}, { status: target.hostname === 'i.instagram.com' ? 403 : 401 });
      }
      if (target.pathname === pagePath) return new Response('<html></html>');
      if (target.pathname === '/graphql/query') return Response.json({ data: {
        xdt_api__v1__media__shortcode__web_info: { items: [] },
      } });
      throw Error('Unmocked endpoint');
    };
    const response = await worker.fetch(new Request('https://worker/telegram/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-webhook' },
      body: JSON.stringify({ update_id: 9, message: { message_id: 8, from: { id: 42 }, chat: { id: 42 },
        text } }),
    }), { BOT_TOKEN: 'test-telegram-token', WEBHOOK_SECRET: 'test-webhook', INSTAGRAM_SESSIONID: session, ...env }, {});
    assert.equal(response.status, 200);
  } finally { Object.assign(console, previous); }
  return { calls, sent, diagnostics, history: globalThis.history };
}

function noObsoleteRequests(result) {
  assert.ok(!result.calls.some(call => /oembed|embed/.test(call.path) || call.path === '/'));
  assert.ok(result.calls.length <= 7, 'each page may issue one shortcode web-info query');
}

test('the connected account uses the existing native API without unnecessary public probes', async () => {
  const result = await run();
  assert.equal(files(result).length, 1);
  assert.equal(result.history.at(-1).status, 'success');
  assert.deepEqual(result.calls.map(call => `${call.hostname}:${call.path}`), [
    `i.instagram.com:${apiPath}`,
  ]);
  assert.match(result.calls[0].headers.get('authorization'), /^Bearer IGT:2:/);
  noObsoleteRequests(result);
});

test('public mobile media sends without authentication or oEmbed', async () => {
  const result = await run({ session: '', respond(call) {
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
  const result = await run({ nativeAllowsAuth: false, respond(call) {
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
  const result = await run({ nativeAllowsAuth: false, env: { INSTAGRAM_CSRFTOKEN: 'stale-csrf' }, respond(call) {
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

test('public fallback and account requests never share their cookie jars', async () => {
  const result = await run({ nativeAllowsAuth: false, respond(call) {
    if (call.path === pagePath && !call.headers.get('cookie')?.includes('sessionid=')) {
      assert.ok(!call.headers.get('cookie')?.includes('account-csrf'));
      return new Response(html(video), { headers: { 'set-cookie': 'mid=anonymous-mid; Path=/' } });
    }
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) {
      assert.ok(!call.headers.get('cookie').includes('anonymous-mid'));
      return new Response('<html></html>', { headers: { 'set-cookie': 'csrftoken=account-csrf; Path=/' } });
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
    const result = await run({ nativeAllowsAuth: false, respond(call) {
      if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return redirect(path);
    } });
    assert.match(report(result), new RegExp(`^INSTAGRAM_SESSION_${code}`));
    assert.equal(result.calls.length, code === 'LOGIN_REQUIRED' ? 4 : 2);
    assert.ok(!result.calls.some(call => call.hostname === 'www.instagram.com' && call.path === apiPath));
    assert.equal(files(result).length, 0);
    assert.match(errorText(result), text);
    assert.ok(!JSON.stringify(result.diagnostics).includes('redirect-secret'));
    noObsoleteRequests(result);
  }
});

test('a home or generic account redirect must not claim consent or block the existing media APIs', async () => {
  for (const destination of ['/?secret=redirect-secret', '/accounts/onetap/?secret=redirect-secret', '/accounts/unknown/?secret=redirect-secret']) {
    const result = await run({ nativeAllowsAuth: false, respond(call) {
      if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return redirect(destination);
      if (call.path === apiPath && call.hostname === 'www.instagram.com') return Response.json({ items: [video] });
    } });
    assert.equal(files(result).length, 1, `${destination}: the supported API is still accessible`);
    assert.equal(result.calls.length, 3);
    assert.equal(result.history.at(-1).status, 'success');
    assert.ok(!JSON.stringify(result.sent).includes('پذیرش شرایط'));
    assert.ok(!JSON.stringify(result.diagnostics).includes('redirect-secret'));
    noObsoleteRequests(result);
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
  const rejected = await run({ nativeAllowsAuth: false, respond(call) {
    if (call.path === pagePath) return new Response('<form id="loginForm" action="/accounts/login/"></form>');
  } });
  assert.match(report(rejected), /^INSTAGRAM_SESSION_LOGIN_REQUIRED/);
  assert.equal(rejected.calls.length, 4);
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

test('rate-limit responses stop immediately', async () => {
  for (const [status, payload] of [[429, {}], [200, { message: 'Please wait a few minutes' }]]) {
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
    assert.equal(result.calls.length, 3);
    assert.equal(result.history.at(-1).status, 'success');
    for (const secret of ['renewed-session', 'fresh-csrf']) assert.ok(!JSON.stringify(result.diagnostics).includes(secret));
  }
});

test('all valid response cookies survive combined fields without turning attributes into cookies', async () => {
  const result = await run({ nativeAllowsAuth: false, respond(call) {
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
  assert.equal(result.calls.length, 3);
});

test('deleted cookies are removed and Max-Age takes precedence over Expires', async () => {
  for (const expired of ['Max-Age=0', 'Max-Age=-1', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']) {
    const result = await run({ nativeAllowsAuth: false, env: { INSTAGRAM_CSRFTOKEN:'old-csrf', INSTAGRAM_MID:'old-mid' }, respond(call) {
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
    assert.equal(result.calls.length, 3, expired);
  }
});

test('an explicitly cleared session stops before retrying more endpoints with rejected credentials', async () => {
  const result = await run({ nativeAllowsAuth: false, respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
      'csrftoken=fresh-csrf; Path=/', 'sessionid=; Max-Age=0; Path=/',
    ], 'workers');
  } });
  assert.equal(result.calls.length, 4);
  assert.equal(files(result).length, 0);
  assert.match(report(result), /^INSTAGRAM_SESSION_LOGIN_REQUIRED/);
  assert.ok(!result.calls.some(call => call.hostname === 'www.instagram.com' && call.path === apiPath));
  assert.ok(!JSON.stringify(result.diagnostics).includes('fresh-csrf'));
});

test('rotated cookies remain isolated from the next independent download request', async () => {
  await run({ nativeAllowsAuth: false, respond(call) {
    if (call.path === pagePath && call.headers.get('cookie')?.includes('sessionid=')) return sessionResponse([
      'sessionid=12345%3Arenewed-session; Path=/', 'csrftoken=fresh-csrf; Path=/',
    ], 'workers');
  } });
  const next = await run();
  const authenticated = next.calls.find(call => call.headers.get('cookie')?.includes('sessionid='));
  assert.match(authenticated.headers.get('cookie'), /sessionid=12345%3Afixture-session/);
  assert.ok(!authenticated.headers.get('cookie').includes('renewed-session'));
});

test('public web-info GraphQL resolves the observed login-only API and metadata-free page regression', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === apiPath) return redirect('https://i.instagram.com/accounts/login/');
    if (call.path === pagePath) return new Response('<script>["LSD",[],{"token":"page-lsd"}]</script>', {
      headers: { 'set-cookie': 'csrftoken=page-csrf; Path=/; Secure' },
    });
    if (call.path === '/graphql/query') return Response.json({ data: {
      xdt_api__v1__media__shortcode__web_info: { items: [video] },
    }, status: 'ok' });
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.history.at(-1).status, 'success');
  assert.equal(result.calls.length, 3, 'reuse the requested page; no homepage/bootstrap retry');
  const graphql = result.calls.at(-1);
  assert.equal(graphql.hostname, 'www.instagram.com');
  assert.equal(graphql.path, '/graphql/query');
  assert.equal(graphql.method, 'POST');
  const params = new URLSearchParams(graphql.body);
  assert.equal(params.get('doc_id'), '27128499623469141');
  assert.equal(JSON.parse(params.get('variables')).shortcode, shortcode);
  assert.equal(graphql.headers.get('x-csrftoken'), 'page-csrf');
  assert.equal(graphql.headers.get('x-fb-lsd'), 'page-lsd');
  assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));
  assert.ok(!JSON.stringify(result.diagnostics).includes('page-csrf'));
});

test('session web-info uses refreshed page state and keeps anonymous cookies separate', async () => {
  const result = await run({ nativeAllowsAuth: false, env: { INSTAGRAM_CSRFTOKEN: 'stale-csrf' }, respond(call) {
    const authenticated = call.headers.get('cookie')?.includes('sessionid=');
    if (call.path === pagePath) return new Response('<html></html>', {
      headers: { 'set-cookie': `csrftoken=${authenticated ? 'account' : 'anonymous'}-csrf; Path=/` },
    });
    if (call.path === '/graphql/query') return Response.json({ data: {
      xdt_api__v1__media__shortcode__web_info: { items: authenticated ? [video] : [] },
    } });
  } });
  assert.equal(files(result).length, 1);
  const graphql = result.calls.filter(call => call.path === '/graphql/query');
  assert.equal(graphql.length, 1);
  assert.equal(graphql[0].headers.get('x-csrftoken'), 'account-csrf');
  assert.ok(!graphql[0].headers.get('cookie').includes('anonymous-csrf'));
  assert.equal(result.calls.length, 3);
});

test('anonymous web-info cannot substitute another post and classifies GraphQL rate limits', async () => {
  for (const limited of [false, true]) {
    const result = await run({ session: '', respond(call) {
      if (call.path === pagePath) return new Response('<script>{"csrf_token":"page-csrf"}</script>');
      if (call.path === '/graphql/query') return Response.json(limited
        ? { data: null, errors: [{ code: 1675004, message: 'Rate limit exceeded' }] }
        : { data: { xdt_api__v1__media__shortcode__web_info: { items: [{ ...video, code: 'AnotherPost' }] } } });
    } });
    assert.equal(result.calls.length, 3);
    assert.equal(files(result).length, 0);
    assert.match(report(result), limited ? /^INSTAGRAM_RATE_LIMIT_429/ : /^INSTAGRAM_POST_UNAVAILABLE/);
    assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));
  }
});

test('the reported public-phase failure retains its actual HTTP status, endpoint and Retry-After', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === apiPath) return Response.json({ message: 'login_required' }, { status: 401 });
    if (call.path === pagePath) return new Response(null, { status: 429, headers: { 'retry-after': '1158' } });
  } });
  assert.match(report(result), /^INSTAGRAM_RATE_LIMIT_429 \[public\/mobile-api:INSTAGRAM_LOGIN_REQUIRED,public\/webpage:INSTAGRAM_RATE_LIMIT_429\]/);
  assert.deepEqual(result.diagnostics.find(x => x.message === 'instagram download failed').info.throttle, {
    source: 'http', httpStatus: 429, endpoint: pagePath, retryAfterSeconds: 1158,
  });
  assert.equal(result.calls.length, 2);
  assert.equal(files(result).length, 0);
  assert.match(errorText(result), /1158/);
});

test('a GraphQL throttle with HTTP 200 is distinguishable from a server HTTP 429', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response('<script>{"csrf_token":"csrf-secret"}</script>');
    if (call.path === '/graphql/query') return Response.json({ data: null,
      errors: [{ code: 1675004, message: 'Rate limit exceeded csrf-secret' }] });
  } });
  const throttle = result.diagnostics.find(x => x.message === 'instagram download failed').info.throttle;
  assert.deepEqual(throttle, { source: 'graphql', httpStatus: 200, endpoint: '/graphql/query', graphqlCode: 1675004 });
  assert.equal(result.calls.length, 3);
  assert.ok(!JSON.stringify(result.diagnostics).includes('csrf-secret'));
  assert.ok(!errorText(result).includes('این سرور'));
});

test('Retry-After dates are read without inventing a delay for missing or malformed headers', async () => {
  for (const value of [undefined, 'invalid', '1.5', new Date(Date.now() + 120_000).toUTCString()]) {
    const result = await run({ respond() {
      return new Response(null, { status: 429, headers: value ? { 'retry-after': value } : {} });
    } });
    const throttle = result.diagnostics.find(x => x.message === 'instagram download failed').info.throttle;
    if (value?.endsWith('GMT')) assert.ok(throttle.retryAfterSeconds >= 118 && throttle.retryAfterSeconds <= 120);
    else assert.equal(throttle.retryAfterSeconds, undefined);
    assert.equal(result.calls.length, 1);
  }
});

test('feedback_required stops requests without claiming an HTTP 429 or an IP restriction', async () => {
  const result = await run({ respond() { return Response.json({ message: 'feedback_required' }, { status: 400 }); } });
  assert.match(report(result), /^INSTAGRAM_FEEDBACK_REQUIRED/);
  assert.equal(result.calls.length, 1);
  assert.equal(files(result).length, 0);
  assert.ok(!errorText(result).includes('429'));
});

test('a kicked bot acknowledges start, unrelated text and Instagram requests without another delivery attempt', async () => {
  for (const text of ['/start', 'hello', `https://www.instagram.com/reel/${shortcode}/`]) {
    const result = await run({ text, telegramRespond() { return Response.json({ ok: false, error_code: 403,
      description: 'Forbidden: bot was kicked from the supergroup chat' }, { status: 403 }); } });
    assert.equal(result.sent.length, 1);
    assert.equal(result.calls.length, 0);
    assert.ok(result.diagnostics.some(x => x.message === 'telegram chat unavailable'));
    assert.ok(!result.diagnostics.some(x => x.message === 'instagram download failed'));
  }
});

test('kicked errors during media delivery stop without sending an error back to the inaccessible chat', async () => {
  const result = await run({ telegramRespond(call) {
    if (call.method === 'sendVideo') return Response.json({ ok: false, error_code: 403,
      description: 'Forbidden: bot was kicked from the supergroup chat' }, { status: 403 });
  } });
  assert.deepEqual(result.sent.map(x => x.method), ['sendMessage', 'sendVideo']);
  assert.equal(result.history.at(-1).status, 'failed');
});

test('temporary Telegram failures and invalid bot credentials are not silently acknowledged as kicked chats', async () => {
  for (const status of [401, 500]) await assert.rejects(() => run({ text: '/start', telegramRespond() {
    return Response.json({ ok: false, error_code: status,
      description: 'Forbidden: bot was kicked from the supergroup chat' }, { status });
  } }), /bot was kicked/);
});

test('a healthy connected account resolves before the reported anonymous LOGIN_REQUIRED/429 path', async () => {
  const result = await run({ respond(call) {
    if (call.hostname === 'i.instagram.com' && call.path === apiPath) {
      return call.headers.get('authorization')?.startsWith('Bearer IGT:2:')
        ? Response.json({ items: [video] })
        : Response.json({ message: 'login_required' }, { status: 401 });
    }
    if (!call.headers.get('cookie')?.includes('sessionid=')) return new Response(null, { status: 429 });
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 1, 'do not send anonymous probes when authenticated media is available');
  assert.match(result.calls[0].headers.get('authorization'), /^Bearer IGT:2:/);
  assert.equal(result.history.at(-1).status, 'success');
});

test('a browser session can resolve web media before anonymous throttling when the native API requires login', async () => {
  const result = await run({ respond(call) {
    const authenticated = call.headers.get('cookie')?.includes('sessionid=');
    if (!authenticated) return call.path === apiPath
      ? Response.json({ message: 'login_required' }, { status: 401 })
      : new Response(null, { status: 429 });
    if (call.hostname === 'i.instagram.com') return Response.json({ message: 'login_required' }, { status: 401 });
    if (call.path === pagePath) return new Response('<script>{"csrf_token":"fresh-csrf"}</script>');
    if (call.path === apiPath) return Response.json({ items: [video] });
  } });
  assert.equal(files(result).length, 1);
  assert.ok(result.calls.every(call => call.headers.get('cookie')?.includes('sessionid=')));
  const media = result.calls.find(call => call.hostname === 'www.instagram.com' && call.path === apiPath);
  assert.equal(media.headers.get('x-csrftoken'), 'fresh-csrf');
});

test('an explicitly rejected session is not reused while an accessible public post can still download', async () => {
  const result = await run({ respond(call) {
    if (call.headers.get('cookie')?.includes('sessionid=')) return call.path === apiPath
      ? Response.json({ message: 'login_required' }, { status: 401 })
      : redirect('/accounts/login/');
    if (call.path === apiPath) return Response.json({ items: [video] });
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 3);
  assert.equal(result.calls.at(-1).headers.get('authorization'), null);
  assert.equal(result.calls.at(-1).headers.get('cookie'), null);
  assert.ok(!result.calls.some(call => call.hostname === 'www.instagram.com' && call.path === apiPath));
});

test('an authenticated throttle stops immediately even if an anonymous endpoint would return media', async () => {
  const result = await run({ respond(call) {
    return call.headers.get('cookie')?.includes('sessionid=')
      ? new Response(null, { status: 429, headers: { 'retry-after': '120' } })
      : Response.json({ items: [video] });
  } });
  assert.equal(files(result).length, 0);
  assert.equal(result.calls.length, 1);
  assert.match(report(result), /session\/mobile-api:INSTAGRAM_RATE_LIMIT_429/);
  assert.match(errorText(result), /120/);
});
