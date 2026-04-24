/**
 * 摘要 Prompt 模板
 *
 * 设计决策（详见 research/design/specifications/llm-summarization.md）：
 * - 7 段结构（vs Claude Code 9 段 / OpenClaw 5 段）：合并冗余段，信息密度更高
 * - 不做 <analysis> 预分析：节省 ~50% 的摘要 token
 * - 语言跟随：中文对话用中文摘要
 * - 缓存友好：不换 system prompt，摘要指令作为末尾 user 消息追加
 */

// ─── 主会话 7 段模板 ───

export const MAIN_SESSION_PROMPT = `你是一个精确的对话摘要助手。请根据以上对话历史，生成结构化摘要。

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

重要：只输出摘要文本，不要调用任何工具，不要输出其他内容。`;

// ─── Sub-agent 5 段模板 ───

export const SUB_AGENT_PROMPT = `你是一个精确的对话摘要助手。请根据以上对话历史，生成面向任务恢复的结构化摘要。

要求：
1. 用对话的主要语言写摘要正文
2. 保持以下 5 个章节标题不变，按顺序输出
3. 不翻译、不修改代码、文件路径、标识符
4. 偏重"可立即恢复任务"的信息，而非全量档案

章节结构：

## 任务概述
[核心请求、成功标准、约束条件]

## 当前状态
[已完成的内容、创建/修改的文件与路径、关键产出]

## 关键发现
[约束、决策及理由、遇到的错误及处理、试过但无效的做法]

## 下一步
[待办事项、阻塞因素、优先级]

## 保留上下文
[用户偏好、领域细节、关键标识符]

重要：只输出摘要文本，不要调用任何工具，不要输出其他内容。`;

// ─── 合并摘要指令 ───

export const MERGE_SUMMARIES_PROMPT = `将以下多段摘要合并为一份统一摘要，使用相同的 7 段结构。

合并要求：
- 保留所有活跃任务及其状态
- 保留批量操作的进度（如 "5/17 项已完成"）
- 保留用户最后的请求和正在做的事
- 保留所有决策及其理由
- 优先保留近期上下文，远期细节可精简
- 所有标识符原样保留

重要：只输出合并后的摘要文本，不要调用任何工具。`;

// ─── 续写消息模板 ───
//
// 历史上这里有 buildContinuationMessage / buildManualCompactMessage 生成
// `[对话已压缩]...` 字符串的 dead code。所有 compact 占位统一由
// @zhixing/core/context/system-meta 的 buildCompactSummaryPair 构造为 Message pair，
// 不再有字符串模板形态 —— 避免两套格式并存导致 LLM 理解分裂。

// ─── 校验重试追加指令 ───

export function buildRetryPrompt(missingSections: string[]): string {
  return `摘要缺少以下必需章节：${missingSections.join("、")}
请补充缺失的章节，保持其余内容不变。`;
}

// ─── 自定义指令包装 ───

const MAX_CUSTOM_INSTRUCTION_LENGTH = 800;

export function wrapCustomInstructions(instructions: string): string {
  const trimmed = instructions.trim().slice(0, MAX_CUSTOM_INSTRUCTION_LENGTH);
  if (!trimmed) return "";
  return `\n\n[用户的额外聚焦指令]\n${trimmed}\n请在摘要中特别关注以上指令提到的内容。`;
}

// ─── 模板选择 ───

export type SummarizationTemplate = "main-session" | "sub-agent";

export function getSummarizationPrompt(
  template: SummarizationTemplate,
  customInstructions?: string,
): string {
  const base =
    template === "main-session" ? MAIN_SESSION_PROMPT : SUB_AGENT_PROMPT;
  const custom = customInstructions
    ? wrapCustomInstructions(customInstructions)
    : "";
  return base + custom;
}
