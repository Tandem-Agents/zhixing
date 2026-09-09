# 消息 Outbox 与因果排序

Outbox 是消息投递的进程内顺序层：同一目标的多个生产者共用一条发送队列，并用 Slot 表达跨路径依赖。它不拥有投递的耐久事实、重试决策或结果裁决。

## 一、需求与设计理由

用户说“5 秒后提醒我”，定时结果可能先于模型生成的“已创建提醒”到达。问题不是模型太慢，而是两条消息路径没有共同的顺序责任。正确性不能依赖模型速度或遵守“不再叙述”的提示词。

必须区分串行发送、因果顺序与可靠投递：

| 机制 | 能解决什么 | 不能代替什么 |
|---|---|---|
| 每目标单消费者队列 | 同一目标的发送尝试串行化，不同目标独立 | 晚入队的前置回复仍可能被抢先，单纯 FIFO 不知道因果关系 |
| Slot 与 `afterSlot` | 前置回复插到依赖消息之前，显式等待前置条件 | 内存状态不能代替崩溃恢复与耐久投递事实 |
| 权威 Delivery | 记录 intent、尝试、结果与恢复，裁决重试和不确定结果 | 不应在传输适配器再复制一套业务状态机 |

原设计将持久性与顺序性分开，这一取舍仍成立；旧 `DeliveryPipeline`／`DeliveryQueue`／`delivery-queue.json` 已退役，不能继续作为现行持久层。当前权威 Delivery 也不是旧队列改名：领域应用负责状态判断，日志与正确性接口负责耐久提交，效果适配器只返回发送证据。

| 替代思路 | 取舍 |
|---|---|
| 只修改模型提示词 | 软约束不能证明消息顺序，不能作为正确性底座 |
| 仅在 send 外加锁 | 防止同时发送，但无法表达“任务结果必须晚于创建它的回复” |
| 全局消息排序 | 不同用户时间轴无此同步要求，会引入无关阻塞；按目标隔离即可 |
| 在 Outbox 内加入持久化与重试 | 与权威 Delivery 重复所有权；退避与不确定结果需要领域裁决，不归通用队列 |
| 为保序重写整个系统 | 单个顺序问题不要求全系统重写；当前已存在权威日志，应复用而非再造第二份 |

这些比较保留原 ADR 的有效设计理由，不把未经独立证实的外部产品类比作为架构正确性的证据。

## 二、当前职责与调用链

```text
会话／Job 权威提交：结果与投递意图
    → Delivery 耐久状态及恢复
    → AuthorityDeliveryPipeline 驱动领域应用与有限发送效果
    → ChannelDeliveryEffect
    → OutboxRegistry → 每目标 Outbox → Channel send
```

| 组件 | 责任与边界 |
|---|---|
| Delivery application／权威日志 | 准入、claim、attempt、幂等身份、结果、重试／不确定裁决；Outbox 事件不是耐久事实 |
| AuthorityDeliveryPipeline | 消费待办，调用领域应用与 transport，按证据提交结果；不是旧 delivery queue |
| ChannelDeliveryEffect | 观察渠道 readiness，将 Delivery source 与幂等键映射到 Outbox；不取得渠道管理权 |
| OutboxRegistry | 注入有限 doSend，按目标懒创建、回收与排空；不自行发现或注册渠道 adapter |
| Outbox | 队列、Slot、一次发送尝试及事件；不做业务过滤或内部重试 |
| InboundRouter | 渠道输入开始执行时开 Slot；权威非空回复交由 Delivery 发出，明确空完成才直接填空 Slot |

Registry 的 key 为 `(channelId, to)`，`threadId` 不入键，同一接收目标的不同 thread 共用队列。不同目标不需要全局全序；共享上游资源仍可能影响整体并发，不能承诺“零开销”。

CLI Host 的 `setup-delivery.ts` 装配共享效果与 Registry，渠道接入面消费同一实例。共享原语不等于所有产品表面都要包装成 Channel：终端渲染与会话协议投影保留各自职责。权限确认是解除运行阻塞的控制流，不能排在它正在阻塞的 Slot 后；确认与普通消息的不同出口是有意的边界，而不是宣称所有发送一律经过 Outbox。

## 三、身份、队列与因果规则

`OutboxEntry` 包含 id、target、content、source、enqueuedAt，以及可选 `afterSlot` 和 `idempotencyKey`。source 区分回复、工具反馈、定时任务、系统消息；它说明消息来源，不代替目标选择或权限身份。

`TurnSlotId` 与渠道 turn 身份关联，用于跨组件因果引用，不是会话内显示序号，也不能据旧字段名把一次模型调用与完整运行混为一谈；术语见[生命周期概念](../../architecture/lifecycle-concepts.md)。

- Scheduler source 的 `createdInTurn` 映射为 `afterSlot`。
- agent source 的 `turnSlotId` 由 ChannelDeliveryEffect 调 `fillSlot(slotId, entry)`，将前置回复送入同一队列。
- 耐久 Delivery 来源必须带原 item 的幂等键，重驱不能换键；Outbox 只传给发送端，不维护权威去重表。非耐久 entry 的类型字段仍可选。

每个 Outbox 只有一个 drain。队首依赖 pending Slot 时等待状态信号，不忙循环；不同目标各自 drain。`fillSlot` 带 entry 时先插入到第一个同 Slot 等待者之前，再关 Slot 并唤醒；无等待者则追加。

这不是“所有 entry 永远严格按入队时刻 FIFO”：前置回复必须越过已经入队的依赖项。插入也可能越过排在该依赖项之后的无关项；原有队列项彼此顺序不变，不能把它描述为回复绝不越过任何无关消息。

## 四、Slot 合同与当前实现边界

权威投递合同要求：final/status item 已耐久接管后，只能由对应权威发送路径填充或明确空终态关闭 Slot，入口收尾不得提前 abandon。目的在于让依赖结果排在前置 final/status 之后，不能把“内存 Slot 已终态”当作“前置消息已送达”。

当前原语与宿主的行为如下，限制不能冒充合同已经闭合：

| 情形 | 当前行为 |
|---|---|
| `openSlot` | 同 ID 已存在时不重复开；默认 TTL 十分钟，显式 `ttlMs <= 0` 可禁用 |
| pending Slot 被 fill | 可带回复插队，随后标 filled；不带内容时只关闭 |
| 未知／已终态 Slot 被 fill 且带 entry | 剥去该 entry 的 afterSlot，退化为普通 post，不吞掉消息，但不恢复已丢失的因果约束 |
| abandon／TTL expired | 原语释放依赖并产生因果断链事件，不等于权威认可前置消息已完成 |
| 孤儿 afterSlot | 原语记录断链并放行；可能来自实例回收或进程恢复，不能单凭“未知”证明前置已发送 |
| 渠道权威回复 | InboundRouter 不在 authoritative 收尾分支 abandon；非空由 ChannelDeliveryEffect fill，completed 且无内容时填空 |

生产 `onStarted` 调 `openSlot({ slotId })`，当前装配未覆盖默认 TTL，因此十分钟到期仍可能提前释放权威依赖。这与上述权威合同存在差异，不能保留旧稿“任何终态放行即可保证因果”的结论。

另一个边界是 fill 在发送完成前关闭 Slot：若前置发送失败，Outbox 清除 inflight 后继续 drain，而不是等待该前置消息的权威重试成功。因此当前原语证明的是尝试排序，不是失败／超时／重启情况下无条件的用户可见送达顺序。迁移文档保留更强的产品要求，并明确现状，不在本次文档任务中整改代码。

## 五、失败、恢复与生命周期

`post` 的 Promise 可以 resolve 一个 `success:false` 的 DeliveryResult，也可能 reject；resolve 不等于成功到达用户。发送默认 30 秒超时，采用 Promise.race，不会取消底层发送，所以超时后仍可能发生外部效果，不能宣称“要么成功，要么完全未发送”的原子性。

Outbox 不内部重试：成功产生 sent，失败产生 failed，最终清除 inflight，交回上游。权威 Pipeline 对明确失败提交结果；传输抛错保留未知结果交恢复策略裁决，不能直接认定未送达并盲目重发。重试仍复用原 Delivery 幂等身份，适配器是否支持去重与响应丢失证据是独立合同。

Outbox 与 Slot 是内存结构。崩溃后的耐久投递从权威 Delivery 状态恢复，而非从旧 JSON 队列恢复；不能再把渠道最终回复丢失解释成“用户重发即可”。内存 Slot 不随日志自动重建，恢复后的因果连续性不能仅凭耐久消息仍在就宣告成立。

Registry 的 `reapIdle` 按空闲时间与 Outbox.isIdle 判断回收；`dispose` 等待各实例 waitIdle 后清空，不是强制取消。Host 先停止权威投递驱动再排空 Registry。Slot timer、等待者、发送超时与日志／事件回调不得引入忙循环；现有原语对观测回调异常做隔离。停机不等于已证明所有外部发送完成。

事件包括 entry 入队／发送／失败、Slot 开启／终态及因果断链。它们用于观测进程内执行，不提供耐久审计或替代权威结果。

## 六、工具直接反馈的取舍

早期方案让 schedule 工具先发送“已安排”，再用 commitment 信号要求模型不重复叙述。实际出现工具反馈、模型重复确认、任务结果三条消息，增加了噪音；因果 Slot 已负责排序，不应再依赖提示词抑制来保证正确性。

当前 schedule 不主动调用 `commitToUser`，由模型正常回复与后续任务结果表达产品事实。工具反馈 API、`committedToUser` 与 `COMMITMENT_SIGNAL` 仍存在，工具执行器将信号写入模型可见内容，系统提示要求避免重复。它们是可选反馈机制，不是必须开启的三层防御，也不赋予工具绕过统一效果与权限边界的权利。

## 七、验证与实现入口

必要验证应分别识别：每目标隔离、回复插入与因果等待、未知／过期／abandon 的断链、失败返回和抛错、超时后的未知效果、幂等键透传、权威恢复及确认控制流不死锁。只测成功路径 FIFO，不能证明用户最终看到的顺序；原有历史测试数量不作当前验收证据。

- [Outbox](../../../packages/core/src/delivery/outbox.ts)、[类型及事件](../../../packages/core/src/delivery/outbox-types.ts)、[Registry](../../../packages/core/src/delivery/outbox-registry.ts)。
- [渠道效果映射](../../../packages/core/src/delivery/channel-effect.ts)、[Delivery 应用](../../../packages/core/src/delivery/application.ts)、[权威投递驱动](../../../packages/core/src/delivery/authority-pipeline.ts)。
- [Host 装配](../../../packages/cli/src/setup-delivery.ts)、[渠道输入与回复投影](../../../packages/server/src/channels/inbound-router.ts)。
- [权威终态投递合同 §5.5](../../../research/design/modules/distributed-runtime/specification.md#55-终态与状态投递)、[远程确认控制流](../../../research/design/specifications/remote-confirmation-execution.md)。

本文只定义消息顺序层及其直接交界，不展开整个调度、渠道、权限或分布式架构；不新增全局排序、第二份持久化、内部重试框架或终端 Channel 化。
