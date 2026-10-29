import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const {outputFiles}=await build({ external: ['node:async_hooks'],entryPoints:['src/public-errors.ts'],bundle:true,format:'esm',write:false});
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const cases=JSON.parse(await readFile(new URL('./public-error-cases.json',import.meta.url),'utf8'));
for(const example of cases) test(`public category ${example.category}: ${example.input}`,()=>{
  const row=api.publicError(example.input);
  assert.equal(row.id,example.category);
  assert.ok(row.message.startsWith('⚠️ '));
  assert.ok(row.bold.every(phrase=>row.message.includes(phrase)));
  assert.equal(api.publicError(row.message).id,row.id);
  assert.ok(api.isPublicErrorMessage(row.message));
});
test('diagnostics guide safe classification without revealing private data or blaming users for provider limits',()=>{
  const row=api.publicError('❌ دریافت کامل نشد','INSTAGRAM_RATE_LIMIT_429 token=PRIVATE https://private.example');
  assert.equal(row.id,'rate_limit');
  assert.ok(!row.message.includes('PRIVATE')&&!row.message.includes('private.example'));
  assert.ok(!row.message.includes('دسترسی شما'));
  assert.equal(api.publicError('❌ API_ID API_HASH آماده نیست').id,'service_unavailable');
});
