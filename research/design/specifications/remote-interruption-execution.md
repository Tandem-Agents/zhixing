# 远程中断(Remote Interruption)执行规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文档是执行规格(execution spec),不是修订日志。**
>
> **只写**:
> - 当前生效的架构、方案、执行计划
> - 架构决策及其"为什么"(帮助理解当前设计)
> - 与真实代码的对接点(精确到文件路径 + 行号)
>
> **不写**(协作者修订时一并清理,不要叠加):
> - 版本号、状态徽章、修订日期、"最后更新"行
> - `修订要点 / 修订历史 / vX.X vs vY.Y` 对比表
> - 决策演化标签(`v1.0 错误 / v2.0 修正 / v2.1 新增` 等)
> - 废案与新案的对比
> - 决策追溯链("当初这么想 → 后来审查发现 → 于是改成"这种叙事)
>
> **演化方式**:设计变化时**原地修改**,不追加"v2.1 修订段"。历史与演化留给 `git log`,不在本文。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **文件作用**:本文档是知行**远程中断**(server / RPC / scheduler / 飞书等非 CLI 直连入口)模块的权威执行规格——补全主模块 [interruptible-agent-loop-execution.md](./interruptible-agent-loop-execution.md) 在 §0.4 中明确"不做跨进程 abort RPC"以及 §5.10 留白"server 路径未来工作锚点"两处的延伸设计。
>
> 本文做三件事:
> 1. 把主模块沉淀的中断协议(`InterruptController` / `AbortReason` / `interruptBehavior`)系统性接入 server / RPC / scheduler 入口
> 2. 设计飞书等异步通道的"主动中断"用户接口(`IntentClassifier` + 关键词识别 + 卡片按钮)
> 3. 修复 server 端"abort 名存实亡"的两层架构债——`SessionRuntime.abort` 仅设 flag 不中断 in-flight turn,且 `SessionAdapter` 调 `agentRuntime.run` 时未透传 `abortSignal`,使得即便修了 flag 问题、agent loop / LLM call / tool 执行依然在后台跑
>
> **前置规格**:
> - [interruptible-agent-loop-execution.md](./interruptible-agent-loop-execution.md) — 中断协议层(必读,本文档**继承其全部不变量与抽象**)
> - [conversation-model.md](./conversation-model.md) — Session / Turn 生命周期
> - [remote-confirmation-execution.md](./remote-confirmation-execution.md) — confirmation 在 server 端的对称扩展,本模块在 IntentClassifier 上与之协同
> - [persistent-service.md](./persistent-service.md) — daemon / scheduler / RPC 拓扑
>
> **已建基础(必读)**:
> - [packages/core/src/interrupt/](../../../packages/core/src/interrupt/) — 主模块产物(types / controller / stream-race / watchdog / cleanup / assemble / graceful-kill),本模块直接复用
> - [packages/server/src/runtime/conversation-manager.ts](../../../packages/server/src/runtime/conversation-manager.ts) — Session 持有者,需扩展 abort 路由 + 新增 `abortAll`
> - [packages/cli/src/serve/session-adapter.ts](../../../packages/cli/src/serve/session-adapter.ts) — `SessionRuntime` 实现,abort 路径需重构(从 set flag 改为 fire signal),`agentRuntime.run` 入口需透传 `abortSignal`
> - [packages/server/src/channels/inbound-router.ts](../../../packages/server/src/channels/inbound-router.ts) — 飞书入站路由,需在 confirmation 检测**前**接入 `IntentClassifier` 的 cancel 前置识别
> - [packages/server/src/rpc/methods/session.ts](../../../packages/server/src/rpc/methods/session.ts) — RPC `session.abort` 方法(当前对 in-flight turn 失效),`session.send` connection close 路径需携带 typed `AbortReason`
> - [packages/cli/src/serve/ephemeral-executor.ts](../../../packages/cli/src/serve/ephemeral-executor.ts) — Scheduler / RPC 短期调用入口
> - [packages/cli/src/serve/command.ts](../../../packages/cli/src/serve/command.ts) — Scheduler 注册点 + `CleanupRegistry` 接入点
> - [packages/server/src/cleanup-registry.ts](../../../packages/server/src/cleanup-registry.ts) — 关停链 LIFO 容器,本模块的 graceful shutdown 通过它实现

---

## 0. 概念与背景

### 0.1 "远程中断"指什么——五类入口

主模块解决的是**CLI 直连用户**(单进程内 esc / Ctrl+C 键盘事件)的中断协议。本模块把同一套协议向**所有非 CLI 直连入口**扩展:

| 入口类型 | 触发源 | 用户视角 | 当前状态 |
|---------|--------|---------|---------|
| 飞书消息(关键词) | 用户在飞书发"取消" / `/cancel` | "我让 agent 停" | **不存在**——消息全走 agent 路径 |
| 飞书卡片按钮 | InteractiveCard `[取消]` callback | 同上(更显式 UI) | **不存在**——飞书路径无卡片 |
| RPC `session.abort` | IDE 插件 / CI / 其他系统 | "我的 client 让 agent 停" | **失效**——只设 flag,当前 turn 继续跑 |
| Scheduler shutdown | service graceful shutdown | "服务要重启,在跑的任务该停下" | **不存在**——scheduled task 不接 abort signal |
| Cron timeout | 定时任务上限触发 | "这个任务跑太久了,自动停" | **不存在**——同上 |

### 0.2 这个模块的作用——四层架构债

当前 server 路径的中断能力**完全失效或缺失**,且**设 flag 这层债只是表象**:

**A. SessionRuntime.abort 名存实亡**——[session-adapter.ts:169-171](../../../packages/cli/src/serve/session-adapter.ts#L169) 仅设 `aborted = true` flag,在**下一个 turn 开头**才检查([session-adapter.ts:54-65](../../../packages/cli/src/serve/session-adapter.ts#L54));当前正在跑的 turn 完全无感。

**B. 飞书路径不调 abort**——[inbound-router.ts:125-183](../../../packages/server/src/channels/inbound-router.ts#L125) 全程未调 `ConversationManager.abort`,飞书用户根本没有发出 abort 信号的入口。

**C. AgentResult.aborted.abortReason 在 channel 渲染层未消费**——主模块 M2 已经把 `abortReason: AbortReason` 字段加到了 aborted 分支(详见主模块 §3.3),但 [inbound-router.ts:419](../../../packages/server/src/channels/inbound-router.ts#L419) 与 [ephemeral-executor.ts:74-77](../../../packages/cli/src/serve/ephemeral-executor.ts#L74) 仍硬编码 `"处理被中止。"` / `"Aborted"`,飞书 / RPC 用户无法分辨"是我的网络慢"还是"是 agent 自己卡住"还是"服务重启了"。

**D. SessionAdapter 入口不透传 abortSignal——这是最深一层债**——[session-adapter.ts:90-101](../../../packages/cli/src/serve/session-adapter.ts#L90) 调 `agentRuntime.run({ messages, turnIndex, source, turnContext, onYield })` 时**完全未传 `abortSignal` 参数**。即便 RPC 路径已经在 [session.ts:112-114](../../../packages/server/src/rpc/methods/session.ts#L112) 通过 `connection.onClose` 触发 `abortController.abort()`,adapter 内部 listener 把 `turnAborted=true` 中断 yield 消费——**底层 agent loop / LLM call / tool 执行依然在后台跑到自然结束**,只是结果被丢弃。这意味着即便修好 A 层(把 flag 改成 fire signal),不修 D 层 abort 仍是空操作。

本模块要让:**(1) 飞书用户能在任意时刻通过文本/按钮要求 agent 立即停下;(2) RPC `session.abort` 真的中断 in-flight turn;(3) Scheduler graceful shutdown 时让正在跑的 cron task 走 cleanup 退出;(4) 所有上述路径产出的 abort 在 channel 侧呈现差异化、可解释的反馈**。

### 0.3 触发立项的真实问题

均可在当前代码路径上复现:

**问题 1 — 飞书"取消"消息被当作 agent 输入**:用户向 agent 发了一个长任务后改主意,在飞书发"取消",该消息被当作下一轮 user message 进入 agent,agent 回应"好的,要停哪个"——但**正在跑的 turn 完全没停**。根因:[inbound-router.ts:125-183](../../../packages/server/src/channels/inbound-router.ts#L125) 只检测 confirmation 回复,无 control intent 识别层。

**问题 2 — RPC client 调 `session.abort` 后 in-flight turn 不停**:IDE 插件用户点击"停止生成",server 收到 RPC,`ConversationManager.abort` → `session.runtime.abort()` 设 flag,**当前 turn 继续跑到 LLM 流结束**,直到下一次 `session.send` 时 flag 才被检查。即便修了 flag 问题,因为 `agentRuntime.run` 没收到 abortSignal,LLM call 仍跑到自然结束。根因:§0.2 A + D 两层债叠加。

**问题 3 — 飞书用户看到"处理被中止"不知道是为什么**:idle-timeout 触发 / context overflow / 上游服务重启 / 父 agent abort,任意被动 abort 路径都呈现统一文案"处理被中止。"。用户无法分辨原因。根因:§0.2 C。

三个问题表面独立,本质同一缺失:**server 端没有一条端到端贯通的"信号源 → 协议层 → 消费者 → 渲染层"中断链路**。

### 0.4 不做什么——范围边界

本规格**不做**以下能力,避免设计失焦:

- **不做"暂停-恢复"**——abort 是终止意图,暂停-恢复是另一类能力(state 序列化 + LLM history 恢复 + tool state 跨进程持久化),与中断语义正交
- **不做 turn 颗粒度的 abort**——一个 session 同时只允许一个 turn 在跑(主模块 §3.4 + conversation-model §5.3 已约束),无需 turnId 维度;`abort(sessionId, reason)` 自动定位到当前 turn 即可
- **不做"自然语言意图模型识别"**——`IntentClassifier` 只做关键词字面匹配,不引入 LLM 调用判定意图。理由:控制意图必须**确定性**(防止 model drift / 无意触发),且关键词足以覆盖 95% 场景
- **不做多语言关键词的全 i18n 框架**——P0 仅支持中英两种;其他语言后续按需扩展,但**接口一开始就为 locale-aware 留口子**
- **不做用户主动取消的二次确认**("你确认要取消吗?")——飞书用户发"取消"已经是显式动作。但保留**取消反馈**(`已停止处理。`),让用户知道动作已生效
- **不做 RPC 上的 abort 进度推流**——RPC `session.send` 已有 yield 流向 client,abort 触发时 partial 事件由主模块 cleanup 路径产出,client 收到流自然终止
- **不做"取消整个 session"**——session 销毁是 daemon 控制面的事(`session.dispose`),不属于用户中断协议
- **不动主模块协议层任何抽象**——本模块只**接线**和**新增渲染层**。`InterruptController` / `AbortReason` 类型 / `forkController` / `interruptBehavior` 0 修改;尤其**不在 `AbortReason.user-cancel.source` 字面量上扩 `feishu` / `card_button`**(那是 breaking change),用现有 `"rpc"` 字面量复用 + `external.origin` 自由字符串容纳所有"非 esc/ctrl-c"来源(详见 §2.4)
- **不区分 sender 的 cancel** —— 群聊场景下(`DEFAULT_BINDING_POLICY.group="per-group"`,多用户共享 conversationId),任何用户的 cancel 作用于整个 conversation 的 in-flight turn + pending queue,不按 `msg.from` 过滤。**这是 by design 的对话型 bot 简化**(群里大家一起跟 bot 对话,任何人叫停都合理);对应 confirmation 模块有 `originSender` 校验防误批准是因为 confirmation 是个体决策,而 cancel 是 conversation-level 终止意图,语义不同。若产品定位为任务型 bot(每个用户独立任务并存),需扩 `PendingTask` / `SessionRuntime.abort` / `ConversationManager.abort` 加 sender 过滤维度,留作 §8 后续锚点
- **飞书 channel 不在 abort 反馈中流式呈现 partial assistant 内容** —— 主模块 INV-5 partial 保留是**协议层**保证(`AgentResult.aborted` 的 yield 序列含 partial assistant_message),CLI 终端实时流式渲染 / RPC client 通过 yield 流自然拿到。飞书是非 streaming channel([inbound-router.ts:376](../../../packages/server/src/channels/inbound-router.ts#L376) 注释明示 inbound-router 不 forward yields),P0 反馈只输出 `formatAbortReasonZh(abortReason)` 文案。若产品需要在飞书 abort 反馈中附 partial 内容(如 "已停止处理。\n\n(已生成的内容:...)"),留作 §8 后续锚点

### 0.5 与主模块、与既有 server 组件的关系

| 现有组件 | 当前角色 | 本规格上线后 |
|---------|---------|-------------|
| 主模块 `InterruptController` / `forkController` | CLI 路径已用 | server 路径同样使用,通过 `createInterruptController({ parent: abortSignal })` 接入外部 signal |
| 主模块 `AbortReason` 判别联合 | 已有 4 种 kind:`user-cancel` / `idle-timeout` / `parent-abort` / `external` | **不新增 kind,不扩 user-cancel.source 字面量**;飞书 / RPC / 卡片**主动**取消统一用 `user-cancel { source: "rpc", pressedAt }`(协议层已有);scheduler-shutdown / cron-timeout / rpc-connection-close 等**被动**来源用 `external { origin }` 自由字符串(详见 §2.4) |
| 主模块 `AgentResult.aborted.abortReason` | 已携带(主模块 M2) | 本模块**消费**该字段,在 channel 渲染层做差异化展示;**不新增字段** |
| 主模块 `ToolDefinition.interruptBehavior` | 已定义 | 本模块**复用**——飞书 abort 触发后,bash 工具仍走 grace 路径,无需重新设计 |
| `ConversationManager` | 持有 sessions,`abort(id): boolean` 委托给 `session.runtime.abort()`(无 reason 参数,且底层失效) | `abort(id, reason?)` 加 reason 参数;**新增** `abortAll(reason): number` 用于关停链路 |
| `SessionRuntime`(via `session-adapter.ts`) | `abort()` 仅设 flag;`run()` 入口**不传 abortSignal 给 agentRuntime** | **重构**:`run(text, opts)` 入口创建 `InterruptController(parent: opts.abortSignal)`,**把 controller.signal 作为 abortSignal 透传给 `agentRuntime.run`**;`abort(reason)` 立即 fire 当前 controller(不再设 flag) |
| `inbound-router.ts handleMessage` | confirmation 拦截 + agent enqueue | **新增前置层**:在 `tryHandleAsConfirmationReply` **之前**调 `IntentClassifier.classify`,识别 cancel intent → `ConversationManager.abort`;confirmation 拦截路径**保留不变**(避免与 remote-confirmation 模块的隐性约束冲突) |
| `inbound-router.ts:419` 硬编码 `"处理被中止。"` | 单一文案 | 调用新增 `formatAbortReasonZh(reason)` 按 reason kind 输出差异化中文文案 |
| `ephemeral-executor.ts:74-77` 硬编码 `"Aborted"` | 单一英文 | 调用新增 `formatAbortReasonEn(reason)` + `serializeAbortReason(reason)` 输出差异化英文 status + JSON detail |
| RPC `session.abort` 方法 | 调 `ConversationManager.abort`(失效) | 同接口、同方法,但底层修复后真的中断 in-flight turn,reason 携带 `user-cancel { source: "rpc" }` |
| RPC `session.send` connection close | 已 `abortController.abort()`(裸 abort,无 typed reason) | 改用 `abortWithReason(controller, { kind: "external", origin: "rpc-connection-close" })`,channel 侧能识别"是连接断了" |
| Scheduler `runAgentTurn` in `command.ts:291-316` | 不接 abortSignal | **新增** `RunRegistry`(`runId → AbortController`);`runEphemeralTurn` 接受 `abortSignal`;暴露 `Scheduler.abortRun(runId, reason)` |
| `CleanupRegistry`([cleanup-registry.ts](../../../packages/server/src/cleanup-registry.ts)) | LIFO 关停链,已注册 server.close / scheduler.stop / channels.dispose 等 | **追加注册** `conversationManager.abortAll` + `runRegistry.abortAll` + `inboundRouter.refuseNew`;graceful shutdown 通过 LIFO 自然实现关停顺序(详见 §2.6) |
| `cli/render.ts formatAbortReasonSummary` | CLI 终端英文渲染(主模块产物) | **保留**——CLI 路径独占,不抽到 core(详见 §3.3) |

**本规格对协议层零修改**;只新增 server 端**信号源**(IntentClassifier / RunRegistry)、**接入器**(SessionRuntime 重构 / Scheduler 接 abortSignal)、**渲染层**(formatAbortReasonZh / formatAbortReasonEn / serializeAbortReason)、**关停集成**(CleanupRegistry 注册项)。

---

## 1. 不变量(Invariants)

本模块**继承主模块 INV-1 ~ INV-14 全部不变量**(协议层不变量在 server 路径同等成立)。本节仅列**新增**的远程中断特定不变量。

**INV-R1. abort 入口幂等性 + 双维度结果**:`ConversationManager.abort(sessionId, reason?)` 必须幂等,并返回完整的 `AbortResult` 区分 in-flight 与 pending 两个维度——

```typescript
interface AbortResult {
  abortedInFlight: boolean       // 是否打断了 in-flight turn (in-flight 维度,接 SessionRuntime.abort 结果)
  cancelledPending: number       // 清理的 pending queue 任务数量 (pending 维度)
}
```

具体语义:
- session 处于 `running` 状态:fire 当前 controller(`abortedInFlight: true`);若同时有 pending,清队列(`cancelledPending: N`)
- session 处于 `idle` 状态但 pending queue 非空:`abortedInFlight: false`,清队列(`cancelledPending: N`)
- session 处于纯 `idle` / `aborted` / `completed` 状态:`{ abortedInFlight: false, cancelledPending: 0 }`
- session 不存在(已 dispose / 从未创建):`{ abortedInFlight: false, cancelledPending: 0 }`,**不抛异常**——飞书消息异步性下 session 可能已被回收

调用方根据两个维度组合决定反馈:
- `abortedInFlight === true` → 不在 cancel ack 处反馈(让 cleanup 路径产出唯一反馈,**反馈单源原则**,详见 §2.3)
- `abortedInFlight === false && cancelledPending > 0` → 反馈"已取消队列中 N 条待处理消息"
- 两者都假 → 反馈"当前没有正在处理的任务"

`SessionRuntime.abort(reason?): boolean` 接口仍是单维度(只管 in-flight)——pending queue 是 ConversationManager 维度的状态(`pendingQueues: Map<id, PendingTask[]>`),不下沉到 SessionRuntime。

异常预留给真正的非法状态(如序列化错误)。

**INV-R2. IntentClassifier 优先级单调**:消息分类必须遵循固定优先级 `control > confirmation > agent-input`。同一消息满足多类条件时只取最高优先级。

具体保障:
- 关键词集合互斥(cancel 词 ∉ confirmation 允许/拒绝词集)——`IntentClassifier` 启动时静态校验,冲突 throw 让启动失败
- pending confirmation 期间收到 control 消息:**先 abort、后让 confirmation 走自然 cleanup**——abort 触发的 cleanup 路径会自动 reject pending confirmation(主模块 §3.6 cleanup),不会双重处理

**INV-R3. AbortReason 透传协议跨进程稳定**:`AgentResult.aborted.abortReason` 必须**可序列化为 JSON**(无 function / Symbol / 循环引用),保证 RPC 协议跨进程传递不丢字段。
- `AbortReason` 已经是判别联合的 plain object,已满足。本不变量是**禁止**未来加 `Error` 实例 / `AbortSignal` 引用等无法序列化的字段
- channel 渲染层(`formatAbortReasonZh` / `formatAbortReasonEn` / `serializeAbortReason`)统一使用 `switch (reason.kind)`;遇到未来扩展的新 kind 必须有 default 分支兜底,不允许抛异常

**INV-R4. 渲染层非协议化**:`formatAbortReasonZh` / `formatAbortReasonEn` / `serializeAbortReason` **不导出到 `core/interrupt`**,各自归属对应 channel 包(server / cli/serve / cli/render)。
- 理由:渲染上下文(终端 chalk vs 飞书 markdown vs RPC JSON)、文案语言、显示长度、emoji 策略均不同
- 但**reason kind 与 source/origin 的语义**有单一 ground truth——本文档 §2.5 表是所有 channel formatter 实现时的引用源,不允许各自重定义"idle-timeout 应该叫什么"

**INV-R5. controller 在执行单元内独占**:任意时刻一个 in-flight 执行单元(`SessionRuntime` 的一个 turn / `RunRegistry` 注册的一个 ephemeral run)只持有**一个** `AbortController`,在该单元生命周期内独占,不跨边界共享。
- `ConversationManager` / `inbound-router` / RPC handler **不持有** controller 引用,只通过路由方法委托(`abort(sessionId)` → `session.runtime.abort(reason)`)
- 这与主模块 INV-2(单一 ground truth)的精神一致——controller 由"运行该执行单元的组件"独占,所有外部入口经其转发

**INV-R6. abortSignal 接入唯一通道**:外部信号(RPC connection close / 用户 cancel intent / scheduler shutdown / 父 agent abort)进入执行单元**必须经 `abortSignal` 参数**(`AgentRuntime.RunParams.abortSignal` / `RunTurnOptions.abortSignal`),由其内部 `createInterruptController({ parent: abortSignal })` 自动获得 parent 传播语义。

禁止以下反模式:
- 在 `tool ctx.abortSignal` 上调 `controller.abort()`(只读跨边界,改变了应该改父级)
- 在 `EventBus` 上 emit `interrupt:fired` 自定义事件让 loop 退出(违反主模块 INV-9 单源事件流)
- 在 `LLMProvider` 实现内部检测 server-level state(应该让 abortSignal 透传到 fetch)
- 跳过 `agentRuntime.run({ abortSignal })` 字段(§0.2 D 项当前正是此反模式)

主模块抽象 `parent` 是 first-class 能力,但**字段名是 `abortSignal`**(协议层 only `AbortSignal`,parent 语义在 controller 内部实现)。

**INV-R7. graceful shutdown 走 CleanupRegistry**:Server 在收到 SIGTERM/SIGINT 关闭信号时,**通过 `CleanupRegistry` LIFO 链路**实现关停,不引入独立 `process.on("SIGTERM")` handler。

CleanupRegistry 注册顺序(本模块新增项 + 与现有项的关系)按"期望执行顺序的倒序"注册——后注册先执行(LIFO):

1. (现有)`server.close` / `channels.dispose` / `scheduler.stop` 等位于较早注册位置(最后执行)
2. (本模块新增)`execution.abortAllAndWait` 注册在 `scheduler.stop` / `channels.dispose` 之后,先执行——一个 callback 内 `Promise.all` 并行触发 `conversations.abortAllAndWait` + `runRegistry.abortAllAndWait`,两类执行单元 abort + drain 同时进行(它们独立无依赖,无需串行)
3. (本模块新增)`inboundRouter.refuseNew()` 注册在最后(LIFO 最先执行)——拒绝新消息进入

**关键**:`abortAllAndWait` 必须在内部 `await` in-flight cleanup 完成(主模块 INV-1 P95 ≤200ms + 30s 总超时兜底),不能 fire-and-forget。否则下一步关传输(`server.close` / `channels.dispose`)会断在 cleanup 路径产出 partial 事件(主模块 INV-5)和取消反馈消息之前,信息全部丢失。

**并行而非串行**:ephemeral run 与 session turn 是独立执行单元,合并为一个 `Promise.all` callback 让两类 drain 同时进行,关停最坏时间从 60s(串行)收敛到 30s(并行上限)。

CleanupRegistry 已保证单项失败不中断链;30s drain 兜底在 `abortAllAndWait` 自身实现,超时直接返回让链路继续。

**INV-R8. abort 与新消息的并发**:abort 期间(从 `abort()` 调用到 cleanup 完成)收到的同 session 新消息必须**排队、不丢弃、不抢占**。
- `ConversationManager.enqueue` 已有串行队列保证;abort 不破坏该队列语义
- abort 完成后,队首消息进入下一个 turn(获得新的 `InterruptController`)
- 例外:同期收到的新 control intent("再取消")是 no-op(INV-R1 幂等性兜底)

---

## 2. 架构

### 2.1 信号源拓扑

```
┌────────────────── 信号源(多入口) ──────────────────────┐
│                                                          │
│ CLI(主模块):                                             │
│   esc / Ctrl+C → KeyboardSource → replController         │
│   SIGINT/SIGTERM → SignalSource → replController         │
│                                                          │
│ Server inbound:                                          │
│   飞书消息 → IntentClassifier → ControlIntent.cancel     │
│              → ConversationManager.abort(sessionId,      │
│                  { kind: "user-cancel", source: "rpc",   │
│                    pressedAt })                          │
│                                                          │
│ RPC:                                                     │
│   session.abort(id) → ConversationManager.abort(id,      │
│                  { kind: "user-cancel", source: "rpc",   │
│                    pressedAt })                          │
│   session.send connection close → abortWithReason(       │
│                  ctrl, { kind: "external",               │
│                  origin: "rpc-connection-close" })       │
│                                                          │
│ Scheduler:                                               │
│   shutdown / cron timeout → RunRegistry.abortRun(        │
│                  runId, { kind: "external", origin })    │
│   parent agent fork → 父 abortSignal 透传                │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ AbortReason 携带、kind/source/origin 区分
                       ▼
┌────────────────── 协议层(主模块,不动) ─────────────────┐
│                                                          │
│ InterruptController                                      │
│  ├─ createInterruptController({ parent, externalSignals })│
│  ├─ abortWithReason(controller, reason)                  │
│  ├─ getAbortReason(signal): AbortReason | null           │
│  └─ forkController(parentSignal)                         │
│                                                          │
│ AbortReason 判别联合(已有 4 种 kind)                    │
│  user-cancel / idle-timeout / parent-abort / external    │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ controller.signal 作为 abortSignal
                       ▼
┌────────────────── 消费层 ────────────────────────────────┐
│                                                          │
│ AgentLoop(主模块):接 abortSignal,内部 createInterrupt   │
│  Controller({ parent: abortSignal }),loop / tools /     │
│  stream watchdog 全部受控                                │
│                                                          │
│ SessionRuntime(本模块重构):接 RunTurnOptions.abortSignal │
│  作为 parent,run() 内部创建子 ctrl,**透传子 ctrl.signal │
│  到 agentRuntime.run({ abortSignal })**                  │
│                                                          │
│ ephemeralRuntime(本模块新增 Scheduler-RunRegistry)     │
│  接 RunRegistry 的 AbortController.signal 作为 parent    │
│                                                          │
└──────────────────────┬───────────────────────────────────┘
                       │ AgentResult.aborted.abortReason
                       ▼
┌────────────────── 渲染层(本模块新增) ──────────────────┐
│                                                          │
│ cli/render.ts formatAbortReasonSummary  (CLI 英文,已有) │
│ server/.../abort-formatter-zh.ts        (飞书中文,新增) │
│ cli/serve/abort-serializer.ts           (RPC JSON,新增) │
│                                                          │
│ 各自消费同一份 AbortReason,产出 channel-specific 文案   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.2 SessionRuntime 重构

**当前问题**(详见 [session-adapter.ts:54-171](../../../packages/cli/src/serve/session-adapter.ts#L54)):

```typescript
// 现状(简化)
function createServerRuntimeAdapter(...): SessionRuntime {
  let aborted = false

  return {
    async *run(text, opts) {
      if (aborted) { aborted = false; throw new Error("Session aborted") }
      const { abortSignal, turnContext, turnIndex, source } = unpackOptions(opts)
      messages.push(userMessage(text))
      let turnAborted = false
      const queue: QueueItem[] = []
      const waiters: Array<() => void> = []

      // ⚠ 架构债 D:agentRuntime.run 入口 NOT 透传 abortSignal —— LLM call 等
      // 在底层完全感知不到任何中断信号,只能通过 onYield 回调被丢弃
      agentRuntime.run({
        messages: [...messages], turnIndex, source, turnContext,
        onYield: (event) => { if (turnAborted) return; queue.push({ kind: "yield", value: event }) },
      }).then(...)

      // adapter 在 abortSignal 上挂 listener 把 turnAborted=true,但只能从消费层中断
      abortSignal?.addEventListener("abort", () => { turnAborted = true; ... })
      // ... queue + waiter 桥接 callback → generator yield ...
      // ... non-completed / turnAborted 时 messages.pop() 回滚 userMsg ...
    },
    abort() { aborted = true }  // ⚠ 架构债 A:仅设 flag,turn 入口才检查
  }
}
```

**重构后**:

```typescript
function createServerRuntimeAdapter(...): SessionRuntime {
  let currentController: AbortController | null = null

  return {
    async *run(text, opts) {
      const { abortSignal, turnContext, turnIndex, source } = unpackOptions(opts)

      // ① 建立本 turn 专属 controller。caller 传入的 abortSignal(RPC connection
      //    close / 上游 abort)作为 parent —— controller 内部用 forkController
      //    实现 parent abort 传播(主模块 INV-8),触发时携带 typed parent reason
      const controller = createInterruptController({ parent: abortSignal })
      currentController = controller

      // ② messages.push + done 分支按 reason !== "completed" 时 messages.pop 回滚 —— 防孤儿
      //    user 消息的第一道防线(与 runTurnWithCommit 的 updateMessages 回滚是双保险,
      //    任一缺失另一层兜底)。本重构换信号传递路径,不动消息状态机
      messages.push(userMessage(text))

      const queue: QueueItem[] = []
      const waiters: Array<() => void> = []
      const wakeOne = () => { const w = waiters.shift(); if (w) w() }

      // ③ 启动 agent loop。controller.signal 作为 abortSignal 透传 ——
      //    abort 触发后,主模块 cleanup 路径(§3.6)在 ≤200ms 内自然完成:
      //    yield partial assistant_message + turn_complete + 最终返回
      //    RunResult.agentResult.reason="aborted" 携带 abortReason(INV-3 / INV-5)
      //
      //    **adapter 不在 controller.signal 上挂 abort listener 主动 push error
      //    终结 consumer loop** —— 那样会与主模块 cleanup 路径竞速,抢在 cleanup
      //    完成前抛出,导致 partial 内容丢失 + abortReason 拿不到 channel 渲染层。
      //    主模块 INV-1(P95 ≤ 200ms)就是 abort 的"立即"语义,无需外层再加速。
      agentRuntime.run({
        messages: [...messages],
        turnIndex,
        source,
        turnContext,
        abortSignal: controller.signal,        // ★ 透传,修 §0.2 D
        onYield: (event) => {
          queue.push({ kind: "yield", value: event })
          wakeOne()
        },
      }).then(
        (runResult) => { queue.push({ kind: "done", result: runResult }); wakeOne() },
        // throw 分支兜底:provider 网络错 / 编程错等。abort 不走此分支 —— run-agent.ts
        // 把 abortSignal 触发统一包成 AgentResult.aborted with abortReason 通过 .then 返回
        // (主模块 §M2 + buildPreFlightError 路径)
        (err)       => { queue.push({ kind: "error", error: err }); wakeOne() },
      )

      try {
        while (true) {
          if (queue.length === 0) await new Promise<void>((r) => waiters.push(r))
          const item = queue.shift()!
          if (item.kind === "yield") {
            yield item.value!
          } else if (item.kind === "done") {
            // non-completed(error / max_turns / aborted)→ pop userMsg 防孤儿
            // aborted 路径下,partial assistant_message 已通过 yield 流出去给 channel 消费,
            // adapter.messages 里仅有 userMsg(无 assistant 配对)→ 必须 pop
            if (item.result!.agentResult.reason !== "completed") messages.pop()
            return item.result!
          } else {
            // throw 路径:无对应 assistant,pop userMsg 防孤儿
            messages.pop()
            throw item.error
          }
        }
      } finally {
        if (currentController === controller) currentController = null
      }
    },

    abort(reason?: AbortReason): boolean {
      const ctrl = currentController
      if (!ctrl || ctrl.signal.aborted) return false   // INV-R1
      abortWithReason(
        ctrl,
        reason ?? { kind: "external", origin: "session-runtime-abort" },
      )
      return true
    },

    // getHistory / updateMessages / dispose / confirmationBroker 字段保持不变
  }
}
```

**关键变化**:
- `abort()` 从设 flag 变成立即 fire——当前正在跑的 LLM call / tool 通过 `controller.signal` → `abortSignal` 链路收到信号(主模块 M2 / M4 / M5 已实现)
- `agentRuntime.run({ abortSignal: controller.signal })` 透传——**修复 §0.2 D 这条最深一层债**,让 agent loop 真正感知中断
- `abort(reason?)` 接受可选 reason,让上游标识来源
- 旧 `aborted` flag 与 turn-入口 polling([session-adapter.ts:54-65](../../../packages/cli/src/serve/session-adapter.ts#L54))**整段移除**——单一 ground truth 是 `controller.signal.aborted`(INV-R5)
- 旧 `turnAborted` flag + `abortSignal.addEventListener("abort", () => push error)` listener **整段移除**——主模块 cleanup 路径在 abort 后自然产出 partial yields + 最终 RunResult,adapter 让事件流通过 onYield/.then 自然完成,**不与主模块 cleanup 竞速**(若竞速会导致主模块 INV-5 partial 保留 + INV-3 abortReason 透传被抢前抛出而丢失)
- `messages.push` 入口必做 + `messages.pop` 在 done(non-completed)/ throw 分支回滚——防孤儿 userMsg 双保险的 adapter 层
- `unpackOptions(opts)` 兼容 legacy `AbortSignal | RunTurnOptions` 联合入参([session-adapter.ts:181-201](../../../packages/cli/src/serve/session-adapter.ts#L181))**保留不动**——legacy `AbortSignal` 直接当 `abortSignal` 用,与新设计的"abortSignal 作为 parent fork 一层"路径无冲突;清理 legacy 入参形态是独立维度,不在本规格范围

**契约扩展**:`@zhixing/cli` 的 `RunParams` 已有 `abortSignal?: AbortSignal`(详见 [run-agent.ts:181](../../../packages/cli/src/run-agent.ts#L181) 主模块 spec §4.2 行 1451 "abortSignal 已透传(无需改)");本模块**只是开始使用**这个字段,无需扩接口。

`ConversationManager.abort(id, reason?)`(详见 [conversation-manager.ts:407-412](../../../packages/server/src/runtime/conversation-manager.ts#L407))做幂等查找,返回 `AbortResult` 双维度结果:

```typescript
interface AbortResult {
  abortedInFlight: boolean
  cancelledPending: number
}

abort(conversationId: string, reason?: AbortReason): AbortResult {
  const session = this.sessions.get(conversationId)
  if (!session) return { abortedInFlight: false, cancelledPending: 0 }

  // ① in-flight 维度:委托 SessionRuntime
  const abortedInFlight = session.runtime.abort(reason)

  // ② pending 维度:清队列 + 触发各 task.cancel(让 caller 通过 cancel hook 收到通知)
  //    pending task 在用户主动 cancel 场景下应该被清理 —— 否则用户发"取消"后,
  //    后续 dequeue 仍会跑这些 pending,与"我让 agent 停"语义违背
  const queue = this.pendingQueues.get(conversationId)
  let cancelledPending = 0
  if (queue) {
    for (const task of queue) {
      try { task.cancel() } catch { /* swallow,逐个独立 */ }
      cancelledPending++
    }
    this.pendingQueues.delete(conversationId)
  }

  return { abortedInFlight, cancelledPending }
}

// abortAll —— 关停链路用,只关心 in-flight 维度(pending queue 在 disposeAll 中清);
// 返回 in-flight aborted count,与 abortAllAndWait 配合实现 INV-R7
abortAll(reason: AbortReason): number {
  let aborted = 0
  for (const [, session] of this.sessions) {
    if (session.runtime.abort(reason)) aborted++
  }
  return aborted
}
```

`SessionRuntime.abort` 接口签名扩为 `abort(reason?: AbortReason): boolean`([packages/server/src/runtime/types.ts:71](../../../packages/server/src/runtime/types.ts#L71))——参数与返回值都是 additive,既有调用方(REPL `/abort` 等无 reason)零改动。

### 2.3 IntentClassifier(飞书消息预处理层)

**职责**:把入站 channel message 分类到三种意图,在 `inbound-router.handleMessage` 进入 `tryHandleAsConfirmationReply` 之**前**做控制意图前置识别。

**与既有 confirmation 拦截路径的关系**(关键边界):
- IntentClassifier **只前置 cancel intent 一种判别**;识别到非 control 时返回 `{ kind: "non-control" }`,inbound-router 走原 `tryHandleAsConfirmationReply` 路径(含群聊发起者校验、broker.resolve、回执 adapter.send 绕过 Outbox 等所有现有逻辑)
- **不重写** `tryHandleAsConfirmationReply`——避免与 [remote-confirmation-execution.md](./remote-confirmation-execution.md) 模块的隐性约束(`originSender` 校验 / 控制响应不走 Outbox 等)产生冲突
- 如果未来要加 `help` / `status` 等更多 control intent,在 IntentClassifier 内扩判别即可,confirmation 拦截路径仍然独立

**接口**:

```typescript
// packages/server/src/intent/types.ts

export type ControlIntent =
  | { kind: "cancel"; matchedKeyword: string }
  // P2 预留(本模块不实现):
  // | { kind: "help" }
  // | { kind: "status" }

export type Intent =
  | { kind: "control"; control: ControlIntent }
  | { kind: "non-control" }     // 让原 confirmation / agent 路径接管

export interface IntentClassifier {
  classify(msg: InboundMessage): Intent     // InboundMessage 来自 @zhixing/core/channels/types
}

// packages/server/src/intent/intent-classifier.ts

export function createDefaultIntentClassifier(opts: {
  cancelKeywords?: ReadonlyArray<string>
  locale?: "zh-CN" | "en"
} = {}): IntentClassifier {
  const cancelKeywords = opts.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS
  return {
    classify(msg) {
      const text = msg.text.trim()
      const matched = matchCancelKeyword(text, cancelKeywords)
      if (matched) return { kind: "control", control: { kind: "cancel", matchedKeyword: matched } }
      return { kind: "non-control" }
    }
  }
}

// packages/server/src/intent/cancel-keywords.ts

export const DEFAULT_CANCEL_KEYWORDS: ReadonlyArray<string> = [
  // 中文
  "取消", "停止", "停",
  // 英文
  "/cancel", "stop", "abort",
]

// 启动时静态校验(INV-R2):cancelKeywords ∩ confirmationAllowKeywords ∩ confirmationDenyKeywords = ∅
// 冲突 throw 让启动失败 —— 词集互斥是不变量,不能运行时容忍
```

**接入点**(`inbound-router.ts handleMessage`,在 line 140 `tryHandleAsConfirmationReply` 检查**之前**):

```typescript
async handleMessage(msg: InboundMessage): Promise<void> {
  const adapter = this.channels.get(msg.channelId)
  if (!adapter) return

  const conversationId = resolveConversationId(msg, adapter.bindingPolicy)

  // ★ 新增前置层:control intent 优先于一切
  const intent = this.intentClassifier.classify(msg)
  if (intent.kind === "control") {
    return await this.handleControlIntent(intent.control, conversationId, msg)
  }

  // 原 confirmation 拦截路径(line 140-143)—— 完全不变
  if (this.confirmationHub) {
    const handled = await this.tryHandleAsConfirmationReply(msg, conversationId)
    if (handled) return
  }

  // 原 agent enqueue 路径(line 145+)—— 完全不变
  // ... getOrCreate / enqueue / runChannelTurn ...
}

private async handleControlIntent(
  control: ControlIntent,
  conversationId: string,
  msg: InboundMessage,
): Promise<void> {
  switch (control.kind) {
    case "cancel": {
      const result = this.conversations.abort(conversationId, {
        kind: "user-cancel",
        source: "rpc",            // 协议层已有字面量,不扩 — 详见 §2.4
        pressedAt: Date.now(),
      })

      // 反馈分发(INV-R1 三分支)
      if (result.abortedInFlight) {
        // 有 in-flight:**不在此处反馈**。in-flight turn 走主模块 cleanup 路径
        // (≤200ms,主模块 INV-1)产出 RunResult.aborted,由 RM1 改造后的
        // runChannelTurn(inbound-router.ts:413+ 通过 formatAbortReasonZh)产出
        // 唯一一条反馈。在这里再 emit 会与 cleanup 路径重复 — 用户收到两条
        return
      }

      const replyTarget = buildReplyTarget(msg)
      const adapter = this.channels.get(replyTarget.channelId)
      if (!adapter) return

      let text: string
      if (result.cancelledPending > 0) {
        // 无 in-flight 但 pending queue 有任务:用户主动取消把队列清掉了
        text = `已取消队列中的 ${result.cancelledPending} 条待处理消息。`
      } else {
        // 既无 in-flight 也无 pending
        text = "当前没有正在处理的任务。"
      }

      // 直接 adapter.send 绕过 Outbox(与 inbound-router.ts:281 confirmation 回执
      // "控制响应即时反馈直接绕过 Outbox" 同源策略),避免 outbox 排队
      await adapter.send(replyTarget, { text })
                   .catch((e) => this.logger.error(`cancel ack send failed: ${errMsg(e)}`))
      return
    }
  }
}
```

**关键不变量**:
- `cancelKeywords` 与 `remote-confirmation` 的 allow/deny 词集**互斥**(INV-R2)——启动时静态校验,冲突 throw
- `classify` 是纯函数(零副作用),可单测覆盖优先级矩阵
- 关键词匹配是**精确字面**(case-insensitive 但不做 substring 匹配),避免"我想取消订阅"这种含 cancel 词的 agent 输入误触
- **反馈单源原则**:有 in-flight 时,abort 反馈由主模块 cleanup 路径(`runChannelTurn` 走 RM1 改造后的 `formatAbortReasonZh`)单独产出;`handleControlIntent` 只在无 in-flight 场景反馈(pending 已清 / 完全空闲两种)。避免与 cleanup 路径重复 emit,代价是有 200ms 反馈延迟(主模块 INV-1 上限),工程权衡接受
- **pending queue 清理**:`ConversationManager.abort` 同时清理该 session 的 pending queue 并触发各 `PendingTask.cancel` hook(`PendingTask.cancel` 当前在 inbound-router 是 log,语义不变 — `cancelledPending` 计数从 ConversationManager 直接返回,UX 反馈不依赖 cancel hook)
- `handleControlIntent` 的反馈直接 `adapter.send` 绕过 Outbox(与 confirmation 回执同源),不走 `emitReply` 避免 outbox 排队延迟控制响应

### 2.4 AbortReason 透传协议——零修改协议层的复用方案

主模块 `AbortReason` 定义在 [packages/core/src/interrupt/types.ts](../../../packages/core/src/interrupt/types.ts),包含 4 种 kind 与稳定字段:

```typescript
type AbortReason =
  | { kind: "user-cancel"; source: "esc" | "ctrl-c" | "sigint" | "rpc"; pressedAt: number }
  | { kind: "idle-timeout"; timeoutMs: number; chunksReceived: number; elapsedSinceLastChunkMs: number }
  | { kind: "parent-abort"; parentReason: AbortReason | null }
  | { kind: "external"; origin?: string }
```

**本模块的 AbortReason 使用约定**(协议层 0 修改,完全靠现有字段):

| 远程入口 | 使用的 reason | 字段填充 |
|---------|------------|---------|
| 飞书文本主动取消 | `user-cancel` | `source: "rpc"`(已有字面量),`pressedAt: Date.now()` |
| 飞书卡片按钮取消(P2) | `user-cancel` | `source: "rpc"`,`pressedAt: Date.now()` |
| RPC `session.abort` 调用 | `user-cancel` | `source: "rpc"`,`pressedAt: Date.now()` |
| RPC `session.send` connection close | `external` | `origin: "rpc-connection-close"` |
| Scheduler graceful shutdown | `external` | `origin: "scheduler-shutdown"` |
| Cron 任务超时 | `external` | `origin: "cron-timeout"` |
| Scheduler `runRegistry.abortRun` RPC | `user-cancel` | `source: "rpc"`,`pressedAt: Date.now()` |
| `SessionRuntime.abort()` 缺省 reason | `external` | `origin: "session-runtime-abort"` |

**为何全部"用户主动远程取消"统一用 `user-cancel { source: "rpc" }`**:
- `source` 字段是字面量 union(`"esc" | "ctrl-c" | "sigint" | "rpc"`),协议层已为远程客户端预留 `"rpc"`——所有非键盘的"用户在某个远程客户端发起的取消"都属于这一类
- 区分"飞书 / IDE / 卡片"是**渲染上下文**问题,不是协议问题——飞书 channel 收到 `source: "rpc"` 就知道"这是飞书用户自己发的"(渲染时直接说"已停止处理。"),RPC channel 收到 `source: "rpc"` 知道"是 client 取消"(渲染时说"Aborted by client.")。同一 source,不同 channel 自然差异化(INV-R4)
- 不扩字面量 union 是**真正的协议层 0 修改**——加新值要让所有 exhaustive switch consumer 同步更新,是 breaking change

**为何被动来源用 `external.origin` 自由字符串**:
- `origin?: string` 已是开放字段,加新值不破坏类型契约
- 渲染层按 `origin` 字符串做 switch + default 兜底,新 origin 不抛异常(INV-R3)
- channel formatter 各自维护"已知 origin 的文案表",未知 origin fallback 到通用"已停止"——开放性与一致性兼得

**渲染层契约**(主模块 INV-3 + 本模块 INV-R3 的合体):

```typescript
function formatAbortReason(reason: AbortReason | null): string {
  if (reason == null) return "已停止"
  switch (reason.kind) {
    case "user-cancel":   return /* by source 细化 */
    case "idle-timeout":  return /* timeoutMs 文案 */
    case "parent-abort":  return /* recurse parentReason */
    case "external":      return /* by origin 细化 */
  }
}
```

### 2.5 渲染层(per-channel)

**4 种 reason kind 的"用户视角语义"**(本节是 channel formatter 的单一参考源):

| kind / 子类 | 含义 | 用户应理解的 |
|-----------|------|------------|
| `user-cancel` (`source: "esc"` / `"ctrl-c"`) | CLI 用户主动键盘取消 | "我按了 esc / ctrl-c" |
| `user-cancel` (`source: "sigint"`) | 进程级 SIGINT | "我 / 系统发了 SIGINT" |
| `user-cancel` (`source: "rpc"`) | 远程客户端主动取消(飞书消息/卡片/IDE/RPC) | "我从远程客户端取消了"(channel 自己解释具体是哪一类客户端) |
| `idle-timeout` | LLM stream chunk 间隔超时 | "服务无响应,自动停了" |
| `parent-abort` | 父 controller 终止传播(链路 wrap,见 §3.10) | **不直接渲染 — formatter 必须先 `unwrapParentAbort` 拿到根因 kind 再分发**;只在 `parentReason === null` 这种纯裸 abort 场景到达 |
| `external` (`origin: "scheduler-shutdown"`) | service graceful shutdown | "服务要重启了" |
| `external` (`origin: "cron-timeout"`) | cron 任务超时 | "你定的任务超时了" |
| `external` (`origin: "rpc-connection-close"`) | RPC 连接断开 | "你的 client 断开了" |
| `external` (`origin: "session-runtime-abort"`) | SessionRuntime.abort 缺省 reason | "(无具体来源)" |
| `external` (其他 origin / undefined) | 未知或外部 SDK 触发 | "(已停止)" |

**关键约束**(§3.10 决策的渲染层落地):server 路径任意 abort 触发后,经过 `SessionAdapter` outer controller + `agent-loop` inner controller(以及 RPC 路径多一层 session.ts abortController)的 `forkController` 链路,`AgentResult.aborted.abortReason` 必然嵌套若干层 `parent-abort`。**所有 channel formatter 在 switch 前必须先 unwrap 到非 parent-abort 的根因**,否则 server 端 99% abort 路径会全部退化到 `parent-abort` 兜底分支,§0.3 问题 3 的差异化文案能力实质失效。

**三个 channel formatter 各司其职**:

#### 2.5.1 `cli/render.ts formatAbortReasonSummary`(主模块产物,保留)

英文 + chalk 样式,服务 CLI 终端用户。本模块**不动**——参考实现见 [render.ts:163-188](../../../packages/cli/src/render.ts#L163)。

#### 2.5.2 server `formatAbortReasonZh`(本模块新增)

中文 + 简洁 markdown,服务飞书等中文 channel 用户。

文件:`packages/server/src/channels/abort-formatter-zh.ts`

```typescript
import type { AbortReason } from "@zhixing/core"

// 本地 helper:递归 unwrap 直到拿到非 parent-abort 的根因(§3.10 + §2.5 关键约束)。
// 不抽到 core/interrupt(协议层 0 修改);不抽到跨 channel 共享(渲染层非协议化,
// INV-R4)。每个 formatter 各自定义同样的 4 行 helper,通过文档约定保证一致性。
function unwrapParentAbort(reason: AbortReason): AbortReason {
  let r: AbortReason = reason
  while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason
  return r
}

export function formatAbortReasonZh(reason: AbortReason | null | undefined): string {
  if (!reason) return "已停止处理。"
  const root = unwrapParentAbort(reason)   // ★ switch 前必 unwrap,否则退化兜底
  switch (root.kind) {
    case "user-cancel":
      // 飞书 channel 收到 source: "rpc" 必然是飞书用户自己——简洁反馈即可,无需追溯具体客户端
      // (esc / ctrl-c / sigint 不会出现在飞书路径,但 default 兜底保留)
      return "已停止处理。"

    case "idle-timeout":
      return `已停止处理。(等待响应超过 ${Math.round(root.timeoutMs / 1000)} 秒)`

    case "parent-abort":
      // unwrap 后仍是 parent-abort 表示 parentReason === null —— 父是裸 AbortController.abort()
      // 触发(无 typed reason)。退化到通用兜底
      return "已停止处理。"

    case "external":
      switch (root.origin) {
        case "scheduler-shutdown":     return "已停止处理。(服务正在重启,请稍后重试)"
        case "cron-timeout":           return "已停止处理。(任务超出时长上限)"
        case "rpc-connection-close":   return "已停止处理。(连接已断开)"
        case "session-runtime-abort":  return "已停止处理。"
        default:                       return "已停止处理。"   // 未知 origin 兜底,INV-R3
      }
  }
}
```

接入点:[inbound-router.ts:419](../../../packages/server/src/channels/inbound-router.ts#L419) 把硬编码 `"处理被中止。"` 替换为 `formatAbortReasonZh(agentResult.abortReason)`。

#### 2.5.3 cli/serve `serializeAbortReason`(本模块新增)

JSON 兼容 + 英文 status,服务 RPC client / scheduled task status 输出。

文件:`packages/cli/src/serve/abort-serializer.ts`

```typescript
import type { AbortReason } from "@zhixing/core"

// 本地 helper(同 §2.5.2):recurse unwrap parent-abort 拿根因。
// detail 字段保留**完整原始结构**(含全部 wrap 层),让 client 想自行解析嵌套时能拿到;
// message 字段按根因渲染,channel UX 直接可读。
function unwrapParentAbort(reason: AbortReason): AbortReason {
  let r: AbortReason = reason
  while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason
  return r
}

export function serializeAbortReason(reason: AbortReason | null | undefined): {
  status: "aborted"
  message: string
  detail: AbortReason | null   // 完整原始结构,client 自行解析嵌套
} {
  return {
    status: "aborted",
    message: formatAbortReasonEn(reason),
    detail: reason ?? null,
  }
}

function formatAbortReasonEn(reason: AbortReason | null | undefined): string {
  if (!reason) return "Aborted."
  const root = unwrapParentAbort(reason)   // ★ switch 前必 unwrap
  switch (root.kind) {
    case "user-cancel": {
      const label = root.source === "ctrl-c" ? "ctrl+c" : root.source
      return `Aborted by user (${label}).`
    }
    case "idle-timeout":
      return `Aborted: stream idle for ${Math.round(root.timeoutMs / 1000)}s.`
    case "parent-abort":
      // unwrap 后仍是 parent-abort → parentReason === null → 父裸 abort
      return "Aborted by parent."
    case "external":
      return root.origin
        ? `Aborted: ${root.origin}.`
        : "Aborted by external signal."
  }
}
```

接入点:[ephemeral-executor.ts:74-77](../../../packages/cli/src/serve/ephemeral-executor.ts#L74) 把 `{ status: "error", error: "Aborted" }` 替换为:

```typescript
const serialized = serializeAbortReason(r.abortReason)
return {
  status: "error",     // 保留 status="error" 兼容现有 RPC schema(client 已按 error 分支处理)
  output,
  error: serialized.message,
  detail: serialized.detail,
  durationMs: Date.now() - startTime,
}
```

注:RPC schema 是否扩 `status: "aborted"` 独立分支由 RPC schema spec 决定,本模块不强制——仅保证 `error` / `detail` 携带可解析结构,client 可在 `detail.kind === "user-cancel"` 等条件上做差异化 UX。

### 2.6 Scheduler 集成 + CleanupRegistry 关停

**当前问题**:[command.ts:291-316](../../../packages/cli/src/serve/command.ts#L291) 的 `runAgentTurn` 函数被注册给 Scheduler,但**不接 abortSignal**——cron 任务跑起来后 agent loop 完全不感知任何外部 abort 信号。注:`AgentTurnParams.abortSignal` 字段在 [scheduler/types.ts:137](../../../packages/core/src/scheduler/types.ts#L137) 已存在,Scheduler 层 API 已就绪,本模块只是开始使用。

**RunRegistry**(本模块新增):

```typescript
// packages/core/src/scheduler/run-registry.ts —— 与 Scheduler 同包,
// server 通过 ctx.server.runRegistry 访问、cli 通过 import 实例化,
// 均从 @zhixing/core 引用,无反向包依赖

import { abortWithReason } from "../interrupt/index.js"
import type { AbortReason } from "../interrupt/types.js"

export class RunRegistry {
  private runs = new Map<string, AbortController>()
  // event-driven drain:abortAllAndWait 时 set,unregisterRun 在 runs 清空时 resolve
  private drainResolver: (() => void) | null = null

  registerRun(runId: string): AbortSignal {
    const ctrl = new AbortController()
    this.runs.set(runId, ctrl)
    return ctrl.signal
  }

  unregisterRun(runId: string): void {
    this.runs.delete(runId)
    if (this.runs.size === 0 && this.drainResolver) {
      this.drainResolver()
      this.drainResolver = null
    }
  }

  abortRun(runId: string, reason: AbortReason): boolean {
    const ctrl = this.runs.get(runId)
    if (!ctrl || ctrl.signal.aborted) return false
    abortWithReason(ctrl, reason)
    return true
  }

  abortAll(reason: AbortReason): number {
    let aborted = 0
    for (const [, ctrl] of this.runs) {
      if (!ctrl.signal.aborted) {
        abortWithReason(ctrl, reason)
        aborted++
      }
    }
    return aborted
  }

  /**
   * 触发 abortAll 后 await 所有 in-flight run 走完 cleanup(`runAgentTurn` 在
   * finally 调 `unregisterRun`,清空时 resolve drain Promise)。
   *
   * 设计:event-driven `Promise.race(drained, timeout)`,不轮询。
   * timeoutMs 兜底:超时不抛,直接返回 —— 避免 grace 类工具 hang 整条关停链。
   */
  async abortAllAndWait(reason: AbortReason, timeoutMs = 30_000): Promise<number> {
    const aborted = this.abortAll(reason)
    if (this.runs.size === 0) return aborted

    const drained = new Promise<void>((resolve) => { this.drainResolver = resolve })
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    await Promise.race([drained, timeout])
    this.drainResolver = null    // 超时路径清理 resolver,避免后续 unregisterRun 误调
    return aborted
  }
}
```

**Scheduler 接入**(改 [command.ts:291-316](../../../packages/cli/src/serve/command.ts#L291)):

```typescript
const runRegistry = new RunRegistry()

const runAgentTurn = async (params: AgentTurnParams): Promise<AgentTurnResult> => {
  // params.taskId 作 RunRegistry key —— Scheduler 当前对同一 task 不允许并发
  // (scheduler.ts 互斥锁保证),taskId 与 in-flight run 一一对应。
  // 未来若需要"同 task 多次运行实例"语义,扩 AgentTurnParams 加 runId 字段
  const runKey = params.taskId ?? "anon"
  const abortSignal = runRegistry.registerRun(runKey)
  try {
    return await runEphemeralTurn({
      runtime: ephemeralRuntime,
      prompt: taskPrompt,
      turnContext,
      abortSignal,                    // ★ 透传给 agentRuntime.run
    })
  } finally {
    runRegistry.unregisterRun(runKey)
  }
}
```

`runEphemeralTurn` 接受 `abortSignal` 透传给 `runtime.run({ abortSignal })`——与 SessionRuntime 路径用法一致(详见 §2.2)。

**ServerContext 注入**:`runRegistry` 加入 [ServerContext](../../../packages/server/src/context.ts) 的可选字段(`runRegistry?: RunRegistry`,**类型从 `@zhixing/core` 引入** — 与 `Scheduler` / `ChannelRegistry` 同源,server 包已依赖 core 无新增依赖,无反向),由 [command.ts](../../../packages/cli/src/serve/command.ts) 在 `createServerContext({ ..., runRegistry })` 时传入,让 RPC method handler 通过 `ctx.server.runRegistry` 访问(与 `ctx.server.scheduler` / `ctx.server.conversations` 同模式)。

**CleanupRegistry 注册**(实现 INV-R7):

graceful shutdown **不引入独立 `process.on("SIGTERM")` handler**——既有 `CleanupRegistry`([cleanup-registry.ts](../../../packages/server/src/cleanup-registry.ts))已是 LIFO 关停链的单一入口,本模块只**追加注册项**,关停顺序由 LIFO 自然实现。

[command.ts](../../../packages/cli/src/serve/command.ts) 注册片段(在现有 `registry.register(...)` 之后追加):

```typescript
// LIFO:后注册先执行 —— 期望执行顺序的倒序

// 现有(已注册,大致顺序):
//   registerTailCleanup → releaseLock / stateFile.cleanup / heartbeat.clear
//   registerCoreCleanup → channels.dispose / scheduler.stop / deliveryStack.stop / stateFile.markStopping
//   server.close(由 runServer 内部注册)
//   confirmationBridge.dispose / confirmationRenderer.stop

// 本模块新增(在 registerCoreCleanup 之后注册,LIFO 中较早执行):

registry.register("execution.abortAllAndWait", async (cleanupReason) => {
  // cleanupReason 是 CleanupRegistry 自己的诊断字符串("SIGTERM" / "uncaught" 等),
  // 仅用于本 callback 的日志;**不进 AbortReason.origin**(否则与 §2.4 / §2.5
  // 的固定字面量不匹配,渲染层会全走 default 分支)
  //
  // 并行 drain:ephemeral run 与 session turn 是独立执行单元,Promise.all 让两类
  // drain 同时进行 —— 串行会让最坏关停时间翻倍(主模块 INV-1 P95 ≤200ms,30s 是
  // grace 类工具兜底上限)
  await Promise.all([
    conversations.abortAllAndWait(
      { kind: "external", origin: "scheduler-shutdown" },   // 固定字面量
      30_000,                                                // 30s drain 兜底
    ),
    runRegistry.abortAllAndWait(
      { kind: "external", origin: "scheduler-shutdown" },
      30_000,
    ),
  ])
})

registry.register("inboundRouter.refuseNew", () => {
  inboundRouter.refuseNewMessages()
})

// LIFO 实际执行顺序(后注册先执行):
//   1. inboundRouter.refuseNew                  拒新入站
//   2. execution.abortAllAndWait                Promise.all([conv, run]) 并行 fire abort +
//                                                等所有 in-flight 走完主模块 cleanup
//                                                (partial yields + RunResult + 取消反馈)
//   3. confirmationRenderer.stop / confirmationBridge.dispose
//   4. server.close                              断 RPC 连接(此时 cleanup 路径已 drain,
//                                                partial 流和反馈消息都已送达 client)
//   5. scheduler.stop / channels.dispose / ...
//   6. heartbeat.clear / stateFile.cleanup / releaseLock
//
// 关键:abortAllAndWait 的 await drain 是 INV-R7 顺序生效的载体 —— 没有它,
// signals fire 完立即返回 → 下一步 server.close 立即断 RPC,partial 事件
// (主模块 INV-5)和取消反馈消息全部丢失。
```

**RPC 暴露**:

```typescript
// packages/server/src/rpc/methods/schedule.ts

export function buildScheduleAbortRunMethod(): MethodEntry {
  return {
    name: "schedule.abortRun",
    requiresAuth: true,
    handler(rawParams, ctx): { aborted: boolean } {
      const runRegistry = ctx.server.runRegistry
      if (!runRegistry) {
        throw new RpcAppError(
          RPC_ERROR_CODES.INTERNAL_ERROR,
          "RunRegistry not configured on server",
        )
      }
      const params = (rawParams ?? {}) as { runId?: string }
      if (typeof params.runId !== "string") {
        throw RpcErrors.invalidParams("schedule.abortRun requires 'runId'")
      }
      const aborted = runRegistry.abortRun(params.runId, {
        kind: "user-cancel",
        source: "rpc",
        pressedAt: Date.now(),
      })
      return { aborted }
    }
  }
}
```

**Cron timeout 来源**:Scheduler 内部对长跑任务可基于 task 配置(deadline / 超时阈值)主动调 `runRegistry.abortRun(runId, { kind: "external", origin: "cron-timeout" })`——具体 timeout 策略不在本模块范围,接入点已就绪。

**`ConversationManager.abortAllAndWait` 实现要点**(mirror RunRegistry,event-driven):

- 持有 `drainResolver: (() => void) | null` 字段
- `setBusy(id, false)` 调用末尾检查"所有 session 都不 busy"时 resolve drainResolver(类似 RunRegistry 的 unregisterRun 检查)
- `abortAllAndWait(reason, timeoutMs)` 同模式 `Promise.race(drained, timeout)`,超时返回不抛
- `setBusy(id, true)` 不影响 drainResolver(只关心从 busy 到 idle 的下降沿)

不写具体代码 — 与 RunRegistry 同模式,实施时复用结构。**严禁用 50ms polling**:spec 要 event-driven,polling 是技术债且工程上无收益(setBusy 已是同步方法,挂 resolver 0 成本)。

### 2.7 RPC 集成

**RPC `session.abort`**(已有 [session.ts:235-250](../../../packages/server/src/rpc/methods/session.ts#L235)):

接口签名不变(`{ conversationId }` 入参,handler 调 `manager.abort(id)`),底层 SessionRuntime 重构后(§2.2)自动获得真正的中断能力。本模块只把 reason 透传:

```typescript
export function buildSessionAbortMethod(): MethodEntry {
  return {
    name: "session.abort",
    requiresAuth: true,
    handler(rawParams, ctx): void {
      const params = (rawParams ?? {}) as SessionAbortParams
      const id = params.conversationId ?? params.sessionId
      if (typeof id !== "string") {
        throw RpcErrors.invalidParams("session.abort requires 'conversationId'")
      }
      const manager = requireConversations(ctx.server)
      const result = manager.abort(id, {
        kind: "user-cancel",
        source: "rpc",
        pressedAt: Date.now(),
      })
      // RPC client 视角:in-flight 和 pending 都没动 = 没有可取消的对象 → notFound
      // 任一维度动了 = 取消生效;client 可通过未来的扩展拿到细分计数(当前 RPC schema
      // 不暴露 cancelledPending,IDE 同步场景 pending 通常为 0)
      if (!result.abortedInFlight && result.cancelledPending === 0) {
        throw RpcErrors.notFound(`Session not found or no in-flight turn / pending message: ${id}`)
      }
    },
  }
}
```

**RPC `session.send` connection close**(已有 [session.ts:105-183](../../../packages/server/src/rpc/methods/session.ts#L105) `runManagedTurn`):

当前实现:每次 `session.send` 创建 per-call `AbortController`,connection close 时调 `abortController.abort()`(裸 abort,无 typed reason)。本模块只**改一行**——把裸 abort 换成 `abortWithReason` 携带 typed reason,**保留** `runTurnWithCommit` 的所有 setBusy / addObserver / commit / 错误包装逻辑:

```typescript
async function runManagedTurn(
  managed: ManagedSession,
  text: string,
  connection: RpcConnection,
  manager: ConversationManager,
): Promise<void> {
  const conversationId = managed.conversationId
  const abortController = new AbortController()

  // ★ 唯一改动:connection close 触发 typed reason,channel 侧能识别"是连接断了"
  const unsubClose = connection.onClose(() => {
    abortWithReason(abortController, {
      kind: "external",
      origin: "rpc-connection-close",
    })
  })

  try {
    // turnContext / runTurnWithCommit / 消费 yield / setBusy / observer 等所有逻辑保持不变 —— 只是
    // 现在传给 runtime.run 的 abortSignal 携带 typed reason,SessionAdapter (§2.2) 把它作为 parent
    // 传给本 turn controller,触发后 cleanup 路径 yield 出的 AgentResult.aborted.abortReason 就是
    // { kind: "external", origin: "rpc-connection-close" }
    const gen = runTurnWithCommit(manager, conversationId, text, {
      abortSignal: abortController.signal,
      turnContext,
      turnIndex: managed.turnCount,
      source: "channel",
    })
    // ... 后续 while loop 消费 yield + connection.notify session.delta / session.complete 不变 ...
  } catch (err) {
    if (abortController.signal.aborted) return
    // ... 原 error 包装路径不变 ...
  } finally {
    unsubClose()
    manager.setBusy(conversationId, false)
    if (connection.closed) manager.removeObserver(conversationId, String(connection.id))
  }
}
```

**RPC `schedule.abortRun`**(本模块新增):见 §2.6。

### 2.8 飞书 InteractiveCard 按钮(P2 设计预留)

**P2 不实施,但接口预留**:

`IntentClassifier` 已定义 `ControlIntent` 是判别联合,卡片按钮 callback 解析为同一个 `ControlIntent.cancel`(`matchedKeyword` 字段可为 `"<button:cancel>"` 或类似标记),后续路由代码完全复用。

`AbortReason` 上**无需为按钮预留新字面量**——按钮触发与文本"取消"在协议层都是 `user-cancel { source: "rpc" }`(§2.4 决策);若产品上需要在飞书侧区分文案("您点击了取消按钮" vs "您发送了取消消息"),由飞书 channel formatter 在 reason 之外通过另一个上下文字段携带,不污染协议层。

**实施清单**(留作 RM6,本规格不展开细节):
- 飞书卡片 SDK 接入、`agent:run_start` 事件触发卡片发送
- 卡片 action callback handler:解析为 `ControlIntent.cancel { matchedKeyword: "<button:cancel>" }`
- 走 §2.3 `handleControlIntent` 已有路径

---

## 3. 关键决策与权衡

### 3.1 为何 SessionRuntime 持有 controller,而非 ConversationManager

**结论**:每个 turn 的 `InterruptController` 由 `SessionRuntime`(`session-adapter.ts` 实例)的 `run()` 方法创建并独占;`ConversationManager` 只做路由,不持锁。

**理由**:
- `SessionRuntime.run()` 是 turn 生命周期的真正承载者——controller 与 turn 同生同死,放在 run() 闭包内最自然(turn 结束自动 GC)
- `ConversationManager` 是 sessions 容器,不该感知"当前 turn 在哪一步";它只需暴露 `abort(sessionId, reason?)` / `abortAll(reason)` 委托方法
- 与主模块 INV-2(单一 ground truth)一致——controller 由"运行 loop 的那个组件"持有
- `RunRegistry` 走相同模式(scheduler 路径的对应执行单元),与 SessionRuntime 是**平行实现**,不是 INV-R5 的例外

### 3.2 为何 IntentClassifier 而不是直接关键词匹配

**结论**:把"消息分类"抽象成 `IntentClassifier` 接口,而不是在 `inbound-router.ts` 内联 if-else 关键词判断。

**理由**:
- **可扩展**:未来加 `/help` / `/status` / `/clear` 等控制意图,只在 classifier 里加 case,inbound-router 路由层零改动
- **可测试**:classifier 是纯函数,优先级矩阵 / 关键词冲突 / locale 切换都能覆盖单测(不依赖 channel adapter mock)
- **可注入**:不同 channel 可注入不同 classifier(飞书侧用中文关键词集 + 飞书消息格式;Slack 侧若引入,用英文 + Slack `/cancel` 命令)
- **职责单一**:IntentClassifier 只前置 cancel,不重写 confirmation 路径——避免与 remote-confirmation 模块产生隐性约束冲突

### 3.3 为何不抽 formatAbortReason 到 core/interrupt

**结论**:三个 channel formatter(CLI 终端 / 飞书中文 / RPC JSON)**不抽公共**,各自归属对应包。

**理由**:
- 渲染上下文完全不同:CLI 终端有 chalk 颜色 + 多行 + emoji 策略;飞书是 markdown 单行 + 中文 + 不能 chalk;RPC 是 JSON object + 英文 status code + 字段化结构
- 抽出来的话,接口必须支持"multi-language" + "multi-format" + "color-aware",会成为巨型 swiss-army-knife——而它的本质只是 4 个 kind 的 switch
- 一旦抽公共,每加一个 reason kind / origin 要在三处改;各自独立后,新 kind 在 channel 文档里登记,各 channel 按需补 case
- 协议层(core)只负责 reason 的**结构稳定性**(INV-R3)和**语义定义**(本文档 §2.5);格式化是 channel 层的事

**例外**:`formatAbortReason` 的"语义解释表"(§2.5)是单一 ground truth——本文档定义"idle-timeout kind 应该让用户理解什么",所有 channel formatter 实现时引用本节。不允许 cli 显示"server timeout"、飞书显示"网络问题"——同一 reason kind 的语义跨 channel 必须一致。

### 3.4 为何关键词优先于按钮(实施顺序)

**结论**:RM3 先做关键词,RM6 后做卡片按钮。

**理由**:
- **关键词工作量小**:IntentClassifier + DEFAULT_CANCEL_KEYWORDS + ConversationManager.abort 三处改动
- **关键词降级兜底**:即便后续做了卡片按钮,关键词仍是"卡片消息丢失" / "用户点不到按钮"的降级路径
- **卡片有外部依赖**:飞书卡片 SDK 接入、`agent:run_start` 事件触发、按钮 action callback 路由,涉及多个新组件
- **覆盖率**:关键词在内部测试 + 早期飞书用户场景下足够覆盖 95% 主动取消需求;按钮是体验提升,不是基础能力

但**架构设计一开始就为按钮留口子**(IntentClassifier `ControlIntent` 判别联合 + `matchedKeyword` 自由字段),避免后续重构。

### 3.5 颗粒度:turn 而非 session

**结论**:`abort(sessionId)` 取消**当前正在跑的 turn**;session 状态保留,用户可继续聊。

**理由**:
- 与 CLI esc 语义对称(esc 不清空 REPL session)
- 飞书会话长期存在(几天/几周),把 session 销毁过激
- 用户更可能想"停下这个 turn 但保留对话上下文"——下一条消息就是新 turn
- session 销毁作为另一个独立操作(`session.dispose` / 飞书 `/clear`)存在,不混淆

### 3.6 abort 幂等性的语义(返回 AbortResult,双维度)

**结论**:`ConversationManager.abort()` 返回 `AbortResult { abortedInFlight: boolean, cancelledPending: number }`,不抛异常;`SessionRuntime.abort()` 仍返 boolean(单 in-flight 维度,pending queue 不下沉到 SessionRuntime 抽象)。

**理由**:
- 飞书/RPC 的异步性:用户发"取消"时 turn 可能已完成、session 可能已 dispose,这些都是**正常状态**而非错误
- **双维度的必要性**:in-flight turn 与 pending queue 是 ConversationManager 持有的两类正交状态。用户发"取消"时,用户视角的"正在处理"包含两者(已发未跑的 pending 也是用户期待 abort 的目标)。单 boolean 无法区分"取消了什么",会让 UX 反馈含糊或不准
- 返回完整结构让调用方按 channel 上下文决定 UX:
  - 飞书 channel 关心 pending(用户连发多条消息场景)→ 反馈"已取消 N 条待处理"
  - RPC client 通常只关心 in-flight(IDE 同步发请求)→ 看 `abortedInFlight` 即可,`cancelledPending` 通常是 0
- 异常预留给真正的非法状态(序列化错误、内存损坏等)
- 符合主模块 cleanup 路径的"abort 是幂等终止意图"哲学

**为何 SessionRuntime.abort 不也返 AbortResult**:
- SessionRuntime 是 in-flight turn 的执行单元,无 pending queue 概念(pending 是 ConversationManager 的调度层状态)
- 抽象不应携带它不持有的状态
- 保留 SessionRuntime.abort: boolean 是"接口契约对应实际状态"的 SRP

### 3.7 ControlIntent 扩展性(暂停 / 重置 / help)

**结论**:`ControlIntent` 用判别联合 `{ kind: "cancel" } | { kind: "help" } | ...`;P0 仅实现 `cancel`,其余 kind 不写到代码里。

**理由**:
- 用户的"控制意图"是开放空间(取消 / 帮助 / 状态查询 / 重置 / 暂停 / 切换模型...),判别联合让未来扩展只加 case 不破契约
- 但**绝不留半实现的接口**——`help` / `status` 等未来 kind 不出现在 P0 代码里(类型不定义、没有 dead branch)。等真做时再加
- 符合主模块 §0.4 "不为未来场景留半实现的接口"原则

### 3.8 graceful shutdown 复用 CleanupRegistry,不引入第二套关停机制

**结论**:INV-R7 关停动作通过向既有 `CleanupRegistry` 追加注册项实现,不写 `process.on("SIGTERM")` 独立 handler。abortAll 类 callback 内部 `await` drain in-flight cleanup,而非 fire-and-forget。

**理由**:
- `CleanupRegistry` 已是 server 关停的**单一入口**——SIGTERM / SIGINT / `server.shutdown` RPC / 正常退出 / uncaughtException 全部走这一条链(消除散弹式关停的根因);引入第二套机制等于把已经收敛的债重新打散
- LIFO 语义自然映射到关停顺序("拒新 → abort → drain → 关资源")——只要按"期望执行顺序的倒序"注册即可
- 单项失败不中断链是 CleanupRegistry 已有保证(独立 try/catch),本模块免费获得鲁棒性
- abort 与"等 drain"必须**在同一 callback 内串行**——CleanupRegistry 调度层不感知 in-flight cleanup,把"等 drain"下放到 abortAllAndWait 内部(配 30s 总超时兜底),才能保证下一个 cleanup 项执行时 partial 事件 + 取消反馈消息已送达;`runServer` 的 close hook 是 HTTP 连接 graceful 等待,与 in-flight session/run 的 abort cleanup 是不同维度的 drain

### 3.9 用 `user-cancel { source: "rpc" }` 复用,而非扩字面量 union

**结论**:飞书 / IDE / 卡片按钮所有"用户在远程客户端主动取消"统一用 `user-cancel { source: "rpc" }`;不在协议层加 `"feishu" | "card_button"` 等新字面量。

**理由**:
- `source` 字段是字面量 union——加新值是 breaking change,所有 exhaustive switch consumer 必须同步更新,违反 §0.4 "协议层零修改"原则
- "客户端类型"是**渲染上下文**问题,不是协议问题:同一 `source: "rpc"` 在飞书 channel formatter 里渲染成"已停止处理。"(用户必然是飞书用户),在 RPC channel serializer 里渲染成"Aborted by client."——天然差异化,完全契合 INV-R4
- 被动来源用 `external.origin` 自由字符串容纳——`origin?: string` 已是开放字段,加新 origin 不破坏类型契约,渲染层 default 兜底就是设计

如果未来真有"协议层必须区分多个客户端类型"的强需求(如审计场景),应在主模块 spec 立项扩 source 字面量,不在本规格私自扩。

### 3.10 controller fork 链路必然 wrap `parent-abort`,渲染层必须 unwrap

**结论**:server 路径的 `AbortController` 形成 fork 链(RPC `session.ts` abortController → `SessionAdapter` outer controller → `agent-loop` inner controller),每层 fork 都把父 reason 包成 `{ kind: "parent-abort", parentReason: <父 reason> }`。`AgentResult.aborted.abortReason` 必然是 N 层 `parent-abort` 嵌套的根因。**所有 channel formatter 在 switch reason.kind 之前必须 `unwrapParentAbort` 拿到根因 kind**。

**为何必须 fork(不能复用 caller controller)**:
- `AbortController` 在主模块设计中**只在创建/触发 abort 的组件持有**(详见主模块协议层 controller.ts 命名约定);跨边界传递的是只读 `AbortSignal`
- `SessionAdapter` 收到 `opts.abortSignal`(只读)需要响应 `SessionRuntime.abort(reason)` 主动触发 abort —— 这要求**写入权限**(调 `controller.abort()`),无法在只读 signal 上完成。所以 SessionAdapter 必须自己 `createInterruptController({ parent: opts.abortSignal })` 拿到一个新 controller(写入)同时挂 parent listener(读父 signal 的 abort 触发)
- `agent-loop` 内部同理(主模块 INV-2 单一 ground truth + INV-8 子 controller 不反向影响),内部再 fork 一次

每层 fork 是协议层固有语义,**不可能消除**。

**渲染层的对应分工**:
- 协议层不感知"渲染需要根因" —— `forkController` 的 wrap 是协议正确(主模块 INV-3 AbortReason 永远可读 + 链路可追溯)
- 渲染层(channel formatter)负责把 fork 链 unwrap 成"用户视角的根因",这是协议层 0 修改原则(§0.4)下渲染层必然承担的责任
- helper 4 行(`while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason`),每个 channel formatter 各自定义一份 —— 不抽公共(INV-R4 渲染层非协议化),不进 core(协议层 0 修改)
- 实施一致性靠 §2.5 表 + 本节决策 + 单测覆盖,不靠代码抽象

**`detail` 字段保留完整原始结构**:`serializeAbortReason.detail` 不 unwrap,完整传给 RPC client —— client 想分析 fork 链路、做诊断 / 审计可自行 recurse。`message` 字段是给人看的,unwrap 后渲染。两个字段职责分离。

---

## 4. 模块边界与依赖

### 4.1 新增文件

| 路径 | 职责 |
|------|------|
| `packages/server/src/intent/types.ts` | `Intent` / `ControlIntent` / `IntentClassifier` 类型 |
| `packages/server/src/intent/intent-classifier.ts` | `createDefaultIntentClassifier` 实现 |
| `packages/server/src/intent/cancel-keywords.ts` | `DEFAULT_CANCEL_KEYWORDS` 词集 + 启动时静态校验 |
| `packages/server/src/channels/abort-formatter-zh.ts` | `formatAbortReasonZh` 中文渲染 |
| `packages/cli/src/serve/abort-serializer.ts` | `serializeAbortReason` + `formatAbortReasonEn` |
| `packages/core/src/scheduler/run-registry.ts` | `RunRegistry` Scheduler 用 —— **放在 core/scheduler 与 Scheduler 同包**(`AgentTurnParams.abortSignal` 也在此包),server / cli 都从 `@zhixing/core` 引用,无反向依赖。**同步在 [packages/core/src/scheduler/index.ts](../../../packages/core/src/scheduler/index.ts) 加 `export { RunRegistry } from "./run-registry.js"`**,让 cli/server `import { RunRegistry } from "@zhixing/core"` 直接拿到。**首次引入 scheduler → interrupt 的模块内依赖**(`abortWithReason` / `AbortReason` 来自 `../interrupt/`),合法且无循环(interrupt 不反向引用 scheduler);未来若 interrupt 模块需要 scheduler 类型会形成循环,需 break |

### 4.2 修改文件

| 路径 | 修改内容 |
|------|---------|
| `packages/cli/src/serve/session-adapter.ts` | `run()` 入口创建 `InterruptController({ parent: opts.abortSignal })`,**把 controller.signal 作为 abortSignal 透传给 `agentRuntime.run`**(修 §0.2 D);`abort(reason?)` 立即 fire(从 set flag 改造);删除 `aborted` flag + turn-入口 polling + `turnAborted` flag + `abortSignal.addEventListener` listener(后两者会与主模块 cleanup 路径竞速,导致 partial 与 abortReason 丢失);**保留** messages.push/pop 防孤儿机制 |
| `packages/server/src/runtime/types.ts` | `SessionRuntime.abort(reason?: AbortReason): boolean` —— additive 扩展接口签名;**新增** `AbortResult` 类型导出(`{ abortedInFlight: boolean, cancelledPending: number }`)供 ConversationManager.abort 使用 |
| `packages/server/src/runtime/conversation-manager.ts` | `abort(id, reason?): AbortResult` 加 reason 参数 + 返回类型扩为 `AbortResult` 双维度(in-flight + pending queue);abort 同时清理该 session 的 pending queue 并触发各 `PendingTask.cancel`(避免取消语义对 pending 失效);**新增** `abortAll(reason): number`(同步 fire,只关心 in-flight 维度,关停场景下 pending 由 disposeAll 清);**新增** `abortAllAndWait(reason, timeoutMs?): Promise<number>` event-driven 实现(`drainResolver` + `setBusy(false)` 触发 + `Promise.race(drained, timeout)`)|
| `packages/server/src/channels/inbound-router.ts` | `InboundRouterOptions` 扩可选字段 `intentClassifier?: IntentClassifier`(constructor 缺省 `createDefaultIntentClassifier()`,持有为 `private readonly intentClassifier`);`handleMessage` 在 `tryHandleAsConfirmationReply` **之前**前置 `intentClassifier.classify(msg)`;新增 `handleControlIntent`(按 `AbortResult` 三分支反馈);line 419 调用 `formatAbortReasonZh`;新增 `refuseNewMessages()` 方法 + `private acceptingNew = true` 字段——`handleMessage` 入口在 `acceptingNew === false` 时**直接 log 一行并 return,不向用户 emit 反馈**(channel 即将随 LIFO 链关闭,弱实时反馈不如 log 一致;用户重试时自然得到 channel 不可达的系统反馈);**`PendingTask.cancel` hook 语义不变**(仍是 log,UX 反馈由 ConversationManager.abort 直接返 `cancelledPending` 让 caller 决定 emit 不依赖 hook) |
| `packages/cli/src/serve/ephemeral-executor.ts` | `EphemeralTurnOptions` 加 `abortSignal?: AbortSignal`,透传给 `runtime.run`;line 74-77 调用 `serializeAbortReason` |
| `packages/cli/src/serve/command.ts` | 实例化 `RunRegistry`;`runAgentTurn` 用 `params.taskId` 注册/反注册 + 注入 `abortSignal`;`createServerContext({ ..., runRegistry })` 注入到 ServerContext;**追加注册** `inboundRouter.refuseNew` / `runRegistry.abortAllAndWait` / `conversationManager.abortAllAndWait` 到 `CleanupRegistry`(LIFO 顺序见 INV-R7);注册 `schedule.abortRun` RPC 方法 |
| `packages/server/src/context.ts` | `ServerContext` 加可选字段 `runRegistry?: RunRegistry`(类型从 **`@zhixing/core`** 引入,与 `Scheduler` / `ChannelRegistry` 同源,server 包已依赖 core 无新增依赖);`createServerContext` 接受同名参数 |
| `packages/server/src/rpc/methods/session.ts` | `session.abort` handler 透传 `{ kind: "user-cancel", source: "rpc", pressedAt }` reason;`session.send` connection close 由 `abortController.abort()` 改为 `abortWithReason(ctrl, { kind: "external", origin: "rpc-connection-close" })`;**保留** `runTurnWithCommit` / setBusy / observer / commit 全部既有逻辑 |
| `packages/server/src/rpc/methods/schedule.ts` | 该文件已存在 5 个 schedule.* method(`list` / `create` / `update` / `delete` / `run`),**追加** `buildScheduleAbortRunMethod()` 并在 RPC method registry 注册;handler 通过 `ctx.server.runRegistry` 取 RunRegistry 实例(详见 §2.6 RPC 暴露片段) |

### 4.3 不动的边界

- `packages/core/src/interrupt/` — 协议层零修改;不扩 `AbortReason.user-cancel.source` 字面量
- `packages/core/src/loop/` — agent-loop / llm-call / tool-executor 零修改
- `packages/cli/src/run-agent.ts` — `RunParams.abortSignal` 已存在(主模块 spec §4.2 已确认),本模块只是开始使用
- `packages/cli/src/render.ts` — CLI 渲染零修改(`formatAbortReasonSummary` 保留)
- `packages/cli/src/repl.ts` — REPL 零修改
- `packages/server/src/cleanup-registry.ts` — `CleanupRegistry` 接口零修改,本模块只追加注册项
- `packages/server/src/runtime/run-turn.ts` — `runTurnWithCommit` 零修改;adapter 重构后它的 P3 异常路径行为仍正确(双保险)
- `packages/server/src/confirmation/` — confirmation 模块及 `tryHandleAsConfirmationReply` 路径完全不动,IntentClassifier 只在其前置一层 cancel 拦截

---

## 5. 渐进式实现里程碑

每个 milestone 独立可验证、独立可回滚。按"修架构债优先 + 用户可见性递进"排序——RM2 先于 RM3(不修底层 abort,飞书取消是假的)。

### RM1 — Channel Formatter + AgentResult.aborted 渲染消费

**目标**:三个 channel formatter 各自就位,消费 `AgentResult.aborted.abortReason`,把硬编码文案替换为差异化文案。**不动协议层、不修架构债**——本里程碑产物纯增量。

**范围**:
- 新建 `packages/server/src/channels/abort-formatter-zh.ts` + `formatAbortReasonZh(reason)`
- 新建 `packages/cli/src/serve/abort-serializer.ts` + `serializeAbortReason(reason)` + `formatAbortReasonEn(reason)`
- 两个 formatter 内部各定义 **`unwrapParentAbort` 本地 helper**(`while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason`,4 行),switch 前必 unwrap 到根因 kind 再分发——否则 RM2 上线后 server 路径所有 fork 链 abort(SessionAdapter outer + agent-loop inner 双层 wrap)渲染失效,详见 §2.5.2 / §2.5.3 + §3.10
- 修改 `inbound-router.ts:419`:替换硬编码 `"处理被中止。"` 为 `formatAbortReasonZh(agentResult.abortReason)`
- 修改 `ephemeral-executor.ts:74-77`:替换硬编码 `"Aborted"` 为 `serializeAbortReason(r.abortReason)` 的 message + detail

**验收**:
- `pnpm tsc --noEmit` + `pnpm test` 通过
- 手工触发 idle-timeout abort,飞书侧看到 `"已停止处理。(等待响应超过 N 秒)"` 而非 `"处理被中止。"`
- **unwrap 验证**:构造 mock `parent-abort{ parent-abort{ user-cancel{ source: "rpc", pressedAt } } }` 嵌套 reason → 验证 formatter 渲染 user-cancel 分支文案(飞书 zh:`"已停止处理。"` / RPC en:`"Aborted by user (rpc)."`)而非 parent-abort default 兜底——确保 unwrap 在 RM2 上线前就能正确处理 fork 链
- **0 层 wrap 验证**:`idle-timeout` reason 直接渲染(unwrap 是 no-op)
- **N 层 wrap 验证**:任意层数嵌套 parent-abort 的根因 kind 都正确分发

**不做**:不改 SessionRuntime / 不接 IntentClassifier / 不修 RPC

### RM2 — SessionRuntime 接 abortSignal + 透传给 agentRuntime(双修架构债)

**目标**:`SessionRuntime.abort` 真正中断 in-flight turn(从 set flag 改为 fire signal),且 `agentRuntime.run` 收到 `abortSignal` 让 LLM call / tool 执行真正停下。**修主架构债 A + D,后续所有 milestones 依赖**。

**范围**:
- 重构 `session-adapter.ts`:
  - `run(text, opts)` 入口:`createInterruptController({ parent: opts.abortSignal })`
  - **把 `controller.signal` 作为 `abortSignal` 字段传给 `agentRuntime.run({ ..., abortSignal: controller.signal })`**——这一步是修 §0.2 D 的关键,缺它整个 RM2 的修复就是空的
  - finally 块清理 `currentController = null`
  - `abort(reason?)`:`currentController != null && !aborted` 时调 `abortWithReason(currentController, reason ?? defaultExternal)`,返回 boolean(INV-R1)
  - **删除** `aborted` flag 字段 + line 54-65 polling 检查
  - **删除** `turnAborted` flag + `abortSignal.addEventListener("abort", () => push error)` listener —— 主模块 cleanup 路径(INV-1 ≤200ms)在 abort 后自然产出 partial yields + RunResult.aborted with abortReason,外层 listener 会与之竞速并 race-condition 抢前抛错,导致 partial 与 abortReason 丢失
  - **保留** `messages.push / messages.pop` 防孤儿机制(基于 done 分支 `reason !== "completed"` 触发 + throw 分支兜底)
- `SessionRuntime.abort(reason?: AbortReason): boolean` 接口签名扩展(`packages/server/src/runtime/types.ts`)—— 单 in-flight 维度,pending 不下沉(详见 §3.6)
- `ConversationManager.abort(id, reason?): AbortResult` 升级为**双维度返回**(`{ abortedInFlight: boolean, cancelledPending: number }`,详见 INV-R1 + §2.2 实现)—— 同时清理该 session 的 pending queue 并触发各 `PendingTask.cancel` hook,把"取消"语义对 in-flight + pending 全覆盖
- `ConversationManager.abortAll(reason): number` + `abortAllAndWait(reason, timeoutMs?): Promise<number>` 新增方法,event-driven `drainResolver` 实现(详见 §2.6 实现要点)—— 后者在 RM5 关停链路用,但接口在 RM2 一并落地避免分散修改
- **`session.ts` RPC `session.abort` handler 同步适配 AbortResult**(让 RM2 单独 build 通过,避免 RM2 → RM4 之间出现编译 broken 状态):
  ```typescript
  const result = manager.abort(id, {
    kind: "external", origin: "session-runtime-abort",   // RM2 用 default reason,RM4 改为 typed user-cancel
  })
  if (!result.abortedInFlight && result.cancelledPending === 0) {
    throw RpcErrors.notFound(`Session not found or no in-flight turn / pending message: ${id}`)
  }
  ```
  reason 字段在 RM2 用 default external,典型 typed `user-cancel { source: "rpc", pressedAt }` 由 RM4 完成

**验收**:
- in-flight turn 调 abort → 200ms 内 LLM call / tool 退出(主模块 INV-1);AgentResult.reason="aborted" 携带 abortReason
- **partial 保留**:abort 触发瞬间已生成的 text / thinking 通过 `assistant_message` yield 到 channel,不丢失(主模块 INV-5 在 server 路径同样成立)
- **abortReason 透传**:RunResult.agentResult.abortReason 被 channel 渲染层(RM1 的 `formatAbortReasonZh` + `unwrapParentAbort`)消费,飞书侧看到差异化文案而非通用兜底
- **AbortResult 双维度**:
  - 纯 idle session(无 in-flight 无 pending)调 abort → `{ abortedInFlight: false, cancelledPending: 0 }`
  - in-flight only → `{ abortedInFlight: true, cancelledPending: 0 }`
  - in-flight + pending → `{ abortedInFlight: true, cancelledPending: N }`,且各 `PendingTask.cancel` hook 被调
  - pending only(无 in-flight)→ `{ abortedInFlight: false, cancelledPending: N }`
  - session 不存在 → `{ abortedInFlight: false, cancelledPending: 0 }`,不抛异常
- 同 turn 内调多次 abort → 仅第一次 `abortedInFlight: true`,后续 `false`(幂等)
- 主模块 M7 parent 测试在 server 路径同样通过(回归测试)
- 旧 polling check 测试零保留(全部迁移到 in-flight 测试)
- grep 确认 `session-adapter.ts` 中无 `addEventListener("abort"` / `turnAborted` 残留

**不做**:不接 IntentClassifier / 不动 Scheduler

### RM3 — IntentClassifier + 飞书关键词主动取消

**目标**:飞书用户发"取消" / `/cancel` 真的能停下 in-flight turn。**P0 用户可见能力**。

**范围**:
- 新建 `packages/server/src/intent/types.ts` + `intent-classifier.ts` + `cancel-keywords.ts`
- 新建 `DEFAULT_CANCEL_KEYWORDS`(中英 P0 集合)
- 修改 `inbound-router.ts`:
  - `InboundRouterOptions` 扩可选字段 `intentClassifier?: IntentClassifier`(constructor 缺省 `createDefaultIntentClassifier()`,持有为 `private readonly intentClassifier`)
  - 在 `handleMessage` 中,**在 `tryHandleAsConfirmationReply` 之前**调 `intentClassifier.classify(msg)`
  - 识别为 `{ kind: "control" }` → 调用新增 `handleControlIntent`(按 §2.3 反馈单源 + 三分支:`abortedInFlight=true` 不反馈让 cleanup 路径产出 / `cancelledPending>0` 直接 `adapter.send` 反馈"已取消队列中的 N 条待处理消息" / 都假反馈"当前没有正在处理的任务"——绕过 Outbox)
  - 识别为 `{ kind: "non-control" }` → 走原 `tryHandleAsConfirmationReply` + agent 路径(完全不动)
- 启动时静态校验:`cancelKeywords ∩ confirmationAllowKeywords ∩ confirmationDenyKeywords = ∅`(INV-R2),冲突直接 throw 让启动失败

**验收**:
- 飞书集成环境手工验证:发长任务后发"取消",turn 在 200ms 内停下,飞书侧看到"已停止处理。"(由 cleanup 路径走 `formatAbortReasonZh` 产出,**不是** handleControlIntent 反馈)
- 用户连发 3 条消息(1 条 in-flight + 2 条 pending)后取消 → in-flight 停 + pending queue 清空 + 飞书侧看到 cleanup 路径反馈("已停止处理。"),pending tasks 的 cancel hook 被调
- 用户在无 in-flight + 无 pending 时发"取消" → 立即收到"当前没有正在处理的任务。"(handleControlIntent 直接 adapter.send)
- session 状态保留,继续发新消息能进入新 turn
- pending confirmation + cancel 同时:abort 优先,confirmation 走自然 cleanup reject
- **不重复 emit**:有 in-flight 时,handleControlIntent 与 cleanup 路径只有后者产出反馈,飞书用户不收两条相同消息

**不做**:不做卡片按钮 / 不做 Scheduler / 不重写 confirmation 拦截

### RM4 — RPC `session.abort` 行为修正 + connection close 携带 typed reason

**目标**:RPC client 调用 `session.abort` / 断开连接时,真的中断 in-flight turn,且 reason 可识别。

**范围**:
- 修改 `session.ts:235-250` `session.abort` handler:reason 透传 `{ kind: "user-cancel", source: "rpc", pressedAt: Date.now() }`
- 修改 `session.ts runManagedTurn`:把 `abortController.abort()` 改为 `abortWithReason(abortController, { kind: "external", origin: "rpc-connection-close" })`;**其他逻辑(setBusy / observer / runTurnWithCommit / commit / 错误包装)完全保留**

**验收**:
- RPC `session.abort` 在 in-flight turn 期间调用 → AgentResult.aborted.abortReason.source === "rpc"
- RPC connection close → AgentResult.aborted.abortReason.kind === "external" && .origin === "rpc-connection-close"
- 现有 RPC schema 不破坏(error/status 字段语义保持)

**不做**:不做 schedule.abortRun(独立 RM5)

### RM5 — Scheduler RunRegistry + abortSignal 透传 + CleanupRegistry 关停集成

**目标**:cron / 调度任务支持外部 abort + service shutdown 时优雅退出 + cleanup 路径产出的 partial / 反馈消息不丢失。

**范围**:
- 新建 `packages/core/src/scheduler/run-registry.ts` + `RunRegistry` 类(含 `abortRun` / `abortAll` / event-driven `abortAllAndWait` 用 `drainResolver` + `Promise.race(drained, timeout)`,详见 §2.6)—— **放在 core/scheduler 与 Scheduler 同包**(详见 §4.1),server / cli 都从 `@zhixing/core` 引用,无反向依赖;同步在 `packages/core/src/scheduler/index.ts` 加 `export { RunRegistry }`
- 修改 `command.ts`:
  - 实例化 `runRegistry`(`import { RunRegistry } from "@zhixing/core"`)
  - `runAgentTurn` 用 `params.taskId` 注册/反注册 + 注入 `abortSignal` 到 `runEphemeralTurn`
  - `runEphemeralTurn` 接受 `abortSignal` 透传给 `runtime.run`(用法对齐 SessionRuntime)
  - `createServerContext({ ..., runRegistry })` 注入到 ServerContext
  - 注册 `inboundRouter.refuseNew` + 单一 `execution.abortAllAndWait` callback(内部 `Promise.all([conversations.abortAllAndWait, runRegistry.abortAllAndWait])` 并行 drain,详见 §2.6 LIFO 顺序图)到 `CleanupRegistry`,**abortAllAndWait 不是 abortAll** — 后者 fire-and-forget 会让下一步 server.close 抢断 partial 流
- 修改 `packages/server/src/context.ts`:`ServerContext` 加可选字段 `runRegistry?: RunRegistry`(类型从 `@zhixing/core` 引入)+ `createServerContext` 接受同名参数
- **追加** `buildScheduleAbortRunMethod` 到已存在的 `packages/server/src/rpc/methods/schedule.ts`(handler 通过 `ctx.server.runRegistry` 取 registry);同步在 RPC method registry 注册

**验收**:
- service 接到 SIGTERM 后,所有 in-flight cron task 在 30s 内 cleanly 退出;bash 子进程不孤儿
- 手动调 `schedule.abortRun(runId)` 立即中断对应 cron task
- 关停链 LIFO 顺序通过 shutdown-chain 测试覆盖(参考 [shutdown-chain.test.ts](../../../packages/cli/src/serve/__tests__/shutdown-chain.test.ts) 既有测试模式)
- **drain 完成性**:在关停链中插入"abort fire 后产出 partial event"的 mock,验证 server.close 在 partial 送达 client 之后才执行(否则 RM5 没真正完成 INV-R7 的核心保证)

**不做**:不做飞书卡片按钮

### RM6 — 飞书 InteractiveCard 按钮(P2)

**目标**:agent run 期间发送"正在处理...[取消]"卡片,用户点击 → abort。

**范围**(本规格不展开,留作独立 spec 子节):
- 飞书卡片 SDK 接入 + 模板设计
- `agent:run_start` 事件订阅 → 发送卡片
- 卡片 action callback handler → 解析为 `ControlIntent.cancel { matchedKeyword: "<button:cancel>" }` → 走 RM3 路径
- 渲染层无需新增分支(卡片按钮与文本取消在协议层都是 `user-cancel { source: "rpc" }`)

**验收**:飞书 channel 可见显式取消按钮,点击体验等价关键词

### RM7 — graceful shutdown 完善 + 灾难恢复

**目标**:覆盖 server 异常退出场景(panic / OOM / 网络故障)的 abort 链路。

**范围**(本规格不展开,留作独立 spec):
- `process.on("uncaughtException")` 路由到 `CleanupRegistry.runAll("uncaught")` 触发 abort 链
- 异常退出后重启时的 session 状态恢复(依赖 conversation-model 持久化 spec)
- 各 channel(飞书 / RPC)上对"服务异常"的统一 fallback 文案

---

## 6. 测试策略

### 6.1 单元测试

| 模块 | 重点覆盖 |
|------|---------|
| `formatAbortReasonZh` / `formatAbortReasonEn` / `serializeAbortReason` | 4 种 kind × 各 source/origin 子分支 + null + default |
| `IntentClassifier` | control/non-control 二分 / 大小写 / substring / locale / 词集冲突 throw |
| `SessionRuntime.abort` | 幂等性 / in-flight 中断 / agentRuntime 收到 abortSignal / idle no-op / 多次调用返回值 |
| `RunRegistry` | register/unregister / abortRun 幂等 / abortAll 计数正确 / `abortAllAndWait` event-driven drain + 超时兜底 |
| `ConversationManager.abort(id, reason?)` | 返回 `AbortResult` 双维度 / 三种状态(in-flight only / pending only / 同时 / 都无)各自计数正确 / session not found / pending queue 清理后再次 abort 是 no-op |
| `ConversationManager.abortAllAndWait` | event-driven drain(setBusy(false) → resolve drainResolver)/ 超时不抛 |
| `unwrapParentAbort` (Zh + En 各一份) | 0 层 wrap / 1 层 / N 层 nested / parentReason === null 时停在 parent-abort |

### 6.2 集成测试

| 场景 | 路径 |
|------|------|
| 飞书 inbound "取消" 中断 in-flight turn | mock channel + IntentClassifier + ConversationManager |
| 飞书"取消"消息**不**误触 confirmation 拦截 | mock pending confirmation + cancel 关键词 |
| 飞书"取消"清理 pending queue + 反馈"已取消 N 条待处理" | enqueue 多条占满 pending → cancel → 验 cancelledPending === N + 反馈文案 |
| RPC `session.abort` 中断 in-flight turn(LLM call 真停) | mock RPC dispatcher + SessionRuntime + 计 LLM call 调用次数 |
| RPC connection close → typed reason 透传 | mock connection lifecycle + 验 abortReason.origin |
| **abort 触发后 partial assistant_message 仍 yield 到 channel** | mock LLM 流跑到一半触发 abort,验 channel 收到含 `[interrupted]` 标记的 partial |
| **abort 后 RunResult.agentResult.abortReason 被 channel formatter 消费** | mock abort + 验 inbound-router 发出文案不是兜底"已停止处理。" |
| CleanupRegistry SIGTERM 触发 abort 链 LIFO 顺序 | 复用 `shutdown-chain.test.ts` 模式 |
| **关停链 abortAllAndWait drain 完成性** | mock in-flight session 的 cleanup 路径耗时 100ms,验 server.close 在 cleanup 完成后执行 |
| cron timeout → abort | mock 时钟 + RunRegistry |
| idle-timeout abort + 飞书渲染 | mock LLM idle stream + inbound-router 渲染检查 |

### 6.3 压力测试

参考主模块 `packages/core/src/__tests__/interrupt-stress.test.ts` 模式,新增 server 端等价压测:

- 100 次随机 in-flight 状态 + abort 触发 → 100/100 aborted、零协议违反、P95 框架延迟 ≤ 200ms
- 多 session 并发 abort 隔离性(session A abort 不影响 session B)
- abort 期间新消息排队不丢(INV-R8)

### 6.4 手工验证清单(per RM)

每个 RM 完成时必须人工触发(REPL / 飞书 sandbox / RPC client):
- [ ] RM1:idle-timeout abort 时飞书消息为差异化中文文案
- [ ] RM2:RPC `session.abort` 后 in-flight turn 立即停(不等下一个 send),LLM call 真的停止(不是只丢弃结果)
- [ ] RM3:飞书发"取消"立即停 + 收到"已停止处理。"
- [ ] RM4:CI/IDE client `session.abort` 行为等价 RM3;断开连接时 reason 携带 `origin: "rpc-connection-close"`
- [ ] RM5:`kill -TERM <server-pid>` 后 in-flight cron 走 cleanup,bash 子进程不留;CleanupRegistry 注册顺序通过 LIFO 测试

---

## 7. 验收清单

**协议层不变量**(继承主模块 INV-1 ~ INV-14):
- [ ] 框架延迟 P95 ≤ 200ms(server 路径同样满足)
- [ ] 单一 ground truth(每 turn 一个 controller,SessionRuntime 持有)
- [ ] AbortReason 永远可读(INV-3 在 RPC/inbound 路径不破坏)
- [ ] 协议合规(cleanup 路径产出完整 messages,飞书/RPC 收到的 yield 流可重建为合法 LLM history)
- [ ] partial 保留 —— **协议层维度**:abort 时已生成的 text/thinking 仍以 partial assistant_message 形式在 yield 序列中产出(主模块 INV-5);**channel UX 维度按 channel 形态分**:CLI 终端实时流式渲染 / RPC client 通过 yield 流自然拿到;**飞书等非 streaming channel P0 不 forward partial**,只反馈 `formatAbortReasonZh(abortReason)` 文案,partial 完整呈现留作 §8 后续锚点

**本模块新增不变量**:
- [ ] INV-R1 abort 入口幂等性 + 双维度结果(`AbortResult { abortedInFlight, cancelledPending }` 返回 + 不抛异常)
- [ ] INV-R2 IntentClassifier 优先级单调 + 词集互斥静态校验
- [ ] INV-R3 AbortReason JSON 可序列化(RPC 跨进程不丢字段)
- [ ] INV-R4 渲染层非协议化(无公共 formatter,各 channel 独立)
- [ ] INV-R5 controller 在执行单元内独占(SessionRuntime / RunRegistry 平行)
- [ ] INV-R6 abortSignal 接入唯一通道(无自定义事件 bus 绕开;agentRuntime.run 必须收到 abortSignal)
- [ ] INV-R7 graceful shutdown 走 CleanupRegistry,无独立 SIGTERM handler
- [ ] INV-R8 abort 期间新消息排队不丢

**用户可见能力**(对应 §0.3 三个真实问题):
- [ ] 飞书"取消"消息真的让 agent 停下(问题 1 解决)
- [ ] 飞书"取消"消息**同时清空 pending queue** —— 用户连发多条后取消,排队的消息不会继续跑(问题 1 完整覆盖)
- [ ] RPC `session.abort` 真的中断 in-flight turn 且 LLM call 真停止(问题 2 解决,A + D 双层债同时修复)
- [ ] 飞书侧呈现差异化中断原因(问题 3 解决,**channel formatter unwrapParentAbort 后按根因 kind 分发**,server 路径所有 abort 不会退化到 parent-abort 兜底)

**架构债清算**:
- [ ] `session-adapter.ts` 中 `aborted` flag 字段已删除
- [ ] line 54-65 turn-入口 polling 检查已删除
- [ ] `session-adapter.ts` 中 `turnAborted` flag + `addEventListener("abort", ...)` 主动 push error listener 已删除(避免与主模块 cleanup 路径竞速 — 见 §2.2 关键变化)
- [ ] `agentRuntime.run({...})` 调用 **必须**含 `abortSignal` 字段(grep 确认 — 这是修 §0.2 D 的关键)
- [ ] `process.on("SIGTERM")` 等独立 handler 不出现在 server 路径(grep 确认 — graceful shutdown 走 CleanupRegistry 唯一入口)
- [ ] CleanupRegistry 关停链中 abort 类 callback **必须 await drain**(grep 确认 — 不允许裸调 `abortAll` 让 server.close 抢断 partial 流)
- [ ] 无任何代码绕过 `abortSignal` 接入 controller(grep 确认 — INV-R6)

---

## 8. 后续工作锚点

本规格**不做**但**留好接口/语义**的能力:

- **InteractiveCard 按钮**(RM6):`ControlIntent` 判别联合 + `matchedKeyword` 自由字段已预留;实施时新增飞书卡片 SDK 接入即可
- **多 ControlIntent kind**:`ControlIntent` 判别联合扩 `help` / `status` / `clear` / `pause`(后两者需另立 spec 设计 pause-resume 协议)
- **多语言关键词**:`createDefaultIntentClassifier({ locale })` 已留 locale 参数;后续按需扩 locale 词集
- **ephemeral run 维度的 abort**:`RunRegistry.abortRun(runId)` 已暴露;后续若飞书要支持"取消我刚才发的定时任务",可在 IntentClassifier 加 `ControlIntent.cancelRun { runId }` kind,路由到 `runRegistry.abortRun`
- **abort 进度推流**:RPC client 当前通过 `session.send` yield 流自然观察 abort cleanup 事件;若需要专用 progress channel(显示"正在停止 bash 子进程...")可独立设计
- **panic / 异常退出恢复**:RM7 范围,需要 conversation-model 持久化 spec 配套
- **多 channel formatter 共享 origin/source 文案表**:三个 channel formatter 当前各自独立 switch,未来若 origin / source 取值大量增长,可抽出"语义键 → 文案"的 Record 表,让每个 channel 维护自己的文案 record,switch 收敛到"reason → 语义键"一处。当前规模(P0 不到 10 个分支)三处独立可读性更好,不强制抽象
- **AbortReason 协议层扩字面量**:若产品上确实需要在协议层区分"飞书用户" / "IDE 用户" / "卡片按钮"等多个客户端类型(如审计/计费场景),应回到主模块 [interruptible-agent-loop-execution.md](./interruptible-agent-loop-execution.md) 立项扩 `user-cancel.source` 字面量并同步所有 exhaustive switch consumer,不在本规格私自扩
- **sender-aware cancel**(任务型 bot 适配):若产品定位从对话型转向任务型(每用户独立任务并存于群聊),需扩 `PendingTask` 加 `sender?: string` 字段(由 inbound-router enqueue 时填入)+ `ConversationManager.abort(id, reason?, senderFilter?)` 加可选 sender 过滤参数 + 同时让 `SessionRuntime.abort` 通过 `turnContext.turnOrigin.triggeredBy` 比对在 in-flight 维度也只针对 sender 自己的 turn。本模块 P0 接受不区分 sender 的简化(§0.4)
- **飞书 abort 反馈附 partial 内容**:若产品需要在飞书 abort 反馈中向用户呈现已生成的 partial assistant 内容(主模块 INV-5 协议层已保证 yield 序列携带,但飞书 channel 不 forward yields),扩 `runChannelTurn` 的 abort 分支为"先 emit partial(从 `agentResult.message` 提取 text/thinking 块)+ 再 emit `formatAbortReasonZh(abortReason)`"双消息

每条锚点对应**未来 spec / RM**,不在本文展开。
