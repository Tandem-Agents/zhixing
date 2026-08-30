/**
 * session.send 方法薄层测试 —— 不起 WebSocket,只验证 handler 的错误映射。
 */

import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../../context.js";
import type { AgentYield, Message, RunResult } from "@zhixing/core";
import {
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  ConversationDirectoryApplicationService,
  createConversationDirectoryProductApiContribution,
  type ConversationRunControlPort,
} from "@zhixing/core/conversation/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import {
  ConversationManager,
  WorksceneBusyError,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import type { DurableConversationTurnExecutor } from "@zhixing/owner-kernel/run-turn";
import { stubDurableTurnExecutor } from "../../__tests__/durable-turn-executor-stub.js";
import {
  buildSessionAbortMethod,
  buildSessionResolveMethod,
  buildSessionSendMethod,
  buildSessionSubscribeMethod,
} from "../methods/session.js";
import { RPC_ERROR_CODES } from "../protocol.js";

function runControlProductApi(
  overrides: Partial<ConversationRunControlPort> = {},
): ProductApiDispatcher {
  const runControl: ConversationRunControlPort = {
    requiresStableCancellationIdentity: true,
    requiresAuthoritativeRunIdentity: true,
    emptyCancellationIsSuccess: false,
    createCancellationIdentity: () => "unused",
    cancel: async () => ({
      matchedDurableRuns: 1,
      abortedInFlight: true,
      cancelledPending: 0,
    }),
    resolveUncertain: async () => ({
      state: "cancelled",
      factDigest: `sha256:${"b".repeat(64)}`,
    }),
    ...overrides,
  };
  const application = new ConversationDirectoryApplicationService({
    storage: {
      list: async () => [],
      create: async () => {
        throw new Error("unused");
      },
      rename: async () => null,
      readHistory: async () => ({ runs: [], hasMore: false }),
    },
    runControl,
  });
  return new ProductApiDispatcher(
    CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
    [createConversationDirectoryProductApiContribution(application)],
  );
}

describe("session.send 方法", () => {
  it("admitTurn 撞工作场景静默闸时返回 BUSY", async () => {
    const method = buildSessionSendMethod();
    const ctx = {
      server: {
        conversations: {
          usesDurableTurnProtocol: () => false,
          admitTurn: async () => {
            throw new WorksceneBusyError("quiescing");
          },
        },
      } as unknown as ServerContext,
      connection: { id: "conn-1" },
    } as never;

    await expect(
      method.handler(
        {
          text: "继续",
          conversationId: "ws:scene-1:conv-main",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
  });
});

describe("session.subscribe publish result history", () => {
  it("replays the owner final and its stable per-item result after the requested revision", async () => {
    const notify = vi.fn();
    const conversationFinalHistory = vi.fn(async () => [{
      frame: {
        v: 1 as const,
        conversationId: "conversation-1",
        runId: "run-1",
        commitRevision: 4,
        digest: `sha256:${"a".repeat(64)}`,
      },
      publishResults: [{
        conversationId: "conversation-1",
        runId: "run-1",
        commitRevision: 4,
        assignmentId: "assignment-1",
        seq: 2,
        mutation: { kind: "workscene-create" as const, name: "专注" },
        decision: {
          t: "conflicted" as const,
          error: {
            code: "revision-conflict" as const,
            message: "内容已变化",
            retryable: false,
          },
        },
      }],
    }]);
    const method = buildSessionSubscribeMethod();

    await expect(method.handler(
      { conversationId: "conversation-1", afterCommitRevision: 3 },
      {
        server: {
          conversations: {
            has: () => true,
            addObserver: () => true,
          },
          runtimeControl: { conversationFinalHistory },
        } as unknown as ServerContext,
        connection: { id: "connection-1", notify },
      } as never,
    )).resolves.toEqual({ subscribed: true });

    expect(conversationFinalHistory).toHaveBeenCalledWith("conversation-1", 3);
    expect(notify).toHaveBeenNthCalledWith(1, "session.final", expect.objectContaining({
      commitRevision: 4,
    }));
    expect(notify).toHaveBeenNthCalledWith(2, "session.event", expect.objectContaining({
      scope: "control",
      event: "publish:result",
      payload: expect.objectContaining({ assignmentId: "assignment-1", seq: 2 }),
    }));
  });
});

describe("session durable control 方法", () => {
  it("preserves durable cancellation identity validation at the application boundary", async () => {
    const method = buildSessionAbortMethod();
    const ctx = {
      server: { productApi: runControlProductApi() } as unknown as ServerContext,
      connection: { id: "connection-1", clientInfo: { id: "desktop" } },
    } as never;
    await expect(
      method.handler({ conversationId: "conversation-1" }, ctx),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message:
        "session.abort requires a stable 'requestId' while durable execution is enabled",
    });
    await expect(
      method.handler(
        { conversationId: "conversation-1", requestId: "cancel-request-1" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message:
        "session.abort requires an authoritative 'runId' while durable execution is enabled",
    });
    await expect(
      method.handler(
        { conversationId: "conversation-1", runId: "run-1" },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "session.abort requires 'requestId' when 'runId' is present",
    });
  });

  it("durably admits cancellation before signalling the local runtime", async () => {
    const order: string[] = [];
    const cancelDurableRuns = vi.fn(async () => {
      order.push("durable");
      return {
        matchedDurableRuns: 1,
        abortedInFlight: true,
        cancelledPending: 0,
      };
    });
    const method = buildSessionAbortMethod();
    await method.handler(
      {
        conversationId: "conversation-1",
        requestId: "cancel-request-1",
        runId: "run-1",
      },
      {
        server: {
          productApi: runControlProductApi({ cancel: cancelDurableRuns }),
        } as unknown as ServerContext,
        connection: { id: "connection-1", clientInfo: { id: "desktop" } },
      } as never,
    );
    expect(order).toEqual(["durable"]);
    expect(cancelDurableRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        operationId: "cancel-request-1",
        runId: "run-1",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:desktop",
          connectionId: "connection-1",
        },
        occurredAt: expect.any(Number),
      }),
    );
  });

  it("settles only the advancement proxy bound to the cancelled run ingress", async () => {
    const settleProxyMessage = vi.fn(async () => {});
    const loadActiveSession = vi.fn(async (_conversationId: string) => ({
      id: "advancement-1",
      status: "active" as const,
      outstandingProxyMessageId: "proxy-current",
    }));
    const cancelDurableRuns = vi.fn(async () => ({
      matchedDurableRuns: 1,
      abortedInFlight: true,
      cancelledPending: 0,
      dependentLifecycleIngressId: "proxy-old",
    }));
    const method = buildSessionAbortMethod();
    await method.handler(
      {
        conversationId: "conversation-1",
        requestId: "cancel-request-old",
        runId: "run-old",
      },
      {
        server: {
          productApi: runControlProductApi({
            cancel: cancelDurableRuns,
            settleDependentCancellation: async ({
              conversationId,
              ingressId,
            }) => {
              const active = await loadActiveSession(conversationId);
              if (active.outstandingProxyMessageId === ingressId) {
                await settleProxyMessage({ conversationId, ingressId });
              }
            },
          }),
        } as unknown as ServerContext,
        connection: { id: "connection-1", clientInfo: { id: "desktop" } },
      } as never,
    );
    expect(loadActiveSession).toHaveBeenCalledWith("conversation-1");
    expect(settleProxyMessage).not.toHaveBeenCalled();
  });

  it("settles the advancement proxy bound to the cancelled run ingress", async () => {
    const settleProxyMessage = vi.fn(async () => {});
    const loadActiveSession = vi.fn(async (_conversationId: string) => ({
      id: "advancement-1",
      status: "active" as const,
      outstandingProxyMessageId: "proxy-current",
    }));
    const method = buildSessionAbortMethod();
    await method.handler(
      {
        conversationId: "conversation-1",
        requestId: "cancel-request-current",
        runId: "run-current",
      },
      {
        server: {
          productApi: runControlProductApi({
            cancel: vi.fn(async () => ({
              matchedDurableRuns: 1,
              abortedInFlight: true,
              cancelledPending: 0,
              dependentLifecycleIngressId: "proxy-current",
            })),
            settleDependentCancellation: async ({
              conversationId,
              ingressId,
            }) => {
              const active = await loadActiveSession(conversationId);
              if (active.outstandingProxyMessageId === ingressId) {
                await settleProxyMessage({
                  conversationId,
                  advancementSessionId: active.id,
                  proxyMessageId: ingressId,
                });
              }
            },
          }),
        } as unknown as ServerContext,
        connection: { id: "connection-1", clientInfo: { id: "desktop" } },
      } as never,
    );
    expect(settleProxyMessage).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      advancementSessionId: "advancement-1",
      proxyMessageId: "proxy-current",
    });
  });

  it("keeps a durable cancellation successful when advancement projection fails", async () => {
    const recoverConversation = vi.fn(async () => ({
      status: "closed-run-recovered" as const,
    }));
    const method = buildSessionAbortMethod();

    await expect(
      method.handler(
        {
          conversationId: "conversation-1",
          requestId: "cancel-request-current",
          runId: "run-current",
        },
        {
          server: {
            productApi: runControlProductApi({
              cancel: vi.fn(async () => ({
                matchedDurableRuns: 1,
                abortedInFlight: true,
                cancelledPending: 0,
                dependentLifecycleIngressId: "proxy-current",
              })),
              settleDependentCancellation: async () => {
                throw new Error("advancement store temporarily unavailable");
              },
              recoverDependentCancellation: async (conversationId) => {
                await recoverConversation(conversationId);
              },
            }),
          } as unknown as ServerContext,
          connection: { id: "connection-1", clientInfo: { id: "desktop" } },
        } as never,
      ),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(recoverConversation).toHaveBeenCalledWith("conversation-1");
    });
  });

  it("routes an uncertain resolution with the authenticated stable principal", async () => {
    const resolveDurableUncertain = vi.fn(async () => ({
      state: "cancelled" as const,
      factDigest: `sha256:${"b".repeat(64)}`,
    }));
    const method = buildSessionResolveMethod();
    await expect(
      method.handler(
        {
          conversationId: "conversation-1",
          runId: "run-1",
          requestId: "resolve-request-1",
          ownerEpoch: 1,
          openFactDigest: `sha256:${"a".repeat(64)}`,
          decision: "user-abandoned",
        },
        {
          server: {
            productApi: runControlProductApi({
              resolveUncertain: resolveDurableUncertain,
            }),
          } as unknown as ServerContext,
          connection: { id: "connection-2", clientInfo: { id: "desktop" } },
        } as never,
      ),
    ).resolves.toMatchObject({ state: "cancelled" });
    expect(resolveDurableUncertain).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerEpoch: 1,
        decision: "user-abandoned",
        operationId: "resolve-request-1",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:desktop",
          connectionId: "connection-2",
        },
      }),
    );
  });

  it("disconnect removes only the observer while a durable run keeps executing", async () => {
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "done after disconnect" }],
    };
    const runtime: SessionRuntime = {
      sessionId: "runtime-durable-disconnect",
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        observedSignal = options?.abortSignal;
        started();
        await executionGate;
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const durable: DurableConversationTurnExecutor = stubDurableTurnExecutor({
      admit: vi.fn(async () => ({ runId: "authority-run-1", shouldSchedule: true })),
      async *run(input) {
        const generator = input.runtime.run(input.messages, input.options);
        while (true) {
          const item = await generator.next();
          if (item.done) return item.value;
          yield item.value;
        }
      },
      publishPendingFinals: vi.fn(async () => 0),
    });
    const manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: durable },
    );
    await manager.getOrCreate("conversation-1");
    const closeHandlers = new Set<() => void>();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection = {
      id: "connection-1",
      clientInfo: { id: "desktop" },
      closed: false,
      notify(method: string, params: unknown) {
        notifications.push({ method, params });
      },
      onClose(handler: () => void) {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    const method = buildSessionSendMethod();

    await expect(
      method.handler(
        { text: "keep working", conversationId: "conversation-1", turnId: "turn-1" },
        {
          server: { conversations: manager } as unknown as ServerContext,
          connection,
        } as never,
      ),
    ).resolves.toMatchObject({ runId: "authority-run-1" });
    await startedGate;
    connection.closed = true;
    for (const handler of [...closeHandlers]) handler();
    expect(observedSignal?.aborted).toBe(false);
    release();
    await vi.waitFor(() => {
      expect(notifications.some((item) => item.method === "session.complete")).toBe(true);
    });
    expect(observedSignal?.aborted).toBe(false);
    await manager.disposeAll();
  });
});
