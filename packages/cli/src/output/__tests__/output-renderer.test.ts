import { describe, expect, it } from "vitest";
import { createOutputRenderer } from "../output-renderer.js";
import { stripAnsi } from "../../tui/ansi.js";
import type { CliWriter } from "../../screen/index.js";

/**
 * 测试 mock writer —— 双轨记录：
 *   - `buffer`：累积输出（用于内容断言：`◆ Read(...)` 等字面包含检查）
 *   - `events`：调用序列（用于编排断言：ensureSegmentBreak 在何时被调）
 *
 * 模仿 StdoutWriter 行为（直输 + ensureSegmentBreak no-op）—— 与生产中
 * StdoutWriter "无 chrome 视觉协调" 的契约一致。chrome 模式下 ScreenWriter 的
 * 段间视觉效果由 cli-writer.test.ts ScreenWriter 单测专门验证。
 */
interface CapturedWriter extends CliWriter {
  buffer: string;
  events: Array<{ kind: "line" | "appendInline" | "notify" | "ensureSegmentBreak"; text?: string }>;
}

function makeCaptureWriter(): CapturedWriter {
  let buffer = "";
  const events: CapturedWriter["events"] = [];

  return {
    get buffer() {
      return buffer;
    },
    get events() {
      return events;
    },
    line(text) {
      events.push({ kind: "line", text });
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
    appendInline(text) {
      if (text.length === 0) return;
      events.push({ kind: "appendInline", text });
      buffer += text;
    },
    notify(text) {
      events.push({ kind: "notify", text });
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
    ensureSegmentBreak() {
      events.push({ kind: "ensureSegmentBreak" });
    },
  } as CapturedWriter;
}

describe("createOutputRenderer · 工具卡片渲染", () => {
  it("default 工具 tool_start 不立即写 scrollback——进行中视觉由状态条接管", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    expect(writer.buffer).toBe("");
  });

  it("Task 工具 tool_start → 主路径完全静默（sub-agent-status 接管）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    expect(writer.buffer).toBe("");
  });

  it("Task 工具 tool_end → 主路径完全静默", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 100,
    });
    expect(writer.buffer).toBe("");
  });

  it("default 工具 tool_end 渲染 ◆ Action(target) + ⎿ result 双行卡片", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "read",
      result: { content: "line1\nline2\nline3", isError: false },
      duration: 50,
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("◆");
    expect(out).toContain("Read(a.ts)");
    expect(out).toContain("⎿");
    expect(out).toContain("3 lines");
  });

  it("失败工具 tool_end —— ◆ 锚 + Action(target) + error 首行", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "missing.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "read",
      result: { content: "ENOENT: no such file", isError: true },
      duration: 10,
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("◆");
    expect(out).toContain("Read(missing.ts)");
    expect(out).toContain("ENOENT: no such file");
  });

  it("混合序列 read + Task + write —— Task 静默 / read 与 write 各产生卡片", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "t1",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t1",
      name: "read",
      result: { content: "ok", isError: false },
      duration: 10,
    });
    renderer.handleEvent({
      type: "tool_start",
      id: "t2",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t2",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 1000,
    });
    renderer.handleEvent({
      type: "tool_start",
      id: "t3",
      name: "write",
      input: { path: "b.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t3",
      name: "write",
      result: { content: "done", isError: false },
      duration: 5,
    });

    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Read(a.ts)");
    expect(out).toContain("Write(b.ts)");
    expect(out).not.toContain("Task(");
    // ◆ 锚出现两次（read + write 各一）
    const anchors = out.match(/◆/g) ?? [];
    expect(anchors.length).toBe(2);
  });

  it("turn_complete 清理未配对的 pendingToolInputs（防御性 invariant）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 异常路径：tool_start 后流被打断，没有 tool_end，turn_complete 兜底清理
    renderer.handleEvent({
      type: "tool_start",
      id: "orphan",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // 下一轮起步——同 id（orphan）的 tool_end 不应再渲染（缓存已清理，input 退化为空）
    renderer.handleEvent({
      type: "tool_end",
      id: "orphan",
      name: "read",
      result: { content: "x\ny", isError: false },
      duration: 5,
    });
    const out = stripAnsi(writer.buffer);
    // header 退化为 `Read`（无 target），证明 input 已被 turn_complete 清理
    expect(out).toContain("Read");
    expect(out).not.toContain("Read(a.ts)");
  });

  describe("段间编排（ensureSegmentBreak 在每个独立 segment 起手处声明）", () => {
    // 架构契约：output-renderer 在每个独立 segment（tool 卡片 / 新 paragraph）
    // 起手处主动调 writer.ensureSegmentBreak() 声明段边界。底层 ScreenWriter
    // 据此 emit 视觉间距；StdoutWriter no-op 保持 stream 格式稳定。
    //
    // 测试关注点：编排（output-renderer 是否在正确时机调 ensureSegmentBreak），
    // 而非底层视觉效果（视觉间距由 cli-writer.test.ts 单测 ScreenWriter 转发
    // 行为验证）。本套测试只断言"调用序列"，不依赖具体 writer 实现的视觉机制。

    /** 抓取所有 ensureSegmentBreak 调用相对于 line/appendInline 调用的索引位置 */
    const segmentBreakIndices = (writer: CapturedWriter): number[] =>
      writer.events
        .map((e, i) => (e.kind === "ensureSegmentBreak" ? i : -1))
        .filter((i) => i >= 0);

    it("每个 tool_end 起手前调一次 ensureSegmentBreak（卡间编排）", () => {
      const writer = makeCaptureWriter();
      const renderer = createOutputRenderer({ writer });
      for (const id of ["t1", "t2", "t3"]) {
        renderer.handleEvent({
          type: "tool_start",
          id,
          name: "read",
          input: { path: `${id}.ts` },
        });
        renderer.handleEvent({
          type: "tool_end",
          id,
          name: "read",
          result: { content: "ok", isError: false },
          duration: 5,
        });
      }
      // 3 个 tool_end → 3 次 ensureSegmentBreak
      expect(segmentBreakIndices(writer)).toHaveLength(3);
      // 每个 ensureSegmentBreak 紧跟 2 行 line（header + result）
      for (const idx of segmentBreakIndices(writer)) {
        expect(writer.events[idx + 1]?.kind).toBe("line");
        expect(writer.events[idx + 2]?.kind).toBe("line");
      }
    });

    it("text_delta 首次 feed 前调一次 ensureSegmentBreak（paragraph 起手编排）", () => {
      const writer = makeCaptureWriter();
      const renderer = createOutputRenderer({ writer });
      renderer.handleEvent({ type: "text_delta", text: "段落内容" });
      renderer.stop();
      // 至少 1 次 ensureSegmentBreak（paragraph 起手）
      const breaks = segmentBreakIndices(writer);
      expect(breaks.length).toBeGreaterThanOrEqual(1);
      // 首个 ensureSegmentBreak 在第一次 appendInline / line 之前
      const firstBreak = breaks[0]!;
      const firstContent = writer.events.findIndex(
        (e) => e.kind === "appendInline" || e.kind === "line",
      );
      expect(firstBreak).toBeLessThan(firstContent);
    });

    it("paragraph → tool → paragraph 编排：3 个 segment 边界各调一次 ensureSegmentBreak", () => {
      const writer = makeCaptureWriter();
      const renderer = createOutputRenderer({ writer });
      // paragraph A
      renderer.handleEvent({ type: "text_delta", text: "段落 A" });
      // tool 卡片（flushTextStream 关闭 mdStream）
      renderer.handleEvent({
        type: "tool_start",
        id: "t1",
        name: "read",
        input: { path: "x.ts" },
      });
      renderer.handleEvent({
        type: "tool_end",
        id: "t1",
        name: "read",
        result: { content: "ok", isError: false },
        duration: 5,
      });
      // paragraph B（mdStream 已 null → 重新创建 + 触发 ensureSegmentBreak）
      renderer.handleEvent({ type: "text_delta", text: "段落 B" });
      renderer.stop();
      // 3 次 ensureSegmentBreak：paragraph A 起手 / tool_end 起手 / paragraph B 起手
      expect(segmentBreakIndices(writer)).toHaveLength(3);
    });

    it("text_delta 纯空白前导被过滤——不创建 mdStream、不调 ensureSegmentBreak", () => {
      const writer = makeCaptureWriter();
      const renderer = createOutputRenderer({ writer });
      // 纯 \n / 空格 起手——output-renderer 跳过（避免起一个 ◆ 锚但什么都没说）
      renderer.handleEvent({ type: "text_delta", text: "  \n\n" });
      expect(segmentBreakIndices(writer)).toEqual([]);
    });
  });
});
