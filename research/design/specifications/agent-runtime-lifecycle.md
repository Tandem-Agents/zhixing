# 主对话运行体生命周期钩子 (Agent Runtime Lifecycle Hooks)

> **状态**: 📐 方案设计（待实施）
>
> **定位**: 为 main / work 两类 user-facing 主对话 runtime 实例提供**四阶段生命周期钩子**——**注意力窗口开启 / 每次 run 前 / 每次 run 后 / 注意力窗口结束**。统一"在生命周期边界做注册式介入"的接入点，把散落在装配期、段切换、`/compact`、`/clear`、`/resume`、实例销毁处的各类"边界动作"收敛到同一抽象。首个内置消费者是 skill 索引的**注意力窗口边界重建**（承接 [skill-system.md](./skill-system.md) §3.2 预留、§3.3 描述的 `systemPrompt` 可重建插座）。
>
> **绑定单位分两层（与 [lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §一一致）**：外层钩子（onWindowOpen / onWindowClose）绑**注意力窗口**，内层钩子（onBeforeRun / onAfterRun）绑 **run**。订阅者**集合**在 runtime 实例装配期注入、实例内恒定（注册单位是实例，触发单位是窗口 / run）。
>
> **关联**:
> - [lifecycle-concepts.md](../drafts/lifecycle-concepts.md) — **生命周期概念的单一权威**：注意力窗口 ⊃ run ⊃ turn；§二四钩子需求。**本 spec 与之冲突一律以它为准。**
> - [context-management-v3-redesign.md](./context-management-v3-redesign.md) — 注意力窗口、段切换 / 压缩只动 messages、段内 system prompt+tools byte-equal（本 spec 的 cache 边界与之协同）
> - [skill-system.md](./skill-system.md) — §3 索引进 system prompt 稳定区、§3.2 预留 / §3.3 `systemPrompt` 可重建插座（首个消费者），§3.1 死线本意（窗口内不变、跨窗口可重建）
> - [runtime-session-hot-reload.md](./runtime-session-hot-reload.md) — runtime 不可变契约 + reload blue-green swap（实例换代的权威）
> - [work-mode.md](./work-mode.md) — main↔work 切换、power runtime overlay、turn 边界原子事务
> - [prompt-system.md](./prompt-system.md) — system prompt 静态 / 动态分区 + `__ZHIXING_CACHE_BOUNDARY__`
> - [subagent-execution.md](./subagent-execution.md) — sub-agent 生命周期归属 Task 工具内部（本 spec 明确排除）

---

## 一、问题与定位

知行的可观测性已有一等公民 EventBus（`AgentEventMap`），但它是 **per-run、纯观测** 的：订阅者只能看、不能改流程，且事件绑在单次 `run()` 上，run 结束 bus 即 GC（`create-agent-runtime.ts:861` 每 run 新建 `eventBus`，`:966/:1022` 装饰与 dispose）。

真实需求里反复出现另一类诉求——**在生命周期边界上做可介入的注册式动作**，正是 [lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §二钉死的四个：

- **①注意力窗口开启**（首窗 / 段切换·压缩·clear·resume 后的新窗）——为新窗口准备 / 重建上下文。**skill 索引随用户 / 接入变化，需在新窗边界把最新索引刷进 system prompt 稳定区**（[skill-system.md](./skill-system.md) §3.2/§3.3）；
- **②run 开启**（一条用户消息）——在该消息发送前注入内容、做异步副作用；
- **③run 结束**（多轮 LLM 全部干完）——发现并总结经验、收尾、记录；
- **④注意力窗口结束**（段切换·压缩·clear·resume 前的旧窗终结、或实例销毁的末窗）——收尾 / 最终 flush（基准 §二：暂无内置用途、先预留接入点；实例销毁的资源收尾是首个落点）。

共同点：**绑在注意力窗口 / run 的生命周期边界上，其中①需要重建即将发送的 system prompt**。现状没有这样的抽象——skill 索引硬编码在装配期（`create-agent-runtime.ts:677` 只装配一次），实例销毁时 runtime 直接失 ref GC（§四④），注意力窗口边界（段切换 / 压缩）只在 core 内改 messages、无对外注册式介入点。

本 spec 定义这套抽象：**Agent Runtime Lifecycle**。它不替代 EventBus（观测仍走 EventBus），而是补齐"生命周期边界、注册式"的介入：订阅者做观测、异步副作用、以及**在合适时机更新上下文**。其意义是把原本硬编码（如 skill 索引只在装配期构造一次）的上下文构建，变成**在生命周期边界暴露的公共介入接口**——onWindowOpen 把"更新 system prompt 段"的能力作为公共接口暴露出来（§3.2、§五），任何订阅者按需调用、用不用与改什么由需求决定；skill 索引重建只是首个消费者。接口形态上只收"段内容"不收"整串"（外部算不出正确整串、拼装归独占段输入的 runtime），这是形态约束、不是把能力私有化。

### 现状缺口一览

| 钩子阶段 | 最接近的现状 | 缺口 |
|---|---|---|
| ① 注意力窗口开启 | 首窗=`createAgentRuntime` 装配（`:677` skill 索引一次性） | 无"窗口开启"注册点；段切换 / 压缩后的新窗在 core 内静默发生，无法重建 system prompt（system prompt 被 agent-loop 在 run 内锁死，`agent-loop.ts:88`） |
| ② 每次 run 前 | `agent:run_start` 事件 | emit 在 agent-loop 内、纯观测，不能在发送前介入 |
| ③ 每次 run 后 | `agent:run_end` / `run()` 的 `finally`（`:1021`） | 纯观测；无注册式、带 `RunResult` 的收尾点 |
| ④ 注意力窗口结束 | 段切换 / 压缩在 turn 边界（`turn-end.ts`）、`/clear`=`resetConversationState`；实例销毁=**无** | 段 / 压缩边界无对外注册点；`AgentRuntime` 接口无 dispose（`:178`），实例销毁四处路径均无挂点 |

---

## 二、概念边界（术语钉死）

钩子的触发单位容易和既有概念混淆，先钉死。知行里有**六个不同层级**：

| 术语 | 是什么 | 边界 | 代码 |
|---|---|---|---|
| **RuntimeSession** | 进程 / 连接级资源容器，聚合 main runtime + scheduler + channels + delivery | `create()`→`dispose()` | `cli/runtime/session.ts:84` |
| **运行体**（agent runtime instance） | 一个 user-facing 主对话 `AgentRuntime` 实例。**钩子订阅者集合的注册单位** | 实例建立→实例销毁 | `orchestrator` `AgentRuntime`（`create-agent-runtime.ts:178`） |
| **conversation** | 数据层对话记录（id / transcript / scope） | 独立持久化 | `conversation-model.md` |
| **注意力窗口**（attention window / 段） | 喂给 LLM 的上下文视图——物理层的瞬态派生投影，按模型优质注意力尺寸维护。**onWindowOpen/onWindowClose 的触发单位** | 首窗(编排启动倒读重建)→每次上下文重构(段切换/compact/clear/resume)新生；窗口内 system prompt+tools+历史对话列表 byte-equal | [lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §一；段载体 `core` SegmentManager |
| **run** | 一次 `runtime.run()`=一条用户消息完整往返。**onBeforeRun/onAfterRun 的触发单位** | run_start→run_end | `create-agent-runtime.ts:855` |
| **turn** | agent-loop 内一次 LLM call（+工具执行） | turn 边界 | `core` agent-loop |

**关键嵌套与交错关系**（决定钩子设计）：

- **注意力窗口 ⊃ run ⊃ turn**，但窗口与 run 是**交错而非严格嵌套**：段切换 / 压缩在 turn 边界（run 内）发生，所以一个 run 可横跨窗口边界——一个窗口通常含多个完整 run，但某个 run 可能起于旧窗、止于新窗。这是 onWindowOpen/onWindowClose 必须能在 run 内触发的根本原因。
- **运行体实例 ⊃ 注意力窗口**：一个 main 实例贯穿整个 session，内部开闭多个注意力窗口（每次段切换 / 压缩各一个）。"实例建立 / 销毁"≠"注意力窗口开启 / 结束"——实例建立时开**首个**窗口、实例销毁时关**末个**窗口，是窗口生命周期的两个特例，不是独立阶段。

**关键澄清**：

- **注册单位 = 运行体实例**（订阅者集合装配期注入、实例内恒定，§3.3）；**触发单位 = 注意力窗口（①④）/ run（②③）**。订阅者活在实例的整个生命周期，但被框架在窗口 / run 边界反复调用。
- **main 运行体**：bootstrap 建立（`session.ts:158`），进 work **不销毁**（`enterWorkMode` 只加 power overlay + 切 broker，`agentRuntime` 原封不动，`session.ts:535-548`；`get runtime()` 用 `workScene?.runtime ?? agentRuntime` 路由，`:391`），直到 `dispose()` 才结束。main 的注意力窗口序列贯穿整个 session。
- **work 运行体**：每次 `enterWorkMode` 新建（`session.ts:540`），`exitWorkMode` 丢弃（`:558`），各有独立的注意力窗口序列。

---

## 三、核心抽象

### 3.1 接口

```typescript
/**
 * 主对话运行体生命周期钩子。订阅者集合在装配期注入一个运行体实例、实例内恒定；
 * 框架在该实例的注意力窗口边界（①④）与 run 边界（②③）按注册顺序调用。
 * 所有钩子可选、可 async。
 */
interface AgentRuntimeLifecycle {
  /** 订阅者标识 —— 日志、错误归属、可观测事件。全局唯一。 */
  readonly id: string;

  /** ① 注意力窗口开启：首窗（实例装配）或窗口换代后（段切换/compact/clear/resume）新窗诞生时调。
   *  ctx 暴露公共的"更新 system prompt 数据驱动段"接口（§3.2），任何订阅者按需用——这是 cache 安全的窗口级上下文更新点（见 §五）。 */
  onWindowOpen?(ctx: LifecycleWindowOpenContext): Promise<void> | void;

  /** ② 每次 run 前：run() 入口、agent-loop 启动前调。观测即将发送的 messages + 异步副作用。 */
  onBeforeRun?(ctx: LifecycleBeforeRunContext): Promise<void> | void;

  /** ③ 每次 run 后：run() 产出 RunResult 后调。观测 + 状态更新（本轮已结束）。 */
  onAfterRun?(ctx: LifecycleAfterRunContext): Promise<void> | void;

  /** ④ 注意力窗口结束：旧窗终结（段切换/compact/clear/resume 前）或实例销毁（末窗）时调。收尾 / flush。 */
  onWindowClose?(ctx: LifecycleWindowCloseContext): Promise<void> | void;
}
```

### 3.2 上下文对象

公共字段（所有 ctx 都有）：

```typescript
interface LifecycleContextBase {
  readonly runtimeId: string;        // 运行体实例唯一 id（装配期生成）
  readonly mode: "main" | "work";
  readonly sceneId?: string;          // work 运行体的工作场景 id
  readonly providerId: string;
  readonly model: string;
}
```

各阶段独有：

```typescript
/** 运行时可在窗口边界更新的"数据驱动段"——内容由 runtime 内可变数据源驱动、需随窗口边界刷新。
 *  第一版只有 skill-index；新增数据驱动段时在此扩枚举。profile 驱动段（identity / principles /
 *  style / safety 等）变化单位是 reload、不属此类，故不在此枚举、也无法经下方接口运行时覆盖。 */
type DataDrivenSegment = "skill-index";

interface LifecycleWindowOpenContext extends LifecycleContextBase {
  /** 窗口开启原因，供订阅者差异化处理 */
  readonly reason:
    | "instance-start"      // 首窗：实例装配
    | "segment-transition"  // 段切换产生新窗（runTurnBegin 或 runTurnEnd 触发）
    | "compact"             // 压缩产生新窗（pre-flight 或 runTurnEnd 触发）
    | "clear"               // /clear 清空后新窗
    | "resume";             // /resume 换对话后新窗
  readonly windowIndex: number;       // 本实例内第几个窗口（从 0）
  /**
   * 公共接口：在本注意力窗口边界更新 system prompt 的一个数据驱动段（如 "skill-index"）。任何订阅者
   * 按需调用、贡献自己负责的段内容（传 null 清空该段）；不调则该段不变。runtime 把贡献记入本窗的段
   * 覆盖视图，本窗 onWindowOpen 全部跑完后据此重新拼装、自管 byte-equal（§五.3）。
   *
   * 形态约束（非私有化）：只收"段内容"、不收"整串"——外部订阅者没有 buildSystemPrompt 的全部段输入、
   * 算不出正确整串，拼装归 runtime（与 TurnContextInjector「贡献段、拼装归 runtime」同构）。段参数用
   * DataDrivenSegment 子类型把 Inv-8 的语义边界钉在类型层——profile 驱动段不可经此覆盖。
   */
  updateSystemPromptSegment(segment: DataDrivenSegment, content: string | null): void;
}

interface LifecycleBeforeRunContext extends LifecycleContextBase {
  readonly conversationId?: string;
  readonly turnIndex: number;
  readonly messages: readonly Message[];   // 本次 run 输入（只读，enrich 前）
}

interface LifecycleAfterRunContext extends LifecycleContextBase {
  readonly conversationId?: string;
  readonly turnIndex: number;
  readonly result: Readonly<RunResult>;
}

interface LifecycleWindowCloseContext extends LifecycleContextBase {
  /** 窗口结束原因 */
  readonly reason:
    // —— 窗口换代（实例存活，旧窗终结、紧接新窗）——
    | "segment-transition"
    | "compact"
    | "clear"
    | "resume"
    // —— 实例销毁（末窗收尾，实例退场）——
    | "session-dispose"     // RuntimeSession 整体销毁（cli dispose / serve 会话驱逐）
    | "workmode-exit"       // exitWorkMode 丢弃 work 运行体
    | "reload-replace"      // reload 换代、退役旧实例
    | "assembly-rollback";  // 装配事务回滚、实例从未上位（§四④）
  readonly windowIndex: number;
}
```

**onWindowOpen↔onWindowClose 配对**：首窗只有 open（实例诞生时没有"前一个窗口"要关）；末窗的 close 由实例销毁触发（之后无新窗 open）；中间每次窗口换代是「旧窗 onWindowClose(换代类 reason) → 新窗 onWindowOpen(换代类 reason)」成对。一个实例内 open 数（1 首窗 + N 换代）与 close 数（N 换代 + 1 末窗）相等。

### 3.3 注册：装配期注入

`AgentRuntime` 已有"注册式生命周期参与"范式——`registerTurnContextProvider`（`:213`）、`registerConversationStateReset`（`:223`）。本钩子沿用同风格，**只走装配期注入**：

```typescript
interface CreateAgentRuntimeOptions {
  // ...既有字段
  lifecycle?: readonly AgentRuntimeLifecycle[];
}
```

理由：onWindowOpen 的首窗（`reason:"instance-start"`）在装配期触发，运行时后注册会错过、语义残缺。装配期注入让订阅集合在实例生命周期内恒定（Inv-10）。第一版不做运行时 `registerLifecycle`（YAGNI）。

调用顺序：每个边界按注册顺序 sequential `await`（与 `SegmentTransitionHook` 顺序契约一致，`segment-manager.ts:413` `runHooksCatch` 按注册序逐个 await）。四个边界一律 forward、不镜像逆序——订阅者各自经 closure 持有材料、彼此不读（§九），无 LIFO 读窗口需求、也无构造对称逆序需求。

---

## 四、四个挂点的物理位置

注意力窗口边界（①④）的触发分**实例级**与 **run 内**两类，对应 §五.3 的双层 holder：实例级换代更新「实例权威 prompt」、run 内换代只更新「本 run 局部 prompt」。

### ① onWindowOpen —— 注意力窗口开启

**触发点**（对应 `reason`）：

1. **首窗（`instance-start`，实例级）**：`createAgentRuntime`（`:452`）在所有资源装配完、固定段输入就绪后、return 对象字面量（`:747`）之前——strategies 数组结束（`:745-746`）与 `:747` return 之间，按序 `await lifecycle[].onWindowOpen({reason:"instance-start", windowIndex:0})`，再据收集到的段覆盖首次 `buildSystemPrompt` 建**实例权威 prompt**（§五.3）。`createAgentRuntime` 为 `async`，此处 `await` 合法。**注意布局**：`run` 等方法体（`:855-1233`）写在该 return 字面量**之内**，return 非文件线性末尾，勿插错。
2. **run 内换代（`segment-transition` / `compact`，run 级）**：agent-loop / run 内**三条 messages 重构出口**都是注意力窗口换代，均须触发 onWindowClose(旧窗)→onWindowOpen(新窗)、并重拼**本 run 局部 prompt**：
   - **runTurnBegin 段切换**（`agent-loop.ts:237-248`，while 循环外、首个 `streamLLMCall` 之前）——恢复超大持久对话 / 超大首输入时在首个 LLM call 前即切段（`turn-end.ts` `runTurnBegin`→`segmentManager.evaluate`，reason=`segment-transition`）；
   - **pre-flight 压缩**（`create-agent-runtime.ts` run() 内、`runAgentLoop` 之前的 `resolveContextManager("pre-flight")`，reason=`compact`）；
   - **runTurnEnd**（`turn-end.ts`，turn 结束的段切换 `segment-transition` / budget 压缩 `compact`，文本路径 `agent-loop.ts:431` 与工具路径 `:537` 两条）。

   这三条经统一信号驱动（§五.3 第2步：返回值携带 `windowChange`），agent-loop / run 在**该重构改完 messages 后、下一个 LLM call 之前** `await windowLifecycle.onChange(reason)`。orchestrator 通过装配期注入的 `windowLifecycle` 回调（与 `turnContextInjector` 同范式）持有 lifecycle 订阅者集合并按序触发。
3. **run 外换代（`clear` / `resume`，实例级）**：`/clear`（cli `resetConversationState` 路径）、`/resume`（换对话）在 run 之间发生。cli 在这两条路径上调 `runtime.onAttentionWindowChange(reason)`（§十二 C 新增的薄方法）触发窗口钩子、更新实例权威 prompt。

**run 入口的窗口延续 vs 换代**：run() 入口 capture 实例权威 prompt 的当前值作为**本 run 局部 prompt**（§五.3）——窗口跨多 run 时若实例权威未变则本 run 取到同值（byte-equal、cache 跨 run 命中），不触发重建；上个 run 末轮切段 / run 外 clear/resume 已更新实例权威时，本 run 自然 capture 到新值。故 run 入口本身不发 onWindowOpen，只做快照；新窗的 onWindowOpen 在其真实换代点（上述三类）触发。

**能力**：为新窗口做准备。ctx 暴露**公共** `updateSystemPromptSegment` 接口（§3.2）——任何订阅者按需贡献自己负责的数据驱动段，runtime 收集后拼装（§五.3）。首个消费者=skill 索引重建（贡献 `skill-index` 段，§九）。

**失败语义**：首窗（`instance-start`）抛错 → **让 `createAgentRuntime` 失败**（实例未就绪、安全回滚，对齐 work-mode `session.ts:529`）。其余 reason（run 内 / 外换代）抛错 → 不阻断主对话：run 内走 per-run bus emit `lifecycle:hook_failed`、run 外走命令调用方通道（§十一），继续用当前 prompt 跑（窗口换代失败=该窗 skill 索引陈旧，不致命）。

### ② onBeforeRun —— 每次 run 前

**时机**：`run()`（`:855`）内，per-run `eventBus` 创建（`:861`）**且 `decorateRunBus` 渲染装饰挂载（`:966`）之后**、ALS try 块（`:1010`）之前的区间——运行在 `runContextStorage.run` 的 ALS **之外**（与 onAfterRun 同侧），早于 `enrichContext`（`:1029`，在 `:1017` ALS 闭包内）。**务必置于 `:966` 之后**（否则其 emit 的 `lifecycle:*` 事件无渲染订阅、静默丢失，§十一），**不要落进 `:1017` 闭包**。钩子看到的 `messages` 是用户原始输入（enrich 前）。

**能力**：观测即将发送的 `messages` + 异步副作用（预热、记录、外部通知）。**不重建 system prompt**——run 前不是注意力窗口边界（窗口跨多 run），run 入口重建会违反窗口内 byte-equal（Inv-2）。system prompt 的窗口边界重建走 onWindowOpen。

**失败语义**：抛错不阻断 run → emit `lifecycle:hook_failed` 到 per-run bus，继续。

### ③ onAfterRun —— 每次 run 后

**时机**：`run()` 内 `runContextStorage.run(...)`（`:1011`）返回后（ALS 外）、`finally` disposeAll（`:1022`）之前。现状 `return await runContextStorage.run(...)` 无"返回后"落点，**需拆为** `const result = await runContextStorage.run(...)` → 每个 `await lifecycle[].onAfterRun(result)`（各自 try/catch 包裹防穿透）→ `return result`（`finally` 仍 disposeAll）。

**能力**：观测完整 `RunResult` + 订阅者状态更新（本轮已结束，**不影响本轮**）。conversationId / turnIndex 由 ctx 显式提供（ALS 外，不依赖 ALS）。

**配对语义**：onAfterRun 在 `runContextStorage.run` 正常返回后触发。若 `run()` 自身抛错（provider SDK 未捕获 / engine 异常 / turn-end 钩子 re-throw），onAfterRun **不触发**——onBeforeRun→onAfterRun **非强配对**。订阅者**不得依赖"onBeforeRun 分配、onAfterRun 释放"对称**，需释放的资源放 onWindowClose(末窗) 或自身幂等。

**失败语义**：抛错 → emit `lifecycle:hook_failed` + 不影响 `RunResult` 返回。

### ④ onWindowClose —— 注意力窗口结束

两类触发，物理位置不同：

**(A) 窗口换代（实例存活）**：`segment-transition` / `compact` 与 onWindowOpen 同点（§四①.2 的三条 run 内重构出口，由 `windowLifecycle.onChange` 在重构后触发，旧窗 close 先于新窗 open）；`clear` / `resume` 由 cli 命令路径触发（§四①.3）。第一版无内置消费者（基准 §二：先预留），空列表零成本。

**(B) 实例销毁（末窗收尾）—— 需新增 dispose 挂点**。这是唯一**当前完全没有物理挂点**的场景。`AgentRuntime` 接口无 dispose（`:178`），四处常规销毁路径都无 runtime dispose：

- `RuntimeSession.dispose()`（`session.ts:827`）："agentRuntime 无 dispose 接口——内部全 in-memory，replace ref 后自然 GC"（`:866`）
- `exitWorkMode()`（`session.ts:555`）：`this.workScene = undefined`，无 dispose（`:558`）
- reload 换 agent（`session.ts:651/656` swap 旧 ref）："旧 agentRuntime 无 dispose 接口——失去 ref 后自然 GC"（`:820`）；且 reload 的 `old`（`:639-647`）**根本不含 agentRuntime**、`disposeOldInBackground`（`:789-821`）只碰 scheduler/delivery/channels——**旧 main runtime 在 reload 时无任何 dispose 路径**
- **serve `SessionRuntime.dispose()`**（`serve/session-adapter.ts:176`）：只清 `messages`、不透传底层 `agentRuntime`（其闭包持有 `agentRuntime`，`session-adapter.ts:47`，故可透传）；serve 每会话经 `createAgentRuntime` 建 main runtime、首窗 onWindowOpen 触发，由 server `ConversationManager` 驱逐 / idle 时销毁

**要动的代码**：

1. **`AgentRuntime` 接口新增 `dispose(reason): Promise<void>`**（`:178`），`reason`（销毁类四态，§3.2）透传 `LifecycleWindowCloseContext.reason`。内部按序 `await lifecycle[].onWindowClose`，幂等（重复调第二次起 no-op，reason 取首次）。这是纯钩子触发点——runtime 内部本就无需释放的资源（in-memory），dispose 的存在意义就是承载末窗 onWindowClose。
   - **与 [runtime-session-hot-reload.md](./runtime-session-hot-reload.md) 的关系（两 spec 一致）**：hot-reload §一「runtime 不可变契约」约束的是 **reload 路径**（reload 一律 create new + replace ref + dispose old、绝不原地改字段热替换配置），**不**意味着 runtime 无任何可变状态。本 spec 引入的实例级**受控可变状态**——① `dispose` 钩子触发点；② §五.3 的「实例权威 prompt + 段覆盖」（窗口边界重建缓存）——只服务**同一实例内**的演化、不改变 reload 的 blue-green 换代语义。
2. **四处销毁路径接 `dispose(reason)`**：
   - `RuntimeSession.dispose()`：若 `workScene` 存在先 `await workScene.runtime.dispose("session-dispose")`、**再置 `workScene = undefined`**（现状 `:832` 第一步即置空，须后移到 dispose 之后，否则 onWindowClose 拿不到实例），最后 `await agentRuntime.dispose("session-dispose")`。
   - `exitWorkMode()`：置 undefined 前 `await workScene.runtime.dispose("workmode-exit")`。
   - **reload 换 agent**：在 agent 域 swap 处（`session.ts:651` 换 `agentRuntime`、`:656` 换 `powerRuntime`）、swap 前对**旧实例**直接 `await dispose("reload-replace")`。**不可搭 `disposeOldInBackground` 便车**——`old` 不含 agentRuntime、且其派发受 `:673` channels 守卫门控、agent-only reload（最常见，`diff.ts` agentChanged 独立于 channelsChanged）下根本不执行。
     - **装配回滚补 dispose**（Inv-4②）：`buildNewResources` 在新 main `createAgent` 成功（首窗 onWindowOpen 已触发）后、若兄弟步骤抛错（如 work 下重建 power 时 scene 已不存在，`:745`）进入回滚 `catch`（`:765`），须对已激活的新实例补 `await dispose("assembly-rollback")`，替换注释「无 dispose、孤立 GC」（`:776`），否则其末窗 onWindowClose 永不触发。
   - **serve `SessionRuntime.dispose()`**（`serve/session-adapter.ts:176`）：透传 `await agentRuntime.dispose("session-dispose")`。**serve 侧 dispose 必须 awaitable**（onWindowClose 的 flush 需可等待、失败须可被销毁调用方捕获，排除 fire-and-forget）。须把 `@zhixing/server` `SessionRuntime.dispose()`（`packages/server/src/runtime/types.ts:86`）从 `void` 改 `Promise<void>`，adapter 改 `async` 透传，4 个调用点（`conversation-manager.ts` delete `:708` / disposeAll `:728` / releaseIfEmpty `:764` / idle reaper `:788`，现状均无 await）改为 `await`。跨包改动清单见 §十二 E。

**失败语义**：onWindowClose 抛错仅 warn、不阻断销毁链 / 换代后续——对齐 `dispose()` 现有「每步独立 try/catch」（`session.ts:825`）的**控制流形状**，但**不沿用其日志通道**：`dispose()` 现用 `console.error`（`:842`，cli 交互模式被吞），onWindowClose 失败须改走用户可见通道（cli `writer.notify`，§十一）。

---

## 五、cache 安全的 system prompt 重建（核心非平凡设计）

这是整套钩子里唯一与 prompt cache 死线正面相关、必须精确的部分。

### 5.1 约束

system prompt 当前是装配期 `const`（`create-agent-runtime.ts:680`）。cache 不变量的真意（[skill-system.md](./skill-system.md) §3.1、[lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §一）：**在单个注意力窗口生命周期内 system prompt + tools + 历史对话列表 byte-equal 不动以保 cache；跨注意力窗口边界（段切换 / compact / clear / resume）才允许重建，重建是"检查→变了才换、没变 byte-equal 不动"。不是 runtime 永久不变。**

skill 索引段（`skill-index`）落在 system prompt **静态缓存区**（`system-prompt.ts:89`，在 `__ZHIXING_CACHE_BOUNDARY__` 之前，`:43`）。所以"刷新 skill 列表"= 改静态前缀 = 若值真变则破 cache、若没变则 byte-equal。

### 5.2 重建只在注意力窗口边界、绝不在窗口内

重建挂点 = **onWindowOpen**（首窗 + 段切换 / compact / clear / resume 后的新窗），不是 onBeforeRun：

- 注意力窗口跨多个 run（基准 §一）。挂 onBeforeRun（每个 run 前）会在同一窗口的第 2、3 个 run 前改 system prompt → 违反"窗口内 byte-equal 不动"（Inv-2）。
- 窗口边界正是「cache 前缀本就要因上下文重构而失效」的时刻（[lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §一）。在此重建是搭车：skill 没变→byte-equal→不破；变了→本就该更新。
- **与 v3 段切换 cache 优化协同**：v3 让段切换 system+tools byte-equal 跨段以保 cache（[context-management-v3-redesign.md](./context-management-v3-redesign.md)）。本 spec 的"检查→变了才换"在 skill 没变时（绝大多数段切换）结果 byte-equal、保住 v3 优化；只在 skill 真变那次让位于必要更新（那次 messages 已大改、cache 本就大面积失效）。"段切换 system 不变"是"窗口边界可重建"在 skill 没变分支的特例。

### 5.3 双层 holder：实例权威 + run 局部（core 改动）

**现状（一手代码）**：`systemPrompt` 在 `runAgentLoop` 启动时解构一次（`agent-loop.ts:88`），其后每个 LLM call 用同一固定引用（`:295` 等 → `llm-call.ts`），**loop 内全程不可改写**；段切换 / 压缩（`turn-end.ts`）只改 messages、不碰 system prompt。所以注意力窗口边界虽在 run 内发生，现状下无法让新窗用上重建后的 system prompt。正确实现须改 core。

**双层 holder（关键设计）**——生效 system prompt 的现取源是 **per-run**、不是 per-instance：

- **实例级**：`authoritativePrompt`（实例权威 prompt）+ 实例级**段覆盖映射**（记录各数据驱动段的当前内容 + 其依据的版本，§九）。它由实例级窗口换代维护：首窗（`instance-start`）、run 外换代（`clear` / `resume` / `reload`）。供**新 run 起步快照**。
- **run 级**：`run()` 入口 capture 一个**本 run 局部 prompt**（初值 = 实例 `authoritativePrompt` 当前值）。`runAgentLoop` 接收 `getSystemPrompt: () => <本 run 局部 prompt>`，agent-loop 每个 LLM call 现取它。
- **run 内换代**（§四①.2 三条出口）只重拼**本 run 局部 prompt**（用本 run 自己的段覆盖视图）+ 单调更新实例级段覆盖 / authoritativePrompt（给后续新 run）；**绝不改其他 in-flight run 的局部 prompt**。

**为什么必须 per-run（并发正确性）**：同一 main runtime 被 REPL 前台 + scheduler 后台**并发 run**（`session.ts:355` scheduler 直接 `this.agentRuntime.run()`、无 REPL-忙守卫；`create-agent-runtime.ts` ALS 注释明示"同一 runtime 并发跑多个 run()"是设计支持的属性）。若生效 prompt 是 per-instance 单 cell，run A 在自身窗口换代时改写它，处于自身两 turn 之间的 run B 下个 LLM call 会读到 A 的新值——B 的 system prompt 在其窗口内中途变化、违反 Inv-2、破 B 的 cache。单调提交只解决"实例级终值不回退"、解决不了"in-flight 的 B 中途观测到变化"。故现取源必须 per-run，与同文件 `contextEngine`（`:885`）/ `segmentManager`（`:954`）已 per-run 构造的范式对齐。

**为什么 per-run 仍满足"窗口跨多 run byte-equal"**：run 入口 capture 实例 `authoritativePrompt`——窗口延续（实例权威未变）时新 run 取到同值（byte-equal、cache 跨 run 命中）；上个 run 末轮切段 / run 外换代已更新实例权威时新 run 取到新值。窗口内（run 局部 prompt 在该 run 内只被本 run 的换代点改）byte-equal 对每个 run 各自成立。

**provider 现读**：provider 每轮从 `request.systemPrompt` 现读（已核实 `anthropic-messages.ts`、`openai-compatible.ts` 两协议），无脏引用。getSystemPrompt 返回本 run 局部 prompt 当前值，run 内无换代时每 turn 取同值 → byte-equal → cache 命中。

**重建触发（统一信号源）**：`runAgentLoop` 新增可选 `windowLifecycle?: { onChange(reason): Promise<void> }`（orchestrator 装配期注入，与 `turnContextInjector` 同范式）。§四①.2 三条 run 内重构出口统一携带换代信号：

- `runTurnEnd` 的 `TurnEndOutcome` 的 `ok` variant 加 `windowChange?: { reason }`（`turn-end.ts` 内本有 `seg.modified` / `ctx.output.modified` 局部信号）；
- `runTurnBegin` 同样改返回 `{ messages, windowChange? }`（不能只返回 `Message[]` 丢弃 `seg.modified`）；
- pre-flight 压缩在 orchestrator `run()` 内（agent-loop 之前），其 `modified` 直接驱动一次 `onChange("compact")`。

agent-loop / run 在该重构改完 messages 后、下个 LLM call 之前 `await windowLifecycle?.onChange(reason)`，内部按序触发 onWindowClose(旧窗)→onWindowOpen(新窗)，订阅者经 `updateSystemPromptSegment` 贡献段 → runtime 重拼**本 run 局部 prompt**。run 外换代（clear/resume）由 cli 经 `runtime.onAttentionWindowChange`（§十二 C）触发、更新实例权威。

### 5.4 公共段更新接口 + buildSystemPrompt 支持段覆盖

onWindowOpen 的 ctx 暴露**公共方法** `updateSystemPromptSegment(segment, content)`（§3.2）——任何订阅者按需贡献数据驱动段（传 null 清空）；不调则不变。落地依赖 `buildSystemPrompt` 支持**段内容覆盖**：

- `PromptBuildContext` 新增 `segmentOverrides?: Partial<Record<SystemPromptSegment, string | null>>`；`renderSegment(segment, ctx, profile)` **每段渲染前先查 override**——`segment in ctx.segmentOverrides` 则直接返回 `ctx.segmentOverrides[segment]`，否则走默认渲染。这让接口生效面=声明面（不再是"只有 skill-index 能传内容"），同时段参数类型（`DataDrivenSegment`，§3.2）把"哪些段允许运行时覆盖"钉在类型层、与 Inv-8 一致。
- runtime 用装配期 capture 的固定段输入（profile / tools / cwd / workspace / segments，`:680-688`，运行体生命周期内不变）+ 段覆盖映射重新 `buildSystemPrompt`，与目标 holder（run 局部 prompt 或实例权威）byte-equal 比、不同才换。

**为何"段更新"而非"提交整串"——形态约束、不是私有化。** 外部订阅者没有 `buildSystemPrompt` 的全部段输入，算不出正确整串（`set(fullPrompt)` 是声明面>生效面的假能力）；但"贡献自己能算的段"它做得到，整串拼装归独占段输入的 runtime。这与 `TurnContextInjector`（`:213`：动态块由各 provider 贡献、runtime 统一注入 user message）**同构**。

### 5.5 时序自洽

- **窗口内多 turn**：本 run 局部 prompt 不变（无 onChange），每 turn getSystemPrompt 取同值 → byte-equal。
- **窗口跨多 run**：run 入口 capture 实例权威——未换代则各 run 取同值（cache 跨 run 命中）。
- **run 内换代**（runTurnBegin 段切换 / pre-flight 压缩 / runTurnEnd 段切换-压缩）：重构改 messages 并发 windowChange → `onChange` 触发 onWindowClose→onWindowOpen → 订阅者贡献段 → 重拼**本 run 局部 prompt** → 下个 LLM call 取新值。段切换摘要 LLM call 在 SegmentManager 内部更早、用换代前的本 run 局部 prompt，与新段独立、不冲突。
- **并发 run**：A 的换代只改 A 的局部 prompt（+ 单调更新实例权威给后续新 run），B 的局部 prompt 不受影响 → B 窗口内 byte-equal、cache 不破。
- **run 外 clear / resume / reload**：cli 触发窗口钩子 → 更新实例权威 → 下个 run 入口 capture 新值。
- **首窗**：装配期 onWindowOpen（`instance-start`）订阅者贡献段（如 skill-index）→ runtime 首次 buildSystemPrompt 建实例权威，第一个 run 入口 capture 它。**skill 索引唯一来源是订阅者贡献，装配期不再硬编码注入**（§九）。

---

## 六、注意力窗口 / run 边界 × 实例的钩子映射

| 事件 | 运行体动作 | 触发的钩子 |
|---|---|---|
| RuntimeSession bootstrap | 建 main 运行体（`session.ts:158`） | main onWindowOpen(`instance-start`, windowIndex=0)，建实例权威 prompt |
| 用户发消息（main 活跃） | main `run()` | run 入口 capture 本 run 局部 prompt → onBeforeRun → (loop) → onAfterRun |
| run 内 runTurnBegin 段切换 | 首个 LLM call 前换代（`agent-loop.ts:237`） | onWindowClose(`segment-transition`) → onWindowOpen(同) → 重拼本 run 局部 prompt |
| run 入口 pre-flight 压缩 | agent-loop 前换代（`create-agent-runtime.ts` run() 内） | onWindowClose(`compact`) → onWindowOpen(`compact`) → 重拼本 run 局部 prompt |
| run 内 runTurnEnd 段切换 / 压缩 | turn 结束换代（`turn-end.ts`，文本/工具两路径） | onWindowClose(`segment-transition`/`compact`) → onWindowOpen(同) → 重拼本 run 局部 prompt |
| `/clear` | 清空对话视图、开新窗 | onWindowClose(`clear`) → onWindowOpen(`clear`) → 更新实例权威 |
| `/resume` 换对话 | 换对话、开新窗 | onWindowClose(`resume`) → onWindowOpen(`resume`) → 更新实例权威 |
| enterWorkMode | 建 work 运行体（`session.ts:540`） | **新 work 实例** onWindowOpen(`instance-start`) |
| 用户发消息（work 活跃） | work `run()` | run 入口 capture → onBeforeRun → onAfterRun |
| exitWorkMode | 丢弃 work 运行体（`:558`） | 该 work 末窗 onWindowClose(`workmode-exit`) |
| reload 换 main | blue-green：建新 main + 退役旧 main（`:651`，swap 处直接 dispose 旧实例） | 旧 main 末窗 onWindowClose(`reload-replace`) + 新 main onWindowOpen(`instance-start`) |
| reload 在 work 下 | 连带换 power（`:656`） | 旧 work onWindowClose(`reload-replace`) + 新 work onWindowOpen(`instance-start`) |
| RuntimeSession dispose（cli） | 销毁 main（+ 若在 work，先销 work） | 末窗 onWindowClose(`session-dispose`) |
| serve 会话驱逐 / idle | server 销毁该会话 main runtime（`ConversationManager`） | 该 serve main 末窗 onWindowClose(`session-dispose`) |

要点：

- **run 内换代有三条出口**（runTurnBegin 段切换 / pre-flight 压缩 / runTurnEnd 段切换-压缩），统一经 `windowChange` 信号 + `windowLifecycle.onChange` 触发、只重拼本 run 局部 prompt——一条不漏（Inv-1）。
- **main 运行体跨 main↔work 持续存活**——进 work 不触发 main 末窗（main 未销毁，只是不被路由）。
- **reload 是实例换代**——旧实例末窗 onWindowClose 接在 **agent 域 swap 处**（`:651/656`），新实例首窗 onWindowOpen 接进 `createAgentRuntime`。**不可搭 `disposeOldInBackground` 便车**（§四④）。
- work 运行体的钩子各自尊重其 memoryScope 隔离（[work-mode.md](./work-mode.md)）——订阅者上下文装配期注入、不从全局拿。

---

## 七、与现有机制的边界（避免重复与债务）

| 现有机制 | 维度 | 与本钩子的关系 |
|---|---|---|
| EventBus（`AgentEventMap`） | per-run、纯观测 | **互补**。本钩子注册式；run 内的 lifecycle 信号（`lifecycle:hook_failed` / `lifecycle:prompt_rebuilt`）走 per-run eventBus（§十一），run 外（首窗 / 末窗）走装配抛错 / 销毁调用方通道 |
| `TurnContextInjector`（`:213`） | per-LLM-call、注入 user message 末尾 `<turn-context>` 动态块 | **正交**。它管动态区消息注入（高频、不动 system prompt），承接源头②"run 开启往消息注入内容"；onWindowOpen 管静态区 system prompt 在窗口边界重建（低频）。两者不重叠。本 spec 的 `windowLifecycle` / `getSystemPrompt` 注入沿用其同款范式 |
| `enrichContext` / `injectContext`（`create-agent-runtime.ts:1029/1036`） | per-run、把 projectContext + 匹配人物注入首条 user message | **正交**。它是 runtime 内置的首条消息注入，承接源头①②"在消息中注入内容"的固定部分；本钩子不重复提供消息注入能力（onBeforeRun messages 只读），①的钩子价值是窗口边界的 system prompt 准备（含 skill 重建）。两者不重叠 |
| `SegmentTransitionHook`（`segment-manager.ts:165-172` 三时刻：beforeSummarize / afterSummarize / beforeNewSegmentStart） | core 段切换流程的内部 hook，含"摘要 LLM call 前中止段切换"的过程内能力；零生产消费者 | **不同层、不构成并存债**。它是 core 段切换机制的内部细粒度扩展点（过程内、可中止），本钩子是 runtime 实例订阅者对窗口边界的响应（边界后通知）。run 内换代信号取自 turn-end / runTurnBegin 的 `windowChange`（§五.3），**不复用、不依赖** SegmentTransitionHook。二者抽象层不同，各自成立 |
| turn-end 钩子（`runTurnEnd`，core agent-loop 内） | turn 边界、budget + 段切换 | **触发源**。run 内 runTurnEnd 那条窗口换代信号来自其 `windowChange`（§四①.2、§十二 B） |
| `registerConversationStateReset` / `resetConversationState`（`:223/:235`） | `/clear`、对话级状态重置 | **同范式 + 触发源**。`/clear` 既是 conversation 数据重置、也是注意力窗口换代——在 `/clear` 路径上叠加 onWindowClose(`clear`)/onWindowOpen(`clear`)（§四①.3）。范式（register + 时机调用）一致 |

---

## 八、范围与排除

本钩子覆盖**所有经 `createAgentRuntime` 装配的 user-facing 主对话运行体**——cli 的 main runtime（`primaryRole=main`）/ work runtime（`primaryRole=power`，`session.ts:261`），**及 serve 模式下每会话经 `createAgentRuntime` 新建的 main runtime**（`serve/command.ts:222` 调 `createCliRuntimeFactory`，定义在 `session-adapter.ts:217`）。它们都走装配路径、自动携带 `lifecycle`、首窗 onWindowOpen 都触发。**唯一排除 Task 工具派生的 sub-agent。**

sub-agent 排除理由（[subagent-execution.md](./subagent-execution.md)）：

- sub-agent 生命周期完全在 Task 工具 `call()` 内（INV-S1：spawn→多轮→finalize 不写独立 Turn、不调 commitTurn），不是 `AgentRuntime` 实例的 `run()`，无 onBeforeRun/onAfterRun 对应物。
- sub-agent **不启用段切换**（[context-management-v3-redesign.md](./context-management-v3-redesign.md) §8.4，保 byte-equal-across-spawns），**无注意力窗口换代**——其 system prompt 整个 sub-agent 生命周期 byte-equal（`subagent/factory.ts:260-262` 死线），无 onWindowOpen/onWindowClose 对应物。
- sub-agent profile `enabledTools` 不含 Task（防递归），上下文走隔离 per-spawn EventBus 冒泡（INV-S2），观测已覆盖。

排除是 by-construction：sub-agent **不经 `createAgentRuntime`**（走 `runChildAgent`，经 `loop-runner.ts` 调 `drainAgentLoop`→`runAgentLoop`），自然不携带 `lifecycle`。**agent-loop 签名向后兼容**：`runAgentLoop` 的 `getSystemPrompt?` 与现有 `systemPrompt?: string` 二选一、内部归一 `const getSP = params.getSystemPrompt ?? (() => params.systemPrompt ?? "")`——sub-agent 调用点（`loop-runner.ts`）继续传固定 `systemPrompt: string`、不传 `getSystemPrompt` / `windowLifecycle`，**零改动**。**关键**：serve 的 main runtime 经 createAgentRuntime、属覆盖项，其末窗 onWindowClose 必须在 serve 销毁路径接上（§四④ / §十二 E），否则首窗 open 触发而末窗 close 永不触发。

---

## 九、首个消费者：skill 索引的注意力窗口边界重建

落地验证这套抽象、兑现 [skill-system.md](./skill-system.md) §3.3 的 v2 边界重建。它是 lifecycle 框架的**首个消费者**——用 §3.2/§五.4 的**公共** `updateSystemPromptSegment` 接口贡献 `skill-index` 段，与任何外部订阅者走同一接口。由 `createAgentRuntime` 默认注册（closure 持有 `skillStore` / `skillMode` 读 version）：

```typescript
function makeSkillIndexLifecycle(): AgentRuntimeLifecycle {
  let builtVersion = -1;  // 消费者侧状态：上次贡献所依据的 skill 版本
  return {
    id: "skill-index-rebuild",
    // 挂注意力窗口开启（首窗 + 每次换代）；不挂 onBeforeRun（run 边界在窗口内）
    onWindowOpen: async (ctx) => {
      const cur = skillStore.version(skillMode);        // O(1)
      if (cur === builtVersion) return;                 // 已最新 → 零 IO、零重算、不调接口
      const next = renderSkillIndex(
        await skillStore.queryTopN(skillMode, SKILL_INDEX_TOP_N),
      );
      ctx.updateSystemPromptSegment("skill-index", next); // 贡献段；拼装 / byte-equal / 单调提交归 runtime
      builtVersion = cur;
    },
  };
}
```

skill 索引的唯一来源是此订阅者：装配期 `createAgentRuntime` **不再硬编码注入 skillIndex**（`:677` 的 `renderSkillIndex(await skillStore.queryTopN(...))` 移进本订阅者闭包），首窗 onWindowOpen 首次贡献、runtime 首次 buildSystemPrompt 即含 skill 段——单一路径、无装配期与订阅者两条路并存。

runtime 侧（`updateSystemPromptSegment` + 重拼）负责：把贡献记入段覆盖视图 → capture 固定段输入重新 `buildSystemPrompt` → 重拼后整串与目标 holder byte-equal 比、不同才换 → 实例级段覆盖的并发写用单调提交（§九 并发安全）。

关键：

- **变更检测靠 `SkillStore` 单调版本号**（前置依赖，§十二 A.10）：任何改变索引投影的**结构性写**（`setState` / `admit` / `archive` / create / update）令 `version` 递增；窗口开启时 O(1) 比对，未变则零 IO、零重算，**绝不在窗口边界扫盘**。version 比对保证**结构性变更绝不漏更新**（论域是结构性变更）。
- **usage（命中度量）有意不进 version、不触发重建**：`queryTopN` 的 top-N 排序依赖 usage（`rankWithUsage` 按 pinned→`lastHitAt`→`hitCount`，`store.ts:433`），usage 在 `load_skill`→`recordHit`（`store.ts:589`，走 per-id 锁、不碰 index）时写。让 usage 进 version 会使每次 load_skill 后下个窗口重算且极可能换 prompt（recency 上浮改 top-N）、破 cache。这是 cache 安全的承重取舍：放弃"窗口内 usage 重排即时反映"、换 cache 稳定；陈旧仅限当前窗口排序新近度，下次结构性写或新窗即纠正。
- **version 契约须含 ordering（publish-after-commit）**：`builtVersion` 比对要可靠，要求任一可读到的 `version` V 对应投影（queryTopN 所读）必已 ≥ V。现状 SkillStore 写经 `withIndexLock`→`writeIndex`（已核实），于 `writeIndex` 之后自增 version 即满足；**切忌先 bump 后 write**。
- **byte-equal 是第二道保险**：version 变但重算结果相同（改了又改回），runtime 重拼后整串 byte-equal 于目标 holder 则不换，cache 不破。
- 固定段输入（profile / tools / cwd / workspace / segments）装配期 capture——运行体生命周期内不变（tools[] 冻结，[context-management-v3-redesign.md](./context-management-v3-redesign.md) §九 INV-4，reload 级、比注意力窗口更强）。
- **并发安全（双层分治）**：同一 main runtime 可被并发 run（REPL 前台 + scheduler 定时任务共享 main runtime，`session.ts:355`、ALS 注释）。① **run 局部 prompt 私有**——run 内换代只改本 run 的局部 prompt，并发 run 互不观测对方的换代，**这是窗口内 byte-equal 在并发下成立的根本**（§五.3）。② **实例级段覆盖的并发写**用单调提交收敛：消费者侧 `builtVersion` 避免重复贡献，runtime 侧以"依据 skill version 较新者胜"提交实例权威、不回退（旧 run 的滞后贡献不覆盖新值）。无锁单调提交而非 mutex：窗口换代频率低、并发面小。
- **为何必须有 holder（而非靠 reload）**：skill 库变化（create / admit / archive）**不触发** reload——`diff.ts` 只比对 config / credentials、无 skill 输入（已核实）。故运行时 skill 变化只能由本实例的窗口边界重建承接，holder 是必要机制。

---

## 十、Invariants

1. **窗口换代触发面无遗漏**：所有 messages 重构出口都是注意力窗口换代、都成对触发 onWindowClose→onWindowOpen。run 内三条出口（runTurnBegin 段切换 / pre-flight 压缩 / runTurnEnd 段切换-压缩，§四①.2）经统一 `windowChange` 信号驱动，一条不漏；run 外换代（clear/resume/reload）+ 首窗 / 末窗各有触发点。
2. **窗口内 system prompt byte-equal（按 run 局部成立）**：生效 system prompt 的现取源是 **per-run 局部 prompt**；它在一个 run 内只被本 run 的换代点重建，run 内（含跨多 turn）不动；run 入口 capture 实例权威保证窗口跨多 run 时延续值 byte-equal。**并发 run 各自的局部 prompt 互不干扰**——一个 run 的换代绝不改另一 in-flight run 的生效 prompt。run 入口（onBeforeRun）不重建。
3. **main 运行体跨 main↔work 持续**：进 work 不触发 main 末窗（main 未销毁）。
4. **首窗 open / 末窗 close 与实例配对**：任何 onWindowOpen(`instance-start`) 已完成的实例，无论以何路径退场，最终必有且仅有一次末窗 onWindowClose（销毁类 reason）。① reload 换代旧实例末窗 close **必须接在 agent 域 swap 处**（`:651/656`）、**不可依赖 `disposeOldInBackground`**；② 装配回滚（`buildNewResources` 兄弟步骤抛错，`:765`）须对已激活实例补 `dispose("assembly-rollback")`、不静默 GC。
5. **system prompt 窗口边界重建走公共段更新接口、拼装归 runtime**：只在 onWindowOpen，订阅者经 ctx 公共方法 `updateSystemPromptSegment` 贡献数据驱动段内容（公共、非只读，skill 仅首个消费者）；runtime 经段覆盖视图收集后重拼、自管 byte-equal。不暴露"提交整串"。agent-loop 经 `getSystemPrompt()` 现取**本 run 局部 prompt**（§五.3），不感知窗口。
6. **cache 死线不破**：重建一律"检查→变了才换、没变 byte-equal 不动"；skill 没变时段切换 holder byte-equal、保住 v3 段切换 system+tools cache（§5.2）。
7. **钩子不修改 tools[]**：tools[] 装配后冻结（reload 级，[context-management-v3-redesign.md](./context-management-v3-redesign.md) §九 INV-4），任何阶段不得增删改。
8. **段覆盖服务数据驱动段**：`updateSystemPromptSegment` 段参数为 `DataDrivenSegment` 子类型（第一版仅 `skill-index`），运行时窗口边界更新只服务数据驱动段；profile 驱动段（identity 等）变化单位是 reload，类型层即排除、不可经此接口覆盖。
9. **失败不阻塞主对话**：onBeforeRun/onAfterRun/run 内窗口换代钩子抛错 → emit `lifecycle:hook_failed` 到 per-run bus + 继续；末窗 onWindowClose 抛错 → 销毁调用方 warn（用户可见）+ 不阻断；唯首窗 onWindowOpen(`instance-start`) 抛错让装配失败（实例未就绪、安全回滚）。**可观测分通道、不押 `logDiagnostic`（cli 交互模式 `index.ts:89` no-op）。**
10. **装配期注入、不开放运行时 register**：订阅集合实例内恒定，保证首窗语义完整。sub-agent by-construction 不挂（不经 createAgentRuntime、无段切换）。
11. **顺序 sequential await、forward**：每个边界按注册顺序串行 await；不镜像逆序（订阅者装配期独立注入、彼此无构造顺序依赖）。

---

## 十一、失败语义与可观测性

### 失败分级

| 阶段 | 抛错处理 | 理由 |
|---|---|---|
| onWindowOpen(`instance-start`，首窗) | 中止装配，`createAgentRuntime` 失败 | 实例未就绪、安全回滚（对齐 work-mode `session.ts:529`） |
| onWindowOpen / onWindowClose（run 内换代） | emit `lifecycle:hook_failed` 到 per-run bus + 用当前 prompt 继续 | 窗口边界动作不阻塞主对话（v3 INV-8） |
| onWindowOpen / onWindowClose（run 外换代 clear/resume） | 命令调用方 warn（用户可见）+ 继续 | 同上、但在 run 外无 per-run bus |
| onBeforeRun | emit `lifecycle:hook_failed` + 用当前 system prompt 继续 run | 不阻塞主对话 |
| onAfterRun | emit `lifecycle:hook_failed` + 不影响已就绪 `RunResult` | run 已成功、收尾失败不污染结果 |
| onWindowClose（末窗，实例销毁） | 销毁调用方 warn（用户可见）+ 不阻断销毁链后续 | 对齐 `dispose()` 每步独立 try/catch |

### 可观测：按"在不在 run 内"分通道（不能统一押 logDiagnostic）

cli 交互模式（REPL / -p，主用户面）启动时 `setDiagnosticLogger(() => {})` 全量静默 `logDiagnostic`（`cli/src/index.ts:89`，仅 serve/rpc 保留）。lifecycle 可观测**绝不能统一走 logDiagnostic**（否则内置 skill 重建每窗静默失败、索引永久陈旧却无人知）。

| 信号 | 时机 | 通道（均不被 cli no-op） |
|---|---|---|
| `lifecycle:hook_failed`（run 内钩子抛错）、`lifecycle:prompt_rebuilt`（内置 skill 真换 prompt） | **run 内**（onBeforeRun/onAfterRun + run 内窗口换代） | **per-run eventBus**（`AgentEventMap` 新增这两事件）。`decorateRunBus` 通道现成（`:966`，serve 同走）——但通道接入 ≠ 已被渲染：现行 `createRenderSubscribers`（`cli/src/render.ts`）仅订阅 retry/context/security/interrupt，对 lifecycle 事件零订阅。要成为生效的失败安全网，**必须在 `createRenderSubscribers` 增订阅 + 渲染**（§十二 B item 14，属本 spec 范围） |
| 首窗 onWindowOpen 失败 | 装配期（run 外） | `createAgentRuntime` 抛错 → 装配调用方（cli startup / serve factory）捕获即可见 |
| 末窗 onWindowClose / run 外换代（clear/resume）失败 | 销毁 / 命令期（run 外） | 调用方处理：cli `RuntimeSession` 用 `writer.notify`（与 scheduler warn/error 同范式，`session.ts:325-331`）、serve 用其 logger |

**emit 归属**：run 内 `lifecycle:hook_failed` / `lifecycle:prompt_rebuilt` 由**持有 per-run bus 的一方** emit，订阅者 ctx 不持有 bus、不自行 emit（onWindowOpen ctx 只有 `updateSystemPromptSegment`）——onBeforeRun/onAfterRun 抛错由 `run()` emit（它在 `:861` 建 bus）；run 内窗口换代的钩子抛错、以及"真换 prompt"的 `prompt_rebuilt`，由 `windowLifecycle.onChange` 触发逻辑 emit（agent-loop / run 调它时 per-run bus 可达）。

**声明面=生效面**：事件上 bus 与订阅渲染必须一并落地，绝不留「上了 bus 但无人渲染」的洞（那正是 `logDiagnostic` no-op 的同构）。视觉形态可实现期细化，「有用户可见信号」是硬性验收项。

---

## 十二、实施清单（可执行）

**A. orchestrator — 钩子契约、挂点、双层 holder、段覆盖拼装**

1. 新增 `orchestrator/src/runtime/lifecycle.ts`：`AgentRuntimeLifecycle` 接口 + 四个 ctx 类型 + `DataDrivenSegment` 类型（onWindowOpen ctx 含公共方法 `updateSystemPromptSegment(seg: DataDrivenSegment, content)`，其余字段只读）；从 `runtime/index.ts` 导出。
2. `CreateAgentRuntimeOptions`（`:324`）新增 `lifecycle?: readonly AgentRuntimeLifecycle[]`。
3. **`buildSystemPrompt` 支持段覆盖**（`system-prompt.ts`）：`PromptBuildContext` 新增 `segmentOverrides?: Partial<Record<SystemPromptSegment, string | null>>`；`renderSegment` 每段渲染前先查 `segment in ctx.segmentOverrides ? ctx.segmentOverrides[segment] : 默认渲染`。
4. **双层 holder**（§五.3）：`:680` 的 `const systemPrompt` 去除；装配期固定段输入 capture；**删 `:677` 的 skillIndex 硬编码注入**（移进 skill 订阅者，§九）。runtime 内部维护**实例级**段覆盖映射 + 实例权威 prompt（首窗 / clear / resume / reload 换代时重拼并单调提交）。
5. 首窗 onWindowOpen 挂点：strategies 数组结束（`:745-746`）与 return 字面量（`:747`）之间，按序 `await lifecycle[].onWindowOpen({reason:"instance-start", windowIndex:0})`，据收集的段覆盖首次 buildSystemPrompt 建实例权威 prompt；抛错则 reject。注意 `run` 方法体写在 return 字面量内（`:855-1233`），勿插错。
6. `run()` 内（per-run eventBus `:861` 后、`decorateRunBus` `:966` 后、ALS try `:1010` 前）：**capture 本 run 局部 prompt（初值=实例权威 prompt 当前值）**；按序 `await lifecycle[].onBeforeRun`（ctx 只读 messages/turnIndex/conversationId）；抛错 → emit `lifecycle:hook_failed`。
7. `run()` 内：**pre-flight 压缩**（`resolveContextManager("pre-flight")`）若 `modified` → `await windowLifecycle.onChange("compact")`（重拼本 run 局部 prompt），在进入 `runAgentLoop` 之前。把 `return await runContextStorage.run(...)`（`:1011`）拆为 `const result = await …` → 每个 `await lifecycle[].onAfterRun(result)`（各自 try/catch）→ `return result`（`finally` 仍 disposeAll）；抛错 → emit `lifecycle:hook_failed`。`run()` 透传给 agent-loop 的是 `getSystemPrompt: () => <本 run 局部 prompt>`（`:1162`）+ `windowLifecycle`。
8. `AgentRuntime` 接口新增 `dispose(reason): Promise<void>`（`:178`）：`reason` 透传末窗 `onWindowClose`；幂等、按序 `await`；失败由销毁调用方 warn（§十一）。
9. `AgentRuntime` 接口新增 `onAttentionWindowChange(reason): Promise<void>`（run 外窗口换代入口，供 cli `/clear`·`/resume` 调）：内部按序 `await onWindowClose(旧窗) → onWindowOpen(新窗)`，更新实例权威 prompt。
10. **前置（属 skill 模块）**：`SkillStore` 暴露 `version(mode): number`，须 **单调递增 + publish-after-commit**（结构性写 `setState`/`admit`/`archive` 等递增；现 `withIndexLock`→`writeIndex` 范式下于 `writeIndex` 之后自增；切忌先 bump 后 write）。现状 SkillStore 只有 `queryTopN` 扫盘投影、**无任何版本 / dirty 信号**（已核实），故此为明确前置；本 spec 只消费不实现。
11. 内置 skill 订阅者（§九）：`createAgentRuntime` 默认注册 `makeSkillIndexLifecycle()`（closure 持有 `skillStore` / `skillMode` 读 version + `renderSkillIndex`/`SKILL_INDEX_TOP_N`），onWindowOpen 走公共 `ctx.updateSystemPromptSegment("skill-index", ...)`；默认置于 `lifecycle` 列表首位（外部 `options.lifecycle` 追加其后）。

**B. core — agent-loop per-run 现取 + 窗口换代信号 + turn-begin/turn-end 返回扩展**

12. `runAgentLoop`（`agent-loop.ts:81`）：**新增可选 `getSystemPrompt?: () => string`，与现有 `systemPrompt?: string` 二选一**，内部归一 `const getSP = params.getSystemPrompt ?? (() => params.systemPrompt ?? "")`；`:88` 一次性解构删除。**agent-loop 内全部 5 处 systemPrompt 消费点一律改 `getSP()` 现取,一处不漏**：`:242`（runTurnBegin 段切换评估）、`:295`（streamLLMCall 主 LLM call）、`:340`（token 校准）、`:431`（runTurnEnd 纯文本路径）、`:537`（runTurnEnd 工具路径）。main agent 走 getSystemPrompt 后 `params.systemPrompt` 恒为 undefined，漏改任一处（尤其三处段切换出口）会让段切换用空 system prompt、缓存安全分叉 prefix 不一致、cache 全 miss。`llm-call.ts` 构造 `request.systemPrompt`（string）不变。**sub-agent 调用点（`loop-runner.ts`）继续传 `systemPrompt: string`、零改动（经归一回退）。**
13. **窗口换代信号 — 三条出口统一**（§四①.2、§五.3）：`runAgentLoop` 新增可选 `windowLifecycle?: { onChange(reason): Promise<void> }`。
    - **runTurnEnd**：`TurnEndOutcome` 的 `ok` variant 加 `windowChange?: { reason: "segment-transition" | "compact" }`（`turn-end.ts` 内 `seg.modified` → segment-transition、`ctx.output.modified` → compact）。agent-loop 读 `turnEnd.windowChange` 在下个 turn 前 `await windowLifecycle?.onChange(reason)`。
    - **runTurnBegin**：改返回 `{ messages, windowChange? }`（不再只返回 `Message[]` 而丢弃 `seg.modified`）；agent-loop 在 runTurnBegin 之后、首个 `streamLLMCall`（`:290`）之前 `await windowLifecycle?.onChange("segment-transition")`。
    - **pre-flight 压缩**：在 orchestrator `run()` 内触发（item 7），不经 agent-loop。
    - 同步**消除 item12 / item13 的读写侧不一致**：item12 已认 `:242` runTurnBegin 做段切换评估，item13 此处把它纳入换代触发,两侧一致。
14. **core**：`AgentEventMap`（`agent-events.ts`）新增 run 内事件 `lifecycle:hook_failed` / `lifecycle:prompt_rebuilt`。首窗 / 末窗（run 外）不进 `AgentEventMap`。**不押 `logDiagnostic`。**
    - **cli/serve 渲染落地（同属本项、不可省略）**：`createRenderSubscribers`（`cli/src/render.ts`）新增对这两事件的订阅 + 用户可见渲染（`hook_failed` 至少一条可见告警；`prompt_rebuilt` 可静默或轻提示）。现行仅订阅 retry/context/security/interrupt，不增订阅 = 声明面>生效面。

**C. cli — 销毁路径接末窗 dispose + clear/resume 接窗口换代**

15. `RuntimeSession.dispose()`（`session.ts:827`）：若 `workScene` 先 `await workScene.runtime.dispose("session-dispose")`、**再置 `workScene = undefined`**（现状 `:832` 置空后移到 dispose 之后），最后 `await agentRuntime.dispose("session-dispose")`。
16. `exitWorkMode()`（`:555`）：置 undefined 前 `await workScene.runtime.dispose("workmode-exit")`。
17. reload 退役旧 runtime 接末窗：agent 域 swap 处（`:651/656`）swap 前 `await oldRuntime.dispose("reload-replace")`。**不可接进 `disposeOldInBackground`**（`old` 不含 agentRuntime、`:673` 守卫门控、agent-only reload 不执行）。装配回滚补 dispose（Inv-4②）：`buildNewResources` 回滚 `catch`（`:765`）对已激活新实例补 `await dispose("assembly-rollback")`，替换 `:776` 注释。
18. `/clear`（`resetConversationState` 路径）、`/resume`（换对话）：在 cli 这两条命令路径上调 `runtime.onAttentionWindowChange("clear" | "resume")`（item 9）。

**D. 测试拓扑**

19. 触发次数与顺序：首窗 open / 末窗 close 与实例配对；run 内三条出口（runTurnBegin 段切换 / pre-flight 压缩 / runTurnEnd 段切换-压缩）各触发 onWindowClose→onWindowOpen 成对；clear/resume 成对。另测：① run() 自身抛错时 onBeforeRun 触发而 onAfterRun 不触发（非强配对）；② 装配回滚配对（onWindowClose(`assembly-rollback`) 不被静默 GC）；③ 实例权威 prompt 跨 reload 走整体换实例。
20. **窗口内 byte-equal + 并发隔离（核心回归）**：(a) 单 run 内跨多 turn，getSystemPrompt byte-equal；窗口跨多 run（无换代）各 run 入口 capture 值 byte-equal。(b) **并发两 run A/B：A 在自身换代重拼局部 prompt，B 的 getSystemPrompt 在其窗口内不变**——锁死 Inv-2 的并发面。(c) skill 库在某 run 窗口内变化不改本窗 system prompt，下个窗口边界才生效。
21. 段覆盖：`updateSystemPromptSegment("skill-index", x)` 真实改变 buildSystemPrompt 输出对应段；`segmentOverrides` 不含的段走默认渲染、byte-equal 历史；段参数类型只接受 `DataDrivenSegment`。version 未变→零重算；变但结果相同→byte-equal 不换；变且不同→换。段切换时 skill 没变 → byte-equal → system+tools cache 跨段命中（Inv-6）。
22. 失败分级：首窗抛错装配失败；其余降级继续。sub-agent 路径不触发任何 lifecycle 钩子、systemPrompt byte-equal-across-spawns 不变。

**E. server — `SessionRuntime.dispose` async 化（跨 `@zhixing/server` 包）**

23. `packages/server/src/runtime/types.ts:86` `dispose(): void` → `dispose(): Promise<void>`。
24. serve adapter（`serve/session-adapter.ts:176`）`dispose()` 改 `async`，清 `messages` 后透传 `await agentRuntime.dispose("session-dispose")`（闭包持有 `agentRuntime`，`:47`）。
25. 4 个调用点改 `await`：`conversation-manager.ts` delete（`:708`）/ disposeAll（`:728`）/ releaseIfEmpty（`:764`）/ idle reaper（`:788`）。

**F. core 改动影响面小结**

26. agent-loop 改动:systemPrompt 由"启动取一次"变"每 LLM call 现取本 run 局部 prompt"(向后兼容签名,sub-agent 传固定 string 不受影响);新增 windowLifecycle.onChange 触发(可选,不注入则 no-op)。turn-end 改动:`TurnEndOutcome` 加 `windowChange` 信号。turn-begin 改动:返回类型从 `Message[]` 改为 `{ messages, windowChange? }`(纯增字段/形状,调用方 agent-loop 同步适配)。三处均为受控扩展,sub-agent 与既有 budget-only 兜底路径不受影响。

---

## 十三、开放问题

- **onWindowClose（窗口换代类）第一版无内置消费者**：基准 §二需求④「暂无用途、先预留」。空列表 sequential await 即 no-op、真零成本（与 `SegmentTransitionHook`「保留接口、零内置实现」同构，已被接受）。实例销毁的末窗 onWindowClose 有落点（资源收尾 / flush）。
- **runtimeId / windowIndex 生成**：runtimeId 装配期生成（`crypto.randomUUID` 或仿 `defaultSegmentId` 时间戳 + 随机，`segment-manager.ts:133`），仅用于事件归属，不持久化。windowIndex 实例内自增计数器（首窗 0）。
- **实例级段覆盖的并发提交粒度**：run 局部 prompt 已隔离"窗口内中途观测"（§五.3 / Inv-2），故并发问题收敛为「实例权威 / 段覆盖的终值不回退」一项。实现选项：① `updateSystemPromptSegment` 写实例级时带 skill version、runtime 单调接受（version 较新者胜）；② runtime 对实例权威分配单调 epoch。实施期择一；低并发（REPL + scheduler）下"version 比对 + 较新者胜"已足够。

---

## 十四、状态

| 字段 | 值 |
|---|---|
| 状态 | 方案设计，待实施 |
| 前置依赖 | ① `SkillStore` 暴露 `version(mode)`（单调 + publish-after-commit，现状无、须先行）；② core agent-loop per-run 现取 + windowLifecycle 回调 + turn-end `windowChange` 扩展 + turn-begin 返回扩展（§十二 B）；③ `buildSystemPrompt` segmentOverrides 段覆盖（§十二 A.3） |
| 实施完成后 | 在 [skill-system.md](./skill-system.md) §3.2/§3.3/§九 标注"注意力窗口边界重建已落地"；在 [lifecycle-concepts.md](../drafts/lifecycle-concepts.md) §二标注四钩子需求已实现 |
