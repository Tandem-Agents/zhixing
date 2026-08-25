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
  CommittedMutationMaterializationError,
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
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

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

describe("scheduler mutation owners", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("plans competing schedule writes against the exact locked prefix", async () => {
    const root = await createTempDir("schedule-exact-prefix");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
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
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
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

  it("fairly redrives transient pending jobs without requiring another task", async () => {
    const root = await createTempDir("job-publish-lifecycle");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
    await seedPendingPublish(log, artifacts, "task-a", "assignment-a", "request-a");
    await seedPendingPublish(log, artifacts, "task-b", "assignment-b", "request-b");
    const attempts = new Map<string, number>();
    const apply = vi.fn(async (input: { assignmentId: string }) => {
      const attempt = (attempts.get(input.assignmentId) ?? 0) + 1;
      attempts.set(input.assignmentId, attempt);
      if (input.assignmentId === "assignment-a" && attempt < 3) {
        throw new Error("temporary materializer outage");
      }
    });
    const participant = new SchedulerJobCommitParticipant({
      coordinator: { readProjectionIds: [], apply } as unknown as GlobalMutationCommitCoordinator,
      log,
      artifacts,
      retryDelayMs: 5,
      pendingPageSize: 1,
    });

    await participant.start();
    try {
      await vi.waitFor(() => {
        expect(attempts.get("assignment-a")).toBe(3);
        expect(attempts.get("assignment-b")).toBe(1);
      }, { timeout: DURABLE_IO_TEST_TIMEOUT_MS });
    } finally {
      await participant.stop();
    }
    const restarted = new SchedulerJobCommitParticipant({
      coordinator: { readProjectionIds: [], apply } as unknown as GlobalMutationCommitCoordinator,
      log,
      artifacts,
      retryDelayMs: 5,
    });
    await restarted.start();
    await restarted.stop();
    expect(attempts.get("assignment-a")).toBe(3);
    expect(attempts.get("assignment-b")).toBe(1);
  });

  it("does not lose a producer wake while the global drain is idle", async () => {
    const root = await createTempDir("job-publish-idle-wake");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
    const apply = vi.fn(async () => {});
    const participant = new SchedulerJobCommitParticipant({
      coordinator: { readProjectionIds: [], apply } as unknown as GlobalMutationCommitCoordinator,
      log,
      artifacts,
      retryDelayMs: 5,
    });

    await participant.start();
    await seedPendingPublish(log, artifacts, "task-late", "assignment-late", "request-late");
    participant.wakePendingPublishing("task-late");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    await participant.stop();
  });

  it("stops retry timers and fails startup visibly for corrupt pending authority", async () => {
    const root = await createTempDir("job-publish-stop");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
    await seedPendingPublish(log, artifacts, "task-a", "assignment-a", "request-a");
    const apply = vi.fn(async () => {
      throw new Error("temporary materializer outage");
    });
    const participant = new SchedulerJobCommitParticipant({
      coordinator: { readProjectionIds: [], apply } as unknown as GlobalMutationCommitCoordinator,
      log,
      artifacts,
      retryDelayMs: 5,
    });
    await participant.start();
    expect(apply).toHaveBeenCalledTimes(1);
    await participant.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(apply).toHaveBeenCalledTimes(1);

    const corruptRoot = await createTempDir("job-publish-corrupt");
    const corruptArtifacts = new FileArtifactStore(path.join(corruptRoot, "artifacts"));
    const corruptLog = trackAuthorityLog(new FileAuthorityCommitLog(
      path.join(corruptRoot, "authority"),
      corruptArtifacts,
      { clock: () => "2026-08-05T00:00:00.000Z" },
    ));
    const corruptBatch = await seedPendingPublish(
      corruptLog,
      corruptArtifacts,
      "task-corrupt",
      "assignment-corrupt",
      "request-corrupt",
    );
    await corruptArtifacts.delete(corruptBatch.ref);
    const onFatal = vi.fn();
    const corrupt = new SchedulerJobCommitParticipant({
      coordinator: { readProjectionIds: [], apply: vi.fn() } as unknown as GlobalMutationCommitCoordinator,
      log: corruptLog,
      artifacts: corruptArtifacts,
      onFatal,
    });
    await expect(corrupt.start()).rejects.toThrow(
      "Pending job publish authority facts are corrupt",
    );
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("fail-stops a durable pending item whose committed materialization contract is invalid", async () => {
    const root = await createTempDir("job-publish-contract-failure");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => "2026-08-05T00:00:00.000Z",
    }));
    await seedPendingPublish(log, artifacts, "task-invalid", "assignment-invalid", "request-invalid");
    const onFatal = vi.fn();
    const participant = new SchedulerJobCommitParticipant({
      coordinator: {
        readProjectionIds: [],
        apply: async () => {
          throw new CommittedMutationMaterializationError(
            "committed mutation has no materialization owner",
          );
        },
      } as unknown as GlobalMutationCommitCoordinator,
      log,
      artifacts,
      onFatal,
    });

    await expect(participant.start()).rejects.toThrow(
      "Job publish materialization contract is invalid",
    );
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});

async function seedPendingPublish(
  log: FileAuthorityCommitLog,
  artifacts: FileArtifactStore,
  taskId: string,
  assignmentId: string,
  requestId: string,
) {
  const batch = createMutationBatch(assignmentId, [{
    v: 1,
    t: "staged-mutation",
    seq: 1,
    domain: "global",
    requestId,
    expected: { anchorEpoch: 7 },
    mutation: { kind: "schedule-create", spec: SPEC },
  }]);
  const batchArtifact = mutationBatchArtifact(batch);
  expect(await artifacts.put(batchArtifact.bytes)).toEqual(batchArtifact.ref);
  const bundle = createJobSealedBundle({
    assignmentId,
    executorId: "executor-1",
    streamFinal: { finalSeq: 1, streamDigest: `sha256:${"0".repeat(64)}` },
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    usageFinal: { reportDigest: `sha256:${"0".repeat(64)}`, upToUsageSeq: 0 },
    dependencyArtifacts: [],
    body: {
      t: "job",
      taskId,
      jobRunId: `run-${taskId}`,
      fence: createJobCommitFence({
        taskId,
        jobRunId: `run-${taskId}`,
        scheduledFor: "2026-08-05T00:00:00.000Z",
        taskRevision: 1,
        deliveryPlanDigest: `sha256:${"0".repeat(64)}`,
        anchorEpoch: 7,
        assignmentId,
        executorId: "executor-1",
      }),
      outcome: { status: "completed", summary: "done" },
      contentAssets: [],
      mutationBatch: { ref: batchArtifact.ref, sessionCount: 0, globalCount: 1 },
    },
  });
  const bundleArtifact = sealedBundleArtifact(bundle);
  expect(await artifacts.put(bundleArtifact.bytes)).toEqual(bundleArtifact.ref);
  await log.append([
    {
      stream: `job:${taskId}`,
      body: {
        t: "committed",
        jobRunId: `run-${taskId}`,
        assignmentId,
        bundle: { ref: bundleArtifact.ref },
        jobRevision: 1,
      },
    },
    {
      stream: "publish",
      body: {
        t: "publish-decision",
        assignmentId,
        batch: { ref: batchArtifact.ref },
        sessionCount: 0,
        globalCount: 1,
        outcomes: [{ seq: 1, outcome: { t: "granted", targetRevision: 1 } }],
      },
    },
    {
      stream: "publish",
      body: {
        t: "publish-progress",
        assignmentId,
        domain: "global",
        upToSeq: 0,
        state: "pending",
      },
    },
  ]);
  return batchArtifact;
}
