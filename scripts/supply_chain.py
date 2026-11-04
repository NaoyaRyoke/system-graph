"""Generate a CycloneDX inventory and license evidence; never upload source code."""
from pathlib import Path
import json,subprocess,sys,datetime,hashlib
R=Path(__file__).resolve().parents[1];A=R/'artifacts';A.mkdir(exist_ok=True)
if len(sys.argv)>1:metadata=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
else:
    host=next(line.split(': ',1)[1] for line in subprocess.check_output(['rustc','-vV'],text=True).splitlines() if line.startswith('host: '))
    metadata=json.loads(subprocess.check_output(['cargo','metadata','--manifest-path',str(R/'rust-host/Cargo.toml'),'--locked','--format-version','1','--filter-platform',host],cwd=R))
components=[];licenses=[]
def add(ecosystem,name,version,license_value):
    license_value=license_value or 'NOASSERTION'
    purl=f'pkg:{ecosystem}/{name.replace("@","%40")}@{version}'
    licenses.append({'ecosystem':ecosystem,'name':name,'version':version,'license':license_value,'notice':'retain license/copyright; review expression and bundled notices','unknown':license_value=='NOASSERTION'})
    if not any(c['bom-ref']==purl for c in components):
        components.append({'type':'library','name':name,'version':version,'purl':purl,'bom-ref':purl,'licenses':[{'license':{'name':license_value}}]})
selected=json.loads(subprocess.check_output(['node',str(R/'scripts/distribution/cargo-scope.mjs'),str(Path(sys.argv[1]).resolve())],cwd=R)) if len(sys.argv)>1 else None
if selected is None:
    raw=A/'cargo-build-metadata.json';raw.write_text(json.dumps(metadata),encoding='utf8')
    selected=json.loads(subprocess.check_output(['node',str(R/'scripts/distribution/cargo-scope.mjs'),str(raw)],cwd=R))
for p in selected['packages']:add('cargo',p['name'],p['version'],p.get('license'))
lock=json.loads((R/'package-lock.json').read_text())
for path,p in lock['packages'].items():
    if not path:continue
    name=p.get('name') or path.rsplit('node_modules/',1)[-1]
    installed=R/path/'package.json'
    package=json.loads(installed.read_text(encoding='utf8')) if installed.exists() else {}
    lic=p.get('license') or package.get('license')
    if isinstance(lic,dict):lic=lic.get('type')
    add('npm',name,p['version'],lic)
bom={'bomFormat':'CycloneDX','specVersion':'1.5','version':1,'metadata':{'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'component':{'type':'application','name':'system-graph-remote','version':'0.1.0-beta.1'}},'components':components,'dependencies':[{'ref':c['bom-ref'],'dependsOn':[]} for c in components],'properties':[{'name':'completeness','value':'npm/Cargo inventory; dependency edges and OS packages require separate enrichment'}]}
(A/'sbom.cdx.json').write_text(json.dumps(bom,indent=2),encoding='utf8')
(A/'license-inventory.json').write_text(json.dumps(licenses,indent=2),encoding='utf8')
rows=['# Dependency license inventory','','Generated from locked Cargo metadata and installed npm package metadata. This is a technical inventory, not a legal opinion. Bundled native/OS code is reviewed separately.','','| ecosystem | dependency | version | license |','|---|---|---|---|']
rows += [f"| {p['ecosystem']} | {p['name']} | {p['version']} | {p['license']} |" for p in licenses]
(R/'docs/license-inventory.md').write_text('\n'.join(rows)+'\n',encoding='utf8')
print(json.dumps({'components':len(components),'unknown':sum(p['unknown'] for p in licenses),'sbom':'CycloneDX 1.5'}))
