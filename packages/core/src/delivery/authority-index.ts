import type {
  CommitEnvelope,
  DeliveryItemState,
  DeliveryStreamRecord,
  JsonValue,
  LogicalRecord,
} from "../contracts/index.js";
import {
  AuthorityStorageError,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
  type RebuildableDurableProjectionIndex,
} from "../authority/index.js";
import {
  DELIVERY_STREAM,
  emptyDeliveryProjection,
  reduceDeliveryAuthorityRecord,
  validateDeliveryStreamRecord,
  type DeliveryProjection,
  type DeliveryStatusNoticeEntry,
  type MutableDeliveryItem,
} from "./authority.js";
import { assertDeliveryItemId } from "./validation.js";

/**
 * 投递权威的按键持久投影：同一份投递领域归约在提交时把结果逐条落键，读取按条目、唯一键与目录精确进行，
 * 读量与已结束的投递历史无关。
 */
export const DELIVERY_AUTHORITY_PROJECTION_ID = "delivery-authority-v1";
const REDUCER_VERSION = 2;

const ITEM_PREFIX = "item/";
const UNIQUE_PREFIX = "key/";
const READY_PREFIX = "ready/";
const RETRY_PREFIX = "retry/";
const UNCERTAIN_PREFIX = "uncertain/";
const PENDING_PREFIX = "pending/";
const COUNT_PREFIX = "count/";
const NOTICE_PREFIX = "notice/";
const NOTICE_ORDER_PREFIX = "notice-order/";

/** 领取顺序：高优先级在前。 */
export const DELIVERY_PRIORITY_RANKS = ["high", "normal", "low"] as const;
export type DeliveryPriority = (typeof DELIVERY_PRIORITY_RANKS)[number];

export const DELIVERY_ITEM_STATES: readonly DeliveryItemState[] = [
  "queued",
  "attempting",
  "retry-wait",
  "uncertain",
  "sent",
  "failed",
  "verified-sent",
  "abandoned",
];

/** 条目行：领域条目加上它在当前目录里的入列位置（进入当前目录类——待领取、重试或 uncertain——时的日志位置）。 */
interface StoredDeliveryItem {
  readonly item: MutableDeliveryItem;
  readonly order: number;
}

/** 一条状态通知在全局顺序里的位置：日志位置与它在 envelope 里的序号。 */
export interface DeliveryNoticePosition {
  readonly lsn: number;
  readonly entry: number;
}

export interface DeliveryNoticeOrderEntry extends DeliveryNoticePosition {
  readonly itemId: string;
  readonly notice: DeliveryStatusNoticeEntry;
}

const fixed = (value: number, width: number) => String(value).padStart(width, "0");
export const deliveryItemKey = (itemId: string) => `${ITEM_PREFIX}${itemId}`;
const uniqueKey = (idempotencyKey: string) => `${UNIQUE_PREFIX}${idempotencyKey}`;
const countKey = (state: DeliveryItemState) => `${COUNT_PREFIX}${state}`;
const noticeKey = (itemId: string, statusRevision: number) =>
  `${NOTICE_PREFIX}${itemId}/${fixed(statusRevision, 10)}`;
const noticeOrderKey = (position: DeliveryNoticePosition) =>
  `${NOTICE_ORDER_PREFIX}${fixed(position.lsn, 16)}/${fixed(position.entry, 6)}`;
const rank = (priority: DeliveryPriority) => DELIVERY_PRIORITY_RANKS.indexOf(priority);
const readyPrefix = (priority: DeliveryPriority) => `${READY_PREFIX}${rank(priority)}/`;
const retryPrefix = (priority: DeliveryPriority) => `${RETRY_PREFIX}${rank(priority)}/`;

export function registerDeliveryAuthorityProjection(
  log: AuthorityCommitLog,
): RebuildableDurableProjectionIndex {
  return log.durableProjection({
    projectionId: DELIVERY_AUTHORITY_PROJECTION_ID,
    reducerVersion: REDUCER_VERSION,
    authenticated: true,
    inputs: { streams: [DELIVERY_STREAM] },
    reduce: reduceDeliveryAuthorityIndex,
  });
}

type DirectoryClass = "ready" | "retry" | "uncertain" | "none";

function directoryClass(state: DeliveryItemState): DirectoryClass {
  if (state === "queued" || state === "attempting") return "ready";
  if (state === "retry-wait") return "retry";
  if (state === "uncertain") return "uncertain";
  return "none";
}

function isPending(state: DeliveryItemState): boolean {
  return directoryClass(state) !== "none";
}

function directoryKeys(row: StoredDeliveryItem): readonly string[] {
  const { item, order } = row;
  const keys: string[] = [];
  const priority = item.intent.priority as DeliveryPriority;
  switch (directoryClass(item.state)) {
    case "ready":
      keys.push(`${readyPrefix(priority)}${fixed(order, 16)}/${item.id}`);
      break;
    case "retry":
      if (!item.nextAttemptAt) throw corruptDeliveryIndex("Retry-wait delivery has no next attempt time");
      keys.push(`${retryPrefix(priority)}${item.nextAttemptAt}/${item.id}`);
      break;
    case "uncertain":
      keys.push(`${UNCERTAIN_PREFIX}${fixed(order, 16)}/${item.id}`);
      break;
    case "none":
      break;
  }
  if (isPending(item.state)) keys.push(`${PENDING_PREFIX}${item.id}`);
  return keys;
}

function deliveryRecordItemId(record: DeliveryStreamRecord): string {
  return record.t === "delivery-resolved" ? record.fact.itemId : record.itemId;
}

async function reduceDeliveryAuthorityIndex(
  envelope: CommitEnvelope<JsonValue>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const records = envelope.entries
    .map((entry, index) => ({ entry: entry as LogicalRecord<unknown>, index }))
    .filter(({ entry }) => entry.stream === DELIVERY_STREAM);
  if (records.length === 0) return [];
  // 只装入本 envelope 触及的条目与唯一键，在这份小投影上运行原领域归约
  const state = emptyDeliveryProjection();
  const before = new Map<string, StoredDeliveryItem | undefined>();
  for (const { entry } of records) {
    const record = validateDeliveryStreamRecord(entry.body);
    const itemId = deliveryRecordItemId(record);
    if (!before.has(itemId)) {
      const row = await readStoredItem(current, itemId);
      before.set(itemId, row);
      if (row) {
        state.items.set(itemId, structuredClone(row.item));
        state.itemByKey.set(row.item.idempotencyKey, itemId);
      }
    }
    if (record.t === "enqueued" && !state.itemByKey.has(record.idempotencyKey)) {
      const existing = await current.get(uniqueKey(record.idempotencyKey));
      if (existing !== undefined) state.itemByKey.set(record.idempotencyKey, indexedItemId(existing));
    }
  }
  const notices: Array<{ readonly itemId: string; readonly notice: DeliveryStatusNoticeEntry; readonly entry: number }> = [];
  const seenNotices = new Map<string, number>();
  for (const { entry, index } of records) {
    reduceDeliveryAuthorityRecord(state, entry, envelope as CommitEnvelope<unknown>);
    const itemId = deliveryRecordItemId(entry.body as DeliveryStreamRecord);
    const history = state.statusNotices.get(itemId) ?? [];
    for (let next = seenNotices.get(itemId) ?? 0; next < history.length; next += 1) {
      notices.push({ itemId, notice: history[next]!, entry: index });
    }
    seenNotices.set(itemId, history.length);
  }

  const mutations: DurableProjectionMutation[] = [];
  const put = (key: string, value: JsonValue) => mutations.push({ kind: "put", key, value });
  const tombstone = (key: string) => mutations.push({ kind: "tombstone", key });
  const counts = new Map<DeliveryItemState, number>();
  for (const [itemId, previous] of before) {
    const item = state.items.get(itemId);
    if (!item) throw corruptDeliveryIndex("Delivery item disappeared during reduction");
    // 同一目录类里保持原位置；新进入待领取或 uncertain 目录时排在本次提交的位置
    const order = previous && directoryClass(previous.item.state) === directoryClass(item.state)
      ? previous.order
      : envelope.lsn;
    const next: StoredDeliveryItem = { item, order };
    if (!previous) put(uniqueKey(item.idempotencyKey), item.id);
    put(deliveryItemKey(itemId), storedValue(next));
    const removed = new Set(previous ? directoryKeys(previous) : []);
    for (const key of directoryKeys(next)) {
      if (removed.has(key)) removed.delete(key);
      else put(key, item.id);
    }
    for (const key of removed) tombstone(key);
    if (previous?.item.state !== item.state) {
      if (previous) counts.set(previous.item.state, (counts.get(previous.item.state) ?? 0) - 1);
      counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
    }
  }
  for (const [itemState, delta] of counts) {
    if (delta === 0) continue;
    const value = countValue(await current.get(countKey(itemState))) + delta;
    if (value < 0) throw corruptDeliveryIndex("Delivery state count is negative");
    put(countKey(itemState), value);
  }
  for (const { itemId, notice, entry } of notices) {
    put(noticeKey(itemId, notice.record.statusRevision), storedValue(notice));
    // 顺序行带上通知本身：全局翻页是一段连续扫描，不再逐条按条目点读（分散的点读随历史变多而变贵）
    const position = { lsn: envelope.lsn, entry };
    put(noticeOrderKey(position), { itemId, notice: storedValue(notice) });
  }
  return mutations;
}

// ---- 读取 ----

async function readStoredItem(
  view: DurableProjectionReadContext,
  itemId: string,
): Promise<StoredDeliveryItem | undefined> {
  const value = await view.get(deliveryItemKey(itemId));
  if (value === undefined) return undefined;
  const row = value as unknown as StoredDeliveryItem;
  if (!row || typeof row !== "object" || !row.item || row.item.id !== itemId || !Number.isSafeInteger(row.order)) {
    throw corruptDeliveryIndex("Delivery item row is invalid");
  }
  return row;
}

export async function readDeliveryItem(
  view: DurableProjectionReadContext,
  itemId: string,
): Promise<MutableDeliveryItem | undefined> {
  return (await readStoredItem(view, itemId))?.item;
}

/** 条目与它进入当前目录类时的日志位置（排空据此判定是否在本轮上界之内）。 */
export async function readDeliveryItemWithOrder(
  view: DurableProjectionReadContext,
  itemId: string,
): Promise<{ readonly item: MutableDeliveryItem; readonly order: number } | undefined> {
  return readStoredItem(view, itemId);
}

/** uncertain 目录键（游标续读用）：只接受本目录前缀下的键。 */
export function isDeliveryUncertainKey(key: string): boolean {
  return key.startsWith(UNCERTAIN_PREFIX) && key.length <= 256;
}

export async function readDeliveryItemIdByKey(
  view: DurableProjectionReadContext,
  idempotencyKey: string,
): Promise<string | undefined> {
  const value = await view.get(uniqueKey(idempotencyKey));
  return value === undefined ? undefined : indexedItemId(value);
}

/** 按条目号装入一份只含这些条目的领域投影，供同步的领域决定使用；缺的条目不装。 */
export async function loadDeliveryProjection(
  view: DurableProjectionReadContext,
  itemIds: Iterable<string>,
  into: DeliveryProjection = emptyDeliveryProjection(),
): Promise<DeliveryProjection> {
  for (const itemId of itemIds) {
    if (into.items.has(itemId)) continue;
    const item = await readDeliveryItem(view, itemId);
    if (!item) continue;
    into.items.set(itemId, item);
    into.itemByKey.set(item.idempotencyKey, itemId);
  }
  return into;
}

export async function readDeliveryStateCounts(
  view: DurableProjectionReadContext,
): Promise<Readonly<Record<DeliveryItemState, number>>> {
  const counts = {} as Record<DeliveryItemState, number>;
  for (const state of DELIVERY_ITEM_STATES) counts[state] = countValue(await view.get(countKey(state)));
  return counts;
}

export async function readDeliveryNotice(
  view: DurableProjectionReadContext,
  itemId: string,
  statusRevision: number,
): Promise<DeliveryStatusNoticeEntry | undefined> {
  const value = await view.get(noticeKey(itemId, statusRevision));
  return value === undefined ? undefined : noticeEntry(value, itemId, statusRevision);
}

/** 一个条目修订号大于 after 的通知，按修订号升序，至多 limit 条。 */
export async function readDeliveryNoticesAfter(
  view: DurableProjectionReadContext,
  itemId: string,
  afterStatusRevision: number,
  limit: number,
): Promise<{ readonly notices: readonly DeliveryStatusNoticeEntry[]; readonly more: boolean }> {
  assertDeliveryItemId(itemId);
  const page = await view.scan(
    { gt: noticeKey(itemId, afterStatusRevision), lt: `${NOTICE_PREFIX}${itemId}/￿` },
    limit,
  );
  return {
    notices: page.entries.map(({ value }) => noticeEntry(value)),
    more: page.continuation !== undefined,
  };
}

/** 全局通知顺序：位置严格在 after 之后的至多 limit 条。 */
export async function readDeliveryNoticeOrder(
  view: DurableProjectionReadContext,
  after: DeliveryNoticePosition | undefined,
  limit: number,
): Promise<{ readonly entries: readonly DeliveryNoticeOrderEntry[]; readonly more: boolean }> {
  const page = await view.scan(
    {
      ...(after ? { gt: noticeOrderKey(after) } : { gte: NOTICE_ORDER_PREFIX }),
      lt: `${NOTICE_ORDER_PREFIX}￿`,
    },
    limit,
  );
  return {
    entries: page.entries.map(({ key, value }) => noticeOrderEntry(key, value)),
    more: page.continuation !== undefined,
  };
}

export interface DeliveryDirectoryEntry {
  readonly key: string;
  readonly itemId: string;
}

async function readDirectory(
  view: DurableProjectionReadContext,
  range: { readonly gte?: string; readonly gt?: string; readonly lt: string },
  limit: number,
): Promise<{ readonly entries: readonly DeliveryDirectoryEntry[]; readonly more: boolean }> {
  const page = await view.scan(range, limit);
  return {
    entries: page.entries.map(({ key, value }) => ({ key, itemId: indexedItemId(value) })),
    more: page.continuation !== undefined,
  };
}

/** 某个优先级的待领取目录（queued 与 attempting），按入列位置升序，从 afterKey 之后续读。 */
export function readDeliveryReadyPage(
  view: DurableProjectionReadContext,
  priority: DeliveryPriority,
  afterKey: string | undefined,
  limit: number,
) {
  const prefix = readyPrefix(priority);
  return readDirectory(view, { ...(afterKey ? { gt: afterKey } : { gte: prefix }), lt: `${prefix}￿` }, limit);
}

/** 某个优先级里下次尝试时间不晚于 now 的重试，按时间升序。 */
export function readDeliveryRetryDuePage(
  view: DurableProjectionReadContext,
  priority: DeliveryPriority,
  now: string,
  afterKey: string | undefined,
  limit: number,
) {
  const prefix = retryPrefix(priority);
  return readDirectory(view, { ...(afterKey ? { gt: afterKey } : { gte: prefix }), lt: `${prefix}${now}￿` }, limit);
}

export function readDeliveryUncertainPage(
  view: DurableProjectionReadContext,
  afterKey: string | undefined,
  limit: number,
) {
  return readDirectory(view, {
    ...(afterKey ? { gt: afterKey } : { gte: UNCERTAIN_PREFIX }),
    lt: `${UNCERTAIN_PREFIX}￿`,
  }, limit);
}

/** pending 目录（queued、attempting、retry-wait、uncertain），按条目号升序。 */
export function readDeliveryPendingPage(
  view: DurableProjectionReadContext,
  afterKey: string | undefined,
  limit: number,
) {
  return readDirectory(view, {
    ...(afterKey ? { gt: afterKey } : { gte: PENDING_PREFIX }),
    lt: `${PENDING_PREFIX}￿`,
  }, limit);
}

// ---- 值的校验 ----

function indexedItemId(value: JsonValue): string {
  if (typeof value !== "string") throw corruptDeliveryIndex("Delivery index entry is not an item id");
  assertDeliveryItemId(value);
  return value;
}

function countValue(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw corruptDeliveryIndex("Delivery state count is invalid");
  }
  return value as number;
}

function noticeEntry(value: JsonValue, itemId?: string, statusRevision?: number): DeliveryStatusNoticeEntry {
  const entry = value as unknown as DeliveryStatusNoticeEntry;
  if (!entry || typeof entry !== "object" || !entry.record || typeof entry.at !== "string") {
    throw corruptDeliveryIndex("Delivery notice row is invalid");
  }
  validateDeliveryStreamRecord(entry.record);
  if (statusRevision !== undefined && entry.record.statusRevision !== statusRevision) {
    throw corruptDeliveryIndex("Delivery notice row does not match its key");
  }
  if (itemId !== undefined && deliveryRecordItemId(entry.record) !== itemId) {
    throw corruptDeliveryIndex("Delivery notice row does not match its item");
  }
  return entry;
}

function noticeOrderEntry(key: string, value: JsonValue): DeliveryNoticeOrderEntry {
  const [lsn, entry] = key.slice(NOTICE_ORDER_PREFIX.length).split("/").map(Number);
  const body = value as { readonly itemId?: unknown; readonly notice?: JsonValue };
  if (
    !Number.isSafeInteger(lsn) || !Number.isSafeInteger(entry) ||
    typeof body?.itemId !== "string" || body.notice === undefined
  ) {
    throw corruptDeliveryIndex("Delivery notice order row is invalid");
  }
  return { lsn: lsn!, entry: entry!, itemId: body.itemId, notice: noticeEntry(body.notice, body.itemId) };
}

/** 写入持久行前去掉值为 undefined 的字段（领域归约会把可选字段清成 undefined）。 */
function storedValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function corruptDeliveryIndex(message: string): AuthorityStorageError {
  return new AuthorityStorageError("commit-log-corrupt", message);
}
