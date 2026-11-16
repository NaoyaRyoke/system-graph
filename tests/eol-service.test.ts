import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type AuditEvent } from '../src/contracts.js';
import { EolQueryService, MemoryEolSources, evaluateEol, type EolSources } from '../src/eol/index.js';
import { handleEol } from '../src/eol/mcp.js';
import { buildEolStdioRuntime } from '../src/eol/stdio.js';
import { PolicyEngine } from '../src/service.js';
import { asOf, eolConfig, notice, snapshot } from './eol-fixtures.js';

export const query={workspace:'main',noticeId:'notice-a',noticeRevision:'r1',snapshotId:'snapshot-a',asOf,limit:20,offset:0};
const isError=(code:string)=>(e:unknown)=>e instanceof ApiError&&e.code===code;

test('scope filters assets, service links, gaps and counts before matching; unknown environment requires explicit access',async()=>{
  const cfg=eolConfig(), s=cfg.snapshots[0]!,base=s.assets[0]!;
  s.assets.push({...base,id:'asset-foreign',repositoryId:'repo-secret',serviceId:'service-secret'},
    {...base,id:'asset-staging',environment:'staging',version:'2.0.0'},
    {...base,id:'asset-unknown',environment:null});
  s.coverage.push({repositoryId:'repo-secret',environment:'production',reason:'collection_failed'},
    {repositoryId:'repo-a',environment:'staging',reason:'collection_failed'});
  const r=buildEolStdioRuntime(cfg);
  const result=await r.service.execute(r.principal,query);
  assert.equal(result.total,60); assert.equal(result.complete,true);
  assert.deepEqual(result,evaluateEol(notice,snapshot(60),{asOf}));
  assert.ok(!JSON.stringify(result).includes('secret'));
  await assert.rejects(r.service.execute(r.principal,{...query,environments:['unknown']}),isError('permission_denied'));
  cfg.permissions[0]!.environments.push('staging','unknown');
  const all=buildEolStdioRuntime(cfg);
  const unknown=await all.service.execute(all.principal,{...query,environments:['unknown']});
  assert.equal(unknown.total,1); assert.equal(unknown.items[0]!.environment,null);
  const staging=await all.service.execute(all.principal,{...query,environments:['staging']});
  assert.equal(staging.items[0]!.status,'unknown');assert.ok(staging.items[0]!.missing.includes('coverage.collection_failed'));assert.equal(staging.status,'unknown');
});

test('authorization and strict inputs precede data access; source binding and revision pinning fail closed',async()=>{
  const cfg=eolConfig(),r=buildEolStdioRuntime(cfg);
  for(const q of [{...query,workspace:'absent'},{...query,repositories:['foreign']},{...query,environments:['staging']}])
    await assert.rejects(r.service.execute(r.principal,q),isError('permission_denied'));
  for(const principal of [{...r.principal,tenant:'tenant-b'},{...r.principal,expiresAt:0}])
    await assert.rejects(r.service.execute(principal,query),isError(principal.expiresAt===0?'unauthenticated':'permission_denied'));
  for(const q of [{...query,tenant:'tenant-b'},{...query,path:'../other'},{...query,url:'https://fixture.invalid'},
    {...query,limit:51},{...query,noticeRevision:'r2'}])
    await assert.rejects(r.service.execute(r.principal,q),isError('invalid_request'));
  await assert.rejects(r.service.execute(r.principal,{...query,snapshotId:'absent'}),isError('not_found'));
  const abort=new AbortController();abort.abort();
  await assert.rejects(r.service.execute(r.principal,query,abort.signal),isError('cancelled'));
  const sources=new MemoryEolSources([{tenant:'tenant-b',workspace:'main',notices:[notice],snapshots:[snapshot()]}]);
  assert.equal(await sources.notices.getNotice('tenant-a','main','notice-a'),undefined);
  assert.equal(await sources.snapshots.getSnapshot('tenant-b','other','snapshot-a'),undefined);
  const copy=await sources.snapshots.getSnapshot('tenant-b','main','snapshot-a');
  copy!.assets[0]!.version='changed';
  assert.equal((await sources.snapshots.getSnapshot('tenant-b','main','snapshot-a'))!.assets[0]!.version,'1.4.0');
  assert.throws(()=>new MemoryEolSources([{tenant:'tenant-a',workspace:'main',notices:[notice,notice],snapshots:[]}]));
});

test('source failures, mismatched IDs, rate limits and audit outcomes do not become empty safe assessments',async()=>{
  const r=buildEolStdioRuntime(eolConfig()),audit:AuditEvent[]=[];
  let reads=0;
  const sources:EolSources={notices:{getNotice:async()=>{reads++;return notice;}},snapshots:{getSnapshot:async()=>snapshot()}};
  const hooks={audit:{record:(e:AuditEvent)=>{audit.push(e);}},metrics:{observe:()=>{}},rateLimit:{admit:()=>({allow:true,retryAfter:0})}};
  const service=new EolQueryService(r.service.policy,sources,hooks);
  await assert.rejects(service.execute({...r.principal,tenant:'tenant-b'},query),isError('permission_denied'));
  assert.equal(reads,0);assert.equal(audit.at(-1)!.allowed,false);
  sources.snapshots.getSnapshot=async()=>({...snapshot(),id:'wrong'});
  await assert.rejects(service.execute(r.principal,query),isError('graph_unavailable'));
  sources.snapshots.getSnapshot=async()=>{throw new Error('sensitive upstream message');};
  const envelope=await handleEol({service,principal:r.principal,signal:new AbortController().signal},query);
  assert.equal(envelope.isError,true);assert.ok(!JSON.stringify(envelope).includes('sensitive'));
  assert.equal(audit.at(-1)!.outcome,'internal_error');
  const limited=new EolQueryService(r.service.policy,sources,{...hooks,rateLimit:{admit:()=>({allow:false,retryAfter:2})}});
  await assert.rejects(limited.execute(r.principal,query),isError('rate_limited'));
  assert.equal(audit.at(-1)!.outcome,'rate_limited');
});

test('MCP projection redacts paths and sensitive product text and enforces response size',async()=>{
  const cfg=eolConfig();
  cfg.snapshots[0]!.assets[0]!.evidence[0]!.source='/private/runtime.json';
  cfg.snapshots[0]!.assets[0]!.product='secret=synthetic';
  const r=buildEolStdioRuntime(cfg),result=await r.service.execute(r.principal,query);
  assert.ok(!JSON.stringify(result).includes('/private'));assert.ok(!JSON.stringify(result).includes('secret=synthetic'));
  const big=eolConfig();big.snapshots[0]=snapshot(50);
  for(const a of big.snapshots[0]!.assets)a.evidence=Array.from({length:16},(_,i)=>({id:`evidence-${i}`,source:'x'.repeat(256),extractor:'x'.repeat(128),confidence:'confirmed'}));
  const br=buildEolStdioRuntime(big);
  await assert.rejects(br.service.execute(br.principal,{...query,limit:50}),isError('response_too_large'));
});

test('configuration refuses unknown fields, disabled workspace and unbound local identity',()=>{
  for(const change of [
    (c:ReturnType<typeof eolConfig>)=>({...c,path:'arbitrary'}),
    (c:ReturnType<typeof eolConfig>)=>({...c,localPrincipal:{principal:'foreign',tenant:'tenant-a'}}),
    (c:ReturnType<typeof eolConfig>)=>({...c,workspace:{...c.workspace,status:'disabled'}}),
  ])assert.throws(()=>buildEolStdioRuntime(change(eolConfig())));
  // No native graph/engine is ever consulted by this service.
  assert.ok(buildEolStdioRuntime(eolConfig()).service.policy instanceof PolicyEngine);
});
