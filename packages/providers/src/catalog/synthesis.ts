/**
 * 硬约束 / 资料 / 偏好三层合成引擎、分字段来源追踪与结构化非对话过滤（设计 §1.3、§1.4、§2.2.4）。
 *
 * 核心不变量：
 * 1. **硬约束不可突破**：本地适配能力、已确认权威原生限制（如权威直连上限/否定能力）绝不可被
 *    用户 `modelOverrides` 突破；冲突时保留用户输入，产出结构化 `overrideConflicts` 并钳制有效值。
 * 2. **资料按字段独立合成**：缺省字段不抹除已有值，显式 `false` 保留否定语义；
 *    第三方聚合端（如 OpenRouter）声明归资料层，不作硬约束，可被用户覆盖并记录提示。
 * 3. **偏好独立**：`hiddenModels`、`customModels` 与 `main/light/power` 绑定不受上游目录刷新改写。
 * 4. **结构化非对话过滤**：仅当存在明确结构化非对话断言（`purpose !== "chat"`、`outputModalities`、
 *    `type`/`subType`、`supportedGenerationMethods`）时过滤；严禁按模型名称关键字启发式隐藏。
 */

import type { ModelInfo, ThinkingControl } from "@zhixing-ai/core";
import type { ModelConnectionConfig, ModelSpecOverride } from "../types.js";
import { BUILTIN_CURATED_CATALOG } from "./builtin-catalog.js";
import {
  evaluateCapabilities,
  type CatalogLifecycle,
  type CuratedCatalogBundle,
  type CuratedModelEntry,
  type CuratedRecommendation,
  type ModelPricingInfo,
  type ModelPurpose,
} from "./schema.js";

export type FieldProvenanceSource =
  | "user-override"
  | "native-discovery"
  | "curated-catalog"
  | "builtin-baseline"
  | "unknown";

export interface SourcedField<T> {
  readonly value: T | undefined;
  readonly source: FieldProvenanceSource;
  /** 仅第三方非权威发现（如 OpenRouter）为 true。 */
  readonly thirdPartyUnverified?: boolean;
}

export interface HardConstraintConflict {
  readonly field:
    | "contextWindow"
    | "maxOutputTokens"
    | "supportsImages"
    | "supportsTools"
    | "supportsThinking";
  readonly requestedValue: number | boolean;
  readonly hardLimit: number | boolean;
  readonly constraintSource: string;
  readonly message: string;
}

/** 经原生发现或可选兼容探测返回的脱敏结构化模型条目（不含原始 SDK 响应或秘密）。 */
export interface DiscoveredModelRecord {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsTools?: boolean;
  readonly supportsImages?: boolean;
  readonly supportsThinking?: boolean;
  readonly lifecycle?: CatalogLifecycle;
  /** 显式结构化用途或模态断言（缺失表示未知，绝不凭名称猜测）。 */
  readonly purpose?: ModelPurpose;
  readonly outputModalities?: readonly string[];
  readonly inputModalities?: readonly string[];
  readonly nativeType?: string;
  readonly nativeSubType?: string;
  readonly supportedGenerationMethods?: readonly string[];
  readonly pricing?: ModelPricingInfo;
  readonly supportedParameters?: readonly string[];
}

export interface SynthesizedModelCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly origin: "curated" | "discovered" | "custom";
  readonly inCuratedCatalog: boolean;
  readonly discovered: boolean;
  readonly isCustom: boolean;
  readonly hidden: boolean;
  readonly lifecycle: CatalogLifecycle;
  readonly replacementModelId?: string;
  readonly lifecycleReason?: string;
  readonly requiresUpgrade: boolean;
  readonly missingCapabilities: readonly string[];
  /** `complete` = 关键规格齐备；`partial` = 部分字段未知；`unknown` = 资料不足/未知。 */
  readonly metadataStatus: "complete" | "partial" | "unknown";
  readonly fields: {
    readonly contextWindow: SourcedField<number>;
    readonly maxOutputTokens: SourcedField<number>;
    readonly supportsTools: SourcedField<boolean>;
    readonly supportsImages: SourcedField<boolean>;
    readonly supportsThinking: SourcedField<boolean>;
    readonly thinkingControl: SourcedField<ThinkingControl>;
  };
  readonly pricing?: ModelPricingInfo;
  readonly recommendedMaxOutputTokens?: number;
  readonly recommendedForRoles: readonly CuratedRecommendation[];
  /** 用户规格覆盖与权威硬约束冲突记录（保留用户输入，同时有效值已按硬约束钳制）。 */
  readonly overrideConflicts: readonly HardConstraintConflict[];
  /** 当上下文与输出上限已知时可直接喂给 core / adapter 的合成 `ModelInfo`（未知字段绝不瞎编）。 */
  readonly modelInfo?: ModelInfo;
}

export interface SynthesizeConnectionModelsInput {
  readonly connectionId: string;
  readonly connection: ModelConnectionConfig;
  readonly catalog: CuratedCatalogBundle;
  readonly bundledCatalog?: CuratedCatalogBundle;
  readonly discoveredModels?: readonly DiscoveredModelRecord[];
  /** 发现字段是否具有当前连接权威硬约束资格（第三方聚合端 OpenRouter 或未核实改址为 false）。 */
  readonly discoveredAuthoritative?: boolean;
  /** 显式服务端已证实的硬约束（可选，按精确 modelId 索引）。 */
  readonly serverConfirmedHardLimits?: Readonly<
    Record<
      string,
      {
        readonly contextWindow?: number;
        readonly maxOutputTokens?: number;
        readonly supportsImages?: boolean;
        readonly supportsTools?: boolean;
        readonly supportsThinking?: boolean;
      }
    >
  >;
  readonly adapterImplemented?: boolean;
  readonly includeHidden?: boolean;
  /** 运行侧解析置 true：把仅出现在 `connection.modelOverrides` 中的精确型号也纳入同一三层合成与硬约束钳制。 */
  readonly includeOverrideOnlyIds?: boolean;
  /** 可选本地已实现能力集合（缺省使用 `LOCAL_SUPPORTED_CATALOG_CAPABILITIES`）。 */
  readonly localCapabilities?: readonly string[];
}

export interface SynthesizedConnectionModelsResult {
  readonly models: readonly SynthesizedModelCandidate[];
  readonly hiddenModels: readonly SynthesizedModelCandidate[];
  readonly filteredNonChatCount: number;
  readonly filteredNonChatIds: readonly string[];
}

const NON_CHAT_MODALITIES = new Set([
  "embedding",
  "embeddings",
  "rerank",
  "tts",
  "stt",
  "audio",
  "speech",
  "image",
  "images",
  "video",
  "moderation",
]);

const CHAT_MODALITIES = new Set(["text", "chat", "multimodal"]);

const NON_CHAT_TYPES = new Set([
  "embedding",
  "embeddings",
  "rerank",
  "reranker",
  "tts",
  "stt",
  "asr",
  "audio",
  "speech",
  "image",
  "text-to-image",
  "image-generation",
  "video",
  "text-to-video",
  "moderation",
]);

const GOOGLE_CHAT_METHODS = new Set([
  "generatecontent",
  "streamgeneratecontent",
  "interactions",
  "createinteraction",
]);

/**
 * 严格结构化非对话过滤（设计 §1.3）：
 * 只过滤满足明确结构化断言的非对话条目；无明确用途字段一律保留（绝不凭模型名称关键字启发式隐藏）。
 */
export function isStructuredNonChatModel(input: {
  readonly curated?: Pick<CuratedModelEntry, "purpose">;
  readonly discovered?: Pick<
    DiscoveredModelRecord,
    "purpose" | "outputModalities" | "nativeType" | "nativeSubType" | "supportedGenerationMethods"
  >;
}): boolean {
  if (input.curated?.purpose !== undefined) {
    return input.curated.purpose !== "chat";
  }
  const d = input.discovered;
  if (!d) return false;

  if (d.purpose !== undefined) {
    return d.purpose !== "chat";
  }

  // 1. 明确声明 outputModalities 且全为非文本/非对话模态
  if (d.outputModalities && d.outputModalities.length > 0) {
    const normalized = d.outputModalities.map((m) => m.trim().toLowerCase()).filter(Boolean);
    if (
      normalized.length > 0 &&
      !normalized.some((m) => CHAT_MODALITIES.has(m)) &&
      normalized.every((m) => NON_CHAT_MODALITIES.has(m))
    ) {
      return true;
    }
  }

  // 2. 明确声明 nativeType / nativeSubType 属于非对话类型（如 SiliconFlow / DashScope）
  const typeVal = d.nativeType?.trim().toLowerCase();
  const subTypeVal = d.nativeSubType?.trim().toLowerCase();
  if (subTypeVal && NON_CHAT_TYPES.has(subTypeVal)) {
    return true;
  }
  if (typeVal && NON_CHAT_TYPES.has(typeVal)) {
    return true;
  }

  // 3. Google native `supportedGenerationMethods` 存在且非空，但完全不含对话生成方法
  if (d.supportedGenerationMethods && d.supportedGenerationMethods.length > 0) {
    const methods = d.supportedGenerationMethods.map((m) => m.trim().toLowerCase()).filter(Boolean);
    if (methods.length > 0 && !methods.some((m) => GOOGLE_CHAT_METHODS.has(m))) {
      return true;
    }
  }

  // 无明确结构化非对话断言：一律保留，绝不靠名称关键字猜测
  return false;
}

/**
 * 合成单个连接上的候选模型列表（硬约束 → 资料分字段合成 → 用户偏好）。
 */
export function synthesizeConnectionModels(
  input: SynthesizeConnectionModelsInput,
): SynthesizedConnectionModelsResult {
  const bundled = input.bundledCatalog ?? BUILTIN_CURATED_CATALOG;
  const presetId = input.connection.presetId;
  const preset = presetId
    ? input.catalog.presets.find((p) => p.id === presetId)
    : undefined;
  const isOfficialPresetEndpoint = (() => {
    if (!preset) return false;
    if (preset.discovery.kind === "ollama-tags") return true;
    try {
      const targetOrigin = new URL(input.connection.endpoint).origin.toLowerCase();
      const officialOrigins = [
        preset.baseUrl,
        ...(preset.alternateBaseUrls ?? []),
        ...(preset.discovery.verifiedOrigins ?? []),
      ];
      return officialOrigins.some((u) => {
        try {
          return new URL(u).origin.toLowerCase() === targetOrigin;
        } catch {
          return u.trim().toLowerCase() === targetOrigin;
        }
      });
    } catch {
      return false;
    }
  })();
  const discoveredAuthoritative =
    input.discoveredAuthoritative ??
    (isOfficialPresetEndpoint ? (preset?.discovery.authoritativeNativeFacts ?? false) : false);

  const curatedById = new Map<string, CuratedModelEntry>();
  if (presetId) {
    for (const m of input.catalog.models) {
      if (m.presetId === presetId) curatedById.set(m.id, m);
    }
  }
  const bundledById = new Map<string, CuratedModelEntry>();
  if (presetId) {
    for (const m of bundled.models) {
      if (m.presetId === presetId) bundledById.set(m.id, m);
    }
  }
  const discoveredById = new Map<string, DiscoveredModelRecord>();
  for (const d of input.discoveredModels ?? []) {
    discoveredById.set(d.id, d);
  }
  const customSet = new Set(input.connection.customModels ?? []);
  const hiddenSet = new Set(input.connection.hiddenModels ?? []);
  const overridesMap = input.connection.modelOverrides ?? {};

  // 保序汇总所有精确 modelId（不改写原始 ID）
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    orderedIds.push(id);
  };
  for (const m of curatedById.keys()) addId(m);
  for (const d of discoveredById.keys()) addId(d);
  for (const c of customSet) addId(c);
  if (input.includeOverrideOnlyIds) {
    for (const o of Object.keys(overridesMap)) addId(o);
  }

  const visibleModels: SynthesizedModelCandidate[] = [];
  const hiddenModels: SynthesizedModelCandidate[] = [];
  const filteredNonChatIds: string[] = [];

  for (const modelId of orderedIds) {
    const curated = curatedById.get(modelId);
    const baseline = bundledById.get(modelId);
    const discovered = discoveredById.get(modelId);
    const isCustom = customSet.has(modelId);

    // 非用户显式手填的自定义模型：按严格结构化断言过滤非对话条目
    if (!isCustom && isStructuredNonChatModel({ curated, discovered })) {
      filteredNonChatIds.push(modelId);
      continue;
    }

    const userOverride: ModelSpecOverride | undefined = overridesMap[modelId];
    const serverHard = input.serverConfirmedHardLimits?.[modelId];
    const overrideConflicts: HardConstraintConflict[] = [];

    // ─── Layer 1: 权威硬约束（仅来自当前连接权威原生发现或服务端明证，第三方聚合不作硬约束）───
    const hardContextWindow =
      serverHard?.contextWindow ??
      (discoveredAuthoritative ? discovered?.contextWindow : undefined);
    const hardMaxOutputTokens =
      serverHard?.maxOutputTokens ??
      (discoveredAuthoritative ? discovered?.maxOutputTokens : undefined);
    const hardSupportsImagesFalse =
      serverHard?.supportsImages === false
        ? { source: "服务端已证实能力限制" }
        : discoveredAuthoritative && discovered?.supportsImages === false
          ? { source: "当前连接权威原生发现声明" }
          : undefined;
    const hardSupportsToolsFalse =
      serverHard?.supportsTools === false
        ? { source: "服务端已证实能力限制" }
        : discoveredAuthoritative && discovered?.supportsTools === false
          ? { source: "当前连接权威原生发现声明" }
          : undefined;
    const hardSupportsThinkingFalse =
      serverHard?.supportsThinking === false
        ? { source: "服务端已证实能力限制" }
        : discoveredAuthoritative && discovered?.supportsThinking === false
          ? { source: "当前连接权威原生发现声明" }
          : undefined;

    // ─── Layer 2: 分字段独立合成（显式 false 保留否定含义，缺省不抹除已有值）───
    const contextWindowField = resolveNumericField({
      field: "contextWindow",
      userValue: userOverride?.contextWindow,
      discoveredValue: discovered?.contextWindow,
      discoveredAuthoritative,
      curatedValue: curated?.contextWindow,
      baselineValue: baseline?.contextWindow,
      hardMax: hardContextWindow,
      hardSource: serverHard?.contextWindow !== undefined ? "服务端已证实上限" : "当前连接权威原生上限",
      conflicts: overrideConflicts,
    });

    const maxOutputField = resolveNumericField({
      field: "maxOutputTokens",
      userValue: userOverride?.maxOutputTokens,
      discoveredValue: discovered?.maxOutputTokens,
      discoveredAuthoritative,
      curatedValue: curated?.maxOutputTokens,
      baselineValue: baseline?.maxOutputTokens,
      hardMax: hardMaxOutputTokens,
      hardSource:
        serverHard?.maxOutputTokens !== undefined ? "服务端已证实输出上限" : "当前连接权威原生输出上限",
      conflicts: overrideConflicts,
    });

    const supportsImagesField = resolveBooleanField({
      field: "supportsImages",
      userValue: userOverride?.supportsImages,
      discoveredValue: discovered?.supportsImages,
      discoveredAuthoritative,
      curatedValue: curated?.supportsImages,
      baselineValue: baseline?.supportsImages,
      hardDeny: hardSupportsImagesFalse,
      conflicts: overrideConflicts,
    });

    const supportsToolsField = resolveBooleanField({
      field: "supportsTools",
      userValue: userOverride?.supportsTools,
      discoveredValue: discovered?.supportsTools,
      discoveredAuthoritative,
      curatedValue: curated?.supportsTools,
      baselineValue: baseline?.supportsTools,
      hardDeny: hardSupportsToolsFalse,
      conflicts: overrideConflicts,
    });

    const supportsThinkingField = resolveBooleanField({
      field: "supportsThinking",
      userValue: userOverride?.supportsThinking,
      discoveredValue: discovered?.supportsThinking,
      discoveredAuthoritative,
      curatedValue: curated?.supportsThinking,
      baselineValue: baseline?.supportsThinking,
      hardDeny: hardSupportsThinkingFalse,
      conflicts: overrideConflicts,
    });

    const thinkingControlField: SourcedField<ThinkingControl> =
      supportsThinkingField.value === false
        ? { value: { type: "none" }, source: supportsThinkingField.source }
        : userOverride?.thinkingControl !== undefined
          ? { value: userOverride.thinkingControl, source: "user-override" }
          : curated?.thinkingControl !== undefined
            ? { value: curated.thinkingControl, source: "curated-catalog" }
            : baseline?.thinkingControl !== undefined
              ? { value: baseline.thinkingControl, source: "builtin-baseline" }
              : { value: undefined, source: "unknown" };

    // 能力门控（局部标“需升级知行”，不整包作废）
    const presetGate = evaluateCapabilities(preset?.requiredCapabilities, input.localCapabilities);
    const modelGate = evaluateCapabilities(curated?.requiredCapabilities, input.localCapabilities);
    const missingCaps = [...new Set([...presetGate.missingCapabilities, ...modelGate.missingCapabilities])];
    if (input.adapterImplemented === false) {
      missingCaps.push(`adapter:${input.connection.adapter}`);
    }
    const requiresUpgrade = missingCaps.length > 0;

    // 生命周期（单次发现缺席仅作观察，绝不自动标 retired！）
    const lifecycle: CatalogLifecycle =
      curated?.lifecycle ?? discovered?.lifecycle ?? baseline?.lifecycle ?? "active";

    // 资料完整度表达（绝不把未知假装成已知）
    const knownCount = [
      contextWindowField.value !== undefined,
      maxOutputField.value !== undefined,
      supportsToolsField.value !== undefined,
    ].filter(Boolean).length;
    const metadataStatus: "complete" | "partial" | "unknown" =
      knownCount === 3 ? "complete" : knownCount > 0 ? "partial" : "unknown";

    // 仅匹配当前 preset 且未被能力门控拦截的用途推荐（解耦且不改默认）
    const recommendedForRoles: CuratedRecommendation[] = presetId
      ? input.catalog.recommendations.filter(
          (r) =>
            r.presetId === presetId &&
            r.modelId === modelId &&
            evaluateCapabilities(r.requiredCapabilities, input.localCapabilities).supported,
        )
      : [];

    const recommendedMaxOutputTokens =
      curated?.recommendedMaxOutputTokens ?? baseline?.recommendedMaxOutputTokens;

    const modelInfo: ModelInfo | undefined =
      contextWindowField.value !== undefined && maxOutputField.value !== undefined
        ? {
            id: modelId,
            name: curated?.name ?? discovered?.name ?? baseline?.name ?? modelId,
            contextWindow: contextWindowField.value,
            maxOutputTokens: maxOutputField.value,
            ...(recommendedMaxOutputTokens !== undefined
              ? { recommendedMaxOutputTokens }
              : {}),
            supportsTools: supportsToolsField.value ?? true,
            ...(supportsImagesField.value !== undefined
              ? { supportsImages: supportsImagesField.value }
              : {}),
            ...(supportsThinkingField.value !== undefined
              ? { supportsThinking: supportsThinkingField.value }
              : {}),
            ...(thinkingControlField.value !== undefined
              ? { thinkingControl: thinkingControlField.value }
              : {}),
          }
        : undefined;

    const candidate: SynthesizedModelCandidate = {
      id: modelId,
      displayName: curated?.name ?? discovered?.name ?? baseline?.name ?? modelId,
      origin: curated ? "curated" : discovered ? "discovered" : "custom",
      inCuratedCatalog: Boolean(curated),
      discovered: Boolean(discovered),
      isCustom,
      hidden: hiddenSet.has(modelId),
      lifecycle,
      ...(curated?.replacementModelId ? { replacementModelId: curated.replacementModelId } : {}),
      ...(curated?.lifecycleReason ? { lifecycleReason: curated.lifecycleReason } : {}),
      requiresUpgrade,
      missingCapabilities: missingCaps,
      metadataStatus,
      fields: {
        contextWindow: contextWindowField,
        maxOutputTokens: maxOutputField,
        supportsTools: supportsToolsField,
        supportsImages: supportsImagesField,
        supportsThinking: supportsThinkingField,
        thinkingControl: thinkingControlField,
      },
      ...(discovered?.pricing ?? curated?.pricing ?? baseline?.pricing
        ? { pricing: discovered?.pricing ?? curated?.pricing ?? baseline?.pricing }
        : {}),
      ...(curated?.recommendedMaxOutputTokens ?? baseline?.recommendedMaxOutputTokens
        ? {
            recommendedMaxOutputTokens:
              curated?.recommendedMaxOutputTokens ?? baseline?.recommendedMaxOutputTokens,
          }
        : {}),
      recommendedForRoles,
      overrideConflicts,
      ...(modelInfo ? { modelInfo } : {}),
    };

    if (candidate.hidden) {
      hiddenModels.push(candidate);
      if (input.includeHidden) visibleModels.push(candidate);
    } else {
      visibleModels.push(candidate);
    }
  }

  return {
    models: visibleModels,
    hiddenModels,
    filteredNonChatCount: filteredNonChatIds.length,
    filteredNonChatIds,
  };
}

/** 独立校验用户规格覆盖是否突破硬约束（保留原用户输入，返回冲突清单供编辑页展示与纠正）。 */
export function validateModelSpecOverrideAgainstHardConstraints(
  override: ModelSpecOverride,
  hardLimits: {
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly supportsImages?: boolean;
    readonly supportsTools?: boolean;
    readonly supportsThinking?: boolean;
    readonly constraintSource?: string;
  },
): readonly HardConstraintConflict[] {
  const conflicts: HardConstraintConflict[] = [];
  const src = hardLimits.constraintSource ?? "当前连接权威硬约束";
  if (
    override.contextWindow !== undefined &&
    hardLimits.contextWindow !== undefined &&
    override.contextWindow > hardLimits.contextWindow
  ) {
    conflicts.push({
      field: "contextWindow",
      requestedValue: override.contextWindow,
      hardLimit: hardLimits.contextWindow,
      constraintSource: src,
      message: `覆盖值 contextWindow=${override.contextWindow} 超过${src}（${hardLimits.contextWindow}），已保留你的输入但运行上限仍受硬约束限制；可刷新核实或改用更保守值。`,
    });
  }
  if (
    override.maxOutputTokens !== undefined &&
    hardLimits.maxOutputTokens !== undefined &&
    override.maxOutputTokens > hardLimits.maxOutputTokens
  ) {
    conflicts.push({
      field: "maxOutputTokens",
      requestedValue: override.maxOutputTokens,
      hardLimit: hardLimits.maxOutputTokens,
      constraintSource: src,
      message: `覆盖值 maxOutputTokens=${override.maxOutputTokens} 超过${src}（${hardLimits.maxOutputTokens}），已保留你的输入但运行上限仍受硬约束限制；可刷新核实或改用更保守值。`,
    });
  }
  if (override.supportsImages === true && hardLimits.supportsImages === false) {
    conflicts.push({
      field: "supportsImages",
      requestedValue: true,
      hardLimit: false,
      constraintSource: src,
      message: `覆盖值 supportsImages=true 与${src}（不支持图片输入）冲突，已保留你的输入但运行仍按硬约束拒绝图片发送；可刷新核实或恢复默认。`,
    });
  }
  if (override.supportsTools === true && hardLimits.supportsTools === false) {
    conflicts.push({
      field: "supportsTools",
      requestedValue: true,
      hardLimit: false,
      constraintSource: src,
      message: `覆盖值 supportsTools=true 与${src}（不支持工具调用）冲突，已保留你的输入但运行仍按硬约束保持 false；可刷新核实或恢复默认。`,
    });
  }
  if (override.supportsThinking === true && hardLimits.supportsThinking === false) {
    conflicts.push({
      field: "supportsThinking",
      requestedValue: true,
      hardLimit: false,
      constraintSource: src,
      message: `覆盖值 supportsThinking=true 与${src}（不支持思考能力）冲突，已保留你的输入但运行仍按硬约束保持 false；可刷新核实或恢复默认。`,
    });
  }
  return conflicts;
}

function resolveNumericField(args: {
  field: "contextWindow" | "maxOutputTokens";
  userValue?: number;
  discoveredValue?: number;
  discoveredAuthoritative: boolean;
  curatedValue?: number;
  baselineValue?: number;
  hardMax?: number;
  hardSource: string;
  conflicts: HardConstraintConflict[];
}): SourcedField<number> {
  if (args.userValue !== undefined) {
    if (args.hardMax !== undefined && args.userValue > args.hardMax) {
      args.conflicts.push({
        field: args.field,
        requestedValue: args.userValue,
        hardLimit: args.hardMax,
        constraintSource: args.hardSource,
        message: `覆盖值 ${args.field}=${args.userValue} 超过${args.hardSource}（${args.hardMax}），已保留你的输入但有效上限已按硬约束钳制为 ${args.hardMax}；可刷新核实或改用更保守值。`,
      });
      return { value: args.hardMax, source: "native-discovery" };
    }
    return { value: args.userValue, source: "user-override" };
  }
  if (args.discoveredValue !== undefined) {
    const clamped =
      args.hardMax !== undefined && args.discoveredValue > args.hardMax
        ? args.hardMax
        : args.discoveredValue;
    return {
      value: clamped,
      source: "native-discovery",
      ...(!args.discoveredAuthoritative && clamped === args.discoveredValue
        ? { thirdPartyUnverified: true }
        : {}),
    };
  }
  if (args.curatedValue !== undefined) {
    if (args.hardMax !== undefined && args.curatedValue > args.hardMax) {
      return { value: args.hardMax, source: "native-discovery" };
    }
    return { value: args.curatedValue, source: "curated-catalog" };
  }
  if (args.baselineValue !== undefined) {
    if (args.hardMax !== undefined && args.baselineValue > args.hardMax) {
      return { value: args.hardMax, source: "native-discovery" };
    }
    return { value: args.baselineValue, source: "builtin-baseline" };
  }
  if (args.hardMax !== undefined) {
    return { value: args.hardMax, source: "native-discovery" };
  }
  return { value: undefined, source: "unknown" };
}

function booleanCapabilityDenyNoun(
  field: "supportsImages" | "supportsTools" | "supportsThinking",
): string {
  switch (field) {
    case "supportsImages":
      return "不支持图片";
    case "supportsTools":
      return "不支持工具调用";
    case "supportsThinking":
      return "不支持思考能力";
  }
}

function resolveBooleanField(args: {
  field: "supportsImages" | "supportsTools" | "supportsThinking";
  userValue?: boolean;
  discoveredValue?: boolean;
  discoveredAuthoritative: boolean;
  curatedValue?: boolean;
  baselineValue?: boolean;
  hardDeny?: { readonly source: string };
  conflicts: HardConstraintConflict[];
}): SourcedField<boolean> {
  if (args.userValue !== undefined) {
    if (args.userValue === true && args.hardDeny) {
      args.conflicts.push({
        field: args.field,
        requestedValue: true,
        hardLimit: false,
        constraintSource: args.hardDeny.source,
        message: `覆盖值 ${args.field}=true 与${args.hardDeny.source}（${booleanCapabilityDenyNoun(args.field)}）冲突，已保留你的输入但有效值仍保持 false；可刷新核实或清除覆盖。`,
      });
      return { value: false, source: "native-discovery" };
    }
    return { value: args.userValue, source: "user-override" };
  }
  if (args.hardDeny) {
    return { value: false, source: "native-discovery" };
  }
  if (args.discoveredValue !== undefined) {
    return {
      value: args.discoveredValue,
      source: "native-discovery",
      ...(!args.discoveredAuthoritative ? { thirdPartyUnverified: true } : {}),
    };
  }
  if (args.curatedValue !== undefined) {
    return { value: args.curatedValue, source: "curated-catalog" };
  }
  if (args.baselineValue !== undefined) {
    return { value: args.baselineValue, source: "builtin-baseline" };
  }
  return { value: undefined, source: "unknown" };
}
