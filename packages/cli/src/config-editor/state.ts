/**
 * WorkingState 操作纯函数。
 *
 * 编辑器对 config / credentials 的所有改动都走这里——确保：
 *   - 不可变更新（structuredClone）：每次返回新对象，方便 React-like 渲染
 *   - 字段边界清晰：每个 helper 只动它声明的字段路径
 *   - 测试友好：纯函数无副作用
 */

import { randomUUID } from "node:crypto";
import {
  computeCredentialRevisionToken,
  DEFAULT_MODEL_CATALOG_PORT,
  getPreset,
  hasExplicitUrlCredentialsOrQueryAuth,
  isLLMConfigV2,
  mergeLegacyModelOverrides,
  normalizeModelId,
  sanitizeEndpointForCache,
  synthesizeConnectionModels,
  type DiscoverConnectionModelsResult,
  type LLMConfigV2,
  type LLMRoleConfig,
  type McpServerConfigEntry,
  type MigrationPendingItem,
  type ModelCatalogPort,
  type ModelConnectionConfig,
  type ModelSpecOverride,
  type PendingModelSecretRetirement,
  type PresetUpdateSuggestion,
  type ProviderCredentialEntry,
  type RoleSelection,
  type VerifyModelGenerationResult,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing-ai/providers";
import { isLocalOrPrivateHostname } from "@zhixing-ai/network";
import type { ModelAdapterId, ThinkingConfig, ThinkingControl } from "@zhixing-ai/core";
import { describeProvenanceSource } from "../terminal/model-command.js";
import type { ModelRole, WorkingState } from "./types.js";
import { connectionCredentialStatus, type ConnectionCredentialStatus } from "./checks/model.js";

// ─── 初始化 ───

export function createInitialState(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): WorkingState {
  return {
    config: structuredClone(config),
    credentials: structuredClone(credentials),
    draftSessionId: randomUUID(),
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

// ─── v2 内部归范化工具 ───

export function buildPresetConnection(
  presetId: string,
  catalog: ModelCatalogPort = DEFAULT_MODEL_CATALOG_PORT,
  connectionId: string = presetId,
): ModelConnectionConfig | undefined {
  const entry = catalog.getPreset(presetId);
  if (!entry) return undefined;
  const curated = entry.curated;
  const auth: ModelConnectionConfig["auth"] =
    curated.defaultAuthMode === "none"
      ? { mode: "none" }
      : curated.defaultAuthMode === "header"
        ? {
            mode: "header",
            headerName: curated.defaultHeaderName ?? "X-Api-Key",
            secretRef: connectionId,
          }
        : { mode: "api-key", secretRef: connectionId };
  return {
    name: connectionId === presetId ? curated.ui.label : `${curated.ui.label} (${connectionId})`,
    presetId,
    presetRevision: entry.revision,
    adapter: curated.protocol,
    endpoint: curated.baseUrl.replace(/\/+$/u, ""),
    auth,
    network: {
      proxy: curated.defaultNetwork?.proxy ?? "inherit",
      ...(curated.defaultNetwork?.allowPrivateOrigin ? { allowPrivateOrigin: true } : {}),
    },
  };
}

function ensureLlmV2Mutable(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): LLMConfigV2 {
  const raw = config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    credentials.version = 2;
    return raw;
  }
  const connections: Record<string, ModelConnectionConfig> = {};
  const legacyProviders = credentials.providers ?? {};
  const legacyLlm = config.llm;
  const candidateIds = new Set<string>([
    ...Object.keys(legacyProviders),
    ...(legacyLlm?.main?.provider ? [legacyLlm.main.provider] : []),
    ...(legacyLlm?.light?.provider ? [legacyLlm.light.provider] : []),
    ...(legacyLlm?.power?.provider ? [legacyLlm.power.provider] : []),
  ]);
  const pendingItems: MigrationPendingItem[] = [];
  const migratedIds = new Set<string>();
  credentials.version = 2;
  for (const id of candidateIds) {
    if (!id) continue;
    const entry = legacyProviders[id];
    if (entry?.baseUrl !== undefined && hasExplicitUrlCredentialsOrQueryAuth(entry.baseUrl)) {
      credentials.protectedLegacyProviders ??= {};
      credentials.protectedLegacyProviders[id] = entry;
      const legacyRoles: { main?: LLMRoleConfig; light?: LLMRoleConfig; power?: LLMRoleConfig } = {};
      if (legacyLlm?.main?.provider === id) legacyRoles.main = legacyLlm.main;
      if (legacyLlm?.light?.provider === id) legacyRoles.light = legacyLlm.light;
      if (legacyLlm?.power?.provider === id) legacyRoles.power = legacyLlm.power;
      const nonSecretFields: Record<string, unknown> = {};
      if (entry.modelOverrides) nonSecretFields.modelOverrides = entry.modelOverrides;
      if (entry.modelInputCapabilities) nonSecretFields.modelInputCapabilities = entry.modelInputCapabilities;
      if (entry.models?.length) nonSecretFields.models = [...entry.models];
      if (entry.quirks) nonSecretFields.quirks = entry.quirks;
      if (Object.keys(legacyRoles).length > 0 || Object.keys(nonSecretFields).length > 0) {
        pendingItems.push({
          id: `protected-roles-${id}`,
          kind: "protected-legacy-roles",
          sourceProviderId: id,
          summary: `旧自定义服务商 "${id}" 端点含敏感认证信息，待替换确认后恢复用途绑定`,
          ...(Object.keys(legacyRoles).length > 0 ? { legacyRoles } : {}),
          ...(Object.keys(nonSecretFields).length > 0 ? { legacyFields: nonSecretFields } : {}),
          createdAt: new Date().toISOString(),
        });
      }
      continue;
    }
    const catalogPreset = DEFAULT_MODEL_CATALOG_PORT.getPreset(id);
    const preset = catalogPreset?.preset ?? getPreset(id);
    const endpoint = entry?.baseUrl ?? preset?.baseUrl ?? "https://api.openai.com/v1";
    const adapter = entry?.protocol ?? preset?.protocol ?? "openai-compatible";
    let isPrivate = false;
    try {
      isPrivate = isLocalOrPrivateHostname(new URL(endpoint).hostname);
    } catch {
      isPrivate = false;
    }
    const mergedOverrides = mergeLegacyModelOverrides(
      entry?.modelOverrides,
      entry?.modelInputCapabilities,
    );
    connections[id] = {
      name: catalogPreset?.curated.ui.label ?? preset?.name ?? id,
      ...(preset ? { presetId: id } : {}),
      adapter,
      endpoint: endpoint.replace(/\/+$/u, ""),
      auth: { mode: "api-key", secretRef: id },
      network: {
        proxy: isPrivate ? "direct" : "inherit",
        ...(isPrivate ? { allowPrivateOrigin: true } : {}),
      },
      ...(entry?.quirks?.thinkingDialect || entry?.quirks?.usageDialect
        ? {
            dialect: {
              ...(entry.quirks.thinkingDialect ? { thinking: entry.quirks.thinkingDialect } : {}),
              ...(entry.quirks.usageDialect ? { usage: entry.quirks.usageDialect } : {}),
            },
          }
        : {}),
      ...(entry?.models && entry.models.length > 0 ? { customModels: [...entry.models] } : {}),
      ...(Object.keys(mergedOverrides).length > 0 ? { modelOverrides: mergedOverrides } : {}),
    };
    migratedIds.add(id);
    if (entry?.apiKey && entry.apiKey.trim().length > 0) {
      credentials.modelSecrets ??= {};
      credentials.modelSecrets[id] = { v: 2, kind: "api-key", value: entry.apiKey };
    }
  }
  const mapRole = (
    r: { provider: string; model: string; thinking?: ThinkingConfig } | undefined,
  ): RoleSelection | undefined => {
    if (!r || !r.provider || !r.model || !migratedIds.has(r.provider)) return undefined;
    return {
      connectionId: r.provider,
      model: r.model,
      ...(r.thinking ? { params: { thinking: r.thinking } } : {}),
    };
  };
  const attentionPolicies: NonNullable<LLMConfigV2["attentionPolicies"]> = {};
  for (const [modelKey, policy] of Object.entries(config.modelCapabilityOverrides ?? {})) {
    attentionPolicies[normalizeModelId(modelKey)] = {
      ...(policy.optimalMaxTokens !== undefined ? { optimalMaxTokens: policy.optimalMaxTokens } : {}),
      ...(policy.riskMaxTokens !== undefined ? { riskMaxTokens: policy.riskMaxTokens } : {}),
    };
  }
  const v2: LLMConfigV2 = {
    schemaVersion: 2,
    connections,
    ...(mapRole(legacyLlm?.main) ? { main: mapRole(legacyLlm?.main)! } : {}),
    ...(mapRole(legacyLlm?.light) ? { light: mapRole(legacyLlm?.light)! } : {}),
    ...(mapRole(legacyLlm?.power) ? { power: mapRole(legacyLlm?.power)! } : {}),
    ...(Object.keys(attentionPolicies).length > 0 ? { attentionPolicies } : {}),
    ...(pendingItems.length > 0 ? { migrationPending: pendingItems } : {}),
  };
  delete credentials.providers;
  if (config.modelCapabilityOverrides !== undefined) {
    delete config.modelCapabilityOverrides;
  }
  config.llm = v2;
  return v2;
}

// ─── v2 服务商连接读写与管理 ───

export function readConnections(
  state: WorkingState,
): Readonly<Record<string, ModelConnectionConfig>> {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) return raw.connections;
  return {};
}

export function readConnection(
  state: WorkingState,
  connectionId: string,
): ModelConnectionConfig | undefined {
  return readConnections(state)[connectionId];
}

export function listConnectionIds(state: WorkingState): string[] {
  return Object.keys(readConnections(state));
}

export function readConnectionSecretValue(
  state: WorkingState,
  secretRef: string,
): string | undefined {
  if (
    state.credentials.revokedModelSecretRefs?.includes(secretRef) ||
    state.credentials.compromisedModelSecretTokens?.[secretRef]
  ) {
    return undefined;
  }
  return (
    state.credentials.modelSecrets?.[secretRef]?.value ??
    state.credentials.providers?.[secretRef]?.apiKey
  );
}

export function readConnectionSecretStatus(
  state: WorkingState,
  connectionId: string,
): ConnectionCredentialStatus {
  const conn = readConnection(state, connectionId);
  if (!conn) return "missing";
  return connectionCredentialStatus(conn, state.credentials);
}

export function nextCustomConnectionId(state: WorkingState, base = "custom"): string {
  const existing = new Set(listConnectionIds(state));
  if (!existing.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * 新增或更新 v2 服务商连接：
 * - 首次配置（尚无有效 main 绑定）且提供了 autoBindMainModel 且连接已就绪时，同次自动绑定 main；
 * - 常规新增（已有 main）绝不改写现有 main / light / power 用途默认。
 */
export function upsertConnection(
  state: WorkingState,
  connectionId: string,
  connection: ModelConnectionConfig,
  options?: { readonly autoBindMainModel?: string },
): WorkingState {
  const prev = readConnection(state, connectionId);
  const identityChanged =
    prev !== undefined &&
    (prev.endpoint !== connection.endpoint ||
      prev.adapter !== connection.adapter ||
      JSON.stringify(prev.auth) !== JSON.stringify(connection.auth));

  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  llm.connections[connectionId] = structuredClone(connection);

  const hasExistingMain = Boolean(llm.main?.connectionId && llm.main?.model);
  if (!hasExistingMain && options?.autoBindMainModel?.trim()) {
    const status = connectionCredentialStatus(connection, credentials);
    if (status === "none" || status === "ready") {
      llm.main = {
        connectionId,
        model: options.autoBindMainModel.trim(),
      };
    }
  }
  if (!identityChanged) {
    return { ...state, config, credentials };
  }
  return invalidateConnectionDraftProbes(
    { ...state, config, credentials, draftRevision: (state.draftRevision ?? 0) + 1 },
    connectionId,
  );
}

/** 写入或轮换 v2 逻辑凭据：自动解除同 secretRef 的撤销集合与封禁占位，并递增草稿修订使旧探测结果失效。 */
export function writeConnectionSecret(
  state: WorkingState,
  secretRef: string,
  kind: "api-key" | "header",
  value: string,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  ensureLlmV2Mutable(config, credentials);
  credentials.modelSecrets ??= {};
  credentials.modelSecrets[secretRef] = { v: 2, kind, value };
  if (credentials.revokedModelSecretRefs) {
    const filtered = credentials.revokedModelSecretRefs.filter((ref) => ref !== secretRef);
    if (filtered.length > 0) credentials.revokedModelSecretRefs = filtered;
    else delete credentials.revokedModelSecretRefs;
  }
  if (credentials.compromisedModelSecretTokens) {
    delete credentials.compromisedModelSecretTokens[secretRef];
    if (Object.keys(credentials.compromisedModelSecretTokens).length === 0) {
      delete credentials.compromisedModelSecretTokens;
    }
  }
  let nextState: WorkingState = {
    ...state,
    config,
    credentials,
    draftRevision: (state.draftRevision ?? 0) + 1,
  };
  for (const [connId, conn] of Object.entries(readConnections(nextState))) {
    if ((conn.auth.mode === "api-key" || conn.auth.mode === "header") && conn.auth.secretRef === secretRef) {
      nextState = invalidateConnectionDraftProbes(nextState, connId);
    }
  }
  return nextState;
}

/** 计算当前连接草稿的非秘密指纹（用于 401 二次确认与过时状态判定）。 */
export function computeConnectionDraftFingerprint(
  state: WorkingState,
  connectionId: string,
): string {
  const conn = readConnection(state, connectionId);
  if (!conn) return "missing";
  const secretValue =
    conn.auth.mode === "api-key" || conn.auth.mode === "header"
      ? readConnectionSecretValue(state, conn.auth.secretRef)
      : undefined;
  const credRev = computeCredentialRevisionToken({
    authMode: conn.auth.mode,
    headerName: conn.auth.mode === "header" ? conn.auth.headerName : undefined,
    secretValue,
  });
  return `${sanitizeEndpointForCache(conn.endpoint)}|${conn.adapter}|${credRev}`;
}

export function invalidateConnectionDraftProbes(
  state: WorkingState,
  connectionId: string,
): WorkingState {
  const nextDiscovery = state.draftDiscoveryByConnection
    ? { ...state.draftDiscoveryByConnection }
    : undefined;
  const nextVerify = state.draftVerificationByConnection
    ? { ...state.draftVerificationByConnection }
    : undefined;
  const nextConfirmed = state.draftAuthRejectedConfirmed
    ? { ...state.draftAuthRejectedConfirmed }
    : undefined;
  if (nextDiscovery) delete nextDiscovery[connectionId];
  if (nextVerify) delete nextVerify[connectionId];
  if (nextConfirmed) delete nextConfirmed[connectionId];
  return {
    ...state,
    ...(nextDiscovery ? { draftDiscoveryByConnection: nextDiscovery } : {}),
    ...(nextVerify ? { draftVerificationByConnection: nextVerify } : {}),
    ...(nextConfirmed ? { draftAuthRejectedConfirmed: nextConfirmed } : {}),
  };
}

/** 记录草稿发现结果：自动丢弃 `aborted` 或 `draftRevision` 已过时的旧结果。 */
export function recordDraftDiscoveryResult(
  state: WorkingState,
  connectionId: string,
  result: DiscoverConnectionModelsResult,
): WorkingState {
  if (result.status === "aborted") return state;
  if (
    result.draftRevision !== undefined &&
    result.draftRevision !== (state.draftRevision ?? 0)
  ) {
    return state;
  }
  return {
    ...state,
    draftDiscoveryByConnection: {
      ...(state.draftDiscoveryByConnection ?? {}),
      [connectionId]: result,
    },
  };
}

/** 记录草稿可选生成验证结果：自动丢弃 `aborted` 或 `draftRevision` 已过时的旧结果。 */
export function recordDraftVerificationResult(
  state: WorkingState,
  connectionId: string,
  result: VerifyModelGenerationResult,
): WorkingState {
  if (result.status === "aborted") return state;
  if (
    result.draftRevision !== undefined &&
    result.draftRevision !== (state.draftRevision ?? 0)
  ) {
    return state;
  }
  return {
    ...state,
    draftVerificationByConnection: {
      ...(state.draftVerificationByConnection ?? {}),
      [connectionId]: {
        ...(state.draftVerificationByConnection?.[connectionId] ?? {}),
        [result.modelId]: result,
      },
    },
  };
}

/** 为 401 鉴权失败的当前草稿记录显式二次确认（“先存待修”，不冒充已验证）。 */
export function confirmAuthRejectedSave(
  state: WorkingState,
  connectionId: string,
): WorkingState {
  const fingerprint = computeConnectionDraftFingerprint(state, connectionId);
  return {
    ...state,
    draftAuthRejectedConfirmed: {
      ...(state.draftAuthRejectedConfirmed ?? {}),
      [connectionId]: fingerprint,
    },
  };
}

export interface ConnectionDeleteImpact {
  readonly connectionId: string;
  readonly referencedRoles: readonly ModelRole[];
  readonly affectsMain: boolean;
  readonly secretRef?: string;
  readonly secretSharedWith: readonly string[];
  readonly candidateRebindConnections: readonly string[];
}

export function inspectConnectionDeleteImpact(
  state: WorkingState,
  connectionId: string,
): ConnectionDeleteImpact {
  const connections = readConnections(state);
  const conn = connections[connectionId];
  const referencedRoles: ModelRole[] = [];
  for (const role of ["main", "light", "power"] as const) {
    if (readModelRole(state, role)?.provider === connectionId) {
      referencedRoles.push(role);
    }
  }
  const secretRef =
    conn && (conn.auth.mode === "api-key" || conn.auth.mode === "header")
      ? conn.auth.secretRef
      : undefined;
  const secretSharedWith = secretRef
    ? Object.entries(connections)
        .filter(
          ([otherId, other]) =>
            otherId !== connectionId &&
            (other.auth.mode === "api-key" || other.auth.mode === "header") &&
            other.auth.secretRef === secretRef,
        )
        .map(([otherId]) => otherId)
    : [];
  const candidateRebindConnections = Object.keys(connections).filter(
    (otherId) => otherId !== connectionId,
  );
  return {
    connectionId,
    referencedRoles,
    affectsMain: referencedRoles.includes("main"),
    ...(secretRef ? { secretRef } : {}),
    secretSharedWith,
    candidateRebindConnections,
  };
}

/**
 * 删除连接（同步处理用途重绑/回退、待清退登记与撤权中止）：
 * - 若影响 main 且未提供合法 rebindMain，抛出明确错误；
 * - light / power 若引用被删连接，自动清空以回退 main；
 * - 有凭据引用时登记 PendingModelSecretRetirement（mode: "retire" 等待在途结束后清退，
 *   或 mode: "revoke" 立即解绑 + 登记 revokedModelSecretRefs + abortConnectionIds）。
 */
export function deleteConnection(
  state: WorkingState,
  input: {
    readonly connectionId: string;
    readonly rebindMain?: { readonly connectionId: string; readonly model: string };
    readonly mode: "retire" | "revoke";
  },
): WorkingState {
  const impact = inspectConnectionDeleteImpact(state, input.connectionId);
  if (impact.affectsMain) {
    if (
      !input.rebindMain ||
      !input.rebindMain.connectionId ||
      input.rebindMain.connectionId === input.connectionId ||
      !input.rebindMain.model.trim()
    ) {
      throw new Error("主模型正引用此连接，删除前必须同时改绑到其他连接与模型");
    }
  }

  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  const removed = llm.connections[input.connectionId];
  if (!removed) return state;

  delete llm.connections[input.connectionId];
  if (impact.affectsMain && input.rebindMain) {
    llm.main = {
      connectionId: input.rebindMain.connectionId,
      model: input.rebindMain.model.trim(),
    };
  }
  if (llm.light?.connectionId === input.connectionId) {
    delete llm.light;
  }
  if (llm.power?.connectionId === input.connectionId) {
    delete llm.power;
  }

  const modelRetirements = [...(state.modelRetirements ?? [])];
  const abortConnectionIds = [...(state.abortConnectionIds ?? [])];

  if (removed.auth.mode === "api-key" || removed.auth.mode === "header") {
    const secretRef = removed.auth.secretRef;
    modelRetirements.push({
      operationId: randomUUID(),
      connectionId: input.connectionId,
      secretRef,
      mode: input.mode,
      sourceRevision: "editor",
      createdAt: new Date().toISOString(),
    });
    if (input.mode === "revoke") {
      if (credentials.modelSecrets) {
        delete credentials.modelSecrets[secretRef];
        if (Object.keys(credentials.modelSecrets).length === 0) {
          delete credentials.modelSecrets;
        }
      }
      const revoked = new Set(credentials.revokedModelSecretRefs ?? []);
      revoked.add(secretRef);
      credentials.revokedModelSecretRefs = [...revoked].sort();
      if (!abortConnectionIds.includes(input.connectionId)) {
        abortConnectionIds.push(input.connectionId);
      }
    }
  } else if (input.mode === "revoke") {
    if (!abortConnectionIds.includes(input.connectionId)) {
      abortConnectionIds.push(input.connectionId);
    }
  }

  return {
    ...state,
    config,
    credentials,
    ...(modelRetirements.length > 0 ? { modelRetirements } : {}),
    ...(abortConnectionIds.length > 0 ? { abortConnectionIds } : {}),
  };
}

/** 对受保护或被阻断的旧自定义端点做严格脱敏（仅展示 scheme://host，隐去路径、userinfo 与查询参数）。 */
export function redactProtectedLegacyEndpoint(rawUrl: string | undefined): string {
  if (!rawUrl || !rawUrl.trim()) return "待填有效端点";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "受保护自定义端点（已隐去详情）";
    }
    const hasAuthOrExtra =
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "";
    return hasAuthOrExtra
      ? `${parsed.protocol}//${parsed.host}（已隐去受保护路径与参数）`
      : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "受保护自定义端点（已隐去详情）";
  }
}

/** 列出仍滞留在 v1 配置中、因 URL 含内嵌凭据/敏感查询参数而被自动迁移阻断的旧服务商 ID。 */
export function listBlockedLegacyProviders(state: WorkingState): readonly string[] {
  if (isLLMConfigV2(state.config.llm as unknown)) return [];
  const blocked: string[] = [];
  for (const [providerId, entry] of Object.entries(state.credentials.providers ?? {})) {
    if (entry.baseUrl !== undefined && hasExplicitUrlCredentialsOrQueryAuth(entry.baseUrl)) {
      blocked.push(providerId);
    }
  }
  return blocked.sort();
}

export function readRepairableLegacyProvider(
  state: WorkingState,
  providerId: string,
): { readonly entry: ProviderCredentialEntry; readonly blockedV1: boolean } | undefined {
  const protectedEntry = state.credentials.protectedLegacyProviders?.[providerId];
  if (protectedEntry) {
    return {
      entry: protectedEntry,
      blockedV1: Boolean(
        protectedEntry.baseUrl !== undefined &&
          hasExplicitUrlCredentialsOrQueryAuth(protectedEntry.baseUrl),
      ),
    };
  }
  if (!isLLMConfigV2(state.config.llm as unknown)) {
    const v1Entry = state.credentials.providers?.[providerId];
    if (v1Entry?.baseUrl !== undefined && hasExplicitUrlCredentialsOrQueryAuth(v1Entry.baseUrl)) {
      return { entry: v1Entry, blockedV1: true };
    }
  }
  return undefined;
}

export function setConfirmedRepairEndpoint(
  state: WorkingState,
  providerId: string,
  endpoint: string,
): WorkingState {
  const cleaned = endpoint.trim().replace(/\/+$/u, "");
  return {
    ...state,
    confirmedRepairEndpoints: {
      ...(state.confirmedRepairEndpoints ?? {}),
      [providerId]: cleaned,
    },
  };
}

/** 迁移修复：确认并把受保护旧服务商自定义端点（含被阻断 v1 URL）转为正式 v2 连接，恢复用途默认与模型覆盖，清除旧保护区。 */
export function confirmProtectedLegacyProvider(
  state: WorkingState,
  providerId: string,
  options?: {
    readonly endpoint?: string;
    readonly adapter?: ModelAdapterId;
    readonly allowPrivateOrigin?: boolean;
    readonly autoBindMainModel?: string;
  },
): WorkingState {
  const found = readRepairableLegacyProvider(state, providerId);
  if (!found) return state;
  const legacy = found.entry;
  const preset = getPreset(providerId);
  const candidateEndpoint = (
    options?.endpoint ??
    state.confirmedRepairEndpoints?.[providerId] ??
    (found.blockedV1 ? "" : (legacy.baseUrl ?? preset?.baseUrl ?? ""))
  )
    .trim()
    .replace(/\/+$/u, "");
  const adapter = options?.adapter ?? legacy.protocol ?? preset?.protocol ?? "openai-compatible";
  if (!candidateEndpoint) {
    throw new Error(`旧服务商 "${providerId}" 缺少有效纯净端点地址，请先输入不含认证信息的端点 URL`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateEndpoint);
  } catch {
    throw new Error("端点 URL 格式无效");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("端点仅允许 http:// 或 https:// 协议");
  }
  if (hasExplicitUrlCredentialsOrQueryAuth(candidateEndpoint)) {
    throw new Error("端点 URL 含内嵌凭据或敏感查询参数，请替换为纯净端点 URL");
  }
  const isPrivate = isLocalOrPrivateHostname(parsedUrl.hostname);
  const allowPrivate = options?.allowPrivateOrigin ?? isPrivate;
  const hadLegacyRootOverrides = state.config.modelCapabilityOverrides !== undefined;
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);

  const matchingPending = (llm.migrationPending ?? []).find(
    (item) => item.kind === "protected-legacy-roles" && item.sourceProviderId === providerId,
  );
  const pendingFields = matchingPending?.legacyFields as
    | {
        modelOverrides?: ProviderCredentialEntry["modelOverrides"];
        modelInputCapabilities?: ProviderCredentialEntry["modelInputCapabilities"];
        models?: string[];
        quirks?: ProviderCredentialEntry["quirks"];
      }
    | undefined;

  const hasKey = Boolean(legacy.apiKey && legacy.apiKey.trim().length > 0);
  if (hasKey) {
    credentials.modelSecrets ??= {};
    credentials.modelSecrets[providerId] = { v: 2, kind: "api-key", value: legacy.apiKey };
  }
  const mergedOverrides = mergeLegacyModelOverrides(
    legacy.modelOverrides ?? pendingFields?.modelOverrides,
    legacy.modelInputCapabilities ?? pendingFields?.modelInputCapabilities,
  );
  const quirks = legacy.quirks ?? pendingFields?.quirks;
  const customModels =
    legacy.models && legacy.models.length > 0
      ? [...legacy.models]
      : pendingFields?.models && pendingFields.models.length > 0
        ? [...pendingFields.models]
        : undefined;

  llm.connections[providerId] = {
    name: preset?.name ?? providerId,
    ...(preset ? { presetId: providerId } : {}),
    adapter,
    endpoint: candidateEndpoint,
    auth: hasKey ? { mode: "api-key", secretRef: providerId } : { mode: "none" },
    network: {
      proxy: isPrivate ? "direct" : "inherit",
      ...(allowPrivate ? { allowPrivateOrigin: true } : {}),
    },
    ...(quirks?.thinkingDialect || quirks?.usageDialect
      ? {
          dialect: {
            ...(quirks.thinkingDialect ? { thinking: quirks.thinkingDialect } : {}),
            ...(quirks.usageDialect ? { usage: quirks.usageDialect } : {}),
          },
        }
      : {}),
    ...(customModels ? { customModels } : {}),
    ...(Object.keys(mergedOverrides).length > 0 ? { modelOverrides: mergedOverrides } : {}),
  };

  if (matchingPending?.legacyRoles) {
    for (const role of ["main", "light", "power"] as const) {
      const preserved = matchingPending.legacyRoles[role];
      if (!llm[role] && preserved?.model) {
        llm[role] = {
          connectionId: providerId,
          model: preserved.model,
          ...(preserved.thinking ? { params: { thinking: preserved.thinking } } : {}),
        };
      }
    }
  }
  if (llm.migrationPending) {
    const remainingPending = llm.migrationPending.filter(
      (item) => !(item.kind === "protected-legacy-roles" && item.sourceProviderId === providerId),
    );
    if (remainingPending.length > 0) llm.migrationPending = remainingPending;
    else delete llm.migrationPending;
  }

  if (credentials.protectedLegacyProviders) {
    delete credentials.protectedLegacyProviders[providerId];
    if (Object.keys(credentials.protectedLegacyProviders).length === 0) {
      delete credentials.protectedLegacyProviders;
    }
  }
  const hasExistingMain = Boolean(llm.main?.connectionId && llm.main?.model);
  if (!hasExistingMain && options?.autoBindMainModel?.trim()) {
    llm.main = { connectionId: providerId, model: options.autoBindMainModel.trim() };
  }

  let confirmedRepairEndpoints = state.confirmedRepairEndpoints;
  if (confirmedRepairEndpoints && providerId in confirmedRepairEndpoints) {
    const nextDrafts = { ...confirmedRepairEndpoints };
    delete nextDrafts[providerId];
    confirmedRepairEndpoints = Object.keys(nextDrafts).length > 0 ? nextDrafts : undefined;
  }

  return {
    ...state,
    config,
    credentials,
    ...(confirmedRepairEndpoints ? { confirmedRepairEndpoints } : { confirmedRepairEndpoints: undefined }),
    ...(hadLegacyRootOverrides ? { removeLegacyModelCapabilityOverrides: true } : {}),
  };
}

export function discardProtectedLegacyProvider(
  state: WorkingState,
  providerId: string,
): WorkingState {
  const found = readRepairableLegacyProvider(state, providerId);
  if (!found) return state;
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  if (credentials.protectedLegacyProviders?.[providerId]) {
    delete credentials.protectedLegacyProviders[providerId];
    if (Object.keys(credentials.protectedLegacyProviders).length === 0) {
      delete credentials.protectedLegacyProviders;
    }
  }
  if (!isLLMConfigV2(config.llm as unknown) && credentials.providers?.[providerId]) {
    delete credentials.providers[providerId];
    if (Object.keys(credentials.providers).length === 0) {
      delete credentials.providers;
    }
    if (config.llm) {
      if (config.llm.main?.provider === providerId) delete config.llm.main;
      if (config.llm.light?.provider === providerId) delete config.llm.light;
      if (config.llm.power?.provider === providerId) delete config.llm.power;
    }
  }
  const raw = config.llm as unknown;
  if (isLLMConfigV2(raw) && raw.migrationPending) {
    const nextPending = raw.migrationPending.filter(
      (item) => !(item.kind === "protected-legacy-roles" && item.sourceProviderId === providerId),
    );
    if (nextPending.length > 0) raw.migrationPending = nextPending;
    else delete raw.migrationPending;
  }
  let confirmedRepairEndpoints = state.confirmedRepairEndpoints;
  if (confirmedRepairEndpoints && providerId in confirmedRepairEndpoints) {
    const nextDrafts = { ...confirmedRepairEndpoints };
    delete nextDrafts[providerId];
    confirmedRepairEndpoints = Object.keys(nextDrafts).length > 0 ? nextDrafts : undefined;
  }
  return {
    ...state,
    config,
    credentials,
    ...(confirmedRepairEndpoints ? { confirmedRepairEndpoints } : { confirmedRepairEndpoints: undefined }),
  };
}

export function dismissMigrationPendingItem(
  state: WorkingState,
  itemId: string,
): WorkingState {
  const raw = state.config.llm as unknown;
  if (!isLLMConfigV2(raw) || !raw.migrationPending?.length) return state;
  const config = structuredClone(state.config);
  const llm = config.llm as LLMConfigV2;
  const next = (llm.migrationPending ?? []).filter((item) => item.id !== itemId);
  if (next.length > 0) llm.migrationPending = next;
  else delete llm.migrationPending;
  return { ...state, config };
}

export function countMigrationRepairItems(state: WorkingState): number {
  const protectedIds = new Set(Object.keys(state.credentials.protectedLegacyProviders ?? {}));
  const blockedIds = listBlockedLegacyProviders(state).filter((id) => !protectedIds.has(id));
  const raw = state.config.llm as unknown;
  const standalonePending = isLLMConfigV2(raw)
    ? (raw.migrationPending ?? []).filter(
        (item) => !(item.kind === "protected-legacy-roles" && protectedIds.has(item.sourceProviderId)),
      )
    : [];
  return protectedIds.size + blockedIds.length + standalonePending.length;
}

// ─── 模型角色字段读写（兼容 v2 与旧单测入口） ───

/** 读 llm 角色配置（main / light / power）：v2 返回 { provider: connectionId, model } 统一视图 */
export function readModelRole(
  state: WorkingState,
  role: ModelRole,
): { provider: string; model: string } | undefined {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    const sel = raw[role];
    if (!sel) return undefined;
    return { provider: sel.connectionId, model: sel.model };
  }
  return state.config.llm?.[role];
}

/** 撤回可选角色（轻量 / 强力）的单独配置，回到沿用主模型；主模型是必填键，不能撤回 */
export function clearModelRole(state: WorkingState, role: ModelRole): WorkingState {
  if (role === "main") return state;
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    if (!raw[role]) return state;
    const config = structuredClone(state.config);
    delete (config.llm as LLMConfigV2)[role];
    return { ...state, config };
  }
  if (!state.config.llm?.[role]) return state;
  const config = structuredClone(state.config);
  const llm = { ...config.llm! };
  delete llm[role];
  config.llm = llm;
  return { ...state, config };
}

/**
 * 设置 llm 角色连接 + 模型（始终写入 v2 结构，并在选择已知预设时自动补建对应连接）。
 */
export function writeModelRole(
  state: WorkingState,
  role: ModelRole,
  providerOrConnectionId: string,
  model: string,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  if (providerOrConnectionId && !llm.connections[providerOrConnectionId]) {
    const presetConn = buildPresetConnection(providerOrConnectionId);
    if (presetConn) {
      llm.connections[providerOrConnectionId] = presetConn;
    }
  }
  const existing = llm[role];
  llm[role] =
    existing?.connectionId === providerOrConnectionId && existing.model === model
      ? existing
      : { connectionId: providerOrConnectionId, model };
  return { ...state, config, credentials };
}

/** 读 llm 角色的思考控制配置（缺省 undefined = 不发思考参数） */
export function readModelThinking(
  state: WorkingState,
  role: ModelRole,
): ThinkingConfig | undefined {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    return raw[role]?.params?.thinking;
  }
  return state.config.llm?.[role]?.thinking;
}

/** 设置 llm 角色的思考控制配置——保留已选连接 + model 不动。 */
export function writeModelThinking(
  state: WorkingState,
  role: ModelRole,
  thinking: ThinkingConfig,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  const existing = llm[role] ?? { connectionId: "", model: "" };
  llm[role] = {
    ...existing,
    params: { ...(existing.params ?? {}), thinking },
  };
  return { ...state, config, credentials };
}

/** 清除 llm 角色的显式思考控制覆盖（恢复型号默认），保留连接与 model 不动。 */
export function clearModelThinking(state: WorkingState, role: ModelRole): WorkingState {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    const existing = raw[role];
    if (!existing?.params?.thinking) return state;
    const config = structuredClone(state.config);
    const llm = config.llm as LLMConfigV2 & Record<ModelRole, RoleSelection | undefined>;
    const current = llm[role]!;
    const nextParams = { ...current.params };
    delete (nextParams as { thinking?: ThinkingConfig }).thinking;
    llm[role] = {
      connectionId: current.connectionId,
      model: current.model,
      ...(current.maxOutputPreference !== undefined
        ? { maxOutputPreference: current.maxOutputPreference }
        : {}),
      ...(Object.keys(nextParams).length > 0 ? { params: nextParams } : {}),
    };
    return { ...state, config };
  }
  if (!state.config.llm?.[role]?.thinking) return state;
  const config = structuredClone(state.config);
  const roleCfg = { ...config.llm![role]! };
  delete roleCfg.thinking;
  config.llm = { ...config.llm!, [role]: roleCfg };
  return { ...state, config };
}

/** 读取用途默认的请求级输出上限偏好（注册语义 `output.maxTokensPreference`）。 */
export function readModelMaxOutputPreference(
  state: WorkingState,
  role: ModelRole,
): number | undefined {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    return raw[role]?.maxOutputPreference;
  }
  return undefined;
}

/** 设置用途默认的请求级输出上限偏好，完整保留既有连接、型号与思考参数。 */
export function writeModelMaxOutputPreference(
  state: WorkingState,
  role: ModelRole,
  maxOutputPreference: number,
  fallbackTarget?: { readonly connectionId: string; readonly model: string },
): WorkingState {
  if (!Number.isSafeInteger(maxOutputPreference) || maxOutputPreference <= 0) {
    return state;
  }
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  const existing = llm[role];
  const connectionId = existing?.connectionId || fallbackTarget?.connectionId || "";
  const model = existing?.model || fallbackTarget?.model || "";
  if (!connectionId || !model) return state;
  if (!llm.connections[connectionId]) {
    const presetConn = buildPresetConnection(connectionId);
    if (presetConn) llm.connections[connectionId] = presetConn;
  }
  llm[role] = {
    ...(existing ?? { connectionId, model }),
    connectionId,
    model,
    maxOutputPreference,
  };
  return { ...state, config, credentials };
}

/** 清除用途默认的请求级输出上限偏好（恢复模型默认），完整保留既有连接、型号与思考参数。 */
export function clearModelMaxOutputPreference(
  state: WorkingState,
  role: ModelRole,
): WorkingState {
  const raw = state.config.llm as unknown;
  if (!isLLMConfigV2(raw)) return state;
  const existing = raw[role];
  if (!existing || existing.maxOutputPreference === undefined) return state;
  const config = structuredClone(state.config);
  const llm = config.llm as LLMConfigV2 & Record<ModelRole, RoleSelection | undefined>;
  const current = llm[role]!;
  llm[role] = {
    connectionId: current.connectionId,
    model: current.model,
    ...(current.params ? { params: current.params } : {}),
  };
  return { ...state, config };
}

// ─── 预设更新建议 / 自定义型号 CRUD / 规格覆盖与恢复预览 / 隐藏与取消隐藏（设计 §3.2、§3.4） ───

export function listPresetUpdateSuggestions(
  state: WorkingState,
  catalog: ModelCatalogPort = DEFAULT_MODEL_CATALOG_PORT,
): readonly PresetUpdateSuggestion[] {
  const suggestions: PresetUpdateSuggestion[] = [];
  for (const [connectionId, conn] of Object.entries(readConnections(state))) {
    const suggestion = catalog.getPresetUpdateSuggestion(connectionId, conn);
    if (suggestion) suggestions.push(suggestion);
  }
  return suggestions;
}

/** 采纳预设更新建议：显式更新端点/协议/预设修订、清除忽略标记并递增草稿修订以待重新发现。 */
export function adoptPresetUpdateSuggestion(
  state: WorkingState,
  connectionId: string,
  suggestion: PresetUpdateSuggestion,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn) return state;
  const updated: ModelConnectionConfig = {
    ...conn,
    endpoint: suggestion.suggestedEndpoint.replace(/\/+$/u, ""),
    adapter: suggestion.suggestedAdapter,
    presetRevision: suggestion.nextPresetRevision,
  };
  delete (updated as { ignoredPresetRevision?: string }).ignoredPresetRevision;
  const next = upsertConnection(state, connectionId, updated);
  return invalidateConnectionDraftProbes(
    { ...next, draftRevision: (next.draftRevision ?? 0) + 1 },
    connectionId,
  );
}

/** 忽略指定预设修订建议：不改既有端点与协议，只记入 ignoredPresetRevision。 */
export function ignorePresetUpdateSuggestion(
  state: WorkingState,
  connectionId: string,
  nextPresetRevision: string,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn) return state;
  return upsertConnection(state, connectionId, {
    ...conn,
    ignoredPresetRevision: nextPresetRevision,
  });
}

/** 重命名自定义型号：更新 customModels、迁移对应 modelOverrides，并同步改绑指向旧 ID 的用途默认。 */
export function renameCustomModel(
  state: WorkingState,
  connectionId: string,
  oldModelId: string,
  newModelId: string,
): WorkingState {
  const trimmed = newModelId.trim();
  if (!trimmed || trimmed === oldModelId) return state;
  const conn = readConnection(state, connectionId);
  if (!conn?.customModels?.includes(oldModelId)) return state;
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  const target = llm.connections[connectionId]!;

  const nextCustom: string[] = [];
  for (const id of target.customModels ?? []) {
    const mapped = id === oldModelId ? trimmed : id;
    if (!nextCustom.includes(mapped)) nextCustom.push(mapped);
  }

  let nextOverrides = target.modelOverrides ? { ...target.modelOverrides } : undefined;
  if (nextOverrides && oldModelId in nextOverrides) {
    if (!(trimmed in nextOverrides)) {
      nextOverrides[trimmed] = nextOverrides[oldModelId]!;
    }
    delete nextOverrides[oldModelId];
    if (Object.keys(nextOverrides).length === 0) nextOverrides = undefined;
  }

  const nextConn: ModelConnectionConfig = {
    ...target,
    customModels: nextCustom,
    ...(nextOverrides ? { modelOverrides: nextOverrides } : {}),
  };
  if (!nextOverrides) {
    delete (nextConn as { modelOverrides?: unknown }).modelOverrides;
  }
  llm.connections[connectionId] = nextConn;

  for (const role of ["main", "light", "power"] as const) {
    const sel = llm[role];
    if (sel && sel.connectionId === connectionId && sel.model === oldModelId) {
      llm[role] = { ...sel, model: trimmed };
    }
  }
  return { ...state, config, credentials };
}

/** 删除自定义型号（仅移出 customModels，不影响供应方目录条目与其他覆盖）。 */
export function removeCustomModel(
  state: WorkingState,
  connectionId: string,
  modelId: string,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn?.customModels?.includes(modelId)) return state;
  const nextCustom = conn.customModels.filter((m) => m !== modelId);
  const updated: ModelConnectionConfig = { ...conn };
  if (nextCustom.length > 0) {
    (updated as { customModels?: readonly string[] }).customModels = nextCustom;
  } else {
    delete (updated as { customModels?: readonly string[] }).customModels;
  }
  return upsertConnection(state, connectionId, updated);
}

/** 新增或更新单型号的规格覆盖（显式 undefined 删除对应字段；全清空则自动移除该型号覆盖键）。 */
export function upsertModelOverride(
  state: WorkingState,
  connectionId: string,
  modelId: string,
  patch: Partial<{
    contextWindow: number | undefined;
    maxOutputTokens: number | undefined;
    supportsImages: boolean | undefined;
    supportsTools: boolean | undefined;
    supportsThinking: boolean | undefined;
    thinkingControl: ThinkingControl | undefined;
  }>,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn || !modelId.trim()) return state;
  const current = conn.modelOverrides?.[modelId] ?? {};
  const merged: Record<string, unknown> = { ...current };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete merged[key];
    else merged[key] = val;
  }
  const nextOverrides: Record<string, ModelSpecOverride> = { ...(conn.modelOverrides ?? {}) };
  if (Object.keys(merged).length > 0) {
    nextOverrides[modelId] = merged as ModelSpecOverride;
  } else {
    delete nextOverrides[modelId];
  }
  const updated: ModelConnectionConfig = { ...conn };
  if (Object.keys(nextOverrides).length > 0) {
    (updated as { modelOverrides?: Readonly<Record<string, ModelSpecOverride>> }).modelOverrides =
      nextOverrides;
  } else {
    delete (updated as { modelOverrides?: unknown }).modelOverrides;
  }
  return upsertConnection(state, connectionId, updated);
}

/** 删除单型号的全部规格覆盖，恢复为上游（原生发现 / 策展目录 / 随包基线 / 未知）值。 */
export function removeModelOverride(
  state: WorkingState,
  connectionId: string,
  modelId: string,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn?.modelOverrides || !(modelId in conn.modelOverrides)) return state;
  const nextOverrides = { ...conn.modelOverrides };
  delete nextOverrides[modelId];
  const updated: ModelConnectionConfig = { ...conn };
  if (Object.keys(nextOverrides).length > 0) {
    (updated as { modelOverrides?: Readonly<Record<string, ModelSpecOverride>> }).modelOverrides =
      nextOverrides;
  } else {
    delete (updated as { modelOverrides?: unknown }).modelOverrides;
  }
  return upsertConnection(state, connectionId, updated);
}

export interface ModelOverrideRestoreField {
  readonly field: string;
  readonly labelZh: string;
  readonly currentValue: string;
  readonly restoredValue: string;
  readonly restoredSource: string;
}

/** 预览删除某型号规格覆盖后每个字段将恢复的上游具体值与来源（设计 §3.2）。 */
export function previewModelOverrideRestore(
  state: WorkingState,
  connectionId: string,
  modelId: string,
  catalog: ModelCatalogPort = DEFAULT_MODEL_CATALOG_PORT,
): readonly ModelOverrideRestoreField[] {
  const conn = readConnection(state, connectionId);
  const existing = conn?.modelOverrides?.[modelId];
  if (!conn || !existing) return [];

  const withoutOverrideConn: ModelConnectionConfig = { ...conn };
  const strippedOverrides = { ...(conn.modelOverrides ?? {}) };
  delete strippedOverrides[modelId];
  if (Object.keys(strippedOverrides).length > 0) {
    (withoutOverrideConn as { modelOverrides?: Readonly<Record<string, ModelSpecOverride>> }).modelOverrides =
      strippedOverrides;
  } else {
    delete (withoutOverrideConn as { modelOverrides?: unknown }).modelOverrides;
  }

  const draftDiscovery = state.draftDiscoveryByConnection?.[connectionId];
  const synthesized = synthesizeConnectionModels({
    connectionId,
    connection: withoutOverrideConn,
    catalog: catalog.bundle,
    discoveredModels: draftDiscovery?.status === "discovered" ? draftDiscovery.models : undefined,
    discoveredAuthoritative: draftDiscovery?.authoritativeNativeFacts,
    adapterImplemented: catalog.isAdapterImplemented(conn.adapter),
    includeHidden: true,
    includeOverrideOnlyIds: false,
  });
  const upstream = synthesized.models.find((m) => m.id === modelId);

  const fmtNum = (v: number | undefined) => (v !== undefined ? `${v} tokens` : "未知");
  const fmtBool = (v: boolean | undefined) =>
    v === true ? "支持 (true)" : v === false ? "不支持 (false)" : "未知";
  const fmtSource = (
    field: { readonly source: "user-override" | "native-discovery" | "curated-catalog" | "builtin-baseline" | "unknown"; readonly thirdPartyUnverified?: boolean } | undefined,
  ) => (field ? describeProvenanceSource(field.source, field.thirdPartyUnverified) : "未知（目录与发现均未收录）");

  const rows: ModelOverrideRestoreField[] = [];
  if (existing.contextWindow !== undefined) {
    rows.push({
      field: "contextWindow",
      labelZh: "上下文窗口",
      currentValue: fmtNum(existing.contextWindow),
      restoredValue: fmtNum(upstream?.fields.contextWindow.value),
      restoredSource: fmtSource(upstream?.fields.contextWindow),
    });
  }
  if (existing.maxOutputTokens !== undefined) {
    rows.push({
      field: "maxOutputTokens",
      labelZh: "最大输出",
      currentValue: fmtNum(existing.maxOutputTokens),
      restoredValue: fmtNum(upstream?.fields.maxOutputTokens.value),
      restoredSource: fmtSource(upstream?.fields.maxOutputTokens),
    });
  }
  if (existing.supportsImages !== undefined) {
    rows.push({
      field: "supportsImages",
      labelZh: "图片输入",
      currentValue: fmtBool(existing.supportsImages),
      restoredValue: fmtBool(upstream?.fields.supportsImages.value),
      restoredSource: fmtSource(upstream?.fields.supportsImages),
    });
  }
  if (existing.supportsTools !== undefined) {
    rows.push({
      field: "supportsTools",
      labelZh: "工具调用",
      currentValue: fmtBool(existing.supportsTools),
      restoredValue: fmtBool(upstream?.fields.supportsTools.value),
      restoredSource: fmtSource(upstream?.fields.supportsTools),
    });
  }
  if (existing.supportsThinking !== undefined) {
    rows.push({
      field: "supportsThinking",
      labelZh: "思考能力",
      currentValue: fmtBool(existing.supportsThinking),
      restoredValue: fmtBool(upstream?.fields.supportsThinking.value),
      restoredSource: fmtSource(upstream?.fields.supportsThinking),
    });
  }
  if (existing.thinkingControl !== undefined) {
    rows.push({
      field: "thinkingControl",
      labelZh: "思考控件",
      currentValue: existing.thinkingControl.type,
      restoredValue: upstream?.fields.thinkingControl.value?.type ?? "无/未知",
      restoredSource: fmtSource(upstream?.fields.thinkingControl),
    });
  }
  return rows;
}

/** 隐藏连接下的供应方型号（写入 hiddenModels，目录刷新不会复活）。 */
export function hideConnectionModel(
  state: WorkingState,
  connectionId: string,
  modelId: string,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn || !modelId.trim()) return state;
  const current = conn.hiddenModels ?? [];
  if (current.includes(modelId)) return state;
  return upsertConnection(state, connectionId, {
    ...conn,
    hiddenModels: [...current, modelId],
  });
}

/** 恢复显示连接下被隐藏的供应方型号。 */
export function unhideConnectionModel(
  state: WorkingState,
  connectionId: string,
  modelId: string,
): WorkingState {
  const conn = readConnection(state, connectionId);
  if (!conn?.hiddenModels?.includes(modelId)) return state;
  const nextHidden = conn.hiddenModels.filter((m) => m !== modelId);
  const updated: ModelConnectionConfig = { ...conn };
  if (nextHidden.length > 0) {
    (updated as { hiddenModels?: readonly string[] }).hiddenModels = nextHidden;
  } else {
    delete (updated as { hiddenModels?: readonly string[] }).hiddenModels;
  }
  return upsertConnection(state, connectionId, updated);
}

// ─── Provider / Connection 凭证兼容读写 ───

/** 读连接或旧 provider 的凭证视图（优先 v2 modelSecrets + connection.customModels） */
export function readProviderEntry(
  state: WorkingState,
  providerId: string,
): ProviderCredentialEntry | undefined {
  const raw = state.config.llm as unknown;
  if (isLLMConfigV2(raw)) {
    const conn = raw.connections[providerId];
    const secretRef =
      conn && (conn.auth.mode === "api-key" || conn.auth.mode === "header")
        ? conn.auth.secretRef
        : providerId;
    const apiKey = readConnectionSecretValue(state, secretRef) ?? "";
    const models = conn?.customModels ? [...conn.customModels] : undefined;
    if (!conn && !apiKey) return undefined;
    return {
      apiKey,
      ...(models ? { models } : {}),
    };
  }
  return state.credentials.providers?.[providerId];
}

/** 写连接或旧 provider 的凭据字段（v2 下写入 modelSecrets 并解除撤销/封禁） */
export function patchProviderEntry(
  state: WorkingState,
  providerId: string,
  patch: Partial<ProviderCredentialEntry>,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  if (!llm.connections[providerId]) {
    const presetConn = buildPresetConnection(providerId);
    if (presetConn) {
      llm.connections[providerId] = presetConn;
    }
  }
  const conn = llm.connections[providerId];
  let next: WorkingState = { ...state, config, credentials };
  if (patch.apiKey !== undefined) {
    const kind = conn?.auth.mode === "header" ? "header" : "api-key";
    const secretRef =
      conn && (conn.auth.mode === "api-key" || conn.auth.mode === "header")
        ? conn.auth.secretRef
        : providerId;
    next = writeConnectionSecret(next, secretRef, kind, patch.apiKey);
  }
  if (patch.models && conn) {
    const cfg = structuredClone(next.config);
    (cfg.llm as LLMConfigV2).connections[providerId] = {
      ...(cfg.llm as LLMConfigV2).connections[providerId]!,
      customModels: [...patch.models],
    };
    next = { ...next, config: cfg };
  }
  return next;
}

/** 给连接追加自定义模型（去重，v2 写入 connection.customModels） */
export function addProviderModel(
  state: WorkingState,
  providerId: string,
  modelId: string,
): WorkingState {
  const config = structuredClone(state.config);
  const credentials = structuredClone(state.credentials);
  const llm = ensureLlmV2Mutable(config, credentials);
  if (!llm.connections[providerId]) {
    llm.connections[providerId] =
      buildPresetConnection(providerId) ?? {
        name: providerId,
        adapter: "openai-compatible",
        endpoint: "https://api.openai.com/v1",
        auth: { mode: "api-key", secretRef: providerId },
        network: { proxy: "inherit" },
      };
  }
  const conn = llm.connections[providerId]!;
  const models = conn.customModels ?? [];
  if (models.includes(modelId)) return { ...state, config, credentials };
  llm.connections[providerId] = {
    ...conn,
    customModels: [...models, modelId],
  };
  return { ...state, config, credentials };
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
    config.messaging[channelId] = state.channelStates?.[channelId]?.type ? { type: state.channelStates[channelId]!.type } : {};
  }
  return { ...state, config, ...(state.channelStates ? { channelIntents: { ...state.channelIntents, [channelId]: true } } : {}) };
}

/** 关闭 channel：从 config.messaging 移除 */
export function disableMessaging(
  state: WorkingState,
  channelId: string,
): WorkingState {
  if (state.channelStates) return { ...state, channelIntents: { ...state.channelIntents, [channelId]: false } };
  const config = structuredClone(state.config);
  if (!config.messaging) return state;
  delete config.messaging[channelId];
  return { ...state, config };
}

export function isMessagingEnabled(state: WorkingState, channelId: string): boolean {
  return state.channelIntents?.[channelId] ?? state.channelStates?.[channelId]?.enabled ?? (state.config.messaging?.[channelId] !== undefined);
}

export function messagingEnabledProjection(state: WorkingState): Readonly<Record<string, boolean>> {
  return Object.fromEntries([...new Set([...Object.keys(state.config.messaging ?? {}), ...Object.keys(state.channelStates ?? {})])]
    .map((id) => [id, isMessagingEnabled(state, id)]));
}

// ─── MCP server 字段读写 ───
//
// config.mcp.servers 放连接决策（传输方式 + 启动信息 + 启用开关），credentials.mcp
// 放该 server 的密字段。二者分属公开配置与 SecretStore、同一 server id 索引——增删改严格成对维护，
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
 * 避免在编辑结果中残留孤儿凭据；两处只在 [完成] 后交给组合根持久化。
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
