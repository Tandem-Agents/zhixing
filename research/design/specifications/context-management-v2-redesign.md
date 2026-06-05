# 上下文管理 · v2 重构方向 (Context Management v2 Redesign)

> ⚠️ **DEPRECATED（2026-05-11 起）**
>
> 本方案的"滑动窗口 + 任务纪要 + capability LRU"范式与 Anthropic prompt cache 元规则①（前缀任何位置变化让其后内容缓存失效）冲突。已被 [`context-management-v3-redesign.md`](./context-management-v3-redesign.md)（cache 第一优先 + 优质注意力窗口 + 段式管理 + tools 满载稳定）取代。本文保留为决策痕迹，不再作为实施依据。
>
> 另注：本文多处"system prompt 启动构造一次、永远 byte-equal"是 v2「不引入运行时重建」语境下的表述。cache 不变量的范围其后已收窄为「**单个注意力窗口**内 byte-equal、跨窗口边界（段切换 / compact / clear / resume）才允许重建」，不是 runtime 永久不变——以 [`context-management-v3-redesign.md`](./context-management-v3-redesign.md) / [`../drafts/lifecycle-concepts.md`](../drafts/lifecycle-concepts.md) 为准。本文正文保留原貌、不逐处订正。
>
> ---
>
> **状态**: 📐 方向已敲定（2026-05-08），spec 阶段未启动
> **定位**: 描述上下文管理的 **v2 演进方向 + 实施计划**——在业务真实路径（`orchestrator/system-prompt.ts` + `core/context/turn-context.ts` + v1.2 数据层）之上扩展 + 加视图层（ContextCompiler 3-Stage）+ 主动管理 messages（滑窗 + 任务纪要生成）+ **复用现有 `TurnContextInjector`** 注入 per-turn 动态状态 + 砍 v1.2 设计稿但与业务路径不兼容/价值不足的死代码 + 砍冗余的 tool_result tier 压缩。实施完成后并入 [context-architecture.md](./context-architecture.md) 升级为 v2.0，本文废弃。
> **关联**:
> - [context-architecture.md](./context-architecture.md) — v1.2 文档权威
> - [turn-context-injection.md](./turn-context-injection.md) — TurnContextInjector / TurnContextProvider 现有规格
> - [../innovations/capability-compiler.md](../innovations/capability-compiler.md) — Q1.A 完整设计
> - [../innovations/tool-result-anchor.md](../innovations/tool-result-anchor.md) — Q1.B 完整设计
> - [conversation-model.md](./conversation-model.md) — Conversation / Transcript 数据模型

---

## 一、问题背景

### 1.1 触发场景

2026-05-08 用户实测 dump 日志：已恢复对话 chat-20260504-41b4 累积 481 messages（240+ 轮 turn × user+assistant），但 `usageRatio` 仅 ~10-15%，远低于 compact 阈值 85%——上下文系统视为"正常"。实际现象：

- 长上下文下输出"混乱回答"——注意力稀释症候
- 即使 messages 仅 1 条，tools schema 仍占 96% payload（10 工具完整 schema ~10K tokens）
- 481 messages 中大量短闲聊（"你好" / "OK" / "1"）——占 token 但对当前任务零价值

> 注：481-message 案例是 `/clear` 持久化 fix（commit 5c4de96）之前的 artifact，今天不可严格复现，但触发动机仍有效。

### 1.2 根因

四类问题叠加：

1. **业务真路径缺少 v2 想要的能力**：tools schema 满载；老 tool_result 累积消耗 token + 弱化注意力；缺少 LLM 任务列表 + 任务纪要机制
2. **v1.2 设计稿与业务路径不兼容/价值不足**：LayerAssembler 4 层语义 + ScenarioEvaluator 关键词分类 + ContextProfile 参数化是一套场景化捆绑套件，业务零调用方且独立价值不足
3. LLM 看到截断提示"可通过 recall_history 恢复"会去调一个**不存在的工具** → unknown tool 错误
4. **messages 历史无主动管理**：累积所有 turn 全量发 LLM，弱模型 attention 滤波能力不足时被低价值历史稀释；v1.2 阈值（85%/95%）按强模型默认，弱模型场景下几乎永不触发

### 1.3 影响

- 短对话每次浪费 ~10K tokens 在不需要的 tools schema
- 长 agent 任务 tool_result 无瘦身
- 用户对"AI 当前任务进度"无可控感
- LLM 看到截断提示但工具不存在 → unknown tool 错误，铁律 3"信息可恢复"是空头承诺
- 弱模型长上下文输出混乱（用户实测：作长诗时穿插随机文件名 / 项目名 / 网络字符）

### 1.4 v2 设计方向

**保留 v1.2 真实生效部分 + 复用现有基建 + 加视图层 + 主动管理 messages + 砍死代码 + 砍冗余压缩**：

- **保留**：
  - v1.2 数据层（onTurnComplete + 3 压缩策略 [`MemoryFlush` / `MessageDrop` / `LLMSummarize`]，砍 `ToolResultTrim` 后从 4 减为 3；`MemoryFlush` 实现位于 `core/src/memory/flush-engine.ts`，非 `context/strategies/`）+ `manageWindow` 的 Pin/eviction + **`applyTierCompression`**（数据层 tool_result 体积管理；维持 `state.messages` 紧凑、保 budget baseline 准确）
  - 业务真路径（`system-prompt.ts:buildSystemPrompt` 启动时构造一次 + `AgentRoleProfile`）
  - **现有 `TurnContextInjector` 基建**（`core/src/context/turn-context.ts`）+ `TimeProvider` / `SchedulerProvider`：v2 在同一接口下追加 task-list / task-briefs / migration-summary 三个 provider
  - memory 工具 + 全部业务工具
- **改造**（不触及 calling convention，不触及 system prompt 静态构造）：
  - `manageWindow` Pin 语义改为 `in_progress` 任务驱动；`isPinned` callback 全面传播到 `MemoryFlush` / `MessageDrop` / `LLMSummarize` / 视图层
  - **transplant `SYSTEM_META_PROMPT_SECTION`** 到 live `system-prompt.ts` always-on segment（修复当前 `<system-meta>` 标签解释段仅在 dead `LayerAssembler` 引用的 bug；transplant 后 `system-prompt.ts` 静态部分仍然 byte-equal）
  - `estimator calibration baseline` 切换：`create-agent-runtime.ts:773-775` 从 `estimateMessages(state.messages)` 改为 `estimateMessages(renderedMessages)`（view-layer 输出）；保 calibration 系数与 LLM 实际处理的 size 对账
  - `ConversationRepository.writeMeta` 升级：atomic write (tmp+rename) + per-id lock，承载 view-layer state 高频写入
  - `/clear` 完整重置：同步清空 transcript + state.messages + 全部 view-layer state（taskBriefState / capabilityState / migrationSummaryState / taskListState）
  - **`TurnContextInjector` inject() 调用点改造**：v1.2 inject 是 per-run（`create-agent-runtime.ts:642` 调一次） → v2 改为 per-LLM-call（每次 streamLLMCall 之前调一次）。**保**：实例 + provider 注册接口 + `runAgentLoop` 外部签名。**改**：`:642` 调用点移入 agent-loop 内部（ContextCompiler 之后）。**为什么必须**：Q3 task brief / mid-run task_list 更新需要后续 streamLLMCall 实时观察到 → per-run inject 不够
- **加层**：streamLLMCall 之前加 ContextCompiler 视图层（**3-Stage**）：Q1.A schema 编排 / Q1.B 老 result 锚化 / Q3 滑窗与任务纪要生成
- **加 provider**：在现有 `TurnContextInjector` 注册 3 个新 TurnContextProvider 实现（`ActiveTaskListProvider` / `TaskBriefsProvider` / `MigrationSummaryProvider`）——它们读 view-layer state，自动注入 user message 的 `<turn-context>` 块，**不修改 system prompt，不破坏 prompt cache**
- **砍**：
  - v1.2 场景化整套（LayerAssembler / ScenarioEvaluator / ContextProfile）+ TurnDigest
  - **`ToolResultTrim` 策略**（与 `tier-compressor` 数据层 tier 截断职责真冗余——都是按 turn-distance 截断 tool_result，tier-compressor 更精细；strategies 4 → 3）
  - `ScenarioHint` 字段（`Conversation.currentHint?` 当前定义但从未持久化）
  - 配套死方法
- **从零实现**：`recall_history` 工具

**v2 不做**（留 v3）：Persistent Knowledge 自动相关性检索 + 注入。memory 工具范围保持现状（手动 `save` / `search`），用户/LLM 通过它存取长期事实；自动相关性检索引擎留 v3。

**核心架构哲学**：v2 复用项目现有的"per-turn 动态上下文 → user message `<turn-context>` 块"机制，不另起炉灶；system prompt 静态构造 + byte-equal cache 命中**完全保留**，calling convention（`runAgentLoop` / `runSubAgentLoop` / `factory.ts` / `llm-call.ts`）**完全不动**。

**两条 baseline 共存**：
- **estimator calibration baseline = view-layer rendered messages**：保 estimator 校准系数与 LLM 实际处理的 size 对账
- **budget evaluation baseline = state.messages**：保 state.messages 体积兜底（防止内存/磁盘无限累积，触发 3 个数据层策略）

---

## 二、v1.2 现状评估（实测审计后的精确事实）

通过 grep 主路径调用链路 + dump 日志验证：

### 2.1 主路径生效（v1.2 真实落地的部分）

| 模块 | 调用路径 | v2 处理 |
|---|---|---|
| `TranscriptStore` / `commitTurn` / `TranscriptStore.load` | run() 主路径 | 保留 |
| `ContextEngine.onTurnComplete` | `agent-loop.ts:323/428` 每轮 | 保留 |
| `ContextEngine.checkBudget` | onTurnComplete 内 + run() 末尾 | 保留（baseline 仍是 state.messages） |
| `ToolResultTrim` (priority 0) | distance≥4 turn 才裁老 result | **砍**（与 view-layer Q1.B 冗余） |
| `MemoryFlush` (priority 3) | usage >= 0.75 | 保留（**接受 isPinned**） |
| `MessageDrop` (priority 5) | budget compact (>=0.85) | 保留（**接受 isPinned**） |
| `LLMSummarize` (priority 200) | usage >= 0.9 | 保留（**接受 isPinned**：Pin 内 turn 不进 split summarize 范围） |
| `manageWindow` 的 Pin + eviction | onTurnComplete 内每轮 | 保留（Q3 复用，Pin 语义改 `in_progress` 驱动） |
| `manageWindow` 的 `applyTierCompression` 步骤 | onTurnComplete 内每轮预防性 tier 截断 | **保留**（数据层 state.messages 体积管理；与 view-layer Q1.B 各司其职——tier-compressor 管 lossy 字符截断 + budget baseline 准确，Q1.B 在其输出上再做语义锚化升级） |
| `state.messages` 写回（agent-loop:443） | onTurnComplete 触发压缩则 state 被更新 | 保留 |
| **`orchestrator/system-prompt.ts:buildSystemPrompt`** | `create-agent-runtime.ts:416` **启动时构造一次** | **保留不动**（仅 transplant `SYSTEM_META_PROMPT_SECTION` 进静态 segment；不引入 builder 化，保 prompt cache byte-equal 命中） |
| `AgentRoleProfile` + mainProfile / subAgentProfile | `profile/agent-role-profile.ts` | 保留 |
| **`TurnContextInjector` + `TimeProvider` + `SchedulerProvider`**（`core/src/context/turn-context.ts`） | `create-agent-runtime.ts:425-486` 启动时实例化 + register；`:642` **per-run() 入口注入一次**（agent-loop.ts 内部不调 inject） | **保留 + 扩展 + 调用点改造**（追加 3 个新 provider 注册，但 **inject() 调用点 Phase 0 必须改造**：从 per-run 移入 agent-loop 内部 per-LLM-call 注入；否则 task_list / task-briefs 等 mid-run 状态变更，下一次 streamLLMCall 看不到——见 §9.2） |
| 8 个工具（read/write/edit/glob/grep/bash/web_fetch/schedule）+ memory 工具 | `tools-builtin/src/` | 保留 |
| `ConversationRepository.writeMeta` | 用户行为级写入（rename/archive/touch） | **升级**：atomic write + per-id lock，承载每 LLM call 的 StateDelta 应用 |
| `create-agent-runtime.ts:773-775` estimator calibration | 用 `estimateMessages(state.messages)` ↔ API `input_tokens` 对账 | **改造**：用 `estimateMessages(renderedMessages)` ↔ API `input_tokens`（renderedMessages = view-layer 输出） |

### 2.2 死代码砍除（业务零调用方 + 与业务路径不兼容/价值不足）

| 模块 | 砍除理由 |
|---|---|
| **`TurnDigest` 模块**（`turn-digest.ts` + `digestHistory` + `addTurnDigest` / `getTurnDigests` + 19 测试 + index 导出） | 程序自动机械面包屑业界对照否定，意图被 task_list + Q3 任务纪要替代 |
| **`LayerAssembler` 整个模块** | 4 层语义与业务真路径 segment 体系不同方法学；失去 ContextProfile 驱动后无独立价值 |
| **`ScenarioEvaluator` 模块** | 中文 + 复杂语义场景下关键词正则不可靠 |
| **`ContextProfile` 体系** | 失去 ScenarioEvaluator 驱动后无价值；`BudgetThresholds` 类型已在 `context/types.ts:62-69`（context-profile.ts 是 import 进来的，不需搬）；只需把 `TierThresholds` 类型从 `context-profile.ts:39-46` 搬到 `context/types.ts`；ContextEngine 配置接口直接接受 `budgetThresholds` + `tierThresholds` 入参 |
| `ContextEngine.buildSystemPrompt` 方法 | 配套 LayerAssembler |
| `ContextEngine.addTurnDigest` / `getTurnDigests` + `digestHistory` 字段 | 配套 TurnDigest |
| **`ToolResultTrim` 策略** | 与 `tier-compressor` 数据层 tier 截断职责真冗余（都是按 turn-distance 截断 tool_result，tier-compressor 更精细，多分级也更克制）；strategies 4 → 3 |
| **`Conversation.currentHint?: ScenarioHint`** 字段 + `ScenarioHint` 类型 | 字段定义但 `ConversationRepository` 从不读写，业务零依赖；随 ScenarioEvaluator 砍除一并清理 |

**recall_history 工具**：v1.2 仅在 `tier-compressor.ts` 注释 + 截断提示文本中字符串提及，工具完全不存在 → **Phase 0 从零实现**（兑现 v1.2 空头承诺）。

**`SYSTEM_META_PROMPT_SECTION` 常量**：当前仅在 dead `LayerAssembler` 中引用，业务真路径 `system-prompt.ts` 不含；导致生产环境下 LLM 一直在没有解释的情况下消费 `<system-meta>` 标签 → **Phase 0 transplant 到 live `system-prompt.ts` 的 always-on 静态 segment**（删 LayerAssembler 之前必做；transplant 后 system-prompt 静态构造仍然 byte-equal）。

### 2.3 v1.2 单一权威 system prompt 路径

```
路径 A（业务真用，每个 conversation 启动时构造一次，永远 byte-equal）：
  create-agent-runtime → orchestrator/system-prompt.ts:buildSystemPrompt
                       → 静态 segments (identity / principles / tool-usage / sub-agent-delegation
                          / skill-evolution / style / safety + transplanted SYSTEM_META_PROMPT_SECTION)
                       → __ZHIXING_CACHE_BOUNDARY__
                       → 静态尾部 (buildEnvironment - cwd / workspace / platform / Node)

路径 B（v1.2 设计稿，业务零调用方）：
  ContextEngine.buildSystemPrompt → core/context/layer-assembler.ts → L0/L1/L2/L3
  ⛔ 整体砍除（与路径 A 设计哲学不兼容）

每轮动态内容（v2 沿用同一机制）：
  TurnContextInjector + 多个 TurnContextProvider → user message 内 <turn-context> 块
  （不修改 system prompt，保护 prompt cache）
```

v2 后**只剩单一权威路径 A**（不动），加上现有 `TurnContextInjector` 扩展（追加 3 个 provider）。

---

## 三、v2 设计方向总览

| 设计 | 作用域 | 完整文档 |
|---|---|---|
| **Q1.A Capability Compiler** | API `tools[]` 数组的 schema 暴露（每次 LLM call）；system prompt 文本 byte-equal 不动 | [../innovations/capability-compiler.md](../innovations/capability-compiler.md) |
| **Q1.B Tool Result Anchor** | messages 中的 tool_result.content（视图层语义锚化升级；与数据层 tier-compressor 各司其职） | [../innovations/tool-result-anchor.md](../innovations/tool-result-anchor.md) |
| **Q2 任务列表（v2 范围内）** | user message `<turn-context>` 块（通过 `ActiveTaskListProvider` 注入） | 本文第六节 |
| **Q3 滑窗 + 任务纪要生成** | messages 视图层（user/assistant text 主动选取 + 任务边界生成纪要）+ user message `<turn-context>` 块（通过 `TaskBriefsProvider` / `MigrationSummaryProvider` 注入） | 本文第七节 |
| **架构演进：ContextCompiler 渲染层** | 每次 LLM call 之前的视图编排（默认全启用，3-Stage） | 本文第八节 |
| **死代码 + 冗余清理** | 砍场景化整套 + TurnDigest + tier 压缩冗余 + 实现 recall_history + transplant SYSTEM_META | 本文第九节 + Phase 0 |

四者共享同一哲学：**v2 是 v1.2 数据层 + 业务真路径 + 现有 `TurnContextInjector` 之上的视图层增强**——磁盘 transcript 由 v1.2 持久化层管理（受其阈值压缩约束），state.messages 是工作集，ContextCompiler 视图层在每次 LLM call 之前编排，per-turn 动态状态由 `TurnContextInjector` 注入 user message `<turn-context>` 块。

---

## 四、Q1.A Capability Compiler（概要）

完整设计见 [../innovations/capability-compiler.md](../innovations/capability-compiler.md)。

### 4.1 核心机制

把 tools schema 从"预注册全集每次满载"颠覆为**会话级演化的分层 state**，由 `ToolSchemaCompilerStage` 每次 LLM call 前编译——**只决定 API `tools[]` 数组**，**不影响** system prompt 文本：

| 层 | API `tools[]` 数组 | system prompt `tool-usage` 文本 | 触发 |
|---|---|---|---|
| Always | 完整 schema | 永远列出完整 hints（含 systemPromptHints） | `memory` + `recall_history` + `task_list` + `request_capabilities` |
| Hot | 完整 schema | 永远列出完整 hints（含 systemPromptHints） | 7 轮 LRU 内活跃的非 Always 工具 |
| Discoverable | **不暴露** | 永远列出完整 hints（含 systemPromptHints） | profile 内但 7 轮内未活跃 |
| Cold | **不暴露** | 不出现 | profile 排除 / sub-agent 隔离配置 |

**关键不变量**：`tool-usage` 段文本在 conversation 期间 byte-equal——profile 决定的非 Cold 工具集合是固定的；该段输出**所有非 Cold 工具的完整 hints**（含 `systemPromptHints` 详细使用引导，如 `read 后总应检查关键区域` 等），但**不含 schema**（schema 只在 API `tools[]` 数组）。capabilityState 演化只影响 API `tools[]` 数组动态。LLM 视角：通过 system prompt 知道工具存在 + 详细用法概念；通过 API `tools[]` 知道当前哪些工具能直接调（含完整 schema）；调 Discoverable 工具时 cli 静默升级到 Hot 并**直接执行**（参数从 hints 语义推断），LLM 看到的就是普通 tool_result —— 若参数猜错，LLM 在下一轮（此时 tools[] 已含完整 schema）凭 error tool_result 自修正再调一次，与"调用-报错-修正"的常规循环同形态。LLM 视角的 system prompt cache 完全不受 capabilityState 演化影响。

### 4.2 LLM ↔ 程序双向契约

- LLM 直接调用 Discoverable 工具（API `tools[]` 中没有，但 system prompt 提示存在）→ cli 拦截 → 静默升级 Discoverable → Hot → **直接用 LLM 提交参数执行** → 返回 tool_result（参数错时 LLM 下一轮凭完整 schema 自修正再调）→ 0 轮额外延迟、无双倍计费
- LLM 用 `request_capabilities` 元工具批量预热（声明"我接下来要用 X / Y / Z 工具"）→ cli 升级到 Hot
- LLM 视角永远只有一个简单契约："system prompt 列出的工具都能直接调"

### 4.3 双层 cache 友好性

- **system prompt cache**：`tool-usage` 段 byte-equal → CACHE_BOUNDARY 之前永远命中 prompt cache
- **API `tools[]` cache**：进入任务稳态后 Hot 集稳定 → tools 数组不变 → 命中 tools 部分 cache；短对话场景从 ~10K tokens 降至 ~300 tokens

两层 cache 独立——system prompt cache 不被 capabilityState 演化破坏，tools cache 在稳态内仍可命中。

---

## 五、Q1.B Tool Result Anchor（概要）

完整设计见 [../innovations/tool-result-anchor.md](../innovations/tool-result-anchor.md)。

### 5.1 核心机制

按"消化状态"两态划分 tool_result：

| 状态 | 形态 | 触发 |
|---|---|---|
| **Focus** | 完整 raw | 最近一次 `tool_use` 的 result |
| **Anchor** | 事实锚（程序自动生成的结构化事实占位） | 其他历史 result |

事实锚示例：

- `[read src/foo.ts, 1235 lines]`
- `[bash "npm test", exit=0, 47 lines]`
- `[grep "TODO", 23 matches in 7 files]`

### 5.2 数据层 tier-compressor 与 view-layer Q1.B 各司其职

二者**不冗余**——是不同层的不同职责：

| 层 | 模块 | 职责 | 形态 |
|---|---|---|---|
| 数据层（`onTurnComplete` 内） | `applyTierCompression` | 管 `state.messages` 体积 + 维持 budget baseline 准确 | lossy 字符截断（T1 全保留 / T2 → 2000 chars / T3 → 500 chars / T4 → 骨架） |
| 视图层（每次 LLM call 之前） | `ToolResultAnchorStage` (Q1.B) | 管 LLM 认知视图质量 | structured semantic anchor（如 `[read foo.ts, 1235 lines]` / `[bash "npm test", exit=0, 47 lines]`） |

**协作模式**：
- 数据层 tier-compressor 在 `onTurnComplete` 内修改 `state.messages`——保 disk/memory 不无限累积，保 `budget.calculateBudget(state.messages)` ratio 准确反映实际占用
- 视图层 Q1.B 在 `state.messages` 之上做**语义升级渲染**——把 tier-compressor 留下的内容（无论是 T1 全文、T2/T3 截断、还是 T4 骨架）渲染为 LLM 易解析的结构化 anchor
- Q1.B 在 T1 范围（distance ≤ T1）效果最佳——能从 tool_result 头/full 内容提取精确 metadata（filename / line count / exit code 等）；T2 范围以截断字符为输入，提取部分 metadata；T4 骨架则透传（已是 anchor 形态）
- **不存在 view-layer 改写 state.messages**（视图层纯函数渲染）

**ToolResultTrim 策略砍除**——它和 tier-compressor 都是按 turn-distance 字符截断，tier-compressor 多分级更精细更克制；ToolResultTrim 是 budget-triggered 二次截断，与 tier-compressor 重复。

**budget critical 时的兜底**：view-layer Stage 失败 → tool_result 原样发；数据层 tier-compressor 仍在跑（state.messages 受控）；budget 阈值触发时 `LLMSummarize` 全局摘要兜底（含 tool_result 一起摘）。

### 5.3 LLM 取回原内容

调 `recall_history(toolUseId | turnRange)` 工具（Phase 0 从零实现）——返回**当前磁盘状态**：compact frontier 之后的 turns 完整 raw，frontier 之前的内容仅能从 `CompactMarker.summary` 还原（v1.2 持久化模型，v2 不改）。

---

## 六、Q2 任务列表（v2 范围内）

### 6.1 二层结构

| 层 | 内容 | 实现位置 |
|---|---|---|
| **Working Memory（基础保留）** | 最近 messages | v1.2 数据层（manageWindow Pin/eviction + 3 压缩策略）+ Q3 视图层滑窗 |
| **Active Task List** | AI 维护的当前任务列表 | LLM 主动调 `task_list` 工具 + **`ActiveTaskListProvider` 注入 user message `<turn-context>` 块** |

**v2 不做** Persistent Knowledge 自动相关性检索 + 注入。详见 §6.3。

### 6.2 Active Task List

学 Claude Code TodoWrite 范式，简化适配。

#### 工具

```ts
task_list.set(items: Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
}>): void;
```

单一动作。LLM 任务过程中调用更新 list。

#### 注入 LLM 视图

通过现有 `TurnContextInjector` 基建（`core/src/context/turn-context.ts`）：

```ts
class ActiveTaskListProvider implements TurnContextProvider {
  readonly id = "task-list";
  constructor(private readonly getTaskList: () => TaskListState) {}
  shouldInject() { return this.getTaskList().items.length > 0; }
  render() {
    return { title: "当前任务列表", body: ... };
  }
}
```

启动时在 `create-agent-runtime.ts` 注册到 `TurnContextInjector`，跟 `TimeProvider` / `SchedulerProvider` 同模式。每次 LLM call 之前 injector 自动 inject 到最新 user message 的 `<turn-context>` 块（**Phase 0 改造 inject 调用点**：从 v1.2 的 per-run（`create-agent-runtime.ts:642`）移入 agent-loop 内部 per-LLM-call；详见 §9.2）。

#### 用户可见

cli 渲染当前任务列表：

```
☐ 读取并分析 cli 路由结构
◐ 拆分 router.ts 到独立 handlers 文件
☐ 更新引用 router 的代码
✓ 跑通现有测试
```

#### 用户命令

| 命令 | 功能 |
|---|---|
| `/tasklist` | 查看当前任务列表（v1 只读） |
| `/task <desc>` | 用户主动追加任务项 |
| `/task new` | 显式开始新任务 |
| `/task done <id>` | 用户标记某项完成（同时触发 Q3 任务边界，生成任务纪要） |

#### 持久化

`task_list` 状态 + 当前 `in_progress` 任务的 raw turn 范围（用于 Pin 判定）一起持久化到 conversation meta。

### 6.3 Persistent Knowledge — v2 不做（v3 评估）

memory 工具当前实测：
- **没有** persistent 标记字段（所有条目默认 persistent）
- **没有**相关性检索（只有关键字搜）
- **没有**自动注入机制
- `subAgentSafe: false` —— sub-agent 不能调，关键事实保存只在 main agent context 发生

v2 决策：第一版**不做** Persistent Knowledge 自动注入：

- 用户 / LLM 通过现有 memory 工具**手动** `save` / `search`
- **不引入** `persistent-knowledge` provider 或 system prompt segment
- v3 评估时再做完整 retrieval / injection 系统（含 schema 扩展 + 相关性引擎 + 注入管道）

**Q3 任务纪要的"关键事实保留"路径**：LLM 在任务完成时主动调 `memory.save` 保存关键事实——条目长期保留在 memory store；v2 不自动注入，LLM 后续需要时主动 `memory.search`。等于现有 memory 工具的标准用法，无新机制。

### 6.4 用户屏幕 vs LLM 视图解耦

- 用户屏幕：当前 transcript（与磁盘持久化状态一致；LLMSummarize 触发后旧 turns 被 CompactMarker 摘要替代，前端渲染 marker.summary）
- LLM 视图：每轮 ContextCompiler 编排——老 tool_result 锚化 + 滑窗截取 + 任务纪要生成（Q3）+ 工具 schema 编排；最新 user message 由 `TurnContextInjector` 自动注入 `<turn-context>` 块（task-list / task-briefs / migration-summary 等）

user/assistant text 视图层在 Q3 引入后**主动管理**：滑窗外的 raw turns drop 出 LLM 视图（磁盘 transcript 由 v1.2 持久化层独立管理，受其阈值压缩约束；`recall_history` 返回**当前磁盘状态**），任务边界达成时收编为任务纪要；详见 §七。v1.2 数据层兜底独立运行。

---

## 七、Q3 MessageWindowStage 滑窗 + 任务纪要生成

### 7.1 核心动机

第一性原理拆解 Q2 现方案盲点（"加段做 attention 锚 ≠ 减噪音"）：

- LLM 是条件概率推断函数——输入信噪比（SNR）直接决定输出质量
- 弱模型 attention 滤波能力不足时，光加结构化信号（task_list）盖不过 raw history 噪音
- 必须在 user/assistant text 那一层做主动选取（减噪音），而非仅靠加段（加信号）

业界对照（Claude Code 92% / Hermes 50% / OpenClaw 50% 阈值兜底）共有盲点：默认强模型 + 大窗口 → 晚动手。知行差异化定位（弱模型 + 长期陪伴 + 短/长双形态）→ **默认早动手**。

### 7.2 核心机制

每次 LLM call 之前，`MessageWindowStage` 把 raw `state.messages` 编排为：

```
LLM 视角的 messages =
  ├─ 滑窗最近 N 轮 raw（user+assistant 配对，含 in_progress 任务的 Pin 保留）
  └─ 新 user input  ←── TurnContextInjector 在此追加 <turn-context> 块：
                          ├─ [active-task-list]   当前任务列表（task_list 状态非空时）
                          ├─ [task-briefs]         已完成任务纪要（21 cap，按时间倒序）
                          └─ [migration-summary]  仅老 conversation 恢复后存在 + K 轮内有效
```

raw 全量在磁盘（受 v1.2 持久化层 compact 约束），`recall_history` 工具按当前磁盘状态取回。

### 7.3 滑窗规则

| 项 | 决策 |
|---|---|
| 单位 | "轮"（user+assistant 配对） |
| 默认窗口 | N = 12 轮 |
| 配置开放度 | 留给 spec 阶段评估 |
| **Pin 例外** | 当前 `in_progress` 任务的全部 raw turns 不参与驱逐（即使跨越 20+ 轮） |

**Pin 全面传播**：orchestrator 持有 `taskListState`，构造 `isPinned: (messageIndex) => boolean` callback，传给所有需要它的层：

| 层 | 用途 |
|---|---|
| `manageWindow.evictOldestTurns` | 数据层 eviction 跳过 Pin 内 turn |
| `MessageDrop.apply` | 物理删 turn 时跳过 Pin 内 turn |
| `LLMSummarize.apply` | `splitMessagesPairAware` 改 pin-aware：Pin 内 turn 不进 summarize 范围（保 raw） |
| `MessageWindowStage` | 视图层滑窗保留 Pin 内 raw turn |

**实现路径**：`taskListState.in_progress` 项关联的 turn 范围由 orchestrator 维护，每轮更新；orchestrator 把 turn 范围映射为 message index range，构造 `isPinned(messageIndex)` callback 注入数据层与视图层（数据层不读视图层 state，避免跨层耦合）。任务标 done 后该范围从 Pin 集合移除 → 该任务期间的 turns 一次性收编为任务纪要（见 7.4）。

### 7.4 任务纪要（Task Brief）

**生成时机**：任务从 in_progress 转 completed（任务边界达成）那一轮，Stage 2 同步触发 `TaskBriefSummarizer`（独立 strategy 类，详见 §九.3）。

**任务边界来源**（多源并存）：

| 来源 | 触发 |
|---|---|
| ① LLM 通过 `task_list` 工具 | 把某项 status 设为 `completed` 或整体清空 |
| ② 用户 `/task done <id>` 命令 | 显式标记 |
| ③ 长闲置自动触发 | >30 min 无消息（spec 阶段确认精确阈值） |

**不引入** LLM 自然语言声明"任务结束"。

**调度模型**：**inline-blocking 同步调度**（与现有 `LLMSummarizeStrategy` 一致，复用已有调度基建）。

- Stage 2 检测到任务边界 → 同步阻塞调用 `TaskBriefSummarizer.run(taskRawTurns)` → 返回纪要
- 输出 `StateDelta` 含新纪要；caller 在 LLM call 完成后应用（更新 `taskBriefState` + writeMeta）
- 当轮 LLM call 增加 1 次 LLM 往返延迟（acceptable——任务边界是低频事件，且发生在用户自然停顿处）

**多任务并发**：若一轮内多项同时 completed（如 LLM `task_list.set` 把多项设为 completed），并发调用 TaskBriefSummarizer（独立任务、独立摘要、独立失败），并发上限默认 3（spec 阶段确认）。

**失败语义**：`TaskBriefSummarizer` LLM call 失败时重试 3 次（指数退避）；仍失败 → emit `view:task_brief_failed` 事件 + 跳过纪要生成（任务边界仍消化，Pin 释放，纪要永久不存在）。**LLM 关键事实保留路径不依赖纪要**——LLM 在任务进行中通过 `memory.save` 保存的事实独立于纪要机制，纪要失败不影响关键事实兜底。

**任务纪要格式**（一行结构化摘要）：

```
[Done] 2026-05-08 14:30 · 重构 cli/router · 拆分 3 文件 (sha a1b2c3d) · 5 turns
```

**注入位置**：通过 `TaskBriefsProvider`（TurnContextProvider 实现）每轮自动 inject 到最新 user message 的 `<turn-context>` 块。Provider 读 `taskBriefState`，shouldInject() 在纪要列表非空时返回 true。

### 7.5 闲聊场景（无任务）

闲聊不形成任务纪要。滑窗外的 user/assistant turns 直接 drop 出 LLM 视图：

- 磁盘 transcript 由 v1.2 持久化层独立管理（**非永久** — LLMSummarize 阈值触发时按 `turnsCompacted` 截断旧 turns + 写 CompactMarker；v2 不改此机制）
- `recall_history` 按当前磁盘状态取回：compact frontier 之后的 turns 完整 raw，frontier 之前的内容仅能从 `CompactMarker.summary` 还原
- "印象层"由现有 memory 工具支撑——LLM / 用户主动通过 `memory.save` mark 的事实长期保留（v2 不自动注入）

**范式**：契合"AI 助手像朋友——只记印象不记每句话"的产品定位。

### 7.6 已恢复对话（v1.2 era）历史前缀处理

| 项 | 决策 |
|---|---|
| 触发 | 惰性 — 首次该 conversation 进入 v2 流程时跑一次 LLMSummarize |
| 范围 | conversation 起点到 v2 上线时刻之间的全部历史 |
| 缓存 | 结果 + 时间戳缓存到 conversation meta（`migrationSummaryState`） |
| 注入 | 通过 `MigrationSummaryProvider`（TurnContextProvider 实现）注入 user message `<turn-context>` 块 |
| 寿命 | **时限失效** — v2 在该 conversation 中运行 K 轮（默认 K=50）后，provider 的 `shouldInject()` 返回 false，自动停止注入 |

**降级**：如果 LLM 不可用（API 故障）→ 摘要生成跳过，老历史完全不可见 + recall_history 兜底。

### 7.7 与 v1.2 数据层 / 现有 TurnContextInjector 的关系

| 层 | 作用 | Q3 关系 |
|---|---|---|
| v1.2 数据层（onTurnComplete + 3 策略 + manageWindow） | 阈值兜底压缩 state.messages；所有策略接受 isPinned，跳过 Pin 内 turn | 共存 — 视图层独立运行；Pin 全面传播保证 in_progress 任务的 raw 不被数据层意外摘掉 |
| 现有 `TurnContextInjector` + `TimeProvider` / `SchedulerProvider` | v1.2 当前 per-run 注入（run 入口一次）；v2 改为 per-LLM-call 注入（每次 streamLLMCall 之前一次） | **复用 + 扩展 + 调用点改造** — 注册接口与实例不动；Q3 追加 3 个 provider（task-list / task-briefs / migration-summary）；**inject() 调用点 Phase 0 改造**为 agent-loop 内部 per-LLM-call（保 task_list / task-briefs mid-run 状态变更被后续 streamLLMCall 实时观察到） |
| 数据层 `applyTierCompression` | 每轮无条件压缩 state.messages tool_result（管体积 + 保 budget baseline 准确） | 视图层独立 — Q1.B 在 tier-compressor 输出之上做语义锚化升级；二者各司其职 |
| Q1.B ToolResultAnchorStage | 老 tool_result 语义锚化（视图层认知质量） | 顺序前置 — Q1.B 先锚化，Q3 再做滑窗截取 |

### 7.8 LLM 配合度风险与缓解

任务边界来源 ① 依赖 LLM 主动调 `task_list`；弱模型未必稳定。缓解：

- ② 用户 `/task done` 兜底
- ③ 长闲置自动触发
- v1.2 数据层独立兜底（视图层退化时 messages 原样发，按 budget 阈值压）

最坏情况：滑窗按 N=12 轮截取，被驱逐的 turns 直接 drop（无任务纪要封装）+ recall_history 按磁盘当前状态兜底。

### 7.9 任务纪要的容量管理

任务纪要是给 LLM 看的**近期完成账本**，不是永久长期记忆。容量管理保证 `<turn-context>` 块体积恒定可控：

| 项 | 决策 |
|---|---|
| 硬上限 | **N_briefs = 21** |
| 超出处理 | **直接丢弃**（不落 conversation meta，不留二级账本；超出的纪要从 state 完全移除） |
| 用户可见性 | **不暴露用户命令**——任务纪要是给 LLM 的内部工件，用户感知通过 task_list (in_progress) 状态 + conversation transcript 已足够 |
| **关键事实保留路径**（唯一） | LLM 主动调 `memory.save` 保存关键事实 → memory store 长期保留；v2 不自动注入（v3 评估）；LLM 后续需要时主动 `memory.search` |

**容量恒定性**：21 × ~100 tokens ≈ 2.1K tokens `<turn-context>` 块，长期对话（年度尺度）下任务纪要段 token 占用恒定可控。

**关键事实不丢失的保障**：
- 任务进行中：LLM 看到 task_list (in_progress) + 滑窗 raw（Pin 全面保护）+ 任务纪要列表
- 任务完成时：纪要生成（同步阻塞）+ LLM 同步评估"哪些事实值得长期记住" → 调 `memory.save`
- 纪要在 21 上限内时：LLM 仍可主动评估并提升
- 纪要被淘汰后：从 LLM 视图与 state 中消失；磁盘 raw 受 v1.2 持久化 compact 约束；唯一保留是 memory store（如已 save）

**淘汰即遗忘**：21 之外的纪要在程序状态中直接清除——有意识的设计选择。

---

## 八、ContextCompiler 渲染层

### 8.1 整体哲学

v1.2 真实底层基建**全部保留或局部砍冗余**。新设计在原架构之上**加一层 ContextCompiler 渲染层**（**3-Stage**），处于 streamLLMCall 之前；现有 `TurnContextInjector` 注入紧随其后（也在 streamLLMCall 之前）。

#### 双 baseline（不冲突）

- **estimator calibration baseline = view-layer rendered messages**：拿 API `input_tokens` 后，对账 `estimateMessages(renderedMessages)`——保 calibration 系数与 LLM 实际处理的 size 匹配
- **budget evaluation baseline = state.messages**：`checkBudget(state.messages)` → 比较 budget thresholds → trigger 3 个数据层策略——保 state.messages 体积兜底

两个 baseline 各做各事：calibration 是 estimator 系数标定；budget 是状态体积兜底。

#### 整体流程

```
[现有] user input → REPL → Agent Loop
                              ↓
[现有保留]                  buildSystemPrompt（启动时构造一次，永远 byte-equal，prompt cache 100% 命中）
                              ↓
[新增]                      ContextCompiler ←── 新增渲染层（3-Stage）
                              ├─ Stage 1: ToolResultAnchorStage   (Q1.B - 老 tool_result 锚化)
                              ├─ Stage 2: MessageWindowStage      (Q3  - 滑窗截取 + 任务纪要触发)
                              └─ Stage 3: ToolSchemaCompilerStage (Q1.A - tools schema 编排)
                              ↓
[现有保留 + 扩展]           TurnContextInjector.inject(messages)
                              ├─ TimeProvider                  (现有)
                              ├─ SchedulerProvider             (现有)
                              ├─ ActiveTaskListProvider        (Q2 新增)
                              ├─ TaskBriefsProvider             (Q3 新增)
                              └─ MigrationSummaryProvider      (Q3 新增)
                              ↓
                            streamLLMCall（看到的是编排后视图：renderedMessages 含 <turn-context> 块 + tools[] + 静态 systemPrompt）
                              ↓
                            executeToolCalls
                              ↓
                            caller 应用 stages 输出的 StateDelta（更新 taskBriefState / capabilityState 等）→ writeMeta（atomic + per-id lock）
                              ↓
                            estimator calibration: estimateMessages(renderedMessages) ↔ API input_tokens
                              ↓
[现有保留]                  onTurnComplete:
                              ├─ manageWindow:
                              │    ├─ applyTierCompression（数据层 tier 截断 state.messages tool_result，Pin 内 turn 跳过）
                              │    └─ Pin + eviction（按 isPinned + maxMessages）
                              ├─ checkBudget(state.messages)  ← budget baseline 是 tier-compressed state.messages
                              ├─ if critical → 3 策略（兜底，全部 isPinned-aware）
                              └─ commitTurn（持久化，含阈值触发的截断）
```

#### 为什么是"加一层"而不是"重构"

1. **底层基建零浪费**——commitTurn / store / events / **system-prompt.ts 启动构造 + cache 命中 / TurnContextInjector** 全部复用
2. **calling convention 零改动**——`runAgentLoop` / `runSubAgentLoop` / `factory.ts` / `llm-call.ts` 全部不动
3. **降级路径自然有**——ContextCompiler 失败时退化为透明层；TurnContextInjector 失败时退化为不注入
4. **风险隔离**——新机制有问题不破坏持久化与 prompt cache
5. **迁移渐进**——Phase 0 / 1 / 2 独立可上线

### 8.2 关键 invariant

1. **磁盘 transcript 由 v1.2 持久化层管理（非永久）**——commitTurn 正常 append 新 turn；阈值触发 LLMSummarize 时按 `turnsCompacted` 截断旧 turns + 写 CompactMarker（含 LLM 生成的 summary）。v2 不改此机制。`recall_history` 返回**当前磁盘状态**：compact frontier 之后的 turns 完整 raw，frontier 之前的内容仅能从 `CompactMarker.summary` 还原
2. **state.messages 是工作集**（不是 raw mirror）——v1.2 数据层可在 onTurnComplete 内压缩 messages，agent-loop 把压缩结果回写 state.messages，这是合法行为
3. **ContextCompiler 输入分两类**：
   - **不可变输入**：state.messages + raw tools 定义——Stages 绝不修改
   - **可演化辅助状态**：taskBriefState / capabilityState / migrationSummaryState / taskListState——Stages 通过输出 `StateDelta` 表达更新意图，由 caller 在 LLM call 完成后应用（保证渲染过程对输入只读、可重入、可重试）
4. **system prompt 启动时构造一次 + 永远 byte-equal**——`buildSystemPrompt` 不引入 builder 化；`tool-usage` segment 文本 byte-equal（`capabilityState` 只影响 API `tools[]` 数组）；transplanted `SYSTEM_META_PROMPT_SECTION` 进 always-on 静态 segment 仍然 byte-equal；prompt cache 命中率最大化
5. **per-turn 动态状态走 user message `<turn-context>` 块**——通过现有 `TurnContextInjector` 自动注入；不修改 system prompt；不破坏 prompt cache（参考 [turn-context-injection.md](./turn-context-injection.md)）
6. **Stage 默认全启用**——不按模型能力区分；不按 profile 启停（profile 只决定 segment 子集与 Cold 工具集）
7. **Pin 全面传播**——`in_progress` 任务的 raw turns 在视图层（MessageWindowStage）与数据层（manageWindow / MessageDrop / LLMSummarize）均不被驱逐/截断/摘要；orchestrator 拥有 `taskListState`，构造 `isPinned: (messageIndex) => boolean` callback 注入到上述所有层
8. **graceful degradation**——任意 Stage 抛错 → 跳过该 Stage（其他 Stage 仍跑）；全部 Stage 抛错 → 退化为透明层（messages 原样发）；TurnContextInjector 任意 provider `render()` 抛错 → 该 provider 跳过（其他 provider 仍注入）

### 8.3 Stage 顺序与依赖

三个 Stage 顺序（默认全启用）：

| 序 | Stage | 输入 | 输出（含 StateDelta） |
|---|---|---|---|
| 1 | ToolResultAnchorStage | state.messages, AgentRoleProfile | rendered messages（老 tool_result 锚化）；无 StateDelta |
| 2 | MessageWindowStage | rendered messages from Stage 1, taskBriefState, taskListState（含 isPinned 来源），conversationMeta（migration summary 缓存） | rendered messages（滑窗截取 + Pin 保留）；StateDelta（任务边界达成时同步触发 TaskBriefSummarizer，输出新纪要；migration summary 首次生成时输出 summary + 时间戳；每轮更新 runs counter） |
| 3 | ToolSchemaCompilerStage | capabilityState, AgentRoleProfile, raw tools 定义 | rendered API `tools[]` 数组（Always + Hot 完整 schema；Discoverable / Cold 不暴露）；StateDelta（自动升级时 → capabilityState Hot 集更新；LRU touched） |

**Stage 之间依赖**：

- Stage 2 输入是 Stage 1 输出（messages 已锚化）
- Stage 3 编排 API `tools[]` 数组，独立于 messages 编排

**ContextCompiler 之后**：`TurnContextInjector.inject(renderedMessages)` 把 active-task-list / task-briefs / migration-summary 等 provider 输出注入到最新 user message 的 `<turn-context>` 块（与现有 `TimeProvider` / `SchedulerProvider` 同流程）。

**StateDelta 应用时机**：caller 在 LLM call 完成后（无论成功失败）**同步**应用 Stages 输出的 StateDelta；写 conversation meta 走 `ConversationRepository.writeMeta`（atomic + per-id lock），保证下轮 LLM call 看到最新 state；失败可重试 → 渲染过程对 input state 是只读的，重试安全；高频小写入（如 capability LRU 时间戳）由 spec 阶段评估 batch/debounce 优化。

**Profile 输入**：v2 ContextCompiler 接收 `AgentRoleProfile`（main / sub agent 区分）。无 ContextProfile（已砍）。

### 8.4 system-meta 消息处理

state.messages 中的 `<system-meta>` 系统消息（CompactMarker 的 compact-summary + ack pair / MessageDrop 的 dropped-turns 标记）是**协议层信号**，Stages 透传不解析：

- ToolResultAnchorStage：扫 tool_result 时跳过 system-meta（它们是 text block，不是 tool_result，安全 by structure）
- MessageWindowStage 滑窗计数：`<system-meta>` 系统消息**不计入轮次**（轮 = user+assistant 配对，system-meta 是 protocol 层）
- Pin 计算：system-meta 不属于任何任务的 in_progress 范围，自然不在 Pin 集
- TurnContextInjector：只动最新 user message，不触碰 system-meta

LLM 通过 transplanted `SYSTEM_META_PROMPT_SECTION`（always-on 静态 segment in system prompt）理解 `<system-meta>` 标签语义。

### 8.5 新事件

| 事件 | 含义 | 时机 |
|---|---|---|
| `view:compile_start` | ContextCompiler 开始渲染 | 每次 LLM call 之前 |
| `view:compile_end` | ContextCompiler 渲染完成（含 stage 耗时 / token 节省） | 每次 LLM call 之前 |
| `view:fallback` | 某 Stage 失败跳过 / 整体降级 | 异常 |
| `view:state_delta_applied` | caller 应用 stages 输出的 StateDelta | LLM call 完成后 |
| `view:task_brief_created` | 任务纪要生成成功 | 任务边界达成时 |
| `view:task_brief_failed` | 任务纪要生成失败（重试 3 次后放弃） | 异常 |
| `view:migration_summary_generated` | 一次性历史摘要首次生成 | 老 conversation 首次进入 v2 流程 |
| `view:capability_upgraded` | Discoverable → Hot 自动升级 | LLM 调 Discoverable 工具触发 |

---

## 九、保留 / 改造 / 砍除清单

### 9.1 保留

- `TranscriptStore` + `commitTurn` + `TranscriptStore.load`
- `CompactMarker` / `system-meta` 协议（含 `SYSTEM_META_PROMPT_SECTION` transplant — 见 §9.2）
- `ContextEngine.onTurnComplete` 主路径
- **3 个压缩策略**（`MemoryFlush`（实现位于 `core/src/memory/flush-engine.ts`）/ `MessageDrop` / `LLMSummarize`，全部接受 `isPinned` callback）—— onTurnComplete 内数据层兜底
- `manageWindow` 的 **Pin + eviction 部分 + `applyTierCompression` 步骤**（数据层 tool_result 体积管理，全部保留）；Q3 复用 Pin，语义改造为 `in_progress` 任务驱动
- 事件系统基础设施
- `memory` 工具（v2 不做相关性自动注入；用户/LLM 通过 `save` / `search` 手动用）
- `tools-builtin` 全 8 工具
- `/clear` / `/compact` 命令（`/clear` 重置语义在 Phase 0 升级 — 见 §9.2）
- `budget` 评估（baseline = state.messages）
- **`orchestrator/system-prompt.ts:buildSystemPrompt` 启动时一次性构造**（不引入 builder 化；保 byte-equal cache 命中）
- `orchestrator/AgentRoleProfile` + mainProfile / subAgentProfile
- **`runAgentLoop` / `runSubAgentLoop` calling convention**（保 `systemPrompt: string` 签名；不改）
- **现有 `TurnContextInjector` + `TimeProvider` + `SchedulerProvider`**（`core/src/context/turn-context.ts`）：实例与注册接口完全保留；**inject() 调用点 Phase 0 改造**：从 `create-agent-runtime.ts:642`（per-run 入口一次）移入 agent-loop 内部 per-LLM-call 注入（详见 §9.2）

### 9.2 改造

| 模块 | 改造内容 |
|---|---|
| **transplant `SYSTEM_META_PROMPT_SECTION`** | 把当前仅在 dead `LayerAssembler` 中引用的 `<system-meta>` 标签解释段，搬到 live `system-prompt.ts` 的 always-on 静态 segment（建议归"工具使用"或新建"消息流标签解释"段，置于 CACHE_BOUNDARY 之前，仍然 byte-equal）；删 LayerAssembler 之前必做 |
| `manageWindow` 的 Pin 判定 | 语义从 v1.2 默认（pin index 0）改为 "`in_progress` 任务驱动"；orchestrator 拥有 `taskListState`，构造 `isPinned: (messageIndex) => boolean` callback |
| **`MemoryFlush` / `MessageDrop` / `LLMSummarize` 策略接受 `isPinned`** | 三个数据层策略都加 isPinned 参数；MessageDrop 物理删 turn 时跳过 Pin 内 turn；LLMSummarize 的 `splitMessagesPairAware` 改 pin-aware（Pin 内 turn 不进 summarize 范围，保留 raw）。**Phase 0/1 实施合约**：当任意 turn `isPinned` 返回 true 时，`LLMSummarize` 整段 no-op（让 raw 直接进数据层 budget 兜底链路）；多段 split 算法（pinned + non-pinned 段同时存在时的 toSummarize 区间识别）的实施延到 Phase 2 与 task brief 同设计实现（§12 #20） |
| **`create-agent-runtime.ts:773-775` estimator calibration** | calibration baseline 从 `estimateMessages(state.messages)` 改为 `estimateMessages(renderedMessages)`（renderedMessages = ContextCompiler Stage 1+2 输出，**不含** TurnContextInjector 注入的 `<turn-context>` 块——后者是后置注入，calibration 在 baseline 之外评估）；保 calibration 系数与 LLM 实际处理的 size 对账。budget evaluation 仍用 state.messages（双 baseline，§8.1） |
| **`ConversationRepository.writeMeta`** | 升级为 atomic write (tmp+rename) + per-id lock（与 `TranscriptStore.commitTurn` 同款机制）；承载每 LLM call 的 StateDelta 应用引发的高频写入；server 模式多 conversation 并发安全 |
| **`/clear` 命令重置语义** | 同步清空：transcript（compactAll）+ state.messages = [] + taskBriefState = {} + capabilityState 默认 init + migrationSummaryState = null + taskListState = []；保留：conversation.id / name / createdAt / preferences / scope / archived。**一句话**："/clear = 复位到新对话，但保留 conversation 身份"。TurnContextInjector 自动反映重置后的 state（每个 provider 的 `shouldInject()` 重新评估），无需特殊处理 |
| **`Conversation.currentHint?: ScenarioHint` 字段砍除** | 字段当前定义但 repository 从不读写 → 业务零依赖；随 ScenarioEvaluator 砍除一并清理 `conversation/types.ts:8` 的 ScenarioHint import 与字段 |
| **`TurnContextInjector` inject() 调用点改造**（Phase 0 关键改造） | v1.2 当前在 `create-agent-runtime.ts:642` 调用一次（**per-run() 入口**，agent-loop 内部零 inject 调用）→ 改造为**每次 streamLLMCall 之前调用一次**（per-LLM-call）。具体：把 `:642` 的 inject 调用点**移入 agent-loop 内部**（ContextCompiler 之后、streamLLMCall 之前）。**`runAgentLoop` 外部签名完全不动**；`TurnContextInjector` 实例与 provider 注册接口完全不动。**为什么必须改**：Q3 的 `TaskBriefSummarizer` 在 Stage 2 同步触发后输出 StateDelta，caller 应用更新 `taskBriefState`；同 run 内后续 streamLLMCall 期望看到新纪要——但 v1.2 inject 是 per-run，调一次后 user message `<turn-context>` 块永远不刷新，新纪要直到下一次 user 输入触发新 run() 才会被注入。同样问题影响 task_list mid-run 更新（LLM 调 `task_list.set` 改 in_progress→completed，后续 LLM call 看不到 task-list 段更新）。改为 per-LLM-call 注入后所有 5 个 provider（含现有 TimeProvider / SchedulerProvider）都获得 fresh 内容 |

### 9.3 新增

| 模块 | 性质 |
|---|---|
| `ContextCompiler` 主框架 | 多 Stage 纯渲染 + StateDelta 输出；**3 Stage** 默认全启用 |
| `ToolResultAnchorStage` | Stage 1（视图层语义锚化；运行在数据层 tier-compressor 输出之上） |
| `MessageWindowStage`（Q3） | Stage 2：滑窗截取 + 任务纪要触发（同步阻塞调用 TaskBriefSummarizer） |
| `ToolSchemaCompilerStage` | Stage 3：编排 API `tools[]` 数组（capabilityState 驱动），不动 system prompt 文本 |
| `capabilityState` 状态机（Always / Hot / Discoverable / Cold + 7 轮 LRU） | 状态：每轮更新；session-scoped 不持久化（重启 / 切换 conversation 走 rebuildCapabilityFromHistory，从 transcript 历史现学现用，避免 snapshot 与 transcript 双源不一致） |
| `taskBriefState`（Q3） | 状态机：21 cap，超出直接丢弃；持久化到 conversation meta |
| `migrationSummaryState`（Q3） | 状态：摘要 + 时间戳 + 已运行轮次计数；持久化到 conversation meta |
| `taskListState` Pin 来源同步 | orchestrator 持有；记录 in_progress 任务的 turn 范围；构造 `isPinned: (messageIndex) => boolean` callback 注入数据层与视图层 |
| **`ActiveTaskListProvider`** (Q2) | TurnContextProvider 实现：读 `taskListState`，注入"当前任务列表"；与 `TimeProvider` / `SchedulerProvider` 同模式注册到 `TurnContextInjector` |
| **`TaskBriefsProvider`** (Q3) | TurnContextProvider 实现：读 `taskBriefState`，注入"已完成任务纪要（最近 21 个）"；同上注册 |
| **`MigrationSummaryProvider`** (Q3) | TurnContextProvider 实现：读 `migrationSummaryState`，K 轮内 `shouldInject()` 返回 true 时注入"历史对话摘要"；同上注册 |
| 自动升级中间件（Discoverable → Hot 静默升级 + 直接执行） | 工具调用拦截 |
| `request_capabilities` 元工具 | Always 层；LLM 批量预热 |
| 事实锚生成器（per tool: read / bash / grep / glob / edit / write / web_fetch） | Stage 1 内部 |
| **`TaskBriefSummarizer` 独立 strategy 类**（Q3） | 新 strategy class（非 `LLMSummarizeStrategy` 复用）；独立 prompt（一行 ledger 格式）+ 独立 validator；只复用 `createCompactionFlush` LLM call helper 与 `splitMessagesPairAware` split helper；Stage 2 内部同步调用；失败重试 3 次（指数退避），仍失败则 emit 事件 + 跳过纪要生成 |
| migration LLMSummarize（Q3） | Stage 2 内部；首次该 conversation 进入 v2 流程时跑一次；缓存到 conversation meta |
| 长闲置 detector（Q3） | onTurnComplete 钩子；>30 min 无消息触发任务边界 |
| `task_list` 工具 | Always 层 |
| `recall_history` 工具 | Always 层，从零实现 |
| Active Task List UI 渲染 | cli 输出区 |
| `/tasklist` / `/task` / `/task new` / `/task done` 命令 | cli |

### 9.4 砍除

| 模块 | 理由 |
|---|---|
| `TurnDigest` 模块（`turn-digest.ts` + `digestHistory` 字段 + `addTurnDigest` / `getTurnDigests` 方法 + 19 测试 + index 导出） | 程序自动机械面包屑业界对照否定，意图被 task_list + Q3 任务纪要替代 |
| `LayerAssembler` 整个模块 | 4 层语义与业务真路径不兼容 |
| `ScenarioEvaluator` 模块 | 关键词正则在中文场景不可靠 |
| `ContextProfile` 体系（含场景化 profile 实例 + `tierThresholds` 字段等参数化配置） | 失去 ScenarioEvaluator 驱动后无价值；`BudgetThresholds` 类型已在 `context/types.ts:62-69`（无需搬）；只需把 `TierThresholds`（`context-profile.ts:39-46` 本地定义）搬到 `context/types.ts`；ContextEngine 配置接口直接接受 `budgetThresholds` + `tierThresholds` 入参（替代原 ContextProfile） |
| `ContextEngine.buildSystemPrompt` 方法 | 配套 LayerAssembler |
| `ContextEngine.addTurnDigest` / `getTurnDigests` 方法 + `digestHistory` 字段 | 配套 TurnDigest |
| **`ToolResultTrim` 策略**（strategies 4 → 3） | 与 `tier-compressor` 数据层 tier 截断真冗余（都是 turn-distance 字符截断，tier-compressor 多分级更精细） |
| **`Conversation.currentHint?: ScenarioHint` 字段 + `ScenarioHint` 类型** | 字段定义但从未持久化，业务零依赖 |

### 9.5 v1.2 设计概念的搬层

| v1.2 概念 | v1.2 落点 | v2 新落点 |
|---|---|---|
| Tier 思想（4 级 tool_result 渐进压缩） | tier-compressor.ts | **保留在数据层**（管 state.messages 体积 + 保 budget baseline 准确）；Q1.B view-layer 在 tier-compressor 输出之上做语义锚化升级；二者各司其职非冗余 |
| Pin（不驱逐） | manageWindow 内部，默认 pin index 0 | Q3 复用 + 语义改造：`in_progress` 任务驱动；orchestrator 持有 `taskListState`，构造 `isPinned` callback 注入到 manageWindow + MessageDrop + LLMSummarize + MessageWindowStage |
| 可恢复（recall_history 承诺） | v1.2 文档承诺，工具不存在 | Phase 0 从零实现 |
| 兜底裁剪（3 压缩策略 + budget 阈值） | onTurnComplete | 保留（强弱模型场景下阈值兜底是合理设计；策略全部接受 isPinned） |
| LLMSummarize 范式 | 阈值触发的全局摘要 | Q3 改用 `TaskBriefSummarizer`（独立 strategy 类，per-task 局部摘要）+ 一次性历史 migration；v1.2 全局兜底保留 |
| `SYSTEM_META_PROMPT_SECTION` | dead `LayerAssembler` 引用 | transplant 到 live `system-prompt.ts` always-on 静态 segment |
| `BudgetThresholds` 类型 | **已在 `context/types.ts:62-69`**（context-profile.ts import 进来用）| 不需搬，原地保留；ContextEngine 配置接口直接接受 `budgetThresholds` 入参（替代原 ContextProfile.budgetThresholds 字段访问） |
| `TierThresholds` 类型 | `context-profile.ts:39-46` 本地定义 | 搬到 `context/types.ts`（与 BudgetThresholds 同处）；ContextEngine 配置接口直接接受 `tierThresholds` 入参 |
| `ScenarioHint` 类型 + `Conversation.currentHint?` 字段 | `conversation/types.ts:8` import；定义但不持久化 | **砍除**（业务零依赖） |
| **per-turn 动态状态（task-list / task-briefs / migration-summary）** | （v1.2 不存在） | **复用现有 `TurnContextInjector` 基建**（`core/src/context/turn-context.ts`）；追加 3 个 provider；不引入新注入路径 |

---

## 十、实施路线（Phase 0–2）

每 Phase 独立可上线 / 独立验证 / 独立回滚。

### Phase 0 · 清理债务 + 关键改造 + 框架 + Q1.B（合并）

**Scope**：

**A. 死代码 + 冗余清理**：
- 砍除 v1.2 全部死代码（§9.4 列表）：TurnDigest / LayerAssembler / ScenarioEvaluator / ContextProfile / ContextEngine 死方法 + 测试 + index 导出
- 砍 `ToolResultTrim` 策略（与 tier-compressor 真冗余；strategies 4 → 3）
- **一次性清理 `ScenarioHint` 链路**（避免编译断裂）：先把 `Conversation.currentHint?: ScenarioHint` 字段从 `conversation/types.ts:8,32` 移除，再砍 `ScenarioHint` 类型本身（随 ContextProfile 砍除）；同 PR 内完成
- **保留 `tier-compressor.ts` + `applyTierCompression`**（数据层 state.messages 体积管理；Q1.B 在其上做语义锚化升级，二者各司其职）；只需把 `TierThresholds` 类型从 `context-profile.ts:39-46` 搬到 `context/types.ts`（与现有 `BudgetThresholds` 同处）；ContextEngine 配置接口直接接受 `budgetThresholds` + `tierThresholds` 入参（替代原 ContextProfile 整体）

**B. 关键改造**：
- transplant `SYSTEM_META_PROMPT_SECTION` 到 live `system-prompt.ts` always-on 静态 segment（CACHE_BOUNDARY 之前；transplant 后整体仍 byte-equal）
- 改造 `create-agent-runtime.ts:773-775` estimator calibration：baseline 改为 `estimateMessages(renderedMessages)`
- 升级 `ConversationRepository.writeMeta`：atomic write (tmp+rename) + per-id lock
- 升级 `/clear` 命令重置语义：同步清空 transcript + state.messages + 全部 view-layer state
- **改造 `TurnContextInjector` inject() 调用点**：从 `create-agent-runtime.ts:642`（per-run 入口）移入 agent-loop 内部（ContextCompiler 之后、streamLLMCall 之前）；`runAgentLoop` 外部签名不动；`TurnContextInjector` 实例与 provider 注册接口不动；详见 §9.2 改造行
- `MemoryFlush` / `MessageDrop` / `LLMSummarize` 策略全部接受 `isPinned: (messageIndex) => boolean` callback；orchestrator 构造 isPinned 来源（Phase 0 阶段默认返回 `false`，Phase 2 接到 taskListState 后真正驱动）
- `BudgetThresholds` 类型已在 `context/types.ts:62-69`（无需搬）；只搬 `TierThresholds` 从 `context-profile.ts:39-46` 到 `context/types.ts`；ContextEngine 配置接口直接接受 `budgetThresholds` + `tierThresholds` 入参（替代原整个 `ContextProfile`）

**C. 从零实现 `recall_history` 工具**（接入 `tools-builtin/`）：
- 输入：`{ turnRange?: { start: number; end: number } } | { toolUseId?: string }`
- 输出：从 transcript 当前磁盘状态读取（compact frontier 之后的 turns 完整 raw + frontier 之前的 marker.summary）
- 实现：通过 `TranscriptStore.load` 全量加载 + 内存过滤
- 注册：Always 层

**D. 建 `ContextCompiler` 主框架**（pass-through Stage——什么都不做）+ 接入 streamLLMCall 之前

**E. Q1.B `ToolResultAnchorStage`**（与 Phase 0 冗余清理合并发布，避免阶段性回归）：
- 实现 `ToolResultAnchorStage`，接入 ContextCompiler（位置 1）
- 实现 per-tool 事实锚生成器（read / bash / grep / glob / edit / write / web_fetch）
- 锚化规则：非最近 tool_use 的 tool_result（Focus/Anchor）
- view-layer 在数据层 tier-compressor 输出之上做语义锚化升级（二者各司其职非冗余；数据层管 state.messages 体积，视图层管 LLM 视图认知质量）
- budget critical 时由 `LLMSummarize` 全局摘要兜底

**关键不变量**：Phase 0 完成后**完全无行为回归**——tier-compressor 数据层职责保留（state.messages 体积管理 + budget baseline 准确）；Q1.B 同步上线在视图层做语义锚化升级；ToolResultTrim 砍除（真冗余）；calling convention 完全不动；system prompt 仍启动时构造一次（byte-equal 不变，prompt cache 100% 命中）。

**风险**: 中（清理范围大；CACHE_BOUNDARY byte-equal 必须守住；writeMeta 升级影响所有写入路径；isPinned 参数引入到三个策略）。

### Phase 1 · ToolSchemaCompilerStage（Q1.A）

**Scope**：

- 新建 `capabilityState` 模块（Always / Hot / Discoverable / Cold + 7 轮 LRU）
- 实现 `ToolSchemaCompilerStage`，接入 ContextCompiler（位置 3）：编排 API `tools[]` 数组（Always + Hot 完整 schema；Discoverable / Cold 不暴露），**不动 system prompt 文本**
- `system-prompt.ts:buildToolUsage` 段保持 byte-equal——永远输出 profile 内所有非 Cold 工具的**完整 hints**（含 `systemPromptHints` 详细使用引导，约 200-300 行，参考 `system-prompt.ts:247-303` 当前实现）；profile 决定的稳态集合，capabilityState 演化不影响该段文本
- 实现自动升级中间件：拦截 LLM 调用 Discoverable 工具 → 静默升级到 Hot → **用 LLM 提交参数直接执行** → 透明返回结果（参数错时由 LLM 在下一轮凭完整 schema 自修正，与常规 error→fix 循环同形态，无额外延迟、无双倍 input 计费）
- 实现 LRU 降级（onTurnComplete hook）
- 实现 `request_capabilities` 元工具（Always 层）
- 启动 / 切换 conversation / 重启 cli 时由 `rebuildCapabilityFromHistory` 从 transcript 历史 tool_use 重建 Hot 集（最近 7 个含 tool_use 的 assistant message 内的工具升级到 hot）
- capability state **不持久化**（与 innovation 重置规则中"cli session 重启 → 新 process 全新开始"对齐）—— tool_use 历史的权威源是 transcript，capability 是其衍生视图，单源避免双源不一致；rebuild 的 hot 集合等价于持久化 snapshot 的信息含量，但跨 process 不携带 session 状态。/clear / /resume / 重启走 reset + rebuild 同一路径

**风险**: 中（LLM 对 system prompt tool-usage 文本中"工具存在"提示的识别准确度需实测；自动升级 +1 轮延迟；冷启动后已恢复对话的 Hot 集重建准确度）。
**收益**: API `tools[]` 短对话场景 96% schema 节省；任务稳态后 Hot 集稳定 tools cache 仍可命中；system prompt cache 完全不受影响。

### Phase 2 · MessageWindowStage + TurnContextProviders + Active Task List

**Scope**（Q2 + Q3 紧耦合）：

**Q3 部分**：
- 实现 `MessageWindowStage`，接入 ContextCompiler（位置 2）
- 实现 `taskBriefState` 状态机（21 cap，超出直接丢弃）+ 持久化
- 实现 `taskListState` Pin 来源：记录 in_progress 任务的 turn 范围（→ message index range）；orchestrator 构造 `isPinned` callback 注入到所有需要它的层（Phase 0 已铺好 isPinned 参数，此 Phase 接通真实来源）
- 实现 `TaskBriefSummarizer` 独立 strategy 类（同步阻塞调用，多任务并发上限 3，重试 3 次失败语义）
- 实现长闲置 detector（onTurnComplete 钩子，>30 min 触发任务边界）
- 实现 migration LLMSummarize（首次该 conversation 进入 v2 流程时跑一次）+ 缓存到 conversation meta（`migrationSummaryState`）

**Q2 部分**：
- 实现 `task_list` 工具（单一 set 动作，Always 层）
- 实现 3 个 TurnContextProvider 并注册到 `TurnContextInjector`：
  - `ActiveTaskListProvider`：读 `taskListState`，shouldInject() 在 items 非空时 true
  - `TaskBriefsProvider`：读 `taskBriefState`，shouldInject() 在纪要非空时 true
  - `MigrationSummaryProvider`：读 `migrationSummaryState`，shouldInject() 在 K 轮（默认 50）内且非空时 true
- 注册位置：`create-agent-runtime.ts` 现有 `turnContextInjector.register(...)` 调用链（约 line 425-486）追加 3 行
- system prompt 引导 LLM 使用 task_list（Claude Code TodoWrite 风格）+ 任务完成时主动 `memory.save` 关键事实
- system prompt 引导 LLM 调 `recall_history` 取回锚化 tool_result（受 compact frontier 约束，可能仅得 summary）
- cli UI 渲染（任务列表实时显示）
- `/tasklist` / `/task <desc>` / `/task new` / `/task done <id>` 命令
- `task_list` 状态持久化到 conversation meta

**Phase 路线决策**：Q3 与 Q2 紧耦合并入同一 Phase——Q3 的 `taskBriefState` / `migrationSummaryState` 通过 Q2 的 TurnContextProvider 注入；Q3 的任务边界来源 ① 依赖 Q2 的 `task_list` 工具；cli UI 同一输出区。

**风险**: 中-高（LLM 主动调 task_list 率不确定；MessageWindowStage 滑窗驱逐边界场景多；migration LLMSummarize 单次成本不小；K 值需实测调；LLM `memory.save` 主动调用率不确定）。

---

## 十一、风险与降级路径

### 11.1 降级路径

| 触发 | 行为 | state 影响 |
|---|---|---|
| 单 Stage 抛错 | 跳过该 Stage（其他 Stage 仍跑），发事件 `view:fallback` | 不修改输入 state |
| 全 Stage 抛错 / ContextCompiler 整体异常 | 退化为透明层（messages / tools[] 原样发，等同 v1.2 行为） | 不修改输入 state |
| 单 TurnContextProvider `render()` 抛错 | 该 provider 跳过（其他 provider 仍注入） | 不修改输入 state |
| `TurnContextInjector` 整体异常 | 退化为不注入 `<turn-context>` 块（messages 原样发） | 不修改输入 state |
| StateDelta 应用失败（writeMeta 失败） | 该轮 stage 输出的 state 更新丢弃；下轮重试；不阻塞当轮 LLM call；emit 事件 | 不修改输入 state |
| onTurnComplete 内 3 策略触发（v1.2 数据层兜底） | 按 priority 跑策略修改 state.messages，commitTurn 写 marker；策略全部 isPinned-aware 跳过 Pin 内 turn | state.messages 被合法更新 |
| MessageWindowStage 滑窗 / 任务纪要生成失败 | Stage 跳过，messages 全量发；budget 阈值兜底 | 不修改输入 state |
| TaskBriefSummarizer 失败（重试 3 次后） | emit `view:task_brief_failed`；跳过纪要生成（任务边界仍消化，Pin 释放）；LLM 关键事实保留路径独立（memory.save） | 不修改输入 state |
| migration LLMSummarize 失败 | 摘要不生成，老历史完全不可见，纯靠 recall_history 兜底 | 不修改输入 state |
| 长闲置 detector 失败 | 任务边界失去 ③ 来源，依赖 ① ② | 不修改输入 state |
| 自动升级中间件失败（Discoverable → Hot 升级出错） | LLM 收到原始 unknown tool 错误；spec 阶段评估降级提示 | 不修改输入 state |

**两层独立**：ContextCompiler 视图层失败时，v1.2 数据层兜底独立运行（已经在跑）；`TurnContextInjector` 失败时，仅 `<turn-context>` 块不注入，messages 主体仍正常。任何情况下最坏退到 v1.2 行为。

### 11.2 主要风险

| 风险 | 严重度 | 对策 |
|---|---|---|
| ContextCompiler bug 导致编排错误 | 高 | graceful degradation 自动跳过 Stage；事件 `view:fallback` 暴露 |
| LLM 不写 task_list | 中 | 数据层保留 user/assistant reasoning；用户 `/task` 命令；任务边界 ② ③ 兜底 |
| Discoverable 工具 LLM 调用准确度 | 中 | system prompt tool-usage 段保留所有非 Cold 工具完整 hints（byte-equal）→ LLM 知工具用法概念但无 schema → 调用时参数靠猜 → 自动升级中间件兜底（详见 §4.2）；Phase 1 实测调用准确度 |
| 事实锚信息丢失（grep multi-target） | 中 | recall_history（受 compact frontier 约束）+ 锚格式预留路径列表 |
| Discoverable 工具首调用参数猜错率 | 低-中 | hints 段提供语义引导（hint 中含参数名 / 用例）；强模型几乎不错；弱模型错时按常规 error→fix 循环（下一轮 tools[] 已含完整 schema，LLM 凭 error tool_result + schema 自修正再调）；token 成本 ≤ 重发 LLM call 路径，且语义统一为"调用-报错-修正"，无 replay 例外路径 |
| 已恢复对话 capabilityState 重建 | 中 | 从历史 tool_use 重建（最近 7 轮内） |
| Phase 0 清理 + 改造 + Q1.B 范围大 | 中-高 | 死代码 grep 已确认；分多 PR 落地；先 transplant SYSTEM_META 后删 LayerAssembler；calibration / writeMeta / Q1.B 测试覆盖 |
| Q1.B Anchor 在 tier-compressor T2/T3 范围内 metadata 提取受限 | 低-中 | tier-compressor T1（distance ≤ 2）范围内 Q1.B 能提取精确 metadata；T2 范围（distance 3-8，2000 chars）能提取部分；T3+（500 chars / skeleton）退化为透传或弱 anchor。Phase 0 实测后评估是否调 T1 阈值匹配 Q3 滑窗 N=12 以扩大 Q1.B 高质量范围 |
| 用户引用锚化 tool_result 详情 | 低 | recall_history 工具 + system prompt 引导 |
| Q3 滑窗 N=12 实测合理性 | 中 | Phase 2 实测；弱模型 attention 容忍度低 → N 不能太大；Pin 例外保留 in_progress raw |
| Q3 长闲置阈值 30 min 误判 | 中 | 有 in_progress 任务时阈值放宽 |
| Q3 一次性历史摘要质量（弱模型生成） | 中 | recall_history 兜底（受 compact frontier 约束） |
| Q3 一次性历史摘要 K=50 | 中 | Phase 2 实测调 |
| Q3 任务纪要质量（TaskBriefSummarizer 同步调用） | 中 | LLM 主动调 `memory.save` 保留关键事实是真兜底；Pin 全面传播保证 in_progress raw 不被数据层意外摘掉 |
| Q3 与 v1.2 数据层 manageWindow Pin 同步 | 中 | orchestrator 拥有 `taskListState`，传 `isPinned` callback；数据层不读视图层 state |
| Q3 任务纪要上限 21 vs LLM `memory.save` 及时性 | 中 | LLM 必须在纪要被淘汰前完成 save；spec 阶段调引导措辞 + Phase 2 实测 |
| `recall_history` 受 v1.2 持久化 compact 约束 | 中 | LLM 接受"可能仅 summary"语义（spec 阶段引导） |
| `SYSTEM_META_PROMPT_SECTION` transplant 漏做 | 中 | Phase 0 严格顺序：先 transplant 后删 LayerAssembler；测试 assert live system-prompt 含此段 |
| v2 不做 Persistent Knowledge 自动注入对长期记忆的影响 | 中 | LLM 主动调 `memory.save` + 后续主动 `memory.search` 是当前可行路径；v3 评估完整 retrieval/injection |
| TaskBriefSummarizer 同步阻塞 +1 LLM 往返延迟 | 中 | 任务边界是低频事件且发生在用户自然停顿处；多任务并发上限 3 控总延迟；3 次重试 + 失败语义良定义 |
| writeMeta 高频写入下的磁盘 IO 压力 | 中 | atomic write + per-id lock 已升级；spec 阶段评估是否需要 batch / debounce capability LRU 时间戳更新 |
| estimator calibration baseline 切换后系数偏差 | 中 | calibration 是渐近过程；偏差大时 emit drift 事件；spec 阶段评估初始系数 |
| TurnContextProvider 间相互独立但渲染顺序影响 LLM 解读 | 低 | 注册顺序固定（time → scheduler → task-list → task-briefs → migration-summary）；spec 阶段确认顺序对 LLM 理解的影响 |
| `TurnContextInjector` inject() 改 per-LLM-call 后对 message-level cache 的影响 | 低 | user message 每轮 inject 不同 `<turn-context>` 块 → user message 内容每轮变化 → message-level cache 不受益（但 system prompt cache 完全不动，主 cache 收益保留）；`stripTurnContext` 保证每轮先剥旧块再注入新块，不累积；inject 自身耗时毫秒级，对 LLM call 总延迟无显著影响 |

---

## 十二、未决问题（spec 阶段澄清）

1. **`ContextCompiler` Stage 接口签名**：纯渲染函数 + StateDelta 输出形式 / 错误返回值 / 事件埋点位置
2. **`recall_history` 工具实现策略**：用 `TranscriptStore.load` 全量加载 + 内存过滤 vs 扩展 store 加 partial 接口；性能权衡（481-message conv 单次 ~50-100ms acceptable for v1）
3. **`capabilityState` 持久化序列化格式**：与 conversation meta 中其他状态共享 schema；Hot 集 LRU 时间戳精度（turn-level vs second-level）
4. **事实锚生成器边界情况**：图片 / 二进制 tool_result / bash 副作用命令的 recall 语义
5. **`task_list` 持久化 schema**：与 conversation meta 关系；`in_progress` 任务的 turn 范围记录方式（用于 Pin 来源）
6. **`TurnContextProvider` 渲染顺序与 LLM 解读**：注册顺序决定 `<turn-context>` 内段落顺序；spec 阶段确认默认顺序与产品体感
7. **Pin 概念在 v2 中的处理**：是否引入用户显式 Pin 命令；`isPinned` callback 签名为 `(messageIndex) => boolean`（保 v1.2 兼容；orchestrator 把 turn 范围映射为 message range）
8. **sub-agent 路径**：sub-agent 走同一 ContextCompiler 实例还是独立；subAgentProfile 配置 Cold 工具集；sub-agent capabilityState 是否独立 vs 共享父 agent；sub-agent 是否注册自己的 TurnContextProvider 集（推荐：sub-agent 不注册 task-list / task-briefs / migration-summary，因为 sub-agent 是短任务）。**Phase 0 现状（已记录待评估）**：sub-agent 路径（`subagent/loop-runner.ts:drainAgentLoop`）当前**不接** ContextCompiler / TurnContextInjector / tokenEstimator —— turnContextInjector / tokenEstimator 不接合理（sub-agent 短命、保 byte-equal-across-spawns 缓存优化、不污染主 estimator 系数），但 ToolResultAnchorStage 不接对长子 task（grep + read + edit 链）的上下文体积控制是显著缺口；作为**独立评估项**（不绑特定 Phase，不属 Q1.A/Q2/Q3 范围）实测决议（启用 / 不启用 / 仅启用 ToolResultAnchorStage 而保留其他 Stage 主路径独占）。
9. **`TurnContextInjector` 注入与 `ContextCompiler` 输出的 ordering**：当前 v1.2 在 enrichContext 之后 inject；v2 是否在 ContextCompiler Stage 1+2 输出后 inject（让 view-layer 处理 raw messages，再追加 `<turn-context>`）
10. **Q3 滑窗默认 N 值实测调**：N=12 是产品方向对齐结果，spec 阶段需根据弱模型实测确定；是否按 main / sub agent 区分
11. **Q3 任务边界来源 ③（长闲置）阈值与组合规则**：默认 30 min；有 in_progress 任务时是否放宽；与用户主动恢复对话场景区分
12. **Q3 任务纪要持久化 schema**：与 conversation meta 关系；字段集（status / 完成时间 / 任务标题 / 关键产出 / git ref / 涵盖轮数 / 摘要内容）
13. **Q3 一次性历史摘要 K 值**：默认 K=50（轮）；spec 阶段实测确定；是否按 conversation 长度自适应
14. **Q3 任务纪要→`memory.save` 提升的 system prompt 引导措辞**：如何让 LLM 在任务完成时稳定评估"是否值得长期记住"并调 `memory.save`；Phase 2 实测调
15. **Q3 `recall_history` 在 compact frontier 前的语义**：取回某 turn 时若已被 v1.2 持久化层 compact，工具返回 `CompactMarker.summary` 还是 error；system prompt 如何引导 LLM 接受"raw 不可用，仅 summary"
16. **`ConversationRepository.writeMeta` 高频写入是否需要 batch / debounce**：capability LRU 每轮更新一次时间戳是否值得每轮 writeMeta；spec 阶段评估
17. **TaskBriefSummarizer 多任务一轮 close 时的调度策略**：单次 `task_list.set([...])` 把多项 in_progress→completed 时，并发上限默认 3（避免 secondary role 雪崩）；spec 阶段定具体上限与 batch 一次 LLM 摘多任务的可行性
18. **`/clear` 与 in-flight LLM call 的 ordering 语义**：用户 `/clear` 时若有 streamLLMCall 未完成或 StateDelta 未应用——abort 当前 / 等其完成 / 强制取消；推荐 abort + 丢弃未应用 StateDelta，spec 阶段定
19. ~~Capability 自动升级的 max-replay cap 行为细节~~ —— 决议：自动升级走"静默升级 + 直接执行"（与 innovation §4.8 / §4.10 原文对齐），不引入 replay 概念。Discoverable 工具首调用参数猜错由常规 error→fix 循环消化（下一轮 LLM 凭完整 schema 自修正），与"调用-报错-修正"同形态。无 replay-cap、无双倍 input billing、无 +1 轮延迟。
20. **`isPinned` callback 在 `splitMessagesPairAware` 中的实现**：Pin 内 turn 不进 summarize 范围意味着 split 算法需要识别"非连续 turn 段"——具体算法 Phase 2 与 task brief 同设计实现
21. **TaskBriefSummarizer 重试策略的具体参数**：3 次重试的具体退避时长；失败后是否记录到磁盘以便后续 manual recovery
22. **Q3 关键事实保存到 `memory` 工具的 category 选择**：现有 categories（`profile` / `person` / `skill`）；任务关键事实存哪类？由 LLM 基于 memory tool description 自主决定 vs spec 阶段明示规则。注意 memory 工具 `subAgentSafe: false`——sub-agent 无法调，关键事实保存只在 main agent context 发生
23. **estimator calibration baseline 切换的初始系数与平滑策略**：从 v1.2 校准结果迁移；rendered 与 state.messages 估算差异大时如何避免 calibration 系数震荡
24. **`TurnContextInjector` 历史 user message 中残留 `<turn-context>` 块的处理**：当前 `inject()` 仅 strip 最新 user message 的旧 turn-context；历史 user messages 中残留的 turn-context 是否需要 view-layer 主动清理（vs 接受作为对话痕迹）；spec 阶段确认
25. **tier-compressor 阈值与 Q1.B 协作的最优配置**：当前 T1=2 / T2=8 / T3=30 / T4>30 默认。Q1.B Anchor 在 T1 范围内能提取精确 metadata（filename / line count / exit code），T2/T3 范围内只能提取部分。是否调高 T1（如匹配 Q3 滑窗 N=12）扩大 Q1.B 高质量范围；权衡 state.messages 体积增长与 Q1.B 视图质量；Phase 0/2 实测后定
26. **internal-state BoundaryType 自描述化改造（独立项）**：当前内部工具（memory / schedule / recall_history / request_capabilities）通过 `core/security/classifier.ts:createDefaultClassifier` 硬编码 `composite.registerContext(name, internalClassifier)` 接入安全分类；每加一个内部工具都要回头改 core，违反"工具自描述边界"模式（read / write 等通过 `boundaries: [{ boundaryType, access }]` 自描述）。改造方案：扩 `BoundaryType` 加 `"internal-state"`，让 `BoundaryImpactClassifier` 把该 boundaryType 直接映射为 `internal` 操作类；4 个工具改用 `boundaries: [{ boundaryType: "internal-state", access: "read"/"write", dynamic: false }]` 自描述，删除 classifier.ts 硬编码。改造后未来内部工具零改 core。**作为独立评估项**（不绑特定 Phase，不属 Q1.A/Q2/Q3 范围）—— 与 Q1.A capability 工具引入的 request_capabilities 漏注册 bug 同根，但全面架构改造影响 4 个工具 + classifier + 测试，独立任务推进。
27. **`capabilityState.advanceTurn` 调用归属重构（独立项）**：当前 advanceTurn 由 orchestrator runtime 在 agent-loop generator done 分支调一次，pre-flight error 路径走 `buildPreFlightError` 快速 return 不进 done 分支 → advanceTurn 不被调，与 cli `state.turnCounter++` 不同步（cli 端无条件 ++）。影响：context overflow 异常路径下 capability LRU 偶尔少推进 1 轮，对降级行为影响微小但语义上"每次 user 发消息 = 1 turn"被打破。改造方案：把 advanceTurn 调用 ownership 移到 cli 端 commitTurn 之后（与 turnCounter 同位置），runtime 暴露 `agent.advanceCapabilityTurn()` 方法供 cli 显式调用。所有 turn 边界（成功 / max_turns / aborted / error / pre-flight error）由 cli 单点驱动，与 turnCounter 严格对齐。

---

## 十三、状态

| 字段 | 值 |
|---|---|
| 状态 | 方向已敲定，spec 阶段未启动 |
| 下一步 | 启动 Phase 0（清理债务 + 关键改造 + recall_history + ContextCompiler 框架 + Q1.B） |
| 实施完成后 | 内容并入 [context-architecture.md](./context-architecture.md) v2.0，本文废弃 |
