import path from "node:path";
import {
  DeliveryAuthority,
  SCHEDULER_USER_NOTICE_STREAM,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { OwnerDeliveryParticipant } from "../delivery-participant.js";
import { SchedulerUserNoticeJournal } from "../scheduler-user-notices.js";

const NOW = "2026-08-02T10:00:00.000Z";

async function createHarness() {
  const root = await createTempDir("scheduler-user-notices");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  const delivery = new OwnerDeliveryParticipant({
    authority: new DeliveryAuthority({ log, anchorEpoch: 3 }),
  });
  return {
    log,
    delivery,
    notices: new SchedulerUserNoticeJournal({ log, delivery }),
  };
}

describe("SchedulerUserNoticeJournal", () => {
  it("atomically prepares and deduplicates missed summaries across restart", async () => {
    const harness = await createHarness();
    const group = {
      groupKey: "feishu:chat-1",
      target: { channelId: "feishu", to: "chat-1" },
      members: [
        {
          taskId: "task-1",
          jobRunId: "job-1",
          taskName: "日报",
          scheduledFor: "2026-08-02T09:00:00.000Z",
        },
        {
          taskId: "task-2",
          jobRunId: "job-2",
          taskName: "提醒",
          scheduledFor: "2026-08-02T09:30:00.000Z",
        },
      ],
    } as const;

    await harness.notices.prepareMissedSummaries([group], NOW);
    const first = await harness.notices.history(0);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "missed-summary",
      state: "prepared",
      ref: { kind: "missed-summary", memberCount: 2 },
    });
    const envelopesAfterFirst = await harness.log.readAll();
    const sourceEnvelope = envelopesAfterFirst.find((envelope) =>
      envelope.entries.some((entry) => entry.stream === SCHEDULER_USER_NOTICE_STREAM),
    );
    expect(sourceEnvelope?.entries.some((entry) => entry.stream === "delivery")).toBe(true);

    const reopened = new SchedulerUserNoticeJournal({
      log: harness.log,
      delivery: harness.delivery,
    });
    await reopened.prepareMissedSummaries([group], NOW);
    expect(await reopened.history(0)).toEqual(first);
    expect(await harness.log.readAll()).toHaveLength(envelopesAfterFirst.length);
  });

  it("uses one scalar commit revision for history and live delivery", async () => {
    const harness = await createHarness();
    await harness.notices.initializeLiveCursor();
    const listener = vi.fn();
    harness.notices.onNotice(listener);

    await harness.notices.prepareMissedSummaries([
      {
        groupKey: "first-party",
        members: [
          {
            taskId: "task-1",
            jobRunId: "job-1",
            taskName: "日报",
            scheduledFor: "2026-08-02T09:00:00.000Z",
          },
        ],
      },
    ], NOW);

    const [notice] = await harness.notices.history(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(notice);
    expect(notice?.revision).toBeGreaterThan(0);
  });

  it("projects a stable per-item publish result through the existing notice history", async () => {
    const harness = await createHarness();
    const records = harness.notices.prepareRecords({
      noticeId: "scheduler-publish:stable",
      kind: "publish-result",
      state: "closed",
      ref: {
        kind: "publish-result",
        taskId: "task-1",
        jobRunId: "job-1",
        assignmentId: "assignment-1",
        seq: 2,
        decision: "conflicted",
      },
      reason: "定时任务未能保存场景修改。",
      actions: ["检查当前内容后重试"],
      at: NOW,
    });
    await harness.log.append(records);

    expect(await harness.notices.history(0)).toEqual([
      expect.objectContaining({
        noticeId: "scheduler-publish:stable",
        kind: "publish-result",
        state: "closed",
        ref: expect.objectContaining({
          assignmentId: "assignment-1",
          seq: 2,
          decision: "conflicted",
        }),
      }),
    ]);
  });

  it("fails closed on an unknown notice field", async () => {
    const harness = await createHarness();
    await harness.log.append([
      {
        stream: SCHEDULER_USER_NOTICE_STREAM,
        body: {
          t: "scheduler-user-notice",
          noticeId: "notice-1",
          kind: "capability-gap",
          state: "open",
          ref: {
            kind: "capability-gap",
            taskId: "task-1",
            jobRunId: "job-1",
            round: 1,
          },
          reason: "missing executor",
          actions: ["检查设备"],
          extra: true,
        },
      },
    ]);
    await expect(harness.notices.history(0)).rejects.toThrow(
      "Scheduler notice fact is invalid",
    );
  });
});
