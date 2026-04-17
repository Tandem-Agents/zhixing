/**
 * RpcClient 集成测试 — 与真实 Server 通信
 *
 * 复用 server.test 同样的测试模式：startServer(port=0) → connect → 调用 → close
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startServer, type ZhixingServerInstance } from "../../server.js";
import { createServerContext } from "../../context.js";
import { DEFAULT_SERVER_CONFIG } from "../../types.js";
import {
  createRpcClient,
  RpcClientError,
  RpcClientClosedError,
  type RpcClient,
} from "../rpc-client.js";

const TEST_TOKEN = "test-token-client";

describe("RpcClient", () => {
  let server: ZhixingServerInstance;
  let client: RpcClient | null = null;

  beforeEach(async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: "0.1.0-test",
      token: TEST_TOKEN,
    });
    server = await startServer({ context: ctx });
  });

  afterEach(async () => {
    if (client && !client.closed) await client.close();
    client = null;
    await server.close();
  });

  function createClient(): RpcClient {
    client = createRpcClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      timeout: 3000,
      connectTimeout: 2000,
    });
    return client;
  }

  // ─── 基本 ───

  it("connect + close lifecycle", async () => {
    const c = createClient();
    expect(c.closed).toBe(false);
    await c.connect();
    await c.close();
    expect(c.closed).toBe(true);
  });

  it("connect rejects on invalid URL", async () => {
    const c = createRpcClient({
      url: "ws://127.0.0.1:1/ws", // port 1 — won't accept
      connectTimeout: 500,
    });
    client = c;
    await expect(c.connect()).rejects.toBeDefined();
  });

  // ─── request ───

  it("request returns success result", async () => {
    const c = createClient();
    await c.connect();
    const result = await c.request<{ status: string }>("health");
    expect(result.status).toBe("ok");
  });

  it("request throws RpcClientError on RPC error", async () => {
    const c = createClient();
    await c.connect();
    await expect(c.request("nonexistent.method")).rejects.toBeInstanceOf(RpcClientError);
    try {
      await c.request("nonexistent.method");
    } catch (err) {
      expect((err as RpcClientError).code).toBe(-32601);
    }
  });

  it("request throws RpcClientError when unauthenticated", async () => {
    server.registry.register({
      name: "test.protected",
      requiresAuth: true,
      handler: () => ({ ok: true }),
    });
    const c = createClient();
    await c.connect();
    await expect(c.request("test.protected")).rejects.toMatchObject({
      code: -32001,
    });
  });

  // ─── authenticate ───

  it("authenticate returns capabilities and unblocks protected methods", async () => {
    server.registry.register({
      name: "test.protected",
      requiresAuth: true,
      handler: () => ({ ok: true }),
    });
    const c = createClient();
    await c.connect();

    const auth = await c.authenticate(TEST_TOKEN, { id: "test", version: "1.0" });
    expect(auth.protocol).toBe(1);
    expect(Array.isArray(auth.capabilities)).toBe(true);

    const result = await c.request<{ ok: boolean }>("test.protected");
    expect(result.ok).toBe(true);
  });

  it("authenticate fails with wrong token", async () => {
    const c = createClient();
    await c.connect();
    await expect(c.authenticate("wrong")).rejects.toMatchObject({ code: -32001 });
  });

  // ─── 通知订阅 ───

  it("onNotification receives matching method only", async () => {
    const c = createClient();
    await c.connect();
    await c.authenticate(TEST_TOKEN);

    const received: unknown[] = [];
    const off = c.onNotification("test.event", (params) => received.push(params));

    // 通过 server 端连接主动 notify
    const conn = [...server.connections][0]!;
    conn.notify("test.event", { x: 1 });
    conn.notify("test.other", { x: 2 });

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ x: 1 }]);

    off();
    conn.notify("test.event", { x: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([{ x: 1 }]); // unchanged after unsubscribe
  });

  it("onAnyNotification receives all notifications", async () => {
    const c = createClient();
    await c.connect();
    await c.authenticate(TEST_TOKEN);

    const received: Array<{ method: string; params: unknown }> = [];
    c.onAnyNotification((method, params) => received.push({ method, params }));

    const conn = [...server.connections][0]!;
    conn.notify("a.event", 1);
    conn.notify("b.event", 2);

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([
      { method: "a.event", params: 1 },
      { method: "b.event", params: 2 },
    ]);
  });

  it("multiple handlers for same method all receive", async () => {
    const c = createClient();
    await c.connect();
    await c.authenticate(TEST_TOKEN);

    const a: unknown[] = [];
    const b: unknown[] = [];
    c.onNotification("test", (p) => a.push(p));
    c.onNotification("test", (p) => b.push(p));

    [...server.connections][0]!.notify("test", { v: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(a).toEqual([{ v: 1 }]);
    expect(b).toEqual([{ v: 1 }]);
  });

  // ─── 错误恢复 ───

  it("pending requests reject when connection closes", async () => {
    const c = createClient();
    await c.connect();

    // Register a slow handler so request is in-flight when we close
    server.registry.register({
      name: "slow.echo",
      requiresAuth: false,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return {};
      },
    });

    // Attach catch handler synchronously to avoid unhandled-rejection during close()
    const settled = c.request("slow.echo").catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 50));

    await c.close();
    const err = await settled;
    expect(err).toBeInstanceOf(RpcClientClosedError);
  });

  it("request after close rejects immediately", async () => {
    const c = createClient();
    await c.connect();
    await c.close();
    await expect(c.request("health")).rejects.toBeInstanceOf(RpcClientClosedError);
  });

  it("close is idempotent", async () => {
    const c = createClient();
    await c.connect();
    await c.close();
    await c.close(); // no throw
  });

  // ─── 超时 ───

  it("request rejects on timeout", async () => {
    server.registry.register({
      name: "slow",
      requiresAuth: false,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return {};
      },
    });
    const c = createRpcClient({
      url: `ws://127.0.0.1:${server.port}/ws`,
      timeout: 200,
    });
    client = c;
    await c.connect();
    await expect(c.request("slow")).rejects.toThrow(/timeout/i);
  });

  // ─── 并发请求 ───

  it("handles concurrent requests with correct id-routing", async () => {
    server.registry.register({
      name: "echo",
      requiresAuth: false,
      handler: async (params) => {
        const p = params as { delay?: number; value: unknown };
        if (p.delay) await new Promise((r) => setTimeout(r, p.delay));
        return p.value;
      },
    });

    const c = createClient();
    await c.connect();

    const results = await Promise.all([
      c.request("echo", { delay: 50, value: "a" }),
      c.request("echo", { delay: 10, value: "b" }),
      c.request("echo", { delay: 30, value: "c" }),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
