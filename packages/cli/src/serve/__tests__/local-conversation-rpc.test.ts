import { describe, expect, it, vi } from "vitest";
import { localConversationId } from "@zhixing/core";
import { RpcAppError } from "@zhixing/server";
import {
  ExecutorFirstPartyRpcRouter,
  LocalConversationRpcRouter,
} from "../local-conversation-rpc.js";
import type { LocalConversationOwnerPort } from "../local-conversation-owner.js";

const DEVICE_ID = "device-abcdef";
const CONVERSATION_ID = localConversationId(
  DEVICE_ID,
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
);

describe("LocalConversationRpcRouter", () => {
  it("公开本机清单并在用户确认前拒绝写入", async () => {
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner: ownerPort(),
      remoteFor: () => { throw new Error("unexpected remote route"); },
    });
    const connection = fakeConnection();

    await expect(
      router.dispatch({ method: "session.list", params: {}, connection }),
    ).resolves.toMatchObject({
      handled: true,
      result: {
        conversations: [{ conversationId: CONVERSATION_ID }],
        availability: { mode: "local-only" },
      },
    });
    await expect(
      router.dispatch({ method: "session.new", params: {}, connection }),
    ).rejects.toMatchObject({
      message: "继续前请确认使用这台电脑新建或恢复本机对话。",
    });
  });

  it("仅允许本机身份并复用 session wire 推送 turn", async () => {
    const port = ownerPort();
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner: port,
      remoteFor: () => { throw new Error("unexpected remote route"); },
    });
    const connection = fakeConnection();

    await router.dispatch({
      method: "session.subscribe",
      params: { conversationId: CONVERSATION_ID },
      connection,
    });
    const result = await router.dispatch({
      method: "session.send",
      params: {
        conversationId: CONVERSATION_ID,
        turnId: "turn-local-1",
        text: "继续工作",
        continueLocally: true,
      },
      connection,
    });

    expect(result).toMatchObject({
      handled: true,
      result: {
        conversationId: CONVERSATION_ID,
        turnId: "turn-local-1",
        runId: "run-local-1",
      },
    });
    expect(connection.notify).toHaveBeenCalledWith(
      "session.complete",
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );

    await expect(
      router.dispatch({
        method: "session.send",
        params: {
          conversationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          turnId: "turn-old-1",
          text: "旧对话",
          continueLocally: true,
        },
        connection,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RpcAppError &&
        error.message ===
          "这个对话目前无法在这台电脑修改，请连接值班设备后重试。",
    );
  });

  it("全局确认能力返回可行动产品语言且不泄漏内部术语", async () => {
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner: ownerPort(),
      remoteFor: () => { throw new Error("unexpected remote route"); },
    });
    const connection = fakeConnection();
    const promise = router.dispatch({
      method: "session.advancementConfirm",
      params: { conversationId: CONVERSATION_ID },
      connection,
    });
    await expect(promise).rejects.toMatchObject({
      message: "这项确认需要连接值班设备；当前对话已保留，可在重新连接后继续。",
    });
    await expect(promise).rejects.not.toThrow(/anchor|owner|epoch|intent|CAS|stream/iu);
  });

  it("本机 current-owner 确认只调用同一 canonical handler", async () => {
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner: ownerPort(),
      remoteFor: () => { throw new Error("unexpected remote route"); },
    });
    const dispatchCanonical = vi.fn(async () => ({
      items: [{ requestId: "confirm-local", conversationId: CONVERSATION_ID }],
    }));

    await expect(router.dispatch({
      method: "confirmation.list",
      params: { conversationId: CONVERSATION_ID },
      connection: fakeConnection(),
      dispatchCanonical,
    })).resolves.toMatchObject({
      handled: true,
      result: { items: [{ requestId: "confirm-local" }] },
    });
    expect(dispatchCanonical).toHaveBeenCalledTimes(1);
  });

  it("按耐久 current owner 转发会话与会话绑定确认", async () => {
    const remoteDeviceId = "device-anchor";
    const owner = ownerPort();
    owner.listConversations = vi.fn(async () => []);
    owner.listConversationAuthorities = vi.fn(async () => [{
      conversationId: CONVERSATION_ID,
      authority: {
        deviceId: remoteDeviceId,
        ownerEpoch: 2,
        transferId: "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV",
        state: "fenced",
      },
    }]);
    owner.currentAuthority = vi.fn(async () => ({
      deviceId: remoteDeviceId,
      ownerEpoch: 2,
      transferId: "xfer-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      state: "fenced",
    }));
    const dispatch = vi.fn(async (method: string) => {
      if (method === "session.list") {
        return {
          conversations: [{
            conversationId: CONVERSATION_ID,
            name: "已收编对话",
            createdAt: "2026-08-07T00:00:00.000Z",
            lastActiveAt: "2026-08-08T00:00:00.000Z",
            active: false,
            busy: false,
            observerCount: 0,
            pendingCount: 1,
          }],
        };
      }
      if (method === "confirmation.list") {
        return { items: [{ requestId: "confirm-1", conversationId: CONVERSATION_ID }] };
      }
      return { conversationId: CONVERSATION_ID };
    });
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner,
      remoteFor: () => ({ dispatch, close: vi.fn() }) as never,
    });
    const connection = fakeConnection();

    await expect(router.dispatch({
      method: "session.list",
      params: {},
      connection,
    })).resolves.toMatchObject({
      handled: true,
      result: { conversations: [{ conversationId: CONVERSATION_ID }] },
    });
    await router.dispatch({
      method: "session.resume",
      params: { conversationId: CONVERSATION_ID },
      connection,
    });
    const dispatchCanonical = vi.fn(async () => ({
      items: [{ requestId: "confirm-local", conversationId: "local-current" }],
    }));
    await expect(router.dispatch({
      method: "confirmation.list",
      params: {},
      connection,
      dispatchCanonical,
    })).resolves.toMatchObject({
      result: {
        items: expect.arrayContaining([
          { requestId: "confirm-local", conversationId: "local-current" },
          { requestId: "confirm-1", conversationId: CONVERSATION_ID },
        ]),
      },
    });
    await router.dispatch({
      method: "confirmation.resolve",
      params: {
        conversationId: CONVERSATION_ID,
        requestId: "confirm-1",
        decision: "allow",
      },
      connection,
    });

    expect(dispatch).toHaveBeenCalledWith(
      "confirmation.list",
      { conversationId: CONVERSATION_ID },
      connection,
    );
    expect(dispatchCanonical).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "confirmation.resolve",
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
      connection,
    );
  });

  it("在本机 owner 上以同一 surface identity 解析 durable uncertain run", async () => {
    const owner = ownerPort();
    const router = new LocalConversationRpcRouter({
      deviceId: DEVICE_ID,
      owner,
      remoteFor: () => { throw new Error("unexpected remote route"); },
    });
    const input = {
      requestId: "resolve-request-1",
      conversationId: CONVERSATION_ID,
      runId: "run-local-1",
      ownerEpoch: 1,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "user-abandoned" as const,
    };

    await expect(router.dispatch({
      method: "session.resolve",
      params: input,
      connection: fakeConnection(),
    })).resolves.toMatchObject({
      handled: true,
      result: { state: "cancelled" },
    });
    expect(owner.resolveDurableUncertain).toHaveBeenCalledWith({
      ...input,
      surfacePrincipal: "rpc:test",
      connectionId: "7",
    });
  });

  it("executor-only 按 method ownership 二选一且 local false 不串到 current anchor", async () => {
    const local = { dispatch: vi.fn(async () => ({ handled: false as const })) };
    const currentAnchor = {
      dispatch: vi.fn(async () => ({ handled: true as const, result: "remote" })),
    };
    const router = new ExecutorFirstPartyRpcRouter({ local, currentAnchor });
    const connection = fakeConnection();

    await expect(router.dispatch({
      method: "session.new",
      params: {},
      connection,
    })).resolves.toEqual({ handled: false });
    expect(local.dispatch).toHaveBeenCalledTimes(1);
    expect(currentAnchor.dispatch).not.toHaveBeenCalled();

    await expect(router.dispatch({
      method: "schedule.list",
      params: {},
      connection,
    })).resolves.toEqual({ handled: true, result: "remote" });
    expect(currentAnchor.dispatch).toHaveBeenCalledTimes(1);

    await expect(router.dispatch({
      method: "health",
      params: {},
      connection,
    })).resolves.toEqual({ handled: false });
    await expect(router.dispatch({
      method: "unknown.method",
      params: {},
      connection,
    })).resolves.toEqual({ handled: false });
    expect(local.dispatch).toHaveBeenCalledTimes(1);
    expect(currentAnchor.dispatch).toHaveBeenCalledTimes(1);
  });
});

function ownerPort(): LocalConversationOwnerPort {
  return {
    createConversation: vi.fn(async () => CONVERSATION_ID),
    ensureSession: vi.fn(async () => {}),
    listConversations: vi.fn(async () => [CONVERSATION_ID]),
    listConversationAuthorities: vi.fn(async () => [{
      conversationId: CONVERSATION_ID,
      authority: { deviceId: DEVICE_ID, ownerEpoch: 1, state: "current" },
    }]),
    currentAuthority: vi.fn(async () => ({
      deviceId: DEVICE_ID,
      ownerEpoch: 1,
      state: "current",
    })),
    mutateSession: vi.fn(async () => ({ revision: 1 })),
    cancelTurns: vi.fn(async () => {}),
    resolveDurableUncertain: vi.fn(async () => ({
      state: "cancelled",
      factDigest: `sha256:${"b".repeat(64)}`,
    })),
    runTurn: vi.fn(async () => ({ kind: "aborted" })),
    admitTurn: vi.fn(async (input) => {
      input.notify("session.complete", {
        conversationId: input.conversationId,
        sessionId: input.conversationId,
        turnId: input.turnId,
        result: { reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
      });
      return {
        status: "immediate",
        runId: "run-local-1",
        outcome: Promise.resolve({ kind: "aborted" }),
      };
    }),
    answerInteractionWithTicket: vi.fn(async () => {}),
    resolveNoInteractiveSurface: vi.fn(async () => {}),
    deferSchedule: vi.fn(),
    listDeferredIntents: vi.fn(async () => []),
    discardDeferredIntent: vi.fn(async () => {}),
    sessionState: {
      readSessionMeta: vi.fn(async () => ({
        conversationId: CONVERSATION_ID,
        ownerEpoch: 1,
        baseRevision: 1,
        name: "本机对话",
        turnCount: 0,
        lastActiveAt: "2026-08-07T00:00:00.000Z",
      })),
      readTranscriptTail: vi.fn(async () => ({ records: [] })),
      readTaskList: vi.fn(async () => ({ items: [] })),
      readAdvancementState: vi.fn(async () => null),
    },
    statusHistory: vi.fn(async (after) => ({ notices: [], next: after })),
    finalHistory: vi.fn(async () => []),
    pendingInteractions: vi.fn(() => []),
    rubricCatalog: {
      listForMatching: vi.fn(async () => []),
      load: vi.fn(async () => undefined),
    },
  };
}

function fakeConnection() {
  return {
    id: 7,
    closed: false,
    authenticated: true,
    loopback: true,
    clientInfo: { id: "test", version: "1" },
    surfacePrincipal: "rpc:test",
    surfaceGeneration: 1,
    notify: vi.fn(),
    onClose: vi.fn(() => () => {}),
  };
}
