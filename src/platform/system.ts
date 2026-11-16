import { z } from 'zod';
import { ApiError,id } from '../contracts.js';
import { timestamp,referenceId } from '../assessments/model.js';
import { collectRepositories,type RepositorySource,type RepositoryRegistration } from './collect.js';
import { graphSnapshotSchema,type GraphSnapshot } from './graph.js';
import { compositionSchema,connectComposition,importCycloneDx,ingestRuntime,type RuntimeSource,type Artifact,type CompositionSnapshot } from './composition.js';
import { noticeSchema,reevaluateNotice,type Notice,type WorkStore,type ReevaluationTrigger } from './remediation.js';
import { canonical,type SnapshotStore } from './storage.js';

export const systemSnapshotSchema=z.object({id:referenceId,schemaVersion:z.literal(1),graph:graphSnapshotSchema,composition:compositionSchema})
  .strict().refine(s=>s.id===s.graph.id&&s.id===s.composition.id&&s.graph.collectedAt===s.composition.collectedAt,'inconsistent snapshot identity');
export type SystemSnapshot=z.infer<typeof systemSnapshotSchema>;
export interface ArtifactInput {sbom:unknown;metadata:Omit<Artifact,'sbom'|'id'> & {id?:string}}
export interface ArtifactSource {read(signal?:AbortSignal):Promise<ArtifactInput[]>}
export interface NotificationSource {read(signal?:AbortSignal):Promise<Notice[]>}
export interface JobRunner {run<T>(key:string,job:()=>Promise<T>):Promise<T>}
export class InlineJobs implements JobRunner {
  private readonly active=new Set<string>();
  async run<T>(key:string,job:()=>Promise<T>):Promise<T>{if(this.active.has(key))throw new ApiError('busy',true);this.active.add(key);try{return await job();}finally{this.active.delete(key);}}
}
/** Application orchestration. External reads, persistence and workflow writes are ports. */
export class SystemCoordinator {
  constructor(private readonly sources:{repositories:RepositorySource;artifacts:ArtifactSource;runtime:RuntimeSource;notifications:NotificationSource},
    private readonly snapshots:SnapshotStore<SystemSnapshot>,private readonly work:WorkStore,private readonly jobs:JobRunner=new InlineJobs()){}
  async refresh(options:{tenant:string;workspace:string;snapshotId:string;asOf:string;repositories:readonly RepositoryRegistration[];
    previousSnapshotId?:string;trigger:ReevaluationTrigger;signal?:AbortSignal;maxAgeDays?:number}) {
    id.parse(options.tenant);id.parse(options.workspace);referenceId.parse(options.snapshotId);timestamp.parse(options.asOf);
    return this.jobs.run(JSON.stringify([options.tenant,options.workspace]),async()=>{
      const previous=options.previousSnapshotId?await this.snapshots.get(options.tenant,options.workspace,options.previousSnapshotId):undefined;
      if(options.previousSnapshotId&&!previous)throw new ApiError('not_found');
      const graph=await collectRepositories(options.repositories,this.sources.repositories,{snapshotId:options.snapshotId,asOf:options.asOf,
        ...(previous?{previous:previous.graph}:{}),...(options.signal?{signal:options.signal}:{})});
      const gaps:CompositionSnapshot['coverage']=[];let artifacts:Artifact[]=[...previous?.composition.artifacts??[]];
      try {
        const inputs=await this.sources.artifacts.read(options.signal);
        for(const input of inputs)try{
          const imported=importCycloneDx(input.sbom,input.metadata),old=artifacts.find(a=>a.id===imported.id);
          if(old&&canonical(old.sbom)!==canonical(imported.sbom))throw new ApiError('invalid_request');
          artifacts=[...artifacts.filter(a=>a.id!==imported.id),imported];
        }catch{
          gaps.push({repositoryId:input.metadata.repositoryId,environment:null,reason:'unsupported_or_invalid_sbom',source:'sbom'});
        }
      }catch{
        artifacts=previous?.composition.artifacts??[];
        for(const repo of options.repositories)gaps.push({repositoryId:repo.repositoryId,environment:repo.environment,reason:'artifact_collection_failed',source:'artifacts'});
      }
      let composition:CompositionSnapshot;
      try{composition=await ingestRuntime(this.sources.runtime,artifacts,{snapshotId:options.snapshotId,asOf:options.asOf,...(options.signal?{signal:options.signal}:{})});}
      catch{
        composition={schemaVersion:1,id:options.snapshotId,collectedAt:options.asOf,artifacts:previous?.composition.artifacts??artifacts,deployments:previous?.composition.deployments??[],coverage:[]};
        for(const repo of options.repositories)gaps.push({repositoryId:repo.repositoryId,environment:repo.environment,reason:'collection_failed',source:'runtime'});
      }
      composition.coverage.push(...gaps);
      if(options.signal?.aborted)throw new ApiError('cancelled');
      const snapshot=systemSnapshotSchema.parse({schemaVersion:1,id:options.snapshotId,graph:connectComposition(graph,composition),composition});
      await this.snapshots.put(options.tenant,options.workspace,snapshot);
      // Notification failure remains an error: it must not silently imply all work is resolved.
      const notices=z.array(noticeSchema).max(100).parse(await this.sources.notifications.read(options.signal));
      if(new Set(notices.map(n=>n.id)).size!==notices.length)throw new ApiError('invalid_request');
      const records=[];
      for(const notice of notices) {
        if(options.signal?.aborted)throw new ApiError('cancelled');
        records.push(...await reevaluateNotice(notice,composition,this.work,{tenant:options.tenant,workspace:options.workspace,asOf:options.asOf,trigger:options.trigger,maxAgeDays:options.maxAgeDays??30}));
      }
      return {snapshot,notices,records};
    });
  }
}
export function emptyGraph(id:string,collectedAt:string):GraphSnapshot{return {schemaVersion:1,id,collectedAt,nodes:[],edges:[],coverage:[],observations:[],context:{compatibility:{},criticality:{}}};}
