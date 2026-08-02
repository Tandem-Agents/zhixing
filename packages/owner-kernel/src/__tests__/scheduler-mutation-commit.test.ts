import type {
  MutationBatch,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { SchedulerConversationMutationPublisher } from "../scheduler-conversation-publisher.js";
import { SchedulerJobCommitParticipant } from "../scheduler-job-commit.js";
import {
  planScheduleMutationCommit,
  scheduleMutationTaskId,
} from "../scheduler-mutation-commit.js";
import { scheduleTaskIdForRequest } from "../scheduler-authority.js";

const SPEC = {
  name: "daily summary",
  enabled: true,
  priority: "normal" as const,
  schedule: { kind: "interval" as const, everyMs: 60_000 },
  action: { kind: "agent-turn" as const, prompt: "summarize" },
};

describe("scheduler mutation commit planning", () => {
  it("binds trusted source and reserves same-batch revisions atomically", () => {
    const requestId = "schedule:assignment-1:create";
    const taskId = scheduleTaskIdForRequest(requestId);
    const plan = planScheduleMutationCommit({
      records: [
        {
          seq: 1,
          requestId,
          mutation: { kind: "schedule-create", spec: SPEC },
        },
        {
          seq: 2,
          requestId: "schedule:assignment-1:disable",
          mutation: {
            kind: "schedule-set-state",
            taskId,
            taskRevision: 1,
            state: "disabled",
          },
        },
      ],
      definitionFor: () => undefined,
      source: {
        origin: { channelId: "feishu", to: "chat-1", threadId: "thread-1" },
        interactionResponder: {
          channelId: "feishu",
          platformSubject: "user-1",
        },
        createdInTurn: "ingress-1",
      },
    });

    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });
    expect(plan.outcomes.get(2)).toEqual({ t: "granted", targetRevision: 2 });
    expect(plan.records).toHaveLength(2);
    expect(plan.taskIds).toEqual([taskId]);
    expect(plan.records[0]).toMatchObject({
      stream: `job:${taskId}`,
      body: {
        def: {
          definition: {
            origin: { channelId: "feishu", to: "chat-1", threadId: "thread-1" },
            interactionResponder: {
              channelId: "feishu",
              platformSubject: "user-1",
            },
            createdInTurn: "ingress-1",
          },
        },
      },
    });
  });

  it("replays an exact create without producing a second revision", () => {
    const requestId = "schedule:assignment-1:create";
    const first = planScheduleMutationCommit({
      records: [
        { seq: 1, requestId, mutation: { kind: "schedule-create", spec: SPEC } },
      ],
      definitionFor: () => undefined,
      source: { createdInTurn: "ingress-1" },
    });
    const existing = (first.records[0]!.body as { def: TaskDefinition }).def;
    const replay = planScheduleMutationCommit({
      records: [
        { seq: 1, requestId, mutation: { kind: "schedule-create", spec: SPEC } },
      ],
      definitionFor: () => existing,
      source: { createdInTurn: "ingress-1" },
    });

    expect(replay.records).toEqual([]);
    expect(replay.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });
  });
});

describe("scheduler mutation owners", () => {
  it("conversation publisher rejects stale epochs and refreshes committed tasks", async () => {
    const definitions = new Map<string, TaskDefinition>();
    const refresh = vi.fn(async () => {});
    const publisher = new SchedulerConversationMutationPublisher({
      anchorEpoch: 7,
      definitionFor: (taskId) => definitions.get(taskId),
      refresh,
      sourceForAssignment: () => ({ createdInTurn: "ingress-1" }),
    });
    const prepared = publisher.prepareGlobalBatchAtPrefix({
      assignmentId: "assignment-1",
      authorityPrefixLsn: 4,
      records: [
        {
          seq: 1,
          requestId: "create-stale",
          expected: { anchorEpoch: 6 },
          mutation: { kind: "schedule-create", spec: SPEC },
        },
        {
          seq: 2,
          requestId: "create-current",
          expected: { anchorEpoch: 7 },
          mutation: { kind: "schedule-create", spec: SPEC },
        },
      ],
    });
    expect(prepared.outcomes[0]!.outcome).toMatchObject({
      t: "conflicted",
      error: { code: "fence-rejected" },
    });
    expect(prepared.records).toHaveLength(1);

    const definition = (prepared.records[0]!.body as { def: TaskDefinition }).def;
    definitions.set(definition.taskId, definition);
    await publisher.apply({
      assignmentId: "assignment-1",
      seq: 2,
      domain: "global",
      mutation: { kind: "schedule-create", spec: SPEC },
      requestId: "create-current",
      targetRevision: 1,
    });
    expect(refresh).toHaveBeenCalledWith([definition.taskId]);
  });

  it("job apply reconstructs projection work after participant restart", async () => {
    const applied = vi.fn(async () => {});
    const mutation: ScheduleWriteMutation = {
      kind: "schedule-create",
      spec: SPEC,
    };
    const batch = {
      records: [
        {
          v: 1,
          t: "staged-mutation",
          seq: 1,
          domain: "global",
          requestId: "job-create",
          expected: { anchorEpoch: 7 },
          mutation,
        },
      ],
    } as unknown as MutationBatch;
    const restarted = new SchedulerJobCommitParticipant({
      definitionFor: () => undefined,
      applied,
    });

    await restarted.applied({ assignmentId: "assignment-1", mutationBatch: batch });
    expect(applied).toHaveBeenCalledWith([
      scheduleMutationTaskId(mutation, "job-create"),
    ]);
  });
});
