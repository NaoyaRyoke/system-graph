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

`transitionWork` handles manual workflow intent and cannot mark resolved. Automatic
resolution requires a currently observed, fresh, confirmed unaffected target and
complete relevant composition. New source alone, a deployment request, target
absence, a missing SBOM, stale runtime or collection failure cannot close work.
Reappearance reopens work; mixed redeployments preserve residual and resolved
targets separately. Removal has no inferred retirement proof in this initial
version: missing targets remain unknown/open pending authoritative confirmation.

`MemoryWorkStore` is disposable; `FileWorkStore.open(absoluteRoot)` persists a
namespace-specific JSON ledger with exclusive write lock, atomic replacement and
CAS versions. File snapshot IDs are immutable; changed data needs a new ID.
Histories are bounded at 256 entries, local ledgers at 5,000 records/16 MiB.
Exceeding a bound is an error, never silent evidence deletion. Writes are atomic
per record, not a distributed transaction across an entire notification batch;
idempotent retry can finish a partially applied batch. Production implementations
must provide durable storage/locking, authorization and operational recovery.

Tests: `node --test dist/tests/platform-remediation.test.js dist/tests/platform-system.test.js`.
MCP exposes `graph_remediation` for scoped paged reads only. Configured `workRoot`
and `snapshotRoot` enable local file stores; otherwise startup uses memory stores.
MCP never creates tickets, sends messages or accepts workflow mutation commands.
