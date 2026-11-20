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

import type { ThinkingConfig } from "@zhixing-ai/core";
import type { ThinkingDialect } from "../types.js";

/**
 * OpenAI 兼容协议下的思考方言（anthropic 走自有协议，不经此路径）。
 */
type OpenAICompatibleThinkingDialect = Exclude<
  ThinkingDialect,
  "anthropic" | "openai-responses" | "google-interactions"
>;

/**
 * 判断 OpenAI 兼容连接的思考方言是否支持在出站 assistant 消息上携带 `reasoning_content`。
 * 聚合器与保守兼容端（`"none"`）绝不盲目发送该厂商私有字段（设计 §2.3）。
 */
export function supportsOpenAICompatibleReasoningContentReplay(
  dialect: ThinkingDialect,
): boolean {
  return (
    dialect === "deepseek" ||
    dialect === "qwen" ||
    dialect === "glm" ||
    dialect === "kimi"
  );
}

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
 * 判断 Claude 型号是否属于 4.7+ 自适应思考代际（弃用旧式 `enabled + budget_tokens`，
 * 采用 `thinking: { type: "adaptive" }` + 可选 `output_config: { effort }`）。
 */
export function isAnthropicAdaptiveThinkingModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  // 匹配 claude-(opus|sonnet|haiku)?-4-7 / 4.7 / 4-8 / 4-9 / 4-1x / 5+，排除 4-20250514 类四位年份后缀
  return /(?:^|[/-])claude-(?:(?:opus|sonnet|haiku)-)?(?:4[.-](?:[7-9]|1\d)(?=$|[.-])|[5-9](?=$|[.-]))/u.test(
    normalized,
  );
}

/**
 * Anthropic extended thinking 旧式预算参数（保留向后兼容签名）。
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

export interface AnthropicThinkingRequestFields {
  readonly thinking?:
    | { readonly type: "enabled"; readonly budget_tokens: number }
    | { readonly type: "adaptive" };
  readonly output_config?: { readonly effort: string };
}

/**
 * 面向全代际 Anthropic Messages 的思考请求字段构造：
 * - Claude 4.7+：使用 `thinking: { type: "adaptive" }`，支持 `on` 与 `effort`（`output_config.effort`）；
 *   不再向 4.7+ 发送官方已弃用/拒绝的 `enabled + budget_tokens`（设计 §1.1）。
 * - 较早 Claude 型号：保留 `thinking: { type: "enabled", budget_tokens }`，同样放行显式 `effort`
 *   给支持 adaptive 的网关/新别名时不造假 budget。
 */
export function buildAnthropicThinkingRequestFields(
  thinking: ThinkingConfig | undefined,
  model: string,
): AnthropicThinkingRequestFields {
  if (thinking === undefined || thinking.mode === "off") return {};

  const adaptiveModel = isAnthropicAdaptiveThinkingModel(model);
  if (thinking.mode === "effort") {
    return {
      thinking: { type: "adaptive" },
      output_config: { effort: thinking.effort },
    };
  }
  if (thinking.mode === "on") {
    return adaptiveModel ? { thinking: { type: "adaptive" } } : {};
  }
  if (thinking.mode === "budget") {
    // Claude 4.7+ 明确拒绝旧式 enabled + budget_tokens，回落为 adaptive 避免 400
    return adaptiveModel
      ? { thinking: { type: "adaptive" } }
      : { thinking: { type: "enabled", budget_tokens: thinking.budget } };
  }
  return {};
}

export interface OpenAIResponsesReasoningParam {
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly summary?: "auto" | "concise" | "detailed";
}

const VALID_OPENAI_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * OpenAI Responses 思考参数映射（`reasoning: { effort?, summary? }`）。
 */
export function buildOpenAIResponsesThinkingParam(
  thinking: ThinkingConfig | undefined,
): OpenAIResponsesReasoningParam | undefined {
  if (thinking === undefined) return undefined;
  switch (thinking.mode) {
    case "off":
      return { effort: "none" };
    case "on":
      return { summary: "auto" };
    case "effort": {
      const normalized = thinking.effort.trim().toLowerCase();
      if (!VALID_OPENAI_EFFORTS.has(normalized)) return undefined;
      return {
        effort: normalized as OpenAIResponsesReasoningParam["effort"],
        summary: "auto",
      };
    }
    case "budget":
      return undefined;
  }
}

export interface GoogleInteractionsThinkingConfig {
  readonly thinking_level?: "minimal" | "low" | "medium" | "high";
  readonly thinking_summaries?: "auto" | "none";
}

const VALID_GOOGLE_LEVELS = new Set(["minimal", "low", "medium", "high"]);

/**
 * Google Interactions 思考参数映射（写入 `generation_config`）。
 */
export function buildGoogleInteractionsThinkingParams(
  thinking: ThinkingConfig | undefined,
): GoogleInteractionsThinkingConfig {
  if (thinking === undefined) return {};
  switch (thinking.mode) {
    case "off":
      return { thinking_level: "minimal", thinking_summaries: "none" };
    case "on":
      return { thinking_summaries: "auto" };
    case "effort": {
      const normalized = thinking.effort.trim().toLowerCase();
      if (!VALID_GOOGLE_LEVELS.has(normalized)) return {};
      return {
        thinking_level: normalized as GoogleInteractionsThinkingConfig["thinking_level"],
        thinking_summaries: "auto",
      };
    }
    case "budget":
      return {};
  }
}
