"""Query public package/version advisory metadata only. No credentials or source uploads."""
from pathlib import Path
import json,urllib.request,datetime
R=Path(__file__).resolve().parents[1];A=R/'artifacts'
inventory=json.loads((A/'license-inventory.json').read_text())
queries=[{'package':{'name':p['name'],'ecosystem':'crates.io' if p['ecosystem']=='cargo' else 'npm'},'version':p['version']} for p in inventory]
result=[];errors=[]
for index in range(0,len(queries),100):
    batch=queries[index:index+100]
    try:
        req=urllib.request.Request('https://api.osv.dev/v1/querybatch',data=json.dumps({'queries':batch}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30)as response:data=json.load(response)
        for q,r in zip(batch,data['results'],strict=True):
            if r.get('vulns'):result.append({'package':q,'advisories':r['vulns']})
    except Exception as e:errors.append({'batch':index,'kind':type(e).__name__})
full=[]
for identity in sorted({v['id']for r in result for v in r['advisories']}):
    try:
        with urllib.request.urlopen('https://api.osv.dev/v1/vulns/'+identity,timeout=20)as response:v=json.load(response)
        full.append({'id':identity,'aliases':v.get('aliases',[]),'summary':v.get('summary'),'severity':v.get('severity',[]),'database_specific':v.get('database_specific',{}),'affected':v.get('affected',[])})
    except Exception as e:errors.append({'id':identity,'kind':type(e).__name__})
(A/'osv.json').write_text(json.dumps({'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'packages_queried':len(queries),'findings':result,'advisories':full,'errors':errors,'coverage':'npm/Cargo package-version matching; OS/container and exploitability review separate'},indent=2),encoding='utf8')
print(json.dumps({'queried':len(queries),'affected_packages':len(result),'advisories':len(full),'errors':len(errors)}))
