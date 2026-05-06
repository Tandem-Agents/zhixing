import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createReadTool } from "../read.js";

describe("Read Tool", () => {
  const tool = createReadTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("read");
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  // ─── 基本读取 ───

  it("读取文件并返回带行号的内容", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3", "utf-8");

    const result = await tool.call({ path: "hello.txt" }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1|line1");
    expect(result.content).toContain("2|line2");
    expect(result.content).toContain("3|line3");
  });

  it("支持绝对路径", async () => {
    const filePath = path.join(tmpDir, "abs.txt");
    await fs.writeFile(filePath, "absolute path content", "utf-8");

    const result = await tool.call({ path: filePath }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("absolute path content");
  });

  // ─── offset / limit ───

  it("offset 跳过前 N 行", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne", "utf-8");

    const result = await tool.call({ path: "lines.txt", offset: 3 }, ctx());

    expect(result.content).toContain("3|c");
    expect(result.content).toContain("4|d");
    expect(result.content).not.toContain("1|a");
    expect(result.content).toContain("Showing lines");
  });

  it("limit 限制返回行数", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne", "utf-8");

    const result = await tool.call({ path: "lines.txt", limit: 2 }, ctx());

    expect(result.content).toContain("1|a");
    expect(result.content).toContain("2|b");
    expect(result.content).not.toContain("3|c");
  });

  it("offset + limit 组合", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne", "utf-8");

    const result = await tool.call({ path: "lines.txt", offset: 2, limit: 2 }, ctx());

    expect(result.content).toContain("2|b");
    expect(result.content).toContain("3|c");
    expect(result.content).not.toContain("1|a");
    expect(result.content).not.toContain("4|d");
  });

  // ─── 错误处理 ───

  it("文件不存在返回 isError", async () => {
    const result = await tool.call({ path: "nonexistent.txt" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("File not found");
  });

  it("路径是目录时返回 isError", async () => {
    const dirPath = path.join(tmpDir, "subdir");
    await fs.mkdir(dirPath);

    const result = await tool.call({ path: "subdir" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("directory");
  });

  // ─── 二进制检测 ───

  it("检测到二进制文件时返回 isError", async () => {
    const filePath = path.join(tmpDir, "binary.bin");
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte → binary
    buf.write("text before", 0);
    await fs.writeFile(filePath, buf);

    const result = await tool.call({ path: "binary.bin" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("binary");
  });

  // ─── 工具元信息 ───

  it("声明为只读且可并行", () => {
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isParallelSafe).toBe(true);
    expect(tool.needsPermission).toBe(false);
  });

  it("定义了 maxResultChars", () => {
    expect(tool.maxResultChars).toBeGreaterThan(0);
  });
});
