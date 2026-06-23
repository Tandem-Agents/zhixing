import { TextDecoder } from "node:util";
import type { GrepLineText } from "./types.js";

export type GrepTextEncoding =
  | "utf-8"
  | "utf-8-bom"
  | "utf-16le-bom"
  | "utf-16be-bom";

export interface DecodedGrepText {
  text: string;
  encoding: GrepTextEncoding;
}

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF16LE_DECODER = new TextDecoder("utf-16le");
const UTF16BE_DECODER = new TextDecoder("utf-16be");

export function decodeGrepFileBytes(bytes: Uint8Array): DecodedGrepText {
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      text: UTF8_DECODER.decode(bytes.subarray(3)),
      encoding: "utf-8-bom",
    };
  }

  if (startsWithBytes(bytes, [0xff, 0xfe])) {
    return {
      text: UTF16LE_DECODER.decode(bytes.subarray(2)),
      encoding: "utf-16le-bom",
    };
  }

  if (startsWithBytes(bytes, [0xfe, 0xff])) {
    return {
      text: UTF16BE_DECODER.decode(bytes.subarray(2)),
      encoding: "utf-16be-bom",
    };
  }

  return {
    text: UTF8_DECODER.decode(bytes),
    encoding: "utf-8",
  };
}

export function splitLogicalLines(text: string): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    if (char !== "\n" && char !== "\r") {
      index++;
      continue;
    }

    lines.push(text.slice(lineStart, index));
    if (char === "\r" && text[index + 1] === "\n") index++;
    index++;
    lineStart = index;
  }

  if (lineStart < text.length) {
    lines.push(text.slice(lineStart));
  }

  return lines;
}

export function toGrepLineText(
  text: string,
  maxLineChars: number,
): GrepLineText {
  if (!Number.isInteger(maxLineChars) || maxLineChars < 0) {
    throw new RangeError("maxLineChars must be a non-negative integer");
  }

  const scalars = Array.from(text);
  if (scalars.length <= maxLineChars) {
    return { text, truncated: false };
  }

  return {
    text: scalars.slice(0, maxLineChars).join(""),
    truncated: true,
    omittedScalars: scalars.length - maxLineChars,
  };
}

export function countUnicodeScalars(text: string): number {
  return Array.from(text).length;
}

function startsWithBytes(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.length < expected.length) return false;
  return expected.every((byte, index) => bytes[index] === byte);
}
