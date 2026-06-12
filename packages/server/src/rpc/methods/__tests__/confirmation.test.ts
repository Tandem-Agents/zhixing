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

function makeConnection(
  id: number,
  opts?: { loopback?: boolean },
): RpcConnection {
  return {
    id,
    authenticated: true,
    // 测试主路径默认可信面(本机 loopback);受限面测试显式传 false
    loopback: opts?.loopback ?? true,
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

/** triggeredBy 缺省 "1"(与默认 caller 连接 id 匹配)——发起接入面即测试主路径 */
function makeRequest(
  id: string,
  turnOrigin?: { channel: string; triggeredBy?: string } | null,
): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    ...(turnOrigin === null
      ? {}
      : { turnOrigin: turnOrigin ?? { channel: "rpc", triggeredBy: "1" } }),
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
    contextId: { kind: "main" },
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
  it("caller 是发起接入面(origin triggeredBy 匹配)→ 成功 resolve 返回 { ok: true }", async () => {
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
    const result = await invoke<{ ok: boolean }>(
      method,
      { requestId: "r1", decision: { kind: "allow-once" } },
      ctx,
    );

    expect(result).toEqual({ ok: true });
    expect((await p).kind).toBe("allow-once");
  });

  it("旁观 observer(非发起者)→ 抛 Unauthorized——可见不可代答由结构保证", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    // 发起者是连接 99;caller 连接 1 即便在 observer 名册也不可代答
    const p = broker.requestConfirmation(
      makeRequest("r1", { channel: "rpc", triggeredBy: "99" }),
    );

    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1", "99"])]]),
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

  it("渠道发起的确认(turnOrigin.channel ≠ rpc)→ RPC caller 拒绝——在渠道侧应答", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "dm:feishu:u1" });

    const p = broker.requestConfirmation(
      makeRequest("rC", { channel: "feishu", triggeredBy: "u1" }),
    );

    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["dm:feishu:u1", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    expect(() =>
      buildConfirmationResolveMethod().handler(
        { requestId: "rC", decision: { kind: "allow-once" } },
        ctx,
      ),
    ).toThrow(RpcAppError);

    broker.resolve("rC", { kind: "allow-once" });
    await p;
  });

  it("无 turnOrigin 的 pending(ephemeral / 直驱)→ 拒绝远程 resolve", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("ephemeral", broker); // 无 conversationId

    const p = broker.requestConfirmation(makeRequest("rE", null));

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

  // ─── kind 白名单——按接入面信任级分级 ───

  it.each([
    ["allow-session", { pattern: { pattern: { tool: "x", argument: "y" }, label: "x y" } }],
    ["allow-context", { pattern: { pattern: { tool: "x", argument: "y" }, label: "x y" } }],
    ["allow-global", { pattern: { pattern: { tool: "x", argument: "y" }, label: "x y" } }],
    ["edit-then-allow", { modifiedInput: {} }],
  ])("非可信面(非 loopback)kind='%s' → invalid params(远程不得沉淀永久规则)", (kind, extra) => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1, { loopback: false }));

    const method = buildConfirmationResolveMethod();
    expect(() =>
      method.handler(
        { requestId: "r1", decision: { kind, ...extra } },
        ctx,
      ),
    ).toThrow(RpcAppError);
  });

  it("可信面 kind='edit-then-allow' 同样拒绝(远程 UX 未设计,两级都不含)", () => {
    const hub = new ConfirmationHub();
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(new Map()),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    expect(() =>
      buildConfirmationResolveMethod().handler(
        { requestId: "r1", decision: { kind: "edit-then-allow", modifiedInput: {} } },
        ctx,
      ),
    ).toThrow(RpcAppError);
  });

  it("可信面持久授权缺 pattern / 坏 pattern 结构 → INVALID_PARAMS,pending 保持未解决", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("rBad"));
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));
    const method = buildConfirmationResolveMethod();

    for (const decision of [
      { kind: "allow-global" }, // 缺 pattern
      { kind: "allow-context", pattern: {} }, // 缺内层
      { kind: "allow-session", pattern: { pattern: { tool: "" }, label: "x" } }, // tool 空
      { kind: "allow-global", pattern: { pattern: { tool: "bash", argument: "ls" } } }, // 缺 label
      { kind: "deny", reason: 42 }, // reason 坏类型
    ]) {
      expect(() =>
        method.handler({ requestId: "rBad", decision }, ctx),
      ).toThrow(RpcAppError);
    }
    // 坏结构全部在边界拦截——pending 未被消费
    expect(broker.listPending()).toHaveLength(1);

    broker.resolve("rBad", { kind: "allow-once" });
    await p;
  });

  it("可信面(loopback + 已认证)持久授权 kind='allow-global' → 成功,决策原样达 broker", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv-A" });

    const p = broker.requestConfirmation(makeRequest("rG"));
    const server = {
      confirmationHub: hub,
      conversations: makeFakeConversations(
        new Map([["conv-A", new Set(["1"])]]),
      ),
    } as unknown as ServerContext;
    const ctx = makeContext(server, makeConnection(1));

    const decision = {
      kind: "allow-global",
      pattern: { pattern: { tool: "bash", argument: "ls *" }, label: "bash ls *" },
    };
    const result = await invoke<{ ok: boolean }>(
      buildConfirmationResolveMethod(),
      { requestId: "rG", decision },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((await p).kind).toBe("allow-global");
  });

  it("可信面 kind='allow-once' / 'deny'（±reason）→ 都在白名单", async () => {
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
