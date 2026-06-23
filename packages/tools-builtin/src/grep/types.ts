import type {
  GrepResultsDiagnostics,
  GrepResultsLineText,
} from "@zhixing/core";

export type GrepOutputMode = "content" | "files" | "count";
export type GrepRegexDialect = "line-regexp";
export type GrepCaseSensitivity = "sensitive" | "ascii-insensitive";
export type GrepExecutorName = GrepResultsDiagnostics["executor"];
export type GrepCapabilityMode = GrepResultsDiagnostics["capabilityMode"];
export type GrepExecutorUnsupportedReason =
  | "unavailable"
  | "unsupported-regex"
  | "unsupported-file-policy"
  | "unsupported-encoding";

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
  maxMatchedFiles?: number;
  maxMatchedLines?: number;
  timeoutMs?: number;
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

export interface GrepSearchPlan {
  query: GrepQuery;
  absoluteSearchPath: string;
  regexp: CompiledLineRegexp;
}

export type GrepSearchPlanCreation =
  | { ok: true; plan: GrepSearchPlan }
  | { ok: false; error: GrepSearchError };

export type GrepExecutorQualification =
  | {
      executable: true;
      capabilityMode: GrepCapabilityMode;
      notes?: string[];
    }
  | {
      executable: false;
      reason: GrepExecutorUnsupportedReason;
      notes?: string[];
    };

export type GrepSearchExecution =
  | { ok: true; result: GrepSearchResult }
  | { ok: false; error: GrepSearchError };

export type GrepSearchError =
  | { code: "invalid-query"; message: string }
  | { code: "invalid-pattern"; message: string }
  | { code: "path-not-found"; path: string; message: string }
  | { code: "executor-unavailable"; message: string; notes?: string[] }
  | {
      code: "unsupported-query";
      reason: GrepExecutorUnsupportedReason;
      message: string;
      notes?: string[];
    }
  | { code: "timeout"; message: string; elapsedMs?: number }
  | { code: "aborted"; message: string }
  | { code: "internal-error"; message: string };

export interface GrepSearchOptions {
  abortSignal?: AbortSignal;
  maxScannedFiles?: number;
}

export interface GrepSearchExecutor {
  name: GrepExecutorName;
  qualify(plan: GrepSearchPlan): Promise<GrepExecutorQualification>;
  search(
    plan: GrepSearchPlan,
    options?: GrepSearchOptions,
  ): Promise<GrepSearchExecution>;
}
