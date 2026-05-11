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
import type { ModelCapabilityOverride } from "./model-capability.js";

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
 * OpenAI 兼容协议下 usage 字段的方言标识。
 *
 * "OpenAI 兼容"是协议层概念，但各 vendor 在 usage 的 cache 字段上存在方言分裂：
 *   - "openai-standard": usage.prompt_tokens_details.cached_tokens
 *                        覆盖 OpenAI / MiniMax / Kimi / 智谱 / 通义 等大多数兼容服务
 *   - "deepseek":        usage.prompt_cache_hit_tokens + prompt_cache_miss_tokens
 *                        DeepSeek 自有方言
 *   - "auto":            按嗅探链派发，未显式声明的 vendor 默认值（DeepSeek-aware
 *                        优先，OpenAI 标准兜底；嗅探失败回落 base 仅 prompt/completion）
 *
 * 扩展点：新 vendor 出现非标方言时，在 openai-usage.ts 加一个 parser 函数 +
 * PARSERS 注册表新增条目，再扩展本类型字面量即可，主适配器无需改动。
 *
 * 仅对 protocol="openai-compatible" 生效；anthropic-messages 协议有自己的 cache
 * 字段（cache_read_input_tokens 等），由 anthropic 适配器内联处理。
 */
export type UsageDialect = "auto" | "openai-standard" | "deepseek";

/**
 * 同协议下不同服务商的行为差异。
 * 预设中包含默认 quirks，自定义 provider 使用最保守的默认值。
 *
 * ─── 架构注记: 协议特定字段的混合 ───
 *
 * 当前 quirks 接口混合了两类字段:
 *   - 协议无关: supportsTools / supportsThinking / supportsStreamUsage
 *   - 协议特定(仅 openai-compatible 消费): maxTokensField / usageDialect
 *
 * 这是延续的工程惯例 —— 协议特定字段对其他协议路径无害(由各协议适配器选择性
 * 消费,anthropic-messages 不读这些字段)。优势是 ResolvedProvider.quirks 单
 * 接口、合并逻辑 mergeQuirks 单点、字面量构造统一 spread DEFAULT_QUIRKS。
 *
 * 升级触发线: 协议特定字段超过 3 个 / 或出现"两协议特定字段语义冲突"时,应重构
 * 为按 protocol 判别的联合类型(OpenAICompatibleQuirks | AnthropicMessagesQuirks)。
 * 当前 2 个字段尚未触线,保持现状。
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
  /**
   * Usage 字段方言标识（仅 openai-compatible 协议消费）。
   * 默认 "auto" —— 适配器按嗅探链派发，已知 vendor 应在 preset 显式声明
   * 以获得最短解析路径与可预测性。详见 UsageDialect。
   */
  usageDialect: UsageDialect;
}

/** 最保守的 quirks 默认值，用于未知自定义 provider */
export const DEFAULT_QUIRKS: ProviderQuirks = {
  maxTokensField: "max_tokens",
  supportsStreamUsage: false,
  supportsThinking: false,
  supportsTools: true,
  usageDialect: "auto",
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

/**
 * 凭证文件中单个 provider 的完整定义条目（对应 ~/.zhixing/credentials.json 的
 * `providers.<id>` 字段）。
 *
 * 凭证 + 技术配置都在这里——provider 资源属于"内容层"，集中存放：
 *   - 内置预设 provider（如 siliconflow / openai）：用户只需填 apiKey，其它字段
 *     由内置预设兜底
 *   - 自定义 provider（私有部署 / 代理）：用户在 credentials.json 写完整字段
 *     （apiKey + baseUrl + protocol + 等），不预设
 *
 * 与 ZhixingConfig 的关系：config.llm.main.provider 引用本表的 key；本表是
 * provider 资源池。
 */
export interface ProviderCredentialEntry {
  /** API Key（必填） */
  apiKey: string;
  /** 覆盖预设的 baseUrl（用于代理/聚合平台/私有部署） */
  baseUrl?: string;
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

  /**
   * 用户在配置编辑器中追加的自定义模型 ID 列表（去重保序）。
   *
   * 仅供 UI 展示——配置编辑器把"preset 默认 + 用户自定义"合并展示在模型选择面板，
   * 让用户可挑选适配器 catalog 之外的模型 ID。
   *
   * **不影响运行时 declaredModels 解析**：`resolveProvider.declaredModels` 仅来自
   * `preset.knownModels`（带 budget 信息的 catalog）；用户自定义模型 ID 通过
   * `modelOverrides[modelId]` 显式注入 budget，或由 `protocol-defaults` 兜底。
   */
  models?: string[];
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

// ─── 消息通道启用条目 ───

/**
 * 单个消息通道的启用条目（对应 zhixing.config.json 的 `messaging.<id>` 字段）。
 *
 * config.json 是决策层：本条目仅记录"启用 channel <id> 时的功能选项"——
 * type / options / defaultTarget 等。**不含**任何凭证或链接字段（appId / appSecret 等）——
 * 那些属于内容层，集中在 credentials.channels.<id>。
 *
 * 一个 channel 出现在 config.messaging 即视为启用；setupChannels 取
 * Object.keys(messaging) 作启用列表，从 credentials.channels.<id> 取完整字段。
 *
 * 与 core 的 ChannelConfig 区分：
 * - MessagingChannelEntry 是 config 层的启用条目（无凭证字段）
 * - ChannelConfig 是 runtime 级配置（字段完整，由 setupChannels 合并产出）
 */
export interface MessagingChannelEntry {
  /** 适配器类型标识。省略时使用配置 key 作为 type。 */
  type?: string;
  /** 适配器特定选项（功能层配置，非凭证） */
  options?: Record<string, unknown>;
  /** 通道 owner 的用户标识（自动投递时使用）。channelId 由配置 key 自动填充。 */
  defaultTarget?: { to: string };
}

/**
 * 单个 LLM 角色的 provider+model 选择。
 *
 * - provider：必须是内置预设 ID 或 credentials.providers 表中的 key
 * - model：该 provider 可识别的模型 ID
 */
export interface LLMRoleConfig {
  provider: string;
  model: string;
}

/**
 * 顶层配置结构（对应 ~/.zhixing/config.json）。
 *
 * config.json 是**决策层**——只记录"启用什么、用哪个"等上层选择。
 * 资源完整定义（provider 凭证 + 技术配置 / channel 凭证 + 链接信息）属于
 * **内容层**，集中在 ZhixingCredentials。
 *
 * 通过 id 关联两层：
 *   config.llm.main.provider   ──refs──>  credentials.providers.<id>
 *   config.messaging.<id>      ──refs──>  credentials.channels.<id>
 */
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
   * 不消费 LLM 的纯 workspace / messaging 路径不会被这里的缺失误伤。
   */
  llm?: {
    main: LLMRoleConfig;
    secondary?: LLMRoleConfig;
  };
  /**
   * 启用的消息通道表（key = channelId，如 "feishu"）。
   *
   * 出现在本表的 channel 视为启用；具体凭证与链接字段（appId / appSecret 等）
   * 在 credentials.channels.<id>。本表只放功能选项（type / options / defaultTarget）。
   */
  messaging?: Record<string, MessagingChannelEntry>;
  /** 智能体身份配置（名字、人格等） */
  agent?: AgentConfig;
  /** 控制意图配置（cancel 关键词扩展等） */
  intent?: IntentConfig;
  /** 工作区配置（安全信任边界） */
  workspace?: WorkspaceConfig;
  /** 网络出口配置（@zhixing/network 共享底座） */
  network?: NetworkConfig;
  /**
   * 模型注意力阈值覆盖（罕见场景手动调整）。
   *
   * 知行内置 `MODEL_CAPABILITIES` 已覆盖主流模型，本字段仅用于：
   *   - 内置数据滞后于实测（用户发现某模型实际表现与默认阈值不符）
   *   - 自定义私有模型 / 不在内置表的模型（走 UNKNOWN 兜底但想精调）
   *
   * key 为 modelId（小写匹配，与 `MODEL_CAPABILITIES` 命名约定一致）。
   * 值是 Partial —— 用户可只指定 optimalMaxTokens 或 riskMaxTokens 之一，
   * 另一个走内置默认。
   *
   * 不进 credentials.json：领域知识属于功能配置；不持久化到 conversation meta：
   * 模型可换、阈值跟模型走（不是会话级状态）。
   */
  modelCapabilityOverrides?: Record<string, ModelCapabilityOverride>;
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
 * **内容层**——provider 与 channel 资源的完整定义集中在此。与 ZhixingConfig
 * 物理隔离：AI 工具体系完全不可读 / 不可写（由 builtin 安全规则强制隔离）。
 *
 * 关联机制：通过 id 与 ZhixingConfig 关联——
 *   credentials.providers.<id> ←──refs──── config.llm.main.provider
 *   credentials.channels.<id>  ←──refs──── config.messaging.<id>
 *
 * 不参与项目级配置级联——凭证是用户级单一来源，避免项目级配置泄漏到 git。
 */
export interface ZhixingCredentials {
  /**
   * Schema 版本——可选字段，预留未来 schema 升级时探测使用。
   *
   * 当前唯一 schema 不写此字段；未来引入新 schema 时按"无字段=v1，version=2=v2"
   * 探测策略升级，不需要现在主动写入。
   */
  version?: number;
  /**
   * Provider 资源池：按 provider id 索引。
   *
   * 内置预设 provider（siliconflow / openai 等）：用户只填 apiKey；
   * 自定义 provider：用户填完整字段（apiKey + baseUrl + protocol + ...）。
   */
  providers?: Record<string, ProviderCredentialEntry>;
  /**
   * Channel 资源池：按 channel id 索引；含该 channel 的所有字段（含 appId
   * 等链接信息与 appSecret 等密字段）。具体字段由 channel 适配器约定。
   */
  channels?: Record<string, Record<string, string>>;
}

// ─── 解析后的 Provider ───

/** 合并预设 + 用户凭证条目后的完整 Provider，可直接传给协议适配器 */
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
  /**
   * 模型预算覆盖表（来自 credentials.providers.<id>.modelOverrides）。
   *
   * Consumer（orchestrator）调 resolveModelInfo 时传入；不在 ResolvedProvider 上
   * 时下游 caller 需自己回查 credentials，破坏配置层封装——故让 ResolvedProvider
   * 携带，避免下游再触达原始 credentials。
   */
  modelOverrides?: Record<string, ModelBudgetOverride>;
}
