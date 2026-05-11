/**
 * 模型的注意力质量阈值 —— 知行内置的领域知识
 *
 * LLM 的注意力随 input token 增长而衰减。每个模型在远小于"总上下文窗口"的
 * 范围内才能稳定输出高质量结果（业界 RULER / NoLiMa 等 benchmark 共识：
 * 标称 1M 的模型实际可靠 50-65%，32K 是 NoLiMa 50% 衰减阈值）。
 *
 * 本表把这些阈值固化为知行内置常量，供上下文管理在 turn 边界评估是否需要
 * 触发段切换 —— 在 attention 阈值之前累积，触顶时整段压缩开新段。
 *
 * 职责边界：
 * - 本模块只关心 **attention 阈值**（知行的独立判断）
 * - **总窗口 / 输出上限** 等 vendor 协议层信息属于 `presets.ts.knownModels`，
 *   不在此重复定义 —— 避免双源不一致
 *
 * 与 `presets.ts`（vendor 技术配置）同性质：领域知识随知行版本演进，**不进
 * `credentials.json`**（凭证唯一入口），用户极少需要覆盖；如需覆盖通过
 * `config.jsonc` 的 functional 配置入口（与 workspace / llm 等同文件）。
 *
 * 不同服务商提供同一模型时共享同一阈值（如 DeepSeek 官方 / 硅基流动转发
 * 同型号 V4-Pro 阈值一致）。
 */

export interface ModelCapability {
  /** 模型标识符（与 `presets.ts` 的 `knownModels[].id` 命名约定一致） */
  readonly modelId: string;
  /** 注意力最好阈值上限 —— 超过此值进入"评估是否切段"窗口 */
  readonly optimalMaxTokens: number;
  /** 注意力风险阈值 —— 超过此值强制切段（即使在任务中） */
  readonly riskMaxTokens: number;
}

/**
 * 内置常量表 —— 按 modelId 完全匹配（大小写不敏感由 `resolveModelCapability` 处理）。
 *
 * 数据来源：
 * - `deepseek-v4-pro`：官方 MRCR 8-needle 数据 —— ≤128K accuracy >0.82 stable
 *   retrieval；256K 仍保持 >0.82；1M 降至 0.59 严重劣化。
 * - `deepseek-v4-flash`：官方未公开分阶段数据；按业界基线保守（NoLiMa 32K
 *   = 50% 衰减阈值）+ Flash 是较弱变体（Non-Think 1M MRCR 仅 37.5）。
 *
 * 后续模型补入策略：优先官方公开的长上下文分阶段 benchmark（MRCR / RULER /
 * NoLiMa）；没有官方数据时沿用业界基线；找不到任何信息走 `UNKNOWN_MODEL_CAPABILITY`
 * 兜底，标注"无依据"。
 */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> = {
  "deepseek-v4-pro": {
    modelId: "deepseek-v4-pro",
    optimalMaxTokens: 128_000,
    riskMaxTokens: 256_000,
  },
  "deepseek-v4-flash": {
    modelId: "deepseek-v4-flash",
    optimalMaxTokens: 32_000,
    riskMaxTokens: 64_000,
  },
};

/**
 * 未知模型的兜底阈值 —— 按业界基线保守取值。
 *
 * `modelId` 留 `<unknown>` 标识；调用方拿到该常量时知道当前没有针对性数据，
 * 用的是保守默认（适合任何模型不报错，但可能"切段过早"略损失累积上下文）。
 */
export const UNKNOWN_MODEL_CAPABILITY: ModelCapability = {
  modelId: "<unknown>",
  optimalMaxTokens: 16_000,
  riskMaxTokens: 32_000,
};

/**
 * Partial<ModelCapability> 形态的用户覆盖 —— 用户只需指定要变的字段，
 * 缺省字段从内置常量继承。
 *
 * 例：`{ optimalMaxTokens: 96_000 }` 只调 optimal 阈值，其他不变。
 */
export type ModelCapabilityOverride = Partial<Omit<ModelCapability, "modelId">>;

/**
 * 解析最终生效的 ModelCapability。
 *
 * 优先级：用户 override > 内置常量 > UNKNOWN 兜底。
 *
 * @param modelId 模型标识符（大小写不敏感）
 * @param override 用户覆盖（仅指定要变的字段）
 */
export function resolveModelCapability(
  modelId: string,
  override?: ModelCapabilityOverride,
): ModelCapability {
  const normalized = modelId.toLowerCase();
  const base =
    MODEL_CAPABILITIES[normalized] ??
    ({ ...UNKNOWN_MODEL_CAPABILITY, modelId: normalized });

  if (!override) return base;

  return {
    modelId: base.modelId,
    optimalMaxTokens: override.optimalMaxTokens ?? base.optimalMaxTokens,
    riskMaxTokens: override.riskMaxTokens ?? base.riskMaxTokens,
  };
}

/**
 * 从 modelCapabilityOverrides map 中按 modelId 查找 override —— **大小写不敏感**。
 *
 * 设计原因：用户在 `config.jsonc` 写 modelId key 时大小写不可预测（如
 * `"DeepSeek-V4-Pro"` / `"deepseek-v4-pro"` / `"DEEPSEEK-V4-PRO"`），与
 * `MODEL_CAPABILITIES` 表内一律 lowercase 的命名约定不一致。把"大小写无关
 * 查找"作为 helper 契约固化在 providers 包内，杜绝每个 caller 各自做
 * normalize 的重复劳动 + 防止任一 caller 漏 normalize 导致"配置写了但不生效"
 * 的沉默失效。
 *
 * 性能：优先 O(1) lowercase 直接匹配；只在精确匹配失败时才线性扫描（用户
 * 误用大小写不一致 key 是罕见路径，O(N) 可接受）。
 *
 * @param overrides 用户配置 map（缺省 undefined）
 * @param modelId 要查找的 modelId（大小写不敏感）
 * @returns 匹配的 override；未匹配返 undefined
 */
export function getModelCapabilityOverride(
  overrides: Record<string, ModelCapabilityOverride> | undefined,
  modelId: string,
): ModelCapabilityOverride | undefined {
  if (!overrides) return undefined;
  const normalized = modelId.toLowerCase();
  // 优先 O(1) 精确 lowercase 匹配（推荐用户走这条路径，文档约定 key 用 lowercase）
  const exact = overrides[normalized];
  if (exact) return exact;
  // fallback 线性扫描兜底用户误用大小写不一致 key 的情形
  for (const [key, value] of Object.entries(overrides)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}
