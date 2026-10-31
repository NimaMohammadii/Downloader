import { build } from 'esbuild';
import ts from 'typescript';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { outputFiles } = await build({
  stdin: { contents: `export * from './src/localization'; export * from './src/admin';
    export * from './src/youtube-subtitles'; export * from './src/start-message';
    export * from './src/restrictions'; export * from './src/broadcast';
    export { YoutubeDownloadWorkflow, createInstagramWorkflow } from './src/youtube-main';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /youtube-main\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { createInstagramWorkflow };', loader: 'ts' }));
    b.onResolve({ filter: /^(cloudflare:workers|@cloudflare\/containers)$/ }, a => ({ path: a.path, namespace: 'runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'runtime' }, a => ({ contents: a.path === 'cloudflare:workers'
      ? 'export class DurableObject {} export class WorkflowEntrypoint {}'
      : 'export class Container {} export function getContainer(){throw Error("Unexpected download");}' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const catalog = JSON.parse(readFileSync('locales/messages.json', 'utf8'));
const publicErrors = JSON.parse(readFileSync('container/public_errors.json', 'utf8'));
const persian = /[آ-ی]/u;
const assertLocalized = (value, label) => assert.ok(!persian.test(value), `${label}: ${value}`);

function fixture() {
  const saved = new Map([[42, 'en'], [api.ADMIN_USER_ID, 'ru']]);
  const env = { BOT_TOKEN: 'fake', ADMIN_STATS: { getByName() { return { async fetch(url) {
    const user = Number(new URL(url).searchParams.get('user'));
    return Response.json({ language: saved.get(user) || 'fa', selected: saved.has(user) });
  } }; } } };
  return { env, saved };
}

test('all bot source copy is covered, including dynamically composed UI and admin errors', () => {
  for (const file of readdirSync('src').filter(f => f.endsWith('.ts') && f !== 'localization.ts')) {
    const ast = ts.createSourceFile(file, readFileSync(`src/${file}`, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let text;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map(s => '7' + s.literal.text).join('');
      // SQL uses stable source identifiers; it is never bot copy.
      if (text && persian.test(text) && !/^[۰-۹٠-٩]+$/.test(text) && !/INSERT OR IGNORE INTO download_stat_events/.test(text)) {
        for (const lang of ['en', 'ru']) assertLocalized(api.translate(text, lang), `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${lang}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
});

test('all catalog entries keep their runtime placeholders and contain both target languages', () => {
  assert.equal(new Set(catalog.map(row => row.fa)).size, catalog.length);
  for (const row of catalog) for (const lang of ['en', 'ru']) {
    assertLocalized(row[lang], row.fa);
    assert.deepEqual([...row[lang].matchAll(/\{\d+\}/g)].map(m => m[0]).sort(),
      [...row.fa.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), `${lang}: ${row.fa}`);
  }
});

test('subtitle controls, every subtitle language, welcome and nested selections are localized', () => {
  const menu = { videoId: 'abcdefghijk', requestMessageId: 8, userId: 42,
    preference: { enabled: true, language: 'fa' } };
  for (const lang of ['en', 'ru']) {
    for (const picker of [false, true]) {
      const buttons = api.subtitleButtons(menu, picker);
      const localized = api.localizePayload({ reply_markup: { inline_keyboard: buttons } }, lang);
      for (const row of localized.reply_markup.inline_keyboard) for (const button of row) assertLocalized(button.text, lang);
      assert.deepEqual(localized.reply_markup.inline_keyboard.map(r => r.map(b => b.callback_data)), buttons.map(r => r.map(b => b.callback_data)));
    }
    const welcome = api.localizePayload(api.startMessage(), lang);
    assertLocalized(welcome.text, lang);
    assert.ok(welcome.entities.some(e => e.type === 'bold'));
    assertLocalized(api.translate('⏳ 480p Standard • زیرنویس فارسی انتخاب شد؛ دانلود شروع شد…', lang), lang);
    assertLocalized(api.translate('پست و ریلز: Apify — اکانت 2', lang), lang);
    assertLocalized(api.translate('۲۴ ساعت گذشته: 5 نفر', lang), lang);
    assertLocalized(api.translate('✅ فارسی 🇮🇷 • غیرفعال کن', lang), lang);
  }
});

test('public errors retain every bold phrase and their custom emoji with correct UTF-16 offsets', () => {
  for (const row of publicErrors) for (const lang of ['en', 'ru']) {
    const entities = row.bold.map(phrase => ({ type: 'bold', offset: row.message.indexOf(phrase), length: phrase.length }));
    entities.push({ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5447644880824181073' });
    const result = api.localizePayload({ text: row.message, entities }, lang);
    assert.equal(result.entities.filter(e => e.type === 'bold').length, row.bold.length, row.id);
    assert.equal(result.entities.find(e => e.type === 'custom_emoji').custom_emoji_id, '5447644880824181073');
    for (const entity of result.entities) assert.ok(entity.offset >= 0 && entity.offset + entity.length <= result.text.length);
  }
});

test('HTML formatting is preserved without conflicting entities', () => {
  const stats = { since: Date.UTC(2026, 9, 30), periods: Object.fromEntries(['day', 'week', 'all'].map(p => [p,
    Object.fromEntries(['ig_story', 'ig_post', 'ig_reel', 'ig_other', 'tiktok', 'x', 'youtube', 'music', 'other'].map(k => [k, 2]))])) };
  for (const lang of ['en', 'ru']) {
    const result = api.localizePayload({ text: api.formatDownloadStatistics(stats), parse_mode: 'HTML' }, lang);
    assertLocalized(result.text, lang);
    assert.equal(result.parse_mode, 'HTML');
    assert.equal(result.entities, undefined);
    assert.equal((result.text.match(/<b>/g) || []).length, (result.text.match(/<\/b>/g) || []).length);
  }
});

test('translated captions preserve content, links, media, callback data and repeated entity positions', () => {
  const caption = 'زیرنویس: فعال';
  assert.equal(api.translate(`عنوان: ${caption}`, 'en'), `Title: ${caption}`);
  assert.equal(api.translate(`درخواست: https://example.org/${caption}`, 'ru'), `Запрос: https://example.org/${caption}`);
  const text = 'بازگشت\nبازگشت';
  const source = { text, entities: [0, 7].map(offset => ({ type: 'bold', offset, length: 6 })),
    reply_markup: { inline_keyboard: [[{ text: 'بازگشت', callback_data: 'ytsp|abcdefghijk|8|42|back', url: 'https://example.org/بازگشت' }]] } };
  const out = api.localizePayload(source, 'en');
  assert.deepEqual(out.entities.map(e => e.offset), [0, 5]);
  assert.deepEqual(out.entities.map(e => out.text.slice(e.offset, e.offset + e.length)), ['Back', 'Back']);
  assert.equal(out.reply_markup.inline_keyboard[0][0].callback_data, source.reply_markup.inline_keyboard[0][0].callback_data);
  assert.equal(out.reply_markup.inline_keyboard[0][0].url, source.reply_markup.inline_keyboard[0][0].url);
  assert.equal(source.text, text);
  const media = api.localizePayload({ media: [{ type: 'video', media: 'file-id', caption: 'Original title\nزیرنویس فارسی' }] }, 'ru');
  assert.equal(media.media[0].media, 'file-id');
  assertLocalized(media.media[0].caption, 'media caption');
  for (const title of ['English', 'فارسی', 'بازگشت']) {
    const result = api.localizePayload({ caption: `${title}\nزیرنویس فارسی` }, 'ru');
    assert.equal(result.caption.split('\n')[0], title);
    assertLocalized(result.caption.split('\n')[1], 'subtitle caption');
  }
});

test('Worker and container agree on statuses, rendering progress and nested presentation values', () => {
  const progress = '🎬 دارم زیرنویس فارسی رو روی ویدیو قرار می‌دم…\n\n⏳ ~3 min • 20%';
  const value = '~3 min • 20%';
  const payloads = [
    { text: progress, entities: [{ type: 'bold', offset: progress.indexOf(value), length: value.length },
      { type: 'custom_emoji', offset: progress.indexOf('⏳'), length: 1, custom_emoji_id: '5386367538735104399' }] },
    { text: 'زیرنویس: فعال', reply_markup: { inline_keyboard: [[{ text: 'فارسی', callback_data: 'ytsl|id|8|42|fa' }]] } },
    { text: '⏳ 480p Standard • زیرنویس فارسی انتخاب شد؛ دانلود شروع شد…' },
    { text: 'زمان باقی‌مانده: ۱ ساعت و ۳ دقیقه' },
    { text: '۲۴ ساعت گذشته: 5 نفر\nپست و ریلز: Apify — اکانت 2' },
    { text: 'عنوان: زیرنویس: فعال\nنام کاربری: @فارسی' },
    { text: '<b>اینستاگرام — مجموع: 8</b>', parse_mode: 'HTML' },
  ];
  const inputs = ['en', 'ru'].flatMap(lang => payloads.map(payload => [payload, lang]));
  const python = execFileSync('python', ['-c', `import json,sys;sys.path.insert(0,'container');from localization import localize_payload;print(json.dumps([localize_payload(p,l) for p,l in json.load(sys.stdin)],ensure_ascii=False))`], { input: JSON.stringify(inputs), encoding: 'utf8' });
  const expected = inputs.map(([payload, lang]) => api.localizePayload(payload, lang));
  assert.deepEqual(JSON.parse(python), expected);
  const rendered = expected[payloads.length];
  assert.ok(rendered.text.includes('~3 мин. • 20%'));
  const bold = rendered.entities.find(e => e.type === 'bold');
  assert.equal(rendered.text.slice(bold.offset, bold.offset + bold.length), '~3 мин. • 20%');
  assert.equal(rendered.entities.find(e => e.type === 'custom_emoji').custom_emoji_id, '5386367538735104399');
});

test('background admin messages use the recipient language rather than the downloading user’s language', async () => {
  const { env } = fixture(), previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ method: url.split('/').at(-1), ...JSON.parse(init.body) }); return Response.json({ ok: true, result: { message_id: 1 } }); };
  try {
    const manager = Object.assign(Object.create(api.BroadcastManager.prototype), { env,
      status() { return { status: 'completed', total: 2, sent: 2, failed: 0, pending: 0 }; } });
    await api.withUserLanguage(env, 42, () => manager.publish({ chat_id: String(api.ADMIN_USER_ID), message_id: 1 }));
    assert.match(calls.at(-1).text, /Рассылка/);
    const workflow = Object.assign(Object.create(api.YoutubeDownloadWorkflow.prototype), { env });
    const step = { do(...args) { return args.at(-1)(); } };
    await api.withUserLanguage(env, 42, () => workflow.notifyInstagramSessionFailure({ id: 'job', instagramPostRequest: { shortcode: 'abc' } }, step, 'PROVIDER_ERROR', { code: 'SESSION_ERROR', message: 'technical detail' }));
    const notice = calls.find(c => c.method === 'sendMessage');
    assert.match(notice.text, /Загрузка Instagram/);
    assert.ok(notice.text.includes('PROVIDER_ERROR') && notice.text.includes('SESSION_ERROR'));
    assert.equal(notice.chat_id, api.ADMIN_USER_ID);
    assert.equal(await api.withUserLanguage(env, 42, async () => api.presentationLocale()), 'en-GB');
    assert.equal(api.presentationLocale(), 'fa-IR');
  } finally { globalThis.fetch = previous; }
});


test('real admin histories, usage reports and provider headings translate every composed label', async () => {
  const { env, saved } = fixture();
  const at = Date.UTC(2026, 9, 31, 12);
  const totals = { downloads: 1, bytes: 1024, unknownSizes: 1, cached: 0, runtimeMs: 12000,
    cpuSeconds: 2, ingressBytes: 2048, egressBytes: 1024, cpuMeasuredMs: 12000, networkMeasuredMs: 12000,
    subtitles: { transcriptionNano: 1, translationNano: 2, calls: 1, unknown: 1 } };
  for (const lang of ['en', 'ru']) {
    saved.set(42, lang);
    await api.withUserLanguage(env, 42, async () => {
      const usage = api.localizePayload({ text: api.formatAdminUsage({ trackingSince: at, now: at + 1000,
        lastMeasured: at, subtitleTrackingSince: at, all: totals, day: totals, week: totals }) }, lang);
      assertLocalized(usage.text, 'usage');
      assert.ok(!/[۰-۹٠-٩]/u.test(usage.text));
      const history = api.formatAdminDownloadHistory({ page: 0, downloads: [{ source: 'تشخیص آهنگ',
        createdAt: at, status: 'success', title: 'Original title', request: 'https://example.org/audio', delivered: 1 }] }).join('\n');
      const result = api.localizePayload({ text: history }, lang);
      assertLocalized(result.text, 'history');
      assert.ok(result.text.includes('Original title') && result.text.includes('https://example.org/audio'));
      for (const label of ['پست/ریلز', 'استوری', 'پست/ریلز، استوری']) {
        assertLocalized(api.translate(`Apify 1 ✅ ${label}`, lang), 'account');
      }
    });
  }
});

test('a resumed music job keeps its selected language when the preference store is temporarily unavailable', async () => {
  const env = { ADMIN_STATS: { getByName() { return { async fetch() { throw Error('temporary store outage'); } }; } } };
  for (const language of ['en', 'ru']) {
    const workflow = Object.assign(Object.create(api.YoutubeDownloadWorkflow.prototype), { env,
      async runLocalized() { return api.localizePayload({ text: '⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…' }).text; } });
    const text = await workflow.run({ payload: { userId: 42, language } }, {});
    assert.equal(text, api.translate('⬇️ دارم آهنگ انتخاب‌شده را دانلود می‌کنم…', language));
  }
});


test('new music workflows capture the requesting user language in their existing payload', async () => {
  const { env, saved } = fixture();
  const created = [];
  env.YOUTUBE_DOWNLOAD_WORKFLOW = { async create(job) { created.push(job); return {}; } };
  for (const language of ['en', 'ru']) {
    saved.set(42, language);
    await api.withUserLanguage(env, 42, () => api.createInstagramWorkflow(env,
      { message: { chat: { id: 42 }, message_id: 7, from: { id: 42 } } },
      { kind: 'music', musicVideoId: 'abcdefghijk' }));
    assert.equal(created.at(-1).params.language, language);
    assert.equal(created.at(-1).params.userId, 42);
    assert.equal(created.at(-1).params.instagram.musicVideoId, 'abcdefghijk');
  }
});
