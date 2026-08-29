import type {
  AgentYield,
  ContentBlock,
  Message,
  TokenUsage,
  ToolResult,
} from "@zhixing/core";

/**
 * The finite event stream emitted by one Intelligence Kernel run.
 *
 * This contract is intentionally independent from the core Agent Loop's
 * `AgentYield`. The Kernel owns the public boundary and projects every loop
 * event into a fresh, frozen value before notifying a product binding.
 */
export type KernelRunEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_block_start" }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "thinking_block_end" }
  | {
      readonly type: "assistant_message";
      readonly message: Readonly<Message>;
    }
  | {
      readonly type: "tool_start";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_end";
      readonly id: string;
      readonly name: string;
      readonly result: Readonly<ToolResult>;
      readonly duration: number;
    }
  | {
      readonly type: "turn_complete";
      readonly turnCount: number;
      readonly usage: Readonly<TokenUsage>;
    };

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

function isToolResult(value: unknown): value is ToolResult {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["content"],
      ["isError", "presentation", "committedToUser"],
    ) &&
    typeof value.content === "string" &&
    (value.isError === undefined || typeof value.isError === "boolean") &&
    (value.presentation === undefined || isRecord(value.presentation)) &&
    (value.committedToUser === undefined ||
      typeof value.committedToUser === "boolean")
  );
}

function assertAgentYield(value: unknown): asserts value is AgentYield {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new TypeError("Kernel run event source is not an AgentYield object");
  }
  let valid = false;
  switch (value.type) {
    case "text_delta":
      valid = hasExactKeys(value, ["type", "text"]) && typeof value.text === "string";
      break;
    case "thinking_block_start":
    case "thinking_block_end":
      valid = hasExactKeys(value, ["type"]);
      break;
    case "thinking_delta":
      valid =
        hasExactKeys(value, ["type", "thinking"]) &&
        typeof value.thinking === "string";
      break;
    case "assistant_message":
      valid = hasExactKeys(value, ["type", "message"]) && isMessage(value.message);
      break;
    case "tool_start":
      valid =
        hasExactKeys(value, ["type", "id", "name", "input"]) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        isRecord(value.input);
      break;
    case "tool_end":
      valid =
        hasExactKeys(value, ["type", "id", "name", "result", "duration"]) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        isToolResult(value.result) &&
        isFiniteNumber(value.duration);
      break;
    case "turn_complete":
      valid =
        hasExactKeys(value, ["type", "turnCount", "usage"]) &&
        typeof value.turnCount === "number" &&
        Number.isSafeInteger(value.turnCount) &&
        value.turnCount >= 0 &&
        isTokenUsage(value.usage);
      break;
    default:
      throw new TypeError(`Unknown AgentYield variant: ${value.type}`);
  }
  if (!valid) {
    throw new TypeError(`Incomplete AgentYield variant: ${value.type}`);
  }
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

function unreachableAgentYield(value: never): never {
  throw new TypeError(`Unhandled AgentYield variant: ${String(value)}`);
}

function projectValidatedAgentYield(event: AgentYield): KernelRunEvent {
  switch (event.type) {
    case "text_delta":
      return Object.freeze({ type: "text_delta", text: event.text });
    case "thinking_block_start":
      return Object.freeze({ type: "thinking_block_start" });
    case "thinking_delta":
      return Object.freeze({ type: "thinking_delta", thinking: event.thinking });
    case "thinking_block_end":
      return Object.freeze({ type: "thinking_block_end" });
    case "assistant_message":
      return Object.freeze({
        type: "assistant_message",
        message: cloneAndFreeze(event.message),
      });
    case "tool_start":
      return Object.freeze({
        type: "tool_start",
        id: event.id,
        name: event.name,
        input: cloneAndFreeze(event.input),
      });
    case "tool_end":
      return Object.freeze({
        type: "tool_end",
        id: event.id,
        name: event.name,
        result: cloneAndFreeze(event.result),
        duration: event.duration,
      });
    case "turn_complete":
      return Object.freeze({
        type: "turn_complete",
        turnCount: event.turnCount,
        usage: cloneAndFreeze(event.usage),
      });
    default:
      return unreachableAgentYield(event);
  }
}

/** Explicit Agent Loop → Kernel projection. */
export function projectAgentYieldToKernelRunEvent(
  value: unknown,
): KernelRunEvent {
  assertAgentYield(value);
  return projectValidatedAgentYield(value);
}

/** Runtime guard used by every product-side projection. */
export function assertKernelRunEvent(
  value: unknown,
): asserts value is KernelRunEvent {
  assertAgentYield(value);
}
