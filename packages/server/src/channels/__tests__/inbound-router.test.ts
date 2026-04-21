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
});
