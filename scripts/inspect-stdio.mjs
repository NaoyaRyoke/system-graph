// Verification only: install Inspector separately, then supply its launcher path.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executable } from './engine.mjs';

const inspector = process.argv[2];
if (!inspector) throw Error('usage: node scripts/inspect-stdio.mjs /path/to/inspector/launcher.js');
const config = resolve('artifacts/sample-stdio.json');
const ids = JSON.parse(readFileSync('artifacts/sample-ids.json','utf8'));
const clientConfig = resolve('artifacts/inspector-stdio.json');
writeFileSync(clientConfig,JSON.stringify({mcpServers:{'system-graph':{
  command:process.execPath,args:[resolve('dist/index.js'),config,executable],
}}}));
const calls = [
  ['initialize',undefined,undefined],
  ['tools/list',undefined,undefined],
  ...['capabilities','inventory','query','impact','trace','explain'].map(op => [
    'tools/call','graph_'+op,{workspace:'main',
      ...(op==='query'?{query:'service'}:op==='trace'?{source:ids.reader,destination:ids.api}:
        op==='impact'||op==='explain'?{target:ids.api}:{})},
  ]),
];
const results=[];
for (const [method,name,args] of calls) {
  const flags=['--cli','--config',clientConfig,'--server','system-graph','--protocol-era','legacy','--method',method];
  if (name) flags.push('--tool-name',name,'--tool-args-json',JSON.stringify(args));
  const output=execFileSync(process.execPath,[resolve(inspector),...flags],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
  const result=JSON.parse(output);
  if(result.isError||result.error)throw Error('Inspector invocation rejected: '+(name??method));
  if(method==='initialize'&&(!result.serverInfo||!result.capabilities?.tools))throw Error('Inspector initialization incomplete');
  if(method==='tools/list'&&result.tools?.length!==6)throw Error('Inspector tool list mismatch');
  if(name&&!result.structuredContent)throw Error('Inspector structured response missing');
  results.push({method,...(name?{tool:name}:{}),pass:true});
  console.log('PASS: Inspector '+(name??method));
}
writeFileSync('artifacts/inspector-results.json',JSON.stringify({results},null,2)+'\n');
