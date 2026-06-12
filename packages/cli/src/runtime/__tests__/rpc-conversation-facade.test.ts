/**
 * RpcConversationFacade —— 方法 → RPC (method, params) 映射与返回还原、
 * 通知订阅还原(payload 原样、含 conversationId 供调用方过滤)。
 */

import { describe, it, expect } from "vitest";
import type { SessionDeltaPayload, SessionChangedPayload } from "@zhixing/server";
import { RpcConversationFacade } from "../rpc-conversation-facade.js";
import { makeFakeHostLink } from "./fake-host-link.js";

describe("RpcConversationFacade · 方法域", () => {
  it("send 携带 text 与可选 conversationId,返回宿主分配的会话身份", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => ({ conversationId: "conv-1", sessionId: "conv-1" }));
    const facade = new RpcConversationFacade(fake.link);

    const result = await facade.send("你好", "conv-1");
    expect(result.conversationId).toBe("conv-1");
    expect(fake.requests).toEqual([
      {
        method: "session.send",
        params: { text: "你好", conversationId: "conv-1" },
      },
    ]);
  });

  it("list 还原 conversations 数组", async () => {
    const fake = makeFakeHostLink();
    const entry = {
      conversationId: "conv-1",
      name: "默认对话",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-02T00:00:00.000Z",
      active: true,
      busy: false,
      observerCount: 1,
      pendingCount: 0,
    };
    fake.setResponder(() => ({ conversations: [entry] }));
    const facade = new RpcConversationFacade(fake.link);

    expect(await facade.list()).toEqual([entry]);
    expect(fake.requests[0]?.method).toBe("session.list");
  });

  it("history 透传 limit / before 游标", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => ({ runs: [], hasMore: false }));
    const facade = new RpcConversationFacade(fake.link);

    const page = await facade.history("conv-1", {
      limit: 5,
      before: { shardId: "s1", runIndex: 3 },
    });
    expect(page).toEqual({ runs: [], hasMore: false });
    expect(fake.requests).toEqual([
      {
        method: "session.history",
        params: {
          conversationId: "conv-1",
          limit: 5,
          before: { shardId: "s1", runIndex: 3 },
        },
      },
    ]);
  });

  it("rename / delete / abort / subscribe / unsubscribe 的方法名与参数", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "session.rename"
        ? { conversationId: "ws:scene-1:conv-9", name: "新名" }
        : method === "session.subscribe"
          ? { subscribed: true }
          : {},
    );
    const facade = new RpcConversationFacade(fake.link);

    // rename 返回保持入参全域键(ws: 前缀)——宿主契约,facade 原样透传
    const renamed = await facade.rename("ws:scene-1:conv-9", "新名");
    expect(renamed.conversationId).toBe("ws:scene-1:conv-9");

    await facade.delete("conv-1");
    await facade.abort("conv-1");
    expect(await facade.subscribe("conv-1")).toBe(true);
    await facade.unsubscribe("conv-1");

    expect(fake.requests.map((r) => r.method)).toEqual([
      "session.rename",
      "session.delete",
      "session.abort",
      "session.subscribe",
      "session.unsubscribe",
    ]);
    expect(fake.requests[1]?.params).toEqual({ conversationId: "conv-1" });
  });
});

describe("RpcConversationFacade · 通知还原", () => {
  it("onDelta / onComplete / onChanged / onModeSwitchIntent 收到原样 payload", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcConversationFacade(fake.link);

    const deltas: SessionDeltaPayload[] = [];
    const changes: SessionChangedPayload[] = [];
    const completes: unknown[] = [];
    const intents: unknown[] = [];
    facade.onDelta((p) => deltas.push(p));
    facade.onComplete((p) => completes.push(p));
    facade.onChanged((p) => changes.push(p));
    facade.onModeSwitchIntent((p) => intents.push(p));

    fake.notify("session.delta", {
      conversationId: "conv-1",
      sessionId: "conv-1",
      delta: { type: "text_delta", text: "hi" },
    });
    fake.notify("session.complete", {
      conversationId: "conv-1",
      sessionId: "conv-1",
      result: { reason: "completed" },
    });
    fake.notify("session.changed", {
      conversationId: "conv-1",
      change: "renamed",
      name: "新名",
    });
    fake.notify("session.modeSwitchIntent", {
      conversationId: "conv-1",
      intent: { kind: "enter", sceneId: "scene-1" },
    });

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.delta).toEqual({ type: "text_delta", text: "hi" });
    expect(completes).toHaveLength(1);
    expect(changes[0]).toEqual({
      conversationId: "conv-1",
      change: "renamed",
      name: "新名",
    });
    expect(intents[0]).toEqual({
      conversationId: "conv-1",
      intent: { kind: "enter", sceneId: "scene-1" },
    });
  });

  it("退订后不再触达", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcConversationFacade(fake.link);

    const deltas: unknown[] = [];
    const off = facade.onDelta((p) => deltas.push(p));
    off();
    fake.notify("session.delta", {
      conversationId: "conv-1",
      sessionId: "conv-1",
      delta: { type: "text_delta", text: "hi" },
    });
    expect(deltas).toEqual([]);
    expect(fake.handlerCount("session.delta")).toBe(0);
  });
});
