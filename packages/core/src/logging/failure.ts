import { LogAppendIndeterminateError, LogStorageError, type LogFailureEvidence, type LogStorageFailure } from "./contracts.js";

export const LOG_FAILURE_FIELDS = { category: "text", code: "text", operation: "text", exitCode: "number", signal: "text", durationMs: "number", admissionMs: "number", lockWaitMs: "number", ioClaims: "number", writerCount: "number", writerPids: { items: "number", maxItems: 8 } } as const;
const SYSTEM_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EDQUOT", "EIO", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EEXIST", "EBADF", "EINVAL", "EAGAIN", "EINTR", "EROFS", "ENAMETOOLONG", "EMFILE", "ENFILE", "EBUSY", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ERR_IPC_CHANNEL_CLOSED"]);
const RPC_FAILURES = new Set(['RPC_CONNECTION_CLOSED', 'RPC_DEADLINE_EXCEEDED', 'RPC_CALLER_CANCELLED']);
const STEP_DIMENSIONS = new Set(["memoryReservationBytes", "temporaryBytes", "slots", "readBytes", "writeBytes", "ioOperations"]);
const CLASSES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "AggregateError"]);
const PROJECTION_FAILURES: Readonly<Record<string, string>> = {
  "Committed transcript run conflicts with an existing projection": "transcript-run-conflict",
  "Committed transcript run is not contiguous with the current projection": "transcript-run-gap",
  "Committed transcript run identity is invalid": "transcript-run-identity",
  "Committed input contains projection metadata": "transcript-input-metadata",
};
for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_INVALID_PACKAGE_CONFIG", "ERR_UNKNOWN_FILE_EXTENSION", "ERR_WORKER_OUT_OF_MEMORY", "ERR_WORKER_INIT_FAILED", "ERR_CHILD_PROCESS_PROTOCOL", "EADDRINUSE", "EADDRNOTAVAIL", "ENOTSUP"]) SYSTEM_CODES.add(code);
const PLATFORM_GUARDS: Readonly<Record<string, string>> = {
  "Checkpoint file identity changed": "file-identity-changed",
  "Checkpoint file identity changed during write": "file-identity-changed",
  "Checkpoint file identity changed during read": "file-identity-changed",
  "Checkpoint read identity changed": "file-identity-changed",
  "Checkpoint file length changed": "file-length-changed",
  "Unsafe file identity": "file-identity-unsafe",
  "Retired file identity changed": "retirement-identity-changed",
  "Retired file reclaim unconfirmed": "retirement-unconfirmed",
  "Retired file space is not confirmed": "retirement-unconfirmed",
  "Unsafe control lock": "control-file-unsafe",
  "Checkpoint directory inventory exceeds its bound": "inventory-limit",
  "Checkpoint durable prefix identity changed": "file-identity-changed",
  "Checkpoint durable prefix is invalid": "durable-prefix-invalid",
  "Checkpoint path contains a reparse point": "path-is-link",
  "Checkpoint handle is unknown or closed": "handle-closed",
};

/** Project before an IPC or retry boundary can erase the original failure. */
export function logFailureEvidence(error: unknown): LogFailureEvidence {
  try {
    if (!(error instanceof Error)) return { category: "non-error" };
    // Apply the same finite projection at every level; wrappers never erase native causes.
    for (const cause of boundedErrorCauses(error)) {
      if (cause instanceof RemoteFailureCause) return cause.evidence;
      if (cause instanceof LogStorageError) return cause.evidence ?? { category: cause.code };
      if (cause instanceof LogAppendIndeterminateError) return cause.evidence ?? { category: "append-unconfirmed" };
      const lower = (cause as NodeJS.ErrnoException).code;
      if (lower === "ERR_CHILD_PROCESS_EXITED") {
        const { exitCode, signal } = cause as Error & { exitCode?: unknown; signal?: unknown };
        return { category: "process", code: lower,
          ...(Number.isSafeInteger(exitCode) ? { exitCode: exitCode as number } : {}),
          ...(typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal) ? { signal } : {}) };
      }
      if (typeof lower === "string" && SYSTEM_CODES.has(lower)) return { category: "system", code: lower };
      if (typeof lower === 'string' && RPC_FAILURES.has(lower)) return { category: 'rpc-transport', code: lower,
        ...(['before-send', 'waiting-receipt'].includes(String((cause as Error & { stage?: unknown }).stage)) ? { operation: String((cause as Error & { stage?: unknown }).stage) } : {}) };
      if (cause.name === "ExecutorDispatchRejectedError" && typeof lower === "string" &&
        ["unauthorized", "capability-expired", "epoch-stale", "revision-conflict", "fence-rejected", "busy", "not-found", "invalid", "lease-exhausted", "missing-base", "typed-stale", "capability-gap", "unavailable-offline", "idempotency-conflict"].includes(lower))
        return { category: "executor-dispatch", code: lower };
      if (cause.name === "StorageMaintenanceAdmissionError" || cause.name === "DeviceCapacityAdmissionError") {
        const admission = (cause as Error & { admission?: { kind?: unknown; blockedBy?: unknown } }).admission;
        if (admission && typeof admission.kind === "string" && ["backpressured", "capacity-gap", "cancelled"].includes(admission.kind)) {
          const blocker = admission.blockedBy;
          return { category: "resource-admission", code: admission.kind,
            ...(typeof blocker === "string" && ["probe-unavailable", "memoryReservationBytes", "temporaryBytes", "slots", "readBytes", "writeBytes", "ioOperations"].includes(blocker) ? { operation: blocker } : {}) };
        }
      }
      if (cause.name === "DeviceCapacityStepError") {
        const dimension = /^Device capacity step exceeded ([a-zA-Z]+)$/u.exec(cause.message)?.[1];
        if (dimension && STEP_DIMENSIONS.has(dimension)) return { category: "resource-step", code: "step-exceeded", operation: dimension };
        if (cause.message === "Device capacity step is no longer usable") return { category: "resource-step", code: "step-inactive" };
        if (cause.message === "Device capacity permit cannot cover the next atomic step") return { category: "resource-step", code: "step-unavailable" };
      }
      if (Object.hasOwn(PROJECTION_FAILURES, cause.message)) return { category: "projection", code: PROJECTION_FAILURES[cause.message]! };
      const native = /\b(?:NTSTATUS 0x[0-9a-f]{1,8}|Win32 \d{1,10}|POSIX errno \d{1,10}|checkpoint-child-missing)\b/iu.exec(cause.message)?.[0];
      if (native) return { category: "platform", code: native };
      if (Object.hasOwn(PLATFORM_GUARDS, cause.message)) return { category: "platform-guard", code: PLATFORM_GUARDS[cause.message]! };
    }
    return { category: CLASSES.has(error.name) ? error.name : "Error" };
  } catch { return { category: "unreadable-error" }; }
}

export function logStorageFailure(error: unknown): LogStorageFailure {
  if (error instanceof LogStorageError) return error.code;
  const code = logFailureEvidence(error).code;
  if (code === "EACCES" || code === "EPERM" || code === "Win32 5" || code?.toLowerCase() === "ntstatus 0xc0000022") return "permission-denied";
  if (code === "ENOSPC" || code === "EDQUOT" || code === "Win32 112") return "disk-full";
  if (code === "ENOENT" || code === "ENOTDIR" || code === "checkpoint-child-missing") return "file-missing";
  if (code === "EIO") return "io-failed";
  return "storage-unavailable";
}

/** Package-relative source positions only: never exception text or absolute paths. */
export function failureSourceFrames(error: unknown): readonly string[] {
  const frames: string[] = [];
  try {
    for (const cause of boundedErrorCauses(error)) {
      if (frames.length >= 4) break;
      if (cause instanceof RemoteFailureCause) {
        for (const frame of cause.frames) if (frames.length < 4 && !frames.includes(frame)) frames.push(frame);
        continue;
      }
      for (const line of (cause.stack ?? '').split('\n').slice(1, 16)) {
        const match = /^\s+at (?:[^()\r\n]{0,160} \()?file:\/\/\/[^\r\n]*\/packages\/(cli|terminal-ui|core|executor|owner-kernel|runtime-host|server)\/(?:dist|src)\/([a-zA-Z0-9_./-]{1,150}\.[mc]?[jt]s):([0-9]+):([0-9]+)\)?$/u.exec(line);
        if (!match) continue;
        const frame = `${match[1]}/${match[2]}:${match[3]}:${match[4]}`;
        if (!frames.includes(frame)) frames.push(frame);
        if (frames.length >= 4) break;
      }
    }
  } catch { /* A hostile Error getter cannot replace the original failure. */ }
  return frames;
}

/** Causal wrappers and AggregateError retries retain the first finite failure. */
function* boundedErrorCauses(error: unknown): Generator<Error> {
  const pending: Array<{ error: unknown; depth: number }> = [{ error, depth: 0 }];
  const seen = new Set<Error>();
  while (pending.length && seen.size < 8) {
    const item = pending.shift()!;
    if (!(item.error instanceof Error) || seen.has(item.error) || item.depth >= 4) continue;
    seen.add(item.error);
    yield item.error;
    const children = [item.error.cause];
    if (item.error instanceof AggregateError && Array.isArray(item.error.errors)) children.push(...item.error.errors.slice(0, 4));
    pending.unshift(...children.map(error => ({ error, depth: item.depth + 1 })));
  }
}

const ADMISSION_BLOCKERS = new Set(["probe-unavailable", "memoryReservationBytes", "temporaryBytes", "slots", "readBytes", "writeBytes", "ioOperations"]);
const STORAGE_FAILURES = new Set(["writer-busy", "probe-unavailable", "resource-wait", "resource-gap", "migration-blocked", "owner-unavailable", "storage-unavailable", "reclaim-pending", "permission-denied", "disk-full", "io-failed", "file-missing", "append-unconfirmed"]);
const DISPATCH_FAILURES = new Set(["unauthorized", "capability-expired", "epoch-stale", "revision-conflict", "fence-rejected", "busy", "not-found", "invalid", "lease-exhausted", "missing-base", "typed-stale", "capability-gap", "unavailable-offline", "idempotency-conflict"]);
class RemoteFailureCause extends Error {
  constructor(readonly evidence: LogFailureEvidence, readonly frames: readonly string[]) { super("Remote operation failed"); }
}

/** Bounded diagnostic data only; the remote peer cannot supply arbitrary log text. */
export function restoreFailureDiagnostic(value: unknown): Error | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const { failure, sourceFrames } = value as { failure?: LogFailureEvidence; sourceFrames?: unknown };
    if (!failure || typeof failure !== "object") return undefined;
    const { category, code, operation } = failure;
    let evidence: LogFailureEvidence | undefined;
    if (CLASSES.has(category) || STORAGE_FAILURES.has(category) || category === "non-error" || category === "unreadable-error") evidence = { category };
    else if (category === "system" && typeof code === "string" && SYSTEM_CODES.has(code)) evidence = { category, code };
    else if (category === 'rpc-transport' && typeof code === 'string' && RPC_FAILURES.has(code)) evidence = { category, code,
      ...(['before-send', 'waiting-receipt'].includes(operation ?? '') ? { operation } : {}) };
    else if (category === "executor-dispatch" && typeof code === "string" && DISPATCH_FAILURES.has(code)) evidence = { category, code };
    else if (category === "resource-admission" && ["backpressured", "capacity-gap", "cancelled"].includes(code ?? "")) evidence = { category, code,
      ...(typeof operation === "string" && ADMISSION_BLOCKERS.has(operation) ? { operation } : {}) };
    else if (category === "resource-step" && code === "step-exceeded" && typeof operation === "string" && STEP_DIMENSIONS.has(operation)) evidence = { category, code, operation };
    else if (category === "resource-step" && ["step-inactive", "step-unavailable"].includes(code ?? "")) evidence = { category, code };
    else if (category === "projection" && Object.values(PROJECTION_FAILURES).includes(code ?? "")) evidence = { category, code };
    else if (category === "platform-guard" && Object.values(PLATFORM_GUARDS).includes(code ?? "")) evidence = { category, code };
    else if (category === "platform" && typeof code === "string" && /^(?:NTSTATUS 0x[0-9a-f]{1,8}|Win32 [0-9]{1,10}|POSIX errno [0-9]{1,10}|checkpoint-child-missing)$/iu.test(code)) evidence = { category, code };
    else if (category === "process" && code === "ERR_CHILD_PROCESS_EXITED") evidence = { category, code,
      ...(Number.isSafeInteger(failure.exitCode) ? { exitCode: failure.exitCode } : {}),
      ...(typeof failure.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(failure.signal) ? { signal: failure.signal } : {}) };
    if (!evidence) return undefined;
    const frames = Array.isArray(sourceFrames) ? sourceFrames.slice(0, 4).filter((frame): frame is string =>
      typeof frame === "string" && !frame.includes("..") &&
      /^(?:cli|terminal-ui|core|executor|owner-kernel|runtime-host|server)\/[a-zA-Z0-9_./-]{1,150}\.[mc]?[jt]s:[0-9]{1,9}:[0-9]{1,9}$/u.test(frame)) : [];
    return new RemoteFailureCause(evidence, frames);
  } catch { return undefined; }
}

/** Project at the service boundary while the typed original is still available. */
export function failureDiagnostic(error: unknown): { readonly failure: LogFailureEvidence; readonly sourceFrames: readonly string[] } {
  const restored = restoreFailureDiagnostic({ failure: logFailureEvidence(error), sourceFrames: failureSourceFrames(error) });
  return { failure: restored ? logFailureEvidence(restored) : { category: "Error" }, sourceFrames: restored ? failureSourceFrames(restored) : [] };
}
