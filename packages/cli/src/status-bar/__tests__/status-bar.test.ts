import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  type AgentEventMap,
  type IEventBus,
} from "@zhixing/core";
import { createStatusBar } from "../status-bar.js";
import { layout } from "../../tui/style.js";
import type { ScreenController, InputRegion } from "../../screen/index.js";

class FakeScreen implements ScreenController {
  statusLines: readonly string[] | null = null;
  setStatusBarCalls: Array<readonly string[] | null> = [];
  private suspendListeners = new Set<(suspended: boolean) => void>();
  attachInput(_region: InputRegion): void {}
  detachInput(): void {}
  setStatusBar(lines: readonly string[] | null): void {
    this.statusLines = lines;
    this.setStatusBarCalls.push(lines);
  }
  withScrollWrite(_fn: (write: (chunk: string) => void) => void): void {}
  writeScrollLine(_text: string): void {}
  requestInputRepaint(): void {}
  suspend(): void {
    for (const l of this.suspendListeners) l(true);
  }
  resume(): void {
    for (const l of this.suspendListeners) l(false);
  }
  onSuspendChange(listener: (suspended: boolean) => void): () => void {
    this.suspendListeners.add(listener);
    return () => {
      this.suspendListeners.delete(listener);
    };
  }
  dispose(): void {}
}

function setup(): {
  screen: FakeScreen;
  mainBus: IEventBus<AgentEventMap>;
  subBus: IEventBus<AgentEventMap>;
  bar: ReturnType<typeof createStatusBar>;
} {
  const screen = new FakeScreen();
  const mainBus = createEventBus<AgentEventMap>({ lineage: "main" });
  const subBus = createEventBus<AgentEventMap>({
    lineage: "main/sub-1",
    parent: mainBus as never,
  });
  const bar = createStatusBar({ screen, eventBus: mainBus });
  return { screen, mainBus, subBus, bar };
}

describe("StatusBar 状态切换", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("idle → thinking on agent:run_start", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    expect(screen.statusLines).not.toBeNull();
    expect(screen.statusLines!.join("")).toContain("思考中");
    bar.dispose();
  });

  it("thinking → streaming 当首个 stream chunk 到达", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("llm:stream_event", {
      type: "text_delta",
      text: "hello",
    } as never);
    vi.advanceTimersByTime(300);
    expect(screen.statusLines!.join("")).toContain("回复中");
    bar.dispose();
  });

  it("streaming → tool 当 tool:call_start (主 bus) 触发", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("tool:call_start", {
      id: "t1",
      name: "read",
      input: { path: "a.ts" },
    });
    expect(screen.statusLines!.join("")).toContain("调用 read");
    bar.dispose();
  });

  it("tool 完成回 streaming", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("tool:call_start", {
      id: "t1",
      name: "read",
      input: {},
    });
    await mainBus.emit("tool:call_end", {
      id: "t1",
      name: "read",
      success: true,
      result: { content: "ok", isError: false },
      duration: 50,
    } as never);
    expect(screen.statusLines!.join("")).toContain("回复中");
    bar.dispose();
  });

  it("Task（派发型工具）切到 task 状态", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "审查代码" },
    });
    expect(screen.statusLines!.join("")).toContain("子任务");
    expect(screen.statusLines!.join("")).toContain("审查代码");
    bar.dispose();
  });

  it("Task 内子 bus 工具调用更新 subToolName", async () => {
    const { screen, mainBus, subBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x" },
    });
    await subBus.emit("tool:call_start", {
      id: "sub-t1",
      name: "grep",
      input: {},
    });
    expect(screen.statusLines!.join("")).toContain("调用 grep");
    bar.dispose();
  });

  it("agent:run_end completed → done 永驻显示（不再 1.5s 自动消失）", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("agent:run_end", {
      reason: "completed",
      duration: 7300,
      usage: { inputTokens: 1200, outputTokens: 14300 } as never,
    });
    expect(screen.statusLines!.join("")).toContain("用时");
    expect(screen.statusLines!.join("")).toContain("7s");
    // done 永驻——renderSummary 移除后 status-bar 是终止反馈的单一事实源
    vi.advanceTimersByTime(60_000);
    expect(screen.statusLines).not.toBeNull();
    expect(screen.statusLines!.join("")).toContain("用时");
    bar.dispose();
  });

  it("done 被下一次 run_start 覆盖回 thinking", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("agent:run_end", {
      reason: "completed",
      duration: 1000,
      usage: { inputTokens: 100, outputTokens: 200 } as never,
    });
    expect(screen.statusLines!.join("")).toContain("用时");
    await mainBus.emit("agent:run_start", { prompt: "next" });
    expect(screen.statusLines!.join("")).toContain("思考中");
    expect(screen.statusLines!.join("")).not.toContain("用时");
    bar.dispose();
  });

  it("agent:run_end aborted + interrupt:fired esc → done(aborted, esc)", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("interrupt:fired", {
      reason: { kind: "user-cancel", source: "esc", pressedAt: Date.now() },
      interruptedTurnIndex: 0,
      toolGraceMs: 0,
    } as never);
    await mainBus.emit("agent:run_end", {
      reason: "aborted",
      duration: 1500,
      usage: { inputTokens: 100, outputTokens: 200 } as never,
    });
    expect(screen.statusLines!.join("")).toContain("已中断");
    expect(screen.statusLines!.join("")).toContain("esc");
    bar.dispose();
  });

  it("agent:run_end error → done(error) 显示 errorType", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("agent:run_end", {
      reason: "error",
      duration: 500,
      usage: { inputTokens: 0, outputTokens: 0 } as never,
      errorType: "rate_limit",
      error: "quota exceeded",
    } as never);
    expect(screen.statusLines!.join("")).toContain("错误");
    expect(screen.statusLines!.join("")).toContain("rate_limit");
    bar.dispose();
  });

  it("agent:run_end max_turns → done(max_turns) 显示达到上限", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("agent:run_end", {
      reason: "max_turns",
      duration: 5000,
      usage: { inputTokens: 100, outputTokens: 200 } as never,
    } as never);
    expect(screen.statusLines!.join("")).toContain("达到 turn 上限");
    bar.dispose();
  });

  it("compact_start → compacting 状态", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("context:compact_start", {
      tokensBefore: 100_000,
    } as never);
    expect(screen.statusLines!.join("")).toContain("整理上下文");
    bar.dispose();
  });

  it("retry:attempt → retrying 状态", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("retry:attempt", {
      errorType: "rate_limit",
      attempt: 2,
      maxRetries: 3,
      delayMs: 1000,
    } as never);
    const text = screen.statusLines!.join("");
    expect(text).toContain("重试中");
    expect(text).toContain("第 2/3 次");
    bar.dispose();
  });

  // 内容左边距 invariant——所有状态条行必须以 layout.contentPrefix 起首，与 AI 行
  // (`  ◆ ...`) / 工具卡片等其它内容对齐。这是跨场景的视觉契约，由 renderPhase 单一
  // 注入点保证；任何分支（thinking / streaming / tool / done / aborted / error /
  // max_turns / compacting / retrying / interrupting）的输出都该满足。
  describe("内容左边距 invariant", () => {
    it("running 阶段所有状态条行起首是 contentPrefix", async () => {
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      for (const line of screen.statusLines ?? []) {
        expect(line.startsWith(layout.contentPrefix)).toBe(true);
      }
      bar.dispose();
    });

    it("done 阶段（completed）状态条行起首是 contentPrefix", async () => {
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      await mainBus.emit("agent:run_end", {
        reason: "completed",
        durationMs: 7300,
      } as never);
      for (const line of screen.statusLines ?? []) {
        expect(line.startsWith(layout.contentPrefix)).toBe(true);
      }
    });

    it("done 阶段（completed）不显示 token 数据——仅显示时长", async () => {
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      await mainBus.emit("agent:run_end", {
        reason: "completed",
        duration: 1900,
        usage: { inputTokens: 8100, outputTokens: 95 } as never,
      });
      const text = screen.statusLines!.join("");
      // 任务结束后 token 信息不再有意义——仅保留时长反馈
      expect(text).not.toContain("↑");
      expect(text).not.toContain("↓");
      expect(text).not.toContain("8.1k");
      expect(text).toContain("用时");
      bar.dispose();
    });

    it("一轮内 token 跨多次 LLM 请求累加——不被覆盖", async () => {
      // 模拟一轮 user prompt 内的两次 LLM 请求（含工具调用循环）：
      //   request 1 结束 → committed = 12000 / 100
      //   request 2 结束 → committed = 12000+12500 / 100+80 = 24500 / 180
      // 测试的核心：第二次 request 不能覆盖第一次的累加值。
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      await mainBus.emit("llm:request_end", {
        usage: { inputTokens: 12000, outputTokens: 100 },
      } as never);
      await mainBus.emit("llm:request_end", {
        usage: { inputTokens: 12500, outputTokens: 80 },
      } as never);
      // request_end 内部立即 repaint——token 变化立即反映，无需等 ticker
      const text = screen.statusLines!.join("");
      // 24500 → "24.5k"；180 → "180"
      expect(text).toContain("24.5k");
      expect(text).toContain("180");
      bar.dispose();
    });

    it("流式估算与 committed 叠加——request_end 时不双倍计算", async () => {
      // stream chunk 期间 streamingOutput 累加（估算），request_end 时清零并 commit 真值。
      // 这是修复"流式估算 + LLM 真值"双计 bug 的核心 invariant。
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      // 流式 100 字符 → estimateTokens(100) ≈ 40
      await mainBus.emit("llm:stream_event", {
        type: "text_delta",
        text: "a".repeat(100),
      } as never);
      // request_end 给真值 output=200，预期：streamingOutput 清零，committedOutput=200
      // 总显示 output = committedOutput(200) + streamingOutput(0) = 200，**不是** 240
      await mainBus.emit("llm:request_end", {
        usage: { inputTokens: 5000, outputTokens: 200 },
      } as never);
      const text = screen.statusLines!.join("");
      expect(text).toContain("200");
      expect(text).not.toContain("240"); // 防双计回归
      bar.dispose();
    });

    it("流式 chunk 触发立即 repaint——token 累加在过程中实时可见", async () => {
      // 修复"过程中看不到 token"的核心 invariant：stream_event 累加后立即 repaint，
      // 不等 250ms ticker。短 turn (< 250ms) 也能让用户看到 token 增长。
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      const linesBeforeChunk = screen.statusLines!.join("");
      // 起手 thinking 阶段还没 chunk —— 不应有 ↓ 标记
      expect(linesBeforeChunk).not.toContain("↓");

      await mainBus.emit("llm:stream_event", {
        type: "text_delta",
        text: "a".repeat(50),
      } as never);
      // 不 advance time —— 立即 repaint 应已触发
      const linesAfterChunk = screen.statusLines!.join("");
      expect(linesAfterChunk).toContain("↓"); // streamingOutput > 0 → ↓ 段出现
      expect(linesAfterChunk).toContain("回复中"); // thinking → streaming 转换
      bar.dispose();
    });

    it("done 阶段（aborted）状态条行起首是 contentPrefix", async () => {
      const { screen, mainBus, bar } = setup();
      await mainBus.emit("agent:run_start", { prompt: "hi" });
      await mainBus.emit("agent:run_end", {
        reason: "aborted",
        durationMs: 1500,
        abortReason: { kind: "user-cancel", source: "esc" },
      } as never);
      for (const line of screen.statusLines ?? []) {
        expect(line.startsWith(layout.contentPrefix)).toBe(true);
      }
    });
  });

  it("dispose 清空状态条 + 取消订阅", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    bar.dispose();
    expect(screen.statusLines).toBeNull();
    screen.statusLines = ["残留"];
    await mainBus.emit("agent:run_start", { prompt: "again" });
    expect(screen.statusLines).toEqual(["残留"]);
  });
});

describe("StatusBar · alt UI 嵌入协议（ScreenController suspend/resume）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ScreenController suspended 时 status-bar 跳过 setStatusBar——避免 alt UI 期间 paint 任务累积", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    expect(screen.statusLines).not.toBeNull();
    // 模拟 alt UI 进入——FakeScreen 的 suspend 触发 onSuspendChange(true)
    screen.suspend();
    screen.statusLines = null; // 重置观察基线
    screen.setStatusBarCalls.length = 0;
    // suspended 期间任何事件触发 repaint 都应跳过 setStatusBar
    await mainBus.emit("llm:stream_event", {
      type: "text_delta",
      text: "ai 回复内容",
    });
    expect(screen.setStatusBarCalls).toEqual([]);
    bar.dispose();
  });

  it("ScreenController resume 后状态条恢复——按当前 phase 重画", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    screen.suspend();
    screen.setStatusBarCalls.length = 0;
    // alt UI 期间状态字段被事件更新，但 setStatusBar 跳过
    await mainBus.emit("llm:stream_event", {
      type: "text_delta",
      text: "ai 回复",
    });
    expect(screen.setStatusBarCalls).toEqual([]);
    // resume 后恢复 ticker + 重画
    screen.resume();
    expect(screen.setStatusBarCalls.length).toBeGreaterThan(0);
    expect(screen.statusLines).not.toBeNull();
    bar.dispose();
  });

  it("dispose 取消 onSuspendChange 订阅——dispose 后 screen.suspend 不再触发 status-bar 行为", () => {
    const { screen, bar } = setup();
    bar.dispose();
    // dispose 后 screen.suspend 应不再让 status-bar 调 stopTicker / 状态字段——
    // 不应抛错
    expect(() => screen.suspend()).not.toThrow();
    expect(() => screen.resume()).not.toThrow();
  });
});
