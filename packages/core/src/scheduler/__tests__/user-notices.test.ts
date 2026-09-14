import { describe, expect, it } from "vitest";
import type { TaskDefinition, JobRunState, MutationBatch, PublishRecord } from "../../contracts/index.js";
import { protocolDigest } from "../../protocol/canonical.js";
import { decideScheduleCapabilityGap, decideScheduleCapabilityGapClosure, decideScheduleMissedSummary, decideScheduleStatusNotification, projectSchedulePublishNotices, schedulerNoticeGroupKey } from "../user-notices.js";
import { projectPublishResults, projectPublishConflicts } from "../../conversation/application.js";

const at = "2026-09-14T00:00:00.000Z";
const definition: TaskDefinition = {
  taskId: "task-1", taskRevision: 1, state: "enabled",
  definition: { kind: "user", origin: { channelId: "feishu", to: "chat-1" },
    spec: { name: "整理", enabled: true, priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 }, action: { kind: "agent-turn", prompt: "整理" } },
  },
};
const system: TaskDefinition = { ...definition, definition: { kind: "system", handler: "__transcript-gc" } };

describe("Schedule notification decisions", () => {
  it("keeps gap open/update/dedupe/reopen identities and sends only an opening notice", () => {
    const input = { taskId: "task-1", jobRunId: "job-1", definition, state: "queued" as const, capabilityRevision: 1, reason: "internal gap" };
    const opened = decideScheduleCapabilityGap(input)!;
    expect(opened.notice).toMatchObject({ state: "open", target: { to: "chat-1" }, channelText: expect.stringContaining("已排队等待") });
    expect(opened.notice.reason).not.toContain("internal gap");
    expect(opened.noticeId).toBe(`scheduler-gap:${protocolDigest("SchedulerCapabilityGap", 1, { taskId: "task-1", jobRunId: "job-1", round: 1 })}`);
    const previous = { ...opened, capabilityRevision: 1, reason: input.reason, open: true };
    expect(decideScheduleCapabilityGap({ ...input, previous })).toBeUndefined();
    const updated = decideScheduleCapabilityGap({ ...input, previous, capabilityRevision: 2 })!;
    expect(updated).toMatchObject({ kind: "capability-gap-updated", noticeId: opened.noticeId, round: 1, notice: { state: "updated" } });
    expect(updated.notice.target).toBeUndefined();
    expect(updated.notice.channelText).toBeUndefined();
    const gaps = new Map([["job-1", previous]]);
    for (const kind of ["assigned", "terminal"] as const) {
      const closed = decideScheduleCapabilityGapClosure({ taskId: "task-1", gaps, events: [{ kind, jobRunId: "job-1" }], at })!;
      expect(closed.notice).toMatchObject({ noticeId: opened.noticeId, state: "closed", actions: [] });
      expect(closed.notice.target).toBeUndefined();
    }
    expect(decideScheduleCapabilityGapClosure({ taskId: "task-1", gaps, events: [], at })).toBeUndefined();
    const reopened = decideScheduleCapabilityGap({ ...input, previous: { ...previous, open: false } })!;
    expect(reopened.round).toBe(2);
    expect(reopened.noticeId).not.toBe(opened.noticeId);
    expect(() => decideScheduleCapabilityGap({ ...input, definition: system })).toThrow("System jobs");
    expect(() => decideScheduleCapabilityGap({ ...input, state: "running" })).toThrow("queued user occurrence");
  });

  it("freezes missed membership, grouping, text and identity from the transaction snapshot", () => {
    const members = ["四", "三", "二", "一"].map((taskName, index) => ({
      taskId: `task-${index}`, jobRunId: `job-${index}`, taskName, scheduledFor: at,
    }));
    const group = { groupKey: schedulerNoticeGroupKey({ channelId: "feishu", to: "chat-1" }), target: { channelId: "feishu", to: "chat-1" }, members };
    const draft = decideScheduleMissedSummary(group, new Set(), at)!;
    expect(draft.reason).toBe("设备离线期间，四、三、二等 4 个任务共错过 4 次执行；可查看状态并按需重新运行。");
    expect(draft.channelText).toBe(draft.reason);
    expect(draft.actions).toEqual(["查看任务状态", "按需重新运行"]);
    expect(decideScheduleMissedSummary({ ...group, members: [...members].reverse() }, new Set(), at)).toEqual(draft);
    expect(decideScheduleMissedSummary(group, new Set(draft.missedMembers), at)).toBeUndefined();
    const remaining = decideScheduleMissedSummary(group, new Set(draft.missedMembers!.slice(0, 3)), at)!;
    expect(remaining.ref).toMatchObject({ memberCount: 1 });
    expect(remaining.noticeId).not.toBe(draft.noticeId);
    expect(schedulerNoticeGroupKey(undefined)).toBe("first-party");
    expect(decideScheduleMissedSummary({ groupKey: "first-party", members }, new Set(), at)?.channelText).toBeUndefined();
  });

  it("owns user/origin/status selection without turning successful or missed runs into status deliveries", () => {
    const statuses: JobRunState[] = ["queued", "dispatched", "running", "cancel-requested", "committed", "missed", "cancelled", "failed", "expired", "uncertain"];
    const expected = [
      "定时任务「整理」已取消。", "定时任务「整理」运行失败。",
      "定时任务「整理」本次未能开始执行，已过期；后续计划不受影响。",
      "定时任务「整理」结果不确定，需要你裁决处理方式。",
    ];
    for (const [index, state] of statuses.entries()) {
      expect(decideScheduleStatusNotification({ definition, state })?.text).toBe(expected[index - 6]);
      expect(decideScheduleStatusNotification({ definition: system, state })).toBeUndefined();
      const noOrigin = structuredClone(definition);
      if (noOrigin.definition.kind === "user") delete noOrigin.definition.origin;
      expect(decideScheduleStatusNotification({ definition: noOrigin, state })).toBeUndefined();
    }
  });

  it("shares publish feedback semantics across schedule, live results, conflicts and history without changing raw decisions", () => {
    const batch = { records: [
      { seq: 1, domain: "global", mutation: { kind: "workscene-delete", sceneId: "scene-1" } },
      { seq: 2, domain: "global", mutation: { kind: "workscene-delete", sceneId: "scene-2" } },
      { seq: 3, domain: "global", mutation: { kind: "skill-usage" } },
      { seq: 4, domain: "conversation", mutation: { kind: "other" } },
    ] } as MutationBatch;
    const rawError = { code: "revision-conflict" as const, message: "owner internal diagnostic", retryable: true };
    const outcomes = [
      { seq: 1, outcome: { t: "conflicted", error: rawError } },
      { seq: 2, outcome: { t: "granted", appliedResult: { kind: "workscene-deleted", sceneId: "scene-2" } } },
      { seq: 3, outcome: { t: "granted" } },
      { seq: 4, outcome: { t: "conflicted", error: rawError } },
    ] as Extract<PublishRecord, { t: "publish-decision" }>["outcomes"];
    const input = { taskId: "task-1", jobRunId: "job-1", assignmentId: "assignment-1", definition, batch, outcomes, at };
    const notices = projectSchedulePublishNotices(input);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ kind: "publish-result", state: "closed", reason: "定时任务「整理」未能完成“删除场景”：相关内容已被其他修改更新。", actions: ["查看最新内容后重试", "放弃这项修改"] });
    expect(notices[1]).toMatchObject({ reason: "定时任务「整理」已删除场景。", actions: ["查看场景"] });
    expect(notices[0]!.noticeId).toBe(`scheduler-publish:${protocolDigest("SchedulerPublishResult", 1, { assignmentId: input.assignmentId, seq: 1, outcome: outcomes[0]!.outcome })}`);
    expect(projectSchedulePublishNotices({ ...input, definition: system })).toEqual([]);
    const identity = { conversationId: "conversation-1", runId: "run-1", commitRevision: 1 };
    const results = projectPublishResults({ ...identity, assignmentId: input.assignmentId, batch, decision: { t: "publish-decision", outcomes } as Extract<PublishRecord, { t: "publish-decision" }> });
    expect(results.map((result) => result.seq)).toEqual([1, 2]);
    const conflicts = projectPublishConflicts({ ...identity, conflicts: [{ seq: 1, domain: "global", error: rawError }] });
    expect(results[0]!.decision).toMatchObject({ t: "conflicted", error: { code: "revision-conflict", message: conflicts?.conflicts[0]?.error.message, retryable: true } });
    expect(JSON.stringify(results)).not.toContain("owner internal diagnostic");
    expect(rawError.message).toBe("owner internal diagnostic");
    expect(projectPublishConflicts({ ...identity, conflicts: [] })).toBeUndefined();
  });
});
