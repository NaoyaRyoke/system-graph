# System Graph Remote MCP

Read-only system-level graph queries across repositories. A Rust engine performs graph selection, ranking, impact and trace operations; TypeScript handles authentication, authorization, workspace registration and bounded MCP transport.

**Version 0.1.0-beta.1 — first public beta candidate, not production-ready.** The distributed host is HCL-free. Full-core Terraform/HCL-enabled artifacts are not cleared for redistribution.

```text
MCP client → maintained TLS/auth edge → TypeScript adapter → private JSON pipe → Rust engine → read-only SQLite snapshot
```

The six tools are `graph_capabilities`, `graph_inventory`, `graph_query`, `graph_impact`, `graph_trace` and `graph_explain`. There is no write, scan, migration, upload or arbitrary path/URL tool. MCP revision: **2026-07-28**. Compatibility uses the official legacy SDK adapter at `/mcp-legacy`; the current endpoint is `/mcp`.

## Build and synthetic demo

Node 24.22.2 (minimum 24.11.0), Rust 1.99.1 with rustfmt/Clippy, a C/C++ toolchain, CMake and Python 3.11+ are required. Dependencies are locked. Linux AMD64 and Windows GNU are tested; Windows MSVC and native ARM64 remain unverified acceptance targets.

```sh
git clone https://github.com/NaoyaRyoke/system-graph.git
cd system-graph
npm ci --ignore-scripts --no-audit --no-fund
cargo build --manifest-path rust-host/Cargo.toml --locked
npm run build
npm test
npm run demo
```

The demo creates synthetic graph snapshots and a short-lived RAM credential, exercises MCP startup/list/query/impact/trace/explain, stops the server/worker and deletes its temporary credential configuration. It never prints credential values. `npm run sample` reuses only its own generated fixtures under ignored `artifacts/`; it refuses to overwrite arbitrary databases.

## Authentication and isolation

Self-host behind a maintained TLS/auth boundary. `npm start -- <runtime-config> <engine-binary>` requires explicit workspace/graph registration and permissions. Signed short-lived tokens use RS256 `at+jwt`, pinned public JWKS, exact issuer/resource audience, exp/nbf, `graph:read` and an explicit issuer+subject binding. No automatic user enrollment, arbitrary tenant selection or implicit anonymous fallback exists. Explicit development bearer mode is loopback-only.

OAuth authorization-server discovery, refresh and introspection are not implemented. The JWT adapter is an integration boundary, not a claim of full OAuth/MCP authorization conformance. Browser/BFF authentication is an operator responsibility.

Each workspace uses a separate container, read-only graph/config mounts, private backend network and explicit permissions. The public executable rejects multi-workspace configuration in one process. In-process multi-workspace fixtures do not establish a production tenant-isolation guarantee against a hostile host or daemon.

## Container verification

```sh
docker build --target verification -t system-graph-beta-verify:local .
docker build --target runtime -t system-graph-beta:local .
node scripts/docker-check.mjs
docker build --target storeverification -t system-graph-store-verify:local .
```

Confirm the Docker context is the intended local daemon. The check creates dedicated containers/networks, exposes only gateway loopback port 18974, and removes its exact resources. Backends publish no host ports and have no external default route. The test gateway is not a production egress firewall. Images/cache and synthetic artifacts remain locally.

Runtime is a minimal scratch image with Node, engine, required ELF libraries and accompanying notices/sources. UID/GID 10001, read-only root/config/graph, dropped capabilities, no-new-privileges, safe DNS and bounded memory/PIDs/CPU/tmpfs are required. Never copy synthetic test file permissions to real credentials. Provision graph snapshots separately; none are embedded in the runtime image.

## Limitations

Queries use ranked lexical matching, not semantic search or complete UI-to-SQL tracing. Declared graph metadata is evidence, not proof of actual runtime exposure. Direct/transitive distinctions, incomplete coverage and result truncation remain visible. Requests/results/workers are bounded; busy workers reject concurrent work rather than creating an unbounded queue.

Native ARM64/MSVC acceptance, long-duration soak, full OAuth lifecycle and adversarial production operation are not covered. No availability SLA, bug bounty or production certification is offered. Raw OS vulnerability scanner results can include contextual non-applicable findings; do not interpret a zero actionable-blocker assessment as patched OS libraries or zero raw CVEs. See [advisory scope](docs/os-advisory-final.md).

## Documentation and licensing

[API](docs/public-api.md) · [Deployment](docs/deployment.md) · [Security model](docs/security-model.md) · [Threat model](docs/threat-model.md) · [Performance](docs/performance-scale.md) · [HCL-free profile](docs/hcl-build-profiles.md) · [SBOM](docs/sbom.md) · [Release checks](docs/release-process.md)

Apache-2.0 project license. Preserve LICENSE, NOTICE, THIRD_PARTY_NOTICES, the complete licenses tree and inherited modification notices. [VENDOR.md](VENDOR.md) records upstream origin and local changes. [Dependency licensing](docs/dependency-licenses.md) describes native/source obligations. Source archives include optional full-core dependency declarations; these are not bundled optional dependency implementations. Publish only the audited HCL-free host, never HCL-enabled artifacts.

Report vulnerabilities privately through Security → Advisories → Report a vulnerability. See [SECURITY.md](SECURITY.md); never include real credentials or confidential graph data in a public issue. No npm package or container registry publication is implied by the source prerelease.
