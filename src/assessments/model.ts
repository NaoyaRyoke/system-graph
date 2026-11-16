import { z } from 'zod';

// Shared notification/evaluation vocabulary. CVE matching is intentionally separate.
export const referenceId = z.string().regex(/^[A-Za-z0-9:_-]{1,180}$/);
export const timestamp = z.iso.datetime({offset:true});
export const calendarDate = z.iso.date();
export const assessmentStatus = z.enum(['affected', 'not_affected', 'unknown']);
export const evidenceSchema = z.object({
  id: referenceId, source: z.string().min(1).max(256), extractor: z.string().min(1).max(128),
  confidence: z.enum(['confirmed','inferred','ambiguous']),
}).strict();
export const noticeMetadata = z.object({
  schemaVersion: z.literal(1), id: referenceId, revision: referenceId, updatedAt: timestamp,
  evidence: z.array(evidenceSchema).max(16),
}).strict();
export interface AssessmentIdentity {
  noticeId: string;
  noticeRevision: string;
  snapshotId: string;
  asOf: string;
}
export type AssessmentStatus = z.infer<typeof assessmentStatus>;
export type Evidence = z.infer<typeof evidenceSchema>;
export interface AssessmentPage<TItem, TGap> extends AssessmentIdentity {
  schemaVersion:1;
  kind:'eol'|'vulnerability';
  status:AssessmentStatus;
  complete:boolean;
  counts:Record<AssessmentStatus,number>;
  total:number;
  items:TItem[];
  limit:number;
  offset:number;
  hasMore:boolean;
  nextOffset:number|null;
  truncated:boolean;
  gaps:TGap[];
}
export interface NoticeSource<T> {
  getNotice(tenant: string, workspace: string, id: string, signal?: AbortSignal): Promise<T | undefined>;
}
export interface SnapshotSource<T> {
  getSnapshot(tenant: string, workspace: string, id: string, signal?: AbortSignal): Promise<T | undefined>;
}
