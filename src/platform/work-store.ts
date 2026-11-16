import { z } from 'zod';
import { mkdir,readFile,realpath,rename,rm,rmdir,stat,writeFile,copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute,join } from 'node:path';
import { ApiError } from '../contracts.js';
import { canonical,stableId } from './storage.js';
import { historyEntrySchema,workRecordSchema,legacyWorkRecordSchema,migrateLegacyRecord,historyDelta,historyOptions,historyPage,type WorkRecord,type HistoryEntry,type HistoryPage,type HistoryOptions } from './work-model.js';

export interface WorkStore {
  list(tenant:string,workspace:string,noticeId?:string):Promise<WorkRecord[]>;
  get(tenant:string,workspace:string,recordId:string):Promise<WorkRecord|undefined>;
  save(record:WorkRecord,expectedVersion:number):Promise<void>;
  getHistory(tenant:string,workspace:string,recordId:string,options?:HistoryOptions):Promise<HistoryPage>;
}
export class MemoryWorkStore implements WorkStore {
  private readonly records=new Map<string,WorkRecord>();
  private readonly archived=new Map<string,HistoryEntry>();
  private key(t:string,w:string,r:string){return canonical([t,w,r]);}
  private eventKey(t:string,w:string,r:string,index:number){return canonical([t,w,r,index]);}
  async list(t:string,w:string,n?:string){return structuredClone([...this.records.values()].filter(r=>r.tenant===t&&r.workspace===w&&(!n||r.noticeId===n)));}
  async get(t:string,w:string,key:string){const r=this.records.get(this.key(t,w,key));return r?structuredClone(r):undefined;}
  async save(raw:WorkRecord,expectedVersion:number){
    const r=workRecordSchema.parse(raw),key=this.key(r.tenant,r.workspace,r.id),old=this.records.get(key);
    if((old?.version??0)!==expectedVersion||r.version!==expectedVersion+1)throw new ApiError('busy',true);
    for(const {sequence,event}of historyDelta(old,r))this.archived.set(this.eventKey(r.tenant,r.workspace,r.id,sequence),structuredClone(event));
    this.records.set(key,r);
  }
  async importLegacy(raw:unknown){
    const inputs=z.array(legacyWorkRecordSchema).max(5000).parse(raw),migrated=inputs.map(migrateLegacyRecord);
    const keys=migrated.map(({record:r})=>this.key(r.tenant,r.workspace,r.id));
    if(new Set(keys).size!==keys.length||keys.some(key=>this.records.has(key)))throw new ApiError('invalid_request');
    for(const {record:r,archived}of migrated){for(const [index,event]of archived.entries())this.archived.set(this.eventKey(r.tenant,r.workspace,r.id,index),event);this.records.set(this.key(r.tenant,r.workspace,r.id),r);}
  }
  async getHistory(t:string,w:string,id:string,options:HistoryOptions={}):Promise<HistoryPage>{
    const o=historyOptions(options),r=await this.get(t,w,id);if(!r)throw new ApiError('not_found');
    if(o.expectedVersion!==undefined&&o.expectedVersion!==r.version)throw new ApiError('busy',true);
    const items:HistoryPage['items']=[];
    for(let index=o.offset;index<Math.min(r.historyCount,o.offset+o.limit);index++){
      const event=index<r.historyOffset?this.archived.get(this.eventKey(t,w,id,index)):r.history[index-r.historyOffset];
      if(!event)throw new ApiError('graph_unavailable');items.push({...structuredClone(event),sequence:index});
    }return historyPage(r,o.offset,o.limit,items);
  }
}
const stateSchema=z.object({schemaVersion:z.literal(2),records:z.array(workRecordSchema).max(5000)}).strict();
const archiveSchema=z.object({schemaVersion:z.literal(1),tenant:z.string(),workspace:z.string(),recordId:z.string(),sequence:z.number().int().nonnegative(),event:historyEntrySchema}).strict();
export class FileWorkStore implements WorkStore {
  private constructor(private readonly root:string){}
  static async open(root:string){if(!isAbsolute(root))throw new ApiError('invalid_request');await mkdir(root,{recursive:true});return new FileWorkStore(await realpath(root));}
  private path(t:string,w:string){return join(this.root,stableId('work',t,w)+'.json');}
  private archivePath(t:string,w:string,r:string,index:number){return join(this.root,stableId('history',t,w,r,String(index))+'.json');}
  private async raw(t:string,w:string):Promise<{text:string;data:unknown}|undefined>{
    try{const file=this.path(t,w),s=await stat(file);if(!s.isFile()||s.size>16*1024*1024)throw new ApiError('resource_limit');const text=await readFile(file,'utf8');return {text,data:JSON.parse(text)};}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
  }
  private validate(records:WorkRecord[],t:string,w:string){if(records.some(r=>r.tenant!==t||r.workspace!==w)||new Set(records.map(r=>r.id)).size!==records.length)throw new ApiError('graph_unavailable');return records;}
  private async locked<T>(t:string,w:string,action:(temporary:string)=>Promise<T>):Promise<T>{
    const lock=this.path(t,w)+'.lock',temp=join(lock,'work.json');
    try{await mkdir(lock);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError('busy',true);throw e;}
    try{return await action(temp);}finally{await rm(temp,{force:true});await rmdir(lock);}
  }
  private async writeState(t:string,w:string,records:WorkRecord[],temp:string){
    const serialized=canonical(stateSchema.parse({schemaVersion:2,records}));if(Buffer.byteLength(serialized)>16*1024*1024)throw new ApiError('resource_limit');
    await writeFile(temp,serialized,{flag:'wx',mode:0o600});await rename(temp,this.path(t,w));
  }
  private async writeArchive(t:string,w:string,r:string,index:number,event:HistoryEntry){
    const value={schemaVersion:1,tenant:t,workspace:w,recordId:r,sequence:index,event},file=this.archivePath(t,w,r,index),serialized=canonical(value);
    try{if(await readFile(file,'utf8')!==serialized)throw new ApiError('graph_unavailable');return;}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const temporary=join(this.path(t,w)+'.lock','archive.json');
    try{await writeFile(temporary,serialized,{flag:'wx',mode:0o600});await rename(temporary,file);}finally{await rm(temporary,{force:true});}
  }
  private async loadLocked(t:string,w:string,temp:string):Promise<WorkRecord[]>{
    const input=await this.raw(t,w);if(!input)return [];
    if(!Array.isArray(input.data))return this.validate(stateSchema.parse(input.data).records,t,w);
    const old=z.array(legacyWorkRecordSchema).max(5000).parse(input.data),migrated=old.map(migrateLegacyRecord);
    this.validate(migrated.map(m=>m.record),t,w);
    const backup=this.path(t,w)+'.v1-backup';
    try{await copyFile(this.path(t,w),backup,constants.COPYFILE_EXCL);}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(backup,'utf8')!==input.text)throw new ApiError('graph_unavailable');}
    for(const {record,archived}of migrated)for(const [index,event]of archived.entries())await this.writeArchive(t,w,record.id,index,event);
    const records=migrated.map(m=>m.record);await this.writeState(t,w,records,temp);return records;
  }
  private async load(t:string,w:string){
    const input=await this.raw(t,w);if(!input)return [];
    if(!Array.isArray(input.data))return this.validate(stateSchema.parse(input.data).records,t,w);
    return this.locked(t,w,temp=>this.loadLocked(t,w,temp));
  }
  async list(t:string,w:string,n?:string){return (await this.load(t,w)).filter(r=>!n||r.noticeId===n);}
  async get(t:string,w:string,id:string){return (await this.load(t,w)).find(r=>r.id===id);}
  async save(raw:WorkRecord,expectedVersion:number){
    const r=workRecordSchema.parse(raw);
    await this.locked(r.tenant,r.workspace,async temp=>{
      const records=await this.loadLocked(r.tenant,r.workspace,temp),old=records.find(v=>v.id===r.id);
      if((old?.version??0)!==expectedVersion||r.version!==expectedVersion+1)throw new ApiError('busy',true);
      for(const {sequence,event}of historyDelta(old,r))await this.writeArchive(r.tenant,r.workspace,r.id,sequence,event);
      await this.writeState(r.tenant,r.workspace,[...records.filter(v=>v.id!==r.id),r],temp);
    });
  }
  async getHistory(t:string,w:string,id:string,options:HistoryOptions={}):Promise<HistoryPage>{
    const o=historyOptions(options),r=await this.get(t,w,id);if(!r)throw new ApiError('not_found');
    if(o.expectedVersion!==undefined&&o.expectedVersion!==r.version)throw new ApiError('busy',true);
    const indexes=Array.from({length:Math.max(0,Math.min(o.limit,r.historyCount-o.offset))},(_,index)=>o.offset+index);
    const items=await Promise.all(indexes.map(async index=>{
      let event:HistoryEntry;
      if(index<r.historyOffset){
        const file=this.archivePath(t,w,id,index),s=await stat(file);if(!s.isFile()||s.size>65536)throw new ApiError('graph_unavailable');
        const value=archiveSchema.parse(JSON.parse(await readFile(file,'utf8')));
        if(value.tenant!==t||value.workspace!==w||value.recordId!==id||value.sequence!==index)throw new ApiError('graph_unavailable');event=value.event;
      }else event=r.history[index-r.historyOffset]!;
      return {...event,sequence:index};
    }));return historyPage(r,o.offset,o.limit,items);
  }
}
