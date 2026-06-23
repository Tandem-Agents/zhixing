import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GrepResultsPresentationArtifact, ToolResult } from "@zhixing/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createGrepTool } from "../grep.js";

describe("Grep Tool", () => {
  const tool = createGrepTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("grep");
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  async function writeFixture(relativePath: string, content: string): Promise<void> {
    const filePath = path.join(tmpDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }

  async function writeFixtureBytes(relativePath: string, content: Buffer): Promise<void> {
    const filePath = path.join(tmpDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  function expectGrepPresentation(result: ToolResult): GrepResultsPresentationArtifact {
    expect(result.presentation?.kind).toBe("grep-results");
    if (result.presentation?.kind !== "grep-results") {
      throw new Error("Expected grep-results presentation");
    }
    return result.presentation;
  }

  // ──────────────────────────────────────
  // 基本搜索
  // ──────────────────────────────────────

  describe("基本搜索", () => {
    it("找到匹配行", async () => {
      await writeFixture("hello.ts", 'const msg = "hello world";\nconsole.log(msg);');

      const result = await tool.call({ pattern: "hello" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("hello world");
      expect(result.content).toContain("hello.ts");

      const presentation = expectGrepPresentation(result);
      expect(presentation).toMatchObject({
        kind: "grep-results",
        matchedFileCount: 1,
        matchedLineCount: 1,
        query: {
          pattern: "hello",
          outputMode: "content",
          regexDialect: "line-regexp",
          caseSensitivity: "sensitive",
          contextLines: 2,
        },
      });
      expect(presentation.files[0]?.displayPath).toBe("hello.ts");
      expect(JSON.stringify(presentation)).not.toContain(tmpDir);
    });

    it("支持正则表达式", async () => {
      await writeFixture("code.ts", "const foo = 1;\nconst bar = 2;\nlet baz = 3;");

      const result = await tool.call({ pattern: "^const\\s+\\w+" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("const foo");
      expect(result.content).toContain("const bar");
    });

    it("支持 ASCII 大小写不敏感搜索", async () => {
      await writeFixture("case.ts", "FOO\nfoo\nK");

      const result = await tool.call(
        {
          pattern: "foo",
          case_sensitivity: "ascii-insensitive",
        },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("FOO");
      const presentation = expectGrepPresentation(result);
      expect(presentation.query.caseSensitivity).toBe("ascii-insensitive");
      expect(presentation.matchedLineCount).toBe(2);
    });

    it("支持 ASCII 词边界", async () => {
      await writeFixture("words.ts", "foo\nfoobar\n变量foo变量");

      const result = await tool.call(
        { pattern: "\\bfoo\\b", context_lines: 0 },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      const presentation = expectGrepPresentation(result);
      expect(presentation.matchedLineCount).toBe(2);
      expect(result.content).toContain("变量foo变量");
      expect(result.content).not.toContain("foobar");
    });

    it("在单个文件中搜索", async () => {
      await writeFixture("target.ts", "line1\ntarget line\nline3");
      await writeFixture("other.ts", "target in other file");

      const result = await tool.call(
        { pattern: "target", path: "target.ts" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("target line");
    });

    it("在指定目录中搜索", async () => {
      await writeFixture("src/app.ts", "findMe here");
      await writeFixture("test/app.test.ts", "findMe in test");

      const result = await tool.call(
        { pattern: "findMe", path: "src" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("findMe here");
      expect(result.content).not.toContain("findMe in test");
    });
  });

  // ──────────────────────────────────────
  // Glob 过滤
  // ──────────────────────────────────────

  describe("Glob 过滤", () => {
    it("按扩展名过滤", async () => {
      await writeFixture("code.ts", "searchTerm in ts");
      await writeFixture("code.js", "searchTerm in js");
      await writeFixture("readme.md", "searchTerm in md");

      const result = await tool.call(
        { pattern: "searchTerm", glob: "*.ts" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("code.ts");
      expect(result.content).not.toContain("code.js");
      expect(result.content).not.toContain("readme.md");
    });

    it("支持花括号语法", async () => {
      await writeFixture("a.ts", "match here");
      await writeFixture("b.tsx", "match here too");
      await writeFixture("c.js", "match not here");

      const result = await tool.call(
        { pattern: "match", glob: "*.{ts,tsx}" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("a.ts");
      expect(result.content).toContain("b.tsx");
      expect(result.content).not.toContain("c.js");
    });
  });

  // ──────────────────────────────────────
  // 输出模式
  // ──────────────────────────────────────

  describe("输出模式", () => {
    it("files 模式只返回文件名", async () => {
      await writeFixture("a.ts", "target content");
      await writeFixture("b.ts", "no match");
      await writeFixture("c.ts", "target content again");

      const result = await tool.call(
        { pattern: "target", output_mode: "files" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("a.ts");
      expect(result.content).toContain("c.ts");
      expect(result.content).not.toContain("b.ts");

      const presentation = expectGrepPresentation(result);
      expect(presentation.query.outputMode).toBe("files");
      expect(presentation.files.map((file) => file.displayPath)).toEqual([
        "a.ts",
        "c.ts",
      ]);
    });

    it("count 模式返回匹配计数", async () => {
      await writeFixture("multi.ts", "foo\nbar\nfoo\nfoo");

      const result = await tool.call(
        { pattern: "foo", output_mode: "count" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("3");

      const presentation = expectGrepPresentation(result);
      expect(presentation.query.outputMode).toBe("count");
      expect(presentation.matchedLineCount).toBe(3);
    });
  });

  // ──────────────────────────────────────
  // 上下文行
  // ──────────────────────────────────────

  describe("上下文行", () => {
    it("默认显示上下文", async () => {
      const lines = ["line1", "line2", "TARGET", "line4", "line5"];
      await writeFixture("ctx.ts", lines.join("\n"));

      const result = await tool.call(
        { pattern: "TARGET", path: "ctx.ts" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      // 默认 2 行上下文
      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
      expect(result.content).toContain("TARGET");
      expect(result.content).toContain("line4");
      expect(result.content).toContain("line5");
    });

    it("context_lines=0 不显示上下文", async () => {
      const lines = ["line1", "line2", "TARGET", "line4", "line5"];
      await writeFixture("noctx.ts", lines.join("\n"));

      const result = await tool.call(
        { pattern: "TARGET", path: "noctx.ts", context_lines: 0 },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("TARGET");
      expect(result.content).not.toContain("line1");
      expect(result.content).not.toContain("line5");
    });
  });

  // ──────────────────────────────────────
  // 自动排除
  // ──────────────────────────────────────

  describe("自动排除", () => {
    it("排除 node_modules", async () => {
      await writeFixture("src/app.ts", "findThis");
      await writeFixture("node_modules/pkg/index.js", "findThis");

      const result = await tool.call({ pattern: "findThis" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("src/app.ts");
      expect(result.content).not.toContain("node_modules");
    });
  });

  // ──────────────────────────────────────
  // 无匹配
  // ──────────────────────────────────────

  describe("无匹配", () => {
    it("无匹配时返回友好提示", async () => {
      await writeFixture("file.ts", "some content");

      const result = await tool.call({ pattern: "nonexistent" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("No matches found");
      const presentation = expectGrepPresentation(result);
      expect(presentation.files).toEqual([]);
      expect(presentation.matchedLineCount).toBe(0);
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

    it("无效正则报错", async () => {
      const result = await tool.call({ pattern: "[invalid" }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain("line-regexp");
    });

    it("不存在的路径报错", async () => {
      const result = await tool.call(
        { pattern: "x", path: "nonexistent" },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  // ──────────────────────────────────────
  // 边界情况
  // ──────────────────────────────────────

  describe("边界情况", () => {
    it("跳过二进制文件", async () => {
      const binaryContent = "text before\0binary data\0more binary";
      await writeFixture("binary.dat", binaryContent);
      await writeFixture("text.txt", "text searchable content");

      const result = await tool.call({ pattern: "text" }, ctx());

      expect(result.content).toContain("text.txt");
      expect(result.content).not.toContain("binary.dat");
    });

    it("处理多文件匹配", async () => {
      await writeFixture("b.ts", "common pattern");
      await writeFixture("a.ts", "common pattern");
      await writeFixture("sub/c.ts", "common pattern");

      const result = await tool.call({ pattern: "common pattern" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("3 files");
      const presentation = expectGrepPresentation(result);
      expect(presentation.files.map((file) => file.displayPath)).toEqual([
        "a.ts",
        "b.ts",
        "sub/c.ts",
      ]);
    });

    it("按核心编码策略搜索 UTF-16 BOM 文件", async () => {
      await writeFixtureBytes(
        "utf16.txt",
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("alpha\r\nfoo\r\nomega", "utf16le"),
        ]),
      );

      const result = await tool.call({ pattern: "^foo$" }, ctx());

      expect(result.isError).toBeUndefined();
      const presentation = expectGrepPresentation(result);
      expect(presentation.files[0]?.matches[0]).toMatchObject({
        line: 2,
        text: { text: "foo", truncated: false },
      });
    });

    it("按核心行模型处理孤立 CR", async () => {
      await writeFixture("cr.txt", "foo\rother");

      const result = await tool.call({ pattern: "^other$" }, ctx());

      expect(result.isError).toBeUndefined();
      const presentation = expectGrepPresentation(result);
      expect(presentation.files[0]?.matches[0]).toMatchObject({
        line: 2,
        text: { text: "other", truncated: false },
      });
    });

    it("裁剪超长行并暴露行级截断元数据", async () => {
      await writeFixture("long.txt", `foo-${"x".repeat(800)}`);

      const result = await tool.call({ pattern: "foo" }, ctx());

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("[line truncated:");
      const presentation = expectGrepPresentation(result);
      expect(presentation.files[0]?.matches[0]?.text).toMatchObject({
        truncated: true,
      });
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

    it("名称为 grep", () => {
      expect(tool.name).toBe("grep");
    });
  });
});
