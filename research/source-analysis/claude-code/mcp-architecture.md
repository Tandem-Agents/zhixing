# Claude Code MCP 架构

> 源码调研，基于本地逆向/重写资料。**deobfuscation 层（cleanroom 重写）零 MCP 覆盖**，本文不依赖它。主证据来自 **analysis 层**（`E:\Dev\longxia\_refs\claude-code-analysis`，cleanroom 重写的结构化 TS 源码 `src/services/mcp/`，代表**较新版本**），交叉印证用 **reverse 层**（`E:\Dev\longxia\_refs\claude-code-reverse`，真实抓取的混淆/美化源码 + README + 真实 tool schema，代表**较旧版本**）。路径相对各自资料根。纯事实记录，不含对知行的设计建议。
>
> **版本差异贯穿全文**：reverse（旧）只有 stdio+SSE、CLI 无 url/oauth；analysis（新）有 7 种 transport、OAuth/XAA、企业策略、7 种 scope。命名约定 `mcp__server__tool` 两版完全一致（reverse 硬编码 + analysis 函数化），是最可靠的事实。

## 概述：基于官方 SDK 的全功能 MCP host + server

Claude Code 是 MCP host/client，直接用官方 SDK `@modelcontextprotocol/sdk/client`，不自研协议（`services/mcp/client.ts:7`，已核验）。client identity 声明 `roots` + `elicitation` 两个客户端能力（`client.ts:985-1002`）。同时也能作 MCP server 对外（`claude mcp serve`）。MCP 模块完整目录 `src/services/mcp/`（client.ts、config.ts、types.ts、auth.ts、mcpStringUtils.ts、normalization.ts 等 23 文件）。

### 数据流（连接 → 发现 → 注入）

1. 配置聚合 `config.ts:1258 getAllMcpConfigs()` 收集所有 scope 的 server 配置。
2. 批量连接 `client.ts:2226 getMcpToolsCommandsAndResources()` 拆 local（stdio/sdk）与 remote 两组，各用 `pMap` 并发（本地默认 3，远程默认 20，`client.ts:553/557`）。
3. 单 server `connectToServer`（`client.ts:595`，lodash memoize 缓存，key = `${name}-${JSON配置}`）。
4. 连上后 `Promise.all` 拉 tools/prompts/resources/skills（`client.ts:2344-2355`）。
5. 连接结果是判别联合 `connected | failed | needs-auth | pending | disabled`（`types.ts:221-226`）。

## Transport（7 种，已核验枚举）

判别字段 `type`，枚举 `types.ts:23-25 z.enum(['stdio','sse','sse-ide','http','ws','sdk'])`（已核验），实际连接分支还含 `claudeai-proxy`。全部分支在 `client.ts:619-961`：
- **stdio** `client.ts:944` `new StdioClientTransport({command,args,env,stderr:'pipe'})`；type 缺省也走 stdio。
- **SSE** `client.ts:619` `new SSEClientTransport(new URL(url), options)`。
- **HTTP (Streamable HTTP)** `client.ts:784` `new StreamableHTTPClientTransport`，强制 `Accept: application/json, text/event-stream`（`client.ts:471`）。
- **WebSocket (`ws`)** `client.ts:735` `new WebSocketTransport`，子协议 `['mcp']`，实现在 `utils/mcpWebSocketTransport.ts`。
- **`sse-ide`/`ws-ide`** 内部 IDE 扩展专用（`client.ts:678-734`），非用户配置。
- **`sdk`** in-process SDK server，由 Agent SDK 管理（`client.ts:866`）。
- **`claudeai-proxy`** 走 claude.ai 代理（`client.ts:868`）。
- **in-process linked transport** `client.ts:921 createLinkedTransportPair()`，用于 Chrome/Computer-Use 内置 server 免起子进程。

> reverse（旧版）只有 stdio + SSE（`cli.beautify.mjs:195325` list 只判 `type==="sse"` 否则 stdio）。

## 配置（7 种 scope）

配置文件 `.mcp.json` 顶层 `{ mcpServers: { <名>: <配置> } }`（`types.ts:171`）；settings 同字段名 `mcpServers`。

Scope 枚举 `types.ts:10-20 local | user | project | dynamic | enterprise | claudeai | managed`（已核验）。落盘位置（`config.ts`）：
- `project` → 项目根 `.mcp.json`，从 cwd 向上遍历父目录合并。
- `user` → 全局 `globalConfig.mcpServers`。
- `local` → 项目私有 `projectConfig.mcpServers`。
- `enterprise` → `managed-mcp.json`，存在时**独占控制**屏蔽其它所有 scope（`config.ts:1084`）。
- `claudeai` → claude.ai 连接器（网络拉取）。
- **优先级** `config.ts:1231 plugin < user < project < local`（local 最高）；enterprise 独占；claudeai 最低。

字段 schema（`types.ts`）：stdio `{type?, command, args, env}`；sse/http/ws `{type, url, headers, headersHelper, oauth}`；oauth 子对象 `{clientId, callbackPort, authServerMetadataUrl(强制https), xaa}`（`types.ts:43-56`）。环境变量 `${VAR}` 展开（`config.ts:556`）；server 名仅 `[a-zA-Z0-9_-]`；Windows npx 需 `cmd /c` 包裹提示（`config.ts:1351`）。

**CLI 命令**：reverse 旧版（`cli.beautify.mjs:195280-195339`）`claude mcp serve / add <name> <command> [args...] (-s scope, -e env) / remove / list / get`（add 仅 stdio）。analysis 新版（`cli/handlers/mcp.tsx`）增 `add-json`（任意 JSON 配置，支持远程/oauth）、`add-from-claude-desktop`（从 Claude Desktop 导入）。写入口 `config.ts:625 addMcpConfig(name, config, scope)`。

## 连接生命周期

- initialize/能力协商由 SDK `client.connect(transport)` 完成（`client.ts:1048`）；连后读 `getServerCapabilities/Version/Instructions`（`client.ts:1157`），能力分 tools/prompts/resources/resources.subscribe。
- roots 回调返回 `file://${getOriginalCwd()}`（`client.ts:1009`）。
- 超时：连接 `MCP_TIMEOUT` 默认 **30000ms**（`client.ts:456`，`Promise.race`）；单请求 `MCP_REQUEST_TIMEOUT_MS=60000`；工具调用 `MCP_TOOL_TIMEOUT` 默认 `100_000_000`ms ≈ 27.8 小时（几乎无限，`client.ts:209`）。
- 重连：增强版 `onerror`（`client.ts:1266`）识别终端错误（ECONNRESET/ETIMEDOUT/EPIPE），连续 3 次（`MAX_ERRORS_BEFORE_RECONNECT=3`）主动 close 触发重连（弥补 SDK 不调 onclose）。
- session 过期：HTTP 404 + JSON-RPC `-32001` 判定（`isMcpSessionExpiredError client.ts:193`），工具调用层最多重试 1 次（`MAX_SESSION_RETRIES=1`）。
- onclose 清缓存重连（`client.ts:1374`）；stdio 进程清理 SIGINT→SIGTERM→SIGKILL 渐进（500ms 上限，`client.ts:1429`）。

## 工具发现 + 命名约定 + schema

**命名 `mcp__<server>__<tool>`，双层证实（已核验）**：
- analysis：`mcpStringUtils.ts:39 getMcpPrefix = `mcp__${normalizeNameForMCP(serverName)}__``，`:50 buildMcpToolName`；逆向解析 `mcpInfoFromString:19` 按 `__` split，首段须为 `mcp`。
- reverse 真实代码硬编码：`cli.beautify.mjs:186293 "mcp__" + d.name + "__" + Z.name`（工具）、`:186358`（prompt）——两处均已核验。
- 名字归一化 `normalization.ts:17` 非 `[a-zA-Z0-9_-]` → `_`。

工具发现 `fetchToolsForClient client.ts:1743`：仅当 `capabilities.tools` 存在才 `tools/list`；每个包成 `MCPTool`（`tools/MCPTool/MCPTool.ts`，input schema `z.object({}).passthrough()` 容纳任意 schema）。关键字段：`name`=全限定名、`mcpInfo:{serverName,toolName}`（权限用）、`isMcp:true`、`inputJSONSchema: tool.inputSchema`（**直接透传，不转换**，`client.ts:1813`）；annotations 映射 `readOnlyHint→isReadOnly`、`destructiveHint→isDestructive`、`openWorldHint→isOpenWorld`。description 截断 `MAX_MCP_DESCRIPTION_LENGTH=2048`（`client.ts:218`）。IDE 工具白名单 `ALLOWED_IDE_TOOLS=['mcp__ide__executeCode','mcp__ide__getDiagnostics']`。

> reverse `results/tools/`（17 个内建工具静态 schema）**不含 MCP 工具**——MCP 工具是运行时动态发现，非静态 schema，符合预期。

## Prompts → slash command，Resources → @ 提及

- **MCP prompts 暴露成 slash command**，内部标识名 `mcp__<server>__<prompt>`（双下划线）：`fetchCommandsForClient client.ts:2033`，`name='mcp__'+normalizeNameForMCP(client.name)+'__'+prompt.name`（`:2058`），`type:'prompt'`、`source:'mcp'`；显示名用 `:` 分隔 `${client.name}:${prompt.name} (MCP)`（`:2069`）。执行 `processSlashCommand.tsx:869 getPromptForCommand`。reverse 印证 `cli.beautify.mjs:186358`。
- **MCP resources 用 `@server:uri` 提及**（冒号分隔）：`extractMcpResourceMentions attachments.ts:2792`（正则 `/(^|\s)@([^\s]+:[^\s]+)\b/g`），`processMcpResourceAttachments:1995` split `:` 取 serverName+uri，调 `client.readResource({uri})`，产 `type:'mcp_resource'` attachment。另暴露 `ListMcpResourcesTool`/`ReadMcpResourceTool`（`{server,uri}` → `resources/read`），二进制 blob 落盘不入 context。

## 权限 / 审批

MCP 工具接入**统一权限系统**，按 `mcp__server__tool` 全限定名匹配规则：
- `MCPTool` 默认 `checkPermissions` 返回 `passthrough`（`MCPTool.ts:56`），并附 suggestion：加一条 allow 规则写入 localSettings（`client.ts:1820`）。
- 规则匹配 `permissions.ts:238 toolMatchesRule`，用全限定名（`mcpStringUtils.ts:60 getToolNameForPermissionCheck`），**三种粒度**：精确 `mcp__server__tool`、server 级 `mcp__server1`（匹配该 server 全部）、通配 `mcp__server1__*`。allow/deny/ask 都走此匹配。CLI `--allowedTools`/`--disallowedTools` 可写 `mcp__server__tool`。
- skip-prefix 模式（`CLAUDE_AGENT_SDK_MCP_NO_PREFIX`）：MCP 工具用未加前缀原名，但权限匹配仍用全限定名，避免与同名 builtin（如 Write）误匹配。
- **MCP server 信任（project scope 审批）**：`.mcp.json`（project scope）server 首次需用户审批（`mcpServerApproval.tsx:15`），只有 `approved` 的才进连接集（`config.ts:1166`）。needs-auth server 注入 `McpAuthTool` 占位。
- **企业策略**：`allowedMcpServers`/`deniedMcpServers`（name/command/url 三种 entry），deny 绝对优先；`allowManagedMcpServersOnly` 只认 managed allowlist；`isRestrictedToPluginOnly('mcp')` 锁 plugin-only。

## OAuth / 远程认证（analysis 新版，reverse 旧版无）

- `services/mcp/auth.ts:1376 class ClaudeAuthProvider implements OAuthClientProvider`，用 SDK 的 `discoverAuthorizationServerMetadata`/`auth`/`refreshAuthorization`。
- 浏览器授权码流：`redirectToAuthorization:1852` 校验 scheme 后 `openBrowser`，本地起 `http.createServer` 收回调；PKCE（createHash/randomBytes），敏感参数日志脱敏。
- token 存 `getSecureStorage()`（macOS keychain 等），15 分钟 needs-auth 缓存避免反复探测。401 处理 `handleRemoteAuthFailure` 标 needs-auth。
- **XAA（Cross-App Access / SEP-990）**：`auth.ts:51 performCrossAppAccess`，OIDC IdP 登录。
- **claude.ai 连接器**：`claudeai-proxy` 走 claude.ai OAuth bearer + 代理，401 自动刷新重试一次。

## 作为 MCP server 对外（`claude mcp serve`）

支持。reverse 真实代码 `cli.beautify.mjs:195281 A.command("serve")`。analysis 实现 `entrypoints/mcp.ts:35 startMCPServer`，用 SDK `Server({name:'claude/tengu'}, {capabilities:{tools:{}}})` + `StdioServerTransport`，把内建工具集经 `ListToolsRequestSchema`（`getTools()` + `zodToJsonSchema`）和 `CallToolRequestSchema`（`findToolByName` → `tool.call`）对外。注意 `mcp.ts:62 // TODO: Also re-expose any MCP tools`——暂不转发下游 MCP 工具，只暴露内建。

## 关键文件清单

**analysis 层（新版主证据，`src/services/mcp/` 及周边）**
- `client.ts` — MCP host 核心：所有 transport 连接、工具/资源/prompt 发现与映射、重连/超时/清理、tool 调用（~3349 行）
- `types.ts` — 配置 schema（7 transport + 7 scope）+ 连接状态联合
- `config.ts` — 配置聚合（scope 优先级/合并）、`.mcp.json` 读写、`addMcpConfig`、企业 allow/deny
- `mcpStringUtils.ts` — `mcp__server__tool` 命名构造/解析、权限名
- `normalization.ts` — server/tool 名归一化
- `auth.ts` — OAuth（ClaudeAuthProvider）、授权码流、token 存储/刷新、XAA（2200+ 行）
- `entrypoints/mcp.ts` — `claude mcp serve`（作 stdio MCP server）
- `cli/handlers/mcp.tsx` — `mcp serve/add-json/remove/list/get/add-from-claude-desktop`
- `services/mcpServerApproval.tsx` — project scope server 首次信任审批
- `utils/permissions/permissions.ts` — 权限规则匹配（精确/server 级/通配 `mcp__*`）
- `tools/MCPTool/MCPTool.ts`、`tools/ReadMcpResourceTool/ReadMcpResourceTool.ts` — MCP 工具基底 + resources/read 工具
- `utils/attachments.ts` — `@server:uri` resource 提及解析
- `utils/mcpWebSocketTransport.ts` — WebSocket transport

**reverse 层（真实抓取，旧版交叉印证）**
- `v1/cli.beautify.mjs` — `:186293`/`:186358` 硬编码 `mcp__`+server+tool 命名；`:186283`（tools/list）/`:186348`（prompts/list）发现；`:195280-195339` 真实 `claude mcp serve/add/remove/list/get` CLI（旧版仅 stdio+SSE）
- `v1/README.md:177-184,248-288` — MCP 集成概述（client 类、stdio transport）
- `results/tools/` — 17 个内建工具静态 schema（无 MCP 工具，印证运行时动态发现）

## 调研盲点
- reverse 旧版无 OAuth/远程认证代码（版本差异，新版 analysis 才有）。
- MCP resources 的 `subscribe` 实时更新完整数据流未深读（仅见 capability 标志 `client.ts:1180`）。
