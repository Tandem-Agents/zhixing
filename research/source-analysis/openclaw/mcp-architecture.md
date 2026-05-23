# OpenClaw MCP 架构

> 源码调研，基于 `E:\Dev\longxia\_refs\openclaw-main`（TypeScript 单体仓库）。路径相对仓库根，行号为调研时所见。纯事实记录，不含对知行的设计建议。

## 核心结论：MCP 不是一个模块，是三个相互独立的子系统

OpenClaw 源码里 MCP 被拆成三套职责完全不同的子系统，撰文/阅读时必须区分，否则会混淆：

| 子系统 | 角色 | 核心目录 | SDK 用法 |
|--------|------|---------|---------|
| **A. embedded Pi bundle-mcp** | OpenClaw 作 **MCP client**：进程内连接外部 server，工具进 agent 工具集 | `src/agents/pi-bundle-mcp-*`、`mcp-transport*`、`mcp-stdio*` | 官方 SDK `Client` |
| **B. CLI-runner 适配器** | OpenClaw **不自己连**，把 MCP server 定义翻译成下游 CLI（Claude/Codex/Gemini）的原生配置，由子进程 CLI 自己连 | `src/agents/cli-runner/bundle-mcp*.ts` | 不用 SDK，只生成配置 |
| **C. OpenClaw as MCP server** | OpenClaw 作 **MCP server** 对外暴露能力（双向） | `src/mcp/` | 官方 SDK `Server` / `McpServer` |

**docs 与 code 的最大落差**：`docs/cli/mcp.md` 只覆盖了子系统 C（`openclaw mcp serve`）和配置注册表面（`mcp list/set/...`），对真正承载"连外部 MCP 工具"的子系统 A 几乎只字未提（仅 `mcp.md:355-369` 一笔带过 "embedded Pi consumes..."）。

三套都用官方 SDK `@modelcontextprotocol/sdk`，不自实现协议层；唯一自写的是 stdio client transport（仍 `implements` SDK 的 `Transport` 接口）。

---

## 子系统 A：作为 MCP client（embedded Pi）

这是真正"把外部 MCP 工具喂给 agent"的路径。

### 数据流（配置 → 连接 → 工具进 agent）

1. **配置合并** — `bundle-mcp-config.ts:49 loadMergedBundleMcpConfig` 把两层来源合并成 `mcpServers` map：plugin bundle 贡献 + OpenClaw owner 配置 `cfg.mcp.servers`；owner 配置覆盖 bundle 默认（`:63` 注释明示）。
2. **session 级运行时管理器** — `pi-bundle-mcp-runtime.ts:377 createSessionMcpRuntimeManager`，全局单例（`getSessionMcpRuntimeManager:580`），按 `sessionId` 缓存 runtime，带配置指纹（sha1，`createCatalogFingerprint:142`）与 idle TTL 清扫。
3. **连接 + 发现** — `getCatalog`（`:205`）对每个 server：`resolveMcpTransport` → `new Client(...)` → `connectWithTimeout` → `listAllTools`（分页 `listTools`，`:122`），产出 `McpToolCatalog`。
4. **物化成 agent 工具** — `pi-bundle-mcp-materialize.ts:64 materializeBundleMcpToolsForRun`：每个 MCP tool 包成 `AnyAgentTool`，`execute` 内 `runtime.callTool(serverName, toolName, input)`（`tools/call`）。
5. **接入 agent loop** — `pi-embedded-runner/run/attempt.ts:882-898` `getOrCreateSessionMcpRuntime` → 物化 → 与核心工具拼成 `effectiveTools`（`:932`）。

### SDK 与 transport

- 官方 SDK：`pi-bundle-mcp-runtime.ts:3 import { Client } from "@modelcontextprotocol/sdk/client/index.js"`（已核验）。
- transport 工厂 `mcp-transport.ts:78 resolveMcpTransport`（已核验）：
  - **stdio** → 自实现 `OpenClawStdioClientTransport`（`:87`，类在 `mcp-stdio-transport.ts:27`，仍 `implements Transport`，复用 SDK 的 `ReadBuffer`/`serializeMessage`）。
  - **streamable-http** → SDK `StreamableHTTPClientTransport`（`:102-104`）。
  - **sse** → SDK `SSEClientTransport`，fetch 换成 undici 以注入 headers（`:117-119`）。
  - **无 websocket client**：grep `WebSocketClientTransport` 在 MCP 代码零命中。
- transport 选择 `mcp-transport-config.ts:107`：有 `command` → stdio；否则按 `transport` 字段（`sse`/`streamable-http`），缺省回退 `sse`（`:153`）。

### 工具命名约定（关键，docs 未提）

`<safeServerName>__<toolName>`，分隔符 `__`，**没有** Claude Code 那样的 `mcp__` 前缀。
- `pi-bundle-mcp-names.ts:7 TOOL_NAME_SEPARATOR = "__"`；`buildSafeToolName:45` 产出 `${serverName}__${toolName}`（已核验）。
- 约束：server 名 sanitize 截断 ≤30 字符（`TOOL_NAME_MAX_PREFIX:8`），全名 ≤64（`:9`），非 `[A-Za-z0-9_-]` 替成 `-`（`TOOL_NAME_SAFE_RE:6`），重名加 `-2/-3` 后缀。

### JSON Schema 转换：基本透传

`pi-bundle-mcp-materialize.ts:112 agentTool.parameters = tool.inputSchema`，不重写 schema。校验侧自定义 validator：Draft 2020-12 用 `ajv/dist/2020`（strict:false），其余走 SDK 默认 `AjvJsonSchemaValidator`（`pi-bundle-mcp-runtime.ts:60`）。结果转换 `toAgentToolResult`（`materialize.ts:16`）把 `CallToolResult.content` 映射为 agent content，空内容回退 `structuredContent`，`isError` 透传。

### 生命周期

- 握手：`Client.connect(transport)` 由 SDK 跑 initialize；OpenClaw 包超时 `connectWithTimeout`（`:95`），默认 `connectionTimeoutMs=30_000`（`mcp-transport-config.ts:40`），可 per-server 覆盖。
- stdio 启动：`mcp-stdio-transport.ts:42 spawn(command, args, {detached:非win32, shell:false, windowsHide:win32})`，env = SDK `getDefaultEnvironment()` + 用户 env，经 Linux OOM 调分。
- 关闭/进程树清理：`mcp-stdio-transport.ts:112 close()` 先 `stdin.end()` 等 2s，仍存活则 `killProcessTree(pid)`。
- **无自动重连**：`getCatalog` 内某 server 连接失败只 `logWarn` + 跳过（`:285-294`），catalog 缓存后不再重连。
- idle 回收：每 60s 扫，idle 超 `mcp.sessionIdleTtlMs`（默认 10min，`0` 禁用）且无活跃 lease 则 dispose；run 结束调 `retireSessionMcpRuntime*`。

### resources / prompts：未接入

消费侧只调 `listTools`/`callTool`；grep `listResources|readResource|listPrompts|getPrompt` 在 MCP 代码零命中。

---

## 子系统 B：给下游 CLI 注入原生 MCP 配置

OpenClaw 用 CLI-runner 模式驱动 Claude Code/Codex/Gemini 时，**不自己连 MCP**，而是把 server 定义翻译成各 CLI 的原生配置，让子进程 CLI 自己连：
- 总入口 `cli-runner/bundle-mcp.ts`。
- Claude：写临时 `mcp.json` + `injectClaudeMcpConfigArgs`（`bundle-mcp.ts:128`）。
- Codex：`-c mcp_servers=<toml>`（`bundle-mcp-codex.ts:65`）；识别 `openclaw` loopback server（`http://127.0.0.1:<port>/mcp`）时加 `default_tools_approval_mode:"approve"`（`:24`）。
- Gemini：写 `settings.json` 经 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`（`bundle-mcp-gemini.ts:60`）。

---

## 子系统 C：作为 MCP server 对外（双向）

三种对外暴露，都走 stdio（`StdioServerTransport`）：

1. **channel bridge**（`openclaw mcp serve`，CLI 入口 `cli/mcp-cli.ts:30`）：`mcp/channel-server.ts:28 createOpenClawChannelMcpServer` → `McpServer{name:"openclaw"}`，内部经 WebSocket 连 OpenClaw Gateway（`channel-bridge.ts:113`），把已路由的 channel 会话暴露成 MCP。暴露 9 个工具（`channel-tools.ts:23`）：`conversations_list / conversation_get / messages_read / attachments_fetch / events_poll / events_wait / messages_send / permissions_list_open / permissions_respond`。事件队列是 live-only（in-memory），客户端断开即清空（`docs/cli/mcp.md:60-70,192-208`）。
2. **plugin-tools server**（`mcp/plugin-tools-serve.ts`）：`Server{name:"openclaw-plugin-tools"}` 暴露插件注册的工具（供 ACP-hosted 的 Claude Code 使用）。
3. **openclaw-tools server**（`mcp/openclaw-tools-serve.ts`）：暴露内建工具，当前仅 `createCronTool()`。

2/3 共用 `tools-stdio-server.ts:9 createToolsMcpServer`（只注册 `ListTools` + `CallTool`）；`plugin-tools-handlers.ts:21` 过滤 `ownerOnly` 工具，并对每个工具套 `wrapToolWithBeforeToolCallHook`（与 agent 同一 pre-execution 边界）。

### Claude experimental notifications

channel bridge 唯一的"非 tools"能力：`channel-tools.ts:11 getChannelMcpCapabilities` 声明 `experimental: { "claude/channel": {}, "claude/channel/permission": {} }`，向 Claude Code 客户端推送 `notifications/claude/channel[/permission]`（`docs/cli/mcp.md:226`）。通用 MCP 客户端走标准 polling 工具。

---

## 配置面

**(a) owner 配置** `mcp.servers`（canonical schema `config/types.mcp.ts:1`）：
```
McpServerConfig = { command?, args?, env?, cwd?, url?, transport?: "sse"|"streamable-http",
                    headers?, connectionTimeoutMs?, ... }
McpConfig = { servers?: Record<name, McpServerConfig>, sessionIdleTtlMs? }
```
CLI 管理 `cli/mcp-cli.ts`：`mcp list/show/set <name> <json>/unset`。`type:"http"` 经 `mcp-config-normalize.ts:6` 归一为 canonical `transport:"streamable-http"`。

**(b) plugin bundle 贡献**：`.mcp.json` 或 bundle manifest（claude/codex/cursor 三种格式，`plugins/bundle-mcp.ts:44`），支持 `${CLAUDE_PLUGIN_ROOT}` 占位展开。

---

## 安全 / 权限

- **消费侧无逐次确认**，复用统一 tool-policy allow/deny 管线：物化工具打标 `pluginId:"bundle-mcp"`（`materialize.ts:124`），run 中过 `applyFinalEffectiveToolPolicy`（`attempt.ts:911`）；`bundle-mcp` 作为 plugin group 可整体 allow/deny（`tool-policy.ts:144 expandPluginGroups`），单个 `<server>__<tool>` 名也能精确控制；`tools.deny:["bundle-mcp"]` 整体禁用。
- **stdio env 安全过滤**（重点）：用户 `env` 块里"解释器启动型"危险变量被剥离。`mcp-config-shared.ts:49 toMcpEnvRecord` 对每个 key 调 `isDangerousHostEnvVarName`（`infra/host-env-security.ts:98`），黑名单/前缀数据在 `infra/host-env-security-policy.json`：`blockedEverywhereKeys`（`NODE_OPTIONS/PYTHONPATH/PERL5OPT/RUBYOPT/SHELLOPTS/PS4/LUA_INIT…`）、`blockedPrefixes`（`DYLD_`/`LD_`/`BASH_FUNC_`）。
- **server 侧边界**：`plugin-tools-handlers.ts` 过滤 `ownerOnly` + 套 `beforeToolCall` hook；channel bridge 不自造路由，只暴露 Gateway 已知路由，auth 走 Gateway token/password。

---

## ACP（extensions/acpx）与 MCP 的关系

ACP（Agent Client Protocol）是承载层，MCP 是被注入的能力。`openclaw acp` 让 OpenClaw host 一个 coding harness（Claude Code/Codex）并经 ACP 与之对话，MCP server 定义通过 ACP 的 `session/*` 方法传给 ACP agent。
- acpx 是薄包装（真正 ACP runtime 在外部 npm 包 `acpx`，`extensions/acpx/AGENTS.md:7`）。
- `mcp-proxy.mjs`（`extensions/acpx/src/runtime-internals/`）：一个 stdio JSON-RPC 代理 shim，**只在 `session/new`/`session/load`/`session/fork` 上把 `mcpServers` 注入到 params**（`rewriteLine:37`），其余透传；payload 经 `--payload`（base64url JSON）传入。
- 两个内建桥（默认关，需显式开 `pluginToolsMcpBridge`/`openClawToolsMcpBridge`）把子系统 C 的 server 反向喂给 ACP-hosted 的 Claude Code（`extensions/acpx/src/config.ts:159/178`）。

---

## 关键文件清单

**子系统 A（client）**
- `src/agents/pi-bundle-mcp-runtime.ts` — session 级 MCP runtime + 全局管理器：连接、listTools、callTool、idle 回收
- `src/agents/pi-bundle-mcp-materialize.ts` — MCP catalog 物化成 `AnyAgentTool`（命名、结果转换、打 `bundle-mcp` 标）
- `src/agents/pi-bundle-mcp-names.ts` — 命名约定 `<server>__<tool>`、sanitize/截断/防冲突
- `src/agents/mcp-transport.ts` / `mcp-transport-config.ts` — transport 工厂 + 配置解析（stdio/sse/streamable-http）
- `src/agents/mcp-stdio-transport.ts` — 自实现 stdio client transport（spawn / readbuffer / 进程树 kill）
- `src/agents/mcp-config-shared.ts` — env/header/args 归一化 + 危险 env 过滤
- `src/agents/bundle-mcp-config.ts` — 合并 plugin bundle + owner config
- `src/agents/pi-embedded-runner/run/attempt.ts` — agent loop 接入点
- `src/agents/pi-embedded-runner/effective-tool-policy.ts`、`tool-policy.ts`、`tool-catalog.ts` — allow/deny policy + `bundle-mcp` group 展开 + tool profile

**子系统 B（下游 CLI 注入）**
- `src/agents/cli-runner/bundle-mcp.ts`、`bundle-mcp-codex.ts`、`bundle-mcp-gemini.ts`、`bundle-mcp-claude.ts`

**子系统 C（server）**
- `src/mcp/channel-server.ts`、`channel-bridge.ts`、`channel-tools.ts` — `mcp serve` channel bridge
- `src/mcp/tools-stdio-server.ts`、`plugin-tools-serve.ts`、`openclaw-tools-serve.ts`、`plugin-tools-handlers.ts` — 通用 tools server 骨架 + 暴露插件/内建工具

**配置 / CLI / 安全 / ACP**
- `src/config/types.mcp.ts`、`mcp-config-normalize.ts`、`src/cli/mcp-cli.ts`、`src/plugins/bundle-mcp.ts`
- `src/infra/host-env-security.ts`、`host-env-security-policy.json`
- `extensions/acpx/src/runtime-internals/mcp-proxy.mjs`、`config.ts`、`config-schema.ts`

**文档**
- `docs/cli/mcp.md` — 仅覆盖子系统 C + 配置注册表面

## 调研盲点（未深读，撰文边界）
- `cli-runner/bundle-mcp-claude.ts` 的 Claude 适配细节、`config/mcp-config.ts` 的 `mcp set/unset` 落盘实现未展开。
- 外部 `acpx` npm 包的 ACP runtime 内部在仓库外，无法核源码。
