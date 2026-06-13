import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RpcClient, ServerEndpoint } from "@zhixing/server";

const rpcMocks = vi.hoisted(() => ({
  discoverServer: vi.fn(),
  createRpcClient: vi.fn(),
}));

vi.mock("@zhixing/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhixing/server")>();
  return {
    ...actual,
    discoverServer: rpcMocks.discoverServer,
    createRpcClient: rpcMocks.createRpcClient,
  };
});

import { runRpcCommand } from "../command.js";

const endpoint: ServerEndpoint = {
  url: "ws://127.0.0.1:18900/ws",
  httpBase: "http://127.0.0.1:18900",
  token: "tok",
  pid: {
    pidFileVersion: 2,
    pid: 1,
    port: 18900,
    startTime: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
  },
};

function makeFakeRpcClient(
  onSessionSend: (params: Record<string, unknown>, emit: EmitNotification) => unknown,
) {
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const emit: EmitNotification = (method, params) => {
    for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
  };
  const client = {
    connect: vi.fn(async () => {}),
    authenticate: vi.fn(async () => ({
      protocol: 1,
      server: { version: "test" },
      capabilities: [] as string[],
    })),
    request: vi.fn(async (method: string, params?: unknown) => {
      if (method === "session.send") {
        return onSessionSend(params as Record<string, unknown>, emit);
      }
      return {};
    }),
    onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
      let set = handlers.get(method);
      if (!set) {
        set = new Set();
        handlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    }),
    onAnyNotification: vi.fn(() => () => {}),
    close: vi.fn(async () => {}),
    closed: false,
  };
  return client as unknown as RpcClient & { request: ReturnType<typeof vi.fn> };
}

type EmitNotification = (method: string, params: unknown) => void;

describe("runRpcCommand · session.send", () => {
  beforeEach(() => {
    rpcMocks.discoverServer.mockResolvedValue(endpoint);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rpcMocks.discoverServer.mockReset();
    rpcMocks.createRpcClient.mockReset();
  });

  it("预分配 turnId,只消费本次 turn 的 delta/complete", async () => {
    let sentParams: Record<string, unknown> | null = null;
    const client = makeFakeRpcClient((params, emit) => {
      sentParams = params;
      const turnId = params.turnId as string;
      emit("session.delta", {
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId: "turn-foreign",
        delta: { type: "text_delta", text: "foreign" },
      });
      emit("session.complete", {
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId: "turn-foreign",
        result: { reason: "error" },
      });
      emit("session.delta", {
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        delta: { type: "text_delta", text: "own" },
      });
      emit("session.complete", {
        conversationId: "conv-1",
        sessionId: "conv-1",
        turnId,
        result: { reason: "completed" },
      });
      return { conversationId: "conv-1", sessionId: "conv-1", turnId };
    });
    rpcMocks.createRpcClient.mockReturnValue(client);

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const exitCode = await runRpcCommand({
      method: "session.send",
      rest: ["你好"],
    });

    expect(exitCode).toBe(0);
    expect(sentParams?.text).toBe("你好");
    expect(sentParams?.turnId).toEqual(expect.any(String));
    expect(String(sentParams?.turnId).length).toBeGreaterThan(0);
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe("own");
  });
});
