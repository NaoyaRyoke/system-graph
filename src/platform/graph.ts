import { z } from 'zod';
import { id, ApiError } from '../contracts.js';
import { evidenceSchema,referenceId,timestamp } from '../assessments/model.js';
import { environmentSchema,coverageIssueSchema,visibleIssue } from './coverage.js';
export { environmentSchema } from './coverage.js';

export const codeSchema=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const graphEvidenceSchema=evidenceSchema.extend({observedAt:timestamp,repositoryId:id,environment:environmentSchema}).strict();
export const serviceBindingSchema=z.object({environment:environmentSchema,deploymentId:referenceId.nullable(),ownerTeam:id.nullable().optional(),evidence:z.array(graphEvidenceSchema).max(16)}).strict();
export const graphNodeSchema=z.object({
  id:referenceId,kind:z.enum(['repository','service','api','event','database','package','source-file','build-artifact','deployment','resource']),
  label:z.string().min(1).max(256),repositoryId:id.nullable(),environment:environmentSchema,shared:z.boolean(),
  attributes:z.record(z.string().max(128),z.union([z.string().max(1024),z.number().finite(),z.boolean(),z.null()])).refine(v=>Object.keys(v).length<=32),
  evidence:z.array(graphEvidenceSchema).max(16),
  logicalService:z.boolean().optional(),serviceBindings:z.array(serviceBindingSchema).max(10000).optional(),
}).strict().refine(n=>n.shared?n.repositoryId===null&&['package','api','event','database','resource'].includes(n.kind):n.repositoryId!==null,'explicit ownership required')
  .refine(n=>!n.logicalService||n.kind==='service'&&!n.shared&&n.repositoryId!==null&&n.environment===null,'logical service ownership required')
  .refine(n=>!n.serviceBindings||n.kind==='service','service bindings require a service');
export const graphEdgeSchema=z.object({id:referenceId,source:referenceId,target:referenceId,kind:codeSchema,
  propagatesImpact:z.boolean(),dependencyKind:z.enum(['declared','resolved','runtime','unknown']),declaredRange:z.string().max(256).nullable(),
  evidence:z.array(graphEvidenceSchema).max(16),
}).strict();
export const graphGapSchema=coverageIssueSchema;
export const observationSchema=z.object({repositoryId:id,environment:environmentSchema,revision:z.string().min(1).max(180),collectedAt:timestamp,
  revisionVerified:z.boolean().default(false),collectionMethod:z.enum(['working_tree','git_commit','provided']).default('provided'),
  contentHashes:z.record(z.string().max(256),z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  extractor:z.string().max(128),status:z.enum(['complete','partial','failed']),files:z.array(z.string().max(256)).max(10000)}).strict();
export const graphSnapshotSchema=z.object({schemaVersion:z.literal(1),id:referenceId,collectedAt:timestamp,
  nodes:z.array(graphNodeSchema).max(12000),edges:z.array(graphEdgeSchema).max(60000),coverage:z.array(graphGapSchema).max(1000),
  observations:z.array(observationSchema).max(128),context:z.object({
    compatibility:z.record(referenceId,z.enum(['breaking','compatible','unknown'])),
    criticality:z.record(referenceId,z.enum(['low','high','critical'])),
  }).strict(),
}).strict().superRefine((g,ctx)=>{
  const nodes=new Set(g.nodes.map(n=>n.id));
  if(nodes.size!==g.nodes.length||new Set(g.edges.map(e=>e.id)).size!==g.edges.length)ctx.addIssue({code:'custom',message:'duplicate graph identifiers'});
  if(g.edges.some(e=>!nodes.has(e.source)||!nodes.has(e.target)))ctx.addIssue({code:'custom',message:'dangling edge'});
});
export type GraphSnapshot=z.infer<typeof graphSnapshotSchema>;
export type GraphNode=z.infer<typeof graphNodeSchema>;
export type GraphEdge=z.infer<typeof graphEdgeSchema>;
export type GraphEvidence=z.infer<typeof graphEvidenceSchema>;
export interface GraphScope {repositories:readonly string[];environments:readonly string[]}
export type RelationQuality='confirmed'|'inferred'|'ambiguous'|'stale';
export interface DependencyPath {nodes:GraphNode[];edges:GraphEdge[]}

/** Legacy snapshots may encode a logical service using the first deployment's env. */
function logicalServices(g:GraphSnapshot):GraphNode[] {
  const nodeMap=new Map(g.nodes.map(n=>[n.id,n])),runs=new Map<string,GraphEdge[]>();
  for(const e of g.edges)if(e.kind==='runs')runs.set(e.source,[...runs.get(e.source)??[],e]);
  return g.nodes.map(n=>{
    if(n.kind!=='service'||n.shared||!n.repositoryId||!n.logicalService&&!runs.has(n.id))return n;
    const bindings=[...n.serviceBindings??(!n.logicalService?[{environment:n.environment,deploymentId:null,evidence:n.evidence}]:[])];
    for(const e of runs.get(n.id)??[]) {
      const d=nodeMap.get(e.target);if(!d||d.kind!=='deployment'||d.repositoryId!==n.repositoryId)continue;
      const evidence=e.evidence.filter(v=>v.repositoryId===n.repositoryId&&v.environment===d.environment);
      if(evidence.length&&!bindings.some(b=>b.deploymentId===d.id))bindings.push({environment:d.environment,deploymentId:d.id,evidence});
    }
    const {ownerTeam:_legacyOwner,...attributes}=n.attributes;
    return {...n,attributes,logicalService:true,environment:null,serviceBindings:bindings.sort((a,b)=>(a.environment??'unknown').localeCompare(b.environment??'unknown')||(a.deploymentId??'').localeCompare(b.deploymentId??''))};
  });
}

/** Shared identities are reachable only along evidenced links from permitted owned nodes. */
export function scopeGraph(raw:unknown,scope:GraphScope):GraphSnapshot {
  const g=graphSnapshotSchema.parse(raw);
  const visible=(v:{repositoryId:string;environment:string|null})=>scope.repositories.includes(v.repositoryId)&&scope.environments.includes(v.environment??'unknown');
  const independent=(n:GraphNode)=>n.shared||n.kind==='build-artifact'&&n.environment===null;
  const nodes=logicalServices(g).map(n=>{
    if(n.logicalService){
      const bindings=(n.serviceBindings??[]).filter(b=>scope.environments.includes(b.environment??'unknown')).map(b=>({...b,evidence:b.evidence.filter(e=>visible(e)&&e.repositoryId===n.repositoryId&&e.environment===b.environment)})).filter(b=>b.evidence.length);
      const evidence=bindings.flatMap(b=>b.evidence).filter((e,i,a)=>a.findIndex(v=>v.id===e.id&&v.environment===e.environment)===i).slice(0,16);
      return {...n,serviceBindings:bindings,evidence};
    }
    return {...n,evidence:n.evidence.filter(e=>visible(e)||independent(n)&&e.environment===null&&scope.repositories.includes(e.repositoryId))};
  });
  const candidates=new Map(nodes.filter(n=>n.shared?(n.environment===null||scope.environments.includes(n.environment)):
    scope.repositories.includes(n.repositoryId!)&&(n.logicalService?!!n.serviceBindings?.length:independent(n)||scope.environments.includes(n.environment??'unknown'))).map(n=>[n.id,n]));
  const edges=g.edges.map(e=>({...e,evidence:e.evidence.filter(v=>visible(v)||v.environment===null&&scope.repositories.includes(v.repositoryId)&&
    !!candidates.get(e.source)&&!!candidates.get(e.target)&&independent(candidates.get(e.source)!)&&independent(candidates.get(e.target)!))})).filter(e=>e.evidence.length&&candidates.has(e.source)&&candidates.has(e.target));
  const selected=new Set([...candidates.values()].filter(n=>!independent(n)).map(n=>n.id));
  // Repository-owned build artifacts need an allowed owned runtime anchor. A
  // common package must never pull in another environment's build artifact.
  for(const e of edges)for(const [from,to]of [[e.source,e.target],[e.target,e.source]]) {
    const source=candidates.get(from!),target=candidates.get(to!);
    if(source&&target&&selected.has(from!)&&!independent(source)&&target.kind==='build-artifact')selected.add(to!);
  }
  const adjacent=new Map<string,string[]>();
  for(const e of edges){adjacent.set(e.source,[...adjacent.get(e.source)??[],e.target]);adjacent.set(e.target,[...adjacent.get(e.target)??[],e.source]);}
  const queue=[...selected];
  for(let i=0;i<queue.length;i++)for(const neighbor of adjacent.get(queue[i]!)??[])if(candidates.get(neighbor)?.shared&&!selected.has(neighbor)){selected.add(neighbor);queue.push(neighbor);}
  const filteredNodes=[...candidates.values()].filter(n=>selected.has(n.id));
  const keepContext=(r:Record<string,string>)=>Object.fromEntries(Object.entries(r).filter(([key])=>selected.has(key)));
  return {...g,nodes:filteredNodes,edges:edges.filter(e=>selected.has(e.source)&&selected.has(e.target)),
    coverage:g.coverage.filter(issue=>visibleIssue(issue,scope,filteredNodes.filter(n=>n.repositoryId!==null).map(n=>({repositoryId:n.repositoryId!,environment:n.environment,
      ...(n.kind==='build-artifact'?{artifactId:n.id,artifactDigest:typeof n.attributes.digest==='string'?n.attributes.digest:null}:{}),...(n.kind==='deployment'?{deploymentId:n.id}:{}),})))),observations:g.observations.filter(visible),
    context:{compatibility:keepContext(g.context.compatibility) as GraphSnapshot['context']['compatibility'],criticality:keepContext(g.context.criticality) as GraphSnapshot['context']['criticality']}};
}

export const traversalOptionsSchema=z.object({asOf:timestamp,maxAgeDays:z.number().int().min(0).max(3650).default(30),
  maxDepth:z.number().int().min(1).max(12).default(8),maxNodes:z.number().int().min(1).max(12000).default(1000),
  maxEdges:z.number().int().min(1).max(60000).default(10000),
  limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(12000).default(0)}).strict();
export const impactOptionsSchema=traversalOptionsSchema.extend({target:referenceId,direction:z.enum(['upstream','downstream','both']).default('upstream')});
export const traceOptionsSchema=traversalOptionsSchema.extend({source:referenceId,destination:referenceId,direction:z.enum(['upstream','downstream','both']).default('downstream')});
type TraverseOptions=z.infer<typeof traversalOptionsSchema>;
export function quality(evidence:readonly GraphEvidence[],asOf:string,maxAgeDays:number):RelationQuality {
  if(!evidence.length)return 'ambiguous';
  if(evidence.some(e=>Date.parse(asOf)-Date.parse(e.observedAt)>maxAgeDays*86400000||Date.parse(e.observedAt)>Date.parse(asOf)))return 'stale';
  if(evidence.some(e=>e.confidence==='ambiguous'))return 'ambiguous';
  return evidence.some(e=>e.confidence==='inferred')?'inferred':'confirmed';
}
function pathQuality(path:DependencyPath,o:TraverseOptions):RelationQuality {
  const q=quality([...path.nodes.flatMap(n=>n.evidence),...path.edges.flatMap(e=>e.evidence)],o.asOf,o.maxAgeDays);
  return q==='confirmed'&&[...path.nodes,...path.edges].some(v=>!v.evidence.length)?'ambiguous':q;
}
function traverse(g:GraphSnapshot,start:string,direction:'upstream'|'downstream'|'both',o:TraverseOptions) {
  const nodes=new Map(g.nodes.map(n=>[n.id,n]));if(!nodes.has(start))throw new ApiError('not_found');
  const adjacent=new Map<string,{edge:GraphEdge;neighbor:string}[]>();
  for(const edge of g.edges.filter(e=>e.propagatesImpact)) {
    const add=(a:string,b:string)=>adjacent.set(a,[...adjacent.get(a)??[],{edge,neighbor:b}]);
    if(direction!=='downstream')add(edge.target,edge.source);
    if(direction!=='upstream')add(edge.source,edge.target);
  }
  for(const list of adjacent.values())list.sort((a,b)=>a.edge.id<b.edge.id?-1:1);
  const paths=new Map<string,DependencyPath>([[start,{nodes:[nodes.get(start)!],edges:[]}]]),queue=[start],bounds=new Set<string>();let scanned=0;
  for(let head=0;head<queue.length;head++) {
    const current=queue[head]!,path=paths.get(current)!;
    for(const {edge,neighbor}of adjacent.get(current)??[]) {
      if(++scanned>o.maxEdges){bounds.add('edge_limit');return {paths,bounds};}
      if(paths.has(neighbor))continue;
      if(path.edges.length>=o.maxDepth){bounds.add('depth_limit');continue;}
      if(paths.size>=o.maxNodes){bounds.add('node_limit');return {paths,bounds};}
      paths.set(neighbor,{nodes:[...path.nodes,nodes.get(neighbor)!],edges:[...path.edges,edge]});queue.push(neighbor);
    }
  }
  return {paths,bounds};
}
function collectionGaps(g:GraphSnapshot,o:TraverseOptions):string[] {
  const gaps=g.coverage.map(c=>`${c.reason}:${c.source}`),age=Date.parse(o.asOf)-Date.parse(g.collectedAt);
  if(age<0||age>o.maxAgeDays*86400000)gaps.push('snapshot_stale_or_future');
  if(g.observations.some(o=>o.status!=='complete'))gaps.push('incomplete_collection');
  return [...new Set(gaps)];
}
export function impact(raw:unknown,options:z.input<typeof impactOptionsSchema>) {
  const g=graphSnapshotSchema.parse(raw),o=impactOptionsSchema.parse(options),walk=traverse(g,o.target,o.direction,o);
  const all=[...walk.paths].filter(([key])=>key!==o.target).map(([key,path])=>({node:g.nodes.find(n=>n.id===key)!,
    classification:path.edges.length===1?'direct_candidate' as const:'indirect_candidate' as const,
    depth:path.edges.length,path,quality:pathQuality(path,o)})).sort((a,b)=>a.node.id<b.node.id?-1:1);
  const gaps=collectionGaps(g,o);if(walk.bounds.size)gaps.push(...walk.bounds);
  if(!all.length)gaps.push('no_candidates_is_not_proof_of_safety');
  if(quality(g.nodes.find(n=>n.id===o.target)!.evidence,o.asOf,o.maxAgeDays)!=='confirmed')gaps.push('target_evidence_unconfirmed_or_stale');
  if(all.some(row=>row.quality!=='confirmed'))gaps.push('uncertain_or_stale_relationships');
  const compatibility=g.context.compatibility[o.target]??'unknown';if(compatibility==='unknown')gaps.push('change_compatibility_missing');
  const complete=gaps.length===0;
  const importance=all.filter(a=>a.node.kind==='service').map(a=>g.context.criticality[a.node.id]);
  const risk: {level:'UNKNOWN'|'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';reasons:string[]}={level:'UNKNOWN',reasons:[...gaps]};
  if(complete&&compatibility==='compatible'){risk.level='LOW';risk.reasons=['explicit_compatible_change'];}
  else if(complete&&compatibility==='breaking') {
    risk.level=importance.includes('critical')?'CRITICAL':importance.includes('high')?'HIGH':'MEDIUM';risk.reasons=['explicit_breaking_change',...importance.filter((v):v is NonNullable<typeof v>=>!!v)];
  }
  const items=all.slice(o.offset,o.offset+o.limit),hasMore=o.offset+items.length<all.length;
  return {schemaVersion:1 as const,analysisContract:2 as const,snapshotId:g.id,asOf:o.asOf,target:g.nodes.find(n=>n.id===o.target)!,items,
    total:all.length,totalIsExact:walk.bounds.size===0,offset:o.offset,limit:o.limit,hasMore,nextOffset:hasMore?o.offset+items.length:null,
    truncated:walk.bounds.size>0,exploration:{truncated:walk.bounds.size>0,reasons:[...walk.bounds]},
    serviceAggregation:all.filter(a=>a.node.kind==='service').map(a=>({serviceId:a.node.id,depth:a.depth,quality:a.quality,
      environments:[...new Set(a.node.logicalService?a.node.serviceBindings?.map(b=>b.environment)??[]:[a.node.environment])],deploymentIds:a.node.serviceBindings?.flatMap(b=>b.deploymentId?[b.deploymentId]:[])??[]})),
    complete,coverageGaps:gaps,coverageIssues:g.coverage,risk,semantics:'possible_change_impact' as const};
}
export function trace(raw:unknown,options:z.input<typeof traceOptionsSchema>) {
  const g=graphSnapshotSchema.parse(raw),o=traceOptionsSchema.parse(options);
  if(!g.nodes.some(n=>n.id===o.destination))throw new ApiError('not_found');
  const walk=traverse(g,o.source,o.direction,o),path=walk.paths.get(o.destination)??null,gaps=collectionGaps(g,o);
  if(!path)gaps.push('no_path_is_not_proof_of_safety');
  const q=path?pathQuality(path,o):null;if(q&&q!=='confirmed')gaps.push('uncertain_or_stale_relationships');
  return {schemaVersion:1 as const,analysisContract:2 as const,snapshotId:g.id,asOf:o.asOf,found:!!path,path,quality:q,conclusion:'unknown' as const,
    truncated:walk.bounds.size>0,coverageGaps:[...gaps,...walk.bounds],coverageIssues:g.coverage,semantics:'dependency_path' as const};
}
