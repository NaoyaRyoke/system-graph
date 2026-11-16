import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { ApiError, MAX_RESPONSE_BYTES, safeError, type AuthContext } from '../contracts.js';
import { PolicyEngine, type ServiceHooks } from '../service.js';
import { displayText, relativeSource } from '../redaction.js';
import { requestContext } from '../request-context.js';
import type { NoticeSource, SnapshotSource } from '../assessments/model.js';
import { evaluateEol } from './evaluate.js';
import { visibleIssue } from '../platform/coverage.js';
import { eolInputSchema, eolNoticeSchema, eolSnapshotSchema, type EolAssessment, type EolNotice, type EolSnapshot } from './model.js';

export interface EolSources { notices:NoticeSource<EolNotice>; snapshots:SnapshotSource<EolSnapshot> }

function redact(value:unknown,key=''):unknown {
  if(typeof value==='string')return key==='source'?(relativeSource(value)??'[redacted]'):displayText(value);
  if(Array.isArray(value))return value.map(v=>redact(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)]));
  return value;
}

/** Uses the existing inventory read permission; never widens a graph scope. */
export class EolQueryService {
  constructor(readonly policy:PolicyEngine,private readonly sources:EolSources,
    private readonly hooks:ServiceHooks,private readonly maxAgeDays=30) {}

  async execute(ctx:AuthContext,raw:unknown,signal?:AbortSignal):Promise<EolAssessment> {
    const started=performance.now(), requestId=requestContext.getStore()?.requestId??randomUUID();
    let workspace='invalid', environments:readonly string[]=[], allowed=false, outcome='invalid_request', resultCount=0;
    try {
      const parsed=eolInputSchema.safeParse(raw);
      if(!parsed.success)throw new ApiError('invalid_request');
      const q=parsed.data; workspace=q.workspace;
      const decision=this.policy.decide(ctx,workspace,'inventory',q.environments,q.repositories);
      if(!decision.allow)throw new ApiError(decision.reason);
      allowed=true; environments=decision.scope.environments;
      if(signal?.aborted)throw new ApiError('cancelled');
      const admission=this.hooks.rateLimit.admit(JSON.stringify([ctx.tenant,ctx.principal,workspace,'eol']));
      if(!admission.allow)throw new ApiError('rate_limited',true,admission.retryAfter);
      const [rawNotice,rawSnapshot]=await Promise.all([
        this.sources.notices.getNotice(ctx.tenant,workspace,q.noticeId,signal),
        this.sources.snapshots.getSnapshot(ctx.tenant,workspace,q.snapshotId,signal),
      ]);
      if(signal?.aborted)throw new ApiError('cancelled');
      if(!rawNotice||!rawSnapshot)throw new ApiError('not_found');
      const n=eolNoticeSchema.safeParse(rawNotice),s=eolSnapshotSchema.safeParse(rawSnapshot);
      if(!n.success||!s.success||n.data.id!==q.noticeId||s.data.id!==q.snapshotId)throw new ApiError('graph_unavailable');
      if(n.data.revision!==q.noticeRevision)throw new ApiError('invalid_request');
      const inScope=(v:{repositoryId:string;environment:string|null})=>
        decision.scope.repositories.includes(v.repositoryId)&&decision.scope.environments.includes(v.environment??'unknown');
      // Apply policy to assets AND coverage before evaluation and before calculating totals.
      const assets=s.data.assets.filter(inScope);
      const snapshot={...s.data,assets,coverage:s.data.coverage.filter(issue=>visibleIssue({...issue,reason:issue.issueReason??issue.reason,source:'eol'},decision.scope,assets))};
      const result=redact(evaluateEol(n.data,snapshot,{asOf:q.asOf,maxAgeDays:this.maxAgeDays,limit:q.limit,offset:q.offset})) as EolAssessment;
      if(Buffer.byteLength(JSON.stringify(result))>MAX_RESPONSE_BYTES)throw new ApiError('response_too_large');
      resultCount=result.items.length; outcome='ok'; return result;
    } catch(error) {
      const e=safeError(error); outcome=e.code;
      if(e.code==='permission_denied'||e.code==='unauthenticated')allowed=false;
      throw e;
    } finally {
      try {
        this.hooks.audit.record({requestId,principal:ctx.principal,tenant:ctx.tenant,workspace,operation:'eol',environments,
          allowed,durationMs:performance.now()-started,resultCount,outcome});
        this.hooks.metrics.observe('eol',performance.now()-started,outcome);
      } catch {throw new ApiError('internal_error');}
    }
  }
}

/** Operator-provisioned, tenant/workspace-bound immutable snapshots and notices. */
export class MemoryEolSources implements EolSources {
  private readonly noticeMap=new Map<string,EolNotice>();
  private readonly snapshotMap=new Map<string,EolSnapshot>();
  readonly notices:NoticeSource<EolNotice>={getNotice:async(t,w,id)=>{
    const v=this.noticeMap.get(JSON.stringify([t,w,id]));return v?structuredClone(v):undefined;
  }};
  readonly snapshots:SnapshotSource<EolSnapshot>={getSnapshot:async(t,w,id)=>{
    const v=this.snapshotMap.get(JSON.stringify([t,w,id]));return v?structuredClone(v):undefined;
  }};
  constructor(records:readonly {tenant:string;workspace:string;notices:readonly EolNotice[];snapshots:readonly EolSnapshot[]}[]) {
    for(const r of records) {
      for(const raw of r.notices) {
        const n=eolNoticeSchema.parse(raw),key=JSON.stringify([r.tenant,r.workspace,n.id]);
        if(this.noticeMap.has(key))throw new ApiError('invalid_request');
        this.noticeMap.set(key,n);
      }
      for(const raw of r.snapshots) {
        const s=eolSnapshotSchema.parse(raw),key=JSON.stringify([r.tenant,r.workspace,s.id]);
        if(this.snapshotMap.has(key))throw new ApiError('invalid_request');
        this.snapshotMap.set(key,s);
      }
    }
  }
}
