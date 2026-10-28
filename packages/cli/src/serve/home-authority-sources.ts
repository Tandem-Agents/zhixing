import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  AuthorityCacheIntegrity,
  FileArtifactStore,
  FileAuthorityCommitLog,
  type DurableLogCheckpoint,
  type VerifiedAnchorTenure,
} from "@zhixing/core/authority";
import { ProtocolVerificationIdentityCache, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { DeviceIdentity, SecretStorePort } from "@zhixing/core/contracts";
import type { LogRecordPort } from "@zhixing/core/logging";
import type { DeviceCapacityArbiterPort, StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { bindConversationAnchorTenure } from './conversation-anchor-tenure.js';
import {
  CURRENT_TRUST_PROJECTION_ID, readCurrentTrust, readTrustIdentity, readCurrentAnchorTenure, readCurrentTrustMember,
  type CurrentTrustProjection,
} from "@zhixing/mesh/trust-chain";
import { createLiveTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import { loadAuthorityCacheIntegrity } from "./authority-cache-integrity.js";
import { artifactReadCapacity, projectionReadCapacity } from "./artifact-read-capacity.js";
import { loadExistingDeviceKey } from "./mesh-device-key.js";
import { executorIdForDevice } from "./executor-identity.js";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { createHomeAssetLifecycle, type HomeAssetLifecycle } from "./home-asset-lifecycle.js";

export interface HomeAuthoritySourcesOptions {
  readonly home: string;
  /** 写者原子取得缓存密钥；只读访问者仅可读取已经存在的密钥。 */
  readonly secretStore?: SecretStorePort;
  /** 只读：不创建权威文件、不写派生缓存、不修剪 WAL；无钥时严格核验。 */
  readonly readOnly?: boolean;
  readonly records?: LogRecordPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly deviceCapacity?: DeviceCapacityArbiterPort;
  /** 提交时间戳的时钟；同一进程内同一 home 的全部写者必须同钟。 */
  readonly clock?: () => string;
}

export interface HomeAuthoritySourcesLease {
  readonly sources: HomeAuthoritySources;
  close(): Promise<void>;
}

interface OwnerSlot {
  readonly opening: Promise<HomeAuthoritySources>;
  readonly clock: (() => string) | undefined;
  references: number;
  closing?: Promise<void>;
}
const writers = new Map<string, OwnerSlot>();

// The composition root names the finite dependencies of each ready boundary.
// Short-lived writers register all definitions but prepare only what they use.
const CORE_WRITE_REQUIRED = ["authority-retained-references"] as const;
const SHARED_REQUIRED = [...CORE_WRITE_REQUIRED, "device-lifecycle-state-v1", "control-admission-v1", "conversation-identities-v1",
  "deferred-global-intents-v1", "conversation-transfer-current-v1", "conversation-transfer-sources-v1", "resource-governor-index-v1",
  "resource-capability-activation-v1"] as const;
const AUTHORITY_REQUIRED = [CURRENT_TRUST_PROJECTION_ID, ...SHARED_REQUIRED, "credential-exposures-v1",
  "global-skill-authority-v1", "global-workscene-authority-v1", "global-rubric-authority-v1",
  "workscene-session-activity-v2", "global-schedule-authority-v1", "job-publish-pending-v1",
  "conversation-read-directory", "conversation-recovery-pending-v1", "conversation-run-state-v1", "advancement-recovery-v1",
  "surface-asset-grants", "delivery-authority-v1", "extension-current-state", "checkpoint-lifecycle-v1"] as const;
const EXECUTOR_REQUIRED = [...SHARED_REQUIRED, "conversation-recovery-pending-v1", "workspace-binding-state-v1", "workspace-probe-state-v1",
  "executor-job-interaction-obligations", "executor-assignment-ledger-v1"] as const;

/**
 * 统一的 home 权威入口。同一进程内同一 home 的可写物理日志只有一个生命周期 owner（按引用
 * 计数共享）；只读访问者各自独立、不持有跨调用的物理读视图，也不承担维护。
 */
export async function openHomeAuthoritySources(options: HomeAuthoritySourcesOptions): Promise<HomeAuthoritySourcesLease> {
  const physical = await realpath(path.resolve(options.home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return path.resolve(options.home);
    throw error;
  });
  if (options.readOnly) {
    const sources = await HomeAuthoritySources.open({ ...options, home: physical });
    let closing: Promise<void> | undefined;
    return { sources, close() { return closing ??= Promise.resolve().then(() => sources.close()); } };
  }
  const key = process.platform === "win32" ? physical.toLowerCase() : physical;
  let slot = writers.get(key);
  while (slot?.closing) {
    await slot.closing;
    slot = writers.get(key);
  }
  if (!slot) {
    slot = { opening: HomeAuthoritySources.open({ ...options, home: physical }), clock: options.clock, references: 0 };
    writers.set(key, slot);
  } else if (options.clock !== undefined && options.clock !== slot.clock) {
    throw new TypeError("Home authority writers in one process must share one commit clock");
  }
  const owned = slot;
  owned.references++;
  let sources: HomeAuthoritySources;
  try {
    sources = await owned.opening;
  } catch (error) {
    owned.references--;
    if (writers.get(key) === owned) writers.delete(key);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    sources,
    close() {
      return closing ??= (async () => {
        if (--owned.references === 0 && writers.get(key) === owned) {
          owned.closing = Promise.resolve().then(() => sources.close()).finally(() => {
            if (writers.get(key) === owned) writers.delete(key);
          });
          await owned.closing;
        }
      })();
    },
  };
}

/**
 * 两阶段装配：
 * 1. 只登记能沿信任链自校验的当前信任投影，读出当前成员与签发者，作为常驻验签身份预载；
 * 2. 再以同一个活验签器登记两本日志的全部固定领域定义（不启动任何领域运行时）。
 * 验签器保持同步；历史身份由日志在操作边界按 keyId 精确补齐（见 ProtocolVerificationIdentityCache）。
 */
export class HomeAuthoritySources {
  readonly artifacts: FileArtifactStore;
  readonly authority: FileAuthorityCommitLog;
  readonly executor: FileAuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly identities = new ProtocolVerificationIdentityCache();
  #authorityPresent = false;
  #knownAnchorTenure: VerifiedAnchorTenure | undefined;
  #trustKnown = false;
  #trustUnavailable = false;
  // 本机执行端的固定投影（按执行端身份分区，已知设备身份时在首次写入前登记）
  #executorRequired: readonly string[] = EXECUTOR_REQUIRED;
  readonly #assetLifecycle: HomeAssetLifecycle | undefined;

  private constructor(
    readonly home: string,
    readonly readOnly: boolean,
    /** 同一 home 的辅助写日志（如工作区目录代际）沿用同一缓存密钥。 */
    readonly integrity: AuthorityCacheIntegrity | undefined,
    options: HomeAuthoritySourcesOptions,
  ) {
    const root = path.join(home, "distributed-runtime");
    this.artifacts = new FileArtifactStore(path.join(root, "artifacts"),
      { runReadStep: artifactReadCapacity(options.deviceCapacity) });
    const shared = {
      integrity,
      readOnly,
      owner: !readOnly,
      records: options.records,
      storageMaintenance: options.storageMaintenance,
      runProjectionReadStep: projectionReadCapacity(options.deviceCapacity),
      ...(options.clock ? { clock: options.clock } : {}),
    };
    this.authority = new FileAuthorityCommitLog(path.join(root, "authority"), this.artifacts, shared);
    this.authority.registerAppendAdmissionGuard(entries => {
      if (entries.some(entry => entry.stream === 'trust')) this.invalidateKnownTrust();
    });
    this.executor = new FileAuthorityCommitLog(path.join(root, "executor-authority"), this.artifacts, shared);
    // 写者在首次写入前持有本 home 唯一的资产生命周期索引，两本日志的追加从此按预算核它的落后量。
    this.#assetLifecycle = readOnly ? undefined : createHomeAssetLifecycle({
      distributedRoot: root,
      authority: this.authority,
      executor: this.executor,
      artifacts: this.artifacts,
      storageMaintenance: options.storageMaintenance,
    });
    this.verifier = createLiveTrustedDeviceProtocolVerifier((keyId) => this.identities.identityFor(keyId));
    this.identities.setSourceReader(() => this.authority.sourceIdentity());
    this.identities.setResolver(async (keyId) => {
      if (!this.#authorityPresent) return undefined;
      // The source owner reuses its bound view. Cross-log reads use a zero-wait
      // fence; preparation or contention returns normal storage backpressure.
      const result = await this.authority.readPreparedProjection(CURRENT_TRUST_PROJECTION_ID,
        (view, context) => readTrustIdentity(view, keyId, context.checkpoint));
      return result?.identity;
    });
  }

  static async open(options: HomeAuthoritySourcesOptions): Promise<HomeAuthoritySources> {
    const readOnly = options.readOnly === true;
    const integrity = await loadAuthorityCacheIntegrity(options.secretStore, readOnly);
    const sources = new HomeAuthoritySources(options.home, readOnly, integrity, options);
    try {
      bindConversationAnchorTenure(sources.authority);
      sources.#authorityPresent = !readOnly || await exists(sources.authority.logPath);
      // 与 C8 运行时验签器一致，本机已有的受保护设备身份始终可验；必须在准备投影之前登记，
      // 否则升级首开的初建会把单机期本机签名的历史记录判为不受信。只读取既有密钥，不创建。
      const localKey = !readOnly && options.secretStore ? await loadExistingDeviceKey(options.secretStore) : undefined;
      // Read-only access never initializes identity or cache state; an existing
      // authenticated seal is reusable, otherwise the source is verified strictly.
      if (sources.#authorityPresent && !readOnly) {
        const current = await sources.currentTrust();
        if (current) sources.rememberCurrentTrust(current);
      }
      let localExecutorId: string | undefined;
      if (localKey) {
        const identity = enrollDeviceIdentity(localKey, {
          displayName: "local-device",
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
          enrolledAt: "1970-01-01T00:00:00.000Z",
        });
        sources.bindLocalIdentity(identity);
        localExecutorId = executorIdForDevice(identity.deviceId);
      }
      if (!readOnly) {
        await sources.#registerDefinitions(localExecutorId);
        // Core registers retention in the FileLog constructor. Every write
        // consumes it, including short management commands and unrelated streams.
        // Prepare it before any caller can enter a domain queue.
        await Promise.all([
          sources.authority.prepareProjections(CORE_WRITE_REQUIRED, "writer-ready"),
          sources.executor.prepareProjections(CORE_WRITE_REQUIRED, "writer-ready"),
        ]);
        // 资产生命周期索引在任何领域写入前追平：此后每次追加的尾部准入都有确定的覆盖位置，持有
        // 领域串行区的写者不会因为索引尚未打开而收到背压。尾部受上一个写者的准入预算约束。
        await sources.#assetLifecycle?.lifecycle.catchUp();
      }
      return sources;
    } catch (error) {
      await sources.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * 写者的固定领域定义：在首次写入前全部登记。只读访问者不写入，也不加载这些领域模块，
   * 由其消费者按需登记所读的投影。
   */
  async #registerDefinitions(localExecutorId: string | undefined): Promise<void> {
    const [core, owner, executorDefinitions, mesh, surfaceAssets, protocol, extensions, checkpoints] = await Promise.all([
      import("@zhixing/core/authority/startup-definitions"),
      import("@zhixing/owner-kernel/startup-definitions"),
      import("@zhixing/executor/startup-definitions"),
      import("@zhixing/mesh/credential-exposure"),
      import("./surface-asset-authority.js"),
      import("@zhixing/core/protocol"),
      import("@zhixing/core/extensions/application"),
      import("@zhixing/mesh/checkpoint-service"),
    ]);
    const { registerDeviceLifecycleProjection, registerSkillAuthorityProjection, registerWorksceneAuthorityProjection,
      registerRubricAuthorityProjection, registerWorksceneActivityProjection, registerWorkspaceBindingProjection,
      registerWorkspaceProbeProjection, registerResourceGovernorIndex, registerResourceCapabilityActivations,
      registerDeliveryAuthorityProjection } = core;
    const { registerControlAdmissionProjection, registerConversationIdentityProjection, registerScheduleAuthorityProjection,
      registerJobPublishPendingProjection, registerDeferredIntentProjection, registerConversationReadProjection,
      registerConversationTransferProjection, registerConversationTransferSources, registerConversationRecoveryProjection, registerConversationRunProjection,
      registerAdvancementRecoveryProjection } = owner;
    const { registerExecutorJobRecoveryProjection, registerDataPlaneTicketProjection, dataPlaneTicketProjectionId,
      registerLeaseClockProjection, leaseClockProjectionId, registerAssignmentLedgerIndex } = executorDefinitions;
    const { credentialExposureIndex } = mesh;
    const { registerSurfaceAssetProjection } = surfaceAssets;
    const { authority, executor, artifacts, verifier } = this;
    for (const log of [authority, executor]) {
      registerDeviceLifecycleProjection(log, verifier);
      registerControlAdmissionProjection(log, artifacts);
      registerConversationIdentityProjection(log, artifacts);
      registerDeferredIntentProjection(log);
      registerConversationTransferProjection(log, verifier);
      // 会话迁移冻结的领域定位索引：首次写入前登记、随写入在线维护，冻结只读该会话相关的信封
      registerConversationTransferSources(log, artifacts);
      // Global recovery discovery reads both sources before a local conversation
      // kernel is mounted. Prepare this fixed discovery index at Host.ready.
      registerConversationRecoveryProjection(log, artifacts);
      // 两本日志各有一个资源调控器：按键投影与分配能力激活在首次写入前登记，就绪前准备
      registerResourceGovernorIndex(log, verifier, protocol.RESOURCE_LEASE_MAX_TTL_MS);
      registerResourceCapabilityActivations(log);
    }
    credentialExposureIndex(authority);
    registerSkillAuthorityProjection(authority);
    registerWorksceneAuthorityProjection(authority);
    registerRubricAuthorityProjection(authority);
    registerWorksceneActivityProjection(authority);
    registerScheduleAuthorityProjection(authority, artifacts);
    registerJobPublishPendingProjection(authority);
    registerConversationReadProjection(authority, artifacts, verifier);
    registerConversationRunProjection(authority, artifacts, verifier);
    // 推进待办依赖同一前缀上的 canonical；同批登记、同页准备，首开只扫一遍历史。
    registerAdvancementRecoveryProjection(authority, artifacts);
    registerSurfaceAssetProjection(authority, artifacts, verifier);
    // 投递权威的按键投影：所有写者首次写入前登记，入队与生命周期决定都受同一恢复欠账预算约束
    registerDeliveryAuthorityProjection(authority);
    // 扩展当前状态索引：首次写入前登记、随写入在线维护；不在扩展首次被调用时才登记，免得读取时追平全部无关尾部
    extensions.registerExtensionIndex(authority);
    // checkpoint 生命周期按键投影：状态、验证、清理与追加去重都按键读，首次写入前登记、随写入在线维护
    checkpoints.registerCheckpointLifecycleIndex(authority);
    registerWorkspaceBindingProjection(executor);
    registerWorkspaceProbeProjection(executor, verifier);
    registerExecutorJobRecoveryProjection(executor, verifier);
    // 派发账本的领域索引：冷读一个派发只读它自己的行，启动恢复只遍历候选目录；首次写入前登记
    registerAssignmentLedgerIndex(executor, verifier);
    if (localExecutorId !== undefined) {
      registerDataPlaneTicketProjection(executor, verifier, localExecutorId);
      // 分派重放不再读租约时钟流：当前时钟与跨分派的时钟规则由这个投影承担，首次写入前登记
      registerLeaseClockProjection(executor, localExecutorId);
      this.#executorRequired = [...EXECUTOR_REQUIRED, dataPlaneTicketProjectionId(localExecutorId), leaseClockProjectionId(localExecutorId)];
    }
  }

  /** 只读访问者打开时 home 是否已有权威日志；写者总是 true（首次使用即建立）。 */
  authorityPresent(): boolean {
    return this.#authorityPresent;
  }

  /** 当前信任状态（只含活跃成员）；未建立信任或只读访问时日志不存在则为 undefined。 */
  async currentTrust(): Promise<CurrentTrustProjection | undefined> {
    if (!this.#authorityPresent) return undefined;
    const result = await this.authority.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID,
      async (view) => ({ kind: "return", value: { trust: await readCurrentTrust(view), tenure: await readCurrentAnchorTenure(view) } }));
    const source = this.authority.sourceIdentity();
    if (source) this.identities.bindSource(source);
    if (result.value.trust) this.rememberCurrentTrust(result.value.trust);
    this.#rememberAnchorTenure(result.value.tenure);
    return result.value.trust;
  }

  knownAnchorTenure(): VerifiedAnchorTenure | undefined { return this.#trustUnavailable ? undefined : this.#knownAnchorTenure; }
  knowsTrustDomain(): boolean { return this.#trustKnown; }
  invalidateKnownTrust(): void { this.#trustKnown = true; this.#trustUnavailable = true; }
  #rememberAnchorTenure(tenure: VerifiedAnchorTenure | undefined): void {
    const previous = this.#knownAnchorTenure;
    if (previous && (!tenure || tenure.homeId !== previous.homeId || tenure.anchorEpoch < previous.anchorEpoch ||
        tenure.chainHead.seq < previous.chainHead.seq || tenure.anchorEpoch === previous.anchorEpoch && tenure.deviceId !== previous.deviceId)) {
      this.invalidateKnownTrust(); throw new Error('Verified trust tenure regressed or changed its home');
    }
    this.#knownAnchorTenure = tenure; this.#trustUnavailable = false;
    if (tenure) this.#trustKnown = true;
  }

  async currentAnchorAuthorization(deviceId: string) {
    const result = await this.authority.transactDurableProjection(CURRENT_TRUST_PROJECTION_ID, async view => ({
      kind: 'return' as const, value: { tenure: await readCurrentAnchorTenure(view), member: await readCurrentTrustMember(view, deviceId) },
    }));
    this.#rememberAnchorTenure(result.value.tenure);
    return result.value;
  }

  /** Live identities are resident; former members move to the bounded historical cache. */
  rememberCurrentTrust(trust: Pick<CurrentTrustProjection, "issuer" | "members">): void {
    const live = trust.members.filter(member => member.state === "active").map(member => member.device);
    if (trust.issuer.issuerPublicKey) {
      const issuer = trust.members.find((member) => member.device.deviceId === trust.issuer.deviceId);
      if (!issuer) throw new Error("Current issuer is missing from the trust projection");
      live.push({ ...issuer.device, deviceId: trust.issuer.issuerKeyId, publicKey: trust.issuer.issuerPublicKey });
    }
    this.identities.replaceResidents(live);
  }

  /** 本机受保护身份，在调用方既有的身份/生命周期检查之后登记；与 C8 一样始终可验本机签名。 */
  bindLocalIdentity(identity: DeviceIdentity): void {
    this.identities.rememberProtected(identity);
  }

  prepareRuntime(boundary: "runtime-prepare" | "host-ready" | "terminal-usable", executorOnly = false) {
    return Promise.all([
      this.authority.prepareProjections(executorOnly ? [CURRENT_TRUST_PROJECTION_ID, ...SHARED_REQUIRED,
        "credential-exposures-v1"] : AUTHORITY_REQUIRED, boundary),
      this.executor.prepareProjections(this.#executorRequired, boundary),
    ]);
  }

  /** 两本日志当前已验位置，供就绪边界记录水位。 */
  async checkpoints(): Promise<readonly DurableLogCheckpoint[]> {
    return Promise.all([this.authority.checkpoint(), this.executor.checkpoint()]);
  }

  /** 本 home 唯一的资产生命周期索引；资产权威与检查点保留共用，只读访问者没有。 */
  assetLifecycle(): HomeAssetLifecycle {
    if (!this.#assetLifecycle) throw new TypeError("Read-only home authority access has no asset lifecycle");
    return this.#assetLifecycle;
  }

  async close(): Promise<void> {
    // 派生索引先停：它的维护读日志尾部，日志停在它之后。
    const lifecycle = await Promise.allSettled([this.#assetLifecycle?.close()]);
    const logs = await Promise.allSettled([this.authority.stopStorageMaintenance(), this.executor.stopStorageMaintenance()]);
    const failures = [...lifecycle, ...logs].flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Home authority sources failed to close");
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
