import * as fs from "node:fs/promises";

import type { UserInputPart, UserTurnInput } from "@zhixing-ai/core";

import { detectMimeType } from "./input-material-ingest.js";
import {
  createMaterialTokenPattern,
  type InputMaterialEntry,
  type InputMaterialKind,
  type InputMaterialRegistry,
} from "./input-material-registry.js";
import {
  decodeUnclassifiedPlainUtf8Material,
  isSupportedTextMaterialMime,
  isUnclassifiedExtensionlessMaterial,
} from "./plain-text-material.js";

export interface ResolveInputMaterialsOptions {
  readonly maxTextFileSize?: number;
  readonly maxImageSize?: number;
}

export interface ResolveInputMaterialsResult {
  readonly input: UserTurnInput;
  readonly errors: readonly string[];
}

export type InputMaterialTokenLabel = "Image" | "File";

export interface ResolveInputMaterialTokenInput {
  readonly token: string;
  readonly label: InputMaterialTokenLabel;
  readonly id: number;
}

export async function resolveInputMaterials(
  draft: string,
  registry: InputMaterialRegistry,
  options: ResolveInputMaterialsOptions = {},
): Promise<ResolveInputMaterialsResult> {
  const parts: UserInputPart[] = [];
  const errors: string[] = [];
  const matches = Array.from(draft.matchAll(createMaterialTokenPattern()));
  if (matches.length === 0) {
    return { input: { parts: [{ type: "text", text: draft }] }, errors };
  }

  let offset = 0;
  for (const match of matches) {
    const start = match.index!;
    if (start > offset) {
      pushText(parts, draft.slice(offset, start));
    }

    const tokenResult = await resolveInputMaterialToken(
      {
        token: match[0],
        label: match[1] as InputMaterialTokenLabel,
        id: parseInt(match[2]!, 10),
      },
      registry,
      options,
    );
    pushParts(parts, tokenResult.input.parts);
    errors.push(...tokenResult.errors);
    offset = start + match[0].length;
  }

  if (offset < draft.length) {
    pushText(parts, draft.slice(offset));
  }

  return { input: { parts }, errors };
}

export async function resolveInputMaterialToken(
  token: ResolveInputMaterialTokenInput,
  registry: InputMaterialRegistry,
  options: ResolveInputMaterialsOptions = {},
): Promise<ResolveInputMaterialsResult> {
  const parts: UserInputPart[] = [];
  const errors: string[] = [];
  const entry = registry.get(token.id);
  if (
    !entry ||
    token.label !== tokenLabelForKind(entry.kind) ||
    !registry.isKnownToken(token.id, token.token)
  ) {
    pushText(parts, token.token);
    return { input: { parts }, errors };
  }

  await pushMaterial(parts, errors, entry, options);
  return { input: { parts }, errors };
}

async function pushMaterial(
  parts: UserInputPart[],
  errors: string[],
  entry: InputMaterialEntry,
  options: ResolveInputMaterialsOptions,
): Promise<void> {
  const stat = await statLocalFile(entry, errors);
  if (!stat) return;

  if (entry.kind === "image") {
    const maxImageSize = options.maxImageSize ?? 5 * 1024 * 1024;
    if (stat.size > maxImageSize) {
      errors.push(
        `${entry.name} -> 图片过大 (${formatByteSize(stat.size)} > ${formatByteSize(maxImageSize)})`,
      );
      return;
    }
    const bytes = await readLocalFile(entry, errors);
    if (!bytes) return;
    const mimeType = detectMimeType(entry.filePath, bytes);
    if (!mimeType.startsWith("image/")) {
      errors.push(`${entry.name} -> 文件内容不是可识别图片`);
      return;
    }
    parts.push({
      type: "image",
      source: {
        type: "base64",
        mediaType: mimeType,
        data: bytes.toString("base64"),
      },
      name: entry.name,
      mimeType,
      size: stat.size,
    });
    return;
  }

  const maxTextFileSize = options.maxTextFileSize ?? 100 * 1024;

  if (isSupportedTextMaterialMime(entry.mimeType)) {
    if (stat.size > maxTextFileSize) {
      errors.push(
        `${entry.name} -> 文本文件过大 (${formatByteSize(stat.size)} > ${formatByteSize(maxTextFileSize)})`,
      );
      return;
    }

    const content = await readLocalTextFile(entry, errors);
    if (content === null) return;
    pushText(
      parts,
      `<file path="${entry.filePath.replace(/\\/g, "/")}">\n${content}\n</file>`,
    );
    return;
  }

  if (!isUnclassifiedExtensionlessMaterial(entry)) {
    errors.push(
      `${entry.name} -> 当前版本尚不能直接发送 ${entry.mimeType} 文件；请先转成文本、图片，或等待文件解析 / provider 文件能力接入`,
    );
    return;
  }

  if (stat.size > maxTextFileSize) {
    errors.push(
      `${entry.name} -> 文本文件过大 (${formatByteSize(stat.size)} > ${formatByteSize(maxTextFileSize)})`,
    );
    return;
  }

  const bytes = await readBoundedTextFallbackBytes(
    entry,
    stat.size,
    maxTextFileSize,
    errors,
  );
  if (!bytes) return;

  const content = decodeUnclassifiedPlainUtf8Material(entry.filePath, bytes);
  if (content === null) {
    errors.push(
      `${entry.name} -> 当前版本尚不能直接发送 ${entry.mimeType} 文件；请先转成文本、图片，或等待文件解析 / provider 文件能力接入`,
    );
    return;
  }

  pushText(
    parts,
    `<file path="${entry.filePath.replace(/\\/g, "/")}">\n${content}\n</file>`,
  );
}

function tokenLabelForKind(kind: InputMaterialKind): InputMaterialTokenLabel {
  return kind === "image" ? "Image" : "File";
}

async function statLocalFile(
  entry: InputMaterialEntry,
  errors: string[],
): Promise<{ size: number; isFile(): boolean } | null> {
  try {
    const stat = await fs.stat(entry.filePath);
    if (!stat.isFile()) {
      errors.push(`${entry.name} -> 不是普通文件`);
      return null;
    }
    return stat;
  } catch (err) {
    errors.push(`${entry.name} -> 文件不可读取 (${errorMessage(err)})`);
    return null;
  }
}

async function readLocalFile(
  entry: InputMaterialEntry,
  errors: string[],
): Promise<Buffer | null> {
  try {
    return await fs.readFile(entry.filePath);
  } catch (err) {
    errors.push(`${entry.name} -> 文件不可读取 (${errorMessage(err)})`);
    return null;
  }
}

async function readLocalTextFile(
  entry: InputMaterialEntry,
  errors: string[],
): Promise<string | null> {
  try {
    return await fs.readFile(entry.filePath, "utf-8");
  } catch (err) {
    errors.push(`${entry.name} -> 文件不可读取 (${errorMessage(err)})`);
    return null;
  }
}

async function readBoundedTextFallbackBytes(
  entry: InputMaterialEntry,
  expectedSize: number,
  maxBytes: number,
  errors: string[],
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(entry.filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      errors.push(`${entry.name} -> 不是普通文件`);
      return null;
    }
    if (stat.size > maxBytes) {
      errors.push(
        `${entry.name} -> 文本文件过大 (${formatByteSize(stat.size)} > ${formatByteSize(maxBytes)})`,
      );
      return null;
    }

    let buffer = Buffer.allocUnsafe(
      Math.min(Math.max(stat.size, expectedSize) + 1, maxBytes + 1),
    );
    let length = 0;
    while (length <= maxBytes) {
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(buffer.length * 2, maxBytes + 1),
        );
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (read.bytesRead === 0) {
        return buffer.subarray(0, length);
      }
      length += read.bytesRead;
    }

    errors.push(
      `${entry.name} -> 文本文件过大 (${formatByteSize(length)} > ${formatByteSize(maxBytes)})`,
    );
    return null;
  } catch (err) {
    errors.push(`${entry.name} -> 文件不可读取 (${errorMessage(err)})`);
    return null;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function pushText(parts: UserInputPart[], text: string): void {
  if (text.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}

function pushParts(
  parts: UserInputPart[],
  nextParts: readonly UserInputPart[],
): void {
  for (const part of nextParts) {
    if (part.type === "text") {
      pushText(parts, part.text);
    } else {
      parts.push(part);
    }
  }
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
