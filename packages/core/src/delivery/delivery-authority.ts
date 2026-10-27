import type {
  DeliveryStatusNotice,
  DeliveryStreamRecord,
  LogicalRecord,
} from "../contracts/index.js";
import {
  AuthorityStorageError,
  type AuthorityCommitLog,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
} from "../authority/index.js";
import { SerialTaskQueue } from "../persistence/index.js";
import { canonicalize } from "../protocol/index.js";
import {
  DELIVERY_STREAM,
  deliveryIdempotencyKey,
  deliveryItemId,
  deliveryRecord,
  deliveryStatusNotice,
  emptyDeliveryProjection,
  materializeDeliveryItem,
  projectDeliveryLifecycleRecords,
  validateDeliveryStreamRecord,
  type DeliveryProjection,
} from "./authority.js";
import {
  DELIVERY_AUTHORITY_PROJECTION_ID,
  loadDeliveryProjection,
  isDeliveryUncertainKey,
  readDeliveryItem,
  readDeliveryItemIdByKey,
  readDeliveryItemWithOrder,
  readDeliveryNotice,
  readDeliveryNoticeOrder,
  readDeliveryNoticesAfter,
  readDeliveryPendingPage,
  readDeliveryReadyPage,
  readDeliveryRetryDuePage,
  readDeliveryStateCounts,
  readDeliveryUncertainPage,
  registerDeliveryAuthorityProjection,
  type DeliveryDirectoryEntry,
  type DeliveryNoticePosition,
} from "./authority-index.js";
import type {
  DeliveryLifecycleAdmissionMutation,
  DeliveryLifecycleAdmissionState,
} from "./application.js";
import type {
  AuthorityDeliveryItem,
  AuthorityDeliveryStats,
  DeliveryClaimablePage,
  DeliveryClaimablePageRequest,
  DeliveryDirectoryPage,
  DeliveryEnqueueInput,
  DeliveryEnqueueResult,
} from "./types.js";
import { assertDeliveryItemId } from "./validation.js";

const deliveryOperationQueues = new WeakMap<AuthorityCommitLog, SerialTaskQueue>();
/** 冻结准入集合、补读单条目通知时的每页条数。 */
const PAGE_SIZE = 128;

/**
 * 锚定端的投递生命周期与入队唯一性。投递状态全部在权威日志的按键持久投影里，按条目、唯一键与目录精确读取；
 * 进程内只留生命周期准入的冻结状态。
 */
export class DeliveryAuthority {
  readonly #log: AuthorityCommitLog;
  readonly #anchorEpoch: number;
  readonly #operations: SerialTaskQueue;
  #lifecycleAdmission: DeliveryLifecycleAdmissionState | undefined;

  constructor(options: { readonly log: AuthorityCommitLog; readonly anchorEpoch: number }) {
    if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
      throw new TypeError("Delivery anchor epoch must be a positive safe integer");
    }
    this.#log = options.log;
    this.#anchorEpoch = options.anchorEpoch;
    const sharedOperations = deliveryOperationQueues.get(options.log) ?? new SerialTaskQueue();
    deliveryOperationQueues.set(options.log, sharedOperations);
    this.#operations = sharedOperations;
    registerDeliveryAuthorityProjection(options.log);
  }

  get anchorEpoch(): number {
    return this.#anchorEpoch;
  }

  /**
   * 在源事务里决定入队：经事务视图按唯一键与候选条目号精确装入，再交给领域决定。源事务须把投递投影列进
   * readProjectionIds。candidates 是本 envelope 里已经计划好的条目（同一事务里先前几次入队的结果），
   * 其中的入队一并计入，重复键照常去重或拒绝。计划由调用方随候选显式传入，不留在进程内：工作集重做时
   * 候选重新生成，不会把上一次尝试的计划带进来。
   */
  async prepareEnqueues(
    inputs: readonly DeliveryEnqueueInput[],
    commitAt: string,
    decide: (
      projection: DeliveryProjection,
      inputs: readonly DeliveryEnqueueInput[],
      commitAt: string,
      lifecycleAdmission: DeliveryLifecycleAdmissionState | undefined,
    ) => DeliveryEnqueueResult,
    transaction: ProjectionTransactionContext,
    candidates: readonly LogicalRecord<unknown>[] = [],
  ): Promise<DeliveryEnqueueResult> {
    const view = transaction.readProjection(DELIVERY_AUTHORITY_PROJECTION_ID);
    const planned = candidates
      .filter((entry) => entry.stream === DELIVERY_STREAM)
      .map((entry) => validateDeliveryStreamRecord(entry.body))
      .filter((record) => record.t === "enqueued");
    const working = projectDeliveryLifecycleRecords(emptyDeliveryProjection(), planned, commitAt);
    for (const input of inputs) {
      const key = deliveryIdempotencyKey(input.keyBody);
      if (!working.itemByKey.has(key)) {
        const existingId = await readDeliveryItemIdByKey(view, key);
        if (existingId !== undefined) {
          const existing = await readDeliveryItem(view, existingId);
          if (!existing) throw corruptDelivery("Delivery unique index is inconsistent");
          working.items.set(existingId, existing);
          working.itemByKey.set(key, existingId);
        }
      }
      // 本次可能分配的条目号：逐个加盐，把已被占用的装进来，直到第一个空位，与全量投影上的决定一致
      for (let salt = 0; ; salt += 1) {
        const candidate = deliveryItemId(key, commitAt, salt);
        if (working.items.has(candidate)) continue;
        const occupied = await readDeliveryItem(view, candidate);
        if (!occupied) break;
        working.items.set(candidate, occupied);
        working.itemByKey.set(occupied.idempotencyKey, candidate);
      }
    }
    return decide(working, inputs, commitAt, this.#admissionSnapshot());
  }

  /**
   * 生命周期准入的正确性边界。冻结要看到完整的 pending 集合：在协调边界内分页读 pending 目录，期间
   * 入队与生命周期决定都在同一协调队列里等待，各页属于同一状态。读量随真实未完成集合增长。
   */
  async transactDeliveryAdmission<Value>(
    decide: (context: {
      readonly projection: DeliveryProjection;
      readonly admission: DeliveryLifecycleAdmissionState | undefined;
    }) => DeliveryLifecycleAdmissionMutation<Value>,
  ): Promise<Value> {
    if (typeof decide !== "function") {
      throw new TypeError("Delivery lifecycle admission decision must be a function");
    }
    return await this.coordinate(async () => {
      const decision = decide({
        projection: await this.#pendingProjection(),
        admission: this.#admissionSnapshot(),
      });
      this.#lifecycleAdmission = decision.admission
        ? canonicalCopy(decision.admission, "Delivery lifecycle admission state")
        : undefined;
      return decision.value;
    });
  }

  /** 与入队、准入和生命周期决定共用的串行协调；投影读取不再需要先追平。 */
  coordinate<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#operations.run(operation);
  }

  async get(itemId: string): Promise<AuthorityDeliveryItem | undefined> {
    assertDeliveryItemId(itemId);
    const item = await this.#read((view) => readDeliveryItem(view, itemId));
    return item ? materializeDeliveryItem(item) : undefined;
  }

  /** 按状态的计数：读固定个数的计数行，与历史条数无关。 */
  async stats(): Promise<AuthorityDeliveryStats> {
    const counts = await this.#read(readDeliveryStateCounts);
    return {
      pending: counts.queued + counts["retry-wait"] + counts.attempting + counts.uncertain,
      queued: counts.queued,
      attempting: counts.attempting,
      delivered: counts.sent + counts["verified-sent"],
      failed: counts.failed + counts.abandoned,
      retrying: counts["retry-wait"],
      uncertain: counts.uncertain,
    };
  }

  /**
   * 某个优先级的一页可领取条目：kind 为 ready 时取 queued 与 attempting，为 retry 时取下次尝试不晚于
   * now 的 retry-wait。从 afterKey 之后续读。
   *
   * 本轮上界（enteredThrough）：只给出进入当前目录时的日志位置不大于它的条目。待领取目录按入列位置排序，
   * 遇到超界的条目即止；重试目录按尝试时间排序，跳过超界的条目，调用方以 next 续读。省略上界时，本页读到
   * 的投影位置就是上界——此刻目录里的条目都不晚于它。
   */
  async claimablePage(input: DeliveryClaimablePageRequest): Promise<DeliveryClaimablePage> {
    const bound = input.enteredThrough;
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0)) {
      throw new RangeError("Delivery claim round bound must be a non-negative safe integer");
    }
    const { value, cursor } = await this.#log.transactDurableProjection<never, Omit<DeliveryClaimablePage, "enteredThrough">>(
      DELIVERY_AUTHORITY_PROJECTION_ID,
      async (view) => {
        const page = input.kind === "ready"
          ? await readDeliveryReadyPage(view, input.priority, input.afterKey, input.limit)
          : await readDeliveryRetryDuePage(view, input.priority, input.now, input.afterKey, input.limit);
        const items: { key: string; item: AuthorityDeliveryItem }[] = [];
        let exceeded = false;
        for (const { key, itemId } of page.entries) {
          const stored = await readDeliveryItemWithOrder(view, itemId);
          if (!stored) throw corruptDelivery("Delivery directory names a missing item");
          if (bound !== undefined && stored.order > bound) {
            if (input.kind === "ready") {
              exceeded = true;
              break;
            }
            continue;
          }
          items.push({ key, item: materializeDeliveryItem(stored.item) });
        }
        const next = page.entries.at(-1)?.key;
        return {
          kind: "return",
          value: { items, more: page.more && !exceeded, ...(next === undefined ? {} : { next }) },
        };
      },
    );
    return { ...value, enteredThrough: bound ?? cursor.lsn };
  }

  /** 全部未结投递（显式停机、迁居冻结用），分页读 pending 目录；读量随真实未完成集合增长。 */
  async pendingItems(): Promise<readonly AuthorityDeliveryItem[]> {
    const projection = await this.#pendingProjection();
    return [...projection.items.values()].map(materializeDeliveryItem);
  }

  /** uncertain 目录的一页，供发现、核验与呈现；不进入自动领取。 */
  async uncertainPage(afterKey: string | undefined, limit: number): Promise<DeliveryDirectoryPage> {
    return this.#read(async (view) => {
      const page = await readDeliveryUncertainPage(view, afterKey, limit);
      return { items: await materializeEntries(view, page.entries), more: page.more };
    });
  }

  /** 一个条目修订号大于 afterStatusRevision 的全部状态通知（只读这一条目的区间）。 */
  async statusHistory(
    itemId: string,
    afterStatusRevision: number,
  ): Promise<readonly DeliveryStatusNotice[]> {
    assertDeliveryItemId(itemId);
    if (!Number.isSafeInteger(afterStatusRevision) || afterStatusRevision < 0) {
      throw new TypeError("Last-seen delivery status revision must be non-negative");
    }
    const notices: DeliveryStatusNotice[] = [];
    let after = afterStatusRevision;
    for (;;) {
      const page = await this.#read((view) => readDeliveryNoticesAfter(view, itemId, after, PAGE_SIZE));
      for (const entry of page.notices) {
        notices.push(deliveryStatusNotice(itemId, entry, this.#anchorEpoch));
        after = entry.record.statusRevision;
      }
      if (!page.more || page.notices.length === 0) return notices;
    }
  }

  async statusNotice(
    itemId: string,
    statusRevision: number,
  ): Promise<DeliveryStatusNotice | undefined> {
    assertDeliveryItemId(itemId);
    if (!Number.isSafeInteger(statusRevision) || statusRevision <= 0) {
      throw new TypeError("Delivery status revision must be a positive safe integer");
    }
    const entry = await this.#read((view) => readDeliveryNotice(view, itemId, statusRevision));
    return entry ? deliveryStatusNotice(itemId, entry, this.#anchorEpoch) : undefined;
  }

  /**
   * 按主体精确补读：每个条目只读修订号大于其游标的那一段，每个条目至多 limit 条；不读未列出的条目。
   * next 是每个主体处理完这一页之后的游标。
   */
  async subjectHistory(
    cursors: readonly DeliverySubjectCursor[],
    limit = PAGE_SIZE,
  ): Promise<{ readonly notices: readonly DeliveryStatusNotice[]; readonly next: readonly DeliverySubjectCursor[] }> {
    for (const cursor of cursors) {
      assertDeliveryItemId(cursor.itemId);
      if (!Number.isSafeInteger(cursor.afterStatusRevision) || cursor.afterStatusRevision < 0) {
        throw new TypeError("Last-seen delivery status revision must be non-negative");
      }
    }
    return this.#read(async (view) => {
      const notices: DeliveryStatusNotice[] = [];
      const next: DeliverySubjectCursor[] = [];
      for (const cursor of cursors) {
        const page = await readDeliveryNoticesAfter(view, cursor.itemId, cursor.afterStatusRevision, limit);
        let after = cursor.afterStatusRevision;
        for (const entry of page.notices) {
          notices.push(deliveryStatusNotice(cursor.itemId, entry, this.#anchorEpoch));
          after = entry.record.statusRevision;
        }
        next.push({ itemId: cursor.itemId, afterStatusRevision: after });
      }
      return { notices, next };
    });
  }

  /**
   * 全局发现：按通知顺序取 after 之后的一页。游标绑定本日志与锚定代次；来源变了（迁居、灾备装入新的
   * 一代）就从头读并标明 reset，不静默跳过。next 指向这一页最后一条之后，没有新通知时不变。
   */
  async statusPage(after: string | undefined, limit: number): Promise<DeliveryStatusPage> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PAGE_SIZE) {
      throw new RangeError(`Delivery status page limit must be 1-${PAGE_SIZE}`);
    }
    const source = { logId: (await this.#log.originCheckpoint()).logId, anchorEpoch: this.#anchorEpoch };
    const cursor = after === undefined ? undefined : decodeNoticeCursor(after);
    const reset = cursor !== undefined && (cursor.logId !== source.logId || cursor.anchorEpoch !== source.anchorEpoch);
    const from = cursor && !reset && cursor.lsn !== undefined && cursor.entry !== undefined
      ? { lsn: cursor.lsn, entry: cursor.entry }
      : undefined;
    return this.#read(async (view) => {
      const page = await readDeliveryNoticeOrder(view, from, limit);
      const notices: DeliveryStatusNotice[] = [];
      let last: DeliveryNoticePosition | undefined = from;
      for (const entry of page.entries) {
        notices.push(deliveryStatusNotice(entry.itemId, entry.notice, this.#anchorEpoch));
        last = { lsn: entry.lsn, entry: entry.entry };
      }
      return {
        notices,
        next: encodeCursor(NOTICE_CURSOR_PREFIX, { ...source, ...(last ? { lsn: last.lsn, entry: last.entry } : {}) }),
        more: page.more,
        reset,
      };
    });
  }

  /**
   * 当前 uncertain：沿 uncertain 目录（按进入 uncertain 时的日志位置排列）有限分页，每条给出它最新的通知，
   * 供及时发现与核验。游标绑定本日志与锚定代次；来源变了就从头读并标明 reset。新进入 uncertain 的条目
   * 排在已读位置之后，关闭的条目离开目录，按游标续读不漏不重。next 指向这一页最后一条之后。
   */
  async uncertainNotices(after: string | undefined, limit: number): Promise<DeliveryStatusPage> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PAGE_SIZE) {
      throw new RangeError(`Delivery uncertain page limit must be 1-${PAGE_SIZE}`);
    }
    const source = { logId: (await this.#log.originCheckpoint()).logId, anchorEpoch: this.#anchorEpoch };
    const cursor = after === undefined ? undefined : decodeUncertainCursor(after);
    const reset = cursor !== undefined && (cursor.logId !== source.logId || cursor.anchorEpoch !== source.anchorEpoch);
    const from = cursor && !reset ? cursor.key : undefined;
    return this.#read(async (view) => {
      const page = await readDeliveryUncertainPage(view, from, limit);
      const notices: DeliveryStatusNotice[] = [];
      for (const { itemId } of page.entries) {
        const item = await readDeliveryItem(view, itemId);
        if (!item) throw corruptDelivery("Delivery directory names a missing item");
        const notice = await readDeliveryNotice(view, itemId, item.statusRevision);
        if (!notice) throw corruptDelivery("Uncertain delivery has no current notice");
        notices.push(deliveryStatusNotice(itemId, notice, this.#anchorEpoch));
      }
      const last = page.entries.at(-1)?.key ?? from;
      return {
        notices,
        next: encodeCursor(UNCERTAIN_CURSOR_PREFIX, { ...source, ...(last === undefined ? {} : { key: last }) }),
        more: page.more,
        reset,
      };
    });
  }

  /**
   * 生命周期决定的正确性边界：按输入的条目号装入工作集，在同一前缀上由调用方决定，校验后一次追加。
   */
  async transactDeliveryLifecycle<Value>(
    itemIds: readonly string[],
    decide: (context: {
      readonly projection: DeliveryProjection;
      readonly transactionAt: string;
      readonly currentAnchorEpoch: number;
    }) => {
      readonly records: readonly DeliveryStreamRecord[];
      readonly value: Value;
    },
  ): Promise<Value> {
    if (typeof decide !== "function") {
      throw new TypeError("Delivery lifecycle decision must be a function");
    }
    for (const itemId of itemIds) assertDeliveryItemId(itemId);
    return await this.#operations.run(async () => (
      await this.#log.transactDurableProjection<DeliveryStreamRecord, Value>(
        DELIVERY_AUTHORITY_PROJECTION_ID,
        async (view, context) => {
          const decision = decide({
            projection: await loadDeliveryProjection(view, itemIds),
            transactionAt: context.at,
            currentAnchorEpoch: this.#anchorEpoch,
          });
          const records = decision.records.map((record) => {
            const frozen = canonicalCopy(record, "Delivery lifecycle decision record");
            validateDeliveryStreamRecord(frozen);
            return deliveryRecord(frozen);
          });
          return records.length === 0
            ? { kind: "return", value: decision.value }
            : { kind: "append", entries: records, value: decision.value };
        },
      )
    ).value);
  }

  /** 当前日志头的投影游标：控制准入以它为目标前缀，只归约本次候选，不重放投递流。 */
  async headCursor(): Promise<ProjectionCursor> {
    return (await this.#log.transactDurableProjection<never, undefined>(
      DELIVERY_AUTHORITY_PROJECTION_ID,
      async () => ({ kind: "return", value: undefined }),
    )).cursor;
  }

  async #pendingProjection(): Promise<DeliveryProjection> {
    const projection = emptyDeliveryProjection();
    let afterKey: string | undefined;
    for (;;) {
      const page = await this.#read(async (view) => {
        const pending = await readDeliveryPendingPage(view, afterKey, PAGE_SIZE);
        await loadDeliveryProjection(view, pending.entries.map(({ itemId }) => itemId), projection);
        return pending;
      });
      if (!page.more || page.entries.length === 0) return projection;
      afterKey = page.entries.at(-1)!.key;
    }
  }

  #admissionSnapshot(): DeliveryLifecycleAdmissionState | undefined {
    return this.#lifecycleAdmission
      ? canonicalCopy(this.#lifecycleAdmission, "Delivery lifecycle admission projection")
      : undefined;
  }

  async #read<T>(operation: (view: DurableProjectionReadContext) => Promise<T>): Promise<T> {
    return (await this.#log.transactDurableProjection<never, T>(
      DELIVERY_AUTHORITY_PROJECTION_ID,
      async (view) => ({ kind: "return", value: await operation(view) }),
    )).value;
  }
}

export interface DeliverySubjectCursor {
  readonly itemId: string;
  readonly afterStatusRevision: number;
}

export interface DeliveryStatusPage {
  readonly notices: readonly DeliveryStatusNotice[];
  /** 不透明游标：处理完这一页后从这里续读。 */
  readonly next: string;
  readonly more: boolean;
  /** 传入的游标属于别的日志或锚定代次：这一页从头读起。 */
  readonly reset: boolean;
}

/** 全局通知游标：来源（日志与锚定代次）加上已处理到的通知位置；没有位置表示从头读。 */
interface NoticeCursor {
  readonly logId: string;
  readonly anchorEpoch: number;
  readonly lsn?: number;
  readonly entry?: number;
}

/** 当前 uncertain 游标：来源加上已读到的 uncertain 目录键；没有键表示从头读。 */
interface UncertainCursor {
  readonly logId: string;
  readonly anchorEpoch: number;
  readonly key?: string;
}

const NOTICE_CURSOR_PREFIX = "dn1.";
const UNCERTAIN_CURSOR_PREFIX = "du1.";
const MAX_CURSOR_LENGTH = 512;

function encodeCursor(prefix: string, cursor: NoticeCursor | UncertainCursor): string {
  return prefix + Buffer.from(canonicalize(cursor), "utf8").toString("base64url");
}

/** 解出带来源的游标；来源字段不合法即拒绝，各自的位置字段由调用方核对。 */
function parseCursor(prefix: string, value: string, invalid: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH || !value.startsWith(prefix)) {
    throw new TypeError(invalid);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"));
  } catch (error) {
    throw new TypeError(invalid, { cause: error });
  }
  const cursor = parsed as Record<string, unknown> | null;
  if (
    !cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
    typeof cursor.logId !== "string" || cursor.logId.length === 0 ||
    !Number.isSafeInteger(cursor.anchorEpoch) || (cursor.anchorEpoch as number) <= 0
  ) {
    throw new TypeError(invalid);
  }
  return cursor;
}

function decodeNoticeCursor(value: string): NoticeCursor {
  const invalid = "Delivery notice cursor is invalid";
  const cursor = parseCursor(NOTICE_CURSOR_PREFIX, value, invalid);
  const position = cursor.lsn !== undefined || cursor.entry !== undefined;
  if (position && (
    !Number.isSafeInteger(cursor.lsn) || (cursor.lsn as number) < 0 ||
    !Number.isSafeInteger(cursor.entry) || (cursor.entry as number) < 0
  )) {
    throw new TypeError(invalid);
  }
  return cursor as unknown as NoticeCursor;
}

function decodeUncertainCursor(value: string): UncertainCursor {
  const invalid = "Delivery uncertain cursor is invalid";
  const cursor = parseCursor(UNCERTAIN_CURSOR_PREFIX, value, invalid);
  if (cursor.key !== undefined && (typeof cursor.key !== "string" || !isDeliveryUncertainKey(cursor.key))) {
    throw new TypeError(invalid);
  }
  return cursor as unknown as UncertainCursor;
}

async function materializeEntries(
  view: DurableProjectionReadContext,
  entries: readonly DeliveryDirectoryEntry[],
): Promise<DeliveryDirectoryPage["items"]> {
  const items = [];
  for (const { key, itemId } of entries) {
    const item = await readDeliveryItem(view, itemId);
    if (!item) throw corruptDelivery("Delivery directory names a missing item");
    items.push({ key, item: materializeDeliveryItem(item) });
  }
  return items;
}

function canonicalCopy<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON`, { cause: error });
  }
}

function corruptDelivery(message: string): AuthorityStorageError {
  return new AuthorityStorageError("commit-log-corrupt", message);
}
