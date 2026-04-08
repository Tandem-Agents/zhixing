/**
 * Edit 工具 — 精确字符串替换
 *
 * 智能体最核心的代码修改能力。与 Write（全量覆盖）不同，
 * Edit 只替换文件中的特定片段，保留其余内容不变。
 *
 * 设计决策（详见 research/design/specifications/phase2-complete-agent.md）：
 * - 精确字符串匹配，不支持正则（安全性和可预测性优先）
 * - 三态匹配检查：零匹配/单匹配/多重匹配，各有明确的错误反馈
 * - replace_all 模式：批量替换，解决变量重命名等高频需求
 * - 错误信息即教程：告诉 LLM 怎么修正，而非仅说"失败了"
 *
 * 对比 Claude Code str_replace：
 * - 多重匹配时报告具体行号，帮助 LLM 缩小范围
 * - 支持 replace_all（Claude Code 必须多次调用或用 Bash sed）
 */

import * as fs from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import { resolveToolPath } from "./utils.js";

const MAX_RESULT_CHARS = 5_000;

export function createEditTool(): ToolDefinition {
  return {
    name: "edit",
    description:
      "Make a targeted edit to a file by replacing a specific string with a new string. " +
      "The old_string must match EXACTLY (including whitespace and indentation). " +
      "To delete text, provide an empty new_string. " +
      "To rename a variable or replace all occurrences, set replace_all to true. " +
      "IMPORTANT: Always read the file first to get the exact text you want to replace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to edit (relative to working directory or absolute)",
        },
        old_string: {
          type: "string",
          description:
            "The exact string to find in the file. Must match precisely, " +
            "including all whitespace, indentation, and newlines.",
        },
        new_string: {
          type: "string",
          description:
            "The replacement string. Use empty string to delete the matched text.",
        },
        replace_all: {
          type: "boolean",
          description:
            "If true, replace ALL occurrences of old_string. " +
            "Default: false (requires exactly one match).",
        },
      },
      required: ["path", "old_string", "new_string"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input, context): Promise<ToolResult> {
      const filePath = resolveToolPath(input.path as string, context.workingDirectory);
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = input.replace_all === true;

      if (typeof oldString !== "string") {
        return { content: 'Parameter "old_string" must be a string.', isError: true };
      }
      if (oldString === "") {
        return { content: 'Parameter "old_string" must not be empty.', isError: true };
      }
      if (typeof newString !== "string") {
        return { content: 'Parameter "new_string" must be a string.', isError: true };
      }
      if (oldString === newString) {
        return { content: "old_string and new_string are identical. No changes needed.", isError: true };
      }

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `File not found: ${filePath}`, isError: true };
        }
        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          return { content: `Permission denied: ${filePath}`, isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to read file: ${msg}`, isError: true };
      }

      const matchPositions = findAllMatches(content, oldString);

      // ── 零匹配 ──
      if (matchPositions.length === 0) {
        return {
          content: buildNoMatchError(filePath, content, oldString),
          isError: true,
        };
      }

      // ── 多重匹配 + replace_all=false ──
      if (matchPositions.length > 1 && !replaceAll) {
        const lineNumbers = matchPositions.map((pos) => getLineNumber(content, pos));
        return {
          content: buildMultipleMatchError(filePath, matchPositions.length, lineNumbers, oldString),
          isError: true,
        };
      }

      // ── 执行替换 ──
      const matchCount = matchPositions.length;
      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : content.slice(0, matchPositions[0]!) + newString + content.slice(matchPositions[0]! + oldString.length);

      try {
        await fs.writeFile(filePath, newContent, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          return { content: `Permission denied: ${filePath}`, isError: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to write file: ${msg}`, isError: true };
      }

      const verb = newString === "" ? "Deleted" : "Replaced";
      const countInfo = matchCount > 1 ? ` (${matchCount} occurrences)` : "";

      return {
        content: `${verb} text in ${filePath}${countInfo}`,
      };
    },
  };
}

// ─── 内部辅助 ───

/**
 * 找到所有匹配的起始位置。
 * 不用正则，直接字符串搜索——避免特殊字符转义问题。
 */
function findAllMatches(content: string, searchStr: string): number[] {
  const positions: number[] = [];
  let startIndex = 0;

  while (true) {
    const index = content.indexOf(searchStr, startIndex);
    if (index === -1) break;
    positions.push(index);
    startIndex = index + searchStr.length;
  }

  return positions;
}

/** 根据字符偏移量计算行号（1-based） */
function getLineNumber(content: string, charOffset: number): number {
  let line = 1;
  for (let i = 0; i < charOffset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * 构建零匹配的错误信息。
 * 显示文件前几行，引导 LLM 先用 read 工具查看文件。
 */
function buildNoMatchError(filePath: string, content: string, oldString: string): string {
  const totalLines = content.split("\n").length;
  const previewLines = content.split("\n").slice(0, 5);
  const preview = previewLines
    .map((line, i) => `  ${i + 1}|${line}`)
    .join("\n");

  const snippetPreview = oldString.length > 80
    ? `${oldString.slice(0, 80)}...`
    : oldString;

  return [
    `The specified old_string was not found in ${filePath}.`,
    ``,
    `Searched for:`,
    `  "${snippetPreview}"`,
    ``,
    `File has ${totalLines} lines. First ${previewLines.length} lines:`,
    preview,
    ``,
    `Suggestion: Use the read tool to view the file and copy the exact text you want to replace.`,
  ].join("\n");
}

/**
 * 构建多重匹配的错误信息。
 * 报告匹配数和具体行号，帮助 LLM 添加更多上下文使匹配唯一。
 */
function buildMultipleMatchError(
  filePath: string,
  matchCount: number,
  lineNumbers: number[],
  oldString: string,
): string {
  const displayLines = lineNumbers.length > 10
    ? `${lineNumbers.slice(0, 10).join(", ")}... and ${lineNumbers.length - 10} more`
    : lineNumbers.join(", ");

  const snippetPreview = oldString.length > 60
    ? `${oldString.slice(0, 60)}...`
    : oldString;

  return [
    `Found ${matchCount} matches for the specified old_string in ${filePath}.`,
    ``,
    `Matched text: "${snippetPreview}"`,
    `Matches at lines: ${displayLines}`,
    ``,
    `To fix, either:`,
    `  1. Include more surrounding context in old_string to make it unique`,
    `  2. Set replace_all=true to replace all ${matchCount} occurrences`,
  ].join("\n");
}
