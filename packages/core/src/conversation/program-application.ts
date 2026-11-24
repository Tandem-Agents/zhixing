import { Buffer } from "node:buffer";
import type {
  ConversationBodyCursor,
  ConversationRunState,
} from "../contracts/index.js";
import { canonicalize, protocolDigest } from "../protocol/canonical.js";
import {
  compareDirectoryKeys,
  type ConversationDirectoryCursor,
  type ConversationDirectoryScopeKind,
  type ConversationDirectorySourceVersion,
} from "./directory-page.js";

/** Maximum raw single-frame budget shared by RPC and Mesh request channels (1 MiB). */
export const PROGRAM_SINGLE_FRAME_MAX_BYTES = 1024 * 1024;
/** Conservative UTF-8 JSON-encoded payload budget leaving headroom for JSON-RPC + Mesh envelopes. */
export const PROGRAM_SAFE_PAYLOAD_BUDGET_BYTES = 900 * 1024;
/** Maximum per-hop slice duration for bounded `--wait` polling (`<= 15_000 ms`). */
export const PROGRAM_MAX_WAIT_SLICE_MS = 15_000;

export type ProgramConversationScopeFilter =
  | "all"
  | ConversationDirectoryScopeKind;

export type ProgramConversationErrorCode =
  | "invalid_params"
  | "invalid_ticket"
  | "invalid_cursor"
  | "payload_too_large"
  | "not_found"
  | "target_deleted"
  | "cleared"
  | "needs_attention"
  | "host_draining"
  | "queue_full"
  | "idempotency_conflict"
  | "cursor_expired"
  | "temporarily_unavailable"
  | "unknown"
  | "uncertain"
  | "unsupported_host_version"
  | "unauthorized";

export class ProgramConversationError extends Error {
  constructor(
    public readonly code: ProgramConversationErrorCode,
    message: string,
    public readonly options?: {
      readonly retryable?: boolean;
      readonly exitCode?: 1 | 2 | 3;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "ProgramConversationError";
  }
}

export interface ProgramConversationExistingEntry {
  readonly entryKind: "conversation";
  readonly canonicalKey: string;
  readonly conversationId: string;
  readonly scope: ConversationDirectoryScopeKind;
  readonly name: string;
  readonly sceneId?: string;
  readonly sceneName?: string;
  readonly workspaceLabel?: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pendingCount: number;
  readonly advancementStatus?: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly lastActiveAt: string;
}

export interface ProgramWorksceneCandidateEntry {
  readonly entryKind: "workscene-candidate";
  readonly canonicalKey: string;
  readonly scope: "workscene";
  readonly sceneId: string;
  readonly sceneName: string;
  readonly workspaceLabel?: string;
  readonly initialized: false;
  readonly lastActiveAt: string;
}

export type ProgramConversationDirectoryEntry =
  | ProgramConversationExistingEntry
  | ProgramWorksceneCandidateEntry;

export interface ProgramConversationListInput {
  readonly query?: string;
  readonly scope?: ProgramConversationScopeFilter;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProgramConversationListResult {
  readonly v: 1;
  readonly entries: readonly ProgramConversationDirectoryEntry[];
  readonly nextCursor?: string;
  readonly partial: boolean;
  readonly unreachableDevices?: readonly string[];
}

export interface ProgramConversationNewInput {
  readonly requestId: string;
  readonly name?: string;
  readonly sceneId?: string;
}

export interface ProgramConversationNewResult {
  readonly v: 1;
  readonly conversationId: string;
  readonly scope: "main" | "workscene";
  readonly sceneId?: string;
  readonly created: boolean;
}

export interface ProgramConversationReadMessageEntry {
  readonly runId: string;
  readonly runIndex: number;
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly role: string;
  readonly type: string;
  readonly text: string;
  readonly offset: number;
  readonly length: number;
  readonly final: boolean;
  readonly sourceConversationId?: string;
  readonly programOrigin?: true;
}

export interface ProgramConversationPendingInputEntry {
  readonly runId: string;
  readonly state: ConversationRunState;
  readonly consumed: boolean;
  readonly disposition: "pending" | "consumed" | "stopped";
  readonly text: string;
  readonly sourceConversationId?: string;
  readonly programOrigin?: true;
}

export interface ProgramConversationReadInput {
  readonly conversationId: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface ProgramConversationReadResult {
  readonly v: 1;
  readonly conversationId: string;
  readonly scope: ConversationDirectoryScopeKind;
  readonly entries: readonly ProgramConversationReadMessageEntry[];
  readonly inputsOutsideHistory: readonly ProgramConversationPendingInputEntry[];
  readonly inputsOutsideHistoryTruncated: boolean;
  readonly hasMore: boolean;
  readonly nextBefore?: string;
}

export interface ProgramConversationSendInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly text: string;
}

export type ProgramConversationSendResult =
  | {
      readonly v: 1;
      readonly admitted: true;
      readonly conversationId: string;
      readonly requestId: string;
      readonly runId: string;
      readonly replayed?: boolean;
    }
  | {
      readonly v: 1;
      readonly admitted: false;
      readonly conversationId: string;
      readonly requestId: string;
      readonly error: {
        readonly code: ProgramConversationErrorCode;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface ProgramConversationResultInput {
  readonly conversationId: string;
  readonly requestId: string;
  readonly waitMs?: number;
  readonly cursor?: string;
}

export type ProgramConversationResultState =
  | "completed"
  | "pending"
  | "failed"
  | "cancelled"
  | "cleared"
  | "target_deleted"
  | "unknown"
  | "temporarily_unavailable"
  | "uncertain"
  | "cursor_expired";

export interface ProgramConversationResultOutput {
  readonly v: 1;
  readonly state: ProgramConversationResultState;
  readonly conversationId: string;
  readonly requestId: string;
  readonly runId?: string;
  readonly runState?: ConversationRunState | "missing" | "unknown";
  readonly answer?: string | null;
  readonly answerTruncated?: boolean;
  readonly emptyReason?: "no_assistant_text";
  readonly nextCursor?: string;
  readonly error?: {
    readonly code: ProgramConversationErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface ProgramConversationApplication {
  list(
    input: ProgramConversationListInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationListResult>;
  create(
    input: ProgramConversationNewInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationNewResult>;
  read(
    input: ProgramConversationReadInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationReadResult>;
  send(
    input: ProgramConversationSendInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationSendResult>;
  result(
    input: ProgramConversationResultInput,
    signal?: AbortSignal,
  ): Promise<ProgramConversationResultOutput>;
}

// ─── Opaque Directory & Body Cursors ───

const DIRECTORY_CURSOR_PREFIX = "zxdc1.";
const BODY_CURSOR_PREFIX = "zxbc1.";

export interface ProgramDirectoryCursorPayload {
  readonly v: 1;
  readonly filterDigest: string;
  readonly reachableOwnersDigest: string;
  readonly sourceVersionsDigest: string;
  readonly after: {
    readonly lastActiveAt: string;
    readonly canonicalKey: string;
  };
}

export function programDirectoryFilterDigest(input: {
  readonly scope: ProgramConversationScopeFilter;
  readonly query: string;
}): string {
  return protocolDigest("ProgramDirectoryFilter", 1, {
    scope: input.scope,
    query: input.query,
  });
}

export function encodeProgramDirectoryCursor(
  payload: ProgramDirectoryCursorPayload,
): string {
  return `${DIRECTORY_CURSOR_PREFIX}${Buffer.from(
    canonicalize(payload),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeProgramDirectoryCursor(
  cursor: string,
): ProgramDirectoryCursorPayload {
  if (
    typeof cursor !== "string" ||
    !cursor.startsWith(DIRECTORY_CURSOR_PREFIX) ||
    cursor.length <= DIRECTORY_CURSOR_PREFIX.length ||
    cursor.length > 8192
  ) {
    throw new ProgramConversationError(
      "invalid_cursor",
      "目录分页游标格式无效。",
      { retryable: false, exitCode: 1 },
    );
  }
  const raw = cursor.slice(DIRECTORY_CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new ProgramConversationError(
      "invalid_cursor",
      "目录分页游标编码无效。",
      { retryable: false, exitCode: 1 },
    );
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("non-canonical");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProgramConversationError(
      "invalid_cursor",
      "目录分页游标无法解析。",
      { retryable: false, exitCode: 1 },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProgramConversationError(
      "invalid_cursor",
      "目录分页游标结构无效。",
      { retryable: false, exitCode: 1 },
    );
  }
  const obj = parsed as Record<string, unknown>;
  const after = obj.after as Record<string, unknown> | undefined;
  if (
    Object.keys(obj).sort().join(",") !==
      "after,filterDigest,reachableOwnersDigest,sourceVersionsDigest,v" ||
    obj.v !== 1 ||
    typeof obj.filterDigest !== "string" ||
    typeof obj.reachableOwnersDigest !== "string" ||
    typeof obj.sourceVersionsDigest !== "string" ||
    !after ||
    typeof after !== "object" ||
    Array.isArray(after) ||
    Object.keys(after).sort().join(",") !== "canonicalKey,lastActiveAt" ||
    typeof after.canonicalKey !== "string" ||
    after.canonicalKey.length === 0 ||
    typeof after.lastActiveAt !== "string" ||
    !Number.isFinite(Date.parse(after.lastActiveAt))
  ) {
    throw new ProgramConversationError(
      "invalid_cursor",
      "目录分页游标字段无效。",
      { retryable: false, exitCode: 1 },
    );
  }
  return {
    v: 1,
    filterDigest: obj.filterDigest,
    reachableOwnersDigest: obj.reachableOwnersDigest,
    sourceVersionsDigest: obj.sourceVersionsDigest,
    after: {
      canonicalKey: after.canonicalKey,
      lastActiveAt: after.lastActiveAt,
    },
  };
}

export interface ProgramBodyCursorPayload {
  readonly v: 1;
  readonly kind: "read-before" | "result-answer";
  readonly runId?: string;
  readonly remainingRuns?: number;
  readonly previousBlock?: number;
  readonly bodyCursor: ConversationBodyCursor;
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) {
      out[k] = stripUndefinedDeep(v);
    }
  }
  return out as T;
}

export function encodeProgramBodyCursor(
  payload: ProgramBodyCursorPayload,
): string {
  return `${BODY_CURSOR_PREFIX}${Buffer.from(
    canonicalize(stripUndefinedDeep(payload)),
    "utf8",
  ).toString("base64url")}`;
}

export function decodeProgramBodyCursor(
  cursor: string,
  expectedKind: "read-before" | "result-answer",
  expectedConversationId: string,
  expectedRunId?: string,
): ProgramBodyCursorPayload {
  if (
    typeof cursor !== "string" ||
    !cursor.startsWith(BODY_CURSOR_PREFIX) ||
    cursor.length <= BODY_CURSOR_PREFIX.length ||
    cursor.length > 8192
  ) {
    throw new ProgramConversationError("invalid_cursor", "正文游标格式无效。", {
      retryable: false,
      exitCode: 1,
    });
  }
  const raw = cursor.slice(BODY_CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(raw)) {
    throw new ProgramConversationError("invalid_cursor", "正文游标编码无效。", {
      retryable: false,
      exitCode: 1,
    });
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error("non-canonical");
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProgramConversationError("invalid_cursor", "正文游标无法解析。", {
      retryable: false,
      exitCode: 1 },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProgramConversationError("invalid_cursor", "正文游标结构无效。", {
      retryable: false,
      exitCode: 1,
    });
  }
  const obj = parsed as Record<string, unknown>;
  const bodyCursor = obj.bodyCursor as ConversationBodyCursor | undefined;
  if (
    obj.v !== 1 ||
    obj.kind !== expectedKind ||
    !bodyCursor ||
    typeof bodyCursor !== "object" ||
    bodyCursor.conversationId !== expectedConversationId ||
    typeof bodyCursor.ownerEpoch !== "number" ||
    !Number.isSafeInteger(bodyCursor.ownerEpoch) ||
    bodyCursor.ownerEpoch < 1 ||
    typeof bodyCursor.revision !== "number" ||
    !Number.isSafeInteger(bodyCursor.revision) ||
    bodyCursor.revision < 0 ||
    typeof bodyCursor.message !== "number" ||
    !Number.isSafeInteger(bodyCursor.message) ||
    bodyCursor.message < 0 ||
    typeof bodyCursor.block !== "number" ||
    !Number.isSafeInteger(bodyCursor.block) ||
    bodyCursor.block < -1 ||
    typeof bodyCursor.offset !== "number" ||
    !Number.isSafeInteger(bodyCursor.offset) ||
    bodyCursor.offset < 0 ||
    (expectedRunId !== undefined && obj.runId !== expectedRunId)
  ) {
    throw new ProgramConversationError("invalid_cursor", "正文游标与目标不匹配。", {
      retryable: false,
      exitCode: 1,
    });
  }
  return {
    v: 1,
    kind: expectedKind,
    ...(typeof obj.runId === "string" ? { runId: obj.runId } : {}),
    ...(typeof obj.remainingRuns === "number" &&
    Number.isSafeInteger(obj.remainingRuns) &&
    obj.remainingRuns >= 0
      ? { remainingRuns: obj.remainingRuns }
      : {}),
    ...(typeof obj.previousBlock === "number" &&
    Number.isSafeInteger(obj.previousBlock)
      ? { previousBlock: obj.previousBlock }
      : {}),
    bodyCursor,
  };
}

/**
 * Slices a UTF-16 string from `startOffset` so its JSON-serialized UTF-8 byte
 * length (`JSON.stringify(slice)`) stays strictly `<= maxJsonEncodedBytes`
 * without splitting surrogate pairs.
 */
export function sliceTextWithinJsonByteBudget(
  text: string,
  startOffset: number,
  maxJsonEncodedBytes: number,
): { readonly chunk: string; readonly nextOffset: number } {
  if (startOffset >= text.length || maxJsonEncodedBytes <= 2) {
    return { chunk: "", nextOffset: startOffset };
  }
  // Worst-case UTF-8 JSON expansion per UTF-16 code unit is 6 bytes (\uXXXX).
  let low = 1;
  let high = Math.min(text.length - startOffset, Math.max(1, maxJsonEncodedBytes));
  let bestEnd = startOffset;
  // Fast path if remaining fits easily.
  const fullCandidate = text.slice(startOffset, startOffset + high);
  if (Buffer.byteLength(JSON.stringify(fullCandidate), "utf8") <= maxJsonEncodedBytes) {
    let end = startOffset + high;
    if (
      end < text.length &&
      end > startOffset &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]!)
    ) {
      end -= 1;
    }
    return { chunk: text.slice(startOffset, end), nextOffset: end };
  }
  while (low <= high) {
    const mid = (low + high) >>> 1;
    let end = startOffset + mid;
    if (
      end < text.length &&
      end > startOffset &&
      /[\uD800-\uDBFF]/u.test(text[end - 1]!)
    ) {
      end -= 1;
    }
    if (end <= startOffset) {
      low = mid + 1;
      continue;
    }
    const encodedBytes = Buffer.byteLength(
      JSON.stringify(text.slice(startOffset, end)),
      "utf8",
    );
    if (encodedBytes <= maxJsonEncodedBytes) {
      bestEnd = end;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (bestEnd <= startOffset) {
    // Advance at least one code point if budget permits a single character.
    const firstCode = text.codePointAt(startOffset)!;
    const step = firstCode > 0xffff ? 2 : 1;
    const oneChar = text.slice(startOffset, startOffset + step);
    if (Buffer.byteLength(JSON.stringify(oneChar), "utf8") <= maxJsonEncodedBytes) {
      bestEnd = startOffset + step;
    }
  }
  return { chunk: text.slice(startOffset, bestEnd), nextOffset: bestEnd };
}

/** Validates send request size against single-frame wire budget (including outer JSON-RPC + Mesh framing). */
export function estimateProgramSendWireBytes(input: {
  readonly conversationId: string;
  readonly requestId: string;
  readonly text: string;
}): number {
  const envelopeSample = {
    jsonrpc: "2.0",
    id: 999999,
    method: "conversation.program.send",
    params: {
      op: "entry",
      action: "send",
      conversationId: input.conversationId,
      requestId: input.requestId,
      text: input.text,
    },
    meshPadding: "x".repeat(2048),
  };
  return Buffer.byteLength(JSON.stringify(envelopeSample), "utf8");
}

// ─── Shared Multi-Source Bounded Directory Coordinator ───

export type RawDirectoryCandidate =
  | {
      readonly entryKind: "conversation";
      readonly canonicalKey: string;
      readonly conversationId: string;
      readonly scope: ConversationDirectoryScopeKind;
      readonly name: string;
      readonly sceneId?: string;
      readonly sceneName?: string;
      readonly workspaceLabel?: string;
      readonly lastActiveAt: string;
      readonly ownerSourceId: string;
    }
  | {
      readonly entryKind: "workscene-candidate";
      readonly canonicalKey: string;
      readonly scope: "workscene";
      readonly sceneId: string;
      readonly sceneName: string;
      readonly workspaceLabel?: string;
      readonly initialized: false;
      readonly lastActiveAt: string;
      readonly ownerSourceId: string;
    };

export interface DirectorySourcePageResult {
  readonly sourceId: string;
  readonly reachable: boolean;
  readonly unreachableDeviceId?: string;
  readonly version?: ConversationDirectorySourceVersion;
  readonly records: readonly RawDirectoryCandidate[];
  readonly hasMore: boolean;
}

export interface DirectorySourceProvider {
  readonly sourceId: string;
  readPage(input: {
    readonly scope: ProgramConversationScopeFilter;
    readonly query: string;
    readonly limit: number;
    readonly after?: ConversationDirectoryCursor;
    readonly signal?: AbortSignal;
  }): Promise<DirectorySourcePageResult>;
  recheckVersion?(signal?: AbortSignal): Promise<ConversationDirectorySourceVersion | undefined>;
  enrichConversation?(
    candidate: Extract<RawDirectoryCandidate, { entryKind: "conversation" }>,
    signal?: AbortSignal,
  ): Promise<ProgramConversationExistingEntry>;
}

export async function coordinateConversationDirectoryPage(input: {
  readonly request: ProgramConversationListInput;
  readonly sources: readonly DirectorySourceProvider[];
  readonly signal?: AbortSignal;
}): Promise<ProgramConversationListResult> {
  const limit = input.request.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ProgramConversationError(
      "invalid_params",
      "列表分页条数 limit 必须为 1 到 100 的整数。",
      { retryable: false, exitCode: 1 },
    );
  }
  const scope: ProgramConversationScopeFilter = input.request.scope ?? "all";
  if (!["all", "main", "workscene", "channel", "local"].includes(scope)) {
    throw new ProgramConversationError(
      "invalid_params",
      "作用域过滤 scope 仅支持 all、main、workscene、channel、local。",
      { retryable: false, exitCode: 1 },
    );
  }
  const rawQuery = input.request.query ?? "";
  if (typeof rawQuery !== "string" || rawQuery.length > 256) {
    throw new ProgramConversationError(
      "invalid_params",
      "搜索词长度不能超过 256 个字符。",
      { retryable: false, exitCode: 1 },
    );
  }
  const normalizedQuery = rawQuery.trim().toLocaleLowerCase();
  const filterDigest = programDirectoryFilterDigest({
    scope,
    query: normalizedQuery,
  });

  const decodedCursor = input.request.cursor
    ? decodeProgramDirectoryCursor(input.request.cursor)
    : undefined;
  if (decodedCursor && decodedCursor.filterDigest !== filterDigest) {
    throw new ProgramConversationError(
      "cursor_expired",
      "分页过滤条件已变化，请去掉 --cursor 重新从首页查询。",
      { retryable: true, exitCode: 3 },
    );
  }

  const afterCursor: ConversationDirectoryCursor | undefined = decodedCursor
    ? {
        conversationId: decodedCursor.after.canonicalKey,
        lastActiveAt: decodedCursor.after.lastActiveAt,
      }
    : undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal?.throwIfAborted();
    const pages = await Promise.all(
      input.sources.map((source) =>
        source.readPage({
          scope,
          query: normalizedQuery,
          limit,
          ...(afterCursor ? { after: afterCursor } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      ),
    );

    const reachablePages = pages.filter((page) => page.reachable);
    if (reachablePages.length === 0) {
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "当前没有可达的会话目录来源，请稍后重试。",
        { retryable: true, exitCode: 3 },
      );
    }

    const unreachableDevices = [
      ...new Set(
        pages
          .filter((page) => !page.reachable && page.unreachableDeviceId)
          .map((page) => page.unreachableDeviceId!),
      ),
    ].sort();
    const partial = pages.some((page) => !page.reachable);

    const reachableOwnersDigest = protocolDigest("ProgramDirectoryOwners", 1, {
      owners: reachablePages.map((page) => page.sourceId).sort(),
    });
    const allVersionsPresent = reachablePages.every(
      (page) => page.version !== undefined,
    );
    const sourceVersionsDigest = allVersionsPresent
      ? protocolDigest("ProgramDirectorySourceVersions", 1, {
          versions: reachablePages
            .map((page) => ({
              sourceId: page.sourceId,
              version: page.version!,
            }))
            .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
        })
      : undefined;

    if (decodedCursor) {
      if (
        decodedCursor.reachableOwnersDigest !== reachableOwnersDigest ||
        !sourceVersionsDigest ||
        decodedCursor.sourceVersionsDigest !== sourceVersionsDigest
      ) {
        throw new ProgramConversationError(
          "cursor_expired",
          "会话目录或可达成员在翻页期间已变化，请重新从首页查询。",
          { retryable: true, exitCode: 3 },
        );
      }
    }

    // Deduplicate by canonicalKey: materialized conversation wins over workscene-candidate.
    const byCanonicalKey = new Map<string, RawDirectoryCandidate>();
    for (const page of reachablePages) {
      for (const candidate of page.records) {
        if (
          afterCursor &&
          compareDirectoryKeys(
            {
              conversationId: candidate.canonicalKey,
              lastActiveAt: candidate.lastActiveAt,
            },
            afterCursor,
          ) <= 0
        ) {
          continue;
        }
        const existing = byCanonicalKey.get(candidate.canonicalKey);
        if (!existing) {
          byCanonicalKey.set(candidate.canonicalKey, candidate);
        } else if (
          existing.entryKind === "workscene-candidate" &&
          candidate.entryKind === "conversation"
        ) {
          byCanonicalKey.set(candidate.canonicalKey, candidate);
        }
      }
    }

    const sorted = [...byCanonicalKey.values()].sort((a, b) =>
      compareDirectoryKeys(
        { conversationId: a.canonicalKey, lastActiveAt: a.lastActiveAt },
        { conversationId: b.canonicalKey, lastActiveAt: b.lastActiveAt },
      ),
    );
    const selected = sorted.slice(0, limit);
    const hasMore =
      sorted.length > limit || reachablePages.some((page) => page.hasMore);

    // Post-read version consistency check across sources.
    let versionDrifted = false;
    for (const source of input.sources) {
      const prior = reachablePages.find(
        (page) => page.sourceId === source.sourceId,
      );
      if (!prior || !source.recheckVersion) continue;
      const rechecked = await source.recheckVersion(input.signal);
      if (!rechecked || canonicalize(rechecked) !== canonicalize(prior.version)) {
        versionDrifted = true;
        break;
      }
    }

    if (versionDrifted) {
      if (decodedCursor) {
        throw new ProgramConversationError(
          "cursor_expired",
          "会话目录在读取期间发生变更，请重新从首页查询。",
          { retryable: true, exitCode: 3 },
        );
      }
      if (attempt === 0) continue;
      throw new ProgramConversationError(
        "temporarily_unavailable",
        "会话目录正在高频更新，暂无法生成一致分页视图，请稍后重试。",
        { retryable: true, exitCode: 3 },
      );
    }

    if (hasMore && (!sourceVersionsDigest || selected.length === 0)) {
      throw new ProgramConversationError(
        decodedCursor ? "cursor_expired" : "temporarily_unavailable",
        "目录仍有后续条目但当前无法证成一致版本游标，请稍后重试。",
        { retryable: true, exitCode: 3 },
      );
    }

    const sourceById = new Map(input.sources.map((s) => [s.sourceId, s]));
    const entries: ProgramConversationDirectoryEntry[] = await Promise.all(
      selected.map(async (item): Promise<ProgramConversationDirectoryEntry> => {
        if (item.entryKind === "workscene-candidate") {
          return {
            entryKind: "workscene-candidate",
            canonicalKey: item.canonicalKey,
            scope: "workscene",
            sceneId: item.sceneId,
            sceneName: item.sceneName,
            ...(item.workspaceLabel ? { workspaceLabel: item.workspaceLabel } : {}),
            initialized: false,
            lastActiveAt: item.lastActiveAt,
          };
        }
        const provider = sourceById.get(item.ownerSourceId);
        if (provider?.enrichConversation) {
          return provider.enrichConversation(item, input.signal);
        }
        return {
          entryKind: "conversation",
          canonicalKey: item.canonicalKey,
          conversationId: item.conversationId,
          scope: item.scope,
          name: item.name,
          ...(item.sceneId ? { sceneId: item.sceneId } : {}),
          ...(item.sceneName ? { sceneName: item.sceneName } : {}),
          ...(item.workspaceLabel ? { workspaceLabel: item.workspaceLabel } : {}),
          active: false,
          busy: false,
          pendingCount: 0,
          summary: "",
          summaryTruncated: false,
          lastActiveAt: item.lastActiveAt,
        };
      }),
    );

    const last = selected.at(-1);
    const nextCursor =
      hasMore && last && sourceVersionsDigest
        ? encodeProgramDirectoryCursor({
            v: 1,
            filterDigest,
            reachableOwnersDigest,
            sourceVersionsDigest,
            after: {
              canonicalKey: last.canonicalKey,
              lastActiveAt: last.lastActiveAt,
            },
          })
        : undefined;

    return {
      v: 1,
      entries,
      ...(nextCursor ? { nextCursor } : {}),
      partial,
      ...(unreachableDevices.length > 0 ? { unreachableDevices } : {}),
    };
  }

  throw new ProgramConversationError(
    "temporarily_unavailable",
    "会话目录正在变更，请稍后重试。",
    { retryable: true, exitCode: 3 },
  );
}
