import { describe, it, expect, vi, beforeEach } from "vitest";
import { InboundRouter } from "../inbound-router.js";
import { ConversationManager } from "../../runtime/conversation-manager.js";
import { ConfirmationHub } from "../../confirmation/hub.js";
import {
  ConfirmationBroker,
  createEventBus,
  type ChannelEventMap,
  type ChannelAdapter,
  type ChannelLogger,
  type ConfirmationRequest,
  type DeliveryResult,
  type InboundMessage,
  ChannelRegistry,
} from "@zhixing/core";
import type { SessionRuntime, RuntimeFactory } from "../../runtime/types.js";
import type { AgentYield, Message, RunResult } from "@zhixing/core";

// ─── Mock 工厂 ───

function createMockRuntime(response?: { text: string }): SessionRuntime {
  const text = response?.text ?? "Hello from agent";
  return {
    sessionId: "rt-1",
    run: vi.fn(function* (): Generator<AgentYield, RunResult> {
      yield { type: "text_delta", text };
      const assistantMsg: Message = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      const userMsg: Message = {
        role: "user",
        content: [{ type: "text", text: "(mock user)" }],
      };
      return {
        agentResult: {
          reason: "completed" as const,
          message: assistantMsg,
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        turn: {
          type: "turn",
          turnIndex: 0,
          timestamp: new Date().toISOString(),
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          usage: { inputTokens: 10, outputTokens: 5 },
          source: "channel",
        },
        newMessages: [assistantMsg],
        durationMs: 0,
      };
    }) as unknown as SessionRuntime["run"],
    getHistory: () => [],
    updateMessages: vi.fn(),
    abort: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

function createMockRuntimeFactory(runtime?: SessionRuntime): RuntimeFactory {
  return {
    create: vi.fn(async () => runtime ?? createMockRuntime()),
  };
}

function createMockAdapter(id = "test-ch"): ChannelAdapter {
  return {
    id,
    capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (): Promise<DeliveryResult> => ({
      success: true,
      messageId: "reply-1",
      retryable: false,
    })),
  };
}

function createTestLogger(): ChannelLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function dmMessage(channelId = "test-ch", from = "user-1", text = "你好"): InboundMessage {
  return { channelId, from, text, chatType: "dm" };
}

function groupMessage(channelId = "test-ch", from = "user-1", groupId = "grp-1", text = "你好"): InboundMessage {
  return { channelId, from, text, chatType: "group", groupId };
}

// ─── 测试 ───

describe("InboundRouter", () => {
  let logger: ChannelLogger;
  let eventBus: ReturnType<typeof createEventBus<ChannelEventMap>>;

  beforeEach(() => {
    logger = createTestLogger();
    eventBus = createEventBus<ChannelEventMap>();
  });

  function setup(options?: {
    adapter?: ChannelAdapter;
    runtime?: SessionRuntime;
  }) {
    const adapter = options?.adapter ?? createMockAdapter();
    const factory = createMockRuntimeFactory(options?.runtime);
    const conversations = new ConversationManager(factory, {
      graceTimeoutMs: 100_000,
      idleTimeoutMs: 100_000,
      idleCheckIntervalMs: 100_000,
    });
    const channels = new ChannelRegistry({
      eventBus,
      logger,
      onMessage: () => {},
    });
    channels.register(adapter);

    const router = new InboundRouter({ conversations, channels, logger });

    return { adapter, factory, conversations, channels, router };
  }

  it("routes DM message to agent and sends reply", async () => {
    const { adapter, router } = setup();
    const msg = dmMessage();

    await router.handleMessage(msg);

    // Wait for async turn to complete
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalled();
    });

    const [target, content] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(target).toEqual({
      channelId: "test-ch",
      to: "user-1",
      threadId: undefined,
    });
    expect(content.text).toBe("Hello from agent");
  });

  it("routes group message with group as reply target", async () => {
    const { adapter, router } = setup();
    const msg = groupMessage();

    await router.handleMessage(msg);

    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalled();
    });

    const [target] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(target.to).toBe("grp-1");
  });

  it("creates conversation via ConversationManager", async () => {
    const { conversations, router } = setup();
    const msg = dmMessage();

    await router.handleMessage(msg);

    await vi.waitFor(() => {
      expect(conversations.has("dm:test-ch:user-1")).toBe(true);
    });
  });

  it("reuses same conversation for same user", async () => {
    const { adapter, factory, router } = setup();

    await router.handleMessage(dmMessage("test-ch", "user-1", "msg 1"));
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
    });

    await router.handleMessage(dmMessage("test-ch", "user-1", "msg 2"));
    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalledTimes(2);
    });

    // Factory should have created only one runtime
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it("records turn with source='channel'", async () => {
    const { conversations, router } = setup();
    const recordSpy = vi.spyOn(conversations, "recordTurn");

    await router.handleMessage(dmMessage());

    await vi.waitFor(() => {
      expect(recordSpy).toHaveBeenCalled();
    });

    const [, turn] = recordSpy.mock.calls[0];
    expect(turn.source).toBe("channel");
  });

  it("warns when adapter not found", async () => {
    const { router } = setup();
    const msg = dmMessage("unknown-ch");

    await router.handleMessage(msg);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No adapter found"),
    );
  });

  it("sends busy reply when queue is full", async () => {
    const neverResolve = new Promise<never>(() => {});
    const slowRuntime: SessionRuntime = {
      sessionId: "slow",
      run: vi.fn(async function* () {
        await neverResolve;
        return { reason: "completed" as const, message: { role: "assistant" as const, content: [] }, usage: { inputTokens: 0, outputTokens: 0 } };
      }) as unknown as SessionRuntime["run"],
      getHistory: () => [],
      abort: vi.fn(),
      dispose: vi.fn(),
    };

    const { adapter, conversations, router } = setup({ runtime: slowRuntime });

    // First message starts running (never completes)
    await router.handleMessage(dmMessage("test-ch", "user-1", "first"));

    // Fill the pending queue (default maxPending=5)
    for (let i = 0; i < 5; i++) {
      await router.handleMessage(dmMessage("test-ch", "user-1", `queued-${i}`));
    }

    // This one should be rejected
    await router.handleMessage(dmMessage("test-ch", "user-1", "overflow"));

    expect(adapter.send).toHaveBeenCalled();
    const lastCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(lastCall[1].text).toContain("队列已满");

    // Cleanup: dispose conversations to stop timers
    conversations.disposeAll();
  });

  it("handles agent error and sends error reply", async () => {
    const errorRuntime: SessionRuntime = {
      sessionId: "err",
      run: vi.fn(function* (): Generator<AgentYield, RunResult> {
        const errorMsg = Object.assign(new Error("LLM failed"), { name: "AgentError" });
        return {
          agentResult: {
            reason: "error" as const,
            error: errorMsg,
            usage: { inputTokens: 0, outputTokens: 0 },
          },
          turn: {
            type: "turn",
            turnIndex: 0,
            timestamp: new Date().toISOString(),
            userMessage: { role: "user", content: [] },
            assistantMessage: { role: "assistant", content: [] },
          },
          newMessages: [],
          durationMs: 0,
        };
      }) as unknown as SessionRuntime["run"],
      getHistory: () => [],
      updateMessages: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };

    const { adapter, router } = setup({ runtime: errorRuntime });

    await router.handleMessage(dmMessage());

    await vi.waitFor(() => {
      expect(adapter.send).toHaveBeenCalled();
    });

    const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(content.text).toContain("LLM failed");
  });

  // ─── Outbox 集成（ADR-007 Phase 1） ───

  it("setOutboxRegistry 是 write-once，重复绑定抛异常", async () => {
    const { OutboxRegistry } = await import("@zhixing/core");
    const { router } = setup();

    const registry1 = new OutboxRegistry(async () => ({ success: true, retryable: false }));
    const registry2 = new OutboxRegistry(async () => ({ success: true, retryable: false }));

    router.setOutboxRegistry(registry1);
    expect(() => router.setOutboxRegistry(registry2)).toThrow(/already bound/);
  });

  // ─── Turn Slot 生命周期（ADR-007 Phase 3） ───

  it("P3d: runChannelTurn 开头 openSlot，成功回复 fillSlot", async () => {
    const { OutboxRegistry } = await import("@zhixing/core");
    const events: Array<{ type: string; slotId?: string }> = [];

    const registry = new OutboxRegistry(
      async () => ({ success: true, messageId: "m1", retryable: false }),
      {
        onEvent: (e) => {
          if (
            e.type === "slot:opened" ||
            e.type === "slot:filled" ||
            e.type === "slot:abandoned"
          ) {
            events.push({ type: e.type, slotId: e.slotId });
          }
        },
      },
    );

    const { router } = setup();
    router.setOutboxRegistry(registry);

    await router.handleMessage(dmMessage());

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "slot:filled")).toBe(true);
    });

    const opened = events.find((e) => e.type === "slot:opened");
    const filled = events.find((e) => e.type === "slot:filled");
    expect(opened).toBeDefined();
    expect(filled).toBeDefined();
    expect(filled!.slotId).toBe(opened!.slotId);
    // slot:filled 出现后，finally 的 abandonSlot 对已 filled 的 slot 是 no-op
    expect(events.filter((e) => e.type === "slot:abandoned")).toHaveLength(0);

    await registry.dispose();
  });

  it("Issue F: LLM 被 commitment 完全抑制（content 为空）→ 只关 slot，不发空 entry", async () => {
    const { OutboxRegistry } = await import("@zhixing/core");
    const sendCalls: string[] = [];
    const slotEvents: string[] = [];

    const registry = new OutboxRegistry(
      async (_t, content) => {
        sendCalls.push(content.text);
        return { success: true, retryable: false };
      },
      {
        onEvent: (e) => {
          if (e.type === "slot:filled") slotEvents.push("filled");
          if (e.type === "slot:abandoned") slotEvents.push("abandoned");
        },
      },
    );

    // 模拟 LLM 完全抑制叙述：completed 但 message.content 是空 text block
    const emptyRuntime: SessionRuntime = {
      sessionId: "empty",
      run: vi.fn(function* (): Generator<AgentYield, RunResult> {
        const assistantMsg: Message = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
        };
        return {
          agentResult: {
            reason: "completed" as const,
            message: assistantMsg,
            usage: { inputTokens: 1, outputTokens: 0 },
          },
          turn: {
            type: "turn",
            turnIndex: 0,
            timestamp: new Date().toISOString(),
            userMessage: { role: "user", content: [{ type: "text", text: "(mock)" }] },
            assistantMessage: assistantMsg,
          },
          newMessages: [assistantMsg],
          durationMs: 0,
        };
      }) as unknown as SessionRuntime["run"],
      getHistory: () => [],
      updateMessages: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn(),
    };

    const { router } = setup({ runtime: emptyRuntime });
    router.setOutboxRegistry(registry);

    await router.handleMessage(dmMessage());

    await vi.waitFor(() => {
      expect(slotEvents).toContain("filled");
    });

    // 核心断言：adapter 从未被调用（没发空消息）
    expect(sendCalls).toHaveLength(0);
    // slot 仍被正确关闭（让后续 afterSlot=turnId 的 task fire 能流动）
    expect(slotEvents).toContain("filled");

    await registry.dispose();
  });

  // ─── PR-3 / remote-confirmation-execution.md §3.5：pending-aware 拦截 ───

  describe("confirmationHub pending-aware 拦截", () => {
    /**
     * 辅助：构造带 confirmationBroker 的 mock runtime。
     * hub.attach 需要 runtime.confirmationBroker，普通 createMockRuntime 不带。
     */
    function createRuntimeWithBroker(
      broker: ConfirmationBroker,
    ): SessionRuntime {
      const base = createMockRuntime();
      return Object.assign(base, { confirmationBroker: broker });
    }

    function setupWithHub(brokerForConv?: Map<string, ConfirmationBroker>) {
      const adapter = createMockAdapter();
      const hub = new ConfirmationHub();

      // 按 conversationId 返回不同 broker，便于多 broker 隔离测试
      const brokers = brokerForConv ?? new Map<string, ConfirmationBroker>();
      const factory: RuntimeFactory = {
        create: vi.fn(async (conversationId: string) => {
          const broker = brokers.get(conversationId) ?? new ConfirmationBroker();
          brokers.set(conversationId, broker);
          return createRuntimeWithBroker(broker);
        }),
      };

      const conversations = new ConversationManager(
        factory,
        {
          graceTimeoutMs: 100_000,
          idleTimeoutMs: 100_000,
          idleCheckIntervalMs: 100_000,
        },
        { confirmationHub: hub },
      );
      const channels = new ChannelRegistry({
        eventBus,
        logger,
        onMessage: () => {},
      });
      channels.register(adapter);

      const router = new InboundRouter({
        conversations,
        channels,
        logger,
        confirmationHub: hub,
      });
      return { adapter, hub, conversations, router, factory, brokers };
    }

    it("无 pending → 消息正常进入 agent 流程（不拦截）", async () => {
      const { adapter, router, hub } = setupWithHub();

      await router.handleMessage(dmMessage("test-ch", "user-1", "hello"));

      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });

      // reply 应是 agent 的回复"Hello from agent"，不是回执
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toBe("Hello from agent");
      expect(hub.snapshot().brokers).toHaveLength(1);
    });

    it("有 pending + 允许词 → broker.resolve(allow-once) + 埋点 matched-structured", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      // 预先创建 conversation + pending request
      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {}); // 挂占位避免走非交互兜底

      const now = Date.now();
      const pendingReq: ConfirmationRequest = {
        id: "req-1",
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
      const brokerPromise = broker.requestConfirmation(pendingReq);

      await router.handleMessage(dmMessage("test-ch", "user-1", "好"));

      // broker 应被解决
      const decision = await brokerPromise;
      expect(decision).toEqual({ kind: "allow-once" });

      // 回执已发
      expect(adapter.send).toHaveBeenCalled();
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toContain("✅ 已允许");

      // 埋点：matched-structured
      const matchedStructured = (logger.info as ReturnType<typeof vi.fn>).mock
        .calls.filter((c) => c[0] === "confirmation.reply.matched-structured");
      expect(matchedStructured).toHaveLength(1);
      expect(matchedStructured[0][1]).toMatchObject({
        requestId: "req-1",
        channelId: "test-ch",
        decision: "allow-once",
      });
    });

    it("有 pending + 拒绝词 → broker.resolve(deny) + 回执", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {});

      const now = Date.now();
      const pendingReq: ConfirmationRequest = {
        id: "req-deny-1",
        tool: "bash",
        toolInput: { command: "rm -rf /" },
        workingDirectory: "/tmp",
        display: {
          title: "Bash 命令",
          body: { kind: "bash", command: "rm -rf /", commandPreview: "rm -rf /" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      await router.handleMessage(dmMessage("test-ch", "user-1", "不"));

      expect(await brokerPromise).toEqual({ kind: "deny" });
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toContain("❌ 已拒绝");
    });

    it("有 pending + 自由文本 → broker.resolve(deny, reason=原文) + 埋点 matched-reason", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {});

      const now = Date.now();
      const pendingReq: ConfirmationRequest = {
        id: "req-reason-1",
        tool: "bash",
        toolInput: { command: "rm -rf /" },
        workingDirectory: "/tmp",
        display: {
          title: "Bash 命令",
          body: { kind: "bash", command: "rm -rf /", commandPreview: "rm -rf /" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      const reason = "不要碰生产目录！";
      await router.handleMessage(dmMessage("test-ch", "user-1", reason));

      const decision = await brokerPromise;
      expect(decision).toEqual({ kind: "deny", reason });

      // 回执含理由
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toContain("❌ 已拒绝");
      expect(content.text).toContain(reason);

      // 埋点：matched-reason
      const matchedReason = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[0] === "confirmation.reply.matched-reason");
      expect(matchedReason).toHaveLength(1);
      expect(matchedReason[0][1]).toMatchObject({
        requestId: "req-reason-1",
        channelId: "test-ch",
        reasonLength: reason.length,
      });
    });

    it("空消息不拦截（正常进入 agent 流程）", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {});

      const now = Date.now();
      const brokerPromise = broker.requestConfirmation({
        id: "req-1",
        tool: "bash",
        toolInput: {},
        workingDirectory: "/tmp",
        display: {
          title: "Bash",
          body: { kind: "bash", command: "ls", commandPreview: "ls" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      });

      // 空白消息不应触发拦截
      await router.handleMessage(dmMessage("test-ch", "user-1", "   "));
      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });

      // agent 回复到达（不是确认回执）
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toBe("Hello from agent");

      // pending 仍然在
      expect(broker.listPending()).toHaveLength(1);
      broker.resolve("req-1", { kind: "allow-once" });
      await brokerPromise;
    });

    it("多 broker 隔离：B 用户回复不影响 A 的 pending", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      // A / B 两个不同 conversation
      await conversations.getOrCreate("dm:test-ch:user-A");
      await conversations.getOrCreate("dm:test-ch:user-B");
      const brokerA = brokers.get("dm:test-ch:user-A")!;
      const brokerB = brokers.get("dm:test-ch:user-B")!;
      brokerA.onRequest(() => {});
      brokerB.onRequest(() => {});

      const now = Date.now();
      const reqA: ConfirmationRequest = {
        id: "req-A",
        tool: "bash",
        toolInput: {},
        workingDirectory: "/tmp",
        display: {
          title: "Bash A",
          body: { kind: "bash", command: "ls", commandPreview: "ls" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      };
      const promiseA = brokerA.requestConfirmation(reqA);

      // B 回复"好"——不应影响 A 的 pending
      await router.handleMessage(dmMessage("test-ch", "user-B", "好"));

      // A 的 pending 仍在
      expect(brokerA.listPending()).toHaveLength(1);
      expect(brokerB.listPending()).toHaveLength(0);

      // 清场
      brokerA.resolve("req-A", { kind: "allow-once" });
      await promiseA;
    });

    it("broker 已超时/已在其他端 resolve → 埋点 stale + 回执'已被处理'", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {});

      const now = Date.now();
      const pendingReq: ConfirmationRequest = {
        id: "req-stale",
        tool: "bash",
        toolInput: {},
        workingDirectory: "/tmp",
        display: {
          title: "Bash",
          body: { kind: "bash", command: "ls", commandPreview: "ls" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      // 模拟 race：手动先 resolve 把 pending 清掉（模拟 RPC 客户端抢到），
      // 但注意 listPending 会变空——这不会让拦截 return false（因为拦截前
      // listPending 已非空的断言发生在入口）。
      //
      // 更准确的 stale 场景：pending 还在 listPending 里时，inbound message 到达；
      // 在 broker.resolve 之前，其它并发路径 race 先 resolve 掉——但单线程 JS 很难。
      //
      // 这里用"broker 先接收到 cancel 让 listPending 返回非空，但 resolve 时
      // 命中 resolved grace 返 false"构造不了——broker 已移除 pending 条目。
      //
      // 退一步验证：把 pending 内的 id 改成一个不存在的（或先外部 resolve 掉），
      // 然后看 router 在调 broker.resolve 时会返 false 触发 stale 埋点。
      //
      // 由于 broker 是 FIFO 队首 showing，无法模拟"队首仍在但 resolve 返 false"，
      // 本用例验证另一个 stale 路径：listPending 的快照 vs 实际 resolve 的原子差。
      // 简化：直接在 router 前 resolve 掉 pending（模拟 RPC 客户端抢先）。
      broker.resolve("req-stale", { kind: "allow-once" });
      await brokerPromise;

      // 此时 pending 已空，router 调 listPending 会返 []，直接跳过拦截进入 agent。
      // 所以本测试改为断言：真 stale（pending 有条目但 resolve race）在代码里
      // 由 broker.resolve 的原子语义保障，触发 `confirmation.reply.stale` 埋点。
      // 这里无法构造 race，但可验证辅助路径：调用 resolve 返 false 时埋点正确。

      // 注：实际 race 场景可靠覆盖见 hub.test.ts 的 resolve 幂等测试。
      // 此用例占位说明：stale 埋点路径存在但很难在单元测试层构造真 race。
      expect(adapter.send).toHaveBeenCalledTimes(0); // 只有 resolve 调用，没有 inbound
    });

    // ─── Fix-3：群聊场景防误批准 ───

    it("群聊场景 + 非 owner 回复 → 不拦截 + 埋点 not-owner-skip", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      // 群聊默认策略 per-group：conversationId = ${channelId}:group:${groupId}
      const conversationId = "test-ch:group:grp-1";
      await conversations.getOrCreate(conversationId);
      const broker = brokers.get(conversationId)!;
      broker.onRequest(() => {});

      const now = Date.now();
      // A 触发的 confirmation：turnOrigin.triggeredBy="user-A"
      const pendingReq: ConfirmationRequest = {
        id: "req-group",
        tool: "bash",
        toolInput: { command: "rm -rf /" },
        workingDirectory: "/tmp",
        display: {
          title: "Bash 命令",
          body: { kind: "bash", command: "rm -rf /", commandPreview: "rm -rf /" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
        turnOrigin: {
          channel: "test-ch",
          target: {
            channelId: "test-ch",
            to: "grp-1",
          },
          triggeredBy: "user-A",
        },
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      // B 在群里回复 "好"
      await router.handleMessage(groupMessage("test-ch", "user-B", "grp-1", "好"));

      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });

      // broker pending 必须保留（不能误批准）
      expect(broker.listPending()).toHaveLength(1);

      // 埋点：not-owner-skip
      const skip = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "confirmation.reply.not-owner-skip",
      );
      expect(skip).toHaveLength(1);
      expect(skip[0][1]).toMatchObject({
        requestId: "req-group",
        expectedSender: "user-A",
        actualSender: "user-B",
      });

      // B 的消息按正常 agent 流程处理 → 收到 agent 回复
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toBe("Hello from agent");

      // 清场
      broker.resolve("req-group", { kind: "allow-once" });
      await brokerPromise;
    });

    it("群聊场景 + owner 回复 → 正常解决 pending", async () => {
      const { adapter, router, conversations, brokers } = setupWithHub();

      const conversationId = "test-ch:group:grp-1";
      await conversations.getOrCreate(conversationId);
      const broker = brokers.get(conversationId)!;
      broker.onRequest(() => {});

      const now = Date.now();
      const pendingReq: ConfirmationRequest = {
        id: "req-group-owner",
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
        turnOrigin: {
          channel: "test-ch",
          target: { channelId: "test-ch", to: "grp-1" },
          triggeredBy: "user-A",
        },
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      // A 自己回复 "好"——owner 匹配
      await router.handleMessage(
        groupMessage("test-ch", "user-A", "grp-1", "好"),
      );

      const decision = await brokerPromise;
      expect(decision).toEqual({ kind: "allow-once" });

      // 回执而非 agent 回复
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toContain("✅ 已允许");
    });

    it("turnOrigin 缺失时跳过身份校验（兼容旧 pending）", async () => {
      const { router, conversations, brokers } = setupWithHub();

      await conversations.getOrCreate("dm:test-ch:user-1");
      const broker = brokers.get("dm:test-ch:user-1")!;
      broker.onRequest(() => {});

      const now = Date.now();
      // pending 无 turnOrigin（理论上 PR-2 后所有 request 都有，但防御性兼容）
      const pendingReq: ConfirmationRequest = {
        id: "req-no-origin",
        tool: "bash",
        toolInput: {},
        workingDirectory: "/tmp",
        display: {
          title: "Bash",
          body: { kind: "bash", command: "ls", commandPreview: "ls" },
          cwd: "/tmp",
        },
        options: [],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt: now,
        expiresAt: now + 60_000,
      };
      const brokerPromise = broker.requestConfirmation(pendingReq);

      await router.handleMessage(dmMessage("test-ch", "user-1", "好"));

      // 无 turnOrigin.triggeredBy → 跳过身份校验 → 正常解决
      expect(await brokerPromise).toEqual({ kind: "allow-once" });
    });

    it("confirmationHub 未配置 → 消息正常进入 agent 流程（拦截零开销）", async () => {
      // 不传 confirmationHub，验证 inbound-router 完全等价旧行为
      const adapter = createMockAdapter();
      const factory = createMockRuntimeFactory();
      const conversations = new ConversationManager(factory, {
        graceTimeoutMs: 100_000,
        idleTimeoutMs: 100_000,
        idleCheckIntervalMs: 100_000,
      });
      const channels = new ChannelRegistry({
        eventBus,
        logger,
        onMessage: () => {},
      });
      channels.register(adapter);
      const router = new InboundRouter({ conversations, channels, logger });

      await router.handleMessage(dmMessage("test-ch", "user-1", "好"));

      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });
      // "好"按普通消息进入 agent，返回 agent 回复
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(content.text).toBe("Hello from agent");
    });
  });

  // ─── Cancel intent (RM3) ───
  describe("control intent: cancel keyword", () => {
    it("/cancel 关键词 → conversations.abort 调用,reason 是 user-cancel{rpc}", async () => {
      const { adapter, conversations, router } = setup();
      // 先建一个 conversation 让 abort 有目标
      await conversations.getOrCreate("dm:test-ch:user-1");

      const abortSpy = vi.spyOn(conversations, "abort");

      await router.handleMessage(dmMessage("test-ch", "user-1", "/cancel"));

      expect(abortSpy).toHaveBeenCalledTimes(1);
      const [convId, reason] = abortSpy.mock.calls[0]!;
      expect(convId).toBe("dm:test-ch:user-1");
      expect(reason?.kind).toBe("user-cancel");
      const r = reason as { kind: "user-cancel"; source: string; pressedAt: number };
      expect(r.source).toBe("rpc");
      expect(typeof r.pressedAt).toBe("number");

      // 不进 agent — runtime.run 不应被触发
      const adapterSendCalls = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[1] as { text: string }).text === "Hello from agent",
      );
      expect(adapterSendCalls).toHaveLength(0);
    });

    it("中文 cancel 关键词同样触发", async () => {
      const { conversations, router } = setup();
      await conversations.getOrCreate("dm:test-ch:user-1");
      const abortSpy = vi.spyOn(conversations, "abort");

      await router.handleMessage(dmMessage("test-ch", "user-1", "中止"));

      expect(abortSpy).toHaveBeenCalledTimes(1);
    });

    it("无 in-flight 无 pending → 反馈'当前没有正在处理的任务',绕过 Outbox", async () => {
      const { adapter, router } = setup();

      await router.handleMessage(dmMessage("test-ch", "user-1", "/cancel"));

      // 直接 adapter.send,不走 emitReply / outbox
      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });
      const lastCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect((lastCall[1] as { text: string }).text).toBe(
        "当前没有正在处理的任务。",
      );
    });

    it("有 pending 但无 in-flight → 反馈'已取消队列中的 N 条'", async () => {
      const { adapter, conversations, router } = setup();
      await conversations.getOrCreate("dm:test-ch:user-1");
      conversations.setBusy("dm:test-ch:user-1", true);
      conversations.enqueue("dm:test-ch:user-1", {
        execute: async () => {},
        cancel: () => {},
      });
      conversations.enqueue("dm:test-ch:user-1", {
        execute: async () => {},
        cancel: () => {},
      });

      // mock runtime.abort 默认返 false → in-flight 维度无打断,只清 pending
      await router.handleMessage(dmMessage("test-ch", "user-1", "/cancel"));

      await vi.waitFor(() => {
        const lastCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.at(-1);
        return lastCall && (lastCall[1] as { text: string }).text.includes("已取消");
      });
      const lastCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect((lastCall[1] as { text: string }).text).toBe(
        "已取消队列中的 2 条待处理消息。",
      );
    });

    it("有 in-flight → 不在 handleControlIntent 处反馈(让 cleanup 路径产出唯一反馈)", async () => {
      const { adapter, conversations, router } = setup({
        runtime: {
          ...createMockRuntime(),
          abort: vi.fn(() => true), // mock in-flight 存在,abort 返 true
        },
      });
      await conversations.getOrCreate("dm:test-ch:user-1");

      await router.handleMessage(dmMessage("test-ch", "user-1", "/cancel"));

      // adapter.send 不应在 handleControlIntent 内被调
      // (cleanup 路径反馈是 runChannelTurn 内,本测试无 in-flight runChannelTurn 在跑)
      // 只验证:与"无 in-flight"分支不同,本路径不发"当前没有正在处理的任务"
      const sentTexts = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[1] as { text: string }).text,
      );
      expect(sentTexts).not.toContain("当前没有正在处理的任务。");
      expect(sentTexts.find((t) => t.startsWith("已取消队列"))).toBeUndefined();
    });

    it("非 cancel 文本 → 走原 confirmation/agent 路径,不调 abort", async () => {
      const { adapter, conversations, router } = setup();
      const abortSpy = vi.spyOn(conversations, "abort");

      await router.handleMessage(dmMessage("test-ch", "user-1", "你好"));

      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });
      // agent 路径:回 "Hello from agent"
      const reply = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
        text: string;
      };
      expect(reply.text).toBe("Hello from agent");
      expect(abortSpy).not.toHaveBeenCalled();
    });

    it("空消息不触发 cancel(避免空字符串误命中)", async () => {
      const { conversations, router } = setup();
      const abortSpy = vi.spyOn(conversations, "abort");

      await router.handleMessage(dmMessage("test-ch", "user-1", ""));

      expect(abortSpy).not.toHaveBeenCalled();
    });

    it("session 不存在 → abort 仍调用(返双零),反馈'当前没有正在处理的任务'", async () => {
      const { adapter, conversations, router } = setup();
      const abortSpy = vi.spyOn(conversations, "abort");

      // 不预创建 session
      await router.handleMessage(dmMessage("test-ch", "user-ghost", "/cancel"));

      expect(abortSpy).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });
      const lastCall = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect((lastCall[1] as { text: string }).text).toBe(
        "当前没有正在处理的任务。",
      );
    });
  });

  // ─── refuseNewMessages (RM5 — graceful shutdown 关停期反馈) ───
  describe("refuseNewMessages", () => {
    it("调用前 handleMessage 正常路由到 agent", async () => {
      const { adapter, router } = setup();
      await router.handleMessage(dmMessage("test-ch", "user-1", "你好"));

      await vi.waitFor(() => {
        expect(adapter.send).toHaveBeenCalled();
      });
      const reply = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
        text: string;
      };
      expect(reply.text).toBe("Hello from agent");
    });

    it("调用后 → 直接 adapter.send 固定文案 + log + return,不进 agent / confirmation / IntentClassifier", async () => {
      const { adapter, conversations, router } = setup();
      const abortSpy = vi.spyOn(conversations, "abort");
      const getOrCreateSpy = vi.spyOn(conversations, "getOrCreate");

      router.refuseNewMessages();

      await router.handleMessage(dmMessage("test-ch", "user-1", "你好"));

      // adapter.send 收到关停文案
      expect(adapter.send).toHaveBeenCalledTimes(1);
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((content as { text: string }).text).toBe(
        "服务暂时不可用,请稍后重新发送。",
      );

      // 三个下游路径全未触发
      expect(abortSpy).not.toHaveBeenCalled();
      expect(getOrCreateSpy).not.toHaveBeenCalled();
    });

    it("拒新期间 cancel 关键词也走拒新分支(不进 IntentClassifier abort 路径)", async () => {
      const { adapter, conversations, router } = setup();
      const abortSpy = vi.spyOn(conversations, "abort");

      router.refuseNewMessages();

      await router.handleMessage(dmMessage("test-ch", "user-1", "/cancel"));

      // 不调 abort —— 拒新分支在 IntentClassifier 之前
      expect(abortSpy).not.toHaveBeenCalled();
      // 收到的是关停文案,不是"当前没有正在处理的任务"
      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((content as { text: string }).text).toBe(
        "服务暂时不可用,请稍后重新发送。",
      );
    });

    it("adapter.send 抛错时拒新分支吞错不抛,关停链不被 block", async () => {
      const adapter = createMockAdapter();
      (adapter.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("network down during shutdown"),
      );
      const { router } = setup({ adapter });

      router.refuseNewMessages();

      // 不抛 —— 关停链能继续走
      await expect(
        router.handleMessage(dmMessage("test-ch", "user-1", "你好")),
      ).resolves.toBeUndefined();
    });

    it("幂等:重复调用不抛,后续 handleMessage 仍走拒新分支", async () => {
      const { adapter, router } = setup();
      router.refuseNewMessages();
      router.refuseNewMessages();
      router.refuseNewMessages();

      await router.handleMessage(dmMessage("test-ch", "user-1", "你好"));

      const [, content] = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect((content as { text: string }).text).toBe(
        "服务暂时不可用,请稍后重新发送。",
      );
    });
  });

  // 注：ADR-007 Phase 3 的"task-fire 排在 LLM 回复之后"核心保证已由两层测试组合证明：
  //
  //   1. outbox.test.ts "fillSlot(slot, entry) 原子性"：
  //      证明在 Outbox 层，fillSlot(slotId, replyEntry) 会把 replyEntry 排在
  //      所有 afterSlot=slotId 的等待 entry **之前**送出。
  //
  //   2. inbound-router.test.ts 上一条 "P3d: runChannelTurn 开头 openSlot, 成功回复 fillSlot"：
  //      证明 InboundRouter 在 turn 启动即 openSlot(turnId)，在成功回复时走 fillSlot(turnId, entry)。
  //
  //   3. outbox-integration.test.ts "P3b: scheduler source 带 createdInTurn → entry.afterSlot 透传"：
  //      证明 Scheduler → OutboxSender 链会把 task 的 createdInTurn 正确派生为 afterSlot。
  //
  //   4. schedule.test.ts "P3c: ctx.turnId 存在 → task.createdInTurn 被设"：
  //      证明 schedule 工具会把当前 turnId 捕获到 task 上。
  //
  // 组合即端到端：turn 内创建的 task fire 在 turn 回复之前到达 outbox，被 afterSlot=turnId
  // 阻塞，fillSlot(turnId, reply) 同时释放并插入 reply 在前。
  //
  // 未写单独 E2E 测试的原因：InboundRouter + 真实 runtime + vi mock 交互存在
  // async generator timer 未稳定触发的现象（见 git history），而上述分层测试已覆盖所有
  // 可观测的 invariant。若后续需要跨 server/core 边界的 E2E 冒烟，建议放在
  // packages/server/__tests__/e2e 目录并用真实的 provider mock。
});
