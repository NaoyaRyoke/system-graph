"""Release-only fingerprint regression: runtime changes must still fail closed."""
from pathlib import Path
import copy, datetime, hashlib, json, shutil, subprocess, sys, tempfile, unittest

ROOT = Path(__file__).resolve().parents[1]

class ReleaseEvidence(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for part in ['scripts', 'docs', 'artifacts']:
            (self.root / part).mkdir()
        shutil.copyfile(ROOT / 'scripts/check_vulnerabilities.py', self.root / 'scripts/check_vulnerabilities.py')
        self.manifest = {
            'nodeVersions': {'node': '24.22.2'},
            'packages': [{'name': 'libc6', 'version': 'fixture-version'}],
            'files': [{'path': '/app/engine', 'sha256': '0' * 64}],
            'linkage': [{'path': '/app/engine', 'imports': ['bounded_fixture']}],
            'nativeEvidence': {'engineLinkMapSha256': 'a' * 64, 'rustSqlite': '3.54.1'},
        }
        stable = copy.deepcopy(self.manifest)
        stable['nativeEvidence'].pop('engineLinkMapSha256')
        self.review = {
            'review_before': '2099-01-01', 'reviews': [],
            'runtime_manifest_sha256': hashlib.sha256(json.dumps(self.manifest).encode()).hexdigest(),
            'runtime_fingerprint_version': 'manifest-v1-without-volatile-link-map',
            'runtime_security_fingerprint_sha256': hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
        }
        (self.root / 'artifacts/osv.json').write_text(json.dumps({'errors': [], 'advisories': []}))
        (self.root / 'artifacts/os-vulnerabilities.json').write_text(json.dumps({'severity_counts': {}, 'errors': [], 'advisories': []}))

    def check(self, expected):
        (self.root / 'artifacts/runtime-manifest.json').write_text(json.dumps(self.manifest), encoding='utf8')
        (self.root / 'docs/os-advisory-review.json').write_text(json.dumps(self.review), encoding='utf8')
        r = subprocess.run([sys.executable, 'scripts/check_vulnerabilities.py', '--require-os'], cwd=self.root, capture_output=True)
        self.assertEqual(r.returncode, expected, r.stdout.decode())

    def test_exact_manifest(self): self.check(0)
    def test_linker_temp_evidence_only(self):
        self.manifest['nativeEvidence']['engineLinkMapSha256'] = 'b' * 64
        self.check(0)
    def test_missing_link_map(self):
        del self.manifest['nativeEvidence']['engineLinkMapSha256']
        self.check(1)
    def test_malformed_link_map(self):
        self.manifest['nativeEvidence']['engineLinkMapSha256'] = 'invalid'
        self.check(1)
    def test_engine_bytes_change(self):
        self.manifest['files'][0]['sha256'] = '1' * 64
        self.check(1)
    def test_node_version_change(self):
        self.manifest['nodeVersions']['node'] = 'different'
        self.check(1)
    def test_os_package_change(self):
        self.manifest['packages'][0]['version'] = 'different'
        self.check(1)
    def test_import_change(self):
        self.manifest['linkage'][0]['imports'].append('new_execution_surface')
        self.check(1)
    def test_native_component_change(self):
        self.manifest['nativeEvidence']['rustSqlite'] = 'different'
        self.check(1)
    def test_legacy_exact_binding(self):
        self.review.pop('runtime_fingerprint_version')
        self.review.pop('runtime_security_fingerprint_sha256')
        self.check(0)

if __name__ == '__main__': unittest.main()
