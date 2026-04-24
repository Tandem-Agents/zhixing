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

/**
 * 模型预算覆盖条目。
 *
 * 用户在配置中为特定 model 覆盖上下文窗口 / 最大输出 —— 当 provider 自身
 * 声明的信息过时、不准确、或适配器硬编码值需要微调时使用。支持部分覆盖。
 */
export interface ModelBudgetOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
}

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
  /**
   * 模型预算覆盖表（key = modelId）。
   *
   * 用于上下文工程：core 的 resolveModelInfo 用此覆盖适配器中硬编码的
   * contextWindow / maxOutputTokens。典型场景：
   *   - DeepSeek 适配器硬编码 128K，但你用的代理上游限制到 64K
   *   - 为新发布的模型名临时注入 budget 信息而不升级适配器
   */
  modelOverrides?: Record<string, ModelBudgetOverride>;
}

/**
 * 工作区配置——对应 `zhixing.config.json` 的 `workspace` 字段。
 *
 * 工作区是安全系统的信任边界：此目录内的常规文件读写被分类为 internal（低影响），
 * 外部文件操作被分类为 external（需确认）。
 *
 * 这是用户级偏好（知行是个人助手，workspace 跟着人走不跟着目录走），
 * 主要在全局配置 ~/.zhixing/config.json 中设定。
 * 目录级配置可选覆盖，面向开发者。
 */
export interface WorkspaceConfig {
  /**
   * 工作区根目录。
   * 全局配置中必须是绝对路径；目录级配置中可用相对路径（相对于配置文件所在目录）。
   */
  root: string;
  /** 工作区内仍需保护的路径（追加到内置保护路径，如 .git/、.env 等） */
  protectedPaths?: string[];
}

/**
 * 智能体身份配置——对应 `zhixing.config.json` 的 `agent` 字段。
 * 未提供时 core 的 `resolveAgentIdentity` 会回退到默认值 `"知行"`。
 */
export interface AgentConfig {
  /**
   * 面向用户显示的智能体名字，出现在面板标题、确认对话框等位置。
   * 留空或不设则为 `"知行"`。
   */
  displayName?: string;
}

// ─── 通道配置条目 ───

/**
 * 单个社交通道的配置条目（对应 zhixing.config.json 的 `channels.<id>` 字段）。
 *
 * 与 core 的 ChannelConfig 区分：
 * - ChannelConfigEntry 是用户级配置（可选字段多，type 可省略靠 key 推断）
 * - ChannelConfig 是 runtime 级配置（字段完整，由 setupChannels 转换）
 */
export interface ChannelConfigEntry {
  /** 适配器类型标识。省略时使用配置 key 作为 type。 */
  type?: string;
  /** 是否启用此通道。默认 true。 */
  enabled?: boolean;
  /** 凭证（appId/appSecret 等），按适配器要求填写 */
  credentials: Record<string, string>;
  /** 适配器特定选项 */
  options?: Record<string, unknown>;
  /** 通道 owner 的用户标识（自动投递时使用）。channelId 由配置 key 自动填充。 */
  defaultTarget?: { to: string };
}

/** 顶层配置结构（对应 zhixing.config.json） */
export interface ZhixingConfig {
  /** 默认使用的 provider ID */
  defaultProvider?: string;
  /** 默认使用的模型 ID */
  defaultModel?: string;
  /** Provider 配置表 */
  providers?: Record<string, ProviderConfig>;
  /** 通道配置表（key = channelId，如 "feishu"） */
  channels?: Record<string, ChannelConfigEntry>;
  /** 智能体身份配置（名字、人格等） */
  agent?: AgentConfig;
  /** 工作区配置（安全信任边界） */
  workspace?: WorkspaceConfig;
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
