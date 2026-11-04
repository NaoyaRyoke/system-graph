import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
await import('./sample.mjs');
const tests=readdirSync('dist/tests').filter(n=>n.endsWith('.test.js')).sort().map(n=>'dist/tests/'+n);
execFileSync(process.execPath,['--test','--test-concurrency=1',...tests],{stdio:'inherit'});
execFileSync(process.execPath,['--test','tests/distribution.test.mjs'],{stdio:'inherit'});
