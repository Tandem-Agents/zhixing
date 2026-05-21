# 上下文架构 (Context Architecture)

> ⚠️ **DEPRECATED（2026-05-11 起）**
>
> 本文（v1.2）描述的"场景参数化（ScenarioEvaluator/ContextProfile）+ 多级 Tier 压缩 + 动态驱逐 + Pinning + recall_history + TurnDigest"范式已被整体砍除（commit e182562~aa8678a，2026-05-11）。tier-compressor / window-manager / recall_history / capability 系统 / ContextCompiler 均已从 `packages/` 删除。上下文管理的新单一来源是 [`context-management-v3-redesign.md`](./context-management-v3-redesign.md)（cache 第一优先 + 优质注意力窗口 + 段式 SegmentManager + tools 满载稳定），Phase 1 已实施落地（见 [`../implementation-v3-context-phase1.md`](../implementation-v3-context-phase1.md)）。本文保留为决策痕迹，不再作为实施依据。
>
> ---
>
> **版本**: v1.2
> **状态**: 📐 设计稿（2026-04-18）
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
| 预算阈值 | 固定绝对值（13K/3K） | 无（overflow 后被动） | **百分比阈值，适配任何模型窗口** |
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
│           Turn 1 → 关键词分类，确定初始 hint（§10.2.2）      │
│           Turn 2+ → Sticky hint + 单调升级守卫（§10.2.3）    │
│           hint → 查表映射为 ContextProfile（固定参数组）       │
│                                                               │
│  [Step 2] LayerAssembler                                     │
│           按 Profile 组装 system prompt：                     │
│           L0 身份 + 工具目录（按 Profile 过滤）               │
│           L1 用户画像（按 Profile 可跳过）                    │
│           L2 本轮触发的 skills/people/journal 片段            │
│           L3 工作区 / 时间 / Turn Digest / 任务提示（动态）    │
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
    ↓
Turn 完成 → TurnDigest.record() → Layer 3 下轮可见
```

六大机制各司其职：

| 机制 | 职责 | 章节 |
|------|------|------|
| `ScenarioEvaluator` + `ContextProfile` | Turn 1 分类 + Sticky 升级 + 参数化 | §十 |
| `LayerAssembler` | 组装系统提示 | §五 |
| `WindowManager`（含 Pinning） | 管理历史消息、驱逐 | §六 |
| `TierCompressor` | 多级压缩 tool_result | §七 |
| `TurnDigest` | 系统自动轨迹（零 LLM 成本） | §6.4 |
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
[System]     Identity lean + query + scenario tools    ~250t
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
| `interactive`（默认，含长任务） | 全文注入 | 基础个性化，长任务压缩由驱逐级联（§6.3）自然应对，Layer 内容不变 |
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
| `lookup` | **跳过整个 Layer 2** |
| `autonomous` | 仅任务描述显式涉及的 skills / people（隐私收窄） |

> 注：原 `long-task` 在 Layer 2 追加的任务账本 / 阶段计划引用已迁移到 Layer 3 的 Active Task Hint（条件：存在 pinned task ledger，不依赖 hint）。

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

  return { skills, people }
```

> 原 `long-task` 分支（taskLedgerRef, phasePlanRef）已移除。任务账本 / 阶段计划的引导改由 Layer 3 Active Task Hint 提供，条件为"存在 pinned task ledger"，不再依赖 hint 类型。

### 5.5 Layer 3 · Dynamic（每 Turn 重建，不 cache）

| 成员 | 出现条件 |
|------|---------|
| Workspace Context（cwd / 项目信息） | CLI 模式 + 非 lookup |
| Current time | `profile.timeInContext=true` |
| Turn Digest（面包屑轨迹） | turnCount > 1 时自动注入（§6.4） |
| Active Task Hint（任务进度一行摘要） | 存在 pinned task ledger 时（不依赖 hint） |

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
algorithm buildWindowedHistory(conv, budget, profile, provider):
    # lookup 无预算管理（会话极短），跳过压缩与驱逐
    if profile.name == 'lookup':
        return conv.runtimeMessages except pinned

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

### 6.4 Turn Digest（系统自动轨迹）

**设计动机**：长任务的信息连续性不能依赖 AI 自觉调用 `task.update`——不同模型遵循度差异大，忘调即恶性循环（不更新 → 旧信息驱逐 → 更不知道更新什么）。系统需要一个**零 LLM 成本、自动维护**的信息安全网。

**机制**：每个 Turn 完成后，Agent Loop 从 Turn 元数据**机械提取**摘要：

```typescript
interface TurnDigest {
  turnIndex: number;
  userMessagePreview: string;    // 用户消息前 DIGEST_PREVIEW_CHARS 字符
  toolCalls: string[];           // ["edit(auth.ts)", "bash(npm test)"]
  filesModified: string[];       // 从 tool_result 提取
  outcome: 'success' | 'error' | 'interrupted';
}
```

零 LLM 成本——纯粹从 Turn 的 tool_use / tool_result 消息中机械提取，不需要语义理解。

**注入位置**：Layer 3（Dynamic），每 Turn 重建。格式为紧凑的面包屑轨迹：

```
[轨迹]
T1: "重构auth模块" → read×3 → 定位 auth 文件
T3: "开始重构" → edit(auth.ts,middleware.ts), bash(npm test) → 成功
T5: "处理测试失败" → edit(auth.test.ts), bash(npm test) → 成功
```

**大小控制**：

| 参数 | 默认 | 说明 |
|------|------|------|
| `MAX_DIGEST_COUNT` | 30 | 保留最近 N 条 |
| `DIGEST_PREVIEW_CHARS` | 80 | 用户消息预览长度 |

- 每条 Digest ~20-30 tokens，30 条 ≈ 600-900 tokens
- 超出 `MAX_DIGEST_COUNT` 时，最老的 5 条合并为组摘要（如 "T1-T5: auth 模块重构，5 轮，3 文件修改"）
- 预算紧张时可进一步缩减（只保留最近 10 条 + 已合并组）

**与其他机制的关系**：

| 机制 | 性质 | 成本 | 维护者 |
|------|------|------|--------|
| **Turn Digest** | 基线安全网，永远在 | 零 | 系统（Agent Loop） |
| `task.update` | 可选增强，语义更丰富 | 零（AI 主动调用） | AI |
| `recall_history` | 按需恢复完整 Turn 原文 | 零（读 transcript） | AI |

三者共存、互补：Digest 确保"做了什么"不丢；task.update 提供"进度到哪"的语义；recall_history 恢复完整细节。

**不可被 AI 覆盖或跳过**：Turn Digest 由 Agent Loop 硬性维护，是系统行为而非 AI 行为。

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

| Profile | T1 | T2 | T3 | 说明 |
|---------|----|----|----|------|
| `interactive` | 2 | 8 | 30 | 固定。预算超阈值时由驱逐级联（§6.3）逐级降 Tier |
| `autonomous` | 1 | 3 | 12 | 固定，后台任务上下文极珍贵 |
| `lookup` | — | — | — | 无 tool_result |

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

### 8.3 阈值（Profile 固定）

| Profile | WARNING | COMPACT | CRITICAL | 说明 |
|---------|---------|---------|----------|------|
| `interactive` | 65% | 80% | 90% | 固定。长对话的压力由驱逐级联（§6.3）自然应对 |
| `autonomous` | 40% | 60% | 80% | 固定。后台任务上下文极珍贵，阈值更紧 |
| `lookup` | — | — | — | 无预算管理（会话极短） |

**百分比阈值替代绝对值**：Claude Code 用固定 13K/3K，在 32K 窗口的小模型上几乎占一半空间。百分比天然适配不同窗口大小。

**为什么不用自适应阈值**（ADR-CTX-017）：阈值只在水位真正碰线时才有意义。短对话水位远低于任何阈值（无区别）；长对话无论起点宽松还是紧凑，终究要压缩（终态一样）。驱逐级联（§6.3）已经提供了天然适应——水位低什么都不做，水位高逐步加大压缩力度。阈值本身不需要也跟着动。

### 8.4 端到端示例：压缩是怎么发生的

以 `interactive` Profile、200K 窗口为例（effectiveWindow ≈ 180K）：

```
Turn 1: 用户 "帮我重构 auth 模块"
  水位: ~3K (2%)  →  远低于 WARNING 65%  →  什么都不做
  Tier:  无旧 tool_result  →  TierCompressor 无事可做
  结果:  system(L0+L1+L2+L3) + user message → 原样发给 LLM

Turn 5: 用户 "继续处理测试"（已有多次 read/edit/bash）
  水位: ~25K (14%)  →  远低于 WARNING  →  什么都不做
  Tier:  Turn 1 tool_result 轮距=4 > T1(2) → Tier 2（trim 到 2000 字符）
         Turn 3-4 tool_result 轮距 1-2 ≤ T1(2) → 完整保留
  结果:  旧 tool_result 按轮距自动瘦身，不触发驱逐

Turn 15: 密集编码后
  水位: ~120K (67%)  →  刚超 WARNING 65%  →  日志记录，不做强制动作
  Tier:  Turn 1-5 tool_result 轮距 10-14 > T2(8) → Tier 3（500 字符）
         Turn 6-7 tool_result 轮距 8-9 > T2(8) → Tier 3
         Turn 13-14 tool_result 轮距 1-2 ≤ T1(2) → 完整保留
  结果:  Tier 压缩持续工作，但水位还没碰到 COMPACT 线

Turn 20: 水位碰 COMPACT 线
  水位: ~148K (82%)  →  超 COMPACT 80%  →  ⚡ 触发驱逐级联
  级联执行:
    ① Tier 降级: 把还在 Tier 2 的 tool_result 降为 Tier 3/4  →  腾出 ~8K
       重算: ~140K (78%)  →  仍超 80%?  不，已低于  →  停止 ✓
  结果:  仅靠 Tier 降级就回到安全水位

Turn 25: 又超了
  水位: ~150K (83%)  →  超 COMPACT 80%  →  ⚡ 触发驱逐级联
  级联执行:
    ① Tier 降级: 已经没什么可降了  →  腾出 ~2K  →  仍超
    ② 驱逐最老 Turn: 驱逐 Turn 2-4（pinned Turn 1 不动）  →  腾出 ~15K
       重算: ~133K (74%)  →  低于 80%  →  停止 ✓
  结果:  Tier 不够就驱逐旧 Turn。被驱逐内容在 transcript 完整保留

Turn 35: 极端长对话
  水位: ~165K (92%)  →  超 CRITICAL 90%  →  ⚡ Tier + 驱逐都做完仍超
  级联执行:
    ① ② 均已执行，仍超 CRITICAL
    ③ LLM 摘要兜底: 把 Turn 5-20 压缩为一段结构化摘要（~2K tokens）
       重算: ~100K (56%)  →  回到正常  →  停止 ✓
  结果:  付出一次 LLM 调用代价，换来大量空间
```

**核心逻辑**：阈值是固定的触发线，级联是天然的适应机制。对话越长、内容越多 → 碰线越频繁 → 级联执行越频繁 → 压缩自然越激进。不需要阈值本身也跟着调。

### 8.5 事件系统集成

已实现。预算检查通过 EventBus 发射事件：

| 事件 | 触发时机 |
|------|---------|
| `context:budget_check` | 每次 Turn 预算检查（phase: pre-compact / post-compact） |
| `context:compact_start` | compact 事务开始 |
| `context:compact_end` | compact 事务结束（事务化 payload,见下） |
| `context:calibrate` | 估算器校准 |

#### compact_end 事务化 payload（Phase 4 治理）

一次 compact 等于**一次事务**：`engine.onTurnComplete` 按 priority 依次调 strategies,收集所有 contribution,事务结束 fire **唯一一次** `compact_end`。消费者（run-agent 的 `subscribeCompactAccumulator`）拿到汇总字段：

```typescript
interface CompactEndPayload {
  strategies: StrategyContribution[];   // 本事务内所有贡献的策略列表(name / phase / turnsCompacted? / summary?)
  summary?: string;                      // 汇总 summary = contributions 中最后一个非空 summary
  turnsCompacted?: number;               // 汇总替代的文件 Turn 数 = Σ(contributions.turnsCompacted)
  tokensBefore: number;                  // 事务起点 token 数
  tokensAfter: number;                   // 事务终点 token 数
}
```

**turnsCompacted 精确计算**（`llm-summarize.ts` 内部）：

```typescript
const turnMessages = stripSummaryPlaceholderPair(toSummarize);  // 去掉前次 compact 的 summary pair
const turnNumbers  = calculateMessageTurns(turnMessages);        // 按 user 边界算每条消息的 turn 号
const turnsCompacted = turnNumbers[turnNumbers.length - 1] ?? 0; // 最大 turn 号 = 本次替代的文件 Turn 数
```

`stripSummaryPlaceholderPair` 是关键 —— 保证多次 compact 时老 summary pair 不被重复计算（否则累加会 over-truncate 磁盘 turns）。

#### run-agent 的 L1 累积（compact-accumulator）

一个 run 内可能有多个 compact 触发点（pre-flight / agent-loop 内 / pure-text return / critical force-apply）,每次 fire `compact_end`。`subscribeCompactAccumulator` 在 run 级 eventBus 上累积：

```typescript
// 规则
//   - 只累积含 summary 的事件(非摘要型事务不替代文件 Turn)
//   - turnsCompacted 累加(Σ contributions)
//   - summary 取最新(后一次 LLM 摘要天然包含前一次,因为 toSummarize 含前次 pair)
//   - tokensBefore 锚定首次(事务起点)
//   - tokensAfter 取最新
//   - timestamp 取最新
```

返回 `{getMarker(), dispose()}` —— `getMarker()` 返回 `CompactMarker | undefined`,`dispose()` 移除 bus 订阅。run-agent 从 `RunResult.compactBefore` 向外透传,最终由 `TranscriptStore.commitTurn` 写入磁盘。

> **类型演进**：老 `CompactInfo` 中间类型已废弃；accumulator 直接产出 `CompactMarker`（core 的权威类型,见 [conversation-model.md §9.2](./conversation-model.md) Compact 标记行）。单一事实源（Phase 5 §0.7.1）。

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

### 10.2 Hint 生命周期：一次分类 + Sticky + 单调升级

场景判定不是每 Turn 重新分类，而是 **Turn 1 一次分类，之后 Sticky 持久**。变化只能通过单调升级发生——只升不降，防止上下文降级导致 AI 行为不一致（ADR-CTX-016）。

> **无用户级 `/scenario` 命令**（ADR-CTX-013）。用户不应在"模式"层面思考。模型意图理解能力在快速提升，显式模式切换是过渡期产物。

#### 10.2.1 Hint 权重与单调性铁律

```
lookup (level 0)  <  interactive (level 1)  <  social (level 2)
```

`autonomous` 不参与排序——由业务代码在 Conversation 创建时硬编码，不发生运行时转换。

**铁律：hint 只能向更高 level 转换，不能降级。**

理由：降级意味着移除已注入的上下文（Profile / 记忆 / 工具目录），AI 在前几轮看到这些信息、后几轮突然消失 → 推理链断裂。单调性保证已注入的上下文不会被撤走。

#### 10.2.2 Turn 1：初始分类

| 优先级 | 谁 | 说明 |
|--------|---|------|
| P2 | **业务代码硬编码** | AgentOrchestrator 派生 BackgroundAgent 时写死 `autonomous` |
| P3 | **关键词分类器** | 零 LLM 成本，命中 social / lookup 关键词模式则返回对应 hint |
| 默认 | — | 无命中 → `interactive` |

```typescript
function resolveInitialHint(ctx: {
  hintOverride?: ScenarioHint;
  userMessage: string;
}): ScenarioHint {
  if (ctx.hintOverride) return ctx.hintOverride;
  const keywordClass = classifyByKeywords(ctx.userMessage);
  if (keywordClass === 'social') return 'social';
  if (keywordClass === 'lookup') return 'lookup';
  return 'interactive';
}
```

零 LLM 成本，准确率 80%+ 即可。首轮判错的成本很低：
- `lookup` 漏检 → 多花 ~2000t（Profile 注入），无功能影响
- `social` 漏检 → 少注入记忆，AI 可 `scenario.escalate` 补救

#### 10.2.3 Turn 2+：Sticky + 守卫 + AI 升级

```typescript
function resolveCurrentHint(conv: Conversation, turn: Turn): ScenarioHint {
  const current = conv.currentHint;

  // autonomous 由业务代码创建时硬编码，运行时不可变（§10.2.1）
  if (current === 'autonomous') return current;

  // P1: AI 主动升级（必须满足单调性——只能升，不能降）
  if (turn.agentEscalation
      && hintLevel(turn.agentEscalation) > hintLevel(current)) {
    return settle(conv, turn.agentEscalation);
  }

  // lookup 自动升级守卫（系统级，唯一的自动转换路径）
  if (current === 'lookup') {
    if (turn.prevAgentDidMutation) return settle(conv, 'interactive');
    if (conv.turnCount > 3)        return settle(conv, 'interactive');
  }

  // Sticky：保持当前 hint，不再跑关键词分类
  return current;
}

function settle(conv: Conversation, hint: ScenarioHint): ScenarioHint {
  conv.currentHint = hint;
  return hint;
}

function hintLevel(hint: ScenarioHint): number {
  return { lookup: 0, interactive: 1, social: 2 }[hint] ?? 1;
}
```

**设计要点**：

- **autonomous 运行时不可变**——由业务代码创建时硬编码，resolveCurrentHint 直接 early return，不参与升级排序（§10.2.1）
- **不再每 Turn 跑关键词分类器**——进入 `interactive` 后，分类器 100% 返回 `interactive`，是空转（ADR-CTX-016）
- **AI `scenario.escalate` 受单调性约束**——只能升级（如 `interactive→social`），降级请求被静默忽略
- **lookup 的自动退出是唯一的系统级升级路径**——AI 调了写工具 或 对话超过 3 轮，自动升为 `interactive`
- **escalation 下一 Turn 生效**——AI 在 Turn N 调 `scenario.escalate` 仅记录意图（写入 `turn.agentEscalation`）；Turn N+1 的 `prepareTurn` → `resolveCurrentHint` 才应用新 Profile。理由：Turn N 的 system prompt 已发给 LLM，中途变更 Profile 会导致 system prompt 与实际工具目录 / Layer 内容不一致
- **阈值固定，级联适应**——Profile 的阈值不随对话变化（ADR-CTX-017），长对话的压缩由驱逐级联（§6.3）自然应对

### 10.3 核心类型

```typescript
/** 场景 hint：四个语义场景，驱动 ContextProfile 选择 */
type ScenarioHint = 'lookup' | 'interactive' | 'social' | 'autonomous';
```

### 10.4 ContextProfile 结构

```typescript
interface ContextProfile {
  name: 'interactive' | 'autonomous' | 'lookup';

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

### 10.5 三个内建 Profile

| Profile | includeProfile | layer2Mode | toolCategories | warn / compact / critical | T1/T2/T3 | onExhausted |
|---------|---------------|-----------|---------------|--------------------------|---------|-------------|
| `interactive` | ✓ | basic / enriched（视 hint） | 全部 | 65 / 80 / 90（固定） | 2 / 8 / 30（固定） | error-to-user |
| `autonomous` | ✗ | minimal | 任务声明的 | 40 / 60 / 80（固定） | 1 / 3 / 12（固定） | event-to-parent |
| `lookup` | ✗ | skip | query + scenario | — | — | error-to-user |

> **设计决策**：原 `long-task` 独立 Profile 已合并入 `interactive`。两者 Layer 内容完全一致（都全文注入 Profile），长对话的压缩压力由驱逐级联（§6.3）自然应对——不值得为此维护独立 Profile + 检测逻辑。见 ADR-CTX-015。

> **为什么 lookup 保留 `scenario` 工具类别**：`scenario.escalate` 是控制面工具，AI 必须在任何 profile 下都能主动升级场景。若 lookup 不含 scenario 类别，AI 在误判为 lookup 的对话中既无法调 mutation 工具、也无法自主升级，只能等 `turnCount > 3` 的系统守卫——用户被困在受限模式长达 3 轮。成本极低（仅多暴露一行 description），收益是保持 `scenario.escalate` 升级路径始终可达。

> **autonomous 的 toolCategories 是动态绑定的**：不同于 `interactive` / `lookup` 的固定值，`autonomous` Profile 的 toolCategories 由 `spawnBackground(options.tools)` 在创建时决定（见 conversation-model §10.3）。实现时以 autonomous 基线 Profile 为模板，用任务声明的工具列表覆写 `toolCategories`。详见 Phase P6。

### 10.6 scenarioHint 与 Profile 的映射

```
hint 'interactive' / undefined  →  Profile 'interactive'（layer2Mode=basic）
hint 'social'                   →  Profile 'interactive'（layer2Mode=enriched）
hint 'autonomous'               →  Profile 'autonomous'
hint 'lookup'                   →  Profile 'lookup'
```

`social` 与 `interactive` 共用 Profile 参数，仅 layer2Mode 不同。原 `long-task` 行为由驱逐级联自然覆盖，无需独立映射。

### 10.7 三轴模型（为什么四个场景够用）

所有真实对话落在三条轴上：

| 轴 | 取值 |
|---|------|
| 时间尺度 | 瞬时 / 短时 / 长时 / 常驻 |
| 信息密度 | 极简 / 普通 / 富文本 / 超密集 |
| 持久化需要 | 不用留 / 要留 / 要归档 |

四个内建场景覆盖三轴：

- `lookup`：瞬时 / 极简 / 不用留
- `interactive`：短时→长时（级联自然应对） / 普通 / 要留（默认）
- `social`：短时 / 超密集 / 要留
- `autonomous`：常驻 / 普通 / 要留

原 `long-task` 不再独立——`interactive` 的固定阈值 + 驱逐级联自然覆盖"长时"段。用户和 AI 无需感知模式切换。

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

### 11.3 任务账本（categories: `task-ledger`）— 可选增强

| 工具 | 用途 |
|------|------|
| `task.update(ledger)` | 覆盖式更新任务账本；自动 pin 最新、unpin 旧的 |
| `plan.declare(plan)` | 声明阶段性计划；自动 pin |

> **与 Turn Digest 的关系**：Turn Digest（§6.4）是系统自动维护的基线安全网，零 LLM 成本，永远在。`task.update` / `plan.declare` 是 AI **可选增强**——提供更高质量的语义摘要。即使 AI 从不调用这两个工具，系统仍通过 Turn Digest 维持信息连续性。AI 调用时，效果叠加（Digest 提供轨迹 + Ledger 提供语义）。

### 11.4 场景控制（categories: `scenario`）

| 工具 | 用途 |
|------|------|
| `scenario.escalate(target, reason)` | Agent 主动切换 scenarioHint |

### 11.5 System Prompt 对 AI 的指令（关键摘录）

> 默认上下文包含：用户画像（Profile，若场景允许）、本轮命中的 Skills / People、最近对话消息、pinned 消息、Turn Digest 轨迹。更早对话**不会自动可见**，需要时用 `recall_history` 取回。
>
> **Turn Digest 轨迹**（[轨迹] 段）由系统自动维护，记录了每轮的操作摘要。利用它快速回顾之前做了什么，无需重新读取完整历史。
>
> 重要的长期事实 → 主动调 `journal.remember` / `skill.save` / `person.save`，不依赖上下文窗口。
>
> 遇到人物代称 → 先用 `person.resolve` 解析，不确定时向用户澄清，**禁止自作主张选人**。
>
> 长任务中可选择调 `task.update` 刷新账本，提供比 Turn Digest 更丰富的语义进度。系统不强制要求。

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
    /** LLM provider，CRITICAL 兜底摘要（§九）时使用；正常路径不触发 LLM */
    provider: ModelProvider;
    /** 业务代码硬编码的 hint（如 AgentOrchestrator 写死 autonomous），对应 §10.2.2 P2 */
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

**为什么两个方法都显式接收 `provider`**：ContextEngine 是无状态接口（不在构造器注入 provider），CLI 和 Server 的调用者各自持有 provider 实例。`prepareTurn` 99% 场景不触发 LLM（铁律 1），但 CRITICAL 兜底时需要——required 参数确保兜底路径永远可用，不会因 provider 缺失静默降级。`compactExplicit` 由 `/compact` 命令独立触发，调用者同样显式传入。

CLI `run-agent.ts` 和 Server `session/*` 都只调这几个方法。引擎不知道跑在哪个进程里。

### 12.2 允许的数据差异

| 字段 | CLI | Server |
|------|-----|--------|
| `conversation.workspace?.cwd` | 通常有 | 通常无 |
| `conversation.channel` | `"cli"` | `"dingtalk" / "feishu" / ...` |
| `conversation.ephemeral` | `-p` 模式 true，REPL false | lookup 场景 true（见 conversation-model §3.7） |

这些影响 Layer 3 / Ephemeral 行为，**引擎算法不分支**。

---

## 十三、Ephemeral Conversation

临时对话的完整生命周期（何时创建、何时升级、CLI vs Server 差异）由 [conversation-model.md §3.7](./conversation-model.md) 统一定义。本节仅说明上下文引擎的相关行为。

**上下文引擎视角**：

| 状态 | 行为 |
|------|------|
| `ephemeral=true` | `prepareTurn` 正常工作（所有机制照常运行），但 TranscriptStore 不写入；不进 conversation list |
| `ephemeral=false`（默认） | append-only 到 transcript.jsonl |

**与场景参数化的关系**：

- 临时对话通常对应 `hint=lookup`（由 ScenarioEvaluator 判定）
- 升级触发（如 `scenario.escalate`、第二轮 Turn、有副作用工具）同时将 ephemeral 转为持久化
- 升级后 hint 可能从 `lookup` 单调升级为 `interactive`（§10.2.3 守卫规则）
- 升级时内存中的 messages 一次性 flush 到新的 transcript.jsonl

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
| `ephemeralAutoPersistAfterNTurns` | 2 | ephemeral 自动落盘阈值（第二轮 Turn 即升级，见 conversation-model §3.7） |
| `MAX_DIGEST_COUNT` | 30 | Turn Digest 保留条数（§6.4） |
| `DIGEST_PREVIEW_CHARS` | 80 | Turn Digest 用户消息预览长度 |

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
  turn-digest.ts                  # §6.4 Turn Digest 系统自动轨迹
  scenario/
    profile.ts                    # §10.5 三个内建 Profile（固定参数）
    hint-evaluator.ts             # §10.2 Turn 1 分类 + Sticky 升级
  tools/
    recall-history.ts             # §11.2
    task-update.ts                # §11.3
    plan-declare.ts               # §11.3
    scenario-escalate.ts          # §11.4
```

### 17.3 其他模块的 schema 变更

| 模块 | 新增字段 |
|------|---------|
| conversation-model | `pinnedMessageIds` / `currentHint` / `ephemeral`（见 conversation-model §3.1） |
| memory-system (profile.md) | 结构化 `relations` 段 |
| memory-system (journal) | 条目新增 `about_person?: string[]` |
| skills-evolution | triggers 升级为多维（keywords / relations / scenarios / emotions） |
| tools-builtin | 所有工具新增 `categories: ToolCategory[]` |

### 17.4 迁移阶段

| Phase | 内容 | 风险 |
|-------|------|-----|
| P1 | TierCompressor（四级替代单级 trim）+ WindowManager + PinManager + **TurnDigest** | 中 |
| P2 | 重写 engine.ts 为 prepareTurn 入口；引入 `interactive` Profile（固定阈值） | 中 |
| P3 | recall_history 工具 + /compact 命令（双模式 LLM 压缩） | 低 |
| P4 | hint evaluator + `lookup` profile + ephemeral | 中 |
| P5 | 社交扩展（relations / resolve / journal.about / 多维 triggers） | 中，依赖 memory 升级 |
| P6 | `autonomous` profile + context_exhausted + task.update / plan.declare（可选增强） | 中，依赖 AgentOrchestrator |

---

## 十八、未决议题

### 参数调优

- [ ] Tier 轮距阈值（2/8/30 为初始值，需实测后调整）
- [ ] warning/compact/critical 比例在不同模型窗口下的表现
- [ ] hint 启发式关键词表
- [ ] Turn Digest 的 MAX_DIGEST_COUNT 最优值（30 条 vs 更多/更少）

### 机制细节

- [ ] **Tool JIT**：默认只在 Tool Catalog 放一行 description、使用时临时注入完整 schema 的方案。依赖各 provider 对"动态 tools 字段"的支持程度，需调研后决定是否引入
- [ ] Layer 2 预加载超出预算时的优先级（目标人物 > social skill > journal？）
- [ ] Prompt cache boundary 的精确切位
- [ ] `person.resolve` 置信度算法

### AI 行为

- [ ] System prompt 记忆引导的最终措辞（需实测不同模型遵循度）
- [ ] 小模型下的降级策略

### 用户可见性

- [ ] `/status` 展示当前 hint / profile / budget / Turn Digest
- [ ] `/pin` / `/unpin` 手动 pin 管理
- ~~`/scenario <hint>` 用户主动切换~~ → 已决策移除（ADR-CTX-013）

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

**决策**：Profile 在 `interactive`（含 `social`）下全文进 Layer 1；在 `lookup` / `autonomous` 下跳过。Skills / People 以"触发命中则全文注入"处理。**不使用单行 pointer 或极简摘要**。（v1.1 更新：原 `long-task` 已合并入 `interactive`，Layer 1 行为不变。）

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

### ~~ADR-CTX-010：scenarioHint 启发式重评，零 LLM 成本~~ → **已被 ADR-CTX-016 取代**

~~**决策**：scenarioHint 每 Turn 由关键词分类器重算；Agent 可 `scenario.escalate` 主动切换。~~

**现决策（v1.2）**：Turn 1 一次分类 + Sticky + 单调升级。取消每 Turn 重新分类。详见 ADR-CTX-016。

**保留的部分**：零 LLM 成本原则不变；Agent `scenario.escalate` 主动权保留（受单调性约束）。

---

### ADR-CTX-011：Ephemeral Conversation

**决策**：`ephemeral=true` 时仅内存中存在，不写 transcript；多种条件可触发升级为持久化。完整生命周期（生效范围 + 升级条件）见 [conversation-model.md §3.7](./conversation-model.md) + ADR-CM-013。

**理由**：单次查询没有长期保留价值；强制持久化污染 transcript 噪音。

---

### ADR-CTX-012：不引入向量索引

**决策**：短期内不引入向量数据库做记忆检索，保持关键词 + trigger 匹配。

**理由**：个人助手规模（Skills <100, People <50）下关键词足够；向量索引引入 embedding 依赖，违反铁律 4。未来规模上去了可作为 Retriever 可选后端。

---

### ADR-CTX-013：不暴露用户级场景切换

**决策**：移除 `/scenario` 用户命令。场景判定完全由系统启发式 + AI `scenario.escalate` 驱动。用户无需感知"模式"概念。

**理由**：

1. **产品直觉**：用户不应在"模式"层面思考——"帮我分析小王最近为什么冷淡"自然触发 social 增强，无需先说 `/scenario social`。最好的个人助手是用户**意识不到背后在做什么**
2. **行业趋势**：模型意图理解能力在快速提升，显式模式切换是过渡期产物。Claude Code、Cursor、Copilot 均不暴露场景切换
3. **错误成本低**：首轮 `lookup` 误判 → 自动守卫升级为 `interactive`；首轮漏检 → 走默认 `interactive`（安全）。AI `scenario.escalate` 可单调升级补救
4. **AI 比用户更适合判断**：AI 全程在对话中，比用户更接近上下文。用户说"看看这段代码"时未必意识到这是 interactive 场景，但 AI 可以判断

保留 `scenario.escalate` 作为 AI 工具——受单调性约束（只升不降，ADR-CTX-016），是系统的"升级阀门"，不是用户功能。

---

### ADR-CTX-014：Turn Digest 系统自动轨迹

**决策**：每 Turn 完成后，Agent Loop 从元数据机械提取摘要（TurnDigest），注入 Layer 3 作为信息连续性的基线安全网。`task.update` / `plan.declare` 降级为可选增强。

**理由**：

1. **AI 自觉性不可靠**：不同模型对"长任务完成里程碑时调 task.update"的遵循度差异大。依赖 AI 自觉 → 恶性循环（不更新 → 旧信息驱逐 → 更不知道更新什么）
2. **零 LLM 成本**：纯机械提取（用户消息前 N 字符 + tool_use 列表 + 修改文件 + 结果），符合铁律 1
3. **系统保证 > AI 承诺**：Turn Digest 由 Agent Loop 硬性维护，不受 AI 行为影响，是系统级保证
4. **层次分明**：Digest 是轨迹（做了什么）→ task.update 是语义（进度到哪）→ recall_history 是细节（完整原文）。三层各司其职、互补叠加
5. **成本极低**：30 条 Digest ≈ 600-900 tokens，在 200K 窗口中 <0.5%

---

### ADR-CTX-015：合并 long-task 到 interactive

**决策**：移除 `long-task` 独立 Profile。内建 Profile 从 4 个减为 3 个（interactive / autonomous / lookup）。长对话的压缩压力由驱逐级联（§6.3）自然应对，不需要独立的参数集。

**理由**：

1. **Layer 内容完全一致**：`interactive` 和 `long-task` 都全文注入 Profile、同样的 Layer 2 逻辑。差异仅在压缩参数——不值得为此维护独立 Profile
2. **检测难题消失**：离散模式切换需要回答"何时算长任务？"——Turn 数？Tool 调用数？用户意图？去掉独立 Profile 后，这个问题不存在了
3. **无重复注入**：无模式切换 → 无 Layer 内容重复计算/注入
4. **级联天然适应**：对话越长 → 碰线越频繁 → 级联执行越频繁 → 压缩自然越激进。不需要阈值本身也跟着变
5. **`autonomous` 和 `lookup` 仍需独立**：它们与 `interactive` 的差异是本质性的（Layer 内容不同、工具集不同、持久化策略不同）

---

### ADR-CTX-016：Hint 一次分类 + Sticky + 单调升级

**决策**：场景 hint 在 Turn 1 由关键词分类器确定，之后 Sticky 持久（存储在 `Conversation.currentHint`）。运行时转换只能单调升级（`lookup→interactive→social`），不能降级。取消每 Turn 重新分类。

**理由**：

1. **每 Turn 分类是空转**：一旦进入 `interactive`（默认，80%+ 对话），后续每轮关键词分类器 100% 返回 `interactive`——Turn 2+ 的分类没有信息增量
2. **降级导致上下文不一致**：AI 在前几轮看到 Profile / 记忆 / 工具目录，后几轮突然消失（降为 `lookup`）→ 推理链断裂。单调性保证已注入的上下文不会被撤走
3. **职责分离**：场景分类是一次性决策（`resolveInitialHint`），压缩适应靠驱逐级联（§6.3）——两个不同的机制，不混淆
4. **误判容错**：首轮 `lookup` 误判 → 自动守卫升级；首轮 `social` 误判 → 多注入记忆（无害）。只有正确判为 `lookup` 能节省 ~2000t，其他误判代价极低

---

### ADR-CTX-017：固定阈值 + 驱逐级联，不做自适应阈值

**决策**：`interactive` Profile 的预算阈值（65/80/90）和 Tier 阈值（2/8/30）均为固定值。不随对话深度或工具密度动态调整。长对话的压缩压力由驱逐级联（§6.3）自然应对。

**理由**：

1. **短对话阈值无意义**：Turn 1-5 水位通常 <20%，无论阈值是 60% 还是 80% 都不触发——调了白调
2. **长对话终态一样**：无论从 80% 还是 70% 开始压缩，长对话最终都会频繁碰线、频繁级联——行为收敛
3. **级联已是天然适应机制**：水位低 → 不触发 → 零动作；水位高 → 频繁触发 → 自动加大压缩力度。这就是适应，不需要阈值本身也跟着动
4. **消除概念复杂度**：`lerp`、双轴因子、饱和曲线——这些概念增加理解和实现成本，但实际收益仅限于"小窗口 + 中等长度对话"的窄边缘场景
5. **Tier 压缩本身就是渐进的**：固定 T1=2 / T2=8 / T3=30 意味着旧 tool_result 按轮距自然衰减——Turn 1 的 tool_result 到 Turn 10 时已被 trim 到 2000 字符，到 Turn 40 时只剩骨架。这是基于时间的天然衰减，不需要额外调参
