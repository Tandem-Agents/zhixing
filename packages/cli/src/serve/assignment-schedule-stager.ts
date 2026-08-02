import type { ScheduleMutationStager } from "@zhixing/core";
import { scheduleTaskIdForRequest } from "@zhixing/owner-kernel";
import type { ConversationAssignmentLedger } from "@zhixing/executor";

/** One deterministic schedule overlay writer per durable assignment run. */
export function createAssignmentScheduleStager(
  ledger: ConversationAssignmentLedger,
  assignmentId: string,
  anchorEpoch: number,
): ScheduleMutationStager {
  let ordinal = 0;
  return async ({ mutation, operationId }) => {
    ordinal += 1;
    const requestId = `schedule:${assignmentId}:${operationId ?? `operation-${ordinal}`}`;
    const staged = await ledger.stageMutation(assignmentId, {
      domain: "global",
      mutation,
      requestId,
      expected: { anchorEpoch },
    });
    return {
      ...staged,
      ...(mutation.kind === "schedule-create"
        ? { taskId: scheduleTaskIdForRequest(requestId) }
        : {}),
    };
  };
}
