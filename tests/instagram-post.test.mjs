import { build } from 'esbuild';
import assert from 'node:assert/strict';
import test from 'node:test';

const { outputFiles } = await build({
  entryPoints: ['src/index.ts'], bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'instagram-post-bindings', setup(build) {
    build.onResolve({ filter: /^\.\/admin$/ }, args => ({ path: args.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export const recordUsage=async()=>true; export const recordMediaDelivery=async()=>{}; export const telegramCustomEmoji = (_method, payload) => payload;
      export const telegramTextMotion = async () => {};
      export const telegramFileCache = async () => null;
      export const recordDownload = async (_env, value) => { (globalThis.history ||= []).push(value); };
      export const recordSuccessfulDelivery = async () => {};
    ` }));
  } }],
});
const { default: worker, instagramProfilePage, instagramProfilePostMedia, instagramProfileErrorText } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

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

test('profile pagination uses the maintained authenticated web query and preserves carousel order', async () => {
  const requests=[];
  const photo={media_type:1,image_versions2:{candidates:[{url:'https://scontent.cdninstagram.com/photo.jpg',width:100,height:100}]}};
  const movie={media_type:2,video_versions:video.video_versions};
  globalThis.fetch=async(url,init)=>{
    const query=new URLSearchParams(init.body);const variables=JSON.parse(query.get('variables'));
    requests.push({url,variables,headers:new Headers(init.headers)});
    assert.equal(query.get('doc_id'),'28975909992013618');
    return Response.json({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{
      edges:variables.after ? [] : [{node:{code:shortcode,carousel_media:[photo,movie]}}],
      page_info:{has_next_page:!variables.after,end_cursor:variables.after?null:'next-page'},
    }}});
  };
  const env={BOT_TOKEN:'fake',INSTAGRAM_SESSIONID:'12345%3Afixture-session'};
  const first=await instagramProfilePage('example',null,env);
  assert.equal(first.next,'next-page');
  assert.deepEqual(first.posts[0].groups.map(g=>g[0].kind),['photo','video']);
  assert.equal(first.posts[0].shortcode,shortcode);
  assert.ok(!JSON.stringify(first).includes('fixture-session'));
  const second=await instagramProfilePage('example',first.next,env);
  assert.equal(second.next,null);
  assert.equal(requests[1].variables.after,'next-page');
  assert.equal(requests[0].variables.username,'example');
  assert.match(requests[0].headers.get('cookie'),/sessionid=/);
});

test('profile lookup stops on challenges and throttles without trying more account endpoints', async () => {
  for (const [body,status,pattern] of [[{message:'challenge_required'},400,/تأیید امنیتی/],
    [{message:'feedback_required'},400,/محدودیت فعالیت/],[{},429,/محدود/]]) {
    let requests=0;
    globalThis.fetch=async()=>{requests++;return Response.json(body,{status});};
    await assert.rejects(()=>instagramProfilePage('example',null,{BOT_TOKEN:'fake',INSTAGRAM_SESSIONID:'session'}),error=>{
      assert.match(instagramProfileErrorText(error),pattern);return true;
    });
    assert.equal(requests,1);
  }
});

test('profile lookup rejects missing sessions, invalid pages and non-advancing pagination', async () => {
  globalThis.fetch=async()=>{throw Error('must not request');};
  await assert.rejects(()=>instagramProfilePage('example',null,{BOT_TOKEN:'fake'}),/LOGIN_REQUIRED/);
  globalThis.fetch=async()=>Response.json({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:[],
    page_info:{has_next_page:true,end_cursor:'same'}}}});
  await assert.rejects(()=>instagramProfilePage('example','same',{BOT_TOKEN:'fake',INSTAGRAM_SESSIONID:'session'}),/PAGINATION/);
  globalThis.fetch=async()=>Response.json({data:{}});
  await assert.rejects(()=>instagramProfilePage('example',null,{BOT_TOKEN:'fake',INSTAGRAM_SESSIONID:'session'}),/UNAVAILABLE/);
});

test('profile media keeps large videos on the existing complete-file uploader and never treats covers as videos', async () => {
  globalThis.fetch=async()=>new Response(null,{headers:{'content-length':'120000000'}});
  const media=await instagramProfilePostMedia({shortcode,url:'https://instagram.com/p/'+shortcode+'/',
    groups:[[{kind:'video',url:video.video_versions[0].url,width:1080,height:1920}]]},{BOT_TOKEN:'fake'});
  assert.equal(media[0].size,120000000);
  assert.equal(media[0].kind,'video');
  globalThis.fetch=async()=>Response.json({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{
    edges:[{node:{code:shortcode,media_type:2,image_versions2:{candidates:[{url:'https://scontent.cdninstagram.com/cover.jpg'}]}}}],
    page_info:{has_next_page:false,end_cursor:null}}}});
  const page=await instagramProfilePage('example',null,{BOT_TOKEN:'fake',INSTAGRAM_SESSIONID:'session'});
  assert.deepEqual(page.posts[0].groups,[]);
});

async function run({ session = '12345%3Afixture-session', env = {}, respond, cdnRespond, telegramRespond,
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
      if (target.hostname === 'scontent.cdninstagram.com') return cdnRespond?.(target, init) || new Response(null, { headers: { 'content-length': '1000000' } });
      const call = { path: target.pathname, url: target, hostname: target.hostname, headers, signal: init.signal,
        method: init.method || 'GET', body: init.body };
      calls.push(call);
      const custom = respond?.(call);
      if (custom) return custom;
      if (target.pathname === apiPath) {
        if (target.hostname === 'i.instagram.com') return Response.json({ items: [video] });
        return Response.json({ message: 'login_required' }, { status: 401 });
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

test('configured Instagram login credentials never reach public Reel requests', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return new Response(html(video));
  } });
  assert.equal(files(result).length, 1);
  assert.deepEqual(result.calls.map(call => `${call.hostname}:${call.path}`), [`www.instagram.com:${pagePath}`]);
  assert.ok(result.calls.every(call => !call.headers.get('authorization')));
  assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));
  assert.ok(result.calls.every(call => !call.headers.get('x-ig-device-id')));

});


test('anonymous webpage security challenges stop without another request', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return redirect('/challenge/');
  } });
  assert.equal(files(result).length, 0);
  assert.equal(result.calls.length, 1);
  assert.match(report(result), /^INSTAGRAM_CHALLENGE_REQUIRED/);

});

test('anonymous GraphQL feedback stops without another request', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<script>{"csrf_token":"anon-csrf"}</script>');
    if (call.path === '/graphql/query') return Response.json({ message: 'feedback_required' }, { status: 400 });
  } });
  assert.equal(files(result).length, 0);
  assert.equal(result.calls.length, 2);
  assert.match(report(result), /^INSTAGRAM_FEEDBACK_REQUIRED \[public\/webpage:INSTAGRAM_FEEDBACK_REQUIRED\]/);
  assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));

});

test('a large Reel uses the existing upload workflow without repeating Instagram resolution', async () => {
  const uploads = [];
  const result = await run({ env: { uploadInstagramPost: async post => uploads.push(post) },
    cdnRespond: () => new Response(null, { headers: { 'content-length': '120000000' } }),
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].media[0].size, 120000000);
  assert.equal(uploads[0].media[0].url, video.video_versions[0].url);
  assert.equal(uploads[0].statusMessageId, 99);
  assert.equal(uploads[0].shortcode, shortcode);
  assert.equal(files(result).length, 0);
  assert.equal(result.calls.length, 2);
  assert.ok(!JSON.stringify(uploads).includes('fixture-session'));
  assert.ok(!result.history.some(item => item.status === 'success'));
  assert.ok(!result.sent.some(item => item.method === 'deleteMessage'));
});

test('small videos retain direct delivery even when large-file upload is available', async () => {
  const uploads = [];
  const result = await run({ env: { uploadInstagramPost: async post => uploads.push(post) } });
  assert.equal(uploads.length, 0);
  assert.equal(files(result).length, 1);
});

test('large-file delivery preserves the best available resolution instead of choosing a smaller low-quality variant', async () => {
  const uploads = [];
  await run({ env: { uploadInstagramPost: async post => uploads.push(post) },
    respond: call => call.hostname === 'i.instagram.com' ? Response.json({ items: [{ code: shortcode, video_versions: [
      { url: 'https://scontent.cdninstagram.com/low.mp4', width: 360, height: 640 },
      { url: 'https://scontent.cdninstagram.com/high.mp4', width: 1080, height: 1920 },
    ] }] }) : undefined,
    cdnRespond: target => new Response(null, { headers: { 'content-length': target.pathname === '/high.mp4' ? '120000000' : '10000000' } }),
  });
  assert.equal(uploads[0].media[0].url, 'https://scontent.cdninstagram.com/high.mp4');
});

test('a mixed carousel is handed off as a whole before any file is published, preserving order', async () => {
  const uploads = [];
  const result = await run({ env: { uploadInstagramPost: async post => uploads.push(post) },
    respond: call => call.hostname === 'i.instagram.com' ? Response.json({ items: [{ code: shortcode, carousel_media: [
      { image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/photo.jpg', width: 1080, height: 1080 }] } },
      video,
    ] }] }) : undefined,
    cdnRespond: target => new Response(null, { headers: { 'content-length': target.pathname.endsWith('.mp4') ? '120000000' : '1000000' } }),
  });
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].media.map(item => item.kind), ['photo', 'video']);
  assert.equal(uploads[0].media[0].url, 'https://scontent.cdninstagram.com/photo.jpg');
  assert.equal(files(result).length, 0);
});

test('unknown video sizes use bounded upload instead of gambling on the URL size limit', async () => {
  const uploads = [];
  const result = await run({ env: { uploadInstagramPost: async post => uploads.push(post) },
    cdnRespond: () => new Response(null),
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].media[0].size, null);
  assert.equal(files(result).length, 0);
});

test('without upload capability, oversized media keeps its explicit failure', async () => {
  const result = await run({ cdnRespond: () => new Response(null, { headers: { 'content-length': '120000000' } }) });
  assert.equal(files(result).length, 0);
  assert.match(report(result), /INSTAGRAM_VIDEO_TOO_LARGE/);
});

test('videos above the upload ceiling are rejected before creating a job with the correct message', async () => {
  const uploads = [];
  const result = await run({ env: { uploadInstagramPost: async post => uploads.push(post) },
    cdnRespond: () => new Response(null, { headers: { 'content-length': '2000000001' } }),
  });
  assert.equal(uploads.length, 0);
  assert.equal(files(result).length, 0);
  assert.match(errorText(result), /۲ گیگابایت/);
});

test('the production entry point hands a large post to the existing workflow and keeps a single status message', async () => {
  const bundle = await build({ entryPoints: ['src/app-main.ts'], bundle: true, format: 'esm', write: false,
    plugins: [{ name: 'large-post-runtime', setup(b) {
      b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/containers)$/ }, a => ({ path: a.path, namespace: 'runtime' }));
      b.onLoad({ filter: /.*/, namespace: 'runtime' }, a => ({ contents: a.path === 'cloudflare:workers'
        ? 'export class DurableObject {} export class WorkflowEntrypoint {}'
        : 'export class Container {} export function getContainer(){throw Error("must not start a container inside the webhook");}' }));
    } }],
  });
  const { default: production } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const jobs = [];
  const sent = [];
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    requests.push(parsed.hostname + parsed.pathname);
    if (parsed.hostname === 'api.telegram.org') {
      sent.push({ method: parsed.pathname.split('/').at(-1), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { message_id: 99 } });
    }
    if (parsed.hostname === 'i.instagram.com') return Response.json({ items: [video] });
    if (parsed.hostname === 'scontent.cdninstagram.com') return new Response(null, { headers: { 'content-length': '120000000' } });
    throw Error('unexpected request ' + parsed.hostname);
  };
  const request = () => new Request('https://worker/telegram/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'post-test' },
    body: JSON.stringify({ update_id: 999, message: { message_id: 8, from: { id: 42 }, chat: { id: 42 },
      text: `https://instagram.com/reel/${shortcode}/` } }),
  });
  const bindings = { BOT_TOKEN: 'test-post-bot', WEBHOOK_SECRET: 'post-test', INSTAGRAM_SESSIONID: 'fixture-session',
    YOUTUBE_DOWNLOAD_WORKFLOW: { async create(value) { jobs.push(value); } },
  };
  assert.equal((await production.fetch(request(), bindings, {})).status, 200);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'igdl-42-8-42');
  assert.equal(jobs[0].params.instagramPost.statusMessageId, 99);
  assert.equal(jobs[0].params.instagramPost.media[0].size, 120000000);
  assert.deepEqual(sent.filter(item => item.method !== 'sendMessageDraft').map(item => item.method), ['sendMessage']);
  assert.equal(requests.filter(value => value.startsWith('i.instagram.com')).length, 1);
  assert.ok(!JSON.stringify(jobs).includes('fixture-session'));
});

test('page metadata miss falls back to an anonymous mobile request only', async () => {
  const result = await run();
  assert.equal(files(result).length, 1);
  assert.equal(result.history.at(-1).status, 'success');
  assert.deepEqual(result.calls.map(call => `${call.hostname}:${call.path}`), [
    `www.instagram.com:${pagePath}`, `i.instagram.com:${apiPath}`,
  ]);
  assert.ok(result.calls.every(call => !call.headers.get('authorization')));
  assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));
  noObsoleteRequests(result);

});

test('anonymous mobile fallback sends without authentication or oEmbed', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.hostname === 'i.instagram.com') return Response.json({ items: [video] });
  } });
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].hostname, 'i.instagram.com');
  assert.equal(result.calls[1].headers.get('cookie'), null);
  assert.equal(result.calls[1].headers.get('authorization'), null);
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





test('anonymous homepage redirects do not falsely claim account consent', async () => {
  for (const destination of ['/?secret=redirect-secret', '/accounts/onetap/?secret=redirect-secret', '/accounts/unknown/?secret=redirect-secret']) {
    const result = await run({ respond(call) {
      if (call.path === pagePath) return redirect(destination);
    } });
    assert.equal(files(result).length, 1);
    assert.equal(result.calls.length, 2);
    assert.equal(result.history.at(-1).status, 'success');
    assert.ok(!JSON.stringify(result.sent).includes('پذیرش شرایط'));
    assert.ok(!JSON.stringify(result.diagnostics).includes('redirect-secret'));
    assert.ok(result.calls.every(call => !call.headers.get('authorization')));
  }

});


test('login-form webpages do not force an account session', async () => {
  const rejected = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<form id="loginForm" action="/accounts/login/"></form>');
    if (call.path === apiPath) return Response.json({ message: 'login_required' }, { status: 401 });
  } });
  assert.match(report(rejected), /^INSTAGRAM_POST_UNAVAILABLE/);
  assert.equal(rejected.calls.length, 2);
  const accessible = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<a href="/accounts/login/">Log in</a>' + html(video));
  } });
  assert.equal(files(accessible).length, 1);

});

test('public page data needs no homepage bootstrap, LSD or fixed GraphQL document', async () => {
  const result = await run({ session: '', respond(call) {
    if (call.path === pagePath) return new Response(html({ data: { item: video } }));
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 1);
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
    if (call.path === apiPath) return Response.json({ items: [] });
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
    if (call.path === apiPath) return Response.json({ items: [] });
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
    const result = await run({ session: '', respond(call) {
      if (call.path === pagePath) return redirect(location);
      if (call.path === apiPath) return Response.json({ message: 'login_required' }, { status: 401 });
    } });
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
    if (call.path === apiPath) return Response.json({ message: 'login_required' }, { status: 401 });
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

test('anonymous web-info GraphQL resolves a metadata-free page without login', async () => {
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
  assert.equal(result.calls.length, 2, 'reuse the requested page; no homepage/bootstrap retry');
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


test('anonymous web-info matches the exact post and stops on GraphQL rate limits', async () => {
  for (const limited of [false, true]) {
    const result = await run({ session: '', respond(call) {
      if (call.path === pagePath) return new Response('<script>{"csrf_token":"page-csrf"}</script>');
      if (call.path === '/graphql/query') return Response.json(limited
        ? { data: null, errors: [{ code: 1675004, message: 'Rate limit exceeded' }] }
        : { data: { xdt_api__v1__media__shortcode__web_info: { items: [{ ...video, code: 'AnotherPost' }] } } });
      if (call.path === apiPath) return Response.json({ items: [] });
    } });
    assert.equal(result.calls.length, limited ? 2 : 3);
    assert.equal(files(result).length, 0);
    assert.match(report(result), limited ? /^INSTAGRAM_RATE_LIMIT_429/ : /^INSTAGRAM_POST_UNAVAILABLE/);
    assert.ok(result.calls.every(call => !call.headers.get('cookie')?.includes('sessionid=')));
  }

});

test('public page throttling preserves exact HTTP status and Retry-After', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return new Response(null, { status: 429, headers: { 'retry-after': '1158' } });
  } });
  assert.match(report(result), /^INSTAGRAM_RATE_LIMIT_429 \[public\/webpage:INSTAGRAM_RATE_LIMIT_429\]/);
  assert.deepEqual(result.diagnostics.find(x => x.message === 'instagram download failed').info.throttle, {
    source: 'http', httpStatus: 429, endpoint: pagePath, retryAfterSeconds: 1158,
  });
  assert.equal(result.calls.length, 1);
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
  assert.equal(result.calls.length, 2);
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

test('upstream GraphQL HTTP 401 rate response triggers shared cooldown without retrying Instagram', async () => {
  let until = 0;
  const stored = [];
  const store = { ADMIN_STATS: { getByName(name) {
    assert.equal(name, 'global');
    return { async fetch(request) {
      const now = Date.now();
      assert.equal(new URL(request.url).pathname, '/instagram-public-cooldown');
      if (request.method === 'POST') {
        const { seconds } = await request.json();
        stored.push(seconds);
        until = Math.max(until, now + seconds * 1000);
      }
      return Response.json({ remainingSeconds: Math.max(0, Math.ceil((until - now) / 1000)) });
    } };
  } } };
  const first = await run({ env: store, respond(call) {
    if (call.path === pagePath) return new Response('<script>{"csrf_token":"public-csrf"}</script>');
    if (call.path === '/graphql/query') {
      assert.ok(!call.headers.get('cookie')?.includes('sessionid='));
      return Response.json({ message: 'Please wait a few minutes before you try again.' }, { status: 401 });
    }
  } });
  assert.equal(first.calls.length, 2);
  assert.equal(files(first).length, 0);
  assert.match(report(first), /^INSTAGRAM_RATE_LIMIT_429 \[public\/webpage:INSTAGRAM_RATE_LIMIT_429\]/);
  assert.deepEqual(first.diagnostics.find(x => x.message === 'instagram download failed').info.throttle, {
    source: 'api', endpoint: '/graphql/query', httpStatus: 401,
  });
  assert.deepEqual(stored, [900]);
  const second = await run({ env: store, respond() { throw Error('Instagram must not be called during cooldown'); } });
  assert.equal(second.calls.length, 0, 'the next Worker request must not contact Instagram');
  assert.ok(second.diagnostics.some(x => x.message === 'instagram public cooldown active' &&
    x.info.remainingSeconds > 0));
  assert.ok(!second.diagnostics.some(x => x.message === 'instagram download failed'),
    'expected local pauses are not upstream download errors');
  assert.match(errorText(second), /درخواست جدید نمی‌فرستد/);
  until = Date.now() - 1;
  const recovered = await run({ env: store, respond(call) {
    if (call.path === pagePath) return new Response(html(video));
  } });
  assert.equal(recovered.calls.length, 1);
  assert.equal(files(recovered).length, 1);
});

test('anonymous Instagram HTTP 429 cooldown honors explicit Retry-After', async () => {
  const recorded = [];
  const env = { ADMIN_STATS: { getByName() {
    return { async fetch(request) {
      if (request.method === 'POST') {
        recorded.push((await request.json()).seconds);
        return Response.json({ remainingSeconds: recorded.at(-1) });
      }
      return Response.json({ remainingSeconds: 0 });
    } };
  } } };
  const result = await run({ env, respond() {
    return new Response(null, { status: 429, headers: { 'retry-after': '1158' } });
  } });
  assert.equal(result.calls.length, 1);
  assert.deepEqual(recorded, [1158]);
});

test('anonymous HTML and GraphQL may never accept server-provided account cookies', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<script>{"csrf_token":"public-csrf"}</script>', {
      headers: { 'set-cookie': 'sessionid=private-session; Path=/; HttpOnly' },
    });
    if (call.path === '/graphql/query') {
      assert.equal(call.headers.get('authorization'), null);
      assert.ok(!call.headers.get('cookie')?.includes('sessionid='));
      assert.equal(call.headers.get('x-csrftoken'), 'public-csrf');
      return Response.json({ data: { xdt_api__v1__media__shortcode__web_info: { items: [video] } } });
    }
  } });
  assert.equal(files(result).length, 1);
  assert.equal(result.calls.length, 2);
});

test('anonymous API failures never use configured account login as fallback', async () => {
  const result = await run({ respond(call) {
    if (call.path === pagePath) return new Response('<html></html>');
    if (call.path === apiPath) return Response.json({ message: 'login_required' }, { status: 401 });
  } });
  assert.equal(files(result).length, 0);
  assert.match(report(result), /^INSTAGRAM_POST_UNAVAILABLE/);
  assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(call => !call.headers.get('authorization') &&
    !call.headers.get('cookie')?.includes('sessionid=')));
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




