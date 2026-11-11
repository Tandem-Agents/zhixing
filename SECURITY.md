# Security Policy

## Current release status

Zhixing has not published a supported public release yet. Version `0.1.0` is an unreleased candidate, so there is currently no supported-version promise or security-response service-level agreement.

Platform targets and pending acceptance are listed in the [release notes](./docs/delivery/releases/0.1.0.md). Implemented adapters or a passing test on one operating system do not constitute a support promise for another.

## Reporting a vulnerability

Do not disclose suspected vulnerability details in a public issue, discussion, pull request, log, or other public channel. Never include API keys, tokens, SecretStore data, private file contents, personal information, or unreviewed full logs.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Tandem-Agents/zhixing/security/advisories/new). Reports are shared privately with the repository's maintainers.

Include only sanitized information needed to reproduce and assess the issue:

- the affected Zhixing version and supported environment;
- the security impact and affected boundary;
- minimal reproduction steps using non-sensitive example data;
- the expected and actual result; and
- non-sensitive evidence sufficient to distinguish the issue.

Do not test against systems, accounts, devices, or data you do not own or have explicit authorization to use.

## Security boundaries

- Zhixing keeps runtime state on the user's devices, but prompts, context, and tool results may be sent to the configured model provider.
- Configured MCP services, message channels, model providers, and network tools are external services with their own permissions, retention, availability, and cost policies.
- File and command tools have real effects. Zhixing enforces trust, permission, and confirmation boundaries, but it is not an operating-system-level strong isolation sandbox.
- `zz doctor` is intended to be a read-only, offline diagnostic entry and should not print secrets or sensitive internal paths. Review and sanitize all information before sharing it.

See the [README](./README.en.md) for the supported environment, data flow, execution boundaries, and current limitations.
