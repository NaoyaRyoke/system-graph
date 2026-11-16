import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const asOf='2026-11-16T00:00:00Z',sbom=JSON.parse(readFileSync(new URL('../examples/platform-sbom.json',import.meta.url),'utf8'));
const ev=(repositoryId,environment)=>({id:'runtime-evidence-'+repositoryId,source:'fixtures/runtime.json',extractor:'sample-v1',confidence:'confirmed',observedAt:asOf,repositoryId,environment});
const newer=structuredClone(sbom);newer.components[1].version='2.0.0';newer.components[1].purl='pkg:npm/library-a@2.0.0';
const metadata=letter=>({repositoryId:'repo-a',revision:'revision-'+letter,digest:'sha256:'+letter.repeat(64),image:'service-a:'+letter,observedAt:asOf,evidence:[ev('repo-a',null)]});
const deployed=(letter,environment,version)=>({name:'service-a',repositoryId:'repo-a',environment,cluster:'cluster-a',account:'account-a',namespace:'team-a',serviceId:'service-a',ownerTeam:'team-a',
  artifactDigest:metadata(letter).digest,image:metadata(letter).image,observedAt:asOf,state:'observed',evidence:[ev('repo-a',environment)],
  products:[{id:'product-a',product:'product-a',vendor:'vendor-a',releaseLine:'1',version,support:{tier:'standard',conditions:{}},observedAt:asOf,
    evidence:[{id:'product-evidence',source:'fixtures/products.json',extractor:'sample-v1',confidence:'confirmed'}]}]});
const noticeEvidence=[{id:'notice-evidence',source:'fixtures/notices.json',extractor:'sample-v1',confidence:'confirmed'}];
const notices=[{schemaVersion:1,kind:'vulnerability',id:'cve-test-a',revision:'r1',updatedAt:'2026-11-01T00:00:00Z',evidence:noticeEvidence,
  rules:[{packageUrl:'pkg:npm/library-a',versions:{scheme:'semver',introduced:'1.0.0',fixed:'2.0.0'}}]},
{schemaVersion:1,kind:'eol',id:'eol-test-a',revision:'r1',updatedAt:'2026-11-01T00:00:00Z',evidence:noticeEvidence,product:'product-a',vendor:'vendor-a',releaseLine:'1',
  versions:{scheme:'numeric',from:'1.0',until:'2.0'},policies:[{tier:'standard',endsOn:'2026-11-15',requiredConditions:[]},{tier:'extended',endsOn:'2027-11-15',requiredConditions:['contract-active']}]}];
const operations=['health','capabilities','inventory','query','impact','trace','explain'];
const config={version:1,localPrincipal:{tenant:'tenant-a',principal:'sample-reader'},workspace:{tenant:'tenant-a',workspace:'main',repositories:{'service-a':'repo-a','service-b':'repo-b'},allowedEnvironments:['production','staging','unknown'],status:'active'},
  permissions:[{tenant:'tenant-a',principal:'sample-reader',workspace:'main',repositories:['service-a','service-b'],environments:['production','staging'],operations}],notices,
  source:{snapshotId:'sample-snapshot-a',asOf,mode:'working_tree',repositories:['a','b'].map(s=>({repositoryId:'repo-'+s,serviceId:'service-'+s,revision:'synthetic-revision-a',environment:'production',baseUrl:`http://service-${s}.invalid`,root:resolve(`tests/fixtures/platform/service-${s}`)})),
    artifacts:[{sbom,metadata:metadata('a')},{sbom:newer,metadata:metadata('b')}],runtime:{schemaVersion:1,deployments:[deployed('a','production','1.1.0'),deployed('b','staging','2.0.0')],coverage:[]}}};
mkdirSync('artifacts',{recursive:true});const file=resolve('artifacts','portable-sample-'+randomUUID()+'.json');
writeFileSync(file,JSON.stringify(config,null,2),{flag:'wx'});
process.stdout.write(file+'\n');
process.stderr.write('Synthetic config created. Start with node dist/index.js --platform CONFIG. No Rust or external service is required.\n');
