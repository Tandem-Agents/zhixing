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

export type PastedMaterialIngestResult =
  | { readonly kind: "not-material" }
  | {
      readonly kind: "ingested";
      readonly insertText: string;
      readonly diagnostics: readonly PastedMaterialIngestDiagnostic[];
    };

export type PastedMaterialIngestFailureReason = "unreadable" | "not-file";

export interface PastedMaterialIngestDiagnostic {
  readonly input: string;
  readonly filePath: string;
  readonly reason: PastedMaterialIngestFailureReason;
  readonly message: string;
}

interface PastedMaterialItem {
  readonly raw: string;
  readonly input: string;
  readonly quoted: boolean;
  readonly shellEscaped: boolean;
  readonly intent: PathIntent;
}

type PathIntent = "text" | "material-path" | "source-location";

type ProcessedMaterialItem =
  | { readonly kind: "text"; readonly raw: string }
  | { readonly kind: "material"; readonly token: string }
  | {
      readonly kind: "failure";
      readonly raw: string;
      readonly diagnostic: PastedMaterialIngestDiagnostic;
    };

export function ingestPastedMaterials(
  content: string,
  registry: InputMaterialRegistry,
  options: PasteMaterialIngestOptions,
): PastedMaterialIngestResult {
  const items = parsePastedMaterialItems(content);
  if (items.length === 0) return { kind: "not-material" };
  if (!isMaterialPathBatch(items)) return { kind: "not-material" };

  return ingestMaterialPathBatch(items, registry, options);
}

function ingestMaterialPathBatch(
  items: readonly PastedMaterialItem[],
  registry: InputMaterialRegistry,
  options: PasteMaterialIngestOptions,
): PastedMaterialIngestResult {
  const processed = items.map((item) =>
    processMaterialItem(item, registry, options),
  );
  const hasMaterial = processed.some((item) => item.kind === "material");
  const hasFailure = processed.some((item) => item.kind === "failure");
  if (!hasMaterial && !hasFailure) return { kind: "not-material" };

  const outputLines: string[] = [];
  const diagnostics: PastedMaterialIngestDiagnostic[] = [];

  for (const item of processed) {
    if (item.kind === "text") {
      outputLines.push(item.raw);
      continue;
    }
    if (item.kind === "material") {
      outputLines.push(item.token);
      continue;
    }

    outputLines.push(item.raw);
    diagnostics.push(item.diagnostic);
  }

  return {
    kind: "ingested",
    insertText: trimEmptyLineEdges(outputLines).join("\n"),
    diagnostics,
  };
}

export function formatMaterialIngestDiagnostic(
  diagnostic: PastedMaterialIngestDiagnostic,
): string {
  return `${diagnostic.input} -> ${diagnostic.message}`;
}

function parsePastedMaterialItems(content: string): PastedMaterialItem[] {
  const rawLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines = trimEmptyLineEdges(rawLines);
  return lines.flatMap((raw) => parsePastedMaterialLineItems(raw));
}

function parsePastedMaterialLineItems(rawLine: string): PastedMaterialItem[] {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0) {
    return [createPastedMaterialItem(rawLine, "", false, false)];
  }

  const tokens = tokenizePastedMaterialLine(trimmed);
  if (!tokens || tokens.length === 0) return [parseSinglePastedMaterialItem(rawLine)];

  if (tokens.length === 1) {
    const token = tokens[0]!;
    return [
      createPastedMaterialItem(
        rawLine,
        token.value,
        token.quoted,
        token.shellEscaped,
      ),
    ];
  }

  if (!tokens.every(hasExplicitTokenBoundary)) {
    return [parseSinglePastedMaterialItem(rawLine)];
  }

  return tokens.map((token) =>
    createPastedMaterialItem(
      token.raw,
      token.value,
      token.quoted,
      token.shellEscaped,
    ),
  );
}

interface PastedMaterialToken {
  readonly raw: string;
  readonly value: string;
  readonly quoted: boolean;
  readonly shellEscaped: boolean;
}

function tokenizePastedMaterialLine(input: string): PastedMaterialToken[] | null {
  const tokens: PastedMaterialToken[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index++;
    if (index >= input.length) break;

    const quote = input[index];
    if (quote === '"' || quote === "'") {
      const token = readQuotedToken(input, index, quote);
      if (!token) return null;
      if (
        token.nextIndex < input.length &&
        !/\s/.test(input[token.nextIndex]!)
      ) {
        return null;
      }
      tokens.push(token.token);
      index = token.nextIndex;
      continue;
    }

    const token = readUnquotedToken(input, index);
    tokens.push(token.token);
    index = token.nextIndex;
  }

  return tokens;
}

function readQuotedToken(
  input: string,
  start: number,
  quote: string,
): { readonly token: PastedMaterialToken; readonly nextIndex: number } | null {
  let index = start + 1;
  let value = "";
  while (index < input.length) {
    const ch = input[index]!;
    if (ch === quote) {
      return {
        token: {
          raw: input.slice(start, index + 1),
          value,
          quoted: true,
          shellEscaped: false,
        },
        nextIndex: index + 1,
      };
    }
    value += ch;
    index++;
  }

  return null;
}

function readUnquotedToken(
  input: string,
  start: number,
): { readonly token: PastedMaterialToken; readonly nextIndex: number } {
  let index = start;

  while (index < input.length) {
    const ch = input[index]!;
    if (/\s/.test(ch)) break;
    if (ch === "\\" && index + 1 < input.length && /\s/.test(input[index + 1]!)) {
      index += 2;
      continue;
    }
    index++;
  }

  const raw = input.slice(start, index);
  const decoded = decodePosixShellPathToken(raw);

  return {
    token: {
      raw,
      value: decoded.value,
      quoted: false,
      shellEscaped: decoded.shellEscaped,
    },
    nextIndex: index,
  };
}

function parseSinglePastedMaterialItem(raw: string): PastedMaterialItem {
  const parsed = unquote(raw.trim());
  return createPastedMaterialItem(raw, parsed.value, parsed.quoted, false);
}

function createPastedMaterialItem(
  raw: string,
  input: string,
  quoted: boolean,
  shellEscaped: boolean,
): PastedMaterialItem {
  return {
    raw,
    input,
    quoted,
    shellEscaped,
    intent: classifyPathIntent(input, quoted, shellEscaped),
  };
}

function unquote(input: string): { readonly value: string; readonly quoted: boolean } {
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return { value: input.slice(1, -1), quoted: true };
  }
  return { value: input, quoted: false };
}

function resolvePastedPath(input: string, workspaceRoot: string): string {
  const expanded = expandUserHome(input);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(workspaceRoot, expanded);
}

function processMaterialItem(
  item: PastedMaterialItem,
  registry: InputMaterialRegistry,
  options: PasteMaterialIngestOptions,
): ProcessedMaterialItem {
  if (!item.input || item.intent !== "material-path") {
    return { kind: "text", raw: item.raw };
  }

  const filePath = resolvePastedPath(item.input, options.workspaceRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      kind: "failure",
      raw: item.raw,
      diagnostic: {
        input: item.input,
        filePath,
        reason: "unreadable",
        message: retainedFailureMessage("文件不存在或不可读取"),
      },
    };
  }

  if (!stat.isFile()) {
    return {
      kind: "failure",
      raw: item.raw,
      diagnostic: {
        input: item.input,
        filePath,
        reason: "not-file",
        message: retainedFailureMessage("不是普通文件"),
      },
    };
  }

  const header = readFileHeader(filePath, stat.size);
  const mimeType = detectMimeType(filePath, header);
  const kind: InputMaterialKind = mimeType.startsWith("image/")
    ? "image"
    : "file";
  const id = registry.registerLocalFile({
    kind,
    filePath,
    name: path.basename(filePath),
    mimeType,
    byteSize: stat.size,
    image: kind === "image" ? readImageMetadata(header, mimeType) : undefined,
  });
  return {
    kind: "material",
    token: registry.format(id, { maxWidth: options.tokenMaxWidth }),
  };
}

function classifyPathIntent(
  input: string,
  quoted: boolean,
  shellEscaped: boolean,
): PathIntent {
  if (!input) return "text";
  if (isSourceLocationLike(input)) return "source-location";
  if (isUrlLike(input) || isPlainDateLike(input)) return "text";
  if (!quoted && !shellEscaped && /\s/.test(input)) return "text";
  if (isMaterialPathLike(input)) return "material-path";
  return "text";
}

function isMaterialPathBatch(items: readonly PastedMaterialItem[]): boolean {
  const nonEmpty = items.filter((item) => item.input.length > 0);
  return (
    nonEmpty.length > 0 &&
    nonEmpty.every((item) => item.intent === "material-path")
  );
}

function hasExplicitTokenBoundary(token: PastedMaterialToken): boolean {
  return token.quoted || token.shellEscaped;
}

function isPosixEscapedPathToken(raw: string): boolean {
  return /^(~|\.{1,2})\//.test(raw) || raw.startsWith("/");
}

const POSIX_PATH_ESCAPE_CHARS = new Set([
  "\\",
  '"',
  "'",
  " ",
  "\t",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "&",
  ";",
  "|",
  "<",
  ">",
  "*",
  "?",
  "!",
  "#",
  "$",
  "`",
]);

function decodePosixShellPathToken(
  raw: string,
): { readonly value: string; readonly shellEscaped: boolean } {
  if (!isPosixEscapedPathToken(raw)) {
    return { value: raw, shellEscaped: false };
  }

  let value = "";
  let shellEscaped = false;
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index]!;
    if (ch !== "\\" || index + 1 >= raw.length) {
      value += ch;
      continue;
    }

    const next = raw[index + 1]!;
    if (!isPosixPathEscapeChar(next)) {
      value += ch;
      continue;
    }

    value += next;
    shellEscaped = true;
    index++;
  }

  return { value, shellEscaped };
}

function isPosixPathEscapeChar(ch: string): boolean {
  return /\s/.test(ch) || POSIX_PATH_ESCAPE_CHARS.has(ch);
}

function isMaterialPathLike(input: string): boolean {
  if (/^(~|\.{1,2})([\\/]|$)/.test(input)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (/^[/\\]{2}[^/\\\s]+[/\\][^/\\\s]+/.test(input)) return true;
  if (/^[/\\]{2}/.test(input)) return false;
  return path.isAbsolute(expandUserHome(input));
}

function isUrlLike(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input);
}

function isSourceLocationLike(input: string): boolean {
  if (isUrlLike(input)) return false;

  const parenLocation = /\(\d+(?:,\d+)?\)$/.exec(input);
  if (parenLocation) {
    return isSourcePathBase(input.slice(0, parenLocation.index));
  }

  const colonLocation = /:(\d+)(?::(\d+))?$/.exec(input);
  if (!colonLocation) return false;
  return isSourcePathBase(input.slice(0, colonLocation.index));
}

function isSourcePathBase(input: string): boolean {
  if (!input || /^[a-zA-Z]$/.test(input)) return false;
  return /[\\/]/.test(input) || /\.[A-Za-z0-9]{1,8}$/.test(input);
}

function isPlainDateLike(input: string): boolean {
  return /^\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?$/.test(input);
}

function retainedFailureMessage(message: string): string {
  return `未添加为材料，原文已保留：${message}`;
}

function trimEmptyLineEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
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
