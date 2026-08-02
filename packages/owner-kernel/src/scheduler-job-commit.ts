import type {
  AuthorityError,
  MutationBatch,
  PublishRecord,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import type { JobCommitParticipant } from "./job-assignment.js";
import {
  planScheduleMutationCommit,
  scheduleMutationTaskId,
} from "./scheduler-mutation-commit.js";

type PublishOutcome = Extract<
  PublishRecord,
  { readonly t: "publish-decision" }
>["outcomes"][number]["outcome"];

export interface SchedulerJobCommitParticipantOptions {
  readonly definitionFor: (taskId: string) => TaskDefinition | undefined;
  readonly applied: (taskIds: readonly string[]) => Promise<void>;
}

/** Atomically publishes job-staged schedule mutations into TaskDefinition streams. */
export class SchedulerJobCommitParticipant implements JobCommitParticipant {
  readonly #options: SchedulerJobCommitParticipantOptions;

  constructor(options: SchedulerJobCommitParticipantOptions) {
    this.#options = options;
  }

  prepare(input: Parameters<JobCommitParticipant["prepare"]>[0]) {
    const outcomes = new Map<number, PublishOutcome>();
    const scheduleRecords: Array<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: ScheduleWriteMutation;
    }> = [];

    for (const record of input.mutationBatch.records) {
      if (record.domain === "global" && record.mutation.kind === "delivery-enqueue") {
        continue;
      }
      if (record.domain !== "global" || !isScheduleMutation(record.mutation)) {
        outcomes.set(
          record.seq,
          conflict(
            "capability-gap",
            "This job owner does not publish the staged global mutation domain",
          ),
        );
        continue;
      }
      scheduleRecords.push({
        seq: record.seq,
        requestId: record.requestId,
        mutation: record.mutation,
      });
    }
    const parent = this.#options.definitionFor(input.occurrence.taskId);
    const source = parent?.definition.kind === "user"
      ? {
          ...(parent.definition.origin
            ? { origin: parent.definition.origin }
            : {}),
          ...(parent.definition.interactionResponder
            ? { interactionResponder: parent.definition.interactionResponder }
            : {}),
          ...(parent.definition.createdInTurn
            ? { createdInTurn: parent.definition.createdInTurn }
            : {}),
        }
      : {};
    const plan = planScheduleMutationCommit({
      records: scheduleRecords,
      definitionFor: this.#options.definitionFor,
      source,
    });
    for (const [seq, outcome] of plan.outcomes) outcomes.set(seq, outcome);
    return { accepted: true as const, records: plan.records, outcomes };
  }

  async applied(input: {
    readonly assignmentId: string;
    readonly mutationBatch: MutationBatch;
  }): Promise<void> {
    const taskIds = input.mutationBatch.records.flatMap((record) =>
      record.domain === "global" && isScheduleMutation(record.mutation)
        ? [scheduleMutationTaskId(record.mutation, record.requestId)]
        : [],
    );
    if (taskIds.length > 0) {
      await this.#options.applied(taskIds);
    }
  }
}

function isScheduleMutation(
  mutation: MutationBatch["records"][number]["mutation"],
): mutation is ScheduleWriteMutation {
  return mutation.kind.startsWith("schedule-");
}

function conflict(
  code: AuthorityError["code"],
  message: string,
): PublishOutcome {
  return { t: "conflicted", error: { code, message, retryable: false } };
}
