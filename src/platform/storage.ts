import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { ApiError } from '../contracts.js';

export const stableId=(kind:string,...parts:string[])=>`${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0,40)}`;
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':canonical(v)).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:1).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new ApiError('invalid_request');return encoded;
}
export interface SnapshotStore<T extends {id:string}> {
  get(tenant:string,workspace:string,id:string):Promise<T|undefined>;
  put(tenant:string,workspace:string,value:T):Promise<void>;
}
export class MemorySnapshotStore<T extends {id:string}> implements SnapshotStore<T> {
  private readonly values=new Map<string,T>();
  constructor(private readonly validate:(raw:unknown)=>T){}
  async get(t:string,w:string,id:string){const v=this.values.get(canonical([t,w,id]));return v?structuredClone(v):undefined;}
  async put(t:string,w:string,raw:T){
    const value=this.validate(raw),key=canonical([t,w,value.id]),old=this.values.get(key);
    if(old&&canonical(old)!==canonical(value))throw new ApiError('invalid_request');
    this.values.set(key,structuredClone(value));
  }
}
/** Immutable snapshots; exclusive per-key lock protects writers across local processes. */
export class FileSnapshotStore<T extends {id:string}> implements SnapshotStore<T> {
  private constructor(private readonly root:string,private readonly validate:(raw:unknown)=>T){}
  static async open<T extends {id:string}>(root:string,validate:(raw:unknown)=>T){
    if(!isAbsolute(root))throw new ApiError('invalid_request');
    await mkdir(root,{recursive:true});return new FileSnapshotStore(await realpath(root),validate);
  }
  private path(t:string,w:string,id:string){return join(this.root,stableId('snapshot',t,w,id)+'.json');}
  async get(t:string,w:string,id:string):Promise<T|undefined>{
    const file=this.path(t,w,id);
    try {
      const s=await stat(file);if(!s.isFile()||s.size>32*1024*1024)throw new ApiError('resource_limit');
      const value=this.validate(JSON.parse(await readFile(file,'utf8')));
      if(value.id!==id)throw new ApiError('graph_unavailable');return value;
    } catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
  }
  async put(t:string,w:string,raw:T):Promise<void>{
    const value=this.validate(raw),file=this.path(t,w,value.id),lock=file+'.lock',temp=join(lock,'snapshot.json');
    const serialized=canonical(value);if(Buffer.byteLength(serialized)>32*1024*1024)throw new ApiError('resource_limit');
    try{await mkdir(lock);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError('busy',true);throw e;}
    try {
      const old=await this.get(t,w,value.id);
      if(old){if(canonical(old)!==serialized)throw new ApiError('invalid_request');return;}
      await writeFile(temp,serialized,{flag:'wx',mode:0o600});await rename(temp,file);
    } finally {await rm(temp,{force:true});await rmdir(lock);}
  }
}
