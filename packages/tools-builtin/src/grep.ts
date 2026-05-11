/**
 * Grep 工具 — 按内容搜索文件
 *
 * 智能体的"搜索引擎"：找到代码中特定符号、字符串、模式的位置。
 *
 * 设计决策：
 * - 双引擎：优先 ripgrep（子进程），不可用时自动降级到 Node.js 内置
 * - 三种输出模式：content（默认，显示匹配行）、files（仅文件路径）、count（匹配数）
 * - 默认 2 行上下文（比 Claude Code 的 0 行更实用）
 * - glob 过滤：限定搜索范围（如 "*.ts"）
 * - 大小保护：output 超长自动截断
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import { resolveToolPath } from "./utils.js";

const execFileAsync = promisify(execFile);

const MAX_RESULT_CHARS = 30_000;
const MAX_FILES_SCANNED = 10_000;
const DEFAULT_CONTEXT_LINES = 2;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  ".nuxt", "coverage", "__pycache__", ".venv", "vendor",
]);

type OutputMode = "content" | "files" | "count";

export function createGrepTool(): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search file contents using regex patterns. " +
      "Returns matching lines with context. Supports file filtering via glob patterns. " +
      "Use output_mode='files' to get only file paths, or 'count' for match counts. " +
      "Use this to find function definitions, variable usages, imports, etc.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for (JavaScript regex syntax)",
        },
        path: {
          type: "string",
          description:
            "File or directory to search in (relative to working directory or absolute). Default: working directory",
        },
        glob: {
          type: "string",
          description:
            'Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}"). Only files matching this pattern will be searched.',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files", "count"],
          description:
            'Output mode: "content" shows matching lines with context (default), ' +
            '"files" shows only file paths containing matches, ' +
            '"count" shows match count per file.',
        },
        context_lines: {
          type: "number",
          description:
            "Number of context lines to show before and after each match (default: 2). Only used with output_mode=content.",
        },
      },
      required: ["pattern"],
    },

    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input, context): Promise<ToolResult> {
      const pattern = input.pattern as string;
      const searchPath = input.path
        ? resolveToolPath(input.path as string, context.workingDirectory)
        : context.workingDirectory;
      const globFilter = (input.glob as string) || undefined;
      const outputMode = (input.output_mode as OutputMode) || "content";
      const contextLines = typeof input.context_lines === "number"
        ? Math.max(0, Math.min(input.context_lines, 10))
        : DEFAULT_CONTEXT_LINES;

      if (!pattern || typeof pattern !== "string") {
        return { content: 'Parameter "pattern" must be a non-empty string.', isError: true };
      }

      // 校验正则合法性
      try {
        new RegExp(pattern);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Invalid regex pattern: ${msg}`, isError: true };
      }

      // 优先尝试 ripgrep
      const rgResult = await tryRipgrep(pattern, searchPath, globFilter, outputMode, contextLines);
      if (rgResult !== null) {
        return rgResult;
      }

      // 降级到 Node.js 内置搜索
      return nodeGrep(pattern, searchPath, globFilter, outputMode, contextLines);
    },
  };
}

// ─── ripgrep 引擎 ───

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  outputMode: OutputMode,
  contextLines: number,
): Promise<ToolResult | null> {
  try {
    const args: string[] = ["--no-heading", "--line-number", "--color=never"];

    if (outputMode === "files") {
      args.push("--files-with-matches");
    } else if (outputMode === "count") {
      args.push("--count");
    } else {
      args.push(`-C${contextLines}`);
    }

    if (globFilter) {
      args.push("--glob", globFilter);
    }

    // 自动排除噪音目录
    for (const dir of IGNORE_DIRS) {
      args.push("--glob", `!${dir}`);
    }

    args.push("--", pattern, searchPath);

    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: MAX_RESULT_CHARS * 2,
      timeout: 30_000,
    });

    return formatOutput(stdout, outputMode, pattern);
  } catch (err: any) {
    // exit code 1 = no matches（正常情况）
    if (err.code === 1 && err.stdout !== undefined) {
      return { content: `No matches found for pattern "${pattern}"` };
    }
    // exit code 2 = error / ripgrep not found
    if (err.code === "ENOENT" || err.code === 127) {
      return null;
    }
    // 其他未知错误也降级
    return null;
  }
}

// ─── Node.js 内置引擎 ───

interface FileMatch {
  file: string;
  matches: { line: number; text: string }[];
}

async function nodeGrep(
  pattern: string,
  searchPath: string,
  globFilter: string | undefined,
  outputMode: OutputMode,
  contextLines: number,
): Promise<ToolResult> {
  const regex = new RegExp(pattern, "gm");

  let stat;
  try {
    stat = await fs.stat(searchPath);
  } catch {
    return { content: `Path not found: ${searchPath}`, isError: true };
  }

  const fileMatches: FileMatch[] = [];
  let totalOutputChars = 0;
  let truncated = false;

  // 将 glob filter 转换为简单的扩展名匹配
  const extFilter = globFilter ? parseGlobExtensions(globFilter) : null;

  if (stat.isFile()) {
    const match = await searchFile(searchPath, regex);
    if (match) {
      fileMatches.push({ file: searchPath, matches: match });
    }
  } else {
    await walkDirectory(searchPath, async (filePath) => {
      if (truncated) return;
      if (extFilter && !matchesExtFilter(filePath, extFilter)) return;

      const match = await searchFile(filePath, regex);
      if (match) {
        fileMatches.push({ file: path.relative(searchPath, filePath).replace(/\\/g, "/"), matches: match });
      }
    });
  }

  if (fileMatches.length === 0) {
    return { content: `No matches found for pattern "${pattern}"` };
  }

  // 格式化输出
  const lines: string[] = [];

  if (outputMode === "files") {
    for (const fm of fileMatches) {
      lines.push(fm.file);
    }
  } else if (outputMode === "count") {
    for (const fm of fileMatches) {
      lines.push(`${fm.file}:${fm.matches.length}`);
    }
  } else {
    for (const fm of fileMatches) {
      if (totalOutputChars > MAX_RESULT_CHARS) {
        truncated = true;
        break;
      }

      lines.push(`── ${fm.file} ──`);

      // 从文件读取内容以展示上下文行
      let fileLines: string[] | null = null;
      if (contextLines > 0) {
        try {
          const content = await fs.readFile(
            path.isAbsolute(fm.file) ? fm.file : path.join(searchPath, fm.file),
            "utf-8",
          );
          fileLines = content.split("\n");
        } catch {
          fileLines = null;
        }
      }

      const displayedLineRanges = new Set<string>();

      for (const m of fm.matches) {
        if (fileLines && contextLines > 0) {
          const startLine = Math.max(1, m.line - contextLines);
          const endLine = Math.min(fileLines.length, m.line + contextLines);
          const rangeKey = `${startLine}-${endLine}`;

          if (!displayedLineRanges.has(rangeKey)) {
            displayedLineRanges.add(rangeKey);
            for (let i = startLine; i <= endLine; i++) {
              const prefix = i === m.line ? ">" : " ";
              const lineContent = `${prefix} ${i}|${fileLines[i - 1]}`;
              lines.push(lineContent);
              totalOutputChars += lineContent.length;
            }
            lines.push("");
          }
        } else {
          const lineContent = `${m.line}:${m.text}`;
          lines.push(lineContent);
          totalOutputChars += lineContent.length;
        }
      }
    }
  }

  let output = lines.join("\n");
  if (truncated) {
    output += `\n\n[truncated: output exceeded ${MAX_RESULT_CHARS.toLocaleString()} chars]`;
  }

  const totalMatches = fileMatches.reduce((sum, fm) => sum + fm.matches.length, 0);
  const header = `Found ${totalMatches} match${totalMatches === 1 ? "" : "es"} in ${fileMatches.length} file${fileMatches.length === 1 ? "" : "s"}:\n\n`;

  return { content: header + output };
}

// ─── 辅助函数 ───

async function searchFile(filePath: string, regex: RegExp): Promise<{ line: number; text: string }[] | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");

    // 跳过二进制文件
    if (content.includes("\0")) return null;

    const lines = content.split("\n");
    const matches: { line: number; text: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      // 重置 regex 的 lastIndex，避免全局匹配的状态问题
      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) {
        matches.push({ line: i + 1, text: lines[i]! });
      }
    }

    return matches.length > 0 ? matches : null;
  } catch {
    return null;
  }
}

async function walkDirectory(
  dir: string,
  callback: (filePath: string) => Promise<void>,
  filesScanned = { count: 0 },
): Promise<void> {
  if (filesScanned.count >= MAX_FILES_SCANNED) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (filesScanned.count >= MAX_FILES_SCANNED) return;

    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(fullPath, callback, filesScanned);
    } else if (entry.isFile()) {
      filesScanned.count++;
      await callback(fullPath);
    }
  }
}

/**
 * 解析 glob filter 中的扩展名列表。
 * 支持 "*.ts"、"*.{ts,tsx}"、"*.ts,*.tsx" 格式。
 */
function parseGlobExtensions(globFilter: string): string[] {
  const extensions: string[] = [];

  // "*.{ts,tsx}" -> ["ts", "tsx"]
  const braceMatch = globFilter.match(/\*\.?\{([^}]+)\}/);
  if (braceMatch) {
    extensions.push(...braceMatch[1]!.split(",").map((ext) => `.${ext.trim()}`));
    return extensions;
  }

  // "*.ts" 或 "*.ts,*.tsx" 格式
  const parts = globFilter.split(",");
  for (const part of parts) {
    const extMatch = part.trim().match(/\*\.(.+)/);
    if (extMatch) {
      extensions.push(`.${extMatch[1]!.trim()}`);
    }
  }

  return extensions;
}

function matchesExtFilter(filePath: string, extensions: string[]): boolean {
  if (extensions.length === 0) return true;
  return extensions.some((ext) => filePath.endsWith(ext));
}

function formatOutput(stdout: string, outputMode: OutputMode, pattern: string): ToolResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { content: `No matches found for pattern "${pattern}"` };
  }

  let output = trimmed;
  if (output.length > MAX_RESULT_CHARS) {
    output = output.slice(0, MAX_RESULT_CHARS);
    output += `\n\n[truncated: output exceeded ${MAX_RESULT_CHARS.toLocaleString()} chars]`;
  }

  if (outputMode === "files") {
    const fileCount = output.split("\n").length;
    return { content: `Found matches in ${fileCount} file${fileCount === 1 ? "" : "s"}:\n\n${output}` };
  }
  if (outputMode === "count") {
    return { content: `Match counts:\n\n${output}` };
  }

  return { content: output };
}
