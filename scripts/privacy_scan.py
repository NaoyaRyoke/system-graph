"""Fail closed on known release identifiers and credential formats. No raw matches printed."""
from pathlib import Path
import re,json,sys,hashlib
R=Path(__file__).resolve().parents[1]
ignore={'node_modules','target','dist','artifacts','.git','.local','__pycache__'}
# Supply deployment-specific deny terms out of band, not in the candidate source.
terms=sys.argv[1:]
patterns={'private_key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----','provider_token':r'(?:ghp_[A-Za-z0-9]{30,}|tskey-auth-[A-Za-z0-9_-]{20,})','JWT':r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}','home_path':r'(?:[A-Za-z]:[\\/]+Users[\\/]+|/home/|/Users/)[a-zA-Z0-9_.-]+','tailnet_domain':r'[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net'}
findings=[];files=0;checksums={};allowances=[]
allow_file=R/'scripts/privacy_allowances.json'
reviewed=json.loads(allow_file.read_text(encoding='utf8'))if allow_file.exists()else{}
for path in R.rglob('*'):
    if not path.is_file() or any(s in ignore for s in path.relative_to(R).parts):continue
    rel=path.relative_to(R).as_posix();raw=path.read_bytes();files+=1;checksums[rel]=hashlib.sha256(raw).hexdigest()
    if path.suffix in ['.db','.pem','.key','.pfx','.png','.jpg','.exe']:findings.append({'path':rel,'category':'forbidden_artifact'});continue
    text=raw.decode('utf8',errors='replace')
    for name,pattern in patterns.items():
        # These two test files deliberately test anonymous synthetic path rejection.
        if name=='home_path' and rel in ['tests/boundaries.test.ts','src/redaction.ts','scripts/privacy_scan.py']:continue
        if re.search(pattern,text,re.I):
            allowance=reviewed.get(rel,{})
            if allowance.get('category')==name and allowance.get('sha256')==checksums[rel]:allowances.append({'path':rel,'category':name,'reason':allowance['reason']})
            else:findings.append({'path':rel,'category':name})
    for term in terms:
        if re.search(re.escape(term),text,re.I):findings.append({'path':rel,'category':'operator_deny_term'})
print(json.dumps({'files':files,'findings':findings,'known_pattern_only':True,'reviewed_legal_text_false_positives':allowances}))
if '--manifest' in terms:raise SystemExit('manifest flag is not a deny term')
if findings:raise SystemExit(1)
