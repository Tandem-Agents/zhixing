/**
 * 模型的注意力质量阈值 —— 派生自单一策展目录源 `BUILTIN_CURATED_CATALOG.attentionThresholds`（设计 §4.1）。
 *
 * 优先级：用户 `llm.attentionPolicies`（或兼容旧 `modelCapabilityOverrides`）覆盖 > 当前目录阈值 > UNKNOWN 兜底。
 */

import { BUILTIN_CURATED_CATALOG } from "./catalog/builtin-catalog.js";

export interface ModelCapability {
  /** 模型标识符（规范化小写短名） */
  readonly modelId: string;
  /** 注意力最好阈值上限 —— 超过此值进入"评估是否切段"窗口 */
  readonly optimalMaxTokens: number;
  /** 注意力风险阈值 —— 超过此值强制切段（即使在任务中） */
  readonly riskMaxTokens: number;
}

function buildBuiltinCapabilities(): Readonly<Record<string, ModelCapability>> {
  const result: Record<string, ModelCapability> = {};
  for (const [key, entry] of Object.entries(BUILTIN_CURATED_CATALOG.attentionThresholds)) {
    result[key] = {
      modelId: entry.modelKey,
      optimalMaxTokens: entry.optimalMaxTokens,
      riskMaxTokens: entry.riskMaxTokens,
    };
  }
  return Object.freeze(result);
}

/** 内置注意力阈值表 —— 派生自单一策展目录源。 */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> =
  buildBuiltinCapabilities();

/** 未知模型的兜底阈值 —— modelId 命中不到内置/目录表时使用。 */
export const UNKNOWN_MODEL_CAPABILITY: ModelCapability = {
  modelId: "<unknown>",
  optimalMaxTokens: 64_000,
  riskMaxTokens: 128_000,
};

export type ModelCapabilityOverride = Partial<Omit<ModelCapability, "modelId">>;

/**
 * 解析最终生效的 ModelCapability。
 * 优先级：用户 override > 目录/内置常量 > UNKNOWN 兜底。
 */
export function resolveModelCapability(
  modelId: string,
  override?: ModelCapabilityOverride,
  customThresholds?: Readonly<Record<string, { readonly optimalMaxTokens: number; readonly riskMaxTokens: number }>>,
): ModelCapability {
  const normalized = normalizeModelId(modelId);
  const custom = customThresholds?.[normalized];
  const base: ModelCapability = custom
    ? {
        modelId: normalized,
        optimalMaxTokens: custom.optimalMaxTokens,
        riskMaxTokens: custom.riskMaxTokens,
      }
    : (MODEL_CAPABILITIES[normalized] ?? { ...UNKNOWN_MODEL_CAPABILITY, modelId: normalized });

  if (!override) return base;

  return {
    modelId: base.modelId,
    optimalMaxTokens: override.optimalMaxTokens ?? base.optimalMaxTokens,
    riskMaxTokens: override.riskMaxTokens ?? base.riskMaxTokens,
  };
}

/** 规范化 model ID 用于查找（取最后一个 '/' 之后的部分并小写）。 */
export function normalizeModelId(modelId: string): string {
  const lastSlash = modelId.lastIndexOf("/");
  const tail = lastSlash >= 0 ? modelId.slice(lastSlash + 1) : modelId;
  return tail.toLowerCase();
}

/** 从 override map 中按规范化 model ID 查找用户覆盖。 */
export function getModelCapabilityOverride(
  overrides: Record<string, ModelCapabilityOverride> | undefined,
  modelId: string,
): ModelCapabilityOverride | undefined {
  if (!overrides) return undefined;
  const target = normalizeModelId(modelId);
  const exact = overrides[target];
  if (exact) return exact;
  for (const [key, value] of Object.entries(overrides)) {
    if (normalizeModelId(key) === target) return value;
  }
  return undefined;
}
