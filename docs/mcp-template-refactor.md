# MCP template comparison and migration

Reference: [yryuu/mcp-api-requester](https://github.com/yryuu/mcp-api-requester), main 75a2c8b0add0c86ca508f5403b12dadfd354e9fe inspected on 2026-11-09.
Target baseline: public main 7dd66281d9cf2fb7c072ce3b2721572d03c39dcb / v0.1.0-beta.1.
This is an independent structural refactor, with no copied reference source and no runtime dependency on that repository.

| Area | Reference | System Graph baseline / decision |
| --- | --- | --- |
| Package | ESM, main/bin dist/index.js | private ESM; add main/bin and dist/index.js launcher |
| TypeScript | ^5.7.2, Node16/ES2022 | keep 5.9.3, strict NodeNext/ES2023 |
| SDK | @modelcontextprotocol/sdk ^1.0.4 | keep server/core/client 2.4.0; v1 SDK 1.32.2 stays test-only |
| Initialization | low-level Server, tools capability | keep McpServer/registerTool; extract shared factory |
| Registration | Tool[] plus list/call switch in index | six typed module definitions, one shared registry |
| Tool separation | src/tools/http.ts, response envelope in index | src/tools per operation; common envelope; QueryService retains graph projection |
| Schemas | hand-written JSON schema; zod ^3.24.1 declared but unused in inspected entry/tool | keep Zod 4.6.7 strict input and response validation |
| Errors | tool isError with error message; HTTP errors serialized | keep safe typed codes, no raw graph/SQL/path/error echo |
| Transport | stdio only | add v2 serveStdio with legacy opening support; keep both HTTP endpoints |
| Lifecycle | connect, stderr startup/fatal log, process.exit on fatal | warm first, EOF/SIGINT/SIGTERM shutdown, abort and close Rust workers |
| Build | tsc/watch/prepare | tsc plus standard launcher; existing dist/src and dist/tests retained |
| Tests | tsx manual HTTP GET/POST/404/cookie calls | existing automated security/Rust/Remote suite plus stdio protocol tests |
| README | node command+args, npx, Inspector | local build and explicit configuration, Windows command+args, Inspector |
| Security | documents arbitrary HTTP and SSRF risk | retain read-only graph boundary; no HTTP request tool or Axios |
| Rust/store | none | persistent child NDJSON, capability/schema negotiation, read-only SQLite unchanged |
| Auth/isolation | trusted local HTTP requester | existing Remote JWT/dev bearer unchanged; stdio explicit local principal, same policy/service |
| Docker | no inspected template Docker workflow | keep Remote entrypoint, include standard launcher in build |
| API | make_request | exactly graph_capabilities/inventory/query/impact/trace/explain |

## Architecture

```text
src/index.ts → transports/stdio.ts ─┐
                                 ├→ server/index.ts → tools/* → QueryService
src/main.ts → transports/remote.ts ┘                              ↓
                                                    EnginePool → RustClient
                                                                 ↓ private NDJSON
                                                       Rust engine → SQLite
```

Root remote-mcp.ts remains an import compatibility facade. Root service.ts, rust-client.ts,
engine-pool.ts and their imports remain stable to avoid an unrelated filesystem migration.
The graph runtime shares registry/permissions, path checks, pool and service construction between
public-runtime.ts (Remote auth) and graph/stdio-runtime.ts (OS-local identity).
No tool calls RustClient directly. All six tools share a single handler/envelope implementation.

## Compatibility

Tool names, strict input schemas, structuredContent, text success marker, typed service errors,
server identity, graph projection, provenance, explicit false, ranked lexical semantics,
impact/trace semantics, permission/environment prefiltering and engine bytes are preserved.
Descriptions now explain each operation. Modern metadata/cache behavior remains unchanged.

**Launch change:** npm start now selects stdio. Use npm run start:remote -- CONFIG ENGINE
for the former npm start behavior. Direct dist/src/main.js, Docker and HTTP endpoints remain.
dist/index.js is a small generated launcher importing compiled src/index.ts at dist/src/index.js;
this preserves existing test/build/Docker consumers of dist/src instead of moving their outputs.

stdio accepts operator paths only through startup args or SYSTEM_GRAPH_CONFIG/SYSTEM_GRAPH_ENGINE.
It requires a separate strict local config with localPrincipal (no auth field). Identity is fixed for
the process lifetime and authorization is checked on every call. OS account/pipe/config access is the
authentication boundary; the launcher must not be exposed as an unauthenticated network service.
No token expiry/revocation claim is made for local identity. Restart to change registration or identity.

## Licensing

The reference README declares MIT; package.json has no license field and the inspected root has no standalone
LICENSE file. No source, HTTP implementation or license text was copied. Only architectural ideas
(entrypoint, modules, stdio and client launch shape) inform this independently written change.
System Graph remains Apache-2.0; LICENSE, NOTICE, THIRD_PARTY_NOTICES and licenses/ are retained.
Existing HCL-enabled distribution restrictions remain. Inspector is a local verification dependency
only and is not added to package.json, the runtime image or distribution notices.

## Verification

Run npm run build, npm run typecheck, npm test and npm run demo after a locked Rust host build.
The stdio suite runs real command+args subprocesses from a different cwd, compares six structured
responses against the original QueryService, checks graph bytes, isolation and protocol purity,
and exercises current and legacy protocol openings. The existing suite still covers Remote current
and legacy clients, JWT, ingress bounds, cancellation, worker faults and response projection.
Inspector verification is reproducible with scripts/inspect-stdio.mjs; see README.
Results and platform limits are recorded in docs/mcp-template-validation.md.

## npx follow-up

The company-style default client command is now npx -y --package=github:NaoyaRyoke/system-graph#refactor/company-mcp-template system-graph. A prepare lifecycle compiles TypeScript from Git source before npm packs it. The files allowlist includes only the compiled MCP runtime, README and existing legal notices; it excludes graph/config/test/cache/Rust artifacts. The Rust host and local graph config remain operator-provisioned. private=true remains; nothing is published to npm. The local node command remains supported. See the README for Windows npx.cmd/cmd setup and npm run test:npx.
