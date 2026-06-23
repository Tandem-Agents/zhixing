export {
  comparePosixPathByCodePoint,
  sortGrepFiles,
  toDisplayPath,
} from "./paths.js";
export {
  countUnicodeScalars,
  decodeGrepFileBytes,
  splitLogicalLines,
  toGrepLineText,
  type DecodedGrepText,
  type GrepTextEncoding,
} from "./text.js";
export {
  LineRegexpSyntaxError,
  compileLineRegexp,
} from "./line-regexp.js";
export { createGrepSearchPlan } from "./plan.js";
export { nodeGrepSearchExecutor } from "./node-executor.js";
export {
  isRipgrepAvailable,
  ripgrepSearchExecutor,
} from "./ripgrep-executor.js";
export { executeGrepSearch } from "./search.js";
export {
  formatGrepSearchError,
  formatGrepToolResult,
} from "./format.js";
export type {
  CompiledLineRegexp,
  CompileLineRegexpOptions,
  GrepCapabilityMode,
  GrepCaseSensitivity,
  GrepContextLine,
  GrepDiagnostics,
  GrepExecutorName,
  GrepExecutorQualification,
  GrepExecutorUnsupportedReason,
  GrepFileResult,
  GrepLineText,
  GrepMatch,
  GrepOutputMode,
  GrepQuery,
  GrepRegexDialect,
  GrepSearchError,
  GrepSearchExecution,
  GrepSearchExecutor,
  GrepSearchOptions,
  GrepSearchPlan,
  GrepSearchPlanCreation,
  GrepSearchResult,
} from "./types.js";
export type { ExecuteGrepSearchOptions } from "./search.js";
