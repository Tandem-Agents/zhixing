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
  type ProviderConfig,
  type ProviderQuirks,
  type ResolvedProvider,
  type ZhixingConfig,
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
 * @param providerId - Provider 标识符（如 "deepseek"、"my-custom-gateway"）
 * @param userConfig - 用户配置（可为空对象，表示全部使用预设默认值）
 * @param env - 环境变量源（默认 process.env，测试时可替换）
 */
export function resolveProvider(
  providerId: string,
  userConfig: ProviderConfig = {},
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

  const apiKey = resolveApiKey(providerId, userConfig.apiKey, preset?.envKey, env);

  const quirks = mergeQuirks(preset?.quirks, userConfig.quirks);

  return {
    id: providerId,
    name: preset?.name ?? providerId,
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    protocol,
    defaultModel: userConfig.defaultModel ?? preset?.defaultModel,
    quirks,
  };
}

/**
 * 从顶层配置中解析指定 provider（或默认 provider）。
 */
export function resolveFromConfig(
  config: ZhixingConfig,
  providerId?: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedProvider {
  const id = providerId ?? config.defaultProvider;
  if (!id) {
    throw new ProviderConfigError(
      "未指定 provider，且配置中没有 defaultProvider",
      "<unknown>",
    );
  }

  const userConfig = config.providers?.[id] ?? {};
  const resolved = resolveProvider(id, userConfig, env);

  if (!resolved.defaultModel && config.defaultModel) {
    return { ...resolved, defaultModel: config.defaultModel };
  }

  return resolved;
}

// ─── API Key 解析 ───

/**
 * 解析 API Key，支持三种格式：
 * 1. "env:VAR_NAME" → 从环境变量读取
 * 2. "helper:command" → 执行命令获取
 * 3. 直接字符串 → 原样使用
 *
 * 如果用户未配置 apiKey，尝试从预设的 envKey 对应的环境变量自动解析。
 */
function resolveApiKey(
  providerId: string,
  userApiKey: string | undefined,
  presetEnvKey: string | undefined,
  env: Record<string, string | undefined>,
): string {
  // 用户显式配置了 apiKey
  if (userApiKey) {
    return parseApiKeyValue(providerId, userApiKey, env);
  }

  // 尝试预设的环境变量
  if (presetEnvKey) {
    const value = env[presetEnvKey];
    if (value) {
      return value;
    }
  }

  throw new ProviderConfigError(
    `Provider "${providerId}" 缺少 API Key。请通过以下方式之一配置：\n` +
      (presetEnvKey
        ? `  1. 设置环境变量 ${presetEnvKey}\n`
        : `  1. 设置环境变量（自定义 provider 需在 apiKey 中用 "env:VAR_NAME" 格式指定）\n`) +
      `  2. 在配置文件中设置 providers.${providerId}.apiKey`,
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
