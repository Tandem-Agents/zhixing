/**
 * ConfirmationHub 单元测试
 *
 * 覆盖 remote-confirmation-execution.md §3.2 的全部不变量：
 *   - attach/detach 生命周期
 *   - INV-H1: 单 conversationId 唯一 broker
 *   - INV-H2: brokerId 全局唯一
 *   - INV-H3: detach 顺序（cancelAll → 取消订阅 → 清索引），pending 的 resolved 事件不丢
 *   - findBrokerByConversation O(1) 反查
 *   - 跨 broker resolve 路由
 *   - listAllPending 聚合
 *   - onEvent 订阅 / 取消
 *   - snapshot
 *   - listener 错误不影响 Hub
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  generateRequestId,
  type ConfirmationRequest,
  type ConfirmationDecision,
} from "@zhixing/core";
import { ConfirmationHub, type HubEvent } from "../hub.js";

// ─── 测试辅助 ───

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
    options: [],
    sessionType: "interactive",
    workspaceId: null,
    createdAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

// ─── attach / detach 基本 ───

describe("ConfirmationHub — attach/detach 基本", () => {
  it("attach 后 snapshot 显示 broker 已注册", () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    hub.attach("b1", broker, { conversationId: "conv1" });

    const snap = hub.snapshot();
    expect(snap.brokers).toHaveLength(1);
    expect(snap.brokers[0]!.brokerId).toBe("b1");
    expect(snap.brokers[0]!.conversationId).toBe("conv1");
    expect(snap.conversationIndexSize).toBe(1);
  });

  it("detach 后从 snapshot 消失", () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    hub.attach("b1", broker, { conversationId: "conv1" });
    hub.detach("b1");

    const snap = hub.snapshot();
    expect(snap.brokers).toHaveLength(0);
    expect(snap.conversationIndexSize).toBe(0);
  });

  it("对未 attach 的 brokerId detach 是 no-op", () => {
    const hub = new ConfirmationHub();
    expect(() => hub.detach("nonexistent")).not.toThrow();
  });
});

// ─── 不变量守护 ───

describe("ConfirmationHub — INV-H2: brokerId 全局唯一", () => {
  it("重复 brokerId attach 抛错", () => {
    const hub = new ConfirmationHub();
    const broker1 = new ConfirmationBroker();
    const broker2 = new ConfirmationBroker();
    hub.attach("same-id", broker1);
    expect(() => hub.attach("same-id", broker2)).toThrow(/INV-H2|already attached/);
  });
});

describe("ConfirmationHub — INV-H1: conversationId 唯一", () => {
  it("同一 conversationId 二次 attach 抛错", () => {
    const hub = new ConfirmationHub();
    const broker1 = new ConfirmationBroker();
    const broker2 = new ConfirmationBroker();
    hub.attach("b1", broker1, { conversationId: "conv-shared" });
    expect(() =>
      hub.attach("b2", broker2, { conversationId: "conv-shared" }),
    ).toThrow(/INV-H1|already has attached/);
  });

  it("不同 conversationId 可共存", () => {
    const hub = new ConfirmationHub();
    hub.attach("b1", new ConfirmationBroker(), { conversationId: "conv-a" });
    hub.attach("b2", new ConfirmationBroker(), { conversationId: "conv-b" });
    expect(hub.snapshot().brokers).toHaveLength(2);
  });

  it("无 conversationId 的 broker 可有多个（ephemeral scope）", () => {
    const hub = new ConfirmationHub();
    hub.attach("ephemeral-1", new ConfirmationBroker());
    hub.attach("ephemeral-2", new ConfirmationBroker());
    expect(hub.snapshot().brokers).toHaveLength(2);
  });

  it("detach 后同一 conversationId 可再次 attach", () => {
    const hub = new ConfirmationHub();
    hub.attach("b1", new ConfirmationBroker(), { conversationId: "conv-a" });
    hub.detach("b1");
    // 应能重新绑定
    expect(() =>
      hub.attach("b2", new ConfirmationBroker(), { conversationId: "conv-a" }),
    ).not.toThrow();
  });
});

describe("ConfirmationHub — INV-H3: detach 顺序", () => {
  it("detach 时先 cancelAll，pending 的 resolved 事件经 Hub listener 送达", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {}); // 挂占位监听器避免走非交互兜底
    hub.attach("b1", broker, { conversationId: "conv1" });

    const events: HubEvent[] = [];
    hub.onEvent((e) => events.push(e));

    const req1 = makeRequest({ id: "r1" });
    const promise = broker.requestConfirmation(req1);

    // 此时应收到一个 request 事件
    expect(events.filter((e) => e.type === "request")).toHaveLength(1);

    // detach 应触发 cancelAll → resolved 事件
    hub.detach("b1");
    const decision = await promise;
    expect(decision).toEqual({ kind: "cancelled", cause: "session-end" });

    const resolvedEvents = events.filter((e) => e.type === "resolved");
    expect(resolvedEvents).toHaveLength(1);
    if (resolvedEvents[0]!.type === "resolved") {
      expect(resolvedEvents[0]!.requestId).toBe("r1");
      expect(resolvedEvents[0]!.decision.kind).toBe("cancelled");
    }
  });

  it("cancelPending=false 时不取消 pending，只清索引", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv1" });

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    hub.detach("b1", { cancelPending: false });

    // broker 的 pending 仍然在（Hub 没有调 cancelAll）
    expect(broker.listPending()).toHaveLength(1);

    // 清场
    broker.resolve("r1", { kind: "allow-once" });
    await promise;
  });

  it("自定义 cancel cause", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    hub.detach("b1", { cause: "aborted" });
    const decision = await promise;
    expect(decision).toEqual({ kind: "cancelled", cause: "aborted" });
  });
});

// ─── findBrokerByConversation ───

describe("ConfirmationHub — findBrokerByConversation（O(1) 反查）", () => {
  it("命中返回 broker 实例", () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    hub.attach("b1", broker, { conversationId: "conv-x" });
    expect(hub.findBrokerByConversation("conv-x")).toBe(broker);
  });

  it("未命中返回 undefined", () => {
    const hub = new ConfirmationHub();
    expect(hub.findBrokerByConversation("none")).toBeUndefined();
  });

  it("detach 后反查失败", () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    hub.attach("b1", broker, { conversationId: "conv-x" });
    hub.detach("b1");
    expect(hub.findBrokerByConversation("conv-x")).toBeUndefined();
  });
});

// ─── findEntry（权限校验用） ───

describe("ConfirmationHub — findEntry", () => {
  it("pending request → 返回含 conversationId 的 HubEntry", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));

    const entry = hub.findEntry("r1");
    expect(entry).toBeDefined();
    expect(entry!.brokerId).toBe("b1");
    expect(entry!.conversationId).toBe("conv-A");
    expect(entry!.request.id).toBe("r1");

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
  });

  it("无 conversationId 的 ephemeral broker → HubEntry.conversationId=undefined", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("ephemeral", broker);

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));

    const entry = hub.findEntry("r1");
    expect(entry).toBeDefined();
    expect(entry!.conversationId).toBeUndefined();
    expect(entry!.brokerId).toBe("ephemeral");

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
  });

  it("已 resolved 的 requestId → 返回 undefined", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    expect(hub.findEntry("r1")).toBeUndefined();
  });

  it("未知 requestId → 返回 undefined", () => {
    const hub = new ConfirmationHub();
    expect(hub.findEntry("nonexistent")).toBeUndefined();
  });
});

// ─── 跨 broker resolve ───

describe("ConfirmationHub — 跨 broker resolve", () => {
  it("按 requestId 路由到正确的 broker", async () => {
    const hub = new ConfirmationHub();
    const brokerA = new ConfirmationBroker();
    const brokerB = new ConfirmationBroker();
    brokerA.onRequest(() => {});
    brokerB.onRequest(() => {});
    hub.attach("bA", brokerA, { conversationId: "conv-A" });
    hub.attach("bB", brokerB, { conversationId: "conv-B" });

    const p1 = brokerA.requestConfirmation(makeRequest({ id: "rA" }));
    const p2 = brokerB.requestConfirmation(makeRequest({ id: "rB" }));

    // 通过 Hub 解决 B 会话的请求
    expect(hub.resolve("rB", { kind: "allow-once" })).toBe(true);

    const decisionB = await p2;
    expect(decisionB).toEqual({ kind: "allow-once" });

    // A 的 pending 未受影响
    expect(brokerA.listPending()).toHaveLength(1);

    brokerA.resolve("rA", { kind: "deny" });
    await p1;
  });

  it("未知 requestId 返回 false", () => {
    const hub = new ConfirmationHub();
    expect(hub.resolve("nonexistent", { kind: "allow-once" })).toBe(false);
  });

  it("已解决的 request（在 grace period 内）返回 false（幂等）", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    expect(hub.resolve("r1", { kind: "allow-once" })).toBe(true);
    // 第二次：requestIndex 已清，返 false
    expect(hub.resolve("r1", { kind: "deny" })).toBe(false);
    expect((await promise).kind).toBe("allow-once");
  });
});

// ─── listAllPending ───

describe("ConfirmationHub — listAllPending", () => {
  it("聚合所有 broker 的 pending，带元数据", async () => {
    const hub = new ConfirmationHub();
    const brokerA = new ConfirmationBroker();
    const brokerB = new ConfirmationBroker();
    brokerA.onRequest(() => {});
    brokerB.onRequest(() => {});
    hub.attach("bA", brokerA, { conversationId: "conv-A" });
    hub.attach("bB", brokerB, { conversationId: "conv-B" });

    const p1 = brokerA.requestConfirmation(makeRequest({ id: "rA-1" }));
    const p2 = brokerA.requestConfirmation(makeRequest({ id: "rA-2" }));
    const p3 = brokerB.requestConfirmation(makeRequest({ id: "rB-1" }));

    const all = hub.listAllPending();
    expect(all).toHaveLength(3);

    const byId = new Map(all.map((e) => [e.request.id, e]));
    expect(byId.get("rA-1")?.brokerId).toBe("bA");
    expect(byId.get("rA-1")?.conversationId).toBe("conv-A");
    expect(byId.get("rB-1")?.brokerId).toBe("bB");
    expect(byId.get("rB-1")?.conversationId).toBe("conv-B");

    // 清场
    brokerA.resolve("rA-1", { kind: "allow-once" });
    brokerA.resolve("rA-2", { kind: "allow-once" });
    brokerB.resolve("rB-1", { kind: "allow-once" });
    await Promise.all([p1, p2, p3]);
  });
});

// ─── onEvent 订阅 ───

describe("ConfirmationHub — onEvent", () => {
  it("request 和 resolved 事件都发射", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv1" });

    const events: HubEvent[] = [];
    hub.onEvent((e) => events.push(e));

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    expect(events.map((e) => e.type)).toEqual(["request", "resolved"]);
    if (events[1]!.type === "resolved") {
      expect(events[1]!.requestId).toBe("r1");
      expect(events[1]!.brokerId).toBe("b1");
      expect(events[1]!.conversationId).toBe("conv1");
      expect(events[1]!.decision).toEqual({ kind: "allow-once" });
    }
  });

  it("unsubscribe 后不再收到事件", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const listener = vi.fn();
    const unsub = hub.onEvent(listener);

    const p1 = broker.requestConfirmation(makeRequest({ id: "r1" }));
    broker.resolve("r1", { kind: "allow-once" });
    await p1;
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();

    const p2 = broker.requestConfirmation(makeRequest({ id: "r2" }));
    broker.resolve("r2", { kind: "allow-once" });
    await p2;
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("listener 抛错不影响 Hub 主流程 / 其它 listener", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const faulty = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    hub.onEvent(faulty);
    hub.onEvent(ok);

    const promise = broker.requestConfirmation(makeRequest({ id: "r1" }));
    broker.resolve("r1", { kind: "allow-once" });
    const decision = await promise;

    expect(decision).toEqual({ kind: "allow-once" });
    expect(ok).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

// ─── 多 broker 资源隔离 ───

describe("ConfirmationHub — 资源隔离", () => {
  it("A broker 的事件不泄漏到 B broker 的索引", async () => {
    const hub = new ConfirmationHub();
    const brokerA = new ConfirmationBroker();
    const brokerB = new ConfirmationBroker();
    brokerA.onRequest(() => {});
    brokerB.onRequest(() => {});
    hub.attach("bA", brokerA, { conversationId: "conv-A" });
    hub.attach("bB", brokerB, { conversationId: "conv-B" });

    const promise = brokerA.requestConfirmation(makeRequest({ id: "rA" }));

    // conv-B 反查不能拿到 A 的 broker
    expect(hub.findBrokerByConversation("conv-B")).toBe(brokerB);
    expect(hub.findBrokerByConversation("conv-A")).toBe(brokerA);

    brokerA.resolve("rA", { kind: "allow-once" });
    await promise;
  });

  it("detach A 不影响 B 的 pending 和索引", async () => {
    const hub = new ConfirmationHub();
    const brokerA = new ConfirmationBroker();
    const brokerB = new ConfirmationBroker();
    brokerA.onRequest(() => {});
    brokerB.onRequest(() => {});
    hub.attach("bA", brokerA, { conversationId: "conv-A" });
    hub.attach("bB", brokerB, { conversationId: "conv-B" });

    const pA = brokerA.requestConfirmation(makeRequest({ id: "rA" }));
    const pB = brokerB.requestConfirmation(makeRequest({ id: "rB" }));

    hub.detach("bA");

    // B 的索引和 pending 不受影响
    expect(hub.findBrokerByConversation("conv-B")).toBe(brokerB);
    expect(brokerB.listPending()).toHaveLength(1);

    // A 的请求被 cancel（INV-H3）
    expect((await pA).kind).toBe("cancelled");

    brokerB.resolve("rB", { kind: "allow-once" });
    await pB;
  });
});
