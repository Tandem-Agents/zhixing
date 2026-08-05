import type {
  CommitEnvelope,
  DeliveryTargetDto,
  LogicalRecord,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type {
  JobDeliveryParticipant,
  SchedulerNoticeDeliveryInput,
} from "./delivery-participant.js";

export const SCHEDULER_NOTICE_STREAM = SCHEDULER_USER_NOTICE_STREAM;

export interface SchedulerNoticeFact {
  readonly t: "scheduler-user-notice";
  readonly noticeId: string;
  readonly kind: SchedulerUserNotice["kind"];
  readonly state: SchedulerUserNotice["state"];
  readonly ref: SchedulerUserNotice["ref"];
  readonly reason: string;
  readonly actions: readonly string[];
  readonly missedMembers?: readonly string[];
}

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

interface NoticeProjection {
  readonly noticeIds: Set<string>;
  readonly missedMembers: Set<string>;
}

/**
 * The narrow authority for scheduler notices that are not job state changes.
 * Commit LSN is the one scalar live/history revision; no second cursor exists.
 */
export class SchedulerUserNoticeJournal {
  readonly #log: AuthorityCommitLog;
  readonly #delivery: JobDeliveryParticipant;
  readonly #listeners = new Set<
    (notice: SchedulerUserNotice) => void | Promise<void>
  >();
  #publishedRevision = 0;

  constructor(options: {
    readonly log: AuthorityCommitLog;
    readonly delivery: JobDeliveryParticipant;
  }) {
    this.#log = options.log;
    this.#delivery = options.delivery;
  }

  prepareRecords(draft: SchedulerNoticeDraft): readonly LogicalRecord<unknown>[] {
    const fact: SchedulerNoticeFact = {
      t: "scheduler-user-notice",
      noticeId: draft.noticeId,
      kind: draft.kind,
      state: draft.state,
      ref: structuredClone(draft.ref),
      reason: draft.reason,
      actions: [...draft.actions],
      ...(draft.missedMembers ? { missedMembers: [...draft.missedMembers] } : {}),
    };
    const records: LogicalRecord<unknown>[] = [
      { stream: SCHEDULER_NOTICE_STREAM, body: fact },
    ];
    if (draft.target && draft.channelText) {
      const prepared = this.#delivery.prepareSchedulerNotices?.([
        {
          at: draft.at,
          noticeId: draft.noticeId,
          target: draft.target,
          text: draft.channelText,
        } satisfies SchedulerNoticeDeliveryInput,
      ]);
      if (!prepared) {
        throw new Error("Scheduler notice delivery participant is unavailable");
      }
      if (!prepared.accepted) throw new Error(prepared.error.message);
      records.push(...prepared.records);
    }
    return records;
  }

  async prepareMissedSummaries(
    groups: readonly MissedSummaryGroup[],
    at: string,
  ): Promise<void> {
    for (const group of [...groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey))) {
      await this.#delivery.coordinate(() => this.#log.transactProjection<NoticeProjection, unknown, void>(
        emptyProjection(),
        noticeReducer,
        (state) => {
          const members = [...group.members]
            .sort((a, b) =>
              a.scheduledFor.localeCompare(b.scheduledFor) ||
              a.taskId.localeCompare(b.taskId) ||
              a.jobRunId.localeCompare(b.jobRunId),
            )
            .filter((member) => !state.missedMembers.has(missedMemberKey(member)));
          if (members.length === 0) return { kind: "return", value: undefined };
          const memberKeys = members.map(missedMemberKey);
          const noticeId = `scheduler-missed:${protocolDigest(
            "SchedulerMissedSummary",
            1,
            { groupKey: group.groupKey, members: memberKeys },
          )}`;
          const text = missedSummaryText(members);
          return {
            kind: "append",
            entries: this.prepareRecords({
              noticeId,
              kind: "missed-summary",
              state: "prepared",
              ref: {
                kind: "missed-summary",
                batchId: noticeId,
                memberCount: members.length,
              },
              reason: text,
              actions: ["查看任务状态", "按需重新运行"],
              at,
              ...(group.target ? { target: group.target, channelText: text } : {}),
              missedMembers: memberKeys,
            }),
            value: undefined,
          };
        },
        { stream: SCHEDULER_NOTICE_STREAM },
      ));
    }
    await this.publishNew();
  }

  async history(afterRevision: number): Promise<readonly SchedulerUserNotice[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new TypeError("Scheduler notice cursor must be a non-negative safe integer");
    }
    const notices: SchedulerUserNotice[] = [];
    for (const envelope of await this.#log.readAll<unknown>()) {
      if (envelope.lsn <= afterRevision) continue;
      for (const entry of envelope.entries) {
        if (entry.stream !== SCHEDULER_NOTICE_STREAM) continue;
        notices.push(projectNotice(validateNoticeFact(entry.body), envelope));
      }
    }
    return notices.sort((a, b) => a.revision - b.revision);
  }

  onNotice(listener: (notice: SchedulerUserNotice) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initializeLiveCursor(): Promise<void> {
    const commits = await this.#log.readAll();
    this.#publishedRevision = commits.at(-1)?.lsn ?? 0;
  }

  async publishNew(): Promise<void> {
    for (const notice of await this.history(this.#publishedRevision)) {
      this.#publishedRevision = Math.max(this.#publishedRevision, notice.revision);
      for (const listener of this.#listeners) {
        await listener(notice);
      }
    }
  }
}

function emptyProjection(): NoticeProjection {
  return { noticeIds: new Set(), missedMembers: new Set() };
}

function noticeReducer(
  state: NoticeProjection,
  raw: LogicalRecord<unknown>,
): NoticeProjection {
  if (raw.stream !== SCHEDULER_NOTICE_STREAM) return state;
  const fact = validateNoticeFact(raw.body);
  state.noticeIds.add(fact.noticeId);
  for (const member of fact.missedMembers ?? []) state.missedMembers.add(member);
  return state;
}

function validateNoticeFact(value: unknown): SchedulerNoticeFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scheduler notice fact must be an object");
  }
  const fact = value as Partial<SchedulerNoticeFact>;
  const allowedKeys = new Set([
    "actions",
    "kind",
    "missedMembers",
    "noticeId",
    "reason",
    "ref",
    "state",
    "t",
  ]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    fact.t !== "scheduler-user-notice" ||
    typeof fact.noticeId !== "string" || fact.noticeId.length === 0 ||
    (fact.kind !== "missed-summary" &&
      fact.kind !== "capability-gap" &&
      fact.kind !== "publish-result") ||
    !["prepared", "open", "updated", "closed"].includes(fact.state ?? "") ||
    typeof fact.reason !== "string" || fact.reason.length === 0 ||
    !Array.isArray(fact.actions) || !fact.actions.every((item) => typeof item === "string") ||
    !validNoticeRef(fact.ref, fact.kind) ||
    (fact.missedMembers !== undefined &&
      (!Array.isArray(fact.missedMembers) ||
        !fact.missedMembers.every((item) => typeof item === "string" && item.length > 0)))
  ) {
    throw new TypeError("Scheduler notice fact is invalid");
  }
  return structuredClone(fact as SchedulerNoticeFact);
}

function validNoticeRef(
  value: unknown,
  kind: SchedulerUserNotice["kind"] | undefined,
): value is SchedulerUserNotice["ref"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (kind === "missed-summary") {
    return Object.keys(ref).every((key) => ["batchId", "kind", "memberCount"].includes(key)) &&
      ref.kind === "missed-summary" &&
      typeof ref.batchId === "string" && ref.batchId.length > 0 &&
      Number.isSafeInteger(ref.memberCount) && (ref.memberCount as number) > 0;
  }
  if (kind === "capability-gap") {
    return Object.keys(ref).every((key) =>
      ["jobRunId", "kind", "round", "taskId"].includes(key)) &&
      ref.kind === "capability-gap" &&
      typeof ref.taskId === "string" && ref.taskId.length > 0 &&
      typeof ref.jobRunId === "string" && ref.jobRunId.length > 0 &&
      Number.isSafeInteger(ref.round) && (ref.round as number) > 0;
  }
  if (kind === "publish-result") {
    return Object.keys(ref).every((key) =>
      ["assignmentId", "decision", "jobRunId", "kind", "seq", "taskId"].includes(key)) &&
      Object.keys(ref).length === 6 &&
      ref.kind === "publish-result" &&
      typeof ref.taskId === "string" && ref.taskId.length > 0 &&
      typeof ref.jobRunId === "string" && ref.jobRunId.length > 0 &&
      typeof ref.assignmentId === "string" && ref.assignmentId.length > 0 &&
      Number.isSafeInteger(ref.seq) && (ref.seq as number) > 0 &&
      (ref.decision === "conflicted" || ref.decision === "applied");
  }
  return false;
}

function projectNotice(
  fact: SchedulerNoticeFact,
  envelope: CommitEnvelope<unknown>,
): SchedulerUserNotice {
  return {
    noticeId: fact.noticeId,
    revision: envelope.lsn,
    kind: fact.kind,
    state: fact.state,
    ref: structuredClone(fact.ref),
    reason: fact.reason,
    actions: [...fact.actions],
    at: envelope.at,
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
