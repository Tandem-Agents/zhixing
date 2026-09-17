<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="assets/brand/readme-hero.en-static.png">
  <img src="assets/brand/readme-hero.en.png" width="100%" alt="Zhixing: an office computer, an outdoor phone and a cafe laptop in different places collaborate for one person. A companion-intelligence vision illustration, not a product interface.">
</picture>

<h1 align="center">A personal assistant for life and work.</h1>

<p align="center">
  <a href="#getting-started">Get started</a> · <a href="docs/README.md">Docs</a> · <a href="docs/philosophy.md">Philosophy</a> · <a href="research/design/architecture/overview.md">Architecture</a> · <a href="assets/brand/readme-hero.en-static.png">Static image</a>
</p>

**Zhixing is a self-hosted, general-purpose personal AI agent.** Running on your own devices, it can read documents, discuss ideas, help you plan, work with files, write code and carry out tasks—for everyday life as well as professional work.

Our long-term direction is **companion intelligence**: the same Zhixing working across your phones, computers and servers, interacting through the device nearest to you and staying by your side in life and work. The product is not tied to a particular model, interface or device. Technology serves people's needs.

## From a conversation to ongoing work

**Think things through.** Research, compare options, write and analyze. Bring multiple perspectives to a question when another angle would help. A useful discussion need not become an execution task.

**Get things done.** Read, search and edit files, run commands, and work with data or code. Break down, delegate and track complex tasks. Finding methods and using tools serve your goal, without requiring you to orchestrate every step.

**Pick up where you left off.** Save and resume conversations. Use work scenes to organize separate working contexts and directories, and schedule tasks for later. Independent conversations can also read and message one another, so you do not have to relay everything yourself.

**Work in your own environment.** Use the terminal or connect Feishu. Choose your model provider, keep reusable methods in Skills, and connect external tools and services through MCP. One device is a complete setup; paired devices are optional.

For example, bring your own material and ask:

> “Compare these travel guides and draft an itinerary around my budget and dates. List the choices you still need me to make.”

> “Read this project's documentation and code, explain how it runs, and list the issues you can substantiate. Don't modify any files yet.”

## One core, many forms

Zhixing does not build a separate assistant for every interface. **A shared core owns the product's rules and authoritative state; interfaces and devices provide different ways to interact and execute.** The terminal, Feishu and paired devices serve the same product.

- **The product is not tied to a model.** Conversations, work scenes and schedules own their rules. Models understand, reason and act; they do not define the whole system.
- **Reliability is a system responsibility.** Durable state, permissions, confirmations and recovery do not depend on a model always getting things right. A claim of completion is not a substitute for execution evidence.
- **Extension does not fragment the product.** Models, tools, channels and devices connect through defined interfaces. Replacing an implementation should not require duplicating business rules.

The aim is to benefit from improving models while keeping the system maintainable over time. Read the [product philosophy](docs/philosophy.md) and [architecture overview](research/design/architecture/overview.md) for the full design.

## Getting started

> [!IMPORTANT]
> **The first public release is not out yet; the npm package is unavailable.** To run from source now, follow the [development setup](CONTRIBUTING.md#development-environment). The steps below are the user installation flow for after publication.

The initial supported environment is **Windows 10/11 x64 · Node.js ≥ 24**. You need a working model service and API key. Calls may incur charges and send request contents to your chosen provider.

### 1. Install

Run in PowerShell:

```powershell
npm install -g @zhixing/cli
zz --version
```

### 2. Start and configure

Open the directory you want Zhixing to work in, then run `zz` (or `zhixing`). For a first try, create a separate directory:

```powershell
New-Item -ItemType Directory -Force .\zhixing-start | Out-Null
Set-Location .\zhixing-start
zz
```

If required settings are missing, Zhixing opens the configuration editor. Choose the main model's provider and model, enter your API key, and save. Feishu and MCP can be configured later. Credentials stay in the device-local SecretStore, not in conversations or public configuration.

An explicit runtime workspace or `workspace.root` setting takes precedence; otherwise, interactive startup uses the current directory. A separate directory makes a first task easier to inspect; **it is not a sandbox**.

### 3. Complete a first task

```text
Create only hello-zhixing.txt in the current working directory,
write “Hello, Zhixing” into it, then read it back to verify.
Do not modify any other files.
```

When a confirmation appears, check the action and path. Inspect the resulting file in that directory. Next, use `/new` for a new conversation, `/resume` for history, `/work` for work scenes, and `/skills` to browse skills. See the [CLI guide](packages/cli/README.md) for the full reference.

## Data and boundaries

- **Self-hosted does not mean offline.** Runtime state is stored on your devices, but prompts, context and tool results may be sent to model providers. MCP, Feishu and network tools also contact their respective external services.
- **Actions have real effects.** Trust, permission and confirmation policies govern tool use. Not every action prompts for confirmation, and these controls are not a strong OS-level sandbox. Start with material and working directories you are comfortable giving it access to.
- **Current capabilities are not the long-term vision.** Conversation persistence and recovery exist today; long-term memory does not. Companion intelligence is a direction, not a claim of always-on assistance in every situation.

Use `zz status` to inspect runtime status and `zz doctor` for read-only offline diagnostics. See the [installation and maintenance guide](research/design/modules/distributed-runtime/release-and-maintenance-guide.md) for updates, backups, removal and data retention, and the [0.1.0 release notes](docs/delivery/releases/0.1.0.md) for current scope.

## Help shape Zhixing

Bring real usage problems, ideas or code. What matters is whether Zhixing makes everyday life and work better.

[Issues and suggestions](https://github.com/Tandem-Agents/zhixing/issues) · [Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security policy](SECURITY.md)

Do not post credentials, private material or unreviewed logs. Follow the security policy's current reporting channels for suspected vulnerabilities; do not disclose them in a public issue.

---

<p align="center">
  Understanding informs action. Action deepens understanding.<br>
  <a href="LICENSE">MIT License</a>
</p>
