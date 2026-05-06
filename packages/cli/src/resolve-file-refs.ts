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

import { expandUserHome } from "@zhixing/core";

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
  // Reset regex lastIndex
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
    return { text: input, resolvedFiles: [], errors: [] };
  }

  // 从后往前替换，避免偏移量错乱
  let result = input;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i]!;
    const absPath = resolveToAbsolute(ref.filePath, options.workspaceRoot);
    let replacement: string;

    try {
      const stat = await fs.stat(absPath);
      if (stat.isDirectory()) {
        replacement = `[目录: ${absPath}]`;
        errors.push(`${ref.full} → 是一个目录，无法读取内容`);
      } else if (stat.size > maxSize) {
        replacement = `[文件过大: ${absPath} (${(stat.size / 1024).toFixed(0)}KB > ${(maxSize / 1024).toFixed(0)}KB)]`;
        errors.push(`${ref.full} → 文件过大`);
      } else {
        const content = await fs.readFile(absPath, "utf-8");
        const fwdPath = absPath.replace(/\\/g, "/");
        replacement = `<file path="${fwdPath}">\n${content}\n</file>`;
        resolvedFiles.push(absPath);
      }
    } catch {
      replacement = `[文件未找到: ${absPath}]`;
      errors.push(`${ref.full} → 文件不存在`);
    }

    result = result.slice(0, ref.start) + replacement + result.slice(ref.end);
  }

  return { text: result, resolvedFiles, errors };
}

// ─── 内部辅助 ───

function resolveToAbsolute(filePath: string, root: string): string {
  const expanded = expandUserHome(filePath);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(root, expanded);
}
