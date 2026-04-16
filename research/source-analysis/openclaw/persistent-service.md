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

## 七、子系统 6：Channel Plugin 架构（通道适配层）

> 补充分析（2026-04-16）：前 6 个子系统覆盖了 Gateway 的"服务"层面，本节起覆盖"通道"层面——Gateway 如何与外部消息平台集成。

### 7.1 核心接口

**文件**: `src/channels/plugins/types.plugin.ts:82-124`

每个通道是一个 TypeScript 对象，实现 `ChannelPlugin` 接口。不是类继承——是**结构化契约**，约 35 个可选 adapter slot：

```typescript
type ChannelPlugin<ResolvedAccount, Probe, Audit> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  // === 必须 ===
  config: ChannelConfigAdapter<ResolvedAccount>;

  // === 运行时 ===
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;   // 连接管理 (startAccount/stopAccount)
  outbound?: ChannelOutboundAdapter;                    // 消息发送
  messaging?: ChannelMessagingAdapter;                  // 会话路由

  // === 安全 ===
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  approvals?: ChannelApprovalAdapter;                   // 审批交互
  approvalCapability?: ChannelApprovalCapability;
  allowlist?: ChannelAllowlistAdapter;

  // === 平台特化 ===
  threading?: ChannelThreadingAdapter;                  // 线程/回复
  streaming?: ChannelStreamingAdapter;                  // 流式消息
  actions?: ChannelMessageActionAdapter;                // 平台动作 (reaction/pin/read)
  mentions?: ChannelMentionAdapter;                     // @提及
  groups?: ChannelGroupAdapter;                         // 群组
  directory?: ChannelDirectoryAdapter;                  // 频道目录

  // === 生命周期 ===
  lifecycle?: ChannelLifecycleAdapter;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  setupWizard?: ChannelPluginSetupWizard;

  // === 其他 ===
  agentPrompt?: ChannelAgentPromptAdapter;              // 通道专属 system prompt
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];  // 通道专属工具
  heartbeat?: ChannelHeartbeatAdapter;
  commands?: ChannelCommandAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  // ...
};
```

### 7.2 通道列表

每个通道是独立的 extension 包（`extensions/<channelName>/`）：

| 通道 | 目录 | 协议 |
|------|------|------|
| Slack | `extensions/slack/` | Socket Mode / Events API |
| Discord | `extensions/discord/` | Gateway WebSocket |
| Telegram | `extensions/telegram/` | Bot API webhook/polling |
| WhatsApp | `extensions/whatsapp/` | Cloud API webhook |
| iMessage (BlueBubbles) | `extensions/bluebubbles/` | REST + webhook |
| iMessage (direct) | `extensions/imessage/` | AppleScript |
| Signal | `extensions/signal/` | signal-cli daemon |
| Matrix | `extensions/matrix/` | Matrix SDK |
| MS Teams | `extensions/msteams/` | Bot Framework |
| Feishu | `extensions/feishu/` | Lark SDK |
| IRC | `extensions/irc/` | IRC 协议 |
| LINE | `extensions/line/` | Messaging API |
| Google Chat | `extensions/googlechat/` | Chat API |
| Twitch | `extensions/twitch/` | IRC + Helix API |
| Nostr | `extensions/nostr/` | Nostr 协议 |
| Zalo | `extensions/zalo/` | Zalo API |

### 7.3 注册与发现

**入口文件**: 每个 extension 有 `channel-entry.ts`：

```typescript
// extensions/slack/channel-entry.ts
export default defineChannelPluginEntry({
  id: "slack",
  name: "Slack",
  plugin: slackPlugin,
  setRuntime: setSlackRuntime,
});
```

**发现流程**（`src/channels/plugins/bundled.ts`）：
1. `discoverOpenClawPlugins()` 扫描 bundled plugin 目录
2. `loadPluginManifestRegistry()` 读取 `package.json` 中的 `openclaw` 键
3. 对每个有 `channels` 的 manifest，通过 `jiti` 加载 `channel-entry.ts`
4. 结果缓存在 `cachedBundledChannelState`

**外部插件目录**（`src/channels/plugins/catalog.ts`）：
支持 `~/.openclaw/mpm/plugins.json` + 环境变量 `OPENCLAW_PLUGIN_CATALOG_PATHS` + 官方 `dist/channel-catalog.json`。优先级：config > workspace > global > bundled > external > fallback。

### 7.4 与 Hermes 的对比

| 维度 | OpenClaw `ChannelPlugin` | Hermes `BasePlatformAdapter` |
|------|--------------------------|------------------------------|
| 形态 | ~35 个可选 adapter slot | Python ABC 类继承（4 必须 + N 可选覆写） |
| 粒度 | 极细——每种能力独立 adapter | 粗——一个类包含所有 |
| 打包 | 独立 npm 包 | 单文件（gateway/platforms/） |
| 发现 | manifest + catalog + 环境变量 | 枚举硬编码 |
| 上手成本 | 高（需理解 35 种 slot） | 低（实现 4 方法即可） |

## 八、入站消息流（Inbound Message Flow）

从"Slack 发了一条消息"到"Agent 收到用户消息"的完整路径：

```
Slack 事件
    │
    ▼
① ChannelGatewayAdapter.startAccount(ctx)              [启动时建立连接]
    │ Slack: Socket Mode 长连接 / Events API webhook
    │
    ▼
② HTTP 路由匹配                                        [webhook 通道]
    │ src/gateway/server/plugins-http.ts
    │ resolvePluginRoutePathContext() → findMatchingPluginHttpRoutes()
    │ 部分路由 bypass auth（平台验证回调）
    │
    ▼
③ 消息规范化
    │ src/channels/plugins/normalize/shared.ts
    │ 各通道特化：Slack 去 <@U1234>、Discord 去 <@!1234>
    │ ChannelMentionAdapter.stripMentions() / stripRegexes()
    │
    ▼
④ 入站去抖                                             [防快速连发]
    │ src/channels/inbound-debounce-policy.ts
    │ shouldDebounceTextInbound() — 媒体/命令/空文本不去抖
    │ createChannelInboundDebouncer() — 去抖窗口内连接文本
    │
    ▼
⑤ 会话路由
    │ ChannelMessagingAdapter.resolveInboundConversation()
    │ ChannelMessagingAdapter.resolveSessionConversation()
    │ 映射平台 ID（Slack thread_ts / Telegram topic ID）→ session key
    │ recordInboundSession() — 记录 lastChannel, to, accountId, threadId
    │
    ▼
⑥ Agent 触发
    │ dispatchInboundMessage() → dispatchReplyFromConfig()
    │ 创建 ReplyDispatcher 处理流式 block delivery
    │ 触发 AI turn
```

## 九、出站消息流（Outbound Message Flow）

从"Agent 要回复"到"用户在 Slack 上看到消息"的完整路径：

```
Agent 回复 (ReplyPayload)
    │
    ▼
① 出站路由
    │ src/infra/outbound/message.ts
    │ resolveOutboundChannelPlugin() → resolveMessageChannelSelection()
    │ resolveOutboundTarget() → buildOutboundSessionContext()
    │
    ▼
② 投递管线                                             [src/infra/outbound/deliver.ts]
    │ deliverOutboundPayloads()
    │   1. normalizeReplyPayloadsForDelivery() — 规范化 + 通道清洗
    │   2. loadChannelOutboundAdapter() — 加载通道发送适配器
    │   3. 构建 ChannelHandler（chunker, text limits, media support）
    │   4. chunkByParagraph() / chunkMarkdownTextWithMode() — 分块
    │   5. 调用 adapter 发送方法
    │
    ▼
③ 发送方法优先级
    │ ChannelOutboundAdapter 提供多级发送方法：
    │ sendPayload()        ← 结构化/交互式 payload
    │ sendFormattedText()  ← 纯文本/markdown 分块
    │ sendFormattedMedia() ← 媒体 + 标题
    │ sendText() / sendMedia() ← 降级原语
    │
    ▼
④ 投递模式
    │ deliveryMode: "direct" | "gateway" | "hybrid"
    │ direct  → 直接 API 调用（Slack chat.postMessage）
    │ gateway → 路由到 Gateway WebSocket（需要 daemon）
    │ hybrid  → 先 direct，失败降级 gateway
    │
    ▼
⑤ 持久化重试队列                                      [delivery-queue-recovery.ts]
    │ 失败 → enqueueDelivery() → delivery-queue/ 目录
    │ MAX_RETRIES = 5，指数退避：5s, 25s, 2m, 10m
    │ PERMANENT_ERROR_PATTERNS → 不可重试错误
    │ 重启时 recoverPendingDeliveries() 补发
```

### 9.1 多通道扇出

一条回复**可以**发到多个通道：
- 显式 `channel` 参数指定目标通道
- Session 绑定路由（`lastChannel` / `lastRoute`）
- 跨上下文投递添加 "[from X]" 前缀（`buildCrossContextComponents()`）
- Mirror/Transcript 投递用于审计日志

## 十、WebSocket RPC 协议

### 10.1 协议版本

`PROTOCOL_VERSION = 3`（`src/gateway/protocol/schema/protocol-schemas.ts`）

### 10.2 帧格式

三种帧类型（判别联合，`src/gateway/protocol/schema/frames.ts`）：

```typescript
// 请求帧：client → server
{ type: "req", id: string, method: string, params?: unknown }

// 响应帧：server → client
{ type: "res", id: string, ok: boolean, payload?: unknown, error?: ErrorShape }

// 事件帧：server → client（推送）
{ type: "event", event: string, payload?: unknown, seq?: number }
```

### 10.3 连接握手

```
Client                                    Server
  │                                          │
  │──── WebSocket 连接 ───────────────────→ │
  │                                          │
  │ ←── event: connect.challenge ────────── │
  │     { nonce, ts }                        │
  │                                          │
  │──── req: connect ────────────────────→  │
  │     { minProtocol, maxProtocol,          │
  │       client: { id, version, platform }, │
  │       auth: { token/bootstrapToken } }   │
  │                                          │
  │ ←── res: HelloOk ───────────────────── │
  │     { protocol, server, features,        │
  │       snapshot, policy }                 │
```

### 10.4 客户端类型

| client.id | client.mode | 用途 |
|-----------|-------------|------|
| `cli` | `backend` | CLI 终端 |
| `webchat` / `control-ui` / `operator-ui` | `frontend` / `observer` | Web 界面 |
| `ios` / `android` | `frontend` | 移动端 |
| `gateway-client` | `backend` | 插件 HTTP 路由 |
| — | `node` | 远程计算节点 |

### 10.5 RPC 方法索引（部分）

| 类别 | 方法 |
|------|------|
| **连接** | connect, health |
| **聊天** | chat.send, chat.history, chat.abort, chat.inject |
| **会话** | sessions.list, sessions.create, sessions.send, sessions.abort, sessions.patch, sessions.delete, sessions.compact |
| **配置** | config.get, config.set, config.apply, config.patch, config.schema |
| **通道** | channels.status, channels.logout |
| **定时** | cron.list, cron.add, cron.update, cron.remove, cron.run, cron.runs |
| **审批** | exec.approval.request, exec.approval.resolve, exec.approvals.get |
| **设备** | device.pair.list, device.pair.approve, device.pair.reject, device.token.rotate |
| **节点** | node.pair.request, node.list, node.invoke, node.invoke.result |
| **技能/工具** | skills.status, skills.install, tools.catalog, tools.effective |
| **模型** | models.list |
| **Agent** | agent, agent.identity, agents.list, agents.create, agents.update |
| **语音** | talk.mode, talk.config, talk.speak |

### 10.6 推送事件

| 事件 | 用途 |
|------|------|
| `connect.challenge` | 握手 nonce |
| `tick` | 心跳 |
| `shutdown` | 优雅停机通知 |
| `agent.event` | Agent 运行进度/完成 |
| `chat.event` | 流式聊天增量 |
| `presence` | 客户端上下线 |
| `exec.approval.requested` | 待审批通知 |
| `exec.approval.resolved` | 审批结果 |
| `session.messages.*` | 会话消息订阅 |

### 10.7 设计评价

| 维度 | 评价 |
|------|------|
| **协议成熟度** | ✅ 优秀。版本协商、challenge 握手、能力声明 |
| **覆盖面** | ✅ 优秀。~60+ RPC 方法覆盖全部 Gateway 能力 |
| **复杂度** | ⚠️ 高。对第三方客户端开发者门槛高 |
| **与 Hermes 对比** | Hermes 无此层——CLI 与 Gateway 通过文件/subprocess 间接交互 |

## 十一、会话 ↔ 通道绑定

### 11.1 路由机制

每个 session 在 session store 中维护通道路由信息：
- `lastChannel` — 最近一次入站的通道 plugin id
- `lastRoute` — 完整投递上下文 `{ channel, to, accountId, threadId }`

### 11.2 跨通道能力

一个 session **可以**跨多个通道：
- `lastChannel` 追踪最近的入站通道，但出站可以显式指定任意通道
- `ChannelConfiguredBindingProvider` 支持将 session 绑定到特定通道/会话对
- 跨通道投递自动添加来源前缀：`[from Telegram]`
- `ChannelConversationBindingSupport` 管理会话绑定的生命周期

## 十二、跨通道审批路由

### 12.1 审批流程

```
① Agent 请求执行审批
    │ exec.approval.request 工具 → Gateway RPC
    │
    ▼
② ExecApprovalManager 持有待审批项
    │
    ▼
③ 审批转发到用户
    │ 转发目标由 ChannelApprovalNativeDeliveryCapabilities.preferredSurface 决定：
    │ ├── "origin"      → 发到触发命令的同一会话
    │ ├── "approver-dm"  → 发到 owner 的私聊
    │ └── "both"         → 两个都发
    │
    ▼
④ 通道特化渲染
    │ Slack → Block Kit 交互按钮
    │ Telegram → Inline Keyboard
    │ Discord → Component Row
    │ buildPendingPayload() / buildResolvedPayload()
    │
    ▼
⑤ 用户点击 approve/deny（平台原生交互）
    │
    ▼
⑥ 通道适配器接收交互 → exec.approval.resolve RPC
    │
    ▼
⑦ Agent 继续执行或中止
```

### 12.2 跨通道转发

当 `shouldSuppressForwardingFallback` 返回 false 时，审批可以从任意通道转发到任意其他已配置通道。

## 十三、通道特化功能

### 13.1 能力声明

每个通道通过 `ChannelCapabilities` 声明支持的功能：

```typescript
type ChannelCapabilities = {
  chatTypes: ("direct" | "group" | "channel" | "thread")[];
  media: boolean;
  reactions: boolean;
  edit: boolean;
  unsend: boolean;
  reply: boolean;
  nativeCommands: boolean;
  effects: boolean;    // iMessage 消息效果
  // ...
};
```

### 13.2 平台特化处理

| 平台 | 特化能力 |
|------|---------|
| **Slack** | thread_ts 解析、Block Kit 渲染、交互式审批按钮 |
| **Discord** | Guild/Channel 隔离、@bot mention gating、Component Row |
| **Telegram** | MarkdownV2 格式、Inline Keyboard、Topic ID 映射 |
| **WhatsApp** | 多媒体消息（audio/video/document）、reaction、已读回执 |
| **iMessage** | 消息效果（slam, gentle）、双 extension（直接/BlueBubbles） |

### 13.3 流式消息合并

`ChannelStreamingAdapter.blockStreamingCoalesceDefaults` 为每个通道配置流式消息合并参数，避免触发平台 rate limit（如 Discord 限制消息编辑频率）。

## 十四、各子系统协作全景

```
              ┌────────────────────────────────────────────────────────┐
              │                   Gateway 进程                         │
              │                                                        │
用户消息       │  Channel Plugin     Inbound          Command Queue     │
(Slack/       │  ┌──────────┐    ┌──────────┐     ┌──────────────┐    │
Discord/      │  │ gateway   │───▶│ normalize│────▶│ default lane │    │
Telegram)  ──▶│  │ adapter   │    │ debounce │     │ (串行)       │───▶│ Agent Turn
              │  └──────────┘    │ route    │     ├──────────────┤    │
              │                   └──────────┘     │ cron lane    │    │
              │                                    │ (并发)       │    │
Cron timer ──▶│  onTimer() ──────────────────────▶│              │───▶│ Agent Turn
              │                                    ├──────────────┤    │     │
Heartbeat  ──▶│  检查 system events ─────────────▶│ heartbeat    │───▶│     │
              │                                    └──────────────┘    │     │
              │                                                        │     │
              │  ┌─────────────────────────────────────────────────┐   │     │
              │  │  Outbound                                       │   │     │
              │  │  normalize → chunker → adapter.send → retry    │◀──┼─────┘
              │  │  delivery-queue/ (持久化重试)                    │   │
              │  └─────────────────────────────────────────────────┘   │
              │                                                        │
              │  WebSocket RPC Server (:18789)                        │
              │  CLI / Web / Mobile 客户端连接                         │
              └────────────────────────────────────────────────────────┘
                                │ OS 级保活
                       Daemon (launchd / systemd / schtasks)
```

## 十五、与知行的对比思考

### 15.1 OpenClaw 做对了的

1. **OS 级保活**：委托 launchd/systemd，比应用层保活可靠
2. **Cron 依赖注入**：`CronServiceDeps` 接口完全解耦，易于测试
3. **执行模式分离**：main session vs isolated session，不同场景不同策略
4. **Missed job 追赶**：重启后补执行，不丢任务
5. **错误退避**：指数退避 + 失败通知，防止无限重试
6. **Lane 隔离**：不同工作负载互不干扰
7. **Channel Plugin 细粒度 adapter**：~35 个独立 slot，每种能力可独立演进
8. **WebSocket RPC 协议**：标准化客户端通信，支持 CLI/Web/Mobile 三端
9. **持久化投递重试队列**：delivery-queue/ + 指数退避，不丢消息
10. **跨通道审批**：审批请求可以跨通道转发，平台原生渲染

### 15.2 自然语言创建定时任务

OpenClaw 提供了 `cron` 工具暴露给 AI Agent，支持自然语言创建定时任务：

```typescript
// src/agents/tools/cron-tool.ts
description: `Manage Gateway cron jobs (status/list/add/update/remove/run/runs) 
and send wake events. Use this for reminders, "check back later" requests, 
delayed follow-ups, and recurring tasks.`
```

用户说"明天 8 点提醒我开会"→ AI 理解意图 → 调用 `cron.add()` 创建 job。工具还支持 `contextMessages` 参数，可以把最近对话的上下文附加到 reminder 中。

但 AI 需要理解并正确填写底层的结构化参数（sessionTarget、wakeMode、payload.kind 等），这对模型的工具调用准确度要求较高。

### 15.3 OpenClaw 做得不够好的

1. **复杂度失控**：Cron ~130 文件、Channel Plugin ~35 个 adapter slot——能力强但认知负担重
2. **Scheduler 与 Gateway 耦合**：Cron 跑在 Gateway 进程内，不能独立扩展
3. **无任务优先级**：所有 cron job 平等，无法表达"紧急"vs"日常"
4. **无可观测性**：Cron 执行状态依赖日志文件，无实时 dashboard
5. **工具参数复杂**：AI 创建 cron job 时需理解多个概念的组合规则
6. **用户体验**：必须先 `daemon install` 才能用 cron，非零步骤
7. **通道适配门槛高**：对比 Hermes 的 4 方法基类，OpenClaw 的 35 slot 对第三方通道开发者不友好

### 15.4 对知行的启示

| 启示 | 来源 | 行动 |
|------|------|------|
| **WebSocket RPC 协议是必要的** | OpenClaw 唯一有标准化客户端协议的 | 知行 Server 模式需要设计自己的 RPC 协议 |
| **通道粒度应取中间路线** | OpenClaw 35 slot 过重，Hermes 4 方法过轻 | 核心抽象 4-6 方法 + 可选 capability trait |
| **持久化投递队列是刚需** | OpenClaw delivery-queue/ + 退避 | 知行的 Outbound 层不能只靠内存态 |
| **审批跨通道转发有价值** | OpenClaw 的多 surface 审批路由 | 知行的 ConfirmationBroker 已是渲染器无关的，扩展到多通道是自然的 |
| **Protocol versioning 从第一天就要做** | OpenClaw 已到 v3，Hermes 没有 | 知行 Server 模式的 RPC 协议第一天就带版本号 |

### 15.5 Claude Code 为什么没有

详见 [Claude Code 常驻服务分析](../claude-code/persistent-service.md)。核心原因：编程助手定位决定了"用户主动发起 → AI 响应"模型，不需要后台运行、多通道、主动通知。但 Claude Code 的 MCP、Daemon Worker、DirectConnect Server 等隐式基础设施说明它正在**渐进地向服务化演进**。
