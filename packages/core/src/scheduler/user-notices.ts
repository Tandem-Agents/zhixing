import type {
  DeliveryTargetDto, SchedulerUserNotice, TaskDefinition, JobRunState,
  GlobalStagedMutation, MutationBatch, PublishRecord, WorksceneAppliedResult,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "../protocol/canonical.js";
import { publishConflictProductCopy } from "../conversation/application.js";
import { projectDeliveryDisplayText } from "../delivery/index.js";

export interface SchedulerNoticeDraft {
  readonly noticeId: string;
  readonly kind: SchedulerUserNotice["kind"];
  readonly state: SchedulerUserNotice["state"];
  readonly ref: SchedulerUserNotice["ref"];
  readonly reason: string;
  readonly actions: readonly string[];
  readonly at: string;
  readonly target?: DeliveryTargetDto;
  readonly channelText?: string;
  readonly missedMembers?: readonly string[];
}

export interface MissedSummaryMember {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly taskName: string;
  readonly scheduledFor: string;
}

export interface MissedSummaryGroup {
  readonly groupKey: string;
  readonly members: readonly MissedSummaryMember[];
  readonly target?: DeliveryTargetDto;
}


/** Snapshot of the one durable capability-gap lifecycle, never a second store. */
export interface ScheduleCapabilityGapState {
  readonly round: number;
  readonly noticeId: string;
  readonly capabilityRevision: number;
  readonly reasonDigest: string;
  readonly reason: string;
  readonly open: boolean;
}

/** Called inside the triggering transaction with that transaction's projection. */
export function decideScheduleCapabilityGap(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly definition?: TaskDefinition;
  readonly state?: JobRunState;
  readonly previous?: ScheduleCapabilityGapState;
  readonly capabilityRevision: number;
  readonly reason: string;
}) {
  const { previous, definition } = input;
  if (!definition || input.state !== "queued") {
    throw new Error("Capability gap requires a queued user occurrence");
  }
  if (definition.definition.kind !== "user") {
    throw new Error("System jobs do not emit user capability-gap notices");
  }
  const reasonDigest = protocolDigest("SchedulerCapabilityGapReason", 1, { reason: input.reason });
  if (previous?.open && previous.capabilityRevision === input.capabilityRevision && previous.reasonDigest === reasonDigest) {
    return undefined;
  }
  const round = previous?.open ? previous.round : (previous?.round ?? 0) + 1;
  const noticeId = previous?.open ? previous.noticeId : `scheduler-gap:${protocolDigest("SchedulerCapabilityGap", 1, {
    taskId: input.taskId, jobRunId: input.jobRunId, round,
  })}`;
  const text = `定时任务「${definition.definition.spec.name}」暂时找不到可用的执行环境，已排队等待；请检查目标设备及所需能力。`;
  const notice: Omit<SchedulerNoticeDraft, "at"> = {
    noticeId, kind: "capability-gap", state: previous?.open ? "updated" : "open",
    ref: { kind: "capability-gap", taskId: input.taskId, jobRunId: input.jobRunId, round },
    reason: text, actions: ["检查目标设备在线状态", "检查任务所需工具与能力"],
    ...(!previous?.open && definition.definition.origin
      ? { target: definition.definition.origin, channelText: text } : {}),
  };
  return {
    kind: previous?.open ? "capability-gap-updated" as const : "capability-gap-opened" as const,
    round, noticeId, reasonDigest, notice,
  };
}

export function decideScheduleCapabilityGapClosure(input: {
  readonly taskId: string;
  readonly events: readonly { readonly kind: "assigned" | "terminal"; readonly jobRunId: string }[];
  readonly gaps: ReadonlyMap<string, ScheduleCapabilityGapState>;
  readonly at: string;
}) {
  const jobRunId = input.events[0]?.jobRunId;
  const gap = jobRunId ? input.gaps.get(jobRunId) : undefined;
  if (!jobRunId || !gap?.open) return undefined;
  const notice: SchedulerNoticeDraft = {
    noticeId: gap.noticeId, kind: "capability-gap", state: "closed",
    ref: { kind: "capability-gap", taskId: input.taskId, jobRunId, round: gap.round },
    reason: "已找到可用执行环境，任务继续处理。", actions: [], at: input.at,
  };
  return { jobRunId, round: gap.round, noticeId: gap.noticeId, notice };
}

export function projectSchedulePublishNotices(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly assignmentId: string;
  readonly definition: TaskDefinition;
  readonly batch: MutationBatch;
  readonly outcomes: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"];
  readonly at: string;
}): readonly SchedulerNoticeDraft[] {
  if (input.definition.definition.kind !== "user") return [];
  const notices: SchedulerNoticeDraft[] = [];
  for (const item of input.outcomes) {
    const record = input.batch.records[item.seq - 1];
    if (!record || record.domain !== "global" ||
      (item.outcome.t === "granted" && item.outcome.appliedResult === undefined)) continue;
    notices.push(schedulerPublishResultDraft({
      taskId: input.taskId, jobRunId: input.jobRunId, assignmentId: input.assignmentId,
      seq: item.seq, mutation: record.mutation as GlobalStagedMutation,
      outcome: item.outcome, taskName: input.definition.definition.spec.name, at: input.at,
    }));
  }
  return notices;
}

function schedulerPublishResultDraft(input: {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly assignmentId: string;
  readonly seq: number;
  readonly mutation: GlobalStagedMutation;
  readonly outcome: Extract<PublishRecord, { t: "publish-decision" }>["outcomes"][number]["outcome"];
  readonly taskName: string;
  readonly at: string;
}): SchedulerNoticeDraft {
  const decision = input.outcome.t === "conflicted" ? "conflicted" : "applied";
  const noticeId = `scheduler-publish:${protocolDigest("SchedulerPublishResult", 1, {
    assignmentId: input.assignmentId,
    seq: input.seq,
    outcome: input.outcome,
  })}`;
  const product = input.outcome.t === "conflicted"
    ? (() => {
        const copy = publishConflictProductCopy(
          input.mutation.kind,
          input.outcome.error.code,
        );
        return {
          reason: `定时任务「${input.taskName}」未能完成“${copy.mutationLabel}”：${copy.reason}。`,
          actions: [...copy.actions],
        };
      })()
    : {
        reason: schedulerAppliedResultText(
          input.taskName,
          input.outcome.appliedResult!,
        ),
        actions: ["查看场景"],
      };
  return {
    noticeId,
    kind: "publish-result",
    state: "closed",
    ref: {
      kind: "publish-result",
      taskId: input.taskId,
      jobRunId: input.jobRunId,
      assignmentId: input.assignmentId,
      seq: input.seq,
      decision,
    },
    reason: product.reason,
    actions: product.actions,
    at: input.at,
  };
}

function schedulerAppliedResultText(
  taskName: string,
  result: WorksceneAppliedResult,
): string {
  if (result.kind === "workscene-deleted") {
    return `定时任务「${taskName}」已删除场景。`;
  }
  switch (result.operation) {
    case "create":
      return `定时任务「${taskName}」已创建场景「${result.scene.name}」。`;
    case "rename":
      return `定时任务「${taskName}」已将场景重命名为「${result.scene.name}」。`;
    case "set-workdir":
      return result.scene.workspace
        ? `定时任务「${taskName}」已更新场景「${result.scene.name}」的工作目录。`
        : `定时任务「${taskName}」已解除场景「${result.scene.name}」的工作目录。`;
  }
}


/** Dedupe against the transaction's committed membership before freezing the summary. */
export function decideScheduleMissedSummary(
  group: MissedSummaryGroup,
  alreadySummarized: ReadonlySet<string>,
  at: string,
): SchedulerNoticeDraft | undefined {
  const members = [...group.members]
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.taskId.localeCompare(b.taskId) || a.jobRunId.localeCompare(b.jobRunId))
    .filter((member) => !alreadySummarized.has(missedMemberKey(member)));
  if (members.length === 0) return undefined;
  const memberKeys = members.map(missedMemberKey);
  const noticeId = `scheduler-missed:${protocolDigest("SchedulerMissedSummary", 1, { groupKey: group.groupKey, members: memberKeys })}`;
  const text = missedSummaryText(members);
  return {
    noticeId, kind: "missed-summary", state: "prepared",
    ref: { kind: "missed-summary", batchId: noticeId, memberCount: members.length },
    reason: text, actions: ["查看任务状态", "按需重新运行"], at,
    ...(group.target ? { target: group.target, channelText: text } : {}),
    missedMembers: memberKeys,
  };
}

function missedMemberKey(member: MissedSummaryMember): string {
  return `${member.taskId}\u0000${member.jobRunId}`;
}

function missedSummaryText(members: readonly MissedSummaryMember[]): string {
  const names = [...new Set(members.map((member) => member.taskName))];
  const label = names.length > 3
    ? `${names.slice(0, 3).join("、")}等 ${names.length} 个任务`
    : names.join("、");
  return `设备离线期间，${label}共错过 ${members.length} 次执行；可查看状态并按需重新运行。`;
}

export function schedulerNoticeGroupKey(target: DeliveryTargetDto | undefined): string {
  return target ? canonicalize(target) : "first-party";
}


export function decideScheduleStatusNotification(input: {
  readonly state: JobRunState;
  readonly definition: TaskDefinition;
}) {
  if (input.definition.definition.kind !== "user") return undefined;
  const definition = input.definition.definition;
  if (!definition.origin) return undefined;
  const taskName = projectDeliveryDisplayText(definition.spec.name);
  const text = jobChannelStatusText(input.state, taskName);
  if (!text) return undefined;
  return { text, taskName, target: definition.origin };
}

function jobChannelStatusText(
  state: JobRunState,
  taskName: string,
): string | undefined {
  switch (state) {
    case "cancelled":
      return `定时任务「${taskName}」已取消。`;
    case "failed":
      return `定时任务「${taskName}」运行失败。`;
    case "expired":
      return `定时任务「${taskName}」本次未能开始执行，已过期；后续计划不受影响。`;
    case "uncertain":
      return `定时任务「${taskName}」结果不确定，需要你裁决处理方式。`;
    default:
      return undefined;
  }
}
