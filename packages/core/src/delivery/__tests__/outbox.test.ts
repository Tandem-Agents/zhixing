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

// ─── Turn Slot 因果依赖（ADR-007 Phase 3 / INV-3 / INV-4） ───

describe("Outbox Turn Slot", () => {
  it("openSlot + fillSlot(无 entry)：下游 afterSlot=slot 的 entry 被阻塞到 fill 后才发", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    outbox.openSlot({ slotId: "turn_1" });

    // 并发 post：一个 afterSlot=turn_1，一个无依赖
    const p1 = outbox.post({ ...makePost("slot-blocked"), afterSlot: "turn_1" });

    // 等一小会儿确保 drain 已挂起
    await new Promise((r) => setTimeout(r, 10));
    expect(sentOrder).toEqual([]);
    expect(outbox.getSlot("turn_1")?.state).toBe("pending");

    // fill slot，等待者被释放
    await outbox.fillSlot("turn_1");
    await p1;
    expect(sentOrder).toEqual(["slot-blocked"]);
    expect(outbox.getSlot("turn_1")?.state).toBe("filled");
  });

  it("fillSlot(slot, entry) 原子性：entry 先于任何 afterSlot=slot 的 entry", async () => {
    // 这是 Phase 3 的核心保证——规格 §3.4：LLM 回复必然先于 task fire
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    outbox.openSlot({ slotId: "turn_1" });

    // 先 post task fire，等在 slot 上（模拟 LLM 慢、task 先触发）
    const taskFirePromise = outbox.post({
      ...makePost("task-fire"),
      afterSlot: "turn_1",
    });
    await new Promise((r) => setTimeout(r, 10));

    // 现在 fill slot 同时追加 LLM 回复
    await outbox.fillSlot("turn_1", makePost("llm-reply"));
    await taskFirePromise;
    await outbox.waitIdle();

    // LLM 回复必须在 task fire 之前
    expect(sentOrder).toEqual(["llm-reply", "task-fire"]);
  });

  it("abandonSlot：entry 放行 + warn 日志 + slot:abandoned 事件", async () => {
    const warns: string[] = [];
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      {
        logger: { warn: (m) => warns.push(m) },
        onEvent: (e) => events.push(e),
      },
    );

    outbox.openSlot({ slotId: "turn_err" });
    const p = outbox.post({ ...makePost(), afterSlot: "turn_err" });
    await new Promise((r) => setTimeout(r, 10));

    outbox.abandonSlot("turn_err", "LLM crashed");
    const result = await p;

    expect(result.success).toBe(true);
    expect(warns.some((w) => w.includes("abandoned"))).toBe(true);
    const abandoned = events.find((e) => e.type === "slot:abandoned");
    expect(abandoned).toBeDefined();
    if (abandoned?.type === "slot:abandoned") {
      expect(abandoned.reason).toBe("LLM crashed");
    }
  });

  it("TTL 超时：slot 自动置 expired，entry 放行 + warn", async () => {
    const warns: string[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      { logger: { warn: (m) => warns.push(m) } },
    );

    outbox.openSlot({ slotId: "turn_slow", ttlMs: 30 });
    const p = outbox.post({ ...makePost(), afterSlot: "turn_slow" });

    // 等 TTL 触发
    await new Promise((r) => setTimeout(r, 60));
    const result = await p;

    expect(result.success).toBe(true);
    expect(outbox.getSlot("turn_slow")?.state).toBe("expired");
    expect(warns.some((w) => w.includes("expired"))).toBe(true);
  });

  it("孤儿 slot 引用（afterSlot 指向从未 open 的 slotId）→ 放行 + warn + causal-broken 事件", async () => {
    // 合法场景：task 创建后 Registry.reapIdle 回收对应 Outbox，之后 fire 时 orphan。
    // 不是 error 级别的故障；causal-broken 事件让上层可订阅告警。
    const warns: string[] = [];
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      {
        logger: { warn: (m) => warns.push(m) },
        onEvent: (e) => events.push(e),
      },
    );

    const p = outbox.post({
      ...makePost(),
      afterSlot: "turn_phantom_never_opened",
    });
    const result = await p;

    expect(result.success).toBe(true);
    expect(warns.some((w) => w.includes("orphan"))).toBe(true);
    const causalBroken = events.find((e) => e.type === "entry:causal-broken");
    expect(causalBroken).toBeDefined();
    if (causalBroken?.type === "entry:causal-broken") {
      expect(causalBroken.reason).toBe("orphan-slot");
      expect(causalBroken.slotId).toBe("turn_phantom_never_opened");
    }
  });

  it("abandoned/expired slot 放行时 emit causal-broken 事件携带 reason 细分", async () => {
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      { onEvent: (e) => events.push(e) },
    );

    outbox.openSlot({ slotId: "t_ab" });
    const p1 = outbox.post({ ...makePost(), afterSlot: "t_ab" });
    await new Promise((r) => setTimeout(r, 5));
    outbox.abandonSlot("t_ab", "LLM crashed");
    await p1;

    const abandonBroken = events.find(
      (e) => e.type === "entry:causal-broken" && e.reason === "slot-abandoned",
    );
    expect(abandonBroken).toBeDefined();
    if (abandonBroken?.type === "entry:causal-broken") {
      expect(abandonBroken.slotCloseReason).toBe("LLM crashed");
    }

    // 第二轮：expired 路径
    outbox.openSlot({ slotId: "t_exp", ttlMs: 10 });
    const p2 = outbox.post({ ...makePost(), afterSlot: "t_exp" });
    await new Promise((r) => setTimeout(r, 30));
    await p2;

    const expireBroken = events.find(
      (e) => e.type === "entry:causal-broken" && e.reason === "slot-expired",
    );
    expect(expireBroken).toBeDefined();
  });

  it("FIFO 保序（INV-6）：head 被 slot 阻塞时，后续无依赖 entry 也被挡住", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    outbox.openSlot({ slotId: "turn_x" });
    const pBlocked = outbox.post({ ...makePost("blocked"), afterSlot: "turn_x" });
    const pFree = outbox.post(makePost("free"));  // 无 afterSlot，但仍在 blocked 后入队

    await new Promise((r) => setTimeout(r, 10));
    expect(sentOrder).toEqual([]);  // head 阻塞 → 整个队列停摆

    await outbox.fillSlot("turn_x");
    await Promise.all([pBlocked, pFree]);
    expect(sentOrder).toEqual(["blocked", "free"]);
  });

  it("多 slot 混合：A 已 filled、B 未 filled，afterSlot=A 的出；afterSlot=B 的等", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });

    outbox.openSlot({ slotId: "A" });
    outbox.openSlot({ slotId: "B" });
    await outbox.fillSlot("A");  // A 提前 filled

    const pa = outbox.post({ ...makePost("after-A"), afterSlot: "A" });
    const pb = outbox.post({ ...makePost("after-B"), afterSlot: "B" });

    await pa;
    await new Promise((r) => setTimeout(r, 10));
    expect(sentOrder).toEqual(["after-A"]);
    expect(outbox.getSlot("B")?.state).toBe("pending");

    await outbox.fillSlot("B");
    await pb;
    expect(sentOrder).toEqual(["after-A", "after-B"]);
  });

  it("openSlot 幂等：同 slotId 重复 open 不重置状态", () => {
    const outbox = createOutbox({ send: async () => okResult() });
    outbox.openSlot({ slotId: "dup", ttlMs: 30_000 });
    const info1 = outbox.getSlot("dup");
    outbox.openSlot({ slotId: "dup", ttlMs: 1 });  // 尝试用超短 TTL 覆盖
    const info2 = outbox.getSlot("dup");
    expect(info1?.openedAt).toBe(info2?.openedAt);
  });

  it("fillSlot 后再 abandonSlot：abandon 忽略（已终态）", async () => {
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      { onEvent: (e) => events.push(e) },
    );

    outbox.openSlot({ slotId: "race" });
    await outbox.fillSlot("race");
    outbox.abandonSlot("race", "too late");

    const abandoned = events.find((e) => e.type === "slot:abandoned");
    expect(abandoned).toBeUndefined();  // 仅 slot:opened + slot:filled
    expect(outbox.getSlot("race")?.state).toBe("filled");
  });

  it("fillSlot(unknown) / abandonSlot(unknown) 都是 no-op + warn", () => {
    const warns: string[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      { logger: { warn: (m) => warns.push(m) } },
    );

    outbox.abandonSlot("nonexistent", "reason");
    outbox.fillSlot("nonexistent");
    expect(warns.filter((w) => w.includes("unknown")).length).toBe(2);
  });

  it("P3d 安全网：fillSlot(unknown, entry) 降级为普通 post，entry 不丢", async () => {
    const sentOrder: string[] = [];
    const warns: string[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
      { logger: { warn: (m) => warns.push(m) } },
    );

    const result = await outbox.fillSlot("never_opened", makePost("rescued"));
    expect((result as DeliveryResult).success).toBe(true);
    expect(sentOrder).toEqual(["rescued"]);
    expect(warns.some((w) => w.includes("unknown"))).toBe(true);
  });

  it("P3d 安全网：fillSlot(terminal, entry) 降级为普通 post，entry 不丢", async () => {
    const sentOrder: string[] = [];
    const debugs: string[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
      { logger: { debug: (m) => debugs.push(m) } },
    );

    outbox.openSlot({ slotId: "raced" });
    outbox.abandonSlot("raced", "test");  // slot 进入终态

    const result = await outbox.fillSlot("raced", makePost("rescued"));
    expect((result as DeliveryResult).success).toBe(true);
    expect(sentOrder).toEqual(["rescued"]);
    expect(debugs.some((m) => m.includes("terminal"))).toBe(true);
  });

  it("回归：logger 在 drain 路径抛错也不会无限 re-kick（必须走 safeLog）", async () => {
    // 构造：logger.error 抛错 + entry 引用孤儿 slot（走 drain 的 error 日志分支）
    // 旧实现：logger 抛 → drain 抛 → finally 看 pending 非空 → re-kick → 同路径再抛 → 无限循环
    // 期望：safeLog 吞掉 logger 异常，entry 正常放行
    let sendCount = 0;
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => {
        sendCount++;
        return okResult();
      },
      {
        logger: {
          error: () => {
            throw new Error("logger boom");
          },
        },
      },
    );

    const p = outbox.post({
      ...makePost(),
      afterSlot: "never_opened",  // 孤儿引用 → 走 logger.error 分支
    });

    // 给足时间，如果有死循环会跑飞 CPU；safeLog 情况下应在 ~10ms 内完成
    const result = await Promise.race([
      p,
      new Promise<string>((r) => setTimeout(() => r("HANG"), 500)),
    ]);

    expect(result).not.toBe("HANG");
    expect(sendCount).toBe(1);  // 仅 send 一次，未陷入循环
  });

  it("openSlot ttlMs<=0 → slot:opened 事件的 ttlMs 为 null（禁用 TTL 的明示）", async () => {
    const events: OutboxEvent[] = [];
    const outbox = new Outbox(
      "feishu:ou_abc",
      async () => okResult(),
      { onEvent: (e) => events.push(e) },
    );
    outbox.openSlot({ slotId: "no_ttl", ttlMs: 0 });
    const opened = events.find((e) => e.type === "slot:opened");
    expect(opened).toBeDefined();
    if (opened?.type === "slot:opened") {
      expect(opened.ttlMs).toBeNull();
    }
  });

  it("drain 空闲状态下 openSlot 不触发发送", async () => {
    const sentOrder: string[] = [];
    const outbox = createOutbox({
      send: async (_t, c) => {
        sentOrder.push(c.text);
        return okResult();
      },
    });
    outbox.openSlot({ slotId: "quiet" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sentOrder).toEqual([]);
  });
});
