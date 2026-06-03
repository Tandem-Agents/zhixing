# MCP Host（船坞）架构设计

> 状态：架构设计（待 review，作者拍板前不实施） | 日期：2026-05-23
>
> 本文设计知行作为 MCP（Model Context Protocol）host 的架构：连接外部 MCP server，把其工具接入 agent 工具集。设计基于对 OpenClaw / Claude Code / Hermes 三家的源码调研（见 `source-analysis/*/mcp-architecture.md`）与知行自身架构的事实勘察，所有架构决策附知行 `文件:行号` 依据。**只设计，不在 review 通过前实施。**

---

## 〇、置顶认知：劲该使在哪

**这关系到知行做这件事时该把劲使在哪。**

**对的那一半：协议适配层，架构确实一样，而且基本没有优化空间。** 连接 server、`initialize` 握手、`tools/list` 动态发现、`tools/call` 转发、transport 收发——这些是 MCP 协议定死的，而且三家都直接调官方 SDK（`@modelcontextprotocol/sdk`）实现。这一层照着做就行，想"优化"也优化不出花来，因为协议和 SDK 已经把形状固定了。三家在这层本质相同，知行也将相同。

**要校准的那一半：MCP host 的架构空间不在协议层，在"宿主集成层"——MCP 怎么嵌进知行自己的工具系统、安全模型、运行时生命周期。** 这一层三家明显不同，而且不是"代码优劣"，是真正的架构选择，每一套都被各自宿主的架构倒逼出来：

- Hermes 是单文件 + 一个专用后台 asyncio loop + 同步桥接——因为它主体是同步的，必须把异步 MCP 桥到同步 agent 线程。
- OpenClaw 是 session 级 runtime manager + 全局单例 + 配置指纹缓存 + idle TTL 回收，把 MCP 拆成三子系统。
- Claude Code 是连接 memoize + local/remote 分组并发 + 接入它那套权限规则三粒度匹配。

同一个固定协议，接进不同的宿主，长出三种不同的集成形态。**所以知行这一层不是"在三家相同架构上抠代码"，而是要做知行自己的架构决策，因为知行的宿主和三家都不一样。** 本文的全部设计重量都压在集成层；协议层只说明"用官方 SDK"，不展开。

---

## 一、设计目标：基于三家，做得更好

**定位原则（先于一切）**：MCP 补的是知行内置工具**够不到的外部盲区**——外部服务 / SaaS 集成（GitHub、Notion、数据库、第三方 API 等），**不重复**知行已有的本地/通用能力（文件读写、bash、memory、web_fetch 这些内置工具已覆盖，且分类更精细）。凡知行内置已有等价能力的，用内置工具、不用 MCP（例如官方 reference 的 filesystem/git/fetch/memory server 在知行里没有价值，因为 read/write/bash/web_fetch/memory 已覆盖且更精细）。这与"MCP 工具统一声明 `external-service` 边界"自洽——MCP 在知行里就是"外部服务"那一类。预设库据此只收外部服务类 server。

知行能在集成层做得比三家更好的，全部来自"知行宿主架构与三家不同"这一事实，不是凭空创新：

| 维度 | 三家现状 | 知行可做得更好（事实依据） |
|------|---------|--------------------------|
| **异步集成** | Hermes 必须用后台 asyncio loop + 同步桥接（宿主同步） | 知行全异步（`provider.chat`/`runAgentLoop`/`tool.call` 均 async generator/Promise，`llm.ts:390`、`agent-loop.ts:81`、`tools.ts:354`），MCP 调用直接 `await`，**零桥接负担** |
| **安全统一** | 三家各起一套：OpenClaw tool-policy group / Claude Code 权限规则三粒度 / Hermes 配置发现期 env 过滤，MCP 工具是旁路 | MCP 工具声明 `boundaries`（`external-service`）→ 走与 builtin 工具**完全相同**的 `SecurityPipeline` + 渐进信任（ADR-004/ADR-006），不是嫁接旁路。`boundary-registry.ts:14` 注释本就为 MCP 预留 |
| **凭证隔离** | 三家 token 都在配置/env 里（Hermes 还专门做 env 过滤防泄漏） | MCP 凭证落 `credentials.json`，**天然继承 bypassImmune 物理隔离**（`builtin-rules.ts` block 整个 credentials.json 的任何 AI 访问）——AI 工具体系不可读不可写，by-design 安全 |
| **生命周期** | 各自 ad-hoc（OpenClaw session manager + idle TTL；Claude Code memoize） | 复用知行既有"进程级单例 + per-runtime 工具实例"模式（工具闭包捕获 assembly 持有的 hub，`builtin-extra-tools.ts:52`），连接归两入口共享的 assembly、由 cli/serve 各自退出链 async dispose |
| **结果处理** | 三家只做截断（防撑爆） | MCP 巨结果可走 `ctx.llm.light` 蒸馏（与 web_fetch distill 同款，`distill.ts` 的 collectStream 已注释预留复用），不止截断 |
| **热重载** | 三家多数需重启 | 知行有 `session.reload` + `computeDiff`，MCP 配置变更可热重连 |
| **用户接入** | CLI 命令 / 手写配置文件（开发者门槛） | `/mcp` 交互面板（对齐 `/config` 配置编辑器）+ 智能引导：系统用预设库 + agent 推断准备技术字段、discovery 验证，**用户只填密钥**——契合"AI 系统该兜住智能"，不碰技术字段、无 CLI |

设计原则：**MCP 工具与 builtin 工具在装配、安全、执行上走同一套路径**，不是平行的第二套系统。让 MCP 浑然一体，而非嫁接孤岛。

---

## 二、整体架构：两层分离 + 数据流

```
配置/凭证          连接层(进程级单例)        映射层(per-runtime)      宿主既有管线
─────────         ──────────────────       ───────────────────     ──────────────
config.mcp    ┐                                                    
              ├─→  McpHub                ┌─→ MCP 工具(ToolDefinition[])
credentials.mcp┘   - SDK Client × N      │   - name: mcp__<srv>__<tool>
                   - transport(stdio/http)│   - inputSchema 透传
                   - initialize/tools/list│   - boundaries: external-service
                   - tools/call 转发       │   - call() → hub.callTool()
                   - 重连/async dispose    │           │
                        │                  │           ↓
                   (闭包捕获) ───────┘    extraTools 注入 assembleTools
                        │                              │
                        │                              ↓
              归 builtinExtraTools assembly       baseTools = builtin + extraTools
              (cli/serve 退出链各调 hub.dispose)        │
                                                      ↓
                                          BoundaryRegistry.fromTools(baseTools)
                                          → SecurityPipeline → tool-executor
```

**两层分离是核心架构决策**：

- **连接层 `McpHub`（进程级单例）**：持有所有 MCP server 的 SDK Client + transport，负责连接/发现/调用/重连/关闭。**生命周期归两入口共享的 `builtinExtraTools` assembly**（`createBuiltinExtraToolsAssembly`，REPL 的 `session.ts` 与 serve 的 `command.ts:209` 都创建并共享它、已持有 `taskListService` 等跨 runtime 单例）。async `dispose()` 由各入口退出链调用：cli 走 `RuntimeSession.dispose()`（`session.ts:799`），serve 走 `shutdown-chain`（`registerCoreCleanup`，`command.ts:521`）。
- **映射层（per-runtime）**：每次 `createAgent` 时把 hub 的工具目录物化成 `ToolDefinition[]`，经 `extraTools` 注入。工具实例随 runtime swap 重建，但都闭包捕获同一个 hub（assembly 工厂参数；hub 无 chicken-and-egg，不需 scheduler 那样的 ctx getter，`builtin-extra-tools.ts:52`）。

**为什么挂 assembly 而非 RuntimeSession**（事实依据）：`AgentRuntime` 接口**无 dispose 方法**（`create-agent-runtime.ts:166-220`），`safeDispose` 是**同步契约**（`:128-131`），swap 时旧 runtime 靠 GC 回收（`session.ts:792`）——而 MCP 连接（stdio 子进程 / http 长连）的关闭是**异步**的，挂 per-runtime 会随 swap 丢弃子进程。更关键：`RuntimeSession` 是 cli REPL 专属，**serve 模式没有它**（serve 用 `createCliRuntimeFactory` + `shutdown-chain`，`command.ts:213,73`）。两入口唯一共享、且本就持有跨 runtime 单例的宿主是 `builtinExtraTools` assembly——McpHub 归它、dispose 由各入口退出链触发，cli/serve 统一；并让 serve 多 session 共享同一批连接（避免每 session 重连）。工具实例则 per-runtime（与 schedule/task_list 同构）。

---

## 三、连接层 McpHub（协议层，照搬 SDK）

职责单一：管理 MCP server 连接，对上层暴露"列出工具 / 调用工具"两个能力。

- **SDK**：用官方 `@modelcontextprotocol/sdk` 的 `Client`，不自研协议（与三家一致，协议层无优化空间）。
- **transport**：阶段一仅 `stdio`（`StdioClientTransport`，本地子进程）；阶段二加 `streamable-http`（`StreamableHTTPClientTransport`，远程）。SSE 是被 streamable-http 取代的旧标准（Hermes 已弃用切到 streamable-http），**不做**，除非后续有 server 只支持 SSE。
- **HTTP 出站必须走知行 network 层（SSRF 防护，硬约束）**：SDK transport 默认用全局 fetch，**不会自动走知行 `@zhixing/network`（undici）出站封装**。因此 streamable-http transport 构造时必须注入基于 `@zhixing/network` 的 fetch / undici dispatcher（与 OpenClaw 给 `SSEClientTransport` 注入 `fetchWithUndici` 同款手法），让 MCP HTTP 出站继承 `network.proxy`（`types.ts:373`）与 SSRF egress 防护——否则 MCP HTTP 调用绕过知行出站安全。不是可选项。
- **连接生命周期**：`connect → initialize 握手（SDK）→ tools/list 发现 → 缓存 catalog`。关闭：stdio 进程树 kill（参考三家：SIGTERM→SIGKILL 升级，知行已有 gracefulKill helper，见 `tools.ts` interruptBehavior "grace" 注释）；http 终止 session。
- **重连**：连接失败不阻塞启动（单 server 失败只记录、跳过，其余照常——参考 OpenClaw `getCatalog` 的隔离策略）；运行中断线指数退避重连。
- **async dispose**：`hub.dispose()` 关闭所有 client + 子进程；由 assembly 暴露、各入口退出链调用（见第二节）。
- **空配置 = no-op hub（零判空分支）**：`config.mcp` 为空时 hub 仍是一个 no-op 实例（`connectAll` 立即 resolve 空 catalog、`callTool` 返回 "no such tool" isError、`dispose` no-op）。hub 引用**恒非空**——assembleTools / dispose 链 / 热重载等调用方无需任何判空分支，用一个空实例的微小开销换全链路零分支。

McpHub 由 `builtinExtraTools` assembly 创建持有，作为 assembly 工厂参数由 assembleTools **闭包捕获**（不走 `ExtraToolsRuntimeContext` getter —— getter 是为 `scheduler` 那类"依赖晚于 assembly 构造"的 chicken-and-egg 延迟解析；hub 在 assembly 构造时即传入、无此问题，闭包捕获更简洁，`builtin-extra-tools.ts:52`）。

---

## 四、映射层：MCP tool → ToolDefinition（集成层核心）

每个 MCP 工具物化成一个知行 `ToolDefinition`（`tools.ts:261`）。字段映射（全部基于已核验的 ToolDefinition 接口）：

| ToolDefinition 字段 | MCP 来源 / 取值 | 依据 |
|---------------------|----------------|------|
| `name` | `mcp__<server>__<tool>` | 业界事实标准（Claude Code 同款）；`__` 分隔（消毒保证 server/tool 名内无 `__`，见下方命名消毒）；前缀对应权限 namespace `mcp:<server>` |
| `description` | MCP tool.description（超长截断） | 防巨描述灌爆 system prompt（Claude Code 截 2048） |
| `inputSchema` | 透传 MCP tool.inputSchema | 知行 `JsonSchema` 要求顶层 `type:"object"`（`tools.ts:110`），不合规则包裹/拒绝 |
| `isReadOnly` | MCP `annotations.readOnlyHint` | 缺省 `false`（fail-closed，`tools.ts:270`） |
| `isParallelSafe` | MCP `annotations.readOnlyHint` | 缺省 `false`（fail-closed）；只读工具并发安全（不改状态），与 Claude Code `readOnlyHint→isConcurrencySafe` 一致；决定能否并发（`tool-executor.ts:316`） |
| `needsPermission` | 默认 `true` | fail-closed（`tools.ts:274`）；只读工具经 boundary 分类自动放行，无需在此放 |
| `boundaries` | `[{ boundaryType:"external-service", access: <readOnlyHint?"query":"invoke">, dynamic:false }]` | **必须声明**否则 fail-closed critical（`tools.ts:291`）。`external-service` 是为外部服务预留的边界类型（`security/types.ts:62`）。读类 access→observe 放行，否则→external 确认（`security/types.ts:75-78`） |
| `maxResultChars` | 设固定上限（如 100_000） | 防 MCP server 巨结果撑爆上下文（`tool-executor.ts:499`，Hermes 同款 100_000） |
| `interruptBehavior` | stdio server → `"grace"`；http → `"cancel"` | stdio 持有子进程需优雅停止（`tools.ts:233`） |
| `systemPromptHints` | 可选，server 级提示 | `tools.ts:309` 注释明确举例"mcp 工具:按服务器特性提示参数约定" |
| `permissionArgumentKey` | MCP 多 string 字段工具可显式声明 | `tools.ts:319`，否则用内置启发式 |
| `call(input, ctx)` | `await hub.callTool(server, tool, input, { signal: ctx.abortSignal })` | 透传 abortSignal 支持中断（`tools.ts:133`）；失败 `return {isError:true}` 不 throw（`tool-executor.ts:268` 错误隔离）；巨结果可选 `ctx.llm.light` 蒸馏 |

**命名消毒（保证 `__` 三段唯一可解）**：`mcp__<server>__<tool>` 以 `__` 为分隔，故 server / tool 名内部**不得再含 `__`**，否则权限通配 `mcp__<server>__*` 的反解析会错位。规则：① server id 在 `config.mcp` 校验阶段约束命名（禁 `__`，建议 `[a-zA-Z0-9-]`，从源头杜绝）；② tool 名（server 动态提供、不可控）映射时把内部连续下划线折为单 `_`、非法字符替为 `_`；③ 同 server 内消毒后若重名，加 `-2/-3` 后缀防冲突（OpenClaw `buildSafeToolName` 同款）。三段由此唯一可解。

**关键简化（推导自事实）**：MCP 工具作为 `extraTools` 进入 `baseTools`（`create-agent-runtime.ts:521`），而 `BoundaryRegistry.fromTools(baseTools)`（`:552`）在装配时**自动注册**所有声明了 boundaries 的工具。因此 MCP 工具的 boundaries 在 runtime 装配时自动进 registry，**正常路径无需** Task 那样的后置 `register`——与 schedule/task_list 完全同构。动态 `register/unregister` 只在"不重建 runtime 的热连接"优化里才需要（见第七节）。

**annotations 有意降维**：映射只消费 MCP `annotations` 的 `readOnlyHint` / `openWorldHint`（→ `isReadOnly` / `isParallelSafe`），其余（`title` / `destructiveHint` / `idempotentHint`）**有意不消费**——知行 `ToolDefinition` 无对应语义槽，且安全分类走 `boundaries`（不依赖 `destructiveHint`）。未来若需要，扩 `ToolDefinition` 增槽，而非在 MCP 映射层 hack。

---

## 五、安全接入：走统一管线，不另起旁路

- **boundary 分类**：MCP 工具声明 `external-service` 边界 → `BoundaryRegistry.fromTools` 自动注册 → `SecurityPipeline` 的 `BoundaryImpactClassifier` 据此分类（`classifier.ts:310`）。只读工具（access=query）→ observe → 自动放行；非只读（access=invoke）→ external → 触发用户确认。与所有 builtin 工具同一条管线、同一套渐进信任。
- **server 级预置规则（可选增强）**：用 `permissionStore.registerBuiltinRules("mcp:<server>", rules)`（`permission-store.ts:446`，namespace 约定 `mcp:<server>` 见 `:443` 注释）给某 server 注册默认放行/拒绝规则。builtin 规则严格让位用户池（用户随时可覆盖）。断开时 `unregisterBuiltinRules("mcp:<server>")` 对偶清理。
- **凭证隔离**：远程 server 凭证在 `credentials.json`，被 `bypassImmune` 规则物理隔离（AI 工具不可读写），无需额外防护。
- **stdio env 安全**（参考三家共识）：spawn stdio server 时过滤"解释器启动型"危险 env（`NODE_OPTIONS`/`PYTHONPATH`/`DYLD_*` 等）——OpenClaw/Hermes 都做了，知行应复用或新建一个 env 白名单（实现阶段对照 OpenClaw `host-env-security-policy.json` 的清单）。
- **子 agent 暴露面（by-construction 安全）**：MCP 工具进 `baseTools` 后是 Task 的 `parentTools` 候选，但子 agent 的 `subAgentProfile.enabledTools` 是白名单 `["read","glob","grep"]`（`default-profiles.ts:52`），Task 按它过滤 parentTools（`subagent/factory.ts:248`）——`mcp__*` 不在白名单，**子 agent 天然不暴露 MCP**（fail-closed）。未来若要让子 agent 用 MCP，再设计白名单扩展，当前无需处理。

---

## 六、用户接入（智能引导）、配置与凭证

### 用户接入：`/mcp` 交互面板 + 智能引导，用户只填私密值

**用户唯一入口是 `/mcp` 交互面板**（形态对齐 `/config` 的配置编辑器：config-editor 多级面板，**非** `/work` 的 typeahead 命令补全）——**无 CLI 命令、无手写配置文件**。面板内浏览已接入 server（状态 / 工具数）、添加、启用 / 停用 / 删除 / 重连、查看工具。

选 config-editor 而非 typeahead 的依据：`/mcp` 本质是管理 `config.mcp` / `credentials.mcp` + 接入后 reload + 多步引导，与 config-editor 的"事务暂存 → 落盘 → reload"同构（其 `channel-config` 面板与 mcp server 同构：配置条目 + 凭证 + 启用开关）；typeahead 的单行 inline 操作（delete / rename / create）承载不了多步引导与启停 / 重连 / 查看等丰富操作，且 typeahead 不触发 reload。

下方的 `config.mcp` / `credentials.mcp` 是面板的**产物**（系统写入），不是用户手写面。配置由"智能接入引导"产生——这正是知行作为 AI 系统的智能该兜住的：

1. **系统准备技术字段**：外部服务类 server 走**内置预设库**（首批 GitHub、Notion，渐进式扩展；其 `command`/`args`/`transport` 系统已备好，参考 Hermes `_MCP_PRESETS`）；非预设的，用 agent 智能从用户给的标识（包名 / URL）**推断**启动方式。`command`/`args`/`url`/`transport` 等技术字段**全程由系统填**，用户不接触、不需要懂。推断 + discovery 失败时面板 graceful 反馈（提示 / 请用户给更明确的标识 / 极端情况标"暂不支持自动接入"），**不退回让用户手填技术字段**——预设库覆盖常见 server 保证多数一步接入。
2. **discovery 验证（临时连接，复用同一套安全）**：系统用 McpHub 的**同一套安全连接逻辑**（stdio env 过滤 / http 的 `@zhixing/network` SSRF dispatcher，不走任何旁路）临时连上去、列出该 server 的工具——连上即证明配置正确（自验证），连不上则面板明确指出卡点（缺密钥 / 需调整）。这是**临时验证连接**，与正式接入（见下方"接入生效路径"）分开。
3. **用户只填私密值**：唯一需要用户亲手输入的是密钥 / token（私密、必须用户处理），面板**明确指引到那一个字段**（"请填入 GitHub Personal Access Token"），用户**只填值**——无需知道它在请求里叫 `Authorization`、要不要 `Bearer ` 前缀（系统拼）。
4. **用户勾选启用哪些工具**（discovery 列出后），落 `config.mcp.servers.<id>.tools`。

即：除私密值外一切由系统处理；让用户做的只剩"选 server + 填一个密钥 + 勾工具"，每步有明确指引。

**接入生效路径（运行时 + prompt cache 安全）**：`/mcp` 面板是运行时操作的，而工具集已 freeze 进当前 runtime 的 system prompt（prompt cache 死线）——故新接入的工具**不塞当前 runtime**。流程：discovery 临时验证 → 用户确认 → 写入 `config.mcp` / `credentials.mcp` → 触发 `session.reload`（复用第七节既有 reload 机制：`config.mcp` 进 `agentChanged` → `await hub.applyConfig` 正式连接 → 重建 runtime）→ 工具进**下一个** runtime 的 system prompt 生效。即"面板确认即在下一轮生效"，不破坏当前已 freeze 的 cache，零新增机制。

### 存储：决策层 / 内容层分离

严格遵循知行既有的"config=决策层 / credentials=内容层、按 id 关联"契约（`types.ts:304-313`），以 `messaging` ↔ `channels` 为同构模板。

**`config.mcp`（落 `ZhixingConfig`，`types.ts:314`）—— 决策层，无凭证**：
```jsonc
{
  "mcp": {
    "servers": {
      "<id>": {
        "type": "stdio" | "http",      // 缺省 stdio
        "command": "uvx", "args": [...],   // stdio
        "url": "https://...",              // http
        "enabled": true,                   // 缺省 true
        "tools": { "include": [...], "exclude": [...] }  // 可选白/黑名单
      }
    }
  }
}
```
参照 `MessagingChannelEntry`（`types.ts:278`，只有 type/options/defaultTarget，无凭证字段）。

**`credentials.mcp`（落 `ZhixingCredentials`，`types.ts:400`）—— 内容层，凭证**：
```jsonc
{ "mcp": { "<id>": { "apiKey": "...", "token": "...", "Authorization": "Bearer ..." } } }
```
新增 `mcp?: Record<string, Record<string,string>>` 子表，与 `channels`（`types.ts:419`）完全同构，按 server id 关联。自动继承 bypassImmune 隔离。

**合并策略（与 messaging 同构）**：`config.mcp.servers` 是 id-map，照 `deepMergeConfig` 的 messaging 模板（`config-loader.ts:396-407`）做 **server id 级合并 + server 内字段浅覆盖**——同 id 的 server 项目级覆盖全局级（`{...existing, ...value}`），其中 `tools.include/exclude` 列表随浅合并整体**覆盖**（不 append，与现有 messaging 嵌套字段行为一致）。`credentials.mcp` 同 `channels` 走 id-map 合并。

**需要改动的既有点（事实清单）**：
- `deepMergeConfig`（`config-loader.ts:382`）加 `mcp` 分支（server id-map 合并，仿 messaging `:396`）；`applyConfigPatch`（`:176`）加 `mcp` 分支。
- `applyCredentialsPatch`（`credentials-loader.ts:163`）加 `mcp` 子表 mergeIdMap 分支（现仅 providers/channels）。
- `computeDiff`（`diff.ts:35-44`）的 `agentChanged` 加 `config.mcp` 与 `credentials.mcp` 比较——否则纯 MCP 变更不触发 runtime 重建（见第七节）。
- `network.proxy`（`types.ts:373`）已声明影响"MCP HTTP"出站，http transport 经第三节的 dispatcher 注入复用。
- 新增 `credentials.mcp` 子表后，同步更新 `bi-zhixing-credentials-block` 的 `suggestion` 文案（`builtin-rules.ts:88-91`，现仅列 `providers.<id>.apiKey` 与 `channels.<id>.<field>`），补上 `mcp.<id>.<field>`——否则 AI 告知用户的凭证 schema 不完整。

> 既有模式延续：MCP 接入沿用 `computeDiff` 域模型、`extraTools` getter、`deepMergeConfig` 逐字段分支这三处既有模式（一致性，非妥协）。这些模式自身的演进（如域模型重构）是独立议题，不在本设计范围。

---

## 七、连接时机、生命周期、热重载、work-mode

**连接时机是承重约束（决定 MCP 工具能否进 system prompt）。** MCP 工具经 extraTools 进 `baseTools`，而 system prompt 在 `createAgent` 中后置于 tools 装配构造、且是 prompt cache 死线（同一构造点 byte-equal 不变）。因此 **hub 的 catalog 必须在 `createAgent` 之前就 ready**——否则 MCP 工具进不了首个 system prompt（LLM 看不到），或事后加入会破坏 prompt cache。这条约束定死了下面的 await 时序；**lazy 连接不可行**（工具进不了已 freeze 的 system prompt），await-connect-then-assemble 是该约束下唯一干净解。

- **创建**：入口（cli bootstrap / serve 启动）先令 assembly `await hub.connectAll({ perServerTimeoutMs })`（并发连接所有 enabled server）→ catalog ready → 再 `createAgent`（assembleTools 同步物化，catalog 已在内存）。cli `createAgent`（`session.ts:147`）与 serve `createCliRuntimeFactory`（`command.ts:213`）本就是 async，前置 await 不改变其形态。
- **工具装配**：`assembleTools`（`builtin-extra-tools.ts:106`）从 hub 物化 MCP 工具进 extraTools，与 schedule/task_list 并列。
- **热重载（cli）**：`session.reload` → `computeDiff`。当前 `agentChanged`（`diff.ts:35-44`）只比较 llm/providers/workspace/network/agent/intent——**必须把 `config.mcp` 与 `credentials.mcp` 加入 `agentChanged`**（`!stableEqual(oldConfig.mcp,newConfig.mcp) || !stableEqual(oldCredentials.mcp,newCredentials.mcp)`），否则纯 MCP 变更不触发 runtime 重建、LLM 看不到新工具。变更时 `await hub.applyConfig(newMcp)`（增量：新增 connect / 删除 disconnect）→ 再 createAgent 重新物化。hub 跨 swap 存活不重建。
- **关闭**：cli `RuntimeSession.dispose()`（`session.ts:799`）与 serve `shutdown-chain`（`command.ts:521`）各增加一步 `await hub.dispose()`（与 scheduler/channels 同款独立 try/catch），关闭所有连接/子进程（stdio 进程树 kill）。
- **失败与断线语义**：连接失败/超时的 server 不进 catalog（其工具不出现），**不阻塞启动**——成功的 server 照常可用（参考 OpenClaw 单 server 失败隔离）。运行中 server 断线时，工具仍在已 freeze 的 system prompt 里（LLM 仍"可见"），但 `call()` 返回明确的 "server unavailable" isError——这是"静态工具集快照 vs server 动态状态"的固有张力（三家皆然，`tool-executor.ts` 错误隔离已 cover）；hub 后台重连，重连成功的 server 工具在下次 runtime 重建后恢复（不动态改已 freeze 的 system prompt）。
- **work-mode 装配——MCP 与 profile 隔离是两条正交通道**：`extraTools` 无条件追加进 `baseTools`（`create-agent-runtime.ts:521`，**不受 `profile.enabledTools` 约束**），而无 workdir workscene 的隔离是在 `profile.enabledTools` 层剔除本地文件工具（隔离语义="无本地文件操作面"，`default-profiles.ts:83-88`）。MCP 工具是**外部服务能力、不属于本地文件操作面**，因此不参与该隔离，在 main / 所有 workscene 一律按 `spec.kind` 装配（`assembleTools` 二分，`builtin-extra-tools.ts:124`：main 与 workscene 均注入）。注：`assembleTools` 的 ctx 只有 `spec.kind`、拿不到 workdir 有无，故 MCP 也无法、无需按 workdir 细分——这与"MCP 是外部能力"语义自洽，不是限制（不引入 `localFs` 之类接口支持不了的标记）。

---

## 八、比三家更好——逐条对照

1. **异步零桥接**：知行全异步，MCP `await hub.callTool()` 直连，省掉 Hermes 整个"后台 asyncio loop + 同步桥接"复杂度。
2. **安全浑然一体**：MCP 工具走与 builtin 完全相同的 `boundaries → SecurityPipeline → 渐进信任`，不是三家那种平行旁路；`boundary-registry` 本就为 MCP 预留接口。
3. **凭证 by-design 隔离**：MCP token 落 credentials.json 自动被 bypassImmune 物理隔离，AI 工具读不到——三家做不到（token 在普通配置/env）。
4. **连接/工具两层分离**：连接挂两入口共享的进程级 assembly（cli `RuntimeSession.dispose` / serve `shutdown-chain` 各自 async dispose），工具 per-runtime（闭包捕获 hub）——职责单一、生命周期对齐知行既有模式，且天然覆盖 cli + serve 两入口，比三家把连接/工具/server 混在一起更清晰。
5. **结果智能蒸馏**：巨结果可走 `ctx.llm.light` 蒸馏，不止截断。
6. **热重载重连**：配置变更热重连，不需重启。
7. **接入零门槛**：用户经 `/mcp` 面板 + 智能引导接入（系统准备技术配置、用户只填密钥），不写配置、不敲 CLI——三家都要用户手写配置或敲命令。这是知行"AI 系统"身份的直接兑现。

注意：知行**不抄** OpenClaw 的"作 MCP server 对外（双向）"和"给下游 CLI 注入配置"——知行是个人助手不是 coding harness 编排器，现阶段只做 host（作 client）。这是有意的范围收敛，不是缺失。

---

## 九、渐进执行计划（每阶段独立、可验证）

每个阶段交付一个**独立可验证**的增量；前一阶段是后一阶段的基础，但每阶段自身有明确的验收点。

**阶段一：连接层 + 工具映射（stdio，最小可用且安全正确）**
- McpHub：SDK Client + stdio transport + initialize + tools/list + tools/call；由 assembly 持有，启动 `await hub.connectAll`。
- 工具映射：MCP tool → ToolDefinition（name/inputSchema/maxResultChars/call，annotations→isReadOnly/isParallelSafe）。**含 `boundaries` 声明**——经 `fromTools` 自动注册、`SecurityPipeline` 自动分类（只读放行 / 非只读确认），安全在本阶段**内建生效**，非后续才补（缺 boundaries 会 fail-closed critical 即不可用，故安全不可能拆成独立后置阶段）。
- stdio spawn 的 env 危险变量过滤（spawn 安全前提，本阶段内建）。
- extraTools 注入；`config.mcp`（stdio）加载。
- **验收**：配一个 stdio reference server（如 `@modelcontextprotocol/server-everything`），启动后 LLM 看到工具并成功调用；非只读触发确认、只读放行；env 过滤生效；单测覆盖映射纯函数 + boundary 分类 + mock hub。
- **独立性**：不依赖 http/凭证/热重载。

**阶段二：HTTP transport + 凭证**
- streamable-http transport（**注入 `@zhixing/network` dispatcher 走 SSRF 防护**，见第三节）；`credentials.mcp` 子表 + loader 合并分支 + `network.proxy` 复用。
- **验收**：配一个远程 http MCP server（带 token）能连接调用；凭证落 credentials.json 且被 bypassImmune 隔离（AI 读取报 block）；HTTP 出站走 proxy/SSRF；单测。
- **独立性**：扩展 transport+凭证，阶段一不回归。

**阶段三：生命周期（async dispose + 热重载重连）**
- `hub.dispose()` 接入 cli `RuntimeSession.dispose()` 与 serve `shutdown-chain`；`computeDiff` 的 `agentChanged` 加 `mcp` config + credentials 比较；reload 增量重连。
- **验收**：reload 改 `config.mcp` 触发重连（新增/删除 server 生效）；退出时 stdio 子进程无残留（进程树确认）；cli 与 serve 两入口均验证。
- **独立性**：生命周期完善，工具行为不变。

**阶段四：用户接入层（`/mcp` 交互面板 + 智能引导，用户唯一入口）**

> 阶段四显著大于前三阶段（hub 运行时韧性 + 交互面板 UI + 智能引导 + LLM 推断 + discovery + 预设库 + 可选蒸馏 / 规则），且面板是终端交互、难自动化。故再拆为下列子步，每步独立可验证：核心路径 4.1→4.5 顺序依赖，4.6 / 4.7 为独立可选增强。复用面以 `/config` 配置编辑器（config-editor）为准 —— slash command 经 registry + dispatcher（均在 `core/typeahead`）、由 `registerConfigCommands` 注册 `/mcp`、config-editor 多级面板状态机 + 事务 `WorkingState` + writers + 经 `config-command` 同款模式落盘 → `session.reload`（复用阶段三热重载：写配置 → `applyConfig` 增量重连）。

- **4.1 hub 运行时能力 + 配置写入原语（基础，可单测、无 UI）**：① McpHub 新增 `serverStatuses()` 暴露每 server 运行状态（connected / **connecting** + 工具数 / transport + 最近一次失败原因）—— 当前 `catalog()` 只返回 connected，面板需全量状态；② McpHub 补**后台自动重连**——监听 Client 公开的 `onclose`（不抢占被 Protocol 内部占用的 transport.onclose）→ 标记 connecting → 指数退避定时重连 → 成功后更新 catalog（工具于下次 runtime 重建进 system prompt），兑现第三 / 七节既述的运行时韧性：**已配置 server 统一收敛到 connected**——首次连接失败、首次 `tools/list` 超时（首次 `npx` 下载常 >10s）、连上后被对端断开，都进同一条退避重试、连上即恢复，用户无需手动重连；失败原因记在状态里供面板诊断（不再有终态 failed，也不靠 `onerror` 记错——避免连上后残留 stale 错误）。三个正确性前提：**区分主动 close 与被动断线**（`disconnectOne` / `dispose` 在主动 close 前先解绑 `onclose`，否则误触发重连——删了又连回来）、**`dispose` 清重连定时器**（否则退出后 timer 仍触发重连，错误且泄漏）、**建链异步期间 server 被移除 / 替换则丢弃孤儿连接**（重连 `await` 建链后复查状态，已非 connecting 则关闭新连接，避免泄漏子进程 / 连接池）；③ `config.mcp` / `credentials.mcp` 写入原语（add / remove / setEnabled，复用 `applyConfigPatch` / `applyCredentialsPatch` + `writeConfig` / `writeCredentials`，与现有 `/config` 同路径：写入走标准 `JSON.stringify`、注释由读时 jsonc-parser 容忍）。验收：`serverStatuses` + 重连调度（注入触发 onclose 的 transport + 假定时器，断言指数退避、首次失败也重试、主动 close 不重连、dispose 清 timer、孤儿连接丢弃）+ 写入原语单测。
- **4.2 预设库（数据 + 纯函数，可单测）**：内置预设（首批 GitHub / Notion）—— 技术字段（command / args / transport / url）模板 + 需用户填的密钥字段标识（http→header / stdio→env，可选 `template` 把裸 token 包成 `Bearer {value}` 等）+ "请填入 X" 指引。验收：预设 → 规格映射单测。
  - **预设是数据、外部生态会变 —— 连接细节须对照当前官方文档核实**（改一行即可，不动代码）；运行时正确性由 4.3 discovery 兜底（接入时实连验证，连不上当场报卡点）。**已核实（截至本次调研）**：GitHub 用官方**远程** server `https://api.githubcopilot.com/mcp/`（旧 npx `@modelcontextprotocol/server-github` 已停止支持；末尾斜杠不可省——缺斜杠会重定向，而连接层禁止跟随；PAT 走 `Authorization: Bearer`，**凭 PAT 对所有 GitHub 用户可用**——仓库 / Issue / PR 等工具按 PAT 权限授予，仅 Copilot 专属工具另需订阅）；Notion 用 `npx @notionhq/notion-mcp-server` + **`NOTION_TOKEN`** 环境变量（官方推荐，旧的 `OPENAPI_MCP_HEADERS` JSON 包裹已非首选）。
- **4.3 discovery 验证（临时连接，复用 hub 建链原语，可测）**：用与 hub 同一条建链原语（`connectAndListTools` → 同一个 `createTransport`，不另起连接旁路、安全策略不漂移）临时连上 + `tools/list`（连上即自证配置正确），用完 dispose；与正式接入分开，**用独立的更长超时**（stdio server 首次 `npx` 下载常 >10s，不复用 `connectTimeoutMs`）+ **接受 `AbortSignal`**（面板取消时连接 / 子进程立即关闭，非空跑到超时）。验收：InMemory 临时连 / 列 / dispose / 中断关闭；失败给明确卡点。
- **4.4 智能接入引导逻辑（组合 4.1–4.3，可测纯逻辑）**：预设匹配 / 非预设走**注入的 light LLM**（由 config-editor ctx 注入，非工具的 `ctx.llm`——引导在面板内、不在工具调用上下文）从包名 · URL 推断启动方式 → 用户填密钥 → **带密钥** discovery 验证（密钥按 transport 注入，复用与运行时同一套 `toServerSpec` 路由；既证启动也证鉴权，避免"启动即需密钥"的 server 走进死路）→ 写配置。LLM / probe 均接受 `AbortSignal`，面板可取消。失败 graceful，不退回让用户手填技术字段。验收：引导编排单测（预设路径 + 推断路径 mock light LLM + discovery mock + 带密钥注入断言）。
- **4.5 `/mcp` 面板 UI（扩展 config-editor 加 `"mcp"` section，手动测）**：`/mcp` 打开 config-editor（对齐 `/config`，非 typeahead 命令补全）。新增工作：`SectionId` 加 `"mcp"`、`PanelDescriptor` 加 mcp-server / mcp-add 等 panel kind、`ConfigEditorContext` 注入 hub（运行时状态查询）与 light LLM（引导推断）、**config-editor 支持异步 panel（loading 态）** 承载引导的推断 / discovery（当前 `handleKey` 是纯同步函数，异步通路是真实新增能力，扩展方式见本步末「config-editor 扩展锚点」）。复用：多级面板状态机 + 事务 `WorkingState` + writers + 经 `config-command` 同款模式落盘 → `session.reload`。流程：main 列出 config 中**全部** server（含已停用——列表来自 `config.mcp`，**非** `serverStatuses()`，否则停用 server 会从面板消失、无法重新启用），运行态按 serverId 叠加 `serverStatuses()`（`entry.statusText`：connected · N 工具 / connecting · 上次错误 / 已停用）→ 选中进 server 面板（启停 / 删除 / 查看工具——**无手动重连**，未连上的 server 由 hub 后台持续退避重试，见 4.1）→ 添加进引导面板（选预设 / 输入标识 → 异步推断 → 填密钥 → 带密钥 discovery 验证）→ 完成落盘 + reload。验收：**手动测**终端交互全流程；底层 4.1–4.4 已自动化覆盖。
  - **config-editor 扩展锚点 ①·异步 panel**：`PanelAction` 增一种 `{ type: "loading"; task: (signal: AbortSignal) => Promise<PanelAction>; render }`——handler 返回它时，runner 渲染 loading 态并把 `task(signal)` 与取消键（Esc / Ctrl+C）`Promise.race`：task 先返回则 apply 其 `PanelAction`，取消键先到则 abort signal 并 pop 回上级。discovery（4.3 `probeServer`）/ 推断（4.4 `McpSetupLlm`）均接受 `AbortSignal` 并透传给 SDK `client.connect`/`listTools` 与 LLM 调用，取消是真正中断（abort 时连接 / 子进程被关闭），非仅放弃等待。对现有 4 种同步 variant（stay / navigate / pop / exit）是纯增量，loading 仅由 mcp panel 产生，既有 handler 不受影响。
  - **config-editor 扩展锚点 ②·同步面板读运行时态**：`serverStatuses()` 是纯内存读（同步、非 async）。`Section.entries` 签名加可选只读 runtime 访问器 `entries(state, runtime?)`——**列表仍来自 config（`listMcpServerIds`，含已停用 server）**，再按 serverId 叠加 `serverStatuses()` 运行态（serverStatuses 只含受管的启用 server，不能用作列表来源）；model / messaging 忽略该参数。`WorkingState` 保持纯事务暂存（运行时快照不混入、杜绝被 writers 误序列化）。键驱动循环按键时刷新、非实时：`connecting` 显示为上次按键的快照，MVP 可接受（无需 live 订阅）。
- **4.6 巨结果蒸馏（可选，对原方案的修正）**：与 `web_fetch` distill 不同，MCP 工具调用无"用户提取意图"（LLM 要的是工具原始结果），无脑摘要会丢掉 LLM 后续需要的细节。故默认仍以 `maxResultChars` 截断 + 明确"已截断"提示（阶段一已具备）；蒸馏仅在能给出明确蒸馏目标时才接入，否则不做（避免丢信息债）。这是对原"同期蒸馏"表述的修正。
- **4.7 server 级预置规则（可选）**：`permissionStore.registerBuiltinRules("mcp:<server>", rules)` 给某 server 默认放行 / 拒绝，断开时 `unregisterBuiltinRules` 对偶清理；builtin 规则严格让位用户池。验收：注册 / 注销单测。

- **总验收**：用户全程不写配置、不敲命令，仅在 `/mcp` 面板"选 server + 填一个密钥 + 勾工具"即可接入并使用；预设 server 一步接入。
- **说明**：4.5 是**面向用户的必要交付、唯一入口**（非"可选增强"）；阶段一~三的手写 `config.mcp` 仅限开发期自测，用户从不接触配置文件。

---

## 十、设计自验证（三遍走查）

**第一遍·正确性**：
- MCP→ToolDefinition 每个字段都有已核验的接口字段对应（第四节表），无虚构字段。
- boundaries 自动注册路径成立：MCP 工具进 extraTools→baseTools→`fromTools` 自动 register（`create-agent-runtime.ts:521,552`，已读核验）。
- 只读放行/非只读确认成立：`BoundaryImpactClassifier.classifyCrossing` access-first（读类 access→observe，否则按 `BOUNDARY_WRITE_IMPACT`，`external-service`→external），已读核验（`classifier.ts:299,322-326`）。
- 异步链成立：`call()` 是 Promise（`tools.ts:354`），hub.callTool 是 async，全程无同步桥接（`agent-loop.ts` async generator 已核验）。
- 凭证隔离成立：`bi-zhixing-credentials-block`（`builtin-rules.ts:75-92`）`match` 路径 `.zhixing/credentials.json`、`access:"any"`、`action:"block"`、`bypassImmune:true` 已核实，MCP 凭证落该文件自动被隔离。

**第二遍·可行性**：
- 连接挂载点覆盖两入口：McpHub 归 `builtinExtraTools` assembly（REPL + serve 共享，`command.ts:209`），dispose 由 cli `RuntimeSession.dispose`（`session.ts:799`）与 serve `shutdown-chain`（`command.ts:521`）各自调用；已核验 RuntimeSession 是 cli 专属、serve 无之、AgentRuntime 无 dispose。
- hub 经 assembly 工厂参数闭包捕获：hub 在 assembly 构造时即传入、无 `scheduler` 那类 chicken-and-egg，故无需 ctx getter（getter 仅"依赖晚于 assembly 构造"的延迟解析场景需要，`builtin-extra-tools.ts:52`，已读）。
- 配置/凭证/diff 扩展点已读核验：`deepMergeConfig` messaging id-map 字段合并模板（`config-loader.ts:396`）；`diff.ts` 的 `agentChanged`（`:35-44`）需加 mcp config+credentials 比较，否则纯 MCP 变更不重建 runtime。
- 安全 API 签名已核验：`BoundaryRegistry.register/unregister`、`PermissionStore.registerBuiltinRules`。

**第三遍·是否最优架构**：
- 两层分离 vs 单层：若把连接也放 per-runtime，会撞上"无 async dispose + swap 丢弃子进程"的硬约束——两层是被宿主事实逼出的唯一干净解，非过度设计。
- 走统一 SecurityPipeline vs 另起旁路：复用既有管线避免第二套安全系统（三家旁路的教训），架构债最低。
- extraTools vs profile.enabledTools：MCP 工具运行时动态发现，与 profile 的"静态名 + fail-fast 校验"模型冲突（`create-agent-runtime.ts:512-518`），extraTools 是唯一无冲突路径。
- **结论**：在知行既有约束下，本设计是把 MCP 长进知行的最小架构债方案，未发现更优解。

---

## 十一、留给作者拍板的关键决策点

1. **工具命名**：采用业界事实标准 `mcp__<server>__<tool>`（利于互操作 + 对应权限 namespace）。是否认可，或要知行自有前缀。
2. **transport 范围**：阶段一 stdio + 阶段二 streamable-http，**不做 SSE**（旧标准）。是否够。
3. **无 workdir workscene 的 MCP 工具**：MCP 是外部服务能力、与本地文件隔离正交，在所有 workscene 一律保留（见第七节，不引入 `assembleTools` 拿不到 workdir 而支持不了的 `localFs` 标记）。确认这个语义。
4. **server 级预置权限规则**（`mcp:<server>` namespace）：列为阶段四可选增强，非必须。是否要提前。
5. **双向（作 MCP server）/ 给下游 CLI 注入**：明确**不做**（知行是个人助手非编排器）。确认这个范围收敛。
6. **接入引导的预设库初始范围（已定）**：首批仅 **GitHub、Notion**（外部服务类），渐进式扩展；只收外部服务类 server（知行内置已覆盖的本地/通用能力不预设，见第一节定位原则），非预设走 agent 推断 + discovery 验证兜底。

---

## 十二、自定义 server 接入向导（规划增量，未实施）

> 状态：规划（未实施，待 review）｜ 日期：2026-05-24（同日复审：对照已实现代码修正——推断管线已建成，本节范围收敛为"UI 接线"）
>
> **被十三取代的部分**：本节"如何把输入变成候选"用的是"LLM 凭知识推断"——实测会编错包名 / 密钥 / 链接且不稳定，已被**十三「事实驱动」**取代。本节的面板 / 候选管线 / 多密钥 / 唯一性 / 命令确认 / env 黑名单等基础设施**仍有效**，只换"候选来源"。
>
> **隔开说明**：〇–十一是已 review / 已落地的 host 架构；本节是其上的**后续增量**，单独成节、与已实施部分隔开，不混写。

### 背景：缺的是 UI 接线，不是逻辑

阶段四落地时 `/mcp` 面板**只接通了预设路径**（GitHub / Notion 一键、单密钥）。但 4.4 设想的"输入标识 → 推断"的**编排逻辑早已实现且有测试**（`config-editor/mcp-setup.ts` + `mcp-setup.test.ts`），只是没接进 UI。复审（grep 实证）确认的真实状态：

- **已实现且通用**：`McpSetupCandidate`（entry 可为任意 stdio `command/args` 或 http `url`）、`presetToCandidate`、`resolveMcpSetup`（按 id/label 命中预设，否则走 LLM 推断）、`inferMcpSetup` + `buildInferencePrompt` + `parseInference`、`deriveServerId`、`parseSecretFields`（**已支持多密钥**）、`validateMcpSetup`（候选+密钥 → `toServerSpec` → probe）、`applyMcpSetup`、`applyMcpSecretFields`（多字段）。
- **缺的 UI 接线**：① `resolveMcpSetup` / `inferMcpSetup` **无任何调用方**；② `ConfigEditorRuntime` **不注入 light LLM**（只有 `mcpServerStatuses` + `mcpProbe`）；③ `mcp-add` 面板**只收 `secretFields[0]`（单字段）**；④ 没有"输入标识接入"的入口（mcp section 只列预设"添加 X"）。

后果：接任意 server 当前只能手改 `config.jsonc`——与第六节"用户唯一入口 `/mcp`、**无手写配置文件**"的不变量相矛盾。本增量 = **把已建成的推断管线接进面板**兑现该不变量，**不重建逻辑、不动连接核心**。

### 核心架构：单一候选管线（已在代码中实现，本节只补输入源 UI）

预设与"输入标识推断"**已殊途同归到 `McpSetupCandidate`**，共用同一尾段：`validateMcpSetup`（带密钥 discovery）→ `applyMcpSetup`（拆 `entry` + `secrets`）→ `upsertMcpServer` + `patchMcpSecrets` → 落盘 → `session.reload`。本增量**不新增平行落盘 / 连接路径、不新增候选模型**——只补"统一输入"这一候选来源的 UI 与多密钥录入。

### 增量范围（承接 4.5 延后的"输入标识 → 推断"）

1. **注入 light LLM**：`ConfigEditorRuntime` 增一个推断访问器（包 `McpSetupLlm`），由命令层（`handleMcpCommand`，与现注入 `mcpProbe` **同一处、同一手法**）接通；light 角色系统已具备（`createProviderRoles` 产出 `roles.light`），具体取用点实现期接通。
2. **统一输入面板**：mcp section 加"添加其他 server"入口 → 输入面板：用户键入包名 / URL / 命令 / 预设名 → 异步 loading 调**已有的** `resolveMcpSetup`（命中预设直用，否则 LLM 推断）→ 得候选。复用 config-editor 既有异步 panel（loading 态）。
3. **serverId 冲突处理（统一输入流必须新增）**：拿到候选后须校验 `serverId` 是否已存在于 `config.mcp.servers`。`upsertMcpServer` 默认**静默覆盖**（`config.mcp.servers[serverId] = entry`，无防护），现有预设流程靠"过滤已接入预设"（`sections/mcp.ts`）规避冲突，**统一输入流绕过该过滤**——若 `deriveServerId` / 用户输入派生出重名 id，会静默覆盖既有 server 及其凭证（数据丢失）。处理：已存在 → 提示"已存在 `<id>`：覆盖 / 改名"（覆盖语义与 12.2 编辑现有自然统一）；不存在 → 按新增走。`isValidServerId` 只管格式，不替代此唯一性校验。
4. **多密钥录入**：把密钥收集从单字段（`secretFields[0]`）扩为**遍历 `candidate.secretFields`**——模型 / `applyMcpSecretFields` / `parseSecretFields` 均已支持，仅 UI 侧扩展。
5. **同尾段**：`validateMcpSetup` → `applyMcpSetup` → `upsertMcpServer` + `patchMcpSecrets` → reload。**完全复用，零改动。**

**关键不变量**：**LLM 只见 server 标识、推断启动方式，绝不接触密钥的值**——值由用户在面板填入、直落 `credentials.mcp.<id>`（AI 不可达）。与预设路径一致。

**（后续）编辑现有 server** —— 同面板预填现存 `config.mcp.servers[id]`，让用户改 command/url/密钥（当前 server 面板仅启停 / 删除）。自然延伸，可独立后置。

### 安全（推断 / 任意 server 引入的新面）

- **任意命令执行确认（确认点必须前置到 discovery 探测之前）**：推断 / 解析出的 stdio `command` = 本机代码执行。**关键时序**：`validateMcpSetup`（discovery 探测）即经 `connectAndListTools` → `createTransport` **spawn 该命令**——首次执行发生在**探测**、不是落盘。故对**非预设**的 stdio 候选，确认必须放在**调 `validateMcpSetup` 之前**（拿到候选、确认 command 后才探测）；放在落盘前是马后炮（命令已运行过）。预设 curated（可信）不需此确认。比 Claude Code / OpenClaw 的"`mcp add` 直接落配置"更强护栏。
- **env 黑名单（待补，落在连接层）**：继承环境的白名单基线**已具备**（`transport.ts` 用 SDK `getDefaultEnvironment()`，不继承整个 `process.env`，挡掉父进程的危险变量——主防护）；但对**显式** `spec.env` 目前**无黑名单过滤**（`...spec.env` 无过滤叠加）。本增量引入用户输入 env 后，须补对显式 env 的"解释器启动型"危险变量（`NODE_OPTIONS` / `LD_*` / `DYLD_*` 等）过滤——**落在 `createTransport`（探测与运行时连接共用的单一点），从而覆盖首次 spawn**（对照第五节 / OpenClaw policy）。
- **凭证隔离**：密钥只入 `credentials.mcp.<id>`、永不进 `config`；LLM 只见标识不见密钥值。
- **http**：推断 url 走既有连接层（禁跟随重定向的 SSRF 防护）。

### 复用锚点（绝大多数已存在且测试覆盖）

已存在：`resolveMcpSetup` / `inferMcpSetup` / `McpSetupCandidate` / `validateMcpSetup` / `applyMcpSetup` / `applyMcpSecretFields` / `presetToCandidate` / `deriveServerId`（`config-editor/mcp-setup.ts`，`mcp-setup.test.ts` 覆盖）、`upsertMcpServer` / `patchMcpSecrets`（`config-editor/state.ts`）、`toServerSpec` / `parseServerSpecs`（`cli/runtime/mcp-config.ts`）、`createTransport`（`mcp/transport.ts`）、`isValidServerId`（`@zhixing/mcp`）、config-editor 异步 panel。**新增仅**：light LLM 注入口 + 一个"统一输入 + 多密钥"面板 + 一个 section 入口 + 命令执行确认 + env 黑名单。

### 渐进执行

- **12.1 接通推断接入（核心，兑现"无手写配置"不变量）**：light LLM 注入 + "添加其他 server"入口 + 统一输入面板（调**已有的** `resolveMcpSetup`）+ 多密钥录入 + 命令执行确认 + env 黑名单 → 同尾段。验收：底层 `mcp-setup` 逻辑已有 `mcp-setup.test.ts` 覆盖；新增 UI 装配最小单测 + 面板手动测全流程。
- **（后续）12.2 编辑现有 server**：同面板预填现存 `config.mcp.servers[id]`。

### 决策（已定，按原则不再拍板）

- **命令执行确认形态**：面板内一步确认（候选面板展示"将在本机运行 `<command>`"，Enter 即知情同意），不另起 `SecurityPipeline`。已实现。
- **手动填写兜底**：由十三定为"信息源不足时的必要出口"（不是可选）——能稳定查到源就用源，查不到就明确让用户手填，绝不让 LLM 凭空补。

### 未尽项与边界（钉死，次要信息）

划定本模块剩余工作的边界，避免反复重提：

- **已决定不做（不再议）**：① MCP 结果**蒸馏**——默认以 `maxResultChars` 截断 + "已截断"提示替代（理由见 4.6）；② **SSE** transport（被 streamable-http 取代的旧标准，见三 / 十一）；③ 知行**作 MCP server 对外**（双向）、给**下游 CLI 注入配置**（范围收敛：个人助手非编排器，见八 / 十一）。这些是经设计否决的边界，不是缺失。
- **可选未来（低优先，有空再做）**：① **4.7 server 级预置权限规则**（`mcp:<server>` 默认放行 / 拒绝）——当前 MCP 工具走默认安全管线（只读放行 / 非只读确认）已够用，预置规则仅省确认次数；② **stdio 配置级 env 黑名单**（过滤显式 `spec.env` 里的 `NODE_OPTIONS` / `LD_*` 等）——继承环境的白名单基线已具备（主防护），黑名单随本节 12.1 自定义 env 入口一并落地，当前无自定义 env 入口、无暴露面。

除本节（十二）的自定义接入外，阶段一~四核心（连接 / 映射 / HTTP / 凭证 / 生命周期 / 热重连 / `/mcp` 面板 / 预设接入）均已落地。

---

## 十三、事实驱动的接入识别（取代十二的"凭 LLM 知识推断"）

> 状态：已实施（13.1 / 13.2 / 13.3）｜ 日期：2026-05-25
>
> 取代关系：十二的面板 / 候选管线 / 多密钥 / 唯一性 / 命令确认 / env 黑名单仍有效；仅"如何把用户输入变成候选"由"LLM 凭记忆推断"改为下述事实驱动。

### 原则：LLM 不臆造任何事实，只从真实信息源提取；源里没有就如实告知

接入一个 server 涉及的每项事实——包是否存在、启动命令、是否需要密钥、密钥从哪获取——**都必须来自真实信息源**，不允许 LLM 凭记忆编造任何一项。LLM 只承担"读真实源文本、抽取结构化信息"，不是知识库。**源里没有的，明确告诉用户"未找到，请自行提供 / 查询"，绝不填假值。** 实连结果是最终事实裁决。

纠正动机：十二的"凭 LLM 知识推断"会编出错误的包名 / 密钥要求 / 获取链接，且同一输入每次结果不同（不稳定）——彻底换掉。

### 能力边界：稳定能力为先，不稳定处给用户友好提示

- **稳定核心**：npm 包类 server（绝大多数 stdio MCP）——npm registry 是权威事实源（包存在性 + README + 主页），据此可靠识别接入方式与密钥要求。这是稳定提供的能力。
- **边界之外**（包不存在 / 无 README / 源未说明）：**不猜**，给用户可理解的提示并转入"手动填写"。
- 用户只看到能理解的话（"识别成功""需要 X 密钥，获取地址…""没找到，请手动填写"），不暴露任何内部机制术语。

### 流程（以 npm 包为例）

1. **查源**：确认包存在 + 取其 README（**大陆可达性是硬指标**，见 13.1）。三态分清、不混淆（诚实）：**确不存在**（404）→ "没找到这个包，请核对名称"；**查询失败**（网络 / 源不可达）→ "暂时查不到，请重试或手动填写"（**不等同"没这个包"**）；**存在** → 拿到 README + 主页。
2. **基线**（不经 LLM）：transport = stdio、命令兜底 = `npx`、args 兜底 = `-y <已确认的真实包名>`。
3. **LLM 受限提取**（main 档）：把 README（尤其其中的 **MCP 配置示例** / 设置段，按标题截取 + 上限）喂给 LLM，从中提取**完整启动配置**——实际 command + args（README 配置示例常直接给出；有些 server 必须带 args，如目录路径 / `--stdio`，只拼 `npx -y 包名` 会连不上）、需要哪些密钥、各自获取说明与**真实链接**。硬约束（给 LLM 的指令）："只依据给定文本，文本没有的输出 null，禁止用你自己的知识补全或猜测"。README 无显式配置 → 回落第 2 步基线。
4. **诚实呈现缺口**：源没提密钥 → 标"未要求密钥"，先按无密钥接入；要密钥但没给地址 → "获取地址：源未提供，请自行查询（主页：<真实主页>）"，不放假链接；无 README → "无法从源确定，请手动填写"。
5. **实连验证**（最终事实）：无密钥先连，通即成；若因鉴权被拒，则提示输入密钥（地址只用源里的真实链接，没有就说没有）。

**URL 类标识**（远程 server）：地址 = 用户给的 URL 本身（事实，无需 registry）、transport = http；无 README 源 → 需要密钥时走手动输入（不编造获取地址）。仍以实连验证为准。

### 用户使用方式（最终形态）

1. `/mcp` →「添加其他 server」→ 输入要接入的 server（如 npm 包名）。
2. 知行查该 server 的官方信息后：
   - **查到、无需密钥** → 直接接入，列表里出现。
   - **查到、需要密钥** → 显示"需要 X"，并给出**从官方信息里找到的真实获取地址**（可点击）；拿到密钥填入 → 接入。
   - **查到、但官方没写获取地址** → "需要密钥，但没找到获取地址，请自行查询"（附官网主页）。
   - **没查到 / 信息不足** → "没能自动识别，请手动填写连接信息" → 手动填写。
3. 全程不写配置文件；不确定处如实说"没找到"，绝不瞎编。

### 相对十二已实现 12.1 的改造

- `resolveMcpSetup` 增加 `fetchSource` 依赖（与 `llm` 同级的函数参数，便于单测注 mock）；handleMcpCommand 装配真实实现后**继续以 `mcpResolve` 暴露给面板**——**不新增 ConfigEditorRuntime 运行时注入点**（面板只认 `mcpResolve`，`fetchSource` 是它的内部依赖，不是并列注入）。`fetchSource` 实现放 `@zhixing/mcp`（同 `probeServer`：网络 / registry 关注点留在 lib 层，用 SSRF-safe fetch + 国内镜像优先）。
- 重构 `resolveMcpSetup` / `inferMcpSetup`：查源 → 基线命令 → LLM 基于 README 文本提取完整启动配置。**prompt 必须站 LLM 视角写**：只含 [README 文本] + [任务：提取启动配置 / 密钥 / 链接] + [输出格式] + [硬约束：只用给定文本、缺失标 null、禁用自身知识]，不写任何"为何这么设计"的反思内容。
- **撤掉 12.x 中"让 LLM 直接输 docUrl"的改动**（无源臆造之源）。
- 候选 / 字段模型保持不变：缺失即"未知"，不加新显式状态——`secretFields` 为空即"未要求密钥"、`docUrl` 缺省即"获取地址未提供"，UI 据此自然诚实展示。
- **手动填写**从"可选"升级为"源不足时的必要出口"：统一输入框的 URL / 完整命令分支（确定性、不经 LLM）即手动出口。

### 渐进执行（各步独立可验证 · 已落地）

- **13.1 信息源抓取器** ✅ `@zhixing/mcp` `source.ts` `fetchMcpServerSource`：三态 {README, 主页} / 确不存在(404) / 查询失败，不混淆；大陆稳定源 npmmirror 元数据，packument 无 readme 时回退 jsdelivr 取 README.md（不假设镜像带 readme）；`HttpGetText` 可注入，8 个 mock 单测（`__tests__/source.test.ts`）。
- **13.2 事实驱动解析** ✅ `cli` `mcp-setup.ts` `resolveMcpSetup(input, {fetchSource, llm})`：分类——预设 / URL（http 确定性）/ 含空格命令（stdio 确定性，按空格拆）/ 裸包名（`groundFromSource`：查源三态 + 据 README grounded 提取）。提取 prompt（`buildExtractionPrompt`）站 LLM 视角、含真实 README 文本 + "禁止用自身知识、缺失标 null"；`parseExtraction` 在 LLM 输出不可解析 / 缺字段时回落 `npx -y <真实包名>` 基线（仍是确定性真实命令，由实连证伪），不当硬失败。README 按字符上限截断（覆盖开头的安装 / 配置段；按标题精确截取留作后续优化）。撤掉了 docUrl 凭知识臆造——docUrl 仅从 README grounded 而来，无则缺省。22 个 mock 单测断言"源没有则不编"（`__tests__/mcp-setup.test.ts`）。
- **13.3 UI 诚实呈现 + 手动兜底** ✅ `config-command.ts` 把 `fetchMcpServerSource`（proxy 与 hub / probe 同源）+ main 档 LLM 装配进 `mcpResolve`（面板仍只认 `mcpResolve`，未新增 runtime 注入点）；`mcp-add-input` 面板透传三态诚实失败原因；统一输入框文案说明"预设 / URL / 命令直接采用，包名查 npm 确认"，URL / 命令分支即手动出口。密钥字段无 docUrl 时，候选携带的真实 `homepage`（查源得到）作"获取地址未提供，可查项目主页"的诚实兜底，绝不臆造获取链接。

## 十四、接入识别升级：搜索引导（轻量工具循环的首个使用者）

> 取代关系：十三的"事实驱动"原则与确定性分支（预设 / URL / 完整命令）**全部保留**；仅"裸输入"一支从"把输入当精确包名直接查"升级为"关键词 → 搜索引导 → ≤5 主流候选 → 选 → grounded 提取"。底层由通用原语[轻量工具循环](./lightweight-tool-loop.md)驱动，本节是它在 MCP 接入的使用层。

### 动机

十三要求用户输入**精确的 npm 包名**（大小写、scope 都要对），否则诚实"没找到"。但用户的自然直觉是输产品名 / 模糊词（如 `Context7`），必然查不到——"产品名 → 包名"是凭记忆的不稳定映射，正是十三刻意不让 LLM 臆造的。出路是把这层映射也变成**事实驱动**：用 npm 搜索接口（真实索引）把关键词变成一组真实存在的包，让 LLM 在真实结果上判断、挑主流，而不是凭记忆猜包名。

### 输入分流（在十三 `resolveMcpSetup` 之上）

- 预设名 / URL / 完整命令（含空格）→ 确定性分支，**不变**（见十三）。
- **裸输入（单 token，可能是精确包名，也可能是模糊词）→ 搜索引导**（本节），取代原"直接 `groundFromSource`"。

### 两个工具（场景注入给轻量工具循环）

- `searchMcpServers(query)`——**新增**于 `@zhixing/mcp`（与 `fetchMcpServerSource` 同层同关注点：网络 / registry / SSRF-safe）。打 `registry.npmmirror.com/-/v1/search?text=<query>`（大陆实测可达），返回真实包列表：`name` / `description` / `keywords` / `downloads.all`。`HttpGetText` 可注入便于 mock。
- `fetchMcpServerSource(packageName)`——**已有**。引导期供 LLM 按需读某候选 README，确认它是不是真 MCP server / 看用途。

### 给 LLM 的 goal（站它视角，无设计者反思）

- 任务：帮用户找到他想接入的那个 MCP server。
- 预期：主流的、真实存在的、确实是 MCP server。
- 方法：用搜索工具搜；"是不是 mcp"看包的 keywords（含 `mcp`/`modelcontextprotocol`）和名字 / 描述；"主不主流"看 `downloads`；一次搜不到就换个词再搜（加 `mcp`、拆词、换同义词）；拿不准某个包就读它 README 确认。
- 输出契约：最终给用户**最多 5 个**候选（可以少、不能多），每个含包名 + 一句话用途 + 选它的理由；一个合适的都没有就如实给"没找到"。

### 场景护栏（`parseFinal`，事实焊死）

搜索引导的 `parseFinal` 在 MCP 场景层强制（通用框架不掺和业务）：

- **不许编造**：`searchMcpServers` 工具的 `run` 把每次真实返回累积进一个场景私有集合；`parseFinal` 校验 LLM 给的每个候选包名必须 ∈ 这个真实集合，不在就 reject（回灌让它重挑——它编不出不存在的包）。这就是轻量工具循环"事实焊死"在 MCP 的落地（见 [lightweight-tool-loop.md](./lightweight-tool-loop.md) §二）。
- **硬截 ≤5**：多于 5 个截断 / reject 让它精选。
- **空 → 没找到**：候选为空 → 诚实"没找到"，不硬凑。
- 轮数上限（如 `maxRounds=5`）防无限换词。

### 选中之后（复用十三，不变）

用户从 ≤5 候选里选中一个**真实包** → 走十三的 `fetchMcpServerSource` + grounded 提取（读该包 README 提启动命令 / 密钥，docUrl / homepage 诚实兜底）→ 现有填密钥面板 → 实连验证 → 落盘。即：搜索引导只是把"选中哪个真实包"前置成事实驱动的一步，选中后的 grounded 提取与验证管线**完全复用**。

### 接口与面板演进

- `McpResolveResult` 增"待选"态：`{ok, candidate}`（确定性 / 精确）、`{ok, choices}`（搜索引导待选，`choices` 为 ≤5 项 `{name, 用途, 理由}`）、`{ok:false, error}`（没找到 / 出错的诚实失败）。
- 新增**候选选择面板**：列出 ≤5 候选（名 + 一句话用途），选中 → grounded 提取（loading）→ 现有填密钥面板。
- **两阶段 resolve，需第二个入口（关键）**：搜索引导出 `choices` 与"选中后提取"是两个阶段。选中一个 choice（确定的真实包名）后**不能复用 `mcpResolve`**——裸词分支现在是搜索引导，会把这个精确包名当关键词再次触发 `runToolLoop` 搜索。需独立入口 `mcpExtract(packageName) → {ok, candidate} | {ok:false, error}`（内部即十三的 `groundFromSource`：读该包 README 提取启动配置 / 密钥），由候选选择面板在选中时调用；`choices` 项携带 `name`（+ 展示用的用途 / 理由），阶段2 用 `name` 提取。`mcpExtract` 与 `mcpProbe`/`mcpResolve` 并列注入 `ConfigEditorRuntime`。
- 统一输入框文案：从"只给包名时查 npm 确认"改为"给包名 / 关键词，自动搜 npm 找出主流可选项"。
- **搜索引导期显示当前步骤**：引导循环可能跑几轮（搜 → 换词 → 读 README → 定候选），`loading` 面板据 `runToolLoop` 的结构化进度实时显示人话步骤（"正在搜索 \"X\"…""正在读取 Y 的说明…""正在分析…"）。这需要 config-editor 的 `loading` 机制增强：`run` 签名加 `report(message)` 回调、`runLoadingAction` 维护 `currentMessage` 收到即重渲染——**通用增强、非 MCP 专属、向后兼容**（现有 loading 的 `run(signal)` 不调 report 即保持静态，TS 函数参数逆变保证旧签名零改动）；MCP 引导层负责把结构化进度翻译成人话（`mcpProgressText`），框架不掺业务（见 [lightweight-tool-loop.md](./lightweight-tool-loop.md) §二）。

### 渐进执行（各步独立可验证）

- **14.1 通用原语** `runToolLoop`（含 `onProgress` 结构化进度）+ mock 单测（见 [lightweight-tool-loop.md](./lightweight-tool-loop.md) §六）。
- **14.2** `@zhixing/mcp` `searchMcpServers` + mock 单测（类比 `fetchMcpServerSource`：可注入 httpGet、解析 name+keywords+downloads、查询失败诚实态）。
- **14.3 MCP 搜索引导**：组装 spec（注入两工具 + goal + `parseFinal` 护栏）+ mock 单测（断言：换词重搜、编造候选被 reject、≤5、空→没找到）。
- **14.4** `McpResolveResult` choices 态 + `mcpExtract` 提取入口（阶段2，绕开搜索）+ 候选选择面板 + 输入分流接线 + **`loading` 机制增强（`run` 加 `report` 回调，通用、向后兼容）** + `mcpProgressText` 进度翻译 + 面板测试。
- **14.5** `config-command` 装配（`callText("main")` 绑 `complete`、两工具绑入）+ 全量构建 + 真机测。

## 参考
- 轻量工具循环（接入识别的底层原语）：`lightweight-tool-loop.md`
- 三家 MCP 调研：`source-analysis/openclaw|claude-code|hermes-agent/mcp-architecture.md`
- 工具系统：ADR-004；安全系统：ADR-006、`tool-permission-execution.md`
- 配置/凭证：ADR-003（schema 段已过时，以 `providers/src/types.ts` 为准）、`credentials-and-onboarding.md`
- 知行接入点事实底座：本文各节 `文件:行号`（ToolDefinition `core/types/tools.ts`；安全 `core/security/{boundary-registry,permission-store,classifier,types}.ts`；装配 `orchestrator/runtime/create-agent-runtime.ts` + `cli/runtime/builtin-extra-tools.ts`；生命周期 `cli/runtime/session.ts`；配置凭证 `providers/src/{types,config-loader,credentials-loader}.ts`）
