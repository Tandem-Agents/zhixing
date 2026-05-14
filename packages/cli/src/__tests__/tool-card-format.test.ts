import { describe, expect, it } from "vitest";
import {
  type BatchEventSnapshot,
  displayToolName,
  formatBatchDetailLine,
  formatBatchSummary,
  formatToolDuration,
  formatToolHeader,
  formatToolResult,
} from "../tool-card-format.js";
import type { ToolResult } from "@zhixing/core";

// ─── 测试用 event 工厂 ───

function mkEvent(
  name: string,
  input: Record<string, unknown>,
  content: string,
  duration: number,
): BatchEventSnapshot {
  return { name, input, result: { content }, duration };
}

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

  it("用户拒绝场景——含 reason 时输出「已拒绝 · <reason>」（user-facing 翻译）", () => {
    // secure-executor 生成的 LLM-facing prompt 模板：
    //   "用户拒绝了这次工具调用。用户的反馈:<reason>。请根据该反馈调整方案。"
    // cli 显示给用户时换成简洁 user-facing 文案，不暴露 LLM 指令
    expect(
      formatToolResult(
        "bash",
        err(
          "用户拒绝了这次工具调用。用户的反馈:不要用 rm -rf,改用 rm -i。请根据该反馈调整方案。",
        ),
        100,
      ),
    ).toBe("已拒绝 · 不要用 rm -rf,改用 rm -i");
  });

  it("用户拒绝场景——无 reason 时输出「已拒绝」", () => {
    expect(
      formatToolResult("bash", err("用户拒绝了这次工具调用。"), 100),
    ).toBe("已拒绝");
  });

  it("用户拒绝场景——模板未来变化时 fallback「已拒绝」（不暴露原 LLM prompt）", () => {
    // prefix 匹配但 reason 正则不匹配的边界——譬如未来 secure-executor 文案改成
    // 「用户拒绝了这次工具调用。原因是 X。」之类，cli 至少安全降级为「已拒绝」
    expect(
      formatToolResult(
        "bash",
        err("用户拒绝了这次工具调用。某种新文案不含反馈字段。"),
        100,
      ),
    ).toBe("已拒绝");
  });

  it("用户拒绝场景——非该场景错误走原 error 首行截断路径", () => {
    expect(formatToolResult("read", err("file not found"), 100)).toBe(
      "file not found",
    );
  });

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

describe("formatBatchSummary", () => {
  it("0 工具——空 batch 边界（caller 应避免，函数 robust）", () => {
    expect(formatBatchSummary([])).toBe("无动作 · 0ms");
  });

  it("单一类型 read——完整短语「阅读了 N 个文件」+ 完成时态", () => {
    expect(
      formatBatchSummary([mkEvent("read", { path: "a.ts" }, "x", 50)]),
    ).toBe("阅读了 1 个文件 · 50ms");
    expect(
      formatBatchSummary([
        mkEvent("read", { path: "a.ts" }, "x", 50),
        mkEvent("read", { path: "b.ts" }, "y", 50),
      ]),
    ).toBe("阅读了 2 个文件 · 100ms");
  });

  it("单一类型 glob——「查找了 N 次」（动作次数量词）", () => {
    expect(
      formatBatchSummary([mkEvent("glob", { pattern: "*.ts" }, "a", 27)]),
    ).toBe("查找了 1 次 · 27ms");
  });

  it("单一类型 grep——「搜索了 N 次」", () => {
    expect(
      formatBatchSummary([
        mkEvent("grep", { pattern: "foo" }, "a\nb", 30),
        mkEvent("grep", { pattern: "bar" }, "c", 20),
      ]),
    ).toBe("搜索了 2 次 · 50ms");
  });

  it("单一类型 bash——「执行了 N 条命令」", () => {
    expect(
      formatBatchSummary([
        mkEvent("bash", { command: "ls" }, "out", 100),
        mkEvent("bash", { command: "pwd" }, "out", 50),
      ]),
    ).toBe("执行了 2 条命令 · 150ms");
  });

  it("单一类型 web_fetch / task_list / memory——各自量词", () => {
    expect(
      formatBatchSummary([
        mkEvent("web_fetch", { url: "http://a" }, "x", 200),
      ]),
    ).toBe("获取了 1 个链接 · 200ms");
    expect(
      formatBatchSummary([mkEvent("task_list", { items: [] }, "ok", 10)]),
    ).toBe("更新了 1 次任务 · 10ms");
    expect(
      formatBatchSummary([
        mkEvent("memory", { action: "search" }, "x", 30),
        mkEvent("memory", { action: "save" }, "y", 50),
      ]),
    ).toBe("使用记忆 2 次 · 80ms");
  });

  it("多类型——紧凑动词「阅读 N · 查找 N」按首次出现顺序拼接", () => {
    const events = [
      mkEvent("read", { path: "a.ts" }, "x", 100),
      mkEvent("read", { path: "b.ts" }, "y", 200),
      mkEvent("glob", { pattern: "*.ts" }, "a\nb", 300),
    ];
    expect(formatBatchSummary(events)).toBe("阅读 2 · 查找 1 · 600ms");
  });

  it("多类型分类顺序 = 首次出现顺序（不是字母序、不是高频优先）", () => {
    const events = [
      mkEvent("glob", { pattern: "*.ts" }, "x", 10),
      mkEvent("read", { path: "a.ts" }, "y", 10),
      mkEvent("bash", { command: "ls" }, "z", 10),
      mkEvent("read", { path: "b.ts" }, "w", 10),
    ];
    // 首次出现顺序 glob → read → bash —— 与用户内心「AI 先做了什么」一致
    expect(formatBatchSummary(events)).toBe(
      "查找 1 · 阅读 2 · 执行 1 · 40ms",
    );
  });

  it("未注册工具——fallback「调用 ${DisplayName} N 次」/ 紧凑「${DisplayName} N」", () => {
    // 单一类型 fallback
    expect(
      formatBatchSummary([
        mkEvent("future_tool", { foo: "bar" }, "x", 100),
        mkEvent("future_tool", { foo: "baz" }, "y", 50),
      ]),
    ).toBe("调用 FutureTool 2 次 · 150ms");
    // 多类型 fallback（混入已知工具）
    expect(
      formatBatchSummary([
        mkEvent("read", { path: "a.ts" }, "x", 10),
        mkEvent("custom_op", { foo: "bar" }, "y", 20),
      ]),
    ).toBe("阅读 1 · CustomOp 1 · 30ms");
  });

  it("用时累加跨越秒级阈值——formatToolDuration 自动切换", () => {
    const events = [
      mkEvent("read", { path: "a.ts" }, "x", 500),
      mkEvent("read", { path: "b.ts" }, "y", 800),
    ];
    expect(formatBatchSummary(events)).toContain("1.3s");
  });

  it("不暴露「工具」字眼 + 不暴露 PascalCase 工具名（已知工具）", () => {
    const text = formatBatchSummary([
      mkEvent("read", { path: "a.ts" }, "x", 10),
      mkEvent("glob", { pattern: "*.ts" }, "y", 10),
    ]);
    expect(text).not.toContain("工具");
    expect(text).not.toContain("Read");
    expect(text).not.toContain("Glob");
    expect(text).not.toContain("×");
    expect(text).not.toContain("（");
  });
});

describe("formatBatchDetailLine", () => {
  it("文件类工具——target 取 basename（不显示绝对路径）", () => {
    expect(
      formatBatchDetailLine(
        mkEvent("read", { path: "D:\\Workspace\\src\\index.ts" }, "a\nb", 10),
      ),
    ).toBe("Read index.ts · 2 lines");
    expect(
      formatBatchDetailLine(
        mkEvent("read", { path: "/long/posix/path/foo.ts" }, "a", 10),
      ),
    ).toBe("Read foo.ts · 1 line");
  });

  it("路径无分隔符——整段返回", () => {
    expect(
      formatBatchDetailLine(mkEvent("read", { path: "foo.ts" }, "x", 10)),
    ).toBe("Read foo.ts · 1 line");
  });

  it("命令类工具——按 BATCH_DETAIL_TARGET_TRUNCATE (40) 限制", () => {
    const longCmd = "a".repeat(50);
    const out = formatBatchDetailLine(
      mkEvent("bash", { command: longCmd }, "ok", 100),
    );
    // bash 详情含 "Bash <40字>… · 1 line · 100ms" —— 截断到 40 字
    expect(out).toMatch(/^Bash a{39}…/);
  });

  it("模式类工具（grep / glob）——pattern 作 target", () => {
    expect(
      formatBatchDetailLine(
        mkEvent("glob", { pattern: "**/*.ts" }, "a\nb\nc", 10),
      ),
    ).toBe("Glob **/*.ts · 3 files");
  });

  it("target 为空时省略空格 + target（避免双空格）", () => {
    expect(formatBatchDetailLine(mkEvent("schedule", {}, "ok", 123))).toBe(
      "Schedule · 123ms",
    );
  });

  it("未知工具——PascalCase + 默认 result（用时）", () => {
    expect(
      formatBatchDetailLine(
        mkEvent("custom_tool", { foo: "bar" }, "data", 50),
      ),
    ).toBe("CustomTool · 50ms");
  });
});
