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

  it("auth with correct token succeeds and returns capabilities", async () => {
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
      const result = response.result as { capabilities: string[] };
      expect(result.capabilities).toContain("session");
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
