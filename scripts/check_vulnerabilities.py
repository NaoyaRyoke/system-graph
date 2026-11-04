"""Fail closed on scan errors, new findings, stale evidence or unresolved exposure."""
from pathlib import Path
import json,sys,datetime,hashlib
R=Path(__file__).resolve().parents[1];A=R/'artifacts'
app=json.loads((A/'osv.json').read_text(encoding='utf8'))
osfile=A/'os-vulnerabilities.json';errors=list(app['errors']);blocking=[];raw={}
if osfile.exists():
 scan=json.loads(osfile.read_text(encoding='utf8'));raw=scan['severity_counts'];errors+=scan['errors']
 reviewfile=R/'docs/os-advisory-review.json';manifest=A/'runtime-manifest.json'
 if not reviewfile.exists()or not manifest.exists():errors.append('OS review/manifest missing')
 else:
  review=json.loads(reviewfile.read_text(encoding='utf8'));rows={r['id']:r for r in review['reviews']}
  if datetime.date.fromisoformat(review['review_before'])<datetime.date.today():errors.append('OS review expired')
  if hashlib.sha256(manifest.read_bytes()).hexdigest()!=review['runtime_manifest_sha256']:errors.append('runtime evidence changed; reassess')
  for v in scan['advisories']:
   row=rows.get(v['id'])
   if row is None or row['disposition'] not in ['FIX','FIXED','NOT AFFECTED','ACCEPT FOR BETA','ACCEPTED WITH EVIDENCE']:blocking.append(v['id'])
   elif not row.get('evidence')or not row.get('mitigation_and_rationale'):blocking.append(v['id'])
elif '--require-os'in sys.argv:errors.append('OS scan missing')
print(json.dumps({'application_advisories':len(app['advisories']),'raw_OS_counts':raw,'OS_blockers':blocking,'errors':errors}))
raise SystemExit(1 if app['advisories']or errors or blocking else 0)
