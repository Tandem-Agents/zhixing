import type { JsonValue, NodeExecutionResult, TokenUsage } from "@zhixing/core";

export function failedResult(
  code: string,
  error: unknown,
  recoverable: boolean,
): NodeExecutionResult {
  return {
    status: "failed",
    error: {
      code,
      message: errorMessage(error),
      recoverable,
    },
  };
}

export function canceledResult(reason?: unknown): NodeExecutionResult {
  const message =
    reason === undefined ? "Node execution canceled" : errorMessage(reason);
  return { status: "canceled", reason: message };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

export function usageToJson(usage: TokenUsage): JsonValue {
  const output: Record<string, JsonValue> = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (usage.totalInputTokens !== undefined) {
    output["totalInputTokens"] = usage.totalInputTokens;
  }
  if (usage.cacheReadTokens !== undefined) {
    output["cacheReadTokens"] = usage.cacheReadTokens;
  }
  if (usage.cacheWriteTokens !== undefined) {
    output["cacheWriteTokens"] = usage.cacheWriteTokens;
  }
  return output;
}
