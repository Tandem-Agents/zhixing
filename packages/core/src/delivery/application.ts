import type {
  AuthorityError,
  DeliveryFailure,
  DeliveryItemState,
  ControlEnvelope,
  ControlResult,
  DeliveryEnqueueKeyBody,
  DeliveryIntentDto,
  DeliveryStatusNotice,
  DeliveryStreamRecord,
  LogicalRecord,
} from "../contracts/index.js";
import {
  decideDeliveryResolution,
  deliveryProjectionStatusNotice,
  deliveryResponseBindingDigest,
  deliveryRecord,
  makeDeliveryOpenFact,
  materializeDeliveryItem,
  prepareDeliveryEnqueues,
  projectDeliveryLifecycleRecords,
  validateDeliveryFailure,
  type DeliveryProjection,
  type DeliveryResolutionDecision,
} from "./authority.js";
import { assertDeliveryItemId } from "./validation.js";
import {
  deliveryAttemptAuthorizationMatches,
  deliveryDeadlineAt,
  deliveryFailureDisposition,
  deliveryUnknownOutcomeDisposition,
} from "./lifecycle-policy.js";
import type {
  AuthorityDeliveryItem,
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
  DeliveryLifecycleBinding,
  DeliveryLifecycleSourceRef,
} from "./types.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  type ProductApiContribution,
} from "../product-api/catalog.js";

export type DeliveryUncertainResolutionDecision =
  | "user-verified-sent"
  | "abandon"
  | "retry-risk-ack";

/** Delivery-owned command for resolving one uncertain delivery attempt. */
export interface DeliveryUncertainResolutionCommand {
  readonly requestId: string;
  readonly itemId: string;
  readonly attempt: number;
  readonly anchorEpoch: number;
  readonly openFactDigest: string;
  readonly decision: DeliveryUncertainResolutionDecision;
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
  readonly projection: DeliveryProjection;
  readonly transactionAt: string;
  readonly currentAnchorEpoch: number;
}

export type DeliveryUncertainResolutionDecide = (
  context: DeliveryUncertainResolutionDecisionContext,
) => DeliveryResolutionDecision;

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
      decideDeliveryResolution(
        context.projection,
        {
          itemId: frozen.itemId,
          attempt: frozen.attempt,
          anchorEpoch: frozen.anchorEpoch,
          openFactDigest: frozen.openFactDigest,
          decision: frozen.decision,
          by: frozen.principal.surfacePrincipal,
        },
        { at: context.transactionAt },
        context.currentAnchorEpoch,
      ));
  }
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
  readonly projection: DeliveryProjection;
  readonly lifecycleBindings: readonly (DeliveryLifecycleBinding | undefined)[];
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
        context.lifecycleBindings,
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

export type DeliveryPreflightFailureDecision =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly attempt: number;
      readonly statusRevision: number;
      readonly notice: Extract<DeliveryStatusNotice, { state: "delivery-failed" }>;
    };

export interface DeliveryLifecycleDecisionContext {
  readonly projection: DeliveryProjection;
  readonly transactionAt: string;
  readonly currentAnchorEpoch: number;
}

export interface DeliveryLifecycleMutation<Value> {
  readonly records: readonly DeliveryStreamRecord[];
  readonly value: Value;
}

/** Correctness supplies one serialized projection transaction, authority time and anchor fence. */
export interface DeliveryLifecycleCorrectnessPort {
  transact<Value>(
    decide: (
      context: DeliveryLifecycleDecisionContext,
    ) => DeliveryLifecycleMutation<Value>,
  ): Promise<Value>;
}

/** Read-only projection mechanism used by the effect driver and Host accepted-work lifecycle. */
export interface DeliveryLifecycleProjectionPort {
  list(): Promise<readonly AuthorityDeliveryItem[]>;
  snapshot(): readonly AuthorityDeliveryItem[];
  lifecycleAcceptedWorkItems(
    operationId: string,
  ): Promise<readonly { readonly id: string; readonly revision: string }[]>;
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

  constructor(
    private readonly correctness: DeliveryLifecycleCorrectnessPort,
    options: { readonly baseRetryDelayMs?: number } = {},
  ) {
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 5_000;
    assertNonNegativeInteger(this.#baseRetryDelayMs, "Delivery retry delay");
  }

  async claim(input: {
    readonly itemId: string;
    readonly outcomePolicy?: DeliveryAttemptOutcomePolicy;
  }): Promise<DeliveryClaimResult> {
    assertDeliveryItemId(input.itemId);
    const frozen = structuredClone(input);
    return await this.correctness.transact<DeliveryClaimResult>((context) => {
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
            item: materializeDeliveryItem(item),
            attempt: item.currentAttempt,
            redrive: true,
            responseBindingDigest: deliveryResponseBindingDigest({
              itemId: item.id,
              attempt: started.attempt,
              startedAt: started.startedAt,
            }),
          });
        }
        const open = makeDeliveryOpenFact(
          item,
          started,
          context.currentAnchorEpoch,
        );
        const uncertain: DeliveryStreamRecord = {
          t: "delivery-uncertain",
          itemId: item.id,
          attempt: item.currentAttempt,
          openedAnchorEpoch: context.currentAnchorEpoch,
          openedAt: context.transactionAt,
          openFactDigest: open.openFactDigest,
          statusRevision: item.statusRevision + 1,
        };
        const projected = projectDeliveryLifecycleRecords(
          context.projection,
          [uncertain],
          context.transactionAt,
        );
        return {
          records: [uncertain],
          value: {
            kind: "uncertain",
            item: materializeDeliveryItem(projected.items.get(item.id)!),
            notice: requireDeliveryStatusNotice(
              projected,
              item.id,
              uncertain.statusRevision,
              context.currentAnchorEpoch,
            ) as Extract<DeliveryStatusNotice, { state: "delivery-uncertain" }>,
          },
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
      const projected = projectDeliveryLifecycleRecords(
        context.projection,
        [started],
        context.transactionAt,
      );
      return {
        records: [started],
        value: {
          kind: "send",
          item: materializeDeliveryItem(projected.items.get(item.id)!),
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
    return await this.correctness.transact<DeliveryPreflightFailureDecision>((context) => {
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
      const projected = projectDeliveryLifecycleRecords(
        context.projection,
        [started, failed],
        context.transactionAt,
      );
      return {
        records: [started, failed],
        value: {
          accepted: true,
          attempt: started.attempt,
          statusRevision: failed.statusRevision,
          notice: requireDeliveryStatusNotice(
            projected,
            item.id,
            failed.statusRevision,
            context.currentAnchorEpoch,
          ) as Extract<DeliveryStatusNotice, { state: "delivery-failed" }>,
        },
      };
    });
  }

  async recordOutcome(input: {
    readonly itemId: string;
    readonly attempt: number;
    readonly outcome: DeliveryOutcome;
    readonly responseBindingDigest: string;
  }): Promise<DeliveryOutcomeDecision> {
    assertDeliveryItemId(input.itemId);
    const frozen = structuredClone(input);
    return await this.correctness.transact<DeliveryOutcomeDecision>((context) => {
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
      } else if (deliveryFailureDisposition(item, frozen.outcome.error) === "retry") {
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
      const projected = projectDeliveryLifecycleRecords(
        context.projection,
        [record],
        context.transactionAt,
      );
      const projectedItem = projected.items.get(item.id)!;
      const notice = deliveryProjectionStatusNotice(
        projected,
        item.id,
        statusRevision,
        context.currentAnchorEpoch,
      );
      return {
        records: [record],
        value: {
          accepted: true,
          state: projectedItem.state,
          statusRevision,
          ...(record.t === "retry-scheduled" ? { retryAt: record.retryAt } : {}),
          ...(notice ? { notice } : {}),
        },
      };
    });
  }
}

function noDeliveryMutation<Value>(value: Value): DeliveryLifecycleMutation<Value> {
  return { records: [], value };
}

function isReadyForDeliveryAttempt(
  item: DeliveryProjection["items"] extends Map<string, infer Item> ? Item : never,
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
  item: DeliveryProjection["items"] extends Map<string, infer Item> ? Item : never,
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
  if (!deliveryAttemptAuthorizationMatches(item, authorization)) {
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

function requireDeliveryStatusNotice(
  projection: DeliveryProjection,
  itemId: string,
  statusRevision: number,
  anchorEpoch: number,
): DeliveryStatusNotice {
  const notice = deliveryProjectionStatusNotice(
    projection,
    itemId,
    statusRevision,
    anchorEpoch,
  );
  if (!notice) throw corruptDeliveryProjection("Delivery status transition has no notice");
  return notice;
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
