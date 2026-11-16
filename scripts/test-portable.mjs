import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const tests=readdirSync('dist/tests').filter(name=>/^(?:platform-|eol).*\.test\.js$/.test(name)).sort().map(name=>'dist/tests/'+name);
execFileSync(process.execPath,['--test','--test-concurrency=1',...tests],{stdio:'inherit'});
