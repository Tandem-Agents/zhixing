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

/**
 * 内存版对话目录——以 appendRun 收集的记录为"盘上事实":有 run 即在清单,
 * 倒读按追加序逆序分页。rename/remove 维护内存 meta 覆盖层。
 */
function createMemoryDirectory(
  records: Map<string, unknown[]>,
): import("../runtime/conversation-directory.js").ConversationDirectory {
  const names = new Map<string, string>();
  const removed = new Set<string>();
  const exists = (id: string) =>
    !removed.has(id) && (records.has(id) || names.has(id));
  return {
    async list() {
      const now = new Date().toISOString();
      return [...records.keys()]
        .filter((id) => !removed.has(id))
        .map((id) => ({
          id,
          name: names.get(id) ?? id,
          createdAt: now,
          lastActiveAt: now,
          isDefault: false,
          archived: false,
        })) as never;
    },
    async rename(id, name) {
      if (!exists(id)) return null;
      names.set(id, name);
      const now = new Date().toISOString();
      return {
        id,
        name,
        createdAt: now,
        lastActiveAt: now,
        isDefault: false,
        archived: false,
      } as never;
    },
    async remove(id) {
      if (!exists(id)) return false;
      removed.add(id);
      return true;
    },
    async readRunsReverse(id, opts) {
      const all = (records.get(id) ?? []) as Array<{ messages: unknown }>;
      const reversed = all
        .map((record, runIndex) => ({
          record: { ...record, runIndex } as never,
          shardId: "000001",
        }))
        .reverse();
      const start = opts.before
        ? reversed.findIndex(
            (r) => (r.record as { runIndex: number }).runIndex < opts.before!.runIndex,
          )
        : 0;
      const slice = start < 0 ? [] : reversed.slice(start);
      return {
        runs: slice.slice(0, opts.limit),
        hasMore: slice.length > opts.limit,
      };
    },
  };
}

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
      conversationDirectory: createMemoryDirectory(recordsByConversation),
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

  it("模式切换意图经 session.modeSwitchIntent 定向发起连接,先于 complete;complete 纯结果不带意图", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        pendingModeSwitch: { kind: "enter", sceneId: "scene-1" },
      }),
    );
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    await client.request("session.send", { text: "go" });
    const intent = await client.waitNotification("session.modeSwitchIntent");
    expect((intent.params as { intent: unknown }).intent).toEqual({
      kind: "enter",
      sceneId: "scene-1",
    });
    const complete = await client.waitNotification("session.complete");
    expect(
      (complete.params as { pendingModeSwitch?: unknown }).pendingModeSwitch,
    ).toBeUndefined();

    client.close();
  });

  it("控制意图不组播:旁观 observer 收 complete 但物理收不到 modeSwitchIntent", async () => {
    await startWithFactory(
      createMockFactory({
        deltaCount: 1,
        pendingModeSwitch: { kind: "enter", sceneId: "scene-1" },
      }),
    );
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    const first = await alice.request("session.send", { text: "round-1" });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await alice.waitNotification("session.modeSwitchIntent");
    await alice.waitNotification("session.complete");

    await bob.request("session.subscribe", { conversationId });
    await alice.request("session.send", { text: "round-2", conversationId });

    // 旁观端:收到组播 complete(纯结果),但意图通知不可达
    const bobComplete = await bob.waitNotification("session.complete");
    expect(
      (bobComplete.params as { pendingModeSwitch?: unknown }).pendingModeSwitch,
    ).toBeUndefined();
    await expect(
      bob.waitNotification("session.modeSwitchIntent", 300),
    ).rejects.toThrow();
    // 发起端照常定向收到
    await alice.waitNotification("session.modeSwitchIntent");

    alice.close();
    bob.close();
  });

  it("组播:第二连接 subscribe 后同看流式 turn(delta + complete),unsubscribe 停收;delete 组播 session.changed", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const alice = await connect(server.port);
    const bob = await connect(server.port);
    await alice.request("auth", { token: TEST_TOKEN });
    await bob.request("auth", { token: TEST_TOKEN });

    // alice 开启对话
    const first = await alice.request("session.send", { text: "round-1" });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await alice.waitNotification("session.complete");

    // bob 订阅(observer 登记)→ 同看 alice 发起的下一个 turn
    const sub = await bob.request("session.subscribe", { conversationId });
    expect(isSuccessResponse(sub) && (sub.result as { subscribed: boolean }).subscribed).toBe(true);

    await alice.request("session.send", { text: "round-2", conversationId });
    const bobDelta = await bob.waitNotification("session.delta");
    expect((bobDelta.params as { conversationId: string }).conversationId).toBe(conversationId);
    const bobComplete = await bob.waitNotification("session.complete");
    expect((bobComplete.params as { result: AgentResult }).result.reason).toBe("completed");
    // 发起端照常收到(发起者在名册内)
    await alice.waitNotification("session.complete");

    // unsubscribe 后 bob 不再收;delete 前的 changed 只发给在册 observer(alice)
    await bob.request("session.unsubscribe", { conversationId });
    await alice.request("session.delete", { conversationId });
    const changed = await alice.waitNotification("session.changed");
    expect(changed.params).toEqual({ conversationId, change: "deleted" });

    alice.close();
    bob.close();
  });

  it("session.subscribe 对不活跃会话返回 subscribed:false", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const r = await client.request("session.subscribe", { conversationId: "ghost" });
    expect(isSuccessResponse(r) && (r.result as { subscribed: boolean }).subscribed).toBe(false);
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
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      const { conversations } = list.result as { conversations: Array<{ conversationId: string }> };
      expect(conversations).toHaveLength(1);
      expect(conversations[0]!.conversationId).toBe(id1);
    }
    // 两轮 turn 各落一条 run record(同一运行时复用)
    expect(recordsByConversation.get(id1)).toHaveLength(2);

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

  it("session.list:盘上空 → 空清单(纯内存 ephemeral 不进列表)", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.list");
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ conversations: [] });
    }
    client.close();
  });

  it("session.list:盘上全量叠加活跃态(busy 随 turn 起落)", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 2, yieldDelayMs: 50 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    // 先完成一轮(落盘进清单),再发慢速第二轮观测 busy
    const first = await client.request("session.send", { text: "warm" });
    const conversationId = (first as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    await client.request("session.send", { text: "slow", conversationId });
    const listBusy = await client.request("session.list");
    expect(isSuccessResponse(listBusy)).toBe(true);
    if (isSuccessResponse(listBusy)) {
      const { conversations } = listBusy.result as {
        conversations: Array<{ conversationId: string; active: boolean; busy: boolean }>;
      };
      const entry = conversations.find((c) => c.conversationId === conversationId)!;
      expect(entry.active).toBe(true);
      expect(entry.busy).toBe(true);
    }

    await client.waitNotification("session.complete");
    const listIdle = await client.request("session.list");
    if (isSuccessResponse(listIdle)) {
      const { conversations } = listIdle.result as {
        conversations: Array<{ conversationId: string; busy: boolean }>;
      };
      expect(conversations.find((c) => c.conversationId === conversationId)!.busy).toBe(false);
    }

    client.close();
  });

  // ─── session.history ───

  it("session.history:倒读落盘事实流(新→旧),不要求会话活跃", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "round-1" });
    const conversationId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");
    await client.request("session.send", { text: "round-2", conversationId });
    await client.waitNotification("session.complete");

    const r = await client.request("session.history", { conversationId, limit: 1 });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      const page = r.result as {
        runs: Array<{ record: { messages: Message[] } }>;
        hasMore: boolean;
      };
      // 倒读:首页是最新一轮;更早内容 hasMore
      expect(page.runs).toHaveLength(1);
      const block = page.runs[0]!.record.messages[0]!.content[0]!;
      expect(block.type === "text" && block.text).toBe("round-2");
      expect(page.hasMore).toBe(true);
    }
    client.close();
  });

  it("session.history:未知对话产出空页(读容错),不抛 NOT_FOUND", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("session.history", { conversationId: "nope" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ runs: [], hasMore: false });
    }
    client.close();
  });

  // ─── session.rename ───

  it("session.rename:改名并组播 session.changed{renamed};未知对话 NOT_FOUND", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const sendResp = await client.request("session.send", { text: "hi" });
    const conversationId = (sendResp as { result: { conversationId: string } }).result.conversationId;
    await client.waitNotification("session.complete");

    const r = await client.request("session.rename", { conversationId, name: "新名字" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual({ conversationId, name: "新名字" });
    }
    const changed = await client.waitNotification("session.changed");
    expect(changed.params).toEqual({ conversationId, change: "renamed", name: "新名字" });

    const missing = await client.request("session.rename", { conversationId: "nope", name: "x" });
    expect(isErrorResponse(missing)).toBe(true);
    if (isErrorResponse(missing)) {
      expect(missing.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    client.close();
  });

  it("session.rename 对场景对话保持全域键(目录返回库内身份,RPC 层不丢 ws: 前缀)", async () => {
    await startWithFactory(createMockFactory({ deltaCount: 1 }));
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    // 让 ws: 形对话进入内存目录的"盘上事实"(发一轮 turn 落 record)
    const wsId = "ws:scene-1:conv_abc";
    await client.request("session.send", { text: "hi", conversationId: wsId });
    await client.waitNotification("session.complete");

    const r = await client.request("session.rename", { conversationId: wsId, name: "场景对话名" });
    expect(isSuccessResponse(r)).toBe(true);
    if (isSuccessResponse(r)) {
      expect((r.result as { conversationId: string }).conversationId).toBe(wsId);
    }
    client.close();
  });

  it("session.history 拒绝坏 limit / 坏 before(无界读取与分页失真在边界 fail-fast)", async () => {
    await startWithFactory(createMockFactory());
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    for (const limit of ["20", 0, -1, 1.5] as unknown[]) {
      const r = await client.request("session.history", { conversationId: "c", limit });
      expect(isErrorResponse(r)).toBe(true);
      if (isErrorResponse(r)) {
        expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
      }
    }
    const badBefore = await client.request("session.history", {
      conversationId: "c",
      before: { shardId: 1, runIndex: "x" },
    });
    expect(isErrorResponse(badBefore)).toBe(true);
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
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual({ conversations: [] });
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
    expect(isSuccessResponse(list)).toBe(true);
    if (isSuccessResponse(list)) {
      const { conversations } = list.result as {
        conversations: Array<{ pendingCount: number }>;
      };
      expect(conversations[0]!.pendingCount).toBe(0);
    }
    // 串行执行:两轮各落一条 run record
    expect(recordsByConversation.get(convId)).toHaveLength(2);

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

    // 装填对已进窗口:本轮 run 输入 = [装填对..., 新用户消息],mock 取末条回声;
    // turnCount 从装填值续延(turnIndex 链路)。窗口投影的细粒度断言由
    // conversation-manager / 同形性测试覆盖,此处锁端到端链路打通。
    const session = conversations.getSession("conv_restored")!;
    expect(session.turnCount).toBe(2); // 装填 1 + 本轮 1
    expect(conversations.getHistory("conv_restored")!.length).toBeGreaterThanOrEqual(4);
    client.close();
  });
});
