import type { ControlEnvelope, ControlResult } from "../contracts/index.js";
import {
  decideDeliveryResolution,
  type DeliveryProjection,
  type DeliveryResolutionDecision,
} from "./authority.js";
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
