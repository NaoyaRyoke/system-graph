import { importCycloneDx,ingestRuntime,MemoryRuntimeSource,type Artifact,type Deployment,type CompositionSnapshot } from '../src/platform/composition.js';
import type { VulnerabilityNotice } from '../src/platform/vulnerability.js';
import type { GraphEvidence,GraphSnapshot } from '../src/platform/graph.js';
import { fileURLToPath } from 'node:url';
import type { RepositoryRegistration } from '../src/platform/collect.js';
import { operations } from '../src/contracts.js';
import { notice } from './eol-fixtures.js';
export const asOf='2026-11-16T00:00:00Z';
export function impactGraph(consumers=2):GraphSnapshot {
  const ev={id:'evidence-a',source:'src/main.ts',extractor:'fixture',confidence:'confirmed' as const,observedAt:asOf,repositoryId:'repo-a',environment:'production'};
  return {schemaVersion:1,id:'snapshot-a',collectedAt:asOf,coverage:[],observations:[],context:{compatibility:{'package-a':'breaking'},criticality:{'service-0':'critical'}},
    nodes:[{id:'package-a',kind:'package',label:'package-a',repositoryId:null,environment:null,shared:true,attributes:{},evidence:[ev]},
      ...Array.from({length:consumers},(_,i)=>({id:`service-${i}`,kind:'service' as const,label:`service-${i}`,repositoryId:i%2?'repo-b':'repo-a',environment:'production',shared:false,attributes:{},evidence:[{...ev,repositoryId:i%2?'repo-b':'repo-a'}]}))],
    edges:Array.from({length:consumers},(_,i)=>({id:`edge-${i}`,source:`service-${i}`,target:'package-a',kind:'depends_on',propagatesImpact:true,dependencyKind:'resolved' as const,declaredRange:null,evidence:[{...ev,repositoryId:i%2?'repo-b':'repo-a'}]}))};
}
export const evidence=(repositoryId='repo-a',environment:string|null='production'):GraphEvidence=>({id:`evidence-${repositoryId}`,source:'fixtures/runtime.json',extractor:'fixture-v1',confidence:'confirmed',observedAt:asOf,repositoryId,environment});
export function sbom(version='1.1.0') {
  return {bomFormat:'CycloneDX',specVersion:'1.6',version:1,
    metadata:{component:{type:'application',name:'service-a','bom-ref':'root',version:'1.0.0',purl:'pkg:npm/service-a@1.0.0'}},
    components:[{type:'library',name:'middle-a','bom-ref':'middle',version:'1.0.0',purl:'pkg:npm/middle-a@1.0.0',scope:'required'},
      {type:'library',name:'library-a','bom-ref':'library',version,purl:`pkg:npm/library-a@${version}`,scope:'required'}],
    dependencies:[{ref:'root',dependsOn:['middle']},{ref:'middle',dependsOn:['library']},{ref:'library',dependsOn:[]}],
    compositions:[{aggregate:'complete',assemblies:['root']}],};
}
export function artifact(version='1.1.0',letter='a'):Artifact {
  return importCycloneDx(sbom(version),{repositoryId:'repo-a',revision:`revision-${letter}`,digest:'sha256:'+letter.repeat(64),image:`service-a:${letter}`,observedAt:asOf,evidence:[evidence('repo-a',null)]});
}
export function deployment(a:Artifact,environment:string|null='production',name='service-a'):Omit<Deployment,'id'|'artifactId'> {
  return {name,repositoryId:'repo-a',environment,cluster:'cluster-a',account:'account-a',namespace:'team-a',serviceId:'service-a',ownerTeam:'team-a',
    artifactDigest:a.digest,image:a.image,observedAt:asOf,state:'observed',products:[{id:'runtime-product-a',product:'product-a',vendor:'vendor-a',releaseLine:'1',version:a.sbom.components.find(c=>c.name==='library-a')!.version,
      support:{tier:'standard',conditions:{}},observedAt:asOf,evidence:[{id:'product-evidence',source:'runtime/products.json',extractor:'fixture-v1',confidence:'confirmed'}]}],
    evidence:[evidence('repo-a',environment)]};
}
export async function composition():Promise<CompositionSnapshot>{
  const old=artifact(),current=artifact('2.0.0','b');
  return ingestRuntime(new MemoryRuntimeSource({schemaVersion:1,deployments:[deployment(old),deployment(current,'staging')],coverage:[]}),[old,current],{snapshotId:'snapshot-a',asOf});
}
export const vulnerability:VulnerabilityNotice={schemaVersion:1,kind:'vulnerability',id:'cve-test-a',revision:'r1',updatedAt:'2026-11-01T00:00:00Z',
  evidence:[{id:'advisory-evidence',source:'notices/cve-test-a.json',extractor:'fixture-v1',confidence:'confirmed'}],
  rules:[{packageUrl:'pkg:npm/library-a',versions:{scheme:'semver',introduced:'1.0.0',fixed:'2.0.0'}}]};
export const sourceRegistrations:RepositoryRegistration[]=['a','b'].map(s=>({repositoryId:`repo-${s}`,serviceId:`service-${s}`,revision:'revision-a',environment:'production',baseUrl:`http://service-${s}.invalid`}));
export const sourceRoots=Object.fromEntries(['a','b'].map(s=>[`repo-${s}`,fileURLToPath(new URL(`../../tests/fixtures/platform/service-${s}`,import.meta.url))]));
export function platformConfig(){
  const old=artifact(),current=artifact('2.0.0','b');
  const inputs=[old,current].map(({sbom,id: _id,...metadata})=>({sbom:{bomFormat:'CycloneDX',specVersion:'1.6',version:1,
    metadata:{component:{type:'application',name:'service-a','bom-ref':'root',version:'1.0.0',purl:'pkg:npm/service-a@1.0.0'}},
    components:sbom.components.filter(c=>c.ref!=='root').map(c=>({type:'library',name:c.name,'bom-ref':c.ref,version:c.version,purl:c.packageUrl,scope:c.dependencyScope})),
    dependencies:sbom.dependencies,compositions:[{aggregate:'complete',assemblies:['root']}]},metadata}));
  return {version:1,localPrincipal:{tenant:'tenant-a',principal:'reader-a'},
    workspace:{tenant:'tenant-a',workspace:'main',repositories:{'service-a':'repo-a','service-b':'repo-b'},allowedEnvironments:['production','staging','unknown'],status:'active'},
    permissions:[{tenant:'tenant-a',principal:'reader-a',workspace:'main',repositories:['service-a','service-b'],environments:['production'],operations}],
    notices:[structuredClone(notice),structuredClone(vulnerability)],source:{snapshotId:'snapshot-a',asOf,
      repositories:sourceRegistrations.map(r=>({...r,root:sourceRoots[r.repositoryId]!})),artifacts:inputs,
      runtime:{schemaVersion:1,deployments:[deployment(old),deployment(current,'staging')],coverage:[]}}};
}
