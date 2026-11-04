# Threat model

| Actor/risk | Mitigation / evidence | Residual and beta disposition |
|---|---|---|
| Internet attacker | no public listener in validation; operator TLS edge; exact Origin/Host; no CORS | real public edge/OAuth conformance not validated; require deployment gate |
| malicious MCP client | strict args, byte/depth/count limits, auth/admission/timeouts, no write/paths | bursts yield busy/rate_limit; global multi-instance quota is future |
| compromised tenant worker | per-workspace container, private network, readonly DB-only mount, nonroot/capdrop | shared kernel/container escape requires maintained host; isolation configuration mandatory |
| malicious repository/graph | read-only snapshots, source not executed, pre-count cap, bounded projection | malformed/large hostile SQLite still needs fuzzing; assertions are not runtime proof |
| dependency compromise | pinned locks/base/action digests, npm/OSV scan, SBOM | no universal clean bill; native/OS review pending, blocker |
| container escape | no Docker socket/privileged mode, pids/memory/read-only root | no VM boundary or kernel hardening proof; operator responsibility |
| provenance leakage | selected facts, bounded relative paths, credential-pattern redaction | arbitrary unknown secrets cannot be universally detected; ingestion must exclude secrets |
| denial of service | queue zero, worker timeout/cancel/restart caps, graph size cap | large graph hydration is O(N+E); 10k measurements are seconds, not interactive SLA |
| malicious proxy | signed resource-bound assertion, explicit identity mapping | trusted edge can impersonate authorized subjects; protect keys/ingress separately |
| forged tenant/environment | server-side binding+permission scope before engine | config administrators remain trusted; changing config requires review |
| key rotation/revocation | pinned-key replacement fails closed; ten-minute max | no live introspection/refresh; revoke at edge/reload; document operator SLA |
| data mutation | only read tools, read-only store/mount, operator-only sample generator | host administrator can replace files; immutable deployment needed |
| release privacy | explicit source manifest, clean-room copy, privacy scan | known-pattern scan is not exhaustive DLP; human release review required |

Acceptability is conditional on release blockers being closed. No claim of production readiness, hostile-host safety or complete MCP/OAuth conformance follows from fixture success.
