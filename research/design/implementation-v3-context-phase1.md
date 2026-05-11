# v3 上下文管理 · Phase 1 实施计划

> **状态**：🚧 进行中 —— Wave 1 全部 ✓ + Wave 2 PR-C1 ✓；剩 Wave 2 PR-C2 + Wave 3/4 D 组
>
> **范围**：v3 spec [§10 Phase 1](specifications/context-management-v3-redesign.md) 的工作分解到 PR 粒度
>
> **关联**：
> - [context-management-v3-redesign.md](specifications/context-management-v3-redesign.md) — 设计权威
> - [active-problem.md](active-problem.md) — 工作台状态
> - [implementation-roadmap.md](implementation-roadmap.md) — 项目总线（待登记 v3 为并行工作流）
>
> **实施模式偏离**：原计划「feature branch 累积所有 PR 后单一 merge」，实际按 commit 直接入主线（截至 2026-05-11 共 9 个 commit）。功能耦合的原子上线约束仍生效——D 组合入前必须确保 Wave 2 完成态不 regression（v1.2 数据层兜底机制保留中）。

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
                  D1 SegmentManager 核心 (依赖 B1+B2+B3+B4 + C1)
                  D2 Hook 接口 + sub-agent risk (依赖 D1)
                  D3 可观测性事件 + calibration 接入 (依赖 D1)
```

**总 PR 数：11 个**（不含 1.E 失效文档 deprecated，已完成）

**进度**：A1 ✓ / A2 ✓ / A3 ✓ / A4 ✓ / B1 ✓ / B2 ✓ / B3 ✓ / B4 ✓ / C1 ✓ / C2 ⏳ / D1 ⏳ / D2 ⏳ / D3 ⏳

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

#### PR-D1：SegmentManager 核心流程

**依赖**：PR-B1（ModelCapability）+ PR-B2（Profile.enabledTools）+ PR-B3（CompactMarker + Conversation 字段）+ PR-B4（TurnContextInjector 分支）+ PR-C1（task_list state）

- 新建 `packages/core/src/context/segment/segment-manager.ts`：
  - 触发评估逻辑（spec §四：双档阈值 + turn 边界 + in-progress 延后）
  - 压缩请求（spec §5.1：缓存安全分叉格式 + 压缩指令 prompt 模板）
  - 新段 user message 拼接（spec §5.2：摘要 + 缓冲带 2 轮 + 用户新输入）
  - 段标记写入（CompactMarker.structuredSummary + 追加到 `Conversation.segmentMetadata.segments[]`）
  - 失败兜底（spec §5.5：重试 3 次 + 降级为不切）
- 挂入 `agent-loop.ts` 精确位置：`turn_complete` 事件之后、`contextManager` 之后、state 重建之内
- prompt 模板放 `segment-manager/prompts.ts`（v3 spec §5.1 模板）

#### PR-D2：`SegmentTransitionHook` 接口 + sub-agent risk 检测

**依赖**：PR-D1

- `SegmentTransitionHook` interface 定义（spec §六：beforeSummarize / afterSummarize / beforeNewSegmentStart）—— 仅接口，无实现
- sub-agent 路径 pre-flight risk 检测：
  - 在 `subagent/loop-runner.ts` LLM call 之前比对 `state.totalUsage.inputTokens` 与 sub-agent profile 的 `riskMaxTokens`
  - 超出则 throw `SubAgentContextOverflowError`（特定 error class）
  - main agent 在 Task 工具内接收该 error，作为"任务过大需重新切片"信号返回 LLM

#### PR-D3：可观测性事件 + estimator calibration 接入

**依赖**：PR-D1

- 6 个段切换事件 emit（spec §8.5）：
  - `segment:evaluation` / `segment:transition_start` / `segment:summarize_complete` / `segment:new_started` / `segment:transition_failed` / `cache:metrics`
- estimator calibration 接入段切换压缩请求路径：用 LLM 返回的 `inputTokens` 校准 estimator 系数

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
