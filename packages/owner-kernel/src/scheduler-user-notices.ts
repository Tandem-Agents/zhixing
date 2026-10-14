import type {
  CommitEnvelope,
  LogicalRecord,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core/delivery";
import { protocolDigest } from "@zhixing/core/protocol";
import { decideScheduleMissedSummary, type SchedulerNoticeDraft, type MissedSummaryGroup } from "@zhixing/core/scheduler/application";
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
      const lifecycleSources = schedulerNoticeLifecycleSources(draft);
      const prepared = this.#delivery.prepareSchedulerNotices?.([
        {
          at: draft.at,
          noticeId: draft.noticeId,
          target: draft.target,
          text: draft.channelText,
          ...(lifecycleSources.length > 0 ? { lifecycleSources } : {}),
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
          const draft = decideScheduleMissedSummary(group, state.missedMembers, at);
          return draft
            ? { kind: "append", entries: this.prepareRecords(draft), value: undefined }
            : { kind: "return", value: undefined };
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
    // 游标已在日志末尾或之后（例如客户端带来的旧游标）：没有更新的通知。
    if (afterRevision >= (await this.#log.checkpoint()).lsn) return [];
    // 只读通知流中游标之后的记录：日志按流与 LSN 筛选，不为它解析整份历史。
    const initial: SchedulerUserNotice[] = [];
    const read = await this.#log.readProjection<SchedulerUserNotice[], unknown>(
      initial,
      (current, entry, envelope) => {
        // 日志内部重试时从未改动的空起点重新收集。
        const notices = current === initial ? [] : current;
        notices.push(projectNotice(validateNoticeFact(entry.body), envelope));
        return notices;
      },
      { stream: SCHEDULER_NOTICE_STREAM, afterLsn: afterRevision },
    );
    return [...read.state].sort((a, b) => a.revision - b.revision);
  }

  onNotice(listener: (notice: SchedulerUserNotice) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initializeLiveCursor(): Promise<void> {
    // 只需要日志当前末尾的 LSN，不读取历史。
    this.#publishedRevision = (await this.#log.checkpoint()).lsn;
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
  return {
    noticeIds: new Set(),
    missedMembers: new Set(),
  };
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


function schedulerNoticeLifecycleSources(
  draft: SchedulerNoticeDraft,
): readonly {
  readonly owner: "assignment" | "scheduler";
  readonly id: string;
  readonly revision: string;
}[] {
  const sources = new Map<string, {
    readonly owner: "assignment" | "scheduler";
    readonly id: string;
    readonly revision: string;
  }>();
  const add = (owner: "assignment" | "scheduler", id: string) => {
    if (id.length === 0) return;
    const revision = owner === "assignment"
      ? protocolDigest("AssignmentDeliveryLifecycleSource", 1, { assignmentId: id })
      : protocolDigest("SchedulerNoticeLifecycleSource", 1, { jobRunId: id });
    sources.set(`${owner}\u0000${id}`, Object.freeze({ owner, id, revision }));
  };
  for (const member of draft.missedMembers ?? []) {
    const separator = member.indexOf("\u0000");
    if (separator >= 0) add("scheduler", member.slice(separator + 1));
  }
  if (draft.ref.kind === "capability-gap" || draft.ref.kind === "publish-result") {
    add("scheduler", draft.ref.jobRunId);
  }
  if (draft.ref.kind === "publish-result") add("assignment", draft.ref.assignmentId);
  return Object.freeze([...sources.values()].sort((left, right) =>
    `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
}
