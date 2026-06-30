/**
 * 带外事件投影与组播契约。
 *
 * forwarder:UI 订阅集白名单(集外事件不上 wire)、大 payload 裁剪
 * (llm:request_start 摘要、segment:new_started 去 windowCompact)、
 * seq 单调、meta 携 lineage / turnOrigin、无对话身份 no-op、dispose 解除订阅。
 *
 * broadcast:observer 内容组播按名册过滤连接;activity 工作台提示排除当前 observer。
 */

import { describe, expect, it, vi } from "vitest";
import { createEventBus, type AgentEventMap } from "@zhixing/core";
import {
  createRunEventForwarder,
  type SessionEventEnvelope,
} from "../session-events.js";
import {
  createActivityBroadcast,
  createObserverBroadcast,
} from "../session-broadcast.js";
import type { RpcConnection } from "../connection.js";
import type { ConversationManager } from "../../runtime/conversation-manager.js";

function makeBus() {
  return createEventBus<AgentEventMap>({ lineage: "main" });
}

const TURN_CONTEXT = {
  turnId: "turn-1",
  turnOrigin: { channel: "rpc", triggeredBy: "7" },
} as never;

function collectEnvelopes() {
  const out: SessionEventEnvelope[] = [];
  const forwarder = createRunEventForwarder((_cid, env) => out.push(env));
  return { out, forwarder };
}

describe("createRunEventForwarder", () => {
  it("UI 订阅集内事件上 wire:信封携对话/run 身份、seq 单调、meta 带 lineage 与 turnOrigin", () => {
    const bus = makeBus();
    const { out, forwarder } = collectEnvelopes();
    const dispose = forwarder({ bus, conversationId: "c1", turnContext: TURN_CONTEXT });

    bus.emit("retry:attempt", { attempt: 1, maxAttempts: 3, delayMs: 100, reason: "x" } as never);
    bus.emit("interrupt:warn", {} as never);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      conversationId: "c1",
      scope: "run",
      runId: "turn-1",
      seq: 0,
      event: "retry:attempt",
      meta: { lineage: "main", turnOrigin: { channel: "rpc", triggeredBy: "7" } },
    });
    expect(out[1]!.seq).toBe(1);
    dispose();
  });

  it("白名单外事件不上 wire(llm:stream_event / tool:call_start / workmode 意图)", () => {
    const bus = makeBus();
    const { out, forwarder } = collectEnvelopes();
    forwarder({ bus, conversationId: "c1", turnContext: TURN_CONTEXT });

    bus.emit("llm:stream_event", { type: "x" } as never);
    bus.emit("tool:call_start", { id: "t1", name: "read", input: {} } as never);
    bus.emit("workmode:switch_requested", { kind: "exit" } as never);

    expect(out).toHaveLength(0);
  });

  it("大 payload 裁剪:llm:request_start 只投摘要字段,segment:new_started 去 windowCompact", () => {
    const bus = makeBus();
    const { out, forwarder } = collectEnvelopes();
    forwarder({ bus, conversationId: "c1", turnContext: TURN_CONTEXT });

    bus.emit("llm:request_start", {
      model: "m1",
      messageCount: 9,
      hasTools: true,
      systemPrompt: "巨大的系统提示词",
      messages: [{ role: "user", content: [] }],
      tools: [{ name: "read" }],
    } as never);
    bus.emit("segment:new_started", {
      segmentId: "seg-1",
      bufferTurns: 2,
      tokensBefore: 1000,
      tokensAfter: 100,
      windowCompact: { summary: "全文", pairsCompacted: 3, tokensBefore: 1000, tokensAfter: 100 },
    } as never);

    expect(out[0]!.payload).toEqual({ model: "m1", messageCount: 9, hasTools: true });
    expect(out[1]!.payload).toEqual({
      segmentId: "seg-1",
      bufferTurns: 2,
      tokensBefore: 1000,
      tokensAfter: 100,
    });
  });

  it("无对话身份(ephemeral / 测试裸跑)不转发;dispose 解除订阅", () => {
    const bus = makeBus();
    const { out, forwarder } = collectEnvelopes();

    const disposeNoCid = forwarder({ bus });
    bus.emit("retry:attempt", { attempt: 1 } as never);
    expect(out).toHaveLength(0);
    disposeNoCid();

    const dispose = forwarder({ bus, conversationId: "c1" });
    bus.emit("retry:attempt", { attempt: 1 } as never);
    expect(out).toHaveLength(1);
    dispose();
    bus.emit("retry:attempt", { attempt: 2 } as never);
    expect(out).toHaveLength(1); // dispose 后不再转发
  });

  it("子 agent 冒泡事件保留子 lineage——渲染层区分主/子帧的依据", () => {
    const parent = makeBus();
    const child = createEventBus<AgentEventMap>({
      parent,
      lineage: "main/sub-abc123",
    });
    const { out, forwarder } = collectEnvelopes();
    forwarder({ bus: parent, conversationId: "c1" });

    child.emit("retry:attempt", { attempt: 1 } as never);

    expect(out).toHaveLength(1);
    expect(out[0]!.meta.lineage).toBe("main/sub-abc123");
  });
});

describe("createObserverBroadcast", () => {
  function makeConn(id: string, opts?: { authenticated?: boolean; closed?: boolean }) {
    return {
      id,
      authenticated: opts?.authenticated ?? true,
      closed: opts?.closed ?? false,
      notify: vi.fn(),
    } as unknown as RpcConnection & { notify: ReturnType<typeof vi.fn> };
  }

  it("按 observer 名册过滤:名册内已认证活跃连接收,其余不收", () => {
    const a = makeConn("1");
    const b = makeConn("2");
    const outside = makeConn("3");
    const unauthed = makeConn("4", { authenticated: false });
    const closed = makeConn("5", { closed: true });
    const manager = {
      getObserverConnectionIds: (cid: string) =>
        cid === "c1" ? new Set(["1", "2", "4", "5"]) : new Set(),
    } as unknown as ConversationManager;

    const broadcast = createObserverBroadcast({
      connections: new Set([a, b, outside, unauthed, closed]),
      manager,
    });
    broadcast("c1", "session.delta", { x: 1 });

    expect(a.notify).toHaveBeenCalledWith("session.delta", { x: 1 });
    expect(b.notify).toHaveBeenCalledWith("session.delta", { x: 1 });
    expect(outside.notify).not.toHaveBeenCalled();
    expect(unauthed.notify).not.toHaveBeenCalled();
    expect(closed.notify).not.toHaveBeenCalled();
  });
});

describe("createActivityBroadcast", () => {
  function makeConn(id: string, opts?: { authenticated?: boolean; closed?: boolean }) {
    return {
      id,
      authenticated: opts?.authenticated ?? true,
      closed: opts?.closed ?? false,
      notify: vi.fn(),
    } as unknown as RpcConnection & { notify: ReturnType<typeof vi.fn> };
  }

  it("只通知非当前 observer 的已认证活跃连接", () => {
    const currentObserver = makeConn("1");
    const otherWorkbench = makeConn("2");
    const unauthed = makeConn("3", { authenticated: false });
    const closed = makeConn("4", { closed: true });
    const manager = {
      getObserverConnectionIds: (cid: string) =>
        cid === "c1" ? new Set(["1"]) : new Set(),
    } as unknown as ConversationManager;

    const broadcast = createActivityBroadcast({
      connections: new Set([currentObserver, otherWorkbench, unauthed, closed]),
      manager,
    });
    const payload = {
      conversationId: "c1",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    };
    broadcast(payload);

    expect(currentObserver.notify).not.toHaveBeenCalled();
    expect(otherWorkbench.notify).toHaveBeenCalledWith(
      "session.activity",
      payload,
    );
    expect(unauthed.notify).not.toHaveBeenCalled();
    expect(closed.notify).not.toHaveBeenCalled();
  });
});
