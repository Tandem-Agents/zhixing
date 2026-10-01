import { expect, it } from "vitest";
import { LogRecorder } from "./recorder.js";
import { LOG_PHASE_EVENTS, observeLogPhase } from "./phase.js";
import { logFailureEvidence } from "./failure.js";
import { DEFAULT_LOG_POLICY } from "./policy.js";
import type { LogCapture, LogSink, LogStatus } from "./contracts.js";

it("嵌套阶段关联开始、结束和底层失败，保留业务异常", async () => {
  const stored: LogCapture[] = [];
  const status: LogStatus = { layout: "zxlog/1", storeId: "test", policy: { version: 1, effective: DEFAULT_LOG_POLICY }, bytes: 0, files: 0, upper: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false };
  const sink: LogSink = { initialize: async () => status, maintain: async () => status,
    append: async entries => { stored.push(...entries); return { policy: status.policy }; }, close: async () => {} };
  const recorder = new LogRecorder(sink);
  const port = recorder.bind({ id: "test", version: 1, events: LOG_PHASE_EVENTS }, { scope: "storage" });
  const cause = Object.assign(new Error("secret input"), { code: "ENOSPC" });
  await expect(observeLogPhase(port, "outer", () => observeLogPhase(port, "inner", async () => { throw cause; }, { waitFor: "disk" }))).rejects.toBe(cause);
  await recorder.close();
  expect(stored.map(item => item.record.event)).toEqual(["phaseStarted", "phaseStarted", "phaseFinished", "phaseFinished"]);
  const [outer, inner, end] = stored.map(item => item.record);
  expect(inner!.refs).toContainEqual({ kind: "parentPhase", id: outer!.refs.find(ref => ref.kind === "phase")!.id });
  expect(end!.refs.find(ref => ref.kind === "phase")).toEqual(inner!.refs.find(ref => ref.kind === "phase"));
  expect(end!.data).toMatchObject({ waitFor: "disk", failure: { category: "system", code: "ENOSPC" } });
  expect(JSON.stringify(stored)).not.toContain("secret input");
});

it("错误证据只投影有限类别和平台码，恶意 getter 不越过故障边界", () => {
  expect(logFailureEvidence(new Error("NTSTATUS 0xc0000022 at private path"))).toEqual({ category: "platform", code: "NTSTATUS 0xc0000022" });
  const hostile = new Error("hidden");
  Object.defineProperty(hostile, "code", { get: () => { throw Error("getter"); } });
  expect(logFailureEvidence(hostile)).toEqual({ category: "unreadable-error" });
});

it("observation preserves an error whose name getter throws", async () => {
  const hostile = new Error("private");
  Object.defineProperty(hostile, "name", { get() { throw Error("getter"); } });
  let received: unknown;
  try { await observeLogPhase({ record() {} }, "test", async () => { throw hostile; }); }
  catch (error) { received = error; }
  expect(received === hostile).toBe(true);
});
