import test from'node:test';import assert from'node:assert/strict';import {verifyRuntime}from'../docker/runtime-guard.mjs';
import fs from'node:fs';import {createHash}from'node:crypto';
import {publicBuildPackages,selectBuildPackages}from'../scripts/distribution/cargo-scope.mjs';

function cargoFixture(){return{packages:['host','normal','optional','dev'].map(id=>({id,name:id==='host'?'hybrid-engine-host':id,version:'1'})),resolve:{nodes:[{id:'host',features:[],deps:[{pkg:'normal',dep_kinds:[{kind:null}]},{pkg:'dev',dep_kinds:[{kind:'dev'}]}]},{id:'normal',features:[],deps:[]},{id:'optional',features:[],deps:[]},{id:'dev',features:[],deps:[]}]}};}

test('Cargo build inventory follows active normal/build edges rather than optional lockfile entries',()=>{
 const metadata=cargoFixture();metadata.packages.find(p=>p.id==='optional').name='pratt';
 assert.deepEqual(publicBuildPackages(metadata).map(p=>p.id),['host','normal']);
 metadata.resolve.nodes[0].deps.push({pkg:'optional',dep_kinds:[{kind:'build'}]});
 assert.throws(()=>publicBuildPackages(metadata),/must exclude Terraform\/HCL/);
});

test('Cargo release gate rejects normal HCL and feature unification, incomplete metadata fails closed',()=>{
 for(const name of ['pratt','hcl-edit','hcl-rs']){const metadata=cargoFixture();metadata.packages.find(p=>p.id==='normal').name=name;assert.throws(()=>publicBuildPackages(metadata),/must exclude/);}
 const metadata=cargoFixture();metadata.resolve.nodes[0].features=['terraform'];assert.throws(()=>publicBuildPackages(metadata),/must disable/);
 assert.throws(()=>selectBuildPackages({packages:[]}),/resolve graph required/);
 const broken=cargoFixture();broken.resolve.nodes.pop();broken.resolve.nodes[0].deps.push({pkg:'missing',dep_kinds:[{kind:null}]});assert.throws(()=>selectBuildPackages(broken),/incomplete/);
});
test('distribution guard allows short fixed Docker DNS without environment overrides',()=>assert.equal(verifyRuntime({},'nameserver 127.0.0.11\nsearch .\noptions ndots:0\n'),true));
test('distribution guard rejects the long-search resolver precondition without echoing its value',()=>{const value='x'.repeat(201);assert.throws(()=>verifyRuntime({},'search '+value),e=>e.message==='unsafe resolver configuration'&&!e.message.includes(value));});
test('distribution guard rejects catalog, loader, and resolver environment overrides',()=>{for(const key of ['LANGUAGE','LOCALDOMAIN','RES_OPTIONS','LD_PRELOAD','LD_LIBRARY_PATH','GCONV_PATH'])assert.throws(()=>verifyRuntime({[key]:'synthetic-value'},''),e=>e.message==='unsafe runtime environment');});

test('modified vendored source files carry a prominent modification notice',()=>{
 const manifest=JSON.parse(fs.readFileSync('licenses/vendor-modifications.json','utf8'));
 for(const file of manifest.files){if(!/\.(rs|toml|sql|md)$/.test(file.path))continue;
  assert.match(fs.readFileSync('vendor/engine/'+file.path,'utf8').slice(0,600),/Modified from Code System Graph v1\.2\.1/,file.path);
 }
});
test('migration attribution preserves every byte of the legacy SQL payload',()=>{
 const sql=fs.readFileSync('vendor/engine/crates/code-system-graph-store-sqlite/migrations/0001_initial.sql','utf8').replaceAll('\r\n','\n');
 const prefix='-- Modified from Code System Graph v1.2.1; local schema/property/provenance hardening. See VENDOR.md.\n';
 assert.ok(sql.startsWith(prefix));
 assert.equal(createHash('sha256').update(sql.slice(prefix.length)).digest('hex'),'9ea19f27258c933acd89d3b5d23d4ed981c1702d80a7ec6d5026843cc68fdc78');
});
