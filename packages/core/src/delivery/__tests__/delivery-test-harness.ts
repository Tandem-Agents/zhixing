import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../../authority/index.js";
import type {
  ArtifactRef,
  DeliveryEnqueueKeyBody,
  DeliveryIntentDto,
  LogicalRecord,
  TranscriptRunRecord,
} from "../../contracts/index.js";
import {
  canonicalize,
  createConversationSealedBundle,
  createJobCommitFence,
  createJobSealedBundle,
  createMutationBatch,
  jobDeliveryPlanDigest,
  mutationBatchArtifact,
  sealedBundleArtifact,
} from "../../protocol/index.js";
import {
  DeliveryAuthority,
  SCHEDULER_USER_NOTICE_STREAM,
  deliveryRecord,
  type DeliveryEnqueueInput,
  type DeliveryEnqueueResult,
} from "../index.js";

export const DELIVERY_TEST_TIME = "2026-07-17T02:00:00.000Z";
const FIXTURE_DIGEST = `sha256:${"0".repeat(64)}` as const;

export async function createDeliveryTestHarness() {
  let now = DELIVERY_TEST_TIME;
  const root = await createTempDir("delivery");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => now,
  });
  const authority = new DeliveryAuthority({ log, anchorEpoch: 7 });

  return {
    root,
    artifacts,
    log,
    authority,
    now: () => new Date(now),
    setNow(value: string) {
      now = value;
    },
    async enqueue(input = deliveryTestInput({ createdAt: now })) {
      return enqueueDelivery(log, artifacts, authority, input);
    },
  };
}

export function deliveryTestInput(
  intentOverrides: Partial<DeliveryIntentDto> = {},
  keyBody: DeliveryEnqueueKeyBody = {
    kind: "conversation-final-delivery",
    conversationId: "conversation-1",
    runId: "run-1",
    commitRevision: 1,
  },
): DeliveryEnqueueInput {
  return {
    keyBody,
    intent: {
      endpoint: {
        kind: "channel",
        target: { channelId: "feishu", to: "user-1" },
      },
      content: { text: "done", markdown: "done" },
      priority: "normal",
      source: { kind: "agent", conversationId: "conversation-1" },
      createdAt: DELIVERY_TEST_TIME,
      maxAttempts: 3,
      ...intentOverrides,
    },
  };
}

export async function enqueueDelivery(
  log: FileAuthorityCommitLog,
  artifacts: FileArtifactStore,
  authority: DeliveryAuthority,
  input: DeliveryEnqueueInput,
): Promise<DeliveryEnqueueResult> {
  const source = await createDeliverySourceFixture(artifacts, input.keyBody);
  return authority.coordinate(async () => (
    await log.transactProjection<Record<string, never>, unknown, DeliveryEnqueueResult>(
      {},
      (state) => state,
      () => {
        const decision = authority.prepareEnqueues([input], input.intent.createdAt);
        if (!decision.accepted || decision.records.length === 0) {
          return { kind: "return", value: decision };
        }
        return {
          kind: "append",
          entries: [
            ...source.records(decision.items[0]!.statusRevision),
            ...decision.records.map(deliveryRecord),
          ],
          value: decision,
        };
      },
      { candidateReferences: source.references },
    )
  ).value);
}

export function deliverySourceRecords(
  key: DeliveryEnqueueKeyBody,
  ref: ArtifactRef,
  targetRevision = 1,
  batchRef = ref,
): LogicalRecord<unknown>[] {
  switch (key.kind) {
    case "conversation-final-delivery":
      return [{
        stream: `run:${key.conversationId}`,
        body: {
          t: "committed",
          runId: key.runId,
          assignmentId: "assignment-source",
          bundle: { ref },
          commitRevision: key.commitRevision,
        },
      }];
    case "conversation-status-delivery":
      return [{
        stream: `run:${key.conversationId}`,
        body: {
          t: "state",
          runId: key.runId,
          statusRevision: key.statusRevision,
          state: "failed",
        },
      }];
    case "job-result-delivery":
      return [{
        stream: `job:${key.taskId}`,
        body: {
          t: "committed",
          jobRunId: key.jobRunId,
          assignmentId: "assignment-source",
          bundle: { ref },
          jobRevision: 1,
        },
      }];
    case "job-status-delivery":
      return [{
        stream: `job:${key.taskId}`,
        body: {
          t: "state",
          jobRunId: key.jobRunId,
          statusRevision: key.statusRevision,
          state: "failed",
        },
      }];
    case "scheduler-user-notice-delivery":
      return [{
        stream: SCHEDULER_USER_NOTICE_STREAM,
        body: {
          t: "scheduler-user-notice",
          noticeId: key.noticeId,
        },
      }];
    case "staged-delivery":
      return [
        {
          stream: "run:test-source",
          body: {
            t: "committed",
            runId: "run:test-source",
            assignmentId: key.assignmentId,
            bundle: { ref },
            commitRevision: 1,
          },
        },
        {
          stream: "publish",
          body: {
            t: "publish-decision",
            assignmentId: key.assignmentId,
            batch: { ref: batchRef },
            sessionCount: 0,
            globalCount: key.mutationSeq,
            outcomes: Array.from({ length: key.mutationSeq }, (_, index) => ({
              seq: index + 1,
              outcome: { t: "granted" as const, targetRevision },
            })),
          },
        },
      ];
  }
}

export async function createDeliverySourceFixture(
  artifacts: FileArtifactStore,
  key: DeliveryEnqueueKeyBody,
): Promise<{
  readonly records: (targetRevision?: number) => LogicalRecord<unknown>[];
  readonly references: readonly ArtifactRef[];
}> {
  if (key.kind === "conversation-status-delivery" || key.kind === "job-status-delivery") {
    return {
      records: (targetRevision) =>
        deliverySourceRecords(key, { digest: FIXTURE_DIGEST, bytes: 0 }, targetRevision),
      references: [],
    };
  }

  if (key.kind === "job-result-delivery") {
    const bundle = createJobSealedBundle({
      assignmentId: "assignment-source",
      executorId: "executor-source",
      streamFinal: { finalSeq: 1, streamDigest: FIXTURE_DIGEST },
      usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      usageFinal: { reportDigest: FIXTURE_DIGEST, upToUsageSeq: 0 },
      dependencyArtifacts: [],
      body: {
        t: "job",
        taskId: key.taskId,
        jobRunId: key.jobRunId,
        fence: createJobCommitFence({
          taskId: key.taskId,
          jobRunId: key.jobRunId,
          scheduledFor: DELIVERY_TEST_TIME,
          taskRevision: 1,
          deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
          anchorEpoch: 1,
          assignmentId: "assignment-source",
          executorId: "executor-source",
        }),
        outcome: { status: "completed", summary: "delivery fixture" },
        contentAssets: [],
      },
    });
    const artifact = sealedBundleArtifact(bundle);
    await artifacts.put(artifact.bytes);
    return {
      records: (targetRevision) =>
        deliverySourceRecords(key, artifact.ref, targetRevision),
      references: [artifact.ref],
    };
  }

  const assignmentId =
    key.kind === "staged-delivery" ? key.assignmentId : "assignment-source";
  const runId =
    key.kind === "conversation-final-delivery" ? key.runId : "run:test-source";
  const conversationId =
    key.kind === "conversation-final-delivery"
      ? key.conversationId
      : "test-source";
  const runRecord: TranscriptRunRecord = {
    type: "run",
    runId,
    runIndex: 1,
    timestamp: DELIVERY_TEST_TIME,
    messages: [],
  };
  const runRecordRef = await artifacts.put(
    Buffer.from(canonicalize(runRecord), "utf8"),
  );
  const batchArtifact =
    key.kind === "staged-delivery"
      ? mutationBatchArtifact(
          createMutationBatch(
            assignmentId,
            Array.from({ length: key.mutationSeq }, (_, index) => ({
              v: 1 as const,
              t: "staged-mutation" as const,
              seq: index + 1,
              domain: "global" as const,
              requestId: `delivery-source-${index + 1}`,
              expected: { anchorEpoch: 1 },
              mutation: {
                kind: "workscene-create" as const,
                name: `Delivery source ${index + 1}`,
              },
            })),
          ),
        )
      : undefined;
  if (batchArtifact) await artifacts.put(batchArtifact.bytes);
  const bundle = createConversationSealedBundle({
    assignmentId,
    executorId: "executor-source",
    streamFinal: { finalSeq: 1, streamDigest: FIXTURE_DIGEST },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: FIXTURE_DIGEST, upToUsageSeq: 0 },
    dependencyArtifacts: [],
    body: {
      t: "conversation",
      runId,
      conversationId,
      ownerEpoch: 1,
      baseRevision: 0,
      runRecord: { ref: runRecordRef },
      contentAssets: [],
      ...(batchArtifact
        ? {
            mutationBatch: {
              ref: batchArtifact.ref,
              sessionCount: 0,
              globalCount: key.kind === "staged-delivery" ? key.mutationSeq : 0,
            },
          }
        : {}),
    },
  });
  const bundleArtifact = sealedBundleArtifact(bundle);
  await artifacts.put(bundleArtifact.bytes);
  const references = [
    runRecordRef,
    ...(batchArtifact ? [batchArtifact.ref] : []),
    bundleArtifact.ref,
  ];
  return {
    records: (targetRevision) =>
      deliverySourceRecords(
        key,
        bundleArtifact.ref,
        targetRevision,
        batchArtifact?.ref,
      ),
    references,
  };
}
