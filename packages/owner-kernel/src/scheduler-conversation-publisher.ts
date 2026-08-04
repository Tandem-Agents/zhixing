import type {
  AuthorityError,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import type { ConversationMutationPublisher } from "./conversation-assignment.js";
import type {
  GlobalMutationCommitParticipant,
  GlobalMutationCommitRecord,
} from "./global-mutation-participant.js";
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
  readonly participants?: readonly GlobalMutationCommitParticipant[];
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
    const scheduleRecords: Array<GlobalMutationCommitRecord & {
      readonly mutation: ScheduleWriteMutation;
    }> = [];
    const participantRecords = new Map<
      GlobalMutationCommitParticipant,
      GlobalMutationCommitRecord[]
    >();
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
        const owners = (this.#options.participants ?? []).filter((participant) =>
          participant.ownsStagedMutation(record.mutation),
        );
        if (owners.length > 1) {
          throw new Error("A staged global mutation has multiple anchor owners");
        }
        const owner = owners[0];
        if (owner) {
          const owned = participantRecords.get(owner) ?? [];
          owned.push({
            seq: record.seq,
            requestId: record.requestId,
            mutation: record.mutation,
          });
          participantRecords.set(owner, owned);
          continue;
        }
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
    const plannedRecords: import("@zhixing/core/contracts").LogicalRecord[] = [
      ...plan.records,
    ];
    for (const [participant, records] of participantRecords) {
      const prepared = participant.prepareStagedMutations({
        assignmentId: input.assignmentId,
        authorityPrefixLsn: input.authorityPrefixLsn,
        records,
      });
      plannedRecords.push(...prepared.records);
      for (const [seq, outcome] of prepared.outcomes) outcomes.set(seq, outcome);
    }
    return {
      records: plannedRecords,
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
    if (input.domain !== "global") {
      throw new Error("This publisher only materializes global mutations");
    }
    if (!isScheduleMutation(input.mutation)) {
      const owners = (this.#options.participants ?? []).filter((participant) =>
        participant.ownsStagedMutation(input.mutation as import("@zhixing/core/contracts").GlobalStagedMutation),
      );
      if (owners.length !== 1) {
        throw new Error("Committed global mutation has no unique anchor owner");
      }
      await owners[0]!.applyStagedMutation({
        ...input,
        mutation: input.mutation as import("@zhixing/core/contracts").GlobalStagedMutation,
      });
      return;
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
