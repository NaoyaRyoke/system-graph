import {verifyRuntime}from'./runtime-guard.mjs';
try{verifyRuntime();}catch{process.stderr.write('FAIL: distribution boundary rejected\n');process.exit(1);}
await import('../dist/src/main.js');
