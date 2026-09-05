import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  OutboxRegistry,
  type ChannelChallengeMessage,
  type ChannelContext,
  type DeliveryResult,
  type DeliveryTarget,
  type OutboundContent,
} from "@zhixing/core";
import {
  createInboundChannelRouter,
  setupChannels,
} from "../channels.js";
import { createAssemblyUnits } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";

const mockFeishu = vi.hoisted(() => ({
  constructorError: undefined as Error | undefined,
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
    readonly id = "feishu";
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
    const surface = createAssemblyUnits({}).find((unit) => unit.name === "channel")!;
    const absent = {
      channelConfiguration: {},
    } as unknown as AssemblyContext;
    await surface.setup(absent);
    expect(absent.channelMechanism).toEqual({
      kind: "absent",
      reason: "not-configured",
    });
    expect(Object.isFrozen(absent.channelMechanism)).toBe(true);

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
    } as unknown as AssemblyContext;
    await surface.setup(configured);
    expect(configured.channelMechanism?.kind).toBe("available");
    if (configured.channelMechanism?.kind !== "available") {
      throw new Error("configured Channel mechanism was not published");
    }
    expect(configured.channelMechanism.channels.challenges.supports("feishu")).toBe(false);
    expect(configured.channelMechanism.channels.statusSnapshot()).toEqual([]);
  });
});
