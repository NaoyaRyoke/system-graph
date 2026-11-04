import { execFileSync } from 'node:child_process';
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';import { performance } from 'node:perf_hooks';import { createHash,randomBytes } from 'node:crypto';
import { generator,executable } from './engine.mjs';import { buildPublicRuntime } from '../dist/src/public-runtime.js';
const out=resolve('artifacts/scale');mkdirSync(out,{recursive:true});
if(!existsSync(resolve(out,'scale.db')))execFileSync(generator,[out,'scale','10000','50000'],{stdio:'inherit'});
const w=JSON.parse(readFileSync(resolve(out,'scale-registry.json'),'utf8'));
const principal={principal:'reader',subject:'synthetic',issuer:'https://issuer.invalid',tenant:w.tenant,roles:['reader'],scopes:['graph:read'],expiresAt:Date.now()+3600000};
const cfg={version:1,graphsRoot:out,expectedGraphSchema:JSON.parse(readFileSync(resolve(out,'engine-release.json'),'utf8')).graph_schema,workspaces:[w],permissions:[{principal:'reader',tenant:w.tenant,workspace:'main',environments:['production'],repositories:Object.keys(w.repositories),operations:['query','impact','trace','explain','inventory','health','capabilities']}],auth:{mode:'dev-bearer',identities:[{sha256:createHash('sha256').update(randomBytes(32)).digest('hex'),principal}]}};
const file=resolve(out,'runtime.json');writeFileSync(file,JSON.stringify(cfg));const runtime=buildPublicRuntime(file,executable);
const target=JSON.parse(readFileSync(resolve(out,'scale-ids.json'),'utf8'));
const operations=[['query',{query:'sample-api',limit:10}],['impact',{target:target.api,limit:10,maxDepth:4}],['trace',{source:target.reader,destination:target.api,maxDepth:4}],['explain',{target:target.reader}],['inventory',{limit:10}]];
const samples=[];const resources=[];
function snapshot(){const ids=[process.pid,...[...runtime.pool.clients.values()].map(c=>c.pid).filter(Boolean)];
 if(process.platform==='linux')return ids.map(pid=>{try{const s=readFileSync(`/proc/${pid}/status`,'utf8');return {pid,rssKiB:Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]??0),fds:execFileSync('sh',['-c',`ls /proc/${Number(pid)}/fd | wc -l`]).toString().trim()};}catch{return {pid,unavailable:true};}});
 if(process.platform==='win32')return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${ids.map(Number).join(',')} -ErrorAction Stop | Select-Object Id,WorkingSet64,Handles,CPU | ConvertTo-Json -Compress`],{encoding:'utf8'}));return {parentRSS:process.memoryUsage().rss};}
try{await runtime.warm();resources.push({phase:'start',data:snapshot()});
 const seconds=process.argv[2]==='soak'?Math.max(30,Math.min(3600,Number(process.argv[3]??1800))):0;
 const until=performance.now()+seconds*1000;let round=0;
 do{for(const concurrency of seconds?[1]:[1,5,10])for(const [operation,args]of operations){const responses=await Promise.all(Array.from({length:concurrency},async()=>{const start=performance.now();try{const result=await runtime.service.execute(principal,operation,{workspace:'main',...args});return {outcome:'ok',ms:performance.now()-start,bytes:Buffer.byteLength(JSON.stringify(result))};}catch(e){return {outcome:e.code??'error',ms:performance.now()-start};}}));samples.push({operation,concurrency,responses});}round++;if(seconds){resources.push({phase:'round-'+round,data:snapshot()});await new Promise(r=>setTimeout(r,1000));}}while(seconds?performance.now()<until:round<3);
 resources.push({phase:'end',data:snapshot()});
 const summary={nodes:10000,edges:50000,seconds,rounds:round,samples,resources,queueDepth:0,backpressure:'one in-flight per workspace, no queue',metrics:runtime.metrics};
 writeFileSync(resolve('artifacts',seconds?'soak.json':'scale.json'),JSON.stringify(summary,null,2));console.log('PASS: bounded scale/soak completed; outcomes recorded, not all concurrency calls are expected to succeed');
}finally{await runtime.close();}
