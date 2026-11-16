import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { conflictingSnapshot,snapshotConfig } from './review-fixtures.js';
import { asOf,composition,sourceRegistrations,impactGraph,sbom,artifact,vulnerability } from './platform-fixtures.js';
import { emptyGraph,type SystemSnapshot } from '../src/platform/system.js';
import { connectComposition,importCycloneDx } from '../src/platform/composition.js';
import { collectRepositories,MemoryRepositorySource } from '../src/platform/collect.js';
import { buildPlatformRuntime } from '../src/platform/runtime.js';
import { notice } from './eol-fixtures.js';
import { FileWorkStore,reevaluateNotice } from '../src/platform/remediation.js';

const entry=fileURLToPath(new URL('../index.js',import.meta.url));
type Call=(operation:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>;
async function session(config:unknown,body:(call:Call)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'review-mcp-')),file=join(dir,'config.json');await writeFile(file,JSON.stringify(config));
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--platform',file],cwd:tmpdir(),stderr:'pipe'});
  const client=new Client({name:'review-regression',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  transport.stderr?.on('data',()=>{});
  try{await client.connect(transport);await body(async(operation,args)=>{
    const result=await client.callTool({name:'graph_'+operation,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent as Record<string,unknown>;
  });}finally{await client.close();assert.ok(dir.startsWith(tmpdir()));await rm(dir,{recursive:true,force:true});}
}
const base=(snapshotId:string)=>({workspace:'main',snapshotId,asOf});
test('[A] actual MCP, authenticated API and work/history agree on a production artifact conflict', {timeout:15000},async()=>{
  const {updated}=await conflictingSnapshot(),cfg=snapshotConfig(updated.snapshot),api=await buildPlatformRuntime(cfg);
  await session(cfg,async call=>{
    for(const kind of ['vulnerability','eol'] as const){
      const args={...base(updated.snapshot.id),noticeId:kind==='eol'?'notice-a':'cve-test-a',noticeRevision:'r1'};
      const result=await call(kind,args);assert.equal(result.status,'unknown');assert.equal(result.complete,false);
      assert.deepEqual(result,await api.service.execute(api.principal,kind,args));assert.ok(!JSON.stringify(result).includes('staging'));
    }
    const work=await call('remediation',{workspace:'main'}),records=work.items as {id:string;state:string;version:number}[];
    assert.ok(records.length>0);assert.ok(records.every(r=>r.state!=='resolved'));
    const r=records[0]!,history=await call('remediation_history',{workspace:'main',recordId:r.id,recordVersion:r.version,limit:1});
    assert.equal(history.total,1);assert.equal((history.items as {status:string}[])[0]!.status,'unknown');
    await assert.rejects(api.service.execute(api.principal,'remediation_history',{workspace:'main',recordId:r.id,environments:['staging']}));
  });
});
test('[C,G] scoped logical service, colon edge IDs and paths survive the actual MCP response', {timeout:15000},async()=>{
  const s=await composition();for(const d of s.deployments)d.serviceId='service:alpha';
  const source=await collectRepositories([{...sourceRegistrations[0]!,serviceId:'service:alpha'}],new MemoryRepositorySource({'repo-a':[]}),{snapshotId:s.id,asOf});
  const linked=connectComposition(source,s),cfg={...snapshotConfig({schemaVersion:1,id:s.id,graph:linked,composition:s},['staging']),notices:[]};
  await session(cfg,async call=>{
    const inventory=await call('inventory',{...base(s.id),limit:50}),nodes=inventory.nodes as {id:string;kind:string;attributes:Record<string,unknown>}[],edges=inventory.edges as {source:string;target:string}[];
    const ids=new Set(nodes.map(n=>n.id));assert.ok(ids.has('service:alpha'));assert.ok(edges.some(e=>e.source==='service:alpha'));
    assert.ok(edges.every(e=>ids.has(e.source)&&ids.has(e.target)));assert.ok(!JSON.stringify(inventory).includes('production'));
    const target=nodes.find(n=>n.kind==='package'&&n.attributes.version==='2.0.0')!.id;
    const impact=await call('impact',{...base(s.id),target});
    assert.ok((impact.serviceAggregation as {serviceId:string}[]).some(s=>s.serviceId==='service:alpha'));
    for(const item of impact.items as {path:{nodes:{id:string}[];edges:{source:string;target:string}[]}}[]){const pathIds=new Set(item.path.nodes.map(n=>n.id));assert.ok(item.path.edges.every(e=>pathIds.has(e.source)&&pathIds.has(e.target)));}
    const trace=await call('trace',{...base(s.id),source:'service:alpha',destination:target});assert.equal(trace.found,true);
    assert.ok(!JSON.stringify(trace).includes('[redacted]'));
  });
});
test('[E] independent inventory/query cursors reconstruct a normal multi-page graph exactly once', {timeout:20000},async()=>{
  const g=impactGraph(60);g.nodes[0]!.label='service-package';
  const snapshot:SystemSnapshot={schemaVersion:1,id:g.id,graph:g,composition:{schemaVersion:1,id:g.id,collectedAt:asOf,artifacts:[],deployments:[],coverage:[]}};
  const cfg={...snapshotConfig(snapshot),notices:[]};
  await session(cfg,async call=>{
    for(const operation of ['inventory','query']){
      const ids=new Set<string>(),edgeIds=new Set<string>();let nodeOffset=0,edgeOffset:number|null=0,nodeDone=false,edgeDone=false,total=0;
      do{
        const result=await call(operation,{...base(g.id),limit:20,offset:nodeDone?total:nodeOffset,edgeLimit:7,edgeOffset:edgeDone?null:edgeOffset,...(operation==='query'?{query:'service'}:{})});
        total=result.total as number;
        for(const node of result.nodes as {id:string}[]){assert.ok(!ids.has(node.id));ids.add(node.id);}
        for(const edge of result.edges as {id:string}[]){assert.ok(!edgeIds.has(edge.id));edgeIds.add(edge.id);}
        const paging=result.edgePaging as {nextOffset:number|null;total:number};assert.equal(paging.total,60);
        if(result.nextOffset===null)nodeDone=true;else nodeOffset=result.nextOffset as number;
        if(paging.nextOffset===null)edgeDone=true;else edgeOffset=paging.nextOffset;
      }while(!nodeDone||!edgeDone);
      assert.equal(ids.size,61);assert.equal(edgeIds.size,60);
    }
  });
});
test('[B,F] limited SBOM completeness and future observations remain unknown over MCP', {timeout:15000},async()=>{
  const s=await composition();s.artifacts[0]=importCycloneDx({...sbom(),compositions:[{aggregate:'complete',dependencies:['middle']}]},artifact());
  const d=s.deployments.find(d=>d.environment==='production')!;d.products[0]!.version='2.0.0';d.products[0]!.observedAt='2027-01-01T00:00:00Z';
  const n={...vulnerability,rules:[{packageUrl:'pkg:npm/not-listed',versions:{scheme:'exact' as const,versions:['1.0.0']}}]};
  const snapshot:SystemSnapshot={schemaVersion:1,id:s.id,graph:connectComposition(emptyGraph(s.id,asOf),s),composition:s};
  const cfg={...snapshotConfig(snapshot),notices:[n,notice]};
  await session(cfg,async call=>{
    const v=await call('vulnerability',{...base(s.id),noticeId:n.id,noticeRevision:n.revision});assert.equal(v.status,'unknown');assert.equal(v.complete,false);
    const e=await call('eol',{...base(s.id),noticeId:notice.id,noticeRevision:notice.revision});assert.equal(e.status,'unknown');assert.equal(e.complete,false);
    assert.ok((e.items as {missing:string[]}[])[0]!.missing.includes('observation_at_or_before_asOf'));
  });
});
test('[D] actual MCP impact and trace retain a server base path across repositories', {timeout:15000},async()=>{
  const graph=await collectRepositories(sourceRegistrations,new MemoryRepositorySource({
    'repo-a':[{path:'main.ts',content:'export const run = () => fetch("https://service-b.invalid/v1/items");'}],
    'repo-b':[{path:'openapi.json',content:JSON.stringify({openapi:'3.1.0',servers:[{url:'https://service-b.invalid/v1/'}],paths:{'/items':{get:{responses:{}}}}})}],
  }),{snapshotId:'base-path',asOf});
  const cfg={...snapshotConfig({schemaVersion:1,id:graph.id,graph,composition:{schemaVersion:1,id:graph.id,collectedAt:asOf,artifacts:[],deployments:[],coverage:[]}}),notices:[]};
  await session(cfg,async call=>{
    const result=await call('impact',{...base(graph.id),target:'service-b'});assert.ok((result.items as {node:{id:string}}[]).some(r=>r.node.id==='service-a'));
    assert.equal((await call('trace',{...base(graph.id),source:'service-a',destination:'service-b'})).found,true);
  });
});
test('paged archived history remains available over MCP after restart without rewinding later evaluations', {timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'history-mcp-'));
  try{
    const store=await FileWorkStore.open(root),s=await composition();
    for(let i=0;i<270;i++){s.id=`audit-${i}`;await reevaluateNotice(vulnerability,s,store,{tenant:'tenant-a',workspace:'main',asOf:new Date(Date.parse(asOf)+i*1000).toISOString(),trigger:'manual'});}
    const r=(await store.list('tenant-a','main'))[0]!;
    const cfg={...snapshotConfig({schemaVersion:1,id:s.id,graph:connectComposition(emptyGraph(s.id,asOf),s),composition:s}),notices:[vulnerability],workRoot:root};
    await session(cfg,async call=>{
      const capabilities=await call('capabilities',{workspace:'main'});assert.equal(capabilities.workSchema,2);
      const records=(await call('remediation',{workspace:'main'})).items as {id:string;version:number;historyCount:number}[];
      assert.equal(records[0]!.version,r.version);assert.equal(records[0]!.historyCount,270);
      const seen=new Set<number>();let offset=0;
      for(;;){const page=await call('remediation_history',{workspace:'main',recordId:r.id,recordVersion:r.version,limit:100,offset});
        for(const e of page.items as {sequence:number}[]){assert.ok(!seen.has(e.sequence));seen.add(e.sequence);}
        if(page.nextOffset===null)break;offset=page.nextOffset as number;
      }assert.equal(seen.size,270);
    });
  }finally{assert.ok(root.startsWith(tmpdir()));await rm(root,{recursive:true,force:true});}
});
