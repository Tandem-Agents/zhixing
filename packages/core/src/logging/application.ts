import { LogRequestError } from "./errors.js";
import type {
  LogFilter,
  LogGap,
  LogPage,
  LogPolicy,
  LogReadContext,
  LogRecord,
  LogRef,
  LogStatus,
} from "./contracts.js";
import { validLogToken } from "./capture.js";
import { MAX_LOG_RECORD_BYTES } from "./policy.js";
import { LocalLogStore, logDigest, indexName, type LogStoreSnapshot, type LogRetirement } from "./storage.js";
import { scopeLogQuery, type LogScanFiles, type LogVisibleRange } from "./query-scope.js";

interface Cursor {
  v: 1;
  upper: number;
  position: number;
  offset: number;
  binding: string;
  storeId: string;
  range?: LogVisibleRange;
}
export type LogAddress =
  | { storeId: string; kind: "record"; id: string }
  | { storeId: string; kind: "operation"; ref: LogRef };
export function formatLogAddress(address: LogAddress): string {
  const suffix =
    address.kind === "record"
      ? `record/${encodeURIComponent(address.id)}`
      : `operation/${encodeURIComponent(address.ref.kind)}/${encodeURIComponent(address.ref.id)}`;
  return `zxlog://${address.storeId}/${suffix}`;
}
export function parseLogAddress(value: string): LogAddress {
  if (value.length > 512) throw new LogRequestError("日志地址过长");
  const match = /^zxlog:\/\/([a-f0-9-]{36})\/(record|operation)\/([^/]+)(?:\/([^/]+))?$/u.exec(
    value,
  );
  if (!match) throw new LogRequestError("日志地址无效");
  const id = decodeURIComponent(match[3]!);
  if (!validLogToken(id)) throw new LogRequestError("日志地址身份无效");
  if (match[2] === "record" && !match[4]) return { storeId: match[1]!, kind: "record", id };
  const refId = decodeURIComponent(match[4] ?? "");
  if (match[2] !== "operation" || !validLogToken(refId)) throw new LogRequestError("日志操作地址无效");
  return {
    storeId: match[1]!,
    kind: "operation",
    ref: { kind: id, id: refId },
  };
}

/** All surfaces use this application; permissions come from a trusted host, never query input. */
export class LogApplication {
  readonly #store: LocalLogStore;
  readonly #context: () => LogReadContext;
  readonly #sources: ReadonlySet<string>;
  /** @param supportedSources Content version keys such as `runtime:1` (`source:sourceVersion`). */
  constructor(
    store: LocalLogStore,
    context: () => LogReadContext,
    supportedSources: readonly string[] = ["runtime:1", "logging:1"],
  ) {
    this.#store = store;
    this.#context = context;
    this.#sources = new Set(supportedSources);
  }
  async status(): Promise<LogStatus> {
    const context = this.#manager();
    const status = await this.#store.status();
    this.#authorize(context);
    return status;
  }
  async applyPolicy(policy: LogPolicy, expectedVersion: number): Promise<LogStatus> {
    const context = this.#manager();
    if (context.managePolicy === false) throw new LogRequestError("当前接入面不能修改日志策略，请使用本机配置入口");
    const status = await this.#store.applyPolicy(policy, expectedVersion, () => this.#authorize(context));
    this.#authorize(context);
    return status;
  }

  async search(filter: LogFilter = {}, cursor?: string): Promise<LogPage> {
    return this.#query(filter, cursor);
  }
  async read(
    address: string,
    view: "overview" | "timeline" | "detail" = "overview",
    cursor?: string,
  ): Promise<LogPage & { readonly detail?: unknown }> {
    const parsed = parseLogAddress(address);
    return this.#query(
      parsed.kind === "record" ? { id: parsed.id } : { ref: parsed.ref },
      cursor,
      parsed,
      view,
    );
  }
  async #query(
    filter: LogFilter,
    cursor?: string,
    address?: LogAddress,
    view: "overview" | "timeline" | "detail" = "timeline",
  ): Promise<LogPage & { readonly detail?: unknown }> {
    const context = structuredClone(this.#context()),
      started = Date.now();
    validateFilter(filter);
    const binding = logDigest(
      JSON.stringify({
        filter,
        subject: context.subject,
        revision: context.revision,
        manageStorage: context.manageStorage,
        scopes: [...context.scopes].sort(),
      }),
    );
    const decoded = cursor ? decodeCursor(cursor, binding) : undefined;
    return this.#store.read(async (state, files, current) => {
      const policy = state.policy.effective,
        deadline = started + policy.queryMs;
      const authorized = (): void => {
        this.#authorize(context);
      };
      if (address && state.storeId !== address.storeId) {
        authorized();
        return {
          records: [],
          gaps: [{ kind: "unavailable", reason: "remote-store" }],
          coverage: { upper: 0, scannedBytes: 0, complete: false },
        };
      }
      if (decoded && decoded.storeId !== state.storeId) throw new LogRequestError("日志游标不属于当前存储");
      const scoped = scopeLogQuery(state, files, context, decoded);
      if (
        decoded &&
        (decoded.upper > scoped.state.upper ||
          decoded.offset > 8 * 1024 * 1024 ||
          (scoped.state.segments.find((segment) => segment.start === decoded.position)?.bytes ??
            decoded.offset) < decoded.offset)
      )
        throw new LogRequestError("日志游标范围无效");
      const page = await this.#scan(
        scoped.state,
        scoped.files,
        context,
        filter,
        binding,
        decoded,
        deadline,
        scoped.range,
      );
      let scannedBytes = page.coverage.scannedBytes;
      let detail: unknown, detailGap: LogGap | undefined;
      const record =
        view === "detail" && address?.kind === "record" && page.records.length === 1
          ? page.records[0]
          : undefined;
      const ref = record?.detail;
      if (record && ref) {
        if (Date.now() - record.receivedAt >= policy.attachmentTtlMs)
          detailGap = { kind: "expired", reason: "detail-retention" };
        else if (
          !state.segments.some(
            (segment) =>
              segment.recordIds.includes(record.id) &&
              segment.attachments.some((item) => item.name === ref.name),
          )
        )
          detailGap = { kind: "insufficient", reason: "detail-not-retained" };
        else if (
          Date.now() >= deadline ||
          scannedBytes + ref.bytes > policy.queryScanBytes ||
          ref.bytes > policy.attachmentBytes ||
          ref.bytes > policy.queryResultBytes
        )
          detailGap = { kind: "insufficient", reason: "detail-query-limit" };
        else {
          try {
            const bytes = await files.read(ref.name, ref.bytes, 0, ref.bytes);
            scannedBytes += bytes.byteLength;
            if (logDigest(bytes) !== ref.sha256) throw Error("digest");
            if (Date.now() >= deadline)
              detailGap = { kind: "insufficient", reason: "detail-query-limit" };
            else detail = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
          } catch {
            detailGap = { kind: "insufficient", reason: "detail-missing-or-corrupt" };
          }
        }
      }
      // Every asynchronous exit, including detail failure, shares this final authorization,
      // policy and retention check. A failed refresh returns no stale evidence.
      const latest = await current();
      authorized();
      if (latest.storeId !== state.storeId || latest.policy.version !== state.policy.version)
        throw new LogRequestError("日志策略或存储已变化，请重新查询");
      const retained = new Set(latest.segments.flatMap((segment) => segment.recordIds));
      let records = page.records.filter((item) => retained.has(item.id));
      const visibleRetirement =
        records.length !== page.records.length ||
        (!context.manageStorage &&
          scoped.state.segments.some((segment) =>
            segment.recordIds.some((id) => !retained.has(id)),
          ));
      const globalRetirement =
        context.manageStorage &&
        state.segments.some(
          (segment) =>
            segment.start <= page.coverage.upper &&
            !latest.segments.some((item) => item.name === segment.name),
        );
      const gaps = [...page.gaps];
      if (visibleRetirement || globalRetirement)
        gaps.push({ kind: "expired", reason: "retired-during-query" });
      if (
        record &&
        ref &&
        !latest.segments.some(
          (segment) =>
            segment.recordIds.includes(record.id) &&
            segment.attachments.some((item) => item.name === ref.name),
        )
      ) {
        detail = undefined;
        detailGap = { kind: "expired", reason: "detail-retired-during-query" };
      }
      if (detailGap) gaps.push(detailGap);
      if (view === "overview") records = records.map((item) => ({ ...item, data: {} }));
      const result: Omit<LogPage, "gaps"> & { gaps: readonly LogGap[]; detail?: unknown } = {
        ...page,
        records,
        gaps: gaps.slice(-16),
        coverage: { ...page.coverage, scannedBytes },
        ...(detail === undefined ? {} : { detail }),
      };
      if (
        Buffer.byteLength(JSON.stringify(result)) > policy.queryResultBytes &&
        detail !== undefined
      ) {
        delete result.detail;
        result.gaps = [
          ...result.gaps.slice(-15),
          { kind: "insufficient", reason: "detail-response-limit" },
        ];
      }
      if (Buffer.byteLength(JSON.stringify(result)) > policy.queryResultBytes)
        throw new LogRequestError("日志查询结果超过限额，请缩小筛选范围");
      return result;
    });
  }

  #authorize(context: LogReadContext): void {
    if (JSON.stringify(this.#context()) !== JSON.stringify(context))
      throw new LogRequestError("日志读取权限发生变化，请重新查询");
  }
  #manager(): LogReadContext {
    const context = structuredClone(this.#context());
    if (!context.manageStorage) throw new LogRequestError("需要本机日志存储管理授权");
    return context;
  }
  async #scan(
    state: LogStoreSnapshot,
    files: LogScanFiles,
    context: LogReadContext,
    filter: LogFilter,
    binding: string,
    cursor: Cursor | undefined,
    deadline: number,
    range?: LogVisibleRange,
  ): Promise<LogPage> {
    const policy = state.policy.effective,
      upper = cursor?.upper ?? state.upper;
    const resultLimit =
      policy.queryResultBytes - Math.min(4096, Math.floor(policy.queryResultBytes / 2));
    let position = cursor?.position ?? 1,
      offset = cursor?.offset ?? 0,
      scannedBytes = 0,
      resultBytes = 0;
    const records: LogRecord[] = [],
      gaps: LogGap[] = [];
    const retirements = [...state.retired].sort((a, b) => a.start - b.start);
    const gap = (reason: string, kind: LogGap["kind"] = "insufficient"): void => {
      if (
        (context.manageStorage || range !== undefined) &&
        gaps.length < 16 &&
        !gaps.some((item) => item.reason === reason && item.kind === kind)
      )
        gaps.push({ kind, reason });
    };
    for (const segment of state.segments
      .filter((item) => item.end >= position && item.start <= upper)
      .sort((a, b) => a.start - b.start)) {
      if (segment.start > position) {
        gap(
          "records-not-retained",
          retirementCovers(retirements, position, segment.start - 1)
            ? "expired"
            : "insufficient",
        );
        offset = 0;
      }
      position = segment.start;
      if (context.manageStorage && filter.id && !segment.recordIds.includes(filter.id)) {
        position = segment.end + 1;
        offset = 0;
        continue;
      }
      if (
        context.manageStorage &&
        filter.id &&
        offset === 0 &&
        policy.queryScanBytes - scannedBytes >= MAX_LOG_RECORD_BYTES * 3 + 4096 &&
        Date.now() < deadline
      ) {
        // Disposable offsets are hints. A corrupt hint cannot hide a retained record:
        // prove the actual line's identity, otherwise resume the ordinary scan at zero.
        try {
          const name = indexName(segment.name),
            info = await files.stat(name);
          if (info.bytes > 4096) throw Error("index-too-large");
          const bytes = await files.read(name, info.bytes, 0, info.bytes);
          scannedBytes += bytes.byteLength;
          const index = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
            schema: number;
            offsets: number[];
          };
          const hint = index.offsets[segment.recordIds.indexOf(filter.id)];
          if (
            index.schema !== 1 ||
            !Number.isSafeInteger(hint) ||
            hint! < 0 ||
            hint! >= segment.bytes
          )
            throw Error("invalid-index");
          const begin = Math.max(0, hint! - 1),
            limit = Math.min(MAX_LOG_RECORD_BYTES + 1, segment.bytes - begin);
          const probe = Buffer.from(await files.read(segment.name, segment.bytes, begin, limit));
          scannedBytes += probe.length;
          if (hint && probe[0] !== 10) throw Error("invalid-record-boundary");
          const line = probe.subarray(hint ? 1 : 0),
            end = line.indexOf(10);
          if (
            end < 0 ||
            parseRecord(line.subarray(0, end).toString("utf8"), MAX_LOG_RECORD_BYTES, state.storeId)
              .id !== filter.id
          )
            throw Error("index-mismatch");
          offset = hint!;
        } catch {
          /* Missing or corrupt indexes have no evidentiary authority. */
        }
      }
      while (
        offset < segment.bytes &&
        Date.now() < deadline &&
        scannedBytes < policy.queryScanBytes &&
        records.length < policy.queryRecords
      ) {
        const limit = Math.min(
          segment.bytes - offset,
          MAX_LOG_RECORD_BYTES * 2,
          policy.queryScanBytes - scannedBytes,
        );
        if (limit < MAX_LOG_RECORD_BYTES && limit < segment.bytes - offset) break;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(await files.read(segment.name, segment.bytes, offset, limit));
        } catch {
          gap("segment-missing-or-corrupt");
          offset = segment.bytes;
          break;
        }
        scannedBytes += bytes.length;
        const lastNewline = bytes.lastIndexOf(10);
        if (lastNewline < 0) {
          gap("record-incomplete-or-oversized");
          offset += bytes.length;
          if (!bytes.length) offset = segment.bytes;
          continue;
        }
        let consumed = 0;
        for (const line of bytes.subarray(0, lastNewline).toString("utf8").split("\n")) {
          const length = Buffer.byteLength(line) + 1;
          let record: LogRecord | undefined;
          try {
            record = parseRecord(line, MAX_LOG_RECORD_BYTES, state.storeId);
            const ordinal = segment.recordIds.indexOf(record.id);
            if (
              ordinal < 0 ||
              (segment.access && segment.access[ordinal]?.scope !== record.access.scope)
            )
              throw Error("record-identity-mismatch");
          } catch {
            record = undefined;
            gap("record-corrupt");
          }
          // Hidden references must not become an existence oracle through a filter or operation address.
          if (record && !context.manageStorage) record = { ...record, refs: [] };
          if (record && allowed(record, context) && matches(record, filter)) {
            const known =
              record.schema === 1 && this.#sources.has(`${record.source}:${record.sourceVersion}`);
            let projected: LogRecord = {
              ...record,
              ...(known
                ? {}
                : {
                    data: {},
                    detail: undefined,
                    gaps: [
                      {
                        kind: "insufficient" as const,
                        reason: "unknown-source-content",
                      },
                    ],
                  }),
            };
            if (Buffer.byteLength(JSON.stringify(projected)) > resultLimit)
              projected = {
                ...projected,
                data: {},
                refs: [],
                truncated: true,
                gaps: [{ kind: "insufficient", reason: "response-size-limit" }],
              };
            const projectedBytes = Buffer.byteLength(JSON.stringify(projected));
            if (resultBytes + projectedBytes > resultLimit || records.length >= policy.queryRecords)
              break;
            records.push(projected);
            resultBytes += projectedBytes;
          }
          consumed += length;
          if (records.length >= policy.queryRecords) break;
        }
        offset += consumed;
        if (!consumed || records.length >= policy.queryRecords || resultBytes >= resultLimit) break;
      }
      if (offset < segment.bytes) break;
      position = segment.end + 1;
      offset = 0;
      if (
        Date.now() >= deadline ||
        scannedBytes >= policy.queryScanBytes ||
        records.length >= policy.queryRecords
      )
        break;
    }
    const remaining = state.segments.some(
      (segment) => segment.end >= position && segment.start <= upper,
    );
    if (!remaining && position <= upper) {
      gap(
        "records-not-retained",
          retirementCovers(retirements, position, upper)
          ? "expired"
          : "insufficient",
      );
      position = upper + 1;
    }
    const complete = position > upper;
    if (context.manageStorage && !records.length && complete && filter.id) gap("record-not-found");
    const next: Cursor = {
      v: 1,
      upper,
      position,
      offset,
      binding,
      storeId: state.storeId,
      ...(range ? { range } : {}),
    };
    return {
      records,
      gaps,
      ...(!complete ? { cursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
      coverage: { upper, scannedBytes, complete },
    };
  }
}

export * from "./product-api.js";
export * from "./tools.js";
export { LogRequestError, publicLogErrorMessage } from "./errors.js";

/** Sorted, bounded evidence may span several retired segments, but must not bridge a hole. */
function retirementCovers(ranges: readonly LogRetirement[], start: number, end: number): boolean {
  let next = start;
  for (const range of ranges) {
    if (range.end < next) continue;
    if (range.start > next) return false;
    if (range.end >= end) return true;
    next = range.end + 1;
  }
  return false;
}

function allowed(record: LogRecord, context: LogReadContext): boolean {
  return context.manageStorage || context.scopes.includes(record.access.scope);
}
function matches(record: LogRecord, filter: LogFilter): boolean {
  return (
    (filter.from === undefined || record.occurredAt >= filter.from) &&
    (filter.until === undefined || record.occurredAt <= filter.until) &&
    (!filter.source || record.source === filter.source) &&
    (!filter.level || record.level === filter.level) &&
    (!filter.id || record.id === filter.id) &&
    (!filter.ref ||
      record.refs.some(
        (ref) =>
          ref.kind === filter.ref!.kind &&
          ref.id === filter.ref!.id &&
          ref.storeId === filter.ref!.storeId,
      ))
  );
}
function validateFilter(filter: LogFilter): void {
  if (
    (filter.from !== undefined && !Number.isSafeInteger(filter.from)) ||
    (filter.until !== undefined && !Number.isSafeInteger(filter.until)) ||
    (filter.id !== undefined && !validLogToken(filter.id)) ||
    (filter.source !== undefined && !validLogToken(filter.source)) ||
    (filter.ref &&
      (!validLogToken(filter.ref.kind) ||
        !validLogToken(filter.ref.id) ||
        (filter.ref.storeId !== undefined && !validLogToken(filter.ref.storeId)))) ||
    (filter.level !== undefined && !["debug", "info", "warn", "error"].includes(filter.level))
  )
    throw new LogRequestError("日志筛选条件无效");
}
function decodeCursor(cursor: string, binding: string): Cursor {
  if (cursor.length > 2048) throw new LogRequestError("日志游标过长");
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
  if (
    value.v !== 1 ||
    value.binding !== binding ||
    !Number.isSafeInteger(value.upper) ||
    value.upper < 0 ||
    !Number.isSafeInteger(value.position) ||
    value.position < 1 ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.storeId !== "string" ||
    (value.range !== undefined &&
      (!value.range ||
        !/^[a-f0-9-]{36}$/u.test(value.range.lastId) ||
        !/^[a-f0-9]{64}$/u.test(value.range.digest)))
  )
    throw new LogRequestError("日志游标已失效或权限发生变化");
  return value;
}
function parseRecord(line: string, limit: number, storeId: string): LogRecord {
  if (Buffer.byteLength(line) > limit) throw Error("oversized");
  const record = JSON.parse(line) as LogRecord;
  if (
    !record ||
    !Number.isInteger(record.schema) ||
    record.schema < 1 ||
    record.storeId !== storeId ||
    !validLogToken(record.id) ||
    !validLogToken(record.source) ||
    !validLogToken(record.event) ||
    !validLogToken(record.process) ||
    !validLogToken(record.access?.scope) ||
    !Array.isArray(record.refs) ||
    record.refs.length > 16 ||
    !Number.isSafeInteger(record.receivedAt) ||
    !Number.isSafeInteger(record.occurredAt) ||
    !Number.isSafeInteger(record.seq) ||
    !Number.isSafeInteger(record.sourceVersion) ||
    typeof record.message !== "string" ||
    Buffer.byteLength(record.message) > 512 ||
    !["critical", "detail"].includes(record.tier) ||
    !["debug", "info", "warn", "error"].includes(record.level)
  )
    throw Error("invalid-envelope");
  for (const ref of record.refs)
    if (
      !validLogToken(ref.kind) ||
      !validLogToken(ref.id) ||
      (ref.storeId !== undefined && !validLogToken(ref.storeId))
    )
      throw Error("invalid-reference");
  if (
    record.detail &&
    (!/^detail-[a-f0-9-]{36}\.json$/u.test(record.detail.name) ||
      !/^[a-f0-9]{64}$/u.test(record.detail.sha256) ||
      !Number.isSafeInteger(record.detail.bytes) ||
      record.detail.bytes < 1 ||
      record.detail.bytes > 1024 * 1024)
  )
    throw Error("invalid-detail-reference");
  if (
    record.result &&
    !["success", "failure", "unknown", "refused", "cancelled"].includes(record.result)
  )
    throw Error("invalid-result");
  if (
    record.repeat &&
    (!Number.isSafeInteger(record.repeat.count) ||
      record.repeat.count < 1 ||
      !Number.isSafeInteger(record.repeat.until))
  )
    throw Error("invalid-repeat");
  if (
    record.gaps &&
    (!Array.isArray(record.gaps) ||
      record.gaps.length > 4 ||
      record.gaps.some(
        (gap) =>
          !["expired", "not-collected", "unavailable", "insufficient"].includes(gap.kind) ||
          !validLogToken(gap.reason),
      ))
  )
    throw Error("invalid-gaps");
  // Unknown envelope additions cannot silently expand the public projection.
  return {
    schema: record.schema,
    id: record.id,
    storeId: record.storeId,
    process: record.process,
    seq: record.seq,
    occurredAt: record.occurredAt,
    receivedAt: record.receivedAt,
    source: record.source,
    sourceVersion: record.sourceVersion,
    event: record.event,
    level: record.level,
    tier: record.tier,
    refs: record.refs.map(({ kind, id, storeId: origin }) => ({
      kind,
      id,
      ...(origin ? { storeId: origin } : {}),
    })),
    access: { scope: record.access.scope },
    message: record.message,
    data: record.data ?? {},
    ...(record.result ? { result: record.result } : {}),
    ...(record.detail
      ? {
          detail: {
            name: record.detail.name,
            bytes: record.detail.bytes,
            sha256: record.detail.sha256,
          },
        }
      : {}),
    ...(record.redacted ? { redacted: true } : {}),
    ...(record.truncated ? { truncated: true } : {}),
    ...(record.gaps ? { gaps: record.gaps.map(({ kind, reason }) => ({ kind, reason })) } : {}),
    ...(record.repeat
      ? { repeat: { count: record.repeat.count, until: record.repeat.until } }
      : {}),
  };
}
