/**
 * Read 工具 — 读取文件内容
 *
 * 智能体最基础的感知能力：理解代码和文档的前提。
 *
 * 设计要点：
 * - 输出带行号，方便 LLM 引用具体行
 * - 支持 offset/limit 做分段读取（大文件友好）
 * - 二进制文件检测，避免返回乱码
 * - isReadOnly + isParallelSafe：安全且可并行
 */

import * as fs from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import { addLineNumbers, isBinaryContent, resolveToolPath } from "./utils.js";

const MAX_RESULT_CHARS = 50_000;
const READ_SYSTEM_PROMPT_HINTS: readonly string[] = [
  "- Use `read` to view file contents, not bash cat/head/tail",
];

export function createReadTool(): ToolDefinition {
  return {
    name: "read",
    description:
      "Read the contents of a file. Output includes line numbers for reference. " +
      "Use `offset` and `limit` for partial reads of large files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to read (relative to working directory or absolute)",
        },
        offset: {
          type: "number",
          description: "Start reading from this line number (1-based). Default: 1",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read. Default: all lines",
        },
      },
      required: ["path"],
    },

    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    systemPromptHints: READ_SYSTEM_PROMPT_HINTS,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input, context): Promise<ToolResult> {
      const filePath = resolveToolPath(input.path as string, context.workingDirectory);
      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : undefined;

      try {
        const buffer = await fs.readFile(filePath);

        if (isBinaryContent(buffer)) {
          return {
            content: `File "${filePath}" appears to be binary (${buffer.length} bytes). Cannot display binary content.`,
            isError: true,
          };
        }

        const fullContent = buffer.toString("utf-8");
        const lines = fullContent.split("\n");
        const totalLines = lines.length;

        const startIdx = offset - 1;
        const endIdx = limit ? Math.min(startIdx + limit, totalLines) : totalLines;
        const selectedLines = lines.slice(startIdx, endIdx);

        const numbered = addLineNumbers(selectedLines.join("\n"), offset);

        const meta: string[] = [];
        if (offset > 1 || limit) {
          meta.push(`Showing lines ${offset}-${startIdx + selectedLines.length} of ${totalLines} total`);
        }

        const content = meta.length > 0 ? `${meta.join(" | ")}\n\n${numbered}` : numbered;

        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `File not found: ${filePath}`, isError: true };
        }
        if ((err as NodeJS.ErrnoException).code === "EISDIR") {
          return { content: `"${filePath}" is a directory, not a file.`, isError: true };
        }
        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          return { content: `Permission denied: ${filePath}`, isError: true };
        }

        return { content: `Failed to read file: ${message}`, isError: true };
      }
    },
  };
}
