/**
 * Skill Effectiveness Inference — 技能效果推断
 *
 * 对话结束后，根据对话信号推断本次注入的技能的效果。
 * 这是知行独有的创新——竞品（Hermes/OpenClaw/Claude Code）都不跟踪技能效果。
 *
 * 推断规则：
 * - 用户明确否定（"不对"/"过时了"/"方法不行"）→ "needs-update"
 * - 连续 3 次使用无否定信号 → "helpful"
 * - 其他情况维持 "unknown" 不做假设
 *
 * 设计约束：
 * - 推断是辅助信号，不自动触发变更
 * - 仅更新 frontmatter，不修改技能正文
 * - 推断失败时静默，不阻塞主流程
 */

import type { Message } from "../types/messages.js";
import { SkillsStore, type SkillEffectiveness } from "./skills-store.js";

// ─── 类型 ───

export interface InferenceInput {
  /** 本轮注入的技能 ID 列表 */
  injectedSkillIds: string[];
  /** 本轮全部对话消息（含 user + assistant） */
  turnMessages: Message[];
}

export interface InferenceResult {
  /** 每个技能的推断结果 */
  updates: SkillEffectivenessUpdate[];
}

export interface SkillEffectivenessUpdate {
  skillId: string;
  previous: SkillEffectiveness;
  inferred: SkillEffectiveness;
  reason: string;
}

// ─── 否定信号检测 ───

/**
 * 用户否定技能的常见表达。
 * 匹配规则：用户消息中包含这些模式之一。
 * 同时支持中文和英文，覆盖最高频的否定场景。
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  // 中文否定
  /这个方法不(对|行|好|管用)/,
  /方法(过时|不对|错了|有问题)/,
  /不(对|行|好|管用|适用)/,
  /过时了/,
  /这(是|个)(错|旧)的/,
  /技能.*?(不对|过时|错|有问题)/,

  // 英文否定
  /(?:this|that|the)\s+(?:method|approach|skill|technique)\s+(?:is\s+)?(?:wrong|outdated|incorrect|broken)/i,
  /doesn'?t\s+work/i,
  /not\s+(?:right|correct|working)/i,
  /(?:wrong|outdated|incorrect)\s+(?:approach|method|solution)/i,
];

/**
 * 检测用户消息中是否包含对技能的否定信号。
 */
export function detectNegativeSignal(userMessages: string[]): string | null {
  for (const msg of userMessages) {
    for (const pattern of NEGATIVE_PATTERNS) {
      const match = msg.match(pattern);
      if (match) {
        return match[0];
      }
    }
  }
  return null;
}

// ─── 推断引擎 ───

/** 连续 N 次使用无否定即判定为 helpful */
const HELPFUL_USE_THRESHOLD = 3;

/**
 * 推断本轮注入的技能的效果。
 *
 * 不直接写入——返回推断结果，由调用方决定是否持久化。
 * 这保证了推断逻辑的可测试性和无副作用。
 */
export async function inferEffectiveness(
  input: InferenceInput,
  skillsStore: SkillsStore,
): Promise<InferenceResult> {
  const { injectedSkillIds, turnMessages } = input;
  if (injectedSkillIds.length === 0) {
    return { updates: [] };
  }

  const userTexts = extractUserTexts(turnMessages);
  const negativeSignal = detectNegativeSignal(userTexts);
  const updates: SkillEffectivenessUpdate[] = [];

  for (const skillId of injectedSkillIds) {
    const skill = await skillsStore.load(skillId);
    if (!skill) continue;

    const previous = skill.meta.effectiveness;

    if (negativeSignal) {
      // 用户否定 → needs-update（无论之前是什么状态）
      if (previous !== "needs-update") {
        updates.push({
          skillId,
          previous,
          inferred: "needs-update",
          reason: `negative-signal: "${negativeSignal}"`,
        });
      }
    } else if (previous === "needs-update") {
      // 之前被标记 needs-update，本次正常使用 → 恢复为 unknown
      updates.push({
        skillId,
        previous,
        inferred: "unknown",
        reason: "used-normally-after-negative",
      });
    } else if (skill.meta.useCount >= HELPFUL_USE_THRESHOLD && previous !== "helpful") {
      // 累计使用 N 次，且从未被否定过 → helpful
      updates.push({
        skillId,
        previous,
        inferred: "helpful",
        reason: `used-${skill.meta.useCount}-times-without-negative`,
      });
    }
  }

  return { updates };
}

/**
 * 将推断结果持久化到 SkillsStore。
 * 仅更新 effectiveness 字段，不触发版本变更。
 */
export async function applyEffectivenessUpdates(
  result: InferenceResult,
  skillsStore: SkillsStore,
): Promise<number> {
  let applied = 0;

  for (const update of result.updates) {
    const skill = await skillsStore.load(update.skillId);
    if (!skill) continue;

    const updatedMeta = {
      ...skill.meta,
      effectiveness: update.inferred,
    };

    try {
      await skillsStore.save(update.skillId, updatedMeta, skill.content);
      applied++;
    } catch {
      // 静默——效果推断失败不应阻塞主流程
    }
  }

  return applied;
}

// ─── 辅助 ───

function extractUserTexts(messages: readonly Message[]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .flatMap((m) =>
      m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text),
    );
}
