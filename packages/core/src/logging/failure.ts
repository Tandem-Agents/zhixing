import { LogAppendIndeterminateError, LogStorageError, type LogFailureEvidence, type LogStorageFailure } from "./contracts.js";

export const LOG_FAILURE_FIELDS = { category: "text", code: "text", operation: "text", exitCode: "number", signal: "text", durationMs: "number", admissionMs: "number", lockWaitMs: "number", ioClaims: "number", writerCount: "number", writerPids: { items: "number", maxItems: 8 } } as const;
const SYSTEM_CODES = new Set(["EACCES", "EPERM", "ENOSPC", "EDQUOT", "EIO", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EEXIST", "EBADF", "EINVAL", "EAGAIN", "EINTR", "EROFS", "ENAMETOOLONG", "EMFILE", "ENFILE", "EBUSY", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ERR_IPC_CHANNEL_CLOSED"]);
const CLASSES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "AggregateError"]);
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
    let cause: unknown = error;
    for (let depth = 0; depth < 4 && cause instanceof Error; depth++, cause = cause.cause) {
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
