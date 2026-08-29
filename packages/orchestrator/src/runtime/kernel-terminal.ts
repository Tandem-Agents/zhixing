import {
  AgentError,
  type AgentErrorType,
  type AgentResult,
  type AbortReason,
  type ContentBlock,
  type Message,
  type PostTurnControlOutcome,
  type RunRecordInput,
  type TokenUsage,
  type WindowCompact,
} from "@zhixing/core";

/** The finite terminal state of one Intelligence Kernel run. */
export type KernelTerminal =
  | {
      readonly reason: "completed";
      readonly message: Readonly<Message>;
      readonly usage: Readonly<TokenUsage>;
    }
  | {
      readonly reason: "max_turns";
      readonly maxTurns: number;
      readonly usage: Readonly<TokenUsage>;
    }
  | {
      readonly reason: "aborted";
      readonly usage: Readonly<TokenUsage>;
      readonly abortReason?: Readonly<AbortReason>;
      readonly exitDelayMs?: number;
    }
  | {
      readonly reason: "error";
      readonly error: Readonly<{
        readonly name: "AgentError";
        readonly message: string;
        readonly type: AgentErrorType;
        readonly recoverable: boolean;
      }>;
      readonly usage: Readonly<TokenUsage>;
    };

/**
 * Non-terminal products produced while a Kernel run is evaluated.
 *
 * These values are candidates, evidence, window/control proposals and
 * diagnostics. They are deliberately separate from {@link KernelTerminal} and
 * become product facts only after a product-side application boundary accepts
 * them.
 */
export interface KernelRunArtifacts {
  readonly runRecord: Readonly<RunRecordInput>;
  readonly windowCompact?: Readonly<WindowCompact>;
  readonly newMessages: readonly Message[];
  readonly durationMs: number;
  readonly pendingPostTurnControl?: Readonly<PostTurnControlOutcome>;
}

/** The complete, immutable result returned by the Kernel run boundary. */
export interface KernelRunCompletion {
  readonly terminal: KernelTerminal;
  readonly artifacts: KernelRunArtifacts;
}

const AGENT_ERROR_TYPES: readonly AgentErrorType[] = [
  "rate_limit",
  "timeout",
  "network",
  "context_overflow",
  "auth",
  "invalid_request",
  "provider_error",
  "tool_error",
  "aborted",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["inputTokens", "outputTokens"],
      ["totalInputTokens", "cacheReadTokens", "cacheWriteTokens"],
    ) ||
    !isFiniteNumber(value.inputTokens) ||
    !isFiniteNumber(value.outputTokens)
  ) {
    return false;
  }
  return [
    value.totalInputTokens,
    value.cacheReadTokens,
    value.cacheWriteTokens,
  ].every((entry) => entry === undefined || isFiniteNumber(entry));
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return hasExactKeys(value, ["type", "text"]) && typeof value.text === "string";
    case "image":
      if (!hasExactKeys(value, ["type", "source"]) || !isRecord(value.source)) {
        return false;
      }
      if (value.source.type === "base64") {
        return (
          hasExactKeys(value.source, ["type", "mediaType", "data"]) &&
          typeof value.source.mediaType === "string" &&
          typeof value.source.data === "string"
        );
      }
      return (
        value.source.type === "url" &&
        hasExactKeys(value.source, ["type", "url"]) &&
        typeof value.source.url === "string"
      );
    case "tool_use":
      return (
        hasExactKeys(value, ["type", "id", "name", "input"]) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        isRecord(value.input)
      );
    case "tool_result":
      return (
        hasExactKeys(value, ["type", "toolUseId", "content"], ["isError"]) &&
        typeof value.toolUseId === "string" &&
        typeof value.content === "string" &&
        (value.isError === undefined || typeof value.isError === "boolean")
      );
    case "thinking":
      return (
        hasExactKeys(value, ["type", "thinking"], ["signature"]) &&
        typeof value.thinking === "string" &&
        (value.signature === undefined || typeof value.signature === "string")
      );
    default:
      return false;
  }
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["role", "content"]) &&
    (value.role === "user" || value.role === "assistant") &&
    Array.isArray(value.content) &&
    value.content.every(isContentBlock)
  );
}

function isAbortReason(value: unknown): value is AbortReason {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "user-cancel":
      return (
        hasExactKeys(value, ["kind", "source", "pressedAt"]) &&
        ["esc", "ctrl-c", "sigint", "rpc"].includes(String(value.source)) &&
        isFiniteNumber(value.pressedAt)
      );
    case "idle-timeout":
      return (
        hasExactKeys(value, [
          "kind",
          "timeoutMs",
          "chunksReceived",
          "elapsedSinceLastChunkMs",
        ]) &&
        isFiniteNumber(value.timeoutMs) &&
        isFiniteNumber(value.chunksReceived) &&
        isFiniteNumber(value.elapsedSinceLastChunkMs)
      );
    case "parent-abort":
      return (
        hasExactKeys(value, ["kind", "parentReason"]) &&
        (value.parentReason === null || isAbortReason(value.parentReason))
      );
    case "external":
      return (
        hasExactKeys(value, ["kind"], ["origin"]) &&
        (value.origin === undefined || typeof value.origin === "string")
      );
    default:
      return false;
  }
}

function assertAgentResult(value: unknown): asserts value is AgentResult {
  if (!isRecord(value) || typeof value.reason !== "string") {
    throw new TypeError("Kernel terminal source is not an AgentResult object");
  }
  let valid = false;
  switch (value.reason) {
    case "completed":
      valid =
        hasExactKeys(value, ["reason", "message", "usage"]) &&
        isMessage(value.message) &&
        isTokenUsage(value.usage);
      break;
    case "max_turns":
      valid =
        hasExactKeys(value, ["reason", "maxTurns", "usage"]) &&
        Number.isSafeInteger(value.maxTurns) &&
        Number(value.maxTurns) >= 0 &&
        isTokenUsage(value.usage);
      break;
    case "aborted":
      valid =
        hasExactKeys(value, ["reason", "usage"], ["abortReason", "exitDelayMs"]) &&
        isTokenUsage(value.usage) &&
        (value.abortReason === undefined || isAbortReason(value.abortReason)) &&
        (value.exitDelayMs === undefined || isFiniteNumber(value.exitDelayMs));
      break;
    case "error": {
      const error = value.error;
      valid =
        hasExactKeys(value, ["reason", "error", "usage"]) &&
        error instanceof AgentError &&
        error.name === "AgentError" &&
        typeof error.message === "string" &&
        AGENT_ERROR_TYPES.some((type) => type === error.type) &&
        typeof error.recoverable === "boolean" &&
        isTokenUsage(value.usage);
      break;
    }
    default:
      throw new TypeError(`Unknown AgentResult terminal: ${value.reason}`);
  }
  if (!valid) {
    throw new TypeError(`Incomplete AgentResult terminal: ${value.reason}`);
  }
}

function isKernelError(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["name", "message", "type", "recoverable"]) &&
    value.name === "AgentError" &&
    typeof value.message === "string" &&
    typeof value.type === "string" &&
    AGENT_ERROR_TYPES.some((type) => type === value.type) &&
    typeof value.recoverable === "boolean"
  );
}

function assertKernelTerminalValue(
  value: unknown,
): asserts value is KernelTerminal {
  if (!isRecord(value) || typeof value.reason !== "string") {
    throw new TypeError("Kernel completion terminal is not an object");
  }
  let valid = false;
  switch (value.reason) {
    case "completed":
      valid =
        hasExactKeys(value, ["reason", "message", "usage"]) &&
        isMessage(value.message) &&
        isTokenUsage(value.usage);
      break;
    case "max_turns":
      valid =
        hasExactKeys(value, ["reason", "maxTurns", "usage"]) &&
        Number.isSafeInteger(value.maxTurns) &&
        Number(value.maxTurns) >= 0 &&
        isTokenUsage(value.usage);
      break;
    case "aborted":
      valid =
        hasExactKeys(value, ["reason", "usage"], ["abortReason", "exitDelayMs"]) &&
        isTokenUsage(value.usage) &&
        (value.abortReason === undefined || isAbortReason(value.abortReason)) &&
        (value.exitDelayMs === undefined || isFiniteNumber(value.exitDelayMs));
      break;
    case "error":
      valid =
        hasExactKeys(value, ["reason", "error", "usage"]) &&
        isKernelError(value.error) &&
        isTokenUsage(value.usage);
      break;
    default:
      throw new TypeError(`Unknown Kernel terminal: ${value.reason}`);
  }
  if (!valid) throw new TypeError(`Incomplete Kernel terminal: ${value.reason}`);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreeze(clone);
  return clone;
}

function unreachableAgentResult(value: never): never {
  throw new TypeError(`Unhandled AgentResult terminal: ${String(value)}`);
}

/** Explicit Agent Loop completion → Kernel terminal projection. */
export function projectAgentResultToKernelTerminal(
  value: unknown,
): KernelTerminal {
  assertAgentResult(value);
  switch (value.reason) {
    case "completed":
      return Object.freeze({
        reason: "completed",
        message: cloneAndFreeze(value.message),
        usage: cloneAndFreeze(value.usage),
      });
    case "max_turns":
      return Object.freeze({
        reason: "max_turns",
        maxTurns: value.maxTurns,
        usage: cloneAndFreeze(value.usage),
      });
    case "aborted":
      return Object.freeze({
        reason: "aborted",
        usage: cloneAndFreeze(value.usage),
        ...(value.abortReason
          ? { abortReason: cloneAndFreeze(value.abortReason) }
          : {}),
        ...(value.exitDelayMs === undefined
          ? {}
          : { exitDelayMs: value.exitDelayMs }),
      });
    case "error":
      return Object.freeze({
        reason: "error",
        error: Object.freeze({
          name: "AgentError",
          message: value.error.message,
          type: value.error.type,
          recoverable: value.error.recoverable,
        }),
        usage: cloneAndFreeze(value.usage),
      });
    default:
      return unreachableAgentResult(value);
  }
}

/** Runtime guard used by every product-side terminal projection. */
export function assertKernelTerminal(
  value: unknown,
): asserts value is KernelTerminal {
  assertKernelTerminalValue(value);
}

/**
 * Transfers Kernel-owned products into one shallow, immutable completion shell.
 *
 * The Agent Loop creates the artifact graph and stops writing it before this
 * call. The shell snapshots the five references without traversing or cloning
 * potentially large messages, tool results, thinking blocks or images. Product
 * adapters become the next owner and copy only when their existing contract
 * specifically requires a distinct mutable container.
 */
export function createKernelRunCompletion(
  terminal: KernelTerminal,
  artifacts: KernelRunArtifacts,
): KernelRunCompletion {
  assertKernelTerminalValue(terminal);
  return Object.freeze({
    terminal,
    artifacts: Object.freeze({ ...artifacts }),
  });
}
