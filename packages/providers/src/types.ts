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

import type {
  ModelAdapterId,
  ModelInfo,
  ModelInputCapabilityOverride,
  ModelSelectionParams,
  ThinkingConfig,
  ThinkingControl,
} from "@zhixing-ai/core";
import type { MeshRoleBootConfig } from "@zhixing-ai/core/contracts";
import type { ModelCapabilityOverride } from "./model-capability.js";

export type { ModelRoleId } from "@zhixing-ai/core";
export type {
  ModelAdapterId,
  ModelSelectionParams,
} from "@zhixing-ai/core";

// ─── 协议类型 ───

/**
 * 已实现受控协议族（与 core `ModelAdapterId` 完全对齐，覆盖全部四类协议）。
 */
export type Protocol = ModelAdapterId;

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
 * 思考控制方言 —— adapter 据此把已校验的 ChatRequest.thinking 写成该 provider
 * 原生思考参数（deepseek 的 thinking+reasoning_effort / qwen 的
 * enable_thinking+thinking_budget / glm·kimi 的 thinking.type / anthropic 的
 * thinking budget）。新增 provider 方言只加一个枚举值 + 对应 adapter 映射，
 * 与 usageDialect 同为方言派发机制。
 * "none" = 不发送任何思考参数（未知 provider 安全兜底）。
 */
export type ThinkingDialect =
  | "none"
  | "deepseek"
  | "qwen"
  | "glm"
  | "kimi"
  | "anthropic"
  | "openai-responses"
  | "google-interactions";

/**
 * 同协议下不同服务商的行为差异。
 * 预设中包含默认 quirks，自定义 provider 使用最保守的默认值。
 *
 * ─── 架构注记: 协议特定字段的混合 ───
 *
 * 当前 quirks 接口混合了两类字段:
 *   - 协议无关: supportsTools / supportsThinking / supportsStreamUsage
 *   - 协议特定(仅 openai-compatible 消费): maxTokensField / usageDialect
 *   - 跨协议方言派发: thinkingDialect(openai-compatible 多方言 + anthropic 自有，
 *     不计入"协议特定"计数，独立的方言派发维度)
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
  /**
   * Provider 全局粗粒度声明:该 provider 旗下至少有一个 model 支持 thinking 模式
   * (DeepSeek deepseek-v4-pro / Claude extended thinking 等)。
   *
   * 仅用于 UI 层为 provider 打能力标签的粗粒度信号。**运行时不参与**
   * reasoning_content 透传判定 —— openai-compatible adapter 走协议级处理
   * (字段缺失自动跳过),不依赖本声明。
   *
   * Model 维度细粒度声明见 `ModelInfo.supportsThinking`,用于模型选择面板等场景。
   */
  supportsThinking: boolean;
  /** 是否支持 function/tool calling */
  supportsTools: boolean;
  /**
   * Usage 字段方言标识（仅 openai-compatible 协议消费）。
   * 默认 "auto" —— 适配器按嗅探链派发，已知 vendor 应在 preset 显式声明
   * 以获得最短解析路径与可预测性。详见 UsageDialect。
   */
  usageDialect: UsageDialect;
  /**
   * 思考控制方言 —— adapter 据此把已校验的 ChatRequest.thinking 写成该
   * provider 原生思考参数；与 usageDialect 同为方言派发机制。
   * 默认 "none"：不发送任何思考参数（安全兜底）。
   */
  thinkingDialect: ThinkingDialect;
}

/** 最保守的 quirks 默认值，用于未知自定义 provider */
export const DEFAULT_QUIRKS: ProviderQuirks = {
  maxTokensField: "max_tokens",
  supportsStreamUsage: false,
  supportsThinking: false,
  supportsTools: true,
  usageDialect: "auto",
  thinkingDialect: "none",
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
  /** 该服务商的 quirks（未指定的字段使用 DEFAULT_QUIRKS） */
  quirks?: Partial<ProviderQuirks>;
  /**
   * 已知 model catalog（可选）。
   *
   * 仅收录有实际消费价值的元信息；不是服务商可接受模型的白名单。
   * 目录、预算与能力的职责见 docs/modules/providers/model-metadata.md。
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
 * 模型输入能力覆盖条目。
 *
 * 用于网关型 / 自定义 provider 为自由填写的 model id 声明可消费的材料形态。
 * 与 modelOverrides 分开：budget 解决上下文窗口，input capability 解决“能不能理解这类输入”。
 */
export type ModelInputCapabilitiesOverride = ModelInputCapabilityOverride;

/**
 * SecretStore 内存投影中的单个 provider 定义条目。
 *
 * 凭证 + 技术配置都在这里——provider 资源属于"内容层"，集中存放：
 *   - 内置预设 provider（如 siliconflow / openai）：用户只需填 apiKey，其它字段
 *     由内置预设兜底
 *   - 自定义 provider（私有部署 / 代理）：用户通过配置向导录入完整字段
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
   * 模型输入能力覆盖表（key = modelId）。
   *
   * 用于声明未进入 preset catalog 的模型能力，例如 `{ images: true }`。
   * 该信息由 runtime 注入 core 做本地 preflight；不属于 CLI 接入面逻辑。
   */
  modelInputCapabilities?: Record<string, ModelInputCapabilitiesOverride>;

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
 * 工作区配置——对应全局 `~/.zhixing/config.jsonc` 的 `workspace` 字段。
 *
 * 工作区是安全系统的信任边界：此目录内的常规文件读写被分类为 internal（低影响），
 * 外部文件操作被分类为 external（需确认）。
 *
 * 这是用户级偏好（知行是个人助手，workspace 跟着人走不跟着目录走），
 * 在全局配置 ~/.zhixing/config.jsonc 中设定。
 */
export interface WorkspaceConfig {
  /**
   * 工作区根目录。
   * 必须使用绝对路径；这是安全信任边界，不能随启动 cwd 改变。
   */
  root: string;
  /** 工作区内仍需保护的路径（追加到内置保护路径，如 .git/、.env 等） */
  protectedPaths?: string[];
}

/**
 * 智能体身份配置——对应全局 `~/.zhixing/config.jsonc` 的 `agent` 字段。
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
 * 控制意图配置——对应全局 `~/.zhixing/config.jsonc` 的 `intent` 字段。
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
 * 单个消息通道的启用条目（对应全局 `~/.zhixing/config.jsonc` 的 `messaging.<id>` 字段）。
 *
 * config.jsonc 是决策层：本条目仅记录"启用 channel <id> 时的功能选项"——
 * type / options / defaultTarget 等。**不含**任何凭证或链接字段（appId / appSecret 等）——
 * 那些属于设备本地秘密层，由 SecretStore 投影为 credentials.channels.<id>。
 *
 * 一个 channel 出现在 config.messaging 即视为启用；setupChannels 取
 * Object.keys(messaging) 作启用列表，从 SecretStore 的 channel 投影取完整字段。
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
 * 单个 MCP server 的配置条目（决策层，无凭证）。
 *
 * 出现在 config.mcp.servers 即视为接入；远程 server 的凭证（token 等）在
 * credentials.mcp.<id>，本表只放连接决策（传输方式 + 启动信息 + 启用开关）。
 */
export type { McpServerConfigEntry } from "@zhixing-ai/core/mcp-management";
import type { McpServerConfigEntry } from "@zhixing-ai/core/mcp-management";

/**
 * MCP host 配置 —— 知行作为 MCP client 接入的外部 server 集合。
 * 与 messaging 同构：servers 按 id 索引，id 同时用作工具命名的 server 段。
 */
export interface McpConfig {
  servers?: Record<string, McpServerConfigEntry>;
}

/**
 * 旧版（v1）单个 LLM 角色的 provider+model 选择（仅用于旧配置迁移与兼容读取）。
 */
export interface LLMRoleConfig {
  provider: string;
  model: string;
  thinking?: ThinkingConfig;
}

/** 旧版（v1）公开配置 llm 段结构。 */
export interface LegacyLLMConfigV1 {
  main?: LLMRoleConfig;
  light?: LLMRoleConfig;
  power?: LLMRoleConfig;
}

/** 连接级认证配置（v2）：秘密只以稳定逻辑凭据 ID 引用，明文永不落公开配置。 */
export type ConnectionAuthConfig =
  | { readonly mode: "none" }
  | { readonly mode: "api-key"; readonly secretRef: string }
  | { readonly mode: "header"; readonly headerName: string; readonly secretRef: string };

/** 连接级网络代理与私网确认策略（v2）。 */
export interface ConnectionNetworkConfig {
  readonly proxy: "inherit" | "direct";
  readonly allowPrivateOrigin?: boolean;
}

/** 连接级协议方言配置（v2）。 */
export interface ConnectionDialectConfig {
  readonly thinking?: ThinkingDialect;
  readonly usage?: UsageDialect;
}

/** 按精确 modelId 存储的物理容量与输入/思考能力覆盖（v2）。 */
export interface ModelSpecOverride {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsImages?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsThinking?: boolean;
  readonly thinkingControl?: ThinkingControl;
}

/** 单个服务商连接配置（v2 供给层权威，设计 §2.2.1）。 */
export interface ModelConnectionConfig {
  readonly name: string;
  readonly presetId?: string;
  readonly presetRevision?: string;
  readonly ignoredPresetRevision?: string;
  readonly adapter: ModelAdapterId;
  /** 创建时固定的已确认 HTTP(S) URL；预设更新绝不静默改写。 */
  readonly endpoint: string;
  readonly auth: ConnectionAuthConfig;
  readonly network: ConnectionNetworkConfig;
  readonly dialect?: ConnectionDialectConfig;
  readonly customModels?: readonly string[];
  readonly modelOverrides?: Readonly<Record<string, ModelSpecOverride>>;
  readonly hiddenModels?: readonly string[];
}

/** 单个用途角色的选择绑定（v2 用途层权威，单向引用供给层连接）。 */
export interface RoleSelection {
  readonly connectionId: string;
  readonly model: string;
  readonly params?: ModelSelectionParams;
  readonly maxOutputPreference?: number;
}

/** 仅存未归属的非秘密旧覆盖项或受保护旧端点的非秘密用途意图，绝不存秘密或未确认公开性质的旧自定义 URL。 */
export interface MigrationPendingItem {
  readonly id: string;
  readonly kind: "unattributed-override" | "protected-legacy-roles";
  readonly sourceProviderId?: string;
  readonly summary: string;
  readonly legacyRoles?: Readonly<{
    readonly main?: LLMRoleConfig;
    readonly light?: LLMRoleConfig;
    readonly power?: LLMRoleConfig;
  }>;
  readonly legacyFields?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** 公开配置 llm 段（v2 权威结构，设计 §2.2.1）。 */
export interface LLMConfigV2 {
  readonly schemaVersion: 2;
  readonly connections: Readonly<Record<string, ModelConnectionConfig>>;
  readonly main?: RoleSelection;
  readonly light?: RoleSelection;
  readonly power?: RoleSelection;
  readonly attentionPolicies?: Readonly<Record<string, ModelCapabilityOverride>>;
  readonly migrationPending?: readonly MigrationPendingItem[];
}

export function isLLMConfigV2(value: unknown): value is LLMConfigV2 {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2 &&
    typeof (value as { connections?: unknown }).connections === "object" &&
    (value as { connections?: unknown }).connections !== null &&
    !Array.isArray((value as { connections?: unknown }).connections)
  );
}

export function isLegacyLLMConfigV1(value: unknown): value is LegacyLLMConfigV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if ((value as { schemaVersion?: unknown }).schemaVersion === 2) return false;
  const record = value as Record<string, unknown>;
  return (
    record.main !== undefined ||
    record.light !== undefined ||
    record.power !== undefined
  );
}

/** 设备本地 SecretStore v2 模型凭据封闭形状（设计 §2.2.2）。 */
export interface ModelSecretEntryV2 {
  readonly v: 2;
  readonly kind: "api-key" | "header";
  readonly value: string;
}

/** 存放在 SecretStore 固定管理记录 `configuration/model-retirements/v1` 中的待清退/撤权项。 */
export interface PendingModelSecretRetirement {
  readonly operationId: string;
  readonly connectionId: string;
  readonly secretRef: string;
  readonly mode: "retire" | "revoke";
  readonly sourceRevision: string;
  readonly createdAt: string;
  /** 退役登记时原秘密值的 SHA-256 摘要（仅存 SecretStore 管理记录），防止旧清退误删重建/轮换后的新秘密。 */
  readonly secretHash?: string;
}

/** 顶层配置结构（对应全局 ~/.zhixing/config.jsonc）。 */
export interface ZhixingConfig {
  /** Device-local role selection and mesh reachability; trust authorization remains on the trust chain. */
  mesh?: MeshRoleBootConfig;
  /**
   * LLM 连接与三用途配置（v2 权威结构）。
   * 初始空模板仅含未配置态；旧版 v1 文件经配置 owner 安全迁移为 v2。
   */
  llm?: LLMConfigV2;
  /**
   * 启用的消息通道表（key = channelId，如 "feishu"）。
   *
   * 出现在本表的 channel 视为启用；具体凭证与链接字段（appId / appSecret 等）
   * 在设备本地 SecretStore。本表只放功能选项（type / options / defaultTarget）。
   */
  messaging?: Record<string, MessagingChannelEntry>;
  /**
   * 接入的 MCP server 表。
   *
   * 出现在 servers 表的 server 视为接入；远程 server 的凭证在 credentials.mcp.<id>，
   * 本表只放连接决策。MCP 工具以 `mcp__<id>__<tool>` 命名进入 agent 工具集，走与
   * 内置工具相同的安全管线。
   */
  mcp?: McpConfig;
  /** 智能体身份配置（名字、人格等） */
  agent?: AgentConfig;
  /** 控制意图配置（cancel 关键词扩展等） */
  intent?: IntentConfig;
  /** 工作区配置（安全信任边界） */
  workspace?: WorkspaceConfig;
  /** 网络出口配置（@zhixing-ai/network 共享底座） */
  network?: NetworkConfig;
  /** 任务推进闭环配置（单会话保险丝阈值等） */
  advancement?: AdvancementConfig;
  /**
   * 模型注意力阈值覆盖（罕见场景手动调整）—— map key 是 model ID。
   *
   * 数据归属:阈值是模型固有属性,内置 `MODEL_CAPABILITIES` 表覆盖主流模型;
   * 本字段让用户**针对特定 model** 覆盖其阈值,不绑 role —— 用户切换 main /
   * light / power 模型后,旧 override 因 key 不匹配自动失效,不会误套到新模型。
   *
   * key 写法不敏感(用 `normalizeModelId` 双向规范化):带 vendor 前缀
   * (如 `deepseek-ai/DeepSeek-V4-Flash`) / 不带前缀 / 大小写混合,全部命中。
   *
   * 何时手动配置:
   *   - 内置阈值与实测不符(model 在自己场景下表现偏离默认)
   *   - 用了不在内置表的私有 / 自部署模型(走 UNKNOWN 兜底想精调)
   *
   * 不进 SecretStore：领域知识属于功能配置；不持久化到 conversation meta：
   * 模型可换、阈值跟模型走(不是会话级状态)。
   */
  modelCapabilityOverrides?: Record<string, ModelCapabilityOverride>;
}

/**
 * 任务推进闭环配置——对应全局 `~/.zhixing/config.jsonc` 的 `advancement` 字段。
 */
export interface AdvancementConfig {
  /**
   * 单个推进会话的 token 保险丝阈值（全量口径，含裁判与被审 run 两半）。
   * 缺省用系统内置宽值——正常任务永不触碰，它是失控保险不是推进机制；
   * 触达即 budget-exceeded 退出并交付收场。
   */
  sessionTokenBudget?: number;
}

/**
 * 网络出口配置——对应全局 `~/.zhixing/config.jsonc` 的 `network` 字段。
 *
 * 影响所有出站 HTTP（当前消费者：web_fetch；未来：webhook 投递 / MCP HTTP / 第二通道出站）。
 * 详见 [网络出口架构](../../../docs/modules/network/architecture.md)。
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

// ─── 设备本地秘密投影 ───

/**
 * 设备本地 SecretStore 解锁后的进程内投影。
 *
 * **内容层**——provider 与 channel 资源的完整定义集中在此。与 ZhixingConfig
 * 与 ZhixingConfig 物理隔离，不进入 AI、网格、备份或迁移流。
 *
 * 关联机制：通过 id 与 ZhixingConfig 关联——
 *   credentials.providers.<id> ←──refs──── config.llm.main.provider
 *   credentials.channels.<id>  ←──refs──── config.messaging.<id>
 *
 * 持久化单一来源是当前设备 SecretStore；本结构只在受信进程内短暂存在。
 */
export interface ZhixingCredentials {
  /**
   * Schema 版本——v1 省略，v2 写入 2。
   */
  version?: number;
  /**
   * v2 逻辑模型凭据池（key = 稳定逻辑凭据 ID / secretRef，值为封闭形状 ModelSecretEntryV2）。
   */
  modelSecrets?: Record<string, ModelSecretEntryV2>;
  /**
   * v2 封禁凭据（compromised）的不透明版本令牌（key = secretRef）：
   * 仅表达“存在但不可读取”，解除编辑基线死锁且绝不暴露明文秘密。
   */
  compromisedModelSecretTokens?: Record<string, string>;
  /**
   * v2 显式撤销的逻辑凭据集合（持久状态，重启不复活为就绪）。
   */
  revokedModelSecretRefs?: string[];
  /**
   * 无法自动确认公开性质的旧自定义 URL 受保护记录（继续留存 SecretStore，经迁移修复确认后才公开）。
   */
  protectedLegacyProviders?: Record<string, ProviderCredentialEntry>;
  /**
   * 旧版 v1 Provider 资源池（仅用于兼容读取与迁移）。
   */
  providers?: Record<string, ProviderCredentialEntry>;
  /**
   * Channel 资源池：按 channel id 索引；含该 channel 的所有字段（含 appId
   * 等链接信息与 appSecret 等密字段）。具体字段由 channel 适配器约定。
   */
  channels?: Record<string, Record<string, string>>;
  /**
   * MCP server 凭证池：按 server id 索引；含远程 server 的 token / apiKey 等密字段，
   * 具体字段由接入引导按 server 约定。与 channels 同构，只经 SecretStore
   * 专用流程读写。
   */
  mcp?: Record<string, Record<string, string>>;
}

type CredentialProjection<K extends keyof ZhixingCredentials> = Readonly<
  Pick<ZhixingCredentials, K> &
    Partial<Record<Exclude<keyof ZhixingCredentials, K>, never>>
>;

/** 运行时 provider 工厂所需的最小秘密投影，不携带 channel / MCP 凭据。 */
export type ProviderCredentialProjection = CredentialProjection<
  | "modelSecrets"
  | "compromisedModelSecretTokens"
  | "revokedModelSecretRefs"
  | "protectedLegacyProviders"
  | "providers"
>;

/** channel 接入面所需的最小秘密投影，不携带 provider / MCP 凭据。 */
export type ChannelCredentialProjection = CredentialProjection<"channels">;

/** MCP 装配桥接所需的最小秘密投影，不携带 provider / channel 凭据。 */
export type McpCredentialProjection = CredentialProjection<"mcp">;

// ─── 解析后的 Provider ───

/** 合并连接配置 + 窄目录资料 + 逻辑凭据后的完整 Provider，可直接传给协议适配器 */
export interface ResolvedProvider {
  /** 连接 / Provider 标识符 */
  id: string;
  /** 稳定连接 ID（v2 与 id 一致） */
  connectionId?: string;
  /** 显示名称 */
  name: string;
  /** API 端点 */
  baseUrl: string;
  /** 非秘密来源指纹（origin + basePath，供跨连接/改址历史投影隔离） */
  sourceOriginKey?: string;
  /** 认证模式（免密 / Bearer api-key / 自定义认证头） */
  authMode?: "none" | "api-key" | "header";
  /** 自定义认证头名称（仅 authMode === "header"） */
  authHeaderName?: string;
  /** 逻辑凭据引用 ID（不含明文） */
  secretRef?: string;
  /** 解析后的明文秘密（免密连接为空字符串） */
  apiKey: string;
  /** 使用的受控协议 */
  protocol: Protocol;
  /** 行为差异配置 */
  quirks: ProviderQuirks;
  /** 连接级代理与私网确认策略 */
  network?: ConnectionNetworkConfig;
  /** 产品级 network.proxy 设置（由模型投影下传） */
  networkProxy?: NetworkConfig["proxy"];
  /** 已知 model catalog（由目录与发现经三层合成统一产出） */
  declaredModels: readonly ModelInfo[];
  /** 经硬约束钳制后的有效模型预算覆盖表（key = modelId） */
  modelOverrides?: Record<string, ModelBudgetOverride>;
  /** 经硬约束钳制后的有效模型输入能力覆盖表（key = modelId） */
  modelInputCapabilities?: Record<string, ModelInputCapabilitiesOverride>;
  /** 用户规格覆盖与硬约束冲突记录（保留原输入同时钳制运行有效值，key = modelId） */
  overrideConflicts?: Readonly<
    Record<
      string,
      readonly {
        readonly field:
          | "contextWindow"
          | "maxOutputTokens"
          | "supportsImages"
          | "supportsTools"
          | "supportsThinking";
        readonly requestedValue: number | boolean;
        readonly hardLimit: number | boolean;
        readonly constraintSource: string;
        readonly message: string;
      }[]
    >
  >;
}
