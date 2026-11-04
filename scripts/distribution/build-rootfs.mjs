// Build-only: derive the runtime from actual ELF dependencies, not a package-name guess.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync}from'node:child_process';
const out='/out/rootfs',records=[],packages=new Map();
fs.mkdirSync(out,{recursive:true});
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function copy(source,destination,owner){const target=out+destination;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);fs.chmodSync(target,destination.includes('/licenses/')?0o444:0o555);records.push({path:destination,sha256:hash(source),owner});}
function packageFor(file){
 for(const candidatePath of [...new Set([fs.realpathSync(file),file,file.replace(/^\/usr\/lib\//,'/lib/'),file.replace(/^\/lib\//,'/usr/lib/')])]){try{const found=execFileSync('dpkg-query',['-S',candidatePath],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n')[0];const p=found.slice(0,found.indexOf(': /'));const fields=execFileSync('dpkg-query',['-W','-f=${Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}',p],{encoding:'utf8'}).split('\t');const[name,version,source,sourceVersion,architecture]=fields;const result={name,version,source:source||name,sourceVersion:sourceVersion||version,architecture,scope:'runtime-ELF'};packages.set(name,result);return name;}catch{}}
 throw Error('unattributed runtime ELF: '+file);
}
const linkage=[];
for(const binary of ['/usr/local/bin/node','/app/engine']){
 const ldd=execFileSync('ldd',[binary],{encoding:'utf8'});const needed=[...new Set([...ldd.matchAll(/\/(?:[^\s()]+)/g)].map(m=>m[0]))];
 if(!needed.length)throw Error('ELF linkage unavailable');
 const symbols=execFileSync('readelf',['--dyn-syms','--wide',binary],{encoding:'utf8',maxBuffer:16*1024*1024});
 linkage.push({binary,needed,undefinedSymbols:symbols.split('\n').filter(l=>/\bUND\b/.test(l)).map(l=>l.trim().split(/\s+/)[7]).filter(Boolean)});
 for(const lib of needed)if(!records.some(r=>r.path===lib))copy(lib,lib,packageFor(lib));
 copy(binary,binary,binary.endsWith('node')?'Node.js':'system-graph-remote');
}
// NSS is loaded lazily by libc, and is not listed by ldd. Preserve it explicitly.
const arch=process.arch==='x64'?'x86_64-linux-gnu':process.arch==='arm64'?'aarch64-linux-gnu':null;if(!arch)throw Error('unsupported packaging architecture');
for(const name of ['libnss_dns.so.2','libnss_files.so.2']){const file='/usr/lib/'+arch+'/'+name;if(fs.existsSync(file)&&!records.some(r=>r.path===file))copy(file,file,packageFor(file));}
for(const p of packages.values()){const file='/usr/share/doc/'+p.name+'/copyright';if(!fs.existsSync(file))throw Error('OS copyright evidence missing');copy(fs.realpathSync(file),'/licenses/os/'+p.name+'/copyright',p.name);}
// Materialize every text as a regular file: distro symlinks point outside /licenses.
function licenseTree(source,destination){
 fs.mkdirSync(destination,{recursive:true});
 for(const e of fs.readdirSync(source,{withFileTypes:true})){
  const from=path.join(source,e.name),to=path.join(destination,e.name);
  if(fs.statSync(from).isDirectory())licenseTree(from,to);
  else {if(fs.existsSync(to)||fs.lstatSync(path.dirname(to)).isSymbolicLink())throw Error('unexpected duplicate license path');fs.copyFileSync(fs.realpathSync(from),to);}
 }
}
licenseTree('/usr/share/common-licenses',out+'/licenses/os/common-licenses');
copy('/usr/local/LICENSE','/licenses/node/LICENSE','Node.js');
for(const [source,destination]of [['/app/node_modules','/app/node_modules'],['/app/dist/src','/app/dist/src'],['/app/docker','/app/docker'],['/app/release-licenses','/licenses/distribution'],['/license-inputs/os-source','/licenses/corresponding-source']]){fs.mkdirSync(path.dirname(out+destination),{recursive:true});fs.cpSync(source,out+destination,{recursive:true});}
for(const [name,data]of [['passwd','app:x:10001:10001:Application:/nonexistent:/sbin/nologin\n'],['group','app:x:10001:\n'],['nsswitch.conf','hosts: files dns\npasswd: files\ngroup: files\n'],['os-release','ID=debian\nVERSION_ID="13"\n']]){fs.mkdirSync(out+'/etc',{recursive:true});fs.writeFileSync(out+'/etc/'+name,data);}
const sources=fs.readdirSync('/license-inputs/os-source',{withFileTypes:true}).filter(e=>e.isFile()).map(e=>({file:e.name,sha256:hash('/license-inputs/os-source/'+e.name),bytes:fs.statSync('/license-inputs/os-source/'+e.name).size}));
const sqliteDirectory=fs.readdirSync('/license-inputs/registry/src')[0];
const sqliteHeader=fs.readFileSync('/license-inputs/registry/src/'+sqliteDirectory+'/libsqlite3-sys-0.39.1/sqlite3/sqlite3.h','utf8');
const nativeEvidence={rustSqlite:sqliteHeader.match(/^#define SQLITE_VERSION +"([^"]+)/m)?.[1],sqliteLicense:'Public domain dedication in bundled sqlite3.h; wrapper crate licenses are retained separately',engineLinkMapSha256:hash('/license-inputs/engine-link.map'),sources};
if(!nativeEvidence.rustSqlite)throw Error('bundled SQLite version missing');
fs.writeFileSync(out+'/licenses/distribution/native-components.json',JSON.stringify(nativeEvidence,null,2));
fs.mkdirSync(out+'/tmp',{recursive:true});fs.mkdirSync(out+'/licenses/distribution',{recursive:true});
const npmLock=JSON.parse(fs.readFileSync('/app/node_modules/.package-lock.json','utf8'));
const npmRuntime=Object.entries(npmLock.packages).map(([p,v])=>({name:v.name??p.split('node_modules/').at(-1),version:v.version}));
const inventory={os:'Debian',osVersion:'13',architecture:process.arch,packages:[...packages.values()],npmRuntime,nodeVersions:process.versions,nativeEvidence,files:records,linkage,removed:'no shell, package manager, npm CLI, OS sqlite, archive tools, PAM, systemd, or sample generator executable'};
fs.writeFileSync(out+'/licenses/distribution/runtime-manifest.json',JSON.stringify(inventory,null,2));
// Some published crates use owner-only license modes. Legal payload must be readable by UID 10001.
function publicLicenseModes(root){for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isSymbolicLink())throw Error('unexpected license symlink');if(e.isDirectory())publicLicenseModes(p);else fs.chmodSync(p,0o444);}fs.chmodSync(root,0o555);}
publicLicenseModes(out+'/licenses');
fs.writeFileSync('/out/runtime-manifest.json',JSON.stringify(inventory,null,2));
console.log(JSON.stringify({runtimePackages:packages.size,runtimeLibraries:records.length,sourceArchives:fs.readdirSync('/license-inputs/os-source').filter(n=>n.endsWith('.xz')||n.endsWith('.gz')||n.endsWith('.dsc')).length}));
