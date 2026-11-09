# System Graph MCP Template Refactor validation

**System Graph MCP Template Refactor: Go**

Scope: local MCP shell refactor on branch `refactor/company-mcp-template`, based on public main
`7dd66281d9cf2fb7c072ce3b2721572d03c39dcb`. Implementation and verification completed before Git saving.
The user subsequently authorized committing and pushing this branch for company-PC trials.
Existing worktrees/changes were preserved. Main merge, Git tags, release, npm/registry publication
and production deployment remain outside this authorization.

## Adopted and excluded

Adopted from [yryuu/mcp-api-requester](https://github.com/yryuu/mcp-api-requester):
a clear src/index.ts entrypoint, src/tools modules, explicit registration, stdio as a first-class
transport, command+args client setup, dist/index.js and bin packaging, and stderr diagnostics.
The reference was actually inspected before editing; see [comparison matrix](mcp-template-refactor.md).

Excluded: make_request, arbitrary HTTP/URL access, Axios, unchecked argument casts, manual HTTP tests,
old SDK APIs/dependency versions and copied source. System Graph keeps TypeScript 5.9.3,
MCP server/core/client 2.4.0 and Zod 4.6.7. SDK v1 remains an existing test-only compatibility client.
Package dependencies, resolutions and integrity hashes are unchanged.

## Architecture and Rust integration

```text
MCP client → stdio / Remote transport → shared server factory → src/tools/*
  → QueryService (authorization, projection, bounds, audit)
  → EnginePool → RustClient → persistent private NDJSON child → Rust → read-only SQLite
```

The six existing tools are graph_capabilities, graph_inventory, graph_query, graph_impact,
graph_trace and graph_explain. Each has its own named definition/schema/handler module.
Shared handler code shapes the MCP success/error envelope. Existing QueryService owns graph response
projection. No tool directly uses RustClient and there is no transport-specific graph implementation.

Rust host, vendored engine, SQL/schema identity, graph selection/ranking, environment prefilters,
provenance/redaction, explicit false, read/write facts, impact classification and trace behavior are
unchanged. Stdio regression compares all six structured responses against the existing service and
checks database SHA-256 before/after calls.

Remote /mcp and /mcp-legacy remain, with the same JWT/dev-bearer auth and HTTP admission checks.
Root remote-mcp.ts is a compatibility facade for existing imports. Docker still launches Remote
through its unchanged entrypoint; build and rootfs assembly include the new local launcher.

## Package and launch changes

- build: tsc plus scripts/build-entry.mjs.
- start and start:stdio: node dist/index.js.
- start:remote: node dist/src/main.js.
- main and system-graph bin: dist/index.js.
- test, typecheck and lint remain available; the existing test runner discovers the new tests.
- No dependency/version/license/private flag changes. package-lock.json adds only root bin metadata.

```sh
npm run build
node dist/index.js /absolute/path/runtime-stdio.json /absolute/path/hybrid-engine-host
npm run start:remote -- /absolute/path/runtime-remote.json /absolute/path/hybrid-engine-host
```

SYSTEM_GRAPH_CONFIG and SYSTEM_GRAPH_ENGINE can replace the explicit config/engine args,
allowing the template-style client entry with only an absolute dist/index.js argument.
npm run sample writes synthetic artifacts/sample-stdio.json. README contains complete mcpServers
configuration and Windows path instructions; Windows GNU launches from another cwd were tested.

## Results

| Check | Result |
| --- | --- |
| Locked offline npm install | PASS; existing cache; no install scripts |
| npm run build / TypeScript typecheck | PASS |
| Windows native JavaScript | 62/62 PASS (55 TypeScript + 7 distribution) |
| New Windows stdio tests | 11/11 PASS; included above |
| Linux Docker JavaScript | 63/63 PASS (56 TypeScript + 7 distribution), UID10001 |
| New Linux stdio tests | 12/12 PASS, including SIGTERM without client EOF |
| Existing Remote current/legacy clients, JWT, bounds/isolation | PASS on Windows and Linux |
| Remote synthetic demo | PASS on Windows and Linux |
| Windows Rust host tests | 5/5 PASS, freshly built locked/offline |
| Rust fmt / all-target Clippy -D warnings | PASS on Windows; unchanged Linux Rust build stage reused matching cache |
| SQLite store tests / all-target Clippy | 93/93 PASS and Clippy PASS, Linux Docker UID10001; tests actually rerun |
| Existing Python release evidence | 10/10 PASS |
| MCP Inspector 2.14.0 CLI | 8/8 PASS: initialize, tools/list, all six calls |
| Protocol purity | PASS; every stdout line parses as MCP JSON-RPC; diagnostics stderr only |
| Shutdown / startup faults | PASS; EOF, pre-initialize EOF, oversize close, missing config/host; Linux SIGTERM |
| Security inputs | PASS; malformed tool args, unknown tool, URL/path/command/tenant fields, unauthorized scope/foreign IDs |
| Privacy scan | PASS, no known-pattern findings; existing authoritative legal-text allowance retained |
| Git whitespace | PASS with core.whitespace=cr-at-eol; original audited CRLF bytes preserved |
| Rust/legal source diff | Empty; LICENSE/NOTICE/THIRD_PARTY_NOTICES/licenses preserved |

Windows used Node 24.22.1 and the existing GNU Rust toolchain; Linux verification used pinned
Node 24.22.2 / Rust 1.99.1 Docker images. Inspector was separately installed under ignored .local
and used its official CLI, the same mcpServers command+args configuration, and a legacy initialize
opening. Modern 2026-07-28 stdio negotiation and all six tools were independently tested with SDK v2.
Inspector result receipt is in ignored artifacts/inspector-results.json; runner is committed-source
candidate scripts/inspect-stdio.mjs. Inspector is not a runtime or package dependency.

A new malformed-JSON test initially expected a diagnostic, but SDK ReadBuffer intentionally discards
syntax-invalid lines and continues. The test now verifies that behavior plus a valid subsequent
initialize and no raw-input echo. Structurally malformed tool inputs are still rejected.
An oversize shutdown test exposed paused stdin holding a pipe open after negotiation; shutdown now
explicitly destroys the owned input pipe after closing the SDK transport. Both platforms pass.

## Security and license review

No HTTP requester, arbitrary filesystem selector, graph write, repository upload, scan/management
or command-execution tool was added. Paths/executable are operator startup configuration only.
A separate strict stdio config binds exactly one workspace and an explicit localPrincipal.
The OS account/config/private pipe authenticate that local process; the same policy checks every call.
Missing/foreign/disabled bindings fail closed before warmup. Startup requires capabilities permission.
Input buffering is 16KiB; service response/worker/rate-limit bounds and audit hooks are shared.

Reference README declares MIT; its inspected root has no standalone LICENSE and package.json
has no license field. No reference source was copied, so no MIT source/notice was imported.
Architecture attribution is in README and the comparison document. System Graph stays Apache-2.0;
all existing third-party/legal files and dependency versions are unchanged.
Existing HCL-enabled distribution restrictions remain; this refactor adds no new release clearance claim.

## Compatibility and remaining limits

The intentional launch change is npm start selecting stdio; use start:remote for its old behavior.
Tool descriptions are more specific. Tool names/input schemas/public response semantics and Remote
paths are retained. dist/index.js is a generated launcher; compiled source remains under dist/src
to preserve existing scripts/tests/containers.

Local identity lasts for the process lifetime; it is not a Remote JWT or OAuth session. Restart for
configuration/identity changes. Do not network-share the local pipe. No OAuth/hosting/tenant redesign.
Windows MSVC, native ARM64, long soak and actual company GUI-client configuration are not validated.
Windows/Linux command+args and official Inspector configuration were validated.
Production deployment, public hosting, complete release/image distribution gates and a rebuilt scratch
runtime image are outside this verification. Docker verification and storeverification targets passed.
Historical beta SOURCE_SHA256SUMS and published artifacts were retained; any future release must
generate fresh manifests/SBOM/artifact-specific evidence. No production readiness is implied.

## Changed files

- Dockerfile
- README.md
- docs/mcp-template-refactor.md
- docs/mcp-template-validation.md
- docs/public-api.md
- docs/security-model.md
- examples/stdio-mcp.json
- package-lock.json
- package.json
- scripts/build-entry.mjs
- scripts/distribution/build-rootfs.mjs
- scripts/inspect-stdio.mjs
- scripts/sample.mjs
- src/graph/stdio-runtime.ts
- src/index.ts
- src/public-runtime.ts
- src/remote-mcp.ts
- src/server/index.ts
- src/tools/capabilities.ts
- src/tools/explain.ts
- src/tools/handler.ts
- src/tools/impact.ts
- src/tools/index.ts
- src/tools/inventory.ts
- src/tools/query.ts
- src/tools/trace.ts
- src/transports/remote.ts
- src/transports/stdio.ts
- tests/stdio.test.ts

## npx launch follow-up

The default MCP client example now uses npx --yes --package=github:NaoyaRyoke/system-graph#refactor/company-mcp-template system-graph. The node launcher remains supported. package.json adds prepare (TypeScript build only), a runtime/legal files allowlist and test:npx; npm publication stays disabled. No dependency, graph engine, auth, schema or tool logic changes. The CI checks include packaged npx startup.

On Windows Node 24.22.1 / npm 12.2.1, npm run test:npx passed package allowlist/license checks, initialize, tools/list, every tool, stdout protocol purity and clean EOF using a freshly packed package and isolated npm cache from a working directory containing spaces. The normal JavaScript suite remains 62/62 PASS; build passes. The npm pack result parser accepts npm 11 array and npm 12 name-keyed output. The client command explicitly selects --package and system-graph rather than relying on package/bin inference. GitHub source fetch and automatic prepare build from commit 624157b18dcb9fbaeaafa0399c8d59904edc8489 were then verified against a fresh npm cache: initialize/list/all six tools, protocol-only stdout and clean EOF passed. npm 12 defaults allow-git to none; this verification explicitly used --allow-git=root for this invocation, without changing global config. README documents the npm 12 flag. Rust binaries and graph/config files remain local prerequisites.
