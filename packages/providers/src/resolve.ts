/**
 * Provider / 连接配置解析器（v2 连接权威 + 窄目录读口，兼容直接测试入口）。
 *
 * 解析流程：
 * 1. 从 v2 `llm.connections[connectionId]` 取连接定义（或兼容旧 `resolveProvider(id, v1Creds)`）
 * 2. 校验目标协议是否在当前版本已实现受控适配（未实现协议不得冒充可用）
 * 3. 按 `auth.mode`（none / api-key / header）从设备本地 SecretStore 投影解析逻辑凭据（绝不造假 Key，拒绝已撤销/已封禁凭据）
 * 4. 经窄目录读口合并预设已知模型与连接级 `modelOverrides`、方言、网络策略与来源指纹
 * 5. 返回 `ResolvedProvider` / `ResolvedLLMRoles`（含用途降级记录与结构化参数/输出偏好）
 */

import type { ModelInfo, ModelSelectionParams, SessionModelSelection } from "@zhixing-ai/core";
import { validateSingleHopHeaderName } from "@zhixing-ai/network";
import { DEFAULT_MODEL_CATALOG_PORT, type ModelCatalogPort } from "./catalog-port.js";
import { evaluateCapabilities, resolveInferenceBaseUrl } from "./catalog/schema.js";
import {
  synthesizeConnectionModels,
  type DiscoveredModelRecord,
  type HardConstraintConflict,
} from "./catalog/synthesis.js";
import {
  DEFAULT_QUIRKS,
  isLLMConfigV2,
  type LegacyLLMConfigV1,
  type LLMConfigV2,
  type LLMRoleConfig,
  type ModelBudgetOverride,
  type ModelConnectionConfig,
  type ModelInputCapabilitiesOverride,
  type NetworkConfig,
  type Protocol,
  type ProviderCredentialEntry,
  type ProviderCredentialProjection,
  type ProviderQuirks,
  type ResolvedProvider,
  type RoleSelection,
  type ZhixingConfig,
} from "./types.js";

// ─── 错误类型 ───

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
  ) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** 计算非秘密来源指纹（origin + 规范化 basePath），供跨连接/同连接改址历史投影隔离。 */
export function computeSourceOriginKey(endpoint: string, adapter: string): string {
  try {
    const parsed = new URL(endpoint);
    const cleanPath = parsed.pathname.replace(/\/+$/u, "");
    return `${adapter}@${parsed.origin.toLowerCase()}${cleanPath}`;
  } catch {
    return `${adapter}@${endpoint.replace(/\/+$/u, "")}`;
  }
}

// ─── v2 连接解析 ───

export interface ConnectionDiscoveryFacts {
  readonly models: readonly DiscoveredModelRecord[];
  readonly authoritativeNativeFacts: boolean;
  readonly serverConfirmedHardLimits?: Readonly<
    Record<
      string,
      {
        readonly contextWindow?: number;
        readonly maxOutputTokens?: number;
        readonly supportsImages?: boolean;
        readonly supportsTools?: boolean;
        readonly supportsThinking?: boolean;
      }
    >
  >;
}

export interface ResolveConnectionOptions {
  readonly networkProxy?: NetworkConfig["proxy"];
  readonly catalog?: ModelCatalogPort;
  /** 本连接的最新已验证发现事实（来自隔离 `ModelDiscoveryCache` 或显式调用注入）。 */
  readonly discovery?: ConnectionDiscoveryFacts;
  /** 可选本地能力集合（默认 `LOCAL_SUPPORTED_CATALOG_CAPABILITIES`）。 */
  readonly localCapabilities?: readonly string[];
}

export interface ResolveLLMRolesOptions {
  readonly catalog?: ModelCatalogPort;
  readonly discoveryByConnection?: Readonly<Record<string, ConnectionDiscoveryFacts>>;
  readonly localCapabilities?: readonly string[];
}

function normalizeRolesOptions(
  input?: ModelCatalogPort | ResolveLLMRolesOptions,
): ResolveLLMRolesOptions {
  if (!input) return {};
  if ("bundle" in input && "listPresets" in input) {
    return { catalog: input };
  }
  return input;
}

/**
 * 校验目录中已知条目的 `requiredCapabilities` 能力硬门控（设计 §2.2.3、§4.1）：
 * 若目录明确标注该预设或精确型号需要本地未实现的能力，拒绝静默放行并明确提示升级知行。
 */
export function assertModelCapabilitySupported(input: {
  readonly catalog: ModelCatalogPort;
  readonly connectionId: string;
  readonly presetId?: string;
  readonly modelId: string;
  readonly localCapabilities?: readonly string[];
}): void {
  const { catalog, connectionId, presetId, modelId, localCapabilities } = input;
  if (!presetId) return;
  const preset = catalog.bundle.presets.find((p) => p.id === presetId);
  const presetGate = evaluateCapabilities(preset?.requiredCapabilities, localCapabilities);
  if (presetGate.requiresUpgrade) {
    throw new ProviderConfigError(
      `连接 "${connectionId}"（预设 ${presetId}）需要升级知行以支持所需能力（${presetGate.missingCapabilities.join(", ")}）`,
      connectionId,
    );
  }
  const curatedModel = catalog.bundle.models.find(
    (m) => m.presetId === presetId && m.id === modelId,
  );
  if (curatedModel) {
    const modelGate = evaluateCapabilities(curatedModel.requiredCapabilities, localCapabilities);
    if (modelGate.requiresUpgrade) {
      throw new ProviderConfigError(
        `模型 "${modelId}" 需要升级知行以支持所需能力（${modelGate.missingCapabilities.join(", ")}），当前版本不能激活为运行模型`,
        connectionId,
      );
    }
  }
}

/**
 * 从 v2 连接表与设备秘密投影解析单个连接。
 * 严格区分免密（none）、API Key（api-key）与自定义认证头（header），拒绝未实现协议、已撤销与封禁凭据；
 * 统一经 `synthesizeConnectionModels` 合成目录、发现事实与用户覆盖，在运行侧强制执行 Layer 1 硬约束钳制。
 */
export function resolveConnection(
  connectionId: string,
  connection: ModelConnectionConfig,
  credentials: ProviderCredentialProjection,
  options: ResolveConnectionOptions = {},
): ResolvedProvider {
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  if (!catalog.isAdapterImplemented(connection.adapter)) {
    throw new ProviderConfigError(
      `连接 "${connectionId}" 使用的协议 "${connection.adapter}" 在当前版本尚未实现受控适配，不能作为可用连接启动`,
      connectionId,
    );
  }
  const endpoint = resolveInferenceBaseUrl(
    connection.endpoint,
    connection.adapter,
    connection.presetId,
  );
  if (!endpoint) {
    throw new ProviderConfigError(`连接 "${connectionId}" 缺少有效端点地址`, connectionId);
  }

  let apiKey = "";
  let authHeaderName: string | undefined;
  let secretRef: string | undefined;

  if (connection.auth.mode === "api-key" || connection.auth.mode === "header") {
    secretRef = connection.auth.secretRef;
    if (connection.auth.mode === "header") {
      const headerError = validateSingleHopHeaderName(connection.auth.headerName);
      if (headerError) {
        throw new ProviderConfigError(`连接 "${connectionId}" 认证头无效：${headerError}`, connectionId);
      }
      authHeaderName = connection.auth.headerName;
    }
    if (credentials.revokedModelSecretRefs?.includes(secretRef)) {
      throw new ProviderConfigError(
        `连接 "${connectionId}" 的凭据（${secretRef}）已显式撤销，需录入新密钥后方可使用`,
        connectionId,
      );
    }
    if (credentials.compromisedModelSecretTokens?.[secretRef]) {
      throw new ProviderConfigError(
        `连接 "${connectionId}" 的凭据（${secretRef}）处于封禁状态（存在但不可读取），请在 /config 录入新密钥完成轮换`,
        connectionId,
      );
    }
    const secretEntry = credentials.modelSecrets?.[secretRef];
    if (!secretEntry || !secretEntry.value.trim()) {
      throw new ProviderConfigError(
        `连接 "${connectionId}" 缺少逻辑凭据 "${secretRef}"。请在目标设备终端通过 /config 写入本地 SecretStore。`,
        connectionId,
      );
    }
    if (secretEntry.kind !== connection.auth.mode) {
      throw new ProviderConfigError(
        `连接 "${connectionId}" 认证模式（${connection.auth.mode}）与凭据记录类型（${secretEntry.kind}）不匹配`,
        connectionId,
      );
    }
    apiKey = secretEntry.value;
  }

  const presetEntry = connection.presetId ? catalog.getPreset(connection.presetId) : undefined;
  const quirks = mergeQuirks(presetEntry?.preset.quirks, {
    ...(connection.dialect?.thinking ? { thinkingDialect: connection.dialect.thinking } : {}),
    ...(connection.dialect?.usage ? { usageDialect: connection.dialect.usage } : {}),
  });

  // 统一走三层合成（目录 + 原生发现 + 用户覆盖 + Layer 1 硬约束钳制），保证配置/列表与运行侧同源
  const synthesized = synthesizeConnectionModels({
    connectionId,
    connection,
    catalog: catalog.bundle,
    ...(options.discovery ? { discoveredModels: options.discovery.models } : {}),
    ...(options.discovery !== undefined
      ? { discoveredAuthoritative: options.discovery.authoritativeNativeFacts }
      : {}),
    ...(options.discovery?.serverConfirmedHardLimits
      ? { serverConfirmedHardLimits: options.discovery.serverConfirmedHardLimits }
      : {}),
    adapterImplemented: catalog.isAdapterImplemented(connection.adapter),
    includeHidden: true,
    includeOverrideOnlyIds: true,
    ...(options.localCapabilities ? { localCapabilities: options.localCapabilities } : {}),
  });

  const declaredModels: ModelInfo[] = [];
  const effectiveModelOverrides: Record<string, ModelBudgetOverride> = {};
  const effectiveInputCapabilities: Record<string, ModelInputCapabilitiesOverride> = {};
  const overrideConflicts: Record<string, readonly HardConstraintConflict[]> = {};
  const rawOverrides = connection.modelOverrides ?? {};

  for (const candidate of synthesized.models) {
    if (candidate.modelInfo) {
      declaredModels.push(candidate.modelInfo);
    }
    const rawUserOverride = rawOverrides[candidate.id];
    const hasHardConflict = candidate.overrideConflicts.length > 0;
    if (hasHardConflict) {
      overrideConflicts[candidate.id] = candidate.overrideConflicts;
    }

    // 凡涉及用户覆盖、原生发现字段或硬约束钳制，均把钳制后的有效值写入运行侧覆盖投影，
    // 确保 core resolveModelInfo / resolveModelInputCapabilities 绝不绕过 Layer 1 硬约束
    const budget: ModelBudgetOverride = {};
    const ctxField = candidate.fields.contextWindow;
    const maxField = candidate.fields.maxOutputTokens;
    if (
      ctxField.value !== undefined &&
      (rawUserOverride?.contextWindow !== undefined ||
        ctxField.source === "user-override" ||
        ctxField.source === "native-discovery")
    ) {
      budget.contextWindow = ctxField.value;
    }
    if (
      maxField.value !== undefined &&
      (rawUserOverride?.maxOutputTokens !== undefined ||
        maxField.source === "user-override" ||
        maxField.source === "native-discovery")
    ) {
      budget.maxOutputTokens = maxField.value;
    }
    if (budget.contextWindow !== undefined || budget.maxOutputTokens !== undefined) {
      effectiveModelOverrides[candidate.id] = budget;
    }

    const imgField = candidate.fields.supportsImages;
    if (
      imgField.value !== undefined &&
      (rawUserOverride?.supportsImages !== undefined ||
        imgField.source === "user-override" ||
        imgField.source === "native-discovery" ||
        hasHardConflict)
    ) {
      effectiveInputCapabilities[candidate.id] = { images: imgField.value };
    }
  }

  return {
    id: connectionId,
    connectionId,
    name: connection.name || presetEntry?.preset.name || connectionId,
    baseUrl: endpoint,
    sourceOriginKey: computeSourceOriginKey(endpoint, connection.adapter),
    authMode: connection.auth.mode,
    ...(authHeaderName ? { authHeaderName } : {}),
    ...(secretRef ? { secretRef } : {}),
    apiKey,
    protocol: connection.adapter as Protocol,
    quirks,
    network: connection.network,
    ...(options.networkProxy !== undefined ? { networkProxy: options.networkProxy } : {}),
    declaredModels,
    ...(Object.keys(effectiveModelOverrides).length > 0
      ? { modelOverrides: effectiveModelOverrides }
      : {}),
    ...(Object.keys(effectiveInputCapabilities).length > 0
      ? { modelInputCapabilities: effectiveInputCapabilities }
      : {}),
    ...(Object.keys(overrideConflicts).length > 0 ? { overrideConflicts } : {}),
  };
}

/**
 * 兼容直接按 providerId + v1 凭据条目解析（供 createProviderDirect 与既有单测使用）。
 */
export function resolveProvider(
  providerId: string,
  credentials: ProviderCredentialProjection,
  catalog: ModelCatalogPort = DEFAULT_MODEL_CATALOG_PORT,
): ResolvedProvider {
  const preset = catalog.getPreset(providerId)?.preset;
  const entry = credentials.providers?.[providerId];

  const baseUrl = entry?.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) {
    throw new ProviderConfigError(
      `Provider "${providerId}" 需要配置 baseUrl（不在内置预设列表中，请通过配置向导补齐）`,
      providerId,
    );
  }

  const protocol = entry?.protocol ?? preset?.protocol;
  if (!protocol) {
    throw new ProviderConfigError(
      `Provider "${providerId}" 需要配置 protocol（不在内置预设列表中，请通过配置向导补齐）。` +
        `可选值: "openai-compatible" | "openai-responses" | "anthropic-messages" | "google-interactions"`,
      providerId,
    );
  }

  const apiKey = resolveLegacyApiKey(providerId, entry);
  const quirks = mergeQuirks(preset?.quirks, entry?.quirks);
  const normalizedUrl = resolveInferenceBaseUrl(baseUrl, protocol, providerId);

  return {
    id: providerId,
    connectionId: providerId,
    name: preset?.name ?? providerId,
    baseUrl: normalizedUrl,
    sourceOriginKey: computeSourceOriginKey(normalizedUrl, protocol),
    authMode: "api-key",
    secretRef: providerId,
    apiKey,
    protocol,
    quirks,
    declaredModels: preset?.knownModels ?? [],
    modelOverrides: entry?.modelOverrides,
    modelInputCapabilities: entry?.modelInputCapabilities,
  };
}

/**
 * 从顶层配置中解析指定连接/provider（或 main 角色）。
 */
export function resolveFromConfig(
  config: ZhixingConfig,
  credentials: ProviderCredentialProjection,
  connectionOrProviderId?: string,
  catalogOrOptions?: ModelCatalogPort | ResolveLLMRolesOptions,
): ResolvedProvider {
  const opts = normalizeRolesOptions(catalogOrOptions);
  const catalog = opts.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  const rawLlm = config.llm as unknown;
  if (isLLMConfigV2(rawLlm)) {
    const connId = connectionOrProviderId ?? rawLlm.main?.connectionId;
    if (!connId) {
      throw new ProviderConfigError(buildMissingMainConfigMessage(), "<unknown>");
    }
    const connection = rawLlm.connections[connId];
    if (!connection) {
      throw new ProviderConfigError(`未找到连接 "${connId}"`, connId);
    }
    const discovery = opts.discoveryByConnection?.[connId];
    return resolveConnection(connId, connection, credentials, {
      networkProxy: config.network?.proxy,
      catalog,
      ...(discovery ? { discovery } : {}),
      ...(opts.localCapabilities ? { localCapabilities: opts.localCapabilities } : {}),
    });
  }
  const legacy = rawLlm as LegacyLLMConfigV1 | undefined;
  const id = connectionOrProviderId ?? legacy?.main?.provider;
  if (!id) {
    throw new ProviderConfigError(buildMissingMainConfigMessage(), "<unknown>");
  }
  return resolveProvider(id, credentials, catalog);
}

// ─── LLM 三用途解析（配置层） ───

/** 单个角色解析结果——配置层产物，不含 LLMProvider 实例。 */
export interface ResolvedLLMRole {
  resolved: ResolvedProvider;
  model: string;
  params?: ModelSelectionParams;
  maxOutputPreference?: number;
}

export interface RoleDegradation {
  role: "light" | "power";
  configured: { provider: string; model: string };
  reason: string;
}

export interface ResolvedLLMRoles {
  main: ResolvedLLMRole;
  light: ResolvedLLMRole;
  power: ResolvedLLMRole;
  degradations: RoleDegradation[];
}

/**
 * 配置层三用途解析（设计 §5.1 步骤 1）：
 * `resolvedMain = llm.main`（必填）；`resolvedLight = llm.light ?? resolvedMain`；
 * `resolvedPower = llm.power ?? resolvedMain`。可选角色显式配置解析出错时告警回落 `resolvedMain`。
 */
export function resolveLLMRoles(
  config: ZhixingConfig,
  credentials: ProviderCredentialProjection,
  catalogOrOptions?: ModelCatalogPort | ResolveLLMRolesOptions,
): ResolvedLLMRoles {
  const opts = normalizeRolesOptions(catalogOrOptions);
  const catalog = opts.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  const rawLlm = config.llm as unknown;
  if (isLLMConfigV2(rawLlm)) {
    return resolveLLMRolesV2(rawLlm, config.network?.proxy, credentials, {
      catalog,
      ...(opts.discoveryByConnection ? { discoveryByConnection: opts.discoveryByConnection } : {}),
      ...(opts.localCapabilities ? { localCapabilities: opts.localCapabilities } : {}),
    });
  }
  const legacy = rawLlm as LegacyLLMConfigV1 | undefined;
  if (!legacy?.main) {
    throw new ProviderConfigError(buildMissingMainConfigMessage(), "<unknown>");
  }
  assertModelCapabilitySupported({
    catalog,
    connectionId: legacy.main.provider,
    presetId: legacy.main.provider,
    modelId: legacy.main.model,
    localCapabilities: opts.localCapabilities,
  });
  const main = resolveLegacyMainRole(legacy.main, credentials, catalog);
  const light = resolveLegacyAuxRole(legacy.light, credentials, main, "light", catalog);
  const power = resolveLegacyAuxRole(legacy.power, credentials, main, "power", catalog);
  return {
    main,
    light: light.role,
    power: power.role,
    degradations: [light.degradation, power.degradation].filter(
      (d): d is RoleDegradation => d != null,
    ),
  };
}

/**
 * 解析会话级结构化选模覆盖（设计 §5.1 步骤 2）：
 * `mode === "follow-default"` 返回 undefined（由调用方取对应主角色 `resolvedMain` 或 `resolvedPower`）；
 * `mode === "override"` 解析为完整绑定，绝不改写 `resolvedLight` 或用途默认。
 */
export function resolveSessionOverride(
  config: ZhixingConfig,
  credentials: ProviderCredentialProjection,
  selection: SessionModelSelection | undefined,
  catalogOrOptions?: ModelCatalogPort | ResolveLLMRolesOptions,
): ResolvedLLMRole | undefined {
  if (!selection || selection.mode === "follow-default") return undefined;
  const opts = normalizeRolesOptions(catalogOrOptions);
  const catalog = opts.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  const rawLlm = config.llm as unknown;
  if (!isLLMConfigV2(rawLlm)) {
    throw new ProviderConfigError("会话级结构化选模覆盖要求 v2 配置格式", selection.connectionId);
  }
  const connection = rawLlm.connections[selection.connectionId];
  if (!connection) {
    throw new ProviderConfigError(
      `本会话覆盖引用的连接 "${selection.connectionId}" 已不存在，请改选或恢复跟随默认`,
      selection.connectionId,
    );
  }
  assertModelCapabilitySupported({
    catalog,
    connectionId: selection.connectionId,
    presetId: connection.presetId,
    modelId: selection.model,
    localCapabilities: opts.localCapabilities,
  });
  const discovery = opts.discoveryByConnection?.[selection.connectionId];
  const resolved = resolveConnection(selection.connectionId, connection, credentials, {
    networkProxy: config.network?.proxy,
    catalog,
    ...(discovery ? { discovery } : {}),
    ...(opts.localCapabilities ? { localCapabilities: opts.localCapabilities } : {}),
  });
  return {
    resolved,
    model: selection.model,
    ...(selection.params ? { params: selection.params } : {}),
    ...(selection.maxOutputPreference !== undefined
      ? { maxOutputPreference: selection.maxOutputPreference }
      : {}),
  };
}

function resolveLLMRolesV2(
  llm: LLMConfigV2,
  networkProxy: NetworkConfig["proxy"],
  credentials: ProviderCredentialProjection,
  opts: {
    readonly catalog: ModelCatalogPort;
    readonly discoveryByConnection?: Readonly<Record<string, ConnectionDiscoveryFacts>>;
    readonly localCapabilities?: readonly string[];
  },
): ResolvedLLMRoles {
  if (!llm.main) {
    throw new ProviderConfigError(buildMissingMainConfigMessage(), "<unknown>");
  }
  const mainConn = llm.connections[llm.main.connectionId];
  if (!mainConn) {
    throw new ProviderConfigError(
      `主模型引用的连接 "${llm.main.connectionId}" 不存在，请通过 /config 修复绑定`,
      llm.main.connectionId,
    );
  }
  assertModelCapabilitySupported({
    catalog: opts.catalog,
    connectionId: llm.main.connectionId,
    presetId: mainConn.presetId,
    modelId: llm.main.model,
    localCapabilities: opts.localCapabilities,
  });
  const mainDiscovery = opts.discoveryByConnection?.[llm.main.connectionId];
  const mainResolved = resolveConnection(llm.main.connectionId, mainConn, credentials, {
    networkProxy,
    catalog: opts.catalog,
    ...(mainDiscovery ? { discovery: mainDiscovery } : {}),
    ...(opts.localCapabilities ? { localCapabilities: opts.localCapabilities } : {}),
  });
  const main: ResolvedLLMRole = {
    resolved: mainResolved,
    model: llm.main.model,
    ...(llm.main.params ? { params: llm.main.params } : {}),
    ...(llm.main.maxOutputPreference !== undefined
      ? { maxOutputPreference: llm.main.maxOutputPreference }
      : {}),
  };

  const light = resolveAuxRoleV2(llm, llm.light, networkProxy, credentials, main, "light", opts);
  const power = resolveAuxRoleV2(llm, llm.power, networkProxy, credentials, main, "power", opts);

  return {
    main,
    light: light.role,
    power: power.role,
    degradations: [light.degradation, power.degradation].filter(
      (d): d is RoleDegradation => d != null,
    ),
  };
}

function resolveAuxRoleV2(
  llm: LLMConfigV2,
  explicit: RoleSelection | undefined,
  networkProxy: NetworkConfig["proxy"],
  credentials: ProviderCredentialProjection,
  fallbackRole: ResolvedLLMRole,
  roleId: "light" | "power",
  opts: {
    readonly catalog: ModelCatalogPort;
    readonly discoveryByConnection?: Readonly<Record<string, ConnectionDiscoveryFacts>>;
    readonly localCapabilities?: readonly string[];
  },
): { role: ResolvedLLMRole; degradation?: RoleDegradation } {
  if (!explicit) {
    return {
      role: {
        resolved: fallbackRole.resolved,
        model: fallbackRole.model,
        ...(fallbackRole.params ? { params: fallbackRole.params } : {}),
        ...(fallbackRole.maxOutputPreference !== undefined
          ? { maxOutputPreference: fallbackRole.maxOutputPreference }
          : {}),
      },
    };
  }
  const connection = llm.connections[explicit.connectionId];
  if (!connection) {
    return {
      role: {
        resolved: fallbackRole.resolved,
        model: fallbackRole.model,
        ...(fallbackRole.params ? { params: fallbackRole.params } : {}),
        ...(fallbackRole.maxOutputPreference !== undefined
          ? { maxOutputPreference: fallbackRole.maxOutputPreference }
          : {}),
      },
      degradation: {
        role: roleId,
        configured: { provider: explicit.connectionId, model: explicit.model },
        reason: "所引用连接不存在",
      },
    };
  }
  try {
    assertModelCapabilitySupported({
      catalog: opts.catalog,
      connectionId: explicit.connectionId,
      presetId: connection.presetId,
      modelId: explicit.model,
      localCapabilities: opts.localCapabilities,
    });
    if (explicit.connectionId === fallbackRole.resolved.id) {
      return {
        role: {
          resolved: fallbackRole.resolved,
          model: explicit.model,
          ...(explicit.params ? { params: explicit.params } : {}),
          ...(explicit.maxOutputPreference !== undefined
            ? { maxOutputPreference: explicit.maxOutputPreference }
            : {}),
        },
      };
    }
    const discovery = opts.discoveryByConnection?.[explicit.connectionId];
    const resolved = resolveConnection(explicit.connectionId, connection, credentials, {
      networkProxy,
      catalog: opts.catalog,
      ...(discovery ? { discovery } : {}),
      ...(opts.localCapabilities ? { localCapabilities: opts.localCapabilities } : {}),
    });
    return {
      role: {
        resolved,
        model: explicit.model,
        ...(explicit.params ? { params: explicit.params } : {}),
        ...(explicit.maxOutputPreference !== undefined
          ? { maxOutputPreference: explicit.maxOutputPreference }
          : {}),
      },
    };
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return {
        role: {
          resolved: fallbackRole.resolved,
          model: fallbackRole.model,
          ...(fallbackRole.params ? { params: fallbackRole.params } : {}),
          ...(fallbackRole.maxOutputPreference !== undefined
            ? { maxOutputPreference: fallbackRole.maxOutputPreference }
            : {}),
        },
        degradation: {
          role: roleId,
          configured: { provider: explicit.connectionId, model: explicit.model },
          reason: err.message || "凭证或必要配置缺失",
        },
      };
    }
    throw err;
  }
}

function resolveLegacyMainRole(
  mainConfig: LLMRoleConfig,
  credentials: ProviderCredentialProjection,
  catalog: ModelCatalogPort,
): ResolvedLLMRole {
  assertModelCapabilitySupported({
    catalog,
    connectionId: mainConfig.provider,
    presetId: mainConfig.provider,
    modelId: mainConfig.model,
  });
  const resolved = resolveProvider(mainConfig.provider, credentials, catalog);
  return {
    resolved,
    model: mainConfig.model,
    ...(mainConfig.thinking ? { params: { thinking: mainConfig.thinking } } : {}),
  };
}

function resolveLegacyAuxRole(
  explicit: LLMRoleConfig | undefined,
  credentials: ProviderCredentialProjection,
  fallbackRole: ResolvedLLMRole,
  roleId: "light" | "power",
  catalog: ModelCatalogPort,
): { role: ResolvedLLMRole; degradation?: RoleDegradation } {
  if (!explicit) {
    return {
      role: {
        resolved: fallbackRole.resolved,
        model: fallbackRole.model,
        ...(fallbackRole.params ? { params: fallbackRole.params } : {}),
      },
    };
  }
  try {
    assertModelCapabilitySupported({
      catalog,
      connectionId: explicit.provider,
      presetId: explicit.provider,
      modelId: explicit.model,
    });
    if (explicit.provider === fallbackRole.resolved.id) {
      return {
        role: {
          resolved: fallbackRole.resolved,
          model: explicit.model,
          ...(explicit.thinking ? { params: { thinking: explicit.thinking } } : {}),
        },
      };
    }
    const resolved = resolveProvider(explicit.provider, credentials, catalog);
    return {
      role: {
        resolved,
        model: explicit.model,
        ...(explicit.thinking ? { params: { thinking: explicit.thinking } } : {}),
      },
    };
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return {
        role: {
          resolved: fallbackRole.resolved,
          model: fallbackRole.model,
          ...(fallbackRole.params ? { params: fallbackRole.params } : {}),
        },
        degradation: {
          role: roleId,
          configured: { provider: explicit.provider, model: explicit.model },
          reason: err.message.includes("需要升级知行")
            ? err.message
            : "凭证或必要配置缺失",
        },
      };
    }
    throw err;
  }
}

function buildMissingMainConfigMessage(): string {
  return (
    "ZhixingConfig.llm.main is required.\n\n" +
    "请在目标设备终端运行 `zhixing` 或 `/config`，添加服务商连接并绑定主模型（main）。"
  );
}

function resolveLegacyApiKey(
  providerId: string,
  entry: ProviderCredentialEntry | undefined,
): string {
  if (entry?.apiKey) return entry.apiKey;
  throw new ProviderConfigError(
    `Provider "${providerId}" 缺少 API Key。\n` +
      `请在目标设备的 TTY 终端运行 \`zhixing\`，通过配置向导写入本地 SecretStore。`,
    providerId,
  );
}

function mergeQuirks(
  presetQuirks?: Partial<ProviderQuirks>,
  userQuirks?: Partial<ProviderQuirks>,
): ProviderQuirks {
  return {
    ...DEFAULT_QUIRKS,
    ...presetQuirks,
    ...userQuirks,
  };
}
