/**
 * Provider 配置解析器
 *
 * 职责：将用户配置 + 预设合并为可直接使用的 ResolvedProvider。
 *
 * 解析流程：
 * 1. 查找预设（如果是已知 provider）
 * 2. 合并用户配置覆盖预设
 * 3. 解析 API Key（env:VAR / helper:cmd / 明文）
 * 4. 验证必填字段
 * 5. 返回 ResolvedProvider
 */

import { execSync } from "node:child_process";
import { getPreset } from "./presets.js";
import {
  DEFAULT_QUIRKS,
  type LLMRoleConfig,
  type ProviderConfig,
  type ProviderQuirks,
  type ResolvedProvider,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "./types.js";

// ─── 错误类型 ───

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

// ─── 主入口 ───

/**
 * 解析单个 provider 的配置，合并预设和用户配置，返回 ResolvedProvider。
 *
 * apiKey 解析优先级：credentials.providers.<id>.apiKey 主路径 →
 * config.providers.<id>.apiKey fallback（支持 env: / helper: / plaintext） →
 * 缺失抛错并提示首次引导。
 *
 * userConfig 与 credentials 都是必需参数——避免 caller 重构时漏传 credentials
 * 而 silent 退化为 fallback-only 路径，错过用户的 credentials.json 主路径。
 *
 * @param providerId - Provider 标识符（如 "deepseek"、"my-custom-gateway"）
 * @param userConfig - 用户配置（无配置时显式传 `{}`，表示全部使用预设默认值）
 * @param credentials - 凭证文件内容（无凭证时显式传 `{ version: 1 }`）
 * @param env - 环境变量源（默认 process.env，测试时可替换）
 */
export function resolveProvider(
  providerId: string,
  userConfig: ProviderConfig,
  credentials: ZhixingCredentials,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  const preset = getPreset(providerId);

  const baseUrl = userConfig.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) {
    throw new ProviderConfigError(
      `Provider "${providerId}" 需要配置 baseUrl（不在内置预设列表中）`,
      providerId,
    );
  }

  const protocol = userConfig.protocol ?? preset?.protocol;
  if (!protocol) {
    throw new ProviderConfigError(
      `Provider "${providerId}" 需要配置 protocol（不在内置预设列表中）。` +
        `可选值: "openai-compatible" | "anthropic-messages"`,
      providerId,
    );
  }

  const apiKey = resolveApiKey(providerId, userConfig.apiKey, credentials, env);

  const quirks = mergeQuirks(preset?.quirks, userConfig.quirks);

  return {
    id: providerId,
    name: preset?.name ?? providerId,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    protocol,
    defaultModel: userConfig.defaultModel ?? preset?.defaultModel,
    quirks,
    declaredModels: preset?.knownModels ?? [],
  };
}

/**
 * 从顶层配置中解析指定 provider（或 main 角色 provider）。
 *
 * 用于"只要一个 ResolvedProvider"的场景（如 createProvider）。需要双角色解析时
 * 用 resolveLLMRoles。
 */
export function resolveFromConfig(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
  providerId?: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  const id = providerId ?? config.llm?.main?.provider;
  if (!id) {
    throw new ProviderConfigError(
      buildMissingMainConfigMessage(),
      "<unknown>",
    );
  }

  const userConfig = config.providers?.[id] ?? {};
  return resolveProvider(id, userConfig, credentials, env);
}

// ─── LLM 双角色解析（配置层） ───

/** 单个角色解析结果——配置层产物，不含 LLMProvider 实例。 */
export interface ResolvedLLMRole {
  resolved: ResolvedProvider;
  model: string;
}

/** 双角色解析结果。 */
export interface ResolvedLLMRoles {
  main: ResolvedLLMRole;
  secondary: ResolvedLLMRole;
}

/** CLI override 入口——main 角色受影响，secondary 不受影响。 */
export interface LLMRolesResolveOptions {
  /** CLI `--provider`：替换 main role 的 provider；model 跟随新 provider 的预设默认（除非也提供 modelOverride）。 */
  providerOverride?: string;
  /** CLI `--model`：替换 main role 的 model（最高优先级）。 */
  modelOverride?: string;
}

/**
 * 配置层双角色解析——纯 ResolvedProvider 计算，**不**实例化 LLMProvider。
 *
 * 实例化与共享判断由 create-provider.ts 的 createProviderRoles 完成，保持
 * resolve.ts ↔ 配置层、create-provider.ts ↔ 实例层的单向依赖。
 */
export function resolveLLMRoles(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
  options: LLMRolesResolveOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedLLMRoles {
  // 单一 fail-fast 边界——把 ZhixingConfig.llm? 的 optional 在此处一次性 narrow，
  // 让下游 helpers 接收已确定形状的字段（避免 TS 跨函数 narrow 失败 / non-null 断言）。
  if (!config.llm?.main) {
    throw new ProviderConfigError(
      buildMissingMainConfigMessage(),
      "<unknown>",
    );
  }

  const providersConfig = config.providers;
  const main = resolveMainRole(config.llm.main, providersConfig, credentials, options, env);
  const secondary = resolveSecondaryRole(
    config.llm.secondary,
    providersConfig,
    credentials,
    env,
    main,
  );

  return { main, secondary };
}

function resolveMainRole(
  mainConfig: LLMRoleConfig,
  providersConfig: Record<string, ProviderConfig> | undefined,
  credentials: ZhixingCredentials,
  options: LLMRolesResolveOptions,
  env: Record<string, string | undefined>,
): ResolvedLLMRole {
  const finalProvider = options.providerOverride ?? mainConfig.provider;
  const userConfig = providersConfig?.[finalProvider] ?? {};
  const resolved = resolveProvider(finalProvider, userConfig, credentials, env);

  let finalModel: string;
  if (options.modelOverride) {
    finalModel = options.modelOverride;
  } else if (options.providerOverride) {
    if (!resolved.defaultModel) {
      throw new ProviderConfigError(
        `--provider "${finalProvider}" requires --model: provider has no ` +
          `default model in preset or providers.${finalProvider}.defaultModel. ` +
          `Pass --model <model-id> explicitly.`,
        finalProvider,
      );
    }
    finalModel = resolved.defaultModel;
  } else {
    finalModel = mainConfig.model;
  }

  return { resolved, model: finalModel };
}

function resolveSecondaryRole(
  explicit: LLMRoleConfig | undefined,
  providersConfig: Record<string, ProviderConfig> | undefined,
  credentials: ZhixingCredentials,
  env: Record<string, string | undefined>,
  main: ResolvedLLMRole,
): ResolvedLLMRole {
  // 没显式配置 → 用 main 实例 + main.model 兜底。
  //
  // 这不是"降级"，是合理的未配置默认：
  //   - 隔离价值（第一层）：调用上下文独立，secondary 一次性 conversation 与 main
  //     conversation 物理隔离；prompt injection 通过工具结果污染 secondary 时，
  //     main 看到的只是结构化净化输出，攻击向量被切断
  //   - 任务专门化（第二层）：放弃——main 通常是为主对话挑的较强模型，跑摘要/抽取
  //     等轻量任务略大材小用
  //   - cost 优化（第三层）：放弃
  //
  // **不**预设任何 vendor 默认（曾经的 SECONDARY_DEFAULT=anthropic 是 vendor lock-in
  // 错误）—— 知行 provider 中立，预设 8 家服务商，不替用户挑选其中之一作为
  // secondary 默认。用户想专门化就显式配 llm.secondary；不配就用 main 兜底。
  if (!explicit) {
    return { resolved: main.resolved, model: main.model };
  }

  // 显式 secondary：用户的明确意图。
  //
  // 同 provider id 时复用 main.resolved 实例——避免重复 env: lookup /
  // helper:cmd execSync。复用的只是协议配置（baseUrl/apiKey/connection pool 等
  // stateless 资源），conversation 仍然独立，隔离性不破坏。
  if (explicit.provider === main.resolved.id) {
    return { resolved: main.resolved, model: explicit.model };
  }

  // 不同 provider id：独立解析，失败 fail-fast（不静默降级到 main，避免把
  // "用户期望的双 provider 架构"伪装成单 provider 在跑）。
  const userConfig = providersConfig?.[explicit.provider] ?? {};
  const resolved = resolveProvider(explicit.provider, userConfig, credentials, env);
  return { resolved, model: explicit.model };
}

function buildMissingMainConfigMessage(): string {
  return (
    `ZhixingConfig.llm.main is required.\n\n` +
    `If migrating from older config that uses top-level defaultProvider/defaultModel,\n` +
    `replace:\n` +
    `  { "defaultProvider": "<id>", "defaultModel": "<model-id>", "providers": {...} }\n` +
    `with:\n` +
    `  { "llm": { "main": { "provider": "<id>", "model": "<model-id>" } }, "providers": {...} }\n\n` +
    `See research/design/specifications/secondary-llm-capability.md §一.1.`
  );
}

// ─── API Key 解析 ───

/**
 * 解析 API Key。
 *
 * 顺序：
 *   1. credentials.providers.<id>.apiKey —— 主路径（向导写、用户编辑）
 *   2. config.providers.<id>.apiKey —— fallback，承载三种格式：
 *        "env:VAR_NAME"   → 从环境变量读取（CI / enterprise vault 用）
 *        "helper:command" → 执行命令获取（vault helper 用）
 *        明文            → 原样使用
 *   3. 都缺失 → 抛 ProviderConfigError，引导用户跑 `zhixing` 触发首次引导
 */
function resolveApiKey(
  providerId: string,
  userApiKey: string | undefined,
  credentials: ZhixingCredentials,
  env: Record<string, string | undefined>,
): string {
  const credApiKey = credentials.providers?.[providerId]?.apiKey;
  if (credApiKey) {
    return credApiKey;
  }

  if (userApiKey) {
    return parseApiKeyValue(providerId, userApiKey, env);
  }

  throw new ProviderConfigError(
    `Provider "${providerId}" 缺少 API Key。\n` +
      `请按以下任一方式配置：\n` +
      `  1. （推荐）在 ~/.zhixing/credentials.json 的 providers.${providerId}.apiKey 字段填入凭证；\n` +
      `     首次使用建议在 TTY 终端跑 \`zhixing\` 触发引导自动写入。\n` +
      `  2. （fallback，CI / vault 用）在 ~/.zhixing/config.json 的 providers.${providerId}.apiKey\n` +
      `     字段写 "env:VAR_NAME" / "helper:command" / 明文之一。`,
    providerId,
  );
}

function parseApiKeyValue(
  providerId: string,
  value: string,
  env: Record<string, string | undefined>,
): string {
  // env:VAR_NAME
  if (value.startsWith("env:")) {
    const varName = value.slice(4);
    const resolved = env[varName];
    if (!resolved) {
      throw new ProviderConfigError(
        `Provider "${providerId}" 的 apiKey 引用了环境变量 ${varName}，但该变量未设置`,
        providerId,
      );
    }
    return resolved;
  }

  // helper:command
  if (value.startsWith("helper:")) {
    const command = value.slice(7);
    try {
      const result = execSync(command, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (!result) {
        throw new ProviderConfigError(
          `Provider "${providerId}" 的 apiKey helper 命令 "${command}" 返回了空值`,
          providerId,
        );
      }
      return result;
    } catch (err) {
      if (err instanceof ProviderConfigError) throw err;
      throw new ProviderConfigError(
        `Provider "${providerId}" 的 apiKey helper 命令 "${command}" 执行失败: ${err instanceof Error ? err.message : String(err)}`,
        providerId,
      );
    }
  }

  // 明文
  return value;
}

// ─── 辅助函数 ───

function mergeQuirks(
  presetQuirks?: Partial<ProviderQuirks>,
  userQuirks?: Partial<ProviderQuirks>,
): ProviderQuirks {
  return {
    ...DEFAULT_QUIRKS,
    ...presetQuirks,
    ...userQuirks,
  };
}

/** 移除 baseUrl 末尾的斜杠，确保拼接路径时不出问题 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
