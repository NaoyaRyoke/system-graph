"""Copy only release source into a NEW directory; never include local build state."""
from pathlib import Path
import sys,hashlib,json,shutil,zipfile
R=Path(__file__).resolve().parents[1]
def source_files():
    folders=['src','rust-host/src','vendor','tests','scripts','docs','docker','examples','.github','.cargo','licenses']
    roots=['package.json','package-lock.json','tsconfig.json','rust-toolchain.toml','.node-version','.gitignore','.dockerignore','Dockerfile','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES','README.md','SECURITY.md','CONTRIBUTING.md','VENDOR.md','rust-host/Cargo.toml','rust-host/Cargo.lock']
    found={R/n for n in roots}
    for name in folders:found.update(p for p in (R/name).rglob('*')if p.is_file()and '__pycache__'not in p.parts)
    for p in found:
        if p.is_symlink()or p.suffix in ['.db','.pem','.key','.exe','.png','.jpg']:raise ValueError('unexpected release artifact')
    return sorted(found)
if __name__=='__main__':
    destination=Path(sys.argv[1]).resolve()
    if destination.exists()or destination==R or R in destination.parents:raise SystemExit('destination must be a new directory outside source')
    destination.mkdir(parents=True)
    manifest={}
    for p in source_files():
        rel=p.relative_to(R);target=destination/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target);manifest[rel.as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
    (destination/'SOURCE_SHA256SUMS.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'files':len(manifest),'source_only':True}))
