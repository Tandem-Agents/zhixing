import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  normalizeSceneName,
  normalizeWorkdir,
  probeWorkdir,
} from "../validation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("工作场景名称与工作目录规范化", () => {
  it("normalizeSceneName trim 后返回显示名，空白名拒绝", () => {
    expect(normalizeSceneName("  项目研发  ")).toBe("项目研发");
    expect(() => normalizeSceneName(" \t\n ")).toThrow(/名称不能为空/);
  });

  it("normalizeWorkdir trim 后按本机路径规则规范化，空白目录拒绝", () => {
    const raw = path.join("root", "project", "..", "project-a");
    expect(normalizeWorkdir(`  ${raw}  `)).toBe(path.normalize(raw));
    expect(() => normalizeWorkdir("   ")).toThrow(/工作目录不能为空/);
  });
});

describe("probeWorkdir", () => {
  it("区分目录、缺失路径与非目录", async () => {
    const root = await createTempDir("workscene-probe");
    const dir = path.join(root, "dir");
    const file = path.join(root, "file.txt");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, "content");

    await expect(probeWorkdir(dir)).resolves.toEqual({ kind: "directory" });
    await expect(probeWorkdir(path.join(root, "missing"))).resolves.toEqual({
      kind: "missing",
    });
    await expect(probeWorkdir(file)).resolves.toEqual({
      kind: "non_directory",
    });
  });

  it("区分不可访问与其他 stat 异常", async () => {
    vi.spyOn(fs, "stat")
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("loop"), { code: "ELOOP" }),
      );

    await expect(probeWorkdir("denied")).resolves.toEqual({
      kind: "inaccessible",
      code: "EACCES",
    });
    await expect(probeWorkdir("loop")).resolves.toEqual({
      kind: "error",
      code: "ELOOP",
    });
  });
});
