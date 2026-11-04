// Fixed destinations only. TLS/authentication must be configured at the trusted edge.
import { createServer,request } from 'node:http';
import {verifyRuntime}from'./runtime-guard.mjs';
verifyRuntime();
const routes=new Map([['/a/mcp','graph-a'],['/b/mcp','graph-b']]);
let active=0;
const server=createServer((req,res)=>{
 if(req.headers.host!=='127.0.0.1:18974'||(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:18974')||req.headers.forwarded||req.headers['x-forwarded-host']){res.writeHead(403).end();return;}
 const target=routes.get(req.url);if(!target||req.method!=='POST'){res.writeHead(404).end();return;}
 if(active>=4){res.writeHead(429,{'Retry-After':'1'}).end();return;}active++;
 const headers={host:'127.0.0.1:18974'};
 for(const name of ['authorization','content-type','accept','mcp-protocol-version','mcp-method','mcp-name'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name];
 let bytes=0,output=0,done=false;
 const finish=()=>{if(!done){active--;done=true;}};
 const upstream=request({host:target,port:3000,path:'/mcp',method:'POST',headers,timeout:6500},incoming=>{
  res.writeHead(incoming.statusCode??502,{'Content-Type':incoming.headers['content-type']??'application/json','Cache-Control':'no-store'});
  incoming.on('data',chunk=>{output+=chunk.length;if(output>262144){upstream.destroy();res.destroy();}else res.write(chunk);});incoming.on('end',()=>res.end());
 });
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.on('timeout',()=>upstream.destroy());
 req.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384){upstream.destroy();res.writeHead(413).end();}else upstream.write(chunk);});req.on('end',()=>upstream.end());req.on('aborted',()=>upstream.destroy());
 res.on('close',()=>{upstream.destroy();finish();});
});
server.maxConnections=32;server.requestTimeout=7000;server.headersTimeout=5000;
server.listen(3000,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
