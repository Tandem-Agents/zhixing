# Security Policy

## Current release status

Zhixing has not published a supported public release yet. Version `0.1.0` is an unreleased candidate, so there is currently no supported-version promise or security-response service-level agreement.

The initial release scope is Windows 10/11 x64 with Node.js 24 or newer. Other operating systems, CPU architectures, and package managers are outside that scope.

## Reporting a vulnerability

Do not disclose suspected vulnerability details in a public issue, discussion, pull request, log, or other public channel. Never include API keys, tokens, SecretStore data, private file contents, personal information, or unreviewed full logs.

Private vulnerability reporting is not currently enabled, and the project does not currently publish a private security email address or another private intake channel. This policy will name a verified private channel only after one is actually available. Until then, there is no project-authorized destination for vulnerability details, and the first public release must not be declared ready on the strength of this file alone.

When a private channel is enabled, a useful report should contain only sanitized information needed to reproduce and assess the issue:

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
