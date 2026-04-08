/**
 * Glob 工具 — 按模式搜索文件
 *
 * 智能体的"眼睛"：在动手之前先发现项目中有哪些文件。
 *
 * 设计决策：
 * - 基于 npm glob 包（成熟稳定，跨平台）
 * - 自动排除噪音目录（node_modules、.git、dist 等）
 * - 结果按修改时间排序（最近修改最相关，借鉴 Claude Code）
 * - 返回文件大小，帮助 LLM 判断是否需要分段读取
 * - isReadOnly + isParallelSafe：安全且可并行
 */

import { glob } from "glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition, ToolResult } from "@zhixing/core";
import { resolveToolPath } from "./utils.js";

const MAX_RESULTS = 200;
const MAX_RESULT_CHARS = 30_000;

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/vendor/**",
];

export function createGlobTool(): ToolDefinition {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern. " +
      "Returns matching file paths sorted by modification time (most recent first). " +
      "Common directories like node_modules, .git, dist are automatically excluded. " +
      "Use this to discover project structure before reading or editing files.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'Glob pattern to match files. Examples: "**/*.ts", "src/**/*.test.ts", "*.json"',
        },
        path: {
          type: "string",
          description:
            "Directory to search in (relative to working directory or absolute). Default: working directory",
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

      if (!pattern || typeof pattern !== "string") {
        return { content: 'Parameter "pattern" must be a non-empty string.', isError: true };
      }

      try {
        await fs.access(searchPath);
      } catch {
        return { content: `Directory not found: ${searchPath}`, isError: true };
      }

      try {
        const matches = await glob(pattern, {
          cwd: searchPath,
          nodir: true,
          dot: true,
          ignore: DEFAULT_IGNORE,
          absolute: false,
        });

        if (matches.length === 0) {
          return {
            content: `No files found matching pattern "${pattern}" in ${searchPath}`,
          };
        }

        // 获取文件 stat 信息（修改时间 + 大小），用于排序和展示
        const fileInfos = await Promise.all(
          matches.map(async (relativePath) => {
            const fullPath = path.join(searchPath, relativePath);
            try {
              const stat = await fs.stat(fullPath);
              return {
                path: relativePath.replace(/\\/g, "/"),
                size: stat.size,
                mtime: stat.mtimeMs,
              };
            } catch {
              return { path: relativePath.replace(/\\/g, "/"), size: 0, mtime: 0 };
            }
          }),
        );

        // 按修改时间降序排序（最近修改的排在前面）
        fileInfos.sort((a, b) => b.mtime - a.mtime);

        const total = fileInfos.length;
        const truncated = total > MAX_RESULTS;
        const displayed = truncated ? fileInfos.slice(0, MAX_RESULTS) : fileInfos;

        const lines = displayed.map((f) => `${f.path}  (${formatSize(f.size)})`);

        const header = truncated
          ? `Found ${total} files, showing first ${MAX_RESULTS} (sorted by modification time):\n`
          : `Found ${total} file${total === 1 ? "" : "s"}:\n`;

        return { content: header + lines.join("\n") };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Glob search failed: ${msg}`, isError: true };
      }
    },
  };
}

// ─── 内部辅助 ───

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
