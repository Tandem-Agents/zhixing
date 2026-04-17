# 上下文架构 (Context Architecture)

> **版本**: v1.0
> **状态**: 📐 设计稿（2026-04-17）
> **定位**: 上下文管理的**唯一权威设计文档**。取代 context-engine.md、context-management.md、context-architecture-draft.md 三份旧文档。
> **关联**:
>
> - [conversation-model.md](./conversation-model.md) — Conversation / SessionRuntime / Turn 三层模型
> - [persistent-service.md](./persistent-service.md) — AgentOrchestrator / BackgroundAgent 运行时
> - [memory-system.md](./memory-system.md) — Journal + 三支柱（Profile / Skills / People）
> - [prompt-system.md](./prompt-system.md) — Prompt 构建与缓存

---

## 一、设计定位

**上下文管理是知行的核心竞争力**。同等模型能力下，上下文效率决定：

- **成本**：更少 tokens → 更低 API 费用
- **质量**：长上下文稀释注意力，精简上下文让模型推理更准确
- **延迟**：长输入影响 TTFT（首 token 时间）
- **工作预算**：留给工具调用 / 中间推理 / 结果生成的空间

### 知行 vs 竞品

| 维度 | Claude Code | OpenClaw | **知行** |
|------|-------------|----------|---------|
| Token 估算 | API usage + 保守系数 | chars/4 + 20% 余量 | **CJK 一等公民 + API 自适应校准** |
| 预算阈值 | 固定绝对值（13K/3K） | 无（overflow 后被动） | **百分比阈值，自适应任何模型窗口** |
| 压缩策略 | 5 层递进 + cache 感知 | 1 层 + Safeguard | **4 级 Tier + 动态驱逐 + LLM 兜底** |
| 触发时机 | 主动 | 被动（overflow/timeout） | **主动（每 Turn prepareTurn 检查）** |
| 场景感知 | 无 | 无 | **ScenarioEvaluator + ContextProfile 参数化** |
| 消息固定 | 无 | 无 | **Pinning（目标 + 任务账本不驱逐）** |
| 内容恢复 | 压缩后原文丢失 | 无 | **recall_history 工具，驱逐 ≠ 丢失** |
| CLI/Server | CLI only | 不同路径 | **同一 prepareTurn，零代码分支** |
| 可扩展性 | 硬编码 | 接口好但实现空 | **策略模式 + 可插拔** |

---

## 二、不可违反的铁律

### 铁律 1：默认路径零额外 LLM 调用，CRITICAL 兜底

每 Turn 的标准压缩流程（Tier 压缩 + Turn 驱逐）不触发 LLM。**唯一例外**：预算达到 CRITICAL 阈值且所有免费手段已用尽时，系统自动执行一次 LLM 摘要作为压箱底兜底。使用主模型执行，不假设用户配置了副模型。

### 铁律 2：CLI 与 Server 行为同构

同一个 ContextEngine 实例跑两端，差异仅在传入数据（CLI 有 cwd、Server 有 channel），**不在代码分支**。

### 铁律 3：信息损失必须可恢复

被窗口驱逐的 Turn 在 transcript.jsonl 完整保留；AI 通过 `recall_history` 工具能取回。驱逐 ≠ 删除。

### 铁律 4：无外部依赖

不依赖向量数据库、embedding 模型、特定 provider 独家特性。Prompt caching 能用最好，不能用也要能工作。

---

## 三、架构总览

一次 Turn 的处理流程：

```
用户消息进来
    ↓
┌─────────────────────────────────────────────────────────────┐
│  ContextEngine.prepareTurn()                                 │
│  (packages/core/src/context/ — CLI 和 Server 都调这一个)    │
│                                                               │
│  [Step 1] ScenarioEvaluator                                  │
│           看用户消息 + 对话状态 → scenarioHint                │
│           (优先级：用户命令 > Agent escalate > 硬编码 > 启发式) │
│           hint → 查表映射为 ContextProfile（参数组）           │
│                                                               │
│  [Step 2] LayerAssembler                                     │
│           按 Profile 组装 system prompt：                     │
│           L0 身份 + 工具目录（按 Profile 过滤）               │
│           L1 用户画像（按 Profile 可跳过）                    │
│           L2 本轮触发的 skills/people/journal 片段            │
│           L3 工作区 / 时间 / 任务提示（动态）                  │
│                                                               │
│  [Step 3] WindowManager                                      │
│           把对话历史过一遍：                                  │
│           · pinned 消息（第一条 user / 任务账本）不动          │
│           · 其他消息按时序进候选窗口                          │
│                                                               │
│  [Step 4] TierCompressor                                     │
│           旧 tool_result 按轮距分 4 级压缩                    │
│                                                               │
│  [Step 5] 预算检查 + 驱逐级联                                 │
│           算总 tokens → 超阈值则：                            │
│           ① 先降 tier → ② 再驱逐最老 Turn                    │
│           ③ 仍超 CRITICAL → LLM 摘要兜底                     │
│           ④ 兜底也失败 → 按 Profile 处理                      │
│                                                               │
│  [Step 6] 组装 messages[]                                    │
│           system + pinned + windowed + turn-scoped + user    │
└─────────────────────────────────────────────────────────────┘
    ↓
messages[] → Provider → LLM
    ↓
回复 → reportActualUsage() → 校准估算器
```

五大机制各司其职：

| 机制 | 职责 | 章节 |
|------|------|------|
| `ScenarioEvaluator` + `ContextProfile` | 决定用哪套参数 | §十 |
| `LayerAssembler` | 组装系统提示 | §五 |
| `WindowManager`（含 Pinning） | 管理历史消息、驱逐 | §六 |
| `TierCompressor` | 多级压缩 tool_result | §七 |
| LLM Compressor | 压箱底摘要 + 手动 /compact | §九 |

---

## 四、Turn 内容模型

每次 Turn 送进 LLM 的 messages[]：

```
messages[] = [
  ┌── 1. SystemPrompt（1 条）──────────────────────────
  │    Layer 0 · Static  ─ Identity + Tool Catalog（场景过滤）
  │    Layer 1 · Profile ─ 用户画像全文（场景可跳过）
  │    Layer 2 · Scene   ─ 触发命中 Skills/People/关系表/journal 片段
  │    Layer 3 · Dynamic ─ Workspace / 当前时刻 / 任务进度提示
  ├── 2. Pinned Messages（0-N 条，按原始时序）────────
  │    - 第一条 user message（原始目标）
  │    - 最新任务账本（task.update 输出）
  │    - 最新阶段计划（plan.declare 输出）
  ├── 3. Windowed History（M 条，按时序）─────────────
  │    - 近期未驱逐的消息
  │    - 其中 tool_result 已按轮距分级压缩
  ├── 4. Turn-scoped Injections（0-N 条）─────────────
  │    - 本 Turn 内 AI 调用 recall_history / memory_search 的结果
  │    - 仅本 Turn 生效，不带入下一 Turn
  └── 5. Current User Message（1 条）─────────────────
       用户本轮输入（@file: 已展开为文件内容）
]
```

### 三个场景下的输出差异

同一 `prepareTurn`，同一套机制，输出差异完全由场景参数驱动。

**场景 A · 默认 interactive**（"帮我看看这段代码"）：

```
[System]     Identity + Tool Catalog + Profile       ~2500t
[System L2]  空或命中 1-2 个 skills                    ~0-500t
[History]    最近几轮                                  ~1-5K
[User]       "帮我看看这段代码"                         ~50t
Total:                                                ~3-8K
```

**场景 B · hint=social**（"小王最近对我很冷淡"）：

```
[System]     Identity + Tool Catalog + Profile（含 relations）  ~2800t
[System L2]  小王档案 + 近 30 天 journal + social skills 索引   ~2000t
[History]    空或极少                                            ~50t
[User]       "小王最近对我很冷淡"                                ~50t
Total:                                                           ~5K
```

**场景 C · hint=lookup**（"Python 3.13 新特性"）：

```
[System]     Identity lean + query tools only          ~250t
[History]    空                                          0t
[User]       "Python 3.13 新特性"                       ~20t
Total:                                                  ~270t
```

---

## 五、Layer 组装机制（LayerAssembler）

### 5.1 组装顺序

```typescript
function assembleSystemPrompt(
  conv: Conversation,
  userMsg: Message,
  retriever: MemoryRetriever,
  profile: ContextProfile,
): string {
  const l0 = buildLayer0(profile);
  const l1 = profile.includeProfile ? buildLayer1(conv.userProfile) : '';
  const l2 = buildLayer2(profile, userMsg, conv, retriever);
  const l3 = buildLayer3(profile, conv);
  return [l0, l1, l2, l3].filter(Boolean).join('\n\n---\n\n');
}
```

### 5.2 Layer 0 · Static（可 cache prefix）

跨 Conversation 几乎不变，是 prompt cache 首选命中段。

| 成员 | 内容 | 基线大小 | 场景影响 |
|------|------|---------|---------|
| Identity | "你是知行..." + 行为原则 + 安全约束 | 300t / 100t（lean） | `lookup` 用 lean 版 |
| Tool Catalog | 每工具一行 description | 依工具数 | 按 Profile 的 `toolCategories` 白名单过滤 |

**Tool Catalog 过滤**：每个工具声明自己的 categories，Layer 0 组装时按 Profile 过滤。

```typescript
type ToolCategory =
  | 'query'          // read / glob / grep / web_search / memory_search / recall_history
  | 'mutation'       // write / edit
  | 'execution'      // bash
  | 'memory-write'   // journal.remember / skill.save / person.save / profile.update
  | 'task-ledger'    // task.update / plan.declare
  | 'social'         // person.resolve / journal.about
  | 'scenario'       // scenario.escalate
  | 'system';

function buildToolCatalog(profile: ContextProfile, allTools: ToolDef[]): string {
  const allowed = allTools.filter(t =>
    profile.toolCategories.some(cat => t.categories.includes(cat)),
  );
  return allowed.map(t => `- ${t.name}: ${t.description}`).join('\n');
}
```

### 5.3 Layer 1 · Profile

Profile 是用户画像，高频相关、体积适中、跨 Turn 稳定。

| 场景 | Layer 1 处理 | 理由 |
|------|-------------|------|
| `interactive`（默认） | 全文注入 | 基础个性化 |
| `long-task` | 全文注入 | 长任务可能涉及个人偏好 |
| `social` | 全文 + relations 表展开 | 需要称谓→person 映射 |
| `lookup` | **跳过** | 查询类用不上，省 prefix |
| `autonomous` | **跳过** | 背景任务，不引入主人画像 |

**设计决策**：Profile 要么全文注入，要么整体跳过。**不使用"极简摘要/pointer"方案**——实践中极简摘要信息密度太低，看了等于没看；需要就给全文，不需要就不给（见 ADR-CTX-003）。

### 5.4 Layer 2 · Scene（场景参数化最活跃层）

基线只做 trigger 匹配；各场景 hint 追加不同的预加载。

| 场景 hint | Layer 2 内容 |
|----------|-------------|
| `interactive`（基线） | 当前 user message 触发命中的 Skills / People 全文 |
| `social` | **+** profile.relations 全表 **+** 目标人物完整档案 **+** 近 30 天相关 journal 片段 **+** 关系类型对应的 social skills 索引清单 |
| `long-task` | **+** 任务账本引用 **+** 阶段计划引用（实际内容在 pinned 段） |
| `lookup` | **跳过整个 Layer 2** |
| `autonomous` | 仅任务描述显式涉及的 skills / people（隐私收窄） |

#### Layer 2 的触发 + 预加载流程

```
evaluateLayer2(hint, userMessage, conversation, retriever):
  if hint in ['lookup', 'autonomous']:
      return minimalOrSkip(hint, conversation)

  triggers = extractTriggers(userMessage, recentTurns)

  skills = retriever.matchSkills(triggers)
  people = retriever.matchPeople(triggers)

  if hint == 'social':
      resolvedPeople = resolveRelations(userMessage, profile.relations)
      people = merge(people, resolvedPeople)
      journals = retriever.journalAbout(people.ids, since=30d)
      socialSkillsIndex = listSocialSkillsByRelation(people.relations)
      return { skills, people, journals, socialSkillsIndex }

  if hint == 'long-task':
      return { skills, people, taskLedgerRef, phasePlanRef }

  return { skills, people }
```

### 5.5 Layer 3 · Dynamic（每 Turn 重建，不 cache）

| 成员 | 出现条件 |
|------|---------|
| Workspace Context（cwd / 项目信息） | CLI 模式 + 非 lookup |
| Current time | `profile.timeInContext=true` |
| Active Task Hint（任务进度一行摘要） | long-task 且存在 task ledger |

### 5.6 Cache Boundary 策略

Provider 支持时标记：

```
[Cache Point 1]  L0 结束处（Identity + Tools，跨 Conversation 高复用）
[Cache Point 2]  L1 结束处（加 Profile，Conversation 内稳定）
[No cache]       L2 动态子段 + L3 + 之后
```

各 provider 的 cache 语义差异在 provider 适配层处理，ContextEngine 只发 boundary 意图。

---

## 六、消息管理：Pinning + 动态窗口 + 驱逐

### 6.1 Pinning

`Conversation.pinnedMessageIds: string[]` 记录不可驱逐消息。

**默认自动 pin 规则**：

| 消息 | 何时自动 pin |
|------|-------------|
| 第一条 user message | Conversation 创建时 |
| 最新 task ledger | `task.update` 执行时（新 pin，旧 ledger unpin） |
| 最新 phase plan | `plan.declare` 执行时 |
| 用户显式固定 | `/pin <message-id>` 命令 |

组装时按**原始时序**插入 history 最前。特例：最新 task ledger 贴近当前 Turn 尾（Agent 下一步推理最需看见）。

### 6.2 动态窗口

窗口大小是**预算的函数**，不是配置项：

```
algorithm buildWindowedHistory(conv, budget, profile):
    candidate = conv.runtimeMessages except pinned

    # Step 1: Tool_result 多级压缩（§七）
    applyTierCompression(candidate, profile)

    # Step 2: 从头驱逐直到预算内
    while estimate(system + pinned + candidate) > budget.compactThreshold
       and candidate.turnCount > MIN_RETAIN_TURNS:
        evictOldestTurn(candidate)

    # Step 3: 仍超 CRITICAL → LLM 压缩兜底（§九）
    if estimate(total) > budget.criticalThreshold:
        summary = await llmCompress(evictedTurns, provider)
        if summary:
            replaceWithSummary(messages, summary)
        else:
            # LLM 压缩也失败（CircuitBreaker 熔断等）
            if profile.onExhausted == 'yield-event-to-parent':
                yield event 'context_exhausted'
            else:
                yield critical_error '运行 /compact 或开新 Conversation'

    return candidate
```

### 6.3 驱逐级联（精细化）

预算超阈值时，按优先级**逐步**执行，每步后重算：

```
1. Tool_result 逐级降 Tier（1→2→3→4）      ← 免费，优先
2. 驱逐最老整个 Turn（pinned 除外）          ← 免费
3. LLM 摘要压缩（§九）                      ← 压箱底兜底
4. 仍超 CRITICAL → 按 Profile 分流           ← 极端情况
```

---

## 七、Tool_result 多级压缩（TierCompressor）

### 7.1 四级 Tier（按轮距）

```
Tier 1 · 轮距 ≤ T1              完整保留
Tier 2 · T1 < 轮距 ≤ T2         trim 到 perToolMaxChars（默认 2000 字符）
Tier 3 · T2 < 轮距 ≤ T3         trim 到 tier3MaxChars（默认 500 字符）+ 结构化标记
Tier 4 · 轮距 > T3              只保留 "[tool=X(args_hash=Y) bytes=N, recallable]"
                                tool_use 调用骨架保留（支撑推理轨迹），内容去除
```

### 7.2 Tier 阈值的 Profile 参数化

| Profile | T1 | T2 | T3 |
|---------|----|----|----|
| `interactive`（基线） | 2 | 10 | 50 |
| `long-task` | 1 | 5 | 25 |
| `autonomous` | 1 | 3 | 12 |
| `lookup` | — | — | — |

### 7.3 设计要点

- **降级优先于驱逐**：预算超阈值时，先把旧 tool_result 的 tier 降下来，再考虑驱逐整 Turn。旧 tool_result 的"内容"衰减快，但 tool_use "调用骨架"的推理轨迹价值长期有效
- **Tier 4 保留调用骨架**：让 LLM 知道"第 N 轮调了 bash 命令，结果 8KB"，支撑推理链完整性
- **与现有 tool-result-trim.ts 的关系**：升级为 tier-compressor.ts，从单级截断变为四级

### 7.4 工具调用去重（可选，Phase 2+）

检测同 `tool_name + args_hash` 的 tool call 近期重复，保留最新结果，更早替换为 `[duplicate of turn X]`。长任务场景的防御优化。

---

## 八、预算系统

### 8.1 Token 估算器

已实现于 `packages/core/src/context/token-estimator.ts`。

```typescript
interface TokenEstimator {
  estimateMessage(message: Message): number;
  estimateMessages(messages: Message[]): number;
  calibrate(estimatedTokens: number, actualTokens: number): void;
  readonly charsPerToken: number;
}
```

**核心算法**：

- CJK / emoji 字符独立加权（~1.5 token/字），拉丁字符 ~0.25 token/字
- 每次 API 返回 `usage` 时，用滑动平均更新 calibration factor（α=0.8 旧 + 0.2 新）
- **不依赖 tiktoken**——三个竞品都验证了不需要

### 8.2 上下文预算

已实现于 `packages/core/src/context/budget.ts`。

```typescript
interface ContextBudget {
  contextWindow: number;
  effectiveWindow: number;   // = contextWindow - min(maxOutput, 20_000)
  currentTokens: number;
  usageRatio: number;
  status: 'normal' | 'warning' | 'compact' | 'critical';
}
```

### 8.3 阈值（Profile 驱动）

| Profile | WARNING | COMPACT | CRITICAL |
|---------|---------|---------|----------|
| `interactive` | 70% | 85% | 92% |
| `long-task` | 60% | 75% | 88% |
| `autonomous` | 40% | 60% | 80% |
| `lookup` | — | — | — |

**百分比阈值替代绝对值**：Claude Code 用固定 13K/3K，在 32K 窗口的小模型上几乎占一半空间。百分比自适应不同窗口大小。

### 8.4 事件系统集成

已实现。预算检查通过 EventBus 发射事件：

| 事件 | 触发时机 |
|------|---------|
| `context:budget_check` | 每次 Turn 预算检查 |
| `context:compact_start/end` | 策略执行前后 |
| `context:calibrate` | 估算器校准 |

---

## 九、LLM 压缩（双模式）

### 9.1 设计哲学

LLM 压缩是"**压箱底**"手段——不是默认路径，但作为安全网不可或缺。它能在极端情况下大幅缩减上下文窗口，是经过验证的有效手段。

- **自动模式**：预算达到 CRITICAL 且免费手段用尽时自动触发，是系统的最后防线
- **手动模式**：用户 `/compact` 主动触发，主动管理上下文长度

两种模式共用同一套压缩引擎（已实现的 `llm-summarize.ts`），区别仅在触发条件。

### 9.2 自动模式（CRITICAL 兜底）

```
触发条件：
  1. 预算状态 = CRITICAL（usageRatio ≥ criticalThreshold）
  2. Tier 压缩 + Turn 驱逐均已执行，仍超阈值
  3. CircuitBreaker 允许（连续 3 次失败则停止）

执行：
  1. 选取被驱逐的 Turn 范围（pinned 除外）
  2. 用主模型生成结构化摘要（关键事实 / 已达成决策 / 未决问题）
  3. 摘要替换被驱逐消息，注入为 role: system
  4. 被替换的原文在 transcript.jsonl 完整保留
```

### 9.3 手动模式（/compact 命令）

```
行为：
  1. 用户主动触发，不受预算状态限制
  2. Fork 一次主模型调用，输入要压缩的 Turn 范围 + 结构化摘要模板
  3. 输出结构化 summary（关键事实 / 已达成决策 / 未决问题 / 用户偏好变化）
  4. 用一条 role: system 消息替换被摘要的 Turn
  5. 被替换 Turn 在 transcript 完整保留，可 recall
  6. CLI 和 Server 共用同一命令

成本：
  - 命令执行前提示预估 tokens 和代价
  - 失败时复用 CircuitBreaker
```

### 9.4 与现有实现的关系

`packages/core/src/context/strategies/llm-summarize.ts` 已实现 LLM 摘要策略：

- CircuitBreaker（3 次连续失败停止）
- `splitMessages` 保留第一条 user message + 最近 N 轮
- 结构化摘要 + 验证
- `createSummarizeFn` 适配器

改造要点：

- 自动模式：在 prepareTurn 的驱逐级联最后一步调用
- 手动模式：通过 `compactExplicit()` 方法暴露给 `/compact` 命令
- 现有 CircuitBreaker 和摘要逻辑完全复用

---

## 十、场景参数化（ScenarioEvaluator + ContextProfile）

### 10.1 核心思路

不同对话需要的"内容配方"差别巨大（参见 §四示例：lookup 270t vs interactive 8K vs social 5K）。知行不为每种对话搭架构，而是搭一套通用机制 + 场景配置。

```
┌─── 不变的机制（所有场景共用）──────────────
│   · 怎么组装系统提示（分层次）
│   · 怎么管理历史消息（pinning + 窗口 + 驱逐）
│   · 怎么压缩 tool_result（分级）
│   · 怎么 LLM 兜底压缩
└────────────────────────────────────────────
              ↑ 消费 ↓
┌─── 可变的场景配置 ──────────────────────────
│   · 该装 Profile 吗？
│   · Tool Catalog 过滤掉哪些？
│   · 预算阈值多少开始压？
│   · Tier 压缩梯度多激进？
│   · 要不要写 transcript？
└────────────────────────────────────────────
```

### 10.2 场景由谁判断

| 优先级 | 谁 | 什么时候 | 典型例子 |
|--------|---|---------|---------|
| 1 | **用户显式命令** | 任何时候 | `/scenario social` |
| 2 | **Agent 主动覆盖** | 运行中发现场景错了 | `scenario.escalate('interactive', '用户要求修改文件')` |
| 3 | **业务代码硬编码** | Conversation 创建时 | AgentOrchestrator 派生 BackgroundAgent 时写死 `autonomous` |
| 4 | **引擎启发式分类器** | 每 Turn 开始时 | 零 LLM 成本的关键词匹配 |

启发式分类器：

```typescript
function evaluateHint(ctx: HintEvalContext): ScenarioHint {
  if (ctx.userOverride) return ctx.userOverride;
  if (ctx.agentEscalation) return ctx.agentEscalation;
  if (ctx.hardcodedHint) return ctx.hardcodedHint;

  const keywordClass = classifyByKeywords(ctx.userMessage);

  if (ctx.prevHint === 'lookup' && ctx.prevAgentDidMutation) return 'interactive';
  if (ctx.prevHint === 'lookup' && ctx.turnCount > 3)        return 'interactive';
  if (keywordClass === 'social')                              return 'social';
  if (keywordClass === 'lookup' && ctx.turnCount <= 1)        return 'lookup';

  return ctx.prevHint ?? 'interactive';
}
```

零 LLM 成本，准确率 80%+ 即可。错误由下一轮重评纠正，或 Agent 用 `scenario.escalate` 主动覆盖。

### 10.3 ContextProfile 结构

```typescript
interface ContextProfile {
  name: 'interactive' | 'long-task' | 'autonomous' | 'lookup';

  // Layer 行为
  includeProfile: boolean;
  layer2Mode: 'basic' | 'enriched' | 'minimal' | 'skip';

  // 工具目录过滤
  toolCategories: ToolCategory[];

  // 预算阈值
  warningRatio: number;
  compactThreshold: number;
  criticalThreshold: number;

  // Tool_result Tier 阈值
  tierThresholds: { T1: number; T2: number; T3: number };

  // 驱逐失败行为
  onExhausted: 'yield-error-to-user' | 'yield-event-to-parent';
}
```

### 10.4 四个内建 Profile

| Profile | includeProfile | layer2Mode | toolCategories | warn / compact / critical | T1/T2/T3 | onExhausted |
|---------|---------------|-----------|---------------|--------------------------|---------|-------------|
| `interactive` | ✓ | basic / enriched（视 hint） | 全部 | 70 / 85 / 92 | 2 / 10 / 50 | error-to-user |
| `long-task` | ✓ | basic | 全部 | 60 / 75 / 88 | 1 / 5 / 25 | error-to-user |
| `autonomous` | ✗ | minimal | 任务声明的 | 40 / 60 / 80 | 1 / 3 / 12 | event-to-parent |
| `lookup` | ✗ | skip | query only | — | — | error-to-user |

### 10.5 scenarioHint 与 Profile 的映射

```
hint 'interactive' / undefined  →  Profile 'interactive'（layer2Mode=basic）
hint 'social'                   →  Profile 'interactive'（layer2Mode=enriched）
hint 'long-task'                →  Profile 'long-task'
hint 'autonomous'               →  Profile 'autonomous'
hint 'lookup'                   →  Profile 'lookup'
```

多个 hint 可映射到同一 Profile（如 `social` 与 `interactive` 共用参数，仅 layer2Mode 不同）。

### 10.6 三轴模型（为什么这五个场景够用）

所有真实对话落在三条轴上：

| 轴 | 取值 |
|---|------|
| 时间尺度 | 瞬时 / 短时 / 长时 / 常驻 |
| 信息密度 | 极简 / 普通 / 富文本 / 超密集 |
| 持久化需要 | 不用留 / 要留 / 要归档 |

五个内建场景各占不同象限：

- `lookup`：瞬时 / 极简 / 不用留
- `interactive`：短时 / 普通 / 要留（默认）
- `social`：短时 / 超密集 / 要留
- `long-task`：长时 / 普通 / 要留
- `autonomous`：常驻 / 普通 / 要留

未来加场景时，先看能不能复用现有 Profile（只加新 hint 映射），不能再加新 Profile。机制代码永远不动。

---

## 十一、AI 工具集

### 11.1 记忆写入（categories: `memory-write`）

| 工具 | 用途 | 写入位置 |
|------|------|---------|
| `journal.remember(fact, tags?, about_person?)` | 沉淀长期事实片段 | `~/.zhixing/me/journal/*.jsonl` |
| `skill.save(name, content, triggers)` | 沉淀方法论，triggers 多维 | `~/.zhixing/me/skills/<name>.md` |
| `person.save(name, facts)` | 沉淀人物档案 | `~/.zhixing/me/people/<name>.md` |
| `profile.update(field, value)` | 更新用户画像 | `~/.zhixing/me/profile.md` |

### 11.2 记忆读取（categories: `query`）

| 工具 | 用途 | 数据源 |
|------|------|-------|
| `memory_search(query)` | 跨 journal / skills / people 检索 | 关键词 + tag |
| `recall_history(query \| time_range \| turn_range)` | 取回被驱逐的旧 Turn 原文 | transcript.jsonl |
| `journal.about(person_id, { since?, limit? })` | 查询某人物相关 journal | journal about_person |
| `person.resolve(query, hints?)` | 指代/称谓消歧，禁止 Agent 自行猜人 | people/ + profile.relations |

### 11.3 任务账本（categories: `task-ledger`）

| 工具 | 用途 |
|------|------|
| `task.update(ledger)` | 覆盖式更新任务账本；自动 pin 最新、unpin 旧的 |
| `plan.declare(plan)` | 声明阶段性计划；自动 pin |

### 11.4 场景控制（categories: `scenario`）

| 工具 | 用途 |
|------|------|
| `scenario.escalate(target, reason)` | Agent 主动切换 scenarioHint |

### 11.5 System Prompt 对 AI 的指令（关键摘录）

> 默认上下文包含：用户画像（Profile，若场景允许）、本轮命中的 Skills / People、最近对话消息、pinned 消息。更早对话**不会自动可见**，需要时用 `recall_history` 取回。
>
> 重要的长期事实 → 主动调 `journal.remember` / `skill.save` / `person.save`，不依赖上下文窗口。
>
> 遇到人物代称 → 先用 `person.resolve` 解析，不确定时向用户澄清，**禁止自作主张选人**。
>
> 长任务完成里程碑 → 调 `task.update` 刷新账本。

---

## 十二、CLI / Server 一致性

### 12.1 唯一入口

```typescript
interface ContextEngine {
  prepareTurn(params: {
    conversation: Conversation;
    runtimeMessages: Message[];
    newUserMessage: Message;
    modelInfo: { contextWindow: number; maxOutputTokens: number };
    memoryRetriever: MemoryRetriever;
    hintOverride?: ScenarioHint;
  }): Promise<{
    messages: Message[];
    hint: ScenarioHint;
    profile: ContextProfile;
    budget: ContextBudget;
    evicted: { turnCount: number; turnRange: [number, number] } | null;
    tierStats: TierCompressionStats;
  }>;

  reportActualUsage(usage: TokenUsage): void;

  compactExplicit(params: {
    conversation: Conversation;
    runtimeMessages: Message[];
    rangeToCompact: [number, number];
    provider: ModelProvider;
  }): Promise<{ summary: Message; evictedRange: [number, number] }>;
}
```

CLI `run-agent.ts` 和 Server `session/*` 都只调这几个方法。引擎不知道跑在哪个进程里。

### 12.2 允许的数据差异

| 字段 | CLI | Server |
|------|-----|--------|
| `conversation.workspace?.cwd` | 通常有 | 通常无 |
| `conversation.channel` | `"cli"` | `"dingtalk" / "feishu" / ...` |
| `conversation.ephemeral` | `-p` 默认 true | 默认 false |

这些影响 Layer 3 / Ephemeral 行为，**引擎算法不分支**。

---

## 十三、Ephemeral Conversation

`Conversation.ephemeral?: boolean`：

| 状态 | 行为 |
|------|------|
| `ephemeral=true` | 内存中创建，不写 transcript；进程退出即释放；不进 conversation list |
| `ephemeral=false`（默认） | append-only 到 transcript.jsonl |

**升级触发**（ephemeral → persistent）：

- 用户 `/save`
- `scenario.escalate` 到非 lookup
- 超过 `ephemeralAutoPersistAfterNTurns`（默认 3）轮

**默认 ephemeral 的情况**：

- CLI `zhixing -p "query"` 单次模式
- CLI REPL 首轮命中 `hint=lookup`（追问则落盘）
- Server **不**默认 ephemeral（每个 channel message 都应可追溯）

---

## 十四、长期文件生命周期

| 对象 | 策略 |
|------|------|
| `transcript/<conversationId>.jsonl` | append-only；超 `archiveDays`（默认 180d）滚动压 `.zst`；recall 透明读归档 |
| `journal/` 片段 | 带 `createdAt` + `lastHitAt` + 可选 `about_person`；90 天未命中标 stale；`/memory audit` 批量管理 |
| `skills/` | 无自动过期；`useCount` + `lastUsedAt` 排序；`/skills audit` 主动管理 |
| `people/` | 无自动过期；用户主动管理；删除时级联清理 journal about_person 引用（仅去标，不删原文） |
| `profile.md` | AI + 用户协作维护 |
| Conversation 元数据 | 永久；`/conversation archive <id>` 显式归档 |
| Ephemeral Conversation | 仅内存；进程退出即释放 |

---

## 十五、隐私边界

### 15.1 People 档案可见性

| 场景 | 规则 |
|------|------|
| CLI 主用户交互 | people/ 全量可见 |
| Server 用户自己通道 | people/ 全量可见 |
| BackgroundAgent | **默认不加载**；仅任务描述显式涉及 person_id 时加载 |
| 跨 Conversation 引用 | **不自动**跨 Conversation 聚合人物的历史提及 |
| 跨通道渲染 | 非主通道回复中不原文引用其他 Conversation 的 people 内容 |

### 15.2 写入安全

所有记忆写入工具执行前，复用声明式威胁模式 + 不可见字符检测。Identity 段明确禁止 AI 主动持久化 API Key / 密码 / token。

---

## 十六、关键阈值与参数

### 16.1 全局常量

| 参数 | 默认 | 说明 |
|------|------|------|
| `perToolMaxChars` | 2000 | Tier 2 trim 长度 |
| `tier3MaxChars` | 500 | Tier 3 trim 长度 |
| `MIN_RETAIN_TURNS` | 2 | 驱逐下限，保证至少保留最近 2 轮 |
| `archiveDays` | 180 | transcript 归档窗口 |
| `journalStaleDays` | 90 | journal stale 阈值 |
| `hintReEvalEveryNTurns` | 1 | hint 重评频率（每轮） |
| `ephemeralAutoPersistAfterNTurns` | 3 | ephemeral 自动落盘阈值 |

所有参数可在 `~/.zhixing/config.json` 的 `context.*` 覆盖。

---

## 十七、与已有实现的关系 + 迁移路径

### 17.1 现有 `packages/core/src/context/` 目录

```
context/
  token-estimator.ts     ✅ 保留（CJK 加权 + calibrate，无需修改）
  budget.ts              🔁 改造（支持 Profile 驱动阈值）
  engine.ts              🔁 改造（新 prepareTurn 入口）
  prompts.ts             🔁 迁移到 layer-assembler.ts
  validation.ts          ✅ 保留
  types.ts               🔁 扩展（新增 ContextProfile / ScenarioHint 等类型）
  strategies/
    tool-result-trim.ts  🔁 升级为 tier-compressor.ts（四级）
    message-drop.ts      ❌ 移除（被动态窗口取代）
    llm-summarize.ts     🔁 改造（自动兜底 + /compact 双入口）
```

### 17.2 新增模块

```
context/
  layer-assembler.ts              # §五 Layer 组装
  window-manager.ts               # §六 动态窗口 + 驱逐
  pin-manager.ts                  # §6.1 Pinning
  tier-compressor.ts              # §七 四级压缩
  scenario/
    profile.ts                    # §10.4 四个内建 Profile
    hint-evaluator.ts             # §10.2 启发式分类器
  tools/
    recall-history.ts             # §11.2
    task-update.ts                # §11.3
    plan-declare.ts               # §11.3
    scenario-escalate.ts          # §11.4
```

### 17.3 其他模块的 schema 变更

| 模块 | 新增字段 |
|------|---------|
| conversation-model | `pinnedMessageIds` / `scenarioHint` / `ephemeral` / `contextProfile` |
| memory-system (profile.md) | 结构化 `relations` 段 |
| memory-system (journal) | 条目新增 `about_person?: string[]` |
| skills-evolution | triggers 升级为多维（keywords / relations / scenarios / emotions） |
| tools-builtin | 所有工具新增 `categories: ToolCategory[]` |

### 17.4 迁移阶段

| Phase | 内容 | 风险 |
|-------|------|-----|
| P1 | TierCompressor（四级替代单级 trim）+ WindowManager + PinManager | 中 |
| P2 | 重写 engine.ts 为 prepareTurn 入口；引入 `interactive` Profile | 中 |
| P3 | recall_history 工具 + /compact 命令（双模式 LLM 压缩） | 低 |
| P4 | hint evaluator + `lookup` / `long-task` profile + ephemeral | 中 |
| P5 | 社交扩展（relations / resolve / journal.about / 多维 triggers） | 中，依赖 memory 升级 |
| P6 | `autonomous` profile + context_exhausted + task.update / plan.declare | 中，依赖 AgentOrchestrator |

---

## 十八、未决议题

### 参数调优

- [ ] Tier 轮距阈值（2/10/50 为初始值，需实测后调整）
- [ ] warning/compact/critical 比例在不同模型窗口下的表现
- [ ] hint 启发式关键词表

### 机制细节

- [ ] **Tool JIT**：默认只在 Tool Catalog 放一行 description、使用时临时注入完整 schema 的方案。依赖各 provider 对"动态 tools 字段"的支持程度，需调研后决定是否引入
- [ ] Layer 2 预加载超出预算时的优先级（目标人物 > social skill > journal？）
- [ ] Prompt cache boundary 的精确切位
- [ ] `person.resolve` 置信度算法

### AI 行为

- [ ] System prompt 记忆引导的最终措辞（需实测不同模型遵循度）
- [ ] 小模型下的降级策略

### 用户可见性

- [ ] `/status` 展示当前 hint / profile / budget
- [ ] `/scenario <hint>` 用户主动切换
- [ ] `/pin` / `/unpin` 手动 pin 管理

### 归档

- [ ] transcript 归档触发时机（定时 / 懒 / 启动时）
- [ ] 用户删除 Conversation 时 journal 的级联策略

---

## 十九、ADR 决策记录

### ADR-CTX-001：上下文作为核心竞争力

**决策**：把"最小化上下文使用"从工程优化项升级为**架构核心原则**，与安全、性能、可扩展性同级。

**理由**：上下文效率是跨场景的乘子因素，决定成本、质量、延迟、工作预算四个维度。

---

### ADR-CTX-002：默认路径零额外 LLM 调用，CRITICAL 兜底

**决策**：`prepareTurn` 标准流程（Tier 压缩 + Turn 驱逐）不触发 LLM。仅 CRITICAL 阈值且免费手段用尽时，自动执行一次 LLM 摘要兜底。用户可随时 `/compact` 手动触发。

**理由**：LLM 压缩成本高、延迟大，不应是默认路径；但作为压箱底安全网不可或缺——在极端情况下能有效缩减上下文窗口，大大释放工作空间。不假设用户有副模型，使用主模型执行。

---

### ADR-CTX-003：Profile 全文 vs 跳过，不使用极简摘要

**决策**：Profile 在 `interactive` / `long-task` / `social` 下全文进 Layer 1；在 `lookup` / `autonomous` 下跳过。Skills / People 以"触发命中则全文注入"处理。**不使用单行 pointer 或极简摘要**。

**理由**：实际场景中极简摘要信息密度太低，"看了跟没看一样"——要么给充分信息，要么不给。需要 Profile 的场景下全文注入体积可控（几百 tokens），值得 cache；不需要的场景跳过省 prefix。

---

### ADR-CTX-004：N 是预算的函数，不是配置项

**决策**：保留的"最近 N 轮"不设硬数字，由预算阈值 + 动态驱逐算法涌现。

**理由**：硬编码 N 在不同模型窗口下行为不一；百分比阈值自适应任何窗口大小。

---

### ADR-CTX-005：窗口驱逐不等于信息丢失

**决策**：驱逐的 Turn 一律在 transcript.jsonl 完整保留；可通过 `recall_history` 取回。

**理由**：窗口是"工作台"，transcript 是"档案"；下架 ≠ 删除。

---

### ADR-CTX-006：CLI 与 Server 共用同一引擎，无分支

**决策**：`prepareTurn` 是 CLI 和 Server 的唯一上下文入口；差异仅在传入数据。

**理由**：两端一致是产品一致性基石；分支是未来 bug 温床。

---

### ADR-CTX-007：场景参数化，不为每场景分架构

**决策**：场景差异通过 `ContextProfile` + `scenarioHint` 表达；三大机制（Layer / Window / Tier）不感知场景，只消费参数。

**理由**：避免架构随场景爆炸；新场景 = 新 Profile + 新 hint 映射，不改机制代码。

---

### ADR-CTX-008：消息 Pinning 服务于长任务连续性

**决策**：`Conversation.pinnedMessageIds` 标记不可驱逐消息；默认 pin 第一条 user message、最新任务账本、最新阶段计划。

**理由**：长任务的"目标锚点"与"进度账本"必须长期稳定可见；按时序驱逐会挤掉它们。

---

### ADR-CTX-009：Tool_result 分级压缩

**决策**：tool_result 按轮距四级压缩（Tier 1-4）；驱逐顺序先降 tier 再驱逐整 Turn。

**理由**：旧 tool_result "内容"衰减快，但 tool_use "调用骨架"的推理轨迹价值长期有效；分级保留轨迹、去除冗余，成本远低于驱逐整 Turn。

---

### ADR-CTX-010：scenarioHint 启发式重评，零 LLM 成本

**决策**：scenarioHint 每 Turn 由关键词分类器重算；Agent 可 `scenario.escalate` 主动切换。

**理由**：启发式错误代价小（下 Turn 可纠正）；LLM 分类违反铁律 1；Agent 对情境最敏感，应有主动权。

---

### ADR-CTX-011：Ephemeral Conversation

**决策**：`ephemeral=true` 时仅内存中存在，不写 transcript；多种条件可触发升级为持久化。

**理由**：单次查询没有长期保留价值；强制持久化污染 transcript 噪音。

---

### ADR-CTX-012：不引入向量索引

**决策**：短期内不引入向量数据库做记忆检索，保持关键词 + trigger 匹配。

**理由**：个人助手规模（Skills <100, People <50）下关键词足够；向量索引引入 embedding 依赖，违反铁律 4。未来规模上去了可作为 Retriever 可选后端。
