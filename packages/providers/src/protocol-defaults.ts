/**
 * 协议族级 Budget 默认值
 *
 * 当 Provider declared catalog 未声明某个 model、且用户也没配 modelOverrides 时，
 * 用协议族的合理工程默认作兜底——比如 OpenAI 兼容协议下任意未声明 model 默认按
 * 128K/4K 处理。这给"网关型"provider（聚合站、私有部署）一个开箱即用的体验，
 * 用户想精调走 modelOverrides。
 *
 * 数据所有权：
 *   - protocol 概念是 providers 包私有的（core 不感知协议字符串）
 *   - 默认值是协议族级别的工程经验值，与具体 provider 无关
 *   - 调用方（cli/server）从 ResolvedProvider.protocol 查这张表后，以
 *     `ModelBudgetInfo` 形状传给 `core/resolveModelInfo` 的 `protocolDefaults` 参数
 *
 * 这不是 LLMProvider.models[] 的代替——models[] 是"declared catalog"（哪些
 * model 元信息已知）；protocol-defaults 是"未声明时的兜底"。两者职责不同。
 */

import type { ModelBudgetInfo } from "@zhixing/core";
import type { Protocol } from "./types.js";

/**
 * 默认值选取依据：
 *   - openai-compatible: 主流聚合站（DeepSeek/MiniMax/通义/硅基/OpenAI 等）
 *     上面跑的现代主流 model 多在 128K 上下文，输出 4K 是兼容性最好的下限
 *   - anthropic-messages: Claude 4 系列 200K 上下文 + 8K 输出
 *
 * 这些是兜底，不是精确值——用户用具体 model 想精调走 modelOverrides。
 */
export const PROTOCOL_BUDGET_DEFAULTS: Record<Protocol, ModelBudgetInfo> = {
  "openai-compatible": {
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
  },
  "anthropic-messages": {
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
};
