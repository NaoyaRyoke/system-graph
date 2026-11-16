import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryWorkStore,FileWorkStore,reevaluateNotice,transitionWork,type WorkStore } from '../src/platform/remediation.js';
import { composition,asOf,vulnerability,artifact } from './platform-fixtures.js';
import { notice } from './eol-fixtures.js';

const opts={tenant:'tenant-a',workspace:'main',asOf,trigger:'composition_updated' as const};
test('CVE/EOL work is idempotent, preserves workflow history and resolves only after observed redeployment',async()=>{
  for(const n of [vulnerability,notice]) {
    const store=new MemoryWorkStore(),s=await composition();
    const first=await reevaluateNotice(n,s,store,opts);assert.equal(first.length,1);assert.equal(first[0]!.state,'investigating');
    const duplicate=await reevaluateNotice(n,s,store,opts);assert.deepEqual(duplicate,first);
    const planned=await transitionWork(store,{tenant:'tenant-a',workspace:'main',id:first[0]!.id,expectedVersion:1,state:'planned',at:asOf,reason:'Upgrade scheduled'});
    const pending=await transitionWork(store,{tenant:'tenant-a',workspace:'main',id:first[0]!.id,expectedVersion:planned.version,state:'awaiting_verification',at:asOf,reason:'Deployment requested'});
    assert.equal((await reevaluateNotice(n,s,store,opts))[0]!.state,'awaiting_verification');
    const current=artifact('2.0.0','b'),updated=structuredClone(s);updated.id='snapshot-updated';
    for(const d of updated.deployments.filter(d=>d.environment==='production')) {
      d.artifactId=current.id;d.artifactDigest=current.digest;d.image=current.image;d.products[0]!.version='2.0.0';
    }
    const resolved=await reevaluateNotice(n,updated,store,{...opts,trigger:'redeployed'});
    assert.equal(resolved.length,1);assert.equal(resolved[0]!.id,pending.id);assert.equal(resolved[0]!.state,'resolved');
    assert.equal(resolved[0]!.snapshotId,'snapshot-updated');assert.equal(resolved[0]!.history.length,4);
    assert.deepEqual(await reevaluateNotice(n,updated,store,{...opts,trigger:'redeployed'}),resolved);
    await assert.rejects(transitionWork(store,{tenant:'tenant-a',workspace:'main',id:resolved[0]!.id,expectedVersion:resolved[0]!.version,state:'planned',at:asOf,reason:'invalid manual reopening'}));
  }
});
test('mixed redeployment reports residual and resolved targets, while deletion and collection gaps never auto-close',async()=>{
  const store=new MemoryWorkStore(),s=await composition(),prod=s.deployments.find(d=>d.environment==='production')!;
  s.deployments.push({...structuredClone(prod),id:'deployment-second',name:'service-b',serviceId:'service-b'});
  const initial=await reevaluateNotice(vulnerability,s,store,opts);assert.equal(initial.length,2);
  const changed=structuredClone(s),newArtifact=artifact('2.0.0','b');changed.id='mixed';
  changed.deployments[0]!.artifactId=newArtifact.id;changed.deployments[0]!.artifactDigest=newArtifact.digest;
  const evaluated=await reevaluateNotice(vulnerability,changed,store,{...opts,trigger:'redeployed'});
  assert.equal(evaluated.filter(r=>r.state==='resolved').length,1);assert.equal(evaluated.filter(r=>r.status==='affected').length,1);
  const absent=structuredClone(changed);absent.id='absent';absent.deployments=[];
  const unknown=await reevaluateNotice(vulnerability,absent,store,opts);
  assert.ok(unknown.every(r=>r.status==='unknown'&&r.state!=='resolved'));
  const partial=structuredClone(changed);partial.id='partial';partial.coverage.push({repositoryId:'repo-a',environment:'production',reason:'collection_failed',source:'runtime'});
  assert.equal((await reevaluateNotice(vulnerability,partial,store,opts)).filter(r=>r.state==='resolved').length,0);
});
test('file work store persists records with optimistic concurrency and tenant isolation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'platform-work-'));
  try {
    const store:WorkStore=await FileWorkStore.open(root),s=await composition();
    const records=await reevaluateNotice(vulnerability,s,store,opts),r=records[0]!;
    assert.deepEqual(await (await FileWorkStore.open(root)).get('tenant-a','main',r.id),r);
    assert.deepEqual(await store.list('tenant-b','main'),[]);
    await assert.rejects(store.save({...r,version:2},0));
    assert.equal((await reevaluateNotice({...vulnerability,revision:'r2'},s,store,{...opts,trigger:'notice_updated'}))[0]!.version,2);
    assert.equal((await store.list('tenant-a','main')).length,1);
  }finally{assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
