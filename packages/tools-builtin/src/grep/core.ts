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
export type {
  CompiledLineRegexp,
  CompileLineRegexpOptions,
  GrepCapabilityMode,
  GrepCaseSensitivity,
  GrepContextLine,
  GrepDiagnostics,
  GrepExecutorName,
  GrepFileResult,
  GrepLineText,
  GrepMatch,
  GrepOutputMode,
  GrepQuery,
  GrepRegexDialect,
  GrepSearchResult,
} from "./types.js";
