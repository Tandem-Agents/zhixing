/**
 * ConfirmationBridge 单元测试
 *
 * 覆盖 remote-confirmation-execution.md §3.9：
 *   - request 事件按 conversation observer 过滤推送
 *   - resolved 事件按 conversation observer 过滤推送
 *   - admin-scoped 兜底（无 conversationId → 广播到所有 authenticated）
 *   - 未认证 / 已关闭连接被过滤
 *   - dispose 取消订阅
 *   - payload 不暴露 reason / note（隐私保护）
 */

import { describe, it, expect, vi } from "vitest";
import {
  ConfirmationBroker,
  type ConfirmationRequest,
} from "@zhixing/core";
import { ConfirmationHub } from "../../confirmation/hub.js";
import type { RpcConnection } from "../connection.js";
import type { ConversationManager } from "../../runtime/conversation-manager.js";
import { createConfirmationBridge } from "../confirmation-bridge.js";

// ─── 测试辅助 ───

function makeFakeConnection(
  id: number,
  opts?: { authenticated?: boolean; closed?: boolean },
): RpcConnection & {
  notifications: Array<{ method: string; params: unknown }>;
} {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const conn: RpcConnection & {
    notifications: Array<{ method: string; params: unknown }>;
  } = {
    id,
    authenticated: opts?.authenticated ?? true,
    clientInfo: undefined,
    sendSuccess: vi.fn(),
    sendError: vi.fn(),
    notify: (method: string, params: unknown) => {
      notifications.push({ method, params });
    },
    close: vi.fn(),
    closed: opts?.closed ?? false,
    onClose: () => () => {},
    notifications,
  } as never;
  return conn;
}

/** 最小 ConversationManager mock——按 conversationId 返回固定 observerIds */
function makeFakeConversations(
  map: Map<string, Set<string>>,
): ConversationManager {
  return {
    getObserverConnectionIds: (conversationId: string) =>
      map.get(conversationId) ?? new Set<string>(),
  } as unknown as ConversationManager;
}

function makeRequest(
  id: string,
  title: string = "Bash 命令",
): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title,
      body: { kind: "bash", command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [],
    sessionType: "interactive",
    contextId: "main",
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

// ─── 基础推送 ───

describe("ConfirmationBridge — observer-scoped 推送", () => {
  it("request 事件：按 conversationId 的 observer 推送", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const connA = makeFakeConnection(1);
    const connB = makeFakeConnection(2);
    const connections = new Set<RpcConnection>([connA, connB]);

    // connA 是 conv-A 的 observer，connB 不是
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1"])]]),
    );

    const bridge = createConfirmationBridge({ connections, hub, conversations });

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    // connA 收到 pending + resolved
    expect(connA.notifications).toHaveLength(2);
    expect(connA.notifications[0]!.method).toBe("confirmation.pending");
    expect(connA.notifications[1]!.method).toBe("confirmation.resolved");

    // connB 没收到（非 observer）
    expect(connB.notifications).toHaveLength(0);

    bridge.dispose();
  });

  it("resolved 事件：payload 不含 reason / note（隐私保护）", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const conn = makeFakeConnection(1);
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1"])]]),
    );
    const bridge = createConfirmationBridge({
      connections: new Set([conn]),
      hub,
      conversations,
    });

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", {
      kind: "deny",
      reason: "不要碰生产！包含敏感内容",
    });
    await promise;

    const resolvedEvent = conn.notifications.find(
      (n) => n.method === "confirmation.resolved",
    );
    expect(resolvedEvent).toBeDefined();
    const payload = resolvedEvent!.params as Record<string, unknown>;
    expect(payload.decision).toBe("deny");
    // reason 不暴露到 RPC payload（隐私保护）——客户端从 payload.decision 和
    // 其他 UX 信号推断，不直接看到自由文本理由
    expect(payload).not.toHaveProperty("reason");
    expect(payload.requestId).toBe("r1");

    bridge.dispose();
  });

  it("无 conversationId（scheduler ephemeral）→ admin-scoped 广播到所有 authenticated 连接", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("ephemeral", broker); // 无 conversationId

    const connA = makeFakeConnection(1);
    const connB = makeFakeConnection(2);
    const connections = new Set<RpcConnection>([connA, connB]);
    const conversations = makeFakeConversations(new Map());
    const bridge = createConfirmationBridge({ connections, hub, conversations });

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    // 两个连接都收到（admin-scoped）
    expect(connA.notifications).toHaveLength(2);
    expect(connB.notifications).toHaveLength(2);

    bridge.dispose();
  });

  it("未认证连接不收到推送", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const connAuth = makeFakeConnection(1, { authenticated: true });
    // 即便 id=2 在 observer 集合里，但未认证 → 过滤
    const connUnauth = makeFakeConnection(2, { authenticated: false });
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1", "2"])]]),
    );
    const bridge = createConfirmationBridge({
      connections: new Set([connAuth, connUnauth]),
      hub,
      conversations,
    });

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    expect(connAuth.notifications).toHaveLength(2);
    expect(connUnauth.notifications).toHaveLength(0);

    bridge.dispose();
  });

  it("已关闭连接不收到推送", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const conn = makeFakeConnection(1, { authenticated: true, closed: true });
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1"])]]),
    );
    const bridge = createConfirmationBridge({
      connections: new Set([conn]),
      hub,
      conversations,
    });

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    expect(conn.notifications).toHaveLength(0);
    bridge.dispose();
  });
});

// ─── pending payload 字段 ───

describe("ConfirmationBridge — confirmation.pending payload", () => {
  it("payload 含 requestId / tool / operationSummary / operationDetail / stewardReason / expiresAt", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const conn = makeFakeConnection(1);
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1"])]]),
    );
    const bridge = createConfirmationBridge({
      connections: new Set([conn]),
      hub,
      conversations,
    });

    const req = makeRequest("r-payload", "Bash 命令");
    req.display.stewardReason = "向外部地址上传数据，与任务意图不完全匹配";
    const promise = broker.requestConfirmation(req);
    broker.resolve("r-payload", { kind: "allow-once" });
    await promise;

    const pendingEvent = conn.notifications.find(
      (n) => n.method === "confirmation.pending",
    );
    expect(pendingEvent).toBeDefined();
    const payload = pendingEvent!.params as Record<string, unknown>;
    expect(payload.requestId).toBe("r-payload");
    expect(payload.conversationId).toBe("conv-A");
    expect(payload.tool).toBe("bash");
    expect(payload.operationSummary).toBe("Bash 命令");
    expect(payload.operationDetail).toBe("ls");
    expect(payload.stewardReason).toBe(
      "向外部地址上传数据，与任务意图不完全匹配",
    );
    expect(payload.expiresAt).toBe(req.expiresAt);

    bridge.dispose();
  });
});

// ─── dispose ───

describe("ConfirmationBridge — dispose", () => {
  it("dispose 后不再推送", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const conn = makeFakeConnection(1);
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["1"])]]),
    );
    const bridge = createConfirmationBridge({
      connections: new Set([conn]),
      hub,
      conversations,
    });

    bridge.dispose();

    const promise = broker.requestConfirmation(makeRequest("r1"));
    broker.resolve("r1", { kind: "allow-once" });
    await promise;

    expect(conn.notifications).toHaveLength(0);
  });
});
