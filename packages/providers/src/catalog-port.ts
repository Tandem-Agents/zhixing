/**
 * 受控模型目录窄读口（设计 §2.1、§2.2.3、§4.1）。
 *
 * 所有后端解析与终端消费均通过 `ModelCatalogPort` 消费同一份已校验 `CuratedCatalogBundle`：
 * - 启动/离线默认使用随包基线 `BUILTIN_CURATED_CATALOG`；
 * - 接入 TUF 可信更新后，`ModelCatalogManager` 在同一窄读口上原子切换到最新已验签目录修订，
 *   下游配置解析、运行装配与终端无需另造第二套解析路径。
 */

import type { ModelAdapterId, ModelInfo, ModelRoleId } from "@zhixing-ai/core";
import { BUILTIN_CURATED_CATALOG } from "./catalog/builtin-catalog.js";
import {
  evaluateCapabilities,
  type CuratedCatalogBundle,
  type CuratedModelEntry,
  type CuratedPreset,
  type CuratedRecommendation,
} from "./catalog/schema.js";
import {
  UNKNOWN_MODEL_CAPABILITY,
  normalizeModelId,
  type ModelCapability,
  type ModelCapabilityOverride,
} from "./model-capability.js";
import type { RoleRecommendation } from "./role-recommendations.js";
import type { ModelConnectionConfig, ProviderPreset } from "./types.js";

/** 当前版本已实现受控协议适配集合（四协议全部就绪）。 */
export const IMPLEMENTED_MODEL_ADAPTERS: readonly ModelAdapterId[] = [
  "openai-compatible",
  "openai-responses",
  "anthropic-messages",
  "google-interactions",
] as const;

export function isAdapterImplemented(adapter: ModelAdapterId): boolean {
  return IMPLEMENTED_MODEL_ADAPTERS.includes(adapter);
}

export interface CatalogPresetEntry {
  readonly id: string;
  readonly revision: string;
  readonly preset: ProviderPreset;
  readonly curated: CuratedPreset;
  readonly implemented: boolean;
  readonly requiresUpgrade: boolean;
  readonly missingCapabilities: readonly string[];
}

export interface PresetUpdateSuggestion {
  readonly connectionId: string;
  readonly presetId: string;
  readonly currentPresetRevision?: string;
  readonly nextPresetRevision: string;
  readonly currentEndpoint: string;
  readonly suggestedEndpoint: string;
  readonly currentAdapter: ModelAdapterId;
  readonly suggestedAdapter: ModelAdapterId;
  readonly endpointChanged: boolean;
  readonly adapterChanged: boolean;
}

export interface ModelCatalogPort {
  readonly revision: string;
  readonly bundle: CuratedCatalogBundle;
  getPreset(presetId: string): CatalogPresetEntry | undefined;
  listPresets(): readonly CatalogPresetEntry[];
  listKnownModels(presetId: string): readonly ModelInfo[];
  listCuratedModels(presetId: string): readonly CuratedModelEntry[];
  getCuratedModel(presetId: string | undefined, modelId: string): CuratedModelEntry | undefined;
  getModelInfo(presetId: string | undefined, modelId: string): ModelInfo | undefined;
  getRoleRecommendation(role: ModelRoleId): RoleRecommendation | undefined;
  getCuratedRecommendations(role?: ModelRoleId): readonly CuratedRecommendation[];
  resolveAttentionCapability(
    modelId: string,
    override?: ModelCapabilityOverride,
  ): ModelCapability;
  isAdapterImplemented(adapter: ModelAdapterId): boolean;
  /** 判断 URL 是否精确匹配已核验的公开预设端点（含主地址与备用地域地址，用于 v1→v2 安全迁移）。 */
  isVerifiedPublicPresetEndpoint(presetId: string | undefined, endpoint: string): boolean;
  /** 比较既有连接固定值与当前预设建议值（绝不静默改写连接；被 `ignoredPresetRevision` 忽略时返回 undefined）。 */
  getPresetUpdateSuggestion(
    connectionId: string,
    connection: ModelConnectionConfig,
  ): PresetUpdateSuggestion | undefined;
}

function normalizeEndpointForMatch(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      return null;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.origin.toLowerCase()}${cleanPath}`;
  } catch {
    return null;
  }
}

export function curatedModelToModelInfo(entry: CuratedModelEntry): ModelInfo | undefined {
  if (entry.contextWindow === undefined || entry.maxOutputTokens === undefined) {
    return undefined;
  }
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    supportsTools: entry.supportsTools ?? true,
    ...(entry.supportsImages !== undefined ? { supportsImages: entry.supportsImages } : {}),
    ...(entry.supportsThinking !== undefined ? { supportsThinking: entry.supportsThinking } : {}),
    ...(entry.thinkingControl !== undefined ? { thinkingControl: entry.thinkingControl } : {}),
  };
}

export function curatedPresetToProviderPreset(
  preset: CuratedPreset,
  models: readonly CuratedModelEntry[],
): ProviderPreset {
  const knownModels = models
    .filter((m) => m.purpose === undefined || m.purpose === "chat")
    .map(curatedModelToModelInfo)
    .filter((info): info is ModelInfo => info !== undefined);
  return {
    name: preset.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    ...(preset.quirks ? { quirks: preset.quirks } : {}),
    ...(knownModels.length > 0 ? { knownModels } : {}),
  };
}

export function createModelCatalogPortFromBundle(bundle: CuratedCatalogBundle): ModelCatalogPort {
  const modelsByPreset = new Map<string, CuratedModelEntry[]>();
  for (const model of bundle.models) {
    const list = modelsByPreset.get(model.presetId) ?? [];
    list.push(model);
    modelsByPreset.set(model.presetId, list);
  }

  const presetEntries = new Map<string, CatalogPresetEntry>();
  const verifiedEndpointsByPreset = new Map<string, Set<string>>();

  for (const curated of bundle.presets) {
    const presetModels = modelsByPreset.get(curated.id) ?? [];
    const providerPreset = curatedPresetToProviderPreset(curated, presetModels);
    const capGate = evaluateCapabilities(curated.requiredCapabilities);
    const implemented = isAdapterImplemented(curated.protocol) && capGate.supported;
    presetEntries.set(curated.id, {
      id: curated.id,
      revision: curated.presetRevision,
      preset: providerPreset,
      curated,
      implemented,
      requiresUpgrade: capGate.requiresUpgrade,
      missingCapabilities: capGate.missingCapabilities,
    });

    const verifiedSet = new Set<string>();
    for (const candidateUrl of [curated.baseUrl, ...(curated.alternateBaseUrls ?? [])]) {
      const normalized = normalizeEndpointForMatch(candidateUrl);
      if (normalized) verifiedSet.add(normalized);
    }
    verifiedEndpointsByPreset.set(curated.id, verifiedSet);
  }

  const orderedEntries = bundle.presets
    .map((p) => presetEntries.get(p.id))
    .filter((e): e is CatalogPresetEntry => e !== undefined);

  return Object.freeze({
    revision: bundle.catalogRevision,
    bundle,
    getPreset(presetId: string): CatalogPresetEntry | undefined {
      return presetEntries.get(presetId);
    },
    listPresets(): readonly CatalogPresetEntry[] {
      return orderedEntries;
    },
    listKnownModels(presetId: string): readonly ModelInfo[] {
      return presetEntries.get(presetId)?.preset.knownModels ?? [];
    },
    listCuratedModels(presetId: string): readonly CuratedModelEntry[] {
      return modelsByPreset.get(presetId) ?? [];
    },
    getCuratedModel(presetId: string | undefined, modelId: string): CuratedModelEntry | undefined {
      if (!presetId) return undefined;
      return (modelsByPreset.get(presetId) ?? []).find((m) => m.id === modelId);
    },
    getModelInfo(presetId: string | undefined, modelId: string): ModelInfo | undefined {
      if (!presetId) return undefined;
      return presetEntries.get(presetId)?.preset.knownModels?.find((m) => m.id === modelId);
    },
    getRoleRecommendation(role: ModelRoleId): RoleRecommendation | undefined {
      const rec = bundle.recommendations.find(
        (r) => r.role === role && evaluateCapabilities(r.requiredCapabilities).supported,
      );
      if (!rec) return undefined;
      return {
        provider: rec.presetId as RoleRecommendation["provider"],
        model: rec.modelId,
        rationale: rec.rationale,
        evidenceSource: rec.evidenceSource,
        verifiedAt: rec.verifiedAt,
        ...(rec.replacementReason ? { replacementReason: rec.replacementReason } : {}),
      };
    },
    getCuratedRecommendations(role?: ModelRoleId): readonly CuratedRecommendation[] {
      return bundle.recommendations.filter(
        (r) =>
          (role === undefined || r.role === role) &&
          evaluateCapabilities(r.requiredCapabilities).supported,
      );
    },
    resolveAttentionCapability(
      modelId: string,
      override?: ModelCapabilityOverride,
    ): ModelCapability {
      const normalized = normalizeModelId(modelId);
      const curatedThreshold = bundle.attentionThresholds[normalized];
      const base: ModelCapability = curatedThreshold
        ? {
            modelId: curatedThreshold.modelKey,
            optimalMaxTokens: curatedThreshold.optimalMaxTokens,
            riskMaxTokens: curatedThreshold.riskMaxTokens,
          }
        : { ...UNKNOWN_MODEL_CAPABILITY, modelId: normalized };
      if (!override) return base;
      return {
        modelId: base.modelId,
        optimalMaxTokens: override.optimalMaxTokens ?? base.optimalMaxTokens,
        riskMaxTokens: override.riskMaxTokens ?? base.riskMaxTokens,
      };
    },
    isAdapterImplemented,
    isVerifiedPublicPresetEndpoint(presetId: string | undefined, endpoint: string): boolean {
      const normalized = normalizeEndpointForMatch(endpoint);
      if (!normalized) return false;
      if (presetId) {
        return verifiedEndpointsByPreset.get(presetId)?.has(normalized) ?? false;
      }
      for (const endpoints of verifiedEndpointsByPreset.values()) {
        if (endpoints.has(normalized)) return true;
      }
      return false;
    },
    getPresetUpdateSuggestion(
      connectionId: string,
      connection: ModelConnectionConfig,
    ): PresetUpdateSuggestion | undefined {
      if (!connection.presetId) return undefined;
      const entry = presetEntries.get(connection.presetId);
      if (!entry || entry.requiresUpgrade || !entry.implemented) return undefined;
      if (connection.ignoredPresetRevision === entry.revision) return undefined;

      const currentNorm = normalizeEndpointForMatch(connection.endpoint);
      const suggestedNorm = normalizeEndpointForMatch(entry.curated.baseUrl);
      const isAlternateOfficial =
        currentNorm !== null &&
        (entry.curated.alternateBaseUrls ?? []).some(
          (alt) => normalizeEndpointForMatch(alt) === currentNorm,
        );
      // 仅当预设修订推进且主地址（非合理地域备用地址）或默认协议变化时提示更新建议
      const endpointChanged =
        Boolean(currentNorm && suggestedNorm && currentNorm !== suggestedNorm && !isAlternateOfficial);
      const adapterChanged =
        connection.adapter !== entry.curated.protocol &&
        !(entry.curated.allowedProtocols?.includes(connection.adapter) ?? false);
      const revisionAdvanced =
        connection.presetRevision !== undefined && connection.presetRevision !== entry.revision;
      if (!endpointChanged && !adapterChanged) return undefined;
      if (!revisionAdvanced && connection.presetRevision === entry.revision) return undefined;

      return {
        connectionId,
        presetId: connection.presetId,
        ...(connection.presetRevision ? { currentPresetRevision: connection.presetRevision } : {}),
        nextPresetRevision: entry.revision,
        currentEndpoint: connection.endpoint,
        suggestedEndpoint: entry.curated.baseUrl,
        currentAdapter: connection.adapter,
        suggestedAdapter: entry.curated.protocol,
        endpointChanged,
        adapterChanged,
      };
    },
  });
}

export function createBuiltinModelCatalogPort(): ModelCatalogPort {
  return createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG);
}

export const DEFAULT_MODEL_CATALOG_PORT: ModelCatalogPort = createBuiltinModelCatalogPort();
