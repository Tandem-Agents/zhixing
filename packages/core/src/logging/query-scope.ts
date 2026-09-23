import { LogRequestError } from "./errors.js";
import type { LogReadContext } from "./contracts.js";
import {
  logDigest,
  type LogFileSystem,
  type LogSegment,
  type LogStoreSnapshot,
} from "./storage.js";

export interface LogVisibleRange {
  readonly lastId: string;
  readonly digest: string;
}
export type LogScanFiles = Pick<LogFileSystem, "read" | "stat">;

/** Exposes only authorized records to the shared scanner, including its watermarks and costs. */
export function scopeLogQuery(
  state: LogStoreSnapshot,
  files: LogFileSystem,
  context: LogReadContext,
  previous?: { upper: number; range?: LogVisibleRange },
): { state: LogStoreSnapshot; files: LogScanFiles; range?: LogVisibleRange } {
  if (context.manageStorage) {
    if (previous?.range) throw new LogRequestError("日志游标权限范围不一致");
    return { state, files };
  }
  if (context.scopes.length && state.segments.some((segment) => !segment.access))
    throw new LogRequestError("日志访问投影尚未就绪，请在存储维护后重新查询");
  const scopes = new Set(context.scopes);
  const visible = state.segments.flatMap((segment) =>
    (segment.access ?? []).flatMap((access, index) =>
      scopes.has(access.scope) ? [{ segment, access, id: segment.recordIds[index]! }] : [],
    ),
  );
  const end = previous
    ? visible.findIndex((item) => item.id === previous.range?.lastId) + 1
    : visible.length;
  const selected = visible.slice(0, end);
  const range = selected.length
    ? {
        lastId: selected.at(-1)!.id,
        digest: logDigest(JSON.stringify(selected.map((item) => item.id))),
      }
    : undefined;
  if (previous && (!range || end !== previous.upper || range.digest !== previous.range?.digest))
    throw new LogRequestError("日志游标覆盖证据不足，原范围可能已淘汰，请重新查询");
  const slices = new Map(selected.map((item) => [item.id, item]));
  const segments: LogSegment[] = selected.map((item, index) => ({
    ...item.segment,
    name: item.id,
    bytes: item.access.bytes,
    start: index + 1,
    end: index + 1,
    recordIds: [item.id],
    access: [{ ...item.access, offset: 0 }],
    attachments: [],
  }));
  return {
    state: { ...state, upper: selected.length, segments, retired: [], pending: [], gaps: 0 },
    range,
    files: {
      stat: async () => {
        throw new LogRequestError("受限读取不访问物理索引");
      },
      read: async (name, size, offset, limit) => {
        const slice = slices.get(name);
        if (
          !slice ||
          size !== slice.access.bytes ||
          offset < 0 ||
          limit < 0 ||
          offset + limit > size
        )
          throw new LogRequestError("日志读取范围不一致");
        return files.read(
          slice.segment.name,
          slice.segment.bytes,
          slice.access.offset + offset,
          limit,
        );
      },
    },
  };
}
