import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGlobTool } from "../glob.js";

describe("Glob Tool", () => {
  const tool = createGlobTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-glob-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  async function writeFixture(relativePath: string, content = "content"): Promise<void> {
    const filePath = path.join(tmpDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  // ──────────────────────────────────────
  // 基本搜索
  // ──────────────────────────────────────

  describe("基本搜索", () => {
    it("按扩展名查找文件", async () => {
      await writeFixture("app.ts");
      await writeFixture("lib.ts");
      await writeFixture("readme.md");

      const result = await tool.call({ pattern: "**/*.ts" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("app.ts");
      expect(result.content).toContain("lib.ts");
      expect(result.content).not.toContain("readme.md");
    });

    it("在子目录中查找文件", async () => {
      await writeFixture("src/a.ts");
      await writeFixture("src/b.ts");
      await writeFixture("test/c.ts");

      const result = await tool.call({ pattern: "src/**/*.ts" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("src/a.ts");
      expect(result.content).toContain("src/b.ts");
      expect(result.content).not.toContain("test/c.ts");
    });

    it("查找所有文件", async () => {
      await writeFixture("a.txt");
      await writeFixture("b.json");
      await writeFixture("src/c.ts");

      const result = await tool.call({ pattern: "**/*" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("a.txt");
      expect(result.content).toContain("b.json");
      expect(result.content).toContain("src/c.ts");
    });
  });

  // ──────────────────────────────────────
  // 自动排除
  // ──────────────────────────────────────

  describe("自动排除", () => {
    it("排除 node_modules", async () => {
      await writeFixture("src/app.ts");
      await writeFixture("node_modules/pkg/index.js");

      const result = await tool.call({ pattern: "**/*.{ts,js}" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("src/app.ts");
      expect(result.content).not.toContain("node_modules");
    });

    it("排除 .git 目录", async () => {
      await writeFixture("src/app.ts");
      await writeFixture(".git/config");

      const result = await tool.call({ pattern: "**/*" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("src/app.ts");
      expect(result.content).not.toContain(".git/config");
    });

    it("包含 dotfiles（非 .git）", async () => {
      await writeFixture(".eslintrc.json");
      await writeFixture("src/app.ts");

      const result = await tool.call({ pattern: "**/*" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain(".eslintrc.json");
    });
  });

  // ──────────────────────────────────────
  // 路径参数
  // ──────────────────────────────────────

  describe("路径参数", () => {
    it("在指定子目录中搜索", async () => {
      await writeFixture("src/a.ts");
      await writeFixture("lib/b.ts");
      await writeFixture("test/c.ts");

      const result = await tool.call(
        { pattern: "**/*.ts", path: "src" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("a.ts");
      expect(result.content).not.toContain("b.ts");
      expect(result.content).not.toContain("c.ts");
    });

    it("支持绝对路径", async () => {
      await writeFixture("sub/file.txt");

      const result = await tool.call(
        { pattern: "**/*.txt", path: path.join(tmpDir, "sub") },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("file.txt");
    });

    it("不存在的目录报错", async () => {
      const result = await tool.call(
        { pattern: "**/*", path: "nonexistent" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  // ──────────────────────────────────────
  // 排序与格式
  // ──────────────────────────────────────

  describe("排序与格式", () => {
    it("显示文件大小", async () => {
      await writeFixture("small.txt", "hi");
      await writeFixture("bigger.txt", "a".repeat(2048));

      const result = await tool.call({ pattern: "**/*.txt" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("B)");
      expect(result.content).toContain("KB)");
    });

    it("显示匹配数量", async () => {
      await writeFixture("a.ts");
      await writeFixture("b.ts");
      await writeFixture("c.ts");

      const result = await tool.call({ pattern: "**/*.ts" }, ctx());

      expect(result.content).toContain("Found 3 files");
    });

    it("单个文件用单数", async () => {
      await writeFixture("only.ts");

      const result = await tool.call({ pattern: "**/*.ts" }, ctx());

      expect(result.content).toContain("Found 1 file:");
      expect(result.content).not.toContain("files:");
    });
  });

  // ──────────────────────────────────────
  // 无匹配
  // ──────────────────────────────────────

  describe("无匹配", () => {
    it("无匹配时返回友好提示", async () => {
      await writeFixture("dummy.txt");

      const result = await tool.call({ pattern: "**/*.py" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("No files found");
      expect(result.content).toContain("**/*.py");
    });
  });

  // ──────────────────────────────────────
  // 参数验证
  // ──────────────────────────────────────

  describe("参数验证", () => {
    it("空 pattern 报错", async () => {
      const result = await tool.call({ pattern: "" }, ctx());
      expect(result.isError).toBe(true);
    });
  });

  // ──────────────────────────────────────
  // 工具元信息
  // ──────────────────────────────────────

  describe("工具元信息", () => {
    it("声明为只读、可并行、不需要权限", () => {
      expect(tool.isReadOnly).toBe(true);
      expect(tool.isParallelSafe).toBe(true);
      expect(tool.needsPermission).toBe(false);
    });

    it("名称为 glob", () => {
      expect(tool.name).toBe("glob");
    });
  });
});
