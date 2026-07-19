import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { assertArtifactRef } from "../authority/artifact-references.js";
import type { ArtifactStore } from "../authority/interfaces.js";
import {
  MAX_INLINE_INTERACTION_DISPLAY_BYTES,
  type ArtifactRef,
  type InteractionDisplay,
} from "../contracts/index.js";
import { canonicalize } from "./canonical.js";

export interface PreparedInteractionDisplay {
  readonly display: InteractionDisplay;
  readonly references: readonly ArtifactRef[];
}

export type InlineInteractionDisplay = Extract<
  InteractionDisplay,
  { readonly title: string }
>;

/** Validates the canonical inline-or-reference representation without I/O. */
export function validateInteractionDisplay(value: unknown): InteractionDisplay {
  assertPlainObject(value, "Interaction display");
  if (Object.prototype.hasOwnProperty.call(value, "ref")) {
    assertExactKeys(value, ["ref"], "Interaction display reference");
    assertPlainObject(value.ref, "Interaction display artifact reference");
    assertExactKeys(
      value.ref,
      ["bytes", "digest"],
      "Interaction display artifact reference",
    );
    assertArtifactRef(value.ref);
    return value as InteractionDisplay;
  }
  const inline = validateInlineInteractionDisplay(value);
  if (inlineDisplayBytes(inline).byteLength > MAX_INLINE_INTERACTION_DISPLAY_BYTES) {
    throw new TypeError("Interaction display must be externalized above its inline budget");
  }
  return inline;
}

/**
 * Reads and validates the referenced display during authoritative replay.
 * Returning the materialized value does not change the frozen representation.
 */
export async function materializeInteractionDisplay(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<InlineInteractionDisplay> {
  const display = validateInteractionDisplay(value);
  if (!("ref" in display)) return display;

  const bytes = await artifacts.get(display.ref);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Interaction display artifact is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("Interaction display artifact is not valid JSON");
  }
  const inline = validateInlineInteractionDisplay(parsed);
  const canonical = canonicalize(inline);
  if (canonical !== text) {
    throw new TypeError("Interaction display artifact is not canonical JSON");
  }
  if (Buffer.byteLength(canonical, "utf8") <= MAX_INLINE_INTERACTION_DISPLAY_BYTES) {
    throw new TypeError("Interaction display artifact must exceed the inline budget");
  }
  return inline;
}

/**
 * Freezes one interaction display into the exact representation used by every
 * durable consumer. Large displays are externalized before any digest is made.
 */
export async function prepareInteractionDisplay(
  input: { readonly title: string; readonly lines: readonly string[] },
  artifacts: ArtifactStore,
): Promise<PreparedInteractionDisplay> {
  const inline = validateInlineInteractionDisplay({
    title: input.title,
    lines: [...input.lines],
  });
  const bytes = inlineDisplayBytes(inline);
  if (bytes.byteLength <= MAX_INLINE_INTERACTION_DISPLAY_BYTES) {
    return { display: inline, references: [] };
  }
  const ref = await artifacts.put(bytes);
  return { display: { ref }, references: [ref] };
}

function validateInlineInteractionDisplay(value: unknown): InlineInteractionDisplay {
  assertPlainObject(value, "Interaction display");
  assertExactKeys(value, ["lines", "title"], "Interaction display");
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new TypeError("Interaction display title must be non-empty");
  }
  if (!Array.isArray(value.lines)) {
    throw new TypeError("Interaction display lines must be an array");
  }
  if (
    Object.keys(value.lines).length !== value.lines.length ||
    value.lines.some((line) => typeof line !== "string")
  ) {
    throw new TypeError("Interaction display lines must be dense strings");
  }
  return value as unknown as InlineInteractionDisplay;
}

function inlineDisplayBytes(value: InlineInteractionDisplay): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}
