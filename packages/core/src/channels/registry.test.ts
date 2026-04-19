import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelRegistry, type ChannelRegistryOptions } from "./registry.js";
import { createEventBus } from "../events/index.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfig,
  ChannelContext,
  ChannelEventMap,
  DeliveryResult,
  DeliveryTarget,
  InboundMessage,
  OutboundContent,
} from "./types.js";

function createMockAdapter(id = "test-channel"): ChannelAdapter {
  return {
    id,
    capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async (): Promise<DeliveryResult> => ({
      success: true,
      messageId: "msg-1",
      retryable: false,
    })),
  };
}

function createRegistryOptions(
  overrides?: Partial<ChannelRegistryOptions>,
): ChannelRegistryOptions {
  return {
    eventBus: createEventBus<ChannelEventMap>(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onMessage: vi.fn(),
    ...overrides,
  };
}

const testConfig: ChannelConfig = {
  type: "test",
  enabled: true,
  credentials: { token: "abc" },
};

describe("ChannelRegistry", () => {
  let registry: ChannelRegistry;
  let options: ChannelRegistryOptions;

  beforeEach(() => {
    options = createRegistryOptions();
    registry = new ChannelRegistry(options);
  });

  describe("register / get / list", () => {
    it("registers and retrieves an adapter by id", () => {
      const adapter = createMockAdapter("ch-1");
      registry.register(adapter);
      expect(registry.get("ch-1")).toBe(adapter);
    });

    it("lists all registered adapters", () => {
      registry.register(createMockAdapter("a"));
      registry.register(createMockAdapter("b"));
      const ids = registry.list().map((a) => a.id);
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toHaveLength(2);
    });

    it("returns undefined for unknown id", () => {
      expect(registry.get("nope")).toBeUndefined();
    });

    it("throws on duplicate registration", () => {
      registry.register(createMockAdapter("dup"));
      expect(() => registry.register(createMockAdapter("dup"))).toThrow(
        "already registered",
      );
    });

    it("throws if registry is disposed", async () => {
      await registry.dispose();
      expect(() => registry.register(createMockAdapter())).toThrow("disposed");
    });
  });

  describe("status tracking", () => {
    it("initializes status as disconnected on register", () => {
      registry.register(createMockAdapter("s1"));
      const status = registry.getStatus("s1");
      expect(status).toMatchObject({ channelId: "s1", state: "disconnected" });
    });

    it("listStatuses returns all channel statuses", () => {
      registry.register(createMockAdapter("a"));
      registry.register(createMockAdapter("b"));
      expect(registry.listStatuses()).toHaveLength(2);
    });
  });

  describe("connect / disconnect lifecycle", () => {
    it("connects an adapter and updates status", async () => {
      const adapter = createMockAdapter("c1");
      registry.register(adapter);
      await registry.connect("c1", testConfig);

      expect(adapter.connect).toHaveBeenCalledOnce();
      const status = registry.getStatus("c1")!;
      expect(status.state).toBe("connected");
      expect(status.connectedAt).toBeTruthy();
    });

    it("passes ChannelContext to adapter.connect", async () => {
      const adapter = createMockAdapter("c2");
      registry.register(adapter);
      await registry.connect("c2", testConfig);

      const ctx = (adapter.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelContext;
      expect(ctx.config).toBe(testConfig);
      expect(typeof ctx.onMessage).toBe("function");
      expect(typeof ctx.registerHttpRoute).toBe("function");
      expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it("emits channel:connected event", async () => {
      const handler = vi.fn();
      options.eventBus.on("channel:connected", handler);

      registry.register(createMockAdapter("c3"));
      await registry.connect("c3", testConfig);

      expect(handler).toHaveBeenCalledWith({ channelId: "c3" });
    });

    it("is idempotent when already connected", async () => {
      const adapter = createMockAdapter("c4");
      registry.register(adapter);
      await registry.connect("c4", testConfig);
      await registry.connect("c4", testConfig);
      expect(adapter.connect).toHaveBeenCalledOnce();
    });

    it("aborts the signal on disconnect", async () => {
      const adapter = createMockAdapter("c-abort");
      let capturedSignal: AbortSignal | undefined;
      (adapter.connect as ReturnType<typeof vi.fn>).mockImplementation(
        async (ctx: ChannelContext) => {
          capturedSignal = ctx.abortSignal;
        },
      );
      registry.register(adapter);
      await registry.connect("c-abort", testConfig);
      expect(capturedSignal!.aborted).toBe(false);

      await registry.disconnect("c-abort");
      expect(capturedSignal!.aborted).toBe(true);
    });

    it("disconnects and updates status", async () => {
      const adapter = createMockAdapter("c5");
      registry.register(adapter);
      await registry.connect("c5", testConfig);
      await registry.disconnect("c5");

      expect(adapter.disconnect).toHaveBeenCalledOnce();
      expect(registry.getStatus("c5")!.state).toBe("disconnected");
    });

    it("emits channel:disconnected event", async () => {
      const handler = vi.fn();
      options.eventBus.on("channel:disconnected", handler);

      registry.register(createMockAdapter("c6"));
      await registry.connect("c6", testConfig);
      await registry.disconnect("c6");

      expect(handler).toHaveBeenCalledWith({ channelId: "c6" });
    });

    it("handles connect failure gracefully", async () => {
      const adapter = createMockAdapter("fail");
      (adapter.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("connection refused"),
      );
      registry.register(adapter);

      await expect(registry.connect("fail", testConfig)).rejects.toThrow("connection refused");
      const status = registry.getStatus("fail")!;
      expect(status.state).toBe("error");
      expect(status.error).toBe("connection refused");
    });

    it("emits channel:error on connect failure", async () => {
      const handler = vi.fn();
      options.eventBus.on("channel:error", handler);

      const adapter = createMockAdapter("err");
      (adapter.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("timeout"),
      );
      registry.register(adapter);
      await registry.connect("err", testConfig).catch(() => {});

      expect(handler).toHaveBeenCalledWith({ channelId: "err", error: "timeout" });
    });

    it("throws when connecting unknown adapter", async () => {
      await expect(registry.connect("ghost", testConfig)).rejects.toThrow("not found");
    });

    it("throws when disconnecting unknown adapter", async () => {
      await expect(registry.disconnect("ghost")).rejects.toThrow("not found");
    });
  });

  describe("onMessage callback", () => {
    it("routes inbound messages through the context callback", async () => {
      const adapter = createMockAdapter("msg-test");
      let capturedCtx: ChannelContext | undefined;
      (adapter.connect as ReturnType<typeof vi.fn>).mockImplementation(
        async (ctx: ChannelContext) => {
          capturedCtx = ctx;
        },
      );

      registry.register(adapter);
      await registry.connect("msg-test", testConfig);

      const msg: InboundMessage = {
        from: "user-1",
        text: "hello",
        channelId: "msg-test",
        chatType: "dm",
      };
      capturedCtx!.onMessage(msg);

      expect(options.onMessage).toHaveBeenCalledWith(msg);
    });

    it("updates lastMessageAt on inbound message", async () => {
      const adapter = createMockAdapter("ts-test");
      let capturedCtx: ChannelContext | undefined;
      (adapter.connect as ReturnType<typeof vi.fn>).mockImplementation(
        async (ctx: ChannelContext) => {
          capturedCtx = ctx;
        },
      );

      registry.register(adapter);
      await registry.connect("ts-test", testConfig);

      capturedCtx!.onMessage({
        from: "u",
        text: "hi",
        channelId: "ts-test",
        chatType: "dm",
      });

      expect(registry.getStatus("ts-test")!.lastMessageAt).toBeTruthy();
    });

    it("emits channel:message-received event", async () => {
      const handler = vi.fn();
      options.eventBus.on("channel:message-received", handler);

      const adapter = createMockAdapter("evt-msg");
      let capturedCtx: ChannelContext | undefined;
      (adapter.connect as ReturnType<typeof vi.fn>).mockImplementation(
        async (ctx: ChannelContext) => {
          capturedCtx = ctx;
        },
      );

      registry.register(adapter);
      await registry.connect("evt-msg", testConfig);

      const msg: InboundMessage = {
        from: "u",
        text: "test",
        channelId: "evt-msg",
        chatType: "group",
        groupId: "g1",
      };
      capturedCtx!.onMessage(msg);

      expect(handler).toHaveBeenCalledWith({ channelId: "evt-msg", message: msg });
    });
  });

  describe("dispose", () => {
    it("disconnects all adapters and clears state", async () => {
      const a1 = createMockAdapter("d1");
      const a2 = createMockAdapter("d2");
      registry.register(a1);
      registry.register(a2);
      await registry.connect("d1", testConfig);
      await registry.connect("d2", testConfig);

      await registry.dispose();

      expect(a1.disconnect).toHaveBeenCalled();
      expect(a2.disconnect).toHaveBeenCalled();
      expect(registry.list()).toHaveLength(0);
      expect(registry.listStatuses()).toHaveLength(0);
    });

    it("is idempotent", async () => {
      registry.register(createMockAdapter("d3"));
      await registry.dispose();
      await registry.dispose();
    });

    it("tolerates disconnect failures during dispose", async () => {
      const adapter = createMockAdapter("d4");
      (adapter.disconnect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("cleanup failed"),
      );
      registry.register(adapter);
      await registry.connect("d4", testConfig);

      await expect(registry.dispose()).resolves.toBeUndefined();
    });
  });
});
