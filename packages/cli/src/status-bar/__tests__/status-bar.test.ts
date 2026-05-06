import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  type AgentEventMap,
  type IEventBus,
} from "@zhixing/core";
import { createStatusBar } from "../status-bar.js";
import type { ScreenController, InputRegion } from "../../screen/index.js";

class FakeScreen implements ScreenController {
  statusLines: readonly string[] | null = null;
  setStatusBarCalls: Array<readonly string[] | null> = [];
  attachInput(_region: InputRegion): void {}
  detachInput(): void {}
  setStatusBar(lines: readonly string[] | null): void {
    this.statusLines = lines;
    this.setStatusBarCalls.push(lines);
  }
  withScrollWrite(_fn: (write: (chunk: string) => void) => void): void {}
  requestInputRepaint(): void {}
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

  it("agent:run_end 切到 done 然后 1.5s 后 idle", async () => {
    const { screen, mainBus, bar } = setup();
    await mainBus.emit("agent:run_start", { prompt: "hi" });
    await mainBus.emit("agent:run_end", {
      reason: "completed",
      duration: 7300,
      usage: { inputTokens: 1200, outputTokens: 14300 } as never,
    });
    expect(screen.statusLines!.join("")).toContain("完成于");
    expect(screen.statusLines!.join("")).toContain("7.3s");
    vi.advanceTimersByTime(1600);
    expect(screen.statusLines).toBeNull();
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
