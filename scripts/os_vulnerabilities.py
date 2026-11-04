from pathlib import Path
import json,urllib.request,datetime,concurrent.futures,math
A=Path(__file__).resolve().parents[1]/'artifacts'
inventory=json.loads((A/'container-packages.json').read_text())
packages=sorted({(p['source']or p['name'],p['sourceVersion']or p['version'])for p in inventory['packages']})
queries=[{'package':{'name':name,'ecosystem':'Debian:'+inventory['osVersion']},'version':version}for name,version in packages]
errors=[];findings=[]
try:
    request=urllib.request.Request('https://api.osv.dev/v1/querybatch',data=json.dumps({'queries':queries}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=30)as response:results=json.load(response)['results']
    for query,result in zip(queries,results,strict=True):
        if result.get('vulns'):findings.append({'package':query,'advisories':result['vulns']})
except Exception as e:errors.append(type(e).__name__)
def severity(value):
    specific=value.get('database_specific',{}).get('severity','').upper()
    if specific in ['CRITICAL','HIGH','MODERATE','MEDIUM','LOW']:return 'medium'if specific=='MODERATE'else specific.lower()
    for s in value.get('severity',[]):
        if s['type']not in ['CVSS_V3','CVSS_V4']:continue
        # V4 is deliberately left unclassified without a complete scorer.
        if s['type']=='CVSS_V4':continue
        try:
            v=dict(x.split(':',1)for x in s['score'].split('/')[1:]);changed=v['S']=='C'
            isc=1-math.prod(1-{'N':0,'L':.22,'H':.56}[v[k]]for k in ['C','I','A'])
            impact=7.52*(isc-.029)-3.25*(isc-.02)**15 if changed else 6.42*isc
            exploit=8.22*{'N':.85,'A':.62,'L':.55,'P':.2}[v['AV']]*{'L':.77,'H':.44}[v['AC']]*({'N':.85,'L':.68,'H':.5}if changed else{'N':.85,'L':.62,'H':.27})[v['PR']]*{'N':.85,'R':.62}[v['UI']]
            score=0 if impact<=0 else math.ceil(min((impact+exploit)*(1.08 if changed else 1),10)*10)/10
            return 'critical'if score>=9 else'high'if score>=7 else'medium'if score>=4 else'low'
        except (KeyError,ValueError):pass
    return 'unrated'
def detail(identity):
    try:
        with urllib.request.urlopen('https://api.osv.dev/v1/vulns/'+identity,timeout=20)as response:v=json.load(response)
        return {'id':identity,'aliases':v.get('aliases',[]),'summary':v.get('summary'),'severity':severity(v),'severity_evidence':v.get('severity',[]),'database_specific':v.get('database_specific',{})}
    except Exception as e:return {'id':identity,'severity':'unrated','error':type(e).__name__}
with concurrent.futures.ThreadPoolExecutor(max_workers=6)as pool:
    details=list(pool.map(detail,sorted({v['id']for p in findings for v in p['advisories']})))
counts={key:sum(d['severity']==key for d in details)for key in ['critical','high','medium','low','unrated']}
(A/'os-vulnerabilities.json').write_text(json.dumps({'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':inventory['image'],'packages_queried':len(queries),'findings':findings,'advisories':details,'severity_counts':counts,'errors':errors,'limitation':'Debian source-package/version matching only; Node binary bundled native libraries and exploitability require separate review'},indent=2))
print(json.dumps({'packages':len(queries),'affected':len(findings),'severity':counts,'errors':errors}))
