/**
 * WorkingState 操作纯函数。
 *
 * 编辑器对 config / credentials 的所有改动都走这里——确保：
 *   - 不可变更新（structuredClone）：每次返回新对象，方便 React-like 渲染
 *   - 字段边界清晰：每个 helper 只动它声明的字段路径
 *   - 测试友好：纯函数无副作用
 */

import type {
  ProviderCredentialEntry,
  ZhixingConfig,
  ZhixingCredentials,
} from "@zhixing/providers";
import type { ModelRole, WorkingState } from "./types.js";

// ─── 初始化 ───

export function createInitialState(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): WorkingState {
  return {
    config: structuredClone(config),
    credentials: structuredClone(credentials),
    inputBuffer: "",
  };
}

// ─── 输入 buffer 操作 ───

export function setInputBuffer(state: WorkingState, buffer: string): WorkingState {
  return { ...state, inputBuffer: buffer };
}

export function clearInputBuffer(state: WorkingState): WorkingState {
  return { ...state, inputBuffer: "" };
}

// ─── 模型角色字段读写 ───

/** 读 llm 角色配置（main / secondary） */
export function readModelRole(
  state: WorkingState,
  role: ModelRole,
): { provider: string; model: string } | undefined {
  return state.config.llm?.[role];
}

/** 设置 llm 角色 provider + model */
export function writeModelRole(
  state: WorkingState,
  role: ModelRole,
  provider: string,
  model: string,
): WorkingState {
  const config = structuredClone(state.config);
  if (!config.llm) {
    config.llm = role === "main"
      ? { main: { provider, model } }
      : { main: { provider: "", model: "" }, secondary: { provider, model } };
    return { ...state, config };
  }
  if (role === "main") {
    config.llm.main = { provider, model };
  } else {
    config.llm.secondary = { provider, model };
  }
  return { ...state, config };
}

// ─── Provider 凭证字段读写 ───

/** 读 provider 凭证条目 */
export function readProviderEntry(
  state: WorkingState,
  providerId: string,
): ProviderCredentialEntry | undefined {
  return state.credentials.providers?.[providerId];
}

/** 写 provider 的某个字段（合并到现有条目） */
export function patchProviderEntry(
  state: WorkingState,
  providerId: string,
  patch: Partial<ProviderCredentialEntry>,
): WorkingState {
  const credentials = structuredClone(state.credentials);
  if (!credentials.providers) credentials.providers = {};
  const existing = credentials.providers[providerId] ?? { apiKey: "" };
  credentials.providers[providerId] = { ...existing, ...patch };
  return { ...state, credentials };
}

/** 给 provider 追加自定义模型（去重） */
export function addProviderModel(
  state: WorkingState,
  providerId: string,
  modelId: string,
): WorkingState {
  const credentials = structuredClone(state.credentials);
  if (!credentials.providers) credentials.providers = {};
  const existing = credentials.providers[providerId] ?? { apiKey: "" };
  const models = existing.models ?? [];
  if (models.includes(modelId)) {
    return state;
  }
  credentials.providers[providerId] = {
    ...existing,
    models: [...models, modelId],
  };
  return { ...state, credentials };
}

// ─── Channel 字段读写 ───

/** 读 channel 凭证条目（appId / appSecret 等所有字段） */
export function readChannelEntry(
  state: WorkingState,
  channelId: string,
): Record<string, string> | undefined {
  return state.credentials.channels?.[channelId];
}

/** 写 channel 的某个字段（合并到现有条目） */
export function patchChannelEntry(
  state: WorkingState,
  channelId: string,
  patch: Record<string, string>,
): WorkingState {
  const credentials = structuredClone(state.credentials);
  if (!credentials.channels) credentials.channels = {};
  const existing = credentials.channels[channelId] ?? {};
  credentials.channels[channelId] = { ...existing, ...patch };
  return { ...state, credentials };
}

/** 启用 channel：在 config.messaging 加入空条目（已存在则不变） */
export function enableMessaging(
  state: WorkingState,
  channelId: string,
): WorkingState {
  const config = structuredClone(state.config);
  if (!config.messaging) config.messaging = {};
  if (!config.messaging[channelId]) {
    config.messaging[channelId] = {};
  }
  return { ...state, config };
}

/** 关闭 channel：从 config.messaging 移除 */
export function disableMessaging(
  state: WorkingState,
  channelId: string,
): WorkingState {
  const config = structuredClone(state.config);
  if (!config.messaging) return state;
  delete config.messaging[channelId];
  return { ...state, config };
}

export function isMessagingEnabled(state: WorkingState, channelId: string): boolean {
  return state.config.messaging?.[channelId] !== undefined;
}
