import { describe, expect, it } from "vitest";
import { sanitizeUntrustedText } from "../text-sanitizer.js";

describe("sanitizeUntrustedText - 默认行为", () => {
  it("纯 ASCII 文本原样返回", () => {
    expect(sanitizeUntrustedText("hello world")).toBe("hello world");
  });

  it("空字符串返回空字符串", () => {
    expect(sanitizeUntrustedText("")).toBe("");
  });

  it("中文文本原样返回(已是 NFC)", () => {
    expect(sanitizeUntrustedText("你好世界")).toBe("你好世界");
  });
});

describe("sanitizeUntrustedText - Unicode 归一化", () => {
  it("NFC 归一化合并组合字符 e + ́  → é", () => {
    const decomposed = "café"; // "cafe" + COMBINING ACUTE ACCENT
    const composed = "café";
    expect(sanitizeUntrustedText(decomposed)).toBe(composed);
  });

  it("默认 NFC 不改变全角字符", () => {
    expect(sanitizeUntrustedText("ABC")).toBe("ABC");
  });

  it("NFKC 把全角 ABC 转为半角", () => {
    expect(sanitizeUntrustedText("ABC", { normalizeForm: "NFKC" })).toBe("ABC");
  });

  it("NFKC 把全角数字转为半角", () => {
    expect(sanitizeUntrustedText("123", { normalizeForm: "NFKC" })).toBe("123");
  });
});

describe("sanitizeUntrustedText - 零宽与不可见字符剥离", () => {
  it.each([
    ["​", "ZERO WIDTH SPACE"],
    ["‌", "ZERO WIDTH NON-JOINER"],
    ["‍", "ZERO WIDTH JOINER"],
    ["‎", "LEFT-TO-RIGHT MARK"],
    ["‏", "RIGHT-TO-LEFT MARK"],
    ["⁠", "WORD JOINER"],
    ["⁡", "FUNCTION APPLICATION"],
    ["⁢", "INVISIBLE TIMES"],
    ["⁣", "INVISIBLE SEPARATOR"],
    ["⁤", "INVISIBLE PLUS"],
    ["⁦", "LEFT-TO-RIGHT ISOLATE"],
    ["⁧", "RIGHT-TO-LEFT ISOLATE"],
    ["⁨", "FIRST STRONG ISOLATE"],
    ["⁩", "POP DIRECTIONAL ISOLATE"],
    ["﻿", "ZWNBSP / BOM"],
  ])("剥离 %s (%s)", (char) => {
    expect(sanitizeUntrustedText(`a${char}b`)).toBe("ab");
  });

  it("剥离嵌入文本中的多个零宽字符", () => {
    const input = "hi​dden‌data﻿";
    expect(sanitizeUntrustedText(input)).toBe("hiddendata");
  });

  it("剥离用于伪装的 BOM", () => {
    expect(sanitizeUntrustedText("﻿hello")).toBe("hello");
  });
});

describe("sanitizeUntrustedText - 长度截断", () => {
  it("文本短于上限时不截断", () => {
    expect(sanitizeUntrustedText("hello", { maxChars: 100 })).toBe("hello");
  });

  it("文本恰好等于上限时不截断", () => {
    expect(sanitizeUntrustedText("hello", { maxChars: 5 })).toBe("hello");
  });

  it("超长截断并附 marker", () => {
    const input = "abcdefghij"; // 10 chars
    const marker = "[... truncated]"; // 15 chars
    const result = sanitizeUntrustedText(input, { maxChars: 20, truncationMarker: marker });
    expect(result).toBe(input); // 不超
  });

  it("超长时尾部用 marker 替代,总长不超 maxChars", () => {
    const input = "a".repeat(100);
    const result = sanitizeUntrustedText(input, { maxChars: 30 });
    expect(result.length).toBe(30);
    expect(result.endsWith("[... truncated]")).toBe(true);
    expect(result.startsWith("a".repeat(15))).toBe(true);
  });

  it("自定义 marker 生效", () => {
    const input = "x".repeat(100);
    const result = sanitizeUntrustedText(input, {
      maxChars: 20,
      truncationMarker: "<cut>",
    });
    expect(result.length).toBe(20);
    expect(result.endsWith("<cut>")).toBe(true);
  });

  it("marker 比 maxChars 还长时,强行截 marker", () => {
    const input = "abcdefghij";
    const result = sanitizeUntrustedText(input, {
      maxChars: 5,
      truncationMarker: "[... truncated]",
    });
    expect(result.length).toBe(5);
    expect(result).toBe("[... ");
  });

  it("marker 长度等于 maxChars 时,长输入完全被替代为 marker", () => {
    const input = "abcdefghij".repeat(10); // 100 chars >> maxChars
    const result = sanitizeUntrustedText(input, {
      maxChars: 15,
      truncationMarker: "[... truncated]", // exactly 15
    });
    expect(result.length).toBe(15);
    expect(result).toBe("[... truncated]");
  });
});

describe("sanitizeUntrustedText - 复合场景", () => {
  it("归一化 + 剥离零宽 + 截断按顺序执行", () => {
    const input = `café​${"x".repeat(100)}`;
    const result = sanitizeUntrustedText(input, { maxChars: 25 });
    expect(result.length).toBe(25);
    expect(result.startsWith("café")).toBe(true);
    expect(result.endsWith("[... truncated]")).toBe(true);
    expect(result).not.toContain("​");
  });

  it("剥离零宽后才计算截断长度", () => {
    const input = `${"​".repeat(50)}hello`;
    const result = sanitizeUntrustedText(input, { maxChars: 100 });
    expect(result).toBe("hello"); // 50 个零宽被剥离 → 实际 5 字符 < 100,不触发截断
  });
});
