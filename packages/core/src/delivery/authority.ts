import type {
  ArtifactRef,
  DeliveryEndpointDto,
  DeliveryEnqueueKeyBody,
  DeliveryFailure,
  DeliveryIntentDto,
  DeliveryItemState,
  DeliveryResolutionFact,
  DeliveryStatusNotice,
  DeliveryStreamRecord,
  LogicalRecord,
  CommitEnvelope,
} from "../contracts/index.js";
import {
  validateInlineOutboundContentDto,
} from "./content-schema.js";
import {
  AuthorityStorageError,
  type AuthorityCommitLog,
  type ProjectionCursor,
  type ProjectionTransactionContext,
} from "../authority/index.js";
import { SerialTaskQueue } from "../persistence/index.js";
import {
  canonicalize,
  protocolDigest,
  validatePublishDecisionRecord,
} from "../protocol/index.js";
import type {
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
  AuthorityDeliveryItem,
  DeliveryOpenFact,
} from "./types.js";
import {
  assertDeliveryDiagnosticText,
  assertDeliveryIdentifier,
  assertDeliveryItemId,
  DELIVERY_ITEM_ID_PREFIX,
} from "./validation.js";

export const DELIVERY_STREAM = "delivery";
const deliveryOperationQueues = new WeakMap<AuthorityCommitLog, SerialTaskQueue>();

interface MutableDeliveryItem {
  id: string;
  idempotencyKey: string;
  keyBody: DeliveryEnqueueKeyBody;
  intentDigest: string;
  intent: DeliveryIntentDto;
  state: DeliveryItemState;
  statusRevision: number;
  currentAttempt: number;
  automaticAttemptsUsed: number;
  pendingManualRetryFactDigest?: string;
  nextAttemptAt?: string;
  lastError?: DeliveryFailure;
  receiptDigest?: string;
  attemptStarted?: Extract<DeliveryStreamRecord, { t: "attempt-started" }>;
  openFact?: DeliveryOpenFact;
  resolution?: DeliveryResolutionFact;
}

type DeliveryStatusRecord = Extract<
  DeliveryStreamRecord,
  {
    t:
      | "sent"
      | "retry-scheduled"
      | "failed"
      | "delivery-uncertain"
      | "delivery-resolved";
  }
>;

interface DeliveryStatusNoticeEntry {
  readonly record: DeliveryStatusRecord;
  readonly at: string;
  readonly closedOpenFactDigest?: string;
}

export interface DeliveryProjection {
  readonly items: Map<string, MutableDeliveryItem>;
  readonly itemByKey: Map<string, string>;
  readonly statusNotices: Map<string, DeliveryStatusNoticeEntry[]>;
}

export interface DeliveryAttemptClaim {
  readonly kind: "send";
  readonly item: AuthorityDeliveryItem;
  readonly attempt: number;
  readonly redrive: boolean;
  readonly responseBindingDigest: string;
}

export type DeliveryClaimResult =
  | DeliveryAttemptClaim
  | {
      readonly kind: "uncertain";
      readonly item: AuthorityDeliveryItem;
      readonly notice: Extract<DeliveryStatusNotice, { state: "delivery-uncertain" }>;
    }
  | { readonly kind: "skip" };

export type DeliveryOutcome =
  | {
      readonly kind: "sent";
      readonly receipt?: {
        readonly digest: string;
        readonly platformMessage?: import("../contracts/index.js").ChannelMessageRef;
      };
    }
  | { readonly kind: "failed"; readonly error: DeliveryFailure };

export type DeliveryOutcomeDecision =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly state: DeliveryItemState;
      readonly statusRevision: number;
      readonly retryAt?: string;
      readonly notice?: DeliveryStatusNotice;
    };

export interface DeliveryResolutionInput {
  readonly itemId: string;
  readonly attempt: number;
  readonly anchorEpoch: number;
  readonly openFactDigest: string;
  readonly decision: DeliveryResolutionFact["decision"];
  readonly by: string;
}

export type DeliveryResolutionRequestBinding = DeliveryResolutionInput;

export type DeliveryResolutionDecision =
  | {
      readonly accepted: true;
      readonly record: Extract<DeliveryStreamRecord, { t: "delivery-resolved" }>;
      readonly state: DeliveryItemState;
    }
  | {
      readonly accepted: false;
      readonly error: {
        readonly code: "epoch-stale" | "fence-rejected" | "not-found";
        readonly message: string;
        readonly retryable: false;
      };
    };

export function emptyDeliveryProjection(): DeliveryProjection {
  return { items: new Map(), itemByKey: new Map(), statusNotices: new Map() };
}

export function deliveryRecord(body: DeliveryStreamRecord): LogicalRecord<DeliveryStreamRecord> {
  return { stream: DELIVERY_STREAM, body };
}

export function deliveryIdempotencyKey(keyBody: DeliveryEnqueueKeyBody): string {
  validateDeliveryEnqueueKeyBody(keyBody);
  return protocolDigest("DeliveryEnqueueKeyBody", 1, keyBody);
}

export function deliveryIntentDigest(intent: DeliveryIntentDto): string {
  validateDeliveryIntent(intent);
  return protocolDigest("DeliveryIntentDto", 1, intent);
}

export function deliveryItemId(
  idempotencyKey: string,
  commitAt: string,
  collisionSalt = 0,
): string {
  assertDigest(idempotencyKey, "Delivery idempotency key");
  assertCanonicalTime(commitAt, "Delivery item identity time");
  assertNonNegativeInteger(collisionSalt, "Delivery item identity collision salt");
  const timestamp = Date.parse(commitAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new TypeError("Delivery item identity time is outside the ULID range");
  }
  const entropy = protocolDigest("DeliveryItemIdEntropy", 1, {
    idempotencyKey,
    commitAt,
    collisionSalt,
  }).slice("sha256:".length, "sha256:".length + 20);
  let value = (BigInt(timestamp) << 80n) | BigInt(`0x${entropy}`);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `${DELIVERY_ITEM_ID_PREFIX}${encoded}`;
}

export function deliveryOpenFactDigest(input: {
  readonly itemId: string;
  readonly attempt: number;
  readonly openedAnchorEpoch: number;
  readonly startedAt: string;
  readonly unknownOutcome: Extract<
    DeliveryStreamRecord,
    { t: "attempt-started" }
  >["unknownOutcome"];
  readonly idempotencyKey: string;
}): string {
  assertDeliveryItemId(input.itemId);
  return protocolDigest("DeliveryOpenFact", 1, input);
}

export function deliveryResponseBindingDigest(input: {
  readonly itemId: string;
  readonly attempt: number;
  readonly startedAt: string;
}): string {
  assertDeliveryItemId(input.itemId, "Delivery response item id");
  assertPositiveInteger(input.attempt, "Delivery response attempt");
  assertCanonicalTime(input.startedAt, "Delivery response start time");
  return protocolDigest("DeliveryResponseBinding", 1, input);
}

export function deliveryResolutionFactDigest(
  fact: Omit<DeliveryResolutionFact, "factDigest">,
): string {
  return protocolDigest("DeliveryResolutionFact", 1, fact);
}

export function prepareDeliveryEnqueues(
  projection: DeliveryProjection,
  inputs: readonly DeliveryEnqueueInput[],
  commitAt: string,
): DeliveryEnqueueResult {
  assertCanonicalTime(commitAt, "Delivery enqueue commit time");
  const planned = new Map<
    string,
    { readonly itemId: string; readonly intentDigest: string; readonly input: DeliveryEnqueueInput }
  >();
  const records: DeliveryStreamRecord[] = [];
  const items: Array<{
    readonly itemId: string;
    readonly state: DeliveryItemState;
    readonly statusRevision: number;
  }> = [];

  for (const rawInput of inputs) {
    const input = snapshot(rawInput, "Delivery enqueue input");
    validateDeliveryEnqueueKeyBody(input.keyBody);
    validateDeliveryIntent(input.intent);
    if (input.intent.createdAt !== commitAt) {
      throw new TypeError("Delivery creation time must equal its authority commit time");
    }
    const key = deliveryIdempotencyKey(input.keyBody);
    const digest = deliveryIntentDigest(input.intent);
    const existingId = projection.itemByKey.get(key);
    const existing = existingId ? projection.items.get(existingId) : undefined;
    const local = planned.get(key);
    if (existingId && !existing) {
      throw corruptDeliveryStream("Delivery unique index is inconsistent");
    }
    const expectedDigest = existing?.intentDigest ?? local?.intentDigest;
    if (expectedDigest !== undefined && expectedDigest !== digest) {
      return {
        accepted: false,
        error: {
          code: "idempotency-conflict",
          message: "Delivery idempotency key is already bound to another intent",
          retryable: false,
        },
      };
    }
    if (existing) {
      items.push({
        itemId: existing.id,
        state: existing.state,
        statusRevision: existing.statusRevision,
      });
      continue;
    }
    if (local) {
      items.push({ itemId: local.itemId, state: "queued", statusRevision: 1 });
      continue;
    }
    let collisionSalt = 0;
    let itemId = deliveryItemId(key, commitAt, collisionSalt);
    const plannedIds = new Set([...planned.values()].map((entry) => entry.itemId));
    while (projection.items.has(itemId) || plannedIds.has(itemId)) {
      collisionSalt += 1;
      itemId = deliveryItemId(key, commitAt, collisionSalt);
    }
    planned.set(key, { itemId, intentDigest: digest, input });
    records.push({
      t: "enqueued",
      itemId,
      keyBody: input.keyBody,
      idempotencyKey: key,
      intentDigest: digest,
      intent: input.intent,
      statusRevision: 1,
    });
    items.push({ itemId, state: "queued", statusRevision: 1 });
  }
  return { accepted: true, records, items };
}

function reduceDeliveryLifecycleRecord(
  state: DeliveryProjection,
  raw: LogicalRecord<unknown>,
  context: Pick<CommitEnvelope<unknown>, "at">,
): DeliveryProjection {
  if (raw.stream !== DELIVERY_STREAM) return state;
  assertCanonicalTime(context.at, "Delivery commit time");
  const record = validateDeliveryStreamRecord(raw.body);
  switch (record.t) {
    case "enqueued": {
      const key = deliveryIdempotencyKey(record.keyBody);
      const intentDigest = deliveryIntentDigest(record.intent);
      if (
        record.idempotencyKey !== key ||
        record.intentDigest !== intentDigest ||
        record.intent.createdAt !== context.at ||
        record.statusRevision !== 1 ||
        state.items.has(record.itemId) ||
        state.itemByKey.has(key)
      ) {
        throw corruptDeliveryStream("Delivery enqueue identity is duplicated or invalid");
      }
      state.items.set(record.itemId, {
        id: record.itemId,
        idempotencyKey: key,
        keyBody: record.keyBody,
        intentDigest,
        intent: record.intent,
        state: "queued",
        statusRevision: 1,
        currentAttempt: 0,
        automaticAttemptsUsed: 0,
      });
      state.itemByKey.set(key, record.itemId);
      return state;
    }
    case "attempt-started": {
      const item = requireItem(state, record.itemId);
      requireRevision(item, record.statusRevision);
      if (
        (item.state !== "queued" && item.state !== "retry-wait") ||
        record.attempt !== item.currentAttempt + 1 ||
        !attemptAuthorizationMatches(item, record.authorization) ||
        record.startedAt !== context.at ||
        (item.state === "retry-wait" &&
          (item.nextAttemptAt === undefined ||
            Date.parse(record.startedAt) < Date.parse(item.nextAttemptAt)))
      ) {
        throw corruptDeliveryStream("Delivery attempt does not bind one ready item");
      }
      item.state = "attempting";
      item.statusRevision = record.statusRevision;
      item.currentAttempt = record.attempt;
      if (record.authorization.kind === "automatic") {
        item.automaticAttemptsUsed += 1;
      } else {
        item.pendingManualRetryFactDigest = undefined;
      }
      item.nextAttemptAt = undefined;
      item.attemptStarted = record;
      item.openFact = undefined;
      return state;
    }
    case "sent": {
      const item = requireOpenAttempt(state, record.itemId, record.attempt, record.statusRevision);
      const closedOpenFactDigest = item.openFact?.openFactDigest;
      item.state = "sent";
      item.statusRevision = record.statusRevision;
      item.receiptDigest = record.receipt?.digest;
      item.openFact = undefined;
      if (closedOpenFactDigest) {
        appendStatusNotice(state, record.itemId, record, context.at, closedOpenFactDigest);
      }
      return state;
    }
    case "retry-scheduled": {
      const item = requireOpenAttempt(state, record.itemId, record.attempt, record.statusRevision);
      const closedOpenFactDigest = item.openFact?.openFactDigest;
      if (
        deliveryFailureDisposition(item, record.error) !== "retry" ||
        Date.parse(record.retryAt) < Date.parse(context.at)
      ) {
        throw corruptDeliveryStream("Delivery retry exceeds its frozen attempt policy");
      }
      item.state = "retry-wait";
      item.statusRevision = record.statusRevision;
      item.nextAttemptAt = record.retryAt;
      item.lastError = record.error;
      item.openFact = undefined;
      if (closedOpenFactDigest) {
        appendStatusNotice(state, record.itemId, record, context.at, closedOpenFactDigest);
      }
      return state;
    }
    case "failed": {
      const item = requireOpenAttempt(state, record.itemId, record.attempt, record.statusRevision);
      const closedOpenFactDigest = item.openFact?.openFactDigest;
      if (deliveryFailureDisposition(item, record.error) !== "terminal") {
        throw corruptDeliveryStream("Retryable delivery failure bypasses its remaining automatic budget");
      }
      item.state = "failed";
      item.statusRevision = record.statusRevision;
      item.lastError = record.error;
      item.openFact = undefined;
      appendStatusNotice(state, record.itemId, record, context.at, closedOpenFactDigest);
      return state;
    }
    case "delivery-uncertain": {
      const item = requireItem(state, record.itemId);
      requireRevision(item, record.statusRevision);
      if (
        item.state !== "attempting" ||
        record.attempt !== item.currentAttempt ||
        !item.attemptStarted ||
        record.openedAnchorEpoch <= 0 ||
        record.openedAt !== context.at ||
        deliveryUnknownOutcomeDisposition(item.attemptStarted, record.openedAt) !== "uncertain"
      ) {
        throw corruptDeliveryStream("Delivery uncertainty does not bind the open attempt");
      }
      const openFact = makeOpenFact(item, item.attemptStarted, record.openedAnchorEpoch);
      if (record.openFactDigest !== openFact.openFactDigest) {
        throw corruptDeliveryStream("Delivery open fact digest is invalid");
      }
      item.state = "uncertain";
      item.statusRevision = record.statusRevision;
      item.openFact = openFact;
      appendStatusNotice(state, record.itemId, record, context.at);
      return state;
    }
    case "delivery-resolved": {
      const item = requireItem(state, record.fact.itemId);
      requireRevision(item, record.statusRevision);
      const open = item.openFact;
      const { factDigest, ...unsigned } = record.fact;
      if (
        item.state !== "uncertain" ||
        !open ||
        record.fact.itemId !== item.id ||
        record.fact.attempt !== item.currentAttempt ||
        record.fact.openedAnchorEpoch !== open.openedAnchorEpoch ||
        record.fact.openFactDigest !== open.openFactDigest ||
        record.fact.at !== context.at ||
        factDigest !== deliveryResolutionFactDigest(unsigned)
      ) {
        throw corruptDeliveryStream("Delivery resolution does not close its open fact");
      }
      item.statusRevision = record.statusRevision;
      item.resolution = record.fact;
      item.openFact = undefined;
      if (record.fact.decision === "user-verified-sent") item.state = "verified-sent";
      else if (record.fact.decision === "abandon") item.state = "abandoned";
      else {
        item.state = "queued";
        item.pendingManualRetryFactDigest = record.fact.factDigest;
      }
      appendStatusNotice(state, record.fact.itemId, record, context.at);
      return state;
    }
  }
}

export function reduceDeliveryAuthorityRecord(
  state: DeliveryProjection,
  record: LogicalRecord<unknown>,
  envelope: CommitEnvelope<unknown>,
): DeliveryProjection {
  if (record.stream !== DELIVERY_STREAM) return state;
  const body = validateDeliveryStreamRecord(record.body);
  if (body.t === "enqueued" || body.t === "delivery-resolved") {
    assertDeliveryEnvelopeCompanions(envelope);
  }
  return reduceDeliveryLifecycleRecord(state, record, envelope);
}

export function decideDeliveryResolution(
  state: DeliveryProjection,
  input: DeliveryResolutionInput,
  context: ProjectionTransactionContext,
  currentAnchorEpoch: number,
): DeliveryResolutionDecision {
  assertDeliveryItemId(input.itemId);
  if (input.anchorEpoch !== currentAnchorEpoch) {
    return rejectedResolution("epoch-stale", "Delivery resolution targets a stale anchor epoch");
  }
  const item = state.items.get(input.itemId);
  if (!item) return rejectedResolution("not-found", "Delivery item does not exist");
  const open = item.openFact;
  if (
    item.state !== "uncertain" ||
    !open ||
    input.attempt !== item.currentAttempt ||
    input.openFactDigest !== open.openFactDigest
  ) {
    return rejectedResolution("fence-rejected", "Delivery resolution does not bind the open attempt");
  }
  const unsigned = {
    itemId: item.id,
    attempt: item.currentAttempt,
    openedAnchorEpoch: open.openedAnchorEpoch,
    resolvedAnchorEpoch: currentAnchorEpoch,
    openFactDigest: open.openFactDigest,
    decision: input.decision,
    by: input.by,
    at: context.at,
  } as const;
  const fact: DeliveryResolutionFact = {
    ...unsigned,
    factDigest: deliveryResolutionFactDigest(unsigned),
  };
  if (!deliveryResolutionFactBindsRequest(fact, input)) {
    throw new TypeError("Delivery resolution fact does not bind its control request");
  }
  const record: Extract<DeliveryStreamRecord, { t: "delivery-resolved" }> = {
    t: "delivery-resolved",
    fact,
    statusRevision: item.statusRevision + 1,
  };
  validateDeliveryStreamRecord(record);
  return {
    accepted: true,
    record,
    state:
      input.decision === "user-verified-sent"
        ? "verified-sent"
        : input.decision === "abandon"
          ? "abandoned"
          : "queued",
  };
}

/** Anchor-owned delivery lifecycle and the shared enqueue uniqueness projection. */
export class DeliveryAuthority {
  readonly #log: AuthorityCommitLog;
  readonly #anchorEpoch: number;
  readonly #operations: SerialTaskQueue;
  #enqueueProjection = emptyDeliveryProjection();
  #cursor: ProjectionCursor | undefined;

  constructor(options: { readonly log: AuthorityCommitLog; readonly anchorEpoch: number }) {
    if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
      throw new TypeError("Delivery anchor epoch must be a positive safe integer");
    }
    this.#log = options.log;
    this.#anchorEpoch = options.anchorEpoch;
    const sharedOperations = deliveryOperationQueues.get(options.log) ?? new SerialTaskQueue();
    deliveryOperationQueues.set(options.log, sharedOperations);
    this.#operations = sharedOperations;
  }

  get anchorEpoch(): number {
    return this.#anchorEpoch;
  }

  /** Called inside a source journal's serialized log transaction. */
  prepareEnqueues(
    inputs: readonly DeliveryEnqueueInput[],
    commitAt: string,
  ): DeliveryEnqueueResult {
    return prepareDeliveryEnqueues(this.#enqueueProjection, inputs, commitAt);
  }

  /** Serializes source commits with the shared delivery uniqueness projection. */
  async coordinate<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      try {
        return await operation();
      } finally {
        await this.#synchronizeUnlocked();
      }
    });
  }

  async list(): Promise<readonly AuthorityDeliveryItem[]> {
    const state = await this.#select((projection) => projection);
    return [...state.items.values()].map(materializeItem);
  }

  /** Current in-process projection for synchronous health and status surfaces. */
  snapshot(): readonly AuthorityDeliveryItem[] {
    return [...this.#enqueueProjection.items.values()].map(materializeItem);
  }

  async get(itemId: string): Promise<AuthorityDeliveryItem | undefined> {
    assertDeliveryItemId(itemId);
    return this.#select((state) => {
      const item = state.items.get(itemId);
      return item ? materializeItem(item) : undefined;
    });
  }

  async statusHistory(
    itemId: string,
    afterStatusRevision: number,
  ): Promise<readonly DeliveryStatusNotice[]> {
    assertDeliveryItemId(itemId);
    if (!Number.isSafeInteger(afterStatusRevision) || afterStatusRevision < 0) {
      throw new TypeError("Last-seen delivery status revision must be non-negative");
    }
    return this.#select((state) =>
      (state.statusNotices.get(itemId) ?? [])
        .filter(({ record }) => record.statusRevision > afterStatusRevision)
        .map((entry) => deliveryStatusNotice(itemId, entry, this.#anchorEpoch)),
    );
  }

  async statusNotices(
    afterByItem: Readonly<Record<string, number>> = {},
  ): Promise<readonly DeliveryStatusNotice[]> {
    for (const [itemId, revision] of Object.entries(afterByItem)) {
      assertDeliveryItemId(itemId, "Delivery status item id");
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError("Delivery status revision must be non-negative");
      }
    }
    return this.#select((state) =>
      [...state.statusNotices.entries()]
        .flatMap(([itemId, notices]) =>
          notices
            .filter(
              ({ record }) =>
                record.statusRevision > (afterByItem[itemId] ?? 0),
            )
            .map((entry) => deliveryStatusNotice(itemId, entry, this.#anchorEpoch)),
        )
        .sort((left, right) =>
          left.at === right.at
            ? left.ref.itemId.localeCompare(right.ref.itemId)
            : left.at.localeCompare(right.at),
        ),
    );
  }

  async claim(input: {
    readonly itemId: string;
    readonly outcomePolicy?:
      | { readonly kind: "manual-resolution" }
      | { readonly kind: "idempotent-redrive"; readonly windowMs: number };
  }): Promise<DeliveryClaimResult> {
    assertDeliveryItemId(input.itemId);
    return (
      await this.#transact<DeliveryClaimResult>((state, context) => {
        const item = state.items.get(input.itemId);
        if (!item) return { kind: "return", value: { kind: "skip" } };
        if (item.state === "attempting") {
          const started = item.attemptStarted;
          if (!started) throw corruptDeliveryStream("Open delivery attempt has no start fact");
          if (deliveryUnknownOutcomeDisposition(started, context.at) === "redrive") {
            return {
              kind: "return",
              value: {
                kind: "send",
                item: materializeItem(item),
                attempt: item.currentAttempt,
                redrive: true,
                responseBindingDigest: deliveryResponseBindingDigest({
                  itemId: item.id,
                  attempt: started.attempt,
                  startedAt: started.startedAt,
                }),
              },
            };
          }
          const open = makeOpenFact(item, started, this.#anchorEpoch);
          const uncertain: DeliveryStreamRecord = {
            t: "delivery-uncertain",
            itemId: item.id,
            attempt: item.currentAttempt,
            openedAnchorEpoch: this.#anchorEpoch,
            openedAt: context.at,
            openFactDigest: open.openFactDigest,
            statusRevision: item.statusRevision + 1,
          };
          const projected = cloneDeliveryProjection(state);
          reduceDeliveryLifecycleRecord(projected, deliveryRecord(uncertain), {
            at: context.at,
          });
          return {
            kind: "append",
            entries: [deliveryRecord(uncertain)],
            value: {
              kind: "uncertain",
              item: materializeItem(projected.items.get(item.id)!),
              notice: requireStatusNotice(
                projected,
                item.id,
                uncertain.statusRevision,
                this.#anchorEpoch,
              ) as Extract<DeliveryStatusNotice, { state: "delivery-uncertain" }>,
            },
          };
        }
        if (!isReadyForAttempt(item, context.at)) {
          return { kind: "return", value: { kind: "skip" } };
        }
        if (!input.outcomePolicy) {
          return { kind: "return", value: { kind: "skip" } };
        }
        const started = makeAttemptStarted(item, context.at, input.outcomePolicy);
        return {
          kind: "append",
          entries: [deliveryRecord(started)],
          value: {
            kind: "send",
            item: materializeProjected(item, started),
            attempt: started.attempt,
            redrive: false,
            responseBindingDigest: deliveryResponseBindingDigest({
              itemId: item.id,
              attempt: started.attempt,
              startedAt: started.startedAt,
            }),
          },
        };
      })
    ).value;
  }

  /** Atomically closes a permanently invalid local payload without exposing an open attempt. */
  async recordPreflightFailure(input: {
    readonly itemId: string;
    readonly outcomePolicy:
      | { readonly kind: "manual-resolution" }
      | { readonly kind: "idempotent-redrive"; readonly windowMs: number };
    readonly error: DeliveryFailure;
  }): Promise<
    | { readonly accepted: false }
    | {
        readonly accepted: true;
        readonly attempt: number;
        readonly statusRevision: number;
        readonly notice: Extract<DeliveryStatusNotice, { state: "delivery-failed" }>;
      }
  > {
    assertDeliveryItemId(input.itemId);
    const error = snapshot(input.error, "Delivery preflight failure");
    validateDeliveryFailure(error);
    if (error.retryable) {
      throw new TypeError("Delivery preflight failure must be permanent");
    }
    return (
      await this.#transact<
        | { readonly accepted: false }
        | {
            readonly accepted: true;
            readonly attempt: number;
            readonly statusRevision: number;
            readonly notice: Extract<DeliveryStatusNotice, { state: "delivery-failed" }>;
          }
      >((state, context) => {
        const item = state.items.get(input.itemId);
        if (!item || !isReadyForAttempt(item, context.at)) {
          return { kind: "return", value: { accepted: false } };
        }
        const started = makeAttemptStarted(item, context.at, input.outcomePolicy);
        const failed: DeliveryStreamRecord = {
          t: "failed",
          itemId: item.id,
          attempt: started.attempt,
          error,
          statusRevision: started.statusRevision + 1,
        };
        const projected = cloneDeliveryProjection(state);
        reduceDeliveryLifecycleRecord(projected, deliveryRecord(started), { at: context.at });
        reduceDeliveryLifecycleRecord(projected, deliveryRecord(failed), { at: context.at });
        return {
          kind: "append",
          entries: [deliveryRecord(started), deliveryRecord(failed)],
          value: {
            accepted: true,
            attempt: started.attempt,
            statusRevision: failed.statusRevision,
            notice: requireStatusNotice(
              projected,
              item.id,
              failed.statusRevision,
              this.#anchorEpoch,
            ) as Extract<DeliveryStatusNotice, { state: "delivery-failed" }>,
          },
        };
      })
    ).value;
  }

  async recordOutcome(input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly outcome: DeliveryOutcome;
    readonly responseBindingDigest: string;
    readonly retryDelayMs?: number;
  }): Promise<DeliveryOutcomeDecision> {
    assertDeliveryItemId(input.itemId);
    if (input.retryDelayMs !== undefined) {
      assertNonNegativeInteger(input.retryDelayMs, "Delivery retry delay");
    }
    return (
      await this.#transact<DeliveryOutcomeDecision>((state, context) => {
        const item = state.items.get(input.itemId);
        if (
          !item ||
          (item.state !== "attempting" && item.state !== "uncertain") ||
          item.currentAttempt !== input.attempt
        ) {
          return { kind: "return", value: { accepted: false } };
        }
        assertDigest(input.responseBindingDigest, "Delivery response binding");
        const started = item.attemptStarted;
        if (!started) throw corruptDeliveryStream("Open delivery attempt has no start fact");
        const expectedBindingDigest = deliveryResponseBindingDigest({
          itemId: item.id,
          attempt: started.attempt,
          startedAt: started.startedAt,
        });
        if (input.responseBindingDigest !== expectedBindingDigest) {
          return { kind: "return", value: { accepted: false } };
        }
        const statusRevision = item.statusRevision + 1;
        let record: DeliveryStreamRecord;
        if (input.outcome.kind === "sent") {
          record = {
            t: "sent",
            itemId: item.id,
            attempt: input.attempt,
            ...(input.outcome.receipt ? { receipt: input.outcome.receipt } : {}),
            statusRevision,
          };
        } else if (deliveryFailureDisposition(item, input.outcome.error) === "retry") {
          if (input.retryDelayMs === undefined) {
            throw new TypeError("Retryable delivery outcome requires retry delay");
          }
          const retryAt = deliveryDeadlineAt(
            context.at,
            input.retryDelayMs,
            Math.max(0, item.automaticAttemptsUsed - 1),
          );
          record = {
            t: "retry-scheduled",
            itemId: item.id,
            attempt: input.attempt,
            retryAt,
            error: input.outcome.error,
            statusRevision,
          };
        } else {
          record = {
            t: "failed",
            itemId: item.id,
            attempt: input.attempt,
            error: input.outcome.error,
            statusRevision,
          };
        }
        record = snapshot(record, "Delivery outcome record");
        validateDeliveryStreamRecord(record);
        const projected = cloneDeliveryProjection(state);
        reduceDeliveryLifecycleRecord(projected, deliveryRecord(record), {
          at: context.at,
        });
        const projectedItem = projected.items.get(item.id)!;
        const notice = findStatusNotice(
          projected,
          item.id,
          statusRevision,
          this.#anchorEpoch,
        );
        return {
          kind: "append",
          entries: [deliveryRecord(record)],
          value: {
            accepted: true,
            state: projectedItem.state,
            statusRevision,
            ...(record.t === "retry-scheduled" ? { retryAt: record.retryAt } : {}),
            ...(notice ? { notice } : {}),
          },
        };
      })
    ).value;
  }

  async #select<Value>(select: (state: DeliveryProjection) => Value): Promise<Value> {
    return this.#operations.run(async () => {
      await this.#synchronizeUnlocked();
      return select(this.#enqueueProjection);
    });
  }

  async #transact<Value>(
    decide: (
      state: DeliveryProjection,
      context: ProjectionTransactionContext,
    ) => import("../authority/index.js").ProjectionTransactionDecision<unknown, Value>,
  ) {
    return this.#operations.run(async () => {
      const working = cloneDeliveryProjection(this.#enqueueProjection);
      const transaction = await this.#log.transactProjection<
        DeliveryProjection,
        unknown,
        Value
      >(
        working,
        this.#reduceAuthority,
        decide,
        {
          stream: DELIVERY_STREAM,
          ...(this.#cursor ? { cursor: this.#cursor } : {}),
        },
      );
      this.#enqueueProjection = transaction.state;
      this.#cursor = transaction.cursor;
      return transaction;
    });
  }

  readonly #reduceAuthority = reduceDeliveryAuthorityRecord;

  async #synchronizeUnlocked(): Promise<void> {
    const working = cloneDeliveryProjection(this.#enqueueProjection);
    const transaction = await this.#log.transactProjection<
      DeliveryProjection,
      unknown,
      void
    >(
      working,
      this.#reduceAuthority,
      () => ({ kind: "return", value: undefined }),
      {
        stream: DELIVERY_STREAM,
        ...(this.#cursor ? { cursor: this.#cursor } : {}),
      },
    );
    this.#enqueueProjection = transaction.state;
    this.#cursor = transaction.cursor;
  }
}

export function assertDeliveryEnvelopeCompanions(
  envelope: CommitEnvelope<unknown>,
): Extract<DeliveryStreamRecord, { t: "delivery-resolved" }> | undefined {
  const resolution = assertDeliveryResolutionCompanions(envelope);
  const enqueued = envelope.entries.filter(
    (entry) =>
      entry.stream === DELIVERY_STREAM &&
      typeof entry.body === "object" &&
      entry.body !== null &&
      (entry.body as { readonly t?: unknown }).t === "enqueued",
  );
  for (const entry of enqueued) {
    const record = validateDeliveryStreamRecord(entry.body);
    if (record.t !== "enqueued") continue;
    if (record.keyBody.kind === "staged-delivery") {
      if (!stagedDeliverySourceMatches(record, envelope)) {
        throw corruptDeliveryStream(
          "Staged delivery enqueue must bind one committed assignment and publish outcome",
        );
      }
      continue;
    }
    const matches = envelope.entries.filter((candidate) =>
      deliverySourceMatches(record.keyBody, candidate),
    );
    if (matches.length !== 1) {
      throw corruptDeliveryStream(
      "Delivery enqueue must have exactly one matching authority source fact",
      );
    }
  }
  return resolution;
}

function assertDeliveryResolutionCompanions(
  envelope: CommitEnvelope<unknown>,
): Extract<DeliveryStreamRecord, { t: "delivery-resolved" }> | undefined {
  const resolutions = envelope.entries.filter(
    (entry) =>
      entry.stream === DELIVERY_STREAM &&
      isPlainObject(entry.body) &&
      entry.body.t === "delivery-resolved",
  );
  const successfulApplications = envelope.entries.filter(
    (entry) => isSuccessfulDeliveryResolutionApplication(entry, envelope),
  );
  if (resolutions.length === 0 && successfulApplications.length === 0) return undefined;
  if (resolutions.length !== 1 || successfulApplications.length !== 1) {
    throw corruptDeliveryStream(
      "Delivery resolution and its successful control application must be unique companions",
    );
  }
  const resolution = validateDeliveryStreamRecord(resolutions[0]!.body);
  if (resolution.t !== "delivery-resolved") {
    throw corruptDeliveryStream("Delivery resolution companion is invalid");
  }
  if (resolution.fact.at !== envelope.at) {
    throw corruptDeliveryStream("Delivery resolution does not bind its authority commit");
  }
  return resolution;
}

export function deliveryResolutionFactBindsRequest(
  fact: DeliveryResolutionFact,
  request: DeliveryResolutionRequestBinding,
): boolean {
  return (
    fact.itemId === request.itemId &&
    fact.attempt === request.attempt &&
    fact.resolvedAnchorEpoch === request.anchorEpoch &&
    fact.openFactDigest === request.openFactDigest &&
    fact.decision === request.decision &&
    fact.by === request.by
  );
}

function isSuccessfulDeliveryResolutionApplication(
  entry: LogicalRecord<unknown>,
  envelope: CommitEnvelope<unknown>,
): boolean {
  return validatesCompanion(() => {
    if (entry.stream !== "control") {
      throw new TypeError("Delivery resolution application must use the control stream");
    }
    assertPlainObject(entry.body, "Delivery resolution control application");
    assertExactKeys(entry.body, ["authorityRevision", "requestId", "result", "t"]);
    if (entry.body.t !== "applied") {
      throw new TypeError("Delivery resolution control companion is not applied");
    }
    assertIdentifier(entry.body.requestId, "Delivery resolution request id");
    assertNonNegativeInteger(
      entry.body.authorityRevision,
      "Delivery resolution authority revision",
    );
    if (entry.body.authorityRevision !== envelope.lsn) {
      throw new TypeError("Delivery resolution authority revision is not its commit LSN");
    }
    assertPlainObject(entry.body.result, "Delivery resolution control result");
    assertExactKeys(entry.body.result, ["body", "status", "v"]);
    if (entry.body.result.v !== 1 || entry.body.result.status !== "ok") {
      throw new TypeError("Delivery resolution control result is not successful");
    }
    assertPlainObject(entry.body.result.body, "Delivery resolution result body");
    assertExactKeys(entry.body.result.body, ["applied", "t"]);
    if (
      entry.body.result.body.t !== "delivery-resolve" ||
      entry.body.result.body.applied !== true
    ) {
      throw new TypeError("Delivery resolution result body is invalid");
    }
  });
}

function stagedDeliverySourceMatches(
  record: Extract<DeliveryStreamRecord, { t: "enqueued" }>,
  envelope: CommitEnvelope<unknown>,
): boolean {
  const key = record.keyBody;
  if (key.kind !== "staged-delivery") return false;
  const committed = envelope.entries.filter(
    (entry) =>
      (entry.stream.startsWith("run:") || entry.stream.startsWith("job:")) &&
      isValidCommittedDeliverySource(entry.body, key.assignmentId),
  );
  const decisions = envelope.entries.filter(
    (entry) =>
      entry.stream === "publish" &&
      isValidPublishDecision(entry.body, key.assignmentId),
  );
  if (committed.length !== 1 || decisions.length !== 1) return false;
  const decision = decisions[0]!.body;
  if (!isPlainObject(decision) || !Array.isArray(decision.outcomes)) return false;
  const matchingOutcomes = decision.outcomes.filter(
    (candidate) =>
      isPlainObject(candidate) &&
      candidate.seq === key.mutationSeq &&
      isPlainObject(candidate.outcome) &&
      candidate.outcome.t === "granted" &&
      candidate.outcome.targetRevision === record.statusRevision,
  );
  return matchingOutcomes.length === 1;
}

function deliverySourceMatches(
  key: DeliveryEnqueueKeyBody,
  candidate: LogicalRecord<unknown>,
): boolean {
  if (candidate.stream === DELIVERY_STREAM || !isPlainObject(candidate.body)) {
    return false;
  }
  const body = candidate.body;
  switch (key.kind) {
    case "conversation-final-delivery":
      return (
        candidate.stream === `run:${key.conversationId}` &&
        isValidConversationCommittedSource(body) &&
        body.runId === key.runId &&
        body.commitRevision === key.commitRevision
      );
    case "conversation-status-delivery":
      return (
        candidate.stream === `run:${key.conversationId}` &&
        isValidConversationStatusSource(body) &&
        body.runId === key.runId &&
        body.statusRevision === key.statusRevision
      );
    case "job-result-delivery":
      return (
        candidate.stream === `job:${key.taskId}` &&
        isValidJobCommittedSource(body) &&
        body.jobRunId === key.jobRunId
      );
    case "job-status-delivery":
      return (
        candidate.stream === `job:${key.taskId}` &&
        isValidJobStatusSource(body) &&
        body.jobRunId === key.jobRunId &&
        body.statusRevision === key.statusRevision
      );
    case "staged-delivery":
      return false;
  }
}

const CHANNEL_STATUS_SOURCE_STATES = new Set([
  "cancelled",
  "failed",
  "expired",
  "uncertain",
]);

function isValidCommittedDeliverySource(
  value: unknown,
  assignmentId: string,
): boolean {
  if (!isPlainObject(value) || value.assignmentId !== assignmentId) return false;
  return isValidConversationCommittedSource(value) || isValidJobCommittedSource(value);
}

function isValidConversationCommittedSource(
  value: unknown,
): value is Record<string, unknown> & {
  readonly t: "committed";
  readonly runId: string;
  readonly assignmentId: string;
  readonly commitRevision: number;
} {
  return validatesCompanion(() => {
    assertPlainObject(value, "Conversation delivery source");
    assertExactKeys(value, ["assignmentId", "bundle", "commitRevision", "runId", "t"]);
    if (value.t !== "committed") throw new TypeError("Conversation delivery source type is invalid");
    assertIdentifier(value.runId, "Conversation delivery source run id");
    assertIdentifier(value.assignmentId, "Conversation delivery source assignment id");
    assertPositiveInteger(value.commitRevision, "Conversation delivery source revision");
    assertPlainObject(value.bundle, "Conversation delivery source bundle");
    assertExactKeys(value.bundle, ["ref"]);
    validateArtifactRef(value.bundle.ref);
  });
}

function isValidJobCommittedSource(
  value: unknown,
): value is Record<string, unknown> & {
  readonly t: "committed";
  readonly jobRunId: string;
  readonly assignmentId: string;
  readonly jobRevision: number;
} {
  return validatesCompanion(() => {
    assertPlainObject(value, "Job delivery source");
    assertExactKeys(value, ["assignmentId", "bundle", "jobRevision", "jobRunId", "t"]);
    if (value.t !== "committed") throw new TypeError("Job delivery source type is invalid");
    assertIdentifier(value.jobRunId, "Job delivery source run id");
    assertIdentifier(value.assignmentId, "Job delivery source assignment id");
    assertPositiveInteger(value.jobRevision, "Job delivery source revision");
    assertPlainObject(value.bundle, "Job delivery source bundle");
    assertExactKeys(value.bundle, ["ref"]);
    validateArtifactRef(value.bundle.ref);
  });
}

function isValidConversationStatusSource(
  value: unknown,
): value is Record<string, unknown> & {
  readonly t: "state";
  readonly runId: string;
  readonly state: string;
  readonly statusRevision: number;
} {
  return validatesCompanion(() => {
    assertPlainObject(value, "Conversation delivery status source");
    assertExactKeys(
      value,
      value.assignmentId === undefined
        ? ["runId", "state", "statusRevision", "t"]
        : ["assignmentId", "runId", "state", "statusRevision", "t"],
    );
    if (value.t !== "state") throw new TypeError("Conversation delivery status source type is invalid");
    assertIdentifier(value.runId, "Conversation delivery status run id");
    if (value.assignmentId !== undefined) {
      assertIdentifier(value.assignmentId, "Conversation delivery status assignment id");
    }
    assertPositiveInteger(value.statusRevision, "Conversation delivery status revision");
    if (!CHANNEL_STATUS_SOURCE_STATES.has(String(value.state))) {
      throw new TypeError("Conversation delivery status is not externally deliverable");
    }
  });
}

function isValidJobStatusSource(
  value: unknown,
): value is Record<string, unknown> & {
  readonly t: "state";
  readonly jobRunId: string;
  readonly state: string;
  readonly statusRevision: number;
} {
  return validatesCompanion(() => {
    assertPlainObject(value, "Job delivery status source");
    assertExactKeys(
      value,
      value.assignmentId === undefined
        ? ["jobRunId", "state", "statusRevision", "t"]
        : ["assignmentId", "jobRunId", "state", "statusRevision", "t"],
    );
    if (value.t !== "state") throw new TypeError("Job delivery status source type is invalid");
    assertIdentifier(value.jobRunId, "Job delivery status run id");
    if (value.assignmentId !== undefined) {
      assertIdentifier(value.assignmentId, "Job delivery status assignment id");
    }
    assertPositiveInteger(value.statusRevision, "Job delivery status revision");
    if (!CHANNEL_STATUS_SOURCE_STATES.has(String(value.state))) {
      throw new TypeError("Job delivery status is not externally deliverable");
    }
  });
}

function isValidPublishDecision(value: unknown, assignmentId: string): boolean {
  return validatesCompanion(() => {
    const decision = validatePublishDecisionRecord(value);
    if (decision.assignmentId !== assignmentId) {
      throw new TypeError("Staged delivery publish decision identity is invalid");
    }
  });
}

function validatesCompanion(assertion: () => void): boolean {
  try {
    assertion();
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateDeliveryStreamRecord(value: unknown): DeliveryStreamRecord {
  assertPlainObject(value, "Delivery stream record");
  switch (value.t) {
    case "enqueued":
      assertExactKeys(value, ["idempotencyKey", "intent", "intentDigest", "itemId", "keyBody", "statusRevision", "t"]);
      assertDeliveryItemId(value.itemId);
      validateDeliveryEnqueueKeyBody(value.keyBody);
      assertDigest(value.idempotencyKey, "Delivery idempotency key");
      assertDigest(value.intentDigest, "Delivery intent digest");
      validateDeliveryIntent(value.intent);
      assertPositiveInteger(value.statusRevision, "Delivery status revision");
      return value as unknown as DeliveryStreamRecord;
    case "attempt-started":
      assertExactKeys(value, ["attempt", "authorization", "itemId", "startedAt", "statusRevision", "t", "unknownOutcome"]);
      assertDeliveryItemId(value.itemId);
      assertPositiveInteger(value.attempt, "Delivery attempt");
      assertPlainObject(value.authorization, "Delivery attempt authorization");
      if (value.authorization.kind === "automatic") {
        assertExactKeys(value.authorization, ["kind"]);
      } else if (value.authorization.kind === "manual") {
        assertExactKeys(value.authorization, ["kind", "resolutionFactDigest"]);
        assertDigest(
          value.authorization.resolutionFactDigest,
          "Delivery manual retry resolution fact",
        );
      } else {
        throw new TypeError("Delivery attempt authorization is invalid");
      }
      assertCanonicalTime(value.startedAt, "Delivery attempt time");
      assertPositiveInteger(value.statusRevision, "Delivery status revision");
      assertPlainObject(value.unknownOutcome, "Delivery unknown outcome policy");
      if (value.unknownOutcome.kind === "manual-resolution") {
        assertExactKeys(value.unknownOutcome, ["kind"]);
      } else if (value.unknownOutcome.kind === "idempotent-redrive") {
        assertExactKeys(value.unknownOutcome, ["kind", "redriveUntil"]);
        assertCanonicalTime(value.unknownOutcome.redriveUntil, "Delivery redrive deadline");
        if (Date.parse(value.unknownOutcome.redriveUntil as string) < Date.parse(value.startedAt as string)) {
          throw new TypeError("Delivery redrive deadline precedes attempt start");
        }
      } else throw new TypeError("Delivery unknown outcome policy is invalid");
      return value as unknown as DeliveryStreamRecord;
    case "sent":
      assertExactKeys(value, ["attempt", "itemId", "receipt", "statusRevision", "t"], true);
      assertLifecycleIdentity(value);
      if (value.receipt !== undefined) {
        assertPlainObject(value.receipt, "Delivery receipt");
        assertExactKeys(value.receipt, ["digest", "platformMessage"], true);
        assertDigest(value.receipt.digest, "Delivery receipt digest");
        if (value.receipt.platformMessage !== undefined) {
          assertPlainObject(value.receipt.platformMessage, "Delivery platform message");
          assertExactKeys(value.receipt.platformMessage, ["channelId", "messageId", "threadId"], true);
          assertIdentifier(value.receipt.platformMessage.channelId, "Receipt channel");
          assertIdentifier(value.receipt.platformMessage.messageId, "Receipt message id");
          if (value.receipt.platformMessage.threadId !== undefined) assertIdentifier(value.receipt.platformMessage.threadId, "Receipt thread id");
        }
      }
      return value as unknown as DeliveryStreamRecord;
    case "retry-scheduled":
      assertExactKeys(value, ["attempt", "error", "itemId", "retryAt", "statusRevision", "t"]);
      assertLifecycleIdentity(value);
      assertCanonicalTime(value.retryAt, "Delivery retry time");
      validateDeliveryFailure(value.error);
      return value as unknown as DeliveryStreamRecord;
    case "failed":
      assertExactKeys(value, ["attempt", "error", "itemId", "statusRevision", "t"]);
      assertLifecycleIdentity(value);
      validateDeliveryFailure(value.error);
      return value as unknown as DeliveryStreamRecord;
    case "delivery-uncertain":
      assertExactKeys(value, ["attempt", "itemId", "openFactDigest", "openedAnchorEpoch", "openedAt", "statusRevision", "t"]);
      assertLifecycleIdentity(value);
      assertPositiveInteger(value.openedAnchorEpoch, "Delivery opened anchor epoch");
      assertCanonicalTime(value.openedAt, "Delivery uncertainty time");
      assertDigest(value.openFactDigest, "Delivery open fact digest");
      return value as unknown as DeliveryStreamRecord;
    case "delivery-resolved":
      assertExactKeys(value, ["fact", "statusRevision", "t"]);
      assertPositiveInteger(value.statusRevision, "Delivery status revision");
      validateDeliveryResolutionFact(value.fact);
      return value as unknown as DeliveryStreamRecord;
    default:
      throw new TypeError("Delivery stream record type is invalid");
  }
}

export function validateDeliveryEnqueueKeyBody(value: unknown): asserts value is DeliveryEnqueueKeyBody {
  assertPlainObject(value, "Delivery enqueue key body");
  switch (value.kind) {
    case "job-result-delivery":
      assertExactKeys(value, ["jobRunId", "kind", "planDigest", "taskId"]);
      assertIdentifier(value.taskId, "Delivery task id");
      assertIdentifier(value.jobRunId, "Delivery job run id");
      assertDigest(value.planDigest, "Delivery plan digest");
      return;
    case "staged-delivery":
      assertExactKeys(value, ["assignmentId", "kind", "mutationSeq"]);
      assertIdentifier(value.assignmentId, "Delivery assignment id");
      assertPositiveInteger(value.mutationSeq, "Delivery mutation sequence");
      return;
    case "conversation-final-delivery":
      assertExactKeys(value, ["commitRevision", "conversationId", "kind", "runId"]);
      assertIdentifier(value.conversationId, "Delivery conversation id");
      assertIdentifier(value.runId, "Delivery run id");
      assertPositiveInteger(value.commitRevision, "Delivery commit revision");
      return;
    case "conversation-status-delivery":
      assertExactKeys(value, ["conversationId", "kind", "runId", "statusRevision"]);
      assertIdentifier(value.conversationId, "Delivery conversation id");
      assertIdentifier(value.runId, "Delivery run id");
      assertPositiveInteger(value.statusRevision, "Delivery status revision");
      return;
    case "job-status-delivery":
      assertExactKeys(value, ["jobRunId", "kind", "statusRevision", "taskId"]);
      assertIdentifier(value.taskId, "Delivery task id");
      assertIdentifier(value.jobRunId, "Delivery job run id");
      assertPositiveInteger(value.statusRevision, "Delivery status revision");
      return;
    default:
      throw new TypeError("Delivery enqueue key kind is invalid");
  }
}

export function validateDeliveryIntent(value: unknown): asserts value is DeliveryIntentDto {
  assertPlainObject(value, "Delivery intent");
  assertExactKeys(value, ["content", "createdAt", "endpoint", "maxAttempts", "priority", "source"], true);
  validateEndpoint(value.endpoint);
  validateContent(value.content);
  if (!new Set(["low", "normal", "high"]).has(String(value.priority))) throw new TypeError("Delivery priority is invalid");
  assertCanonicalTime(value.createdAt, "Delivery creation time");
  assertPositiveInteger(value.maxAttempts, "Delivery max attempts");
  if (value.source !== undefined) validateSource(value.source);
}

function validateEndpoint(value: unknown): asserts value is DeliveryEndpointDto {
  assertPlainObject(value, "Delivery endpoint");
  if (value.kind === "channel") {
    assertExactKeys(value, ["kind", "target"]);
    assertPlainObject(value.target, "Delivery target");
    assertExactKeys(value.target, ["channelId", "threadId", "to"], true);
    assertIdentifier(value.target.channelId, "Delivery channel id");
    assertIdentifier(value.target.to, "Delivery recipient");
    if (value.target.threadId !== undefined) assertIdentifier(value.target.threadId, "Delivery thread id");
    return;
  }
  if (value.kind === "webhook") {
    assertExactKeys(value, ["endpoint", "kind"]);
    assertPlainObject(value.endpoint, "Webhook secret reference");
    assertExactKeys(value.endpoint, ["bindingId", "kind"]);
    if (value.endpoint.kind !== "webhook") throw new TypeError("Webhook endpoint requires a webhook secret reference");
    assertIdentifier(value.endpoint.bindingId, "Webhook binding id");
    return;
  }
  throw new TypeError("Delivery endpoint kind is invalid");
}

function validateContent(value: unknown): void {
  assertPlainObject(value, "Delivery content");
  if ("ref" in value) {
    assertExactKeys(value, ["ref"]);
    validateArtifactRef(value.ref);
    return;
  }
  validateInlineOutboundContentDto(value);
}

function validateSource(value: unknown): void {
  assertPlainObject(value, "Delivery source");
  if (value.kind === "scheduler") {
    assertExactKeys(value, ["createdInTurn", "kind", "taskId", "taskName"], true);
    assertIdentifier(value.taskId, "Delivery source task id");
    assertDeliveryDiagnosticText(value.taskName, "Delivery source task name", {
      nonEmpty: true,
    });
    if (value.createdInTurn !== undefined) assertIdentifier(value.createdInTurn, "Delivery source turn id");
    return;
  }
  if (value.kind === "agent") {
    assertExactKeys(value, ["conversationId", "kind"]);
    assertIdentifier(value.conversationId, "Delivery source conversation id");
    return;
  }
  if (value.kind === "system") {
    assertExactKeys(value, ["kind", "reason"]);
    assertDeliveryDiagnosticText(value.reason, "Delivery source reason");
    return;
  }
  throw new TypeError("Delivery source kind is invalid");
}

function validateDeliveryFailure(value: unknown): asserts value is DeliveryFailure {
  assertPlainObject(value, "Delivery failure");
  assertExactKeys(value, ["code", "message", "retryable"]);
  assertIdentifier(value.code, "Delivery failure code");
  assertDeliveryDiagnosticText(value.message, "Delivery failure message");
  if (typeof value.retryable !== "boolean") throw new TypeError("Delivery retryable flag must be boolean");
}

function validateDeliveryResolutionFact(value: unknown): asserts value is DeliveryResolutionFact {
  assertPlainObject(value, "Delivery resolution fact");
  assertExactKeys(value, ["at", "attempt", "by", "decision", "factDigest", "itemId", "openFactDigest", "openedAnchorEpoch", "resolvedAnchorEpoch"]);
  assertDeliveryItemId(value.itemId);
  assertPositiveInteger(value.attempt, "Delivery resolution attempt");
  assertPositiveInteger(value.openedAnchorEpoch, "Delivery opened anchor epoch");
  assertPositiveInteger(value.resolvedAnchorEpoch, "Delivery resolved anchor epoch");
  assertDigest(value.openFactDigest, "Delivery open fact digest");
  if (!new Set(["user-verified-sent", "abandon", "retry-risk-ack"]).has(String(value.decision))) throw new TypeError("Delivery resolution decision is invalid");
  assertIdentifier(value.by, "Delivery resolution principal");
  assertCanonicalTime(value.at, "Delivery resolution time");
  assertDigest(value.factDigest, "Delivery resolution fact digest");
}

function appendStatusNotice(
  state: DeliveryProjection,
  itemId: string,
  record: DeliveryStatusRecord,
  at: string,
  closedOpenFactDigest?: string,
): void {
  const history = state.statusNotices.get(itemId) ?? [];
  if (history.some((entry) => entry.record.statusRevision === record.statusRevision)) {
    throw corruptDeliveryStream("Delivery status revision has multiple notices");
  }
  history.push({
    record,
    at,
    ...(closedOpenFactDigest ? { closedOpenFactDigest } : {}),
  });
  state.statusNotices.set(itemId, history);
}

function deliveryStatusNotice(
  itemId: string,
  entry: DeliveryStatusNoticeEntry,
  currentAnchorEpoch: number,
): DeliveryStatusNotice {
  const { record, at, closedOpenFactDigest } = entry;
  if (
    record.t === "sent" ||
    record.t === "retry-scheduled" ||
    (record.t === "failed" && closedOpenFactDigest)
  ) {
    if (!closedOpenFactDigest) {
      throw corruptDeliveryStream("Delivery uncertainty closure has no open fact identity");
    }
    return {
      v: 1,
      ref: { execution: "delivery", itemId },
      state: "delivery-uncertain-closed",
      statusRevision: record.statusRevision,
      actions: [],
      at,
      attempt: record.attempt,
      anchorEpoch: currentAnchorEpoch,
      openFactDigest: closedOpenFactDigest,
      ...(record.t === "sent"
        ? { closedBy: "late-sent" as const }
        : record.t === "retry-scheduled"
          ? { closedBy: "late-retry-scheduled" as const }
          : { closedBy: "late-failed" as const, error: record.error }),
    };
  }
  if (record.t === "failed") {
    return {
      v: 1,
      ref: { execution: "delivery", itemId },
      state: "delivery-failed",
      statusRevision: record.statusRevision,
      actions: [],
      at,
      attempt: record.attempt,
      anchorEpoch: currentAnchorEpoch,
    };
  }
  if (record.t === "delivery-uncertain") {
    return {
      v: 1,
      ref: { execution: "delivery", itemId },
      state: "delivery-uncertain",
      statusRevision: record.statusRevision,
      actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
      at,
      attempt: record.attempt,
      anchorEpoch: currentAnchorEpoch,
      openFactDigest: record.openFactDigest,
    };
  }
  if (record.t !== "delivery-resolved") {
    throw corruptDeliveryStream("Delivery notice source is not externally observable");
  }
  return {
    v: 1,
    ref: { execution: "delivery", itemId },
    state: "delivery-resolved",
    statusRevision: record.statusRevision,
    actions: [],
    at,
    attempt: record.fact.attempt,
    anchorEpoch: record.fact.resolvedAnchorEpoch,
    openFactDigest: record.fact.openFactDigest,
    decision: record.fact.decision,
  };
}

export function deliveryResolutionStatusNotice(
  record: Extract<DeliveryStreamRecord, { t: "delivery-resolved" }>,
): Extract<DeliveryStatusNotice, { state: "delivery-resolved" }> {
  const validated = validateDeliveryStreamRecord(record);
  if (validated.t !== "delivery-resolved") {
    throw new TypeError("Delivery resolution notice requires a resolution record");
  }
  return deliveryStatusNotice(
    validated.fact.itemId,
    { record: validated, at: validated.fact.at },
    validated.fact.resolvedAnchorEpoch,
  ) as Extract<DeliveryStatusNotice, { state: "delivery-resolved" }>;
}

function findStatusNotice(
  state: DeliveryProjection,
  itemId: string,
  statusRevision: number,
  currentAnchorEpoch: number,
): DeliveryStatusNotice | undefined {
  const matches = (state.statusNotices.get(itemId) ?? []).filter(
    (entry) => entry.record.statusRevision === statusRevision,
  );
  if (matches.length > 1) {
    throw corruptDeliveryStream("Delivery status revision has multiple notices");
  }
  return matches[0]
    ? deliveryStatusNotice(itemId, matches[0], currentAnchorEpoch)
    : undefined;
}

function requireStatusNotice(
  state: DeliveryProjection,
  itemId: string,
  statusRevision: number,
  currentAnchorEpoch: number,
): DeliveryStatusNotice {
  const notice = findStatusNotice(state, itemId, statusRevision, currentAnchorEpoch);
  if (!notice) throw corruptDeliveryStream("Delivery status transition has no notice");
  return notice;
}

function requireItem(state: DeliveryProjection, itemId: string): MutableDeliveryItem {
  const item = state.items.get(itemId);
  if (!item) throw corruptDeliveryStream("Delivery lifecycle record names an unknown item");
  return item;
}

function requireRevision(item: MutableDeliveryItem, revision: number): void {
  if (revision !== item.statusRevision + 1) throw corruptDeliveryStream("Delivery status revision is not contiguous");
}

function requireOpenAttempt(
  state: DeliveryProjection,
  itemId: string,
  attempt: number,
  revision: number,
): MutableDeliveryItem {
  const item = requireItem(state, itemId);
  requireRevision(item, revision);
  if (
    (item.state !== "attempting" && item.state !== "uncertain") ||
    item.currentAttempt !== attempt
  ) {
    throw corruptDeliveryStream("Delivery result does not bind the current open attempt");
  }
  return item;
}

function makeOpenFact(
  item: MutableDeliveryItem,
  started: Extract<DeliveryStreamRecord, { t: "attempt-started" }>,
  openedAnchorEpoch: number,
): DeliveryOpenFact {
  const input = {
    itemId: item.id,
    attempt: started.attempt,
    openedAnchorEpoch,
    startedAt: started.startedAt,
    unknownOutcome: started.unknownOutcome,
    idempotencyKey: item.idempotencyKey,
  };
  return { ...input, openFactDigest: deliveryOpenFactDigest(input) };
}

function materializeItem(item: MutableDeliveryItem): AuthorityDeliveryItem {
  return snapshot(
    {
      id: item.id,
      idempotencyKey: item.idempotencyKey,
      keyBody: item.keyBody,
      intentDigest: item.intentDigest,
      endpoint: item.intent.endpoint,
      content: item.intent.content,
      priority: item.intent.priority,
      ...(item.intent.source ? { source: item.intent.source } : {}),
      createdAt: item.intent.createdAt,
      maxAttempts: item.intent.maxAttempts,
      state: item.state,
      statusRevision: item.statusRevision,
      attempts: item.currentAttempt,
      currentAttempt: item.currentAttempt,
      automaticAttemptsUsed: item.automaticAttemptsUsed,
      ...(item.pendingManualRetryFactDigest
        ? { pendingManualRetryFactDigest: item.pendingManualRetryFactDigest }
        : {}),
      ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
      ...(item.lastError ? { lastError: item.lastError } : {}),
      ...(item.receiptDigest ? { receiptDigest: item.receiptDigest } : {}),
      ...(item.openFact ? { openFact: item.openFact } : {}),
      ...(item.resolution ? { resolution: item.resolution } : {}),
    },
    "Delivery item projection",
  );
}

function materializeProjected(
  item: MutableDeliveryItem,
  record: DeliveryStreamRecord,
): AuthorityDeliveryItem {
  const temporary = emptyDeliveryProjection();
  const enqueued: DeliveryStreamRecord = {
    t: "enqueued",
    itemId: item.id,
    keyBody: item.keyBody,
    idempotencyKey: item.idempotencyKey,
    intentDigest: item.intentDigest,
    intent: item.intent,
    statusRevision: 1,
  };
  reduceDeliveryLifecycleRecord(temporary, deliveryRecord(enqueued), {
    at: enqueued.intent.createdAt,
  });
  const clone = temporary.items.get(item.id)!;
  Object.assign(clone, structuredClone(item));
  const at =
    record.t === "attempt-started"
      ? record.startedAt
      : record.t === "delivery-uncertain"
        ? record.openedAt
        : undefined;
  if (!at) throw new TypeError("Projected delivery transition has no authority time");
  reduceDeliveryLifecycleRecord(temporary, deliveryRecord(record), { at });
  return materializeItem(clone);
}

function assertLifecycleIdentity(value: Record<string, unknown>): void {
  assertDeliveryItemId(value.itemId);
  assertPositiveInteger(value.attempt, "Delivery attempt");
  assertPositiveInteger(value.statusRevision, "Delivery status revision");
}

function validateArtifactRef(value: unknown): asserts value is ArtifactRef {
  assertPlainObject(value, "Artifact reference");
  assertExactKeys(value, ["bytes", "digest"]);
  assertDigest(value.digest, "Artifact digest");
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) throw new TypeError("Artifact bytes must be a non-negative safe integer");
}

function rejectedResolution(
  code: "epoch-stale" | "fence-rejected" | "not-found",
  message: string,
): DeliveryResolutionDecision {
  return { accepted: false, error: { code, message, retryable: false } };
}

function requirePositiveMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Delivery redrive window must be a positive safe integer");
  return value;
}

function isReadyForAttempt(item: MutableDeliveryItem, at: string): boolean {
  if (item.state === "queued") return true;
  if (item.state !== "retry-wait") return false;
  if (item.nextAttemptAt === undefined) {
    throw corruptDeliveryStream("Retrying delivery item has no retry deadline");
  }
  return Date.parse(item.nextAttemptAt) <= Date.parse(at);
}

type AttemptAuthorization = Extract<
  DeliveryStreamRecord,
  { t: "attempt-started" }
>["authorization"];

function attemptAuthorizationMatches(
  item: MutableDeliveryItem,
  authorization: AttemptAuthorization,
): boolean {
  if (authorization.kind === "manual") {
    return (
      item.pendingManualRetryFactDigest !== undefined &&
      authorization.resolutionFactDigest === item.pendingManualRetryFactDigest
    );
  }
  return (
    item.pendingManualRetryFactDigest === undefined &&
    item.automaticAttemptsUsed < item.intent.maxAttempts
  );
}

function deliveryFailureDisposition(
  item: MutableDeliveryItem,
  error: DeliveryFailure,
): "retry" | "terminal" {
  return error.retryable && item.automaticAttemptsUsed < item.intent.maxAttempts
    ? "retry"
    : "terminal";
}

function deliveryUnknownOutcomeDisposition(
  started: Extract<DeliveryStreamRecord, { t: "attempt-started" }>,
  at: string,
): "redrive" | "uncertain" {
  if (started.unknownOutcome.kind === "manual-resolution") return "uncertain";
  return Date.parse(at) <= Date.parse(started.unknownOutcome.redriveUntil)
    ? "redrive"
    : "uncertain";
}

function makeAttemptStarted(
  item: MutableDeliveryItem,
  at: string,
  outcomePolicy:
    | { readonly kind: "manual-resolution" }
    | { readonly kind: "idempotent-redrive"; readonly windowMs: number },
): Extract<DeliveryStreamRecord, { t: "attempt-started" }> {
  const attempt = item.currentAttempt + 1;
  const authorization = item.pendingManualRetryFactDigest
    ? ({
        kind: "manual",
        resolutionFactDigest: item.pendingManualRetryFactDigest,
      } as const)
    : ({ kind: "automatic" } as const);
  if (!attemptAuthorizationMatches(item, authorization)) {
    throw corruptDeliveryStream("Ready delivery item exceeds its attempt policy");
  }
  const unknownOutcome =
    outcomePolicy.kind === "manual-resolution"
      ? ({ kind: "manual-resolution" } as const)
      : ({
          kind: "idempotent-redrive",
          redriveUntil: deliveryDeadlineAt(
            at,
            requirePositiveMs(outcomePolicy.windowMs),
          ),
        } as const);
  return {
    t: "attempt-started",
    itemId: item.id,
    attempt,
    authorization,
    startedAt: at,
    unknownOutcome,
    statusRevision: item.statusRevision + 1,
  };
}

/** Produces a canonical deadline without letting valid integer policy values overflow Date. */
export function deliveryDeadlineAt(
  at: string,
  baseDelayMs: number,
  exponent = 0,
): string {
  assertCanonicalTime(at, "Delivery deadline base time");
  assertNonNegativeInteger(baseDelayMs, "Delivery deadline delay");
  assertNonNegativeInteger(exponent, "Delivery deadline exponent");
  const start = BigInt(Date.parse(at));
  const maximum = 8_640_000_000_000_000n;
  const delay =
    baseDelayMs === 0
      ? 0n
      : exponent > 53
        ? maximum
        : BigInt(baseDelayMs) * 2n ** BigInt(exponent);
  const target = start + delay > maximum ? maximum : start + delay;
  return new Date(Number(target)).toISOString();
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
}

function assertExactKeys(value: object, expected: readonly string[], optional = false): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (optional ? actual.some((key) => !allowed.includes(key)) : canonicalize(actual) !== canonicalize(allowed)) {
    throw new TypeError("Delivery protocol value fields are incomplete or unknown");
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  assertDeliveryIdentifier(value, label);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a canonical SHA-256 digest`);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new TypeError(`${label} must be a canonical ISO timestamp`);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`, { cause: error });
  }
}

function cloneDeliveryProjection(state: DeliveryProjection): DeliveryProjection {
  return {
    items: new Map(
      [...state.items].map(([itemId, item]) => [itemId, structuredClone(item)]),
    ),
    itemByKey: new Map(state.itemByKey),
    statusNotices: new Map(
      [...state.statusNotices].map(([itemId, notices]) => [
        itemId,
        structuredClone(notices),
      ]),
    ),
  };
}

function corruptDeliveryStream(message: string): AuthorityStorageError {
  return new AuthorityStorageError("commit-log-corrupt", message);
}
