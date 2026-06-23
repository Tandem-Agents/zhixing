import type {
  GrepResultsDiagnostics,
  GrepResultsLineText,
} from "@zhixing/core";

export type GrepOutputMode = "content" | "files" | "count";
export type GrepRegexDialect = "line-regexp";
export type GrepCaseSensitivity = "sensitive" | "ascii-insensitive";
export type GrepExecutorName = GrepResultsDiagnostics["executor"];
export type GrepCapabilityMode = GrepResultsDiagnostics["capabilityMode"];

export interface GrepQuery {
  workingDirectory: string;
  pattern: string;
  searchPath: string;
  glob?: string;
  outputMode: GrepOutputMode;
  regexDialect: GrepRegexDialect;
  caseSensitivity: GrepCaseSensitivity;
  contextLines: number;
  maxResultChars: number;
  maxLineChars: number;
}

export interface GrepSearchResult {
  query: GrepQuery;
  files: GrepFileResult[];
  matchedFileCount: number;
  matchedLineCount: number;
  truncated: boolean;
  diagnostics: GrepDiagnostics;
}

export interface GrepFileResult {
  absolutePath: string;
  displayPath: string;
  matches: GrepMatch[];
}

export interface GrepMatch {
  line: number;
  text: GrepLineText;
  contextBefore: GrepContextLine[];
  contextAfter: GrepContextLine[];
}

export interface GrepContextLine {
  line: number;
  text: GrepLineText;
}

export type GrepLineText = GrepResultsLineText;
export type GrepDiagnostics = GrepResultsDiagnostics;

export interface CompiledLineRegexp {
  dialect: "line-regexp";
  originalPattern: string;
  javascriptSource: string;
  ripgrepSource: string;
  caseSensitivity: GrepCaseSensitivity;
  test(line: string): boolean;
}

export interface CompileLineRegexpOptions {
  caseSensitivity?: GrepCaseSensitivity;
}
