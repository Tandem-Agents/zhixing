import { describe, expect, it, vi, beforeEach } from "vitest";
import { OutboxRegistry } from "@zhixing/core/delivery";
import { type ChannelChallengeMessage, type ChannelContext, type DeliveryResult, type DeliveryTarget, type OutboundContent } from "@zhixing/core/channels";
import {
  createInboundChannelRouter,
  setupChannels,
} from "../channels.js";
import { prepareChannel, type PrepareChannelInput } from "../access-surfaces.js";
import { ChannelConversationProductBinding } from "../channel-conversation-product-binding.js";
import { AnchorSessionBroadcastLifecycle } from "../anchor-session-broadcast-lifecycle.js";
import { createSessionBroadcastTransport } from "@zhixing/rpc/session-broadcast";

const mockFeishu = vi.hoisted(() => ({
  constructorError: undefined as Error | undefined,
  ids: [] as string[],
  connect: vi.fn<(_: ChannelContext) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  send: vi.fn<(
    target: DeliveryTarget,
    content: OutboundContent,
  ) => Promise<DeliveryResult>>(),
  sendChallenge: vi.fn<(
    message: ChannelChallengeMessage,
  ) => Promise<DeliveryResult>>(),
}));

vi.mock("@zhixing/channel-feishu", () => ({
  FeishuAdapter: class {
    readonly id = mockFeishu.ids.shift() ?? "feishu";
    readonly capabilities = {
      chatTypes: ["dm"],
      media: false,
      edit: false,
      streaming: false,
    };
    readonly bindingPolicy = { group: "per-user-in-group" as const };

    constructor() {
      if (mockFeishu.constructorError) throw mockFeishu.constructorError;
    }

    connect(ctx: ChannelContext): Promise<void> {
      return mockFeishu.connect(ctx);
    }

    disconnect(): Promise<void> {
      return mockFeishu.disconnect();
    }

    send(target: DeliveryTarget, content: OutboundContent): Promise<DeliveryResult> {
      return mockFeishu.send(target, content);
    }

    sendChallenge(message: ChannelChallengeMessage): Promise<DeliveryResult> {
      return mockFeishu.sendChallenge(message);
    }
  },
}));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const OUTBOUND_ONLY = Object.freeze({
  inbound: Object.freeze({
    kind: "absent" as const,
    reason: "outbound-only" as const,
  }),
  onChallengeAction: async () => undefined,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("setupChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeishu.constructorError = undefined;
    mockFeishu.ids.length = 0;
    mockFeishu.disconnect.mockResolvedValue(undefined);
    mockFeishu.send.mockResolvedValue({ success: true, retryable: false });
    mockFeishu.sendChallenge.mockResolvedValue({ success: true, retryable: false });
  });

  it("先返回稳定有限端口，显式 absent profile 才能开放 outbound-only 连接", async () => {
    const gate = deferred<void>();
    mockFeishu.connect.mockReturnValue(gate.promise);

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });

    expect(result.delivery.status("feishu")).toBe("disconnected");
    expect(result.statusSnapshot()).toEqual([
      { channelId: "feishu", state: "disconnected" },
    ]);

    await result.activate();
    const connectionTask = result.connectConfigured(OUTBOUND_ONLY);
    await Promise.resolve();
    expect(result.delivery.status("feishu")).toBe("connecting");
    let settled = false;
    connectionTask.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await connectionTask;

    expect(result.delivery.status("feishu")).toBe("connected");
    expect(logger.info).toHaveBeenCalledWith("Channel '%s' connected", "feishu");
  });

  it("连接失败只进入通道 error 状态，不让 setup 失败", async () => {
    mockFeishu.connect.mockRejectedValue(new Error("bad credentials"));

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    await result.activate();
    await result.connectConfigured(OUTBOUND_ONLY);

    expect(result.statusSnapshot()[0]).toMatchObject({
      state: "error",
      error: "bad credentials",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Channel '%s' failed to connect (non-fatal): %s",
      "feishu",
      "bad credentials",
    );
  });

  it("可先完成配置注册，再由 current-owner 生命周期显式连接和断开", async () => {
    mockFeishu.connect.mockResolvedValue(undefined);

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });

    expect(mockFeishu.connect).not.toHaveBeenCalled();

    await result.activate();
    await result.connectConfigured(OUTBOUND_ONLY);
    expect(mockFeishu.connect).toHaveBeenCalledOnce();
    expect(result.delivery.status("feishu")).toBe("connected");

    await result.disconnectConfigured();
    expect(mockFeishu.disconnect).toHaveBeenCalledOnce();
    expect(result.delivery.status("feishu")).toBe("disconnected");
  });

  it("keeps inbound grouping and replies internal while returning only consumed Host ports", async () => {
    mockFeishu.connect.mockResolvedValue(undefined);
    const admitTurn = vi.fn(async (input: { conversationId: string }) => ({
      status: "not-found" as const,
      conversationId: input.conversationId,
      turnId: "turn-test",
    }));
    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    const outbox = new OutboxRegistry((target, content) =>
      result.inbound.send(target, content));
    const router = createInboundChannelRouter({
      conversation: {
        prepareAgentTurn: async () => ({ turnId: "turn-test" }) as never,
        admitAgentTurn: admitTurn,
        abort: async () => ({
          cancelled: true,
          feedback: { kind: "idle" },
        }),
      } as never,
      channels: result.inbound,
      deliveryOutbox: outbox,
      logger,
      sessionBroadcast: vi.fn(),
      sessionActivityBroadcast: vi.fn(),
      isCurrentOwner: () => true,
    });
    await result.activate();
    await result.connectConfigured(Object.freeze({
      inbound: Object.freeze({
        kind: "router",
        handleMessage: (message) => router.handleMessage(message),
      }),
      onChallengeAction: async () => undefined,
    }));
    const target = { channelId: "feishu", to: "user-1" };

    const context = mockFeishu.connect.mock.calls[0]?.[0];
    expect(context).toBeDefined();
    context!.onMessage({
      channelId: "feishu",
      from: "user-1",
      text: "hello",
      chatType: "group",
      groupId: "group-1",
    });
    await vi.waitFor(() => expect(admitTurn).toHaveBeenCalledOnce());
    expect(admitTurn.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "feishu:group:group-1:user-1",
    });

    await expect(result.delivery.send(target, { text: "delivery" })).resolves.toEqual({
      success: true,
      retryable: false,
    });
    router.refuseNewMessages();
    context!.onMessage({
      channelId: "feishu",
      from: "user-1",
      text: "after-stop",
      chatType: "group",
      groupId: "group-1",
    });
    await vi.waitFor(() => expect(mockFeishu.send).toHaveBeenCalledTimes(2));
    expect(result.challenges.supports("feishu")).toBe(true);
    await result.challenges.sendChallenge({
      challengeId: "challenge-1",
      token: { route: { channelId: "feishu" } },
    } as ChannelChallengeMessage);

    expect(mockFeishu.send).toHaveBeenNthCalledWith(1, target, { text: "delivery" });
    expect(mockFeishu.send).toHaveBeenNthCalledWith(
      2,
      { channelId: "feishu", to: "group-1", threadId: undefined },
      { text: "服务暂时不可用,请稍后重新发送。" },
    );
    expect(mockFeishu.sendChallenge).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result.statusSnapshot())).toBe(true);
    expect(Object.isFrozen(result.statusSnapshot()[0])).toBe(true);
    await outbox.dispose();
    await result.dispose();
    expect(mockFeishu.disconnect).toHaveBeenCalledOnce();
  });

  it("物理连接只接收已完成的 challenge action consumer", async () => {
    let current = true;
    const onChallengeAction = vi.fn(async () => {});
    mockFeishu.connect.mockResolvedValue(undefined);

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    await result.activate();
    await result.connectConfigured(Object.freeze({
      inbound: OUTBOUND_ONLY.inbound,
      onChallengeAction: async (action) => {
        if (!current) {
          throw new Error("Channel interaction is not owned by this device");
        }
        await onChallengeAction(action);
      },
    }));
    const context = mockFeishu.connect.mock.calls[0]?.[0];
    expect(context).toBeDefined();

    current = false;
    await expect(context!.onChallengeAction({} as never)).rejects.toThrow(
      "not owned by this device",
    );
    expect(onChallengeAction).not.toHaveBeenCalled();
  });

  it("把未配置和 adapter 创建失败冻结为显式机制结果", async () => {
    const absent = {
      channelConfiguration: {},
    } as unknown as PrepareChannelInput;
    const absentMechanism = await prepareChannel(Object.freeze(absent), {});
    expect(absentMechanism).toEqual({
      kind: "absent",
      reason: "not-configured",
    });
    expect(Object.isFrozen(absentMechanism)).toBe(true);

    mockFeishu.constructorError = new Error("adapter unavailable");
    const configured = {
      channelConfiguration: {
        messaging: { feishu: { type: "feishu" } },
      },
      conversations: {
        usesDurableTurnProtocol: () => true,
      },
      channelHttpRoutes: new Map(),
      lifecycleContributions: { acquire: vi.fn() },
    } as unknown as PrepareChannelInput;
    const configuredMechanism = await prepareChannel(Object.freeze(configured), {});
    expect(configuredMechanism?.kind).toBe("available");
    if (configuredMechanism?.kind !== "available") {
      throw new Error("configured Channel mechanism was not published");
    }
    expect(configuredMechanism.channels.challenges.supports("feishu")).toBe(false);
    expect(configuredMechanism.channels.statusSnapshot()).toEqual([]);
  });

  it.each(["connectConfigured", "resumeConfigured"] as const)(
    "%s cannot open physical ingress before Host activation",
    async (operation) => {
      const result = await setupChannels({
        entries: { feishu: { type: "feishu" } },
        credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
        logger,
      });
      mockFeishu.connect.mockResolvedValue(undefined);
      if (operation === "resumeConfigured") {
        await result.suspendConfigured();
      }
      await result[operation](OUTBOUND_ONLY);
      expect(mockFeishu.connect).not.toHaveBeenCalled();
      await result.activate();
      expect(mockFeishu.connect).toHaveBeenCalledOnce();
      await expect(result.activate()).rejects.toThrow("already active");

      // Current-owner withdrawal during operation remains reversible.
      await result.disconnectConfigured();
      await result.resumeConfigured(OUTBOUND_ONLY);
      expect(mockFeishu.connect).toHaveBeenCalledTimes(2);
      await result.dispose();
      await expect(result.resumeConfigured(OUTBOUND_ONLY)).rejects.toThrow("closed");
      expect(mockFeishu.connect).toHaveBeenCalledTimes(2);
    },
  );

  it("withdraws startup connection intent and never reopens after failed startup cleanup", async () => {
    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    await result.connectConfigured(OUTBOUND_ONLY);
    await result.disconnectConfigured();
    await result.activate();
    expect(mockFeishu.connect).not.toHaveBeenCalled();
    await result.dispose();
    await expect(result.connectConfigured(OUTBOUND_ONLY)).rejects.toThrow("closed");
  });

  it("delivers an immediate first message through prepared consumers while another adapter is still connecting", async () => {
    mockFeishu.ids.push("first", "slow");
    const slow = deferred<void>();
    const firstMessage = deferred<void>();
    const result = await setupChannels({
      entries: { first: { type: "feishu" }, slow: { type: "feishu" } },
      credentials: { channels: {} }, logger,
    });
    const binding = new ChannelConversationProductBinding({ usesDurableTurnProtocol: () => false } as never);
    const broadcast = new AnchorSessionBroadcastLifecycle();
    const command = vi.fn(async () => ({ result: { turnId: "first-turn" } }));
    const notify = vi.fn();
    let confirmationReady = false;
    const consumers = {
      inbound: {
        kind: "router" as const,
        handleMessage: async () => {
          try {
            expect(confirmationReady).toBe(true);
            await binding.prepareAgentTurn({ channelId: "first", platformSubject: "user" });
            broadcast.port.session("conversation", "session.event", {});
            firstMessage.resolve();
          } catch (error) { firstMessage.reject(error); }
        },
      },
      onChallengeAction: async () => {},
    };
    mockFeishu.connect.mockImplementationOnce(async (context) => {
      context.onMessage({ channelId: "first", from: "user", text: "hello", chatType: "dm" });
    }).mockImplementationOnce(() => slow.promise);
    await result.connectConfigured(consumers);
    expect(mockFeishu.connect).not.toHaveBeenCalled();
    binding.bind({ supports: () => true, command } as never);
    broadcast.install(createSessionBroadcastTransport({
      connections: new Set([{ id: "observer", authenticated: true, closed: false, notify }]),
      observerConnectionIds: () => new Set(["observer"]),
    }));
    confirmationReady = true;
    const activating = result.activate();
    try {
      await firstMessage.promise;
      expect(command).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledOnce();
      expect(result.statusSnapshot().find((status) => status.channelId === "slow")?.state)
        .toBe("connecting");
    } finally {
      slow.resolve();
      await activating;
      binding.close();
      broadcast.close();
      await result.dispose();
    }
  });

  it("aborts an in-flight activation before waiting for an adapter to finish connecting", async () => {
    mockFeishu.connect.mockImplementation((context) => new Promise((resolve) => {
      context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    await result.connectConfigured(OUTBOUND_ONLY);
    const activating = result.activate();
    await vi.waitFor(() => expect(mockFeishu.connect).toHaveBeenCalledOnce());
    await result.dispose();
    await activating;
    expect(mockFeishu.connect.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    await expect(result.resumeConfigured(OUTBOUND_ONLY)).rejects.toThrow("closed");
  });
});
