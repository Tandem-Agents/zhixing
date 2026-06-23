import type { GrepResultsPresentationArtifact, ToolResult } from "@zhixing/core";
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

  return {
    content,
    presentation: buildGrepResultsPresentation(result),
  };
}

export function formatGrepSearchError(error: GrepSearchError): ToolResult {
  return { content: error.message, isError: true };
}

function formatNoMatches(result: GrepSearchResult): string {
  return `No matches found for pattern "${result.query.pattern}".`;
}

function buildGrepResultsPresentation(
  result: GrepSearchResult,
): GrepResultsPresentationArtifact {
  return {
    kind: "grep-results",
    query: {
      pattern: result.query.pattern,
      searchPath: result.query.searchPath,
      glob: result.query.glob,
      outputMode: result.query.outputMode,
      regexDialect: result.query.regexDialect,
      caseSensitivity: result.query.caseSensitivity,
      contextLines: result.query.contextLines,
    },
    files: result.files.map((file) => ({
      displayPath: file.displayPath,
      matches: file.matches,
    })),
    matchedFileCount: result.matchedFileCount,
    matchedLineCount: result.matchedLineCount,
    truncated: result.truncated,
    diagnostics: result.diagnostics,
  };
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
  const rows = new Map<
    number,
    { line: number; text: GrepLineText; isMatch: boolean }
  >();

  for (const match of file.matches) {
    for (const line of match.contextBefore) {
      if (!rows.has(line.line)) {
        rows.set(line.line, { ...line, isMatch: false });
      }
    }
    rows.set(match.line, {
      line: match.line,
      text: match.text,
      isMatch: true,
    });
    for (const line of match.contextAfter) {
      if (!rows.has(line.line)) {
        rows.set(line.line, { ...line, isMatch: false });
      }
    }
  }

  for (const row of [...rows.values()].sort((a, b) => a.line - b.line)) {
    lines.push(
      row.isMatch
        ? formatMatchedLine(row)
        : formatContextLine(" ", row),
    );
  }

  return lines.join("\n");
}

function formatMatchedLine(match: Pick<GrepMatch, "line" | "text">): string {
  return `> ${match.line}|${formatLineText(match.text)}`;
}

function formatContextLine(prefix: string, line: GrepContextLine): string {
  return `${prefix} ${line.line}|${formatLineText(line.text)}`;
}

function formatLineText(line: GrepLineText): string {
  if (!line.truncated) return line.text;
  return `${line.text} [line truncated: ${line.omittedScalars} scalar${line.omittedScalars === 1 ? "" : "s"} omitted]`;
}
