/**
 * UI 暴露的内置预设视图 —— 派生自单一策展目录源（`@zhixing-ai/providers/configuration`）。
 *
 * 彻底取代原手工维护的白名单表，消除“后端 8 家、终端仅 2 家”与四处手工同步：
 * 首批 11 项内置预设全部同源供给，且支持传入实时更新后的 `ModelCatalogPort` 动态列出新预设。
 */

import {
  DEFAULT_MODEL_CATALOG_PORT,
  type CatalogPresetEntry,
  type ModelCatalogPort,
} from "@zhixing-ai/providers/configuration";

export interface SupportedProvider {
  id: string;
  /** UI 显示名 */
  label: string;
  /** 短描述（可选），显示在选择列表的右侧 */
  description?: string;
  /** API Key 编辑面板的提示文本（不含 URL，URL 走 docUrl） */
  apiKeyHint: string;
  /** API Key 格式示例（如 "sk-xxxxxxxxxxxxxxxx"） */
  apiKeyExample: string;
  /** API Key 创建页文档链接——input panel 渲染为可点击行 */
  docUrl?: string;
  /** 模型列表文档链接——add-model panel 渲染为可点击行，引导用户去查可用 model id */
  modelListDocUrl?: string;
  /** add-model panel 显示的 model id 示例（参考性质，让用户知道格式） */
  modelExample?: string;
  /** 默认认证模式（免密如 Ollama 为 "none"） */
  defaultAuthMode?: "none" | "api-key" | "header";
  /** 该条目是否需要升级知行客户端（能力门控隔离，不整包作废） */
  requiresUpgrade?: boolean;
}

function toSupportedProvider(entry: CatalogPresetEntry): SupportedProvider {
  const ui = entry.curated.ui;
  return {
    id: entry.id,
    label: ui.label,
    description: ui.description,
    apiKeyHint: ui.apiKeyHint,
    apiKeyExample: ui.apiKeyExample,
    ...(ui.docUrl ? { docUrl: ui.docUrl } : {}),
    ...(ui.modelListDocUrl ? { modelListDocUrl: ui.modelListDocUrl } : {}),
    ...(ui.modelExample ? { modelExample: ui.modelExample } : {}),
    defaultAuthMode: entry.curated.defaultAuthMode,
    ...(entry.requiresUpgrade ? { requiresUpgrade: true } : {}),
  };
}

/** 从指定（或随包默认）单一策展目录动态派生全部受支持预设列表。 */
export function listSupportedProviders(
  catalog: ModelCatalogPort = DEFAULT_MODEL_CATALOG_PORT,
): SupportedProvider[] {
  return catalog.listPresets().map(toSupportedProvider);
}

/** 随包基线 11 项预设静态视图（派生自 `DEFAULT_MODEL_CATALOG_PORT`，非手工副本）。 */
export const SUPPORTED_PROVIDERS: SupportedProvider[] = listSupportedProviders();
