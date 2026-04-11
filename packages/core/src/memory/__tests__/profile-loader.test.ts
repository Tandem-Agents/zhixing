import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProfile, formatProfileForContext } from "../profile-loader.js";
import type { ProfileData } from "../types.js";

// ─── Mock fs ───

vi.mock("node:fs/promises");
const mockedFs = vi.mocked(fs);

// 固定 HOME 目录
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const TEST_HOME = "/test-home";

beforeEach(() => {
  process.env.HOME = TEST_HOME;
  delete process.env.USERPROFILE;
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});

// ─── loadProfile ───

describe("loadProfile", () => {
  const profilePath = path.join(TEST_HOME, ".zhixing", "me", "profile.md");

  it("加载完整的 profile.md", async () => {
    mockedFs.readFile.mockResolvedValue(`---
name: 张三
language: zh-CN
timezone: Asia/Shanghai
---

## 技术栈
TypeScript, React, Node.js

## 偏好
喜欢简洁的代码风格`);

    const result = await loadProfile();

    expect(mockedFs.readFile).toHaveBeenCalledWith(profilePath, "utf-8");
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe("张三");
    expect(result!.meta.language).toBe("zh-CN");
    expect(result!.meta.timezone).toBe("Asia/Shanghai");
    expect(result!.content).toContain("## 技术栈");
    expect(result!.content).toContain("TypeScript, React, Node.js");
  });

  it("文件不存在时返回 null", async () => {
    mockedFs.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await loadProfile();
    expect(result).toBeNull();
  });

  it("文件为空时返回 null", async () => {
    mockedFs.readFile.mockResolvedValue("   \n  ");

    const result = await loadProfile();
    expect(result).toBeNull();
  });

  it("缺少 name 时默认为 User", async () => {
    mockedFs.readFile.mockResolvedValue(`---
language: en
---

Some content`);

    const result = await loadProfile();
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe("User");
  });

  it("无 frontmatter 时仍加载内容", async () => {
    mockedFs.readFile.mockResolvedValue("Just plain text about me");

    const result = await loadProfile();
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe("User");
    expect(result!.content).toBe("Just plain text about me");
  });

  it("使用 USERPROFILE 环境变量 (Windows)", async () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "C:\\Users\\test";

    mockedFs.readFile.mockResolvedValue(`---
name: Test
---

content`);

    const result = await loadProfile();
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe("Test");
  });
});

// ─── formatProfileForContext ───

describe("formatProfileForContext", () => {
  it("格式化完整的 profile", () => {
    const profile: ProfileData = {
      meta: { name: "张三", language: "zh-CN", timezone: "Asia/Shanghai" },
      content: "## 技术栈\nTypeScript, React",
      raw: "",
    };

    const result = formatProfileForContext(profile);
    expect(result).toContain("# User Profile");
    expect(result).toContain("Name: 张三");
    expect(result).toContain("Language: zh-CN");
    expect(result).toContain("Timezone: Asia/Shanghai");
    expect(result).toContain("## 技术栈");
    expect(result).toContain("TypeScript, React");
  });

  it("可选字段缺失时不输出", () => {
    const profile: ProfileData = {
      meta: { name: "Alice" },
      content: "",
      raw: "",
    };

    const result = formatProfileForContext(profile);
    expect(result).toContain("Name: Alice");
    expect(result).not.toContain("Language:");
    expect(result).not.toContain("Timezone:");
  });

  it("无正文时只输出 meta", () => {
    const profile: ProfileData = {
      meta: { name: "Bob" },
      content: "",
      raw: "",
    };

    const result = formatProfileForContext(profile);
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("# User Profile");
    expect(lines[1]).toBe("Name: Bob");
  });
});
