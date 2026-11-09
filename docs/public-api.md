# Read-only public API

All tools require `workspace` (registered alias), with optional `environments` and repository aliases. Tenant/DB/path/URL parameters are not accepted. Missing environment request defaults to the permission's explicit environment list. Unknown context is excluded before traversal. A production graph never merges same-name dev/staging entities by name alone. Explicit false remains distinct from absent/null.

| Tool | arguments in addition to common scope | result |
|---|---|---|
| graph_capabilities | none | API version, operation support, management=false, bounds |
| graph_query | query, limit=10 | native lexical hits/score, scoped coverage, truncation |
| graph_impact | target, direction=upstream, maxDepth=8, limit=20 | direct/transitive native classifications, unknown coverage/risk |
| graph_trace | source, destination, maxDepth=8 | bounded native edge segments, coverage gaps |
| graph_explain | target, kind=node/edge/result | selected assertions and provenance, bounded evidence |
| graph_inventory | limit=20, offset=0 | scoped nodes/edges/counts, current-page facets, nextOffset |

`result` explanation accepts a node ID returned in query results; it is an alias, not an independently persisted result record. Inventory facets are current-page only, not global analytics. Source fields are relative/redacted; raw code, bodies, arbitrary properties and absolute paths are omitted. See security-model.md for the exact projection boundary.

Limit: UTF-8 query 256 bytes (not regex); result nodes 50, edges 100, evidence 16, depth 12, graph hydration 12k nodes/60k edges (pre-counted); HTTP body 16KiB; engine request 64KiB, engine response 1MiB, public response 256KiB. Engine timeout 5s, HTTP total deadline 6.5s, auth wait 2s; four active ingress requests, 32 connections; one in-flight worker request with queue depth zero; bounded restart and per-principal/operation rate limit 60/minute. Limits are a guardrail, not a large-graph latency SLA.

Typed errors: unauthenticated, permission_denied, not_found, invalid_request, rate_limited/retryAfter, busy, cancelled, engine_crash/timeout, graph_unavailable, incompatible_api, unsupported_capability, invalid_engine_response, resource_limit, response_too_large, internal_error. Ingress auth uses HTTP401/403; tool execution errors use MCP isError with a fixed code and no SQL/path/input echo. Unknown/foreign IDs are indistinguishable. No management/write tool exists.

## Private Rust contract

NDJSON pipe, API1.0. Envelope: api_version/id/operation/params; response repeats version/id with ok/result or typed error. Unknown fields and incompatible engine contract/schema fail closed. Operations: health, capabilities, query, impact, trace, explain, inventory. Principal/token/tenant claims never enter the engine request; the enterprise service sends only authorized repo/environment scope and server-selected DB. Internal scope is not a public filesystem selector. Operation addition is capability-negotiated; schema changes require a new derived-schema snapshot, not live migration.

## Transports

The same six tool definitions and QueryService handlers serve stdio, /mcp and /mcp-legacy. Stdout is protocol-only; diagnostics use stderr. Stdio binds an explicit OS-local principal and one workspace, with the same policy/projection. Its input buffer is 16KiB. HTTP headers, ingress/auth deadlines and JWT are Remote-specific. See README for command+args registration and the npm start migration.
