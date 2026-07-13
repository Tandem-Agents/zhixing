import { Buffer } from "node:buffer";
import { isNonEmptyUserTurnInput } from "@zhixing/core";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ArtifactStore,
  type AuthorityCommitLog,
  type ProjectionCursor,
  type ProjectionTransactionDecision,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  ChannelResponderRef,
  ControlEnvelope,
  ControlRecord,
  ControlRequest,
  ControlResult,
  IngressContext,
  LogicalRecord,
} from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { SerialTaskQueue } from "@zhixing/core/persistence";

const MAX_CONTROL_IDENTIFIER_BYTES = 480;
const MAX_CONTROL_MESSAGE_BYTES = 4 * 1024;

type InitialControlRequest = Extract<
  ControlRequest,
  { t: "input" | "session-create" }
>;

export type InitialControlEnvelope = Omit<ControlEnvelope, "body"> & {
  readonly body: InitialControlRequest;
};

export interface TrustedControlSource {
  readonly principal: ControlEnvelope["principal"];
  readonly ingress?: IngressContext;
}

export interface ControlApplicationPlan {
  readonly result: ControlResult;
  readonly authorityRevision: number;
  readonly authorityEntries?: readonly LogicalRecord<unknown>[];
}

type InitialControlRequestType = InitialControlRequest["t"];

type StoredControlAdmissionValue =
  | {
      readonly kind: "applied" | "replayed";
      readonly canonicalRequestId: string;
      readonly requestType: InitialControlRequestType;
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
      readonly requestType: InitialControlRequestType;
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
  readonly requestType: InitialControlRequestType;
  readonly payloadDigest: string;
  readonly surfacePrincipal: string;
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
  const at = input.at ?? new Date().toISOString();
  const envelope = {
    v: 1 as const,
    requestId: input.requestId,
    principal: source.principal,
    dependencyArtifacts: [],
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts: [],
    }),
    at,
    body,
  };
  const validated = snapshotInitialControlEnvelope(envelope);
  assertTrustedSourceMatches(validated, source);
  return validated;
}

export function channelSurfacePrincipal(responder: ChannelResponderRef): string {
  const value = snapshot(responder, "Channel responder");
  assertChannelResponder(value);
  return `channel:${protocolDigest("ChannelResponderRef", 1, value)}`;
}

/**
 * Durable request and ingress idempotency for the first control-plane cutover set.
 * It only appends authority effects supplied as data; execution remains on the
 * existing path until the complete durable run protocol is enabled.
 */
export class ControlAdmissionJournal {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #operations = new SerialTaskQueue();
  #projection = emptyProjection();
  #projectionCursor: ProjectionCursor | undefined;

  constructor(log: AuthorityCommitLog, artifacts: ArtifactStore) {
    this.#log = log;
    this.#artifacts = artifacts;
  }

  async apply(input: {
    readonly envelope: InitialControlEnvelope;
    readonly source: TrustedControlSource;
    /** Produces data for the authority commit; it must not apply side effects itself. */
    readonly prepare: (context: {
      readonly canonicalRequestId: string;
    }) => ControlApplicationPlan | Promise<ControlApplicationPlan>;
  }): Promise<ControlAdmissionOutcome> {
    const envelope = snapshotInitialControlEnvelope(input.envelope);
    const source = snapshotTrustedSource(input.source);
    assertTrustedSourceMatches(envelope, source);
    return this.#operations.run(() => this.#apply(envelope, input.prepare));
  }

  async #apply(
    envelope: InitialControlEnvelope,
    prepare: (context: {
      readonly canonicalRequestId: string;
    }) => ControlApplicationPlan | Promise<ControlApplicationPlan>,
  ): Promise<ControlAdmissionOutcome> {
    const preparedEnvelope = await prepareEnvelope(envelope, this.#artifacts);
    const receipt = await this.#transact(
      (state) =>
        decideControlReceipt({
          state,
          envelope,
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
    envelope: InitialControlEnvelope,
    preparedEnvelope: PreparedStored<InitialControlEnvelope>,
    alias: Extract<ControlTransactionValue, { kind: "alias" }>,
  ): Promise<ControlAdmissionOutcome> {
    const transaction = await this.#transact(
      (state) =>
        decideAppliedAlias({
          state,
          envelope,
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
  ) {
    const draft = beginProjectionDraft(this.#projection);
    const transaction = await this.#log.transactProjection<
      ControlProjectionDraft,
      unknown,
      ControlTransactionValue
    >(
      draft,
      (state, record) => reduceControlProjection(state, record, this.#artifacts),
      decide,
      {
        stream: "control",
        ...(this.#projectionCursor ? { cursor: this.#projectionCursor } : {}),
        candidateReferences,
      },
    );
    commitProjectionDraft(transaction.state);
    this.#projectionCursor = transaction.cursor;
    return transaction;
  }
}

function emptyProjection(): ControlProjection {
  return { requests: new Map(), ingresses: new Map() };
}

function beginProjectionDraft(base: ControlProjection): ControlProjectionDraft {
  return { base, requests: new Map(), ingresses: new Map() };
}

function commitProjectionDraft(draft: ControlProjectionDraft): void {
  for (const [key, value] of draft.requests) draft.base.requests.set(key, value);
  for (const [key, value] of draft.ingresses) draft.base.ingresses.set(key, value);
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
  artifacts: ArtifactStore,
): Promise<ControlProjectionDraft> {
  const body = record.body;
  if (!isPlainRecord(body) || (body.t !== "received" && body.t !== "applied")) {
    throw invalidControlRecord("Control stream contains an unknown record");
  }

  if (body.t === "received") {
    assertExactKeys(body, ["envelope", "requestId", "t"], "received record");
    assertIdentifier(body.requestId, "Control received requestId");
    const storedEnvelope = snapshotStored<InitialControlEnvelope>(body.envelope);
    const envelope = snapshotInitialControlEnvelope(
      await loadStored(storedEnvelope, artifacts, "ControlEnvelope"),
    );
    if (envelope.requestId !== body.requestId) {
      throw invalidControlRecord("Control received requestId does not match its envelope");
    }
    const existing = getRequest(state, envelope.requestId);
    if (existing) {
      if (!sameRequestBinding(existing, envelope)) {
        throw invalidControlRecord("A control requestId has conflicting durable payloads");
      }
      return state;
    }

    const request = requestProjection(envelope);
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
  snapshotControlResult(
    await loadStored(storedResult, artifacts, "ControlResult"),
    request.requestType,
  );
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
  readonly envelope: InitialControlEnvelope;
  readonly storedEnvelope: Stored<InitialControlEnvelope>;
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
    entries: [receivedRecord(input.envelope.requestId, input.storedEnvelope)],
    value: {
      kind: "pending" as const,
      canonicalRequestId: input.envelope.requestId,
    },
  };
}

function decideControlCompletion(input: {
  readonly state: ControlProjectionDraft;
  readonly envelope: InitialControlEnvelope;
  readonly storedEnvelope: Stored<InitialControlEnvelope>;
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
            receivedRecord(input.envelope.requestId, input.storedEnvelope),
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
  readonly envelope: InitialControlEnvelope;
  readonly storedEnvelope: Stored<InitialControlEnvelope>;
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
      receivedRecord(input.envelope.requestId, input.storedEnvelope),
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
  envelope: Stored<InitialControlEnvelope>,
): LogicalRecord<ControlRecord> {
  return { stream: "control", body: { t: "received", requestId, envelope } };
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

function requestProjection(envelope: InitialControlEnvelope): RequestProjection {
  const key = ingressKey(envelope);
  return {
    requestId: envelope.requestId,
    requestType: envelope.body.t,
    payloadDigest: envelope.payloadDigest,
    surfacePrincipal: envelope.principal.surfacePrincipal,
    ...(key ? { ingressKey: key } : {}),
  };
}

function ingressKey(envelope: InitialControlEnvelope): string | undefined {
  if (envelope.body.t !== "input") return undefined;
  return canonicalize([
    envelope.principal.surfacePrincipal,
    envelope.body.ingress.ingressId,
  ]);
}

function sameRequestBinding(
  left: RequestProjection,
  right: InitialControlEnvelope,
): boolean {
  return (
    left.payloadDigest === right.payloadDigest &&
    left.surfacePrincipal === right.principal.surfacePrincipal
  );
}

function sameIngressBinding(
  indexed: IngressProjection,
  envelope: InitialControlEnvelope,
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
  envelope: InitialControlEnvelope,
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
  envelope: InitialControlEnvelope,
  artifacts: ArtifactStore,
): Promise<PreparedStored<InitialControlEnvelope>> {
  const inline: ControlRecord = {
    t: "received",
    requestId: envelope.requestId,
    envelope,
  };
  return prepareStored(envelope, inline, artifacts);
}

async function prepareResult(
  result: ControlResult,
  artifacts: ArtifactStore,
): Promise<PreparedStored<ControlResult>> {
  const inline: ControlRecord = {
    t: "applied",
    requestId: "x".repeat(MAX_CONTROL_IDENTIFIER_BYTES),
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
  return { stored: { ref }, references: [ref] };
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

function snapshotInitialControlEnvelope(value: unknown): InitialControlEnvelope {
  const envelope = snapshot(value, "Control envelope");
  assertPlainRecord(envelope, "Control envelope");
  assertExactKeys(
    envelope,
    [
      "at",
      "body",
      "dependencyArtifacts",
      "payloadDigest",
      "principal",
      "requestId",
      "v",
    ],
    "Control envelope",
  );
  if (envelope.v !== 1) throw new TypeError("Control envelope version must be 1");
  assertIdentifier(envelope.requestId, "Control requestId");
  assertCanonicalTime(envelope.at, "Control envelope time");
  assertPlainRecord(envelope.principal, "Control principal");
  assertExactKeys(
    envelope.principal,
    ["connectionId", "deviceId", "surfacePrincipal"],
    "Control principal",
  );
  assertIdentifier(envelope.principal.surfacePrincipal, "surfacePrincipal");
  assertIdentifier(envelope.principal.deviceId, "deviceId");
  assertIdentifier(envelope.principal.connectionId, "connectionId");
  if (!Array.isArray(envelope.dependencyArtifacts) || envelope.dependencyArtifacts.length > 0) {
    throw new TypeError("Initial control requests cannot declare dependency artifacts");
  }
  assertInitialControlRequest(envelope.body);
  if (
    typeof envelope.payloadDigest !== "string" ||
    envelope.payloadDigest !==
      protocolDigest("ControlEnvelopePayload", 1, {
        body: envelope.body,
        dependencyArtifacts: envelope.dependencyArtifacts,
      })
  ) {
    throw new TypeError("Control envelope payload digest is invalid");
  }
  return envelope as unknown as InitialControlEnvelope;
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
  if (source.ingress !== undefined) assertIngressContext(source.ingress);
  return source as unknown as TrustedControlSource;
}

function assertTrustedSourceMatches(
  envelope: InitialControlEnvelope,
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

function assertInitialControlRequest(value: unknown): void {
  assertPlainRecord(value, "Control request");
  if (value.t === "session-create") {
    assertAllowedKeys(
      value,
      ["requestedName", "sceneId", "t"],
      "session-create request",
    );
    if (value.requestedName !== undefined) {
      assertNonEmptyString(value.requestedName, "requestedName");
    }
    if (value.sceneId !== undefined) assertIdentifier(value.sceneId, "sceneId");
    return;
  }
  if (value.t !== "input") {
    throw new TypeError("Control admission currently accepts input or session-create");
  }
  assertExactKeys(
    value,
    ["conversationId", "ingress", "input", "ownerEpoch", "t"],
    "input request",
  );
  assertIdentifier(value.conversationId, "conversationId");
  if (!Number.isSafeInteger(value.ownerEpoch) || (value.ownerEpoch as number) < 0) {
    throw new TypeError("ownerEpoch must be a non-negative safe integer");
  }
  assertPlainRecord(value.ingress, "Control input ingress reference");
  assertExactKeys(
    value.ingress,
    ["ingressId", "source"],
    "Control input ingress reference",
  );
  assertIdentifier(value.ingress.ingressId, "ingressId");
  if (value.ingress.source !== "first-party" && value.ingress.source !== "channel") {
    throw new TypeError("Control input source is invalid");
  }
  assertUserTurnInput(value.input);
}

function assertUserTurnInput(value: unknown): void {
  if (!isNonEmptyUserTurnInput(value)) {
    throw new TypeError("Control input must contain a non-empty user turn");
  }
  const input = value as unknown as Record<string, unknown>;
  assertExactKeys(input, ["parts"], "User turn input");
  for (const part of value.parts) {
    const record = part as unknown as Record<string, unknown>;
    if (part.type === "text") {
      assertExactKeys(record, ["text", "type"], "User input text part");
      continue;
    }
    assertAllowedKeys(
      record,
      ["mimeType", "name", "size", "source", "type"],
      "User input image part",
    );
    if (part.name !== undefined) {
      assertNonEmptyString(part.name, "User input image name");
    }
    if (part.mimeType !== undefined) {
      assertNonEmptyString(part.mimeType, "User input image mimeType");
    }
    if (
      part.size !== undefined &&
      (!Number.isSafeInteger(part.size) || part.size < 0)
    ) {
      throw new TypeError("User input image size must be a non-negative safe integer");
    }
    const source = part.source as unknown as Record<string, unknown>;
    if (part.source.type === "base64") {
      assertExactKeys(source, ["data", "mediaType", "type"], "Base64 image source");
    } else {
      assertExactKeys(source, ["type", "url"], "URL image source");
    }
  }
}

function assertIngressContext(value: unknown): asserts value is IngressContext {
  assertPlainRecord(value, "Ingress context");
  const common = [
    "deviceId",
    "ingressId",
    "kind",
    "receivedAt",
    "surfacePrincipal",
    "turnOrigin",
  ];
  if (value.kind === "first-party") {
    assertAllowedKeys(value, common, "First-party ingress context");
  } else if (value.kind === "channel") {
    assertAllowedKeys(
      value,
      [...common, "replyTarget", "responder"],
      "Channel ingress context",
    );
    assertChannelResponder(value.responder);
    assertDeliveryTarget(value.replyTarget);
    if (value.surfacePrincipal !== channelSurfacePrincipal(value.responder)) {
      throw new TypeError("Channel surfacePrincipal is not derived from its responder");
    }
  } else {
    throw new TypeError("Ingress context kind is invalid");
  }
  assertIdentifier(value.surfacePrincipal, "Ingress surfacePrincipal");
  assertIdentifier(value.deviceId, "Ingress deviceId");
  assertIdentifier(value.ingressId, "Ingress ingressId");
  assertCanonicalTime(value.receivedAt, "Ingress receivedAt");
  if (value.turnOrigin !== undefined) assertTurnOrigin(value.turnOrigin);
}

function assertChannelResponder(value: unknown): asserts value is ChannelResponderRef {
  assertPlainRecord(value, "Channel responder");
  assertAllowedKeys(
    value,
    ["channelId", "platformSubject", "tenant"],
    "Channel responder",
  );
  assertIdentifier(value.channelId, "Channel responder channelId");
  assertIdentifier(value.platformSubject, "Channel responder platformSubject");
  if (value.tenant !== undefined) assertIdentifier(value.tenant, "Channel tenant");
}

function assertDeliveryTarget(value: unknown): void {
  assertPlainRecord(value, "Delivery target");
  assertAllowedKeys(value, ["channelId", "threadId", "to"], "Delivery target");
  assertIdentifier(value.channelId, "Delivery channelId");
  assertIdentifier(value.to, "Delivery recipient");
  if (value.threadId !== undefined) assertIdentifier(value.threadId, "threadId");
}

function assertTurnOrigin(value: unknown): void {
  assertPlainRecord(value, "Turn origin");
  assertAllowedKeys(
    value,
    ["channel", "surface", "target", "triggeredBy"],
    "Turn origin",
  );
  assertIdentifier(value.channel, "Turn origin channel");
  if (value.target !== undefined) assertDeliveryTarget(value.target);
  if (value.triggeredBy !== undefined) {
    assertIdentifier(value.triggeredBy, "Turn origin triggeredBy");
  }
  if (value.surface !== undefined) {
    assertPlainRecord(value.surface, "Turn origin surface");
    assertAllowedKeys(value.surface, ["capabilities"], "Turn origin surface");
    if (value.surface.capabilities !== undefined) {
      assertPlainRecord(value.surface.capabilities, "Surface capabilities");
      assertAllowedKeys(
        value.surface.capabilities,
        ["postTurnControl"],
        "Surface capabilities",
      );
      if (
        value.surface.capabilities.postTurnControl !== undefined &&
        typeof value.surface.capabilities.postTurnControl !== "boolean"
      ) {
        throw new TypeError("postTurnControl capability must be boolean");
      }
    }
  }
}

function snapshotControlResult(
  value: ControlResult,
  requestType: InitialControlRequest["t"],
): ControlResult {
  const result = snapshot(value, "Control result");
  assertPlainRecord(result, "Control result");
  if (result.v !== 1) throw new TypeError("Control result version must be 1");
  if (result.status === "rejected") {
    assertExactKeys(result, ["error", "status", "v"], "Rejected control result");
    assertAuthorityError(result.error);
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
  } else {
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
  }
  return result as unknown as ControlResult;
}

function assertAuthorityError(value: unknown): asserts value is AuthorityError {
  assertPlainRecord(value, "Authority error");
  assertExactKeys(value, ["code", "message", "retryable"], "Authority error");
  const codes: ReadonlySet<AuthorityError["code"]> = new Set([
    "unauthorized",
    "capability-expired",
    "epoch-stale",
    "revision-conflict",
    "fence-rejected",
    "busy",
    "not-found",
    "invalid",
    "lease-exhausted",
    "missing-base",
    "typed-stale",
    "capability-gap",
    "unavailable-offline",
    "idempotency-conflict",
  ]);
  if (typeof value.code !== "string" || !codes.has(value.code as AuthorityError["code"])) {
    throw new TypeError("Authority error code is invalid");
  }
  assertBoundedNonEmptyString(
    value.message,
    "Authority error message",
    MAX_CONTROL_MESSAGE_BYTES,
  );
  if (typeof value.retryable !== "boolean") {
    throw new TypeError("Authority error retryable must be boolean");
  }
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

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an ISO timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
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

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertBoundedNonEmptyString(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is string {
  assertNonEmptyString(value, label);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${label} exceeds the ${maxBytes}-byte limit`);
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (Buffer.byteLength(value, "utf8") > MAX_CONTROL_IDENTIFIER_BYTES) {
    throw new TypeError(
      `${label} exceeds the ${MAX_CONTROL_IDENTIFIER_BYTES}-byte limit`,
    );
  }
}

function invalidControlRecord(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}
