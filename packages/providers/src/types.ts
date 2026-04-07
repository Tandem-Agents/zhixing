/**
 * Provider 层类型定义
 *
 * 三层概念模型：
 * - Protocol：协议族，决定用哪个 SDK 适配器
 * - Provider：服务商配置（baseUrl + apiKey + protocol）
 * - Config：用户声明的 providers 集合 + 默认选择
 *
 * 设计原则：
 * - 按协议组织适配器，不按服务商（借鉴 OpenClaw 的 Api→Transport 分层）
 * - 新增 OpenAI 兼容服务商零代码，只加预设配置
 * - API Key 支持三种格式统一解析
 */

// ─── 协议类型 ───

/**
 * 协议族。决定用哪个 SDK 适配器处理 HTTP 请求/响应。
 *
 * openai-compatible 覆盖：DeepSeek、MiniMax、Kimi、千问、GLM、硅基流动、OpenAI 等
 * anthropic-messages 覆盖：Anthropic Claude
 */
export type Protocol = "openai-compatible" | "anthropic-messages";

// ─── Provider Quirks ───

/**
 * 同协议下不同服务商的行为差异。
 * 预设中包含默认 quirks，自定义 provider 使用最保守的默认值。
 */
export interface ProviderQuirks {
  /**
   * max tokens 参数的字段名。
   * OpenAI 新版用 max_completion_tokens，旧版和大多数兼容服务用 max_tokens。
   */
  maxTokensField: "max_tokens" | "max_completion_tokens";
  /** 流式响应中是否返回 usage 统计 */
  supportsStreamUsage: boolean;
  /** 是否支持 extended thinking（如 Claude 的 thinking） */
  supportsThinking: boolean;
  /** 是否支持 function/tool calling */
  supportsTools: boolean;
}

/** 最保守的 quirks 默认值，用于未知自定义 provider */
export const DEFAULT_QUIRKS: ProviderQuirks = {
  maxTokensField: "max_tokens",
  supportsStreamUsage: false,
  supportsThinking: false,
  supportsTools: true,
};

// ─── Provider 预设 ───

/** 内置的已知服务商默认配置。用户只需提供 apiKey 即可使用。 */
export interface ProviderPreset {
  /** 显示名称 */
  name: string;
  /** 默认 API 端点 */
  baseUrl: string;
  /** 使用的协议 */
  protocol: Protocol;
  /** 默认的环境变量名（用于自动解析 API Key） */
  envKey?: string;
  /** 默认模型 ID */
  defaultModel?: string;
  /** 该服务商的 quirks（未指定的字段使用 DEFAULT_QUIRKS） */
  quirks?: Partial<ProviderQuirks>;
}

// ─── 用户配置 ───

/** 用户对单个 provider 的配置。与预设合并后生成 ResolvedProvider。 */
export interface ProviderConfig {
  /** 覆盖预设的 baseUrl（用于代理/聚合平台/私有部署） */
  baseUrl?: string;
  /**
   * API Key，支持三种格式：
   * - "env:VAR_NAME"  — 从环境变量读取
   * - "helper:command" — 执行命令获取（适配 Vault 等）
   * - 直接字符串 — 明文
   */
  apiKey?: string;
  /** 覆盖预设的协议（自定义 provider 必填） */
  protocol?: Protocol;
  /** 覆盖预设的默认模型 */
  defaultModel?: string;
  /** 覆盖预设的 quirks */
  quirks?: Partial<ProviderQuirks>;
}

/** 顶层配置结构（对应 zhixing.config.json） */
export interface ZhixingConfig {
  /** 默认使用的 provider ID */
  defaultProvider?: string;
  /** 默认使用的模型 ID */
  defaultModel?: string;
  /** Provider 配置表 */
  providers?: Record<string, ProviderConfig>;
}

// ─── 解析后的 Provider ───

/** 合并预设 + 用户配置后的完整 Provider，可直接传给协议适配器 */
export interface ResolvedProvider {
  /** Provider 标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API 端点 */
  baseUrl: string;
  /** 解析后的 API Key（明文） */
  apiKey: string;
  /** 使用的协议 */
  protocol: Protocol;
  /** 默认模型 */
  defaultModel?: string;
  /** 行为差异配置 */
  quirks: ProviderQuirks;
}
