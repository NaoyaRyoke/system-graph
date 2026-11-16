import { z } from 'zod';
import { id } from '../contracts.js';
import { calendarDate, evidenceSchema, noticeMetadata, referenceId, timestamp, type AssessmentPage, type AssessmentStatus, type Evidence } from '../assessments/model.js';
import { issueScopeSchema,type CoverageIssue } from '../platform/coverage.js';

const name = z.string().min(1).max(128);
const environment = id.refine(v=>v!=='unknown','use null for unknown environment').nullable();
export const numericVersion = z.string().regex(/^\d{1,12}(?:\.\d{1,12}){0,7}$/);
export function compareNumeric(a:string,b:string): number {
  const x=a.split('.').map(BigInt), y=b.split('.').map(BigInt);
  for(let i=0;i<Math.max(x.length,y.length);i++) {
    const left=x[i]??0n, right=y[i]??0n;
    if(left!==right)return left<right?-1:1;
  }
  return 0;
}
const versions = z.discriminatedUnion('scheme', [
  z.object({scheme:z.literal('exact'), values:z.array(name).min(1).max(100)}).strict(),
  z.object({scheme:z.literal('numeric'), from:numericVersion, until:numericVersion}).strict()
    .refine(v=>compareNumeric(v.from,v.until)<0, 'empty or reversed version range'),
]);
export const eolNoticeSchema = noticeMetadata.extend({
  kind:z.literal('eol'), product:name, vendor:name, releaseLine:name,
  versions,
  policies:z.array(z.object({
    tier:id, endsOn:calendarDate.nullable(), requiredConditions:z.array(id).max(16),
  }).strict()).min(1).max(8),
}).strict().refine(v=>new Set(v.policies.map(p=>p.tier)).size===v.policies.length,'duplicate support tiers');
export const eolAssetSchema = z.object({
  id:referenceId, repositoryId:z.string().min(1).max(180), environment,
  product:name.nullable(), vendor:name.nullable(), releaseLine:name.nullable(), version:name.nullable(),
  support:z.object({tier:id.nullable(), conditions:z.record(id,z.boolean().nullable()).refine(v=>Object.keys(v).length<=32)}).strict(),
  artifactId:referenceId.nullable(),artifactDigest:z.string().max(128).nullable().optional(),deploymentId:referenceId.nullable(), serviceId:referenceId.nullable(), ownerTeam:id.nullable(),
  observedAt:timestamp,observationRange:z.object({earliest:timestamp,latest:timestamp}).strict().refine(r=>Date.parse(r.earliest)<=Date.parse(r.latest),'invalid observation range').optional(),evidence:z.array(evidenceSchema).max(16),
}).strict();
export const coverageGapSchema = z.object({
  repositoryId:z.string().min(1).max(180), environment,
  reason:z.enum(['collection_failed','partial_collection','unsupported_input']),
  issueReason:z.string().max(64).optional(),appliesTo:issueScopeSchema.optional(),
}).strict();
export const eolSnapshotSchema = z.object({
  schemaVersion:z.literal(1), id:referenceId, collectedAt:timestamp,
  assets:z.array(eolAssetSchema).max(10000), coverage:z.array(coverageGapSchema).max(1000),
}).strict().refine(v=>new Set(v.assets.map(a=>a.id)).size===v.assets.length,'duplicate asset IDs');
export const evaluationOptionsSchema = z.object({
  asOf:timestamp, maxAgeDays:z.number().int().min(0).max(3650).default(30),
  limit:z.number().int().min(1).max(50).default(20), offset:z.number().int().min(0).max(10000).default(0),
}).strict();
export const eolInputSchema = z.object({
  workspace:id, noticeId:referenceId, noticeRevision:referenceId, snapshotId:referenceId,
  environments:z.array(id).min(1).max(16).optional(), repositories:z.array(id).min(1).max(16).optional(),
  asOf:timestamp, limit:z.number().int().min(1).max(50).default(20), offset:z.number().int().min(0).max(10000).default(0),
}).strict();
export type EolNotice = z.infer<typeof eolNoticeSchema>;
export type EolAsset = z.infer<typeof eolAssetSchema>;
export type EolSnapshot = z.infer<typeof eolSnapshotSchema>;
export type EvaluationOptions = z.input<typeof evaluationOptionsSchema>;
export interface EolAssetAssessment {
  assetId:string; repositoryId:string; environment:string|null;
  product:string|null; vendor:string|null; releaseLine:string|null; version:string|null;
  supportTier:string|null; ownerTeam:string|null; observedAt:string;
  observationRange:{earliest:string;latest:string};
  supportConditions:{condition:string;value:boolean|null}[];
  status:AssessmentStatus; reason:string; deadline:string|null; missing:string[];
  path:{kind:'asset'|'artifact'|'deployment'|'service';id:string}[];
  evidence:Evidence[];
}
export interface EolGap {reason:string; repositoryId?:string; environment?:string|null;issueReason?:string|undefined;appliesTo?:CoverageIssue['appliesTo']}
export interface EolAssessment extends AssessmentPage<EolAssetAssessment,EolGap> {
  evaluationContract:2;
  schemaVersion:1; kind:'eol'; status:AssessmentStatus; complete:boolean;
  noticeUpdatedAt:string; noticeEvidence:Evidence[]; snapshotCollectedAt:string; maxAgeDays:number;
  criteria:Pick<EolNotice,'product'|'vendor'|'releaseLine'|'versions'|'policies'>;
  truncated:false; // No graph exploration: result paging is represented separately.
}
