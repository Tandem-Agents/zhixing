import { hostname, platform } from "node:os";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core";
import {
  BackupRecoveryAdministrationApplicationService,
  BackupRecoveryAdministrationError,
  type BackupRecoveryAdministrationSetupResult,
  type BackupRecoveryAdministrationStatus,
  type BackupRecoveryAdministrationTargetBinding,
  BackupRecoveryRootLifecycleApplicationService,
  BackupRecoveryRootLifecycleError,
  type BackupRecoveryRootActivationPlan,
  type BackupRecoveryRootLifecycleContext,
} from "@zhixing/core/backup-recovery/application";
import type {
  DeviceIdentity,
  HomeTrustEvent,
  HomeTrustEventWithBody,
  HomeTrustRecord,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { canonicalize } from "@zhixing/core/protocol";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { loadConfig } from "@zhixing/providers";
import { RecoveryActivationCoordinator } from "@zhixing/mesh/bootstrap-authority";
import {
  createCheckpointId,
  type CheckpointPackage,
  type CheckpointSigner,
} from "@zhixing/mesh/checkpoint";
import { AuthorityCheckpointService } from "@zhixing/mesh/checkpoint-service";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import {
  decodeRecoveryPackage,
  encodeRecoveryPackage,
  requireCurrentRecoveryPackage,
} from "@zhixing/mesh/recovery-package";
import { enrollDeviceIdentity, type DeviceKey } from "@zhixing/mesh/device-identity";
import {
  activateAnchorIssuerKey,
  loadActiveAnchorIssuerKey,
  loadDeviceKey,
  persistAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import { RecoveryRoot, keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  MeshPairedCheckpointTransport,
  PairedRecoveryCheckpointTarget,
} from "@zhixing/mesh/paired-checkpoint-target";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createDomainResetApproval,
  createDomainResetEventFromApproval,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  type DomainResetApproval,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { createStdoutWriter } from "../screen/index.js";
import {
  type BackupTargetBinding,
  type BackupTargetConfigurationRepository,
} from "./backup-target-config.js";
import { createBackupTargetConfigurationInfrastructure } from "./backup-target-config-infrastructure.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { prepareMeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { createPublishedCheckpointTargetInfrastructure } from "./published-checkpoint-target-infrastructure.js";
import type {
  PublishedCheckpointDirectorySessions,
  RetirablePublishedRecoveryCheckpointTarget,
} from "./published-checkpoint-target.js";

export interface BackupCommandOptions {
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort;
  readonly writeLine?: (line: string) => void;
  readonly readRecoveryPackage?: () => Promise<string>;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly now?: () => string;
  readonly openRecoveryTarget?: (
    binding: BackupTargetBinding,
    recipientKeyId: string,
  ) => Promise<{
    readonly target: RetirablePublishedRecoveryCheckpointTarget;
    readonly close: () => Promise<void>;
  }>;
}

export async function runBackupSetupCommand(
  selection: {
    readonly directory?: string;
    readonly pairedDeviceName?: string;
  },
  options: BackupCommandOptions = {},
): Promise<void> {
  const selectedDevice = selection.pairedDeviceName;
  if ((selection.directory === undefined) === (selectedDevice === undefined)) {
    throw new TypeError("请选择一个独立目录或一台已配对设备作为恢复备份目标");
  }
  const context = await openContext(options);
  const application = createBackupRecoveryAdministration(context, options);
  const result = await mapBackupAdministrationError(() => application.setup(selection.directory !== undefined
    ? { kind: "directory", directory: selection.directory }
    : {
        kind: "paired-device",
        displayName: selectedDevice!,
      }));
  renderBackupSetupResult(context, result);
}

export async function runRecoveryRootRotateCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  const outcome = await mapRootLifecycleError(() =>
    createBackupRecoveryRootLifecycleApplication(options).rotate(input));
  if (outcome.kind !== "rotated") throw new Error("恢复根轮换返回了错误的产品结果");
  (options.writeLine ?? createStdoutWriter().line)(
    "新的恢复码已回读验证并启用；旧恢复码已永久失效。",
  );
}

export async function runRecoveryRootInvalidateCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  const outcome = await mapRootLifecycleError(() =>
    createBackupRecoveryRootLifecycleApplication(options).invalidate(input));
  if (outcome.kind !== "invalidated") throw new Error("恢复根停用返回了错误的产品结果");
  (options.writeLine ?? createStdoutWriter().line)(
    "当前恢复码已停用；创建新恢复码前，恢复备份不可用于接管值班。",
  );
}

export async function runRecoveryRootApproveResetCommand(
  input: { readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  const outcome = await mapRootLifecycleError(() =>
    createBackupRecoveryRootLifecycleApplication(options).approveReset(input));
  if (outcome.kind !== "reset-approved") {
    throw new Error("恢复根共同确认返回了错误的产品结果");
  }
  const writeLine = options.writeLine ?? createStdoutWriter().line;
  writeLine(`重置确认码：${encodeResetApproval(outcome.approval)}`);
  writeLine("请把确认码交给当前主设备，并立即在那里完成恢复码重置。");
}

async function openResetApprovalContext(options: BackupCommandOptions): Promise<{
  readonly key: DeviceKey;
  readonly projection: TrustProjection;
  readonly writeLine: (line: string) => void;
  readonly now: () => string;
}> {
  const home = options.zhixingHome ?? getZhixingHome();
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: home });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("设备秘密存储解锁后才能共同确认恢复码重置");
  }
  const refs = await secretStore.list("device-key/device/v1/");
  if (refs.length !== 1 || !refs[0]!.bindingId.startsWith("device/v1/")) {
    throw new Error("当前设备必须且只能持有一个既有设备身份");
  }
  const deviceId = refs[0]!.bindingId.slice("device/v1/".length);
  const key = await loadDeviceKey(secretStore, deviceId);
  if (!key) throw new Error("当前设备身份不可用");
  const store = new FileMeshBootstrapStore(home, key);
  const [projection, record] = await Promise.all([
    store.loadTrustProjection(),
    store.loadTrustRecord(),
  ]);
  if (!projection || !record || canonicalize(projection.chainHead) !== canonicalize(record.chainHead)) {
    throw new Error("当前设备缺少可验证的最新信任记录");
  }
  return {
    key,
    projection,
    writeLine: options.writeLine ?? createStdoutWriter().line,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

export async function runRecoveryRootResetCommand(
  input: { readonly approval: string; readonly userConfirmed: boolean },
  options: BackupCommandOptions = {},
): Promise<void> {
  const outcome = await mapRootLifecycleError(() =>
    createBackupRecoveryRootLifecycleApplication(options).reset({
      userConfirmed: input.userConfirmed,
      decodeApproval: () => decodeResetApproval(input.approval),
    }));
  if (outcome.kind !== "reset") throw new Error("恢复根重置返回了错误的产品结果");
  (options.writeLine ?? createStdoutWriter().line)(
    "新的恢复码已在独立目标回读验证并启用；其他设备需要重新加入。",
  );
}

export function recoveryRootPublicError(_error: unknown): Error {
  return new Error(
    "恢复码操作未完成。请核对当前设备状态、独立备份和确认码后重试；系统不会绕过共同确认或自动重置安全域。",
  );
}

export async function runBackupVerifyCommand(options: BackupCommandOptions = {}): Promise<void> {
  const context = await openContext(options, false);
  await mapBackupAdministrationError(() =>
    createBackupRecoveryAdministration(context, options).verify());
  context.writeLine("恢复备份已从实际目标完整解封并验证，可用于恢复。");
}

export async function runBackupStatusCommand(options: BackupCommandOptions = {}): Promise<void> {
  const context = await openContext(options, false);
  renderBackupStatus(
    context,
    await mapBackupAdministrationError(() =>
      createBackupRecoveryAdministration(context, options).status()),
  );
}

interface BackupContext {
  readonly home: string;
  readonly secretStore: SecretStorePort;
  readonly meshConfiguration?: MeshRoleBootConfig;
  readonly key: DeviceKey;
  readonly issuerKey: DeviceKey;
  readonly identity: DeviceIdentity;
  readonly trust: HomeTrustRecord;
  readonly projection: TrustProjection;
  readonly store: FileMeshBootstrapStore;
  readonly capacity: { readonly storage: StorageMaintenanceGovernorPort };
  readonly backupTargets: BackupTargetConfigurationRepository;
  readonly publishedDirectoryTargets: PublishedCheckpointDirectorySessions;
  readonly writeLine: (line: string) => void;
  readonly now: () => string;
}

interface BackupAdministrationTargetSession {
  readonly target: RetirablePublishedRecoveryCheckpointTarget;
  readonly paired?: PairedRecoveryCheckpointTarget;
}

function createBackupRecoveryAdministration(
  context: BackupContext,
  options: BackupCommandOptions,
): BackupRecoveryAdministrationApplicationService<
  PreparedInitialRoot,
  BackupAdministrationTargetSession,
  RecoveryRoot
> {
  return new BackupRecoveryAdministrationApplicationService({
    listPairedDevices: async () => context.trust.members.map((member) => ({
      deviceId: member.device.deviceId,
      displayName: member.device.displayName,
      active: member.state === "active",
      current: member.device.deviceId === context.key.deviceId,
    })),
    readRootState: async () =>
      context.trust.recoveryRootPublicKey && context.trust.recoveryBackupPublicKey
        ? {
            kind: "established" as const,
            recipientKeyId: keyIdForPublicKey(context.trust.recoveryBackupPublicKey),
            checkpointRevision: context.trust.chainHead.eventDigest,
          }
        : { kind: "missing" as const },
    prepareInitialRoot: () => prepareInitialRoot(context, options.readRecoveryPackage),
    preparedRootRecipientKeyId: (prepared) => prepared.checkpoint.envelope.recipientKeyId,
    selectTarget: (binding) => context.backupTargets.select(toBackupTargetBinding(binding)),
    withDirectoryTarget: async (directory, use) => {
      const targetSession = await context.publishedDirectoryTargets.create(directory);
      const binding = {
        kind: "directory" as const,
        targetId: targetSession.target.targetId,
        directory: path.resolve(directory),
      };
      try {
        return await use(binding, { target: targetSession.target });
      } finally {
        await targetSession.close();
      }
    },
    withSelectedTarget: async (binding, recipientKeyId, use) => {
      const connection = await openTargetBinding(
        context,
        toBackupTargetBinding(binding),
        recipientKeyId,
      );
      try {
        return await use({
          target: connection.target,
          ...(connection.target instanceof PairedRecoveryCheckpointTarget
            ? { paired: connection.target }
            : {}),
        });
      } finally {
        await connection.close();
      }
    },
    replayRootActivation: async (binding, session) => {
      if (binding.kind !== "paired-device") return;
      if (!session.paired) throw new Error("配对恢复备份目标没有建立认证传输");
      const replay = await currentPairedRootActivation(context, binding.targetId);
      if (replay) await session.paired.activateRoot(replay);
    },
    establishInitialRoot: async (prepared, session) => {
      const established = await establishInitialRoot(
        context,
        session.target,
        options.readRecoveryPackage,
        prepared,
      );
      return { legacyTrustOnly: established.legacyTrustOnly };
    },
    activateInitialRoot: async (binding, prepared, session) => {
      if (binding.kind !== "paired-device") return;
      if (!session.paired) throw new Error("配对恢复备份目标没有建立认证传输");
      const record = await context.store.loadTrustRecord();
      if (!record || prepared.plan.kind !== "establish") {
        throw new Error("恢复根激活后缺少可提交的 current-issuer 信任事实");
      }
      await session.paired.activateRoot({
        checkpointId: prepared.checkpoint.envelope.checkpointId,
        event: prepared.plan.rootEvent,
        record,
      });
    },
    createCheckpoint: async (session, requestId) => {
      const checkpoint = await createService(context, context.trust, session.target)
        .createAndReplicate({ request: { kind: "forced", requestId } });
      return { checkpointId: checkpoint.envelope.checkpointId };
    },
    loadTargetConfiguration: () => context.backupTargets.load(),
    verificationCandidate: (targetId) =>
      createService(context, context.trust, metadataOnlyTarget(targetId))
        .verificationCandidate(),
    readRecoveryPackage: async () => requireCurrentRecoveryPackage(
      await readDecodedRecoveryPackage(options.readRecoveryPackage),
    ).root,
    verifyCheckpoint: async ({ target, checkpointId, recoveryPackage }) => {
      await createService(context, context.trust, target.target).verify({
        checkpointId,
        recoveryRoot: recoveryPackage,
      });
    },
    readStatus: (targetId) =>
      createService(context, context.trust, metadataOnlyTarget(targetId)).status(),
  });
}

function toBackupTargetBinding(
  binding: BackupRecoveryAdministrationTargetBinding,
): BackupTargetBinding {
  return binding.kind === "paired-device"
    ? {
        kind: "paired-device",
        targetId: binding.targetId,
        deviceId: binding.deviceId,
      }
    : {
        kind: "directory",
        targetId: binding.targetId,
        directory: binding.directory,
      };
}

async function mapBackupAdministrationError<Result>(
  action: () => Promise<Result>,
): Promise<Result> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof BackupRecoveryAdministrationError)) throw error;
    const messages: Record<typeof error.code, string> = {
      "duplicate-paired-device-name": "存在同名配对设备，请先修改设备名称后重试",
      "invalid-paired-device": "恢复备份目标必须是另一台已配对且仍有效的设备",
      "missing-recipient-identity": "恢复备份目标缺少候选恢复根身份",
      "target-not-configured": "尚未配置恢复备份目标，请先运行 zz backup setup",
      "current-target-binding-missing": "恢复备份目标配置缺少当前绑定",
      "verification-candidate-missing": "当前恢复根没有待验证的恢复备份",
      "verification-target-binding-missing": "待验证恢复备份的目标绑定不存在",
      "recovery-root-missing": "当前 home 尚未建立恢复根",
    };
    throw new Error(messages[error.code]);
  }
}

type RecoveryRootLifecycleTrustEvent = HomeTrustEventWithBody<
  Extract<HomeTrustEvent["body"], { readonly t: "recovery-root" | "domain-reset" }>
>;

type RecoveryRootRotateEvent = HomeTrustEventWithBody<
  Extract<HomeTrustEvent["body"], { readonly t: "recovery-root"; readonly op: "rotate" }>
>;

type RecoveryRootEstablishEvent = HomeTrustEventWithBody<
  Extract<HomeTrustEvent["body"], { readonly t: "recovery-root"; readonly op: "establish" }>
>;

type RecoveryRootResetEvent = HomeTrustEventWithBody<
  Extract<HomeTrustEvent["body"], { readonly t: "domain-reset" }>
>;

type RecoveryRootResetSignature = DomainResetApproval["coSign"]["sig"];

function createBackupRecoveryRootLifecycleApplication(
  options: BackupCommandOptions,
): BackupRecoveryRootLifecycleApplicationService<
  RecoveryRoot,
  RecoveryRootLifecycleTrustEvent,
  CheckpointPackage,
  RetirablePublishedRecoveryCheckpointTarget,
  RecoveryRootResetSignature
> {
  return new BackupRecoveryRootLifecycleApplicationService({
    now: options.now ?? (() => new Date().toISOString()),
    withIssuerSession: async (use) => {
      const context = await openContext(options, false);
      return use({
        context: projectRootLifecycleContext({
          projection: context.projection,
          currentDeviceId: context.key.deviceId,
          signerKeyId: context.issuerKey.deviceId,
        }),
        readCurrentPackage: async () => rootMaterial(requireCurrentRecoveryPackage(
          await readDecodedRecoveryPackage(options.readRecoveryPackage),
        ).root),
        prepareReplacementRoot: () => prepareReplacementRoot(context, options),
        createRotateEvent: ({ currentRoot, candidateRoot, at }) => createRecoveryRootEvent({
          current: context.projection,
          op: "rotate",
          candidate: candidateRoot,
          outerSigner: currentRoot,
          at,
        }),
        createInvalidationEvent: ({ currentRoot, at }) => createSignedTrustEvent({
          current: context.projection,
          at,
          signer: currentRoot,
          body: {
            t: "recovery-root" as const,
            op: "invalidate" as const,
            signedBy: "recovery-root" as const,
          },
        }),
        createResetEvents: ({ approval, candidateRoot, at }) => {
          const resetEvent = createDomainResetEventFromApproval({
            current: context.projection,
            issuer: context.issuerKey,
            approval,
          });
          const afterReset = applyTrustEvent(context.projection, resetEvent);
          return {
            resetEvent,
            rootEvent: createRecoveryRootEvent({
              current: afterReset,
              op: "establish",
              candidate: candidateRoot,
              outerSigner: context.issuerKey,
              at,
            }),
          };
        },
        withCurrentTarget: async (candidateRoot, useTarget) => {
          const connection = await openCurrentTarget(context, candidateRoot, options);
          try {
            return await useTarget(connection.target);
          } finally {
            await connection.close();
          }
        },
        targetId: (target) => target.targetId,
        captureCheckpoint: ({ plan, candidateRoot, createdAt }) =>
          captureRootLifecycleCheckpoint(
            context,
            toRecoveryActivationPlan(plan),
            candidateRoot,
            createdAt,
          ),
        currentCheckpointIds: (targetId) => currentRootCheckpointIds(context, targetId),
        activate: async ({
          plan,
          candidateRoot,
          checkpoint,
          target,
          supersedeCheckpointIds,
        }) => {
          const activationPlan = toRecoveryActivationPlan(plan);
          let next = context.projection;
          if (activationPlan.kind === "domain-reset-establish") {
            next = applyTrustEvent(next, activationPlan.resetEvent);
          }
          next = applyTrustEvent(next, activationPlan.rootEvent);
          const targetRecord = buildHomeTrustRecord(next, context.issuerKey);
          await new RecoveryActivationCoordinator(context.store.bootstrapAuthority()).activatePrepared({
            current: context.projection,
            plan: activationPlan,
            checkpoint,
            candidateRoot,
            issuerIdentity: currentIssuerIdentity(context),
            target,
            sourceIndependenceDomain: `filesystem:${await sourceDevice(context.store)}`,
            now: context.now,
            onStep: async (step) => {
              if (step === "verified") {
                await activateIndependentRootTarget(target, {
                  checkpointId: checkpoint.envelope.checkpointId,
                  event: activationPlan.rootEvent,
                  record: targetRecord,
                });
              }
            },
            supersedeCheckpointIds,
          });
          const record = await context.store.loadTrustRecord();
          if (!record) {
            throw new Error(activationPlan.kind === "rotate"
              ? "恢复根轮换没有形成耐久信任记录"
              : "恢复根重置没有形成耐久信任记录");
          }
        },
        commitInvalidation: async (event) => {
          const next = applyTrustEvent(context.projection, event);
          const record = buildHomeTrustRecord(next, context.issuerKey);
          await context.store.appendTrustEvent({ event, record });
        },
      });
    },
    withApprovalSession: async (use) => {
      const context = await openResetApprovalContext(options);
      return use({
        context: projectRootLifecycleContext({
          projection: context.projection,
          currentDeviceId: context.key.deviceId,
          signerKeyId: context.key.deviceId,
        }),
        createApproval: (at) => createDomainResetApproval({
          current: context.projection,
          coSigner: context.key,
          at,
        }),
      });
    },
  });
}

function projectRootLifecycleContext(input: {
  readonly projection: TrustProjection;
  readonly currentDeviceId: string;
  readonly signerKeyId: string;
}): BackupRecoveryRootLifecycleContext {
  const root = input.projection.recoveryRootPublicKey && input.projection.recoveryBackupPublicKey
    ? {
        rootPublicKey: input.projection.recoveryRootPublicKey,
        backupPublicKey: input.projection.recoveryBackupPublicKey,
      }
    : undefined;
  return Object.freeze({
    homeId: input.projection.homeId,
    trustEpoch: input.projection.trustEpoch,
    chainHead: Object.freeze({ ...input.projection.chainHead }),
    currentDeviceId: input.currentDeviceId,
    issuerDeviceId: input.projection.issuer.deviceId,
    issuerKeyId: input.projection.issuer.issuerKeyId,
    signerKeyId: input.signerKeyId,
    activeDeviceIds: Object.freeze(input.projection.members
      .filter((member) => member.state === "active")
      .map((member) => member.device.deviceId)),
    ...(root ? { currentRoot: Object.freeze(root) } : {}),
  });
}

function rootMaterial(root: RecoveryRoot): {
  readonly root: RecoveryRoot;
  readonly identity: { readonly rootPublicKey: string; readonly backupPublicKey: string };
} {
  return Object.freeze({ root, identity: Object.freeze(root.publicIdentity()) });
}

function toRecoveryActivationPlan(
  plan: BackupRecoveryRootActivationPlan<RecoveryRootLifecycleTrustEvent>,
): Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["plan"] {
  if (plan.kind === "rotate") {
    if (!isRecoveryRootRotateEvent(plan.rootEvent)) {
      throw new TypeError("Recovery root rotate plan contains the wrong event");
    }
    return Object.freeze({ v: 1, kind: "rotate", rootEvent: plan.rootEvent });
  }
  if (
    !isRecoveryRootResetEvent(plan.resetEvent) ||
    !isRecoveryRootEstablishEvent(plan.rootEvent)
  ) {
    throw new TypeError("Recovery root reset plan contains the wrong events");
  }
  return Object.freeze({
    v: 1,
    kind: "domain-reset-establish",
    resetEvent: plan.resetEvent,
    rootEvent: plan.rootEvent,
  });
}

function isRecoveryRootRotateEvent(
  event: RecoveryRootLifecycleTrustEvent,
): event is RecoveryRootRotateEvent {
  return event.body.t === "recovery-root" && event.body.op === "rotate";
}

function isRecoveryRootEstablishEvent(
  event: RecoveryRootLifecycleTrustEvent,
): event is RecoveryRootEstablishEvent {
  return event.body.t === "recovery-root" && event.body.op === "establish";
}

function isRecoveryRootResetEvent(
  event: RecoveryRootLifecycleTrustEvent,
): event is RecoveryRootResetEvent {
  return event.body.t === "domain-reset";
}

async function activateIndependentRootTarget(
  target: RetirablePublishedRecoveryCheckpointTarget,
  input: {
    readonly checkpointId: string;
    readonly event: HomeTrustEvent;
    readonly record: HomeTrustRecord;
  },
): Promise<void> {
  if (!("activateRoot" in target) || typeof target.activateRoot !== "function") return;
  await (target.activateRoot as (value: typeof input) => Promise<void>)(input);
}

async function mapRootLifecycleError<Result>(
  action: () => Promise<Result>,
): Promise<Result> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof BackupRecoveryRootLifecycleError)) throw error;
    const messages: Record<typeof error.code, string> = {
      "rotate-confirmation-required": "请先确认已准备保存新的恢复码",
      "invalidate-confirmation-required": "请先确认立即停用当前恢复码",
      "approve-reset-confirmation-required": "请先在另一台已加入设备上确认重置恢复码",
      "reset-confirmation-required": "请先确认旧恢复码已永久丢失并准备保存新恢复码",
      "current-issuer-required": "只有当前值班设备可以管理恢复根",
      "current-root-missing": "恢复包不是当前有效恢复根",
      "reset-current-root-missing": "Domain reset requires an active recovery root",
      "current-package-mismatch": "恢复包不是当前有效恢复根",
      "replacement-readback-mismatch": "回读的恢复码与本次生成的新恢复码不一致",
      "approval-generation-mismatch": "Domain reset approval does not match the current trust generation",
      "approval-cosigner-ineligible": "只有当前安全域中的有效设备可以共同确认恢复码重置",
      "approval-cosigner-is-issuer": "当前主设备不能同时作为第二台共同确认设备",
    };
    throw new Error(messages[error.code]);
  }
}

function renderBackupSetupResult(
  context: BackupContext,
  result: BackupRecoveryAdministrationSetupResult,
): void {
  switch (result.kind) {
    case "initial-root-established":
      context.writeLine("恢复备份已创建、回读并验证，可用于恢复。");
      return;
    case "legacy-root-established":
      context.writeLine("旧恢复包中的恢复根已安全激活；请再次运行 zz backup setup 创建完整恢复备份。");
      return;
    case "checkpoint-created":
      context.writeLine(
        `恢复备份已写入目标，仍需运行 zz backup verify 完成验证（${result.checkpointId}）。`,
      );
  }
}

function renderBackupStatus(context: BackupContext, status: BackupRecoveryAdministrationStatus): void {
  switch (status.state) {
    case "recoverable":
      context.writeLine("恢复备份：可恢复。最近一份备份已从独立目标完整验证。");
      return;
    case "pending-verification":
      context.writeLine("恢复备份：待验证。下一步：运行 zz backup verify 并输入恢复包。");
      return;
    case "not-configured":
      context.writeLine("恢复备份：未配置。下一步：运行 zz backup setup 选择独立目录或配对设备。");
      return;
    case "configured-empty":
      context.writeLine("恢复备份：尚无可恢复副本。下一步：重新运行 zz backup setup。");
      return;
    case "unavailable":
      context.writeLine("恢复备份：尚无可恢复副本。下一步：重新运行 zz backup setup。");
  }
}

async function openContext(
  options: BackupCommandOptions,
  initialize = true,
  requireIssuer = true,
): Promise<BackupContext> {
  const home = options.zhixingHome ?? getZhixingHome();
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: home });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("设备秘密存储解锁后才能管理恢复备份");
  }
  const key = await loadOrCreateDeviceKey(secretStore);
  const capacity = options.storageMaintenance
    ? { storage: options.storageMaintenance }
    : createDeviceCapacityRuntime(path.join(home, "distributed-runtime", "capacity"));
  const store = new FileMeshBootstrapStore(home, key, { storageMaintenance: capacity.storage });
  let projection = await store.loadTrustProjection();
  let trust = await store.loadTrustRecord();
  let identity: DeviceIdentity;
  if (!projection || !trust) {
    if (!initialize) throw new Error("当前设备尚未建立可管理恢复备份的本地身份");
    identity = enrollDeviceIdentity(key, {
      displayName: hostname(),
      platform: devicePlatform(),
      enrolledAt: new Date().toISOString(),
    });
    const created = await store.initializeLocalHome({
      key,
      identity,
      roles: ["anchor", "executor"],
    });
    projection = created.projection;
    trust = created.record;
  } else {
    const member = trust.members.find((candidate) =>
      candidate.state === "active" && candidate.device.deviceId === key.deviceId);
    if (!member) throw new Error("当前设备不在有效的 home 信任成员中");
    identity = member.device;
  }
  if (requireIssuer && trust.issuer.deviceId !== key.deviceId) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  const config = loadConfig({ homeDir: home });
  if (config.mesh?.enabledRoles && !config.mesh.enabledRoles.includes("anchor")) {
    throw new Error("只有当前主设备可以管理恢复备份");
  }
  let issuerKey = await loadActiveAnchorIssuerKey(secretStore, trust.issuer.issuerKeyId);
  if (!issuerKey && trust.issuer.issuerKeyId === key.deviceId) {
    const bootstrapKeyId = `home-bootstrap:${trust.homeId}`;
    await persistAnchorIssuerKey(secretStore, bootstrapKeyId, key);
    await activateAnchorIssuerKey(secretStore, bootstrapKeyId, key.deviceId);
    issuerKey = key;
  }
  if (!issuerKey || issuerKey.deviceId !== trust.issuer.issuerKeyId) {
    throw new Error("当前主设备缺少可用的值班签发密钥");
  }
  store.bindIssuerKey(issuerKey);
  return {
    home,
    secretStore,
    ...(config.mesh ? { meshConfiguration: config.mesh } : {}),
    key,
    issuerKey,
    identity,
    trust,
    projection,
    store,
    capacity,
    backupTargets: createBackupTargetConfigurationInfrastructure(home),
    publishedDirectoryTargets: createPublishedCheckpointTargetInfrastructure({
      zhixingHome: home,
      storageMaintenance: capacity.storage,
    }).directory,
    writeLine: options.writeLine ?? createStdoutWriter().line,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

interface PreparedInitialRoot {
  readonly root: RecoveryRoot;
  readonly plan: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["plan"];
  readonly checkpoint: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["checkpoint"];
  readonly legacyTrustOnly: boolean;
}

async function prepareInitialRoot(
  context: BackupContext,
  readRecoveryPackage?: () => Promise<string>,
): Promise<PreparedInitialRoot> {
  const root = RecoveryRoot.generate();
  const recoveryPackage = encodeRecoveryPackage(root);
  context.writeLine(`恢复包：${recoveryPackage}`);
  const decoded = await readDecodedRecoveryPackage(readRecoveryPackage);
  if (decoded.version === 1) {
    if (decoded.checkpoint.envelope.manifest.purpose.kind !== "root-activation") {
      throw new Error("旧恢复包不包含根激活计划");
    }
    return {
      root: decoded.root,
      plan: decoded.checkpoint.envelope.manifest.purpose.plan,
      checkpoint: decoded.checkpoint,
      legacyTrustOnly: true,
    };
  }
  if (
    decoded.root.rootPublicKey !== root.rootPublicKey ||
    decoded.root.backupPublicKey !== root.backupPublicKey
  ) throw new Error("回读的恢复包与本次生成的恢复根不一致");
  const createdAt = new Date().toISOString();
  const generatedPlan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent: createRecoveryRootEvent({
      current: context.projection,
      op: "establish",
      candidate: root,
      outerSigner: context.issuerKey,
      at: createdAt,
    }),
  };
  const plan = generatedPlan;
  const issuer = checkpointIssuer(currentIssuerIdentity(context), context.issuerKey);
  const checkpoint = (await captureFullAuthorityCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    purpose: { kind: "root-activation", plan },
    trust: context.trust,
    issuer,
    recipient: decoded.root.publicIdentity(),
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    storageMaintenance: context.capacity.storage,
  })).checkpoint;
  if (checkpoint.envelope.recipientKeyId !== keyIdForPublicKey(decoded.root.backupPublicKey)) {
    throw new Error("恢复包与恢复 checkpoint 的 recipient 身份不一致");
  }
  return { root: decoded.root, plan, checkpoint, legacyTrustOnly: false };
}

async function establishInitialRoot(
  context: BackupContext,
  target: RetirablePublishedRecoveryCheckpointTarget,
  readRecoveryPackage?: () => Promise<string>,
  prepared?: PreparedInitialRoot,
): Promise<PreparedInitialRoot> {
  const initial = prepared ?? await prepareInitialRoot(context, readRecoveryPackage);
  await new RecoveryActivationCoordinator(context.store.bootstrapAuthority()).activatePrepared({
    current: context.projection,
    plan: initial.plan,
    checkpoint: initial.checkpoint,
    candidateRoot: initial.root,
    issuerIdentity: currentIssuerIdentity(context),
    target,
    sourceIndependenceDomain: `filesystem:${await sourceDevice(context.store)}`,
    now: () => new Date().toISOString(),
  });
  return initial;
}

function createService(
  context: BackupContext,
  trust: HomeTrustRecord,
  target: RetirablePublishedRecoveryCheckpointTarget,
): AuthorityCheckpointService {
  if (!trust.recoveryBackupPublicKey) throw new Error("当前 home 尚未建立恢复根");
  const recipient = {
    backupPublicKey: trust.recoveryBackupPublicKey,
    backupKeyId: keyIdForPublicKey(trust.recoveryBackupPublicKey),
  };
  return new AuthorityCheckpointService({
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    target,
    trust,
    issuer: checkpointIssuer(currentIssuerIdentity(context), context.issuerKey),
    recipient,
    currentAnchor: trust.issuer.deviceId === context.key.deviceId,
    storageMaintenance: context.capacity.storage,
  });
}

async function connectPairedTarget(
  context: BackupContext,
  targetDeviceId: string,
  recipientKeyId = context.trust.recoveryBackupPublicKey
    ? keyIdForPublicKey(context.trust.recoveryBackupPublicKey)
    : undefined,
): Promise<{
  readonly target: PairedRecoveryCheckpointTarget;
  readonly close: () => Promise<void>;
}> {
  const member = context.trust.members.find((candidate) =>
    candidate.state === "active" && candidate.device.deviceId === targetDeviceId);
  if (!member || targetDeviceId === context.key.deviceId) {
    throw new Error("恢复备份目标不再是另一台有效配对设备");
  }
  if (!recipientKeyId) throw new Error("恢复备份目标缺少候选恢复根身份");
  const bootstrap = await prepareMeshRuntimeBootstrap({
    zhixingHome: context.home,
    secretStore: context.secretStore,
    storageMaintenance: context.capacity.storage,
    ...(context.meshConfiguration ? { configuration: context.meshConfiguration } : {}),
  });
  if (bootstrap.mode !== "trusted-home" || !bootstrap.roles.includes("anchor")) {
    throw new Error("只有当前主设备可以连接配对设备核对恢复备份");
  }
  const control = new ProductionMeshControlPlane({
    localIdentity: bootstrap.deviceKey,
    trust: bootstrap.trust,
    configuration: bootstrap.configuration,
    endpoints: bootstrap.endpoints,
    transportPeers: bootstrap.transportPeers,
    secretStore: context.secretStore,
    endpointDirectory: bootstrap.bootstrapProjection.endpoints,
    transportPeerDirectory: bootstrap.bootstrapProjection.transportPeers,
    trustProjection: Object.freeze({
      loadTrustRecord: () => bootstrap.bootstrapStore.loadTrustRecord(),
    }),
    services: new MeshServiceRegistry(),
    credentialRouteGuard: new CredentialExposureAuthority({
      deviceId: context.key.deviceId,
      log: context.store.authorityLog(),
      secretStore: context.secretStore,
    }),
    watchTrust: false,
    ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
  });
  try {
    await control.start();
    context.writeLine("正在通过认证连接等待配对备份设备……");
    await waitForPeer(control, targetDeviceId, 30_000);
    return {
      target: new PairedRecoveryCheckpointTarget({
        homeId: context.trust.homeId,
        sourceDeviceId: context.key.deviceId,
        targetDeviceId,
        recipientKeyId,
        transport: new MeshPairedCheckpointTransport(control.connections.client(targetDeviceId)),
        storageMaintenance: context.capacity.storage,
      }),
      close: () => control.stop(),
    };
  } catch (error) {
    await control.stop().catch(() => undefined);
    throw error;
  }
}

async function currentPairedRootActivation(
  context: BackupContext,
  targetId: string,
): Promise<{
  readonly checkpointId: string;
  readonly event: Parameters<PairedRecoveryCheckpointTarget["activateRoot"]>[0]["event"];
  readonly record: HomeTrustRecord;
} | undefined> {
  if (!context.projection.recoveryActivationDigest) return undefined;
  return context.store.loadRecoveryRootActivationReplay({
    activationDigest: context.projection.recoveryActivationDigest,
    targetId,
  });
}

async function openTargetBinding(
  context: BackupContext,
  binding: BackupTargetBinding,
  recipientKeyId?: string,
): Promise<{ readonly target: RetirablePublishedRecoveryCheckpointTarget; readonly close: () => Promise<void> }> {
  if (binding.kind === "paired-device") {
    return connectPairedTarget(context, binding.deviceId, recipientKeyId);
  }
  const targetSession = await context.publishedDirectoryTargets.openExisting(binding.directory);
  if (targetSession.target.targetId !== binding.targetId) {
    await targetSession.close();
    throw new Error("恢复备份目标的物理身份已改变");
  }
  return targetSession;
}

async function waitForPeer(
  control: ProductionMeshControlPlane,
  deviceId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!control.connections.has(deviceId)) {
    if (Date.now() >= deadline) {
      throw new Error("配对备份设备未在等待时间内上线；请确认目标设备正在运行后重试");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

function metadataOnlyTarget(targetId: string): RetirablePublishedRecoveryCheckpointTarget {
  const unavailable = async (): Promise<never> => {
    throw new Error("Recovery checkpoint target is not connected");
  };
  return {
    targetId,
    independenceDomain: targetId,
    writeDurable: unavailable,
    read: unavailable,
    retire: unavailable,
  };
}

function checkpointIssuer(identity: DeviceIdentity, key: DeviceKey): DeviceIdentity & CheckpointSigner {
  return Object.assign({}, identity, {
    sign: key.sign.bind(key),
  });
}

async function sourceDevice(store: FileMeshBootstrapStore): Promise<string> {
  return String((await store.authorityLog().originCheckpoint()).logId);
}

async function readDecodedRecoveryPackage(
  injected?: () => Promise<string>,
): Promise<ReturnType<typeof decodeRecoveryPackage>> {
  return injected ? decodeRecoveryPackage(await injected()) : readRecoveryPackageFromTty();
}

function currentIssuerIdentity(context: BackupContext): DeviceIdentity {
  if (context.issuerKey.deviceId === context.identity.deviceId) return context.identity;
  return Object.freeze({
    ...context.identity,
    deviceId: context.issuerKey.deviceId,
    publicKey: context.issuerKey.publicKey,
  });
}

async function prepareReplacementRoot(
  context: BackupContext,
  options: BackupCommandOptions,
): Promise<{
  readonly generated: ReturnType<typeof rootMaterial>;
  readonly readBack: ReturnType<typeof rootMaterial>;
}> {
  const generated = RecoveryRoot.generate();
  context.writeLine(`新的恢复码：${encodeRecoveryPackage(generated)}`);
  const readBack = requireCurrentRecoveryPackage(
    await readDecodedRecoveryPackage(options.readRecoveryPackage),
  );
  return Object.freeze({
    generated: rootMaterial(generated),
    readBack: rootMaterial(readBack.root),
  });
}

async function openCurrentTarget(
  context: BackupContext,
  recipient: RecoveryRoot,
  options: BackupCommandOptions,
): Promise<{ readonly target: RetirablePublishedRecoveryCheckpointTarget; readonly close: () => Promise<void> }> {
  const configured = await context.backupTargets.load();
  if (!configured) throw new Error("尚未配置独立恢复备份目标");
  const binding = configured.bindings.find((candidate) =>
    candidate.targetId === configured.currentTargetId);
  if (!binding) throw new Error("恢复备份目标配置缺少当前绑定");
  const recipientKeyId = keyIdForPublicKey(recipient.backupPublicKey);
  if (options.openRecoveryTarget) return options.openRecoveryTarget(binding, recipientKeyId);
  return openTargetBinding(context, binding, recipientKeyId);
}

async function captureRootLifecycleCheckpoint(
  context: BackupContext,
  plan: Parameters<RecoveryActivationCoordinator["activatePrepared"]>[0]["plan"],
  candidateRoot: RecoveryRoot,
  createdAt: string,
): Promise<CheckpointPackage> {
  return (await captureFullAuthorityCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    purpose: { kind: "root-activation", plan },
    trust: context.trust,
    issuer: checkpointIssuer(currentIssuerIdentity(context), context.issuerKey),
    recipient: candidateRoot.publicIdentity(),
    log: context.store.authorityLog(),
    artifacts: context.store.artifactStore(),
    retention: context.store.checkpointRetention(),
    storageMaintenance: context.capacity.storage,
  })).checkpoint;
}

async function currentRootCheckpointIds(
  context: BackupContext,
  targetId: string,
): Promise<readonly string[]> {
  if (!context.projection.recoveryActivationDigest) return [];
  const replay = await context.store.loadRecoveryRootActivationReplay({
    activationDigest: context.projection.recoveryActivationDigest,
    targetId,
  });
  return replay ? [replay.checkpointId] : [];
}

const RESET_APPROVAL_PREFIX = "zxra1:";

function encodeResetApproval(approval: DomainResetApproval): string {
  return `${RESET_APPROVAL_PREFIX}${Buffer.from(canonicalize(approval), "utf8").toString("base64url")}`;
}

function decodeResetApproval(value: string): DomainResetApproval {
  if (!value.startsWith(RESET_APPROVAL_PREFIX)) throw new TypeError("重置确认码格式无效");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(RESET_APPROVAL_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new TypeError("重置确认码格式无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("重置确认码格式无效");
  }
  const record = parsed as Record<string, unknown>;
  if (
    canonicalize(Object.keys(record).sort()) !== canonicalize([
      "at", "coSign", "homeId", "prevEventDigest", "seq", "trustEpoch", "v",
    ]) ||
    record.v !== 1 || typeof record.homeId !== "string" ||
    typeof record.prevEventDigest !== "string" || typeof record.seq !== "number" ||
    typeof record.trustEpoch !== "number" || typeof record.at !== "string" ||
    !record.coSign || typeof record.coSign !== "object" || Array.isArray(record.coSign)
  ) throw new TypeError("重置确认码格式无效");
  const coSign = record.coSign as Record<string, unknown>;
  const signature = coSign.sig;
  if (
    canonicalize(Object.keys(coSign).sort()) !== canonicalize(["deviceId", "sig"]) ||
    typeof coSign.deviceId !== "string" || !signature || typeof signature !== "object" ||
    Array.isArray(signature)
  ) throw new TypeError("重置确认码格式无效");
  const signatureRecord = signature as Record<string, unknown>;
  if (
    canonicalize(Object.keys(signatureRecord).sort()) !== canonicalize(["alg", "keyId", "sig"]) ||
    typeof signatureRecord.alg !== "string" || typeof signatureRecord.keyId !== "string" ||
    typeof signatureRecord.sig !== "string"
  ) throw new TypeError("重置确认码格式无效");
  return Object.freeze({
    v: 1,
    homeId: record.homeId,
    seq: record.seq,
    prevEventDigest: record.prevEventDigest,
    trustEpoch: record.trustEpoch,
    at: record.at,
    coSign: Object.freeze({
      deviceId: coSign.deviceId,
      sig: Object.freeze({
        alg: signatureRecord.alg,
        keyId: signatureRecord.keyId,
        sig: signatureRecord.sig,
      }),
    }),
  });
}

function devicePlatform(): "linux" | "windows" | "macos" | "headless" {
  const current = platform();
  if (current === "win32") return "windows";
  if (current === "darwin") return "macos";
  if (current === "linux") return "linux";
  return "headless";
}
