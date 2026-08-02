import type {
  AuthorityError,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import type { ConversationMutationPublisher } from "./conversation-assignment.js";
import {
  planScheduleMutationCommit,
  scheduleMutationTaskId,
  type ScheduleDefinitionSource,
  type SchedulePublishOutcome,
} from "./scheduler-mutation-commit.js";

export interface SchedulerConversationMutationPublisherOptions {
  readonly anchorEpoch: number;
  readonly definitionFor: (taskId: string) => TaskDefinition | undefined;
  readonly refresh: (taskIds: readonly string[]) => Promise<void>;
  readonly sourceForAssignment: (
    assignmentId: string,
  ) => ScheduleDefinitionSource;
}

/** Publishes conversation-staged schedule writes in the conversation commit. */
export class SchedulerConversationMutationPublisher
  implements ConversationMutationPublisher
{
  readonly #options: SchedulerConversationMutationPublisherOptions;

  constructor(options: SchedulerConversationMutationPublisherOptions) {
    this.#options = options;
  }

  decideGlobalBatchAtPrefix(
    input: Parameters<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[0],
  ): ReturnType<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]> {
    return this.prepareGlobalBatchAtPrefix(input).outcomes;
  }

  prepareGlobalBatchAtPrefix(
    input: Parameters<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[0],
  ): NonNullable<
    ReturnType<
      NonNullable<ConversationMutationPublisher["prepareGlobalBatchAtPrefix"]>
    >
  > {
    const outcomes = new Map<number, SchedulePublishOutcome>();
    const scheduleRecords: Array<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: ScheduleWriteMutation;
    }> = [];
    for (const record of input.records) {
      if (record.expected.anchorEpoch !== this.#options.anchorEpoch) {
        outcomes.set(
          record.seq,
          conflict("fence-rejected", "Schedule anchor epoch is stale"),
        );
      } else if (isScheduleMutation(record.mutation)) {
        scheduleRecords.push({
          seq: record.seq,
          requestId: record.requestId,
          mutation: record.mutation,
        });
      } else {
        outcomes.set(
          record.seq,
          conflict(
            "capability-gap",
            "This conversation owner does not publish the staged global mutation domain",
          ),
        );
      }
    }

    const plan = planScheduleMutationCommit({
      records: scheduleRecords,
      definitionFor: this.#options.definitionFor,
      source: this.#options.sourceForAssignment(input.assignmentId),
    });
    for (const [seq, outcome] of plan.outcomes) outcomes.set(seq, outcome);
    return {
      records: plan.records,
      outcomes: input.records.map((record) => ({
        seq: record.seq,
        outcome:
          outcomes.get(record.seq) ??
          conflict("invalid", "Schedule mutation decision is missing"),
      })),
    };
  }

  async apply(
    input: Parameters<ConversationMutationPublisher["apply"]>[0],
  ): Promise<void> {
    if (input.domain !== "global" || !isScheduleMutation(input.mutation)) {
      throw new Error("This publisher only materializes global schedule mutations");
    }
    const taskId = scheduleMutationTaskId(input.mutation, input.requestId);
    await this.#options.refresh([taskId]);
    const definition = this.#options.definitionFor(taskId);
    if (!definition || definition.taskRevision < input.targetRevision) {
      throw new Error("Committed schedule revision is not available for projection");
    }
  }
}

function isScheduleMutation(
  mutation: { readonly kind: string },
): mutation is ScheduleWriteMutation {
  return mutation.kind.startsWith("schedule-");
}

function conflict(
  code: AuthorityError["code"],
  message: string,
): SchedulePublishOutcome {
  return { t: "conflicted", error: { code, message, retryable: false } };
}
