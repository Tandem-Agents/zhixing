import { describe, expect, it } from "vitest";
import { deriveChildLineage } from "../lineage.js";

describe("deriveChildLineage", () => {
  it("拼接父 lineage + '/sub-' + id 前 8 字符", () => {
    expect(deriveChildLineage("main", "abcdef0123456789")).toBe(
      "main/sub-abcdef01",
    );
  });

  it("父 lineage 为 undefined 时回退到 'main'", () => {
    expect(deriveChildLineage(undefined, "abcdef0123456789")).toBe(
      "main/sub-abcdef01",
    );
  });

  it("支持嵌套子 agent (孙子 lineage 以子 lineage 为前缀)", () => {
    const childLineage = deriveChildLineage("main", "1234567890abcdef");
    const grandchildLineage = deriveChildLineage(childLineage, "fedcba0987654321");
    expect(grandchildLineage).toBe("main/sub-12345678/sub-fedcba09");
    expect(grandchildLineage.startsWith(`${childLineage}/`)).toBe(true);
  });

  it("id 短于 8 字符时取全部字符 (退化但不崩)", () => {
    expect(deriveChildLineage("main", "abc")).toBe("main/sub-abc");
  });
});
