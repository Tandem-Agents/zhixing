/**
 * WorkingState 操作纯函数。
 *
 * 编辑器对 config / credentials 的所有改动都走这里——确保：
 *   - 不可变更新（structuredClone）：每次返回新对象，方便 React-like 渲染
 *   - 字段边界清晰：每个 helper 只动它声明的字段路径
 *   - 测试友好：纯函数无副作用
 */

import type {
  McpServerConfigEntry,
  ProviderCredentialEntry,
  ZhixingConfig,
  ZhixingCredentials,
} from "@zhixing/providers";
import type { ThinkingConfig } from "@zhixing/core";
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

/** 读 llm 角色配置（main / light / power） */
export function readModelRole(
  state: WorkingState,
  role: ModelRole,
): { provider: string; model: string } | undefined {
  return state.config.llm?.[role];
}

/**
 * 设置 llm 角色 provider + model。
 *
 * 角色无关写入：main 是 schema 必填键，写非 main 角色而 llm 尚不存在时，
 * 先放一个占位空 main 保持 schema 合法（写 main 时该占位被同次写入覆盖）。
 * 不再有 `role === "main" ? … : secondary` 的逐角色分支——新增角色零改动。
 */
export function writeModelRole(
  state: WorkingState,
  role: ModelRole,
  provider: string,
  model: string,
): WorkingState {
  const config = structuredClone(state.config);
  const llm = config.llm ?? { main: { provider: "", model: "" } };
  config.llm = { ...llm };
  config.llm[role] = { provider, model };
  return { ...state, config };
}

/** 读 llm 角色的思考控制配置（缺省 undefined = 不发思考参数） */
export function readModelThinking(
  state: WorkingState,
  role: ModelRole,
): ThinkingConfig | undefined {
  return state.config.llm?.[role]?.thinking;
}

/**
 * 设置 llm 角色的思考控制配置——保留已选 provider + model 不动。
 *
 * 仅在该角色已有 provider+model 时有意义（思考控制步骤总在 model 选定后进入）；
 * 防御性兜底：llm/角色缺失时按 writeModelRole 同款占位逻辑保 schema 合法。
 */
export function writeModelThinking(
  state: WorkingState,
  role: ModelRole,
  thinking: ThinkingConfig,
): WorkingState {
  const config = structuredClone(state.config);
  const llm = config.llm ?? { main: { provider: "", model: "" } };
  config.llm = { ...llm };
  const existing = config.llm[role] ?? { provider: "", model: "" };
  config.llm[role] = { ...existing, thinking };
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

// ─── MCP server 字段读写 ───
//
// config.mcp.servers 放连接决策（传输方式 + 启动信息 + 启用开关），credentials.mcp
// 放该 server 的密字段。二者分属两文件、同一 server id 索引——增删改严格成对维护，
// 避免残留孤儿凭证。

/** 读某 MCP server 的连接配置（type / command / args / url / enabled）。 */
export function readMcpServer(
  state: WorkingState,
  serverId: string,
): McpServerConfigEntry | undefined {
  return state.config.mcp?.servers?.[serverId];
}

/** 列出所有已配置的 MCP server id（保配置顺序）。 */
export function listMcpServerIds(state: WorkingState): string[] {
  return Object.keys(state.config.mcp?.servers ?? {});
}

/** server 是否启用——缺省视为启用，仅显式 enabled:false 才停用。 */
export function isMcpServerEnabled(
  state: WorkingState,
  serverId: string,
): boolean {
  return state.config.mcp?.servers?.[serverId]?.enabled !== false;
}

/**
 * 新增 / 整体替换一个 MCP server 的连接配置。
 *
 * 整体替换而非合并：切换传输方式（stdio↔http）时旧字段（command vs url）必须清掉，
 * 合并会残留 stale 字段导致连接规格错乱。凭证另走 patchMcpSecrets。
 */
export function upsertMcpServer(
  state: WorkingState,
  serverId: string,
  entry: McpServerConfigEntry,
): WorkingState {
  const config = structuredClone(state.config);
  if (!config.mcp) config.mcp = {};
  if (!config.mcp.servers) config.mcp.servers = {};
  config.mcp.servers[serverId] = entry;
  return { ...state, config };
}

/** 启停某 server——合并 enabled 标志、保留连接字段；server 不存在则不变。 */
export function setMcpServerEnabled(
  state: WorkingState,
  serverId: string,
  enabled: boolean,
): WorkingState {
  const existing = state.config.mcp?.servers?.[serverId];
  if (!existing) return state;
  const config = structuredClone(state.config);
  config.mcp!.servers![serverId] = { ...existing, enabled };
  return { ...state, config };
}

/**
 * 移除一个 MCP server——同时清 config.mcp.servers 与 credentials.mcp 两处条目，
 * 避免残留孤儿凭证（事务性：随 [完成] 一次落盘）。
 */
export function removeMcpServer(
  state: WorkingState,
  serverId: string,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  if (config.mcp?.servers) delete config.mcp.servers[serverId];
  if (credentials.mcp) delete credentials.mcp[serverId];
  return { ...state, config, credentials };
}

/** 读某 MCP server 的凭证条目（token 等密字段）。 */
export function readMcpSecrets(
  state: WorkingState,
  serverId: string,
): Record<string, string> | undefined {
  return state.credentials.mcp?.[serverId];
}

/** 写 MCP server 凭证字段（合并到现有条目，不丢未提及字段）。 */
export function patchMcpSecrets(
  state: WorkingState,
  serverId: string,
  patch: Record<string, string>,
): WorkingState {
  const credentials = structuredClone(state.credentials);
  if (!credentials.mcp) credentials.mcp = {};
  const existing = credentials.mcp[serverId] ?? {};
  credentials.mcp[serverId] = { ...existing, ...patch };
  return { ...state, credentials };
}
