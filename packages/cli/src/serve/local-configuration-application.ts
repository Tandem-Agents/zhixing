/** Local Configuration owns the read policy; startup/terminal adapters receive
 * one application snapshot and do not compose Authority or exposure rules. */
import { createHash } from "node:crypto";
import { canonicalize } from "@zhixing-ai/core/protocol/canonical";
import {
  computeConfigurationSourceDigest,
  loadConfigurationSnapshot,
  editConfiguration,
  probeConfigurationSourceDigest,
  settlePendingModelRetirements,
  type ConfigurationSnapshotResult,
  type CredentialStoreCoordinator,
  type ZhixingConfig,
} from "@zhixing-ai/providers/configuration";
import type { SecretStorePort } from "@zhixing-ai/core/contracts";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import {
  projectRuntimeConfiguration,
  type RuntimeAuthorityConfigurationProjection,
} from "../runtime/runtime-configuration-projections.js";
import {
  projectRuntimeSecrets,
  type RuntimeSecretProjections,
} from "../runtime/runtime-secret-projections.js";
import {
  type ModelRuntimePort,
  type ModelRuntimeUpdateResult,
} from "../runtime/model-runtime-port.js";

export interface LocalConfigurationPort {
  read(options?: {
    readonly autoMigrate?: boolean;
    readonly settleRetirements?: boolean;
    readonly inFlightConnectionIds?: ReadonlySet<string>;
  }): ReturnType<typeof loadConfigurationSnapshot>;
  edit(
    base: Parameters<typeof editConfiguration>[0],
    edit: Parameters<typeof editConfiguration>[1],
    options?: Pick<
      Parameters<typeof editConfiguration>[2],
      "scope" | "prepare" | "modelRetirements" | "removeLegacyModelCapabilityOverrides" | "forceModelConfigVersion2"
    >,
  ): ReturnType<typeof editConfiguration>;
}

export function createLocalConfigurationApplication(options: {
  readonly homeDir: string;
  readonly configPath: string;
  readonly store: SecretStorePort & CredentialStoreCoordinator;
  readonly records?: import("@zhixing-ai/core/logging").LogRecordPort;
  readonly processIdentityResolver?: import("@zhixing-ai/core/persistence").FileLockOptions["processIdentityResolver"];
}): LocalConfigurationPort {
  return {
    edit: (base, edit, policy) => editConfiguration(base, edit, {
      ...policy, configPath: options.configPath, store: options.store, records: options.records,
      processIdentityResolver: options.processIdentityResolver,
    }),
    async read(readOptions) {
      // Prepare the read-only safety view before Configuration takes its own
      // publication lock. Every call observes fresh trust and closes its lease.
      const owner = await FileMeshBootstrapStore.open(options.homeDir, undefined, { readOnly: true, secretStore: options.store });
      try {
        const trust = await owner.loadCurrentTrust();
        const refs = trust ? await options.store.list("device-key/device/v1/") : [];
        const deviceId = refs.length === 1 ? refs[0]!.bindingId.slice("device/v1/".length) : undefined;
        const guarded = deviceId && trust?.members.some(member => member.device.deviceId === deviceId && member.state === "active");
        const exposure = guarded ? new CredentialExposureAuthority({ deviceId: deviceId!, log: owner.authorityLog(), secretStore: options.store }) : undefined;
        return await loadConfigurationSnapshot({
          configPath: options.configPath, store: options.store, records: options.records,
          processIdentityResolver: options.processIdentityResolver, legacyHomeDir: options.homeDir,
          ...(readOptions?.autoMigrate ? { autoMigrate: true } : {}),
          ...(readOptions?.settleRetirements !== undefined ? { settleRetirements: readOptions.settleRetirements } : {}),
          ...(readOptions?.inFlightConnectionIds ? { inFlightConnectionIds: readOptions.inFlightConnectionIds } : {}),
          ...(exposure ? { authorizeCredentialRead: async ({ kind, id }: { kind: "provider" | "channel" | "mcp"; id: string }) => {
            try { await exposure.assertConfigurationRoute(kind, id); return true; }
            catch { return false; }
          } } : {}),
        });
      } finally { await owner.stopStorageMaintenance(); }
    },
  };
}

/**
 * 宿主侧统一模型窄生效执行器：
 * - 从本地配置与 SecretStore 重读权威快照（遵守 CredentialExposureAuthority 封禁读策略）；
 * - 结合当前在途连接集合幂等结算待清退秘密；
 * - 经 ModelRuntimePort 预检并原子换代（失败不切、保留旧可用运行态）；
 * - 成功后触发执行器就绪快照重发布。
 */
export interface ReloadHostModelRuntimeAppliedContext {
  readonly credentialRotationConfiguration: ReturnType<typeof projectRuntimeConfiguration>["credentialRotation"];
  readonly credentialRotationCredentials: ReturnType<typeof projectRuntimeSecrets>["credentialRotationCredentials"];
  readonly credentialGeneration: string | null;
}

export interface HostModelRotationPublicationContext {
  readonly credentialRotationConfiguration: ReturnType<typeof projectRuntimeConfiguration>["credentialRotation"];
  readonly credentialGeneration: string | null;
}

export async function reloadHostModelRuntimePort(options: {
  readonly homeDir: string;
  readonly configPath: string;
  readonly store: SecretStorePort & CredentialStoreCoordinator;
  readonly modelRuntimePort: ModelRuntimePort;
  readonly operationId?: string;
  readonly revokedSecretRefs?: readonly string[];
  readonly abortConnectionIds?: readonly string[];
  /** 仅执行安全撤权/连接停用，不热应用任何候选模型配置（供混合编辑整机换代前先行止血使用）。 */
  readonly revokeOnly?: boolean;
  /** 显式控制首次读取是否自动迁移（默认 true；磁盘对账器传 false 防止被拒混合编辑触发副作用迁移）。 */
  readonly autoMigrate?: boolean;
  /** 核对快照内新增撤权/封禁/移除活跃密钥并无条件先行止血（供磁盘对账路径使用）。 */
  readonly enforceDiskRevocations?: boolean;
  /**
   * 针对同一已读配对快照执行混合非模型变更裁决：返回 true 时拒绝半应用模型候选，
   * 并在每次内部重读（publishRotations / settlePendingModelRetirements）后再次校验，
   * 杜绝按旧“纯模型”判断去应用新混合配对。
   */
  readonly rejectNonModelChange?: (snapshot: ConfigurationSnapshotResult) => boolean;
  /** 在 exposure 过滤读之前尝试验证并发布待轮换的封禁凭据，打破 compromised 基线死锁（设计 §5.3）。 */
  readonly publishRotations?: (ctx: HostModelRotationPublicationContext) => Promise<void>;
  readonly onApplied?: (ctx: ReloadHostModelRuntimeAppliedContext) => Promise<{ readonly rotationWarning?: string } | void>;
  readonly onSecurityRevoked?: () => Promise<void>;
  /**
   * 仅在候选配对快照确认生效（且与活口 revision 一致）时回传**该快照自身**派生的规范化来源摘要，
   * 绝不使用任何独立读盘样本（读前或读后），彻底消除 A→B→A 与 onApplied 窗口吞保存。
   */
  readonly onAppliedSourceDigest?: (digest: string) => void;
  /** 当同一配对快照因非模型混合变更被拒时，回传该被拒快照自身派生的来源摘要。 */
  readonly onRejectedNonModelSourceDigest?: (digest: string) => void;
  /** 当同一配对快照在 applyUpdate 阶段预检失败时，回传该失败快照自身派生的来源摘要。 */
  readonly onFailedCandidateSourceDigest?: (digest: string) => void;
}): Promise<ModelRuntimeUpdateResult & { readonly rotationWarning?: string }> {
  const localConfig = createLocalConfigurationApplication({
    homeDir: options.homeDir,
    configPath: options.configPath,
    store: options.store,
  });

  if (options.revokeOnly) {
    let diskRevoked: readonly string[] = [];
    let diskCompromised: Readonly<Record<string, string>> | undefined;
    try {
      const snap = await localConfig.read({ settleRetirements: false });
      diskRevoked = snap.credentials.revokedModelSecretRefs ?? [];
      diskCompromised = snap.credentials.compromisedModelSecretTokens;
    } catch {
      // 读取失败不阻断显式撤权参数执行
    }
    const mergedRevoked = [
      ...new Set([...(options.revokedSecretRefs ?? []), ...diskRevoked]),
    ];
    const revoked = await options.modelRuntimePort.enforceRevocations({
      ...(mergedRevoked.length > 0 ? { revokedSecretRefs: mergedRevoked } : {}),
      ...(options.abortConnectionIds?.length ? { abortConnectionIds: options.abortConnectionIds } : {}),
      ...(diskCompromised && Object.keys(diskCompromised).length > 0
        ? { compromisedModelSecretTokens: diskCompromised }
        : {}),
    });
    if (
      revoked.abortedCalls > 0 ||
      mergedRevoked.length > 0 ||
      Boolean(options.abortConnectionIds?.length)
    ) {
      await options.onSecurityRevoked?.().catch(() => {});
    }
    return {
      applied: true,
      revision: revoked.revision,
      abortedCalls: revoked.abortedCalls,
    };
  }

  const enforceSnapshotRevocations = async (
    snap: ConfigurationSnapshotResult,
  ): Promise<number> => {
    if (!options.enforceDiskRevocations) return 0;
    const currentPortCreds = options.modelRuntimePort.snapshot().providerCredentials;
    const currentRevoked = new Set(currentPortCreds.revokedModelSecretRefs ?? []);
    const currentCompromised = currentPortCreds.compromisedModelSecretTokens ?? {};
    const currentActiveSecretKeys = new Set(Object.keys(currentPortCreds.modelSecrets ?? {}));
    const diskRevoked = snap.credentials.revokedModelSecretRefs ?? [];
    const diskCompromised = snap.credentials.compromisedModelSecretTokens ?? {};
    const removedActiveSecretRefs = Object.entries(currentPortCreds.modelSecrets ?? {})
      .filter(([, entry]) => Boolean(entry?.value?.trim()))
      .map(([ref]) => ref)
      .filter((ref) => !(snap.credentials.modelSecrets?.[ref]?.value?.trim()));
    const newlyRevoked = [
      ...new Set([
        ...diskRevoked.filter(
          (ref) => !currentRevoked.has(ref) || currentActiveSecretKeys.has(ref),
        ),
        ...removedActiveSecretRefs,
      ]),
    ];
    const newlyCompromisedEntries = Object.entries(diskCompromised).filter(
      ([ref, token]) => currentCompromised[ref] !== token || currentActiveSecretKeys.has(ref),
    );
    if (newlyRevoked.length === 0 && newlyCompromisedEntries.length === 0) return 0;
    const enforced = await options.modelRuntimePort.enforceRevocations({
      ...(newlyRevoked.length > 0 ? { revokedSecretRefs: newlyRevoked } : {}),
      ...(newlyCompromisedEntries.length > 0
        ? { compromisedModelSecretTokens: Object.fromEntries(newlyCompromisedEntries) }
        : {}),
    });
    await options.onSecurityRevoked?.().catch(() => {});
    return enforced.abortedCalls;
  };

  let totalRevocationAbortedCalls = 0;

  const validateCandidateSnapshot = async (
    snap: ConfigurationSnapshotResult,
    allowExplicitRevocationOnMismatch: boolean,
  ): Promise<(ModelRuntimeUpdateResult & { readonly rotationWarning?: string }) | null> => {
    // R2-D / F8：热激活与冷启动采用一致 fail-closed 契约——严禁将 v2+v1 manifest 失配作为新运行或轮换来源。
    if (snap.migration?.status === "mismatch") {
      if (allowExplicitRevocationOnMismatch) {
        const revoked = await options.modelRuntimePort.enforceRevocations({
          ...(options.revokedSecretRefs?.length ? { revokedSecretRefs: options.revokedSecretRefs } : {}),
          ...(options.abortConnectionIds?.length ? { abortConnectionIds: options.abortConnectionIds } : {}),
        });
        if (
          revoked.abortedCalls > 0 ||
          Boolean(options.revokedSecretRefs?.length) ||
          Boolean(options.abortConnectionIds?.length)
        ) {
          await options.onSecurityRevoked?.().catch(() => {});
        }
        return {
          applied: false,
          revision: revoked.revision,
          abortedCalls: totalRevocationAbortedCalls + revoked.abortedCalls,
          reason:
            "检测到 v2 模型配置与旧版 SecretStore 清单失配（缺少 modelConfigVersion=2），已拒绝热生效；请先执行配置修复确认迁移。",
        };
      }
      return {
        applied: false,
        revision: options.modelRuntimePort.snapshot().revision,
        abortedCalls: totalRevocationAbortedCalls,
        reason:
          "检测到 v2 模型配置与旧版 SecretStore 清单失配（缺少 modelConfigVersion=2），已拒绝热生效；请先执行配置修复确认迁移。",
      };
    }

    // R2-A1：安全撤权/封禁优先于混合编辑裁决无条件立即生效，杜绝“混合保存 + 漏通知”继续用旧 Authorization 发请求。
    const abortedByDiskRevocation = await enforceSnapshotRevocations(snap);
    totalRevocationAbortedCalls += abortedByDiskRevocation;

    // R2-A2 + R5 + R6：混合裁决严格作用于即将应用的同一份配对快照（自动对账与显式激活同源），绝不按旧纯模型判定去应用新混合配对。
    if (options.rejectNonModelChange?.(snap)) {
      if (options.revokedSecretRefs?.length || options.abortConnectionIds?.length) {
        const explicitRevoked = await options.modelRuntimePort.enforceRevocations({
          ...(options.revokedSecretRefs?.length ? { revokedSecretRefs: options.revokedSecretRefs } : {}),
          ...(options.abortConnectionIds?.length ? { abortConnectionIds: options.abortConnectionIds } : {}),
        });
        totalRevocationAbortedCalls += explicitRevoked.abortedCalls;
        await options.onSecurityRevoked?.().catch(() => {});
      }
      options.onRejectedNonModelSourceDigest?.(computeConfigurationSourceDigest(snap));
      return {
        applied: false,
        revision: options.modelRuntimePort.snapshot().revision,
        abortedCalls: totalRevocationAbortedCalls,
        reason: "检测到非模型配置或凭据混合变更，保留给完整宿主换代统一承接。",
      };
    }

    return null;
  };

  let snapshot = await localConfig.read({
    autoMigrate: options.autoMigrate ?? true,
    settleRetirements: false,
  });
  let rotationWarning: string | undefined;

  const initialReject = await validateCandidateSnapshot(snapshot, true);
  if (initialReject) return initialReject;

  // 若存在待轮换发布钩子，在 exposure 过滤后的 applyUpdate 前先执行轮换验证并发布，
  // 避免被标记为 compromised 的新密钥在 applyUpdate 预检时被过滤而死锁。
  if (options.publishRotations) {
    const preProjected = projectRuntimeConfiguration(snapshot.config);
    try {
      await options.publishRotations({
        credentialRotationConfiguration: preProjected.credentialRotation,
        credentialGeneration: snapshot.generation,
      });
      snapshot = await localConfig.read({ settleRetirements: false });
    } catch (error) {
      rotationWarning = error instanceof Error ? error.message : String(error);
    }
    const postRotationReject = await validateCandidateSnapshot(snapshot, false);
    if (postRotationReject) {
      return rotationWarning
        ? { ...postRotationReject, rotationWarning }
        : postRotationReject;
    }
  }

  const retirement = await settlePendingModelRetirements({
    configPath: options.configPath,
    store: options.store,
    inFlightConnectionIds: options.modelRuntimePort.inFlightConnectionIds(),
  });
  if (retirement.settled > 0) {
    snapshot = await localConfig.read({ settleRetirements: false });
    const postSettleReject = await validateCandidateSnapshot(snapshot, false);
    if (postSettleReject) {
      return rotationWarning
        ? { ...postSettleReject, rotationWarning }
        : postSettleReject;
    }
  }

  const projectedConfig = projectRuntimeConfiguration(snapshot.config);
  const projectedSecrets = projectRuntimeSecrets(snapshot.credentials);
  const candidateSourceDigest = computeConfigurationSourceDigest(snapshot);
  const result = await options.modelRuntimePort.applyUpdate({
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.revokedSecretRefs ? { revokedSecretRefs: options.revokedSecretRefs } : {}),
    ...(options.abortConnectionIds ? { abortConnectionIds: options.abortConnectionIds } : {}),
    modelConfiguration: projectedConfig.model,
    advancementConfiguration: projectedConfig.advancement,
    providerCredentials: projectedSecrets.providerCredentials,
    exposureCredentials: projectedSecrets.credentialExposureCredentials,
    credentialGeneration: snapshot.generation,
  });
  const candidateRevision = options.modelRuntimePort.computeCandidateRevision({
    modelConfiguration: projectedConfig.model,
    providerCredentials: projectedSecrets.providerCredentials,
    credentialGeneration: snapshot.generation,
  });
  if (result.applied && options.modelRuntimePort.snapshot().revision === candidateRevision) {
    options.onAppliedSourceDigest?.(candidateSourceDigest);
  } else if (!result.applied) {
    options.onFailedCandidateSourceDigest?.(candidateSourceDigest);
  }
  if (result.applied && !result.deduplicated) {
    const appliedFeedback = await options.onApplied?.({
      credentialRotationConfiguration: projectedConfig.credentialRotation,
      credentialRotationCredentials: projectedSecrets.credentialRotationCredentials,
      credentialGeneration: snapshot.generation,
    });
    if (!rotationWarning && appliedFeedback?.rotationWarning) {
      rotationWarning = appliedFeedback.rotationWarning;
    }
  }
  const finalResult =
    totalRevocationAbortedCalls > 0
      ? { ...result, abortedCalls: (result.abortedCalls ?? 0) + totalRevocationAbortedCalls }
      : result;
  return rotationWarning ? { ...finalResult, rotationWarning } : finalResult;
}

export interface HostExplicitModelActivationInput {
  readonly operationId?: string;
  readonly revokedSecretRefs?: readonly string[];
  readonly abortConnectionIds?: readonly string[];
  readonly revokeOnly?: boolean;
}

export interface HostModelDiskReconciler {
  captureBaseline(): Promise<void>;
  reconcileFromDisk(): Promise<void>;
  markSynced(appliedSourceDigest?: string): Promise<void>;
  /**
   * 宿主显式模型激活统一入口（与自动准入对账共享同一非模型基线、撤权优先与来源摘要语义）：
   * 即使通知方此前按纯模型发出通知，在盘上已被并发混合编辑取代时仍先止血撤权再拒绝半应用。
   */
  applyExplicitActivation(
    input: HostExplicitModelActivationInput,
  ): Promise<ModelRuntimeUpdateResult & { readonly rotationWarning?: string }>;
}

/**
 * 新模型准入前本机磁盘修订对账器（设计 §5.2 / §5.3）：
 * - 任何已接纳的安全撤权/封禁（revokedModelSecretRefs / compromisedModelSecretTokens）
 *   优先无条件生效（禁新 + abort + 剥离快照），不受混合非模型修改延迟；
 * - 当磁盘与 SecretStore 出现 v2+v1 manifest 失配（migration.status === "mismatch"）时严格拒绝；
 * - 若磁盘包含非模型配置（network / workspace / mesh / mcp / agent 等）或非模型凭据（如 mcp 凭据）
 *   的混合变更，绝不半应用模型窄生效，保留给完整宿主换代裁决；
 * - 纯模型域变更在通知缺席后可幂等补应用。
 */
export function createHostModelDiskReconciler(options: {
  readonly homeDir: string;
  readonly configPath: string;
  readonly store: SecretStorePort & CredentialStoreCoordinator;
  readonly modelRuntimePort: ModelRuntimePort;
  readonly initialAuthorityConfiguration?: RuntimeAuthorityConfigurationProjection;
  readonly initialMcpCredentials?: RuntimeSecretProjections["mcpCredentials"];
  readonly publishRotations?: (ctx: HostModelRotationPublicationContext) => Promise<void>;
  readonly onApplied?: (ctx: ReloadHostModelRuntimeAppliedContext) => Promise<{ readonly rotationWarning?: string } | void>;
  readonly onSecurityRevoked?: () => Promise<void>;
}): HostModelDiskReconciler {
  type SnapshotCredentials = ConfigurationSnapshotResult["credentials"];
  const UNSYNCED_BASELINE_DIGEST = "\u0000unsynced-from-live-port";
  let baselineNonModelConfigDigest: string | undefined;
  let baselineNonModelCredentialsDigest: string | undefined;
  let lastSyncedSourceDigest: string | undefined;

  const nonModelConfigDigest = (
    config: ZhixingConfig | RuntimeAuthorityConfigurationProjection,
  ): string => {
    const nonModel: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (
        value === undefined ||
        key === "messaging" ||
        key === "llm" ||
        key === "modelCapabilityOverrides"
      ) {
        continue;
      }
      nonModel[key] = value;
    }
    return canonicalize(nonModel);
  };

  // 与 configuration-application.ts 的非模型凭据裁决同源：只保留非模型/非通道凭据（如 mcp）的 SHA-256 摘要，不驻留明文秘密。
  const nonModelCredentialsDigest = (
    credentials: SnapshotCredentials | RuntimeSecretProjections["mcpCredentials"],
  ): string => {
    const nonModelCredentials: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(credentials)) {
      if (
        value === undefined ||
        key === "channels" ||
        key === "version" ||
        key === "providers" ||
        key === "modelSecrets" ||
        key === "protectedLegacyProviders" ||
        key === "revokedModelSecretRefs" ||
        key === "compromisedModelSecretTokens"
      ) {
        continue;
      }
      nonModelCredentials[key] = value;
    }
    return createHash("sha256")
      .update(canonicalize(nonModelCredentials), "utf8")
      .digest("hex");
  };

  const isMixedNonModelChange = (snap: ConfigurationSnapshotResult): boolean => {
    const diskNonModelConfig = nonModelConfigDigest(snap.config);
    const diskNonModelCredentials = nonModelCredentialsDigest(snap.credentials);
    const networkChanged =
      canonicalize(options.modelRuntimePort.snapshot().modelConfiguration.network ?? null) !==
      canonicalize(snap.config.network ?? null);
    const nonModelConfigChanged =
      networkChanged ||
      (baselineNonModelConfigDigest !== undefined &&
        diskNonModelConfig !== baselineNonModelConfigDigest);
    const nonModelCredentialsChanged =
      baselineNonModelCredentialsDigest !== undefined &&
      diskNonModelCredentials !== baselineNonModelCredentialsDigest;
    return nonModelConfigChanged || nonModelCredentialsChanged;
  };

  const localConfig = createLocalConfigurationApplication({
    homeDir: options.homeDir,
    configPath: options.configPath,
    store: options.store,
  });

  const verifySnapshotSyncAgainstLivePort = async (
    initializeNonModelBaseline: boolean,
  ): Promise<string> => {
    if (initializeNonModelBaseline) {
      baselineNonModelConfigDigest = options.initialAuthorityConfiguration
        ? nonModelConfigDigest(options.initialAuthorityConfiguration)
        : undefined;
      baselineNonModelCredentialsDigest = options.initialMcpCredentials
        ? nonModelCredentialsDigest(options.initialMcpCredentials)
        : undefined;
    }
    try {
      // 同步摘要严格由配对读取得到的 snap 自身派生，不做二次读盘采样，杜绝观测与生效来源分裂。
      const snap = await localConfig.read({ settleRetirements: false });
      if (baselineNonModelConfigDigest === undefined) {
        baselineNonModelConfigDigest = nonModelConfigDigest(snap.config);
      }
      if (baselineNonModelCredentialsDigest === undefined) {
        baselineNonModelCredentialsDigest = nonModelCredentialsDigest(snap.credentials);
      }
      if (snap.migration?.status === "mismatch") {
        return UNSYNCED_BASELINE_DIGEST;
      }
      const projectedConfig = projectRuntimeConfiguration(snap.config);
      const projectedSecrets = projectRuntimeSecrets(snap.credentials);
      const diskModelRevision = options.modelRuntimePort.computeCandidateRevision({
        modelConfiguration: projectedConfig.model,
        providerCredentials: projectedSecrets.providerCredentials,
        credentialGeneration: snap.generation,
      });
      const liveSnapshot = options.modelRuntimePort.snapshot();
      const matches =
        diskModelRevision === liveSnapshot.revision &&
        !isMixedNonModelChange(snap);
      return matches ? computeConfigurationSourceDigest(snap) : UNSYNCED_BASELINE_DIGEST;
    } catch {
      return UNSYNCED_BASELINE_DIGEST;
    }
  };

  const captureBaseline = async (): Promise<void> => {
    lastSyncedSourceDigest = await verifySnapshotSyncAgainstLivePort(true);
  };

  const markSynced = async (appliedSourceDigest?: string): Promise<void> => {
    if (appliedSourceDigest !== undefined) {
      lastSyncedSourceDigest = appliedSourceDigest;
      return;
    }
    lastSyncedSourceDigest = await verifySnapshotSyncAgainstLivePort(false);
  };

  const reconcileFromDisk = async (): Promise<void> => {
    if (lastSyncedSourceDigest === undefined) {
      await captureBaseline();
      if (lastSyncedSourceDigest !== UNSYNCED_BASELINE_DIGEST) {
        return;
      }
    }
    // 轻量快路径仅作跳过提示，绝不写入 lastSyncedSourceDigest；与 computeSnapshotSourceDigest 共用同一语义口径。
    const currentProbeDigest = await probeConfigurationSourceDigest({
      configPath: options.configPath,
      store: options.store,
    });
    if (currentProbeDigest !== null && currentProbeDigest === lastSyncedSourceDigest) {
      return;
    }

    // 单一配对快照贯通：失配拒收 → 撤权优先 → 混合非模型裁决 → 热激活，全部作用于同一 snapshot，
    // 且仅将该实际处理快照自身的规范化来源摘要写回 lastSyncedSourceDigest。
    let resolvedSourceDigest: string | undefined;
    try {
      await reloadHostModelRuntimePort({
        homeDir: options.homeDir,
        configPath: options.configPath,
        store: options.store,
        modelRuntimePort: options.modelRuntimePort,
        autoMigrate: false,
        enforceDiskRevocations: true,
        rejectNonModelChange: isMixedNonModelChange,
        ...(options.publishRotations ? { publishRotations: options.publishRotations } : {}),
        ...(options.onApplied ? { onApplied: options.onApplied } : {}),
        ...(options.onSecurityRevoked ? { onSecurityRevoked: options.onSecurityRevoked } : {}),
        onAppliedSourceDigest: (digest) => {
          resolvedSourceDigest = digest;
        },
        onRejectedNonModelSourceDigest: (digest) => {
          resolvedSourceDigest = digest;
        },
        onFailedCandidateSourceDigest: (digest) => {
          resolvedSourceDigest = digest;
        },
      });
    } catch {
      return;
    }
    if (resolvedSourceDigest !== undefined) {
      lastSyncedSourceDigest = resolvedSourceDigest;
    }
  };

  const applyExplicitActivation = async (
    input: HostExplicitModelActivationInput,
  ): Promise<ModelRuntimeUpdateResult & { readonly rotationWarning?: string }> => {
    if (baselineNonModelConfigDigest === undefined && options.initialAuthorityConfiguration) {
      baselineNonModelConfigDigest = nonModelConfigDigest(options.initialAuthorityConfiguration);
    }
    if (baselineNonModelCredentialsDigest === undefined && options.initialMcpCredentials) {
      baselineNonModelCredentialsDigest = nonModelCredentialsDigest(options.initialMcpCredentials);
    }
    let resolvedSourceDigest: string | undefined;
    const result = await reloadHostModelRuntimePort({
      homeDir: options.homeDir,
      configPath: options.configPath,
      store: options.store,
      modelRuntimePort: options.modelRuntimePort,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.revokedSecretRefs ? { revokedSecretRefs: input.revokedSecretRefs } : {}),
      ...(input.abortConnectionIds ? { abortConnectionIds: input.abortConnectionIds } : {}),
      ...(input.revokeOnly ? { revokeOnly: input.revokeOnly } : {}),
      autoMigrate: false,
      enforceDiskRevocations: !input.revokeOnly,
      ...(!input.revokeOnly ? { rejectNonModelChange: isMixedNonModelChange } : {}),
      ...(options.publishRotations ? { publishRotations: options.publishRotations } : {}),
      ...(options.onApplied ? { onApplied: options.onApplied } : {}),
      ...(options.onSecurityRevoked ? { onSecurityRevoked: options.onSecurityRevoked } : {}),
      ...(!input.revokeOnly
        ? {
            onAppliedSourceDigest: (digest: string) => {
              resolvedSourceDigest = digest;
            },
            onRejectedNonModelSourceDigest: (digest: string) => {
              resolvedSourceDigest = digest;
            },
            onFailedCandidateSourceDigest: (digest: string) => {
              resolvedSourceDigest = digest;
            },
          }
        : {}),
    });
    if (!input.revokeOnly && resolvedSourceDigest !== undefined) {
      lastSyncedSourceDigest = resolvedSourceDigest;
    }
    return result;
  };

  return { captureBaseline, reconcileFromDisk, markSynced, applyExplicitActivation };
}

/** 宿主侧按当前活跃/在途租约集合幂等结算待清退模型秘密（供引用归零钩子调用，设计 §5.3）。 */
export async function settleHostPendingModelRetirements(options: {
  readonly configPath: string;
  readonly store: SecretStorePort & CredentialStoreCoordinator;
  readonly modelRuntimePort: ModelRuntimePort;
}): Promise<{ readonly settled: number; readonly remaining: number }> {
  return settlePendingModelRetirements({
    configPath: options.configPath,
    store: options.store,
    inFlightConnectionIds: options.modelRuntimePort.inFlightConnectionIds(),
  });
}
