# L3 LLM 摘要压缩方案

> **状态**: 📐 方案设计（2026-04-09）
> **前置**: context-architecture.md 已设计；CircuitBreaker 已实现
> **关联**: context-architecture.md §九 LLM 压缩、phase2-complete-agent.md Phase 2D-3

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
2. **CJK 一等公民**：中文对话用中文摘要（继承 OpenClaw 的语言跟随策略）
3. **续航优先**：§6/7 确保压缩后 LLM 知道"刚才在做什么、接下来做什么"
4. **可校验**：必需章节标题检查（继承 OpenClaw 的 audit 思路）
5. **缓存友好**：摘要指令作为末尾 user 消息追加，不更换 system prompt

### 2.2 七段结构

```markdown
## 核心目标
用户最终想达成什么。逐条列出明确请求，标注优先级变化。
包含用户的关键修正和偏好变化（替代 Claude Code 的「所有用户消息」段——
只保留影响方向的消息，不逐条列原文）。

## 技术上下文
技术栈、架构决策、约束条件、关键概念。
合并 Claude Code 的 §2（Key Technical Concepts）和 OpenClaw 的 §3（Constraints/Rules）。

## 文件与变更
读取、修改、创建的文件列表。
对最近修改的文件附带关键代码片段（完整函数签名或核心逻辑）。
每个文件标注操作类型：[读] [改] [建] [删]

## 已解决与未解决
已解决的问题及其方案。
遇到的错误、用户反馈导致的方向修正。
仍在排查的问题。
合并 Claude Code 的 §4（Errors）和 §5（Problem Solving）。

## 待办清单
被用户明确要求但尚未完成的任务。
每项标注状态：[ ] 待做 / [~] 进行中 / [x] 已完成但未确认

## 当前进度
压缩请求之前正在做什么。
包含具体的文件名、代码片段、执行到哪一步。
这是恢复工作的最关键信息。

## 关键标识符
UUID、hash、文件路径、API key、URL、端口号等。
原样保留，不缩写、不重构。
```

### 2.3 为什么是 7 段而非 5 或 9

| 合并/拆分 | 来源 | 理由 |
|-----------|------|------|
| §1 核心目标 ← Claude §1 + §6 精华 | 用户意图 + 关键修正 | §6 逐条列所有消息太浪费，只保留影响方向的 |
| §2 技术上下文 ← Claude §2 + OC §3 | 概念 + 约束 | 本质上同一类信息 |
| §3 文件与变更 ← Claude §3 | 文件追踪 | OpenClaw 完全缺失此维度，必须保留 |
| §4 已解决与未解决 ← Claude §4 + §5 | 问题追踪 | 错误和问题排查是一体的 |
| §5 待办清单 ← Claude §7 + OC §2 + §4 | 任务追踪 | 合并 OpenClaw 的 TODOs + Pending asks |
| §6 当前进度 ← Claude §8 | 续航关键 | 独立一段，优先级最高 |
| §7 关键标识符 ← OC §5 | 精确性 | OpenClaw 验证了这一段的必要性 |

**净效果**：与 Claude Code 9 段相比，节省约 15-20% 的摘要 token（消除重复段落），同时不丢失任何关键维度。

### 2.4 无需 `<analysis>` 预分析

Claude Code 要求先输出 `<analysis>` 做时间线分析再输出 `<summary>`。这是双重开销——分析段本身可能占摘要 50% 的 token，最后还会被丢弃。

知行方案：**直接输出 7 段结构**，不要求预分析。7 段本身已经涵盖了时间线（§1 的优先级变化、§4 的问题历程、§6 的当前进度），额外的分析步骤是冗余。

## 三、Prompt 工程

### 3.1 系统提示（复用主会话 system prompt）

不更换 system prompt，**追加 user 消息**作为摘要指令。

理由：与 Claude Code 相同——最大化 prompt cache 命中率。更换 system prompt 会导致所有 cached prefix 失效。

### 3.2 摘要指令（末尾追加的 user 消息）

```text
你是一个精确的对话摘要助手。请根据以上对话历史，生成结构化摘要。

要求：
1. 用对话的主要语言写摘要正文
2. 保持以下 7 个章节标题不变，按顺序输出
3. 不翻译、不修改代码、文件路径、标识符、错误信息
4. 聚焦事实：讨论了什么、做了什么、当前状态
5. 最近的对话内容比更早的内容更重要
6. 「当前进度」章节必须包含压缩前最后在做的事情的具体细节
7. 「关键标识符」章节中所有标识符原样保留，不缩写

章节结构：

## 核心目标
[用户的明确请求，标注优先级变化和关键修正]

## 技术上下文
[技术栈、架构决策、约束条件]

## 文件与变更
[文件列表，标注 [读][改][建][删]，最近修改的附代码片段]

## 已解决与未解决
[已解决的问题及方案；仍在排查的问题]

## 待办清单
[未完成任务，标注 [ ] 待做 / [~] 进行中]

## 当前进度
[压缩前正在做什么，具体文件名、代码、步骤]

## 关键标识符
[UUID、hash、路径、URL 等，原样保留]

重要：只输出摘要文本，不要调用任何工具，不要输出其他内容。
```

### 3.3 自定义追加指令（/compact 扩展）

支持用户通过 `/compact <指令>` 追加自定义聚焦点：

```text
[用户的额外聚焦指令]
请在摘要中特别关注以上指令提到的内容。
```

追加在摘要指令末尾，限制最大 800 字符（与 OpenClaw 一致）。

### 3.4 合并摘要指令（多段摘要合并时使用）

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

```typescript
const REQUIRED_SECTIONS = [
  "## 核心目标",
  "## 技术上下文",
  "## 文件与变更",
  "## 已解决与未解决",
  "## 待办清单",
  "## 当前进度",
  "## 关键标识符",
] as const;

function validateSummary(summary: string): {
  valid: boolean;
  missing: string[];
} {
  const lines = summary.split('\n').map(l => l.trim());
  const missing = REQUIRED_SECTIONS.filter(
    section => !lines.includes(section)
  );
  return { valid: missing.length === 0, missing };
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

### 5.1 续写消息

压缩完成后注入一条 system 消息：

```text
[对话已压缩]
以下是之前对话的摘要，涵盖了核心目标、技术上下文、文件变更、问题追踪、
待办事项、当前进度和关键标识符。

{formatted_summary}

请从「当前进度」描述的位置继续工作，不要询问用户额外问题。
```

### 5.2 不做 Rehydration

Claude Code 压缩后重新注入最近读过的 5 个文件（~50K token）。

知行方案：**Phase 2 不做 rehydration**。

理由：
1. 50K token 的文件重注入会大幅抵消压缩节省的空间
2. 摘要的 §3（文件与变更）已包含关键代码片段
3. LLM 需要文件内容时可以自己调用 Read 工具
4. 这是一个优化点，不是基础功能——留给 Phase 3

### 5.3 Auto-compact vs /compact 的续写差异

| 场景 | 续写指令 |
|------|---------|
| Auto-compact | "请从「当前进度」描述的位置继续工作，不要询问用户额外问题。" |
| /compact（手动） | "对话已压缩。等待用户的下一个指令。" |

手动 compact 后不应自动继续任务——用户可能想改方向。

## 六、分块摘要策略

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
块2 摘要 ─┼─→ 合并指令 → 最终 7 段摘要
块3 摘要 ─┘
```

合并摘要也经过必需章节校验。

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

熔断后降级策略：跳过 L3，仅保留 L1（ToolResult 截断）+ L2（早期消息丢弃）的结果。对话可继续但无摘要——这比完全无法对话要好。

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
  llm-summarize.ts         ← 核心实现（L3 策略）
  llm-summarize.test.ts    ← 测试

packages/core/src/context/
  prompts.ts               ← 摘要 prompt 模板（7 段 + 5 段 + 合并指令）
  validation.ts            ← 章节校验逻辑
```

## 十、实现路线

### Step 2G-1：Prompt 模板与校验

```
内容：
  - prompts.ts：7 段主模板 + 5 段 sub-agent 模板 + 合并指令
  - validation.ts：必需章节检查 + 重试指令生成
验证：
  - 单元测试：各模板包含正确的必需章节标题
  - 校验逻辑：缺章节 → 检测到；全章节 → 通过
```

### Step 2G-2：摘要生成核心

```
内容：
  - llm-summarize.ts：generateSummary + 校验 + 重试 + CircuitBreaker
  - 分块策略：单次/多块判断 + 合并
验证：
  - 集成测试：mock LLM → 生成摘要 → 校验通过
  - 熔断测试：连续失败 → 降级
```

### Step 2G-3：Engine 集成

```
内容：
  - 注册 L3 策略到 ContextEngine
  - L2 后仍超阈值时触发 L3
  - 压缩后注入续写消息
验证：
  - 端到端测试：长对话 → L1 → L2 → L3 → 对话继续
  - 续写消息包含格式化的摘要
```

## 十一、设计原则

1. **7 段 > 9 段**：合并冗余，信息密度更高，摘要 token 更少
2. **无分析段**：不要求 `<analysis>` 预分析，直接输出结构化摘要
3. **语言跟随**：中文对话用中文摘要，英文对话用英文摘要
4. **校验但不严苛**：检查章节标题，不逐一验证标识符
5. **单次重试**：不做多轮修正——2 次不过就降级
6. **缓存友好**：不换 system prompt，摘要指令作为 user 消息追加
7. **不做过度 rehydration**：LLM 需要文件时自己读，不预注入
