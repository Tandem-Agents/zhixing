# 消息 Outbox (Message Outbox & Causal Ordering)

> **版本**: v1.0
> **状态**: 📐 设计稿（2026-04-21）
> **关联**:
>
> - [persistent-service.md](./persistent-service.md) §4.7 — Delivery Pipeline（Outbox 在其之上叠加保序层）
> - [conversation-model.md](./conversation-model.md) §Turn — Turn Slot 概念的承接点
> - [server-gateway.md](./server-gateway.md) — Channel Adapter 出站接口
> - [confirmation-ux.md](./confirmation-ux.md) — Step 20 远程确认依赖本规格
> - [ADR-007 Message Outbox & Causal Ordering](../architecture/decisions/007-message-outbox.md)

---

## 一、问题定义

### 1.1 观察到的现象

Serve 模式下用户在飞书发 `"5秒后提醒我"`，系统表现：

1. 用户消息进入 ConversationManager，LLM 轮1 调 `schedule` 工具创建 5s 后的任务
2. LLM 需要轮2 推理生成"已经创建了定时任务..."的确认回复
3. 这期间 5s 已过，Scheduler 触发任务 → ephemeral runtime (1 LLM 轮) → DeliveryPipeline → 飞书
4. 用户看到的顺序：

   ```
   Bot: 时间到了！5秒已过。🎯          ← 任务触发先到
   Bot: 已经创建了定时任务，5秒后会提醒你！🎯  ← 创建确认后到
   ```

**"已触发"比"已创建"更早到达——因果倒置。**

### 1.2 根因分析

代码层面的两条出口路径完全独立：

| 路径 | 起点 | 经过 | 出口 |
|------|------|------|------|
| **A. 用户回复** | InboundRouter ([inbound-router.ts:45](../../../packages/server/src/channels/inbound-router.ts#L45)) | ConversationManager → LLM → 文本聚合 | `adapter.send()` ([inbound-router.ts:133](../../../packages/server/src/channels/inbound-router.ts#L133)) |
| **B. 定时投递** | Scheduler.executeSingleTask ([scheduler.ts:321](../../../packages/core/src/scheduler/scheduler.ts#L321)) | ephemeralRuntime → `enqueueDelivery` → DeliveryPipeline | `adapter.send()` ([pipeline.ts:224](../../../packages/core/src/delivery/pipeline.ts#L224)) |

**关键架构缺陷**：

1. **无时间轴所有者**：两条路径各写各的，没有组件承担"此用户的输出时间轴"这一职责
2. **DeliveryPipeline 非 per-user 保序**：它是全局 FIFO + 按优先级排序，同一用户的多个投递无保序保证 ([pipeline.ts:154](../../../packages/core/src/delivery/pipeline.ts#L154))
3. **LLM 回复路径绕过 DeliveryPipeline**：`adapter.send()` 直调，彻底不经队列
4. **命题（commitment）与动作（action）的生成耦合错位**：LLM 被委托去生成"我做了 X"的叙述，但 LLM 推理延迟是非确定的——把强因果保证托付给非确定组件

### 1.3 本质

问题不是 5s 提醒倒转——那只是症状。**本质是系统正在演化为多生产者、单消费者（用户时间轴）的架构，但缺失串行化原语**。

未来会有更多生产者加入：

- Step 17 Daemon 的晨报/晚报主动消息
- Step 18 Active Hours 的延迟投递
- Step 19 流式卡片的 UI 更新
- Step 20 远程权限确认的卡片交互回执
- Journal 凝练后的主动汇报
- 未来的外部 webhook 触发消息

**没有 Outbox 的情况下，生产者越多，顺序混乱越严重——指数级恶化**。这是必须在 Daemon 之前修掉的架构债务。

### 1.4 与现有组件的关系

| 现有组件 | 当前角色 | Outbox 上线后 |
|---------|---------|--------------|
| ConversationManager | 管理会话运行时生命周期 | 不变。发起 LLM turn 时额外开启 Turn Slot |
| DeliveryPipeline | 持久化队列 + 重试 + 过滤器 | 不变。drain 目标从 `adapter.send` 改为 `outbox.post` |
| ChannelAdapter.send | 直接对外发送 | 不变。只有 Outbox 调它 |
| InboundRouter | LLM 回复聚合后直接 adapter.send | drain 目标改为 Outbox |
| Scheduler / ephemeralRuntime | 产生任务结果后 enqueueDelivery | 不变。Pipeline 背后是 Outbox |

**Outbox 不替代 DeliveryPipeline**——两者职责正交：
- DeliveryPipeline = **持久性**（崩溃恢复、重试策略、过滤器链）
- Outbox = **顺序性**（per-user 串行化、因果依赖、承诺占位）

---

## 二、不变量（Invariants）

Outbox 设计的正确性由以下不变量定义。任何实现和修改都必须保持这些不变量。

**INV-1. Per-Target FIFO**：同一 `(channelId, to)` 的所有 entry，出队顺序与入队顺序一致。

**INV-2. 不同 Target 之间相互独立**：`(feishu, user_A)` 和 `(feishu, user_B)` 的出队无同步约束，可并发处理。

**INV-3. Causal Happens-Before**：若 entry E₂ 声明 `afterSlot: S`，且 slot S 尚未填充，则 E₂ 必须在 S 填充之后出队。

**INV-4. Slot 单调性**：Turn Slot 一旦开启，必然在有限时间内进入三种终态之一——`filled`（LLM 回复到达）/ `abandoned`（turn 异常终止）/ `expired`（超过 slot TTL）。不会无限阻塞下游 entry。

**INV-5. 发送原子性**：`outbox.post(entry)` 返回 resolved 时，要么 entry 已成功到达 `adapter.send` 且无错误，要么整个调用失败（不产生"部分发送"）。

**INV-6. 无隐式重排**：Outbox 内部的重试策略（若有）必须保证重试期间该 entry 占用队列头部——不能让后续 entry 越过失败项发送。

**INV-7. 可观测**：每个 entry 产生至少两个事件 `entry:enqueued` / `entry:sent` 或 `entry:failed`。用于测试、审计、调试。

---

## 三、架构

### 3.1 分层视图

```
┌─────────────── 生产者层 ───────────────┐
│  LLM User Reply    Scheduler Task   │
│  Tool Commitment   Future: Daemon    │
└───────────┬──────────────────────────┘
            │
            ▼
┌─────────── 持久层（可选）──────────────┐
│  DeliveryPipeline                    │
│  （仅用于需要崩溃恢复的 entry，当前：   │
│   Scheduler / System handler 结果）   │
└───────────┬──────────────────────────┘
            │
            ▼
┌─────────── 顺序层 ────────────────────┐
│  OutboxRegistry                      │
│   ├─ Outbox[feishu:ou_abc]  ←── FIFO │
│   ├─ Outbox[feishu:ou_xyz]           │
│   └─ Outbox[dingtalk:...]            │
│   每个 Outbox：                        │
│    - FIFO 队列                        │
│    - Turn Slot 占位                   │
│    - 因果依赖解析                      │
│    - 单 drain goroutine               │
└───────────┬──────────────────────────┘
            │
            ▼
┌─────────── 适配器层 ───────────────────┐
│  ChannelAdapter.send(target, content) │
│  （feishu / dingtalk / …）             │
└──────────────────────────────────────┘
```

### 3.2 组件职责

| 组件 | 职责 | 非职责 |
|------|------|--------|
| **Outbox** | 单 target 的 FIFO + 因果依赖 + 单消费者 drain | 不做持久化；不做重试策略；不做过滤 |
| **OutboxRegistry** | 管理所有 target 的 Outbox 实例、生命周期、空闲回收 | 不做业务逻辑 |
| **DeliveryPipeline**（现有） | 持久化 + 重试 + 过滤链 | 不再直接调 adapter.send（改调 Outbox） |
| **Turn Slot** | 跨路径因果依赖的载体 | 不做消息内容传输 |

### 3.3 数据模型

```typescript
// ─── 核心实体 ───

/** Outbox 中的单个 entry */
interface OutboxEntry {
  /** 去重 + 追踪用的 entry id */
  readonly id: string;
  readonly target: DeliveryTarget;  // (channelId, to, threadId?)
  readonly content: OutboundContent; // 文本/卡片/富媒体
  readonly source: EmissionSource;
  /** 因果依赖：若指定，必须等 slotId 填充后才出队 */
  readonly afterSlot?: TurnSlotId;
  /** 幂等键，可选 */
  readonly idempotencyKey?: string;
  readonly enqueuedAt: string;  // ISO-8601
}

/** entry 的来源，影响日志和优先级 */
type EmissionSource =
  | { kind: "llm-reply"; conversationId: string; turnId: TurnId }
  | { kind: "tool-commitment"; conversationId: string; turnId: TurnId; toolName: string }
  | { kind: "scheduled-task"; taskId: string; createdInTurn?: TurnId }
  | { kind: "system"; handler: string };

/** Turn 的全局唯一标识（新引入） */
type TurnId = string;   // 例如 `turn_${ulid()}`
type TurnSlotId = TurnId;

/** Target 的字符串键，用于索引 Outbox 实例 */
type OutboxKey = string;  // `${channelId}:${to}`

// ─── 运行时状态 ───

/** 单个 Outbox 的状态机 */
interface Outbox {
  readonly key: OutboxKey;
  /** FIFO 队列 */
  readonly pending: OutboxEntry[];
  /** 已开启但未填充的 slot（按开启顺序） */
  readonly slots: Map<TurnSlotId, SlotState>;
  /** 正在 drain 中的 entry（占位，保证 FIFO） */
  inflight?: OutboxEntry;
}

interface SlotState {
  readonly id: TurnSlotId;
  readonly openedAt: string;
  readonly position: number;   // 占用的 FIFO 位置
  state: "pending" | "filled" | "abandoned" | "expired";
  /** 填充时由 turn 最终回复填入 */
  filledEntry?: OutboxEntry;
  readonly ttlMs: number;       // 默认 10 分钟
}
```

### 3.4 API 表面

```typescript
interface OutboxRegistry {
  /** 获取（或按需创建）某 target 的 Outbox */
  of(target: DeliveryTarget): Outbox;

  /** 批量释放长时间空闲的 Outbox（防止内存无限增长） */
  reapIdle(maxIdleMs: number): number;

  /** 注入 ChannelAdapter（由 adapter 发现时注册） */
  registerAdapter(adapter: ChannelAdapter): void;

  /** 用于测试：清空所有 Outbox */
  dispose(): Promise<void>;
}

interface Outbox {
  /** 提交一个 entry。返回 Promise 在 entry 发送成功或永久失败时 resolve。 */
  post(entry: OutboxEntry): Promise<DeliveryResult>;

  /** 开启一个 Turn Slot（由 ConversationManager 在 turn 开始时调用） */
  openSlot(opts: { slotId: TurnSlotId; ttlMs?: number }): void;

  /** 填充 slot（LLM turn 正常完成） */
  fillSlot(slotId: TurnSlotId, entry?: OutboxEntry): Promise<DeliveryResult | void>;

  /** 弃用 slot（turn 异常终止，无回复可发） */
  abandonSlot(slotId: TurnSlotId, reason: string): void;

  /** 观测 */
  on<K extends keyof OutboxEventMap>(event: K, handler: OutboxEventMap[K]): void;
}

type OutboxEventMap = {
  "entry:enqueued": (entry: OutboxEntry) => void;
  "entry:sent": (entry: OutboxEntry, result: DeliveryResult) => void;
  "entry:failed": (entry: OutboxEntry, error: Error) => void;
  "slot:opened": (slot: SlotState) => void;
  "slot:filled": (slot: SlotState, entry?: OutboxEntry) => void;
  "slot:expired": (slot: SlotState) => void;
};
```

### 3.5 Drain 算法

每个 Outbox 有唯一的 drain loop（单消费者保证 FIFO）：

```
loop:
  next_entry ← peek(pending)
  if next_entry == null: await signal("new-entry" | "slot-filled")
  if next_entry.afterSlot:
    slot ← slots[next_entry.afterSlot]
    if slot == null: abort("stale slot ref")  // 生产者 bug
    if slot.state == "pending": await signal("slot-filled" | "slot-expired")
    if slot.state in (filled, abandoned, expired):
      if slot.state in (abandoned, expired) and next_entry.afterSlot.required:
        log_warn "causal precondition lost, emitting anyway"
      // fallthrough — slot 已终态，放行
  pop(pending)
  inflight ← next_entry
  try:
    result ← adapter.send(next_entry.target, next_entry.content)
    emit("entry:sent", next_entry, result)
  catch err:
    emit("entry:failed", next_entry, err)
    // 此处不做 Outbox 层重试。重试责任在 DeliveryPipeline 上游。
  inflight ← null
```

**关键点**：

- 单 drain = 天然 FIFO，无需锁
- 阻塞在因果依赖上时，用 signal 唤醒（slot 状态变化时 notify）
- Outbox 自己**不做重试**——失败即上报，重试是 DeliveryPipeline 的职责。Pipeline 决定重试时，会以新 entry 重新 post。重试的代价是顺序丢失（新 entry 会排在当前尾部），这是持久性 vs 顺序性的权衡，业界通行做法
- 如果需要"重试期间保持头部"的更强语义，可在 Phase 4 引入 inflight 的 backoff 重试，当前规格不包含

### 3.6 Turn Slot 生命周期

```
ConversationManager.runTurn(target, userMsg):
  slotId ← generate_turn_id()
  outbox ← registry.of(target)
  outbox.openSlot({ slotId })
  try:
    // 把 slotId 传入 runtime，供工具读取
    result ← runtime.run(userMsg, { turnId: slotId, target })
    finalText ← extract_text(result)
    if finalText:
      await outbox.fillSlot(slotId, makeEntry(target, finalText, "llm-reply", slotId))
    else:
      outbox.fillSlot(slotId)   // 空填充，只释放占位
  catch err:
    outbox.abandonSlot(slotId, err.message)
    throw
```

Slot 的 3 种终态：

| 终态 | 触发场景 | 下游（afterSlot=此 slot 的 entry）行为 |
|------|---------|-------------------------------------|
| `filled` | LLM 正常完成 + 有回复文本 | 按 FIFO 继续发送 |
| `filled` (empty) | LLM 正常完成 + 无文本（被 prompt 抑制） | 按 FIFO 继续发送 |
| `abandoned` | turn 异常中止（timeout、error、abort） | 按 FIFO 发送，日志 warn |
| `expired` | 超过 ttlMs 未填充（默认 10 分钟） | 按 FIFO 发送，日志 warn |

---

## 四、Commitment / Action 职责分离

### 4.1 问题重申

LLM 调 schedule 工具后**又要推理生成一段"已创建"的叙述**——这是一次不必要的 LLM 往返。工具自己就知道它做了什么、何时触发，应该由工具**直接产出 commitment 消息**。LLM 的角色是决策，不是叙述已完成的事实。

这对标 Claude Code / Cursor 的核心范式：**Tool 效果可视 → LLM 无需叙述**。

### 4.2 Tool Execution Context 扩展

```typescript
interface ToolExecutionContext {
  readonly workingDirectory: string;
  readonly abortSignal: AbortSignal;

  // ─── 新增字段（可选，仅在 server/channel 上下文提供）───

  /** 当前 turn 的唯一标识（Phase 3 引入） */
  readonly turnId?: TurnId;

  /** 当前 turn 绑定的用户 target（Phase 2 引入） */
  readonly emissionTarget?: DeliveryTarget;

  /**
   * 直接向用户发出一条 commitment 消息，不经过 LLM。
   * 消息进入 Outbox，不与 LLM 最终回复重复。
   * （Phase 2 引入）
   */
  readonly commitToUser?: (content: OutboundContent) => Promise<DeliveryResult>;
}
```

### 4.3 ToolResult 扩展

```typescript
interface ToolResult {
  readonly content: string;        // 给 LLM 看
  readonly isError?: boolean;

  /** 新增：告知 LLM 该工具已直接向用户发送了可视化结果。
   *  LLM 应避免重复叙述。（Phase 2 引入） */
  readonly committedToUser?: boolean;
}
```

### 4.4 系统提示补充（Phase 2）

在 CLI 的 `buildSystemPrompt` 中新增段落：

> 当工具的返回结果包含 `committedToUser: true` 时，用户**已经**看到了该工具的执行反馈。你不需要重复叙述"我已经创建了 X"。如果没有其他必要补充的信息，你可以直接结束本轮回复（输出空）。

### 4.5 schedule 工具示例改造

```typescript
async call(input, context) {
  const task = await scheduler.createTask(...);

  // Phase 2: 直接向用户 commit 一条可视化消息
  if (context.commitToUser && input.action === "create") {
    await context.commitToUser({
      text: `⏰ 已安排：${task.schedule.description}`,
    });
    return {
      content: JSON.stringify({ status: "ok", taskId: task.id }),
      committedToUser: true,
    };
  }

  // 非 channel 场景（CLI REPL）保持原路径：结果只给 LLM，LLM 自己叙述
  return {
    content: JSON.stringify({ status: "ok", taskId: task.id, nextRunAt }),
  };
}
```

**效果**：

- 用户看到的第一条消息由 schedule 工具确定性生成（不依赖 LLM 二轮推理）
- LLM 收到 `committedToUser: true`，遵循系统提示**直接结束本轮**
- 5s 后 task 触发，Outbox 已空，新 entry 直接发送

### 4.6 与 Turn Slot 的协同（Phase 3）

Phase 2 仅靠 prompt 约束 LLM "不再叙述"。若 LLM 违反（尤其小模型），仍可能出现：

```
Outbox timeline:
  [commit "⏰ 已安排"]   ← 立即
  [LLM 晚到的叙述]        ← N 秒后
  [task fire]           ← T+5s
```

若 N > 5s，task fire 仍会抢 LLM 叙述。Phase 3 的 Turn Slot 解决这个边缘：

```
Outbox timeline:
  [commit "⏰ 已安排"]   ← 立即
  [slot_T: pending]      ← 占位，turn 未完成
  [task fire, afterSlot=slot_T]  ← 等 slot_T 填充后才发
```

即使 task fire 先到 Outbox，因果依赖保证它**不会越过未填充的 slot**。LLM 无论快慢，顺序必然正确。

---

## 五、CLI vs Server：共用还是分开？

### 5.1 结论

**一套实现，共用原语，放在 `@zhixing/core`。**

### 5.2 理由

**代码路径已共享**：REPL（[repl.ts:707](../../../packages/cli/src/repl.ts#L707)）和 serve（[serve/command.ts](../../../packages/cli/src/serve/command.ts)）都创建同一个 `Scheduler` 并注入同一个 `DeliveryPipeline`。Pipeline 内部逻辑不分 REPL/serve。如果只在一侧加 Outbox，Pipeline 要分叉两套，维护成本急增。

**REPL 目前无并发不等于永远无并发**：
- 当前 REPL 是单线程阻塞式（用户命令→处理完→下一个），确实无并发
- 但 REPL 中的 Scheduler 和 user command 本质也是两个独立生产者；只要引入异步输入（如后台刷新、推送卡片更新），并发立刻浮现
- Step 19 流式卡片若接入 CLI，REPL 立即有真实并发

**Outbox 的抽象对 REPL 是 no-op**：REPL 当前单生产者场景下，Outbox 退化为"提交即发送"，零开销、零行为变化。统一抽象换来未来扩展性。

### 5.3 封装边界

```
@zhixing/core/delivery/
  outbox.ts              ← Outbox 类 + 类型
  outbox-registry.ts     ← Registry + 空闲回收
  outbox-events.ts       ← EventBus 集成
  pipeline.ts            ← [现有] 改造：sender.send → registry.of(target).post

@zhixing/server/
  inbound-router.ts      ← [现有] 改造：adapter.send → outboxRegistry.of(target).post
  turn-slot-coordinator.ts  ← [新增] 绑定 ConversationManager 的 turn lifecycle 到 Outbox.openSlot/fillSlot

@zhixing/cli/
  serve/command.ts       ← [改造] 注入 OutboxRegistry
  repl.ts                ← [改造] 注入 OutboxRegistry（REPL 终端 Channel 可选暂缓接入）
```

### 5.4 REPL 终端适配器（可选 / 延后）

REPL 的"channel"是终端。若要把 REPL 回复也纳入 Outbox，需要：

1. 实现 `TerminalChannelAdapter implements ChannelAdapter`
2. `send()` 内部调 REPL 的渲染函数
3. REPL 注册该 adapter 到 ChannelRegistry
4. LLM 回复和 Scheduler 投递都走 Outbox

**当前阶段不实施**——REPL 终端渲染器与 Channel 协议耦合度低，强行包装会引入无谓复杂度。等 Step 19 流式卡片需要 CLI 侧支持时一起做。

---

## 六、失败模式与降级

### 6.1 Adapter.send 失败

- 单次失败 → Outbox emit `entry:failed` 事件，不做内部重试
- DeliveryPipeline（上游）根据事件决定是否 requeue
- LLM 回复路径（不经 Pipeline）：失败则丢失，要求用户重发；日志记录供排查

### 6.2 Slot 超时

- 默认 TTL 10 分钟
- 超时后 `state = expired`，下游 entry 放行并附 warn 日志
- 业务方决定是否对 expired 做特殊处理（例如把 task fire 结果加前缀"注：本次提醒原本属于 T 时刻的任务，但由于当时对话长时间未完成，现才送达"）——规格不强制

### 6.3 Slot 孤儿（slotId 被引用但 Outbox 里找不到）

- 通常是生产者 bug（task 记录的 slotId 在 Outbox 里从未 open）
- Drain 算法见到悬空引用：记 error 日志，视为 `expired` 处理，放行 entry
- 用于防御编程，不应在正常流程中发生

### 6.4 Drain 卡死

- 若 adapter.send 一直不返回（channel 卡死），Outbox 整条 FIFO 停滞
- 处理：为 adapter.send 加超时包装（默认 30s），超时视为失败
- 这个超时包装放在 Outbox drain 里，不要求 adapter 自己实现

### 6.5 进程崩溃

- Outbox 是纯内存——未发送的 entry 丢失
- **这是设计权衡**：
  - LLM 回复类 entry：对话 transcript 已持久化，用户可重发，丢失可接受
  - Scheduler 类 entry：走 Pipeline 持久化，进程重启后 Pipeline 重新 replay 到 Outbox，不丢

---

## 七、对其他模块的影响

| 模块 | 影响 | 变更量 |
|------|------|--------|
| [conversation-model.md](./conversation-model.md) | Turn 新增全局 TurnId 字段；ConversationManager 对接 Outbox.openSlot | 中 |
| [persistent-service.md](./persistent-service.md) §4.7 | DeliveryPipeline drain 目标改变；新增 Outbox 章节引用 | 小 |
| [ADR-004 工具系统架构](../architecture/decisions/004-tool-system-architecture.md) | ToolExecutionContext 新增 commitToUser/turnId；ToolResult 新增 committedToUser | 中 |
| [server-gateway.md](./server-gateway.md) | ChannelAdapter 接口不变；InboundRouter 改 drain 目标 | 小 |
| [confirmation-ux.md](./confirmation-ux.md) | 远程确认卡片回执走 Outbox；Step 20 规划受益 | 待补 |
| [turn-context-injection.md](./turn-context-injection.md) | 无影响 | — |
| CLI REPL | Outbox 注入但终端适配器延后；不改用户可见行为 | 小 |

---

## 八、实施路线

### Phase 1 — Outbox 基础设施

**目标**：打通管道，无行为变化（仍会出现倒转）

1. 新增 `@zhixing/core/delivery/outbox.ts` + `outbox-registry.ts`，实现 INV-1/2/5/6/7
2. DeliveryPipeline drain：`sender.send` → `registry.of(target).post`
3. InboundRouter LLM 回复：`adapter.send` → `registry.of(target).post`
4. 单元测试：并发 post 保序、registry 生命周期

**验收**：所有回归测试通过；观察日志中 `entry:enqueued` / `entry:sent` 事件串联。

### Phase 2 — Tool-authored Commitment

**目标**：修复观察到的 5s 倒转现象（常规情况）

1. 扩展 ToolExecutionContext：`commitToUser`、`emissionTarget`
2. 扩展 ToolResult：`committedToUser`
3. 改造 schedule 工具：create 成功 → commitToUser + committedToUser=true
4. 更新系统提示：committedToUser 时抑制叙述
5. 集成测试：5s 提醒 E2E 验证顺序

**验收**：飞书 E2E "5秒后提醒我"，commitment 早于 task fire（常规 LLM 延迟下）；无 conv_xxx 新增（16e 复核）。

### Phase 3 — Turn Slot 因果锁

**目标**：即使 LLM 超时/违反 prompt 也保证顺序正确

1. 引入 `TurnId` 类型，ConversationManager 在 turn 开始时生成
2. AgentLoop 将 turnId 透传给 ToolExecutionContext
3. schedule 工具将 turnId 存入 `task.createdInTurn`
4. Scheduler 投递时，DeliveryPipeline entry 带 `afterSlot: task.createdInTurn`
5. ConversationManager 的 turn 开始/结束对接 Outbox.openSlot/fillSlot/abandonSlot
6. Outbox drain 实现因果阻塞（INV-3）

**验收**：故意构造"LLM 超时 > 任务延迟"的测试，task fire 仍在 LLM 回复后出现。

### Phase 4（可选 / 未来）

- inflight 重试（增强 INV-6 的健壮性）
- Outbox 持久化（为"服务器崩溃时 LLM 回复也不丢"的场景）
- REPL 终端适配器化（配合 Step 19 流式卡片）

---

## 九、测试策略

### 9.1 单元测试（@zhixing/core）

- Outbox FIFO：并发 post 10 条，出队顺序等于入队顺序
- Slot 阻塞：post(afterSlot=S)，fillSlot(S) 之前不出队
- Slot 超时：openSlot → ttl 超时 → dependents 放行
- Slot abandon：openSlot → abandonSlot → dependents 放行 + warn 事件
- 孤儿 slot 引用：post(afterSlot=不存在) → 放行 + error 事件
- Adapter 失败：emit failed 事件 + inflight 清空
- 多 target 独立性：A 卡死不影响 B

### 9.2 集成测试（@zhixing/server）

- InboundRouter → Outbox：LLM 回复进入 Outbox 后到达 adapter
- Pipeline → Outbox：Scheduler 结果经 Pipeline 后到达 Outbox
- 双生产者并发：LLM 回复 + Scheduler 投递同时 post，FIFO 顺序正确
- Slot 协同：ConversationManager turn 开始/结束 → Outbox slot lifecycle

### 9.3 E2E 测试（飞书）

- "5秒后提醒我"：commitment 早于 task fire（Phase 2）
- 模拟 LLM 10s 延迟（注入 mock provider）：task fire 仍在 LLM 回复后（Phase 3）

---

## 十、非目标（明确不做）

| 非目标 | 理由 |
|--------|------|
| Outbox 做复杂重试策略 | 重试是 Pipeline 的职责，Outbox 保持纯净 |
| Outbox 持久化（Phase 1-3） | 大多数 entry 不需要；Pipeline 为持久性路径兜底 |
| 跨目标的全局 total order | 不同用户时间轴互相独立，全局 order 无业务意义 |
| 优先级队列 | FIFO 的简单性是核心价值；优先级由生产者侧通过入队时机表达 |
| 去重 / 幂等 | 仅通过 `idempotencyKey` 字段 opt-in，不强制 |
| 替代 DeliveryPipeline | 两者职责正交，Outbox 是顺序层，Pipeline 是持久层 |

---

## 附录 A：与行业方案对照

| 系统 | 机制 | 映射到知行 |
|------|------|-----------|
| Slack / Linear | 每个对话时间轴单消费者 | 每 target 一个 Outbox |
| Claude Code / Cursor | Tool-authored UI，LLM 不叙述 | Phase 2 commitment 模式 |
| Temporal / Airflow | 子任务 happens-after 父 commit | Phase 3 Turn Slot |
| Akka / Erlang actor | Mailbox 单消费者 | drain 单 goroutine |
| Event Sourcing | 单一 log，projection 按序 | Outbox per target = local log |
| Reactive UI (Redux/Elm) | 单 store，多 effect dispatch | Outbox 是 target 的 store |

**核心共性**：所有顶级方案都把"谁拥有时间轴"作为一级概念。知行的 Outbox 是对这一范式的本地应用。
