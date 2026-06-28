import type {
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";
import {
  executeGrepSearch,
  formatGrepSearchError,
  formatGrepToolResult,
  type GrepCaseSensitivity,
  type GrepOutputMode,
  type GrepQuery,
} from "./grep/core.js";

const MAX_RESULT_CHARS = 30_000;
const MAX_LINE_CHARS = 500;
const MAX_MATCHED_FILES = 200;
const MAX_MATCHED_LINES = 1_000;
const MAX_SCANNED_FILES = 10_000;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const GREP_SYSTEM_PROMPT_HINTS: readonly string[] = [
  "- Use `grep` to search file contents by regex, not bash grep/rg",
];

export function createGrepTool(): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search file contents using portable line-regexp patterns. " +
      "Returns matching lines with optional context and supports glob filtering. " +
      "Use output_mode='files' to list matching files, output_mode='count' for matched line counts, " +
      "and case_sensitivity='ascii-insensitive' for ASCII-only case-insensitive search.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Portable line-regexp pattern to search for. Supports literals, groups, alternation, common quantifiers, ASCII \\w/\\d/\\s/\\b, ^ and $ within a logical line.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search in, relative to the working directory or absolute. Defaults to the working directory.",
        },
        glob: {
          type: "string",
          description:
            'Glob pattern to filter files during directory searches, for example "*.ts", "*.{ts,tsx}", or "src/**/*.ts".',
        },
        output_mode: {
          type: "string",
          enum: ["content", "files", "count"],
          description:
            'Output mode: "content" shows matching lines with context, "files" shows matching file paths, "count" shows matched line counts.',
          default: "content",
        },
        case_sensitivity: {
          type: "string",
          enum: ["sensitive", "ascii-insensitive"],
          description:
            'Case sensitivity: "sensitive" by default, or "ascii-insensitive" for ASCII-only case folding.',
          default: "sensitive",
        },
        context_lines: {
          type: "number",
          description:
            "Number of context lines to show before and after each match. Defaults to 2 and is capped at 10.",
          default: DEFAULT_CONTEXT_LINES,
        },
      },
      required: ["pattern"],
    },

    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    systemPromptHints: GREP_SYSTEM_PROMPT_HINTS,
    maxResultChars: MAX_RESULT_CHARS,

    async call(input, context): Promise<ToolResult> {
      const queryOrError = buildGrepQuery(input, context.workingDirectory);
      if ("content" in queryOrError) return queryOrError;

      const execution = await executeGrepSearch(queryOrError, {
        abortSignal: context.abortSignal,
        maxScannedFiles: MAX_SCANNED_FILES,
      });
      if (!execution.ok) return formatGrepSearchError(execution.error);

      return formatGrepToolResult(execution.result);
    },
  };
}

function buildGrepQuery(
  input: Record<string, unknown>,
  workingDirectory: string,
): GrepQuery | ToolResult {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return {
      content: 'Parameter "pattern" must be a non-empty string.',
      isError: true,
    };
  }

  const pathValue = input.path;
  if (pathValue !== undefined && typeof pathValue !== "string") {
    return { content: 'Parameter "path" must be a string.', isError: true };
  }

  const globValue = input.glob;
  if (globValue !== undefined && typeof globValue !== "string") {
    return { content: 'Parameter "glob" must be a string.', isError: true };
  }

  const outputMode = parseOutputMode(input.output_mode);
  if (outputMode === null) {
    return {
      content: 'Parameter "output_mode" must be "content", "files", or "count".',
      isError: true,
    };
  }

  const caseSensitivity = parseCaseSensitivity(input.case_sensitivity);
  if (caseSensitivity === null) {
    return {
      content:
        'Parameter "case_sensitivity" must be "sensitive" or "ascii-insensitive".',
      isError: true,
    };
  }

  const contextLines = parseContextLines(input.context_lines);
  if (contextLines === null) {
    return {
      content: 'Parameter "context_lines" must be a finite number.',
      isError: true,
    };
  }

  return {
    workingDirectory,
    pattern: input.pattern,
    searchPath: pathValue === undefined || pathValue === "" ? "." : pathValue,
    glob: globValue === "" ? undefined : globValue,
    outputMode,
    regexDialect: "line-regexp",
    caseSensitivity,
    contextLines,
    maxResultChars: MAX_RESULT_CHARS,
    maxLineChars: MAX_LINE_CHARS,
    maxMatchedFiles: MAX_MATCHED_FILES,
    maxMatchedLines: MAX_MATCHED_LINES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function parseOutputMode(value: unknown): GrepOutputMode | null {
  if (value === undefined) return "content";
  if (value === "content" || value === "files" || value === "count") {
    return value;
  }
  return null;
}

function parseCaseSensitivity(value: unknown): GrepCaseSensitivity | null {
  if (value === undefined) return "sensitive";
  if (value === "sensitive" || value === "ascii-insensitive") return value;
  return null;
}

function parseContextLines(value: unknown): number | null {
  if (value === undefined) return DEFAULT_CONTEXT_LINES;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(MAX_CONTEXT_LINES, Math.trunc(value)));
}
