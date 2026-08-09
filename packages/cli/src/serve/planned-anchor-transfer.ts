import path from "node:path";
import type {
  AnchorTransferCommand,
  AnchorTransferCommit,
  AnchorTransferResult,
  ArtifactRef,
  AuthorityCatalog,
  CommitEnvelope,
  HomeTrustEvent,
  HomeTrustEventWithBody,
  HomeTrustEventBody,
  HomeTrustRecord,
  LogicalRecord,
  ReadyProof,
  SecretStorePort,
  TransferRecord,
} from "@zhixing/core/contracts";
import type { DurableLogCheckpoint } from "@zhixing/core/authority";
import {
  collectArtifactRefs,
  FileArtifactStore,
} from "@zhixing/core/authority";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
} from "@zhixing/core/resources";
import {
  createSignedAnchorTransferCommand,
  createSignedAnchorTransferAbort,
  createSignedPlannedAnchorTransferCommit,
  canonicalize,
  createSignedSourceFreezeProof,
  prepareAuthorityCatalog,
  protocolDigest,
  readyProofDigest,
  reducePlannedAnchorTransfer,
  sourceFreezeProofDigest,
  validateAnchorTransferCommand,
  type PlannedAnchorTransferState,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import {
  createAnchorTransferReadyProof,
  validateAnchorTransferReadyProof,
  type AnchorTransferReadySnapshot,
} from "@zhixing/mesh/anchor-transfer-ready";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import {
  activateAnchorIssuerKey,
  deleteAnchorIssuerKey,
  loadAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  replayTrustChain,
  type TrustProjection,
} from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

const ANCHOR_TRANSFER_STREAM = "transfer:anchor";

type PlannedRecord = Extract<TransferRecord, { mode: "planned" }>;
type MigrationTransition = HomeTrustEventWithBody<
  Extract<HomeTrustEventBody, { t: "issuer-transition"; reason: "migration" }>
>;

export interface PlannedAnchorTransferLifecycle {
  stopAccepting(): void | Promise<void>;
  drainAccepted(): Promise<void>;
  resumeAfterAbort(): void | Promise<void>;
}

export interface PlannedAnchorTransferTargetPort {
  ready(input: {
    readonly transferId: string;
    readonly sourceDeviceId: string;
  }): Promise<ReadyProof>;
  apply(command: AnchorTransferCommand): Promise<AnchorTransferResult>;
}

export interface PlannedAnchorTransferArtifactSourcePort {
  applyArtifactCommand(command: AnchorTransferCommand): Promise<AnchorTransferResult>;
}

export class FilePlannedAnchorTransferJournal {
  constructor(
    private readonly log: FileAuthorityCommitLog,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async state(transferId: string): Promise<PlannedAnchorTransferState | undefined> {
    return (await this.states()).get(transferId);
  }

  async states(): Promise<ReadonlyMap<string, PlannedAnchorTransferState>> {
    return this.log.rebuildProjection<
      ReadonlyMap<string, PlannedAnchorTransferState>,
      PlannedRecord
    >(
      new Map<string, PlannedAnchorTransferState>(),
      (states, entry) => reduceJournal(states, entry, this.verifier),
      { stream: ANCHOR_TRANSFER_STREAM },
    );
  }

  async append(
    record: PlannedRecord,
    extraEntries: readonly LogicalRecord<unknown>[] = [],
  ): Promise<PlannedAnchorTransferState> {
    const entries = [
      ...extraEntries,
      { stream: ANCHOR_TRANSFER_STREAM, body: record },
    ] as LogicalRecord<PlannedRecord>[];
    const result = await this.log.transactProjection<
      ReadonlyMap<string, PlannedAnchorTransferState>,
      PlannedRecord,
      PlannedAnchorTransferState
    >(
      new Map(),
      (states, entry) => reduceJournal(states, entry, this.verifier),
      (states) => {
        const current = states.get(record.transferId);
        const next = reducePlannedAnchorTransfer(current, record, this.verifier);
        if (current === next) return { kind: "return", value: next };
        return {
          kind: "append",
          entries,
          value: next,
        };
      },
      {
        stream: ANCHOR_TRANSFER_STREAM,
        candidateReferences: collectArtifactRefs(entries),
      },
    );
    return result.value;
  }

  async assertNoCompetingTransfer(transferId: string): Promise<void> {
    for (const [candidate, state] of await this.states()) {
      if (
        candidate !== transferId &&
        state.phase !== "aborted" &&
        state.phase !== "tombstoned"
      ) {
        throw new Error("Another duty-device migration is already in progress");
      }
    }
  }
}

export class PlannedAnchorTransferTarget implements PlannedAnchorTransferTargetPort {
  readonly #journal: FilePlannedAnchorTransferJournal;
  readonly #stagingArtifacts: FileArtifactStore;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly identityKey: DeviceKey;
    readonly secretStore: SecretStorePort;
    readonly bootstrapStore: FileMeshBootstrapStore;
    readonly authorityLog: FileAuthorityCommitLog;
    readonly artifacts: FileArtifactStore;
    readonly stagingRoot: string;
    readonly sourceFor: (deviceId: string) => PlannedAnchorTransferArtifactSourcePort;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly readiness: () => Promise<AnchorTransferReadySnapshot>;
    readonly onInstalled?: (record: HomeTrustRecord) => void | Promise<void>;
    readonly now?: () => number;
  }) {
    if (options.identityKey.deviceId !== options.deviceId) {
      throw new TypeError("Migration target identity key belongs to another device");
    }
    this.#stagingArtifacts = new FileArtifactStore(
      path.join(options.stagingRoot, "artifacts"),
    );
    this.#journal = new FilePlannedAnchorTransferJournal(
      new FileAuthorityCommitLog(
        path.join(options.stagingRoot, "journal"),
        this.#stagingArtifacts,
        { storageMaintenance: options.storageMaintenance },
      ),
      options.verifier,
    );
  }

  state(transferId: string): Promise<PlannedAnchorTransferState | undefined> {
    return this.#journal.state(transferId);
  }

  async ready(input: {
    readonly transferId: string;
    readonly sourceDeviceId: string;
  }): Promise<ReadyProof> {
    const existing = await this.#journal.state(input.transferId);
    if (existing) {
      if (
        existing.identity.sourceDeviceId !== input.sourceDeviceId ||
        existing.identity.targetDeviceId !== this.options.deviceId
      ) {
        throw new Error("Migration ready replay conflicts with its durable identity");
      }
      return existing.readyProof;
    }
    const trust = await currentTrust(this.options.bootstrapStore);
    if (trust.issuer.deviceId !== input.sourceDeviceId) {
      throw new Error("Only the current duty device can prepare a migration target");
    }
    await this.#journal.assertNoCompetingTransfer(input.transferId);
    return (await createAnchorTransferReadyProof({
      transferId: input.transferId,
      targetIdentityKey: this.options.identityKey,
      trust,
      secretStore: this.options.secretStore,
      snapshot: await this.options.readiness(),
      now: this.options.now?.(),
    })).proof;
  }

  async apply(commandInput: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const command = validateAnchorTransferCommand(commandInput, this.options.verifier);
    if (command.op === "status") return resultFor(command, await this.#journal.state(command.transferId));
    if (command.op === "freeze") return this.#freeze(command);
    if (command.op === "import") return this.#import(command);
    if (command.op === "commit") return this.#commit(command);
    if (command.op === "abort") return this.#abort(command);
    if (command.op !== "prepare") throw new Error("Migration target has not enabled this transfer phase yet");
    await this.#journal.assertNoCompetingTransfer(command.transferId);
    const trust = await currentTrust(this.options.bootstrapStore);
    if (
      command.sourceDeviceId !== trust.issuer.deviceId ||
      command.targetDeviceId !== this.options.deviceId
    ) {
      throw new Error("Migration prepare command does not bind the current devices");
    }
    validateAnchorTransferReadyProof({
      proof: command.readyProof,
      trust,
      targetDeviceId: this.options.deviceId,
      expected: await this.options.readiness(),
      now: this.options.now?.(),
    });
    const issuerKey = await loadAnchorIssuerKey(this.options.secretStore, command.transferId);
    if (
      !issuerKey ||
      issuerKey.deviceId !== command.readyProof.targetIssuerKeyId ||
      issuerKey.publicKey !== command.readyProof.targetIssuerPublicKey
    ) {
      throw new Error("Migration issuer key no longer matches its ready proof");
    }
    applyTrustEvent(trust, command.trustTransition);
    const state = await this.#journal.append(preparedRecord(command));
    return resultFor(command, state);
  }

  async #freeze(
    command: Extract<AnchorTransferCommand, { op: "freeze" }>,
  ): Promise<AnchorTransferResult> {
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase !== "prepared" && state.phase !== "fenced") {
      return resultFor(command, state);
    }
    if (
      command.proof.sourceEpoch !== state.identity.sourceAnchorEpoch ||
      command.proof.subject !== state.identity.sourceDeviceId
    ) {
      throw new TypeError("Migration freeze proof changes its prepared source identity");
    }
    const source = this.options.sourceFor(state.identity.sourceDeviceId);
    await this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-fenced",
      transferId: command.transferId,
      sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
      recoveryCheckpointDigest: command.recoveryCheckpointDigest,
      at: new Date().toISOString(),
    });
    await Promise.all([
      this.#pull(source, command, command.checkpoint),
      this.#pull(source, command, command.catalog),
    ]);
    const catalog = parseAuthorityCatalog(await this.#stagingArtifacts.get(command.catalog));
    const exported = parseAuthorityExport(await this.#stagingArtifacts.get(command.checkpoint));
    assertExportBinding(catalog, exported, command.proof, state);
    const next = await this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-frozen",
      transferId: command.transferId,
      checkpoint: command.checkpoint,
      catalog,
      catalogRef: command.catalog,
      proof: command.proof,
    });
    return resultFor(command, next);
  }

  async #import(
    command: Extract<AnchorTransferCommand, { op: "import" }>,
  ): Promise<AnchorTransferResult> {
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase === "imported") return resultFor(command, state);
    if (
      state.phase !== "frozen" ||
      state.checkpoint?.digest !== command.checkpoint.digest ||
      state.catalogRef?.digest !== command.catalog.digest
    ) {
      throw new TypeError("Migration import does not bind the frozen artifacts");
    }
    const next = await this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-imported",
      transferId: command.transferId,
      checkpointDigest: command.checkpoint.digest,
      authorityCatalogDigest: command.catalog.digest,
    });
    return resultFor(command, next);
  }

  async #commit(
    command: Extract<AnchorTransferCommand, { op: "commit" }>,
  ): Promise<AnchorTransferResult> {
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase === "committed" || state.phase === "tombstoned") {
      if (canonicalize(state.commit) !== canonicalize(command.commit)) {
        throw new TypeError("Migration commit replay changes the signed decision");
      }
      return resultFor(command, state);
    }
    if (state.phase !== "imported" || !state.checkpoint || !state.catalogRef || !state.catalog) {
      throw new Error("Migration target cannot commit before its private import is complete");
    }
    const committedRecord: Extract<PlannedRecord, { t: "anchor-committed" }> = {
      v: 1,
      mode: "planned",
      t: "anchor-committed",
      transferId: command.transferId,
      commit: command.commit,
    };
    reducePlannedAnchorTransfer(state, committedRecord, this.options.verifier);
    const issuerKey = await loadAnchorIssuerKey(this.options.secretStore, command.transferId);
    if (
      !issuerKey ||
      issuerKey.deviceId !== state.readyProof.targetIssuerKeyId ||
      issuerKey.publicKey !== command.commit.targetIssuerPublicKey
    ) {
      throw new Error("Migration commit no longer owns the prepared target issuer key");
    }
    const current = await currentTrust(this.options.bootstrapStore);
    if (
      current.homeId !== state.readyProof.homeId ||
      current.trustEpoch !== state.readyProof.trustEpoch ||
      canonicalize(current.chainHead) !== canonicalize(state.readyProof.trustChainHead)
    ) {
      throw new Error("Migration target trust generation changed before commit installation");
    }
    const transition = requireMigrationTransition(state.trustTransition);
    const nextTrust = applyTrustEvent(current, transition);
    if (nextTrust.trustEpoch !== command.commit.nextTrustEpoch) {
      throw new TypeError("Migration commit trust epoch does not match its transition");
    }
    const trustRecord = buildHomeTrustRecord(nextTrust, issuerKey);
    const references = uniqueRefs([
      state.checkpoint,
      state.catalogRef,
      state.catalog.authorityRecords,
      ...state.catalog.retainedArtifacts,
    ]);
    for (const reference of references) await this.#promote(reference, command.transferId);
    const exported = parseAuthorityExport(await this.#stagingArtifacts.get(state.checkpoint));
    await installPlannedAuthorityBase({
      log: this.options.authorityLog,
      transferId: command.transferId,
      commits: exported.commits,
    });
    await activateAnchorIssuerKey(
      this.options.secretStore,
      command.transferId,
      state.readyProof.targetIssuerKeyId,
    );
    await installPlannedAnchorAuthority({
      log: this.options.authorityLog,
      verifier: this.options.verifier,
      current,
      transition,
      record: trustRecord,
      commit: command.commit,
      checkpoint: state.checkpoint,
      catalog: state.catalogRef,
      candidateReferences: references,
    });
    const next = await this.#journal.append(committedRecord);
    await this.options.onInstalled?.(trustRecord);
    return resultFor(command, next);
  }

  async #abort(
    command: Extract<AnchorTransferCommand, { op: "abort" }>,
  ): Promise<AnchorTransferResult> {
    const state = await this.#requiredPrepared(command.transferId);
    if (state.phase === "committed" || state.phase === "tombstoned") {
      throw new Error("Committed migration cannot be cancelled");
    }
    if (state.phase === "aborted") {
      if (canonicalize(state.abort) !== canonicalize(command.abort)) {
        throw new TypeError("Migration abort replay changes the signed decision");
      }
      return resultFor(command, state);
    }
    const record: Extract<PlannedRecord, { t: "anchor-aborted" }> = {
      v: 1,
      mode: "planned",
      t: "anchor-aborted",
      transferId: command.transferId,
      abort: command.abort,
    };
    reducePlannedAnchorTransfer(state, record, this.options.verifier);
    const next = await this.#journal.append(record);
    const references = uniqueRefs([
      ...(state.checkpoint ? [state.checkpoint] : []),
      ...(state.catalogRef ? [state.catalogRef] : []),
      ...(state.catalog?.retainedArtifacts ?? []),
    ]);
    for (const reference of references) {
      await this.#stagingArtifacts.delete(reference);
    }
    await deleteAnchorIssuerKey(
      this.options.secretStore,
      command.transferId,
      state.readyProof.targetIssuerKeyId,
    );
    return resultFor(command, next);
  }

  async #requiredPrepared(transferId: string): Promise<PlannedAnchorTransferState> {
    const state = await this.#journal.state(transferId);
    if (!state) throw new Error("Migration target has no prepared state");
    return state;
  }

  async #pull(
    source: PlannedAnchorTransferArtifactSourcePort,
    origin: Extract<AnchorTransferCommand, { op: "freeze" }>,
    ref: ArtifactRef,
  ): Promise<void> {
    const self = this;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < ref.bytes;) {
        const length = Math.min(512 * 1024, ref.bytes - offset);
        const command = createSignedAnchorTransferCommand({
          v: 1,
          op: "read-range",
          requestId: `${origin.requestId}:range:${offset}`,
          transferId: origin.transferId,
          ref,
          offset,
          length,
        }, self.options.signer);
        if (command.op !== "read-range") throw new TypeError("Migration range command changed operation");
        const result = await source.applyArtifactCommand(command);
        if (result.status !== "range") throw new Error("Migration source did not return an artifact range");
        const bytes = Buffer.from(result.data, "base64");
        offset += bytes.byteLength;
        yield bytes;
      }
    }
    await this.#stagingArtifacts.putVerifiedStream(
      ref,
      chunks(),
      (operation) => runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.deviceId,
          { transferId: origin.transferId, ref },
          { obligation: "pre-commit" },
        ),
        operation,
      ),
    );
  }

  async #promote(ref: ArtifactRef, transferId: string): Promise<void> {
    if (await this.options.artifacts.has(ref)) return;
    const source = this.#stagingArtifacts;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < ref.bytes;) {
        const length = Math.min(512 * 1024, ref.bytes - offset);
        const bytes = await source.readRange(ref, offset, length);
        offset += bytes.byteLength;
        yield bytes;
      }
    }
    await this.options.artifacts.putVerifiedStream(
      ref,
      chunks(),
      (operation) => runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.deviceId,
          { transferId, ref, phase: "promote" },
          { obligation: "committed" },
        ),
        operation,
      ),
    );
  }
}

export class PlannedAnchorTransferOwner {
  readonly #journal: FilePlannedAnchorTransferJournal;
  #fenceMode: "open" | "draining" | "frozen" | "committed" = "open";
  #fencedTransferId: string | undefined;
  #disposeFence: (() => void) | undefined;

  constructor(private readonly options: {
    readonly deviceId: string;
    readonly anchorEpoch: () => number;
    readonly identityKey: DeviceKey;
    readonly bootstrapStore: FileMeshBootstrapStore;
    readonly log: FileAuthorityCommitLog;
    readonly signer: ProtocolSigner;
    readonly verifier: ProtocolSignatureVerifier;
    readonly targetFor: (deviceId: string) => PlannedAnchorTransferTargetPort;
    readonly artifacts: FileArtifactStore;
    readonly ensureRecoveryCheckpoint: (transferId: string) => Promise<string>;
    readonly lifecycle: PlannedAnchorTransferLifecycle;
    readonly now?: () => string;
  }) {
    this.#journal = new FilePlannedAnchorTransferJournal(options.log, options.verifier);
  }

  /** Reinstalls a durable source fence before any public producer is admitted. */
  async recoverBeforeAdmission(): Promise<void> {
    for (const [transferId, state] of await this.#journal.states()) {
      if (
        state.phase === "fenced" ||
        state.phase === "frozen" ||
        state.phase === "imported" ||
        state.phase === "committed" ||
        state.phase === "tombstoned"
      ) {
        this.#installFence(
          transferId,
          state.phase === "committed" || state.phase === "tombstoned"
            ? "committed"
          : "frozen",
        );
      }
      if (state.phase === "committed" && state.commit) {
        await this.#sendCommitted(state).catch(() => undefined);
      } else if (state.phase === "aborted" && state.abort) {
        await this.#sendAbort(state).catch(() => undefined);
        if (!this.#fencedTransferId || this.#fencedTransferId === transferId) {
          this.#clearFence();
          await this.options.lifecycle.resumeAfterAbort();
        }
      }
    }
  }

  async prepare(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }): Promise<PlannedAnchorTransferState> {
    const existing = await this.#journal.state(input.transferId);
    if (existing) {
      if (
        existing.identity.requestId !== input.requestId ||
        existing.identity.sourceDeviceId !== this.options.deviceId ||
        existing.identity.targetDeviceId !== input.targetDeviceId
      ) {
        throw new Error("Migration prepare replay conflicts with its durable identity");
      }
      return existing;
    }
    const trust = await currentTrust(this.options.bootstrapStore);
    if (
      trust.issuer.deviceId !== this.options.deviceId ||
      trust.issuer.issuerKeyId !== this.options.identityKey.deviceId
    ) {
      throw new Error("Only the current duty device can start migration");
    }
    await this.#journal.assertNoCompetingTransfer(input.transferId);
    const target = this.options.targetFor(input.targetDeviceId);
    const readyProof = validateAnchorTransferReadyProof({
      proof: await target.ready({
        transferId: input.transferId,
        sourceDeviceId: this.options.deviceId,
      }),
      trust,
      targetDeviceId: input.targetDeviceId,
    });
    const trustTransition = createMigrationTransition(
      trust,
      readyProof,
      this.options.identityKey,
    );
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "prepare",
      requestId: input.requestId,
      transferId: input.transferId,
      sourceDeviceId: this.options.deviceId,
      targetDeviceId: input.targetDeviceId,
      sourceAnchorEpoch: this.options.anchorEpoch(),
      nextAnchorEpoch: this.options.anchorEpoch() + 1,
      readyProof,
      trustTransition,
    }, this.options.signer);
    if (command.op !== "prepare") {
      throw new TypeError("Migration prepare command was not preserved by validation");
    }
    const state = await this.#journal.append(preparedRecord(command));
    const result = await target.apply(command);
    if (result.status !== "ok" || result.state !== "prepared") {
      throw new Error("Migration target did not durably prepare");
    }
    return state;
  }

  async fence(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<DurableLogCheckpoint> {
    const state = await this.#journal.state(input.transferId);
    if (!state) throw new Error("Migration is not prepared");
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration fence replay changes request identity");
    }
    if (state.phase === "aborted") throw new Error("Aborted migration cannot be fenced");
    if (state.phase === "committed" || state.phase === "tombstoned") {
      this.#installFence(input.transferId, "committed");
      return this.options.log.checkpoint();
    }
    if (state.phase !== "prepared") {
      this.#installFence(input.transferId, "frozen");
      return this.options.log.checkpoint();
    }

    const recoveryCheckpointDigest = await this.options.ensureRecoveryCheckpoint(
      input.transferId,
    );
    let admissionClosed = false;
    try {
      await this.options.lifecycle.stopAccepting();
      admissionClosed = true;
      this.#installFence(input.transferId, "draining");
      await this.#journal.append({
        v: 1,
        mode: "planned",
        t: "anchor-fenced",
        transferId: input.transferId,
        sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
        recoveryCheckpointDigest,
        at: this.options.now?.() ?? new Date().toISOString(),
      });
      await this.options.lifecycle.drainAccepted();
      this.#fenceMode = "frozen";
      return this.options.log.checkpoint();
    } catch (error) {
      const durable = await this.#journal.state(input.transferId).catch(() => undefined);
      if (durable?.phase === "prepared") {
        this.#clearFence();
        if (admissionClosed) await this.options.lifecycle.resumeAfterAbort();
      }
      throw error;
    }
  }

  async freeze(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<PlannedAnchorTransferState> {
    const frozen = await this.#journal.state(input.transferId);
    if (!frozen) throw new Error("Migration is not prepared");
    if (frozen.identity.requestId !== input.requestId) {
      throw new Error("Migration freeze replay changes request identity");
    }
    if (frozen.phase === "frozen" || frozen.phase === "imported") return frozen;
    if (frozen.phase !== "prepared" && frozen.phase !== "fenced") {
      throw new Error(`Migration cannot freeze from ${frozen.phase}`);
    }
    const checkpoint = await this.fence(input);
    const state = await this.#journal.state(input.transferId);
    if (!state || state.phase !== "fenced") throw new Error("Migration fence is unavailable");
    const snapshot = await this.options.log.readSnapshot<unknown>();
    if (snapshot.cursor.lsn !== checkpoint.lsn) {
      throw new Error("Frozen authority snapshot changed after its durable checkpoint");
    }
    const exportBytes = Buffer.from(canonicalExport({
      v: 1,
      checkpoint,
      commits: snapshot.commits,
    }), "utf8");
    const checkpointRef = await this.options.artifacts.put(exportBytes);
    const trust = await currentTrust(this.options.bootstrapStore);
    const retainedArtifacts = collectArtifactRefs(snapshot.commits)
      .sort(compareRefs);
    for (const ref of retainedArtifacts) {
      if (!(await this.options.artifacts.has(ref))) {
        throw new Error(`Frozen authority references a missing artifact: ${ref.digest}`);
      }
    }
    const catalog = buildAuthorityCatalog({
      state,
      checkpoint,
      commits: snapshot.commits,
      authorityRecords: checkpointRef,
      retainedArtifacts,
      trust,
    });
    const preparedCatalog = prepareAuthorityCatalog(catalog);
    await this.options.artifacts.put(preparedCatalog.bytes);
    const proof = createSignedSourceFreezeProof({
      v: 1,
      transferId: input.transferId,
      scope: "anchor",
      subject: state.identity.sourceDeviceId,
      sourceEpoch: state.identity.sourceAnchorEpoch,
      checkpointDigest: checkpointRef.digest,
      lastLsn: checkpoint.lsn,
    }, this.options.signer);
    const next = await this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-frozen",
      transferId: input.transferId,
      checkpoint: checkpointRef,
      catalog,
      catalogRef: preparedCatalog.ref,
      proof,
    });
    const target = this.options.targetFor(state.identity.targetDeviceId);
    const freezeCommand = createSignedAnchorTransferCommand({
      v: 1,
      op: "freeze",
      requestId: input.requestId,
      transferId: input.transferId,
      recoveryCheckpointDigest: state.recoveryCheckpointDigest!,
      checkpoint: checkpointRef,
      catalog: preparedCatalog.ref,
      proof,
    }, this.options.signer);
    if (freezeCommand.op !== "freeze") throw new TypeError("Migration freeze command changed operation");
    const freezeResult = await target.apply(freezeCommand);
    if (freezeResult.status !== "ok" || freezeResult.state !== "frozen") {
      throw new Error("Migration target did not durably freeze its private import");
    }
    const importCommand = createSignedAnchorTransferCommand({
      v: 1,
      op: "import",
      requestId: input.requestId,
      transferId: input.transferId,
      checkpoint: checkpointRef,
      catalog: preparedCatalog.ref,
    }, this.options.signer);
    if (importCommand.op !== "import") throw new TypeError("Migration import command changed operation");
    const importResult = await target.apply(importCommand);
    if (importResult.status !== "ok" || importResult.state !== "imported") {
      throw new Error("Migration target did not durably import the authority base");
    }
    return this.#journal.append({
      v: 1,
      mode: "planned",
      t: "anchor-imported",
      transferId: input.transferId,
      checkpointDigest: next.checkpoint!.digest,
      authorityCatalogDigest: next.catalogRef!.digest,
    });
  }

  async commit(input: {
    readonly requestId: string;
    readonly transferId: string;
  }): Promise<PlannedAnchorTransferState> {
    let state = await this.#journal.state(input.transferId);
    if (!state) throw new Error("Migration is not prepared");
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration commit replay changes request identity");
    }
    if (state.phase === "aborted") throw new Error("Aborted migration cannot commit");
    if (state.phase !== "committed" && state.phase !== "tombstoned") {
      if (state.phase !== "imported" || !state.proof || !state.checkpoint || !state.catalogRef) {
        throw new Error("Migration cannot commit before both sides finish the private import");
      }
      const trust = await currentTrust(this.options.bootstrapStore);
      validateAnchorTransferReadyProof({
        proof: state.readyProof,
        trust,
        targetDeviceId: state.identity.targetDeviceId,
      });
      if (
        state.catalog?.trust.homeId !== trust.homeId ||
        state.catalog.trust.trustEpoch !== trust.trustEpoch ||
        canonicalize(state.catalog.trust.chainHead) !== canonicalize(trust.chainHead) ||
        canonicalize(state.catalog.trust.issuerKeyId) !== canonicalize(trust.issuer.issuerKeyId)
      ) {
        throw new Error("Migration trust prefix changed after the authority export was frozen");
      }
      applyTrustEvent(trust, state.trustTransition);
      const commit = createSignedPlannedAnchorTransferCommit({
        v: 1,
        mode: "planned",
        transferId: state.identity.transferId,
        sourceDeviceId: state.identity.sourceDeviceId,
        targetDeviceId: state.identity.targetDeviceId,
        freezeProofDigest: sourceFreezeProofDigest(state.proof),
        checkpointDigest: state.checkpoint.digest,
        authorityCatalogDigest: state.catalogRef.digest,
        trustTransitionDigest: trustEventDigest(state.trustTransition),
        nextAnchorEpoch: state.identity.nextAnchorEpoch,
        nextTrustEpoch: state.readyProof.trustEpoch + 1,
        targetIssuerPublicKey: state.readyProof.targetIssuerPublicKey,
        readyProofDigest: readyProofDigest(state.readyProof),
        at: this.options.now?.() ?? new Date().toISOString(),
      }, this.options.signer);
      state = await this.#journal.append(
        {
          v: 1,
          mode: "planned",
          t: "anchor-committed",
          transferId: input.transferId,
          commit,
        },
        [
          { stream: "trust", body: { t: "home-trust-event", event: state.trustTransition } },
          {
            stream: "transfer:anchor-current",
            body: {
              v: 1,
              t: "planned-anchor-source-committed",
              transferId: input.transferId,
              targetDeviceId: state.identity.targetDeviceId,
              nextAnchorEpoch: state.identity.nextAnchorEpoch,
              nextTrustEpoch: commit.nextTrustEpoch,
              commit,
            },
          },
        ],
      );
      this.#installFence(input.transferId, "committed");
    }
    await this.#sendCommitted(state);
    return state;
  }

  async abort(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly reason: "source-resumed" | "target-rejected" | "operator-cancelled";
  }): Promise<PlannedAnchorTransferState> {
    let state = await this.#journal.state(input.transferId);
    if (!state) throw new Error("Migration is not prepared");
    if (state.identity.requestId !== input.requestId) {
      throw new Error("Migration cancellation replay changes request identity");
    }
    if (state.phase === "committed" || state.phase === "tombstoned") {
      throw new Error("Committed migration can only move forward");
    }
    if (state.phase !== "aborted") {
      const abort = createSignedAnchorTransferAbort({
        v: 1,
        transferId: input.transferId,
        requestId: input.requestId,
        sourceDeviceId: state.identity.sourceDeviceId,
        targetDeviceId: state.identity.targetDeviceId,
        sourceAnchorEpoch: state.identity.sourceAnchorEpoch,
        reason: input.reason,
        at: this.options.now?.() ?? new Date().toISOString(),
      }, this.options.signer);
      state = await this.#journal.append({
        v: 1,
        mode: "planned",
        t: "anchor-aborted",
        transferId: input.transferId,
        abort,
      });
    }
    await this.#sendAbort(state);
    this.#clearFence();
    await this.options.lifecycle.resumeAfterAbort();
    return state;
  }

  async #sendCommitted(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.commit) throw new Error("Migration has no signed commit to install");
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "commit",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      commit: state.commit,
    }, this.options.signer);
    if (command.op !== "commit") throw new TypeError("Migration commit command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      (result.state !== "committed" && result.state !== "tombstoned") ||
      canonicalize(result.commit) !== canonicalize(state.commit)
    ) {
      throw new Error("Migration target did not install the signed commit");
    }
  }

  async #sendAbort(state: PlannedAnchorTransferState): Promise<void> {
    if (!state.abort) throw new Error("Migration has no signed cancellation to replay");
    const command = createSignedAnchorTransferCommand({
      v: 1,
      op: "abort",
      requestId: state.identity.requestId,
      transferId: state.identity.transferId,
      abort: state.abort,
    }, this.options.signer);
    if (command.op !== "abort") throw new TypeError("Migration abort command changed operation");
    const result = await this.options.targetFor(state.identity.targetDeviceId).apply(command);
    if (
      result.status !== "ok" ||
      result.state !== "aborted" ||
      canonicalize(result.abort) !== canonicalize(state.abort)
    ) {
      throw new Error("Migration target did not durably cancel the transfer");
    }
  }

  async applyArtifactCommand(commandInput: AnchorTransferCommand): Promise<AnchorTransferResult> {
    const command = validateAnchorTransferCommand(commandInput, this.options.verifier);
    if (command.op !== "probe" && command.op !== "read-range") {
      throw new TypeError("Migration source accepts only artifact read commands");
    }
    const state = await this.#journal.state(command.transferId);
    if (!state || (state.phase !== "frozen" && state.phase !== "imported")) {
      throw new Error("Migration source artifacts are not frozen");
    }
    if (command.signature.keyId !== state.identity.targetDeviceId) {
      throw new TypeError("Migration artifact command is not signed by its prepared target");
    }
    const allowed = [state.checkpoint!, state.catalogRef!, ...(state.catalog?.retainedArtifacts ?? [])]
      .some((ref) => ref.digest === command.ref.digest && ref.bytes === command.ref.bytes);
    if (!allowed) throw new TypeError("Migration artifact is outside the frozen catalog");
    if (command.op === "probe") return resultFor(command, state);
    const bytes = await this.options.artifacts.readRange(
      command.ref,
      command.offset,
      command.length,
    );
    return {
      v: 1,
      status: "range",
      requestId: command.requestId,
      transferId: command.transferId,
      ref: command.ref,
      offset: command.offset,
      data: Buffer.from(bytes).toString("base64"),
    };
  }

  #installFence(
    transferId: string,
    mode: "draining" | "frozen" | "committed",
  ): void {
    if (this.#fencedTransferId && this.#fencedTransferId !== transferId) {
      throw new Error("Another duty-device migration owns the authority fence");
    }
    this.#fencedTransferId = transferId;
    this.#fenceMode = mode;
    if (this.#disposeFence) return;
    this.#disposeFence = this.options.log.registerAppendAdmissionGuard((entries) => {
      if (this.#fenceMode === "draining") return;
      const transferEntries = entries.filter((entry) =>
        entry.stream === ANCHOR_TRANSFER_STREAM &&
        typeof entry.body === "object" &&
        entry.body !== null &&
        "transferId" in entry.body &&
        entry.body.transferId === this.#fencedTransferId,
      );
      const commitsTransfer = transferEntries.some((entry) =>
        "t" in (entry.body as object) &&
        (entry.body as { t?: string }).t === "anchor-committed",
      );
      const permitted = entries.every((entry) =>
        entry.stream === ANCHOR_TRANSFER_STREAM ||
        (commitsTransfer && (entry.stream === "trust" || entry.stream === "transfer:anchor-current")),
      );
      if (!permitted) {
        throw new Error("Duty-device migration has frozen authority writes");
      }
    });
  }

  #clearFence(): void {
    this.#disposeFence?.();
    this.#disposeFence = undefined;
    this.#fenceMode = "open";
    this.#fencedTransferId = undefined;
  }
}

type PlannedCommit = Extract<AnchorTransferCommit, { mode: "planned" }>;

interface PlannedAnchorInstallation {
  readonly v: 1;
  readonly t: "planned-anchor-installed";
  readonly transferId: string;
  readonly commit: PlannedCommit;
  readonly transition: MigrationTransition;
  readonly trustRecord: HomeTrustRecord;
  readonly checkpoint: ArtifactRef;
  readonly catalog: ArtifactRef;
}

async function installPlannedAuthorityBase(input: {
  readonly log: FileAuthorityCommitLog;
  readonly transferId: string;
  readonly commits: readonly CommitEnvelope<unknown>[];
}): Promise<void> {
  type Progress = ReadonlyMap<number, string>;
  for (const source of input.commits) {
    const entries = source.entries.filter((entry) =>
      entry.stream !== "trust" &&
      entry.stream !== ANCHOR_TRANSFER_STREAM &&
      entry.stream !== "transfer:anchor-current" &&
      entry.stream !== "transfer:anchor-import");
    const progress = {
      v: 1 as const,
      t: "planned-anchor-base-envelope" as const,
      transferId: input.transferId,
      sourceLsn: source.lsn,
      envelopeDigest: source.envelopeDigest,
    };
    await input.log.transactProjection<Progress, unknown, void>(
      new Map(),
      (projection, entry) => {
        if (
          entry.stream !== "transfer:anchor-import" ||
          !isBaseImportProgress(entry.body) ||
          entry.body.transferId !== input.transferId
        ) return projection;
        const next = new Map(projection);
        const existing = next.get(entry.body.sourceLsn);
        if (existing && existing !== entry.body.envelopeDigest) {
          throw new Error("Imported authority base changed a source envelope identity");
        }
        next.set(entry.body.sourceLsn, entry.body.envelopeDigest);
        return next;
      },
      (projection) => {
        const existing = projection.get(source.lsn);
        if (existing) {
          if (existing !== source.envelopeDigest) {
            throw new Error("Authority base replay conflicts with a previously imported source envelope");
          }
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [...entries, { stream: "transfer:anchor-import", body: progress }],
          value: undefined,
        };
      },
      {
        stream: "transfer:anchor-import",
        candidateReferences: collectArtifactRefs(entries),
      },
    );
  }
}

function isBaseImportProgress(value: unknown): value is {
  readonly v: 1;
  readonly t: "planned-anchor-base-envelope";
  readonly transferId: string;
  readonly sourceLsn: number;
  readonly envelopeDigest: string;
} {
  return typeof value === "object" && value !== null &&
    (value as { v?: unknown }).v === 1 &&
    (value as { t?: unknown }).t === "planned-anchor-base-envelope" &&
    typeof (value as { transferId?: unknown }).transferId === "string" &&
    Number.isSafeInteger((value as { sourceLsn?: unknown }).sourceLsn) &&
    typeof (value as { envelopeDigest?: unknown }).envelopeDigest === "string";
}

async function installPlannedAnchorAuthority(input: {
  readonly log: FileAuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly current: TrustProjection;
  readonly transition: MigrationTransition;
  readonly record: HomeTrustRecord;
  readonly commit: PlannedCommit;
  readonly checkpoint: ArtifactRef;
  readonly catalog: ArtifactRef;
  readonly candidateReferences: readonly ArtifactRef[];
}): Promise<void> {
  const installation: PlannedAnchorInstallation = {
    v: 1,
    t: "planned-anchor-installed",
    transferId: input.commit.transferId,
    commit: input.commit,
    transition: input.transition,
    trustRecord: input.record,
    checkpoint: input.checkpoint,
    catalog: input.catalog,
  };
  type Projection = {
    readonly trustEvents: readonly HomeTrustEvent[];
    readonly installations: ReadonlyMap<string, PlannedAnchorInstallation>;
  };
  await input.log.transactProjection<Projection, unknown, void>(
    { trustEvents: [], installations: new Map() },
    (projection, entry) => {
      if (entry.stream === "trust" && isTrustEventRecord(entry.body)) {
        const trustEvents = [...projection.trustEvents, entry.body.event];
        replayTrustChain(trustEvents);
        return { ...projection, trustEvents };
      }
      if (entry.stream === "transfer:anchor-current" && isPlannedInstallation(entry.body)) {
        const installations = new Map(projection.installations);
        const existing = installations.get(entry.body.transferId);
        if (existing && canonicalize(existing) !== canonicalize(entry.body)) {
          throw new Error("Installed duty-device migration changed its durable decision");
        }
        installations.set(entry.body.transferId, entry.body);
        return { ...projection, installations };
      }
      return projection;
    },
    (projection) => {
      const existing = projection.installations.get(input.commit.transferId);
      if (existing) {
        if (canonicalize(existing) !== canonicalize(installation)) {
          throw new Error("Duty-device migration install replay conflicts with the committed authority base");
        }
        return { kind: "return", value: undefined };
      }
      if (projection.trustEvents.length === 0) {
        throw new Error("Migration target trust chain is missing");
      }
      const current = replayTrustChain(projection.trustEvents);
      if (canonicalize(current) !== canonicalize(input.current)) {
        throw new Error("Migration target trust chain changed before atomic installation");
      }
      const next = applyTrustEvent(current, input.transition);
      if (
        next.trustEpoch !== input.commit.nextTrustEpoch ||
        next.issuer.deviceId !== input.commit.targetDeviceId ||
        next.issuer.issuerPublicKey !== input.commit.targetIssuerPublicKey
      ) {
        throw new TypeError("Migration target transition does not produce the committed authority");
      }
      return {
        kind: "append",
        entries: [
          { stream: "trust", body: { t: "home-trust-event", event: input.transition } },
          { stream: "trust", body: { t: "home-trust-record", record: input.record } },
          { stream: "transfer:anchor-current", body: installation },
        ],
        value: undefined,
      };
    },
    {
      streams: ["trust", "transfer:anchor-current"],
      candidateReferences: input.candidateReferences,
    },
  );
}

function isTrustEventRecord(
  value: unknown,
): value is { readonly t: "home-trust-event"; readonly event: HomeTrustEvent } {
  return typeof value === "object" && value !== null &&
    (value as { t?: unknown }).t === "home-trust-event" &&
    typeof (value as { event?: unknown }).event === "object";
}

function isPlannedInstallation(value: unknown): value is PlannedAnchorInstallation {
  return typeof value === "object" && value !== null &&
    (value as { v?: unknown }).v === 1 &&
    (value as { t?: unknown }).t === "planned-anchor-installed" &&
    typeof (value as { transferId?: unknown }).transferId === "string";
}

function trustEventDigest(event: HomeTrustEvent): string {
  const { signature: _, ...unsigned } = event;
  return protocolDigest("HomeTrustEvent", 1, unsigned);
}

function requireMigrationTransition(event: HomeTrustEvent): MigrationTransition {
  if (
    event.body.t !== "issuer-transition" ||
    event.body.reason !== "migration" ||
    event.body.signedBy !== "issuer"
  ) {
    throw new TypeError("Planned migration requires its prepared issuer transition");
  }
  return event as MigrationTransition;
}

function uniqueRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  const unique = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    const existing = unique.get(ref.digest);
    if (existing && existing.bytes !== ref.bytes) {
      throw new TypeError("Artifact digest is associated with conflicting byte counts");
    }
    unique.set(ref.digest, ref);
  }
  return [...unique.values()].sort(compareRefs);
}

interface PlannedAuthorityExport {
  readonly v: 1;
  readonly checkpoint: DurableLogCheckpoint;
  readonly commits: readonly CommitEnvelope<unknown>[];
}

function canonicalExport(value: PlannedAuthorityExport): string {
  return canonicalize(value);
}

function parseAuthorityExport(bytes: Uint8Array): PlannedAuthorityExport {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as PlannedAuthorityExport;
  if (canonicalExport(value) !== text || value.v !== 1 || !Array.isArray(value.commits)) {
    throw new TypeError("Planned authority export is not canonical");
  }
  return value;
}

function parseAuthorityCatalog(bytes: Uint8Array): AuthorityCatalog {
  const text = Buffer.from(bytes).toString("utf8");
  const value = JSON.parse(text) as unknown;
  const prepared = prepareAuthorityCatalog(value);
  if (Buffer.from(prepared.bytes).toString("utf8") !== text) {
    throw new TypeError("Authority catalog is not canonical");
  }
  return prepared.catalog;
}

function buildAuthorityCatalog(input: {
  readonly state: PlannedAnchorTransferState;
  readonly checkpoint: DurableLogCheckpoint;
  readonly commits: readonly CommitEnvelope<unknown>[];
  readonly authorityRecords: ArtifactRef;
  readonly retainedArtifacts: readonly ArtifactRef[];
  readonly trust: TrustProjection;
}): AuthorityCatalog {
  const streams = new Map<string, Array<{ readonly lsn: number; readonly body: unknown }>>();
  for (const commit of input.commits) {
    for (const entry of commit.entries) {
      const records = streams.get(entry.stream) ?? [];
      records.push({ lsn: commit.lsn, body: entry.body });
      streams.set(entry.stream, records);
    }
  }
  return prepareAuthorityCatalog({
    v: 1,
    transferId: input.state.identity.transferId,
    sourceDeviceId: input.state.identity.sourceDeviceId,
    targetDeviceId: input.state.identity.targetDeviceId,
    sourceAnchorEpoch: input.state.identity.sourceAnchorEpoch,
    source: input.checkpoint,
    trust: {
      homeId: input.trust.homeId,
      trustEpoch: input.trust.trustEpoch,
      chainHead: input.trust.chainHead,
      issuerDeviceId: input.trust.issuer.deviceId,
      issuerKeyId: input.trust.issuer.issuerKeyId,
    },
    coverage: [
      "conversation-authority", "conversation-content", "execution-assets",
      "global-authority", "pending-obligations", "trust-and-anchor",
    ],
    streams: [...streams].sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([stream, records]) => ({
        stream,
        firstLsn: records[0]!.lsn,
        lastLsn: records.at(-1)!.lsn,
        recordCount: records.length,
        digest: protocolDigest("AuthorityCatalogStream", 1, { stream, records }),
      })),
    authorityRecords: input.authorityRecords,
    retainedArtifacts: input.retainedArtifacts,
    pendingObligations: [],
  }).catalog;
}

function assertExportBinding(
  catalog: AuthorityCatalog,
  exported: PlannedAuthorityExport,
  proof: import("@zhixing/core/contracts").SourceFreezeProof,
  state: PlannedAnchorTransferState,
): void {
  if (
    catalog.transferId !== state.identity.transferId ||
    catalog.sourceDeviceId !== state.identity.sourceDeviceId ||
    catalog.targetDeviceId !== state.identity.targetDeviceId ||
    catalog.source.lsn !== proof.lastLsn ||
    exported.checkpoint.lsn !== proof.lastLsn ||
    exported.checkpoint.prefixDigest !== catalog.source.prefixDigest ||
    exported.commits.at(-1)?.lsn !== proof.lastLsn
  ) {
    throw new TypeError("Planned authority export does not bind its frozen source prefix");
  }
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
  return left.digest.localeCompare(right.digest, "en-US") || left.bytes - right.bytes;
}

function preparedRecord(
  command: Extract<AnchorTransferCommand, { op: "prepare" }>,
): Extract<PlannedRecord, { t: "anchor-prepared" }> {
  return {
    v: 1,
    mode: "planned",
    t: "anchor-prepared",
    requestId: command.requestId,
    transferId: command.transferId,
    sourceDeviceId: command.sourceDeviceId,
    targetDeviceId: command.targetDeviceId,
    sourceAnchorEpoch: command.sourceAnchorEpoch,
    nextAnchorEpoch: command.nextAnchorEpoch,
    readyProof: command.readyProof,
    trustTransition: command.trustTransition,
  };
}

function createMigrationTransition(
  trust: TrustProjection,
  proof: ReadyProof,
  signer: DeviceKey,
): MigrationTransition {
  return createSignedTrustEvent({
    current: trust,
    signer,
    at: proof.issuedAt,
    body: {
      t: "issuer-transition",
      reason: "migration",
      signedBy: "issuer",
      nextTrustEpoch: trust.trustEpoch + 1,
      fromIssuerKeyId: trust.issuer.issuerKeyId,
      toIssuerKeyId: proof.targetIssuerKeyId,
      toIssuerPublicKey: proof.targetIssuerPublicKey,
      toDeviceId: proof.targetDeviceId,
    },
  });
}

function reduceJournal(
  states: ReadonlyMap<string, PlannedAnchorTransferState>,
  entry: LogicalRecord<PlannedRecord>,
  verifier: ProtocolSignatureVerifier,
): ReadonlyMap<string, PlannedAnchorTransferState> {
  if (entry.stream !== ANCHOR_TRANSFER_STREAM) return states;
  const next = new Map(states);
  next.set(
    entry.body.transferId,
    reducePlannedAnchorTransfer(states.get(entry.body.transferId), entry.body, verifier),
  );
  return next;
}

function resultFor(
  command: AnchorTransferCommand,
  state: PlannedAnchorTransferState | undefined,
): AnchorTransferResult {
  if (!state) {
    return {
      v: 1,
      status: "rejected",
      requestId: command.requestId,
      transferId: command.transferId,
      error: { code: "not-found", retryable: false },
    };
  }
  if (state.phase === "prepared" || state.phase === "fenced") {
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "prepared" };
  }
  if (state.phase === "frozen" || state.phase === "imported") {
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: state.phase, ref: state.checkpoint! };
  }
  if (state.phase === "committed" || state.phase === "tombstoned") {
    return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: state.phase, commit: state.commit! };
  }
  return { v: 1, status: "ok", requestId: command.requestId, transferId: command.transferId, state: "aborted", abort: state.abort! };
}

async function currentTrust(store: FileMeshBootstrapStore): Promise<TrustProjection> {
  const trust = await store.loadTrustProjection();
  if (!trust) throw new Error("Home trust is not initialized");
  return trust;
}
