import { describe, it, expect, vi } from "vitest";
import {
  buildServerShutdownMethod,
  buildServerInfoMethod,
  buildDeliveryResolveMethod,
  buildLlmCompleteMethod,
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

  it("drain strategy waits for active work before triggering shutdown", async () => {
    vi.useFakeTimers();
    try {
      const trigger = vi.fn();
      let busy = true;
      const ctx = mkCtx({
        requestShutdown: trigger,
        conversations: {
          list: () => [{ conversationId: "conv-1", busy, pendingCount: 0 }],
        } as never,
        runtimeControl: { flushDelivery: vi.fn(async () => {}) },
      });

      const result = buildServerShutdownMethod().handler(
        { reason: "user-stop", strategy: "drain", timeoutMs: 1_000 },
        ctx,
      ) as any;

      expect(result.strategy).toBe("drain");
      expect(trigger).not.toHaveBeenCalled();
      busy = false;
      await vi.advanceTimersByTimeAsync(200);
      expect(trigger).toHaveBeenCalledWith("user-stop:drain");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain strategy does not let delivery flush block shutdown forever", async () => {
    vi.useFakeTimers();
    try {
      const trigger = vi.fn();
      const ctx = mkCtx({
        requestShutdown: trigger,
        conversations: { list: () => [] } as never,
        runtimeControl: { flushDelivery: vi.fn(() => new Promise<void>(() => {})) },
      });

      const result = buildServerShutdownMethod().handler(
        { reason: "user-stop", strategy: "drain", timeoutMs: 100 },
        ctx,
      ) as any;

      expect(result.strategy).toBe("drain");
      expect(trigger).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(trigger).toHaveBeenCalledWith("user-stop:drain");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server.info", () => {
  it("返回宿主状态权威视图(要求认证——含 workspace / 会话规模等运维信息)", async () => {
    const ctx = mkCtx({
      listenAddr: { port: 18900, host: "127.0.0.1" },
      requestShutdown: () => {},
    });
    const entry = buildServerInfoMethod();
    expect(entry.requiresAuth).toBe(true);

    const result = await entry.handler({}, ctx) as any;
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

  it("叠加活跃会话 / 连接数 / 宿主装配信息(workspace / logPath)", async () => {
    const ctx = mkCtx({
      conversations: {
        list: () => [{ busy: true }, { busy: false }],
      } as never,
      connectionCount: () => 3,
      hostInfo: { workspace: "/ws", logPath: "/log/host.log" },
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.activeConversations).toBe(2);
    expect(result.busyConversations).toBe(1);
    expect(result.connectionCount).toBe(3);
    expect(result.workspace).toBe("/ws");
    expect(result.logPath).toBe("/log/host.log");
  });

  it("叠加 MCP 状态快照", async () => {
    const ctx = mkCtx({
      mcpStatuses: () => [
        {
          serverId: "github",
          transport: "stdio",
          status: "connected",
          toolCount: 3,
        },
      ],
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.mcpServers).toEqual([
      {
        serverId: "github",
        transport: "stdio",
        status: "connected",
        toolCount: 3,
      },
    ]);
  });

  it("叠加通道状态快照", async () => {
    const ctx = mkCtx({
      channels: {
        listStatuses: () => [
          {
            channelId: "feishu",
            state: "connecting",
          },
        ],
      } as never,
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.channels).toEqual([
      {
        channelId: "feishu",
        state: "connecting",
      },
    ]);
  });

  it("叠加运行控制投影", async () => {
    const ctx = {
      ...mkCtx({
        conversations: {
          list: () => [
            {
              conversationId: "conv-1",
              busy: true,
              pendingCount: 2,
            },
          ],
        } as never,
        runRegistry: { size: () => 1 } as never,
        scheduler: {
          listTasks: () => [
            { id: "user-task", enabled: true, system: false },
            { id: "system-task", enabled: true, system: true },
            { id: "disabled-task", enabled: false, system: false },
          ],
        } as never,
        runtimeControl: {
          deliveryStats: () => ({
            pending: 3,
            queued: 3,
            attempting: 0,
            delivered: 0,
            failed: 0,
            retrying: 1,
            uncertain: 0,
          }),
        },
        channels: {
          listStatuses: () => [
            { channelId: "feishu", state: "connected" },
            { channelId: "slack", state: "disconnected" },
          ],
        } as never,
        connectionCount: () => 2,
      }),
      connection: { id: 7, authenticated: true } as never,
    };

    const result = await buildServerInfoMethod().handler({}, ctx) as any;

    expect(result.accessSurfaces.otherRpcConnections).toBe(1);
    expect(result.accessSurfaces.liveChannels).toEqual([
      { channelId: "feishu", state: "connected" },
    ]);
    expect(result.activeWork.count).toBe(4);
    expect(result.activeWork.cancellableWork).toMatchObject([
      { id: "conversation:conv-1", count: 3 },
      { id: "scheduler:runs", count: 1 },
    ]);
    expect(result.deferredWork).toMatchObject([
      { id: "delivery:queue", count: 3 },
    ]);
    expect(result.keepAliveWork).toMatchObject([
      { id: "scheduler:enabled", count: 1 },
    ]);
  });

  it("marks shutdownAvailable=false when requestShutdown not wired", async () => {
    const ctx = mkCtx({ requestShutdown: undefined });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.shutdownAvailable).toBe(false);
  });

  it("returns delivery history after each caller's durable revision", async () => {
    const deliveryStatus = vi.fn(async () => [{
      v: 1,
      ref: { execution: "delivery", itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN" },
      state: "delivery-failed",
      statusRevision: 4,
      actions: [],
      at: "2026-07-17T02:00:00.000Z",
      attempt: 1,
      anchorEpoch: 2,
    }]);
    const ctx = mkCtx({ runtimeControl: { deliveryStatus } });

    const result = await buildServerInfoMethod().handler({
      deliveryStatusAfter: { "dlv-01KXPWTM80BYB4SH423EJT1CVN": 3 },
    }, ctx) as any;

    expect(deliveryStatus).toHaveBeenCalledWith({
      "dlv-01KXPWTM80BYB4SH423EJT1CVN": 3,
    });
    expect(result.deliveryStatus).toHaveLength(1);
  });

  it("returns conversation status history after each run cursor", async () => {
    const conversationStatus = vi.fn(async () => ({
      notices: [{
        v: 1,
        ref: {
          execution: "conversation",
          conversationId: "conversation-1",
          runId: "run-1",
          ownerEpoch: 1,
        },
        state: "uncertain",
        statusRevision: 4,
        actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
        at: "2026-07-18T02:00:00.000Z",
        openFactDigest: `sha256:${"a".repeat(64)}`,
      }],
      next: [{
        conversationId: "conversation-1",
        runId: "run-1",
        afterStatusRevision: 4,
      }],
    }));
    const ctx = mkCtx({ runtimeControl: { conversationStatus } });
    const cursor = {
      conversationId: "conversation-1",
      runId: "run-1",
      afterStatusRevision: 3,
    };

    const result = await buildServerInfoMethod().handler({
      conversationStatusAfter: [cursor],
    }, ctx) as any;

    expect(conversationStatus).toHaveBeenCalledWith([cursor]);
    expect(result.conversationStatus).toHaveLength(1);
    expect(result.conversationStatusNext).toEqual([
      { conversationId: "conversation-1", runId: "run-1", afterStatusRevision: 4 },
    ]);
  });

  it("returns job status history after each run cursor", async () => {
    const jobStatus = vi.fn(async () => ({
      notices: [{
        v: 1,
        ref: {
          execution: "job",
          taskId: "task-1",
          jobRunId: "job-run-1",
          anchorEpoch: 1,
        },
        state: "running",
        statusRevision: 3,
        actions: [],
        at: "2026-07-28T02:00:00.000Z",
      }],
      next: [{
        taskId: "task-1",
        jobRunId: "job-run-1",
        afterStatusRevision: 3,
      }],
    }));
    const ctx = mkCtx({ runtimeControl: { jobStatus } });
    const cursor = {
      taskId: "task-1",
      jobRunId: "job-run-1",
      afterStatusRevision: 2,
    };

    const result = await buildServerInfoMethod().handler({
      jobStatusAfter: [cursor],
    }, ctx) as any;

    expect(jobStatus).toHaveBeenCalledWith([cursor]);
    expect(result.jobStatus).toHaveLength(1);
    expect(result.jobStatusNext).toEqual([cursorWithRevision(cursor, 3)]);
  });

  it("rejects a delivery cursor outside the protocol identifier domain", async () => {
    const ctx = mkCtx({ runtimeControl: { deliveryStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        deliveryStatusAfter: { ["i".repeat(481)]: 0 },
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("rejects malformed conversation status cursors", async () => {
    const ctx = mkCtx({ runtimeControl: { conversationStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        conversationStatusAfter: [{
          conversationId: "conversation-1",
          runId: "run-1",
          afterStatusRevision: -1,
        }],
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("rejects malformed job status cursors", async () => {
    const ctx = mkCtx({ runtimeControl: { jobStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        jobStatusAfter: [{
          taskId: "task-1",
          jobRunId: "job-run-1",
          afterStatusRevision: -1,
        }],
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  // silence lint on unused import
  it("RpcAppError is a class", () => {
    expect(typeof RpcAppError).toBe("function");
  });
});

function cursorWithRevision<T extends object>(
  cursor: T,
  afterStatusRevision: number,
): T & { afterStatusRevision: number } {
  return { ...cursor, afterStatusRevision };
}

describe("delivery.resolve", () => {
  it("forwards a validated decision with the authenticated surface identity", async () => {
    const resolveDelivery = vi.fn(async () => ({ status: "ok" }));
    const ctx = {
      ...mkCtx({
        runtimeControl: { resolveDelivery },
        conversations: {
          durableControlPrincipal: (input: {
            surfacePrincipal: string;
            connectionId: string;
          }) => ({ ...input, deviceId: "anchor-device" }),
        } as never,
      }),
      connection: {
        id: 7,
        authenticated: true,
        clientInfo: { id: "desktop" },
      } as never,
    };
    const params = {
      requestId: "resolution-1",
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      attempt: 1,
      anchorEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "abandon",
    } as const;

    await expect(buildDeliveryResolveMethod().handler(params, ctx)).resolves.toEqual({
      status: "ok",
    });
    expect(resolveDelivery).toHaveBeenCalledWith({
      ...params,
      principal: {
        surfacePrincipal: "rpc:owner",
        deviceId: "anchor-device",
        connectionId: "7",
      },
    });
  });

  it("rejects incomplete or unknown decision fields", async () => {
    const entry = buildDeliveryResolveMethod();
    await expect(entry.handler({ decision: "abandon" }, mkCtx())).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
    });
  });

  it("rejects invalid request, item, and derived surface identifiers", async () => {
    const resolveDelivery = vi.fn();
    const entry = buildDeliveryResolveMethod();
    const valid = {
      requestId: "resolution-1",
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      attempt: 1,
      anchorEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "abandon",
    };
    const ctx = {
      ...mkCtx({
        runtimeControl: { resolveDelivery },
        conversations: {
          durableControlPrincipal: (input: {
            surfacePrincipal: string;
            connectionId: string;
          }) => ({ ...input, deviceId: "anchor-device" }),
        } as never,
      }),
      connection: { id: 7, authenticated: true, clientInfo: { id: "desktop" } },
    } as never;

    await expect(
      entry.handler({ ...valid, requestId: "r".repeat(481) }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "i".repeat(481) }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "item-01KXPWTM80BYB4SH423EJT1CVN" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVI" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler(valid, {
        ...ctx,
        connection: {
          id: "c".repeat(481),
          authenticated: true,
          clientInfo: { id: "desktop" },
        },
      } as never),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(resolveDelivery).not.toHaveBeenCalled();
  });
});

describe("llm.complete", () => {
  it("仅可信 loopback 面可调用,并转发 prompt / role", async () => {
    const complete = vi.fn(async (prompt: string, role?: "main" | "light") =>
      `${role ?? "default"}:${prompt}`,
    );
    const ctx = {
      ...mkCtx({ llmComplete: complete }),
      connection: { authenticated: true, loopback: true } as any,
    };
    const entry = buildLlmCompleteMethod();
    expect(entry.requiresAuth).toBe(true);

    await expect(
      entry.handler({ prompt: "整理 MCP 配置", role: "main" }, ctx),
    ).resolves.toEqual({ text: "main:整理 MCP 配置" });
    expect(complete).toHaveBeenCalledWith("整理 MCP 配置", "main");
  });

  it("拒绝非 loopback / 空 prompt / 非法 role / 未装配执行体", async () => {
    const entry = buildLlmCompleteMethod();
    await expect(
      entry.handler(
        { prompt: "x" },
        { ...mkCtx(), connection: { authenticated: true, loopback: false } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "" },
        { ...mkCtx({ llmComplete: async () => "x" }), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "x", role: "fast" },
        { ...mkCtx({ llmComplete: async () => "x" }), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "x" },
        { ...mkCtx(), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INTERNAL_ERROR });
  });
});
