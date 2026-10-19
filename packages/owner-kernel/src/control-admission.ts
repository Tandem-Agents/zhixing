import { Buffer } from "node:buffer";
import { currentMaintenanceAbortSignal, StorageMaintenanceCancelledError } from "@zhixing/core/resources";
import {
  artifactJsonIndex,
  AuthorityStorageError,
  DurableProjectionRecordBindingError,
  collectArtifactRefs,
  describeControlArtifactClosure,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveControlArtifactClosure,
  validateAdmittedControlEnvelope,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  ChannelResponderRef,
  CommitEnvelope,
  ControlEnvelope,
  ControlRecord,
  ControlRequest,
  ControlResult,
  IngressContext,
  JsonValue,
  LogicalRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  assertProtocolIdentifier,
  channelResponderPrincipal,
  MAX_PROTOCOL_IDENTIFIER_LENGTH,
  protocolDigest,
  validateChannelResponderRef,
  validateCancelBatchControlResultBody,
  validateIngressContext,
  validateAuthorityError,
} from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";
import {
  assertDeliveryEnvelopeCompanions,
  deliveryResolutionFactBindsRequest,
} from "@zhixing/core/delivery";

const MAX_AUTHORITY_PROJECTION_CACHES = 8;
const CONTROL_PROJECTION_ID = "control-admission-v1";
export const CONVERSATION_IDENTITY_PROJECTION_ID = "conversation-identities-v1";
const CONVERSATION_IDENTITY_PREFIX = "identity:";
const CONVERSATION_IDENTITY_REQUEST_PREFIX = "request:";

type InitialControlRequest = Extract<
  ControlRequest,
  { t: "input" | "session-create" }
>;
type ConversationControlRequest = Extract<
  ControlRequest,
  { t: "cancel" | "cancel-batch" | "session-write" | "uncertain-resolve" }
>;
type JobControlRequest = Extract<
  ControlRequest,
  { t: "job-run" | "job-cancel" | "uncertain-resolve" }
>;
type DeliveryControlRequest = Extract<ControlRequest, { t: "delivery-resolve" }>;
type GlobalControlRequest = Extract<ControlRequest, { t: "global-write" }>;
type CreateJobControlRequest = JobControlRequest;
type AuthorityControlRequest =
  | ConversationControlRequest
  | JobControlRequest
  | DeliveryControlRequest
  | GlobalControlRequest;
type AdmittedControlRequest = InitialControlRequest | AuthorityControlRequest;

export type InitialControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: InitialControlRequest;
};
export type ConversationControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: ConversationControlRequest;
};
export type JobControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: JobControlRequest;
};
export type DeliveryControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: DeliveryControlRequest;
};
export type GlobalControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: GlobalControlRequest;
};
export type AuthorityControlEnvelope =
  | ConversationControlEnvelope
  | JobControlEnvelope
  | DeliveryControlEnvelope
  | GlobalControlEnvelope;
type AdmittedControlEnvelope =
  | InitialControlEnvelope
  | AuthorityControlEnvelope;

export interface TrustedControlSource {
  readonly principal: ControlEnvelope["principal"];
  readonly ingress?: IngressContext;
}

export interface ControlApplicationPlan {
  readonly result: ControlResult;
  readonly authorityRevision: number;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
}

export interface AtomicControlApplicationPlan {
  readonly result: ControlResult;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
}

export interface AtomicControlApplicationContext<
  Envelope extends AdmittedControlEnvelope = AdmittedControlEnvelope,
> {
  readonly canonicalRequestId: string;
  readonly authorityPrefix: ProjectionTransactionContext;
  readonly envelope: Envelope;
  readonly ingress?: IngressContext;
}

type AdmittedControlRequestType = AdmittedControlRequest["t"];

type StoredControlAdmissionValue =
  | {
      readonly kind: "applied" | "replayed";
      readonly canonicalRequestId: string;
      readonly requestType: AdmittedControlRequestType;
      readonly storedResult: Stored<ControlResult>;
      readonly authorityRevision: number;
    }
  | {
      readonly kind: "rejected";
      readonly result: Extract<ControlResult, { status: "rejected" }>;
    };

type ControlTransactionValue =
  | StoredControlAdmissionValue
  | {
      readonly kind: "pending";
      readonly canonicalRequestId: string;
    }
  | {
      readonly kind: "alias";
      readonly canonicalRequestId: string;
      readonly requestType: AdmittedControlRequestType;
      readonly storedResult: Stored<ControlResult>;
      readonly authorityRevision: number;
    };

export type ControlAdmissionOutcome =
  | {
      readonly kind: "applied" | "replayed";
      readonly canonicalRequestId: string;
      readonly result: ControlResult;
      readonly authorityRevision: number;
      readonly commitLsn?: number;
  }
  | Extract<StoredControlAdmissionValue, { kind: "rejected" }>;

export type ControlAdmissionLookup =
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "received-pending";
      readonly canonicalRequestId: string;
    }
  | {
      readonly kind: "settled";
      readonly outcome: ControlAdmissionOutcome;
    };

interface StoredReference {
  readonly ref: ArtifactRef;
}

type Stored<T> = T | StoredReference;

interface PreparedStored<T> {
  readonly stored: Stored<T>;
  readonly references: readonly ArtifactRef[];
}

interface RequestProjection {
  readonly requestId: string;
  readonly requestType: AdmittedControlRequestType;
  readonly payloadDigest: string;
  readonly surfacePrincipal: string;
  readonly envelope: AdmittedControlEnvelope;
  readonly ingress?: IngressContext;
  readonly ingressKey?: string;
  storedResult?: Stored<ControlResult>;
  authorityRevision?: number;
}

interface IngressProjection {
  readonly requestId: string;
  readonly payloadDigest: string;
  readonly surfacePrincipal: string;
}

interface ControlProjection {
  readonly requests: Map<string, RequestProjection>;
  readonly ingresses: Map<string, IngressProjection>;
}

interface ControlProjectionDraft {
  readonly base: ControlProjection;
  readonly requests: Map<string, RequestProjection>;
  readonly ingresses: Map<string, IngressProjection>;
}

export interface CreateInitialControlEnvelopeInput {
  readonly requestId: string;
  readonly source: TrustedControlSource;
  readonly body: InitialControlRequest;
  readonly at?: string;
}

export function createInitialControlEnvelope(
  input: CreateInitialControlEnvelopeInput,
): InitialControlEnvelope {
  const source = snapshotTrustedSource(input.source);
  const body = snapshot(input.body, "Control request");
  const dependencyArtifacts = [
    ...describeControlArtifactClosure(body).dependencies,
  ];
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
    at,
    body,
  };
  const validated = snapshotAdmittedControlEnvelope(envelope);
  if (!isInitialControlEnvelope(validated)) {
    throw new TypeError("Initial control envelope requires input or session-create");
  }
  assertTrustedSourceMatches(validated, source);
  return validated;
}

export interface CreateConversationControlEnvelopeInput {
  readonly requestId: string;
  readonly source: TrustedControlSource;
  readonly body: ConversationControlRequest;
  readonly at?: string;
}

export function createConversationControlEnvelope(
  input: CreateConversationControlEnvelopeInput,
): ConversationControlEnvelope {
  const source = snapshotTrustedSource(input.source);
  if (source.ingress !== undefined) {
    throw new TypeError("Conversation control requests do not accept ingress context");
  }
  const body = snapshot(input.body, "Conversation control request");
  const dependencyArtifacts = [
    ...describeControlArtifactClosure(body).dependencies,
  ];
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
    at,
    body,
  };
  const validated = snapshotAdmittedControlEnvelope(envelope);
  if (!isConversationControlEnvelope(validated)) {
    throw new TypeError(
      "Conversation control envelope requires cancel, session-write, or uncertain-resolve",
    );
  }
  assertTrustedSourceMatches(validated, source);
  return validated;
}

export interface CreateJobControlEnvelopeInput {
  readonly requestId: string;
  readonly source: TrustedControlSource;
  readonly body: CreateJobControlRequest;
  readonly at?: string;
}

export function createJobControlEnvelope(
  input: CreateJobControlEnvelopeInput,
): JobControlEnvelope {
  const source = snapshotTrustedSource(input.source);
  const body = snapshot(input.body, "Job control request");
  const dependencyArtifacts = [
    ...describeControlArtifactClosure(body).dependencies,
  ];
  if (body.t === "job-run") {
    validateIngressContext(source.ingress ?? failMissingJobIngress());
  } else if (source.ingress !== undefined) {
    throw new TypeError("Only job-run control requests accept ingress context");
  }
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
    at,
    body,
  };
  const validated = snapshotAdmittedControlEnvelope(envelope);
  if (!isJobControlEnvelope(validated)) {
    throw new TypeError("Job control envelope requires a job authority request");
  }
  assertTrustedSourceMatches(validated, source);
  return validated;
}

export interface CreateDeliveryControlEnvelopeInput {
  readonly requestId: string;
  readonly source: TrustedControlSource;
  readonly body: DeliveryControlRequest;
  readonly at?: string;
}

export function createDeliveryControlEnvelope(
  input: CreateDeliveryControlEnvelopeInput,
): DeliveryControlEnvelope {
  const source = snapshotTrustedSource(input.source);
  if (source.ingress !== undefined) {
    throw new TypeError("Delivery control requests do not accept ingress context");
  }
  const body = snapshot(input.body, "Delivery control request");
  const dependencyArtifacts = [
    ...describeControlArtifactClosure(body).dependencies,
  ];
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
    at,
    body,
  };
  const validated = snapshotAdmittedControlEnvelope(envelope);
  if (!isDeliveryControlEnvelope(validated)) {
    throw new TypeError("Delivery control envelope requires delivery-resolve");
  }
  assertTrustedSourceMatches(validated, source);
  return validated;
}

export function channelSurfacePrincipal(responder: ChannelResponderRef): string {
  return channelResponderPrincipal(validateChannelResponderRef(responder));
}

export function createGlobalControlEnvelope(input: {
  readonly requestId: string;
  readonly source: TrustedControlSource;
  readonly body: GlobalControlRequest;
  readonly at?: string;
}): GlobalControlEnvelope {
  const source = snapshotTrustedSource(input.source);
  if (source.ingress !== undefined) {
    throw new TypeError("Global control requests do not accept ingress context");
  }
  const body = snapshot(input.body, "Global control request");
  const dependencyArtifacts = [...describeControlArtifactClosure(body).dependencies];
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
    at,
    body,
  };
  const validated = snapshotAdmittedControlEnvelope(envelope);
  if (!isGlobalControlEnvelope(validated)) {
    throw new TypeError("Global control envelope requires global-write");
  }
  assertTrustedSourceMatches(validated, source);
  return validated;
}

/**
 * Durable request and ingress idempotency for the control plane.
 * Initial requests can commit a prepared result, while domain-bound requests
 * atomically commit their control receipt and authority records.
 */
export class ControlAdmissionJournal {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #operations = new SerialTaskQueue();
  readonly #identities: ReturnType<AuthorityCommitLog['durableProjection']>;
  readonly #control: ReturnType<AuthorityCommitLog['durableProjection']>;
  #recovered = false;
  #writeInputsPrepared = false;
  readonly #authorityProjections = new Map<
    string,
    {
      readonly target: unknown;
      readonly cursor: ProjectionCursor;
    }
  >();

  constructor(log: AuthorityCommitLog, artifacts: ArtifactStore) {
    this.#log = log;
    this.#artifacts = artifacts;
    // 幂等历史按键驻磁盘；一次准入只读本次请求及其 ingress 规范记录。
    this.#control = registerControlAdmissionProjection(log, artifacts);
    log.registerCheckpointFlush?.(() => this.#control.flushCheckpoint?.());
    this.#identities = registerConversationIdentityProjection(log, artifacts);
  }

  /**
   * Enumerates durably applied session identities from the control owner itself.
   * Consumers use this projection instead of maintaining a second conversation
   * registry; artifact-backed results are materialized through the same store.
   */
  async listCreatedConversationIds(): Promise<readonly string[]> {
    const ids: string[] = [];
    let continuation: string | undefined;
    do {
      const page = await this.#identities.scan({ gte: CONVERSATION_IDENTITY_PREFIX, lt: CONVERSATION_IDENTITY_PREFIX + '\uffff' }, 128, continuation);
      for (const entry of page.entries) {
        const id = entry.key.slice(CONVERSATION_IDENTITY_PREFIX.length);
        if (!isPlainRecord(entry.value) || entry.value.conversationId !== id || Object.keys(entry.value).length !== 1) throw invalidControlRecord('Conversation identity projection is invalid');
        ids.push(id);
      }
      continuation = page.continuation;
    } while (continuation);
    return ids.sort();
  }

  async hasCreatedConversation(conversationId: string): Promise<boolean> {
    return conversationIdentityExistsAt(this.#identities, conversationId);
  }

  async lookup(input: {
    readonly envelope: AdmittedControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionLookup> {
    const envelope = snapshotAdmittedControlEnvelope(input.envelope);
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
    if (!this.#recovered) await this.#control.checkpoints();
    return this.#operations.run(async () => {
      const transaction = await this.#transact<
        StoredControlAdmissionValue
        | Extract<ControlTransactionValue, { kind: "pending" }>
        | undefined
      >(
        envelope,
        (state) => {
          const request = getRequest(state, envelope.requestId);
          if (!request) {
            return { kind: "return", value: undefined };
          }
          if (!sameRequestBinding(request, envelope)) {
            return noAppendConflict(
              "requestId is already bound to another control request",
            );
          }
          return request.storedResult
            ? replayWithoutAppend(request)
            : {
                kind: "return",
                value: {
                  kind: "pending",
                  canonicalRequestId: request.requestId,
                },
              };
        },
        [],
      );
      if (transaction.value === undefined) {
        return { kind: "absent" };
      }
      if (transaction.value.kind === "pending") {
        return {
          kind: "received-pending",
          canonicalRequestId: transaction.value.canonicalRequestId,
        };
      }
      return {
        kind: "settled",
        outcome: await materializeOutcome(transaction.value, this.#artifacts),
      };
    });
  }

  /** Read the original input outcome without replaying input or admission effects. */
  async inputReceipt(input: { readonly conversationId: string; readonly turnId: string; readonly surfacePrincipal: string }): Promise<import('@zhixing/core/conversation/application').ConversationInputReceipt> {
    const requestId = `input:${protocolDigest("ConversationInputIdentity", 1, { surfacePrincipal: input.surfacePrincipal, ingressId: input.turnId })}`;
    if (!this.#recovered) await this.#control.checkpoints();
    return this.#operations.run(async () => {
      const transaction = await this.#transact<StoredControlAdmissionValue | undefined>(requestId, (state) => {
        const request = getRequest(state, requestId);
        if (!request || request.surfacePrincipal !== input.surfacePrincipal || request.envelope.body.t !== 'input' ||
          request.envelope.body.conversationId !== input.conversationId || request.envelope.body.ingress.ingressId !== input.turnId || !request.storedResult) {
          return { kind: 'return', value: undefined };
        }
        return replayWithoutAppend(request);
      }, []);
      if (!transaction.value) return { status: 'unknown' };
      const outcome = await materializeOutcome(transaction.value, this.#artifacts);
      if (outcome.kind === 'rejected' || outcome.result.status === 'rejected') return { status: 'rejected' };
      if (outcome.result.body.t !== 'input') throw invalidControlRecord('Input receipt contains another control result');
      return { status: 'accepted', conversationId: input.conversationId, turnId: input.turnId, runId: outcome.result.body.runId };
    });
  }

  async apply(input: {
    readonly envelope: InitialControlEnvelope;
    readonly source: TrustedControlSource;
    /** Produces data for the authority commit; it must not apply side effects itself. */
    readonly prepare: (context: {
      readonly canonicalRequestId: string;
    }) => ControlApplicationPlan | Promise<ControlApplicationPlan>;
  }): Promise<ControlAdmissionOutcome> {
    const envelope = snapshotAdmittedControlEnvelope(input.envelope);
    if (!isInitialControlEnvelope(envelope)) {
      throw new TypeError("Initial control application rejects conversation control requests");
    }
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
    await this.prepareRecovery();
    return this.#operations.run(() =>
      this.#apply(envelope, source.ingress, input.prepare)
    );
  }

  async applyAuthority<
    State,
    Envelope extends AdmittedControlEnvelope,
  >(input: {
    readonly envelope: Envelope;
    readonly source: TrustedControlSource;
    readonly stream: string;
    readonly initial: State;
    /** Verified target prefix; control receipts keep their independent current watermark. */
    readonly targetBase?: { readonly state: State; readonly cursor: ProjectionCursor; readonly createState?: () => State;
      readonly readProjectionIds?: readonly string[]; readonly validateAtPrefix?: (context: ProjectionTransactionContext) => Promise<void> };
    readonly reducer: (
      state: State,
      record: LogicalRecord<unknown>,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => State | Promise<State>;
    readonly decide: (
      state: State,
      context: AtomicControlApplicationContext<Envelope>,
    ) => AtomicControlApplicationPlan | Promise<AtomicControlApplicationPlan>;
    readonly candidateReferences?: readonly ArtifactRef[];
    readonly companionStreams?: readonly string[];
    readonly readProjectionIds?: readonly string[];
    readonly observe?: (
      record: LogicalRecord<unknown>,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => void | Promise<void>;
    readonly prepareCompanions?: (
      state: State,
      context: AtomicControlApplicationContext<Envelope>,
      plan: AtomicControlApplicationPlan,
    ) => readonly LogicalRecord<unknown>[];
    readonly onCommitted?: (
      state: State,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => void;
    /** 所属 owner 接管已验证的状态与游标；接管后控制适配不再保留同一可变状态。 */
    readonly onProjected?: (state: State, cursor: ProjectionCursor) => void;
  }): Promise<ControlAdmissionOutcome> {
    const envelope = snapshotAdmittedControlEnvelope(input.envelope) as Envelope;
    if (envelope.body.t === "session-create") {
      throw new TypeError(
        "Atomic authority application rejects session-create control requests",
      );
    }
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
    if (input.targetBase && input.observe) throw new TypeError("A target prefix cannot skip an independent observer");
    assertIdentifier(input.stream, "Authority control target stream");
    if (input.stream === "control") {
      throw new TypeError("Authority control target stream cannot be control");
    }
    for (const stream of input.companionStreams ?? []) {
      assertIdentifier(stream, "Authority control companion stream");
      if (stream === "control" || stream === input.stream) {
        throw new TypeError("Authority control companion stream must be distinct");
      }
    }
    await this.prepareRecovery();
    return this.#operations.run(async () => {
      const preparedEnvelope = await prepareEnvelope(
        envelope,
        source.ingress,
        this.#artifacts,
      );
      const receipt = await this.#transact(
        envelope,
        (state) =>
          decideControlReceipt({
            state,
            envelope,
            ingress: source.ingress,
            storedEnvelope: preparedEnvelope.stored,
          }),
        preparedEnvelope.references,
      );
      if (receipt.value.kind === "rejected") return receipt.value;
      if (receipt.value.kind === "replayed") {
        return materializeOutcome(receipt.value, this.#artifacts);
      }
      if (receipt.value.kind !== "pending") {
        throw invalidControlRecord("Conversation control receipt is not pending");
      }
      return this.#completeAuthority({
        ...input,
        envelope,
        preparedEnvelope,
        canonicalRequestId: receipt.value.canonicalRequestId,
      });
    });
  }

  async #completeAuthority<
    State,
    Envelope extends AdmittedControlEnvelope,
  >(input: {
    readonly envelope: Envelope;
    readonly preparedEnvelope: PreparedStored<AdmittedControlEnvelope>;
    readonly canonicalRequestId: string;
    readonly stream: string;
    readonly initial: State;
    /** Verified target prefix; control receipts keep their independent current watermark. */
    readonly targetBase?: { readonly state: State; readonly cursor: ProjectionCursor; readonly createState?: () => State;
      readonly readProjectionIds?: readonly string[]; readonly validateAtPrefix?: (context: ProjectionTransactionContext) => Promise<void> };
    readonly reducer: (
      state: State,
      record: LogicalRecord<unknown>,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => State | Promise<State>;
    readonly decide: (
      state: State,
      context: AtomicControlApplicationContext<Envelope>,
    ) => AtomicControlApplicationPlan | Promise<AtomicControlApplicationPlan>;
    readonly candidateReferences?: readonly ArtifactRef[];
    readonly companionStreams?: readonly string[];
    readonly readProjectionIds?: readonly string[];
    readonly observe?: (
      record: LogicalRecord<unknown>,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => void | Promise<void>;
    readonly prepareCompanions?: (
      state: State,
      context: AtomicControlApplicationContext<Envelope>,
      plan: AtomicControlApplicationPlan,
    ) => readonly LogicalRecord<unknown>[];
    readonly onCommitted?: (
      state: State,
      commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
    ) => void;
    readonly onProjected?: (state: State, cursor: ProjectionCursor) => void;
  }): Promise<ControlAdmissionOutcome> {
    type CombinedProjection = {
      target: State;
    };
    const cached = this.#takeAuthorityProjection(input.stream) as
      | {
          readonly target: State;
          readonly cursor: ProjectionCursor;
        }
      | undefined;
    // The supplied owner basis belongs to its current import generation; a
    // numerically newer combined cache must not replace it.
    const targetBase = input.targetBase;
    const initial: CombinedProjection = {
      target: targetBase?.state ?? cached?.target ?? input.initial,
    };
    let candidateLsn: number | undefined;
    try {
      const transaction = await this.#log.transactProjection<
        CombinedProjection,
        unknown,
        StoredControlAdmissionValue
      >(
        initial,
        async (state, record, commit) => {
          if (targetBase?.validateAtPrefix && commit.lsn !== candidateLsn) return state;
          await input.observe?.(record, commit);
          if (record.stream === input.stream) {
            state.target = await input.reducer(state.target, record, commit);
          }
          return state;
        },
        async (state, authorityPrefix) => {
          await targetBase?.validateAtPrefix?.(authorityPrefix);
          candidateLsn = authorityPrefix.nextLsn;
          const control = await readControlIndexState(
            authorityPrefix.readProjection(CONTROL_PROJECTION_ID), input.canonicalRequestId, this.#artifacts,
          );
          const request = getRequest(control, input.canonicalRequestId);
          if (!request) {
            throw invalidControlRecord("Atomic control request has no received record");
          }
          if (!sameRequestBinding(request, input.envelope)) {
            throw invalidControlRecord("Atomic control request changed its durable binding");
          }
          if (request.storedResult) return replayWithoutAppend(request);

          const canonicalEnvelope = request.envelope as Envelope;

          const context: AtomicControlApplicationContext<Envelope> = {
            canonicalRequestId: input.canonicalRequestId,
            authorityPrefix,
            envelope: canonicalEnvelope,
            ...(request.ingress === undefined ? {} : { ingress: request.ingress }),
          };
          const plan = snapshot(
            await input.decide(state.target, context),
            "Atomic control application plan",
          );
          const result = snapshotControlResult(plan.result, canonicalEnvelope.body.t);
          const primaryEntries = snapshotAuthorityEntries(
            plan.authorityEntries ?? [],
          );
          const companionEntries = snapshotAuthorityEntries(
            input.prepareCompanions?.(state.target, context, plan) ?? [],
          );
          const authorityEntries = [...primaryEntries, ...companionEntries];
          const allowedStreams = new Set([
            input.stream,
            ...(input.companionStreams ?? []),
          ]);
          if (authorityEntries.some((entry) => !allowedStreams.has(entry.stream))) {
            throw new TypeError(
              "Atomic control plan may only append its target or declared companion streams",
            );
          }
          const authorityRevision = authorityPrefix.nextLsn;
          return {
            kind: "append",
            entries: [
              ...authorityEntries,
              appliedRecord(input.canonicalRequestId, result, authorityRevision),
            ],
            value: {
              kind: "applied",
              canonicalRequestId: input.canonicalRequestId,
              requestType: canonicalEnvelope.body.t,
              storedResult: result,
              authorityRevision,
            },
          };
        },
        {
          streams: [input.stream, ...(input.companionStreams ?? [])],
          // The combined wrapper is private. Mutable targets supply their
          // owner's draft factory; immutable targets retain the verified basis.
          createState: () => { candidateLsn = undefined; return { target: targetBase?.createState ? targetBase.createState() : initial.target }; },
          readProjectionIds: [...new Set([CONTROL_PROJECTION_ID, ...(input.readProjectionIds ?? []), ...(targetBase?.readProjectionIds ?? [])])],
          ...(targetBase ? { cursor: targetBase.cursor } : cached ? { cursor: cached.cursor } : {}),
          candidateReferences: collectArtifactRefs([
            ...input.preparedEnvelope.references,
            ...(input.candidateReferences ?? []),
          ]),
        },
      );
      if (input.onProjected) {
        try { input.onProjected(transaction.state.target, transaction.cursor); }
        catch { /* 派生缓存接管失败不改变已经耐久提交的结果。 */ }
      } else {
        this.#cacheAuthorityProjection(input.stream, {
          target: transaction.state.target,
          cursor: transaction.cursor,
        });
      }
      if (transaction.commit) {
        try {
          input.onCommitted?.(transaction.state.target, transaction.commit);
        } catch {
          // The authority commit is already durable; observer failure cannot change its result.
        }
      }
      return materializeOutcome(
        transaction.value,
        this.#artifacts,
        transaction.commit?.lsn,
      );
    } catch (error) {
      this.#authorityProjections.delete(input.stream);
      throw error;
    }
  }

  #takeAuthorityProjection(stream: string):
    | {
        readonly target: unknown;
        readonly cursor: ProjectionCursor;
      }
    | undefined {
    const cached = this.#authorityProjections.get(stream);
    if (!cached) return undefined;
    this.#authorityProjections.delete(stream);
    return cached;
  }

  #cacheAuthorityProjection(
    stream: string,
    cached: {
      readonly target: unknown;
      readonly cursor: ProjectionCursor;
    },
  ): void {
    this.#authorityProjections.set(stream, cached);
    while (this.#authorityProjections.size > MAX_AUTHORITY_PROJECTION_CACHES) {
      const oldest = this.#authorityProjections.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#authorityProjections.delete(oldest);
    }
  }

  async #apply(
    envelope: AdmittedControlEnvelope,
    ingress: IngressContext | undefined,
    prepare: (context: {
      readonly canonicalRequestId: string;
    }) => ControlApplicationPlan | Promise<ControlApplicationPlan>,
  ): Promise<ControlAdmissionOutcome> {
    const preparedEnvelope = await prepareEnvelope(
      envelope,
      ingress,
      this.#artifacts,
    );
    const receipt = await this.#transact(
      envelope,
      (state) =>
        decideControlReceipt({
          state,
          envelope,
          ingress,
          storedEnvelope: preparedEnvelope.stored,
        }),
      preparedEnvelope.references,
    );
    if (receipt.value.kind === "rejected") return receipt.value;
    if (receipt.value.kind === "replayed") {
      return materializeOutcome(receipt.value, this.#artifacts);
    }
    if (receipt.value.kind === "alias") {
      return this.#appendAlias(
        envelope,
        ingress,
        preparedEnvelope,
        receipt.value,
      );
    }
    if (receipt.value.kind !== "pending") {
      throw invalidControlRecord("Control receipt returned an invalid state");
    }
    const canonicalRequestId = receipt.value.canonicalRequestId;

    const plan = snapshot(
      await prepare({ canonicalRequestId }),
      "Control application plan",
    );
    const result = snapshotControlResult(plan.result, envelope.body.t);
    assertAuthorityRevision(plan.authorityRevision);
    const authorityEntries = snapshotAuthorityEntries(plan.authorityEntries ?? []);
    const preparedResult = await prepareResult(result, this.#artifacts);
    const completion = await this.#transact(
      envelope,
      (state) =>
        decideControlCompletion({
          state,
          envelope,
          ingress,
          storedEnvelope: preparedEnvelope.stored,
          canonicalRequestId,
          storedResult: preparedResult.stored,
          authorityRevision: plan.authorityRevision,
          authorityEntries,
        }),
      collectArtifactRefs([
        ...preparedEnvelope.references,
        ...preparedResult.references,
        ...authorityEntries,
      ]),
    );
    if (completion.value.kind === "alias") {
      return this.#appendAlias(
        envelope,
        ingress,
        preparedEnvelope,
        completion.value,
      );
    }
    if (completion.value.kind === "pending") {
      throw invalidControlRecord("Control completion remained pending");
    }
    return materializeOutcome(
      completion.value,
      this.#artifacts,
      completion.commit?.lsn,
    );
  }

  async #appendAlias(
    envelope: AdmittedControlEnvelope,
    ingress: IngressContext | undefined,
    preparedEnvelope: PreparedStored<AdmittedControlEnvelope>,
    alias: Extract<ControlTransactionValue, { kind: "alias" }>,
  ): Promise<ControlAdmissionOutcome> {
    const transaction = await this.#transact(
      envelope,
      (state) =>
        decideAppliedAlias({
          state,
          envelope,
          ingress,
          storedEnvelope: preparedEnvelope.stored,
          canonicalRequestId: alias.canonicalRequestId,
        }),
      collectArtifactRefs([
        ...preparedEnvelope.references,
        alias.storedResult,
      ]),
    );
    if (
      transaction.value.kind === "pending" ||
      transaction.value.kind === "alias"
    ) {
      throw invalidControlRecord("Applied ingress alias did not reach a terminal result");
    }
    return materializeOutcome(
      transaction.value,
      this.#artifacts,
      transaction.commit?.lsn,
    );
  }


  /** 索引沿自己的耐久游标恢复，不再把全部控制历史物化成进程内 Map。 */
  async prepareRecovery(): Promise<void> {
    if (this.#writeInputsPrepared) return;
    if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
    // Both fixed projections consume control writes, including job controls.
    // Finish their candidates before the caller enters its domain coordinator.
    if (this.#log.prepareProjections) {
      await this.#log.prepareProjections([CONTROL_PROJECTION_ID, CONVERSATION_IDENTITY_PROJECTION_ID]);
    } else {
      await this.#control.checkpoints();
      await this.#identities.checkpoints();
    }
    if (this.#control.flushCheckpoint) await this.#control.flushCheckpoint();
    else await this.#control.checkpoints();
    if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
    this.#recovered = true;
    this.#writeInputsPrepared = true;
  }

  get hasRecoveredProjection(): boolean { return this.#recovered; }

  async #transact(
    subject: AdmittedControlEnvelope | string,
    decide: (state: ControlProjectionDraft) => ProjectionTransactionDecision<unknown, ControlTransactionValue>,
    candidateReferences: readonly ArtifactRef[],
  ): Promise<{ readonly value: ControlTransactionValue; readonly commit?: CommitEnvelope<unknown> }>;
  async #transact<Value>(
    subject: AdmittedControlEnvelope | string,
    decide: (state: ControlProjectionDraft) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[],
  ): Promise<{ readonly value: Value; readonly commit?: CommitEnvelope<unknown> }>;
  async #transact<Value>(
    subject: AdmittedControlEnvelope | string,
    decide: (state: ControlProjectionDraft) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[],
  ) {
    const transaction = await this.#log.transactDurableProjection<unknown, Value>(
      CONTROL_PROJECTION_ID,
      async (current) => decide(await readControlIndexState(current, subject, this.#artifacts)),
      { candidateReferences },
    );
    this.#recovered = true;
    return transaction;
  }
}

/** exact 主记录保留完整绑定，ingress 二级记录只指向规范请求。 */
function controlRequestKey(requestId: string): string { return `request:${requestId}`; }
function controlIngressKey(key: string): string { return `ingress:${protocolDigest("ControlIngressIndex", 1, key)}`; }

async function readControlIndexState(
  current: DurableProjectionReadContext,
  subject: AdmittedControlEnvelope | string,
  artifacts: ArtifactStore,
): Promise<ControlProjectionDraft> {
  const state = beginProjectionDraft(emptyProjection());
  const requestId = typeof subject === "string" ? subject : subject.requestId;
  const request = await readIndexedControlRequest(current, requestId, artifacts);
  if (request) state.base.requests.set(requestId, request);
  const key = typeof subject === "string" ? request?.ingressKey : ingressKey(subject);
  if (key) {
    const indexed = await current.get(controlIngressKey(key));
    if (indexed !== undefined) {
      if (!isPlainRecord(indexed) || indexed.ingressKey !== key || typeof indexed.requestId !== "string" ||
          Object.keys(indexed).sort().join(",") !== "ingressKey,requestId") {
        throw new DurableProjectionRecordBindingError("Control ingress index binding is invalid");
      }
      const canonical = indexed.requestId === requestId ? request : await readIndexedControlRequest(current, indexed.requestId, artifacts);
      if (!canonical || canonical.ingressKey !== key) {
        throw new DurableProjectionRecordBindingError("Control ingress index has no matching canonical request");
      }
      state.base.requests.set(canonical.requestId, canonical);
      state.base.ingresses.set(key, ingressProjection(canonical));
    }
  }
  return state;
}

async function readIndexedControlRequest(
  current: DurableProjectionReadContext,
  requestId: string,
  artifacts: ArtifactStore,
): Promise<RequestProjection | undefined> {
  const value = await current.get(controlRequestKey(requestId));
  if (value === undefined) return undefined;
  if (!isPlainRecord(value) || value.requestId !== requestId) {
    throw new DurableProjectionRecordBindingError("Control request index identity is invalid");
  }
  let storedEnvelope: Stored<AdmittedControlEnvelope>;
  try { storedEnvelope = snapshotStored<AdmittedControlEnvelope>(value.envelope); }
  catch { throw new DurableProjectionRecordBindingError("Control request index envelope is invalid"); }
  // 物理读取和准入失败保留自身错误分类，不能把压力误当派生索引损坏而整份重建。
  const loaded = await loadStored(storedEnvelope, artifacts, "ControlEnvelope");
  try {
    const envelope = snapshotAdmittedControlEnvelope(loaded);
    if (envelope.requestId !== requestId) throw new Error("envelope identity");
    const ingress = value.ingress === undefined ? undefined : validateIngressContext(value.ingress as unknown as IngressContext);
    assertDurableIngressMatches(envelope, ingress);
    const expected = requestProjection(envelope, ingress);
    if (value.storedResult !== undefined) {
      expected.storedResult = snapshotStored<ControlResult>(value.storedResult);
      assertAuthorityRevision(value.authorityRevision);
      expected.authorityRevision = value.authorityRevision as number;
    }
    if (canonicalize({ ...expected, envelope: storedEnvelope }) !== canonicalize(value)) throw new Error("request binding");
    return expected;
  } catch {
    throw new DurableProjectionRecordBindingError("Control request index binding is invalid");
  }
}

async function reduceControlIndex(
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
  artifacts: ArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations = new Map<string, DurableProjectionMutation>();
  const overlay: DurableProjectionReadContext = {
    get: async (key) => {
      const changed = mutations.get(key);
      return changed ? changed.kind === "put" ? changed.value : undefined : current.get(key);
    },
    scan: (range, limit, continuation) => current.scan(range, limit, continuation),
  };
  for (const record of envelope.entries) {
    if (record.stream !== "control") continue;
    const body = record.body;
    let subject: AdmittedControlEnvelope | string | undefined;
    if (isPlainRecord(body) && body.t === "received") {
      subject = snapshotAdmittedControlEnvelope(await loadStored(
        snapshotStored<AdmittedControlEnvelope>(body.envelope), artifacts, "ControlEnvelope",
      ));
    } else if (isPlainRecord(body) && body.t === "applied" && typeof body.requestId === "string") {
      subject = body.requestId;
    }
    const state = subject === undefined ? beginProjectionDraft(emptyProjection()) : await readControlIndexState(overlay, subject, artifacts);
    await reduceControlProjection(state, record, envelope, artifacts);
    for (const [id, request] of state.requests) {
      const key = controlRequestKey(id);
      const previous = await overlay.get(key);
      const storedEnvelope = isPlainRecord(body) && body.t === "received" && body.requestId === id
        ? snapshotStored<AdmittedControlEnvelope>(body.envelope)
        : isPlainRecord(previous) ? snapshotStored<AdmittedControlEnvelope>(previous.envelope) : undefined;
      if (!storedEnvelope) throw new DurableProjectionRecordBindingError("Control request index lost its envelope reference");
      // 外置大输入继续保留CAS引用，不因派生索引的单值预算增加业务输入上限。
      mutations.set(key, { kind: "put", key, value: { ...request, envelope: storedEnvelope } as unknown as JsonValue });
    }
    for (const [ingress, request] of state.ingresses) {
      const key = controlIngressKey(ingress);
      mutations.set(key, { kind: "put", key, value: { ingressKey: ingress, requestId: request.requestId } });
    }
  }
  return [...mutations.values()];
}

/** Source control pairing shares the exact request/result/ingress rules. A
 * source conversation cannot import delivery/global control authority. */
export async function validateImportedConversationControl(input: {
  group: import('./conversation-base-source.js').AuthenticatedConversationFacts;
  record: LogicalRecord<unknown>; artifacts: ArtifactStore;
  received(requestId: string): Promise<LogicalRecord<unknown> | undefined>;
  applied(requestId: string): Promise<LogicalRecord<unknown> | undefined>;
  ingress(key: string): Promise<LogicalRecord<unknown> | undefined>;
}): Promise<{ requestId: string; ingressKey?: string; received: boolean; applied: boolean }> {
  const { isAuthenticatedConversationFacts } = await import('./conversation-base-source.js');
  if (!isAuthenticatedConversationFacts(input.group) || !input.group.entries.includes(input.record)) throw new TypeError('Imported control has no authenticated source');
  const body = input.record.body;
  if (!isPlainRecord(body) || (body.t !== 'received' && body.t !== 'applied') || typeof body.requestId !== 'string') throw invalidControlRecord('Invalid imported conversation control');
  const previous = await input.received(body.requestId);
  const received = body.t === 'received' ? input.record : previous;
  const receivedBody = received?.body;
  if (!isPlainRecord(receivedBody)) throw invalidControlRecord('Imported control has no received predecessor');
  const envelope = snapshotAdmittedControlEnvelope(await loadStored(snapshotStored<AdmittedControlEnvelope>(receivedBody.envelope), input.artifacts, 'ControlEnvelope'));
  const request = envelope.body;
  let id = 'conversationId' in request ? request.conversationId : 'ref' in request && request.ref.execution === 'conversation' ? request.ref.conversationId : undefined;
  if (request.t === 'session-create') {
    // Creation acquires its conversation identity in the applied result. The
    // received half stays pending until that exact pair is verified; frozen
    // source validation rejects any unmatched received request.
    if (body.t === 'applied') {
      const result = await loadStored(snapshotStored<ControlResult>(body.result), input.artifacts, 'ControlResult');
      id = result.status === 'ok' && result.body.t === 'session-create' ? result.body.conversationId : undefined;
    }
  }
  if (!(request.t === 'session-create' && body.t === 'received') && id !== input.group.source.manifest.conversationId)
    throw invalidControlRecord('Imported control belongs to another authority domain');
  const key = ingressKey(envelope), priorIngress = key ? await input.ingress(key) : undefined;
  const draft = beginProjectionDraft(emptyProjection());
  if (priorIngress && priorIngress !== previous) await reduceControlDomain(draft, priorIngress, input.artifacts, undefined);
  if (previous) await reduceControlDomain(draft, previous, input.artifacts, undefined);
  const applied = previous && await input.applied(body.requestId);
  if (applied) await reduceControlDomain(draft, applied, input.artifacts, undefined);
  await reduceControlDomain(draft, input.record, input.artifacts, undefined);
  return { requestId: body.requestId, ...(key ? { ingressKey: key } : {}), received: body.t === 'received', applied: body.t === 'applied' || !!applied };
}

function emptyProjection(): ControlProjection {
  return { requests: new Map(), ingresses: new Map() };
}

function beginProjectionDraft(base: ControlProjection): ControlProjectionDraft {
  return { base, requests: new Map(), ingresses: new Map() };
}

function getRequest(
  state: ControlProjectionDraft,
  requestId: string,
): RequestProjection | undefined {
  return state.requests.get(requestId) ?? state.base.requests.get(requestId);
}

function editRequest(
  state: ControlProjectionDraft,
  requestId: string,
): RequestProjection | undefined {
  const changed = state.requests.get(requestId);
  if (changed) return changed;
  const current = state.base.requests.get(requestId);
  if (!current) return undefined;
  const editable = { ...current };
  state.requests.set(requestId, editable);
  return editable;
}

function getIngress(
  state: ControlProjectionDraft,
  key: string,
): IngressProjection | undefined {
  return state.ingresses.get(key) ?? state.base.ingresses.get(key);
}

async function reduceControlProjection(
  state: ControlProjectionDraft,
  record: LogicalRecord<unknown>,
  commit: import("@zhixing/core/contracts").CommitEnvelope<unknown>,
  artifacts: ArtifactStore,
): Promise<ControlProjectionDraft> {
  const deliveryResolution = assertDeliveryEnvelopeCompanions(commit);
  return reduceControlDomain(state, record, artifacts, deliveryResolution);
}

async function reduceControlDomain(state: ControlProjectionDraft, record: LogicalRecord<unknown>, artifacts: ArtifactStore,
  deliveryResolution: ReturnType<typeof assertDeliveryEnvelopeCompanions>): Promise<ControlProjectionDraft> {
  const body = record.body;
  if (
    isPlainRecord(body) &&
    (
      body.t === "asset-grant-issued" ||
      body.t === "asset-grant-revoked" ||
      body.t === "authority-time-frontier"
    )
  ) {
    assertSurfaceAssetControlRecord(body);
    return state;
  }
  if (!isPlainRecord(body) || (body.t !== "received" && body.t !== "applied")) {
    throw invalidControlRecord("Control stream contains an unknown record");
  }

  if (body.t === "received") {
    assertAllowedKeys(body, ["envelope", "ingress", "requestId", "t"], "received record");
    for (const key of ["envelope", "requestId", "t"] as const) {
      if (!(key in body)) throw invalidControlRecord("Control received record is incomplete");
    }
    assertIdentifier(body.requestId, "Control received requestId");
    const storedEnvelope = snapshotStored<AdmittedControlEnvelope>(body.envelope);
    const envelope = snapshotAdmittedControlEnvelope(
      await loadStored(storedEnvelope, artifacts, "ControlEnvelope"),
    );
    if (envelope.requestId !== body.requestId) {
      throw invalidControlRecord("Control received requestId does not match its envelope");
    }
    const ingress = body.ingress === undefined
      ? undefined
      : validateIngressContext(body.ingress as IngressContext);
    assertDurableIngressMatches(envelope, ingress);
    const existing = getRequest(state, envelope.requestId);
    if (existing) {
      if (!sameRequestBinding(existing, envelope)) {
        throw invalidControlRecord("A control requestId has conflicting durable payloads");
      }
      return state;
    }

    const request = requestProjection(envelope, ingress);
    state.requests.set(envelope.requestId, request);
    const key = ingressKey(envelope);
    if (key) {
      const indexed = getIngress(state, key);
      if (indexed && !sameIngressBinding(indexed, envelope)) {
        throw invalidControlRecord("An ingress key has conflicting durable payloads");
      }
      if (!indexed) {
        state.ingresses.set(key, ingressProjection(request));
      }
    }
    return state;
  }

  assertExactKeys(
    body,
    ["authorityRevision", "requestId", "result", "t"],
    "applied record",
  );
  assertIdentifier(body.requestId, "Control applied requestId");
  assertAuthorityRevision(body.authorityRevision);
  const request = editRequest(state, body.requestId);
  if (!request) {
    throw invalidControlRecord("Control applied record has no received predecessor");
  }
  if (request.storedResult) {
    throw invalidControlRecord("Control request has more than one applied record");
  }
  const storedResult = snapshotStored<ControlResult>(body.result);
  const appliedResult = snapshotControlResult(
    await loadStored(storedResult, artifacts, "ControlResult"),
    request.requestType,
  );
  if (
    request.requestType === "delivery-resolve" &&
    appliedResult.status === "ok" &&
    appliedResult.body.t === "delivery-resolve" &&
    appliedResult.body.applied
  ) {
    const resolutionRequest = request.envelope.body;
    if (
      resolutionRequest.t !== "delivery-resolve" ||
      !deliveryResolution ||
      !deliveryResolutionFactBindsRequest(deliveryResolution.fact, {
        itemId: resolutionRequest.itemId,
        attempt: resolutionRequest.attempt,
        anchorEpoch: resolutionRequest.anchorEpoch,
        openFactDigest: resolutionRequest.openFactDigest,
        decision: resolutionRequest.decision,
        by: request.envelope.principal.surfacePrincipal,
      })
    ) {
      throw invalidControlRecord(
        "Delivery resolution does not bind its durable control request",
      );
    }
  }
  request.storedResult = storedResult;
  request.authorityRevision = body.authorityRevision;

  const key = request.ingressKey;
  if (key) {
    const indexed = getIngress(state, key);
    if (!indexed || !sameIngressProjection(indexed, request)) {
      throw invalidControlRecord("Control applied record has no matching ingress index");
    }
  }
  return state;
}

function decideControlReceipt(input: {
  readonly state: ControlProjectionDraft;
  readonly envelope: AdmittedControlEnvelope;
  readonly ingress?: IngressContext;
  readonly storedEnvelope: Stored<AdmittedControlEnvelope>;
}) {
  const byRequest = getRequest(input.state, input.envelope.requestId);
  if (byRequest) {
    if (!sameRequestBinding(byRequest, input.envelope)) {
      return noAppendConflict("requestId is already bound to another control request");
    }
    if (byRequest.storedResult) {
      return replayWithoutAppend(byRequest);
    }
    return pendingWithoutAppend(byRequest.requestId);
  }

  const key = ingressKey(input.envelope);
  const byIngress = key ? getIngress(input.state, key) : undefined;
  if (byIngress) {
    if (!sameIngressBinding(byIngress, input.envelope)) {
      return noAppendConflict("ingressId is already bound to another input");
    }
    const canonical = getRequest(input.state, byIngress.requestId);
    if (!canonical) {
      throw invalidControlRecord("Ingress index points to a missing control request");
    }
    if (canonical.storedResult) {
      return aliasWithoutAppend(canonical);
    }
    return pendingWithoutAppend(canonical.requestId);
  }

  return {
    kind: "append" as const,
    entries: [
      receivedRecord(
        input.envelope.requestId,
        input.storedEnvelope,
        input.ingress,
      ),
    ],
    value: {
      kind: "pending" as const,
      canonicalRequestId: input.envelope.requestId,
    },
  };
}

function decideControlCompletion(input: {
  readonly state: ControlProjectionDraft;
  readonly envelope: AdmittedControlEnvelope;
  readonly ingress?: IngressContext;
  readonly storedEnvelope: Stored<AdmittedControlEnvelope>;
  readonly canonicalRequestId: string;
  readonly storedResult: Stored<ControlResult>;
  readonly authorityRevision: number;
  readonly authorityEntries: readonly LogicalRecord<unknown>[];
}) {
  const canonical = getRequest(input.state, input.canonicalRequestId);
  if (!canonical) {
    throw invalidControlRecord("Pending control request is missing its received record");
  }
  assertCompletionTargetsCanonical(canonical, input.envelope);
  if (canonical.storedResult) {
    return input.envelope.requestId === canonical.requestId
      ? replayWithoutAppend(canonical)
      : aliasWithoutAppend(canonical);
  }

  const alias = input.envelope.requestId !== canonical.requestId;
  return {
    kind: "append" as const,
    entries: [
      ...input.authorityEntries,
      appliedRecord(
        canonical.requestId,
        input.storedResult,
        input.authorityRevision,
      ),
      ...(alias
        ? [
            receivedRecord(
              input.envelope.requestId,
              input.storedEnvelope,
              input.ingress,
            ),
            appliedRecord(
              input.envelope.requestId,
              input.storedResult,
              input.authorityRevision,
            ),
          ]
        : []),
    ],
    value: {
      kind: "applied" as const,
      canonicalRequestId: canonical.requestId,
      requestType: canonical.requestType,
      storedResult: input.storedResult,
      authorityRevision: input.authorityRevision,
    },
  };
}

function decideAppliedAlias(input: {
  readonly state: ControlProjectionDraft;
  readonly envelope: AdmittedControlEnvelope;
  readonly ingress?: IngressContext;
  readonly storedEnvelope: Stored<AdmittedControlEnvelope>;
  readonly canonicalRequestId: string;
}) {
  const byRequest = getRequest(input.state, input.envelope.requestId);
  if (byRequest) {
    if (!sameRequestBinding(byRequest, input.envelope)) {
      return noAppendConflict("requestId is already bound to another control request");
    }
    if (!byRequest.storedResult) {
      throw invalidControlRecord("Ingress alias request is pending unexpectedly");
    }
    return replayWithoutAppend(byRequest);
  }
  const canonical = getRequest(input.state, input.canonicalRequestId);
  if (!canonical?.storedResult || canonical.authorityRevision === undefined) {
    throw invalidControlRecord("Applied ingress projection is incomplete");
  }
  assertCompletionTargetsCanonical(canonical, input.envelope);
  return {
    kind: "append" as const,
    entries: [
      receivedRecord(
        input.envelope.requestId,
        input.storedEnvelope,
        input.ingress,
      ),
      appliedRecord(
        input.envelope.requestId,
        canonical.storedResult,
        canonical.authorityRevision,
      ),
    ],
    value: storedOutcome("replayed", canonical),
  };
}

function receivedRecord(
  requestId: string,
  envelope: Stored<AdmittedControlEnvelope>,
  ingress?: IngressContext,
): LogicalRecord<ControlRecord> {
  return {
    stream: "control",
    body: {
      t: "received",
      requestId,
      envelope,
      ...(ingress === undefined ? {} : { ingress }),
    },
  };
}

function appliedRecord(
  requestId: string,
  result: Stored<ControlResult>,
  authorityRevision: number,
): LogicalRecord<ControlRecord> {
  return {
    stream: "control",
    body: { t: "applied", requestId, result, authorityRevision },
  };
}

function pendingWithoutAppend(canonicalRequestId: string) {
  return {
    kind: "return" as const,
    value: { kind: "pending" as const, canonicalRequestId },
  };
}

function storedOutcome(
  kind: "applied" | "replayed",
  request: RequestProjection,
): Extract<StoredControlAdmissionValue, { kind: "applied" | "replayed" }> {
  if (!request.storedResult || request.authorityRevision === undefined) {
    throw invalidControlRecord("Applied request projection is incomplete");
  }
  return {
    kind,
    canonicalRequestId: request.requestId,
    requestType: request.requestType,
    storedResult: request.storedResult,
    authorityRevision: request.authorityRevision,
  };
}

function replayWithoutAppend(request: RequestProjection) {
  return { kind: "return" as const, value: storedOutcome("replayed", request) };
}

function aliasWithoutAppend(request: RequestProjection) {
  const outcome = storedOutcome("replayed", request);
  return { kind: "return" as const, value: { ...outcome, kind: "alias" as const } };
}

function noAppendConflict(message: string) {
  return {
    kind: "return" as const,
    value: {
      kind: "rejected" as const,
      result: idempotencyConflict(message),
    },
  };
}

function idempotencyConflict(
  message: string,
): Extract<ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: {
      code: "idempotency-conflict",
      message,
      retryable: false,
    },
  };
}

function ingressProjection(request: RequestProjection): IngressProjection {
  return {
    requestId: request.requestId,
    payloadDigest: request.payloadDigest,
    surfacePrincipal: request.surfacePrincipal,
  };
}

function requestProjection(
  envelope: AdmittedControlEnvelope,
  ingress?: IngressContext,
): RequestProjection {
  const key = ingressKey(envelope);
  return {
    requestId: envelope.requestId,
    requestType: envelope.body.t,
    payloadDigest: envelope.payloadDigest,
    surfacePrincipal: envelope.principal.surfacePrincipal,
    envelope: snapshot(envelope, "Control request envelope"),
    ...(ingress === undefined ? {} : { ingress: snapshot(ingress, "Control ingress") }),
    ...(key ? { ingressKey: key } : {}),
  };
}

function ingressKey(envelope: AdmittedControlEnvelope): string | undefined {
  if (envelope.body.t !== "input") return undefined;
  return canonicalize([
    envelope.principal.surfacePrincipal,
    envelope.body.ingress.ingressId,
  ]);
}

function sameRequestBinding(
  left: RequestProjection,
  right: AdmittedControlEnvelope,
): boolean {
  return (
    left.requestType === right.body.t &&
    left.payloadDigest === right.payloadDigest &&
    left.surfacePrincipal === right.principal.surfacePrincipal
  );
}

function sameIngressBinding(
  indexed: IngressProjection,
  envelope: AdmittedControlEnvelope,
): boolean {
  return (
    indexed.payloadDigest === envelope.payloadDigest &&
    indexed.surfacePrincipal === envelope.principal.surfacePrincipal
  );
}

function sameIngressProjection(
  indexed: IngressProjection,
  request: RequestProjection,
): boolean {
  return (
    indexed.payloadDigest === request.payloadDigest &&
    indexed.surfacePrincipal === request.surfacePrincipal
  );
}

function assertCompletionTargetsCanonical(
  canonical: RequestProjection,
  envelope: AdmittedControlEnvelope,
): void {
  if (envelope.requestId === canonical.requestId) {
    if (!sameRequestBinding(canonical, envelope)) {
      throw invalidControlRecord("Pending request changed its durable binding");
    }
    return;
  }
  const key = ingressKey(envelope);
  if (
    key === undefined ||
    key !== canonical.ingressKey ||
    canonical.requestType !== "input" ||
    !sameRequestBinding(canonical, envelope)
  ) {
    throw invalidControlRecord("Ingress retry does not match its canonical request");
  }
}

async function materializeOutcome(
  value: StoredControlAdmissionValue,
  artifacts: ArtifactStore,
  commitLsn?: number,
): Promise<ControlAdmissionOutcome> {
  if (value.kind === "rejected") return value;
  const result = snapshotControlResult(
    await loadStored(value.storedResult, artifacts, "ControlResult"),
    value.requestType,
  );
  return {
    kind: value.kind,
    canonicalRequestId: value.canonicalRequestId,
    result,
    authorityRevision: value.authorityRevision,
    ...(commitLsn === undefined ? {} : { commitLsn }),
  };
}

async function prepareEnvelope(
  envelope: AdmittedControlEnvelope,
  ingress: IngressContext | undefined,
  artifacts: ArtifactStore,
): Promise<PreparedStored<AdmittedControlEnvelope>> {
  const closure = await resolveControlArtifactClosure(envelope, artifacts);
  const inline: ControlRecord = {
    t: "received",
    requestId: envelope.requestId,
    envelope,
    ...(ingress === undefined ? {} : { ingress }),
  };
  const prepared = await prepareStored(envelope, inline, artifacts);
  assertControlRecordFits(
    receivedRecord(envelope.requestId, prepared.stored, ingress).body,
  );
  return {
    stored: prepared.stored,
    references: collectArtifactRefs([
      prepared.references,
      closure.references,
    ]),
  };
}

async function prepareResult(
  result: ControlResult,
  artifacts: ArtifactStore,
): Promise<PreparedStored<ControlResult>> {
  const inline: ControlRecord = {
    t: "applied",
    requestId: "\u0800".repeat(MAX_PROTOCOL_IDENTIFIER_LENGTH),
    result,
    authorityRevision: 0,
  };
  return prepareStored(result, inline, artifacts);
}

async function prepareStored<T>(
  value: T,
  containingRecord: ControlRecord,
  artifacts: ArtifactStore,
): Promise<PreparedStored<T>> {
  if (
    Buffer.byteLength(canonicalize(containingRecord), "utf8") <=
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    return { stored: value, references: collectArtifactRefs(value) };
  }
  const ref = await artifacts.put(Buffer.from(canonicalize(value), "utf8"));
  return {
    stored: { ref },
    references: [ref, ...collectArtifactRefs(value)],
  };
}

export async function loadStored<T>(
  stored: Stored<T>,
  artifacts: ArtifactStore,
  label: string,
): Promise<T> {
  if (!isStoredReference(stored)) return stored;
  const bytes = await artifacts.get(stored.ref);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} artifact is not valid JSON`,
      { cause: error },
    );
  }
  if (canonicalize(parsed) !== Buffer.from(bytes).toString("utf8")) {
    throw invalidControlRecord(`${label} artifact is not canonical`);
  }
  return parsed as T;
}

function snapshotAdmittedControlEnvelope(value: unknown): AdmittedControlEnvelope {
  return validateAdmittedControlEnvelope(value) as AdmittedControlEnvelope;
}

function isInitialControlEnvelope(
  envelope: AdmittedControlEnvelope,
): envelope is InitialControlEnvelope {
  return envelope.body.t === "input" || envelope.body.t === "session-create";
}

function isConversationControlEnvelope(
  envelope: AdmittedControlEnvelope,
): envelope is ConversationControlEnvelope {
  return (
    envelope.body.t === "cancel" ||
    envelope.body.t === "cancel-batch" ||
    envelope.body.t === "session-write" ||
    (envelope.body.t === "uncertain-resolve" &&
      envelope.body.ref.execution === "conversation")
  );
}

function isJobControlEnvelope(
  envelope: AdmittedControlEnvelope,
): envelope is JobControlEnvelope {
  return (
    envelope.body.t === "job-run" ||
    envelope.body.t === "job-cancel" ||
    (envelope.body.t === "uncertain-resolve" &&
      envelope.body.ref.execution === "job")
  );
}

function isDeliveryControlEnvelope(
  envelope: AdmittedControlEnvelope,
): envelope is DeliveryControlEnvelope {
  return envelope.body.t === "delivery-resolve";
}

export function registerConversationIdentityProjection(
  log: AuthorityCommitLog,
  artifacts: ArtifactStore,
) {
  return log.durableProjection<ControlRecord>({
    projectionId: CONVERSATION_IDENTITY_PROJECTION_ID,
    inputs: { streams: ["control"] },
    reducerVersion: 2,
    reduce: (envelope, current) =>
      reduceConversationIdentityProjection(envelope, current, artifacts),
  });
}

export async function conversationIdentityExistsAt(
  projection: DurableProjectionReadContext,
  conversationId: string,
): Promise<boolean> {
  const value = await projection.get(conversationIdentityKey(conversationId));
  if (value === undefined) return false;
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "conversationId" ||
    value.conversationId !== conversationId
  ) {
    throw invalidControlRecord("Conversation identity projection is invalid");
  }
  return true;
}

async function reduceConversationIdentityProjection(
  envelope: CommitEnvelope<ControlRecord>,
  current: DurableProjectionReadContext,
  artifacts: ArtifactStore,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const get = (key: string) => overlay.has(key) ? overlay.get(key) : current.get(key);
  const put = (key: string, value: JsonValue) => {
    overlay.set(key, value);
    mutations.push({ kind: "put" as const, key, value });
  };
  const tombstone = (key: string) => {
    overlay.set(key, undefined);
    mutations.push({ kind: "tombstone" as const, key });
  };
  for (const entry of envelope.entries) {
    if (entry.stream !== "control") continue;
    if (entry.body.t === "received") {
      const stored = snapshotStored<AdmittedControlEnvelope>(entry.body.envelope);
      if ('ref' in stored) {
        const json = artifactJsonIndex(artifacts);
        while (!(await json.prepare(stored.ref)).ready) await new Promise<void>(setImmediate);
        if (await json.value(stored.ref, ['body', 't'], 128) !== 'session-create') continue;
      } else if (stored.body.t !== 'session-create') continue;
      const admitted = snapshotAdmittedControlEnvelope(
        await loadStored(
          snapshotStored<AdmittedControlEnvelope>(entry.body.envelope),
          artifacts,
          "ControlEnvelope",
        ),
      );
      if (admitted.body.t === "session-create") {
        put(conversationIdentityRequestKey(entry.body.requestId), {
          requestId: admitted.requestId,
        });
      }
      continue;
    }
    if (entry.body.t !== "applied") continue;
    const requestKey = conversationIdentityRequestKey(entry.body.requestId);
    const request = await get(requestKey);
    if (request === undefined) continue;
    if (
      !isPlainRecord(request) ||
      Object.keys(request).sort().join(",") !== "requestId" ||
      request.requestId !== entry.body.requestId
    ) {
      throw invalidControlRecord("Conversation identity request projection is invalid");
    }
    const result = await loadStored(
      snapshotStored<ControlResult>(entry.body.result),
      artifacts,
      "ControlResult",
    );
    if (result.status === "ok") {
      if (result.body.t !== "session-create") {
        throw invalidControlRecord("Conversation identity result does not bind its request");
      }
      put(conversationIdentityKey(result.body.conversationId), {
        conversationId: result.body.conversationId,
      });
    }
    tombstone(requestKey);
  }
  return mutations;
}

function conversationIdentityKey(conversationId: string): string {
  return `${CONVERSATION_IDENTITY_PREFIX}${conversationId}`;
}

function conversationIdentityRequestKey(requestId: string): string {
  return `${CONVERSATION_IDENTITY_REQUEST_PREFIX}${requestId}`;
}

function isGlobalControlEnvelope(
  envelope: AdmittedControlEnvelope,
): envelope is GlobalControlEnvelope {
  return envelope.body.t === "global-write";
}

function snapshotTrustedSource(value: TrustedControlSource): TrustedControlSource {
  const source = snapshot(value, "Trusted control source");
  assertPlainRecord(source, "Trusted control source");
  assertAllowedKeys(source, ["ingress", "principal"], "Trusted control source");
  assertPlainRecord(source.principal, "Trusted control principal");
  assertExactKeys(
    source.principal,
    ["connectionId", "deviceId", "surfacePrincipal"],
    "Trusted control principal",
  );
  assertIdentifier(source.principal.surfacePrincipal, "surfacePrincipal");
  assertIdentifier(source.principal.deviceId, "deviceId");
  assertIdentifier(source.principal.connectionId, "connectionId");
  if (source.ingress !== undefined) validateIngressContext(source.ingress);
  return source as unknown as TrustedControlSource;
}

function assertTrustedSourceMatches(
  envelope: AdmittedControlEnvelope,
  source: TrustedControlSource,
): void {
  if (canonicalize(envelope.principal) !== canonicalize(source.principal)) {
    throw new TypeError("Control envelope principal is not the authenticated source");
  }
  if (envelope.body.t === "session-create") {
    if (source.ingress !== undefined) {
      throw new TypeError("session-create does not accept an input ingress context");
    }
    return;
  }
  if (envelope.body.t === "job-run") {
    const ingress = source.ingress;
    if (!ingress) {
      throw new TypeError("job-run requires owner-derived ingress context");
    }
    if (
      ingress.surfacePrincipal !== envelope.principal.surfacePrincipal ||
      ingress.deviceId !== envelope.principal.deviceId
    ) {
      throw new TypeError("job-run does not match its owner-derived ingress context");
    }
    return;
  }
  if (
    envelope.body.t === "cancel" ||
    envelope.body.t === "cancel-batch" ||
    envelope.body.t === "job-cancel" ||
    envelope.body.t === "uncertain-resolve" ||
    envelope.body.t === "delivery-resolve" ||
    envelope.body.t === "global-write" ||
    envelope.body.t === "session-write"
  ) {
    if (source.ingress !== undefined) {
      throw new TypeError("Authority control requests do not accept ingress context");
    }
    return;
  }
  const ingress = source.ingress;
  if (!ingress) throw new TypeError("input requires owner-derived ingress context");
  if (
    ingress.surfacePrincipal !== envelope.principal.surfacePrincipal ||
    ingress.deviceId !== envelope.principal.deviceId ||
    ingress.ingressId !== envelope.body.ingress.ingressId ||
    ingress.kind !== envelope.body.ingress.source
  ) {
    throw new TypeError("Control input does not match its owner-derived ingress context");
  }
}

function assertSurfaceAssetControlRecord(
  body: Record<string, unknown>,
): void {
  if (body.t === "asset-grant-issued") {
    assertExactKeys(body, ["grant", "t"], "asset-grant-issued record");
    assertPlainRecord(body.grant, "asset-grant-issued grant");
    return;
  }
  if (body.t === "authority-time-frontier") {
    assertExactKeys(
      body,
      ["frontier", "t"],
      "authority-time-frontier record",
    );
    if (
      typeof body.frontier !== "string" ||
      !Number.isFinite(Date.parse(body.frontier)) ||
      new Date(Date.parse(body.frontier)).toISOString() !== body.frontier
    ) {
      throw invalidControlRecord(
        "authority-time-frontier frontier is not a canonical timestamp",
      );
    }
    return;
  }
  assertExactKeys(
    body,
    ["grantId", "reason", "t"],
    "asset-grant-revoked record",
  );
  assertIdentifier(body.grantId, "asset-grant-revoked grantId");
  if (
    body.reason !== "session-deleted" &&
    body.reason !== "surface-revoked" &&
    body.reason !== "superseded"
  ) {
    throw invalidControlRecord("asset-grant-revoked reason is invalid");
  }
}

function snapshotControlResult(
  value: ControlResult,
  requestType: AdmittedControlRequest["t"],
): ControlResult {
  const result = snapshot(value, "Control result");
  assertPlainRecord(result, "Control result");
  if (result.v !== 1) throw new TypeError("Control result version must be 1");
  if (result.status === "rejected") {
    assertExactKeys(result, ["error", "status", "v"], "Rejected control result");
    validateAuthorityError(result.error);
    return result as unknown as ControlResult;
  }
  if (result.status !== "ok") throw new TypeError("Control result status is invalid");
  assertExactKeys(result, ["body", "status", "v"], "Successful control result");
  assertPlainRecord(result.body, "Control result body");
  if (requestType === "session-create") {
    assertExactKeys(
      result.body,
      ["conversationId", "t"],
      "session-create result",
    );
    if (result.body.t !== "session-create") {
      throw new TypeError("session-create requires a matching result body");
    }
    assertIdentifier(result.body.conversationId, "Result conversationId");
  } else if (requestType === "input") {
    assertExactKeys(
      result.body,
      ["queuedPosition", "runId", "t"],
      "input result",
    );
    if (result.body.t !== "input") {
      throw new TypeError("input requires a matching result body");
    }
    assertIdentifier(result.body.runId, "Result runId");
    if (
      !Number.isSafeInteger(result.body.queuedPosition) ||
      (result.body.queuedPosition as number) < 0
    ) {
      throw new TypeError("queuedPosition must be a non-negative safe integer");
    }
  } else if (requestType === "cancel") {
    assertExactKeys(result.body, ["runState", "t"], "cancel result");
    if (result.body.t !== "cancel") {
      throw new TypeError("cancel requires a matching result body");
    }
    assertConversationRunState(result.body.runState, "cancel runState");
  } else if (requestType === "cancel-batch") {
    validateCancelBatchControlResultBody(result.body);
  } else if (requestType === "session-write") {
    assertExactKeys(result.body, ["revision", "t"], "session-write result");
    if (result.body.t !== "session-write") {
      throw new TypeError("session-write requires a matching result body");
    }
    if (
      !Number.isSafeInteger(result.body.revision) ||
      (result.body.revision as number) <= 0
    ) {
      throw new TypeError("session-write revision must be a positive safe integer");
    }
  } else if (requestType === "job-run") {
    assertExactKeys(result.body, ["jobRunId", "t"], "job-run result");
    if (result.body.t !== "job-run") {
      throw new TypeError("job-run requires a matching result body");
    }
    assertIdentifier(result.body.jobRunId, "Result jobRunId");
  } else if (requestType === "job-cancel") {
    assertExactKeys(result.body, ["runState", "t"], "job-cancel result");
    if (result.body.t !== "job-cancel") {
      throw new TypeError("job-cancel requires a matching result body");
    }
    assertJobRunState(result.body.runState, "job-cancel runState");
  } else if (requestType === "uncertain-resolve") {
    assertExactKeys(
      result.body,
      ["factDigest", "state", "t"],
      "uncertain-resolve result",
    );
    if (result.body.t !== "uncertain-resolve") {
      throw new TypeError("uncertain-resolve requires a matching result body");
    }
    assertUncertainResolutionTargetState(
      result.body.state,
      "uncertain-resolve state",
    );
    if (
      typeof result.body.factDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(result.body.factDigest)
    ) {
      throw new TypeError("uncertain-resolve factDigest is invalid");
    }
  } else if (requestType === "global-write") {
    assertExactKeys(result.body, ["revision", "t"], "global-write result");
    if (result.body.t !== "global-write") {
      throw new TypeError("global-write requires a matching result body");
    }
    if (
      !Number.isSafeInteger(result.body.revision) ||
      (result.body.revision as number) <= 0
    ) {
      throw new TypeError("global-write revision must be a positive safe integer");
    }
  } else {
    assertExactKeys(result.body, ["applied", "t"], "delivery-resolve result");
    if (result.body.t !== "delivery-resolve") {
      throw new TypeError("delivery-resolve requires a matching result body");
    }
    if (typeof result.body.applied !== "boolean") {
      throw new TypeError("delivery-resolve applied must be boolean");
    }
  }
  return result as unknown as ControlResult;
}

function snapshotAuthorityEntries(
  entries: readonly LogicalRecord<unknown>[],
): readonly LogicalRecord<unknown>[] {
  const value = snapshot(entries, "Authority entries");
  if (!Array.isArray(value)) throw new TypeError("Authority entries must be an array");
  for (const entry of value) {
    assertPlainRecord(entry, "Authority entry");
    assertExactKeys(entry, ["body", "stream"], "Authority entry");
    assertIdentifier(entry.stream, "Authority entry stream");
    if (entry.stream === "control") {
      throw new TypeError("Application plans cannot inject control stream records");
    }
  }
  return value as unknown as readonly LogicalRecord<unknown>[];
}

export function snapshotStored<T>(value: unknown): Stored<T> {
  const stored = snapshot(value, "Stored control value");
  if (isStoredReference(stored)) return stored;
  return stored as T;
}

function isStoredReference(value: unknown): value is StoredReference {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || !("ref" in value)) {
    return false;
  }
  const ref = value.ref;
  return (
    isPlainRecord(ref) &&
    Object.keys(ref).sort().join(",") === "bytes,digest" &&
    typeof ref.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(ref.digest) &&
    Number.isSafeInteger(ref.bytes) &&
    (ref.bytes as number) >= 0
  );
}

function assertAuthorityRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("authorityRevision must be a non-negative safe integer");
  }
}

function assertConversationRunState(value: unknown, label: string): void {
  const states = new Set([
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "committed",
    "cancelled",
    "failed",
    "expired",
    "uncertain",
  ]);
  if (typeof value !== "string" || !states.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertJobRunState(value: unknown, label: string): void {
  const states = new Set([
    "queued",
    "dispatched",
    "running",
    "cancel-requested",
    "committed",
    "cancelled",
    "failed",
    "expired",
    "missed",
    "uncertain",
  ]);
  if (typeof value !== "string" || !states.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertUncertainResolutionTargetState(value: unknown, label: string): void {
  if (value !== "queued" && value !== "cancelled" && value !== "failed") {
    throw new TypeError(`${label} is invalid`);
  }
}

function failMissingJobIngress(): never {
  throw new TypeError("job-run requires owner-derived ingress context");
}

function assertDurableIngressMatches(
  envelope: AdmittedControlEnvelope,
  ingress: IngressContext | undefined,
): void {
  const requiresIngress = envelope.body.t === "input" || envelope.body.t === "job-run";
  if (requiresIngress !== (ingress !== undefined)) {
    throw invalidControlRecord(
      requiresIngress
        ? "Control received record is missing its owner-derived ingress"
        : "Control received record carries ingress for a request that forbids it",
    );
  }
  if (!ingress) return;
  if (
    ingress.surfacePrincipal !== envelope.principal.surfacePrincipal ||
    ingress.deviceId !== envelope.principal.deviceId
  ) {
    throw invalidControlRecord("Control received ingress does not match its principal");
  }
  if (
    envelope.body.t === "input" &&
    (ingress.ingressId !== envelope.body.ingress.ingressId ||
      ingress.kind !== envelope.body.ingress.source)
  ) {
    throw invalidControlRecord("Control received ingress does not match its input identity");
  }
}

function assertControlRecordFits(record: ControlRecord): void {
  if (
    Buffer.byteLength(canonicalize(record), "utf8") >
    MAX_INLINE_LOGICAL_RECORD_BYTES
  ) {
    throw new TypeError("Control record exceeds the durable record limit");
  }
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, { cause: error });
  }
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new TypeError(`${label} contains unknown fields`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertProtocolIdentifier(value, label);
}

function invalidControlRecord(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}

export function registerControlAdmissionProjection(log: AuthorityCommitLog, artifacts: ArtifactStore) {
  return log.durableProjection({
      projectionId: CONTROL_PROJECTION_ID,
      inputs: { streams: ["control"] },
      authenticated: true,
      reducerVersion: 1,
      reduce: (envelope, current) => reduceControlIndex(envelope, current, artifacts),
    });
}
