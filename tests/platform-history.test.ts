import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryWorkStore,FileWorkStore,reevaluateNotice,transitionWork,HISTORY_WINDOW,type WorkStore } from '../src/platform/remediation.js';
import { stableId } from '../src/platform/storage.js';
import { composition,asOf,vulnerability } from './platform-fixtures.js';

const opts={tenant:'tenant-a',workspace:'main',asOf,trigger:'manual' as const};
async function fullHistory(store:WorkStore,id:string,version:number){
  const items=[];let offset=0;
  for(;;){const page=await store.getHistory('tenant-a','main',id,{offset,limit:37,expectedVersion:version});items.push(...page.items);if(page.nextOffset===null)break;offset=page.nextOffset;}
  return items;
}
test('unchanged evaluations coalesce with first/last time and count, retaining CAS and exact idempotency',async()=>{
  const store=new MemoryWorkStore(),s=await composition();
  for(let i=0;i<600;i++)await reevaluateNotice(vulnerability,s,store,{...opts,asOf:new Date(Date.parse(asOf)+i*1000).toISOString()});
  const r=(await store.list('tenant-a','main'))[0]!;
  assert.equal(r.version,600);assert.equal(r.schemaVersion,2);assert.equal(r.historyCount,1);assert.equal(r.history[0]!.evaluationCount,600);
  assert.equal(Date.parse(r.history[0]!.at),Date.parse(asOf));assert.equal(r.history[0]!.lastAt,r.evaluatedAt);
  assert.deepEqual(await reevaluateNotice(vulnerability,s,store,{...opts,asOf:r.evaluatedAt}),[r]);
  await assert.rejects(reevaluateNotice(vulnerability,s,store,opts));
  await assert.rejects(transitionWork(store,{tenant:'tenant-a',workspace:'main',id:r.id,expectedVersion:r.version,state:'planned',at:asOf,reason:'Out of order'}));
});
test('memory and file stores retain over 256 changed evaluations and reconstruct all history after reopening',async()=>{
  const root=await mkdtemp(join(tmpdir(),'work-history-v2-'));
  try{
    for(let adapter=0;adapter<2;adapter++){
      let store:WorkStore=adapter===0?new MemoryWorkStore():await FileWorkStore.open(root);
      const s=await composition();
      for(let i=0;i<280;i++){
        s.id=`changed-${i}`;
        await reevaluateNotice(vulnerability,s,store,{...opts,asOf:new Date(Date.parse(asOf)+i*1000).toISOString()});
      }
      if(adapter===1)store=await FileWorkStore.open(root);
      const r=(await store.list('tenant-a','main'))[0]!;
      assert.equal(r.history.length,HISTORY_WINDOW);assert.equal(r.historyCount,280);assert.equal(r.historyOffset,280-HISTORY_WINDOW);
      const all=await fullHistory(store,r.id,r.version);
      assert.equal(all.length,280);assert.equal(new Set(all.map(e=>e.sequence)).size,280);
      assert.equal(all[0]!.snapshotId,'changed-0');assert.equal(all.at(-1)!.snapshotId,'changed-279');
      assert.ok(all.every(e=>e.evaluationCount===1));
      await assert.rejects(store.getHistory('tenant-b','main',r.id));
      await assert.rejects(store.getHistory('tenant-a','main',r.id,{expectedVersion:r.version-1}));
      await assert.rejects(store.save({...r,version:r.version+1},r.version-1));
      const edited=structuredClone(r);edited.version++;edited.history[0]!.reason='Illicit archive rewrite';
      await assert.rejects(store.save(edited,r.version));
    }
  }finally{assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('v1 JSON migration preserves original bytes, all events, IDs and versions before continuing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'legacy-work-fixture-'));
  try{
    const memory=new MemoryWorkStore(),s=await composition(),created=(await reevaluateNotice(vulnerability,s,memory,opts))[0]!;
    const {schemaVersion:_schema,assessmentKey:_key,requiresReevaluation:_review,historyCount:_count,historyOffset:_offset,history:_history,...fields}=created;
    const {lastAt:_last,evaluationCount:_evaluations,policy:_policy,...event}=created.history[0]!;
    const legacy={...fields,version:256,snapshotId:'legacy-255',history:Array.from({length:256},(_,i)=>({...event,at:new Date(Date.parse(asOf)+i*1000).toISOString(),snapshotId:`legacy-${i}`})),
      evaluatedAt:new Date(Date.parse(asOf)+255000).toISOString()};
    const original=JSON.stringify([legacy],null,2)+'\n',file=join(root,stableId('work','tenant-a','main')+'.json');await writeFile(file,original);
    const store=await FileWorkStore.open(root),migrated=(await store.list('tenant-a','main'))[0]!;
    assert.equal(migrated.id,legacy.id);assert.equal(migrated.version,256);assert.equal(migrated.historyCount,256);
    assert.equal(migrated.requiresReevaluation,true);
    assert.equal(await readFile(file+'.v1-backup','utf8'),original);
    assert.equal((JSON.parse(await readFile(file,'utf8')) as {schemaVersion:number}).schemaVersion,2);
    const before=await fullHistory(store,migrated.id,migrated.version);assert.equal(before.length,256);assert.equal(before[0]!.snapshotId,'legacy-0');
    s.id='after-migration';const next=(await reevaluateNotice(vulnerability,s,store,{...opts,asOf:new Date(Date.parse(asOf)+256000).toISOString()}))[0]!;
    assert.equal(next.version,257);assert.equal(next.historyCount,257);
    assert.equal(next.requiresReevaluation,false);
    const reopened=await FileWorkStore.open(root);assert.deepEqual(await fullHistory(reopened,next.id,next.version),[...before,{...next.history.at(-1)!,sequence:256}]);
    assert.equal(await readFile(file+'.v1-backup','utf8'),original);
    const memImported=new MemoryWorkStore();await memImported.importLegacy([legacy]);assert.equal((await fullHistory(memImported,legacy.id,256)).length,256);
  }finally{assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
