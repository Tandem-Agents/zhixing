/**
 * 一站式 Provider 创建工厂
 *
 * 将配置解析 + 协议适配器选择合二为一。
 *
 * 三种创建方式：
 * - createProviderRoles — 多角色解析（main + light + power），CLI/serve 入口
 * - createProvider      — 传入显式 ZhixingConfig，单角色 LLMProvider
 * - createProviderDirect()— 指定 provider ID + 显式 ProviderCredentialEntry，单角色 LLMProvider
 */

import type {
  ChatRequest,
  LLMProvider,
  LLMRole,
  LLMRoles,
  SessionModelSelection,
} from "@zhixing-ai/core";
import { createAnthropicProvider } from "./adapters/anthropic-messages.js";
import { createGoogleInteractionsProvider } from "./adapters/google-interactions.js";
import { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
import { createOpenAIResponsesProvider } from "./adapters/openai-responses.js";
import type { ModelCatalogPort } from "./catalog-port.js";
import { loadConfig } from "./config-loader.js";
import {
  resolveFromConfig,
  resolveLLMRoles,
  resolveProvider,
  resolveSessionOverride,
  type ConnectionDiscoveryFacts,
  type ResolvedLLMRole,
  type ResolvedLLMRoles,
} from "./resolve.js";
import type {
  ProviderCredentialEntry,
  ProviderCredentialProjection,
  ResolvedProvider,
  ZhixingConfig,
} from "./types.js";

/**
 * 根据协议类型选择适配器，创建 LLMProvider。
 */
export function createProviderFromResolved(resolved: ResolvedProvider): LLMProvider {
  switch (resolved.protocol) {
    case "openai-compatible":
      return createOpenAICompatibleProvider(resolved);
    case "openai-responses":
      return createOpenAIResponsesProvider(resolved);
    case "anthropic-messages":
      return createAnthropicProvider(resolved);
    case "google-interactions":
      return createGoogleInteractionsProvider(resolved);
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
 * 凭据由产品组合根从设备本地 SecretStore 解锁后显式传入；本层不触达持久化秘密。
 */
export function createProvider(
  config: ZhixingConfig,
  credentials: ProviderCredentialProjection,
  providerId?: string,
  catalog?: ModelCatalogPort,
): LLMProvider {
  const resolved = resolveFromConfig(config, credentials, providerId, catalog);
  return createProviderFromResolved(resolved);
}

/**
 * 快捷方式：直接指定 provider ID 创建 LLMProvider。
 *
 * 完全独立模式：不读持久化、不创建模板，仅用显式条目构造 ResolvedProvider。
 */
export function createProviderDirect(
  providerId: string,
  override: ProviderCredentialEntry,
): LLMProvider {
  const credentials: ProviderCredentialProjection = { providers: { [providerId]: override } };
  const resolved = resolveProvider(providerId, credentials);
  return createProviderFromResolved(resolved);
}

// ─── 多角色工厂（main + light + power） ───

export interface ProviderRolesOptions {
  env?: Record<string, string | undefined>;
  config?: ZhixingConfig;
  credentials: ProviderCredentialProjection;
  catalog?: ModelCatalogPort;
  /** 按 connectionId 索引的最新已验证发现事实（来自隔离缓存，统一进入三层合成与运行硬约束）。 */
  discoveryByConnection?: Readonly<Record<string, ConnectionDiscoveryFacts>>;
  /** 可选本地已实现能力集合。 */
  localCapabilities?: readonly string[];
  /** 会话级结构化选模覆盖（仅作用于当前会话主循环角色，绝不改绑 light）。 */
  sessionOverride?: SessionModelSelection;
  /** 本会话覆盖生效的目标主角色（普通对话 main / 工作场景 power / 调度轻量 light）。 */
  primaryRole?: "main" | "light" | "power";
}

export interface ProviderRolesResult {
  /** 纯用途默认角色绑定（main / light / power 始终严格对应配置用途，不被 sessionOverride 覆盖）。 */
  roles: LLMRoles;
  config: ZhixingConfig;
  resolvedRoles: ResolvedLLMRoles;
  /** 若会话级结构化覆盖已生效，返回其解析结果（供思考参数与预算解析）。 */
  effectivePrimary?: ResolvedLLMRole;
  /** 若会话级结构化覆盖已生效，返回独立绑定的会话主循环 LLMRole（不污染 roles.main / roles.power）。 */
  sessionPrimary?: LLMRole;
  /** 关闭本次构造出的全部连接独占网络 dispatcher。 */
  closeAll: () => Promise<void>;
}

export function createProviderRoles(
  options: ProviderRolesOptions,
): ProviderRolesResult {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig({ env });
  const credentials = options.credentials;
  const resolveOpts = {
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.discoveryByConnection
      ? { discoveryByConnection: options.discoveryByConnection }
      : {}),
    ...(options.localCapabilities ? { localCapabilities: options.localCapabilities } : {}),
  };
  const resolved = resolveLLMRoles(config, credentials, resolveOpts);
  const sessionOverrideResolved = resolveSessionOverride(
    config,
    credentials,
    options.sessionOverride,
    resolveOpts,
  );

  const byConnection = new Map<string, LLMProvider>();
  const instanceFor = (role: ResolvedLLMRole): LLMProvider => {
    const key = role.resolved.id;
    const existing = byConnection.get(key);
    if (existing) return existing;
    const created = createProviderFromResolved(role.resolved);
    byConnection.set(key, created);
    return created;
  };

  // 设计 §5.1 硬不变量：roles.main / roles.light / roles.power 始终严格保持用途默认纯度；
  // sessionOverride 仅作用于会话主循环与未指定角色的子执行，经 sessionPrimary 独立交付，绝不覆盖 roles.main。
  const mainProvider = instanceFor(resolved.main);
  const lightProvider = instanceFor(resolved.light);
  const powerProvider = instanceFor(resolved.power);
  const sessionPrimary = sessionOverrideResolved
    ? bindRole(instanceFor(sessionOverrideResolved), sessionOverrideResolved.model)
    : undefined;

  return {
    config,
    resolvedRoles: resolved,
    ...(sessionOverrideResolved ? { effectivePrimary: sessionOverrideResolved } : {}),
    ...(sessionPrimary ? { sessionPrimary } : {}),
    roles: {
      main: bindRole(mainProvider, resolved.main.model),
      light: bindRole(lightProvider, resolved.light.model),
      power: bindRole(powerProvider, resolved.power.model),
    },
    async closeAll(): Promise<void> {
      const providers = [...byConnection.values()];
      byConnection.clear();
      await Promise.allSettled(providers.map((provider) => provider.close?.()));
    },
  };
}

/**
 * 按与 createProviderRoles 相同的解析，提前装载主角色 provider 的 SDK 并构造客户端（不发请求）。
 * 首发用主角色；SDK 模块在进程内共享，之后每次创建运行时新建的实例直接复用已装载的模块。
 */
export async function prepareProviderRoles(options: ProviderRolesOptions): Promise<void> {
  const { roles } = createProviderRoles(options);
  await roles.main.provider.prepare?.();
}
