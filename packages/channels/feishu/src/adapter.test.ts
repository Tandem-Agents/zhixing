import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelContext,
} from "@zhixing/core/channels";

const {
  mockStart,
  mockClose,
  mockCreate,
  mockRegister,
  mockCardAction,
} = vi.hoisted(() => ({
  mockStart: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn(),
  mockCreate: vi.fn(),
  mockRegister: vi.fn(),
  mockCardAction: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: { message: { create: mockCreate } },
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: mockRegister.mockReturnThis(),
  })),
  WSClient: vi.fn().mockImplementation(({ logger }) => ({
    start: async (options: unknown) => { await mockStart(options); logger.debug("[ws]", "ws connect success"); },
    close: mockClose,
  })),
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 3, trace: 0 },
  CardActionHandler: vi.fn().mockImplementation(
    (
      _options: unknown,
      callback: (event: unknown) => Promise<unknown>,
    ) => {
      mockCardAction.mockImplementation(callback);
      return { handle: vi.fn() };
    },
  ),
  adaptDefault: vi.fn((_path: string, handler: unknown) => handler),
}));

import { FeishuAdapter } from "./adapter.js";
import { WSClient } from "@larksuiteoapi/node-sdk";

// 结构完备的签名 challenge token:严格 callback 校验器只放行规范 wire 形态。
function challengeToken() {
  return {
    v: 1,
    assignmentId: "asg-1",
    challengeId: "challenge-1",
    displayDigest: `sha256:${"a".repeat(64)}`,
    interactionRequestId: "interaction-1",
    issuedAt: "2026-07-28T00:00:00.000Z",
    expiry: "2026-07-28T01:00:00.000Z",
    ref: {
      execution: "conversation",
      conversationId: "conv-1",
      runId: "run-1",
      ownerEpoch: 1,
    },
    route: { channelId: "feishu", to: "ou_user" },
    signature: { alg: "ed25519", keyId: "device:owner", sig: "sig-bytes" },
  };
}

function makeContext(overrides?: Partial<ChannelContext>): ChannelContext {
  return {
    config: {
      type: "feishu",
      enabled: true,
      credentials: {
        appId: "test-id",
        appSecret: "test-secret",
        verificationToken: "verification",
        encryptKey: "encryption",
      },
    },
    abortSignal: new AbortController().signal,
    eventBus: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    } as unknown as ChannelContext["eventBus"],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    onMessage: vi.fn(),
    onChallengeAction: vi.fn(),
    registerHttpRoute: vi.fn(),
    ...overrides,
  };
}

describe("FeishuAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ code: 0, data: { message_id: "msg_out_1" } });
  });

  it("declares MVP capabilities (no streaming, no edit)", () => {
    const adapter = new FeishuAdapter();
    expect(adapter.capabilities.streaming).toBe(false);
    expect(adapter.capabilities.edit).toBe(false);
    expect(adapter.capabilities.media).toBe(false);
    expect(adapter.id).toBe("feishu");
  });

  it("connects and starts WSClient", async () => {
    const adapter = new FeishuAdapter();
    const context = makeContext();
    await adapter.connect(context);
    expect(mockStart).toHaveBeenCalledOnce();
    expect(context.registerHttpRoute).toHaveBeenCalledWith(
      "/channels/feishu/challenge",
      expect.anything(),
    );
  });

  it("reports actual socket loss instead of remaining healthy until process exit", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    expect(adapter.health()).toBe("ready");
    const options = vi.mocked(WSClient).mock.calls[0]![0];
    expect(options.autoReconnect).toBe(false);
    options.logger!.debug("[ws]", "client closed");
    expect(adapter.health()).toBe("unavailable");
  });

  it("awaits admission and propagates its failure; replay retains the platform identity", async () => {
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => { accept = resolve; });
    const onMessage = vi.fn<ChannelContext["onMessage"]>(async () => gate);
    await new FeishuAdapter("work").connect(makeContext({ onMessage }));
    const receive = mockRegister.mock.calls[0]![0]["im.message.receive_v1"];
    const event = { sender: { sender_type: "user", sender_id: { open_id: "user" } },
      message: { message_id: "stable-platform-event", create_time: "1", chat_id: "chat", chat_type: "p2p", message_type: "text", content: '{"text":"hello"}' } };
    let acknowledged = false;
    const receiving = receive(event).then(() => { acknowledged = true; });
    await Promise.resolve(); expect(acknowledged).toBe(false);
    accept(); await receiving;
    await receive(event);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const retryEvent = { ...event, message: { ...event.message, message_id: "retry-event" } };
    onMessage.mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(receive(retryEvent)).rejects.toThrow("authority unavailable");
    await receive(retryEvent);
    expect(onMessage).toHaveBeenCalledTimes(3);
    expect(onMessage.mock.calls[0]![0]).toMatchObject({ channelId: "work", messageId: "stable-platform-event" });
  });

  it("carries stable delivery idempotency into the platform API", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    const target = { channelId: "feishu", to: "ou_user" };
    const meta = { idempotencyKey: "logical-reply", deliveryAttempt: { itemId: "item", attempt: 1 } };
    await adapter.send(target, { text: "hello" }, meta);
    await adapter.send(target, { text: "hello" }, meta);
    expect(mockCreate.mock.calls[0]![0].data.uuid).toMatch(/^[a-f0-9]{32}$/);
    expect(mockCreate.mock.calls[1]![0].data.uuid).toBe(mockCreate.mock.calls[0]![0].data.uuid);
  });

  it("derives a platform-authenticated responder from a signed card callback", async () => {
    const onChallengeAction = vi.fn();
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext({ onChallengeAction }));

    await mockCardAction({
      open_id: "ou_user",
      tenant_key: "tenant",
      action: {
        value: {
          v: 1,
          token: challengeToken(),
          decision: { allowed: true },
        },
      },
    });

    expect(onChallengeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        token: challengeToken(),
        responder: {
          channelId: "feishu",
          platformSubject: "ou_user",
          tenant: "tenant",
        },
        decision: { allowed: true },
      }),
    );
  });

  it("keeps basic messaging and disables challenges without callback credentials", async () => {
    const adapter = new FeishuAdapter();
    const context = makeContext();
    context.config.credentials = { appId: "test-id", appSecret: "test-secret" };
    await adapter.connect(context);

    expect(adapter.sendChallenge).toBeUndefined();
    expect(context.registerHttpRoute).not.toHaveBeenCalled();
    expect(context.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("verificationToken"),
    );

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );
    expect(result.success).toBe(true);
  });

  it("rejects callback payloads and decisions carrying unknown fields", async () => {
    const onChallengeAction = vi.fn();
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext({ onChallengeAction }));

    await expect(
      mockCardAction({
        open_id: "ou_user",
        action: {
          value: {
            v: 1,
            token: challengeToken(),
            decision: { allowed: true },
            extra: "injected",
          },
        },
      }),
    ).rejects.toThrow(/fields are incomplete or unknown/u);
    await expect(
      mockCardAction({
        open_id: "ou_user",
        action: {
          value: {
            v: 1,
            token: challengeToken(),
            decision: { allowed: false, reason: "no", verdict: "spoofed" },
          },
        },
      }),
    ).rejects.toThrow(/fields are incomplete or unknown/u);
    expect(onChallengeAction).not.toHaveBeenCalled();
  });

  it("disconnects and closes WSClient", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    await adapter.disconnect();
    expect(mockClose).toHaveBeenCalled();
  });

  it("sends a card message via open_id", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello", markdown: "**Hello**" },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg_out_1");
    expect(mockCreate).toHaveBeenCalledOnce();

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.params.receive_id_type).toBe("open_id");
    expect(callArgs.data.receive_id).toBe("ou_user1");
    expect(callArgs.data.msg_type).toBe("interactive");
  });

  it("sends to chat_id for group targets", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());

    await adapter.send(
      { channelId: "feishu", to: "oc_group1" },
      { text: "Hi group" },
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.params.receive_id_type).toBe("chat_id");
    expect(callArgs.data.receive_id).toBe("oc_group1");
  });

  it("returns retryable=false for permanent API errors", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    mockCreate.mockResolvedValue({ code: 99991400, msg: "invalid param" });

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("returns retryable=true for rate limit errors", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    mockCreate.mockResolvedValue({ code: 99991429, msg: "rate limited" });

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it("preserves uncertain transport outcomes for Delivery instead of reporting not-sent", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    mockCreate.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    )).rejects.toThrow("ECONNREFUSED");
  });

  it("returns error when not connected", async () => {
    const adapter = new FeishuAdapter();
    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("cleans up internal state when connect fails", async () => {
    mockStart.mockRejectedValueOnce(new Error("auth failed"));
    const adapter = new FeishuAdapter();

    await expect(adapter.connect(makeContext())).rejects.toThrow("auth failed");

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("closes WSClient on abort signal", async () => {
    const ac = new AbortController();
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext({ abortSignal: ac.signal }));

    expect(mockClose).not.toHaveBeenCalled();
    ac.abort();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("uses markdown content when available", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());

    await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "plain", markdown: "**bold**" },
    );

    const content = JSON.parse(mockCreate.mock.calls[0][0].data.content);
    expect(content.elements[0].content).toContain("**bold**");
  });

  it("falls back to text when markdown is absent", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());

    await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "fallback text" },
    );

    const content = JSON.parse(mockCreate.mock.calls[0][0].data.content);
    expect(content.elements[0].content).toContain("fallback text");
  });
});
