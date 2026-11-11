import path from "node:path";
import { DELIVERY_AUTHORITY_PROJECTION_ID, DeliveryAuthority, SCHEDULER_USER_NOTICE_STREAM } from "@zhixing-ai/core/delivery";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  type ProjectionTransactionContext,
} from "@zhixing-ai/core/authority";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createOwnerDeliveryParticipant } from "../delivery-obligation-correctness.js";
import { SchedulerUserNoticeJournal } from "../scheduler-user-notices.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

const NOW = "2026-08-02T10:00:00.000Z";

function inSourceTransaction<T>(
  log: FileAuthorityCommitLog,
  operation: (transaction: ProjectionTransactionContext) => Promise<T>,
): Promise<T> {
  return log.transactDurableProjection<never, T>(
    DELIVERY_AUTHORITY_PROJECTION_ID,
    async (_view, transaction) => ({ kind: "return", value: await operation(transaction) }),
  ).then((result) => result.value);
}

async function createHarness() {
  const root = await createTempDir("scheduler-user-notices");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  }));
  const delivery = createOwnerDeliveryParticipant({
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
    const first = (await harness.notices.page(0)).notices;
    expect(first).toHaveLength(1);
    // 有通道来源的一组：受众随分组事实落下为 channel，终端不认领
    expect(first[0]).toMatchObject({
      kind: "missed-summary",
      state: "prepared",
      ref: { kind: "missed-summary", memberCount: 2 },
      audience: "channel",
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
    expect((await reopened.page(0)).notices).toEqual(first);
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

    const page = await harness.notices.page(0);
    const [notice] = page.notices;
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(notice);
    expect(notice?.revision).toBeGreaterThan(0);
    // 无通道来源的一组是本机第一方汇总；源代际取自权威日志身份，跨页稳定
    expect(notice?.audience).toBe("first-party");
    expect(page).toMatchObject({ more: false, source: expect.stringMatching(/\S/u) });
    expect(page.nextRevision).toBeGreaterThanOrEqual(notice!.revision);
    // 游标在末尾或超前（客户端带来的旧游标）：没有更新的通知，不报错。
    await expect(harness.notices.page(notice!.revision)).resolves.toEqual({ notices: [], nextRevision: notice!.revision, nextSkip: 0, more: false, source: page.source });
    await expect(harness.notices.page(notice!.revision + 1_000)).resolves.toMatchObject({ notices: [], nextRevision: notice!.revision + 1_000, more: false });
  });

  it("reads bounded pages at the source and keeps one envelope's notices together", async () => {
    const harness = await createHarness();
    const draft = (noticeId: string) => ({
      noticeId, kind: "publish-result" as const, state: "closed" as const,
      ref: { kind: "publish-result" as const, taskId: "task-1", jobRunId: "job-1", assignmentId: "assignment-1", seq: 1, decision: "applied" as const },
      reason: "定时任务已创建场景。", actions: ["查看场景"], at: NOW,
    });
    // 一个信封里两条通知，之后三个各一条的信封，中间夹一个不含通知的提交
    const pair = await inSourceTransaction(harness.log, async (transaction) => [
      ...await harness.notices.prepareRecords(draft("n-1"), transaction),
      ...await harness.notices.prepareRecords(draft("n-2"), transaction),
    ]);
    await harness.log.append(pair);
    await harness.log.append([{ stream: "job:noise-fixture", body: { t: "noise" } }]);
    for (const id of ["n-3", "n-4", "n-5"]) {
      await harness.log.append(await inSourceTransaction(harness.log, (transaction) => harness.notices.prepareRecords(draft(id), transaction)));
    }
    const first = await harness.notices.page(0, 0, 2);
    expect(first.notices.map((notice) => notice.noticeId)).toEqual(["n-1", "n-2", "n-3"]);
    expect(first.notices[0]!.revision).toBe(first.notices[1]!.revision);
    expect(first.more).toBe(true);
    expect(first.nextRevision).toBe(first.notices[2]!.revision);
    const second = await harness.notices.page(first.nextRevision, first.nextSkip, 2);
    expect(second.notices.map((notice) => notice.noticeId)).toEqual(["n-4", "n-5"]);
    expect(second.source).toBe(first.source);
    const third = await harness.notices.page(second.nextRevision, second.nextSkip, 2);
    expect(third).toMatchObject({ notices: [], more: false });
    await expect(harness.notices.page(0, 0, 33)).rejects.toThrow(RangeError);
  });

  it("cuts inside one oversized envelope and continues with the skip without losing entries", async () => {
    const harness = await createHarness();
    const reason = "定".repeat(4_000); // 约 12 KB；单条逻辑记录内联上限 32 KiB，一条总能放进 64 KiB 页
    const records = await inSourceTransaction(harness.log, async (transaction) => {
      const all = [];
      for (let seq = 1; seq <= 7; seq++) {
        all.push(...await harness.notices.prepareRecords({
          noticeId: `scheduler-publish:big-${seq}`, kind: "publish-result", state: "closed",
          ref: { kind: "publish-result", taskId: "task-1", jobRunId: "job-1", assignmentId: "assignment-1", seq, decision: "applied" },
          reason, actions: [], at: NOW,
        }, transaction, all));
      }
      return all;
    });
    const envelope = await harness.log.append(records);
    const first = await harness.notices.page(0);
    expect(first.notices.length).toBeGreaterThan(0);
    expect(first.notices.length).toBeLessThan(7);
    expect(first).toMatchObject({ nextRevision: envelope.lsn - 1, nextSkip: first.notices.length, more: true });
    const second = await harness.notices.page(first.nextRevision, first.nextSkip);
    expect([...first.notices, ...second.notices].map((notice) => notice.noticeId))
      .toEqual(Array.from({ length: 7 }, (_, index) => `scheduler-publish:big-${index + 1}`));
    expect(second).toMatchObject({ nextSkip: 0, more: false });
    // 续读游标只能指向紧接其后那个信封；条数等于该信封条数表示已处理完，接着读后面的（这里已无更多）
    await expect(harness.notices.page(first.nextRevision, 7)).resolves.toMatchObject({ notices: [], nextSkip: 0, more: false });
    await expect(harness.notices.page(first.nextRevision, 8)).rejects.toThrow("continuation");
    await expect(harness.notices.page(envelope.lsn, 1)).rejects.toThrow("continuation");
    // live 发布沿同一续读位置：一次发布全部 7 条、不重不漏
    const live: string[] = [];
    const reopened = new SchedulerUserNoticeJournal({ log: harness.log, delivery: harness.delivery });
    reopened.onNotice((notice) => { live.push(notice.noticeId); });
    await reopened.publishNew();
    expect(live).toHaveLength(7);
    expect(new Set(live).size).toBe(7);
  });

  it("projects a stable per-item publish result through the existing notice history", async () => {
    const harness = await createHarness();
    // 与生产一样在源事务里决定；这条通知没有投递目标，不入队
    const records = await inSourceTransaction(harness.log, (transaction) => harness.notices.prepareRecords({
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
    }, transaction));
    await harness.log.append(records);

    expect((await harness.notices.page(0)).notices).toEqual([
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
    // 写入时的索引归约会拒绝它：另开不登记投影的日志实例写下，模拟日志里出现未经校验的记录
    const raw = new FileAuthorityCommitLog(harness.log.rootDir, harness.log.artifactStore, { clock: () => NOW });
    await raw.append([
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
    await raw.stopStorageMaintenance();
    await expect(harness.notices.page(0)).rejects.toThrow(
      "Scheduler notice fact is invalid",
    );
  });
});
