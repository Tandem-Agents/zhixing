import { describe, expect, it } from "vitest";
import type { AgentEventMap } from "@zhixing/core";
import { EventBus } from "@zhixing/core";
import {
  subscribeCompactAccumulator,
  toCompactMarker,
} from "../compact-accumulator.js";

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
  it("从未 fire 时 getter 返回 undefined", () => {
    const bus = makeBus();
    const get = subscribeCompactAccumulator(bus);
    expect(get()).toBeUndefined();
  });

  it("一次 fire 含 summary：getter 返回该事件的元数据", async () => {
    const bus = makeBus();
    const get = subscribeCompactAccumulator(bus);

    await bus.emit(
      "context:compact_end",
      makeEvent({
        summary: "first summary",
        turnsCompacted: 5,
        tokensBefore: 2000,
        tokensAfter: 800,
      }),
    );

    expect(get()).toEqual({
      summary: "first summary",
      turnsCompacted: 5,
      tokensBefore: 2000,
      tokensAfter: 800,
    });
  });

  it("两次 fire 都含 summary：turnsCompacted 累加、summary 取最新", async () => {
    const bus = makeBus();
    const get = subscribeCompactAccumulator(bus);

    await bus.emit(
      "context:compact_end",
      makeEvent({ summary: "first", turnsCompacted: 3, tokensBefore: 2000, tokensAfter: 1200 }),
    );
    await bus.emit(
      "context:compact_end",
      makeEvent({ summary: "second (含前次)", turnsCompacted: 4, tokensBefore: 1500, tokensAfter: 600 }),
    );

    expect(get()).toEqual({
      summary: "second (含前次)",    // 取最新（新 summary 天然含旧历史）
      turnsCompacted: 3 + 4,          // 累加
      tokensBefore: 2000,             // 锚定第一次
      tokensAfter: 600,               // 取最新
    });
  });

  it("多次 fire 中部分无 summary：只累积含 summary 的事务", async () => {
    const bus = makeBus();
    const get = subscribeCompactAccumulator(bus);

    // 非摘要型事务（ToolResultTrim / MessageDrop 等）—— summary 缺失
    await bus.emit("context:compact_end", makeEvent({
      strategies: [{ name: "tool_result_trim", success: true, tokensBefore: 2000, tokensAfter: 1500 }],
      tokensBefore: 2000,
      tokensAfter: 1500,
      // 无 summary
    }));

    expect(get()).toBeUndefined();   // 非摘要事务不参与累积

    // 后面一次摘要型事务
    await bus.emit("context:compact_end", makeEvent({
      summary: "llm summary",
      turnsCompacted: 7,
      tokensBefore: 1500,
      tokensAfter: 400,
    }));

    expect(get()).toEqual({
      summary: "llm summary",
      turnsCompacted: 7,
      tokensBefore: 1500,   // 首次摘要型事务的 tokensBefore（不是非摘要型那次的 2000）
      tokensAfter: 400,
    });
  });

  it("turnsCompacted 为 undefined 时按 0 处理", async () => {
    const bus = makeBus();
    const get = subscribeCompactAccumulator(bus);

    // 两次都有 summary 但一次 turnsCompacted 缺失（理论不该发生但防御）
    await bus.emit("context:compact_end", makeEvent({
      summary: "first", turnsCompacted: 2, tokensBefore: 2000, tokensAfter: 1500,
    }));
    await bus.emit("context:compact_end", makeEvent({
      summary: "second", tokensBefore: 1500, tokensAfter: 800,
      // 无 turnsCompacted
    }));

    expect(get()?.turnsCompacted).toBe(2);   // 2 + 0 = 2
    expect(get()?.summary).toBe("second");
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

// ─── toCompactMarker ───

describe("toCompactMarker", () => {
  it("添加 type 和 timestamp 字段，其余字段透传", () => {
    const before = Date.now();
    const marker = toCompactMarker({
      summary: "s",
      turnsCompacted: 3,
      tokensBefore: 1000,
      tokensAfter: 400,
    });
    const after = Date.now();

    expect(marker.type).toBe("compact");
    expect(marker.summary).toBe("s");
    expect(marker.turnsCompacted).toBe(3);
    expect(marker.tokensBefore).toBe(1000);
    expect(marker.tokensAfter).toBe(400);

    // timestamp 是有效 ISO 字符串，且在调用前后之间
    const ts = new Date(marker.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
