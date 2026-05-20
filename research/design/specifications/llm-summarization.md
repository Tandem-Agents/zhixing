# LLM 摘要压缩方案

> **本文档定位**：知行 **LLM 主对话压缩**（`LLMSummarizeStrategy`）的设计权威。覆盖主会话 7 段模板 / sub-agent 5 段模板 / 校验与重试 / 续写机制 / CircuitBreaker。当前实现位于 [`packages/core/src/context/prompts.ts`](../../packages/core/src/context/prompts.ts) + [`validation.ts`](../../packages/core/src/context/validation.ts) + [`strategies/llm-summarize.ts`](../../packages/core/src/context/strategies/llm-summarize.ts)，与本文同源。
>
> **相关但独立的机制**（不属于本文范围）：
>
> - **段切换摘要**（`createSegmentSummarizeFn`，facts / state / active 三段结构）—— work-mode / context-management v3 的"缓存安全分叉"专用机制，独立 prompt + 独立代码路径，详见 [context-management-v3-redesign.md](./context-management-v3-redesign.md) §5
> - **记忆提取**（`MemoryFlushStrategy`，JSON 提取写盘）—— 见 [memory-system.md](./memory-system.md)
>
> **历史路径已废弃**：本文最初锚定的 "L3" 三级 Tier 压缩模型已整体砍除。LLMSummarize 现在是独立 strategy（priority 200 / usage ≥ 0.9 触发），不再是"L3 兜底层"。
>
> **角色归属**：LLMSummarize 走 `roles.main`（摘要质量直接关系到下一轮 LLM 的认知输入），由 [`createSummarizeCallLLM`](../../packages/orchestrator/src/runtime/compaction-llm.ts) 承载，详见 [secondary-llm-capability.md](./secondary-llm-capability.md) ADR-SLLM-009。

## 一、竞品摘要模板对比

### 1.1 OpenClaw：5 段结构化摘要

| 章节 | 内容 | 质检 |
|------|------|------|
| Decisions | 已做的决策 | ✅ 必需 |
| Open TODOs | 未完成事项 | ✅ 必需 |
| Constraints/Rules | 约束和规则 | ✅ 必需 |
| Pending user asks | 未回答的用户追问 | ✅ 必需 |
| Exact identifiers | UUID/hash/路径等 | ✅ 必需（strict 模式） |

**优点：** 结构简洁；有 `auditSummaryQuality` 做必需章节 + 标识符 + 用户追问反映度的三重校验；不通过时自动追加修正指令重试。

**不足：** 缺少「文件与代码」追踪（恢复后不知道碰了哪些文件）；缺少「当前进度」（不知道压缩前在做什么）；摘要生成的核心 prompt 在闭源 `pi-coding-agent` 包内，不可定制。

### 1.2 Claude Code：9 段全量档案

| # | 章节 | 侧重 |
|---|------|------|
| 1 | Primary Request and Intent | 用户意图 |
| 2 | Key Technical Concepts | 技术栈/框架 |
| 3 | Files and Code Sections | 文件 + 完整代码片段 |
| 4 | Errors and Fixes | 错误与修复 |
| 5 | Problem Solving | 问题排查 |
| 6 | All User Messages | 所有用户消息原文 |
| 7 | Pending Tasks | 待办事项 |
| 8 | Current Work | 压缩前正在做的事 |
| 9 | Optional Next Step | 下一步建议 |

**优点：** 信息全面；§6「所有用户消息」能防止任务漂移；§8/9 保障压缩后无缝续航；复用同一 system prompt 最大化 prompt cache 命中。

**不足：** 9 段过于冗余——§2 与 §3 高度重叠（技术概念 vs 文件代码），§4 与 §5 可合并（错误修复 vs 问题排查），§6 列出**所有**用户消息原文在长对话中极其浪费 token；要求先输出 `<analysis>` 再输出 `<summary>`，双重输出增加摘要 token 消耗。

### 1.3 Sub-agent 变体

| 产品 | 段数 | 特点 |
|------|------|------|
| OpenClaw | 与主会话相同 | 无区分 |
| Claude Code | 5 段 | Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve |

Claude Code 的 sub-agent 5 段更面向「任务恢复」而非「全量档案」，比主会话模板更实用。

## 二、知行摘要模板设计（7 段）

### 2.1 设计原则

1. **信息密度优先**：合并竞品中的冗余章节，7 段覆盖 9 段的全部信息
2. **决策追溯**：除"做了什么"还要保留"为什么这样做"，避免压缩后下一轮 LLM 失去决策依据
3. **CJK 一等公民**：中文对话用中文摘要（继承 OpenClaw 的语言跟随策略）
4. **进度三态**：用 `[完成] / [进行中] / [阻塞]` 显式三态替代散落表述，进入"进行中"必含具体步骤（吸取 opencode Progress 精华）
5. **可校验**：必需章节标题检查（继承 OpenClaw 的 audit 思路）
6. **缓存友好**：摘要指令作为末尾 user 消息追加，不更换 system prompt

### 2.2 七段结构

```markdown
## 核心目标
用户的明确请求、成功标准；标注优先级变化和关键修正。
（替代 Claude Code 的「所有用户消息」段——只保留影响方向的消息，不逐条列原文）

## 约束与偏好
用户明确表达的工作约束、技术栈偏好、沟通风格；若无显式表达则写"未观察到"。
（吸取 opencode Constraints & Preferences 精华，独立成段以确保不被冲淡）

## 进度
- [完成] 已收尾的事项（简洁列出）
- [进行中] 当前正在做但未完成的事项（必须含到哪一步、具体文件名/代码/步骤）
- [阻塞] 等待外部依赖或用户决策的事项及阻塞原因；若无则省略本子项

（三态化吸取 opencode Progress 精华；"进行中"是恢复工作的最关键信息）

## 关键决策
做了什么决策 + 理由 + 排除的其他选项；无决策则写"未观察到"。
（吸取 opencode Key Decisions 精华——"为什么"和"否决了什么"一样重要）

## 下一步
尚未开始的待办，标注 [ ] 待做 / [~] 进行中；按优先级排序。

## 关键上下文
接口签名、关键代码片段、不变量、UUID/hash/路径/URL 等技术锚点，原样保留。
（合并旧版"技术上下文"+"关键标识符"两段——本质都是"恢复语境必需的精确锚点"）

## 相关文件
文件列表，标注 [读][改][建][删]；最近修改的附简短代码片段。
（知行特色，保留 OpenClaw 完全缺失但 Claude Code §3 有的文件追踪维度）
```

### 2.3 7 段对照来源

| 知行章节 | 主要来源 | 演化理由 |
|---|---|---|
| 核心目标 | Claude §1 + §6 精华 | §6 逐条列所有用户消息太浪费,只保留影响方向的 |
| **约束与偏好** | **opencode Constraints & Preferences** | 独立成段确保用户工作约束不被冲淡(早期版本没有此段,实测约束信息容易丢失) |
| **进度（三态）** | **opencode Progress + Claude §8** | 三态化 `[完成]/[进行中]/[阻塞]` 替代散落表述;"进行中"含具体步骤是续航关键 |
| **关键决策** | **opencode Key Decisions** | 独立成段记录"决策 + 理由 + 排除选项",压缩后下一轮 LLM 仍可追溯决策依据 |
| 下一步 | Claude §7 + OC §2 + §4 | 合并 OpenClaw 的 TODOs + Pending asks |
| 关键上下文 | OC §5 + Claude §2 合并 | "技术上下文"+"关键标识符"本质都是恢复语境必需的精确锚点,合并去冗余 |
| 相关文件 | Claude §3 | OpenClaw 完全缺失,保留 `[读][改][建][删]` 知行特色标注 |

**与早期版本变化**:吸取 opencode 三大精华(Constraints & Preferences / Key Decisions / Progress 三态化),合并冗余段(技术上下文 + 关键标识符 → 关键上下文);章节总数仍为 7,prompt cache 命中率不变。

### 2.4 无需 `<analysis>` 预分析

Claude Code 要求先输出 `<analysis>` 做时间线分析再输出 `<summary>`。这是双重开销——分析段本身可能占摘要 50% 的 token，最后还会被丢弃。

知行方案：**直接输出 7 段结构**，不要求预分析。7 段本身已经涵盖了时间线（核心目标的优先级变化、关键决策的理由链、进度三态的演进），额外的分析步骤是冗余。

## 三、Prompt 工程

### 3.1 系统提示（复用主会话 system prompt）

不更换 system prompt，**追加 user 消息**作为摘要指令。

理由：与 Claude Code 相同——最大化 prompt cache 命中率。更换 system prompt 会导致所有 cached prefix 失效。

### 3.2 摘要指令（末尾追加的 user 消息）

权威实现见 [`packages/core/src/context/prompts.ts`](../../packages/core/src/context/prompts.ts) `MAIN_SESSION_PROMPT`：

```text
你是一个精确的对话摘要助手。请根据以上对话历史，生成结构化摘要。

要求：
1. 用对话的主要语言写摘要正文
2. 保持以下 7 个章节标题不变，按顺序输出
3. 不翻译、不修改代码、文件路径、标识符、错误信息
4. 聚焦事实：讨论了什么、做了什么决策、当前状态
5. 最近的对话内容比更早的内容更重要
6. 「进度」章节的"进行中"必须包含压缩前最后在做的事情的具体细节
7. 「关键上下文」中所有标识符原样保留，不缩写

章节结构：

## 核心目标
[用户的明确请求、成功标准；标注优先级变化和关键修正]

## 约束与偏好
[用户明确表达的工作约束、技术栈偏好、沟通风格；若无显式表达则写"未观察到"]

## 进度
- [完成] 已收尾的事项（简洁列出）
- [进行中] 当前正在做但未完成的事项（必须含到哪一步、具体文件名/代码/步骤）
- [阻塞] 等待外部依赖或用户决策的事项及阻塞原因；若无则省略本子项

## 关键决策
[做了什么决策 + 理由 + 排除的其他选项；无决策则写"未观察到"]

## 下一步
[尚未开始的待办，标注 [ ] 待做 / [~] 进行中；按优先级排序]

## 关键上下文
[接口签名、关键代码片段、不变量、UUID/hash/路径/URL 等技术锚点，原样保留]

## 相关文件
[文件列表，标注 [读][改][建][删]；最近修改的附简短代码片段]

重要：只输出摘要文本，不要调用任何工具，不要输出其他内容。
```

### 3.3 自定义追加指令（/compact 扩展）

支持用户通过 `/compact <指令>` 追加自定义聚焦点：

```text
[用户的额外聚焦指令]
请在摘要中特别关注以上指令提到的内容。
```

追加在摘要指令末尾，限制最大 800 字符（与 OpenClaw 一致）。

### 3.4 合并摘要指令（多段摘要合并时使用,见 §六）

当对话过长需要分块摘要再合并时：

```text
将以下多段摘要合并为一份统一摘要，使用相同的 7 段结构。

合并要求：
- 保留所有活跃任务及其状态
- 保留批量操作的进度（如 "5/17 项已完成"）
- 保留用户最后的请求和正在做的事
- 保留所有决策及其理由
- 优先保留近期上下文，远期细节可精简
- 所有标识符原样保留
```

## 四、质量校验

### 4.1 必需章节检查

权威实现见 [`packages/core/src/context/validation.ts`](../../packages/core/src/context/validation.ts)：

```typescript
export const REQUIRED_MAIN_SECTIONS = [
  "## 核心目标",
  "## 约束与偏好",
  "## 进度",
  "## 关键决策",
  "## 下一步",
  "## 关键上下文",
  "## 相关文件",
] as const;

export const REQUIRED_SUB_SECTIONS = [
  "## 任务概述",
  "## 当前状态",
  "## 关键发现",
  "## 下一步",
  "## 保留上下文",
] as const;

export function validateSummary(
  summary: string,
  template: "main-session" | "sub-agent" = "main-session",
): { valid: boolean; missing: string[] } {
  const sections =
    template === "main-session" ? REQUIRED_MAIN_SECTIONS : REQUIRED_SUB_SECTIONS;
  const lines = new Set(summary.split("\n").map((l) => l.trim()));
  const missing = sections.filter((section) => !lines.has(section));
  return { valid: missing.length === 0, missing: [...missing] };
}
```

### 4.2 校验失败重试

校验不通过时，追加修正指令重新请求（最多 1 次重试）：

```text
摘要缺少以下必需章节：{missing_sections}
请补充缺失的章节，保持其余内容不变。
```

**为什么只重试 1 次**：
- OpenClaw 允许多次重试，但实践中大部分质量问题在首次重试后就能修复
- 多次重试的 token 成本不成比例
- 如果 2 次都不通过，说明模型能力不足以完成此任务，继续重试无意义

### 4.3 不做 identifier 严格校验

OpenClaw 的 strict identifier 检查（验证每个 UUID 是否在摘要中出现）在实践中过于严格：
- 需要先提取对话中的所有标识符（本身是个复杂任务）
- 某些标识符可能在对话后期已经不再相关
- 校验失败导致的重试成本较高

知行方案：**在 prompt 中强调保留标识符，但不做逐一校验**。如果用户反馈标识符丢失，再考虑加严校验。

## 五、压缩后续写（Continuation）

### 5.1 system-meta `<compact-summary>` + ack pair

当前实现：压缩完成后由 [`buildCompactSummaryPair`](../../packages/core/src/context/system-meta.ts) 构造一对消息插在压缩位:

- **user 消息**:`<system-meta kind="compact-summary">` 标签包裹摘要正文
- **assistant 消息**:`<system-meta kind="ack">` 标签的简短确认(pair 语义,避免单条 user 消息打破 turn 配对)

LLM 通过 system-meta 标签明确"这是机制插入的元消息"而非用户原话,不当自己原话回应。pair 语义同时保证下游 split / pair-aware 算法不被破坏(早期"单条 system 消息"设计会让 turn 切分异常,已废弃)。

历史路径上 `buildContinuationMessage / buildManualCompactMessage` 字符串模板形态已被删除 —— 所有 compact 占位统一由 `buildCompactSummaryPair` 构造 Message pair,避免两套格式并存导致 LLM 理解分裂。

### 5.2 不做 Rehydration

Claude Code 压缩后重新注入最近读过的 5 个文件（~50K token）。

知行方案：**不做 rehydration**。

理由：
1. 50K token 的文件重注入会大幅抵消压缩节省的空间
2. 摘要的「相关文件」段已包含关键代码片段
3. LLM 需要文件内容时可以自己调用 Read 工具
4. 这是一个优化点，不是基础功能——留给未来按真实回归数据再评估

### 5.3 Auto-compact vs /compact 的同源

**当前实现两者完全同源**:都走 `forceCompact` / `engine.onTurnComplete` → 同一份 `strategies` → 同一个 `createSummarizeCallLLM` → 同一份 `MAIN_SESSION_PROMPT`。

- 自动触发(LLMSummarize canApply usage ≥ 0.9 + 文件 turn ≥ minTurns)
- 手动触发(`/compact` 命令)

两条触发路径产生**结构完全一致的摘要**(同 prompt + 同 model + 同 marker pair 机制),区别只在触发时机。早期设计的"auto/manual 不同续写指令"路径已废弃 —— pair 机制下 LLM 通过 system-meta 标签理解上下文不需要 prompt 层区分。

## 六、分块摘要策略（未来工作）

> **现状未实现**:本节为设计探索;当前 LLMSummarize 走单次摘要 + 重试一次的简化路径。`MERGE_SUMMARIES_PROMPT` 已在 `prompts.ts` 预留(供未来分块合并使用),但 strategy 内部尚未分块,触发条件依赖 `preserveRecentTurns` + `triggerRatio` 控制规模。

### 6.1 单次 vs 分块

```
if estimatedTokens(messages) <= MAX_SINGLE_SUMMARY_TOKENS:
    单次摘要
else:
    按 token 数均分为 N 块（N = ceil(total / MAX_SINGLE_SUMMARY_TOKENS)）
    每块独立摘要
    合并所有块摘要为一份最终摘要
```

`MAX_SINGLE_SUMMARY_TOKENS`：模型上下文窗口的 60%（留 40% 给摘要输出 + 系统 prompt）。

### 6.2 分块边界

按完整 turn（user + assistant 对）切分，不在 turn 中间切断。

### 6.3 合并流程

```
块1 摘要 ─┐
块2 摘要 ─┼─→ 合并指令（MERGE_SUMMARIES_PROMPT） → 最终 7 段摘要
块3 摘要 ─┘
```

合并摘要也经过必需章节校验。

### 6.4 实施触发条件

接入条件:观察到 LLMSummarize 因单次输入过大被 provider 拒绝(context window 超限)成为高频回归,而非提前实施。当前 main 模型 context window 普遍 ≥ 128K,单次摘要在 90% 触发阈值下输入很少超 100K,**分块在实测出现真实压力前不实施** —— 避免引入未被验证的复杂度。

## 七、CircuitBreaker 集成

```typescript
const summarizationBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
  halfOpenMaxAttempts: 1,
});

async function summarizeWithBreaker(
  messages: Message[],
  callLLM: CallLLMFn,
): Promise<CompactionResult> {
  return summarizationBreaker.execute(async () => {
    const summary = await generateSummary(messages, callLLM);
    const validation = validateSummary(summary);
    if (!validation.valid) {
      // 重试一次
      const retried = await retrySummary(summary, validation.missing, callLLM);
      const revalidation = validateSummary(retried);
      if (!revalidation.valid) {
        throw new Error(`Summary validation failed: ${revalidation.missing.join(', ')}`);
      }
      return buildCompactionResult(messages, retried);
    }
    return buildCompactionResult(messages, summary);
  });
}
```

熔断后降级策略：跳过 LLMSummarize,由其他 strategy(MessageDrop 等免费策略)兜底压缩。对话可继续但无主对话摘要 —— 这比完全无法对话要好。当 ContextEngine 在 critical 硬挡仍无法压到 non-critical 时(force-apply 也救不了),输出 `ContextManagerOutput.failed=true`,由 agent-loop / run-agent 闭环成 error 而非硬送 provider。

## 八、Sub-agent 摘要变体

### 8.1 5 段结构

Sub-agent 的摘要模板更面向任务恢复，不需要完整的档案级记录：

```markdown
## 任务概述
核心请求、成功标准、约束条件。

## 当前状态
已完成的内容、创建/修改的文件与路径、关键产出。

## 关键发现
约束、决策及理由、遇到的错误及处理、试过但无效的做法。

## 下一步
待办事项、阻塞因素、优先级。

## 保留上下文
用户偏好、领域细节、标识符。
```

### 8.2 实现

Sub-agent 场景下替换主会话的 7 段模板为 5 段模板，通过 `SummarizationTemplate` 配置：

```typescript
type SummarizationTemplate = 'main-session' | 'sub-agent';

function getSummarizationPrompt(template: SummarizationTemplate): string {
  switch (template) {
    case 'main-session': return MAIN_SESSION_PROMPT;   // 7 段
    case 'sub-agent': return SUB_AGENT_PROMPT;         // 5 段
  }
}
```

## 九、文件结构

```
packages/core/src/context/strategies/
  llm-summarize.ts         ← LLMSummarize strategy 核心实现
  llm-summarize.test.ts    ← 测试

packages/core/src/context/
  prompts.ts               ← 摘要 prompt 模板(7 段 main + 5 段 sub-agent + 合并指令)
  validation.ts            ← 章节校验逻辑(REQUIRED_MAIN_SECTIONS / REQUIRED_SUB_SECTIONS)
  system-meta.ts           ← buildCompactSummaryPair (<system-meta kind="compact-summary"> + ack pair)

packages/orchestrator/src/runtime/
  compaction-llm.ts        ← createSummarizeCallLLM(roles.main) + createMemoryFlushCallLLM(roles.light)
```

## 十、设计原则

1. **7 段 > 9 段**：合并冗余,信息密度更高,摘要 token 更少
2. **吸取 opencode 三大精华**:Constraints & Preferences 独立成段 / Key Decisions 含理由 + 排除选项 / Progress 三态化(`[完成]/[进行中]/[阻塞]`)
3. **决策追溯优先**:除"做了什么"还要保留"为什么这样做",避免压缩后下一轮 LLM 失去决策依据
4. **无分析段**:不要求 `<analysis>` 预分析,直接输出结构化摘要
5. **语言跟随**:中文对话用中文摘要,英文对话用英文摘要
6. **校验但不严苛**:检查章节标题,不逐一验证标识符
7. **单次重试**:不做多轮修正 —— 2 次不过就降级,由 strategy 链兜底
8. **走 main 不走 light**:摘要质量直接关系下一轮 LLM 认知输入,角色分流见 [secondary-llm-capability ADR-SLLM-009](./secondary-llm-capability.md)
9. **auto/manual 同源**:`/compact` 与自动触发完全同一份 strategies + helper + prompt,不再有 prompt 层差异
10. **system-meta pair 续写**:压缩占位由 `<system-meta kind="compact-summary"> + ack` Message pair 承载,字符串模板形态已废弃
