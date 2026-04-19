import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "@zhixing/core";

const { mockStart, mockClose, mockCreate, mockRegister } = vi.hoisted(() => ({
  mockStart: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn(),
  mockCreate: vi.fn(),
  mockRegister: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: { message: { create: mockCreate } },
  })),
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: mockRegister.mockReturnThis(),
  })),
  WSClient: vi.fn().mockImplementation(() => ({
    start: mockStart,
    close: mockClose,
  })),
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { info: 3 },
}));

import { FeishuAdapter } from "./adapter.js";

function makeContext(overrides?: Partial<ChannelContext>): ChannelContext {
  return {
    config: {
      type: "feishu",
      enabled: true,
      credentials: { appId: "test-id", appSecret: "test-secret" },
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
    await adapter.connect(makeContext());
    expect(mockStart).toHaveBeenCalledOnce();
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

  it("returns retryable=true for network errors", async () => {
    const adapter = new FeishuAdapter();
    await adapter.connect(makeContext());
    mockCreate.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await adapter.send(
      { channelId: "feishu", to: "ou_user1" },
      { text: "Hello" },
    );

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
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
