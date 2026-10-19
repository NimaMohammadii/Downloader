import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = await readFile(new URL('../src/story-main.ts', import.meta.url), 'utf8');
const { outputFiles } = await build({
  stdin: { contents: source, loader: 'ts' }, bundle: true, format: 'esm', write: false,
  plugins: [{ name: 'test-story-bindings', setup(build) {
    build.onResolve({ filter: /.*/ }, a => ({ path: a.path, namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, a => ({ contents: a.path === './main'
      ? 'export default { fetch() { globalThis.legacy++; return Response.json({delegated: true}); } };'
      : 'export const telegramCustomEmoji=(_method,payload)=>payload; export const telegramTextMotion=async()=>{}; export const telegramFileCache=async(...args)=>globalThis.storyFileCache ? globalThis.storyFileCache(...args) : null; export class AdminStatsStore {} export const ADMIN_USER_ID = 1; export async function recordDownload(_env,record) {(globalThis.downloadHistory ||= []).push(record);} export async function recordSuccessfulDelivery() {}' }));
  } }],
});
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const session = '12345%3Afictional-test-session';
const media = { pk: '999', user: { pk: '77' }, video_versions: [{ url: 'https://cdn.instagram.com/test.mp4', width: 720, height: 1280 }] };
async function run({ routes = {}, env = {}, link = 'https://www.instagram.com/stories/example/999/' } = {}) {
  const requests = [], telegram = [];
  globalThis.legacy = 0; globalThis.downloadHistory = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = new Headers(init.headers);
    if (url.hostname === 'api.telegram.org') {
      const body = JSON.parse(init.body); telegram.push({ method: url.pathname.split('/').at(-1), body });
      return Response.json({ ok: true, result: { message_id: 10, ...(url.pathname.endsWith('/sendVideo') ? { video: { file_id: 'genuine_story_file' } } : {}) } });
    }
    requests.push({ url, headers });
    if (url.hostname === 'cdn.instagram.com') return new Response(null, { headers: { 'content-length': '1000000' } });
    const handler = routes[url.pathname];
    if (handler) return handler({ url, headers });
    throw Error('Unexpected request ' + url.pathname);
  };
  const request = new Request('https://worker/telegram/webhook', { method: 'POST', headers: {
    'x-telegram-bot-api-secret-token': 'dlr_7Tz91mQX4pK8vN2sR6cH5bJ3wF9yUaE1', 'content-type': 'application/json',
  }, body: JSON.stringify({ update_id: 123, message: { message_id: 7, from: { id: 1 }, chat: { id: 1 }, text: link } }) });
  const response = await worker.fetch(request, { BOT_TOKEN: 'fictional-token', INSTAGRAM_SESSIONID: session, ...env }, {});
  assert.equal(response.status, 200);
  return { requests, telegram, legacy: globalThis.legacy };
}

test('missing session fails explicitly without Instagram requests or legacy retries', async () => {
  const r = await run({ env: { INSTAGRAM_SESSIONID: '' } });
  assert.equal(r.requests.length, 0); assert.equal(r.legacy, 0);
  assert.match(r.telegram[0].body.text, /INSTAGRAM_SESSIONID/);
  assert.equal(globalThis.downloadHistory.at(-1).status,'failed');
});

test('expired-session JSON is recognized on non-2xx and stops the resolver chain', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'login_required' }, { status: 401 }) } });
  assert.equal(r.requests.length, 1); assert.equal(r.legacy, 0);
  assert.match(r.telegram[0].body.text, /ورود دوباره/);
  assert.ok(!JSON.stringify(r.telegram).includes(session));
});

test('security challenge is distinguished from a missing story', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'challenge_required', challenge: {} }, { status: 400 }) } });
  assert.match(r.telegram[0].body.text, /تأیید امنیتی/); assert.equal(r.requests.length, 1);
});

test('rate limiting stops instead of issuing more fallback requests', async () => {
  const r = await run({ routes: { '/api/v1/media/999/info/': () => Response.json({ message: 'Please wait a few minutes' }, { status: 429 }) } });
  assert.match(r.telegram[0].body.text, /محدود/); assert.equal(r.requests.length, 1);
});

test('story ID resolves owner and sends only the matching story without username lookup', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [{ ...media, pk: '998' }, media] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
  assert.ok(!r.requests.some(r => r.url.pathname.includes('usernameinfo')));
  assert.equal(r.legacy, 0);
  assert.equal(globalThis.downloadHistory.at(-1).status,'success');
  assert.equal(globalThis.downloadHistory.at(-1).delivered,1);
});

test('empty story-feed response falls back to authenticated reels with the same cookie jar', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: null }, { headers: { 'set-cookie': 'mid=fresh-mid; Path=/' } }),
    '/api/v1/feed/reels_media/': ({ url, headers }) => {
      assert.equal(url.searchParams.get('reel_ids'), '77');
      assert.match(headers.get('cookie'), /mid=fresh-mid/);
      return Response.json({ reels: { '77': { items: [media] } } });
    },
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('a missing requested story never sends a different story', async () => {
  const r = await run({ routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [media] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [{ ...media, pk: '998' }] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 0);
  assert.match(r.telegram[0].body.text, /منقضی|قابل مشاهده/);
});

test('username fallback retains full session cookies and CSRF on the web endpoint', async () => {
  const r = await run({ env: { INSTAGRAM_CSRFTOKEN: 'test-csrf', INSTAGRAM_MID: 'test-mid' }, routes: {
    '/api/v1/media/999/info/': () => Response.json({ items: [] }),
    '/api/v1/users/example/usernameinfo/': () => Response.json({ status: 'fail' }, { status: 404 }),
    '/api/v1/users/web_profile_info/': ({ headers }) => {
      assert.match(headers.get('cookie'), /mid=test-mid/);
      assert.equal(headers.get('x-csrftoken'), 'test-csrf');
      return Response.json({ data: { user: { id: '77' } } });
    },
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [media] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('non-story posts retain the existing route', async () => {
  const r = await run({ link: 'https://www.instagram.com/reel/example/' });
  assert.equal(r.legacy, 1); assert.equal(r.requests.length, 0);
});

test('raw 64-bit media IDs remain exact and select only the requested story', async () => {
  const wanted = '3490123456789012345', sibling = '3490123456789012346';
  assert.equal(Number(wanted), Number(sibling)); // Both collapse with response.json().
  const exactResponse = (items, wrapper) => new Response(
    JSON.stringify(wrapper(items)).replace(/"pk":"(\d{19})"/g, '"pk":$1'),
    { headers: { 'content-type': 'application/json' } },
  );
  const wantedMedia = { ...media, pk: wanted, caption: { text: 'Keep 3490123456789012345 and "quotes" intact' } };
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => exactResponse([wantedMedia], items => ({ items })),
    '/api/v1/feed/user/77/story/': () => exactResponse([
      { ...media, pk: sibling, video_versions: [{ url: 'https://cdn.instagram.com/wrong.mp4' }] }, wantedMedia,
    ], items => ({ reel: { items } })),
  } });
  const sent = r.telegram.filter(t => t.method === 'sendVideo');
  assert.equal(sent.length, 1);
  assert.equal(new URL(sent[0].body.video).searchParams.get('src'), media.video_versions[0].url);
  assert.ok(!r.requests.some(r => r.url.pathname.includes('usernameinfo')));
});

test('a composite string ID can match when pk is already rounded upstream', async () => {
  const wanted = '3490123456789012345';
  const item = { ...media, pk: Number(wanted), id: `${wanted}_77` };
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => Response.json({ items: [item] }),
    '/api/v1/feed/user/77/story/': () => Response.json({ reel: { items: [item] } }),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 1);
});

test('neighboring large ID is never mistaken for a missing requested story', async () => {
  const wanted = '3490123456789012345';
  const r = await run({ link: `https://www.instagram.com/stories/example/${wanted}/`, routes: {
    [`/api/v1/media/${wanted}/info/`]: () => Response.json({ items: [{ ...media, pk: wanted }] }),
    '/api/v1/feed/user/77/story/': () => new Response(
      '{"reel":{"items":[{"pk":3490123456789012346}]}}',
    ),
  } });
  assert.equal(r.telegram.filter(t => t.method === 'sendVideo').length, 0);
  assert.match(r.telegram[0].body.text, /منقضی|قابل مشاهده/);
});

test('Story video reuse keeps source access checks and owner-bound song buttons',async()=>{
  const operations=[];
  globalThis.storyFileCache=async(_env,op,key,value)=>{
    operations.push({op,key,value});
    return op==='get'?{method:'sendVideo',fileId:'cached_story_id',data:{caption:'Instagram'}}:null;
  };
  try {
    const r=await run({routes:{
      '/api/v1/media/999/info/':()=>Response.json({items:[media]}),
      '/api/v1/feed/user/77/story/':()=>Response.json({reel:{items:[media]}}),
    }});
    const sent=r.telegram.find(t=>t.method==='sendVideo').body;
    assert.equal(sent.video,'cached_story_id');
    assert.ok(r.requests.some(r=>r.url.pathname.includes('/feed/user/')));
    assert.equal(sent.reply_markup.inline_keyboard[0][1].callback_data,'igm|s|999|0|1');
    assert.equal(operations[0].key,'ig:1:999:0:video');
    assert.equal(operations.at(-1).value.fileId,'genuine_story_file');
  } finally {delete globalThis.storyFileCache;}
});
