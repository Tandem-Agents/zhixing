// Provider 层公开 API

// 类型导出
export type {
  AgentConfig,
  ChannelConfigEntry,
  IntentConfig,
  LLMRoleConfig,
  ModelBudgetOverride,
  NetworkConfig,
  Protocol,
  ProviderConfig,
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

// 配置解析
export {
  ProviderConfigError,
  resolveFromConfig,
  resolveLLMRoles,
  resolveProvider,
} from "./resolve.js";
export type {
  LLMRolesResolveOptions,
  ResolvedLLMRole,
  ResolvedLLMRoles,
} from "./resolve.js";

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

// 首次启动必要字段检测
export { checkBootstrap } from "./bootstrap-check.js";
export type { MissingField } from "./bootstrap-check.js";

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
