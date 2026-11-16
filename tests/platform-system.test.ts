import test from 'node:test';
import assert from 'node:assert/strict';
import { SystemCoordinator,InlineJobs,systemSnapshotSchema } from '../src/platform/system.js';
import { MemoryRepositorySource } from '../src/platform/collect.js';
import { MemorySnapshotStore } from '../src/platform/storage.js';
import { MemoryWorkStore } from '../src/platform/remediation.js';
import { platformConfig,asOf,sourceRegistrations } from './platform-fixtures.js';
import { buildPlatformRuntime } from '../src/platform/runtime.js';
import { impact } from '../src/platform/graph.js';
import { evaluateVulnerability } from '../src/platform/vulnerability.js';
import { vulnerability } from './platform-fixtures.js';

test('coordinator retains immutable old artifacts across build updates and represents repository/runtime collection failures',async()=>{
  const cfg=platformConfig(),repos=new MemoryRepositorySource({'repo-a':[{path:'main.ts',content:'export const a=1;'}],'repo-b':[]});
  let runtimeFails=false;
  const store=new MemorySnapshotStore(systemSnapshotSchema.parse),work=new MemoryWorkStore();
  const coordinator=new SystemCoordinator({repositories:repos,artifacts:{read:async()=>cfg.source.artifacts},runtime:{read:async()=>{
    if(runtimeFails)throw Error('synthetic outage');return cfg.source.runtime;
  }},notifications:{read:async()=>cfg.notices}},store,work);
  const options={tenant:'tenant-a',workspace:'main',asOf,repositories:sourceRegistrations,trigger:'composition_updated' as const};
  const first=await coordinator.refresh({...options,snapshotId:'system-a'});
  assert.equal(first.records.length,2);
  cfg.source.artifacts=cfg.source.artifacts.slice(1); // Only the newer build is returned now.
  const second=await coordinator.refresh({...options,snapshotId:'system-b',previousSnapshotId:'system-a'});
  assert.equal(second.snapshot.composition.artifacts.length,2);
  assert.equal(evaluateVulnerability(vulnerability,second.snapshot.composition,{asOf}).counts.affected,1);
  runtimeFails=true;repos.files['repo-a']=new Error('synthetic source outage');
  const failed=await coordinator.refresh({...options,snapshotId:'system-c',previousSnapshotId:'system-b'});
  assert.ok(failed.snapshot.graph.coverage.some(g=>g.reason==='collection_failed'));
  assert.equal(impact(failed.snapshot.graph,{target:'service-a',asOf}).complete,false);
  assert.ok(failed.records.every(r=>r.state!=='resolved'));
});
test('notification acquisition failure remains an error and does not close existing records',async()=>{
  const cfg=platformConfig(),store=new MemorySnapshotStore(systemSnapshotSchema.parse),work=new MemoryWorkStore();
  let failed=false;
  const coordinator=new SystemCoordinator({repositories:new MemoryRepositorySource({'repo-a':[],'repo-b':[]}),artifacts:{read:async()=>cfg.source.artifacts},
    runtime:{read:async()=>cfg.source.runtime},notifications:{read:async()=>{if(failed)throw Error('synthetic notification outage');return cfg.notices;}}},store,work);
  const options={tenant:'tenant-a',workspace:'main',asOf,repositories:sourceRegistrations,trigger:'notice_updated' as const};
  await coordinator.refresh({...options,snapshotId:'before'});const before=await work.list('tenant-a','main');failed=true;
  await assert.rejects(coordinator.refresh({...options,snapshotId:'after',previousSnapshotId:'before'}));
  assert.deepEqual(await work.list('tenant-a','main'),before);
});
test('local startup validates identity before reading sources and rejects duplicate notice IDs',async()=>{
  const cfg=platformConfig();
  await assert.rejects(buildPlatformRuntime({...cfg,localPrincipal:{tenant:'tenant-b',principal:'reader-a'}}));
  await assert.rejects(buildPlatformRuntime({...cfg,workspace:{...cfg.workspace,status:'disabled'}}));
  await assert.rejects(buildPlatformRuntime({...cfg,notices:[...cfg.notices,cfg.notices[0]!]}));
});
test('inline job runner rejects overlapping refreshes and releases its slot after failure',async()=>{
  const jobs=new InlineJobs();let finish:()=>void=()=>{};
  const running=jobs.run('same',()=>new Promise<void>(resolve=>{finish=resolve;}));
  await assert.rejects(jobs.run('same',async()=>{}));finish();await running;
  await assert.rejects(jobs.run('same',async()=>{throw Error('synthetic');}));
  assert.equal(await jobs.run('same',async()=>42),42);
});
