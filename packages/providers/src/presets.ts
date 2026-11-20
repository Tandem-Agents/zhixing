/**
 * 内置 Provider 预设视图 —— 派生自单一策展目录源 `BUILTIN_CURATED_CATALOG`（设计 §1.2、§4.1）。
 *
 * 取代原手工维护预设表，避免与策展目录、用途推荐、注意力阈值及终端注册表四处漂移。
 * 完整 11 项内置预设均由单一源统一派生。
 */

import { BUILTIN_CURATED_CATALOG } from "./catalog/builtin-catalog.js";
import { curatedPresetToProviderPreset } from "./catalog-port.js";
import type { ProviderPreset } from "./types.js";

export type BuiltinPresetId =
  | "deepseek"
  | "qwen"
  | "kimi"
  | "glm"
  | "minimax"
  | "openai"
  | "anthropic"
  | "siliconflow"
  | "openrouter"
  | "google"
  | "ollama";

function buildBuiltinPresetsMap(): Readonly<Record<BuiltinPresetId, ProviderPreset>> {
  const result: Record<string, ProviderPreset> = {};
  for (const curated of BUILTIN_CURATED_CATALOG.presets) {
    const models = BUILTIN_CURATED_CATALOG.models.filter((m) => m.presetId === curated.id);
    result[curated.id] = curatedPresetToProviderPreset(curated, models);
  }
  return Object.freeze(result) as Readonly<Record<BuiltinPresetId, ProviderPreset>>;
}

/**
 * 11 项内置 Provider 预设表（派生自 `BUILTIN_CURATED_CATALOG`，保留精确字面 key 类型）。
 */
export const PROVIDER_PRESETS: Readonly<Record<BuiltinPresetId, ProviderPreset>> =
  buildBuiltinPresetsMap();

/**
 * 获取预设。返回 undefined 表示不在预设列表中（自定义连接）。
 */
export function getPreset(providerId: string): ProviderPreset | undefined {
  return (PROVIDER_PRESETS as Record<string, ProviderPreset | undefined>)[providerId];
}

/**
 * 获取所有预设 ID 列表（11 项）。
 */
export function getPresetIds(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}
