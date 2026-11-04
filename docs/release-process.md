# Release checks

Version remains 0.1.0-beta.1. Publish only HCL-free source and accompanying inventory/notices; HCL-enabled artifacts are not release candidates. This is a prerelease, not a production-readiness claim.

1. Review the exact source manifest and complete Git history, public author metadata, workflows/logs, secret/privacy findings and license inventory. Preserve authoritative legal texts and classify synthetic security-test patterns explicitly.
2. Enable PVR on the actual public repository and verify the reporter entry point, SECURITY.md and maintainer Security alerts/Email subscription. Document any delivery-test limitation accurately; never invent a tested report.
3. Build/test from a fresh anonymous clone using locked dependencies: TypeScript tests/lint/typecheck/build, Rust host tests/fmt/Clippy/build, SQLite regression, container verification and synthetic MCP query/impact/trace/explain. Stop owned processes/listeners, preserve unrelated resources, verify snapshot integrity.
4. Generate a new source ZIP from the reviewed manifest, without .git, caches, databases, credentials, logs or build outputs. Generate the active-profile SBOM and required notices; verify no blocked HCL packages are included. Validate schema/hash/license payloads. Do not reuse an earlier unreviewed ZIP.
5. Tag the exact tested public commit as v0.1.0-beta.1 without rewriting history. Publish a GitHub prerelease with the reviewed source ZIP, SHA256SUMS, SBOM and THIRD_PARTY_NOTICES. GitHub's automatic source archives represent the tagged Git tree and are distinct bytes from the curated manifest ZIP; their hashes are not interchangeable.
6. Download/clone without credentials, verify tag/commit/history/hash agreement, sample behavior and private report entry point. Record exact failures and untested platforms. No npm/container registry publication or new feature is implied.

Do not force push, rewrite tags, silently replace assets/checksums, or strip license text to suppress a finding. A new blocker stops promotion and requires a reviewed correction.
