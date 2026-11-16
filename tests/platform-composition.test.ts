import test from 'node:test';
import assert from 'node:assert/strict';
import { compositionToEol,connectComposition,importCycloneDx,ingestRuntime,MemoryRuntimeSource,scopeComposition,parsePackageUrl } from '../src/platform/composition.js';
import { evaluateVulnerability,compareSemver } from '../src/platform/vulnerability.js';
import { evaluateEol } from '../src/eol/evaluate.js';
import { impact,scopeGraph,type GraphSnapshot } from '../src/platform/graph.js';
import { asOf,artifact,composition,deployment,sbom,vulnerability } from './platform-fixtures.js';
import { notice } from './eol-fixtures.js';

test('SBOM exact versions and transitive paths bind old production artifact even after new source/build exists',async()=>{
  const s=await composition(),r=evaluateVulnerability(vulnerability,s,{asOf});
  assert.equal(r.counts.affected,1);assert.equal(r.counts.not_affected,1);
  const affected=r.items.find(i=>i.environment==='production')!;
  assert.equal(affected.status,'affected');assert.equal(affected.exploitability,'not_assessed');
  assert.deepEqual(affected.artifact!.matches[0]!.dependencyPath,['root','middle','library']);
  assert.equal(affected.artifact!.matches[0]!.dependencyDepth,2);
  assert.equal(affected.artifact!.revision,'revision-a');
  assert.equal(r.items.find(i=>i.environment==='staging')!.artifact!.revision,'revision-b');
  const eol=evaluateEol(notice,compositionToEol(s),{asOf});assert.equal(eol.counts.affected,1);
});
test('environment/cluster/account/namespace produce distinct deployments; tags never substitute for observed digests',async()=>{
  const a=artifact(),d=deployment(a),records=[d,{...d,cluster:'cluster-b'},{...d,account:'account-b'},{...d,namespace:'team-b'},{...d,environment:null}];
  const s=await ingestRuntime(new MemoryRuntimeSource({schemaVersion:1,deployments:records}),[a],{snapshotId:'runtime-a',asOf});
  assert.equal(new Set(s.deployments.map(d=>d.id)).size,5);
  const missing=await ingestRuntime(new MemoryRuntimeSource({schemaVersion:1,deployments:[{...d,artifactDigest:null}]}),[a],{snapshotId:'missing',asOf});
  assert.equal(evaluateVulnerability(vulnerability,missing,{asOf}).status,'unknown');
  const declared=await ingestRuntime(new MemoryRuntimeSource({schemaVersion:1,deployments:[{...d,state:'declared'}]}),[a],{snapshotId:'declared',asOf});
  assert.equal(evaluateVulnerability(vulnerability,declared,{asOf}).items[0]!.status,'unknown');
});
test('partial/opaque SBOM and unknown versions never prove absence; different package and fixed versions are excluded',async()=>{
  const s=await composition();s.artifacts[0]!.sbom.complete=false;s.artifacts[0]!.sbom.gaps=['partial_collection'];
  const other={...vulnerability,rules:[{packageUrl:'pkg:npm/other',versions:{scheme:'exact' as const,versions:['1.0.0']}}]};
  assert.equal(evaluateVulnerability(other,s,{asOf}).items.find(i=>i.environment==='production')!.status,'unknown');
  const known=await composition();assert.equal(evaluateVulnerability(other,known,{asOf}).status,'not_affected');
  known.artifacts[0]!.sbom.components.find(c=>c.name==='library-a')!.version=null;
  assert.equal(evaluateVulnerability(vulnerability,known,{asOf}).items.find(i=>i.environment==='production')!.status,'unknown');
  assert.throws(()=>importCycloneDx({...sbom(),specVersion:'1.5'},artifact()));
  const opaque=sbom();opaque.dependencies.pop();assert.equal(importCycloneDx(opaque,artifact()).sbom.complete,false);
});
test('runtime scope hides staging artifacts and composition graph retains permitted package -> artifact -> deployment -> service paths',async()=>{
  const s=await composition(),scoped=scopeComposition(s,{repositories:['repo-a'],environments:['production']});
  assert.equal(scoped.deployments.length,1);assert.equal(scoped.artifacts.length,1);assert.ok(!JSON.stringify(scoped).includes('revision-b'));
  const empty:GraphSnapshot={schemaVersion:1,id:s.id,collectedAt:asOf,nodes:[],edges:[],coverage:[],observations:[],context:{compatibility:{},criticality:{}}};
  const connected=scopeGraph(connectComposition(empty,s),{repositories:['repo-a'],environments:['production']});
  const component=connected.nodes.find(n=>n.kind==='package'&&n.attributes.version==='1.1.0')!;
  assert.ok(component);assert.ok(impact(connected,{target:component.id,asOf}).items.some(i=>i.node.kind==='deployment'));
  assert.ok(!JSON.stringify(connected).includes('revision-b'));
});
test('SemVer precedence, numeric/exact ranges, unsupported PURLs and stale runtime remain explicit',async()=>{
  assert.ok(compareSemver('1.0.0-alpha.2','1.0.0-alpha.10')<0);assert.ok(compareSemver('1.0.0-rc.1','1.0.0')<0);
  assert.equal(compareSemver('1.0.0+build-a','1.0.0+build-b'),0);assert.throws(()=>compareSemver('01.0.0','1.0.0'));
  assert.equal(parsePackageUrl('pkg:npm/%40scope/library@1.2.3')!.identity,'pkg:npm/%40scope/library');
  assert.equal(parsePackageUrl('pkg:npm/library?arch=x64'),null);
  const uncertain=evaluateVulnerability({...vulnerability,evidence:[]},await composition(),{asOf});
  assert.ok(uncertain.artifacts.every(a=>a.status==='unknown'));
  const s=await composition();s.deployments[0]!.observedAt='2020-01-01T00:00:00Z';
  assert.equal(evaluateVulnerability(vulnerability,s,{asOf}).items.find(i=>i.environment==='production')!.status,'unknown');
});
test('EOL conversion cannot hide missing, stale or inferred runtime proof behind abundant product evidence',async()=>{
  for(const missing of ['none','stale','inferred'] as const) {
    const s=await composition(),d=s.deployments.find(d=>d.environment==='production')!;
    d.products[0]!.evidence=Array.from({length:16},(_,i)=>({id:`product-${i}`,source:'products.json',extractor:'fixture',confidence:'confirmed'}));
    if(missing==='none')d.evidence=[];
    else if(missing==='stale')d.evidence[0]!.observedAt='2020-01-01T00:00:00Z';
    else d.evidence[0]!.confidence='inferred';
    const r=evaluateEol(notice,compositionToEol(s),{asOf});
    assert.equal(r.items.find(i=>i.environment==='production')!.status,'unknown');assert.equal(r.complete,false);
  }
});
