// Exercise the packaged command through the real npx CLI, from outside the checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { executable } from './engine.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw Error('Run this check with npm run test:npx');
const npxCli = join(dirname(npmCli), 'npx-cli.js');
await import('./sample.mjs');
const work = mkdtempSync(resolve('artifacts/npx check '));
const env = { ...process.env, npm_config_cache: join(work, 'cache'), SYSTEM_GRAPH_CONFIG: resolve('artifacts/sample-stdio.json'), SYSTEM_GRAPH_ENGINE: executable };
const packResult = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--silent', '--json', '--pack-destination', work], { encoding: 'utf8', env }));
const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
const paths = packed.files.map(file => file.path);
for (const required of ['dist/index.js', 'dist/src/index.js', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) assert.ok(paths.includes(required), required);
for (const file of paths) {
  assert.ok(['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES', 'THIRD_PARTY_NOTICES.md', 'VENDOR.md', 'dist/index.js'].includes(file) || file.startsWith('dist/src/') || file.startsWith('licenses/'), 'unexpected package file: ' + file);
  assert.ok(!/\.(?:db|exe|key|pem)$/.test(file), 'runtime/state file included: ' + file);
}

const packageSpec = process.argv[2] ?? join(work, packed.filename);
const child = spawn(process.execPath, [npxCli, '--yes', '--package', packageSpec, 'system-graph'], { cwd: work, env, windowsHide: true, stdio: 'pipe' });
const closed = new Promise(resolve => child.once('close', resolve));
let buffer = '', diagnostic = '', next = 0;
const invalid = [], pending = new Map();
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { diagnostic += chunk; });
child.stdin.on('error', () => {});
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      pending.get(message.id)?.(message);
    } catch { invalid.push('non-protocol stdout'); }
  }
});
async function request(method, params = {}) {
  const id = ++next;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('npx MCP request timeout')); }, 180000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    void closed.then(code => {
      if (pending.has(id)) {
        clearTimeout(timer); pending.delete(id);
        reject(Error('npx exited before an MCP response (exit ' + code + ')\n' + diagnostic));
      }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return result;
}
try {
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'npx-package-check', version: '1' } });
  assert.equal(initialized.error, undefined); assert.ok(initialized.result.capabilities.tools);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request('tools/list');
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['graph_capabilities', 'graph_explain', 'graph_impact', 'graph_inventory', 'graph_query', 'graph_trace']);
  const ids = JSON.parse(readFileSync('artifacts/sample-ids.json', 'utf8'));
  for (const op of ['capabilities', 'inventory', 'query', 'impact', 'trace', 'explain']) {
    const args = { workspace: 'main', ...(op === 'query' ? { query: 'service' } : op === 'trace' ? { source: ids.reader, destination: ids.api } : op === 'impact' || op === 'explain' ? { target: ids.api } : {}) };
    const response = await request('tools/call', { name: 'graph_' + op, arguments: args });
    assert.equal(response.error, undefined); assert.notEqual(response.result.isError, true); assert.ok(response.result.structuredContent);
  }
  child.stdin.end();
  let timer;
  try {
    assert.equal(await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('npx shutdown timeout')), 5000); })]), 0);
  } finally { clearTimeout(timer); }
  assert.deepEqual(invalid, []); assert.equal(buffer, '');
  assert.match(diagnostic, /READY: read-only graph stdio server/);
  writeFileSync(join(work, 'result.json'), JSON.stringify({ pass: true, files: paths.length, checks: ['package allowlist', 'initialize', 'tools/list', 'six tool calls', 'stdout purity', 'clean EOF'] }, null, 2));
  console.log('PASS: npx package, initialize/list/six calls, stdout purity and clean EOF');
} finally {
  child.stdin.end();
  if (child.exitCode === null) child.kill();
}
