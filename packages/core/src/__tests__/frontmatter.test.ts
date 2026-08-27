import { describe, it, expect } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter.js";

describe("parseFrontmatter", () => {
  it("解析标准的 frontmatter + content", () => {
    const raw = `---
name: 张三
language: zh-CN
---

## 技术栈
TypeScript, React`;

    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({ name: "张三", language: "zh-CN" });
    expect(result.content).toBe("## 技术栈\nTypeScript, React");
    expect(result.raw).toBe(raw);
  });

  it("解析数组值", () => {
    const raw = `---
tags: [docker, networking, debug]
triggers: ["docker network", "容器连不上"]
---

content`;

    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual(["docker", "networking", "debug"]);
    expect(result.data.triggers).toEqual(["docker network", "容器连不上"]);
  });

  it("解析布尔和数字值", () => {
    const raw = `---
version: 3
useCount: 7
condensed: true
---

body`;

    const result = parseFrontmatter(raw);
    expect(result.data.version).toBe(3);
    expect(result.data.useCount).toBe(7);
    expect(result.data.condensed).toBe(true);
  });

  it("无 frontmatter 时返回完整内容", () => {
    const raw = "Just some content\nwithout frontmatter";
    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({});
    expect(result.content).toBe(raw);
  });

  it("空字符串", () => {
    const result = parseFrontmatter("");
    expect(result.data).toEqual({});
    expect(result.content).toBe("");
  });

  it("只有 frontmatter 没有 content", () => {
    const raw = `---
name: 张三
---`;

    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({ name: "张三" });
    expect(result.content).toBe("");
  });

  it("frontmatter 中的空数组", () => {
    const raw = `---
tags: []
---

body`;

    const result = parseFrontmatter(raw);
    expect(result.data.tags).toEqual([]);
  });

  it("frontmatter 中的 null 值", () => {
    const raw = `---
name: 张三
timezone: null
empty:
---

body`;

    const result = parseFrontmatter(raw);
    expect(result.data.name).toBe("张三");
    expect(result.data.timezone).toBeNull();
    expect(result.data.empty).toBeNull();
  });

  it("跳过注释行", () => {
    const raw = `---
# 这是注释
name: 张三
---

body`;

    const result = parseFrontmatter(raw);
    expect(result.data).toEqual({ name: "张三" });
  });

  it("处理带引号的字符串值", () => {
    const raw = `---
title: "Docker: 网络调试"
---

body`;

    const result = parseFrontmatter(raw);
    expect(result.data.title).toBe("Docker: 网络调试");
  });
});

describe("stringifyFrontmatter", () => {
  it("序列化基本键值对", () => {
    const result = stringifyFrontmatter(
      { name: "张三", language: "zh-CN" },
      "## 技术栈\nTypeScript",
    );

    expect(result).toBe(
      "---\nname: 张三\nlanguage: zh-CN\n---\n\n## 技术栈\nTypeScript",
    );
  });

  it("序列化数组", () => {
    const result = stringifyFrontmatter(
      { tags: ["docker", "networking"] },
      "content",
    );

    expect(result).toContain("tags: [docker, networking]");
  });

  it("跳过 undefined 和 null 值", () => {
    const result = stringifyFrontmatter(
      { name: "张三", timezone: undefined, empty: null },
      "content",
    );

    expect(result).not.toContain("timezone");
    expect(result).not.toContain("empty");
  });

  it("空 data 时不输出 frontmatter", () => {
    const result = stringifyFrontmatter({}, "just content");
    expect(result).toBe("just content");
    expect(result).not.toContain("---");
  });

  it("特殊字符的字符串加引号", () => {
    const result = stringifyFrontmatter(
      { title: "Docker: 网络调试" },
      "content",
    );

    expect(result).toContain('title: "Docker: 网络调试"');
  });

  it("roundtrip: parse → stringify → parse 保持一致", () => {
    const original = `---
name: 张三
tags: [docker, react]
version: 2
---

## 内容
这是正文`;

    const parsed = parseFrontmatter(original);
    const rebuilt = stringifyFrontmatter(
      parsed.data as Record<string, unknown>,
      parsed.content,
    );
    const reparsed = parseFrontmatter(rebuilt);

    expect(reparsed.data).toEqual(parsed.data);
    expect(reparsed.content).toBe(parsed.content);
  });
});
