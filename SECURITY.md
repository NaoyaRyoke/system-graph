# Security policy

## Supported scope

Version 0.1.0-beta.1 is a prerelease, not production-ready. The supported distribution scope is the HCL-free read-only host and its tested platform profile. There is no staffed response-time SLA or bug-bounty commitment.

## Report privately

Use this repository's **Security → Advisories → Report a vulnerability** form. Private Vulnerability Reporting must be enabled before publishing beta assets. SECURITY.md describes policy and does not activate that GitHub feature. If the form is unavailable, do not post vulnerability details in a public issue or discussion; distribution must pause until the private reporting route is restored. No alternative security email is currently offered.

Include version/digest, deployment assumptions, impact and a minimal synthetic reproduction. Authentication/authorization bypass, cross-workspace disclosure, path traversal, command execution, credential disclosure and dependency vulnerabilities are in scope. Remove real code/graphs, credentials, tokens, cookies, session IDs, private keys, personal identities, home paths and production data. Test only systems you are authorized to assess.

The maintainer receives repository Security alerts notifications, acknowledges privately, reproduces with synthetic fixtures and coordinates mitigation, a fix and disclosure with the reporter. Acknowledgement does not confirm severity. Agree publication timing privately and avoid exposing user data or exploitation details while coordinating a fix. No automatic public advisory publication is part of reporting.

## Operator responsibilities and limits

Operators maintain TLS termination, issuer lifecycle, explicit subject/permission mapping, read-only snapshots/mounts, network isolation, host patches and logging retention. Signed-token validation does not implement the complete OAuth lifecycle. Host administrator/kernel compromise and availability guarantees are outside the beta's claimed isolation. Cross-tenant disclosure or auth bypass remains reportable regardless of those limits.

Terraform/HCL-enabled builds are excluded from published artifacts until their unresolved dependency-license condition is separately resolved. Keep all accompanying notices and source obligations.
