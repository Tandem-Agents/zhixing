import type { LogCapture, LogPolicy } from "./contracts.js";

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
