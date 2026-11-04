import { buildPublicRuntime } from './public-runtime.js';
import { listenLocal } from './remote-mcp.js';
async function start(){
 const config=process.argv[2],executable=process.argv[3];if(!config||!executable)throw Error('explicit fixture configuration required');
 const runtime=buildPublicRuntime(config,executable);
 try{
  const origin=process.env.CANONICAL_ORIGIN??'http://127.0.0.1:3000';
  if(runtime.authMode==='dev-bearer'&& !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('dev authentication requires loopback');
  await runtime.warm();const server=await listenLocal(runtime.service,runtime.auth,{port:3000,containerFixture:process.env.CONTAINER_MODE==='1',canonicalOrigin:origin,readiness:()=>[...runtime.pool.clients.values()].every(c=>c.available)});
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await server.close();await runtime.close();process.exit(0);};
  process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});process.stderr.write('READY: read-only graph server; no credentials logged\n');
 }catch{await runtime.close();throw Error('startup rejected');}
}
void start().catch(()=>{process.stderr.write('FAIL: startup rejected\n');process.exitCode=1;});
