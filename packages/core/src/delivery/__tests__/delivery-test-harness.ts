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
} from "../../contracts/index.js";
import {
  DeliveryAuthority,
  deliveryRecord,
  type DeliveryEnqueueInput,
  type DeliveryEnqueueResult,
} from "../index.js";

export const DELIVERY_TEST_TIME = "2026-07-17T02:00:00.000Z";

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
  const sourceRef = await artifacts.put(Buffer.from("delivery-test-source", "utf8"));
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
            ...deliverySourceRecords(
              input.keyBody,
              sourceRef,
              decision.items[0]!.statusRevision,
            ),
            ...decision.records.map(deliveryRecord),
          ],
          value: decision,
        };
      },
      { candidateReferences: [sourceRef] },
    )
  ).value);
}

export function deliverySourceRecords(
  key: DeliveryEnqueueKeyBody,
  ref: ArtifactRef,
  targetRevision = 1,
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
            batch: { ref },
            sessionCount: 0,
            globalCount: 1,
            outcomes: [
              {
                seq: key.mutationSeq,
                outcome: { t: "granted", targetRevision },
              },
            ],
          },
        },
      ];
  }
}
