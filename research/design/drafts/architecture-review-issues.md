# 架构审查问题收集

## 使用规则

- 本文骨架固定保留：`使用规则`、`维护原则`、`问题条目结构`、`排除问题条目结构`、`提示词文本块结构`、`来源`、`本轮审查问题`、`已排除问题`、`用户使用的提示词`。
- 清理时只清空动态内容，不删除骨架标题、说明和格式。
- `用户使用的提示词` 属于用户权限内容，不参与清理；除非用户明确要求，不得修改、清空或删除其中任何文本块。

## 维护原则

本文用于收集一轮架构审查中发现的问题，目标是在当前事实与认知下尽可能把这一轮能发现的问题收集完整，直到除本文已记录的问题之外，本轮已经无法再发现新的问题。

这不表示这些问题解决后未来不能再发现问题。问题修复本身可能暴露新的问题，或引入新的设计约束，这是正常且接受的事实。

这里的“本轮收集完成”只表示：除本文动态部分已经记录的问题外，当前这一轮审查暂时没有新的可发现问题，可以结束本轮审查。

新增问题必须满足两个条件：第一，问题必须基于事实真实成立；第二，不能与动态区已有问题重复、重合或冲突。若只是同一问题的不同表述，应合并到既有条目，而不是新增。

新增问题还必须区分“架构阶段必须定死的问题”和“实现阶段自然会处理的细节”；后者不进入问题列表，避免审查变成无限挑刺。

## 清理节奏

1. 来源：随当前模块更新而更新，修改频率低。
2. 本轮审查问题：按轮次更新；每轮审查找出所有问题，解决并清理后，该轮问题清零。
3. 已排除问题：跨轮次有效；本轮、下一轮及后续轮次继续积累并用于避免重复验证，更新时机与来源更新时机一致。
4. 用户使用的提示词：不随轮次或模块清理，只有用户明确要求时才可改动。

## 问题条目结构

动态区每个问题条目固定包含三部分：

1. 编号标题：一句话指出问题本质。
2. 问题说明：说明真实事实、风险和为什么这是问题。
3. 解决方案：以 `解决方案：` 开头，写执行者认可的最优解决方案，要求精简、可执行。

## 排除问题条目结构

已排除问题使用列表维护，每项固定包含两部分：

1. 什么问题：说明被核查但排除的问题。
2. 为什么排除：说明排除依据，便于后续审查避免重复验证。

## 提示词文本块结构

底部「用户使用的提示词」使用独立文本块维护；每个文本块下方必须紧跟 `---` 分割线，空文本块也必须保留分割线。

## 来源

- 审查对象：`Subagents 早期 Task 工具用户面（UI / 交互 / 功能审查）`
- 需求来源：`research/design/drafts/requirement-backlog.md`「临时草稿工作台」
- 事实依据：
  - `research/design/specifications/subagent-execution.md`
  - `research/internals/screen-rendering/overview.md`
  - `research/design/drafts/unified-core-and-access-surfaces.md`
  - `packages/orchestrator/src/tools/task.ts`
  - `packages/orchestrator/src/tools/task-usage.ts`
  - `packages/orchestrator/src/profile/default-profiles.ts`
  - `packages/orchestrator/src/runtime/system-prompt.ts`
  - `packages/orchestrator/src/subagent/factory.ts`
  - `packages/orchestrator/src/subagent/loop-runner.ts`
  - `packages/orchestrator/src/subagent/result-classifier.ts`
  - `packages/orchestrator/src/orchestration/runner.ts`
  - `packages/core/src/context/token-estimator.ts`
  - `packages/core/src/events/event-bus.ts`
  - `packages/core/src/interrupt/watchdog.ts`
  - `packages/core/src/loop/agent-loop.ts`
  - `packages/core/src/loop/tool-executor.ts`
  - `packages/core/src/types/tools.ts`
  - `packages/tools-builtin/src/read.ts`
  - `packages/tools-builtin/src/glob.ts`
  - `packages/tools-builtin/src/grep.ts`
  - `packages/tools-builtin/src/web-fetch.ts`
  - `packages/cli/src/status-bar/status-bar.ts`
  - `packages/cli/src/status-bar/verbs.ts`
  - `packages/cli/src/status-bar/__tests__/status-bar.test.ts`
  - `packages/cli/src/screen/screen-controller.ts`
  - `packages/cli/src/tui/style.ts`
  - `packages/cli/src/tui/line-width.ts`
  - `packages/cli/src/typeahead-input.ts`
  - `packages/cli/src/task-tail/task-tail.ts`
  - `packages/cli/src/task-tail/task-tail-render.ts`
  - `packages/cli/src/bottom-info/render.ts`
  - `packages/cli/src/context-indicator/context-indicator.ts`
  - `packages/cli/src/output/speaker-state.ts`
  - `packages/cli/src/output/output-renderer.ts`
  - `packages/cli/src/output/__tests__/output-renderer.test.ts`
  - `packages/cli/src/subtasks/presentation.ts`
  - `packages/cli/src/render.ts`
  - `packages/cli/src/tool-card-format.ts`
  - `packages/cli/src/tool-render-strategy.ts`
  - `packages/core/src/confirmation/request-builder.ts`
  - `packages/server/src/rpc/session-events.ts`
  - `packages/orchestrator/src/tools/__tests__/task-usage.test.ts`

---

## 本轮审查问题

### Subagents 早期 Task 工具用户面（第二轮）

1. 主 lineage 守卫误屏蔽了既有文件化编排进度 UI

   `OrchestrationRunnerV1` 在 `main/orch-<runId>` 子 lineage 上发出 `orchestration:run_start / node_start / run_end`，但 CLI 新增的 `isMainLineage` 只接受 `main` 或无 lineage，并被直接套到这三个专用订阅上。生产路径中的多视角评议进度因此全部被过滤；现有测试只在无 lineage 的根 bus 上直接发事件，没有覆盖 runner 的真实事件来源。这是本需求对既有模块造成的确定回归。

   解决方案：按事件语义判定作用域：主状态、retry、segment、lifecycle 等通用顶层 UI 继续只认根 lineage；`orchestration:*` 本身就是编排域事件，不套根 lineage 守卫，只用既有 `definitionId / runId` 隔离当前实例，避免 CLI 耦合 `main/orch-*` 命名。补“根 bus + 真实 `OrchestrationRunnerV1` 子 bus”的集成测试，锁定编排进度可见且普通子 agent 事件不污染该 UI。

2. `tool:child_end` 没有即时收束并发子任务状态

   状态栏收到 `tool:child_end` 后只改 `activeTasks` 中的 status 和 subToolName，不重算 phase、不更新完成计数、也不 repaint；`activeCount` 又直接取 map.size。并发执行层会等全部调用 `Promise.allSettled` 后才按输入顺序发 `tool:call_end`，所以先完成的子任务在长尾同伴结束前仍被计为“运行中”，焦点行还可能继续显示它最后一个子工具。这与新增 child 生命周期事件的实时语义冲突。

   解决方案：用单一 Task registry 持有“子运行状态 + 父工具调用是否结束”，所有活跃数和三态计数从 registry 派生，避免维护可漂移的重复计数。`tool:child_end` 立即、幂等地终结子运行状态，清理 lineage/subTool、切换到仍运行的焦点并 repaint；`tool:call_end` 只负责父调用收口，并为未产生 child 生命周期的前置失败提供 fallback，不能重复计数。按真实时序补“一个 child_end 后另一个仍运行、随后 call_end”的回归测试。

3. 窄终端会裁掉子任务失败状态和成本信息

   子任务告警与 `/usage` 明细先放固定 24/28 列描述，再把失败/中止、tokens、工具调用和耗时放在右侧，最后对整行 `clampLine`。在 30 列终端中，失败告警实际只剩“子任务 #1 + 描述”，`⚠ 失败` 被裁掉；用量明细也只剩编号和描述，状态与 token 消失。行宽虽然合规，但最重要的信息不可见。

   解决方案：为完成告警和 `/usage` 分别定义字段优先级，先保留状态、编号及该视图的核心诊断/成本，再按实时 columns 把剩余宽度分给描述；空间不足时依次省略 sub id、耗时等次要字段，固定语义段仍放不下才拆成两条受宽度约束的行。补 24/30/40 列下的 CJK、长描述、失败和中止测试，同时断言行宽与关键字段可见。

4. Task 结果上限没有覆盖失败元数据和展示元数据

   `TASK_RESULT_TEXT_MAX_CHARS` 只裁剪 final/partial；失败前缀中的 description、provider error，及 presentation 中的 description / errorOrAbortReason 都原样保留。description 仅校验非空、schema 也没有长度约束，因此长描述或大体积上游错误仍可绕过 20k 上限进入主上下文，并在摘要 flush 前以同等体积驻留 CLI collector；Task 又没有 core `maxResultChars` 兜底。这使“专用结果上限”在失败路径并不成立。

   解决方案：在 Task 模块为可变字段设置独立上限：description 使用 schema `maxLength` 与运行期同源短限；error / abort reason 先按同一中限裁剪，再同时用于失败前缀和 presentation；final / partial 保持现有 20k 上限。usage trailer 始终最后追加，不启用会截断 trailer 的 core 通用截断。补各字段超长的三态测试，锁定 content / presentation 总上界和 trailer 仍可解析。

5. Subagents 详情挤占全局信息状态栏并裁掉既有信息

   CLI 底部常态由三个稳定部分组成：输入区、其上方一行全局信息状态栏、其下方一行输入提示。当前 Task phase 没有新增详情行，而是把全局信息状态栏左侧阶段替换成长子任务描述、并发计数和内部工具，再把时间/token、长期任务进度及上下文/cache 拼进同一物理行；该行禁止折行并从右侧截断。实测 80 列时长期任务进度和上下文可完全消失，Subagents 的瞬时执行详情与全局运行信息也失去清晰层级。此前模拟中的视觉换行不是实际行为，当前实现始终只有一行。

   **目标运行效果：**

   ```text
     ⌬ 3 个子任务 · 2 运行 1 完成 · #3 检查并发状态 · grep
     ◈ 子任务中 (8s · ↑ 12.4k ↓ 620) │ 推进审查 (2/5) │ ~ 14k
   ╭──────────────────────────────────────────────────╮
   │ ❯ 输入消息或 / 查看命令                          │
   ╰──────────────────────────────────────────────────╯
                                              esc 清空
   ```

   **原信息栏承载：**最靠近输入区的稳定锚点行继续承载全局运行阶段、耗时与本轮 token、长期任务进度、上下文/cache；Subagents 运行时只把阶段精确更新为“子任务中”，不让详情侵占其它槽位。输入区及其下方提示行保持原语义和位置。

   **拼接规则：**临时详情行只承载子任务总数与运行/完成/失败/中止计数、当前焦点子任务及当前内部工具；全局信息仍只在稳定锚点行内拼接。两行都禁止折行；详情行空间不足时先缩短描述，再省略内部工具和次要细节，但始终保留总数与状态。子任务全部结束后详情行立即消失，全局行切回“回复中/已完成”，完成聚合与失败告警按既有规则一次性追加到 scrollback。

   **最终效果：**常态仍是“全局信息栏 + 输入区 + 底部提示行”三个部分；仅在 Subagents 活跃期间，于全局信息栏上方增加一条临时详情行。用户既能看到并发子任务进度，也不会失去原有全局信息，Chrome 高度只在子任务批次开始和结束时各变化一次。

   解决方案：把状态区定义为通用的“零到多条临时详情行 + 一条稳定锚点行”，不在 `ScreenController` 写入 Task 概念。`status-bar` 在 Task phase 输出“子任务详情行 + 全局锚点行”，其它 phase 只输出锚点行；`ScreenController` 将独立 status tails 拼到最靠近输入区的锚点行，而非固定拼到第一行，现有单行调用行为保持不变。详情行按字段优先级分配实时列宽，复用现有 Chrome 动态高度协议。补常态/Task 起止、40/80/120 列、长 CJK 描述、tails 锚定与不折行测试，并与第 2 条的单一 Task registry 共用实时状态真相源。

---

## 已排除问题

- 什么问题：把这轮范围扩大到通用子 agent 基础设施、文件化可编排基础设施或废弃的子 agent 并发文档。
  为什么排除：需求已限定为最早期 `Task` 工具用户面，即主 agent 并发派子 agent 查询/阅读内容的模块；其它模块会导致范围失控。
- 什么问题：把子 agent 的所有中间步骤完整写入主对话 transcript 或 scrollback。
  为什么排除：`subagent-execution` 已把子 agent 中间过程定义为内部上下文，用户只需要主 agent 综合后的答案与必要运行摘要；全量展开会污染主会话并放大噪音。
- 什么问题：为子 agent 详情做 alt-screen 可滚动面板或复杂折叠 UI。
  为什么排除：当前终端接入面没有应用层 UI 状态，alt-screen 内滚动也不可靠；本轮应沿 main buffer scrollback、状态栏和紧凑行摘要优化。
- 什么问题：给每个子 agent 增加用户主动单独取消按钮或命令。
  为什么排除：现有中断语义是父 turn 级联取消，单子 agent 取消会改变 abort 粒度和运行协议；这超出本轮轻量 UI/交互优化边界，应作为独立架构需求评估。
- 什么问题：直接删掉 `Task` 工具或把 Subagents 并入文件化编排能力。
  为什么排除：`Task` 面向临时研究型并发查询，文件化编排面向持久流程，两者用户价值和生命周期不同；本轮目标是优化早期模块，不是移除能力。
- 什么问题：取消 `Task -> sub-agent-status` 策略，让 Task 回到普通工具 batch 渲染。
  为什么排除：普通工具 batch 会把 LLM 内部 tool result 与原始 trailer 当普通工具卡片展示，既噪音大又可能和状态栏双重渲染；应新增专用摘要渲染，而不是退回默认策略。
- 什么问题：在 CLI 渲染层直接解析 `<usage>` trailer 来得到子 agent 用量。
  为什么排除：`<usage>` 是 orchestrator 侧给主 LLM 的私有文本协议，已有 `parseTaskUsageFromMessages` 和 runtime 结构化用量面；终端 UI 应消费结构化事件/投影，避免多个接入面各自理解私有格式。
- 什么问题：子 agent 没有 `write / edit / bash` 等写入或执行类工具。
  为什么排除：当前需求定位是并发查询、阅读和审查，写入/执行类工具会扩大权限与副作用面；不开放这些工具符合只读调研型子 agent 的边界。
- 什么问题：状态栏把子 agent 的 LLM token 也计入本轮运行中的 token 数。
  为什么排除：状态栏展示的是这一轮用户请求造成的总体 LLM 消耗，子 agent 消耗属于本轮总成本；细分成本已由 `/usage` 的子任务拆分承担，不应从状态栏总数中剔除。
- 什么问题：把 Task 工具的 `process/exec` 边界改成需要用户确认的高危工具边界。
  为什么排除：Task 是 orchestrator 内部派生子 agent 的只读调研入口，实际文件/网络权限仍由子 agent 的具体工具和安全链路承担；把内部调度本身升级为高危确认会破坏交互流，且不能替代具体工具的权限控制。
- 什么问题：把无 workdir 场景下 Task 仍可出现单独拆成一个新问题。
  为什么排除：真实风险已经由“Task 说明与实际 child tool surface 同源”方案覆盖；若无 workdir 导致子工具面为空或能力不匹配，应在同一工具说明/启用条件问题里解决，单独列项会重复。
- 什么问题：把 `tool-card-format.ts` 中 Task 的 display / target 分支单独列为本轮功能问题。
  为什么排除：当前 `Task` 由 `sub-agent-status` 策略从 batch 卡片路径剥离，这些分支不影响用户行为；是否删除或正式接入应随专用完成摘要和统一子任务展示格式自然处理，单列会把实现清理当成架构问题。
- 什么问题：把 `maxCallsPerTurn` 超限或严格输入校验拒绝的 Task 渲染成子 agent 失败终态。
  为什么排除：这类调用没有派生子 agent，属于给主 LLM 自我修正的输入级工具错误；伪造 child 生命周期或纳入子任务摘要会混淆“未启动”和“已运行后失败”的语义。
- 什么问题：本轮立即实现 `tool:child_start/end` 与 `sub-agent-result` 的 RPC 转发。
  为什么排除：当前只需保证事件和展示元数据可序列化、保留 lineage/父子 id 且不夹带 stream；实际 wire 投影必须随 unified-core 的多接入面收编统一设计，局部转发会提前固化不完整协议。

---

## 用户使用的提示词

```
任务：完成一轮审查；

你作为执行者再次去理解并审查架构设计。只审查，不能直接修改架构；
你的意见非常重要，因为最终是由你来执行的，所以你必须理解和认可架构设计。
有任何你不理解或不认可的问题都要提出来。 

发现问题收集进入“架构审查问题收集”文档，这个问题必须真实，绝对不能和文档中已发现的问题重合，否则你审一辈子都审不完了。
排除的问题进入 “已排除问题”列表，避免下次再在这个问题上耽误时间；

一轮审查的结束条件：
直到除了收集文档中已有的问题，找不见新的问题，这轮审查结束，直接回复简要信息

审查标准： 

以顶级产品经理、顶级架构师、顶级智能体专家的身份思考，以"首席产品官 +乔布斯直觉判断；想法是否能经得起时间的检验，在未来仍然是好的产品吗？是顶级产品和架构吗？
注意宏观视角看整体架构、要可维护、可扩展、可插拔，需要最佳代码实践方案
我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计；
要回归到产品需求本质、要经得起时间的检验、在未来仍然是好的产品；

注意：
1、审查前先建立并逐项扫完固定核查矩阵：状态面、入口面、消费方、生命周期、异常路径、安全边界、模块边界、测试验收；问题先收集并去重，不得沿“最新发现的问题”做邻近扩散式增量审查。不允许发现问题就提前收口；直到矩阵全部扫完再统一裁决。
2、回复风格为“言简意赅”，直接说重点，不要说低价值信息；

执行纪律：看到“先建立并逐项扫完固定核查矩阵”“不允许发现问题就提前收口”“不得增量审查”，必须按硬流程执行，绝对不允许嘴上认可、行为上还是被单个问题牵着走。

严禁被单个问题牵着走；

```

---

```
请检查收集的问题文档中每个问题
1、问题是否真实？
2、问题的解决方案，是否为你作为执行者认为的最优解。
如果不是最优方案，请修改，但必须精简，不要长篇大论。
```

---

```
执行者又发现了一些问题，都放在了这个文档中“架构审查问题收集”；
作为架构者，你看一下这些问题是否真实？你是否认可？
如果你认可的话，对每一个问题都给出你作为架构师的最优解决方案，
要足够精简，不要长篇大论，
用文本的形式直接回复我，不要修改。
你的这个方案是要给执行者说的。
```

---

```
这是架构者对所有问题的分析以及方案
你看一下是他的方案更好，还是你的方案更好？或者结合两个方案的优点给出更优的版本
如果得出更优的版本，把最新方案更新到问题收集列表中；不需要维护多版本记录，只关注最新方案：

```

---

```
执行者结合你给的信息，更新了收集的问题列表。你看一下最新的解决方案，是否认可？认可的话由他来执行。
```

---

```
行，那你把问题收集列表清空一下，我们准备开始下一轮问题搜集。
如果一整轮没有发现任何问题，那审查阶段彻底结束，准备开始动手实现；
```

---
