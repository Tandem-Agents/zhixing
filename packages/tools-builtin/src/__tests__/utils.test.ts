import { describe, expect, it } from "vitest";
import { addLineNumbers, resolveToolPath, truncateResult } from "../utils.js";

describe("resolveToolPath", () => {
  it("绝对路径原样返回（规范化）", () => {
    const result = resolveToolPath("/home/user/file.txt", "/workspace");
    expect(result).toMatch(/file\.txt$/);
  });

  it("相对路径基于 workingDirectory 解析", () => {
    const result = resolveToolPath("src/index.ts", "/workspace/project");
    expect(result).toContain("project");
    expect(result).toMatch(/src[/\\]index\.ts$/);
  });

  it("处理 .. 路径", () => {
    const result = resolveToolPath("../other/file.ts", "/workspace/project");
    expect(result).toMatch(/other[/\\]file\.ts$/);
  });
});

describe("truncateResult", () => {
  it("短于限制时原样返回", () => {
    const content = "hello world";
    expect(truncateResult(content, 100)).toBe(content);
  });

  it("刚好等于限制时原样返回", () => {
    const content = "12345";
    expect(truncateResult(content, 5)).toBe(content);
  });

  it("超出限制时截断并附加提示", () => {
    const content = "a".repeat(100);
    const result = truncateResult(content, 50);
    expect(result).toHaveLength(50 + result.length - 50); // 截断内容 + 提示
    expect(result).toContain("[truncated:");
    expect(result).toContain("50");
    expect(result).toContain("100");
  });
});

describe("addLineNumbers", () => {
  it("为每行添加行号", () => {
    const result = addLineNumbers("line1\nline2\nline3");
    expect(result).toBe("1|line1\n2|line2\n3|line3");
  });

  it("支持自定义起始行号", () => {
    const result = addLineNumbers("a\nb\nc", 10);
    expect(result).toBe("10|a\n11|b\n12|c");
  });

  it("行号对齐填充", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
    const result = addLineNumbers(lines);
    const firstLine = result.split("\n")[0];
    // 行号应补齐到两位宽度（1-12）
    expect(firstLine).toBe(" 1|line1");
  });

  it("空字符串返回单行 '1|'", () => {
    const result = addLineNumbers("");
    expect(result).toBe("1|");
  });
});
