/**
 * ModelBudgetInfo Resolver — 把多源 budget 数据合成 ContextEngine 需要的
 * `{ contextWindow, maxOutputTokens }`，并显式暴露解析来源。
 *
 * 数据源四层（从高到低）：
 *   1. overrides[model]            — 用户在配置中精确覆盖（最高优先级）
 *   2. providerModels.find(id===)  — Provider declared catalog 命中
 *   3. protocolDefaults            — 协议族级默认（如 OpenAI 兼容 128K/4K）
 *   4. CONSERVATIVE_FALLBACK       — core 层 defensive 兜底（生产路径不应触达，
 *                                     仅在调用方未注入 protocolDefaults 时启用）
 *
 * 设计要点：
 *   - LLMProvider.models 是 declared catalog，可以为空数组——网关型 provider
 *     一个实例承载海量 model，无法预先列举。catalog 之外的 model 走第 3 层。
 *   - core 不知道 protocol 字符串（"openai-compatible" 等），调用方
 *     （cli/server）从 ResolvedProvider.protocol 查 PROTOCOL_BUDGET_DEFAULTS 后
 *     以 ModelBudgetInfo 形状注入。保持 core ← providers 单向依赖。
 */

import type { ModelInfo } from "../types/llm.js";
import type { ModelBudgetInfo } from "./budget.js";

// ─── 来源标签 ───

/**
 * 解析来源：
 *   - override         : 用户在配置中为此 model 显式覆盖
 *   - declared         : provider catalog 命中
 *   - protocol-default : 协议族级默认（catalog 未命中且调用方提供了 protocolDefaults）
 *   - fallback         : 调用方未提供 protocolDefaults 时的 defensive 兜底
 */
export type ResolutionSource =
  | "override"
  | "declared"
  | "protocol-default"
  | "fallback";

// ─── 警告 ───

export type ResolutionWarningCode = "USING_FALLBACK";

export interface ResolutionWarning {
  readonly code: ResolutionWarningCode;
  readonly message: string;
}

// ─── 结果 ───

export interface ResolvedModelInfo {
  /** 解析出的 ModelBudgetInfo（永不为 undefined） */
  readonly info: ModelBudgetInfo;
  /** 解析来源，调用方可据此决定日志级别 */
  readonly source: ResolutionSource;
  /** 解析过程中的警告（仅在 fallback 路径产生） */
  readonly warnings: readonly ResolutionWarning[];
}

// ─── 保守默认 ───

/**
 * 保守默认值：32K 上下文 + 4K 输出预留。
 *
 * 这是 core 层 defensive 兜底——仅当调用方未注入 protocolDefaults 时启用，
 * 正常生产路径（CLI/server）不应触达。设计目的是确保 `info` 永不为 undefined，
 * ContextEngine 永远可启用，避免静默禁用 compact 这类隐蔽故障。
 */
export const CONSERVATIVE_FALLBACK: ModelBudgetInfo = {
  contextWindow: 32_000,
  maxOutputTokens: 4_000,
};

// ─── 输入 ───

export interface ResolveModelInfoInput {
  /** Provider 标识（用于 override lookup key 与 warning 文案） */
  readonly providerId: string;
  /** 当前请求的模型 ID */
  readonly model: string;
  /**
   * Provider declared catalog（已知模型元信息）。
   *
   * 网关型 provider 通常传空数组——catalog 之外的 model 由
   * protocolDefaults 兜底，不再走"列表第一个当 fallback"那种伪占位路径。
   */
  readonly providerModels: readonly ModelInfo[];
  /**
   * 用户覆盖表：key = modelId，value = 部分 ModelBudgetInfo 字段。
   * 允许用户只覆盖 contextWindow 而保留 maxOutputTokens 等。
   *
   * 来源通常是 ZhixingConfig.providers.<providerId>.modelOverrides，
   * 调用方（cli/server）负责提取。
   */
  readonly overrides?: Record<string, Partial<ModelBudgetInfo>>;
  /**
   * 协议族级 budget 默认。
   *
   * catalog 未命中且无 override 时使用——比如 OpenAI 兼容协议下，任意未声明的
   * model id 默认按 128K/4K 处理。这是网关型 provider 的合理工程兜底，
   * 用户想精调走 modelOverrides。
   *
   * 调用方（cli/server）从 PROTOCOL_BUDGET_DEFAULTS[provider.protocol] 读取
   * 后注入。core 层不感知 protocol 字符串。
   */
  readonly protocolDefaults?: ModelBudgetInfo;
}

// ─── 核心解析 ───

/**
 * 解析模型预算信息。详见模块顶部"数据源四层"。
 */
export function resolveModelInfo(
  input: ResolveModelInfoInput,
): ResolvedModelInfo {
  const { providerId, model, providerModels, overrides, protocolDefaults } =
    input;

  const declaredMatch = providerModels.find((m) => m.id === model);

  // 1) override 路径——按 base 来源分支，类型系统显式收窄
  const override = overrides?.[model];
  if (override) {
    const base =
      (declaredMatch ? toBudget(declaredMatch) : undefined) ??
      protocolDefaults ??
      CONSERVATIVE_FALLBACK;
    return {
      info: mergeBudget(base, override),
      source: "override",
      warnings: [],
    };
  }

  // 2) declared 命中
  if (declaredMatch) {
    return {
      info: toBudget(declaredMatch),
      source: "declared",
      warnings: [],
    };
  }

  // 3) protocol 默认（调用方注入）
  if (protocolDefaults) {
    return {
      info: { ...protocolDefaults },
      source: "protocol-default",
      warnings: [],
    };
  }

  // 4) defensive 兜底——生产路径不应触达
  return {
    info: { ...CONSERVATIVE_FALLBACK },
    source: "fallback",
    warnings: [
      {
        code: "USING_FALLBACK",
        message:
          `Provider "${providerId}" model "${model}" 无法解析 budget: ` +
          `catalog 未声明且调用方未注入 protocolDefaults。` +
          `使用保守默认 {${CONSERVATIVE_FALLBACK.contextWindow}/${CONSERVATIVE_FALLBACK.maxOutputTokens}}。` +
          `如属生产路径，检查调用方是否传入 protocolDefaults；想精调请配 modelOverrides。`,
      },
    ],
  };
}

// ─── 内部辅助 ───

function toBudget(m: ModelInfo): ModelBudgetInfo {
  return {
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
  };
}

function mergeBudget(
  base: ModelBudgetInfo,
  patch: Partial<ModelBudgetInfo>,
): ModelBudgetInfo {
  return {
    contextWindow: patch.contextWindow ?? base.contextWindow,
    maxOutputTokens: patch.maxOutputTokens ?? base.maxOutputTokens,
  };
}
