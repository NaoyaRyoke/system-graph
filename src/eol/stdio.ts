import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { id, type AuditEvent, type AuthContext, type Permission, type WorkspaceRegistration } from '../contracts.js';
import { FixedWindowRateLimit, PolicyEngine } from '../service.js';
import { createEolServer } from './mcp.js';
import { eolNoticeSchema, eolSnapshotSchema } from './model.js';
import { EolQueryService, MemoryEolSources } from './service.js';

// This additive launcher accepts no engine/database configuration and starts no worker.
export const eolStdioConfigSchema=z.object({
  version:z.literal(1), localPrincipal:z.object({principal:id,tenant:id}).strict(),
  workspace:z.object({tenant:id,workspace:id,repositories:z.record(id,z.string().min(1).max(180))
    .refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=16),
    allowedEnvironments:z.array(id).min(1).max(16),status:z.enum(['active','disabled'])}).strict(),
  permissions:z.array(z.object({principal:id,tenant:id,workspace:id,
    repositories:z.array(id).min(1).max(16),environments:z.array(id).min(1).max(16),
    operations:z.array(z.literal('inventory')).length(1),
  }).strict()).min(1).max(128),
  maxAgeDays:z.number().int().min(0).max(3650).default(30),
  notices:z.array(eolNoticeSchema).min(1).max(100), snapshots:z.array(eolSnapshotSchema).min(1).max(16),
}).strict();

export function buildEolStdioRuntime(raw:unknown) {
  const cfg=eolStdioConfigSchema.parse(raw);
  const principal:AuthContext={...cfg.localPrincipal,subject:cfg.localPrincipal.principal,
    issuer:'https://stdio.invalid',roles:['reader'],scopes:['graph:read'],expiresAt:Number.MAX_SAFE_INTEGER};
  const w:WorkspaceRegistration={...cfg.workspace,engineWorkspace:cfg.workspace.workspace,database:'',repoRoots:[]};
  const permissions:Permission[]=cfg.permissions;
  const policy=new PolicyEngine([w],permissions);
  if(!policy.decide(principal,w.workspace,'inventory').allow)throw new Error('local identity rejected');
  const sources=new MemoryEolSources([{tenant:w.tenant,workspace:w.workspace,notices:cfg.notices,snapshots:cfg.snapshots}]);
  const audit:AuditEvent[]=[],metrics:{operation:string;value:number;outcome:string}[]=[];
  const service=new EolQueryService(policy,sources,{
    // Fixed identity, no request contents or evidence enter process logs.
    audit:{record:e=>{if(audit.length===1000)audit.shift();audit.push(e);}},
    metrics:{observe:(operation,value,outcome)=>{if(metrics.length===1000)metrics.shift();metrics.push({operation,value,outcome});}},
    rateLimit:new FixedWindowRateLimit(60),
  },cfg.maxAgeDays);
  return {service,principal,audit,metrics};
}

export async function runEolStdio(file:string):Promise<void> {
  if(!isAbsolute(file))throw new Error('absolute config path required');
  const stat=statSync(file);
  if(!stat.isFile()||stat.size>16*1024*1024)throw new Error('invalid config');
  const runtime=buildEolStdioRuntime(JSON.parse(readFileSync(file,'utf8')));
  const abort=new AbortController();
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:16384});
  const handle=serveStdio(()=>createEolServer({...runtime,signal:abort.signal}),{
    transport,legacy:'serve',onerror:()=>{process.stderr.write('WARN: MCP transport error\n');},
  });
  let stopping:Promise<void>|undefined;
  const stop=()=>stopping??=(async()=>{
    abort.abort();await handle.close();process.stdin.destroy();
    process.off('SIGINT',signalStop);process.off('SIGTERM',signalStop);
  })();
  const signalStop=()=>{void stop().catch(()=>{process.exitCode=1;});};
  const closed=transport.onclose;
  transport.onclose=()=>{closed?.();signalStop();};
  process.on('SIGINT',signalStop);process.on('SIGTERM',signalStop);
  process.stderr.write('READY: read-only EOL stdio server\n');
}
