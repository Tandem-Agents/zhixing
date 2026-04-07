// Provider 层公开 API

// 类型导出
export type {
  Protocol,
  ProviderConfig,
  ProviderPreset,
  ProviderQuirks,
  ResolvedProvider,
  ZhixingConfig,
} from "./types.js";
export { DEFAULT_QUIRKS } from "./types.js";

// 预设
export { getPreset, getPresetIds, PROVIDER_PRESETS } from "./presets.js";

// 配置解析
export { ProviderConfigError, resolveFromConfig, resolveProvider } from "./resolve.js";

// 协议适配器
export { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";

// 一站式工厂
export { createProvider, createProviderDirect } from "./create-provider.js";
