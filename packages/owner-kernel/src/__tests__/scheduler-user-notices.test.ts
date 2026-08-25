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
import { protocolDigest } from "@zhixing/core/protocol";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

const NOW = "2026-08-02T10:00:00.000Z";

async function createHarness() {
  const root = await createTempDir("scheduler-user-notices");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  }));
  const delivery = new OwnerDeliveryParticipant({
    authority: new DeliveryAuthority({ log, anchorEpoch: 3 }),
  });
  return {
    log,
    delivery,
    notices: new SchedulerUserNoticeJournal({ log, delivery }),
  };
}

describe("SchedulerUserNoticeJournal", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
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

  it("persists one monotonic journal-maintenance notice across attempts and restart", async () => {
    const harness = await createHarness();
    await harness.notices.initializeLiveCursor();
    const months = [{
      month: "2026-06",
      sources: [
        { id: "2026-06-01", expectedDigest: `sha256:${"1".repeat(64)}` },
        { id: "2026-06-02", expectedDigest: `sha256:${"2".repeat(64)}` },
      ],
    }];
    const plan = {
      planDigest: protocolDigest("JournalMaintenancePlan", 1, { months }),
      months,
    } as const;
    const base = {
      noticeId: `journal-maintenance:${plan.planDigest}`,
      kind: "journal-maintenance" as const,
      journalPlan: plan,
      at: NOW,
    };
    const write = (
      state: "prepared" | "open" | "updated" | "closed",
      attempt: number,
      completed: number,
    ) => harness.notices.recordJournalMaintenance({
      ...base,
      state,
      ref: {
        kind: "journal-maintenance",
        planDigest: plan.planDigest,
        monthCount: 1,
        fileCount: 2,
        attempt,
        completed,
      },
      reason: state === "closed" ? "日志凝练已完成。" : "日志凝练处理中。",
      actions: ["可用 /journal 查看状态"],
    });

    await write("prepared", 0, 0);
    await write("open", 1, 0);
    await write("updated", 1, 0);
    await write("open", 2, 0);
    await write("updated", 2, 1);
    await write("closed", 2, 1);

    const reopened = new SchedulerUserNoticeJournal({
      log: harness.log,
      delivery: harness.delivery,
    });
    const [latest] = await reopened.journalMaintenanceStates();
    expect(latest).toMatchObject({
      notice: {
        kind: "journal-maintenance",
        state: "closed",
        ref: { attempt: 2, completed: 1 },
      },
      plan,
    });
    await expect(write("open", 3, 1)).rejects.toThrow(/monotonic/);
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
