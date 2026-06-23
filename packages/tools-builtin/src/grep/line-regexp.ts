import type {
  CompiledLineRegexp,
  CompileLineRegexpOptions,
  GrepCaseSensitivity,
} from "./types.js";

const ASCII_WORD_CLASS = "[A-Za-z0-9_]";
const ASCII_WORD_CLASS_CONTENT = "A-Za-z0-9_";
const ASCII_DIGIT_CLASS = "[0-9]";
const ASCII_DIGIT_CLASS_CONTENT = "0-9";
const ASCII_SPACE_CLASS = "[\\t\\n\\v\\f\\r ]";
const ASCII_SPACE_CLASS_CONTENT = "\\t\\n\\v\\f\\r ";

export class LineRegexpSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineRegexpSyntaxError";
  }
}

interface TranslatedPattern {
  javascriptSource: string;
  ripgrepSource: string;
}

interface TranslatedToken {
  javascriptSource: string;
  ripgrepSource: string;
  nextIndex: number;
}

export function compileLineRegexp(
  pattern: string,
  options: CompileLineRegexpOptions = {},
): CompiledLineRegexp {
  const caseSensitivity = options.caseSensitivity ?? "sensitive";
  const translated = translateLineRegexp(pattern, caseSensitivity);

  let regex: RegExp;
  try {
    regex = new RegExp(translated.javascriptSource, "u");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LineRegexpSyntaxError(`Invalid line-regexp pattern: ${message}`);
  }

  return {
    dialect: "line-regexp",
    originalPattern: pattern,
    javascriptSource: translated.javascriptSource,
    ripgrepSource: translated.ripgrepSource,
    caseSensitivity,
    test(line: string): boolean {
      regex.lastIndex = 0;
      return regex.test(line);
    },
  };
}

function translateLineRegexp(
  pattern: string,
  caseSensitivity: GrepCaseSensitivity,
): TranslatedPattern {
  let javascriptSource = "";
  let ripgrepSource = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index]!;

    if (char === "\n" || char === "\r") {
      throw new LineRegexpSyntaxError("line-regexp patterns cannot contain raw line terminators");
    }

    if (char === "\\") {
      const escaped = translateEscape(pattern, index, false);
      javascriptSource += escaped.javascriptSource;
      ripgrepSource += escaped.ripgrepSource;
      index = escaped.nextIndex;
      continue;
    }

    if (char === "[") {
      const characterClass = translateCharacterClass(
        pattern,
        index,
        caseSensitivity,
      );
      javascriptSource += characterClass.javascriptSource;
      ripgrepSource += characterClass.ripgrepSource;
      index = characterClass.nextIndex;
      continue;
    }

    if (char === "(" && pattern[index + 1] === "?") {
      if (pattern[index + 2] !== ":") {
        throw new LineRegexpSyntaxError("line-regexp supports capturing and non-capturing groups, not lookaround or inline flags");
      }
      javascriptSource += "(?:";
      ripgrepSource += "(?:";
      index += 3;
      continue;
    }

    if (char === ".") {
      javascriptSource += "[\\s\\S]";
      ripgrepSource += ".";
      index++;
      continue;
    }

    const token = readCodePoint(pattern, index);
    if (caseSensitivity === "ascii-insensitive" && isAsciiLetter(token.char)) {
      const folded = asciiFoldClass(token.char);
      javascriptSource += folded;
      ripgrepSource += folded;
    } else {
      javascriptSource += token.char;
      ripgrepSource += token.char;
    }
    index = token.nextIndex;
  }

  return { javascriptSource, ripgrepSource };
}

function translateCharacterClass(
  pattern: string,
  startIndex: number,
  caseSensitivity: GrepCaseSensitivity,
): TranslatedToken {
  let javascriptSource = "[";
  let ripgrepSource = "[";
  let index = startIndex + 1;
  let isFirstContentChar = true;

  if (pattern[index] === "^") {
    javascriptSource += "^";
    ripgrepSource += "^";
    index++;
  }

  while (index < pattern.length) {
    const char = pattern[index]!;

    if (char === "\n" || char === "\r") {
      throw new LineRegexpSyntaxError("line-regexp character classes cannot contain raw line terminators");
    }

    if (char === "]" && !isFirstContentChar) {
      return {
        javascriptSource: `${javascriptSource}]`,
        ripgrepSource: `${ripgrepSource}]`,
        nextIndex: index + 1,
      };
    }

    if (char === "\\") {
      const escaped = translateEscape(pattern, index, true);
      javascriptSource += escaped.javascriptSource;
      ripgrepSource += escaped.ripgrepSource;
      index = escaped.nextIndex;
      isFirstContentChar = false;
      continue;
    }

    const range = readAsciiLetterRange(pattern, index);
    if (caseSensitivity === "ascii-insensitive" && range !== null) {
      const folded = asciiFoldRange(range.start, range.end);
      javascriptSource += `${range.start}-${range.end}${folded}`;
      ripgrepSource += `${range.start}-${range.end}${folded}`;
      index = range.nextIndex;
      isFirstContentChar = false;
      continue;
    }

    const token = readCodePoint(pattern, index);
    if (caseSensitivity === "ascii-insensitive" && isAsciiLetter(token.char)) {
      const folded = `${token.char}${swapAsciiCase(token.char)}`;
      javascriptSource += folded;
      ripgrepSource += folded;
    } else {
      javascriptSource += token.char;
      ripgrepSource += token.char;
    }
    index = token.nextIndex;
    isFirstContentChar = false;
  }

  throw new LineRegexpSyntaxError("Unterminated line-regexp character class");
}

function translateEscape(
  pattern: string,
  backslashIndex: number,
  inCharacterClass: boolean,
): TranslatedToken {
  const escaped = pattern[backslashIndex + 1];
  if (escaped === undefined) {
    throw new LineRegexpSyntaxError("Trailing backslash in line-regexp pattern");
  }

  if (escaped === "w") {
    return escapeResult(
      inCharacterClass ? ASCII_WORD_CLASS_CONTENT : ASCII_WORD_CLASS,
      inCharacterClass ? ASCII_WORD_CLASS_CONTENT : ASCII_WORD_CLASS,
      backslashIndex + 2,
    );
  }

  if (escaped === "d") {
    return escapeResult(
      inCharacterClass ? ASCII_DIGIT_CLASS_CONTENT : ASCII_DIGIT_CLASS,
      inCharacterClass ? ASCII_DIGIT_CLASS_CONTENT : ASCII_DIGIT_CLASS,
      backslashIndex + 2,
    );
  }

  if (escaped === "s") {
    return escapeResult(
      inCharacterClass ? ASCII_SPACE_CLASS_CONTENT : ASCII_SPACE_CLASS,
      inCharacterClass ? ASCII_SPACE_CLASS_CONTENT : ASCII_SPACE_CLASS,
      backslashIndex + 2,
    );
  }

  if (!inCharacterClass && (escaped === "b" || escaped === "B")) {
    return escapeResult(
      `\\${escaped}`,
      `(?-u:\\${escaped})`,
      backslashIndex + 2,
    );
  }

  if (inCharacterClass && (escaped === "b" || escaped === "B")) {
    throw new LineRegexpSyntaxError(`\\${escaped} is outside the portable line-regexp character class subset`);
  }

  if (escaped === "n" || escaped === "r") {
    throw new LineRegexpSyntaxError("line-regexp patterns cannot match line terminators");
  }

  if (escaped === "p" || escaped === "P") {
    throw new LineRegexpSyntaxError("Unicode property classes are outside the line-regexp subset");
  }

  if (escaped === "u" || escaped === "x" || escaped === "c") {
    throw new LineRegexpSyntaxError("Encoded escapes are outside the line-regexp subset; use literal Unicode text");
  }

  if (escaped === "k" && pattern[backslashIndex + 2] === "<") {
    throw new LineRegexpSyntaxError("Backreferences are outside the line-regexp subset");
  }

  if (isAsciiDigit(escaped)) {
    throw new LineRegexpSyntaxError("Backreferences are outside the line-regexp subset");
  }

  if (isAsciiLetter(escaped) && escaped !== "t" && escaped !== "f" && escaped !== "v" && escaped !== "b") {
    throw new LineRegexpSyntaxError(`Unsupported line-regexp escape \\${escaped}`);
  }

  const source = `\\${escaped}`;

  return escapeResult(source, source, backslashIndex + 2);
}

function escapeResult(
  javascriptSource: string,
  ripgrepSource: string,
  nextIndex: number,
): TranslatedToken {
  return { javascriptSource, ripgrepSource, nextIndex };
}

function readCodePoint(input: string, index: number): { char: string; nextIndex: number } {
  const codePoint = input.codePointAt(index);
  if (codePoint === undefined) {
    throw new LineRegexpSyntaxError("Unexpected end of line-regexp pattern");
  }

  return {
    char: String.fromCodePoint(codePoint),
    nextIndex: index + (codePoint > 0xffff ? 2 : 1),
  };
}

function readAsciiLetterRange(
  pattern: string,
  index: number,
): { start: string; end: string; nextIndex: number } | null {
  const start = pattern[index];
  const dash = pattern[index + 1];
  const end = pattern[index + 2];
  if (
    start === undefined ||
    dash !== "-" ||
    end === undefined ||
    end === "]" ||
    !isAsciiLetter(start) ||
    !isAsciiLetter(end)
  ) {
    return null;
  }

  return { start, end, nextIndex: index + 3 };
}

function asciiFoldClass(char: string): string {
  return `[${char}${swapAsciiCase(char)}]`;
}

function asciiFoldRange(start: string, end: string): string {
  if (isLowerAsciiLetter(start) && isLowerAsciiLetter(end)) {
    return `${start.toUpperCase()}-${end.toUpperCase()}`;
  }
  if (isUpperAsciiLetter(start) && isUpperAsciiLetter(end)) {
    return `${start.toLowerCase()}-${end.toLowerCase()}`;
  }
  return `${swapAsciiCase(start)}${swapAsciiCase(end)}`;
}

function swapAsciiCase(char: string): string {
  return isLowerAsciiLetter(char) ? char.toUpperCase() : char.toLowerCase();
}

function isAsciiLetter(char: string): boolean {
  return isLowerAsciiLetter(char) || isUpperAsciiLetter(char);
}

function isLowerAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x61 && code <= 0x7a;
}

function isUpperAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a;
}

function isAsciiDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}
