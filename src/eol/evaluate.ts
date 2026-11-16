import { eolNoticeSchema, eolSnapshotSchema, evaluationOptionsSchema, numericVersion, compareNumeric,
  type EolNotice, type EolAsset, type EolAssetAssessment, type EolAssessment, type EvaluationOptions } from './model.js';

function assessAsset(notice:EolNotice, asset:EolAsset, asOf:string, maxAgeDays:number):EolAssetAssessment {
  const row:EolAssetAssessment={
    assetId:asset.id, repositoryId:asset.repositoryId, environment:asset.environment,
    product:asset.product,vendor:asset.vendor,releaseLine:asset.releaseLine,version:asset.version,
    supportTier:asset.support.tier,ownerTeam:asset.ownerTeam,observedAt:asset.observedAt,supportConditions:[],
    status:'unknown',reason:'insufficient_information',deadline:null,missing:[],
    path:[{kind:'asset',id:asset.id},
      ...(asset.artifactId?[{kind:'artifact' as const,id:asset.artifactId}]:[]),
      ...(asset.deploymentId?[{kind:'deployment' as const,id:asset.deploymentId}]:[]),
      ...(asset.serviceId?[{kind:'service' as const,id:asset.serviceId}]:[])], evidence:asset.evidence,
  };
  const finish=(status:EolAssetAssessment['status'],reason:string)=>({...row,status,reason});
  const age=Date.parse(asOf)-Date.parse(asset.observedAt);
  if(age<0)row.missing.push('observation_at_or_before_asOf');
  if(age>maxAgeDays*86400000)row.missing.push('fresh_observation');
  if(!asset.evidence.length||asset.evidence.some(e=>e.confidence!=='confirmed'))row.missing.push('confirmed_asset_evidence');
  if(!notice.evidence.length||notice.evidence.some(e=>e.confidence!=='confirmed'))row.missing.push('confirmed_notice_evidence');
  if(Date.parse(notice.updatedAt)>Date.parse(asOf))row.missing.push('notice_at_or_before_asOf');
  if(row.missing.length)return row;
  for(const key of ['product','vendor','releaseLine'] as const) {
    // An explicit identity mismatch excludes this notification even if other fields are absent.
    if(asset[key]!==null&&asset[key]!==notice[key])return finish('not_affected',`${key}_mismatch`);
  }
  for(const key of ['product','vendor','releaseLine','version'] as const)if(asset[key]===null)row.missing.push(key);
  if(row.missing.length)return row;
  const version=asset.version!;
  if(notice.versions.scheme==='numeric') {
    if(!numericVersion.safeParse(version).success){row.missing.push('supported_numeric_version');return row;}
    if(compareNumeric(version,notice.versions.from)<0||compareNumeric(version,notice.versions.until)>=0)return finish('not_affected','version_outside_range');
  } else if(!notice.versions.values.includes(version))return finish('not_affected','version_not_listed');
  const policy=notice.policies.find(p=>p.tier===asset.support.tier);
  if(!policy){row.missing.push(asset.support.tier===null?'support.tier':'notice.policy_for_support_tier');return row;}
  row.deadline=policy.endsOn;
  row.supportConditions=policy.requiredConditions.map(condition=>({condition,value:asset.support.conditions[condition]??null}));
  for(const condition of policy.requiredConditions) {
    if(asset.support.conditions[condition]!==true)row.missing.push(`support.conditions.${condition}`);
  }
  if(row.missing.length)return finish('unknown','support_conditions_unconfirmed');
  if(policy.endsOn===null){row.missing.push('notice.support_deadline');return row;}
  // endsOn is inclusive. Compare UTC dates, independent of the caller's timezone offset.
  const today=new Date(asOf).toISOString().slice(0,10);
  return today>policy.endsOn?finish('affected','support_ended'):finish('not_affected','support_active');
}

/** Evaluate already normalized inventory. No I/O, MCP, Rust or implicit version coercion. */
export function evaluateEol(rawNotice:unknown,rawSnapshot:unknown,rawOptions:EvaluationOptions):EolAssessment {
  const notice=eolNoticeSchema.parse(rawNotice),snapshot=eolSnapshotSchema.parse(rawSnapshot),options=evaluationOptionsSchema.parse(rawOptions);
  const rows=snapshot.assets.map(asset=>{
    const row=assessAsset(notice,asset,options.asOf,options.maxAgeDays);
    // Product matching and service attribution are separate facts. A known EOL asset
    // stays affected even when its owning service or team still needs investigation.
    if(asset.serviceId===null)row.missing.push('serviceId');
    if(asset.ownerTeam===null)row.missing.push('ownerTeam');
    return row;
  })
    .sort((a,b)=>a.assetId<b.assetId?-1:a.assetId>b.assetId?1:0);
  const gaps:EolAssessment['gaps']=snapshot.coverage.map(g=>({...g}));
  const age=Date.parse(options.asOf)-Date.parse(snapshot.collectedAt);
  if(age<0)gaps.push({reason:'snapshot_from_future'});
  if(age>options.maxAgeDays*86400000)gaps.push({reason:'stale_snapshot'});
  if(!rows.length)gaps.push({reason:'no_observed_assets'});
  const counts={affected:0,not_affected:0,unknown:0};
  for(const row of rows)counts[row.status]++;
  const complete=gaps.length===0&&counts.unknown===0&&rows.every(row=>row.missing.length===0);
  const status=counts.affected?'affected':!complete?'unknown':'not_affected';
  const items=rows.slice(options.offset,options.offset+options.limit),hasMore=options.offset+items.length<rows.length;
  return {schemaVersion:1,kind:'eol',noticeId:notice.id,noticeRevision:notice.revision,snapshotId:snapshot.id,
    asOf:options.asOf,noticeUpdatedAt:notice.updatedAt,noticeEvidence:notice.evidence,snapshotCollectedAt:snapshot.collectedAt,
    criteria:{product:notice.product,vendor:notice.vendor,releaseLine:notice.releaseLine,versions:notice.versions,policies:notice.policies},
    maxAgeDays:options.maxAgeDays,status,complete,counts,total:rows.length,items,limit:options.limit,offset:options.offset,
    hasMore,nextOffset:hasMore?options.offset+items.length:null,truncated:false,gaps};
}
