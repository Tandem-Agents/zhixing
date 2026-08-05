import path from "node:path";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type {
  MutationBatch,
  PublishRecord,
  ScheduleWriteMutation,
  TaskDefinition,
} from "@zhixing/core/contracts";
import {
  createJobCommitFence,
  createJobSealedBundle,
  createMutationBatch,
  mutationBatchArtifact,
  sealedBundleArtifact,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { SchedulerConversationMutationPublisher } from "../scheduler-conversation-publisher.js";
import { SchedulerJobCommitParticipant } from "../scheduler-job-commit.js";
import {
  GlobalMutationCommitCoordinator,
} from "../global-mutation-commit-coordinator.js";
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
  it("plans competing schedule writes against the exact locked prefix", async () => {
    const root = await createTempDir("schedule-exact-prefix");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    });
    const coordinator = new GlobalMutationCommitCoordinator({
      log,
      artifacts,
      refreshSchedule: async () => {},
      scheduleDefinitionFor: () => undefined,
    });
    const transact = async (
      assignmentId: string,
      records: readonly {
        seq: number;
        requestId: string;
        mutation: ScheduleWriteMutation;
      }[],
    ) => (await log.transactProjection(
      {},
      (state) => state,
      async (_state, context) => {
        const prepared = await coordinator.prepare({
          assignmentId,
          records,
          context,
          source: { createdInTurn: "ingress-1" },
        });
        return prepared.records.length === 0
          ? { kind: "return" as const, value: prepared.outcomes }
          : {
              kind: "append" as const,
              entries: prepared.records,
              value: prepared.outcomes,
            };
      },
      { readProjectionIds: coordinator.readProjectionIds },
    )).value;

    const createRequestId = "schedule:assignment:create";
    const taskId = scheduleTaskIdForRequest(createRequestId);
    expect((await transact("assignment", [{
      seq: 1,
      requestId: createRequestId,
      mutation: { kind: "schedule-create", spec: SPEC },
    }])).get(1)).toMatchObject({ t: "granted", targetRevision: 1 });

    const results = await Promise.all([
      transact("assignment-a", [{
        seq: 1,
        requestId: "disable-a",
        mutation: {
          kind: "schedule-set-state",
          taskId,
          taskRevision: 1,
          state: "disabled",
        },
      }]),
      transact("assignment-b", [{
        seq: 1,
        requestId: "disable-b",
        mutation: {
          kind: "schedule-set-state",
          taskId,
          taskRevision: 1,
          state: "disabled",
        },
      }]),
    ]);
    expect(results.map((result) => result.get(1)?.t).sort()).toEqual([
      "conflicted",
      "granted",
    ]);
  });

  it("conversation publisher rejects stale epochs and refreshes committed tasks", async () => {
    const definitions = new Map<string, TaskDefinition>();
    const refresh = vi.fn(async () => {});
    const coordinator = {
      readProjectionIds: [],
      prepare: async (input: {
        readonly records: readonly { seq: number; requestId: string; mutation: ScheduleWriteMutation }[];
        readonly source: import("../scheduler-mutation-commit.js").ScheduleDefinitionSource;
      }) => planScheduleMutationCommit({
        records: input.records,
        definitionFor: (taskId) => definitions.get(taskId),
        source: input.source,
      }),
      apply: async (input: { mutation: ScheduleWriteMutation; requestId: string }) => {
        await refresh([scheduleMutationTaskId(input.mutation, input.requestId)]);
      },
    } as unknown as GlobalMutationCommitCoordinator;
    const publisher = new SchedulerConversationMutationPublisher({
      anchorEpoch: 7,
      coordinator,
      sourceForAssignment: () => ({ createdInTurn: "ingress-1" }),
    });
    const prepared = await publisher.prepareGlobalBatchAtPrefix({
      assignmentId: "assignment-1",
      authorityPrefixLsn: 4,
      authorityContext: {
        lastLsn: 4,
        nextLsn: 5,
        at: "2026-01-01T00:00:00.000Z",
        readProjection: () => { throw new Error("unused"); },
      },
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
    const apply = vi.fn(async () => {});
    const coordinator = {
      readProjectionIds: [],
      apply,
    } as unknown as GlobalMutationCommitCoordinator;
    const projection = {
      scan: async () => ({ entries: [], checkpoint: {}, continuation: undefined }),
    };
    const restarted = new SchedulerJobCommitParticipant({
      coordinator,
      log: {
        durableProjection: () => projection,
      } as never,
      artifacts: {} as never,
    });

    await restarted.applyGranted({
      assignmentId: "assignment-1",
      seq: 1,
      mutationBatch: batch,
      outcome: { t: "granted", targetRevision: 1 },
    });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: "assignment-1",
      seq: 1,
      requestId: "job-create",
      targetRevision: 1,
    }));
    expect(applied).not.toHaveBeenCalled();
  });

  it("redrives only granted job side effects and removes the bounded pending fact", async () => {
    const root = await createTempDir("job-publish-redrive");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    });
    const mutation: ScheduleWriteMutation = { kind: "schedule-create", spec: SPEC };
    const batch = createMutationBatch("assignment-1", [
      {
        v: 1,
        t: "staged-mutation",
        seq: 1,
        domain: "global",
        requestId: "job-create",
        expected: { anchorEpoch: 7 },
        mutation,
      },
      {
        v: 1,
        t: "staged-mutation",
        seq: 2,
        domain: "global",
        requestId: "job-conflict",
        expected: { anchorEpoch: 7 },
        mutation: { kind: "schedule-delete", taskId: "other-task", taskRevision: 1 },
      },
    ]);
    const batchArtifact = mutationBatchArtifact(batch);
    expect(await artifacts.put(batchArtifact.bytes)).toEqual(batchArtifact.ref);
    const bundle = createJobSealedBundle({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      streamFinal: { finalSeq: 1, streamDigest: `sha256:${"0".repeat(64)}` },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: `sha256:${"0".repeat(64)}`, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        taskId: "task-1",
        jobRunId: "job-run-1",
        fence: createJobCommitFence({
          taskId: "task-1",
          jobRunId: "job-run-1",
          scheduledFor: "2026-08-05T00:00:00.000Z",
          taskRevision: 1,
          deliveryPlanDigest: `sha256:${"0".repeat(64)}`,
          anchorEpoch: 7,
          assignmentId: "assignment-1",
          executorId: "executor-1",
        }),
        outcome: { status: "completed", summary: "done" },
        contentAssets: [],
        mutationBatch: { ref: batchArtifact.ref, sessionCount: 0, globalCount: 2 },
      },
    });
    const bundleArtifact = sealedBundleArtifact(bundle);
    expect(await artifacts.put(bundleArtifact.bytes)).toEqual(bundleArtifact.ref);
    const decision = {
      t: "publish-decision",
      assignmentId: "assignment-1",
      batch: { ref: batchArtifact.ref },
      sessionCount: 0,
      globalCount: 2,
      outcomes: [
        { seq: 1, outcome: { t: "granted", targetRevision: 1 } },
        {
          seq: 2,
          outcome: {
            t: "conflicted",
            error: { code: "revision-conflict", message: "changed", retryable: false },
          },
        },
      ],
    } satisfies Extract<PublishRecord, { t: "publish-decision" }>;
    let releaseApply!: () => void;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const apply = vi.fn(async () => applyGate);
    const coordinator = {
      readProjectionIds: [],
      apply,
    } as unknown as GlobalMutationCommitCoordinator;
    const participant = new SchedulerJobCommitParticipant({ coordinator, log, artifacts });
    await log.append([
      {
        stream: "job:task-1",
        body: {
          t: "committed",
          jobRunId: "job-run-1",
          assignmentId: "assignment-1",
          bundle: { ref: bundleArtifact.ref },
          jobRevision: 1,
        },
      },
      { stream: "publish", body: decision },
      {
        stream: "publish",
        body: {
          t: "publish-progress",
          assignmentId: "assignment-1",
          domain: "global",
          upToSeq: 0,
          state: "pending",
        },
      },
    ]);

    const firstResume = participant.resumePendingPublishing("task-1");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const concurrentResume = participant.resumePendingPublishing("task-1");
    releaseApply();
    await Promise.all([firstResume, concurrentResume]);
    expect(apply).toHaveBeenCalledTimes(1);
    const restarted = new SchedulerJobCommitParticipant({ coordinator, log, artifacts });
    await restarted.resumePendingPublishing("task-1");
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
