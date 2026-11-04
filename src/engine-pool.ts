import { ApiError,type WorkspaceRegistration,type MetricsHook } from './contracts.js';
import { RustClient } from './rust-client.js';
export class EnginePool{
 readonly clients=new Map<string,RustClient>();private readonly restarts=new Map<string,{since:number;count:number}>();private stopping=false;private readonly retiring=new Set<Promise<void>>();
 constructor(private readonly executable:string,private readonly maxWorkers=8,private readonly schema?:string,private readonly metrics?:MetricsHook){}
 get(w:WorkspaceRegistration):RustClient{
  if(this.stopping)throw new ApiError('busy');const key=JSON.stringify([w.tenant,w.workspace]);let client=this.clients.get(key);
  if(client&&!client.available){const closing=client.close();this.retiring.add(closing);void closing.finally(()=>this.retiring.delete(closing));const now=Date.now();let history=this.restarts.get(key);if(!history||now-history.since>30000)history={since:now,count:0};if(++history.count>2)throw new ApiError('busy',true);this.restarts.set(key,history);this.metrics?.observe('worker_restart',1,'ok');this.clients.delete(key);client=undefined;}
  this.metrics?.observe('queue_depth',0,'reject_when_busy');
  if(!client){if(this.clients.size>=this.maxWorkers)throw new ApiError('busy',true);client=new RustClient({executable:this.executable,args:[w.database,w.engineWorkspace],...(this.schema?{expectedGraphSchema:this.schema}:{}),requiredOperations:['health','capabilities','query','impact','trace','explain','inventory']});this.clients.set(key,client);this.metrics?.observe('worker_count',this.clients.size,'ok');}
  return client;
 }
 async warm(workspaces:readonly WorkspaceRegistration[]){for(const w of workspaces)await this.get(w).negotiate();}
 async close(){this.stopping=true;await Promise.all([...this.clients.values()].map(c=>c.close()));await Promise.all(this.retiring);}
}
