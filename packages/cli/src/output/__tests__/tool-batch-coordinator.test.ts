import { describe, expect, it } from "vitest";
import { createToolBatchCoordinator } from "../tool-batch-coordinator.js";
import { stripAnsi } from "../../tui/ansi.js";
import type { CliWriter } from "../../screen/index.js";
import type {
  ReplaceableSegmentHandle,
} from "../../screen/screen-controller.js";
import type { BatchEventSnapshot } from "../../tool-card-format.js";

/**
 * 测试 mock writer ——双形态：
 *   - chrome 模式：beginReplaceableSegment 返回真实 handle（记录 replace/commit/close 序列）
 *   - stdout 模式：beginReplaceableSegment 不实现（退化路径——退化为一次性 line emit 多行）
 *
 * 同时记录 line / ensureSegmentBreak / segment 操作序列，让测试可断言整套
 * 时序契约（不是仅最终态）。
 */

type Event =
  | { kind: "line"; text: string }
  | { kind: "appendInline"; text: string }
  | { kind: "notify"; text: string }
  | { kind: "ensureSegmentBreak" }
  | { kind: "beginReplaceableSegment" }
  | { kind: "seg.replace"; text: string }
  | { kind: "seg.commit"; text: string }
  | { kind: "seg.close" };

interface ChromeMockWriter extends CliWriter {
  events: Event[];
  segments: ReplaceableSegmentHandle[];
}

interface StdoutMockWriter extends CliWriter {
  events: Event[];
}

function makeChromeMock(): ChromeMockWriter {
  const events: Event[] = [];
  const segments: ReplaceableSegmentHandle[] = [];
  const writer: ChromeMockWriter = {
    events,
    segments,
    line(text) {
      events.push({ kind: "line", text });
    },
    appendInline(text) {
      if (text.length === 0) return;
      events.push({ kind: "appendInline", text });
    },
    notify(text) {
      events.push({ kind: "notify", text });
    },
    ensureSegmentBreak() {
      events.push({ kind: "ensureSegmentBreak" });
    },
    beginReplaceableSegment() {
      events.push({ kind: "beginReplaceableSegment" });
      const handle: ReplaceableSegmentHandle = {
        replace(text) {
          events.push({ kind: "seg.replace", text });
        },
        commit(text) {
          events.push({ kind: "seg.commit", text });
        },
        close() {
          events.push({ kind: "seg.close" });
        },
      };
      segments.push(handle);
      return handle;
    },
  };
  return writer;
}

function makeStdoutMock(): StdoutMockWriter {
  const events: Event[] = [];
  return {
    events,
    line(text) {
      events.push({ kind: "line", text });
    },
    appendInline(text) {
      if (text.length === 0) return;
      events.push({ kind: "appendInline", text });
    },
    notify(text) {
      events.push({ kind: "notify", text });
    },
    ensureSegmentBreak() {
      events.push({ kind: "ensureSegmentBreak" });
    },
    // 关键：stdout 退化路径不实现 beginReplaceableSegment（与 createStdoutWriter 行为对称）
  };
}

// ─── 测试用 event 工厂 ───

function mkSuccess(
  name: string,
  input: Record<string, unknown>,
  content: string,
  duration: number,
): BatchEventSnapshot {
  return {
    name,
    input,
    result: { content },
    duration,
  };
}

function mkFailure(
  name: string,
  input: Record<string, unknown>,
  errorContent: string,
  duration: number,
): BatchEventSnapshot {
  return {
    name,
    input,
    result: { content: errorContent, isError: true },
    duration,
  };
}

function mkDiffSuccess(): BatchEventSnapshot {
  return {
    name: "edit",
    input: { path: "auth.ts" },
    result: {
      content: "applied",
      presentation: {
        kind: "file-diff",
        path: "src/auth.ts",
        operation: "modified",
        changeStats: { kind: "exact", addedLines: 1, removedLines: 1 },
        hunks: [
          {
            oldStart: 4,
            oldLines: 2,
            newStart: 4,
            newLines: 2,
            lines: [
              {
                type: "removed",
                oldLineNumber: 4,
                content: "const role = 'user';",
              },
              {
                type: "added",
                newLineNumber: 4,
                content: "const role = 'admin';",
              },
            ],
          },
        ],
      },
    },
    duration: 42,
  };
}

/** 最后一个 seg.replace 的 stripped 文本——便于断言渲染内容 */
function lastReplaceText(writer: ChromeMockWriter): string {
  for (let i = writer.events.length - 1; i >= 0; i--) {
    const e = writer.events[i]!;
    if (e.kind === "seg.replace") return stripAnsi(e.text);
  }
  throw new Error("no seg.replace events recorded");
}

function lastCommitText(writer: ChromeMockWriter): string {
  for (let i = writer.events.length - 1; i >= 0; i--) {
    const e = writer.events[i]!;
    if (e.kind === "seg.commit") return stripAnsi(e.text);
  }
  throw new Error("no seg.commit events recorded");
}

// ─── 测试 ───

describe("ToolBatchCoordinator · chrome 模式（ReplaceableSegment 流式重渲）", () => {
  it("首个 recordSuccess → ensureSegmentBreak + beginSegment + replace", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x\ny\nz", 50));
    const kinds = writer.events.map((e) => e.kind);
    // 顺序：先段间空行声明 → 起 segment → 首次 replace
    expect(kinds).toEqual([
      "ensureSegmentBreak",
      "beginReplaceableSegment",
      "seg.replace",
    ]);
  });

  it("单一类型摘要——用户视角动作短语（read → 「阅读了 N 个文件」）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x\ny\nz", 50));
    const text = lastReplaceText(writer);
    // 检查头部（第一行）的摘要文案——详情行仍含 `Read a.ts` 是预期的（详情
    // 行需要工具名以让用户精确识别每个动作的具体目标）
    const headerLine = text.split("\n")[0]!;
    expect(headerLine).toContain("阅读了 1 个文件 · 50ms");
    expect(headerLine).not.toContain("工具");
    expect(headerLine).not.toContain("Read");
    expect(headerLine).not.toContain("（");
  });

  it("多次 recordSuccess 累积 → 每次都触发 segment.replace（同一 segment 持有）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 20));
    coord.recordSuccess(mkSuccess("glob", { pattern: "*.ts" }, "a\nb", 30));
    expect(writer.segments).toHaveLength(1);
    const replaces = writer.events.filter((e) => e.kind === "seg.replace");
    expect(replaces).toHaveLength(3);
  });

  it("多类型摘要——紧凑动词 + 累计用时（无「工具」字眼、无 PascalCase）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 20));
    coord.recordSuccess(mkSuccess("glob", { pattern: "*.ts" }, "a\nb", 30));
    const text = lastReplaceText(writer);
    expect(text).toContain("阅读 2");
    expect(text).toContain("查找 1");
    expect(text).toContain("60ms");
    expect(text).not.toContain("工具");
    expect(text).not.toContain("×");
  });

  it("3 工具 → 无 ⋮ 折叠行，全部详情入展示", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 20));
    coord.recordSuccess(mkSuccess("read", { path: "c.ts" }, "z", 30));
    const text = lastReplaceText(writer);
    expect(text).not.toContain("⋮");
    // 头部 + 3 详情 = 4 行
    expect(text.split("\n")).toHaveLength(4);
    // 三个详情都在
    expect(text).toContain("Read a.ts");
    expect(text).toContain("Read b.ts");
    expect(text).toContain("Read c.ts");
  });

  it("4+ 工具 → ⋮ +K 折叠 + 仅近邻 3 详情入展示（5 行恒定上限）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 10));
    coord.recordSuccess(mkSuccess("read", { path: "c.ts" }, "z", 10));
    coord.recordSuccess(mkSuccess("read", { path: "d.ts" }, "w", 10));
    coord.recordSuccess(mkSuccess("read", { path: "e.ts" }, "v", 10));
    const text = lastReplaceText(writer);
    expect(text).toContain("⋮ +2"); // 5 总数 - 3 近邻 = 2 折叠
    // 头部 + ⋮ + 3 详情 = 5 行
    expect(text.split("\n")).toHaveLength(5);
    // 最近 3 个详情入展示
    expect(text).toContain("Read c.ts");
    expect(text).toContain("Read d.ts");
    expect(text).toContain("Read e.ts");
    // 早期工具不入展示（被折叠）
    expect(text).not.toContain("Read a.ts");
    expect(text).not.toContain("Read b.ts");
  });

  it("详情行路径取 basename——长绝对路径不显示", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(
      mkSuccess("read", { path: "D:\\ZhixingWorkspace\\src\\index.ts" }, "x\ny", 10),
    );
    const text = lastReplaceText(writer);
    expect(text).toContain("Read index.ts");
    expect(text).not.toContain("D:\\");
  });

  it("closeBatch → segment.commit（替换并冻结）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.closeBatch();
    const commits = writer.events.filter((e) => e.kind === "seg.commit");
    expect(commits).toHaveLength(1);
  });

  it("无 batch 时 closeBatch 是 no-op（幂等）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.closeBatch();
    coord.closeBatch();
    coord.closeBatch();
    expect(writer.events).toEqual([]);
  });

  it("closeBatch 后再 recordSuccess → 起新 segment（新 batch）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.closeBatch();
    coord.recordSuccess(mkSuccess("glob", { pattern: "*.ts" }, "a", 5));
    // 两个独立 segment
    expect(writer.segments).toHaveLength(2);
    // 新 batch 摘要不含旧工具
    const text = lastReplaceText(writer);
    expect(text).toContain("Glob");
    expect(text).not.toContain("Read");
  });
});

describe("ToolBatchCoordinator · 失败破窗", () => {
  it("无 batch 时 recordFailure → 仅 emit 红色独立行（无 segment 起 / 无 commit）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordFailure(
      mkFailure("read", { path: "missing.ts" }, "ENOENT", 10),
    );
    const kinds = writer.events.map((e) => e.kind);
    // ensureSegmentBreak（段间空行）+ 两行 line（header + ⎿ result）
    expect(kinds).toEqual(["ensureSegmentBreak", "line", "line"]);
    expect(writer.segments).toHaveLength(0);
    // header 文本含工具 + target；result 文本含 error
    const lineTexts = writer.events
      .filter((e): e is Event & { kind: "line" } => e.kind === "line")
      .map((e) => stripAnsi(e.text));
    expect(lineTexts[0]).toContain("◆");
    expect(lineTexts[0]).toContain("Read(missing.ts)");
    expect(lineTexts[1]).toContain("⎿");
    expect(lineTexts[1]).toContain("ENOENT");
  });

  it("有 batch 时 recordFailure → 先 commit batch + 再 emit 失败行", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    writer.events.length = 0; // 清空便于断言后续序列
    coord.recordFailure(
      mkFailure("read", { path: "missing.ts" }, "ENOENT", 10),
    );
    const kinds = writer.events.map((e) => e.kind);
    // 顺序：commit 当前 batch（保历史）→ ensureSegmentBreak（与 batch 拉开）→ 两行 line
    expect(kinds).toEqual([
      "seg.commit",
      "ensureSegmentBreak",
      "line",
      "line",
    ]);
  });

  it("recordFailure 后再 recordSuccess → 起新 batch（新 segment）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordFailure(
      mkFailure("read", { path: "missing.ts" }, "ENOENT", 10),
    );
    coord.recordSuccess(mkSuccess("read", { path: "ok.ts" }, "x", 10));
    expect(writer.segments).toHaveLength(1);
    const text = lastReplaceText(writer);
    expect(text).toContain("Read ok.ts");
    // 失败不入 batch
    expect(text).not.toContain("missing.ts");
    expect(text).not.toContain("ENOENT");
  });
});

describe("ToolBatchCoordinator · 副作用工具 recordSideEffect（独立成行 ✎，永不折叠）", () => {
  it("无 batch 时 recordSideEffect → 仅 emit 单行 ✎（dim，无 segment 起 / 无 commit）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSideEffect(
      mkSuccess("edit", { path: "auth.ts" }, "applied", 42),
    );
    const kinds = writer.events.map((e) => e.kind);
    expect(kinds).toEqual(["ensureSegmentBreak", "line"]);
    expect(writer.segments).toHaveLength(0);
    const lineText = stripAnsi(
      (writer.events.find((e) => e.kind === "line")! as Event & { kind: "line" })
        .text,
    );
    expect(lineText).toContain("✎");
    expect(lineText).toContain("Edit auth.ts");
    expect(lineText).toContain("applied");
  });

  it("有 batch 时 recordSideEffect → 先 commit batch + 再 emit ✎ 行", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x\ny", 10));
    writer.events.length = 0;
    coord.recordSideEffect(
      mkSuccess("write", { path: "out.ts" }, "ok", 12),
    );
    const kinds = writer.events.map((e) => e.kind);
    expect(kinds).toEqual(["seg.commit", "ensureSegmentBreak", "line"]);
  });

  it("有 file-diff presentation 时在副作用行下挂 hunk block", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({
      writer,
      columns: () => 100,
    });
    coord.recordSideEffect(mkDiffSuccess());

    const lineTexts = writer.events
      .filter((e): e is Event & { kind: "line" } => e.kind === "line")
      .map((e) => stripAnsi(e.text));

    expect(lineTexts).toHaveLength(4);
    expect(lineTexts[0]).toContain("✎");
    expect(lineTexts[0]).toContain("Modified auth.ts · +1 -1");
    expect(lineTexts[1]).toContain("@@ -4,2 +4,2 @@");
    expect(lineTexts[2]).toContain("- const role = 'user';");
    expect(lineTexts[3]).toContain("4 + const role = 'admin';");
  });

  it("recordSideEffect 后 recordSuccess → 起新探索 batch（副作用不污染 batch）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSideEffect(
      mkSuccess("edit", { path: "auth.ts" }, "applied", 10),
    );
    coord.recordSuccess(mkSuccess("read", { path: "after.ts" }, "x", 5));
    // 新 batch segment 起手；副作用工具不计入 batch.events
    expect(writer.segments).toHaveLength(1);
    const text = lastReplaceText(writer);
    expect(text).toContain("Read after.ts");
    expect(text).not.toContain("Edit");
    expect(text).not.toContain("auth.ts");
  });

  it("连续多个 recordSideEffect → 每个独立成行（不合并 / 不折叠）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSideEffect(mkSuccess("write", { path: "a.ts" }, "ok", 10));
    coord.recordSideEffect(mkSuccess("write", { path: "b.ts" }, "ok", 10));
    coord.recordSideEffect(mkSuccess("edit", { path: "c.ts" }, "applied", 10));
    const lineTexts = writer.events
      .filter((e): e is Event & { kind: "line" } => e.kind === "line")
      .map((e) => stripAnsi(e.text));
    expect(lineTexts).toHaveLength(3);
    expect(lineTexts[0]).toContain("Write a.ts");
    expect(lineTexts[1]).toContain("Write b.ts");
    expect(lineTexts[2]).toContain("Edit c.ts");
    // 每个 ✎ 锚都独立、永不折叠（不出现 ⋮ +K）
    for (const text of lineTexts) {
      expect(text).toContain("✎");
      expect(text).not.toContain("⋮");
    }
  });

  it("stdout 退化路径 recordSideEffect → 正常 emit ✎ 单行（与 chrome 行为对称）", () => {
    const writer = makeStdoutMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSideEffect(mkSuccess("write", { path: "x.ts" }, "ok", 5));
    const lineEvents = writer.events.filter((e) => e.kind === "line");
    expect(lineEvents).toHaveLength(1);
    expect(stripAnsi(lineEvents[0]!.text)).toContain("✎");
    expect(stripAnsi(lineEvents[0]!.text)).toContain("Write x.ts");
  });
});

describe("ToolBatchCoordinator · stdout 退化路径（无 beginReplaceableSegment）", () => {
  it("recordSuccess 不立即 emit（events 累积，等 closeBatch）", () => {
    const writer = makeStdoutMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 10));
    // 仅有第一次 begin batch 触发的 ensureSegmentBreak，不应 emit 任何 line
    const lineEvents = writer.events.filter((e) => e.kind === "line");
    expect(lineEvents).toEqual([]);
  });

  it("closeBatch → 一次性 line emit 多行最终摘要（pipe / CI stream-stable）", () => {
    const writer = makeStdoutMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 10));
    coord.recordSuccess(mkSuccess("glob", { pattern: "*.ts" }, "a\nb", 30));
    coord.recordSuccess(mkSuccess("read", { path: "c.ts" }, "z", 10));
    coord.closeBatch();
    const lineTexts = writer.events
      .filter((e): e is Event & { kind: "line" } => e.kind === "line")
      .map((e) => stripAnsi(e.text));
    // 4 工具（read×3 + glob×1，多类型）→ ⋮ +1 折叠 → 头部 + ⋮ + 3 详情 = 5 行
    expect(lineTexts).toHaveLength(5);
    expect(lineTexts[0]).toContain("阅读 3");
    expect(lineTexts[0]).toContain("查找 1");
    expect(lineTexts[1]).toContain("⋮ +1");
  });

  it("recordFailure 在 stdout 退化也正常 emit 红色独立行", () => {
    const writer = makeStdoutMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordFailure(
      mkFailure("read", { path: "missing.ts" }, "ENOENT", 10),
    );
    const lineEvents = writer.events.filter((e) => e.kind === "line");
    expect(lineEvents).toHaveLength(2);
    expect(stripAnsi(lineEvents[0]!.text)).toContain("Read(missing.ts)");
  });
});

describe("ToolBatchCoordinator · dispose 等价 closeBatch（renderer.stop 析构）", () => {
  it("dispose 时若有活跃 batch → 等价 closeBatch（commit）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.dispose();
    const commits = writer.events.filter((e) => e.kind === "seg.commit");
    expect(commits).toHaveLength(1);
  });

  it("dispose 后再 dispose → no-op（幂等）", () => {
    const writer = makeChromeMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.dispose();
    const eventsBeforeSecondDispose = writer.events.length;
    coord.dispose();
    expect(writer.events.length).toBe(eventsBeforeSecondDispose);
  });

  it("stdout 退化路径 dispose → 一次 line emit 最终摘要（防止 events 丢失）", () => {
    const writer = makeStdoutMock();
    const coord = createToolBatchCoordinator({ writer });
    coord.recordSuccess(mkSuccess("read", { path: "a.ts" }, "x", 10));
    coord.recordSuccess(mkSuccess("read", { path: "b.ts" }, "y", 10));
    coord.dispose();
    const lineEvents = writer.events.filter((e) => e.kind === "line");
    expect(lineEvents.length).toBeGreaterThan(0);
  });
});
