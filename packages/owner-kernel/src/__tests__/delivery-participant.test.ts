import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import type {
  ConversationRunState,
  IngressContext,
  JobOccurrence,
  JobRunState,
  LogicalRecord,
  TaskDefinition,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  createJobCommitFence,
  createJobSealedBundle,
  createMutationBatch,
  jobDeliveryPlanDigest,
  protocolDigest,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  createOwnerDeliveryLifecycleBinding,
  createOwnerDeliveryParticipant,
} from "../delivery-obligation-correctness.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

const NOW = "2026-07-17T02:00:00.000Z";
const DIGEST = `sha256:${"0".repeat(64)}`;
const ARTIFACT_REF = { digest: DIGEST, bytes: 0 } as const;
const CONVERSATION_COMMIT_LIFECYCLE_SOURCE = {
  owner: "conversation" as const,
  id: "conversation-1:run-1",
  revision: "1",
};
const CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE = {
  owner: "assignment" as const,
  id: "local:assignment-conversation",
  revision: protocolDigest("AssignmentDeliveryLifecycleSource", 1, {
    assignmentId: "assignment-conversation",
  }),
};
const JOB_ASSIGNMENT_LIFECYCLE_SOURCE = {
  owner: "assignment" as const,
  id: "local:assignment-job",
  revision: protocolDigest("AssignmentDeliveryLifecycleSource", 1, {
    assignmentId: "assignment-job",
  }),
};

async function participant(maxAttempts?: number) {
  return (await participantFixture(maxAttempts)).owner;
}

async function participantFixture(maxAttempts?: number) {
  const root = await createTempDir("delivery-participant");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  }));
  const authority = new DeliveryAuthority({ log, anchorEpoch: 3 });
  return {
    authority,
    owner: createOwnerDeliveryParticipant({
      authority,
      ...(maxAttempts ? { maxAttempts } : {}),
    }),
  };
}

function deliveryKinds(records: readonly LogicalRecord<unknown>[]) {
  return records.map(
    (record) =>
      (record.body as { readonly keyBody: { readonly kind: string } }).keyBody.kind,
  );
}

function deliveryTexts(records: readonly LogicalRecord<unknown>[]): string[] {
  return records.map((record) => {
    const body = record.body as {
      readonly intent: { readonly content: { readonly text?: string } };
    };
    const text = body.intent.content.text;
    if (text === undefined) throw new Error("delivery fixture has no inline text");
    return text;
  });
}

function stagedMutation(assignmentId: string, target: "turn-origin" | "explicit") {
  return createMutationBatch(assignmentId, [
    {
      v: 1,
      t: "staged-mutation",
      seq: 1,
      domain: "global",
      requestId: `delivery-${assignmentId}`,
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target:
            target === "turn-origin"
              ? { kind: "turn-origin" }
              : {
                  kind: "explicit",
                  target: { channelId: "feishu", to: "chat-2" },
                },
          content: "staged result",
        },
      },
    },
  ]);
}

const channelIngress: IngressContext = {
  kind: "channel",
  surfacePrincipal: "surface:user-1",
  responder: {
    channelId: "feishu",
    platformSubject: "user-1",
    tenant: "tenant-1",
  },
  replyTarget: { channelId: "feishu", to: "chat-1" },
  deviceId: "device-1",
  ingressId: "ingress-1",
  receivedAt: NOW,
};

const runRecord: TranscriptRunRecord = {
  type: "run",
  runId: "run-1",
  runIndex: 1,
  timestamp: NOW,
  messages: [
    { role: "user", content: [{ type: "text", text: "work" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ],
};

function jobFacts() {
  const delivery = { kind: "channel" as const, channel: "feishu", to: "chat-1" };
  const definition: TaskDefinition = {
    taskId: "task-1",
    taskRevision: 1,
    state: "enabled",
    definition: {
      kind: "user",
      origin: { channelId: "feishu", to: "chat-1" },
      spec: {
        name: "Scheduled work",
        enabled: true,
        priority: "urgent",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "work" },
        delivery,
      },
    },
  };
  const occurrence: JobOccurrence = {
    taskId: "task-1",
    jobRunId: "job-run-1",
    scheduledFor: NOW,
    taskRevision: 1,
    deliveryPlan: { delivery, planDigest: jobDeliveryPlanDigest(delivery) },
    state: "running",
  };
  const fence = createJobCommitFence({
    taskId: occurrence.taskId,
    jobRunId: occurrence.jobRunId,
    scheduledFor: occurrence.scheduledFor,
    taskRevision: occurrence.taskRevision,
    deliveryPlanDigest: occurrence.deliveryPlan.planDigest,
    anchorEpoch: 3,
    assignmentId: "assignment-job",
    executorId: "executor-1",
  });
  const bundle = createJobSealedBundle({
    assignmentId: "assignment-job",
    executorId: "executor-1",
    streamFinal: { finalSeq: 1, streamDigest: DIGEST },
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    usageFinal: { reportDigest: DIGEST, upToUsageSeq: 0 },
    dependencyArtifacts: [],
    body: {
      t: "job",
      taskId: occurrence.taskId,
      jobRunId: occurrence.jobRunId,
      fence,
      outcome: { status: "completed", summary: "done" },
      contentAssets: [],
    },
  });
  return { definition, occurrence, bundle };
}

describe("owner delivery participant", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("binds all seven canonical producer paths to the frozen lifecycle source exact-set", async () => {
    const { authority, owner } = await participantFixture();
    const lifecycle = createOwnerDeliveryLifecycleBinding({ authority }).application;
    const facts = jobFacts();
    const conversationRevision = protocolDigest("ConversationDeliveryLifecycleSource", 1, {
      conversationId: "conversation-1",
    });
    const schedulerRevision = protocolDigest("SchedulerAcceptedWork", 1, {
      taskId: facts.occurrence.taskId,
      jobRunId: facts.occurrence.jobRunId,
      scheduledFor: facts.occurrence.scheduledFor,
      taskRevision: facts.occurrence.taskRevision,
      deliveryPlan: facts.occurrence.deliveryPlan,
    });
    await lifecycle.installAdmission({
      operationId: "stop-delivery-producers",
      sources: [
        { owner: "conversation", id: "conversation-1", revision: conversationRevision },
        CONVERSATION_COMMIT_LIFECYCLE_SOURCE,
        CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE,
        JOB_ASSIGNMENT_LIFECYCLE_SOURCE,
        { owner: "scheduler", id: "job-run-1", revision: schedulerRevision },
      ],
      deliveries: [],
    });
    const conversation = owner.prepareConversationCommit({
      at: NOW,
      conversationId: "conversation-1",
      runId: "run-1",
      assignmentId: "assignment-conversation",
      commitRevision: 1,
      conversationLifecycleSource: CONVERSATION_COMMIT_LIFECYCLE_SOURCE,
      assignmentLifecycleSource: CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE,
      ingress: channelIngress,
      runRecord,
      mutationBatch: stagedMutation("assignment-conversation", "turn-origin"),
    });
    const conversationStatus = owner.prepareConversationStatuses([{
      at: NOW,
      conversationId: "conversation-1",
      runId: "run-1",
      state: "uncertain",
      statusRevision: 2,
      ingress: channelIngress,
    }]);
    const control = owner.prepareConversationControlResponses([{
      at: NOW,
      conversationId: "conversation-1",
      requestId: "cancel:conversation-1",
      replyTarget: channelIngress.replyTarget,
      response: "empty-cancel-batch",
    }]);
    const job = owner.prepareJobCommit({
      at: NOW,
      ...facts,
      assignmentLifecycleSource: JOB_ASSIGNMENT_LIFECYCLE_SOURCE,
      mutationBatch: stagedMutation("assignment-job", "explicit"),
    });
    const jobStatus = owner.prepareJobStatuses([{
      at: NOW,
      occurrence: facts.occurrence,
      definition: facts.definition,
      state: "failed",
      statusRevision: 2,
    }]);
    const notice = owner.prepareSchedulerNotices([{
      at: NOW,
      noticeId: "notice-1",
      target: channelIngress.replyTarget,
      text: "notice",
      lifecycleSources: [{ owner: "scheduler", id: "job-run-1", revision: schedulerRevision }],
    }]);
    const results = [conversation, conversationStatus, control, job, jobStatus, notice];
    for (const result of results) {
      if (!result.accepted) throw new Error("lifecycle producer fixture was rejected");
    }
    expect(results.flatMap((result) => deliveryKinds(result.records))).toEqual([
      "conversation-final-delivery",
      "staged-delivery",
      "conversation-status-delivery",
      "conversation-control-response-delivery",
      "job-result-delivery",
      "staged-delivery",
      "job-status-delivery",
      "scheduler-user-notice-delivery",
    ]);
    expect(() => owner.prepareConversationStatuses([{
      at: NOW,
      conversationId: "conversation-successor",
      runId: "run-successor",
      state: "failed",
      statusRevision: 1,
      ingress: channelIngress,
    }])).toThrow("not part of the frozen lifecycle operation");
  });

  it("derives conversation final, staged and non-terminal status deliveries", async () => {
    const owner = await participant();
    const committed = owner.prepareConversationCommit({
      at: NOW,
      conversationId: "conversation-1",
      runId: "run-1",
      assignmentId: "assignment-conversation",
      commitRevision: 1,
      conversationLifecycleSource: CONVERSATION_COMMIT_LIFECYCLE_SOURCE,
      assignmentLifecycleSource: CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE,
      ingress: channelIngress,
      runRecord,
      mutationBatch: stagedMutation("assignment-conversation", "turn-origin"),
    });
    if (!committed.accepted) throw new Error("conversation fixture was rejected");
    const status = owner.prepareConversationStatuses([
      {
        at: NOW,
        conversationId: "conversation-1",
        runId: "run-1",
        state: "uncertain",
        statusRevision: 2,
        ingress: channelIngress,
      },
    ]);
    if (!status.accepted) throw new Error("conversation status fixture was rejected");

    expect(deliveryKinds(committed.records)).toEqual([
      "conversation-final-delivery",
      "staged-delivery",
    ]);
    expect(deliveryKinds(status.records)).toEqual(["conversation-status-delivery"]);
  });

  it("derives job result, staged and non-terminal status deliveries", async () => {
    const owner = await participant();
    const facts = jobFacts();
    const committed = owner.prepareJobCommit({
      at: NOW,
      ...facts,
      assignmentLifecycleSource: JOB_ASSIGNMENT_LIFECYCLE_SOURCE,
      mutationBatch: stagedMutation("assignment-job", "explicit"),
    });
    if (!committed.accepted) throw new Error("job fixture was rejected");
    const status = owner.prepareJobStatuses([
      {
        at: NOW,
        occurrence: facts.occurrence,
        definition: facts.definition,
        state: "failed",
        statusRevision: 2,
      },
    ]);
    if (!status.accepted) throw new Error("job status fixture was rejected");

    expect(deliveryKinds(committed.records)).toEqual([
      "job-result-delivery",
      "staged-delivery",
    ]);
    expect(deliveryKinds(status.records)).toEqual(["job-status-delivery"]);
  });

  it("turns invalid job staged content into a durable per-item conflict", async () => {
    const owner = await participant();
    const facts = jobFacts();
    const mutationBatch = stagedMutation("assignment-job", "explicit");
    const batchRef = ARTIFACT_REF;
    const input = {
      at: NOW,
      ...facts,
      assignmentLifecycleSource: JOB_ASSIGNMENT_LIFECYCLE_SOURCE,
      bundle: {
        ...facts.bundle,
        body: {
          ...facts.bundle.body,
          mutationBatch: { ref: batchRef, sessionCount: 0, globalCount: 1 },
        },
      },
      mutationBatch,
      stagedContentErrors: new Map([
        [
          1,
          {
            code: "invalid" as const,
            message: "Delivery content is invalid or unavailable",
            retryable: false,
          },
        ],
      ]),
    };
    const committed = owner.prepareJobCommit(input);
    if (!committed.accepted) throw new Error("job fixture was rejected");

    expect(deliveryKinds(committed.records)).toEqual(["job-result-delivery"]);
    expect(committed.stagedConflicts.get(1)).toMatchObject({ code: "invalid" });
    const envelope = {
      v: 1 as const,
      lsn: 1,
      at: NOW,
      envelopeDigest: DIGEST,
      entries: [
        {
          stream: "job:task-1",
          body: {
            t: "committed",
            jobRunId: "job-run-1",
            assignmentId: "assignment-job",
            bundle: { ref: ARTIFACT_REF },
            jobRevision: 1,
          },
        },
        ...committed.records,
        {
          stream: "publish",
          body: {
            t: "publish-decision",
            assignmentId: "assignment-job",
            batch: { ref: batchRef },
            sessionCount: 0,
            globalCount: 1,
            outcomes: [
              {
                seq: 1,
                outcome: {
                  t: "conflicted",
                  error: committed.stagedConflicts.get(1)!,
                },
              },
            ],
          },
        },
      ],
    };
    expect(() => owner.assertJobCommit(input, envelope)).not.toThrow();
    expect(() =>
      owner.assertJobCommit(input, {
        ...envelope,
        entries: envelope.entries.filter((entry) => entry.stream !== "publish"),
      }),
    ).toThrow("exactly one publish decision");
    expect(() =>
      owner.assertJobCommit(input, {
        ...envelope,
        entries: envelope.entries.map((entry) =>
          entry.stream === "publish"
            ? {
                ...entry,
                body: {
                  ...entry.body,
                  outcomes: [
                    {
                      seq: 1,
                      outcome: {
                        t: "conflicted",
                        error: {
                          code: "busy",
                          message: "tampered",
                          retryable: true,
                        },
                      },
                    },
                  ],
                },
              }
            : entry,
        ),
      }),
    ).toThrow("does not bind its durable result");
    expect(() =>
      owner.assertJobCommit(input, {
        ...envelope,
        entries: envelope.entries.map((entry) =>
          entry.stream === "publish"
            ? {
                ...entry,
                body: {
                  ...entry.body,
                  outcomes: [
                    {
                      seq: 1,
                      outcome: {
                        t: "conflicted",
                        error: {
                          code: "not-an-authority-error",
                          message: "tampered",
                          retryable: false,
                        },
                      },
                    },
                  ],
                },
              }
            : entry,
        ),
      }),
    ).toThrow("structure is invalid");
  });

  it("does not create a duplicate status delivery for committed results", async () => {
    const owner = await participant();
    const facts = jobFacts();
    const status = owner.prepareJobStatuses([
      {
        at: NOW,
        occurrence: facts.occurrence,
        definition: facts.definition,
        state: "committed",
        statusRevision: 3,
      },
    ]);
    if (!status.accepted) throw new Error("job status fixture was rejected");
    expect(status.records).toEqual([]);
  });

  it("sends only the frozen conversation channel status whitelist with product copy", async () => {
    const owner = await participant();
    const cases: ReadonlyArray<readonly [ConversationRunState, string | undefined]> = [
      ["queued", undefined],
      ["dispatched", undefined],
      ["running", undefined],
      ["cancel-requested", undefined],
      ["committed", undefined],
      ["cancelled", "本次运行已取消。"],
      ["failed", "本次运行失败。"],
      ["expired", "本次请求未能开始执行，已过期。你可以重新发送。"],
      ["uncertain", "本次运行结果不确定，需要你裁决处理方式。"],
    ];

    for (const [index, [state, expected]] of cases.entries()) {
      const result = owner.prepareConversationStatuses([
        {
          at: NOW,
          conversationId: "conversation-1",
          runId: "run-1",
          state,
          statusRevision: index + 1,
          ingress: channelIngress,
        },
      ]);
      if (!result.accepted) throw new Error(`conversation ${state} was rejected`);
      expect(deliveryTexts(result.records), state).toEqual(expected ? [expected] : []);
    }
  });

  it("sends only the frozen job channel status whitelist with product copy", async () => {
    const owner = await participant();
    const facts = jobFacts();
    const cases: ReadonlyArray<readonly [JobRunState, string | undefined]> = [
      ["queued", undefined],
      ["dispatched", undefined],
      ["running", undefined],
      ["cancel-requested", undefined],
      ["committed", undefined],
      ["missed", undefined],
      ["cancelled", "定时任务「Scheduled work」已取消。"],
      ["failed", "定时任务「Scheduled work」运行失败。"],
      ["expired", "定时任务「Scheduled work」本次未能开始执行，已过期；后续计划不受影响。"],
      ["uncertain", "定时任务「Scheduled work」结果不确定，需要你裁决处理方式。"],
    ];

    for (const [index, [state, expected]] of cases.entries()) {
      const result = owner.prepareJobStatuses([
        {
          at: NOW,
          occurrence: facts.occurrence,
          definition: facts.definition,
          state,
          statusRevision: index + 1,
        },
      ]);
      if (!result.accepted) throw new Error(`job ${state} was rejected`);
      expect(deliveryTexts(result.records), state).toEqual(expected ? [expected] : []);
    }
  });

  it("leaves non-delivery staged mutations to their owning commit participant", async () => {
    const owner = await participant();
    const facts = jobFacts();
    const mutationBatch = createMutationBatch("assignment-job", [
      {
        v: 1,
        t: "staged-mutation",
        seq: 1,
        domain: "global",
        requestId: "workscene-assignment-job",
        expected: { anchorEpoch: 3 },
        mutation: { kind: "workscene-create", name: "Research" },
      },
    ]);
    const committed = owner.prepareJobCommit({
      at: NOW,
      ...facts,
      assignmentLifecycleSource: JOB_ASSIGNMENT_LIFECYCLE_SOURCE,
      mutationBatch,
    });
    if (!committed.accepted) throw new Error("job fixture was rejected");

    expect(deliveryKinds(committed.records)).toEqual(["job-result-delivery"]);
  });

  it("conflicts a turn-origin delivery without a durable route instead of rejecting the run", async () => {
    const owner = await participant();
    const committed = owner.prepareConversationCommit({
      at: NOW,
      conversationId: "conversation-1",
      runId: "run-1",
      assignmentId: "assignment-conversation",
      commitRevision: 1,
      conversationLifecycleSource: CONVERSATION_COMMIT_LIFECYCLE_SOURCE,
      assignmentLifecycleSource: CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE,
      ingress: {
        kind: "first-party",
        surfacePrincipal: "surface:user-1",
        deviceId: "device-1",
        ingressId: "ingress-1",
        receivedAt: NOW,
      },
      runRecord,
      mutationBatch: stagedMutation("assignment-conversation", "turn-origin"),
    });

    expect(committed.accepted).toBe(true);
    if (!committed.accepted) return;
    expect(committed.records).toEqual([]);
    expect(committed.stagedConflicts.get(1)).toEqual({
      code: "unavailable-offline",
      message: "Delivery request has no durable route",
      retryable: false,
    });
  });

  it("validates replay identity without recomputing the current retry policy", async () => {
    const original = await participant(3);
    const input = {
      at: NOW,
      conversationId: "conversation-1",
      runId: "run-1",
      assignmentId: "assignment-conversation",
      commitRevision: 1,
      conversationLifecycleSource: CONVERSATION_COMMIT_LIFECYCLE_SOURCE,
      assignmentLifecycleSource: CONVERSATION_ASSIGNMENT_LIFECYCLE_SOURCE,
      ingress: channelIngress,
      runRecord,
    } as const;
    const prepared = original.prepareConversationCommit(input);
    if (!prepared.accepted) throw new Error("conversation fixture was rejected");
    const envelope = {
      v: 1 as const,
      lsn: 1,
      at: NOW,
      envelopeDigest: DIGEST,
      entries: [
        {
          stream: "run:conversation-1",
          body: {
            t: "committed",
            runId: "run-1",
            assignmentId: "assignment-conversation",
            bundle: { ref: ARTIFACT_REF },
            commitRevision: 1,
          },
        },
        ...prepared.records,
      ],
    };

    const upgraded = await participant(5);
    expect(() => upgraded.assertConversationCommit(input, envelope)).not.toThrow();
  });
});
