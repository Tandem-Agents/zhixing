import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PathGuard, type GuidanceWarningInput } from "@zhixing/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGuidanceFileReader,
  readGuidanceFile,
} from "../read-guidance-file.js";

describe("readGuidanceFile", () => {
  let root: string;
  let outside: string;
  let warnings: GuidanceWarningInput[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zhixing-guidance-root-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "zhixing-guidance-out-"));
    warnings = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("读取普通文件并保留完整内容", async () => {
    const filePath = path.join(root, "ZHIXING.md");
    const content = "约定\n".repeat(2_000);
    await writeFile(filePath, content, "utf8");

    await expect(read(filePath)).resolves.toBe(content);
    expect(warnings).toEqual([]);
  });

  it("复用 PathGuard containment，越界路径不注入并诊断", async () => {
    const spy = vi.spyOn(PathGuard, "isWithinWorkspace");
    const filePath = path.join(outside, "ZHIXING.md");
    await writeFile(filePath, "secret", "utf8");

    await expect(read(filePath)).resolves.toBeNull();

    expect(spy).toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("不在作用域根目录内");
  });

  it("缺文件与 ENOTDIR 不诊断", async () => {
    await expect(read(path.join(root, "missing", "ZHIXING.md"))).resolves.toBeNull();
    const fileRoot = path.join(root, "file-root");
    await writeFile(fileRoot, "not dir", "utf8");

    await expect(read(path.join(fileRoot, "ZHIXING.md"), fileRoot)).resolves.toBeNull();

    expect(warnings).toEqual([]);
  });

  it("目录等非普通文件不注入并诊断", async () => {
    const dirPath = path.join(root, "ZHIXING.md");
    await mkdir(dirPath);

    await expect(read(dirPath)).resolves.toBeNull();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("不是普通文件");
  });

  it("读取阶段失败时不注入并诊断", async () => {
    const filePath = path.join(root, "ZHIXING.md");
    await writeFile(filePath, "content", "utf8");
    const reader = createGuidanceFileReader({
      lstat,
      open: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });

    await expect(
      reader({
        scopeRoot: root,
        path: filePath,
        reportWarning: (event) => warnings.push(event),
      }),
    ).resolves.toBeNull();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("约定文件读取失败");
    expect(warnings[0]?.message).toContain("permission denied");
  });

  it("最终组件为 symlink 时不注入并诊断", async () => {
    const target = path.join(outside, "target.md");
    const linkPath = path.join(root, "ZHIXING.md");
    await writeFile(target, "outside", "utf8");
    const created = await tryCreateSymlink(target, linkPath);
    if (!created) return;

    await expect(read(linkPath)).resolves.toBeNull();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/不在作用域根目录内|符号链接|重解析点/);
  });

  async function read(filePath: string, scopeRoot = root): Promise<string | null> {
    return readGuidanceFile({
      scopeRoot,
      path: filePath,
      reportWarning: (event) => warnings.push(event),
    });
  }
});

async function tryCreateSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}
