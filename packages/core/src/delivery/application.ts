import type {
  AuthorityError,
  DeliveryFailure,
  DeliveryItemState,
  ControlEnvelope,
  ControlResult,
  DeliveryEnqueueKeyBody,
  DeliveryIntentDto,
  DeliveryStreamRecord,
  LogicalRecord,
} from "../contracts/index.js";
import {
  deliveryIdempotencyKey,
  deliveryIntentDigest,
  deliveryResponseBindingDigest,
  deliveryRecord,
  prepareDeliveryEnqueues,
  validateDeliveryFailure,
} from "./authority.js";
import {
  assertDeliveryIdentifier,
  assertDeliveryItemId,
  assertDeliveryLifecycleSourceRef,
} from "./validation.js";
import {
  deliveryAttemptAuthorizationMatches,
  deliveryDeadlineAt,
  deliveryFailureDisposition,
  deliveryUnknownOutcomeDisposition,
} from "./lifecycle-policy.js";
import type {
  AuthorityDeliveryItem,
  DeliveryApplicationProjection,
  DeliveryApplicationProjectionItem,
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
  DeliveryLifecycleBinding,
  DeliveryLifecycleAdmission,
  DeliveryLifecycleRestoration,
  DeliveryLifecycleSourceRef,
  DeliveryResponseLossEvidence,
} from "./types.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { canonicalize } from "../protocol/index.js";

export type DeliveryUncertainResolutionChoice =
  | "user-verified-sent"
  | "abandon"
  | "retry-risk-ack";

declare const DELIVERY_RESOLUTION_FENCE: unique symbol;
export type DeliveryResolutionFence = string & {
  readonly [DELIVERY_RESOLUTION_FENCE]: "delivery-resolution-fence";
};

/** Delivery-owned command for resolving one uncertain delivery attempt. */
export interface DeliveryUncertainResolutionCommand {
  readonly requestId: string;
  readonly itemId: string;
  readonly attempt: number;
  readonly resolutionFence: DeliveryResolutionFence;
  readonly openFactDigest: string;
  readonly decision: DeliveryUncertainResolutionChoice;
  readonly principal: Readonly<ControlEnvelope["principal"]>;
}

/** Durable outcome currently returned by the Delivery control admission chain. */
export type DeliveryUncertainResolutionOutcome =
  | {
      readonly kind: "applied" | "replayed";
      readonly canonicalRequestId: string;
      readonly result: ControlResult;
      readonly authorityRevision: number;
      readonly commitLsn?: number;
    }
  | {
      readonly kind: "rejected";
      readonly result: Extract<ControlResult, { readonly status: "rejected" }>;
    };

export interface DeliveryUncertainResolutionDecisionContext {
  readonly projection: DeliveryApplicationProjection;
  readonly transactionAt: string;
}

export type DeliveryUncertainResolutionDecision =
  | { readonly accepted: true; readonly state: DeliveryItemState }
  | {
      readonly accepted: false;
      readonly error: {
        readonly code: "fence-rejected" | "not-found";
        readonly message: string;
        readonly retryable: false;
      };
    };

export type DeliveryUncertainResolutionDecide = (
  context: DeliveryUncertainResolutionDecisionContext,
) => DeliveryUncertainResolutionDecision;

/** Correctness port: admission, authority coordination and durable commit remain mechanisms. */
export interface DeliveryUncertainResolutionCorrectnessPort {
  resolve(
    command: DeliveryUncertainResolutionCommand,
    decide: DeliveryUncertainResolutionDecide,
  ): Promise<DeliveryUncertainResolutionOutcome>;
}

export interface DeliveryUncertainResolutionApplication {
  execute(
    command: DeliveryUncertainResolutionCommand,
  ): Promise<DeliveryUncertainResolutionOutcome>;
}

/** The single Delivery application entry for the uncertain-resolution decision. */
export class DeliveryUncertainResolutionApplicationService
  implements DeliveryUncertainResolutionApplication
{
  constructor(
    private readonly correctness: DeliveryUncertainResolutionCorrectnessPort,
  ) {}

  async execute(
    command: DeliveryUncertainResolutionCommand,
  ): Promise<DeliveryUncertainResolutionOutcome> {
    const frozen = Object.freeze({
      ...command,
      principal: Object.freeze({ ...command.principal }),
    });
    return await this.correctness.resolve(frozen, (context) =>
      decideDeliveryUncertainResolution(
        context.projection,
        {
          itemId: frozen.itemId,
          attempt: frozen.attempt,
          openFactDigest: frozen.openFactDigest,
          decision: frozen.decision,
          by: frozen.principal.surfacePrincipal,
        },
        context.transactionAt,
      ));
  }
}

function decideDeliveryUncertainResolution(
  projection: DeliveryApplicationProjection,
  input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly openFactDigest: string;
    readonly decision: DeliveryUncertainResolutionChoice;
    readonly by: string;
  },
  transactionAt: string,
): DeliveryUncertainResolutionDecision {
  assertDeliveryItemId(input.itemId);
  assertDeliveryDigest(input.openFactDigest, "Delivery open fact");
  assertDeliveryIdentifier(input.by, "Delivery resolution principal");
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
    throw new TypeError("Delivery resolution attempt must be a positive safe integer");
  }
  if (!Number.isFinite(Date.parse(transactionAt))) {
    throw new TypeError("Delivery resolution time must be canonical");
  }
  const item = projection.items.get(input.itemId);
  if (!item) {
    return rejectedUncertainResolution("not-found", "Delivery item does not exist");
  }
  if (
    item.state !== "uncertain" ||
    !item.openFact ||
    input.attempt !== item.currentAttempt ||
    input.openFactDigest !== item.openFact.openFactDigest
  ) {
    return rejectedUncertainResolution(
      "fence-rejected",
      "Delivery resolution does not bind the open attempt",
    );
  }
  return {
    accepted: true,
    state:
      input.decision === "user-verified-sent"
        ? "verified-sent"
        : input.decision === "abandon"
          ? "abandoned"
          : "queued",
  };
}

function rejectedUncertainResolution(
  code: "fence-rejected" | "not-found",
  message: string,
): DeliveryUncertainResolutionDecision {
  return { accepted: false, error: { code, message, retryable: false } };
}

/**
 * A product obligation saying that one already-decided result must be delivered.
 * Retry policy is deliberately absent: Delivery owns it when accepting the obligation.
 */
export interface DeliveryObligation {
  readonly keyBody: DeliveryEnqueueKeyBody;
  readonly intent: Omit<DeliveryIntentDto, "maxAttempts">;
  readonly lifecycleSources?: readonly DeliveryLifecycleSourceRef[];
}

export type DeliveryObligationDecision =
  | {
      readonly accepted: true;
      readonly records: readonly LogicalRecord<unknown>[];
      readonly items: Extract<
        DeliveryEnqueueResult,
        { readonly accepted: true }
      >["items"];
    }
  | { readonly accepted: false; readonly error: AuthorityError };

export interface DeliveryObligationDecisionContext {
  readonly projection: DeliveryApplicationProjection;
  readonly lifecycleAdmission: DeliveryLifecycleAdmissionState | undefined;
}

export type DeliveryObligationDecide = (
  context: DeliveryObligationDecisionContext,
) => DeliveryEnqueueResult;

/** Correctness supplies serialization, the current projection and lifecycle fence only. */
export interface DeliveryObligationCorrectnessPort {
  coordinate<Result>(operation: () => Promise<Result>): Promise<Result>;
  prepare(
    inputs: readonly DeliveryEnqueueInput[],
    commitAt: string,
    decide: DeliveryObligationDecide,
  ): DeliveryEnqueueResult;
}

export interface DeliveryObligationApplication {
  coordinate<Result>(operation: () => Promise<Result>): Promise<Result>;
  prepare(
    obligations: readonly DeliveryObligation[],
    commitAt: string,
  ): DeliveryObligationDecision;
}

/** The single Delivery-owned decision entry for all current producer obligations. */
export class DeliveryObligationApplicationService
  implements DeliveryObligationApplication
{
  readonly #maxAttempts: number;

  constructor(
    private readonly correctness: DeliveryObligationCorrectnessPort,
    options: { readonly maxAttempts?: number } = {},
  ) {
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts <= 0) {
      throw new TypeError("Delivery max attempts must be a positive safe integer");
    }
  }

  coordinate<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.correctness.coordinate(operation);
  }

  prepare(
    obligations: readonly DeliveryObligation[],
    commitAt: string,
  ): DeliveryObligationDecision {
    const inputs = obligations.map((obligation) => ({
      keyBody: obligation.keyBody,
      intent: { ...obligation.intent, maxAttempts: this.#maxAttempts },
      ...(obligation.lifecycleSources
        ? { lifecycleSources: obligation.lifecycleSources }
        : {}),
    }));
    const decision = this.correctness.prepare(inputs, commitAt, (context) =>
      prepareDeliveryEnqueues(
        context.projection,
        inputs,
        commitAt,
        decideDeliveryLifecycleBindings(
          context.projection,
          inputs,
          context.lifecycleAdmission,
        ),
      ));
    if (!decision.accepted) return decision;
    return {
      accepted: true,
      records: decision.records.map(deliveryRecord),
      items: decision.items,
    };
  }
}

export type DeliveryAttemptOutcomePolicy =
  | { readonly kind: "manual-resolution" }
  | { readonly kind: "idempotent-redrive"; readonly windowMs: number };

/** Delivery owns how finite send-effect evidence governs an unknown response. */
export function decideDeliveryAttemptOutcomePolicy(
  evidence: DeliveryResponseLossEvidence,
): DeliveryAttemptOutcomePolicy {
  return evidence.kind === "unverified"
    ? { kind: "manual-resolution" }
    : { kind: "idempotent-redrive", windowMs: evidence.windowMs };
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
    };

export type DeliveryPreflightFailureDecision =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly attempt: number;
      readonly statusRevision: number;
    };

export interface DeliveryLifecycleDecisionContext {
  readonly projection: DeliveryApplicationProjection;
  readonly transactionAt: string;
}

export type DeliveryLifecycleDecisionRecord =
  | Exclude<
      DeliveryStreamRecord,
      { readonly t: "delivery-uncertain" | "delivery-resolved" }
    >
  | {
      readonly t: "delivery-uncertain";
      readonly itemId: string;
      readonly attempt: number;
      readonly openedAt: string;
      readonly statusRevision: number;
    };

export interface DeliveryLifecycleMutation<Value> {
  readonly records: readonly DeliveryLifecycleDecisionRecord[];
  readonly value: Value;
}

export interface DeliveryLifecycleCommit<Value> {
  readonly projection: DeliveryApplicationProjection;
  readonly value: Value;
}

/** Correctness supplies one serialized projection transaction and its durable commit result. */
export interface DeliveryLifecycleCorrectnessPort {
  snapshot(): readonly AuthorityDeliveryItem[];
  transact<Value>(
    decide: (
      context: DeliveryLifecycleDecisionContext,
    ) => DeliveryLifecycleMutation<Value>,
  ): Promise<DeliveryLifecycleCommit<Value>>;
  transactAdmission<Value>(
    decide: (
      context: DeliveryLifecycleAdmissionDecisionContext,
    ) => DeliveryLifecycleAdmissionMutation<Value>,
  ): Promise<Value>;
}

/** Read-only projection mechanism used by the effect driver and Host accepted-work lifecycle. */
export interface DeliveryLifecycleProjectionPort {
  list(): Promise<readonly AuthorityDeliveryItem[]>;
  snapshot(): readonly AuthorityDeliveryItem[];
}

export interface DeliveryLifecycleAdmissionState {
  readonly operationId: string;
  readonly sources: readonly DeliveryLifecycleSourceRef[];
  readonly deliveries: readonly {
    readonly id: string;
    readonly revision: string;
  }[];
  readonly sealed: boolean;
}

export interface DeliveryLifecycleAdmissionDecisionContext {
  readonly projection: DeliveryApplicationProjection;
  readonly admission: DeliveryLifecycleAdmissionState | undefined;
}

export interface DeliveryLifecycleAdmissionMutation<Value> {
  readonly admission: DeliveryLifecycleAdmissionState | undefined;
  readonly value: Value;
}

/** Pipeline-side effects. Delivery owns when and why these effects run. */
export interface DeliveryLifecycleEffectPort {
  closeAdmission(): void;
  waitForQuiescedEffects(): Promise<void>;
  flushQuiescedOnce(): Promise<void>;
  resume(): Promise<void>;
}

export interface DeliveryLifecycleApplication {
  claim(input: {
    readonly itemId: string;
    readonly outcomePolicy?: DeliveryAttemptOutcomePolicy;
  }): Promise<DeliveryClaimResult>;
  recordPreflightFailure(input: {
    readonly itemId: string;
    readonly outcomePolicy: DeliveryAttemptOutcomePolicy;
    readonly error: DeliveryFailure;
  }): Promise<DeliveryPreflightFailureDecision>;
  recordOutcome(input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly outcome: DeliveryOutcome;
    readonly responseBindingDigest: string;
  }): Promise<DeliveryOutcomeDecision>;
  captureAcceptedWork(): readonly { readonly id: string; readonly revision: string }[];
  installAdmission(input: DeliveryLifecycleAdmission): Promise<void>;
  restoreAdmission(input: DeliveryLifecycleRestoration): Promise<void>;
  sealAdmission(operationId: string): Promise<void>;
  releaseAdmission(operationId: string): Promise<void>;
  acceptedWorkItems(
    operationId: string,
  ): Promise<readonly { readonly id: string; readonly revision: string }[]>;
  closeAdmission(effects: DeliveryLifecycleEffectPort): void;
  settleAcceptedWork(input: {
    readonly operationId: string;
    readonly strategy: "immediate" | "drain" | "cancel";
    readonly timeoutMs: number;
    readonly effects: DeliveryLifecycleEffectPort;
  }): Promise<void>;
  resume(effects: DeliveryLifecycleEffectPort): Promise<void>;
}

/**
 * Domain signal that the projection supplied by Correctness violates a
 * Delivery lifecycle invariant. The Correctness adapter maps this signal to
 * its stable storage error contract without making Delivery depend on an
 * Authority implementation type.
 */
export class DeliveryProjectionInvariantError extends Error {
  readonly kind = "delivery-projection-invariant" as const;

  constructor(message: string) {
    super(message);
    this.name = "DeliveryProjectionInvariantError";
  }
}

/**
 * The single Delivery-owned decision entry from a ready item through attempt,
 * uncertain/retry and terminal outcome. Transport and event effects stay outside.
 */
export class DeliveryLifecycleApplicationService
  implements DeliveryLifecycleApplication
{
  readonly #baseRetryDelayMs: number;
  readonly #now: () => number;
  readonly #wait: (delayMs: number) => Promise<void>;

  constructor(
    private readonly correctness: DeliveryLifecycleCorrectnessPort,
    options: {
      readonly baseRetryDelayMs?: number;
      readonly now?: () => number;
      readonly wait?: (delayMs: number) => Promise<void>;
    } = {},
  ) {
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 5_000;
    assertNonNegativeInteger(this.#baseRetryDelayMs, "Delivery retry delay");
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? ((delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  captureAcceptedWork(): readonly { readonly id: string; readonly revision: string }[] {
    return acceptedDeliveryItems(this.correctnessSnapshot());
  }

  async installAdmission(input: DeliveryLifecycleAdmission): Promise<void> {
    const frozen = freezeLifecycleAdmissionInput(input, false);
    await this.correctness.transactAdmission((context) => ({
      admission: decideLifecycleAdmissionInstall(context, frozen),
      value: undefined,
    }));
  }

  async restoreAdmission(input: DeliveryLifecycleRestoration): Promise<void> {
    const frozen = freezeLifecycleAdmissionInput(input, input.sealed);
    await this.correctness.transactAdmission((context) => ({
      admission: decideLifecycleAdmissionInstall(context, frozen),
      value: undefined,
    }));
  }

  async sealAdmission(operationId: string): Promise<void> {
    assertDeliveryIdentifier(operationId, "Delivery lifecycle operation id");
    await this.correctness.transactAdmission((context) => {
      const admission = requireLifecycleAdmission(context.admission, operationId);
      return {
        admission: Object.freeze({ ...admission, sealed: true }),
        value: undefined,
      };
    });
  }

  async releaseAdmission(operationId: string): Promise<void> {
    assertDeliveryIdentifier(operationId, "Delivery lifecycle operation id");
    await this.correctness.transactAdmission((context) => {
      if (!context.admission) return { admission: undefined, value: undefined };
      requireLifecycleAdmission(context.admission, operationId);
      return { admission: undefined, value: undefined };
    });
  }

  async acceptedWorkItems(
    operationId: string,
  ): Promise<readonly { readonly id: string; readonly revision: string }[]> {
    assertDeliveryIdentifier(operationId, "Delivery lifecycle operation id");
    return await this.correctness.transactAdmission((context) => ({
      admission: context.admission,
      value: lifecycleAcceptedDeliveryItems(
        context.projection,
        requireLifecycleAdmission(context.admission, operationId),
      ),
    }));
  }

  closeAdmission(effects: DeliveryLifecycleEffectPort): void {
    effects.closeAdmission();
  }

  async settleAcceptedWork(input: {
    readonly operationId: string;
    readonly strategy: "immediate" | "drain" | "cancel";
    readonly timeoutMs: number;
    readonly effects: DeliveryLifecycleEffectPort;
  }): Promise<void> {
    assertDeliveryIdentifier(input.operationId, "Delivery lifecycle operation id");
    assertNonNegativeInteger(input.timeoutMs, "Delivery lifecycle settlement timeout");
    input.effects.closeAdmission();
    await input.effects.waitForQuiescedEffects();
    if (input.strategy === "immediate") return;

    const deadline = this.#now() + input.timeoutMs;
    while (true) {
      await input.effects.flushQuiescedOnce();
      const pending = await this.acceptedWorkItems(input.operationId);
      if (pending.length === 0) return;
      const uncertain = this.correctnessSnapshot().find((item) => item.state === "uncertain");
      if (uncertain) {
        throw new Error(
          `Delivery ${uncertain.id} has an uncertain outcome that requires the existing user decision`,
        );
      }
      const now = this.#now();
      if (now >= deadline) {
        throw new Error(
          "Delivery accepted work did not reach a durable terminal state before the deadline",
        );
      }
      await this.#wait(Math.min(25, deadline - now));
    }
  }

  resume(effects: DeliveryLifecycleEffectPort): Promise<void> {
    return effects.resume();
  }

  private correctnessSnapshot(): readonly AuthorityDeliveryItem[] {
    return this.correctness.snapshot();
  }

  async claim(input: {
    readonly itemId: string;
    readonly outcomePolicy?: DeliveryAttemptOutcomePolicy;
  }): Promise<DeliveryClaimResult> {
    assertDeliveryItemId(input.itemId);
    const frozen = structuredClone(input);
    const committed = await this.correctness.transact<
      | { readonly kind: "skip" }
      | {
          readonly kind: "send";
          readonly itemId: string;
          readonly attempt: number;
          readonly redrive: boolean;
          readonly responseBindingDigest: string;
        }
      | { readonly kind: "uncertain"; readonly itemId: string }
    >((context) => {
      const item = context.projection.items.get(frozen.itemId);
      if (!item) return noDeliveryMutation({ kind: "skip" });
      if (item.state === "attempting") {
        const started = item.attemptStarted;
        if (!started) throw corruptDeliveryProjection("Open delivery attempt has no start fact");
        if (
          deliveryUnknownOutcomeDisposition(started, context.transactionAt) ===
          "redrive"
        ) {
          return noDeliveryMutation({
            kind: "send",
            itemId: item.id,
            attempt: item.currentAttempt,
            redrive: true,
            responseBindingDigest: deliveryResponseBindingDigest({
              itemId: item.id,
              attempt: started.attempt,
              startedAt: started.startedAt,
            }),
          });
        }
        const uncertain: DeliveryLifecycleDecisionRecord = {
          t: "delivery-uncertain",
          itemId: item.id,
          attempt: item.currentAttempt,
          openedAt: context.transactionAt,
          statusRevision: item.statusRevision + 1,
        };
        return {
          records: [uncertain],
          value: { kind: "uncertain", itemId: item.id },
        };
      }
      if (!isReadyForDeliveryAttempt(item, context.transactionAt)) {
        return noDeliveryMutation({ kind: "skip" });
      }
      if (!frozen.outcomePolicy) return noDeliveryMutation({ kind: "skip" });
      const started = makeAttemptStarted(
        item,
        context.transactionAt,
        frozen.outcomePolicy,
      );
      return {
        records: [started],
        value: {
          kind: "send",
          itemId: item.id,
          attempt: started.attempt,
          redrive: false,
          responseBindingDigest: deliveryResponseBindingDigest({
            itemId: item.id,
            attempt: started.attempt,
            startedAt: started.startedAt,
          }),
        },
      };
    });
    if (committed.value.kind === "skip") return committed.value;
    const item = committed.projection.items.get(committed.value.itemId);
    if (!item) throw corruptDeliveryProjection("Committed delivery item is missing");
    return committed.value.kind === "uncertain"
      ? { kind: "uncertain", item: publicDeliveryItem(item) }
      : {
          ...committed.value,
          item: publicDeliveryItem(item),
        };
  }

  async recordPreflightFailure(input: {
    readonly itemId: string;
    readonly outcomePolicy: DeliveryAttemptOutcomePolicy;
    readonly error: DeliveryFailure;
  }): Promise<DeliveryPreflightFailureDecision> {
    assertDeliveryItemId(input.itemId);
    const frozen = structuredClone(input);
    validateDeliveryFailure(frozen.error);
    if (frozen.error.retryable) {
      throw new TypeError("Delivery preflight failure must be permanent");
    }
    const committed = await this.correctness.transact<DeliveryPreflightFailureDecision>((context) => {
      const item = context.projection.items.get(frozen.itemId);
      if (!item || !isReadyForDeliveryAttempt(item, context.transactionAt)) {
        return noDeliveryMutation({ accepted: false });
      }
      const started = makeAttemptStarted(
        item,
        context.transactionAt,
        frozen.outcomePolicy,
      );
      const failed: DeliveryStreamRecord = {
        t: "failed",
        itemId: item.id,
        attempt: started.attempt,
        error: frozen.error,
        statusRevision: started.statusRevision + 1,
      };
      return {
        records: [started, failed],
        value: {
          accepted: true,
          attempt: started.attempt,
          statusRevision: failed.statusRevision,
        },
      };
    });
    return committed.value;
  }

  async recordOutcome(input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly outcome: DeliveryOutcome;
    readonly responseBindingDigest: string;
  }): Promise<DeliveryOutcomeDecision> {
    assertDeliveryItemId(input.itemId);
    const frozen = structuredClone(input);
    const committed = await this.correctness.transact<
      | { readonly accepted: false }
      | {
          readonly accepted: true;
          readonly itemId: string;
          readonly statusRevision: number;
          readonly retryAt?: string;
        }
    >((context) => {
      const item = context.projection.items.get(frozen.itemId);
      if (
        !item ||
        (item.state !== "attempting" && item.state !== "uncertain") ||
        item.currentAttempt !== frozen.attempt
      ) {
        return noDeliveryMutation({ accepted: false });
      }
      assertDeliveryDigest(frozen.responseBindingDigest, "Delivery response binding");
      const started = item.attemptStarted;
      if (!started) throw corruptDeliveryProjection("Open delivery attempt has no start fact");
      const expectedBindingDigest = deliveryResponseBindingDigest({
        itemId: item.id,
        attempt: started.attempt,
        startedAt: started.startedAt,
      });
      if (frozen.responseBindingDigest !== expectedBindingDigest) {
        return noDeliveryMutation({ accepted: false });
      }
      const statusRevision = item.statusRevision + 1;
      let record: DeliveryStreamRecord;
      if (frozen.outcome.kind === "sent") {
        record = {
          t: "sent",
          itemId: item.id,
          attempt: frozen.attempt,
          ...(frozen.outcome.receipt ? { receipt: frozen.outcome.receipt } : {}),
          statusRevision,
        };
      } else if (deliveryFailureDisposition(
        { ...item, intent: { maxAttempts: item.maxAttempts } },
        frozen.outcome.error,
      ) === "retry") {
        const retryAt = deliveryDeadlineAt(
          context.transactionAt,
          this.#baseRetryDelayMs,
          Math.max(0, item.automaticAttemptsUsed - 1),
        );
        record = {
          t: "retry-scheduled",
          itemId: item.id,
          attempt: frozen.attempt,
          retryAt,
          error: frozen.outcome.error,
          statusRevision,
        };
      } else {
        record = {
          t: "failed",
          itemId: item.id,
          attempt: frozen.attempt,
          error: frozen.outcome.error,
          statusRevision,
        };
      }
      return {
        records: [record],
        value: {
          accepted: true,
          itemId: item.id,
          statusRevision,
          ...(record.t === "retry-scheduled" ? { retryAt: record.retryAt } : {}),
        },
      };
    });
    if (!committed.value.accepted) return committed.value;
    const item = committed.projection.items.get(committed.value.itemId);
    if (!item) throw corruptDeliveryProjection("Committed delivery item is missing");
    return {
      accepted: true,
      state: item.state,
      statusRevision: committed.value.statusRevision,
      ...(committed.value.retryAt ? { retryAt: committed.value.retryAt } : {}),
    };
  }
}

function decideDeliveryLifecycleBindings(
  projection: DeliveryApplicationProjection,
  inputs: readonly DeliveryEnqueueInput[],
  admission: DeliveryLifecycleAdmissionState | undefined,
): readonly (DeliveryLifecycleBinding | undefined)[] {
  if (!admission) return inputs.map(() => undefined);
  const permits = new Map(
    admission.sources.map((source) => [lifecycleSourceKey(source), source]),
  );
  return inputs.map((input) => {
    const sources = input.lifecycleSources;
    if (!sources || sources.length === 0) {
      throw new Error("Delivery source is not part of the frozen lifecycle operation");
    }
    for (const source of sources) {
      assertDeliveryLifecycleSourceRef(source);
      const permit = permits.get(lifecycleSourceKey(source));
      if (!permit || permit.revision !== source.revision) {
        throw new Error("Delivery source is not part of the frozen lifecycle operation");
      }
    }
    const existingId = projection.itemByKey.get(deliveryIdempotencyKey(input.keyBody));
    if (existingId) {
      const existing = projection.items.get(existingId);
      if (!existing) throw corruptDeliveryProjection("Delivery unique index is inconsistent");
      if (existing.intentDigest === deliveryIntentDigest(input.intent)) {
        return existing.lifecycleBinding;
      }
    }
    if (admission.sealed) {
      throw new Error("Delivery producer admission is sealed for the lifecycle operation");
    }
    return Object.freeze({
      operationId: admission.operationId,
      sources: Object.freeze(sources.map((source) => Object.freeze({ ...source }))),
    });
  });
}

function freezeLifecycleAdmissionInput(
  input: DeliveryLifecycleAdmission,
  sealed: boolean,
): DeliveryLifecycleAdmissionState {
  assertDeliveryIdentifier(input.operationId, "Delivery lifecycle operation id");
  const sources = new Map<string, DeliveryLifecycleSourceRef>();
  for (const source of input.sources) {
    assertDeliveryLifecycleSourceRef(source);
    const key = lifecycleSourceKey(source);
    const previous = sources.get(key);
    if (previous && previous.revision !== source.revision) {
      throw new TypeError("Delivery lifecycle source identity has conflicting revisions");
    }
    sources.set(key, Object.freeze({ ...source }));
  }
  const deliveries = new Map<string, string>();
  for (const delivery of input.deliveries) {
    assertDeliveryItemId(delivery.id, "Delivery lifecycle item id");
    if (typeof delivery.revision !== "string" || delivery.revision.length === 0) {
      throw new TypeError("Delivery lifecycle item revision is invalid");
    }
    const previous = deliveries.get(delivery.id);
    if (previous && previous !== delivery.revision) {
      throw new TypeError("Delivery lifecycle item has conflicting revisions");
    }
    deliveries.set(delivery.id, delivery.revision);
  }
  return freezeLifecycleAdmissionState({
    operationId: input.operationId,
    sources: [...sources.values()],
    deliveries: [...deliveries].map(([id, revision]) => ({ id, revision })),
    sealed,
  });
}

function decideLifecycleAdmissionInstall(
  context: DeliveryLifecycleAdmissionDecisionContext,
  incoming: DeliveryLifecycleAdmissionState,
): DeliveryLifecycleAdmissionState {
  const current = context.admission;
  if (!current) {
    return capturePendingLifecycleDeliveries(incoming, context.projection);
  }
  if (current.operationId !== incoming.operationId) {
    throw new Error("Another lifecycle operation owns delivery producer admission");
  }
  const currentSources = canonicalLifecycleSources(current.sources);
  const incomingSources = canonicalLifecycleSources(incoming.sources);
  const sources = current.sources.length === 0 && incoming.sources.length > 0 && !current.sealed
    ? incoming.sources
    : current.sources;
  if (
    incoming.sources.length > 0 &&
    !(current.sources.length === 0 && !current.sealed) &&
    currentSources !== incomingSources
  ) {
    throw new Error("Another lifecycle operation owns delivery producer admission");
  }
  const deliveries = new Map(current.deliveries.map(({ id, revision }) => [id, revision]));
  for (const delivery of incoming.deliveries) {
    const previous = deliveries.get(delivery.id);
    if (previous !== undefined && previous !== delivery.revision) {
      throw new Error("Lifecycle delivery snapshot conflicts with its durable replay");
    }
    deliveries.set(delivery.id, delivery.revision);
  }
  return capturePendingLifecycleDeliveries(
    {
      operationId: current.operationId,
      sources,
      deliveries: [...deliveries].map(([id, revision]) => ({ id, revision })),
      sealed: current.sealed || incoming.sealed,
    },
    context.projection,
  );
}

function capturePendingLifecycleDeliveries(
  admission: DeliveryLifecycleAdmissionState,
  projection: DeliveryApplicationProjection,
): DeliveryLifecycleAdmissionState {
  const deliveries = new Map(admission.deliveries.map(({ id, revision }) => [id, revision]));
  for (const item of projection.items.values()) {
    if (!isPendingDelivery(item.state)) continue;
    const previous = deliveries.get(item.id);
    if (previous !== undefined && previous !== item.intentDigest) {
      throw new Error("Lifecycle delivery revision changed while admission was closing");
    }
    deliveries.set(item.id, item.intentDigest);
  }
  return freezeLifecycleAdmissionState({
    ...admission,
    deliveries: [...deliveries].map(([id, revision]) => ({ id, revision })),
  });
}

function lifecycleAcceptedDeliveryItems(
  projection: DeliveryApplicationProjection,
  admission: DeliveryLifecycleAdmissionState,
): readonly { readonly id: string; readonly revision: string }[] {
  const frozenDeliveries = new Map(
    admission.deliveries.map(({ id, revision }) => [id, revision]),
  );
  const permits = new Map(
    admission.sources.map((source) => [lifecycleSourceKey(source), source.revision]),
  );
  const items = [...projection.items.values()].filter((item) => {
    if (!isPendingDelivery(item.state)) return false;
    const initialRevision = frozenDeliveries.get(item.id);
    if (initialRevision !== undefined) {
      if (initialRevision !== item.intentDigest) {
        throw new Error("Lifecycle delivery item revision changed after it was frozen");
      }
      return true;
    }
    return item.lifecycleBinding?.operationId === admission.operationId;
  }).filter((item) => {
    const binding = item.lifecycleBinding;
    if (!binding || binding.operationId !== admission.operationId) return true;
    for (const source of binding.sources) {
      if (permits.get(lifecycleSourceKey(source)) !== source.revision) {
        throw new Error("Lifecycle delivery binding is outside the frozen source exact-set");
      }
    }
    return true;
  }).map((item) => Object.freeze({ id: item.id, revision: item.intentDigest }));
  return Object.freeze(items.sort((left, right) => left.id.localeCompare(right.id, "en-US")));
}

function acceptedDeliveryItems(
  items: readonly AuthorityDeliveryItem[],
): readonly { readonly id: string; readonly revision: string }[] {
  return Object.freeze(items.filter((item) => isPendingDelivery(item.state))
    .map((item) => Object.freeze({ id: item.id, revision: item.intentDigest }))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US")));
}

function requireLifecycleAdmission(
  admission: DeliveryLifecycleAdmissionState | undefined,
  operationId: string,
): DeliveryLifecycleAdmissionState {
  if (!admission || admission.operationId !== operationId) {
    throw new Error("Lifecycle operation does not own delivery producer admission");
  }
  return admission;
}

function freezeLifecycleAdmissionState(
  state: DeliveryLifecycleAdmissionState,
): DeliveryLifecycleAdmissionState {
  return Object.freeze({
    operationId: state.operationId,
    sources: Object.freeze(state.sources
      .map((source) => Object.freeze({ ...source }))
      .sort(compareLifecycleSources)),
    deliveries: Object.freeze(state.deliveries
      .map((delivery) => Object.freeze({ ...delivery }))
      .sort((left, right) => left.id.localeCompare(right.id, "en-US"))),
    sealed: state.sealed,
  });
}

function canonicalLifecycleSources(sources: readonly DeliveryLifecycleSourceRef[]): string {
  return canonicalize([...sources].sort(compareLifecycleSources));
}

function lifecycleSourceKey(source: DeliveryLifecycleSourceRef): string {
  return `${source.owner}\u0000${source.id}`;
}

function compareLifecycleSources(
  left: DeliveryLifecycleSourceRef,
  right: DeliveryLifecycleSourceRef,
): number {
  return lifecycleSourceKey(left).localeCompare(lifecycleSourceKey(right), "en-US");
}

function isPendingDelivery(state: DeliveryItemState): boolean {
  return state === "queued" ||
    state === "retry-wait" ||
    state === "attempting" ||
    state === "uncertain";
}

function noDeliveryMutation<Value>(value: Value): DeliveryLifecycleMutation<Value> {
  return { records: [], value };
}

function isReadyForDeliveryAttempt(
  item: DeliveryApplicationProjectionItem,
  at: string,
): boolean {
  if (item.state === "queued") return true;
  if (item.state !== "retry-wait") return false;
  if (item.nextAttemptAt === undefined) {
    throw corruptDeliveryProjection("Retrying delivery item has no retry deadline");
  }
  return Date.parse(item.nextAttemptAt) <= Date.parse(at);
}

function makeAttemptStarted(
  item: DeliveryApplicationProjectionItem,
  at: string,
  outcomePolicy: DeliveryAttemptOutcomePolicy,
): Extract<DeliveryStreamRecord, { readonly t: "attempt-started" }> {
  const attempt = item.currentAttempt + 1;
  const authorization = item.pendingManualRetryFactDigest
    ? ({
        kind: "manual",
        resolutionFactDigest: item.pendingManualRetryFactDigest,
      } as const)
    : ({ kind: "automatic" } as const);
  if (!deliveryAttemptAuthorizationMatches(
    { ...item, intent: { maxAttempts: item.maxAttempts } },
    authorization,
  )) {
    throw corruptDeliveryProjection("Ready delivery item exceeds its attempt policy");
  }
  const unknownOutcome =
    outcomePolicy.kind === "manual-resolution"
      ? ({ kind: "manual-resolution" } as const)
      : ({
          kind: "idempotent-redrive",
          redriveUntil: deliveryDeadlineAt(
            at,
            requirePositiveInteger(outcomePolicy.windowMs, "Delivery redrive window"),
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

function publicDeliveryItem(
  item: DeliveryApplicationProjectionItem,
): AuthorityDeliveryItem {
  const { attemptStarted: _attemptStarted, ...projection } = item;
  return Object.freeze(projection);
}

function corruptDeliveryProjection(message: string): DeliveryProjectionInvariantError {
  return new DeliveryProjectionInvariantError(message);
}

function assertDeliveryDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export const DELIVERY_RESOLVE_UNCERTAIN_COMMAND = defineProductApiCommand<
  "delivery.command.resolve-uncertain",
  DeliveryUncertainResolutionCommand,
  DeliveryUncertainResolutionOutcome,
  never
>("delivery.command.resolve-uncertain", []);

export const DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [DELIVERY_RESOLVE_UNCERTAIN_COMMAND],
  factEvents: [],
});

/** Delivery-owned Product API contribution; live status notices remain outside Product API facts. */
export function createDeliveryResolutionProductApiContribution(
  application: DeliveryUncertainResolutionApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(DELIVERY_RESOLVE_UNCERTAIN_COMMAND, async (command) => ({
        result: await application.execute(command),
        facts: [],
      })),
    ],
    factEvents: [],
  });
}
