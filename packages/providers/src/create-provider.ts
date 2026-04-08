/**
 * 一站式 Provider 创建工厂
 *
 * 将配置解析 + 协议适配器选择合二为一。
 * 用户只需传入配置，即可获得 LLMProvider 实例。
 *
 * 三种创建方式（从简到完整）：
 * - createProviderFromConfig() — 自动从配置文件加载，零参数
 * - createProvider()           — 传入显式 config 对象
 * - createProviderDirect()     — 指定 provider ID + 配置
 */

import type { LLMProvider } from "@zhixing/core";
import { createAnthropicProvider } from "./adapters/anthropic-messages.js";
import { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
import { loadConfig } from "./config-loader.js";
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
      return createAnthropicProvider(resolved);
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

/**
 * 从配置文件自动加载 Provider。零参数即可工作。
 *
 * 加载顺序：全局配置 → 项目配置 → 环境变量
 * 返回同时包含 provider 实例和解析后的 defaultModel。
 *
 * @example
 * ```ts
 * const { provider, defaultModel } = createProviderFromConfig();
 * for await (const event of provider.chat({
 *   model: defaultModel,
 *   messages: [userMessage("你好")],
 * })) { ... }
 * ```
 */
export function createProviderFromConfig(options: {
  providerId?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): { provider: LLMProvider; defaultModel: string; config: ZhixingConfig } {
  const env = options.env ?? process.env;
  const config = loadConfig({ cwd: options.cwd, env });
  const resolved = resolveFromConfig(config, options.providerId, env);
  const provider = createFromResolved(resolved);
  const defaultModel = resolved.defaultModel ?? config.defaultModel ?? "unknown";

  return { provider, defaultModel, config };
}
