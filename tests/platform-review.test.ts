import test from 'node:test';
import assert from 'node:assert/strict';
import { importCycloneDx,compositionToEol,connectComposition,scopeComposition } from '../src/platform/composition.js';
import { impact,trace,scopeGraph } from '../src/platform/graph.js';
import { collectRepositories,MemoryRepositorySource } from '../src/platform/collect.js';
import { emptyGraph } from '../src/platform/system.js';
import { MemoryWorkStore,reevaluateNotice } from '../src/platform/remediation.js';
import { evaluateVulnerability } from '../src/platform/vulnerability.js';
import { evaluateEol } from '../src/eol/evaluate.js';
import { buildPlatformRuntime } from '../src/platform/runtime.js';
import { asOf,composition,sbom,artifact,vulnerability,platformConfig,sourceRegistrations,impactGraph } from './platform-fixtures.js';
import { notice } from './eol-fixtures.js';
import { conflictingSnapshot } from './review-fixtures.js';

const prod={repositories:['repo-a'],environments:['production']};
test('[A] conflicting SBOM remains uncertain after production scope and cannot resolve work',async()=>{
  const {updated}=await conflictingSnapshot();
  const scoped=scopeComposition(updated.snapshot.composition,prod);
  const result=evaluateVulnerability(vulnerability,scoped,{asOf});
  assert.equal(result.status,'unknown');assert.equal(result.complete,false);
  assert.equal(result.items[0]!.status,'unknown');
  assert.ok(updated.records.every(r=>r.state!=='resolved'));
  assert.ok(scopeGraph(updated.snapshot.graph,prod).coverage.length>0);
});
test('[B] dependency-only composition does not prove the absence of an unlisted package',()=>{
  const input={...sbom(),compositions:[{aggregate:'complete',dependencies:['middle']}]};
  const a=importCycloneDx(input,artifact());
  assert.equal(a.sbom.complete,false);assert.ok(a.sbom.gaps.length>0);
});
test('[C] logical service remains in each authorized environment regardless of source/deployment order',async()=>{
  const previous=new Map<string,unknown>();
  for(const withSource of [false,true])for(const reverse of [false,true]){
    const s=await composition();if(reverse)s.deployments.reverse();
    const g=withSource?await collectRepositories([sourceRegistrations[0]!],new MemoryRepositorySource({'repo-a':[]}),{snapshotId:s.id,asOf}):emptyGraph(s.id,asOf);
    const linked=connectComposition(g,s);
    for(const environments of [['production'],['staging'],['production','staging']]){
      const visible=scopeGraph(linked,{repositories:['repo-a'],environments});
      const target=visible.nodes.find(n=>n.kind==='package'&&n.attributes.version===(environments[0]==='production'?'1.1.0':'2.0.0'))!;
      assert.ok(target);assert.ok(visible.nodes.some(n=>n.id==='service-a'));
      const aggregation=impact(visible,{target:target.id,asOf}).serviceAggregation;
      assert.ok(aggregation.some(s=>s.serviceId==='service-a'));
      assert.ok(visible.nodes.flatMap(n=>n.evidence).every(e=>e.environment===null||environments.includes(e.environment)));
      const key=String(withSource)+environments.join(',');if(reverse)assert.deepEqual(aggregation,previous.get(key));else previous.set(key,aggregation);
    }
  }
});
test('[D] OpenAPI server base path connects the caller for either trailing-slash form',async()=>{
  for(const server of ['https://service-b.invalid/v1','https://service-b.invalid/v1/']){
    const sources=new MemoryRepositorySource({'repo-a':[{path:'main.ts',content:'export const load = () => fetch("https://service-b.invalid/v1/items");'}],
      'repo-b':[{path:'openapi.json',content:JSON.stringify({openapi:'3.1.0',servers:[{url:server}],paths:{'/items':{get:{responses:{}}}}})}]});
    const g=await collectRepositories(sourceRegistrations,sources,{snapshotId:'api-paths',asOf});
    assert.ok(impact(g,{target:'service-b',asOf}).items.some(i=>i.node.id==='service-a'));
    assert.equal(trace(g,{source:'service-a',destination:'service-b',asOf}).found,true);
  }
});
test('[E] inventory edges can be reconstructed independently from one-node pages',async()=>{
  const {source:_source,...base}=platformConfig(),g=impactGraph();
  const r=await buildPlatformRuntime({...base,notices:[],snapshots:[{schemaVersion:1,id:g.id,graph:g,composition:{schemaVersion:1,id:g.id,collectedAt:asOf,artifacts:[],deployments:[],coverage:[]}}]});
  for(const operation of ['inventory','query'] as const){
    const edgeIds=new Set<string>(),nodeIds=new Set<string>();let edgeOffset:number|null=0;
    for(let offset=0;offset<3;offset++){
      const result=await r.service.execute(r.principal,operation,{workspace:'main',snapshotId:g.id,asOf,limit:1,offset,edgeOffset,edgeLimit:1,...(operation==='query'?{query:'-'}:{})});
      for(const n of result.nodes as {id:string}[]){assert.ok(!nodeIds.has(n.id));nodeIds.add(n.id);}
      for(const e of result.edges as {id:string}[]){assert.ok(!edgeIds.has(e.id));edgeIds.add(e.id);}
      edgeOffset=(result.edgePaging as {nextOffset:number|null}).nextOffset;
    }
    assert.equal(nodeIds.size,3);assert.equal(edgeIds.size,2);
  }
});
test('[F] future product, deployment and runtime evidence cannot hide behind an older observation',async()=>{
  for(const source of ['product','deployment','runtime'] as const){
    const s=await composition(),d=s.deployments.find(d=>d.environment==='production')!;
    d.products[0]!.version='2.0.0';
    if(source==='product')d.products[0]!.observedAt='2027-01-01T00:00:00Z';
    if(source==='deployment')d.observedAt='2027-01-01T00:00:00Z';
    if(source==='runtime')d.evidence[0]!.observedAt='2027-01-01T00:00:00Z';
    const r=evaluateEol(notice,compositionToEol(s),{asOf});
    assert.equal(r.items.find(i=>i.environment==='production')!.status,'unknown',source);
    const records=await reevaluateNotice(notice,s,new MemoryWorkStore(),{tenant:'tenant-a',workspace:'main',asOf,trigger:'redeployed'});
    assert.ok(records.every(r=>r.state!=='resolved'));
  }
});
test('[G] service API redaction preserves valid colon IDs in graph edges',async()=>{
  const {source:_source,...base}=platformConfig(),g=impactGraph();g.nodes[1]!.id='service:alpha';g.edges[0]!.source='service:alpha';
  g.nodes[1]!.attributes={id:'secret:attribute',source:'secret:attribute',target:'package-a',kind:'custom',password:'synthetic'};
  g.nodes[1]!.evidence[0]!.source='C:/private/fixture.ts';
  const r=await buildPlatformRuntime({...base,notices:[],snapshots:[{schemaVersion:1,id:g.id,graph:g,composition:{schemaVersion:1,id:g.id,collectedAt:asOf,artifacts:[],deployments:[],coverage:[]}}]});
  const inventory=await r.service.execute(r.principal,'inventory',{workspace:'main',snapshotId:g.id,asOf});
  assert.ok((inventory.edges as {source:string}[]).some(e=>e.source==='service:alpha'));
  const node=(inventory.nodes as {id:string;attributes:Record<string,unknown>;evidence:{source:string}[]}[]).find(n=>n.id==='service:alpha')!;
  assert.equal(node.attributes.id,'[redacted]');assert.equal(node.attributes.source,'[redacted]');assert.ok(!('password'in node.attributes));assert.equal(node.evidence[0]!.source,'[redacted]');
});
test('[history] more than 256 unchanged periodic evaluations remain operational and idempotent',async()=>{
  const s=await composition(),work=new MemoryWorkStore();
  for(let i=0;i<300;i++)await reevaluateNotice(vulnerability,s,work,{tenant:'tenant-a',workspace:'main',asOf:new Date(Date.parse(asOf)+i*1000).toISOString(),trigger:'manual'});
  const records=await work.list('tenant-a','main');assert.equal(records.length,1);assert.equal(records[0]!.version,300);
});
test('[A] unrelated artifact and unknown-environment issues do not block verified healthy production',async()=>{
  const {updated,cfg,coordinator}=await conflictingSnapshot();
  const b=cfg.source.artifacts[1]!,c=b.sbom.components.find(c=>c['bom-ref']==='library')!;c.version='2.0.0';c.purl='pkg:npm/library-a@2.0.0';
  cfg.source.runtime.coverage.push({repositoryId:'repo-a',environment:null,reason:'collection_failed',source:'unknown-runtime'});
  const fixed=await coordinator.refresh({tenant:'tenant-a',workspace:'main',repositories:sourceRegistrations,asOf,trigger:'redeployed',snapshotId:'healthy-after-conflict',previousSnapshotId:updated.snapshot.id});
  assert.ok(fixed.records.every(r=>r.state==='resolved'));
  const s=fixed.snapshot.composition;
  s.coverage.push({repositoryId:'repo-a',environment:null,reason:'unsupported_or_invalid_sbom',source:'unrelated-sbom',appliesTo:{kind:'artifact',artifactId:s.artifacts.find(a=>a.digest!==b.metadata.digest)!.id}});
  const selected=scopeComposition(s,prod);assert.equal(selected.coverage.length,0);
  assert.equal(evaluateVulnerability(vulnerability,selected,{asOf}).status,'not_affected');
  const current=(await reevaluateNotice(vulnerability,s,new MemoryWorkStore(),{tenant:'tenant-a',workspace:'main',asOf,trigger:'redeployed'}));assert.equal(current.length,0);
});
test('[B] completeness never cascades from root or a direct dependency; full explicit declarations permit absence',async()=>{
  for(const declaration of [{aggregate:'complete',assemblies:['root']},{aggregate:'complete',dependencies:['middle']},{aggregate:'complete'}]){
    const input={...sbom(),compositions:[declaration]},a=importCycloneDx(input,artifact());
    const s=await composition();s.artifacts[0]=a;
    const missing={...vulnerability,rules:[{packageUrl:'pkg:npm/not-listed',versions:{scheme:'exact' as const,versions:['1.0.0']}}]};
    assert.equal(evaluateVulnerability(missing,scopeComposition(s,prod),{asOf}).status,'unknown');
    assert.equal(evaluateVulnerability(vulnerability,scopeComposition(s,prod),{asOf}).items[0]!.status,'affected');
  }
  const full=await composition(),missing={...vulnerability,rules:[{packageUrl:'pkg:npm/not-listed',versions:{scheme:'exact' as const,versions:['1.0.0']}}]};
  assert.equal(evaluateVulnerability(missing,scopeComposition(full,prod),{asOf}).status,'not_affected');
});
test('[F] both temporal bounds survive conversion, inclusive observation boundary and future support deadlines remain valid',async()=>{
  const s=await composition(),d=s.deployments.find(d=>d.environment==='production')!;
  d.products[0]!.support={tier:'extended',conditions:{'contract-active':true}};
  let r=evaluateEol(notice,compositionToEol(s),{asOf});assert.equal(r.items.find(i=>i.environment==='production')!.status,'not_affected');
  d.products[0]!.observedAt='2027-01-01T00:00:00Z';d.evidence[0]!.observedAt='2020-01-01T00:00:00Z';
  r=evaluateEol(notice,compositionToEol(s),{asOf});const row=r.items.find(i=>i.environment==='production')!;
  assert.ok(row.missing.includes('fresh_observation'));assert.ok(row.missing.includes('observation_at_or_before_asOf'));
  assert.equal(row.observationRange.earliest,'2020-01-01T00:00:00Z');assert.equal(row.observationRange.latest,'2027-01-01T00:00:00Z');
  const legacy=compositionToEol(await composition());for(const asset of legacy.assets)delete asset.observationRange;
  assert.ok(evaluateEol(notice,legacy,{asOf}).items.every(i=>i.status==='unknown'&&i.missing.includes('observation_range_requires_recollection')));
});
