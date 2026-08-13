import type {
  CommitEnvelope,
  DeliveryTargetDto,
  LogicalRecord,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { SCHEDULER_USER_NOTICE_STREAM, isCalendarDay } from "@zhixing/core";
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
  readonly journalPlan?: JournalMaintenanceNoticePlan;
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
  readonly journalPlan?: JournalMaintenanceNoticePlan;
}

export interface JournalMaintenanceNoticePlan {
  readonly planDigest: string;
  readonly months: readonly {
    readonly month: string;
    readonly targetExpectedDigest?: string;
    readonly sources: readonly {
      readonly id: string;
      readonly expectedDigest: string;
    }[];
  }[];
}

export interface JournalMaintenanceNoticeState {
  readonly notice: SchedulerUserNotice;
  readonly plan: JournalMaintenanceNoticePlan;
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
  readonly journalMaintenance: Map<string, SchedulerNoticeFact>;
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
      ...(draft.journalPlan ? { journalPlan: structuredClone(draft.journalPlan) } : {}),
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

  async recordJournalMaintenance(draft: SchedulerNoticeDraft): Promise<void> {
    if (draft.kind !== "journal-maintenance") {
      throw new TypeError("Journal maintenance notice kind is invalid");
    }
    await this.#log.transactProjection<NoticeProjection, unknown, void>(
      emptyProjection(),
      noticeReducer,
      (projection) => {
        const next = validateNoticeFact(this.prepareRecords(draft)[0]!.body);
        const current = projection.journalMaintenance.get(draft.noticeId);
        if (current && canonicalize(current) === canonicalize(next)) {
          return { kind: "return", value: undefined };
        }
        assertJournalMaintenanceTransition(current, next);
        return {
          kind: "append",
          entries: [{ stream: SCHEDULER_NOTICE_STREAM, body: next }],
          value: undefined,
        };
      },
      { stream: SCHEDULER_NOTICE_STREAM },
    );
    await this.publishNew();
  }

  async journalMaintenanceStates(): Promise<readonly JournalMaintenanceNoticeState[]> {
    const states = new Map<string, JournalMaintenanceNoticeState>();
    for (const envelope of await this.#log.readAll<unknown>()) {
      for (const entry of envelope.entries) {
        if (entry.stream !== SCHEDULER_NOTICE_STREAM) continue;
        const fact = validateNoticeFact(entry.body);
        if (fact.kind !== "journal-maintenance" || !fact.journalPlan) continue;
        states.set(fact.noticeId, {
          notice: projectNotice(fact, envelope),
          plan: structuredClone(fact.journalPlan),
        });
      }
    }
    return [...states.values()].sort(
      (a, b) => a.notice.revision - b.notice.revision,
    );
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
  return {
    noticeIds: new Set(),
    missedMembers: new Set(),
    journalMaintenance: new Map(),
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
  if (fact.kind === "journal-maintenance") {
    state.journalMaintenance.set(fact.noticeId, fact);
  }
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
    "journalPlan",
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
      fact.kind !== "publish-result" &&
      fact.kind !== "journal-maintenance") ||
    !["prepared", "open", "updated", "closed"].includes(fact.state ?? "") ||
    typeof fact.reason !== "string" || fact.reason.length === 0 ||
    !Array.isArray(fact.actions) || !fact.actions.every((item) => typeof item === "string") ||
    !validNoticeRef(fact.ref, fact.kind) ||
    (fact.missedMembers !== undefined &&
      (!Array.isArray(fact.missedMembers) ||
        !fact.missedMembers.every((item) => typeof item === "string" && item.length > 0))) ||
    (fact.kind === "journal-maintenance"
      ? !validJournalPlan(fact.journalPlan) ||
        fact.journalPlan.planDigest !==
          (fact.ref as Extract<SchedulerUserNotice["ref"], { kind: "journal-maintenance" }>).planDigest ||
        fact.journalPlan.months.length !==
          (fact.ref as Extract<SchedulerUserNotice["ref"], { kind: "journal-maintenance" }>).monthCount ||
        fact.journalPlan.months.reduce((sum, month) => sum + month.sources.length, 0) !==
          (fact.ref as Extract<SchedulerUserNotice["ref"], { kind: "journal-maintenance" }>).fileCount
      : fact.journalPlan !== undefined)
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
  if (kind === "journal-maintenance") {
    return Object.keys(ref).sort().join(",") ===
        "attempt,completed,fileCount,kind,monthCount,planDigest" &&
      ref.kind === "journal-maintenance" &&
      typeof ref.planDigest === "string" && /^sha256:[a-f0-9]{64}$/u.test(ref.planDigest) &&
      Number.isSafeInteger(ref.monthCount) && (ref.monthCount as number) > 0 &&
      Number.isSafeInteger(ref.fileCount) && (ref.fileCount as number) > 0 &&
      Number.isSafeInteger(ref.attempt) && (ref.attempt as number) >= 0 &&
      Number.isSafeInteger(ref.completed) && (ref.completed as number) >= 0 &&
      (ref.completed as number) <= (ref.monthCount as number);
  }
  return false;
}

function validJournalPlan(value: unknown): value is JournalMaintenanceNoticePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<JournalMaintenanceNoticePlan>;
  if (
    Object.keys(value).sort().join(",") !== "months,planDigest" ||
    typeof plan.planDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.planDigest) ||
    !Array.isArray(plan.months) || plan.months.length === 0 ||
    protocolDigest("JournalMaintenancePlan", 1, { months: plan.months }) !==
      plan.planDigest
  ) return false;
  let previousMonth = "";
  return plan.months.every((month) => {
    if (!month || typeof month !== "object" || Array.isArray(month)) return false;
    const expectedKeys = [
      "month",
      "sources",
      ...(month.targetExpectedDigest === undefined ? [] : ["targetExpectedDigest"]),
    ].sort().join(",");
    if (
      Object.keys(month).sort().join(",") !== expectedKeys ||
      !/^\d{4}-(0[1-9]|1[0-2])$/u.test(month.month) ||
      month.month <= previousMonth ||
      (month.targetExpectedDigest !== undefined &&
        !/^sha256:[a-f0-9]{64}$/u.test(month.targetExpectedDigest)) ||
      !Array.isArray(month.sources) || month.sources.length === 0
    ) return false;
    previousMonth = month.month;
    let previousSource = "";
    return month.sources.every((source: { id: string; expectedDigest: string }) => {
      if (
        !source || typeof source !== "object" || Array.isArray(source) ||
        Object.keys(source).sort().join(",") !== "expectedDigest,id" ||
        !isCalendarDay(source.id) ||
        !source.id.startsWith(`${month.month}-`) ||
        source.id <= previousSource ||
        !/^sha256:[a-f0-9]{64}$/u.test(source.expectedDigest)
      ) return false;
      previousSource = source.id;
      return true;
    });
  });
}

function assertJournalMaintenanceTransition(
  current: SchedulerNoticeFact | undefined,
  next: SchedulerNoticeFact,
): void {
  const ref = next.ref as Extract<
    SchedulerUserNotice["ref"],
    { kind: "journal-maintenance" }
  >;
  if (!current) {
    if (next.state !== "prepared" || ref.attempt !== 0 || ref.completed !== 0) {
      throw new TypeError("Journal maintenance notice must start prepared");
    }
    return;
  }
  const previous = current.ref as typeof ref;
  if (
    current.kind !== "journal-maintenance" ||
    current.state === "closed" ||
    current.journalPlan?.planDigest !== next.journalPlan?.planDigest ||
    previous.monthCount !== ref.monthCount ||
    previous.fileCount !== ref.fileCount ||
    ref.attempt < previous.attempt ||
    ref.completed < previous.completed ||
    ref.completed > previous.completed + 1 ||
    next.state === "prepared"
  ) {
    throw new TypeError("Journal maintenance notice transition is not monotonic");
  }
  if (next.state === "open") {
    if (ref.attempt !== previous.attempt + 1 || ref.completed !== previous.completed) {
      throw new TypeError("Journal maintenance attempt transition is invalid");
    }
  } else if (next.state === "updated") {
    if (ref.attempt !== previous.attempt) {
      throw new TypeError("Journal maintenance progress transition is invalid");
    }
  } else if (next.state === "closed") {
    if (ref.attempt !== previous.attempt) {
      throw new TypeError("Journal maintenance completion is invalid");
    }
  }
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
