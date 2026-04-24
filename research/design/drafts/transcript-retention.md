# Transcript 持久化治理（执行过程归档）

> **文档定位（2026-04-24 更新）**：本文档是 Phase 5 transcript 治理的**执行过程归档**,不作为其他设计文档的引用源。
> - **权威 spec（single source of truth）已更新,请以这些文档为准**：
>   - [conversation-model.md §9.5 + ADR-CM-015 + ADR-CM-017](../specifications/conversation-model.md)——commitTurn 原子截断、接口契约
>   - [session-persistence.md §2.3 + §4.5 + §5](../specifications/session-persistence.md)——文件不变量、TranscriptStore 接口、写入实现
>   - [context-architecture.md §8.5](../specifications/context-architecture.md)——compact_end 事务化事件、turnsCompacted 精确计算
> - **保留本文档的价值**：详细的问题审计（§0.1 完整链条审计 / §0.2 25 个 P0 问题分级）、5 阶段执行顺序、ADR-TR-1 到 TR-9 的推导过程、§4 接口变更清单的历史记录。这些属于"工程过程知识",精简合并会丢失,保留作未来重访参考。
> - **不要双写**：新的设计决策（如 Phase 6+ 演进）应该写入权威 spec,不要再编辑本文档；本文档作为**冻结归档**保留。
>
> **原始目标**：一次性修掉 transcript.jsonl 无限增长 + 多个隐蔽 Bug，统一 REPL / server 的 compact 持久化路径。
> **实施结果**：Phase 1-5 + Bug A/B 全部完成,三包 2456 tests 全绿；core + server dist 重建。权威 spec 已同步。
> **关键约束（历史背景）**：治理依赖 compact **有真实语义**。经审计，当时 compact 链条本身就是坏的——直接把磁盘清理挂到"compact 事件"上会永久丢数据。因此前置了 **M0 修复 compact 链条**（Phase 1-4），然后才做 M1-M5 的持久化治理（Phase 5）。

---

## 0. 预置修复 — Compact 链条本身（M0）

### 0.0 架构骨架与执行顺序

> **设计原则**：25 个问题不是零散 bug，是 5 类架构失衡的表象。统一骨架修复，避免各自为政导致的二次冲突。

#### 五类骨架

| 骨架 | 现状失衡 | 治理方向 | 覆盖问题 |
|------|--------|---------|---------|
| **1. 双环触发** | compact 只在单点（tool 循环尾）触发 | 外环 `run 级`（pre-flight / post-flight）+ 内环 `turn 级`（保留） | P0-F, P0-H, P0-L |
| **2. 事务化事件** | 多策略各自 fire，覆盖式接收 | 一次 compact = 一次事务；事务结束 fire 唯一 `compact_end`，payload 含所有 strategy 贡献 + 权威 summary / turnsCompacted | P0-B, P0-D, P0-E, P0-Q, P0-Y |
| **3. 单一事实源** | LLM context / state.messages / transcript 三处状态互不一致 | `RunResult.postRunMessages` 权威快照 + `compactBefore` 元数据；通过 M1 的 `commitTurn({turn, compactBefore})` 原子收敛 | P0-O, M1-M4 |
| **4. 策略链契约化** | 各策略各自切分、各自 callLLM、各自 fire | 共享 `splitMessagesPairAware` helper；统一 `FlushLLMFn(msgs, {abortSignal})`；统一占位符 `<system-meta>` 包装 | P0-A, P0-P, P0-R, P0-S, P0-T, P0-W, P0-X, P0-Z, P0-AA |
| **5. 跨 run 状态容器** | engine 每次新建，内部字段丢失 | digestHistory / breaker / estimator 全部上移到 `AgentRuntime` 层；engine 降级为短命协调器 | P0-BB, P0-J |
| **6. 配置安全网** | profile 忘传 = 死代码；modelInfo 缺失 = 静默禁用 | 默认值 + warn log + 用户覆盖配置构成三层安全网 | P0-C, P0-U |

#### 执行顺序（5 阶段 + 清洁度）

```
Phase 1 安全网与激活（独立 · 最先做）
  ├─ P0-U modelInfo 安全降级（避免静默禁用）
  ├─ P0-C 生产 engine 注入 INTERACTIVE_PROFILE
  └─ P0-T splitMessagesPairAware helper（注册 LLMSummarize 的前置）
      ↓
Phase 2 策略链契约化（依赖 P0-T）
  ├─ P0-W abortSignal 透传（FlushLLMFn 签名统一）
  ├─ P0-A 注册 LLMSummarize（依赖 P0-T + P0-W）
  ├─ P0-P MessageDrop canApply 加预算前置（P0-A 配套）
  ├─ P0-R / P0-S MemoryFlush 预算前置 + tail 截断
  └─ P0-X / P0-Z 占位符统一 <system-meta> 包装
      ↓
Phase 3 事务化事件（依赖 Phase 2）
  ├─ P0-E CompactionResult.summary / turnsCompacted 字段扩展
  ├─ P0-D engine 改为事务化 fire（唯一 compact_end，汇总 payload）
  ├─ P0-B run-agent 订阅读取真实 summary
  ├─ P0-Q 手动 /compact 同走事务链
  └─ P0-Y budget_check 补发"post-compact" phase
      ↓
Phase 4 双环触发（依赖 Phase 3 的 P0-D）
  ├─ P0-F pure-text turn 触发 compact
  ├─ P0-H run 入口 pre-flight
  └─ P0-L critical 硬挡 + force-apply LLMSummarize
      ↓
Phase 5 单一事实源（依赖 Phase 4 + 和 M1 合并设计）
  ├─ P0-O RunResult.postRunMessages 权威快照
  ├─ P0-BB digestHistory 上移到 AgentRuntime 层
  └─ M1-M4 commitTurn 原子事务 + 原子截断

清洁度（任何时间可插入，不阻塞主线）
  P0-J / P0-AA / P1-a / P1-b / P2
```

**关键约束**：
- Phase 1 → 2 严格顺序（P0-T 未修前 P0-A 注册 = 生产 crash）
- Phase 2 → 3 严格顺序（事务化需要新字段）
- Phase 3 → 4 松耦合（触发增加后事件链必须已能正确汇报）
- Phase 5 融合 M1-M4（commitTurn 同时修 compact 跨 run 和 transcript 截断）

---

### 0.1 完整链条审计

```
agent-loop (每个 tool 循环完)
  └─ contextManager.onTurnComplete(messages, turnCount)
       │
       ├─ Step 1: manageWindow (Tier 压缩 + Pin-aware 淘汰)
       │    条件：this.config.profile?.tierThresholds 非空
       │    ⚠️ 生产路径 run-agent.ts 创建 engine 从不传 profile
       │    → Window/Tier 整个是【死代码】
       │
       ├─ Step 2: checkBudget
       │    实际阈值 = DEFAULT_THRESHOLDS (0.75/0.85/0.95)
       │    ⚠️ INTERACTIVE_PROFILE 定义的 0.65/0.80/0.90 未生效（死代码）
       │
       └─ Step 3: for strategy in strategies  （超阈值时）
            ├─ ToolResultTrim    (P0, 裁工具结果)
            ├─ MemoryFlush       (副作用, compacted=false → fire success=false，订阅方默认忽略)
            └─ MessageDrop       (P5, 丢中间消息 + 插占位)
            ⚠️ LLMSummarizeStrategy 存在且有单测，但【没人注册】
            ⚠️ 每个 strategy 各自 fire 一次 compact_end（成功/失败两路），后覆盖前

run-agent.ts 订阅 compact_end
  └─ compactInfo = {
       summary: "(auto-compacted)",   ⚠️ 【硬编码占位】
       turnsCompacted: 0,              ⚠️ 【硬编码 0】
       tokensBefore, tokensAfter,     ✓ 从事件取，准
     }

RunResult → REPL appendCompact → transcript.jsonl
  marker.summary = "(auto-compacted)"
  ⚠️ 下次 load 时 rebuildMessages 把这个塞进 LLM：
     "[对话已压缩] 以下是之前对话的摘要：(auto-compacted)"
     → LLM 只知道"之前被压过"，内容完全丢失
```

### 0.2 问题分级

#### 架构级（必须在做 M1 前解决）

| # | 问题 | 位置 | 若不修的后果 |
|---|------|------|-----|
| **P0-F** | **`onTurnComplete` 只在 agent-loop 的 tool 循环尾调用**；LLM 纯文本回复（无 tool_use）时 Loop 直接 `return`，跳过 compact 检查 | `agent-loop.ts:119-125` vs `:148-157` | **社交通道 / 纯聊天 turn 根本不触发 compact**——上下文堆到 API token 超限直接报错 |
| **P0-H** | `AgentRuntime.run()` 入口**无 pre-flight 检查**；上一轮累积到 95% 的 context 可以直接进入下一次 LLM 调用 | `run-agent.ts:302-442`（run 入口无 budget 检查） | 结合 P0-F：大量 turn 在 context 超标的情况下发 LLM，要么被 provider 拒绝要么勉强回答 |
| **P0-L** | `engine.onTurnComplete` 跑完 strategies 后 budget 仍 `critical` 时**不硬挡**，只返回"尽力了"的 messages | `engine.ts:113-189` | critical 被当成 compact 同级处理，硬挡机制形同虚设 |
| **P0-O** | compact **只在 agent-loop 内部的 state.messages 上生效**；`RunResult.newMessages` 由事件流重建，回传 REPL 的是**未压缩**的完整流；REPL state.messages 和 transcript.jsonl 也从未存压缩版 | `run-agent.ts:307, 440, 424-432` + `repl.ts:1190` | compact 跨 run 不累计——每次新 run 从完整历史重来；transcript.jsonl 本就"不存压缩版"，M1-M4 的原子截断等于凭空丢数据 |

**方案**（骨架 1 双环触发 + 骨架 3 单一事实源；详见 §0.7）：
- **P0-F**：`agent-loop.ts:119` "无 tool_calls → return" 前补调 `contextManager.onTurnComplete({messages: [...state.messages, llmResult.message], turnCount: state.turnCount + 1})`。**目的是让 engine fire compact_end 事件**，run-agent.ts 闭包订阅捕获；agent-loop 本身无需改 return 结构（compact 的 canonical 由 commitTurn 隐式收敛，§0.7.3）。`state.turnCount` 语义不改（L2 决策）
- **P0-H**：`AgentRuntime.run` 调 `runAgentLoop` 前跑一次 `onTurnComplete(messages, 0)`；若 fire compact_end，订阅写入闭包 `lastCompact`；run 结束时塞进 `RunResult.compactBefore`
- **P0-L**：engine 跑完 strategies budget 仍 critical → force-apply `LLMSummarizeStrategy`（忽略 triggerRatio / messages 数门槛，circuit breaker 仍生效）；仍失败返回 `ContextManagerOutput { failed: true }`，agent-loop 见 failed yield `agent:context_exhausted` 事件并 `return { reason: "error" }`
- **P0-O**：不独立存 postRunMessages 字段。`RunResult` 带 `{ turn, compactBefore? }`（§0.7.2），**canonical 由 `store.commitTurn` 返回**（§0.7.1 单向数据流）。REPL: `state.messages = await commitTurn(...)`；session-adapter: 外层 `session.runtime.updateMessages(canonical)` 回喂（§0.7.5）

**跨 compact 累积**（L1，修 N11）：一个 run 内可能触发 compact 多次（上述 4 个触发点叠加）。run-agent.ts 闭包订阅 `context:compact_end` 多次 fire 时**累积式记录**——`turnsCompacted` 累加（反映累积替代的原始文件 Turn 总数），`summary` 取最后一次（最新摘要已通过递归压缩包含所有历史），`tokensBefore` 锚定第一次（起点），`tokensAfter` 取最后一次（终点）。完整算法见 §0.7.3。

#### 功能/质量级

| # | 问题 | 位置 | 若不修的后果 |
|---|------|------|-----|
| P0-A | `LLMSummarizeStrategy` 未注册到生产 strategies 列表 | `run-agent.ts:248-252` | 没有任何策略产出可读摘要 |
| P0-B | transcript compact marker 的 `summary` 硬编码 `"(auto-compacted)"` | `run-agent.ts:355-360` | 跨会话语义失真 |
| P0-C | `createContextEngine` 生产调用全都不传 `profile` 参数 | `run-agent.ts:276, 286, 290, 320` | WindowManager + TierCompressor + Pin 淘汰是死代码 |
| P0-D | 多策略串联 `fire compact_end`，REPL 覆盖式接收 | engine.ts:148-185 + run-agent.ts:351-362 | `turnsCompacted` 等元数据被最后一个 strategy 覆盖 |
| P0-E | `turnsCompacted` 字段硬编码为 0 | run-agent.ts:357 | CompactMarker 元数据失真 |

**方案**（骨架 2 事务化事件 + 骨架 6 配置安全网）：
- **P0-A**：`run-agent.ts:248` append `createLLMSummarizeStrategy({callLLM: flushCallLLM, estimator, triggerRatio: 0.9, preserveRecentTurns: 4})`。严格依赖 Phase 1 的 P0-T + Phase 2 的 P0-W
- **P0-B**：订阅方改读 `event.summary`（骨架 2 payload 字段），fallback `"(auto)"`；硬编码字符串仅作最后兜底
- **P0-C**：`createContextEngine` 签名内部默认 `profile ?? INTERACTIVE_PROFILE`；调用方无需改动即自动激活 WindowManager + Tier 压缩。注意 P0-AA：激活后 ToolResultTrim 可能退化为 no-op（骨架 4 契约层面重新定位）
- **P0-D**：骨架 2 核心——engine 改为事务模式：循环内累积各 strategy 贡献到 `CompactTransaction`，循环结束 fire **唯一** `context:compact_end { strategies: [{name, success, tokensSaved, summary?, turnsCompacted?}], summary, turnsCompacted, tokensBefore, tokensAfter }`；当前 compact_start 保留（标记事务开始）
- **P0-E**（修 N2 + N4）：`LLMSummarizeStrategy.apply` 构造 `CompactionResult` 时**精确计算 turnsCompacted** —— 语义为"本次压缩替代掉的文件 Turn 数"（而非消息对数）。算法：
  1. 用 `splitMessagesPairAware(messages, preserveRecentTurns * 2)` 得到 `{toSummarize, toPreserve}`——pair-aware 调整后切分点可能不等于 `preserveRecentTurns * 2`
  2. 调用 helper `stripSummaryPlaceholderPair(toSummarize)` 去掉开头可能存在的 `[对话已压缩] / 已了解` placeholder 对（归一化后文件至多 1 个 compact，placeholder 也只会出现在 toSummarize 开头 0 或 2 条）
  3. 对剩余 `turnMessages` 调 `calculateMessageTurns(...)`，取 `turns[turns.length - 1]` 作为本次压缩的文件 Turn 数
  4. 塞进 `CompactionResult.turnsCompacted`
  
  核心：commitTurn 按此值切分文件 turns（N1）；其他策略（ToolResultTrim / MessageDrop）填 `undefined` 表示"非摘要型压缩，不影响 turnsCompacted"。

  helper 独立 export 便于单测：
  ```ts
  // @zhixing/core
  export function stripSummaryPlaceholderPair(messages: readonly Message[]): Message[];
  ```

#### 功能悬空（相关但不阻塞）

| # | 问题 | 位置 | 备注 |
|---|------|------|-----|
| P0-J | `engine.addTurnDigest` 生产无人调用；TurnDigest 面包屑（作 Layer 3 system prompt 注入）从未启用 | engine.ts:197, layer-assembler.ts:164 | 不影响 compact，但属于"设计了但未接线"同类 |
| P0-P | 注册 LLMSummarize 后 canApply 要求 `messages.length >= 6`，但 MessageDrop 前置可能把消息压到 4 以下 | llm-summarize.ts:82-88 | M0.1 注册时调整策略顺序：LLMSummarize 应先于 MessageDrop 或两者 canApply 互斥 |

**方案**（骨架 5 跨 run 状态容器 + 骨架 4 策略链契约化）：
- **P0-J**：扩展 `ContextManagerHook` 新增 `recordTurn?(digest: TurnDigest): void`；agent-loop 每个 turn 完成（含 pure-text）后调用。digestHistory 存储位置见 P0-BB（上移到 AgentRuntime 跨 run 共享）
- **P0-P**：`MessageDrop.canApply` 加 `&& budget.usageRatio < 0.9` 前置（把 9x% 场景让给 LLMSummarize），LLMSummarize 自身 canApply 不动

#### 第 4 轮审计新发现（2026-04-23）

| # | 问题 | 位置 | 严重程度 / 影响 |
|---|------|------|-----|
| **P0-T** | **LLMSummarize.splitMessages 按消息数硬切（`messages.slice(-preserveCount)`），不保证 tool_use/tool_result 配对完整**；切分点劈开 assistant(tool_use) / user(tool_result) → 下次 LLM 调用 API 报 `tool_use without matching tool_result` | llm-summarize.ts:140-155 | ❌❌ 注册 LLMSummarize（M0.1）后**立即暴露**，生产 crash 风险 |
| **P0-U** | `provider.models.find(m => m.id === model) ?? provider.models[0]`；找不到时 modelInfo=undefined → modelBudgetInfo=undefined → contextEngine=undefined → agent-loop 收到 undefined contextManager → **compact 静默完全禁用**，无任何日志 | run-agent.ts:233, 253-255, 319-321 | ❌ 用非 anthropic/openai-compatible 的 provider 或拼错 model 名时 compact 悄无声息关闭 |
| **P0-W** | context 策略内部的 LLM 调用（MemoryFlush / LLMSummarize）**不透传 abortSignal**；session.abort 或用户 /abort 期间 compact 会继续跑完 | flush-engine.ts:142-169, llm-summarize.ts:160-198 | ⚠️ session 可能被 hang 几秒；daemon 模式下更严重（grace timer 失效） |
| P0-Q | 手动 `/compact` 命令的 summary 硬编码 `"(manual compact)"` | repl.ts:535 | 和 P0-B 同类；用户主动压缩期望真摘要，得到占位符 |
| P0-R | MemoryFlushStrategy.canApply 只看 `messages.length >= 6`，不看 budget；每次 compact 触发就 **附带一次 LLM 调用**（对话 ≥6 条） | flush-engine.ts:114-116 | 成本放大；部分被 engine break 机制保护（ToolResultTrim 压回 warning 就 break，但 MemoryFlush priority=3 排第二会先执行）。重新看 engine 逻辑：strategies sort asc，ToolResultTrim(0)→MemoryFlush(3)→MessageDrop(5)。ToolResultTrim 压回 warning 就 break，MemoryFlush 不执行 ✓ 部分风险自然兜底 |
| P0-S | MemoryFlush 的 LLM 调用自己会发**全量 messages + 提取 prompt**，在 compact 触发场景（usage ≥ 85%）下**自己大概率超 token limit** 失败；try-catch 内吞 | flush-engine.ts:142-144, 201-210 | ⚠️ 常规无害（静默失败），但每次 compact 都白烧 1 次 API |
| P0-X | MessageDrop / WindowManager eviction 插入占位符是 **user 角色消息**（`"[前 X 轮对话已省略...]"`）；LLM 看到"用户的话"可能困惑 | message-drop.ts:79, window-manager.ts:196-199 | ⚠️ 应该用 system message 或包在 `<meta>` 标签里；对答复质量有微小影响 |
| P0-Y | `context:budget_check` 事件在 compact 执行**前** fire（engine.ts:136-141 在 strategies 循环之前）；反映"准备进入 compact"的状态而非"compact 结果" | engine.ts:136-141 vs 148-189 | ⚠️ 对 REPL 渲染无影响（渲染用它判断是否展示预警）；对未来指标订阅可能误导；建议在 strategies 执行完 fire 第二次反映结果 |
| P0-Z | MessageDrop 切分后出现**两条连续 user 消息**（firstMessage 保留 + placeholder 插入 + recentMessages 可能以 tool_result 开头）；Anthropic API 虽允许连续同 role 但非最佳实践 | message-drop.ts:79-83 | ⚠️ 非硬错误，但可能导致 LLM 把 placeholder 当用户新请求 |
| P0-AA | Tier 压缩（激活 profile 后）与 ToolResultTrim 策略**功能重叠**（都裁 tool_result）；Tier 预防性跑完后 ToolResultTrim 的 canApply 大概率返回 false（已经都被裁过），从兜底退化成 no-op | engine.ts:118-131 vs tool-result-trim.ts:126-148 | ⚠️ 激活 M0.5 后需要重新评估 ToolResultTrim 的定位——要么调 staleTurnThreshold，要么和 Tier 合并 |
| P0-BB | ContextEngine 每次 run 新建（`run-agent.ts:319-321`），**`digestHistory` 跨 run 不持久**（engine 内部字段，重建就空）；即便 M0.8 接线 addTurnDigest，跨 run 也没法累积 | engine.ts:67, 197 + run-agent.ts:319 | ⚠️ TurnDigest 设计要求跨 run 累积才有意义（作为"面包屑"）；engine 生命周期设计和功能需求错位 |

**方案**（骨架 4 策略链契约化 + 骨架 6 配置安全网 + 骨架 5 跨 run 容器）：
- **P0-T**（硬阻塞）：core 新增共享 helper `splitMessagesPairAware(messages, preserveCount): {toSummarize, toPreserve}`——按消息数定初始切分点 → 若前段最后一条 assistant 含 `tool_use` 块，切分点向后推到下一个 "assistant 边界之前"（保证整 turn 在一侧）。`LLMSummarizeStrategy.splitMessages` 和 `MessageDrop.findKeepBoundary` 统一走这个 helper。加 fixture 测试覆盖 tool_use/tool_result 对
- **P0-U**：`run-agent.ts:253` modelInfo 缺失时：(a) `console.warn` 明示并给出建议；(b) 降级到保守默认 `{contextWindow: 32_000, maxOutputTokens: 4_000}` 继续启用 compact（宁错估不消失）；(c) `ZhixingConfig.providers.<id>.modelOverrides` 允许用户覆盖适配器硬编码
- **P0-W**：`CompactionContext` 扩展 `abortSignal?: AbortSignal`；`ContextManagerHook.onTurnComplete` 签名加 opts；agent-loop 调用时透传 `params.abortSignal`。`FlushLLMFn` 签名统一为 `(msgs, opts?: {abortSignal}) => Promise<string>`；实现内部传给 `provider.chat`。这是骨架 4 契约的一部分（所有 LLM 调用必接 abort）
- **P0-Q**：`forceCompact` 返回值扩展 `compactBefore?: CompactMarker`（§4.7）；REPL 手动 /compact 分支改为 `state.messages = await store.commitTurn(id, { compactBefore: result.compactBefore })`（走统一入口，内部按 turnsCompacted 保留末尾 turns），summary 由 CompactMarker 自带（不再硬编码）
- **P0-R**：`MemoryFlushStrategy.canApply` 加 `budget.usageRatio >= 0.75` 前置
- **P0-S**：`buildExtractionRequest` 对 messages 做 tail 截断（保留第一条 user 作为锚 + 最后 20 条），再拼 prompt；配合 P0-R 成本可控
- **P0-X / P0-Z / N10**（合并）：占位符**统一到结构化 `<system-meta kind="...">` 格式**，覆盖**四处插入点**：

  | kind | 语义 | 使用位置 |
  |------|------|---------|
  | `compact-summary` | LLM 生成的 compact 摘要 | `LLMSummarizeStrategy.buildCompactedMessages` + `TranscriptStore.rebuildCanonicalMessages`（load 路径） |
  | `ack` | 紧跟 compact-summary 的 assistant 回执 | 同上 |
  | `dropped-turns` | 非摘要型"省略 X 轮"占位 | `MessageDrop.apply` + `WindowManager.evictOldestTurns` |

  统一格式：
  ```ts
  // compact-summary + ack pair（摘要路径）
  {role: "user",      content: [{type: "text", text: `<system-meta kind="compact-summary">${summary}</system-meta>`}]}
  {role: "assistant", content: [{type: "text", text: `<system-meta kind="ack">已阅读摘要</system-meta>`}]}

  // dropped-turns（丢弃路径，不是摘要）
  {role: "user", content: [{type: "text", text: `<system-meta kind="dropped-turns" count="${N}">前 ${N} 轮对话已省略</system-meta>`}]}
  ```

  **`stripSummaryPlaceholderPair` 按 kind 识别**（N10）：只识别 `compact-summary + ack` pair，**不剥 `dropped-turns`**——后者是独立的驱逐标记，不代表"文件 Turn"，不应跳过它影响 turnsCompacted 计算。

  ```ts
  export function stripSummaryPlaceholderPair(messages: readonly Message[]): Message[] {
    if (messages.length < 2) return messages;
    const firstText = extractFirstText(messages[0]);
    const secondText = extractFirstText(messages[1]);
    if (
      messages[0].role === "user" &&
      messages[1].role === "assistant" &&
      /<system-meta kind="compact-summary">/.test(firstText) &&
      /<system-meta kind="ack">/.test(secondText)
    ) {
      return messages.slice(2);
    }
    return messages;
  }
  ```

  **system prompt 扩展**：在 `@zhixing/core/context/layer-assembler.ts` 的 Layer 1/2 加一段告知 LLM：`<system-meta>` 标签内是系统元信息（compact 摘要 / 省略标记 / 元数据），不是用户原话，不需要回应；按 `kind` 字段理解含义。

  P0-Z 的"连续 user"由 P0-T 的 pair-aware 切分保证 recentMessages[0] 是 assistant（整 turn 在 preserve 侧），自然避免
- **P0-Y**：engine 在 strategies 循环**后**补发一次 `context:budget_check { phase: "post-compact", ... }`；原位置的 fire 改为 `phase: "pre-compact"`。订阅方按需过滤（REPL 渲染可仍只看 pre）
- **P0-AA**：M0.5 激活 Tier 后保留 ToolResultTrim 作"非 Tier 窗口的兜底"；短期不删，实测观察 canApply 频率，若长期未命中再合并到 Tier。**不加 `preservesToolPairing` 字段**（§0.7.6 简化）——pairing 由共享 helper `splitMessagesPairAware`（P0-T）统一保证，测试里加 `assertToolPairingIntact` 断言即可
- **P0-BB**（修 A6）：把 `digestHistory: TurnDigest[]` 从 `ContextEngine` 迁到 `AgentRuntime` 层（和 estimator 同层），engine 构造时作为依赖注入。具体接口：

  ```ts
  // core/src/context/engine.ts
  interface ContextEngineConfig {
    modelInfo: ModelBudgetInfo;
    thresholds?: BudgetThresholds;
    profile?: ContextProfile;
    digestHistory?: TurnDigest[];   // ★ 新增：外部注入的 reference；未传时 engine 内部 new [] 兼容旧行为
  }

  // engine 内部
  class ContextEngine {
    private readonly digestHistory: TurnDigest[];
    constructor(estimator, strategies, config, eventBus?) {
      this.digestHistory = config.digestHistory ?? [];  // 注入的引用 or 内部默认
      // ...
    }
    addTurnDigest(d) { this.digestHistory.push(d); }    // push 到注入引用（跨 run 持久）
    getTurnDigests() { return this.digestHistory; }
  }
  ```

  **AgentRuntime 层持有 `digestHistory: TurnDigest[]`**（和 `estimator` 同层 closure 变量），每次 `run()` 创建 engine 时传入引用。engine 每 push 一条都直接更新外层数组，跨 run 自动持久。

  **CircuitBreaker 不需要迁**——它在 `LLMSummarizeStrategy` 构造时 `new`，而 strategy 实例在 `createAgentRuntime` 工厂外层（run-agent.ts:248）创建，已经跨 run 共享。

  与 P0-J 的 `ContextManagerHook.recordTurn(digest)` 接线一起实施——agent-loop 每个 turn 完成调 `contextManager.recordTurn(digest)` → engine 转 `addTurnDigest(digest)` → push 到 AgentRuntime 持有的数组。

#### 轻微

| # | 问题 | 位置 | 备注 |
|---|------|------|-----|
| P1-a | `CompactionResult.tokensBefore/After` 在 ToolResultTrim / MessageDrop 写死 0 | tool-result-trim.ts:166-167 + message-drop.ts:87-88 | engine fire 事件时会重算，外部可见数据仍对 |
| P1-b | estimator.calibrate 用 `allMessages` 而非实际送 LLM 的 `messagesWithTurnContext`（多注入 context / 技能 / time） | run-agent.ts:414-420 | 估算会系统性偏低，校准因子会补偿；自适应能收敛但不精确 |
| P2 | WindowManager 占位消息提 `recall_history` 工具（实现未确认） | window-manager.ts:198 | 激活 WindowManager 后（P0-C 修复）才暴露 |

**方案**（清洁度，不阻塞主线，任意时间可插入）：
- **P1-a**：两处 `apply` 构造 result 时填 `tokensBefore = estimator.estimateMessages(messages)`、`tokensAfter = estimator.estimateMessages(newMessages)`（注入 estimator 即可）
- **P1-b**：`run-agent.ts:418` 改用实际送 LLM 的 `messagesWithTurnContext`（enrichedContext + turnContext 注入后的版本）作为 estimate base；不改则接受校准因子自适应收敛（当前策略）
- **P2**：`window-manager.ts:198` 占位文案统一为 P0-X 的 `<system-meta>` 格式；不提 `recall_history`

### 0.3 阶段 → 问题索引

> 各问题的**缩略方案已写在 §0.2 表格下方**；本节只给阶段聚合，避免重复。

| Phase | 覆盖问题 | 骨架 | 聚合目标 | 估时 |
|-------|---------|------|---------|------|
| Phase 1 | P0-U · P0-C · P0-T | 6+1+4 | 安全网 + 激活 + 配对保护（注册前提） | ~3h |
| Phase 2 | P0-W · P0-A · P0-P · P0-R · P0-S · P0-X/Z | 4 | 策略链契约化（统一签名 + 注册 LLMSummarize） | ~3.5h |
| Phase 3 | P0-E · P0-D · P0-B · P0-Q · P0-Y | 2 | 事务化事件（唯一 compact_end payload） | ~2h |
| Phase 4 | P0-F · P0-H · P0-L | 1 | 双环触发（pre-flight + pure-text + critical 硬挡） | ~2.5h |
| Phase 5 | P0-O · P0-BB · P0-J + M1-M4 | 3+5 | 单一事实源 + 跨 run 容器 + 原子截断 | ~5h |
| 清洁度 | P0-AA · P1-a · P1-b · P2 | - | 任意时间插入 | ~1h |

**总工作量**：~17h（原 ~19h，架构骨架统一后合并节省 ~2h）

**M0 里程碑粒度拆分见 §0.5**（每个 Phase 可再细分 M0.x 交付单元）。

### 0.4 M0.1 的成本权衡

`LLMSummarizeStrategy` 是 `requiresLLM=true` 的付费策略：`triggerRatio: 0.9` 意味着只在 **usage 到 90%** 时才启动（在激活 WindowManager 后实际阈值是 effectiveWindow × 0.9，接近 critical 线）。

**行为：**
- 正常情况：Tier 压缩 + MessageDrop 已能把 usage 压回 normal → 不触发 LLMSummarize → 无成本
- 极端情况：前两者压不下去 → LLMSummarize 生成一次摘要（~1 次 LLM 调用，小 prompt）→ 上下文回到 50% 以下

**摘要 LLM 选择**：复用现有 `flushCallLLM`（和 memory flush 同一路径）——避免再开新的 provider 通道。成本、能力都够用（memory flush 已在用它提取结构化数据）。

### 0.5 M0 里程碑（按 Phase 展开）

按 §0.0 的 5 阶段视图拆为交付单元。每个 PID 的具体修复方案见 §0.2 表格下的"方案"段。

**Phase 1 — 安全网与激活（~3h · 独立可并行）**
- **P0-U**：`run-agent.ts:253` modelInfo 缺失 warn + 降级到 `{32K, 4K}` + 加 `modelOverrides` 配置 · 1h
- **P0-C**：`createContextEngine` 内部默认注入 `INTERACTIVE_PROFILE`；跑现有上下文测试防回归 · 0.5h
- **P0-T**：core 新增共享 helper `splitMessagesPairAware` + tool_use/tool_result fixture 测试 · 1.5h

**Phase 2 — 策略链契约化（~3.5h · 依赖 P0-T）**
- **P0-W**：`CompactionContext.abortSignal` + `FlushLLMFn(msgs, {abortSignal})` 统一签名 · 1h
- **P0-A**：`run-agent.ts:248` append `createLLMSummarizeStrategy(...)` · 0.3h
- **P0-P**：`MessageDrop.canApply` 加 `usageRatio < 0.9` 前置 · 0.2h
- **P0-R / P0-S**：`MemoryFlushStrategy.canApply` 加 `usageRatio >= 0.75` + `buildExtractionRequest` tail-20 截断 · 0.5h
- **P0-X / P0-Z / P2**：占位符统一 `<system-meta>` 包装（含 WindowManager 的 recall_history 文案同步清理） · 0.5h
- **P0-AA**：ToolResultTrim 保留 + `preservesToolPairing: true` 标记 · 0.1h

**Phase 3 — 事务化事件（~2h · 依赖 Phase 2）**
- **P0-E**：`CompactionResult` 扩展 `summary?: string` + `turnsCompacted?: number` · 0.3h
- **P0-D**：engine 改事务模式，循环累积 `CompactTransaction`，fire **唯一** `context:compact_end { strategies, summary, turnsCompacted, tokensBefore, tokensAfter }` · 1h
- **P0-B**：`run-agent.ts:355-360` 订阅改读 `event.summary`，硬编码降为兜底 · 0.3h
- **P0-Q**：`repl.ts:535` 读 `forceCompact` 返回的真 summary · 0.1h
- **P0-Y**：strategies 执行后补发 `context:budget_check { phase: "post-compact" }`；原位改 `phase: "pre-compact"` · 0.3h

**Phase 4 — 双环触发（~2.5h · 依赖 Phase 3）**
- **P0-F**：`agent-loop.ts:119` "无 tool → return" 前补调 `contextManager.onTurnComplete`；turnCount 语义统一为"每次 LLM 完成 +1" · 0.5h
- **P0-H**：`AgentRuntime.run` 调 `runAgentLoop` 前跑一次 pre-flight `onTurnComplete`；结果作为 `compactBefore` 塞进 RunResult · 1h
- **P0-L**：engine 跑完 budget 仍 critical → force-apply LLMSummarize；仍失败返回 `{failed: true}`，agent-loop yield `agent:context_exhausted` 终止 · 1h

**Phase 5 — 单一事实源（~2.5h 本 Phase + 合入 M1-M4）**
- **P0-O**：`RunResult` 扩展 `postRunMessages: Message[]` + `compactBefore?: CompactMarker`；REPL / session-adapter 改为整体替换 state.messages · 1.5h
- **P0-BB / P0-J**：`digestHistory` + `CircuitBreaker` 从 engine 迁到 `AgentRuntime` 层；扩展 `ContextManagerHook.recordTurn(digest)`，agent-loop 每 turn 调用 · 1h
- **M1-M4**：原 transcript 治理，`commitTurn({turn, compactBefore})` 作为 P0-O 的持久化出口 · ~5h

**清洁度（~1h · 任意时间插入）**
- **P1-a**：ToolResultTrim / MessageDrop 构造 CompactionResult 时填真实 tokens · 0.3h
- **P1-b**：estimator.calibrate 改用 `messagesWithTurnContext`（或保持现状让校准自适应） · 0.3h

**总估时**：Phase 1-5 约 13.5h + M1-M4 约 5h + 清洁 1h = **~19.5h**

**关键顺序约束**：
- Phase 1 → 2 严格（P0-T 未修就注册 P0-A = 生产 crash）
- Phase 2 → 3 严格（事务化依赖新字段）
- Phase 3 → 4 松（触发点增加前事件必须已能汇报真值）
- Phase 5 融合 M1-M4（commitTurn 同时修跨 run 持久 + 磁盘原子截断）
- Phase 1 内 3 项、清洁度：可并行无依赖

### 0.7 关键协议对齐（方案收敛到单向数据流）

> 审查第 1-2 版方案时发现 5 类硬冲突 + 7 类留白。根因是 §3–§6（初版，transcript-only 视角）和 §0（新版，compact 系统视角）两套协议并存。本节给出最终协议，§3 / §4 / §6 据此对齐。

#### 0.7.1 单向数据流（单一事实源）

```
┌─ agent-loop yield 流 ──────────────────────────────────────────┐
│                                                                 │
│  onTurnComplete（在 pre-flight / tool 循环尾 / pure-text before │
│   return / critical force-apply 四个触发点都调）                │
│    └→ engine fire 事务化 context:compact_end（Phase 3 P0-D）    │
│                                                                 │
└────────→ run-agent.ts 闭包订阅 compact_end ────────────────────┘
                   │
                   ▼ （闭包维护 lastCompact，多次 fire 取最后一次，L1）
      RunResult { turn, compactBefore?, agentResult, ... }
                   │
                   ▼
      调用方（REPL / session-adapter 经 InboundRouter）
                   │
                   ▼
      store.commitTurn(id, { turn, compactBefore })
                   │
                   ▼ （原子写 + 内部 rebuildCanonicalMessages）
      返回 canonical messages
                   │
                   ▼
      调用方 state.messages = canonical
      （REPL：state.messages；session-adapter：updateMessages(canonical)）
```

所有状态同步经此一条路径。**没有"postRunMessages 独立字段"**——canonical 由 commitTurn 返回值即时产生。

#### 0.7.2 核心类型与接口

**统一到唯一的 compact 类型：`CompactMarker`**（core/src/transcript/types.ts 已有）
- **废弃 `CompactInfo`**（C3）：RunResult 直接带 CompactMarker；run-agent 订阅 compact_end 事件时就组装 CompactMarker。
- CompactMarker.`timestamp` **由 run-agent.ts 订阅方赋值**（`new Date().toISOString()`）。engine 不感知 CompactMarker 类型（那是 transcript 层概念），event payload 不含 timestamp 字段。事务化后 `rebuildCanonicalMessages` 按文件顺序处理，timestamp 仅作元信息不参与排序。

```ts
// core/src/loop/types.ts —— RunResult 统一形态
interface RunResult {
  agentResult: AgentResult;
  turn: Turn;                      // 持久化单元（Turn 构造契约见 §0.7.8）
  compactBefore?: CompactMarker;   // 本 run 最后一次 compact（L1 规则）
  newMessages: Message[];          // 本轮 yield 流重建的增量（保留；非持久化用途，见 §0.7.9）
  // 诊断：usage / budget / durationMs / toolEndCount / injectedSkillIds ...
}

// core/src/runtime/types.ts —— SessionRuntime（server 侧）
interface SessionRuntime {
  run(text, opts?): AsyncGenerator<AgentYield, RunResult>;
  updateMessages(canonical: Message[]): void;   // ★ 新增：调用方喂回 canonical
  getHistory(limit?): Message[];
  abort(): void;
  dispose(): void;
}

// core/src/transcript/types.ts —— TranscriptStore
interface ITranscriptStore {
  init(id, opts): Promise<void>;
  commitTurn(id, { turn, compactBefore? }): Promise<Message[]>;  // ★ 返回 canonical
  appendCompact(id, compact): Promise<Message[]>;                // 手动 /compact；返回 canonical
  load(id): Promise<LoadedTranscript>;
  exists(id): Promise<boolean>;
  countTurns(id): Promise<number>;
  // appendTurn 降级为 legacy，内部转 commitTurn({turn})
}

// cli/src/run-agent.ts —— AgentRuntime.forceCompact 扩展
forceCompact(messages, turnCount): Promise<{
  modified: boolean;
  messages: Message[];
  budget?: ContextBudget;
  compactBefore?: CompactMarker;   // ★ 新增
}>
```

#### 0.7.3 四个 compact 触发点的统一契约

精确列出（修 N5）：

| # | 触发点 | 代码位置 | 谁调 onTurnComplete |
|---|--------|---------|---------------------|
| 1 | Pre-flight（P0-H） | `run-agent.ts` 的 `run()` 入口，调 `runAgentLoop` **之前** | run-agent |
| 2 | Tool 循环尾（原有） | `agent-loop.ts:148-157` | agent-loop |
| 3 | Pure-text before return（P0-F） | `agent-loop.ts:119-125` 的 `return` 前 | agent-loop |
| 4 | Critical force-apply（P0-L） | `engine.ts` `onTurnComplete` 内部，strategies 循环**之后**仍 critical 时 | engine |

**统一机制**：
1. 调用点调 `contextManager.onTurnComplete(...)` —— 返回 modified messages 用于当前 state 更新（仅影响本 run 内 LLM 后续调用）
2. engine 内 fire `context:compact_end`（Phase 3 事务化后保证每次 onTurnComplete 至多 fire 一次）
3. **run-agent.ts 闭包**订阅——无论是 run-agent 自己调的 pre-flight，还是 agent-loop 调的（通过共享 eventBus 传递），还是 engine 内部的 force-apply，**都在同一个闭包里订阅同一个事件**
4. 闭包**累积式**维护 `lastCompact: CompactMarker | undefined`，多次 fire **累加 `turnsCompacted`**（而非覆盖）；run 结束时 `RunResult.compactBefore = lastCompact`

**关键**：四个触发点共享同一个 eventBus——run-agent.ts 创建 eventBus（run-agent.ts:303），传给 runAgentLoop（作为 `params.eventBus`）和 contextEngine（作为构造参数）。engine 内部的 force-apply 也用同一 eventBus。订阅只有一个点。

**L1 累积算法**（修 N11）：

一个 run 内可能触发 compact 多次（pre-flight / tool 循环尾 / pure-text return / critical force-apply）。`compactBefore.turnsCompacted` 的**正确语义是"本 run 内累积被 summary 替代的原始文件 Turn 总数"**——不能取最后一次（会丢失之前压缩的信息）。

```ts
// run-agent.ts 闭包
let lastCompact: CompactMarker | undefined;
let firstTokensBefore: number | undefined;

eventBus.on("context:compact_end", (info) => {
  if (!info.summary) return;  // ★ 仅摘要型压缩参与累积（LLMSummarize fire），
                              //   非摘要型（ToolResultTrim/MessageDrop 的 compact_end）不累积
                              //   —— 它们不产生语义替代，不影响文件 Turn 保留决策
  if (firstTokensBefore === undefined) firstTokensBefore = info.tokensBefore;

  lastCompact = {
    type: "compact",
    timestamp: new Date().toISOString(),                                  // 最后一次时间
    summary: info.summary,                                                // 最后一次摘要（含之前历史）
    turnsCompacted: (lastCompact?.turnsCompacted ?? 0) + (info.turnsCompacted ?? 0),  // ★ 累加
    tokensBefore: firstTokensBefore,                                      // 锚定起点
    tokensAfter: info.tokensAfter,                                        // 终点
  };
});
```

**为什么累加是对的**：第 N 次 compact 的 `toSummarize` 包含第 N-1 次的 summary placeholder pair，经 `stripSummaryPlaceholderPair` 去掉后，剩下的就是"自上次 compact 以来新替代的文件 Turn"。`info.turnsCompacted` 是本次增量，累加得到"自 run 开始累积的总替代数"——commitTurn 据此从文件原始 turns 切分保留末尾，和内存 canonical 对齐。

**agent-loop 不需要改 AgentResult 结构**——messages 改动只影响本 run 内部，跨 run 的 canonical 由 commitTurn + `rebuildCanonicalMessages` 算出（见 §0.7.1）。

**turnCount 语义不改**（L2 决策）：pure-text 分支调 onTurnComplete 时传 `state.turnCount + 1` 作为"本 turn 序号"，但 state.turnCount 本身不变。`agent-loop.maxTurns` / `ToolResultTrim.staleTurnThreshold` 语义保持原样。

#### 0.7.4 Tier 与持久化（L4 决策 → ADR-TR-6）

**决定**：知行采用 "**持久化 Turn = LLM 视角 Turn**" 架构。tier-compressor 预防性裁过的 tool_result 直接成为持久化 Turn 里的 tool_result 内容。

**原因**：
- 用户诉求明确是"别占磁盘"——保留原始 tool 输出反向增长
- 当前没有 audit / 原始回看需求
- 运行时 canonical（commitTurn → rebuildCanonicalMessages 结果）就是最新 state，下次 run 直接用，不需要 re-apply tier

**取舍**：放弃 tool_result 原始数据。如未来需要 audit，再引入 `rawTurn` 双写（不在本次范围）。

#### 0.7.5 session-adapter messages 管理（L6）

session-adapter 保留 `let messages: Message[]` 作为 agent-loop run 入参持有——但**每次 run 结束后由调用方通过 `updateMessages(canonical)` 喂回**：

```ts
// session-adapter.ts
async *run(text, opts?): AsyncGenerator<AgentYield, RunResult> {
  messages.push(userMessage(text));
  const result = await agentRuntime.run({ messages: [...messages], ... });
  // 注意：不在这里 push newMessages——而是由外层 updateMessages 回喂
  return result;  // result.turn / result.compactBefore
},
updateMessages(canonical: Message[]): void {
  messages = [...canonical];
}
```

InboundRouter / REPL loop 顺序：
```
const result = gen.return  // RunResult
const canonical = await conversations.recordTurn(id, result.turn, result.compactBefore);
// recordTurn 内部：commitTurn + 拿到 canonical + 更新 ConversationManager 缓存
session.runtime.updateMessages(canonical);
```

#### 0.7.6 `CompactionStrategy.preservesToolPairing` 字段 —— 不加（L7 简化）

原 P0-AA 方案提议加字段作声明，实际用途只是文档 + 测试断言。

**简化**：不加字段。**用共享 helper `splitMessagesPairAware` 保证正确性**（Phase 1 P0-T），再加一条 test helper `assertToolPairingIntact(messages)` 在集成测试中断言每次 compact 后配对完整。

#### 0.7.7 Windows fs.rename 策略（D2 + A8）

**默认策略**：Windows 平台**默认走 fallback 路径**（两步 unlink+rename + orphan 回收），Linux/macOS 走 simple rename。这是保守取向——Windows 上 rename 的边缘场景（共享驱动器、WSL 跨文件系统、旧版 NTFS）可能破坏原子性假设，statically 不可预见。

**Linux/macOS**：`fs.promises.rename(tmp, file)` 直接走，POSIX `rename(2)` 原子覆盖——**认定为平台承诺**。

**Windows**（默认 fallback）：
1. `fs.promises.writeFile(tmp, content)`
2. 若 `file` 存在 → `fs.promises.unlink(file)`
3. `fs.promises.rename(tmp, file)`
4. 启动期（TranscriptStore 构造或 conversation load 时）扫目录 `.tmp` 后缀文件，清理 orphan（来自中途 crash 的残留）

**可选简单 rename 优化**：M1 起手可写一个 20 行 smoke test 在 CI 验证 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` 覆盖成功——成功则生产可通过配置 `transcript.windowsSimpleRename: true` 切到 simple rename 以省去 unlink 调用。默认关闭。smoke test 仅验证"覆盖成功"，原子性不可观测但平台文档承诺。

#### 0.7.8 Turn 构造契约（修 H3）

**责任归属**：`Turn` 由 `run-agent.ts` 在 `run()` 结束前构造，挂到 `RunResult.turn`。**不在调用方（REPL / session-adapter）构造**——避免两处散落且不一致。

**数据源**：

| 字段 | 取值 |
|------|------|
| `turnIndex` | 由 `RunParams.turnIndex` 传入（REPL 从 `state.turnCounter`；server 从 `ConversationManager.session.turnCount`） |
| `timestamp` | `new Date().toISOString()` at run 结束时 |
| `userMessage` | `params.messages[params.messages.length - 1]`（原始未注入版本——`enrichContext / turnContextInjector` 的注入只进内部 `messagesWithContext`，不进 `params.messages`） |
| `assistantMessage` | `newMessages` 里**最后一条** `role === "assistant"` 的消息——pure-text turn 即为 LLM 文本回复；tool-loop turn 为工具链结束后的总结 assistant。若无（异常/abort）塞一条空 assistant 作兜底 |
| `toolCalls` | 扫 `newMessages` 提取所有 `tool_use` block 的 `{name, input}` + 对应 `tool_result` 的 `{result, isError}`，按发生顺序组成 `ToolCallRecord[]` |
| `usage` | `agentResult.usage` 最终汇总 |
| `source` | `RunParams.source ?? "interactive"`（interactive / channel / scheduler） |

**附带修正已存在 Bug**：REPL 当前 `repl.ts:1222` 取 `newMessages[0]` 作 assistantMessage——tool 循环下这是第一条（可能是发 tool_use 的中间消息），**不是最终回复**。新契约取最后一条 assistant 解决这个独立 bug。

**helper**：在 `@zhixing/core` 暴露 `buildTurn(params, newMessages, agentResult): Turn`，单元测试覆盖 pure-text / tool-loop / abort 三种场景。

#### 0.7.9 newMessages 与 canonical 的正交（修 H1）

`RunResult.newMessages` **保留**，不废弃（上版误删）。它和 `canonical`（commitTurn 产出）是正交关系：

- **newMessages**（增量）：本轮 yield 流重建的原始消息序列；用于**非持久化**场景——技能提议检测（扫 assistant 文本关键字）、技能效果推断、非 REPL 单次运行的输出显示、诊断日志、ephemeral 路径重建 canonical 的输入
- **canonical**（全量）：`commitTurn(...)` 返回的当前 state 视图；包含压缩效果；用于**状态同步**——REPL 的 `state.messages`、session-adapter 的 `messages` 字段

两者互不可替代：canonical 是全量累积（含压缩），无法满足"本轮发生了什么"的 diff 需求；newMessages 只含增量，不含压缩效果。

---

### 0.6 M0 验收

**架构级**：
- **纯聊天 E2E**：跑 30+ 轮 pure-text 对话（无工具调用）直到 usage > 80%，观察 compact 被触发（P0-F 修复验证）
- **跨 run 压缩 E2E**：触发 compact 后关闭 REPL、重开，state.messages 已是压缩版而非完整流（P0-O 修复验证）
- **pre-flight E2E**：手工造一个 95% usage 的 transcript，重开 REPL，第一次发消息前 compact 先跑（P0-H 修复验证）
- **critical 硬挡**：手工造一个连 LLMSummarize 都压不下去的场景，agent-loop 能 yield 错误事件而不硬送 LLM（P0-L）

**内容质量**：
- compact marker `summary` 字段是 LLM 生成的真实摘要（非 `"(auto-compacted)"`）
- 关闭 REPL 重开后 LLM 能从 summary 里复述之前讨论的关键信息
- `turnsCompacted` 字段准确反映被摘要替代的轮数
- compact_end 事件每轮 compact 最多 fire 一次

**激活**：
- WindowManager 激活后 cli 现有上下文测试全绿
- 在真实对话里观察到 Tier 压缩触发（tool_result trim 到 2000 / 500 字符）

**M0 完成后才进 M1**——此时 compact 在三个维度都有真实语义（触发、内容、跨 run 持久），把磁盘清理挂到它身上才安全。

---

## 1. 问题全局定位

用户初始诉求是 "transcript.jsonl 无限增长"。深挖现状后发现这是**同一件事的三个面**：

### 1.1 显性问题：compact 前的 turns 永不清理（用户感知）

`TranscriptStore.appendCompact` (`packages/core/src/transcript/store.ts:76-83`) 只做 `appendRecord`，从不截断。
`rebuildMessages` (store.ts:131-156) 按 `timestamp > lastCompact.timestamp` 过滤，运行时只用最后一次 compact 之后的 turns——但磁盘上一切 turns 永远保留。

长跑后 transcript.jsonl 单调膨胀；daemon 常驻场景下尤其明显。

### 1.2 隐蔽 Bug A：server 路径**从不写 compact marker**

- REPL 路径：`repl.ts:1255-1264` 在 `agentResult.run()` 返回的 `compactInfo` 非空时显式调用 `appendCompact`。
- server 路径：`session-adapter.ts` (`packages/cli/src/serve/session-adapter.ts`) 把 `agentRuntime.run()` 的 `RunResult` 中**只透传 `agentResult`**，`compactInfo` 被丢弃。`InboundRouter` → `ConversationManager.recordTurn` 也只调 `persistTurn`，无 `persistCompact`。

**后果**：server / daemon 模式下，LLM 上下文到达阈值时内存中的 compact 仍会发生，但**持久化层完全无感知**。下次 grace / idle release 后重新 `loadHistory`，会把全量 turns 塞回 LLM——compact 等于白做，上下文会立刻再次爆掉。

### 1.3 隐蔽 Bug B：REPL 的 compact marker 时间戳晚于当轮 turn → 丢 turn

`rebuildMessages` 按 `timestamp` 严格大于 `lastCompact.timestamp` 筛 turn。
但 REPL 里：

```
turn.timestamp   = new Date().toISOString()  at repl.ts:1227 (turn build 时)
appendTurn(turn) at repl.ts:1237
compact.timestamp = new Date().toISOString() at repl.ts:1258 (compact build 时)
appendCompact(compact) at repl.ts:1264
```

`compact.timestamp > turn.timestamp` 恒成立（后生成），所以**当轮 turn 被后续 load 时过滤掉**——每次触发自动 compact 就丢一轮。

compact 在 AgentRuntime 内部发生于本 turn LLM 调用**之前**（`engine.ts:155-185`，compact 完成后才跑 strategy→llm），所以本 turn 语义上是 post-compact，应被保留。当前实现是反的。

---

## 2. 设计原则

1. **Compact 是截断点，不是标记**：marker 落盘即"之前内容物理死亡"。一个 transcript 文件任意时刻**至多包含 1 个 compact marker**。
2. **单一持久化入口**：compact 和 turn 必须经同一原子操作写入，不允许调用方分两次调用再自己保证顺序（REPL 当前那种 `appendTurn + appendCompact` 容易出 1.3 这种顺序 bug）。
3. **REPL 与 server 走同一条路**：compact 持久化不能是 REPL 的"额外步骤"——应由 `TranscriptStore` 提供的原子操作承担，任意持久化路径接入即正确。
4. **向后兼容**：线上已有 transcript.jsonl 可能含多 compact + 历史 turns，首次 load 时 lazy 归一化，不搞一次性 migration 脚本。
5. **崩溃安全**：截断操作基于 `write-tmp + rename` 原子语义；crash 在任何中间点可恢复。

---

## 3. 架构决策（ADR 风格）

### ADR-TR-1：Compact 即截断

**决定**：`TranscriptStore` 的 compact 写入**立即物理丢弃 marker 之前的所有 turns**。

**原因**：compact 之前的 turns 在运行时已是死数据（`rebuildCanonicalMessages` 不用）；保留它们只增加磁盘、load 时间、解析成本，不带来任何价值。

**后果**：
- `rebuildCanonicalMessages` 大幅简化：文件里最多 1 个 compact，紧跟 header，之后全是 turns。不再需要 `turns.filter(timestamp > lastCompact.timestamp)`。
- `countTurns` 语义变化：从"文件总 turn 行数"变成"active 段 turn 数"（= compact 之后的 turns 数）。具体调用方：
  - `repl.ts:756, 790, 795` 作 `turnCounter` 初始化——新语义下就是"本段已完成 turn 数"，正好是下一个 turnIndex 的基准，**REPL 行为不变**
  - `packages/core/src/transcript/__tests__/store.test.ts` 相关断言：需要更新期望值为归一化后语义
  - 旧文件在归一化前读到的 countTurns 可能含前史（多 compact 场景）；归一化触发后即准确
- 旧文件（多 compact / 有前史 turns）首次 load 被归一化后也符合新不变量。

**拒绝的备选**：按文件大小阈值触发轮转 / 时间窗口轮转——需要在无 compact 时现场生成摘要（= 注入一次 LLM 调用，有成本且不确定），且和 "compact 作为上下文语义边界" 的角色重复。

### ADR-TR-2：Compact + Turn 原子事务

**决定**：引入 `TranscriptStore.commitTurn(conversationId, { turn, compactBefore? })` 作为**唯一 turn 持久化入口**，替代现有 `appendTurn` + `appendCompact` 两段式调用。

`compactBefore` 的语义是"本 turn 之前 LLM 上下文被压缩了，compactBefore 代表压缩边界"。内部实现：
- 无 `compactBefore` → 等价于 `appendRecord(turn)`
- 有 `compactBefore` → 原子重写：`header + compactBefore + turn`（一次性落盘）

**原因**：
- 杜绝 1.3 类顺序 bug：compact 永远在"跟它同事务的 turn"之前，不会被 timestamp 误排
- 语义精确：compact 是 turn 的前置元数据，不是独立事件
- 减少调用方心智：REPL / server 接入方都只调一个方法

**保留的遗留 API**：`appendCompact` 保留为"手动 /compact 命令"专用（无 turn 关联的纯压缩），内部走原子重写：`header + compact`。`appendTurn` 保留但在实现中仍建议走 `commitTurn({ turn })` 以统一路径。

### ADR-TR-3：RunResult 携带 turn + compactBefore（对齐 §0.7.2）

**决定**：扩展 `SessionRuntime.run()` 和 `AgentRuntime.run()` 的 return 值为统一的 `RunResult`：

```ts
interface RunResult {
  agentResult: AgentResult;
  turn: Turn;                      // 本轮 user+assistant 事件（原始）
  compactBefore?: CompactMarker;   // 本 run 期间最后一次 compact 的 marker
  // 其他诊断字段：usage / budget / durationMs / ...
}

// SessionRuntime.run 的 AsyncGenerator return 类型
run(text, opts?): AsyncGenerator<AgentYield, RunResult>
```

**原因**：
- compact 是"turn 的前置元数据"，不是独立事件流
- 回收 session-adapter 当前丢弃 compactInfo 的 bug
- 调用方在 turn 完成分支一次性拿到 turn + compactBefore，直接调 `commitTurn` 持久化并获得 canonical messages

**和 §0.7 的对齐**：
- **废弃 `CompactInfo` / `TurnCompletion` 中间类型**（C3）——直接使用 core 已有的 `CompactMarker`
- **不依赖 `compactedAt` 字段**（C2）——CompactMarker.timestamp 由 engine 在 fire compact_end 时赋值；transcript 不再按 timestamp 过滤（见 §5），1.3 的时间戳 bug 由原子事务（ADR-TR-2）消除
- **多次 compact 规则（L1）**：run-agent.ts 闭包订阅 compact_end，多次 fire 时**覆盖式记录**，取最后一次作 compactBefore。因为后一次 compact 的 toSummarize 自然包含前一次的 meta-summary，物理上后者完全替代前者

**后果**：`RunTurnOptions` 和 `AgentYield` 类型不变。调用点从 `{agentResult, newMessages, compactInfo}` 改为 `{agentResult, turn, compactBefore}`。新增 `SessionRuntime.updateMessages(canonical)`（见 §0.7.5），取代 session-adapter 自行 `messages.push(...newMessages)`。

### ADR-TR-4：归档策略 = 直接丢弃（但保留开关）

**决定**：默认直丢，compact 之前的 turns 不归档。

**原因**：
- daemon 长跑下归档本身是新的磁盘增长点
- 绝大多数场景不会回看"compact 之前的原始 turns"——有 compact summary 即可
- 用户实际担忧是"文件无限增长"，归档方案没有真正解决

**保留开关**：在 `ZhixingConfig` 加 `transcript.archiveOnCompact?: boolean`（默认 `false`）。开启时裁剪前把旧文件 `rename` 成 `transcript.<ISO-ts>.archive.jsonl`，保留最近 N 份（`archiveKeep?: number`，默认 3）。实现作为 Phase 2，不阻塞主干。

### ADR-TR-5：旧文件 Lazy 迁移

**决定**：首次 `TranscriptStore.load` 读到"非归一化"文件（存在 compact marker 之前有非 header 内容，或存在多于 1 个 compact）时，**load 成功后立即触发一次归一化重写**。

**原因**：
- 无需全局 migration 脚本
- 访问路径上 load 本来就会 read 全文，归一化只多一次 write，成本可控
- 未被 load 的老文件保持原样，不动就不伤

**实现位置**：`TranscriptStore.load` 返回 `LoadedTranscript` 前，如果 `needsNormalize` 则**同步执行一次 normalize 重写**（不是 fire-and-forget）——必须同步，否则 load 返回后调用方马上发起 commitTurn，commitTurn 走 `_loadUnlocked` 又会看到非归一化状态，两者冲突。同步归一化在 per-transcript 锁（ADR-TR-8）内完成，确保下次读/写立即见到归一化格式。

**性能**：只有老文件首次 load 会归一化一次，之后全部快路径。

### ADR-TR-6：持久化 Turn = LLM 视角 Turn（对齐 §0.7.4）

**决定**：tier-compressor 对 tool_result 的预防性裁剪**直接成为持久化 Turn 的一部分**，不保留未裁剪的 raw 版本。

**原因**：
- 用户诉求是"减少磁盘占用"，保留 raw 数据反向
- 没有 audit / 回看原始 tool_result 的功能需求
- 运行时 canonical = commitTurn 后 `rebuildCanonicalMessages` 的结果（已经是裁剪版），下次 run 直接用，不需要二次 re-apply

**后果**：放弃 tool_result 原始数据。如未来需要 audit，引入 `rawTurn` 双写（不在本次范围）。

**N1 retainedTurns 的 tool_result 语义澄清**：commitTurn 保留 `retainedTurns` 时，Turn 内部的 `toolCalls[].result` / `userMessage`（含 tool_result block）/ `assistantMessage`（含 tool_use block）都是**tier-compressor 裁过的版本**（如果激活了 WindowManager）——tier 的预防性裁剪发生在 compact 触发之前，落到 Turn 结构里的就是裁过的。这和"持久化 = LLM 视角"一致，不视为数据丢失。

**不变量**：`canonical == rebuildCanonicalMessages(persistedTurns, [compactBefore?])`——三路状态（LLM context / state.messages / transcript）完全一致。

### ADR-TR-7：commitTurn 返回 canonical messages（对齐 §0.7.1）

**决定**：`ITranscriptStore.commitTurn(id, {turn, compactBefore?}): Promise<Message[]>`——写入后内部调用 `rebuildCanonicalMessages` 并返回。

**原因**：
- 调用方拿到 canonical 后直接 `state.messages = canonical` / `session.runtime.updateMessages(canonical)`，无需自己重算
- 避免调用方散落的 rebuild 逻辑造成不一致
- `appendCompact`（手动 /compact 路径）同样返回 canonical，接口对称

**实现**：commitTurn 内部已经写入文件，再 rebuild 不需要二次读盘（写什么就 rebuild 什么）。成本 = 一次内存遍历。

### ADR-TR-8：Per-Transcript 串行化（R2 升级为必做）

**决定**：`TranscriptStore` 对同一 `conversationId` 的所有写路径（`commitTurn` / `appendCompact` / `load`-触发的 normalize）**串行化**——不能并发，必须排队。

**原因**：
- commitTurn 的原子重写是 `write tmp → rename`；load 触发的 lazy normalize 也是 `write tmp → rename`。如果并发，两个 writer 同时 `rename` 不同的 tmp 到同一目标 → 后者覆盖前者 → 第一个写入的数据丢失
- 单独 `fs.rename` 对每次调用是原子的，但"读+决策+写"整个事务不原子
- 即使"单 conversation 单 writer"（ConversationManager.busy 保证了 run 级串行），load 可以在 run 空档触发（比如 UI 渲染调 load），和后续 commitTurn 起 race

**实现**：
- TranscriptStore 内部维护 `Map<conversationId, Promise<void>>`（尾部链）
- 每次写操作前：`const prev = locks.get(id); const next = prev.then(() => doWrite()); locks.set(id, next.catch(() => {}));`
- 读路径（load 无 normalize 需求时）不参与锁；load 触发 normalize 时走锁
- 跨 conversation 不互斥——不同 id 完全并发

**放弃的备选**：进程内全局锁（过粗，多会话相互阻塞）；OS 级 flock（跨平台兼容性差，Windows 要 LockFileEx）。

### ADR-TR-9：归档策略统一（合并 ADR-TR-4 与 R3）

**决定**：裁剪类操作（compact 原子重写、lazy normalize 重写）若用户开启归档，**统一走 ADR-TR-4 的归档机制**（`transcript.<ISO-ts>.archive.jsonl` + `archiveKeep: N`），不再有第二套 `.pre-normalize.bak` 并存。

**原因**：两套备份机制文件名规则、保留窗口、清理时机不统一会互相掩埋。用户开关一个即可。

**默认**：归档关闭（`archiveOnCompact: false`）。开启时**所有**裁剪操作都归档；关闭时直接重写，不保留旧数据。

---

## 4. 接口变更清单

> 全部对齐 §0.7（单向数据流 + commitTurn 返回 canonical + 废弃 CompactInfo/TurnCompletion + SessionRuntime.updateMessages）。

### 4.1 `@zhixing/core` - TranscriptStore

```ts
interface ITranscriptStore {
  init(id, opts): Promise<void>;
  load(id): Promise<LoadedTranscript>;
  countTurns(id): Promise<number>;
  exists(id): Promise<boolean>;

  // ★ 单一主入口：覆盖三种合法形态（ADR-TR-7）
  //   { turn }               → 普通 append（每轮对话）
  //   { turn, compactBefore }→ 带压缩的 turn（自动 compact）
  //   { compactBefore }      → 纯压缩无 turn（手动 /compact）
  //   {}                     → 非法，throw
  commitTurn(id: string, payload: {
    turn?: Turn;
    compactBefore?: CompactMarker;
  }): Promise<Message[]>;

  // legacy 薄别名（保持 backward-compat）；内部一律委托 commitTurn
  appendTurn(id: string, turn: Turn): Promise<void>;
  appendCompact(id: string, compact: CompactMarker): Promise<Message[]>;
}

// ★ 新 public export —— 供 ConversationManager ephemeral 分支重建内存 canonical
export function rebuildCanonicalMessages(
  turns: readonly Turn[],
  compacts: readonly CompactMarker[],   // 归一化后长度 <= 1
): Message[];
```

**commitTurn 核心算法**（修 N1 + N3）：

```ts
async commitTurn(id, { turn, compactBefore }): Promise<Message[]> {
  if (!turn && !compactBefore) {
    throw new Error("commitTurn requires at least turn or compactBefore");
  }
  return await this.lock(id, async () => {
    const loaded = await this._loadUnlocked(id);  // 归一化已同步执行（ADR-TR-5）
    const existingCompact = loaded.compacts[0];    // 归一化后至多 1 个

    if (compactBefore) {
      // ★ 关键：按 compactBefore.turnsCompacted 切分当前文件 turns，保留末尾部分
      //   turnsCompacted = 本次压缩替代的文件 Turn 数（相对于 loaded.turns，不含新 turn）
      const keepCount = Math.max(0, loaded.turns.length - compactBefore.turnsCompacted);
      const retainedTurns = loaded.turns.slice(-keepCount);
      const newTurns = turn ? [...retainedTurns, turn] : retainedTurns;

      // 原子重写：header + compactBefore + newTurns
      const lines = [
        serialize(loaded.header),
        serialize(compactBefore),
        ...newTurns.map(serialize),
      ].join("\n") + "\n";
      await writeTmpAndRename(this.filePath(id), lines);

      return rebuildCanonicalMessages(newTurns, [compactBefore]);
    }

    // 无新 compact → 简单 append turn（existingCompact 保持不动）
    await fs.appendFile(this.filePath(id), serialize(turn!) + "\n");
    return rebuildCanonicalMessages(
      [...loaded.turns, turn!],
      existingCompact ? [existingCompact] : [],
    );
  });
}

// legacy 薄别名
appendTurn(id, turn)     { await this.commitTurn(id, { turn }); }
appendCompact(id, c)     { return await this.commitTurn(id, { compactBefore: c }); }
```

**语义小结**：
| payload | 行为 | 文件形态变化 |
|---------|------|-------------|
| `{turn}` | append 模式 | `header + [compact?] + ...turns + turn` |
| `{turn, compactBefore}` | 原子重写，按 turnsCompacted 截断保留末尾 | `header + compactBefore + retainedTurns + turn` |
| `{compactBefore}`（手动 /compact） | 原子重写，按 turnsCompacted 截断 | `header + compactBefore + retainedTurns` |

**`_loadUnlocked` vs `load`**（修 A7）：为避免锁内二次获取锁的死锁，TranscriptStore 内部把 load 拆成两层——
- `load(id)`: public，获取 per-transcript 锁 → 调 `_loadUnlocked(id)` → 若检测 `needsNormalize` 则在锁内同步触发归一化重写 → 返回最新 `LoadedTranscript`
- `_loadUnlocked(id)`: private，纯读文件不获取锁；仅供已在锁内的代码（如 commitTurn 内部）调用

commitTurn 的 `_loadUnlocked` 调用因为已在外层 `this.lock(id, ...)` 内，不会再触发锁。

**Windows rename** 行为（修 A8）：**Windows 平台默认走 fallback 路径**（更保守）——即 `write tmp → unlink old → rename tmp → old` + 启动期 orphan `.tmp` 清理。Linux/macOS 走 simple rename（POSIX 原子）。smoke test（§0.7.7）仅用来决定"是否**额外启用**简单 rename 优化"——成功时优化为 simple rename（生产可配置），默认仍是 fallback。保守策略应对 Windows 共享驱动器 / WSL 跨 fs 边界 / 旧版 NTFS 等边缘场景。

**`rebuildCanonicalMessages`**（原 private `rebuildMessages`）：
- 位置：`packages/core/src/transcript/store.ts` → 提升为 module-level export
- 在 `packages/core/src/index.ts` 加导出行
- 行为不变：归一化后 `compacts.length <= 1`，首条 placeholder pair（若有 compact）+ 所有 turns 展开

### 4.2 `@zhixing/core` - RunResult + SessionRuntime

**废弃中间类型**：不再使用 `TurnCompletion` / `CompactInfo`；统一用 `CompactMarker`（来自 transcript/types.ts）。

```ts
// core/src/loop/types.ts
interface RunResult {
  agentResult: AgentResult;
  turn: Turn;                      // 本轮原始 user+assistant 事件（构造见 §0.7.8）
  compactBefore?: CompactMarker;   // 本 run 最后一次 compact 的 marker（L1 规则）
  newMessages: Message[];          // 本轮 yield 流增量（保留；与 canonical 正交，见 §0.7.9）
  usage?: TokenUsage;
  budget?: ContextBudget;
  durationMs: number;
  toolEndCount: number;
  injectedSkillIds: string[];
}

// core/src/runtime/types.ts
interface RunParams {
  messages: Message[];
  turnIndex: number;                // ★ 新增（修 N8）：本轮 turn 号，由调用方传入（REPL: state.turnCounter；server: session.turnCount）
  turnContext?: TurnContext;
  source?: TurnSource;              // "interactive" / "channel" / "scheduler"，用于 turn.source 字段
  onYield?: (event: AgentYield) => void;
  // ... 其他现有字段（enrichOptions / securityPrompt / onBeforeEventRender / abortSignal）
}

interface RunTurnOptions {          // SessionRuntime.run 的第二参
  turnIndex: number;                // ★ 新增（同上）
  turnContext?: TurnContext;
  source?: TurnSource;
  abortSignal?: AbortSignal;
}

interface SessionRuntime {
  sessionId: string;
  confirmationBroker?: IConfirmationBroker;
  run(text, opts?: RunTurnOptions | AbortSignal): AsyncGenerator<AgentYield, RunResult>;
  updateMessages(canonical: Message[]): void;   // ★ 新增（§0.7.5）
  getHistory(limit?): Message[];
  abort(): void;
  dispose(): void;
}
```

**调用方 turnIndex 来源**：
- **REPL** (`repl.ts`)：`turnIndex: state.turnCounter`（每次 commitTurn 成功后 `state.turnCounter++`）
- **InboundRouter** (`server`)：`turnIndex: session.turnCount`（由 ConversationManager 的 ManagedSession 持有；`recordTurn` 成功后 `session.turnCount++`）
- **ephemeral-executor**（scheduler）：`turnIndex: 0`（ephemeral 单 prompt）

### 4.3 `@zhixing/cli` - session-adapter

```ts
// queue "done" 项携带 RunResult
interface QueueItem {
  kind: "yield" | "done" | "error";
  value?: AgentYield;
  runResult?: RunResult;   // 原 result: AgentResult
  error?: unknown;
}

// run 内部：不再 push newMessages；只 return RunResult
export function createServerRuntimeAdapter(sessionId, agentRuntime, initialMessages?): SessionRuntime {
  let messages: Message[] = initialMessages ? [...initialMessages] : [];

  return {
    sessionId,
    confirmationBroker: agentRuntime.confirmationBroker,

    async *run(text, opts?) {
      messages.push(userMessage(text));
      try {
        // ... 原有 queue 消费逻辑
        // agentRuntime.run(...) 返回 RunResult（含 turn + compactBefore）
        const runResult = await agentRuntime.run({ messages: [...messages], ... });
        return runResult;
        // 注意：messages 成功分支不在这里更新——等调用方 commitTurn 后 updateMessages 回喂
      } catch (err) {
        // ★ 失败回滚：移除刚 push 的 userMsg，避免下次 run 时连续 user 消息
        //   （复用当前 session-adapter.ts:124 `if (turnAborted) { messages.pop(); }` 的语义）
        messages.pop();
        throw err;
      }
    },

    updateMessages(canonical: Message[]): void {
      messages = [...canonical];
    },

    // getHistory / abort / dispose 不变
  };
}
```

### 4.4 `@zhixing/server` - ConversationManager

**ManagedSession 扩展**（修 H4）：

```ts
interface ManagedSession {
  // ... 现有字段
  pendingTurns: Turn[];
  pendingCompact?: CompactMarker;   // ★ 新增：ephemeral 期间累积的最新 compact 边界
}
```

**Callback 接口**：

```ts
interface ConversationManagerCallbacks {
  // ★ 替代旧 persistTurn；返回 canonical 用于回喂 SessionRuntime
  commitTurn?: (id: string, payload: {
    turn: Turn;
    compactBefore?: CompactMarker;
  }) => Promise<Message[]>;
  // 其余回调不变；loadHistory / initTranscript 用法不变
}
```

**recordTurn 重写**（修 H2 + H4 + N9）：

```ts
async recordTurn(
  conversationId: string,
  turn: Turn,
  compactBefore?: CompactMarker,
): Promise<Message[]> {
  const session = this.sessions.get(conversationId);
  if (!session) return [];

  if (session.ephemeral) {
    // ★ 修 N9：按 compactBefore.turnsCompacted 切分 pendingTurns 保留末尾
    //   （对齐 commitTurn 在 persistent 分支的切分逻辑；N11 累积累加后 turnsCompacted
    //    是 run 内累积替代总数，相对于本次 run 之前的 pendingTurns 长度）
    if (compactBefore) {
      const keepCount = Math.max(
        0,
        session.pendingTurns.length - compactBefore.turnsCompacted,
      );
      session.pendingTurns = session.pendingTurns.slice(-keepCount);
      session.pendingCompact = compactBefore;   // 覆盖式（N11 累积已在 run-agent 闭包做过）
    }
    session.pendingTurns.push(turn);
    session.turnCount++;

    // 内存版 canonical = 从 pendingTurns + pendingCompact 重建
    const canonical = rebuildCanonicalMessages(
      session.pendingTurns,
      session.pendingCompact ? [session.pendingCompact] : [],
    );
    session.runtime.updateMessages(canonical);

    // 第 2 个 turn 自动 promote（首次落盘）
    if (session.turnCount >= 2) {
      await this.promote(conversationId);
    }
    return canonical;
  }

  // persistent：commitTurn 落盘 + 拿 canonical + 回喂
  const canonical = await this.commitTurn!(conversationId, { turn, compactBefore });
  session.runtime.updateMessages(canonical);
  session.turnCount++;
  return canonical;
}
```

**promote 重写**（修 H4 + N9）：

```ts
async promote(conversationId: string): Promise<boolean> {
  const session = this.sessions.get(conversationId);
  if (!session || !session.ephemeral) return false;
  if (!this.commitTurn) return false;

  if (!session.transcriptInited && this.initTranscript) {
    await this.initTranscript(conversationId);
    session.transcriptInited = true;
  }

  if (session.pendingCompact && session.pendingTurns.length > 0) {
    // 有 compact 边界：第一个 pendingTurn 带 compactBefore 落盘（触发原子截断），
    // 后续 pendingTurns 依次 append（都是 compact 之后保留的 turns，需持久化）
    // ★ 修 N9：不能只写最后一个——pendingTurns 经切分后保留的是"压缩后仍活跃的 turns"，
    //   它们全部需要持久化；commitTurn 原子重写产生 header+compactBefore+allRetainedTurns
    const [first, ...rest] = session.pendingTurns;
    await this.commitTurn(conversationId, { turn: first, compactBefore: session.pendingCompact });
    for (const t of rest) {
      await this.commitTurn(conversationId, { turn: t });
    }
  } else {
    // 无 compact：依次 flush 所有 pendingTurns
    for (const t of session.pendingTurns) {
      await this.commitTurn(conversationId, { turn: t });
    }
  }

  session.pendingTurns.length = 0;
  session.pendingCompact = undefined;
  session.ephemeral = false;
  return true;
}
```

**语义不变量**：
- `session.runtime.messages` 永远等于 `rebuildCanonicalMessages(persisted/pending-turns, [compactBefore?])`
- 这对 persistent 和 ephemeral 都成立（单一事实源 §0.7.1）

### 4.5 `@zhixing/server` - InboundRouter

```ts
// inbound-router.ts turn 完成分支附近
let runResult: RunResult | undefined;
for await (const event of runtime.run(text, opts)) {
  // ...处理 event
}
// 从 generator 拿 return 值：需要用 while + gen.next() 或改造消费
// 结论：改造 runtime.run 消费方式，在 "done" 分支拿到 runResult

await this.conversations.recordTurn(
  conversationId,
  runResult.turn,
  runResult.compactBefore,  // 可能是 undefined
);
// recordTurn 内部已 updateMessages，这里无需再做
```

### 4.6 `@zhixing/cli` - REPL

```ts
// repl.ts ~1220-1265
const runResult = await state.agent.run({...});
// runResult: { agentResult, turn, compactBefore?, ... }

if (state.conversationId) {
  const canonical = await state.store.commitTurn(state.conversationId, {
    turn: runResult.turn,
    compactBefore: runResult.compactBefore,
  });
  state.messages = canonical;               // ★ 整体替换，不再 push newMessages
  state.convRepo.touch(state.conversationId).catch(() => {});
  state.turnCounter++;
}
```

手动 /compact 路径（repl.ts:511-540）同理：
```ts
const result = await state.agent.forceCompact([...state.messages], state.turnCounter);
if (result.modified && result.compactBefore) {
  // 走统一入口 commitTurn({compactBefore})——内部按 turnsCompacted 保留末尾 turns
  state.messages = await state.store.commitTurn(
    state.conversationId,
    { compactBefore: result.compactBefore },
  );
  console.log(chalk.green(`  ✓ 压缩完成，当前上下文占用 ${pct}%\n`));
}
```

### 4.7 `@zhixing/cli` - AgentRuntime.forceCompact 扩展

```ts
forceCompact(messages: Message[], turnCount: number): Promise<{
  modified: boolean;
  messages: Message[];           // agent-loop 视角的压缩结果（供 /usage 等显示）
  budget?: ContextBudget;
  compactBefore?: CompactMarker; // ★ 新增；供 REPL 调 appendCompact
}>
```

实现：
- 内部创建**独立 eventBus**（与 run() 的事件流隔离）订阅 `context:compact_end`，用订阅时时间戳组装 CompactMarker
- 但 **strategies 数组复用 factory 外层共享实例**——这意味着 `LLMSummarizeStrategy.circuitBreaker` 状态跨 run() 和 forceCompact() 共享，是**有意为之**（手动 compact 失败会拖慢后续自动 compact，但不丢失已有熔断计数）
- forceCompact 的 first-try + forced-retry 两次都可能 fire，取最后一次（对齐 L1 规则）

---

## 5. 文件格式演进

### 归一化后的不变量

```
┌────────────────────────────────────────┐
│ header                                 │ ← 总是首行
├────────────────────────────────────────┤
│ [compact]  ← 可选，至多 1 个，紧跟 header │
├────────────────────────────────────────┤
│ turn turn turn ...                     │ ← 按 turnIndex 递增
└────────────────────────────────────────┘
```

`TRANSCRIPT_FORMAT_VERSION` **不升级**——新不变量是更严格的子集，旧 version=1 的文件仍可读（兼容读 + lazy 归一化），format 版本不变。

### `rebuildCanonicalMessages` 简化

```ts
// 简化后（§4.1 提升为 public export，名字从 rebuildMessages 改为 rebuildCanonicalMessages）：
export function rebuildCanonicalMessages(
  turns: readonly Turn[],
  compacts: readonly CompactMarker[],   // 归一化后长度 <= 1
): Message[] {
  const msgs: Message[] = [];
  if (compacts.length > 0) {
    const c = compacts[compacts.length - 1]!;  // 归一化后总是唯一
    // 使用 <system-meta kind="..."> 统一格式（N10）——
    // 与 LLMSummarize.buildCompactedMessages 完全一致，stripSummaryPlaceholderPair 能识别
    msgs.push({
      role: "user",
      content: [{ type: "text", text: `<system-meta kind="compact-summary">${c.summary}</system-meta>` }],
    });
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: `<system-meta kind="ack">已阅读摘要</system-meta>` }],
    });
  }
  for (const t of turns) {
    msgs.push(t.userMessage, t.assistantMessage);
  }
  return msgs;
}
```

兼容读（旧文件）：发现多 compact 或有前史 turns 时，仍按原 timestamp 过滤逻辑 load；load 完触发 normalize 重写，下次 load 就走快路径。

---

## 6. 里程碑与任务分解

> **注意**：M1-M4 的前置是 §0 的 M0（修复 compact 链条）。M0 未完成前不得进入 M1，否则磁盘清理会用假 summary 换真数据。

### M1 — core 原子写入 + 新接口
- Windows rename smoke test（§0.7.7）—— 起手第一件事
- `TranscriptStore.commitTurn` 实现（append / 原子重写双路径，返回 canonical messages）
- `appendCompact` 改为原子重写，返回 canonical
- `rebuildCanonicalMessages` 按文件顺序简化（至多 1 个 compact，紧跟 header）
- 旧文件兼容读 + lazy normalize
- 废弃 `CompactInfo` 类型；run-agent.ts 订阅 compact_end 直接组装 `CompactMarker`
- 测试：commitTurn 两分支 + 原子性（crash fixture）+ normalize + `assertToolPairingIntact` helper

### M2 — server 路径接入
- `RunResult` 统一形态（`{agentResult, turn, compactBefore?, ...}`）
- `SessionRuntime` 接口：`run` return 类型 → `RunResult`；新增 `updateMessages(canonical)`
- `session-adapter.ts` 内部 messages 持有 + `updateMessages` 方法；queue "done" 携带 RunResult
- `ConversationManagerCallbacks.persistTurn` → `commitTurn`（返回 canonical）
- `ConversationManager.recordTurn` 签名扩展：`(id, turn, compactBefore?) → Promise<Message[] | undefined>`；持久分支内部调 updateMessages 回喂
- `InboundRouter` 从 generator return 值取 RunResult
- 测试：InboundRouter + compact 触发 + canonical 回喂同步

### M3 — REPL 路径切换
- `repl.ts` 合并为 `commitTurn`，用返回值整体替换 `state.messages`
- `AgentRuntime.forceCompact` 返回值扩展 `compactBefore`；`/compact` 命令走 `store.appendCompact`
- 测试：REPL turn + 自动/手动 compact 的当轮 turn 不再丢失；跨 run 压缩累积生效

### M4 — 兼容性 + 验收
- 老格式 fixture（多 compact + 前史 turns）验证 load → normalize → 再 load 一致
- E2E：daemon 场景下跑到 compact 触发，重启后 transcript 文件行数不单调爆炸
- roadmap 技术债"Transcript 段轮转"移除
- 精简内容合并到 `conversation-model.md` / `session-persistence.md` / `context-architecture.md`，删除本文档

---

## 7. 风险与非目标

### 风险

| # | 风险 | 缓解 |
|---|------|------|
| R1 | Windows rename overwrite 某些路径失败 | CI 加 Windows 测试（§0.7.7 smoke test）；失败则 fallback 到 unlink+rename + orphan-tmp 启动清理 |
| R2 | normalize 写入与 commitTurn 并发 | **ADR-TR-8 per-transcript 串行化**（强制，不再"如需要再加"） |
| R3 | 旧文件兼容读误归一化丢数据 | 兼容读严格沿用原 timestamp 过滤；可选归档由 **ADR-TR-9** 统一开关（`archiveOnCompact: true` 时裁剪前 archive，关闭则直接重写） |

### 非目标

- 跨对话 retention（如"最近 90 天的对话自动归档"）—— 属于 "对话数量无上限" 的另一条线，不在本文档
- 手动 `/prune` 命令 —— 用户不需要；compact 自动截断已满足
- Transcript 压缩（gzip 等）—— 过早优化

---

## 8. 与现有设计的映射

| 现有文档 | 受影响段落 | 合并动作 |
|---------|-----------|---------|
| `conversation-model.md` | §ADR-CM-015（TranscriptStore 职责）| 补 "commitTurn 原子事务 + 至多 1 个 compact + per-transcript 串行化（ADR-TR-8）" |
| `session-persistence.md` | JSONL 格式说明 | 更新不变量描述（header + [compact?] + turns） |
| `context-architecture.md` | context:compact_end 事件 | 更新为"事务化 payload：`{strategies[], summary?, turnsCompacted?, tokensBefore, tokensAfter}`；废弃 `CompactInfo` 类型" |
| `conversation-model.md` | §SessionRuntime 接口 | 新增 `updateMessages(canonical)` 方法契约；`run` return 类型由 `AgentResult` 改 `RunResult` |
| `implementation-roadmap.md` | 技术债延后表"Transcript 段轮转" | 移除条目（已治理） |

**本文档命运**：M4 验收完成后删除 `research/design/drafts/transcript-retention.md`。
