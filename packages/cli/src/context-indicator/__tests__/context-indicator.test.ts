/**
 * ContextIndicator 单测 —— 验证多源事件订阅 + setStatusTail 投递契约。
 *
 * 测试边界：组件只负责"订阅事件 → 合成 → 投递段"：
 *   - 订阅 context:tokens_snapshot → 渲染 ~ Xk
 *   - 订阅 llm:request_end → 合成 (cache Yk) 后缀
 *   - 不订阅 agent:run_start（per-run 装配下 cache 跨 run 自然消失，详见模块 docstring）
 *   - dispose 取消订阅但不撤段（跨 run 保留最后快照）
 *   - 格式契约：~ 前缀 + 可选 (cache N) 后缀
 *
 * 不测：ScreenController 真实行为（多段拼接由 screen-controller.test.ts 覆盖）；
 * 不测：core 端 emit 时机（turn-end.test.ts 覆盖）；
 * 不测：provider 端 cacheReadTokens 解析（providers/__tests__ 覆盖）。
 */

import { describe, expect, it } from "vitest";
import { createEventBus } from "@zhixing/core";
import type { AgentEventMap, IEventBus } from "@zhixing/core";
import type { ScreenController } from "../../screen/index.js";
import { createContextIndicator } from "../context-indicator.js";

// ─── Stub ───

function makeScreenSpy(): {
  setStatusTail: (id: string, text: string | null) => void;
  calls: { id: string; text: string | null }[];
} {
  const calls: { id: string; text: string | null }[] = [];
  return {
    calls,
    setStatusTail(id, text) {
      calls.push({ id, text });
    },
  };
}

function setup(): {
  screen: ReturnType<typeof makeScreenSpy>;
  bus: IEventBus<AgentEventMap>;
  handle: ReturnType<typeof createContextIndicator>;
} {
  const screen = makeScreenSpy();
  const bus = createEventBus<AgentEventMap>();
  const handle = createContextIndicator({
    screen: screen as unknown as ScreenController,
    eventBus: bus,
  });
  return { screen, bus, handle };
}

// ─── 订阅与渲染 ───

describe("ContextIndicator · 订阅 + 渲染", () => {
  it("emit 后用稳定 id 'context' 调 setStatusTail，文本带 ~ 前缀", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", {
      totalTokens: 13099,
      turnCount: 1,
    });
    expect(screen.calls).toHaveLength(1);
    expect(screen.calls[0]!.id).toBe("context");
    expect(screen.calls[0]!.text).toBe("~ 13.1k");
  });

  it("多次 emit → 每次都刷新段（保 last-wins 语义）", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 1000, turnCount: 1 });
    await bus.emit("context:tokens_snapshot", { totalTokens: 25000, turnCount: 2 });
    expect(screen.calls).toHaveLength(2);
    expect(screen.calls[0]!.text).toBe("~ 1.0k");
    expect(screen.calls[1]!.text).toBe("~ 25.0k");
  });

  it("totalTokens ≤ 0 防御 → 跳过 setStatusTail 调用", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 0, turnCount: 1 });
    await bus.emit("context:tokens_snapshot", { totalTokens: -5, turnCount: 1 });
    expect(screen.calls).toHaveLength(0);
  });

  it("dispose 取消订阅但不撤段（跨 run 保留最后快照，与 status-bar done 态同模式）", async () => {
    const { screen, bus, handle } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    expect(screen.calls).toHaveLength(1);

    const callsBefore = screen.calls.length;
    handle.dispose();
    // dispose 不应再调 setStatusTail —— 段保留显示，等下次 run 的 first emit 覆盖
    expect(screen.calls.length).toBe(callsBefore);

    // 之后 emit 也不触发（订阅已撤）
    await bus.emit("context:tokens_snapshot", { totalTokens: 99999, turnCount: 9 });
    expect(screen.calls.length).toBe(callsBefore);
  });

  it("小于 1000 的 token 数无 k 后缀（formatTokens 契约）", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 999, turnCount: 1 });
    expect(screen.calls[0]!.text).toBe("~ 999");
  });
});

// ─── 多源合成（context + cache） ───

describe("ContextIndicator · 多源合成：context + cache", () => {
  it("totalTokens 已知 + cacheReadTokens 到达 → 合成 '~ Xk (cache Yk)'", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500, cacheReadTokens: 9000 },
      stopReason: "end_turn",
    });
    // 最后一次调 setStatusTail 应是合成结果
    expect(screen.calls[screen.calls.length - 1]!.text).toBe(
      "~ 14.0k (cache 9.0k)",
    );
  });

  it("cacheReadTokens=undefined → 仅显示 totalTokens，无 (cache) 后缀", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500 },
      stopReason: "end_turn",
    });
    expect(screen.calls[screen.calls.length - 1]!.text).toBe("~ 14.0k");
  });

  it("cacheReadTokens=0 → 视同无命中，不显示 cache 部分", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500, cacheReadTokens: 0 },
      stopReason: "end_turn",
    });
    expect(screen.calls[screen.calls.length - 1]!.text).toBe("~ 14.0k");
  });

  it("cache 真值先到达、totalTokens 后到达 → totalTokens 到达时合成显示 cache", async () => {
    const { screen, bus } = setup();
    // cache 真值先到（理论上不应该，但测试乱序到达健壮性）
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500, cacheReadTokens: 9000 },
      stopReason: "end_turn",
    });
    // 此时 totalTokens 还没到 → 不应渲染段
    expect(screen.calls).toHaveLength(0);

    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    // totalTokens 到达 → 合成显示（cache 已暂存在 state）
    expect(screen.calls).toHaveLength(1);
    expect(screen.calls[0]!.text).toBe("~ 14.0k (cache 9.0k)");
  });

  it("多次 LLM call：命中 → 未命中 → cache 部分被清掉（last-wins）", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500, cacheReadTokens: 9000 },
      stopReason: "end_turn",
    });
    expect(screen.calls[screen.calls.length - 1]!.text).toBe("~ 14.0k (cache 9.0k)");

    // 第二次 LLM call 无命中 → cacheReadTokens 缺失
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500 },
      stopReason: "end_turn",
    });
    expect(screen.calls[screen.calls.length - 1]!.text).toBe("~ 14.0k");
  });

  it("agent:run_start 不被订阅 —— per-run 装配下跨 run state 由 dispose 释放，无需再清", async () => {
    const { screen, bus } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    await bus.emit("llm:request_end", {
      model: "test",
      duration: 100,
      usage: { inputTokens: 14000, outputTokens: 500, cacheReadTokens: 9000 },
      stopReason: "end_turn",
    });
    expect(screen.calls[screen.calls.length - 1]!.text).toBe("~ 14.0k (cache 9.0k)");

    const callsBefore = screen.calls.length;
    // 故意 emit run_start —— 组件不应有任何响应（同 run 内继续工作；跨 run
    // 时本实例已 dispose、新实例由 decorateRunBus 重建，与 run_start 解耦）
    await bus.emit("agent:run_start", { prompt: "irrelevant" });
    expect(screen.calls.length).toBe(callsBefore);
  });

  it("dispose 取消两路订阅（context / llm:request_end 均不再触发）", async () => {
    const { screen, bus, handle } = setup();
    await bus.emit("context:tokens_snapshot", { totalTokens: 14000, turnCount: 1 });
    handle.dispose();
    const callsBefore = screen.calls.length;

    // dispose 后 emit 任一上游事件都不应触发 setStatusTail
    await bus.emit("context:tokens_snapshot", { totalTokens: 99999, turnCount: 9 });
    await bus.emit("llm:request_end", {
      model: "x",
      duration: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5000 },
      stopReason: "end_turn",
    });

    expect(screen.calls.length).toBe(callsBefore);
  });
});

// ─── 集成测试 typecheck ───

it("ContextIndicator 接口 typecheck（仅编译时验证）", () => {
  // 编译期占位 —— 验证 createContextIndicator 的 options 形状契约稳定
  const _typecheck = (): void => {
    const screen = makeScreenSpy() as unknown as ScreenController;
    const bus = createEventBus<AgentEventMap>();
    const _handle = createContextIndicator({ screen, eventBus: bus });
    _handle.dispose();
  };
  expect(_typecheck).toBeDefined();
});
