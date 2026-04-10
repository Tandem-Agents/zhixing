# OpenClaw — 常驻服务架构分析

> **分析状态**: ✅ 完整分析（2026-04-09）
> **核心问题**: OpenClaw 如何实现常驻后台运行、定时任务、守护进程管理？

## 一、核心结论

OpenClaw 拥有业界最成熟的个人智能体常驻服务架构，由**三个互相协作的子系统**构成：

```
┌──────────────────────────────────────────────────────────────────┐
│                    Gateway（常驻进程）                            │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│  │ Cron Service  │   │ Heartbeat    │   │ Command Queue        │ │
│  │ 定时任务调度   │   │ 周期唤醒     │   │ 任务队列 + Lane 隔离 │ │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬───────────┘ │
│         │                  │                       │             │
│         ▼                  ▼                       ▼             │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Agent Runtime（Pi Agent + 工具 + LLM）                       ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ Channels（WhatsApp / Telegram / Slack / Discord / ...）      ││
│  └──────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ WebSocket Server / HTTP API / MCP HTTP                       ││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────┬───────────────────────────────────────────┘
                       │ OS 级服务管理
┌──────────────────────▼───────────────────────────────────────────┐
│                    Daemon Service                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                    │
│  │ launchd   │   │ systemd   │   │ schtasks  │                   │
│  │ (macOS)   │   │ (Linux)   │   │ (Windows) │                   │
│  └──────────┘   └──────────┘   └──────────┘                    │
│  开机自启、崩溃重启、日志管理、服务状态                           │
└──────────────────────────────────────────────────────────────────┘
```

## 二、子系统 1：Daemon（OS 级服务管理）

### 2.1 设计理念

Gateway 进程需要 7×24 小时运行。OpenClaw 不自己实现进程保活，而是**委托操作系统原生的服务管理器**。

### 2.2 平台适配

通过统一的 `GatewayService` 接口，适配三个平台：

```typescript
// src/daemon/service.ts
type GatewayService = {
  label: string;
  stage: (args) => Promise<void>;   // 预写配置文件（不启动）
  install: (args) => Promise<void>; // 写入 + 启动
  uninstall: (args) => Promise<void>;
  stop: (args) => Promise<void>;
  restart: (args) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args) => Promise<boolean>;
  readCommand: (env) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env) => Promise<GatewayServiceRuntime>;
};
```

| 平台 | 实现 | 注册文件 | 核心能力 |
|------|------|---------|---------|
| macOS | launchd | `~/Library/LaunchAgents/com.openclaw.gateway.plist` | KeepAlive、开机自启、崩溃重启 |
| Linux | systemd | `~/.config/systemd/user/openclaw-gateway.service` | 用户级服务、Linger、日志 |
| Windows | schtasks | Windows 计划任务 | 开机运行、后台执行 |

### 2.3 核心文件

```
src/daemon/
├── service.ts              # 统一接口 + 平台路由
├── service-types.ts        # 类型定义
├── launchd.ts              # macOS launchd plist 管理
├── launchd-plist.ts        # plist XML 生成
├── systemd.ts              # Linux systemd unit 管理
├── systemd-unit.ts         # unit 文件生成
├── systemd-linger.ts       # loginctl enable-linger（无登录运行）
├── schtasks.ts             # Windows 计划任务管理
├── schtasks-exec.ts        # schtasks 命令封装
├── runtime-paths.ts        # 跨平台运行时路径解析
├── runtime-binary.ts       # Node.js 二进制路径发现
├── diagnostics.ts          # 服务状态诊断
├── inspect.ts              # 运行时检测
└── constants.ts            # 服务名等常量
```

### 2.4 CLI 命令

```bash
openclaw daemon install    # 安装系统服务（写入 plist/unit/schtask）
openclaw daemon start      # 启动
openclaw daemon stop       # 停止
openclaw daemon restart    # 重启
openclaw daemon status     # 查看状态（installed/loaded/running）
openclaw daemon uninstall  # 卸载系统服务
```

### 2.5 设计评价

| 维度 | 评价 |
|------|------|
| **跨平台** | ✅ 优秀。三大平台原生方案，不走 PM2 等中间层 |
| **可靠性** | ✅ 优秀。OS 保活 > 应用层保活 |
| **复杂度** | ⚠️ 高。每个平台独立实现，~60 个文件，包含大量边界情况处理 |
| **用户体验** | ⚠️ 一般。需要手动执行 `daemon install`，非开箱即用 |

## 三、子系统 2：Gateway Run Loop（进程生命周期）

### 3.1 设计理念

Gateway 需要长时间运行且支持**优雅重启**（配置变更、版本升级时不丢失正在执行的对话）。

### 3.2 核心循环

```typescript
// src/cli/gateway-cli/run-loop.ts
async function runGatewayLoop(params) {
  let lock = await acquireGatewayLock({ port });
  
  for (;;) {  // 无限循环，SIGUSR1 触发进程内重启
    server = await params.start({ startupStartedAt });
    
    // 阻塞等待重启信号
    await new Promise<void>((resolve) => {
      restartResolver = resolve;
    });
  }
}
```

### 3.3 信号处理

| 信号 | 行为 |
|------|------|
| SIGTERM | 优雅停机：排空活跃任务 → 关闭 WebSocket → 释放锁 → 退出 |
| SIGINT | 同 SIGTERM |
| SIGUSR1 | 优雅重启：排空 → 关闭 → 重新获取锁 → 重新启动 |

### 3.4 排空（Drain）机制

重启时不直接杀进程，而是等待活跃工作完成：

```
SIGUSR1 收到
    │
    ▼
markGatewayDraining()          ← 拒绝新任务入队
    │
    ▼
abortEmbeddedPiRun(compacting) ← 中止正在 compact 的运行
    │
    ▼
waitForActiveTasks(90s)        ← 等待活跃任务完成
waitForActiveEmbeddedRuns(90s)
    │
    ▼ 超时
abortEmbeddedPiRun(all)        ← 强制中止所有运行
    │
    ▼
server.close()                 ← 关闭服务器
    │
    ▼
选择重启方式
├── 方式1: 完整进程重启（fork 子进程，父进程退出）
└── 方式2: 进程内重启（释放锁 → 重新获取 → 重新 start()）
```

### 3.5 进程锁

通过端口锁（`acquireGatewayLock`）确保同时只有一个 Gateway 实例运行。锁释放后新进程才能启动，避免端口冲突。

### 3.6 设计评价

| 维度 | 评价 |
|------|------|
| **优雅性** | ✅ 优秀。双层排空 + 超时兜底 |
| **可靠性** | ✅ 优秀。进程锁防多开 + 信号处理完善 |
| **复杂度** | ⚠️ 中等。~270 行，但涉及信号/锁/异步编排 |
| **重启策略** | ✅ 优秀。优先 fork 子进程，失败降级为进程内重启 |

## 四、子系统 3：Cron Service（应用内定时调度）

### 4.1 设计理念

Cron 是 OpenClaw 最复杂的子系统之一（~130 个 `.ts` 文件）。它在 Gateway 进程内实现了完整的定时任务调度器，核心基于 `setTimeout` 而非 OS cron。

### 4.2 整体架构

```
┌─ Cron Service ─────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────┐                                               │
│  │ CronService  │ ← 外部 API（start/stop/add/remove/list/run） │
│  └──────┬──────┘                                               │
│         │                                                       │
│  ┌──────▼──────┐                                               │
│  │    State     │ ← 依赖注入（deps: CronServiceDeps）           │
│  │  + Store     │ ← JSON 持久化（cron.json）                    │
│  │  + Timer     │ ← setTimeout 驱动                             │
│  └──────┬──────┘                                               │
│         │                                                       │
│  ┌──────▼──────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │ Timer Loop   │   │ Job Executor │   │ Delivery Pipeline    ││
│  │ armTimer()   │──▶│ executeJob() │──▶│ announce/webhook     ││
│  │ onTimer()    │   │ (with timeout)│  │ to channels          ││
│  └──────────────┘   └──────────────┘   └──────────────────────┘│
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐│
│  │ Session Reap  │   │ Task Ledger  │   │ Failure Alert        ││
│  │ (清理旧会话)  │   │ (执行台账)   │   │ (失败通知用户)       ││
│  └──────────────┘   └──────────────┘   └──────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### 4.3 调度类型

```typescript
// src/cron/types.ts
type CronSchedule =
  | { kind: "at"; at: string }          // 一次性：指定时间执行一次
  | { kind: "every"; everyMs: number }  // 间隔性：每 N 毫秒执行
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }; // 表达式
```

**cron 表达式**基于 NPM `croner` 库，支持标准 cron 语法 + 时区。

### 4.4 定时器循环

核心是 `armTimer()` + `onTimer()` 的递归循环：

```
启动
  │
  ▼
armTimer()
  │ 计算最近一个 job 的 nextRunAtMs
  │ delay = nextRunAtMs - now
  │ 限制 delay ≤ 60s（防止长时间不唤醒导致漂移）
  │ 限制 delay ≥ 2s（防止 tight loop）
  │
  ▼
setTimeout(onTimer, clampedDelay)
  │
  ▼
onTimer()
  │ 加锁
  │ forceReload store（防止外部修改）
  │ collectRunnableJobs(now)
  │   └ 检查 enabled + nextRunAtMs ≤ now + 无 runningAtMs
  │
  ├── 无到期 job → recomputeNextRuns → armTimer()
  │
  └── 有到期 job →
      │ 标记 runningAtMs
      │ persist
      │
      ▼ 并发执行（maxConcurrentRuns，默认 1）
      runDueJob()
        │ 创建 Task Run 台账记录
        │ executeJobCoreWithTimeout()
        │   ├── main session → enqueueSystemEvent + heartbeat
        │   └── isolated → runIsolatedAgentTurn（独立会话）
        │
        ▼
      applyJobResult()
        │ 更新 state（lastRunAtMs, consecutiveErrors, ...）
        │ 计算 nextRunAtMs
        │ 触发 failure alert（如果连续失败）
        │ one-shot job 标记 disabled
        │ persist
        │
        ▼
      armTimer() ← 递归
```

### 4.5 Job 执行模式

| sessionTarget | 含义 | 执行方式 |
|---------------|------|---------|
| `"main"` | 主会话中执行 | 注入 systemEvent → 通过 heartbeat 唤醒主会话 |
| `"isolated"` | 独立会话 | 创建独立会话 → 完整 agent turn → 投递结果 |
| `"current"` | 当前会话 | 类似 isolated |
| `"session:xxx"` | 指定会话 | 指定 session key |

### 4.6 结果投递（Delivery）

执行完毕后，结果可以投递到各种通道：

```typescript
type CronDeliveryMode = "none" | "announce" | "webhook";
```

- **none**: 不投递，仅执行
- **announce**: 通过消息通道（WhatsApp/Telegram/...）发送
- **webhook**: HTTP POST 到指定 URL

### 4.7 错误处理与退避

```typescript
const DEFAULT_BACKOFF_SCHEDULE_MS = [
  30_000,      // 1st error →  30s
  60_000,      // 2nd error →   1min
  5 * 60_000,  // 3rd error →   5min
  15 * 60_000, // 4th error →  15min
  60 * 60_000, // 5th+ error → 60min
];
```

- 连续失败时指数退避
- one-shot job 瞬态错误最多重试 3 次
- 连续 N 次失败后通过通道通知用户
- schedule 计算连续 3 次异常时自动 disable job

### 4.8 启动追赶（Missed Jobs）

Gateway 重启后，检测哪些 job 在停机期间错过了执行：

```
重启
  │
  ▼
collectRunnableJobs(now, { allowCronMissedRunByLastRun: true })
  │ 找到 previousRunAtMs > lastRunAtMs 的 job
  │
  ▼
最多立即执行 5 个（DEFAULT_MAX_MISSED_JOBS_PER_RESTART）
  │
  ▼
剩余的按 5s 间隔错开（防止 Gateway 过载）
```

### 4.9 持久化

Job 定义和状态持久化到 JSON 文件（`cron.json`），每次执行后写回。带文件锁防止并发写入。

### 4.10 设计评价

| 维度 | 评价 |
|------|------|
| **功能完整度** | ✅ 优秀。cron/at/every 三种调度 + 投递 + 重试 + 告警 |
| **可靠性** | ✅ 优秀。退避、missed job 追赶、文件锁、stuck 检测 |
| **复杂度** | ❌ 过高。~130 个文件、大量边界 case、难以维护 |
| **可测试性** | ✅ 良好。CronServiceDeps 依赖注入，大量单元测试 |
| **扩展性** | ⚠️ 一般。调度器与 Gateway 进程耦合，不可独立部署 |

## 五、子系统 4：Heartbeat（周期唤醒）

### 5.1 设计理念

Heartbeat 是一个**周期性唤醒主会话**的机制。即使用户没有发消息，Gateway 也会定时检查是否有系统事件需要处理（如 cron 结果、定时提醒等）。

### 5.2 工作方式

```
┌─ Heartbeat Runner ──────────────────────────────────────────┐
│                                                              │
│  每 N 分钟（可配置）唤醒                                      │
│    │                                                         │
│    ▼                                                         │
│  检查是否有待处理的 system events                              │
│    │                                                         │
│    ├── 有 → 触发 agent turn（处理事件）→ 投递结果到通道       │
│    └── 无 → 跳过                                             │
│                                                              │
│  Cron job 也可以通过 requestHeartbeatNow() 立即唤醒           │
│                                                              │
│  Active Hours 过滤：深夜不打扰用户                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 与 Cron 的关系

Cron 的 `wakeMode` 决定如何触发 heartbeat：

- `"next-heartbeat"`：等下一个自然心跳周期
- `"now"`：通过 `requestHeartbeatNow()` 立即唤醒

### 5.4 核心文件

```
src/infra/
├── heartbeat-runner.ts         # 主逻辑（~1200行）
├── heartbeat-runner.runtime.ts # 运行时绑定
├── heartbeat-wake.ts           # heartbeat 请求/取消 API
├── heartbeat-events.ts         # 事件发射
├── heartbeat-events-filter.ts  # system event 分类过滤
├── heartbeat-active-hours.ts   # 活跃时段判断
├── heartbeat-reason.ts         # 唤醒原因分类
├── heartbeat-summary.ts        # 摘要配置
├── heartbeat-visibility.ts     # 可见性控制
```

## 六、子系统 5：Command Queue（任务队列与 Lane 隔离）

### 6.1 设计理念

Gateway 同时承载多种工作负载（用户对话、cron 任务、heartbeat 巡检），需要并发控制防止互相干扰。

### 6.2 Lane 机制

```
┌─ Command Queue ──────────────────────────────────────────┐
│                                                           │
│  Lane: "default"    ← 用户对话（串行）                     │
│  Lane: "cron"       ← Cron 任务（可并发，受 maxConcurrent）│
│  Lane: "heartbeat"  ← Heartbeat 唤醒                       │
│  Lane: "system"     ← 系统级操作                           │
│                                                           │
│  每条 lane 独立的 active count + 排队队列                  │
│  Gateway draining 时拒绝新 enqueue                         │
│  waitForActiveTasks(timeout) 用于优雅停机                  │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

### 6.3 核心文件

```
src/process/
├── command-queue.ts     # 队列核心（入队/出队/排空/等待）
├── lanes.ts             # Lane 定义
├── supervisor/          # 子进程监督器
│   ├── supervisor.ts
│   ├── registry.ts
│   └── adapters/
├── exec.ts              # 命令执行
├── kill-tree.ts         # 进程树清理
└── restart-recovery.ts  # 重启恢复
```

## 七、各子系统协作全景

```
用户消息 ──→ Gateway ──→ Command Queue (default lane) ──→ Agent Turn

Cron timer ──→ onTimer() ──→ Command Queue (cron lane) ──→
  ├── main session → enqueueSystemEvent + requestHeartbeatNow
  └── isolated → runIsolatedAgentTurn ──→ Delivery Pipeline

Heartbeat ──→ 检查 system events ──→ Agent Turn ──→ Reply to Channel

Daemon ──→ OS 保活 Gateway 进程 ──→ 崩溃自动重启
```

## 八、与知行的对比思考

### 8.1 OpenClaw 做对了的

1. **OS 级保活**：委托 launchd/systemd，比应用层保活可靠
2. **Cron 依赖注入**：`CronServiceDeps` 接口完全解耦，易于测试
3. **执行模式分离**：main session vs isolated session，不同场景不同策略
4. **Missed job 追赶**：重启后补执行，不丢任务
5. **错误退避**：指数退避 + 失败通知，防止无限重试
6. **Lane 隔离**：不同工作负载互不干扰

### 8.2 自然语言创建定时任务

OpenClaw 提供了 `cron` 工具暴露给 AI Agent，支持自然语言创建定时任务：

```typescript
// src/agents/tools/cron-tool.ts
description: `Manage Gateway cron jobs (status/list/add/update/remove/run/runs) 
and send wake events. Use this for reminders, "check back later" requests, 
delayed follow-ups, and recurring tasks.`
```

用户说"明天 8 点提醒我开会"→ AI 理解意图 → 调用 `cron.add()` 创建 job。工具还支持 `contextMessages` 参数，可以把最近对话的上下文附加到 reminder 中。

但 AI 需要理解并正确填写底层的结构化参数（sessionTarget、wakeMode、payload.kind 等），这对模型的工具调用准确度要求较高。

### 8.3 OpenClaw 做得不够好的

1. **复杂度失控**：Cron 子系统 ~130 个文件，大量 regression fix（issue 编号散布各处）
2. **Scheduler 与 Gateway 耦合**：Cron 跑在 Gateway 进程内，不能独立扩展
3. **无任务优先级**：所有 cron job 平等，无法表达"紧急"vs"日常"
4. **无可观测性**：Cron 执行状态依赖日志文件，无实时 dashboard
5. **工具参数复杂**：AI 创建 cron job 时需理解 sessionTarget、wakeMode、delivery 等多个概念的组合规则，增加了模型调用出错的概率
6. **用户体验**：必须先 `daemon install` 才能用 cron，非零步骤

### 8.4 Claude Code 为什么没有

Claude Code 定位为**编程助手 CLI 工具**，本质是"用户主动发起 → AI 响应"模型。它不需要：
- 后台运行（用户关闭终端就结束）
- 定时任务（编程场景无此需求）
- 多通道（只有终端一个入口）
- 主动通知（编程助手不会主动推送消息）

这与个人助手的需求完全不同——个人助手需要 7×24 可达、主动关怀、跨通道投递。
