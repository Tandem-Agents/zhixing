# 知行常驻服务架构设计方案

> 设计日期：2026-04-09
> 依赖调研：[openclaw/persistent-service.md](../../source-analysis/openclaw/persistent-service.md)
> 产品定位：个人助手（需要 7×24 可达 + 主动关怀 + 跨通道投递）

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

### 2.2 Claude Code：无常驻能力

Claude Code 是纯 CLI 工具，无任何后台服务。每次会话独立，关闭即结束。

**启示**：CLI 形态已经过验证可以提供良好的交互体验，但对于个人助手场景来说能力不足。

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

### 2.5 两者都没做的

| 空白 | 知行的机会 |
|------|-----------|
| 零步骤激活 | `zhixing serve` 即可运行，无需 `daemon install` |
| 投递持久化队列 | 投递失败不丢弃，崩溃恢复后重新投递 |
| 任务优先级 | 紧急任务穿透免打扰 + 插队执行 |
| 实时可观测 | EventBus 驱动的任务执行/投递实时状态 |
| 统一任务模型 | 定时任务、触发式任务、消息驱动任务统一抽象 |
| 跨运行记忆 | 持续跟踪型任务可保留上下文（可选 sessionId） |

## 三、知行常驻服务架构

### 3.1 核心设计原则

1. **统一内核**：所有接入方式（Server API、社交通道、CLI 终端）共享同一个 Agent 内核。
2. **接入平等**：Server 模式（社交平台对接）和 CLI 模式（终端交互）是两种同等重要的使用方式，不分主次——产品定位是类同 OpenClaw 的独立部署智能体。
3. **触发源解耦**：任务执行逻辑不感知触发来源（CLI/Cron/API/Channel）。
4. **渐进复杂度**：从简单开始（`zhixing serve`），需要时再加 OS 级保活。
5. **EventBus 一切**：所有状态变更通过 EventBus 流转，天然支持可观测性。

### 3.2 两种运行模式

知行的产品定位是**独立部署的个人助手**，类同 OpenClaw。用户的典型使用方式是将知行部署后，通过社交平台（微信、钉钉等）与它交互。CLI 终端是另一种同等重要的接入方式，适用于开发调试和直接交互场景。

两种模式共享同一个 Agent 内核，只是接入层不同：

```
┌──────────────────────────────────────────────────────────────────┐
│                       知行 Agent 内核                             │
│                                                                   │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Agent    │  │ Tool       │  │ Memory   │  │ Event Bus     │  │
│  │ Loop     │  │ Pipeline   │  │ System   │  │ (typed)       │  │
│  └──────────┘  └────────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Context  │  │ Session    │  │ Provider │  │ Resilience    │  │
│  │ Engine   │  │ Manager    │  │ Layer    │  │ Engine        │  │
│  └──────────┘  └────────────┘  └──────────┘  └───────────────┘  │
│                                                                   │
│  ═══════════════════════════════════════════════════════════════  │
│  以上是共享内核，以下是接入层（两种模式同等重要）                   │
│  ═══════════════════════════════════════════════════════════════  │
│                                                                   │
│  ┌─ Server 模式 ────────────────────────┐  ┌─ CLI 模式 ────────┐ │
│  │                                      │  │                    │ │
│  │ ┌── 入站 ─────────────────────────┐  │  │ REPL 终端渲染      │ │
│  │ │ Gateway API (WebSocket + HTTP)  │  │  │ 交互式对话          │ │
│  │ │ Channel Adapters (微信/钉钉/…)  │  │  │                    │ │
│  │ └────────────┬────────────────────┘  │  │ 可连接 Server      │ │
│  │              ▼                       │  │ 也可独立运行        │ │
│  │ ┌── 调度 ─────────────────────────┐  │  │                    │ │
│  │ │ Scheduler                       │  │  │ 触发:              │ │
│  │ │  并发控制 · Active Hours · 优先级│  │  │ - 用户输入          │ │
│  │ └────────────┬────────────────────┘  │  │ - 斜杠命令          │ │
│  │              ▼                       │  │                    │ │
│  │ ┌── 出站 ─────────────────────────┐  │  │                    │ │
│  │ │ Delivery Pipeline               │  │  │                    │ │
│  │ │  排队 · 去重 · 重试 · 免打扰     │  │  │                    │ │
│  │ └────────────────────────────────┘  │  │                    │ │
│  │                                      │  │                    │ │
│  │ 触发: Cron · 外部消息 · API 调用     │  │                    │ │
│  └──────────────────────────────────────┘  └────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
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
| 定时任务 | ❌ | ✅ 通过 Server | ✅ Scheduler |
| 外部通道 | ❌ | ❌ | ✅ Channel Adapters |
| 记忆凝练 | ✅ 惰性（启动时检查） | ✅ 通过 Server | ✅ 定时（Cron 驱动） |
| 主动通知 | ❌ | ❌ | ✅ 通过 Channel 推送 |
| 免打扰 | N/A | N/A | ✅ Active Hours |
| 投递保障 | N/A | N/A | ✅ Delivery Pipeline |
| API 接口 | ❌ | ❌ | ✅ WebSocket + HTTP |
| 可观测性 | ✅ 终端渲染 | ✅ 终端渲染 | ✅ API + EventBus |

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
  | { kind: "once"; at: string }              // "2026-04-10T08:00:00+08:00"
  | { kind: "interval"; everyMs: number }     // 每 N 毫秒
  | { kind: "cron"; expr: string; tz?: string }; // "0 8 * * *"

// ─── 执行动作 ───
type TaskAction =
  | {
      kind: "agent-turn";
      prompt: string;
      model?: string;
      tools?: string[];
      // 持续性任务可指定 sessionId，跨运行保留上下文
      // 不指定则每次运行创建独立临时会话
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
| `"isolated"` — 独立临时会话 | `agent-turn` 默认行为 |
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
│  │    ├── agent-turn → 创建独立 Agent 会话 → 执行 prompt       │
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

### 5.1 定位

Server 模式下对外暴露的接口，供 CLI 远程连接、Web UI、移动端、第三方系统调用。

### 5.2 接口设计

```
WebSocket ws://localhost:PORT/ws
  ├── 双向消息流（对话）
  ├── 事件订阅（EventBus 流）
  └── 会话管理

HTTP REST http://localhost:PORT/api
  ├── POST /api/chat         ← 发送消息（一次性）
  ├── GET  /api/status        ← 服务状态
  ├── GET  /api/scheduler     ← 定时任务列表
  ├── POST /api/scheduler     ← 创建定时任务
  ├── DELETE /api/scheduler/:id ← 删除定时任务
  ├── POST /api/memory/gc     ← 手动触发记忆凝练
  └── GET  /api/health        ← 健康检查
```

### 5.3 CLI 远程模式

当 Server 运行时，CLI 可以选择连接到 Server 而非独立运行：

```bash
zhixing              # 检测到 Server 运行中 → 连接 Server 的 WebSocket
zhixing --local      # 强制本地运行（独立于 Server）
```

**判断逻辑**：
1. 检查 `~/.zhixing/server.pid`（PID 文件）
2. 如果存在 → 尝试连接 WebSocket
3. 连接成功 → 代理模式（CLI 变为 Server 的终端前端）
4. 连接失败 → 本地模式

## 六、Channel Adapter（通道适配器）

### 6.1 定位

Channel Adapter 是知行连接社交平台的桥梁。这是产品定位"独立部署 + 社交平台接入"的核心基础设施。

### 6.2 统一接口

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

## 十、与 OpenClaw / Claude Code 的对比

| 维度 | OpenClaw | Claude Code | **知行** |
|------|----------|-------------|---------|
| **架构模型** | Gateway 单体（Cron+Heartbeat+Queue 耦合） | 无常驻架构 | **入站/调度/出站三层分离** |
| **心跳依赖** | ✅ 需要（主会话唤醒的唯一通道） | N/A | **不需要**（直接执行，覆盖所有真实需求） |
| 激活门槛 | `daemon install`（需理解 OS 服务） | N/A | **`zhixing serve`**（零配置） |
| 定时任务创建 | cron 工具（AI 调用，10+ 参数概念） | N/A | **schedule 工具**（AI 调用，3+1 概念） |
| 概念数 | 10+（sessionTarget/wakeMode/delivery/…） | N/A | **4 个**（Task + Schedule + Action + Priority） |
| 调度器复杂度 | ~130 个文件 | N/A | **<20 个文件** |
| **并发控制** | Command Queue + 4 条 Lane | N/A | **maxConcurrent + 优先级排序** |
| **免打扰** | heartbeat.activeHours（仅心跳级） | N/A | **双层过滤**（Scheduler + Delivery），urgent 可穿透 |
| **投递管线** | 分散在 heartbeat/cron/outbound 多处，无持久化 | N/A | **独立 Delivery Pipeline**，持久化队列，崩溃不丢失 |
| **去重** | 24h 内相同心跳内容去重 | N/A | **Delivery Pipeline 级去重**（同样 24h） |
| **任务会话** | 4 种 sessionTarget（复杂组合） | N/A | **默认独立 + 可选 sessionId**（简洁且灵活） |
| **通道适配** | Channel Plugin（紧耦合 Gateway） | N/A | **ChannelAdapter 独立接口**，插件式加载 |
| OS 级保活 | ✅ 三平台 | N/A | ✅ 三平台（Level 2） |
| 轻量后台 | ❌（必须 OS 服务） | N/A | ✅ `--daemon`（Level 1） |
| CLI 兼容 | CLI 是独立客户端 | CLI 是唯一入口 | **CLI 可独立或连接 Server** |
| 可观测性 | 日志文件 | N/A | **EventBus 实时事件流**（Scheduler + Delivery + Channel） |
| Missed task 追赶 | ✅ 复杂（多种策略） | N/A | ✅ 简化（按优先级排序，<=3 立即，>3 错开） |
| 错误退避 | ✅ 指数退避 | N/A | ✅ 指数退避 + 用户通知 |

## 十一、渐进实现路线

每步独立可验证，不依赖后续步骤。

```
S1 Scheduler 核心 ─→ S2 Server 模式 ─→ S3 Delivery Pipeline ─→ S4 Daemon ─→ S5 Channel ─→ S6 OS 服务
     (调度逻辑)        (前台运行)        (投递 + 免打扰)       (后台运行)    (社交接入)     (开机自启)
```

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

**不做什么**：
- 不做 Server 模式（Scheduler 先在 CLI 进程内运行）
- 不做 Delivery Pipeline（结果先打印到终端）
- 不做 Active Hours（CLI 进程内无意义）
- 不做 Daemon
- 不做 sessionId 持续性会话（Phase S3 再加）

**验证**：
- CLI 中自然语言创建："每 30 秒打印一句问候" → AI 调用 schedule.create → 到期自动执行 → 结果打印到终端
- 并发控制：创建 5 个同时到期的任务 → 观察最多 3 个并行执行
- 错误退避：故意让任务失败 → 观察退避间隔递增 → 连续 5 次失败后自动 disable
- Missed task 追赶：创建任务 → 关闭 CLI → 重启 → 补执行
- 优先级：创建 urgent + low 任务同时到期 → urgent 先执行

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
```

### Phase S2: Server 前台模式

**范围**：知行可以作为长期运行的服务，对外提供 API。

**做什么**：
- `zhixing serve` 命令（前台运行）
- HTTP API（/api/status, /api/health, /api/scheduler, /api/chat）
- WebSocket 端点（双向对话流 + EventBus 事件订阅）
- Scheduler 集成到 Server 进程
- 进程锁（端口监听锁）
- SIGTERM/SIGINT 优雅停机（等待活跃任务 → 保存状态 → 退出）
- SIGUSR1 优雅重启
- 内置系统任务（`__journal-gc`、`__health-check`）

**验证**：
- `zhixing serve` 启动 → `curl /api/status` 返回服务状态
- 通过 WebSocket 发送消息 → 收到 AI 回复
- 创建定时任务 → 到期执行 → 结果可通过 API 查询
- Ctrl+C → 优雅停机（观察日志：等待任务 → 保存 → 退出）
- 记忆凝练由 `__journal-gc` 自动触发（凌晨 3 点或手动 `/journal gc`）

**交付**：
```
packages/cli/src/commands/
  └── serve.ts               # zhixing serve 命令
packages/core/src/server/
  ├── gateway.ts             # HTTP + WebSocket 服务器
  ├── routes.ts              # HTTP API 路由
  ├── websocket.ts           # WebSocket 处理
  └── process-lock.ts        # 端口锁
```

### Phase S3: Delivery Pipeline + Active Hours

**范围**：任务结果可靠投递，免打扰时段保护。

**做什么**：
- `DeliveryPipeline`（持久化队列 `~/.zhixing/delivery-queue.json`）
- `DeliveryQueue`（enqueue/dequeue/peek，FIFO + priority 排序）
- Webhook 投递（HTTP POST + 超时 + SSRF 防护 + 指数退避重试）
- Active Hours 配置（全局 + Scheduler/Delivery 双层过滤）
- 去重逻辑（24h 内相同 taskId + 相同 content → 跳过）
- `__delivery-retry` 内置系统任务
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

### Phase S4: Daemon 后台模式

**范围**：知行可以在后台持续运行，CLI 可以连接到运行中的 Server。

**做什么**：
- `zhixing serve --daemon`（fork 子进程 + detach + PID 文件）
- `zhixing serve stop`（发送 SIGTERM → 优雅停机）
- `zhixing serve status`（检查 PID + 端口探活）
- CLI 自动检测 Server → WebSocket 代理模式
- `zhixing --local` 强制本地独立运行

**验证**：
- `zhixing serve --daemon` → 后台运行 → `zhixing serve status` 显示运行中
- `zhixing` → 自动检测到 Server → 连接 WebSocket → 对话通过 Server 的 Agent 内核处理
- `zhixing --local` → 独立运行（不连接 Server）
- `zhixing serve stop` → PID 文件中读取 PID → SIGTERM → 优雅停机
- 创建定时任务 → 关闭所有终端 → 任务仍然到期执行

**交付**：
```
packages/cli/src/commands/
  └── serve.ts               # 扩展 daemon/stop/status 子命令
packages/cli/src/daemon/
  ├── process.ts             # fork + detach 逻辑
  └── pid.ts                 # PID 文件管理
```

### Phase S5: Channel Adapter 框架 + 首个通道

**范围**：知行可以接收和发送社交平台消息。

**做什么**：
- `ChannelAdapter` 统一接口
- `ChannelRouter`（入站消息 → Session 解析 → Agent 处理）
- `ChannelRegistry`（适配器注册表，插件式加载）
- Delivery Pipeline 对接 ChannelAdapter.send()
- Channel EventBus 事件
- 首个通道实现：Webhook Adapter（通用 HTTP 入站/出站，可对接任意平台的 webhook）

**验证**：
- 配置 Webhook Channel → 外部 HTTP POST 到 `/api/channel/webhook` → Agent 处理 → 回复 POST 到配置的 callback URL
- 创建定时任务 + channel delivery → 到期 → 执行 → 通过 Webhook Channel 投递
- Channel 断开 → Delivery Pipeline 排队 → Channel 恢复 → 自动重试投递

**交付**：
```
packages/core/src/channels/
  ├── types.ts               # ChannelAdapter, InboundMessage, OutboundMessage
  ├── adapter.ts             # ChannelAdapter 接口
  ├── router.ts              # 入站消息路由
  └── registry.ts            # 适配器注册表
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
  | { kind: "cron"; expr: string; tz?: string };

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
