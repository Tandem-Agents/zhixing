import type { EnvironmentRequirement } from "../contracts/protocol.js";
import type {
  ContentBlock,
  ImageSource,
  Message,
} from "../types/messages.js";
import type { UserTurnInput } from "../types/user-input.js";
import { canonicalize, compareCanonicalStrings } from "./canonical.js";
import { assertProtocolIdentifier as assertIdentifier } from "./validation.js";

const EVIDENCE_KINDS = new Set([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
  "conversation-fact",
  "none",
]);

/** Protocol-grade validation for a durable or wire user turn. */
export function validateUserTurnInput(value: unknown): UserTurnInput {
  assertPlainRecord(value, "User turn input");
  assertExactKeys(value, ["parts"], "User turn input");
  assertDenseArray(value.parts, "User turn input parts");
  for (const part of value.parts) {
    assertPlainRecord(part, "User input part");
    if (part.type === "text") {
      assertExactKeys(part, ["text", "type"], "User input text part");
      assertString(part.text, "User input text");
      continue;
    }
    if (part.type !== "image") {
      throw new TypeError("User input part type is invalid");
    }
    assertAllowedKeys(
      part,
      ["mimeType", "name", "size", "source", "type"],
      "User input image part",
    );
    assertImageSource(part.source, "User input image source");
    if (part.name !== undefined) {
      assertNonEmptyString(part.name, "User input image name");
    }
    if (part.mimeType !== undefined) {
      assertNonEmptyString(part.mimeType, "User input image mimeType");
    }
    if (
      part.size !== undefined &&
      (!Number.isSafeInteger(part.size) || (part.size as number) < 0)
    ) {
      throw new TypeError("User input image size must be a non-negative safe integer");
    }
  }
  return value as unknown as UserTurnInput;
}

/** Protocol-grade user-turn validation that also requires executable content. */
export function validateNonEmptyUserTurnInput(value: unknown): UserTurnInput {
  const input = validateUserTurnInput(value);
  if (
    !input.parts.some((part) =>
      part.type === "image" ? true : part.text.length > 0,
    )
  ) {
    throw new TypeError("User turn input must contain non-empty content");
  }
  return input;
}

/** Validates the exact closed Message[] schema used by durable protocol DTOs. */
export function validateMessages(value: unknown, label = "Messages"): Message[] {
  assertDenseArray(value, label);
  for (const message of value) validateMessage(message, `${label} message`);
  return value as Message[];
}

/** Validates one exact closed Message value. */
export function validateMessage(value: unknown, label = "Message"): Message {
  assertPlainRecord(value, label);
  assertExactKeys(value, ["content", "role"], label);
  if (value.role !== "user" && value.role !== "assistant") {
    throw new TypeError(`${label} role is invalid`);
  }
  assertDenseArray(value.content, `${label} content`);
  for (const block of value.content) validateContentBlock(block, `${label} content block`);
  return value as unknown as Message;
}

/** Validates the exact EnvironmentRequirement shape embedded in a manifest. */
export function validateEnvironmentRequirement(value: unknown): EnvironmentRequirement {
  assertPlainRecord(value, "Manifest environment");
  assertAllowedKeys(
    value,
    ["credentialBindings", "deviceId", "evidenceKinds", "workspace"],
    "Manifest environment",
  );
  if (value.deviceId !== undefined) {
    assertIdentifier(value.deviceId, "Environment deviceId");
  }
  if (value.workspace !== undefined) {
    assertPlainRecord(value.workspace, "Manifest workspace");
    assertExactKeys(
      value.workspace,
      ["bindingRef", "deviceId", "workspaceBindingRevision"],
      "Manifest workspace",
    );
    assertIdentifier(value.workspace.deviceId, "Workspace deviceId");
    assertIdentifier(value.workspace.bindingRef, "Workspace bindingRef");
    assertPositiveInteger(
      value.workspace.workspaceBindingRevision,
      "Workspace binding revision",
    );
    if (
      value.deviceId !== undefined &&
      value.deviceId !== value.workspace.deviceId
    ) {
      throw new TypeError(
        "Manifest deviceId must match the workspace target device",
      );
    }
  }
  if (value.credentialBindings !== undefined) {
    assertDenseArray(value.credentialBindings, "Environment credential bindings");
    const bindingIds = new Set<string>();
    for (const binding of value.credentialBindings) {
      assertPlainRecord(binding, "Environment credential binding");
      assertExactKeys(
        binding,
        ["bindingId", "service"],
        "Environment credential binding",
      );
      assertIdentifier(binding.service, "Environment credential service");
      assertIdentifier(binding.bindingId, "Environment credential bindingId");
      if (bindingIds.has(binding.bindingId)) {
        throw new TypeError("Environment credential binding ids must be unique");
      }
      bindingIds.add(binding.bindingId);
    }
    assertSorted(
      value.credentialBindings as Array<{ service: string; bindingId: string }>,
      (binding) => `${binding.service}\u0000${binding.bindingId}`,
      "Environment credential bindings",
    );
  }
  if (value.evidenceKinds !== undefined) {
    assertDenseArray(value.evidenceKinds, "Environment evidence kinds");
    const kinds = new Set<string>();
    for (const kind of value.evidenceKinds) {
      if (typeof kind !== "string" || !EVIDENCE_KINDS.has(kind)) {
        throw new TypeError("Environment evidence kind is invalid");
      }
      if (kinds.has(kind)) {
        throw new TypeError("Environment evidence kinds must be unique");
      }
      kinds.add(kind);
    }
    assertSorted(
      value.evidenceKinds as string[],
      (kind) => kind,
      "Environment evidence kinds",
    );
  }
  return value as unknown as EnvironmentRequirement;
}

function validateContentBlock(value: unknown, label: string): ContentBlock {
  assertPlainRecord(value, label);
  switch (value.type) {
    case "text":
      assertExactKeys(value, ["text", "type"], label);
      assertString(value.text, `${label} text`);
      return value as unknown as ContentBlock;
    case "image":
      assertExactKeys(value, ["source", "type"], label);
      assertImageSource(value.source, `${label} image source`);
      return value as unknown as ContentBlock;
    case "tool_use":
      assertExactKeys(value, ["id", "input", "name", "type"], label);
      assertIdentifier(value.id, `${label} id`);
      assertIdentifier(value.name, `${label} name`);
      assertPlainRecord(value.input, `${label} input`);
      try {
        canonicalize(value.input);
      } catch (error) {
        throw new TypeError(`${label} input must be canonical JSON`, { cause: error });
      }
      return value as unknown as ContentBlock;
    case "tool_result":
      assertAllowedKeys(value, ["content", "isError", "toolUseId", "type"], label);
      if (!("content" in value) || !("toolUseId" in value)) {
        throw new TypeError(`${label} is incomplete`);
      }
      assertIdentifier(value.toolUseId, `${label} toolUseId`);
      assertString(value.content, `${label} content`);
      if (value.isError !== undefined && typeof value.isError !== "boolean") {
        throw new TypeError(`${label} isError must be boolean`);
      }
      return value as unknown as ContentBlock;
    case "thinking":
      assertAllowedKeys(value, ["signature", "thinking", "type"], label);
      if (!("thinking" in value)) throw new TypeError(`${label} is incomplete`);
      assertString(value.thinking, `${label} thinking`);
      if (value.signature !== undefined) {
        assertString(value.signature, `${label} signature`);
      }
      return value as unknown as ContentBlock;
    default:
      throw new TypeError(`${label} type is invalid`);
  }
}

function assertImageSource(value: unknown, label: string): asserts value is ImageSource {
  assertPlainRecord(value, label);
  if (value.type === "base64") {
    assertExactKeys(value, ["data", "mediaType", "type"], label);
    assertString(value.mediaType, `${label} mediaType`);
    assertString(value.data, `${label} data`);
    return;
  }
  if (value.type === "url") {
    assertExactKeys(value, ["type", "url"], label);
    assertString(value.url, `${label} url`);
    return;
  }
  throw new TypeError(`${label} type is invalid`);
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new TypeError(`${label} must be a dense array`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function assertAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${label} contains an unknown field`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSorted<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCanonicalStrings(key(values[index - 1]!), key(values[index]!)) > 0) {
      throw new TypeError(`${label} must be sorted`);
    }
  }
}
