import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEol, type EolNotice, type EolSnapshot } from '../src/eol/index.js';
import { asOf, notice, snapshot } from './eol-fixtures.js';
const assess = (s = snapshot(), n = notice, extra = {}) => evaluateEol(n, s, {asOf, ...extra});

test('EOL dates, versions, policies and runtime evidence determine affected services', () => {
  const r = assess();
  assert.equal(r.status, 'affected'); assert.equal(r.items[0]!.status, 'affected');
  assert.equal(r.items[0]!.deadline, '2026-11-15');
  assert.deepEqual(r.items[0]!.path.map(p => p.kind), ['asset','artifact','deployment','service']);
  assert.equal(r.snapshotId, 'snapshot-a'); assert.equal(r.noticeRevision, 'r1');
  const s = snapshot(); s.assets[0]!.support = {tier:'extended', conditions:{'contract-active':true}};
  assert.equal(assess(s).items[0]!.status, 'not_affected');
  s.assets[0]!.support.conditions['contract-active'] = null;
  assert.ok(assess(s).items[0]!.missing.includes('support.conditions.contract-active'));
  s.assets[0]!.support.conditions['contract-active'] = false;
  assert.equal(assess(s).items[0]!.status, 'unknown');
  assert.deepEqual(assess(s).items[0]!.supportConditions,[{condition:'contract-active',value:false}]);
  assert.deepEqual(r.criteria.versions,notice.versions);
  s.assets[0]!.support.tier = null;
  assert.ok(assess(s).items[0]!.missing.includes('support.tier'));
});

test('deadline is the last supported UTC calendar date; product/vendor/series/version remain distinct', () => {
  assert.equal(assess(snapshot(), notice, {asOf:'2026-11-15T23:59:59Z'}).items[0]!.status, 'unknown'); // future inventory
  const s = snapshot(); s.assets[0]!.observedAt = '2026-11-15T00:00:00Z';
  assert.equal(assess(s, notice, {asOf:'2026-11-15T23:59:59Z'}).items[0]!.status, 'not_affected');
  for (const field of ['product','vendor','releaseLine','version'] as const) {
    const s = snapshot(); s.assets[0]![field] = field === 'version' ? '2.0.0' : 'other';
    assert.equal(assess(s).items[0]!.status, 'not_affected');
    s.assets[0]![field] = null;
    assert.equal(assess(s).items[0]!.status, 'unknown');
  }
  const unsupported = snapshot(); unsupported.assets[0]!.version = '1.4-vendor';
  assert.equal(assess(unsupported).items[0]!.status, 'unknown');
});

test('stale, inferred, absent evidence and collection failure cannot establish safety', () => {
  for (const mutate of [
    (s:EolSnapshot) => {s.assets[0]!.observedAt = '2020-01-01T00:00:00Z';},
    (s:EolSnapshot) => {s.assets[0]!.evidence[0]!.confidence = 'inferred';},
    (s:EolSnapshot) => {s.assets[0]!.evidence = [];},
  ]) {
    const s = snapshot(); mutate(s); assert.equal(assess(s).items[0]!.status, 'unknown');
  }
  const empty = snapshot(0); empty.coverage = [{repositoryId:'repo-a', environment:'production', reason:'collection_failed'}];
  assert.equal(assess(empty).status, 'unknown'); assert.equal(assess(empty).complete, false);
  assert.equal(assess(snapshot(0)).status, 'unknown');
});

test('60 asset instances page by stable ID, preserving total and snapshot without duplicates', () => {
  const s = snapshot(60), ids:string[] = [];
  for (const offset of [0,20,40]) {
    const r = assess(s, notice, {limit:20, offset}); ids.push(...r.items.map(i=>i.assetId));
    assert.equal(r.total,60); assert.equal(r.hasMore,offset<40);
    assert.equal(r.nextOffset,offset<40 ? offset+20 : null);
    assert.equal(r.truncated,false);
  }
  assert.equal(new Set(ids).size,60);
  const s2 = snapshot(); s2.assets.push({...s2.assets[0]!, id:'asset-new', version:'2.0.0', artifactId:'artifact-new', environment:'staging'});
  const r = assess(s2); assert.deepEqual(r.items.map(i=>i.status), ['affected','not_affected']);
});

test('invalid dates, ranges, duplicate asset IDs and unsupported schemas fail explicitly', () => {
  assert.throws(()=>assess(snapshot(), {...notice, schemaVersion:2} as unknown as EolNotice));
  assert.throws(()=>assess(snapshot(), {...notice, policies:[{tier:'standard',endsOn:'2026-02-30',requiredConditions:[]}]}));
  assert.throws(()=>assess(snapshot(), {...notice, versions:{scheme:'numeric',from:'2.0',until:'1.0'}}));
  const s = snapshot(2); s.assets[1]!.id = s.assets[0]!.id; assert.throws(()=>assess(s));
  assert.throws(()=>assess(snapshot(), notice, {asOf:'not-a-date'}));
});

test('literal version selectors support vendor releases; unannounced deadlines and tiers remain unknown',()=>{
  const n=structuredClone(notice),s=snapshot();
  n.versions={scheme:'exact',values:['1.4-vendor']};s.assets[0]!.version='1.4-vendor';
  assert.equal(assess(s,n).items[0]!.status,'affected');
  s.assets[0]!.version='1.4';assert.equal(assess(s,n).items[0]!.status,'not_affected');
  s.assets[0]!.version='1.4-vendor';n.policies[0]!.endsOn=null;
  assert.deepEqual(assess(s,n).items[0]!.missing,['notice.support_deadline']);
  s.assets[0]!.support.tier='custom';
  assert.deepEqual(assess(s,n).items[0]!.missing,['notice.policy_for_support_tier']);
});

test('UTC deadline normalization, inferred notice, missing ownership and pure input immutability',()=>{
  const s=snapshot();s.assets[0]!.observedAt='2026-11-14T00:00:00Z';s.collectedAt=s.assets[0]!.observedAt;
  assert.equal(assess(s,notice,{asOf:'2026-11-16T01:00:00+09:00'}).status,'not_affected');
  const n=structuredClone(notice);n.evidence[0]!.confidence='ambiguous';
  assert.equal(assess(s,n).status,'unknown');
  s.assets[0]!.serviceId=null;s.assets[0]!.ownerTeam=null;
  const before=structuredClone(s),r=assess(s);
  assert.equal(r.items[0]!.status,'affected');assert.equal(r.complete,false);
  assert.deepEqual(r.items[0]!.missing,['serviceId','ownerTeam']);
  assert.deepEqual(s,before);
});
