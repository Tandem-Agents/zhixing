/**
 * 一站式 Provider 创建工厂
 *
 * 将配置解析 + 协议适配器选择合二为一。
 * 用户只需传入配置，即可获得 LLMProvider 实例。
 */

import type { LLMProvider } from "@zhixing/core";
import { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
import { resolveFromConfig, resolveProvider } from "./resolve.js";
import type { ProviderConfig, ResolvedProvider, ZhixingConfig } from "./types.js";

/**
 * 根据协议类型选择适配器，创建 LLMProvider。
 */
function createFromResolved(resolved: ResolvedProvider): LLMProvider {
  switch (resolved.protocol) {
    case "openai-compatible":
      return createOpenAICompatibleProvider(resolved);
    case "anthropic-messages":
      throw new Error(
        `Protocol "anthropic-messages" 尚未实现。` +
          `请使用 "openai-compatible" 协议或等待后续版本。`,
      );
    default:
      throw new Error(`未知的 protocol: ${resolved.protocol as string}`);
  }
}

/**
 * 从完整配置创建 LLMProvider。
 *
 * @example
 * ```ts
 * const provider = createProvider({
 *   defaultProvider: "deepseek",
 *   providers: {
 *     deepseek: { apiKey: "env:DEEPSEEK_API_KEY" }
 *   }
 * });
 * ```
 */
export function createProvider(
  config: ZhixingConfig,
  providerId?: string,
  env?: Record<string, string | undefined>,
): LLMProvider {
  const resolved = resolveFromConfig(config, providerId, env);
  return createFromResolved(resolved);
}

/**
 * 快捷方式：直接指定 provider ID + 配置创建 LLMProvider。
 *
 * @example
 * ```ts
 * const provider = createProviderDirect("deepseek", {
 *   apiKey: "sk-xxx"
 * });
 * ```
 */
export function createProviderDirect(
  providerId: string,
  config?: ProviderConfig,
  env?: Record<string, string | undefined>,
): LLMProvider {
  const resolved = resolveProvider(providerId, config, env);
  return createFromResolved(resolved);
}
