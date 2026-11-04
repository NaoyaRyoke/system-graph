# Private reporting setup

GitHub Private Vulnerability Reporting is a Public-repository feature. Enable it at Settings → Security and quality → Advanced Security → Private vulnerability reporting. Confirm the enabled state after reloading. An eligible signed-in non-admin reporter must see Security → Advisories → Report a vulnerability and the current security policy. An admin's draft advisory UI is not the same test.

The responsible maintainer subscribes to Watch → Custom → Security alerts (or All Activity), does not ignore the repository, and enables personal Subscriptions → Watching → Email. Subscription settings are not proof of delivery; verify receipt and private acknowledgement with an agreed harmless synthetic notification test when an eligible reporter is available. Never publish that test as a public advisory, include secrets, or send a report to an unrelated repository. No fallback email exists.

No beta assets should be announced if PVR is disabled or the private reporting route is unavailable. See SECURITY.md and release-process.md. Do not record reporter personal data or report bodies in release artifacts.

References: [GitHub configuration](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), [reporter workflow](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).
