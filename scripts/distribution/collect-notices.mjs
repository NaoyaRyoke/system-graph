// Build-only distribution evidence. Values are public package/license metadata only.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {publicBuildPackages} from './cargo-scope.mjs';
const output='/app/release-licenses';fs.mkdirSync(output,{recursive:true});
const metadata=JSON.parse(fs.readFileSync('/license-inputs/cargo-metadata.json','utf8'));
const entries=[],missing=[],unresolved=[];
const digest=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function files(root){const result=[];for(const e of fs.readdirSync(root,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(root,e.name);if(e.isDirectory()&&!['.git','node_modules','target'].includes(e.name))result.push(...files(p));else if(e.isFile()&&/^(?:licen[cs]e|copying|copyright|notice|authors)(?:[._-].*)?$/i.test(e.name))result.push(p);}return result;}
function save(ecosystem,name,version,license,root,source){
 const slug=ecosystem+'/'+name.replaceAll('/','__')+'-'+version;let texts=files(root);
 const supplement='/license-inputs/supplemental/'+name+'-'+version;
 if(!texts.length&&fs.existsSync(supplement)){root=supplement;texts=files(root);}
 const record={ecosystem,name,version,license,source,scope:ecosystem==='cargo'?'resolved build/platform inventory; native reachability listed separately':'resolved npm inventory; runtime package tree is pruned separately',copyleft:/\b(?:MPL|GPL|LGPL|AGPL)/.test(license),selectedLicense:license==='MIT OR Apache-2.0 OR LGPL-2.1-or-later'?'MIT':license,attribution:'Preserve included license/copyright texts',notice:'Preserve included NOTICE files when present',sourceOffer:'No additional offer for permissive selection; OS/source-specific rules are separate',files:[]};
 if(!texts.length)missing.push({ecosystem,name,version});
 for(const file of texts){const relative=path.relative(root,file).replaceAll('\\','/'),destination=slug+'/'+relative;fs.mkdirSync(path.dirname(output+'/'+destination),{recursive:true});fs.copyFileSync(file,output+'/'+destination);record.files.push({path:destination,sha256:digest(file)});}
 entries.push(record);
}
for(const p of publicBuildPackages(metadata)){let root;
 if(p.source?.startsWith('registry+'))root='/license-inputs/registry/src/'+p.manifest_path.split('/registry/src/')[1].replace(/\/Cargo.toml$/,'');
 else if(p.name==='hybrid-engine-host')root='/license-inputs/host';
 else root='/license-inputs/engine';
 const source=p.source?.startsWith('registry+')?'https://crates.io/crates/'+p.name+'/'+p.version:p.name==='hybrid-engine-host'?'This source archive: rust-host/':'https://github.com/dertin/code-system-graph/tree/d161502d8e6db606345f998574df10637591f9e8 (locally modified; see VENDOR.md)';
 save('cargo',p.name,p.version,p.license??'NOASSERTION',root,source);
}
function npm(root){for(const e of fs.readdirSync(root,{withFileTypes:true})){if(!e.isDirectory()||e.name.startsWith('.'))continue;const folder=path.join(root,e.name);if(e.name.startsWith('@')){npm(folder);continue;}const file=path.join(folder,'package.json');if(!fs.existsSync(file))continue;const p=JSON.parse(fs.readFileSync(file,'utf8'));save('npm',p.name,p.version,typeof p.license==='string'?p.license:p.license?.type??'NOASSERTION',folder,'https://www.npmjs.com/package/'+p.name+'/v/'+p.version);if(fs.existsSync(path.join(folder,'node_modules')))npm(path.join(folder,'node_modules'));}}
npm('/app/node_modules');
fs.cpSync('/license-inputs/rust-license',output+'/rust-toolchain',{recursive:true});
fs.copyFileSync('/app/LICENSE',output+'/LICENSE');fs.copyFileSync('/app/NOTICE',output+'/NOTICE');
fs.copyFileSync('/app/VENDOR.md',output+'/VENDOR.md');fs.copyFileSync('/app/vendor-modifications.json',output+'/vendor-modifications.json');
if(!JSON.parse(fs.readFileSync('/app/vendor-modifications.json','utf8')).perFileNoticeReviewComplete)unresolved.push({ecosystem:'source',name:'modified-vendored-engine',version:'1.2.1+local',reason:'Final per-file modification notice review remains open; see vendor-modifications.json. Migration bytes are preserved for schema compatibility.'});
fs.cpSync('/license-inputs/supplemental/sources.json',output+'/supplemental-sources.json');
fs.writeFileSync(output+'/dependency-license-inventory.json',JSON.stringify({entries,missing,unresolved,policy:'Exact texts are preserved; expressions are not proof of binary reachability. Unresolved attribution blocks publication even if an internal candidate image builds.'},null,2));
let text='# Third-party distribution notices\n\nGenerated from the release lockfile and package sources. Preserve this file and the accompanying license texts. Node bundled native dependencies are covered by /licenses/node/LICENSE. OS libraries, exact source archives and their source/relink instructions are under /licenses/os and /licenses/corresponding-source.\n\n';
for(const p of entries)text+=`- ${p.ecosystem} ${p.name} ${p.version}: ${p.license}; ${p.source}; license texts: ${p.files.map(f=>f.path).join(', ')}\n`;
for(const p of unresolved)text+=`\nREDISTRIBUTION BLOCKER: ${p.name} ${p.version}: ${p.reason}\n`;
fs.writeFileSync(output+'/THIRD_PARTY_NOTICES',text);
if(missing.length||unresolved.length){console.log(JSON.stringify({missing,unresolved}));throw Error('license evidence incomplete; do not distribute');}
console.log(JSON.stringify({attributedPackages:entries.length,missing:0}));
