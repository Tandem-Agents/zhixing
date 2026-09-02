import {
  DELIVERY_STREAM,
  decideDeliveryResolution,
  deliveryResolutionStatusNotice,
  deliveryRecord,
  emptyDeliveryProjection,
  projectDeliveryApplicationProjection,
  reduceDeliveryAuthorityRecord,
  type DeliveryAuthority,
  type DeliveryProjection,
} from "@zhixing/core/delivery";
import type {
  DeliveryUncertainResolutionCommand,
  DeliveryUncertainResolutionCorrectnessPort,
  DeliveryUncertainResolutionDecide,
  DeliveryResolutionFence,
} from "@zhixing/core/delivery/application";
import type {
  DeliveryStatusNotice,
  DeliveryStreamRecord,
  LogicalRecord,
} from "@zhixing/core/contracts";
import type {
  ControlAdmissionJournal,
} from "./control-admission.js";
import { createDeliveryControlEnvelope } from "./control-admission.js";

export function createDeliveryResolutionCorrectnessPort(input: {
  readonly admission: ControlAdmissionJournal;
  readonly authority: DeliveryAuthority;
  readonly clock?: () => string;
  readonly onResolved?: (
    notice: Extract<DeliveryStatusNotice, { state: "delivery-resolved" }>,
  ) => void | Promise<void>;
}): DeliveryUncertainResolutionCorrectnessPort {
  return Object.freeze({
    resolve: async (
      command: DeliveryUncertainResolutionCommand,
      decide: DeliveryUncertainResolutionDecide,
    ) => {
      const requestedAnchorEpoch = parseDeliveryResolutionFence(
        command.resolutionFence,
      );
      const source = { principal: command.principal };
      const envelope = createDeliveryControlEnvelope({
        requestId: command.requestId,
        source,
        body: {
          t: "delivery-resolve",
          itemId: command.itemId,
          attempt: command.attempt,
          anchorEpoch: requestedAnchorEpoch,
          openFactDigest: command.openFactDigest,
          decision: command.decision,
        },
        ...(input.clock ? { at: input.clock() } : {}),
      });
      let applied:
        | Extract<DeliveryStreamRecord, { t: "delivery-resolved" }>
        | undefined;
      const outcome = await input.authority.coordinate(() =>
        input.admission.applyAuthority<DeliveryProjection, typeof envelope>({
          envelope,
          source,
          stream: DELIVERY_STREAM,
          initial: emptyDeliveryProjection(),
          reducer: (state, record, commit) =>
            reduceDeliveryAuthorityRecord(
              state,
              record as LogicalRecord<DeliveryStreamRecord>,
              commit,
            ),
          decide: (state, context) => {
            if (requestedAnchorEpoch !== input.authority.anchorEpoch) {
              return {
                result: {
                  v: 1,
                  status: "rejected",
                  error: {
                    code: "epoch-stale",
                    message: "Delivery resolution targets a stale anchor epoch",
                    retryable: false,
                  },
                },
              };
            }
            const decision = decide({
              projection: projectDeliveryApplicationProjection(state),
              transactionAt: context.authorityPrefix.at,
            });
            if (!decision.accepted) {
              return {
                result: { v: 1, status: "rejected", error: decision.error },
              };
            }
            const authorityDecision = decideDeliveryResolution(
              state,
              {
                itemId: command.itemId,
                attempt: command.attempt,
                anchorEpoch: requestedAnchorEpoch,
                openFactDigest: command.openFactDigest,
                decision: command.decision,
                by: command.principal.surfacePrincipal,
              },
              { at: context.authorityPrefix.at },
              input.authority.anchorEpoch,
            );
            if (!authorityDecision.accepted) {
              return {
                result: { v: 1, status: "rejected", error: authorityDecision.error },
              };
            }
            applied = authorityDecision.record;
            return {
              result: {
                v: 1,
                status: "ok",
                body: { t: "delivery-resolve", applied: true },
              },
              authorityEntries: [deliveryRecord(authorityDecision.record)],
            };
          },
        })
      );
      if (applied && input.onResolved) {
        const notice = deliveryResolutionStatusNotice(applied);
        try {
          void Promise.resolve(input.onResolved(notice)).catch(() => undefined);
        } catch {
          // The authority decision is already durable; live observers are best-effort.
        }
      }
      return outcome;
    },
  });
}

const DELIVERY_RESOLUTION_FENCE_PREFIX = "delivery-resolution-fence:v1:";

/** Correctness/RPC binding for the legacy numeric wire fence. */
export function createDeliveryResolutionFence(
  anchorEpoch: number,
): DeliveryResolutionFence {
  if (!Number.isSafeInteger(anchorEpoch) || anchorEpoch <= 0) {
    throw new TypeError("Delivery resolution anchor epoch must be a positive safe integer");
  }
  return `${DELIVERY_RESOLUTION_FENCE_PREFIX}${anchorEpoch}` as DeliveryResolutionFence;
}

function parseDeliveryResolutionFence(fence: DeliveryResolutionFence): number {
  if (typeof fence !== "string" || !fence.startsWith(DELIVERY_RESOLUTION_FENCE_PREFIX)) {
    throw new TypeError("Delivery resolution fence is invalid");
  }
  const value = Number(fence.slice(DELIVERY_RESOLUTION_FENCE_PREFIX.length));
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== fence.slice(DELIVERY_RESOLUTION_FENCE_PREFIX.length)) {
    throw new TypeError("Delivery resolution fence is invalid");
  }
  return value;
}
