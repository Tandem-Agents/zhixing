import type { AuthorityError, GlobalStagedMutation } from "@zhixing/core/contracts";
import type { ConversationMutationPublisher } from "./conversation-assignment.js";
import type { GlobalMutationCommitCoordinator } from "./global-mutation-commit-coordinator.js";
import type { ScheduleDefinitionSource } from "./scheduler-mutation-commit.js";

export interface SchedulerConversationMutationPublisherOptions {
  readonly anchorEpoch: number;
  readonly coordinator: GlobalMutationCommitCoordinator;
  readonly sourceForAssignment: (assignmentId: string) => ScheduleDefinitionSource;
}

/** Publishes conversation-staged global writes in the conversation commit. */
export class SchedulerConversationMutationPublisher
  implements ConversationMutationPublisher
{
  readonly #options: SchedulerConversationMutationPublisherOptions;

  constructor(options: SchedulerConversationMutationPublisherOptions) {
    this.#options = options;
  }

  get readProjectionIds(): readonly string[] {
    return this.#options.coordinator.readProjectionIds;
  }

  async decideGlobalBatchAtPrefix(
    input: Parameters<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[0],
  ): Promise<Awaited<ReturnType<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>>> {
    return (await this.prepareGlobalBatchAtPrefix(input)).outcomes;
  }

  async prepareGlobalBatchAtPrefix(
    input: Parameters<ConversationMutationPublisher["decideGlobalBatchAtPrefix"]>[0],
  ) {
    const admissible: Array<{
      readonly seq: number;
      readonly requestId: string;
      readonly mutation: GlobalStagedMutation;
    }> = [];
    const outcomes = new Map<number, Awaited<ReturnType<
      ConversationMutationPublisher["decideGlobalBatchAtPrefix"]
    >>[number]["outcome"]>();
    for (const record of input.records) {
      if (record.expected.anchorEpoch !== this.#options.anchorEpoch) {
        outcomes.set(record.seq, conflict("fence-rejected", "Global anchor epoch is stale"));
      } else {
        admissible.push({
          seq: record.seq,
          requestId: record.requestId,
          mutation: record.mutation,
        });
      }
    }
    const prepared = await this.#options.coordinator.prepare({
      assignmentId: input.assignmentId,
      records: admissible,
      context: input.authorityContext,
      source: this.#options.sourceForAssignment(input.assignmentId),
    });
    for (const [seq, outcome] of prepared.outcomes) outcomes.set(seq, outcome);
    return {
      records: prepared.records,
      outcomes: input.records.map((record) => ({
        seq: record.seq,
        outcome: outcomes.get(record.seq) ??
          conflict("invalid", "Global mutation decision is missing"),
      })),
    };
  }

  async apply(input: Parameters<ConversationMutationPublisher["apply"]>[0]): Promise<void> {
    if (input.domain !== "global") {
      throw new Error("This publisher only materializes global mutations");
    }
    await this.#options.coordinator.apply({
      ...input,
      mutation: input.mutation as GlobalStagedMutation,
    });
  }
}

function conflict(
  code: AuthorityError["code"],
  message: string,
) {
  return { t: "conflicted" as const, error: { code, message, retryable: false } };
}
