import { displayText,relativeSource,factValue } from './redaction.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { requestContext } from './request-context.js';
import { responseSchemas,type ResponseMap } from './responses.js';
import { z } from 'zod';
import { ApiError,MAX_RESPONSE_BYTES,capabilitiesSchema,inputs,nativeNode,nativeEdge,principalSchema,reportSchema,safeError,type AuthContext,type AuditHook,type MetricsHook,type RateLimitHook,type Operation,type Permission,type WorkspaceRegistration,type EnginePort } from './contracts.js';
export interface ServiceHooks{audit:AuditHook;metrics:MetricsHook;rateLimit:RateLimitHook}
export class PolicyEngine{
 constructor(readonly registry:readonly WorkspaceRegistration[],private readonly permissions:readonly Permission[]){}
 decide(ctx:AuthContext,workspace:string,op:Operation,environments?:readonly string[],repositories?:readonly string[]){
  const p=principalSchema.safeParse(ctx);if(!p.success||ctx.expiresAt<=Date.now())return {allow:false as const,reason:'unauthenticated' as const};
  const target=this.registry.find(w=>w.tenant===ctx.tenant&&w.workspace===workspace&&w.status==='active');
  const permit=this.permissions.find(p=>p.tenant===ctx.tenant&&p.principal===ctx.principal&&p.workspace===workspace);
  if(!target||!permit||!ctx.scopes.includes('graph:read')||!permit.operations.includes(op))return {allow:false as const,reason:'permission_denied' as const};
  const env=environments??permit.environments,repos=repositories??permit.repositories;
  if(!env.length||!repos.length||env.length>16||repos.length>16||env.some(v=>!permit.environments.includes(v)||!target.allowedEnvironments.includes(v))||repos.some(v=>!permit.repositories.includes(v)||!target.repositories[v]))return {allow:false as const,reason:'permission_denied' as const};
  return {allow:true as const,reason:'policy_allowed',target,scope:{environments:[...env],repositories:repos.map(r=>target.repositories[r]!)}};
 }
}
const facts=new Set(['environment','allow_write','public_internet','funnel','access_mode','unverified','score_weight']);
function node(raw:unknown){const n=nativeNode.parse(raw);return {id:n.id,kind:n.kind,label:displayText(n.label),facts:Object.fromEntries(Object.entries(n.properties).filter(([k,v])=>facts.has(k)&&factValue(k,v.value)!==undefined).map(([k,v])=>[k,factValue(k,v.value)]))};}
function edge(raw:unknown){const e=nativeEdge.parse(raw);return {id:e.id,source:e.source,target:e.target,kind:e.kind};}
const object=(raw:unknown)=>z.record(z.string(),z.unknown()).parse(raw);
function shape(op:Operation,raw:unknown):Record<string,unknown>{
 if(op==='health'){z.object({status:z.literal('alive')}).passthrough().parse(raw);return {status:'alive'};}
 if(op==='capabilities'){capabilitiesSchema.parse(raw);return {apiVersion:'1.0',operations:['query','impact','trace','explain','inventory'],management:false,limits:{nodes:50,edges:100,provenance:16,bytes:MAX_RESPONSE_BYTES,depth:12}};}
 if(op==='query'){const r=reportSchema.parse(raw);return {hits:r.hits.map(h=>({...node(h.node),score:h.score})),totalMatches:r.total_matches,coverage:{inputNodes:r.coverage.input_nodes,eligibleNodes:r.coverage.eligible_nodes,semantics:'native-ranked-lexical.v1'},truncated:r.truncated??false,reason:r.truncated?'result_limit':null};}
 const r=object(raw);
 if(op==='inventory'){const nodes=z.array(z.unknown()).max(50).parse(r.nodes).map(node);return {nodes,repositories:[...new Set(z.array(nativeNode).parse(r.nodes).map(n=>n.repo_id).filter(v=>v!==null).map(v=>displayText(v,180)))],services:nodes.filter(n=>n.kind==='service'),resources:nodes.filter(n=>n.kind!=='service'),environments:[...new Set(nodes.map(n=>n.facts.environment).filter(v=>typeof v==='string'))],facetsScope:'current_page',edges:z.array(z.unknown()).max(100).parse(r.edges).map(edge),totalNodes:z.number().parse(r.total_nodes),totalEdges:z.number().parse(r.total_edges),truncated:z.boolean().parse(r.truncated),reason:r.reason,nextOffset:r.next_offset};}
 if(op==='trace'){const segments=z.array(z.object({source:nativeNode,target:nativeNode,edge:nativeEdge}).passthrough()).max(12).parse(r.segments);return {segments:segments.map(s=>({from:node(s.source),to:node(s.target),edge:edge(s.edge)})),truncated:z.boolean().parse(r.truncated),reason:r.truncated?'depth_limit':null,coverageGaps:z.array(z.string().max(256)).parse(r.coverage_gaps).map(v=>displayText(v))};}
 if(op==='impact'){
  const items=[];for(const category of ['direct_consumers','transitive_consumers','possibly_affected','unknown_due_to_coverage'])for(const item of z.array(z.object({node:nativeNode,classification:z.string(),depth:z.number()}).passthrough()).max(50).parse(r[category]))items.push({...node(item.node),classification:item.classification,depth:item.depth});
  if(items.length>50)throw new ApiError('response_too_large');
  return {target:node(object(r.target).node),items,risk:r.risk,truncated:r.truncation!==null,reason:r.truncation?'engine_bound':null,coverageIncomplete:true};
 }
 const provenance=[];for(const[key,value]of Object.entries(object(r.properties))){const p=object(value);const scalar=factValue(key,p.value);if(facts.has(key)&&scalar!==undefined)provenance.push({property:key,value:scalar,sourceFile:relativeSource(p.source_file),sourcePointer:'/properties/'+key,extractor:typeof p.extractor==='string'?displayText(p.extractor,128):'[redacted]',origin:p.provenance});}
 const evidence=z.array(z.record(z.string(),z.unknown())).max(16).parse(r.evidence).map(e=>({id:e.id,extractor:typeof e.extractor==='string'?displayText(e.extractor,128):'[redacted]',origin:e.provenance,confidence:e.confidence}));
 return {target:r.target,kind:r.kind,provenance,evidence,truncated:z.boolean().parse(r.truncated),reason:r.reason};
}
export class QueryService{
 readonly policy:PolicyEngine;
 constructor(workspaces:readonly WorkspaceRegistration[],permissions:readonly Permission[],private readonly engine:(w:WorkspaceRegistration)=>EnginePort,readonly hooks:ServiceHooks){this.policy=new PolicyEngine(workspaces,permissions);}
 async execute<O extends Operation>(ctx:AuthContext,operation:O,raw:unknown,signal?:AbortSignal):Promise<ResponseMap[O]>{
  const started=performance.now(),requestId=requestContext.getStore()?.requestId??randomUUID();let workspace='invalid',environments:readonly string[]=[],allowed=false,outcome='invalid_request',resultCount=0;
  try{
   const parsed=inputs[operation].safeParse(raw);if(!parsed.success)throw new ApiError('invalid_request');const q=parsed.data;workspace=q.workspace;
   const decision=this.policy.decide(ctx,workspace,operation,q.environments,q.repositories);
   if(!decision.allow)throw new ApiError(decision.reason);allowed=true;environments=decision.scope.environments;if(signal?.aborted)throw new ApiError('cancelled');
   const admission=this.hooks.rateLimit.admit(JSON.stringify([ctx.tenant,ctx.principal,workspace,operation]));if(!admission.allow)throw new ApiError('rate_limited',true,admission.retryAfter);
   const client=this.engine(decision.target);await client.negotiate();const params:Record<string,unknown>={scope:decision.scope};
   for(const[k,v]of Object.entries(q))if(!['workspace','environments','repositories'].includes(k))params[k==='maxDepth'?'max_depth':k]=v;
   const response=responseSchemas[operation].parse(shape(operation,await client.call(operation,operation==='health'||operation==='capabilities'?{}:params,signal))) as ResponseMap[O];
   if(Buffer.byteLength(JSON.stringify(response))>MAX_RESPONSE_BYTES)throw new ApiError('response_too_large');
   resultCount='hits'in response?response.hits.length:'nodes'in response?response.nodes.length:'items'in response?response.items.length:'segments'in response?response.segments.length:0;outcome='ok';return response;
  }catch(e){const error=e instanceof z.ZodError?new ApiError('invalid_engine_response'):safeError(e);outcome=error.code;if(error.code==='engine_crash'||error.code==='engine_timeout')this.hooks.metrics.observe(error.code,1,error.code);if(error.code==='permission_denied'||error.code==='unauthenticated')allowed=false;throw error;}
  finally{try{this.hooks.audit.record({requestId,principal:ctx.principal,tenant:ctx.tenant,workspace,operation,environments,allowed,durationMs:performance.now()-started,resultCount,outcome});this.hooks.metrics.observe(operation,performance.now()-started,outcome);}catch{throw new ApiError('internal_error');}}
 }
 query(ctx:AuthContext,raw:unknown){return this.execute(ctx,'query',raw)}
 control(ctx:AuthContext,workspace:string,op:'health'|'capabilities'){return this.execute(ctx,op,{workspace})}
}
export class FixedWindowRateLimit implements RateLimitHook{
 private readonly counters=new Map<string,{start:number;count:number}>();constructor(private readonly max=60,private readonly windowMs=60000){}
 admit(key:string){const now=performance.now();let v=this.counters.get(key);if(!v||now-v.start>=this.windowMs){for(const[k,x]of this.counters)if(now-x.start>=this.windowMs)this.counters.delete(k);if(this.counters.size>=1000&&!this.counters.has(key))return {allow:false,retryAfter:1};v={start:now,count:0};this.counters.set(key,v);}const allow=++v.count<=this.max;return {allow,retryAfter:allow?0:Math.max(1,Math.ceil((this.windowMs-(now-v.start))/1000))};}
}
export const controlInput=inputs.capabilities;
