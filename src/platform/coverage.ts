import { z } from 'zod';
import { id } from '../contracts.js';
import { referenceId } from '../assessments/model.js';

export const environmentSchema=id.refine(v=>v!=='unknown','unknown environments use null').nullable();
export const issueScopeSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('repository')}).strict(),
  z.object({kind:z.literal('artifact'),artifactId:referenceId.optional(),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()}).strict().refine(s=>!!s.artifactId||!!s.digest,'artifact identity required'),
  z.object({kind:z.literal('deployment'),deploymentId:referenceId}).strict(),
]);
export const coverageIssueSchema=z.object({repositoryId:id,environment:environmentSchema,
  reason:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),source:z.string().max(256),appliesTo:issueScopeSchema.optional(),
}).strict().transform(issue=>{
  // Legacy artifact failures carried no identity. They cannot prove any affected
  // repository artifact healthy; recollection is required to attribute them.
  if(!issue.appliesTo&&issue.environment===null&&['unsupported_or_invalid_sbom','artifact_collection_failed'].includes(issue.reason))
    return {...issue,appliesTo:{kind:'repository' as const}};
  return issue;
});
export type CoverageIssue=z.infer<typeof coverageIssueSchema>;
export interface CoverageTarget {repositoryId:string;environment:string|null;artifactId?:string|null|undefined;artifactDigest?:string|null|undefined;deploymentId?:string|null|undefined}
export function issueApplies(issue:Pick<CoverageIssue,'repositoryId'|'environment'|'appliesTo'>,target:CoverageTarget):boolean {
  if(issue.repositoryId!==target.repositoryId)return false;
  const scope=issue.appliesTo;
  if(!scope)return issue.environment===target.environment;
  if(scope.kind==='repository')return true;
  if(scope.kind==='deployment')return scope.deploymentId===target.deploymentId;
  return !!scope.artifactId&&scope.artifactId===target.artifactId||!!scope.digest&&scope.digest===target.artifactDigest;
}
export function visibleIssue(issue:CoverageIssue,scope:{repositories:readonly string[];environments:readonly string[]},targets:readonly CoverageTarget[]):boolean {
  if(!scope.repositories.includes(issue.repositoryId))return false;
  if(!issue.appliesTo)return scope.environments.includes(issue.environment??'unknown');
  return issue.appliesTo.kind==='repository'||targets.some(t=>issueApplies(issue,t));
}
