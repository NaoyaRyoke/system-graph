# Feature 3: components, artifacts and observed runtime

APIs: `importCycloneDx(raw, metadata)`, `ingestRuntime(source, artifacts, options)`,
`connectComposition(graph, composition)`, `scopeComposition`, `compositionToEol`.
Types: `Artifact`, `Component`, `Deployment`, `CompositionSnapshot`.
Port: `RuntimeSource.read(signal)`. Artifact acquisition uses `ArtifactSource`.

```ts
import { importCycloneDx, ingestRuntime } from 'system-graph-remote/platform';
const artifact = importCycloneDx(sbomJson, buildMetadata);
const snapshot = await ingestRuntime(runtimeSource, [artifact], {
  snapshotId: 'snapshot-next', asOf: '2026-11-16T00:00:00Z',
});
```

Initial SBOM support is **CycloneDX 1.6 JSON**, not the tool's own supply-chain
script output. Components (including a metadata root) retain exact versions,
unqualified PURLs, dependency scope, root distance and relationships. Nested
components are flattened with depth/count limits. Dependencies omitted for a
component remain opaque; missing completeness declarations, references, package
identifiers, versions, unsupported services or partial compositions remain gaps.
Unknown top-level descriptive metadata is not interpreted as runtime evidence.
The importer handles the stated subset; it is not a complete CycloneDX schema validator.

Build metadata binds immutable artifact ID/digest, source repository/revision,
image and evidence. Source-file nodes have a separate kind. Runtime records name
environment/cluster/account/namespace, observed digest, service and team.
Deployment IDs incorporate these scope dimensions; duplicate unknown identities
are rejected, not merged. Tags do not resolve an artifact. Digest ambiguity or
declaration-only runtime remains incomplete. Different versions have different
component node identities, even when the package name is equal.

`products` supplies normalized installed product/support data for EOL; a missing
product inventory is a gap. The application normalizer must supply authoritative
product/vendor/series/entitlement facts rather than infer them from a package name.
Historical digest-bound artifacts remain available through coordinator refreshes,
so a new build does not erase an old production deployment.

Scope filtering exposes only artifacts bound to allowed observed deployments;
the trusted pure API can also examine artifacts not currently deployed. A common
component never authorizes an unrelated environment's artifact. Immutable SBOM
evidence need not be recreated merely because a build is old; current runtime
evidence must still verify that digest is actually deployed.

Tests: `node --test dist/tests/platform-composition.test.js`; synthetic SBOM:
`examples/platform-sbom.json`; runtime fixtures: `tests/platform-fixtures.ts`.
MCP: `graph_inventory`, `graph_explain`, `graph_vulnerability`, `graph_eol`.
Reference: [CycloneDX 1.6 JSON](https://cyclonedx.org/docs/1.6/json/).
