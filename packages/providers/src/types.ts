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

import type { ModelInfo } from "@zhixing/core";

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
  /** 默认模型 ID */
  defaultModel?: string;
  /** 该服务商的 quirks（未指定的字段使用 DEFAULT_QUIRKS） */
  quirks?: Partial<ProviderQuirks>;
  /**
   * 已知 model catalog（可选）。
   *
   * 当前所有 preset 都不内嵌——budget 跟 PROTOCOL_BUDGET_DEFAULTS 一致时，内嵌
   * 是负维护无价值（详见 research/design/drafts/model-budget-resolution.md §4.3）。
   * 字段保留作扩展点：未来真有 model 的 budget 跟协议族默认显著不同
   * （如 1M context 变体），届时按需补充。
   */
  knownModels?: readonly ModelInfo[];
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

/**
 * 控制意图配置——对应 `zhixing.config.json` 的 `intent` 字段。
 *
 * 用于让用户/团队在不改源码的前提下扩展 cancel 关键词集。启动时
 * 与 server 的 `DEFAULT_CANCEL_KEYWORDS` 合并(append 而非 replace,避免误删默认),
 * 并通过 `IntentClassifier` 的 disjoint 静态校验——配错关键词跟
 * confirmation APPROVE/DENY 集合冲突时启动失败 fail-fast,优于在生产产生歧义。
 */
export interface IntentConfig {
  /**
   * 用户追加的 cancel 关键词。
   *
   * 例:某团队习惯用"打断"作为中止指令——可在配置加 `["打断"]`,启动时
   * 与默认集合并。**配错示例**:加"取消"会因与 confirmation DENY_SET 冲突
   * 而启动失败,此时应选其他不冲突的词。
   */
  cancelKeywords?: string[];
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

/**
 * 单个 LLM 角色的 provider+model 选择。
 *
 * - provider：必须是 ZhixingConfig.providers 表中的 key（或内置预设 ID）
 * - model：该 provider 可识别的模型 ID
 */
export interface LLMRoleConfig {
  provider: string;
  model: string;
}

/** 顶层配置结构（对应 zhixing.config.json） */
export interface ZhixingConfig {
  /**
   * LLM 角色配置：
   * - main 必填——主对话循环、用户面对的最终输出
   * - secondary 可缺省——I/O 边界净化（上下文压缩、WebFetch distill、工具结果摘要等）
   *   缺省时直接用 main 实例 + main.model 兜底（隔离价值仍保留，仅放弃任务专门化）。
   *   不预设任何 vendor 默认（provider 选择是用户主权范畴）。
   *
   * 类型为 optional 是为了反映 loadConfig 的真实输出形状——文件可能缺这一段。
   * 真正的 fail-fast 校验在 resolveLLMRoles / resolveFromConfig 入口集中处理；
   * 不消费 LLM 的纯 workspace / channels 路径不会被这里的缺失误伤。
   */
  llm?: {
    main: LLMRoleConfig;
    secondary?: LLMRoleConfig;
  };
  /** Provider 配置表 */
  providers?: Record<string, ProviderConfig>;
  /** 通道配置表（key = channelId，如 "feishu"） */
  channels?: Record<string, ChannelConfigEntry>;
  /** 智能体身份配置（名字、人格等） */
  agent?: AgentConfig;
  /** 控制意图配置（cancel 关键词扩展等） */
  intent?: IntentConfig;
  /** 工作区配置（安全信任边界） */
  workspace?: WorkspaceConfig;
  /** 网络出口配置（@zhixing/network 共享底座） */
  network?: NetworkConfig;
}

/**
 * 网络出口配置——对应 `zhixing.config.json` 的 `network` 字段。
 *
 * 影响所有出站 HTTP（当前消费者：web_fetch；未来：webhook 投递 / MCP HTTP / 第二通道出站）。
 * 详见 [network-egress.md §十三](../../../research/design/specifications/network-egress.md)。
 */
export interface NetworkConfig {
  /**
   * 代理配置（默认 "auto"）：
   *   - undefined / "auto"：从环境变量读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（Unix 惯例）
   *   - "off"：显式禁用,即使环境变量有也不用代理
   *   - "http://host:port" / "https://host:port"：显式代理 URL（覆盖环境变量）
   *
   * 中国用户 99% 已被代理软件（Clash/V2Ray）自动设了 HTTP_PROXY，无需手动配置。
   * 仅当代理软件没设环境变量、或想 zhixing 走与系统不同的代理时，才需要在此显式配置。
   */
  proxy?: "auto" | "off" | string;
}

// ─── 用户级凭证文件 ───

/**
 * 用户凭证文件结构（对应 ~/.zhixing/credentials.json）。
 *
 * 与 ZhixingConfig 物理隔离：AI 工具体系完全不可读 / 不可写
 * （由 builtin 安全规则强制隔离，规则文档在 security 包中）。
 *
 * 关联机制：与 config.providers.<id> / config.channels.<id> 通过 id 关联。
 * 不参与项目级配置级联——凭证是用户级单一来源，避免项目级配置泄漏到 git。
 */
export interface ZhixingCredentials {
  /** schema 版本，用于未来迁移；当前固定为 1 */
  version: 1;
  /** Provider 凭证：按 provider id 索引 */
  providers?: Record<string, { apiKey: string }>;
  /** Channel 凭证：按 channel id 索引；字段由具体 channel 适配器决定 */
  channels?: Record<string, Record<string, string>>;
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
  /**
   * 已知 model catalog（来自 preset.knownModels）。
   *
   * adapter 会原样写入 LLMProvider.models[]，供 ContextEngine 的 budget 解析使用。
   * 不变量：不得包含占位条目（id="unknown" 等）；缺失就返回空数组。
   */
  declaredModels: readonly ModelInfo[];
}
