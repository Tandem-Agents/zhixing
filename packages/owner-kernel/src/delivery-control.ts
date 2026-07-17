import {
  DELIVERY_STREAM,
  decideDeliveryResolution,
  deliveryResolutionStatusNotice,
  deliveryRecord,
  emptyDeliveryProjection,
  reduceDeliveryAuthorityRecord,
  type DeliveryAuthority,
  type DeliveryProjection,
} from "@zhixing/core/delivery";
import type {
  DeliveryStatusNotice,
  DeliveryStreamRecord,
  LogicalRecord,
} from "@zhixing/core/contracts";
import type {
  ControlAdmissionJournal,
  ControlAdmissionOutcome,
  DeliveryControlEnvelope,
  TrustedControlSource,
} from "./control-admission.js";

export async function applyDeliveryResolutionControl(input: {
  readonly admission: ControlAdmissionJournal;
  readonly authority: DeliveryAuthority;
  readonly envelope: DeliveryControlEnvelope;
  readonly source: TrustedControlSource;
  readonly onResolved?: (
    notice: Extract<DeliveryStatusNotice, { state: "delivery-resolved" }>,
  ) => void | Promise<void>;
}): Promise<ControlAdmissionOutcome> {
  let applied:
    | Extract<DeliveryStreamRecord, { t: "delivery-resolved" }>
    | undefined;
  const outcome = await input.authority.coordinate(() =>
    input.admission.applyAuthority<DeliveryProjection, DeliveryControlEnvelope>({
    envelope: input.envelope,
    source: input.source,
    stream: DELIVERY_STREAM,
    initial: emptyDeliveryProjection(),
    reducer: (state, record, commit) =>
      reduceDeliveryAuthorityRecord(
        state,
        record as LogicalRecord<DeliveryStreamRecord>,
        commit,
      ),
    decide: (state, context) => {
      const body = context.envelope.body;
      const decision = decideDeliveryResolution(
        state,
        {
          itemId: body.itemId,
          attempt: body.attempt,
          anchorEpoch: body.anchorEpoch,
          openFactDigest: body.openFactDigest,
          decision: body.decision,
          by: context.envelope.principal.surfacePrincipal,
        },
        context.authorityPrefix,
        input.authority.anchorEpoch,
      );
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
    }),
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
}
