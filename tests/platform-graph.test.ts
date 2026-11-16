import test from 'node:test';
import assert from 'node:assert/strict';
import { impact, trace, scopeGraph } from '../src/platform/graph.js';
import { asOf as now,impactGraph as graph } from './platform-fixtures.js';

test('shared evidence connects authorized repositories, preserving paths, quality and actual risk context',()=>{
  const g=graph();
  const r=impact(g,{target:'package-a',asOf:now});
  assert.equal(r.total,2);assert.equal(r.risk.level,'CRITICAL');
  assert.equal(r.items[0]!.path.edges[0]!.evidence[0]!.source,'src/main.ts');
  assert.equal(r.items[0]!.quality,'confirmed');
  const scoped=scopeGraph(g,{repositories:['repo-a'],environments:['production']});
  assert.deepEqual(scoped.nodes.map(n=>n.id).sort(),['package-a','service-0']);
  assert.ok(!JSON.stringify(scoped).includes('repo-b'));
  assert.equal(impact(scoped,{target:'package-a',asOf:now}).total,1);
});

test('60 candidates have exact counts and three pages with no duplicates; exploration truncation is independent',()=>{
  const g=graph(60),ids:string[]=[];
  for(const offset of [0,20,40]) {
    const r=impact(g,{target:'package-a',asOf:now,offset,limit:20});
    assert.equal(r.total,60);assert.equal(r.totalIsExact,true);assert.equal(r.truncated,false);
    assert.equal(r.hasMore,offset<40);assert.equal(r.nextOffset,offset<40?offset+20:null);
    ids.push(...r.items.map(i=>i.node.id));
  }
  assert.equal(new Set(ids).size,60);
  const bounded=impact(g,{target:'package-a',asOf:now,maxNodes:3});
  assert.equal(bounded.truncated,true);assert.equal(bounded.totalIsExact,false);
});

test('unknown environment and foreign evidence never become production; disconnected trace is not safety',()=>{
  const g=graph();g.nodes[1]!.environment=null;
  assert.ok(!scopeGraph(g,{repositories:['repo-a'],environments:['production']}).nodes.some(n=>n.id==='service-0'));
  assert.ok(scopeGraph(g,{repositories:['repo-a'],environments:['unknown']}).nodes.some(n=>n.id==='service-0'));
  g.edges=[];const t=trace(g,{source:'service-0',destination:'service-1',asOf:now});
  assert.equal(t.found,false);assert.equal(t.conclusion,'unknown');
});

test('trace/impact retain inferred, ambiguous and stale relations and report missing context',()=>{
  for(const confidence of ['inferred','ambiguous'] as const) {
    const g=graph();g.edges[0]!.evidence[0]!.confidence=confidence;
    assert.equal(trace(g,{source:'service-0',destination:'package-a',asOf:now}).quality,confidence);
  }
  const g=graph();g.edges[0]!.evidence[0]!.observedAt='2020-01-01T00:00:00Z';
  assert.equal(trace(g,{source:'service-0',destination:'package-a',asOf:now}).quality,'stale');
  g.context={compatibility:{},criticality:{}};
  assert.equal(impact(g,{target:'package-a',asOf:now}).risk.level,'UNKNOWN');
  g.coverage.push({repositoryId:'repo-a',environment:'production',reason:'collection_failed',source:'src/main.ts'});
  assert.equal(impact(g,{target:'package-a',asOf:now}).complete,false);
});
