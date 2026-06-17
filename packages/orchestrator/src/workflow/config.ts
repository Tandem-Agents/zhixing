import type { JsonValue } from "@zhixing/core";

export type JsonRecord = { readonly [key: string]: JsonValue };

export interface AgentNodeExecutorConfig {
  readonly prompt: string;
  readonly includeInput: boolean;
}

export interface ToolNodeExecutorConfig {
  readonly toolName: string;
  readonly input: JsonRecord;
  readonly inputPointers: Record<string, string>;
}

export function parseAgentNodeExecutorConfig(
  config: JsonValue | undefined,
): AgentNodeExecutorConfig {
  const record = expectOptionalRecord(config, "agent executor config");
  const promptValue = record?.["prompt"] ?? record?.["task"];
  if (typeof promptValue !== "string" || promptValue.trim().length === 0) {
    throw new Error("Agent node executor requires non-empty prompt");
  }
  const includeInputValue = record?.["includeInput"];
  if (
    includeInputValue !== undefined &&
    typeof includeInputValue !== "boolean"
  ) {
    throw new Error("Agent node executor includeInput must be boolean");
  }
  return {
    prompt: promptValue.trim(),
    includeInput: includeInputValue ?? true,
  };
}

export function parseToolNodeExecutorConfig(
  config: JsonValue | undefined,
): ToolNodeExecutorConfig {
  const record = expectRecord(config, "tool executor config");
  const toolName = record["toolName"];
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    throw new Error("Tool node executor requires non-empty toolName");
  }
  const input = record["input"];
  if (input !== undefined && !isJsonRecord(input)) {
    throw new Error("Tool node executor input must be a JSON object");
  }
  const inputPointersValue = record["inputPointers"];
  if (
    inputPointersValue !== undefined &&
    !isStringRecord(inputPointersValue)
  ) {
    throw new Error("Tool node executor inputPointers must map keys to pointers");
  }
  return {
    toolName: toolName.trim(),
    input: input ?? {},
    inputPointers: inputPointersValue ?? {},
  };
}

export function resolvePointer(input: JsonValue, pointer: string): JsonValue {
  if (pointer === "") return input;
  if (!pointer.startsWith("/")) {
    throw new Error(`Invalid JSON pointer "${pointer}"`);
  }

  let current: JsonValue | undefined = input;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= current.length ||
        String(index) !== segment
      ) {
        throw new Error(`JSON pointer not found: ${pointer}`);
      }
      current = current[index];
      continue;
    }
    if (isJsonRecord(current)) {
      if (!(segment in current)) {
        throw new Error(`JSON pointer not found: ${pointer}`);
      }
      current = current[segment];
      continue;
    }
    throw new Error(`JSON pointer not found: ${pointer}`);
  }
  return current ?? null;
}

export function asMutableToolInput(
  record: JsonRecord,
): Record<string, unknown> {
  return { ...record };
}

function expectOptionalRecord(
  value: JsonValue | undefined,
  label: string,
): JsonRecord | undefined {
  if (value === undefined) return undefined;
  return expectRecord(value, label);
}

function expectRecord(value: JsonValue | undefined, label: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isJsonRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}
