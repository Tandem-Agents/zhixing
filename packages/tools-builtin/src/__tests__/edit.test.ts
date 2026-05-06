import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createEditTool } from "../edit.js";

describe("Edit Tool", () => {
  const tool = createEditTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("edit");
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  async function writeFixture(name: string, content: string): Promise<string> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async function readFixture(name: string): Promise<string> {
    return fs.readFile(path.join(tmpDir, name), "utf-8");
  }

  // ──────────────────────────────────────
  // 单匹配替换（核心路径）
  // ──────────────────────────────────────

  describe("单匹配替换", () => {
    it("替换文件中唯一匹配的文本", async () => {
      await writeFixture("hello.txt", "hello world");

      const result = await tool.call(
        { path: "hello.txt", old_string: "hello", new_string: "goodbye" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Replaced");
      expect(await readFixture("hello.txt")).toBe("goodbye world");
    });

    it("替换多行文本", async () => {
      const content = "line1\nline2\nline3\nline4";
      await writeFixture("multi.txt", content);

      const result = await tool.call(
        { path: "multi.txt", old_string: "line2\nline3", new_string: "replaced2\nreplaced3" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("multi.txt")).toBe("line1\nreplaced2\nreplaced3\nline4");
    });

    it("保留缩进和空白", async () => {
      const content = "function foo() {\n    const x = 1;\n    return x;\n}";
      await writeFixture("indent.ts", content);

      const result = await tool.call(
        { path: "indent.ts", old_string: "    const x = 1;", new_string: "    const x = 42;" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("indent.ts")).toContain("const x = 42;");
    });

    it("支持绝对路径", async () => {
      const absPath = await writeFixture("abs.txt", "old content");

      const result = await tool.call(
        { path: absPath, old_string: "old", new_string: "new" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("abs.txt")).toBe("new content");
    });
  });

  // ──────────────────────────────────────
  // 删除（new_string 为空字符串）
  // ──────────────────────────────────────

  describe("删除文本", () => {
    it("空 new_string 删除匹配文本", async () => {
      await writeFixture("delete.txt", "keep this remove this keep this too");

      const result = await tool.call(
        { path: "delete.txt", old_string: "remove this ", new_string: "" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("Deleted");
      expect(await readFixture("delete.txt")).toBe("keep this keep this too");
    });

    it("删除整行（含换行符）", async () => {
      await writeFixture("lines.txt", "line1\ndelete-me\nline3");

      const result = await tool.call(
        { path: "lines.txt", old_string: "delete-me\n", new_string: "" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("lines.txt")).toBe("line1\nline3");
    });
  });

  // ──────────────────────────────────────
  // replace_all
  // ──────────────────────────────────────

  describe("replace_all", () => {
    it("替换所有匹配项", async () => {
      await writeFixture("multi-match.txt", "foo bar foo baz foo");

      const result = await tool.call(
        { path: "multi-match.txt", old_string: "foo", new_string: "qux", replace_all: true },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toContain("3 occurrences");
      expect(await readFixture("multi-match.txt")).toBe("qux bar qux baz qux");
    });

    it("replace_all 对单个匹配也正常工作", async () => {
      await writeFixture("single.txt", "only one match");

      const result = await tool.call(
        { path: "single.txt", old_string: "one", new_string: "1", replace_all: true },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("single.txt")).toBe("only 1 match");
    });

    it("replace_all 删除所有匹配项", async () => {
      await writeFixture("del-all.txt", "a,b,c,d");

      const result = await tool.call(
        { path: "del-all.txt", old_string: ",", new_string: "", replace_all: true },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("del-all.txt")).toBe("abcd");
    });
  });

  // ──────────────────────────────────────
  // 零匹配错误
  // ──────────────────────────────────────

  describe("零匹配错误", () => {
    it("找不到文本时返回有帮助的错误", async () => {
      await writeFixture("nomatch.txt", "actual content\nline 2\nline 3");

      const result = await tool.call(
        { path: "nomatch.txt", old_string: "does not exist", new_string: "replacement" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
      expect(result.content).toContain("nomatch.txt");
      // 应该显示文件前几行帮助 LLM
      expect(result.content).toContain("actual content");
      // 应该建议使用 read 工具
      expect(result.content).toContain("read tool");
    });

    it("replace_all 模式下零匹配也报错", async () => {
      await writeFixture("nomatch2.txt", "some content");

      const result = await tool.call(
        { path: "nomatch2.txt", old_string: "nonexistent", new_string: "x", replace_all: true },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });
  });

  // ──────────────────────────────────────
  // 多重匹配错误（replace_all=false）
  // ──────────────────────────────────────

  describe("多重匹配错误", () => {
    it("多个匹配时返回错误并报告行号", async () => {
      const content = "const x = 1;\nconst y = 2;\nconst z = 3;";
      await writeFixture("ambiguous.txt", content);

      const result = await tool.call(
        { path: "ambiguous.txt", old_string: "const", new_string: "let" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("3 matches");
      expect(result.content).toContain("lines:");
      // 建议包含更多上下文或使用 replace_all
      expect(result.content).toContain("replace_all");
    });

    it("文件不被修改", async () => {
      const content = "foo foo foo";
      await writeFixture("nochange.txt", content);

      await tool.call(
        { path: "nochange.txt", old_string: "foo", new_string: "bar" },
        ctx(),
      );

      expect(await readFixture("nochange.txt")).toBe(content);
    });
  });

  // ──────────────────────────────────────
  // 参数验证
  // ──────────────────────────────────────

  describe("参数验证", () => {
    it("old_string 为空时报错", async () => {
      await writeFixture("param.txt", "content");

      const result = await tool.call(
        { path: "param.txt", old_string: "", new_string: "x" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("must not be empty");
    });

    it("old_string 和 new_string 相同时报错", async () => {
      await writeFixture("same.txt", "content");

      const result = await tool.call(
        { path: "same.txt", old_string: "content", new_string: "content" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("identical");
    });
  });

  // ──────────────────────────────────────
  // 文件错误
  // ──────────────────────────────────────

  describe("文件错误", () => {
    it("文件不存在时报错", async () => {
      const result = await tool.call(
        { path: "nonexistent.txt", old_string: "x", new_string: "y" },
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
    it("替换文件中的全部内容", async () => {
      await writeFixture("full.txt", "entire content");

      const result = await tool.call(
        { path: "full.txt", old_string: "entire content", new_string: "new entire content" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("full.txt")).toBe("new entire content");
    });

    it("包含特殊字符的文本", async () => {
      const content = 'regex: /^foo\\.bar$/g\npath: C:\\Users\\test';
      await writeFixture("special.txt", content);

      const result = await tool.call(
        { path: "special.txt", old_string: "/^foo\\.bar$/g", new_string: "/^baz$/g" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      const newContent = await readFixture("special.txt");
      expect(newContent).toContain("/^baz$/g");
      expect(newContent).toContain("C:\\Users\\test");
    });

    it("替换空行和空白字符", async () => {
      const content = "before\n\n\nafter";
      await writeFixture("blank.txt", content);

      const result = await tool.call(
        { path: "blank.txt", old_string: "\n\n\n", new_string: "\n" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      expect(await readFixture("blank.txt")).toBe("before\nafter");
    });

    it("大文件中的单次替换", async () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
      lines[499] = "TARGET LINE";
      await writeFixture("large.txt", lines.join("\n"));

      const result = await tool.call(
        { path: "large.txt", old_string: "TARGET LINE", new_string: "REPLACED LINE" },
        ctx(),
      );

      expect(result.isError).toBeUndefined();
      const newContent = await readFixture("large.txt");
      expect(newContent).toContain("REPLACED LINE");
      expect(newContent).not.toContain("TARGET LINE");
    });
  });

  // ──────────────────────────────────────
  // 工具元信息
  // ──────────────────────────────────────

  describe("工具元信息", () => {
    it("声明为非只读、不可并行、需要权限", () => {
      expect(tool.isReadOnly).toBe(false);
      expect(tool.isParallelSafe).toBe(false);
      expect(tool.needsPermission).toBe(true);
    });

    it("名称为 edit", () => {
      expect(tool.name).toBe("edit");
    });
  });
});
