// Provider 层公开 API

// 类型导出
export type {
  AgentConfig,
  IntentConfig,
  LLMRoleConfig,
  MessagingChannelEntry,
  ModelBudgetOverride,
  NetworkConfig,
  Protocol,
  ProviderCredentialEntry,
  ProviderPreset,
  ProviderQuirks,
  ResolvedProvider,
  WorkspaceConfig,
  ZhixingConfig,
  ZhixingCredentials,
} from "./types.js";
export { DEFAULT_QUIRKS } from "./types.js";

// 协议族默认 budget（cli/server 在调用 core.resolveModelInfo 时注入）
export { PROTOCOL_BUDGET_DEFAULTS } from "./protocol-defaults.js";

// 预设
export { getPreset, getPresetIds, PROVIDER_PRESETS } from "./presets.js";

// 模型注意力阈值（领域知识，随知行版本演进；用户可通过 functional 配置覆盖）
export {
  MODEL_CAPABILITIES,
  UNKNOWN_MODEL_CAPABILITY,
  getModelCapabilityOverride,
  normalizeModelId,
  resolveModelCapability,
} from "./model-capability.js";
export type {
  ModelCapability,
  ModelCapabilityOverride,
} from "./model-capability.js";

// 配置解析
export {
  ProviderConfigError,
  resolveFromConfig,
  resolveLLMRoles,
  resolveProvider,
} from "./resolve.js";
export type {
  ResolvedLLMRole,
  ResolvedLLMRoles,
} from "./resolve.js";

// 角色集注册表（角色集单一事实源）
export { AUX_ROLE_SPECS, ROLE_SPECS } from "./role-spec.js";
export type { RoleId, RoleSpec } from "./role-spec.js";

// 档位推荐（"某档位首选哪一对 provider+model"的语义抽象层）
export { ROLE_RECOMMENDATIONS } from "./role-recommendations.js";
export type { RoleRecommendation } from "./role-recommendations.js";

// 协议适配器
export { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";

// 配置加载
export {
  applyConfigPatch,
  ConfigSchemaError,
  ensureWorkspaceDir,
  getDefaultWorkspacePath,
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  resolveHomeDir,
  resolveWorkspace,
  writeConfig,
} from "./config-loader.js";
export type { ResolvedWorkspace, WorkspaceDirStatus, WorkspaceSource } from "./config-loader.js";

// 凭证加载
export {
  applyCredentialsPatch,
  CredentialsSchemaError,
  getCredentialsPath,
  loadCredentials,
  writeCredentials,
} from "./credentials-loader.js";

// 配置语义校验（凭证字段 / 密字段拒绝）
export {
  BUILTIN_VALIDATORS,
  ConfigSemanticError,
  validateConfigSemantics,
} from "./config-validator.js";
export type { ConfigSemanticIssue, ConfigValidator } from "./config-validator.js";

// 一站式工厂
export {
  createProvider,
  createProviderDirect,
  createProviderRoles,
} from "./create-provider.js";
export type {
  ProviderRolesOptions,
  ProviderRolesResult,
} from "./create-provider.js";
