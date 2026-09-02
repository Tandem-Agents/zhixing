import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces, hostname, platform } from "node:os";
import { connect, createServer, type Server, type Socket } from "node:net";
import QRCode from "qrcode";
import {
  getZhixingHome,
} from "@zhixing/core";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type {
  CheckpointStreamRecord,
  DeviceIdentity,
  DeviceRole,
  HomeTrustEvent,
  MeshRoleBootConfig,
  MeshEndpointDescriptor,
  MeshEndpointTransport,
  PairingAcceptance,
  PairingJoin,
  PairingOffer,
  PakeRound,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { canonicalize, EXECUTION_PROTOCOL_VERSION } from "@zhixing/core/protocol";
import {
  createMeshEndpointDescriptor,
  deletePairwiseRendezvousSecret,
  derivePairwiseRendezvousSecret,
  persistPairwiseRendezvousSecret,
  validateMeshEndpointDescriptor,
  validateRendezvousKey,
} from "@zhixing/mesh/bootstrap";
import { encodeBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import { PairingCommitCoordinator } from "@zhixing/mesh/bootstrap-authority";
import { RecoveryActivationCoordinator } from "@zhixing/mesh/bootstrap-authority";
import {
  createCheckpointId,
  type CheckpointPackage,
} from "@zhixing/mesh/checkpoint";
import { captureFullAuthorityCheckpoint } from "@zhixing/mesh/full-checkpoint";
import {
  FilePairedCheckpointStaging,
  decodePairedCheckpointResult,
  PairedCheckpointReceiver,
  PairedRecoveryCheckpointTarget,
  type PairedCheckpointCommand,
  type PairedCheckpointResult,
  type PairedCheckpointTransport,
} from "@zhixing/mesh/paired-checkpoint-target";
import {
  decodeRecoveryPackage,
  encodeRecoveryPackage,
} from "@zhixing/mesh/recovery-package";
import {
  enrollDeviceIdentity,
  verifyDeviceSignature,
  type DeviceKey,
} from "@zhixing/mesh/device-identity";
import {
  assemblePairingFinished,
  assertPairingOfferJoin,
  createPairingAcceptanceProof,
  createQrPairingJoin,
  InMemoryPairingOfferRepository,
  pairingTranscriptDigest,
  verifyPairingAcceptance,
  type PairingOfferMaterial,
  type PairingOfferRepository,
} from "@zhixing/mesh/pairing";
import {
  applyTrustEvent,
  createRecoveryRootEvent,
  createSignedTrustEvent,
  homeTrustEventDigest,
  replayTrustChain,
  verifyHomeTrustRecord,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { loadConfig, writeConfig } from "@zhixing/providers";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { createStdoutWriter } from "../screen/index.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  createMeshBootstrapProjectionPorts,
  type MeshBootstrapProjectionPorts,
} from "./mesh-bootstrap-projection.js";
import { FileBackupTargetConfiguration } from "./backup-target-config.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";
import {
  FileMeshPairingContinuationStore,
  type DurablePairingInvitation,
  type DurablePairingBootstrap,
  type PairingIssuerContinuation,
  type PairingJoinerContinuation,
} from "./mesh-pairing-continuation.js";
import {
  CredentialExposureAuthority,
  exposureGuardedSecretStore,
} from "./credential-exposure-authority.js";
import { reconcileCurrentManagedService } from "./managed-service-runtime.js";

const PAIRING_TIMEOUT_MS = 120_000;
const MAX_PAIRING_FRAME_BYTES = 1024 * 1024;
const pairingDeadlines = new WeakMap<Socket, AbortSignal>();

class PairingPublicFacingError extends Error {
  override readonly name = "PairingPublicFacingError";
}

export interface PairCommandOptions {
  readonly invitation?: string;
  readonly listen?: string;
  readonly advertise?: string;
  readonly relay?: string;
  readonly relayOnly?: boolean;
  readonly roles?: readonly DeviceRole[];
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort;
  readonly writeLine?: (line: string) => void;
  readonly confirmRecoveryPackage?: (recoveryPackage: string) => Promise<string>;
  readonly executorAutoStart?: boolean;
  readonly promptExecutorAutoStart?: () => Promise<boolean>;
  readonly reconcileManagedService?: (
    trigger: "pairing-issuer-committed" | "pairing-joiner-committed",
  ) => Promise<void>;
  /** Isolated composition seam for the target-device configuration step. */
  readonly completeDeviceConfiguration?: () => Promise<"ready" | "cancelled">;
  /** Isolated composition seam for the final duty-device choice. */
  readonly selectDutyDevice?: (input: {
    readonly currentDeviceName: string;
    readonly pairedDeviceName: string;
  }) => Promise<"current" | "paired">;
  /** Isolated composition seam for the existing planned migration command. */
  readonly migrateDutyTo?: (deviceName: string) => Promise<void>;
}

interface PairingRuntimeInput extends PairCommandOptions {
  readonly isolatedComposition: boolean;
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly key: DeviceKey;
  readonly store: FileMeshBootstrapStore;
  readonly bootstrapProjection: MeshBootstrapProjectionPorts;
  readonly continuations: FileMeshPairingContinuationStore;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly writeLine: (line: string) => void;
}

interface PairingInvitation {
  readonly v: 1;
  readonly offer: PairingOffer;
  readonly issuer: DeviceIdentity;
  readonly rendezvousKey: string;
  readonly transports: readonly MeshEndpointTransport[];
  readonly qrSecret?: string;
}

interface JoinMessage {
  readonly t: "join";
  readonly join: PairingJoin;
  readonly rootCertificatePem: string;
  readonly firstRound?: PakeRound;
}

interface PairingChallengeMessage {
  readonly t: "challenge";
  readonly acceptance: Omit<PairingAcceptance, "finished">;
  readonly issuerProof: ReturnType<typeof createPairingAcceptanceProof>;
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly issuerRootCertificatePem: string;
  readonly issuerEndpoint: MeshEndpointDescriptor;
}

interface JoinerProofMessage {
  readonly t: "joiner-proof";
  readonly proof: ReturnType<typeof createPairingAcceptanceProof>;
}

interface PairingCommittedMessage extends DurablePairingBootstrap {
  readonly t: "committed";
}

interface PairingResumeMessage {
  readonly t: "resume";
  readonly offerId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly proof: string;
  readonly joinerProof: PairingAcceptance["finished"]["joiner"];
}

interface RecoveryOnboardingStartMessage {
  readonly t: "recovery-onboarding-start";
  readonly homeId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly checkpointId: string;
  readonly recipientKeyId: string;
}

interface RecoveryOnboardingCommandMessage {
  readonly t: "recovery-onboarding-command";
  readonly command: PairedCheckpointCommand;
}

interface RecoveryOnboardingResultMessage {
  readonly t: "recovery-onboarding-result";
  readonly result: PairedCheckpointResult;
}

interface RecoveryOnboardingCompleteMessage {
  readonly t: "recovery-onboarding-complete";
  readonly checkpointId: string;
}

/** Runs the same executable as pairing issuer or joiner without loading the agent runtime. */
export async function runPairCommand(options: PairCommandOptions = {}): Promise<void> {
  const zhixingHome = options.zhixingHome ?? getZhixingHome();
  if (options.invitation) {
    assertProductionPairingInvitation(decodeInvitation(options.invitation));
  }
  const continuations = new FileMeshPairingContinuationStore(zhixingHome);
  const continuation = await continuations.load();
  if (continuation) assertProductionPairingOffer(continuation.invitation.offer);
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir: zhixingHome });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("Device SecretStore must be unlocked before pairing");
  }
  const key = await loadOrCreateDeviceKey(secretStore);
  const deviceCapacity = createDeviceCapacityRuntime(
    `${zhixingHome}/distributed-runtime/capacity`,
  );
  const store = new FileMeshBootstrapStore(zhixingHome, key, {
    storageMaintenance: deviceCapacity.storage,
  });
  const bootstrapProjection = createMeshBootstrapProjectionPorts(store);
  const routedSecretStore = exposureGuardedSecretStore(
    secretStore,
    new CredentialExposureAuthority({
      deviceId: key.deviceId,
      log: store.authorityLog(),
      secretStore,
    }),
  );
  const writeLine: (line: string) => void =
    options.writeLine ?? createStdoutWriter().line;
  try {
    if (options.invitation || continuation?.side === "joiner") {
      await joinPairing({
        ...options,
        isolatedComposition: options.secretStore !== undefined,
        ...(options.invitation ? { invitation: options.invitation } : {}),
        zhixingHome,
        secretStore: routedSecretStore,
        key,
        store,
        bootstrapProjection,
        continuations,
        storageMaintenance: deviceCapacity.storage,
        writeLine,
      });
      return;
    }
    await issuePairing({
      ...options,
      isolatedComposition: options.secretStore !== undefined,
      zhixingHome,
      secretStore: routedSecretStore,
      key,
      store,
      bootstrapProjection,
      continuations,
      storageMaintenance: deviceCapacity.storage,
      writeLine,
    });
    await reconcileAfterPairing(options, "pairing-issuer-committed");
  } finally {
    await store.stopStorageMaintenance();
  }
}

async function reconcileAfterPairing(
  options: PairCommandOptions,
  trigger: "pairing-issuer-committed" | "pairing-joiner-committed",
): Promise<void> {
  if (options.reconcileManagedService) {
    await options.reconcileManagedService(trigger);
    return;
  }
  // A caller-supplied SecretStore denotes an isolated embedding/test composition.
  // Production CLI pairing always uses the platform store and performs host reconcile.
  if (!options.secretStore) await reconcileCurrentManagedService(trigger);
}

/** Renders the one invitation as both a scannable terminal QR and copyable text. */
export async function renderPairingInvitation(
  invitation: string,
  writeLine: (line: string) => void,
  renderQr: (content: string) => Promise<string> = (content) =>
    QRCode.toString(content, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    }),
): Promise<void> {
  const qr = await renderQr(invitation);
  writeLine("用另一台设备扫描下面的二维码，或复制二维码下方的邀请内容。");
  writeLine(qr.trimEnd());
  writeLine(`邀请内容：${invitation}`);
}

/** Converts internal pairing failures into one safe, actionable public message. */
export function pairingPublicError(error: unknown): Error {
  if (error instanceof PairingPublicFacingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/recovery|恢复码|root activation/iu.test(message)) {
    return new Error(
      "恢复码设置尚未完成。请保留刚才的恢复码，并在当前设备重新运行 zz pair 继续。",
    );
  }
  if (/invitation|offer|邀请|single-use|already belongs/iu.test(message)) {
    return new Error(
      "这份配对邀请已经失效或不能再次使用。请回到出码设备重新运行 zz pair，再扫描或复制新的邀请内容。",
    );
  }
  if (/rendezvous|routable|address|listen|relay|connect|socket|network|会合/iu.test(message)) {
    return new Error(
      "两台设备暂时无法连接。请确认它们在同一网络后，回到出码设备重新运行 zz pair。",
    );
  }
  if (/configuration|config|credential|model|executor-auto-start|干活电脑/iu.test(message)) {
    return new Error(
      "这台设备尚未准备好。请在交互终端重新运行 zz pair，按提示完成模型服务配置。",
    );
  }
  return new Error(
    "配对尚未完整结束，已经完成的安全步骤会被保留。请在当前设备重新运行 zz pair 继续。",
  );
}

export async function activateInitialRecoveryRoot(input: {
  readonly store: FileMeshBootstrapStore;
  readonly issuerKey: DeviceKey;
  readonly issuerIdentity: DeviceIdentity;
  readonly current: TrustProjection;
  readonly targetId: string;
  readonly targetIndependenceDomain: string;
  readonly createTarget: (binding: {
    readonly checkpointId: string;
    readonly recipientKeyId: string;
  }) => Promise<import("@zhixing/mesh/bootstrap-authority").RecoveryCheckpointTarget>;
  readonly writeLine: (line: string) => void;
  readonly confirmRecoveryPackage?: (recoveryPackage: string) => Promise<string>;
}): Promise<TrustProjection> {
  if (input.current.recoveryRootPublicKey || input.current.recoveryBackupPublicKey) {
    throw new Error("Recovery root is already active");
  }
  const pending = await loadPendingFullRootActivation(
    input.store,
    input.current,
    input.targetId,
  );
  const recoveryRoot = pending ? undefined : RecoveryRoot.generate();
  const recoveryPackage = recoveryRoot ? encodeRecoveryPackage(recoveryRoot) : "";
  if (recoveryPackage) {
    input.writeLine("这是你的恢复码，抄下来放在安全的地方：");
    input.writeLine(recoveryPackage);
  } else {
    input.writeLine("请粘贴上次已经保存的恢复码，继续完成设备配对。");
  }
  const decoded = input.confirmRecoveryPackage
    ? decodeRecoveryPackage(await input.confirmRecoveryPackage(recoveryPackage))
    : await readRecoveryPackageFromTty({
        prompt: "请粘贴完整恢复码，确认你已经保存：",
      });
  const candidateRoot = decoded.root;
  const legacy = decoded.version === 1 ? decoded : undefined;
  if (pending && (
    pending.plan.rootEvent.body.backupPublicKey !== candidateRoot.backupPublicKey ||
    pending.plan.rootEvent.body.rootPublicKey !== candidateRoot.rootPublicKey
  )) throw new Error("Recovery package does not match the pending root activation");
  if (pending && legacy && canonicalize(legacy.checkpoint.envelope) !== canonicalize(
    pending.checkpoint.envelope,
  )) {
    throw new Error("Legacy recovery package does not match the pending root activation");
  }
  if (recoveryRoot && decoded.version === 2 && (
    recoveryRoot.backupPublicKey !== candidateRoot.backupPublicKey ||
    recoveryRoot.rootPublicKey !== candidateRoot.rootPublicKey
  )) throw new Error("Recovery package read-back does not match the generated recovery root");
  const createdAt = pending?.checkpoint.envelope.createdAt ??
    legacy?.checkpoint.envelope.createdAt ?? new Date().toISOString();
  const generatedPlan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent: createRecoveryRootEvent({
      current: input.current,
      op: "establish",
      candidate: candidateRoot,
      outerSigner: input.issuerKey,
      at: createdAt,
    }),
  };
  const legacyPurpose = legacy?.checkpoint.envelope.manifest.purpose;
  if (legacyPurpose && legacyPurpose.kind !== "root-activation") {
    throw new Error("Legacy recovery package does not contain a root activation plan");
  }
  const plan = pending?.plan ??
    (legacyPurpose?.kind === "root-activation" ? legacyPurpose.plan : generatedPlan);
  const trust = await input.store.loadTrustRecord();
  if (!trust) throw new Error("Recovery activation requires the local home trust record");
  const checkpoint = pending?.checkpoint ?? legacy?.checkpoint ??
    (await captureFullAuthorityCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    purpose: { kind: "root-activation", plan },
    trust,
    issuer: Object.assign({}, input.issuerIdentity, {
      sign: input.issuerKey.sign.bind(input.issuerKey),
    }),
    recipient: candidateRoot.publicIdentity(),
    log: input.store.authorityLog(),
    artifacts: input.store.artifactStore(),
    retention: input.store.checkpointRetention(),
    })).checkpoint;
  const target = await input.createTarget({
    checkpointId: checkpoint.envelope.checkpointId,
    recipientKeyId: checkpoint.envelope.recipientKeyId,
  });
  if (
    target.targetId !== input.targetId ||
    target.independenceDomain !== input.targetIndependenceDomain
  ) throw new Error("Recovery target changed during root activation");
  const coordinator = new RecoveryActivationCoordinator(input.store.bootstrapAuthority());
  const next = await coordinator.activatePrepared({
    current: input.current,
    plan,
    checkpoint,
    candidateRoot,
    issuerIdentity: input.issuerIdentity,
    target,
    sourceIndependenceDomain: `device:${input.issuerKey.deviceId}`,
    now: () => new Date().toISOString(),
  });
  input.writeLine("恢复码已验证并安全启用。");
  return next;
}

async function issuePairing(input: PairingRuntimeInput): Promise<void> {
  const config = loadConfig({ homeDir: input.zhixingHome });
  let trustRecord = await input.store.loadTrustRecord();
  let projection = await input.store.loadTrustProjection();
  let identity: DeviceIdentity;
  if (!projection || !trustRecord) {
    identity = enrollDeviceIdentity(input.key, {
      displayName: hostname(),
      platform: devicePlatform(),
      enrolledAt: new Date().toISOString(),
    });
    const initialized = await input.store.initializeLocalHome({
      key: input.key,
      identity,
      roles: ["anchor", "executor"],
    });
    projection = initialized.projection;
    trustRecord = initialized.record;
  } else {
    const local = trustRecord.members.find((member) =>
      member.device.deviceId === input.key.deviceId && member.state === "active");
    if (!local || !local.roles.includes("anchor") || trustRecord.issuer.deviceId !== input.key.deviceId) {
      throw new Error("Only the active home anchor may issue a pairing invitation");
    }
    identity = local.device;
  }

  let continuation = await input.continuations.load();
  if (continuation?.side === "joiner") {
    throw new Error("A joining-device pairing continuation is already active");
  }
  if (continuation?.phase === "offer-secret-pending") {
    await deletePairingSecret(input.secretStore, continuation.invitation.offer.offerId);
    await input.continuations.clear(continuation.invitation.offer.offerId);
    continuation = undefined;
  }
  if (continuation?.phase === "secret-pending") {
    await deletePairwiseRendezvousSecret(
      input.secretStore,
      continuation.join.device.deviceId,
    );
    await deletePairingSecret(input.secretStore, continuation.invitation.offer.offerId);
    await input.continuations.clear(continuation.invitation.offer.offerId);
    continuation = undefined;
  }
  let committedReplay = continuation?.phase === "commit-ready"
    ? await input.store.pairingAuthority().loadPairingCommit(continuation.attempt.attemptId)
    : undefined;
  if (
    continuation?.phase === "commit-ready" &&
    await input.bootstrapProjection.completions.bootstrapCompleted(
      continuation.join.device.deviceId,
      continuation.invitation.offer.offerId,
    )
  ) {
    await deletePairingSecret(input.secretStore, continuation.invitation.offer.offerId);
    await input.continuations.clear(continuation.invitation.offer.offerId);
    continuation = undefined;
    committedReplay = undefined;
  }
  if (
    continuation &&
    !committedReplay &&
    Date.parse(continuation.invitation.offer.expiresAt) <= Date.now()
  ) {
    if (continuation.phase === "commit-ready") {
      await deletePairwiseRendezvousSecret(
        input.secretStore,
        continuation.join.device.deviceId,
      );
    }
    await deletePairingSecret(input.secretStore, continuation.invitation.offer.offerId);
    await input.continuations.clear(continuation.invitation.offer.offerId);
    continuation = undefined;
  }

  const listener = input.relayOnly
    ? undefined
    : await openPairingListener(input.listen ?? config.mesh?.anchorListen?.bind);
  let transport: Socket | undefined;
  let pairwisePersisted = false;
  let pairingCommitted = false;
  let peerDeviceId: string | undefined;
  try {
    const advertised = listener
      ? resolveAdvertisedEndpoint(
          listener.endpoint,
          input.advertise,
          config.mesh?.anchorListen?.advertised?.[0],
        )
      : undefined;
    const relay = input.relay
      ? parseEndpoint(input.relay, "Pairing relay")
      : config.mesh?.relayRegistration;
    if (!advertised && !relay) {
      throw new Error("Pairing requires a direct listener or blind relay");
    }
    const transports: MeshEndpointTransport[] = [
      ...(advertised ? [{ kind: "direct" as const, ...advertised }] : []),
      ...(relay ? [{ kind: "blind-relay" as const, relay }] : []),
    ];
    const enabledRoles = trustRecord.members.find((member) =>
      member.device.deviceId === input.key.deviceId)?.roles ?? ["anchor", "executor"];
    const meshConfiguration = {
      enabledRoles,
      ...(config.mesh?.executorAutoStart !== undefined
        ? { executorAutoStart: config.mesh.executorAutoStart }
        : {}),
      ...(listener && advertised
        ? { anchorListen: { bind: listener.endpoint, advertised: [advertised] } }
        : {}),
      ...(relay ? { relayRegistration: relay } : {}),
    };
    await writeConfig({ ...config, mesh: meshConfiguration }, { homeDir: input.zhixingHome });

    const endpoints = await input.bootstrapProjection.endpoints.loadEndpoints();
    const currentEndpoint = endpoints.get(identity.deviceId);
    const candidate = createMeshEndpointDescriptor({
      deviceId: identity.deviceId,
      configuration: meshConfiguration,
      revision: (currentEndpoint?.revision ?? 0) + 1,
    });
    let issuerEndpoint: MeshEndpointDescriptor;
    let material: PairingOfferMaterial;
    let offers: PairingOfferRepository;
    let invitation: PairingInvitation;
    if (continuation) {
      assertIssuerContinuation(continuation, projection.homeId, identity);
      issuerEndpoint = validateMeshEndpointDescriptor(continuation.issuerEndpoint);
      if (canonicalize(candidate.transports) !== canonicalize(continuation.invitation.transports)) {
        throw new Error("Pairing continuation endpoints differ from the durable invitation");
      }
      if (currentEndpoint && canonicalize(currentEndpoint) !== canonicalize(issuerEndpoint)) {
        throw new Error("Pairing continuation conflicts with the durable endpoint directory");
      }
      if (!currentEndpoint) {
        await input.bootstrapProjection.endpoints.acceptEndpoint(issuerEndpoint);
      }
      const secret = await loadPairingSecret(
        input.secretStore,
        continuation.invitation.offer.offerId,
      );
      material = { offer: continuation.invitation.offer, secret: secret.offerSecret };
      offers = new RestoredPairingOfferRepository(material);
      invitation = restoreInvitation(continuation.invitation, secret.offerSecret);
    } else {
      issuerEndpoint = currentEndpoint &&
        canonicalize(currentEndpoint.transports) === canonicalize(candidate.transports)
        ? currentEndpoint
        : await input.bootstrapProjection.endpoints.acceptEndpoint(candidate);
      const issued = new InMemoryPairingOfferRepository();
      material = issued.issueQr({
        homeId: projection.homeId,
        issuer: identity,
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
      });
      offers = issued;
      const durableInvitation: DurablePairingInvitation = {
        v: 1,
        offer: material.offer,
        issuer: identity,
        rendezvousKey: validateRendezvousKey(`rzv:${randomBytes(32).toString("hex")}`),
        transports,
      };
      const offerSecretPending: PairingIssuerContinuation = {
        v: 1,
        side: "issuer",
        phase: "offer-secret-pending",
        invitation: durableInvitation,
        issuerEndpoint,
      };
      continuation = offerSecretPending;
      await input.continuations.save(offerSecretPending);
      try {
        await persistPairingSecret(input.secretStore, material.offer.offerId, {
          offerSecret: material.secret,
        });
      } catch (error) {
        await deletePairingSecret(input.secretStore, material.offer.offerId);
        await input.continuations.clear(material.offer.offerId);
        throw error;
      }
      continuation = {
        ...offerSecretPending,
        phase: "offered",
      };
      await input.continuations.save(continuation);
      invitation = restoreInvitation(durableInvitation, material.secret);
    }
    assertProductionPairingOffer(material.offer);
    await renderPairingInvitation(encodeInvitation(invitation), input.writeLine);

    const acceptUntil = committedReplay
      ? new Date(Date.now() + PAIRING_TIMEOUT_MS).toISOString()
      : material.offer.expiresAt;
    transport = await acceptPairingConnection(
      listener?.server,
      relay,
      invitation.rendezvousKey,
      acceptUntil,
    );
    const coordinator = new PairingCommitCoordinator(
      input.store.pairingAuthority(),
      offers,
    );
    const firstFrame = await receivePairingFrame(transport);
    if (isRecord(firstFrame) && firstFrame.t === "resume") {
      if (continuation?.phase !== "commit-ready") {
        throw new Error("Pairing resume has no durable commit-ready state");
      }
      const secret = await loadPairingSecret(input.secretStore, material.offer.offerId);
      const resumed = await resumeIssuerPairing({
        input,
        transport,
        continuation,
        resume: asResumeMessage(firstFrame),
        projection,
        offers,
        sessionKey: sessionKeyFromSecret(material.offer, secret),
      });
      pairingCommitted = resumed.committed;
      pairwisePersisted = true;
      peerDeviceId = continuation.join.device.deviceId;
      return;
    }
    if (continuation?.phase !== "offered") {
      throw new Error("Committed pairing continuation requires an authenticated resume frame");
    }
    const joinMessage = asJoinMessage(firstFrame);
    if (joinMessage.firstRound !== undefined) {
      throw new TypeError("High-entropy pairing does not accept PAKE rounds");
    }
    peerDeviceId = joinMessage.join.device.deviceId;
    assertPairingOfferJoin(material.offer, joinMessage.join, identity);
    const attempt = await coordinator.beginQrAttempt({
      current: projection,
      offer: material.offer,
      issuerIdentity: identity,
    });
    const sessionKey = material.secret;
    const pakeRounds: readonly PakeRound[] = [];

    if (!projection.recoveryRootPublicKey) {
      const targetDeviceId = joinMessage.join.device.deviceId;
      const homeId = projection.homeId;
      let activatedCheckpointId: string | undefined;
      projection = await activateInitialRecoveryRoot({
        store: input.store,
        issuerKey: input.key,
        issuerIdentity: identity,
        current: projection,
        targetId: `backup-device:${targetDeviceId}`,
        targetIndependenceDomain: `device:${targetDeviceId}`,
        createTarget: async ({ checkpointId, recipientKeyId }) => {
          activatedCheckpointId = checkpointId;
          await sendPairingFrame(transport!, {
            t: "recovery-onboarding-start",
            homeId,
            sourceDeviceId: identity.deviceId,
            targetDeviceId,
            checkpointId,
            recipientKeyId,
          } satisfies RecoveryOnboardingStartMessage);
          return new PairedRecoveryCheckpointTarget({
            homeId,
            sourceDeviceId: identity.deviceId,
            targetDeviceId,
            recipientKeyId,
            transport: new PairingSocketCheckpointTransport(transport!),
            storageMaintenance: input.storageMaintenance,
          });
        },
        writeLine: input.writeLine,
        ...(input.confirmRecoveryPackage
          ? { confirmRecoveryPackage: input.confirmRecoveryPackage }
          : {}),
      });
      if (!activatedCheckpointId) {
        throw new Error("Recovery activation did not select its pairing target");
      }
      await sendPairingFrame(transport, {
        t: "recovery-onboarding-complete",
        checkpointId: activatedCheckpointId,
      } satisfies RecoveryOnboardingCompleteMessage);
      trustRecord = await input.store.loadTrustRecord();
      if (!trustRecord?.recoveryRootPublicKey) {
        throw new Error("Recovery root activation did not produce a trusted projection");
      }
    }
    await selectInitialPairingBackupTarget({
      zhixingHome: input.zhixingHome,
      store: input.store,
      targetDeviceId: joinMessage.join.device.deviceId,
    });

    const transcriptDigest = pairingTranscriptDigest(material.offer, joinMessage.join, pakeRounds);
    const acceptedAt = new Date().toISOString();
    const trustEvent = createPairingTrustEvent({
      current: projection,
      device: joinMessage.join.device,
      roles: normalizeGrantedRoles(input.roles),
      pairingTranscriptDigest: transcriptDigest,
      at: acceptedAt,
      issuerKey: input.key,
    });
    const acceptanceBody: Omit<PairingAcceptance, "finished"> = {
      v: 1,
      offerId: material.offer.offerId,
      transcriptDigest,
      chainHead: {
        seq: trustEvent.seq,
        eventDigest: homeTrustEventDigest(trustEvent),
      },
      acceptedAt,
    };
    const issuerProof = createPairingAcceptanceProof({
      acceptance: acceptanceBody,
      role: "issuer",
      signer: input.key,
      method: material.offer.method.kind,
      ...(typeof sessionKey === "string" ? {} : { sessionKey }),
    });
    const trustEvents = [...await input.store.loadTrustEvents(), trustEvent];
    await sendPairingFrame(transport, {
      t: "challenge",
      acceptance: acceptanceBody,
      issuerProof,
      trustEvents,
      issuerRootCertificatePem: input.key.rootCertificatePem,
      issuerEndpoint,
    } satisfies PairingChallengeMessage);

    const secretPending: Extract<PairingIssuerContinuation, { phase: "secret-pending" }> = {
      v: 1,
      side: "issuer",
      phase: "secret-pending",
      invitation: stripInvitationSecret(invitation),
      issuerEndpoint,
      attempt,
      join: joinMessage.join,
      joinerRootCertificatePem: joinMessage.rootCertificatePem,
      pakeRounds,
      acceptanceBody,
      issuerProof,
      trustEvent,
    };
    continuation = secretPending;
    await input.continuations.save(secretPending);
    const pairwise = derivePairwiseRendezvousSecret(sessionKey);
    await persistPairwiseRendezvousSecret(input.secretStore, peerDeviceId, pairwise);
    pairwisePersisted = true;
    continuation = {
      ...secretPending,
      phase: "commit-ready",
    };
    await input.continuations.save(continuation);
    const joinerProof = asJoinerProof(await receivePairingFrame(transport));
    const acceptance: PairingAcceptance = {
      ...acceptanceBody,
      finished: assemblePairingFinished({
        method: material.offer.method.kind,
        issuer: issuerProof,
        joiner: joinerProof.proof,
      }),
    };
    await coordinator.commit({
      current: projection,
      offer: material.offer,
      join: joinMessage.join,
      pakeRounds,
      acceptance,
      trustEvent,
      issuerIdentity: identity,
      ...(typeof sessionKey === "string" ? {} : { sessionKey }),
      attempt,
    });
    pairingCommitted = true;
    await input.bootstrapProjection.transportPeers.acceptTransportPeer({
      identity: joinMessage.join.device,
      rootCertificatePem: joinMessage.rootCertificatePem,
    });
    trustRecord = await input.store.loadTrustRecord();
    if (!trustRecord) throw new Error("Pairing commit did not produce a trust projection");
    await sendPairingFrame(transport, {
      t: "committed",
      acceptance,
      trustEvents,
      trustRecord,
      issuerRootCertificatePem: input.key.rootCertificatePem,
      issuerEndpoint,
    } satisfies PairingCommittedMessage);
    const acknowledged = await receivePairingFrame(transport);
    if (!isRecord(acknowledged) || acknowledged.t !== "bootstrap-complete") {
      throw new Error("Pairing peer did not acknowledge bootstrap completion");
    }
    await input.bootstrapProjection.completions.markBootstrapComplete(
      peerDeviceId,
      material.offer.offerId,
    );
    await deletePairingSecret(input.secretStore, material.offer.offerId);
    await input.continuations.clear(material.offer.offerId);
    input.writeLine(`已和“${joinMessage.join.device.displayName}”完成配对。`);
    await completeDutyDeviceSelection({
      options: input,
      isolated: input.isolatedComposition,
      currentDeviceName: identity.displayName,
      pairedDeviceName: joinMessage.join.device.displayName,
      writeLine: input.writeLine,
    });
  } catch (error) {
    if (
      continuation &&
      pairwisePersisted &&
      !pairingCommitted &&
      peerDeviceId &&
      continuation?.phase !== "commit-ready"
    ) {
      const offerId = continuation.invitation.offer.offerId;
      await deletePairwiseRendezvousSecret(input.secretStore, peerDeviceId);
      await deletePairingSecret(input.secretStore, offerId);
      await input.continuations.clear(offerId);
    }
    throw error;
  } finally {
    transport?.destroy();
    if (listener) await closeServer(listener.server);
  }
}

export const PAIRING_TRUST_EVENT_DESCRIPTOR = Object.freeze({
  owner: "current-issuer",
  initial: "enroll",
  reenrollment: "reenroll",
  eligibleState: "pending-reenroll",
  proof: "fresh-pairing-transcript",
});

export function createPairingTrustEvent(input: {
  readonly current: TrustProjection;
  readonly device: DeviceIdentity;
  readonly roles: readonly DeviceRole[];
  readonly pairingTranscriptDigest: string;
  readonly at: string;
  readonly issuerKey: DeviceKey;
}): HomeTrustEvent {
  const member = input.current.members.find((candidate) =>
    candidate.device.deviceId === input.device.deviceId);
  if (member?.state === PAIRING_TRUST_EVENT_DESCRIPTOR.eligibleState) {
    if (canonicalize(member.device) !== canonicalize(input.device)) {
      throw new TypeError("Reenrollment device identity changed");
    }
    return createSignedTrustEvent({
      current: input.current,
      body: {
        t: PAIRING_TRUST_EVENT_DESCRIPTOR.reenrollment,
        deviceId: input.device.deviceId,
        pairingTranscriptDigest: input.pairingTranscriptDigest,
      },
      at: input.at,
      signer: input.issuerKey,
    });
  }
  return createSignedTrustEvent({
    current: input.current,
    body: {
      t: PAIRING_TRUST_EVENT_DESCRIPTOR.initial,
      device: input.device,
      roles: [...input.roles],
      pairingTranscriptDigest: input.pairingTranscriptDigest,
    },
    at: input.at,
    signer: input.issuerKey,
  });
}

async function joinPairing(input: PairingRuntimeInput): Promise<void> {
  let persisted = await input.continuations.load();
  if (persisted?.side === "issuer") {
    throw new Error("A pairing issuer continuation is already active on this device");
  }
  if (persisted?.phase === "secret-pending") {
    await deletePairwiseRendezvousSecret(
      input.secretStore,
      persisted.invitation.issuer.deviceId,
    );
    await deletePairingSecret(input.secretStore, persisted.invitation.offer.offerId);
    await input.continuations.clear(persisted.invitation.offer.offerId);
    persisted = undefined;
  }
  const invitation = input.invitation
    ? decodeInvitation(input.invitation, { allowExpired: persisted?.side === "joiner" })
    : persisted
      ? restoreInvitation(
          persisted.invitation,
          (await loadPairingSecret(
            input.secretStore,
            persisted.invitation.offer.offerId,
          )).offerSecret,
        )
      : undefined;
  if (!invitation) throw new Error("Joining a home requires a pairing invitation");
  assertProductionPairingInvitation(invitation);
  if (persisted && (
    persisted.invitation.offer.offerId !== invitation.offer.offerId ||
    persisted.invitation.issuer.deviceId !== invitation.issuer.deviceId ||
    persisted.localDeviceId !== input.key.deviceId
  )) {
    throw new Error("Pairing invitation differs from the durable continuation");
  }
  if (
    persisted?.phase === "bootstrap-ready" &&
    await input.bootstrapProjection.completions.bootstrapCompleted(
      persisted.invitation.issuer.deviceId,
      persisted.invitation.offer.offerId,
    )
  ) {
    await deletePairingSecret(input.secretStore, persisted.invitation.offer.offerId);
    await input.continuations.clear(persisted.invitation.offer.offerId);
    input.writeLine("这台设备已经准备好，可以开始使用知行了。");
    return;
  }
  if (persisted) {
    await resumeJoinerPairing({ input, invitation, continuation: persisted });
    return;
  }
  if (await input.store.loadTrustProjection()) {
    throw new Error("This device already belongs to a home trust chain");
  }
  const identity = enrollDeviceIdentity(input.key, {
    displayName: hostname(),
    platform: devicePlatform(),
    enrolledAt: new Date().toISOString(),
  });
  let socket: Socket | undefined;
  let peerDeviceId: string | undefined;
  let commitPossible = false;
  try {
    socket = await connectPairingInvitation(invitation);
    peerDeviceId = invitation.issuer.deviceId;
    if (!invitation.qrSecret) throw new Error("High-entropy pairing invitation has no secret");
    const join: PairingJoin = createQrPairingJoin(invitation.offer, identity, invitation.qrSecret);
    assertPairingOfferJoin(invitation.offer, join, invitation.issuer);
    const sessionKey = invitation.qrSecret;
    const pakeRounds: readonly PakeRound[] = [];
    await sendPairingFrame(socket, {
      t: "join",
      join,
      rootCertificatePem: input.key.rootCertificatePem,
    } satisfies JoinMessage);
    const challenge = await receiveChallengeAfterRecoveryOnboarding({
      socket,
      first: await receivePairingFrame(socket),
      invitation,
      identity,
      zhixingHome: input.zhixingHome,
      storageMaintenance: input.storageMaintenance,
    });
    validateChallenge(invitation, join, pakeRounds, challenge);
    const proof = createPairingAcceptanceProof({
      acceptance: challenge.acceptance,
      role: "joiner",
      signer: input.key,
      method: invitation.offer.method.kind,
      ...(typeof sessionKey === "string" ? {} : { sessionKey }),
    });
    const secretPending: Extract<PairingJoinerContinuation, { phase: "secret-pending" }> = {
      v: 1,
      side: "joiner",
      phase: "secret-pending",
      invitation: stripInvitationSecret(invitation),
      localDeviceId: input.key.deviceId,
      join,
      pakeRounds,
      proof,
    };
    await input.continuations.save(secretPending);
    const pairwise = derivePairwiseRendezvousSecret(sessionKey);
    await persistPairwiseRendezvousSecret(input.secretStore, peerDeviceId, pairwise);
    await persistPairingSecret(input.secretStore, invitation.offer.offerId, {
      offerSecret: sessionKey,
    });
    const continuation: PairingJoinerContinuation = {
      ...secretPending,
      phase: "proof-ready",
    };
    await input.continuations.save(continuation);
    commitPossible = true;
    await sendPairingFrame(socket, { t: "joiner-proof", proof } satisfies JoinerProofMessage);
    const committed = asCommitted(await receivePairingFrame(socket));
    validateCommitted(invitation, join, sessionKey, committed);
    const bootstrapContinuation: PairingJoinerContinuation = {
      ...continuation,
      phase: "bootstrap-ready",
      committed: stripCommittedFrame(committed),
    };
    await input.continuations.save(bootstrapContinuation);
    await completeJoinerBootstrap({ input, invitation, committed, socket });
  } catch (error) {
    if (!commitPossible && peerDeviceId) {
      await deletePairingSecret(input.secretStore, invitation.offer.offerId);
      await deletePairwiseRendezvousSecret(input.secretStore, peerDeviceId);
      await input.continuations.clear(invitation.offer.offerId);
    }
    throw error;
  } finally {
    socket?.destroy();
  }
}

async function resumeIssuerPairing(input: {
  readonly input: PairingRuntimeInput;
  readonly transport: Socket;
  readonly continuation: Extract<PairingIssuerContinuation, { phase: "commit-ready" }>;
  readonly resume: PairingResumeMessage;
  readonly projection: ReturnType<typeof replayTrustChain>;
  readonly offers: PairingOfferRepository;
  readonly sessionKey: Buffer | string;
}): Promise<{ readonly committed: true }> {
  const { continuation, resume } = input;
  const peerDeviceId = continuation.join.device.deviceId;
  if (
    resume.offerId !== continuation.invitation.offer.offerId ||
    resume.deviceId !== peerDeviceId
  ) {
    throw new Error("Pairing resume identity does not match the durable continuation");
  }
  const pairwise = await input.input.secretStore.get({
    kind: "rendezvous",
    bindingId: peerDeviceId,
  });
  if (!pairwise || !verifyPairingResumeProof(resume, pairwise)) {
    throw new Error("Pairing resume proof is invalid");
  }
  const acceptance: PairingAcceptance = {
    ...continuation.acceptanceBody,
    finished: assemblePairingFinished({
      method: continuation.invitation.offer.method.kind,
      issuer: continuation.issuerProof,
      joiner: resume.joinerProof,
    }),
  };
  const coordinator = new PairingCommitCoordinator(
    input.input.store.pairingAuthority(),
    input.offers,
  );
  await coordinator.commit({
    current: input.projection,
    offer: continuation.invitation.offer,
    join: continuation.join,
    pakeRounds: continuation.pakeRounds,
    acceptance,
    trustEvent: continuation.trustEvent,
    issuerIdentity: continuation.invitation.issuer,
    ...(typeof input.sessionKey === "string" ? {} : { sessionKey: input.sessionKey }),
    attempt: continuation.attempt,
  });
  await input.input.bootstrapProjection.transportPeers.acceptTransportPeer({
    identity: continuation.join.device,
    rootCertificatePem: continuation.joinerRootCertificatePem,
  });
  const trustEvents = await input.input.store.loadTrustEvents();
  const trustRecord = await input.input.store.loadTrustRecord();
  if (!trustRecord) throw new Error("Pairing resume did not produce a trust projection");
  await sendPairingFrame(input.transport, {
    t: "committed",
    acceptance,
    trustEvents,
    trustRecord,
    issuerRootCertificatePem: input.input.key.rootCertificatePem,
    issuerEndpoint: continuation.issuerEndpoint,
  } satisfies PairingCommittedMessage);
  const acknowledged = await receivePairingFrame(input.transport);
  if (!isRecord(acknowledged) || acknowledged.t !== "bootstrap-complete") {
    throw new Error("Pairing peer did not acknowledge bootstrap completion");
  }
  await input.input.bootstrapProjection.completions.markBootstrapComplete(
    peerDeviceId,
    continuation.invitation.offer.offerId,
  );
  await deletePairingSecret(input.input.secretStore, continuation.invitation.offer.offerId);
  await input.input.continuations.clear(continuation.invitation.offer.offerId);
  input.input.writeLine(`已和“${continuation.join.device.displayName}”完成配对。`);
  await completeDutyDeviceSelection({
    options: input.input,
    isolated: input.input.isolatedComposition,
    currentDeviceName: continuation.invitation.issuer.displayName,
    pairedDeviceName: continuation.join.device.displayName,
    writeLine: input.input.writeLine,
  });
  return { committed: true };
}

async function resumeJoinerPairing(input: {
  readonly input: PairingRuntimeInput;
  readonly invitation: PairingInvitation;
  readonly continuation: PairingJoinerContinuation;
}): Promise<void> {
  const pairwise = await input.input.secretStore.get({
    kind: "rendezvous",
    bindingId: input.continuation.invitation.issuer.deviceId,
  });
  if (!pairwise) throw new Error("Pairing resume secret is unavailable");
  const secret = await loadPairingSecret(
    input.input.secretStore,
    input.continuation.invitation.offer.offerId,
  );
  const sessionKey = sessionKeyFromSecret(input.invitation.offer, secret);
  const socket = await connectPairingInvitation(
    input.invitation,
    new Date(Date.now() + PAIRING_TIMEOUT_MS).toISOString(),
  );
  try {
    await sendPairingFrame(
      socket,
      createPairingResumeMessage(input.continuation, pairwise),
    );
    const committed = asCommitted(await receivePairingFrame(socket));
    validateCommitted(
      input.invitation,
      input.continuation.join,
      sessionKey,
      committed,
    );
    if (
      input.continuation.phase === "bootstrap-ready" &&
      canonicalize(stripCommittedFrame(committed)) !==
        canonicalize(input.continuation.committed)
    ) {
      throw new Error("Pairing resume returned a different committed bootstrap");
    }
    if (input.continuation.phase === "proof-ready") {
      await input.input.continuations.save({
        ...input.continuation,
        phase: "bootstrap-ready",
        committed: stripCommittedFrame(committed),
      });
    }
    await completeJoinerBootstrap({
      input: input.input,
      invitation: input.invitation,
      committed,
      socket,
    });
  } finally {
    socket.destroy();
  }
}

async function completeJoinerBootstrap(input: {
  readonly input: PairingRuntimeInput;
  readonly invitation: PairingInvitation;
  readonly committed: PairingCommittedMessage;
  readonly socket: Socket;
}): Promise<void> {
  await input.input.store.importTrustBootstrap({
    events: input.committed.trustEvents,
    record: input.committed.trustRecord,
    localDeviceId: input.input.key.deviceId,
  });
  await input.input.bootstrapProjection.transportPeers.acceptTransportPeer({
    identity: input.invitation.issuer,
    rootCertificatePem: input.committed.issuerRootCertificatePem,
  });
  await input.input.bootstrapProjection.endpoints.acceptEndpoint(
    input.committed.issuerEndpoint,
  );
  const local = input.committed.trustRecord.members.find((member) =>
    member.device.deviceId === input.input.key.deviceId && member.state === "active");
  if (!local) throw new Error("Pairing trust projection does not contain the local device");
  const config = loadConfig({ homeDir: input.input.zhixingHome });
  const executorAutoStart = await resolveExecutorAutoStartSelection({
    explicit: input.input.executorAutoStart,
    persisted: config.mesh?.executorAutoStart,
    isolated: input.input.isolatedComposition,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: () => requestExecutorAutoStart(input.input),
  });
  const reachability = await resolveJoinerAnchorReachability({
    roles: local.roles,
    invitation: input.invitation,
    configuration: config.mesh,
  });
  await writeConfig({
    ...config,
    mesh: {
      enabledRoles: local.roles,
      executorAutoStart,
      ...reachability,
    },
  }, { homeDir: input.input.zhixingHome });
  await completePairingDeviceConfiguration(input.input);
  await reconcileAfterPairing(input.input, "pairing-joiner-committed");
  await input.input.bootstrapProjection.completions.markBootstrapComplete(
    input.invitation.issuer.deviceId,
    input.invitation.offer.offerId,
  );
  await sendPairingFrame(input.socket, { t: "bootstrap-complete" });
  await deletePairingSecret(input.input.secretStore, input.invitation.offer.offerId);
  await input.input.continuations.clear(input.invitation.offer.offerId);
  input.input.writeLine("这台设备已经准备好，可以开始使用知行了。");
}

async function requestExecutorAutoStart(
  options: PairCommandOptions,
): Promise<boolean> {
  if (options.promptExecutorAutoStart) return options.promptExecutorAutoStart();
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question(
        "让这台电脑开机后自动上线并继续任务？[y/N] ",
      )).trim().toLowerCase();
      if (answer === "" || answer === "n" || answer === "no") return false;
      if (answer === "y" || answer === "yes") return true;
    }
  } finally {
    prompt.close();
  }
}

export async function resolveExecutorAutoStartSelection(input: {
  readonly explicit?: boolean;
  readonly persisted?: boolean;
  readonly isolated: boolean;
  readonly interactive: boolean;
  readonly prompt: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.explicit !== undefined) return input.explicit;
  if (input.persisted !== undefined) return input.persisted;
  if (input.isolated) return false;
  if (!input.interactive) {
    throw new Error("请在交互终端重新运行同一个配对命令，完成这台干活电脑的上线选择");
  }
  return input.prompt();
}

export async function resolveJoinerAnchorReachability(input: {
  readonly roles: readonly DeviceRole[];
  readonly invitation: Pick<PairingInvitation, "transports">;
  readonly configuration?: MeshRoleBootConfig;
}): Promise<Pick<MeshRoleBootConfig, "anchorListen" | "relayRegistration">> {
  if (!input.roles.includes("anchor")) return {};
  if (input.configuration?.anchorListen || input.configuration?.relayRegistration) {
    return {
      ...(input.configuration.anchorListen
        ? { anchorListen: input.configuration.anchorListen }
        : {}),
      ...(input.configuration.relayRegistration
        ? { relayRegistration: input.configuration.relayRegistration }
        : {}),
    };
  }
  const relay = input.invitation.transports.find((transport) =>
    transport.kind === "blind-relay");
  if (relay?.kind === "blind-relay") {
    return { relayRegistration: relay.relay };
  }
  const reservation = await openPairingListener();
  try {
    return {
      anchorListen: {
        bind: reservation.endpoint,
        advertised: [resolveAdvertisedEndpoint(reservation.endpoint)],
      },
    };
  } finally {
    await closeServer(reservation.server);
  }
}

async function completePairingDeviceConfiguration(
  input: PairCommandOptions & {
    readonly isolatedComposition: boolean;
    readonly zhixingHome: string;
    readonly writeLine: (line: string) => void;
  },
): Promise<void> {
  input.writeLine("知行需要在这台设备上登录模型服务。");
  if (input.completeDeviceConfiguration) {
    if (await input.completeDeviceConfiguration() === "cancelled") {
      throw new PairingPublicFacingError(
        "设备配置已取消，已经完成的安全步骤会被保留。请在当前设备重新运行 zz pair 继续。",
      );
    }
  } else if (!input.isolatedComposition) {
    const { runStartupCheck } = await import("../startup.js");
    const result = await runStartupCheck({
      homeDir: input.zhixingHome,
      mode: "pairing",
      isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    });
    if (result.kind === "cancelled") {
      throw new PairingPublicFacingError(
        "设备配置已取消，已经完成的安全步骤会被保留。请在当前设备重新运行 zz pair 继续。",
      );
    }
    if (result.kind !== "ready") {
      throw new PairingPublicFacingError(
        "这台设备尚未准备好。请在交互终端重新运行 zz pair，按提示完成模型服务配置。",
      );
    }
  }
  input.writeLine("这台设备的模型服务已经准备好。");
}

async function completeDutyDeviceSelection(input: {
  readonly options: PairCommandOptions;
  readonly isolated: boolean;
  readonly currentDeviceName: string;
  readonly pairedDeviceName: string;
  readonly writeLine: (line: string) => void;
}): Promise<void> {
  if (input.isolated && !input.options.selectDutyDevice) return;
  input.writeLine("哪台设备长期开机？让它值班。");
  const choice = input.options.selectDutyDevice
    ? await input.options.selectDutyDevice({
        currentDeviceName: input.currentDeviceName,
        pairedDeviceName: input.pairedDeviceName,
      })
    : await requestDutyDeviceChoice(input.currentDeviceName, input.pairedDeviceName);
  if (choice === "current") {
    input.writeLine(`知行继续在“${input.currentDeviceName}”值班。`);
    return;
  }
  try {
    if (input.options.migrateDutyTo) {
      await input.options.migrateDutyTo(input.pairedDeviceName);
    } else {
      const { prepareDutyMigration } = await import("../runtime/duty-migration-command.js");
      await prepareDutyMigration(input.pairedDeviceName, true);
    }
  } catch (error) {
    throw new PairingPublicFacingError(
      `设备已经配对，但值班设备尚未切换。请保持两台设备在线，然后运行 zz duty migrate "${input.pairedDeviceName}"。`,
      { cause: error },
    );
  }
}

async function requestDutyDeviceChoice(
  currentDeviceName: string,
  pairedDeviceName: string,
): Promise<"current" | "paired"> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new PairingPublicFacingError(
      "设备已经配对，但还没有确认值班设备。请在交互终端运行 zz duty migrate 继续。",
    );
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question(
        `1. ${currentDeviceName}\n2. ${pairedDeviceName}\n序号：`,
      )).trim();
      if (answer === "1") return "current";
      if (answer === "2") return "paired";
    }
  } finally {
    prompt.close();
  }
}

async function selectInitialPairingBackupTarget(input: {
  readonly zhixingHome: string;
  readonly store: FileMeshBootstrapStore;
  readonly targetDeviceId: string;
}): Promise<void> {
  const targets = new FileBackupTargetConfiguration(input.zhixingHome);
  if (await targets.load()) return;
  const targetId = `backup-device:${input.targetDeviceId}`;
  const records = await input.store.loadCheckpointRecords();
  const created = [...records].reverse().find((record) =>
    record.t === "checkpoint-created" &&
    record.targetId === targetId &&
    record.purpose.kind === "root-activation");
  if (!created || !records.some((record) =>
    record.t === "checkpoint-verified" &&
    record.checkpointId === created.checkpointId &&
    record.targetId === targetId)) return;
  await targets.select({
    kind: "paired-device",
    targetId,
    deviceId: input.targetDeviceId,
  });
}

class PairingSocketCheckpointTransport implements PairedCheckpointTransport {
  constructor(private readonly socket: Socket) {}

  async request(command: PairedCheckpointCommand): Promise<PairedCheckpointResult> {
    await sendPairingFrame(this.socket, {
      t: "recovery-onboarding-command",
      command,
    } satisfies RecoveryOnboardingCommandMessage);
    const frame = await receivePairingFrame(this.socket);
    if (!isRecord(frame) || frame.t !== "recovery-onboarding-result" || !isRecord(frame.result)) {
      throw new Error("Pairing target returned an invalid recovery checkpoint result");
    }
    assertObjectKeys(frame, ["result", "t"], "Recovery onboarding result");
    return decodePairedCheckpointResult(frame.result);
  }
}

async function receiveChallengeAfterRecoveryOnboarding(input: {
  readonly socket: Socket;
  readonly first: unknown;
  readonly invitation: PairingInvitation;
  readonly identity: DeviceIdentity;
  readonly zhixingHome: string;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
}): Promise<PairingChallengeMessage> {
  if (isRecord(input.first) && input.first.t === "challenge") {
    return asChallenge(input.first);
  }
  const start = recoveryOnboardingStart(input.first);
  if (
    start.homeId !== input.invitation.offer.homeId ||
    start.sourceDeviceId !== input.invitation.issuer.deviceId ||
    start.targetDeviceId !== input.identity.deviceId
  ) throw new Error("Recovery onboarding target does not match this pairing session");
  const targetRoot = `${input.zhixingHome}/distributed-runtime/recovery-checkpoints`;
  const target = await FileRecoveryCheckpointTarget.openPaired({
    targetRoot,
    targetDeviceId: input.identity.deviceId,
    storageMaintenance: input.storageMaintenance,
  });
  try {
    const receiver = new PairedCheckpointReceiver({
      homeId: start.homeId,
      sourceDeviceId: start.sourceDeviceId,
      targetDeviceId: start.targetDeviceId,
      recipientKeyId: start.recipientKeyId,
      staging: new FilePairedCheckpointStaging({
        root: `${input.zhixingHome}/distributed-runtime/recovery-checkpoint-incoming`,
        target,
        storageMaintenance: input.storageMaintenance,
      }),
    });
    while (true) {
      const frame = await receivePairingFrame(input.socket);
      if (isRecord(frame) && frame.t === "recovery-onboarding-complete") {
        assertObjectKeys(frame, ["checkpointId", "t"], "Recovery onboarding completion");
        if (frame.checkpointId !== start.checkpointId) {
          throw new Error("Recovery onboarding completed another checkpoint");
        }
        return asChallenge(await receivePairingFrame(input.socket));
      }
      if (!isRecord(frame) || frame.t !== "recovery-onboarding-command" || !isRecord(frame.command)) {
        throw new Error("Pairing issuer sent an invalid recovery checkpoint command");
      }
      assertObjectKeys(frame, ["command", "t"], "Recovery onboarding command");
      const result = await receiver.request(frame.command as unknown as PairedCheckpointCommand);
      await sendPairingFrame(input.socket, {
        t: "recovery-onboarding-result",
        result,
      } satisfies RecoveryOnboardingResultMessage);
    }
  } finally {
    await target.close();
  }
}

function recoveryOnboardingStart(value: unknown): RecoveryOnboardingStartMessage {
  if (
    !isRecord(value) ||
    value.t !== "recovery-onboarding-start" ||
    typeof value.homeId !== "string" ||
    typeof value.sourceDeviceId !== "string" ||
    typeof value.targetDeviceId !== "string" ||
    typeof value.checkpointId !== "string" ||
    typeof value.recipientKeyId !== "string"
  ) throw new Error("Pairing issuer did not provide a valid recovery onboarding target");
  assertObjectKeys(value, [
    "checkpointId",
    "homeId",
    "recipientKeyId",
    "sourceDeviceId",
    "t",
    "targetDeviceId",
  ], "Recovery onboarding start");
  return value as unknown as RecoveryOnboardingStartMessage;
}

function validateChallenge(
  invitation: PairingInvitation,
  join: PairingJoin,
  pakeRounds: readonly PakeRound[],
  challenge: PairingChallengeMessage,
): void {
  const projection = replayTrustChain(challenge.trustEvents);
  const last = challenge.trustEvents.at(-1);
  if (
    !last ||
    last.body.t !== "enroll" ||
    last.body.device.deviceId !== join.device.deviceId ||
    challenge.acceptance.offerId !== invitation.offer.offerId ||
    challenge.acceptance.transcriptDigest !== pairingTranscriptDigest(invitation.offer, join, pakeRounds) ||
    challenge.acceptance.chainHead.seq !== last.seq ||
    challenge.acceptance.chainHead.eventDigest !== homeTrustEventDigest(last) ||
    projection.homeId !== invitation.offer.homeId
  ) {
    throw new Error("Pairing challenge is not bound to the requested enrollment");
  }
  verifyDeviceSignature(
    invitation.issuer,
    "PairingAcceptance",
    1,
    challenge.acceptance,
    challenge.issuerProof.sig,
  );
  validateMeshEndpointDescriptor(challenge.issuerEndpoint);
}

function validateCommitted(
  invitation: PairingInvitation,
  join: PairingJoin,
  sessionKey: Buffer | string,
  committed: PairingCommittedMessage,
): void {
  const projection = replayTrustChain(committed.trustEvents);
  verifyHomeTrustRecord(committed.trustRecord, projection);
  const event = committed.trustEvents.at(-1);
  if (!event || committed.acceptance.chainHead.eventDigest !== homeTrustEventDigest(event)) {
    throw new Error("Pairing commit is missing its enrollment event");
  }
  const next = applyTrustEvent(
    replayTrustChain(committed.trustEvents.slice(0, -1)),
    event,
  );
  if (canonicalize(next.chainHead) !== canonicalize(projection.chainHead)) {
    throw new Error("Pairing trust chain did not advance exactly once");
  }
  const finished = committed.acceptance.finished;
  const expectedMethod = invitation.offer.method.kind;
  if (finished.method !== expectedMethod) throw new Error("Pairing acceptance method changed");
  verifyPairingAcceptance({
    acceptance: committed.acceptance,
    offer: invitation.offer,
    issuer: invitation.issuer,
    joiner: join.device,
    ...(typeof sessionKey === "string" ? {} : { sessionKey }),
  });
}

async function openPairingListener(
  configured?: { readonly host: string; readonly port: number } | string,
): Promise<{ server: Server; endpoint: { host: string; port: number } }> {
  const endpoint = typeof configured === "string"
    ? parseEndpoint(configured, "Pairing listen endpoint")
    : configured ?? { host: "0.0.0.0", port: 0 };
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.port, endpoint.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Pairing listener has no TCP address");
  return { server, endpoint: { host: endpoint.host, port: address.port } };
}

function resolveAdvertisedEndpoint(
  bound: { host: string; port: number },
  explicit?: string,
  configured?: { readonly host: string; readonly port: number },
): { host: string; port: number } {
  if (explicit) {
    const parsed = parseEndpoint(explicit, "Pairing advertised endpoint");
    return { host: parsed.host, port: parsed.port === 0 ? bound.port : parsed.port };
  }
  if (configured) return { host: configured.host, port: configured.port };
  const host = isWildcardHost(bound.host) ? localNetworkAddress() : bound.host;
  return { host, port: bound.port };
}

async function acceptPairingConnection(
  server: Server | undefined,
  relay: { host: string; port: number } | undefined,
  rendezvousKey: string,
  expiresAt: string,
): Promise<Socket> {
  const deadline = AbortSignal.timeout(Math.max(1, Date.parse(expiresAt) - Date.now()));
  const candidates: PairingConnectionCandidate[] = [];
  if (server) {
    candidates.push(createPairingConnectionCandidate(async (signal) => {
      const socket = await acceptSocket(server, signal);
      await waitForPairingPeer(socket, signal);
      return socket;
    }, deadline));
  }
  if (relay) {
    candidates.push(createPairingConnectionCandidate(async (signal) => {
      const socket = await connectRelay(relay, rendezvousKey, signal);
      await waitForPairingPeer(socket, signal);
      return socket;
    }, deadline));
  }
  try {
    const winner = await Promise.any(candidates.map(async (candidate) => ({
      candidate,
      socket: await candidate.socket,
    })));
    for (const candidate of candidates) {
      if (candidate !== winner.candidate) candidate.cancel();
    }
    pairingDeadlines.set(winner.socket, deadline);
    return winner.socket;
  } catch (error) {
    for (const candidate of candidates) candidate.cancel();
    throw new Error("Pairing invitation expired before a peer connected", { cause: error });
  }
}

interface PairingConnectionCandidate {
  readonly socket: Promise<Socket>;
  readonly cancel: () => void;
}

function createPairingConnectionCandidate(
  connectCandidate: (signal: AbortSignal) => Promise<Socket>,
  deadline: AbortSignal,
): PairingConnectionCandidate {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([deadline, cancellation.signal]);
  return {
    socket: connectCandidate(signal).catch((error) => {
      if (signal.aborted) throw signal.reason;
      throw error;
    }),
    cancel: () => cancellation.abort(new Error("Another pairing transport connected first")),
  };
}

function waitForPairingPeer(socket: Socket, signal: AbortSignal): Promise<void> {
  if (socket.readableLength > 0) return Promise.resolve();
  if (signal.aborted) {
    socket.destroy();
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener("readable", onReadable);
      socket.removeListener("end", onClosed);
      socket.removeListener("close", onClosed);
      socket.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onReadable = () => { cleanup(); resolve(); };
    const onClosed = () => { cleanup(); reject(new Error("Pairing connection closed before peer data arrived")); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(signal.reason);
    };
    socket.once("readable", onReadable);
    socket.once("end", onClosed);
    socket.once("close", onClosed);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function connectPairingInvitation(
  invitation: PairingInvitation,
  expiresAt = invitation.offer.expiresAt,
): Promise<Socket> {
  const signal = AbortSignal.timeout(Math.max(1, Date.parse(expiresAt) - Date.now()));
  const errors: unknown[] = [];
  for (const transport of invitation.transports) {
    try {
      if (transport.kind === "direct") {
        const socket = await connectSocket({ host: transport.host, port: transport.port }, signal);
        pairingDeadlines.set(socket, signal);
        return socket;
      }
      const socket = await connectRelay(transport.relay, invitation.rendezvousKey, signal);
      pairingDeadlines.set(socket, signal);
      return socket;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "No pairing rendezvous endpoint was reachable");
}

async function connectRelay(
  relay: { host: string; port: number },
  rendezvousKey: string,
  signal: AbortSignal,
): Promise<Socket> {
  const socket = await connectSocket(relay, signal);
  await writeSocket(socket, encodeBlindRendezvousHello({
    v: 1,
    key: validateRendezvousKey(rendezvousKey),
    ttlMs: Math.min(PAIRING_TIMEOUT_MS, 3_600_000),
  }), signal);
  return socket;
}

function acceptSocket(server: Server, signal: AbortSignal): Promise<Socket> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("connection", onConnection);
      signal.removeEventListener("abort", onAbort);
    };
    const onConnection = (socket: Socket) => { cleanup(); resolve(socket); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    server.once("connection", onConnection);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function connectSocket(endpoint: { host: string; port: number }, signal: AbortSignal): Promise<Socket> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onError = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(signal.reason); };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sendPairingFrame(socket: Socket, value: unknown): Promise<void> {
  const body = Buffer.from(canonicalize(value), "utf8");
  if (body.byteLength > MAX_PAIRING_FRAME_BYTES) throw new Error("Pairing frame exceeds its byte limit");
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  await writeSocket(socket, frame, requirePairingDeadline(socket));
}

async function receivePairingFrame(socket: Socket): Promise<unknown> {
  const signal = requirePairingDeadline(socket);
  const header = await readExactly(socket, 4, signal);
  const length = header.readUInt32BE(0);
  if (length < 1 || length > MAX_PAIRING_FRAME_BYTES) throw new Error("Pairing frame length is invalid");
  const body = await readExactly(socket, length, signal);
  const text = body.toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text) throw new Error("Pairing frame is not canonical");
  return value;
}

async function readExactly(
  socket: Socket,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  while (received < length) {
    const chunk = socket.read(length - received) as Buffer | null;
    if (chunk) {
      chunks.push(chunk);
      received += chunk.byteLength;
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        socket.destroy();
        reject(signal.reason);
        return;
      }
      const cleanup = () => {
        socket.removeListener("readable", onReadable);
        socket.removeListener("end", onClose);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        signal.removeEventListener("abort", onAbort);
      };
      const onReadable = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Pairing connection closed")); };
      const onAbort = () => {
        cleanup();
        socket.destroy();
        reject(signal.reason);
      };
      socket.once("readable", onReadable);
      socket.once("end", onClose);
      socket.once("error", onError);
      socket.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return Buffer.concat(chunks, length);
}

function writeSocket(
  socket: Socket,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    socket.destroy();
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      socket.destroy();
      finish(signal.reason instanceof Error ? signal.reason : new Error("Pairing operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.write(bytes, finish);
  });
}

function requirePairingDeadline(socket: Socket): AbortSignal {
  const signal = pairingDeadlines.get(socket);
  if (!signal) throw new Error("Pairing socket has no absolute session deadline");
  return signal;
}

function encodeInvitation(invitation: PairingInvitation): string {
  return Buffer.from(canonicalize(invitation), "utf8").toString("base64url");
}

function decodeInvitation(
  encoded: string,
  options: { readonly allowExpired?: boolean } = {},
): PairingInvitation {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("Pairing invitation encoding is invalid");
  const text = bytes.toString("utf8");
  const value = JSON.parse(text) as unknown;
  if (canonicalize(value) !== text || !isRecord(value) || value.v !== 1) {
    throw new Error("Pairing invitation is invalid");
  }
  assertExactKeys(value, ["issuer", "offer", "qrSecret", "rendezvousKey", "transports", "v"]);
  if (!Array.isArray(value.transports) || value.transports.length === 0) {
    throw new Error("Pairing invitation has no rendezvous transport");
  }
  validateRendezvousKey(value.rendezvousKey);
  const descriptor = validateMeshEndpointDescriptor({
    v: 1,
    deviceId: (value.issuer as DeviceIdentity).deviceId,
    transports: value.transports,
    revision: 1,
    at: new Date(0).toISOString(),
  });
  const invitation = value as unknown as PairingInvitation;
  if (
    invitation.offer.issuer.deviceId !== invitation.issuer.deviceId ||
    (!options.allowExpired && Date.parse(invitation.offer.expiresAt) <= Date.now()) ||
    (invitation.offer.method.kind === "qr-secret" && !invitation.qrSecret) ||
    (invitation.offer.method.kind === "short-pake" && invitation.qrSecret !== undefined)
  ) {
    throw new Error("Pairing invitation offer is invalid");
  }
  return { ...invitation, transports: descriptor.transports };
}

function asJoinMessage(value: unknown): JoinMessage {
  if (!isRecord(value) || value.t !== "join" || !isRecord(value.join) || typeof value.rootCertificatePem !== "string") {
    throw new Error("Pairing join frame is invalid");
  }
  return value as unknown as JoinMessage;
}

function asChallenge(value: unknown): PairingChallengeMessage {
  if (!isRecord(value) || value.t !== "challenge" || !Array.isArray(value.trustEvents)) {
    throw new Error("Pairing challenge is invalid");
  }
  return value as unknown as PairingChallengeMessage;
}

function asJoinerProof(value: unknown): JoinerProofMessage {
  if (!isRecord(value) || value.t !== "joiner-proof" || !isRecord(value.proof)) {
    throw new Error("Pairing joiner proof is invalid");
  }
  return value as unknown as JoinerProofMessage;
}

function asCommitted(value: unknown): PairingCommittedMessage {
  if (!isRecord(value) || value.t !== "committed" || !Array.isArray(value.trustEvents)) {
    throw new Error("Pairing commit response is invalid");
  }
  return value as unknown as PairingCommittedMessage;
}

function asResumeMessage(value: unknown): PairingResumeMessage {
  if (
    !isRecord(value) ||
    value.t !== "resume" ||
    typeof value.offerId !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.proof !== "string" ||
    !isRecord(value.joinerProof)
  ) {
    throw new Error("Pairing resume frame is invalid");
  }
  assertExactKeys(value, ["deviceId", "joinerProof", "nonce", "offerId", "proof", "t"]);
  return value as unknown as PairingResumeMessage;
}

interface PersistedPairingSecret {
  readonly v: 1;
  readonly offerSecret: string;
  readonly sessionKey?: string;
}

class RestoredPairingOfferRepository implements PairingOfferRepository {
  #material: PairingOfferMaterial | undefined;

  constructor(material: PairingOfferMaterial) {
    this.#material = material;
  }

  get(offerId: string): PairingOfferMaterial | undefined {
    return this.#material?.offer.offerId === offerId ? this.#material : undefined;
  }

  remove(offerId: string): void {
    if (this.#material?.offer.offerId === offerId) this.#material = undefined;
  }
}

function stripInvitationSecret(invitation: PairingInvitation): DurablePairingInvitation {
  return {
    v: 1,
    offer: invitation.offer,
    issuer: invitation.issuer,
    rendezvousKey: invitation.rendezvousKey,
    transports: invitation.transports,
  };
}

function stripCommittedFrame(
  committed: PairingCommittedMessage,
): DurablePairingBootstrap {
  return {
    acceptance: committed.acceptance,
    trustEvents: committed.trustEvents,
    trustRecord: committed.trustRecord,
    issuerRootCertificatePem: committed.issuerRootCertificatePem,
    issuerEndpoint: committed.issuerEndpoint,
  };
}

function restoreInvitation(
  invitation: DurablePairingInvitation,
  offerSecret: string,
): PairingInvitation {
  return {
    ...invitation,
    ...(invitation.offer.method.kind === "qr-secret" ? { qrSecret: offerSecret } : {}),
  };
}

function assertIssuerContinuation(
  continuation: PairingIssuerContinuation,
  homeId: string,
  identity: DeviceIdentity,
): void {
  if (
    continuation.invitation.offer.homeId !== homeId ||
    continuation.invitation.offer.issuer.deviceId !== identity.deviceId ||
    canonicalize(continuation.invitation.issuer) !== canonicalize(identity)
  ) {
    throw new Error("Pairing continuation is not bound to the local home issuer");
  }
  validateRendezvousKey(continuation.invitation.rendezvousKey);
  validateMeshEndpointDescriptor(continuation.issuerEndpoint);
}

async function persistPairingSecret(
  store: SecretStorePort,
  offerId: string,
  secret: Omit<PersistedPairingSecret, "v">,
): Promise<void> {
  const value = canonicalize({ v: 1, ...secret } satisfies PersistedPairingSecret);
  const ref = { kind: "rendezvous" as const, bindingId: `pairing:${offerId}` };
  await store.put(ref, value);
  if (await store.get(ref) !== value) {
    throw new Error("Pairing continuation secret did not survive durable read-back");
  }
}

async function loadPairingSecret(
  store: SecretStorePort,
  offerId: string,
): Promise<PersistedPairingSecret> {
  const text = await store.get({ kind: "rendezvous", bindingId: `pairing:${offerId}` });
  if (!text) throw new Error("Pairing continuation secret is unavailable");
  const value = JSON.parse(text) as unknown;
  if (
    canonicalize(value) !== text ||
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.offerSecret !== "string" ||
    value.offerSecret.length === 0 ||
    value.sessionKey !== undefined && typeof value.sessionKey !== "string"
  ) {
    throw new Error("Pairing continuation secret is invalid");
  }
  assertExactKeys(value, ["offerSecret", "sessionKey", "v"]);
  return value as unknown as PersistedPairingSecret;
}

async function loadPendingFullRootActivation(
  store: FileMeshBootstrapStore,
  current: TrustProjection,
  targetId: string,
): Promise<{
  readonly checkpoint: CheckpointPackage;
  readonly plan: Extract<
    CheckpointPackage["envelope"]["manifest"]["purpose"],
    { kind: "root-activation" }
  >["plan"];
} | undefined> {
  const records = await store.loadCheckpointRecords();
  const terminal = new Set(records
    .filter((record) => record.t === "checkpoint-verified")
    .map((record) => record.checkpointId));
  const created = [...records].reverse().find((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-created" }
  > =>
    record.t === "checkpoint-created" &&
    record.targetId === targetId &&
    record.purpose.kind === "root-activation" &&
    !terminal.has(record.checkpointId));
  if (!created) return undefined;
  const envelopeBytes = await store.artifactStore().get(created.envelopeRef);
  const envelopeText = Buffer.from(envelopeBytes).toString("utf8");
  const envelope = JSON.parse(envelopeText) as CheckpointPackage["envelope"];
  if (
    canonicalize(envelope) !== envelopeText ||
    envelope.checkpointId !== created.checkpointId ||
    envelope.digest !== created.envelopeDigest ||
    envelope.manifest.purpose.kind !== "root-activation" ||
    envelope.manifest.purpose.plan.rootEvent.homeId !== current.homeId ||
    envelope.manifest.purpose.plan.rootEvent.seq !== current.chainHead.seq + 1 ||
    envelope.manifest.purpose.plan.rootEvent.prevEventDigest !== current.chainHead.eventDigest
  ) throw new Error("Pending recovery activation does not match the current trust prefix");
  const chunks = await Promise.all(envelope.chunks.map(async (descriptor) => ({
    seq: descriptor.seq,
    bytes: Buffer.from(await store.artifactStore().get({
      digest: descriptor.digest,
      bytes: descriptor.bytes,
    })),
  })));
  return {
    checkpoint: { envelope, chunks },
    plan: envelope.manifest.purpose.plan,
  };
}

function deletePairingSecret(store: SecretStorePort, offerId: string): Promise<void> {
  return store.delete({ kind: "rendezvous", bindingId: `pairing:${offerId}` });
}

function sessionKeyFromSecret(
  offer: PairingOffer,
  secret: PersistedPairingSecret,
): Buffer | string {
  assertProductionPairingOffer(offer);
  return secret.offerSecret;
}

function assertProductionPairingOffer(offer: PairingOffer): asserts offer is PairingOffer & {
  readonly method: { readonly kind: "qr-secret" };
} {
  if (offer.method.kind !== "qr-secret") {
    throw new Error("This release only accepts audited high-entropy pairing invitations");
  }
}

function assertProductionPairingInvitation(invitation: PairingInvitation): void {
  assertProductionPairingOffer(invitation.offer);
  if (!invitation.qrSecret) {
    throw new Error("High-entropy pairing invitation has no secret");
  }
}

function createPairingResumeMessage(
  continuation: PairingJoinerContinuation,
  pairwiseSecret: string,
): PairingResumeMessage {
  const nonce = randomBytes(32).toString("base64url");
  const body = {
    offerId: continuation.invitation.offer.offerId,
    deviceId: continuation.localDeviceId,
    nonce,
  };
  return {
    t: "resume",
    ...body,
    proof: pairingResumeProof(body, pairwiseSecret),
    joinerProof: continuation.proof,
  };
}

function verifyPairingResumeProof(
  message: PairingResumeMessage,
  pairwiseSecret: string,
): boolean {
  const expected = pairingResumeProof({
    offerId: message.offerId,
    deviceId: message.deviceId,
    nonce: message.nonce,
  }, pairwiseSecret);
  const actualBytes = Buffer.from(message.proof, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function pairingResumeProof(
  body: { readonly offerId: string; readonly deviceId: string; readonly nonce: string },
  pairwiseSecret: string,
): string {
  return createHmac("sha256", Buffer.from(pairwiseSecret, "base64url"))
    .update("zhixing:pairing-resume:v1", "utf8")
    .update(Buffer.from([0]))
    .update(canonicalize(body), "utf8")
    .digest("base64url");
}

function normalizeGrantedRoles(value: readonly DeviceRole[] | undefined): readonly DeviceRole[] {
  const roles = value ?? ["anchor", "executor"];
  if (
    roles.length === 0 ||
    roles.some((role) => role !== "anchor" && role !== "executor" && role !== "surface")
  ) {
    throw new Error("Pairing contains an unsupported device capability");
  }
  return [...new Set(roles)].sort();
}

function parseEndpoint(value: string, label: string): { host: string; port: number } {
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw new Error(`${label} must use host:port`);
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!host || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${label} is invalid`);
  }
  return { host, port };
}

function localNetworkAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("No routable local address was found");
}

function devicePlatform(): DeviceIdentity["platform"] {
  const current = platform();
  if (current === "win32") return "windows";
  if (current === "darwin") return "macos";
  if (current === "linux") return "linux";
  return "headless";
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = allowed.filter((key) => value[key] !== undefined).sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Pairing invitation contains unknown fields");
  }
}

function assertObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
