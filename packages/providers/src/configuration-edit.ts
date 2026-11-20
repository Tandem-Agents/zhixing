import { runtimeConfigurationObservation } from "./configuration-logging.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireFileLock, ensureDurableDirectory, syncDirectory, type FileLockOptions } from "@zhixing-ai/core/persistence";
import { canonicalize } from "@zhixing-ai/core/protocol/canonical";
import type { SecretRef, SecretStorePort } from "@zhixing-ai/core/contracts";
import type { LogRecordPort, LogSource } from "@zhixing-ai/core/logging";
import { isLocalOrPrivateHostname } from "@zhixing-ai/network";
import { DEFAULT_MODEL_CATALOG_PORT, type ModelCatalogPort } from "./catalog-port.js";
import {
  applyConfigPatch,
  assertAbsoluteWorkspaceRoot,
  assertNoConfigurationCommit,
  loadConfig,
  writeConfigUnlocked,
} from "./config-loader.js";
import { hasExplicitUrlCredentialsOrQueryAuth, validateConfigSemantics } from "./config-validator.js";
import {
  applyCredentialEdits,
  assertNoConfigurationEdit,
  commitCredentialsUnlocked,
  CONFIGURATION_EDIT_REF,
  loadCredentialsUnlocked,
  loadCredentialSnapshotUnlocked,
  mutationCoordinator,
  normalizePendingModelRetirements,
  readManifestMetadataUnlocked,
  readPendingModelRetirementsUnlocked,
  writePendingModelRetirementsUnlocked,
  type CredentialSnapshotOptions,
} from "./credentials-loader.js";
import { writeJsonAtomic } from "./internal/io.js";
import { normalizeModelId, type ModelCapabilityOverride } from "./model-capability.js";
import {
  isLegacyLLMConfigV1,
  isLLMConfigV2,
  type LegacyLLMConfigV1,
  type LLMConfigV2,
  type LLMRoleConfig,
  type MigrationPendingItem,
  type ModelConnectionConfig,
  type ModelSecretEntryV2,
  type ModelSpecOverride,
  type PendingModelSecretRetirement,
  type ProviderCredentialEntry,
  type RoleSelection,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "./types.js";

export const CONFIGURATION_LOG_SOURCE: LogSource = {
  id: "configuration",
  version: 1,
  events: {
    saved: {
      message: "配置保存已完成",
      level: "info",
      tier: "critical",
      fields: { scope: "text", selectionVersion: "text", selectionDigest: "text", omitted: "text" },
    },
    uncertain: {
      message: "配置保存尚未确认完成",
      level: "warn",
      tier: "critical",
      fields: { error: "text" },
    },
    recovered: {
      message: "配置保存恢复已完成",
      level: "info",
      tier: "critical",
      fields: { selectionVersion: "text", selectionDigest: "text", omitted: "text" },
    },
    effective: {
      message: "宿主已接纳运行配置",
      level: "info",
      tier: "critical",
      fields: {
        mode: "text",
        roles: { items: "text", maxItems: 8 },
        selectionVersion: "text",
        selectionDigest: "text",
        omitted: "text",
      },
    },
  },
};

type Snapshot = { config: ZhixingConfig; credentials: ZhixingCredentials };
type SecretUpdate = { readonly ref: SecretRef; readonly value: string };
type Options = CredentialSnapshotOptions & {
  readonly configPath: string;
  readonly records?: LogRecordPort;
  readonly processIdentityResolver?: FileLockOptions["processIdentityResolver"];
};

interface SavedEditV1 extends Snapshot {
  readonly v: 1;
  readonly id: string;
  readonly configPath: string;
  readonly secretUpdates: readonly SecretUpdate[];
}

interface SavedEditV2 extends Snapshot {
  readonly v: 2;
  readonly id: string;
  readonly configPath: string;
  readonly secretUpdates: readonly SecretUpdate[];
  readonly modelConfigVersion: 2;
  readonly pendingModelRetirements?: readonly PendingModelSecretRetirement[];
  readonly removeLegacyModelCapabilityOverrides?: boolean;
}

type SavedEdit = SavedEditV1 | SavedEditV2;

export interface EditConfigurationOptions {
  readonly scope?: "mcp";
  /** Prepare encrypted publication records after both source baselines have been checked. */
  readonly prepare?: (store: SecretStorePort, source: Snapshot) => Promise<readonly SecretUpdate[]>;
  /** 随本次保存原子登记到 configuration/model-retirements/v1 的待清退/撤权项。 */
  readonly modelRetirements?: readonly PendingModelSecretRetirement[];
  /** 显式移除旧根级 modelCapabilityOverrides 字段（不依赖省略字段删除）。 */
  readonly removeLegacyModelCapabilityOverrides?: boolean;
  /** 强制本次保存使用 SavedEdit.v = 2 并落盘 MANIFEST_REF.modelConfigVersion = 2。 */
  readonly forceModelConfigVersion2?: boolean;
}

export interface ConfigurationMigrationResult {
  readonly status:
    | "migrated"
    | "already-v2"
    | "not-needed"
    | "blocked"
    | "mismatch";
  readonly reason?: string;
  readonly blockedProviders?: readonly string[];
  readonly protectedLegacyProviderIds?: readonly string[];
  readonly pendingItemCount?: number;
}

export interface ConfigurationSnapshotResult extends Snapshot {
  readonly generation: string | null;
  readonly modelConfigVersion: 1 | 2 | null;
  readonly pendingModelRetirements: readonly PendingModelSecretRetirement[];
  readonly recoveredEdit?: true;
  readonly migration?: ConfigurationMigrationResult;
}

/** The configuration owner reports its durable acceptance boundary. A surface
 * must reopen through recovery, never retry a stale edit as an unsaved draft. */
export class ConfigurationEditPendingError extends Error {
  constructor(
    readonly acceptance: "unknown" | "accepted",
    cause: unknown,
  ) {
    super(
      acceptance === "accepted"
        ? "配置修改已接纳，保存收尾尚未完成；重新打开配置入口或重启将继续恢复"
        : "配置接纳结果尚未确认；重新打开配置入口将核对保存状态，未逆向覆盖",
      { cause },
    );
    this.name = "ConfigurationEditPendingError";
  }
}

/** Config/Secret own one recoverable local save. Only its random id goes to disk in plaintext. */
export async function editConfiguration(
  expected: Snapshot,
  next: Snapshot,
  options: Options & EditConfigurationOptions,
): Promise<void> {
  await recoverConfigurationEdit(options);
  const configPath = path.resolve(options.configPath);
  const release = await lockConfiguration(configPath, options);
  try {
    await mutationCoordinator(options).runExclusive(async () => {
      assertNoConfigurationCommit(configPath);
      await assertNoConfigurationEdit(options.store);
      const currentConfig = loadConfig({ configPath, noAutoCreate: true });
      const beforeConfig = options.scope === "mcp" ? expected.config.mcp ?? {} : expected.config;
      const observedConfig = options.scope === "mcp" ? currentConfig.mcp ?? {} : currentConfig;
      if (canonicalize(beforeConfig) !== canonicalize(observedConfig)) {
        throw new Error("配置在编辑期间已变更，未覆盖；请重新打开配置面板");
      }
      const manifestMeta = await readManifestMetadataUnlocked(options.store);
      const currentCredentials = await loadCredentialsUnlocked({ store: options.store });
      const credentials = applyCredentialEdits(
        currentCredentials,
        options.scope === "mcp" ? { mcp: expected.credentials.mcp ?? {} } : expected.credentials,
        options.scope === "mcp" ? { mcp: next.credentials.mcp ?? {} } : next.credentials,
        { currentGeneration: manifestMeta?.generation ?? null },
      );
      const config =
        options.scope === "mcp"
          ? { ...currentConfig, mcp: next.config.mcp ?? {} }
          : applyConfigPatch(currentConfig, next.config, "replace", {
              removeLegacyModelCapabilityOverrides: options.removeLegacyModelCapabilityOverrides,
            });
      assertAbsoluteWorkspaceRoot(config, configPath);
      if (validateConfigSemantics(config).length) {
        throw new Error("配置含有不支持的字段，未保存；请通过配置入口修正");
      }

      const useV2 =
        options.forceModelConfigVersion2 === true ||
        isLLMConfigV2(config.llm) ||
        manifestMeta?.modelConfigVersion === 2 ||
        (options.modelRetirements?.length ?? 0) > 0;

      const existingRetirements = await readPendingModelRetirementsUnlocked(options.store);
      const stampedNewRetirements = (options.modelRetirements ?? []).map((item) => {
        if (item.secretHash) return item;
        const secretValue =
          currentCredentials.modelSecrets?.[item.secretRef]?.value ??
          next.credentials.modelSecrets?.[item.secretRef]?.value ??
          currentCredentials.providers?.[item.secretRef]?.apiKey;
        return secretValue && secretValue.trim().length > 0
          ? { ...item, secretHash: sha256Hex(secretValue) }
          : item;
      });
      const nextRetirements =
        stampedNewRetirements.length > 0
          ? normalizePendingModelRetirements([...existingRetirements, ...stampedNewRetirements])
          : existingRetirements;

      const secretUpdates =
        (await options.prepare?.(options.store, { config, credentials })) ?? [];
      const edit: SavedEdit = useV2
        ? {
            v: 2,
            id: randomUUID(),
            configPath,
            config,
            credentials: { ...credentials, version: 2 },
            secretUpdates,
            modelConfigVersion: 2,
            ...(nextRetirements.length > 0 ? { pendingModelRetirements: nextRetirements } : {}),
            ...(options.removeLegacyModelCapabilityOverrides
              ? { removeLegacyModelCapabilityOverrides: true }
              : {}),
          }
        : {
            v: 1,
            id: randomUUID(),
            configPath,
            config,
            credentials,
            secretUpdates,
          };

      await persistAndApplySavedEdit(edit, options, options.scope ?? "configuration");
    });
  } finally {
    await release();
  }
}

/**
 * 安全的旧配置 v1 → v2 原子迁移（设计 §5.5）：
 * 1. 先恢复合法遗留保存计划再迁移；
 * 2. 在配置锁与 SecretStore 互斥内先重读判重，并发启动幂等；
 * 3. 管理权限读取完整原记录（不因普通编辑读过滤漏迁 compromised 凭据）；
 * 4. 仅省略或匹配已核验公开预设的端点自动迁入公开连接表；含 URL 内嵌凭据或敏感查询参数拒绝迁移并保留原对；
 *    无法自动确认公开性质的自定义 baseUrl 留存 SecretStore（protectedLegacyProviders）待修复确认；
 * 5. modelCapabilityOverrides 收口至 llm.attentionPolicies 并显式移除旧根级字段；
 * 6. 写入 SavedEdit.v = 2 与 MANIFEST_REF.modelConfigVersion = 2 阻止旧程序误读。
 */
export async function migrateConfigurationV1ToV2(
  options: Options & { readonly catalog?: ModelCatalogPort },
): Promise<ConfigurationMigrationResult> {
  await recoverConfigurationEdit(options);
  const configPath = path.resolve(options.configPath);
  const catalog = options.catalog ?? DEFAULT_MODEL_CATALOG_PORT;
  const release = await lockConfiguration(configPath, options);
  try {
    return await mutationCoordinator(options).runExclusive(() =>
      migrateConfigurationV1ToV2Unlocked(configPath, options, catalog),
    );
  } finally {
    await release();
  }
}

async function migrateConfigurationV1ToV2Unlocked(
  configPath: string,
  options: Options,
  catalog: ModelCatalogPort,
): Promise<ConfigurationMigrationResult> {
  assertNoConfigurationCommit(configPath);
  await assertNoConfigurationEdit(options.store);

  const currentConfig = loadConfig({ configPath, noAutoCreate: true });
  const manifestMeta = await readManifestMetadataUnlocked(options.store);
  const rawLlm = currentConfig.llm as unknown;

  // 情况 1：公开配置已是 v2
  if (isLLMConfigV2(rawLlm)) {
    if (manifestMeta === null) {
      // 未初始化状态（如全新模板或纯免密已配 v2）：仅在已有显式连接时补建 modelConfigVersion=2
      if (Object.keys(rawLlm.connections).length > 0) {
        await commitCredentialsUnlocked(
          options.store,
          { version: 2 },
          { modelConfigVersion: 2 },
        );
      }
      return { status: "already-v2" };
    }
    if (manifestMeta.modelConfigVersion !== 2) {
      return {
        status: "mismatch",
        reason:
          "公开配置已为 v2，但设备 SecretStore 清单缺少 modelConfigVersion=2；拒绝自动覆盖，请经迁移修复入口核对",
      };
    }
    return { status: "already-v2" };
  }

  // 管理权限读取完整原凭据（不过滤 compromised，不漏迁任何条目）
  const fullCredentials = await loadCredentialsUnlocked({ store: options.store });
  const legacyProviders = fullCredentials.providers ?? {};
  const legacyLlm = isLegacyLLMConfigV1(rawLlm) ? (rawLlm as LegacyLLMConfigV1) : undefined;
  const hasLegacyRootOverrides =
    currentConfig.modelCapabilityOverrides !== undefined &&
    Object.keys(currentConfig.modelCapabilityOverrides).length > 0;

  if (
    !legacyLlm &&
    Object.keys(legacyProviders).length === 0 &&
    !hasLegacyRootOverrides
  ) {
    return { status: "not-needed" };
  }

  // 前置安全检查：检测任何旧自定义 baseUrl 含显式 URL 内嵌凭据或敏感查询认证
  const blockedProviders: string[] = [];
  for (const [providerId, entry] of Object.entries(legacyProviders)) {
    if (entry.baseUrl !== undefined && hasExplicitUrlCredentialsOrQueryAuth(entry.baseUrl)) {
      blockedProviders.push(providerId);
    }
  }
  if (blockedProviders.length > 0) {
    return {
      status: "blocked",
      reason: `检测到旧自定义端点含内嵌凭据或敏感查询认证参数（${blockedProviders.join("、")}），已保留原旧配对，请通过迁移修复入口人工处置`,
      blockedProviders,
    };
  }

  const connections: Record<string, ModelConnectionConfig> = {};
  const modelSecrets: Record<string, ModelSecretEntryV2> =
    { ...(fullCredentials.modelSecrets ?? {}) };
  const protectedLegacyProviders: Record<string, ProviderCredentialEntry> = {
    ...(fullCredentials.protectedLegacyProviders ?? {}),
  };
  const pendingItems: MigrationPendingItem[] = [];
  const migratedProviderIds = new Set<string>();
  const protectedIds: string[] = [];
  const nowIso = new Date().toISOString();

  // 收集所有涉及到的旧 providerId（凭据表 + 角色引用）
  const candidateProviderIds = new Set<string>([
    ...Object.keys(legacyProviders),
    ...(legacyLlm?.main?.provider ? [legacyLlm.main.provider] : []),
    ...(legacyLlm?.light?.provider ? [legacyLlm.light.provider] : []),
    ...(legacyLlm?.power?.provider ? [legacyLlm.power.provider] : []),
  ]);

  const preserveProtectedLegacyIntent = (
    providerId: string,
    entry: ProviderCredentialEntry | undefined,
  ): void => {
    const legacyRoles: {
      main?: LLMRoleConfig;
      light?: LLMRoleConfig;
      power?: LLMRoleConfig;
    } = {};
    if (legacyLlm?.main?.provider === providerId) legacyRoles.main = legacyLlm.main;
    if (legacyLlm?.light?.provider === providerId) legacyRoles.light = legacyLlm.light;
    if (legacyLlm?.power?.provider === providerId) legacyRoles.power = legacyLlm.power;

    const nonSecretFields: Record<string, unknown> = {};
    if (entry?.modelOverrides && Object.keys(entry.modelOverrides).length > 0) {
      nonSecretFields.modelOverrides = entry.modelOverrides;
    }
    if (entry?.modelInputCapabilities && Object.keys(entry.modelInputCapabilities).length > 0) {
      nonSecretFields.modelInputCapabilities = entry.modelInputCapabilities;
    }
    if (entry?.models && entry.models.length > 0) {
      nonSecretFields.models = [...entry.models];
    }
    if (entry?.quirks && Object.keys(entry.quirks).length > 0) {
      nonSecretFields.quirks = entry.quirks;
    }

    const roleList = Object.keys(legacyRoles);
    if (roleList.length > 0 || Object.keys(nonSecretFields).length > 0) {
      pendingItems.push({
        id: `protected-roles-${providerId}`,
        kind: "protected-legacy-roles",
        sourceProviderId: providerId,
        summary:
          roleList.length > 0
            ? `旧自定义服务商 "${providerId}" 受保护待确认；确认后将自动恢复 ${roleList.join("/")} 用途绑定与非秘密覆盖`
            : `旧自定义服务商 "${providerId}" 受保护待确认；确认后将自动恢复非秘密模型覆盖`,
        ...(roleList.length > 0 ? { legacyRoles } : {}),
        ...(Object.keys(nonSecretFields).length > 0 ? { legacyFields: nonSecretFields } : {}),
        createdAt: nowIso,
      });
    }
  };

  for (const providerId of [...candidateProviderIds].sort()) {
    const entry = legacyProviders[providerId];
    const presetEntry = catalog.getPreset(providerId);

    if (entry?.baseUrl !== undefined) {
      const isVerifiedPublic = catalog.isVerifiedPublicPresetEndpoint(providerId, entry.baseUrl);
      if (!isVerifiedPublic) {
        // 无法自动确认公开性质的旧自定义 URL：继续留存 SecretStore 受保护，绝不落公开 config.jsonc 或 migrationPending
        protectedLegacyProviders[providerId] = entry;
        protectedIds.push(providerId);
        preserveProtectedLegacyIntent(providerId, entry);
        continue;
      }
    }

    const endpoint = entry?.baseUrl ?? presetEntry?.preset.baseUrl;
    const adapter = entry?.protocol ?? presetEntry?.preset.protocol;
    if (!endpoint || !adapter) {
      // 既无预设又缺端点/协议：若含密钥绝不静默丢弃，转入受保护旧区待修复；非秘密覆盖归入 migrationPending
      if (entry && entry.apiKey && entry.apiKey.trim().length > 0) {
        protectedLegacyProviders[providerId] = entry;
        protectedIds.push(providerId);
        preserveProtectedLegacyIntent(providerId, entry);
      } else if (entry && (entry.modelOverrides || entry.modelInputCapabilities || entry.models)) {
        pendingItems.push({
          id: `unattributed-${providerId}`,
          kind: "unattributed-override",
          sourceProviderId: providerId,
          summary: `旧服务商 "${providerId}" 缺少端点或协议，未能自动归属其非秘密模型覆盖`,
          legacyFields: {
            ...(entry.modelOverrides ? { modelOverrides: entry.modelOverrides } : {}),
            ...(entry.modelInputCapabilities
              ? { modelInputCapabilities: entry.modelInputCapabilities }
              : {}),
            ...(entry.models ? { models: entry.models } : {}),
          },
          createdAt: nowIso,
        });
      }
      continue;
    }

    const secretRef = providerId;
    const hasKey = Boolean(entry?.apiKey && entry.apiKey.trim().length > 0);
    if (hasKey && entry) {
      modelSecrets[secretRef] = {
        v: 2,
        kind: "api-key",
        value: entry.apiKey,
      };
    }

    const mergedOverrides = mergeLegacyModelOverrides(
      entry?.modelOverrides,
      entry?.modelInputCapabilities,
    );
    const parsedEndpoint = tryParseUrl(endpoint);
    const isPrivate = parsedEndpoint ? isLocalOrPrivateHostname(parsedEndpoint.hostname) : false;

    connections[providerId] = {
      name: presetEntry?.preset.name ?? providerId,
      ...(presetEntry ? { presetId: providerId, presetRevision: presetEntry.revision } : {}),
      adapter,
      endpoint: endpoint.replace(/\/+$/u, ""),
      auth: { mode: "api-key", secretRef },
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
    migratedProviderIds.add(providerId);
  }

  const mapRole = (
    roleCfg: LLMRoleConfig | undefined,
  ): RoleSelection | undefined => {
    if (!roleCfg || !migratedProviderIds.has(roleCfg.provider)) return undefined;
    return {
      connectionId: roleCfg.provider,
      model: roleCfg.model,
      ...(roleCfg.thinking ? { params: { thinking: roleCfg.thinking } } : {}),
    };
  };

  const attentionPolicies: Record<string, ModelCapabilityOverride> = {};
  for (const [modelKey, policy] of Object.entries(currentConfig.modelCapabilityOverrides ?? {})) {
    attentionPolicies[normalizeModelId(modelKey)] = {
      ...(policy.optimalMaxTokens !== undefined ? { optimalMaxTokens: policy.optimalMaxTokens } : {}),
      ...(policy.riskMaxTokens !== undefined ? { riskMaxTokens: policy.riskMaxTokens } : {}),
    };
  }

  const main = mapRole(legacyLlm?.main);
  const light = mapRole(legacyLlm?.light);
  const power = mapRole(legacyLlm?.power);

  const nextLlm: LLMConfigV2 = {
    schemaVersion: 2,
    connections,
    ...(main ? { main } : {}),
    ...(light ? { light } : {}),
    ...(power ? { power } : {}),
    ...(Object.keys(attentionPolicies).length > 0 ? { attentionPolicies } : {}),
    ...(pendingItems.length > 0 ? { migrationPending: pendingItems } : {}),
  };

  const nextConfig = applyConfigPatch(
    currentConfig,
    { llm: nextLlm },
    "replace",
    { removeLegacyModelCapabilityOverrides: true },
  );

  if (validateConfigSemantics(nextConfig).length > 0) {
    return {
      status: "blocked",
      reason: "迁移结果未通过公开配置安全语义校验，已完整保留原旧配对，请经迁移修复入口处置",
    };
  }

  const nextCredentials: ZhixingCredentials = {
    version: 2,
    ...(Object.keys(modelSecrets).length > 0 ? { modelSecrets } : {}),
    ...(Object.keys(protectedLegacyProviders).length > 0 ? { protectedLegacyProviders } : {}),
    ...(fullCredentials.revokedModelSecretRefs?.length
      ? { revokedModelSecretRefs: fullCredentials.revokedModelSecretRefs }
      : {}),
    ...(fullCredentials.channels ? { channels: fullCredentials.channels } : {}),
    ...(fullCredentials.mcp ? { mcp: fullCredentials.mcp } : {}),
  };

  const existingRetirements = await readPendingModelRetirementsUnlocked(options.store);
  const edit: SavedEditV2 = {
    v: 2,
    id: randomUUID(),
    configPath,
    config: nextConfig,
    credentials: nextCredentials,
    secretUpdates: [],
    modelConfigVersion: 2,
    ...(existingRetirements.length > 0 ? { pendingModelRetirements: existingRetirements } : {}),
    removeLegacyModelCapabilityOverrides: true,
  };
  await persistAndApplySavedEdit(edit, options, "migration-v1-to-v2");

  return {
    status: "migrated",
    ...(protectedIds.length > 0 ? { protectedLegacyProviderIds: protectedIds } : {}),
    ...(pendingItems.length > 0 ? { pendingItemCount: pendingItems.length } : {}),
  };
}

/**
 * 幂等结算 `configuration/model-retirements/v1` 中的待清退秘密（设计 §5.3）：
 * - 在途调用中的连接（inFlightConnectionIds）暂不清退其普通 retire 秘密；
 * - 引用归零、保存恢复或启动恢复时自动清理不再被任何现存连接共享的逻辑凭据；
 * - 他连共用同一 logical secretRef 时保留秘密并仅移除已完成清退条目；
 * - mode === "revoke" 立即解绑并登记至 revokedModelSecretRefs，重启不复活。
 */
export async function settlePendingModelRetirements(
  options: Options & { readonly inFlightConnectionIds?: ReadonlySet<string> },
): Promise<{ readonly settled: number; readonly remaining: number }> {
  await recoverConfigurationEdit(options);
  const configPath = path.resolve(options.configPath);
  const release = await lockConfiguration(configPath, options);
  try {
    return await mutationCoordinator(options).runExclusive(() =>
      settlePendingModelRetirementsUnlocked(
        configPath,
        options,
        options.inFlightConnectionIds ?? new Set<string>(),
      ),
    );
  } finally {
    await release();
  }
}

async function settlePendingModelRetirementsUnlocked(
  configPath: string,
  options: Options,
  inFlight: ReadonlySet<string>,
): Promise<{ readonly settled: number; readonly remaining: number }> {
  assertNoConfigurationCommit(configPath);
  await assertNoConfigurationEdit(options.store);

  const pending = await readPendingModelRetirementsUnlocked(options.store);
  if (pending.length === 0) return { settled: 0, remaining: 0 };

  const currentConfig = loadConfig({ configPath, noAutoCreate: true });
  const currentCredentials = await loadCredentialsUnlocked({ store: options.store });
  const activeConnections = isLLMConfigV2(currentConfig.llm)
    ? Object.entries(currentConfig.llm.connections)
    : [];

  const remaining: PendingModelSecretRetirement[] = [];
  let settled = 0;
  const nextModelSecrets = { ...(currentCredentials.modelSecrets ?? {}) };
  const revokedSet = new Set(currentCredentials.revokedModelSecretRefs ?? []);
  let credentialsChanged = false;

  for (const item of pending) {
    if (item.mode === "retire" && inFlight.has(item.connectionId)) {
      remaining.push(item);
      continue;
    }
    const currentSecret = nextModelSecrets[item.secretRef];
    const currentSecretHash = currentSecret ? sha256Hex(currentSecret.value) : undefined;
    const secretReplacedSinceQueued = Boolean(
      item.secretHash && currentSecretHash && currentSecretHash !== item.secretHash,
    );

    if (item.mode === "revoke") {
      if (secretReplacedSinceQueued && !revokedSet.has(item.secretRef)) {
        // 撤权登记后用户已轮换写入新秘密并解除了撤销态：不删新秘密，仅结算旧撤权项
        settled += 1;
        continue;
      }
      if (item.secretRef in nextModelSecrets) {
        delete nextModelSecrets[item.secretRef];
        credentialsChanged = true;
      }
      if (!revokedSet.has(item.secretRef)) {
        revokedSet.add(item.secretRef);
        credentialsChanged = true;
      }
      settled += 1;
      continue;
    }
    // mode === "retire":
    // 只要任意当前活跃连接（含同 ID 重建连接）仍在引用该 secretRef，或秘密已被新值替换，绝不删除当前秘密
    const stillReferencedByActive = activeConnections.some(
      ([, conn]) =>
        (conn.auth.mode === "api-key" || conn.auth.mode === "header") &&
        conn.auth.secretRef === item.secretRef,
    );
    if (!stillReferencedByActive && !secretReplacedSinceQueued && item.secretRef in nextModelSecrets) {
      delete nextModelSecrets[item.secretRef];
      credentialsChanged = true;
    }
    settled += 1;
  }

  if (settled === 0) return { settled: 0, remaining: remaining.length };

  if (credentialsChanged) {
    const nextCredentials: ZhixingCredentials = {
      ...currentCredentials,
      version: 2,
      ...(Object.keys(nextModelSecrets).length > 0 ? { modelSecrets: nextModelSecrets } : {}),
      ...(revokedSet.size > 0 ? { revokedModelSecretRefs: [...revokedSet].sort() } : {}),
    };
    if (Object.keys(nextModelSecrets).length === 0) delete nextCredentials.modelSecrets;
    await commitCredentialsUnlocked(options.store, nextCredentials, { modelConfigVersion: 2 });
  }
  await writePendingModelRetirementsUnlocked(options.store, remaining);
  return { settled, remaining: remaining.length };
}

/** Recover first, optionally migrate v1→v2 and settle retirements under the same lock, then issue config and credentials from the same locked source pair. */
export async function loadConfigurationSnapshot(
  options: Options & {
    readonly autoMigrate?: boolean;
    readonly catalog?: ModelCatalogPort;
    readonly settleRetirements?: boolean;
    readonly inFlightConnectionIds?: ReadonlySet<string>;
  },
): Promise<ConfigurationSnapshotResult> {
  const recovered = await recoverConfigurationEdit(options);
  const configPath = path.resolve(options.configPath);
  const release = await lockConfiguration(configPath, options);
  try {
    return await mutationCoordinator(options).runExclusive(async () => {
      // 先完成旧遗留凭据源一次性导入，再做 v1→v2 迁移与版本失配检查
      if (options.legacyHomeDir !== undefined) {
        await loadCredentialSnapshotUnlocked(options);
      }

      let migration: ConfigurationMigrationResult | undefined;
      if (options.autoMigrate === true) {
        migration = await migrateConfigurationV1ToV2Unlocked(
          configPath,
          options,
          options.catalog ?? DEFAULT_MODEL_CATALOG_PORT,
        );
      }
      assertNoConfigurationCommit(configPath);

      const loadedConfig = loadConfig({ configPath });
      const manifestMetaPreSettle = await readManifestMetadataUnlocked(options.store);
      if (
        !migration &&
        isLLMConfigV2(loadedConfig.llm) &&
        manifestMetaPreSettle !== null &&
        manifestMetaPreSettle.modelConfigVersion !== 2
      ) {
        migration = {
          status: "mismatch",
          reason:
            "公开配置已为 v2，但设备 SecretStore 清单缺少 modelConfigVersion=2；拒绝自动覆盖，请经迁移修复入口核对",
        };
      }

      // 启动恢复或保存恢复自动幂等结算待清退项（设计 §5.3）
      const shouldSettle =
        migration?.status !== "mismatch" &&
        (options.settleRetirements === true || (recovered && options.settleRetirements !== false));
      if (shouldSettle) {
        await settlePendingModelRetirementsUnlocked(
          configPath,
          options,
          options.inFlightConnectionIds ?? new Set<string>(),
        );
      }

      const secrets = await loadCredentialSnapshotUnlocked({
        ...options,
        legacyHomeDir: undefined,
      });
      const manifestMeta = await readManifestMetadataUnlocked(options.store);
      const pendingModelRetirements = await readPendingModelRetirementsUnlocked(options.store);
      return {
        config: loadConfig({ configPath }),
        ...secrets,
        modelConfigVersion: manifestMeta?.modelConfigVersion ?? null,
        pendingModelRetirements,
        ...(recovered ? { recoveredEdit: true as const } : {}),
        ...(migration ? { migration } : {}),
      };
    });
  } finally {
    await release();
  }
}

/**
 * 由单一配对快照自身派生的规范化非秘密来源摘要（公开配置 + 秘密世代/版本/撤销元数据）。
 * 与 {@link probeConfigurationSourceDigest} 共享同一语义口径，供宿主准入对账判定“已核对/已应用来源”是否被后续保存取代。
 */
export function computeConfigurationSourceDigest(
  snapshot: Pick<ConfigurationSnapshotResult, "config" | "generation" | "modelConfigVersion" | "credentials">,
): string {
  return computePairedConfigurationDigest({
    config: snapshot.config,
    generation: snapshot.generation,
    modelConfigVersion: snapshot.modelConfigVersion,
    revokedModelSecretRefs: snapshot.credentials.revokedModelSecretRefs ?? [],
  });
}

/**
 * 与 {@link computeConfigurationSourceDigest} 同口径的轻量只读变化探测（仅作跳过提示，绝不替代快照自身的已生效来源证明）。
 * 检测到未决保存标记 `.edit.pending` 或读解析异常时返回 null，促使调用方走完整配对读取与恢复。
 */
export async function probeConfigurationSourceDigest(options: {
  readonly configPath: string;
  readonly store: SecretStorePort;
}): Promise<string | null> {
  try {
    const resolvedConfigPath = path.resolve(options.configPath);
    if (fs.existsSync(`${resolvedConfigPath}.edit.pending`)) {
      return null;
    }
    const [config, manifestMeta] = await Promise.all([
      Promise.resolve(loadConfig({ configPath: resolvedConfigPath, noAutoCreate: true })),
      readManifestMetadataUnlocked(options.store),
    ]);
    return computePairedConfigurationDigest({
      config,
      generation: manifestMeta?.generation ?? null,
      modelConfigVersion: manifestMeta?.modelConfigVersion ?? null,
      revokedModelSecretRefs: manifestMeta?.revokedModelSecretRefs ?? [],
    });
  } catch {
    return null;
  }
}

function computePairedConfigurationDigest(input: {
  readonly config: ZhixingConfig;
  readonly generation: string | null;
  readonly modelConfigVersion: 1 | 2 | null;
  readonly revokedModelSecretRefs: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      canonicalize({
        config: input.config,
        generation: input.generation,
        modelConfigVersion: input.modelConfigVersion,
        revokedModelSecretRefs: [...input.revokedModelSecretRefs].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

async function persistAndApplySavedEdit(
  edit: SavedEdit,
  options: Options,
  scope: string,
): Promise<void> {
  await options.store.put(CONFIGURATION_EDIT_REF, JSON.stringify(edit));
  // This marker is the durable acceptance point. No source has changed before it.
  try {
    await writeJsonAtomic(markerPath(edit.configPath), { id: edit.id });
  } catch (cause) {
    options.records?.record({
      event: "uncertain",
      refs: [{ kind: "configurationEdit", id: edit.id }],
      result: "unknown",
      data: { error: "配置接纳未确认" },
    });
    throw new ConfigurationEditPendingError("unknown", cause);
  }
  try {
    await applySavedEdit(edit, options.store);
  } catch (cause) {
    options.records?.record({
      event: "uncertain",
      refs: [{ kind: "configurationEdit", id: edit.id }],
      result: "unknown",
      data: { error: "配置已接纳，保存收尾未确认" },
    });
    throw new ConfigurationEditPendingError("accepted", cause);
  }
  options.records?.record(() => {
    const context = runtimeConfigurationObservation(edit.config);
    return {
      event: "saved",
      refs: [
        { kind: "configurationEdit", id: edit.id },
        { kind: "configuration", id: context.selectionDigest },
      ],
      result: "success",
      data: { scope, ...context },
    };
  });
}

/** 接续上次已接纳、收尾未完成的保存；返回这次是否真的完成了一次接续（供界面说明） */
async function recoverConfigurationEdit(options: Options): Promise<boolean> {
  const encoded = await options.store.get(CONFIGURATION_EDIT_REF);
  if (!encoded) return false;
  const observed = parseEdit(encoded);
  const release = await lockConfiguration(observed.configPath, options);
  let recovered = false;
  try {
    await mutationCoordinator(options).runExclusive(async () => {
      const current = await options.store.get(CONFIGURATION_EDIT_REF);
      if (!current) return;
      const edit = parseEdit(current);
      if (edit.id !== observed.id || edit.configPath !== observed.configPath) {
        throw new Error("配置保存已由另一编辑接续，请重试");
      }
      const marker = await readMarker(edit.configPath);
      if (!marker) {
        await syncDirectory(path.dirname(edit.configPath));
        await options.store.delete(CONFIGURATION_EDIT_REF);
        return;
      }
      if (marker.id !== edit.id) {
        throw new Error("配置恢复标识不一致，未改写配置或凭据");
      }
      await syncDirectory(path.dirname(edit.configPath));
      await applySavedEdit(edit, options.store);
      recovered = true;
      options.records?.record(() => {
        const context = runtimeConfigurationObservation(edit.config);
        return {
          event: "recovered",
          refs: [
            { kind: "configurationEdit", id: edit.id },
            { kind: "configuration", id: context.selectionDigest },
          ],
          result: "success",
          data: context,
        };
      });
    });
  } finally {
    await release();
  }
  return recovered;
}

async function applySavedEdit(edit: SavedEdit, store: SecretStorePort): Promise<void> {
  for (const update of edit.secretUpdates) await store.put(update.ref, update.value);
  if (edit.v === 2 && edit.pendingModelRetirements !== undefined) {
    await writePendingModelRetirementsUnlocked(store, edit.pendingModelRetirements);
  }
  await commitCredentialsUnlocked(
    store,
    edit.credentials,
    edit.v === 2 ? { modelConfigVersion: 2 } : undefined,
  );
  await writeConfigUnlocked(
    edit.config,
    edit.configPath,
    edit.v === 2 && edit.removeLegacyModelCapabilityOverrides
      ? { removeLegacyModelCapabilityOverrides: true }
      : undefined,
  );
  await fs.promises.unlink(markerPath(edit.configPath));
  await syncDirectory(path.dirname(edit.configPath));
  await store.delete(CONFIGURATION_EDIT_REF);
}

function markerPath(configPath: string): string {
  return `${configPath}.edit.pending`;
}

async function lockConfiguration(configPath: string, options: Options) {
  await ensureDurableDirectory(path.dirname(configPath));
  return acquireFileLock(`${configPath}.write.lock`, {
    staleMs: 30_000,
    waitMs: 5_000,
    resourceName: "Configuration",
    processIdentityResolver: options.processIdentityResolver,
  });
}

async function readMarker(configPath: string): Promise<{ id: string } | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(markerPath(configPath), "utf8")) as { id: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseEdit(encoded: string): SavedEdit {
  const edit = JSON.parse(encoded) as SavedEdit;
  if (
    (edit.v !== 1 && edit.v !== 2) ||
    typeof edit.id !== "string" ||
    !path.isAbsolute(edit.configPath) ||
    !Array.isArray(edit.secretUpdates)
  ) {
    throw new Error("配置恢复记录无效，未改写配置或凭据");
  }
  if (edit.v === 2 && edit.modelConfigVersion !== 2) {
    throw new Error("配置 v2 恢复记录缺少 modelConfigVersion=2，未改写配置或凭据");
  }
  return edit;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function mergeLegacyModelOverrides(
  budgets: ProviderCredentialEntry["modelOverrides"],
  inputs: ProviderCredentialEntry["modelInputCapabilities"],
): Record<string, ModelSpecOverride> {
  const result: Record<string, ModelSpecOverride> = {};
  for (const [modelId, budget] of Object.entries(budgets ?? {})) {
    result[modelId] = {
      ...(budget.contextWindow !== undefined ? { contextWindow: budget.contextWindow } : {}),
      ...(budget.maxOutputTokens !== undefined ? { maxOutputTokens: budget.maxOutputTokens } : {}),
    };
  }
  for (const [modelId, caps] of Object.entries(inputs ?? {})) {
    result[modelId] = {
      ...result[modelId],
      ...(caps.images !== undefined ? { supportsImages: caps.images } : {}),
    };
  }
  return result;
}
