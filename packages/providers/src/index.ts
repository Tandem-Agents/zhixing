// Provider 层公开 API

// 类型导出
export type {
  AgentConfig,
  ChannelConfigEntry,
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
} from "./types.js";
export { DEFAULT_QUIRKS } from "./types.js";

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
  ensureWorkspaceDir,
  getDefaultWorkspacePath,
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  resolveWorkspace,
} from "./config-loader.js";
export type { ResolvedWorkspace, WorkspaceDirStatus, WorkspaceSource } from "./config-loader.js";

// 一站式工厂
export {
  createProvider,
  createProviderDirect,
  createProviderRoles,
} from "./create-provider.js";
export type { ProviderRolesOptions } from "./create-provider.js";
