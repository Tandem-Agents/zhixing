# 可中断 Agent Loop(Interruptible Agent Loop)执行规格

> **文件作用**
> 本文档是知行可中断 Agent Loop 模块的**权威细节规格**——从概念、源码级三方调研、架构决策、协议定义、里程碑拆解到验收清单。其他文档涉及"中断 / 取消 / abort / idle-timeout"时统一引用本文档,避免版本漂移。
>
> 它做三件事:
> 1. 对中断与 abort 机制做源码级三方调研(OpenClaw / Hermes / Claude Code)并明确取舍
> 2. 基于三方对比设计出与已有架构契合且更优的统一抽象
> 3. 拆解为按"用户可见性优先"排序的渐进实现里程碑(M1-M9)
>
> **前置**:[persistent-service.md §3.6](./persistent-service.md)(Orchestrator 层) · [conversation-model.md](./conversation-model.md)(Turn / SessionRuntime) · [tools-builtin.md](./tools-builtin.md)(工具协议)
> **已建基础**:
> - [agent-loop.ts](../../../packages/core/src/loop/agent-loop.ts) · [llm-call.ts](../../../packages/core/src/loop/llm-call.ts) · [tool-executor.ts](../../../packages/core/src/loop/tool-executor.ts)
> - [run-agent.ts](../../../packages/cli/src/run-agent.ts) · [repl.ts](../../../packages/cli/src/repl.ts) · [run-agent.ts:680-703 `trackMessages`](../../../packages/cli/src/run-agent.ts#L680)(yield 流 → newMessages 重建)
> - [context/termination.ts](../../../packages/core/src/context/termination.ts)(abort 优先归一化样板)
> - [tui/_internal/stdin-ownership.ts](../../../packages/cli/src/tui/_internal/stdin-ownership.ts)(keypress ownership 协调)
> - [types/agent-events.ts](../../../packages/core/src/types/agent-events.ts)(`AgentRunEndReason` 已含 "aborted")
>
> **三方调研原文**:[openclaw](../../source-analysis/openclaw/interruption-and-abort.md) · [hermes-agent](../../source-analysis/hermes-agent/interruption-and-abort.md) · [claude-code](../../source-analysis/claude-code/interruption-and-abort.md)
>
> **下游延伸规格**:[remote-interruption-execution.md](./remote-interruption-execution.md) — server / RPC / scheduler / 飞书等非 CLI 直连入口的中断接入设计(本模块协议层的应用层扩展,继承本文全部 INV)

---

## 0. 概念与背景

> 这一节以第一人称回答读文档时最先冒出来的 5 个基础问题。不塞进后续技术章节,以免稀释它们的聚焦度。

### 0.1 "中断"在本规格里指什么——三种语义层级

"中断"在不同语境下含义不同,本规格明确三层语义,避免后续讨论混淆:

| 语义 | 触发源 | 终态 | 进程影响 |
|------|--------|------|---------|
| **取消当前 turn**(cancel)| Esc / Ctrl+C 单击 / idle-timeout / 父 agent abort / 外部 AbortSignal | AgentResult { reason: "aborted", abortReason: ... } | 进程继续运行,REPL 回到提示符 |
| **退出 REPL 进程**(exit)| Ctrl+C 800ms 内双击 / Ctrl+D / `/exit` | process.exit(0) | 进程终止 |
| **退出当前操作**(escape)| 在确认对话框、typeahead 面板等子 UI 中按 Esc | 仅子 UI 关闭 | 不动 agent loop |

本规格主要解决**第一层(取消当前 turn)**,对第二层只定义 REPL 双击触发协议(实际清理走 `/exit` 命令既有路径),对第三层不介入(由 typeahead-broker / confirmation-broker 各自处理)。

**与"达到最大轮数"的关系**:`AgentResult.reason="max_turns"` 是**与 abort 平行的独立终止类型**——表示"达到上限"而非"被中断"。它不走 abort 路径、不携带 abortReason。本规格不混淆两者。

### 0.2 这个模块的作用

当前 zhixing 的中断能力虽有骨架但不闭环:

- `RunParams.abortSignal` 已透传到 `runAgentLoop`([`run-agent.ts:177, 591`](../../../packages/cli/src/run-agent.ts#L177)),但 REPL 调用 `agentRuntime.run()` 时**不传**([`repl.ts:1188-1202`](../../../packages/cli/src/repl.ts#L1188))——链路最后一公里断
- `agent-loop.ts:86` 仅在每个 turn 边界检查 `abortSignal.aborted`——一旦进入 `streamLLMCall`,整个 stream 消费循环不再检查 abort
- `llm-call.ts:79-131` 的 `for await (const event of stream)` 循环**没有 chunk 级 abort 检查、没有 idle-timeout**——LLM 静默挂死时只能等
- `tool-executor.ts:63` 的工具串行循环**没有 per-iteration abort 检查**——多个工具串行时只能等当前工具完成
- abort 退出时**没有协议清理**——partial text 丢失、orphan tool_use 不补齐 placeholder,违反 LLM 协议导致下一轮 API 400
- abort reason 是 `unknown`——下游无法做差异化处理(用户取消 vs 超时 vs 父 abort)

本模块要解决:**让用户在任何时刻按 Esc / Ctrl+C 都能在 200ms 内打断当前 LLM 流响应或工具执行;让长时间无响应的 LLM 流自动检测并降级;让所有 abort 路径产出对 LLM 协议合规的 messages**。

### 0.3 触发本规格立项的两个真实问题

均已在线上复现:

**问题 A — 223 秒 LLM 流挂死**:用户在 REPL 中第二次让 agent 读取 web_fetch 内容,LLM 进入 stream 后第一个 chunk 永不到达。Esc 没反应,Ctrl+C 没反应(被 readline 吞掉),最终用户只能 kill 进程。日志显示 LLM provider 已发起 fetch,但 stream 消费循环一直在等。**根因**:`llm-call.ts:79-131` 没有 idle-timeout 看门狗。

**问题 B — REPL 无法中断**:上述场景中,根本就没有"用户中断"的入口——`repl.ts` 完全没有 SIGINT/Esc handler,readline 在 typeahead 模式下又把 Ctrl+C 路由给了 typeahead-input,agent loop 收不到任何 abort 信号。**根因**:`agentRuntime.run()` 没接 abortSignal 实参 + REPL 没装载键盘监听 source。

A 和 B 表面独立,本质是同一模块缺失:**没有一个端到端的可中断 agent loop 机制**。

### 0.4 不做什么——范围边界

本规格**不做**以下能力,避免设计失焦:

- **不做 user-typed-while-busy 的"软中断"语义**(Claude Code `'interrupt'` reason)。zhixing 当前 REPL 在 agent 跑时不接受输入;server 通道 / typeahead-while-busy 是后续独立工作。`AbortReason` 是判别联合,未来加 `{ kind: "user-typed", newMessage }` 不破坏现有契约。
- **不做"自然语言 abort 触发"**(OpenClaw `abort-primitives.ts` 的 30+ 多语言关键词)。这是 IM 通道特化,CLI/REPL 按 Esc 即可。
- **不做跨进程 abort RPC**(OpenClaw 的 chatAbortControllers Map + WebSocket 广播)。zhixing 当前是单进程 REPL,无需 daemon-style 远程 abort。
- **不做"投机执行"abort**(Claude Code `'streaming_fallback'` reason)。投机执行依赖 StreamingToolExecutor,zhixing 不做投机。
- **不做 force-close TCP socket 的 reach-into-internals**(Hermes `_force_close_tcp_sockets`)。Node.js fetch/undici 已经在 `AbortSignal` + `request.destroy()` 公开 API 上提供等价能力,无需触碰内部字段。
- **不做完整的 keybinding 框架**(Claude Code Ink 的 chord / context / overlay 优先级)。zhixing REPL 是简单 readline 模式,复用已有 `acquireStdinOwnership` 处理 keypress ownership 即可。
- **不做 partial tool_use 保留**——abort 路径下 LLM 已经完整生成的 tool_use blocks 也一律丢弃(详见 §3.6.4 的设计代价说明)。

### 0.5 与现有模块的关系

| 现有组件 | 当前角色 | 本规格上线后 |
|---------|---------|-------------|
| `RunParams.abortSignal`(cli/run-agent.ts) | 已存在,REPL 不传 | REPL 把 KeyboardSource + SignalSource 触发的 controller.signal 传入 |
| `run-agent.ts buildPreFlightError`(line 511-563) | pre-flight resolveContextManager abort 时构造空 RunResult,无 abortReason | 接入 abortReason(`getAbortReason(params.abortSignal) ?? { kind: "external" }`),**不 emit EventBus 事件**——pre-flight 阶段 agent-loop 未启动,事件流应完整缺失(emit fired 但缺 run_end 破坏 INV-9 单向蕴含) |
| `agent-loop.ts` | turn 边界检查 abortSignal | 内部用 `createInterruptController` 合并外部 signal + 子 fork,**对外仍接 AbortSignal**(无接口形态变化) |
| `toTerminalAgentResult`(agent-loop.ts:289-301) | termination → AgentResult 单参映射,abort 路径仅带 usage | 签名扩为 `(termination, usage, abortReason?, abortFiredAt?)`,abort 路径补全 abortReason / exitDelayMs(INV-13);**不接 controller**——保持纯映射语义(§3.2.3:controller 只在创建/触发 abort 的地方持有) |
| `llm-call.ts` | for-await 无 abort 检查、无 idle-timeout | 接入 chunk 级 abort 检查 + 看门狗包装 stream + abort 路径返回 partial 数据 |
| `tool-executor.ts` | 串行执行无 per-iter check、aborted 时无占位 result | per-tool check + break + 暴露 unexecuted;**协议清理统一交给 cleanup** |
| `repl.ts` | readline + typeahead,无 SIGINT/Esc 处理 | agent run 期间装载 KeyboardSource(基于 `acquireStdinOwnership`)+ SignalSource |
| `acquireStdinOwnership`(cli/tui/_internal) | 现有 keypress ownership snapshot/restore | KeyboardSource 复用此机制,与 typeahead-input / confirmation-renderer 共用同一协调原语 |
| `resolveContextManager`(core/context/termination.ts) | "abort 优先"归一化样板 | cleanup 模块借鉴同样的判别联合归一化模式 |
| `trackMessages`(cli/run-agent.ts:680-703) | yield 流 → newMessages 重建(依赖 turn_complete 触发 user message 包装) | agent-loop 的 abort 退出路径**完整组装** assistant_message + tool_end + turn_complete yield 序列,让 trackMessages 零修改也能产生协议合规 newMessages |
| `EventBus AgentEventMap` | 已有 `agent:run_end` 含 reason="aborted" | 新增 `interrupt:warn` / `interrupt:fired` 事件,遵循 `{模块}:{动作}` 命名 |
| `AgentResult.aborted` | 当前只携带 usage | 新增 `abortReason?: AbortReason` + `exitDelayMs?: number`(仅 reason="aborted" 上有这两字段) |
| `LLMCallResult` | 单 shape `{ message, stopReason, usage, error? }` | **改为判别联合**(`aborted: false` / `aborted: true` 两 shape);属于 breaking change,需要外部消费者(若有)迁移 |
| `ToolDefinition` | `call(input, ctx)` | 可选新增 `interruptBehavior?: "cancel" \| "grace" \| "background"`(默认 cancel) |
| `LLM StopReason` | end_turn / tool_use / max_tokens / stop_sequence | **不变**——abort 通过 agent-loop 终止判定表达,不污染 LLM 层语义 |

**本规格不替代任何现有抽象**——只在四处插入"中断感知"代码,并新增独立的 `packages/core/src/interrupt/` 模块承载抽象。

---

## 1. 竞品调研

> 三方源码细读 5000+ 行,原文见 `research/source-analysis/{openclaw,hermes-agent,claude-code}/interruption-and-abort.md`。本节只列对设计决策有影响的对比。

### 1.1 三方设计哲学对比

| 维度 | OpenClaw(TS Daemon) | Hermes(Python Cooperative) | Claude Code(TS Ink) |
|------|----------------------|------------------------------|----------------------|
| **取消模型** | 原生 `AbortController` + `AbortSignal.any` | `threading.Event` + `bool` 双标志 polling | 原生 `AbortController` + reason 字符串协议 |
| **入口数量** | 5 个机制叠加(TUI/Gateway RPC/attempt/SDK/undici) | 5 个独立入口(KeyBinding/裸signal/asyncio loop/ACP RPC/KeyboardInterrupt) | 1 个统一路由(Ink useInput → keybinding → CancelRequestHandler → onCancel) |
| **多源汇聚** | attempt 内 `runAbortController` 单点收敛 | `AIAgent.interrupt()` 单点收敛 | `abortController.abort(reason)` reason 字符串区分 |
| **stream idle-timeout** | ✅ 60s 默认,stream wrapper(`llm-idle-timeout.ts`),每 chunk 重置 | ✅ 三层(httpx 120s + 应用 stale 180-300s + agent inactivity 1800s) | ✅ 90s + 45s warn 双阈值(**默认关闭**,需 `CLAUDE_ENABLE_STREAM_WATCHDOG`) |
| **iterator vs abort 协调** | `abortable()` wrapper 让所有 await 立即 reject(`attempt.ts:1281-1303`) | cooperative polling + force-close socket 双保险 | SDK 自身响应 signal.aborted(依赖 SDK 实现) |
| **tool abort 策略** | 单一 `AbortError`,Bash 同步 SIGKILL,backgrounded 豁免 | cooperative polling 200ms,subprocess SIGTERM→1s grace→SIGKILL,killpg 进程组 | 三类:Bash treeKill / WebFetch axios cancel / interruptBehavior 单工具决定 |
| **协议清理** | `flushPendingToolResultsAfterIdle` 30s 等 SDK idle | 跳过的 tool 必须写 fake `role: tool` placeholder | `yieldMissingToolResultBlocks` 合成 `is_error: true` placeholder |
| **partial 保留** | gateway 层独立 `chatRunBuffers` Map,broadcast + persist | persist_session 在每个 interrupt 退出点同步执行 | abort 前显式把 streamingText 物化为 assistant message |
| **REPL UX** | Ctrl+C 双击退出,Esc abort(IDE 风格) | Ctrl+C 单击 soft interrupt + 2s 内双击 hard exit | Esc 单击取消任务 + Ctrl+C 800ms 双击退出 |

### 1.2 各自的精彩与短板

**OpenClaw —— 抽象正确但实现散乱**
- ✅ 单一 `runAbortController` 收敛多源 abort
- ✅ idle-timeout 用 stream wrapper,跨 provider 通用
- ✅ `abortable()` race 让所有 await 立即 reject
- ❌ 3 套手写 abort+timeout 合并实现并存(历史包袱)
- ❌ Bash backgrounded 豁免逻辑分散在工具内部,无统一中断策略协议
- ❌ 协议清理依赖 30s wait-for-idle + 私有 SDK race 修补

**Hermes —— 实战充分但模型不优雅**
- ✅ 三层 timeout 分层各负其责
- ✅ 关闭路径双重 try/except 对再次 SIGINT 免疫
- ✅ 递归 child agent interrupt
- ❌ threading.Event + polling——Node.js 无需 polling
- ❌ 5 个独立入口都各自调 `interrupt()`,没有插件化 source 抽象
- ❌ Force-close socket reach-into-httpx-internals,脆但有效

**Claude Code —— UX 最成熟,但 reason 语义是叠加产物**
- ✅ stream idle-timeout 90s + 45s warn 双阈值,`exit_delay_ms` 测量传播延迟
- ✅ Esc 单击取消 / Ctrl+C 800ms 双击退出 —— 符合 shell/CLI 用户预期
- ✅ 中断时显式物化 streamingText
- ✅ `yieldMissingToolResultBlocks` 自动合成 placeholder
- ❌ 5 种 reason 字符串是逐步演化堆出来的——拼写错误编译期发现不了
- ❌ stream watchdog **默认关闭**,新项目不应继承
- ❌ Ink useInput + keybinding 框架完整但重,简单 readline REPL 不需要

### 1.3 知行的超越点

| 维度 | 知行选择 | 对比依据 |
|------|---------|---------|
| **AbortReason 类型** | discriminated union(`{ kind, ...metadata }`),不是字符串 | OpenClaw Error+cause 在做"类型化 reason"但没系统化;Claude Code 字符串 reason 演化已现脆性 |
| **核心抽象** | **不引入 controller class**,提供 4 个 helper(create/abort/get/fork) | zhixing 现有所有 API 全程用 `AbortSignal`;引入 class 制造双轨制 |
| **iterator 与 abort 协调** | **race 是基础能力**,与 idle-timeout 是否启用解耦;watchdog 总是包装 race + 可选叠加 idle-timer | 保证 mock 测试和真实 SDK 路径行为一致;不依赖 SDK 自身响应 abort |
| **看门狗默认状态** | 默认开 + 可配置(idleTimeoutMs=0 仅禁用 idle-timer,race 仍工作) | Claude Code 默认关是历史包袱;OpenClaw/Hermes 默认开印证 idle-timeout 是必备能力 |
| **看门狗双阈值** | warn (50%) + abort (100%) 都触发 EventBus,UI 层显示倒计时 | Claude Code 仅 log;知行用户能在警告时主动决定 |
| **工具中断策略** | 三类协议化(cancel/grace/background)写进 ToolDefinition | OpenClaw 散落工具内部;Claude Code 二元少了 grace 中间态 |
| **协议清理职责分层** | cleanup 模块**只产数据**(partialAssistant + placeholderToolResults),agent-loop **统一组装 yield 序列**(含 turn_complete) | 单一事实源;trackMessages 零修改自然包出 user message |
| **REPL 输入** | 复用现有 `acquireStdinOwnership` + 简单 stdin raw mode;Esc 单击 cancel + Ctrl+C 800ms 双击 exit | Claude Code Ink 太重;OpenClaw TUI IDE 风格不符合 shell 用户预期 |
| **interrupt:fired emit 协议** | `abortWithReason` 是纯函数不发事件;agent-loop 的 abort listener **只记录 abortFiredAt(同步操作)**;**emit fired 在退出路径里显式 await**,严格保证 INV-9 顺序 | listener fire-and-forget emit 会与 await emit run_end 时序错乱 |
| **不做** | 'user-typed' 中断 / 自然语言 abort / 跨进程 RPC / 投机执行 / TCP reach-in / partial tool_use 保留 | 范围边界清晰,避免堆功能 |

---

## 2. 不变量(Invariants)

可中断 Agent Loop 的正确性由以下不变量定义。任何实现和修改都必须保持这些不变量。

**INV-1. 中断响应延迟上界**:从 `abortWithReason()` 调用到 `runAgentLoop` AsyncGenerator return 终态的 P95 延迟 ≤ 200ms,**仅指 loop 框架延迟**(不含正在执行的工具自身 abort 等待时间——后者由 ToolInterruptBehavior 决定上界)。SLO 监控必须从 InterruptFiredEvent 计算 `loopFrameworkDelay = exitDelayMs - toolGraceMs`,直接拿 `exitDelayMs` 会把 grace 类工具的合规等待误判为框架性能问题。

**INV-2. 单一 ground truth**:每次 `runAgentLoop` 调用内部仅持有**一个** `AbortController` 实例(由 `createInterruptController` 创建)。所有外部 `abortSignal`、看门狗触发、SIGINT、子 agent fork 都必须通过该 controller 收敛——下游只 wire 一个 `signal`。

**INV-3. AbortReason 永远可读**:`signal.aborted === true` 时,调用 `getAbortReason(signal)` 返回值满足以下其一:
- 合法的 `AbortReason` 判别联合实例(本模块通过 `abortWithReason` 触发)
- `null`(外部 AbortSignal 直接 aborted、未经 `abortWithReason`)

下游可放心 `switch (reason?.kind)`,并对 null 做"未知中断源"分支处理。

**INV-4. 协议合规**:abort 退出后,`AgentRuntime.run` 返回的 `RunResult.newMessages` 中:
- 每个 `tool_use` block 都有匹配的 `tool_result`(id 对应、顺序在后)
- 任何流式收到的 `tool_use`(无论 args 是否完整)一律不进 partial assistant message,由 cleanup 在 unexecutedToolUses 中注入合成 `tool_result` placeholder

**INV-5. Partial 保留**:abort 时已经累积的 `pendingText` / `pendingThinking`,必须在终止前作为一条 `assistant_message` yield 出去,**partial assistant message 必须可视地携带 `[interrupted]` 标记**——用户读 transcript 时能立即识别"这是中断的回复",而不是误以为是完整结束。具体规则:
- 有 text 时:在 text block 末尾追加 `\n\n[interrupted]`
- 仅 thinking、无 text 时:追加一个独立 `text` block(内容为 `[interrupted]`)——thinking-only 也必须有标记可读,否则 transcript 仅显示 thinking 内容会让用户误以为是"已结束的 thinking"
- text 与 thinking 都为空时:不 yield assistant_message(无内容可携带)

partial assistant message **只承载 text + thinking 两类 block**,不携带 tool_use(详见 §3.6.4 设计代价说明)。

**INV-6. 看门狗时间维度**:`StreamWatchdog` 是 chunk-arrival idle,不是 wall-clock total。每个 stream event 到达必须 reset timer。warn 与 abort 共享同一 timer 重置点;reset 后下一周期允许再次 warn。

**INV-7. 看门狗资源回收**:`StreamWatchdog` 在 stream 正常结束 / abort / consumer 提前 return / iterator throw 任一终态都必须 `clearTimeout(timer)` 并 `removeEventListener` 掉所有挂在 abort signal 上的 listener。不允许定时器或 listener 泄漏到下一轮 turn。

**INV-8. 子 controller 不反向影响**:`forkController(parent)` 创建的子 controller,子 abort 时**不影响**父;父 abort 时所有子**自动**abort(带 `{ kind: "parent-abort", parentReason }`)。

**INV-9. EventBus 顺序与归属**:每次 agent-loop 内的 abort 必须按以下顺序发射事件——`interrupt:warn`(仅 idle-timeout 50% 触发)→ `interrupt:fired`(abort 触发后、run_end 之前)→ `agent:run_end`(loop 终止)。warn 不一定有,但**每次 `interrupt:fired` emit 都严格在同一 run 的 `agent:run_end` emit 之前**(单向蕴含,非数量对等——completed / max_turns / error 路径有 run_end 无 fired)。**emit 协议**:
- `interrupt:warn` 由 watchdog 内部 emit
- `interrupt:fired` **由 `emitRunEnd` 在 abort 路径上唯一调一次**——`emitRunEnd` 内部判断 `result.reason === "aborted"` 时先 `await emit("interrupt:fired", { reason, interruptedTurnIndex, exitDelayMs })`,再 `await emit("agent:run_end", ...)`。所有 abort 退出分支只调 emitRunEnd,fired 自动正确顺序、自动幂等、新增分支零负担
- abort listener 内**只**做同步操作(记录 `abortFiredAt`),**不**调用 emit——避免 fire-and-forget 时序错乱
- 任何调用 `abortWithReason` 的方(watchdog / KeyboardSource / SignalSource / 父 agent fork 传播)都不自行 emit fired
- **`agent-loop` 启动前的 abort(pre-flight 路径)既不 emit `interrupt:fired` 也不 emit `agent:run_end`**——pre-flight 失败的语义是"本次 run 未真启动",订阅方观察的事件流应完整缺失(没有 `agent:run_start`,自然没有 fired / run_end);emit fired 但缺 run_end 会成为孤儿事件破坏单向蕴含。`buildPreFlightError` 仅在 `RunResult.agentResult` 同步返回值上填 abortReason 即可

**INV-10. REPL 双击窗口确定**:Ctrl+C 双击退出窗口固定 800ms;超过则视为新一次单击。窗口可通过 ENV `ZHIXING_DOUBLE_PRESS_MS` 调整但不暴露 CLI flag。

**INV-11. Stdin 协调原语单源**:`KeyboardSource` 的 keypress 监听必须通过 `acquireStdinOwnership` 取得 ownership;release 时按相反顺序还原。**不允许新建 keypress ownership 协调机制**。**任何在 state.running=true 期间需要 cooked mode 的调用方(`readline.question` / 临时文本输入子 UI)必须先 `keyboardSource.pause()`、finally `resume()`**——KeyboardSource 与 readline 不能同时持有 stdin。

**INV-12. iterator 与 abort 同步退出**:`wrapStreamWithWatchdog` 包装的 stream,其 iterator.next() 在 controller.signal aborted 后必须 ≤10ms 返回 `{ done: true }`。**此能力由 race 层提供,与 idle-timeout 是否启用无关**——`idleTimeoutMs=0` 仅关闭 idle timer,race 仍然生效。

**INV-13. AgentResult 字段范围与终止优先级**:`abortReason` / `exitDelayMs` 字段**仅出现在 `reason: "aborted"` 分支**。`reason: "max_turns"` 是与 abort 平行的独立终止类型,不携带这两字段、不调用 `abortWithReason`。**当 abort 与 max_turns 同时满足时(典型:用户在最后一轮按 Esc),abort 优先**——agent-loop 入口先 abort guard 再 max_turns guard,与 termination.ts 的"abort 优先于 context_overflow"哲学对称,保证用户中断意图永不被被动达到上限的判定覆盖。

**INV-14. usage 计入**:abort 路径下 `AgentResult.usage` 必须等于 `mergeUsage(state.totalUsage, llmResult.usage)`(若 llmResult 存在)。abort 退出时 yield 的 `turn_complete.usage` 必须等于 `llmResult.usage`(若存在),不得用 `emptyUsage()` 占位。LLM 计费按服务端实际处理的 tokens 计算,客户端中断不会免除——usage 必须如实反映。

---

## 3. 架构

### 3.1 分层视图

```
┌─────────────────── REPL / 入口层 ──────────────────────┐
│  packages/cli/src/repl.ts                              │
│   ├─ agent run 期间装载 KeyboardSource + SignalSource   │
│   └─ 把 controller.signal 作为 abortSignal 传 run()    │
│                                                        │
│  packages/cli/src/interrupt/                            │
│   ├─ keyboard-source.ts  Esc / Ctrl+C / Ctrl+D 解析    │
│   ├─ signal-source.ts    SIGINT / SIGTERM 兜底         │
│   └─ double-press.ts     Ctrl+C 800ms 双击退出         │
└──────────────────┬─────────────────────────────────────┘
                   │ controller.signal(原生 AbortSignal)
                   │
                   │ abortSignal 透传链:
                   │   REPL → agentRuntime.run({ abortSignal })
                   │        → runAgentLoop({ abortSignal })
                   │        → createInterruptController({ externalSignals: [abortSignal] })
                   ▼
┌─────────────── 中断模块 ──────────────────────────────────┐
│  packages/core/src/interrupt/                            │
│   ├─ types.ts        AbortReason / WatchdogPolicy        │
│   ├─ controller.ts   createInterruptController +         │
│   │                   abortWithReason + getAbortReason + │
│   │                   forkController                     │
│   ├─ stream-race.ts  wrapStreamWithAbortRace             │
│   │                   (race 基础层,INV-12 总是生效)     │
│   ├─ watchdog.ts     wrapStreamWithWatchdog              │
│   │                   (facade:race + 可选 idle-timer)   │
│   ├─ cleanup.ts      buildCleanup(出数据,不出 yield)   │
│   ├─ assemble.ts     assemblePartialMessage              │
│   │                   (仅 text + thinking)              │
│   └─ graceful-kill.ts gracefulKill helper(跨平台)      │
└──────────────────┬─────────────────────────────────────┘
                   │ 改造对象
                   ▼
┌─────────────── Agent Loop 层(已有,最小化插入点) ──────┐
│  packages/core/src/loop/                                │
│   ├─ agent-loop.ts    内部 createInterruptController +   │
│   │                    注册 abort listener 同步记         │
│   │                    abortFiredAt(不 emit)+         │
│   │                    abort 退出路径 await emit fired + │
│   │                    调 buildCleanup +                 │
│   │                    自己组装 yield 序列(INV-4 / 5) │
│   ├─ llm-call.ts      stream wrap watchdog + chunk break │
│   │                    + abort 路径返回 partial 数据     │
│   │                    (不 yield assistant_message)    │
│   └─ tool-executor.ts per-iter check + 暴露 unexecuted   │
│                        给 cleanup(不再自己合成)         │
└──────────────────┬─────────────────────────────────────┘
                   │ ctx.abortSignal(与现有完全相同)
                   ▼
┌─────────────── 工具层 ──────────────────────────────────┐
│  Bash (grace) / WebFetch (cancel) / Memory (cancel) ... │
│  通过 ctx.abortSignal 收到中断;grace 类用 gracefulKill  │
└─────────────────────────────────────────────────────────┘
```

### 3.2 核心抽象:4 个 helper + AbortReason 判别联合

#### 3.2.1 `AbortReason`:判别联合,承载类型化 metadata

```typescript
// packages/core/src/interrupt/types.ts

export type AbortReason =
  | UserCancelReason
  | IdleTimeoutReason
  | ParentAbortReason
  | ExternalSignalReason;

export interface UserCancelReason {
  readonly kind: "user-cancel";
  readonly source: "esc" | "ctrl-c" | "sigint" | "rpc";
  readonly pressedAt: number;            // monotonic ms
}

export interface IdleTimeoutReason {
  readonly kind: "idle-timeout";
  readonly timeoutMs: number;            // 触发的阈值
  readonly chunksReceived: number;       // 触发前已收到 chunk 数
  readonly elapsedSinceLastChunkMs: number;
}

export interface ParentAbortReason {
  readonly kind: "parent-abort";
  readonly parentReason: AbortReason | null;   // 父若非本模块控制,可能是 null
}

export interface ExternalSignalReason {
  readonly kind: "external";
  readonly origin?: string;              // 调用方可标注(如 "scheduler-task-timeout")
}

export interface WatchdogPolicy {
  /** chunk 间最大间隔(ms)。默认 60_000;0 仅禁用 idle-timer,race 仍生效(INV-12) */
  readonly idleTimeoutMs: number;
  /**
   * 警告阈值比例。**约束:必须在 (0, 1) 开区间内**。
   * 默认 0.5;触发后 EventBus 发 interrupt:warn。
   * 不满足约束时 createWatchdogPolicy 抛 TypeError;直接构造对象使用属于编程错误。
   */
  readonly warnThresholdRatio: number;
}

export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = {
  idleTimeoutMs: 60_000,
  warnThresholdRatio: 0.5,
};

/**
 * 工厂构造器:验证 warnThresholdRatio 在 (0, 1) 开区间内。
 * 配置层(如 run-agent.ts 透传用户配置)推荐通过此函数创建 WatchdogPolicy。
 */
export function createWatchdogPolicy(opts: Partial<WatchdogPolicy> = {}): WatchdogPolicy {
  const policy = { ...DEFAULT_WATCHDOG_POLICY, ...opts };
  if (policy.warnThresholdRatio <= 0 || policy.warnThresholdRatio >= 1) {
    throw new TypeError(
      `WatchdogPolicy.warnThresholdRatio must be in (0, 1), got ${policy.warnThresholdRatio}`,
    );
  }
  return policy;
}
```

**为什么没有 `MaxTurnsReason`**:max-turns 是 `AgentResult.reason="max_turns"` 独立终止类型,不走 abort 路径。把 max-turns 纳入 AbortReason 会让"达到上限"和"被中断"语义混淆。

**为什么不用字符串 reason**:Claude Code 5 种 reason 字符串是演化产物,下游 `if (reason === '...')` 拼写错误编译期发现不了。判别联合让 `switch (reason.kind)` 在 `--strict` 下穷尽检查;元数据强类型,IDE 自动补全。

**预留扩展槽位**:未来若需要 `'user-typed'` / `'sibling-error'` / `'background'`,加新 interface 即可,不破坏现有契约。

#### 3.2.2 4 个 helper 函数:保持原生 AbortController 心智

```typescript
// packages/core/src/interrupt/controller.ts

import { setMaxListeners } from "node:events";
import type { AbortReason } from "./types.js";

const DEFAULT_MAX_LISTENERS = 50;

/**
 * 创建一个新的 AbortController,自动处理:
 * - setMaxListeners(50) 绕开 EventEmitter 默认 10 listener 警告
 * - 合并多个外部 AbortSignal:任一 aborted → controller aborted(reason: external)
 *
 * 返回原生 AbortController,对外接口零侵入。
 */
export function createInterruptController(opts?: {
  readonly externalSignals?: readonly AbortSignal[];
  readonly maxListeners?: number;
}): AbortController {
  const controller = new AbortController();
  setMaxListeners(opts?.maxListeners ?? DEFAULT_MAX_LISTENERS, controller.signal);

  for (const ext of opts?.externalSignals ?? []) {
    if (ext.aborted) {
      abortWithReason(controller, { kind: "external" });
      continue;
    }
    const onExtAbort = () => abortWithReason(controller, { kind: "external" });
    ext.addEventListener("abort", onExtAbort, { once: true });
  }

  return controller;
}

/**
 * 触发 abort 并附带类型化 reason。reason 通过原生 signal.reason 传递。
 * 幂等:已 aborted 时 no-op,不覆盖原 reason。
 *
 * **纯函数契约**:本函数不发任何 EventBus 事件、不写日志。
 * emit interrupt:fired 是 agent-loop 模块的责任(INV-9)。
 */
export function abortWithReason(controller: AbortController, reason: AbortReason): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
}

/**
 * 安全地从 AbortSignal 提取 AbortReason。
 * 仅识别本模块通过 abortWithReason 触发的 abort;其他来源(如外部 signal、controller.abort()
 * 不带 reason)返回 null,调用方应做"未知 reason"分支处理。
 */
export function getAbortReason(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) return null;
  const r = signal.reason;
  if (r && typeof r === "object" && "kind" in r && typeof r.kind === "string") {
    return r as AbortReason;
  }
  return null;
}

/**
 * 创建子 controller,父 abort → 子自动 abort(reason: parent-abort);
 * 子 abort 不影响父(INV-8)。子也走 setMaxListeners(50)。
 */
export function forkController(parent: AbortController): AbortController {
  const child = createInterruptController();

  if (parent.signal.aborted) {
    abortWithReason(child, {
      kind: "parent-abort",
      parentReason: getAbortReason(parent.signal),
    });
    return child;
  }

  const onParentAbort = () => {
    abortWithReason(child, {
      kind: "parent-abort",
      parentReason: getAbortReason(parent.signal),
    });
  };
  parent.signal.addEventListener("abort", onParentAbort, { once: true });
  return child;
}
```

**为什么不引入 controller class**:zhixing 现有所有 API 全程用 `AbortSignal`(ChatRequest、ToolExecutionContext、ContextManagerInput 等)。引入 class 会制造双轨制——旧调用方传 abortSignal、新调用方传 controller。helper 函数模式保持原生 AbortController 心智,任何接 `AbortSignal` 的库(fetch、Anthropic SDK、setTimeout 等)零改动接入;fork 关系通过 `forkController(parent)` 显式表达。

#### 3.2.3 命名约定:abortSignal 与 controller 何时用哪个

整个代码库遵循以下命名约定:

- **`AbortSignal` 是只读跨边界传递的抽象**——用作函数参数、ToolExecutionContext 字段、ChatRequest 字段。所有现有 API 不变。
- **`AbortController` 是可写的所有者持有**——只在创建/触发 abort 的地方出现(agent-loop 内部、source 模块、fork 调用方)。
- **从不在工具层、Provider 层、ContextManager 层暴露 AbortController**——避免下游误调 `.abort()` 把上游状态搞乱。
- **loop 内部子生成器例外:`streamLLMCall` 接 `controller: AbortController` 而非 abortSignal**——`wrapStreamWithWatchdog` 的 idle-timer 触发时必须能调 `abortWithReason(controller, ...)`,只有 controller 暴露 abort 能力。下游 `ChatRequest.abortSignal = controller.signal`,Provider 层语义不变。`tool-executor` / `resolveContextManager` 仍接 abortSignal——它们是观察者不是触发者,无需写权限。

### 3.3 中断信号流

```
[键盘] Esc / Ctrl+C
   ↓ stdin raw mode(acquireStdinOwnership 协调)
[KeyboardSource] keypress 解析 + 双击窗口判定
   ↓ abortWithReason(controller, { kind: "user-cancel", source: "esc", pressedAt })
[AbortController] signal.aborted = true; signal.reason = AbortReason
   ↓ "abort" 事件触发
   ├─→ [agent-loop 注册的 abort listener] 同步记 abortFiredAt(不 emit)
   ├─→ [stream-race 内部] iterator.next 立即返回 { done: true }(INV-12)
   ├─→ [llm-call.ts watched stream] for-await 拿到 done → 退出循环
   │     根据是否 aborted 走 abort 路径 return partial 数据
   ├─→ [Anthropic SDK / OpenAI SDK] fetch signal aborted → 抛 AbortError
   │     被 race + try/catch 统一吸收
   ├─→ [tool-executor.ts] 当前正在跑的工具看到 ctx.abortSignal.aborted
   │     ├─ ToolInterruptBehavior=cancel → 工具 fast-path return
   │     ├─ ToolInterruptBehavior=grace  → gracefulKill: SIGTERM → 1s grace → SIGKILL
   │     └─ ToolInterruptBehavior=background → 不杀,记录 background 引用
   │   工具返回(含 partial 输出)→ tool-executor 收到 result → 退出循环
   └─→ [子 agent fork controller] 父 abort → 子收到 parent-abort
[agent-loop.ts] 进入终止流程
   ↓ const outcome = buildCleanup({ partial, unexecutedToolUses, reason });
   ↓ 按 outcome 自己组装 yield 序列:
   │   1. partialAssistant 非 null → yield assistant_message
   │   2. 每个 placeholder → yield tool_end (with id/name 反查)
   │   3. 有任何 placeholder → yield turn_complete with llmResult.usage(INV-14)
[agent-loop.ts] return await emitRunEnd(eventBus, startTime, abortResult, abortFiredAt, state.turnCount)
[emitRunEnd] await emit("interrupt:fired", { reason, interruptedTurnIndex, exitDelayMs, toolGraceMs })   // INV-9
[emitRunEnd] await emit("agent:run_end", { reason: "aborted", ... })
```

### 3.4 流响应中断:race 基础层 + idle-timer 叠加层

#### 3.4.1 两层职责分离

stream 中断能力分两层职责:

1. **race 层(`wrapStreamWithAbortRace`)**:基础能力,保证 INV-12——iterator.next 在 abort 后 ≤10ms 退出,不依赖底层 stream 自身响应 abort。**永远生效**,无开关。
2. **idle-timer 层(可选叠加)**:chunk-arrival idle 触发 abort,保证 INV-6。可通过 `idleTimeoutMs=0` 关闭。

`wrapStreamWithWatchdog` 是对外 facade,根据 policy 组合两层。

```typescript
// packages/core/src/interrupt/stream-race.ts

/**
 * 包装 stream,让 iterator.next() race controller.signal:
 * abort 触发后 ≤10ms 返回 { done: true }(INV-12)。
 *
 * 不挂任何 timer、不依赖任何 policy——纯粹的 race 能力。
 * Listener 在每次 next() 前注册、settle 后立即移除,无泄漏。
 */
export function wrapStreamWithAbortRace<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const result = await raceIteratorWithAbort(iterator, controller.signal);
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

/**
 * race iterator.next() 与 abort signal。abort 触发时立即返回 { done: true };
 * 否则返回 iterator 真实结果。listener 在 promise settle 后 removeEventListener 防泄漏(INV-7)。
 */
async function raceIteratorWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined };

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ done: true, value: undefined });
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    iterator.next().then(
      (r) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}
```

```typescript
// packages/core/src/interrupt/watchdog.ts

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { abortWithReason } from "./controller.js";
import { wrapStreamWithAbortRace } from "./stream-race.js";
import { DEFAULT_WATCHDOG_POLICY, type WatchdogPolicy } from "./types.js";

/**
 * Facade:race 基础层(总是包装)+ 可选 idle-timer 叠加层。
 * - policy.idleTimeoutMs > 0 → 包 race + idle-timer
 * - policy.idleTimeoutMs <= 0 → 仅包 race(idle-timer 关闭,但 INV-12 仍保证)
 */
export function wrapStreamWithWatchdog<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  policy: WatchdogPolicy = DEFAULT_WATCHDOG_POLICY,
  eventBus?: IEventBus<AgentEventMap>,
): AsyncIterable<T> {
  const raced = wrapStreamWithAbortRace(stream, controller);
  if (policy.idleTimeoutMs <= 0) return raced;
  return wrapWithIdleTimer(raced, controller, policy, eventBus);
}

function wrapWithIdleTimer<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  policy: WatchdogPolicy,
  eventBus?: IEventBus<AgentEventMap>,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let chunksReceived = 0;
      let lastChunkAt = Date.now();
      let warnTimer: NodeJS.Timeout | null = null;
      let abortTimer: NodeJS.Timeout | null = null;

      const clearTimers = () => {
        if (warnTimer !== null) { clearTimeout(warnTimer); warnTimer = null; }
        if (abortTimer !== null) { clearTimeout(abortTimer); abortTimer = null; }
      };

      const armTimers = () => {
        clearTimers();
        const warnMs = policy.idleTimeoutMs * policy.warnThresholdRatio;

        warnTimer = setTimeout(() => {
          eventBus?.emit("interrupt:warn", {
            kind: "idle-timeout-warn",
            elapsedMs: Date.now() - lastChunkAt,
            timeoutMs: policy.idleTimeoutMs,
            chunksReceived,
          }).catch(() => {});
        }, warnMs);

        abortTimer = setTimeout(() => {
          abortWithReason(controller, {
            kind: "idle-timeout",
            timeoutMs: policy.idleTimeoutMs,
            chunksReceived,
            elapsedSinceLastChunkMs: Date.now() - lastChunkAt,
          });
        }, policy.idleTimeoutMs);
      };

      armTimers();
      try {
        while (true) {
          // 内层 stream 已经 race 过 abort,这里直接消费
          const result = await iterator.next();
          if (result.done) return;
          chunksReceived++;
          lastChunkAt = Date.now();
          armTimers();          // 每 chunk 重置(INV-6)
          yield result.value;
        }
      } finally {
        clearTimers();          // 任何终态都清理(INV-7)
      }
    },
  };
}
```

**关键设计**:
- race 是基础能力(INV-12),与 idle-timer 是否启用无关——`idleTimeoutMs=0` 时仍包装 race
- idle-timer 触发 abort 时**不抛错**——只调 `abortWithReason()`;后续 race 立即返回 done,让 for-await 退出
- warn 与 abort 共享同一 reset 点;新周期允许再次 warn(INV-6)

#### 3.4.2 `llm-call.ts` 改造:先处理 event、再 check abort、abort 路径返回 partial 数据

为了保证 partial 内容完整(INV-5),abort check **必须放在 event 处理之后**——确保 abort 发生瞬间收到的最后一个 chunk 已被累积进 pendingText。

```typescript
// packages/core/src/loop/llm-call.ts (摘要)

// streamLLMCall API 形态:接 controller 而非 abortSignal(详见 §3.2.3 "loop 内部子生成器例外")。
// agent-loop 创建 controller 后透传:
//   yield* streamLLMCall({ deps, messages, model, ..., controller, watchdog: watchdogPolicy, eventBus })
// 下游 ChatRequest.abortSignal = controller.signal,Provider 层语义不变。
const watched = wrapStreamWithWatchdog(stream, controller, watchdogPolicy, eventBus);

try {
  for await (const event of watched) {
    // 先处理:累积 partial / yield delta(确保 abort 瞬间收到的最后一个 chunk 已进 pendingText/Thinking)
    await eventBus?.emit("llm:stream_event", event);
    switch (event.type) { /* 现有逻辑:累积 pendingText / pendingThinking / pendingToolCalls */ }

    // 再 check:race 层(INV-12)已保证下次 next() 在 abort 后 ≤10ms 返回 done,
    // 此处显式 break 是与 race 形成双保险——表达"本 event 处理完即退出"的意图,
    // 省一次 micro-task 的 race resolve 等待,让 abort 响应延迟更稳定
    if (controller.signal.aborted) break;
  }
} catch (err) {
  if (controller.signal.aborted) {
    // SDK 抛 AbortError——落到下方 abort 出口
  } else {
    return { aborted: false, message, stopReason, usage, error: toAgentError(err) };
  }
}

if (controller.signal.aborted) {
  // abort 路径:只返回 partial 数据,不 yield assistant_message,不 assemble 完整 message。
  // 由 cleanup + agent-loop 统一处理 partial assistant message 的构造与 yield。
  // pendingToolCalls 故意丢弃——partial assistant 仅承载 text + thinking(INV-5)。
  return {
    aborted: true,
    partial: { text: pendingText, thinking: pendingThinking },
    usage,                       // INV-14:partial usage 必须如实返回(LLM 已实际处理)
  };
}

// 正常出口:yield 完整 assistant_message
const message = assembleMessage(contentBlocks, pendingText, pendingThinking, pendingToolCalls);
yield { type: "assistant_message", message };
return { aborted: false, message, stopReason, usage };
```

`LLMCallResult` 改为判别联合(**breaking change**:loop/index.ts 导出此类型,外部消费者需迁移到判别联合分支判定):

```typescript
// packages/core/src/loop/types.ts

export type LLMCallResult =
  | {
      readonly aborted: false;
      readonly message: Message;
      readonly stopReason: StopReason;
      readonly usage: TokenUsage;
      readonly error?: AgentError;
    }
  | {
      readonly aborted: true;
      readonly partial: {
        readonly text: string;
        readonly thinking: string;
      };
      readonly usage: TokenUsage;
    };
```

**为什么 abort 路径不 yield assistant_message**:保证"partial assistant message 只含 text + thinking"这一不变量在源头就被强制。yield assistant_message 的责任移交给 agent-loop 在 cleanup 后统一执行。

**为什么 LLM StopReason 不加 "aborted"**:abort 是 agent loop 的终止判定,不是 LLM 的回复终止原因。LLM 层只负责"我组装了什么",回到 agent-loop 后才判定整个 turn 是 aborted 还是 completed。

### 3.5 工具中断:cancel / grace / background + gracefulKill

#### 3.5.1 `ToolDefinition.interruptBehavior`

```typescript
// packages/core/src/types/tools.ts

export type ToolInterruptBehavior =
  | "cancel"      // 默认。abort 信号到达即立即中止;纯 JS 工具(read/edit/grep/web_fetch)适用
  | "grace"       // SIGTERM → 1s grace → SIGKILL;长跑外部进程(bash)适用
  | "background"; // 不中止,工具应 yield background 引用(Step 22 BackgroundAgent 才用)

export interface ToolDefinition<TInput = unknown> {
  // ... 现有字段
  /**
   * 工具被 abort 时的行为。默认 "cancel"。
   * - cancel: tool.call 内部应该尽快 reject AbortError 或 return(看 ctx.abortSignal)
   * - grace: 工具自身实现 SIGTERM→grace→SIGKILL(推荐用 gracefulKill helper)
   * - background: 工具 yield 一个 background ref,主 loop 不等
   */
  interruptBehavior?: ToolInterruptBehavior;
}
```

#### 3.5.2 `tool-executor.ts` 改造:per-iter check + 暴露 unexecuted

```typescript
// packages/core/src/loop/tool-executor.ts (摘要)

export interface ExecuteToolCallsResult {
  readonly completedResults: readonly ToolResultBlock[];
  /** abort 时未执行的 tool_use(按原顺序),交由 cleanup 注入 placeholder */
  readonly unexecutedToolUses: readonly ToolUseBlock[];
  /**
   * abort 触发瞬间正在执行的工具的退出时刻(`performance.now()` 值)。
   * - abort 发生在工具 await 期间(无论工具响应 abort 抛 AbortError 还是正常 return partial)→ 有值
   * - abort 发生在工具间隙(循环顶部 abort guard 触发)→ undefined
   * - 非 abort 退出 → undefined
   *
   * 用途:agent-loop 据此与 abortFiredAt 计算 `toolGraceMs = max(0, abortedDuringToolAt - abortFiredAt)`,
   * 表达"工具自身 abort 等待消耗"。InterruptFiredEvent 携带 toolGraceMs 让订阅方做 P95 SLO 监控时
   * `loopFrameworkDelay = exitDelayMs - toolGraceMs`,与 INV-1 "不含工具自身 abort 时间" 严格对应。
   */
  readonly abortedDuringToolAt?: number;
}

export async function* executeToolCalls(...): AsyncGenerator<AgentYield, ExecuteToolCallsResult> {
  const results: ToolResultBlock[] = [];
  let abortedAtIndex: number | null = null;
  let abortedDuringToolAt: number | undefined;   // 工具退出瞬间(若 abort 发生在工具 await 期间)

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;

    // abort 检查在循环最前——比"工具未找到"分支早,保证已 aborted 时不再消耗任何工具
    // 注意:这里 abort 是"工具间隙"触发,不记 abortedDuringToolAt(loopFrameworkDelay 全归 loop)
    if (signal.aborted) {
      abortedAtIndex = i;
      break;
    }

    const tool = toolMap.get(call.name);
    if (!tool) {
      // 工具未找到分支保持现有 isError tool_result 路径(tool-executor.ts L76-100)——
      // 它不是 abort 触发,不进入 unexecutedToolUses,直接合成 isError 结果继续下一个
      continue;
    }

    const ctx: ToolExecutionContext = {
      workingDirectory,
      abortSignal: signal,
      llm: llmRoles,
    };

    try {
      const rawResult = await deps.executeTool(tool, call.input, ctx);

      // 现有 ToolResultBlock 推入 results + yield tool_end + emit tool:call_end(L108-137 保留)。
      // **必须放在 abort 检查之前**——保证当前工具完成的合规 result 一定进入 completedResults,
      // 否则 abort 时丢 result 会让 LLM 在下一轮看不到该工具已执行,可能重发同 tool_use 引发幂等性破坏(写类工具会重复写)。

      if (signal.aborted) {
        // 工具响应 abort 后正常 return(可能是 partial output);记录退出时刻供 toolGraceMs 计算
        abortedDuringToolAt = performance.now();
        abortedAtIndex = i + 1;        // 当前工具已完成,unexecutedToolUses 从下一个开始
        break;
      }
    } catch (err) {
      if (signal.aborted) {
        // 工具响应 abort 抛 AbortError;记录退出时刻供 toolGraceMs 计算
        abortedDuringToolAt = performance.now();
        abortedAtIndex = i;
        break;     // 不合成,由 cleanup 注入 placeholder
      }
      // 非 abort 错误走现有 isUserFacingError 路径(保留 L138-172 逻辑)
    }
  }

  return {
    completedResults: results,
    unexecutedToolUses: abortedAtIndex !== null
      ? toolCalls.slice(abortedAtIndex)
      : [],
    abortedDuringToolAt,
  };
}
```

**关键设计**:tool-executor 只暴露 unexecutedToolUses 列表(保留 ToolUseBlock 完整对象,含 id + name + input),**不自己合成任何 placeholder**。所有合成逻辑由 cleanup 模块承担——单一事实源原则。

#### 3.5.3 `gracefulKill` helper:跨平台

```typescript
// packages/core/src/interrupt/graceful-kill.ts

import type { ChildProcess } from "node:child_process";

export interface GracefulKillOptions {
  /** SIGTERM 后等 SIGKILL 的时间(ms)。默认 1000 */
  readonly graceMs?: number;
}

/**
 * 跨平台优雅停止子进程。
 * - POSIX: SIGTERM → graceMs 等待 → SIGKILL(含进程组)
 * - Windows: SIGTERM 不可靠 → 直接 process.kill()(taskkill /F 等价语义)
 *
 * 返回 Promise<void>,在 child 退出或 SIGKILL 后 resolve(永不 reject)。
 */
export async function gracefulKill(
  child: ChildProcess,
  opts: GracefulKillOptions = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    try { child.kill(); } catch { /* 已退出 */ }
    return waitForExit(child);
  }

  const graceMs = opts.graceMs ?? 1000;
  try {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } }
    }
  } catch { /* 已退出 */ }

  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    sleep(graceMs).then(() => false),
  ]);

  if (!exited) {
    try {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
      }
    } catch { /* 已退出 */ }
    await waitForExit(child);
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**强制使用约束**:所有 `interruptBehavior: "grace"` 的工具实现必须 import `gracefulKill`,不允许自写 SIGTERM/SIGKILL 升级链。

### 3.6 协议清理:cleanup 出数据,agent-loop 组 yield

#### 3.6.1 设计原则:分层职责清晰

cleanup 模块**只产语义化数据**——partialAssistant Message + placeholderToolResults 数组。它**不产 yield 序列**,因为 yield 序列需要 agent-loop 持有的状态(turnCount / usage / 反查 tool name 的 map)。

agent-loop 在退出前调 cleanup 拿数据,**自己组装** yield 序列(含 trackMessages 需要的 turn_complete)。

这一分层让:
- cleanup 模块零状态依赖,纯函数易测
- agent-loop 是 yield 序列的唯一组装者,trackMessages 零修改即可正确包出 user message
- 单一事实源——所有合成逻辑只在 cleanup 模块出现一次

#### 3.6.2 接口定义

```typescript
// packages/core/src/interrupt/cleanup.ts

import type { ToolUseBlock, ToolResultBlock, Message } from "../types/messages.js";
import type { AbortReason } from "./types.js";

export interface CleanupContext {
  /**
   * llm-call abort 路径返回的 partial 数据(abort 时尚未 yield assistant_message)。
   * 仅承载 text + thinking,不含 tool_use(INV-5)。
   * abort 不在 LLM 流响应阶段时为 undefined。
   */
  readonly partial?: {
    readonly text: string;
    readonly thinking: string;
  };
  /**
   * tool-executor 返回的未执行 ToolUse(保留完整对象含 id + name + input)。
   * 由 cleanup 注入合成 tool_result placeholder。
   * abort 不在工具执行阶段时为空数组或 undefined。
   */
  readonly unexecutedToolUses?: readonly ToolUseBlock[];
  /** abort 原因 */
  readonly reason: AbortReason | null;
}

/**
 * 清理结果 —— 判别联合,借鉴 ContextTermination 风格。
 *
 * - "no-cleanup": 无 partial、无 unexecuted → 调用方无需做任何 yield
 * - "data":       含 partialAssistant 与/或 placeholderToolResults → 调用方据此组 yield 序列
 */
export type CleanupOutcome =
  | { readonly kind: "no-cleanup" }
  | {
      readonly kind: "data";
      /** partial assistant message(仅 text + thinking blocks);无内容时为 null */
      readonly partialAssistant: Message | null;
      /** 注入的 placeholder(按 unexecutedToolUses 顺序);空数组表示无需 yield tool_end */
      readonly placeholderToolResults: readonly ToolResultBlock[];
    };

export function buildCleanup(ctx: CleanupContext): CleanupOutcome;
```

#### 3.6.3 算法

```typescript
import { assemblePartialMessage } from "./assemble.js";

export function buildCleanup(ctx: CleanupContext): CleanupOutcome {
  const partialAssistant = ctx.partial
    ? assemblePartialMessage(ctx.partial.text, ctx.partial.thinking)
    : null;

  const placeholderToolResults: ToolResultBlock[] = (ctx.unexecutedToolUses ?? []).map(
    (tc) => ({
      type: "tool_result" as const,
      toolUseId: tc.id,
      content: `[Tool execution cancelled: ${formatReasonForToolResult(ctx.reason)}]`,
      isError: true,
    }),
  );

  if (partialAssistant === null && placeholderToolResults.length === 0) {
    return { kind: "no-cleanup" };
  }

  return { kind: "data", partialAssistant, placeholderToolResults };
}

function formatReasonForToolResult(r: AbortReason | null): string {
  if (!r) return "interrupted";
  switch (r.kind) {
    case "user-cancel": return `user pressed ${r.source}`;
    case "idle-timeout": return `stream idle ${Math.floor(r.timeoutMs / 1000)}s, ${r.chunksReceived} chunks received`;
    case "parent-abort": return "parent aborted";
    case "external": return r.origin ?? "external signal";
  }
}
```

#### 3.6.4 `assemblePartialMessage`:仅 text + thinking + 设计代价说明

```typescript
// packages/core/src/interrupt/assemble.ts

import type { Message, ContentBlock } from "../types/messages.js";

/**
 * 构造 partial assistant message —— 仅承载 text + thinking blocks(INV-5)。
 *
 * 与 llm-call.ts 的 assembleMessage 严格区别:
 * - assembleMessage:正常路径,包含 thinking + text + tool_use
 * - assemblePartialMessage:abort 路径,仅 text + thinking;**[interrupted] 标记必出**(INV-5):
 *   - text 非空 → 追加到 text 末尾
 *   - thinking-only → 独立 text block 承载标记
 *   - 都空 → return null(无内容可 yield)
 */
export function assemblePartialMessage(
  text: string,
  thinking: string,
): Message | null {
  if (!text && !thinking) return null;

  const blocks: ContentBlock[] = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) {
    blocks.push({ type: "text", text: `${text}\n\n[interrupted]` });
  } else {
    // thinking-only:用独立 text block 承载标记,保证用户读 transcript 时能识别"中断"
    blocks.push({ type: "text", text: "[interrupted]" });
  }
  return { role: "assistant", content: blocks };
}
```

**设计代价(必须明确)**:abort 路径下 LLM 即使**完整生成了** tool_use(tool_call_end 已到达、args JSON 完整),这些 tool_use 也**全部丢弃**——partial assistant 不携带任何 tool_use block。

- **直接代价**:用户中断后看 transcript,**看不到 LLM 在那一刻准备调用什么工具**。partial assistant 对 tool_use 是"完全失忆"。占位 placeholder 走 `unexecutedToolUses` 路径,LLM 在下一轮看到的是"某个 tool_use_id 被取消"——但因为 partial assistant 不含对应 tool_use block,这些 placeholder **不与任何 tool_use 配对**(它们 toolUseId 来自被丢弃的 tool_use)。
- **协议合规上的处理**:cleanup 注入的 placeholder 仅作为"自描述的取消通知"放入 tool_result message 中,不要求与上游 tool_use 配对——因为上游 tool_use 也没进 messages。LLM 看到 user role 的 tool_result with `[Tool execution cancelled: ...]` 内容,理解为"我之前请求过的某些工具被中断了"。
- **为什么这么设计**:流式 tool_use args 完整性判断不可靠(tool_call_end 事件可能未到达;argsJson 表面完整但语义残缺);把"完整 tool_use 保留 + 残缺 tool_use 丢弃"做成两条路径,意味着引入"判定 args 完整性"的脆弱启发式。统一丢弃换来协议规则简单 + 实现确定性。
- **何时考虑反转**:如果产品反馈"中断后看不到 LLM 想做什么是关键缺失"(典型如调试场景),需要后续独立 spec 设计"args 完整性判定 + 完整 tool_use 保留 + 强制 placeholder 配对"机制——这是范围爆炸的工程,本规格不做。

### 3.7 REPL 输入路由:复用 acquireStdinOwnership

#### 3.7.1 KeyboardSource 与 stdin 协调

```typescript
// packages/cli/src/interrupt/keyboard-source.ts

import { acquireStdinOwnership, type StdinOwnershipHandle } from "../tui/_internal/stdin-ownership.js";
import { abortWithReason } from "@zhixing/core";

export interface KeyboardSourceHandle {
  /**
   * 临时暂停 keypress 拦截 + 退出 raw mode,把 stdin 让给 readline.question 等需要 cooked mode 的调用方。
   * pause 期间 KeyboardSource 不响应 Esc / Ctrl+C(用户按这些键由 readline 默认处理或被忽略);
   * SignalSource 仍然工作——用户按 Ctrl+C 走 OS SIGINT 仍可触发 abort,作为 pause 期间的兜底中断通道。
   * 幂等。
   */
  pause(): void;
  /**
   * 恢复 raw mode + 重新挂回 keypress 拦截。幂等。pause/resume 必须配对使用。
   */
  resume(): void;
  /** 完全释放 keypress ownership 与 raw mode,恢复初始状态。幂等。 */
  detach(): void;
}

export function attachKeyboardSource(opts: {
  controller: AbortController;
  /**
   * 双击检测回调 —— REPL 自己决定双击是 exit 还是别的。
   * 返回 Promise<void> 表示需要异步执行(如 exit 清理:等 turn 退出 → scheduler.stop 等);
   * KeyboardSource 不 await 该返回值——双击触发是 fire-and-forget,REPL 自己管理 Promise 生命周期。
   */
  onDoublePress: (key: "ctrl-c") => void | Promise<void>;
  doublePressMs?: number;
}): KeyboardSourceHandle {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // 非 TTY 环境(CI、管道)KeyboardSource 不工作,由 SignalSource 兜底。
    // 仍返回完整 KeyboardSourceHandle —— pause/resume 也是 no-op,
    // 让调用方(securityPrompt 等)统一 pause/resume 协议在 non-TTY 也能跑通,
    // 不必额外判 isTTY。
    return { pause: () => {}, resume: () => {}, detach: () => {} };
  }

  const ownership: StdinOwnershipHandle = acquireStdinOwnership(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);

  let lastCtrlCAt = 0;
  const doublePressMs = opts.doublePressMs ?? 800;

  const onKeypress = (_str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
    if (key.name === "escape") {
      abortWithReason(opts.controller, {
        kind: "user-cancel",
        source: "esc",
        pressedAt: Date.now(),
      });
      return;
    }
    if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (now - lastCtrlCAt < doublePressMs) {
        // void Promise:回调可能是 async,KeyboardSource 不阻塞 keypress 队列
        void opts.onDoublePress("ctrl-c");
        return;
      }
      lastCtrlCAt = now;
      abortWithReason(opts.controller, {
        kind: "user-cancel",
        source: "ctrl-c",
        pressedAt: now,
      });
    }
  };

  stdin.on("keypress", onKeypress);

  let paused = false;
  let detached = false;

  return {
    pause: () => {
      if (paused || detached) return;
      paused = true;
      stdin.off("keypress", onKeypress);
      // **强制切到 cooked mode (false)**,而不是回到 wasRaw —— typeahead 路径下
      // wasRaw 可能本身就是 true(readline terminal 模式维持 raw),回到 wasRaw 仍是 raw,
      // readline.question 在 raw mode 下没有字符 echo / 行编辑,用户按字符看不到回显,
      // securityPrompt 体验完全坏掉。pause 的语义就是"让 cooked-mode 调用方能正常工作",
      // 必须强制 cooked。
      stdin.setRawMode(false);
    },
    resume: () => {
      if (!paused || detached) return;
      paused = false;
      stdin.setRawMode(true);                // 恢复 KeyboardSource 工作所需的 raw mode
      stdin.on("keypress", onKeypress);
    },
    detach: () => {
      if (detached) return;
      detached = true;
      if (!paused) stdin.off("keypress", onKeypress);
      // 仅 detach 时恢复 attach 前的初始状态(wasRaw)——pause/resume 是临时切换,
      // detach 是彻底归还,语义不同
      stdin.setRawMode(wasRaw);
      ownership.release();
    },
  };
}
```

**关键设计**:
- `acquireStdinOwnership` 已经处理"snapshot 现有 keypress listener + remove + restore"——KeyboardSource 不需要重做
- raw mode 状态自己保存/恢复(acquireStdinOwnership 不管这个)
- detach 必须严格按 `off → setRawMode → release` 顺序
- raw mode 下 Ctrl+C 字节(0x03)**不会**自动转 SIGINT(tty 驱动只在 cooked mode 转)——KeyboardSource 是 raw mode 下 Ctrl+C 的唯一处理路径
- onDoublePress 类型 `void | Promise<void>`——回调可能异步执行(REPL exit 清理:abort + 等 turn 退出 + scheduler.stop)

#### 3.7.2 SignalSource 兜底

```typescript
// packages/cli/src/interrupt/signal-source.ts

import { abortWithReason } from "@zhixing/core";

export function attachSignalSource(controller: AbortController) {
  const onSignal = () =>
    abortWithReason(controller, {
      kind: "user-cancel",
      source: "sigint",
      pressedAt: Date.now(),
    });

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    detach: () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}
```

**为什么需要 SignalSource**:raw mode 失效场景(如 stdin 被重定向、TTY 异常、CI 环境)KeyboardSource 拿不到 keypress;SIGINT 通过 OS 信号兜底。

#### 3.7.3 REPL 装载时机与 readline 协调

REPL 在 `state.running = true` 时 attach KeyboardSource + SignalSource,`state.running = false` 时 detach。这样:
- agent idle 期间 stdin 完全归 typeahead-input / readline 所有
- agent run 期间 KeyboardSource 持有 keypress ownership 并将 stdin 切到 raw mode,typeahead-input 已 pause
- confirmation 渲染期间通过同样的 `acquireStdinOwnership` 协调(已有机制),KeyboardSource 与之共用同一原语

**与 `readline.question` / 任何 cooked-mode 调用方协调**:agent run 期间(state.running=true)若有调用方需要走 `readline.question`(典型:`securityPrompt` 弹出工具确认对话框、其他子 UI 临时收文本输入),**必须在调用前 `keyboardSource.pause()`,在 finally 中 `keyboardSource.resume()`**。理由:
- KeyboardSource 持有 keypress ownership + 切换 stdin 到 raw mode,readline.question 在 raw mode 下行编辑 / Enter / echo 全异常(用户输入字符不显示、Enter 不触发 line 事件)
- pause 期间 SignalSource 仍工作——用户按 Ctrl+C 走 OS SIGINT 仍可触发 abort,作为 pause 期间的兜底中断通道(securityPrompt 内部对 abort 的响应是 securityBroker 的责任,不在本规范范围)

**REPL 改造典范**(`securityPrompt` 接入):

```typescript
// repl.ts state.running=true 期间的 securityPrompt 回调
securityPrompt: async (text) => {
  renderer.stop();
  keyboardSource.pause();
  try {
    return await rl.question(text);
  } finally {
    keyboardSource.resume();
  }
}
```

未来若 REPL 引入其他 cooked-mode 子 UI,统一遵循此 pause/resume 协议——KeyboardSource 与 readline 不能同时持有 stdin。

---

## 4. 模块边界与依赖

### 4.1 包结构

```
packages/core/src/
├── interrupt/                              ← 新增模块
│   ├── index.ts                            导出公开 API
│   ├── types.ts                            AbortReason / WatchdogPolicy / DEFAULT_WATCHDOG_POLICY / createWatchdogPolicy
│   ├── controller.ts                       4 个 helper(create/abort/get/fork)
│   ├── stream-race.ts                      wrapStreamWithAbortRace + raceIteratorWithAbort(基础层,INV-12)
│   ├── watchdog.ts                         wrapStreamWithWatchdog(facade:race + 可选 idle-timer)
│   ├── cleanup.ts                          buildCleanup + CleanupContext / CleanupOutcome + formatReasonForToolResult
│   ├── assemble.ts                         assemblePartialMessage(仅 text + thinking)
│   └── graceful-kill.ts                    gracefulKill 跨平台 helper
│
├── loop/                                   ← 修改(内部改造)
│   ├── agent-loop.ts                       内部 createInterruptController +
│   │                                        abort listener 同步记 abortFiredAt(不 emit) +
│   │                                        abort 退出路径 await emit interrupt:fired +
│   │                                        调 buildCleanup +
│   │                                        自己组装 yield 序列(assistant_message + tool_end + turn_complete with llmResult.usage)
│   ├── llm-call.ts                         接 watchdog + 先处理后 check + abort 路径返回 partial 数据
│   ├── tool-executor.ts                    per-iter check + 暴露 unexecutedToolUses(不合成)
│   └── types.ts                            LLMCallResult 改为判别联合(aborted: true | false)— breaking change
│
├── types/
│   ├── tools.ts                            新增 interruptBehavior 字段(可选)
│   └── agent-events.ts                     新增 interrupt:warn / interrupt:fired 事件
│
└── (zero new deps)

packages/cli/src/
├── repl.ts                                 ← 修改:state.running 时 attach sources
├── run-agent.ts                            ← 不改(abortSignal 已透传)+ 默认 watchdog 透传
└── interrupt/                              ← 新增
    ├── keyboard-source.ts                  attachKeyboardSource(复用 acquireStdinOwnership)
    ├── signal-source.ts                    attachSignalSource
    └── repl-runtime.ts                     装载/卸载 sources、双击退出协调
```

### 4.2 公开 API

`packages/core/src/interrupt/index.ts`:

```typescript
export {
  createInterruptController,
  abortWithReason,
  getAbortReason,
  forkController,
} from "./controller.js";

export type {
  AbortReason,
  UserCancelReason,
  IdleTimeoutReason,
  ParentAbortReason,
  ExternalSignalReason,
  WatchdogPolicy,
} from "./types.js";

export { DEFAULT_WATCHDOG_POLICY, createWatchdogPolicy } from "./types.js";
export { wrapStreamWithAbortRace } from "./stream-race.js";
export { wrapStreamWithWatchdog } from "./watchdog.js";
export { buildCleanup } from "./cleanup.js";
export type { CleanupContext, CleanupOutcome } from "./cleanup.js";
export { assemblePartialMessage } from "./assemble.js";
export { gracefulKill } from "./graceful-kill.js";
export type { GracefulKillOptions } from "./graceful-kill.js";
```

`packages/core/src/index.ts` 增加 re-export:

```typescript
export {
  createInterruptController,
  abortWithReason,
  getAbortReason,
  forkController,
  wrapStreamWithAbortRace,
  wrapStreamWithWatchdog,
  buildCleanup,
  assemblePartialMessage,
  gracefulKill,
  DEFAULT_WATCHDOG_POLICY,
  createWatchdogPolicy,
} from "./interrupt/index.js";

export type {
  AbortReason,
  WatchdogPolicy,
  CleanupContext,
  CleanupOutcome,
  GracefulKillOptions,
} from "./interrupt/index.js";
```

**Breaking change 说明**:`LLMCallResult` 类型由单 shape 改为判别联合(`aborted: false` / `aborted: true`),原本直接 `result.message` / `result.stopReason` 的访问需迁移到分支判定 `if (!result.aborted) { result.message }`。本类型在 `loop/index.ts` 已导出但属于 core 内部抽象,外部消费者预期为零或极少。

### 4.3 abortSignal 透传链(端到端)

```
[键盘/SIGINT]
   ↓ KeyboardSource / SignalSource → abortWithReason(replController, ...)
[REPL]                                                                              packages/cli/src/repl.ts
   replController.signal
   ↓ 透传作为 abortSignal 实参                                                       ← 修改点
[agentRuntime.run({ messages, turnIndex, abortSignal: replController.signal })]    packages/cli/src/run-agent.ts:177
   params.abortSignal
   ↓ 透传给 runAgentLoop                                                            ← 已有(line 591)
[runAgentLoop({ abortSignal: params.abortSignal, watchdog: WATCHDOG_POLICY })]      packages/core/src/loop/agent-loop.ts
   ↓ 内部
   const controller = createInterruptController({ externalSignals: [params.abortSignal] });  ← 修改点
   let abortFiredAt: number | null = null;                                                    ← 修改点
   const recordAbortTime = () => { abortFiredAt = performance.now(); };
   if (controller.signal.aborted) {
     recordAbortTime();   // 防御:已 aborted signal 上 addEventListener 不触发(EventTarget 标准)
   } else {                                                                                   // ← 修改点
     controller.signal.addEventListener("abort", recordAbortTime, { once: true });
   }
   ↓ 全链路用 controller.signal
[streamLLMCall({ controller, watchdog })]                                           packages/core/src/loop/llm-call.ts
   ↓ const watched = wrapStreamWithWatchdog(stream, controller, watchdog, eventBus); ← 修改点
   ↓ ChatRequest.abortSignal = controller.signal(Provider 层透明)
   ↓ for await (const event of watched) { ...处理event...; if (controller.signal.aborted) break; }
   ↓ abort → return { aborted: true, partial: { text, thinking }, usage }
[executeToolCalls({ abortSignal: controller.signal })]                              packages/core/src/loop/tool-executor.ts
   ↓ for (const call of toolCalls) { if (signal.aborted) { abortedAtIndex = i; break; } ... }  ← 修改点
   ↓ ctx.abortSignal = signal(与现有完全一致)
[tool.call(input, { abortSignal })]                                                 工具实现

— abort 退出路径(agent-loop 内,所有 abort 分支共用此模板) —
const reason = getAbortReason(controller.signal);
const usage = mergeUsage(state.totalUsage, llmResult?.usage ?? emptyUsage());        ← INV-14
const outcome = buildCleanup({ partial, unexecutedToolUses, reason });
if (outcome.kind === "data") {
  if (outcome.partialAssistant) yield { type: "assistant_message", message: outcome.partialAssistant };
  if (outcome.placeholderToolResults.length > 0) {
    const toolNameById = new Map((unexecutedToolUses ?? []).map(t => [t.id, t.name]));
    for (const r of outcome.placeholderToolResults) {
      yield {
        type: "tool_end",
        id: r.toolUseId,
        name: toolNameById.get(r.toolUseId) ?? "unknown",
        result: { content: r.content, isError: true },
        duration: 0,
      };
    }
    yield {
      type: "turn_complete",
      turnCount: state.turnCount + 1,
      usage: llmResult?.usage ?? emptyUsage(),                                        ← INV-14
    };
  }
}
// toolGraceMs:abort 发生在工具 await 期间 → 工具退出时刻 - abort 触发时刻;否则 0
const toolGraceMs = (toolExecutorResult?.abortedDuringToolAt != null && abortFiredAt != null)
  ? Math.max(0, toolExecutorResult.abortedDuringToolAt - abortFiredAt)
  : 0;
return await emitRunEnd(
  eventBus, startTime,
  {
    reason: "aborted",
    abortReason: reason ?? undefined,
    exitDelayMs: abortFiredAt !== null ? Math.round(performance.now() - abortFiredAt) : undefined,
    usage,                                                                            ← INV-14
  },
  abortFiredAt,                                                                       ← required:supply abortFiredAt(non-abort 路径传 null)
  state.turnCount,                                                                    ← required:一律 state.turnCount,不取 newTurnCount
  toolGraceMs,                                                                        ← required:non-abort 路径传 0
);

— contextManager abort 路径(toTerminalAgentResult 改造) —
// resolveContextManager 在 pre-text-return / tool-loop 两处调用后,kind="aborted" 走此路径。
// partial=undefined、unexecutedToolUses=[] → buildCleanup 返回 kind="no-cleanup",无需 yield。
// abortReason / exitDelayMs 由调用方就近算好后传入,toTerminalAgentResult 保持纯映射语义。
function toTerminalAgentResult(
  termination: ContextTermination,
  usage: TokenUsage,
  abortReason?: AbortReason,                                                         // ← 新增参数
  abortFiredAt?: number | null,                                                      // ← 新增参数
): AgentResult | undefined {
  switch (termination.kind) {
    case "ok":      return undefined;
    case "error":   return { reason: "error", error: termination.error, usage };
    case "aborted": return {
      reason: "aborted",
      abortReason,                                                                   // ← INV-3 + INV-13
      exitDelayMs: abortFiredAt != null
        ? Math.round(performance.now() - abortFiredAt) : undefined,                  // ← INV-13
      usage,
    };
  }
}
// 调用方(agent-loop.ts L142、L193 两处)在调用前就近算好:
//   const abortReason = getAbortReason(controller.signal) ?? undefined;
//   const terminal = toTerminalAgentResult(termination, usage, abortReason, abortFiredAt);
// 不接 controller 让 toTerminalAgentResult 保持纯映射语义(§3.2.3 命名约定:controller 只在
// 创建/触发 abort 的地方持有);不传 abortReason 时 contextManager abort 进入 emitRunEnd 时
// result.abortReason 为 undefined,emit fired 带 reason: null,REPL 走 §8.3 "interrupted"
// 兜底文案——破坏差异化 UX 与 INV-3 在该路径上的精神。

— emitRunEnd 内部(单一退出点,emit fired 收敛于此) —
async function emitRunEnd(
  eventBus,
  startTime,
  result: AgentResult,
  abortFiredAt: number | null,         // ← required 无默认值,non-abort 路径传 null
  interruptedTurnIndex: number,        // ← required 无默认值,所有调用点一律传 state.turnCount
  toolGraceMs: number,                 // ← required 无默认值,non-abort 路径传 0
): Promise<AgentResult> {
  // INV-9: emit fired 严格在 run_end 之前;单一调用点保证幂等;新增 abort 分支零负担
  if (result.reason === "aborted") {
    await eventBus?.emit("interrupt:fired", {
      reason: result.abortReason ?? null,
      interruptedTurnIndex,
      exitDelayMs: result.exitDelayMs,   // 直接从 result 透传,EventBus 订阅方零依赖 RunResult 即可监控中断响应延迟(INV-1 SLO 配对)
      toolGraceMs,                       // 工具自身 abort 等待消耗(参见 INV-1 与 §3.5.2);订阅方做 P95 SLO 时计算 exitDelayMs - toolGraceMs
    });
  }
  await eventBus?.emit("agent:run_end", { reason: result.reason, duration: ..., usage: result.usage, ... });
  return result;
}

// 调用契约:**所有调用点一律传齐 5 个参数**——non-abort 路径(max_turns / completed / error)
// 也传 (null, state.turnCount, 0),即使 emit fired 不会触发,值不会被消费。
// 默认值会让"忘传"成为悄悄的 bug:第 5 轮 abort 误报为第 0 轮(turn-index)/ toolGraceMs 误算 0。
// 用 required 参数把契约一致性强制到编译期。
```

**修改点统计**:
- `repl.ts`:装载 sources + 传 abortSignal 实参
- `run-agent.ts`:abortSignal 已透传(无需改);默认 watchdog 透传;**buildPreFlightError 接入 abortReason**(`getAbortReason(params.abortSignal) ?? { kind: "external" }`),不 emit EventBus 事件——pre-flight 阶段 agent-loop 未启动,emit fired/run_end 都会破坏事件流语义
- `agent-loop.ts`:内部 createInterruptController + abort listener 防御已 aborted + 同步记时间(不 emit) + cleanup 调用 + yield 序列组装 + usage 累积 + **emitRunEnd 增加 abortFiredAt / interruptedTurnIndex 参数,内部统一 emit fired** + **toTerminalAgentResult 扩签名接 abortReason / abortFiredAt 扁平参数(纯映射函数,不接 controller),abort 路径补全 abortReason / exitDelayMs**
- `llm-call.ts`:**streamLLMCall 接参由 abortSignal 改为 controller**(watchdog 必须能触发 abort,§3.2.3 例外) + watchdog 包装 + 先处理后 check + abort 路径返回 partial
- `tool-executor.ts`:per-iter check + return shape 改为 `{ completedResults, unexecutedToolUses, abortedDuringToolAt? }`(breaking change,影响 agent-loop 调用点);**"工具未找到"分支保持现有 isError 路径,不进入 unexecutedToolUses**;**abortedDuringToolAt 在工具 await 期间 abort 时记录退出时刻,用于 toolGraceMs 计算**
- `agent-loop.ts` tool 循环调用点:`toolResultMessage(toolResults)` 改为 `toolResultMessage(toolExecutorResult.completedResults)`(承接 tool-executor return shape 变化);并基于 `toolExecutorResult.unexecutedToolUses.length > 0` 判定是否进入 abort 退出路径;**abort 退出路径计算 toolGraceMs 透传给 emitRunEnd**
- `loop/types.ts`:LLMCallResult 改为判别联合;`StreamLLMCallParams` / `AgentLoopDeps.callLLM` 不变(callLLM 仍接 ChatRequest,Provider 抽象稳定)
- `types/tools.ts`:interruptBehavior 字段
- `types/agent-events.ts`:新增 `interrupt:warn` / `interrupt:fired` 2 个事件
- 新增 `interrupt/` 模块(types / controller / stream-race / watchdog / cleanup / assemble / graceful-kill)

---

## 5. 关键决策与权衡

### 5.1 不引入 InterruptController class,用 4 helper

**取舍**:失去把 fork 能力捆绑到自定义类型上的简洁性;获得与 zhixing 现有 "全程 AbortSignal" 心智模型的一致性。

**理由**:
- zhixing 现有 ChatRequest / ToolExecutionContext / ContextManagerInput 等几十处 API 全程用 `AbortSignal`
- class 引入双轨制——旧调用方传 abortSignal、新调用方传 controller
- helper 函数模式让任何接 `AbortSignal` 的库(fetch、Anthropic SDK、setTimeout)零改动接入
- fork 关系通过 `forkController(parent)` 显式表达,符合"操作不属于数据"的设计哲学

**当前限制(已知留白,非债务)**:`createInterruptController` 在 `externalSignals` 上挂的 listener 用 `{ once: true }`,**只在 ext.abort() 触发时自动 remove**;若 ext signal 永不 abort 且生命周期长(典型:server session-level controller 跨多次 run、scheduler 长任务共享一个 abortSignal),N 次 createInterruptController 在同一 ext signal 上累积 N 个 listener,closure 引用 controller 让其无法 GC。
- **当前作用范围**:REPL 路径**不触发** —— `replController` per turn 创建,turn 结束 controller 被 GC,signal 跟着 GC,无累积。server 路径**未实现**(§0.4 明确不做跨进程 RPC)
- **不引入 `dispose()` 协议**:返回 `{ controller, dispose }` 双值结构会破坏"返回原生 AbortController"的核心心智(本节 ADR 的根本理由),与几十处现有 API 全程用 AbortSignal 的设计哲学冲突;为一个未来场景重构核心抽象不值得
- **未来工作锚点**:server 路径正式引入 session-level controller 时,与 session 生命周期管理一并独立设计 dispose / WeakRef / signal-pool 等方案,不在本规范范围。本规范不为未来场景留半实现的接口

### 5.2 AbortReason 用判别联合而非字符串

**取舍**:失去 Claude Code 字符串 reason 的"轻量级 enum"简洁性;获得编译期穷尽检查 + 类型化 metadata。

**理由**:
- discriminated union 让 `switch (reason.kind)` 在 `--strict` 下穷尽检查
- 元数据强类型(idle-timeout 的 chunksReceived、user-cancel 的 source)随 reason 走
- 新增 kind 时所有未覆盖分支编译报错

### 5.3 max-turns 不进 abort 体系

**取舍**:失去"用统一中断协议表达所有非 completed 终止"的整齐感;获得"达到上限"和"被中断"的语义清晰。

**理由**:
- max-turns 是 agent 主动判定(`turnCount >= maxTurns`),不是被外部触发
- 现有 `AgentResult.reason="max_turns"` 已是平行体系,强行纳入 abort 会破坏现有调用方的语义
- AgentResult 上 `abortReason` / `exitDelayMs` 字段限定在 `reason: "aborted"` 分支(INV-13)

### 5.4 LLM StopReason 不加 "aborted"

**取舍**:失去"LLM 层就能看出 abort"的扁平性;获得边界严格分层。

**理由**:
- abort 是 agent loop 的终止判定,LLM 只负责"我组装了什么"
- `AgentRunEndReason` 已经有 "aborted"(agent-events.ts:31),与 LLM `StopReason` 严格分离
- 给 LLM `StopReason` 加 "aborted" 会污染 Provider 抽象——不是所有 Provider 都有 "aborted" 概念

### 5.5 idle-timeout 计时维度选 chunk-arrival 而非 wall-clock

**取舍**:失去 wall-clock total timeout 的"硬上限"语义;获得 chunk-arrival 的"真实失败模式"覆盖。

**理由**:
- LLM stream 失败的典型形态是 first-byte 之后静默挂死,wall-clock total 会让快速 stream 也被误杀
- chunk-arrival 是 OpenClaw / Hermes / Claude Code 三方一致的选择

### 5.6 race 与 idle-timer 解耦,race 是基础能力

**取舍**:多一个独立模块文件(`stream-race.ts`);获得 INV-12 不依赖 watchdog policy。

**理由**:
- 用户配置 `idleTimeoutMs=0` 禁用 idle-timer 时,中断响应延迟保证不应丢失
- mock 测试场景下底层 stream 完全不响应 abortSignal——race 是唯一能让 watchdog disabled 路径也通过测试的机制
- OpenClaw `attempt.ts:1281-1303` 的 `abortable()` race 是范本(虽然 OpenClaw 没把它和 idle-timeout 解耦)
- 两层职责清晰:race = "abort 响应能力";idle-timer = "无活动检测能力"

### 5.7 协议清理:cleanup 出数据,agent-loop 组 yield 序列

**取舍**:cleanup 与 agent-loop 之间多一道"数据→yield"映射;获得职责清晰分层 + trackMessages 零修改。

**理由**:
- yield 序列需要 turnCount / usage / 反查 tool name 等 agent-loop 持有的状态——cleanup 不应跨层依赖
- agent-loop 是 yield 序列的唯一组装者,trackMessages 通过现有的"tool_end + turn_complete → user message"协议自然包出合规 messages
- 单一事实源——所有 placeholder 合成只在 cleanup 模块出现一次

### 5.8 LLMCallResult 改为判别联合(aborted: true | false)

**取舍**:Breaking change(外部消费者需迁移到分支判定);获得"abort 路径不携带 message/stopReason"的类型保证。

**理由**:
- abort 路径不调 assembleMessage(避免 partial 包含 tool_use),只返回 partial 数据——message / stopReason 字段在该分支无意义
- 判别联合让"什么字段在什么分支可用"由编译器强制
- 防止 abort 路径下游误用 `result.message`(可能是空内容 message)
- LLMCallResult 是 core 内部抽象,外部消费者预期为零或极少;迁移代价小

### 5.9 partial assistant 不携带任何 tool_use(包括完整生成的)

**取舍**:用户中断后看 transcript,看不到 LLM 在中断时刻准备调用什么工具;获得协议规则简单 + 实现确定性。

**理由**(详见 §3.6.4 的设计代价说明):
- 流式 tool_use args 完整性判断不可靠(tool_call_end 事件可能未到达;argsJson 表面完整但语义残缺)
- 区分"完整 tool_use 保留 + 残缺 tool_use 丢弃"需要引入"判定 args 完整性"的脆弱启发式
- 统一丢弃换来:partial assistant 永远不会有"orphan tool_use"协议违规风险
- 何时反转:产品反馈"中断后看不到 LLM 想做什么是关键缺失"时,需独立 spec 设计完整性判定 + 强制配对机制

### 5.10 工具中断策略分三类

**取舍**:失去单一 cancel 的简单性;获得对长跑命令的优雅停止 + 对后台任务的预留。

**理由**:
- Bash 工具直接 SIGKILL 会丢 partial output、丢 trap "EXIT" handler 副作用——Hermes 1s grace 是验证过的成熟选择
- background 是 Step 22 BackgroundAgent 的接口预留
- Claude Code 的 cancel/block 二元少了 grace 中间态

**强制约束**:grace 类工具必须 import `gracefulKill` helper,不允许自写 SIGTERM/SIGKILL 升级链。

### 5.11 复用 acquireStdinOwnership,不新造 stdin 协调

**取舍**:约束 KeyboardSource 必须按 `acquireStdinOwnership` 的 keypress 模式工作;获得与 typeahead-input / confirmation-renderer 共享同一协调原语。

**理由**:
- 已有 `acquireStdinOwnership` 解决了 "readline 内部 keypress listener 的 snapshot/restore" 这个核心难题
- 新造另一套 stdin 协调机制会与现有冲突,引入新债务
- raw mode 状态切换不属于 ownership 协调范畴,KeyboardSource 自管 wasRaw → setRawMode(true) → setRawMode(wasRaw)

### 5.12 REPL 输入路由:Esc 单击 cancel + Ctrl+C 800ms 双击 exit

**取舍**:与 OpenClaw TUI IDE 风格不一致;获得与 shell / Python REPL / Claude Code 一致的 CLI 习惯。

**详细行为表**:

| 按键 | agent 跑时 | agent idle 时 |
|------|----------|--------------|
| Esc 单击 | abort 当前 turn | 无操作(typeahead 面板自己处理) |
| Ctrl+C 单击 | abort 当前 turn | readline 默认(清空当前输入) |
| Ctrl+C 800ms 内双击 | abort + exit | readline 触发 SIGINT → exit |
| Ctrl+D | abort + exit(EOF) | exit |

### 5.13 abortWithReason 是纯函数 + emit fired 由 emitRunEnd 唯一调用

**取舍**:emit fired 不能在 abort listener 内触发(addEventListener 同步签名无法 await);获得 INV-9 顺序严格保证 + 纯函数零依赖 + 单一调用点防漏。

**理由**:
- `abortWithReason` 是 core 纯函数,不应耦合 EventBus
- abort listener 内 `void emit(...)` 是 fire-and-forget,emit 完成时机不确定——可能在 agent-loop 已经 emit run_end 之后才到达,违反 INV-9
- agent-loop 的 abort 退出路径**不止一个分支**(turn 边界 / LLM 后 / tool 后 / contextManager abort),让每个分支手写 await emit fired 容易在新增分支时漏写
- **emit fired 收敛到 `emitRunEnd` 内部**:emitRunEnd 已经是 agent-loop 单一退出点;在它内部判 `result.reason === "aborted"` 决定是否 emit fired,在 emit run_end 之前——单一调用点天然幂等、新增 abort 分支零负担、INV-9 顺序严格保证
- listener 内只做同步操作(记 abortFiredAt 用于计算 exitDelayMs),不耦合任何异步 IO
- listener 注册前必须先检查 `controller.signal.aborted`——已 aborted signal 上 addEventListener 不触发(EventTarget 标准),已 aborted 场景需同步调 recordAbortTime,否则 abortFiredAt 永远 null
- pre-flight abort 路径不经过 emitRunEnd——pre-flight 阶段 agent-loop 未启动,buildPreFlightError 仅在 RunResult.agentResult 上同步填 abortReason,不 emit 任何 EventBus 事件;订阅方观察的语义就是"本次 run 未真启动"(无 run_start / fired / run_end),与"启动后被中断"严格区分

### 5.14 不做"用户加新消息中断"语义

**取舍**:失去 Claude Code/Hermes 的 IM 风格"边跑边收新消息";获得设计聚焦。

**理由**:
- zhixing 当前 REPL 在 agent 跑时不接受输入
- IM 通道(飞书)的"新消息触发 interrupt"是通道适配器责任——AbortReason 预留扩展槽位
- 实现这个语义需要"新消息排队 + 中断后再注入"完整子系统,范围爆炸

### 5.15 看门狗默认开 + 双阈值 + EventBus 暴露 + 工厂构造器验证阈值

**取舍**:增加默认行为复杂度 + WatchdogPolicy 构造需走 createWatchdogPolicy;获得开箱即用的失败检测 + 配置错误编译/运行期暴露。

**理由**:
- Claude Code 默认关是历史 rollout 顾虑,新项目不应继承
- OpenClaw 60s / Hermes 120s 默认开都印证 idle-timeout 是必备能力
- EventBus 暴露 `interrupt:warn` 让 UI 可以在 30s 警告时给用户实时倒计时
- `warnThresholdRatio` 在 (0, 1) 开区间外会导致"立即/永不触发 warn"的退化行为;`createWatchdogPolicy` 工厂在构造时 throw,把配置错误前置到启动期而不是运行期发生在用户面前

**配置**:`runAgentLoop({ watchdog: createWatchdogPolicy({ idleTimeoutMs: 0 }) })` 仅禁用 idle-timer,race 仍生效。REPL 装载时使用 `DEFAULT_WATCHDOG_POLICY`。

### 5.17 abort 优先于 max_turns(终止判定优先级)

**取舍**:agent-loop 入口的 guard 顺序与现有代码相反(现状 max_turns 先);获得"用户主动中断意图永不被被动判定覆盖"的语义保证。

**理由**:
- `termination.ts` 已经把"abort 优先于 context_overflow"做成不变量(`resolveContextManager` 在 `output.failed` 分支也先查 abortSignal),本规范应延续相同的优先级哲学
- 用户在最后一轮按 Esc 时,如果 max_turns guard 先触发,run_end.reason="max_turns"——REPL 显示"max turns reached",但用户的真实意图是"我按 Esc 想停"
- abort 是用户/外部主动信号,max_turns 是被动达到上限——主动信号优先于被动判定符合"尊重用户意图"原则
- 顺序对称:agent-loop 入口 guard 顺序与 termination.ts 内部归一化顺序(abort > error > overflow)一致,降低维护者认知成本

### 5.16 usage 在 abort 路径必须如实计入(INV-14)

**取舍**:abort 路径下 usage 累积逻辑要与正常路径完全一致;获得用户计费认知准确。

**理由**:
- LLM 计费按服务端实际处理的 tokens 计算,客户端中断不会免除费用
- abort 之前 LLM 已经处理 prompt + 部分 output,这些 tokens 必须计入 totalUsage 和 turn_complete.usage
- 用 `emptyUsage()` 占位会让 UI 显示"本轮 0 token",误导用户对实际花费的判断
- llmResult 不存在时(如 turn 边界 abort,LLM 调用都没发起)usage 才是 emptyUsage——这是真实的"零消耗",非误报

---

## 6. 渐进式实现里程碑

每个 milestone 独立可验证、独立可回滚。**按"用户可见性优先"排序**——P2(REPL 中断不了)在 M3 完成后即修复;P1(223s hang)在 M5 完成后修复。

### M1 — 协议层(types + 4 helper + race + assemble + cleanup)

**目标**:建立纯类型 + helper 函数 + race 基础能力 + 协议清理算法,不动现有 agent-loop 代码。

**范围**:
- 新建 `packages/core/src/interrupt/types.ts`:AbortReason 判别联合(4 种 kind,**不含 MaxTurnsReason**)+ WatchdogPolicy + DEFAULT_WATCHDOG_POLICY + createWatchdogPolicy(验证 warnThresholdRatio 开区间)
- 新建 `packages/core/src/interrupt/controller.ts`:4 helper(createInterruptController / abortWithReason / getAbortReason / forkController)
- 新建 `packages/core/src/interrupt/stream-race.ts`:wrapStreamWithAbortRace + raceIteratorWithAbort(基础层,INV-12)
- 新建 `packages/core/src/interrupt/assemble.ts`:assemblePartialMessage(仅 text + thinking)
- 新建 `packages/core/src/interrupt/cleanup.ts`:buildCleanup + CleanupContext / CleanupOutcome + formatReasonForToolResult
- 新建 `packages/core/src/interrupt/index.ts`:导出 + core/index.ts 加 re-export
- 单测:
  - controller:createInterruptController 返回原生 AbortController;setMaxListeners(50) 生效;多 externalSignals 任一 aborted → controller aborted;abortWithReason 幂等;getAbortReason 类型安全(本模块 reason → 类型化、外部 → null);forkController 父→子传播 + 子→父隔离 + 嵌套传播
  - createWatchdogPolicy:warnThresholdRatio = 0 / 1 / 1.5 / -0.1 都 throw TypeError;0.5 / 0.1 / 0.9 通过
  - stream-race:mock stream 永远 hang(不响应 abortSignal),race 触发 abort 后 ≤10ms 返回 done;listener 在 settle 后 removeEventListener(模拟检查 listenerCount)
  - assemble:text + thinking 都空 → null;只有 text → text block 末尾 `[interrupted]`;只有 thinking → thinking block 无标记
  - cleanup:CleanupContext 全空 → kind="no-cleanup";只有 partial → partialAssistant 非 null + placeholderToolResults 空数组;只有 unexecutedToolUses → partialAssistant null + placeholders 数量与顺序匹配;formatReasonForToolResult 4 种 reason kind 文本格式

**验收**:
- `pnpm tsc --noEmit` 通过
- 新增单测全过
- 现有测试零修改且全过

**不做**:不修改任何现有 loop / cli 代码。本里程碑产物纯增量。

### M2 — agent-loop 内部接入 controller + abort listener 记时间

**目标**:agent-loop 内部用 createInterruptController 包装外部 abortSignal;abort listener 同步记 abortFiredAt;AgentResult.aborted 携带 abortReason / exitDelayMs;对外 API 保持完全不变。

**范围**:
- 修改 `agent-loop.ts`:
  - 入口 `const controller = createInterruptController({ externalSignals: params.abortSignal ? [params.abortSignal] : [] })`
  - 注册 abort listener:**先检查 `controller.signal.aborted`**——已 aborted 则同步调 recordAbortTime(防御:已 aborted signal 上 addEventListener 不触发);否则 addEventListener。这样保证 externalSignal 已 aborted 时(scheduled task 超时、子 agent fork 时父已 aborted)abortFiredAt 仍能正确记录
  - listener 体内**只**做同步操作(记 `abortFiredAt`),**不**调用 emit(INV-9)
  - 现有所有 `params.abortSignal?.aborted` 检查改为 `controller.signal.aborted`
  - 现有透传:`executeToolCalls` / `resolveContextManager` 接收 `controller.signal`(它们是观察者);`streamLLMCall` 接收 `controller` 本体(M4 改造,§3.2.3 例外,watchdog 必须能触发 abort)
  - **入口 guard 顺序调整为先 abort 再 max_turns**(INV-13 终止优先级 + ADR §5.17:abort > max_turns,与 termination.ts "abort 优先于 context_overflow" 哲学对称)
  - turn 边界 abort 时 reason 来自 `getAbortReason(controller.signal)`
  - max-turns 路径**不携带** abortReason / exitDelayMs(平行体系,INV-13)
- 修改 `emitRunEnd`(agent-loop.ts:259-272):
  - 新增 3 个 **required** 参数(无默认值):`abortFiredAt: number | null` + `interruptedTurnIndex: number` + `toolGraceMs: number`
  - **emit fired 收敛于此**:`if (result.reason === "aborted") await emit("interrupt:fired", { reason: result.abortReason ?? null, interruptedTurnIndex, exitDelayMs: result.exitDelayMs, toolGraceMs })`,在 emit run_end 之前(INV-9);exitDelayMs 直接从 result 透传,toolGraceMs 由调用方按 §3.5.2 abortedDuringToolAt 计算
  - **所有 emitRunEnd 调用点(含 max_turns / completed / error 等 non-abort 路径)一律传齐 5 个参数**——non-abort 路径传 `(null, state.turnCount, 0)`,虽然 emit fired 不触发、值不会被消费,但用 required 参数把"调用点契约一致性"强制到编译期,杜绝默认值带来的"忘传"悄悄 bug(第 5 轮 abort 误报为第 0 轮 / toolGraceMs 误算 0)
  - `interruptedTurnIndex` 一律取 `state.turnCount`(turn 边界 / LLM 后 / tool 后 / contextManager 后均一致;`state.turnCount` 是"当前正在跑的 turn 0-indexed 序号",**不取 newTurnCount**)
- 修改 `loop/types.ts`:
  - `AgentResult.aborted` 增加 `abortReason?: AbortReason` + `exitDelayMs?: number`(仅 reason="aborted" 上加,INV-13)
  - 其他 reason 分支不变
- 修改 `agent-events.ts`:新增 `interrupt:warn` / `interrupt:fired` 事件类型(`InterruptFiredEvent.interruptedTurnIndex` 字段语义为"被中断的 turn 序号,0-indexed,等于 abort 触发瞬间的 state.turnCount",与 `turn_complete.turnCount` 即"已完成 turn 数,1-indexed"严格区分)
- **修改 `toTerminalAgentResult`(agent-loop.ts:289-301)**:
  - 签名扩为 `toTerminalAgentResult(termination, usage, abortReason?, abortFiredAt?)`——接扁平参数,**不接 controller**(§3.2.3 命名约定:controller 只在创建/触发 abort 的地方持有,纯映射函数无需 controller 引用)
  - kind="aborted" 分支补全 abortReason / exitDelayMs(INV-13),与主循环 abort 退出路径行为一致:
    ```typescript
    case "aborted":
      return {
        reason: "aborted",
        abortReason,
        exitDelayMs: abortFiredAt != null ? Math.round(performance.now() - abortFiredAt) : undefined,
        usage,
      };
    ```
  - 调用方(agent-loop.ts L142、L193 两处)在调用前就近算好:
    ```typescript
    const abortReason = getAbortReason(controller.signal) ?? undefined;
    const terminal = toTerminalAgentResult(termination, usage, abortReason, abortFiredAt);
    ```
  - 没有这一步,contextManager 触发的 abort 进入 emitRunEnd 时 result.abortReason 永远 undefined,emit fired 带 reason: null,REPL 渲染走 §8.3 "interrupted" 兜底文案——破坏差异化 UX 与 INV-3 在该路径上的精神
- **修改 `cli/run-agent.ts buildPreFlightError`(line 511-563)**:
  - pre-flight resolveContextManager 返回 kind="aborted" 时:
    - 构造 AgentResult.aborted 带 `abortReason: getAbortReason(params.abortSignal) ?? { kind: "external" }`(INV-13)——保证 RunResult.agentResult 携带类型化 reason,REPL renderSummary 能按 §8.3 显示差异化文本
    - exitDelayMs 保持 undefined(pre-flight 阶段无 abort listener,无法测量)
    - **不 emit 任何 EventBus 事件**——pre-flight 阶段 agent-loop 未启动(无 `agent:run_start` 也无 `agent:run_end`),emit `interrupt:fired` 会成为孤儿事件破坏 INV-9 单向蕴含;且 run-agent.ts 的 eventBus 是 run() 内部局部 bus,emit 也无外部观察者
  - 这一改造让 pre-flight abort 路径与 agent-loop 路径在 `RunResult.agentResult` 层面行为一致(INV-3 / INV-13);事件流层面 pre-flight 失败语义就是"本次 run 未真启动",订阅方按观察到的事件流推断状态即可
- 测试:
  - 现有 agent-loop 测试零修改全过
  - 新增:外部 abortSignal aborted → AgentResult.reason="aborted",abortReason.kind="external"
  - **新增**:外部 abortSignal **已经 aborted** 时构造 controller → abortFiredAt 仍正确记录(防御已 aborted 场景)
  - 新增:abort listener 内只更新 abortFiredAt,**不**调用 emit
  - 新增:emit fired 在 emitRunEnd 内部调用一次(用 spy 记录 emit 顺序),fired emit 完成在 run_end emit 开始之前;**fired payload 含 exitDelayMs(数值 ≥ 0,与 AgentResult.exitDelayMs 一致)**
  - 新增:任何 abort 退出分支(turn 边界 / contextManager abort)调 emitRunEnd 都自动 emit fired——不在分支里手写
  - 新增:max-turns 触发 → AgentResult.reason="max_turns",**不带** abortReason / exitDelayMs;emitRunEnd **不** emit fired(INV-13)
  - **新增**:abort 与 max_turns 同时满足(state.turnCount === maxTurns 且 controller.signal.aborted)→ AgentResult.reason="aborted"(abort 优先,INV-13 + ADR §5.17)
  - 新增:exitDelayMs = round(performance.now() - abortFiredAt) 在 abort 路径上有合理值
  - **新增**:contextManager abort 路径(mock contextManager.onTurnComplete 内部触发 controller abort)→ toTerminalAgentResult 返回的 AgentResult.aborted 携带 abortReason.kind ≠ undefined;emit fired 带类型化 reason;§8.3 分支文本不走 "interrupted" 兜底
  - **新增**:run-agent.ts buildPreFlightError abort 路径 → RunResult.agentResult.aborted 带 abortReason(`{ kind: "external" }` 或类型化);**spy 验证 eventBus 在 pre-flight 路径全程零 interrupt:fired / agent:run_end emit**(订阅方观察到的事件流是"本次 run 未真启动")

**验收**:所有现有 agent-loop 测试零修改且全过;新增测试通过;`pnpm tsc --noEmit` 通过。

**不做**:不动 llm-call.ts / tool-executor.ts 的内部循环;不引入看门狗;不动 REPL。

### M3 — REPL 接通:让 P2 立即修复

**目标**:用户在 REPL 按 Esc / Ctrl+C 能 abort 当前 turn。**用户可见的第一步修复**。

**范围**:
- 新建 `packages/cli/src/interrupt/keyboard-source.ts`:attachKeyboardSource(按 §3.7.1 实现,onDoublePress 类型 `void | Promise<void>`)
- 新建 `packages/cli/src/interrupt/signal-source.ts`:attachSignalSource(按 §3.7.2 实现)
- 新建 `packages/cli/src/interrupt/repl-runtime.ts`:装载/卸载 sources、双击退出协调(双击 callback 内部异步执行 abort + 等 turn 退出 + 走 /exit 清理路径)
- 修改 `packages/cli/src/repl.ts`:
  - state.running = true 之前:`const replController = createInterruptController()` + `keyboardSource = attachKeyboardSource({ controller: replController, onDoublePress: handleExit })` + `signalSource = attachSignalSource(replController)`
  - 调用 `agentRuntime.run({ ..., abortSignal: replController.signal })`
  - **`securityPrompt` 回调改造为 pause/resume KeyboardSource 包裹 `rl.question`**(§3.7.3 协调协议),消除 raw mode 与 cooked mode 冲突:
    ```typescript
    securityPrompt: async (text) => {
      renderer.stop();
      keyboardSource.pause();
      try { return await rl.question(text); } finally { keyboardSource.resume(); }
    }
    ```
  - state.running = false 之后:detach + 不复用 replController(每个 turn 一个新实例)
  - 双击 ctrl+c 触发:先 abort 当前 turn → 等 turn 退出 → 走现有 /exit 路径清理(scheduler.stop 等)
- 测试:
  - keyboard-source 单测:mock stdin emit `'keypress'` 事件 with `{ name: "escape" }` → controller abort with reason.kind="user-cancel" + source="esc"
  - keyboard-source 单测:emit `'keypress'` 两次 with `{ name: "c", ctrl: true }`,间隔 < 800ms → onDoublePress 触发;间隔 > 800ms → 各自单击
  - keyboard-source 单测:onDoublePress 返回 Promise → KeyboardSource 不 await(fire-and-forget)
  - keyboard-source 单测:non-TTY stdin → attach 返回 no-op handle
  - **keyboard-source 单测:pause → keypress 不再触发 abort + stdin.isRaw === wasRaw;resume → keypress 重新触发 abort + stdin.isRaw === true;pause/resume 幂等(多次调用不抖动 raw mode)**
  - signal-source 单测:emit "SIGINT" → controller abort with reason.kind="user-cancel" + source="sigint"
  - acquireStdinOwnership 集成测试:attach 后现有 readline keypress listener 被 snapshot;detach 后恢复
  - **集成测试:state.running=true 期间触发 securityPrompt → keyboardSource.pause 调用 → rl.question 在 cooked mode 正常 echo 字符 + Enter 触发 line 事件 → finally resume 恢复 raw mode + keypress 拦截**

**验收**:
- 单测全过
- **手动 REPL 测试**(核心验收):
  - agent 跑时按 Esc → 200ms 内 turn 终止 + 终端显示中断状态 + 回到 prompt
  - agent 跑时按 Ctrl+C → 同上
  - prompt 状态按 Ctrl+C → readline 默认行为(清空输入或退出,不被本模块干扰)
  - 800ms 内连按 Ctrl+C → abort + exit
  - typeahead 面板里按 Esc → 关闭面板(agent 没在跑,KeyboardSource 没 attach)
  - **agent 跑期间触发 securityPrompt 工具确认对话框 → 用户输入字符正常显示、Enter 提交、abort 通过 SignalSource Ctrl+C 仍可触发**

**不做**:不引入看门狗;不做协议清理(abort 后 messages 可能不合规,下一轮 LLM 会报错——已知限制,M4 修复)。

**避免现有功能退化的强制约束**:
- KeyboardSource 装载会把 stdin 切到 raw mode 并独占 keypress,任何在 state.running=true 期间走 `readline.question` 的子 UI 会立即失灵(用户按字符无 echo、Enter 不触发)
- 当前唯一案例是 `securityPrompt`(repl.ts L1198 工具确认对话框)
- **本里程碑落地必须把 KeyboardSource 装载 + repl.ts securityPrompt 改造为 pause/resume 包裹(§3.7.3)放在同一个 PR 合入**——不能拆 PR。任何拆 PR 单独合入 KeyboardSource 装载会让 securityPrompt 直接退化,影响所有需要工具确认的现有用户场景
- 若未来引入新的 cooked-mode 子 UI(临时文本输入对话框等),同样必须同期改造 pause/resume 包裹,否则该子 UI 装载即坏

### M4 — Stream chunk 级 break + cleanup 接入

**目标**:让 abort 在 stream 消费循环中能被立即响应;保证产出协议合规的 messages。

**范围**:
- 修改 `loop/types.ts`:`LLMCallResult` 改为判别联合(aborted: true | false 两个 shape) — breaking change
- 修改 `llm-call.ts`:
  - **`StreamLLMCallParams.abortSignal: AbortSignal` 改为 `controller: AbortController`**——M5 引入 watchdog 时必须能调 `abortWithReason(controller, ...)` 触发 idle-timeout abort,M4 提前到位避免 M5 再 break(§3.2.3 "loop 内部子生成器例外");下游 ChatRequest 仍接 `abortSignal: controller.signal`,Provider 抽象不变
  - **用 `wrapStreamWithAbortRace(stream, controller)` 包装 stream**(M1 已建立基础设施)——保证 INV-12 在 M4 即生效:即使底层 SDK / mock stream 不响应 abortSignal,iterator.next() 在 controller aborted 后 ≤10ms 返回 done。M5 时只需把这一处包装 swap 成 `wrapStreamWithWatchdog(stream, controller, watchdogPolicy, eventBus)`,无需新增包装点
  - `for await` 循环改为「先处理 event 累积 partial,再 check abort」(§3.4.2)
  - try/catch 包裹 for-await:SDK AbortError 时若 `controller.signal.aborted` → 落到 abort 出口
  - 退出时若 `controller.signal.aborted` → return `{ aborted: true, partial: { text, thinking }, usage }`(**不调** assembleMessage,**不 yield** assistant_message)
  - 正常退出 → yield assistant_message + return `{ aborted: false, message, stopReason, usage }`
- 修改 `tool-executor.ts`:
  - `for` 循环开头加 `if (signal.aborted) { abortedAtIndex = i; break; }`
  - catch 块加 `if (signal.aborted) { abortedAtIndex = i; break; }`(不再合成)
  - return 改为 `{ completedResults: results, unexecutedToolUses: abortedAtIndex !== null ? toolCalls.slice(abortedAtIndex) : [] }`
- 修改 `agent-loop.ts`:
  - 调用 streamLLMCall 时透传 controller:`yield* streamLLMCall({ ..., controller })`(M4 仅传 controller;M5 时 `AgentLoopParams.watchdog` 字段引入,届时这里加 `watchdog: watchdogPolicy`)
  - tool 循环调用点 `toolResultMessage(toolResults)` 改为 `toolResultMessage(toolExecutorResult.completedResults)`(承接 §3.5.2 tool-executor return shape 变化:return 由 `ToolResultBlock[]` 变为 `{ completedResults, unexecutedToolUses, abortedDuringToolAt? }`)
  - 进入 abort 退出路径的判定:`llmResult.aborted === true` **或** `toolExecutorResult.unexecutedToolUses.length > 0`
  - 调 `buildCleanup({ partial, unexecutedToolUses, reason })` 拿到 outcome
  - 按 §4.3 组装 yield 序列:partialAssistant → assistant_message;placeholders → tool_end[];最后 turn_complete with `llmResult.usage`(INV-14)
  - 计算 `toolGraceMs = max(0, abortedDuringToolAt - abortFiredAt)`(若都有值,否则 0),作为 emitRunEnd 第 5 个 required 参数透传
  - return AgentResult.aborted with abortReason + exitDelayMs + usage = mergeUsage(...)
- 单测:
  - llm-call abort 路径:mock stream 5 chunks,第 3 chunk 处理后 controller.abort → 第 3 chunk 的 text 已累积进 partial.text;返回 `{ aborted: true, partial }`;**usage 反映 LLM 实际处理的 tokens**(INV-14)
  - llm-call abort 路径:partial 不包含 pendingToolCalls(即使 stream 中收到了 tool_call_start)
  - tool-executor 5 个 calls,第 2 个执行中 abort → completedResults.length === 1,unexecutedToolUses.length === 4
  - cleanup partial 非空 → outcome.partialAssistant 含 [interrupted] 标记
  - cleanup unexecutedToolUses 非空 → outcome.placeholderToolResults 数量与顺序匹配
  - cleanup partial + unexecuted 都空 → kind="no-cleanup"
  - 端到端:agent-loop abort → final newMessages 协议合规(zod schema:每个 tool_use 都有 tool_result)
  - 端到端:abort 后 trackMessages 收到的 yield 序列产出 newMessages 含 partial assistant + 包含合成 tool_results 的 user message
  - 端到端:abort 后 turn_complete.usage === llmResult.usage(非 emptyUsage,INV-14);AgentResult.usage === mergeUsage(state.totalUsage, llmResult.usage)

**验收**:
- 单测全过
- **手动 REPL 测试**(接 M3):按 Esc 中断后再发新消息,LLM **不报 400**(messages 协议合规)
- 集成测试:abort 后 transcript 持久化包含 partial 内容 + `[interrupted]` 标记
- 集成测试:abort 后 UI 显示的 turn token 用量 ≈ LLM 实际处理的 tokens(非 0)

**不做**:不加 idle-timer 看门狗(P1 主因 223s hang 还未修复,M5 修);不做工具 grace 策略(M6)。

### M5 — Stream idle-timer 叠加层(修复 P1 主因)

**目标**:让 LLM 流响应静默挂死时自动检测并触发 abort;watchdog facade 组合 race + idle-timer 两层。

**范围**:
- 新建 `packages/core/src/interrupt/watchdog.ts`:wrapStreamWithWatchdog facade + wrapWithIdleTimer 内部函数(按 §3.4.1 实现)
- 修改 `agent-loop.ts`:从 `params.watchdog?: WatchdogPolicy` 读策略,传给 streamLLMCall
- 修改 `llm-call.ts`:把 race 包装升级为 `wrapStreamWithWatchdog(stream, controller, watchdogPolicy, eventBus)`
- 修改 `loop/types.ts`:`AgentLoopParams` 增加 `watchdog?: WatchdogPolicy`
- 修改 `run-agent.ts`:**仅在 `params.watchdog === undefined` 时填默认 `DEFAULT_WATCHDOG_POLICY`**——保留用户通过 RunParams 传入的自定义 policy(包括显式禁用 idle-timer 的 `createWatchdogPolicy({ idleTimeoutMs: 0 })`);`runAgentLoop` 内部不再二次 fallback,fallback 链单点存在(只信任入参)
- 单测(vitest fake timer + 异步 mock stream):
  - fake stream 60s 不出 chunk → 30s 触发 warn 事件、60s 触发 abort(reason.kind="idle-timeout")
  - fake stream 每 5s 一个 chunk → 永不触发
  - 外部 abort 先于看门狗 → race 立即返回 done,clearTimers,无 abort 重复触发
  - **关键 INV-12 测试**:`policy = { idleTimeoutMs: 0, warnThresholdRatio: 0.5 }`,mock stream 永远 hang,触发外部 abort → race 在 ≤10ms 内返回 done(idle-timer 关闭但 race 仍工作)
  - **关键 INV-12 测试**:`policy = { idleTimeoutMs: 60_000, warnThresholdRatio: 0.5 }`,mock stream 永远 hang,触发外部 abort → race 在 ≤10ms 内返回 done
  - stream 正常结束 → vi.getTimerCount() === 0;abort signal listener count 不增长(INV-7)
  - chunk 间隔 50s → 第 30s 触发 warn → 50s 收 chunk reset → 新周期 30s 后再 warn

**验收**:
- 单测全过
- **手动 REPL 测试**(核心验收):触发 web_fetch 让 LLM 长时间不出 chunk → 30s 看到警告日志,60s agent-loop 自动终止 with reason.kind="idle-timeout"
- INV-7 校验:agent-loop 跑完后 `vi.getTimerCount() === 0`
- INV-12 校验:**任何 watchdog policy(含 disabled)**下,触发 abort 后 stream 在 ≤10ms 内退出

**不做**:UI 倒计时显示在 M8(本里程碑只发 EventBus 事件);工具 grace 策略在 M6。

### M6 — 工具中断协议层(协议字段 + helper)

**目标**:建立工具中断策略协议字段;提供跨平台 gracefulKill helper;为下游工具实际接入 grace 策略提供基础设施。

**范围**:
- 修改 `packages/core/src/types/tools.ts`:`ToolDefinition.interruptBehavior?: "cancel" | "grace" | "background"`
- 新建 `packages/core/src/interrupt/graceful-kill.ts`:跨平台 gracefulKill(按 §3.5.3 实现)
- core/index.ts 增加 re-export
- 单测(gracefulKill):
  - mock ChildProcess 立即退出 → gracefulKill 立即 resolve
  - mock ChildProcess SIGTERM 后 500ms 退出 → graceMs=1000 时 resolve(不触发 SIGKILL)
  - mock ChildProcess SIGTERM 后不退出 → graceMs=1000 时 1s 后触发 SIGKILL → resolve
  - process.platform="win32" mock(DI 锚定)→ 不发 SIGTERM 直接 child.kill()
- 单测(interruptBehavior):
  - 默认 cancel:现有所有工具 ToolDefinition 不带 interruptBehavior 字段时视为 cancel
  - tool-executor 不读 interruptBehavior(M6 协议层只声明,工具自身按声明实现)

**验收**:
- 单测全过
- core 包导出 gracefulKill
- 现有工具实现零改动(interruptBehavior 是可选字段)

**避免 dead code 债务的强制约束**:
- `interruptBehavior` 字段在 M6 完成时**没有任何代码消费方**(tool-executor 不读、Bash 工具未接入)。这是接口预留;若长期无消费方接入则成为 dead code 债务
- **本里程碑落地必须同步开启 Bash 工具接入工单**(独立 PR,接入项:Bash 工具 ToolDefinition 标注 `interruptBehavior: "grace"` + 内部 import 并使用 `gracefulKill` 替代自写 SIGTERM/SIGKILL),与 M6 同期 review、同期合入
- 若 Bash 工具接入工单不与 M6 同期合入,**M6 不应推进**——避免协议字段悬空。本规范不规定 Bash 工具内部实现细节(那是 tool 自身的 spec),只约束"M6 不能孤立合入"

### M7 — 子 Agent 中断传播(为 Step 21 预留)

**目标**:父 agent abort 时子 agent(通过 `forkController()` 创建)自动 abort;子 abort 不影响父。

**范围**:
- 修改 `agent-loop.ts`:增加 `params.parentController?: AbortController`
- 入口逻辑:
  - 若 parentController 存在 → `controller = forkController(parentController)`,同时 externalSignals 仍合并 params.abortSignal
  - 否则按 M2 创建独立 controller
- 子 agent 调用方(Step 21 spec 实现)传 parentController
- 单测:
  - 父 controller fork 出子 → 父 abort → 子 controller 在 < 10ms 内也 aborted
  - 父 controller fork 出 3 个子 → 任一子 abort → 父和其他兄弟不受影响
  - 嵌套(父 fork 子,子内部 runAgentLoop 时自动 fork 孙)→ 父 abort → 子和孙都 abort
  - 集成测试(mock 子 agent loop):父 agent 跑到第 2 turn 时父 controller abort → 进行中的子 agent 在 200ms 内终止

**验收**:单测全过;集成测试通过。

**不做**:本里程碑不实现完整的子 agent 抽象(那是 Step 21 范围);只验证 fork → abort 传播机制能正常工作。

### M8 — 视觉反馈与可观测性

**目标**:用户在中断警告 / 触发 / 完成时看到清晰反馈。

**范围**:
- 修改 `packages/cli/src/render.ts`:
  - 订阅 `interrupt:warn` → 显示 "stream slow, will auto-cancel in Xs..."(每秒刷新倒计时)
  - 订阅 `interrupt:fired` → 显示 "interrupted: <reason summary>"
  - renderSummary 按 abortReason.kind 显示差异化文本(见 §8.3)
  - partial assistant message 末尾的 `[interrupted]` 用 dim 灰色标记
- 修改 `repl.ts`:
  - state.running=true 时底部状态条显示 `chalk.dim("(esc to interrupt · ctrl+c again to exit)")`
- EventBus 事件文档化:在 `agent-events.ts` 注释说明 interrupt:warn / interrupt:fired 字段语义

**验收**:
- **手动 REPL 测试 5 个场景**:
  1. 看门狗 30s warn → 屏幕显示倒计时 "auto-cancel in 30s"
  2. 看门狗 60s 触发 → 终止 + 显示 "interrupted: stream idle 60s, 0 chunks received"
  3. 用户 Esc → "interrupted by user (esc)"
  4. max-turns 触发 → "max turns 100 reached"(**不带** abortReason 文本)
  5. 父 agent abort 子 agent → 子 agent 显示 "interrupted by parent (user-cancel)"
- EventBus 订阅集成测试:模拟一次完整 abort 流程,验证 warn → fired → run_end 顺序

### M9 — 实战压测与调优

**目标**:在 mock + 真实 LLM provider 场景下验证 INV-1 / INV-4 / INV-5 / INV-7 / INV-12 / INV-14 不变量。

**范围**:
- 新建 `packages/core/src/__tests__/interrupt-stress.test.ts`:
  - 100 次随机 abort 实验:异步 mock provider(基于 `mockSequenceProvider` 加 await sleep 包装)模拟 1-10s 流响应 + 5 个 tool 串行
  - 每次随机时刻 abort
  - 度量 abort → run_end P50 / P95 / P99 延迟,**分别统计 exitDelayMs、toolGraceMs、loopFrameworkDelay = exitDelayMs - toolGraceMs**;INV-1 SLO 验证 loopFrameworkDelay 而非原始 exitDelayMs(避免 grace 工具合规等待被误判 SLO 违反)
  - 每次 run 结束后用 zod schema 校验 messages 协议合规
  - 每次 run 结束后校验 AgentResult.usage > emptyUsage(若 LLM 调用过)(INV-14)
  - vi.getTimerCount() === 0 校验(INV-7)
  - process listener count 不增长校验
- 真实 LLM provider 验收(手动):
  - 跑长任务(多 tool 串行),中途按 Esc,验证体验
  - 跑会触发 idle-timeout 的场景,验证看门狗效果

**验收**:
- P95 abort 传播延迟 ≤ 200ms(INV-1)
- 100 次中协议合规率 100%(INV-4)
- usage 计入率 100%(INV-14)
- vi.getTimerCount() === 0(INV-7)
- 手动验收 5 场景体验流畅

**注**:mock-provider.ts 当前是同步 generator,stress test 需要新写一个支持 await sleep 的异步 mock 包装。

---

## 7. 测试策略

### 7.1 单测层(vitest)

| 模块 | 关键测试场景 |
|------|------------|
| `controller.ts` | 4 helper 各自正确性、fork 父子传播、外部 signal 合并、reason 类型化 |
| `types.ts` createWatchdogPolicy | warnThresholdRatio 边界值(0/1/负/超大)throw;合法值通过 |
| `stream-race.ts` | mock stream 永远 hang 时 race 触发后 ≤10ms 返回 done(INV-12);settle 后 listener removed(INV-7) |
| `assemble.ts` | 仅 text + thinking、`[interrupted]` 标记、blocks 顺序 |
| `cleanup.ts` | partial / unexecuted 各种组合 → CleanupOutcome.kind 分支正确;formatReasonForToolResult 4 种 reason kind |
| `watchdog.ts` | chunk-arrival 计时、双阈值、disabled 时仍 race(INV-12)、resource cleanup(INV-7)、reset 后允许再 warn |
| `graceful-kill.ts` | POSIX SIGTERM→grace→SIGKILL、Windows 直接 kill、已退出 child no-op |
| `keyboard-source.ts` | mock stdin emit 'keypress' 事件 with key.name='escape'/'c'+ctrl → reason 类型与 source 字段、双击窗口、raw mode 状态恢复、ownership snapshot/restore、non-TTY no-op、onDoublePress 异步回调不阻塞 |
| `signal-source.ts` | emit "SIGINT" → reason.source="sigint"、detach 后不再触发 |

**测试纪律**:
- 所有时间相关测试用 `vi.useFakeTimers()`
- `process.platform` 测试必须 DI mock,不读真实 platform
- KeyboardSource 测试 mock `process.stdin`,不动真实 stdin
- 不引入真实 LLM provider;用 mock-provider.ts + 异步包装

### 7.2 集成测试层

- agent-loop + llm-call + tool-executor 端到端:abort 触发 → AgentResult.reason="aborted" + newMessages 协议合规(zod schema)+ usage 反映实际处理 tokens(INV-14)
- agent-loop abort listener 同步记 abortFiredAt + 退出路径 await emit fired(emit 顺序通过 spy 验证 fired 在 run_end 之前)
- REPL 装载 KeyboardSource:模拟 keypress emit → controller abort → agent-loop 终止
- 子 agent fork:父 controller abort → 嵌套子 agent 全部终止
- typeahead-input 与 KeyboardSource ownership 协调:先后 attach/detach 不破坏现有 listener

### 7.3 手动验收

- M3 / M4 / M5 / M8 各自的"手动 REPL 测试"清单
- 真实 LLM provider 跑:长任务 + 中途按 Esc,验证体验流畅 + UI 显示 token 用量准确

---

## 8. 文档与可观测性

### 8.1 EventBus 事件

在 `packages/core/src/types/agent-events.ts` 新增:

```typescript
export interface InterruptWarnEvent {
  readonly kind: "idle-timeout-warn";
  readonly elapsedMs: number;        // 距上次 chunk 时间
  readonly timeoutMs: number;        // 即将触发的阈值
  readonly chunksReceived: number;
}

export interface InterruptFiredEvent {
  readonly reason: AbortReason | null;
  /**
   * 被中断的 turn 序号(0-indexed,等于 abort 触发瞬间的 state.turnCount)。
   * 与 `turn_complete.turnCount`("已完成 turn 数",1-indexed)语义不同——
   * 前者标识"哪个 turn 被中断",后者标识"已完成多少 turn"。
   */
  readonly interruptedTurnIndex: number;
  /**
   * abort 触发到 emit fired 之间的**总**延迟(ms)。值由 emitRunEnd 从 `AgentResult.exitDelayMs` 透传——
   * EventBus 订阅方零依赖 RunResult 即可拿到中断响应延迟。
   *
   * 未记录 abortFiredAt 时(如 listener 注册前已 abort 但防御分支未生效)为 undefined;
   * 正常路径恒有值。
   *
   * **注意**:本字段是"总延迟",**包含工具自身 abort 等待消耗(toolGraceMs)**。
   * 监控 INV-1 P95 ≤ 200ms 的 SLO 时,应使用 `loopFrameworkDelay = exitDelayMs - toolGraceMs`,
   * 与 INV-1 "不含正在执行的工具自身 abort 时间" 严格对应。
   */
  readonly exitDelayMs?: number;
  /**
   * abort 触发瞬间正在执行的工具的 abort 等待消耗(ms)。
   * - abort 发生在工具 await 期间(无论工具响应抛 AbortError 还是正常 return partial)→ 有值
   * - abort 发生在工具间隙、LLM 阶段、turn 边界、contextManager 阶段 → 0
   *
   * 设计意图:让 EventBus 订阅方做 P95 SLO 监控时能精确隔离"loop 框架延迟"与"工具自身延迟",
   * 避免 grace 类工具(如 Bash 1s SIGTERM grace)合规等待被误统计为 loop 框架性能问题。
   */
  readonly toolGraceMs: number;
}

export type AgentEventMap = {
  // ... 现有
  "interrupt:warn": InterruptWarnEvent;
  "interrupt:fired": InterruptFiredEvent;
};
```

**emit 协议(INV-9 严格保证)**:
- `interrupt:warn` 由 watchdog 内部 emit(看门狗持有 eventBus 引用)
- `interrupt:fired` **由 `emitRunEnd` 在 abort 路径上唯一调一次**——`emitRunEnd` 内部判断 `result.reason === "aborted"` 时先 `await emit("interrupt:fired", { reason, interruptedTurnIndex, exitDelayMs, toolGraceMs })`,再 `await emit("agent:run_end", ...)`。所有 abort 退出分支只调 emitRunEnd,fired 自动正确顺序、自动幂等、新增分支零负担;exitDelayMs 直接从 `result.exitDelayMs` 透传,toolGraceMs 由 agent-loop 按 §3.5.2 abortedDuringToolAt 计算后传入,订阅方做 P95 监控用 `exitDelayMs - toolGraceMs` 隔离 loop 框架延迟
- `agent:run_end` 由 `emitRunEnd` 在终止流程末尾 `await emit(...)`(已有)
- abort listener 内**只**做同步操作(记 abortFiredAt),**不**调用 emit——避免 fire-and-forget 时序错乱
- 任何调用 `abortWithReason` 的方(watchdog / KeyboardSource / SignalSource / 父 agent fork 传播)都不自行 emit fired
- **`agent-loop` 启动前的 abort(pre-flight 路径)不 emit 任何 interrupt / run_end 事件**——pre-flight 失败语义是"本次 run 未真启动",订阅方观察到的事件流应保持完整缺失(无 run_start / fired / run_end);emit fired 但缺 run_end 会成为孤儿事件破坏 INV-9 单向蕴含。`buildPreFlightError` 仅在 `RunResult.agentResult` 上填 abortReason 即可——RunResult 是同步返回值,无需事件辅助传递

### 8.2 日志

- abort listener 触发时打 INFO 日志:`[interrupt] abort fired: kind=user-cancel source=esc`
- 看门狗 warn 触发时打 WARN 日志:`[watchdog] stream idle 30s/60s, 0 chunks`
- 看门狗 abort 触发时打 WARN 日志:`[watchdog] stream idle timeout, aborting`
- 不打 stack trace(abort 是预期行为)

### 8.3 错误码与诊断字段

`AgentResult` 字段(INV-13):

```typescript
// loop/types.ts
export type AgentResult =
  | { reason: "completed"; message: Message; usage: TokenUsage }
  | { reason: "max_turns"; usage: TokenUsage }      // 不带 abortReason / exitDelayMs
  | {
      reason: "aborted";
      usage: TokenUsage;                  // INV-14:mergeUsage(state.totalUsage, llmResult?.usage ?? emptyUsage())
      abortReason?: AbortReason;          // null → 外部 signal 直接 aborted(无类型化 reason)
      exitDelayMs?: number;               // abort 触发到 emit run_end 之间的延迟
    }
  | { reason: "error"; error: AgentError; usage: TokenUsage };
```

REPL 在 `renderSummary` 中按 `abortReason?.kind` 显示差异化文本(仅 reason="aborted" 调用此分支):

| reason.kind | 终端显示 |
|-------------|---------|
| `user-cancel` (source="esc") | `interrupted by user (esc)` |
| `user-cancel` (source="ctrl-c") | `interrupted by user (ctrl+c)` |
| `idle-timeout` | `interrupted: stream idle for {timeoutMs/1000}s ({chunksReceived} chunks received)` |
| `parent-abort` | `interrupted by parent ({parentReason?.kind ?? "unknown"})` |
| `external` | `interrupted by external signal{origin ? ` (${origin})` : ""}` |
| `null`(外部 signal 无 reason) | `interrupted` |

`reason: "max_turns"` 显示 `max turns reached ({maxTurns})`,**不读 abortReason**(INV-13)。

---

## 9. 验收清单

主线 M1-M9 完成视为本规格落地。每项验收对应 §6 中 milestone 的"验收"小节。

| # | 验收项 | 关联 INV |
|---|-------|---------|
| 1 | controller.ts 4 helper 单测全过(含 fork、abort 幂等、外部 signal 合并) | INV-2、INV-3、INV-8 |
| 2 | createWatchdogPolicy 边界值验证(warnThresholdRatio 在 (0,1) 之外 throw) | INV-6 |
| 3 | stream-race.ts mock stream 不响应 abortSignal,触发 abort 后 ≤10ms 退出 | INV-12 |
| 4 | assemble.ts 单测全过;partial 仅含 text + thinking | INV-5 |
| 5 | cleanup.ts 单测全过;CleanupOutcome 判别联合 4 种组合正确 | INV-4 |
| 6 | agent-loop 接入 controller 后现有测试零修改 + abort 路径产 abortReason;max_turns 路径不带 abortReason | INV-3、INV-13 |
| 7 | abort listener 同步记 abortFiredAt 不 emit;**已 aborted signal 场景下也能正确记**(防御 EventTarget 标准);emitRunEnd 在 abort 路径单一调用 emit fired,顺序在 run_end 之前(spy 验证);**fired payload 含 exitDelayMs(数值 ≥ 0,与 AgentResult.exitDelayMs 一致)+ toolGraceMs(工具 await 期间 abort 时 > 0,其他场景为 0)** | INV-9 |
| 8 | REPL 按 Esc / Ctrl+C 200ms 内 abort 当前 turn(手动) | INV-1 |
| 9 | REPL Ctrl+C 800ms 双击退出(手动) | INV-10 |
| 10 | KeyboardSource 与 acquireStdinOwnership 集成测试通过 | INV-11 |
| 11 | abort 后 newMessages 通过 zod schema 校验(每个 tool_use 都有 tool_result) | INV-4 |
| 12 | partial assistant message 包含 `[interrupted]` 标记 | INV-5 |
| 13 | StreamWatchdog 60s/30s 双阈值单测全过;disabled 时 race 仍工作 | INV-6、INV-12 |
| 14 | StreamWatchdog 资源 cleanup 通过 vi.getTimerCount() 校验 | INV-7 |
| 15 | abort 路径 turn_complete.usage === llmResult.usage(非 emptyUsage);AgentResult.usage = mergeUsage(...) | INV-14 |
| 16 | 看门狗 warn 触发 → 屏幕实时倒计时(手动) | INV-9 |
| 17 | EventBus 事件顺序:interrupt:warn → interrupt:fired → agent:run_end | INV-9 |
| 18 | gracefulKill 跨平台(POSIX SIGTERM→SIGKILL / Windows direct kill)单测全过 | — |
| 19 | 子 agent fork 父 abort → 子 < 200ms 终止 | INV-1、INV-8 |
| 20 | M9 stress test:100 次随机 abort,协议合规率 100%、**P95 loop 框架延迟(`exitDelayMs - toolGraceMs`)≤ 200ms**、usage 计入率 100% | INV-1、INV-4、INV-14 |
| 21 | run-agent.ts buildPreFlightError abort 路径在 RunResult.agentResult 上携带 abortReason(`getAbortReason ?? { kind: "external" }`);**eventBus 全程零 interrupt:fired / agent:run_end emit**(pre-flight 阶段 agent-loop 未启动,事件流缺失即语义) | INV-3、INV-9、INV-13 |
| 22 | contextManager abort 路径(toTerminalAgentResult)→ AgentResult.aborted 携带类型化 abortReason + exitDelayMs,与主循环 abort 退出路径行为一致 | INV-3、INV-13 |
| 23 | abort 与 max_turns 同时满足时(state.turnCount === maxTurns 且 controller.signal.aborted)→ AgentResult.reason="aborted"(abort 优先) | INV-13、ADR §5.17 |
| 24 | tool-executor abortedDuringToolAt 测量正确(工具 await 期间 abort 时有值,工具间隙 abort 时 undefined);agent-loop 计算 toolGraceMs = max(0, abortedDuringToolAt - abortFiredAt);InterruptFiredEvent.toolGraceMs 字段值与之一致 | INV-1 |
| 25 | KeyboardSource pause/resume 与 securityPrompt 协调:state.running=true 期间 rl.question 在 cooked mode 正常工作;pause 期间 SignalSource Ctrl+C 仍可触发 abort | INV-11 |
| 26 | partial assistant message thinking-only 场景含独立 `[interrupted]` text block(INV-5 标记必出) | INV-5 |
| 27 | emitRunEnd 5 个参数全部 required;non-abort 路径调用点也传 (null, state.turnCount, 0)——编译期强制契约一致性,杜绝默认值 turn-index 误报 0 / toolGraceMs 误算 0 的悄悄 bug | INV-9、INV-1 |

主线落地后,本规格状态在 `specifications/README.md` 切到"已实施"。

---

## 附:参考实现引用

### OpenClaw(TypeScript Daemon)
- `_refs/openclaw/src/agents/pi-embedded-runner/run/llm-idle-timeout.ts:11-119` — chunk-arrival idle timeout 实现
- `_refs/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:304, 1265-1280` — runAbortController 单点收敛
- `_refs/openclaw/src/agents/pi-embedded-runner/run/attempt.ts:1281-1303` — `abortable()` race 模式(zhixing stream-race 范本)
- `_refs/openclaw/src/agents/pi-tools.abort.ts:21-46` — combineAbortSignals(AbortSignal.any + fallback)
- `_refs/openclaw/src/utils/fetch-timeout.ts:5-12` — bindAbortRelay(防闭包泄漏)
- `_refs/openclaw/src/agents/bash-tools.exec.ts:1564-1575` — 工具内部 abort handler
- `_refs/openclaw/src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts` — 30s wait-for-idle 协议清理(zhixing 不沿用)

### Hermes(Python Cooperative)
- `_refs/hermes-agent/run_agent.py:2540-2577` — AIAgent.interrupt() 单点
- `_refs/hermes-agent/run_agent.py:4881-4940` — Stream stale watchdog
- `_refs/hermes-agent/run_agent.py:6577-6593, 6868-6879, 7441-7447` — 多层 pre-flight + post-check 中断点
- `_refs/hermes-agent/run_agent.py:6585-6593` — skipped tool 写 fake `role: tool` placeholder
- `_refs/hermes-agent/tools/environments/base.py:369-420` — subprocess polling + SIGTERM→SIGKILL 升级
- `_refs/hermes-agent/tools/environments/local.py:263-279` — killpg 进程组管理
- `_refs/hermes-agent/cli.py:7910-7980` — Ctrl+C 双键序列(soft / hard)
- `_refs/hermes-agent/cli.py:8984-9019` — 关闭路径双重 try/except 对再次 KeyboardInterrupt 免疫

### Claude Code(TypeScript Ink)
- `_refs/claude-code-analysis/src/utils/abortController.ts:16-99` — createAbortController + setMaxListeners(50)
- `_refs/claude-code-analysis/src/utils/combinedAbortSignal.ts:15-47` — createCombinedAbortSignal
- `_refs/claude-code-analysis/src/services/api/claude.ts:1868-1928` — chunk-idle watchdog 完整实现(90s + 45s warn 双阈值)
- `_refs/claude-code-analysis/src/services/api/claude.ts:2305-2335` — exit_delay_ms 测量
- `_refs/claude-code-analysis/src/services/api/claude.ts:1515-1526` — releaseStreamResources
- `_refs/claude-code-analysis/src/hooks/useCancelRequest.ts:63-276` — CancelRequestHandler 上下文优先级路由(zhixing 不沿用 Ink 框架)
- `_refs/claude-code-analysis/src/hooks/useDoublePress.ts:1-62` — 800ms 双击实现(zhixing 沿用模式)
- `_refs/claude-code-analysis/src/screens/REPL.tsx:2106-2163` — onCancel 物化 streamingText(zhixing 沿用 partial 保留思路)
- `_refs/claude-code-analysis/src/services/tools/toolExecution.ts:415-453` — abort 时合成 tool_result
- `_refs/claude-code-analysis/src/utils/Shell.ts + ShellCommand.ts` — Bash 工具 treeKill + abortHandler
- `_refs/claude-code-analysis/src/Tool.ts:407-416` — interruptBehavior 协议(zhixing 扩展为三类)
- `_refs/claude-code-analysis/src/query.ts:1011-1052, 1484-1516` — yieldMissingToolResultBlocks 安全网(zhixing 用 buildCleanup 统一处理)

### 知行已有基础(本规格修改对象)
- `packages/core/src/loop/agent-loop.ts:86-92` — 当前 turn 边界 abort 检查
- `packages/core/src/loop/llm-call.ts:79-131` — 当前 for-await 无 abort 检查(M4 修改)
- `packages/core/src/loop/llm-call.ts:179-203` — assembleMessage(正常路径用,不在 abort 路径用)
- `packages/core/src/loop/tool-executor.ts:63-173` — 当前串行执行无 per-iter check(M4 修改)
- `packages/cli/src/run-agent.ts:177, 591` — RunParams.abortSignal 已透传到 runAgentLoop(无需改)
- `packages/cli/src/run-agent.ts:680-703` — trackMessages(yield 流 → newMessages);agent-loop 通过组装 turn_complete yield 让其零修改产合规 messages
- `packages/cli/src/repl.ts:1101-1288` — 当前 REPL 主循环(M3 装载 sources)
- `packages/cli/src/tui/_internal/stdin-ownership.ts` — 现有 keypress ownership 协调原语(M3 复用)
- `packages/core/src/context/termination.ts:40-43` — ContextTermination 判别联合归一化样板(cleanup 借鉴模式)
- `packages/core/src/types/agent-events.ts:31` — AgentRunEndReason 已含 "aborted"(M5 新增 interrupt:* 事件)
