# 知行智能体运行时架构设计方案

> 设计日期：2026-04-09 | 最后更新：2026-04-16（v2.0 — 智能协调层）
> 依赖调研：[openclaw/persistent-service.md](../../source-analysis/openclaw/persistent-service.md)、[claude-code/persistent-service.md](../../source-analysis/claude-code/persistent-service.md)、[hermes-agent/persistent-service.md](../../source-analysis/hermes-agent/persistent-service.md)
> 产品定位：个人助手（需要 7×24 可达 + 主动关怀 + 跨通道投递 + 智能协调）
>
> **v2.0 变更摘要**：
> - 文档标题从"常驻服务架构"升级为"智能体运行时架构"——反映 2026 行业范式从"定时任务+通道"到"Agent Harness+智能协调"的跃迁
> - 新增 §2.6 行业范式变迁分析（Harness / Background Agent / Monitor / Tasks DAG）
> - 新增 §3.6 AgentOrchestrator（智能协调层）设计
> - `TaskSchedule` 新增 `after`（任务依赖）和 `self-paced`（自定步调）两种调度模式
> - 路线图插入 S2.5（AgentOrchestrator）和 S3.5（Monitor + TaskGraph）
> - 已验证：**全部新能力对已实现模块零重构影响**（Agent Loop / EventBus / Confirmation Broker / Security Pipeline / Typeahead / Context Engine 均无需修改）

## 一、问题定义

### 1.1 现状

知行当前以 CLI 形态运行（`zhixing` 命令启动 REPL）。每次使用需要用户手动启动，关闭终端即结束。这限制了：

- **无法定时执行任务**：比如"每天早上 8 点查看今日天气和日程"
- **无法接收外部消息**：比如微信/钉钉转发的消息无法触达
- **无法主动通知用户**：比如监控到某事件后主动推送
- **记忆凝练无法自动执行**：Journal 生命周期管理依赖用户启动 CLI

### 1.2 目标

让知行具备**常驻运行**能力，支持：

1. **定时任务**：用户在对话中创建，到时自动执行并投递结果
2. **外部接入**：WebSocket/HTTP API 接收外部通道消息
3. **主动巡检**：周期性检查和维护（记忆凝练、通知汇总等）
4. **可靠运行**：崩溃自动恢复、优雅停机

### 1.3 与记忆系统的关联

记忆系统设计文档中预留了 Server 模式触发策略：

```
Server 触发策略（未来实现）:
  ① Cron 定时 → scan + expire + condense
  ② Heartbeat 巡检时顺便检查
  ③ API 端点手动触发
```

常驻服务就是这个"未来实现"的载体。其中 ② 在知行中由内置系统任务 `__journal-gc` 替代（不需要 Heartbeat 层）。

## 二、竞品方案提炼

### 2.1 OpenClaw 的路线：全功能常驻引擎

```
Daemon（OS 级保活）
  └── Gateway（常驻进程）
       ├── Cron Service（应用内定时调度器，~130 个文件）
       ├── Heartbeat Runner（周期唤醒，~1200 行）
       ├── Command Queue + Lane 隔离
       ├── 多通道消息接收/投递
       └── WebSocket/HTTP/MCP 接口
```

**取**：
- OS 级保活的思想（launchd/systemd/schtasks）
- Cron 依赖注入设计（`CronServiceDeps`，解耦+可测试）
- 执行模式分离（main session vs isolated session）
- Missed job 追赶（重启后补执行）
- 错误退避 + 失败通知
- Lane 隔离（不同工作负载互不干扰）

**舍**：
- ~130 个文件的 Cron 复杂度（大量 regression fix 堆砌）
- Scheduler 与 Gateway 进程的强耦合
- sessionTarget/wakeMode/delivery 的概念过载
- 必须先 `daemon install` 的安装门槛

### 2.2 Claude Code：从"无常驻"到"Harness + 智能协调"

> **2026-04-16 重写**：Claude Code 在 2026 年初经历了重大架构演进，不再是"无常驻能力"。

Claude Code 选择了与 OpenClaw 完全不同的路线——不做 Gateway 常驻服务，但在**会话内智能协调**维度实现了行业领先。

**已实现的能力**：

| 能力 | 实现方式 | 发布版本 |
|------|---------|---------|
| **背景子 Agent** | 主对话中派生独立子 agent（独立上下文窗口 + 工具集），后台运行不阻塞主对话 | v2.0.60+ |
| **前台推后台** | Ctrl+B 将当前前台任务推到后台继续执行 | v2.0.60+ |
| **Monitor 工具** | 实时事件流监控——每行日志/每个错误都是一个通知，agent 可即时反应（非轮询） | v2.1.98 |
| **Tasks DAG** | 任务依赖的有向无环图——Task A 显式阻塞 Task B，状态存储在 `~/.claude/tasks` | 2026 Q1 |
| **Agent Teams** | 一个 session 作为 team lead 派出 teammates，各自独立 git worktree + mailbox 通信 | 2026 Q1 |
| **Remote Triggers** | 云端定时执行（依赖 Anthropic 基础设施） | 2025 |
| **Managed Agents** | 托管 Agent 运行——无需自建 agent loop / tool execution / runtime | 2026 |

**仍不具备的能力**：
- 多通道消息网关（Slack/Discord/微信/钉钉）
- 独立部署的常驻调度器（Cron/Heartbeat）
- 可靠投递管线（持久化队列 + 去重 + 免打扰）
- 跨通道审批转发

**关键启示**：

1. **Harness > Model**：2025 的关键词是"Agent"，2026 的关键词是**"Harness"**。Claude 将驱动 Claude Code 的内部 harness 泛化为 Claude Agent SDK。模型不再是护城河，**harness 才是**。
2. **会话内背景执行是新范式**：用户在对话中说"后台帮我查一下 X"——这不是定时任务，是**会话内派生的即时背景工作**。OpenClaw 和 Hermes 都没有这个能力。
3. **反应式 > 轮询式**：Monitor 工具监听实时事件流并反应，比定时检查更高效、更及时。
4. **任务依赖是编排基础**：Tasks DAG 让多个 agent 可以协调——"A 完成后才启动 B"。纯独立定时任务无法表达这种关系。

### 2.3 OpenClaw 心跳机制的真实需求分析

OpenClaw 的 Heartbeat Runner（~1200 行，32 个文件）看似是"定时检查"，实质是**主会话的唯一主动唤醒通道**——Cron 的 main-session 任务不直接执行，而是注入 system event 到队列，依赖心跳去"摇醒"主会话处理。这是其架构模型的产物，不是本质需求。

剥离架构表象后，心跳覆盖的**真实用户需求**有 5 个：

| 真实需求 | OpenClaw 的实现方式 | 知行的解法 |
|---------|-------------------|-----------|
| 定时任务执行 | Cron → systemEvent → Heartbeat → Agent Turn（间接） | **Scheduler → TaskExecutor → Agent Turn（直接）** |
| 结果投递到通道 | Heartbeat → Channel Plugin → 发送 | **Delivery Pipeline → Channel Adapter → 发送** |
| 免打扰时段 | `heartbeat.activeHours`（仅在心跳级别过滤） | **Server 级 Active Hours**（Scheduler + Delivery 双层过滤） |
| 深夜不唤醒 AI | Active Hours 判断后 skip | **Scheduler 级别直接跳过**（不浪费 LLM 调用） |
| 防重复打扰 | 24h 内相同内容去重 + transcript 修剪 | **Delivery Pipeline 去重 + 独立任务会话**（天然无 transcript 污染） |

**核心洞察**：OpenClaw 的心跳是架构债——因为"主会话"模型导致所有异步事件必须通过心跳间接唤醒。知行采用**直接执行 + 独立会话**模型，从根源上消除了心跳层的必要性，同时用更简洁的方式覆盖了所有真实需求。

### 2.4 OpenClaw 已经做了但可以做得更好的

| 能力 | OpenClaw 现状 | 知行的改进空间 |
|------|-------------|--------------|
| 自然语言创建定时任务 | ✅ 有 `cron` 工具，AI 可调用创建 | 简化工具参数（3 个概念 vs 10+），降低模型调用出错率 |
| 结果投递 | ✅ 多通道 + webhook，但耦合在心跳流程中 | **独立的 Delivery Pipeline**，可排队、可重试、有免打扰过滤 |
| Active Hours | ✅ 心跳级别过滤，不够细粒度 | **任务级 + 全局级双层过滤**，紧急任务可穿透 |
| Lane 隔离 | ✅ 4 条 Lane 并发控制 | **Scheduler 级并发控制** + 任务优先级 |
| 任务会话模式 | ✅ 4 种 sessionTarget（复杂） | **2 种 + 可选 sessionId**（简洁且灵活） |

### 2.5 三者都没做的

| 空白 | 知行的机会 |
|------|-----------|
| 零步骤激活 | `zhixing serve` 即可运行，无需 `daemon install` |
| 投递持久化队列 | 投递失败不丢弃，崩溃恢复后重新投递 |
| 任务优先级 | 紧急任务穿透免打扰 + 插队执行 |
| 实时可观测 | EventBus 驱动的任务执行/投递实时状态 |
| 统一任务模型 | 定时任务、触发式任务、消息驱动任务统一抽象 |
| 跨运行记忆 | 持续跟踪型任务可保留上下文（可选 sessionId） |
| **常驻 + 智能协调双覆盖** | OpenClaw 有常驻无协调，Claude Code 有协调无常驻——知行**两者兼得** |

### 2.6 行业范式变迁（2026 年初）

> 本节是 v2.0 新增。知行的架构不能停留在 2025 年的"定时任务 + 通道适配"范式上。

#### 2.6.1 从"常驻服务"到"Agent Harness"

**Agent Harness** 是 2026 年进入主流的架构概念。它是包裹在 LLM 外面的**基础设施层**——管理 agent 生命周期、工具调度、权限控制、子 agent 协调、可观测性。

Anthropic 将驱动 Claude Code 的内部 harness 泛化发布为 **Claude Agent SDK**；OpenAI 发表了"Harness Engineering"范式文章。Phil Schmid 等行业观察者将其定义为 2026 年的核心竞争力。Gartner 预测 2026 年底 40% 企业应用将包含 task-specific AI agent。

**核心洞察**：知行已经是一个 harness（Agent Loop + EventBus + Tool Pipeline + Security + Context Engine），只是没有显式地这样定位。v2.0 需要将这个身份显式化，并补齐 harness 的**协调维度**。

#### 2.6.2 四个新范式能力

| 能力 | 含义 | 谁先做了 | 知行现状 |
|------|------|---------|---------|
| **Background Agent** | 用户在对话中派生后台任务，不阻塞主对话 | Claude Code | ❌ 需新增 |
| **Monitor** | Agent 订阅实时事件流并反应（非轮询） | Claude Code | ❌ 需新增（EventBus 是天然基础） |
| **Task DAG** | 任务间有依赖关系（A 完成后才执行 B） | Claude Code | ❌ 需扩展 TaskSchedule |
| **Self-paced** | Agent 自己决定下次检查时间（非固定间隔） | Claude Code | ❌ 需扩展 TaskSchedule |

**关键判断**：OpenClaw 和 Hermes **也都没有覆盖**这些新范式。如果知行补齐，将成为**唯一同时覆盖"常驻运行基础设施"和"智能协调新范式"的开源个人助手**。

#### 2.6.3 对已实现模块的影响评估

在决定补齐这些能力之前，我们验证了对现有代码的影响：

| 已实现模块 | 影响程度 | 原因 |
|-----------|---------|------|
| Agent Loop | ✅ 零影响 | 纯 AsyncGenerator 函数，多实例并发无冲突 |
| EventBus | ✅ 零影响 | 工厂函数创建独立实例，无全局状态 |
| Confirmation Broker | ✅ 零影响 | 已有 `NonInteractiveResolver` 兜底，背景 agent 走非交互路径 |
| Security Pipeline | ✅ 零影响 | `SessionType` 已预留 `"gateway"` / `"api"` |
| Typeahead | ✅ 零影响 | 仅 CLI 输入环节，背景 agent 无用户输入 |
| Context Engine | ✅ 零影响 | 工厂函数创建实例，无共享状态 |
| Provider 层 | ✅ 零影响 | 无状态适配器，可并发调用 |
| 内置工具 | ✅ 零影响 | 工厂函数创建实例 |
| Session/SessionStore | ✅ 零影响 | 已支持多会话并存 |
| 记忆系统 | ⚠️ 极小 | save() 需加文件锁防并发写入 |
| CLI REPL | ⚠️ 增量 | 新增通知显示 + Ctrl+B 快捷键 |
| run-agent.ts | ⚠️ 增量 | 新增 `createBackgroundSession()` 函数 |

**结论**：全部新能力都是在现有模块**上面**新建 AgentOrchestrator 层，不需要在**里面**改已有模块。这是架构预判的收益——依赖注入、工厂函数、接口分离三个设计选择让纵向扩展成为可能。

## 三、知行常驻服务架构

### 3.1 核心设计原则

1. **统一内核**：所有接入方式（Server API、社交通道、CLI 终端）和所有执行模式（前台、背景、定时、反应式）共享同一个 Agent 内核。
2. **接入平等**：Server 模式（社交平台对接）和 CLI 模式（终端交互）是两种同等重要的使用方式，不分主次——产品定位是类同 OpenClaw 的独立部署智能体。
3. **触发源解耦**：任务执行逻辑不感知触发来源（CLI/Cron/API/Channel/BackgroundAgent/Monitor）。
4. **渐进复杂度**：从简单开始（`zhixing serve`），需要时再加 OS 级保活。
5. **EventBus 一切**：所有状态变更通过 EventBus 流转，天然支持可观测性和 Monitor 反应式订阅。
6. **Harness 即产品**（v2.0 新增）：知行本身就是 Agent Harness——管理 agent 生命周期、协调多 agent 并发、控制工具权限、保障结果投递。这不是附属基础设施，是核心价值。
7. **协调与执行分离**（v2.0 新增）：AgentOrchestrator 管理"谁在运行、谁等谁"；Agent Loop 只管"当前这轮怎么跑"。两者通过 EventBus 通信，互不侵入。

### 3.2 两种运行模式

知行的产品定位是**独立部署的个人助手**，类同 OpenClaw。用户的典型使用方式是将知行部署后，通过社交平台（微信、钉钉等）与它交互。CLI 终端是另一种同等重要的接入方式，适用于开发调试和直接交互场景。

两种模式共享同一个 Agent 内核和智能协调层，只是接入层不同：

```
┌── 知行 AgentRuntime ─────────────────────────────────────────────────────┐
│                                                                           │
│  ┌── Agent 内核（已实现）──────────────────────────────────────────────┐  │
│  │  Agent Loop · Tool Pipeline · Memory · EventBus (typed)            │  │
│  │  Context Engine · Session Manager · Provider Layer · Resilience    │  │
│  │  Security Pipeline · Confirmation Broker · Typeahead               │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌── AgentOrchestrator（v2.0 新增）───────────────────────────────────┐  │
│  │                                                                     │  │
│  │  ┌─ BackgroundAgent ─┐  ┌─ TaskGraph ─┐  ┌─ Monitors ──────────┐ │  │
│  │  │ 派生 · 前台推后台  │  │ DAG 依赖    │  │ 事件流订阅 + 反应   │ │  │
│  │  │ 通知 · 生命周期    │  │ 自定步调    │  │ EventBus 天然基础   │ │  │
│  │  └───────────────────┘  └─────────────┘  └─────────────────────┘ │  │
│  │                                                                     │  │
│  │  Mailbox（agent 间通信）    AgentRegistry（实例生命周期管理）       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ═════════════════════════════════════════════════════════════════════════ │
│  以上是共享层（内核 + 协调），以下是接入层（两种模式同等重要）            │
│  ═════════════════════════════════════════════════════════════════════════ │
│                                                                           │
│  ┌─ Server 模式 ──────────────────────────────┐  ┌─ CLI 模式 ────────┐  │
│  │                                              │  │                    │  │
│  │ ┌── 入站 ──────────────────────────────┐    │  │ REPL 终端渲染      │  │
│  │ │ Gateway API (WebSocket + HTTP)       │    │  │ 交互式对话          │  │
│  │ │ Channel Adapters (微信/钉钉/…)       │    │  │                    │  │
│  │ └──────────────┬───────────────────────┘    │  │ 可连接 Server      │  │
│  │                ▼                             │  │ 也可独立运行        │  │
│  │ ┌── 调度 ──────────────────────────────┐    │  │                    │  │
│  │ │ Scheduler                            │    │  │ 触发:              │  │
│  │ │  并发控制 · Active Hours · 优先级     │    │  │ - 用户输入          │  │
│  │ │  任务依赖(DAG) · 自定步调            │    │  │ - 斜杠命令          │  │
│  │ └──────────────┬───────────────────────┘    │  │ - 背景 Agent 派生   │  │
│  │                ▼                             │  │ - Monitor 事件      │  │
│  │ ┌── 出站 ──────────────────────────────┐    │  │                    │  │
│  │ │ Delivery Pipeline                    │    │  │                    │  │
│  │ │  排队 · 去重 · 重试 · 免打扰          │    │  │                    │  │
│  │ └─────────────────────────────────────┘    │  │                    │  │
│  │                                              │  │                    │  │
│  │ 触发: Cron · 外部消息 · API · 依赖完成       │  │                    │  │
│  └──────────────────────────────────────────────┘  └────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Server 模式的三层数据流**——这是比 OpenClaw 更清晰的架构分层：

1. **入站层**（Inbound）：接收外部请求——Gateway API 处理 HTTP/WebSocket，Channel Adapter 处理社交平台消息
2. **调度层**（Scheduling）：决定何时执行——Scheduler 管理定时任务，Active Hours 过滤免打扰，并发控制限制同时执行数
3. **出站层**（Outbound）：投递执行结果——Delivery Pipeline 负责排队、去重、重试、免打扰过滤

对比 OpenClaw 的 Gateway 单体（Cron + Heartbeat + Queue + Channel 全部揉在一起），知行的三层分离使每层**可独立测试、独立扩展**。

### 3.3 Server 模式（本方案核心）

```bash
zhixing serve                    # 前台运行（调试用）
zhixing serve --daemon           # 后台运行（生产用，OS 级保活）
zhixing serve status             # 查看服务状态
zhixing serve stop               # 停止后台服务
```

Server 模式是知行作为独立部署智能体的核心形态。它是长生命周期进程，组件分为三层：

**入站层**：
- **Gateway API**：WebSocket + HTTP，供 CLI 远程连接、Web UI、移动端调用
- **Channel Adapters**：微信、钉钉等社交平台适配器

**调度层**：
- **Scheduler**：定时任务调度器，带并发控制和优先级
- **Active Hours**：全局免打扰时段配置

**出站层**：
- **Delivery Pipeline**：结果投递管线，排队 + 去重 + 重试 + 免打扰过滤

### 3.4 CLI 模式（已有，保持）

```bash
zhixing              # REPL 交互模式
zhixing -p "prompt"  # 单次模式
```

CLI 是与知行直接交互的终端界面，适用于开发调试和终端爱好者。CLI 有两种运行方式：

- **独立模式**：Agent 内核在 CLI 进程内运行，退出即结束
- **连接模式**：当 Server 运行时，CLI 自动连接到 Server 的 WebSocket，作为 Server 的终端前端

Server 模式的能力在 CLI 中也有对应的手动触发方式（如 `/schedule list`、`/journal gc`），确保两种使用方式的体验一致。

### 3.5 能力矩阵

| 能力 | CLI 独立模式 | CLI 连接模式 | Server 模式 |
|------|-------------|-------------|------------|
| 用户对话 | ✅ REPL | ✅ 通过 WebSocket | ✅ 通过 API/Channel |
| 背景 Agent | ✅ 进程内并发 | ✅ 通过 Server | ✅ AgentOrchestrator |
| Monitor | ✅ 进程内事件流 | ✅ 通过 Server | ✅ 持续监控 |
| 定时任务 | ❌ | ✅ 通过 Server | ✅ Scheduler |
| 任务依赖(DAG) | ❌ | ✅ 通过 Server | ✅ TaskGraph |
| 外部通道 | ❌ | ❌ | ✅ Channel Adapters |
| 记忆凝练 | ✅ 惰性（启动时检查） | ✅ 通过 Server | ✅ 定时（Cron 驱动） |
| 主动通知 | ❌ | ❌ | ✅ 通过 Channel 推送 |
| 免打扰 | N/A | N/A | ✅ Active Hours |
| 投递保障 | N/A | N/A | ✅ Delivery Pipeline |
| API 接口 | ❌ | ❌ | ✅ WebSocket + HTTP |
| 可观测性 | ✅ 终端渲染 | ✅ 终端渲染 | ✅ API + EventBus |

### 3.6 AgentOrchestrator（智能协调层，v2.0 新增）

AgentOrchestrator 是 v2.0 的核心新增层，负责管理所有 agent 实例的**生命周期和协调关系**。它位于 Agent 内核之上、接入层之下，不侵入任何已实现模块。

#### 3.6.1 定位

```
传统范式：用户输入 → Agent Loop → 结果
新范式：  用户输入 → AgentOrchestrator → 主 Agent Loop（前台）
                                        └→ 背景 Agent Loop（后台，不阻塞）
                                        └→ Monitor（订阅事件流，触发反应）
                                        └→ TaskGraph（依赖编排）
```

**与 Scheduler 的关系**：Scheduler 管理**定时触发**（"什么时候执行"），Orchestrator 管理**实例协调**（"谁在运行、谁等谁、结果给谁"）。两者互补，不重叠。

#### 3.6.2 BackgroundAgent（背景 Agent）

**核心能力**：用户在对话中派生一个后台任务，主对话不阻塞。

```typescript
interface BackgroundAgent {
  id: string;
  parentSessionId: string;          // 派生它的主会话
  status: "running" | "done" | "error";
  prompt: string;                   // 背景任务描述
  result?: AgentResult;             // 完成后的结果摘要
  createdAt: string;
  completedAt?: string;
}

interface AgentOrchestrator {
  /** 在当前会话中派生一个背景 agent */
  spawnBackground(opts: {
    parentSessionId: string;
    prompt: string;
    model?: string;
    tools?: string[];
  }): Promise<BackgroundAgent>;

  /** 把前台任务推到后台（Ctrl+B 场景） */
  pushToBackground(sessionId: string): Promise<BackgroundAgent>;

  /** 列出某会话的所有背景 agent */
  listBackground(parentSessionId: string): BackgroundAgent[];

  /** 背景 agent 完成时的回调 */
  onBackgroundComplete(handler: (agent: BackgroundAgent) => void): void;
}
```

**用户体验**：
```
用户: 帮我后台调研一下 DingTalk Stream SDK 的认证机制
知行: 好的，我在后台开始调研。你可以继续和我聊别的事。
      [背景任务 #bg-1 已启动]

用户: （继续聊其他事情...）

知行: [背景任务 #bg-1 完成]
      DingTalk Stream SDK 认证机制调研结果：
      1. 使用 AppKey + AppSecret 获取 access_token ...
```

**安全策略**：背景 Agent 的 ConfirmationBroker 不 attach 渲染器 → 自动走 `NonInteractiveResolver` → 默认 deny 高风险操作。或者挂一个 `DelegatingRenderer` 转发到主会话 Broker。两条路径都不需要修改 Broker 代码。

**实现要点**：
- 调用 `runAgentLoop()` 传入独立的 params（独立 EventBus、独立 Context、共享 Provider）
- 背景 Agent 的 EventBus 事件通过 `bridgeEvents()` 冒泡到主会话的 EventBus
- 完成通知通过 Orchestrator 的 `onBackgroundComplete` 回调传递给 CLI/Channel

**为什么知行特别需要这个**：知行是"个人助手"不是"编程工具"。个人助手场景下用户经常说"顺便帮我查一下 XX"——这天然就是背景任务。编程工具场景下用户通常在等结果，但个人助手场景下用户经常在多线程处理事务。

#### 3.6.3 Monitor（反应式监控）

**核心能力**：Agent 订阅一个实时事件流，满足条件时自动反应。

```typescript
interface MonitorSpec {
  id: string;
  name: string;
  enabled: boolean;

  /** 监控什么 */
  source:
    | { kind: "process"; command: string }          // 监控进程输出
    | { kind: "file"; path: string }                // 监控文件变化
    | { kind: "eventbus"; pattern: string }         // 监控 EventBus 事件
    | { kind: "webhook"; path: string }             // 监控入站 webhook
    | { kind: "channel"; channelId: string };       // 监控通道消息

  /** 怎么反应 */
  reaction:
    | { kind: "agent-turn"; prompt: string }        // 触发 agent 处理
    | { kind: "notify"; delivery: TaskDelivery }    // 通知用户
    | { kind: "callback"; handler: string };        // 调用回调

  /** 过滤条件（可选） */
  filter?: { pattern: string };                     // 正则匹配

  /** 生命周期 */
  expiresAt?: string;                               // 自动过期
  maxTriggers?: number;                              // 最大触发次数
}
```

**与 EventBus 的关系**：EventBus 是**基础设施**（事件传输），Monitor 是**业务抽象**（订阅 + 过滤 + 反应）。EventBus 已经是一等公民，Monitor 是它的自然延伸。`eventbus` 类型的 source 直接订阅 EventBus 事件；其他类型的 source 先转化为事件再处理。

**典型场景**：
- "监控服务器日志，出现 ERROR 就通知我钉钉"
- "监控这个 API 的响应时间，超过 2s 就告警"
- "监控部署流水线，完成后总结结果发给我"

**与 Scheduler 的差异**：
| 维度 | Scheduler | Monitor |
|------|-----------|---------|
| 触发方式 | 时间驱动 | 事件驱动 |
| 适用场景 | "每天 8 点做 X" | "一有 Y 发生就做 Z" |
| 执行频率 | 可预测 | 不可预测 |
| 生命周期 | 持续（直到 disable） | 可设过期 / 最大触发数 |

#### 3.6.4 TaskGraph（任务依赖图）

对现有 Scheduler 的**扩展**，不是替换。在 `TaskSchedule` 中新增两种调度模式：

```typescript
// 扩展 TaskSchedule（在 §4.2 原有三种基础上新增两种）
type TaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string }
  // ─── v2.0 新增 ───
  | { kind: "after"; taskIds: string[] }              // 前置依赖：所有指定任务完成后触发
  | { kind: "self-paced"; initialDelayMs: number };   // 自定步调：agent 执行完自己决定下次时间
```

**`after` 模式——任务依赖**：
```
用户: 帮我做三件事：先搜索 API 文档，再分析现有代码，两个都完成后再开始实现功能
→ AI 创建三个任务：
  Task A: 搜索 API 文档       schedule: { kind: "once", at: "now" }
  Task B: 分析现有代码         schedule: { kind: "once", at: "now" }
  Task C: 实现功能             schedule: { kind: "after", taskIds: ["A", "B"] }
→ A 和 B 并行执行，C 等两者都完成后自动触发
```

**`self-paced` 模式——自定步调**：
```
用户: 帮我持续关注这个 GitHub issue，有新进展就通知我
→ AI 创建任务：
  schedule: { kind: "self-paced", initialDelayMs: 3600000 }  // 初始 1 小时后检查
→ 第一次执行：没有新进展 → agent 返回 "下次 4 小时后检查"
→ 第二次执行：有新评论 → agent 通知用户 + 返回 "下次 30 分钟后检查"
→ agent 根据变化频率自主调整检查间隔
```

`self-paced` 通过 `AgentTurnResult` 的新字段传递下次调度时间：
```typescript
interface AgentTurnResult {
  status: "ok" | "error";
  output?: string;
  error?: string;
  durationMs: number;
  /** self-paced 任务：agent 建议的下次执行延迟（毫秒） */
  nextDelayMs?: number;
}
```

#### 3.6.5 Orchestrator EventBus 事件

```typescript
type OrchestratorEvents = {
  'orchestrator:background-spawned':  { agentId: string; parentSessionId: string; prompt: string };
  'orchestrator:background-complete': { agentId: string; status: "done" | "error"; summary?: string };
  'orchestrator:pushed-to-background': { agentId: string; sessionId: string };
  'orchestrator:monitor-created':     { monitorId: string; source: MonitorSpec["source"] };
  'orchestrator:monitor-triggered':   { monitorId: string; event: unknown };
  'orchestrator:monitor-expired':     { monitorId: string };
  'orchestrator:task-dependency-met': { taskId: string; completedDeps: string[] };
};
```

## 四、Scheduler（定时任务调度器）

### 4.1 定位

Scheduler 是 Server 模式的核心子系统，负责定时任务的创建、调度、执行和投递。

**与 OpenClaw Cron 的本质差异**：

| 维度 | OpenClaw Cron | 知行 Scheduler |
|------|---------------|----------------|
| 复杂度 | ~130 个文件 | 目标 <20 个文件 |
| 概念数 | sessionTarget / wakeMode / delivery / failureAlert / ... | Task + Schedule + Action |
| 创建方式 | JSON 配置 / CLI 命令 | **自然语言**（AI 理解用户意图后调用 API） |
| 与 Agent 关系 | Agent 是 Cron 的执行器 | Scheduler 是 Agent 的一个能力 |
| 可测试性 | ✅ 依赖注入 | ✅ 依赖注入 + EventBus 断言 |

### 4.2 核心概念（只有三个）

```typescript
// ─── 定时任务 ───
interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: TaskPriority;   // 默认 "normal"

  schedule: TaskSchedule;
  action: TaskAction;
  delivery?: TaskDelivery;

  state: TaskState;

  createdAt: string;    // ISO 8601
  updatedAt: string;
  /** 内置系统任务标记，用户不可删除 */
  system?: boolean;
}

// ─── 调度规则 ───
type TaskSchedule =
  | { kind: "once"; at: string }                // "2026-04-10T08:00:00+08:00"
  | { kind: "interval"; everyMs: number }       // 每 N 毫秒
  | { kind: "cron"; expr: string; tz?: string } // "0 8 * * *"
  // ─── v2.0 新增 ───
  | { kind: "after"; taskIds: string[] }        // 前置依赖完成后触发（见 §3.6.4 TaskGraph）
  | { kind: "self-paced"; initialDelayMs: number }; // agent 自定步调（见 §3.6.4）

// ─── 执行动作 ───
type TaskAction =
  | {
      kind: "agent-turn";
      prompt: string;
      model?: string;
      tools?: string[];
      // 持续性任务可指定 sessionId，跨运行保留上下文（走 ConversationManager，持久化 transcript）
      // 不指定则 ephemeral 执行：创建 bare AgentRuntime → run → dispose，不持久化 transcript，磁盘零痕迹
      sessionId?: string;
    }
  | { kind: "system"; handler: string; params?: Record<string, unknown> };

// ─── 结果投递 ───
type TaskDelivery =
  | { kind: "none" }
  | { kind: "channel"; channel: string; to: string }
  | { kind: "webhook"; url: string; headers?: Record<string, string> };

// ─── 任务优先级 ───
type TaskPriority = "low" | "normal" | "high" | "urgent";
// urgent: 穿透 Active Hours 免打扰，插队执行
// high:   插队但不穿透免打扰
// normal: 默认
// low:    让出给其他任务

// ─── 任务状态 ───
interface TaskState {
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  lastSummary?: string;           // 上次执行摘要（用于去重和展示）
  consecutiveErrors: number;
  runCount: number;
}
```

**设计理念**：

- **3+1 个核心概念**（Task + Schedule + Action + 可选 Priority）vs OpenClaw 的 10+ 个概念
- **`TaskAction`** 统一了 OpenClaw 的 sessionTarget + wakeMode + payload
- **`agent-turn`** = 启动 agent 会话执行 prompt（默认独立会话，可选持续会话）
- **`system`** = 内置的系统操作（记忆凝练、巡检等），不需要 LLM 调用
- **`sessionId`** 解决了"跨运行记忆"需求——"持续跟踪某 GitHub issue"这类任务需要上次的上下文
- **`priority`** 解决了"紧急穿透"需求——紧急任务可以穿透 Active Hours
- 每个概念都有明确的枚举值，用户不需要记忆组合规则

**与 OpenClaw 任务会话模式的对比**：

| OpenClaw (4 种 sessionTarget) | 知行 (2 种 + 可选 sessionId) |
|------|------|
| `"main"` — 注入事件到主会话（需 heartbeat 唤醒） | 不需要——直接执行，无主会话概念 |
| `"isolated"` — 独立临时会话 | `agent-turn` 默认行为（ephemeral：bare runtime，无 transcript） |
| `"current"` — 绑定到创建时的会话 | `agent-turn` + `sessionId: "当前会话ID"` |
| `"session:xxx"` — 指定命名会话 | `agent-turn` + `sessionId: "xxx"` |

### 4.3 Schedule 工具（AI 可调用）

```typescript
interface ScheduleToolInput {
  action: "create" | "list" | "update" | "delete" | "run";
  // create 时
  task?: {
    name: string;
    schedule: TaskSchedule;
    prompt: string;              // agent-turn 的提示词
    delivery?: TaskDelivery;
  };
  // update/delete/run 时
  id?: string;
  patch?: Partial<ScheduledTask>;
}
```

**用户体验**：

```
用户: 每天早上 8 点帮我查看今天的天气和日程安排，然后发到微信上
→ AI 理解意图
→ AI 调用 schedule.create({
    name: "每日早报",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
    prompt: "查看今天的天气预报和日程安排，整理成简洁的早报格式",
    delivery: { kind: "channel", channel: "wechat", to: "self" }
  })
→ AI 回复: "已创建定时任务'每日早报'，每天早上 8:00 执行。
   我会查看天气和日程，整理成早报发到你的微信。"
```

OpenClaw 的 `cron` 工具已经实现了自然语言创建定时任务，但其工具参数非常复杂（sessionTarget、wakeMode、delivery、payload.kind 等 10+ 个概念的组合规则）。知行的 `schedule` 工具将概念简化到 3 个（Task + Schedule + Action），降低模型调用出错率。

### 4.4 调度引擎

```
┌─ Scheduler Engine ─────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────────┐                                              │
│  │ TaskStore     │ ← JSON 持久化（~/.zhixing/scheduler.json）  │
│  │  load()       │                                              │
│  │  save()       │                                              │
│  │  addTask()    │                                              │
│  │  removeTask() │                                              │
│  └──────┬───────┘                                              │
│         │                                                       │
│  ┌──────▼───────┐                                              │
│  │ TimerLoop     │ ← 核心调度循环                               │
│  │  armTimer()   │   与 OpenClaw 相同模式：                     │
│  │  onTick()     │   计算最近到期时间 → setTimeout → 检查+执行  │
│  │               │   限制 delay ∈ [2s, 60s]（防漂移+防 tight loop）│
│  └──────┬───────┘                                              │
│         │                                                       │
│  ┌──────▼───────┐                                              │
│  │ TaskExecutor  │ ← 执行引擎                                   │
│  │  run(task)    │                                              │
│  │    ├── agent-turn (默认) → ephemeral runtime → prompt → dispose │
│  │    ├── agent-turn (+sessionId) → ConversationManager → 持久会话 │
│  │    └── system → 调用内置 handler                             │
│  │  deliver()    │ ← 结果投递                                   │
│  │    ├── channel → Channel Adapter                             │
│  │    └── webhook → HTTP POST                                   │
│  └──────────────┘                                              │
│                                                                 │
│  ┌──────────────┐                                              │
│  │ ErrorPolicy   │ ← 错误处理策略                               │
│  │  退避: [30s, 1m, 5m, 15m, 60m]                              │
│  │  once 任务: 最多重试 3 次，然后 disable                      │
│  │  连续 5 次失败: 通知用户                                     │
│  │  schedule 计算异常 3 次: 自动 disable                        │
│  └──────────────┘                                              │
│                                                                 │
│  事件发射: eventBus.emit('scheduler:*', ...)                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.5 并发控制

OpenClaw 用 Command Queue + 4 条 Lane 做并发隔离（~数百行代码）。知行用更简洁的方式实现：

```typescript
interface SchedulerConfig {
  maxConcurrent: number;       // 同时执行的最大任务数，默认 3
  taskTimeoutMs: number;       // 单个任务超时，默认 300_000（5 分钟）
}
```

**调度逻辑**：
```
onTick():
  due = collectDueTasks()          // 按 priority 排序：urgent > high > normal > low
  running = getRunningCount()
  slots = maxConcurrent - running
  
  if slots <= 0:
    事件: scheduler:queue-full
    return
  
  toRun = due.slice(0, slots)      // 取前 N 个（高优先级先执行）
  deferred = due.slice(slots)      // 剩余排队等下次 tick
  
  for task in toRun:
    executeWithTimeout(task, taskTimeoutMs)
```

**对比 OpenClaw**：OpenClaw 的 Lane 机制按工作负载类型隔离（default/cron/heartbeat/system），但同一 Lane 内无优先级。知行用单一队列 + 优先级排序，更简洁且真正实现了"紧急插队"。

### 4.6 Active Hours（免打扰时段）

这是 OpenClaw 心跳的核心功能之一，但它只在心跳级别过滤——如果一个 cron job 触发了 isolated agent turn，Active Hours 不生效。知行做到**双层过滤**：

```typescript
interface ActiveHoursConfig {
  enabled: boolean;
  start: string;               // "08:00"
  end: string;                 // "22:00"
  timezone: string;            // "Asia/Shanghai"
}
```

**双层过滤机制**：

```
任务到期
  │
  ▼
Scheduler 层过滤:
  ├── priority = "urgent" → 直接执行（穿透免打扰）
  ├── 在活跃时段内 → 正常执行
  └── 在免打扰时段 → 推迟到活跃时段开始时执行
      └── 事件: scheduler:task-deferred-quiet-hours
          
任务执行完成，准备投递结果
  │
  ▼
Delivery Pipeline 层过滤:
  ├── priority = "urgent" → 立即投递
  ├── 在活跃时段内 → 立即投递
  └── 在免打扰时段 → 入队，等活跃时段批量投递
      └── 事件: delivery:queued-quiet-hours
```

**为什么需要两层**：Scheduler 层避免在深夜浪费 LLM 调用（省钱）；Delivery 层避免深夜推送消息打扰用户（体验）。某些 `system` 类型任务（如 journal-gc）可以在深夜执行但不投递结果。

### 4.7 Delivery Pipeline（投递管线）

> **实现偏差：** 核心架构一致，接口细节有演化。`DeliverySender` 取代直接 ChannelRegistry 依赖（可插拔发送）；过滤器链为 `DeliveryFilter[]` 可注入（非硬编码）；重试语义区分 channel-not-ready（不消耗 attempts）与 send 失败（指数退避）。详见 [implementation-roadmap.md Step 12](../implementation-roadmap.md)。

OpenClaw 的结果投递分散在 heartbeat-runner、server-cron、outbound 等多处。知行将其统一为独立的 Delivery Pipeline：

```
┌─ Delivery Pipeline ──────────────────────────────────────────┐
│                                                               │
│  ┌──────────────┐                                            │
│  │ DeliveryQueue │ ← 持久化（~/.zhixing/delivery-queue.json）│
│  │  enqueue()    │   崩溃恢复后可重新投递                      │
│  │  dequeue()    │                                            │
│  │  peek()       │                                            │
│  └──────┬───────┘                                            │
│         │                                                     │
│  ┌──────▼───────┐                                            │
│  │ 过滤器链      │                                            │
│  │  ├── Active Hours 检查                                     │
│  │  ├── 去重（24h 内相同内容跳过）                              │
│  │  └── Channel Ready 检查                                    │
│  └──────┬───────┘                                            │
│         │                                                     │
│  ┌──────▼───────┐                                            │
│  │ 投递执行      │                                            │
│  │  ├── channel → ChannelAdapter.send()                      │
│  │  └── webhook → HTTP POST + 超时 + SSRF 防护               │
│  │  失败 → 指数退避重试（最多 3 次）                           │
│  └──────┬───────┘                                            │
│         │                                                     │
│  ┌──────▼───────┐                                            │
│  │ 结果处理      │                                            │
│  │  成功 → eventBus.emit('delivery:sent')                    │
│  │  失败 → eventBus.emit('delivery:failed')                  │
│  └──────────────┘                                            │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**对比 OpenClaw**：OpenClaw 的投递没有持久化队列，crash 后正在投递的结果丢失。知行的 DeliveryQueue 基于文件持久化，崩溃恢复后自动重试。

### 4.8 依赖注入

借鉴 OpenClaw 的 `CronServiceDeps` 模式，但增强：

```typescript
interface SchedulerDeps {
  now: () => Date;
  store: TaskStore;
  activeHours: ActiveHoursConfig;

  runAgentTurn: (params: AgentTurnParams) => Promise<AgentTurnResult>;
  systemHandlers: Map<string, SystemHandler>;

  delivery: DeliveryPipeline;
  eventBus: TypedEventBus;
  logger: Logger;
}

interface DeliveryPipeline {
  enqueue(item: DeliveryItem): Promise<void>;
  flush(): Promise<void>;   // 手动触发排空队列
  stats(): DeliveryStats;
}
```

### 4.9 Missed Task 追赶

与 OpenClaw 思路相同但简化：

```
Server 启动
  │
  ▼
store.load()
  │
  ▼
扫描所有 enabled 且 nextRunAt < now 的任务
  │
  ├── 数量 ≤ 3 → 立即依次执行
  │
  └── 数量 > 3 → 按 priority 排序执行前 3 个，其余按 5s 间隔重新调度
      └── 事件: scheduler:missed-tasks-deferred
```

### 4.10 内置系统任务

Server 启动时自动注册的内部任务，用户不可删除但可修改调度：

| 任务 ID | 默认调度 | 动作 | 优先级 | 说明 |
|---------|---------|------|--------|------|
| `__journal-gc` | `0 3 * * *`（凌晨 3 点） | `system:journal-lifecycle` | low | Journal 凝练 + 过期清理 |
| `__health-check` | 每 5 分钟 | `system:health-check` | normal | 进程健康 + Scheduler 状态 |
| `__delivery-retry` | 每 1 分钟 | `system:delivery-flush` | high | 重试失败的投递 |

用户通过对话创建的定时任务 ID 不以 `__` 开头。

## 五、Gateway API

> **完整协议设计**已迁移至 [server-gateway.md](./server-gateway.md)。本节保留概要。

### 5.1 定位

Server 模式下对外暴露的接口，供 CLI 远程连接、Web UI、移动端、第三方系统调用。

### 5.2 协议选择

- **有状态操作**：JSON-RPC 2.0 over WebSocket（会话、调度、背景 Agent、审批）
- **无状态查询**：HTTP REST（`GET /api/health`、`GET /api/status`）
- **外部兼容**：`POST /v1/chat/completions`（OpenAI 兼容，S7 实现）

完整方法列表（~20 个 RPC 方法 + 推送事件）见 [server-gateway.md §5](./server-gateway.md)。

### 5.3 CLI 远程模式

当 Server 以 Daemon 模式运行时（S4），CLI 可以选择连接到 Server 而非独立运行：

```bash
zhixing              # 检测到 Server 运行中 → 连接 Server 的 WebSocket
zhixing --local      # 强制本地运行（独立于 Server）
```

**判断逻辑**：
1. 检查 `~/.zhixing/server.pid`（PID 文件）
2. 如果存在 → 尝试连接 WebSocket
3. 连接成功 → 代理模式（CLI 变为 Server 的终端前端）
4. 连接失败 → 本地模式

此功能在 **S4 Daemon** 阶段实现（S2 前台模式下 Server 占据终端，无 CLI 连接场景）。

## 六、Channel Adapter（通道适配器）

> **⚠️ 接口已升级**：本节的 6 方法接口是 v1 初版设计，已被 [server-gateway.md §4](./server-gateway.md) 的**两层模型**（3 必须方法 + N 可选 Capability Traits）替代。实现时以 server-gateway.md 为准。本节保留作为演进记录。

### 6.1 定位

Channel Adapter 是知行连接社交平台的桥梁。这是产品定位"独立部署 + 社交平台接入"的核心基础设施。

### 6.2 统一接口（v1，已被 server-gateway.md §4 替代）

```typescript
interface ChannelAdapter {
  readonly id: string;          // "wechat" | "dingtalk" | "telegram" | ...
  readonly name: string;        // 显示名称

  // 生命周期
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isReady(): boolean;

  // 出站：发送消息到通道
  send(message: OutboundMessage): Promise<SendResult>;

  // 入站：接收来自通道的消息
  onMessage(handler: (msg: InboundMessage) => void): Disposable;

  // 状态
  status(): ChannelStatus;
}

interface OutboundMessage {
  to: string;                   // 接收者标识
  text: string;
  mediaUrls?: string[];
  threadId?: string;            // 群/话题内的线程
}

interface InboundMessage {
  from: string;                 // 发送者标识
  text: string;
  channel: string;              // 来源通道 ID
  mediaUrls?: string[];
  threadId?: string;
  raw?: unknown;                // 原始平台数据（调试用）
}
```

### 6.3 入站消息处理流程

```
Channel Adapter 收到消息
  │
  ▼
ChannelRouter（路由器）
  │ 识别发送者、解析消息
  ▼
Session 解析
  │ 找到或创建对应的 session
  ▼
Agent Kernel 处理
  │ 跟 CLI 输入走完全相同的 Agent Loop
  ▼
结果通过 Delivery Pipeline 投递回通道
```

**核心设计**：入站消息经过 ChannelRouter 后，与 CLI 用户输入走**同一条 Agent Loop 路径**——这是"统一内核"原则的具体体现。

### 6.4 适配器注册

```typescript
// 插件式注册，每个通道一个适配器文件
const channelRegistry = new Map<string, () => ChannelAdapter>();

channelRegistry.set('wechat', () => new WeChatAdapter());
channelRegistry.set('dingtalk', () => new DingTalkAdapter());
channelRegistry.set('webhook', () => new WebhookAdapter());  // 通用 Webhook 入站
```

Channel Adapter 的实现文件独立于核心包，可以按需安装：

```
packages/
  channels/
    wechat/     → @zhixing/channel-wechat
    dingtalk/   → @zhixing/channel-dingtalk
    webhook/    → @zhixing/channel-webhook
```

## 七、Daemon（OS 级服务管理）

### 7.1 设计理念

**渐进式采用**：

```
Level 0: zhixing serve                    ← 前台运行（调试/临时）
Level 1: zhixing serve --daemon           ← 后台运行（nohup + PID 文件）
Level 2: zhixing serve --install          ← OS 服务安装（launchd/systemd）
```

- Level 0 不需要任何系统配置，适合初次尝试和开发调试
- Level 1 只需一个命令，适合个人日常使用
- Level 2 等同 OpenClaw 的 `daemon install`，适合需要开机自启的用户

### 7.2 `--daemon` 模式（Level 1，MVP）

```
zhixing serve --daemon
  │
  ▼
fork 子进程
  │ 子进程:
  │   detach stdio
  │   写入 PID 文件（~/.zhixing/server.pid）
  │   写入端口文件（~/.zhixing/server.port）
  │   启动 Gateway + Scheduler
  │   监听 SIGTERM → 优雅停机
  │
  ▼ 父进程:
  打印 "Server started (PID: xxx, PORT: yyy)"
  退出
```

**优雅停机**：

```
zhixing serve stop
  │
  ▼
读取 PID 文件
  │
  ▼
发送 SIGTERM
  │ 子进程收到:
  │   停止接受新任务
  │   等待活跃任务完成（最多 30s）
  │   关闭 WebSocket 连接
  │   保存 Scheduler 状态
  │   删除 PID 文件
  │   退出
```

### 7.3 OS 服务安装（Level 2，后期）

与 OpenClaw 相同思路，但简化实现：

```typescript
interface ServiceManager {
  install(config: ServiceConfig): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}
```

每个平台一个实现文件（vs OpenClaw 每个平台 5-10 个文件）。

## 八、进程管理

### 8.1 进程锁

通过端口监听实现进程锁（比 PID 文件更可靠）：

```
启动时:
  尝试监听配置端口（默认 18900）
    ├── 成功 → 获得锁，继续启动
    └── 失败 (EADDRINUSE) → 另一个 Server 已运行，报错退出
```

### 8.2 优雅重启

```
SIGUSR1
  │
  ▼
scheduler.pause()           ← 暂停定时器
  │
  ▼
等待活跃任务完成（最多 30s）
  │
  ▼
scheduler.save()            ← 持久化当前状态
  │
  ▼
gateway.close()             ← 关闭 HTTP/WS
  │
  ▼
重新加载配置
  │
  ▼
gateway.start()             ← 重新启动
scheduler.resume()          ← 恢复定时器 + missed task 追赶
```

## 九、事件流（EventBus 集成）

### 9.1 Scheduler 事件

```typescript
type SchedulerEvents = {
  'scheduler:task-created': { task: ScheduledTask };
  'scheduler:task-updated': { taskId: string; changes: Partial<ScheduledTask> };
  'scheduler:task-removed': { taskId: string };
  'scheduler:task-started': { taskId: string; runAt: string };
  'scheduler:task-completed': { taskId: string; status: 'ok' | 'error'; durationMs: number; summary?: string };
  'scheduler:task-delivered': { taskId: string; delivery: TaskDelivery; success: boolean };
  'scheduler:missed-tasks': { count: number; executed: number; deferred: number };
  'scheduler:error-backoff': { taskId: string; consecutiveErrors: number; nextRetryAt: string };
};
```

### 9.2 Delivery 事件

```typescript
type DeliveryEvents = {
  'delivery:enqueued': { taskId: string; delivery: TaskDelivery; reason?: string };
  'delivery:sent': { taskId: string; channel: string; to: string; durationMs: number };
  'delivery:failed': { taskId: string; channel: string; error: string; retryAt?: string };
  'delivery:queued-quiet-hours': { taskId: string; deliverAt: string };
  'delivery:deduplicated': { taskId: string; reason: string };
};
```

### 9.3 Channel 事件

```typescript
type ChannelEvents = {
  'channel:connected': { channelId: string };
  'channel:disconnected': { channelId: string; reason: string };
  'channel:message-received': { channelId: string; from: string };
  'channel:reconnecting': { channelId: string; attempt: number };
};
```

### 9.4 Server 事件

```typescript
type ServerEvents = {
  'server:started': { port: number; pid: number };
  'server:stopping': { reason: string };
  'server:stopped': {};
  'server:client-connected': { clientId: string; type: 'websocket' | 'http' };
  'server:client-disconnected': { clientId: string };
};
```

这些事件自动流向：
- CLI 终端渲染（通过 EventBus）
- WebSocket 客户端（通过事件订阅）
- 日志文件（通过 EventBus → Logger）

## 十、与 OpenClaw / Claude Code / Hermes 的对比

> v2.0 更新：Claude Code 不再是"N/A"——它在智能协调维度已经行业领先。

### 10.1 常驻基础设施对比

| 维度 | OpenClaw | Claude Code | Hermes | **知行** |
|------|----------|-------------|--------|---------|
| **架构模型** | Gateway 单体 | 无常驻架构 | asyncio 单进程 | **入站/调度/出站三层分离** |
| **心跳依赖** | ✅ ~1200 行 | N/A | ❌ | **不需要** |
| 激活门槛 | `daemon install` | N/A | `hermes gateway run` | **`zhixing serve`** |
| 定时任务 | cron（10+ 概念） | Remote Triggers（云端） | Cron Ticker | **schedule**（3+1 概念） |
| 调度器复杂度 | ~130 文件 | N/A | ~200 行 | **<20 文件** |
| 并发控制 | 4 条 Lane | N/A | 无 | **maxConcurrent + 优先级** |
| 免打扰 | 心跳级 | N/A | 无 | **双层过滤 + urgent 穿透** |
| 投递管线 | 分散无持久化 | N/A | 分散 | **独立 Pipeline + 持久化** |
| 通道适配 | Plugin（35 slot） | 无 | BasePlatformAdapter | **3 必须 + N trait** |
| 中国平台 | ❌ | ❌ | ✅ 钉钉/飞书 | ✅ **钉钉首选** |

### 10.2 智能协调能力对比（v2.0 新增维度）

| 维度 | OpenClaw | Claude Code | Hermes | **知行** |
|------|----------|-------------|--------|---------|
| **背景 Agent** | ❌ | ✅ 领先 | ❌ | ✅ AgentOrchestrator |
| **前台推后台** | ❌ | ✅ Ctrl+B | ❌ | ✅ pushToBackground |
| **Monitor** | ❌ | ✅ Monitor Tool | ❌ | ✅ MonitorSpec |
| **任务依赖 DAG** | ❌ | ✅ Tasks | ❌ | ✅ `after` 调度 |
| **自定步调** | ❌ | ✅ /loop | ❌ | ✅ `self-paced` 调度 |
| **Agent 团队** | ❌ | ✅ Teams | ❌ | 🔮 未来（架构已支持） |
| **Harness SDK 化** | ⚠️ 隐含 | ✅ Claude Agent SDK | ⚠️ 隐含 | ✅ 显式 AgentRuntime |

### 10.3 综合定位

```
                    智能协调能力
                         ▲
                         │
              知行 ───── │ ───── Claude Code
             (两者兼得)   │     (只有协调)
                         │
        ─────────────────┼──────────────────→ 常驻基础设施
                         │
              OpenClaw ── │
             (只有常驻)   │
                         │
              Hermes ──── │
             (常驻一般)   │
```

**知行是唯一同时覆盖"常驻运行基础设施"和"智能协调新范式"的开源个人助手。**

## 十一、渐进实现路线

每步独立可验证。v2.0 插入 S2.5 和 S3.5。**v2.1（2026-04-17）插入 S2.7：在 S2.5 前必须先统一会话语义,详见 [conversation-model.md §13](./conversation-model.md#十三渐进实现路线)。**

```
S1 Scheduler 核心 ──→ S2 Server 模式 ──→ S2.7 对话模型统一 ──→ S2.5 AgentOrchestrator ──→ S3 Delivery Pipeline
     (调度逻辑)          (前台运行)         (Conversation/Runtime/Transcript)   (背景Agent + 编排)          (投递 + 免打扰)
                              │                 │                          │
                              │                 │                          │
                              │                 ▼                          │
                              │         S3.5 Monitor + TaskGraph ◄─────────┘
                              │            (反应式监控 + 依赖)
                              │                 │
                              ▼                 ▼
                          S4 Daemon ────────────────────→ S5 Channel ──→ S6 OS 服务
                         (后台运行 + CLI远程)              (社交接入)     (开机自启)
```

**阶段依赖关系**：
| 阶段 | 前置依赖 | 说明 |
|------|---------|------|
| S1 | 无 | 在 CLI 进程内独立运行 |
| S2 | S1 | Scheduler 集成到 Server 进程 |
| S2.5 | S2 | 需要长生命周期进程（但核心逻辑也可在 CLI 独立验证） |
| S3 | S2 | Delivery Pipeline 运行在 Server 进程内 |
| S3.5 | **S1 + S2.5 + S3** | TaskGraph 扩展 Scheduler；Monitor reaction 需 Orchestrator 派生 agent；notify reaction 可选走 Delivery |
| S4 | S2 | Daemon 是 Server 的后台化 |
| S5 | S2 + S3 | Channel 需要 Server 的 HTTP 路由 + Delivery Pipeline |
| S6 | S4 | OS 服务是 Daemon 的系统级增强 |

### Phase S1: Scheduler 核心

**范围**：验证核心调度逻辑——能创建、能执行、能退避、能追赶。

**做什么**：
- `TaskStore`（JSON 持久化 `~/.zhixing/scheduler.json`，CRUD）
- `TimerLoop`（armTimer/onTick 调度循环，delay ∈ [2s, 60s]）
- `TaskExecutor`（agent-turn 独立会话执行 + system handler 调用）
- `ErrorPolicy`（指数退避 + 自动 disable）
- `schedule` 工具（AI 可调用，create/list/update/delete/run）
- `SchedulerConfig`（maxConcurrent、taskTimeoutMs）
- Scheduler EventBus 事件
- 优先级排序（due tasks 按 priority 排序执行）
- **系统提示更新**：`buildSystemPrompt()` 中注入 `schedule` 工具的使用引导，使 AI 知道何时/如何创建定时任务

**Scheduler 在 CLI 中的生命周期**：

```
REPL 启动（startRepl）
  ├── createSession()              ← 已有流程
  ├── scheduler = new Scheduler(deps)
  ├── scheduler.start()            ← 启动 TimerLoop（setTimeout 不阻塞 readline）
  │   └── load TaskStore → 检查 missed tasks → armTimer
  │
  ├── ─ REPL 循环 ─
  │   readline.question() 与 TimerLoop 在同一个 Node.js 事件循环中共存
  │   两者互不阻塞（readline 等 stdin，Timer 等 setTimeout）
  │
  └── REPL 退出（/exit 或 Ctrl+D）
      ├── scheduler.stop()         ← 清除 timer + 等待活跃任务完成（最多 10s）
      └── scheduler.save()         ← 持久化 TaskStore 到磁盘
```

**任务结果的终端输出策略**：S1 不做 Delivery Pipeline，任务结果通过 EventBus 通知 REPL 渲染。具体机制：
- `TaskExecutor` 完成后 emit `scheduler:task-completed` 事件
- REPL 订阅该事件，在**当前 readline prompt 之上**插入通知行（与已有的 retry/budget 事件渲染方式一致——先 `pauseUI()` 暂停 spinner，打印结果，再恢复 prompt）
- 如果用户正在输入，通知在下一个 readline prompt 前显示（不打断输入行）

**不做什么**：
- 不做 Server 模式（Scheduler 先在 CLI 进程内运行）
- 不做 Delivery Pipeline（结果通过 EventBus → REPL 终端渲染）
- 不做 Active Hours（CLI 进程内无意义）
- 不做 Daemon
- 不做 sessionId 持续性会话（Phase S3 再加）

**验证**：
- CLI 中自然语言创建："每 30 秒打印一句问候" → AI 调用 schedule.create → 到期自动执行 → 结果打印到终端
- 并发控制：创建 5 个同时到期的任务 → 观察最多 3 个并行执行
- 错误退避：故意让任务失败 → 观察退避间隔递增 → 连续 5 次失败后自动 disable
- Missed task 追赶：创建任务 → 关闭 CLI → 重启 → 补执行
- 优先级：创建 urgent + low 任务同时到期 → urgent 先执行
- REPL 退出：`/exit` → 观察 "等待活跃任务完成…" 日志 → TaskStore 已持久化

**交付**：
```
packages/core/src/scheduler/
  ├── types.ts              # ScheduledTask, TaskSchedule, TaskAction, TaskPriority
  ├── task-store.ts          # JSON 持久化 CRUD
  ├── timer-loop.ts          # 核心调度循环
  ├── task-executor.ts       # agent-turn + system 执行
  ├── error-policy.ts        # 退避 + 重试策略
  ├── config.ts              # SchedulerConfig
  └── index.ts               # Scheduler 入口
packages/tools-builtin/src/
  └── schedule.ts            # AI 可调用的 schedule 工具
packages/cli/src/
  └── system-prompt.ts       # 更新：注入 schedule 工具使用引导
```

### Phase S2: Server 前台模式

**范围**：知行可以作为长期运行的服务，对外提供 API。

**技术选型**：
- HTTP 服务器：Node.js 原生 `node:http`（零依赖，知行 MVP 不需要框架级路由；OpenClaw 和 Hermes 同样不使用框架）
- WebSocket：`ws` 包（Node.js 生态标准，OpenClaw 也用它）
- 协议：**JSON-RPC 2.0 over WebSocket**（详见 [server-gateway.md §5](./server-gateway.md)）用于有状态操作（会话、调度）；HTTP REST 仅用于无状态查询（`/api/health`、`/api/status`）和 OpenAI 兼容端点

**做什么**：
- 创建 `@zhixing/server` 包（独立于 core——Server 依赖 core，core 不依赖 Server）
- `zhixing serve` 命令（前台运行）
- HTTP 端点：`GET /api/health`、`GET /api/status`（无状态查询走 REST）
- WebSocket 端点 + JSON-RPC 2.0：`auth`、`health`、`session.send`、`session.list`、`server.status` 五个核心方法 + `session.delta`、`session.complete` 推送事件
- Scheduler 集成到 Server 进程（S1 的 Scheduler 从 CLI 进程迁移到 Server 进程，调用 `scheduler.start()` 位置变化，逻辑不变）
- 进程锁（端口监听锁）
- SIGTERM/SIGINT 优雅停机（等待活跃任务 → 保存状态 → 退出）
- SIGUSR1 优雅重启
- 内置系统任务：`__journal-gc`、`__health-check`（`__delivery-retry` 在 S3 实现 Delivery Pipeline 后再注册）

**不做什么**：
- 不做 CLI 远程连接模式（CLI 连接 Server 的 WebSocket 代理在 **S4 Daemon** 阶段实现——S2 是前台运行，Server 占据终端，无 CLI 连接场景）
- 不做 Delivery Pipeline（S3）
- 不做 Daemon（S4）

**验证**：
- `zhixing serve` 启动 → `curl http://localhost:18900/api/status` 返回服务状态
- `wscat -c ws://localhost:18900/ws` → 发送 auth JSON-RPC → 发送 `session.send` → 收到 `session.delta` 推送事件 → 收到 `session.complete`
- 创建定时任务 → 到期执行 → 通过 `schedule.list` RPC 查询任务状态
- Ctrl+C → 优雅停机（观察日志：等待任务 → 保存 → 退出）
- 记忆凝练由 `__journal-gc` 自动触发（凌晨 3 点或手动通过 RPC 触发）

**交付**：
```
packages/cli/src/commands/
  └── serve.ts               # zhixing serve 命令
packages/server/              # 新包 @zhixing/server
  ├── package.json
  ├── src/
  │   ├── index.ts            # 入口
  │   ├── server.ts           # HTTP + WebSocket 服务器（node:http + ws）
  │   ├── rpc/
  │   │   ├── protocol.ts     # JSON-RPC 2.0 编解码
  │   │   └── handlers.ts     # 方法分发
  │   ├── routes.ts           # REST 端点（/api/health, /api/status）
  │   └── process-lock.ts     # 端口锁
```

### Phase S2.5: AgentOrchestrator（v2.0 新增）

**范围**：知行可以在一个会话中派生背景 Agent 并发执行，不阻塞主对话。

**前置依赖**：S2（需要长生命周期进程；Server 模式下通过 RPC 暴露 background 方法）。但背景 Agent 的核心逻辑也可在 CLI 独立模式下验证。

**做什么**：
- `AgentOrchestrator`（agent 实例生命周期管理）
- `BackgroundAgent`（后台 agent 状态跟踪）
- `spawnBackground()`（从主会话派生背景 agent）
- `pushToBackground()`（前台任务推到后台，见下方技术方案）
- `onBackgroundComplete()`（完成通知回调）
- `bridgeEvents()`（背景 agent EventBus → 主 EventBus 事件冒泡）
- `createBackgroundSession()`（见下方接口契约）
- `background` 工具（AI 可调用，见下方触发机制）
- 背景 agent 安全策略：无渲染器时走 `NonInteractiveResolver`（已实现，零改动）
- Orchestrator EventBus 事件
- **系统提示更新**：`buildSystemPrompt()` 注入 `background` 工具使用引导
- CLI：`/background` 命令（列出/查看背景任务）+ Ctrl+B 推后台

**AI 如何触发 background spawn**：

新增 `background` 工具（与 `schedule` 工具同级），AI 在以下场景主动调用：
```typescript
// packages/tools-builtin/src/background.ts
interface BackgroundToolInput {
  action: "spawn" | "list" | "abort";
  // spawn 时
  prompt?: string;          // 背景任务的目标描述
  tools?: string[];         // 背景 agent 可用的工具子集（可选，默认继承父会话）
  // abort 时
  agentId?: string;
}
```
系统提示引导 AI 在用户说"后台"/"顺便"/"同时"等意图时调用此工具。AI 判断何时用 background vs 直接执行——如果任务简短（<10s）直接执行更合适。

**`createBackgroundSession()` 接口契约**：

```typescript
// packages/core/src/orchestrator/background-agent.ts
interface BackgroundSessionOptions {
  /** 父会话（共享 provider、security pipeline 配置） */
  parentSession: AgentSession;
  /** 背景任务的 prompt */
  prompt: string;
  /** 可选：覆盖模型 */
  model?: string;
  /** 可选：工具子集（默认继承父会话全部工具） */
  tools?: ToolDefinition[];
  /** AbortSignal（父会话退出时联动取消） */
  abortSignal: AbortSignal;
}

function createBackgroundSession(opts: BackgroundSessionOptions): {
  /** 独立的 EventBus（通过 bridgeEvents 冒泡到父） */
  eventBus: IEventBus<AgentEventMap>;
  /** 运行背景 agent，返回结果 Promise */
  run: () => Promise<AgentResult>;
}
```

共享的部分：`provider`（复用 LLM 连接和 prompt cache）、`securityPipeline`（共享规则，但 ConfirmationBroker 不 attach 渲染器）、`memoryStore`（共享记忆）。
独立的部分：`eventBus`（独立实例）、`contextEngine`（独立上下文预算）、`messages`（独立对话历史）。

**Ctrl+B 技术方案**：

核心挑战：Agent Loop 是 AsyncGenerator，消费者（REPL）正在 `await gen.next()` 阻塞。按 Ctrl+B 需要把这个 generator **转移**到后台继续消费，同时恢复 readline 输入。

```
用户按 Ctrl+B（stdin raw mode 捕获 \x02 字节码）
  │
  ▼
① 设置标志位 pushToBackgroundRequested = true
  │ 当前 gen.next() 仍在 await，不中断
  │
  ▼
② 当前 yield 返回后，REPL 的消费循环检查标志位
  │ if (pushToBackgroundRequested) {
  │   // 不再在 REPL 循环中消费 gen，转交给后台
  │   orchestrator.adoptGenerator(gen, currentState)
  │   break;  // 退出 REPL 的消费循环
  │ }
  │
  ▼
③ orchestrator.adoptGenerator() 内部：
  │ - 创建 BackgroundAgent 记录
  │ - 启动一个 detached Promise 继续消费 gen.next() 直到 done
  │ - 完成后 emit 'orchestrator:background-complete' 事件
  │
  ▼
④ REPL 循环退出后，恢复 readline.question() 等待新输入
  │ 背景 agent 的 EventBus 事件通过 bridgeEvents 冒泡
  │ 完成通知通过 REPL 的 EventBus 订阅渲染
```

关键约束：
- Ctrl+B 的捕获通过已有的 `stdin-ownership.ts` 模块管理——在 typeahead raw mode 下直接检测 `\x02`，在 readline 模式下注册 keypress 监听
- Generator 不可"暂停"——`adoptGenerator` 接管后会**继续运行直到完成**，只是结果不再渲染到前台
- 如果用户在后台 agent 运行期间再次输入并触发新的 agent run，两个 agent loop 共享 provider 并发调用 LLM——这是安全的（provider 是无状态的）

**不做什么**：
- 不做 Monitor（S3.5）
- 不做 TaskGraph（S3.5）
- 不做 Agent Teams / Mailbox（未来）

**验证**：
- REPL 中："帮我后台查一下天气" → AI 调用 `background.spawn` → 主对话继续 → 背景完成后通知弹回
- Ctrl+B：正在执行的长任务 → 按 Ctrl+B → 推到后台 → 主输入恢复 → 后台完成后通知弹回
- `/background` 列出所有背景任务状态（running / done / error）
- 背景 agent 遇到高风险工具 → NonInteractiveResolver 自动 deny → 不阻塞主会话
- Server 模式下：通过 RPC `background.spawn` / `background.list` 管理
- 父会话退出 → AbortSignal 触发 → 背景 agent 优雅终止

**交付**：
```
packages/core/src/orchestrator/
  ├── types.ts               # BackgroundAgent, AgentOrchestrator, BackgroundSessionOptions
  ├── orchestrator.ts         # AgentOrchestrator 实现
  ├── background-agent.ts     # createBackgroundSession + adoptGenerator
  ├── event-bridge.ts         # EventBus 事件冒泡
  └── index.ts
packages/tools-builtin/src/
  └── background.ts           # AI 可调用的 background 工具
packages/cli/src/
  ├── background.ts           # /background 命令 + Ctrl+B stdin 捕获
  └── system-prompt.ts        # 更新：注入 background 工具使用引导
```

### Phase S3: Delivery Pipeline + Active Hours

**范围**：任务结果可靠投递，免打扰时段保护。

**做什么**：
- `DeliveryPipeline`（持久化队列 `~/.zhixing/delivery-queue.json`）
- `DeliveryQueue`（enqueue/dequeue/peek，FIFO + priority 排序）
- Webhook 投递（HTTP POST + 30s 超时 + SSRF 防护 + 指数退避重试）
  - SSRF 防护过滤内网地址：`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1`、`fc00::/7`
- Active Hours 配置（全局 + Scheduler/Delivery 双层过滤）
- 去重逻辑（24h 内相同 taskId + 相同 content → 跳过）
- `__delivery-retry` 内置系统任务（此时注册——S2 阶段未注册是因为 Delivery Pipeline 尚不存在）
- Delivery EventBus 事件
- `agent-turn` 的 `sessionId` 支持（持续性任务会话）

**不做什么**：
- 不做 Channel Adapter（channel 投递先返回 "channel not configured" 错误）
- 不做 Daemon

**验证**：
- 创建任务 + webhook delivery → 到期 → 执行 → HTTP POST 到目标 URL → 收到 payload
- 设置 Active Hours 22:00-08:00 → 在 23:00 创建到期任务 → normal priority → Scheduler 推迟到 08:00
- 同上但 urgent priority → 立即执行 + 立即投递
- 崩溃恢复：任务执行成功 → 投递失败（断网）→ 强制 kill → 重启 → delivery-queue 中恢复 → 重新投递
- 去重：两次执行产生相同结果 → 第二次投递被跳过
- 持续性会话：创建带 sessionId 的任务 → 连续执行 3 次 → 第 3 次 AI 能引用前两次的上下文

**交付**：
```
packages/core/src/delivery/
  ├── types.ts               # DeliveryItem, DeliveryPipeline
  ├── delivery-queue.ts      # 持久化队列
  ├── delivery-pipeline.ts   # 过滤 → 投递 → 重试
  ├── webhook.ts             # HTTP POST 投递
  ├── dedup.ts               # 去重逻辑
  └── active-hours.ts        # 免打扰时段判断
```

### Phase S3.5: Monitor + TaskGraph（v2.0 新增）

**范围**：知行可以反应式监控事件流，支持任务间依赖关系和自定步调。

**前置依赖**：
- S1（Scheduler 核心——TaskGraph 是 Scheduler 的扩展）
- **S2.5**（AgentOrchestrator——Monitor 的 `agent-turn` reaction 通过 `orchestrator.spawnBackground()` 派生 agent 执行）
- S3（Delivery Pipeline——Monitor 的 `notify` reaction 通过 Delivery 投递通知，可选依赖：无 Delivery 时降级为终端打印）

**做什么**：
- `MonitorRegistry`（Monitor 注册 + 生命周期管理）
- `MonitorSpec` 支持的 source 类型：`process` / `file` / `eventbus`（其余在 S5 后解锁）
- `MonitorRunner`（source → filter → reaction 管线）
- `TaskSchedule` 的 `after` 模式（任务依赖，见下方解析机制）
- `TaskSchedule` 的 `self-paced` 模式（agent 自定步调）
- `AgentTurnResult.nextDelayMs`（self-paced 回传下次延迟）
- `monitor` 工具（AI 可调用，create/list/stop）
- **系统提示更新**：`buildSystemPrompt()` 注入 `monitor` 工具使用引导
- Monitor 和 TaskGraph 的 EventBus 事件

**`after` 模式的依赖解析机制**：

```
任务 A 完成（scheduler:task-completed 事件）
  │
  ▼
Scheduler.onTaskComplete(taskId) 回调：
  ├── 扫描所有 enabled 且 schedule.kind === "after" 的任务
  ├── 对每个候选任务：
  │   检查 schedule.taskIds 中的每个依赖 ID
  │   查对应任务的 state.lastStatus
  │   ├── 全部 === "ok" → 解锁：设置 nextRunAt = now，下个 tick 执行
  │   ├── 任一 === "error" → emit 'orchestrator:task-dependency-failed'
  │   │   默认行为：不触发，等用户修复后手动 run
  │   │   可选：配置 failStrategy: "run-anyway" | "wait"（未来扩展）
  │   └── 任一未完成（无 lastStatus）→ 继续等待
  └── emit 'orchestrator:task-dependency-met'（如果有任务被解锁）
```

**`self-paced` 模式的调度逻辑**：
```
self-paced 任务首次调度：nextRunAt = now + initialDelayMs
  │
  ▼
TaskExecutor 执行 agent-turn
  │
  ▼
AgentTurnResult 返回：
  ├── nextDelayMs 存在 → nextRunAt = now + nextDelayMs
  ├── nextDelayMs 为 null/undefined → nextRunAt = now + initialDelayMs（回退到初始间隔）
  └── status === "error" → 走 ErrorPolicy 正常退避逻辑
```

**不做什么**：
- 不做 `channel` 类型的 Monitor source（需要 S5 Channel 框架）
- 不做 Agent Teams / Mailbox

**验证**：
- "监控 /tmp/test.log，出现 ERROR 就告诉我" → AI 调用 `monitor.create` → 写入 ERROR → agent 通知
- "先查文档，再分析代码，两个都完成后开始实现" → 3 个任务 A/B/C → C 的 schedule 是 `{ kind: "after", taskIds: ["A","B"] }` → A/B 并行完成后 C 自动触发
- after 依赖失败：A 成功，B 失败 → C 不触发 → emit dependency-failed 事件 → 用户修复 B → 手动 run B → B 成功 → C 自动触发
- "持续关注这个议题" → self-paced 任务 → 第一次无变化返回 4h → 有变化返回 30min
- self-paced agent 返回空 nextDelayMs → 回退到 initialDelayMs 间隔

**交付**：
```
packages/core/src/orchestrator/
  ├── monitor-registry.ts     # Monitor 注册表
  ├── monitor-runner.ts       # source → filter → reaction
  └── sources/
      ├── process-source.ts   # 进程输出监控
      ├── file-source.ts      # 文件变化监控（fs.watch）
      └── eventbus-source.ts  # EventBus 事件监控
packages/core/src/scheduler/
  └── task-graph.ts           # after 解析 + self-paced 调度扩展
packages/tools-builtin/src/
  └── monitor.ts              # AI 可调用的 monitor 工具
packages/cli/src/
  └── system-prompt.ts        # 更新：注入 monitor 工具使用引导
```

### Phase S4: Daemon 后台模式 + CLI 远程连接

**范围**：知行可以在后台持续运行，CLI 可以连接到运行中的 Server。

**做什么**：
- `zhixing serve --daemon`（后台启动 Server 进程）
  - Linux/macOS：`child_process.fork()` + detach stdio + setsid
  - Windows：`child_process.spawn()` + `detached: true` + `unref()` + stdio 重定向到 null（Windows 没有 POSIX fork，需要 spawn 模式）
  - 写入 PID 文件（`~/.zhixing/server.pid`）和端口文件（`~/.zhixing/server.port`）
- `zhixing serve stop`（发送 SIGTERM → 优雅停机；Windows 通过 `process.kill(pid)` 发送）
- `zhixing serve status`（检查 PID + 端口探活）
- **CLI 远程连接模式**（从 S2 移至此阶段——S2 是前台运行无连接场景）：
  - REPL 启动时检测 `~/.zhixing/server.pid` → 尝试 WebSocket 连接
  - 连接成功 → CLI 变为 Server 的终端前端，所有 agent 请求通过 JSON-RPC 转发到 Server
  - 连接失败 → 回退到本地独立模式
  - `zhixing --local` 强制跳过检测，本地独立运行

**不做什么**：
- 不做 OS 级服务安装（S6）

**验证**：
- `zhixing serve --daemon` → 后台运行 → `zhixing serve status` 显示运行中
- `zhixing` → 自动检测到 Server → 连接 WebSocket → 对话通过 Server 的 Agent 内核处理
- `zhixing --local` → 独立运行（不连接 Server）
- `zhixing serve stop` → SIGTERM → 优雅停机
- 创建定时任务 → 关闭所有终端 → 任务仍然到期执行
- Windows：`zhixing serve --daemon` → 任务管理器可见 node 进程 → `zhixing serve stop` → 进程消失

**交付**：
```
packages/cli/src/commands/
  └── serve.ts               # 扩展 daemon/stop/status 子命令
packages/cli/src/daemon/
  ├── process.ts             # fork/spawn + detach 逻辑（跨平台）
  └── pid.ts                 # PID 文件管理
packages/cli/src/
  └── remote-client.ts       # CLI → Server WebSocket 代理
```

### Phase S5: Channel Adapter 框架 + 首个通道

**范围**：知行可以接收和发送社交平台消息。

**做什么**：
- `ChannelAdapter` 两层接口（**以 [server-gateway.md §4](./server-gateway.md) 的 v2 模型为准**——3 必须方法 + N 可选 Capability Traits）
- `InboundRouter`（完整管线：normalize → debounce → command detect → session-bind → concurrency guard → agent turn → result routing，详见 server-gateway.md §6）
- `ChannelRegistry`（适配器注册表，插件式加载）
- Delivery Pipeline 对接 `ChannelAdapter.send()`
- `DeliveryRouter`（智能投递路由：显式指定 > 触发来源 > 最近活跃 > 默认通道）
- Channel EventBus 事件
- 首个通道实现：Webhook Adapter（通用 HTTP 入站/出站，可对接任意平台的 webhook）

> **注意**：本文档 §6 的旧版 6 方法 ChannelAdapter 接口已被 server-gateway.md §4 的两层模型替代。实现时以后者为准。

**验证**：
- 配置 Webhook Channel → 外部 HTTP POST 到 `/api/channel/webhook` → InboundRouter 处理 → Agent 执行 → 回复 POST 到配置的 callback URL
- 创建定时任务 + channel delivery → 到期 → 执行 → 通过 Webhook Channel 投递
- Channel 断开 → Delivery Pipeline 排队 → Channel 恢复 → 自动重试投递
- 去抖验证：500ms 内连发 3 条消息 → 合并为 1 条处理

**交付**：
```
packages/core/src/channels/
  ├── types.ts               # ChannelAdapter (v2), Capability Traits, InboundMessage, OutboundContent
  ├── capabilities.ts        # 类型守卫 (isEditable, isStreamable, isApprovable, ...)
  ├── registry.ts            # ChannelRegistry
  └── index.ts
packages/server/src/inbound/
  ├── router.ts              # InboundRouter（完整管线）
  ├── debouncer.ts           # 入站去抖
  ├── session-binder.ts      # 会话绑定策略
  └── normalizer.ts          # 消息规范化
packages/server/src/outbound/
  └── delivery-router.ts     # 智能投递路由
packages/channels/webhook/
  └── index.ts               # 通用 Webhook 适配器
```

### Phase S6: OS 级服务安装（可选）

**范围**：开机自启 + 崩溃自动恢复。

**做什么**：
- `zhixing serve --install`（安装 OS 服务）
- `zhixing serve --uninstall`
- launchd（macOS）/ systemd（Linux）/ schtasks（Windows）适配
- 每平台 1 个文件

**验证**：
- macOS: `zhixing serve --install` → 重启系统 → 服务自动启动
- Linux: 同上（systemd）
- Windows: 同上（schtasks）
- 强制 kill 进程 → OS 自动重启

**交付**：
```
packages/cli/src/daemon/
  ├── service-manager.ts     # ServiceManager 统一接口
  ├── launchd.ts             # macOS
  ├── systemd.ts             # Linux
  └── schtasks.ts            # Windows
```

## 十二、核心类型设计

```typescript
// ─── Scheduler 核心类型 ───

interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: TaskPriority;

  schedule: TaskSchedule;
  action: TaskAction;
  delivery?: TaskDelivery;

  state: TaskState;

  createdAt: string;
  updatedAt: string;
  system?: boolean;
}

type TaskPriority = "low" | "normal" | "high" | "urgent";

type TaskSchedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "after"; taskIds: string[] }                // v2.0: 前置依赖
  | { kind: "self-paced"; initialDelayMs: number };     // v2.0: 自定步调

type TaskAction =
  | {
      kind: "agent-turn";
      prompt: string;
      model?: string;
      tools?: string[];
      sessionId?: string;     // 持续性任务可指定会话 ID
    }
  | { kind: "system"; handler: string; params?: Record<string, unknown> };

type TaskDelivery =
  | { kind: "none" }
  | { kind: "channel"; channel: string; to: string }
  | { kind: "webhook"; url: string; headers?: Record<string, string> };

interface TaskState {
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
  lastSummary?: string;
  consecutiveErrors: number;
  runCount: number;
}

// ─── Active Hours ───

interface ActiveHoursConfig {
  enabled: boolean;
  start: string;               // "08:00"
  end: string;                 // "22:00"
  timezone: string;            // "Asia/Shanghai"
}

// ─── Scheduler 配置 & 依赖注入 ───

interface SchedulerConfig {
  maxConcurrent: number;       // 默认 3
  taskTimeoutMs: number;       // 默认 300_000
  activeHours: ActiveHoursConfig;
}

// 实现偏差：delivery 为可选 IDeliveryPipeline；无 eventBus（投递是任务生命周期的一部分，非事件）；
// 新增 resolveDeliveryTarget?（Step 15 自动路由）。详见 implementation-roadmap.md Step 13/15。
interface SchedulerDeps {
  now: () => Date;
  config: SchedulerConfig;
  store: TaskStore;
  runAgentTurn: (params: AgentTurnParams) => Promise<AgentTurnResult>;
  systemHandlers: Map<string, SystemHandler>;
  delivery: DeliveryPipeline;
  eventBus: TypedEventBus;
  logger: Logger;
}

interface AgentTurnParams {
  prompt: string;
  model?: string;
  tools?: string[];
  sessionId?: string;
  abortSignal?: AbortSignal;
}

interface AgentTurnResult {
  status: "ok" | "error";
  output?: string;
  error?: string;
  durationMs: number;
  /** v2.0: self-paced 任务 — agent 建议的下次执行延迟（毫秒） */
  nextDelayMs?: number;
}

type SystemHandler = (params?: Record<string, unknown>) => Promise<{
  status: "ok" | "error";
  summary?: string;
}>;

// ─── TaskStore ───

interface TaskStore {
  load(): Promise<ScheduledTask[]>;
  save(tasks: ScheduledTask[]): Promise<void>;
  addTask(task: ScheduledTask): Promise<void>;
  updateTask(id: string, patch: Partial<ScheduledTask>): Promise<void>;
  removeTask(id: string): Promise<void>;
  getTask(id: string): ScheduledTask | undefined;
}

// ─── TimerLoop ───

interface TimerLoop {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  tick(): Promise<void>;
}

// ─── Delivery Pipeline ───
// 实现偏差：DeliveryItem 用 DeliveryTarget（channelId + to）替代 TaskDelivery；增加 attempts/maxAttempts/
// expiresAt/source 字段；接口简化为 IDeliveryPipeline（enqueue 接受 EnqueueParams）。
// 详见 implementation-roadmap.md Step 12。

interface DeliveryItem {
  id: string;
  taskId: string;
  delivery: TaskDelivery;
  content: string;
  priority: TaskPriority;
  createdAt: string;
  retryCount: number;
  maxRetries: number;          // 默认 3
  lastError?: string;
}

interface DeliveryPipeline {
  enqueue(item: Omit<DeliveryItem, 'id' | 'retryCount'>): Promise<void>;
  flush(): Promise<void>;
  stats(): { pending: number; failed: number };
}

// ─── Channel Adapter ───

interface ChannelAdapter {
  readonly id: string;
  readonly name: string;
  connect(config: ChannelConfig): Promise<void>;
  disconnect(): Promise<void>;
  isReady(): boolean;
  send(message: OutboundMessage): Promise<SendResult>;
  onMessage(handler: (msg: InboundMessage) => void): Disposable;
  status(): ChannelStatus;
}

// ─── Server ───

interface ServerConfig {
  port: number;                // 默认 18900
  host: string;                // 默认 '127.0.0.1'
  shutdownTimeoutMs: number;   // 默认 30000
  scheduler: SchedulerConfig;
  activeHours: ActiveHoursConfig;
  channels: Record<string, ChannelConfig>;
}

interface ServerStatus {
  running: boolean;
  pid: number;
  port: number;
  uptime: string;
  scheduler: {
    taskCount: number;
    nextRunAt?: string;
    activeTaskCount: number;
  };
  delivery: {
    pending: number;
    failed: number;
  };
  channels: Record<string, ChannelStatus>;
  memory: {
    rss: number;
    heapUsed: number;
  };
}

// ─── Schedule 工具（AI 调用） ───

interface ScheduleToolInput {
  action: "create" | "list" | "update" | "delete" | "run";
  task?: {
    name: string;
    schedule: TaskSchedule;
    prompt: string;
    priority?: TaskPriority;
    delivery?: TaskDelivery;
    sessionId?: string;
  };
  id?: string;
  patch?: Partial<ScheduledTask>;
}
```

## 十三、决策记录

### ADR-014: 为什么不复用 OS crontab

**背景**：可以用操作系统的 crontab 来调度任务。

**决策**：在应用内实现 Scheduler，不依赖 OS crontab。

**理由**：
- 应用内 Scheduler 可以感知任务状态（running、error count 等）
- 自然语言创建需要动态操作任务，crontab 不适合频繁增删
- 任务执行需要完整的 Agent 环境（provider、session、context），OS cron 只能执行命令
- 跨平台一致性：crontab 语法和行为在各平台有差异
- 错误退避、missed task 追赶等高级特性需要应用层实现

### ADR-015: 为什么 Scheduler 先在 CLI 内运行

**背景**：Scheduler 是 Server 模式的组件，可以等 Server 实现后再做。

**决策**：Phase S1 先在 CLI 进程内运行 Scheduler，Phase S2 再迁移到 Server。

**理由**：
- 可以尽早验证调度逻辑的正确性
- CLI 内运行时，Scheduler 的生命周期 = 进程生命周期，简化了关注点
- 所有核心逻辑（Timer Loop、Error Policy、Task Store）与运行环境无关
- 迁移到 Server 只需在不同的入口调用 `scheduler.start()`

### ADR-016: 为什么用三级渐进而非一步到位的 OS 服务

**背景**：OpenClaw 要求用户先 `daemon install` 才能使用 cron。

**决策**：三级渐进（前台 → daemon → OS 服务），每级独立有用。

**理由**：
- Level 0（前台）：开发调试，看到所有输出，Ctrl+C 即停
- Level 1（daemon）：个人日常，一条命令启动后台，无需理解 OS 服务概念
- Level 2（OS 服务）：需要开机自启和崩溃恢复的高级用户
- 降低入门门槛：大部分用户停在 Level 1 就够用
- 每级的实现独立：Level 1 不依赖 Level 2 的代码

### ADR-017: 为什么 TaskAction 只有两种

> ⚠️ **修订（2026-04-17）**：本 ADR 中的 `sessionId` 字段在 [conversation-model.md ADR-CM-006](./conversation-model.md#adr-cm-006) 中被重新定义为 `conversationId`,默认 `undefined`(临时一次性 runtime,不写入任何 Transcript)。"持续性会话"语义改为"显式归入指定 Conversation"——避免高频任务污染对话历史。


**背景**：OpenClaw 的 Cron 有 sessionTarget（main/isolated/current/session:xxx）、wakeMode（now/next-heartbeat）、payload（systemEvent/agentTurn）多个维度的组合。

**决策**：知行的 `TaskAction` 只有 `agent-turn` 和 `system` 两种，加可选 `sessionId` 支持持续性任务。

**理由**：
- `agent-turn` 覆盖 OpenClaw 的 isolated + agentTurn：启动独立会话执行 prompt
- `agent-turn` + `sessionId` 覆盖 OpenClaw 的 current 和 session:xxx：指定会话执行
- `system` 覆盖 OpenClaw 的 main + systemEvent：调用内置 handler
- OpenClaw 的 main session 模式（注入事件到主会话）在知行中不需要——知行没有"持续运行的主会话"概念
- OpenClaw 的 wakeMode 和 heartbeat 机制是为了适配"主会话+通道"模型，知行的 Server 模式下任务直接由 Scheduler 驱动，不需要 heartbeat 唤醒
- 两种 action + 可选 sessionId 覆盖了所有场景，同时把概念数从 10+ 降到 4

### ADR-018: 为什么不需要 Heartbeat

**背景**：OpenClaw 有一个 ~1200 行的 Heartbeat Runner（32 个相关文件），用于周期性唤醒主会话处理异步事件。

**决策**：知行不实现 Heartbeat 机制。

**理由**：
- OpenClaw 的心跳是**架构产物**——因为 main session 是被动的，Cron 的 systemEvent 注入后无人处理，必须靠心跳唤醒
- 知行采用**直接执行**模型——Scheduler 到期后直接启动 Agent Turn 执行，不存在"等待唤醒"的中间态
- 心跳覆盖的真实需求，知行用更直接的方式解决：
  - 免打扰 → Active Hours（双层过滤，比心跳级过滤更精细）
  - 结果投递 → Delivery Pipeline（独立管线，带持久化队列）
  - 防重复 → Delivery Pipeline 去重（24h 内相同内容跳过）
  - 主动巡检 → 内置系统任务（`__health-check` 等）
- 消除心跳带来的 **无效 LLM 调用**——OpenClaw 每次心跳都调用 LLM，大部分时候得到 HEARTBEAT_OK（空操作），然后还要从 transcript 中删除这次无效对话

### ADR-019: 为什么 Delivery Pipeline 独立于 Scheduler

**背景**：可以在 Scheduler 的 TaskExecutor 中直接投递结果。

**决策**：Delivery Pipeline 是独立组件，有自己的持久化队列。

**理由**：
- **关注点分离**：Scheduler 负责"何时执行"，Delivery 负责"如何投递"
- **持久化保障**：任务执行成功但投递失败（通道断开、网络抖动），结果不丢失
- **免打扰过滤**：深夜执行的 system 任务（如 journal-gc）可以正常运行，但结果等到白天才投递
- **批量投递**：多个任务结果可以合并投递，减少消息打扰
- **独立重试**：投递重试不影响 Scheduler 的调度循环
- OpenClaw 的投递分散在 heartbeat-runner、server-cron、outbound 三处，逻辑重复且不一致

### ADR-020: 为什么 Channel Adapter 是独立包

**背景**：通道适配可以写在核心包内。

**决策**：每个通道适配器是独立的 npm 包（`@zhixing/channel-wechat` 等）。

**理由**：
- 不同通道的 SDK 体积差异大，不应污染核心包
- 用户只安装需要的通道，降低依赖复杂度
- 通道适配器可以独立发版和更新
- 第三方可以开发自定义通道适配器
- 统一的 `ChannelAdapter` 接口保证核心包不依赖任何具体通道实现

### ADR-021: 为什么需要 AgentOrchestrator 层（v2.0 新增）

**背景**：2026 年初行业范式从"定时任务 + 通道"演进到"Agent Harness + 智能协调"。Claude Code 实现了会话内背景 Agent、Monitor、Tasks DAG 等能力。OpenClaw 和 Hermes 均未跟进。

**决策**：新增 AgentOrchestrator 层，位于 Agent 内核之上、接入层之下。

**理由**：
- **不做的风险**：知行一发布就落后于 Claude Code 的协调能力，虽然常驻基础设施更好但用户体验维度缺失
- **做的收益**：成为唯一同时覆盖"常驻运行"和"智能协调"的开源个人助手
- **对已有代码零侵入**：Agent Loop 是纯函数、EventBus 是工厂实例、Confirmation Broker 已有非交互兜底——全部新能力都是在现有模块上面**叠加**新层
- Orchestrator 的职责边界清晰：它管"谁在运行、谁等谁"，不管"当前这轮怎么跑"——后者是 Agent Loop 的职责

### ADR-022: 为什么背景 Agent 走 NonInteractiveResolver（v2.0 新增）

**背景**：背景 Agent 执行工具时如果触发安全确认，用户可能正在主对话中，无法同时响应两个确认弹窗。

**决策**：背景 Agent 的 ConfirmationBroker 不 attach 渲染器，默认走 `NonInteractiveResolver`（auto-deny）。

**理由**：
- 安全优先：背景任务不应在用户不知情时执行高风险操作
- 已有代码完全支持：`NonInteractiveResolver` 在 Phase 1 就已实现
- 可渐进增强：未来可实现 `DelegatingRenderer` 将确认请求转发到主会话 Broker
- 背景 Agent 的工具集本身可以收窄（`spawnBackground` 的 `tools` 参数），从源头减少确认需求

### ADR-023: 为什么 TaskGraph 是 Scheduler 的扩展而非独立系统（v2.0 新增）

**背景**：Claude Code 的 Tasks 系统是独立于调度的文件系统存储。可以为知行也做独立的 TaskGraph 系统。

**决策**：在 `TaskSchedule` 中新增 `after` 和 `self-paced` 两种调度模式，TaskGraph 是 Scheduler 的扩展。

**理由**：
- 任务依赖本质上是一种调度规则——"什么时候执行"的变体：不是"某个时间"而是"某些前置完成后"
- 复用 Scheduler 的 TaskStore / ErrorPolicy / 优先级 / EventBus 集成
- 避免两套任务管理系统（Scheduler + TaskGraph）增加用户和维护者的认知负担
- `self-paced` 的 `nextDelayMs` 通过 `AgentTurnResult` 回传，Scheduler 据此设置下次 `nextRunAt`——逻辑简洁

### ADR-024: 为什么 Monitor 和 Scheduler 分离（v2.0 新增）

**背景**：Monitor 的反应式事件（"有 X 发生就做 Y"）可以建模为特殊的 Scheduler 任务。

**决策**：Monitor 是独立系统，与 Scheduler 平级。

**理由**：
- **触发机制根本不同**：Scheduler 是时间驱动（`setTimeout`），Monitor 是事件驱动（`EventBus.on` / `fs.watch` / 进程 stdout）
- 生命周期不同：Monitor 可以有 `maxTriggers`（触发 N 次后自动停止）和 `expiresAt`（超时过期），这些语义在 Scheduler 中不自然
- Monitor 的 source（进程输出、文件变化、EventBus 事件）需要专门的适配器，塞进 Scheduler 会破坏其简洁性
- 两者的 EventBus 事件 namespace 自然分离：`scheduler:*` vs `orchestrator:monitor-*`
