/**
 * LayerAssembler(层级组装器) — 四层 system prompt 组装
 *
 * 规格引用：context-architecture.md §3.2 (LayerAssembler)
 *
 * 设计原则：
 * - 纯函数：输入 → 输出，无状态，无 I/O
 * - Profile 驱动：所有层级的包含/跳过决策由 ContextProfile 参数化
 * - 调用方负责数据获取：LayerAssembler 不做异步检索，
 *   userProfile / sceneContent 由调用方预取后传入
 * - 可测试：每一层可独立检验
 *
 * 四层结构：
 * Layer 0 (Static)  — Agent 身份 + 工具目录（可缓存前缀）
 * Layer 1 (Profile) — 用户画像（Profile.includeProfile 控制）
 * Layer 2 (Scene)   — 场景触发内容（Profile.layer2Mode 控制）
 * Layer 3 (Dynamic) — 工作区/时间/轨迹/任务提示（每轮重建）
 */

import type { ContextProfile, ToolCategory } from "./context-profile.js";
import type { TurnDigest } from "./turn-digest.js";
import { formatDigestTrail } from "./turn-digest.js";

// ─── Tool Declaration ───

/**
 * 工具声明（用于 Layer 0 工具目录过滤）。
 *
 * 每个工具声明自己的 categories，LayerAssembler 按
 * Profile.toolCategories 白名单过滤。
 */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly categories: readonly ToolCategory[];
}

// ─── 输入 ───

export interface LayerAssemblerInput {
  /** 当前场景 Profile（决定所有层级行为） */
  readonly profile: ContextProfile;

  /** Layer 0: Agent 身份文本 */
  readonly identity: string;
  /** Layer 0: 可用工具列表（按 profile.toolCategories 过滤） */
  readonly tools?: readonly ToolDeclaration[];

  /** Layer 1: 用户画像文本（调用方预取） */
  readonly userProfile?: string;

  /** Layer 2: 场景触发内容（调用方根据 layer2Mode 预取） */
  readonly sceneContent?: string;

  /** Layer 3: 工作区上下文 */
  readonly workspaceContext?: string;
  /** Layer 3: 当前时间 */
  readonly currentTime?: string;
  /** Layer 3: Turn 轨迹摘要 */
  readonly turnDigests?: readonly TurnDigest[];
  /** Layer 3: 活跃任务一句话提示 */
  readonly activeTaskHint?: string;
}

// ─── 输出 ───

/** 分层组装结果（用于调试/测试各层内容） */
export interface LayerResult {
  readonly layer0: string;
  readonly layer1: string;
  readonly layer2: string;
  readonly layer3: string;
  readonly systemPrompt: string;
}

// ─── 组装 ───

/** 组装完整的 system prompt（便捷入口） */
export function assembleSystemPrompt(input: LayerAssemblerInput): string {
  return assembleLayers(input).systemPrompt;
}

/** 组装并返回各层分解结果（用于测试和调试） */
export function assembleLayers(input: LayerAssemblerInput): LayerResult {
  const layer0 = buildLayer0(input);
  const layer1 = buildLayer1(input);
  const layer2 = buildLayer2(input);
  const layer3 = buildLayer3(input);

  const systemPrompt = [layer0, layer1, layer2, layer3]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return { layer0, layer1, layer2, layer3, systemPrompt };
}

// ─── Layer 0: Static (Identity + Tool Catalog) ───

function buildLayer0(input: LayerAssemblerInput): string {
  const parts: string[] = [input.identity];

  if (input.tools && input.tools.length > 0) {
    const catalog = buildToolCatalog(
      input.tools,
      input.profile.toolCategories,
    );
    if (catalog) parts.push(catalog);
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * 按 Profile.toolCategories 白名单过滤工具，生成目录文本。
 *
 * 工具只要有一个 category 在白名单中即可通过。
 */
export function buildToolCatalog(
  tools: readonly ToolDeclaration[],
  allowedCategories: readonly ToolCategory[],
): string {
  const allowed = new Set(allowedCategories);
  const filtered = tools.filter((t) =>
    t.categories.some((c) => allowed.has(c)),
  );

  if (filtered.length === 0) return "";

  const lines = filtered.map((t) => `- ${t.name}: ${t.description}`);
  return `[可用工具]\n${lines.join("\n")}`;
}

// ─── Layer 1: Profile (User Portrait) ───

function buildLayer1(input: LayerAssemblerInput): string {
  if (!input.profile.includeProfile) return "";
  if (!input.userProfile) return "";

  return `[用户画像]\n${input.userProfile}`;
}

// ─── Layer 2: Scene (Dynamically triggered content) ───

function buildLayer2(input: LayerAssemblerInput): string {
  if (input.profile.layer2Mode === "skip") return "";
  if (!input.sceneContent) return "";

  return input.sceneContent;
}

// ─── Layer 3: Dynamic (Per-turn, NOT cached) ───

function buildLayer3(input: LayerAssemblerInput): string {
  const parts: string[] = [];

  if (input.workspaceContext) {
    parts.push(input.workspaceContext);
  }

  if (input.currentTime) {
    parts.push(`[当前时间] ${input.currentTime}`);
  }

  if (input.turnDigests && input.turnDigests.length > 0) {
    const trail = formatDigestTrail(input.turnDigests);
    if (trail) parts.push(trail);
  }

  if (input.activeTaskHint) {
    parts.push(`[活跃任务] ${input.activeTaskHint}`);
  }

  return parts.join("\n\n");
}
