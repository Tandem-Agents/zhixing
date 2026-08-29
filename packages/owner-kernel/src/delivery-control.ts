import {
  DELIVERY_STREAM,
  deliveryResolutionStatusNotice,
  deliveryRecord,
  emptyDeliveryProjection,
  reduceDeliveryAuthorityRecord,
  type DeliveryAuthority,
  type DeliveryProjection,
} from "@zhixing/core/delivery";
import type {
  DeliveryUncertainResolutionCommand,
  DeliveryUncertainResolutionCorrectnessPort,
  DeliveryUncertainResolutionDecide,
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
      const source = { principal: command.principal };
      const envelope = createDeliveryControlEnvelope({
        requestId: command.requestId,
        source,
        body: {
          t: "delivery-resolve",
          itemId: command.itemId,
          attempt: command.attempt,
          anchorEpoch: command.anchorEpoch,
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
            const decision = decide({
              projection: state,
              transactionAt: context.authorityPrefix.at,
              currentAnchorEpoch: input.authority.anchorEpoch,
            });
            if (!decision.accepted) {
              return {
                result: { v: 1, status: "rejected", error: decision.error },
              };
            }
            applied = decision.record;
            return {
              result: {
                v: 1,
                status: "ok",
                body: { t: "delivery-resolve", applied: true },
              },
              authorityEntries: [deliveryRecord(decision.record)],
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
