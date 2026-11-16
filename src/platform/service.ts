import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { id,ApiError,MAX_RESPONSE_BYTES,safeError,type AuthContext,type Operation } from '../contracts.js';
import { PolicyEngine,type ServiceHooks } from '../service.js';
import { referenceId,timestamp } from '../assessments/model.js';
import { displayText,relativeSource } from '../redaction.js';
import { requestContext } from '../request-context.js';
import { evaluateEol } from '../eol/evaluate.js';
import { scopeGraph,impact,trace,traversalOptionsSchema } from './graph.js';
import { scopeComposition,compositionToEol } from './composition.js';
import { evaluateVulnerability } from './vulnerability.js';
import { noticeSchema,type Notice,type WorkStore } from './remediation.js';
import { systemSnapshotSchema,type SystemSnapshot } from './system.js';
import type { SnapshotStore } from './storage.js';

const scope={workspace:id,environments:z.array(id).min(1).max(16).optional(),repositories:z.array(id).min(1).max(16).optional()};
const snapshot={...scope,snapshotId:referenceId,asOf:timestamp};
const paging={limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(12000).default(0)};
const traversal=traversalOptionsSchema.omit({asOf:true,maxAgeDays:true}).shape;
export const platformInputs={
  capabilities:z.object(scope).strict(),health:z.object(scope).strict(),
  inventory:z.object({...snapshot,...paging,edgeOffset:z.number().int().min(0).max(60000).default(0)}).strict(),
  query:z.object({...snapshot,...paging,edgeOffset:z.number().int().min(0).max(60000).default(0),query:z.string().trim().min(1).refine(v=>Buffer.byteLength(v)<=256)}).strict(),
  impact:z.object({...snapshot,...traversal,target:referenceId,direction:z.enum(['upstream','downstream','both']).default('upstream')}).strict(),
  trace:z.object({...snapshot,...traversal,source:referenceId,destination:referenceId,direction:z.enum(['upstream','downstream','both']).default('downstream')}).strict(),
  explain:z.object({...snapshot,target:referenceId,kind:z.enum(['node','edge']).default('node')}).strict(),
  vulnerability:z.object({...snapshot,...paging,noticeId:referenceId,noticeRevision:referenceId}).strict(),
  eol:z.object({...snapshot,...paging,noticeId:referenceId,noticeRevision:referenceId}).strict(),
  remediation:z.object({...scope,...paging,noticeId:referenceId.optional()}).strict(),
};
export type PlatformOperation=keyof typeof platformInputs;
export interface PlatformNoticeSource {get(tenant:string,workspace:string,id:string,signal?:AbortSignal):Promise<Notice|undefined>}
export class MemoryNoticeSource implements PlatformNoticeSource {
  private readonly values=new Map<string,Notice>();
  constructor(records:readonly {tenant:string;workspace:string;notice:Notice}[]){for(const r of records){
    const notice=noticeSchema.parse(r.notice),key=JSON.stringify([r.tenant,r.workspace,notice.id]);
    if(this.values.has(key))throw new ApiError('invalid_request');this.values.set(key,notice);
  }}
  async get(t:string,w:string,id:string){const n=this.values.get(JSON.stringify([t,w,id]));return n?structuredClone(n):undefined;}
}
export function publicProjection(value:unknown,key=''):unknown {
  if(typeof value==='string')return key==='source'?(relativeSource(value)??'[redacted]'):displayText(value);
  if(Array.isArray(value))return value.map(v=>publicProjection(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['password','secret','token','authorization','api_key'].includes(k.toLowerCase())).map(([k,v])=>[displayText(k,128),publicProjection(v,k)]));
  return value;
}
const page=<T>(all:T[],limit:number,offset:number)=>({items:all.slice(offset,offset+limit),total:all.length,limit,offset,
  hasMore:offset+Math.min(limit,Math.max(0,all.length-offset))<all.length,nextOffset:offset+limit<all.length?offset+limit:null});
/** Transport-independent authenticated read adapter. Every feature calls the public TS core. */
export class PlatformQueryService {
  constructor(readonly policy:PolicyEngine,private readonly snapshots:SnapshotStore<SystemSnapshot>,private readonly notices:PlatformNoticeSource,
    private readonly work:WorkStore,private readonly hooks:ServiceHooks,private readonly maxAgeDays=30){}
  async execute(ctx:AuthContext,operation:PlatformOperation,raw:unknown,signal?:AbortSignal):Promise<Record<string,unknown>> {
    const started=performance.now(),requestId=requestContext.getStore()?.requestId??randomUUID();
    let workspace='invalid',allowed=false,environments:readonly string[]=[],outcome='invalid_request',resultCount=0;
    try {
      const parsed=platformInputs[operation].safeParse(raw);if(!parsed.success)throw new ApiError('invalid_request');
      const q=parsed.data;workspace=q.workspace;
      const permission:Operation=['eol','vulnerability','remediation'].includes(operation)?'inventory':operation as Operation;
      const decision=this.policy.decide(ctx,workspace,permission,q.environments,q.repositories);
      if(!decision.allow)throw new ApiError(decision.reason);allowed=true;environments=decision.scope.environments;
      if(signal?.aborted)throw new ApiError('cancelled');
      const rate=this.hooks.rateLimit.admit(JSON.stringify([ctx.tenant,ctx.principal,workspace,operation]));if(!rate.allow)throw new ApiError('rate_limited',true,rate.retryAfter);
      let result:unknown;
      if(operation==='health')result={status:'alive'};
      else if(operation==='capabilities')result={apiVersion:'portable-1',implementation:'typescript',operations:Object.keys(platformInputs).filter(k=>k!=='health'),
        graphSchema:1,compositionSchema:1,sbomFormats:['CycloneDX-1.6-JSON'],management:false,maxAgeDays:this.maxAgeDays,
        limits:{nodes:12000,edges:60000,page:50,bytes:MAX_RESPONSE_BYTES,depth:12}};
      else if(operation==='remediation') {
        const args=platformInputs.remediation.parse(q),records=(await this.work.list(ctx.tenant,workspace,args.noticeId))
          .filter(r=>decision.scope.repositories.includes(r.repositoryId)&&decision.scope.environments.includes(r.environment??'unknown'))
          .sort((a,b)=>a.id<b.id?-1:1);
        result={apiVersion:'portable-1',...page(records,args.limit,args.offset),truncated:false};
      } else {
        const selected=z.object(snapshot).passthrough().parse(q);
        const found=await this.snapshots.get(ctx.tenant,workspace,selected.snapshotId);if(!found)throw new ApiError('not_found');
        const checked=systemSnapshotSchema.safeParse(found);if(!checked.success||checked.data.id!==selected.snapshotId)throw new ApiError('graph_unavailable');
        const g=scopeGraph(checked.data.graph,decision.scope),composition=scopeComposition(checked.data.composition,decision.scope);
        const base={apiVersion:'portable-1',snapshotId:g.id,asOf:selected.asOf,collectedAt:g.collectedAt,coverage:g.coverage,observations:g.observations};
        if(operation==='impact') {
          const args=platformInputs.impact.parse(q);result=impact(g,{target:args.target,asOf:args.asOf,limit:args.limit,offset:args.offset,maxDepth:args.maxDepth,maxNodes:args.maxNodes,maxEdges:args.maxEdges,direction:args.direction,maxAgeDays:this.maxAgeDays});
        }else if(operation==='trace') {
          const args=platformInputs.trace.parse(q);result=trace(g,{source:args.source,destination:args.destination,asOf:args.asOf,maxDepth:args.maxDepth,maxNodes:args.maxNodes,maxEdges:args.maxEdges,direction:args.direction,maxAgeDays:this.maxAgeDays});
        }else if(operation==='inventory'||operation==='query') {
          const args=operation==='query'?platformInputs.query.parse(q):platformInputs.inventory.parse(q);
          const term=operation==='query'?platformInputs.query.parse(q).query.toLowerCase():null;
          const nodes=g.nodes.filter(n=>!term||n.label.toLowerCase().includes(term)||n.id.toLowerCase().includes(term)).sort((a,b)=>a.id<b.id?-1:1);
          const p=page(nodes,args.limit,args.offset),ids=new Set(p.items.map(n=>n.id));
          const edgePage=page(g.edges.filter(e=>ids.has(e.source)&&ids.has(e.target)),100,args.edgeOffset);
          result={...base,...p,nodes:p.items,edges:edgePage.items,edgePaging:{total:edgePage.total,offset:edgePage.offset,hasMore:edgePage.hasMore,nextOffset:edgePage.nextOffset},truncated:false,semantics:term?'normalized-lexical.v1':'normalized-inventory.v1'};
        }else if(operation==='explain') {
          const args=platformInputs.explain.parse(q),target=args.kind==='node'?g.nodes.find(n=>n.id===args.target):g.edges.find(e=>e.id===args.target);
          if(!target)throw new ApiError('not_found');result={...base,kind:args.kind,target,evidence:target.evidence,truncated:false};
        }else {
          const args=operation==='eol'?platformInputs.eol.parse(q):platformInputs.vulnerability.parse(q);
          const notice=await this.notices.get(ctx.tenant,workspace,args.noticeId,signal);if(!notice)throw new ApiError('not_found');
          const checkedNotice=noticeSchema.safeParse(notice);if(!checkedNotice.success||checkedNotice.data.id!==args.noticeId)throw new ApiError('graph_unavailable');
          if(notice.revision!==args.noticeRevision||notice.kind!==(operation==='eol'?'eol':'vulnerability'))throw new ApiError('invalid_request');
          result=operation==='eol'?evaluateEol(notice,compositionToEol(composition),{asOf:args.asOf,limit:args.limit,offset:args.offset,maxAgeDays:this.maxAgeDays}):
            evaluateVulnerability(notice,composition,{asOf:args.asOf,limit:args.limit,offset:args.offset,maxAgeDays:this.maxAgeDays},g);
        }
      }
      if(signal?.aborted)throw new ApiError('cancelled');
      const response=z.record(z.string(),z.unknown()).parse(publicProjection(result));
      if(Buffer.byteLength(JSON.stringify(response))>MAX_RESPONSE_BYTES)throw new ApiError('response_too_large');
      resultCount=Array.isArray(response.items)?response.items.length:0;outcome='ok';return response;
    }catch(error){const e=safeError(error);outcome=e.code;if(e.code==='unauthenticated'||e.code==='permission_denied')allowed=false;throw e;}
    finally{try{this.hooks.audit.record({requestId,principal:ctx.principal,tenant:ctx.tenant,workspace,operation,environments,allowed,durationMs:performance.now()-started,resultCount,outcome});
      this.hooks.metrics.observe(operation,performance.now()-started,outcome);}catch{throw new ApiError('internal_error');}}
  }
}
