import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteTool } from "../write.js";

describe("Write Tool", () => {
  const tool = createWriteTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-write-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  // ─── 基本写入 ───

  it("创建新文件", async () => {
    const result = await tool.call(
      { path: "new.txt", content: "hello world" },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Successfully wrote");

    const written = await fs.readFile(path.join(tmpDir, "new.txt"), "utf-8");
    expect(written).toBe("hello world");
  });

  it("覆盖已有文件", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "old content", "utf-8");

    const result = await tool.call(
      { path: "existing.txt", content: "new content" },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const written = await fs.readFile(filePath, "utf-8");
    expect(written).toBe("new content");
  });

  it("自动创建父目录", async () => {
    const result = await tool.call(
      { path: "deep/nested/dir/file.txt", content: "deep content" },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const written = await fs.readFile(
      path.join(tmpDir, "deep/nested/dir/file.txt"),
      "utf-8",
    );
    expect(written).toBe("deep content");
  });

  it("支持绝对路径", async () => {
    const absPath = path.join(tmpDir, "abs-write.txt");
    const result = await tool.call(
      { path: absPath, content: "absolute" },
      ctx(),
    );

    expect(result.isError).toBeUndefined();
    const written = await fs.readFile(absPath, "utf-8");
    expect(written).toBe("absolute");
  });

  // ─── 返回信息 ───

  it("返回包含字符数和行数的成功消息", async () => {
    const content = "line1\nline2\nline3";
    const result = await tool.call(
      { path: "info.txt", content },
      ctx(),
    );

    expect(result.content).toContain(String(content.length));
    expect(result.content).toContain("3 lines");
  });

  // ─── 工具元信息 ───

  it("声明为非只读且需要权限", () => {
    expect(tool.isReadOnly).toBe(false);
    expect(tool.needsPermission).toBe(true);
  });
});
