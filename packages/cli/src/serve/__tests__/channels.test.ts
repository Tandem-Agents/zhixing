import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  ChannelContext,
  DeliveryResult,
  DeliveryTarget,
  OutboundContent,
} from "@zhixing/core";
import { setupChannels } from "../channels.js";

const mockFeishu = vi.hoisted(() => ({
  connect: vi.fn<(_: ChannelContext) => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  send: vi.fn<(
    target: DeliveryTarget,
    content: OutboundContent,
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

    connect(ctx: ChannelContext): Promise<void> {
      return mockFeishu.connect(ctx);
    }

    disconnect(): Promise<void> {
      return mockFeishu.disconnect();
    }

    send(target: DeliveryTarget, content: OutboundContent): Promise<DeliveryResult> {
      return mockFeishu.send(target, content);
    }
  },
}));

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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
    mockFeishu.disconnect.mockResolvedValue(undefined);
    mockFeishu.send.mockResolvedValue({ success: true, retryable: false });
  });

  it("先返回稳定 registry/router，外部通道连接在后台完成", async () => {
    const gate = deferred<void>();
    mockFeishu.connect.mockReturnValue(gate.promise);

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });

    expect(result.registry.get("feishu")).toBeDefined();
    expect(result.registry.getStatus("feishu")?.state).toBe("connecting");

    let settled = false;
    result.connectionTask.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await result.connectionTask;

    expect(result.registry.getStatus("feishu")?.state).toBe("connected");
    expect(logger.info).toHaveBeenCalledWith("Channel '%s' connected", "feishu");
  });

  it("连接失败只进入通道 error 状态，不让 setup 失败", async () => {
    mockFeishu.connect.mockRejectedValue(new Error("bad credentials"));

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
    });
    await result.connectionTask;

    expect(result.registry.getStatus("feishu")).toMatchObject({
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
      connectImmediately: false,
    });
    await result.connectionTask;

    expect(result.registry.get("feishu")).toBeDefined();
    expect(mockFeishu.connect).not.toHaveBeenCalled();

    await result.connectConfigured();
    expect(mockFeishu.connect).toHaveBeenCalledOnce();
    expect(result.registry.getStatus("feishu")?.state).toBe("connected");

    await result.disconnectConfigured();
    expect(mockFeishu.disconnect).toHaveBeenCalledOnce();
    expect(result.registry.getStatus("feishu")?.state).toBe("disconnected");
  });

  it("连接切换竞态中的 confirmation challenge 也在副作用前复核 current owner", async () => {
    let current = true;
    const onChallengeAction = vi.fn(async () => {});
    mockFeishu.connect.mockResolvedValue(undefined);

    const result = await setupChannels({
      entries: { feishu: { type: "feishu" } },
      credentials: { channels: { feishu: { appId: "cli_x", appSecret: "s" } } } as never,
      logger,
      isCurrentOwner: () => current,
      onChallengeAction,
    });
    await result.connectionTask;
    const context = mockFeishu.connect.mock.calls[0]?.[0];
    expect(context).toBeDefined();

    current = false;
    await expect(context!.onChallengeAction({} as never)).rejects.toThrow(
      "not owned by this device",
    );
    expect(onChallengeAction).not.toHaveBeenCalled();
  });
});
