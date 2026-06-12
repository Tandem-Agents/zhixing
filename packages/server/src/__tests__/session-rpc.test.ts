/**
 * S2.D 集成测试：session.* RPC 方法 + delta/complete 推送
 *
 * 用 mock RuntimeFactory（不依赖真实 LLM）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket from "ws";
import type { AgentResult, AgentYield, Message, RunResult } from "@zhixing/core";
import { startServer, type ZhixingServerInstance } from "../server.js";
import { createServerContext } from "../context.js";
import { ConversationManager } from "../runtime/conversation-manager.js";
import type { ConversationBootstrap, SessionRuntime, RuntimeFactory } from "../runtime/types.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import {
  encodeRequest,
  parseMessage,
  RPC_ERROR_CODES,
  type JsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
} from "../rpc/protocol.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-session";

// ─── Mock runtime ───

interface MockOptions {
  /** 推送的 delta 数量（默认 2） */
  deltaCount?: number;
  /** run 抛出异常 */
  throwError?: string;
  /** 每个 yield 的延迟（ms） */
  yieldDelayMs?: number;
  /** RunResult 顶层携带的模式切换意图(complete 通知附带契约的驱动源) */
  pendingModeSwitch?: RunResult["pendingModeSwitch"];
}

function createMockRuntime(
  sessionId: string,
  opts: MockOptions = {},
): SessionRuntime {
  let aborted = false;

  return {
    sessionId,
    // 纯执行体:输入消息由调用方构造(窗口归 ManagedSession),mock 取末条回声
    async *run(messages): AsyncGenerator<AgentYield, RunResult> {
      const userMsg: Message =
        messages[messages.length - 1] ?? { role: "user", content: [] };
      const block = userMsg.content[0];
      const text = block && block.type === "text" ? block.text : "";
      if (opts.throwError) {
        throw new Error(opts.throwError);
      }

      const count = opts.deltaCount ?? 2;
      for (let i = 0; i < count; i++) {
        if (aborted) break;
        if (opts.yieldDelayMs) await sleep(opts.yieldDelayMs);
        yield { type: "text_delta", text: `chunk-${i}` };
      }

      const reply: Message = {
        role: "assistant",
        content: [{ type: "text", text: `echo:${text}` }],
      };
      yield { type: "turn_complete", turnCount: 1, usage: { inputTokens: 5, outputTokens: 5 } };

      return {
        agentResult: {
          reason: "completed",
          message: reply,
          usage: { inputTokens: 5, outputTokens: 5 },
        },
        runRecord: {
          timestamp: new Date().toISOString(),
          messages: [userMsg, reply],
          usage: { inputTokens: 5, outputTokens: 5 },
        },
        newMessages: [reply],
        durationMs: 0,
        ...(opts.pendingModeSwitch
          ? { pendingModeSwitch: opts.pendingModeSwitch }
          : {}),
      };
    },
    abort(): boolean {
      aborted = true;
      return true;
    },
    async dispose() {},
  };
}

function createMockFactory(opts: MockOptions = {}): RuntimeFactory {
  return {
    async create(sessionId) {
      return createMockRuntime(sessionId, opts);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 客户端辅助 ───

interface RpcClient {
  ws: WebSocket;
  request(method: string, params?: unknown): Promise<JsonRpcResponse>;
  /** 等待匹配条件的下一条通知（含已缓存的） */
  waitNotification(method: string, timeoutMs?: number): Promise<{ method: string; params: unknown }>;
  close(): void;
}

async function connect(port: number): Promise<RpcClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 0;
  const pending = new Map<string | number, (msg: JsonRpcResponse) => void>();
  const notificationQueue: Array<{ method: string; params: unknown }> = [];
  const notificationWaiters: Array<{
    predicate: (n: { method: string; params: unknown }) => boolean;
    resolve: (n: { method: string; params: unknown }) => void;
  }> = [];

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
        }
      }
    } else if (parsed.kind === "notification") {
      const notif = { method: parsed.message.method, params: parsed.message.params };
      const waiterIdx = notificationWaiters.findIndex((w) => w.predicate(notif));
      if (waiterIdx >= 0) {
        const w = notificationWaiters.splice(waiterIdx, 1)[0]!;
        w.resolve(notif);
      } else {
        notificationQueue.push(notif);
      }
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
    waitNotification(method, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const predicate = (n: { method: string; params: unknown }) => n.method === method;
        const idx = notificationQueue.findIndex(predicate);
        if (idx >= 0) {
          resolve(notificationQueue.splice(idx, 1)[0]!);
          return;
        }
        const timer = setTimeout(() => {
          const wIdx = notificationWaiters.findIndex((w) => w.predicate === predicate);
          if (wIdx >= 0) notificationWaiters.splice(wIdx, 1);
          reject(new Error(`Timeout waiting for notification: ${method}`));
        }, timeoutMs);
        notificationWaiters.push({
          predicate,
          resolve: (n) => {
            clearTimeout(timer);
            resolve(n);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

// ─── 测试 ───

describe("session.* RPC (S2.D)", () => {
  let server: ZhixingServerInstance;

  // 默认 appendRun mock：按 conversation 自增 runIndex 并记录追加的原文
  // （窗口经 acceptRun 接受协议自行前进，session.history RPC 返回的是窗口投影）。
  //
  // 不关心持久化具体形态的测试（测 routing / abort / pending queue 等）通过此默认 cb 就够；
  // 需要断言持久化副作用的测试仍可覆盖式传自己的 appendRun。
  const recordsByConversation = new Map<string, unknown[]>();

  async function startWithFactory(factory: RuntimeFactory): Promise<void> {
    recordsByConversation.clear();
    const conversations = new ConversationManager(factory, {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (conversationId, record) => {
        const prev = recordsByConversation.get(conversationId) ?? [];
        recordsByConversation.set(conversationId, [...prev, record]);
        return { runIndex: prev.length, shardId: "000001" };
      },
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
    });
    server = await startServer({ context: ctx });
  }

  afterEach(async () => {
    if (server) await server.close();
  });

  // ─── auth 报告 session capability ───

  it("auth reports 'session' capability when conversations manager is present", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    const r = await client.request("auth", { token: TEST_TOKEN });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      const result = r.result as { capabilities: string[] };
      expect(result.capabilities).toContain("session");
    }
    client.close();
  });

  // ─── session.send ───

  it("session.send returns sessionId and pushes delta + complete", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 3 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "hi" });
    expect(isSuccessResponse(sendResp)).toBe(true);
    const sessionId = (sendResp as { result: { sessionId: string } }).result.sessionId;
    expect(sessionId).toMatch(/^conv_/);

    // 收 deltas + turn_complete + complete
    const deltas: unknown[] = [];
    while (deltas.length < 4) {
      const n = await client.waitNotification("session.delta");
      deltas.push(n.params);
    }
    expect(deltas).toHaveLength(4); // 3 text_delta + 1 turn_complete

    const complete = await client.waitNotification("session.complete");
    const completeParams = complete.params as {
      sessionId: string;
      result: AgentResult;
      pendingModeSwitch?: unknown;
    };
    expect(completeParams.sessionId).toBe(sessionId);
    expect(completeParams.result.reason).toBe("completed");
    // 无模式切换意图时不附带字段
    expect(completeParams.pendingModeSwitch).toBeUndefined();

    client.close();
  });

  it("session.complete 顶层附带 pendingModeSwitch(turn 内进出场景意图,跟随权归发起接入面)", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        pendingModeSwitch: { kind: "enter", sceneId: "scene-1" },
      }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "go" });
    const complete = await client.waitNotification("session.complete");
    const params = complete.params as { pendingModeSwitch?: unknown };
    expect(params.pendingModeSwitch).toEqual({ kind: "enter", sceneId: "scene-1" });

    client.close();
  });

  it("session.send rejects empty text", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", { text: "" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("session.send with existing sessionId reuses runtime", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", { text: "first" });
    const id1 = (r1 as { result: { sessionId: string } }).result.sessionId;
    await client.waitNotification("session.complete");

    const r2 = await client.request("session.send", { text: "second", sessionId: id1 });
    const id2 = (r2 as { result: { sessionId: string } }).result.sessionId;
    expect(id2).toBe(id1);
    await client.waitNotification("session.complete");

    const list = await client.request("session.list");
    if (isSuccessResponse(list)) {
      const runtimes = list.result as Array<{ sessionId: string; messageCount: number }>;
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]!.messageCount).toBe(4); // 2 turns × (user + assistant)
    }

    client.close();
  });

  it("error in runtime.run is reported via session.complete with error reason", async () => {
    await startWithFactory(createMockFactory({ throwError: "boom" }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "trigger error" });
    const complete = await client.waitNotification("session.complete");
    const result = (complete.params as { result: AgentResult }).result;
    expect(result.reason).toBe("error");
    if (result.reason === "error") {
      expect(result.error.message).toBe("boom");
    }

    client.close();
  });

  // ─── session.list ───

  it("session.list returns empty initially", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.list");
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual([]);
    }
    client.close();
  });

  it("session.list reflects busy=true during run", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 2, yieldDelayMs: 50 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "slow" });
    // Should be busy now (run still streaming)
    const listBusy = await client.request("session.list");
    if (isSuccessResponse(listBusy)) {
      const runtimes = listBusy.result as Array<{ busy: boolean }>;
      expect(runtimes[0]!.busy).toBe(true);
    }

    await client.waitNotification("session.complete");

    // After complete, busy should be false
    const listIdle = await client.request("session.list");
    if (isSuccessResponse(listIdle)) {
      const runtimes = listIdle.result as Array<{ busy: boolean }>;
      expect(runtimes[0]!.busy).toBe(false);
    }

    client.close();
  });

  // ─── session.history ───

  it("session.history returns the message list", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "hello" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result.sessionId;
    await client.waitNotification("session.complete");

    const r = await client.request("session.history", { sessionId });
    if (isSuccessResponse(r)) {
      const messages = r.result as Message[];
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("user");
      expect(messages[1]!.role).toBe("assistant");
    }
    client.close();
  });

  it("session.history returns NOT_FOUND for unknown sessionId", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.history", { sessionId: "nope" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    client.close();
  });

  // ─── session.delete ───

  it("session.delete removes runtime", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "x" });
    const sessionId = (sendResp as { result: { sessionId: string } }).result.sessionId;
    await client.waitNotification("session.complete");

    await client.request("session.delete", { sessionId });
    const list = await client.request("session.list");
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual([]);
    }
    client.close();
  });

  // ─── 并发互斥 (PendingQueue) ───

  it("concurrent sends to same conversation are serialized", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1, yieldDelayMs: 50 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", { text: "first" });
    const convId = (r1 as { result: { conversationId: string } }).result.conversationId;

    const r2 = await client.request("session.send", { text: "second", conversationId: convId });
    expect(isSuccessResponse(r2)).toBe(true);

    const c1 = await client.waitNotification("session.complete");
    const c1Result = (c1.params as { result: { reason: string } }).result;
    expect(c1Result.reason).toBe("completed");

    const c2 = await client.waitNotification("session.complete");
    const c2Result = (c2.params as { result: { reason: string } }).result;
    expect(c2Result.reason).toBe("completed");

    const list = await client.request("session.list");
    if (isSuccessResponse(list)) {
      const runtimes = list.result as Array<{ messageCount: number; pendingCount: number }>;
      expect(runtimes[0]!.messageCount).toBe(4);
      expect(runtimes[0]!.pendingCount).toBe(0);
    }

    client.close();
  });

  it("session.send returns BUSY when queue is full", async () => {
    const conversations = new ConversationManager(createMockFactory({ deltaCount: 1, yieldDelayMs: 200 }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
      maxPending: 2,
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r1 = await client.request("session.send", { text: "running" });
    const convId = (r1 as { result: { conversationId: string } }).result.conversationId;

    await client.request("session.send", { text: "queued-1", conversationId: convId });
    await client.request("session.send", { text: "queued-2", conversationId: convId });

    const r4 = await client.request("session.send", { text: "overflow", conversationId: convId });
    expect(isErrorResponse(r4)).toBe(true);
    if (isErrorResponse(r4)) {
      expect(r4.error.code).toBe(RPC_ERROR_CODES.BUSY);
    }

    for (let i = 0; i < 3; i++) {
      await client.waitNotification("session.complete", 5000);
    }
    client.close();
  });

  // ─── 配置缺失场景 ───

  it("session.send returns INTERNAL_ERROR when conversations manager is missing", async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      // conversations intentionally omitted
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.send", { text: "hi" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
    }
    client.close();
  });

  // ─── TranscriptStore 集成 (Step 7b) ───

  it("completed turn is persisted via ConversationManager.recordTurn", async () => {
    const appendedRecords: Array<{ conversationId: string; record: { messages: Message[] } }> = [];

    const conversations = new ConversationManager(createMockFactory({ deltaCount: 1 }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (conversationId, record) => {
        appendedRecords.push({ conversationId, record: { messages: [...record.messages] } });
        return { runIndex: appendedRecords.length - 1, shardId: "000001" };
      },
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "persist me" });
    const convId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    await sleep(50);

    expect(appendedRecords).toHaveLength(1);
    expect(appendedRecords[0]!.conversationId).toBe(convId);
    const { messages } = appendedRecords[0]!.record;
    expect(messages[0]!.role).toBe("user");
    expect(messages[messages.length - 1]!.role).toBe("assistant");

    client.close();
  });

  it("error turn is NOT persisted via ConversationManager.recordTurn", async () => {
    const appendedRecords: unknown[] = [];

    const conversations = new ConversationManager(createMockFactory({ throwError: "kaboom" }), {
      graceTimeoutMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      idleCheckIntervalMs: 999_999,
    }, {
      appendRun: async (_cid, record) => {
        appendedRecords.push(record);
        return { runIndex: appendedRecords.length - 1, shardId: "000001" };
      },
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "will error" });
    await client.waitNotification("session.complete");
    await sleep(50);

    expect(appendedRecords).toHaveLength(0);
    client.close();
  });

  it("loadHistory restores history on getOrCreate（启动装填对进窗口）", async () => {
    const restored: ConversationBootstrap = {
      bootstrap: [
        { role: "user", content: [{ type: "text", text: "previous question" }] },
        { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
      ],
      turnCount: 1,
    };

    const loadHistory = async (conversationId: string) => {
      if (conversationId === "conv_restored") return restored;
      return undefined;
    };

    const conversations = new ConversationManager(
      createMockFactory({ deltaCount: 1 }),
      { graceTimeoutMs: 60_000, idleTimeoutMs: 30 * 60_000, idleCheckIntervalMs: 999_999 },
      {
        loadHistory,
        appendRun: async () => ({ runIndex: 1, shardId: "000001" }),
      },
    );
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      conversations,
    });
    server = await startServer({ context: ctx });
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "follow up", conversationId: "conv_restored" });
    expect(isSuccessResponse(sendResp)).toBe(true);
    await client.waitNotification("session.complete");

    const histResp = await client.request("session.history", { conversationId: "conv_restored" });
    if (isSuccessResponse(histResp)) {
      const messages = histResp.result as Message[];
      expect(messages.length).toBeGreaterThanOrEqual(4);
      expect(messages[0]!.role).toBe("user");
      expect((messages[0]!.content[0] as { text: string }).text).toBe("previous question");
    }
    client.close();
  });
});
