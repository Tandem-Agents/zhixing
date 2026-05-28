/**
 * ConfirmationBroker 单元测试
 *
 * 测试矩阵（覆盖 spec §9.2 Step 1 的所有行为保证）：
 *   - 基本 request/resolve 往返
 *   - FIFO 队列 + 串行化（任意时刻只有一个 showing）
 *   - onRequest 监听器通知语义
 *   - 无监听器时走非交互解析器（fail-to-deny / fail-to-expired）
 *   - 幂等 resolve（同 id 第二次返回 false）
 *   - cancel 单个 / cancelAll
 *   - 超时自动 expire
 *   - Grace period：resolved 后仍能查到但 pending 中消失
 *   - 事件发射（所有事件类型）
 *   - 重复 id 抛错
 *   - backpressure（队列满）
 *   - 监听器错误隔离
 *   - snapshot / listPending 正确性
 *   - 取消 queued 不影响 showing
 *   - 取消 showing 时队列正确前进
 */

import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import {
  ConfirmationBroker,
  createConfirmationBroker,
  generateRequestId,
} from "../broker.js";
import {
  failToAllowResolver,
  failToDenyResolver,
  failToExpiredResolver,
} from "../non-interactive.js";
import type {
  ConfirmationDecision,
  ConfirmationEventMap,
  ConfirmationRequest,
  NonInteractiveResolver,
  RequestListener,
  ResolvedListener,
} from "../types.js";

// ─── 测试辅助 ───

/**
 * 构造一个最小合法的 ConfirmationRequest。
 * 大部分字段不参与 broker 的调度逻辑——broker 只关心 id / tool / expiresAt。
 */
function makeRequest(
  overrides: Partial<ConfirmationRequest> = {},
): ConfirmationRequest {
  const id = overrides.id ?? generateRequestId();
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title: "Bash",
      body: { kind: "bash", command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [
      { kind: "allow-once", label: "允许一次" },
      { kind: "deny", label: "拒绝" },
    ],
    sessionType: "interactive",
    contextId: "main",
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

/**
 * 异步等待一个 microtask tick——给 Promise 一次运行的机会。
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ─── 基本 request/resolve ───

describe("ConfirmationBroker — 基本 request/resolve", () => {
  it("有监听器时，requestConfirmation 返回的 Promise 等待 resolve 调用", async () => {
    const broker = new ConfirmationBroker();
    const listener = vi.fn();
    broker.onRequest(listener);

    const req = makeRequest();
    const promise = broker.requestConfirmation(req);

    // 立即应已通知监听器
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(req);

    // Promise 仍然 pending
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);

    // 现在解决
    expect(broker.resolve(req.id, { kind: "allow-once" })).toBe(true);
    const decision = await promise;
    expect(decision).toEqual({ kind: "allow-once" });
  });

  it("resolve 返回的 decision 保留 note 字段", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once", note: "用 -i 代替" });
    const decision = await promise;
    expect(decision).toEqual({ kind: "allow-once", note: "用 -i 代替" });
  });

  it("deny 决定能把 reason 传递出去", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, {
      kind: "deny",
      reason: "不要用 rm，改用 rm -i",
    });
    const decision = await promise;
    expect(decision).toEqual({
      kind: "deny",
      reason: "不要用 rm，改用 rm -i",
    });
  });
});

// ─── 非交互降级 ───

describe("ConfirmationBroker — 非交互降级", () => {
  it("无监听器 → 立即走 fail-to-deny resolver", async () => {
    const broker = new ConfirmationBroker(); // 默认 failToDenyResolver
    const req = makeRequest();
    const decision = await broker.requestConfirmation(req);
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("默认拒绝");
    }
  });

  it("无监听器 + 自定义 resolver → expired", async () => {
    const broker = new ConfirmationBroker({
      nonInteractiveResolver: failToExpiredResolver,
    });
    const req = makeRequest();
    const decision = await broker.requestConfirmation(req);
    expect(decision).toEqual({ kind: "expired" });
  });

  it("非交互路径上仍然会发射 confirmation:auto-resolved 事件", async () => {
    const eventBus = new EventBus<ConfirmationEventMap>();
    const seen: string[] = [];
    eventBus.on("confirmation:auto-resolved", (p) => {
      seen.push(p.resolverName);
    });
    const broker = new ConfirmationBroker({ eventBus });
    await broker.requestConfirmation(makeRequest());
    expect(seen).toEqual(["fail-to-deny"]);
  });

  it("自定义 resolver 可以返回 allow-once 放行", async () => {
    const autoAllow: NonInteractiveResolver = {
      name: "auto-allow-for-test",
      resolve: () => ({ kind: "allow-once" }),
    };
    const broker = new ConfirmationBroker({ nonInteractiveResolver: autoAllow });
    const decision = await broker.requestConfirmation(makeRequest());
    expect(decision).toEqual({ kind: "allow-once" });
  });
});

// ─── FIFO 队列与串行化 ───

describe("ConfirmationBroker — FIFO 队列与串行化", () => {
  it("第二个请求在队列中等待，第一个 resolve 后才被 show", async () => {
    const broker = new ConfirmationBroker();
    const shown: string[] = [];
    broker.onRequest((req) => shown.push(req.id));

    const r1 = makeRequest({ id: "r1" });
    const r2 = makeRequest({ id: "r2" });
    const p1 = broker.requestConfirmation(r1);
    const p2 = broker.requestConfirmation(r2);

    // 只有 r1 被通知
    expect(shown).toEqual(["r1"]);
    // r2 在队列中
    const pending = broker.listPending();
    expect(pending.map((p) => p.request.id)).toEqual(["r1", "r2"]);
    expect(pending[0]!.status).toBe("showing");
    expect(pending[1]!.status).toBe("queued");

    // Resolve r1 → r2 被通知
    broker.resolve("r1", { kind: "allow-once" });
    expect(shown).toEqual(["r1", "r2"]);

    // r2 现在是 showing
    const pending2 = broker.listPending();
    expect(pending2.map((p) => p.request.id)).toEqual(["r2"]);
    expect(pending2[0]!.status).toBe("showing");

    broker.resolve("r2", { kind: "deny" });
    expect(await p1).toEqual({ kind: "allow-once" });
    expect(await p2).toEqual({ kind: "deny" });
  });

  it("resolve showing 时队列正确前进到下一个", async () => {
    const broker = new ConfirmationBroker();
    const shown: string[] = [];
    broker.onRequest((req) => shown.push(req.id));

    const promises = ["a", "b", "c"].map((id) =>
      broker.requestConfirmation(makeRequest({ id })),
    );
    expect(shown).toEqual(["a"]);

    broker.resolve("a", { kind: "allow-once" });
    expect(shown).toEqual(["a", "b"]);
    broker.resolve("b", { kind: "allow-once" });
    expect(shown).toEqual(["a", "b", "c"]);
    broker.resolve("c", { kind: "allow-once" });

    const decisions = await Promise.all(promises);
    expect(decisions.map((d) => d.kind)).toEqual([
      "allow-once",
      "allow-once",
      "allow-once",
    ]);
  });

  it("同一时刻永远只有一个 showing 状态", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});

    const promises: Array<Promise<ConfirmationDecision>> = [];
    for (let i = 0; i < 5; i++) {
      promises.push(broker.requestConfirmation(makeRequest({ id: `r${i}` })));
    }

    // 断言不变量：每次检查 pending 都只有 0 或 1 个 showing
    for (let i = 0; i < 5; i++) {
      const pending = broker.listPending();
      const showing = pending.filter((p) => p.status === "showing").length;
      expect(showing).toBe(1);
      const headId = pending[0]!.request.id;
      broker.resolve(headId, { kind: "allow-once" });
    }
    await Promise.all(promises);
  });
});

// ─── 监听器机制 ───

describe("ConfirmationBroker — 监听器机制", () => {
  it("onRequest 订阅后到达的请求会被通知", async () => {
    const broker = new ConfirmationBroker();
    const listener = vi.fn();
    broker.onRequest(listener);
    const req = makeRequest();
    broker.requestConfirmation(req);
    expect(listener).toHaveBeenCalledWith(req);
  });

  it("onRequest 返回的 unsubscribe 能正确取消订阅", async () => {
    const broker = new ConfirmationBroker();
    const listener = vi.fn();
    const unsub = broker.onRequest(listener);

    // 之前先加一个"常驻"监听器，避免取消所有监听器后走非交互降级
    broker.onRequest(() => {});

    unsub();
    broker.requestConfirmation(makeRequest());
    expect(listener).not.toHaveBeenCalled();
  });

  it("多个监听器都会收到通知", async () => {
    const broker = new ConfirmationBroker();
    const a = vi.fn();
    const b = vi.fn();
    broker.onRequest(a);
    broker.onRequest(b);
    broker.requestConfirmation(makeRequest());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("监听器抛出错误不影响 broker 和其它监听器", async () => {
    const broker = new ConfirmationBroker();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const faulty: RequestListener = () => {
      throw new Error("boom");
    };
    const ok = vi.fn();
    broker.onRequest(faulty);
    broker.onRequest(ok);

    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    expect(ok).toHaveBeenCalledWith(req);
    broker.resolve(req.id, { kind: "allow-once" });
    await promise;

    errorSpy.mockRestore();
  });

  it("queued 状态的请求不会触发监听器，直到它变成 showing", async () => {
    const broker = new ConfirmationBroker();
    const listener = vi.fn();
    broker.onRequest(listener);

    broker.requestConfirmation(makeRequest({ id: "a" }));
    broker.requestConfirmation(makeRequest({ id: "b" }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "a" }),
    );

    broker.resolve("a", { kind: "allow-once" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "b" }),
    );
  });
});

// ─── 幂等 resolve ───

describe("ConfirmationBroker — 幂等与边界情况", () => {
  it("对未知 id 的 resolve 返回 false", () => {
    const broker = new ConfirmationBroker();
    expect(broker.resolve("nonexistent", { kind: "allow-once" })).toBe(false);
  });

  it("对同一 id resolve 两次，第二次返回 false", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const req = makeRequest();
    const promise = broker.requestConfirmation(req);

    expect(broker.resolve(req.id, { kind: "allow-once" })).toBe(true);
    expect(broker.resolve(req.id, { kind: "deny" })).toBe(false);
    expect((await promise).kind).toBe("allow-once");
  });

  it("重复 id 的 request 直接抛错", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const req = makeRequest({ id: "dup" });
    // 第一次成功注册——不 await，让它挂在 pending 里
    const p1 = broker.requestConfirmation(req);

    // requestConfirmation 是 async，重复 id 会 reject 返回的 Promise
    await expect(
      broker.requestConfirmation(makeRequest({ id: "dup" })),
    ).rejects.toThrow(/duplicate request id/);

    // 清场
    broker.resolve("dup", { kind: "allow-once" });
    await p1;
  });

  it("已 resolve 但还在 grace period 内的 id 也会被 duplicate 检测命中", async () => {
    const broker = new ConfirmationBroker({ resolvedGraceMs: 60_000 });
    broker.onRequest(() => {});
    const req = makeRequest({ id: "g1" });
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once" });
    await promise;

    await expect(
      broker.requestConfirmation(makeRequest({ id: "g1" })),
    ).rejects.toThrow(/duplicate/);
  });
});

// ─── 取消 ───

describe("ConfirmationBroker — cancel/cancelAll", () => {
  it("cancel showing 请求：Promise 以 cancelled 收尾，队列前进", async () => {
    const broker = new ConfirmationBroker();
    const shown: string[] = [];
    broker.onRequest((r) => shown.push(r.id));

    const p1 = broker.requestConfirmation(makeRequest({ id: "a" }));
    const p2 = broker.requestConfirmation(makeRequest({ id: "b" }));
    expect(shown).toEqual(["a"]);

    broker.cancel("a", "user-ctrl-c");
    expect(shown).toEqual(["a", "b"]);

    expect(await p1).toEqual({ kind: "cancelled", cause: "user-ctrl-c" });
    broker.resolve("b", { kind: "allow-once" });
    expect(await p2).toEqual({ kind: "allow-once" });
  });

  it("cancel queued 请求：不影响 showing", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});

    const p1 = broker.requestConfirmation(makeRequest({ id: "a" }));
    const p2 = broker.requestConfirmation(makeRequest({ id: "b" }));
    const p3 = broker.requestConfirmation(makeRequest({ id: "c" }));

    broker.cancel("b", "aborted");
    expect(broker.listPending().map((p) => p.request.id)).toEqual(["a", "c"]);
    expect(await p2).toEqual({ kind: "cancelled", cause: "aborted" });

    broker.resolve("a", { kind: "allow-once" });
    broker.resolve("c", { kind: "allow-once" });
    await p1;
    await p3;
  });

  it("cancelAll 取消所有 pending，返回计数", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});

    const promises = ["a", "b", "c"].map((id) =>
      broker.requestConfirmation(makeRequest({ id })),
    );
    const n = broker.cancelAll("session-end");
    expect(n).toBe(3);
    expect(broker.listPending()).toEqual([]);
    const decisions = await Promise.all(promises);
    expect(decisions).toEqual([
      { kind: "cancelled", cause: "session-end" },
      { kind: "cancelled", cause: "session-end" },
      { kind: "cancelled", cause: "session-end" },
    ]);
  });

  it("cancel 未知 id 返回 false", () => {
    const broker = new ConfirmationBroker();
    expect(broker.cancel("nonexistent", "aborted")).toBe(false);
  });
});

// ─── 超时 ───

describe("ConfirmationBroker — 超时", () => {
  it("到达 expiresAt 后请求自动 expire", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ConfirmationBroker();
      broker.onRequest(() => {});
      const now = Date.now();
      const req = makeRequest({ createdAt: now, expiresAt: now + 1000 });
      const promise = broker.requestConfirmation(req);

      vi.advanceTimersByTime(1001);
      const decision = await promise;
      expect(decision).toEqual({ kind: "expired" });
      expect(broker.listPending()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("超时后队列会前进到下一个请求", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ConfirmationBroker();
      const shown: string[] = [];
      broker.onRequest((r) => shown.push(r.id));

      const now = Date.now();
      const p1 = broker.requestConfirmation(
        makeRequest({ id: "a", createdAt: now, expiresAt: now + 1000 }),
      );
      const p2 = broker.requestConfirmation(
        makeRequest({ id: "b", createdAt: now, expiresAt: now + 60_000 }),
      );

      expect(shown).toEqual(["a"]);

      vi.advanceTimersByTime(1001);
      expect(shown).toEqual(["a", "b"]);
      expect((await p1).kind).toBe("expired");

      broker.resolve("b", { kind: "allow-once" });
      await p2;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 事件发射 ───

describe("ConfirmationBroker — 事件发射", () => {
  it("完整流程发射 requested / shown / resolved 三个事件", async () => {
    const eventBus = new EventBus<ConfirmationEventMap>();
    const events: string[] = [];
    eventBus.onAny((name) => {
      events.push(name);
    });

    const broker = new ConfirmationBroker({ eventBus });
    broker.onRequest(() => {});
    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once" });
    await promise;

    expect(events).toEqual([
      "confirmation:requested",
      "confirmation:shown",
      "confirmation:resolved",
    ]);
  });

  it("cancel 触发 confirmation:cancelled 事件", async () => {
    const eventBus = new EventBus<ConfirmationEventMap>();
    let captured: { cause: string } | null = null;
    eventBus.on("confirmation:cancelled", (p) => {
      captured = { cause: p.cause };
    });

    const broker = new ConfirmationBroker({ eventBus });
    broker.onRequest(() => {});
    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.cancel(req.id, "user-ctrl-c");
    await promise;

    expect(captured).toEqual({ cause: "user-ctrl-c" });
  });

  it("超时触发 confirmation:expired 事件", async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus<ConfirmationEventMap>();
      let expired = false;
      eventBus.on("confirmation:expired", () => {
        expired = true;
      });

      const broker = new ConfirmationBroker({ eventBus });
      broker.onRequest(() => {});
      const now = Date.now();
      const promise = broker.requestConfirmation(
        makeRequest({ createdAt: now, expiresAt: now + 500 }),
      );

      vi.advanceTimersByTime(501);
      await promise;
      expect(expired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Backpressure ───

describe("ConfirmationBroker — backpressure", () => {
  it("队列达到 maxQueueDepth 后新请求立即被 backpressure cancel", async () => {
    const broker = new ConfirmationBroker({ maxQueueDepth: 2 });
    broker.onRequest(() => {});

    const p1 = broker.requestConfirmation(makeRequest({ id: "a" }));
    const p2 = broker.requestConfirmation(makeRequest({ id: "b" }));
    const p3 = broker.requestConfirmation(makeRequest({ id: "c" }));

    // p3 应立即 resolve 为 backpressure cancelled
    const d3 = await p3;
    expect(d3).toEqual({ kind: "cancelled", cause: "backpressure" });

    // p1/p2 仍 pending，可以正常 resolve
    broker.resolve("a", { kind: "allow-once" });
    broker.resolve("b", { kind: "allow-once" });
    await Promise.all([p1, p2]);
  });
});

// ─── snapshot / listPending ───

describe("ConfirmationBroker — snapshot", () => {
  it("snapshot 包含 pending 列表、resolver 名字、监听器计数", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    broker.onRequest(() => {});
    broker.requestConfirmation(makeRequest({ id: "a" }));
    broker.requestConfirmation(makeRequest({ id: "b" }));

    const snap = broker.snapshot();
    expect(snap.pending.map((p) => p.request.id)).toEqual(["a", "b"]);
    expect(snap.listenerCount).toBe(2);
    expect(snap.nonInteractiveResolver).toBe("fail-to-deny");
    expect(snap.resolvedRecently).toEqual([]);
  });

  it("resolve 后 snapshot.resolvedRecently 包含记录", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const req = makeRequest({ id: "x" });
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once" });
    await promise;

    const snap = broker.snapshot();
    expect(snap.pending).toEqual([]);
    expect(snap.resolvedRecently).toHaveLength(1);
    expect(snap.resolvedRecently[0]!.id).toBe("x");
  });
});

// ─── 工厂 ───

describe("createConfirmationBroker + generateRequestId", () => {
  it("createConfirmationBroker 工厂返回可用实例", async () => {
    const broker = createConfirmationBroker();
    const decision = await broker.requestConfirmation(makeRequest());
    expect(decision.kind).toBe("deny"); // 无监听器 → fail-to-deny
  });

  it("generateRequestId 返回 UUID 格式", () => {
    const id = generateRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("failToDenyResolver 的 name 是 fail-to-deny", () => {
    expect(failToDenyResolver.name).toBe("fail-to-deny");
  });

  it("failToAllowResolver 注入后,无监听器路径 → auto-resolve 为 allow-once (测试用,生产严禁)", async () => {
    expect(failToAllowResolver.name).toBe("fail-to-allow");

    const broker = new ConfirmationBroker({
      nonInteractiveResolver: failToAllowResolver,
    });
    const decision = await broker.requestConfirmation(makeRequest());
    expect(decision).toEqual({ kind: "allow-once" });
  });
});

// ─── onResolved 监听器 ───
//
// 远程确认聚合层（ConfirmationHub）需要一个"请求已被解决"的唯一事件源来清理
// 索引 / 推送 RPC 通知。onResolved 覆盖全部 5 条 resolved 路径：
//   1. user resolve
//   2. cancel（含 cancelAll 每个条目）
//   3. expire（超时）
//   4. 无监听器时的非交互兜底（fail-to-deny 等）
//   5. backpressure（队列满）
//
// 对比 EventBus 的 `confirmation:resolved` 事件：后者只针对 user-resolve
// 路径，不覆盖 cancel / expire / 兜底 / backpressure。

describe("ConfirmationBroker — onResolved 监听器", () => {
  it("user resolve 路径触发 onResolved，携带正确的 requestId 和 decision", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const seen: Array<{ id: string; kind: string }> = [];
    broker.onResolved((id, decision) => {
      seen.push({ id, kind: decision.kind });
    });

    const req = makeRequest({ id: "u1" });
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once", note: "ok" });
    await promise;

    expect(seen).toEqual([{ id: "u1", kind: "allow-once" }]);
  });

  it("cancel 路径触发 onResolved，decision 为 cancelled + cause", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const seen: ConfirmationDecision[] = [];
    broker.onResolved((_id, decision) => {
      seen.push(decision);
    });

    const req = makeRequest({ id: "c1" });
    const promise = broker.requestConfirmation(req);
    broker.cancel(req.id, "user-ctrl-c");
    await promise;

    expect(seen).toEqual([{ kind: "cancelled", cause: "user-ctrl-c" }]);
  });

  it("cancelAll 为队列中每个请求触发 onResolved", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const seen: string[] = [];
    broker.onResolved((id) => seen.push(id));

    const promises = ["a", "b", "c"].map((id) =>
      broker.requestConfirmation(makeRequest({ id })),
    );
    broker.cancelAll("session-end");
    await Promise.all(promises);

    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("expire 路径触发 onResolved，decision 为 expired", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ConfirmationBroker();
      broker.onRequest(() => {});
      const seen: ConfirmationDecision[] = [];
      broker.onResolved((_id, decision) => {
        seen.push(decision);
      });

      const now = Date.now();
      const promise = broker.requestConfirmation(
        makeRequest({ id: "e1", createdAt: now, expiresAt: now + 1000 }),
      );
      vi.advanceTimersByTime(1001);
      await promise;

      expect(seen).toEqual([{ kind: "expired" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("非交互兜底路径（无 onRequest 监听器）触发 onResolved", async () => {
    const broker = new ConfirmationBroker(); // 默认 failToDenyResolver
    const seen: ConfirmationDecision[] = [];
    broker.onResolved((_id, decision) => {
      seen.push(decision);
    });

    await broker.requestConfirmation(makeRequest({ id: "n1" }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("deny");
  });

  it("backpressure 路径触发 onResolved，decision 为 cancelled + backpressure", async () => {
    const broker = new ConfirmationBroker({ maxQueueDepth: 1 });
    broker.onRequest(() => {});
    const seen: ConfirmationDecision[] = [];
    broker.onResolved((_id, decision) => {
      seen.push(decision);
    });

    const p1 = broker.requestConfirmation(makeRequest({ id: "bp-a" }));
    const p2 = broker.requestConfirmation(makeRequest({ id: "bp-b" }));

    const d2 = await p2;
    expect(d2).toEqual({ kind: "cancelled", cause: "backpressure" });
    // 第二个请求走 backpressure 路径立即触发 onResolved
    expect(seen).toContainEqual({ kind: "cancelled", cause: "backpressure" });

    broker.resolve("bp-a", { kind: "allow-once" });
    await p1;
    // 然后第一个请求的正常 resolve 路径也触发
    expect(seen).toHaveLength(2);
  });

  it("onResolved 在 requestConfirmation 的 Promise resolve 之前触发", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const order: string[] = [];
    broker.onResolved(() => order.push("listener"));

    const req = makeRequest({ id: "order1" });
    const promise = broker.requestConfirmation(req).then(() => {
      order.push("promise");
    });
    broker.resolve(req.id, { kind: "allow-once" });
    await promise;

    expect(order).toEqual(["listener", "promise"]);
  });

  it("取消订阅后不再触发", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const listener = vi.fn();
    const unsub = broker.onResolved(listener);

    const r1 = makeRequest({ id: "s1" });
    const p1 = broker.requestConfirmation(r1);
    broker.resolve(r1.id, { kind: "allow-once" });
    await p1;
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    const r2 = makeRequest({ id: "s2" });
    const p2 = broker.requestConfirmation(r2);
    broker.resolve(r2.id, { kind: "allow-once" });
    await p2;
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("监听器抛错不影响 broker 主流程和其他监听器", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const faulty: ResolvedListener = () => {
      throw new Error("boom");
    };
    const ok = vi.fn();
    broker.onResolved(faulty);
    broker.onResolved(ok);

    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "allow-once" });
    const decision = await promise;

    expect(decision.kind).toBe("allow-once");
    expect(ok).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it("多个监听器都会收到通知", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const a = vi.fn();
    const b = vi.fn();
    broker.onResolved(a);
    broker.onResolved(b);

    const req = makeRequest();
    const promise = broker.requestConfirmation(req);
    broker.resolve(req.id, { kind: "deny" });
    await promise;

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(req.id, { kind: "deny" });
  });

  it("每个 requestId 至多触发一次（resolve 已成功后再次 resolve 不重复触发）", async () => {
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    const listener = vi.fn();
    broker.onResolved(listener);

    const req = makeRequest({ id: "dup1" });
    const promise = broker.requestConfirmation(req);
    expect(broker.resolve(req.id, { kind: "allow-once" })).toBe(true);
    expect(broker.resolve(req.id, { kind: "deny" })).toBe(false);
    await promise;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(req.id, { kind: "allow-once" });
  });
});

// ─── 审计血缘元信息 ───

describe("ConfirmationBroker — 审计血缘 (id / parentBrokerId / sourceAgentId)", () => {
  it("不传 options.id → 自动生成 UUID v4 形态的稳定 id", () => {
    const a = new ConfirmationBroker();
    const b = new ConfirmationBroker();
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("显式 options.id → 实例 id 使用注入值,跨调用稳定 (测试场景刚需)", () => {
    const broker = new ConfirmationBroker({ id: "fixed-id-001" });
    expect(broker.id).toBe("fixed-id-001");
    expect(broker.snapshot().id).toBe("fixed-id-001");
  });

  it("snapshot 透传 parentBrokerId / sourceAgentId 字段", () => {
    const broker = new ConfirmationBroker({
      id: "child-1",
      parentBrokerId: "parent-1",
      sourceAgentId: "sub-agent-uuid-xyz",
    });
    const snap = broker.snapshot();
    expect(snap.id).toBe("child-1");
    expect(snap.parentBrokerId).toBe("parent-1");
    expect(snap.sourceAgentId).toBe("sub-agent-uuid-xyz");
  });

  it("无 parentBrokerId / sourceAgentId 注入 → snapshot 字段为 undefined (主 broker 形态)", () => {
    const broker = new ConfirmationBroker({ id: "main-1" });
    const snap = broker.snapshot();
    expect(snap.id).toBe("main-1");
    expect(snap.parentBrokerId).toBeUndefined();
    expect(snap.sourceAgentId).toBeUndefined();
  });

  it("eventBus 注入后,所有事件 payload 自动含 brokerId / parentBrokerId / sourceAgentId", async () => {
    const eventBus = new EventBus<ConfirmationEventMap>();
    const captured: Array<{
      event: string;
      brokerId: string;
      parentBrokerId?: string;
      sourceAgentId?: string;
    }> = [];

    // 订阅所有 6 个事件,聚合校验 audit 字段
    const events: Array<keyof ConfirmationEventMap> = [
      "confirmation:requested",
      "confirmation:shown",
      "confirmation:resolved",
      "confirmation:cancelled",
      "confirmation:expired",
      "confirmation:auto-resolved",
    ];
    for (const evt of events) {
      eventBus.on(evt, (payload) => {
        captured.push({
          event: evt,
          brokerId: payload.brokerId,
          parentBrokerId: payload.parentBrokerId,
          sourceAgentId: payload.sourceAgentId,
        });
      });
    }

    const broker = new ConfirmationBroker({
      eventBus,
      id: "child-with-bus",
      parentBrokerId: "parent-bus-123",
      sourceAgentId: "sub-agent-abc",
    });

    // 触发 auto-resolved (无 listener → 走 resolver) → 一个事件
    await broker.requestConfirmation(makeRequest({ id: "auto-1" }));

    // 触发 requested + shown + resolved (有 listener 路径)
    broker.onRequest(() => {});
    const p = broker.requestConfirmation(makeRequest({ id: "active-1" }));
    broker.resolve("active-1", { kind: "allow-once" });
    await p;

    // 触发 cancelled
    const p2 = broker.requestConfirmation(makeRequest({ id: "cancel-1" }));
    broker.cancel("cancel-1", "user-ctrl-c");
    await p2;

    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(c.brokerId).toBe("child-with-bus");
      expect(c.parentBrokerId).toBe("parent-bus-123");
      expect(c.sourceAgentId).toBe("sub-agent-abc");
    }
  });

  it("主 broker 形态 (无 parent / sourceAgent) → 事件 payload 仅含 brokerId,不污染父字段", async () => {
    const eventBus = new EventBus<ConfirmationEventMap>();
    const captured: Array<{
      brokerId: string;
      parentBrokerId?: string;
      sourceAgentId?: string;
    }> = [];

    eventBus.on("confirmation:auto-resolved", (payload) => {
      captured.push({
        brokerId: payload.brokerId,
        parentBrokerId: payload.parentBrokerId,
        sourceAgentId: payload.sourceAgentId,
      });
    });

    const broker = new ConfirmationBroker({ eventBus, id: "main-only" });
    await broker.requestConfirmation(makeRequest({ id: "main-auto" }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.brokerId).toBe("main-only");
    expect(captured[0]!.parentBrokerId).toBeUndefined();
    expect(captured[0]!.sourceAgentId).toBeUndefined();
  });
});
