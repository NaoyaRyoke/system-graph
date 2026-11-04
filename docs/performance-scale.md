# Scale and soak results

Synthetic graph: **10,000 nodes / 50,000 cyclic edges**, approximately 78MiB standalone SQLite snapshot. The public cap is 12,000 nodes / 60,000 edges; a 12,001-node fixture is rejected before hydration. A 100k graph was not measured and is outside the supported cap.

Windows GNU debug engine, Node24.22.1; warm persistent worker. Five operations, concurrency1/5/10, three rounds per cell. These are service and localhost MCP measurements, not WAN/TLS/OAuth/Linux production SLAs. Each successful operation still loads/selects a graph using native semantics. No queue is introduced: overloaded requests return busy or HTTP429, not automatic retries.

| layer | operation | concurrency | successes | outcomes | successful median ms | successful max ms |
|---|---|---:|---:|---|---:|---:|
| TS→Rust | query | 1 | 3 | {'ok': 3} | 2436.65 | 2448.53 |
| TS→Rust | query | 5 | 3 | {'ok': 3, 'busy': 12} | 2424.13 | 2440.69 |
| TS→Rust | query | 10 | 3 | {'ok': 3, 'busy': 27} | 2433.19 | 2449.02 |
| TS→Rust | impact | 1 | 3 | {'ok': 3} | 2489.72 | 2499.29 |
| TS→Rust | impact | 5 | 3 | {'ok': 3, 'busy': 12} | 2491.97 | 2493.55 |
| TS→Rust | impact | 10 | 3 | {'ok': 3, 'busy': 27} | 2477.29 | 2491.94 |
| TS→Rust | trace | 1 | 3 | {'ok': 3} | 2454.36 | 2458.46 |
| TS→Rust | trace | 5 | 3 | {'ok': 3, 'busy': 12} | 2454.07 | 2454.64 |
| TS→Rust | trace | 10 | 3 | {'ok': 3, 'busy': 27} | 2454.84 | 2456.52 |
| TS→Rust | explain | 1 | 3 | {'ok': 3} | 2378.02 | 2379.4 |
| TS→Rust | explain | 5 | 3 | {'ok': 3, 'busy': 12} | 2359.43 | 2362.6 |
| TS→Rust | explain | 10 | 3 | {'ok': 3, 'busy': 27} | 2365.86 | 2371.09 |
| TS→Rust | inventory | 1 | 3 | {'ok': 3} | 2379.58 | 2382.37 |
| TS→Rust | inventory | 5 | 3 | {'ok': 3, 'busy': 12} | 2372.06 | 2376.61 |
| TS→Rust | inventory | 10 | 3 | {'ok': 3, 'busy': 27} | 2380.74 | 2381.84 |
| localhost MCP | query | 1 | 3 | {'ok': 3} | 2440.09 | 2452.56 |
| localhost MCP | query | 5 | 3 | {'ok': 3, 'busy': 12} | 2434.85 | 2438.6 |
| localhost MCP | query | 10 | 3 | {'ok': 3, 'busy': 27} | 2435.07 | 2444.54 |
| localhost MCP | impact | 1 | 3 | {'ok': 3} | 2501.49 | 2505.22 |
| localhost MCP | impact | 5 | 3 | {'ok': 3, 'busy': 12} | 2495.33 | 2499.74 |
| localhost MCP | impact | 10 | 3 | {'ok': 3, 'busy': 27} | 2502.27 | 2503.94 |
| localhost MCP | trace | 1 | 3 | {'ok': 3} | 2465.62 | 2475.39 |
| localhost MCP | trace | 5 | 3 | {'ok': 3, 'busy': 12} | 2465.78 | 2467.34 |
| localhost MCP | trace | 10 | 3 | {'ok': 3, 'busy': 27} | 2462.93 | 2469.21 |
| localhost MCP | explain | 1 | 3 | {'ok': 3} | 2377.61 | 2396.91 |
| localhost MCP | explain | 5 | 3 | {'ok': 3, 'busy': 12} | 2383.14 | 2383.68 |
| localhost MCP | explain | 10 | 3 | {'ok': 3, 'busy': 27} | 2376.09 | 2382.28 |
| localhost MCP | inventory | 1 | 3 | {'ok': 3} | 2388.34 | 2389.85 |
| localhost MCP | inventory | 5 | 3 | {'ok': 3, 'busy': 12} | 2381.92 | 2388.9 |
| localhost MCP | inventory | 10 | 3 | {'ok': 3, 'busy': 27} | 2382.91 | 2392.13 |

The successful median excludes bounded overload refusals; count columns must be read with latency. Three successful samples per cell are insufficient for a meaningful p95 claim. HTTP admission is four active requests/32 connections; native worker queue depth is zero. Raising ingress concurrency does not create parallel execution inside one workspace.

CPU/RSS/handle snapshots and raw latencies are generated artifacts, not release source. Native/remote tests record parent and exact worker process statistics. Cold graph hydration raises RSS/handles; the short observation cannot prove the absence of long-term leaks. All exact workers are closed/reaped and target listeners stop after tests.

Remote MCP shortened soak: requested 60s, actual 67.3s, 5 rounds; outcomes {'ok': 25}; worker restarts 0. Native service soak: 60s, 5 rounds. **No 30–60 minute result is claimed.**

Reproduce after the quick start: `npm run benchmark` creates the scale fixture; `node scripts/remote-load.mjs` measures localhost MCP. For the full operator soak use `node scripts/remote-load.mjs soak 1800` (30 minutes), or `soak 3600`. A shortened run is `soak 60`. The script uses only generated artifacts and a RAM dev credential, and closes listener/client/worker in finally. Native service-only soak is also available with `npm run soak`.

Beta recommendation: start with ≤2k nodes/10k edges, one in-flight request per workspace, fixed byte/depth/count limits and memory hard limits; measure actual deployment before increasing. The 10k workload takes seconds on this debug setup. Small-graph 256MiB container measurements do not certify 10k/hostile-graph memory sufficiency. Improve native indexed/scoped retrieval or immutable snapshot caching in a later phase; do not reimplement graph semantics in TypeScript. Full Linux scale/soak, hostile-graph fuzzing and process descriptor trends remain should-fix work.

Remote-soak process snapshots (Node + exact Rust worker combined): working set 96.63→101.46MiB; handles 450→451; accumulated CPU delta 60.453s over 67.3s wall time. These are sampled working sets, not an in-request peak or a long-term leak proof. No worker restarted; both processes/listeners were closed after the run.
