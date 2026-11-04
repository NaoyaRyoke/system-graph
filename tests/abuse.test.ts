import test from 'node:test';import assert from 'node:assert/strict';
import { fixture,ids } from './support.js';import { ApiError } from '../src/contracts.js';
test('query/traversal abuse is bounded before engine execution; lexical input is never regex',async()=>{const f=fixture(),a=ids('alpha');try{
 for(const q of ['x'.repeat(100000),'(a+)+$'.repeat(10000)])await assert.rejects(f.service.execute(f.owner,'query',{workspace:'main',query:q}),(e:unknown)=>e instanceof ApiError&&e.code==='invalid_request');
 for(const maxDepth of [13,1e10,-1,1.5,'12'])await assert.rejects(f.service.execute(f.owner,'trace',{workspace:'main',source:a.reader,destination:a.api,maxDepth}));
 assert.equal(f.pool.clients.size,0);
 for(const query of ['*','(a+)+$']){try{const result=await f.service.execute(f.owner,'query',{workspace:'main',query,limit:50});assert.ok(result.hits.length<=50);}catch(e){assert.ok(e instanceof ApiError&&e.code==='invalid_request');}}
 for(let i=0;i<10;i++){const trace=await f.service.execute(f.owner,'trace',{workspace:'main',source:a.reader,destination:a.api,maxDepth:12});assert.equal(trace.segments.length,1);}
 assert.equal(f.pool.clients.size,1);
}finally{await f.close();}});
