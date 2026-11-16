import { z } from 'zod';
import { id,ApiError } from '../contracts.js';
import { assessmentStatus,referenceId,timestamp } from '../assessments/model.js';
import { environmentSchema } from './coverage.js';
import { canonical } from './storage.js';

export const HISTORY_WINDOW=16;
export const workStateSchema=z.enum(['investigating','planned','awaiting_verification','resolved']);
export type WorkState=z.infer<typeof workStateSchema>;
export const triggerSchema=z.enum(['notice_updated','composition_updated','redeployed','manual']);
export type ReevaluationTrigger=z.infer<typeof triggerSchema>;
const historyFields={at:timestamp,state:workStateSchema,status:assessmentStatus,snapshotId:referenceId,noticeRevision:referenceId,
  reason:z.string().max(256),evidenceIds:z.array(referenceId).max(64),trigger:z.union([triggerSchema,z.literal('workflow_updated')]),
  policy:z.object({maxAgeDays:z.number().int().min(0).max(3650)}).strict().optional()};
export const historyEntrySchema=z.object({...historyFields,lastAt:timestamp,evaluationCount:z.number().int().positive()}).strict()
  .refine(e=>Date.parse(e.at)<=Date.parse(e.lastAt),'invalid history interval');
export type HistoryEntry=z.infer<typeof historyEntrySchema>;
export type NewHistoryEntry=z.infer<ReturnType<typeof legacyHistorySchema>>;
function legacyHistorySchema(){return z.object(historyFields).strict();}
const recordFields={id:referenceId,tenant:id,workspace:id,noticeId:referenceId,noticeKind:z.enum(['eol','vulnerability']),
  targetId:referenceId,repositoryId:id,environment:environmentSchema,state:workStateSchema,status:assessmentStatus,
  snapshotId:referenceId,noticeRevision:referenceId,evaluatedAt:timestamp,evaluationKey:referenceId,version:z.number().int().positive()};
export const legacyWorkRecordSchema=z.object({...recordFields,history:z.array(legacyHistorySchema()).min(1).max(256)}).strict();
export const workRecordSchema=z.object({...recordFields,schemaVersion:z.literal(2),assessmentKey:referenceId.nullable(),
  requiresReevaluation:z.boolean().default(false),
  historyCount:z.number().int().positive(),historyOffset:z.number().int().nonnegative(),history:z.array(historyEntrySchema).min(1).max(HISTORY_WINDOW),
}).strict().refine(r=>r.historyOffset===Math.max(0,r.historyCount-HISTORY_WINDOW)&&r.historyOffset+r.history.length===r.historyCount,'invalid history window')
  .refine(r=>{const last=r.history.at(-1)!;return last.state===r.state&&last.status===r.status&&last.snapshotId===r.snapshotId&&last.noticeRevision===r.noticeRevision;},'latest state and history differ')
  .refine(r=>r.history.every((event,index)=>index===0||Date.parse(event.at)>=Date.parse(r.history[index-1]!.lastAt)),'history timestamps are out of order');
export type WorkRecord=z.infer<typeof workRecordSchema>;
export interface HistoryPage {schemaVersion:2;recordId:string;recordVersion:number;total:number;offset:number;limit:number;hasMore:boolean;nextOffset:number|null;items:(HistoryEntry&{sequence:number})[]}
export interface HistoryOptions {offset?:number;limit?:number;expectedVersion?:number}
export function historyOptions(raw:HistoryOptions){return z.object({offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50),expectedVersion:z.number().int().positive().optional()}).strict().parse(raw);}
export function appendHistory(old:WorkRecord|undefined,event:NewHistoryEntry,coalesce=false){
  let recent=old?[...old.history]:[],count=old?.historyCount??0;
  if(coalesce&&recent.length){const last=recent.at(-1)!;recent[recent.length-1]={...last,lastAt:event.at,evaluationCount:last.evaluationCount+1};}
  else{recent.push({...event,lastAt:event.at,evaluationCount:1});count++;}
  recent=recent.slice(-HISTORY_WINDOW);
  return {history:recent,historyCount:count,historyOffset:count-recent.length};
}
export function migrateLegacyRecord(raw:unknown){
  const legacy=legacyWorkRecordSchema.parse(raw),events=legacy.history.map(e=>({...e,lastAt:e.at,evaluationCount:1}));
  const record=workRecordSchema.parse({...legacy,schemaVersion:2,assessmentKey:null,requiresReevaluation:true,historyCount:events.length,
    historyOffset:Math.max(0,events.length-HISTORY_WINDOW),history:events.slice(-HISTORY_WINDOW)});
  return {record,archived:events.slice(0,record.historyOffset)};
}
/** Validate a CAS update without allowing committed history to be rewritten. */
export function historyDelta(old:WorkRecord|undefined,next:WorkRecord):{sequence:number;event:HistoryEntry}[]{
  if(!old){if(next.historyCount!==1)throw new ApiError('invalid_request');return [];}
  if(Date.parse(next.evaluatedAt)<Date.parse(old.evaluatedAt)||Date.parse(next.history.at(-1)!.lastAt)<Date.parse(old.history.at(-1)!.lastAt))throw new ApiError('invalid_request');
  if(next.historyCount!==old.historyCount&&next.historyCount!==old.historyCount+1)throw new ApiError('invalid_request');
  const coalesce=next.historyCount===old.historyCount;
  if(!coalesce&&Date.parse(next.history.at(-1)!.at)<Date.parse(old.history.at(-1)!.lastAt))throw new ApiError('invalid_request');
  for(let index=Math.max(old.historyOffset,next.historyOffset);index<old.historyCount;index++){
    const before=old.history[index-old.historyOffset]!,after=next.history[index-next.historyOffset]!;
    if(index===old.historyCount-1&&coalesce){
      const {lastAt:oldAt,evaluationCount:oldCount,...oldFields}=before,{lastAt:newAt,evaluationCount:newCount,...newFields}=after;
      if(canonical(oldFields)!==canonical(newFields)||Date.parse(newAt)<Date.parse(oldAt)||newCount!==oldCount+1)throw new ApiError('invalid_request');
    }else if(canonical(before)!==canonical(after))throw new ApiError('invalid_request');
  }
  return old.history.flatMap((event,index)=>old.historyOffset+index<next.historyOffset?[{sequence:old.historyOffset+index,event}]:[]);
}
export function historyPage(record:WorkRecord,offset:number,limit:number,items:HistoryPage['items']):HistoryPage {
  const hasMore=offset+items.length<record.historyCount;
  return {schemaVersion:2,recordId:record.id,recordVersion:record.version,total:record.historyCount,offset,limit,items,hasMore,nextOffset:hasMore?offset+items.length:null};
}
