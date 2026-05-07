import { describe, expect, it } from "vitest";
import {
  displayToolName,
  formatToolDuration,
  formatToolHeader,
  formatToolResult,
} from "../tool-card-format.js";
import type { ToolResult } from "@zhixing/core";

describe("displayToolName", () => {
  it("已注册工具走显式 PascalCase 映射", () => {
    expect(displayToolName("read")).toBe("Read");
    expect(displayToolName("write")).toBe("Write");
    expect(displayToolName("bash")).toBe("Bash");
    expect(displayToolName("web_fetch")).toBe("WebFetch");
    expect(displayToolName("Task")).toBe("Task");
  });

  it("未注册工具走 snake_case → PascalCase 通用规则", () => {
    expect(displayToolName("some_new_tool")).toBe("SomeNewTool");
    expect(displayToolName("standalone")).toBe("Standalone");
  });

  it("空段（连续下划线）被过滤", () => {
    expect(displayToolName("a__b")).toBe("AB");
  });
});

describe("formatToolHeader", () => {
  it("文件类工具——path 作 target", () => {
    expect(formatToolHeader("read", { path: "src/foo.ts" })).toBe(
      "Read(src/foo.ts)",
    );
    expect(formatToolHeader("write", { path: "out.txt" })).toBe(
      "Write(out.txt)",
    );
    expect(formatToolHeader("edit", { path: "a.md" })).toBe("Edit(a.md)");
  });

  it("文件类工具——支持 file_path 别名", () => {
    expect(formatToolHeader("read", { file_path: "x.ts" })).toBe("Read(x.ts)");
  });

  it("命令类工具——command 作 target，超长截断", () => {
    expect(formatToolHeader("bash", { command: "ls -la" })).toBe(
      "Bash(ls -la)",
    );
    const longCmd = "a".repeat(80);
    const out = formatToolHeader("bash", { command: longCmd });
    expect(out.length).toBeLessThanOrEqual("Bash()".length + 60);
    expect(out.endsWith("…)")).toBe(true);
  });

  it("模式类工具（grep / glob）——pattern 作 target", () => {
    expect(formatToolHeader("grep", { pattern: "auth" })).toBe('Grep(auth)');
    expect(formatToolHeader("glob", { pattern: "**/*.ts" })).toBe(
      "Glob(**/*.ts)",
    );
  });

  it("Task 工具——description 作 target", () => {
    expect(formatToolHeader("Task", { description: "research X" })).toBe(
      "Task(research X)",
    );
  });

  it("memory 工具——operation 作 target，向后兼容 action 字段", () => {
    expect(formatToolHeader("memory", { operation: "read" })).toBe(
      "Memory(read)",
    );
    expect(formatToolHeader("memory", { action: "write" })).toBe(
      "Memory(write)",
    );
  });

  it("target 为空时省略括号", () => {
    expect(formatToolHeader("schedule", {})).toBe("Schedule");
    expect(formatToolHeader("read", {})).toBe("Read");
  });

  it("未知工具——保留 PascalCase 名，target 退化为空", () => {
    expect(formatToolHeader("unknown_tool", { foo: "bar" })).toBe(
      "UnknownTool",
    );
  });
});

describe("formatToolResult", () => {
  function ok(content: string): ToolResult {
    return { content };
  }
  function err(content: string): ToolResult {
    return { content, isError: true };
  }

  it("失败——error 首行截断", () => {
    expect(formatToolResult("read", err("file not found"), 100)).toBe(
      "file not found",
    );
    expect(
      formatToolResult("read", err("first line\nsecond line"), 100),
    ).toBe("first line");
    const longErr = "x".repeat(200);
    const out = formatToolResult("read", err(longErr), 100);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("失败 content 为空——退化默认错误描述", () => {
    expect(formatToolResult("read", err(""), 100)).toBe("(unknown error)");
  });

  it("read 成功——行数 + lines 单复数", () => {
    expect(formatToolResult("read", ok("a\nb\nc"), 100)).toBe("3 lines");
    expect(formatToolResult("read", ok("a"), 100)).toBe("1 line");
    expect(formatToolResult("read", ok(""), 100)).toBe("0 lines");
  });

  it("write 成功——ok", () => {
    expect(formatToolResult("write", ok("done"), 100)).toBe("ok");
  });

  it("edit 成功——applied", () => {
    expect(formatToolResult("edit", ok("changed"), 100)).toBe("applied");
  });

  it("bash 成功——行数 + 用时", () => {
    expect(formatToolResult("bash", ok("line1\nline2"), 250)).toBe(
      "2 lines · 250ms",
    );
    expect(formatToolResult("bash", ok("only one"), 50)).toBe(
      "1 line · 50ms",
    );
  });

  it("grep 成功——行数即匹配", () => {
    expect(formatToolResult("grep", ok("a:1:foo\nb:2:bar"), 100)).toBe(
      "2 lines",
    );
  });

  it("glob 成功——文件数 + 单复数", () => {
    expect(formatToolResult("glob", ok("a.ts\nb.ts\nc.ts"), 100)).toBe(
      "3 files",
    );
    expect(formatToolResult("glob", ok("only.ts"), 100)).toBe("1 file");
  });

  it("默认工具——仅用时", () => {
    expect(formatToolResult("schedule", ok("queued"), 123)).toBe("123ms");
    expect(formatToolResult("Task", ok("done"), 1500)).toBe("1.5s");
  });

  it("末尾 \\n 不算独立行", () => {
    expect(formatToolResult("read", ok("a\nb\n"), 100)).toBe("2 lines");
  });
});

describe("formatToolDuration", () => {
  it("亚秒级——ms 精度", () => {
    expect(formatToolDuration(0)).toBe("0ms");
    expect(formatToolDuration(123)).toBe("123ms");
    expect(formatToolDuration(999)).toBe("999ms");
  });

  it("秒级——一位小数", () => {
    expect(formatToolDuration(1000)).toBe("1.0s");
    expect(formatToolDuration(1500)).toBe("1.5s");
    expect(formatToolDuration(7345)).toBe("7.3s");
  });
});
