/**
 * S2.C 集成测试：真实 WebSocket 客户端 → Server → 响应
 *
 * 验证：
 * - WebSocket upgrade 路径过滤
 * - JSON-RPC 请求/响应往返
 * - auth 方法 + 认证状态机
 * - 未认证时其他方法被拒
 * - parse error / method not found 错误返回
 */

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { acquireFileLock, withFileLockProcessIdentity } from "@zhixing/core/persistence";
import {
  DEVICE_CAPACITY_CLASSES,
  DefaultDeviceCapacityArbiter,
  currentDeviceCapacityStep,
  isHoldingMaintenanceExclusion,
  runHoldingMaintenanceExclusion,
  runWithDeviceCapacity,
  type DeviceCapacityPolicy,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import { startServer, type ZhixingServerInstance } from "../server.js";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import {
  encodeRequest,
  encodeNotification,
  parseMessage,
  RPC_ERROR_CODES,
  type JsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
} from "../rpc/protocol.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-rpc";

// ─── 客户端辅助 ───

interface RpcClient {
  ws: WebSocket;
  /** 发送请求并等待响应 */
  request(method: string, params?: unknown): Promise<JsonRpcResponse>;
  /** 发送通知（不等响应） */
  notify(method: string, params?: unknown): void;
  /** 等待下一条消息 */
  nextMessage(): Promise<unknown>;
  close(): void;
}

async function connect(port: number, path = "/ws"): Promise<RpcClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 0;
  const pending = new Map<string | number, (msg: JsonRpcResponse) => void>();
  const messageQueue: unknown[] = [];
  const messageWaiters: Array<(msg: unknown) => void> = [];

  ws.on("message", (data) => {
    const text = data.toString();
    const parsed = parseMessage(text);
    if (parsed.kind === "response") {
      const id = parsed.message.id;
      if (id !== null) {
        const cb = pending.get(id);
        if (cb) {
          pending.delete(id);
          cb(parsed.message);
          return;
        }
      }
    }
    // 非响应消息（通知、未匹配响应）→ 推入队列
    if (messageWaiters.length > 0) {
      messageWaiters.shift()!(parsed);
    } else {
      messageQueue.push(parsed);
    }
  });

  return {
    ws,
    request(method, params) {
      const id = ++nextId;
      return new Promise<JsonRpcResponse>((resolve) => {
        pending.set(id, resolve);
        ws.send(encodeRequest(id, method, params));
      });
    },
    notify(method, params) {
      ws.send(encodeNotification(method, params));
    },
    nextMessage() {
      if (messageQueue.length > 0) {
        return Promise.resolve(messageQueue.shift());
      }
      return new Promise((resolve) => messageWaiters.push(resolve));
    },
    close() {
      ws.close();
    },
  };
}

// ─── 测试 ───

describe("WebSocket RPC 只恢复服务级的平台身份端口", () => {
  const MIB = 1024 * 1024;
  const capacity = { memoryReservationBytes: MIB, temporaryBytes: 0, slots: 1 };
  const step = { occupancy: capacity, quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 } };
  const capacityPolicy: DeviceCapacityPolicy = {
    version: 1,
    occupancy: { memoryReservationBytes: 16 * MIB, temporaryBytes: 16 * MIB, slots: 1, memorySafetyReserveBytes: 0, temporarySafetyReserveBytes: 0 },
    quantum: { readBytes: 100, writeBytes: 100, ioOperations: 100 },
    quantumRefillPerSecond: { readBytes: 100, writeBytes: 100, ioOperations: 100 },
    pressure: { maxCpuBusyRatio: 0.9, minimumAvailableMemoryBytes: 0 },
    retryAfterMs: 1,
    classWeights: Object.fromEntries(DEVICE_CAPACITY_CLASSES.map((serviceClass) => [serviceClass, 1])) as DeviceCapacityPolicy["classWeights"],
  };

  // 取锁时哪个解析器被调用，就说明请求处理拿到的是哪个服务的身份端口（都没被调用＝落到默认解析）。
  function platformIdentity(calls: string[], name: string) {
    return { read: async (pid: number) => { calls.push(name); return { kind: "present" as const, birth: `win32:${pid}` }; } };
  }

  function testContext(): ReturnType<typeof createServerContext> {
    return createServerContext({ config: { ...DEFAULT_SERVER_CONFIG, port: 0 }, version: TEST_VERSION, token: TEST_TOKEN });
  }

  function registerLock(server: ZhixingServerInstance, directory: string): void {
    let next = 0;
    server.registry.register({
      name: "test.lock",
      requiresAuth: false,
      handler: async () => {
        const release = await acquireFileLock(path.join(directory, `lock-${++next}`), { staleMs: 30_000, waitMs: 1_000 });
        await release();
        return { ok: true };
      },
    });
  }

  it("两个服务各在自己的身份作用域内启动，每次请求只用本服务的端口，断开重连后不变", async () => {
    const root = await createTempDir("ws-platform-identity");
    const calls: string[] = [];
    const first = await withFileLockProcessIdentity(platformIdentity(calls, "first"), () => startServer({ context: testContext() }));
    const second = await withFileLockProcessIdentity(platformIdentity(calls, "second"), () => startServer({ context: testContext() }));
    try {
      registerLock(first, path.join(root, "first"));
      registerLock(second, path.join(root, "second"));
      const toFirst = await connect(first.port);
      const toSecond = await connect(second.port);
      await toFirst.request("test.lock");
      await toSecond.request("test.lock");
      await toFirst.request("test.lock");
      await toSecond.request("test.lock");
      const byServer = (name: string) => calls.filter((call) => call === name).length;
      expect(calls.length).toBeGreaterThanOrEqual(4);
      expect(new Set(calls)).toEqual(new Set(["first", "second"]));
      const beforeReconnect = byServer("first");
      toFirst.close();
      const again = await connect(first.port);
      await again.request("test.lock");
      expect(byServer("first")).toBeGreaterThan(beforeReconnect);
      again.close();
      toSecond.close();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("接入时已结束的维护互斥、已完成的容量步骤与其他操作上下文不随消息复活，前一请求的上下文不进入下一请求", async () => {
    const root = await createTempDir("ws-platform-identity-only");
    const calls: string[] = [];
    const operation = new AsyncLocalStorage<string>();
    const carried = new AsyncLocalStorage<string>();
    const arbiter = new DefaultDeviceCapacityArbiter({
      policy: capacityPolicy,
      probe: () => ({ cpuBusyRatio: 0, availableMemoryBytes: 64 * MIB, processRssBytes: MIB, temporaryBytesAvailable: 64 * MIB }),
    });
    const admission = { admissionId: "server-start", serviceClass: "workload-interactive" as const, atomic: step, preferred: step, maxWaitMs: 0 };
    const server = await withFileLockProcessIdentity(platformIdentity(calls, "service"), () =>
      operation.run("startup-operation", () =>
        runHoldingMaintenanceExclusion(() =>
          runWithDeviceCapacity(arbiter, admission, new AbortController().signal, () => startServer({ context: testContext() })))));
    try {
      registerLock(server, root);
      server.registry.register({ name: "test.carry", requiresAuth: false, handler: () => { carried.enterWith("previous-request"); return { ok: true }; } });
      server.registry.register({
        name: "test.context",
        requiresAuth: false,
        handler: () => {
          let step: string;
          try { step = currentDeviceCapacityStep() === undefined ? "none" : "active"; } catch { step = "revived-finished-step"; }
          return { holdingExclusion: isHoldingMaintenanceExclusion(), step, operation: operation.getStore() ?? null, carried: carried.getStore() ?? null };
        },
      });
      const client = await connect(server.port);
      await client.request("test.carry");
      const seen = await client.request("test.context");
      expect(isSuccessResponse(seen) && seen.result).toEqual({ holdingExclusion: false, step: "none", operation: null, carried: null });
      await client.request("test.lock");
      expect(calls).toContain("service");
      client.close();
    } finally {
      await server.close();
    }
  });
});

describe("WebSocket + RPC (S2.C)", () => {
  let server: ZhixingServerInstance;

  beforeEach(async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });
    server = await startServer({ context: ctx });
  });

  afterEach(async () => {
    await server.close();
  });

  it("WebSocket upgrade only succeeds on /ws path", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/wrong-path`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) => {
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      }),
    ).rejects.toThrow();
  });

  it("auth with correct token succeeds and returns protocol info", async () => {
    const client = await connect(server.port);
    const response = await client.request("auth", {
      token: TEST_TOKEN,
      client: { id: "test-client", version: "0.1.0" },
    });
    expect(isSuccessResponse(response)).toBe(true);
    if (isSuccessResponse(response)) {
      expect(response.result).toMatchObject({
        protocol: 1,
        server: { version: TEST_VERSION },
      });
      // capabilities is dependency-driven; this server has no sessions/scheduler injected
      const result = response.result as { capabilities: string[] };
      expect(Array.isArray(result.capabilities)).toBe(true);
    }
    client.close();
  });

  it("auth with wrong token returns UNAUTHORIZED", async () => {
    const client = await connect(server.port);
    const response = await client.request("auth", { token: "wrong" });
    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(RPC_ERROR_CODES.UNAUTHORIZED);
    }
    client.close();
  });

  it("auth without token returns INVALID_PARAMS", async () => {
    const client = await connect(server.port);
    const response = await client.request("auth", {});
    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("health works without auth", async () => {
    const client = await connect(server.port);
    const response = await client.request("health");
    expect(isSuccessResponse(response)).toBe(true);
    if (isSuccessResponse(response)) {
      expect(response.result).toMatchObject({ status: "ok", version: TEST_VERSION });
    }
    client.close();
  });

  it("methods requiring auth fail before auth", async () => {
    server.registry.register({
      name: "test.protected",
      requiresAuth: true,
      handler: () => ({ ok: true }),
    });

    const client = await connect(server.port);
    const response = await client.request("test.protected");
    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(RPC_ERROR_CODES.UNAUTHORIZED);
    }
    client.close();
  });

  it("server.shutdown is rejected by the router before its local lifecycle is consulted", async () => {
    const client = await connect(server.port);
    const response = await client.request("server.shutdown", {
      requestId: "unauthenticated-shutdown",
    });
    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(RPC_ERROR_CODES.UNAUTHORIZED);
    }
    client.close();
  });

  it("methods requiring auth succeed after auth", async () => {
    server.registry.register({
      name: "test.protected",
      requiresAuth: true,
      handler: () => ({ ok: true }),
    });

    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const response = await client.request("test.protected");
    expect(isSuccessResponse(response)).toBe(true);
    if (isSuccessResponse(response)) {
      expect(response.result).toEqual({ ok: true });
    }
    client.close();
  });

  it("unknown method returns METHOD_NOT_FOUND", async () => {
    const client = await connect(server.port);
    const response = await client.request("nonexistent.method");
    expect(isErrorResponse(response)).toBe(true);
    if (isErrorResponse(response)) {
      expect(response.error.code).toBe(RPC_ERROR_CODES.METHOD_NOT_FOUND);
    }
    client.close();
  });

  it("malformed JSON returns PARSE_ERROR with null id", async () => {
    const client = await connect(server.port);
    const waiter = client.nextMessage();
    client.ws.send("not json {");
    const result = await waiter;
    if (
      result &&
      typeof result === "object" &&
      "kind" in result &&
      (result as { kind: string }).kind === "response"
    ) {
      const msg = (result as { message: JsonRpcResponse }).message;
      expect(isErrorResponse(msg)).toBe(true);
      if (isErrorResponse(msg)) {
        expect(msg.error.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);
        expect(msg.id).toBeNull();
      }
    } else {
      throw new Error(`Unexpected message: ${JSON.stringify(result)}`);
    }
    client.close();
  });

  it("multiple connections are independent (auth state per-connection)", async () => {
    server.registry.register({
      name: "test.protected",
      requiresAuth: true,
      handler: () => ({ ok: true }),
    });

    const c1 = await connect(server.port);
    const c2 = await connect(server.port);

    // c1 auth, c2 not
    await c1.request("auth", { token: TEST_TOKEN });

    const r1 = await c1.request("test.protected");
    const r2 = await c2.request("test.protected");

    expect(isSuccessResponse(r1)).toBe(true);
    expect(isErrorResponse(r2)).toBe(true);

    c1.close();
    c2.close();
  });

  it("close() disconnects all active connections", async () => {
    const c1 = await connect(server.port);
    const c2 = await connect(server.port);
    expect(server.connections.size).toBe(2);

    const closeWaiters = [
      new Promise<void>((r) => c1.ws.once("close", () => r())),
      new Promise<void>((r) => c2.ws.once("close", () => r())),
    ];
    await server.close();
    await Promise.all(closeWaiters);

    expect(server.connections.size).toBe(0);
  });

  it("server can notify a connection (push event)", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    // 找到对应的 RpcConnection 并发推送
    const conn = [...server.connections][0]!;
    const waiter = client.nextMessage();
    conn.notify("test.event", { foo: "bar" });

    const result = await waiter;
    if (
      result &&
      typeof result === "object" &&
      "kind" in result &&
      (result as { kind: string }).kind === "notification"
    ) {
      const msg = (result as { message: { method: string; params: unknown } }).message;
      expect(msg.method).toBe("test.event");
      expect(msg.params).toEqual({ foo: "bar" });
    } else {
      throw new Error(`Unexpected message: ${JSON.stringify(result)}`);
    }

    client.close();
  });
});
