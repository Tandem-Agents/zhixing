/**
 * ModelBudgetInfo Resolver — 从 provider.models / 配置 overrides / 保守默认
 * 中解析出上下文预算所需的模型信息。
 *
 * 职责归属：
 *   "provider + model → ModelBudgetInfo" 这个解析行为原来散落在 run-agent.ts
 *   的两行业务代码中（`provider.models.find(...) ?? provider.models[0]`），
 *   异常路径藏在 optional 链里 —— 找不到模型时 modelBudgetInfo=undefined，
 *   ContextEngine 静默不启用，无任何日志。
 *
 *   本模块把解析职责抽成独立函数，通过 `source` + `warnings` 字段把异常态
 *   强制暴露到类型系统上。调用方必须显式处理 fallback 场景。
 *
 * 为什么放在 core 而不是 cli：
 *   server 路径（daemon）未来接入时也会面对同样的解析，core 是更通用的家。
 *   这里不直接 import @zhixing/providers 的 ZhixingConfig，而是接收 pure
 *   Record<string, Partial<ModelBudgetInfo>> 作为 overrides —— 调用方
 *   从自己的配置结构提取，保持 core 不反向依赖 providers。
 */

import type { ModelInfo } from "../types/llm.js";
import type { ModelBudgetInfo } from "./budget.js";

// ─── 来源标签 ───

/**
 * 解析来源：
 *   - override: 用户在配置中为此 model 显式覆盖了字段
 *   - declared: provider 声明列表中有此 model（原路径）
 *   - fallback: 全部失败，启用保守默认值（确保 compact 仍工作）
 */
export type ResolutionSource = "override" | "declared" | "fallback";

// ─── 警告 ───

export type ResolutionWarningCode =
  | "MODEL_NOT_FOUND"
  | "NO_DECLARED_MODELS"
  | "USING_FALLBACK";

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
  /** 解析过程中的警告（MODEL_NOT_FOUND / USING_FALLBACK 等） */
  readonly warnings: readonly ResolutionWarning[];
}

// ─── 保守默认 ───

/**
 * 保守默认值：32K 上下文 + 4K 输出预留。
 *
 * 选定原则：
 *   - 32K 是 2024-2025 大多数主流模型的最低上下文水位
 *   - 4K 输出充足覆盖普通对话
 *   - 宁可高估输出预留（多保留 token 空间），不低估
 *
 * 当所有查找途径都失败时启用，确保 ContextEngine 永不 undefined。
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
  /** Provider 声明的模型列表 */
  readonly providerModels: readonly ModelInfo[];
  /**
   * 用户覆盖表：key = modelId，value = 部分 ModelBudgetInfo 字段。
   * 允许用户只覆盖 contextWindow 而保留 maxOutputTokens 等。
   *
   * 来源通常是 ZhixingConfig.providers.<providerId>.modelOverrides，
   * 调用方（cli/server）负责提取。
   */
  readonly overrides?: Record<string, Partial<ModelBudgetInfo>>;
}

// ─── 核心解析 ───

/**
 * 解析模型预算信息。
 *
 * 优先级（高到低）：
 *   1. overrides[model] 存在 → 与 declared model（若找到）合并或基于 fallback
 *      合并 → source = "override"
 *   2. providerModels 中 id === model → source = "declared"
 *   3. providerModels 非空但无匹配 → 用 providerModels[0]
 *      + warn(MODEL_NOT_FOUND) → source = "declared"
 *   4. providerModels 为空 → CONSERVATIVE_FALLBACK
 *      + warn(NO_DECLARED_MODELS) + warn(USING_FALLBACK) → source = "fallback"
 */
export function resolveModelInfo(
  input: ResolveModelInfoInput,
): ResolvedModelInfo {
  const { providerId, model, providerModels, overrides } = input;
  const warnings: ResolutionWarning[] = [];

  // 先定位 declared 模型（如果有）
  const declaredMatch = providerModels.find((m) => m.id === model);
  const declaredFallback = declaredMatch ?? providerModels[0];

  // override 路径 —— 按 base 的三种来源分支，类型系统显式收窄
  const override = overrides?.[model];
  if (override) {
    // 1) 精确匹配 declared：override 直接叠加
    if (declaredMatch) {
      return {
        info: mergeBudget(toBudget(declaredMatch), override),
        source: "override",
        warnings,
      };
    }

    // 2) providerModels 非空但 model 名不匹配：用第一个作 base，带 warning
    if (declaredFallback !== undefined) {
      warnings.push({
        code: "MODEL_NOT_FOUND",
        message: `Model "${model}" not found in provider "${providerId}"; override applied on top of declared fallback "${declaredFallback.id}".`,
      });
      return {
        info: mergeBudget(toBudget(declaredFallback), override),
        source: "override",
        warnings,
      };
    }

    // 3) providerModels 完全为空：基于保守默认合并 override
    return {
      info: mergeBudget(CONSERVATIVE_FALLBACK, override),
      source: "override",
      warnings,
    };
  }

  // declared 精确匹配
  if (declaredMatch) {
    return {
      info: toBudget(declaredMatch),
      source: "declared",
      warnings,
    };
  }

  // declared 有但模型名不匹配
  if (declaredFallback) {
    warnings.push({
      code: "MODEL_NOT_FOUND",
      message: `Model "${model}" not found in provider "${providerId}"; using first declared model "${declaredFallback.id}" as fallback.`,
    });
    return {
      info: toBudget(declaredFallback),
      source: "declared",
      warnings,
    };
  }

  // 完全 fallback
  warnings.push({
    code: "NO_DECLARED_MODELS",
    message: `Provider "${providerId}" declares no models.`,
  });
  warnings.push({
    code: "USING_FALLBACK",
    message: `Using conservative fallback {contextWindow: ${CONSERVATIVE_FALLBACK.contextWindow}, maxOutputTokens: ${CONSERVATIVE_FALLBACK.maxOutputTokens}} — context management is active but may be suboptimal. Consider adding "modelOverrides" to provider config.`,
  });
  return {
    info: { ...CONSERVATIVE_FALLBACK },
    source: "fallback",
    warnings,
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
