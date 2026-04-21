# ADR-007: 消息 Outbox 与因果排序

> **状态**: 接受 | **日期**: 2026-04-21

## 背景

Serve 模式下观察到稳定复现的顺序倒转：用户在飞书发 `"5秒后提醒我"`，Bot 先回"时间到了"，后回"已经创建了定时任务"。**动作先到、承诺后到，因果倒置**。

根因在于系统存在两条独立的消息出口：

1. **用户回复路径**：InboundRouter → ConversationManager → LLM 两轮推理 → `adapter.send()` 直调
2. **定时投递路径**：Scheduler → ephemeralRuntime → DeliveryPipeline → `adapter.send()`

两条路径**没有任何共享的协调层**。DeliveryPipeline 是全局 FIFO + 按优先级排序，无 per-user 保序；LLM 回复甚至完全不经 Pipeline。adapter.send 的并发调用也没有任何串行化保证。

这不只是一次偶发 bug。系统正在演化为**多生产者单消费者（用户时间轴）**的架构，即将加入的生产者包括：

- Step 17 Daemon 的主动消息（晨报、状态汇报）
- Step 18 Active Hours 的延迟投递
- Step 19 流式卡片的 UI 更新
- Step 20 远程权限确认卡片回执
- 未来的 Journal 凝练回执、外部 webhook 触发

**没有一个组件承担"此用户的时间轴所有者"这一职责。生产者越多，混乱越严重——非线性恶化。**

横向对照行业方案：

- Slack / Linear：每个对话有单消费者时间轴，所有生产者入队到同一 edge
- Claude Code / Cursor：Tool-authored UI 范式——工具效果可视，LLM 不叙述
- Temporal / Airflow：子任务 happens-after 父 commit 的显式因果依赖
- Akka / Erlang：per-actor mailbox 单消费者
- Event Sourcing：单一 log，projection 按序消费

**共性**：顶级系统都把"谁拥有时间轴"作为一级概念。知行目前缺失这一层。

## 决策

引入 **Message Outbox** 作为所有用户出口消息的顺序层。Outbox 是 per-target 的单消费者 FIFO，叠加在 `ChannelAdapter.send` 之上；所有生产者（LLM 回复、Scheduler、Tool commitment、未来 Daemon）经由 Outbox 发送。叠加 **Tool-authored Commitment** 范式和 **Turn Slot** 因果依赖，三层协同保证顺序正确。

### 决策 1：Outbox 作为顺序层，不替代 Pipeline

DeliveryPipeline（现有）负责**持久性**——崩溃恢复、重试策略、过滤器链。Outbox 负责**顺序性**——per-user FIFO、因果依赖、承诺占位。两者职责正交。

```
生产者 → [DeliveryPipeline（可选：持久性）] → Outbox → ChannelAdapter.send
```

Pipeline 的 drain 目标从 `adapter.send` 改为 `outbox.post`。LLM 回复路径不需要持久性，直接 post 到 Outbox。

**为什么不扩展 Pipeline 去做保序**：Pipeline 的存在理由是持久化 + 重试，它的队列语义是"可失败可重试"，天然与严格 FIFO 顺序性冲突（重试会打乱顺序）。保留 Pipeline 的角色纯净，让 Outbox 专注顺序——职责单一原则。

### 决策 2：Tool-authored Commitment

工具的执行反馈直接由工具自己产生 commitment 消息，**不委托给 LLM 做二轮推理叙述**。

扩展 ToolExecutionContext：

```typescript
interface ToolExecutionContext {
  // 既有：workingDirectory, abortSignal
  readonly turnId?: TurnId;                // 当前 turn 唯一标识
  readonly emissionTarget?: DeliveryTarget; // 用户目标
  readonly commitToUser?: (content: OutboundContent) => Promise<DeliveryResult>;
}

interface ToolResult {
  // 既有：content, isError
  readonly committedToUser?: boolean;  // LLM 应抑制叙述
}
```

系统提示补一条："收到 `committedToUser: true` 时用户已看到工具反馈，不要重复叙述，无其他信息可直接结束本轮。"

**对标 Claude Code 核心范式**：tool 输出作为 UI 事实，LLM 仅在有额外信息时发言。工程上这个改动比"让 LLM 不说话"的 prompt hack 稳定得多——改工具协议是结构约束，改 prompt 是软约束。

### 决策 3：Turn Slot 因果依赖

跨路径的因果关系通过 **Turn Slot** 表达。每次用户 turn 开始时在该 target 的 Outbox 里开一个 slot；turn 内创建的定时任务记录 `createdInTurn` 字段；任务触发投递时带 `afterSlot: createdInTurn` 标签；Outbox drain 时阻塞直到对应 slot 进入终态。

```typescript
interface OutboxEntry {
  // ...
  readonly afterSlot?: TurnSlotId;
}
```

Slot 状态机：`pending → filled | abandoned | expired`。任何终态都会释放下游 entry——保证**不会无限阻塞**（INV-4）。TTL 默认 10 分钟。

**为什么不仅靠 Commitment 范式解决**：Commitment 修的是"常规情况"——LLM 遵守 prompt 时 OK，违反 prompt（尤其小模型、长上下文）时仍可能出现新的 LLM 叙述晚于任务触发。Turn Slot 是**结构性**保证，不依赖模型合规。两层协同才能实现"即使 LLM 失控，用户看到的顺序依然正确"。

### 决策 4：per-Target 粒度，不做全局 total order

Outbox 以 `(channelId, to)` 为键。不同用户、不同 channel 之间**无同步约束**，可完全并发。

**为什么不做全局 total order**：不同用户的时间轴互相独立，全局排序无业务意义；且单消费者全局化会极大限制吞吐。Slack / Linear / Akka 都是 per-target 粒度。

### 决策 5：CLI 与 Server 共用同一原语

Outbox 实现放在 `@zhixing/core/delivery/outbox.ts`。REPL 和 serve 共用，不做分叉实现。

**理由**：

- DeliveryPipeline 本就是 REPL/serve 共享，Pipeline 改造自然要求 REPL 和 serve 一起跟进
- REPL 当前单线程无并发只是运行时事实，代码路径始终是多生产者结构；Step 19 流式卡片接入 CLI 后 REPL 立刻有真实并发
- Outbox 对单生产者场景退化为 no-op，零行为变化、零性能开销

REPL 终端渲染器**不立刻**包装为 ChannelAdapter——终端渲染与 Channel 协议耦合度低，强行适配引入无谓复杂度。等 Step 19 流式卡片需要时一起做。

### 决策 6：Outbox 不做内部重试

adapter.send 失败时，Outbox emit `entry:failed` 事件并清空 inflight，**不做内部重试**。重试责任在上游——Pipeline 通过事件决定是否 requeue（会产生新 entry 排到队尾）。

**为什么不内部重试**：重试保留头部（阻塞 FIFO）会让单条失败拖死整个用户的输出；重试弹出头部（让后续 entry 先走）会破坏 FIFO。两种选择都需权衡，应由上游根据业务语义决定，而非 Outbox 统一强制。

Outbox 为 adapter.send 加超时包装（默认 30s），防止 channel 卡死导致 drain 永久阻塞——这是**防卡死**不是**重试**。

## 为什么这样做

### 为什么引入一级概念"用户时间轴所有者"

系统已观察到顺序问题，且即将有 5+ 个新生产者上线（Step 17-20）。若不在 Daemon 之前引入 Outbox，每个生产者都会自己想办法绕路 adapter.send，最终形成难以追溯的网状依赖，顺序问题变成架构级痼疾。

**现在改是 40 行级别的插入；Daemon 后改是跨多个模块的重构**。时机窗口只在当下。

### 为什么三层协同（Outbox + Commitment + Turn Slot）

- 单独 Outbox：FIFO 但 LLM 慢时仍倒转（因为 LLM 慢 → LLM 回复晚入队 → task fire 早入队）
- Outbox + Commitment：修常规情况（LLM 合规情况下，commitment 立即入队，LLM 最终无文本输出），但不能保证小模型合规
- Outbox + Commitment + Turn Slot：结构保证（slot 占位让 task fire 必然等 turn 完成），bullet-proof

三层是纵深防御（defense in depth），上层修体验、下层保正确性。

### 为什么不做 Phase 4（inflight 重试 + 持久化）

- inflight 重试会让单生产者故障放大为全用户出口阻塞（运维灾难）
- Outbox 持久化改善的是"服务器崩溃时 LLM 回复也不丢"——这个场景用户可重发，收益小成本高
- 保持 Outbox 简单、纯粹，是长期可维护性的关键

## 替代方案

### A：只改 Prompt，不引入 Outbox

告诉 LLM "调用 schedule 后不要叙述"。

- 优势：改动最小，一行 prompt
- 劣势：软约束，小模型 / 长上下文下容易违反；不能应对 Daemon / Active Hours / 流式卡片等后续多生产者场景；治标不治本
- 未采用原因：用户明确"第一优先级是最佳架构、最佳设计方案、稳定性"，prompt hack 与长期价值背道而驰

### B：扩展 DeliveryPipeline 做 per-user 保序

把 Pipeline 的全局 FIFO 改为 per-target FIFO。

- 优势：复用现有组件，不新增抽象
- 劣势：Pipeline 承担了"持久性 + 顺序性"两份职责，重试/backoff 与严格 FIFO 本质冲突；LLM 回复路径仍需改造走 Pipeline（而 Pipeline 的持久化对 LLM 回复是浪费）
- 未采用原因：违反单一职责，耦合死锁

### C：per-target 锁

在 adapter.send 外层加 per-target mutex，强制串行化。

- 优势：极简单
- 劣势：只能保证"同一时刻一个在发"，不能解决"顺序"——两个生产者的到达顺序仍由调度决定；没有因果标签能力
- 未采用原因：不解决根本问题

### D：完整 Event Sourcing 重写

全系统改造为 event sourced，所有消息过单一 log。

- 优势：顺序问题不复存在
- 劣势：侵入全系统，重写成本巨大；与 LLM streaming 语义不匹配；知行当前规模用不着
- 未采用原因：远超必要复杂度

## 影响

### 受影响的设计文档

| 文档 | 变更 |
|------|------|
| [message-outbox.md](../../specifications/message-outbox.md) | **新建**（本 ADR 的详细规格） |
| [persistent-service.md](../../specifications/persistent-service.md) §4.7 | DeliveryPipeline drain 目标说明更新；新增章节引用 Outbox |
| [conversation-model.md](../../specifications/conversation-model.md) | 引入全局 TurnId 字段；turn lifecycle 对接 Outbox slot |
| [ADR-004 工具系统](004-tool-system-architecture.md) | ToolExecutionContext + ToolResult 扩展 |
| [server-gateway.md](../../specifications/server-gateway.md) | InboundRouter drain 目标改变（细节小） |
| [confirmation-ux.md](../../specifications/confirmation-ux.md) | Step 20 远程卡片回执走 Outbox |

### 实施阶段

- **Phase 1**：Outbox 原语 + 所有生产者归一。无行为变化，铺管道。
- **Phase 2**：Tool-authored commitment + schedule 工具改造 + prompt 更新。修复观察到的常规 inversion。
- **Phase 3**：Turn Slot 因果标签 + ConversationManager 集成。结构保证顺序正确。
- **Phase 4（可选）**：inflight 重试、Outbox 持久化。当前不实施。

依赖 Step 16e ephemeral execution 已完成（2026-04-20）。**Phase 1-3 必须在 Step 17 Daemon 之前完成**——否则 Daemon 的新生产者会把顺序问题放大到整条产品线。

### 约束

- Outbox 不得嵌入重试策略（与 Pipeline 职责重叠）
- ToolExecutionContext 的 `commitToUser` 在 CLI REPL 场景下为 undefined（无 channel）；工具必须支持两种代码路径
- Slot TTL 有明确上限（默认 10 分钟），不允许生产者请求无限 TTL——防止孤儿 slot 阻塞

## 相关决策

- 依赖：[ADR-004 工具系统架构](004-tool-system-architecture.md)（ToolExecutionContext 扩展点）
- 启用：Step 17 Daemon、Step 19 流式卡片、Step 20 远程确认
- 关联：[conversation-model.md](../../specifications/conversation-model.md) Turn 概念

## 引用

- [消息 Outbox 详细规格](../../specifications/message-outbox.md)
- [持久化服务设计方案 §4.7 Delivery Pipeline](../../specifications/persistent-service.md)
- [implementation-roadmap.md Step 16.9](../../implementation-roadmap.md)
- 对照行业方案：Slack per-channel timeline、Claude Code tool-authored UI、Temporal happens-after、Akka actor mailbox、Event Sourcing
