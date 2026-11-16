import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRepositories,GitRepositorySource,LocalRepositorySource,MemoryRepositorySource } from '../src/platform/collect.js';
import { impact,graphSnapshotSchema } from '../src/platform/graph.js';
import { FileSnapshotStore,MemorySnapshotStore } from '../src/platform/storage.js';
import { sourceRegistrations as registrations,sourceRoots as roots } from './platform-fixtures.js';

const now='2026-11-16T00:00:00Z';
test('real source fixtures extract cross-repository API calls, versioned transitive lock dependencies and provenance',async()=>{
  const g=await collectRepositories(registrations,new LocalRepositorySource(roots),{snapshotId:'source-a',asOf:now});
  const r=impact(g,{target:'service-b',asOf:now});
  assert.ok(r.items.some(i=>i.node.id==='service-a'));
  assert.ok(r.items.find(i=>i.node.id==='service-a')!.path.edges.some(e=>e.kind==='calls'));
  assert.ok(g.nodes.some(n=>n.kind==='database'&&n.label==='database-a'));
  assert.deepEqual(g.nodes.filter(n=>n.attributes.name==='library-a').map(n=>n.attributes.version).sort(),['1.1.0','1.2.0']);
  const middle=g.nodes.find(n=>n.attributes.name==='middle-a'&&n.attributes.version==='1.0.0')!;
  const nested=g.nodes.find(n=>n.attributes.name==='library-a'&&n.attributes.version==='1.1.0')!;
  assert.ok(g.edges.some(e=>e.source===middle.id&&e.target===nested.id&&e.dependencyKind==='resolved'));
  assert.ok(g.observations.every(o=>o.status==='complete'));assert.equal(g.coverage.length,0);
});
test('updates remove deleted facts; failed collection retains last evidence and returns gaps, not an empty safe graph',async()=>{
  const source=new MemoryRepositorySource({'repo-a':[{path:'src/a.ts',content:'export const a = 1;'}],'repo-b':[]});
  const first=await collectRepositories(registrations,source,{snapshotId:'v1',asOf:now});
  const file=first.nodes.find(n=>n.kind==='source-file')!.id;
  source.files['repo-a']=[];
  const second=await collectRepositories(registrations,source,{snapshotId:'v2',asOf:now,previous:first});
  assert.ok(!second.nodes.some(n=>n.id===file));
  source.files['repo-a']=new Error('synthetic failure');
  const failed=await collectRepositories(registrations,source,{snapshotId:'v3',asOf:now,previous:first});
  assert.ok(failed.nodes.some(n=>n.id===file));assert.equal(failed.observations[0]!.status,'failed');
  assert.equal(impact(failed,{target:'service-a',asOf:now}).complete,false);
  source.files['repo-a']=[{path:'main.rs',content:'fn main() {}'},{path:'bad.ts',content:'const = ;'}];
  const partial=await collectRepositories(registrations,source,{snapshotId:'v4',asOf:now});
  assert.ok(partial.coverage.some(g=>g.reason==='unsupported_source_format'));
  assert.ok(partial.coverage.some(g=>g.reason==='syntax_error'));
  source.files['repo-a']=[{path:'fetch.ts',content:"fetch('http://service-b.invalid/items', { method: 'POST' }); fetch('http://service-b.invalid/other', options);"}];
  const methods=await collectRepositories(registrations,source,{snapshotId:'methods',asOf:now});
  assert.ok(methods.nodes.some(n=>n.kind==='api'&&n.attributes.method==='POST'));
  assert.ok(methods.coverage.some(g=>g.reason==='unresolved_fetch_method'));
  assert.ok(!methods.nodes.some(n=>n.attributes.endpoint==='http://service-b.invalid/other'));
});
test('memory and local file snapshots enforce immutable IDs and tenant/workspace bindings',async()=>{
  const g=await collectRepositories(registrations,new MemoryRepositorySource({'repo-a':[],'repo-b':[]}),{snapshotId:'immutable',asOf:now});
  const root=await mkdtemp(join(tmpdir(),'graph-snapshots-'));
  try {
    for(const store of [new MemorySnapshotStore(graphSnapshotSchema.parse),await FileSnapshotStore.open(root,graphSnapshotSchema.parse)]) {
      await store.put('tenant-a','main',g);await store.put('tenant-a','main',g);
      assert.deepEqual(await store.get('tenant-a','main',g.id),g);
      assert.equal(await store.get('tenant-b','main',g.id),undefined);
      await assert.rejects(store.put('tenant-a','main',{...g,collectedAt:'2026-11-17T00:00:00Z'}));
    }
  } finally {assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('Git source reads a pinned committed revision and records hashes without changing a dirty working tree',async()=>{
  const root=await mkdtemp(join(tmpdir(),'platform-git-fixture-')),run=promisify(execFile),file=join(root,'main.ts');
  const git=async(args:string[])=>(await run('git',['-C',root,...args],{windowsHide:true})).stdout.trim();
  const old='export const value = 1;\n',dirty='export const value = 2;\n';
  try {
    await git(['init','--quiet']);await writeFile(file,old);await git(['add','main.ts']);
    await git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','synthetic source fixture']);
    const revision=await git(['rev-parse','HEAD']);await writeFile(file,dirty);
    const r={...registrations[0]!,revision};
    const result=await collectRepositories([r],new GitRepositorySource({'repo-a':root}),{snapshotId:'git-a',asOf:now});
    assert.equal(result.observations[0]!.revisionVerified,true);assert.equal(result.observations[0]!.collectionMethod,'git_commit');
    assert.equal(result.observations[0]!.contentHashes['main.ts'],createHash('sha256').update(old).digest('hex'));
    assert.equal(await readFile(file,'utf8'),dirty);assert.match(await git(['status','--short']),/main.ts/);
  }finally{assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
