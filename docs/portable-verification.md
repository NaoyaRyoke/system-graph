# Portable acceptance and review verification

Baseline: `refactor/company-mcp-template`, `67e7bc87649395e72a108f6f5673392fa780a406`.
The pre-existing EOL changes were retained. The portable implementation uses its own
normalized schema v1 and the existing authorization/redaction boundaries.

## Review A–F

The findings were reconfirmed in the current reference implementation. Corrections
below are in the completed TypeScript APIs and `--platform` MCP path. Native
SQLite/Rust code and its original adapter contract remain for compatibility and
comparison, and still have the native limitations described here. These are not
claimed as fixes to the legacy executable. Use the portable path for features 1–6;
there is no native fallback in that path.

| Finding | Current-code evidence | Portable correction / reproduction |
| --- | --- | --- |
| A. Shared nodes disappear | `rust-host/src/main.rs` scopes by eligible environment and non-null permitted repo_id; `package_graph.rs` creates package nodes with no repo_id | `scopeGraph`: explicit shared identities and allowed evidenced anchors; separate handling of repo-owned build artifacts. Tests show cross-repo paths, denied repos, unknown environment, and no staging leakage through common packages. |
| B. Paging disappears from impact projection | `src/service.ts` derives public truncated from native truncation only; request offset is absent from the old impact input | Impact returns total, totalIsExact, offset, limit, hasMore, nextOffset and independent exploration bounds. Both core and real MCP retrieve exactly 60 candidates across three pages. |
| C. Context/evidence is lost | Native `ImpactContext` has empty freshness/compatibility/criticality/service-membership data; old projection reduces impact/trace fields | The portable snapshot supplies context and dated scoped evidence. Path quality, source evidence, services, gaps and risk reasons survive projection. UNKNOWN is retained when context is absent; actual supplied context can produce a supported qualitative risk level. |
| D. Package versions collapse | Native `PackageIdentity` consists of ecosystem/name; package graph IDs use that identity | Declaration ranges and resolved package identities are distinct. npm nested resolution and SBOM versions/relationships retain exact versions and scope. Two versions of library-a remain distinct; transitive CVE target has root → middle → library evidence. |
| E. Deployment/build identity is incomplete | Native deployment key is technology/namespace/name; source files use Artifact; extracted image information is not the managed artifact/runtime model | Source-file and build-artifact kinds differ. Repository revision/digest/image/SBOM are explicit. Runtime identity includes env/cluster/account/namespace/name and binds the actually observed digest, with unresolved/declaration-only states reported. |
| F. Self-scanning is not managed-service matching | Existing supply-chain/vulnerability scripts inspect this tool and its dependencies | Managed CycloneDX ingestion and normalized advisory matching are separate APIs, with local target-service fixtures. Those scripts are never reused as if they evaluated managed runtime services. |

## Required acceptance cases

| Requirement | Executed test coverage |
| --- | --- |
| Cross-repository/shared-node dependency paths | `platform-graph.test.ts`, actual TS/OpenAPI fixtures in `platform-ingestion.test.ts` |
| Allowed shared nodes without publishing forbidden repos/envs | `platform-graph`, `platform-composition`, `platform-mcp` scope tests |
| 60 results / 20 per page; exact totals, no duplicates/gaps | `platform-graph` plus real `platform-mcp` pagination; independent EOL 60-row tests |
| Production/staging/unknown stay distinct | `platform-graph`, `platform-composition`, EOL policy tests |
| Different versions of the same library remain distinct | Nested npm lock fixture and two SBOM/runtime versions |
| Vulnerable indirect component from SBOM dependencies | `platform-composition`, exact depth-2 path and affected production service |
| Code/build updated but old artifact still running | Composition fixtures and coordinator retention test |
| Confirmed/inferred/ambiguous/stale relations; no-path is not safety | `platform-graph`, EOL/Vuln uncertainty tests |
| Partial/failed collection is not successful no-target | Ingestion, coordinator runtime/source failure and notification failure tests |
| Redeployment separates residual and resolved targets | `platform-remediation` mixed update test |
| Same notice does not duplicate response records | CVE and EOL repeated-evaluation and notice-revision tests |
| Public APIs run without Rust or MCP processes | Core graph/source/composition/workflow tests; portable package entrypoint |
| MCP preserves semantics, evidence and paging | Modern and legacy source-to-MCP tests for every tool, plus real 60-row paging |

Additional regressions verify immutable snapshot files, durable work-store reload,
optimistic concurrency, tenant isolation, cancellation, fixed identity, strict
inputs, notice revision pinning, response bounds, path/credential redaction, and
that abundant product evidence cannot mask missing/stale/inferred runtime proof.
The Git fixture creates its own temporary repository and proves committed blobs
are read while dirty working-tree bytes remain untouched.

## Commands and limits

Validation date: 2026-11-16. Host: Windows, Node 24.22.1, TypeScript 5.9.3.

| Actual command/check | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed |
| `node node_modules/typescript/bin/tsc` + `node scripts/build-entry.mjs` | Passed |
| `node scripts/test-portable.mjs` | 41 passed; no Rust build/process required |
| `node scripts/test.mjs` with existing native executables | 96 compiled tests + 7 distribution tests passed (103 total, including the 41 portable tests) |
| `node scripts/sample-platform.mjs` | Created a new synthetic local config |
| Package public API and manifest/lockfile consistency | Verified directly with Node |
| Existing `scripts/privacy_scan.py` | No findings; reviewed legal-text allowance retained |
| `git -c core.whitespace=cr-at-eol diff --check` | Passed; original CRLF bytes preserved |

The shell did not provide npm on PATH, so package-script equivalents were run
directly with Node. Native regression used the existing `.local/rust-target`
executables; Rust was not rebuilt or changed. The existing TypeScript 5.9.3 parser
was moved from development to runtime dependencies and its lockfile classification
was updated. Its license evidence was already present in the retained inventory.

Not exercised: live GitHub fetching, real SBOM feeds, cloud/cluster runtime queries,
production authentication/authorization, enterprise DBs/jobs/tickets/notifications,
Docker/Linux, a fresh npm install, and npx package fetching. No production service
was changed and no messages were sent. Repository publication is a separate,
owner-authorized operation. Synthetic tests do not
establish real deployment completeness, exploitability or operational safety.

Input limits and initial-format coverage are in the per-feature transfer guides.
In particular, this is not a full language/parser migration or full CycloneDX/OSV/
NVD/RPM/Debian support claim. Unported/ambiguous inputs stay explicit gaps or errors.
Legacy native snapshot IDs/data need an explicit normalizer/migration mapping into
schema v1; they are not silently reinterpreted as portable snapshots. Consumers
should obtain the new normalized node IDs from inventory after migration.
