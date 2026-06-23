import { Buffer } from "node:buffer";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LineRegexpSyntaxError,
  comparePosixPathByCodePoint,
  compileLineRegexp,
  countUnicodeScalars,
  decodeGrepFileBytes,
  sortGrepFiles,
  splitLogicalLines,
  toDisplayPath,
  toGrepLineText,
} from "../grep/core.js";

describe("grep core semantics", () => {
  describe("display path and sorting", () => {
    it("projects workspace files to POSIX relative display paths", () => {
      const workingDirectory = path.resolve("workspace");
      const filePath = path.join(workingDirectory, "src", "app.ts");

      expect(toDisplayPath(filePath, workingDirectory)).toBe("src/app.ts");
    });

    it("projects outside files to normalized absolute display paths", () => {
      const workingDirectory = path.resolve("workspace");
      const filePath = path.resolve(workingDirectory, "..", "outside", "app.ts");

      expect(toDisplayPath(filePath, workingDirectory)).toBe(
        filePath.replace(/\\/g, "/"),
      );
    });

    it("sorts files by displayPath using POSIX code point order", () => {
      const sorted = sortGrepFiles([
        { displayPath: "src/b.ts" },
        { displayPath: "README.md" },
        { displayPath: "src/a.ts" },
      ]);

      expect(sorted.map((file) => file.displayPath)).toEqual([
        "README.md",
        "src/a.ts",
        "src/b.ts",
      ]);
      expect(comparePosixPathByCodePoint("💡.ts", "😀.ts")).toBeLessThan(0);
    });
  });

  describe("line model", () => {
    it("normalizes CRLF, LF, and CR without keeping terminators", () => {
      expect(splitLogicalLines("a\r\nb\nc\rd\r\n")).toEqual([
        "a",
        "b",
        "c",
        "d",
      ]);
    });

    it("does not create a synthetic empty line for a final terminator", () => {
      expect(splitLogicalLines("a\n")).toEqual(["a"]);
      expect(splitLogicalLines("\n")).toEqual([""]);
      expect(splitLogicalLines("")).toEqual([]);
    });

    it("truncates line text by Unicode scalar count", () => {
      expect(countUnicodeScalars("a😀bc")).toBe(4);
      expect(toGrepLineText("a😀bc", 2)).toEqual({
        text: "a😀",
        truncated: true,
        omittedScalars: 2,
      });
      expect(toGrepLineText("a😀", 2)).toEqual({
        text: "a😀",
        truncated: false,
      });
    });
  });

  describe("encoding", () => {
    it("decodes UTF-8 with and without BOM", () => {
      expect(decodeGrepFileBytes(Buffer.from("hello", "utf-8"))).toEqual({
        text: "hello",
        encoding: "utf-8",
      });
      expect(
        decodeGrepFileBytes(Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from("hello", "utf-8"),
        ])),
      ).toEqual({
        text: "hello",
        encoding: "utf-8-bom",
      });
    });

    it("decodes UTF-16 files with BOM", () => {
      expect(
        decodeGrepFileBytes(Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("hello", "utf16le"),
        ])),
      ).toEqual({
        text: "hello",
        encoding: "utf-16le-bom",
      });
      expect(
        decodeGrepFileBytes(Buffer.concat([
          Buffer.from([0xfe, 0xff]),
          utf16be("hello"),
        ])),
      ).toEqual({
        text: "hello",
        encoding: "utf-16be-bom",
      });
    });
  });

  describe("line-regexp", () => {
    it("matches by Unicode scalar value", () => {
      const regexp = compileLineRegexp("^.$");

      expect(regexp.test("😀")).toBe(true);
      expect(regexp.test("😀😀")).toBe(false);
      expect(regexp.test("\u2028")).toBe(true);
    });

    it("supports Unicode literals and quantifiers", () => {
      const regexp = compileLineRegexp("^😀+$");

      expect(regexp.test("😀😀")).toBe(true);
      expect(regexp.test("😀x")).toBe(false);
    });

    it("uses ASCII word classes and word boundaries", () => {
      expect(compileLineRegexp("^\\w+$").test("foo_09")).toBe(true);
      expect(compileLineRegexp("^\\w+$").test("变量")).toBe(false);

      const word = compileLineRegexp("\\bfoo\\b");
      expect(word.test("foo")).toBe(true);
      expect(word.test("foobar")).toBe(false);
      expect(word.test("变量foo变量")).toBe(true);
      expect(word.ripgrepSource).toContain("(?-u:\\b)");
    });

    it("supports ASCII-only case insensitive matching", () => {
      const regexp = compileLineRegexp("foo[a-c]+", {
        caseSensitivity: "ascii-insensitive",
      });

      expect(regexp.test("FOOC")).toBe(true);
      expect(regexp.test("fooD")).toBe(false);
      expect(compileLineRegexp("k", {
        caseSensitivity: "ascii-insensitive",
      }).test("K")).toBe(false);
    });

    it("rejects regex features outside the portable subset", () => {
      expect(() => compileLineRegexp("(?<=a)b")).toThrow(LineRegexpSyntaxError);
      expect(() => compileLineRegexp("(a)\\1")).toThrow(LineRegexpSyntaxError);
      expect(() => compileLineRegexp("\\p{L}")).toThrow(LineRegexpSyntaxError);
      expect(() => compileLineRegexp("\\u0061")).toThrow(LineRegexpSyntaxError);
      expect(() => compileLineRegexp("a\\n")).toThrow(LineRegexpSyntaxError);
      expect(() => compileLineRegexp("[\\b]")).toThrow(LineRegexpSyntaxError);
    });
  });
});

function utf16be(text: string): Buffer {
  const littleEndian = Buffer.from(text, "utf16le");
  const bigEndian = Buffer.alloc(littleEndian.length);
  for (let i = 0; i < littleEndian.length; i += 2) {
    bigEndian[i] = littleEndian[i + 1]!;
    bigEndian[i + 1] = littleEndian[i]!;
  }
  return bigEndian;
}
