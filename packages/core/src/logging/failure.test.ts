import { expect, it } from "vitest";
import { failureDiagnostic, failureSourceFrames, logFailureEvidence, logStorageFailure, restoreFailureDiagnostic } from "./failure.js";
import { LogAppendIndeterminateError, LogStorageError } from "./contracts.js";

it.each([
  [Object.assign(Error("private rejection"), { name: "ExecutorDispatchRejectedError", code: "lease-exhausted" }), { category: "executor-dispatch", code: "lease-exhausted" }, "storage-unavailable"],
  [Error("Committed transcript run conflicts with an existing projection"), { category: "projection", code: "transcript-run-conflict" }, "storage-unavailable"],
  [Object.assign(Error("private pressure"), { name: "StorageMaintenanceAdmissionError", admission: { kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs: 25 } }), { category: "resource-admission", code: "backpressured", operation: "probe-unavailable" }, "storage-unavailable"],
  [Object.assign(Error("private pressure"), { name: "DeviceCapacityAdmissionError", admission: { kind: "backpressured", blockedBy: "private" } }), { category: "resource-admission", code: "backpressured" }, "storage-unavailable"],
  [Error("Committed transcript run is not contiguous with the current projection"), { category: "projection", code: "transcript-run-gap" }, "storage-unavailable"],
  [Object.assign(Error("private module"), { code: "ERR_MODULE_NOT_FOUND" }), { category: "system", code: "ERR_MODULE_NOT_FOUND" }, "storage-unavailable"],
  [Object.assign(Error("private child"), { code: "ERR_CHILD_PROCESS_EXITED", exitCode: 7, signal: null }), { category: "process", code: "ERR_CHILD_PROCESS_EXITED", exitCode: 7 }, "storage-unavailable"],
  [Object.assign(Error("private path"), { code: "ENOSPC" }), { category: "system", code: "ENOSPC" }, "disk-full"],
  [Error("private path (Win32 5)"), { category: "platform", code: "Win32 5" }, "permission-denied"],
  [Error("Checkpoint durable prefix is invalid"), { category: "platform-guard", code: "durable-prefix-invalid" }, "storage-unavailable"],
  [new LogAppendIndeterminateError({ category: "system", code: "EIO" }), { category: "system", code: "EIO" }, "io-failed"],
  [new LogStorageError("file-missing", "private path", { category: "system", code: "ENOENT" }), { category: "system", code: "ENOENT" }, "file-missing"],
] as const)("preserves a finite lower cause through wrappers %#", (cause, evidence, code) => {
  const error = new Error("private outer", { cause: new Error("private middle", { cause }) });
  expect(logFailureEvidence(error)).toEqual(evidence);
  expect(logStorageFailure(error)).toBe(code);
  expect(JSON.stringify(logFailureEvidence(error))).not.toContain("private");
});

it("bounds cyclic, hostile and arbitrary error payloads", () => {
  const error = new Error("secret"); error.cause = error;
  expect(logFailureEvidence(error)).toEqual({ category: "Error" });
  expect(logFailureEvidence(Object.assign(Error("secret"), { code: "secret" }))).toEqual({ category: "Error" });
  Object.defineProperty(error, "code", { get() { throw Error("secret getter"); } });
  expect(logFailureEvidence(error)).toEqual({ category: "unreadable-error" });
  expect(logFailureEvidence(undefined)).toEqual({ category: "non-error" });
});

it("retains the first finite retry cause through AggregateError without leaking payload", () => {
  const first = Object.assign(new Error("private first"), { name: "StorageMaintenanceAdmissionError", admission: { kind: "backpressured", blockedBy: "probe-unavailable" } });
  const aggregate = new AggregateError([first, new Error("private second")], "private wrapper");
  aggregate.errors.push(aggregate);
  expect(logFailureEvidence(aggregate)).toEqual({category:"resource-admission",code:"backpressured",operation:"probe-unavailable"});
});

it("preserves RPC source positions across a remote diagnostic without logging paths or payloads", () => {
  const error = Object.assign(Error('private request'), { code: 'ETIMEDOUT' });
  error.stack = 'Error: private request\n    at Timeout.cancel (file:///private/user/repo/packages/server/dist/client/rpc-client.js:232:22)';
  const diagnostic = failureDiagnostic(error);
  expect(diagnostic).toEqual({ failure: {category: 'system', code: 'ETIMEDOUT'}, sourceFrames: ['server/client/rpc-client.js:232:22'] });
  expect(failureSourceFrames(restoreFailureDiagnostic(diagnostic))).toEqual(diagnostic.sourceFrames);
  expect(JSON.stringify(diagnostic)).not.toContain('private');
});

it.each(['RPC_DEADLINE_EXCEEDED', 'RPC_CALLER_CANCELLED', 'RPC_CONNECTION_CLOSED'])('retains finite %s and stage without arbitrary RPC content', code => {
  const error = Object.assign(Error('private payload'), { code, stage: 'waiting-receipt' });
  const diagnostic = failureDiagnostic(error);
  expect(diagnostic.failure).toEqual({ category: 'rpc-transport', code, operation: 'waiting-receipt' });
  expect(logFailureEvidence(restoreFailureDiagnostic(diagnostic))).toEqual(diagnostic.failure);
  expect(JSON.stringify(diagnostic)).not.toContain('private');
  expect(logFailureEvidence(Object.assign(error, { stage: 'private' }))).toEqual({ category: 'rpc-transport', code });
});


it.each(["memoryReservationBytes", "temporaryBytes", "slots", "readBytes", "writeBytes", "ioOperations"])("retains the finite exceeded %s dimension through the remote boundary", dimension => {
  const error = Object.assign(new Error("Device capacity step exceeded " + dimension), { name: "DeviceCapacityStepError" });
  const diagnostic = failureDiagnostic(new Error("private wrapper", { cause: error }));
  expect(diagnostic.failure).toEqual({ category: "resource-step", code: "step-exceeded", operation: dimension });
  expect(logFailureEvidence(restoreFailureDiagnostic(diagnostic))).toEqual(diagnostic.failure);
  expect(failureDiagnostic(Object.assign(new Error("Device capacity step exceeded private"), { name: "DeviceCapacityStepError" })).failure).toEqual({ category: "Error" });
  expect(restoreFailureDiagnostic({ failure: { category: "resource-step", code: "step-exceeded", operation: "private" } })).toBeUndefined();
});
