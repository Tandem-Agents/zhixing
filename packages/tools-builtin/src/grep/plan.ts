import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileLineRegexp, LineRegexpSyntaxError } from "./line-regexp.js";
import type {
  GrepCaseSensitivity,
  GrepOutputMode,
  GrepQuery,
  GrepRegexDialect,
  GrepSearchError,
  GrepSearchPlanCreation,
} from "./types.js";

const OUTPUT_MODES: readonly GrepOutputMode[] = ["content", "files", "count"];
const CASE_SENSITIVITY_MODES: readonly GrepCaseSensitivity[] = [
  "sensitive",
  "ascii-insensitive",
];
const REGEX_DIALECTS: readonly GrepRegexDialect[] = ["line-regexp"];

export async function createGrepSearchPlan(
  query: GrepQuery,
): Promise<GrepSearchPlanCreation> {
  const queryError = validateGrepQuery(query);
  if (queryError !== null) return { ok: false, error: queryError };

  const absoluteSearchPath = resolveSearchPath(
    query.searchPath,
    query.workingDirectory,
  );

  try {
    await fs.access(absoluteSearchPath);
  } catch {
    return {
      ok: false,
      error: {
        code: "path-not-found",
        path: absoluteSearchPath,
        message: `Path not found: ${absoluteSearchPath}`,
      },
    };
  }

  try {
    return {
      ok: true,
      plan: {
        query,
        absoluteSearchPath,
        regexp: compileLineRegexp(query.pattern, {
          caseSensitivity: query.caseSensitivity,
        }),
      },
    };
  } catch (err) {
    if (err instanceof LineRegexpSyntaxError) {
      return {
        ok: false,
        error: { code: "invalid-pattern", message: err.message },
      };
    }
    throw err;
  }
}

function resolveSearchPath(searchPath: string, workingDirectory: string): string {
  if (path.isAbsolute(searchPath)) return path.normalize(searchPath);
  return path.resolve(workingDirectory, searchPath);
}

function validateGrepQuery(query: GrepQuery): GrepSearchError | null {
  if (typeof query.pattern !== "string" || query.pattern.length === 0) {
    return {
      code: "invalid-query",
      message: 'Grep query requires a non-empty "pattern".',
    };
  }

  if (!REGEX_DIALECTS.includes(query.regexDialect)) {
    return {
      code: "unsupported-query",
      reason: "unsupported-regex",
      message: `Unsupported grep regex dialect: ${query.regexDialect}`,
    };
  }

  if (!OUTPUT_MODES.includes(query.outputMode)) {
    return {
      code: "invalid-query",
      message: `Unsupported grep output mode: ${query.outputMode}`,
    };
  }

  if (!CASE_SENSITIVITY_MODES.includes(query.caseSensitivity)) {
    return {
      code: "unsupported-query",
      reason: "unsupported-regex",
      message: `Unsupported grep case sensitivity: ${query.caseSensitivity}`,
    };
  }

  const integerError =
    validateInteger(query.contextLines, "contextLines", 0) ??
    validateInteger(query.maxResultChars, "maxResultChars", 1) ??
    validateInteger(query.maxLineChars, "maxLineChars", 0) ??
    validateOptionalInteger(query.maxMatchedFiles, "maxMatchedFiles", 1) ??
    validateOptionalInteger(query.maxMatchedLines, "maxMatchedLines", 1) ??
    validateOptionalInteger(query.timeoutMs, "timeoutMs", 0);

  if (integerError !== null) {
    return { code: "invalid-query", message: integerError };
  }

  return null;
}

function validateInteger(
  value: number,
  name: string,
  minimum: number,
): string | null {
  if (!Number.isInteger(value) || value < minimum) {
    return `${name} must be an integer greater than or equal to ${minimum}.`;
  }
  return null;
}

function validateOptionalInteger(
  value: number | undefined,
  name: string,
  minimum: number,
): string | null {
  if (value === undefined) return null;
  return validateInteger(value, name, minimum);
}
