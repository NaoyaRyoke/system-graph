import { z } from 'zod';
import { id,ApiError } from '../contracts.js';
import { assessmentStatus,timestamp } from '../assessments/model.js';
import { eolNoticeSchema,type EolNotice } from '../eol/model.js';
import { evaluateEol } from '../eol/evaluate.js';
import { compositionSchema,compositionToEol,type CompositionSnapshot } from './composition.js';
import { vulnerabilityNoticeSchema,evaluateVulnerability,type VulnerabilityNotice } from './vulnerability.js';
import { canonical,stableId } from './storage.js';
import { issueApplies,type CoverageTarget } from './coverage.js';
import { appendHistory,triggerSchema,workRecordSchema,type WorkRecord,type WorkState,type ReevaluationTrigger } from './work-model.js';
import type { WorkStore } from './work-store.js';
export { workStateSchema,workRecordSchema,HISTORY_WINDOW } from './work-model.js';
export type { WorkRecord,WorkState,ReevaluationTrigger,HistoryEntry,HistoryPage,HistoryOptions } from './work-model.js';
export { MemoryWorkStore,FileWorkStore } from './work-store.js';
export type { WorkStore } from './work-store.js';

export const noticeSchema=z.union([eolNoticeSchema,vulnerabilityNoticeSchema]);
export type Notice=EolNotice|VulnerabilityNotice;
export async function transitionWork(store:WorkStore,request:{tenant:string;workspace:string;id:string;expectedVersion:number;
  state:Exclude<WorkState,'resolved'>;at:string;reason:string}):Promise<WorkRecord> {
  const state=z.enum(['investigating','planned','awaiting_verification']).parse(request.state);timestamp.parse(request.at);
  const r=await store.get(request.tenant,request.workspace,request.id);if(!r)throw new ApiError('not_found');
  if(r.version!==request.expectedVersion)throw new ApiError('busy',true);
  if(r.state==='resolved'||Date.parse(request.at)<Math.max(Date.parse(r.evaluatedAt),Date.parse(r.history.at(-1)!.lastAt)))throw new ApiError('invalid_request');
  const next=workRecordSchema.parse({...r,state,version:r.version+1,...appendHistory(r,{at:request.at,state,status:r.status,
    snapshotId:r.snapshotId,noticeRevision:r.noticeRevision,reason:request.reason,evidenceIds:[],trigger:'workflow_updated'})});
  await store.save(next,r.version);return next;
}
interface Observation {targetId:string;repositoryId:string;environment:string|null;status:z.infer<typeof assessmentStatus>;verified:boolean;reason:string;evidenceIds:string[]}
function observations(notice:Notice,s:CompositionSnapshot,asOf:string,maxAgeDays:number):Observation[] {
  z.number().int().min(0).max(3650).parse(maxAgeDays);
  const all:Observation[]=[],age=Date.parse(asOf)-Date.parse(s.collectedAt),fresh=age>=0&&age<=maxAgeDays*86400000;
  const noGap=(target:CoverageTarget)=>!s.coverage.some(g=>issueApplies(g,target));
  if(notice.kind==='vulnerability') {
    let offset=0;
    for(;;){const r=evaluateVulnerability(notice,s,{asOf,offset,limit:50,maxAgeDays});
      all.push(...r.items.map(i=>({targetId:i.deploymentId,repositoryId:i.repositoryId,environment:i.environment,status:i.status,
        verified:fresh&&i.status==='not_affected'&&i.artifact?.complete===true&&noGap(i),
        reason:i.reason,evidenceIds:[...i.evidence.map(e=>e.id),...i.artifact?.evidence.map(e=>e.id)??[]].slice(0,64)})));
      if(r.nextOffset===null)break;offset=r.nextOffset;
    }
  }else{
    const snapshot=compositionToEol(s);let offset=0;
    for(;;){const r=evaluateEol(notice,snapshot,{asOf,offset,limit:50,maxAgeDays});
      all.push(...r.items.map(i=>({targetId:i.assetId,repositoryId:i.repositoryId,environment:i.environment,status:i.status,
        verified:fresh&&i.status==='not_affected'&&i.missing.length===0&&noGap(snapshot.assets.find(a=>a.id===i.assetId)!),reason:i.reason,evidenceIds:i.evidence.map(e=>e.id).slice(0,64)})));
      if(r.nextOffset===null)break;offset=r.nextOffset;
    }
  }return all;
}
/** Triggered by notices, configuration updates or redeployment. Absence never closes work. */
export async function reevaluateNotice(rawNotice:unknown,rawComposition:unknown,store:WorkStore,
  options:{tenant:string;workspace:string;asOf:string;trigger:ReevaluationTrigger;maxAgeDays?:number}):Promise<WorkRecord[]> {
  const notice=noticeSchema.parse(rawNotice),s=compositionSchema.parse(rawComposition);id.parse(options.tenant);id.parse(options.workspace);timestamp.parse(options.asOf);triggerSchema.parse(options.trigger);
  const existing=await store.list(options.tenant,options.workspace,notice.id),current=observations(notice,s,options.asOf,options.maxAgeDays??30);
  for(const old of existing)if(!current.some(o=>o.targetId===old.targetId))current.push({targetId:old.targetId,repositoryId:old.repositoryId,environment:old.environment,
    status:'unknown',verified:false,reason:'target_missing_from_runtime_not_verified_removed',evidenceIds:[]});
  const results:WorkRecord[]=[];
  for(const o of current) {
    const key=stableId('work',options.tenant,options.workspace,notice.kind,notice.id,o.targetId),old=await store.get(options.tenant,options.workspace,key);
    if(!old&&o.status==='not_affected')continue;
    const evaluationKey=stableId('evaluation',notice.revision,s.id,options.asOf,o.targetId,o.status,String(o.verified),String(options.maxAgeDays??30));
    if(old?.evaluationKey===evaluationKey&&!old.requiresReevaluation){results.push(old);continue;}
    if(old&&Date.parse(options.asOf)<Math.max(Date.parse(old.evaluatedAt),Date.parse(old.history.at(-1)!.lastAt)))throw new ApiError('invalid_request');
    let state:WorkState=old?.state??'investigating';
    if(o.verified&&o.status==='not_affected')state='resolved';
    else if(old?.state==='resolved')state='investigating';
    else if(old?.state==='awaiting_verification'&&o.status==='affected')state='planned';
    const assessmentKey=stableId('assessment',notice.revision,s.id,o.targetId,o.status,String(o.verified),o.reason,state,options.trigger,String(options.maxAgeDays??30),canonical(o.evidenceIds));
    const coalesce=old?.assessmentKey===assessmentKey&&old.history.at(-1)?.trigger!=='workflow_updated';
    const r=workRecordSchema.parse({schemaVersion:2,id:key,tenant:options.tenant,workspace:options.workspace,noticeId:notice.id,noticeKind:notice.kind,
      targetId:o.targetId,repositoryId:o.repositoryId,environment:o.environment,state,status:o.status,snapshotId:s.id,
      noticeRevision:notice.revision,evaluatedAt:options.asOf,evaluationKey,assessmentKey,version:(old?.version??0)+1,
      ...appendHistory(old,{at:options.asOf,state,status:o.status,snapshotId:s.id,noticeRevision:notice.revision,
        reason:o.reason,evidenceIds:o.evidenceIds,trigger:options.trigger,policy:{maxAgeDays:options.maxAgeDays??30}},coalesce)});
    await store.save(r,old?.version??0);results.push(r);
  }
  return results.sort((a,b)=>a.id<b.id?-1:1);
}
