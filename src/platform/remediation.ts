import { z } from 'zod';
import { mkdir,readFile,realpath,rename,rm,rmdir,stat,writeFile } from 'node:fs/promises';
import { isAbsolute,join } from 'node:path';
import { id,ApiError } from '../contracts.js';
import { assessmentStatus,referenceId,timestamp } from '../assessments/model.js';
import { eolNoticeSchema,type EolNotice } from '../eol/model.js';
import { evaluateEol } from '../eol/evaluate.js';
import { compositionSchema,compositionToEol,type CompositionSnapshot } from './composition.js';
import { vulnerabilityNoticeSchema,evaluateVulnerability,type VulnerabilityNotice } from './vulnerability.js';
import { environmentSchema } from './graph.js';
import { canonical,stableId } from './storage.js';

export const noticeSchema=z.union([eolNoticeSchema,vulnerabilityNoticeSchema]);
export type Notice=EolNotice|VulnerabilityNotice;
export const workStateSchema=z.enum(['investigating','planned','awaiting_verification','resolved']);
export type WorkState=z.infer<typeof workStateSchema>;
const triggerSchema=z.enum(['notice_updated','composition_updated','redeployed','manual']);
export type ReevaluationTrigger=z.infer<typeof triggerSchema>;
const historySchema=z.object({at:timestamp,state:workStateSchema,status:assessmentStatus,snapshotId:referenceId,noticeRevision:referenceId,
  reason:z.string().max(256),evidenceIds:z.array(referenceId).max(64),trigger:z.union([triggerSchema,z.literal('workflow_updated')])}).strict();
export const workRecordSchema=z.object({id:referenceId,tenant:id,workspace:id,noticeId:referenceId,noticeKind:z.enum(['eol','vulnerability']),
  targetId:referenceId,repositoryId:id,environment:environmentSchema,state:workStateSchema,status:assessmentStatus,
  snapshotId:referenceId,noticeRevision:referenceId,evaluatedAt:timestamp,evaluationKey:referenceId,version:z.number().int().positive(),
  history:z.array(historySchema).min(1).max(256)}).strict();
export type WorkRecord=z.infer<typeof workRecordSchema>;
export interface WorkStore {
  list(tenant:string,workspace:string,noticeId?:string):Promise<WorkRecord[]>;
  get(tenant:string,workspace:string,recordId:string):Promise<WorkRecord|undefined>;
  save(record:WorkRecord,expectedVersion:number):Promise<void>;
}
export class MemoryWorkStore implements WorkStore {
  private readonly records=new Map<string,WorkRecord>();
  async list(t:string,w:string,n?:string){return structuredClone([...this.records.values()].filter(r=>r.tenant===t&&r.workspace===w&&(!n||r.noticeId===n)));}
  async get(t:string,w:string,key:string){const r=this.records.get(canonical([t,w,key]));return r?structuredClone(r):undefined;}
  async save(raw:WorkRecord,expectedVersion:number){
    const r=workRecordSchema.parse(raw),key=canonical([r.tenant,r.workspace,r.id]),old=this.records.get(key);
    if((old?.version??0)!==expectedVersion||r.version!==expectedVersion+1)throw new ApiError('busy',true);
    this.records.set(key,r);
  }
}
export class FileWorkStore implements WorkStore {
  private constructor(private readonly root:string){}
  static async open(root:string){if(!isAbsolute(root))throw new ApiError('invalid_request');await mkdir(root,{recursive:true});return new FileWorkStore(await realpath(root));}
  private path(t:string,w:string){return join(this.root,stableId('work',t,w)+'.json');}
  async list(t:string,w:string,n?:string):Promise<WorkRecord[]> {
    try {
      const file=this.path(t,w),s=await stat(file);if(s.size>16*1024*1024)throw new ApiError('resource_limit');
      const records=z.array(workRecordSchema).max(5000).parse(JSON.parse(await readFile(file,'utf8')));
      if(records.some(r=>r.tenant!==t||r.workspace!==w)||new Set(records.map(r=>r.id)).size!==records.length)throw new ApiError('graph_unavailable');
      return records.filter(r=>!n||r.noticeId===n);
    } catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  }
  async get(t:string,w:string,key:string){return (await this.list(t,w)).find(r=>r.id===key);}
  async save(raw:WorkRecord,expectedVersion:number){
    const r=workRecordSchema.parse(raw),file=this.path(r.tenant,r.workspace),lock=file+'.lock',temp=join(lock,'work.json');
    try{await mkdir(lock);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError('busy',true);throw e;}
    try {
      const records=await this.list(r.tenant,r.workspace),old=records.find(v=>v.id===r.id);
      if((old?.version??0)!==expectedVersion||r.version!==expectedVersion+1)throw new ApiError('busy',true);
      const next=[...records.filter(v=>v.id!==r.id),r],serialized=canonical(next);
      if(next.length>5000||Buffer.byteLength(serialized)>16*1024*1024)throw new ApiError('resource_limit');
      await writeFile(temp,serialized,{flag:'wx',mode:0o600});await rename(temp,file);
    }finally{await rm(temp,{force:true});await rmdir(lock);}
  }
}
export async function transitionWork(store:WorkStore,request:{tenant:string;workspace:string;id:string;expectedVersion:number;
  state:Exclude<WorkState,'resolved'>;at:string;reason:string}):Promise<WorkRecord> {
  const state=z.enum(['investigating','planned','awaiting_verification']).parse(request.state);timestamp.parse(request.at);
  const r=await store.get(request.tenant,request.workspace,request.id);if(!r)throw new ApiError('not_found');
  if(r.version!==request.expectedVersion)throw new ApiError('busy',true);
  if(r.state==='resolved'||Date.parse(request.at)<Date.parse(r.history.at(-1)!.at))throw new ApiError('invalid_request');
  const next=workRecordSchema.parse({...r,state,version:r.version+1,history:[...r.history,{at:request.at,state,status:r.status,
    snapshotId:r.snapshotId,noticeRevision:r.noticeRevision,reason:request.reason,evidenceIds:[],trigger:'workflow_updated'}]});
  await store.save(next,r.version);return next;
}
interface Observation {targetId:string;repositoryId:string;environment:string|null;status:z.infer<typeof assessmentStatus>;verified:boolean;reason:string;evidenceIds:string[]}
function observations(notice:Notice,s:CompositionSnapshot,asOf:string,maxAgeDays:number):Observation[] {
  z.number().int().min(0).max(3650).parse(maxAgeDays);
  const all:Observation[]=[],age=Date.parse(asOf)-Date.parse(s.collectedAt),fresh=age>=0&&age<=maxAgeDays*86400000;
  const noGap=(repo:string,env:string|null)=>!s.coverage.some(g=>g.repositoryId===repo&&g.environment===env);
  if(notice.kind==='vulnerability') {
    let offset=0;
    for(;;){const r=evaluateVulnerability(notice,s,{asOf,offset,limit:50,maxAgeDays});
      all.push(...r.items.map(i=>({targetId:i.deploymentId,repositoryId:i.repositoryId,environment:i.environment,status:i.status,
        verified:fresh&&i.status==='not_affected'&&i.artifact?.complete===true&&noGap(i.repositoryId,i.environment),
        reason:i.reason,evidenceIds:[...i.evidence.map(e=>e.id),...i.artifact?.evidence.map(e=>e.id)??[]].slice(0,64)})));
      if(r.nextOffset===null)break;offset=r.nextOffset;
    }
  }else{
    const snapshot=compositionToEol(s);let offset=0;
    for(;;){const r=evaluateEol(notice,snapshot,{asOf,offset,limit:50,maxAgeDays});
      all.push(...r.items.map(i=>({targetId:i.assetId,repositoryId:i.repositoryId,environment:i.environment,status:i.status,
        verified:fresh&&i.status==='not_affected'&&i.missing.length===0&&noGap(i.repositoryId,i.environment),reason:i.reason,evidenceIds:i.evidence.map(e=>e.id).slice(0,64)})));
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
    const evaluationKey=stableId('evaluation',notice.revision,s.id,options.asOf,o.targetId,o.status,String(o.verified));
    if(old?.evaluationKey===evaluationKey){results.push(old);continue;}
    if(old&&Date.parse(options.asOf)<Math.max(Date.parse(old.evaluatedAt),Date.parse(old.history.at(-1)!.at)))throw new ApiError('invalid_request');
    let state:WorkState=old?.state??'investigating';
    if(o.verified&&o.status==='not_affected')state='resolved';
    else if(old?.state==='resolved')state='investigating';
    else if(old?.state==='awaiting_verification'&&o.status==='affected')state='planned';
    const r=workRecordSchema.parse({id:key,tenant:options.tenant,workspace:options.workspace,noticeId:notice.id,noticeKind:notice.kind,
      targetId:o.targetId,repositoryId:o.repositoryId,environment:o.environment,state,status:o.status,snapshotId:s.id,
      noticeRevision:notice.revision,evaluatedAt:options.asOf,evaluationKey,version:(old?.version??0)+1,
      history:[...old?.history??[],{at:options.asOf,state,status:o.status,snapshotId:s.id,noticeRevision:notice.revision,
        reason:o.reason,evidenceIds:o.evidenceIds,trigger:options.trigger}]});
    await store.save(r,old?.version??0);results.push(r);
  }
  return results.sort((a,b)=>a.id<b.id?-1:1);
}
