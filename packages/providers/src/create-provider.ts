/**
 * 一站式 Provider 创建工厂
 *
 * 将配置解析 + 协议适配器选择合二为一。
 *
 * 三种创建方式：
 * - createProviderRoles() — 双角色解析（main + secondary），CLI/serve 入口
 * - createProvider()      — 传入显式 ZhixingConfig，单角色 LLMProvider
 * - createProviderDirect()— 指定 provider ID + ProviderConfig，单角色 LLMProvider
 */

import type { ChatRequest, LLMProvider, LLMRole, LLMRoles } from "@zhixing/core";
import { createAnthropicProvider } from "./adapters/anthropic-messages.js";
import { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
import { loadConfig, resolveHomeDir } from "./config-loader.js";
import { loadCredentials } from "./credentials-loader.js";
import {
  resolveFromConfig,
  resolveLLMRoles,
  resolveProvider,
  type LLMRolesResolveOptions,
  type ResolvedLLMRoles,
} from "./resolve.js";
import type { ProviderConfig, ResolvedProvider, ZhixingConfig } from "./types.js";

/**
 * 工厂层共用：按 env 推断 ~/.zhixing/ 目录后加载凭证。
 *
 * 让 ZHIXING_CONFIG_PATH 测试覆盖与 credentials 文件保持同目录——
 * 测试用临时目录跑全链路时，credentials 自动从同 tmpdir 取，不污染开发者机器。
 */
function loadCredentialsFromEnv(env: Record<string, string | undefined>) {
  return loadCredentials({ homeDir: resolveHomeDir(env) });
}

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
 * 把 LLMProvider + model 绑定成 LLMRole——consumer 调 chat() 不需重复传 model。
 *
 * @internal 仅供测试与同包高级用例；外部 consumer 用 createProviderRoles
 * 一站式构造，不应该自己 bind（绕过 same-id 复用 / 缺省兜底等工厂逻辑）。
 */
export function bindRole(provider: LLMProvider, model: string): LLMRole {
  const role: LLMRole = {
    provider,
    model,
    chat: (request: Omit<ChatRequest, "model">) =>
      provider.chat({ ...request, model }),
  };

  if (provider.countTokens) {
    role.countTokens = (messages) => provider.countTokens!(messages, model);
  }

  return role;
}

/**
 * 从完整配置创建 LLMProvider（单角色，main role）。
 *
 * 内部从 ~/.zhixing/credentials.json 加载 apiKey；缺失抛错引向首次配置向导。
 */
export function createProvider(
  config: ZhixingConfig,
  providerId?: string,
): LLMProvider {
  const credentials = loadCredentialsFromEnv(process.env);
  const resolved = resolveFromConfig(config, credentials, providerId);
  return createFromResolved(resolved);
}

/**
 * 快捷方式：直接指定 provider ID + 配置创建 LLMProvider。
 *
 * 内部从 ~/.zhixing/credentials.json 加载 apiKey；缺失抛错引向首次配置向导。
 */
export function createProviderDirect(
  providerId: string,
  config?: ProviderConfig,
): LLMProvider {
  const credentials = loadCredentialsFromEnv(process.env);
  const resolved = resolveProvider(providerId, config ?? {}, credentials);
  return createFromResolved(resolved);
}

// ─── 双角色工厂（main + secondary） ───

export interface ProviderRolesOptions extends LLMRolesResolveOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * `createProviderRoles` 返回结果。
 *
 * `resolvedRoles` 暴露配置层中间产物（含 protocol/baseUrl/quirks/declaredModels
 * 等元信息），消费者据此完成 budget 解析等需要 protocol-aware 的工作——
 * 这些信息原本被埋在 LLMProvider 实例里不可见。
 */
export interface ProviderRolesResult {
  roles: LLMRoles;
  config: ZhixingConfig;
  resolvedRoles: ResolvedLLMRoles;
}

/**
 * 一站式创建会话级 LLMRoles：从配置文件加载 → 双角色配置解析 →
 * 实例化 LLMProvider（同 provider id 共享实例）→ 绑定 model 成 LLMRole。
 *
 * CLI override（providerOverride / modelOverride）直接在工厂内吸收，让
 * roles.main.{provider, model} 始终反映会话实际使用的 effective state。
 *
 * 用户没显式配 llm.secondary 时，secondary 自动用 main 实例 + main.model 兜底
 * （仍保留调用上下文隔离价值，仅放弃任务专门化/cost 优化）。这是正常状态，
 * 不打印任何提示——/status 命令未来可主动展示当前角色配置供用户决策是否专门化。
 *
 * options.env 仍保留——loadConfig / loadCredentials 需要它推断 ~/.zhixing 目录
 * （ZHIXING_CONFIG_PATH 测试覆盖入口）。env 不再透传给凭证解析器。
 */
export function createProviderRoles(
  options: ProviderRolesOptions = {},
): ProviderRolesResult {
  const env = options.env ?? process.env;
  const config = loadConfig({ cwd: options.cwd, env });
  const credentials = loadCredentialsFromEnv(env);
  const resolved = resolveLLMRoles(config, credentials, {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
  });

  const mainProvider = createFromResolved(resolved.main.resolved);

  // 同 provider id 复用 LLMProvider 实例：连接池/限速/cache 共用。
  // 兜底路径下 secondary.resolved 与 main.resolved 是同一对象，必然命中。
  const secondaryProvider =
    resolved.secondary.resolved.id === resolved.main.resolved.id
      ? mainProvider
      : createFromResolved(resolved.secondary.resolved);

  return {
    config,
    resolvedRoles: resolved,
    roles: {
      main: bindRole(mainProvider, resolved.main.model),
      secondary: bindRole(secondaryProvider, resolved.secondary.model),
    },
  };
}
