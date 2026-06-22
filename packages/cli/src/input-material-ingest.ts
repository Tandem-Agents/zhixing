import * as fs from "node:fs";
import * as path from "node:path";

import { expandUserHome } from "@zhixing/core";

import {
  InputMaterialRegistry,
  type ImageMetadata,
  type InputMaterialKind,
} from "./input-material-registry.js";

export interface PasteMaterialIngestOptions {
  readonly workspaceRoot: string;
  readonly tokenMaxWidth?: number;
}

export function materialTokensFromPastedPaths(
  content: string,
  registry: InputMaterialRegistry,
  options: PasteMaterialIngestOptions,
): string | null {
  const paths = parsePastedPaths(content);
  if (paths.length === 0) return null;

  const entries = [];
  for (const pastedPath of paths) {
    const filePath = resolvePastedPath(pastedPath, options.workspaceRoot);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const header = readFileHeader(filePath, stat.size);
    const mimeType = detectMimeType(filePath, header);
    const kind: InputMaterialKind = mimeType.startsWith("image/")
      ? "image"
      : "file";
    entries.push({
      kind,
      filePath,
      name: path.basename(filePath),
      mimeType,
      byteSize: stat.size,
      image: kind === "image" ? readImageMetadata(header, mimeType) : undefined,
    });
  }

  return entries
    .map((entry) => {
      const id = registry.registerLocalFile(entry);
      return registry.format(id, { maxWidth: options.tokenMaxWidth });
    })
    .join("\n");
}

function parsePastedPaths(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized
    .split("\n")
    .map((line) => unquote(line.trim()))
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines;
}

function unquote(input: string): string {
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1);
  }
  return input;
}

function resolvePastedPath(input: string, workspaceRoot: string): string {
  const expanded = expandUserHome(input);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(workspaceRoot, expanded);
}

export function detectMimeType(
  filePath: string,
  header: Buffer = Buffer.alloc(0),
): string {
  const sniffed = detectMimeTypeFromHeader(header);
  if (sniffed) return sniffed;

  const ext = path.extname(filePath).toLowerCase();
  if (isImageExtension(ext)) return "application/octet-stream";

  switch (ext) {
    case ".txt":
    case ".md":
    case ".markdown":
    case ".log":
    case ".json":
    case ".jsonc":
    case ".yaml":
    case ".yml":
    case ".xml":
    case ".html":
    case ".css":
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
    case ".mjs":
    case ".cjs":
    case ".py":
    case ".rs":
    case ".go":
    case ".java":
    case ".c":
    case ".h":
    case ".cpp":
    case ".hpp":
    case ".cs":
    case ".sh":
    case ".ps1":
    case ".sql":
    case ".toml":
    case ".ini":
    case ".csv":
    case ".tsv":
      return "text/plain";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function readImageMetadata(
  bytes: Buffer,
  mimeType: string,
): ImageMetadata | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }

  if (mimeType === "image/gif" && bytes.length >= 10) {
    return {
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }

  if (mimeType === "image/jpeg") {
    return readJpegMetadata(bytes);
  }

  if (mimeType === "image/webp") {
    return readWebpMetadata(bytes);
  }

  return undefined;
}

function readFileHeader(filePath: string, size: number): Buffer {
  const byteCount = Math.min(size, 64 * 1024);
  if (byteCount <= 0) return Buffer.alloc(0);

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const bytes = Buffer.alloc(byteCount);
    const read = fs.readSync(fd, bytes, 0, byteCount, 0);
    return read === byteCount ? bytes : bytes.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}

function detectMimeTypeFromHeader(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function isImageExtension(ext: string): boolean {
  return (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".gif" ||
    ext === ".webp"
  );
}

function readJpegMetadata(bytes: Buffer): ImageMetadata | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;

    const isSof =
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf));
    if (isSof && offset + 8 < bytes.length) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return undefined;
}

function readWebpMetadata(bytes: Buffer): ImageMetadata | undefined {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return undefined;
  }

  const chunkType = bytes.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }

  if (chunkType === "VP8 " && bytes.length >= 30) {
    const start = 20;
    if (
      bytes[start + 3] === 0x9d &&
      bytes[start + 4] === 0x01 &&
      bytes[start + 5] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(start + 6) & 0x3fff,
        height: bytes.readUInt16LE(start + 8) & 0x3fff,
      };
    }
  }

  if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  return undefined;
}
