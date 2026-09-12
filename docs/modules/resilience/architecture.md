# 容错与模型调用恢复

## 目标与职责

个人智能体不能要求用户盯住每次调用并手工恢复：暂时性失败应在安全边界内自动重试，无法恢复时必须形成可见结果，不能静默失联。不同会话的故障不应互相拖垮。这些要求适用于 CLI 和常驻通道，不以某个尚未接入的通讯产品为前提。

容错不是把整个系统包进一个重试循环。模型请求重试、通道重连、消息耐久处理和服务恢复各有自己的成功条件与副作用边界；可复用退避和失败计数原语，但不能据此推导它们已共用同一恢复状态机。本文负责模型调用容错及其直接交界，不定义消息队列、服务生命周期或持久化恢复。

核心取舍是将协议适配与恢复策略分开：Provider 负责请求和流事件转换，调用装配处注入重试，推理循环不承担厂商错误策略。独立原语避免各调用点重复编写退避算法；事件表达恢复过程，产品表面决定呈现方式，不把内部机制交给用户组装。

## 当前生产链

`createAgentRuntime` 在每个 Run 内把主角色的 `provider.chat` 包装为 `withRetry`，交给 Kernel 的模型调用链；段切换摘要另由 `makeSegmentStreamFactory` 装配同类保护，覆盖自动切段与手动整理。两者使用各自的包装器，不共享一个全局熔断器。摘要的模型与连接归属见[模型角色](../providers/model-roles.md)。

职责分界：

| 责任 | 当前归属 |
|---|---|
| 原始 SDK 错误、协议与流事件转换 | [Provider](../providers/architecture.md)；SDK 自带重试不等于本层重试，也不能假定已关闭 |
| 错误分类、退避、熔断与内容输出前重试 | `core/src/resilience`，由 orchestrator 装配 |
| 流空闲监测、中止竞争与退出 | `core/src/interrupt` 与模型流消费链；不是重试包装器的超时计时器 |
| 已接受运行的提交、终态和重启恢复 | 会话 owner 与[运行生命周期](../conversation/runtime-lifecycle.md)、[持久化](../conversation/persistence.md)，不由请求重试替代 |
| 恢复过程呈现与最终失败投递 | 事件投影、CLI 和通道各自的产品路径，不由 `withRetry` 直接发送用户消息 |

## 安全重试边界

`withRetry` 同时处理生成器抛错和 `error` 事件。可恢复错误先被扣留，尝试恢复后才决定是否向消费者发出最终错误；普通流事件仍向下游透传，并不缓存整次响应。

- 已流出文本、思考或工具调用内容后，不再自动重新请求，避免重复输出或重复工具调用。`text_delta`、`thinking_delta`、`tool_call_start/delta/end` 都会关闭本次重试窗口；仅有用量事件不会关闭。
- 不可重试错误、次数耗尽或熔断拒绝，终止该调用并向上游暴露错误。重试不负责改模型、换凭证、切 Provider、压缩上下文或重放已执行工具。
- 请求的中止信号在尝试前与错误处理前检查；已中止时退出，不把主动终止当作网络故障重试。退避等待当前监听的是 `config.abortSignal`，不是自动使用 `request.abortSignal`；生产装配未传该配置，故不能承诺等待会被请求取消立即唤醒。外围流退出由中止保护链负责，不能等同于内部等待已停止。
- 空闲 watchdog 负责触发中止，不能把它描述成“60 秒超时后自动重试一次”。连接或超时错误只有在未输出内容、未中止且配置允许时才进入重试。

## 分类、退避与熔断

分类不依赖 SDK 类：先识别 AbortError，再检查 HTTP 状态、网络错误码及消息启发式，最后归为 unknown。当前 401/403 属于认证错误，429 属于限流，408 属于超时，413 属于上下文溢出，500/502/503/529 属于 Provider 错误；连接错误也在恢复覆盖范围内。

生产装配使用默认配置：首次调用外最多重试 3 次，允许 `rate_limit`、`timeout`、`network`、`provider_error` 和 `unknown`。认证、无效请求、上下文溢出及主动中止不在默认可重试集合中。源码虽另有 `getRecoveryStrategy` 分类次数表，`withRetry` 不消费它；不能把表中次数当作实际执行策略。

退避默认基数 500ms、指数增长、上限 30,000ms，并使用 Full Jitter 分散重试时机。错误中可识别的 Retry-After 优先于计算值，支持秒数或日期；这条分支不受上述指数退避上限约束，因此“有界”在此保证的是尝试次数，不是统一的总耗时上限。

熔断器由包装器创建，默认连续失败阈值为 `maxRetries + 1`，成功清零；调用方也可显式传入实例。默认未设冷却期，熔断后不会自行恢复。原语支持配置冷却时间后进入 half-open，但当前 `isAllowed` 不预占探测名额，不能声称已保证并发时仅放行一次探测。生产主调用包装器在 Run 内创建，不能描述为每个会话长期持有或跨会话共享的熔断状态。

## 反馈与可靠性边界

`retry:attempt` 表达尝试次数与等待时间，`retry:success` 表达恢复成功，`retry:exhausted` 表达耗尽或熔断拒绝。它们经会话事件投影进入 RPC，CLI 渲染器和状态条已有消费者；并非每个不可恢复错误都会发出 exhausted。success 中 `totalDelayMs` 当前为 0，占位值不能当成真实累计延迟。

用户消息应得到回复，失败也应有交代。短暂恢复不打扰用户，持续等待应反馈处理中，最终失败必须明确告知；但 retry 事件本身不证明通道已完成这些通知，也没有统一的 10/30 秒通知合同。消息至少一次交付、重连期间缓冲、最终降级回复与跨会话故障隔离，分别由消息、通道和服务责任链保障，不能仅凭模型请求重试推导为全部已实现。

当前模型重试链没有 Provider/model failover，也没有通过非流式回退恢复流请求。模型请求、消息处理、通道连接和服务进程的恢复责任须分别闭合；算法可以复用，故障状态与副作用边界不能混为一体。服务与中断职责分别见[常驻服务](../../../research/design/specifications/persistent-service.md)与[中断执行](../interruption/architecture.md)。

## 实现定位

- [重试包装器](../../../packages/core/src/resilience/with-retry.ts)、[配置](../../../packages/core/src/resilience/types.ts)、[错误分类](../../../packages/core/src/resilience/classify.ts)、[退避](../../../packages/core/src/resilience/backoff.ts)、[熔断器](../../../packages/core/src/resilience/circuit-breaker.ts)。
- [运行装配](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)、[流 watchdog](../../../packages/core/src/interrupt/watchdog.ts)。
- [会话事件投影](../../../packages/rpc/src/session-events.ts)、[CLI 渲染](../../../packages/cli/src/render.ts)、[状态条](../../../packages/cli/src/status-bar/status-bar.ts)。
