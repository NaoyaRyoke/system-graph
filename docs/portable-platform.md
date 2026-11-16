# Portable TypeScript platform: features 1–6

This is the transferable implementation of the requested six features. It operates
without Rust, an MCP process, external credentials, or a database server. MCP is a
read adapter over the same exported APIs. The native SQLite/Rust implementation
remains a compatibility/comparison path with its original contract; it is not
required by the portable features and is not a fallback for unsupported inputs.

The starting branch was `refactor/company-mcp-template` at `67e7bc8`. Existing EOL
work was preserved. The implementation adds the graph core, source ingestion,
composition, vulnerability evaluation and workflow around that EOL implementation.
Repository publication is separate from validation. No deployment or real external
data connection is part of this implementation.

## Build and verify

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm run test:portable
npm run sample:portable
```

`test:portable` builds and runs only the TypeScript API and portable MCP tests. It
never generates native graph fixtures or builds/starts Rust. If npm is not on PATH,
the equivalent commands are:

```sh
node node_modules/typescript/bin/tsc
node scripts/build-entry.mjs
node scripts/test-portable.mjs
node scripts/sample-platform.mjs
```

The sample command writes a new synthetic config under ignored `artifacts/` and
prints its absolute path. It does not overwrite an existing file. Start the server:

```sh
node dist/index.js --platform ABSOLUTE_CONFIG_PATH
```

The config contains absolute roots for the checked-in synthetic source repositories,
two digest-bound build artifacts, CycloneDX data, observed production/staging
deployments, and fixed CVE/EOL notices. It has no usable external credential.
The source roots are checkout resources; the sample command is not a packaged
production data acquisition service. `--eol` remains available for the smaller
standalone EOL adapter.

## APIs and responsibilities

Import from `system-graph-remote/platform` or `dist/src/platform/index.js`.
Declarations are emitted by the build. The core export starts no MCP server.

| Feature | Public API | Transfer guide |
| --- | --- | --- |
| 1. Evidence-based impact | `scopeGraph`, `impact`, `trace` | [01-impact](transfer/01-impact.md) |
| 2. Source ingestion/update | `collectRepositories`, `LocalRepositorySource`, `GitRepositorySource` | [02-sources](transfer/02-sources.md) |
| 3. Component/artifact/runtime | `importCycloneDx`, `ingestRuntime`, `connectComposition` | [03-composition](transfer/03-composition.md) |
| 4. CVE matching | `evaluateVulnerability` | [04-vulnerability](transfer/04-vulnerability.md) |
| 5. EOL matching | `evaluateEol`, `compositionToEol` | [EOL guide](eol-transfer.md) |
| 6. Reevaluation/workflow | `reevaluateNotice`, `transitionWork`, `SystemCoordinator.refresh` | [06-remediation](transfer/06-remediation.md) |

Source, artifact, runtime and notification providers are independent ports.
`SnapshotStore`, `WorkStore` and `JobRunner` isolate persistence and execution.
`MemorySnapshotStore`/`FileSnapshotStore`, `MemoryWorkStore`/`FileWorkStore` and
`InlineJobs` support personal local verification. `PolicyEngine`, `AuthContext` and
`ServiceHooks` supply the existing authorization, audit, rate limit and metrics
boundaries. External databases, GitHub fetching, cloud/cluster queries, live
advisory feeds, enterprise authentication, distributed scheduling, ticketing and
outbound notifications must be connected through these interfaces at transfer.

`SystemCoordinator.refresh` collects sources, preserves previous evidence on
collection failure, retains historical immutable artifacts, ingests observed
runtime, stores a new snapshot and reevaluates notices. A notification-fetch failure
is an error; it does not silently close existing work. Refresh/workflow writes are
application APIs. MCP exposes read tools only.

## MCP contract

`--platform` serves ten tools: `graph_capabilities`, `graph_inventory`,
`graph_query`, `graph_impact`, `graph_trace`, `graph_explain`,
`graph_vulnerability`, `graph_eol`, `graph_remediation` and `graph_remediation_history`.
Capabilities identify `portable-2`, `workSchema: 2`, `inventoryContract: 2` and
`implementation: typescript`.
The native v1 response schema is not silently reused for these richer results.

```json
{"workspace":"main","snapshotId":"sample-snapshot-a","asOf":"2026-11-16T00:00:00Z","target":"service-b","limit":20,"offset":0}
```

Use that input for `graph_impact`; use source/destination instead of target for
`graph_trace`. Inventory/query return IDs for other calls. The sample CVE request is:

```json
{"workspace":"main","snapshotId":"sample-snapshot-a","asOf":"2026-11-16T00:00:00Z","noticeId":"cve-test-a","noticeRevision":"r1","limit":20,"offset":0}
```

For EOL change the notice ID to `eol-test-a`. Remediation listing needs only
`workspace`, optional `noticeId`, and pagination. The sample returns an affected old
production artifact and a fixed staging artifact; it preserves component paths,
evidence, observation time and advisory revision. Exploitability is not inferred
from component membership. Update/stop impact candidates are a separate result.

Use command `node` with arguments `[ABSOLUTE_DIST_INDEX, "--platform", ABSOLUTE_CONFIG]`
in the local MCP client. Both legacy and modern MCP protocol tests exercise this
actual process from another working directory. No engine argument is accepted or
needed. To embed in another server, import `createPlatformServer` or
`registerPlatformTools` from `system-graph-remote/platform/mcp` and provide a
`PlatformQueryService`, authenticated principal and abort signal. Existing Remote
factories require explicit integration with this adapter; no anonymous Remote
endpoint is added by the local launcher.

Every call authorizes before reading providers. EOL, CVE and remediation reads use
the existing inventory read permission; graph operations retain their respective
permissions. Repository aliases resolve through operator registration. Shared
identities need an evidenced path to an authorized owned node. Build artifacts need
an allowed runtime anchor, so a common package cannot pull a staging artifact into
a production-only response. Unknown environments use null and require the explicit
`unknown` permission. They are never classified as production.

Request frames remain 16 KiB; responses remain 256 KiB. Pages contain at most 50
rows. Graph traversal has explicit depth/node/edge bounds, separate from result
paging. Inventory edges have their own `edgePaging`, `edgeOffset` and `edgeLimit`;
their domain is the whole authorized graph, independently of the node page. Query
edges cover the induced graph over all matching nodes. Use `edgeOffset: null` after
the edge stream finishes while continuing node pages. References can point to nodes
on another page. CVE artifact
pages use the same offset/limit with `artifactsNextOffset`; follow each continuation
independently. Evidence-heavy single rows may still hit `response_too_large`.

## Coverage, migration and verification

All portable schemas are version 1 and are validated at public boundaries. Stored
snapshots are immutable and keyed by tenant/workspace/ID. Do not reuse an ID for a
different snapshot, installed product instance, package version, deployment or
notice revision. Deployment IDs include environment, cluster, account, namespace
and name; raw source files and built artifacts have distinct node kinds.

Supported extraction is deliberately narrower than the existing native parser:
TS/JS literal imports/exports and literal fetch calls, OpenAPI 3.0/3.1 JSON,
`system-graph.json`, npm manifests and v2/v3 lockfiles. See the source guide for the
explicit unsupported-format behavior. No Rust extractor is invoked for a format
that is not yet ported. Unknown or unsupported data produces gaps or validation
errors, never a complete successful empty parse. Fixed notifications and synthetic
fixtures establish repeatability, not real operational authentication or exposure.

The acceptance/review matrix and actual command results are recorded in
[portable-verification.md](portable-verification.md). The [03da16a follow-up](review-followup.md)
records A–G fixes, protocol/storage versions and lossless v1 history migration.
Native comparison tests still
need the pre-existing Rust executables; that requirement belongs to compatibility
verification, not to any completed portable feature.
