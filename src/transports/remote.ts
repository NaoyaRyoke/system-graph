import { createServer,type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ApiError,MAX_RESPONSE_BYTES,safeError,type AuthContext,type AuthProvider } from '../contracts.js';
import { QueryService } from '../service.js';
import { legacyAdapter } from '../legacy-adapter.js';
import { requestContext } from '../request-context.js';
import { createGraphServer } from '../server/index.js';
export interface ListenerOptions{port?:number;containerFixture?:boolean;canonicalOrigin?:string;readiness?:()=>boolean}
export async function listenLocal(service:QueryService,auth:AuthProvider,options:ListenerOptions={}):Promise<{url:string;server:Server;close:()=>Promise<void>}>{
 let origin=options.canonicalOrigin??'',active=0;
 const server=createServer((req,res)=>{void(async()=>{
  const start=performance.now(),requestId=randomUUID(),abort=new AbortController();let actor:AuthContext|undefined;let outcome='rejected';let counted=false;
  req.once('aborted',()=>abort.abort());res.once('close',()=>{if(!res.writableEnded)abort.abort();});
  const timer=setTimeout(()=>{abort.abort();res.destroy();},6500);
  try{
   const host=req.headers.host;const allowed=host===new URL(origin).host||options.containerFixture&&host==='127.0.0.1:3000';
   if(!allowed||(req.headers.origin!==undefined&&req.headers.origin!==origin)||req.headers.forwarded||req.headers['x-forwarded-host']||req.headers['x-forwarded-for']){res.writeHead(403).end();return;}
   if(req.url==='/health'&&req.method==='GET'){const ready=options.readiness?.()??true;res.writeHead(ready?200:503,{'Content-Type':'application/json'}).end(JSON.stringify({status:ready?'alive':'not_ready'}));return;}
   if(req.url!=='/mcp'&&req.url!=='/mcp-legacy'){res.writeHead(404).end();return;}
   if(active>=4){res.writeHead(429,{'Retry-After':'1'}).end();return;}active++;counted=true;
   let authTimer:NodeJS.Timeout|undefined;
   try{actor=await Promise.race([auth.authenticate(req.headers,abort.signal),new Promise<never>((_resolve,reject)=>{authTimer=setTimeout(()=>{reject(new ApiError('unauthenticated'));abort.abort();},2000);})]);}finally{if(authTimer)clearTimeout(authTimer);}
   if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'}).end();return;}
   let size=0;const chunks:Buffer[]=[];
   if(!req.headers['content-type']?.startsWith('application/json'))throw new ApiError('invalid_request');
   for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>16384)throw new ApiError('invalid_request');chunks.push(chunk);}
   const body=Buffer.concat(chunks).toString('utf8');try{JSON.parse(body);}catch{throw new ApiError('invalid_request');}
   const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(typeof v==='string'&&!['host','connection','content-length'].includes(k))headers.set(k,v);
   const web=new Request(origin+req.url,{method:'POST',headers,body,signal:abort.signal});
   const current=createMcpHandler(()=>createGraphServer({service,principal:actor!,signal:abort.signal}),{legacy:'reject',responseMode:'auto',onerror:()=>{}});
   try{
    const response=await requestContext.run({requestId},()=>req.url==='/mcp-legacy'?legacyAdapter(()=>createGraphServer({service,principal:actor!,signal:abort.signal}))(web):current.fetch(web));
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>MAX_RESPONSE_BYTES)throw new ApiError('response_too_large');
    res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.setHeader('Cache-Control','no-store');res.end(bytes);outcome=String(response.status);
   }finally{await current.close();}
  }catch(error){const e=safeError(error);outcome=e.code;if(!res.headersSent)res.writeHead(e.code==='unauthenticated'?401:e.code==='permission_denied'?403:400,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:{code:e.code}}));else res.end();}
  finally{clearTimeout(timer);if(counted)active--;service.hooks.metrics.observe('request_count',1,outcome);service.hooks.metrics.observe('active_requests',active,outcome);try{service.hooks.audit.record({requestId,principal:actor?.principal??'anonymous',tenant:actor?.tenant??'unknown',workspace:'adapter',operation:'mcp_ingress',environments:[],allowed:!!actor,durationMs:performance.now()-start,resultCount:0,outcome});}catch{/* The query service separately fails closed when its audit sink rejects. */}}
 })();});
 server.maxConnections=32;server.requestTimeout=7000;server.headersTimeout=5000;server.maxHeadersCount=32;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,options.containerFixture?'0.0.0.0':'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('listener unavailable');origin=options.canonicalOrigin??`http://127.0.0.1:${address.port}`;
 return {url:origin+'/mcp',server,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
