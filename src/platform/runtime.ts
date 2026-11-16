import { z } from 'zod';
import { readFileSync,statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StdioServerTransport,serveStdio } from '@modelcontextprotocol/server/stdio';
import { id,operations,type AuthContext,type AuditEvent,type WorkspaceRegistration } from '../contracts.js';
import { PolicyEngine,FixedWindowRateLimit } from '../service.js';
import { referenceId,timestamp } from '../assessments/model.js';
import { repositorySchema,LocalRepositorySource,GitRepositorySource } from './collect.js';
import { artifactSchema } from './composition.js';
import { FileSnapshotStore,MemorySnapshotStore,type SnapshotStore } from './storage.js';
import { FileWorkStore,MemoryWorkStore,noticeSchema,reevaluateNotice,type WorkStore } from './remediation.js';
import { SystemCoordinator,systemSnapshotSchema,type SystemSnapshot,type ArtifactInput } from './system.js';
import { PlatformQueryService,MemoryNoticeSource } from './service.js';
import { createPlatformServer } from './mcp.js';

const absolute=z.string().refine(isAbsolute,'absolute path required');
const sourceSchema=z.object({snapshotId:referenceId,asOf:timestamp,previousSnapshotId:referenceId.optional(),
  mode:z.enum(['working_tree','git_commit']).default('working_tree'),
  repositories:z.array(repositorySchema.extend({root:absolute})).min(1).max(16),
  artifacts:z.array(z.object({sbom:z.unknown(),metadata:artifactSchema.omit({sbom:true,id:true}).extend({id:referenceId.optional()})}).strict()).max(1000),
  runtime:z.unknown()}).strict();
export const platformConfigSchema=z.object({version:z.literal(1),localPrincipal:z.object({principal:id,tenant:id}).strict(),
  workspace:z.object({tenant:id,workspace:id,repositories:z.record(id,id).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=16),
    allowedEnvironments:z.array(id).min(1).max(16),status:z.enum(['active','disabled'])}).strict(),
  permissions:z.array(z.object({principal:id,tenant:id,workspace:id,repositories:z.array(id).min(1).max(16),environments:z.array(id).min(1).max(16),
    operations:z.array(z.enum(operations)).min(1).max(7)}).strict()).min(1).max(128),
  notices:z.array(noticeSchema).max(100),maxAgeDays:z.number().int().min(0).max(3650).default(30),
  snapshots:z.array(systemSnapshotSchema).min(1).max(16).optional(),source:sourceSchema.optional(),snapshotRoot:absolute.optional(),workRoot:absolute.optional(),
}).strict().refine(c=>(c.source===undefined)!==(c.snapshots===undefined),'provide exactly one of source or snapshots');

export async function buildPlatformRuntime(raw:unknown) {
  const cfg=platformConfigSchema.parse(raw),w:WorkspaceRegistration={...cfg.workspace,engineWorkspace:cfg.workspace.workspace,database:'',repoRoots:[]};
  const principal:AuthContext={...cfg.localPrincipal,subject:cfg.localPrincipal.principal,issuer:'https://stdio.invalid',roles:['reader'],scopes:['graph:read'],expiresAt:Number.MAX_SAFE_INTEGER};
  const policy=new PolicyEngine([w],cfg.permissions);
  if(!policy.decide(principal,w.workspace,'capabilities').allow)throw new Error('local identity rejected');
  const notices=new MemoryNoticeSource(cfg.notices.map(notice=>({tenant:w.tenant,workspace:w.workspace,notice})));
  const snapshots:SnapshotStore<SystemSnapshot>=cfg.snapshotRoot?await FileSnapshotStore.open(cfg.snapshotRoot,systemSnapshotSchema.parse):new MemorySnapshotStore(systemSnapshotSchema.parse);
  const work:WorkStore=cfg.workRoot?await FileWorkStore.open(cfg.workRoot):new MemoryWorkStore();
  // Startup can reopen an old immutable view. It must not rewind later periodic
  // evaluations or workflow intent already persisted in workRoot.
  const eligibleNotices=async(at:string)=>{
    const eligible=[];
    for(const notice of cfg.notices){const records=await work.list(w.tenant,w.workspace,notice.id);
      if(records.every(r=>Math.max(Date.parse(r.evaluatedAt),Date.parse(r.history.at(-1)!.lastAt))<=Date.parse(at)))eligible.push(notice);
    }return eligible;
  };
  const loaded:SystemSnapshot[]=[];
  if(cfg.snapshots)for(const snapshot of cfg.snapshots){await snapshots.put(w.tenant,w.workspace,snapshot);loaded.push(snapshot);}
  if(cfg.source){
    const source=cfg.source;
    if(source.repositories.some(r=>!Object.values(w.repositories).includes(r.repositoryId)||!w.allowedEnvironments.includes(r.environment??'unknown')))throw new Error('unregistered source');
    const roots=Object.fromEntries(source.repositories.map(r=>[r.repositoryId,r.root]));
    const artifacts=source.artifacts as ArtifactInput[];
    const bootstrapNotices=await eligibleNotices(source.asOf);
    const coordinator=new SystemCoordinator({repositories:source.mode==='git_commit'?new GitRepositorySource(roots):new LocalRepositorySource(roots),artifacts:{read:async()=>structuredClone(artifacts)},
      runtime:{read:async()=>structuredClone(source.runtime)},notifications:{read:async()=>structuredClone(bootstrapNotices)}},snapshots,work);
    const result=await coordinator.refresh({tenant:w.tenant,workspace:w.workspace,snapshotId:source.snapshotId,asOf:source.asOf,
      repositories:source.repositories.map(({root: _root,...repo})=>repo),...(source.previousSnapshotId?{previousSnapshotId:source.previousSnapshotId}:{}),trigger:'composition_updated',maxAgeDays:cfg.maxAgeDays});
    loaded.push(result.snapshot);
  }else{
    const ordered=[...loaded].sort((a,b)=>Date.parse(b.graph.collectedAt)-Date.parse(a.graph.collectedAt)),latest=ordered[0];
    // A tied timestamp does not establish which distinct snapshot is current.
    if(latest&&(!ordered[1]||Date.parse(ordered[1].graph.collectedAt)!==Date.parse(latest.graph.collectedAt)))for(const notice of await eligibleNotices(latest.graph.collectedAt))
      await reevaluateNotice(notice,latest.composition,work,{tenant:w.tenant,workspace:w.workspace,asOf:latest.graph.collectedAt,trigger:'manual',maxAgeDays:cfg.maxAgeDays});
  }
  const audit:AuditEvent[]=[],metrics:{operation:string;value:number;outcome:string}[]=[];
  const service=new PlatformQueryService(policy,snapshots,notices,work,{audit:{record:e=>{if(audit.length===1000)audit.shift();audit.push(e);}},
    metrics:{observe:(operation,value,outcome)=>{if(metrics.length===1000)metrics.shift();metrics.push({operation,value,outcome});}},rateLimit:new FixedWindowRateLimit(60)},cfg.maxAgeDays);
  return {service,principal,snapshots,work,audit,metrics,loaded};
}
export async function runPlatformStdio(file:string):Promise<void> {
  if(!isAbsolute(file))throw new Error('absolute config required');const s=statSync(file);
  if(!s.isFile()||s.size>32*1024*1024)throw new Error('invalid config');
  const runtime=await buildPlatformRuntime(JSON.parse(readFileSync(file,'utf8'))),abort=new AbortController();
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:16384});
  const handle=serveStdio(()=>createPlatformServer({...runtime,signal:abort.signal}),{transport,legacy:'serve',onerror:()=>{process.stderr.write('WARN: MCP transport error\n');}});
  let stopping:Promise<void>|undefined;
  const stop=()=>stopping??=(async()=>{abort.abort();await handle.close();process.stdin.destroy();process.off('SIGINT',signalStop);process.off('SIGTERM',signalStop);})();
  const signalStop=()=>{void stop().catch(()=>{process.exitCode=1;});};
  const closed=transport.onclose;transport.onclose=()=>{closed?.();signalStop();};process.on('SIGINT',signalStop);process.on('SIGTERM',signalStop);
  process.stderr.write('READY: read-only TypeScript system graph server\n');
}
