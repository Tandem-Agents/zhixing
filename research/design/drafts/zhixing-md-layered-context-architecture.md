# ZHIXING.md 分层上下文与约定注入架构

## 需求区

### ZHIXING.md · 分层上下文与约定注入

- **触发**：根目录遗留的旧 `ZHIXING.md` 属于已废弃语义，它曾把 agent 语义绑定到运行地址；这与知行"通用个人助手、可运行在任意地址且效果一致"的产品定位相反。旧文件及所有"运行地址承载项目语义"的相关功能、引用都应彻底清理。
- **用户价值**：用户可以在不同作用域沉淀稳定的工作背景、约定和上下文，让知行进入不同工作环境时自动获得合适背景，同时保持运行地址无特殊意义、上下文前缀稳定、成本可控。
- **核心需求**：建立知行自己的 `ZHIXING.md` 分层上下文与约定注入机制。它只承载上下文与约定注入，不承载记忆；Claude Code 的同类机制只作参考，不作为标准。当前版本只落地全局系统级与工作场景级，子目录级仅作为未来扩展概念保留。
- **作用域**：

  1. 全局系统级：位于知行系统工作目录根下，对所有工作场景通用，是系统级通用配置，与用户个性化无关。
  2. 工作场景级：位于工作场景的工作目录根下，在该工作场景内生效；它对应编程智能体里的"项目级"，但知行统一以"工作场景"表达。仅适用于有工作目录的工作场景。
  3. 子目录级：当前版本不落地，仅作为未来可能扩展的作用域想法保留；若未来引入，其位置必须在工作场景工作目录之下，不能与根目录重合，只能作用于某个更深子目录。本次架构只需避免阻断未来扩展，不设计具体加载、触发、合并 / 覆盖规则。
- **注入机制**：`ZHIXING.md` 内容不进入 system prompt，而是在注意力上下文窗口生命周期内的第一条消息中，以结构化标签注入 user message；一个窗口内只注入一次，压缩换窗后重新注入，以保护上下文前缀稳定和缓存命中。
- **地基约束**：优先复用现有生命周期 / 注意力窗口地基；若地基不足，只能从通用架构角度补强"窗口首条注入"能力，不能为 `ZHIXING.md` 做专用耦合。
- **已定问题**：全局文件的准确物理位置、全局系统级与工作场景级内容的合并 / 覆盖规则、XML / 类 XML 标签形式及标签命名均已在 §11 定死。
- **下一步**：新建独立 draft，先盘点旧 `ZHIXING.md` 文件和相关遗留引用，再设计全局系统级与工作场景级的分层加载、窗口首条注入、合并规则与缓存稳定策略，并保留未来扩展到子目录级的架构余地。

## 用户需求起点

```text
我们接下来要做的是我们自己的ZHIXING.md功能；
在我们项目的代码根目录，其实有一个这个文件，你应该能找到，但它并不是我们这个需求，它是古老版本的，它的概念和定位和现在其实是完全错位，是已经被遗弃废弃、不需要任何考虑它价值的东西。
所以它是需要被删掉的，然后如果和它有相关功能的话也需要清理干净，彻底清理。
我先简要说一下这个古老版本的一些背景：
1. 它当时作为系统内部的一个文件，却放在项目根目录，本身就很奇怪，之前就是错的，所以没有价值。
2. 它当时和运行环境绑定，知行的运行地址和该文件有关。
3. 后来需求非常清晰：知行可以运行在任何地址，预期和效果一样，运行地址不具备任何特殊意义。这是和其他编程智能体非常显著的差别。
4. 因此，这个语义定义也完全被遗弃了，为什么和这个其他编程智能体在这一点上不一样呢？就是为什么我们运行的地址不需要它具备意义？很核心的一个区别就是我们是一个通用智能体，我们的定位是个人助手，所以我并不希望这个运行的地址和我们项目本身的某一个语义产生关联，我觉得这很不好。

然后我们的 ZHIXING.md功能，就和“Claude Code — 系统提示词与上下文组装”这个文档中的 部分内容有关系了；
这部分内容其实指的就是 Claude Code 自己的那个 Cloud.md 文件功能，但是我发现那个文档里描述的范围是混着的，功能里面包含了记忆和其他东西，感觉比较乱。所以它不能作为标准去思考，只能作为一部分参考。
我现在理解的话，从文档里看出的需求是 Cloud.md 文件功能的范围或者说层级有 3 个：

1、第一个就是最顶级的、所有都通用的，是项目工作的系统目录，也就是系统地址的根目录。在那个根目录下有一个文件，全部项目都会用到。这是第一个层级。
2、第二个是项目级配置，即在项目根目录下有一个文件，在该项目范围内生效。
对应到我们自己的项目，这指的就是“工作场景”。前面让你看过的工作场景架构文档中提到，我们分为“主模式”和“工作模式”。在“工作模式”下可以绑定“工作地址”，这个“工作地址”实际上就等同于编程智能体中的“项目”概念。
我们也有这个概念，只是叫法不同。因为我们是通用智能体，未来面对的工作场景更多，不只是编程。因此，在第二个层级上，我们以“项目”为单位，但将叫法替换为“工作场景的工作目录”（即根地址或根目录）。在该目录下放置的文件即为项目级文件。
3、第三个点：文档里提到是子文件夹级。这个级别我其实没太考虑好，因为我自己在使用 Claude Code 的时候，并没有意识到这个层级的文件能力的价值，但我大概能感觉到它可能是有价值的，所以我决定可以保留这个功能。
具体约束如下：
1. 这个层级必须是在工作场景之下
2. 是在根目录之下的层级，不能重合
3. 它得是在某一个子目录
这大概是我理解到的点。你待会可以审核一下我理解的这个点对不对？

无论是哪个层级，注入的时机是明确且唯一的。

我们有两个概念：生命周期，以及注意力上下文窗口。一个注意力上下文窗口是有生命周期的，即在压缩前（无论是手动压缩还是触发注意力阈值压缩），在触发压缩之前，它处于一个生命周期内。

原则是：在一个窗口内，上下文前缀保持不动，以维持最大的缓存可能性，从而降低成本。

因此，在这个生命周期内的第一条消息触发时，进行注入。
关于生命周期和第一个消息注入能力：

1. 我们目前的生命周期架构模块理论上是支持的，因为本身就有生命周期的概念和基础，能够对接。
2. 请你先确认一下是否真的支持，或者地基部分是否还需要补充。
3. 需要明确告诉我这些信息，这是细节问题，与清晰的需求不冲突。

如果生命周期能很好支持，那就没问题；如果不能，我们就需要对生命周期进行修改。修改原则如下：

1. 生命周期是通用的地基，绝对不能为了某个特定需求（包括当前需求）去耦合，或专门为此做能力扩展。
2. 作为通用地基，如果不满足新需求，应站在通用角度，以最优架构实现通用能力的扩展，从而包容当前需求，而不是专门为此耦合。

你理解我的意思吗？

关于 Claude Code 的注入形式，刚才提示词装配文档里提到是通过 XML 标签方式注入的，这可能也是目前主流且最佳的一个注入实践。

你可以查一下最主流、最优的实践方式：
1. 如果 XML 标签确实是最佳实践，就直接按这个走。
2. 名字方面，如果当前名字不是最优，我们可以优化；如果本身已经最优，则不用改。
3. 请确认 XML 标签形式是否为最佳实践，并思考名字是否最优。

只要形式和名字明确了，这个注入形式的需求就很清晰了。

这个需求点我基本上说清楚了，主要包含两部分：

1. 清理旧的、看起来相似但实际上完全不同的东西。
2. 明确需求的描述，包括功能层级和注入机制：
   - 功能层级：从全局到项目系统工作目录（与用户无直接关系），再到工作场景级别，最后是子目录级别。
   - 注入时机：基于现有的生命周期地基。
   - 注入形式：有参考依据。

以上几点我觉得已经说得很清楚了。如果你还有什么问题，可以问，但我们只对接需求问题，不对接架构细节。
```

## 架构内容

> 本节为可执行架构。设计原则：不做最小修补，补通用地基而非 `ZHIXING.md` 专用耦合；分层加载、发送前缀出口、领域消费者三层解耦、可插拔、可扩展。

### 0. 架构总览

`ZHIXING.md` 的本质是**作用域化的常驻约定**：一次声明、进入对应作用域即持续生效，形态稳定如 `gitconfig` / `editorconfig`。落到知行运行态，它有五条硬性质，任何方案都必须同时满足：

1. **窗口（段）级常驻**：一个注意力窗口内所有 run 都能看到，不是单个 run 瞬态。
2. **进 messages、不进 system prompt**（用户明确约束）。
3. **只进发送视图、不进窗口事实、不落盘**：它是持久文件的派生视图，只在 LLM-call 请求前缀出现，绝不写回 transcript、`AttentionWindow` 或段摘要。
4. **每段一次、换段重注**：压缩换窗后由新窗 `onWindowOpen` 重算，窗口内 byte-equal 保 cache 前缀。
5. **并发安全**：同一 runtime 被 REPL 前台 + scheduler 后台并发 run，in-flight run 不得中途观测到注入内容变化（否则破自己的 cache）。

方案分三层，自下而上：

```
┌─ ③ 领域消费者（cli 装配层）────────────────────────────────┐
│   createZhixingGuidanceLifecycle —— AgentRuntimeLifecycle    │
│   onWindowOpen 内：调 ② 分层加载 → 合并 → 调 ① 贡献出口       │
├─ ② 分层加载服务（纯逻辑 + 注入式 I/O）──────────────────────┤
│   已解析根目录 → 作用域链拼路径 → 全量读文件 → 层叠合并渲染   │
├─ ① 通用地基扩展（orchestrator / core）──────────────────────┤
│   窗口级发送前缀能力：                                       │
│   onWindowOpen 新出口 contributeMessagePrefix               │
│   + 双层 holder（实例权威 / run 局部）                       │
│   + run 入口 capture、agent-loop 每次 LLM-call 现取前缀       │
│   + system-meta 对形态（core/system-meta.ts 新 kind）        │
└─────────────────────────────────────────────────────────────┘
```

只有 ① 触碰通用地基，并复用已验证的 system prompt 双层 holder / epoch 并发思路；② ③ 是 `ZHIXING.md` 领域内容，与地基解耦。这个地基能力不是 `ZHIXING.md` 专用能力，未来任何"窗口级稳定发送前缀"都可复用。

### 1. 地基现状与支持度结论（回答"生命周期是否支持"）

一手核查结论：生命周期地基**结构上支持、能力上缺一个出口**。

- **触发时机已正确**：`onWindowOpen` 钩子绑在窗口换代边界（建实例 / 段切换 / compact / clear / resume），每段触发一次——正是"窗口生命周期第一条消息"的时机。见 `packages/orchestrator/src/runtime/create-agent-runtime.ts` 的 `windowLifecycle.onChange`（`create-agent-runtime.ts:1391-1437`：旧窗 `onWindowClose` → 新窗 `onWindowOpen`）。
- **并发范式已验证可复用**：system prompt 已用"实例权威 + run 局部"双层 holder 解决并发换代问题（`create-agent-runtime.ts:1382-1441`：`instanceSegmentOverrides` 单调写给后续新 run、`localSegmentOverrides` 只改本 run；`myEpoch > instanceEpoch` 守卫防滞后并发 run 回写）。
- **缺口——没有"窗口级 messagePrefix 贡献出口"**：
  - `onWindowOpen` 现在唯一的贡献通道是 `updateSystemPromptSegment`（`create-agent-runtime.ts:1420-1425`），只改 system prompt 段 → 违反"不进 system prompt"。
  - `onBeforeRun` + `injectUserContext` → `prependContextBlock` 是 **run 瞬态**，拼进"最后一条 user message"（本轮用户输入），每 run 都重拼且位置随本轮输入浮动 → 违反"窗口级常驻 + 前缀稳定"。
  - `AttentionWindow` 的 `bootstrap` 条目锚在**会话激活**（`createAttentionWindow` 仅在 `conversation-manager.ts` `doCreate` 调用），且**首次折叠即被摘要对取代**（`attention-window.ts` `fold()`：新 summary 置首、取代含 bootstrap 的全部前缀条目）→ 不在段边界续存、不可承载"每段重注"。
- **结论**：按用户"通用地基不为特定需求耦合，缺则以通用最优架构扩展"的原则，补 ① 一个通用的"窗口级发送前缀"能力。它与 `updateSystemPromptSegment` 完全平行——一个贡献 system prompt 段，一个贡献 LLM-call message 前缀，同一个双层 holder 范式。

### 2. 通用地基扩展 ① —— 窗口级发送前缀

**定位**：`onWindowOpen` 期间，订阅者贡献一段"窗口级常驻发送前缀"；runtime 持有它，但不把它写入 `state.messages`。agent-loop 在每次 LLM-call 组装请求时现取 `getMessagePrefix()`，把前缀拼到实际发送给 provider 的 messages 最前。窗口内 byte-equal，换段重算。不含任何 `ZHIXING.md` 知识——任何"窗口级稳定发送背景"都可复用。

**2.1 新出口与实例身份（生命周期契约）** — `packages/orchestrator/src/runtime/lifecycle.ts`

`LifecycleContextBase` 增实例级运行体身份，供所有 lifecycle 订阅者在窗口级钩子中判断运行面；`LifecycleWindowOpenContext` 增一个方法，与 `updateSystemPromptSegment` 对称：

```ts
type RuntimeKind = "conversation" | "ephemeral";

interface LifecycleWarningInput {
  readonly message: string;
}

interface LifecycleWarningEvent extends LifecycleWarningInput {
  readonly hookId: string;
  readonly phase: string;
  readonly windowIndex?: number;
  readonly runtimeId: string;
}

type MessagePrefixContribution = readonly Message[];

interface LifecycleContextBase {
  readonly runtimeKind: RuntimeKind;
  reportLifecycleWarning(event: LifecycleWarningInput): void;
  // 既有字段：runtimeId / mode / sceneId / providerId / model
}

interface LifecycleWindowOpenContext extends LifecycleContextBase {
  readonly reason: WindowOpenReason;
  readonly windowIndex: number;
  updateSystemPromptSegment(segment: DataDrivenSegment, content: string | null): void;
  /**
   * 贡献本窗口的常驻发送前缀 messages（不进 system prompt、不进 state.messages、不落盘）。
   * messages=null 表示本窗口该订阅者无贡献，且覆盖清空上一窗同订阅者贡献。
   * 多订阅者各贡献一组 messages，按 lifecycle 注册顺序拼接为 messagePrefix。
   */
  contributeMessagePrefix(messages: MessagePrefixContribution | null): void;
}
```

按订阅者区分（不是按资源名），因为语义是"多源各贡献一块、有序拼接"，而非"同名覆盖"。runtime 在 `onWindowOpen` 的订阅者循环里为每个 `sub` 闭包捕获 `sub.id` 作 key；装配期必须校验最终 lifecycle 列表的 `id` 唯一，重复直接 fail-fast。

`MessagePrefixContribution` 不是任意消息数组：runtime 边界必须校验为纯文本、角色安全、以 assistant 结束的 user/assistant pair 序列，并深拷贝为 runtime 自有快照；非法贡献清空该订阅者本窗贡献并按 hook 失败处理。这样 capability 校验可继续只看业务 `messagesForLLM`，不会被未来订阅者塞入图片 / 工具块 / 可变引用破坏。

`reportLifecycleWarning` 走实例级通用诊断 sink：订阅者只提供 `message`，runtime 自动补 `hookId` / `phase` / `windowIndex` / `runtimeId`，不信任订阅者自报归属；公开事件名为 `lifecycle:warning`。`lifecycleBase()` 只负责身份字段，诊断 sink 必须按构造点注入：run 内 ctx 绑定当前 `eventBus` 并进入 `session-events.ts` 小 payload 投影；run 外（`instance-start` / `clear` / `resume` / `compact` / `dispose`）ctx 绑定同结构有界 ring buffer。`ConversationManager` 作为会话 owner，在 runtime 创建后、run 外窗口变更 / compact / dispose 后通过 `drainLifecycleDiagnostics()` 读取 ring buffer，并用现有 `sessionBroadcast + createControlSessionEventEnvelope` 投影为 `session.event`，避免"写了无人读"。诊断出口不为 guidance 专用。

事件语义正交定死：`lifecycle:hook_failed` 是运行时判定 hook 失败的权威通道，覆盖订阅者抛错、非法 `MessagePrefixContribution` 等运行时检测失败；`lifecycle:warning` 只承载订阅者主动 `reportLifecycleWarning` 的软降级信息，例如 `getWorkscene` 失败、workdir 非绝对、按层读取降级。二者不得混用。

`runtimeKind` 在实例装配期定死：`CreateAgentRuntimeOptions.runtimeKind?: RuntimeKind` 默认 `"conversation"`；普通主对话 / 工作场景会话显式传 `"conversation"`，定时任务等一次性执行体显式传 `"ephemeral"`。它是通用生命周期身份字段，不为 `ZHIXING.md` 耦合；`conversationId` 只存在于 run 级上下文，不能用于 `onWindowOpen` 判定运行面。

**2.2 双层 holder（并发正确性）** — `create-agent-runtime.ts`

复用 `instanceSegmentOverrides` / `localSegmentOverrides` 的 holder + epoch 思路，但不是照抄 system prompt 段机制：prefix 需要 per-sub.id key、事务提交、Message[] 深拷贝与 run 外 committed 视图原子切换。

- 实例级：`instanceMessagePrefixContributions: Map<subId, MessagePrefixContribution | null>` + `authoritativeMessagePrefix` + `instanceEpoch`（复用现有 epoch 机制）。
- run 局部：run 入口从实例级快照出 `localMessagePrefixContributions`，并派生 `localMessagePrefix`。
- `onWindowOpen` 的 `contributeMessagePrefix(messages)` 按订阅者事务化：ctx 先写该订阅者临时 contribution；hook 正常结束且边界校验通过后，深拷贝进入本次窗口的 staged holder。hook 抛错或非法贡献按所在路径处理，三条既有错误语义不能抹平：首窗 `instance-start` 仍 fail-fast；run 外 `clear/resume/compact` 仍 collect failure，且该订阅者本窗 staged 贡献置空；run 内换窗仍 emit 当前 `eventBus` 的 `lifecycle:hook_failed` 并继续，且该订阅者本窗 staged 贡献置空。
- 实例权威提交必须原子：run 外 onWindowOpen 与 run 内 `myEpoch > instanceEpoch` 提交都先暂存本次窗口的 system prompt 覆盖与 prefix 贡献，订阅者循环结束后同刻切换 `instanceSegmentOverrides` / `instanceMessagePrefixContributions` / `authoritativePrompt` / `authoritativeMessagePrefix`。run 外 `estimateConversationRequestBudget` 只能读一次 committed view，禁止读到旧 prompt + 半更新 prefix。
- holder 起点定死：local 从 instance 快照继承；订阅者不调则沿用该订阅者上一窗贡献。`zhixing-guidance` 消费者每窗必须调用一次，传 messages 或 null；null 表示本窗清空，不允许误沿用旧 guidance。
- prefix 拼接只有一个纯函数：`assembleMessagePrefix(contributions, lifecycleOrder)`，显式按 lifecycle 注册顺序读取 holder、跳过 null / 空贡献，并返回深拷贝后的 messages。run 内传 `localMessagePrefixContributions`，run 外 budget 传 `instanceMessagePrefixContributions`；两者不得各写一套拼接逻辑。

**2.3 拼装与发送位置** — `create-agent-runtime.ts` + `agent-loop.ts`

- 拼装：runtime 只通过 `assembleMessagePrefix(localMessagePrefixContributions, lifecycleOrder)` 拼接 run-local prefix messages，不知道 `guidance` 或 `<system-meta>`；全空则 `getMessagePrefix()` 返回空数组。
- `create-agent-runtime.ts` 给 `runAgentLoop` 传 `getMessagePrefix: () => readonly Message[]`，形态仿 `getSystemPrompt`。`AgentLoopParams.getMessagePrefix` 可选，`agent-loop` 内默认 `() => []`，保证 sub-agent / 直接 core loop 默认无 prefix。每个 run 入口 capture 本 run 局部前缀；run 内窗口换代后只更新本 run 局部前缀，并单调提交给实例权威供后续 run 使用。
- `agent-loop.ts` 在每次 LLM-call 组装层现取：

  ```
  state.messages
    → turnContextInjector.inject(...)
    → providerMessages = [...getMessagePrefix(), ...messagesForLLM]
    → streamLLMCall({ messages: providerMessages, ... })
  ```

  `providerMessages` 是唯一送 provider 的 messages 口径；LLM-call 请求与 token calibration 必须共用它，避免"请求一套、估算一套"。`state.messages` 仍是窗口事实链；`turnContextInjector` 仍管每次 LLM-call 的动态上下文；`messagePrefix` 是更靠前的稳定发送前缀。三者职责不互相覆盖。
- 发送视图会计收敛为共享发送准备 helper：run 内先生成 `messagesForLLM = turnContextInjector.inject(state.messages)`，再拼 `providerMessages = messagePrefix + messagesForLLM`，并同时返回 `systemPrompt` / `tools` / `stateMessages` / `messagesForLLM` / `providerMessages`。请求、主循环 calibration estimated、turn-end `context:tokens_snapshot`、段阈值估算共用这套发送视图；可摘要 `messages` 仍只用 `state.messages`。`turn-end` 不再自己拼 prefix 或只拿裸 getter，改接收 `prepareSendView(messages)` thunk，保证 snapshot 不漏 turn-context。
- 隔离验收锚：

  1. `guidancePrefix` **不进 `state.messages`**，所以 `runTurnBegin` / `runTurnEnd` 的可摘要 `messages` 输入看不到它，段 split 不会摘要它。
  2. `guidancePrefix` **不进 run record 持久化**，`buildRunRecord` 仍只取用户原文与本 run 新消息，prefix 是纯发送视图。
  3. `guidancePrefix` **每次 LLM-call 现取**，换段后由新窗 `onWindowOpen` 重算，窗口内 byte-equal。
  4. `guidancePrefix` **不进段压缩摘要 LLM 请求**，`SegmentSummarizeRequest.messages` 只使用可摘要事实链 `state.messages` + 末尾压缩指令；compact summary / 持久化派生 snapshot / memory hook 永远看不到 guidance。
- token 会计不变量：`messagePrefix` 不进入 `state.messages` / run record / summary / 持久化派生 snapshot；但所有表达"下一次 provider 请求 token 总量 / 剩余预算"的口径都必须反映 prefix 成本，且不能双算。

  - 单一真相源：`packages/core/src/context/token-accounting.ts` 定义并导出 loop-local `TokenAnchor` 与通用 `computeContextTokens`，输入 `{ estimator, systemPrompt, stateMessages, providerMessages, tools, anchor }`，内化 A1 / A2 规则。`context/token-accounting.ts` 禁止依赖 `loop/*`；loop 反向 import `TokenAnchor`，避免未来预算消费者引入 context → loop 反向依赖。
  - Budget 权威：表达"下一次 provider 请求 token 总量 / 剩余预算"的口径只包括 `context:tokens_snapshot` 数字事件、`ConversationManager.contextBudget`、`session.contextBudget`（含 usage 视图附带的 budget）。`ConversationManager` 是窗口 messages 的唯一 owner，只把当前窗口 messages 作为纯入参传给 `SessionRuntime` / `AgentRuntime`，运行体绝不缓存或持有这份窗口状态。运行体暴露 `estimateConversationRequestBudget(messages)` 与 `estimateMessagesTokens(messages)`；前者由运行体私有 `buildCommittedRequestView(messages)` 用实例当前 `authoritativePrompt + authoritativeMessagePrefix + tools` 和传入 messages 组装不含 turn-context 的请求视图，且必须复用 `computeContextTokens` 同一底层估算口径，不另起算法；后者供 snapshot / perspectives 等 message-only 场景。跨包抽象 `SessionRuntime` 与 `session-adapter` 必须同步改形，不能保留旧 `checkBudget(messages)` 旁路。
  - A1 provider 真值路径：`anchor.totalInputTokens` 与 `getTotalInputTokens(usage)` 已天然包含当次实发 prefix / turn-context；anchor+delta 只在当前 `stateMessages` 仍是 anchor 时刻消息谱系的延伸时可用，delta 只取 `stateMessages.slice(anchor.baselineMessageCount)`，绝不从 `providerMessages` 切片，避免把 prefix / 旧消息重复估算。
  - A2 纯字符估算路径：无 provider 真值或 anchor 失效时，run 内 fallback 按 `estimateText(systemPrompt) + estimateMessages(providerMessages) + estimateTools(tools)` 估算；run 外由 owner 传入当前窗口 messages，runtime 内部用 instance committed 口径组装不含 turn-context 的当前请求视图后调用同一底层估算口径。calibration estimated 使用同源 `providerMessages`。
  - 压缩触发估算：`SegmentManager.evaluate` 阈值不是 budget 权威，但它评估的是当前发送视图能否继续承载。`SegmentManagerInput` 拆分阈值会计输入与可摘要 `messages`：阈值用当前有效 `providerMessages`，split / summary / record 仍只用 `state.messages`。
  - 压缩转移指标：`tokensBefore` / `tokensAfter` / `windowCompact` 是 `SegmentManager.evaluate` 的转移指标，用于展示压缩效果与快照元数据，不代表下一次 provider 请求总量。源码路径允许 before / after 采用不同展示口径（例如 before 近似请求总量、after 近似压缩后消息量），只要求字段文义清楚，不被任何 budget 权威路径复用。
  - `forceCompact` 定死：`ForceCompactResult` 不再返回 budget，也不保留兼容字段；只保留 `modified` / `messages` / `windowCompact` / `emergencyFloor` 等结果与转移指标。手动压缩后的最终容量，由 owner 在 `applyCompact → onAttentionWindowChange` 后通过 `ConversationManager.contextBudget` / `session.contextBudget` 获取。
  - B 类：可摘要历史量口径永远不含 prefix，包括摘要请求 messages、segment split 输入、summary 内容、持久化派生 snapshot / memory hook 内容及其度量。
  - `TokenAnchor`：语义改为 `totalInputTokens`，写入、calibration actual 与成功样本 guard 统一使用 `getTotalInputTokens(usage)`。`baselineMessageCount` 仍用 `state.messages.length` 作为唯一 state 维度基线，不新增第二 baseline、hash 或版本号机制；anchor 失效的本质条件是消息谱系被替换，长度只是不可靠代理。失效判定与执行全部留在 loop 层：`runTurnBegin` / `runTurnEnd` 根据 `SegmentManager.evaluate` 既有 `modified && newSegmentMessages` 事实自行推导“谱系被替换 → anchor 失效”（snapshot 传 `anchor: undefined`，工具循环继续跑时写回 `state.anchor = undefined`）。`SegmentManagerOutput` 不新增 anchor 字段，segment 层对 token 会计零知识。追加消息不是谱系替换，仍由 delta 正确处理；run 外 `/compact`、`clear`、`resume`、会话切换不持有 loop-local anchor，下个 run 自然重建。turn-context 内容变化但消息长度不变时只造成一次 snapshot 近似误差，下一次成功 LLM call 会用新真值重写 anchor 自校正。
  - 同名澄清：`context:tokens_snapshot` 是给 UI 的 token 数量事件，属 budget 权威、数字含 prefix；compact summary / 持久化派生 snapshot 是内容快照，属 B 类、内容绝不含 guidance。
- turn-end 顺序定死：`runTurnEnd` / `runTurnBegin` 接收同一个 `prepareSendView(messages)` thunk，而不是一次性 `systemPrompt` / `messagePrefix` 值。流程为 `evaluate(旧发送视图判是否压缩) → 若换窗则 windowLifecycle.onChange(重算 system 段 + prefix，并显式失效 anchor) → snapshot(重新 prepare，使用新 system / prefix，且包含 turn-context；发生谱系替换时不得走 anchor+delta)`。不做发送前同步换窗压缩；固定成本变化由 turn 边界 evaluate 与 snapshot 暴露并收敛。
- 跨层接线定死：`context:tokens_snapshot` 可使用 loop-local anchor；窗口级 `ConversationManager.contextBudget` / `session.contextBudget` 不复用 loop anchor，由 owner 只传当前窗口 messages 给 runtime 的 `estimateConversationRequestBudget(messages)`。run 外 budget 禁止复用 run-local `getMessagePrefix()`；runtime 内部私有 `buildCommittedRequestView(messages)` 先对 instance committed view 做单次快照：`authoritativePrompt` + `authoritativeMessagePrefix` + frozen tools + 传入 messages，`providerMessages = committedPrefix + messages`，不含 turn-context，`anchor: undefined`。`snapshotAttentionWindowV1` / perspectives 调 `estimateMessagesTokens(messages)`，纯 messages、不含 system / prefix / tools / turn-context。`RunResult.budget` 与 `ForceCompactResult.budget` 均删除，不提供 budget 旁路。
- 公开事件契约定死：`packages/core/src/types/agent-events.ts` 必须同步更新，`context:tokens_snapshot.totalTokens` 定义为含 prefix 且按 `getTotalInputTokens` 口径的下一次发送总量；`llm:request_start.messages` 定义为实发 `providerMessages`，不等同窗口事实链 `state.messages`。
- capability 校验保持在 `messagesForLLM` 上即可；`messagePrefix` 是运行时生成的纯文本 `<system-meta>` pair，不含图片 / 多模态 block，对当前 `validateMessagesAgainstInputCapabilities` 恒通过，不需要前移校验点。
- 段压缩摘要路径定死：摘要请求**禁止**带 `messagePrefix`，也不靠 summarize prompt 要求模型忽略 guidance。`guidance` 是可重建约定前缀，不是对话事实；机制隔离优先于 prompt 祈求。现有 `SegmentManager -> createSegmentSummarizeFn -> provider.chat` 独立路径保持使用不含 prefix 的 `input.messages`，只把 prefix 作为固定成本参与阈值估算。
- cache 表述定死：主对话 LLM-call 的 guidance 前缀在窗口内 byte-equal，保持高频请求缓存收益；段压缩是低频维护调用，有意不含 guidance。`packages/core/src/context/segment/prompts.ts`、`segment/llm-fn.ts`、`segment-manager.ts`、`segment/types.ts` 与相关测试中的旧注释必须改为：摘要维护分叉只保证 `systemPrompt + tools + state.messages` 稳定，不承诺与主对话含 guidance 的完整 provider 请求 byte-equal；分叉内部相邻摘要请求仍可稳定命中 cache。

**2.4 注入形式与标签（回答"XML 标签是否最佳、命名"）**

- **XML-like 标签是知行既定最佳实践，复用 `<system-meta>` 单一事实源**（`packages/core/src/context/system-meta.ts`），不新造 `<context>` 或裸 XML。但 `guidance` 不能只吃泛化"机制插入上下文"语义，必须有专项来源与优先级规则。
- **新增 kind**：在 `system-meta.ts` 加 `buildGuidanceMessagePair(content)` 构造器，产出 `<system-meta kind="guidance">…</system-meta>` user + `<system-meta kind="ack">已阅读约定</system-meta>` assistant 对（维持角色交替，同 `startup-bootstrap` 形态）。payload 经既有 `escapeSystemMetaPayload` 防注入闭合标签。
- **来源与优先级**：`SYSTEM_META_PROMPT_SECTION` 增 `guidance` 专项规则：它是用户 / 工作场景声明的稳定约定，优先级低于系统提示、安全策略和当前用户要求，不得覆盖更高层指令；payload 必须带 scope/source 标识（global / workscene、`ZHIXING_HOME/ZHIXING.md` / `workdir/ZHIXING.md` 等逻辑来源），绝对物理路径只进诊断事件、不进发送内容。
- **不进 `SystemMetaKind`**：`SystemMetaKind` / `detectSystemMetaKind` / `stripSummaryPlaceholderPair` 只服务压缩 / 丢弃生命周期识别；`guidance` 与 `startup-bootstrap`、`workscene-digest` 同类，只构造、不参与识别和剥离。`SYSTEM_META_PROMPT_SECTION` 已泛化覆盖任意 kind。
- **命名**：取 `guidance`。理由：`ZHIXING.md` 承载"工作背景 + 约定 + 上下文"，`guidance`（指导/约定背景）比 `directives`（偏强命令）、`context`（与 run 瞬态 `<context>` 撞名）更准；单词、与现有 `workscene-digest` 等同风格。作用域不编进 kind（见 4.3 用块内分节表达），保持 messages 前缀只多一对、最简。

### 3. 分层加载服务 ② —— 作用域链驱动

**定位**：分两层：装配层异步解析运行上下文；服务层基于已解析根目录做路径拼接、文件读取与层叠渲染。路径 / 层叠 / 分节逻辑可纯单测；I/O 通过注入边界隔离。

**3.1 作用域链（可扩展的核心抽象）**

装配层 `onWindowOpen` 先解析根：

```ts
interface GuidanceResolvedRoots {
  readonly homeDir: string;
  readonly workdir?: string;
}
```

- `homeDir = getZhixingHome()`。
- `workdir`：仅当 `ctx.mode==="work"` 且有 `ctx.sceneId` 时，装配层 `await worksceneDirectory.get(ctx.sceneId)`，取返回 scene 的 `workdir`；没有场景、场景不存在、无 workdir 均为 undefined。底层 `WorkScene.workdir` 类型不声明绝对路径契约，宿主 `WorksceneDirectory` 写入侧虽会校验，`zhixing-guidance` 消费边界仍必须用 `path.isAbsolute(workdir)` 防御校验，非绝对路径诊断上报并降级为仅全局层。

服务层不再异步查询领域对象，只消费已解析根目录和注入式文件读取：

```ts
interface GuidanceScope {
  readonly id: "global" | "workscene";  // 未来可加 "subdir"
  readonly label: string;               // 渲染分节标题用
  readonly source: string;              // 渲染逻辑来源用，不含绝对物理路径
  resolvePath(roots: GuidanceResolvedRoots): string | null;
}

interface GuidanceWarningInput {
  readonly message: string;
}

type ReadGuidanceFile = (input: {
  readonly scopeRoot: string;
  readonly path: string;
  readonly reportWarning: (event: GuidanceWarningInput) => void;
}) => Promise<string | null>;
```

当前链（有序，宽 → 具体）：

1. **全局系统级** `global`：`source` = `ZHIXING_HOME/ZHIXING.md`，`resolvePath` = `join(roots.homeDir, "ZHIXING.md")`。`roots.homeDir` 来自 `getZhixingHome()`，即 `~/.zhixing` 或 `ZHIXING_HOME`，是知行系统工作目录根，与用户个性化无关。任何模式恒适用。
2. **工作场景级** `workscene`：`source` = `workdir/ZHIXING.md`，仅当 `roots.workdir` 存在时 `resolvePath` = `join(roots.workdir, "ZHIXING.md")`，否则返回 null。

`getZhixingHome()` 即"全局文件准确物理位置"这一已定问题的答案。

**3.2 加载与降级**

- `loadLayeredGuidance({ roots, readGuidanceFile, reportWarning })` 按链顺序对每个 `resolvePath` 非 null 的 scope 调 `readGuidanceFile({ scopeRoot, path, reportWarning })`：存在且非空 → 收 `{ scope, source, label, content }` 为一节；文件缺失 / 空 → 跳过该节；读取失败 / 安全降级 → 跳过该节并经通用诊断出口上报。
- `readGuidanceFile({ scopeRoot, path, reportWarning })` 是宿主装配层注入的专用安全读取边界，不放进 `@zhixing/core`。containment 基元必须复用仓库单一事实源 `PathGuard`（realpath 双侧 + 包含式），禁止为 guidance 手搓第二套 realpath/前缀判断；在其上叠加 guidance 专属更严层：`lstat` 先拒绝 symlink / directory / special file，读取目标必须是 regular file，POSIX 可用 `O_NOFOLLOW` 作补强，但不得把它写成 Windows / reparse point 的硬保证，也不承诺拒绝 hardlink。`ENOENT` / `ENOTDIR`（scope root 或目标文件不存在）返回 `null` 且不诊断；目标存在后的 symlink / reparse 越界 / 非普通文件 / 权限等异常一律不注入并诊断上报。工作场景 `workdir` 是潜在不可信输入，此边界不得后置或降级。
- `ZHIXING.md` 全量注入，不做专用 token / 字符上限，不做自动截断。它是用户主动维护的有界约定文件，系统不能静默砍掉用户声明的约定。
- 全部为空 → 服务返回 `null` → 消费者 `contributeMessagePrefix(null)` → 本窗无 guidance prefix。

**3.3 合并规则（回答"合并 / 覆盖"已定问题）**

`ZHIXING.md` 是自由文本约定，非 key-value，无"同名 key 覆盖"语义。取**层叠拼接（cascade）**：所有适用层都注入，**全局在前、场景在后**，同一 `guidance` 块内按 scope 分节：

```text
# 全局约定
scope: global
source: ZHIXING_HOME/ZHIXING.md
<全局 ZHIXING.md 内容>

# 工作场景约定
scope: workscene
source: workdir/ZHIXING.md
<该场景 ZHIXING.md 内容>
```

这是 `loadLayeredGuidance` 返回的裸 payload 示例，不含 `<system-meta>` 外壳。场景节在后 = 更具体、LLM 自然就近优先，符合用户"越具体作用域优先"，也与 `CLAUDE.md`（user + project 皆生效、非替换）层叠语义一致。只渲染实际存在的节：`main` 模式或无 workdir 场景只有全局节。唯一职责链固定为：服务出裸 payload → `zhixing-guidance` 调 `buildGuidanceMessagePair` 包 pair → `contributeMessagePrefix` 贡献 messages。

### 4. 领域消费者 ③ —— ZhixingGuidanceLifecycle

**定位**：`AgentRuntimeLifecycle` 实现，复用 `packages/cli/src/serve/advancement-acceptance-lifecycle.ts` 的工厂与注册范式，但挂 `onWindowOpen` 并通过 `contributeMessagePrefix` 贡献窗口级发送前缀；由宿主装配层注册、随 `RuntimeHost` 共享订阅者集合下发全部会话实例。

```ts
// packages/cli/src/serve/zhixing-guidance-lifecycle.ts
export function createZhixingGuidanceLifecycle(deps: {
  getZhixingHome: () => string;
  getWorkscene: (sceneId: string) => Promise<{ workdir?: string } | null>;
  readGuidanceFile: ReadGuidanceFile;
  loadLayeredGuidance: (input: {
    roots: GuidanceResolvedRoots;
    readGuidanceFile: ReadGuidanceFile;
    reportWarning: (event: GuidanceWarningInput) => void;
  }) => Promise<string | null>;
}): AgentRuntimeLifecycle {
  return {
    id: "zhixing-guidance",
    async onWindowOpen(ctx) {
      ctx.contributeMessagePrefix(null); // 入口先清空，任何异常都不会沿用上一窗 guidance

      if (ctx.runtimeKind === "ephemeral") {
        return;
      }

      const homeDir = deps.getZhixingHome();
      let workdir: string | undefined;
      try {
        if (ctx.mode === "work" && ctx.sceneId) {
          const scene = await deps.getWorkscene(ctx.sceneId);
          const candidate = scene?.workdir;
          if (candidate && path.isAbsolute(candidate)) {
            workdir = candidate;
          } else if (candidate) {
            ctx.reportLifecycleWarning({
              message: "guidance workdir is not absolute; action=use-global-only",
            });
          }
        }
      } catch (error) {
        ctx.reportLifecycleWarning({
          message: `guidance workscene query failed; action=use-global-only; error=${String(error)}`,
        });
        // 场景查询失败只降级为无场景层，仍尝试全局层。
      }

      try {
        const content = await deps.loadLayeredGuidance({
          roots: {
            homeDir,
            ...(workdir ? { workdir } : {}),
          },
          readGuidanceFile: deps.readGuidanceFile,
          reportWarning: ctx.reportLifecycleWarning,
        });
        ctx.contributeMessagePrefix(
          content ? buildGuidanceMessagePair(content) : null,
        ); // null → 本窗无 guidance prefix
      } catch (error) {
        ctx.reportLifecycleWarning({
          message: `guidance load failed; action=empty-guidance; error=${String(error)}`,
        });
        // 保持入口 null，绝不沿用上一窗 prefix。
      }
    },
  };
}
```

- 只挂 `onWindowOpen`（每段一次），不挂 `onBeforeRun`（不做 run 瞬态）。
- `ephemeral` 一次性执行体不生效 guidance；消费者入口先调用 `contributeMessagePrefix(null)`，保证该窗口不沿用任何旧贡献。
- 异常安全定死：`zhixing-guidance` 每窗入口先清空本订阅者贡献；`getWorkscene` 失败只降级为无场景层、仍尝试全局层并上报诊断；`loadLayeredGuidance` 内部按层跳过读失败 / 安全降级并上报诊断；外层意外失败保持 null。任何失败都不得阻断对话，也不得继承上一窗 guidance。
- 领域依赖在装配层收口：`getZhixingHome` 与 `worksceneDirectory.get(sceneId)` 在 lifecycle 内解析成 roots；分层服务只消费 roots、注入式 `readGuidanceFile` 与诊断出口。
- 注册点定死：`packages/cli/src/serve/command.ts:376` 当前 `lifecycle: [createAdvancementAcceptanceLifecycle(...)]` 处追加 `createZhixingGuidanceLifecycle(...)`，依赖从同一 `RuntimeHost` 装配上下文注入。

### 5. 旧 ZHIXING.md 清理（需求前半）

清理动作：

- 删除仓库根 0 字节遗留 `ZHIXING.md`。
- 以全仓清单为唯一工作表逐条处理，不靠举例或人工记忆：

  ```powershell
  rg -n 'ZHIXING\.md|Project Instructions|loadInstructions|injectContext' . -g '!node_modules/**' -g '!dist/**' -g '!**/dist/**' -g '!.git/**'
  ```
- 每一处结果必须分类处理：

  - 活代码：当前不预设仍存在旧 loader；若复扫发现旧的"运行地址 / cwd 项目语义"加载路径，不得保留，迁到本文机制或删除。
  - packages 注释 / prompt 文案：订正为 `<system-meta kind="guidance">` 的窗口级发送前缀机制。
  - research/spec 旧方案：标明过时或改写到本文新机制，删除"用户级个性化"、`<context>` 首条注入、子目录级本期落地等旧表述。
  - 需求原文与本文自身：可保留作为来源记录。
- 收尾同命令复扫；除需求来源与本文外，不应再有旧语义残留。

### 6. 运行边界：持久会话 runtime 与一次性执行体

guidance 只作用于有持久会话身份的 user-facing conversation runtime（main / work）。一次性执行体不自动生效 `ZHIXING.md`：

- Task 派生的 sub-agent 不经本 lifecycle 钩子、无 `onWindowOpen`、无窗口换代，天然不触发本机制。
- `RuntimeHost.createEphemeralRuntime()` 创建的定时任务执行体虽经 `createAgentRuntime` 与统一 lifecycle 下发，但 `runtimeKind === "ephemeral"`，由 `zhixing-guidance` 在 `onWindowOpen` 明确跳过。

一次性执行体需要的背景由调用方 prompt 显式组织，不从 `ZHIXING.md` 自动继承。

### 7. 子目录级扩展余地（不落地，仅防阻断）

作用域链（3.1）天生容纳未来的 `subdir` scope：往链尾追加一个 `resolvePath` 在场景 workdir **之下某子目录**（不与根重合）解析路径的 scope 即可，前面两层与注入机制 ① 完全不动。本次不实现其触发（子目录如何被"进入"）、不实现其合并细则——架构只保证不阻断，符合需求"保留想法、当前不落地"。

### 8. 模块划分与文件落点（可执行清单）

| 层                                 | 文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 动作    | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① 契约                            | `packages/orchestrator/src/runtime/lifecycle.ts` / `packages/core/src/types/agent-events.ts` / `packages/server/src/rpc/session-events.ts`                                                                                                                                                                                                                                                                                                                                                                                            | 改      | `LifecycleContextBase` 加 `runtimeKind` 与通用诊断出口；新增 `lifecycle:warning` 事件与投影；`LifecycleWindowOpenContext.contributeMessagePrefix(messages)` 接收 `MessagePrefixContribution \| null`；`lifecycle:hook_failed` 保持 hook 失败权威语义                                                                                                                                                                                                                                                                             |
| ① server 契约                     | `packages/server/src/runtime/types.ts` / `packages/cli/src/serve/session-adapter.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 改      | `SessionRuntime.checkBudget(messages)` 拆为 `estimateConversationRequestBudget(messages)` / `estimateMessagesTokens(messages)`；新增 `drainLifecycleDiagnostics()`（必要时含 peek）桥接 runtime run 外诊断 ring buffer；adapter 只做机械透传                                                                                                                                                                                                                                                                                        |
| ① 运行时                          | `packages/orchestrator/src/runtime/create-agent-runtime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 改      | `CreateAgentRuntimeOptions.runtimeKind` 默认 conversation；实例级诊断 sink 按 run 内 / run 外构造点注入；校验 lifecycle id 唯一；事务化 prefix 贡献、校验/深拷贝、`onWindowOpen` 接线、run 入口 capture、向 agent-loop 传 `getMessagePrefix`；实例 committed prompt/prefix 原子切换                                                                                                                                                                                                                                                   |
| ① loop                            | `packages/core/src/loop/types.ts` / `agent-loop.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 改      | `AgentLoopParams.getMessagePrefix` 可选且默认空；构造共享发送准备 helper 与唯一 `providerMessages`；请求、calibration、snapshot、段阈值共用该口径；不写 `state.messages`                                                                                                                                                                                                                                                                                                                                                              |
| ① token 会计核心                  | `packages/core/src/context/token-accounting.ts`（新） / `packages/core/src/types/llm.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                | 建 / 改 | 定义并导出 loop-local`TokenAnchor(totalInputTokens)` 与 `computeContextTokens({ estimator, systemPrompt, stateMessages, providerMessages, tools, anchor })`；actual 统一 `getTotalInputTokens(usage)`；修正 `TokenUsage/getTotalInputTokens` 契约；`context` 不依赖 `loop`                                                                                                                                                                                                                                                      |
| ① token 会计 / 阈值 / 摘要 / 事件 | `packages/core/src/loop/turn-end.ts` / `packages/core/src/context/segment/segment-manager.ts` / `packages/core/src/context/segment/types.ts` / `packages/core/src/context/segment/calibration.ts` / `packages/orchestrator/src/runtime/create-agent-runtime.ts` / `packages/server/src/runtime/conversation-manager.ts` / `packages/server/src/perspectives/controller.ts` / `packages/core/src/context/segment/prompts.ts` / `packages/core/src/context/segment/llm-fn.ts` / `packages/core/src/types/agent-events.ts` | 改      | `context:tokens_snapshot`、`ConversationManager.contextBudget` / `session.contextBudget` 统一复用 `computeContextTokens` 且防双算；runtime 侧提供 `estimateConversationRequestBudget(messages)` / `estimateMessagesTokens(messages)`；删除 `RunResult.budget` / `ForceCompactResult.budget`；段阈值用 providerMessages、可摘要 messages 只用 state.messages；loop 层基于既有 `modified/newSegmentMessages` 显式失效 loop-local anchor，`SegmentManagerOutput` 不新增 anchor 字段；摘要请求不含 prefix；摘要校准 estimated / actual 同步升级为 system+messages+tools / `getTotalInputTokens`；修正 cache、agent-loop inputTokens 注释与事件契约 |
| ① 形式                            | `packages/core/src/context/system-meta.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 改      | 加`buildGuidanceMessagePair` 与 `guidance` 专项来源 / 优先级规则；`guidance` 不进 `SystemMetaKind` / detect / strip                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ② 服务                            | `packages/core/src/context/guidance/layered-guidance.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 建      | `GuidanceScope` 链、`loadLayeredGuidance` 裸 payload、scope/source 分节渲染；roots 已解析，I/O 与诊断均经注入                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ③ 消费者                          | `packages/cli/src/serve/zhixing-guidance-lifecycle.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 建      | `createZhixingGuidanceLifecycle`，只挂 `onWindowOpen`，入口清空；校验 workdir 绝对路径；自行 `buildGuidanceMessagePair` 后贡献 messages；ephemeral 跳过                                                                                                                                                                                                                                                                                                                                                                               |
| ③ 装配                            | `packages/cli/src/serve/command.ts:376` / `packages/cli/src/runtime/runtime-host.ts` / `packages/cli/src/serve/read-guidance-file.ts`（新）                                                                                                                                                                                                                                                                                                                                                                                           | 改 / 建 | 注入`worksceneDirectory.get` + `getZhixingHome` + `PathGuard containment + lstat` 安全读取；注册 lifecycle；conversation / ephemeral 显式写入 `runtimeKind`                                                                                                                                                                                                                                                                                                                                                                         |
| 清理                               | 仓库根空`ZHIXING.md` + 仓库根 grep 全量清单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 删 / 改 | 见 §5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

分层放置理由：① 是 target/UI 无关的通用能力，生命周期契约在 orchestrator、LLM-call 发送组装在 core loop、渲染形式在 core system-meta；② 纯上下文逻辑放 core context 域，I/O 由调用方注入；③ 领域装配（持有 `worksceneDirectory`、`getZhixingHome` 等 runtime 依赖）放 cli serve 装配层，与 `advancement-acceptance-lifecycle` 同层同范式。

### 9. 测试策略（按影响面分层）

- **② 单测**：作用域链解析（main 只全局 / work 有 workdir 两层 / work 无 workdir 只全局）、缺文件降级、全空返回 null、层叠拼接顺序与 scope/source 裸分节 payload、文件内容全量注入不截断。
- **③ 读取安全单测**：宿主层 `readGuidanceFile` 覆盖 `PathGuard containment + lstat`：`ENOENT` / `ENOTDIR` 返回 null 且不诊断；symlink / reparse 越界 / 非普通文件 / 权限异常不注入并上报诊断；POSIX `O_NOFOLLOW` 只测为补强，不作为 Windows 语义依赖；不测试 hardlink 拒绝；断言 containment 复用 `PathGuard`，不新建第二套路径判断。
- **① 单测**：
  - `reportLifecycleWarning`：订阅者只提供 message；runtime 自动补 `hookId` / `phase` / `windowIndex` / `runtimeId`；run 内转发 eventBus 并投影，run 外进入有界 ring buffer，`ConversationManager` 在 runtime 创建后、run 外窗口变更 / compact / dispose 后通过 `drainLifecycleDiagnostics()` drain，并用 `sessionBroadcast + createControlSessionEventEnvelope` 投影。
  - 事件语义：hook 抛错 / 非法 prefix contribution 只走 `lifecycle:hook_failed`；订阅者主动软降级只走 `lifecycle:warning`。
  - `MessagePrefixContribution`：只接受纯文本 user/assistant pair、assistant 结束；非法贡献按 `lifecycle:hook_failed` 处理。
  - `onWindowOpen` 三态错误语义：首窗 `instance-start` 抛出 fail-fast；run 外 `clear/resume/compact` collect failure 且本窗 staged 置空不阻断；run 内换窗 emit `lifecycle:hook_failed`、staged 置空、run 继续。
  - 双层 holder 并发：in-flight run 不观测后续窗口换代的新贡献。
  - 实例 committed 视图原子性：run 外 onWindowOpen 期间 budget 查询不能读到旧 `authoritativePrompt` + 半更新 prefix；提交后 prompt/prefix 同步可见。
  - `getMessagePrefix` 每次 LLM-call 现取；窗口内 byte-equal；段切换后重算。
  - `providerMessages` 是请求与 token calibration 的唯一 messages 口径，prefix 与 turn-context 计入 estimated，actual 用 `getTotalInputTokens(usage)` 且不重复加 prefix。
  - 摘要 `segment/calibration.ts` 的 estimated 为摘要请求 system + messages + tools，guard / actual 使用 `getTotalInputTokens(usage)`。
  - `token-accounting.ts` 拥有 `TokenAnchor` 与 `computeContextTokens`；不依赖 `loop/*`，避免未来 context 反向依赖 loop。
  - `computeContextTokens` 是 budget 权威单一口径；anchor 真值路径只从 stateMessages 取 delta、不双算 prefix，fallback 显式使用 providerMessages。
  - prefix 存在但无新增 state message 时，anchor+delta 路径 delta 为空，不因 providerMessages 比 stateMessages 多 prefix 而高估。
  - 段切换后即使 `newSegmentMessages.length >= anchor.baselineMessageCount`，也必须因消息谱系替换而显式失效 anchor，走 fallback，不得 anchor+delta。
  - `context:tokens_snapshot`：fallback 估算含 providerMessages 与 turn-context；`anchor.totalInputTokens + delta` 真值路径不双算 prefix；段切换后先 `windowLifecycle.onChange` 再 snapshot，且 snapshot 通过 `prepareSendView` 现取新 systemPrompt / messagePrefix / turn-context；本 turn 发生谱系替换时 snapshot 使用 `anchor: undefined`。
  - `SegmentManager.evaluate` 阈值按 `systemPrompt` 同口径计入 providerMessages 固定成本，但 split / summary 输入不含 prefix / turn-context。
  - `tokensBefore` / `tokensAfter` / `windowCompact` 是转移指标，不被当作下一次 provider 请求总量；测试不要求 before / after 与 budget 同口径。
  - `ConversationManager.contextBudget` / `session.contextBudget` 均反映下一次 provider 请求总量，含当前窗口 prefix 固定成本，不模拟 turn-context；runtime 侧只测 `estimateConversationRequestBudget(messages)` / `estimateMessagesTokens(messages)` 两个 helper，请求总量 helper 只把 messages 当纯入参、不缓存窗口状态，并与 `computeContextTokens` 同底层估算口径；无 active run 时 run 外 budget 含 instance committed prefix 固定成本、不含 turn-context；`assembleMessagePrefix` 被 run 内 local 与 run 外 committed 两条路径共用；`snapshotAttentionWindowV1` / perspectives 改用 message-only estimator；`SessionRuntime` / `session-adapter` 不再暴露旧 `checkBudget(messages)`。
  - `RunResult` / `ForceCompactResult` 均无 `budget` 字段；旧测试断言删除，手动压缩后的最终容量只通过 `applyCompact → onAttentionWindowChange → ConversationManager.contextBudget/session.contextBudget` 获取。
  - `SegmentSummarizeRequest.messages` 不含 guidancePrefix，只含可摘要事实链 + 末尾压缩指令。
  - `TokenAnchor.baselineMessageCount` 保持 `state.messages.length`，`anchor.totalInputTokens` 含 prefix / turn-context 固定成本，注释与测试不再假设实发 messages 与 state messages 等长；不新增第二 baseline / hash；换段后显式失效并在下一次成功 LLM call 重建，重建后含新 prefix；turn-context 变化不引入 hash。
  - lifecycle id 重复时装配 fail-fast；直接 `createAgentRuntime({})` 的 `runtimeKind` 默认为 conversation，RuntimeHost ephemeral 为 ephemeral。
  - `agent-events.ts` 契约更新：`context:tokens_snapshot.totalTokens` 是含 prefix 的下一次发送总量；`llm:request_start.messages` 是实发 providerMessages。
  - capability 校验不因纯文本 messagePrefix 改变行为。
  - `state.messages`、SegmentManager 可摘要 `messages` 输入均不含 guidancePrefix / turn-context。
  - `buildRunRecord` / `AttentionWindow.acceptRun` 不含 guidancePrefix。
  - `guidance` 不进 `SystemMetaKind` / detect / strip；system prompt 含 guidance 来源 / 优先级规则。
- **③ 集成**：`onWindowOpen` → 贡献 → provider 请求 messages 前缀出现 `<system-meta kind="guidance">`；段切换后重注；子 agent 与 ephemeral runtime 请求不出现 guidance；上一窗有 guidance 时，新窗 `getWorkscene` 失败仍注入全局层、非绝对 workdir 降级为全局层、`loadLayeredGuidance` 失败则为空，均不继承上一窗 prefix；诊断 warning 的 message 说明 scope / path / error / 降级结果，runtime 补齐 hook 归属。
- **回归护栏**：窗口持久化契约确认 prefix 不落盘、不进 `AttentionWindow`、不进 compact summary / 持久化派生 snapshot；段压缩 summary / 持久化派生 snapshot 不含 guidance 文件内容；`context:tokens_snapshot` 数字事件含 prefix 成本。
- 中间轮 `tsc` + 定向单测；收尾一次全量 + `pnpm build`（① 动到 core/orchestrator 上游包，消费侧构建依赖 dist，勿并行）。

### 10. 已定问题的最终答复

- **全局文件物理位置**：`getZhixingHome()` 根下，即 `~/.zhixing/ZHIXING.md`（或 `ZHIXING_HOME/ZHIXING.md`）。
- **全局 / 场景合并规则**：层叠拼接，全局在前、场景在后，同一 `guidance` 块内分节，只渲染存在的层（§3.3）。
- **标签形式与命名**：复用 `<system-meta>` 单一事实源，新增 `kind="guidance"`（§2.4）。
- **当前版本作用域**：只落地全局系统级与工作场景级；子目录级仅保留扩展余地，不设计触发 / 加载 / 合并规则。

### 11. 最终执行计划

拆分标准：先枚举架构不变量，提交边界不得切开任何不变量；一次提交必须形成可独立理解、构建、测试、回滚的终态子集，可以缺能力但不得存在半升级语义或需要靠后续提交修复的中间债务。

本模块提交边界必须守住以下不变量：

- guidance prefix 只属于发送视图，不进入 `state.messages`、窗口事实链、run record、段摘要、持久化派生 snapshot。
- 发送视图、token 会计、budget、calibration 共用同一口径：`systemPrompt + providerMessages + tools`，可摘要历史量只认 `state.messages`。
- lifecycle/messagePrefix 是通用地基，runtime 零 `ZHIXING.md` 知识；`ZHIXING.md` 只在消费者层转成 `Message[]` 贡献。
- prefix holder 事务化、深拷贝、按 lifecycle 顺序拼接；run 内 local 与 run 外 committed 两条路径复用同一拼接函数，实例 committed prompt/prefix 原子切换。
- guidance 读取安全边界在宿主层完成，复用 `PathGuard containment + lstat`，物理路径只进诊断不进发送内容。
- `ZHIXING.md` 只作用于 user-facing conversation runtime；sub-agent / ephemeral 一次性执行体不自动继承。

| 提交 | 边界 | 目标 | 验收 |
| ---- | ---- | ---- | ---- |
| 1 | core token 会计与 system-meta 原语 | 新建 `token-accounting.ts`，下沉 loop-local `TokenAnchor(totalInputTokens)`，统一 `computeContextTokens` 与 `getTotalInputTokens` actual 口径；`system-meta.ts` 新增 `buildGuidanceMessagePair` 与 guidance 来源 / 优先级规则 | core 单测覆盖 `getTotalInputTokens`、anchor+delta / fallback、防 prefix 双算；`guidance` 不进 `SystemMetaKind` / detect / strip |
| 2 | lifecycle 与事件契约 | `lifecycle.ts` 增 `runtimeKind`、诊断出口、`MessagePrefixContribution` 与 `contributeMessagePrefix(Message[] \| null)`；`agent-events.ts` / `session-events.ts` 增 `lifecycle:warning`，保留 `lifecycle:hook_failed` 为 hook 失败权威通道；server runtime 契约预留 diagnostics drain | 类型与事件投影单测覆盖 warning payload 归属由 runtime 补齐；hook 抛错 / 非法贡献只走 `hook_failed`，主动软降级只走 `warning` |
| 3 | core loop 发送视图与段会计闭环 | `agent-loop.ts` 建共享发送准备 helper 与唯一 `providerMessages`；`turn-end.ts` / `segment-manager.ts` / `segment/calibration.ts` 接入 providerMessages 阈值、snapshot、摘要 calibration；段切换由 loop 层基于 `modified/newSegmentMessages` 显式失效 anchor，`SegmentManagerOutput` 不引入 anchor 概念 | core 单测覆盖请求/calibration/snapshot 同源 providerMessages、摘要请求不含 prefix、段切换长度未变也失效 anchor、`state.messages` 与可摘要输入不含 prefix / turn-context |
| 4 | runtime prefix holder、run 外 budget 与诊断桥 | `create-agent-runtime.ts` 实现 runtimeKind 默认值、lifecycle id 唯一校验、prefix 贡献事务化 / 深拷贝、local/committed holder、`assembleMessagePrefix`、committed prompt/prefix 原子切换、诊断 ring buffer；删除 `RunResult.budget` / `ForceCompactResult.budget` | orchestrator 单测覆盖首窗 fail-fast、run 外 collect、run 内 emit、holder 并发隔离、committed 视图原子性、run 外 diagnostics drain、两个 budget 字段无残留 |
| 5 | server budget 接口语义分离 | `SessionRuntime.checkBudget(messages)` 拆为 `estimateConversationRequestBudget(messages)` / `estimateMessagesTokens(messages)`；`ConversationManager.contextBudget` / `session.contextBudget` 只由 owner 传窗口 messages，runtime 私有构造 committed request view；snapshot / perspectives 改用 message-only estimator | server / runtime 测试覆盖请求总量含 systemPrompt / committed prefix / tools、不含 turn-context，runtime 不缓存传入 messages；message-only estimator 不重复计入固定成本 |
| 6 | guidance 纯服务与宿主安全读取 | `layered-guidance.ts` 实现全局 / 工作场景层叠、scope/source 裸 payload；`read-guidance-file.ts` 在宿主层复用 `PathGuard containment + lstat`，区分缺文件与安全降级 | 单测覆盖层叠顺序、空文件 / 缺文件降级、全量注入不截断、物理路径不进 payload；安全测试覆盖 symlink / reparse 越界 / 非普通文件 / 权限异常诊断，`ENOENT/ENOTDIR` 不诊断 |
| 7 | guidance lifecycle 消费者与 runtime host 装配 | 新建 `zhixing-guidance-lifecycle.ts`，入口先清空、ephemeral 跳过、场景查询失败保全局、加载成功后自行 `buildGuidanceMessagePair` 并贡献 messages；`runtime-host.ts` / `command.ts` 注入 `runtimeKind`、`worksceneDirectory.get`、`getZhixingHome`、安全读取并注册 lifecycle | 集成测试覆盖 main/work 注入、段切换重注、sub-agent / ephemeral 不注入、异常不沿用旧 prefix、诊断含 scope/path/error/降级结果 |
| 8 | 旧语义清理与公开契约收口 | 删除仓库根 0 字节 `ZHIXING.md`；按 §5 从仓库根全量复扫并清理旧 `ZHIXING.md` / `Project Instructions` / cache 注释 / 事件契约表述；同步测试与文档引用 | `rg` 复扫除需求来源与本文外无旧语义残留；公开事件契约明确 `context:tokens_snapshot.totalTokens` 与 `llm:request_start.messages` 新语义 |
| 9 | 全量验收 | 跑核心、orchestrator、server、cli 相关定向测试；最后执行 `pnpm build` 全量重建 | 全量构建通过；关键回归护栏成立：prefix 不落盘、不进摘要、不进窗口事实链，budget/snapshot 反映 prefix 成本 |

执行顺序不可重排为会产生中间债务的形态：提交 3 不得在提交 1 的 token 会计原语之前落地；提交 4/5 必须共同保持 runtime / server budget 接口可构建；提交 7 不得早于提交 4 的通用 lifecycle/messagePrefix 地基；提交 8 必须在新机制可运行后执行，避免先删旧引用却没有新路径承接。
