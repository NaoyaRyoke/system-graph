import ts from 'typescript';
import { z } from 'zod';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { posix, relative, resolve, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { id, ApiError } from '../contracts.js';
import { timestamp,referenceId } from '../assessments/model.js';
import { stableId } from './storage.js';
import { environmentSchema,graphSnapshotSchema,type GraphSnapshot,type GraphNode,type GraphEdge,type GraphEvidence } from './graph.js';

export const repositorySchema=z.object({repositoryId:id,serviceId:referenceId,environment:environmentSchema,
  revision:z.string().min(1).max(180),baseUrl:z.url().nullable()}).strict();
export type RepositoryRegistration=z.infer<typeof repositorySchema>;
export interface SourceFile {path:string;content:string}
export interface SourceCollection {files:SourceFile[];revision:string;revisionVerified:boolean;collectionMethod:'working_tree'|'git_commit'|'provided'}
export interface RepositorySource {read(repository:RepositoryRegistration,signal?:AbortSignal):Promise<SourceFile[]|SourceCollection>}
const sourcePath=z.string().min(1).max(256).refine(p=>!p.includes('\\')&&!p.startsWith('/')&&!p.split('/').some(s=>s==='..'||s==='.'||s===''));
export class LocalRepositorySource implements RepositorySource {
  constructor(private readonly roots:Readonly<Record<string,string>>){}
  async read(repo:RepositoryRegistration,signal?:AbortSignal):Promise<SourceCollection> {
    const configured=this.roots[repo.repositoryId];if(!configured||!isAbsolute(configured))throw new ApiError('invalid_request');
    const root=await realpath(configured),files:SourceFile[]=[];let total=0;
    const visit=async(dir:string)=>{
      for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
        if(signal?.aborted)throw new ApiError('cancelled');
        if(['.git','node_modules','dist','target','.local'].includes(entry.name))continue;
        if(entry.isSymbolicLink())throw new ApiError('unsupported_capability');
        const file=resolve(dir,entry.name),actual=await realpath(file),rel=relative(root,actual);
        if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../'))throw new ApiError('permission_denied');
        if(entry.isDirectory()){await visit(file);continue;}
        if(!entry.isFile())continue;
        const s=await stat(file);total+=s.size;
        if(s.size>1024*1024||total>16*1024*1024||files.length>=2000)throw new ApiError('resource_limit');
        files.push({path:rel.replaceAll('\\','/'),content:await readFile(file,'utf8')});
      }
    };
    await visit(root);return {files,revision:repo.revision,revisionVerified:false,collectionMethod:'working_tree'};
  }
}
/** Reads committed Git blobs directly, protecting dirty working trees and verifying the exact revision. */
export class GitRepositorySource implements RepositorySource {
  constructor(private readonly roots:Readonly<Record<string,string>>){}
  async read(repo:RepositoryRegistration,signal?:AbortSignal):Promise<SourceCollection> {
    const configured=this.roots[repo.repositoryId];if(!configured||!isAbsolute(configured)||!/^[a-f0-9]{40}$/.test(repo.revision))throw new ApiError('invalid_request');
    const root=await realpath(configured),run=promisify(execFile);
    const git=async(args:string[])=>{const r=await run('git',['-C',root,...args],{windowsHide:true,maxBuffer:16*1024*1024,...(signal?{signal}:{})});return r.stdout;};
    const actual=(await git(['rev-parse','--verify',repo.revision+'^{commit}'])).trim();
    if(actual!==repo.revision)throw new ApiError('invalid_request');
    const entries=(await git(['ls-tree','-r','-z','--full-tree',repo.revision])).split('\0').filter(Boolean);
    if(entries.length>2000)throw new ApiError('resource_limit');
    const files:SourceFile[]=[];let size=0;
    for(const entry of entries) {
      const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);if(!match||!sourcePath.safeParse(match[3]).success)throw new ApiError('unsupported_capability');
      const content=await git(['cat-file','blob',match[2]!]);size+=Buffer.byteLength(content);
      if(Buffer.byteLength(content)>1024*1024||size>16*1024*1024)throw new ApiError('resource_limit');
      files.push({path:match[3]!,content});
    }
    return {files,revision:actual,revisionVerified:true,collectionMethod:'git_commit'};
  }
}
export class MemoryRepositorySource implements RepositorySource {
  constructor(readonly files:Record<string,SourceFile[]|Error>){}
  async read(r:RepositoryRegistration){const files=this.files[r.repositoryId];if(files instanceof Error)throw files;if(!files)throw new ApiError('not_found');return structuredClone(files);}
}
const blank=(snapshotId:string,asOf:string):GraphSnapshot=>({schemaVersion:1,id:snapshotId,collectedAt:asOf,nodes:[],edges:[],coverage:[],observations:[],context:{compatibility:{},criticality:{}}});
const packageManifest=z.object({name:z.string().optional(),version:z.string().optional(),
  dependencies:z.record(z.string(),z.string()).optional(),devDependencies:z.record(z.string(),z.string()).optional(),
  optionalDependencies:z.record(z.string(),z.string()).optional(),peerDependencies:z.record(z.string(),z.string()).optional()}).passthrough();
const lockSchema=z.object({lockfileVersion:z.union([z.literal(2),z.literal(3)]),packages:z.record(z.string(),z.object({
  name:z.string().optional(),version:z.string().optional(),dependencies:z.record(z.string(),z.string()).optional(),
  optionalDependencies:z.record(z.string(),z.string()).optional(),peerDependencies:z.record(z.string(),z.string()).optional(),devDependencies:z.record(z.string(),z.string()).optional(),dev:z.boolean().optional(),optional:z.boolean().optional(),link:z.boolean().optional(),
}).passthrough())}).passthrough();
const catalogSchema=z.object({schemaVersion:z.literal(1),requires:z.array(z.object({kind:z.enum(['event','database']),name:z.string().min(1).max(128)}).strict()).default([]),
  provides:z.array(z.object({kind:z.literal('event'),name:z.string().min(1).max(128)}).strict()).default([]),dependsOnServices:z.array(referenceId).default([])}).strict();

export async function collectRepositories(rawRegistrations:readonly RepositoryRegistration[],source:RepositorySource,
  options:{snapshotId:string;asOf:string;previous?:GraphSnapshot;signal?:AbortSignal}):Promise<GraphSnapshot> {
  referenceId.parse(options.snapshotId);timestamp.parse(options.asOf);
  const registrations=rawRegistrations.map(r=>repositorySchema.parse(r));
  if(new Set(registrations.map(r=>r.repositoryId)).size!==registrations.length||new Set(registrations.map(r=>r.serviceId)).size!==registrations.length)throw new ApiError('invalid_request');
  const out=blank(options.snapshotId,options.asOf),nodes=new Map<string,GraphNode>(),edges=new Map<string,GraphEdge>();
  const mergeEvidence=(values:GraphEvidence[])=>{
    const unique=values.filter((v,i,a)=>a.findIndex(x=>x.id===v.id)===i);
    for(const e of unique.slice(16))if(!out.coverage.some(g=>g.reason==='evidence_limit'&&g.repositoryId===e.repositoryId&&g.environment===e.environment))out.coverage.push({repositoryId:e.repositoryId,environment:e.environment,reason:'evidence_limit',source:'graph-evidence'});
    return unique.slice(0,16);
  };
  const addNode=(n:GraphNode)=>{const old=nodes.get(n.id);nodes.set(n.id,old?{...old,evidence:mergeEvidence([...old.evidence,...n.evidence])}:n);return n.id;};
  const addEdge=(e:GraphEdge)=>{const old=edges.get(e.id);edges.set(e.id,old?{...old,evidence:mergeEvidence([...old.evidence,...e.evidence])}:e);};
  const previous=options.previous?graphSnapshotSchema.parse(options.previous):undefined;
  for(const repo of registrations) {
    const gap=(reason:string,file:string)=>out.coverage.push({repositoryId:repo.repositoryId,environment:repo.environment,reason,source:file});
    const evidence=(file:string,confidence:GraphEvidence['confidence']='confirmed',pointer=''):GraphEvidence=>({id:stableId('evidence',repo.repositoryId,repo.revision,file,pointer),source:file,
      extractor:'typescript-collector-v1',confidence,observedAt:options.asOf,repositoryId:repo.repositoryId,environment:repo.environment});
    const owned=(nodeId:string,kind:GraphNode['kind'],label:string,file:string,attributes:GraphNode['attributes']={})=>addNode({id:nodeId,kind,label,repositoryId:repo.repositoryId,environment:repo.environment,shared:false,attributes,evidence:[evidence(file)]});
    const shared=(kind:'package'|'api'|'event'|'database',key:string,file:string,attrs:GraphNode['attributes']={})=>addNode({id:stableId(kind,key),kind,label:key.slice(0,256),repositoryId:null,environment:null,shared:true,attributes:attrs,evidence:[evidence(file)]});
    const link=(from:string,to:string,kind:string,file:string,dependencyKind:GraphEdge['dependencyKind']='declared',range:string|null=null,confidence:GraphEvidence['confidence']='confirmed',propagates=true)=>addEdge({id:stableId('edge',from,to,kind),source:from,target:to,kind,propagatesImpact:propagates,dependencyKind,declaredRange:range,evidence:[evidence(file,confidence,from+':'+to+':'+kind)]});
    let files:SourceFile[],revisionVerified=false,collectionMethod:SourceCollection['collectionMethod']='provided';
    try {
      if(options.signal?.aborted)throw new ApiError('cancelled');
      const collection=await source.read(repo,options.signal);
      if(Array.isArray(collection))files=collection;
      else{files=collection.files;revisionVerified=collection.revisionVerified;collectionMethod=collection.collectionMethod;if(collection.revision!==repo.revision)throw new ApiError('invalid_request');}
      if(files.length>2000||files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>16*1024*1024||new Set(files.map(f=>f.path)).size!==files.length||files.some(f=>!sourcePath.safeParse(f.path).success||Buffer.byteLength(f.content)>1024*1024))throw new ApiError('resource_limit');
    } catch(error) {
      if(options.signal?.aborted)throw new ApiError('cancelled');
      gap('collection_failed','repository');
      if(previous) {
        for(const n of previous.nodes.filter(n=>n.repositoryId===repo.repositoryId||n.shared&&n.evidence.some(e=>e.repositoryId===repo.repositoryId)))addNode({...n,evidence:n.evidence.filter(e=>e.repositoryId===repo.repositoryId)});
        for(const e of previous.edges.filter(e=>e.evidence.some(v=>v.repositoryId===repo.repositoryId)))addEdge({...e,evidence:e.evidence.filter(v=>v.repositoryId===repo.repositoryId)});
      }
      out.observations.push({repositoryId:repo.repositoryId,environment:repo.environment,revision:repo.revision,revisionVerified:false,collectionMethod,contentHashes:{},collectedAt:options.asOf,extractor:'typescript-collector-v1',status:'failed',files:[]});continue;
    }
    owned(repo.serviceId,'service',repo.serviceId,'repository');
    const fileMap=new Map(files.map(f=>[f.path,f.content]));
    const packageNodes=new Map<string,string>();
    const manifest=fileMap.get('package.json');
    if(manifest)try {
      const pkg=packageManifest.parse(JSON.parse(manifest));
      for(const [section,values]of Object.entries({dependencies:pkg.dependencies,devDependencies:pkg.devDependencies,optionalDependencies:pkg.optionalDependencies,peerDependencies:pkg.peerDependencies}))
        for(const [name,range]of Object.entries(values??{})) {
          const target=shared('package',`npm:${name}:declared:${range}`,'package.json',{ecosystem:'npm',name,version:null,versionStatus:'declared',dependencyScope:section,declaredRange:range});
          packageNodes.set(name,target);link(repo.serviceId,target,'depends_on','package.json','declared',range);
        }
    } catch {gap('invalid_manifest','package.json');}
    const lock=fileMap.get('package-lock.json');
    if(lock)try {
      const parsed=lockSchema.parse(JSON.parse(lock)),installed=new Map<string,string>();
      for(const [path,pkg]of Object.entries(parsed.packages)) {
        if(path==='')continue;
        const name=pkg.name??path.split('node_modules/').at(-1)!;
        if(!pkg.version||pkg.link||!path.includes('node_modules/')){gap('unsupported_lock_entry','package-lock.json');continue;}
        const target=shared('package',`npm:${name}:resolved:${pkg.version}`,'package-lock.json',{ecosystem:'npm',name,version:pkg.version,versionStatus:'resolved',dependencyScope:pkg.dev?'development':pkg.optional?'optional':'runtime'});
        installed.set(path,target);
      }
      const resolveInstalled=(from:string,name:string)=>{
        let at=from;
        for(;;){const target=installed.get((at?at+'/':'')+'node_modules/'+name);if(target)return target;if(!at)return undefined;at=at.includes('/node_modules/')?at.slice(0,at.lastIndexOf('/node_modules/')):'';}
      };
      for(const [path,pkg]of Object.entries(parsed.packages)) {
        const from=path===''?repo.serviceId:installed.get(path);if(!from)continue;
        for(const [name,range]of Object.entries({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies,...(path===''?pkg.devDependencies:{})})) {
          const target=resolveInstalled(path,name);
          if(!target){gap('unresolved_lock_dependency','package-lock.json');continue;}
          link(from,target,'depends_on','package-lock.json','resolved',range);
        }
      }
    } catch {gap('unsupported_or_invalid_lockfile','package-lock.json');}
    for(const file of files) {
      const sourceId=owned(stableId('file',repo.repositoryId,file.path),'source-file',file.path,file.path,{revision:repo.revision});
      link(repo.serviceId,sourceId,'depends_on',file.path,'declared');
      try {
        if(/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file.path)) {
          const parsed=ts.createSourceFile(file.path,file.content,ts.ScriptTarget.Latest,true);
          if(ts.transpileModule(file.content,{fileName:file.path,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ESNext,jsx:ts.JsxEmit.Preserve}}).diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error)){gap('syntax_error',file.path);continue;}
          const visit=(n:ts.Node)=>{
            if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)) {
              const spec=n.moduleSpecifier.text;
              if(spec.startsWith('.')) {
                const base=posix.normalize(posix.join(posix.dirname(file.path),spec));
                const candidates=[base,...['.ts','.tsx','.js','.mjs','.cjs','/index.ts','/index.js'].map(ext=>base+ext),base.replace(/\.js$/,'.ts')];
                const target=candidates.find(p=>fileMap.has(p)&&sourcePath.safeParse(p).success);
                if(target)link(sourceId,stableId('file',repo.repositoryId,target),'imports',file.path);else gap('unresolved_import',file.path);
              } else if(!spec.startsWith('node:')) {
                const packageName=spec.startsWith('@')?spec.split('/').slice(0,2).join('/'):spec.split('/')[0]!;
                const target=packageNodes.get(packageName);if(target)link(sourceId,target,'imports',file.path);else gap('unresolved_package_import',file.path);
              }
            }
            if(ts.isCallExpression(n)) {
              if(n.expression.getText(parsed)==='fetch') {
                const arg=n.arguments[0];
                if(arg&&ts.isStringLiteral(arg))try {
                  const url=new URL(arg.text,repo.baseUrl??undefined);
                  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();
                  let method:string|undefined='GET';const options=n.arguments[1];
                  if(options) {
                    if(!ts.isObjectLiteralExpression(options))method=undefined;
                    else for(const property of options.properties) {
                      if(ts.isSpreadAssignment(property)||property.name&&ts.isComputedPropertyName(property.name))method=undefined;
                      else if(property.name?.getText(parsed).replaceAll(/["']/g,'')==='method')method=ts.isPropertyAssignment(property)&&ts.isStringLiteral(property.initializer)?property.initializer.text.toUpperCase():undefined;
                    }
                  }
                  if(!method||!['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','TRACE'].includes(method))gap('unresolved_fetch_method',file.path);
                  else {const api=shared('api',`${method} ${url.origin}${url.pathname}`,file.path,{method,endpoint:url.origin+url.pathname});link(sourceId,api,'calls',file.path,'declared',null,'inferred');}
                } catch {gap('unresolved_api_call',file.path);}
                else gap('dynamic_api_call',file.path);
              }
              if(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(parsed)==='require')gap('dynamic_or_commonjs_import',file.path);
            }
            ts.forEachChild(n,visit);
          };visit(parsed);
        } else if(/^openapi\.json$/.test(file.path)) {
          const api=z.object({openapi:z.string().regex(/^3\.[01]\./),servers:z.array(z.object({url:z.url()}).passthrough()).min(1),paths:z.record(z.string(),z.record(z.string(),z.unknown()))}).passthrough().parse(JSON.parse(file.content));
          if(api.servers.length!==1)gap('multiple_api_servers',file.path);
          for(const [path,methods]of Object.entries(api.paths))for(const method of Object.keys(methods).filter(m=>['get','post','put','patch','delete','head','options','trace'].includes(m))) {
            const url=new URL(path,api.servers[0]!.url),target=shared('api',`${method.toUpperCase()} ${url.origin}${url.pathname}`,file.path,{method:method.toUpperCase(),endpoint:url.origin+url.pathname});
            link(target,repo.serviceId,'served_by',file.path);
          }
          if(file.content.includes('"$ref"')||file.content.includes('"callbacks"'))gap('openapi_references_not_resolved',file.path);
        } else if(file.path==='system-graph.json') {
          const catalog=catalogSchema.parse(JSON.parse(file.content));
          for(const dep of catalog.requires)link(repo.serviceId,shared(dep.kind,dep.name,file.path),'depends_on',file.path);
          for(const provided of catalog.provides)link(shared(provided.kind,provided.name,file.path),repo.serviceId,'provided_by',file.path);
          for(const service of catalog.dependsOnServices) {
            if(registrations.some(r=>r.serviceId===service))link(repo.serviceId,service,'depends_on',file.path);else gap('unregistered_service_dependency',file.path);
          }
        } else if(!['package.json','package-lock.json'].includes(file.path)&&!/(?:\.md|\.txt|\.gitignore|\.json)$/.test(file.path))gap('unsupported_source_format',file.path);
        else if(file.path.endsWith('.json')&&!['package.json','package-lock.json'].includes(file.path))gap('unsupported_configuration',file.path);
      } catch {gap('extraction_failed',file.path);}
    }
    out.observations.push({repositoryId:repo.repositoryId,environment:repo.environment,revision:repo.revision,revisionVerified,collectionMethod,
      contentHashes:Object.fromEntries(files.map(f=>[f.path,createHash('sha256').update(f.content).digest('hex')])),collectedAt:options.asOf,extractor:'typescript-collector-v1',status:out.coverage.some(g=>g.repositoryId===repo.repositoryId)?'partial':'complete',files:files.map(f=>f.path)});
  }
  out.nodes=[...nodes.values()];
  for(const edge of edges.values())if(!nodes.has(edge.source)||!nodes.has(edge.target))for(const e of edge.evidence)out.coverage.push({repositoryId:e.repositoryId,environment:e.environment,reason:'unresolved_graph_reference',source:e.source});
  out.edges=[...edges.values()].filter(e=>nodes.has(e.source)&&nodes.has(e.target));
  if(previous)out.context=previous.context;
  return graphSnapshotSchema.parse(out);
}
