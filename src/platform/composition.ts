import { z } from 'zod';
import { id,ApiError } from '../contracts.js';
import { referenceId,timestamp } from '../assessments/model.js';
import { eolAssetSchema,type EolSnapshot } from '../eol/model.js';
import { environmentSchema,graphEvidenceSchema,graphGapSchema,graphSnapshotSchema,type GraphScope,type GraphSnapshot,type GraphNode,type GraphEdge } from './graph.js';
import { stableId } from './storage.js';

/** Deliberately bounded PURL subset: unqualified package identities; unsupported forms stay unknown. */
export function parsePackageUrl(raw:string):{identity:string;version:string|null}|null {
  const match=/^pkg:([a-z][a-z0-9.+-]*)\/([^?#]+)$/.exec(raw);if(!match)return null;
  const path=match[2]!,at=path.lastIndexOf('@'),coordinate=at>0?path.slice(0,at):path,version=at>0?path.slice(at+1):null;
  if(version==='')return null;
  try {
    const segments=coordinate.split('/').map(decodeURIComponent);
    if(segments.some(s=>!s||s==='.'||s==='..'||s.includes('/')||/[\s\x00-\x1f]/.test(s)))return null;
    if(match[1]==='npm'&&!(segments.length===1||segments.length===2&&segments[0]!.startsWith('@')))return null;
    return {identity:`pkg:${match[1]}/${segments.map(encodeURIComponent).join('/')}`,version:version===null?null:decodeURIComponent(version)};
  } catch{return null;}
}
export const componentSchema=z.object({ref:z.string().min(1).max(256),name:z.string().min(1).max(256),
  packageUrl:z.string().max(1024).nullable(),identity:z.string().max(1024).nullable(),version:z.string().min(1).max(128).nullable(),
  dependencyScope:z.enum(['required','optional','excluded','unknown']),dependencyDepth:z.number().int().nonnegative().nullable()}).strict();
export const sbomSchema=z.object({format:z.literal('CycloneDX'),specVersion:z.literal('1.6'),rootRef:z.string().max(256).nullable(),
  components:z.array(componentSchema).max(10000),dependencies:z.array(z.object({ref:z.string().max(256),dependsOn:z.array(z.string().max(256)).max(10000)}).strict()).max(10001),
  complete:z.boolean(),gaps:z.array(z.string().max(128)).max(128)}).strict();
export const artifactSchema=z.object({id:referenceId,repositoryId:id,revision:z.string().min(1).max(180),
  digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),image:z.string().min(1).max(512),observedAt:timestamp,
  sbom:sbomSchema,evidence:z.array(graphEvidenceSchema).max(16)}).strict();
const productSchema=eolAssetSchema.omit({repositoryId:true,environment:true,artifactId:true,deploymentId:true,serviceId:true,ownerTeam:true});
export const deploymentSchema=z.object({id:referenceId,name:z.string().min(1).max(128),repositoryId:id,environment:environmentSchema,
  cluster:z.string().max(128).nullable(),account:z.string().max(128).nullable(),namespace:z.string().max(128).nullable(),
  serviceId:referenceId,ownerTeam:id.nullable(),artifactId:referenceId.nullable(),artifactDigest:z.string().max(128).nullable(),
  image:z.string().max(512),observedAt:timestamp,state:z.enum(['observed','declared']),products:z.array(productSchema).max(128),
  evidence:z.array(graphEvidenceSchema).max(16)}).strict();
export const compositionSchema=z.object({schemaVersion:z.literal(1),id:referenceId,collectedAt:timestamp,
  artifacts:z.array(artifactSchema).max(1000),deployments:z.array(deploymentSchema).max(10000),coverage:z.array(graphGapSchema).max(1000),
}).strict().superRefine((s,ctx)=>{
  for(const list of [s.artifacts,s.deployments])if(new Set(list.map(v=>v.id)).size!==list.length)ctx.addIssue({code:'custom',message:'duplicate composition identity'});
  const artifacts=new Map(s.artifacts.map(a=>[a.id,a]));
  for(const d of s.deployments)if(d.artifactId!==null) {
    const artifact=artifacts.get(d.artifactId);
    if(!artifact||artifact.repositoryId!==d.repositoryId||artifact.digest!==d.artifactDigest)ctx.addIssue({code:'custom',message:'invalid runtime artifact binding'});
  }
});
export type Component=z.infer<typeof componentSchema>;
export type Artifact=z.infer<typeof artifactSchema>;
export type Deployment=z.infer<typeof deploymentSchema>;
export type CompositionSnapshot=z.infer<typeof compositionSchema>;

/** CycloneDX 1.6 JSON: retains membership, exact versions, dependency graph and scope. */
export function importCycloneDx(raw:unknown,metadata:Omit<Artifact,'sbom'|'id'> & {id?:string}):Artifact {
  const component=z.object({'bom-ref':z.string().min(1).max(256).optional(),type:z.string().min(1),name:z.string().min(1).max(256),
    version:z.string().min(1).max(128).optional(),purl:z.string().max(1024).optional(),scope:z.enum(['required','optional','excluded']).optional(),components:z.array(z.unknown()).optional()}).passthrough();
  const input=z.object({bomFormat:z.literal('CycloneDX'),specVersion:z.literal('1.6'),version:z.number().int().min(1).optional(),
    metadata:z.object({component:component.optional()}).passthrough().optional(),components:z.array(z.unknown()).max(10000).default([]),
    dependencies:z.array(z.object({ref:z.string().max(256),dependsOn:z.array(z.string().max(256)).max(10000).default([])}).passthrough()).max(10001).optional(),
    compositions:z.array(z.object({aggregate:z.string(),assemblies:z.array(z.string()).optional()}).passthrough()).optional(),
    services:z.array(z.unknown()).optional(),
  }).passthrough().parse(raw);
  const gaps=new Set<string>(),components:Component[]=[],known=new Set<string>();
  if(input.services?.length)gaps.add('sbom_services_not_supported');
  const add=(rawComponent:unknown,depth:number)=>{
    if(depth>16||components.length>=10000)throw new ApiError('resource_limit');
    const c=component.parse(rawComponent),ref=c['bom-ref']??stableId('component',String(components.length),c.name,c.version??'');
    if(!c['bom-ref'])gaps.add('missing_component_reference');
    if(known.has(ref))throw new ApiError('invalid_request');known.add(ref);
    const p=c.purl?parsePackageUrl(c.purl):null;
    if(!p)gaps.add('unsupported_or_missing_package_identifier');
    const version=c.version??p?.version??null;
    if(!version)gaps.add('missing_component_version');
    if(p?.version&&c.version&&p.version!==c.version)gaps.add('component_version_conflict');
    components.push({ref,name:c.name,packageUrl:c.purl??null,identity:p?.identity??null,version,
      dependencyScope:c.scope??'unknown',dependencyDepth:null});
    for(const child of c.components??[])add(child,depth+1);
  };
  for(const c of input.components)add(c,0);
  if(input.metadata?.component&&!known.has(input.metadata.component['bom-ref']??''))add(input.metadata.component,0);
  const rootRef=input.metadata?.component?.['bom-ref']??null;if(rootRef)known.add(rootRef);else gaps.add('missing_root_component');
  const dependencies=(input.dependencies??[]).map(d=>({ref:d.ref,dependsOn:d.dependsOn}));
  if(!input.dependencies)gaps.add('dependency_graph_missing');
  if(components.some(c=>!dependencies.some(d=>d.ref===c.ref)))gaps.add('opaque_component_dependencies');
  if(new Set(dependencies.map(d=>d.ref)).size!==dependencies.length)gaps.add('duplicate_dependency_reference');
  for(const d of dependencies)if(!known.has(d.ref)||d.dependsOn.some(ref=>!known.has(ref)))gaps.add('dangling_dependency_reference');
  if(!input.compositions?.length)gaps.add('sbom_completeness_unspecified');
  else if(input.compositions.some(c=>c.aggregate!=='complete')||!input.compositions.some(c=>!c.assemblies?.length||rootRef!==null&&c.assemblies.includes(rootRef)))gaps.add('sbom_declares_incomplete_composition');
  if(rootRef){
    const depths=new Map<string,number>([[rootRef,0]]),queue=[rootRef],adjacent=new Map(dependencies.map(d=>[d.ref,d.dependsOn]));
    for(let i=0;i<queue.length;i++)for(const child of adjacent.get(queue[i]!)??[])if(!depths.has(child)){depths.set(child,depths.get(queue[i]!)!+1);queue.push(child);}
    for(const c of components)c.dependencyDepth=depths.get(c.ref)??null;
    if(components.some(c=>c.dependencyDepth===null))gaps.add('dependency_reachability_unknown');
  }
  return artifactSchema.parse({...metadata,id:metadata.id??stableId('artifact',metadata.repositoryId,metadata.digest),sbom:{format:'CycloneDX',specVersion:'1.6',rootRef,
    components,dependencies,complete:gaps.size===0,gaps:[...gaps]}});
}
export interface RuntimeSource {read(signal?:AbortSignal):Promise<unknown>}
export class MemoryRuntimeSource implements RuntimeSource {constructor(public data:unknown){}async read(){return structuredClone(this.data);}}
export const runtimeInputSchema=z.object({schemaVersion:z.literal(1),deployments:z.array(deploymentSchema.omit({id:true,artifactId:true}).extend({artifactId:referenceId.nullable().optional()})).max(10000),
  coverage:z.array(graphGapSchema).max(1000).default([])}).strict();
export async function ingestRuntime(source:RuntimeSource,artifacts:readonly Artifact[],options:{snapshotId:string;asOf:string;signal?:AbortSignal}):Promise<CompositionSnapshot> {
  if(options.signal?.aborted)throw new ApiError('cancelled');
  const raw=runtimeInputSchema.parse(await source.read(options.signal)),coverage=[...raw.coverage];
  if(options.signal?.aborted)throw new ApiError('cancelled');
  const deployments=raw.deployments.map(d=>{
    const matches=artifacts.filter(a=>a.repositoryId===d.repositoryId&&a.digest===d.artifactDigest);
    const artifact=matches.length===1?matches[0]:undefined;
    if(!artifact)coverage.push({repositoryId:d.repositoryId,environment:d.environment,reason:'runtime_artifact_unresolved',source:'runtime'});
    if(d.state!=='observed')coverage.push({repositoryId:d.repositoryId,environment:d.environment,reason:'runtime_declaration_only',source:'runtime'});
    return {...d,id:stableId('deployment',d.repositoryId,d.environment??'unknown',d.cluster??'unknown',d.account??'unknown',d.namespace??'unknown',d.name),
      artifactId:artifact?.id??null};
  });
  return compositionSchema.parse({schemaVersion:1,id:options.snapshotId,collectedAt:options.asOf,artifacts,deployments,coverage});
}
export function scopeComposition(raw:unknown,scope:GraphScope):CompositionSnapshot {
  const s=compositionSchema.parse(raw),visible=(d:{repositoryId:string;environment:string|null})=>scope.repositories.includes(d.repositoryId)&&scope.environments.includes(d.environment??'unknown');
  const deployments=s.deployments.filter(visible).map(d=>({...d,evidence:d.evidence.filter(visible)}));
  const visibleArtifacts=new Set(deployments.map(d=>d.artifactId));
  return {...s,deployments,artifacts:s.artifacts.filter(a=>scope.repositories.includes(a.repositoryId)&&visibleArtifacts.has(a.id)).map(a=>({...a,evidence:a.evidence.filter(e=>scope.repositories.includes(e.repositoryId)&&(e.environment===null||scope.environments.includes(e.environment)))})),coverage:s.coverage.filter(visible)};
}
export function compositionToEol(raw:unknown):EolSnapshot {
  const s=compositionSchema.parse(raw),coverage:EolSnapshot['coverage']=s.coverage.map(g=>({repositoryId:g.repositoryId,environment:g.environment,
    reason:g.reason==='collection_failed'?'collection_failed':'partial_collection'}));
  const assets:EolSnapshot['assets']=[];
  for(const d of s.deployments) {
    if(!d.products.length)coverage.push({repositoryId:d.repositoryId,environment:d.environment,reason:'partial_collection'});
    for(const product of d.products) {
      const summarize=(values:readonly {confidence:'confirmed'|'inferred'|'ambiguous'}[])=>!values.length||values.some(e=>e.confidence==='ambiguous')?'ambiguous' as const:values.some(e=>e.confidence==='inferred')?'inferred' as const:'confirmed' as const;
      const runtimeConfidence=d.state==='observed'?summarize(d.evidence):'inferred' as const;
      const detail=[...product.evidence,...d.evidence.map(e=>({id:e.id,source:e.source,extractor:e.extractor,confidence:e.confidence}))];
      if(detail.length>14)coverage.push({repositoryId:d.repositoryId,environment:d.environment,reason:'partial_collection'});
      const observedAt=[product.observedAt,d.observedAt,...d.evidence.map(e=>e.observedAt)].sort((a,b)=>Date.parse(a)-Date.parse(b))[0]!;
      assets.push({...product,id:stableId('asset',d.id,product.id),repositoryId:d.repositoryId,environment:d.environment,
        artifactId:d.artifactId,deploymentId:d.id,serviceId:d.serviceId,ownerTeam:d.ownerTeam,observedAt,
        evidence:[{id:stableId('product-proof',d.id,product.id),source:'product-evidence-summary',extractor:'composition-v1',confidence:summarize(product.evidence)},
          {id:stableId('runtime-proof',d.id),source:'runtime-evidence-summary',extractor:'composition-v1',confidence:runtimeConfidence},...detail.slice(0,14)]});
    }
  }
  return {schemaVersion:1,id:s.id,collectedAt:s.collectedAt,assets,coverage};
}

/** Connect exact SBOM package versions and observed deployments to the source graph. */
export function connectComposition(rawGraph:unknown,rawComposition:unknown):GraphSnapshot {
  const g=graphSnapshotSchema.parse(rawGraph),s=compositionSchema.parse(rawComposition);
  if(g.id!==s.id)throw new ApiError('invalid_request');
  const nodes=new Map(g.nodes.map(n=>[n.id,n])),edges=new Map(g.edges.map(e=>[e.id,e]));
  const mergeEvidence=(values:Artifact['evidence'])=>{
    const unique=values.filter((v,i,a)=>a.findIndex(x=>x.id===v.id)===i);
    for(const e of unique.slice(16))if(!g.coverage.some(v=>v.reason==='evidence_limit'&&v.repositoryId===e.repositoryId&&v.environment===e.environment))g.coverage.push({repositoryId:e.repositoryId,environment:e.environment,reason:'evidence_limit',source:'graph-evidence'});
    return unique.slice(0,16);
  };
  const node=(n:GraphNode)=>{const old=nodes.get(n.id);nodes.set(n.id,old?{...old,evidence:mergeEvidence([...old.evidence,...n.evidence])}:n);};
  const edge=(source:string,target:string,kind:string,evidence:Artifact['evidence'])=>{
    const e:GraphEdge={id:stableId('edge',source,target,kind),source,target,kind,propagatesImpact:true,dependencyKind:'runtime',declaredRange:null,evidence};
    const old=edges.get(e.id);if(old)e.evidence=mergeEvidence([...old.evidence,...evidence]);edges.set(e.id,e);
  };
  for(const a of s.artifacts) {
    node({id:a.id,kind:'build-artifact',label:a.image,repositoryId:a.repositoryId,environment:null,shared:false,
      attributes:{digest:a.digest,revision:a.revision},evidence:a.evidence});
    const componentIds=new Map<string,string>();
    for(const c of a.sbom.components) {
      const componentId=stableId('package',c.identity??a.id+':'+c.ref,c.version??'unknown');componentIds.set(c.ref,componentId);
      node({id:componentId,kind:'package',label:c.name,repositoryId:null,environment:null,shared:true,
        attributes:{identity:c.identity,version:c.version,dependencyScope:c.dependencyScope,dependencyDepth:c.dependencyDepth},evidence:a.evidence});
      edge(a.id,componentId,'contains_component',a.evidence);
    }
    for(const dep of a.sbom.dependencies)for(const child of dep.dependsOn) {
      const from=componentIds.get(dep.ref),to=componentIds.get(child);if(from&&to)edge(from,to,'depends_on',a.evidence);
    }
  }
  for(const d of s.deployments) {
    const evidence=d.evidence.map(e=>({...e,confidence:d.state==='declared'?'inferred' as const:e.confidence}));
    node({id:d.id,kind:'deployment',label:d.name,repositoryId:d.repositoryId,environment:d.environment,shared:false,
      attributes:{cluster:d.cluster,account:d.account,namespace:d.namespace,image:d.image,state:d.state},evidence});
    if(!nodes.has(d.serviceId))node({id:d.serviceId,kind:'service',label:d.serviceId,repositoryId:d.repositoryId,environment:d.environment,shared:false,attributes:{ownerTeam:d.ownerTeam},evidence});
    edge(d.serviceId,d.id,'runs',evidence);if(d.artifactId)edge(d.id,d.artifactId,'deploys',evidence);
  }
  return graphSnapshotSchema.parse({...g,nodes:[...nodes.values()],edges:[...edges.values()],coverage:[...g.coverage,...s.coverage]});
}
