import * as path from "node:path";

import { detectMimeType } from "./input-material-ingest.js";

const UTF8_FATAL_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

// Rejects NUL and all Unicode Cc controls except White_Space controls (\t, \n, \v, \f, \r, U+0085 NEL).
const NON_WHITESPACE_CONTROL_RE =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/u;

export function isSupportedTextMaterialMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
}

export function isUnclassifiedExtensionlessMaterial(entry: {
  readonly kind: string;
  readonly mimeType: string;
  readonly filePath: string;
}): boolean {
  if (entry.kind !== "file" || entry.mimeType !== "application/octet-stream") {
    return false;
  }
  const base = path.basename(entry.filePath);
  if (!base || base === "." || base === "..") return false;
  return path.extname(base) === "" && !base.endsWith(".");
}

export function decodeUnclassifiedPlainUtf8Material(
  filePath: string,
  bytes: Uint8Array,
): string | null {
  if (bytes.byteLength === 0) return "";

  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (detectMimeType(filePath, buf) !== "application/octet-stream") {
    return null;
  }
  if (hasAsciiUnsupportedContainerHeader(buf)) {
    return null;
  }

  for (let i = 0; i < buf.length; i += 1) {
    const b = buf[i]!;
    if (b <= 0x08 || (b >= 0x0e && b <= 0x1f) || b === 0x7f) {
      return null;
    }
  }

  let decoded: string;
  try {
    decoded = UTF8_FATAL_DECODER.decode(buf);
  } catch {
    return null;
  }

  if (NON_WHITESPACE_CONTROL_RE.test(decoded)) {
    return null;
  }
  return decoded;
}

function hasAsciiUnsupportedContainerHeader(bytes: Buffer): boolean {
  return (
    startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) || // %PDF-
    startsWithBytes(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]) // {\rtf
  );
}

function startsWithBytes(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}
