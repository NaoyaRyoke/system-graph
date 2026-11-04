from pathlib import Path
import json
A=Path(__file__).resolve().parents[1]/'artifacts'
inventory=json.loads((A/'license-inventory.json').read_text())
unknown=[{'name':p['name'],'version':p['version']}for p in inventory if p['unknown']]
print(json.dumps({'unknown_licenses':unknown,'inventory_only':'OS/native notices and distribution obligations remain a release review'}))
raise SystemExit(1 if unknown else 0)
