import type {
  AuthorityError,
  GlobalStagedMutation,
  MutationBatch,
  PublishRecord,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import type { JobCommitParticipant } from "./job-assignment.js";
import type {
  GlobalMutationCommitParticipant,
  GlobalMutationCommitRecord,
} from "./global-mutation-participant.js";
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
  readonly participants?: readonly GlobalMutationCommitParticipant[];
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
    const participantRecords = new Map<
      GlobalMutationCommitParticipant,
      GlobalMutationCommitRecord[]
    >();

    for (const record of input.mutationBatch.records) {
      if (record.domain === "global" && record.mutation.kind === "delivery-enqueue") {
        continue;
      }
      if (record.domain !== "global") {
        outcomes.set(
          record.seq,
          conflict(
            "capability-gap",
            "This job owner does not publish the staged global mutation domain",
          ),
        );
        continue;
      }
      if (!isScheduleMutation(record.mutation)) {
        const mutation = record.mutation as GlobalStagedMutation;
        const owners = (this.#options.participants ?? []).filter((participant) =>
          participant.ownsStagedMutation(mutation),
        );
        if (owners.length > 1) {
          throw new Error("A job-staged global mutation has multiple anchor owners");
        }
        const owner = owners[0];
        if (!owner) {
          outcomes.set(
            record.seq,
            conflict(
              "capability-gap",
              "This job owner does not publish the staged global mutation domain",
            ),
          );
          continue;
        }
        const owned = participantRecords.get(owner) ?? [];
        owned.push({
          seq: record.seq,
          requestId: record.requestId,
          mutation,
        });
        participantRecords.set(owner, owned);
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
    const plannedRecords: import("@zhixing/core/contracts").LogicalRecord[] = [
      ...plan.records,
    ];
    for (const [participant, records] of participantRecords) {
      const prepared = participant.prepareStagedMutations({
        assignmentId: input.bundle.assignmentId,
        authorityPrefixLsn: input.authorityPrefixLsn,
        records,
      });
      plannedRecords.push(...prepared.records);
      for (const [seq, outcome] of prepared.outcomes) outcomes.set(seq, outcome);
    }
    return { accepted: true as const, records: plannedRecords, outcomes };
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
    for (const participant of this.#options.participants ?? []) {
      const records = input.mutationBatch.records.flatMap((record) =>
        record.domain === "global" &&
        record.mutation.kind !== "delivery-enqueue" &&
        participant.ownsStagedMutation(record.mutation as GlobalStagedMutation)
          ? [{
              seq: record.seq,
              requestId: record.requestId,
              mutation: record.mutation as GlobalStagedMutation,
            }]
          : [],
      );
      if (records.length > 0) {
        await participant.refreshStagedMutations?.(records);
      }
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
