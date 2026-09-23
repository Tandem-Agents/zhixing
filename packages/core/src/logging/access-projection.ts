import { validLogToken } from "./capture.js";
import { MAX_LOG_RECORD_BYTES } from "./policy.js";

/** A bounded copy of each record's access and byte range, published with its segment. */
export interface LogRecordAccess {
  readonly scope: string;
  readonly offset: number;
  readonly bytes: number;
}

export function projectLogAccess(
  bytes: Uint8Array,
  ids: readonly string[],
  storeId: string,
): readonly LogRecordAccess[] {
  const content = Buffer.from(bytes),
    result: LogRecordAccess[] = [];
  let offset = 0;
  for (const id of ids) {
    const end = content.indexOf(10, offset);
    if (end < offset || end - offset + 1 > MAX_LOG_RECORD_BYTES)
      throw Error("日志访问投影缺少完整记录");
    const record = JSON.parse(content.subarray(offset, end).toString("utf8"));
    if (record?.id !== id || record.storeId !== storeId || !validLogToken(record.access?.scope))
      throw Error("日志访问投影身份不一致");
    result.push({ scope: record.access.scope, offset, bytes: end - offset + 1 });
    offset = end + 1;
  }
  if (offset !== content.length) throw Error("日志访问投影范围不一致");
  return result;
}

export function validLogAccess(
  access: readonly LogRecordAccess[],
  count: number,
  bytes: number,
): boolean {
  if (!Array.isArray(access) || access.length !== count) return false;
  let offset = 0;
  for (const item of access) {
    if (
      !item ||
      !validLogToken(item.scope) ||
      item.offset !== offset ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > MAX_LOG_RECORD_BYTES
    )
      return false;
    offset += item.bytes;
  }
  return offset === bytes;
}
