import { execFileSync } from 'node:child_process';
import { mkdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generator } from './engine.mjs';
import { DatabaseSync } from 'node:sqlite';
const out=resolve('artifacts');mkdirSync(out,{recursive:true});
for(const tenant of ['alpha','beta'])if(!existsSync(resolve(out,tenant+'.db')))execFileSync(generator,[out,tenant,'0','2'],{stdio:'inherit'});
if(!existsSync(resolve(out,'sample.db')))execFileSync(generator,[out,'sample','18','18'],{stdio:'inherit'});
for(const label of ['alpha','beta','sample']){const db=new DatabaseSync(resolve(out,label+'-readonly.db'));db.exec('PRAGMA journal_mode=DELETE');db.close();}
const w=JSON.parse(readFileSync(resolve(out,'sample-registry.json'),'utf8'));
const cfg={version:1,expectedGraphSchema:JSON.parse(readFileSync(resolve(out,'engine-release.json'),'utf8')).graph_schema,graphsRoot:out,workspaces:[w],permissions:[{principal:'sample-reader',tenant:w.tenant,workspace:'main',environments:['production'],repositories:Object.keys(w.repositories),operations:['health','capabilities','query','impact','trace','explain','inventory']}],auth:{mode:'dev-bearer',identities:[]}};
// No usable credential is generated or persisted. The demo creates a RAM token.
writeFileSync(resolve(out,'sample-template.json'),JSON.stringify(cfg,null,2));
console.log('PASS: synthetic fixtures generated; no usable credential written');

const {auth: _remoteAuth, ...graphConfig}=cfg;
writeFileSync(resolve(out,'sample-stdio.json'),JSON.stringify({...graphConfig,localPrincipal:{principal:'sample-reader',tenant:w.tenant}},null,2));
