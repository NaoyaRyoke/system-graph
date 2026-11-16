import { SystemCoordinator,systemSnapshotSchema,type SystemSnapshot } from '../src/platform/system.js';
import { MemoryRepositorySource } from '../src/platform/collect.js';
import { MemorySnapshotStore } from '../src/platform/storage.js';
import { MemoryWorkStore } from '../src/platform/remediation.js';
import { platformConfig,sourceRegistrations,asOf } from './platform-fixtures.js';
export async function conflictingSnapshot(){
  const cfg=platformConfig(),snapshots=new MemorySnapshotStore(systemSnapshotSchema.parse),work=new MemoryWorkStore();
  const coordinator=new SystemCoordinator({repositories:new MemoryRepositorySource({'repo-a':[],'repo-b':[]}),
    artifacts:{read:async()=>cfg.source.artifacts},runtime:{read:async()=>cfg.source.runtime},notifications:{read:async()=>cfg.notices}},snapshots,work);
  const options={tenant:'tenant-a',workspace:'main',repositories:sourceRegistrations,asOf,trigger:'composition_updated' as const};
  await coordinator.refresh({...options,snapshotId:'before-conflict'});
  const b=cfg.source.artifacts[1]!,d=cfg.source.runtime.deployments.find(d=>d.environment==='production')!;
  d.artifactDigest=b.metadata.digest;d.image=b.metadata.image;d.products[0]!.version='2.0.0';
  const c=b.sbom.components.find(c=>c['bom-ref']==='library')!;c.version='1.1.0';c.purl='pkg:npm/library-a@1.1.0';
  const updated=await coordinator.refresh({...options,snapshotId:'after-conflict',previousSnapshotId:'before-conflict'});
  return {cfg,updated,work,coordinator};
}
export function snapshotConfig(snapshot:SystemSnapshot,environments=['production']){
  const {source:_source,...cfg}=platformConfig();cfg.permissions[0]!.environments=environments;
  return {...cfg,snapshots:[snapshot]};
}
