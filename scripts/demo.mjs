import { readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes,createHash } from 'node:crypto';
import { buildPublicRuntime } from '../dist/src/public-runtime.js';
import { listenLocal } from '../dist/src/remote-mcp.js';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { executable } from './engine.mjs';
await import('./sample.mjs');
const cfg=JSON.parse(readFileSync('artifacts/sample-template.json','utf8')),token=randomBytes(32).toString('base64url');
cfg.auth.identities=[{sha256:createHash('sha256').update(token).digest('hex'),principal:{principal:'sample-reader',subject:'synthetic-subject',issuer:'https://issuer.invalid',tenant:'tenant-sample',roles:['reader'],scopes:['graph:read'],expiresAt:Date.now()+600000}}];
const file=resolve('artifacts/demo-runtime.json');writeFileSync(file,JSON.stringify(cfg),{mode:0o600});
const runtime=buildPublicRuntime(file,executable);let server,client;
try{await runtime.warm();server=await listenLocal(runtime.service,runtime.auth);client=new Client({name:'sample-client',version:'0.1.0-beta.1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
 console.log('tools/list:',(await client.listTools()).tools.map(t=>t.name).join(', '));
 const ids=JSON.parse(readFileSync('artifacts/sample-ids.json','utf8'));
 for(const [op,args]of [['query',{query:'sample'}],['impact',{target:ids.api}],['trace',{source:ids.reader,destination:ids.api}],['explain',{target:ids.reader}]]){const result=await client.callTool({name:'graph_'+op,arguments:{workspace:'main',...args}});if(result.isError)throw Error('demo operation failed');console.log('PASS:',op,'read-only result');}
}finally{await client?.close();await server?.close();await runtime.close();unlinkSync(file);}
