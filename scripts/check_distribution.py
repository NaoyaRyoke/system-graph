"""Distribution-license gate; private reporting requires separate maintainer verification."""
from pathlib import Path
import json, sys
R = Path(__file__).resolve().parents[1]
file = R / 'artifacts/distribution-license-inventory.json'
if not file.exists():
    raise SystemExit('BLOCKER: actual image license evidence missing')
inventory = json.loads(file.read_text(encoding='utf8'))
missing = inventory.get('missing', [])
unresolved = inventory.get('unresolved', [])
print(json.dumps({'missing_license_evidence': missing, 'unresolved_redistribution': unresolved,
                  'missing_required_text': sum(p.get('name') == 'pratt' for p in unresolved),
                  'private_reporting_operational': 'USER ACTION REQUIRED: enable and verify PVR before beta release; technical strategy B is documented'}))
# No repository exists yet. A local document cannot assert that PVR is enabled.
raise SystemExit(1 if missing or unresolved else 0)
