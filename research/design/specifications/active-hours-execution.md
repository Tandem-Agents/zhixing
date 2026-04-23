# Active Hours（免打扰时段）执行规格

> **文件作用**
> 本文档是 Step 18（P2）Active Hours 的**权威细节规格**——从概念、竞品调研、架构决策、里程碑拆解到验收清单。其他文档涉及 Active Hours 时统一引用本文档，避免版本漂移。
>
> 它做三件事：
> 1. 对 Active Hours 做源码级三方调研（OpenClaw / Hermes / Claude Code）
> 2. 基于三方对比设计出比它们更优的方案
> 3. 拆解为独立可验证的渐进实现里程碑（M1-M7）
>
> **前置**：[persistent-service.md §4.6](./persistent-service.md)（顶层定位） · [implementation-roadmap.md P2](../implementation-roadmap.md)（进度） · [daemon-level-1-execution.md](./daemon-level-1-execution.md)（Step 17 基础）
> **已建基础**：[Scheduler](../../../packages/core/src/scheduler/scheduler.ts) · [TaskPriority](../../../packages/core/src/scheduler/types.ts)

---

## 0. 概念与背景

> 这一节以第一人称回答读文档时最先冒出来的 5 个基础问题。

### 0.1 Active Hours 是什么

Active Hours = **活跃时段** / 免打扰时段的反面。用户配置"每天哪几个小时我希望收到推送"（例如 08:00-22:00），其余时间为**免打扰**。免打扰时段：
- 到期的定时任务**不执行**（省 LLM 开销）
- 或执行了但**结果不立即推送**（不吵醒用户）

### 0.2 为什么 Daemon 上线后才做这个

前台 CLI 跑的时候，用户就在电脑前——不会被"推送"打扰，所以不需要 active hours。但 Step 17 Daemon 常驻后，凌晨 3 点飞书消息会震醒手机——这是"always-on 个人 Agent"的副作用，必须解决。

### 0.3 和 priority 什么关系

`TaskPriority` 已有 `low/normal/high/urgent` 四级（S1 Scheduler 已定义）。Active Hours 引入后：
- `urgent` → **穿透免打扰**，任何时段都执行 + 推送
- 其他 → 遵守免打扰

本规格 **不改 priority 类型**，只定义穿透语义。

### 0.4 和 Scheduler / Delivery Pipeline 的关系

原 [persistent-service.md §4.6](./persistent-service.md) 设计是"双层过滤"（Scheduler + Delivery）。但 **M32 Faithful Delivery 契约** 已明文废弃 Delivery 层 filter 机制——Pipeline 只负责忠实送达，业务策略在上游处理。

**本规格的决定**：**只在 Scheduler 层过滤**（单点）。Scheduler 层判定：
- 非 urgent 任务在免打扰时段 → **推迟**到活跃时段开始（不丢弃，修复 OpenClaw 缺陷）
- urgent 任务 → 直接执行

### 0.5 不做什么

- ❌ **不做 per-channel active hours**（不同通道不同时段，复杂度高，Level 1 全局一组够用，TD 跟踪）
- ❌ **不做 per-task active hours 字段覆盖**（用 priority=urgent 表达"穿透"意图已足）
- ❌ **不做自动补跑**（cron task 深夜错过的 tick 不会补跑，符合 OpenClaw 行为，避免"积攒一堆突然爆发"的体验灾难）
- ❌ **不做 Agent [SILENT] 标记**（那是独立的内容级抑制机制，非时段问题；未来可以独立加）

---

## 1. 竞品调研

### 1.1 三方设计哲学对比

| 维度 | OpenClaw | Hermes | Claude Code |
|------|---------|--------|-------------|
| **是否实现 Active Hours** | ✅ 有（heartbeat 级） | ❌ 根本没有 | ❌ 单进程 CLI 不需要 |
| **配置模型** | 全局 + per-agent 两级继承 | 无 | 无 |
| **时区** | user / local / IANA 三层降级 | zoneinfo（现代 Python）| 本地时区 + UTC（Remote Trigger） |
| **跨午夜** | ✅ 明确支持（22:00-06:00） | N/A | N/A |
| **判定层级** | 单点（heartbeat 开始） | 无（内容级 `[SILENT]` 抑制） | N/A |
| **Urgent 穿透** | ❌ 无 | ❌ 无 | N/A |
| **Deferred 任务** | ❌ **直接 skip 不推迟** | ❌ 只有手动 pause | N/A |
| **活跃开始惊群** | ❌ 无错峰 | ❌ 60s tick 集中爆发 | ✅ **Jitter 动态分散** |
| **热更新** | ✅ `updateConfig()` | ✅ 无缓存 | ✅ GrowthBook 动态 |
| **核心文件** | `heartbeat-active-hours.ts`<br>`heartbeat-runner.ts:558` | `cron/scheduler.py:931-933`<br>（仅 SILENT） | `cronJitterConfig.ts`<br>（仅 jitter）|

### 1.2 各自的精彩与短板

**OpenClaw** —— 唯一完整实现，但几个关键缺陷
- ✅ 配置二级继承（global + per-agent），fail-safe 容错
- ✅ 时区处理完善：user/local/IANA 三层降级，**跨午夜正确实现**（`>= start OR < end`）
- ✅ 热更新：`updateConfig()` 无需重启
- ✅ 测试密度高：时间注入 + 多时区场景
- ❌ **无 urgent 穿透**：紧急告警被无条件阻止
- ❌ **直接 skip 不推迟**：免打扰期间到期的 heartbeat 被丢弃，下周期重评——**信息丢失**
- ❌ **无错峰**：一旦到活跃时段，若有大量 deferred 任务会同时爆发
- ❌ **粒度不足**：仅 heartbeat 级，per-task / per-channel 都没有

**Hermes** —— 刻意不做
- ✅ **时区基础设施领先**：`zoneinfo`（Python 3.9+ 标准）
- ✅ **Agent 主观能动**：`[SILENT]` 标记让 Agent 自己判断"现在该不该报"（plus：可以理解业务上下文）
- ❌ **无企业级控制**：无法禁止某时段所有通知
- ❌ **无优先级穿透**
- ❌ **被动而非主动**：依赖 Agent 理解时段（容易遗漏）
- ❌ **60s tick 集中爆发**：大量 deferred 任务惊群

**Claude Code** —— 不需要但给了启发
- ✅ **Cron Jitter 动态配置**（`cronJitterConfig.ts`）：避免"所有客户端在 `:00` 整点同时触发"的 load shedding 思路，完美适用于"活跃时段开始"惊群问题
- ✅ **通知节流**（`useNotifyAfterTimeout.ts`）：6 秒用户 idle 才推送——不是时段，但"不打扰用户"的实时判断
- ❌ **不是本问题的答案**：单进程 CLI 不持久运行，没有"跨时段"概念

### 1.3 知行 Step 18 的超越点

| 维度 | 知行选择 | 对比原因 |
|------|----------|---------|
| 判定层级 | **Scheduler 层单点**（继承 OpenClaw 架构） | M32 Faithful Delivery 否决 Delivery 层 filter；单点过滤一致性好 |
| 配置模型 | **全局 ActiveHoursConfig** | Level 1 够用；per-channel TD 延后 |
| 时区处理 | **Node 原生 `Intl.DateTimeFormat`**（借鉴 Claude Code 的 lightweight 思路） | 零依赖、跨平台；不需要 luxon/date-fns-tz |
| 跨午夜 | **`>= start OR < end`**（从 OpenClaw 抄正确实现） | 已被 OpenClaw 实战验证 |
| Urgent 穿透 | **`priority === "urgent"` 直接执行** + **ScheduleTool 限制 AI 自动设 urgent** | 填补 OpenClaw 无穿透的缺陷；防止 AI 滥用 |
| Deferred 语义 | **推迟到活跃时段开始（不丢弃）**，记录 `deferredFromRun` | 修复 OpenClaw "直接 skip 丢信息"的缺陷 |
| 错峰机制 | **Jitter 分散**：deferred task 的 new nextRunAt = `activeStart + random(0, jitterMs)` | **借鉴 Claude Code** 的 CronJitterConfig，解决"活跃时段开始惊群" |
| 热更新 | **RPC `schedule.activeHours.update` + Scheduler rearm** | 借鉴 OpenClaw，但走 RPC 而非文件监听（Daemon 架构下更自然） |
| 状态可观察 | **`serve status` 显示当前 active/quiet** + **`schedule list` 显示 deferred 标记** | 超越三方——用户第一次能看见"为什么任务没执行" |
| Priority 排序 | **TimerLoop 已按 PRIORITY_WEIGHT DESC 排序**（[timer-loop.ts:106-108](../../../packages/core/src/scheduler/timer-loop.ts)），handleDueTasks 继承此顺序 | 既有实现已满足需求；两阶段 defer 流程依赖此预排序——urgent 先遍历、先穿透 |

---

## 2. 范围与非范围

### 2.1 P2 本规格覆盖

| 能力 | 产出 |
|------|------|
| `ActiveHoursConfig` 全局配置 | Scheduler 层判定 + 热更新 |
| `ActiveHoursEvaluator` 纯函数抽象 | 时区 + 跨午夜判定，可独立测试 |
| Urgent 穿透 | `priority === "urgent"` 无视免打扰 |
| Deferred 任务 | 非 urgent 任务在免打扰时段推迟到 `activeStart + jitter` |
| Jitter 错峰 | 默认 `jitterWindowMs = 5 * 60_000`（5 分钟）|
| Priority 排序 | TimerLoop 已实现（[timer-loop.ts:106](../../../packages/core/src/scheduler/timer-loop.ts)），两阶段 defer 依赖此预排序 |
| RPC 热更新 | `schedule.activeHours.get` / `schedule.activeHours.update` |
| EventBus 事件 | `scheduler:task-deferred-quiet-hours` / `scheduler:active-hours-changed` |
| UX 可观察 | `serve status` / `schedule list` 显示当前时段状态 |

### 2.2 延后（TD 跟踪）

- Per-channel active hours（工作群 vs 私人群不同时段）
- Per-task active hours 覆盖字段（用 priority=urgent 已够表达，但未来可加 `task.activeHoursOverride`）
- Agent 级 `[SILENT]` 标记（内容级抑制，独立于时段）
- 积攒补跑（**cron 表达式深夜每一次 tick 不会被积攒成活跃时段一次性触发多次**——与 OpenClaw 一致，避免"攒了一批突然爆发"的体验灾难）
- 临时打破免打扰命令（如 `zhixing serve pause-active-hours --duration 30m`）——可通过 `rpc schedule.activeHours.update --arg enabled=false` 实现，不本阶段做

### 2.2.1 Missed task 追赶的语义（澄清）

Scheduler 现有 missed task 追赶机制（start 时扫描 `nextRunAt < now` 的任务）在 Active Hours 下：

- **仍会被追赶**（不跳过）
- **追赶时若落免打扰 → 也会被 defer 到活跃时段**（Active Hours 过滤对 missed task 同样生效）
- **单个 task 只有一个 nextRunAt**，所以"深夜错过 3 次 tick"不会变成"活跃时段连跑 3 次"——只跑 1 次（这就是上面说的"不积攒补跑"）

### 2.3 依赖既有能力

P2 复用而非重建：
- **TaskPriority 类型** — [types.ts:13](../../../packages/core/src/scheduler/types.ts)（已有 low/normal/high/urgent）
- **PRIORITY_WEIGHT** — [types.ts:18](../../../packages/core/src/scheduler/types.ts)（已在 [timer-loop.ts:106](../../../packages/core/src/scheduler/timer-loop.ts) 使用）
- **Scheduler.handleDueTasks** — [scheduler.ts:308](../../../packages/core/src/scheduler/scheduler.ts)（扩展判定点）
- **TaskState.nextRunAt** — [types.ts:66](../../../packages/core/src/scheduler/types.ts)（defer 写这个字段）
- **SchedulerEventMap** — 新事件
- **Daemon 常驻** — Step 17 完成

---

## 3. 架构决策

### 3.1 判定流程（两阶段：defer 先于 concurrency slicing）

**核心原则**：defer **不占** `activeTasks` 并发额度。先过滤出 defer 候选（免打扰 + 非 urgent），剩余才走 slice(0, available) 执行。这样避免"3 个 high 全被 defer 浪费 tick"的问题。

```
TimerLoop tick
  │  dueTasks 已按 PRIORITY_WEIGHT DESC 排序（timer-loop.ts:106-108）
  ▼
Scheduler.handleDueTasks(dueTasks)    ← 输入已排序，不再重复排序
  │
  ├── 阶段 1: Defer 过滤（不占并发槽）
  │     └── 对每个 task 评估：
  │            cfg?.enabled && evaluate(now).state === "quiet"
  │            && task.priority !== "urgent"
  │            && !activeTasks.has(t.id)
  │         ├── 是 → defer（不加入 activeTasks）
  │         │      ├── newNextRunAt = nextActiveStart + random(0, jitterMs)
  │         │      ├── task.state.deferredFromRun = <original-nextRunAt>
  │         │      ├── task.state.nextRunAt = newNextRunAt
  │         │      ├── store.updateTask (持久化)
  │         │      └── eventBus.emit("scheduler:task-deferred-quiet-hours", {...})
  │         └── 否 → 进入阶段 2 候选集
  │
  └── 阶段 2: 执行 slicing
        │
        ├── 取 maxConcurrent - activeTasks.size 个（候选已排序，urgent 先入队）
        │
        └── 对每个入选 task：executeSingleTask（走现有路径，占 activeTasks）
```

**不变量**：
- 一个 task 同 tick 只会走 defer **或** execute 中的一条（决策互斥）
- 被 deferred 的 task 不加入 `activeTasks` → 并发槽可被其他 task（含同 tick 到期的 urgent）使用
- 阶段 1 的持久化/事件失败不影响阶段 2（Promise.allSettled 隔离失败）

### 3.2 ActiveHoursEvaluator 接口

**文件**：`packages/core/src/scheduler/active-hours.ts`（新增）

```typescript
export interface ActiveHoursConfig {
  /** 开关（默认 false——不影响任何行为） */
  enabled: boolean;
  /** "HH:MM"（24h 制），inclusive */
  start: string;
  /** "HH:MM"，exclusive（允许 "24:00" 表示到第二天 00:00）*/
  end: string;
  /** IANA 时区，默认系统时区。invalid 会 fallback 到系统时区 */
  timezone?: string;
  /** Deferred 任务的 jitter 窗口（ms），默认 300_000（5 分钟），设 0 禁用 */
  jitterWindowMs?: number;
}

export type ActiveHoursState = "active" | "quiet" | "disabled";

export interface ActiveHoursEvaluation {
  state: ActiveHoursState;
  /** 当前时区解析后的本地时间（调试用） */
  localTime?: string;
  /** quiet 态下，下一个 active window 的开始时间（用于 defer） */
  nextActiveStart?: Date;
}

export interface ActiveHoursEvaluator {
  /** 判定当前时刻是 active 还是 quiet */
  evaluate(now: Date, cfg: ActiveHoursConfig): ActiveHoursEvaluation;
  /**
   * 从 `now` 起计算 deferred 任务的 nextRunAt（含 jitter）。
   * 注意：第一参数是当前时刻 `now`，**不是** `originalNextRunAt`——
   * originalNextRunAt 仅在 Scheduler 侧写入 `task.state.deferredFromRun` 记账，
   * 不参与算法（防止 missed-task 追赶时算到过去时间导致活锁，详见 §3.5）。
   */
  computeDeferredNextRunAt(
    now: Date,
    cfg: ActiveHoursConfig,
    rng?: () => number,  // 测试注入
  ): Date;
}

export function createActiveHoursEvaluator(): ActiveHoursEvaluator;
```

**设计原则**：
- **纯函数**：`evaluate` / `computeDeferredNextRunAt` 都是纯函数——给定 (now/rng, cfg) 返回确定值，无副作用
- **Fail-safe**：任何异常（非法 timezone / 非法 HH:MM / 跨时区 DST）都 **fallback 到 active**（宁可吵用户不可漏事）
- **无 I/O**：不读 config 文件，不发事件，只做时刻判定
- **无状态单例**：多次 `createActiveHoursEvaluator()` 返回等价实例

**所有权与 DI 策略**（Scheduler 集成）：

`SchedulerDeps` 定义位于 [scheduler.ts:40](../../../packages/core/src/scheduler/scheduler.ts#L40)（**不是 types.ts**）。扩展如下：

```typescript
// packages/core/src/scheduler/scheduler.ts
export interface SchedulerDeps {
  // ... 原有字段
  /** 可选：仅测试场景覆盖默认 evaluator。生产不传，Scheduler 内部 createActiveHoursEvaluator() */
  activeHoursEvaluator?: ActiveHoursEvaluator;
}
```

- **生产路径**：调用方**只配 `config.activeHours`**（数据），Scheduler 内部 `this.evaluator = deps.activeHoursEvaluator ?? createActiveHoursEvaluator()`
- **测试路径**：注入 mock evaluator 断言 interaction，或注入 fake clock 验证时段判定
- **避免冗余**：不让调用方同时传 evaluator 和 config——config 是数据真源，evaluator 是纯函数消费者

### 3.3 跨午夜判定（抄 OpenClaw 正确实现）

```typescript
// active-hours.ts 核心判定
const startMin = parseHHMM(cfg.start);  // 08:00 → 480
const endMin = parseHHMM(cfg.end);      // 22:00 → 1320
const currentMin = getMinutesInTZ(now, cfg.timezone);

if (endMin > startMin) {
  // 正常窗口：08:00-22:00
  return currentMin >= startMin && currentMin < endMin ? "active" : "quiet";
}
// 跨午夜：22:00-06:00
return currentMin >= startMin || currentMin < endMin ? "active" : "quiet";
```

**边界**：`start === end` 视为 "配置错误" → fallback 到 active（fail-safe）。

### 3.4 时区处理（Node 原生）

```typescript
function getMinutesInTZ(date: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    // 非法 tz → 回退系统时区
    return date.getHours() * 60 + date.getMinutes();
  }
}
```

**优点**：零依赖，`Intl` 在 Node 16+ 稳定支持。
**劣势**：没有 DST 过渡点的精细处理（如 `02:30` 可能被跳过）——但 Level 1 个人工具，这种罕见情况降级到 active 可接受。

### 3.5 Deferred 任务的 nextRunAt 计算

**参数语义**：defer 的起点是 `now`（当前 tick 时间），**不是** `originalNextRunAt`。
- `originalNextRunAt` 只用来写 `task.state.deferredFromRun`（给 UX 看"从哪个时间被推后"的记账）
- 算法输入必须是 `now` —— 否则 missed-task 场景（`originalNextRunAt` 远在过去且刚好落在历史 active 窗口）会算出"过去时间 + jitter"，任务依旧被视作 due，下个 tick 再 defer，活锁直到真的进入 08:00 active 态

```typescript
// 纯算法：从 now 起找"下一个 active 起点 + jitter"
computeDeferredNextRunAt(now: Date, cfg: ActiveHoursConfig, rng = Math.random): Date {
  const nextActive = findNextActiveStart(now, cfg);
  const jitterMs = Math.floor(rng() * (cfg.jitterWindowMs ?? 300_000));
  return new Date(nextActive.getTime() + jitterMs);
}

// Scheduler.handleDueTasks 调用点（M3）
const originalAt = task.state.nextRunAt;                                  // 仅记账
task.state.deferredFromRun = originalAt;
task.state.nextRunAt = evaluator.computeDeferredNextRunAt(now, cfg).toISOString();
```

#### 3.5.1 `findNextActiveStart` 算法

核心职责：给定起点 `from`（**Scheduler 侧传入 `now`**），返回**下一次 active 窗口的起点**（一个绝对时刻 Date）。

```typescript
function findNextActiveStart(from: Date, cfg: ActiveHoursConfig): Date {
  // 防御：若当前已 active，不应调用到这里——但返回 `from` 自身保证幂等
  if (evaluate(from, cfg).state === "active") return from;

  // 算法：在 [from, from + 48h] 范围内，以 1 分钟步长找第一个 active 时刻
  //      （48h 上限足以覆盖任何跨午夜/DST 场景，且开销极低——最多 2880 次计算）
  const endBoundary = new Date(from.getTime() + 48 * 60 * 60 * 1000);
  let cursor = new Date(from.getTime());
  while (cursor < endBoundary) {
    // 每分钟递增，检查是否刚进入 active 态
    cursor = new Date(cursor.getTime() + 60 * 1000);
    if (evaluate(cursor, cfg).state === "active") {
      // 对齐到分钟边界（去掉秒/毫秒）让 defer 时刻干净
      cursor.setSeconds(0, 0);
      return cursor;
    }
  }
  // 48h 内找不到 active 窗口 → 配置错（start===end 或类似），fail-safe 返回 from（让 task 尽快执行）
  return from;
}
```

**为什么用 "步进 + evaluate" 而不是"直接构造 Date"**：
- 避免跨时区 DST / 夏令时的日期运算陷阱（`new Date(Y, M, D, 8, 0)` 在 DST 过渡日有歧义）
- 复用同一个 `evaluate` 函数——判定逻辑单一来源
- 1 分钟步长足够精细（用户不会配"08:00:30" 这种秒级精度）

**性能预算**：单次 defer 最坏 2880 次 `Intl.DateTimeFormat` 调用 ≈ 3ms（Node 20 实测）。个人 agent 场景（并发 defer ≤ 10）完全可接受。若未来场景压力变大（并发 defer ≫ 10），优化方向是缓存 `getMinutesInTZ(now, tz)` 的结果按分钟键复用（不在本阶段）。

**边界 case**：
- 当前 quiet，活跃时段今晚 22:00 开始（跨午夜）→ 返回今晚 22:00
- 当前 quiet（活跃 08:00-22:00 今早 07:58）→ 返回今早 08:00
- 当前在 quiet 连续跨 2 天（少见，比如 start === end 配置错）→ 48h 内无 active → 返回 from
- 当前 active（调用方 bug）→ 返回 from（幂等）

**关键语义**：
- **不修改** task 的 schedule（cron 表达式 / interval 参数不变）
- **只改** `task.state.nextRunAt`
- 下次 fire 完，Scheduler 按正常逻辑算下下次 → 如果仍落免打扰 → 再 defer
- 这保证"cron 表达式的语义不被 Active Hours 污染"——用户查看 schedule 仍是原定义

### 3.6 Priority 排序（确认既有实现）

**现状**：[timer-loop.ts:106-108](../../../packages/core/src/scheduler/timer-loop.ts) 已在 `doTick()` 中按 `PRIORITY_WEIGHT` DESC 排序 dueTasks，然后传给 `handleDueTasks(dueTasks)`。`handleDueTasks` 内部的 `.filter()` 和 `.slice()` 保持此顺序——urgent/high 自然排在前面。

**结论**：**无需修改 `handleDueTasks` 排序逻辑**。两阶段 defer 流（§3.1）直接依赖 TimerLoop 的预排序：
- 阶段 1 遍历时 urgent 先遇到、直接跳过 defer → 进入阶段 2 候选
- 阶段 2 `slice(0, available)` 从排序后列表截取 → urgent 优先获得并发槽

**前序审查误判说明**：早期审查（Round 2）误判"PRIORITY_WEIGHT 已定义但未使用"，实际 S1 TimerLoop 实现时已集成排序。Round 9 交叉验证源码后纠正。

### 3.7 配置来源与热更新

#### 3.7.1 启动时加载

config 从 `zhixing.config.json` 里读（`loadConfig()` 已有机制）：

```jsonc
{
  "scheduler": {
    "maxConcurrent": 3,
    "activeHours": {
      "enabled": true,
      "start": "08:00",
      "end": "22:00",
      "timezone": "Asia/Shanghai",
      "jitterWindowMs": 300000
    }
  }
}
```

Scheduler 启动时从 config 读 activeHours，传入 ActiveHoursEvaluator。

#### 3.7.2 运行时热更新（RPC）+ 持久化

**RPC 命名空间决策**：ActiveHours 是 Scheduler 域的运行时配置，沿用现有 `schedule.*` 命名空间（与 `schedule.create/update/list` 并列），**不引入 `config.*` 命名空间**。理由：
- 现有 RPC 注册器（[methods/index.ts](../../../packages/server/src/rpc/methods/index.ts)）按**数据所有者**分命名空间（session / schedule / server / auth / health）
- ActiveHours 的所有者是 Scheduler，不是抽象的 "config"
- 未来若有跨域 runtime config 需要统一入口，再引入 `config.*`（parallel，不冲突）

新增 RPC 方法（注册到 `buildBuiltinRegistry`）：

| 方法 | requiresAuth | 语义 |
|------|--------------|------|
| `schedule.activeHours.get` | ✅ | 返回当前 ActiveHoursConfig |
| `schedule.activeHours.update` | ✅ | 更新 config + 立即生效 + rearm timer + **写 override 文件** |

**热更新语义**：
- **入参 schema 校验**（非法 HH:MM / 非法 timezone 立即返回 `RpcErrors.invalidParams`，磁盘/内存/事件均不动）
- **写入顺序：disk-first, memory-second**（F2 架构决策）—— 磁盘是真源，内存派生：
  1. 先 `configOverrideWriter.writePatch` 落盘
  2. 落盘失败 → 抛 `RpcErrors.internal`，**不改内存、不 emit**（崩溃重启后行为一致）
  3. 落盘成功 → 调 `Scheduler.updateActiveHours` 改内存
- 改内存后立即生效（下一次 tick 就用新 config；TimerLoop.rearm 触发）
- **不回滚**已 deferred 的 task（保持原 deferred 时间；用户希望"现在就跑"可 `schedule run <id>`）
- **Scheduler.updateActiveHours 内部 emit** `scheduler:active-hours-changed` 事件（RPC handler 只调方法，不碰 bus；避免 handler 依赖 schedulerEventBus 引用）

**持久化策略（A15 决策）**：**写用户级 override 文件**而非源 config。

```
源 config:       ./zhixing.config.json          ← 可能 git 管理、团队/示例，不写
全局 config:     ~/.zhixing/config.json         ← 用户全局默认，不写
用户 override:   ~/.zhixing/config.override.json ← daemon 写这里，与 server.pid/token 同级
```

**loadConfig 合并顺序**（改动 `@zhixing/providers/config-loader.ts`）：

当前实现 [config-loader.ts:83](../../../packages/providers/src/config-loader.ts#L83)：`deepMergeConfig(globalConfig, projectConfig)` —— 优先级 **项目 > 全局**。

**M2 改为三层**（低 → 高优先级）：

```
全局 config (~/.zhixing/config.json)
    ↓ 被项目覆盖
项目 config (./zhixing.config.json)
    ↓ 被 override 覆盖
用户 override (~/.zhixing/config.override.json)   ← 新增一层，最高优先级
```

代码实现等价：`deepMergeConfig(deepMergeConfig(global, project), override)`。

**为什么 override 在最顶层**：
- 源 config / 项目 config 可能在 git 里（团队示例），daemon 改 runtime 设置不应污染版本库
- Override 文件专属**用户本机**的 daemon 运行时调整（与 `server.token` / channel credentials 同理，都在 `~/.zhixing/` 下）
- 重启后 override 被读取，**行为连续**——用户配的一直在生效

**新抽象**：`ConfigOverrideWriter`（`packages/providers/src/config-override.ts`）

```typescript
export interface ConfigOverrideWriter {
  /** 读当前 override 文件。不存在或损坏均返回 null（不区分——损坏场景等同于"从零开始"） */
  read(): Promise<Partial<ZhixingConfig> | null>;
  /** 合并写入 override——deep merge 现有内容，原子写（tmp + rename） */
  writePatch(patch: Partial<ZhixingConfig>): Promise<void>;
  /** 删字段（set null 视为重置到默认） */
  clearPath(dottedPath: string): Promise<void>;
}

export function createConfigOverrideWriter(path?: string): ConfigOverrideWriter;
```

**writePatch 行为定义**（补齐 Issue 8）：
- 输入 `{ scheduler: { activeHours: {...} } }` → 只更新该路径，不动其他字段
- 原子写（tmp + rename）——避免并发写撕裂（参考 ServerStateFile）
- 并发调用串行化（内部 promise chain，同 ServerStateFile）
- **面对损坏的 override 文件**：`read()` 返回 null → writePatch 按空对象 `{}` 为 base 合并 patch 写入 —— **不尝试保留损坏内容**（损坏即失去信任，用户可从损坏文件 backup 手动恢复）
- 失败抛错，RPC 返回 `RpcErrors.internal`（用户重试）

**Override 文件生命周期**：
- 创建：首次 `schedule.activeHours.update` RPC 调用
- 清理：用户手动删除文件；本 Level 不做 `zhixing config reset` CLI 命令（TD）
- daemon stop / crash 不影响 override（它是独立文件）

### 3.8 UX 可观察性

#### 3.8.1 `serve status` 扩展（UX 文案友好化）

**人类可读模式**（给普通用户）：

```
  ● running
    pid:       12096
    port:      18900
    phase:     running
    免打扰:    活跃 (08:00-22:00 Asia/Shanghai)           ← enabled + active
    # 或
    免打扰:    免打扰中 (将于 08:00 Asia/Shanghai 恢复推送)   ← enabled + quiet
    # 或（未启用不显示本行）
```

**JSON 模式**（给脚本/外部工具）：

```json
{
  "status": "running",
  "activeHours": {
    "enabled": true,
    "state": "quiet",
    "window": "08:00-22:00",
    "timezone": "Asia/Shanghai",
    "nextActiveStart": "2026-04-23T00:00:00+08:00",
    "localTime": "02:30"
  }
}
```

**设计决策**：
- 人类输出用**中文**（"免打扰中"比 `quiet` 直观，与知行整体中文语境一致）
- JSON 保留英文 `state` 字段（机器友好）
- 同时显示 window + timezone，让用户确认"生效的配置"——防 Issue "配错没发现"

#### 3.8.2 `schedule list` 扩展

Deferred task 标记：

```
  ● daily-report  (cron 每天 22:30)  next: 08:00 (免打扰推迟自 22:30)
```

deferred 任务的 "原计划时间"（`deferredFromRun`）明文显示，用户一眼看出"为什么没跑"。

### 3.9 事件模型

新增两条 `SchedulerEventMap`（定义在 [events.ts](../../../packages/core/src/scheduler/events.ts)）：

```typescript
"scheduler:task-deferred-quiet-hours": {
  taskId: string;
  name: string;
  originalNextRunAt: string;
  newNextRunAt: string;
  reason: "quiet-hours";
};

"scheduler:active-hours-changed": {
  previous: ActiveHoursConfig;
  current: ActiveHoursConfig;
};
```

**事件 → RPC 通知 映射**（event-bridge 转发）：

| SchedulerEventMap 内部事件 | event-bridge 转发为 RPC 通知 |
|---------------------------|------------------------------|
| `scheduler:task-deferred-quiet-hours` | `schedule.deferred` |
| `scheduler:active-hours-changed` | `schedule.activeHoursChanged` |

与现有 mapping 风格一致（`scheduler:task-started` → `schedule.started`、`scheduler:task-completed` → `schedule.completed`）——**RPC 通知也走 `schedule.*` 命名空间**，不引入 `config.*`。

**重要：事件订阅是显式白名单**。[event-bridge.ts](../../../packages/server/src/rpc/event-bridge.ts) 逐条 `bus.on(...)`，新事件不会被自动转发。对应里程碑必须修改 event-bridge.ts：

- M3（加 `task-deferred-quiet-hours`）→ 加 `bus.on("scheduler:task-deferred-quiet-hours", ...)` 转发为 `schedule.deferred`
- M5（加 `active-hours-changed`）→ 加 `bus.on("scheduler:active-hours-changed", ...)` 转发为 `schedule.activeHoursChanged`

不加对应订阅，外部工具（CLI `zhixing rpc --watch`、Web UI）**收不到**这些事件。

### 3.10 Urgent 穿透的防滥用（防线精确化）

**问题**：AI 自主创建或修改任务时设 `priority: "urgent"` 会让"免打扰 AI 绕开免打扰"。

**防线边界**（A16 决策）：

| 调用路径 | priority 字段 | 原因 |
|---------|--------------|------|
| **ScheduleTool**（AI tool call） | **不暴露**（硬编码 `normal`） | LLM 自主行为，不可信 |
| **RPC `schedule.create/update`** | **暴露**（用户可设 urgent） | 授信路径（CLI/UI 有 auth token） |
| 未来 S2.5 AgentOrchestrator | TBD（届时再定） | 本阶段不涉及 |

**实现定位（修正 Issue 7）**：ScheduleTool **只有一个 `inputSchema`**（[schedule.ts:70](../../../packages/tools-builtin/src/schedule.ts#L70)），create/update 共用同一 schema，用 `action` 字段 switch。所以修改不是"分别改 create schema / update schema"，而是：

1. **从唯一 `inputSchema.properties` 删除 `priority` 字段**（create + update 都失去 AI 可见性）
2. **`handleCreate`** ([schedule.ts:198](../../../packages/tools-builtin/src/schedule.ts#L198))：硬编码 `priority: "normal"`，忽略任何传入
3. **`handleUpdate`** ([schedule.ts:238](../../../packages/tools-builtin/src/schedule.ts#L238))：**显式 drop `input.priority`**（即使有也不进 patch）—— 修原漏洞
4. Tool 顶层 description 加一句："priority 由用户通过 CLI/UI 设置，AI 无权调整"
5. RPC 侧 `schedule.create/update` handler 的 priority 参数**保留**——那是授信用户路径

**为什么 RPC 保留 priority**：
- 用户通过 `zhixing rpc schedule.create --priority urgent` 是显式意图
- RPC 层有 auth token 校验（未认证拒绝），防止被恶意调用
- 若 RPC 也删 priority，用户就**没办法**创建 urgent 任务——功能丧失

---

## 4. 核心决策（决议汇总）

| # | 决策 | 选择 | 出处 |
|---|------|------|------|
| A1 | 判定层级 | **Scheduler 层单点** | M32 Faithful Delivery 否决 Delivery 层；OpenClaw 架构 |
| A2 | 配置粒度 | **全局 ActiveHoursConfig** | 起步简化；per-channel / per-task 延后 |
| A3 | 时区处理 | **Node 原生 `Intl.DateTimeFormat` + fallback 链** | 零依赖；Claude Code 思路 |
| A4 | 跨午夜 | **`>= start OR < end`** | 抄 OpenClaw 正确实现 |
| A5 | Fail-safe 方向 | **异常降级到 active**（宁可吵用户不漏事） | OpenClaw 思路 |
| A6 | Urgent 穿透 | **`priority === "urgent"` 直接执行** | 填补 OpenClaw 空白 |
| A7 | Urgent 防滥用 | **ScheduleTool 不暴露 priority 给 AI** | 知行独创 |
| A8 | Deferred 策略 | **推迟到活跃时段开始（不丢弃）**，记录 `deferredFromRun` | 修复 OpenClaw 信息丢失 |
| A9 | 惊群错峰 | **Jitter：`activeStart + random(0, 5min)`** | 借鉴 Claude Code CronJitterConfig |
| A10 | Cron task 补跑 | **不补跑** | 与 OpenClaw 一致；避免"积攒一批突然爆发" |
| A11 | 热更新 | **RPC `schedule.activeHours.update` + Scheduler.updateActiveHours 内部 emit + rearm timer** | OpenClaw updateConfig + RPC 化 + 沿用 `schedule.*` 命名空间 |
| A12 | Priority 排序 | **确认 TimerLoop 已按 PRIORITY_WEIGHT 排序**（[timer-loop.ts:106](../../../packages/core/src/scheduler/timer-loop.ts)），handleDueTasks 依赖此预排序，不重复排序 | S1 已实现；Round 9 交叉验证纠正前序误判 |
| A13 | 配置来源 | **`zhixing.config.json` + RPC 热更新 + `~/.zhixing/config.override.json` 持久化** | 与现有 config 架构一致；override 与 channel credentials 同目录 |
| A14 | Evaluator 抽象 | **纯函数 + Scheduler 内部构造；仅测试可 DI 覆盖** | 避免"同时传 config 和 evaluator"的冗余；config 是数据真源 |
| **A15** | **热更新持久化** | **写 `~/.zhixing/config.override.json`**，源 config 不动 | 源 config 可能 git 管理；override 是用户本机 runtime 调整，重启后仍生效 |
| **A16** | **Urgent 防滥用边界** | **Tool 层（AI）移除 priority**（单一 inputSchema 里删除，create+update 都失去暴露）；**RPC 层（授信用户）保留** | LLM 自主不可信；RPC 有 auth token 校验可信 |
| **A17** | **Defer 并发槽语义** | **Defer 不占 `activeTasks` slot**：先过滤 defer 候选，剩余才走 slice(0, available) 执行 | 避免"3 个 high 全被 defer 浪费 tick"——同 tick 到期的 urgent 仍可填入空闲槽 |
| **A18** | **RPC 命名空间** | **ActiveHours 走 `schedule.*` 命名空间**（`schedule.activeHours.get/update` + 通知 `schedule.activeHoursChanged` / `schedule.deferred`） | 与现有 `session.* / schedule.* / server.*` 按数据所有者分命名空间一致；不引入 `config.*` |
| **A19** | **ZhixingConfig↔SchedulerConfig 桥接** | **CLI/Server wiring 层**从 `zhixingConfig.scheduler` 提取字段，传入 `new Scheduler({ config: { activeHours, maxConcurrent } })` | 保持 `@zhixing/core` 不依赖 `@zhixing/providers`；types 分离，wiring 在 server/cli 层组合 |
| **A20** | **热更新写入顺序** | **disk-first, memory-second**：RPC update 先 `writePatch` 落盘，失败即返回错误不改内存；落盘成功后才改 Scheduler 内部 config 并 emit | 磁盘是真源，内存派生；避免 memory-first 下"磁盘写失败+daemon 崩溃"导致重启后行为倒退；与 ServerStateFile 同模式 |
| **A21** | **defer 算法参数** | `computeDeferredNextRunAt(now, cfg)` 第一参数是 `now`，不是 `originalNextRunAt`；`originalNextRunAt` 只用来写 `deferredFromRun` 记账 | 避免 missed-task 追赶场景下"从过去时间扫起→返回过去时间→下 tick 再 defer"的活锁（F1 回归守卫在 M1 测试中） |

---

## 5. 渐进实现（7 个独立可验证里程碑）

设计原则：**每个里程碑独立可 merge、可验证、可回滚**。M1-M7 总计 ~9 工作小时（v3 修订——M2 纳入 wiring 桥接从 1h 调到 1.5h；其余不变）。

### M1 — ActiveHoursEvaluator 纯函数 + Jitter 默认值（1.5h）

> 本里程碑实现 A3 / A4 / A5 / A9 / A14 五项决策（Jitter 并入本里程碑）。

**改动**：
- `packages/core/src/scheduler/active-hours.ts`（新增 ~180 行）：
  - `ActiveHoursConfig` / `ActiveHoursState` / `ActiveHoursEvaluation` 类型
  - `createActiveHoursEvaluator()` 工厂
  - `evaluate(now, cfg)` 判定（跨午夜 + 时区）
  - **`computeDeferredNextRunAt(now, cfg, rng?)`** —— 第一参数是 `now`，不是 `originalNextRunAt`（§3.5 语义说明；默认 `jitterWindowMs = 300_000`）
  - `findNextActiveStart(from, cfg)` 私有工具（算法见 §3.5.1，1 分钟步长扫描 48h）
  - `parseHHMM` / `getMinutesInTZ` 私有工具
  - 完整 fail-safe（非法 tz / 非法 HH:MM / enabled=false / start===end 全返 active）
- **`packages/core/src/scheduler/index.ts`（改 ~3 行）**：补 `export * from "./active-hours.js"`（遵循现有约定——scheduler 域 export 统一走 `scheduler/index.ts`，`core/src/index.ts` 只做包级 barrel re-export `./scheduler/index.js`）—— 让 `@zhixing/providers` 能 `import type { ActiveHoursConfig } from "@zhixing/core"`（M2 用）
- `packages/core/src/scheduler/__tests__/active-hours.test.ts`（新增 ~200 行）：
  - `enabled: false` → 永远 active
  - 正常窗口 08:00-22:00：边界、中间、外部
  - 跨午夜 22:00-06:00：午夜附近、边界
  - 多时区（Asia/Shanghai / America/Los_Angeles / UTC）
  - 非法 tz / 非法 HH:MM 降级
  - `start === end` fail-safe
  - jitter：rng 注入 0 / 0.999 / jitterWindowMs=0 禁用
  - `findNextActiveStart`：quiet→next start；跨日；当前 active 幂等
  - **missed-task 守卫**：`computeDeferredNextRunAt(now=2026-04-22 03:00, cfg=08:00-22:00)` → 返回 `2026-04-22 08:00 + jitter`（**不返回过去时间**）—— F1 回归守卫

**验证**：
- 所有新测试通过
- 现有 scheduler 测试零回归

**回滚**：删 `active-hours.ts` 和测试文件。无影响（还未被 Scheduler 引用）。

### M2 — ZhixingConfig 扩展 + ConfigOverrideWriter + loadConfig 合并链 + wiring 桥接（1.5h）

> 本里程碑实现 A13 / A15 / A19（启动加载 + override 持久化 + wiring 桥接）。**工作量 1.5h**——跨 providers / core / server / cli 四个包；wiring 桥接是关键一步，不能漏（Issue 2 修复）。

**核心架构**：
- `@zhixing/providers` 的 `ZhixingConfig` 是**用户配置类型**（面向 `zhixing.config.json`）
- `@zhixing/core` 的 `SchedulerConfig` 是**scheduler 内部运行时配置**（`new Scheduler({ config })` 入参）
- **两者分离**：保持 `@zhixing/core` 不依赖 `@zhixing/providers`
- **wiring 层（server/cli）负责组合**：从 `zhixingConfig.scheduler` 抽取字段，传入 `new Scheduler({ config: { activeHours, maxConcurrent } })`

**改动**：

1. **类型与 loader**（providers 包）：
   - `packages/providers/src/types.ts`（改 ~15 行）：`ZhixingConfig` 加 `scheduler?: SchedulerSection` 字段，`SchedulerSection = { maxConcurrent?: number; activeHours?: ActiveHoursConfig }`。`ActiveHoursConfig` 从 `@zhixing/core` 导入（M1 已把它加到 core 包根 index.ts export）—— `@zhixing/providers` 已依赖 `@zhixing/core`（workspace:\*），可直接 import type，避免类型漂移。
   - `packages/providers/src/config-loader.ts`（改 ~40 行）：
     - 加导出 `getConfigOverridePath(env)`
     - `loadConfig` 合并链：**global → project → override**（override 最高优先级，用连续两次 `deepMergeConfig`）
     - `deepMergeConfig` 加 `scheduler` 分支：**按现有 `agent` 风格做 1 级合并** `result.scheduler = { ...base.scheduler, ...override.scheduler }`；`activeHours` 子对象作为整体替换（RPC 写 override 时总是完整 cfg，整体替换语义一致；手动编辑 override 的用户也需要写完整 activeHours —— 这与现有 agent/workspace 字段行为一致）

2. **Override writer**（providers 新增）：
   - `packages/providers/src/config-override.ts`（新增 ~100 行）：`ConfigOverrideWriter` 接口 + `createConfigOverrideWriter(path?)`；`read/writePatch/clearPath` 实现；**原子写（tmp+rename）+ 内部串行 promise chain**（参考 ServerStateFile）；损坏文件 read→null（§3.7.2）

3. **Core 侧 SchedulerConfig**（core 包，保持 providers 无依赖）：
   - `packages/core/src/scheduler/config.ts`（改 ~10 行）：
     - `SchedulerConfig` 加 `activeHours?: ActiveHoursConfig`（ActiveHoursConfig 来自 M1 的 active-hours.ts）
     - `DEFAULT_SCHEDULER_CONFIG.activeHours` 保持 undefined —— enabled 默认 false 由 evaluator 自判

4. **Wiring 桥接**（server/cli 层，**Issue 2 核心修复**）：
   - `packages/cli/src/serve/command.ts`（改 ~10 行）：创建 Scheduler 前从 `zhixingConfig.scheduler` 抽取字段并入 `deps.config`：
     ```typescript
     const scheduler = new Scheduler({
       // ... 原有字段
       config: {
         maxConcurrent: zhixingConfig.scheduler?.maxConcurrent,
         activeHours: zhixingConfig.scheduler?.activeHours,
       },
     });
     ```
   - `packages/server/src/context.ts`（改 ~3 行）：`ServerContext` 加 `configOverrideWriter?: ConfigOverrideWriter`（**类型定义归 M2**，与 value 注入同步）
   - 同时创建 `configOverrideWriter = createConfigOverrideWriter()` 注入 `ServerContext`（为 M5 铺路；**M2 只建不用，M5 启用**）

5. **测试**：
   - `packages/providers/src/__tests__/config-override.test.ts`（新增 ~80 行）：read / writePatch 嵌套合并 / 损坏文件 / 并发串行化
   - `packages/providers/src/__tests__/config-loader.test.ts`（加 ~30 行）：三层合并 global → project → override

**验证**：
- 所有测试通过
- Scheduler 默认 `activeHours` 为 undefined → 不改变现有行为（零回归）
- 手动创建 `~/.zhixing/config.override.json` 能覆盖 `zhixing.config.json`
- Scheduler 构造器收到 wiring 传入的 `config.activeHours`（测试断言）

**回滚**：revert types/config-loader/core config；删 config-override.ts；默认值保证无影响。wiring 桥接字段未被 M3 使用前是 no-op。

### M3 — Scheduler 集成 + defer 两阶段 + event-bridge（2h）

> 本里程碑实现 A1 / A6 / A8 / A17 + event-bridge 订阅。**关键注意**：defer 两阶段（A17）+ `SchedulerDeps` 位置在 scheduler.ts 不在 types.ts（Issue 6）。Priority 排序已由 TimerLoop 实现（A12 确认），handleDueTasks 不重复排序。

**前置动作**（编码前）：
1. 跑 `pnpm --filter @zhixing/core test` 抓 `scheduler.test.ts` baseline（pass/fail/执行顺序）
2. 以 baseline 为契约：M3 完成后零回归

**改动**：
**M3 只做 defer 半边；热更新/事件/订阅整块归 M5**——避免 dead-code 期，每个里程碑是完整可观察行为。

- `packages/core/src/scheduler/scheduler.ts`（改 ~60 行）：
  - `SchedulerDeps`（**本文件，不是 types.ts**）加 `activeHoursEvaluator?: ActiveHoursEvaluator`
  - 构造器：`this.evaluator = deps.activeHoursEvaluator ?? createActiveHoursEvaluator()`
  - 读 `this.config.activeHours` 作为数据源
  - `handleDueTasks`（**两阶段 A17**）：
    1. **阶段 1 — defer 过滤**（输入已由 TimerLoop 按 PRIORITY_WEIGHT 排序）：对每个 task 若 `cfg?.enabled && evaluate(now).state === "quiet" && priority !== "urgent" && !activeTasks.has(id)` → defer（**不加 activeTasks**）
       - `originalAt = task.state.nextRunAt`
       - `task.state.deferredFromRun = originalAt`
       - `task.state.nextRunAt = evaluator.computeDeferredNextRunAt(now, cfg).toISOString()` —— **传 now 不传 originalAt**（§3.5 / F1 语义）
       - `store.updateTask` → emit `scheduler:task-deferred-quiet-hours`
    2. **阶段 2 — 执行**：剩余（未 defer + 未 active）→ `slice(0, maxConcurrent - activeTasks.size)` → 各自 `executeSingleTask`（现有路径，加 activeTasks）
  - （**不加** `updateActiveHours` / `getActiveHours` —— 整块放 M5 一次性完成）
- `packages/core/src/scheduler/types.ts`（改 ~2 行）：`TaskState` 加 `deferredFromRun?: string`
- `packages/core/src/scheduler/events.ts`（改 ~8 行）：`SchedulerEventMap` 只加 `scheduler:task-deferred-quiet-hours`（`active-hours-changed` 归 M5）
- **`packages/server/src/rpc/event-bridge.ts`（改 ~10 行）—— 不要漏**：
  - 显式白名单订阅，加 `bus.on("scheduler:task-deferred-quiet-hours", ...)` 转发为 `schedule.deferred`
  - `active-hours-changed` 事件类型/emit/订阅三者同步归 M5
- `packages/core/src/scheduler/__tests__/scheduler-active-hours.test.ts`（新增 ~180 行）：
  - `enabled: false` → 行为不变（零回归守卫）
  - active 态 → 正常执行
  - quiet + non-urgent → defer + 事件 + state 持久化 + **不加 activeTasks**（A17 守卫）
  - quiet + urgent → 穿透执行
  - **A17 并发守卫**：maxConcurrent=2，3 个 normal + 1 个 urgent 全到期 quiet → 3 normal defer 不占槽，urgent 执行（依赖 TimerLoop 预排序）
  - maxConcurrent slice 正确

**验证**：
- baseline 零回归
- 外部 RPC client `--watch` 能收到 `schedule.deferred` 推送
- A17 不变量：defer 路径不修改 activeTasks

**回滚**：revert scheduler/types/events/event-bridge；删新测试。M1/M2 保留。

### M4 — ScheduleTool 防 AI 滥用 urgent（单一 inputSchema 修复）（0.5h）

> 本里程碑实现 A16 决策——**schedule 工具只有一个 `inputSchema`，create/update 共用**。修复方法：从 properties 删 priority + create/update handler 各自过滤（Issue 7 修正）。

**改动**：
- `packages/tools-builtin/src/schedule.ts`（改 ~15 行）：
  - **从唯一的 `inputSchema.properties` 删除 `priority` 字段**（[schedule.ts:119-123](../../../packages/tools-builtin/src/schedule.ts#L119)）—— create + update 同时失去 AI 可见性
  - `handleCreate`（[schedule.ts:198](../../../packages/tools-builtin/src/schedule.ts#L198)）：硬编码 `priority: "normal"`，完全忽略 input.priority
  - `handleUpdate`（[schedule.ts:238](../../../packages/tools-builtin/src/schedule.ts#L238)）：**显式删除** `if (input.priority !== undefined) patch.priority = input.priority;` 这一行——priority 不再进 patch
  - Tool 顶层 description 加一句："priority 由用户通过 CLI/UI 设置，AI 无权调整"
- `packages/tools-builtin/src/__tests__/schedule.test.ts`（改 ~25 行）：
  - AI create 传 `priority: "urgent"` → 实际 normal（无视）
  - **AI update 传 `priority: "urgent"` → priority 保持原值**（Issue 1 漏洞回归守卫）
  - 其他字段（name/description/enabled/schedule_*）正常更新

**验证**：
- RPC `schedule.create/update` handler（非 tool 路径）仍支持 priority 参数（授信用户可设）
- AI tool 路径永远无法设 urgent（单一 schema 删字段后 create + update 都挡住）

**回滚**：恢复 tool schema 里的 priority 字段 + handleUpdate 的一行。

### M5 — RPC schedule.activeHours + Scheduler.updateActiveHours + override 持久化 + bridge 订阅（1.5h）

> 本里程碑实现 A11 / A15 / A18——**一次性完整走通** RPC → disk → Scheduler → emit → bridge。**关键架构决策**：
> - **disk-first, memory-second 写入顺序**（F2）：磁盘是真源，内存派生。磁盘写失败不动内存，崩溃重启后行为一致
> - **Scheduler 内部 emit**：`Scheduler.updateActiveHours` 自己发 `scheduler:active-hours-changed`，RPC handler 不碰 bus
> - **RPC 访问路径**：`ctx.server.scheduler` / `ctx.server.configOverrideWriter`（与现有 schedule.list/create handler 一致）
> - **方法/事件/订阅三同步**：updateActiveHours 方法 + active-hours-changed 事件类型 + event-bridge 订阅都在本里程碑引入（M3 不提前加任何）

**改动**：

1. **Scheduler 侧**（core 包）：
   - `packages/core/src/scheduler/scheduler.ts`（改 ~25 行）：
     - `getActiveHours(): ActiveHoursConfig | undefined` —— 返回 `this.config.activeHours` 结构化副本（防外部 mutate）
     - `updateActiveHours(cfg: ActiveHoursConfig): void`：
       - `previous = this.config.activeHours`
       - 原子引用替换 `this.config.activeHours = cfg`
       - `this.timerLoop.rearm()` —— 立即生效
       - `this.eventBus.emit("scheduler:active-hours-changed", { previous, current: cfg })` —— 内部 emit
   - `packages/core/src/scheduler/events.ts`（改 ~8 行）：`SchedulerEventMap` 补 `scheduler:active-hours-changed`

2. **RPC handler**（server 包）：
   - `packages/server/src/rpc/methods/schedule.ts`（追加到现有文件，~80 行）：
     - `buildScheduleActiveHoursGetMethod()` — `schedule.activeHours.get`（requiresAuth）：返回 `requireScheduler(ctx.server).getActiveHours()`
     - `buildScheduleActiveHoursUpdateMethod()` — `schedule.activeHours.update`（requiresAuth），**严格 disk-first 顺序**：
       1. **入参 schema 校验**（非法 HH:MM / 非法 timezone / enabled 非布尔 → `RpcErrors.invalidParams`）—— 失败即返回，磁盘/内存/事件全不动
       2. **先写盘**：`await ctx.server.configOverrideWriter?.writePatch({ scheduler: { activeHours: cfg } })`
          - `writePatch` reject → 抛 `RpcErrors.internal("persist failed")` → 返回错误，**内存不动**（语义：落盘失败 = 未更新）
          - writer 未注入（纯测试 / 非 daemon 场景）→ 跳过落盘直接走步骤 3（显式 warn log）
       3. **后改内存**：`requireScheduler(ctx.server).updateActiveHours(cfg)` —— Scheduler 内部 emit `scheduler:active-hours-changed`
       4. 返回 `{ updated: true, applied: cfg }`
   - `packages/server/src/rpc/methods/index.ts`（加 ~3 行）：注册两个新 method builder

3. **事件桥接**（server 包）：
   - `packages/server/src/rpc/event-bridge.ts`（改 ~10 行）：补 `bus.on("scheduler:active-hours-changed", ...)` 转发为 `schedule.activeHoursChanged`（**不叫 `config.changed`**，A18）

4. **测试**：
   - `packages/server/src/rpc/methods/__tests__/schedule-active-hours.test.ts`（新增 ~120 行）：
     - get 返回当前 cfg
     - update 正常：入参校验 → writePatch 被调用 → scheduler.updateActiveHours 被调用（顺序断言）
     - update 入参非法：返回 invalidParams，writer/scheduler 均未被调用
     - **F2 守卫**：`writePatch` 失败 → RPC 返回 internal，**scheduler.updateActiveHours 未被调用**（disk-first 不变量）
     - writer 未注入：RPC 成功，scheduler 被调，带 warn log
     - event-bridge 转发：update 后 mock connection 收到 `schedule.activeHoursChanged`
   - `packages/core/src/scheduler/__tests__/scheduler-active-hours.test.ts`（加 ~40 行）：
     - `updateActiveHours` 替换 config + rearm + emit 三件套
     - `getActiveHours` 返回副本（外部 mutate 不影响内部）

**验证**：
- RPC `schedule.activeHours.get/update` 正常
- update 成功后 `~/.zhixing/config.override.json` 已写入，内存已切换
- **写盘失败 → RPC 失败 + 内存/磁盘仍一致（旧 config）**（F2 核心守卫）
- daemon 重启后 override 被读取，配置保留（持久化闭环）
- 外部 `--watch` 收到 `schedule.activeHoursChanged`

**回滚**：revert 本里程碑 5 块改动（scheduler 方法 + events 类型 + RPC handler + bridge 订阅 + context 类型）。M3 的 defer 半边保留无碍。

### M6 — UX: serve status + schedule list + 中文友好文案（1h）

> 本里程碑实现 §3.8 UX。

**改动**：
- `packages/cli/src/serve/status.ts`（改 ~30 行）：
  - `buildReport` 加 `activeHours?: { enabled, state, window?, timezone?, nextActiveStart?, localTime? }`
  - `printReportHuman` 显示中文友好行："免打扰中 (将于 08:00 Asia/Shanghai 恢复推送)"
  - JSON 模式保留英文 `state` 字段
- `packages/cli/src/schedule-cli/list.ts`（改 ~15 行）：
  - 任务列表显示 deferred 标记（if `task.state.deferredFromRun`）："next: 08:00 (免打扰推迟自 22:30)"
- `packages/server/src/rpc/methods/server.ts`（`server.info` 加 activeHours 字段，改 ~10 行）
- `packages/cli/src/serve/__tests__/status.test.ts`（加 ~25 行）：测 activeHours 字段 + 中英输出

**验证**：
- `zhixing serve status` 免打扰时显示"免打扰中 (将于 08:00 恢复推送)"
- `zhixing schedule list` deferred 标记清晰

**回滚**：revert 显示代码；字段保留不渲染。

### M7 — E2E 验收 + 文档（1h）

**E2E 验收脚本**：

```bash
# 1. 启用 active hours（注意：RPC 命名空间是 schedule.*，不是 config.*）
zhixing rpc schedule.activeHours.update \
  --arg enabled=true --arg start="08:00" --arg end="22:00" \
  --arg timezone="Asia/Shanghai" --arg jitterWindowMs=0  # 关 jitter 便于测试

# 2. 创建任务（当前假设 23:00，即免打扰时段）
zhixing schedule create --name "晚间测试" --schedule-cron "0 23 * * *"
#  预期：task 创建，priority=normal，到 23:00 tick 时被 defer 到次日 08:00

# 3. 创建 urgent 任务（授信路径，用户显式）
zhixing schedule create --name "紧急告警" --priority urgent --schedule-cron "0 * * * *"
#  预期：每小时都执行，即使深夜（穿透）

# 4. 查询状态
zhixing serve status
#  预期：免打扰中 (将于 08:00 Asia/Shanghai 恢复推送)

# 5. 查询任务列表
zhixing schedule list
#  预期：晚间测试 ... next: 08:00 (免打扰推迟自 23:00)

# 6. 持久化验证（A15 核心）
cat ~/.zhixing/config.override.json
#  预期：{ "scheduler": { "activeHours": { "enabled": true, ... } } }
zhixing serve stop
zhixing serve --daemon
zhixing rpc schedule.activeHours.get
#  预期：仍是上面配置的值（override 文件被读取）

# 7. 运行时改配置 + 事件（A18 命名空间验证）
zhixing rpc --watch &   # 另一终端订阅事件
zhixing rpc schedule.activeHours.update --arg enabled=false
#  预期：watch 端收到 schedule.activeHoursChanged 事件（不是 config.changed）；后续 tick 不再 defer

# 8. AI 滥用检查（Issue 1 漏洞修复验证）
zhixing ask "创建一个每分钟执行的紧急任务"
zhixing schedule list
#  预期：AI 创建的任务 priority=normal（不是 urgent）——A16 create 防线

zhixing ask "把刚才那个任务改成紧急优先级"
zhixing schedule list
#  预期：priority 仍是 normal——A16 update 防线（Issue 1 的 update 漏洞守卫）

# 9. 并发 race（TimerLoop 预排序 + M3 两阶段守卫）
# 同时到期 1 个 urgent + 3 个 normal（超过 maxConcurrent=3）
# 预期：urgent 必入前 3 跑（按 PRIORITY_WEIGHT 排序）

# 10. F2 disk-first 守卫（手动故障注入，可选）
# chmod 444 ~/.zhixing/config.override.json     # 让 writer 写失败
zhixing rpc schedule.activeHours.update --arg enabled=false
#  预期：RPC 返回 internal error；再查 get 仍是旧 cfg（内存未变）
# chmod 644 ~/.zhixing/config.override.json     # 恢复

# 11. F1 missed-task 活锁守卫（通过日志观察）
# 停 daemon 若干小时，让 cron 任务积压过期，重启进入 quiet hours
# 预期：每个过期任务被 defer 一次到未来 activeStart + jitter，而不是活锁反复 defer
```

**文档**：
- 更新 `persistent-service.md §4.6` 引用本文档（已做）
- 更新 `implementation-roadmap.md` P2 状态为"已实现（M1-M7）"

**回滚**：独立 TD，不阻塞已完成里程碑。

---

## 6. 依赖图与工作量

```
M1 (1.5h)  ActiveHoursEvaluator + Jitter
   │
M2 (1.5h)  ZhixingConfig + override writer + wiring 桥接  ← 与 M1 并行
   │
   └──→ 合流 ──→
          │
       M3 (2h)    Scheduler 集成 + defer 两阶段 + event-bridge
          │
          ├── M4 (0.5h)  ScheduleTool 防滥用（单一 inputSchema 删 priority）
          │
          └──→ 合流 ──→
                 │
              M5 (1.5h)  RPC schedule.activeHours + disk-first 持久化 + updateActiveHours + bridge 订阅
                 │
              M6 (1h)    UX 展示 + 中文文案
                 │
              M7 (1h)    E2E + 文档
```

**总计 ~9 小时**（M2 从 1h 调到 1.5h，纳入 wiring 桥接）。

**并行机会**：
- M1 与 M2 完全独立
- M3 完成后 M4 与 M5 可并行（分别改 tools-builtin 和 server rpc）

---

## 7. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| M1 时区判定在 DST 边界出错 | 低 | 边界 2 小时内判定可能误差 1 小时 | Fail-safe 到 active；DST 国内无影响；海外用户看日志诊断 |
| M1 findNextActiveStart 配置错导致返回 from 自身 | 低 | task 立刻执行（看似"没 defer"） | 48h 扫描上限是 sentinel；日志 warn |
| M2 override 文件并发写 race | 低 | 两个 RPC update 同时写可能撕裂 | 原子写（tmp+rename）；writer 内部串行化 promise chain（参考 ServerStateFile） |
| M3 defer 后 cron task 的 natural schedule 混乱 | 中 | 用户困惑 task 下次到底什么时候跑 | `deferredFromRun` 字段保留原计划；schedule list 明确显示 |
| **M3 忘记加 event-bridge 订阅** | **中** | 新事件只在内部 emit，外部 `--watch` 收不到 | spec 明示 + 里程碑 checklist；写 integration test 验证 RPC 推送 |
| M4 AI 创建 urgent 需求被误拒 | 低 | 用户说"给我设紧急"AI 做不到 | Tool description 明说+引导用户用 CLI `schedule create --priority urgent` |
| **M4 AI 通过 update 升级 priority 漏洞** | **高**（未修即漏洞） | AI 可通过 schedule.update 绕过 create 防护 | M4 必须同时修 create+update；回归测试守卫 |
| M5 热更新并发 race | 低 | 同一 tick 里 evaluator 被替换 | Scheduler 内部替换时 atomic（引用交换）；多次调用幂等 |
| M5 override 文件损坏（手动乱改 / 磁盘故障） | 低 | loadConfig 解析失败 | `readJsonSafe` 已容忍（解析失败视为 undefined）；daemon 启动仍用源 config |
| 用户配错 start/end 导致全天静默 | 中 | 任务全都不跑 | A5 fail-safe：`start === end` 降级 active；RPC update 入参 schema 校验；status 显示生效 config |
| Timezone 用错（系统时区 ≠ 用户时区） | 低 | 时段判定错几小时 | 默认系统时区；明确提示配 `timezone: "Asia/Shanghai"`；status 显示当前 localTime |

**整体回滚策略**：
- 每个里程碑独立可 revert
- 默认 `enabled: false`——不改代码即可禁用功能
- 最保守回滚：RPC `schedule.activeHours.update --arg enabled=false`，所有路径变 no-op
- 紧急 fallback：删 `~/.zhixing/config.override.json` 让 daemon 回到源 config 默认

---

## 8. 架构可扩展性展望

本 spec 的抽象为未来几个阶段铺垫：

| 未来阶段 | 本 spec 已铺垫的扩展点 |
|---------|----------------------|
| **Per-channel active hours** | `ActiveHoursEvaluator.evaluate` 可接受 `channelId` 参数；config 扩展为 `Record<channelId, ActiveHoursConfig>` |
| **Per-task override** | `ScheduledTask` 加 `activeHoursOverride?: ActiveHoursConfig` 字段；evaluator 先看 task 后看全局 |
| **Step 20 远程确认** | Deferred 任务被触发时可主动推送通知（借助 Active Hours 事件）；urgent 确认可穿透 |
| **S2.5 AgentOrchestrator** | 背景 Agent 的 fire 也经过 evaluate；同样的 jitter 错峰逻辑 |
| **Agent `[SILENT]` 标记** | 独立于本模块；ChannelAdapter.send 返回 silent-marker 时跳过推送（不在 Scheduler 层） |
| **智能活跃时段建议** | 未来 AI 根据用户历史交互推荐 active hours → RPC `schedule.activeHours.update` |
| **ConfigOverrideWriter 复用** | 本阶段引入的 override writer 可被**其他运行时配置**复用（如 max-concurrent 动态调优、Active Hours 之外的策略类配置）——成为整个 daemon 的"运行时配置写回层" |
| **临时打破免打扰命令** | 本阶段延后的 TD：`zhixing serve pause-active-hours --duration 30m`——基于现有 `schedule.activeHours.update` + 定时回填实现，不需要新抽象 |

**关键原则**：**扩展通过组合（新字段 / 新层级）而非修改（改已有 API）实现**——ActiveHoursEvaluator 的纯函数签名 + config 可选字段 + ConfigOverrideWriter 的通用接口是未来扩展的根。
