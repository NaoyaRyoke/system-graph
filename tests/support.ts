import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash,randomBytes } from 'node:crypto';
import { operations,type AuthContext,type WorkspaceRegistration } from '../src/contracts.js';
import { buildRuntime } from '../src/runtime.js';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const executable=process.env.ENGINE_BINARY??join(root,'target/debug/hybrid-engine-host'+(process.platform==='win32'?'.exe':''));
export const schema=(JSON.parse(readFileSync(join(root,'artifacts/engine-release.json'),'utf8')) as {graph_schema:string}).graph_schema;
export function config(container=false){const identities=[];const tokens:Record<string,string>={};const workspaces:WorkspaceRegistration[]=[];
 for(const[label,tenant]of [['alpha','tenant-a'],['beta','tenant-b']] as const){const token=randomBytes(32).toString('base64url');tokens[tenant]=token;const principal:AuthContext={principal:tenant==='tenant-a'?'reader-a':'reader-b',subject:tenant,issuer:'https://fixture.invalid',tenant,roles:['reader'],scopes:['graph:read'],expiresAt:Date.now()+600000};identities.push({sha256:createHash('sha256').update(token).digest('hex'),principal});const w=JSON.parse(readFileSync(join(root,`artifacts/${label}-registry.json`),'utf8')) as WorkspaceRegistration;workspaces.push(container?{...w,database:`/graphs/${label}.db`,repoRoots:[`/snapshots/${label}`]}:w);}
 return {data:{fixtureOnly:true,expectedGraphSchema:schema,graphsRoot:container?'/graphs':join(root,'artifacts'),workspaces,identities},tokens};}
export function fixture(){const c=config();mkdirSync(join(root,'artifacts'),{recursive:true});const file=join(root,'artifacts/runtime-fixture.json');writeFileSync(file,JSON.stringify(c.data));return {...buildRuntime(file,executable),...c,owner:c.data.identities[0]!.principal,other:c.data.identities[1]!.principal};}
export const ids=(name:'alpha'|'beta')=>JSON.parse(readFileSync(join(root,`artifacts/${name}-ids.json`),'utf8')) as {reader:string;api:string};
export const allOps=operations;
