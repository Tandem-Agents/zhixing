import type { JsonValue, WorkflowDecisionOption } from "@zhixing/core";

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

export interface GateNodeExecutorConfig {
  readonly question: string;
  readonly options: readonly WorkflowDecisionOption[];
  readonly recommendedOptionId?: string;
  readonly rationale?: string;
  readonly includeInputInRationale: boolean;
}

export interface JoinNodeExecutorConfig {
  readonly label?: string;
  readonly includeInput: boolean;
  readonly metadata?: JsonRecord;
}

export interface TransformNodeExecutorConfig {
  readonly output: JsonRecord;
  readonly inputPointers: Record<string, string>;
  readonly includeInput: boolean;
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

export function parseGateNodeExecutorConfig(
  config: JsonValue | undefined,
): GateNodeExecutorConfig {
  const record = expectRecord(config, "gate executor config");
  const question = record["question"];
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new Error("Gate node executor requires non-empty question");
  }
  const optionsValue = record["options"];
  if (!Array.isArray(optionsValue) || optionsValue.length === 0) {
    throw new Error("Gate node executor requires at least one option");
  }

  const optionIds = new Set<string>();
  const options = optionsValue.map((entry, index) => {
    if (!isJsonRecord(entry)) {
      throw new Error(`Gate node executor option ${index} must be an object`);
    }
    const optionId = entry["optionId"];
    const label = entry["label"];
    const description = entry["description"];
    if (typeof optionId !== "string" || optionId.trim().length === 0) {
      throw new Error(`Gate node executor option ${index} requires optionId`);
    }
    const normalizedOptionId = optionId.trim();
    if (optionIds.has(normalizedOptionId)) {
      throw new Error(
        `Gate node executor option "${normalizedOptionId}" is duplicated`,
      );
    }
    optionIds.add(normalizedOptionId);
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error(
        `Gate node executor option "${normalizedOptionId}" requires label`,
      );
    }
    if (description !== undefined && typeof description !== "string") {
      throw new Error(
        `Gate node executor option "${normalizedOptionId}" description must be string`,
      );
    }
    return {
      optionId: normalizedOptionId,
      label: label.trim(),
      ...(description !== undefined ? { description } : {}),
    };
  });

  const recommendedOptionId = record["recommendedOptionId"];
  const normalizedRecommendedOptionId =
    typeof recommendedOptionId === "string"
      ? recommendedOptionId.trim()
      : recommendedOptionId;
  if (
    normalizedRecommendedOptionId !== undefined &&
    (typeof normalizedRecommendedOptionId !== "string" ||
      !optionIds.has(normalizedRecommendedOptionId))
  ) {
    throw new Error("Gate node executor recommendedOptionId must match an option");
  }
  const rationale = record["rationale"];
  if (rationale !== undefined && typeof rationale !== "string") {
    throw new Error("Gate node executor rationale must be string");
  }
  const includeInputInRationale = record["includeInputInRationale"];
  if (
    includeInputInRationale !== undefined &&
    typeof includeInputInRationale !== "boolean"
  ) {
    throw new Error("Gate node executor includeInputInRationale must be boolean");
  }

  return {
    question: question.trim(),
    options,
    ...(typeof normalizedRecommendedOptionId === "string"
      ? { recommendedOptionId: normalizedRecommendedOptionId }
      : {}),
    ...(typeof rationale === "string" ? { rationale } : {}),
    includeInputInRationale: includeInputInRationale ?? false,
  };
}

export function parseJoinNodeExecutorConfig(
  config: JsonValue | undefined,
): JoinNodeExecutorConfig {
  const record = expectOptionalRecord(config, "join executor config");
  const label = record?.["label"];
  if (label !== undefined && typeof label !== "string") {
    throw new Error("Join node executor label must be string");
  }
  const includeInput = record?.["includeInput"];
  if (includeInput !== undefined && typeof includeInput !== "boolean") {
    throw new Error("Join node executor includeInput must be boolean");
  }
  const metadata = record?.["metadata"];
  if (metadata !== undefined && !isJsonRecord(metadata)) {
    throw new Error("Join node executor metadata must be a JSON object");
  }
  return {
    ...(typeof label === "string" && label.trim().length > 0
      ? { label: label.trim() }
      : {}),
    includeInput: includeInput ?? true,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function parseTransformNodeExecutorConfig(
  config: JsonValue | undefined,
): TransformNodeExecutorConfig {
  const record = expectRecord(config, "transform executor config");
  const output = record["output"];
  if (output !== undefined && !isJsonRecord(output)) {
    throw new Error("Transform node executor output must be a JSON object");
  }
  const inputPointersValue = record["inputPointers"];
  if (
    inputPointersValue !== undefined &&
    !isStringRecord(inputPointersValue)
  ) {
    throw new Error("Transform node executor inputPointers must map keys to pointers");
  }
  const includeInput = record["includeInput"];
  if (includeInput !== undefined && typeof includeInput !== "boolean") {
    throw new Error("Transform node executor includeInput must be boolean");
  }
  return {
    output: output ?? {},
    inputPointers: inputPointersValue ?? {},
    includeInput: includeInput ?? false,
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
