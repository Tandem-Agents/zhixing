import { describe, it, expect, vi, beforeEach } from "vitest";
import { InboundRouter } from "../inbound-router.js";
import { ConversationManager } from "../../runtime/conversation-manager.js";
import {
  createEventBus,
  type ChannelEventMap,
  type ChannelAdapter,
  type ChannelLogger,
  type DeliveryResult,
  type InboundMessage,
  ChannelRegistry,
} from "@zhixing/core";
import type { SessionRuntime, RuntimeFactory } from "../../runtime/types.js";
import type { AgentResult, AgentYield, Message } from "@zhixing/core";

// ─── Mock 工厂 ───

function createMockRuntime(response?: { text: string }): SessionRuntime {
  const text = response?.text ?? "Hello from agent";
  return {
    sessionId: "rt-1",
    run: vi.fn(function* (): Generator<AgentYield, AgentResult> {
      yield { type: "text_delta", text };
      return {
        reason: "completed" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }) as unknown as SessionRuntime["run"],
    getHistory: () => [],
    abort: vi.fn(),
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
      run: vi.fn(function* (): Generator<AgentYield, AgentResult> {
        return {
          reason: "error" as const,
          error: Object.assign(new Error("LLM failed"), { name: "AgentError" }),
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }) as unknown as SessionRuntime["run"],
      getHistory: () => [],
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
      run: vi.fn(function* (): Generator<AgentYield, AgentResult> {
        return {
          reason: "completed" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "" }],
          },
          usage: { inputTokens: 1, outputTokens: 0 },
        } satisfies AgentResult;
      }) as unknown as SessionRuntime["run"],
      getHistory: () => [],
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
