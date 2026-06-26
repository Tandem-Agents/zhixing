import type { OrchestrationParseResultV1 } from "./types.js";

export function parseOrchestrationDefinitionV1(
  source: string,
): OrchestrationParseResultV1 {
  try {
    const withoutComments = stripJsonComments(source);
    const withoutTrailingCommas = stripTrailingCommas(withoutComments);
    return { ok: true, value: JSON.parse(withoutTrailingCommas) };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          code: "parse_error",
          message:
            error instanceof Error
              ? `Invalid orchestration JSONC: ${error.message}`
              : "Invalid orchestration JSONC.",
        },
      ],
    };
  }
}

function stripJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (char === undefined) break;

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length) {
        const commentChar = source[index + 1];
        if (commentChar === "\n" || commentChar === "\r") break;
        result += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      let closed = false;
      while (index + 1 < source.length) {
        const commentChar = source[index + 1];
        const commentNext = source[index + 2];
        if (commentChar === "*" && commentNext === "/") {
          result += "  ";
          index += 2;
          closed = true;
          break;
        }
        result += commentChar === "\n" || commentChar === "\r" ? commentChar : " ";
        index += 1;
      }
      if (!closed) {
        throw new Error("Unterminated block comment.");
      }
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) break;

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
        cursor += 1;
      }
      const next = source[cursor];
      if (next === "}" || next === "]") continue;
    }

    result += char;
  }

  return result;
}
