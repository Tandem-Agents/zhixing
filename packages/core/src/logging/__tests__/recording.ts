import { randomUUID } from "node:crypto";
import { LogRecorder } from "../recorder.js";
import { DEFAULT_LOG_POLICY } from "../policy.js";
import type { BindLogSource, LogCapture, LogStatus } from "../contracts.js";

/** Real admission, capture, redaction and queue; the sink only collects accepted batches. */
export function recordingFixture() {
  const captures: LogCapture[] = [];
  const status: LogStatus = { storeId: randomUUID(), layout: "zxlog/1", policy: { version: 1, effective: DEFAULT_LOG_POLICY }, bytes: 0, files: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false, upper: 0 };
  const recorder = new LogRecorder({
    initialize: async () => status,
    append: async (batch) => { captures.push(...structuredClone(batch)); return status; },
    maintain: async () => status,
    close: async () => {},
  });
  const bind: BindLogSource = (...args) => recorder.bind(...args);
  return { recorder, bind, captures, records: () => captures.map((capture) => capture.record), finish: () => recorder.close(3000) };
}
