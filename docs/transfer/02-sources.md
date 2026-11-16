# Feature 2: source ingestion and update

API: `collectRepositories(registrations, source, options)`.
Port: `RepositorySource.read(registration, signal)` returns files or a collection
with revision-verification metadata. Implement repository fetching/auth outside the
extractor. File collection and AST parsing never write the registered checkout.

```ts
import { GitRepositorySource, collectRepositories } from 'system-graph-remote/platform';
const source = new GitRepositorySource({ 'repo-a': absoluteCheckoutRoot });
const graph = await collectRepositories(registrations, source, {
  snapshotId: 'snapshot-next', asOf: '2026-11-16T00:00:00Z', previous: oldGraph,
});
```

Each registration has a globally unique repository ID, service ID, exact environment
or null, revision and optional base URL. `GitRepositorySource` requires a full
40-character local commit SHA, verifies it, and reads committed blobs without
checkout/stash. `LocalRepositorySource` reads working-tree files; its revision is
explicitly **unverified**, not proof those files match a commit. Every observation
records per-file hashes, collection method/time, extractor, revision and status.

| Input | Initial TypeScript support |
| --- | --- |
| TS/JS/TSX/JSX, mjs/cjs/mts/cts | Literal imports/exports; relative file resolution; package references; literal fetch endpoints |
| OpenAPI | 3.0/3.1 JSON, explicit server, operation paths; unresolved references/callbacks are gaps |
| Configuration | Strict `system-graph.json` event/database/service declarations |
| npm | package.json declared scopes/ranges; package-lock v2/v3 exact versions, nesting and transitive relationships |
| Other JSON/YAML/TOML/SQL/Rust/Python/Go/JVM/.NET/HCL | Not ported; gaps instead of native fallback or successful empty extraction |

Dynamic imports/require, computed fetch URLs/options, unresolved module references,
unsupported lockfiles and syntax errors are reported. TypeScript support is static
syntactic dependency extraction, not whole-program control/data-flow, runtime
execution, type checking or arbitrary HTTP-client recognition. Paths, imported
aliases, dynamic endpoints and API templates may require further resolvers. Package
ownership is not guessed from a matching name. Plain documentation is not code.

The native `packages.rs` lists npm/pnpm/Yarn, Python, Cargo, Go, Maven, Gradle and
.NET manifest readers. Those formats are not claimed as ported merely because the
native extractor recognized them. All unported formats remain explicit gaps here.

A successful refresh replaces the registered repository facts, including deletion.
A failed refresh retains previous evidence timestamps and records collection gaps.
Snapshot IDs are immutable; partial data never becomes a complete empty snapshot.
Source limits: 2,000 files, 1 MiB per file and 16 MiB total. Working-tree collection
skips generated/dependency directories and refuses links; Git collection refuses
non-regular blobs/submodules. No arbitrary client path/URL is accepted through MCP.

Tests: `node --test dist/tests/platform-ingestion.test.js`. The checked-in
`tests/fixtures/platform/service-a` and `service-b` cover extraction; a temporary
synthetic Git repository verifies pinned commits and dirty-worktree protection.
MCP startup source configuration invokes this same API before exposing read tools.
