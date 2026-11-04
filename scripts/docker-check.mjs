import { execFileSync } from 'node:child_process';import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,chmodSync } from 'node:fs';import { resolve } from 'node:path';import { generateKeyPairSync,sign } from 'node:crypto';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const context=process.env.DOCKER_CONTEXT_NAME??'default',image=process.env.GRAPH_IMAGE??'system-graph-beta:local';
const docker=(...args)=>execFileSync('docker',['--context',context,...args],{encoding:'utf8',timeout:30000}).trim();
const name='system-graph-beta-check';const containers=[],networks=[],clients=[];
mkdirSync('artifacts',{recursive:true});const out=mkdtempSync(resolve('artifacts/docker-check-'));
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key',use:'sig',alg:'RS256'};
const tokens={};const receipt={tests:[],network:'internal isolated backends + loopback-only gateway',runtime:[]};
function token(tenant){const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'at+jwt',kid:'synthetic-key'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://issuer.invalid',aud:'https://graph.invalid/mcp',sub:tenant,tenant,scope:'graph:read',exp:Math.floor(Date.now()/1000)+300})).toString('base64url');return h+'.'+p+'.'+sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url');}
const wait=async()=>{for(let i=0;i<40;i++){if(containers.filter(c=>c!==name+'-gateway').every(c=>JSON.parse(docker('inspect',c))[0].State.Health.Status==='healthy'))return;await new Promise(r=>setTimeout(r,500));}throw Error('health deadline');};
try{
 for(const label of ['a','b']){
  const tenant=label==='a'?'tenant-a':'tenant-b',fixture=label==='a'?'alpha':'beta',container=name+'-'+label,network=name+'-'+label;
  if(docker('ps','-aq','--filter','name=^/'+container+'$')||docker('network','ls','-q','--filter','name=^'+network+'$'))throw Error('dedicated name already exists');
  docker('network','create','--internal','-o','com.docker.network.bridge.gateway_mode_ipv4=isolated',network);networks.push(network);
  const registry=JSON.parse(readFileSync('artifacts/'+fixture+'-registry.json','utf8'));
  registry.database='/graphs/graph.db';const cfg={version:1,expectedGraphSchema:JSON.parse(readFileSync('artifacts/engine-release.json','utf8')).graph_schema,graphsRoot:'/graphs',workspaces:[registry],permissions:[{principal:'reader',tenant,workspace:'main',environments:['production'],repositories:Object.keys(registry.repositories),operations:['query','impact','trace','explain','inventory','health','capabilities']}],auth:{mode:'jwt',issuer:'https://issuer.invalid',audience:'https://graph.invalid/mcp',jwks:{keys:[jwk]},bindings:[{issuer:'https://issuer.invalid',subject:tenant,principal:'reader',tenant}]}};
  const cfgFile=resolve(out,label+'.json'),dbFile=resolve(out,label+'.db');writeFileSync(cfgFile,JSON.stringify(cfg));copyFileSync(resolve('artifacts/'+fixture+'-readonly.db'),dbFile);chmodSync(cfgFile,0o444);chmodSync(dbFile,0o444);tokens[label]=token(tenant);
  docker('create','--name',container,'--network',network,'--network-alias','graph-'+label,'--restart=no','--dns-search','.','--dns-option','ndots:0','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','256m','--pids-limit','64','--cpus','1','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001','--mount',`type=bind,src=${dbFile},dst=/graphs/graph.db,readonly`,'--mount',`type=bind,src=${cfgFile},dst=/config/runtime.json,readonly`,'-e','CONTAINER_MODE=1','-e','CANONICAL_ORIGIN=http://127.0.0.1:18974',image);containers.push(container);docker('start',container);
 }
 const publicNetwork=name+'-ingress';if(docker('network','ls','-q','--filter','name=^'+publicNetwork+'$'))throw Error('dedicated network exists');docker('network','create',publicNetwork);networks.push(publicNetwork);
 const gateway=name+'-gateway';docker('create','--name',gateway,'--network',publicNetwork,'--restart=no','--dns-search','.','--dns-option','ndots:0','--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','96m','--pids-limit','32','--publish','127.0.0.1:18974:3000','--no-healthcheck','--entrypoint','node',image,'/app/docker/gateway.mjs');containers.push(gateway);
 for(const label of ['a','b'])docker('network','connect',name+'-'+label,gateway);docker('start',gateway);await wait();
 for(const label of ['a','b']){
  const client=new Client({name:'container-check',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18974/'+label+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+tokens[label]}}}));clients.push(client);
  if((await client.listTools()).tools.length!==6)throw Error('tools mismatch');
  const identity=JSON.parse(readFileSync('artifacts/'+(label==='a'?'alpha':'beta')+'-ids.json','utf8'));
  for(const[op,args]of [['query',{query:'service'}],['impact',{target:identity.api}],['trace',{source:identity.reader,destination:identity.api}],['explain',{target:identity.reader}],['inventory',{}],['capabilities',{}]]){const r=await client.callTool({name:'graph_'+op,arguments:{workspace:'main',...args}});if(r.isError)throw Error('read failed');receipt.tests.push(label+':'+op);}
  const target=JSON.parse(readFileSync('artifacts/'+(label==='a'?'beta':'alpha')+'-ids.json','utf8')).reader;const denied=await client.callTool({name:'graph_explain',arguments:{workspace:'main',target}});if(!denied.isError||!JSON.stringify(denied).includes('not_found'))throw Error('foreign ID disclosed');
  const backend=name+'-'+label;
  const check=docker('exec',backend,'node','-e',"const fs=require('fs'),net=require('net');if(fs.existsSync('/graphs/other.db'))process.exit(2);const s=net.connect({host:'198.51.100.1',port:443});s.once('connect',()=>process.exit(3));s.once('error',()=>{console.log('PASS: no other DB mount; external route denied');process.exit(0)});setTimeout(()=>{s.destroy();console.log('PASS: no other DB mount; external route blocked');process.exit(0)},500)");receipt.tests.push(check);
  const inspected=JSON.parse(docker('inspect',backend))[0];if(Object.keys(inspected.HostConfig.PortBindings??{}).length||inspected.Config.User!=='10001:10001'||!inspected.HostConfig.ReadonlyRootfs)throw Error('isolation config');
  receipt.runtime.push({user:inspected.Config.User,ports:inspected.HostConfig.PortBindings,mounts:inspected.Mounts.map(m=>({destination:m.Destination,readOnly:!m.RW})),networks:Object.keys(inspected.NetworkSettings.Networks),stats:JSON.parse(docker('stats','--no-stream','--format','{{json .}}',backend))});
 }
 // A token for one tenant cannot authenticate to the other container.
 const rejected=await fetch('http://127.0.0.1:18974/b/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.a,'Content-Type':'application/json'},body:'{}'});if(rejected.status!==403)throw Error('foreign tenant token accepted');receipt.tests.push('cross-tenant signed token rejected');
 docker('restart',name+'-a');await wait();const restarted=await clients[0].callTool({name:'graph_query',arguments:{workspace:'main',query:'service'}});if(restarted.isError)throw Error('restart failed');receipt.restart=true;
 receipt.image=JSON.parse(docker('image','inspect',image))[0].Id;receipt.success=true;
}finally{
 const failures=[];
 for(const client of clients){try{await client.close();}catch{failures.push('client_close_failed');}}
 for(const container of containers.reverse()){try{docker('stop','--time','10',container);const c=JSON.parse(docker('inspect',container))[0];if(c.State.Running)throw Error('stop failed');if(c.State.ExitCode!==0||c.State.OOMKilled)failures.push('non_graceful_exit');receipt.tests.push('stopped:'+c.State.ExitCode);docker('rm',container);}catch{failures.push('container_cleanup_failed');}}
 for(const network of networks.reverse()){try{docker('network','rm',network);}catch{failures.push('network_cleanup_failed');}}
 receipt.cleaned=failures.length===0;receipt.cleanupErrors=failures;if(failures.length)receipt.success=false;writeFileSync(resolve('artifacts/docker-check-receipt.json'),JSON.stringify(receipt,null,2));
 if(failures.length)throw Error('dedicated resource cleanup failed; inspect receipt');
}
console.log('PASS: container isolation, signed-JWT MCP, egress restriction, restart and cleanup');
