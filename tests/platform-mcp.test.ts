import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiError } from '../src/contracts.js';
import { buildPlatformRuntime } from '../src/platform/runtime.js';
import { type PlatformOperation } from '../src/platform/service.js';
import { asOf,platformConfig,impactGraph } from './platform-fixtures.js';

const base={workspace:'main',snapshotId:'snapshot-a',asOf},entry=fileURLToPath(new URL('../index.js',import.meta.url));
const request=(op:PlatformOperation):Record<string,unknown>=>op==='capabilities'?{workspace:'main'}:op==='remediation'?{workspace:'main'}:
  op==='query'?{...base,query:'service'}:op==='impact'||op==='explain'?{...base,target:'service-b'}:
  op==='trace'?{...base,source:'service-a',destination:'service-b'}:
  op==='eol'?{...base,noticeId:'notice-a',noticeRevision:'r1'}:
  op==='vulnerability'?{...base,noticeId:'cve-test-a',noticeRevision:'r1'}:base;
const isError=(code:string)=>(e:unknown)=>e instanceof ApiError&&e.code===code;
test('all features run from actual source extraction through modern MCP without Rust; projections preserve full core semantics', {timeout:20000},async()=>{
  const cfg=platformConfig(),runtime=await buildPlatformRuntime(cfg),dir=await mkdtemp(join(tmpdir(),'platform-mcp-')),file=join(dir,'config with spaces.json');
  await writeFile(file,JSON.stringify(cfg));
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--platform',file],cwd:tmpdir(),stderr:'pipe'}),client=new Client({name:'platform-test',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  let stderr='';transport.stderr?.on('data',d=>stderr+=String(d));
  try {
    await client.connect(transport);assert.equal(client.getProtocolEra(),'modern');
    const list=(await client.listTools()).tools;assert.equal(list.length,10);assert.ok(list.every(t=>t.annotations?.readOnlyHint===true));
    for(const op of ['capabilities','inventory','query','impact','trace','explain','vulnerability','eol','remediation'] as const) {
      const result=await client.callTool({name:'graph_'+op,arguments:request(op)});
      assert.notEqual(result.isError,true,op+': '+JSON.stringify(result));
      assert.deepEqual(result.structuredContent,await runtime.service.execute(runtime.principal,op,request(op)),op);
    }
    const trace=await runtime.service.execute(runtime.principal,'trace',request('trace'));assert.equal(trace.found,true);
    const vuln=await runtime.service.execute(runtime.principal,'vulnerability',request('vulnerability'));assert.equal(vuln.status,'affected');assert.equal(vuln.total,1);
    assert.ok(!JSON.stringify(vuln).includes('revision-b'));
    const denied=await client.callTool({name:'graph_vulnerability',arguments:{...request('vulnerability'),environments:['staging']}});
    assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/permission_denied/);
    assert.match(stderr,/READY: read-only TypeScript system graph server/);
  } finally {await client.close();assert.ok(dir.startsWith(tmpdir()));await rm(dir,{recursive:true,force:true});}
});
test('portable MCP supports the legacy client and keeps the same TypeScript evidence/paging contract', {timeout:15000},async()=>{
  const cfg=platformConfig(),runtime=await buildPlatformRuntime(cfg),dir=await mkdtemp(join(tmpdir(),'platform-legacy-')),file=join(dir,'config.json');
  await writeFile(file,JSON.stringify(cfg));
  const transport=new LegacyTransport({command:process.execPath,args:[entry,'--platform',file],cwd:tmpdir(),stderr:'pipe'}),client=new LegacyClient({name:'portable-legacy',version:'1'});
  transport.stderr?.on('data',()=>{});
  try {
    await client.connect(transport);assert.equal((await client.listTools()).tools.length,10);
    const result=await client.callTool({name:'graph_impact',arguments:request('impact')});
    assert.deepEqual(result.structuredContent,await runtime.service.execute(runtime.principal,'impact',request('impact')));
  }finally{await client.close();assert.ok(dir.startsWith(tmpdir()));await rm(dir,{recursive:true,force:true});}
});
test('portable service rejects foreign principals/scopes, client paths and revision drift; permission denial is audited',async()=>{
  const r=await buildPlatformRuntime(platformConfig());
  for(const raw of [{...base,workspace:'absent'},{...base,repositories:['foreign']},{...base,environments:['unknown']}])
    await assert.rejects(r.service.execute(r.principal,'inventory',raw),isError('permission_denied'));
  await assert.rejects(r.service.execute({...r.principal,tenant:'tenant-b'},'inventory',base),isError('permission_denied'));
  assert.equal(r.audit.at(-1)!.allowed,false);
  await assert.rejects(r.service.execute({...r.principal,expiresAt:0},'inventory',base),isError('unauthenticated'));
  for(const extra of [{path:'../outside'},{url:'http://fixture.invalid'},{tenant:'tenant-b'},{limit:51}])
    await assert.rejects(r.service.execute(r.principal,'inventory',{...base,...extra}),isError('invalid_request'));
  await assert.rejects(r.service.execute(r.principal,'vulnerability',{...request('vulnerability'),noticeRevision:'different'}),isError('invalid_request'));
  const ac=new AbortController();ac.abort();await assert.rejects(r.service.execute(r.principal,'inventory',base,ac.signal),isError('cancelled'));
});
test('MCP impact retrieves 60 candidates in three 20-row pages without losing evidence or pagination', {timeout:15000},async()=>{
  const {source:_source,...baseConfig}=platformConfig(),g=impactGraph(60);
  const cfg={...baseConfig,notices:[],snapshots:[{schemaVersion:1,id:g.id,graph:g,composition:{schemaVersion:1,id:g.id,collectedAt:asOf,artifacts:[],deployments:[],coverage:[]}}]};
  const dir=await mkdtemp(join(tmpdir(),'platform-pages-')),file=join(dir,'config.json');await writeFile(file,JSON.stringify(cfg));
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--platform',file],cwd:tmpdir(),stderr:'pipe'}),client=new Client({name:'paging-test',version:'1'});
  transport.stderr?.on('data',()=>{});
  try {
    await client.connect(transport);const ids=new Set<string>();
    for(const offset of [0,20,40]) {
      const result=await client.callTool({name:'graph_impact',arguments:{...base,target:'package-a',offset,limit:20}});
      assert.notEqual(result.isError,true);const data=result.structuredContent as Record<string,unknown>;
      assert.equal(data.total,60);assert.equal(data.totalIsExact,true);assert.equal(data.truncated,false);
      assert.equal(data.hasMore,offset<40);assert.equal(data.nextOffset,offset<40?offset+20:null);
      const items=data.items as {node:{id:string};path:{edges:{evidence:unknown[]}[]}}[];
      for(const row of items){ids.add(row.node.id);assert.ok(row.path.edges[0]!.evidence.length);}
    }
    assert.equal(ids.size,60);
  }finally{await client.close();assert.ok(dir.startsWith(tmpdir()));await rm(dir,{recursive:true,force:true});}
});
