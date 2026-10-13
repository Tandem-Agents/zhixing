import type { LogCapture, LogPolicy } from "./contracts.js";

/** 单次追加的记录上限：每次追加发布一代完整状态，高峰期多带无详情记录可减少整份重写。 */
export const LOG_APPEND_BATCH_RECORDS = 64;
/** 单次追加中带详情的记录上限：每条详情各占一个文件，沿用原有文件预算。 */
export const LOG_APPEND_BATCH_DETAILS = 8;
/** 单次追加的估算字节上限，远低于日志写入进程的单帧上限。 */
export const LOG_APPEND_BATCH_BYTES = 8 * 1024 * 1024;

/** Previously projected captures are fitted again when the persisted policy shrinks. */
export function fitLogCapture(capture: LogCapture, policy: LogPolicy): LogCapture {
  let record = capture.record;
  let detail =
    capture.detail && Buffer.byteLength(capture.detail) <= policy.attachmentBytes
      ? capture.detail
      : undefined;
  if (Buffer.byteLength(JSON.stringify(record)) + 512 > policy.recordBytes) {
    record = {
      ...record,
      data: {},
      refs: [],
      truncated: true,
      gaps: [{ kind: "not-collected", reason: "policy-size-limit" }],
    };
    detail = undefined;
  }
  if (capture.detail && !detail)
    record = {
      ...record,
      truncated: true,
      gaps: [{ kind: "not-collected", reason: "detail-size-limit" }],
    };
  if (Buffer.byteLength(JSON.stringify(record)) + 512 > policy.recordBytes)
    throw Error("日志信封超过生效限额");
  return { record, ...(detail ? { detail } : {}) };
}
