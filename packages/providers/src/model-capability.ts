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
  const normalized = normalizeModelId(modelId);
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
 * 规范化 model ID 用于查找 —— 处理 vendor 前缀 + 大小写差异。
 *
 * 实际 model ID 在各 provider 间命名不统一:
 *   - 官方:  "deepseek-chat", "claude-3-opus-20240229", "gpt-4-turbo"
 *   - 转发: "deepseek-ai/DeepSeek-V4-Flash" (siliconflow / huggingface 风格)
 *           "accounts/fireworks/models/llama-v3" (fireworks 风格)
 *
 * 内置 `MODEL_CAPABILITIES` 表用最简洁的"主名"作 key(如 "deepseek-v4-flash"),
 * 同一个模型无论从哪条路径接入都能命中。
 *
 * 规则:取最后一个 '/' 之后的部分,lowercase。
 *   - "deepseek-ai/DeepSeek-V4-Flash" → "deepseek-v4-flash" ✓
 *   - "gpt-4-turbo" → "gpt-4-turbo"(无 '/' 直接 lowercase)
 *   - "accounts/fireworks/models/llama-v3" → "llama-v3"
 *
 * 这是知行**单一 ID 规范化策略**,所有 capability 查找(内置表 + 用户 override)
 * 都走此函数,杜绝"配置 ID 与表内 ID 不一致导致沉默失效"的问题。
 */
export function normalizeModelId(modelId: string): string {
  const lastSlash = modelId.lastIndexOf("/");
  const tail = lastSlash >= 0 ? modelId.slice(lastSlash + 1) : modelId;
  return tail.toLowerCase();
}

/**
 * 从 `modelCapabilityOverrides` map 查找指定 model 的 override —— 用 normalize
 * 处理 key / query 任意一侧的 vendor 前缀或大小写差异。
 *
 * 设计契约:用户在 config 写 key 时怎么写都行 —— 带前缀
 * `"deepseek-ai/DeepSeek-V4-Flash"`、不带前缀 `"deepseek-v4-flash"`、
 * 大小写混合 `"DeepSeek-V4-Flash"`,全部 normalize 后命中同一个 entry。
 *
 * 性能:优先 O(1) normalize 后直接 lookup(用户用 normalize 形式时命中);
 * 兜底 O(N) 线性扫描(用户用其他形式时命中)。N 通常很小(用户手配的 override
 * 条目数为个位数),开销可忽略。
 *
 * 切换语义:caller 改 `llm.main.model` 后,旧 model 的 override 因 key normalize
 * 后不匹配新 model 而自动失效 —— 阈值绑模型不绑 role。
 */
export function getModelCapabilityOverride(
  overrides: Record<string, ModelCapabilityOverride> | undefined,
  modelId: string,
): ModelCapabilityOverride | undefined {
  if (!overrides) return undefined;
  const target = normalizeModelId(modelId);
  // O(1):用户 key 直接是 normalize 形式
  const exact = overrides[target];
  if (exact) return exact;
  // 兜底:用户 key 是任意形式,normalize 后比对
  for (const [key, value] of Object.entries(overrides)) {
    if (normalizeModelId(key) === target) return value;
  }
  return undefined;
}
