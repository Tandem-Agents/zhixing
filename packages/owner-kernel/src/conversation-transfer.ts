import type {
  ArtifactRef,
  CommitEnvelope,
  ConversationTransferAbort,
  ConversationTransferCommit,
  ConversationTransferManifest,
  Digest,
  JsonValue,
  SourceFreezeProof,
  TransferRecord,
} from "@zhixing/core/contracts";
import type {
  ArtifactReceiveProgress,
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  IdentifiedPhysicalStepRunner,
  DurableProjectionSource, VerifiedAnchorTenure,
  DurableLogCheckpoint,
} from "@zhixing/core/authority";
import {
  validateAdmittedControlEnvelope,
  resolveDispatchArtifactClosure,
  resolveSealedBundleArtifactClosure,
} from "@zhixing/core/authority";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import {
  canonicalize,
  conversationTransferCommitDigest,
  createSignedConversationTransferAbort,
  createSignedConversationTransferCommit,
  createSignedSourceFreezeProof,
  prepareConversationTransferManifest,
  protocolDigest,
  reduceConversationTransfer,
  sourceFreezeProofDigest,
  validateConversationTransferCommit,
  validateSourceFreezeProof,
  validateConversationTransferManifest,
  validateConversationEnvelope,
  type ConversationTransferState,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { ConversationBaseSource, type ConversationBaseManifest } from "./conversation-base-source.js";
import { registerConversationBaseContext } from "./conversation-base-registry.js";
import { isLocalConversationId } from '@zhixing/core/conversation';
export { isConversationSourceEvidenceError } from './conversation-base-source.js';
export { foldConversationBaseBindings, conversationBaseKey, openConversationBase, registerConversationBaseContext } from './conversation-base-registry.js';
export type { ConversationBaseBinding } from './conversation-base-registry.js';
import { conversationAnchorAtPrefix, conversationAnchorAtSource, conversationAnchorProjectionIds, conversationOwnerBasis,
  adoptedConversationOwner, type ConversationOwnerBasis } from './conversation-owner-authority.js';
export { registerConversationAnchorTenure, conversationAnchorAtPrefix, conversationAnchorProjectionIds } from './conversation-owner-authority.js';
export type { ConversationAnchorTenurePort } from './conversation-owner-authority.js';

export const CONVERSATION_TRANSFER_PROJECTION_ID =
  "conversation-transfer-current-v1";
const TRANSFER_PROJECTION_REDUCER_VERSION = 5;

interface ConversationTransferCommittedBaseRecord {
  readonly v: 1 | 2;
  readonly ownerBasis?: ConversationOwnerBasis;
  readonly t: "conversation-transfer-committed-base";
  readonly transferId: string;
  readonly conversationId: string;
  readonly manifest: ArtifactRef;
  readonly records: ArtifactRef;
  readonly sessionState: ArtifactRef;
}

type ConversationTransferLogRecord =
  | TransferRecord
  | ConversationTransferCommittedBaseRecord;

function isConversationTransferCommittedBase(
  record: ConversationTransferLogRecord,
): record is ConversationTransferCommittedBaseRecord {
  return record.t === "conversation-transfer-committed-base";
}

function reduceConversationTransferLogRecord(
  state: ConversationTransferState | undefined,
  record: ConversationTransferLogRecord,
  verifier: ProtocolSignatureVerifier,
): ConversationTransferState | undefined {
  return isConversationTransferCommittedBase(record)
    ? state
    : reduceConversationTransfer(state, record, verifier);
}

export interface CurrentConversationAuthority {
  readonly deviceId: string;
  readonly ownerEpoch: number;
  readonly transferId?: string;
  readonly anchorEpoch?: number;
  readonly state: "current" | "frozen" | "importing" | "fenced";
}

export interface ConversationTransferSessionSnapshot {
  readonly reducerVersion: string;
  readonly value: JsonValue;
}

export interface ConversationTransferSourceOptions {
  readonly deviceId: string;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly abortSignal?: () => AbortSignal;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly acceptsConversationId: (conversationId: string) => boolean;
  readonly accepting?: () => boolean;
  readonly isCurrentAnchor: (deviceId: string) => boolean | Promise<boolean>;
  readonly conversationState: (conversationId: string) => Promise<{
    readonly exists: boolean;
    readonly deleted: boolean;
    readonly ownerEpoch: number;
  }>;
  readonly settleConversation: (conversationId: string) => Promise<void>;
  readonly resumeConversation?: (conversationId: string) => void | Promise<void>;
  readonly snapshotSessionState: (
    conversationId: string,
  ) => Promise<ConversationTransferSessionSnapshot>;
  readonly clock?: () => string;
}

export interface ConversationTransferReadPort {
  probe(input: {
    readonly transferId: string;
    readonly targetDeviceId: string;
    readonly ref: ArtifactRef;
  }): Promise<boolean>;
  readRange(input: {
    readonly transferId: string;
    readonly targetDeviceId: string;
    readonly ref: ArtifactRef;
    readonly offset: number;
    readonly length: number;
  }): Promise<Uint8Array>;
}

export interface FrozenConversationTransfer {
  readonly manifest: ConversationTransferManifest;
  readonly manifestRef: ArtifactRef;
  readonly proof: SourceFreezeProof;
}

export class ConversationTransferSource {
  readonly #options: ConversationTransferSourceOptions;
  readonly #clock: () => string;

  constructor(options: ConversationTransferSourceOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    registerConversationTransferProjection(options.log, options.verifier);
  }

  async prepare(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
    readonly conversationId: string;
    readonly sourceOwnerEpoch: number;
  }): Promise<ConversationTransferState> {
    if (this.#options.accepting && !this.#options.accepting()) {
      throw new Error("Conversation transfer source is not accepting work");
    }
    if (!this.#options.acceptsConversationId(input.conversationId)) {
      throw new TypeError("Conversation does not belong to the transfer source");
    }
    if (!(await this.#options.isCurrentAnchor(input.targetDeviceId))) {
      throw new TypeError("Conversation transfer target is not the current trusted device");
    }
    const state = await this.#options.conversationState(input.conversationId);
    if (!state.exists || state.deleted || state.ownerEpoch !== input.sourceOwnerEpoch) {
      throw new TypeError("Conversation transfer source identity is not current");
    }
    await this.#options.settleConversation(input.conversationId);
    try {
      const settled = await this.#options.conversationState(input.conversationId);
      if (
        !settled.exists ||
        settled.deleted ||
        settled.ownerEpoch !== input.sourceOwnerEpoch
      ) {
        throw new TypeError("Conversation transfer source identity changed while settling");
      }
      return await appendConversationTransferRecord(
        this.#options.log,
        this.#options.verifier,
        {
          v: 1,
          t: "prepared",
          requestId: input.requestId,
          transferId: input.transferId,
          sourceDeviceId: this.#options.deviceId,
          targetDeviceId: input.targetDeviceId,
          conversationId: input.conversationId,
          sourceOwnerEpoch: input.sourceOwnerEpoch,
          nextOwnerEpoch: input.sourceOwnerEpoch + 1,
        },
      );
    } catch (error) {
      await this.#options.resumeConversation?.(input.conversationId);
      throw error;
    }
  }

  async freeze(transferId: string): Promise<FrozenConversationTransfer> {
    const current = await readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (!current) throw new TypeError("Conversation transfer is not prepared");
    if (current.phase === "frozen" || current.phase === "imported") {
      return this.#readFrozen(current);
    }
    if (current.phase !== "prepared") {
      throw new TypeError(`Conversation transfer cannot freeze from ${current.phase}`);
    }

    const identity = current.identity;
    const source = await this.#options.conversationState(identity.conversationId);
    if (
      !source.exists ||
      source.deleted ||
      source.ownerEpoch !== identity.sourceOwnerEpoch
    ) {
      throw new TypeError("Conversation changed before its transfer freeze");
    }
    const checkpoint = await this.#options.log.checkpoint();
    // 按会话领域索引找到冻点前相关的信封并精确读出，原两遍选择器在这个子集上的结果与整读相同
    const selected = await selectConversationAuthorityRecords(
      await readConversationTransferEnvelopes(this.#options.log, this.#options.artifacts, identity.conversationId, checkpoint),
      identity.conversationId,
      this.#options.artifacts,
      this.#options.verifier,
    );
    const authorityBytes = Buffer.from(canonicalize(selected.records), "utf8");
    const recordsRef = await putTransferArtifact(
      this.#options,
      identity.transferId,
      "source-records",
      authorityBytes,
    );
    const session = await this.#options.snapshotSessionState(identity.conversationId);
    const sessionBytes = Buffer.from(canonicalize(session.value), "utf8");
    const sessionStateRef = await putTransferArtifact(
      this.#options,
      identity.transferId,
      "source-session-state",
      sessionBytes,
    );
    const contentAssets = uniqueSortedRefs(selected.references);
    const prepared = prepareConversationTransferManifest({
      v: 1,
      requestId: identity.requestId,
      transferId: identity.transferId,
      sourceDeviceId: identity.sourceDeviceId,
      targetDeviceId: identity.targetDeviceId,
      conversationId: identity.conversationId,
      sourceOwnerEpoch: identity.sourceOwnerEpoch,
      nextOwnerEpoch: identity.nextOwnerEpoch,
      lastLsn: checkpoint.lsn,
      authorityBase: {
        checkpoint,
        records: recordsRef,
        sessionState: sessionStateRef,
        reducerVersion: session.reducerVersion,
      },
      streams: selected.streams,
      contentAssets,
    });
    const manifestRef = await putTransferArtifact(
      this.#options,
      identity.transferId,
      "source-manifest",
      prepared.bytes,
    );
    if (canonicalize(manifestRef) !== canonicalize(prepared.ref)) {
      throw new Error("ArtifactStore returned a manifest identity mismatch");
    }
    const proof = createSignedSourceFreezeProof(
      {
        v: 1,
        transferId: identity.transferId,
        scope: "conversation",
        subject: identity.conversationId,
        sourceEpoch: identity.sourceOwnerEpoch,
        checkpointDigest: manifestRef.digest,
        lastLsn: checkpoint.lsn,
      },
      this.#options.signer,
    );
    await appendConversationTransferRecord(
      this.#options.log,
      this.#options.verifier,
      {
        v: 1,
        t: "frozen",
        transferId,
        manifest: manifestRef,
        proof,
      },
    );
    return { manifest: prepared.manifest, manifestRef, proof };
  }

  async abort(
    transferId: string,
    reason: ConversationTransferAbort["reason"],
  ): Promise<ConversationTransferAbort> {
    const abort = await this.prepareAbort(transferId, reason);
    await this.acceptAbort(abort);
    return abort;
  }

  /** Creates the source-signed fact without changing source authority. */
  async prepareAbort(
    transferId: string,
    reason: ConversationTransferAbort["reason"],
  ): Promise<ConversationTransferAbort> {
    const current = await readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (!current) throw new TypeError("Conversation transfer is unknown");
    if (current.phase === "aborted") return current.abort!;
    if (current.phase === "committed" || current.phase === "tombstoned") {
      throw new TypeError("Committed conversation transfer cannot be aborted");
    }
    return createSignedConversationTransferAbort(
      {
        v: 1,
        requestId: current.identity.requestId,
        transferId,
        sourceDeviceId: current.identity.sourceDeviceId,
        targetDeviceId: current.identity.targetDeviceId,
        conversationId: current.identity.conversationId,
        sourceOwnerEpoch: current.identity.sourceOwnerEpoch,
        reason,
        at: this.#clock(),
      },
      this.#options.signer,
    );
  }

  /** Records only the exact abort already durably acknowledged by the target. */
  async acceptAbort(abort: ConversationTransferAbort): Promise<void> {
    const current = await readConversationTransferState(
      this.#options.log,
      abort.transferId,
      this.#options.verifier,
    );
    if (!current) throw new TypeError("Conversation transfer is unknown");
    if (current.phase === "aborted") {
      if (canonicalize(current.abort) !== canonicalize(abort)) {
        throw new TypeError("Conversation transfer abort conflicts with durable state");
      }
      return;
    }
    await appendConversationTransferRecord(
      this.#options.log,
      this.#options.verifier,
      { v: 1, t: "aborted", transferId: abort.transferId, abort },
    );
    await this.#options.resumeConversation?.(current.identity.conversationId);
  }

  /** Mirror the target's imported/commit facts into the source fencing stream. */
  async acceptCommit(input: {
    readonly manifest: ConversationTransferManifest;
    readonly commit: ConversationTransferCommit;
  }): Promise<ConversationTransferState> {
    const commit = validateConversationTransferCommit(
      input.commit,
      this.#options.verifier,
    );
    let state = await readConversationTransferState(
      this.#options.log,
      commit.transferId,
      this.#options.verifier,
    );
    if (!state || !state.manifest || !state.proof) {
      throw new TypeError("Conversation transfer source is not frozen");
    }
    assertManifestIdentity(input.manifest, state);
    if (state.phase === "frozen") {
      state = await appendConversationTransferRecord(
        this.#options.log,
        this.#options.verifier,
        {
          v: 1,
          t: "imported",
          transferId: commit.transferId,
          manifestDigest: state.manifest.digest,
          importedRecordBase: input.manifest.authorityBase.records,
        },
      );
    }
    if (state.phase === "imported") {
      state = await appendConversationTransferRecord(
        this.#options.log,
        this.#options.verifier,
        { v: 1, t: "committed", transferId: commit.transferId, commit },
      );
    }
    if (state.phase === "committed") {
      state = await appendConversationTransferRecord(
        this.#options.log,
        this.#options.verifier,
        {
          v: 1,
          t: "tombstoned",
          transferId: commit.transferId,
          commitDigest: conversationTransferCommitDigest(commit),
          at: this.#clock(),
        },
      );
    }
    if (state.phase !== "tombstoned") {
      throw new TypeError(`Conversation transfer source cannot accept commit from ${state.phase}`);
    }
    return state;
  }

  readonly readPort: ConversationTransferReadPort = Object.freeze({
    probe: async (input: Parameters<ConversationTransferReadPort["probe"]>[0]) => {
      await this.#assertReadable(input.transferId, input.targetDeviceId, input.ref);
      return this.#options.artifacts.has(input.ref);
    },
    readRange: async (
      input: Parameters<ConversationTransferReadPort["readRange"]>[0],
    ) => {
      await this.#assertReadable(input.transferId, input.targetDeviceId, input.ref);
      assertRange(input.ref, input.offset, input.length);
      const signal = this.#options.abortSignal?.() ?? new AbortController().signal;
      return runWithMaintenanceUrgency(() => "foreground", signal, () =>
        runStorageMaintenanceStep(
          this.#options.storageMaintenance,
          storageMaintenanceRequest("conversation-transfer", input.transferId, {
            step: "source-range-read",
            digest: input.ref.digest,
            offset: input.offset,
            length: input.length,
          }, { obligation: "pre-commit" }),
          () => this.#options.artifacts.readRange(
            input.ref,
            input.offset,
            input.length,
          ),
        )
      );
    },
  });

  async #assertReadable(
    transferId: string,
    targetDeviceId: string,
    ref: ArtifactRef,
  ): Promise<void> {
    const state = await readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (!state || (state.phase !== "frozen" && state.phase !== "imported")) {
      throw new TypeError("Conversation transfer is not readable");
    }
    if (targetDeviceId !== state.identity.targetDeviceId) {
      throw new TypeError("Conversation transfer reader is not the prepared target");
    }
    const frozen = await this.#readFrozen(state);
    const allowed = [
      frozen.manifestRef,
      frozen.manifest.authorityBase.records,
      frozen.manifest.authorityBase.sessionState,
      ...frozen.manifest.contentAssets,
    ];
    if (!allowed.some((candidate) => sameRef(candidate, ref))) {
      throw new TypeError("Conversation transfer ref is outside the frozen manifest");
    }
  }

  async #readFrozen(
    state: ConversationTransferState,
  ): Promise<FrozenConversationTransfer> {
    if (!state.manifest || !state.proof) {
      throw new Error("Frozen conversation transfer is incomplete");
    }
    const bytes = await this.#options.artifacts.get(state.manifest);
    const manifest = validateConversationTransferManifest(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    );
    return { manifest, manifestRef: state.manifest, proof: state.proof };
  }
}

export function registerConversationTransferProjection(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
) {
  return log.durableProjection<ConversationTransferLogRecord>({
    projectionId: CONVERSATION_TRANSFER_PROJECTION_ID,
    inputs: { families: ["transfer:"] },
    reducerVersion: TRANSFER_PROJECTION_REDUCER_VERSION,
    reduce: async (envelope, current, source) =>
      reduceConversationTransferProjection(envelope, current, verifier, log, source),
  });
}

export async function resolveCurrentConversationAuthorityAt(
  projection: DurableProjectionReadContext,
  conversationId: string,
  fallback: { readonly deviceId: string; readonly ownerEpoch: number },
  anchor?: VerifiedAnchorTenure,
): Promise<CurrentConversationAuthority> {
  const state = await projectedConversationTransferState(projection, conversationId);
  if (!state || state.phase === "aborted") {
    if (anchor && !isLocalConversationId(conversationId)) return { deviceId: anchor.deviceId, ownerEpoch: anchor.anchorEpoch,
      anchorEpoch: anchor.anchorEpoch, state: fallback.deviceId === anchor.deviceId ? 'current' : 'fenced' };
    return { ...fallback, state: "current" };
  }
  if (state.phase === "prepared" || state.phase === "frozen") {
    return {
      deviceId: state.identity.sourceDeviceId,
      ownerEpoch: state.identity.sourceOwnerEpoch,
      transferId: state.identity.transferId,
      state: "frozen",
    };
  }
  if (state.phase === "imported") {
    return {
      deviceId: state.identity.sourceDeviceId,
      ownerEpoch: state.identity.sourceOwnerEpoch,
      transferId: state.identity.transferId,
      state: "importing",
    };
  }
  const basis = await projection.get(`owner-base:${conversationId}`) as unknown as ConversationOwnerBasis | undefined;
  if (!anchor || !basis) return {
    deviceId: anchor?.deviceId ?? state.identity.targetDeviceId,
    ownerEpoch: state.identity.nextOwnerEpoch, transferId: state.identity.transferId,
    // A source routing hint is not fresh write authority. Missing legacy
    // basis must never promote the historical target to current ownership.
    state: 'fenced',
  };
  const owner = adoptedConversationOwner(basis, anchor);
  return {
    ...owner,
    transferId: state.identity.transferId,
    state:
      fallback.deviceId === owner.deviceId ? "current" : "fenced",
  };
}

export async function resolveCurrentConversationAuthority(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
  conversationId: string,
  fallback: { readonly deviceId: string; readonly ownerEpoch: number },
): Promise<CurrentConversationAuthority> {
  registerConversationTransferProjection(log, verifier);
  const transaction = await log.transactDurableProjection<TransferRecord, CurrentConversationAuthority>(
    CONVERSATION_TRANSFER_PROJECTION_ID,
    async (projection, context) => ({
      kind: "return",
      value: await resolveCurrentConversationAuthorityAt(
        projection,
        conversationId,
        fallback,
        await conversationAnchorAtPrefix(log, context),
      ),
    }), { readProjectionIds: conversationAnchorProjectionIds(log) },
  );
  return transaction.value;
}

export async function assertConversationTransferWriteAuthority(
  projection: DurableProjectionReadContext,
  conversationId: string,
  actor: { readonly deviceId: string; readonly ownerEpoch: number },
  anchor?: VerifiedAnchorTenure,
): Promise<void> {
  const resolved = await resolveCurrentConversationAuthorityAt(
    projection,
    conversationId,
    actor,
    anchor,
  );
  if (
    resolved.state !== "current" ||
    resolved.deviceId !== actor.deviceId ||
    resolved.ownerEpoch !== actor.ownerEpoch
  ) {
    throw new Error("Conversation is not writable on this device");
  }
}

/** Local-domain authorization stays bound to its own durable transfer fence. */
export async function localConversationAuthorityAt(view: DurableProjectionReadContext, conversationId: string,
  deviceId: string, ownerEpoch: number): Promise<boolean> {
  const state = await projectedConversationTransferState(view, conversationId);
  return !state || state.phase === 'aborted' && state.identity.sourceDeviceId === deviceId && state.identity.sourceOwnerEpoch === ownerEpoch;
}

/** Both precommit publication and committed restoration use the same verified
 * owner source. A historical manifest is not a current-device assertion. */
export async function resolveConversationPublicationOwner(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier,
  manifest: ConversationBaseManifest, manifestRef: ArtifactRef, deviceId: string): Promise<CurrentConversationAuthority> {
  registerConversationTransferProjection(log, verifier);
  return (await log.transactDurableProjection<never, CurrentConversationAuthority>(CONVERSATION_TRANSFER_PROJECTION_ID, async (view, context) => {
    const state = await view.get(`transfer:${manifest.transferId}`) as unknown as ConversationTransferState | undefined;
    if (!state || !['frozen', 'imported', 'committed', 'tombstoned'].includes(state.phase) || !state.manifest || !sameRef(state.manifest, manifestRef)) throw new TypeError('Conversation publication has no durable transfer identity');
    for (const key of ['requestId', 'transferId', 'conversationId', 'sourceDeviceId', 'targetDeviceId', 'sourceOwnerEpoch', 'nextOwnerEpoch'] as const) {
      if (state.identity[key] !== manifest[key]) throw new TypeError('Conversation publication identity differs from its source');
    }
    const anchor = await conversationAnchorAtPrefix(log, context);
    if (!anchor) throw new TypeError('Conversation publication requires a verified anchor tenure');
    const owner = state.phase === 'committed' || state.phase === 'tombstoned'
      ? await resolveCurrentConversationAuthorityAt(view, manifest.conversationId, { deviceId, ownerEpoch: manifest.nextOwnerEpoch }, anchor)
      : { deviceId: conversationOwnerBasis(anchor, manifest.targetDeviceId, manifest.nextOwnerEpoch).deviceId,
          ownerEpoch: manifest.nextOwnerEpoch, anchorEpoch: anchor.anchorEpoch, state: 'current' as const };
    if (owner.deviceId !== deviceId || owner.state !== 'current') throw new TypeError('Conversation publication does not belong to the current owner');
    return { kind: 'return', value: owner };
  }, { readProjectionIds: conversationAnchorProjectionIds(log) })).value;
}

export async function appendConversationTransferRecord(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
  record: TransferRecord,
): Promise<ConversationTransferState> {
  registerConversationTransferProjection(log, verifier);
  const candidateReferences: ArtifactRef[] = [];
  collectArtifactRefs(record, candidateReferences);
  const transaction = await log.transactProjection<
    ConversationTransferState | undefined,
    ConversationTransferLogRecord,
    ConversationTransferState
  >(
    undefined,
    (state, logical) =>
      logical.stream.startsWith("transfer:xfer-")
        ? reduceConversationTransferLogRecord(state, logical.body, verifier)
        : state,
    (state) => {
      const next = reduceConversationTransfer(state, record, verifier);
      if (next === state) return { kind: "return", value: state! };
      return {
        kind: "append",
        entries: [{ stream: `transfer:${record.transferId}`, body: record }],
        value: next,
      };
    },
    {
      stream: `transfer:${record.transferId}`,
      candidateReferences: uniqueSortedRefs(candidateReferences),
    },
  );
  return transaction.value;
}

async function appendConversationTransferCommitAndBase(
  log: AuthorityCommitLog,
  verifier: ProtocolSignatureVerifier,
  record: Extract<TransferRecord, { t: "committed" }>,
  manifest: ConversationTransferManifest,
): Promise<ConversationTransferState> {
  registerConversationTransferProjection(log, verifier);
  const manifestRef = prepareConversationTransferManifest(manifest).ref;
  const candidateReferences = uniqueSortedRefs([
    manifestRef,
    manifest.authorityBase.records,
    manifest.authorityBase.sessionState,
    ...manifest.contentAssets,
  ]);
  const transaction = await log.transactProjection<
    ConversationTransferState | undefined,
    ConversationTransferLogRecord,
    ConversationTransferState
  >(
    undefined,
    (state, logical) =>
      logical.stream === `transfer:${record.transferId}`
        ? reduceConversationTransferLogRecord(state, logical.body, verifier)
        : state,
    async (state, context) => {
      const next = reduceConversationTransfer(state, record, verifier);
      if (next === state) return { kind: "return", value: state! };
      const tenure = await conversationAnchorAtPrefix(log, context);
      if (!tenure) throw new TypeError('Conversation adoption requires a verified anchor tenure');
      const ownerBasis = conversationOwnerBasis(tenure, manifest.targetDeviceId, manifest.nextOwnerEpoch);
      return {
        kind: "append",
        entries: [
          { stream: `transfer:${record.transferId}`, body: record },
          {
            stream: `transfer:${record.transferId}`,
            body: {
              v: 2,
              ownerBasis,
              t: "conversation-transfer-committed-base",
              transferId: record.transferId,
              conversationId: manifest.conversationId,
              manifest: manifestRef,
              records: manifest.authorityBase.records,
              sessionState: manifest.authorityBase.sessionState,
            },
          },
        ],
        value: next,
      };
    },
    {
      stream: `transfer:${record.transferId}`,
      candidateReferences,
      readProjectionIds: conversationAnchorProjectionIds(log),
    },
  );
  return transaction.value;
}

export async function readConversationTransferState(
  log: AuthorityCommitLog,
  transferId: string,
  verifier: ProtocolSignatureVerifier,
): Promise<ConversationTransferState | undefined> {
  return await registerConversationTransferProjection(log, verifier).get(`transfer:${transferId}`) as unknown as ConversationTransferState | undefined;
}

async function readConversationTransferCommittedBaseRecord(
  log: AuthorityCommitLog,
  transferId: string,
  verifier: ProtocolSignatureVerifier,
): Promise<ConversationTransferCommittedBaseRecord | undefined> {
  return await registerConversationTransferProjection(log, verifier).get(`base:${transferId}`) as unknown as ConversationTransferCommittedBaseRecord | undefined;
}

/** Owner identity remains available independently of the imported CAS bodies. */
export async function readCommittedConversationTransferHeader(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier, transferId: string) {
  registerConversationTransferProjection(log, verifier);
  return (await log.transactDurableProjection<never, { state: ConversationTransferState; base: ConversationTransferCommittedBaseRecord }>(
    CONVERSATION_TRANSFER_PROJECTION_ID, async view => {
      const state = await view.get(`transfer:${transferId}`) as unknown as ConversationTransferState | undefined;
      const base = await view.get(`base:${transferId}`) as unknown as ConversationTransferCommittedBaseRecord | undefined;
      if (!state || !['committed', 'tombstoned'].includes(state.phase) || !state.commit || !state.manifest || !state.proof ||
          !base || base.conversationId !== state.identity.conversationId || !sameRef(base.manifest, state.manifest)) {
        throw new TypeError('Conversation transfer has no committed atomic source binding');
      }
      return { kind: 'return', value: { state, base } };
    })).value;
}

export async function loadCommittedConversationBase(log: AuthorityCommitLog, artifacts: ArtifactStore,
  verifier: ProtocolSignatureVerifier, transferId: string): Promise<ConversationTransferPublication> {
  const { state, base } = await readCommittedConversationTransferHeader(log, verifier, transferId);
  registerConversationBaseContext(log, artifacts, verifier);
  const source = await ConversationBaseSource.open({ log, artifacts, verifier, state, ownerCheckpoint: await log.checkpoint() });
  if (!source.ready) await source.prepare();
  const manifest = source.manifest;
  if (!sameRef(base.records, manifest.authorityBase.records) || !sameRef(base.sessionState, manifest.authorityBase.sessionState)) {
    throw new TypeError('Committed conversation authority base does not match its manifest');
  }
  return { state, manifest, source };
}

/**
 * 明确请求全部转移时分页读取其当前行，不重放WAL或另存全集合检查点。
 */
export async function listConversationTransferStates(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier): Promise<readonly ConversationTransferState[]> {
  const index = registerConversationTransferProjection(log, verifier), states: ConversationTransferState[] = [];
  let after: string | undefined;
  do {
    const page = await index.scan({ ...(after ? { gt: after } : { gte: 'transfer:' }), lt: 'transfer:\uffff' }, 64);
    for (const entry of page.entries) states.push(entry.value as unknown as ConversationTransferState);
    after = page.continuation ? page.entries.at(-1)!.key : undefined;
  } while (after);
  return states.sort((a, b) => a.identity.transferId.localeCompare(b.identity.transferId));
}

export interface ConversationTransferAuthorityRecord {
  readonly lsn: number;
  readonly at: string;
  readonly stream: string;
  readonly body: JsonValue;
  readonly sourceEnvelopeDigest?: string;
  readonly sourceItem?: number;
}

interface SelectedConversationRecords {
  readonly records: readonly ConversationTransferAuthorityRecord[];
  readonly streams: ConversationTransferManifest["streams"];
  readonly references: readonly ArtifactRef[];
}

export async function selectConversationAuthorityRecords(
  commits: readonly CommitEnvelope<unknown>[],
  conversationId: string,
  artifacts: ArtifactStore,
  verifier: ProtocolSignatureVerifier,
): Promise<SelectedConversationRecords> {
  const assignmentIds = new Set<string>();
  const controlRequestIds = new Set<string>();
  for (const envelope of commits) {
    for (const entry of envelope.entries) {
      if (entry.stream === `run:${conversationId}`) {
        collectStringFields(entry.body, "assignmentId", assignmentIds);
      }
      const control = entry.stream === "control"
        ? await materializeTransferControlRecord(entry.body, artifacts)
        : undefined;
      if (control && recordBindsConversation(control, conversationId)) {
        const requestId = recordString(entry.body, "requestId");
        if (requestId) controlRequestIds.add(requestId);
      }
    }
  }
  const records: ConversationTransferAuthorityRecord[] = [];
  const references: ArtifactRef[] = [];
  for (const envelope of commits) {
    for (const [sourceItem, entry] of envelope.entries.entries()) {
      const include =
        isDirectConversationStream(entry.stream, conversationId) ||
        (entry.stream === "control" &&
          controlRequestIds.has(recordString(entry.body, "requestId") ?? "")) ||
        (entry.stream === "publish" &&
          assignmentIds.has(recordString(entry.body, "assignmentId") ?? "")) ||
        (entry.stream === "final-outbox" &&
          recordString(entry.body, "conversationId") === conversationId);
      if (!include) continue;
      const body = cloneJson(entry.body, "Conversation transfer record body");
      collectArtifactRefs(body, references);
      if (entry.stream === `run:${conversationId}` && body && typeof body === 'object' && !Array.isArray(body)) {
        const fact = body as Record<string, unknown>;
        if (fact.t === 'assigned' && fact.dispatchRef) {
          const dispatch = validateConversationEnvelope(JSON.parse(Buffer.from(await artifacts.get(fact.dispatchRef as ArtifactRef)).toString('utf8')), verifier);
          references.push(...(await resolveDispatchArtifactClosure(dispatch, artifacts)).transfer);
        } else if (fact.t === 'committed' && fact.bundle) {
          const bundle = JSON.parse(Buffer.from(await artifacts.get((fact.bundle as { ref: ArtifactRef }).ref)).toString('utf8'));
          references.push(...(await resolveSealedBundleArtifactClosure(bundle, artifacts)).transfer);
        }
      }
      if (entry.stream === "control") {
        collectArtifactRefs(
          await materializeTransferControlRecord(entry.body, artifacts),
          references,
        );
      }
      records.push({ lsn: envelope.lsn, at: envelope.at, stream: entry.stream, body,
        sourceEnvelopeDigest: envelope.envelopeDigest, sourceItem });
    }
  }
  if (!records.some((record) => record.stream === `run:${conversationId}`)) {
    throw new Error("Conversation transfer has no authoritative conversation stream");
  }
  for (const ref of uniqueSortedRefs(references)) {
    if (!(await artifacts.has(ref))) {
      throw new Error("Conversation transfer references a missing content artifact");
    }
  }
  const byStream = new Map<string, typeof records>();
  for (const record of records) {
    const list = byStream.get(record.stream) ?? [];
    list.push(record);
    byStream.set(record.stream, list);
  }
  const streams = [...byStream.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stream, entries]) => ({
      stream,
      firstLsn: entries[0]!.lsn,
      lastLsn: entries.at(-1)!.lsn,
      recordCount: entries.length,
      digest: protocolDigest("ConversationTransferLogicalStream", 1, {
        stream,
        records: entries,
      }),
    }));
  return { records, streams, references: uniqueSortedRefs(references) };
}

async function reduceConversationTransferProjection(
  envelope: CommitEnvelope<ConversationTransferLogRecord>,
  current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier,
  log: AuthorityCommitLog,
  source: DurableProjectionSource,
): Promise<readonly DurableProjectionMutation[]> {
  const overlay = new Map<string, ConversationTransferState>();
  const mutations: DurableProjectionMutation[] = [];
  const getState = async (key: string) => {
    if (overlay.has(key)) return overlay.get(key);
    const value = await current.get(key);
    return value === undefined
      ? undefined
      : (value as unknown as ConversationTransferState);
  };
  for (const entry of envelope.entries) {
    if (!entry.stream.startsWith("transfer:xfer-")) continue;
    if (!entry.body || typeof entry.body.transferId !== 'string' || entry.stream !== `transfer:${entry.body.transferId}`) throw new TypeError('Conversation transfer record belongs to another stream');
    if (isConversationTransferCommittedBase(entry.body)) {
      const body = entry.body, state = await getState('transfer:' + body.transferId), key = 'base:' + body.transferId;
      const keys = body.v === 1 ? ['v', 't', 'transferId', 'conversationId', 'manifest', 'records', 'sessionState']
        : body.v === 2 ? ['v', 't', 'transferId', 'conversationId', 'manifest', 'records', 'sessionState', 'ownerBasis'] : [];
      if (!keys.length || canonicalize(Object.keys(body).sort()) !== canonicalize(keys.sort()) || envelope.entries.some(value => value.stream === 'trust')) {
        throw new TypeError('Conversation owner basis requires its own atomic transfer publication');
      }
      if (!state?.commit || state.phase !== 'committed' || body.conversationId !== state.identity.conversationId ||
          !state.manifest || !sameRef(body.manifest, state.manifest) ||
          !envelope.entries.some(value => value.stream === entry.stream && value.body.t === 'committed' && value.body.transferId === body.transferId)) {
        throw new TypeError('Conversation committed base is not atomic with its owner commit');
      }
      const prior = await current.get(key);
      if (prior !== undefined && canonicalize(prior) !== canonicalize(body)) throw new TypeError('Conversation committed base changed');
      mutations.push({ kind: 'put', key, value: body as unknown as JsonValue });
      const tenure = await conversationAnchorAtSource(log, source);
      if (!tenure && source.candidate) throw new TypeError('Conversation owner basis has no verified anchor tenure');
      if (tenure) {
        const basis = conversationOwnerBasis(tenure, state.identity.targetDeviceId, state.identity.nextOwnerEpoch);
        if (body.v === 2 && canonicalize(body.ownerBasis) !== canonicalize(basis) || body.v === 1 && body.ownerBasis !== undefined) throw new TypeError('Conversation owner basis does not match its committed trust prefix');
        mutations.push({ kind: 'put', key: `owner-base:${body.conversationId}`, value: basis as unknown as JsonValue });
      }
      continue;
    }
    const transferKey = `transfer:${entry.body.transferId}`;
    const previous = await getState(transferKey);
    const next = reduceConversationTransfer(previous, entry.body, verifier);
    const conversationKey = `conversation:${next.identity.conversationId}`;
    const conversation = await getState(conversationKey);
    if (
      entry.body.t === "prepared" &&
      conversation &&
      conversation.identity.transferId !== next.identity.transferId &&
      !canFollowConversationTransfer(conversation, next)
    ) {
      throw new Error("Conversation already has an incompatible transfer generation");
    }
    overlay.set(transferKey, next);
    overlay.set(conversationKey, next);
    const conversationId = next.identity.conversationId, transferId = next.identity.transferId;
    // 二级定位：按会话列出它的全部迁移；未终结（非 aborted/tombstoned）的迁移单列，启动只读这批；
    // 已提交（含已转出）的迁移另列，目标端按会话找它收编的迁移，不遍历迁移历史
    const open = `${OPEN_TRANSFER_PREFIX}${conversationId}:${transferId}`;
    mutations.push(
      { kind: "put", key: transferKey, value: next as unknown as JsonValue },
      { kind: "put", key: conversationKey, value: next as unknown as JsonValue },
      { kind: "put", key: `${CONVERSATION_TRANSFERS_PREFIX}${conversationId}:${transferId}`, value: { transferId } },
      next.phase === "aborted" || next.phase === "tombstoned"
        ? { kind: "tombstone", key: open }
        : { kind: "put", key: open, value: { conversationId, transferId } },
    );
    if (next.phase === "committed" || next.phase === "tombstoned") {
      mutations.push({ kind: "put", key: `${COMMITTED_TRANSFER_PREFIX}${conversationId}:${transferId}`, value: { conversationId, transferId } });
    }
  }
  return mutations;
}

const OPEN_TRANSFER_PREFIX = "open:";
const CONVERSATION_TRANSFERS_PREFIX = "by-conversation:";
const COMMITTED_TRANSFER_PREFIX = "committed:";

async function scanTransferIndex(
  index: DurableProjectionReadContext,
  prefix: string,
): Promise<readonly { readonly conversationId?: string; readonly transferId: string }[]> {
  const values: { conversationId?: string; transferId: string }[] = [];
  let continuation: string | undefined;
  do {
    const page = await index.scan({ gte: prefix, lt: `${prefix}￿` }, 64, continuation);
    for (const entry of page.entries) values.push(entry.value as unknown as { conversationId?: string; transferId: string });
    continuation = page.continuation;
  } while (continuation);
  return values;
}

/** 未终结（非 aborted/tombstoned）的迁移：只读这批二级键，不遍历已终结的迁移历史。 */
export async function listOpenConversationTransfers(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier):
  Promise<readonly { readonly conversationId: string; readonly transferId: string }[]> {
  const index = registerConversationTransferProjection(log, verifier);
  return (await scanTransferIndex(index, OPEN_TRANSFER_PREFIX)) as readonly { conversationId: string; transferId: string }[];
}

/** 一个会话的全部迁移，按迁移 id 精确读取状态。 */
export async function listConversationTransfersFor(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier,
  conversationId: string): Promise<readonly ConversationTransferState[]> {
  const index = registerConversationTransferProjection(log, verifier);
  const states: ConversationTransferState[] = [];
  for (const { transferId } of await scanTransferIndex(index, `${CONVERSATION_TRANSFERS_PREFIX}${conversationId}:`)) {
    const state = await index.get(`transfer:${transferId}`);
    if (state === undefined) throw new Error("Conversation transfer index has no matching transfer");
    states.push(state as unknown as ConversationTransferState);
  }
  return states.sort((a, b) => a.identity.transferId.localeCompare(b.identity.transferId));
}

/** 一个会话已提交（含已转出）的迁移编号，按编号排序；只读这个会话的二级键。 */
export async function listCommittedConversationTransferIds(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier,
  conversationId: string): Promise<readonly string[]> {
  const index = registerConversationTransferProjection(log, verifier);
  return (await scanTransferIndex(index, `${COMMITTED_TRANSFER_PREFIX}${conversationId}:`)).map(entry => entry.transferId);
}

/** 全部已提交收编的会话，按会话编号排序；供目录类列举按需调用，启动路径不读。 */
export async function listCommittedConversationIds(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier):
  Promise<readonly string[]> {
  const index = registerConversationTransferProjection(log, verifier);
  return [...new Set((await scanTransferIndex(index, COMMITTED_TRANSFER_PREFIX)).map(entry => entry.conversationId!))];
}

async function projectedConversationTransferState(
  projection: DurableProjectionReadContext,
  conversationId: string,
): Promise<ConversationTransferState | undefined> {
  const value = await projection.get(`conversation:${conversationId}`);
  return value === undefined
    ? undefined
    : (value as unknown as ConversationTransferState);
}

function canFollowConversationTransfer(
  previous: ConversationTransferState,
  next: ConversationTransferState,
): boolean {
  if (previous.phase === "aborted") {
    return (
      next.identity.sourceDeviceId === previous.identity.sourceDeviceId &&
      next.identity.sourceOwnerEpoch === previous.identity.sourceOwnerEpoch
    );
  }
  if (previous.phase === "committed" || previous.phase === "tombstoned") {
    return (
      next.identity.sourceDeviceId === previous.identity.targetDeviceId &&
      next.identity.sourceOwnerEpoch === previous.identity.nextOwnerEpoch
    );
  }
  return false;
}

function isDirectConversationStream(stream: string, conversationId: string): boolean {
  return (
    stream === `run:${conversationId}` ||
    stream === `intent:${conversationId}` ||
    stream === `session-activity:${conversationId}`
  );
}

function recordBindsConversation(value: unknown, conversationId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => recordBindsConversation(entry, conversationId));
  }
  if (!isPlainRecord(value)) return false;
  if (value.conversationId === conversationId) return true;
  return Object.values(value).some((entry) =>
    isPlainRecord(entry) ? recordBindsConversation(entry, conversationId) : false
  );
}

async function materializeTransferControlRecord(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<unknown> {
  if (!isPlainRecord(value)) return value;
  if (value.t === "received") {
    const envelope = await materializeStoredControlValue(value.envelope, artifacts);
    return {
      ...value,
      envelope: validateAdmittedControlEnvelope(envelope),
    };
  }
  if (value.t === "applied") {
    return {
      ...value,
      result: await materializeStoredControlValue(value.result, artifacts),
    };
  }
  return value;
}

async function materializeStoredControlValue(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<unknown> {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !("ref" in value)) {
    return value;
  }
  const refValue = value.ref;
  if (
    !isPlainRecord(refValue) ||
    typeof refValue.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(refValue.digest) ||
    !Number.isSafeInteger(refValue.bytes) ||
    (refValue.bytes as number) < 0
  ) {
    throw new TypeError("Conversation transfer control artifact reference is invalid");
  }
  const bytes = await artifacts.get({
    digest: refValue.digest as Digest,
    bytes: refValue.bytes as number,
  });
  const text = Buffer.from(bytes).toString("utf8");
  const decoded = JSON.parse(text) as unknown;
  if (canonicalize(decoded) !== text) {
    throw new TypeError("Conversation transfer control artifact is not canonical");
  }
  return decoded;
}

function recordString(value: unknown, key: string): string | undefined {
  return isPlainRecord(value) && typeof value[key] === "string"
    ? value[key] as string
    : undefined;
}

function collectStringFields(value: unknown, key: string, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStringFields(item, key, target);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (typeof value[key] === "string") target.add(value[key] as string);
  for (const item of Object.values(value)) collectStringFields(item, key, target);
}

function collectArtifactRefs(value: unknown, target: ArtifactRef[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactRefs(item, target);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (
    Object.keys(value).length >= 2 &&
    typeof value.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.digest) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) >= 0
  ) {
    target.push({ digest: value.digest as Digest, bytes: value.bytes as number });
  }
  for (const item of Object.values(value)) collectArtifactRefs(item, target);
}

function uniqueSortedRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...new Map(refs.map((ref) => [canonicalize(ref), ref])).values()]
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)))
    .map((ref) => ({ ...ref }));
}

function cloneJson(value: unknown, label: string): JsonValue {
  try {
    return JSON.parse(canonicalize(value)) as JsonValue;
  } catch (error) {
    throw new TypeError(`${label} is not canonical JSON`, { cause: error });
  }
}

function validateAuthorityRecord(value: unknown): ConversationTransferAuthorityRecord {
  if (
    !isPlainRecord(value) ||
    !Number.isSafeInteger(value.lsn) ||
    (value.lsn as number) <= 0 ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    typeof value.stream !== "string" ||
    value.stream.length === 0 ||
    !("body" in value)
  ) {
    throw new Error("Conversation transfer authority record is invalid");
  }
  return {
    lsn: value.lsn as number,
    at: value.at,
    stream: value.stream,
    body: cloneJson(value.body, "Conversation transfer authority record body"),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.digest === right.digest && left.bytes === right.bytes;
}

function assertRange(ref: ArtifactRef, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    offset + length > ref.bytes
  ) {
    throw new RangeError("Conversation transfer read range is invalid");
  }
}

/** Transfer-private CAS view required by the conversation transfer application. */
export interface ConversationTransferStagingArtifacts {
  readonly get: (ref: ArtifactRef) => Promise<Uint8Array>;
  readonly readRange: (
    ref: ArtifactRef,
    offset: number,
    limit: number,
  ) => Promise<Uint8Array>;
  readonly has: (ref: ArtifactRef) => Promise<boolean>;
}

/** Durable-prefix receiver view required by the conversation transfer application. */
export interface ConversationTransferStagingReceiver {
  readonly progress: (
    ref: ArtifactRef,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ) => Promise<ArtifactReceiveProgress>;
  readonly append: (
    ref: ArtifactRef,
    offset: number,
    bytes: Uint8Array,
    runPhysicalStep?: IdentifiedPhysicalStepRunner,
  ) => Promise<ArtifactReceiveProgress>;
}

/** One immutable physical staging projection, scoped to exactly one transfer identity. */
export interface ConversationTransferStaging {
  readonly artifacts: ConversationTransferStagingArtifacts;
  readonly receiver: ConversationTransferStagingReceiver;
  readonly cleanup: () => Promise<number>;
}

export interface ConversationTransferStagingArea {
  readonly forTransfer: (transferId: string) => ConversationTransferStaging;
}

export interface ConversationTransferTargetOptions {
  readonly deviceId: string;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly staging: ConversationTransferStagingArea;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly isActiveSource: (deviceId: string) => boolean | Promise<boolean>;
  readonly acceptsSourceConversationId: (
    sourceDeviceId: string,
    conversationId: string,
  ) => boolean;
  readonly conversationExists: (conversationId: string) => boolean | Promise<boolean>;
  readonly sourceOwnerEpoch: (conversationId: string) => number | undefined | Promise<number | undefined>;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly abortSignal?: () => AbortSignal;
  readonly reducerVersion: string;
  readonly preparePublication?: (
    input: ConversationTransferPublication,
  ) => Promise<{ readonly publish: () => void }>;
}

export interface ImportedConversationTransfer {
  readonly state: ConversationTransferState;
  readonly manifest: ConversationTransferManifest;
}

export interface ConversationTransferCommittedBase {
  readonly state: ConversationTransferState;
  readonly manifest: ConversationTransferManifest;
  readonly records: readonly ConversationTransferAuthorityRecord[];
  readonly sessionState: JsonValue;
}

/** Prepared immutable import view. The source reads only bounded referenced
 * regions; the full authority record array never becomes a publication value. */
export interface ConversationTransferPublication {
  readonly state: ConversationTransferState;
  readonly manifest: ConversationBaseManifest;
  readonly source: ConversationBaseSource;
}

export class ConversationTransferTarget {
  readonly #options: ConversationTransferTargetOptions;
  readonly #publicationTokens = new Map<string, { readonly publish: () => void }>();
  readonly #sources = new Map<string, ConversationBaseSource>();

  constructor(options: ConversationTransferTargetOptions) {
    this.#options = options;
    registerConversationTransferProjection(options.log, options.verifier);
    registerConversationBaseContext(options.log, options.artifacts, options.verifier);
  }

  state(transferId: string): Promise<ConversationTransferState | undefined> {
    return readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
  }

  /** Reads the immutable imported authority base only after the owner switch is durable. */
  async committedBase(transferId: string): Promise<ConversationTransferCommittedBase> {
    const state = await this.state(transferId);
    if (!state || (state.phase !== "committed" && state.phase !== "tombstoned")) {
      throw new TypeError("Conversation transfer is not committed");
    }
    if (!state.manifest) throw new Error("Committed conversation transfer has no manifest");
    const committedBase = await readConversationTransferCommittedBaseRecord(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (
      !committedBase ||
      committedBase.conversationId !== state.identity.conversationId ||
      !sameRef(committedBase.manifest, state.manifest)
    ) {
      throw new Error("Committed conversation transfer has no atomic authority base");
    }
    const manifest = await loadManifest(this.#options.artifacts, committedBase.manifest);
    if (
      !sameRef(committedBase.records, manifest.authorityBase.records) ||
      !sameRef(committedBase.sessionState, manifest.authorityBase.sessionState)
    ) {
      throw new Error("Committed conversation authority base does not match its manifest");
    }
    return loadCommittedBase(this.#options.artifacts, state, manifest);
  }

  /** Recovery/publication view for the committed owner switch. Only the
   * authenticated source header and bounded derived pages are loaded. */
  async committedBaseSource(transferId: string): Promise<ConversationTransferPublication> {
    return loadCommittedConversationBase(this.#options.log, this.#options.artifacts, this.#options.verifier, transferId);
  }

  async #openSource(state: ConversationTransferState): Promise<ConversationBaseSource> {
    const transferId = state.identity.transferId;
    const existing = this.#sources.get(transferId);
    if (existing) {
      if (canonicalize(existing.state.identity) !== canonicalize(state.identity) || !state.manifest || !sameRef(existing.manifestRef, state.manifest)) throw new TypeError('Conversation source cache generation changed');
      if (!existing.ready) await existing.prepare();
      return existing;
    }
    if (!state.manifest || !state.proof) throw new TypeError("Conversation transfer source is not authenticated");
    const source = await ConversationBaseSource.open({
      log: this.#options.log,
      artifacts: this.#options.artifacts,
      verifier: this.#options.verifier,
      state,
      ownerCheckpoint: await this.#options.log.checkpoint(),
    });
    if (!source.ready) await source.prepare();
    this.#sources.set(transferId, source);
    return source;
  }

  async prepare(input: Extract<TransferRecord, { t: "prepared" }>): Promise<ConversationTransferState> {
    if (input.targetDeviceId !== this.#options.deviceId) {
      throw new TypeError("Conversation transfer target device does not match");
    }
    if (!(await this.#options.isActiveSource(input.sourceDeviceId))) {
      throw new TypeError("Conversation transfer source device is not active");
    }
    if (
      !this.#options.acceptsSourceConversationId(
        input.sourceDeviceId,
        input.conversationId,
      )
    ) {
      throw new TypeError("Conversation transfer identity is outside the source namespace");
    }
    const replay = await this.state(input.transferId);
    if (replay) {
      return appendConversationTransferRecord(this.#options.log, this.#options.verifier, input);
    }
    if (await this.#options.conversationExists(input.conversationId)) {
      throw new TypeError("Conversation transfer target already has this conversation");
    }
    const epoch = await this.#options.sourceOwnerEpoch(input.conversationId);
    if (epoch !== undefined && epoch !== input.sourceOwnerEpoch) {
      throw new TypeError("Conversation transfer source owner epoch is stale");
    }
    return appendConversationTransferRecord(this.#options.log, this.#options.verifier, input);
  }

  async import(input: {
    readonly transferId: string;
    readonly manifestRef: ArtifactRef;
    readonly proof: SourceFreezeProof;
    readonly source: ConversationTransferReadPort;
  }): Promise<ImportedConversationTransfer> {
    const state = await readConversationTransferState(
      this.#options.log,
      input.transferId,
      this.#options.verifier,
    );
    if (!state || (state.phase !== "prepared" && state.phase !== "frozen")) {
      if (state?.phase === "imported") {
        const manifest = await loadManifest(this.#options.artifacts, state.manifest!);
        return { state, manifest };
      }
      throw new TypeError("Conversation transfer target is not prepared");
    }
    const proof = validateSourceFreezeProof(input.proof, this.#options.verifier);
    if (
      proof.transferId !== state.identity.transferId ||
      proof.scope !== "conversation" ||
      proof.subject !== state.identity.conversationId ||
      proof.sourceEpoch !== state.identity.sourceOwnerEpoch ||
      proof.checkpointDigest !== input.manifestRef.digest
    ) {
      throw new TypeError("Conversation transfer proof does not bind target preparation");
    }
    const staging = this.#options.staging.forTransfer(state.identity.transferId);
    if (state.phase === "frozen") {
      if (
        !state.manifest ||
        !sameRef(state.manifest, input.manifestRef) ||
        canonicalize(state.proof) !== canonicalize(proof)
      ) {
        throw new TypeError("Conversation transfer retry does not match frozen staging");
      }
    } else {
      await copyArtifact(
        input.manifestRef,
        state.identity.transferId,
        state.identity.targetDeviceId,
        input.source,
        staging.artifacts,
        staging.receiver,
        this.#options,
      );
    }
    const manifest = await loadManifest(staging.artifacts, input.manifestRef);
    assertManifestIdentity(manifest, state);
    if (manifest.authorityBase.reducerVersion !== this.#options.reducerVersion) {
      throw new Error("Conversation transfer reducer version is incompatible");
    }
    for (const ref of [
      manifest.authorityBase.records,
      manifest.authorityBase.sessionState,
      ...manifest.contentAssets,
    ]) {
      if (!(await staging.artifacts.has(ref))) {
        await copyArtifact(
          ref,
          state.identity.transferId,
          state.identity.targetDeviceId,
          input.source,
          staging.artifacts,
          staging.receiver,
          this.#options,
        );
      }
    }
    await promoteTransferClosure(
      state.identity.transferId,
      [
        input.manifestRef,
        manifest.authorityBase.records,
        manifest.authorityBase.sessionState,
        ...manifest.contentAssets,
      ],
      staging.artifacts,
      this.#options,
    );
    const provisional = {
      ...state,
      phase: "frozen" as const,
      manifest: input.manifestRef,
      proof,
    } as ConversationTransferState;
    const source = await ConversationBaseSource.open({
      log: this.#options.log,
      artifacts: this.#options.artifacts,
      verifier: this.#options.verifier,
      state: provisional,
      ownerCheckpoint: await this.#options.log.checkpoint(),
    });
    if (!source.ready) await source.prepare();
    this.#sources.set(state.identity.transferId, source);
    if (state.phase === "prepared") {
      await appendConversationTransferRecord(
        this.#options.log,
        this.#options.verifier,
        {
          v: 1,
          t: "frozen",
          transferId: state.identity.transferId,
          manifest: input.manifestRef,
          proof,
        },
      );
    }
    const importedRecord: Extract<TransferRecord, { t: "imported" }> = {
      v: 1,
      t: "imported",
      transferId: state.identity.transferId,
      manifestDigest: input.manifestRef.digest,
      importedRecordBase: manifest.authorityBase.records,
    };
    const stagedState = await readConversationTransferState(
      this.#options.log,
      state.identity.transferId,
      this.#options.verifier,
    );
    if (!stagedState || stagedState.phase !== "frozen") {
      throw new Error("Conversation transfer staging phase is not frozen");
    }
    const preview = reduceConversationTransfer(
      stagedState,
      importedRecord,
      this.#options.verifier,
    );
    if (this.#options.preparePublication) {
      if (!source) throw new TypeError("Conversation transfer publication requires artifact-derived pages");
      this.#publicationTokens.set(
        state.identity.transferId,
        await this.#options.preparePublication({ state: preview, manifest, source }),
      );
    }
    const final = await appendConversationTransferRecord(
      this.#options.log,
      this.#options.verifier,
      importedRecord,
    );
    return { state: final, manifest };
  }

  async cleanupAborted(transferId: string): Promise<number> {
    const state = await readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (!state || state.phase !== "aborted") return 0;
    const signal = this.#options.abortSignal?.() ?? new AbortController().signal;
    return runWithMaintenanceUrgency(() => "foreground", signal, () =>
      runStorageMaintenanceStep(
        this.#options.storageMaintenance,
        storageMaintenanceRequest("conversation-transfer", transferId, {
          step: "staging-cleanup",
        }, { obligation: "committed" }),
        () => this.#options.staging.forTransfer(transferId).cleanup(),
      )
    );
  }

  async commit(transferId: string): Promise<{
    readonly state: ConversationTransferState;
    readonly manifest: ConversationTransferManifest;
    readonly commit: ConversationTransferCommit;
  }> {
    const current = await readConversationTransferState(
      this.#options.log,
      transferId,
      this.#options.verifier,
    );
    if (!current) throw new TypeError("Conversation transfer target is unknown");
    if (current.phase === "committed" || current.phase === "tombstoned") {
      const manifest = await loadManifest(this.#options.artifacts, current.manifest!);
      await this.#publishPreparedBase(current, manifest);
      return { state: current, manifest, commit: current.commit! };
    }
    if (current.phase !== "imported" || !current.manifest || !current.proof) {
      throw new TypeError("Conversation transfer target is not imported");
    }
    const manifest = await loadManifest(this.#options.artifacts, current.manifest);
    assertManifestIdentity(manifest, current);
    const commit = createSignedConversationTransferCommit(
      {
        v: 1,
        transferId,
        conversationId: current.identity.conversationId,
        sourceDeviceId: current.identity.sourceDeviceId,
        targetDeviceId: current.identity.targetDeviceId,
        freezeProofDigest: sourceFreezeProofDigest(current.proof),
        checkpointDigest: current.manifest.digest,
        sourceOwnerEpoch: current.identity.sourceOwnerEpoch,
        nextOwnerEpoch: current.identity.nextOwnerEpoch,
        at: new Date().toISOString(),
      },
      this.#options.signer,
    );
    if (!this.#publicationTokens.has(transferId) && this.#options.preparePublication) {
      this.#publicationTokens.set(
        transferId,
        await this.#options.preparePublication({ state: current, manifest, source: await this.#openSource(current) }),
      );
    }
    const state = await appendConversationTransferCommitAndBase(
      this.#options.log,
      this.#options.verifier,
      { v: 1, t: "committed", transferId, commit },
      manifest,
    );
    this.#publicationTokens.get(transferId)?.publish();
    return { state, manifest, commit };
  }

  async recordAbort(abort: ConversationTransferAbort): Promise<void> {
    await appendConversationTransferRecord(
      this.#options.log,
      this.#options.verifier,
      { v: 1, t: "aborted", transferId: abort.transferId, abort },
    );
    this.#publicationTokens.delete(abort.transferId);
  }

  async #publishPreparedBase(
    state: ConversationTransferState,
    manifest: ConversationTransferManifest,
  ): Promise<void> {
    if (!this.#options.preparePublication) return;
    let token = this.#publicationTokens.get(state.identity.transferId);
    if (!token) {
      token = await this.#options.preparePublication({
        state,
        manifest,
        source: await this.#openSource(state),
      });
      this.#publicationTokens.set(state.identity.transferId, token);
    }
    token.publish();
  }
}

export interface ConversationAdoptionCoordinatorOptions {
  readonly source: ConversationTransferSource;
  readonly target: ConversationTransferTarget;
  readonly afterCommit?: (input: {
    readonly manifest: ConversationTransferManifest;
    readonly commit: ConversationTransferCommit;
  }) => Promise<void>;
}

/**
 * The narrow adoption coordinator owns network retry order, never authority.
 * Both logs remain the only durable facts, so repeating this method after any
 * lost response resumes the same transfer generation without another owner.
 */
export class ConversationAdoptionCoordinator {
  readonly #options: ConversationAdoptionCoordinatorOptions;

  constructor(options: ConversationAdoptionCoordinatorOptions) {
    this.#options = options;
  }

  async adopt(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly sourceDeviceId: string;
    readonly targetDeviceId: string;
    readonly conversationId: string;
    readonly sourceOwnerEpoch: number;
    readonly sourceReadPort?: ConversationTransferReadPort;
  }): Promise<ConversationTransferCommit> {
    const prepared: Extract<TransferRecord, { t: "prepared" }> = {
      v: 1,
      t: "prepared",
      requestId: input.requestId,
      transferId: input.transferId,
      sourceDeviceId: input.sourceDeviceId,
      targetDeviceId: input.targetDeviceId,
      conversationId: input.conversationId,
      sourceOwnerEpoch: input.sourceOwnerEpoch,
      nextOwnerEpoch: input.sourceOwnerEpoch + 1,
    };
    await this.#options.target.prepare(prepared);
    await this.#options.source.prepare(input);
    const frozen = await this.#options.source.freeze(input.transferId);
    const imported = await this.#options.target.import({
      transferId: input.transferId,
      manifestRef: frozen.manifestRef,
      proof: frozen.proof,
      source: input.sourceReadPort ?? this.#options.source.readPort,
    });
    if (imported.state.phase !== "imported") {
      throw new Error("Conversation transfer did not reach imported state");
    }
    const committed = await this.#options.target.commit(input.transferId);
    await this.#options.source.acceptCommit(committed);
    await this.#options.afterCommit?.({
      manifest: committed.manifest,
      commit: committed.commit,
    });
    return committed.commit;
  }
}

async function copyArtifact(
  ref: ArtifactRef,
  transferId: string,
  targetDeviceId: string,
  source: ConversationTransferReadPort,
  staging: ConversationTransferStagingArtifacts,
  receiver: ConversationTransferStagingReceiver,
  options: ConversationTransferTargetOptions,
): Promise<void> {
  if (!(await source.probe({ transferId, targetDeviceId, ref }))) {
    throw new Error("Conversation transfer source is missing a manifest artifact");
  }
  const signal = options.abortSignal?.() ?? new AbortController().signal;
  const capacityStep = identifiedCapacityStep(options, transferId, ref);
  await runWithMaintenanceUrgency(() => "foreground", signal, async () => {
    let progress = await receiver.progress(ref, capacityStep);
    const size = 256 * 1024;
    while (!progress.complete) {
      const offset = progress.receivedBytes;
      const bytes = await source.readRange({
        transferId,
        targetDeviceId,
        ref,
        offset,
        length: Math.min(size, ref.bytes - offset),
      });
      progress = await receiver.append(ref, offset, bytes, capacityStep);
    }
  });
  if (!(await staging.has(ref))) {
    throw new Error("Conversation transfer staging did not finalize its verified artifact");
  }
}

async function promoteTransferClosure(
  transferId: string,
  refs: readonly ArtifactRef[],
  staging: ConversationTransferStagingArtifacts,
  options: ConversationTransferTargetOptions,
): Promise<void> {
  for (const ref of uniqueSortedRefs(refs)) {
    if (await options.artifacts.has(ref)) continue;
    await options.artifacts.putVerifiedStream(
      ref,
      readStoredChunks(staging, ref),
      (operation) =>
        runStorageMaintenanceStep(
          options.storageMaintenance,
          storageMaintenanceRequest("conversation-transfer", transferId, {
            step: "promote",
            bytes: ref.bytes,
          }, { obligation: "pre-commit" }),
          operation,
        ),
    );
  }
}

function identifiedCapacityStep(
  options: ConversationTransferTargetOptions,
  transferId: string,
  ref: ArtifactRef,
): IdentifiedPhysicalStepRunner {
  return (identity, operation) =>
    runStorageMaintenanceStep(
      options.storageMaintenance,
      storageMaintenanceRequest("conversation-transfer", transferId, {
        receiverStep: identity,
        digest: ref.digest,
      }, { obligation: "pre-commit" }),
      operation,
    );
}

async function* readStoredChunks(
  store: ConversationTransferStagingArtifacts,
  ref: ArtifactRef,
): AsyncIterable<Uint8Array> {
  const size = 256 * 1024;
  for (let offset = 0; offset < ref.bytes; offset += size) {
    yield await store.readRange(ref, offset, Math.min(size, ref.bytes - offset));
  }
}

async function putTransferArtifact(
  options: Pick<
    ConversationTransferSourceOptions,
    "artifacts" | "storageMaintenance" | "abortSignal"
  >,
  transferId: string,
  step: string,
  bytes: Uint8Array,
): Promise<ArtifactRef> {
  const signal = options.abortSignal?.() ?? new AbortController().signal;
  return runWithMaintenanceUrgency(() => "foreground", signal, () =>
    runStorageMaintenanceStep(
      options.storageMaintenance,
      storageMaintenanceRequest(
        "conversation-transfer",
        transferId,
        { step, bytes: bytes.byteLength },
        { obligation: "pre-commit" },
      ),
      () => options.artifacts.put(bytes),
    ),
  );
}

async function loadManifest(
  artifacts: ConversationTransferStagingArtifacts,
  ref: ArtifactRef,
): Promise<ConversationTransferManifest> {
  const bytes = await artifacts.get(ref);
  const prepared = prepareConversationTransferManifest(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (!sameRef(prepared.ref, ref)) throw new Error("Conversation transfer manifest digest mismatch");
  return prepared.manifest;
}

async function loadCommittedBase(
  artifacts: ConversationTransferStagingArtifacts,
  state: ConversationTransferState,
  manifest: ConversationTransferManifest,
): Promise<ConversationTransferCommittedBase> {
  const rawRecords = JSON.parse(
    Buffer.from(await artifacts.get(manifest.authorityBase.records)).toString("utf8"),
  ) as unknown;
  if (!Array.isArray(rawRecords)) {
    throw new Error("Committed conversation authority base is invalid");
  }
  const records = rawRecords.map((value) => validateAuthorityRecord(value));
  const sessionState = cloneJson(
    JSON.parse(
      Buffer.from(await artifacts.get(manifest.authorityBase.sessionState)).toString("utf8"),
    ),
    "Committed conversation session state",
  );
  return { state, manifest, records, sessionState };
}

function assertManifestIdentity(
  manifest: ConversationTransferManifest,
  state: ConversationTransferState,
): void {
  const identity = state.identity;
  if (
    manifest.requestId !== identity.requestId ||
    manifest.transferId !== identity.transferId ||
    manifest.sourceDeviceId !== identity.sourceDeviceId ||
    manifest.targetDeviceId !== identity.targetDeviceId ||
    manifest.conversationId !== identity.conversationId ||
    manifest.sourceOwnerEpoch !== identity.sourceOwnerEpoch ||
    manifest.nextOwnerEpoch !== identity.nextOwnerEpoch
  ) {
    throw new TypeError("Conversation transfer manifest does not bind target preparation");
  }
}

/**
 * 会话迁移冻结的领域定位索引：只记“含该会话相关条目或归属来源的信封”在哪里，冻结时按会话前缀找到这些信封、
 * 精确读出，再交给原两遍选择器（selectConversationAuthorityRecords），选择语义不变。
 * - e/：直属流（run/intent/session-activity）与该会话 final-outbox 条目所在信封；
 * - ca/ 与 pa/：run 正文里出现的 assignmentId（最早建立的 lsn）与该 assignmentId 的 publish 所在信封；
 * - cc/ 与 cr/：物化后绑定该会话的 control 请求（最早建立的 lsn）与该 requestId 的全部 control 所在信封。
 * 归属与位置都带 lsn，冻结只取冻点之前的，续读不混入冻点后的事实或关系。
 */
export const CONVERSATION_TRANSFER_SOURCES_PROJECTION_ID = "conversation-transfer-sources-v1";
const DIRECT_STREAM_PREFIXES = ["run:", "intent:", "session-activity:"] as const;
const sourceDigest = (domain: string, value: string): string => protocolDigest(`ConversationTransferSources${domain}`, 1, value);
const lsnKey = (lsn: number): string => lsn.toString().padStart(16, "0");

/** 物化后的 control 记录里被绑定的全部会话：与 recordBindsConversation 同一遍历（数组逐项、对象只下钻对象值）。 */
function boundConversations(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) boundConversations(entry, target);
    return;
  }
  if (!isPlainRecord(value)) return;
  if (typeof value.conversationId === "string") target.add(value.conversationId);
  for (const entry of Object.values(value)) if (isPlainRecord(entry)) boundConversations(entry, target);
}

/** 固定登记（重复登记同一定义幂等）：与会话迁移投影同处，首次写入前登记、随写入在线维护。 */
export function registerConversationTransferSources(log: AuthorityCommitLog, artifacts: ArtifactStore): void {
  log.durableProjection<unknown>({
    projectionId: CONVERSATION_TRANSFER_SOURCES_PROJECTION_ID, reducerVersion: 1, authenticated: true,
    inputs: { families: [...DIRECT_STREAM_PREFIXES], streams: ["control", "publish", "final-outbox"] },
    async reduce(envelope, current, source: DurableProjectionSource) {
      const changes = new Map<string, JsonValue | undefined>();
      const position = source.checkpoint as unknown as JsonValue;
      const establish = async (key: string, value: Record<string, JsonValue>) => {
        if (changes.has(key) || (await current.get(key)) !== undefined) return;
        changes.set(key, { ...value, lsn: envelope.lsn });
      };
      for (const entry of envelope.entries) {
        const direct = DIRECT_STREAM_PREFIXES.find((prefix) => entry.stream.startsWith(prefix));
        if (direct) {
          const conversationId = entry.stream.slice(direct.length);
          changes.set(`e/${sourceDigest("Conversation", conversationId)}/${lsnKey(envelope.lsn)}`, position);
          if (direct === "run:") {
            const assignments = new Set<string>();
            collectStringFields(entry.body, "assignmentId", assignments);
            for (const assignmentId of assignments)
              await establish(`ca/${sourceDigest("Conversation", conversationId)}/${sourceDigest("Assignment", assignmentId)}`, { assignmentId });
          }
        } else if (entry.stream === "final-outbox") {
          const conversationId = recordString(entry.body, "conversationId");
          if (conversationId) changes.set(`e/${sourceDigest("Conversation", conversationId)}/${lsnKey(envelope.lsn)}`, position);
        } else if (entry.stream === "publish") {
          const assignmentId = recordString(entry.body, "assignmentId");
          if (assignmentId) changes.set(`pa/${sourceDigest("Assignment", assignmentId)}/${lsnKey(envelope.lsn)}`, position);
        } else if (entry.stream === "control") {
          const requestId = recordString(entry.body, "requestId");
          if (!requestId) continue;
          changes.set(`cr/${sourceDigest("Request", requestId)}/${lsnKey(envelope.lsn)}`, position);
          const bound = new Set<string>();
          boundConversations(await materializeTransferControlRecord(entry.body, artifacts), bound);
          for (const conversationId of bound)
            await establish(`cc/${sourceDigest("Conversation", conversationId)}/${sourceDigest("Request", requestId)}`, { requestId });
        }
      }
      return [...changes].map(([key, value]): DurableProjectionMutation => value === undefined
        ? { kind: "tombstone", key } : { kind: "put", key, value });
    },
  });
}

/**
 * 冻点之前与该会话相关的信封，按 lsn 先后精确读出（每个信封一次）。冻点由调用方先取得；索引视图在其后的
 * 同一已验证前缀上，位置与归属都只取 lsn ≤ 冻点的。
 */
export async function readConversationTransferEnvelopes(
  log: AuthorityCommitLog,
  artifacts: ArtifactStore,
  conversationId: string,
  through: DurableLogCheckpoint,
): Promise<readonly CommitEnvelope<unknown>[]> {
  registerConversationTransferSources(log, artifacts);
  const positions = (await log.transactDurableProjection<never, Map<number, DurableLogCheckpoint>>(CONVERSATION_TRANSFER_SOURCES_PROJECTION_ID, async (current) => {
    const found = new Map<number, DurableLogCheckpoint>();
    const upper = lsnKey(through.lsn + 1);
    const scanAll = async (prefix: string, lt = prefix + "￿") => {
      const entries: { key: string; value: JsonValue }[] = [];
      for (let continuation: string | undefined, first = true; first || continuation; first = false) {
        const page = await current.scan({ gte: prefix, lt }, 64, continuation);
        entries.push(...page.entries);
        continuation = page.continuation;
      }
      return entries;
    };
    const collect = async (prefix: string) => {
      for (const { value } of await scanAll(prefix, prefix + upper)) {
        const checkpoint = value as unknown as DurableLogCheckpoint;
        if (checkpoint.lsn <= through.lsn) found.set(checkpoint.lsn, checkpoint);
      }
    };
    const conversation = sourceDigest("Conversation", conversationId);
    await collect(`e/${conversation}/`);
    for (const { value } of await scanAll(`ca/${conversation}/`)) {
      const relation = value as { assignmentId?: unknown; lsn?: unknown };
      if (typeof relation.assignmentId === "string" && typeof relation.lsn === "number" && relation.lsn <= through.lsn)
        await collect(`pa/${sourceDigest("Assignment", relation.assignmentId)}/`);
    }
    for (const { value } of await scanAll(`cc/${conversation}/`)) {
      const relation = value as { requestId?: unknown; lsn?: unknown };
      if (typeof relation.requestId === "string" && typeof relation.lsn === "number" && relation.lsn <= through.lsn)
        await collect(`cr/${sourceDigest("Request", relation.requestId)}/`);
    }
    return { kind: "return", value: found };
  })).value;
  const envelopes: CommitEnvelope<unknown>[] = [];
  // 按位置精确读：readEnvelopeAt 核对帧索引与 lsn，信封原样交给选择器，不重拼、不重算摘要
  for (const lsn of [...positions.keys()].sort((left, right) => left - right))
    envelopes.push(await log.readEnvelopeAt<unknown>(positions.get(lsn)!));
  return envelopes;
}
