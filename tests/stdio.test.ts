import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { config, root, executable, ids, fixture } from './support.js';
import { operations, type Operation } from '../src/contracts.js';
import { buildStdioRuntime } from '../src/graph/stdio-runtime.js';

const entry = join(root, 'dist/index.js');
const names = ['graph_capabilities','graph_explain','graph_impact','graph_inventory','graph_query','graph_trace'];
function localConfig() {
  const c = config(), w = c.data.workspaces[0]!, identity = c.data.identities[0]!.principal;
  return { version: 1, expectedGraphSchema: c.data.expectedGraphSchema, graphsRoot: c.data.graphsRoot,
    workspaces: [w], permissions: [{ principal: identity.principal, tenant: w.tenant, workspace: w.workspace,
      environments: ['production'], repositories: Object.keys(w.repositories), operations }],
    localPrincipal: { principal: identity.principal, tenant: w.tenant } };
}
function save(data = localConfig()) {
  const file = join(root, 'artifacts/stdio-' + randomUUID() + '.json');
  writeFileSync(file, JSON.stringify(data)); return file;
}
const args = (op: Operation) => {
  const n = ids('alpha');
  return op === 'query' ? {workspace:'main',query:'service'} :
    op === 'impact' || op === 'explain' ? {workspace:'main',target:n.api} :
    op === 'trace' ? {workspace:'main',source:n.reader,destination:n.api} : {workspace:'main'};
};
type Message = { jsonrpc: string; id?: number; result?: any; error?: {code:number;message:string} };
function raw(file: string, engine = executable, envConfig = false) {
  const child = spawn(process.execPath, [entry, ...(envConfig ? [] : [file,engine])], {
    cwd: tmpdir(), windowsHide: true, stdio: 'pipe',
    env: {...process.env,...(envConfig ? {SYSTEM_GRAPH_CONFIG:file,SYSTEM_GRAPH_ENGINE:engine} : {})},
  });
  let stdout = '', stderr = '', buffer = '', next = 0;
  const messages: Message[] = [], invalid: string[] = [];
  const pending = new Map<number, (v:Message)=>void>();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk:string) => {
    stdout += chunk; buffer += chunk;
    for (;;) {
      const end=buffer.indexOf('\n'); if(end<0)break;
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try { const message=JSON.parse(line) as Message;
        if(message.jsonrpc!=='2.0')invalid.push('non-protocol JSON');
        messages.push(message); if(message.id!==undefined)pending.get(message.id)?.(message);
      } catch {invalid.push('non-JSON stdout');}
    }
  });
  child.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
  const closed = new Promise<number|null>(resolve=>child.once('close',resolve));
  async function request(method:string, params:Record<string,unknown>={}) {
    const id=++next;
    const response=new Promise<Message>((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('MCP response timeout'));},6000);
      pending.set(id,v=>{clearTimeout(timer);pending.delete(id);resolve(v);});
    });
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    return response;
  }
  async function initialize() {
    const r=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'stdio-regression',version:'1'}});
    assert.equal(r.error,undefined); assert.ok(r.result.capabilities.tools);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  }
  async function finish() {
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      const code=await Promise.race([closed,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{child.kill();reject(Error('stdio failed to shut down'));},3000);
      })]);
      assert.equal(code,0); assert.deepEqual(invalid,[]); assert.equal(buffer,'');
    } finally {if(timer)clearTimeout(timer);}
  }
  return {child,closed,request,initialize,finish,messages,invalid,get stdout(){return stdout;},get stderr(){return stderr;}};
}

test('stdio initialize/list and all six calls preserve service semantics and database bytes; stdout is protocol only',async()=>{
  const file=save(),p=raw(file),f=fixture();
  const hash=()=>createHash('sha256').update(readFileSync(f.workspaces[0]!.database)).digest('hex'),before=hash();
  try {
    await p.initialize(); const list=await p.request('tools/list');
    assert.deepEqual(list.result.tools.map((t:{name:string})=>t.name),names);
    for(const tool of list.result.tools)assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
    for(const op of ['capabilities','inventory','query','impact','trace','explain'] as const){
      const r=await p.request('tools/call',{name:'graph_'+op,arguments:args(op)});
      assert.equal(r.error,undefined);assert.notEqual(r.result.isError,true);
      assert.deepEqual(r.result.structuredContent,await f.service.execute(f.owner,op,args(op)));
      assert.deepEqual(r.result.content,[{type:'text',text:'Read-only graph result.'}]);
    }
    await p.finish();assert.equal(hash(),before);assert.match(p.stderr,/READY: read-only graph stdio server/);
  } finally {p.child.kill();await f.close();unlinkSync(file);}
});

test('modern SDK launches command plus args from another cwd and calls every shared tool',async()=>{
  const file=save(),transport=new StdioClientTransport({command:process.execPath,args:[entry,file,executable],cwd:tmpdir(),stderr:'pipe'});
  const c=new Client({name:'modern-stdio',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
  transport.stderr?.on('data',()=>{});
  try {
    await c.connect(transport);assert.equal(c.getProtocolEra(),'modern');
    assert.deepEqual((await c.listTools()).tools.map(t=>t.name),names);
    for(const op of ['capabilities','inventory','query','impact','trace','explain'] as const)
      assert.notEqual((await c.callTool({name:'graph_'+op,arguments:args(op)})).isError,true);
  } finally {await c.close();unlinkSync(file);}
});

test('stdio rejects malformed arguments, unknown tools and arbitrary URL/path/tenant selectors',async()=>{
  const file=save(),p=raw(file);
  try {
    await p.initialize();
    for(const extra of [{query:''},{query:123},{url:'http://169.254.169.254'},{path:'../outside'},{tenant:'tenant-b'},{command:'synthetic-command'},{limit:51}]) {
      const r=await p.request('tools/call',{name:'graph_query',arguments:{...args('query'),...extra}});
      assert.ok(r.error||r.result?.isError);
    }
    const unknown=await p.request('tools/call',{name:'make_request',arguments:{url:'http://127.0.0.1'}});
    assert.ok(unknown.error||unknown.result?.isError); await p.finish();
  } finally {p.child.kill();unlinkSync(file);}
});

test('stdio keeps environment/workspace/foreign IDs denied and selected false provenance intact',async()=>{
  const file=save(),p=raw(file);
  try {
    await p.initialize();
    for(const [op,a,expected] of [
      ['query',{...args('query'),workspace:'absent'},'permission_denied'],
      ['query',{...args('query'),environments:['development']},'permission_denied'],
      ['query',{...args('query'),repositories:['foreign']},'permission_denied'],
      ['impact',{workspace:'main',target:ids('beta').api},'not_found'],
      ['trace',{workspace:'main',source:ids('alpha').reader,destination:ids('beta').api},'not_found'],
      ['explain',{workspace:'main',target:ids('beta').reader},'not_found'],
    ] as const) {
      const r=await p.request('tools/call',{name:'graph_'+op,arguments:a});
      assert.equal(r.result.isError,true);assert.equal(JSON.parse(r.result.content[0].text).error.code,expected);
    }
    const explain=await p.request('tools/call',{name:'graph_explain',arguments:{workspace:'main',target:ids('alpha').reader}});
    assert.match(JSON.stringify(explain.result.structuredContent),/"value":false/);
    assert.ok(!JSON.stringify(explain).includes(root));await p.finish();
  } finally {p.child.kill();unlinkSync(file);}
});

test('stdio supports environment configuration with the template node/dist/index.js command',async()=>{
  const file=save(),p=raw(file,executable,true);
  try {await p.initialize();assert.equal((await p.request('tools/list')).result.tools.length,6);await p.finish();}
  finally {p.child.kill();unlinkSync(file);}
});

test('stdio unavailable Rust host exits nonzero, cleans up and prints a fixed stderr error only',async()=>{
  const file=save(),p=raw(file,join(root,'artifacts/absent-engine'));
  try {assert.equal(await p.closed,1);assert.equal(p.stdout,'');assert.equal(p.stderr.trim(),'FAIL: startup rejected');}
  finally {p.child.kill();unlinkSync(file);}
});

test('stdio missing configuration is rejected without stdout or input echo',async()=>{
  const child=spawn(process.execPath,[entry],{windowsHide:true,stdio:'pipe',env:{...process.env,SYSTEM_GRAPH_CONFIG:'',SYSTEM_GRAPH_ENGINE:''}});
  let out='',err='';child.stdout.on('data',s=>out+=String(s));child.stderr.on('data',s=>err+=String(s));
  assert.equal(await new Promise(resolve=>child.once('close',resolve)),1);
  assert.equal(out,'');assert.equal(err.trim(),'FAIL: startup rejected');
});

test('stdio config requires a bound local identity, one workspace and strict fields before spawning',()=>{
  const base=localConfig();
  for(const data of [
    {...base,localPrincipal:{principal:'unknown',tenant:'tenant-a'}},
    {...base,localPrincipal:{principal:'reader-a',tenant:'tenant-b'}},
    {...base,workspaces:[...base.workspaces,...base.workspaces]},
    {...base,auth:{mode:'dev-bearer',identities:[]}},
    {...base,localPrincipal:undefined},
    {...base,workspaces:[{...base.workspaces[0]!,status:'disabled'}]},
  ]) {
    const file=save(data as ReturnType<typeof localConfig>);
    try {assert.throws(()=>buildStdioRuntime(file,executable));}finally{unlinkSync(file);}
  }
});

test('stdio EOF before initialize closes the warmed Rust worker naturally',async()=>{
  const file=save(),p=raw(file);
  try {await p.finish();assert.deepEqual(p.messages,[]);}finally{p.child.kill();unlinkSync(file);}
});

test('stdio ignores malformed JSON per SDK framing and subsequent valid protocol requests still work',async()=>{
  const file=save(),p=raw(file);
  try {p.child.stdin.write('{broken-json}\n');await p.initialize();await p.finish();assert.ok(!p.stderr.includes('broken-json'));}
  finally{p.child.kill();unlinkSync(file);}
});

test('stdio oversized protocol input closes the connection and worker with clean stdout',async()=>{
  const file=save(),p=raw(file);
  try {
    await p.initialize();p.child.stdin.write('x'.repeat(16385));
    const timer=setTimeout(()=>p.child.kill(),3000);
    try {assert.equal(await p.closed,0);}finally{clearTimeout(timer);}
    assert.deepEqual(p.invalid,[]);assert.match(p.stderr,/WARN: MCP transport error/);
  }finally{p.child.kill();unlinkSync(file);}
});

if (process.platform !== 'win32') test('stdio SIGTERM closes a negotiated connection and Rust worker without waiting for client EOF',async()=>{
  const file=save(),p=raw(file);
  try {
    await p.initialize();p.child.kill('SIGTERM');
    const timer=setTimeout(()=>p.child.kill('SIGKILL'),3000);
    try {assert.equal(await p.closed,0);}finally{clearTimeout(timer);}
    assert.deepEqual(p.invalid,[]);
  }finally{p.child.kill();unlinkSync(file);}
});
