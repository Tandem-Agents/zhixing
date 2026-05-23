# Hermes Agent MCP 架构

> 源码调研，基于 `E:\Dev\longxia\_refs\hermes-agent-main`（Python 3.11）。路径相对仓库根，行号为调研时所见。纯事实记录，不含对知行的设计建议。

## 概述：单文件 client 核心 + 专用后台事件循环 + 官方 Python SDK

Hermes 的 MCP **client** 逻辑几乎全在一个文件 `tools/mcp_tool.py`（约 122KB）。它把 MCP 当作"动态工具来源"接入既有 `ToolRegistry`，而非独立子系统。同时也能作 MCP **server** 对外（`mcp_serve.py`，FastMCP）。用官方 Python `mcp` SDK，且作为**可选依赖**优雅降级。

核心运行模型：一个专用后台 asyncio 事件循环 `_mcp_loop` 跑在 daemon 线程（`mcp_tool.py:1788 _ensure_mcp_loop`，线程名 `"mcp-event-loop"`）；每个 MCP server 是该 loop 上一个长生命周期 asyncio Task（`MCPServerTask:856`）持有 transport context 存活；同步的 agent 线程通过 `run_coroutine_threadsafe()` 把调用调度到该 loop（`_run_on_mcp_loop:1804`，轮询 future 以响应用户中断）。

### 数据流（配置 → 连接 → 工具进 registry）

1. `discover_mcp_tools():2792` 入口 → `_load_mcp_config():1861` 读 `~/.hermes/config.yaml` 的 `mcp_servers`，做 `${ENV}` 插值。
2. → `register_mcp_servers(servers):2715` 过滤已连接/`enabled:false`，启动后台 loop，**并行** `asyncio.gather` 连接所有 server（`_discover_all:2754`）。
3. 每 server：`_discover_and_register_server:2686` → `_connect_server:1894` 创建 `MCPServerTask` 并 `await server.start()` 等 ready。
4. `_register_server_tools:2578` 把工具转 schema 并 `registry.register(...)`。

### 与 ToolRegistry 的整合（已核验）

注册进**同一个**全局单例 `registry`（`tools/registry.py:437`），与 built-in 工具同一张表。MCP 工具 toolset 命名 `mcp-{name}`（`mcp_tool.py:2593`），handler 是 `_make_tool_handler` 生成的同步闭包，`check_fn` 检查 session 存活。`mcp_tool.py` 被显式排除在 built-in 自动发现之外（`registry.py:62` glob 跳过它），因为它需异步连接而非 import 副作用注册。registry 对 `mcp-` 前缀 toolset 有专门逻辑：允许 MCP→MCP 覆盖（refresh），拒绝 MCP shadow built-in（`registry.py:194-213`，已核验：碰撞跳过保留 built-in），用 `threading.RLock` 保护动态刷新与读线程并发。

注册时机：曾是 `model_tools.py` import 副作用（会阻塞 gateway loop 至多 120s，已移除），现各入口显式调用（`hermes_cli/main.py`、`tui_gateway/entry.py`、`acp_adapter/entry.py`、`gateway/run.py`），热刷新先 `shutdown_mcp_servers` 再 `discover_mcp_tools`。

## SDK：官方 Python `mcp`，可选依赖优雅降级（已核验）

- `mcp_tool.py:175 from mcp import ClientSession, StdioServerParameters` / `:176 from mcp.client.stdio import stdio_client`（已核验）。
- `:179/:186 from mcp.client.streamable_http import streamablehttp_client / streamable_http_client`（优先非废弃 API，mcp ≥ 1.24.0）。
- 类型 `mcp.types`：`LATEST_PROTOCOL_VERSION`、sampling 类型、notification 类型（`tools/list_changed` 等），分组 try-import 让旧 SDK 不破。
- SDK 不存在时 `_MCP_AVAILABLE=False`，整模块 no-op（`:219`）。
- 服务端用 SDK 的 FastMCP（`mcp_serve.py:51`）。

## Transport：仅 stdio + Streamable HTTP，不支持 SSE 客户端（已核验）

- stdio：`_run_stdio:1013`，`stdio_client(server_params, errlog=...)` + `StdioServerParameters`。
- Streamable HTTP：`_run_http:1093`，`streamable_http_client`（新）或 `streamablehttp_client`（旧）。
- 选择：`_is_http():894` 判 config 是否含 `url` 键；两者都有则警告并用 HTTP。
- **无 `sse_client`**：非测试代码 0 命中；`RELEASE_v0.6.0.md` 记录 PR #3646 从 `sse_client` **切到** `streamable_http_client`。HTTP 默认注入 `mcp-protocol-version` header（`LATEST_PROTOCOL_VERSION`，fallback `2025-03-26`）。

## 配置

配置文件 `~/.hermes/config.yaml` 的 `mcp_servers` 键（`hermes_cli/mcp_config.py:8`；home = `HERMES_HOME` 或 `~/.hermes`）。

字段（权威 `website/docs/reference/mcp-config-reference.md`）：
- stdio：`command`、`args`、`env`；HTTP：`url`、`headers`、`auth:oauth`、`ssl_verify`。
- 通用：`enabled`（默认 true）、`timeout`（每次调用，默认 120）、`connect_timeout`（默认 60）。
- `tools`: `include`/`exclude`（白/黑名单，include 优先）、`resources`(bool)、`prompts`(bool)。
- `sampling`: `enabled/model/max_tokens_cap/timeout/max_rpm/allowed_models/max_tool_rounds/log_level`。
- `oauth`: 子配置。

**CLI 管理 `hermes mcp ...`（`hermes_cli/mcp_config.py`，已核验）**：`add:219`、`remove/rm:412`、`list/ls:444`、`test:513`、`configure/config:641`、`login:584`（强制 OAuth 重认证）、`serve:744`（起服务端）。
- `add` 是 **discovery-first**：先临时连接 server 列出工具（`_probe_single_server:160`），再让用户勾选启用哪些（curses checklist），写 `tools.include`。
- stdio 的 API key 存 `~/.hermes/.env`（env key 形如 `MCP_<NAME>_API_KEY`），header 写 `Bearer ${ENV}` 引用；`--env KEY=VALUE` 仅 stdio 支持。

## 连接生命周期（底层全 asyncio，对调用方暴露同步接口）

- 握手：`async with ClientSession(...) as session: await session.initialize()` → `_discover_tools()` → `_ready.set()`。
- 能力协商：SDK 处理 initialize；sampling 能力通过 `SamplingCapability` 传给 `ClientSession`；`message_handler` 仅当 SDK 支持时注入（`inspect.signature` 探测）。
- 超时：`connect_timeout`（初连，`asyncio.wait_for` 包 `_connect_server`）、`timeout`（每次调用）。
- 重连/退避：`run():1214` while 循环 + 指数退避。初连重试 `_MAX_INITIAL_CONNECT_RETRIES=3`，断线重连 `_MAX_RECONNECT_RETRIES=5`，退避封顶 `_MAX_BACKOFF_SECONDS=60`。
- OAuth/session 恢复重连：`_reconnect_event` 触发 transport 拆建不计失败；两类恢复——auth 401（`_handle_auth_error_and_retry:1494` 调 OAuth manager `handle_401`）、session 过期（`_handle_session_expired_and_retry:1643`，只重连不刷 token）。
- **熔断器**：连续失败 `_CIRCUIT_BREAKER_THRESHOLD=3` 开路，冷却 60s，返回"别再重试"提示防模型刷爆迭代。closed/open/half-open 状态机。
- 关闭：`shutdown_mcp_servers():2947` 并行 `server.shutdown()`，等 10s 否则 cancel，deregister 工具；`_stop_mcp_loop():3046` 停 loop + 杀残留 stdio 子进程（`_kill_orphaned_mcp_children`，跟踪 `_orphan_stdio_pids`）。
- 错误处理：anyio TaskGroup 异常解包（`_unwrap_exception_group`）；凭证脱敏 `_sanitize_error`。

## 工具发现 + 命名约定 + schema 转换（已核验命名）

- 发现：`_discover_tools()` → `session.list_tools()`；动态刷新：server 发 `notifications/tools/list_changed` → `_refresh_tools()`（deregister 旧的、重注册、log diff）。
- **命名 `mcp_{safe_server_name}_{safe_tool_name}`**（单下划线分隔、`mcp_` 前缀，`_convert_mcp_schema:2419`，已核验）；`sanitize_mcp_name_component:2403` 把非 `[A-Za-z0-9_]` 全替成 `_`（连字符→下划线）。toolset 名 `mcp-{name}` + 注册裸 server 名为 alias。
- schema 转换 `_normalize_mcp_input_schema:2306` 做跨 provider 兼容修复：`definitions`→`$defs`（Moonshot/Kimi）、缺 type 补 `object`、`required` 剪枝到只含存在的 property（Gemini 400 修复）。最终 `{name, description, parameters}`，再被 registry 包成 OpenAI `{type:"function", function:{...}}`。
- 过滤：include/exclude（include 优先）；与 built-in 同名跳过保留 built-in（已核验）。

> 三家命名约定对比：Hermes `mcp_<server>_<tool>`（单 `_`，非法→`_`）/ OpenClaw `<server>__<tool>`（双 `__`，无前缀，非法→`-`）/ Claude Code `mcp__<server>__<tool>`（双 `__`，非法→`_`）。

## resources / prompts：包装成"utility 工具"（非原生暴露）

每 server 注册 4 个普通工具：`mcp_{name}_list_resources` / `_read_resource` / `_list_prompts` / `_get_prompt`（schema `_build_utility_schemas:2427`，handler 调 `session.list_resources/read_resource/list_prompts/get_prompt`）。双门控：config `tools.resources`/`tools.prompts` 未禁用（默认 true）**且** session 真有该方法（`hasattr`）。`prompts/list_changed`、`resources/list_changed` 通知只 log 不处理（标注 future work）。

## 安全：边界在配置/发现期，而非调用期

MCP 工具调用**不经过** Hermes 的命令审批（`tools/approval.py`，针对危险 shell **命令模式**）或 Tirith 扫描——grep 确认 approval.py / tirith / run_agent.py 均 0 处 MCP 引用，MCP 工具作为普通 registry 工具不触发命令审批（已核验：`run_agent.py` 工具执行走 `_execute_tool_calls*` + approval callback，审批是命令模式，MCP handler 不经此路）。安全集中在配置/发现期：
- **stdio env 白名单**：子进程只透传 `_SAFE_ENV_KEYS`（PATH/HOME/USER/`XDG_*`…）+ 用户显式 env（`_build_safe_env`）。
- **OSV 恶意包检测**：spawn stdio 前查 OSV 库（`check_package_for_malware:1027`）。
- **prompt injection 扫描**：工具描述扫 10 种注入模式（`_scan_mcp_description`），**仅 warning 不阻断**。
- **凭证脱敏**：返回 LLM 的错误剥离 token/key/Bearer。
- **跨域 redirect 剥 Authorization**：HTTP 重定向到不同 origin 删 auth header。
- **工具选择白名单**：include/exclude + `hermes mcp add` 默认让用户勾选启用哪些工具。

## OAuth 2.1 PKCE

`tools/mcp_oauth.py` 用 SDK `OAuthClientProvider` 子类，token 存 `HERMES_HOME/mcp-tokens/<server>.json`（按 profile 隔离）。进程级单例 `MCPOAuthManager`（`tools/mcp_oauth_manager.py`）：provider 缓存、跨进程 token 磁盘 watch、401 去重、`handle_401` 恢复决策。`hermes mcp login` 强制重认证（清磁盘+内存缓存触发新流程）。

## 作为 MCP server 对外（`hermes mcp serve`）：消息桥

`mcp_serve.py` 用 SDK `FastMCP("hermes")`，`@mcp.tool()` 注册 10 个工具，`server.run_stdio_async()` 跑 **stdio**。暴露的是**消息桥**（非 agent 推理）：`conversations_list / conversation_get / messages_read / attachments_fetch / events_poll / events_wait / messages_send / permissions_list_open / permissions_respond / channels_list`，让外部 MCP 客户端（Claude Desktop/Cursor/Codex）操作 Hermes 的跨平台消息会话。这与作为 client 的 `mcp_tool.py` 完全独立，仅共享同一 `mcp` SDK 包。（形态与 OpenClaw 的 channel bridge 高度对应。）

## ACP（acp_adapter）与 MCP 的关系

ACP（Agent Client Protocol）= Hermes 作**被驱动的 agent**，被外部 editor/IDE 经 `acp` 库 JSON-RPC over stdio 调用（`acp_adapter/entry.py:99`）。MCP = Hermes 作 **client** 连外部工具 server。两者正交但有交点：ACP 协议允许客户端建会话时声明 MCP server（`McpServerStdio`/`McpServerHttp`/`McpServerSse`），`_register_session_mcp_servers:251` 把它们映射成 Hermes `mcp_servers` 格式，**复用同一个** `register_mcp_servers` 接入。注意：映射只对 `McpServerStdio` 走 command/args，**其余（含 `McpServerSse`）一律当 HTTP `url`**——与"无 SSE 客户端"一致。

## 关键文件清单

- `tools/mcp_tool.py` — MCP **client 核心**：后台 asyncio loop、`MCPServerTask` 生命周期、stdio/HTTP transport、工具发现+注册、sampling、熔断、重连、动态刷新
- `tools/registry.py` — 全局 `ToolRegistry`，MCP 工具与 built-in 共表（`mcp-` toolset 特殊处理 + 线程锁）
- `hermes_cli/mcp_config.py` — `hermes mcp add/remove/list/test/configure/login/serve` CLI，管理 `config.yaml` 的 `mcp_servers`，discovery-first
- `tools/mcp_oauth.py` / `tools/mcp_oauth_manager.py` — OAuth 2.1 PKCE provider + 进程级单例 manager（token 磁盘存储/401 恢复）
- `mcp_serve.py` — Hermes 作 MCP server（FastMCP，stdio），10 个消息桥工具
- `acp_adapter/server.py` / `entry.py` — ACP agent；`_register_session_mcp_servers` 映射 ACP 声明的 MCP server 复用接入
- `model_tools.py` — 工具发现编排（MCP 发现已从 import 副作用移除，各入口显式触发）
- `website/docs/reference/mcp-config-reference.md` — config schema 权威文档

## 调研盲点 / 阴性结论
- "MCP 工具不经调用期命令审批"是阴性结论：已核 approval.py / tirith / run_agent.py 三处无 MCP 特判，且 `run_agent.py` 工具执行路径（`_execute_tool_calls*`）的 approval 是命令模式 callback；如需写"完全不受任何调用期 gating"的更强结论，建议再核 agent 主循环对所有工具的统一拦截路径有无遗漏。
- mcp_tool.py 的 sampling 回调、`_make_message_handler` 细节未逐行展开（采信 agent 报告行号）。
