import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import assert from 'node:assert/strict';
const b=await build({entryPoints:['src/telegram-file-cache.ts'],bundle:true,format:'esm',write:false});
const {telegramFileCache:cache,telegramFileCacheRequest:request,FILE_CACHE_RETENTION_MS:year}=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
const value={method:'sendVideo',fileId:'fixture_id',data:{caption:'video'},fileSize:1234};
function fixture(){
 const stores=new Map(),calls=[];let now=2*year,hook;
 function store(name){
  if(!stores.has(name)){
   const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE telegram_file_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX cache_at ON telegram_file_cache(created_at)');
   const sql={exec(q,...args){const s=db.prepare(q);if(q.startsWith('SELECT'))return{toArray:()=>s.all(...args)};s.run(...args);return{toArray:()=>[]};}};
   stores.set(name,{db,sql,async fetch(input){const body=await input.json();calls.push({name,body});if(hook)await hook(name,body);return request(body,sql,now);}});
  }
  return stores.get(name);
 }
 const env={BOT_TOKEN:'123:fixture',ADMIN_STATS:{getByName:store}};
 return{env,store,stores,calls,get now(){return now;},set now(v){now=v;},set hook(v){hook=v;},close(){for(const s of stores.values())s.db.close();}};
}
test('one-year retention exceeds 30 days, expires at the boundary and is not extended by reads',async()=>{
 const f=fixture();try{
 await cache(f.env,'put','yt:example:v720',value);f.now+=180*86400000;
 assert.equal((await cache(f.env,'get','yt:example:v720')).fileId,value.fileId);
 f.now=3*year;
 assert.equal(await cache(f.env,'get','yt:example:v720'),null);
 }finally{f.close();}
});
test('old cache migrates without restarting its age; no upload or invalidation is overwritten',async()=>{
 for(const replacement of [undefined,{...value,fileId:'new_file'},null]){
 const f=fixture();try{
 const key='ig:42:post:0:video';
 request({op:'put',key,value},f.store('telegram-files-123').sql,f.now-90*86400000);
 f.hook=async(name,body)=>{if(body.op==='import'&&replacement!==undefined)request({op:replacement===null?'delete':'put',key,value:replacement},f.store(name).sql,f.now);};
 const result=await cache(f.env,'get',key);
 assert.equal(result?.fileId??null,replacement===null?null:replacement?.fileId??value.fileId);
 const migrated=f.calls.find(c=>c.body.op==='import');
 assert.equal(migrated.body.createdAt,f.now-90*86400000);
 if(replacement===undefined){f.now+=275*86400000;assert.equal(await cache(f.env,'get',key),null);}
 }finally{f.close();}}
});
test('invalidation cannot resurrect a legacy ID, even if the old store is unavailable',async()=>{
 const f=fixture();try{
 const key='yt:example:v360';request({op:'put',key,value},f.store('telegram-files-123').sql,f.now);
 await cache(f.env,'get',key);
 f.hook=async(name,body)=>{if(name==='telegram-files-123'&&body.op==='delete')throw Error('legacy offline');};
 await cache(f.env,'delete',key);
 assert.equal(await cache(f.env,'get',key),null);
 }finally{f.close();}
});
test('keys are spread deterministically across 64 bot-scoped stores with distinct variants',async()=>{
 const f=fixture();try{
 for(let i=0;i<1024;i++)await cache(f.env,'put',`yt:video${i}:v720`,value);
 assert.equal([...f.stores.keys()].filter(n=>n.includes('-v2-')).length,64);
 const key='yt:example:v720:sub-fa-v1';await cache(f.env,'put',key,value);
 assert.equal((await cache(f.env,'get',key)).fileId,value.fileId);
 assert.equal(await cache({...f.env,BOT_TOKEN:'999:another'},'get',key),null);
 assert.equal(await cache(f.env,'get','yt:example:v720:sub-de-v1'),null);
 }finally{f.close();}
});
test('more than 10000 entries survive and expiration cleanup is bounded',()=>{
 const f=fixture();try{
 const {db,sql}=f.store('scale');const insert=db.prepare('INSERT INTO telegram_file_cache VALUES (?,?,?)');
 db.exec('BEGIN');for(let i=0;i<10001;i++)insert.run(`yt:${i}`,JSON.stringify(value),f.now);for(let i=0;i<501;i++)insert.run(`old:${i}`,JSON.stringify(value),f.now-year);db.exec('COMMIT');
 request({op:'put',key:'yt:new',value},sql,f.now);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM telegram_file_cache WHERE created_at = ?').get(f.now).n,10002);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM telegram_file_cache WHERE created_at < ?').get(f.now).n,301);
 }finally{f.close();}
});
test('malformed data, future imports, corrupt rows and unavailable storage fail safely',async()=>{
 const f=fixture();try{
 const {db,sql}=f.store('validation');
 for(const body of [{op:'put',key:'bad/key',value},{op:'put',key:'ok',value:{...value,method:'sendDocument'}},{op:'import',key:'ok',value,createdAt:f.now+1}])assert.equal(request(body,sql,f.now).status,400);
 db.prepare('INSERT INTO telegram_file_cache VALUES (?,?,?)').run('ok','{broken',f.now);
 assert.equal((await request({op:'get',key:'ok'},sql,f.now).json()).value,null);
 assert.equal(await cache({...f.env,ADMIN_STATS:{getByName(){throw Error('offline');}}},'get','ok'),null);
 assert.equal(await cache({...f.env,ADMIN_STATS:undefined},'get','ok'),null);
 }finally{f.close();}
});
