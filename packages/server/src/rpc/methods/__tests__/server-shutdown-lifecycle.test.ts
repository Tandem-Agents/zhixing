import { describe, expect, it, vi } from "vitest";
import { RPC_ERROR_CODES } from "../../protocol.js";
import type { HandlerContext } from "../../handlers.js";
import { buildServerShutdownMethod } from "../server.js";

function context(input: {
  prepare: ReturnType<typeof vi.fn>;
  trigger?: ReturnType<typeof vi.fn>;
}): HandlerContext {
  return {
    connection: { authenticated: true, loopback: true } as never,
    server: {
      config: { port: 18900, host: "127.0.0.1" },
      version: "test",
      startedAt: Date.now(),
      token: "token",
      requestShutdown: input.trigger ?? vi.fn(),
      lifecycleShutdown: { prepare: input.prepare },
    } as never,
  };
}

describe("server.shutdown durable lifecycle", () => {
  it("requires a stable requestId before any effect", async () => {
    const prepare = vi.fn();
    await expect(buildServerShutdownMethod().handler({}, context({ prepare })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("returns only after ready-to-stop and then schedules process cleanup", async () => {
    const order: string[] = [];
    const prepare = vi.fn(async (input) => {
      order.push("durable-ready");
      return { requestId: input.requestId, phase: "ready-to-stop" as const, strategy: input.strategy };
    });
    const trigger = vi.fn(() => order.push("shutdown"));
    const result = await buildServerShutdownMethod().handler({
      requestId: "request-stop-1",
      reason: "user-stop",
      strategy: "drain",
      timeoutMs: 1_000,
    }, context({ prepare, trigger }));
    expect(result).toMatchObject({
      accepted: true,
      requestId: "request-stop-1",
      phase: "ready-to-stop",
      strategy: "drain",
    });
    await Promise.resolve();
    expect(order).toEqual(["durable-ready", "shutdown"]);
  });

  it("propagates preparation failure and never acknowledges or triggers shutdown", async () => {
    const prepare = vi.fn(async () => { throw new Error("delivery flush failed"); });
    const trigger = vi.fn();
    await expect(buildServerShutdownMethod().handler({
      requestId: "request-stop-2",
      strategy: "cancel",
    }, context({ prepare, trigger }))).rejects.toThrow("delivery flush failed");
    expect(trigger).not.toHaveBeenCalled();
  });
});
