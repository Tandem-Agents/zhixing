/**
 * Write 工具 — 创建或覆盖文件
 *
 * 智能体最基础的行动能力：产生实际输出。
 *
 * 设计要点：
 * - 自动创建父目录（mkdir -p 语义）
 * - 覆盖写入，不是追加
 * - needsPermission: true — 写入操作默认需要确认
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import { resolveToolPath } from "./utils.js";

export function createWriteTool(): ToolDefinition {
  return {
    name: "write",
    description:
      "Create or overwrite a file with the given content. " +
      "Parent directories are created automatically if they don't exist. " +
      "IMPORTANT: This completely replaces the file content. To make targeted edits, prefer using bash with sed or similar.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to write (relative to working directory or absolute)",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["path", "content"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    maxResultChars: 1_000,

    async call(input, context): Promise<ToolResult> {
      const filePath = resolveToolPath(input.path as string, context.workingDirectory);
      const content = input.content as string;

      if (typeof content !== "string") {
        return { content: 'Parameter "content" must be a string.', isError: true };
      }

      try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(filePath, content, "utf-8");

        const lineCount = content.split("\n").length;
        return {
          content: `Successfully wrote ${content.length} chars (${lineCount} lines) to ${filePath}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if ((err as NodeJS.ErrnoException).code === "EACCES") {
          return { content: `Permission denied: ${filePath}`, isError: true };
        }

        return { content: `Failed to write file: ${message}`, isError: true };
      }
    },
  };
}
