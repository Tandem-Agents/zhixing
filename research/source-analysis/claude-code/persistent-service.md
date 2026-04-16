# Claude Code — 常驻服务 / 服务架构分析

> **分析状态**: ✅ 完整分析（2026-04-16）
> **核心问题**: Claude Code 为什么不做 Gateway？它有哪些替代方案？对"个人助手"场景有什么启示？
> **信息来源**: 架构分析（★★★★☆）— 基于 npm 泄露源码的 cleanroom 分析和逆向 prompt

## 一、核心结论

Claude Code **刻意选择不做** Gateway / 常驻服务。但这不意味着它没有相关能力——它通过**四种替代路径**覆盖了部分需求，并且其架构中隐藏着一些向服务化演进的基础设施。

```
┌─ Claude Code 的"服务化"能力谱 ──────────────────────────────────────┐
│                                                                       │
│  显式能力                          隐式基础设施                        │
│  ┌─────────────────────┐          ┌──────────────────────────────┐   │
│  │ MCP Server 模式      │          │ DirectConnect Server         │   │
│  │ (暴露工具给外部消费)   │          │ (WebSocket 会话服务器)       │   │
│  ├─────────────────────┤          ├──────────────────────────────┤   │
│  │ Remote Triggers      │          │ Daemon Worker 系统           │   │
│  │ (云端定时执行)        │          │ (进程监督器)                 │   │
│  ├─────────────────────┤          ├──────────────────────────────┤   │
│  │ --print 非交互模式    │          │ 并发会话 PID 管理            │   │
│  │ (CI/CD / 管线集成)    │          │ (文件锁 + stale 检测)       │   │
│  ├─────────────────────┤          ├──────────────────────────────┤   │
│  │ Background Sessions  │          │ UDS Inbox IPC               │   │
│  │ (tmux 后台会话)       │          │ (进程间通信)                 │   │
│  └─────────────────────┘          └──────────────────────────────┘   │
│                                                                       │
│  ❌ 不具备的能力                                                      │
│  ├── 多通道消息网关（Slack/Discord/微信/钉钉）                        │
│  ├── 用户不在场时的主动执行（Cron/Heartbeat）                         │
│  ├── 跨通道审批转发                                                   │
│  └── 集中式会话管理和状态同步                                         │
└───────────────────────────────────────────────────────────────────────┘
```

## 二、MCP Server / Client 架构

### 2.1 Claude Code 作为 MCP Server

**入口**: `src/entrypoints/mcp.ts`

Claude Code 可以将自身全部工具暴露为 MCP 服务器，供其他 LLM 或 IDE 调用：

- 服务器名称：`"claude/tengu"`（内部代号）
- 传输方式：**仅 StdioServerTransport**（stdin/stdout 通信）
- 暴露 40+ 工具（Read, Write, Edit, Grep, Bash 等全部内建工具）
- 运行在 `isNonInteractiveSession: true` 模式，thinking 禁用
- 支持 MCP 标准的 `ListTools` 和 `CallTool` 请求

**架构含义**：MCP Server 模式是一个**独立执行模式**，不是 sidecar。消费者（IDE 或其他 LLM）启动 Claude Code 进程作为子进程，通过 stdin/stdout 通信。

### 2.2 Claude Code 作为 MCP Client

**核心文件**: `src/services/mcp/`

支持连接外部 MCP 服务器获取额外工具能力：

| 传输类型 | 说明 |
|----------|------|
| `stdio` | 启动子进程，通过 stdin/stdout 通信（默认，最常用） |
| `sse` | Server-Sent Events over HTTP |
| `http` | Streamable HTTP（新版 MCP transport） |
| `ws` | WebSocket |
| `sse-ide` / `ws-ide` | IDE 专用变体（VS Code 扩展等） |
| `sdk` | 进程内传输（InProcessTransport，无子进程开销） |
| `claudeai-proxy` | 通过 claude.ai 连接器代理 |

### 2.3 MCP 配置层级

```
enterprise （受管配置，存在时独占控制）
    ↓
local （项目本地配置）
    ↓
project （.mcp.json，向上遍历父目录）
    ↓
user （全局用户配置）
    ↓
dynamic （运行时注入）
    ↓
claudeai （从 claude.ai 账户拉取的连接器）
```

### 2.4 进程内传输（InProcessTransport）

**文件**: `src/services/mcp/InProcessTransport.ts`

一种优化模式：MCP server + client 在同一进程内通过 linked pair 通信，消息通过 `queueMicrotask()` 传递，避免子进程开销。用于 SDK 集成场景。

### 2.5 设计评价

| 维度 | 评价 |
|------|------|
| **协议丰富度** | ✅ 优秀。7 种传输方式，远超 OpenClaw/Hermes |
| **配置灵活度** | ✅ 优秀。6 层配置层级，企业级管控 |
| **作为 Server** | ⚠️ 受限。仅 stdio，不支持 HTTP/WS 暴露 |
| **与 Gateway 的关系** | MCP 是**工具扩展机制**，不是通道网关 |

## 三、Remote Triggers（远程定时执行）

### 3.1 架构

**入口**: `src/skills/bundled/scheduleRemoteAgents.ts`（/schedule 命令）

Remote Triggers 不是本地 Cron——它是一个**云端执行系统**：

```
CLI（客户端）                           Anthropic 云端
┌──────────────────┐                ┌──────────────────────────┐
│ /schedule 命令    │ ── HTTP API → │ RemoteTrigger Service    │
│ RemoteTriggerTool │                │                          │
│                   │                │ ┌──────────────────────┐ │
│ 仅负责 CRUD:      │                │ │ Cron 调度器           │ │
│ create/update/    │                │ │ (云端管理)            │ │
│ list/delete       │                │ └──────────┬───────────┘ │
└──────────────────┘                │            │              │
                                     │            ▼              │
                                     │ ┌──────────────────────┐ │
                                     │ │ CCR 容器              │ │
                                     │ │ (Claude Code Remote)  │ │
                                     │ │ 独立 git checkout     │ │
                                     │ │ 完整工具链            │ │
                                     │ └──────────────────────┘ │
                                     └──────────────────────────┘
```

### 3.2 执行模型

- 每次触发创建**全隔离远程会话**（CCR — Claude Code Remote）
- 执行环境：**容器化**——带独立 git checkout 和完整工具链
- 需要 `environment_id`——通过 `fetchEnvironments()` / `createDefaultCloudEnvironment()` 预置
- 可附加 claude.ai 的 MCP 连接器（Slack, Datadog 等）
- Cron 表达式：标准 5-field，**最小间隔 1 小时**

### 3.3 /loop 命令（本地定时）

**文件**: `src/skills/bundled/loop.ts`

与 Remote Triggers 不同，`/loop` 是**本地进程内调度**：
- 使用 `CronCreate` 工具 + `createCronScheduler` 本地调度器
- 通过 `useScheduledTasks` React hook 将 prompt 注入 REPL 命令队列
- 进程结束即停止——不持久化

### 3.4 设计评价

| 维度 | 评价 |
|------|------|
| **隔离性** | ✅ 优秀。每次执行完全隔离，无状态污染 |
| **可靠性** | ✅ 优秀。云端管理，不依赖本地进程 |
| **灵活性** | ⚠️ 一般。最小 1 小时间隔，无法做"5 分钟后提醒我" |
| **成本** | ❌ 每次执行消耗云端资源 + API token |
| **本地化** | ❌ 完全依赖 Anthropic 基础设施，不可自托管 |

## 四、非交互 / 无头模式

### 4.1 `--print` 模式

**文件**: `src/cli/print.ts`

```bash
claude -p "task description"    # 一次性执行，无 REPL
```

- 使用 `StructuredIO` 进行 JSON 格式化 I/O（stdin/stdout）
- `isNonInteractiveSession: true`
- 共享同一套 QueryEngine、Tool 系统、API Client
- 无 Ink/React UI 渲染——纯数据管线
- 支持 `--input-format stream-json` 用于 SDK 流式集成

### 4.2 Background Sessions（`--bg`）

特性门控的后台会话系统：

```bash
claude --bg "long running task"   # 在 tmux 中启动后台会话
claude ps                          # 列出后台会话
claude logs <session-id>           # 查看日志
claude attach <session-id>         # 连接会话
claude kill <session-id>           # 终止
```

每个后台会话写 PID 文件到 `~/.claude/sessions/`，包含 `{ pid, sessionId, cwd, kind }`。

### 4.3 Daemon Worker 系统（feature-gated `DAEMON`）

**文件**: `src/daemon/`

```bash
claude daemon [subcommand]          # 长运行监督进程
claude --daemon-worker=<kind>       # 由 supervisor 启动的 worker
```

- Supervisor 进程管理多个 worker
- Worker 是轻量的——跳过完整 config/analytics 初始化
- 每种 worker kind 有自己的 `run()` 函数
- 通过 `src/daemon/workerRegistry.js` 注册

### 4.4 DirectConnect Server

**文件**: `src/server/directConnectManager.ts`

一个**隐藏的 WebSocket 会话服务器**，用于 IDE/SDK 集成：

```typescript
type ServerConfig = {
    port: number;
    host: string;
    authToken: string;
    unix?: string;           // Unix domain socket 路径
    idleTimeoutMs: number;
    maxSessions: number;
    workspace: string;
};
```

- 通过 WebSocket 暴露会话管理能力
- 可以 spawn 子 Claude 进程并管理其生命周期
- 这是一个**直连服务器**（IDE/SDK → Claude），不是公共 HTTP 网关

### 4.5 其他无头路径

- `claude environment-runner`：Headless BYOC（Bring Your Own Compute）运行器
- `claude self-hosted-runner`：对接 SelfHostedRunnerWorkerService API（register + poll heartbeat）

## 五、为什么不做 Gateway

### 5.1 Claude Code 的选择

Claude Code **刻意**选择了 process-per-session 模型而非 persistent server 模型。

### 5.2 架构对比

| 维度 | Claude Code | OpenClaw | Hermes |
|------|------------|----------|--------|
| 执行模型 | Process-per-session | Persistent server + sessions | Persistent server + thread pool |
| 状态管理 | 文件系统（JSONL 追加日志） | 内存 + 数据库 | SQLite + JSONL |
| 多路复用 | N/A（每进程一个会话） | Gateway 多路复用 | asyncio.create_task |
| 通道集成 | 无——仅 CLI | Slack, Discord, Telegram... | 17 平台 |
| 安全边界 | OS 进程隔离 | 进程内隔离 | 进程内隔离 |

### 5.3 Claude Code 获得的优势

1. **安全简洁**：每个会话是 OS 进程。无共享内存攻击面，无会话间越权。`CLAUDE_CODE_REMOTE` flag 隔离远程行为
2. **零运维负担**：无服务器需要管理、监控、保活。无端口需要加固，无 TLS 证书需要轮换
3. **完美隔离**：崩溃的会话不影响其他会话。无共享状态腐蚀风险
4. **CI/CD 天然适配**：`claude -p "task"` 就是一个子进程——不需要客户端库或 API
5. **开发者信任模型**：以开发者自己的用户身份运行，继承其文件权限——无提权攻击面

### 5.4 Claude Code 失去的能力

1. **无多通道调度**——不能同时做 Slack bot、Discord bot 等
2. **无实时 webhook 处理**——每次 trigger 是独立远程会话，不是持久监听器
3. **无跨会话共享上下文**——每个会话独立启动（通过 session resume 和 CLAUDE.md 部分缓解）
4. **无集中管理面板**——`claude ps` 仅显示本机会话

### 5.5 根本原因分析

Claude Code 的 "no gateway" 选择源于其**产品定位**：

- 它是**编程助手**，不是个人助手
- 用户模式是"主动发起 → AI 响应"，不是"7×24 被动等待"
- 编程场景不需要多通道、定时任务、主动通知
- 安全性在编程场景（操作文件系统、执行 shell 命令）比消息路由更重要

**但**——Daemon Worker、DirectConnect Server、Background Sessions 的存在说明 Anthropic **正在向服务化演进**，只是当前仍以 CLI-first 为主。

## 六、会话持久化（无 Server）

### 6.1 文件系统状态管理

**文件**: `src/utils/sessionStorage.ts`

- 会话存储在 `~/.claude/projects/<sanitized-path>/` 目录
- Transcript 是**追加式 JSONL**：每条消息（user/assistant/tool）追加为一行 JSON
- Session ID 是启动时生成的 UUID
- `--resume` / `--continue` 模式：读回 JSONL → 重建 `Message[]` 数组 → 继续对话
- 历史独立存储在 `~/.claude/history.jsonl`，文件级锁（`lockfile` 库）
- 超过 1KB 的粘贴内容存入独立 paste store（内容哈希寻址）

### 6.2 与 OpenClaw/Hermes 的对比

| 维度 | Claude Code | OpenClaw | Hermes |
|------|------------|----------|--------|
| 存储格式 | JSONL 追加日志 | JSON + 内存态 | SQLite + JSONL |
| 读取方式 | 全量回放 | 内存快照 | SQL 查询 |
| 并发保护 | 文件锁 | 进程锁 + Gateway 排他 | PID 文件 |
| 压缩 | 无 | 有 | 无 |
| 流式恢复 | 无 | 有 | 无 |

## 七、多实例协调

### 7.1 PID 管理

**文件**: `src/utils/concurrentSessions.ts`

```
~/.claude/sessions/
├── <pid1>.json     # { pid, sessionId, cwd, startedAt, kind, status, messagingSocketPath }
├── <pid2>.json
└── ...
```

- 每个会话启动时注册 PID 文件
- `countConcurrentSessions()` 读目录 → 过滤 stale PID（`isProcessRunning()`）→ 清扫死条目
- 会话种类：`interactive`、`bg`、`daemon`、`daemon-worker`

### 7.2 IPC 机制

| 机制 | 说明 |
|------|------|
| **UDS Inbox** | Unix domain socket 路径存在 PID 文件中，用于进程间消息传递 |
| **useMailboxBridge / useInboxPoller** | React hook，用于会话间消息传递 |
| **Teammate 系统** | 进程内子 agent（`InProcessTeammateTask`），基于 mailbox 通信 |
| **Bridge WebSocket** | 远程会话通过 `wss://api.anthropic.com/v1/sessions/ws/{id}/subscribe` 通信 |

## 八、扩展模型对比

### 8.1 Claude Code 的三种扩展点

| 机制 | 形态 | 持久性 | 能力 |
|------|------|--------|------|
| **Hooks** | Shell 命令，在生命周期节点执行 | 瞬态（子进程）| 可影响行为（allow/deny 工具、注入 prompt） |
| **Skills** | 命名 prompt + 工具约束 | 瞬态（skill 执行期间）| 101+ 内建 skill，可声明 `allowedTools` |
| **CLAUDE.md** | 纯文本指令文件 | 持久（注入 system prompt）| 无代码执行，纯声明 |

### 8.2 与 OpenClaw 通道插件的对比

| 维度 | Claude Code 扩展 | OpenClaw Channel Plugin |
|------|------------------|------------------------|
| **存活时间** | 子进程级，瞬态 | 常驻进程级，持久连接 |
| **能力** | 修改行为、注入 prompt | 双向实时通信、webhook 监听 |
| **安全边界** | 子进程隔离 | 进程内共享 |
| **复杂度** | 低（Shell 命令 / 文本文件） | 高（~35 adapter slot 接口） |
| **通道能力** | ❌ 无 | ✅ Slack/Discord/Telegram/... |

### 8.3 向服务化演进的可行性

Claude Code 的现有基础设施可以支撑服务化扩展：

| 现有基础设施 | 可以复用于 |
|-------------|----------|
| DirectConnect Server + ServerConfig | 持久化 WebSocket 会话服务器 |
| Daemon Worker 系统 | 进程监督和 worker 管理 |
| MCP Server 模式 | 工具暴露协议 |
| Bridge 系统 | 长运行 poll 循环和会话管理 |
| Background Sessions | 后台任务执行 |

**缺失的**：HTTP 服务器、通道调度、会话多路复用、持久化认证——这些都非 trivial，但架构上是可行的。

## 九、与知行的对比思考

### 9.1 Claude Code 做对了的（值得知行学习）

1. **Process-per-session 安全模型**：在需要执行文件操作和 shell 命令的场景中，进程级隔离比进程内隔离安全得多。知行的 Server 模式应考虑为高风险工具调用 fork 独立进程
2. **MCP 作为工具扩展协议**：7 种传输方式 + 6 层配置层级，是最完善的工具扩展体系。知行的 Tool 系统可以通过 MCP 扩展第三方工具
3. **PID + 文件锁的多实例协调**：简单、可靠、无需中心化服务器。知行的 CLI 模式可以借鉴
4. **`--print` 管线模式**：让 agent 可以嵌入 CI/CD 和脚本——知行也需要非交互执行能力
5. **渐进式服务化**：先做 CLI，再做 Background Sessions，再做 Daemon Worker——不急于一步到位

### 9.2 Claude Code 的局限（知行需要超越的）

1. **无通道网关**——这是"编程工具 vs 个人助手"的根本分野。知行的定位要求多通道接入
2. **Remote Triggers 依赖 Anthropic 基础设施**——知行需要自托管的定时执行能力
3. **无集中式会话管理**——`claude ps` 仅限本机，知行的 Server 模式需要跨设备统一视图
4. **无主动执行能力**——Claude Code 始终是"用户发起 → AI 响应"，知行需要"AI 主动关怀"

### 9.3 对知行架构的启示

| 启示 | 来源 | 行动 |
|------|------|------|
| **双模态执行不是二选一** | Claude Code 在 CLI-first 基础上渐进添加 Daemon | 知行也应 CLI-first + 渐进 Server |
| **MCP 是工具扩展的标准答案** | Claude Code 7 种传输、6 层配置 | 知行的 Tool 系统应预留 MCP 扩展点 |
| **Process 隔离是安全基线** | Claude Code 的 process-per-session | 知行 Server 模式处理高风险工具时考虑 fork |
| **云端 + 本地定时互补** | Remote Triggers（云） + /loop（本地） | 知行的 Scheduler 设计应同时支持本地和远程 |
| **DirectConnect 模式有价值** | IDE/SDK 通过 WebSocket 接入 | 知行的 Server 模式可以暴露 WebSocket API 给 IDE/Web |
