import type { AuthorityCommitLog, DurableProjectionMutation, DurableProjectionReadContext } from "@zhixing/core/authority";
import { DurableProjectionRecordBindingError } from "@zhixing/core/authority";
import type { JsonValue } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";

/**
 * 当前安装指针：transfer:anchor-current 的真正末条、按 transferId 的安装记录，以及两类安装收尾的完成凭据
 * （灾备回执、计划迁居完成标记）。启动判断“当前安装是什么、是否已收尾”只做固定几次精确读，与历史迁居、
 * 灾备次数无关。归约只做形状检查，完整校验由读取方做。
 */
export const ANCHOR_INSTALLATION_PROJECTION_ID = "anchor-installation-current-v1";
export const ANCHOR_CURRENT_STREAM = "transfer:anchor-current";
export const DISASTER_POST_INSTALL_STREAM = "transfer:anchor-disaster-post-install";
export const PLANNED_POST_INSTALL_STREAM = "transfer:anchor-planned-post-install";

const CURRENT_KEY = "current";
const INSTALLATION_TYPES = new Set(["planned-anchor-installed", "disaster-anchor-installed"]);

export interface AnchorCurrentRecord {
  readonly lsn: number;
  readonly entry: number;
  readonly body: unknown;
}

export interface IndexedAnchorInstallation extends AnchorCurrentRecord {
  /** 同一 transferId 之后又出现的安装记录条数；非零即当前安装有歧义。 */
  readonly duplicates: number;
}

/** 按 transferId 的完成凭据；同一 transferId 出现内容不同的凭据时 conflict 为真。 */
export interface IndexedCompletion {
  readonly value: unknown;
  readonly conflict: boolean;
}

export interface AnchorInstallationIndexPort {
  durableProjection: AuthorityCommitLog["durableProjection"];
  transactDurableProjection: AuthorityCommitLog["transactDurableProjection"];
}

const keyFor = (prefix: string, transferId: string) =>
  `${prefix}${protocolDigest("AnchorInstallationIndexIdentity", 1, { transferId })}`;
const installedKey = (transferId: string) => keyFor("installed/", transferId);
const disasterReceiptKey = (transferId: string) => keyFor("disaster-receipt/", transferId);
const plannedCompletionKey = (transferId: string) => keyFor("planned-completion/", transferId);
/** 灾备转移摘要 → 安装记录里的根签 commit：继任证明按转移精确取，不扫安装历史。 */
const disasterCommitKey = (transitionDigest: string) => `disaster-commit/${transitionDigest}`;

function unsignedEventDigest(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const { signature: _signature, ...unsigned } = event as Record<string, unknown>;
  return protocolDigest("HomeTrustEvent", 1, unsigned);
}

function invalid(): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError("Anchor installation index row is invalid");
}

function transferIdOf(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const transferId = (body as { readonly transferId?: unknown }).transferId;
  return typeof transferId === "string" && transferId.length > 0 ? transferId : undefined;
}

function isInstallation(body: unknown): boolean {
  return transferIdOf(body) !== undefined &&
    INSTALLATION_TYPES.has(String((body as { readonly t?: unknown }).t));
}

function readPositioned(value: JsonValue | undefined): AnchorCurrentRecord | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { lsn, entry } = value;
  if (
    typeof lsn !== "number" || !Number.isSafeInteger(lsn) || lsn < 1 ||
    typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 ||
    !("body" in value)
  ) {
    throw invalid();
  }
  return { lsn, entry, body: value.body };
}

function readInstalled(value: JsonValue | undefined): IndexedAnchorInstallation | undefined {
  const positioned = readPositioned(value);
  if (!positioned) return undefined;
  const duplicates = (value as Record<string, JsonValue>).duplicates;
  if (typeof duplicates !== "number" || !Number.isSafeInteger(duplicates) || duplicates < 0) throw invalid();
  return { ...positioned, duplicates };
}

function readCompletion(value: JsonValue | undefined): IndexedCompletion | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.conflict !== "boolean" || !("value" in value)) {
    throw invalid();
  }
  return { value: value.value, conflict: value.conflict };
}

/** 本机日志的所有写者在首次写入前登记；按 projectionId 幂等。 */
export function registerAnchorInstallationIndex(log: Pick<AnchorInstallationIndexPort, "durableProjection">): void {
  log.durableProjection({
    projectionId: ANCHOR_INSTALLATION_PROJECTION_ID,
    reducerVersion: 2,
    authenticated: true,
    inputs: { streams: [ANCHOR_CURRENT_STREAM, DISASTER_POST_INSTALL_STREAM, PLANNED_POST_INSTALL_STREAM] },
    reduce: async (envelope, current) => {
      const changes: DurableProjectionMutation[] = [];
      const overlay = new Map<string, JsonValue>();
      const read = async (key: string) => overlay.has(key) ? overlay.get(key) : current.get(key);
      const put = (key: string, value: JsonValue) => {
        overlay.set(key, value);
        changes.push({ kind: "put", key, value });
      };
      for (const [entry, record] of envelope.entries.entries()) {
        if (record.stream === ANCHOR_CURRENT_STREAM) {
          const body = record.body as JsonValue;
          put(CURRENT_KEY, { lsn: envelope.lsn, entry, body });
          const transferId = transferIdOf(body);
          if (transferId !== undefined && isInstallation(body)) {
            const existing = readInstalled(await read(installedKey(transferId)));
            put(installedKey(transferId), existing
              ? { lsn: existing.lsn, entry: existing.entry, body: existing.body as JsonValue, duplicates: existing.duplicates + 1 }
              : { lsn: envelope.lsn, entry, body, duplicates: 0 });
            const installed = body as Record<string, JsonValue>;
            const transitionDigest = installed.t === "disaster-anchor-installed" ? unsignedEventDigest(installed.transition) : undefined;
            if (transitionDigest && installed.commit && !(await read(disasterCommitKey(transitionDigest)))) {
              put(disasterCommitKey(transitionDigest), installed.commit);
            }
          }
          continue;
        }
        const keyOf = record.stream === DISASTER_POST_INSTALL_STREAM
          ? disasterReceiptKey
          : record.stream === PLANNED_POST_INSTALL_STREAM ? plannedCompletionKey : undefined;
        const transferId = transferIdOf(record.body);
        if (!keyOf || transferId === undefined) continue;
        const existing = readCompletion(await read(keyOf(transferId)));
        if (existing === undefined) {
          put(keyOf(transferId), { value: record.body as JsonValue, conflict: false });
        } else if (!existing.conflict && canonicalize(existing.value) !== canonicalize(record.body)) {
          put(keyOf(transferId), { value: existing.value as JsonValue, conflict: true });
        }
      }
      return changes;
    },
  });
}

/** 一次精确读：当前末条、它对应的安装记录与两类完成凭据。 */
export async function readAnchorInstallationState(
  log: AnchorInstallationIndexPort,
  transferId?: string,
): Promise<{
  readonly current?: AnchorCurrentRecord;
  readonly installation?: IndexedAnchorInstallation;
  readonly disasterReceipt?: IndexedCompletion;
  readonly plannedCompletion?: IndexedCompletion;
}> {
  registerAnchorInstallationIndex(log);
  return (await log.transactDurableProjection(ANCHOR_INSTALLATION_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const current = readPositioned(await view.get(CURRENT_KEY));
    const id = transferId ?? (current && isInstallation(current.body) ? transferIdOf(current.body) : undefined);
    if (id === undefined) return { kind: "return" as const, value: current ? { current } : {} };
    const installation = readInstalled(await view.get(installedKey(id)));
    const disasterReceipt = readCompletion(await view.get(disasterReceiptKey(id)));
    const plannedCompletion = readCompletion(await view.get(plannedCompletionKey(id)));
    return {
      kind: "return" as const,
      value: {
        ...(current ? { current } : {}),
        ...(installation ? { installation } : {}),
        ...(disasterReceipt ? { disasterReceipt } : {}),
        ...(plannedCompletion ? { plannedCompletion } : {}),
      },
    };
  })).value;
}

/** 某条灾备转移的根签 commit（形状由调用方按恢复根验）；本机日志里没有这次安装返回 undefined。 */
export async function readDisasterRecoveryCommit(
  log: AnchorInstallationIndexPort,
  transitionDigest: string,
): Promise<unknown> {
  registerAnchorInstallationIndex(log);
  return (await log.transactDurableProjection(ANCHOR_INSTALLATION_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: await view.get(disasterCommitKey(transitionDigest)),
  }))).value;
}

/**
 * 按 transferId 写入一条完成凭据：已有相同内容原样返回，内容不同即失败关闭。
 * 读取与追加在同一投影事务内，凭据只写一次。
 */
export async function recordAnchorInstallationCompletion<Value>(
  log: AnchorInstallationIndexPort,
  input: {
    readonly stream: typeof DISASTER_POST_INSTALL_STREAM | typeof PLANNED_POST_INSTALL_STREAM;
    readonly transferId: string;
    readonly value: Value;
    readonly conflictMessage: string;
  },
): Promise<Value> {
  registerAnchorInstallationIndex(log);
  const key = input.stream === DISASTER_POST_INSTALL_STREAM
    ? disasterReceiptKey(input.transferId)
    : plannedCompletionKey(input.transferId);
  return (await log.transactDurableProjection<JsonValue, Value>(ANCHOR_INSTALLATION_PROJECTION_ID, async (view) => {
    const existing = readCompletion(await view.get(key));
    if (existing) {
      if (existing.conflict || canonicalize(existing.value) !== canonicalize(input.value)) {
        throw new Error(input.conflictMessage);
      }
      return { kind: "return", value: existing.value as Value };
    }
    return {
      kind: "append",
      entries: [{ stream: input.stream, body: input.value as unknown as JsonValue }],
      value: input.value,
    };
  })).value;
}
