import type {
  AuthorityError,
  ControlEnvelope,
  ControlResult,
  DeliveryEnqueueKeyBody,
  DeliveryIntentDto,
  LogicalRecord,
} from "../contracts/index.js";
import {
  decideDeliveryResolution,
  deliveryRecord,
  prepareDeliveryEnqueues,
  type DeliveryProjection,
  type DeliveryResolutionDecision,
} from "./authority.js";
import type {
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
