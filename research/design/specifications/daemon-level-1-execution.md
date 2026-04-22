# Daemon Level 1 执行规格

> **文件作用**
> 本文档是 Daemon Level 1（`zhixing serve --daemon`）的**权威细节规格**——从概念、架构决策、PID / 状态文件 schema、里程碑拆解到验收清单。其他文档涉及 Daemon Level 1 时统一引用本文档，避免版本漂移。Level 2（OS 服务：launchd/systemd/SCM）有独立执行规格，**不复用本文档**。
>
> 它做三件事：
> 1. 对 Level 1 做源码级调研（OpenClaw / Hermes / Claude Code）并给出取舍
> 2. 基于三方对比设计出比它们更优的方案
> 3. 拆解为独立可验证的渐进实现里程碑（M1-M9）
>
> **前置**：[persistent-service.md §7](./persistent-service.md)（顶层定位） · [implementation-roadmap.md P1](../implementation-roadmap.md)（进度）
> **已建基础**：[process-lock.ts](../../../packages/server/src/process-lock.ts) · [lifecycle.ts](../../../packages/server/src/lifecycle.ts) · [discovery.ts](../../../packages/server/src/client/discovery.ts)

---

## 0. 概念与背景

> 这一节以第一人称回答读文档时最先冒出来的 5 个基础问题。不塞进后续技术章节，以免稀释它们的聚焦度。

### 0.1 Daemon 怎么理解

Daemon ——是 Unix 术语"守护进程"，指**脱离终端、后台常驻**的进程。读文档时直接把它当成"后台服务"就行。

### 0.2 这个模块的作用

现在的 `zhixing serve` 是**前台进程**——绑在启动它的那个终端上：

- 关终端 / Ctrl+C / 关机 → server 立刻死，飞书消息收不到
- 重启电脑后不会自动起来
- 想用 CLI 对话，必须先开一个终端跑 `serve`，再开另一个终端跑客户端

Daemon 模式要解决的是：**一次 `zhixing serve --daemon` 启动后脱离终端独立运行**，关闭所有终端、甚至登出会话都不受影响。这是"always-on 个人 Agent"的前提；Step 18（免打扰）和 Step 20（远程权限确认）都依赖这个常驻能力。

### 0.3 对 server / cli 模块有没有影响

**Server 模块**：几乎零侵入。
- 新增一个可选的 `CleanupRegistry` 注入参数
- 内部清理职责**收窄**（只管自己的 `server.close`，`releaseLock` 等移交 command.ts）
- 现有 6 个 lifecycle 测试全部继续通过
- `shutdown()` 契约不变，仍**不调** `process.exit`

**CLI 模块**：主要改动集中在 [packages/cli/src/serve/](../../../packages/cli/src/serve/)：
- 新增 `self-exec.ts`、`daemon.ts`
- `command.ts` 加 entry 分支（parent 启动 daemon / child 跑 server）
- 其他命令（`ask`、`repl`、`schedule` 等）完全不动

### 0.4 原有 `zhixing serve` 还保留吗

保留，而且是默认行为。

| 命令 | 模式 |
|------|------|
| `zhixing serve` | 前台模式（不变，等同现状） |
| `zhixing serve --daemon` | 新增后台模式 |

两者共用同一套 server / scheduler / delivery 代码路径，区别只是**进程拓扑**（是否 detach + 是否接管 stdio）。现有使用方式完全保留。

### 0.5 和现有 server 的区别 & 不可抗力断了怎么办

| 维度 | 前台 `serve` | `serve --daemon` |
|------|-------------|-----------------|
| 进程归属 | 绑终端 | 脱离终端（`detached + unref`）|
| 关终端后 | 进程死 | 继续运行 |
| stdout/stderr | 打到终端 | 重定向到日志文件 |
| 启动反馈 | 直接看日志 | 父进程轮询 PID + `.ready` + `/api/health` 握手 5s 内确认 |
| 停止方式 | Ctrl+C | `zhixing serve stop`（discover → RPC `server.shutdown` → taskkill 降级）|
| 状态查询 | — | `zhixing serve status`（PID 存活 + 端口健康 + heartbeat 新鲜度）|

**不可抗力断了怎么办**：
- **崩溃 / 被 kill -9** → 留下陈旧 PID 文件；下次启动自动清理（`isProcessAlive` + `startTime` 比对 + 抢锁重建，见 [§3.2](#32-pid-文件-schemav2扩展自-process-lockts)）
- **Level 1 不做自动重启**——那是 Level 2（launchd/systemd 注册）或 Level 3（完整服务化）的能力；M9 的 TD#1 修复只解决飞书 reconnect 期间消息不丢，不是进程级重启
- **无跨进程重连机制**——CLI 连接 daemon 时每次 `discoverServer` 都会重新读 PID 文件建立 WebSocket；daemon 挂了 CLI 会直接报连接失败，需要手动 `zhixing serve --daemon` 再起

想要 auto-restart / 开机自启，等 Level 2 的 OS 服务注册。**Level 1 只解决"脱离终端常驻"这一件事**。

---

## 1. 竞品调研

### 1.1 三种哲学对比

源码细读后，三方在"如何让进程后台化 + 如何管控"这件事上呈现完全不同的哲学：

| 维度 | OpenClaw | Hermes | Claude Code |
|------|---------|--------|-------------|
| **后台化机制** | 委托 OS 服务管理器（launchd/systemd/schtasks）| 委托 OS 服务管理器；手动场景靠 `nohup` | **原生 `spawn(..., { detached: true }) + unref()`** |
| **PID 文件** | 无（读 launchd/systemctl/netstat）| JSON + `start_time`（内核 ticks，PID reuse 检测）| JSON 丰富字段（kind / logPath / status / sessionId）|
| **启动 readiness** | WebSocket 探测 port（500ms × 120 = 60s）| **无** readiness——写 PID 即"就绪"| 无显式 readiness——子进程自注册 |
| **停机超时** | 90s drain + 25s force-exit | 10s SIGTERM → SIGKILL | 30s default, 双信号 force-exit |
| **状态文件** | 无 | `gateway_state.json`（platform-level 健康）| PID 文件中内嵌 `status` / `updatedAt` |
| **日志** | launchd 重定向 stdout/stderr，app 层无滚动 | 双层：app RotatingFileHandler（5MB×3）+ journalctl/launchd | transcript-based，env 变量 `CLAUDE_CODE_SESSION_LOG` 记录路径 |
| **Windows** | schtasks + taskkill /T /F 升级 | **不支持服务化**，只能前台 | `spawn detached` 原生工作；signal limit 用 Node 抽象绕开 |
| **核心文件** | `src/cli/gateway-cli/run-loop.ts` `src/daemon/schtasks.ts` `src/infra/process-respawn.ts` | `gateway/run.py:7696-7878` `gateway/status.py` `hermes_cli/gateway.py` | `src/utils/concurrentSessions.ts` `src/cli/editor.ts` `src/bridge/bridgeMain.ts` |

### 1.2 各自的精彩与短板

**OpenClaw** —— 正确但过重
- ✅ OS 服务委托 + 端口锁 + WebSocket readiness 探测（真正验证服务可用）
- ✅ 停机 drain 超时 + force-exit 兜底，不会僵尸
- ❌ `daemon install` 门槛高（~60 个文件），用户必须先学服务管理
- ❌ Readiness 探测 500ms×120 = 60s 最坏情形太慢（用户已经 Ctrl+C 了）
- ❌ 无独立 PID 文件，跨平台 PID 发现要走 netstat/PowerShell，Windows 5s 超时

**Hermes** —— 轻量但裸奔
- ✅ `start_time` + cmdline 双重验证避免 PID 复用误判（聪明）
- ✅ `gateway_state.json` 记录 platform-level 健康状态（诊断利器）
- ✅ `--replace` 语义：10s SIGTERM grace → SIGKILL 升级
- ❌ **无 readiness 检查**：PID 写入 = "已启动"，但端口可能还没 listen；crashed 进程会显示"running"~10s
- ❌ **优雅停机无超时**：挂起的 platform adapter 可以永远阻塞 SIGTERM（依赖 systemd `TimeoutStopSec=30` OS 层兜底）
- ❌ Windows 根本不支持服务化，只能前台

**Claude Code** —— Node.js 最成熟，但过度 session-化
- ✅ **原生 `spawn(cmd, args, { detached: true, stdio: 'ignore' }) + child.unref()`** —— 不依赖 OS 服务管理器，跨平台语义一致
- ✅ 丰富 PID schema：`{ pid, sessionId, cwd, startedAt, kind, logPath, status, waitingFor, updatedAt }`
- ✅ Cleanup Registry 模式：`registerCleanup()` / `runCleanupFunctions()`，所有退出路径走同一清理链
- ✅ 双信号 force-exit：第一次 Ctrl+C 优雅，第二次立即 exit(1)
- ✅ Windows：`spawn detached` 原生工作，不需要特殊处理（signal 限制靠 Node 抽象）
- ❌ 无真正的"daemon 状态查询"——PID 文件是 session-level 的，一次查询要扫整个 `~/.claude/sessions/` 目录
- ❌ 日志路径由 env 变量传递，缺乏**单一可预测路径**供外部工具观察

### 1.3 知行 Level 1 的超越点

基于以上对比，本 spec 的设计取舍如下：

| 维度 | 知行选择 | 对比原因 |
|------|----------|---------|
| 后台化机制 | **Claude Code 的 `spawn + detached + unref`** | 零依赖、跨平台、不需 `daemon install` |
| PID 文件 | **Hermes 的 `startTime` 检测 + Claude Code 的 logPath/kind 字段** | PID reuse 安全 + 外部工具可直达日志 |
| Readiness 验证 | **改良：child 写 `.ready` marker + parent 轮询 PID+marker+health，5s 上限** | 比 OpenClaw 的 60s 探测快 10×；比 Hermes 的"无验证"鲁棒 |
| 状态文件 | **Hermes 的 gateway_state.json，精简到 server 级** | 运行诊断 + 死亡检测（lastHeartbeat） |
| 停机超时 | **OpenClaw drain + Hermes SIGTERM→SIGKILL 升级 + Claude Code 双信号** | 三者之长合一 |
| 日志 | **单一预测路径 + 子进程 stdio 重定向 + 无滚动（TD 跟踪）** | 修 Claude Code 的路径散乱；修 Hermes/OpenClaw 的不滚动（暂不做，TD 跟踪）|
| Windows 停机 | **优先走 WebSocket RPC `server.shutdown` 优雅，失败降级 taskkill /T → /F /T** | 给 Windows 用户真正的 graceful path（Hermes 直接放弃） |
| Cleanup 机制 | **Claude Code 的 Cleanup Registry 抽出来** | 所有退出路径去同一条清理链 |

---

## 2. 范围与非范围

### 2.1 P1a（本执行规格覆盖）

| 能力 | 产出 |
|------|------|
| `zhixing serve --daemon` | `spawn + detached + unref` + 重定向日志 + 父进程等 `.ready` + health 探测 |
| `zhixing serve stop` | discover → SIGTERM → 30s 轮询 → SIGKILL 兜底 |
| `zhixing serve status` | 三态（running / stopped / stale）+ `--json` + 死亡检测（lastHeartbeat）|
| `zhixing serve logs` | 默认打印日志尾部 50 行，`--tail` 流式跟踪 |
| TD#1 修复 | `setup-delivery` channel-not-found 改为 `retryable:true` |

### 2.2 P1b（剥离，独立阶段）

- `zhixing`（无参）Server 运行时自动 connect WebSocket（涉及 local/remote REPL UX 对齐，独立设计）
- Level 2 OS 服务安装（persistent-service.md §7.3 占位）
- 真正的 SIGUSR1 热重启（Level 1 无 supervisor，不做）

### 2.3 依赖既有能力

P1 复用而非重建：
- **端口锁** — `startServer` 的 `listen()` 已处理 `EADDRINUSE`
- **PID 文件 + stale 检测** — [process-lock.ts](../../../packages/server/src/process-lock.ts)（本 spec 将**扩展** schema）
- **Shutdown 编排** — [lifecycle.ts](../../../packages/server/src/lifecycle.ts)（本 spec 将**加强**超时与 cleanup）
- **Server 发现** — [discovery.ts](../../../packages/server/src/client/discovery.ts)

---

## 3. 架构决策

### 3.1 进程拓扑

```
用户终端
   │
   │ zhixing serve --daemon
   ▼
┌──────────── 父进程（CLI） ─────────────────────┐
│ 1. 通过 SelfExec 模块拿 { cmd, args, env }     │
│ 2. 打开日志文件 fd (append mode)               │
│ 3. spawn(cmd, args, DaemonSpawnOptions(fd))    │
│    ├─ detached: true                           │
│    ├─ stdio: ["ignore", fd, fd]                │
│    ├─ windowsHide: true                        │
│    └─ env: DAEMON_CHILD=1, 其它继承            │
│ 4. child.unref() + 父进程立即 close(fd)        │
│ 5. StartupHandshake.wait(READY_PATH, 5s):      │
│    - PID 文件存在 + pid 存活                    │
│    - .ready marker 存在                        │
│    - GET /api/health 200                       │
│ 6. 成功 → 打印横幅 + exit(0)                   │
│    失败 → 打印日志尾部 20 行 + exit(1)         │
└────────────────────────────────────────────────┘
                │
                │ 完全脱离（fd 复制给子进程）
                ▼
┌──────────── 子进程（Server）─────────────────────┐
│ isDaemonChild() === true 时：                    │
│ 1. ServerStateFile.transition("starting")        │
│ 2. 启动 HTTP + WebSocket + Scheduler + Channels  │
│ 3. acquireLock（PID 文件 v2）                    │
│ 4. command.ts 所有子系统就绪后：                 │
│    ServerStateFile.markReady()                   │
│      ↳ 原子写 state={phase:"ready"}              │
│      ↳ 创建 .ready marker                        │
│    ServerStateFile.markRunning()   ← 紧随调用    │
│      ↳ 原子写 state={phase:"running"}            │
│ 5. Heartbeat timer: 每 60s 刷新 lastHeartbeat    │
│    （不改 phase）                                │
│ 6. 等待信号 / shutdown RPC                       │
│ 7. Cleanup Registry.runAll()（LIFO 展开）：       │
│    - markStopping → scheduler.stop → channels    │
│      → delivery → heartbeat → server.close       │
│    - markStopped → 删 .ready/state → releaseLock │
└──────────────────────────────────────────────────┘
```

**关键机制拆分为 4 个独立模块**（见 §3.7 / §3.8）：

| 模块 | 路径 | 职责 |
|------|------|------|
| `SelfExec` | `packages/cli/src/serve/self-exec.ts` | 如何重新执行自己（进程身份、env 过滤） |
| `ServerStateFile` | `packages/server/src/server-state.ts` | 阶段状态机 + 状态文件 + ready marker |
| `CleanupRegistry` | `packages/server/src/cleanup-registry.ts` | LIFO 清理链（M4） |
| `server.*` RPC | `packages/server/src/rpc/methods/server.ts` | graceful shutdown 控制面 |

### 3.2 PID 文件 schema（v2，扩展自 process-lock.ts）

**路径**：`~/.zhixing/server.pid`

```json
{
  "pidFileVersion": 2,
  "pid": 12345,
  "port": 18900,
  "host": "127.0.0.1",
  "startedAt": "2026-04-22T10:30:15.000Z",
  "startTime": 8291047,
  "argv": ["node", ".../zhixing", "serve"],
  "kind": "zhixing-server",
  "version": "0.1.0",
  "logPath": "/home/user/.zhixing/server.log"
}
```

- **`pidFileVersion`** —— schema 演化，未来兼容
- **`startTime`** —— 从 Linux `/proc/<pid>/stat` 字段 22 或 Node `process.uptime()` 推算；用于 PID 复用检测（Hermes 模式）
- **`logPath`** —— 外部工具 / `serve status` 直接告知用户日志位置
- **`kind`** —— 为将来 Level 2 daemon worker / bg session 扩展预留

### 3.3 ServerStateFile：阶段状态机

**设计意图**：`.ready` marker + `server.state` JSON 不是两个独立概念——它们是**同一个生命周期状态机**的两种外化。统一到 `ServerStateFile` 抽象里，消除职责重叠（审查 D1）。

#### 3.3.1 阶段状态机

```
       ┌────────────┐
       │  starting  │  子进程初始化中，HTTP/Scheduler/Channels 未全就绪
       └─────┬──────┘
             │ markReady()        ← 写 .ready marker（只在此唯一点创建）
             │ markRunning()      ← 紧随 markReady，同步调用（不等 heartbeat）
             ▼
       ┌────────────┐
       │  running   │  稳态。每 60s heartbeat 仅刷新 lastHeartbeat（不变 phase）
       └─────┬──────┘
             │ markStopping()     ← SIGTERM / server.shutdown RPC
             ▼
       ┌────────────┐
       │  stopping  │  正在清理（scheduler.stop / channels.close / releaseLock）
       └─────┬──────┘
             │ markStopped()
             ▼
       ┌────────────┐
       │  stopped   │  进程即将退出。之后 cleanup 会删 .ready marker + PID 文件
       └────────────┘

  任意阶段出现不可恢复错误 → unhealthy（保留 PID 文件供诊断，不删 .ready）
```

**为什么保留 `ready` 阶段但不停留**：`ready` 是 `markReady()` 写 `.ready` marker 的语义锚点——父进程 handshake 检测到 marker 即可。但子进程**立即**调 `markRunning()` 进入稳态，不等 60s heartbeat。`ready` 阶段实际持续 <1ms（同步调用间隙），仅在 crash 诊断时可见（state 文件记录了转换时间戳）。Heartbeat timer 只刷新 `lastHeartbeat`，不改 phase。

#### 3.3.2 接口契约

```typescript
// packages/server/src/server-state.ts

export type ServerPhase =
  | "starting" | "ready" | "running" | "stopping" | "stopped" | "unhealthy";

export interface ServerStateSnapshot {
  phase: ServerPhase;
  pid: number;
  startedAt: string;          // ISO，不变
  lastHeartbeat: string;      // ISO，heartbeat 刷新
  port?: number;
  host?: string;
  exitReason?: "graceful" | "error" | "crash" | "signal";
  /** 可扩展：Step 18 Active Hours 时填 channelHealth，现在留空 */
  extensions?: Record<string, unknown>;
}

export interface ServerStateFileOptions {
  statePath?: string;         // ~/.zhixing/server.state
  readyMarkerPath?: string;   // ~/.zhixing/server.ready
  clock?: () => Date;         // 注入，便于测试
}

export class ServerStateFile {
  constructor(opts?: ServerStateFileOptions);

  /** starting → ready（写 state + 创建 .ready marker，原子顺序）*/
  markReady(snapshot: Omit<ServerStateSnapshot, "phase">): Promise<void>;

  /** ready → running（紧随 markReady 同步调，不等 heartbeat）*/
  markRunning(): Promise<void>;

  /** running → stopping（SIGTERM / RPC 入口）*/
  markStopping(reason: ServerStateSnapshot["exitReason"]): Promise<void>;

  /** stopping → stopped（cleanup 的早期阶段）*/
  markStopped(): Promise<void>;

  /** 任意阶段 → unhealthy（不可恢复错误）*/
  markUnhealthy(reason: string): Promise<void>;

  /** 周期性刷新 lastHeartbeat（仅更新时间戳，不改 phase）*/
  heartbeat(): Promise<void>;

  /** 读当前快照（失败返回 null，不抛）*/
  read(): Promise<ServerStateSnapshot | null>;

  /** 删 .ready marker + state 文件（cleanup 最后一步）*/
  cleanup(): Promise<void>;
}
```

**职责边界**：
- **ServerStateFile 不关心 PID 文件**——那是 `process-lock.ts` 的职责
- **不关心 channel / delivery 健康**——子系统自己用 EventBus 发事件，未来可通过 `extensions` 字段外化
- **不关心 cleanup 顺序**——由 `CleanupRegistry` (M4) 编排

#### 3.3.3 文件格式

`~/.zhixing/server.state`（原子写：tmp → rename）：
```json
{
  "phase": "running",
  "pid": 12345,
  "startedAt": "2026-04-22T10:30:15.000Z",
  "lastHeartbeat": "2026-04-22T10:35:00.000Z",
  "port": 18900,
  "host": "127.0.0.1",
  "exitReason": null,
  "extensions": {}
}
```

`~/.zhixing/server.ready`——**空文件**（boolean marker），只有 `markReady()` 写入；`cleanup()` 删除。外部工具（父进程 handshake、`serve status`）用它做最廉价的"是否进入过 ready"探测。

#### 3.3.4 stale heartbeat 判定

`serve status` 读 state 文件：
- `phase === "running"` AND `Date.now() - lastHeartbeat < 2 × HEARTBEAT_MS` → `running`
- `phase === "running"` AND `Date.now() - lastHeartbeat >= 2 × HEARTBEAT_MS` → `running-unhealthy`（僵尸）
- `phase === "stopping"` → `stopping`
- state 文件不存在 + PID 文件存在 → `running-unknown`（可能升级中途）
- PID 文件不存在 → `stopped`

**stale 阈值 = 2 × heartbeat 间隔**，即 120s。heartbeat 缺失 1 次即告警，2 次确认僵尸。

### 3.4 信号处理矩阵

| 信号 | 平台 | 行为 |
|------|------|------|
| `SIGTERM` | POSIX | graceful shutdown（30s timeout per 步骤）→ exit(0) |
| `SIGTERM` | Windows | Node 层等价 force-kill，**但 lifecycle.ts 的 handler 仍会被调用**（Node 会在 exit 前执行 listener），因此优雅清理**部分**生效 |
| `SIGINT` (第一次) | All | 同 SIGTERM graceful |
| `SIGINT` (第二次) | All | `process.exit(1)` 立即（Ctrl+C 连按双击的 force-exit） |
| `SIGKILL` | POSIX | 不可捕获，只能事后由 `serve stop` 兜底清理 stale PID |
| `SIGUSR1` | POSIX only | 本 Level 等同 SIGTERM（不做自动重启）；Windows 跳过 |

### 3.5 日志策略

| 项 | 值 | 原因 |
|---|---|---|
| 路径 | `~/.zhixing/server.log`（单文件 append） | 可预测，外部工具 `tail -f` 即用 |
| stdio 重定向 | 父进程 `fs.openSync(LOG_PATH, 'a')`，传给 child 的 stdout/stderr fd | 无需 child 自管文件 |
| 滚动 | **不做** | 个人日常流量 <10MB/月；引入 logrotate 增加 ~100 行 + 测试面；纳入 TD#9 |
| 启动失败诊断 | 父进程 fail 时打印 log 尾部 20 行到父 stdout | 用户立即看到错误 |
| `serve logs` 查看 | 默认打印最后 50 行；`--tail` 以 spawn Node readline 实现的跨平台 tail -f | 不依赖 Unix `tail` 二进制 |

### 3.6 Cleanup Registry（借鉴 Claude Code）

抽出 cleanup-registry 风格工具到 `packages/server/src/cleanup-registry.ts`：

```typescript
interface CleanupRegistry {
  register(name: string, fn: () => Promise<void> | void): void;
  runAll(reason: string): Promise<void>;  // 按 LIFO 顺序、每项独立 try/catch
}
```

所有退出路径（SIGTERM / SIGINT / uncaughtException / 正常退出 / `server.shutdown` RPC）统一调用 `registry.runAll()`，消除"某处忘了清理 PID 文件"的散弹式 bug。

#### 3.6.1 跨包所有权（I15 修复）

**问题**：`CleanupRegistry` 定义在 `packages/server/`，但 `channels.dispose()` / `deliveryStack.stop()` / heartbeat timer 的生命周期管理在 `packages/cli/src/serve/command.ts`。当前代码已有**重复清理**：`lifecycle.ts` 的 shutdown 调 `scheduler.stop()`，`command.ts:293-296` 又调一次——M4 必须消除这种分散。

**解法：注入模式**

```
command.ts（编排层）                           lifecycle.ts（运行层）
┌──────────────────────────────────┐        ┌───────────────────────────────┐
│ 1. const registry = new          │        │ runServer(opts) {             │
│    CleanupRegistry()             │        │   // 注册 server-internal     │
│                                  │        │   opts.cleanupRegistry        │
│ 2. 注册尾部清理（LIFO 最后执行）│───────▶│     ?.register("http.close",  │
│    - releaseLock                 │  注入  │        runner.server.close)   │
│    - stateFile.cleanup           │        │                               │
│    - stateFile.markStopped       │        │   // shutdown 入口调 registry │
│                                  │        │   shutdown = (reason) =>      │
│ 3. runServer({ ...,              │        │     registry.runAll(reason)   │
│      cleanupRegistry: registry })│        │ }                             │
│    ↳ runServer 内部注册          │        └───────────────────────────────┘
│      runner.server.close         │
│                                  │
│ 4. 注册核心资源（LIFO 最先执行）│
│    - clearInterval(hb)           │
│    - deliveryStack.stop          │
│    - channels.dispose            │
│    - scheduler.stop              │
│    - stateFile.markStopping      │
│                                  │
│ 5. 删除 waitForShutdown()        │
│    之后的重复清理块               │
│    （原 L293-296）               │
└──────────────────────────────────┘
```

**关键约束**：
- `command.ts` **创建并拥有** registry 实例——它是唯一知道全部资源的编排点
- `runServer` 通过可选参数 `cleanupRegistry?: CleanupRegistry` 接收注入——无 daemon 时不传，行为等价现状（向后兼容）
- `lifecycle.ts` 内部只注册 `runner.server.close`（server HTTP/WS 关闭）；`releaseLock` 由 command.ts 注册（确保 LIFO 最后执行）
- **彻底删除** `command.ts` 的 `waitForShutdown()` 之后的重复清理块（原 L293-296：`scheduler.stop` / `delivery.stop` / `channels.dispose`）——这些已注册到 registry，由 `lifecycle.ts` 统一触发

**注册顺序与 LIFO 执行顺序**：

LIFO = 最后注册者最先执行。因此**注册顺序是期望执行顺序的倒序**——和构造/析构的镜像关系一致。下表左列是注册顺序（代码书写顺序），右列是 LIFO 实际执行顺序：

```
注册顺序                                 LIFO 执行顺序
（代码中的 register 调用序）               （runAll 实际调用序）
─────────────────────────────           ─────────────────────────────
┌─ command.ts 注册（cleanup 尾部）┐      ① stateFile.markStopping
│ 1. releaseLock()               │      ② scheduler.stop()
│ 2. stateFile.cleanup()         │      ③ channels.dispose()
│ 3. stateFile.markStopped()     │      ④ deliveryStack.stop()
├─ runServer 内部注册 ───────────┤      ⑤ clearInterval(heartbeat)
│ 4. runner.server.close()       │      ⑥ runner.server.close()
├─ command.ts 注册（核心资源）───┤      ⑦ stateFile.markStopped()
│ 5. clearInterval(heartbeat)    │      ⑧ stateFile.cleanup()
│ 6. deliveryStack.stop()        │      ⑨ releaseLock()
│ 7. channels.dispose()          │
│ 8. scheduler.stop()            │
│ 9. stateFile.markStopping()    │
└────────────────────────────────┘
```

**执行顺序保证**（右列 ①→⑨）：
- ① `markStopping` 最先——对外宣告停机，外部观察者立即感知
- ②→⑤ 业务子系统先停——scheduler 先于 server.close，确保活跃任务不往已关闭连接写数据
- ⑥ HTTP/WS close——此时上游已不产生新请求
- ⑦→⑨ 状态文件清理 + PID 文件最后删——与现有 lifecycle.ts 的 `scheduler→server→lock` 顺序一致

**代码时序**：command.ts 先注册尾部项（1-3），然后调 `runServer()` 使其内部注册中间项（4），再回到 command.ts 注册核心资源（5-9）。这个时序是自然的——尾部清理（state 文件/PID 文件）在调用 runServer **之前**就知道要注册；核心资源（scheduler/channels/delivery）在 runServer **之后**才全部就绪。LIFO 自动把"先注册的尾部"推到执行末尾。

### 3.7 SelfExec：自重入机制

**设计意图**：父进程需要 spawn 一个"自己的 daemon child 版本"（通过 env var 识别）。如何定位自身可执行入口是个容易散弹化的决策点——涉及生产/开发模式差异、跨平台、env 继承、未来 Level 2 复用。统一到 `SelfExec` 模块。

#### 3.7.1 接口

```typescript
// packages/cli/src/serve/self-exec.ts

/** Child 识别：仅通过 env var，不引入 CLI flag（避免 commander 注册污染） */
export const DAEMON_CHILD_ENV_VAR = "ZHIXING_DAEMON_CHILD";

export function isDaemonChild(): boolean {
  return process.env[DAEMON_CHILD_ENV_VAR] === "1";
}

export interface SelfExecArgs {
  /** Node binary 路径（process.execPath） */
  command: string;
  /** [entryScript, ...forwardedArgs]；forwardedArgs 不含 --daemon */
  args: string[];
  /** 清理后的 env，附加 DAEMON_CHILD=1 */
  env: NodeJS.ProcessEnv;
}

/**
 * 解析当前进程的"自重入"参数。
 * 若当前不是通过标准 .js 脚本入口调用（bundled binary / REPL），
 * 抛 UnsupportedSelfExecError 明确拒绝 daemon 模式。
 */
export function resolveSelfExec(forwardedArgs: string[]): SelfExecArgs;

export interface DaemonSpawnOptions extends Pick<SpawnOptions,
  "detached" | "stdio" | "windowsHide" | "env"> {}

/** 构造 daemon spawn options（集中所有平台决策点） */
export function buildDaemonSpawnOptions(logFd: number, env: NodeJS.ProcessEnv): DaemonSpawnOptions;
```

#### 3.7.2 关键决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 子进程识别方式 | **env var `ZHIXING_DAEMON_CHILD=1`**，不引入 CLI flag | 避免 commander unknown-option 报错；不污染 `--help` 输出 |
| 入口脚本定位 | `process.argv[1]`（而非 `process.execPath`） | `execPath` 是 node binary；`argv[1]` 才是 zhixing 脚本 |
| Bundled binary 兜底 | `argv[1]` 非 .js / 不存在 → 抛错拒绝 `--daemon` | Level 1 要求必须通过标准 CLI 调用；未来 Level 2 可特化 |
| `detached` | `true`（所有平台） | Node 抽象一致 |
| `stdio` | `["ignore", logFd, logFd]` | stdin 关；stdout/stderr 合并到 log 文件 |
| `windowsHide` | `true`（所有平台，POSIX 无效） | **防 Windows 弹出新 console 窗口** |
| env 过滤 | 剥离 `TERM` / `COLUMNS` / `LINES` / `TTY` 相关 | daemon child 无 TTY，避免 chalk 误判为彩色终端污染日志 |
| env 附加 | `ZHIXING_DAEMON_CHILD=1` | 子进程识别标志 |

#### 3.7.3 可插拔点

- `resolveSelfExec` 签名允许未来注入"bundled binary 路径 resolver"（Level 2 需要）
- `buildDaemonSpawnOptions` 可被 Level 2 OS 服务扩展（添加 `uid`/`gid`/资源限制）
- env 过滤规则单独导出为 `filterDaemonChildEnv()`，便于测试断言

### 3.8 Server Control RPC Surface

**设计意图**：Windows 下 SIGTERM 等价 force-kill（[process-lock.ts:17-19](../../../packages/server/src/process-lock.ts#L17-L19)），需要应用层优雅通道。同时为将来的 `server.reload()` 热配置、`server.info()` 诊断预留命名空间。

#### 3.8.1 新增 RPC 命名空间

| 方法 | requiresAuth | 语义 |
|------|--------------|------|
| `server.shutdown` | ✅ | 请求优雅停机；立即 ack 回响应，实际 shutdown 异步执行（走与 SIGTERM 相同的 `runner.shutdown` 路径） |
| `server.info` (可选增强) | ❌ | 读取 state 文件 + PID 文件摘要，无鉴权（仅本地访问） |
| `server.reload` (🔮 占位) | ✅ | 未来用于热重载配置，Level 1 不实现 |

`server.shutdown` 请求 schema：
```typescript
{
  reason?: string;          // "user-requested" / "upgrade" / ...
  timeoutMs?: number;       // graceful shutdown 预算上限，默认 30_000
}

// 返回
{
  accepted: true;
  phase: "stopping";
  estimatedCompleteAt: string;  // ISO，仅参考
}
```

**实现要点**：
- 由 `packages/server/src/rpc/methods/server.ts` 提供（与 `auth.ts` / `schedule.ts` / `session.ts` 同级）
- handler 拿到 `ctx` 后调 `ctx.server.requestShutdown?.(reason)`——这个 hook 需要在 `ServerContext` 里新增
- `requestShutdown` 实际调用 `runner.shutdown(reason)`，但 handler 不 `await`（立即返回 ack，避免 RPC 自己被 shutdown 切断连接）

**`ctx.requestShutdown` 绑定时序（I1 修复）**：

```
startServer(ctx)  ← 返回 runner
    │
    ▼ 立即（同一 tick）
ctx.requestShutdown = (reason) => runner.shutdown(reason)
    │
    ▼ 此后 RPC 调用才可能到达 handler
```

- `lifecycle.ts` 的 `runServer()` 在 `startServer()` resolve 后**立即**（同一微任务）绑定 `ctx.requestShutdown`
- 理论上 HTTP listen → 第一个 RPC 到达之间存在数微秒窗口（TCP accept 后到 handler 执行前），但 Node 事件循环保证：`startServer` 的 `await` resolve 与 `ctx.requestShutdown` 赋值在同一微任务内完成，而 RPC handler 执行在下一个事件循环 tick——**不存在 race**
- 防御性兜底：handler 检查 `ctx.server.requestShutdown` 为 null 时，抛 `RpcErrors.internal("server shutdown not wired yet")`，而非静默忽略
- 此错误只可能在 `startServer` 内部抛异常（未正常 resolve）时触发——等价于 server 没启动成功，RPC 本就不应正常服务

#### 3.8.2 与 SIGTERM 的关系

```
             ┌─ SIGTERM / SIGINT (POSIX)
             │     └─ shutdown(reason).then(() => process.exit(0))
             │
             ├─ server.shutdown RPC（跨平台，唯一 Windows graceful 路径）
             │     └─ shutdown(reason)  // 不 await，不 exit，立即 ack
             │
             ├─ uncaughtException（兜底）
             │     └─ shutdown(reason).then(() => process.exit(1))
             │
             ▼
       runner.shutdown(reason)          ← 幂等，首次执行清理
             │
             ▼
       CleanupRegistry.runAll(reason)   ← LIFO 展开
             │
             ▼
       Promise resolve                  ← 不调 process.exit
             │                            由调用方 .then() 决定是否 exit
             ▼
       waitForShutdown() resolve        ← 依赖同一 promise
```

**关键设计约束**：`shutdown()` 只负责清理 + resolve promise，**绝不调 `process.exit()`**。退出决策权留给触发方：
- 信号 handler：`.then(() => process.exit(0))`——与现有 [lifecycle.ts:128-129](../../../packages/server/src/lifecycle.ts#L128-L129) 模式一致
- RPC handler：不 exit（进程由信号/OS 管理）
- `waitForShutdown()`：调用方（command.ts）等 promise resolve 后自然退出

这保证了 `waitForShutdown()` 契约不变——M4 重构不破坏现有 6 个 lifecycle 测试。

---

## 4. 核心决策（决议汇总）

| # | 决策 | 选择 | 出处 |
|---|------|------|------|
| A1 | 后台化机制 | `spawn(process.argv[1] via SelfExec, args, { detached:true, stdio:[ignore,logFd,logFd], windowsHide:true }) + child.unref()` | Claude Code + 改良 |
| A2 | 父进程 ready 判定 | 5s 轮询：PID alive + `.ready` marker + `/api/health` 200，三者皆需 | 改良三方 |
| A3 | PID 文件 schema | `v2 { pidFileVersion, pid, port, host, startedAt, startTime, argv, kind, version, logPath }` | Hermes + Claude Code |
| A4 | 停机超时升级 | graceful 30s 轮询 → 超时 SIGKILL + 强制清理文件 | Hermes `--replace` |
| A5 | `status` 四态输出 | `running` / `running-unhealthy` / `running-unknown` / `stopped` / `stale` | 改良三方 |
| A6 | 日志单文件 append | `~/.zhixing/server.log`；无滚动，记 TD#9 | 独立决策 |
| A7 | Windows 停机 | 先尝试 RPC `server.shutdown`（15s），失败降级 taskkill /T → /F /T | OpenClaw + 原创 |
| A8 | 二次信号 force-exit | 已实现（[lifecycle.ts:130-137](../../../packages/server/src/lifecycle.ts#L130-L137)）| Claude Code |
| A9 | SIGUSR1 在 Level 1 | = 优雅停机；无 supervisor 不做自启 | 独立决策 |
| A10 | Cleanup Registry 中心化 | `packages/server/src/cleanup-registry.ts`，单一 shutdown 出口 | Claude Code |
| **A11** | **子进程识别** | **env var `ZHIXING_DAEMON_CHILD=1`，不引入 CLI flag** | **独立**（H2 修复） |
| **A12** | **入口脚本定位** | **`process.argv[1]`（不是 execPath）；非 .js 拒绝 daemon 模式** | **独立**（H1 修复） |
| **A13** | **生命周期状态机** | **`ServerStateFile` 抽象承载 starting/ready/running/stopping/stopped/unhealthy；.ready marker 是 `ready` 阶段副产品** | **独立**（H3 修复） |
| **A14** | **shutdown 单一出口** | **`runner.shutdown(reason)` 汇聚 SIGTERM / SIGINT / `server.shutdown` RPC / uncaughtException，触发 `CleanupRegistry.runAll`；不调 `process.exit`，exit 由调用方 `.then()` 决定** | **独立**（H5 修复） |

---

## 5. 渐进实现（9 个独立可验证里程碑）

设计原则：**每个里程碑独立可 merge、可验证、可回滚**。M1-M9 总计 ~10 工作小时。

### M1 — SelfExec + Daemon child 入口 + readiness 握手（2.5h）

> 本里程碑实现 A1 / A2 / A11 / A12 四项决策。

**改动**：
- `packages/cli/src/serve/self-exec.ts`（新增 ~80 行）：
  - `isDaemonChild()` / `DAEMON_CHILD_ENV_VAR`
  - `resolveSelfExec(forwardedArgs)`：从 `process.argv[1]` 构造，非 .js 抛 `UnsupportedSelfExecError`
  - `buildDaemonSpawnOptions(logFd, env)`：封装 `detached/stdio/windowsHide/env`
  - `filterDaemonChildEnv(env)`：剥离 TTY-specific 变量
- `packages/cli/src/serve/daemon.ts`（新增 ~120 行）：
  - 父进程分支：调用 `resolveSelfExec` + `buildDaemonSpawnOptions` + spawn + `child.unref()` + 立即 `fs.closeSync(logFd)`
  - `startupHandshake(timeoutMs=5000)`：轮询 PID 文件 / `.ready` / `/api/health`，三者皆需
  - 失败路径：读 `~/.zhixing/server.log` 尾部 20 行打印 + `exit(1)`
- `packages/cli/src/serve/command.ts`（改 ~10 行）：入口判定 `if (isDaemonChild()) runChild() else if (opts.daemon) spawnDaemon()`
- `packages/cli/src/index.ts`（改 ~2 行）：serve 命令加 `--daemon` flag
- `packages/cli/src/serve/__tests__/self-exec.test.ts`（新增 ~80 行）：
  - mock `process.argv` + `process.platform`，断言 spawn options 内容
  - 断言 bundled binary 场景抛错

> **注**：`.ready` marker 的**写入位置不在本里程碑**——M1 只做父子协议；marker 的写入由 M3 的 `ServerStateFile.markReady()` 在 `command.ts` 最末端调用。M1 阶段父进程的 handshake 用"PID 文件 + `/api/health`"两项判定就够（ready marker 判定在 M3 启用）。

**验证**：
```bash
pnpm --filter @zhixing/cli build     # M1 依赖构建产物（见下方 N2 注）
zhixing serve --daemon               # 预期：3s 内返回横幅
ls ~/.zhixing/server.pid              # 存在
ps -p $(cat ~/.zhixing/server.pid | jq .pid)  # 子进程活
# 子进程会一直运行，M5 之前只能 kill -9 停掉
```

**单元测试**（不实际 spawn）：
- `self-exec.test.ts`：mock `process.argv[1]`、断言产出的 command/args/env 正确
- `daemon.test.ts`：mock `child_process.spawn` + `fs.existsSync`、覆盖 handshake 成功/超时/失败路径

**回滚**：删除 self-exec.ts / daemon.ts，还原 command.ts 的入口判定（~10 行），还原 index.ts 的 `--daemon` flag（~2 行）。无影响已有功能。

### M2 — PID 文件 schema v2 + 静默迁移（1h）

> 本里程碑实现 A3 决策。

**改动**：
- `packages/server/src/process-lock.ts`（改 ~40 行）：
  - 扩展 `PidFileContents`：加 `pidFileVersion`/`startTime`/`argv`/`kind`/`version`/`logPath`
  - `readPidFile` 兼容 v1：**无 `pidFileVersion` 字段** → 视为 v1，自动补齐 `pidFileVersion:1, startTime:null`；**不**报告 stale（静默迁移，避免用户升级后的"Found stale pid file"警告）
  - 新增 `resolveProcessStartTime(pid)`：Linux 读 `/proc/<pid>/stat` 字段 22；macOS 用 `ps -o lstart= -p`；Windows / 读取失败 → `null`
  - PID reuse 检测：若 PID 文件有 `startTime` 且 runtime 的 `resolveProcessStartTime(pid)` 不同 → 判 stale
- `packages/server/src/__tests__/process-lock.test.ts`（新增 ~50 行）：
  - v1 文件静默迁移（不报 stale，兼容读取）
  - v2 文件 startTime 一致 → 正常
  - v2 文件 startTime 不一致 → stale
  - startTime 为 null（平台不支持）→ 降级为纯 `isProcessAlive()` 检测

**验证**：
- 所有 `process-lock.test.ts` 原有用例继续通过（向后兼容）
- 新 v1→v2 迁移用例通过
- 全量 2200+ test green

**回滚**：revert process-lock.ts。旧 v2 文件对回滚后的 v1 代码：v1 代码只读 `{ pid, port, startedAt }`，多余字段被忽略——**向后兼容**。

### M3 — ServerStateFile + 阶段状态机 + heartbeat（2h）

> 本里程碑实现 A13 决策；M1 的 `.ready` marker 握手在本里程碑**正式启用**。

**改动**：
- `packages/server/src/server-state.ts`（新增 ~150 行）：
  - `ServerStateFile` 类（§3.3.2 契约）：6 个 `mark*()` 方法 + `heartbeat()` + `read()` + `cleanup()`
  - 原子写实现（tmp → rename）
  - 状态转换校验（非法转换抛错——例如 `stopped` → `running`）
- `packages/cli/src/serve/command.ts`（改 ~25 行）：
  - daemon child 入口处 `new ServerStateFile()` + `markStarting()`
  - 所有子系统（channels / delivery / scheduler / server）就绪后：
    - **`markReady({pid, startedAt, port, host})`** ←—— .ready marker 在此创建
    - **紧接 `markRunning()`** ←—— 立即进入稳态，不等 heartbeat
  - 启动 `setInterval(() => state.heartbeat(), 60_000)`——仅刷新 `lastHeartbeat` 时间戳
- `packages/server/src/lifecycle.ts`（改 ~15 行）：
  - `shutdown(reason)` 开头：`state.markStopping(reason)` + `clearInterval(heartbeatTimer)`（临时硬编码，M4 移入 Registry）
  - 结尾前：`state.markStopped()` + `state.cleanup()`
- `packages/server/src/__tests__/server-state.test.ts`（新增 ~80 行）：
  - 状态转换正确性
  - .ready marker 生命周期（只在 markReady 创建、cleanup 删除）
  - 原子写（并发 write 测试）
  - 非法转换校验

**验证**：
```bash
zhixing serve --daemon
cat ~/.zhixing/server.state       # phase: running（markReady+markRunning 背靠背，不会停在 ready）
ls ~/.zhixing/server.ready         # 存在
sleep 65 && cat ~/.zhixing/server.state  # lastHeartbeat 已刷新、phase=running
```

**回滚**：revert command.ts + lifecycle.ts，删 server-state.ts。M1 的 handshake 回到"PID 文件 + /api/health 两项判定"（与 M1 完成时一致）。

> **M3→M4 过渡债**：本里程碑在 lifecycle.ts 硬编码 `clearInterval(heartbeatTimer)`。M4 的 CleanupRegistry 会接管这个清理（由 command.ts 注册到 registry），到时移除硬编码。spec 读者应知这是**预期过渡态**，非遗漏。

### M4 — Cleanup Registry 抽出 + shutdown 统一出口 + 跨包注入（2h）

> 本里程碑实现 A10 / A14 决策。**范围从 1h 上调到 2h**——lifecycle.ts 是 server 包核心 shutdown 路径，回归面大（审查 D2）。同时解决 I15 跨包 cleanup 所有权问题。

**前置动作**（编码前）：
1. 运行 `pnpm --filter @zhixing/server test`，记录 `lifecycle.test.ts` 全部用例 baseline（pass/fail/断言顺序）
2. 以 baseline 为契约：M4 完成后所有用例行为必须**完全一致**

**改动**：
- `packages/server/src/cleanup-registry.ts`（新增 ~60 行）：
  - `register(name, fn)`：压栈
  - `runAll(reason)`：**LIFO 展开**，每项独立 try/catch，记录失败但不中断链
  - logger 注入点（observability）
- `packages/server/src/lifecycle.ts`（重构 ~60 行）：
  - `runServer` 新增可选参数 **`cleanupRegistry?: CleanupRegistry`**
  - 传入时：`runServer` 在 registry 中注册 server-internal 资源（`runner.server.close` / `releaseLock`）；`shutdown(reason)` 收窄为 `await registry.runAll(reason)` + resolve promise（**不调 `process.exit`**）
  - 未传入时（向后兼容，非 daemon 模式）：内部创建默认 registry，行为等价现有 shutdown 逻辑
  - 信号 handler 保持现有模式：`shutdown(reason).then(() => process.exit(0))`——exit 决策权在调用方，不在 shutdown 内部
  - `waitForShutdown()` 契约不变：shutdown promise resolve → waitForShutdown resolve
- `packages/cli/src/serve/command.ts`（重构 ~30 行）：
  - 创建 `const registry = new CleanupRegistry()`
  - **runServer 之前**注册尾部清理：`releaseLock` → `stateFile.cleanup` → `stateFile.markStopped`（LIFO 最后执行）
  - 调 `runServer({ ..., cleanupRegistry: registry })`（内部注册 `runner.server.close`）
  - **runServer 之后**注册核心资源：`clearInterval(hb)` → `deliveryStack.stop` → `channels.dispose` → `scheduler.stop` → `stateFile.markStopping`（LIFO 最先执行）
  - **彻底删除** `waitForShutdown()` 之后的重复清理块（原 L293-296 的 `scheduler.stop` / `delivery.stop` / `channels.dispose`）——消除双重清理 bug
- `packages/server/src/__tests__/cleanup-registry.test.ts`（新增 ~60 行）：
  - 注册 3 项，中间项抛错 → 其它两项仍运行
  - LIFO 顺序断言
  - 重复 runAll 幂等

**验证**：
- `cleanup-registry.test.ts` 全部通过
- `lifecycle.test.ts` baseline **零回归**
- 全量 2200+ test green
- E2E：启动 daemon → SIGTERM → 观察清理日志顺序与 M3 完成后一致

**回滚**：revert lifecycle.ts，删 cleanup-registry.ts，shutdown 行为回到 M3 完成态。

### M5 — `zhixing serve stop` 命令（1.5h）

**改动**：
- `packages/cli/src/serve/stop.ts`（新增 ~80 行）：discover → SIGTERM → 30s 轮询 `isProcessAlive` → 超时 SIGKILL + 强制 `releaseLock()` + 清理 `.ready` / `.state`
- `packages/cli/src/index.ts`（改 ~15 行）：注册 `serve stop` 子命令
- `packages/cli/src/serve/__tests__/stop.test.ts`（新增 ~60 行）：mock `isProcessAlive` 返回序列，测超时路径

**验证**：
```bash
zhixing serve --daemon
zhixing serve stop           # "Server stopped"，2s 内返回
ls ~/.zhixing/               # PID/ready/state 文件皆清
```

**回滚**：删 stop.ts，注销命令，无副作用。

### M6 — `zhixing serve status` 命令（1.5h）

**改动**：
- `packages/cli/src/serve/status.ts`（新增 ~100 行）：四态输出（running / running-unhealthy / stopped / stale）+ `--json` flag
  - `running`：PID alive + /api/health 200 + state.lastHeartbeat < 2min
  - `running-unhealthy`：PID alive + 但 health 挂 / heartbeat stale
  - `stopped`：无 PID 文件
  - `stale`：PID 文件存在 + 进程死
- `packages/cli/src/index.ts`（改 ~10 行）：注册 `serve status` 子命令

**验证**：
```bash
zhixing serve status         # stopped
zhixing serve --daemon && zhixing serve status  # running + 显示 pid/port/uptime/log
kill -9 $(cat ~/.zhixing/server.pid | jq .pid)
zhixing serve status         # stale + 提示 "Run zhixing serve to replace"
```

**回滚**：删 status.ts。

### M7 — `server.shutdown` RPC + Windows 兼容路径（2h）

> 本里程碑实现 A7 决策（Windows）。**范围从 1.5h 上调到 2h**——新增 RPC 方法 + ServerContext 扩展（审查 H5）。

**改动（RPC 新方法——跨平台受益，非 Windows 专有）**：
- `packages/server/src/rpc/methods/server.ts`（新增 ~80 行）：
  - `server.shutdown` handler：参数 `{ reason?, timeoutMs? }`，立即返回 `{ accepted, phase:"stopping", estimatedCompleteAt }`
  - 不 `await` 实际 shutdown（避免 RPC 自己被 close 切断应答链）
  - `server.info` handler（可选增强）：读 state 文件 + PID 文件返回摘要
- `packages/server/src/rpc/methods/index.ts`（改 ~5 行）：注册新命名空间
- `packages/server/src/context.ts`（改 ~10 行）：`ServerContext` 增 `requestShutdown?(reason): void` hook
- `packages/server/src/lifecycle.ts`（改 ~5 行）：`runServer` 在 `startServer()` resolve 后**同一微任务内**绑定 `ctx.requestShutdown = runner.shutdown`（无 race，见 §3.8.1）
- `packages/server/src/rpc/methods/server.ts`：handler 防御性检查 `requestShutdown` 为 null → 抛 `RpcErrors.internal("server shutdown not wired yet")`

**改动（Windows stop 降级链）**：
- `packages/cli/src/serve/stop.ts`（改 ~40 行）：`process.platform === 'win32'` 分支
  1. 尝试 RPC `server.shutdown`（15s timeout）→ 成功 → 走正常停机
  2. RPC 失败 → `execFileSync('taskkill', ['/T', '/PID', pid])` → 等 10s 轮询 `isProcessAlive`
  3. 仍存活 → `execFileSync('taskkill', ['/F', '/T', '/PID', pid])`
  4. 所有路径末尾手动 `releaseLock()` + `stateFile.cleanup()`

**测试**：
- `rpc/methods/__tests__/server.test.ts`（新增 ~80 行）：handler 立即回响 + 真实触发 shutdown
- `stop.windows.test.ts`（新增 ~50 行）：platform mock，覆盖三级降级路径

**验证**：
- POSIX：`server.shutdown` RPC 可通过 `zhixing rpc server.shutdown` 调用（跨平台统一入口）
- Windows 实机：`zhixing serve stop` 走 RPC 路径，日志出现 "Graceful stop via server.shutdown RPC"
- Windows 实机：`serve stop` 在子进程僵死时降级到 taskkill /F

**回滚**：revert rpc/methods/server.ts + stop.ts。回到 M6 完成态（无 Windows graceful 路径，但 POSIX 不受影响）。

### M8 — `zhixing serve logs` 命令（1.5h）

**改动**：
- `packages/cli/src/serve/logs.ts`（新增 ~80 行）：
  - `zhixing serve logs`：`fs.readFile` → 取最后 N 行（默认 50）
  - `zhixing serve logs --tail`：**轮询模式**（每 500ms `fs.stat`，文件变大则 `createReadStream` 增量读）
    - **不用 `fs.watch`**：Windows 上每次写入触发多次、需自己去重，行为不一致（审查 D4）
    - 轮询实现 ~30 行，跨平台行为一致
  - `--lines N` 覆盖默认 50
- `packages/cli/src/index.ts`（改 ~10 行）：注册命令
- `packages/cli/src/serve/__tests__/logs.test.ts`（新增 ~40 行）：
  - mock `fs`，测最后 N 行正确性（小于 N 行文件、空文件、UTF-8 中文）
  - 轮询模式：模拟文件增长 → 验证增量读取内容

**验证**：
```bash
zhixing serve --daemon && zhixing serve logs       # 看到启动横幅
zhixing serve logs --tail &
zhixing rpc schedule.create ...                     # 事件流实时追加
```

**回滚**：删 logs.ts。

### M9 — TD#1 修复 + E2E 验收（1h）

**改动**：
- `packages/cli/src/setup-delivery.ts`（改 1 行）：`retryable: false` → `retryable: true`
- `packages/cli/src/__tests__/setup-delivery.test.ts`（改 ~15 行）：加一条回归测试

**E2E 验收脚本**：

```bash
# 1. 基本生命周期
zhixing serve --daemon
zhixing serve status            # running
cat ~/.zhixing/server.log       # 有启动横幅
zhixing serve stop
zhixing serve status            # stopped

# 2. 启动失败反馈
nc -l 18900 &
zhixing serve --daemon          # 5s 后打印日志尾部 + exit(1)
kill %1

# 3. Stale 清理
zhixing serve --daemon
kill -9 $(jq .pid ~/.zhixing/server.pid)
zhixing serve status            # stale
zhixing serve --daemon          # 覆盖成功

# 4. 超时强杀
# 构造一个卡住的 scheduler task（flight task mock 5min sleep）
zhixing serve stop              # 打印 "Graceful timeout...SIGKILL"

# 5. TD#1 回归：飞书通道 flap 期间投递不丢
# daemon 模式启动 → 任务到期 → 手动拔 feishu token 3s 再恢复
# 日志：看到 "retrying delivery" 而非 "dropped"
```

**回滚**：TD#1 可单独 revert（setup-delivery.ts 一行改动）。

---

## 6. 工作量与依赖图

```
M1 (2.5h)  SelfExec + daemon child + handshake
   │
M2 (1h)    PID schema v2 + 静默迁移        ← 与 M1 可并行（independent modules）
   │
   └──→ 合流 ──→
          │
       M3 (2h)  ServerStateFile + 状态机 + heartbeat
          │
       M4 (2h)  Cleanup Registry + shutdown 统一出口
          │
          ┌────┴──────┐
          │           │
        M5 (1.5h)   M6 (1.5h)   ← 并行（M5 不依赖 M6，反之亦然）
          │           │
          └─────┬─────┘
                │
             M7 (2h)    server.shutdown RPC + Windows 路径
                │
             M8 (1.5h)  serve logs + 轮询 tail   ← 可并行 M7
                │
             M9 (1h)    TD#1 修复 + E2E 验收
```

**总计 ~14-15 小时**（2 工作日）。比原估算 +4h，来自：
- M1 +0.5h（SelfExec 抽象）
- M3 +0.5h（状态机 + 原子写测试）
- M4 +1h（回归基线 + 可观察性保证）
- M7 +0.5h（RPC 方法 + ServerContext 扩展）

**并行机会**（如果是两人协作）：
- M1 与 M2 独立模块，可并行（2.5h + 1h 压缩到 2.5h）
- M5 与 M6 彼此独立（stop 与 status 不耦合，共享 discovery 模块）
- M7 与 M8（Windows 路径 vs logs 命令，两个独立文件）

---

## 7. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| M1 SelfExec 在 pnpm/bundled 场景定位 entry 失败 | 中 | `--daemon` 直接抛错拒绝 | `resolveSelfExec` 抛 `UnsupportedSelfExecError`，用户看到明确提示 |
| M1 父子 readiness 在慢机误报失败 | 低 | 父 exit(1)，但子已就绪运行 | 5s 是 p99 阈值；用户可 `serve status` 二次确认 |
| M2 PID schema 迁移误判旧文件为 stale | 低 | 用户升级后一次"覆盖启动"警告 | 静默迁移策略（无 pidFileVersion 自动补 v1，不报 stale） |
| M3 状态文件原子写并发损坏 | 低 | state 文件瞬间读到空/旧内容 | tmp+rename atomic 写；reader 容忍 null |
| **M4 lifecycle 重构破坏 shutdown 顺序** | **中** | 2200+ 测试 flaky；生产遗留 PID/ready 文件 | **编码前抓 baseline；按现有顺序反序注册；独立测试对照** |
| M5/M7 Windows 强杀后文件残留 | 中 | 下次 `serve` 报 "already running" | stop 末尾手动 releaseLock + stateFile.cleanup；M6 status 报 stale 提示 |
| M7 `server.shutdown` RPC 应答链被自己切断 | 中 | RPC client 等不到 ack，误判失败 | handler 不 await 实际 shutdown，立即回 ack 后异步触发 |
| M9 TD#1 retryable:true 导致错误配置无限重试 | 低 | 队列膨胀 | Pipeline 已有 max attempts=3 + 指数退避 |

**整体回滚策略**：
- 本 spec 改动集中在 CLI 与 Server 包的**新增文件** + **扩展字段**
- **无核心 agent / delivery / outbox 改动**
- 任何里程碑出现阻塞 bug，可单独 revert 该里程碑（依赖关系保证）
- 最保守回滚：移除 `serve --daemon` 子命令，回到 Level 0 前台模式——用户体验等于当前现状

---

## 8. 架构可扩展性展望

本 spec 的抽象为未来几个阶段铺垫：

| 未来阶段 | 本 spec 已铺垫的扩展点 |
|---------|----------------------|
| **Level 2 OS 服务** | `SelfExec` 可注入 bundled binary resolver；`buildDaemonSpawnOptions` 可接 uid/gid/resource limits |
| **Step 18 Active Hours** | `ServerStateFile.extensions` 字段预留给 `channelHealth` / `activeHoursState` |
| **Step 20 远程权限确认** | `server.*` RPC namespace 可加 `server.permissionRequest` / `server.permissionResolve` |
| **S2.5 AgentOrchestrator** | `CleanupRegistry` 可扩容 background agent 清理项；`ServerStateFile.extensions` 记录 orchestrator state |
| **热配置重载** | `server.reload` RPC 方法已在 §3.8.1 占位 |

关键原则：**扩展通过组合（新文件 / 新方法）而非修改（改已有 API）实现**——本 spec 的所有核心抽象都是为此服务。
