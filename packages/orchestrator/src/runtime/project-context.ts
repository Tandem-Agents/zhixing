/**
 * 项目上下文加载与注入
 *
 * 从 ZHIXING.md 加载项目指令,通过 <context> 标签注入到 user messages 中。
 *
 * 设计决策:
 * - ZHIXING.md 不进 system prompt,保护缓存前缀
 * - 通过 <context> 标签注入到首条 user message
 * - 三层加载(用户级 → 项目级),项目级覆盖用户级
 *
 * 加载路径:
 *   1. ~/.zhixing/ZHIXING.md          — 用户级(所有项目通用偏好)
 *   2. ./ZHIXING.md 或 ./.zhixing/ZHIXING.md — 项目级
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Message, ProfileData } from "@zhixing/core";
import { loadProfile, formatProfileForContext, MemoryRetriever } from "@zhixing/core";

// ─── 类型 ───

export interface ProjectContext {
  /** ZHIXING.md 内容(合并后),null 表示无项目指令 */
  instructions: string | null;
  /** 当前日期(YYYY-MM-DD) */
  date: string;
  /** 用户身份画像(~/.zhixing/me/profile.md),null 表示未配置 */
  profile: ProfileData | null;
  /** 动态注入的额外上下文(如匹配的技能),每次对话设置 */
  dynamicContext: string | null;
  /** 本轮注入的技能 ID 列表(用于更新提议) */
  injectedSkillIds: string[];
  /** 反思提示(当上一轮 toolEndCount >= threshold 时注入) */
  reflectionHint: string | null;
}

// ─── 加载 ───

/**
 * 加载项目上下文。
 *
 * 优先级:项目级 > 用户级。如果项目级存在则忽略用户级(覆盖而非合并)。
 * 两级都不存在时 instructions 为 null。
 */
export async function loadProjectContext(
  cwd: string,
  memoryRoot?: string,
): Promise<ProjectContext> {
  const [instructions, profile] = await Promise.all([
    loadInstructions(cwd),
    loadProfile(memoryRoot),
  ]);
  const date = new Date().toISOString().slice(0, 10);

  return { instructions, date, profile, dynamicContext: null, injectedSkillIds: [], reflectionHint: null };
}

/** 反思触发阈值:toolEndCount >= 此值时注入反思提示 */
export const REFLECTION_THRESHOLD = 8;

export interface EnrichOptions {
  /** 上一轮的 toolEndCount(用于判断是否触发反思) */
  lastToolEndCount?: number;
  /** 本会话是否已经提议过技能(每会话最多 1 次) */
  hasProposedSkill?: boolean;
  /**
   * 装配期注入的 scoped 检索器 —— 工作场景下指向 workscene 记忆域，
   * 与 profile / memory 工具同源隔离。缺省回退默认个人域检索器
   * （Layer-A 根治后路径正确，服务非装配调用方）。
   */
  retriever?: MemoryRetriever;
}

/**
 * 根据最后一条用户消息检索匹配的技能,
 * 并在合适时机注入反思提示到 dynamicContext。
 * 每次 run() 前调用。
 */
export async function enrichContext(
  context: ProjectContext,
  messages: readonly Message[],
  options: EnrichOptions = {},
): Promise<ProjectContext> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return context;

  const userText = lastUser.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ");

  if (!userText.trim()) return context;

  // 检索匹配的技能 —— 优先用装配期注入的 scoped 检索器（工作场景隔离）
  const retriever = options.retriever ?? new MemoryRetriever();
  const result = await retriever.retrieve(userText);

  const dynamicParts: string[] = [];
  const injectedSkillIds: string[] = [];

  if (result.contextText) {
    dynamicParts.push(result.contextText);
    injectedSkillIds.push(...result.skills.map((s) => s.skill.id));
  }

  // 反思提示:上一轮复杂任务后,且本会话未提议过
  const reflectionHint = buildReflectionHint(options, injectedSkillIds);
  if (reflectionHint) {
    dynamicParts.push(reflectionHint);
  }

  return {
    ...context,
    dynamicContext: dynamicParts.length > 0 ? dynamicParts.join("\n\n") : null,
    injectedSkillIds,
    reflectionHint,
  };
}

/**
 * 构建反思提示。
 * 仅在上一轮 toolEndCount >= threshold 且本会话未提议过时返回。
 */
function buildReflectionHint(
  options: EnrichOptions,
  injectedSkillIds: string[],
): string | null {
  const { lastToolEndCount = 0, hasProposedSkill = false } = options;

  if (hasProposedSkill) return null;
  if (lastToolEndCount < REFLECTION_THRESHOLD) return null;

  const lines = [
    "# Reflection Hint",
    `The previous task involved ${lastToolEndCount} tool calls, indicating a complex problem-solving process.`,
    "Consider whether this experience contains a reusable methodology worth saving as a skill.",
  ];

  if (injectedSkillIds.length > 0) {
    lines.push(`Skills used this session: ${injectedSkillIds.join(", ")}`);
    lines.push("If you found improvements to any of these skills, propose an update.");
  }

  return lines.join("\n");
}

async function loadInstructions(cwd: string): Promise<string | null> {
  // 项目级优先
  const projectPaths = [
    path.join(cwd, "ZHIXING.md"),
    path.join(cwd, ".zhixing", "ZHIXING.md"),
  ];

  for (const p of projectPaths) {
    const content = await readFileSafe(p);
    if (content !== null) return content;
  }

  // 用户级兜底
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    const userPath = path.join(home, ".zhixing", "ZHIXING.md");
    const content = await readFileSafe(userPath);
    if (content !== null) return content;
  }

  return null;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// ─── 注入 ───

const CONTEXT_TAG = "<context>";
const CONTEXT_TAG_END = "</context>";

/**
 * 将项目上下文注入到首条 user message 中。
 *
 * 规则:
 * - 仅注入到消息列表中的 **第一条 user message**
 * - 如果该消息已包含 <context> 标签,不重复注入
 * - 无内容可注入时(instructions 为 null 且无额外信息),返回原始消息
 * - 不修改原始数组,返回新数组
 */
export function injectContext(
  messages: Message[],
  context: ProjectContext,
): Message[] {
  const contextBlock = buildContextBlock(context);
  if (!contextBlock) return messages;

  const result = [...messages];
  const firstUserIdx = result.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) return result;

  const firstUser = result[firstUserIdx]!;
  const currentText = extractUserText(firstUser);

  // 已注入则跳过
  if (currentText.includes(CONTEXT_TAG)) return result;

  const injectedText = `${contextBlock}\n\n${currentText}`;
  result[firstUserIdx] = replaceUserText(firstUser, injectedText);

  return result;
}

/**
 * 构建 <context> 块。
 * 无内容时返回 null。
 */
function buildContextBlock(context: ProjectContext): string | null {
  const sections: string[] = [];

  if (context.profile) {
    sections.push(formatProfileForContext(context.profile));
  }

  if (context.instructions) {
    sections.push(`# Project Instructions (ZHIXING.md)\n${context.instructions}`);
  }

  if (context.dynamicContext) {
    sections.push(context.dynamicContext);
  }

  if (sections.length === 0) return null;

  return `${CONTEXT_TAG}\n${sections.join("\n\n")}\n${CONTEXT_TAG_END}`;
}

// ─── Message 操作辅助 ───

function extractUserText(message: Message): string {
  const textBlock = message.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return textBlock?.text ?? "";
}

/**
 * 替换消息中第一个 TextBlock 的文本。
 * 若不存在 TextBlock,则在 content 最前面插入一个。
 */
function replaceUserText(message: Message, newText: string): Message {
  const hasText = message.content.some((b) => b.type === "text");

  if (!hasText) {
    return {
      ...message,
      content: [{ type: "text" as const, text: newText }, ...message.content],
    };
  }

  let replaced = false;
  const newContent = message.content.map((block) => {
    if (block.type === "text" && !replaced) {
      replaced = true;
      return { ...block, text: newText };
    }
    return block;
  });

  return { ...message, content: newContent };
}
