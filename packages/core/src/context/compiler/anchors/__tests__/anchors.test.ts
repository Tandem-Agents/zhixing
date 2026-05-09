import { describe, expect, it } from "vitest";
import type {
  ToolResultBlock,
  ToolUseBlock,
} from "../../../../types/messages.js";
import {
  AnchorRegistry,
  bashAnchor,
  createDefaultAnchorRegistry,
  editAnchor,
  fallbackAnchor,
  globAnchor,
  grepAnchor,
  readAnchor,
  webFetchAnchor,
  writeAnchor,
  type AnchorGenerator,
} from "../index.js";

// ─── 测试辅助 ───

function use(
  name: string,
  input: Record<string, unknown> = {},
  id = "use-1",
): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function result(
  content: string,
  isError = false,
  toolUseId = "use-1",
): ToolResultBlock {
  return { type: "tool_result", toolUseId, content, isError };
}

// ─── per-tool generator ───

describe("readAnchor", () => {
  it("成功：含 path 与行数", () => {
    const out = readAnchor.generate(
      use("read", { path: "src/foo.ts" }),
      result("line1\nline2\nline3"),
    );
    expect(out).toBe("[read src/foo.ts, 3 lines]");
  });

  it("失败：不含行数", () => {
    const out = readAnchor.generate(
      use("read", { path: "src/foo.ts" }),
      result("ENOENT", true),
    );
    expect(out).toBe("[read src/foo.ts, error]");
  });

  it("缺 path 返 null（让 registry fallback）", () => {
    const out = readAnchor.generate(use("read", {}), result("x"));
    expect(out).toBeNull();
  });
});

describe("bashAnchor", () => {
  it("成功：含 command + ok + 行数", () => {
    const out = bashAnchor.generate(
      use("bash", { command: "ls -la" }),
      result("file1\nfile2"),
    );
    expect(out).toBe('[bash "ls -la", ok, 2 lines]');
  });

  it("失败：error 标记", () => {
    const out = bashAnchor.generate(
      use("bash", { command: "false" }),
      result("exit 1", true),
    );
    expect(out).toBe('[bash "false", error, 1 lines]');
  });

  it("长 command 截断到 80 字符", () => {
    const longCmd = "x".repeat(120);
    const out = bashAnchor.generate(
      use("bash", { command: longCmd }),
      result("ok"),
    );
    // 含截断省略号
    expect(out).toContain("…");
    expect(out!.length).toBeLessThan(120);
  });

  it("多行 command 单行化", () => {
    const out = bashAnchor.generate(
      use("bash", { command: "echo a\necho b" }),
      result(""),
    );
    expect(out).toBe('[bash "echo a echo b", ok, 1 lines]');
  });

  it("缺 command 返 null", () => {
    const out = bashAnchor.generate(use("bash", {}), result("x"));
    expect(out).toBeNull();
  });
});

describe("grepAnchor", () => {
  it("成功：仅计非空行", () => {
    const content = "file1.ts:10:match\n\nfile2.ts:5:match\n";
    const out = grepAnchor.generate(
      use("grep", { pattern: "TODO" }),
      result(content),
    );
    expect(out).toBe('[grep "TODO", 2 match lines]');
  });

  it("空结果：0 matches", () => {
    const out = grepAnchor.generate(
      use("grep", { pattern: "missing" }),
      result(""),
    );
    expect(out).toBe('[grep "missing", 0 match lines]');
  });

  it("失败", () => {
    const out = grepAnchor.generate(
      use("grep", { pattern: "[" }),
      result("invalid regex", true),
    );
    expect(out).toBe('[grep "[", error]');
  });
});

describe("globAnchor", () => {
  it("成功：行数 = matches", () => {
    const out = globAnchor.generate(
      use("glob", { pattern: "**/*.ts" }),
      result("a.ts\nb.ts\nc.ts"),
    );
    expect(out).toBe('[glob "**/*.ts", 3 matches]');
  });

  it("空匹配", () => {
    const out = globAnchor.generate(
      use("glob", { pattern: "**/*.xyz" }),
      result(""),
    );
    expect(out).toBe('[glob "**/*.xyz", 0 matches]');
  });
});

describe("editAnchor", () => {
  it("成功 / 失败", () => {
    expect(
      editAnchor.generate(use("edit", { path: "a.ts" }), result("ok")),
    ).toBe("[edit a.ts, ok]");
    expect(
      editAnchor.generate(
        use("edit", { path: "a.ts" }),
        result("err", true),
      ),
    ).toBe("[edit a.ts, error]");
  });

  it("缺 path 返 null", () => {
    expect(editAnchor.generate(use("edit", {}), result("x"))).toBeNull();
  });
});

describe("writeAnchor", () => {
  it("成功 / 失败", () => {
    expect(
      writeAnchor.generate(use("write", { path: "a.ts" }), result("ok")),
    ).toBe("[write a.ts, ok]");
    expect(
      writeAnchor.generate(
        use("write", { path: "a.ts" }),
        result("denied", true),
      ),
    ).toBe("[write a.ts, error]");
  });
});

describe("webFetchAnchor", () => {
  it("成功：含 url + chars", () => {
    const out = webFetchAnchor.generate(
      use("web_fetch", { url: "https://example.com" }),
      result("x".repeat(500)),
    );
    expect(out).toBe("[web_fetch https://example.com, 500 chars]");
  });

  it("长 url 截断", () => {
    const longUrl = `https://example.com/${"x".repeat(200)}`;
    const out = webFetchAnchor.generate(
      use("web_fetch", { url: longUrl }),
      result("ok"),
    );
    expect(out).toContain("…");
  });

  it("失败", () => {
    const out = webFetchAnchor.generate(
      use("web_fetch", { url: "https://x.invalid" }),
      result("DNS error", true),
    );
    expect(out).toBe("[web_fetch https://x.invalid, error]");
  });
});

// ─── fallback ───

describe("fallbackAnchor", () => {
  it("未知工具：包含工具名 + 状态 + 长度", () => {
    const out = fallbackAnchor(
      use("unknown_tool", { foo: "bar" }),
      result("hello"),
    );
    expect(out).toBe("[unknown_tool, ok, 5 chars]");
  });

  it("失败状态", () => {
    const out = fallbackAnchor(
      use("unknown_tool"),
      result("oops", true),
    );
    expect(out).toBe("[unknown_tool, error, 4 chars]");
  });
});

// ─── registry ───

describe("AnchorRegistry", () => {
  it("派发到对应 generator", () => {
    const reg = new AnchorRegistry().register(readAnchor);
    const out = reg.generate(
      use("read", { path: "x.ts" }),
      result("a\nb"),
    );
    expect(out).toBe("[read x.ts, 2 lines]");
  });

  it("未注册工具走 fallback", () => {
    const reg = new AnchorRegistry();
    const out = reg.generate(use("custom_tool"), result("hi"));
    expect(out).toBe("[custom_tool, ok, 2 chars]");
  });

  it("generator 返 null 时走 fallback", () => {
    const partialGen: AnchorGenerator = {
      toolName: "partial",
      generate: () => null,
    };
    const reg = new AnchorRegistry().register(partialGen);
    const out = reg.generate(
      use("partial"),
      result("content"),
    );
    expect(out).toBe("[partial, ok, 7 chars]");
  });

  it("registerAll 批量", () => {
    const reg = new AnchorRegistry().registerAll([readAnchor, bashAnchor]);
    expect(
      reg.generate(use("read", { path: "a.ts" }), result("x")),
    ).toBe("[read a.ts, 1 lines]");
    expect(
      reg.generate(use("bash", { command: "ls" }), result("x")),
    ).toBe('[bash "ls", ok, 1 lines]');
  });

  it("同名 register 覆盖前者", () => {
    const reg = new AnchorRegistry().register(readAnchor);
    const overrideGen: AnchorGenerator = {
      toolName: "read",
      generate: () => "[read OVERRIDE]",
    };
    reg.register(overrideGen);
    expect(
      reg.generate(use("read", { path: "x" }), result("y")),
    ).toBe("[read OVERRIDE]");
  });
});

// ─── default registry ───

describe("createDefaultAnchorRegistry", () => {
  it("内置覆盖 7 个工具 + 未注册走 fallback", () => {
    const reg = createDefaultAnchorRegistry();

    expect(
      reg.generate(use("read", { path: "x.ts" }), result("a\nb")),
    ).toBe("[read x.ts, 2 lines]");
    expect(
      reg.generate(use("bash", { command: "ls" }), result("a")),
    ).toBe('[bash "ls", ok, 1 lines]');
    expect(
      reg.generate(use("grep", { pattern: "x" }), result("hit")),
    ).toBe('[grep "x", 1 match lines]');
    expect(
      reg.generate(use("glob", { pattern: "*.ts" }), result("a.ts")),
    ).toBe('[glob "*.ts", 1 matches]');
    expect(
      reg.generate(use("edit", { path: "a.ts" }), result("ok")),
    ).toBe("[edit a.ts, ok]");
    expect(
      reg.generate(use("write", { path: "a.ts" }), result("ok")),
    ).toBe("[write a.ts, ok]");
    expect(
      reg.generate(
        use("web_fetch", { url: "https://x.com" }),
        result("h".repeat(10)),
      ),
    ).toBe("[web_fetch https://x.com, 10 chars]");

    // 未注册工具走 fallback
    expect(reg.generate(use("schedule"), result("ok"))).toBe(
      "[schedule, ok, 2 chars]",
    );
  });
});
