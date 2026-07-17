import { Buffer } from "node:buffer";
import type { OutboundContentDto } from "../channels/types.js";
import { canonicalize } from "../protocol/canonical.js";

export const MAX_INLINE_DELIVERY_CONTENT_BYTES = 8 * 1024;

export function validateOutboundContentDto(
  value: unknown,
): asserts value is OutboundContentDto {
  assertPlainObject(value, "Outbound delivery content");
  assertExactKeys(value, ["markdown", "media", "text"]);
  if (typeof value.text !== "string") {
    throw new TypeError("Delivery content text must be a string");
  }
  if (value.markdown !== undefined && typeof value.markdown !== "string") {
    throw new TypeError("Delivery content markdown must be a string");
  }
  if (value.media === undefined) return;
  if (!Array.isArray(value.media)) {
    throw new TypeError("Delivery media must be an array");
  }
  for (const media of value.media) {
    assertPlainObject(media, "Delivery media item");
    assertExactKeys(media, ["ref", "type"], false);
    assertPlainObject(media.ref, "Delivery media artifact reference");
    assertExactKeys(media.ref, ["bytes", "digest"], false);
    if (
      typeof media.ref.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(media.ref.digest) ||
      !Number.isSafeInteger(media.ref.bytes) ||
      (media.ref.bytes as number) < 0
    ) {
      throw new TypeError("Delivery media artifact reference is invalid");
    }
    if (!["image", "file", "audio", "video"].includes(String(media.type))) {
      throw new TypeError("Delivery media type is invalid");
    }
  }
}

export function canonicalOutboundContentDto(value: unknown): string {
  validateOutboundContentDto(value);
  return canonicalize(value);
}

export function validateInlineOutboundContentDto(
  value: unknown,
): asserts value is OutboundContentDto {
  const encoded = canonicalOutboundContentDto(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_INLINE_DELIVERY_CONTENT_BYTES) {
    throw new TypeError("Inline delivery content must be externalized");
  }
}

function assertPlainObject(
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

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  optional = true,
): void {
  const actual = Object.keys(value);
  if (
    actual.some((key) => !allowed.includes(key)) ||
    (!optional && allowed.some((key) => !actual.includes(key)))
  ) {
    throw new TypeError("Delivery content fields are incomplete or unknown");
  }
}
