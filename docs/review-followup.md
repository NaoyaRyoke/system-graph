# Review follow-up at 03da16a

Baseline: `refactor/company-mcp-template`, local/remote HEAD `03da16a`, clean tree.
This log covers the supplied review A–G and continued workflow history. The pasted
request ends mid-sentence after its legacy-data requirement; preserve existing
data and provide an explicit migration path as part of stage 2.

| Item | Reproduction | Fix / regression / transfer documentation |
| --- | --- | --- |
| A. Artifact contradictions disappear after environment scope | Reproduced: scoped complete/not_affected and resolved work | Fixed: typed artifact/deployment/repository applicability; affected targets stay unknown, unrelated artifacts do not block closure. Core, service, MCP and workflow regressions pass. |
| B. Limited CycloneDX composition becomes global completeness | Reproduced: dependency-only declaration produced complete=true | Fixed: explicit assembly and dependency coverage for every known reference, with no cascading completeness. Positive matches and fully supported negatives retained. |
| C. Multi-environment logical service disappears | Reproduced with/without source and reversed deployment order | Fixed: repository-owned logical services with scoped evidenced bindings; production/staging/both aggregate deterministically. |
| D. OpenAPI server base path disappears | Reproduced with /v1 and /v1/ servers | Fixed: OpenAPI path append plus common endpoint normalization; actual MCP impact and trace connect service-a to service-b. |
| E. Edges crossing inventory pages disappear | Reproduced: three one-node pages yielded zero edges | Fixed: independent stable node and edge domains/cursors; inventory and query reconstruct small and normal multi-page graphs. |
| F. Future evidence is hidden by the oldest timestamp | Reproduced separately for product, deployment and runtime evidence | Fixed: earliest/latest observation range, both stale/future checks, boundary/deadline tests, no automatic closure. |
| G. Redaction breaks valid edge references | Reproduced: service:alpha edge source redacted | Fixed: reference IDs and evidence paths use separate projection contexts. Metadata/path/credential protection retained; inventory/impact/trace verified over MCP. |
| Stage 2. Workflow history stops after 256 evaluations | Reproduced at evaluation 257 | Fixed: unchanged-proof evaluation spans, recent-state window and immutable archived event paging; old JSON migrated with original-byte backup. |

Run `node --test dist/tests/platform-review.test.js` for the focused suite.
Use `node scripts/test-portable.mjs` after compilation for portable regressions.
No native fallback, relaxed repository/environment policy or disabled redaction is
an acceptable correction. Track all test results and format/API changes here.

## Causes, implementations and exact scope

- **A:** A repository/environment tuple could not identify an immutable-artifact
  problem. `coverage.ts` now represents `appliesTo: {kind: 'artifact', artifactId,
  digest}`, `{kind: 'deployment', deploymentId}` or `{kind: 'repository'}`.
  Omitted applicability retains the original exact-environment meaning, including
  null as unknown. Scoping checks allowed runtime/artifact anchors before exposing
  an independent issue. `issueApplies` is shared by matching and closure logic;
  conflicts retain the previous artifact facts but invalidate definitive verdicts
  for the affected digest. A clean re-observation removes the current issue and
  permits closure. Source-wide acquisition failure has explicit repository scope.
  Old unbound SBOM-failure gaps conservatively require repository recollection.
- **B:** The old importer treated absent `assemblies` as global proof. Imported
  `completeness` now records the complete assembly and dependency reference sets
  separately. Both dimensions must explicitly cover all known component/root refs.
  A declaration for a parent does not certify its children or transitive dependencies.
  Unknown refs, incomplete/unsupported declarations and missing coverage remain
  gaps; a positive vulnerable component is still detectable. Fixture declarations
  were corrected rather than weakening these rules to preserve old expectations.
- **C:** A service's single environment came from whichever source/deployment was
  inserted first. The stable service ID now denotes a non-shared, repository-owned
  logical service; `serviceBindings` carry environment, deployment, owner and
  evidence. Authorization projects those bindings before traversal/aggregation.
  Legacy `runs` relationships can establish bindings only for the same owned
  service/deployment repository with correctly scoped evidence. No arbitrary
  service receives shared-node privileges. Failed source recollection retains
  source facts rather than stale runtime bindings from a previous composition.
- **D:** URL reference resolution replaced the server pathname. `endpoints.ts`
  implements the supported static OpenAPI append rule and shares endpoint identity
  normalization with fetch extraction. Templates, relative/variable/multiple
  servers and operation/path server overrides outside the supported subset are
  gaps, not complete successful empty extraction.
- **E:** Edges were selected using only the current node page. Inventory now pages
  the entire authorized edge set; query pages the induced graph over **all** matching
  nodes. Node and edge sorting/cursors are independent. Off-page endpoint references
  are expected and resolve once the corresponding node pages are fetched.
- **F:** Taking a minimum hid later observations. Conversion retains the temporal
  range of the product, deployment and runtime evidence. Matching tests the minimum
  for staleness and maximum for future input; future support deadlines remain valid.
- **G:** A key named `source` was always treated as a file path. Complete graph-edge
  objects preserve typed references; evidence/gap paths still use path redaction.
  Untrusted `attributes`/`facts` maps cannot impersonate an edge to bypass filtering.

Official references: [CycloneDX 1.6 compositions](https://cyclonedx.org/docs/1.6/json/),
[OpenAPI 3.1 Paths Object](https://spec.openapis.org/oas/v3.1.0.html#paths-object).

## Compatibility and existing data

| Boundary | Version / migration |
| --- | --- |
| Native comparison API | Unchanged; no native fix/fallback is claimed |
| Portable MCP | Server 2.0.0, `apiVersion: portable-2`, 10 read tools including `graph_remediation_history` |
| Impact/trace reports | `analysisContract: 2`; snapshot family remains schemaVersion 1 |
| CVE/EOL reports | `evaluationContract: 2`; cached contract-1 negatives are not upgraded into new proofs |
| Inventory/query | `inventoryContract: 2`, independent `edgeOffset`/`edgeLimit`, explicit edge scope |
| Portable snapshots | Schema family 1 accepts older data; new applicability, bindings, completeness and observation-range fields are additive for the new reader. Old strict readers may reject new fields; downgrade is not promised. Existing snapshot files are not rewritten. |
| Legacy SBOM | A stored complete flag without scope provenance becomes incomplete until supported raw SBOM input is re-imported. Better completeness attestations can refresh identical component/dependency facts; contradictory versions remain an issue. |
| Legacy converted EOL asset | A composition-v1 asset without its observation range needs recollection. A genuinely standalone single observation remains a valid input. Original future timestamps cannot be reconstructed from an already collapsed timestamp. |
| Work records / latest-state ledger | Version 2; v1 array-ledgers are backed up as `work-….json.v1-backup`, converted under the namespace write lock and atomically replaced only after archives exist. IDs, CAS versions and all legacy events are preserved. |

Work-record `history` is now the latest 16 events, with explicit `historyOffset` and
`historyCount`; it is not the complete audit trail. Use `WorkStore.getHistory` or
`graph_remediation_history` for the full paged trail. Pin `recordVersion` across
pages, restarting on a version conflict. New adapters must implement this v2 store
method. Unknown ledger versions or inconsistent legacy data fail without silently
dropping or repairing original records. Migration preserves historical decisions
as historical facts; reevaluate current state with fresh input before relying on
old closure decisions. Startup does not rewind a later persisted evaluation to an
old snapshot/config time, or choose arbitrarily between tied current snapshots.
Migrated records expose `requiresReevaluation: true`; old resolved decisions must
not be presented as newly verified closures while that flag is set. A successful
explicit reevaluation clears the flag and records the new decision. Recollection
must use a new immutable snapshot ID, even for the same source commit, when the
corrected representation or evidence has changed.

Repeated unchanged evaluations of the same snapshot, notice revision, policy and
outcome update `evaluatedAt`, CAS version and the latest span's `lastAt`/count. Exact
retries do not write. Distinct proof snapshots, state/notice/policy changes and
manual workflow events remain individual events. Older events are immutable files;
no event-count ceiling is substituted for the old 256 limit and no events are
silently discarded. The latest ledger retains its existing record/byte bound;
archive storage grows with real changes and is subject to disk capacity. Production
retention/backups and database replacement remain `WorkStore` responsibilities.

## Verification and resumability

Focused tests: `platform-review.test.ts`, `platform-review-mcp.test.ts`,
`platform-history.test.ts`; fixtures: `review-fixtures.ts` and the existing synthetic
platform fixtures. The original baseline log records all eight failures, followed
by passing focused runs. Additional regressions prove unrelated-artifact recovery,
600 coalesced evaluations, 280 independently retrievable events, 256-event legacy
migration, optimistic concurrency, monotonic time, restart behavior and actual MCP
history paging. Logs under ignored `.local/` are local evidence, not required
transfer inputs.

Validation on Windows / Node 24.22.1 / TypeScript 5.9.3, 2026-11-16:

| Actual check | Result |
| --- | --- |
| Original focused tests against 03da16a | All eight cases failed as reported (A–G and evaluation 257) |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed |
| TypeScript build + `scripts/build-entry.mjs` | Passed |
| Portable suite, with native engine/generator paths deliberately unavailable | 61 passed |
| Full native-compatibility + portable suite | 116 compiled tests + 7 distribution tests passed (123 total) |
| Migration/restart/MCP history focused final run | 9 passed |
| Existing privacy scan | No findings; existing reviewed legal-text allowance retained |
| `git -c core.whitespace=cr-at-eol diff --check` | Passed |

No Rust source/build, Docker, Linux host or live external feed was changed or
validated. Native compatibility tests used the existing local executables.
All newly introduced data, archives and migrated ledgers in tests are synthetic;
no existing operational workRoot was migrated during development.
