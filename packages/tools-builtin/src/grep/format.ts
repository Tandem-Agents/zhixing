import type { ToolResult } from "@zhixing/core";
import type {
  GrepContextLine,
  GrepFileResult,
  GrepLineText,
  GrepMatch,
  GrepSearchError,
  GrepSearchResult,
} from "./types.js";

export function formatGrepToolResult(result: GrepSearchResult): ToolResult {
  const content =
    result.files.length === 0
      ? formatNoMatches(result)
      : formatMatchesByOutputMode(result);

  return { content };
}

export function formatGrepSearchError(error: GrepSearchError): ToolResult {
  return { content: error.message, isError: true };
}

function formatNoMatches(result: GrepSearchResult): string {
  return `No matching lines found for pattern "${result.query.pattern}".`;
}

function formatMatchesByOutputMode(result: GrepSearchResult): string {
  const header = formatHeader(result);
  const body =
    result.query.outputMode === "files"
      ? formatFiles(result.files)
      : result.query.outputMode === "count"
        ? formatCounts(result.files)
        : formatContent(result.files);
  const truncation = result.truncated
    ? "\n\n[truncated: grep result budget reached during collection]"
    : "";

  return `${header}\n\n${body}${truncation}`;
}

function formatHeader(result: GrepSearchResult): string {
  return `Found ${result.matchedLineCount} matching line${result.matchedLineCount === 1 ? "" : "s"} in ${result.matchedFileCount} file${result.matchedFileCount === 1 ? "" : "s"}.`;
}

function formatFiles(files: readonly GrepFileResult[]): string {
  return files.map((file) => file.displayPath).join("\n");
}

function formatCounts(files: readonly GrepFileResult[]): string {
  return files
    .map((file) => `${file.displayPath}:${file.matches.length}`)
    .join("\n");
}

function formatContent(files: readonly GrepFileResult[]): string {
  return files.map(formatFileContent).join("\n\n");
}

function formatFileContent(file: GrepFileResult): string {
  const lines = [`── ${file.displayPath} ──`];
  for (const match of file.matches) {
    lines.push(...formatMatch(match));
  }
  return lines.join("\n");
}

function formatMatch(match: GrepMatch): string[] {
  return [
    ...match.contextBefore.map((line) => formatContextLine(" ", line)),
    formatMatchedLine(match),
    ...match.contextAfter.map((line) => formatContextLine(" ", line)),
  ];
}

function formatMatchedLine(match: GrepMatch): string {
  return `> ${match.line}|${formatLineText(match.text)}`;
}

function formatContextLine(prefix: string, line: GrepContextLine): string {
  return `${prefix} ${line.line}|${formatLineText(line.text)}`;
}

function formatLineText(line: GrepLineText): string {
  if (!line.truncated) return line.text;
  return `${line.text} [line truncated: ${line.omittedScalars} scalar${line.omittedScalars === 1 ? "" : "s"} omitted]`;
}
