# Zhixing

> Know, then act; act, then know. Zhixing is a personal agent that runs on your own devices, combining conversation with real task execution inside explicit boundaries.

[中文](./README.md) · [Documentation index](./docs/README.md)

> Release status: the first public release is being prepared; the npm installation command below applies only after the package is published.

## What it is for

- Continue recoverable everyday conversations with clear context across work scenes.
- Read and write files, search content, run commands, and complete multi-step tasks within the applicable trust and permission policies.
- Manage work scenes, task lists, and schedules, with multi-perspective analysis and subtask orchestration.
- Use Skills, configured MCP services, and optional Feishu and multi-device capabilities.

## Supported environment

The first public release formally supports:

- Windows 10/11 x64
- Node.js `>=24.0.0`
- global installation with npm

Other operating systems, CPU architectures, and package managers are outside the initial support scope.

## Quick start

### 1. Install

After the package is released, run in PowerShell:

```powershell
npm install -g @zhixing/cli
zz --version
```

Do not use `sudo npm` or relax system-directory permissions. If the global npm directory is not writable, use Node.js's supported user-level setup.

### 2. Start in a separate trial directory

Zhixing selects an explicitly supplied runtime workspace first, then `workspace.root` from configuration, and falls back to the current directory only for an interactive session without either setting. A normal working directory is not a sandbox and cannot prevent tools from accessing other paths. Start a first trial from a separate directory, and check the actual target directory first if you already have workspace configuration:

```powershell
New-Item -ItemType Directory -Force .\zhixing-first-task | Out-Null
Set-Location .\zhixing-first-task
zz
```

On the first interactive run, Zhixing opens the configuration editor when required settings are incomplete. The minimum runnable configuration needs:

- a provider and model name for the main model;
- the corresponding provider API key;
- your confirmation to save the configuration.

Public configuration defaults to `%USERPROFILE%\.zhixing\config.jsonc`; set `ZHIXING_HOME` to use another Zhixing data root. API keys are stored in the device-local SecretStore and should never be placed in `config.jsonc`, prompts, repositories, issues, or logs. Message channels and MCP are optional and do not block basic conversation readiness. Later, use `/config` and `/mcp` inside the REPL to edit them.

### 3. Complete a real first task

Send this prompt in the REPL:

```text
Only in the current working directory, create zhixing-check.txt containing “Zhixing completed its first task”, read the file back, and tell me its contents. Do not modify any other file.
```

Zhixing may allow, deny, or request confirmation according to the current trust and permission policies. If a confirmation request appears, check its target path and effect before approval. After leaving the REPL, verify it in the same PowerShell session:

```powershell
Get-Content .\zhixing-check.txt
```

This task calls your configured model provider. Network requests, provider charges, and that provider's data policy may apply.

## Continue conversations and manage work

Running `zz` enters the default REPL. It resumes the newest resumable main conversation when one exists and otherwise creates a new one.

| Goal | REPL commands |
| --- | --- |
| Create, resume, name, or clear a conversation | `/new`, `/resume`, `/name`, `/clear` |
| Inspect status, model, usage, and context | `/status`, `/model`, `/usage`, `/context` |
| Manage work scenes and tasks | `/work`, `/tasks` |
| Manage configuration, MCP, trust, and security | `/config`, `/mcp`, `/trust`, `/security` |
| Inspect available Skills | `/skills` |
| Compact the current context or exit | `/compact`, `/exit` |

Device-level diagnostics and maintenance use `zz status`, `zz doctor`, `zz stop`, `zz app`, `zz pair`, `zz device`, `zz duty`, `zz backup`, and `zz workspace`. Use `zz help` and the [CLI guide](./packages/cli/README.md) for exact parameters.

## Data, network, and execution boundaries

- Zhixing's runtime and local state live on your devices, but that does not mean all data always stays local. Prompts, context, and tool results are sent to your configured model provider when needed for a task.
- MCP, message channels, and network tools contact their respective external services. Each service's permissions, charges, retention, and privacy policy apply.
- File and command tools have real effects. Zhixing enforces trust, permission, and confirmation boundaries, but it is not currently an operating-system-level strong isolation sandbox. Policy-allowed operations may run directly; when a confirmation request appears, inspect its paths and actions before approval.
- `zz doctor` is a read-only, offline diagnostic entry and should not print secrets or sensitive internal paths. Never post API keys, SecretStore data, private file contents, or unreviewed full logs in a public support channel.

## Diagnose, update, and uninstall

Inspect status and the local environment:

```powershell
zz status
zz doctor
```

For a same-version repair, capture the current exact version and reinstall that version:

```powershell
$ZhixingVersion = zz --version
zz stop --maintenance
npm install -g "@zhixing/cli@$ZhixingVersion"
zz
```

For an intentional forward upgrade, safely stop Zhixing and install the selected newer version. To install the latest version:

```powershell
zz stop --maintenance
npm install -g @zhixing/cli@latest
zz
```

You can replace `latest` with an exact newer version you have selected. Zhixing does not replace its program in the background, and downgrade is unsupported after a newer version has run. To uninstall the program while retaining all user data:

```powershell
zz app remove
npm uninstall -g @zhixing/cli
```

Permanently removing the current device and its local data is a separate destructive operation: `zz device remove --permanent`. Do not treat it as normal uninstall. See the [installation, maintenance, and release guide](./research/design/modules/distributed-runtime/release-and-maintenance-guide.md) for the full procedure.

## Current limitations

- Initial formal support is limited to Windows 10/11 x64 and Node.js 24 or newer.
- There is no background auto-update, and downgrade after running a newer version is unsupported.
- Skills and MCP are current capabilities, but Zhixing does not claim an unlimited plugin platform. Unreleased future capabilities, including long-term memory, are outside the first-release contract.
- Zhixing alone cannot guarantee strong OS isolation, external-service availability, model quality, or provider cost.

## Repository and documentation

```text
packages/   Production packages
docs/       User and delivery documentation entry points
research/   Architecture, design, and research
scripts/    Build, verification, and release scripts
```

- [Documentation index](./docs/README.md)
- [CLI guide](./packages/cli/README.md)
- [Architecture overview](./research/design/architecture/overview.md)
- [First public release delivery plan](./docs/delivery/first-public-release.md)
- [0.1.0 release notes](./docs/delivery/releases/0.1.0.md)
- [Verification runbook](./research/design/workbench/verification-runbook.md)
- [Contributing guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security policy](./SECURITY.md)
- [Bug and feature requests](https://github.com/Tandem-Agents/zhixing/issues)

Do not disclose suspected vulnerability details in a public issue. See the [security policy](./SECURITY.md) for the current private-reporting and supported-version status.

## License

[MIT](./LICENSE)
