import { describe, expect, it } from "vitest";
import { createOutputRenderer } from "../output-renderer.js";
import { stripAnsi } from "../../tui/ansi.js";
import type { CliWriter } from "../../screen/index.js";
import type {
  ReplaceableSegmentHandle,
} from "../../screen/screen-controller.js";

/**
 * 测试 mock writer ——双轨记录 + chrome 模式（提供 beginReplaceableSegment）：
 *   - `buffer`：累积输出（用于内容断言：◆ 锚、Read(...)、error 文本等字面包含）
 *   - `events`：调用序列（用于编排断言：ensureSegmentBreak / line / 段操作 顺序）
 *
 * chrome 模式让 batch coordinator 走 ReplaceableSegment 流式路径——测试覆盖
 * "coordinator 接管 tool_end / closeBatch 在边界触发"的契约。stdout 退化路径
 * （无 beginReplaceableSegment）的行为单独在 tool-batch-coordinator.test.ts 覆盖。
 */
type CaptureEvent =
  | { kind: "line"; text: string }
  | { kind: "appendInline"; text: string }
  | { kind: "notify"; text: string }
  | { kind: "ensureSegmentBreak" }
  | { kind: "beginReplaceableSegment" }
  | { kind: "seg.replace"; text: string }
  | { kind: "seg.commit"; text: string }
  | { kind: "seg.close" };

interface CapturedWriter extends CliWriter {
  buffer: string;
  events: CaptureEvent[];
  segments: ReplaceableSegmentHandle[];
}

function makeCaptureWriter(): CapturedWriter {
  let buffer = "";
  const events: CaptureEvent[] = [];
  const segments: ReplaceableSegmentHandle[] = [];

  const writer: CapturedWriter = {
    get buffer() {
      return buffer;
    },
    get events() {
      return events;
    },
    get segments() {
      return segments;
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
    beginReplaceableSegment() {
      events.push({ kind: "beginReplaceableSegment" });
      const handle: ReplaceableSegmentHandle = {
        replace(text) {
          events.push({ kind: "seg.replace", text });
        },
        commit(text) {
          events.push({ kind: "seg.commit", text });
          // commit 时把内容追加进 buffer 让内容断言可见
          buffer += stripAnsi(text);
          if (!text.endsWith("\n")) buffer += "\n";
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

describe("createOutputRenderer · 工具事件分流", () => {
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

  it("Task 工具 tool_start → 主路径不直接 emit（sub-agent-status 接管视觉）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    // Task 自身不产生 line / segment.replace 等渲染操作
    expect(writer.events.some((e) => e.kind === "line")).toBe(false);
    expect(writer.events.some((e) => e.kind === "beginReplaceableSegment")).toBe(
      false,
    );
  });

  it("Task 工具 tool_end → 主路径完全静默（不入 batch、不破窗）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 100,
    });
    expect(writer.events).toEqual([]);
  });

  it("side-effect 工具 tool_end (success) → 独立成行 ✎（不入 batch，不开 segment）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "edit",
      input: { path: "auth.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "edit",
      result: { content: "applied", isError: false },
      duration: 42,
    });
    // 副作用走 line emit，不开 segment
    expect(writer.segments).toHaveLength(0);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("✎");
    expect(out).toContain("Edit auth.ts");
    expect(out).toContain("applied");
  });

  it("混合 read + edit + read → 探索入 batch、edit 独立成行 ✎、新探索起新 batch", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 探索 1：read
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
      result: { content: "x", isError: false },
      duration: 5,
    });
    // 副作用：edit
    renderer.handleEvent({
      type: "tool_start",
      id: "t2",
      name: "edit",
      input: { path: "auth.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t2",
      name: "edit",
      result: { content: "applied", isError: false },
      duration: 12,
    });
    // 验证 1：read
    renderer.handleEvent({
      type: "tool_start",
      id: "t3",
      name: "read",
      input: { path: "b.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t3",
      name: "read",
      result: { content: "y", isError: false },
      duration: 5,
    });
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // 探索类应起两个独立 batch（edit 在中间破窗）
    expect(writer.segments).toHaveLength(2);
    const out = stripAnsi(writer.buffer);
    // 三者都可见
    expect(out).toContain("Read a.ts");
    expect(out).toContain("Edit auth.ts");
    expect(out).toContain("Read b.ts");
    // 副作用锚 ✎ 出现
    expect(out).toContain("✎");
  });

  it("default 工具 tool_end (success) → coordinator 接管：起 segment + replace 累积", () => {
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
    // coordinator 起 segment 并 replace，未触发 line（折叠展示由 segment 持有）
    const kinds = writer.events.map((e) => e.kind);
    expect(kinds).toContain("beginReplaceableSegment");
    expect(kinds).toContain("seg.replace");
    // 不再以 line 形式 emit 工具卡片（旧契约已废弃）
    expect(writer.events.filter((e) => e.kind === "line")).toHaveLength(0);
  });

  it("失败工具 tool_end → 破窗 emit 红色独立 ◆ 行（含 Action(target) + ⎿ + error）", () => {
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
    expect(out).toContain("⎿");
    expect(out).toContain("ENOENT: no such file");
  });

  it("混合序列 read + Task + write —— Task 静默 / read 入 batch / write 走 ✎ 副作用单行", () => {
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
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    // 关键契约：read 进 batch 起 1 segment；Task 主路径静默；write 是副作用走
    // 独立 ✎ 行（不入 batch、不开 segment）—— 故 segments.length === 1
    expect(writer.segments).toHaveLength(1);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Read");
    expect(out).toContain("Write b.ts");
    expect(out).toContain("✎"); // 副作用锚
    expect(out).not.toContain("Task "); // Task 主路径不渲染
  });

  it("turn_complete 清理未配对的 pendingToolInputs（异常路径防御）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 异常路径：tool_start 后流被打断，无 tool_end；turn_complete 兜底清理
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
    // 下一轮 —— 同 id（orphan）的 tool_end input 应已被清理（退化为空 input）
    renderer.handleEvent({
      type: "tool_end",
      id: "orphan",
      name: "read",
      result: { content: "x\ny", isError: false },
      duration: 5,
    });
    // batch 详情行的 target 来自 input.path——清理后退化为空 target，
    // 仅显示 `Read · 2 lines` 而非 `Read a.ts · 2 lines`
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 2,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Read");
    expect(out).not.toContain("Read a.ts");
  });
});

describe("createOutputRenderer · 段间编排（coordinator + ensureSegmentBreak）", () => {
  // 架构契约：
  //   - 每个 batch 起手由 coordinator 内部调 ensureSegmentBreak（段间空行）+
  //     beginReplaceableSegment（流式重渲基础）
  //   - text_delta 起手前调 closeBatch（释放 segment 让 mdStream 可安全 begin）
  //     + 自身 ensureSegmentBreak（paragraph 起手空行）
  //   - turn_complete 触发 closeBatch（commit batch）
  //   - sub-agent-status 工具 start 触发 closeBatch（让 status-bar 接管视觉）

  it("text_delta 起手前 closeBatch + ensureSegmentBreak（释放 segment 防嵌套）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 先开一个 batch
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
      duration: 5,
    });
    // 此时有活跃 batch segment。下一个 text_delta 必须先 commit
    renderer.handleEvent({ type: "text_delta", text: "段落内容" });
    renderer.stop();
    // 必须有至少一个 seg.commit（关闭旧 batch）
    expect(writer.events.some((e) => e.kind === "seg.commit")).toBe(true);
    // commit 必须发生在 text_delta 引发的 ensureSegmentBreak 之前
    const commitIdx = writer.events.findIndex((e) => e.kind === "seg.commit");
    // 后续才出现 paragraph 内容 emit
    const firstAppendIdx = writer.events.findIndex(
      (e) => e.kind === "appendInline",
    );
    expect(firstAppendIdx).toBeGreaterThan(commitIdx);
  });

  it("turn_complete 触发 closeBatch（commit segment）", () => {
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
      duration: 5,
    });
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(writer.events.filter((e) => e.kind === "seg.commit")).toHaveLength(
      1,
    );
  });

  it("Task tool_start 触发 closeBatch（让 status-bar 接管 sub-agent-status 视觉）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 一个 default 工具进 batch
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
      duration: 5,
    });
    // Task tool_start 触发 closeBatch（commit segment）
    renderer.handleEvent({
      type: "tool_start",
      id: "t2",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    expect(writer.events.some((e) => e.kind === "seg.commit")).toBe(true);
  });

  it("text_delta 纯空白前导被过滤——不创建 mdStream、不调 closeBatch", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 纯 \n / 空格 起手——output-renderer 跳过（避免起一个 paragraph 锚但什么都没说）
    renderer.handleEvent({ type: "text_delta", text: "  \n\n" });
    expect(writer.events).toEqual([]);
  });

  it("renderer.stop → coordinator.dispose 触发 closeBatch（commit segment）", () => {
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
      duration: 5,
    });
    renderer.stop();
    expect(writer.events.filter((e) => e.kind === "seg.commit")).toHaveLength(
      1,
    );
  });
});

// ─── Thinking rolling tail ─────────────────────────────────────────────
//
// 覆盖产品契约 (详见 output-renderer.ts thinking_block_* case 注释):
//   - thinking 流: 边界事件触发 segment 生命周期 (begin → replace → close)
//   - rolling: 内容 > 2 行时第一行加 "..." 标识
//   - 防御 cleanup: text_delta / stop 时关闭悬挂 thinking segment
//   - 降级: 无 thinking_block_start 的 thinking_delta 走 appendInline 旧路径
//
// 不覆盖: 60ms flush 节流 (依赖 timer,通过 thinking_block_end 同步 flush 验证
// 最终内容正确性即可;timer 逻辑由 setTimeout/clearTimeout 标准实现保证)。

describe("createOutputRenderer · thinking rolling tail", () => {
  it("thinking_block_start → delta* → thinking_block_end: begin + replace + close 完整 segment 生命周期", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({ type: "thinking_delta", thinking: "思考内容" });
    renderer.handleEvent({ type: "thinking_block_end" });

    // begin / close 各一次,replace 至少一次 (thinking_block_end 路径强制 flush)
    expect(
      writer.events.filter((e) => e.kind === "beginReplaceableSegment"),
    ).toHaveLength(1);
    expect(writer.events.filter((e) => e.kind === "seg.close")).toHaveLength(1);
    const replaces = writer.events.filter((e) => e.kind === "seg.replace");
    expect(replaces.length).toBeGreaterThanOrEqual(1);

    // 最终 replace 内容含 ┊ 前缀 + thinking 文本 (dim 着色,stripAnsi 后断言)
    const finalReplace = replaces[replaces.length - 1];
    if (finalReplace?.kind === "seg.replace") {
      expect(stripAnsi(finalReplace.text)).toContain("┊ 思考内容");
    }
  });

  it("rolling: thinking 内容超过 2 行时第一行加 '...' 标识", () => {
    const writer = makeCaptureWriter();
    // 用 columns=20 制造短行,3 段 \n 强制 3 行 → 滚出第一行
    const renderer = createOutputRenderer({ writer, columns: 20 });

    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({
      type: "thinking_delta",
      thinking: "line1\nline2\nline3",
    });
    renderer.handleEvent({ type: "thinking_block_end" });

    const replaces = writer.events.filter((e) => e.kind === "seg.replace");
    expect(replaces.length).toBeGreaterThanOrEqual(1);
    const finalReplace = replaces[replaces.length - 1];
    if (finalReplace?.kind === "seg.replace") {
      const stripped = stripAnsi(finalReplace.text);
      // 应显示后两行 (line2 / line3),第一显示行加 "..." 标识
      expect(stripped).toContain("...line2");
      expect(stripped).toContain("┊ line3");
      // 不含 line1 (已滚出)
      expect(stripped).not.toContain("line1");
    }
  });

  it("段间空行: thinking 含空行时空行被过滤,'...' 不单独占行(回归 bug 锁死)", () => {
    // LLM thinking 输出常含段间空行(如思考分段),早期实现按 \n 切后空段进入
    // visibleLines,slice(-2) 可能取到 ["", "实质内容"],第一行加 "..." 拼空内容
    // 产生单独 "┊ ..." 行 —— 与"...总是与实质内容同行"产品契约相悖。
    // 本测试锁死过滤空行的契约。
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({
      type: "thinking_delta",
      thinking: "用户问候\n\n让我简洁回复",
    });
    renderer.handleEvent({ type: "thinking_block_end" });

    const replaces = writer.events.filter((e) => e.kind === "seg.replace");
    const finalReplace = replaces[replaces.length - 1];
    expect(finalReplace?.kind).toBe("seg.replace");
    if (finalReplace?.kind === "seg.replace") {
      const stripped = stripAnsi(finalReplace.text);
      // 应是两行实质内容,空段过滤后总数 2 → 未滚出 → 无 "..."
      expect(stripped).toContain("┊ 用户问候");
      expect(stripped).toContain("┊ 让我简洁回复");
      // 不应出现单独 "┊ ..." 行
      expect(stripped).not.toMatch(/┊\s*\.\.\.\s*$/m);
    }
  });

  it("段间空行 + 滚出: 多段含空行,'...' 拼接到最旧的实质内容前", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({
      type: "thinking_delta",
      thinking: "段1\n\n段2\n\n段3",
    });
    renderer.handleEvent({ type: "thinking_block_end" });

    const replaces = writer.events.filter((e) => e.kind === "seg.replace");
    const finalReplace = replaces[replaces.length - 1];
    if (finalReplace?.kind === "seg.replace") {
      const stripped = stripAnsi(finalReplace.text);
      // 过滤空行后 3 行,slice(-2)=[段2, 段3],第一行加 "..."
      expect(stripped).toContain("...段2");
      expect(stripped).toContain("┊ 段3");
      expect(stripped).not.toContain("段1");
    }
  });

  it("防御 cleanup: text_delta 到达时若 thinking segment 还在,先 close 再开 markdown 段", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    // 模拟异常路径: thinking_block_start + delta,但没 thinking_block_end
    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({ type: "thinking_delta", thinking: "悬挂 thinking" });
    // text_delta 直接到来 (假设 adapter 漏 emit end)
    renderer.handleEvent({ type: "text_delta", text: "正式回复" });

    // thinking segment 应被 close (防御性 cleanup),不悬挂
    expect(writer.events.filter((e) => e.kind === "seg.close")).toHaveLength(1);
    // 时序: thinking ensureSegmentBreak → thinking segment begin → close (text_delta
    // 防御) → text 段 ensureSegmentBreak → markdown begin。close 必须在 text 段
    // 的 ensureSegmentBreak 之前 (单一活跃 segment 约束: markdown 段 begin 前
    // 必须释放 thinking segment)。
    const closeIdx = writer.events.findIndex((e) => e.kind === "seg.close");
    const ensureBreakIndices = writer.events
      .map((e, i) => (e.kind === "ensureSegmentBreak" ? i : -1))
      .filter((i) => i >= 0);
    // 应至少两次 ensureSegmentBreak: thinking 段开始时 + text 段开始时
    expect(ensureBreakIndices.length).toBeGreaterThanOrEqual(2);
    const textSegEnsureBreakIdx = ensureBreakIndices[ensureBreakIndices.length - 1];
    expect(closeIdx).toBeLessThan(textSegEnsureBreakIdx!);
  });

  it("stop() 关闭悬挂 thinking segment (dispose 路径)", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    renderer.handleEvent({ type: "thinking_block_start" });
    renderer.handleEvent({ type: "thinking_delta", thinking: "悬挂" });
    renderer.stop();

    expect(writer.events.filter((e) => e.kind === "seg.close")).toHaveLength(1);
  });

  it("降级: 无 thinking_block_start 的 thinking_delta 走 appendInline 旧路径 (异常路径兜底)", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer, columns: 80 });

    // 不发 thinking_block_start,直接 thinking_delta (协议漂移 / 跨 provider 续聊兜底)
    renderer.handleEvent({ type: "thinking_delta", thinking: "降级显示" });

    // 无 segment 创建,内容走 appendInline 保留(不丢失)
    expect(
      writer.events.filter((e) => e.kind === "beginReplaceableSegment"),
    ).toHaveLength(0);
    const appendEvents = writer.events.filter(
      (e) => e.kind === "appendInline",
    );
    expect(appendEvents).toHaveLength(1);
    if (appendEvents[0]?.kind === "appendInline") {
      expect(stripAnsi(appendEvents[0].text)).toBe("降级显示");
    }
  });
});
