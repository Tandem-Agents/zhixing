import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  describeControlArtifactClosure,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  resolveControlArtifactClosure,
  validateAdmittedControlEnvelope,
  type ArtifactStore,
  type AuthorityCommitLog,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  ChannelResponderRef,
  ControlEnvelope,
  ControlRecord,
  ControlRequest,
  ControlResult,
  IngressContext,
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
  #projection = emptyProjection();
  #projectionCursor: ProjectionCursor | undefined;
  readonly #authorityProjections = new Map<
    string,
    {
      readonly control: ControlProjection;
      readonly target: unknown;
      readonly cursor: ProjectionCursor;
    }
  >();

  constructor(log: AuthorityCommitLog, artifacts: ArtifactStore) {
    this.#log = log;
    this.#artifacts = artifacts;
  }

  /**
   * Enumerates durably applied session identities from the control owner itself.
   * Consumers use this projection instead of maintaining a second conversation
   * registry; artifact-backed results are materialized through the same store.
   */
  async listCreatedConversationIds(): Promise<readonly string[]> {
    return this.#operations.run(async () => {
      const transaction = await this.#transact<readonly Stored<ControlResult>[]>(
        (state) => {
          const requests = new Map(state.base.requests);
          for (const [requestId, request] of state.requests) {
            requests.set(requestId, request);
          }
          const results = [...requests.values()]
            .filter(
              (request) =>
                request.requestType === "session-create" &&
                request.storedResult !== undefined,
            )
            .map((request) => request.storedResult!);
          return { kind: "return", value: results };
        },
        [],
      );
      const ids = new Set<string>();
      for (const stored of transaction.value) {
        const result = await loadStored(stored, this.#artifacts, "ControlResult");
        if (
          result.status === "ok" &&
          result.body.t === "session-create"
        ) {
          ids.add(result.body.conversationId);
        }
      }
      return [...ids].sort();
    });
  }

  async lookup(input: {
    readonly envelope: AdmittedControlEnvelope;
    readonly source: TrustedControlSource;
  }): Promise<ControlAdmissionLookup> {
    const envelope = snapshotAdmittedControlEnvelope(input.envelope);
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
    return this.#operations.run(async () => {
      const transaction = await this.#transact<
        StoredControlAdmissionValue
        | Extract<ControlTransactionValue, { kind: "pending" }>
        | undefined
      >(
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
  }): Promise<ControlAdmissionOutcome> {
    const envelope = snapshotAdmittedControlEnvelope(input.envelope) as Envelope;
    if (envelope.body.t === "session-create") {
      throw new TypeError(
        "Atomic authority application rejects session-create control requests",
      );
    }
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
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
    return this.#operations.run(async () => {
      const preparedEnvelope = await prepareEnvelope(
        envelope,
        source.ingress,
        this.#artifacts,
      );
      const receipt = await this.#transact(
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
  }): Promise<ControlAdmissionOutcome> {
    type CombinedProjection = {
      readonly control: ControlProjectionDraft;
      target: State;
    };
    const cached = this.#takeAuthorityProjection(input.stream) as
      | {
          readonly control: ControlProjection;
          readonly target: State;
          readonly cursor: ProjectionCursor;
        }
      | undefined;
    const initial: CombinedProjection = {
      control: beginProjectionDraft(cached?.control ?? emptyProjection()),
      target: cached?.target ?? input.initial,
    };
    try {
      const transaction = await this.#log.transactProjection<
        CombinedProjection,
        unknown,
        StoredControlAdmissionValue
      >(
        initial,
        async (state, record, commit) => {
          if (record.stream === "control") {
            await reduceControlProjection(
              state.control,
              record,
              commit,
              this.#artifacts,
            );
          } else {
            await input.observe?.(record, commit);
            if (record.stream === input.stream) {
              state.target = await input.reducer(state.target, record, commit);
            }
          }
          return state;
        },
        async (state, authorityPrefix) => {
          const request = getRequest(state.control, input.canonicalRequestId);
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
          streams: ["control", input.stream, ...(input.companionStreams ?? [])],
          ...(input.readProjectionIds
            ? { readProjectionIds: input.readProjectionIds }
            : {}),
          ...(cached ? { cursor: cached.cursor } : {}),
          candidateReferences: collectArtifactRefs([
            ...input.preparedEnvelope.references,
            ...(input.candidateReferences ?? []),
          ]),
        },
      );
      const control = commitProjectionDraft(transaction.state.control);
      this.#cacheAuthorityProjection(input.stream, {
        control,
        target: transaction.state.target,
        cursor: transaction.cursor,
      });
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
        readonly control: ControlProjection;
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
      readonly control: ControlProjection;
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

  async #transact(
    decide: (
      state: ControlProjectionDraft,
    ) => ProjectionTransactionDecision<unknown, ControlTransactionValue>,
    candidateReferences: readonly ArtifactRef[],
  ): Promise<
    import("@zhixing/core/authority").ProjectionTransactionResult<
      ControlProjectionDraft,
      unknown,
      ControlTransactionValue
    >
  >;
  async #transact<Value>(
    decide: (
      state: ControlProjectionDraft,
    ) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[],
  ): Promise<
    import("@zhixing/core/authority").ProjectionTransactionResult<
      ControlProjectionDraft,
      unknown,
      Value
    >
  >;
  async #transact<Value>(
    decide: (
      state: ControlProjectionDraft,
    ) => ProjectionTransactionDecision<unknown, Value>,
    candidateReferences: readonly ArtifactRef[],
  ) {
    const draft = beginProjectionDraft(this.#projection);
    try {
      const transaction = await this.#log.transactProjection<
        ControlProjectionDraft,
        unknown,
        Value
      >(
        draft,
        (state, record, commit) =>
          reduceControlProjection(state, record, commit, this.#artifacts),
        decide,
        {
          stream: "control",
          ...(this.#projectionCursor ? { cursor: this.#projectionCursor } : {}),
          candidateReferences,
        },
      );
      this.#projection = commitProjectionDraft(transaction.state);
      this.#projectionCursor = transaction.cursor;
      return transaction;
    } catch (error) {
      this.#projection = emptyProjection();
      this.#projectionCursor = undefined;
      this.#authorityProjections.clear();
      throw error;
    }
  }
}

function emptyProjection(): ControlProjection {
  return { requests: new Map(), ingresses: new Map() };
}

function beginProjectionDraft(base: ControlProjection): ControlProjectionDraft {
  return { base, requests: new Map(), ingresses: new Map() };
}

function commitProjectionDraft(draft: ControlProjectionDraft): ControlProjection {
  for (const [requestId, request] of draft.requests) {
    draft.base.requests.set(requestId, request);
  }
  for (const [key, ingress] of draft.ingresses) {
    draft.base.ingresses.set(key, ingress);
  }
  return draft.base;
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

async function loadStored<T>(
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

function snapshotStored<T>(value: unknown): Stored<T> {
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
