/**
 * RpcConversationFacade —— 方法 → RPC (method, params) 映射与返回还原、
 * 通知订阅还原(payload 原样、含 conversationId 供调用方过滤)。
 */

import { describe, it, expect } from "vitest";
import {
  RPC_ERROR_CODES,
  RpcClientError,
  type SessionDeltaPayload,
  type SessionChangedPayload,
  type SessionActivityPayload,
} from "@zhixing/server";
import { RpcConversationFacade } from "../rpc-conversation-facade.js";
import { makeFakeHostLink } from "./fake-host-link.js";

describe("RpcConversationFacade · 方法域", () => {
  it("send 携带 text / conversationId / turnId,返回宿主回显的 turn 身份", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder(() => ({
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-1",
    }));
    const facade = new RpcConversationFacade(fake.link);

    const result = await facade.send("你好", "conv-1", "turn-1");
    expect(result.conversationId).toBe("conv-1");
    expect(result.turnId).toBe("turn-1");
    expect(fake.requests).toEqual([
      {
        method: "session.send",
        params: { text: "你好", conversationId: "conv-1", turnId: "turn-1" },
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

  it("rename / delete / abort / taskList / subscribe / unsubscribe 的方法名与参数", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "session.rename"
        ? { conversationId: "ws:scene-1:conv-9", name: "新名" }
        : method === "session.subscribe"
          ? { subscribed: true }
          : method === "session.taskList"
            ? { taskList: { items: [] } }
            : method === "session.taskListUpdate"
              ? { ok: true, message: "ok", taskList: { items: [] } }
              : {},
    );
    const facade = new RpcConversationFacade(fake.link);

    // rename 返回保持入参全域键(ws: 前缀)——宿主契约,facade 原样透传
    const renamed = await facade.rename("ws:scene-1:conv-9", "新名");
    expect(renamed.conversationId).toBe("ws:scene-1:conv-9");

    await facade.delete("conv-1");
    await facade.abort("conv-1");
    expect((await facade.taskList("conv-1")).taskList).toEqual({ items: [] });
    await facade.taskListUpdate("conv-1", { kind: "add", content: "x" });
    expect(await facade.subscribe("conv-1")).toBe(true);
    await facade.unsubscribe("conv-1");

    expect(fake.requests.map((r) => r.method)).toEqual([
      "session.rename",
      "session.delete",
      "session.abort",
      "session.taskList",
      "session.taskListUpdate",
      "session.subscribe",
      "session.unsubscribe",
    ]);
    expect(fake.requests[1]?.params).toEqual({ conversationId: "conv-1" });
    expect(fake.requests[4]?.params).toEqual({
      conversationId: "conv-1",
      action: { kind: "add", content: "x" },
    });
  });

  it("new / clear / compact / contextBudget / usage / resume 的方法名与参数", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) =>
      method === "session.new"
        ? { conversationId: "conv-new", name: "新对话" }
        : method === "session.compact"
          ? { modified: true, tokensBefore: 100, tokensAfter: 40 }
          : method === "session.contextBudget"
            ? {
                budget: {
                  contextWindow: 200_000,
                  effectiveWindow: 180_000,
                  currentTokens: 12_000,
                  usageRatio: 0.067,
                  status: "normal",
                },
                turnCount: 3,
                calibrationFactor: 1,
              }
            : method === "session.usage"
              ? {
                  budget: {
                    contextWindow: 200_000,
                    effectiveWindow: 180_000,
                    currentTokens: 12_000,
                    usageRatio: 0.067,
                    status: "normal",
                  },
                  turnCount: 3,
                  calibrationFactor: 1,
                  subUsages: [
                    {
                      index: 1,
                      description: "调研",
                      tokens: 100,
                      status: "succeeded",
                    },
                  ],
                }
            : method === "session.resume"
              ? {
                  conversationId: "conv-1",
                  name: "默认对话",
                  active: true,
                  busy: false,
                }
              : {},
    );
    const facade = new RpcConversationFacade(fake.link);

    expect(await facade.newConversation()).toEqual({
      conversationId: "conv-new",
      name: "新对话",
    });
    await facade.clear("conv-1");
    expect(await facade.compact("conv-1")).toMatchObject({
      modified: true,
      tokensAfter: 40,
    });
    expect((await facade.contextBudget("conv-1")).turnCount).toBe(3);
    expect((await facade.usage("conv-1")).subUsages).toHaveLength(1);
    expect(await facade.resume("conv-1")).toMatchObject({
      conversationId: "conv-1",
      active: true,
    });

    expect(fake.requests).toEqual([
      { method: "session.new", params: undefined },
      { method: "session.clear", params: { conversationId: "conv-1" } },
      { method: "session.compact", params: { conversationId: "conv-1" } },
      { method: "session.contextBudget", params: { conversationId: "conv-1" } },
      { method: "session.usage", params: { conversationId: "conv-1" } },
      { method: "session.resume", params: { conversationId: "conv-1" } },
    ]);
  });

  it("resumeIfExists 只把 NOT_FOUND 翻译为 null,其它错误保持异常", async () => {
    const fake = makeFakeHostLink();
    const facade = new RpcConversationFacade(fake.link);

    fake.setResponder(() => {
      throw new RpcClientError(RPC_ERROR_CODES.NOT_FOUND, "Session not found");
    });
    await expect(facade.resumeIfExists("missing")).resolves.toBeNull();

    fake.setResponder(() => {
      throw new RpcClientError(RPC_ERROR_CODES.INTERNAL_ERROR, "boom");
    });
    await expect(facade.resumeIfExists("conv-1")).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
    });
  });
});

describe("RpcConversationFacade · 通知还原", () => {
  it("onDelta / onComplete / onChanged / onActivity / onModeSwitchIntent 收到原样 payload", () => {
    const fake = makeFakeHostLink();
    const facade = new RpcConversationFacade(fake.link);

    const deltas: SessionDeltaPayload[] = [];
    const changes: SessionChangedPayload[] = [];
    const activities: SessionActivityPayload[] = [];
    const completes: unknown[] = [];
    const intents: unknown[] = [];
    facade.onDelta((p) => deltas.push(p));
    facade.onComplete((p) => completes.push(p));
    facade.onChanged((p) => changes.push(p));
    facade.onActivity((p) => activities.push(p));
    facade.onModeSwitchIntent((p) => intents.push(p));

    fake.notify("session.delta", {
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-1",
      delta: { type: "text_delta", text: "hi" },
    });
    fake.notify("session.complete", {
      conversationId: "conv-1",
      sessionId: "conv-1",
      turnId: "turn-1",
      result: { reason: "completed" },
    });
    fake.notify("session.changed", {
      conversationId: "conv-1",
      change: "renamed",
      name: "新名",
    });
    fake.notify("session.activity", {
      conversationId: "conv-other",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    });
    fake.notify("session.modeSwitchIntent", {
      conversationId: "conv-1",
      turnId: "turn-1",
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
    expect(activities[0]).toEqual({
      conversationId: "conv-other",
      source: "feishu",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
      unreadHint: true,
      listInvalidated: true,
    });
    expect(intents[0]).toEqual({
      conversationId: "conv-1",
      turnId: "turn-1",
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
      turnId: "turn-1",
      delta: { type: "text_delta", text: "hi" },
    });
    expect(deltas).toEqual([]);
    expect(fake.handlerCount("session.delta")).toBe(0);
  });
});
