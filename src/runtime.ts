import { registeredFile } from './paths.js';
import { createHash,timingSafeEqual } from 'node:crypto';
import { realpathSync,readFileSync,statSync } from 'node:fs';
import { isAbsolute,relative,resolve } from 'node:path';
import { z } from 'zod';
import { ApiError,operations,principalSchema,type AuthContext,type AuthProvider,type Permission,type WorkspaceRegistration,type AuditEvent } from './contracts.js';
import { EnginePool } from './engine-pool.js';
import { FixedWindowRateLimit,QueryService } from './service.js';
const configSchema=z.object({fixtureOnly:z.literal(true),expectedGraphSchema:z.string(),graphsRoot:z.string(),workspaces:z.array(z.object({tenant:z.string(),workspace:z.string(),engineWorkspace:z.string(),database:z.string(),repositories:z.record(z.string(),z.string()),repoRoots:z.array(z.string()),allowedEnvironments:z.array(z.string()),status:z.enum(['active','disabled'])})).max(8),identities:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),principal:principalSchema})).max(16)}).strict();
export class HashFixtureAuth implements AuthProvider{
 constructor(private readonly identities:readonly {sha256:string;principal:AuthContext}[]){}
 async authenticate(headers:Readonly<Record<string,string|string[]|undefined>>){const raw=headers.authorization;if(typeof raw!=='string'||!raw.startsWith('Bearer ')||raw.length>512)throw new ApiError('unauthenticated');const hash=createHash('sha256').update(raw.slice(7)).digest();const match=this.identities.find(v=>timingSafeEqual(Buffer.from(v.sha256,'hex'),hash));if(!match||match.principal.expiresAt<=Date.now())throw new ApiError('unauthenticated');return {...match.principal};}
}
export function buildRuntime(file:string,executable:string){
 const cfg=configSchema.parse(JSON.parse(readFileSync(file,'utf8')));const root=realpathSync(cfg.graphsRoot);
 const workspaces:WorkspaceRegistration[]=cfg.workspaces.map(w=>{const database=registeredFile(root,w.database);const rel=relative(root,database);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||!isAbsolute(w.database))throw new ApiError('invalid_request');return {...w,database};});
 const identities=workspaces.map(w=>{const s=statSync(w.database,{bigint:true});return `${s.dev}:${s.ino}`;});if(new Set(identities).size!==identities.length)throw new ApiError('invalid_request');
 if(new Set(workspaces.map(w=>JSON.stringify([w.tenant,w.workspace]))).size!==workspaces.length)throw new ApiError('invalid_request');
 const permissions:Permission[]=cfg.identities.flatMap(i=>workspaces.filter(w=>w.tenant===i.principal.tenant).map(w=>({principal:i.principal.principal,tenant:w.tenant,workspace:w.workspace,environments:['production'],repositories:Object.keys(w.repositories),operations})));
 const audit:AuditEvent[]=[];const metrics:{name:string;value:number;outcome:string}[]=[];
 const hooks={audit:{record:(event:AuditEvent)=>{if(audit.length>=1000)audit.shift();audit.push(event);}},metrics:{observe:(name:string,value:number,outcome:string)=>{if(metrics.length>=1000)metrics.shift();metrics.push({name,value,outcome});}},rateLimit:new FixedWindowRateLimit(200)};
 const pool=new EnginePool(executable,8,cfg.expectedGraphSchema,hooks.metrics);const service=new QueryService(workspaces,permissions,w=>pool.get(w),hooks);
 return {service,pool,workspaces,audit,metrics,auth:new HashFixtureAuth(cfg.identities),warm:async()=>{await pool.warm(workspaces);for(const identity of cfg.identities){const w=workspaces.find(w=>w.tenant===identity.principal.tenant);if(w)await service.execute(identity.principal,'inventory',{workspace:w.workspace,limit:1});}},close:async()=>pool.close()};
}
export const resolvePath=(p:string)=>resolve(p);
