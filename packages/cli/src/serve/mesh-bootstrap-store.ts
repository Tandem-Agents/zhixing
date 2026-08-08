import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  CheckpointStreamRecord,
  DeviceIdentity,
  DeviceRole,
  HomeTrustEvent,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  PairingStreamRecord,
  RecoveryActivationPlan,
} from "@zhixing/core/contracts";
import { MAX_SURFACE_ASSET_BYTES } from "@zhixing/core/contracts";
import {
  ArtifactLifecycleIndex,
  collectArtifactRefs,
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import { canonicalize } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { ensureDurableDirectory, SerialTaskQueue, syncDirectory } from "@zhixing/core/persistence";
import {
  MeshEndpointDirectory,
  validateMeshEndpointDescriptor,
} from "@zhixing/mesh/bootstrap";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  validateDeviceTrustRoot,
} from "@zhixing/mesh/device-identity";
import {
  homeTrustEventDigest,
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  createTrustGenesisEvent,
  replayTrustChain,
  type TrustProjection,
  verifyHomeTrustRecord,
} from "@zhixing/mesh/trust-chain";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import type {
  BootstrapAuthorityPort,
  PairingAtomicCommit,
  PairingAttemptAdmission,
  PairingAttemptDecision,
  PairingAuthorityPort,
  PairingCommitReceipt,
  PairingCommitReplay,
  RecoveryActivationAtomicCommit,
  RecoveryActivationReplay,
} from "@zhixing/mesh/bootstrap-authority";
import {
  checkpointEnvelopeArtifact,
  checkpointPackageFromChunks,
  readCheckpointChunk,
  type CheckpointPackage,
} from "@zhixing/mesh/checkpoint";
import { validateRecoveryActivationPlan } from "@zhixing/mesh/bootstrap-authority";
import { pairingOfferDigest } from "@zhixing/mesh/pairing";

type TrustStreamRecord =
  | { readonly t: "home-trust-event"; readonly event: HomeTrustEvent }
  | { readonly t: "home-trust-record"; readonly record: HomeTrustRecord };

const FULL_AUTHORITY_CHECKPOINT_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);
const MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES = 16 * 1024 * 1024;

interface PersistedEndpointDirectory {
  readonly v: 1;
  readonly descriptors: readonly MeshEndpointDescriptor[];
}

interface PersistedTransportTrust {
  readonly v: 1;
  readonly peers: readonly TrustedMeshPeer[];
}

export interface FileMeshBootstrapStoreOptions {
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

/** Durable device-domain bootstrap state sharing the authority log's trust stream. */
export class FileMeshBootstrapStore {
  readonly #log: FileAuthorityCommitLog;
  readonly #artifacts: FileArtifactStore;
  readonly #endpointFile: string;
  readonly #peerFile: string;
  readonly #completionFile: string;
  readonly #checkpointLifecycle: ArtifactLifecycleIndex;
  readonly #endpointWrites = new SerialTaskQueue();

  constructor(
    readonly rootDir: string,
    readonly issuerKey?: DeviceKey,
    options: FileMeshBootstrapStoreOptions = {},
  ) {
    const distributedRoot = path.join(path.resolve(rootDir), "distributed-runtime");
    this.#artifacts = new FileArtifactStore(path.join(distributedRoot, "artifacts"));
    this.#log = new FileAuthorityCommitLog(
      path.join(distributedRoot, "authority"),
      this.#artifacts,
      { storageMaintenance: options.storageMaintenance },
    );
    const temporaryArtifacts = new FileArtifactStore(
      path.join(distributedRoot, "surface-asset-temporary"),
    );
    const receiver = new FileResumableArtifactReceiver(
      temporaryArtifacts,
      path.join(distributedRoot, "surface-asset-partials"),
      { maxArtifactBytes: MAX_SURFACE_ASSET_BYTES },
    );
    this.#checkpointLifecycle = new ArtifactLifecycleIndex({
      rootDir: path.join(distributedRoot, "derived"),
      logs: [this.#log],
      artifacts: this.#artifacts,
      temporaryArtifacts,
      temporaryPresence: new FileArtifactTemporaryPresenceStore(
        path.join(temporaryArtifacts.rootDir, ".presence"),
        { storageMaintenance: options.storageMaintenance },
      ),
      receiver,
      storageMaintenance: options.storageMaintenance,
      maintenanceResourceId: this.#artifacts.rootDir,
    });
    this.#endpointFile = path.join(distributedRoot, "mesh-endpoints.json");
    this.#peerFile = path.join(distributedRoot, "mesh-peers.json");
    this.#completionFile = path.join(distributedRoot, "mesh-bootstrap-completions.json");
  }

  stopStorageMaintenance(): void {
    this.#checkpointLifecycle.stopStorageMaintenance();
    this.#log.stopStorageMaintenance();
  }

  authorityLog(): FileAuthorityCommitLog {
    return this.#log;
  }

  artifactStore(): FileArtifactStore {
    return this.#artifacts;
  }

  checkpointRetention(): ArtifactLifecycleIndex {
    return this.#checkpointLifecycle;
  }

  async loadCheckpointRecords(): Promise<readonly CheckpointStreamRecord[]> {
    return (await this.#log.readStream<CheckpointStreamRecord>("checkpoint"))
      .map((record) => record.body);
  }

  async loadTrustEvents(): Promise<readonly HomeTrustEvent[]> {
    const records = await this.#log.readStream<TrustStreamRecord>("trust");
    const events: HomeTrustEvent[] = [];
    for (const { body } of records) {
      if (body.t === "home-trust-event") events.push(body.event);
    }
    if (events.length > 0) replayTrustChain(events);
    return events;
  }

  async loadTrustProjection(): Promise<TrustProjection | undefined> {
    const events = await this.loadTrustEvents();
    return events.length === 0 ? undefined : replayTrustChain(events);
  }

  async loadTrustRecord(): Promise<HomeTrustRecord | undefined> {
    const records = await this.#log.readStream<TrustStreamRecord>("trust");
    const events: HomeTrustEvent[] = [];
    let latest: HomeTrustRecord | undefined;
    for (const { body } of records) {
      if (body.t === "home-trust-event") events.push(body.event);
      else if (body.t === "home-trust-record") latest = body.record;
    }
    if (events.length === 0) return undefined;
    const projection = replayTrustChain(events);
    if (
      latest?.homeId === projection.homeId &&
      latest.trustEpoch === projection.trustEpoch &&
      latest.chainHead.seq === projection.chainHead.seq &&
      latest.chainHead.eventDigest === projection.chainHead.eventDigest
    ) {
      verifyHomeTrustRecord(latest, projection);
      return latest;
    }
    throw new Error("Home trust projection record is missing or stale");
  }

  async initializeLocalHome(input: {
    readonly key: DeviceKey;
    readonly identity: DeviceIdentity;
    readonly roles: readonly DeviceRole[];
    readonly at?: string;
    readonly homeId?: string;
  }): Promise<{ readonly projection: TrustProjection; readonly record: HomeTrustRecord }> {
    const at = input.at ?? new Date().toISOString();
    const homeId = input.homeId ?? generateUlid();
    const result = await this.#log.transactProjection<
      readonly HomeTrustEvent[],
      TrustStreamRecord,
      { projection: TrustProjection; record: HomeTrustRecord }
    >(
      [],
      (events, record) => {
        if (record.body.t !== "home-trust-event") return events;
        const next = [...events, record.body.event];
        replayTrustChain(next);
        return next;
      },
      (events) => {
        if (events.length > 0) {
          const projection = replayTrustChain(events);
          const record = buildHomeTrustRecord(projection, input.key);
          return { kind: "return", value: { projection, record } };
        }
        const genesis = createTrustGenesisEvent({
          homeId,
          issuer: input.identity,
          signer: input.key,
          at,
        });
        let projection = replayTrustChain([genesis]);
        const roleChange = createSignedTrustEvent({
          current: projection,
          body: {
            t: "role-change",
            deviceId: input.identity.deviceId,
            roles: [...input.roles],
          },
          at,
          signer: input.key,
        });
        projection = applyTrustEvent(projection, roleChange);
        const record = buildHomeTrustRecord(projection, input.key);
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: genesis } },
            { stream: "trust", body: { t: "home-trust-event", event: roleChange } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: { projection, record },
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  async appendTrustEvent(input: {
    readonly event: HomeTrustEvent;
    readonly issuerKey?: DeviceKey;
    readonly record?: HomeTrustRecord;
  }): Promise<TrustProjection> {
    const result = await this.#log.transactProjection<
      readonly HomeTrustEvent[],
      TrustStreamRecord,
      TrustProjection
    >(
      [],
      (events, record) => {
        if (record.body.t !== "home-trust-event") return events;
        const next = [...events, record.body.event];
        replayTrustChain(next);
        return next;
      },
      (events) => {
        if (events.length === 0) throw new Error("Trust chain genesis is missing");
        const current = replayTrustChain(events);
        const projection = applyTrustEvent(current, input.event);
        const record = input.record ??
          (input.issuerKey ? buildHomeTrustRecord(projection, input.issuerKey) : undefined);
        if (!record) throw new Error("Trust update requires its signed projection record");
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: input.event } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: projection,
        };
      },
      { stream: "trust" },
    );
    return result.value;
  }

  async importTrustBootstrap(input: {
    readonly events: readonly HomeTrustEvent[];
    readonly record: HomeTrustRecord;
    readonly localDeviceId: string;
  }): Promise<void> {
    if (input.events.length === 0) throw new Error("Trust bootstrap event chain is empty");
    const projection = replayTrustChain(input.events);
    verifyHomeTrustRecord(input.record, projection);
    if (
      input.record.chainHead.seq !== projection.chainHead.seq ||
      input.record.chainHead.eventDigest !== projection.chainHead.eventDigest ||
      !input.record.members.some((member) =>
        member.device.deviceId === input.localDeviceId && member.state === "active")
    ) {
      throw new Error("Trust bootstrap does not activate the local device");
    }
    await this.#log.transactProjection<readonly HomeTrustEvent[], TrustStreamRecord, void>(
      [],
      (events, logical) => {
        if (logical.body.t !== "home-trust-event") return events;
        const next = [...events, logical.body.event];
        replayTrustChain(next);
        return next;
      },
      (events) => {
        if (events.length > 0) {
          if (canonicalize(events) !== canonicalize(input.events)) {
            throw new Error("Local device already belongs to another trust chain");
          }
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [
            ...input.events.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record: input.record } },
          ],
          value: undefined,
        };
      },
      { stream: "trust" },
    );
  }

  async markBootstrapComplete(peerDeviceId: string, offerId: string): Promise<void> {
    await this.#endpointWrites.run(async () => {
      const current = await readBootstrapCompletions(this.#completionFile);
      const existing = current[peerDeviceId];
      if (existing && existing !== offerId) {
        throw new Error("Mesh peer bootstrap already completed under another pairing offer");
      }
      await writeDurableJson(this.#completionFile, {
        ...current,
        [peerDeviceId]: offerId,
      });
    });
  }

  async bootstrapCompleted(peerDeviceId: string, offerId: string): Promise<boolean> {
    const current = await readBootstrapCompletions(this.#completionFile);
    return current[peerDeviceId] === offerId;
  }

  pairingAuthority(): PairingAuthorityPort {
    return new FilePairingAuthority(this.#log, this.issuerKey);
  }

  bootstrapAuthority(): BootstrapAuthorityPort {
    return new FileBootstrapAuthority(this.#log, this.#artifacts, this.issuerKey);
  }

  async loadEndpoints(): Promise<MeshEndpointDirectory> {
    let text: string;
    try {
      text = await readFile(this.#endpointFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new MeshEndpointDirectory();
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Mesh endpoint directory is not valid JSON");
    }
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.descriptors)) {
      throw new Error("Mesh endpoint directory is invalid");
    }
    if (canonicalize(value) !== text) {
      throw new Error("Mesh endpoint directory is not canonical");
    }
    return new MeshEndpointDirectory(
      value.descriptors.map(validateMeshEndpointDescriptor),
    );
  }

  async acceptEndpoint(value: unknown): Promise<MeshEndpointDescriptor> {
    return this.#endpointWrites.run(async () => {
      const directory = await this.loadEndpoints();
      const accepted = directory.accept(value);
      await writeDurableJson(this.#endpointFile, {
        v: 1,
        descriptors: directory.list(),
      } satisfies PersistedEndpointDirectory);
      return accepted;
    });
  }

  async loadTransportPeers(): Promise<readonly TrustedMeshPeer[]> {
    let text: string;
    try {
      text = await readFile(this.#peerFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Mesh peer transport trust is not valid JSON");
    }
    if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.peers)) {
      throw new Error("Mesh peer transport trust is invalid");
    }
    if (canonicalize(value) !== text) {
      throw new Error("Mesh peer transport trust is not canonical");
    }
    return value.peers.map(validateTransportPeer);
  }

  async acceptTransportPeer(peer: TrustedMeshPeer): Promise<void> {
    await this.#endpointWrites.run(async () => {
      const accepted = validateTransportPeer(peer);
      const current = await this.loadTransportPeers();
      const existing = current.find((candidate) =>
        candidate.identity.deviceId === accepted.identity.deviceId);
      if (existing && canonicalize(existing) !== canonicalize(accepted)) {
        throw new Error("Authenticated mesh peer transport identity changed");
      }
      const peers = existing
        ? current
        : [...current, accepted].sort((left, right) =>
            left.identity.deviceId.localeCompare(right.identity.deviceId, "en-US"));
      await writeDurableJson(this.#peerFile, {
        v: 1,
        peers,
      } satisfies PersistedTransportTrust);
    });
  }
}

interface PairingProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly attempts: ReadonlyMap<string, {
    readonly admission: PairingAttemptAdmission;
    readonly status: "started" | "failed" | "succeeded";
    readonly acceptance?: import("@zhixing/core/contracts").PairingAcceptance;
    readonly trustEventDigest?: string;
  }>;
}

type BootstrapRecord = TrustStreamRecord | PairingStreamRecord;

type RecoveryStreamRecord =
  | TrustStreamRecord
  | CheckpointStreamRecord
  | {
      readonly t: "recovery-activation-committed";
      readonly commit: RecoveryActivationAtomicCommit;
    };

interface RecoveryProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly checkpointRecords: readonly CheckpointStreamRecord[];
  readonly activations: ReadonlyMap<string, RecoveryActivationAtomicCommit>;
}

class FilePairingAuthority implements PairingAuthorityPort {
  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly issuerKey?: DeviceKey,
  ) {}

  async beginPairingAttempt(
    offer: import("@zhixing/core/contracts").PairingOffer,
    now: number,
  ): Promise<PairingAttemptDecision> {
    const result = await this.log.transactProjection<PairingProjection, BootstrapRecord, PairingAttemptDecision>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const attempts = [...state.attempts.values()]
          .filter((entry) => entry.admission.offerId === offer.offerId)
          .sort((left, right) => left.admission.ordinal - right.admission.ordinal);
        const succeeded = attempts.some((entry) => entry.status === "succeeded");
        const latest = attempts.at(-1);
        if (succeeded || attempts.length >= offer.attempts.max) {
          return {
            kind: "return",
            value: { admitted: false, reason: "exhausted", attempts: attempts.length, retryAfterMs: 0 },
          };
        }
        const retryNotBefore = latest ? Date.parse(latest.admission.retryNotBefore) : 0;
        if (now < retryNotBefore) {
          return {
            kind: "return",
            value: {
              admitted: false,
              reason: "backoff",
              attempts: attempts.length,
              retryAfterMs: retryNotBefore - now,
            },
          };
        }
        const ordinal = attempts.length + 1;
        const admittedAt = now;
        const admission: PairingAttemptAdmission = {
          offerId: offer.offerId,
          offerDigest: pairingOfferDigest(offer),
          attemptId: generateUlid(admittedAt),
          ordinal,
          at: new Date(admittedAt).toISOString(),
          retryNotBefore: new Date(admittedAt + Math.min(8_000, 250 * 2 ** (ordinal - 1))).toISOString(),
        };
        return {
          kind: "append",
          entries: [{ stream: "pairing", body: { t: "pairing-attempt-started", ...admission } }],
          value: { admitted: true, attempt: admission },
        };
      },
      { streams: ["pairing", "trust"] },
    );
    return result.value;
  }

  async failPairingAttempt(attempt: PairingAttemptAdmission): Promise<void> {
    await this.log.transactProjection<PairingProjection, BootstrapRecord, void>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const current = state.attempts.get(attempt.attemptId);
        if (!current || canonicalize(current.admission) !== canonicalize(attempt)) {
          throw new Error("Pairing attempt admission is unknown");
        }
        if (current.status === "failed") return { kind: "return", value: undefined };
        if (current.status !== "started") throw new Error("Pairing attempt is already finalized");
        return {
          kind: "append",
          entries: [{
            stream: "pairing",
            body: {
              t: "pairing-attempt-failed",
              offerId: attempt.offerId,
              attemptId: attempt.attemptId,
            },
          }],
          value: undefined,
        };
      },
      { streams: ["pairing", "trust"] },
    );
  }

  async loadPairingCommit(attemptId: string): Promise<PairingCommitReplay | undefined> {
    const state = await this.log.rebuildProjection(
      emptyPairingProjection(),
      reducePairingProjection,
      { streams: ["pairing", "trust"] },
    );
    const attempt = state.attempts.get(attemptId);
    if (attempt?.status !== "succeeded" || !attempt.acceptance || !attempt.trustEventDigest) {
      return undefined;
    }
    const event = state.trustEvents.find((candidate) =>
      homeTrustEventDigest(candidate) === attempt.trustEventDigest);
    if (!event) throw new Error("Pairing commit is missing its trust event");
    const trust = replayTrustChain(state.trustEvents);
    return {
      receipt: pairingReceipt(attempt.admission, attempt.acceptance, event),
      trust,
    };
  }

  async commitPairing(input: PairingAtomicCommit): Promise<void> {
    const issuerKey = this.issuerKey;
    if (!issuerKey) throw new Error("Pairing authority requires the local issuer key");
    await this.log.transactProjection<PairingProjection, BootstrapRecord, void>(
      emptyPairingProjection(),
      reducePairingProjection,
      (state) => {
        const current = state.attempts.get(input.attempt.attemptId);
        const expectedReceipt = pairingReceipt(input.attempt, input.acceptance, input.trustEvent);
        if (current?.status === "succeeded" && current.acceptance && current.trustEventDigest) {
          const event = state.trustEvents.find((candidate) =>
            homeTrustEventDigest(candidate) === current.trustEventDigest);
          if (!event || canonicalize(pairingReceipt(current.admission, current.acceptance, event)) !== canonicalize(expectedReceipt)) {
            throw new Error("Pairing attempt commit conflict");
          }
          return { kind: "return", value: undefined };
        }
        if (
          !current ||
          current.status !== "started" ||
          canonicalize(current.admission) !== canonicalize(input.attempt) ||
          current.admission.offerId !== input.offer.offerId
        ) {
          throw new Error("Pairing attempt is not durably admitted");
        }
        if ([...state.attempts.values()].some((entry) =>
          entry.admission.offerId === input.offer.offerId && entry.status === "succeeded")) {
          throw new Error("Pairing offer is already consumed");
        }
        if (state.trustEvents.length === 0) throw new Error("Trust chain genesis is missing");
        const trust = replayTrustChain(state.trustEvents);
        if (canonicalize(trust.chainHead) !== canonicalize(input.expectedChainHead)) {
          throw new Error("Pairing trust head changed before commit");
        }
        const next = applyTrustEvent(trust, input.trustEvent);
        const record = buildHomeTrustRecord(next, issuerKey);
        return {
          kind: "append",
          entries: [
            {
              stream: "pairing",
              body: {
                t: "pairing-attempt-succeeded",
                offerId: input.offer.offerId,
                attemptId: input.attempt.attemptId,
                offerDigest: pairingOfferDigest(input.offer),
                acceptance: input.acceptance,
                trustEventDigest: homeTrustEventDigest(input.trustEvent),
              },
            },
            { stream: "trust", body: { t: "home-trust-event", event: input.trustEvent } },
            { stream: "trust", body: { t: "home-trust-record", record } },
          ],
          value: undefined,
        };
      },
      { streams: ["pairing", "trust"] },
    );
  }
}

class FileBootstrapAuthority implements BootstrapAuthorityPort {
  readonly #pairing: FilePairingAuthority;

  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly artifacts: FileArtifactStore,
    private readonly issuerKey?: DeviceKey,
  ) {
    this.#pairing = new FilePairingAuthority(log, issuerKey);
  }

  beginPairingAttempt(
    offer: Parameters<PairingAuthorityPort["beginPairingAttempt"]>[0],
    now: number,
  ): ReturnType<PairingAuthorityPort["beginPairingAttempt"]> {
    return this.#pairing.beginPairingAttempt(offer, now);
  }

  failPairingAttempt(
    attempt: PairingAttemptAdmission,
  ): ReturnType<PairingAuthorityPort["failPairingAttempt"]> {
    return this.#pairing.failPairingAttempt(attempt);
  }

  loadPairingCommit(
    attemptId: string,
  ): ReturnType<PairingAuthorityPort["loadPairingCommit"]> {
    return this.#pairing.loadPairingCommit(attemptId);
  }

  commitPairing(
    input: PairingAtomicCommit,
  ): ReturnType<PairingAuthorityPort["commitPairing"]> {
    return this.#pairing.commitPairing(input);
  }

  async persistCheckpointPackage(checkpoint: CheckpointPackage): Promise<ArtifactRef> {
    for (const descriptor of checkpoint.envelope.chunks) {
      const bytes = await readCheckpointChunk(checkpoint, descriptor.seq);
      try {
        const stored = await this.artifacts.put(bytes);
        if (stored.digest !== descriptor.digest || stored.bytes !== descriptor.bytes) {
          throw new TypeError("Checkpoint chunk does not match its signed manifest");
        }
      } finally {
        bytes.fill(0);
      }
    }
    const expectedEnvelope = checkpointEnvelopeArtifact(checkpoint.envelope);
    const storedEnvelope = await this.artifacts.put(
      Buffer.from(canonicalize(checkpoint.envelope), "utf8"),
    );
    if (canonicalize(storedEnvelope) !== canonicalize(expectedEnvelope)) {
      throw new TypeError("Checkpoint envelope artifact identity is inconsistent");
    }
    return storedEnvelope;
  }

  async loadCheckpointPackage(
    envelopeRef: ArtifactRef,
  ): Promise<CheckpointPackage | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await this.artifacts.get(envelopeRef);
    } catch (error) {
      if ((error as { code?: string }).code === "artifact-missing") return undefined;
      throw error;
    }
    const text = Buffer.from(bytes).toString("utf8");
    const envelope = JSON.parse(text) as CheckpointPackage["envelope"];
    if (
      canonicalize(envelope) !== text ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(envelopeRef)
    ) {
      throw new Error("Checkpoint envelope artifact is not canonical or self-consistent");
    }
    if (canonicalize(envelope.manifest.scope) !== canonicalize(FULL_AUTHORITY_CHECKPOINT_SCOPE)) {
      let totalBytes = 0;
      for (const descriptor of envelope.chunks) {
        totalBytes += descriptor.bytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES) {
          throw new TypeError("Legacy checkpoint exceeds its bounded materialization limit");
        }
      }
      const chunks: { seq: number; bytes: Uint8Array }[] = [];
      try {
        for (const descriptor of envelope.chunks) {
          chunks.push({
            seq: descriptor.seq,
            bytes: await this.artifacts.get({ digest: descriptor.digest, bytes: descriptor.bytes }),
          });
        }
        return checkpointPackageFromChunks(envelope, chunks);
      } catch (error) {
        for (const chunk of chunks) {
          Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength).fill(0);
        }
        throw error;
      }
    }
    return {
      envelope,
      source: {
        read: (seq, offset, limit) => {
          const descriptor = envelope.chunks[seq];
          if (!descriptor || descriptor.seq !== seq) {
            return Promise.reject(new TypeError("Stored checkpoint chunk sequence is invalid"));
          }
          return this.artifacts.readRange(
            { digest: descriptor.digest, bytes: descriptor.bytes },
            offset,
            limit,
          );
        },
      },
    };
  }

  async appendCheckpoint(record: CheckpointStreamRecord): Promise<void> {
    await this.log.transactProjection<RecoveryProjection, RecoveryStreamRecord, void>(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      (state) => {
        const exact = state.checkpointRecords.find((candidate) =>
          canonicalize(candidate) === canonicalize(record));
        if (exact) return { kind: "return", value: undefined };
        const identity = checkpointRecordIdentity(record);
        if (state.checkpointRecords.some((candidate) =>
          checkpointRecordIdentity(candidate) === identity)) {
          throw new Error("Checkpoint record identity conflict");
        }
        return {
          kind: "append",
          entries: [{ stream: "checkpoint", body: record }],
          value: undefined,
        };
      },
      {
        streams: ["trust", "checkpoint"],
        candidateReferences: collectArtifactRefs(record),
      },
    );
  }

  async loadRecoveryActivation(
    checkpointId: string,
  ): Promise<RecoveryActivationReplay | undefined> {
    const state = await this.log.rebuildProjection(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      { streams: ["trust", "checkpoint"] },
    );
    const commit = state.activations.get(checkpointId);
    if (!commit) return undefined;
    return {
      commit,
      trust: replayTrustChain(state.trustEvents),
    };
  }

  async commitRecoveryActivation(input: RecoveryActivationAtomicCommit): Promise<void> {
    const issuerKey = this.issuerKey;
    if (!issuerKey) throw new Error("Recovery activation requires the local issuer key");
    await this.log.transactProjection<RecoveryProjection, RecoveryStreamRecord, void>(
      emptyRecoveryProjection(),
      reduceRecoveryProjection,
      (state) => {
        const checkpointId = input.verification.checkpointId;
        const replay = state.activations.get(checkpointId);
        if (replay) {
          if (canonicalize(replay) !== canonicalize(input)) {
            throw new Error("Recovery activation commit conflict");
          }
          return { kind: "return", value: undefined };
        }
        if (state.trustEvents.length === 0) {
          throw new Error("Recovery activation trust chain is missing");
        }
        const current = replayTrustChain(state.trustEvents);
        if (canonicalize(current.chainHead) !== canonicalize(input.expectedChainHead)) {
          throw new Error("Recovery activation trust head changed before commit");
        }
        assertRecoveryEvidence(state.checkpointRecords, input);
        const next = validateRecoveryActivationPlan(current, input.plan);
        const events = recoveryPlanEvents(input.plan);
        const record = buildHomeTrustRecord(next, issuerKey);
        return {
          kind: "append",
          entries: [
            ...events.map((event) => ({
              stream: "trust",
              body: { t: "home-trust-event" as const, event },
            })),
            { stream: "trust", body: { t: "home-trust-record" as const, record } },
            ...input.checkpointRecords.map((checkpointRecord) => ({
              stream: "checkpoint",
              body: checkpointRecord,
            })),
            {
              stream: "checkpoint",
              body: { t: "recovery-activation-committed" as const, commit: input },
            },
          ],
          value: undefined,
        };
      },
      { streams: ["trust", "checkpoint"] },
    );
  }
}

function emptyPairingProjection(): PairingProjection {
  return { trustEvents: [], attempts: new Map() };
}

function reducePairingProjection(
  state: PairingProjection,
  record: { readonly stream: string; readonly body: BootstrapRecord },
): PairingProjection {
  if (record.stream === "trust" && record.body.t === "home-trust-event") {
    const trustEvents = [...state.trustEvents, record.body.event];
    replayTrustChain(trustEvents);
    return { ...state, trustEvents };
  }
  if (record.stream !== "pairing") return state;
  const body = record.body;
  const attempts = new Map(state.attempts);
  if (body.t === "pairing-attempt-started") {
    const admission: PairingAttemptAdmission = {
      attemptId: body.attemptId,
      offerId: body.offerId,
      offerDigest: body.offerDigest,
      ordinal: body.ordinal,
      at: body.at,
      retryNotBefore: body.retryNotBefore,
    };
    if (attempts.has(admission.attemptId)) throw new Error("Duplicate pairing attempt id");
    attempts.set(admission.attemptId, { admission, status: "started" });
  } else if (body.t === "pairing-attempt-failed") {
    const current = attempts.get(body.attemptId);
    if (!current || current.admission.offerId !== body.offerId || current.status !== "started") {
      throw new Error("Invalid pairing attempt failure record");
    }
    attempts.set(body.attemptId, { ...current, status: "failed" });
  } else if (body.t === "pairing-attempt-succeeded") {
    const current = attempts.get(body.attemptId);
    if (
      !current ||
      current.status !== "started" ||
      current.admission.offerId !== body.offerId ||
      current.admission.offerDigest !== body.offerDigest
    ) {
      throw new Error("Invalid pairing attempt success record");
    }
    attempts.set(body.attemptId, {
      ...current,
      status: "succeeded",
      acceptance: body.acceptance,
      trustEventDigest: body.trustEventDigest,
    });
  }
  return { ...state, attempts };
}

function emptyRecoveryProjection(): RecoveryProjection {
  return {
    trustEvents: [],
    checkpointRecords: [],
    activations: new Map(),
  };
}

function reduceRecoveryProjection(
  state: RecoveryProjection,
  record: { readonly stream: string; readonly body: RecoveryStreamRecord },
): RecoveryProjection {
  const body = record.body;
  if (record.stream === "trust" && body.t === "home-trust-event") {
    const trustEvents = [...state.trustEvents, body.event];
    replayTrustChain(trustEvents);
    return { ...state, trustEvents };
  }
  if (record.stream !== "checkpoint") return state;
  if (body.t === "home-trust-event" || body.t === "home-trust-record") {
    throw new Error("Trust record was written to the checkpoint stream");
  }
  if (body.t === "recovery-activation-committed") {
    const checkpointId = body.commit.verification.checkpointId;
    const activations = new Map(state.activations);
    const existing = activations.get(checkpointId);
    if (existing && canonicalize(existing) !== canonicalize(body.commit)) {
      throw new Error("Recovery activation log contains a conflicting commit");
    }
    activations.set(checkpointId, body.commit);
    return { ...state, activations };
  }
  const identity = checkpointRecordIdentity(body);
  const existing = state.checkpointRecords.find((candidate) =>
    checkpointRecordIdentity(candidate) === identity);
  if (existing) {
    if (canonicalize(existing) !== canonicalize(body)) {
      throw new Error("Checkpoint log contains a conflicting record");
    }
    return state;
  }
  return {
    ...state,
    checkpointRecords: [...state.checkpointRecords, body],
  };
}

function checkpointRecordIdentity(record: CheckpointStreamRecord): string {
  switch (record.t) {
    case "checkpoint-created":
    case "checkpoint-superseded":
      return `${record.t}:${record.checkpointId}`;
    case "checkpoint-cleanup-progress":
      return `${record.t}:${record.checkpointId}:${record.targetId}:${record.phase}`;
    case "checkpoint-replicated":
    case "checkpoint-verified":
      return `${record.t}:${record.checkpointId}:${record.targetId}`;
    case "checkpoint-verify-failed":
      return `${record.t}:${canonicalize(record)}`;
  }
}

function assertRecoveryEvidence(
  records: readonly CheckpointStreamRecord[],
  input: RecoveryActivationAtomicCommit,
): void {
  const verification = input.verification;
  const created = records.find((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-created" }
  > => record.t === "checkpoint-created" && record.checkpointId === verification.checkpointId);
  const replicated = records.find((record): record is Extract<
    CheckpointStreamRecord,
    { t: "checkpoint-replicated" }
  > =>
    record.t === "checkpoint-replicated" &&
    record.checkpointId === verification.checkpointId &&
    record.targetId === verification.targetId);
  if (
    !created ||
    !replicated ||
    created.recipientKeyId !== verification.recipientKeyId ||
    replicated.recipientKeyId !== verification.recipientKeyId ||
    created.envelopeDigest !== verification.envelopeDigest ||
    replicated.envelopeDigest !== verification.envelopeDigest
  ) {
    throw new Error("Recovery activation checkpoint evidence is incomplete");
  }
}

function recoveryPlanEvents(plan: RecoveryActivationPlan): readonly HomeTrustEvent[] {
  return plan.kind === "domain-reset-establish"
    ? [plan.resetEvent, plan.rootEvent]
    : [plan.rootEvent];
}

function pairingReceipt(
  attempt: PairingAttemptAdmission,
  acceptance: import("@zhixing/core/contracts").PairingAcceptance,
  event: HomeTrustEvent,
): PairingCommitReceipt {
  const trustEventDigest = homeTrustEventDigest(event);
  return {
    expectedChainHead: {
      seq: event.seq - 1,
      eventDigest: event.prevEventDigest,
    },
    attemptId: attempt.attemptId,
    offerId: attempt.offerId,
    offerDigest: attempt.offerDigest,
    acceptance,
    trustEventDigest,
    resultingChainHead: { seq: event.seq, eventDigest: trustEventDigest },
  };
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, canonicalize(value), { encoding: "utf8", flag: "wx" });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function generateUlid(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = now;
  let prefix = "";
  for (let index = 0; index < 10; index += 1) {
    prefix = alphabet[timestamp % 32]! + prefix;
    timestamp = Math.floor(timestamp / 32);
  }
  const entropy = randomBytes(10);
  let bits = 0;
  let available = 0;
  let suffix = "";
  for (const byte of entropy) {
    bits = (bits << 8) | byte;
    available += 8;
    while (available >= 5 && suffix.length < 16) {
      available -= 5;
      suffix += alphabet[(bits >>> available) & 31];
      bits &= (1 << available) - 1;
    }
  }
  if (suffix.length < 16) suffix += alphabet[(bits << (5 - available)) & 31];
  return `${prefix}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateTransportPeer(value: unknown): TrustedMeshPeer {
  if (!isRecord(value) || !isRecord(value.identity)) {
    throw new Error("Mesh peer transport identity is invalid");
  }
  const identity = value.identity;
  const identityKeys = Object.keys(identity).sort();
  if (
    Object.keys(value).sort().join(",") !== "identity,rootCertificatePem" ||
    identityKeys.join(",") !== "deviceId,displayName,enrolledAt,platform,publicKey" ||
    typeof identity.deviceId !== "string" ||
    typeof identity.publicKey !== "string" ||
    typeof identity.displayName !== "string" ||
    (identity.platform !== "windows" && identity.platform !== "macos" && identity.platform !== "linux" && identity.platform !== "headless") ||
    typeof identity.enrolledAt !== "string" ||
    typeof value.rootCertificatePem !== "string"
  ) {
    throw new Error("Mesh peer transport identity fields are invalid");
  }
  validateDeviceTrustRoot(identity as unknown as DeviceIdentity, value.rootCertificatePem);
  return Object.freeze({
    identity: Object.freeze({
      deviceId: identity.deviceId as string,
      publicKey: identity.publicKey as string,
      displayName: identity.displayName as string,
      platform: identity.platform,
      enrolledAt: identity.enrolledAt as string,
    }) as DeviceIdentity,
    rootCertificatePem: value.rootCertificatePem,
  });
}

async function readBootstrapCompletions(filePath: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Mesh bootstrap completion state is not valid JSON");
  }
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Mesh bootstrap completion state is invalid");
  }
  if (canonicalize(value) !== text) {
    throw new Error("Mesh bootstrap completion state is not canonical");
  }
  return value as Record<string, string>;
}
