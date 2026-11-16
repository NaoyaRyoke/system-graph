import type { EolNotice, EolSnapshot } from '../src/eol/index.js';

export const asOf = '2026-11-16T00:00:00Z';
export const notice: EolNotice = {
  schemaVersion: 1, kind: 'eol', id: 'notice-a', revision: 'r1', updatedAt: '2026-11-01T00:00:00Z',
  evidence: [{id:'notice-evidence', source:'notices/product-a.json', extractor:'fixture', confidence:'confirmed'}],
  product: 'product-a', vendor: 'vendor-a', releaseLine: '1',
  versions: {scheme:'numeric', from:'1.0', until:'2.0'},
  policies: [
    {tier:'standard', endsOn:'2026-11-15', requiredConditions:[]},
    {tier:'extended', endsOn:'2027-11-15', requiredConditions:['contract-active']},
  ],
};
export function snapshot(count = 1): EolSnapshot {
  return {schemaVersion:1, id:'snapshot-a', collectedAt:asOf, coverage:[], assets:Array.from({length:count}, (_, i) => ({
    id:`asset-${String(i).padStart(3,'0')}`, repositoryId:'repo-a', environment:'production',
    product:'product-a', vendor:'vendor-a', releaseLine:'1', version:'1.4.0',
    support:{tier:'standard', conditions:{}}, observedAt:asOf,
    artifactId:'artifact-old', deploymentId:`deployment-${i}`, serviceId:`service-${i}`, ownerTeam:'team-a',
    evidence:[{id:'runtime-evidence', source:'runtime/production.json', extractor:'fixture', confidence:'confirmed'}],
  }))};
}
export function eolConfig() {
  return {version:1,localPrincipal:{principal:'reader-a',tenant:'tenant-a'},
    workspace:{tenant:'tenant-a',workspace:'main',repositories:{'service-a':'repo-a'},
      allowedEnvironments:['production','staging','unknown'],status:'active'},
    permissions:[{principal:'reader-a',tenant:'tenant-a',workspace:'main',repositories:['service-a'],
      environments:['production'],operations:['inventory']}],
    notices:[structuredClone(notice)],snapshots:[snapshot(60)],maxAgeDays:30};
}
