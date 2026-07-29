import type {
  ConversationAssignmentLedger,
  InteractionStreamProjectionReceipt,
} from "./assignment-ledger.js";
import type {
  StreamDataFramePayload,
  StreamFrameAppender,
  StreamFrameMeta,
} from "@zhixing/core/protocol";

export interface AssignmentInteractionProjectionWriter {
  appendInteractionProjection(
    payload: StreamDataFramePayload,
    meta: StreamFrameMeta,
    signal: AbortSignal | undefined,
    sourceId: string,
  ): Promise<InteractionStreamProjectionReceipt>;
}

export interface AssignmentInteractionStreamProjectionOptions {
  readonly assignmentId: string;
  readonly ledger: Pick<
    ConversationAssignmentLedger,
    "interactionStreamEvents" | "interactionStreamProjectedUpTo"
  >;
  readonly writer: StreamFrameAppender;
  readonly meta: StreamFrameMeta;
  readonly afterRecordSeq?: number;
  readonly signal?: AbortSignal;
}

export interface AssignmentInteractionStreamProjection {
  readonly projected: number;
  readonly lastRecordSeq: number;
  readonly receipts: readonly InteractionStreamProjectionReceipt[];
}

export async function projectAssignmentInteractionStream(
  options: AssignmentInteractionStreamProjectionOptions,
): Promise<AssignmentInteractionStreamProjection> {
  const durableAfterRecordSeq = isInteractionProjectionWriter(options.writer)
    ? await options.ledger.interactionStreamProjectedUpTo(
        options.assignmentId,
      )
    : undefined;
  const afterRecordSeq =
    durableAfterRecordSeq ?? options.afterRecordSeq ?? 0;
  const events = await options.ledger.interactionStreamEvents(
    options.assignmentId,
  );
  let projected = 0;
  let lastRecordSeq = afterRecordSeq;
  const receipts: InteractionStreamProjectionReceipt[] = [];
  for (const event of events) {
    if (event.recordSeq <= lastRecordSeq) continue;
    const sourceId = `interaction:${event.recordSeq}`;
    if (isInteractionProjectionWriter(options.writer)) {
      receipts.push(
        await options.writer.appendInteractionProjection(
          event.payload,
          options.meta,
          options.signal,
          sourceId,
        ),
      );
    } else {
      await options.writer.append(
        event.payload,
        options.meta,
        options.signal,
        sourceId,
      );
    }
    projected += 1;
    lastRecordSeq = event.recordSeq;
  }
  return { projected, lastRecordSeq, receipts };
}

export function isInteractionProjectionWriter(
  writer: StreamFrameAppender,
): writer is StreamFrameAppender & AssignmentInteractionProjectionWriter {
  return (
    "appendInteractionProjection" in writer &&
    typeof writer.appendInteractionProjection === "function"
  );
}
