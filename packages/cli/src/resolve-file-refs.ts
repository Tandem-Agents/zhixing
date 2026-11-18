/**
 * resolveFileRefs — 解析用户消息中的 @file:path 引用
 *
 * 在 REPL 提交前调用。把 `@file:path` 替换成文件内容，让 agent
 * 不需要自己猜路径。
 *
 * 示例：
 *   输入: "@file:src/index.ts 这个文件有什么问题"
 *   输出: "<file path=\"D:/ZhixingWorkspace/src/index.ts\">\nexport function main() ...\n</file>\n这个文件有什么问题"
 *
 * 设计要点：
 *   - 基于 workspace root 解析相对路径（和 FileProvider 一致）
 *   - 支持 ~/ 和绝对路径
 *   - 文件不存在时保留原文并附加警告
 *   - 不修改非 @file: 的文本
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createTextFileMaterial, type UserInputPart } from "@zhixing-ai/core";
import { expandUserHome } from "@zhixing-ai/core/paths";

// ─── @file:path 匹配正则 ───

/**
 * 匹配 @file:path 引用。
 * path 部分可包含：字母、数字、下划线、连字符、点、斜杠、波浪号、冒号（Windows 盘符）。
 * 必须以非空白字符结尾。
 */
const FILE_REF_RE = /(@file:)([\p{L}\p{N}_\-.\/~:][^\s]*)/gu;

// ─── 公开 API ───

export interface ResolveFileRefsOptions {
  /** 工作区根目录（绝对路径） */
  readonly workspaceRoot: string;
  /** 单个文件最大读取字节数（防止注入巨型文件）。默认 100KB */
  readonly maxFileSize?: number;
}

export interface ResolveResult {
  /** 处理后的文本 */
  readonly text: string;
  /** 结构化输入分段（成功读取的文件引用作为独立带 material 的文本 part，不与普通文本合并） */
  readonly parts?: readonly UserInputPart[];
  /** 成功解析的文件路径（绝对路径） */
  readonly resolvedFiles: readonly string[];
  /** 解析失败的引用（文件不存在等） */
  readonly errors: readonly string[];
}

/**
 * 解析文本中所有 `@file:path` 引用，替换成文件内容的 XML 标签。
 *
 * 调用方式：在构造 user message 之前调用。
 */
export async function resolveFileRefs(
  input: string,
  options: ResolveFileRefsOptions,
): Promise<ResolveResult> {
  const maxSize = options.maxFileSize ?? 100 * 1024;
  const resolvedFiles: string[] = [];
  const errors: string[] = [];

  // 收集所有 @file:path 引用
  const refs: Array<{ full: string; filePath: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(input)) !== null) {
    refs.push({
      full: m[0],
      filePath: m[2]!,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (refs.length === 0) {
    return {
      text: input,
      parts: input.length > 0 ? [{ type: "text", text: input }] : [],
      resolvedFiles: [],
      errors: [],
    };
  }

  const parts: UserInputPart[] = [];
  let text = "";
  let offset = 0;

  for (const ref of refs) {
    if (ref.start > offset) {
      const slice = input.slice(offset, ref.start);
      text += slice;
      pushPlainText(parts, slice);
    }

    const absPath = resolveToAbsolute(ref.filePath, options.workspaceRoot);
    let replacement: string;
    let fileMaterial: ReturnType<typeof createTextFileMaterial> | undefined;

    try {
      const stat = await fs.stat(absPath);
      if (stat.isDirectory()) {
        replacement = `[目录: ${absPath}]`;
        errors.push(`${ref.full} → 是一个目录，无法读取内容`);
      } else if (stat.size > maxSize) {
        replacement = `[文件过大: ${absPath} (${(stat.size / 1024).toFixed(0)}KB > ${(maxSize / 1024).toFixed(0)}KB)]`;
        errors.push(`${ref.full} → 文件过大`);
      } else {
        const bytes = await readBoundedBytes(absPath, maxSize);
        if ("tooLarge" in bytes) {
          replacement = `[文件过大: ${absPath} (${(bytes.tooLarge / 1024).toFixed(0)}KB > ${(maxSize / 1024).toFixed(0)}KB)]`;
          errors.push(`${ref.full} → 文件过大`);
        } else {
          const content = bytes.buffer.toString("utf-8");
          const fwdPath = absPath.replace(/\\/g, "/");
          replacement = `<file path="${fwdPath}">\n${content}\n</file>`;
          fileMaterial = createTextFileMaterial(path.basename(absPath), bytes.buffer.byteLength);
          resolvedFiles.push(absPath);
        }
      }
    } catch {
      replacement = `[文件未找到: ${absPath}]`;
      errors.push(`${ref.full} → 文件不存在`);
    }

    text += replacement;
    if (fileMaterial) {
      parts.push({ type: "text", text: replacement, material: fileMaterial });
    } else {
      pushPlainText(parts, replacement);
    }
    offset = ref.end;
  }

  if (offset < input.length) {
    const tail = input.slice(offset);
    text += tail;
    pushPlainText(parts, tail);
  }

  return { text, parts, resolvedFiles, errors };
}

// ─── 内部辅助 ───

async function readBoundedBytes(
  absPath: string,
  maxBytes: number,
): Promise<{ readonly buffer: Buffer } | { readonly tooLarge: number }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    if (stat.size > maxBytes) {
      return { tooLarge: stat.size };
    }
    let buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length <= maxBytes) {
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) {
        return { buffer: buffer.subarray(0, length) };
      }
      length += read.bytesRead;
    }
    return { tooLarge: length };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function pushPlainText(parts: UserInputPart[], text: string): void {
  if (text.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text" && !last.material) {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}

function resolveToAbsolute(filePath: string, root: string): string {
  const expanded = expandUserHome(filePath);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(root, expanded);
}
