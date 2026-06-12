import { describe, it, expect, vi } from "vitest";
import {
  buildServerShutdownMethod,
  buildServerInfoMethod,
} from "../server.js";
import type { HandlerContext } from "../../handlers.js";
import { RpcAppError } from "../../handlers.js";
import { RPC_ERROR_CODES } from "../../protocol.js";

function mkCtx(overrides: Partial<HandlerContext["server"]> = {}): HandlerContext {
  return {
    connection: { authenticated: true } as any,
    server: {
      config: { port: 18900, host: "127.0.0.1" } as any,
      version: "0.1.0-test",
      startedAt: Date.now() - 1000,
      token: "t",
      ...overrides,
    } as any,
  };
}

describe("server.shutdown", () => {
  it("calls requestShutdown and returns accepted ack", () => {
    const trigger = vi.fn();
    const entry = buildServerShutdownMethod();
    const ctx = mkCtx({ requestShutdown: trigger });

    const result = entry.handler({ reason: "test-cleanup" }, ctx);
    expect(trigger).toHaveBeenCalledWith("test-cleanup");
    expect(result).toMatchObject({ accepted: true, phase: "stopping" });
    expect(typeof (result as any).estimatedCompleteAt).toBe("string");
  });

  it("uses default reason when params.reason is missing", () => {
    const trigger = vi.fn();
    const ctx = mkCtx({ requestShutdown: trigger });
    buildServerShutdownMethod().handler({}, ctx);
    expect(trigger).toHaveBeenCalledWith(expect.stringMatching(/rpc\.server\.shutdown/));
  });

  it("throws INTERNAL_ERROR when requestShutdown hook is not wired", () => {
    const ctx = mkCtx({ requestShutdown: undefined });
    expect(() => buildServerShutdownMethod().handler({}, ctx)).toThrowError(
      expect.objectContaining({
        name: "RpcAppError",
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
      }),
    );
  });

  it("requires auth (requiresAuth: true)", () => {
    const entry = buildServerShutdownMethod();
    expect(entry.requiresAuth).toBe(true);
  });

  it("does NOT await shutdown (sync-like return)", () => {
    // handler 必须同步返回 ack（或立即 resolve 的 promise）
    const trigger = vi.fn(() => new Promise(() => {})); // 永不 resolve
    const ctx = mkCtx({ requestShutdown: trigger });
    const result = buildServerShutdownMethod().handler({}, ctx);
    // 如果 handler await 了 trigger 的 promise，这里会 pending——但 result 已返回
    expect(result).toBeDefined();
    if (result instanceof Promise) {
      // 如果是 Promise，应该立即 resolve
      return expect(result).resolves.toBeDefined();
    }
  });

  it("accepts timeoutMs param in estimatedCompleteAt calculation", () => {
    const trigger = vi.fn();
    const ctx = mkCtx({ requestShutdown: trigger });
    const before = Date.now();
    const result = buildServerShutdownMethod().handler({ timeoutMs: 60_000 }, ctx) as any;
    const eta = Date.parse(result.estimatedCompleteAt);
    expect(eta).toBeGreaterThanOrEqual(before + 60_000);
    expect(eta).toBeLessThanOrEqual(Date.now() + 60_000 + 100);
  });
});

describe("server.info", () => {
  it("返回宿主状态权威视图(要求认证——含 workspace / 会话规模等运维信息)", () => {
    const ctx = mkCtx({
      listenAddr: { port: 18900, host: "127.0.0.1" },
      requestShutdown: () => {},
    });
    const entry = buildServerInfoMethod();
    expect(entry.requiresAuth).toBe(true);

    const result = entry.handler({}, ctx) as any;
    expect(result.version).toBe("0.1.0-test");
    expect(result.pid).toBe(process.pid);
    expect(result.port).toBe(18900);
    expect(result.shutdownAvailable).toBe(true);
    expect(typeof result.uptimeSec).toBe("number");
    expect(result.uptimeSec).toBeGreaterThanOrEqual(0);
    // 宿主状态权威视图——占用红线可见面与协议兼容判定
    expect(result.protocol).toBe(1);
    expect(typeof result.memoryRssBytes).toBe("number");
    expect(result.memoryRssBytes).toBeGreaterThan(0);
    expect(result.activeConversations).toBe(0);
    expect(result.connectionCount).toBe(0);
  });

  it("叠加活跃会话 / 连接数 / 宿主装配信息(workspace / logPath)", () => {
    const ctx = mkCtx({
      conversations: {
        list: () => [{ busy: true }, { busy: false }],
      } as never,
      connectionCount: () => 3,
      hostInfo: { workspace: "/ws", logPath: "/log/host.log" },
    });
    const result = buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.activeConversations).toBe(2);
    expect(result.busyConversations).toBe(1);
    expect(result.connectionCount).toBe(3);
    expect(result.workspace).toBe("/ws");
    expect(result.logPath).toBe("/log/host.log");
  });

  it("marks shutdownAvailable=false when requestShutdown not wired", () => {
    const ctx = mkCtx({ requestShutdown: undefined });
    const result = buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.shutdownAvailable).toBe(false);
  });

  // silence lint on unused import
  it("RpcAppError is a class", () => {
    expect(typeof RpcAppError).toBe("function");
  });
});
