import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces, hostname, platform } from "node:os";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline/promises";
import {
  getZhixingHome,
} from "@zhixing/core";
import type {
  DeviceIdentity,
  DeviceRole,
  HomeTrustEvent,
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
  createRootActivationCheckpoint,
  type CheckpointPackage,
} from "@zhixing/mesh/checkpoint";
import {
  enrollDeviceIdentity,
  verifyDeviceSignature,
  type DeviceKey,
} from "@zhixing/mesh/device-identity";
import {
  assemblePairingFinished,
  assertPairingOfferJoin,
  CIPHERMAN_PAIRING_PAKE_SUITES,
  createPairingAcceptanceProof,
  createQrPairingJoin,
  InMemoryPairingOfferRepository,
  pairingTranscriptDigest,
  PakeJoinerSession,
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
import { createPlatformSecretStore } from "@zhixing/secrets";
import { loadConfig, writeConfig } from "@zhixing/providers";
import { loadOrCreateDeviceKey } from "./mesh-device-key.js";
import { createStdoutWriter } from "../screen/index.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import {
  FileMeshPairingContinuationStore,
  type DurablePairingInvitation,
  type DurablePairingBootstrap,
  type PairingIssuerContinuation,
  type PairingJoinerContinuation,
} from "./mesh-pairing-continuation.js";

const PAIRING_TIMEOUT_MS = 120_000;
const MAX_PAIRING_FRAME_BYTES = 1024 * 1024;
const pairingDeadlines = new WeakMap<Socket, AbortSignal>();

export interface PairCommandOptions {
  readonly invitation?: string;
  readonly method?: "qr" | "short";
  readonly shortCode?: string;
  readonly listen?: string;
  readonly advertise?: string;
  readonly relay?: string;
  readonly relayOnly?: boolean;
  readonly roles?: readonly DeviceRole[];
  readonly zhixingHome?: string;
  readonly secretStore?: SecretStorePort;
  readonly writeLine?: (line: string) => void;
  readonly confirmRecoveryPackage?: (recoveryPackage: string) => Promise<string>;
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

interface PakeResponseMessage {
  readonly t: "pake-response";
  readonly round: PakeRound;
}

interface PakeFinishMessage {
  readonly t: "pake-finish";
  readonly round: PakeRound;
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

interface EncodedRecoveryPackage {
  readonly v: 1;
  readonly recoverySecret: string;
  readonly checkpoint: {
    readonly envelope: CheckpointPackage["envelope"];
    readonly chunks: readonly {
      readonly seq: number;
      readonly bytes: string;
    }[];
  };
}

/** Runs the same executable as pairing issuer or joiner without loading the agent runtime. */
export async function runPairCommand(options: PairCommandOptions = {}): Promise<void> {
  const zhixingHome = options.zhixingHome ?? getZhixingHome();
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
  const continuations = new FileMeshPairingContinuationStore(zhixingHome);
  const writeLine: (line: string) => void =
    options.writeLine ?? createStdoutWriter().line;
  const continuation = await continuations.load();
  if (options.invitation || continuation?.side === "joiner") {
    await joinPairing({
      ...options,
      ...(options.invitation ? { invitation: options.invitation } : {}),
      zhixingHome,
      secretStore,
      key,
      store,
      continuations,
      writeLine,
    });
    return;
  }
  await issuePairing({
    ...options,
    zhixingHome,
    secretStore,
    key,
    store,
    continuations,
    writeLine,
  });
}

export async function activateInitialRecoveryRoot(input: {
  readonly store: FileMeshBootstrapStore;
  readonly issuerKey: DeviceKey;
  readonly issuerIdentity: DeviceIdentity;
  readonly current: TrustProjection;
  readonly writeLine: (line: string) => void;
  readonly confirmRecoveryPackage?: (recoveryPackage: string) => Promise<string>;
}): Promise<TrustProjection> {
  if (input.current.recoveryRootPublicKey || input.current.recoveryBackupPublicKey) {
    throw new Error("Recovery root is already active");
  }
  const recoveryRoot = RecoveryRoot.generate();
  const createdAt = new Date().toISOString();
  const rootEvent = createRecoveryRootEvent({
    current: input.current,
    op: "establish",
    candidate: recoveryRoot,
    outerSigner: input.issuerKey,
    at: createdAt,
  });
  const plan = {
    v: 1 as const,
    kind: "establish" as const,
    rootEvent,
  };
  const checkpoint = createRootActivationCheckpoint({
    checkpointId: createCheckpointId(),
    createdAt,
    plan,
    recoveryRoot,
    issuer: input.issuerKey,
    scope: ["trust"],
    domainRevisions: { trust: input.current.chainHead.seq },
    upToLsn: input.current.chainHead.seq,
    plaintextChunks: [
      Buffer.from(canonicalize(await input.store.loadTrustEvents()), "utf8"),
    ],
  });
  const recoveryPackage = encodeRecoveryPackage(recoveryRoot, checkpoint);
  input.writeLine(`Recovery package: ${recoveryPackage}`);

  let independentCopy: CheckpointPackage | undefined;
  const confirm = input.confirmRecoveryPackage ?? promptRecoveryPackage;
  const coordinator = new RecoveryActivationCoordinator(input.store.bootstrapAuthority());
  const next = await coordinator.activatePrepared({
    current: input.current,
    plan,
    checkpoint,
    candidateRoot: recoveryRoot,
    issuerIdentity: input.issuerIdentity,
    target: {
      targetId: `user-recovery-package:${checkpoint.envelope.checkpointId}`,
      independenceDomain: "offline:user-held-recovery-package",
      writeDurable: async (candidate) => {
        if (canonicalCheckpoint(candidate) !== canonicalCheckpoint(checkpoint)) {
          throw new Error("Recovery checkpoint changed before independent copy verification");
        }
        const confirmed = await confirm(recoveryPackage);
        const decoded = decodeRecoveryPackage(confirmed);
        if (
          decoded.root.rootPublicKey !== recoveryRoot.rootPublicKey ||
          decoded.root.backupPublicKey !== recoveryRoot.backupPublicKey ||
          canonicalCheckpoint(decoded.checkpoint) !== canonicalCheckpoint(checkpoint)
        ) {
          throw new Error("Recovery package read-back does not match the generated package");
        }
        independentCopy = decoded.checkpoint;
      },
      read: async (checkpointId) => {
        if (
          !independentCopy ||
          independentCopy.envelope.checkpointId !== checkpointId
        ) {
          throw new Error("Recovery package has not survived independent read-back");
        }
        return independentCopy;
      },
    },
    sourceIndependenceDomain: `device:${input.issuerKey.deviceId}`,
    now: () => new Date().toISOString(),
  });
  input.writeLine("Recovery root activated after independent package verification.");
  return next;
}

async function issuePairing(input: PairCommandOptions & {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly key: DeviceKey;
  readonly store: FileMeshBootstrapStore;
  readonly continuations: FileMeshPairingContinuationStore;
  readonly writeLine: (line: string) => void;
}): Promise<void> {
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

  if (!projection.recoveryRootPublicKey) {
    projection = await activateInitialRecoveryRoot({
      store: input.store,
      issuerKey: input.key,
      issuerIdentity: identity,
      current: projection,
      writeLine: input.writeLine,
      ...(input.confirmRecoveryPackage
        ? { confirmRecoveryPackage: input.confirmRecoveryPackage }
        : {}),
    });
    trustRecord = await input.store.loadTrustRecord();
    if (!trustRecord?.recoveryRootPublicKey) {
      throw new Error("Recovery root activation did not produce a trusted projection");
    }
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
    await input.store.bootstrapCompleted(
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
      ...(listener && advertised
        ? { anchorListen: { bind: listener.endpoint, advertised: [advertised] } }
        : {}),
      ...(relay ? { relayRegistration: relay } : {}),
    };
    await writeConfig({ ...config, mesh: meshConfiguration }, { homeDir: input.zhixingHome });

    const endpoints = await input.store.loadEndpoints();
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
      if (!currentEndpoint) await input.store.acceptEndpoint(issuerEndpoint);
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
        : await input.store.acceptEndpoint(candidate);
      const issued = new InMemoryPairingOfferRepository();
      material = input.method === "short"
        ? issued.issueShortCode({
            homeId: projection.homeId,
            issuer: identity,
            protocolVersion: EXECUTION_PROTOCOL_VERSION,
          })
        : issued.issueQr({
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
    input.writeLine(`Pairing invitation: ${encodeInvitation(invitation)}`);
    if (material.offer.method.kind === "short-pake") {
      input.writeLine(`Pairing code: ${material.secret}`);
    }

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
      CIPHERMAN_PAIRING_PAKE_SUITES,
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
    peerDeviceId = joinMessage.join.device.deviceId;
    assertPairingOfferJoin(material.offer, joinMessage.join, identity);
    let attempt;
    let sessionKey: Buffer | string;
    let pakeRounds: readonly PakeRound[] = [];
    if (material.offer.method.kind === "short-pake") {
      if (!joinMessage.firstRound) throw new TypeError("Short-code pairing requires a joiner PAKE round");
      const started = await coordinator.beginShortCodeAttempt({
        current: projection,
        offer: material.offer,
        join: joinMessage.join,
        joinerRound: joinMessage.firstRound,
        issuerIdentity: identity,
      });
      attempt = started.attempt;
      await sendPairingFrame(transport, { t: "pake-response", round: started.session.responseRound } satisfies PakeResponseMessage);
      const finish = asPakeFinish(await receivePairingFrame(transport));
      sessionKey = await started.session.finish(finish.round);
      pakeRounds = [joinMessage.firstRound, started.session.responseRound, finish.round];
    } else {
      attempt = await coordinator.beginQrAttempt({
        current: projection,
        offer: material.offer,
        issuerIdentity: identity,
      });
      sessionKey = material.secret;
    }

    const transcriptDigest = pairingTranscriptDigest(material.offer, joinMessage.join, pakeRounds);
    const acceptedAt = new Date().toISOString();
    const trustEvent = createSignedTrustEvent({
      current: projection,
      body: {
        t: "enroll",
        device: joinMessage.join.device,
        roles: [...normalizeGrantedRoles(input.roles)],
        pairingTranscriptDigest: transcriptDigest,
      },
      at: acceptedAt,
      signer: input.key,
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
    if (material.offer.method.kind === "short-pake") {
      await persistPairingSecret(input.secretStore, material.offer.offerId, {
        offerSecret: material.secret,
        sessionKey: Buffer.from(sessionKey).toString("base64url"),
      });
    }
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
    await input.store.acceptTransportPeer({
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
    await input.store.markBootstrapComplete(peerDeviceId, material.offer.offerId);
    await deletePairingSecret(input.secretStore, material.offer.offerId);
    await input.continuations.clear(material.offer.offerId);
    input.writeLine(`Paired device: ${peerDeviceId}`);
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

async function joinPairing(input: PairCommandOptions & {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly key: DeviceKey;
  readonly store: FileMeshBootstrapStore;
  readonly continuations: FileMeshPairingContinuationStore;
  readonly writeLine: (line: string) => void;
}): Promise<void> {
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
  if (persisted && (
    persisted.invitation.offer.offerId !== invitation.offer.offerId ||
    persisted.invitation.issuer.deviceId !== invitation.issuer.deviceId ||
    persisted.localDeviceId !== input.key.deviceId
  )) {
    throw new Error("Pairing invitation differs from the durable continuation");
  }
  if (
    persisted?.phase === "bootstrap-ready" &&
    await input.store.bootstrapCompleted(
      persisted.invitation.issuer.deviceId,
      persisted.invitation.offer.offerId,
    )
  ) {
    await deletePairingSecret(input.secretStore, persisted.invitation.offer.offerId);
    await input.continuations.clear(persisted.invitation.offer.offerId);
    input.writeLine(`Joined home: ${persisted.committed.trustRecord.homeId}`);
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
    let join: PairingJoin;
    let sessionKey: Buffer | string;
    let pakeRounds: readonly PakeRound[] = [];
    if (invitation.offer.method.kind === "short-pake") {
      if (!input.shortCode) throw new Error("Short-code pairing requires --code");
      const started = await PakeJoinerSession.start(
        invitation.offer,
        identity,
        input.shortCode,
        CIPHERMAN_PAIRING_PAKE_SUITES,
      );
      join = started.join;
      assertPairingOfferJoin(invitation.offer, join, invitation.issuer);
      await sendPairingFrame(socket, {
        t: "join",
        join,
        rootCertificatePem: input.key.rootCertificatePem,
        firstRound: started.session.firstRound,
      } satisfies JoinMessage);
      const response = asPakeResponse(await receivePairingFrame(socket));
      const finalRound = started.session.finish(response.round);
      sessionKey = started.session.sessionKey();
      pakeRounds = [started.session.firstRound, response.round, finalRound];
      await sendPairingFrame(socket, { t: "pake-finish", round: finalRound } satisfies PakeFinishMessage);
    } else {
      if (!invitation.qrSecret) throw new Error("QR pairing invitation has no secret");
      join = createQrPairingJoin(invitation.offer, identity, invitation.qrSecret);
      assertPairingOfferJoin(invitation.offer, join, invitation.issuer);
      sessionKey = invitation.qrSecret;
      await sendPairingFrame(socket, {
        t: "join",
        join,
        rootCertificatePem: input.key.rootCertificatePem,
      } satisfies JoinMessage);
    }
    const challenge = asChallenge(await receivePairingFrame(socket));
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
      offerSecret: typeof sessionKey === "string" ? sessionKey : input.shortCode!,
      ...(typeof sessionKey === "string"
        ? {}
        : { sessionKey: Buffer.from(sessionKey).toString("base64url") }),
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
  readonly input: PairCommandOptions & {
    readonly secretStore: SecretStorePort;
    readonly key: DeviceKey;
    readonly store: FileMeshBootstrapStore;
    readonly continuations: FileMeshPairingContinuationStore;
    readonly writeLine: (line: string) => void;
  };
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
    CIPHERMAN_PAIRING_PAKE_SUITES,
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
  await input.input.store.acceptTransportPeer({
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
  await input.input.store.markBootstrapComplete(
    peerDeviceId,
    continuation.invitation.offer.offerId,
  );
  await deletePairingSecret(input.input.secretStore, continuation.invitation.offer.offerId);
  await input.input.continuations.clear(continuation.invitation.offer.offerId);
  input.input.writeLine(`Paired device: ${peerDeviceId}`);
  return { committed: true };
}

async function resumeJoinerPairing(input: {
  readonly input: PairCommandOptions & {
    readonly zhixingHome: string;
    readonly secretStore: SecretStorePort;
    readonly key: DeviceKey;
    readonly store: FileMeshBootstrapStore;
    readonly continuations: FileMeshPairingContinuationStore;
    readonly writeLine: (line: string) => void;
  };
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
  readonly input: PairCommandOptions & {
    readonly zhixingHome: string;
    readonly secretStore: SecretStorePort;
    readonly key: DeviceKey;
    readonly store: FileMeshBootstrapStore;
    readonly continuations: FileMeshPairingContinuationStore;
    readonly writeLine: (line: string) => void;
  };
  readonly invitation: PairingInvitation;
  readonly committed: PairingCommittedMessage;
  readonly socket: Socket;
}): Promise<void> {
  await input.input.store.importTrustBootstrap({
    events: input.committed.trustEvents,
    record: input.committed.trustRecord,
    localDeviceId: input.input.key.deviceId,
  });
  await input.input.store.acceptTransportPeer({
    identity: input.invitation.issuer,
    rootCertificatePem: input.committed.issuerRootCertificatePem,
  });
  await input.input.store.acceptEndpoint(input.committed.issuerEndpoint);
  const local = input.committed.trustRecord.members.find((member) =>
    member.device.deviceId === input.input.key.deviceId && member.state === "active");
  if (!local) throw new Error("Pairing trust projection does not contain the local device");
  const config = loadConfig({ homeDir: input.input.zhixingHome });
  await writeConfig({
    ...config,
    mesh: { enabledRoles: local.roles },
  }, { homeDir: input.input.zhixingHome });
  await input.input.store.markBootstrapComplete(
    input.invitation.issuer.deviceId,
    input.invitation.offer.offerId,
  );
  await sendPairingFrame(input.socket, { t: "bootstrap-complete" });
  await deletePairingSecret(input.input.secretStore, input.invitation.offer.offerId);
  await input.input.continuations.clear(input.invitation.offer.offerId);
  input.input.writeLine(`Joined home: ${input.committed.trustRecord.homeId}`);
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

function asPakeResponse(value: unknown): PakeResponseMessage {
  if (!isRecord(value) || value.t !== "pake-response" || !isRecord(value.round)) {
    throw new Error("Pairing PAKE response is invalid");
  }
  return value as unknown as PakeResponseMessage;
}

function asPakeFinish(value: unknown): PakeFinishMessage {
  if (!isRecord(value) || value.t !== "pake-finish" || !isRecord(value.round)) {
    throw new Error("Pairing PAKE finish is invalid");
  }
  return value as unknown as PakeFinishMessage;
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

function deletePairingSecret(store: SecretStorePort, offerId: string): Promise<void> {
  return store.delete({ kind: "rendezvous", bindingId: `pairing:${offerId}` });
}

function sessionKeyFromSecret(
  offer: PairingOffer,
  secret: PersistedPairingSecret,
): Buffer | string {
  if (offer.method.kind === "qr-secret") return secret.offerSecret;
  if (!secret.sessionKey) throw new Error("Pairing PAKE session key is unavailable for resume");
  const decoded = Buffer.from(secret.sessionKey, "base64url");
  if (decoded.toString("base64url") !== secret.sessionKey || decoded.byteLength === 0) {
    throw new Error("Pairing PAKE session key is invalid");
  }
  return decoded;
}

function encodeRecoveryPackage(
  root: RecoveryRoot,
  checkpoint: CheckpointPackage,
): string {
  const payload: EncodedRecoveryPackage = {
    v: 1,
    recoverySecret: root.exportSecret(),
    checkpoint: {
      envelope: checkpoint.envelope,
      chunks: checkpoint.chunks.map((chunk) => ({
        seq: chunk.seq,
        bytes: Buffer.from(chunk.bytes).toString("base64url"),
      })),
    },
  };
  return `zxrp1:${Buffer.from(canonicalize(payload), "utf8").toString("base64url")}`;
}

function decodeRecoveryPackage(value: string): {
  readonly root: RecoveryRoot;
  readonly checkpoint: CheckpointPackage;
} {
  const trimmed = value.trim();
  if (!trimmed.startsWith("zxrp1:")) {
    throw new TypeError("Recovery package has an unsupported format");
  }
  const encoded = trimmed.slice("zxrp1:".length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== encoded) {
    throw new TypeError("Recovery package is not canonical base64url");
  }
  const text = bytes.toString("utf8");
  let valueObject: unknown;
  try {
    valueObject = JSON.parse(text);
  } catch {
    throw new TypeError("Recovery package is not valid JSON");
  }
  if (
    canonicalize(valueObject) !== text ||
    !isRecord(valueObject) ||
    valueObject.v !== 1 ||
    typeof valueObject.recoverySecret !== "string" ||
    !isRecord(valueObject.checkpoint) ||
    !isRecord(valueObject.checkpoint.envelope) ||
    !Array.isArray(valueObject.checkpoint.chunks)
  ) {
    throw new TypeError("Recovery package shape is invalid");
  }
  assertObjectKeys(valueObject, ["checkpoint", "recoverySecret", "v"], "Recovery package");
  assertObjectKeys(valueObject.checkpoint, ["chunks", "envelope"], "Recovery checkpoint");
  const chunks = valueObject.checkpoint.chunks.map((entry, expectedSeq) => {
    if (
      !isRecord(entry) ||
      entry.seq !== expectedSeq ||
      typeof entry.bytes !== "string"
    ) {
      throw new TypeError("Recovery checkpoint chunk is invalid");
    }
    assertObjectKeys(entry, ["bytes", "seq"], "Recovery checkpoint chunk");
    const chunkBytes = Buffer.from(entry.bytes, "base64url");
    if (chunkBytes.toString("base64url") !== entry.bytes) {
      throw new TypeError("Recovery checkpoint chunk is not canonical base64url");
    }
    return { seq: expectedSeq, bytes: chunkBytes };
  });
  const checkpoint: CheckpointPackage = {
    envelope: valueObject.checkpoint.envelope as unknown as CheckpointPackage["envelope"],
    chunks,
  };
  const root = RecoveryRoot.importSecret(valueObject.recoverySecret);
  return { root, checkpoint };
}

function canonicalCheckpoint(checkpoint: CheckpointPackage): string {
  return canonicalize({
    envelope: checkpoint.envelope,
    chunks: checkpoint.chunks.map((chunk) => ({
      seq: chunk.seq,
      bytes: Buffer.from(chunk.bytes).toString("base64url"),
    })),
  });
}

async function promptRecoveryPackage(_recoveryPackage: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(
      "Save the recovery package independently, then paste the complete package to verify it: ",
    );
  } finally {
    prompt.close();
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
  const roles = value ?? ["executor"];
  if (roles.length === 0 || roles.some((role) => role !== "executor" && role !== "surface")) {
    throw new Error("Pairing may grant executor or surface roles");
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
  throw new Error("No routable local address was found; provide --advertise host:port");
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
