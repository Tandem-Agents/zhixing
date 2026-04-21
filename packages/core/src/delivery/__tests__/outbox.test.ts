/**
 * Outbox 单测 — 验证不变量 INV-1/5/7 与 Phase 1 行为
 */

import { describe, it, expect, vi } from "vitest";
import { Outbox } from "../outbox.js";
import type {
  EmissionSource,
  OutboxEvent,
  OutboxDoSend,
} from "../outbox-types.js";
import type {
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "../../channels/types.js";

// ─── 测试工具 ───

const TARGET: DeliveryTarget = { channelId: "feishu", to: "ou_abc" };

function llmSource(): EmissionSource {
  return { kind: "llm-reply", conversationId: "conv_x", turnId: "turn_1" };
}

function makePost(
  content = "hello",
): { target: DeliveryTarget; content: OutboundContent; source: EmissionSource } {
  return {
    target: TARGET,
    content: { text: content },
    source: llmSource(),
  };
}

function okResult(messageId = "mid"): DeliveryResult {
  return { success: true, messageId, retryable: false };
}

function errorResult(error = "boom"): DeliveryResult {
  return { success: false, error, retryable: true };
}

function createOutbox(opts: {
  send: OutboxDoSend;
  sendTimeoutMs?: number;
  events?: OutboxEvent[];
}): Outbox {
  return new Outbox("feishu:ou_abc", opts.send, {
    sendTimeoutMs: opts.sendTimeoutMs,
    onEvent: opts.events ? (e) => opts.events!.push(e) : undefined,
  });
}

// ─── 基础 FIFO（INV-1） ───

describe("Outbox FIFO (INV-1)", () => {
  it("连续 post 10 条，出队顺序等于入队顺序", async () => {
    const sentOrder: string[] = [];
    const send = vi.fn<OutboxDoSend>(async (_target, content) => {
      sentOrder.push(content.text);
      return okResult();
    });

    const outbox = createOutbox({ send });
    const promises: Promise<DeliveryResult>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(outbox.post(makePost(`msg-${i}`)));
    }
    await Promise.all(promises);

    expect(sentOrder).toEqual(
      Array.from({ length: 10 }, (_, i) => `msg-${i}`),
    );
  });

  it("并发 post 仍然串行发送（send 一个接一个，无重叠）", async () => {
    let concurrentCalls = 0;
    let maxConcurrent = 0;

    const send: OutboxDoSend = async () => {
      concurrentCalls++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
      await new Promise((r) => setTimeout(r, 5));
      concurrentCalls--;
      return okResult();
    };

    const outbox = createOutbox({ send });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => outbox.post(makePost(`m${i}`))),
    );

    expect(maxConcurrent).toBe(1);
  });

  it("中途 post 的 entry 仍保留入队顺序", async () => {
    const sentOrder: string[] = [];
    const send: OutboxDoSend = async (_t, c) => {
      // 第一条慢一点，给后续 post 的机会
      if (c.text === "first") await new Promise((r) => setTimeout(r, 20));
      sentOrder.push(c.text);
      return okResult();
    };

    const outbox = createOutbox({ send });
    const p1 = outbox.post(makePost("first"));
    // 故意延迟，让 p1 已在 inflight
    await new Promise((r) => setTimeout(r, 5));
    const p2 = outbox.post(makePost("second"));
    const p3 = outbox.post(makePost("third"));

    await Promise.all([p1, p2, p3]);
    expect(sentOrder).toEqual(["first", "second", "third"]);
  });
});

// ─── 事件（INV-7） ───

describe("Outbox 事件", () => {
  it("每个成功 entry 产生 enqueued + sent", async () => {
    const events: OutboxEvent[] = [];
    const outbox = createOutbox({
      send: async () => okResult("abc"),
      events,
    });

    await outbox.post(makePost("hello"));

    const types = events.map((e) => e.type);
    expect(types).toEqual(["entry:enqueued", "entry:sent"]);
    expect(events[1]).toMatchObject({
      type: "entry:sent",
      key: "feishu:ou_abc",
      result: { success: true, messageId: "abc" },
    });
    expect((events[1] as Extract<OutboxEvent, { type: "entry:sent" }>).attemptLatencyMs)
      .toBeGreaterThanOrEqual(0);
  });

  it("adapter 返回 success=false 触发 failed 事件但不抛异常", async () => {
    const events: OutboxEvent[] = [];
    const outbox = createOutbox({
      send: async () => errorResult("channel busy"),
      events,
    });

    const result = await outbox.post(makePost());
    expect(result.success).toBe(false);
    expect(result.error).toBe("channel busy");

    const failed = events.find((e) => e.type === "entry:failed");
    expect(failed).toBeDefined();
    expect((failed as Extract<OutboxEvent, { type: "entry:failed" }>).error)
      .toBe("channel busy");
  });

  it("send 抛异常触发 failed 事件 + reject", async () => {
    const events: OutboxEvent[] = [];
    const outbox = createOutbox({
      send: async () => {
        throw new Error("network down");
      },
      events,
    });

    await expect(outbox.post(makePost())).rejects.toThrow("network down");
    const failed = events.find((e) => e.type === "entry:failed");
    expect(failed).toBeDefined();
  });

  it("onEvent handler 抛错不影响 drain", async () => {
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      {
        onEvent: (e) => {
          events.push(e);
          if (e.type === "entry:enqueued") throw new Error("handler boom");
        },
      },
    );

    await outbox.post(makePost());
    expect(events.some((e) => e.type === "entry:sent")).toBe(true);
  });
});

// ─── 超时 ───

describe("Outbox 超时兜底", () => {
  it("adapter.send 超过 sendTimeoutMs 视为失败", async () => {
    const events: OutboxEvent[] = [];
    const outbox = createOutbox({
      send: () => new Promise<DeliveryResult>(() => {}),  // 永不 resolve
      sendTimeoutMs: 30,
      events,
    });

    await expect(outbox.post(makePost())).rejects.toThrow(/timed out/);
    const failed = events.find((e) => e.type === "entry:failed");
    expect(failed).toBeDefined();
  });

  it("超时后后续 entry 正常处理（INV-6 无隐式阻塞）", async () => {
    const sentOrder: string[] = [];
    let first = true;
    const send: OutboxDoSend = (_, c) => {
      if (first) {
        first = false;
        return new Promise<DeliveryResult>(() => {});
      }
      sentOrder.push(c.text);
      return Promise.resolve(okResult());
    };

    const outbox = createOutbox({ send, sendTimeoutMs: 30 });
    const p1 = outbox.post(makePost("slow"));
    const p2 = outbox.post(makePost("fast"));

    await expect(p1).rejects.toThrow(/timed out/);
    await p2;
    expect(sentOrder).toEqual(["fast"]);
  });

  it("sendTimeoutMs <= 0 时跳过超时包装", async () => {
    const outbox = createOutbox({
      send: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return okResult();
      },
      sendTimeoutMs: 0,
    });
    const result = await outbox.post(makePost());
    expect(result.success).toBe(true);
  });
});

// ─── 状态观测 ───

describe("Outbox 状态", () => {
  it("isIdle / pendingCount / inflight 随 drain 变化", async () => {
    const outbox = createOutbox({
      send: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return okResult();
      },
    });

    expect(outbox.isIdle()).toBe(true);
    expect(outbox.pendingCount).toBe(0);

    const p = outbox.post(makePost("msg"));
    // 刚入队：要么在 pending 要么已 inflight
    await new Promise((r) => setTimeout(r, 5));
    expect(outbox.isIdle()).toBe(false);

    await p;
    expect(outbox.isIdle()).toBe(true);
    expect(outbox.inflight).toBeNull();
  });

  it("waitIdle 在所有 entry 发送完后 resolve", async () => {
    const outbox = createOutbox({
      send: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return okResult();
      },
    });

    outbox.post(makePost("a"));
    outbox.post(makePost("b"));
    outbox.post(makePost("c"));
    await outbox.waitIdle();
    expect(outbox.isIdle()).toBe(true);
  });
});

// ─── Race condition 回归：drain finally 间隙的 re-kick ───

describe("Outbox drain finally 间隙 race（回归）", () => {
  it("在 post(A).then 里再 post(B)，B 必定被投递（不搁浅）", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    // 关键：B 的 post 发生在 A 的 .then 回调里——
    // A 完成时 drain 的 while 可能已退出，finally 微任务尚未运行；
    // 此时 kick() 看到 draining 非 null 会 no-op。
    // 没有 re-kick 兜底的话 B 会搁浅。
    const p = outbox.post(makePost("A")).then(() => {
      outbox.post(makePost("B"));
    });

    await p;
    await outbox.waitIdle();

    expect(sentOrder).toEqual(["A", "B"]);
  });

  it("链式 post（每条在前一条 .then 里发下一条）全部到达", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    const chain = outbox.post(makePost("1")).then(() =>
      outbox.post(makePost("2")).then(() =>
        outbox.post(makePost("3")).then(() =>
          outbox.post(makePost("4")),
        ),
      ),
    );

    await chain;
    await outbox.waitIdle();

    expect(sentOrder).toEqual(["1", "2", "3", "4"]);
  });
});

// ─── afterSlot 字段（Phase 1 降级行为） ───

describe("Outbox afterSlot（Phase 1）", () => {
  it("带 afterSlot 的 entry 仍立即 drain，并产生 warn 日志", async () => {
    const warns: string[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      {
        logger: {
          warn: (msg) => warns.push(msg),
        },
      },
    );

    const result = await outbox.post({
      ...makePost(),
      afterSlot: "turn_phantom",
    });
    expect(result.success).toBe(true);
    expect(warns.some((w) => w.includes("afterSlot"))).toBe(true);
  });
});
