# Feature 5: EOL assessment and transfer guide

EOL is feature 5 of the [portable TypeScript platform](portable-platform.md).
`compositionToEol` connects observed deployment product/support data to this API;
the platform MCP mode and reevaluation coordinator use the same evaluator. The
smaller independent EOL-only launcher remains supported for direct integration.

## Public API

After `npm run build`, import from `system-graph-remote/eol` (or
`dist/src/eol/index.js` from another checkout). The subpath has TypeScript declarations
and no startup side effects. `evaluateEol(notice, snapshot, options)` is synchronous,
validates its inputs, performs no I/O, and requires neither Rust nor MCP.

```js
import { readFileSync } from 'node:fs';
import { evaluateEol } from 'system-graph-remote/eol';

const fixture = JSON.parse(readFileSync('examples/eol-stdio.json', 'utf8'));
const report = evaluateEol(fixture.notices[0], fixture.snapshots[0], {
  asOf: '2026-11-16T00:00:00Z', maxAgeDays: 30, limit: 20, offset: 0,
});
console.log(report.status, report.counts, report.items);
// affected, { affected: 1, not_affected: 1, unknown: 0 }
```

Exports include `EolNotice`, `EolAsset`, `EolSnapshot`, `EvaluationOptions`,
`EolAssessment`, `EolAssetAssessment`, the notice/snapshot/request schemas,
`EolQueryService`, `MemoryEolSources`, and `EolSources`. The separate
`system-graph-remote/eol/mcp` subpath exports `createEolServer` and `registerEolTool`;
importing the core API does not load an MCP SDK. Existing deep package imports
remain available. `AssessmentIdentity`, `AssessmentPage`, `AssessmentStatus`,
`NoticeSource<T>`, `SnapshotSource<T>`, evidence and notice metadata form the shared
notification vocabulary. They are suitable for future CVE results; no CVE matching
or exploitability assessment is provided by the EOL evaluator.

## Input contract and normalization

`schemaVersion: 1` is required; unknown fields and unsupported schemas fail validation.
`examples/eol-stdio.json` is a complete synthetic input and operator configuration.

| Input | Required meaning |
| --- | --- |
| Notice | Product, vendor, release line, version selector, support policies, revision, update time, evidence |
| Policy | Explicit tier, inclusive last supported date (`endsOn`), required boolean condition keys |
| Asset | One observed product instance in one repository and environment; exact installed version and identity, explicit support tier/conditions, observation time/evidence |
| Optional links | Immutable artifact, deployment, service and owning team IDs; use `null` if unknown |
| Snapshot | Immutable ID, collection time, observed asset instances, scoped collection gaps |
| Query | Evaluation time; MCP additionally pins notice ID, revision and snapshot ID |

Normalize identity aliases before calling the API. Product/vendor/release-line
comparisons are exact and case sensitive; no fuzzy product inference is attempted.
Use `null` for unknown identity/version/tier fields, and for unknown environment.
The literal environment `unknown` is reserved for the permission selector; asset
and coverage inputs use `null`. It is never treated as production.

Each asset ID must uniquely identify an installed product instance, including its
deployment/environment where applicable. Different versions, deployment accounts,
clusters, and environments must have different asset/deployment IDs. The evaluator
does not generate these identities or join rows using product names. Supply links
from observed runtime inventory, not the current source branch. One artifact used
by multiple deployments yields distinct instance rows. This preserves a production
old artifact while staging or source has already been updated.

All supplied asset evidence must attest the normalized installed identity, version,
support data and supplied links. Record weaker evidence as `inferred` or `ambiguous`;
do not label inferred runtime associations `confirmed`. Evidence includes a stable
ID, relative source locator, extractor and confidence. The observation timestamp
applies to the asset record and its associations. Full SBOM formats, source
extraction, raw graph ingestion, transitive dependency discovery, and ingestion
of external provider feeds belong to their own adapters/features.

## Rules, uncertainty and limits

- `numeric` selectors cover `[from, until)`. Versions are one to eight dot-separated
  unsigned decimal segments, each at most 12 digits, compared with integers and
  trailing-zero padding (`1.4` equals `1.4.0`). This is not npm SemVer, RPM, Debian,
  Maven, or vendor suffix ordering. Such installed strings return `unknown` under
  numeric selectors. `exact` selectors accept a list of literal installed versions.
  Unsupported selector schemes are rejected, never successfully parsed as empty input.
- Missing identity/version returns `unknown`, except an explicit product/vendor/series
  mismatch can already exclude this notice. Missing or unlisted support tier returns
  the field requiring confirmation. There is no assumed standard-support entitlement.
- Every required support condition must be explicitly `true`. Missing, `null`, and
  `false` leave the selected policy unconfirmed; no fallback to another policy is
  guessed. A `null` deadline returns `notice.support_deadline` as missing.
  Results retain the notice `criteria` and the selected policy's evaluated
  `supportConditions`, including explicit false values, so the rule is reviewable.
- Support lasts through `endsOn` in the UTC calendar. `asOf` accepts explicit ISO
  timestamps and offsets; the next UTC date is `affected`. Active support returns
  `not_affected` with its future deadline. This means unaffected by this specific
  notice at this evaluation time, not globally supported or secure.
- Stale observations (default more than 30 days), future observations, absent or
  unconfirmed asset/notice evidence, and notices published after `asOf` return
  `unknown`. The threshold is explicit in public options and operator-controlled in
  MCP configuration. `updatedAt` records the notice revision time; fetching fresh
  authoritative notices remains the provider's responsibility.
- Collection gaps, stale/future collection timestamps, or no observed assets make
  the aggregate incomplete. An empty result is `unknown`. Known affected rows remain
  affected during partial collection; otherwise incomplete data makes aggregate
  status unknown. Counts describe observed asset instances, never unseen assets.
  Coverage must describe every known failed/uncollected scope; omission cannot be
  detected by this evaluator.
- `path` preserves supplied asset → artifact → deployment → service references;
  absent links are omitted. A missing service link means the asset can be assessed
  but no affected service can be identified from that row. Missing `serviceId` and
  `ownerTeam` appear explicitly in `missing` and make the aggregate incomplete;
  they do not erase a known affected asset. This path is a supplied
  association, not dependency traversal or a stop/update impact candidate list.
- All three statuses are included in pages. Totals/counts/status cover the entire
  authorized input, even when the current page contains no affected row. Stable
  lexical asset-ID ordering, `hasMore` and `nextOffset` support up to 50 rows per page.
  `truncated` is false: there is no bounded graph exploration here. Result paging
  does not change that flag. Continue with identical notice revision, snapshot ID,
  `asOf`, scope and age policy. Snapshot sources must preserve content under an ID.

Snapshots support at most 10,000 assets and 1,000 coverage gaps; each asset or notice
supports 16 evidence records. Policy tiers and condition counts are bounded by the
schemas. Validation errors throw from the pure API. Provider failure is an MCP
error, not a successful zero-result assessment. MCP inputs are capped at 16 KiB and
serialized results at the existing 256 KiB bound; reduce `limit` if evidence causes
`response_too_large`.

## Rust-free MCP verification

```sh
npm run test:eol
node dist/index.js --eol /absolute/path/to/examples/eol-stdio.json
```

The dedicated mode uses the existing package launcher, serves only `graph_eol`, and
does not construct, warm, spawn or build a Rust worker. The existing six-tool mode
keeps its engine/config arguments. The new mode accepts one absolute operator
config path (regular file, at most 16 MiB); MCP arguments cannot supply files, URLs,
tenant IDs, raw notices, raw inventory or commands. Local principal registration is
fixed before serving, with no anonymous fallback. This is a local stdio mode, not
an authenticated Remote service. Operator file access and process isolation matter.

Example MCP client registration (replace the two absolute paths):

```json
{
  "mcpServers": {
    "system-graph-eol": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "--eol", "/absolute/path/to/examples/eol-stdio.json"]
    }
  }
}
```

Call `tools/list`, then `graph_eol` with:

```json
{
  "workspace": "main", "noticeId": "notice-a", "noticeRevision": "r1", "snapshotId": "snapshot-a",
  "asOf": "2026-11-16T00:00:00Z", "limit": 20, "offset": 0
}
```

The fixture returns one affected production row using `artifact-old` and one
unaffected staging row using `artifact-new`. Both legacy and modern protocol
adapters return the same structured assessment as the TypeScript service. Unknown
environment requires `unknown` in both registration and the caller's permission;
the fixture deliberately does not grant that permission.

`EolQueryService` reuses `PolicyEngine`'s `inventory` read permission. Every call
checks tenant, workspace, expiry, operation, repositories and environments before
consulting providers. Filtering applies to asset rows, service references, coverage,
totals and counts. Selecting a narrower authorized scope is supported. Out-of-scope
rows cannot contribute even counts or coverage reasons. MCP text/evidence uses
the existing redaction rules and returns fixed error codes. Queries pass through
rate limiting, audit and metrics hooks; the local launcher retains at most 1,000
audit and metric entries in process memory and logs no raw input.

## Transfer connections

1. Implement `NoticeSource<EolNotice>.getNotice(tenant, workspace, id, signal)` for
   normalized, trusted provider notifications. Separate fetching/parsing and alias
   resolution from EOL evaluation. Preserve revisions and distinguish unsupported
   data from missing notifications. A requested revision mismatch is rejected.
2. Implement `SnapshotSource<EolSnapshot>.getSnapshot(tenant, workspace, id, signal)`
   against immutable runtime snapshots in your store. Connect feature 3's component,
   artifact and deployment data here; retain collection gaps and confirmed versions.
   A wrong returned snapshot/notice ID is rejected as unavailable input.
3. Supply existing registrations/permissions to `PolicyEngine`, an authenticated
   principal, and audit/metrics/rate-limit hooks to `EolQueryService`. Network
   deployment must use the application's actual authentication; do not reuse the
   local stdio identity as a remote authentication scheme.
4. Call `service.execute(principal, request, signal)`. Register the same service with
   `registerEolTool(server, {service, principal, signal})` for an existing MCP server.
   `createGraphServer` also accepts optional `eolService` in its context, leaving
   its original six tools unchanged when absent. Existing Remote factories must
   explicitly provide that service; default Remote config has no EOL source.

`MemoryEolSources` validates and copies operator-provided records, keys them by
tenant/workspace/ID, rejects duplicate bindings, and returns clones. It is suitable
for local verification. Production stores must enforce immutable snapshot IDs,
access-controlled evidence locators, provider cancellation/timeouts and durable
audit where required. No external feed, database, authentication, scheduler,
ticketing or notification integration is implemented in this increment.

Notice/snapshot schema versions are independent of the native graph schema. Never
silently reinterpret existing IDs, version schemes, policy semantics or environment
nullability. Publish new schema versions and adapters for incompatible changes.

## Validation and integration

The dedicated test command compiles TypeScript and runs pure API, policy and real
stdio MCP tests without Rust or graph fixture generation. Tests include support
conditions, dates, exact identity/version distinctions, uncertainty, incomplete
collection, 60-row pagination, forbidden scopes, unknown environment, source
failure, response bounds, redaction, both protocol eras and EOF cleanup. The
checked-in example is tested as input. Additional existing graph regression tests
require the existing native engine and generated graph fixtures.

Validation performed on Windows with Node 24.22.1 on 2026-11-16:

| Command/check actually executed | Result |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | Passed |
| `node node_modules/typescript/bin/tsc` and `node scripts/build-entry.mjs` | Passed |
| `node --test dist/tests/eol.test.js dist/tests/eol-service.test.js dist/tests/eol-mcp.test.js` | 16 passed; no Rust process/build required |
| Full portable/native command results | See [current verification record](portable-verification.md) |
| `node --input-type=module` importing `system-graph-remote/eol` with the checked-in example | Affected production asset and unaffected staging asset |
| Existing `scripts/privacy_scan.py` under the discovered local Python interpreter | No findings; existing reviewed legal-text allowance retained |
| `git -c core.whitespace=cr-at-eol diff --check` | Passed; tracked CRLF manifest bytes preserved |

The `npm` command was not on this shell's PATH, so equivalent package-script
commands were executed directly with Node. Rust was not rebuilt; the full existing
graph regression used the existing local native executables. Linux, Docker, npx
package fetching and live external feeds were not tested in this increment. The
existing TypeScript 5.9.3 dependency is now a runtime dependency for source AST
collection; EOL evaluation needs no compiler. No production service was changed;
repository publication is separate from validation.

Features 1–4 and 6 are implemented in `src/platform`; see the linked guides for
their coverage. [Feature 6](transfer/06-remediation.md) handles idempotent work
records and resolution verification against updated observed runtime. The review
matrix distinguishes the corrected portable path from retained native comparison
behavior; no native fallback is used for completed portable features.
