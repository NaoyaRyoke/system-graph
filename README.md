# System Graph

System Graph is a read-only MCP server for querying cross-repository system relationships. A Rust engine performs graph selection, ranking, impact and trace operations; TypeScript handles authentication, authorization, workspace registration and bounded MCP transport.

**Version 0.1.0-beta.1 — first public beta candidate, not production-ready.** The distributed host is HCL-free. Full-core Terraform/HCL-enabled artifacts are not cleared for redistribution.

```text
Remote MCP client → maintained TLS/auth edge → TypeScript adapter → private JSON pipe → Rust engine → read-only SQLite snapshot
```

The six tools are `graph_capabilities`, `graph_inventory`, `graph_query`, `graph_impact`, `graph_trace` and `graph_explain`. There is no write, scan, migration, upload or arbitrary path/URL tool. MCP revision: **2026-07-28**. Compatibility uses the official legacy SDK adapter at `/mcp-legacy`; the current endpoint is `/mcp`.

## Architecture and stdio MCP setup

```text
MCP client → TypeScript MCP server → src/tools/* → QueryService
                                                     ↓
                                              EnginePool / RustClient
                                                     ↓ private NDJSON
                                              Rust engine → SQLite
```

The shared server/tool registry serves stdio and both Remote endpoints.
src/index.ts owns local MCP startup/lifecycle; src/main.ts remains the Remote entrypoint.
The Rust host must be built separately; MCP startup never downloads or compiles an executable.

Use the installation commands below. npm run build produces dist/index.js; npm run typecheck
checks types and npm test runs existing and new protocol tests. npm start and npm run start:stdio
now select stdio. The old Remote command is npm run start:remote -- CONFIG ENGINE.
The package remains private. Its system-graph bin supports npx from this GitHub branch; no npm registry publication is required.

Run npm run sample to generate synthetic snapshots and artifacts/sample-stdio.json.
For a real snapshot, provision it separately and supply version, expectedGraphSchema, absolute
graphsRoot, exactly one registered workspaces entry, explicit permissions and
localPrincipal: {"principal":"sample-reader","tenant":"..."}.
Use the generated sample as a shape reference, update the IDs/schema for your snapshot,
and omit Remote auth. No default identity or graph scanning is performed.

### Recommended: npx from GitHub

After provisioning the Rust host and graph config locally, start the TypeScript MCP layer with:

```sh
npx -y --package=github:NaoyaRyoke/system-graph#refactor/company-mcp-template system-graph
```

Set SYSTEM_GRAPH_CONFIG and SYSTEM_GRAPH_ENGINE to their absolute local paths. Git and Node/npm
are required. On first use npm fetches the GitHub source, installs its JavaScript build dependencies,
and runs prepare to compile TypeScript. Subsequent use is cached. No Rust host, database or config
is bundled, downloaded or built by prepare. Node/Rust build commands remain available below.
Use this branch while it is unmerged; for reproducible trials replace the branch after # with a
reviewed commit SHA. Do not use bare npx system-graph: this project is not published on npm.
Do not enable --foreground-scripts on the MCP command, because build output can pollute stdout.

Register the local MCP client using command + args:

```json
{
  "mcpServers": {
    "system-graph": {
      "command": "npx",
      "args": ["-y", "--package=github:NaoyaRyoke/system-graph#refactor/company-mcp-template", "system-graph"],
      "env": {
        "SYSTEM_GRAPH_CONFIG": "/absolute/path/to/system-graph/artifacts/sample-stdio.json",
        "SYSTEM_GRAPH_ENGINE": "/absolute/path/to/system-graph/target/debug/hybrid-engine-host"
      }
    }
  }
}
```

Alternatively append CONFIG and ENGINE after system-graph in args. All configured filesystem
paths must be absolute, so the client's working directory is irrelevant. On Windows use
C:/SystemGraph/artifacts/sample-stdio.json and C:/SystemGraph/target/debug/hybrid-engine-host.exe.
JSON backslashes must be doubled; forward slashes work too. If the MCP client cannot launch npx.cmd,
use command "cmd" and args ["/d", "/c", "npx", "-y", "--package=github:NaoyaRyoke/system-graph#refactor/company-mcp-template", "system-graph"].
A locally built checkout can still use command "node" with an absolute dist/index.js argument.

For a local package verification, run npm run test:npx after building the Rust host. It packs the
runtime with its legal notices, launches that package through the real npx CLI from a path with
spaces in a different working directory, and checks initialize, tools/list, all six calls, clean EOF and
stdout purity. The package allowlist excludes tests, graph/config artifacts, caches and Rust binaries.
The GitHub source prepare build and local node command are separate supported launch paths.

Stdout carries MCP NDJSON only. Diagnostics use stderr. Closing stdin aborts work and closes
the persistent Rust worker; delivered SIGINT/SIGTERM use the same cleanup. Both legacy initialize
and current negotiation use SDK v2 serveStdio. The OS account, config access and private pipe
identify the caller. localPrincipal is fixed for the process lifetime; every call still passes
the existing permissions/environment/repository policy. Restart to change registration/identity.
Do not expose this local launcher through an unauthenticated network bridge.

### Available tools and examples

| Tool | Example arguments | Purpose |
| --- | --- | --- |
| graph_capabilities | {"workspace":"main"} | API support and bounds |
| graph_inventory | {"workspace":"main","limit":20} | Scoped nodes/edges and pagination |
| graph_query | {"workspace":"main","query":"service","limit":10} | Ranked lexical matches |
| graph_impact | {"workspace":"main","target":"<returned-node-id>"} | Direct/transitive impact |
| graph_trace | {"workspace":"main","source":"<node-id>","destination":"<node-id>"} | Bounded trace |
| graph_explain | {"workspace":"main","target":"<returned-node-id>","kind":"node"} | Provenance |

Use IDs returned by inventory/query. Optional environments and repositories narrow registered
permissions. See [public API](docs/public-api.md) for exact semantics and limits.

### MCP Inspector

Use [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/tree/main/clients/cli)
with a separate installation; it is not a System Graph runtime dependency:

```sh
npm install --prefix .local/inspector --ignore-scripts --no-audit --no-fund @modelcontextprotocol/inspector@2.14.0
npm run sample
node scripts/inspect-stdio.mjs .local/inspector/node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js
```

The runner checks initialize, tools/list and every tool against synthetic graphs using mcpServers
command+args. It writes ignored artifacts and starts no public listener.
See [comparison/migration](docs/mcp-template-refactor.md) and
[validation results](docs/mcp-template-validation.md).

## Installation, build and synthetic demo

Node 24.22.2 (minimum 24.11.0), Rust 1.99.1 with rustfmt/Clippy, a C/C++ toolchain, CMake and Python 3.11+ are required. Dependencies are locked. Linux AMD64 and Windows GNU are tested; Windows MSVC and native ARM64 remain unverified acceptance targets.

```sh
git clone --branch refactor/company-mcp-template https://github.com/NaoyaRyoke/system-graph.git
cd system-graph
npm ci --ignore-scripts --no-audit --no-fund
cargo build --manifest-path rust-host/Cargo.toml --locked
npm run build
npm test
npm run demo
```

The demo creates synthetic graph snapshots and a short-lived RAM credential, exercises MCP startup/list/query/impact/trace/explain, stops the server/worker and deletes its temporary credential configuration. It never prints credential values. `npm run sample` reuses only its own generated fixtures under ignored `artifacts/`; it refuses to overwrite arbitrary databases.

## Authentication and isolation

Self-host behind a maintained TLS/auth boundary. `npm run start:remote -- <runtime-config> <engine-binary>` requires explicit workspace/graph registration and permissions. Signed short-lived tokens use RS256 `at+jwt`, pinned public JWKS, exact issuer/resource audience, exp/nbf, `graph:read` and an explicit issuer+subject binding. No automatic user enrollment, arbitrary tenant selection or implicit anonymous fallback exists. Explicit development bearer mode is loopback-only.

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

Architecture and local launch patterns were informed by [yryuu/mcp-api-requester](https://github.com/yryuu/mcp-api-requester). No reference source or HTTP tool is included; this project is independently maintained.
