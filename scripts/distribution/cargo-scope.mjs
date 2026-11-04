// Select a target-filtered Cargo normal/build closure, never the entire lockfile.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function selectBuildPackages(metadata, rootName = 'hybrid-engine-host') {
  if (!metadata.resolve?.nodes || !Array.isArray(metadata.packages)) throw Error('Cargo resolve graph required');
  const roots = metadata.packages.filter(p => p.name === rootName);
  if (roots.length !== 1) throw Error('exactly one Cargo build root required');
  const nodes = new Map(metadata.resolve.nodes.map(n => [n.id,n]));
  const seen = new Set(), pending = [roots[0].id];
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    const node = nodes.get(id);
    if (!node || !Array.isArray(node.deps)) throw Error('incomplete Cargo resolve graph');
    seen.add(id);
    for (const dep of node.deps) {
      if (!Array.isArray(dep.dep_kinds)) throw Error('Cargo dependency kinds required');
      if (dep.dep_kinds.some(k => k.kind === null || k.kind === 'normal' || k.kind === 'build')) pending.push(dep.pkg);
    }
  }
  const packages = metadata.packages.filter(p => seen.has(p.id));
  if (packages.length !== seen.size) throw Error('Cargo package missing from metadata');
  return packages;
}

export function publicBuildPackages(metadata) {
  const packages = selectBuildPackages(metadata);
  if (packages.some(p => ['pratt','hcl-edit','hcl-rs'].includes(p.name))) throw Error('Public Beta build must exclude Terraform/HCL dependencies');
  const ids = new Set(packages.map(p => p.id));
  if (metadata.resolve.nodes.some(n => ids.has(n.id) && (n.features ?? []).includes('terraform'))) throw Error('Public Beta build must disable terraform feature');
  return packages;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const packages = publicBuildPackages(metadata);
  process.stdout.write(JSON.stringify({packages,scope:'target-filtered normal/build closure; optional/full-source inventory is separate'}));
}
