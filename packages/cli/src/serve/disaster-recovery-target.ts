import path from "node:path";
import { rm } from "node:fs/promises";
import type {
  ArtifactRef,
  DeviceIdentity,
  DisasterRecoveryCommand,
  CredentialExposureRecord,
  HomeTrustEvent,
  HomeTrustRecord,
  LogicalRecord,
  SecretStorePort,
  TransferRecord,
} from "@zhixing/core/contracts";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import {
  canonicalize,
  anchorTransferCommitDigest,
  authorityCatalogDigest,
  createSignedDisasterRecoveryCommand,
  createSignedDisasterRecoveryCommit,
  validateDisasterRecoveryAbort,
  protocolDigest,
  prepareAuthorityCatalog,
  readyProofDigest,
  reduceDisasterRecovery,
  type DisasterRecoveryState,
  type DisasterRecoveryVerifiers,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import {
  createAnchorTransferReadyProof,
  validateAnchorTransferReadyProof,
} from "@zhixing/mesh/anchor-transfer-ready";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import {
  activateAnchorIssuerKey,
  deleteAnchorIssuerKey,
  loadActiveAnchorIssuerKey,
  loadAnchorIssuerKey,
  loadOrCreateAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import {
  type DeviceKey,
  verifyDeviceSignature,
} from "@zhixing/mesh/device-identity";
import {
  RecoveryRoot,
  verifyRecoverySignature,
} from "@zhixing/mesh/recovery-root";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  replayTrustChain,
} from "@zhixing/mesh/trust-chain";
import { projectDeviceCredentialRevocation } from "@zhixing/mesh/credential-exposure";
import {
  type PlannedAnchorReadinessPort,
} from "./planned-anchor-transfer.js";
import {
  type DisasterAuthorityRecordSet,
  disasterAuthorityEnvelopes,
  parseDisasterAuthorityRecordSet,
  verifyAndStageDisasterRecoveryAuthority,
} from "./disaster-recovery-authority.js";
import {
  FileDisasterRecoveryCandidateJournal,
  type DisasterRecoveryCandidateState,
  type DisasterRecoveryInstallDecision,
  type DisasterRecoveryVerifiedCandidate,
} from "./disaster-recovery-candidate.js";
import {
  createDisasterRecoveryInstallation,
  loadDisasterRecoveryPostInstallReceipt,
  loadCurrentDisasterRecoveryInstallation,
  recordDisasterRecoveryPostInstallReceipt,
  type DisasterRecoveryInstallation,
} from "./disaster-recovery-installation.js";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import type { DisasterRecoveryReachabilityEvidence } from
  "./disaster-recovery-trust-evidence.js";

const DISASTER_TRANSFER_STREAM = "transfer:anchor-disaster";
const TRANSFER_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFER_ARTIFACT_BYTES = 512 * 1024 * 1024 * 1024;

export const DISASTER_RECOVERY_TARGET_DESCRIPTOR = Object.freeze({
  owner: "eligible-recovery-target",
  roles: Object.freeze(["anchor-executor", "anchor-only"]),
  phases: Object.freeze(["prepare", "commit", "abort", "tombstone"]),
  order: Object.freeze([
    "claim",
    "verify",
    "private-import",
    "atomic-install",
    "generation-rebind",
    "consumer-recovery",
    "credential-guard",
    "open",
  ]),
});

type DisasterRecord = Extract<TransferRecord, { mode: "disaster-recovery" }>;
type PrepareCommand = Extract<DisasterRecoveryCommand, { op: "prepare" }>;
type StoredDisasterRecord = {
  readonly v: 1;
  readonly t: "disaster-recovery-record";
  readonly recordJson: string;
};

export interface DisasterRecoveryImportedState {
  readonly state: DisasterRecoveryState;
  readonly authorityRecords: DisasterAuthorityRecordSet;
  readonly baselineEvents: readonly HomeTrustEvent[];
}

export type DisasterRecoveryAbortState =
  | DisasterRecoveryState
  | {
      readonly phase: "aborted";
      readonly transferId: string;
      readonly abort: import("@zhixing/core/contracts").DisasterRecoveryAbort;
    };

export interface DisasterRecoveryPostInstallDescriptor {
  readonly installation: DisasterRecoveryInstallation;
  readonly installedGeneration: import("./disaster-recovery-installation.js").DisasterInstalledAuthorityGeneration;
  readonly state?: DisasterRecoveryState;
  readonly pendingObligations: import("@zhixing/core/contracts").AuthorityCatalog["pendingObligations"];
  readonly requiresPostInstallCompletion: boolean;
}

export class FileDisasterRecoveryTransferJournal {
  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly verifiers: DisasterRecoveryVerifiers,
    private readonly now: () => number = Date.now,
  ) {}

  async state(transferId: string): Promise<DisasterRecoveryState | undefined> {
    return (await this.states()).get(transferId);
  }

  async states(): Promise<ReadonlyMap<string, DisasterRecoveryState>> {
    return this.log.rebuildProjection<ReadonlyMap<string, DisasterRecoveryState>>(
      new Map<string, DisasterRecoveryState>(),
      (states, entry) => reduceDisasterJournal(
        states,
        entry,
        this.verifiers,
        this.now(),
      ),
      { stream: DISASTER_TRANSFER_STREAM },
    );
  }

  async append(
    record: DisasterRecord,
    candidateReferences: readonly ArtifactRef[] = [],
  ): Promise<DisasterRecoveryState> {
    const result = await this.log.transactProjection<
      ReadonlyMap<string, DisasterRecoveryState>,
      StoredDisasterRecord,
      DisasterRecoveryState
    >(
      new Map(),
      (states, entry) => reduceDisasterJournal(
        states,
        entry,
        this.verifiers,
        this.now(),
      ),
      (states) => {
        const current = states.get(record.transferId);
        const next = reduceDisasterRecovery(
          current,
          record,
          this.verifiers,
          this.now(),
        );
        if (next === current) return { kind: "return", value: next };
        return {
          kind: "append",
          entries: [{
            stream: DISASTER_TRANSFER_STREAM,
            body: {
              v: 1,
              t: "disaster-recovery-record",
              recordJson: canonicalize(record),
            } satisfies StoredDisasterRecord,
          }],
          value: next,
        };
      },
      {
        stream: DISASTER_TRANSFER_STREAM,
        candidateReferences,
      },
    );
    return result.value;
  }
}

export class DisasterRecoveryTarget {
  constructor(private readonly options: {
    readonly deviceId: string;
    readonly identity: DeviceIdentity;
    readonly identityKey: DeviceKey;
    readonly secretStore: SecretStorePort;
    readonly sharedArtifacts: FileArtifactStore;
    readonly authorityLog: FileAuthorityCommitLog;
    readonly stagingRoot: string;
    readonly readiness: PlannedAnchorReadinessPort;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
    readonly now?: () => number;
  }) {
    if (
      options.identity.deviceId !== options.deviceId ||
      options.identityKey.deviceId !== options.deviceId
    ) {
      throw new TypeError("Disaster recovery target identity is inconsistent");
    }
  }

  async prepareAndImport(input: {
    readonly prepare: PrepareCommand;
    readonly checkpoint: CheckpointPackage;
    readonly recoveryRoot: RecoveryRoot;
    readonly trustEvidence: DisasterRecoveryReachabilityEvidence;
    readonly signal?: AbortSignal;
  }): Promise<DisasterRecoveryImportedState> {
    input.signal?.throwIfAborted();
    if (input.prepare.targetDeviceId !== this.options.deviceId) {
      throw new TypeError("Disaster recovery command targets another device");
    }
    assertRecoveryRoot(input.prepare, input.recoveryRoot);
    if (input.checkpoint.envelope.digest !== input.prepare.checkpointEnvelope.digest) {
      throw new TypeError("Disaster recovery checkpoint changes its originating prepare identity");
    }
    const candidate = this.#candidateFor(input.recoveryRoot.rootPublicKey);
    const claimed = await candidate.claim(input.prepare);
    if (claimed.terminal === "aborted") {
      throw new Error("Disaster recovery candidate was durably aborted");
    }

    const context = await this.#context(
      input.prepare.transferId,
      input.recoveryRoot.rootPublicKey,
    );
    if (claimed.verified) {
      return this.#importVerifiedCandidate({
        prepare: input.prepare,
        candidate: claimed,
        context,
        recoveryRoot: input.recoveryRoot,
      });
    }
    const preparedRecord: DisasterRecord = {
      v: 1,
      mode: "disaster-recovery",
      t: "anchor-prepared",
      transferId: input.prepare.transferId,
      prepare: input.prepare,
    };
    await context.journal.append(preparedRecord);

    const staged = await verifyAndStageDisasterRecoveryAuthority({
      requestId: input.prepare.requestId,
      transferId: input.prepare.transferId,
      targetDeviceId: this.options.deviceId,
      checkpointTargetId: input.prepare.checkpointTargetId,
      checkpoint: input.checkpoint,
      recoveryRoot: input.recoveryRoot,
      trustEvidence: input.trustEvidence.evidence.map((item) => item.events),
      privateArtifacts: context.artifacts,
      privatePartialsRoot: path.join(context.root, "partials"),
      ...(this.options.storageMaintenance
        ? { storageMaintenance: this.options.storageMaintenance }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      now: this.options.now?.(),
    });
    const issuerKey = await loadOrCreateAnchorIssuerKey(
      this.options.secretStore,
      input.prepare.transferId,
    );
    let verified: DisasterRecoveryCandidateState;
    try {
      await this.#deleteFreshIssuerKeyIfAborted({
        candidate,
        prepare: input.prepare,
        issuerKey,
      });
      verified = await candidate.recordVerified(input.prepare.transferId, {
        baseline: staged.baseline,
        baselineEvents: staged.baselineEvents,
        reachabilityCut: input.trustEvidence.cut,
        trustEvidence: input.trustEvidence.evidence,
        trustEvidenceDigest: input.trustEvidence.digest,
        onsiteVerification: staged.onsiteVerification,
        authorityRecordsRef: staged.authorityRecordsRef,
        catalog: staged.catalog,
        catalogRef: staged.catalogRef,
      });
      await this.#deleteFreshIssuerKeyIfAborted({
        candidate,
        prepare: input.prepare,
        issuerKey,
      });
    } catch (error) {
      await this.#deleteFreshIssuerKeyIfAborted({
        candidate,
        prepare: input.prepare,
        issuerKey,
      });
      throw error;
    }
    return this.#importVerifiedCandidate({
      prepare: input.prepare,
      candidate: verified,
      context,
      recoveryRoot: input.recoveryRoot,
    });
  }

  async #importVerifiedCandidate(input: {
    readonly prepare: PrepareCommand;
    readonly candidate: DisasterRecoveryCandidateState;
    readonly context: {
      readonly root: string;
      readonly artifacts: FileArtifactStore;
      readonly journal: FileDisasterRecoveryTransferJournal;
    };
    readonly recoveryRoot: RecoveryRoot;
  }): Promise<DisasterRecoveryImportedState> {
    const verified = input.candidate.verified;
    if (!verified) throw new Error("Disaster recovery candidate is not verified");
    const existing = await input.context.journal.state(input.prepare.transferId);
    if (!existing) {
      throw new Error("Verified disaster candidate has no durable private prepare state");
    }
    if (existing.phase === "aborted" || input.candidate.terminal === "aborted") {
      throw new Error("Disaster recovery candidate was durably aborted");
    }
    const allowShared = input.candidate.terminal === "committed";
    const stored = await this.#readVerifiedCandidateArtifacts(
      input.context.artifacts,
      verified,
      allowShared,
    );
    if (existing.imported) {
      if (
        existing.phase !== "imported" && existing.phase !== "committed" &&
        existing.phase !== "tombstoned"
      ) throw new Error("Disaster imported replay has an invalid private phase");
      return Object.freeze({
        state: existing,
        authorityRecords: stored.authorityRecords,
        baselineEvents: verified.baselineEvents,
      });
    }
    if (existing.phase !== "prepared") {
      throw new Error("Verified disaster candidate cannot resume private import");
    }
    const issuerKey = await loadAnchorIssuerKey(
      this.options.secretStore,
      input.prepare.transferId,
    );
    if (!issuerKey) {
      throw new Error("Verified disaster candidate is missing its durable issuer key");
    }
    const trust = replayTrustChain(verified.baselineEvents);
    const readyNow = this.options.now?.() ?? Date.now();
    const { proof: readyProof } = await createAnchorTransferReadyProof({
      requestId: input.prepare.requestId,
      transferId: input.prepare.transferId,
      candidateDigest: disasterReadyCandidateDigest({
        prepare: input.prepare,
        baseline: verified.baseline,
        onsiteVerification: verified.onsiteVerification,
        trustEvidenceDigest: verified.trustEvidenceDigest,
      }),
      targetIdentityKey: this.options.identityKey,
      trust,
      secretStore: this.options.secretStore,
      issuerKey,
      snapshot: await this.options.readiness.reserve({
        transferId: input.prepare.transferId,
        expiresAt: new Date(readyNow + 5 * 60_000).toISOString(),
      }),
      now: readyNow,
    });
    const transition = createSignedTrustEvent({
      current: trust,
      at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      signer: input.recoveryRoot,
      body: {
        t: "issuer-transition",
        nextTrustEpoch: verified.baseline.trustEpoch + 1,
        fromIssuerKeyId: verified.baseline.issuer.issuerKeyId,
        toIssuerKeyId: issuerKey.deviceId,
        toIssuerPublicKey: issuerKey.publicKey,
        toDeviceId: this.options.deviceId,
        reason: "disaster-recovery",
        signedBy: "recovery-root",
      },
    });
    const imported = createSignedDisasterRecoveryCommand({
      v: 1,
      op: "import",
      requestId: input.prepare.requestId,
      transferId: input.prepare.transferId,
      targetDeviceId: this.options.deviceId,
      checkpointTargetId: input.prepare.checkpointTargetId,
      checkpointEnvelopeDigest: input.prepare.checkpointEnvelope.digest,
      baseline: verified.baseline,
      onsiteVerification: verified.onsiteVerification,
      catalog: verified.catalog,
      catalogRef: verified.catalogRef,
      readyProof,
      trustTransition: transition,
      nextAnchorEpoch: verified.baseline.anchorEpoch + 1,
      nextTrustEpoch: verified.baseline.trustEpoch + 1,
      targetIssuerPublicKey: issuerKey.publicKey,
    }, input.recoveryRoot) as Extract<DisasterRecoveryCommand, { op: "import" }>;
    const importedContext = await this.#context(
      input.prepare.transferId,
      input.recoveryRoot.rootPublicKey,
      issuerKey,
    );
    const state = await importedContext.journal.append({
      v: 1,
      mode: "disaster-recovery",
      t: "anchor-imported",
      transferId: input.prepare.transferId,
      imported,
    }, [
      verified.authorityRecordsRef,
      verified.catalogRef,
      ...verified.catalog.retainedArtifacts,
    ]);
    return Object.freeze({
      state,
      authorityRecords: stored.authorityRecords,
      baselineEvents: verified.baselineEvents,
    });
  }

  async #readVerifiedCandidateArtifacts(
    privateArtifacts: FileArtifactStore,
    verified: DisasterRecoveryVerifiedCandidate,
    allowShared: boolean,
  ): Promise<{ readonly authorityRecords: DisasterAuthorityRecordSet }> {
    const read = async (ref: ArtifactRef): Promise<Uint8Array> => {
      if (await privateArtifacts.has(ref)) return privateArtifacts.get(ref);
      if (allowShared && await this.options.sharedArtifacts.has(ref)) {
        return this.options.sharedArtifacts.get(ref);
      }
      throw new Error("Verified disaster candidate is missing a private artifact");
    };
    const authorityRecords = parseDisasterAuthorityRecordSet(
      await read(verified.authorityRecordsRef),
    );
    const catalogText = Buffer.from(await read(verified.catalogRef)).toString("utf8");
    const rawCatalog = JSON.parse(catalogText) as unknown;
    if (canonicalize(rawCatalog) !== catalogText) {
      throw new Error("Verified disaster catalog is not canonical");
    }
    const catalog = prepareAuthorityCatalog(rawCatalog).catalog;
    if (
      canonicalize(catalog) !== canonicalize(verified.catalog) ||
      canonicalize(authorityRecords.source) !== canonicalize(verified.catalog.source)
    ) throw new Error("Verified disaster artifacts change their durable exact-set");
    for (const ref of uniqueRefs([
      ...authorityRecords.pages.map((page) => page.ref),
      ...verified.catalog.retainedArtifacts,
    ])) {
      if (
        !await privateArtifacts.has(ref) &&
        !(allowShared && await this.options.sharedArtifacts.has(ref))
      ) throw new Error("Verified disaster candidate has a missing private reference");
    }
    return { authorityRecords };
  }

  async commit(input: {
    readonly transferId: string;
    readonly recoveryRoot: RecoveryRoot;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly state: DisasterRecoveryState;
    readonly trustRecord: HomeTrustRecord;
    readonly installation: DisasterRecoveryInstallation;
  }> {
    const candidate = this.#candidateFor(input.recoveryRoot.rootPublicKey);
    const claimed = await candidate.state(input.transferId);
    if (!claimed?.verified) throw new Error("Disaster recovery candidate is not verified");
    assertRecoveryRoot(claimed.prepare, input.recoveryRoot);
    const context = await this.#context(input.transferId, input.recoveryRoot.rootPublicKey);
    const state = await context.journal.state(input.transferId);
    if (claimed.terminal === "aborted" || state?.phase === "aborted") {
      throw new Error("Terminal-aborted disaster recovery cannot be committed");
    }
    if (!state?.imported) {
      throw new Error("Disaster recovery authority is not privately imported");
    }
    if (claimed.terminal === "committed") {
      if (!claimed.installDecision) {
        throw new Error("Committed disaster candidate has no durable install decision");
      }
      if (state.phase !== "committed" && state.phase !== "tombstoned") {
        throw new Error("Committed disaster candidate has no private committed state");
      }
      return {
        state,
        trustRecord: claimed.installDecision.installation.trustRecord,
        installation: claimed.installDecision.installation,
      };
    }
    if (claimed.installDecision) {
      return this.#forwardInstallDecision({
        transferId: input.transferId,
        recoveryRoot: input.recoveryRoot,
        candidate,
        decision: claimed.installDecision,
        context,
      });
    }
    if (state.phase !== "imported") {
      throw new Error("Disaster recovery install decision is missing from private progress");
    }
    const imported = state.imported;
    const current = replayTrustChain(claimed.verified.baselineEvents);
    const snapshot = await this.options.readiness.reserve({
      transferId: input.transferId,
      expiresAt: imported.readyProof.expiresAt,
    });
    validateAnchorTransferReadyProof({
      proof: imported.readyProof,
      trust: current,
      targetDeviceId: this.options.deviceId,
      expected: snapshot,
      expectedIdentity: {
        requestId: claimed.prepare.requestId,
        candidateDigest: disasterReadyCandidateDigest({
          prepare: claimed.prepare,
          baseline: claimed.verified.baseline,
          onsiteVerification: claimed.verified.onsiteVerification,
          trustEvidenceDigest: claimed.verified.trustEvidenceDigest,
        }),
      },
      now: this.options.now?.(),
    });
    const issuerKey = await loadAnchorIssuerKey(this.options.secretStore, input.transferId);
    if (
      !issuerKey || issuerKey.deviceId !== imported.readyProof.targetIssuerKeyId ||
      issuerKey.publicKey !== imported.targetIssuerPublicKey
    ) throw new Error("Disaster recovery issuer key no longer matches the verified candidate");

    const records = parseDisasterAuthorityRecordSet(
      await context.artifacts.get(claimed.verified.authorityRecordsRef),
    );
    const sourceFacts = await readSourceFacts(context.artifacts, records);
    assertTrustPrefix(sourceFacts.trustEvents, claimed.verified.baselineEvents);
    const missingTrust = claimed.verified.baselineEvents.slice(sourceFacts.trustEvents.length);
    let nextTrust = applyTrustEvent(current, imported.trustTransition);
    const now = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const revoke = createSignedTrustEvent({
      current: nextTrust,
      at: now,
      signer: issuerKey,
      body: {
        t: "revoke",
        deviceId: imported.baseline.issuer.deviceId,
        reason: "disaster-recovery",
      },
    });
    nextTrust = applyTrustEvent(nextTrust, revoke);
    const trustRecord = buildHomeTrustRecord(nextTrust, issuerKey);
    const compromised = projectDeviceCredentialRevocation({
      records: latestExposureRecords(sourceFacts.exposures),
      deviceId: imported.baseline.issuer.deviceId,
      markedAt: now,
    }).records.filter((record) =>
      record.deviceId === imported.baseline.issuer.deviceId && record.state === "compromised");
    const commit = createSignedDisasterRecoveryCommit({
      v: 1,
      mode: "disaster-recovery",
      transferId: input.transferId,
      targetDeviceId: this.options.deviceId,
      checkpointEnvelopeDigest: imported.checkpointEnvelopeDigest,
      authorityCatalogDigest: authorityCatalogDigest(imported.catalog),
      trustTransitionDigest: protocolDigest(
        "HomeTrustEvent",
        1,
        unsignedTrustEvent(imported.trustTransition),
      ),
      readyProofDigest: readyProofDigest(imported.readyProof),
      nextAnchorEpoch: imported.nextAnchorEpoch,
      nextTrustEpoch: imported.nextTrustEpoch,
      targetIssuerPublicKey: imported.targetIssuerPublicKey,
      at: now,
    }, input.recoveryRoot);
    const installation = createDisasterRecoveryInstallation({
      commit,
      recoveryRootPublicKey: input.recoveryRoot.rootPublicKey,
      transition: imported.trustTransition,
      revoke,
      trustRecord,
      authorityRecords: claimed.verified.authorityRecordsRef,
      catalog: claimed.verified.catalogRef,
      sourceHead: records.source,
    });
    const references = uniqueRefs([
      claimed.verified.authorityRecordsRef,
      claimed.verified.catalogRef,
      ...records.pages.map((page) => page.ref),
      ...claimed.verified.catalog.retainedArtifacts,
    ]);
    for (const reference of references) {
      await this.#promote(context, reference, input.signal);
    }
    const finalSnapshot = await this.options.readiness.reserve({
      transferId: input.transferId,
      expiresAt: imported.readyProof.expiresAt,
    });
    validateAnchorTransferReadyProof({
      proof: imported.readyProof,
      trust: current,
      targetDeviceId: this.options.deviceId,
      expected: finalSnapshot,
      expectedIdentity: {
        requestId: claimed.prepare.requestId,
        candidateDigest: disasterReadyCandidateDigest({
          prepare: claimed.prepare,
          baseline: claimed.verified.baseline,
          onsiteVerification: claimed.verified.onsiteVerification,
          trustEvidenceDigest: claimed.verified.trustEvidenceDigest,
        }),
      },
      now: this.options.now?.(),
    });
    input.signal?.throwIfAborted();
    const installationEntries: readonly LogicalRecord<unknown>[] = [
      ...missingTrust.map((event) => ({
        stream: "trust",
        body: { t: "home-trust-event", event },
      })),
      { stream: "trust", body: { t: "home-trust-event", event: imported.trustTransition } },
      { stream: "trust", body: { t: "home-trust-event", event: revoke } },
      { stream: "trust", body: { t: "home-trust-record", record: trustRecord } },
      ...compromised.map((record) => ({ stream: "exposure", body: record })),
      {
        stream: DISASTER_TRANSFER_STREAM,
        body: {
          v: 1,
          mode: "disaster-recovery",
          t: "anchor-committed",
          transferId: input.transferId,
          commit,
        } satisfies DisasterRecord,
      },
      { stream: "transfer:anchor-current", body: installation },
    ];
    const decided = await candidate.decideInstall(input.transferId, {
      installationEntries,
      installation,
      candidateReferences: references,
    });
    if (!decided.installDecision) {
      throw new Error("Disaster candidate did not retain its install decision");
    }
    return this.#forwardInstallDecision({
      transferId: input.transferId,
      recoveryRoot: input.recoveryRoot,
      candidate,
      decision: decided.installDecision,
      context,
    });
  }

  async abort(input: {
    readonly abort: import("@zhixing/core/contracts").DisasterRecoveryAbort;
    readonly recoveryRoot: RecoveryRoot;
  }): Promise<DisasterRecoveryAbortState> {
    const candidate = this.#candidateFor(input.recoveryRoot.rootPublicKey);
    const claimed = await candidate.state(input.abort.transferId);
    if (!claimed) throw new Error("Disaster recovery abort has no durable candidate claim");
    assertRecoveryRoot(claimed.prepare, input.recoveryRoot);
    const abort = validateDisasterRecoveryAbort(input.abort, {
      verify: (schemaId, version, payload, signature) =>
        verifyRecoverySignature(input.recoveryRoot.rootPublicKey, schemaId, version, payload, signature),
    });
    const installed = await loadCurrentDisasterRecoveryInstallation(this.options.authorityLog);
    if (installed?.installation.transferId === input.abort.transferId) {
      throw new Error("Committed disaster recovery cannot be cancelled");
    }
    const terminal = await candidate.terminal(input.abort.transferId, "aborted", abort);
    const context = await this.#context(input.abort.transferId, input.recoveryRoot.rootPublicKey);
    const current = await context.journal.state(input.abort.transferId);
    if (current?.phase === "committed" || current?.phase === "tombstoned") {
      throw new Error("Committed disaster recovery cannot be cancelled");
    }
    const state: DisasterRecoveryAbortState = current === undefined
      ? Object.freeze({
          phase: "aborted" as const,
          transferId: input.abort.transferId,
          abort: terminal.abort!,
        })
      : current.phase === "aborted"
        ? current
        : await context.journal.append({
          v: 1,
          mode: "disaster-recovery",
          t: "anchor-aborted",
          transferId: input.abort.transferId,
          abort,
        });
    const transferKey = await loadAnchorIssuerKey(
      this.options.secretStore,
      input.abort.transferId,
    );
    if (transferKey) {
      await deleteAnchorIssuerKey(
        this.options.secretStore,
        input.abort.transferId,
        transferKey.deviceId,
      );
    }
    await rm(path.join(this.options.stagingRoot, "transfers", input.abort.transferId), {
      recursive: true,
      force: true,
    });
    await this.options.readiness.release(input.abort.transferId);
    return state;
  }

  async #deleteFreshIssuerKeyIfAborted(input: {
    readonly candidate: FileDisasterRecoveryCandidateJournal;
    readonly prepare: Extract<DisasterRecoveryCommand, { readonly op: "prepare" }>;
    readonly issuerKey: DeviceKey;
  }): Promise<void> {
    const current = await input.candidate.state(input.prepare.transferId);
    if (current?.terminal !== "aborted") return;
    if (canonicalize(current.prepare) !== canonicalize(input.prepare)) {
      throw new Error("Disaster recovery abort belongs to another candidate identity");
    }
    await deleteAnchorIssuerKey(
      this.options.secretStore,
      input.prepare.transferId,
      input.issuerKey.deviceId,
    );
    throw new Error("Disaster recovery candidate was durably aborted");
  }

  async tombstone(input: {
    readonly transferId: string;
    readonly userConfirmedOldDeviceIsolated: boolean;
    readonly at?: string;
  }): Promise<DisasterRecoveryState> {
    if (!input.userConfirmedOldDeviceIsolated) {
      throw new Error("确认旧设备已隔离后才能完成恢复");
    }
    const installed = await loadCurrentDisasterRecoveryInstallation(this.options.authorityLog);
    if (!installed || installed.installation.transferId !== input.transferId) {
      throw new Error("当前安全域没有对应的灾难恢复提交");
    }
    const context = await this.#context(
      input.transferId,
      installed.installation.recoveryRootPublicKey,
    );
    const current = await context.journal.state(input.transferId);
    if (!current?.commit || (current.phase !== "committed" && current.phase !== "tombstoned")) {
      throw new Error("灾难恢复尚未提交，不能确认旧设备隔离");
    }
    if (current.phase === "tombstoned") return current;
    return context.journal.append({
      v: 1,
      mode: "disaster-recovery",
      t: "anchor-tombstoned",
      transferId: input.transferId,
      commitDigest: anchorTransferCommitDigest(current.commit),
      at: input.at ?? new Date(this.options.now?.() ?? Date.now()).toISOString(),
    });
  }

  async #forwardInstallDecision(input: {
    readonly transferId: string;
    readonly recoveryRoot: RecoveryRoot;
    readonly candidate: FileDisasterRecoveryCandidateJournal;
    readonly decision: DisasterRecoveryInstallDecision;
    readonly context: {
      readonly root: string;
      readonly artifacts: FileArtifactStore;
      readonly journal: FileDisasterRecoveryTransferJournal;
    };
  }): Promise<{
    readonly state: DisasterRecoveryState;
    readonly trustRecord: HomeTrustRecord;
    readonly installation: DisasterRecoveryInstallation;
  }> {
    let installed = await loadCurrentDisasterRecoveryInstallation(this.options.authorityLog);
    if (installed) {
      if (
        installed.installation.transferId !== input.transferId ||
        canonicalize(installed.installation) !== canonicalize(input.decision.installation)
      ) throw new Error("Another authority generation is current before disaster completion");
    } else {
      const claimed = await input.candidate.state(input.transferId);
      if (!claimed?.verified || !claimed.installDecision) {
        throw new Error("Disaster authority install has no durable decision");
      }
      if (canonicalize(claimed.installDecision) !== canonicalize(input.decision)) {
        throw new Error("Disaster authority install decision conflicts with replay");
      }
      const stored = await this.#readVerifiedCandidateArtifacts(
        input.context.artifacts,
        claimed.verified,
        false,
      );
      if (
        canonicalize(stored.authorityRecords.source) !==
        canonicalize(input.decision.installation.sourceHead)
      ) throw new Error("Disaster authority source differs from its install decision");
      await this.options.authorityLog.installPlannedAnchorPrefix({
        source: disasterAuthorityEnvelopes(input.context.artifacts, stored.authorityRecords),
        sourceHead: input.decision.installation.sourceHead,
        installationEntries: input.decision.installationEntries,
        candidateReferences: input.decision.candidateReferences,
      });
      installed = await loadCurrentDisasterRecoveryInstallation(this.options.authorityLog);
    }
    if (
      !installed ||
      canonicalize(installed.installation) !== canonicalize(input.decision.installation)
    ) throw new Error("Disaster authority installation failed exact read-back");
    return this.#completeInstalled(
      input.transferId,
      input.recoveryRoot,
      input.decision,
    );
  }

  async #completeInstalled(
    transferId: string,
    recoveryRoot: RecoveryRoot,
    decision: DisasterRecoveryInstallDecision,
  ): Promise<{
    readonly state: DisasterRecoveryState;
    readonly trustRecord: HomeTrustRecord;
    readonly installation: DisasterRecoveryInstallation;
  }> {
    const installation = decision.installation;
    const candidate = this.#candidateFor(recoveryRoot.rootPublicKey);
    const durableCandidate = await candidate.state(transferId);
    if (
      !durableCandidate?.installDecision ||
      canonicalize(durableCandidate.installDecision) !== canonicalize(decision)
    ) throw new Error("Installed disaster recovery has no matching candidate decision");
    const installed = await loadCurrentDisasterRecoveryInstallation(this.options.authorityLog);
    if (
      !installed ||
      canonicalize(installed.installation) !== canonicalize(installation)
    ) throw new Error("Installed disaster recovery is not current authority");
    const context = await this.#context(transferId, recoveryRoot.rootPublicKey);
    let state = await context.journal.state(transferId);
    if (!state) throw new Error("Installed disaster recovery has no private replay state");
    if (state.phase === "imported") {
      await activateAnchorIssuerKey(
        this.options.secretStore,
        transferId,
        installation.trustRecord.issuer.issuerKeyId,
      );
      state = await context.journal.append({
        v: 1,
        mode: "disaster-recovery",
        t: "anchor-committed",
        transferId,
        commit: installation.commit,
      });
    }
    if (state.phase !== "committed" && state.phase !== "tombstoned") {
      throw new Error("Installed disaster recovery journal is not committed");
    }
    const activeKey = await loadActiveAnchorIssuerKey(
      this.options.secretStore,
      installation.trustRecord.issuer.issuerKeyId,
    );
    if (!activeKey || activeKey.publicKey !== installation.trustRecord.issuer.issuerPublicKey) {
      throw new Error("Installed disaster recovery issuer key is not active");
    }
    await candidate.terminal(transferId, "committed");
    return { state, trustRecord: installation.trustRecord, installation };
  }

  async #promote(
    context: { readonly root: string; readonly artifacts: FileArtifactStore },
    ref: ArtifactRef,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.options.sharedArtifacts.has(ref)) return;
    const receiver = new FileResumableArtifactReceiver(
      this.options.sharedArtifacts,
      path.join(context.root, "promotion-partials"),
      { maxArtifactBytes: MAX_TRANSFER_ARTIFACT_BYTES, maxChunkBytes: TRANSFER_CHUNK_BYTES },
    );
    let progress = await receiver.progress(ref);
    while (!progress.complete) {
      if (signal?.aborted) throw signal.reason ?? new Error("Disaster recovery was cancelled");
      const offset = progress.receivedBytes;
      const length = Math.min(TRANSFER_CHUNK_BYTES, ref.bytes - offset);
      const bytes = await runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.deviceId,
          { transferId: path.basename(context.root), ref, offset, phase: "disaster-promote-read" },
          { obligation: "committed" },
        ),
        () => context.artifacts.readRange(ref, offset, length),
      );
      progress = await receiver.append(
        ref,
        offset,
        bytes,
        (_identity, operation) => runStorageMaintenanceStep(
          this.options.storageMaintenance,
          storageMaintenanceRequest(
            "authority-checkpoint",
            this.options.deviceId,
            { transferId: path.basename(context.root), ref, offset, phase: "disaster-promote-write" },
            { obligation: "committed" },
          ),
          operation,
        ),
      );
    }
  }

  #candidateFor(rootPublicKey: string): FileDisasterRecoveryCandidateJournal {
    return new FileDisasterRecoveryCandidateJournal(
      new FileAuthorityCommitLog(
        path.join(this.options.stagingRoot, "candidate-claims"),
        this.options.sharedArtifacts,
        { storageMaintenance: this.options.storageMaintenance },
      ),
      rootPublicKey,
    );
  }

  async #context(
    transferId: string,
    rootPublicKey: string,
    issuerKey?: DeviceKey,
  ): Promise<{
    readonly root: string;
    readonly artifacts: FileArtifactStore;
    readonly journal: FileDisasterRecoveryTransferJournal;
  }> {
    const root = path.join(this.options.stagingRoot, "transfers", transferId);
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(
      path.join(this.options.stagingRoot, "journals", transferId),
      artifacts,
      { storageMaintenance: this.options.storageMaintenance },
    );
    const targetIssuer = issuerKey ?? (await loadAnchorIssuerKey(
      this.options.secretStore,
      transferId,
    ) ?? await loadStoredTargetIssuer(log));
    const journal = new FileDisasterRecoveryTransferJournal(
      log,
      disasterVerifiers(
        rootPublicKey,
        this.options.identity,
        targetIssuer,
      ),
      this.options.now ?? Date.now,
    );
    return { root, artifacts, journal };
  }
}

function disasterReadyCandidateDigest(input: {
  readonly prepare: PrepareCommand;
  readonly baseline: import("@zhixing/core/contracts").DisasterRecoveryBaseline;
  readonly onsiteVerification: import("@zhixing/core/contracts").RecoveryCheckpointVerification;
  readonly trustEvidenceDigest: string;
}): string {
  return protocolDigest("DisasterRecoveryReadyCandidate", 1, {
    requestId: input.prepare.requestId,
    transferId: input.prepare.transferId,
    targetDeviceId: input.prepare.targetDeviceId,
    checkpointTargetId: input.prepare.checkpointTargetId,
    checkpointEnvelopeDigest: input.prepare.checkpointEnvelope.digest,
    baseline: input.baseline,
    onsiteVerification: input.onsiteVerification,
    trustEvidenceDigest: input.trustEvidenceDigest,
  });
}

export async function completeDisasterRecoveryInstallationBeforeBootstrap(input: {
  readonly zhixingHome: string;
  readonly deviceId: string;
  readonly secretStore: SecretStorePort;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly stagingRoot?: string;
  readonly now?: () => number;
}): Promise<DisasterRecoveryPostInstallDescriptor | undefined> {
  const authorityLog = input.bootstrapStore.authorityLog();
  const installed = await loadCurrentDisasterRecoveryInstallation(authorityLog);
  if (!installed || installed.installation.trustRecord.issuer.deviceId !== input.deviceId) {
    return undefined;
  }
  const { installation } = installed;
  const trust = await input.bootstrapStore.loadTrustRecord();
  if (!trust || canonicalize(trust) !== canonicalize(installation.trustRecord)) {
    throw new Error("Installed disaster recovery trust does not match current authority");
  }
  const target = trust.members.find((member) => member.device.deviceId === input.deviceId);
  if (!target || target.state !== "active" || !target.roles.includes("anchor")) {
    throw new Error("Installed disaster recovery target is not current-duty eligible");
  }
  const receipt = await loadDisasterRecoveryPostInstallReceipt({
    log: authorityLog,
    generation: installed.generation,
  });
  const stagingRoot = input.stagingRoot ?? path.join(
    input.zhixingHome,
    "distributed-runtime",
    "disaster-recovery-staging",
  );
  const privateRoot = path.join(stagingRoot, "transfers", installation.transferId);
  const privateArtifacts = new FileArtifactStore(path.join(privateRoot, "artifacts"));
  const transferKey = await loadAnchorIssuerKey(input.secretStore, installation.transferId);
  const privateLog = new FileAuthorityCommitLog(
    path.join(stagingRoot, "journals", installation.transferId),
    privateArtifacts,
    { storageMaintenance: input.storageMaintenance },
  );
  const storedIssuer = transferKey ?? await loadStoredTargetIssuer(privateLog);
  const journal = new FileDisasterRecoveryTransferJournal(
    privateLog,
    disasterVerifiers(
      installation.recoveryRootPublicKey,
      target.device,
      storedIssuer,
    ),
    input.now ?? Date.now,
  );
  let state = await journal.state(installation.transferId);
  if (!state) throw new Error("Installed disaster recovery has no exact private replay state");
  if (state.phase === "imported") {
    if (
      !transferKey || transferKey.deviceId !== installation.trustRecord.issuer.issuerKeyId ||
      transferKey.publicKey !== installation.commit.targetIssuerPublicKey
    ) throw new Error("Installed disaster recovery is missing its exact issuer key");
    await activateAnchorIssuerKey(
      input.secretStore,
      installation.transferId,
      installation.trustRecord.issuer.issuerKeyId,
    );
    state = await journal.append({
      v: 1,
      mode: "disaster-recovery",
      t: "anchor-committed",
      transferId: installation.transferId,
      commit: installation.commit,
    });
  }
  if (state.phase !== "committed" && state.phase !== "tombstoned") {
    throw new Error("Installed disaster recovery private journal is not committed");
  }
  const candidate = new FileDisasterRecoveryCandidateJournal(
    new FileAuthorityCommitLog(
      path.join(stagingRoot, "candidate-claims"),
      input.bootstrapStore.artifactStore(),
      { storageMaintenance: input.storageMaintenance },
    ),
    installation.recoveryRootPublicKey,
  );
  const candidateState = await candidate.state(installation.transferId);
  if (
    !candidateState?.installDecision ||
    canonicalize(candidateState.installDecision.installation) !== canonicalize(installation)
  ) throw new Error("Installed disaster recovery has no matching target-wide decision");
  const activeKey = await loadActiveAnchorIssuerKey(
    input.secretStore,
    installation.trustRecord.issuer.issuerKeyId,
  );
  if (!activeKey || activeKey.publicKey !== installation.trustRecord.issuer.issuerPublicKey) {
    throw new Error("Installed disaster recovery issuer key is not active");
  }
  await candidate.terminal(installation.transferId, "committed");
  input.bootstrapStore.bindIssuerKey(activeKey);
  const catalogText = Buffer.from(
    await input.bootstrapStore.artifactStore().get(installation.catalog),
  ).toString("utf8");
  const rawCatalog = JSON.parse(catalogText) as unknown;
  if (canonicalize(rawCatalog) !== catalogText) {
    throw new Error("Installed disaster recovery catalog is not canonical");
  }
  const catalog = prepareAuthorityCatalog(rawCatalog).catalog;
  if (
    catalog.transferId !== installation.transferId ||
    canonicalize(catalog.source) !== canonicalize(installation.sourceHead)
  ) throw new Error("Installed disaster recovery catalog does not match its authority base");
  return Object.freeze({
    installation,
    installedGeneration: installed.generation,
    ...(state ? { state } : {}),
    pendingObligations: catalog.pendingObligations,
    requiresPostInstallCompletion: receipt === undefined,
  });
}

export async function finishDisasterRecoveryPostInstall(input: {
  readonly zhixingHome: string;
  readonly transferId: string;
  readonly readiness: PlannedAnchorReadinessPort;
  readonly authorityLog: FileAuthorityCommitLog;
  readonly installedGeneration: import("./disaster-recovery-installation.js").DisasterInstalledAuthorityGeneration;
  readonly participants: readonly string[];
  readonly readBack: readonly {
    readonly kind: import("@zhixing/core/contracts").AuthorityCatalog["pendingObligations"][number]["kind"];
    readonly id: string;
    readonly disposition: "current-owner" | "terminal";
  }[];
}): Promise<void> {
  await recordDisasterRecoveryPostInstallReceipt({
    log: input.authorityLog,
    generation: input.installedGeneration,
    participants: input.participants,
    readBack: input.readBack,
  });
  await rm(path.join(
    input.zhixingHome,
    "distributed-runtime",
    "disaster-recovery-staging",
    "transfers",
    input.transferId,
  ), { recursive: true, force: true });
  await input.readiness.release(input.transferId);
}

function reduceDisasterJournal(
  states: ReadonlyMap<string, DisasterRecoveryState>,
  entry: LogicalRecord<unknown>,
  verifiers: DisasterRecoveryVerifiers,
  now: number,
): ReadonlyMap<string, DisasterRecoveryState> {
  if (entry.stream !== DISASTER_TRANSFER_STREAM) return states;
  const stored = entry.body as Partial<StoredDisasterRecord> & Record<string, unknown>;
  if (
    stored.v !== 1 || stored.t !== "disaster-recovery-record" ||
    typeof stored.recordJson !== "string" ||
    canonicalize(Object.keys(stored).sort()) !== canonicalize(["recordJson", "t", "v"])
  ) throw new TypeError("Disaster recovery journal record is invalid");
  const raw = JSON.parse(stored.recordJson) as unknown;
  if (canonicalize(raw) !== stored.recordJson) {
    throw new TypeError("Disaster recovery journal record is not canonical");
  }
  const record = raw as DisasterRecord;
  const current = states.get(record.transferId);
  const next = reduceDisasterRecovery(current, record, verifiers, now);
  if (next === current) return states;
  const updated = new Map(states);
  updated.set(record.transferId, next);
  return updated;
}

function disasterVerifiers(
  rootPublicKey: string,
  target: DeviceIdentity,
  targetIssuer?: Pick<DeviceKey, "deviceId" | "publicKey">,
): DisasterRecoveryVerifiers {
  const recoveryRoot: ProtocolSignatureVerifier = {
    verify(schemaId, version, payload, signature) {
      verifyRecoverySignature(rootPublicKey, schemaId, version, payload, signature);
    },
  };
  return {
    recoveryRoot,
    targetDevice: {
      verify(schemaId, version, payload, signature) {
        verifyDeviceSignature(target, schemaId, version, payload, signature);
      },
    },
    targetIssuer: {
      verify(schemaId, version, payload, signature) {
        if (!targetIssuer) {
          throw new TypeError("Disaster recovery target issuer key is not prepared");
        }
        verifyDeviceSignature({
          ...target,
          deviceId: targetIssuer.deviceId,
          publicKey: targetIssuer.publicKey,
        }, schemaId, version, payload, signature);
      },
    },
  };
}

async function loadStoredTargetIssuer(
  log: FileAuthorityCommitLog,
): Promise<Pick<DeviceKey, "deviceId" | "publicKey"> | undefined> {
  const entries = await log.readStream<StoredDisasterRecord>(DISASTER_TRANSFER_STREAM);
  for (const entry of entries.toReversed()) {
    const stored = entry.body;
    if (
      stored.v !== 1 || stored.t !== "disaster-recovery-record" ||
      typeof stored.recordJson !== "string"
    ) continue;
    const raw = JSON.parse(stored.recordJson) as Partial<DisasterRecord>;
    if (canonicalize(raw) !== stored.recordJson || raw.t !== "anchor-imported") continue;
    const imported = raw.imported;
    if (
      imported?.op !== "import" ||
      typeof imported.readyProof.targetIssuerKeyId !== "string" ||
      typeof imported.targetIssuerPublicKey !== "string"
    ) continue;
    return Object.freeze({
      deviceId: imported.readyProof.targetIssuerKeyId,
      publicKey: imported.targetIssuerPublicKey,
    });
  }
  return undefined;
}

function assertRecoveryRoot(prepare: PrepareCommand, root: RecoveryRoot): void {
  const identity = root.publicIdentity();
  if (
    prepare.recoveryRoot.rootKeyId !== identity.rootKeyId ||
    prepare.recoveryRoot.recipientKeyId !== identity.backupKeyId ||
    prepare.checkpointEnvelope.recipientKeyId !== identity.backupKeyId
  ) {
    throw new TypeError("Recovery package does not match the selected backup");
  }
}

async function readSourceFacts(
  artifacts: FileArtifactStore,
  records: DisasterAuthorityRecordSet,
): Promise<{
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly exposures: readonly CredentialExposureRecord[];
}> {
  const trustEvents: HomeTrustEvent[] = [];
  const exposures: CredentialExposureRecord[] = [];
  for await (const envelope of disasterAuthorityEnvelopes(artifacts, records)) {
    for (const entry of envelope.entries) {
      const body = entry.body as Record<string, unknown>;
      if (entry.stream === "trust" && body.t === "home-trust-event") {
        trustEvents.push(body.event as HomeTrustEvent);
      } else if (entry.stream === "exposure" && isExposureRecord(body)) {
        exposures.push(body as unknown as CredentialExposureRecord);
      }
    }
  }
  if (trustEvents.length === 0) throw new Error("Recovery authority has no trust prefix");
  replayTrustChain(trustEvents);
  return { trustEvents, exposures };
}

function assertTrustPrefix(
  source: readonly HomeTrustEvent[],
  baseline: readonly HomeTrustEvent[],
): void {
  if (source.length > baseline.length) {
    throw new Error("Recovery checkpoint trust is ahead of its selected baseline");
  }
  for (let index = 0; index < source.length; index += 1) {
    if (protocolDigest("HomeTrustEvent", 1, unsignedTrustEvent(source[index]!)) !==
      protocolDigest("HomeTrustEvent", 1, unsignedTrustEvent(baseline[index]!))) {
      throw new Error("Recovery checkpoint trust is not a prefix of its selected baseline");
    }
  }
}

function latestExposureRecords(
  records: readonly CredentialExposureRecord[],
): readonly CredentialExposureRecord[] {
  const latest = new Map<string, CredentialExposureRecord>();
  for (const record of records) {
    const key = [
      record.deviceId,
      record.bindingId,
      record.service,
      record.principalFingerprint ?? "",
      record.tenant ?? "",
      ...(record.scopes ?? []),
    ].join("\0");
    const prior = latest.get(key);
    if (!prior || prior.markedAt < record.markedAt) latest.set(key, record);
  }
  return [...latest.values()];
}

function isExposureRecord(value: Record<string, unknown>): boolean {
  return typeof value.deviceId === "string" && typeof value.bindingId === "string" &&
    typeof value.service === "string" && typeof value.state === "string" &&
    typeof value.markedAt === "string";
}

function uniqueRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const prior = unique.get(ref.digest);
    if (prior && prior.bytes !== ref.bytes) throw new Error("Artifact digest has conflicting sizes");
    unique.set(ref.digest, ref);
  }
  return [...unique.values()].sort((left, right) =>
    left.digest.localeCompare(right.digest, "en-US"));
}

function unsignedTrustEvent(event: HomeTrustEvent): Omit<HomeTrustEvent, "signature"> {
  const { signature: _, ...unsigned } = event;
  return unsigned;
}
