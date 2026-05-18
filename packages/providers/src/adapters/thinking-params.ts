/**
 * 思考控制 → provider 原生请求参数 的方言映射（纯函数，无状态、可单测）。
 *
 * 设计原则：还原各家官方原生形态，不做统一抽象。四家思考控制分属离散
 * effort / 纯开关 / 连续 token budget 三种不同维度，强行归一必然向不支持的
 * 模型发出无效值。故按 ProviderQuirks.thinkingDialect 派发到各自映射，
 * 1:1 还原官方参数（与 usageDialect 同为方言派发机制）。
 *
 * ThinkingConfig 已在装配期按所选 model 的 ThinkingControl 校验过形态，本层
 * 只负责"写成线格式"，不再校验。某方言不支持的 mode（如 deepseek 收到
 * budget、anthropic 收到无 budget 的 on）→ 不发该参数（"不发"确定安全，
 * "发错"结果不可控），不抛错。
 *
 * 官方原生形态（DeepSeek/Anthropic 经官方文档核实；GLM/Qwen/Kimi 依规格
 * 已锁定的官方事实表）：
 *   - deepseek ：thinking{type:enabled|disabled} + reasoning_effort{high|max}
 *   - qwen     ：enable_thinking(bool) + thinking_budget(token 数)
 *   - glm/kimi ：thinking{type:enabled|disabled}（纯开关）
 *   - anthropic：thinking{type:enabled, budget_tokens:int}（连续预算，必填 budget）
 *   - none     ：不发送任何思考参数
 */

import type { ThinkingConfig } from "@zhixing/core";
import type { ThinkingDialect } from "../types.js";

/**
 * OpenAI 兼容协议下的思考方言（anthropic 走自有协议，不经此路径）。
 */
type OpenAICompatibleThinkingDialect = Exclude<ThinkingDialect, "anthropic">;

/**
 * 把 ThinkingConfig 写成 OpenAI 兼容请求体的思考参数片段，调用方直接展开
 * 进 ChatCompletion 请求。thinking 缺省或方言不支持该形态 → 返回空对象
 * （请求不带任何思考参数，服务端用自身默认）。
 */
export function buildOpenAICompatibleThinkingParams(
  dialect: OpenAICompatibleThinkingDialect,
  thinking: ThinkingConfig | undefined,
): Record<string, unknown> {
  if (thinking === undefined || dialect === "none") return {};

  switch (dialect) {
    case "deepseek":
      // 官方：thinking{type} 开关 + reasoning_effort 离散档（high/max）。
      // 不传任何参数 = 服务端默认 enabled + effort high。
      switch (thinking.mode) {
        case "off":
          return { thinking: { type: "disabled" } };
        case "on":
          return { thinking: { type: "enabled" } };
        case "effort":
          return {
            thinking: { type: "enabled" },
            reasoning_effort: thinking.effort,
          };
        case "budget":
          return {};
      }
      break;

    case "qwen":
      // 官方：enable_thinking(bool) + thinking_budget(token 数)。
      switch (thinking.mode) {
        case "off":
          return { enable_thinking: false };
        case "on":
          return { enable_thinking: true };
        case "budget":
          return { enable_thinking: true, thinking_budget: thinking.budget };
        case "effort":
          return {};
      }
      break;

    case "glm":
    case "kimi":
      // 官方：thinking.type 纯开关（enabled/disabled）。强度档/预算不适用。
      switch (thinking.mode) {
        case "off":
          return { thinking: { type: "disabled" } };
        case "on":
          return { thinking: { type: "enabled" } };
        case "effort":
        case "budget":
          return {};
      }
      break;
  }

  return {};
}

/**
 * Anthropic extended thinking 请求参数。官方：thinking{type:"enabled",
 * budget_tokens:int}，budget_tokens 必填。
 *
 * 返回 undefined = 不进入 extended thinking（Anthropic 无 disabled 概念，
 * 不传该参数即标准模式）：
 *   - off / effort：不适用 → 标准模式
 *   - on：Anthropic 强制要求 budget_tokens，无法在不臆造数值的前提下表达
 *     "开但不指定预算" → 退回标准模式（"不发"安全，优于发非法请求）
 *   - budget：→ { type:"enabled", budget_tokens }
 */
export function buildAnthropicThinkingParam(
  thinking: ThinkingConfig | undefined,
): { type: "enabled"; budget_tokens: number } | undefined {
  if (thinking === undefined) return undefined;
  if (thinking.mode === "budget") {
    return { type: "enabled", budget_tokens: thinking.budget };
  }
  return undefined;
}
