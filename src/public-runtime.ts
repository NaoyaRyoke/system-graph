import { readFileSync,realpathSync,statSync } from 'node:fs';
import { z } from 'zod';
import { operations,id,principalSchema,ApiError,type AuditEvent,type Permission,type WorkspaceRegistration } from './contracts.js';
import { JwtAuth,PinnedJwks } from './auth.js';
import { HashFixtureAuth } from './runtime.js';
import { registeredFile } from './paths.js';
import { EnginePool } from './engine-pool.js';
import { QueryService,FixedWindowRateLimit } from './service.js';
const workspace=z.object({tenant:id,workspace:id,engineWorkspace:id,database:z.string(),repositories:z.record(id,z.string()),repoRoots:z.array(z.string()).max(16),allowedEnvironments:z.array(id).min(1).max(16),status:z.enum(['active','disabled'])}).strict();
const permission=z.object({principal:id,tenant:id,workspace:id,environments:z.array(id).min(1).max(16),repositories:z.array(id).min(1).max(16),operations:z.array(z.enum(operations)).min(1).max(7)}).strict();
const binding=z.object({issuer:z.url(),subject:z.string().min(1).max(128),principal:id,tenant:id}).strict();
const auth=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('dev-bearer'),identities:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),principal:principalSchema}).strict()).min(1).max(16)}).strict(),
 z.object({mode:z.literal('jwt'),issuer:z.url(),audience:z.url(),jwks:z.unknown(),bindings:z.array(binding).min(1).max(16)}).strict()
]);
const configSchema=z.object({version:z.literal(1),expectedGraphSchema:z.string(),graphsRoot:z.string(),workspaces:z.array(workspace).length(1),permissions:z.array(permission).min(1).max(128),auth}).strict();
export function buildPublicRuntime(file:string,executable:string){
 const cfg=configSchema.parse(JSON.parse(readFileSync(file,'utf8'))),root=realpathSync(cfg.graphsRoot);
 const workspaces:WorkspaceRegistration[]=cfg.workspaces.map(w=>({...w,database:registeredFile(root,w.database)}));
 const inodes=workspaces.map(w=>{const s=statSync(w.database,{bigint:true});return `${s.dev}:${s.ino}`;});
 if(new Set(inodes).size!==inodes.length||new Set(workspaces.map(w=>JSON.stringify([w.tenant,w.workspace]))).size!==workspaces.length)throw new ApiError('invalid_request');
 const permissions:Permission[]=cfg.permissions;
 const authProvider=cfg.auth.mode==='jwt'?new JwtAuth(cfg.auth.issuer,cfg.auth.audience,new PinnedJwks(cfg.auth.jwks),cfg.auth.bindings):new HashFixtureAuth(cfg.auth.identities);
 const audit:AuditEvent[]=[],metrics:{name:string;value:number;outcome:string}[]=[];
 const hooks={audit:{record:(e:AuditEvent)=>{if(audit.length===1000)audit.shift();audit.push(e);}},metrics:{observe:(name:string,value:number,outcome:string)=>{if(metrics.length===1000)metrics.shift();metrics.push({name,value,outcome});}},rateLimit:new FixedWindowRateLimit(60)};
 const pool=new EnginePool(executable,8,cfg.expectedGraphSchema,hooks.metrics),service=new QueryService(workspaces,permissions,w=>pool.get(w),hooks);
 return {auth:authProvider,authMode:cfg.auth.mode,workspaces,pool,service,audit,metrics,warm:async()=>{await pool.warm(workspaces);for(const w of workspaces)await pool.get(w).call('inventory',{limit:1,scope:{environments:[w.allowedEnvironments[0]],repositories:Object.values(w.repositories)}});},close:async()=>pool.close()};
}
