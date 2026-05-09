import { describe, expect, it } from "vitest";
import type { AgentEventMap } from "@zhixing/core";
import { EventBus } from "@zhixing/core";
import { subscribeCompactAccumulator } from "../compact-accumulator.js";

// ─── Fixtures ───

function makeBus(): EventBus<AgentEventMap> {
  return new EventBus<AgentEventMap>();
}

function makeEvent(
  overrides: Partial<AgentEventMap["context:compact_end"]> = {},
): AgentEventMap["context:compact_end"] {
  return {
    strategies: [],
    tokensBefore: 1000,
    tokensAfter: 500,
    ...overrides,
  };
}

// ─── subscribeCompactAccumulator 累积规则 ───

describe("subscribeCompactAccumulator · 基础累积规则", () => {
  it("从未 fire 时 getMarker 返回 undefined", () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);
    expect(acc.getMarker()).toBeUndefined();
  });

  it("一次 fire 含 summary：getMarker 返回 CompactMarker（含 type + timestamp）", async () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);
    const before = Date.now();

    await bus.emit(
      "context:compact_end",
      makeEvent({
        summary: "first summary",
        turnsCompacted: 5,
        tokensBefore: 2000,
        tokensAfter: 800,
      }),
    );

    const marker = acc.getMarker();
    expect(marker).toBeDefined();
    expect(marker!.type).toBe("compact");
    expect(marker!.summary).toBe("first summary");
    expect(marker!.turnsCompacted).toBe(5);
    expect(marker!.tokensBefore).toBe(2000);
    expect(marker!.tokensAfter).toBe(800);
    // timestamp 是有效 ISO 且在事件触发期间
    const ts = Date.parse(marker!.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("两次 fire 都含 summary：turnsCompacted 累加、summary 取最新、timestamp 取最新", async () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);

    await bus.emit(
      "context:compact_end",
      makeEvent({ summary: "first", turnsCompacted: 3, tokensBefore: 2000, tokensAfter: 1200 }),
    );
    const firstTs = acc.getMarker()!.timestamp;
    // 跨不同毫秒，让第二次 fire 的 timestamp 可区分
    await new Promise((r) => setTimeout(r, 5));
    await bus.emit(
      "context:compact_end",
      makeEvent({ summary: "second (含前次)", turnsCompacted: 4, tokensBefore: 1500, tokensAfter: 600 }),
    );

    const marker = acc.getMarker()!;
    expect(marker.type).toBe("compact");
    expect(marker.summary).toBe("second (含前次)"); // 取最新（新 summary 天然含旧历史）
    expect(marker.turnsCompacted).toBe(3 + 4);      // 累加
    expect(marker.tokensBefore).toBe(2000);         // 锚定第一次
    expect(marker.tokensAfter).toBe(600);           // 取最新
    // timestamp 覆盖式更新（第二次 fire 的时间）
    expect(Date.parse(marker.timestamp)).toBeGreaterThan(Date.parse(firstTs));
  });

  it("多次 fire 中部分无 summary：只累积含 summary 的事务", async () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);

    // 非摘要型事务（如 MessageDrop）—— summary 缺失
    await bus.emit("context:compact_end", makeEvent({
      strategies: [{ name: "trim_legacy", success: true, tokensBefore: 2000, tokensAfter: 1500 }],
      tokensBefore: 2000,
      tokensAfter: 1500,
      // 无 summary
    }));

    expect(acc.getMarker()).toBeUndefined();   // 非摘要事务不参与累积

    // 后面一次摘要型事务
    await bus.emit("context:compact_end", makeEvent({
      summary: "llm summary",
      turnsCompacted: 7,
      tokensBefore: 1500,
      tokensAfter: 400,
    }));

    const marker = acc.getMarker()!;
    expect(marker.type).toBe("compact");
    expect(marker.summary).toBe("llm summary");
    expect(marker.turnsCompacted).toBe(7);
    expect(marker.tokensBefore).toBe(1500);   // 首次摘要型事务的 tokensBefore（不是非摘要型那次的 2000）
    expect(marker.tokensAfter).toBe(400);
  });

  it("turnsCompacted 为 undefined 时按 0 处理", async () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);

    // 两次都有 summary 但一次 turnsCompacted 缺失（理论不该发生但防御）
    await bus.emit("context:compact_end", makeEvent({
      summary: "first", turnsCompacted: 2, tokensBefore: 2000, tokensAfter: 1500,
    }));
    await bus.emit("context:compact_end", makeEvent({
      summary: "second", tokensBefore: 1500, tokensAfter: 800,
      // 无 turnsCompacted
    }));

    expect(acc.getMarker()?.turnsCompacted).toBe(2);   // 2 + 0 = 2
    expect(acc.getMarker()?.summary).toBe("second");
  });

  it("onEvent 回调在每次 fire 时被触发（含非摘要事务）", async () => {
    const bus = makeBus();
    const seen: string[] = [];
    subscribeCompactAccumulator(bus, (info) => {
      seen.push(info.summary ?? "<no-summary>");
    });

    await bus.emit("context:compact_end", makeEvent({ tokensBefore: 1000, tokensAfter: 800 }));
    await bus.emit("context:compact_end", makeEvent({
      summary: "with summary", turnsCompacted: 1, tokensBefore: 800, tokensAfter: 400,
    }));

    // 非摘要型和摘要型事件都进入 onEvent（UI 渲染要看到所有事务）
    expect(seen).toEqual(["<no-summary>", "with summary"]);
  });
});

// ─── dispose 语义 ───

describe("subscribeCompactAccumulator · dispose 语义", () => {
  it("dispose 后再 fire 不会改变已累积值", async () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);

    await bus.emit("context:compact_end", makeEvent({
      summary: "before-dispose", turnsCompacted: 3, tokensBefore: 2000, tokensAfter: 1000,
    }));
    const before = acc.getMarker();
    expect(before?.summary).toBe("before-dispose");

    acc.dispose();

    await bus.emit("context:compact_end", makeEvent({
      summary: "after-dispose", turnsCompacted: 100, tokensBefore: 1000, tokensAfter: 500,
    }));

    // dispose 后 listener 被移除，累积状态不受后续 fire 影响
    const after = acc.getMarker();
    expect(after?.summary).toBe("before-dispose");
    expect(after?.turnsCompacted).toBe(3);
  });

  it("dispose 幂等：多次调用不抛错", () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);
    expect(() => {
      acc.dispose();
      acc.dispose();
      acc.dispose();
    }).not.toThrow();
  });

  it("dispose 后 bus 里不再有 context:compact_end 监听器", () => {
    const bus = makeBus();
    const acc = subscribeCompactAccumulator(bus);
    expect(bus.listenerCount("context:compact_end")).toBe(1);
    acc.dispose();
    expect(bus.listenerCount("context:compact_end")).toBe(0);
  });

  it("多个 accumulator 独立订阅 + dispose 互不干扰", async () => {
    const bus = makeBus();
    const acc1 = subscribeCompactAccumulator(bus);
    const acc2 = subscribeCompactAccumulator(bus);

    await bus.emit("context:compact_end", makeEvent({
      summary: "first-event", turnsCompacted: 2, tokensBefore: 2000, tokensAfter: 1000,
    }));
    expect(acc1.getMarker()?.summary).toBe("first-event");
    expect(acc2.getMarker()?.summary).toBe("first-event");

    acc1.dispose();  // 只 dispose acc1

    await bus.emit("context:compact_end", makeEvent({
      summary: "second-event", turnsCompacted: 5, tokensBefore: 1000, tokensAfter: 400,
    }));

    // acc1 已 dispose，不再累积
    expect(acc1.getMarker()?.summary).toBe("first-event");
    expect(acc1.getMarker()?.turnsCompacted).toBe(2);
    // acc2 仍在订阅
    expect(acc2.getMarker()?.summary).toBe("second-event");
    expect(acc2.getMarker()?.turnsCompacted).toBe(2 + 5);

    acc2.dispose();
  });
});
