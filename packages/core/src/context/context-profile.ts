/**
 * 场景参数化：ScenarioHint + ContextProfile
 *
 * 规格引用：context-architecture.md §10
 *
 * 设计原则：
 * - 机制不变，配置可变 — 所有上下文机制（LayerAssembler / WindowManager / TierCompressor）
 *   消费同一个 ContextProfile 接口，场景差异完全由 Profile 参数驱动
 * - 三个内建 Profile 覆盖四个场景（social 复用 interactive，仅 layer2Mode 不同）
 * - Profile 是不可变值对象，运行时不修改
 */

import type { BudgetThresholds } from "./types.js";

// ─── ScenarioHint ───

/** 场景 hint：四个语义场景，驱动 ContextProfile 选择 */
export type ScenarioHint = "lookup" | "interactive" | "social" | "autonomous";

// ─── ToolCategory ───

/**
 * 工具类别标签。每个工具声明自己的 categories，
 * LayerAssembler 按 Profile 的 toolCategories 白名单过滤 Tool Catalog。
 */
export type ToolCategory =
  | "query"
  | "mutation"
  | "execution"
  | "memory-write"
  | "task-ledger"
  | "social"
  | "scenario"
  | "system";

// ─── ContextProfile ───

/** Tier 压缩阈值：tool_result 按轮距分四级压缩 */
export interface TierThresholds {
  /** Tier 1 上界：轮距 ≤ T1 完整保留 */
  readonly T1: number;
  /** Tier 2 上界：T1 < 轮距 ≤ T2 trim 到 2000 字符 */
  readonly T2: number;
  /** Tier 3 上界：T2 < 轮距 ≤ T3 trim 到 500 字符 + 结构标记 */
  readonly T3: number;
}

/** 驱逐级联穷尽后的行为 */
export type ExhaustedAction =
  | "yield-error-to-user"
  | "yield-event-to-parent";

/**
 * ContextProfile — 场景驱动的参数组。
 *
 * 所有上下文机制（LayerAssembler / WindowManager / TierCompressor / BudgetManager）
 * 消费这一个接口，场景差异完全由参数值驱动，机制代码永远不动。
 */
export interface ContextProfile {
  /** Profile 名称，也是 discriminant */
  readonly name: "interactive" | "autonomous" | "lookup";

  // ── Layer 行为 ──

  /** 是否注入用户画像（Layer 1） */
  readonly includeProfile: boolean;
  /** Layer 2 模式：basic=触发匹配 / enriched=+关系+journal / minimal=仅任务声明 / skip=跳过 */
  readonly layer2Mode: "basic" | "enriched" | "minimal" | "skip";

  // ── 工具目录过滤 ──

  /** 允许的工具类别白名单 */
  readonly toolCategories: readonly ToolCategory[];

  // ── 预算阈值 ──

  readonly budgetThresholds: BudgetThresholds;

  // ── Tier 压缩阈值 ──

  /** null 表示不做 Tier 压缩（lookup 场景无 tool_result） */
  readonly tierThresholds: TierThresholds | null;

  // ── 驱逐失败行为 ──

  readonly onExhausted: ExhaustedAction;
}

// ─── 内建 Profile 常量 ───

const ALL_TOOL_CATEGORIES: readonly ToolCategory[] = [
  "query",
  "mutation",
  "execution",
  "memory-write",
  "task-ledger",
  "social",
  "scenario",
  "system",
] as const;

/**
 * interactive Profile — 默认场景。
 * social hint 也使用此 Profile，仅 layer2Mode 被覆写为 enriched。
 */
export const INTERACTIVE_PROFILE: ContextProfile = {
  name: "interactive",
  includeProfile: true,
  layer2Mode: "basic",
  toolCategories: ALL_TOOL_CATEGORIES,
  budgetThresholds: { warning: 0.65, compact: 0.80, critical: 0.90 },
  tierThresholds: { T1: 2, T2: 8, T3: 30 },
  onExhausted: "yield-error-to-user",
} as const;

export const AUTONOMOUS_PROFILE: ContextProfile = {
  name: "autonomous",
  includeProfile: false,
  layer2Mode: "minimal",
  toolCategories: ["query", "mutation", "execution", "scenario", "system"],
  budgetThresholds: { warning: 0.40, compact: 0.60, critical: 0.80 },
  tierThresholds: { T1: 1, T2: 3, T3: 12 },
  onExhausted: "yield-event-to-parent",
} as const;

export const LOOKUP_PROFILE: ContextProfile = {
  name: "lookup",
  includeProfile: false,
  layer2Mode: "skip",
  toolCategories: ["query", "scenario"],
  budgetThresholds: { warning: 0.75, compact: 0.85, critical: 0.95 },
  tierThresholds: null,
  onExhausted: "yield-error-to-user",
} as const;

// ─── Hint → Profile 映射 ───

/**
 * 将 ScenarioHint 映射为 ContextProfile。
 *
 * 映射规则（spec §10.6）：
 * - interactive / undefined → INTERACTIVE（layer2Mode=basic）
 * - social → INTERACTIVE（layer2Mode=enriched）
 * - autonomous → AUTONOMOUS
 * - lookup → LOOKUP
 *
 * social 与 interactive 共用 Profile 参数，仅 layer2Mode 不同。
 */
export function hintToProfile(hint: ScenarioHint): ContextProfile {
  switch (hint) {
    case "lookup":
      return LOOKUP_PROFILE;
    case "autonomous":
      return AUTONOMOUS_PROFILE;
    case "social":
      return { ...INTERACTIVE_PROFILE, layer2Mode: "enriched" as const };
    case "interactive":
    default:
      return INTERACTIVE_PROFILE;
  }
}

// ─── Hint 级别（单调升级排序用） ───

const HINT_LEVELS: Record<ScenarioHint, number> = {
  lookup: 0,
  interactive: 1,
  social: 2,
  autonomous: -1, // 不参与排序，由业务代码硬编码
};

/**
 * 获取 hint 的级别数值（用于单调升级判断）。
 * autonomous 返回 -1，不参与运行时排序。
 */
export function hintLevel(hint: ScenarioHint): number {
  return HINT_LEVELS[hint] ?? 1;
}
