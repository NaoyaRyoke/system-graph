import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildEolStdioRuntime } from '../src/eol/stdio.js';
import { asOf, eolConfig } from './eol-fixtures.js';

const entry=fileURLToPath(new URL('../index.js',import.meta.url));
const query={workspace:'main',noticeId:'notice-a',noticeRevision:'r1',snapshotId:'snapshot-a',asOf,limit:20,offset:0};
function configFile() {
  const dir=mkdtempSync(join(tmpdir(),'system-graph-eol-')),file=join(dir,'config with spaces.json'),config=eolConfig();
  writeFileSync(file,JSON.stringify(config));
  return {file,config,cleanup:()=>{unlinkSync(file);rmdirSync(dir);}};
}

test('modern MCP EOL launcher has no engine argument and preserves public API evidence and all three pages', {timeout:15000},async()=>{
  const f=configFile(),runtime=buildEolStdioRuntime(f.config);
  const transport=new StdioClientTransport({command:process.execPath,args:[entry,'--eol',f.file],cwd:tmpdir(),stderr:'pipe'});
  const c=new Client({name:'eol-test',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  let stderr='';transport.stderr?.on('data',v=>{stderr+=String(v);});
  try {
    await c.connect(transport);assert.equal(c.getProtocolEra(),'modern');
    const tools=(await c.listTools()).tools;
    assert.deepEqual(tools.map(t=>t.name),['graph_eol']);assert.equal(tools[0]!.annotations?.readOnlyHint,true);
    const seen=new Set<string>();
    for(const offset of [0,20,40]) {
      const q={...query,offset},result=await c.callTool({name:'graph_eol',arguments:q});
      assert.notEqual(result.isError,true);
      const expected=await runtime.service.execute(runtime.principal,q);
      assert.deepEqual(result.structuredContent,expected);
      for(const item of expected.items)seen.add(item.assetId);
    }
    assert.equal(seen.size,60);
    const denied=await c.callTool({name:'graph_eol',arguments:{...query,environments:['staging']}});
    assert.equal(denied.isError,true);assert.match(JSON.stringify(denied),/permission_denied/);
    assert.match(stderr,/READY: read-only EOL stdio server/);
  } finally {await c.close();f.cleanup();}
});

test('legacy SDK negotiates EOL without Rust and preserves the same assessment', {timeout:15000},async()=>{
  const f=configFile(),transport=new LegacyTransport({command:process.execPath,args:[entry,'--eol',f.file],cwd:tmpdir(),stderr:'pipe'});
  const c=new LegacyClient({name:'eol-legacy-test',version:'1'});
  transport.stderr?.on('data',()=>{});
  try {
    await c.connect(transport);
    assert.deepEqual((await c.listTools()).tools.map(t=>t.name),['graph_eol']);
    const result=await c.callTool({name:'graph_eol',arguments:query}),r=buildEolStdioRuntime(f.config);
    assert.deepEqual(result.structuredContent,await r.service.execute(r.principal,query));
  } finally {await c.close();f.cleanup();}
});

test('EOL launcher handles EOF and invalid config with clean stdout and bounded diagnostics', {timeout:10000},async()=>{
  const f=configFile();
  try {
    for(const valid of [true,false]) {
      if(!valid)writeFileSync(f.file,JSON.stringify({...f.config,localPrincipal:{principal:'foreign',tenant:'tenant-a'}}));
      const p=spawn(process.execPath,[entry,'--eol',f.file],{windowsHide:true,stdio:'pipe',cwd:tmpdir()});
      let out='',err='';p.stdout.on('data',v=>out+=String(v));p.stderr.on('data',v=>err+=String(v));
      p.stdin.end();
      const timer=setTimeout(()=>p.kill(),5000);
      try {
        const code=await new Promise<number|null>(resolve=>p.once('close',resolve));
        assert.equal(code,valid?0:1);assert.equal(out,'');
        assert.equal(err.trim(),valid?'READY: read-only EOL stdio server':'FAIL: startup rejected');
      } finally {clearTimeout(timer);p.kill();}
    }
  } finally {f.cleanup();}
});

test('checked-in synthetic example identifies old production artifact and supported staging artifact',async()=>{
  const file=fileURLToPath(new URL('../../examples/eol-stdio.json',import.meta.url));
  const raw=JSON.parse(readFileSync(file,'utf8'));
  const r=buildEolStdioRuntime(raw),result=await r.service.execute(r.principal,query);
  assert.equal(result.items.length,2);
  assert.deepEqual(result.items.map(i=>[i.environment,i.status]),[['production','affected'],['staging','not_affected']]);
});
