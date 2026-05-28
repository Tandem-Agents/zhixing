/**
 * confirmation.* RPC 方法单元测试
 *
 * 覆盖：
 *   - confirmation.list：observer 过滤（默认 / 指定 conversationId）
 *   - confirmation.list：未注册 hub → INTERNAL_ERROR
 *   - confirmation.resolve：成功 / 已解决 / 参数校验
 */

import { describe, it, expect, vi } from "vitest";
import {
  ConfirmationBroker,
  type ConfirmationRequest,
} from "@zhixing/core";
import { ConfirmationHub } from "../../../confirmation/hub.js";
import type { ServerContext } from "../../../context.js";
import type { RpcConnection } from "../../connection.js";
import type { ConversationManager } from "../../../runtime/conversation-manager.js";
import type { HandlerContext, MethodEntry } from "../../handlers.js";
import { RpcAppError } from "../../handlers.js";
import {
  buildConfirmationListMethod,
  buildConfirmationResolveMethod,
} from "../confirmation.js";

// ─── 测试辅助 ───

function makeConnection(id: number): RpcConnection {
  return {
    id,
    authenticated: true,
    sendSuccess: vi.fn(),
    sendError: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    closed: false,
    onClose: () => () => {},
  } as unknown as RpcConnection;
}

function makeFakeConversations(
  map: Map<string, Set<string>>,
): ConversationManager {
  return {
    getObserverConnectionIds: (conversationId: string) =>
      map.get(conversationId) ?? new Set<string>(),
  } as unknown as ConversationManager;
}

function makeContext(
  server: ServerContext,
  connection: RpcConnection,
): HandlerContext {
  return { connection, server };
}

function makeRequest(id: string): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title: "Bash 命令",
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

async function invoke<T>(
  method: MethodEntry,
  params: unknown,
  ctx: HandlerContext,
): Promise<T> {
  return (await method.handler(params, ctx)) as T;
}

// ─── confirmation.list ───

describe("confirmation.list", () => {
  it("默认：只返回当前连接作为 observer 的会话的 pending", async () => {
    const hub = new ConfirmationHub();
    const brokerA = new ConfirmationBroker();
    const brokerB = new ConfirmationBroker();
    brokerA.onRequest(() => {});
    brokerB.onRequest(() => {});
    hub.attach("bA", brokerA, { conversationId: "conv-A" });
    hub.attach("bB", brokerB, { conversationId: "conv-B" });

    const pA = brokerA.requestConfirmation(makeRequest("rA"));
    const pB = brokerB.requestConfirmation(makeRequest("rB"));

    // conn(1) 是 conv-A 的 observer；不是 conv-B 的
    const conversations = makeFakeConversations(
      new Map([
        ["conv-A", new Set(["1"])],
        ["conv-B", new Set(["99"])],
      ]),
    );
    const server = {
      confirmationHub: hub,
      conversations,
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationListMethod();
    const result = await invoke<{ items: Array<{ requestId: string }> }>(
      method,
      {},
      ctx,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.requestId).toBe("rA");

    // 清场
    brokerA.resolve("rA", { kind: "allow-once" });
    brokerB.resolve("rB", { kind: "allow-once" });
    await Promise.all([pA, pB]);
  });

  it("显式 conversationId：非 observer 返回空", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("rA"));

    // conn(1) 不是 conv-A 的 observer
    const conversations = makeFakeConversations(
      new Map([["conv-A", new Set(["99"])]]),
    );
    const server = {
      confirmationHub: hub,
      conversations,
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationListMethod();
    const result = await invoke<{ items: unknown[] }>(
      method,
      { conversationId: "conv-A" },
      ctx,
    );

    expect(result.items).toHaveLength(0);

    broker.resolve("rA", { kind: "allow-once" });
    await p;
  });

  it("ephemeral（无 conversationId）默认不暴露", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("ephemeral", broker); // 无 conversationId

    const p = broker.requestConfirmation(makeRequest("rE"));

    const conversations = makeFakeConversations(new Map());
    const server = {
      confirmationHub: hub,
      conversations,
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationListMethod();
    const result = await invoke<{ items: unknown[] }>(method, {}, ctx);

    expect(result.items).toHaveLength(0);

    broker.resolve("rE", { kind: "allow-once" });
    await p;
  });

  it("hub 未配置 → INTERNAL_ERROR", () => {
    const server = {
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationListMethod();
    // handler 同步抛错（非 async）
    expect(() => method.handler({}, ctx)).toThrow(RpcAppError);
  });
});

// ─── confirmation.resolve ───

describe("confirmation.resolve", () => {
  it("caller 是 observer → 成功 resolve 返回 { ok: true }", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("r1"));

    // conn(1) 是 conv-A 的 observer
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    const result = await invoke<{ ok: boolean }>(
      method,
      { requestId: "r1", decision: { kind: "allow-once" } },
      ctx,
    );

    expect(result).toEqual({ ok: true });
    expect((await p).kind).toBe("allow-once");
  });

  it("caller 非 observer → 抛 Unauthorized（越权防护）", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("r1"));

    // conn(1) 不是 conv-A 的 observer（conn(99) 才是）
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["99"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler(
        { requestId: "r1", decision: { kind: "allow-once" } },
        ctx,
      ),
    ).toThrow(RpcAppError);

    // broker pending 保持不变
    expect(broker.listPending()).toHaveLength(1);

    broker.resolve("r1", { kind: "allow-once" });
    await p;
  });

  it("ephemeral pending（无 conversationId）→ 拒绝远程 resolve", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("ephemeral", broker); // 无 conversationId

    const p = broker.requestConfirmation(makeRequest("rE"));

    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler(
        { requestId: "rE", decision: { kind: "allow-once" } },
        ctx,
      ),
    ).toThrow(RpcAppError);

    broker.resolve("rE", { kind: "allow-once" });
    await p;
  });

  it("未知 requestId 返回 { ok: false, reason: 'already-resolved-or-not-found' }", async () => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    const result = await invoke<{ ok: boolean; reason?: string }>(
      method,
      { requestId: "nonexistent", decision: { kind: "allow-once" } },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already-resolved-or-not-found");
  });

  it("已解决的 requestId（已出 hub.requestIndex）→ { ok: false }", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("r1"));
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();

    // 第一次：ok
    const r1 = await invoke<{ ok: boolean }>(
      method,
      { requestId: "r1", decision: { kind: "allow-once" } },
      ctx,
    );
    expect(r1.ok).toBe(true);

    // 第二次：hub.findEntry 返 undefined → already-resolved
    const r2 = await invoke<{ ok: boolean; reason?: string }>(
      method,
      { requestId: "r1", decision: { kind: "deny" } },
      ctx,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("already-resolved-or-not-found");

    await p;
  });

  // ─── kind 白名单（spec §2.2 防远程持久授权） ───

  it.each([
    ["allow-session", { pattern: { pattern: { executable: "x", argument: "y" } } }],
    ["allow-context", { pattern: { pattern: { executable: "x", argument: "y" } } }],
    ["allow-global", { pattern: { pattern: { executable: "x", argument: "y" } } }],
    ["edit-then-allow", { modifiedInput: {} }],
  ])("远程 kind='%s' → invalid params（远程路径不支持持久授权 / 编辑）", (kind, extra) => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler(
        { requestId: "r1", decision: { kind, ...extra } },
        ctx,
      ),
    ).toThrow(RpcAppError);
  });

  it("远程 kind='allow-once' / 'deny'（±reason）→ 都在白名单", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));
    const method = buildConfirmationResolveMethod();

    // 自由文本理由通过 { kind: "deny", reason } 表达——无独立 kind
    for (const [reqSuffix, decision] of [
      ["allow", { kind: "allow-once" }],
      ["deny-bare", { kind: "deny" }],
      ["deny-with-reason", { kind: "deny", reason: "no thanks" }],
    ] as const) {
      const req = makeRequest(`r-${reqSuffix}`);
      const p = broker.requestConfirmation(req);
      const result = await invoke<{ ok: boolean }>(
        method,
        { requestId: req.id, decision },
        ctx,
      );
      expect(result.ok).toBe(true);
      await p;
    }
  });

  it("缺少 requestId → invalid params", () => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler({ decision: { kind: "allow-once" } }, ctx),
    ).toThrow(RpcAppError);
  });

  it("缺少 decision → invalid params", () => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() => method.handler({ requestId: "r1" }, ctx)).toThrow(RpcAppError);
  });

  it("decision 无 kind → invalid params", () => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler({ requestId: "r1", decision: {} }, ctx),
    ).toThrow(RpcAppError);
  });
});
