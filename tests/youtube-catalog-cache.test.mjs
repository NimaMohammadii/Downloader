import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
const bundle=await build({entryPoints:['src/youtube-catalog.ts'],bundle:true,format:'esm',write:false});
const {youtubeCatalogRequest:request,cleanYoutubeCatalog:clean,youtubeCatalogCache:cache,CATALOG_TTL_MS:ttl}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const id='abcdefghijk',key=`yt:${id}:${'a'.repeat(64)}`;
const value={ok:true,videoId:id,title:'Fixture',qualities:[360,720],audioAvailable:true,sizes:{720:{bytes:1234,estimated:true}}};
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE youtube_catalog_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,created_at INTEGER NOT NULL)');
 return {db,sql:{exec(q,...args){const s=db.prepare(q);return{toArray:()=>s.all(...args),...(!q.startsWith('SELECT')?(s.run(...args),{}):{})};}}};
}
test('catalog survives a fresh accessor, expires without sliding TTL, and cannot cross video or configuration keys',async()=>{
 const {db,sql}=fixture();try{
 assert.equal(request({op:'put',key,value},sql,1000).status,200);
 assert.equal((await request({op:'get',key},sql,1001).json()).value.videoId,id);
 assert.equal((await request({op:'get',key:key.replace('a'.repeat(64),'b'.repeat(64))},sql,1001).json()).value,null);
 assert.equal((await request({op:'get',key},sql,1000+ttl).json()).value,null);
 assert.equal(request({op:'put',key,value:{...value,videoId:'bbbbbbbbbbb'}},sql,1001).status,400);
 }finally{db.close();}
});
test('only successful display data is stored; source URLs, credentials, unknown fields and failures never enter storage',()=>{
 const {db,sql}=fixture();try{
 request({op:'put',key,value:{...value,formats:[{url:'https://secret'}],cookie:'secret',apiKey:'secret'}},sql,1);
 const stored=db.prepare('SELECT value FROM youtube_catalog_cache').get().value;
 assert.ok(!stored.includes('secret'));assert.deepEqual(JSON.parse(stored),clean(value,id));
 for(const bad of [{...value,ok:false},{...value,qualities:[1440]},{...value,qualities:[],audioAvailable:false}])
  assert.equal(request({op:'put',key,value:bad},sql,2).status,400);
 db.prepare('UPDATE youtube_catalog_cache SET value = ?').run('{bad');
 assert.equal(request({op:'get',key},sql,2).status,200);
 }finally{db.close();}
});
test('helper scopes catalogs to the bot and treats absent, malformed and failed storage as a miss',async()=>{
 const names=[];
 const env={BOT_TOKEN:'123:fixture',ADMIN_STATS:{getByName(n){names.push(n);return{async fetch(){return Response.json({value});}}}}};
 assert.equal((await cache(env,'get',key)).videoId,id);assert.deepEqual(names,['telegram-files-123']);
 assert.equal(await cache({...env,ADMIN_STATS:undefined},'get',key),null);
 assert.equal(await cache({...env,ADMIN_STATS:{getByName(){throw Error('offline');}}},'get',key),null);
});
