# Feature 6: reevaluation and response records

APIs: `reevaluateNotice(notice, composition, workStore, options)`,
`transitionWork(workStore, request)`, `SystemCoordinator.refresh(options)`.
Ports: `WorkStore`, `SnapshotStore<SystemSnapshot>`, `NotificationSource`,
`RepositorySource`, `ArtifactSource`, `RuntimeSource`, `JobRunner`.

```ts
import { MemoryWorkStore, reevaluateNotice } from 'system-graph-remote/platform';
const work = new MemoryWorkStore();
const records = await reevaluateNotice(notice, observedSnapshot, work, {
  tenant: 'tenant-a', workspace: 'main', asOf: '2026-11-16T00:00:00Z',
  trigger: 'redeployed',
});
```

Triggers are `notice_updated`, `composition_updated`, `redeployed` and `manual`.
The coordinator runs evaluation after collecting/storing a new snapshot; external
webhooks/jobs can call it through their own authentication and job implementation.
`InlineJobs` rejects overlapping refreshes rather than queuing unbounded work.

Record identity is tenant/workspace/notice kind/notice ID/target instance, excluding
notice revision, artifact version and snapshot ID. A repeated evaluation has the
same key and does not append history. Notice revisions/configuration updates modify
the same record. States are investigating, planned, awaiting verification and
resolved. Assessment status is a separate field. Optimistic versions protect
updates. Each history entry records trigger, evaluation snapshot, notice revision,
time, status and evidence IDs. Out-of-order evaluation is rejected.

Work records now use `schemaVersion: 2`. Exact retries leave the version unchanged;
later identical evaluations of the same proof snapshot, notice revision, policy and
outcome coalesce into a span (`at`, `lastAt`, `evaluationCount`) while advancing CAS
version and `evaluatedAt`. Different snapshots/notice revisions/outcomes/policies
and workflow transitions remain separate events. Manual intent is never coalesced
away. The active age policy is retained in new evaluation events.

`transitionWork` handles manual workflow intent and cannot mark resolved. Automatic
resolution requires a currently observed, fresh, confirmed unaffected target and
complete relevant composition. New source alone, a deployment request, target
absence, a missing SBOM, stale runtime or collection failure cannot close work.
Reappearance reopens work; mixed redeployments preserve residual and resolved
targets separately. Removal has no inferred retirement proof in this initial
version: missing targets remain unknown/open pending authoritative confirmation.

`MemoryWorkStore` is disposable; `FileWorkStore.open(absoluteRoot)` persists a
namespace-specific v2 latest-state JSON ledger with exclusive write lock, atomic
replacement and CAS versions. File snapshot IDs are immutable; changed data needs
a new ID. Latest state includes 16 recent events with `historyOffset`/`historyCount`.
Older events are immutable, separately paged JSON files and have no per-record
event-count ceiling. This window is a view, not deleted history. The latest ledger
retains the 5,000-record/16 MiB bound; archive disk capacity and backup/retention
are operator responsibilities. Writes are atomic
per record, not a distributed transaction across an entire notification batch;
idempotent retry can finish a partially applied batch. Production implementations
must provide durable storage/locking, authorization and operational recovery.

```ts
if (records[0]) {
  const page = await work.getHistory('tenant-a', 'main', records[0].id, {
    offset: 0, limit: 50, expectedVersion: records[0].version,
  });
  // Follow nextOffset; keep expectedVersion fixed or restart after a conflict.
}
```

Custom storage migrations can use the exported `migrateLegacyRecord`,
`legacyWorkRecordSchema` and `historyEntrySchema`; the migration helper returns a
v2 head plus all older events to persist in the adapter's own transaction.

`getHistory` is required on transferred v2 `WorkStore` implementations. It returns
zero-based event sequences, total event count and continuation separately from CAS
version and coalesced evaluation count. Native v1 array-ledgers are backed up
byte-for-byte as `work-….json.v1-backup`; all prior events/IDs/versions are retained
before an atomic head-format upgrade. Backups/archives are not removed by reads.
Unsupported or inconsistent data fails instead of being silently truncated.
Historical resolved decisions remain historical data and need fresh reevaluation
under the corrected rules. Migrated records are explicitly marked
`requiresReevaluation: true` until a successful reevaluation; do not display that
historical state as a newly verified closure. Startup does not rewind later periodic/workflow times
to an old config's collection time; an ambiguous tied latest snapshot does not
trigger arbitrary bootstrap reevaluation.

Tests: `node --test dist/tests/platform-remediation.test.js dist/tests/platform-system.test.js`.
MCP exposes `graph_remediation` for latest state and `graph_remediation_history`
for full history (`recordId`, `offset`, `limit`, optional pinned `recordVersion`).
Both apply repository/environment policy before returning any data. Configured `workRoot`
and `snapshotRoot` enable local file stores; otherwise startup uses memory stores.
MCP never creates tickets, sends messages or accepts workflow mutation commands.
