import type {
  CommitEnvelope,
  LogicalRecord,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import { createHash } from "node:crypto";
import {
  readDurableProjectionKeys,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type ProjectionTransactionContext,
  type RebuildableDurableProjectionIndex,
} from "@zhixing/core/authority";
import { DELIVERY_AUTHORITY_PROJECTION_ID, registerDeliveryAuthorityProjection, SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core/delivery";
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
  readonly audience?: "first-party" | "channel";
}

/**
 * 有界补读的一页：至多这么多个含通知的信封，投影后的通知至多这么多字节。超出时在条目边界截断，同一信封
 * 里没给完的条目用 nextSkip 续读，不丢不重。单条通知总能放进一页：逻辑记录正文内联上限 32 KiB
 * （core authority MAX_INLINE_LOGICAL_RECORD_BYTES），投影只少不多；一页至少给出一条以保证前进。
 */
export const SCHEDULER_NOTICE_PAGE_COMMITS = 32;
export const SCHEDULER_NOTICE_PAGE_BYTES = 64 * 1024;

export interface SchedulerNoticePage {
  readonly notices: readonly SchedulerUserNotice[];
  /** 这个修订及之前的通知都已给完（含其间不含通知的提交）。 */
  readonly nextRevision: number;
  /** 大于 0 时，nextRevision 之后第一个含通知的信封里已给出这么多条，续读时原样带回。 */
  readonly nextSkip: number;
  readonly more: boolean;
  /** 通知源代际：权威日志身份的摘要，日志换代后游标不能沿用。 */
  readonly source: string;
  /** 请求游标属于另一代：本页是这一代从起点读的结果，调用方应丢弃旧位置、按本页接续。 */
  readonly reset?: true;
}


/**
 * 已汇总过的错过成员按键落盘：判定一组错过成员只读这些成员各自的一行，不重放通知流。
 */
export const SCHEDULER_NOTICE_INDEX_PROJECTION_ID = "scheduler-notice-index-v1";

const missedMemberKey = (member: string) =>
  `m/${createHash("sha256").update(member, "utf8").digest("hex").slice(0, 32)}`;

export function registerSchedulerNoticeIndex(log: AuthorityCommitLog): RebuildableDurableProjectionIndex {
  return log.durableProjection({
    projectionId: SCHEDULER_NOTICE_INDEX_PROJECTION_ID,
    reducerVersion: 1,
    authenticated: true,
    inputs: { streams: [SCHEDULER_NOTICE_STREAM] },
    reduce: (envelope) => {
      const mutations: DurableProjectionMutation[] = [];
      for (const entry of envelope.entries) {
        if (entry.stream !== SCHEDULER_NOTICE_STREAM) continue;
        for (const member of validateNoticeFact(entry.body).missedMembers ?? []) {
          mutations.push({ kind: "put", key: missedMemberKey(member), value: member });
        }
      }
      return mutations;
    },
  });
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
  #publishedSkip = 0;

  constructor(options: {
    readonly log: AuthorityCommitLog;
    readonly delivery: JobDeliveryParticipant;
  }) {
    this.#log = options.log;
    this.#delivery = options.delivery;
    registerSchedulerNoticeIndex(options.log);
    // 通知的投递入队在本日志的源事务里按同一前缀读投递投影
    registerDeliveryAuthorityProjection(options.log);
  }

  /**
   * 通知事实及其投递入队，在调用方持锁的源事务里决定。transaction 是那次源事务（须把投递投影列进
   * readProjectionIds），candidates 是同一 envelope 里已计划的条目。
   */
  async prepareRecords(
    draft: SchedulerNoticeDraft,
    transaction: ProjectionTransactionContext,
    candidates: readonly LogicalRecord<unknown>[] = [],
  ): Promise<readonly LogicalRecord<unknown>[]> {
    const fact: SchedulerNoticeFact = {
      t: "scheduler-user-notice",
      noticeId: draft.noticeId,
      kind: draft.kind,
      state: draft.state,
      ref: structuredClone(draft.ref),
      reason: draft.reason,
      actions: [...draft.actions],
      ...(draft.missedMembers ? { missedMembers: [...draft.missedMembers] } : {}),
      ...(draft.audience ? { audience: draft.audience } : {}),
    };
    const records: LogicalRecord<unknown>[] = [
      { stream: SCHEDULER_NOTICE_STREAM, body: fact },
    ];
    if (draft.target && draft.channelText) {
      const lifecycleSources = schedulerNoticeLifecycleSources(draft);
      const prepared = await this.#delivery.prepareSchedulerNotices?.([
        {
          at: draft.at,
          noticeId: draft.noticeId,
          target: draft.target,
          text: draft.channelText,
          ...(lifecycleSources.length > 0 ? { lifecycleSources } : {}),
        } satisfies SchedulerNoticeDeliveryInput,
      ], transaction, candidates);
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
      await this.#delivery.coordinate(() => this.#log.transactDurableProjection<unknown, void>(
        SCHEDULER_NOTICE_INDEX_PROJECTION_ID,
        async (view, context) => {
          // 只读这一组成员各自是否已汇总
          const members = [...new Set(group.members.map((member) => `${member.taskId}\u0000${member.jobRunId}`))];
          const summarized = new Set<string>();
          for (let offset = 0; offset < members.length; offset += 256) {
            const chunk = members.slice(offset, offset + 256);
            const values = await readDurableProjectionKeys(view, chunk.map(missedMemberKey));
            chunk.forEach((member, index) => { if (values[index] === member) summarized.add(member); });
          }
          const draft = decideScheduleMissedSummary(group, summarized, at);
          return draft
            ? { kind: "append", entries: await this.prepareRecords(draft, context), value: undefined }
            : { kind: "return", value: undefined };
        },
        { readProjectionIds: [DELIVERY_AUTHORITY_PROJECTION_ID] },
      ));
    }
    await this.publishNew();
  }

  /**
   * 游标之后的一页通知。源端有界：按流至多读 limit 个含通知的信封（帧索引跳过其他流），投影超过字节
   * 上限时在条目边界截断；skip 是上一页在同一信封里已给出的条数，续读不丢不重。
   * cursorSource 是游标所属的代际：先认代际，属于另一代的游标不按这一代校验位置，而是明确返回这一代
   * 从起点读的一页（reset）；同一代的非法续读仍然拒收。
   */
  async page(
    requestedAfter: number,
    requestedSkip = 0,
    limit = SCHEDULER_NOTICE_PAGE_COMMITS,
    cursorSource?: string,
  ): Promise<SchedulerNoticePage> {
    if (!Number.isSafeInteger(requestedAfter) || requestedAfter < 0 || !Number.isSafeInteger(requestedSkip) || requestedSkip < 0) {
      throw new TypeError("Scheduler notice cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SCHEDULER_NOTICE_PAGE_COMMITS) {
      throw new RangeError("Scheduler notice page limit is invalid");
    }
    if (cursorSource !== undefined && (typeof cursorSource !== "string" || cursorSource.length === 0 || cursorSource.length > 256)) {
      throw new TypeError("Scheduler notice cursor source is invalid");
    }
    const head = await this.#log.checkpoint();
    const source = protocolDigest("SchedulerNoticeSource", 1, { logId: head.logId });
    const reset = cursorSource !== undefined && cursorSource !== source;
    const afterRevision = reset ? 0 : requestedAfter, skip = reset ? 0 : requestedSkip;
    const generation = reset ? { source, reset: true as const } : { source };
    // 游标已在日志末尾或之后（例如客户端带来的旧游标）：没有更新的通知；此时不存在可续读的信封。
    if (afterRevision >= head.lsn) {
      if (skip > 0) throw new TypeError("Scheduler notice continuation does not match its envelope");
      return { notices: [], nextRevision: afterRevision, nextSkip: 0, more: false, ...generation };
    }
    if (!this.#log.readStreamEnvelopes) throw new Error("Bounded scheduler notice read is unavailable");
    const read = await this.#log.readStreamEnvelopes<unknown>([SCHEDULER_NOTICE_STREAM], afterRevision, head.lsn, limit);
    const notices: SchedulerUserNotice[] = [];
    let bytes = 0;
    for (let index = 0; index < read.commits.length; index++) {
      const envelope = read.commits[index]!;
      const entries = envelope.entries.filter((entry) => entry.stream === SCHEDULER_NOTICE_STREAM);
      const start = index === 0 ? skip : 0;
      // 续读游标只能指向紧接其后的那个信封；条数等于该信封条数表示它已处理完，接着读后面的信封
      if (start > 0 && (envelope.lsn !== afterRevision + 1 || start > entries.length)) {
        throw new TypeError("Scheduler notice continuation does not match its envelope");
      }
      for (let position = start; position < entries.length; position++) {
        const notice = projectNotice(validateNoticeFact(entries[position]!.body), envelope);
        const size = Buffer.byteLength(JSON.stringify(notice));
        if (notices.length > 0 && bytes + size > SCHEDULER_NOTICE_PAGE_BYTES) {
          return position > 0
            ? { notices, nextRevision: envelope.lsn - 1, nextSkip: position, more: true, ...generation }
            : { notices, nextRevision: read.commits[index - 1]!.lsn, nextSkip: 0, more: true, ...generation };
        }
        notices.push(notice);
        bytes += size;
      }
    }
    if (skip > 0 && read.commits.length === 0) throw new TypeError("Scheduler notice continuation does not match its envelope");
    return { notices, nextRevision: read.lastLsn, nextSkip: 0, more: read.hasMore, ...generation };
  }

  onNotice(listener: (notice: SchedulerUserNotice) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initializeLiveCursor(): Promise<void> {
    // 只需要日志当前末尾的 LSN，不读取历史。
    this.#publishedRevision = (await this.#log.checkpoint()).lsn;
    this.#publishedSkip = 0;
  }

  async publishNew(): Promise<void> {
    for (;;) {
      const page = await this.page(this.#publishedRevision, this.#publishedSkip);
      for (const notice of page.notices) {
        for (const listener of this.#listeners) {
          await listener(notice);
        }
      }
      // 按页推进到源端给出的续读位置（含同一信封里已发出的条数）
      this.#publishedRevision = page.nextRevision;
      this.#publishedSkip = page.nextSkip;
      if (!page.more) return;
    }
  }
}

function validateNoticeFact(value: unknown): SchedulerNoticeFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Scheduler notice fact must be an object");
  }
  const fact = value as Partial<SchedulerNoticeFact>;
  const allowedKeys = new Set([
    "actions",
    "audience",
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
    (fact.audience !== undefined && fact.audience !== "first-party" && fact.audience !== "channel") ||
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
    ...(fact.audience ? { audience: fact.audience } : {}),
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
