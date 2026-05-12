# v3 上下文管理 · Phase 1 实施计划

> **状态**：✅ 实施全部完成 —— 11 个 PR 全部落地；D2 / D3 待 commit 后 Phase 1 收官
>
> **范围**：v3 spec [§10 Phase 1](specifications/context-management-v3-redesign.md) 的工作分解到 PR 粒度
>
> **关联**：
> - [context-management-v3-redesign.md](specifications/context-management-v3-redesign.md) — 设计权威
> - [active-problem.md](active-problem.md) — 工作台状态
> - [implementation-roadmap.md](implementation-roadmap.md) — 项目总线（待登记 v3 为并行工作流）
>
> **实施模式偏离**：原计划「feature branch 累积所有 PR 后单一 merge」，实际按 commit 直接入主线。功能耦合的原子上线约束仍生效——D 组合入前必须确保 Wave 2 完成态不 regression（v1.2 数据层兜底机制保留中）。
>
> **D1 实际超范围**：D1 实施时一并落地了原 D2 的 SegmentTransitionHook interface（含三 phase 接入 + 错误分级 + hook_failed 事件）和原 D3 的段切换可观测事件（实际 7 个，超过原计划的 6 个）。D2 / D3 实际剩余范围已收窄（见各自 PR 描述）。

---

## 一、关键约束

**原子上线**：1.A 砍除清单 + 1.B 基础设施重构 + 1.C task_list + 1.D SegmentManager 之间存在功能耦合：
- 只砍不上新机制 → 上下文管理失去能力（无视图层、无 capability 管理、无段切换），直接 regression
- 只上新机制不砍旧机制 → 与 v3 invariants 冲突

实施模式：**所有 PR 在同一 feature branch（`feat/context-v3-phase1`）累积 commit；review 通过后单一 merge commit 合入 main**。禁止砍除类 PR 单独合入主线。

---

## 二、PR 拆分总览

```
[砍除组]                              [基础设施组]
A1 recall_history (独立)              B1 ModelCapability + estimateTools (独立)
A2 capabilityState 全套 (独立)        B2 Profile.enabledTools + tools[] 装配 (独立)
A3 ContextCompiler + 锚化 (独立)      B3 CompactMarker + Conversation 字段 (独立)
A4 tier-compressor + manageWindow (独立) B4 TurnContextInjector 段切换分支 (独立)
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
        [task_list 组]            (依赖 B3)
        C1 task_list 工具 + state (依赖 B3)
        C2 task_list cli 命令 + UI (依赖 C1)
                          │
                          ▼
                  [SegmentManager 组]
                  D1 SegmentManager 核心 + Hook 接口 + 段切换事件 (依赖 B1+B2+B3+B4 + C1)
                  D2 sub-agent risk 检测 (依赖 D1)
                  D3 段切换路径 calibration 接入 (依赖 D1)
```

**总 PR 数：11 个**（不含 1.E 失效文档 deprecated，已完成）

**进度**：A1 ✓ / A2 ✓ / A3 ✓ / A4 ✓ / B1 ✓ / B2 ✓ / B3 ✓ / B4 ✓ / C1 ✓ / C2 ✓ / D1 ✓ / D2 ✓（待 commit）/ D3 ✓（待 commit）

---

## 三、PR 详细清单

> **砍除 PR 的实施总原则**：每个 A 组 PR 的"删除位置清单"仅列**已知锚点**，不保证穷举。实施时必须先 `grep` 该模块的所有引用点（含 import / 字符串字面量 / 测试 / 文档），按依赖逆序砍除，确保砍除后 typecheck + lint + test 全过。已知锚点漏列的潜在位置：`security/classifier.ts`（v1.2 硬编码 internal tool 安全分类）、`runtime/capability-config.ts`、`runtime/run-context.ts`、`cli/serve/command.ts`、`cli/runtime/types.ts`、`tools-builtin/src/index.ts`（导出）、各种测试 fixture。

### A 组：砍除清单（与 v3 invariants 冲突的现有代码）

#### PR-A1：砍 `recall_history` 工具 ✅ `e182562`

- 删除 `packages/tools-builtin/src/recall-history.ts` + 测试
- 删除 `create-agent-runtime.ts:444-455` 注入点
- main profile 工具列表移除该工具

#### PR-A2：砍 `capabilityState` 全套（含视图层 stage） ✅ `ecff89c`

- 删除 `packages/core/src/context/capability/` 全目录（types / state / rebuild）
- 删除 `packages/tools-builtin/src/request-capabilities.ts` + 测试
- 删除 `packages/core/src/context/compiler/stages/tool-schema-compiler.ts` + 测试（**ToolSchemaCompilerStage 概念上属于 capabilityState 概念簇——从 capabilityState 派生 tools[]，与本 PR 砍 capability 同步删除**）
- 删除 `agent-loop.ts:404-413` 自动升级中间件（10 行内联逻辑）
- 删除 `cli/repl.ts:385` / `cli/repl.ts:914` / `serve/session-adapter.ts:227` 三处 `rebuildCapabilityFromHistory` 调用
- 删除 `orchestrator runtime:988` `advanceTurn` 调用
- 删除 `create-agent-runtime.ts:415-427` `request_capabilities` 注入点 + promote 闭包桥接

#### PR-A3：砍 `ContextCompiler` 框架 + `ToolResultAnchorStage` ✅ `e8c678e`

- 删除 `packages/core/src/context/compiler/` 目录下**除 PR-A2 已处理外的全部文件**（含 `compiler.ts` / `types.ts` / `index.ts` / `stages/tool-result-anchor.ts` / `anchors/registry.ts` / `anchors/types.ts` / `anchors/index.ts` / `anchors/generators/*.ts` 7 个 generator / 测试目录）
- 删除 `create-agent-runtime.ts:586` ContextCompiler 实例化
- 删除 `agent-loop.ts:263` `compiler.compile()` 调用
- agent-loop 中改为 messages 直接 pass-through 给 LLM call

> 注：本 PR 不动 `stages/tool-schema-compiler.ts` + 测试——该文件由 PR-A2 删除。本 PR 完成后整个 `compiler/` 目录应被完全移除。

#### PR-A4：砍 `tier-compressor` + `manageWindow` + `TierThresholds` + `onTurnComplete` 主路径改造 ✅ `347ce21`

- 删除 `packages/core/src/context/tier-compressor.ts` + 测试
- 删除 `packages/core/src/context/window-manager.ts` + 测试（含 Pin + eviction + applyTierCompression 全部）
- 删除 `TierThresholds` 类型（`context/types.ts:94-98`）
- 删除 ContextEngine 配置接口的 `tierThresholds` 入参
- 删除 `MessageDrop` 中的 `isPinned` 消费（`message-drop.ts:74,100`）+ 关联 3 个 isPinned 专项测试（`__tests__/message-drop.test.ts:189/200/216`）
- **改造 `ContextEngine.onTurnComplete` 主路径**：从"调用 `manageWindow`（含 tier-compressor + Pin + eviction）+ `checkBudget` + 3 策略" → 改为"直接 `checkBudget` + 调用策略（MessageDrop / LLMSummarize）"，删除 manageWindow 中间层调用

### B 组：基础设施重构与字段扩展

#### PR-B1：`ModelCapability` 接口 + 常量 + `estimateTools` API ✅ `8ca22d7`

- 新建 `packages/providers/src/model-capability.ts`：
  - `ModelCapability` interface
  - `MODEL_CAPABILITIES` 常量（deepseek-v4-pro / deepseek-v4-flash）
  - `UNKNOWN_MODEL_CAPABILITY` 兜底
- config 类型加 `modelCapabilityOverrides?: Record<modelId, Partial<ModelCapability>>` 字段
- `TokenEstimator` 类加 `estimateTools(tools: ToolSpec[]): number` 方法（复用 `estimateTextTokensRaw(JSON.stringify(tool))` 逐工具累加）

#### PR-B2：`AgentRoleProfile.enabledTools` + tools[] 装配重构 ✅ `6132c71`

- `AgentRoleProfile` 类型加 `enabledTools: string[]` 字段
- main / sub-agent profile 实例显式声明 enabledTools（具体集合见 spec §7.2）
- 重构 `create-agent-runtime.ts:511-544` tools[] 装配路径：从硬编码 `baseTools + Task` 改为按 profile 过滤
- session 创建时 freeze tools[]，会话期间不变

#### PR-B3：`CompactMarker` + `Conversation` type 字段扩展 + `/clear` 扩展 ✅ `1b39a6f`

- `CompactMarker` 加两个选填字段：`segmentId?: string` + `structuredSummary?: { facts; state; active }`
- `Conversation` type 加两个选填字段：
  - `taskListState?: { items: TaskItem[] }`
  - `segmentMetadata?: { currentSegmentId: string; segments: SegmentMeta[] }`
- `SegmentMeta` 类型定义（段 ID / 切换时间 / 压缩前后 token 数 / 关联 marker 引用）
- `ConversationRepository.writeMeta` / `readMeta` 读写路径不变（已有 atomic + per-id lock）
- **`/clear` 命令重置语义扩展**：同步清空 `taskListState` + `segmentMetadata`（与字段扩展同 PR，避免引用未定义字段）

#### PR-B4：`TurnContextInjector` 段切换分支 ✅ `bd0f636`（与 PR-C1 同 commit）

- `inject()` 加 `skipTurnContext` 参数（默认 false；段切换压缩请求时传 true，保「缓存安全分叉」格式）
- 当前 PR 加参数但暂无调用方传 true；PR-D1 SegmentManager 实现时接通调用

### C 组：task_list 工具（SegmentManager 评估策略的前置依赖）

#### PR-C1：task_list 工具实现 + state 模型 ✅ `bd0f636`

**依赖**：PR-B3（需 `Conversation.taskListState` 字段）

- 新建 `packages/tools-builtin/src/task-list.ts`：
  - `task_list.set(items)` 单动作工具
  - state 模型 + 持久化到 conversation meta（走 PR-B3 字段）
  - 暴露 `getInProgressTasks(): TaskItem[]` 接口供 SegmentManager 读
- main profile 内置注册

**实际产出 vs spec 差异**（实施时浮现的设计补强，已落地）：

1. **TaskListService 四层架构**（spec 未指定，实施决定）：装配层（assembly factory）→ 业务服务层（`TaskListService`：per-conversation cache + 原子 set with rollback）→ 持久化抽象层（`TaskListStore` interface）→ 持久化实现层（`ConversationRepoTaskListStore` REPL 模式 / `InMemoryTaskListStore` serve 模式过渡）。这一分层让 serve 模式 ephemeral 路径与 REPL 持久路径共用业务逻辑，且 serve 模式后续接入 conversation meta 持久化时无需改业务层。

2. **TaskListProvider（per-turn 上下文注入器）**（spec §8.1 未列）：spec 只说"task_list 状态跨段保留"，但未指明 LLM 读路径。实施时发现 LLM 在段切换后无法读到 task_list state（写入持久化但读不回 LLM 视角），新增 `TaskListProvider` 注入 per-turn 上下文，遵循"有才放"原则（`shouldInject` 返 false 时不污染上下文）。归属 v3 §8.3 TurnContextInjector 概念簇。

3. **ephemeral 路径降级**（spec 未列）：定时任务 / `--print` 等 ephemeral 路径无 conversationId（ALS 中 `conversationId === undefined`），工具层直接 isError 拒绝；TaskListProvider 同条件下 `shouldInject` 返 false。这是"task_list 是会话局部资源"语义的运行时保障。

4. **EMPTY_TASK_STATUS_SUMMARY 双重不变性**（与 task_list 并行修复）：`TaskStatusSummary` 接口字段全部 `readonly` 化（编译期不变性）+ `Object.freeze` 顶层与内层数组（运行时不变性），消除 cli 装配层 fallback 常量曾用的 `as unknown as` 双重断言。归属 scheduler types 层的根因消除式重构（非 type-lying 补丁）。

5. **CLI 装配收敛**（与 task_list 并行修复）：新增 `BuiltinExtraToolsAssembly` factory + `registerCliTurnContextProviders` helper，把 REPL bootstrap / REPL reload swap / serve per-session / serve ephemeral 四个 runtime 装配点的 builtin tool/provider 注册收敛到一处。**杜绝"两入口不对齐"类回归**（实施过程中曾遗漏 serve 路径 TaskListProvider 注册，被 review catch 后通过 helper 抽取根治）。

#### PR-C2：task_list cli 命令 + UI

**依赖**：PR-C1

- 新增 4 个命令到 `buildBuiltinCommands()`：`/tasklist` / `/task <desc>` / `/task new` / `/task done <id>`
- 命令 handler 注册到 `CommandDispatcher`
- cli UI 实时渲染任务列表

### D 组：SegmentManager 核心

#### PR-D1：SegmentManager 核心流程 ✅ `52add6b`

**依赖**：PR-B1（ModelCapability）+ PR-B2（Profile.enabledTools）+ PR-B3（CompactMarker + Conversation 字段）+ PR-B4（TurnContextInjector 分支）+ PR-C1（task_list state）

- SegmentManager 核心编排：turn 边界评估 → 决策 → 压缩 LLM call → 新段组装
- 段切换决策引擎（pass / defer / trigger），in-progress 任务延后触发
- 缓存安全分叉压缩请求（末尾追加压缩指令，保 prefix cache 命中）
- 结构化摘要解析（facts / state / active 三段）与消息组合器（摘要 + 缓冲带）
- agent-loop 在 turn 边界接入 `segmentManager.evaluate`，失败降级不切
- create-agent-runtime 装配（含 capability 解析、stream factory、segment marker accumulator）
- cli 装配层注入 taskListReader + persistence
- TurnContextInjector 新增 `skipTurnContext` 参数支持缓存安全分叉

**实际超范围（一并落地的原 D2 / D3 部分）**：
- `SegmentTransitionHook` interface 完整实现：三 phase（beforeSummarize / afterSummarize / beforeNewSegmentStart）+ 错误分级（beforeSummarize 失败 abort；其他 phase 失败 warning）+ `segment:hook_failed` 事件
- 7 个段切换可观测事件 emit：`evaluation` / `transition_start` / `summarize_complete` / `new_started` / `hook_failed` / `metadata_persist_failed` / `transition_failed`

#### PR-D2：sub-agent risk 检测

**依赖**：PR-D1

**范围已收窄**（原 D2 的 Hook interface 部分已在 D1 实现）。

**架构契合点**：sub-agent loop 已有 `max_tokens` / `wall_clock` 软上限机制——监听 `llm:request_end` 事件 → first-wins 槽位写 `BudgetExceededKind` → abort 同款 controller → `deriveErrorMeta` 按 kind 折类型。本 PR 把"context overflow 检测"作为**同类软上限的新触发条件**，复用全套既有机制，不引入新抽象。

**语义差异（与 max_tokens 区分）**：
- `max_tokens`：累加 `inputTokens + outputTokens` 监控**总成本**（用户配置 budget）
- `context_overflow`：检查**单次** `inputTokens` 监控**注意力质量**（模型固有 risk 阈值）—— 两者监听同一事件源，比对不同指标，触发不同 kind

**触发时机**：post-call（每次 `llm:request_end` 后）—— 与 max_tokens 同模式，graceful 中止下次 turn。首次 call 已发生不可避免，但 sub-agent 初始 messages 极短，首次 inputTokens 主要由 systemPrompt 决定，运行时真实触发场景是"sub-agent 跑了几轮工具累积 messages 后下次 call 超阈"。

**实施改动**：
- `subagent/budget.ts` 的 `BudgetExceededKind` 枚举加 `"context_overflow"` —— 与既有三类（max_turns / max_tokens / wall_clock）同级
- `subagent/loop-runner.ts`：
  - `RunSubAgentLoopOptions` 加 `riskMaxTokens` 字段
  - `usageListener` 内增加单次 `payload.usage.inputTokens > opts.riskMaxTokens` 检查，与 cumulative max_tokens 检查并列
  - 触发时 first-wins 槽位写 `"context_overflow"` + 调 `abortWithReason` 用 origin `"subagent-context-overflow"`
- `subagent/factory.ts` 的 `deriveErrorMeta` 新增 case：
  - `case "context_overflow"` → `type: "sub_agent_context_overflow"`，`message: "sub-task too large for reliable attention. Split the task into smaller, more focused sub-tasks."`
  - message 写为 LLM 可读切片提示（既有 Task 工具失败渲染把 message 直接拼入 ToolResult content）
- `RunChildAgentOptions` 加 `riskMaxTokens`，透传给 `runSubAgentLoop`
- `runChildAgent` 调用方（Task 工具装配或 create-agent-runtime sub-agent 装配处）：
  - 用 `resolveModelCapability(model, override).riskMaxTokens` 解析
  - 注入 `runChildAgent({..., riskMaxTokens})`

**架构收益**：
- 零新 error class（无 `SubAgentContextOverflowError`）
- 零 estimator 注入 sub-agent（usage 是 LLM 真值）
- 零 wrap provider
- 零 agent-loop 改动
- 零 Task 工具改动
- 命名澄清：`BudgetExceededKind` 注释更新清晰说明四类（三成本 + 一质量）的语义差异，未来若需独立分类再 rename 是局部重构

**测试焦点**：
- budget.ts 枚举完整性：新增 "context_overflow" 值
- loop-runner usageListener 触发：单次 `inputTokens > riskMaxTokens` → 槽位写入 + abort
- first-wins 语义：max_tokens 与 context_overflow 同 listener 内 race 时先入槽者胜出
- deriveErrorMeta 折叠：`budgetExceededKind="context_overflow"` → 正确 type + message
- runChildAgent 端到端：超阈值场景返 `ChildAgentResult.status="failed"` + `error.type="sub_agent_context_overflow"`
- Task 工具渲染：既有 failed 路径自然产出 isError ToolResult 含切片提示（task.ts 无需改）
- 装配链：riskMaxTokens 从 model capability 正确解析并透传到 loop-runner
- 未触发场景：正常 sub-agent 调用不受影响（inputTokens 在 riskMaxTokens 内，loop 正常执行）

#### PR-D3：段切换路径 estimator calibration 接入

**依赖**：PR-D1

**范围已收窄**（原 D3 的事件 emit 部分已在 D1 实现）：

- `segmentStreamFactory` 装配链增加 calibration wrapper：
  `resilientCallLLM → wrapStreamWithWatchdog → wrapWithCalibration`
- `wrapWithCalibration` 是透传 stream wrapper：透传所有 stream events，同时累积 usage，流末尾调 `estimator.calibrate(estimated, usage.inputTokens)`
- 不动 `segment/llm-fn.ts`（保持纯文本消费契约）
- 不走 EventBus（避免与主对话 `llm:request_end` 难以区分归属），用流包装精确归属段切换路径

**测试焦点**：
- wrapWithCalibration 流转发不破坏 stream 行为（events 顺序与原始流一致）
- usage 累积后正确调用 calibrate
- 异常路径（abort / error / 空 usage）不调用 calibrate（与 main agent loop 同条件）

---

## 四、Review + 合并顺序

**Feature branch**：`feat/context-v3-phase1`

**Review 顺序**（并行加并行，按依赖收敛）：

```
Wave 1（可并行）：A1 / A2 / A3 / A4 / B1 / B2 / B3 / B4
        ↓
Wave 2：C1（依赖 B3） → C2
        ↓
Wave 3：D1（依赖 B 组全部 + C1）
        ↓
Wave 4（可并行）：D2 / D3
```

**最终合并**：feature branch 累积 11 个 PR 后，**单一 merge commit** 合入 main。

---

## 五、测试策略

| PR | 测试焦点 |
|---|---|
| A1–A4 砍除组 | 现有依赖模块的测试同步删除 / 简化；确保 lint + typecheck 通过 |
| B1 ModelCapability | 单元测试：MODEL_CAPABILITIES 查询 / 兜底 / config override / estimateTools 准确性 |
| B2 Profile.enabledTools | 单元测试：profile 子集 + tools[] freeze；集成测试：session 期间 tools[] byte-equal 验证 |
| B3 字段扩展 | 单元测试：CompactMarker 填法契约（段切换路径 / 兜底路径分别填法）；conversation meta 读写往返 |
| B4 TurnContextInjector | 单元测试：skipTurnContext 参数生效；/clear 重置覆盖新字段 |
| C1 task_list 工具 | 单元测试：set / 持久化 / getInProgressTasks |
| C2 task_list cli | 集成测试：4 个命令 + UI 渲染 |
| D1 SegmentManager 核心 | **集成测试覆盖完整段切换流程** + **缓存安全分叉格式 verify**（压缩请求与上轮 prefix byte-equal） |
| D2 Hook + sub-agent | sub-agent risk 检测 e2e：触发 overflow → throw → main agent 接收 |
| D3 可观测性 | 事件断言测试 + calibration 系数收敛性 |

---

## 六、集成验证（合并主线前的最后一关）

- **e2e 测试**：模拟"对话累积到 optimal/risk 阈值 → 段切换 → 新段继续工作"完整流程
- **cache 命中验证**：段内 LLM call 的 prompt cache 真实命中（从 API response 的 `cacheReadTokens` 验证）
- **v1.2 数据层兜底验证**：模拟段切换重试 3 次失败 → 触发 `LLMSummarize` 兜底
- **真实模型实测**：用 DeepSeek-V4-Pro 跑一轮 >100K tokens 长对话，验证 attention 阈值触发段切换 + 段切换后 LLM 仍能继续工作
- **缓冲带 2 轮的连续性验证**：段切换跨越编程任务时，新段 LLM 能依据缓冲带 + summary 继续完成任务

---

## 七、回滚预案

由于是 feature branch 单一 merge，回滚等价于 revert 该 merge commit。**砍除类 PR 的回滚仅是 git 操作**——v1.2 数据层兜底机制（MessageDrop / LLMSummarize）保留不动，回滚后系统直接退到 v1.2 行为。

---

## 八、PR-C2 详细设计

> 本节是 PR-C2 进入实施前的详细设计沉淀。`三、PR 详细清单` 中 PR-C2 一节仅列范围摘要，本节给出**最终落地形态**——视觉规范、架构分层、模块边界、实施分块。

### 8.1 设计原则

PR-C2 在 cli 上呈现 task_list 状态，与 LLM 工具 task_list.set 共享数据源。设计取舍源于**屏幕空间宝贵 + 用户真实需求**两条第一性原则：

- **80% 时间用户在短问答 / 闲聊**——没用 task_list，UI 不该占空间
- **20% 时间长任务推进**——用户最关心"当前在做什么 + 总进度"，不是完整列表
- **完整列表是偶尔查阅需求**——可由命令拉出，不需要常驻屏幕

→ **双层 UI**：常驻摘要层（屏幕底部 status 行尾段，"当前 + 进度"）+ 按需详情层（`/tasklist` 命令拉完整列表到 scroll region）

### 8.2 屏幕布局

任务信息区**与状态信息区同行**，物理上位于其右侧；逻辑上**完全独立**（任务模块不修改 status-bar 模块）：

```
┌────────────────────────────────────────────────────────────────────┐
│ scrollback                                                         │
├────────────────────────────────────────────────────────────────────┤
│ scroll region（对话内容）                                          │
├────────────────────────────────────────────────────────────────────┤  ← scrollBottom
│ [status info]  │  [task info]                                      │  ← 同一行
│ ╭────────────────────────────────────────────────────────────────╮ │
│ │ ❯ 输入消息或 / 查看命令                                          │ │  ← input box
│ ╰────────────────────────────────────────────────────────────────╯ │
└────────────────────────────────────────────────────────────────────┘
```

**关键性质**：任务功能新增**零额外 chrome 行**——任务区只是 status 行的尾段拼接，行数不变。

### 8.3 任务区视觉规范

**有 in_progress 任务**：

```
◐ 思考中 · 12s · 1.2k  │  实现 task_list cli 命令 (1/4)
```

**有任务但无 in_progress（pending 待推进）**：

```
◐ 思考中 · 12s · 1.2k  │  4 个任务待办 (0/4)
```

**多 in_progress 越界（违反 LLM AT MOST ONE 约束）**：

```
◐ 思考中 · 12s · 1.2k  │  实现 task_list cli 命令 +2 (3/4)
```

**状态信息区未渲染时（idle / 启动初期等场景）任务区独立显示**（无分隔符前缀）：

```
实现 task_list cli 命令 (1/4)
```

**任务列表为空**：任务区输出空文本；状态行随其自身存在与否决定是否渲染（与本设计无关）。

| 元素 | 字符/格式 | 颜色 |
|---|---|---|
| 分隔符 | `│` (U+2502)，前后各 2 空格；仅在状态区与任务区同行时由 chrome 协议绘制 | dim 灰 |
| 任务内容 | 文本 | default（不 dim，要看清） |
| 多 in_progress 后缀 | `+N` | dim |
| 进度括号 | `(N/M)`——N=已完成数，M=总任务数 | dim 灰 |

**设计决策依据**：
- 进度用 `(N/M)` 圆括号合并到任务文本末尾——"附加信息"语法惯例 + 主信息（任务名）在前
- 计数语义统一为"已完成/总数"——通用进度条习惯，符合直觉
- 无左锚字符（如 `▎`）——与分隔符 `│` 视觉字符族重复
- 行末超长由 chrome 行宽 clamp 自然截断 `…`，不引入显式阈值降级
- 任务区独立于状态区——状态区不存在时任务区仍按需显示，确保"屏幕底部永驻"的产品诉求在所有 cli 阶段（含 idle）成立

### 8.4 `/tasklist` 详细视图

`/tasklist` 命令写完整列表到 scroll region（不占 chrome 区，scrollback 可回看）：

```
任务列表 · 4 项 · 1 进行 · 2 待办 · 1 已完成
─────────────────────────────────
  1. ● 实现 task_list cli 命令
  2. ○ 写文档
  3. ○ 验证集成测试
  4. ✓ 调研 cli 架构
```

| 状态 | icon | 颜色 |
|---|---|---|
| in_progress | `●` (U+25CF) | brand 青绿 |
| pending | `○` (U+25CB) | dim 灰 |
| completed | `✓` (U+2713) | green |

**序号**：1-based，与 `/task done <idx>` 一一对应。圆形系（○/●）+ 完成态变形（✓），视觉一致 + 三态层级清晰。

### 8.5 服务层 primitive 扩展

`TaskListService` 在已有 `set / getCached / getInProgressTasks / getAllTasks / prime / clear` 基础上做两组改造：

**改造 A · 既有 `set` 改为"先 save 后 cache"模式（修复乐观更新的 race 风险）**

既有 set 是"先改 cache 后 save，失败回滚 cache"的乐观更新模式 —— 在 cli 与 LLM 并发写时，回滚 cache 与对方读 cache 存在 race。根因是"cache 反映尚未确认的状态"——cache 语义错位。

**`ConversationRepoTaskListStore.save` 已经通过 `ConversationRepository` 的 per-id metaLock + writeAtomic 保证 FIFO 原子序列化**，service 层不需要再加锁。改为：

```typescript
async set(convId: string, items: readonly TaskItem[]): Promise<TaskListState> {
  const next: TaskListState = { items: [...items] };
  await this.store.save(convId, next);  // store 已 atomic 串行；成功才返回
  this.cache.set(convId, next);          // 同步更新 cache
  this.emit(convId, next);
  return next;
}
```

- cache 永远反映"已持久化"状态 —— 语义正确
- save 失败 cache 不动 —— 无需 rollback
- 无需 service 层 mutex / runSerial —— store 已保证 FIFO

**改造 B · 新增 `mutate` + `subscribe` primitive**

```typescript
class TaskListService {
  /**
   * Read-modify-write 便利方法 —— cli 命令（add / done）路径专用。
   * 内部：读 cache 当前 items → 应用 mutator → 调 set（走 store FIFO 锁）。
   * 失败抛错（来自 store.save / mutator）；cache 与持久化一致由 set 保证。
   */
  async mutate(
    convId: string,
    mutator: (current: readonly TaskItem[]) => readonly TaskItem[],
  ): Promise<TaskListState>;

  /**
   * 订阅状态变化 —— UI 模块感知数据更新的唯一入口。
   * 触发时机：set 成功后 + clear 后；返回 unsubscribe 幂等。
   * state: null 表示"已驱逐 / 已清空"（与 cache miss 等价）。
   */
  subscribe(
    listener: (event: { conversationId: string; state: TaskListState | null }) => void,
  ): () => void;
}
```

**改造 C · `clear` 也触发 emit**（修复订阅模式 leak）

既有 `clear(convId)` 仅删 cache，**不 emit** —— 导致 `/clear` 路径走 `service.clear` 后订阅者无法感知。改为：

```typescript
clear(convId: string): void {
  this.cache.delete(convId);
  this.emit(convId, null);  // 通知订阅者：state 已清空
}
```

**根因消除原则**：
- cache 语义统一为"已持久化状态的本地副本"——不存在"乐观假设"的中间态
- 订阅事件 payload `state: TaskListState | null` 覆盖 set / clear / 驱逐三种语义
- cli 命令通过 mutate 走 set，与 LLM 工具的 set 同走 store 的 atomic 锁，无 race
- subscribe 让 UI 与写入路径解耦——LLM 工具 / cli 命令 / 未来远端写入路径都不需知道 UI 模块存在

### 8.6 屏幕协调器扩展

`ScreenController` 新增独立的尾段渲染 API（不动 `setStatusBar`）：

```typescript
interface ScreenController {
  // 已有，行为完全保留
  setStatusBar(lines: readonly string[] | null): void;

  /**
   * 设置状态行尾段文本（纯任务文本，不含分隔符）。
   * 空字符串 / null = 不渲染。
   * 渲染规则由 chrome 协议决定（见下）；行末超长由 chrome 行宽 clamp 自然截断。
   */
  setStatusTail(text: string | null): void;
}
```

**chrome 渲染规则**（statusLines 与 statusTail 两个独立信息源，按各自存在与否分支渲染）：

| statusLines | statusTail | chrome 状态行表现 | 行数 |
|---|---|---|---|
| 非空 | 非空 | 第一行：`statusLines[0] + "  │  " + statusTail`；其余 status 行不变 | `statusLines.length` |
| 非空 | 空 | 按原有行为渲染 statusLines | `statusLines.length` |
| 空 | 非空 | 一行：`statusTail`（不含分隔符前缀） | `1` |
| 空 | 空 | 无 status 区 | `0` |

`computeChromeHeight()` 推导：`statusHeight + inputLines`，其中 `statusHeight = statusLines.length > 0 ? statusLines.length : (statusTail !== null ? 1 : 0)`。chrome 行数按需扩展，与现有 status 行数变化（如 thinking → tool）走同一 DECSTBM 边界推导路径。

**根因消除原则**：
- 任务区**逻辑职责独立**于 status-bar——通过 setStatusTail 独立 API 注入，不改 status-bar 模块、不污染 setStatusBar 语义
- 任务模块输出**纯任务文本**（不含分隔符前缀）——分隔符归属 chrome 协议，由 ScreenController 在拼接时按"是否同行"决定是否绘制
  - 同行场景：chrome 协议绘制 `│` 区分两个信息源
  - 独立场景：无分隔符，任务文本直接渲染
  - 这避免了"任务模块自带分隔符 → 独立显示时 ScreenController 还要 strip 前缀"的反向耦合
- chrome 行数按需扩展——与 input 多行扩展同协议，无需特殊路径

### 8.7 模块布局

```
packages/cli/src/
├── task-tail/                       ← 新增模块（任务区渲染）
│   ├── index.ts                        公共 export：TaskTail / renderTaskList
│   ├── task-tail.ts                    服务订阅 → 调 ScreenController.setStatusTail
│   ├── task-tail-render.ts             纯函数：state | null → string（含分隔符前缀 / 进度 / 越界）
│   ├── tasklist-render.ts              纯函数：state | null → string[]（/tasklist 详细视图）
│   └── __tests__/
│       ├── task-tail-render.test.ts     snapshot：null / 空 / 单 in_progress / 多 in_progress / pending only / 全完成
│       ├── tasklist-render.test.ts      snapshot：详细视图各 mix + null 友好提示
│       └── task-tail.test.ts            订阅 → ScreenController 调用集成 + refresh
├── commands/                        ← 新增模块（命令 handler，未来 /memory 等同模式抽出）
│   ├── task-commands.ts                registerTaskCommands factory + 子命令 parser + echo
│   └── __tests__/
│       └── task-commands.test.ts        通过 dispatcher 端到端
└── repl.ts                          ← bootstrap 接线 + conversation 切换路径调 refresh
```

`task-tail/` 与 `status-bar/` 同层级，互不耦合；`commands/` 把命令 handler 从 `repl.ts` 抽出（**不进 REPL_COMMANDS 数组 + slashCommands 字典**，绕开 legacy 桥接模式），杜绝 god file 继续膨胀。命令注册用 `:repl` 后缀与现有 tRegistry 约定一致。

### 8.8 命令映射

| dispatcher 命令 | rest 解析 | 行为 |
|---|---|---|
| `/tasklist` | 无 | 写完整列表（详细视图）到 scroll region |
| `/task new <desc>` | `new <desc>` | `service.mutate(c, curr => [...curr, { content, status: "pending" }])`；echo `✓ 添加："<desc>"` |
| `/task done <token>` | `done <token>` | token 先按 1-based index → 失败按 UUID 前缀；找不到返友好 error；echo `✓ 完成："<content>"` |
| `/task <desc>` | `<desc>`（无 new/done 关键字）| `/task new <desc>` 的 shortcut |

**命令注册细节**（与现有 typeahead 装配契约对齐）：
- 命令 id 用 `:repl` 后缀（如 `tasklist:repl`、`task:repl`）——与 `repl.ts:1151` 现有约定一致
- 通过 `registerTaskCommands` factory 直接注册到 tRegistry / typeaheadDispatcher，**不进** `REPL_COMMANDS` 数组，**不写** legacy `slashCommands` 字典 entry
- typeahead panel 通过 tRegistry 自动发现新命令，免额外接线

**省略原因记录**：
- 不加 `/task progress <id>`——in_progress 状态由 LLM 通过 task_list 工具自管；用户手动管会与 LLM 自管竞争
- 不加 `/task delete <id>`——completed 是终态；保持最小 scope

**ephemeral 拒绝**：`getConversationId() === undefined` 时（一次性 run / 定时任务）命令返回友好提示——与 task_list 工具行为对齐（task list 是 conversation-scoped 资源）。

**命名避让**：`/tasks` 已绑 scheduler 任务，不动；新命令用 `/tasklist`。

**Echo 范围**：cli 命令完成后 echo 简短确认（`✓ <action>："<content>"` dim 灰）；LLM 调 task_list.set 时工具 result 已 renderSummary，**不额外 echo**。

### 8.9 渐进式实施

每步独立可验证、不依赖未完成代码：

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | `TaskListService` 改造：set 改"先 save 后 cache" + mutate + subscribe + clear emit | 单元测试：set 失败 cache 不动、订阅触发时机、clear emit(null)、并发交错最终一致、unsubscribe 幂等、监听器抛错隔离 |
| 2 | `task-tail-render.ts` + `tasklist-render.ts` 纯函数 | snapshot 测试覆盖任务区 + 详细视图全部状态组合（含 null state） |
| 3 | `ScreenController.setStatusTail` API + chrome 第一行拼接 + clampLine | 现有 status-bar / segment / cursor 测试不退化 + 新拼接 + 超长截断集成测试 |
| 4 | `TaskTail` 类：service 订阅 + setStatusTail 投递 + refresh + dispose | 集成测试：service 写入 / clear / refresh 触发 tail 更新；start 前已有数据时 refresh 拉初值 |
| 5 | `commands/task-commands.ts` 4 命令 + 子命令 parser + echo（命令 id 用 `:repl` 后缀） | E2E：通过 dispatcher 调用，断言 service state + writer output |
| 6 | `repl.ts` bootstrap 接线 + conversation 切换路径接线 + 手动 smoke | 实测：启动 cli、`/task new ...` → tail 出现；`/new` `/switch` 后 tail 跟随新对话；与 LLM 工具同步刷新 |

**Step 6 接线清单**（明确，避免装配遗漏）：
- bootstrap：创建 `TaskTail` 实例，`getConversationId: () => state.conversationId`，调 `start()`
- `/new` handler 末尾（line 306 之后）：`taskTail.refresh()`
- `/switch` handler 末尾（line 349 之后）：`taskTail.refresh()`
- `/clear` 已通过 `service.clear` emit(null) 自动处理，**无需**额外 refresh
- `registerTaskCommands({ ..., service, getConversationId, writer })` 在 bootstrap 调一次完成命令注册

**实施注意**：
- Step 1 改 task-list.ts 是**API 行为变更**（先 save 后 cache 与既有"先 cache 后 save 回滚"不同语义）——需要回归 task_list 工具的现有测试，特别是 split-brain 测试用例
- Step 6 手动 smoke 验证 cli 启动行为（涉及 raw mode / DECSTBM，不能自动化），眼看

### 8.10 与 UI 底层 chrome 协议的契合

`screen-controller.ts` 采用 DECSTBM 三区模型（scrollback / scroll region / chrome），chrome 协议有 4 个硬约束。task-tail 设计必须**完全契合**：

| 约束 | 含义 | task-tail 对应策略 |
|---|---|---|
| chrome 不 emit `\n` —— 破坏 region 永驻 | chrome 渲染通过绝对寻址逐行写，不靠换行推进 | 不新增 chrome 行，拼到 status 第一行末尾 |
| chrome 行宽 ≤ viewportCols−1 —— 防隐式 wrap | 超长行会被终端隐式换行，物理行 > 逻辑行 → DECSTBM 边界错位 | 拼接后 `clampLine` 兜底，超长 truncate `…` |
| chromeHeight 显式贯穿 DECSTBM 边界 | scrollBottom = viewportRows − chromeHeight，必须与 buildChromeBytes 起手行同公式 | `computeChromeHeight` 按 status / tail 双源**按需扩展**——与现有 status 行数变化（thinking → tool 等）走同一 refreshChrome 路径，DECSTBM 协议保持一致 |
| 写入路径 enqueue + flush 串行化 | 所有 chrome 操作经队列保原子 | setStatusTail 也走 enqueue，与 setStatusBar / refreshChrome 不冲突 |

**核心收益**：tail 是 chrome 协议的合理扩展——chrome 区表达"屏幕底部固定信息层"，statusLines 与 statusTail 是两个独立信息源，按各自存在与否决定渲染布局。`computeChromeHeight` 推导路径不变（按需 max），`refreshChrome` 路径完全沿用现有协议（与 status 行数变化同源），不触发 DECSTBM 协议层面的新逻辑。`clampLine` 已是 ANSI-aware 的行宽兜底工具（与 writeScrollLine / segment 同合约），改动局限在 `buildChromeBytes` 内 status 区分支与 `computeChromeHeight` 双源推导两处，无破坏性。

### 8.11 数据流与模块协同

写入路径**全收敛**到 `TaskListService.set`（mutate 内部也调 set）；读取路径通过 subscribe 异步推送：

```
┌──────────────────────────────────────────────────────────────┐
│ 写入路径（统一收敛到 service）                                │
│                                                              │
│  LLM tool task_list.set ──┐                                  │
│  cli /task new <desc>  ──┤                                   │
│  cli /task done <idx>  ──┤──→ TaskListService.set            │
│                                       │                      │
│                                       ▼                      │
│                              await store.save                │
│                                  (Repository per-id metaLock │
│                                   + writeAtomic，FIFO 原子)  │
│                                       │ ok                   │
│                                       ▼                      │
│                              cache.set + emit                │
└────────────────────────────────────────┬─────────────────────┘
                                         │ subscribe
                                         ▼
                          ┌──────────────────────────┐
                          │ TaskTail（订阅者）       │
                          │   state | null →         │
                          │   renderTaskTail         │
                          └────────────┬─────────────┘
                                       │ setStatusTail(text|null)
                                       ▼
                          ┌──────────────────────────┐
                          │ ScreenController         │
                          │   status / tail 双源渲染 │
                          │   同行 → 拼接 + 分隔符   │
                          │   独立 → tail 单独成行   │
                          │   clamp viewportCols-1   │
                          └──────────────────────────┘
```

**架构原则落地**：
- service 是数据真相唯一源，写路径全收敛——杜绝双写入口的不一致
- 写入串行化由 `ConversationRepository` 的 per-id metaLock 兜底，service 层不重复加锁（避免双层锁冗余）
- cache 永远反映"已持久化状态" —— save 成功才落 cache + emit；失败 cache 不动
- TaskTail 是订阅者，**不感知** LLM / cli 写路径；payload `state | null` 统一覆盖 set / clear / 驱逐
- ScreenController 是 chrome 协议层——管理 status / tail 双源的同行 vs 独立渲染规则；分隔符归 chrome 协议而非任务模块——任务模块只输出纯任务文本，无需感知"是否与 status 同行"

### 8.12 关键代码骨架

#### TaskListService primitive 扩展

```typescript
type SubscribeListener = (e: { conversationId: string; state: TaskListState | null }) => void;

class TaskListService {
  private readonly cache = new Map<string, TaskListState>();
  private readonly subscribers = new Set<SubscribeListener>();
  // 注：写入串行化由 store（ConversationRepository per-id metaLock）保证，service 不重复加锁

  /**
   * 写入语义：先 save 后 cache。
   * - save 由 store 的 per-id metaLock 保证 FIFO 原子持久化
   * - save 成功才更新 cache + emit —— cache 永远反映"已持久化"状态
   * - save 失败抛错，cache 保持原状，不 emit
   */
  async set(convId: string, items: readonly TaskItem[]): Promise<TaskListState> {
    const next: TaskListState = { items: [...items] };
    await this.store.save(convId, next);
    this.cache.set(convId, next);
    this.emit(convId, next);
    return next;
  }

  /**
   * Read-modify-write 便利方法 —— cli 命令（add / done）路径专用。
   * 流程：ensure prime（从磁盘加载到 cache）→ 读 cache 当前 items → 应用 mutator → 调 set。
   *
   * prime 是 service 层的自防御：避免 caller 遗漏 prime 时 mutator 收到空数组，
   * 错误覆盖磁盘上已有的任务（数据丢失）。prime 幂等 + cache 有则 early return，零额外开销。
   *
   * 并发语义：cache 读 + mutator + store.save 之间不持锁；store FIFO 串行多次写入时，
   * mutate 内部基于其调用时刻的 cache 快照计算。LLM 与 cli 并发场景下结果由最后写入者决定。
   */
  async mutate(
    convId: string,
    mutator: (current: readonly TaskItem[]) => readonly TaskItem[],
  ): Promise<TaskListState> {
    await this.prime(convId);
    const curr = this.cache.get(convId)?.items ?? [];
    return this.set(convId, mutator(curr));
  }

  subscribe(listener: SubscribeListener): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  /**
   * 清空 cache + 触发 emit（state=null）—— `/clear` 路径调用。
   * 磁盘端持久化由 caller 单独处理（如 conversationRepo.clearViewLayerState），
   * 本方法仅负责 cache 驱逐 + 通知订阅者。
   */
  clear(convId: string): void {
    this.cache.delete(convId);
    this.emit(convId, null);
  }

  private emit(convId: string, state: TaskListState | null): void {
    for (const l of this.subscribers) {
      try { l({ conversationId: convId, state }); } catch { /* 隔离 */ }
    }
  }
}
```

**关键设计点**：
- **不引入 service 层 mutex** —— store 已 atomic，避免双层锁冗余
- cache 语义统一为"已持久化的本地副本"，无乐观更新中间态
- emit 在 save 成功之后或 clear 时触发——订阅者看不到失败的中间态
- 监听器抛错 swallow——一个订阅者异常不影响其他订阅者

#### ScreenController setStatusTail + computeChromeHeight + buildChromeBytes

```typescript
// chrome 协议层的分隔符 —— status / tail 同行时绘制，归 chrome 协议非任务模块
private static readonly STATUS_TAIL_SEPARATOR = `  ${tone.dim("│")}  `;

private statusTail: string | null = null;

setStatusTail(text: string | null): void {
  this.enqueue(() => {
    const next = text && text.length > 0 ? text : null;
    if (next === this.statusTail) return;  // 幂等：无变化不重画
    this.statusTail = next;
    if (this.scrollRegion.state.attached) {
      this.refreshChrome();
    }
  });
}

// detach / dispose 路径同步清理 statusTail，避免重新 attach 时旧 tail 复活
detachInput(): void {
  this.enqueue(() => {
    if (this.scrollRegion.state.attached) {
      this.scrollRegion.detachInput();
    }
    this.input = null;
    this.statusLines = [];
    this.statusTail = null;
    this.hasActiveSegment = false;
  });
}

dispose(): void {
  // ... 既有 dispose 流程
  this.queue.push({
    run: () => {
      if (this.scrollRegion.state.attached) {
        this.scrollRegion.shutdown();
      }
      this.input = null;
      this.statusLines = [];
      this.statusTail = null;  // 与 detachInput 对称清理
      this.preAttachContent = "";
      this.hasActiveSegment = false;
    },
  });
  // ...
}

// status / tail 双源 → chrome 行数按需扩展
private computeChromeHeight(): number {
  const inputLines = this.input ? this.input.renderLines().length : 0;
  const statusHeight = this.statusLines.length > 0
    ? this.statusLines.length
    : (this.statusTail !== null ? 1 : 0);
  return statusHeight + inputLines;
}

// 双源渲染：同行拼接 + 分隔符 / 独立成行
private buildChromeBytes(chromeHeight: number): string {
  if (chromeHeight === 0) return "";
  const scrollBottom = this.viewportRows - chromeHeight;
  const startRow = scrollBottom + 1;
  const lineBudget = this.viewportCols - 1;

  const allLines: string[] = [];
  if (this.statusLines.length > 0) {
    // 有 status：tail 拼到第一行（chrome 协议绘制分隔符）
    for (let i = 0; i < this.statusLines.length; i++) {
      let line = this.statusLines[i]!;
      if (i === 0 && this.statusTail) {
        line = line + ScreenControllerImpl.STATUS_TAIL_SEPARATOR + this.statusTail;
      }
      allLines.push(clampLine(line, lineBudget));
    }
  } else if (this.statusTail) {
    // 无 status：tail 独立一行（无分隔符，加 layout.contentPrefix 与 cli 全局对齐契约一致）
    allLines.push(clampLine(layout.contentPrefix + this.statusTail, lineBudget));
  }
  if (this.input) {
    for (const line of this.input.renderLines()) allLines.push(line);
  }

  let bytes = "";
  for (let i = 0; i < allLines.length; i++) {
    bytes += `\x1b[${startRow + i};1H\x1b[2K${allLines[i]}`;
  }
  return bytes;
}
```

`clampLine` 来自 `tui/line-width.ts`（已有 API，ANSI-aware，与 writeScrollLine / segment 同一行宽合约工具）。`layout.contentPrefix` 来自 `tui/style.ts`（cli 全局左对齐 token，状态行 / AI 行 / 工具卡片等同用）。`computeChromeHeight` 按双源 max 推导，`refreshChrome` 路径不变——chrome 行数变化与现有 status 行数变化走同一 DECSTBM 边界推导。

#### task-tail-render 纯函数

```typescript
/**
 * 渲染任务区文本 —— 纯任务内容，不含分隔符前缀。
 * 分隔符由 chrome 协议在拼接到状态行时绘制（见 ScreenController.STATUS_TAIL_SEPARATOR）。
 * 空列表 / 全完成 / state=null 返回空字符串 → ScreenController 不渲染 tail 行。
 */
export function renderTaskTail(state: TaskListState | null): string {
  if (!state || state.items.length === 0) return "";

  const items = state.items;
  const inProgress = items.filter((t) => t.status === "in_progress");
  const total = items.length;
  const completed = items.filter((t) => t.status === "completed").length;
  const pending = items.filter((t) => t.status === "pending").length;

  // 全完成：列表已"事实关闭"，不显示
  if (inProgress.length === 0 && pending === 0) return "";

  let main: string;
  if (inProgress.length === 0) {
    main = `${pending} 个任务待办`;
  } else if (inProgress.length === 1) {
    main = inProgress[0]!.content;
  } else {
    main = `${inProgress[0]!.content} ${tone.dim(`+${inProgress.length - 1}`)}`;
  }

  return main + " " + tone.dim(`(${completed}/${total})`);
}
```

#### TaskTail 类（订阅 + 生命周期）

```typescript
export class TaskTail {
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly opts: {
    screen: ScreenController;
    service: TaskListService;
    /**
     * 取当前活跃 conversation id —— 来自 cli REPL state.conversationId（持久化对话场景），
     * 不是 task_list 工具的 ALS 路径（仅在 turn run 内有效）。
     * 装配方负责让此函数反映当前活跃 conversation；切换对话后由 caller 调 refresh()。
     */
    getConversationId: () => string | null | undefined;
  }) {}

  start(): void {
    if (this.disposed) throw new Error("TaskTail.start after dispose");
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.service.subscribe((e) => {
      // 仅响应当前 conversation 的事件（多 conversation 隔离）
      if (e.conversationId !== this.opts.getConversationId()) return;
      // e.state 可能是 null（clear / 驱逐），renderTaskTail 直接处理
      this.opts.screen.setStatusTail(renderTaskTail(e.state) || null);
    });
    this.refresh();  // 启动时显式拉初值（service 已有数据但未 emit 的情况）
  }

  /**
   * 显式刷新 —— conversation 切换路径（/new / /switch）必须调用。
   * /clear 路径不需要（service.clear 会 emit state=null → subscribe handler 自动处理）。
   */
  refresh(): void {
    if (this.disposed) return;
    const convId = this.opts.getConversationId();
    if (!convId) {
      this.opts.screen.setStatusTail(null);
      return;
    }
    const state = this.opts.service.getCached(convId);
    this.opts.screen.setStatusTail(renderTaskTail(state) || null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.opts.screen.setStatusTail(null);
  }
}
```

**注**：TaskTail **不订阅** `ScreenController.onSuspendChange`——TaskTail 是事件驱动无 ticker，suspended 期间即使收到 emit，setStatusTail 入队后由 ScreenController 自身的暂存机制自然延后到 resume；不存在 status-bar 那样的周期 ticker 浪费。

### 8.13 与既有 cli 机制的契合点

| 既有机制 | 来源 | task-tail 如何契合 |
|---|---|---|
| ScreenController enqueue + flush | `screen-controller.ts` | setStatusTail 入队，自动串行不与 setStatusBar / attachInput 等冲突 |
| suspend / resume 暂存 | ScreenController flush 暂停 | TaskTail **不订阅** onSuspendChange——事件驱动无 ticker，setStatusTail 入队后由 ScreenController 自动暂存，resume 后 flush |
| repaintInputCursor | `refreshChrome` 路径 | refreshChrome 内已含；setStatusTail 后 cursor 位置自动正确 |
| 行宽硬合约 | `tui/line-width.ts` clampLine（ANSI-aware） | 拼接后 clamp 到 viewportCols-1，与 writeScrollLine / segment 同合约 |
| ConversationRepository per-id metaLock | `repository.ts` `withMetaLock` | store.save 已 FIFO 原子；service 层不重复加锁 |
| `/clear` 走 clearViewLayerState + service.clear | `repl.ts` | service.clear 触发 emit(state=null) → TaskTail subscribe handler 自动 setStatusTail(null) |
| `state.conversationId`（cli REPL 状态） | `repl.ts:109` CliReplState | TaskTail.getConversationId 注入 `() => state.conversationId`——与 task_list 工具的 ALS 路径独立 |
| `/new` / `/switch` 改 state.conversationId | `repl.ts:306 / 349` | conversation 切换后 caller 必须显式调 `taskTail.refresh()`（subscribe 不感知 state.conversationId 变化） |

### 8.14 风险防控与测试覆盖

| 风险 | 防控措施 | 验收手段 |
|---|---|---|
| buildChromeBytes 改动影响 status 渲染 | 改动局限于 status 区分支与 computeChromeHeight 双源推导；其余路径完全保留 | Step 3 前 `pnpm test screen-controller` 全绿；改后回归测试同条件全绿 |
| status idle 时 tail 不显示 | computeChromeHeight + buildChromeBytes 双源分支：无 status 时 tail 独立成行 | idle 场景集成测试：setStatusBar(null) + setStatusTail("x") → chromeHeight=1+input，tail 渲染在状态行位置 |
| 拼接后超 viewportCols-1 → 隐式 wrap | clampLine 统一兜底（已是 ANSI-aware） | 专项测试 `status + tail > viewportCols → 结果 ≤ viewportCols-1` |
| LLM set 与 cli mutate 并发写顺序 | store 的 per-id metaLock 保 FIFO 原子；cache 反映"已持久化"状态 | 并发测试：LLM set + cli mutate 交错，验证最终 cache 与磁盘一致 |
| mutate 在 cache miss 时丢磁盘已有数据 | mutate 内置 `await this.prime(convId)` 自防御，不依赖 caller 装配 | 测试：磁盘有 [A,B,C] / cache 未 prime → mutate 加 D → 最终持久化 [A,B,C,D] |
| 订阅者抛错传染 service | emit 内 try-catch swallow | 多订阅者测试，一个抛错不影响其他订阅者收到事件 |
| TaskTail 启动时 service 已有数据但未 emit | start() 内显式 refresh() 拉初值 | 启动顺序测试：service 先 set → 后 start，断言 tail 立即显示 |
| `/clear` 路径 tail 不刷新 | service.clear emit (state=null) → subscribe handler 自动 setStatusTail(null) | clear 集成测试：clear 后 emit 收到 null + tail 立即隐藏 |
| `/new` `/switch` 切换 conversation tail 不刷新 | caller 切换 state.conversationId 后必须显式调 taskTail.refresh() | conversation 切换集成测试，断言 tail 跟随新 convId 内容 |
| detach / dispose 后重新 attach 旧 tail 复活 | detachInput / dispose 同步清空 statusTail（对称清理） | detach → attach 测试：attach 后 chrome 不含旧 tail |
| tail 独立显示时违反 cli 全局对齐契约 | buildChromeBytes 独立分支注入 `layout.contentPrefix` —— 与 status / AI / 工具卡片等同对齐 token | 视觉测试：idle + tail → 行前 2 空格，与有 status 时 statusLines[0] 起手列对齐 |
| 长任务内容 truncate 后 `(N/M)` 被截掉 | clampLine 是从末尾截断，超长任务可能丢进度 —— 接受此降级（窄终端语义） | 文档化此行为；不为之引入复杂的优先级保留策略 |

### 8.15 装配契约（基于已查证的实际现状）

**conversationId 来源 —— 两条独立路径，不要混淆**：

| 路径 | 来源 | 适用对象 |
|---|---|---|
| ALS（异步上下文存储） | `runContextStorage.getStore()?.conversationId` | task_list 工具（仅 turn run 内有效） |
| cli REPL 状态 | `state.conversationId`（CliReplState） | TaskTail（长生命周期，turn 之外也需要） |

两者必须指向同一 conversation；装配上：cli 启动 turn 时把 `state.conversationId` 注入 ALS run-context；TaskTail 始终从 `state.conversationId` 读，**不**走 ALS。

**Refresh 触发路径**（subscribe 不感知 state.conversationId 变化）：

| 路径 | 是否需要 refresh | 原因 |
|---|---|---|
| LLM 调 task_list.set | 否 | service.set emit → subscribe 自动处理 |
| cli `/task new` `/task done` | 否 | mutate → set → emit → subscribe 自动处理 |
| cli `/clear` | 否 | service.clear emit(state=null) → subscribe 自动处理 |
| cli `/new` 创建新对话 | **是** | state.conversationId 改变，但 service 未必 emit；显式调 taskTail.refresh() |
| cli `/switch` 切换对话 | **是** | 同上 |
| cli session 启动 / 恢复 | 已在 TaskTail.start() 内自动 refresh | 不需要 caller 额外调 |

**TaskListService API 行为变更（PR-C2 内的破坏性调整）**：

| 既有行为 | 改造后行为 | 影响范围 |
|---|---|---|
| `set` 先改 cache 后 save，失败回滚 cache | 先 save 后改 cache，失败 cache 不动 | task_list 工具的现有测试（特别是 split-brain 用例）需要回归验证语义对齐 |
| `clear` 只删 cache | 删 cache + emit(state=null) | 新增订阅者契约，既有 cli `/clear` 路径调用方式不变 |
| 无 mutate / subscribe | 新增 | 纯添加，向后兼容 |

迁移风险：现有 task_list 工具的"set 失败回滚"测试需要重新审视——新语义下 cache 不会被乐观更新，"回滚"概念消失，相关测试用例语义更新。
