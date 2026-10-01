import { expect, it } from "vitest";
import { logFailureEvidence, logStorageFailure } from "./failure.js";
import { LogAppendIndeterminateError, LogStorageError } from "./contracts.js";

it.each([
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
