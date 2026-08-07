import { describe, expect, it, vi } from "vitest";
import { localConversationId } from "@zhixing/core";
import { RpcAppError } from "@zhixing/server";
import { LocalConversationRpcRouter } from "../local-conversation-rpc.js";
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
});

function ownerPort(): LocalConversationOwnerPort {
  return {
    createConversation: vi.fn(async () => CONVERSATION_ID),
    ensureSession: vi.fn(async () => {}),
    listConversations: vi.fn(async () => [CONVERSATION_ID]),
    mutateSession: vi.fn(async () => ({ revision: 1 })),
    cancelTurns: vi.fn(async () => {}),
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
    notify: vi.fn(),
    onClose: vi.fn(() => () => {}),
  };
}
