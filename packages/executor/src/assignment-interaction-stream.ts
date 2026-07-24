import type { ConversationAssignmentLedger } from "./assignment-ledger.js";
import type { StreamFrameAppender } from "@zhixing/core/protocol";

export interface AssignmentInteractionStreamProjectionOptions {
  readonly assignmentId: string;
  readonly ledger: Pick<ConversationAssignmentLedger, "interactionStreamEvents">;
  readonly writer: StreamFrameAppender;
  readonly meta: Parameters<StreamFrameAppender["append"]>[1];
  readonly afterRecordSeq?: number;
  readonly signal?: AbortSignal;
}

export interface AssignmentInteractionStreamProjection {
  readonly projected: number;
  readonly lastRecordSeq: number;
}

export async function projectAssignmentInteractionStream(
  options: AssignmentInteractionStreamProjectionOptions,
): Promise<AssignmentInteractionStreamProjection> {
  const events = await options.ledger.interactionStreamEvents(
    options.assignmentId,
  );
  let projected = 0;
  let lastRecordSeq = options.afterRecordSeq ?? 0;
  for (const event of events) {
    if (event.recordSeq <= lastRecordSeq) continue;
    await options.writer.append(
      event.payload,
      options.meta,
      options.signal,
      `interaction:${event.recordSeq}`,
    );
    projected += 1;
    lastRecordSeq = event.recordSeq;
  }
  return { projected, lastRecordSeq };
}
