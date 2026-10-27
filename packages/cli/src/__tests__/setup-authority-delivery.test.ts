import { describe, it, expect, afterEach, vi } from "vitest";
import type { ChannelDeliveryEffectSource } from "@zhixing/core/delivery/channel-effect";
import type { AgentYield, RunResult } from "@zhixing/core/loop";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { createDeliveryResolutionFence } from "@zhixing/owner-kernel/delivery";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import { createTempDir } from "@zhixing/test-utils";
import { DurableConversationInteractionObserver } from "../serve/conversation-protocol-runtime.js";
import {
  createProtocol,
  getOrCreateActiveConversation,
  MemorySecretStore,
  setupAuthorityRuntime,
  TEST_DURABLE_IO_TIMEOUT_MS,
  TEST_RUNTIME_AUTHORITY_FACTS,
} from "../serve/__tests__/conversation-protocol-runtime-fixture.js";
import {
  setupDelivery,
  type AuthorityRuntimeStack,
  type DeliveryStack,
} from "../setup-delivery.js";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function emptyChannelDelivery(): ChannelDeliveryEffectSource {
  return {
    status: () => undefined,
    send: async () => undefined,
  };
}

/**
 * 经装配好的运行时走真实提交产生一条投递：对已登记的会话发起一个零候选的批量取消，
 * 控制准入在同一权威决定里提交回执并入队一条发往渠道的 control-response 投递。
 */
async function enqueueControlResponse(
  authorityRuntime: AuthorityRuntimeStack,
  stack: DeliveryStack,
  conversationId: string,
): Promise<string> {
  const runtime: SessionRuntime = {
    ...TEST_RUNTIME_AUTHORITY_FACTS,
    sessionId: `runtime-${conversationId}`,
    async *run(): AsyncGenerator<AgentYield, RunResult> {
      throw new Error("delivery fixture must not execute a turn");
    },
    abort: () => false,
    async dispose() {},
  };
  let manager!: ConversationManager;
  const protocol = createProtocol({
    authority: authorityRuntime,
    manager: () => manager,
    interactions: new DurableConversationInteractionObserver(),
  });
  manager = new ConversationManager(
    { create: vi.fn(async () => runtime) },
    undefined,
    { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
  );
  await getOrCreateActiveConversation(authorityRuntime, manager, conversationId);
  protocol.bindDeliveryDrain(async () => {});
  const cancelled = await protocol.cancel({
    conversationId,
    requestId: `cancel:${conversationId}`,
    principal: {
      surfacePrincipal: "rpc:owner",
      deviceId: authorityRuntime.deviceId,
      connectionId: "connection:delivery-fixture",
    },
    response: { replyTarget: { channelId: "feishu", to: "chat-1" } },
  });
  expect(cancelled.dispositions).toEqual([]);
  const pending = await stack.authority.pendingItems();
  expect(pending).toEqual([
    expect.objectContaining({
      keyBody: expect.objectContaining({ kind: "conversation-control-response-delivery" }),
      state: "queued",
    }),
  ]);
  return pending[0]!.id;
}

describe("setupDelivery authority production path", () => {
  let stack: DeliveryStack | null = null;

  afterEach(async () => {
    if (stack) {
      await stack.stop().catch(() => {});
      stack = null;
    }
  });

  it("assembles a valid DeliveryStack with an empty channel registry", async () => {
    const home = await createTempDir("delivery");
    const authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    stack = await setupDelivery({
      channels: emptyChannelDelivery(),
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    expect(stack).toBeDefined();
    expect(stack.authorityDelivery).toBeDefined();
    expect(stack.authority).toBeDefined();
    expect(stack.authorityLog).toBeDefined();
    expect(stack.artifacts).toBeDefined();
    expect(stack.participant).toBeDefined();
    expect(stack.controlAdmission).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.subjectHistory).toBe("function");
    expect(typeof stack.resolutionApplication.execute).toBe("function");
    expect(typeof stack.stop).toBe("function");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("publishes a revisioned resolved notice through the production control path", async () => {
    const home = await createTempDir("delivery");
    const authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    stack = await setupDelivery({
      channels: emptyChannelDelivery(),
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    const itemId = await enqueueControlResponse(authorityRuntime, stack, "conversation-resolution");
    const lifecycle = authorityRuntime.deliveryLifecycle?.application;
    if (!lifecycle) throw new Error("expected Delivery lifecycle application");
    const claim = await lifecycle.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    });
    expect(claim.kind).toBe("send");
    await lifecycle.claim({ itemId });
    const uncertain = await stack.authority.get(itemId);
    expect(uncertain?.state).toBe("uncertain");
    const listener = vi.fn();
    stack.onStatus(() => {
      throw new Error("simulated status consumer failure");
    });
    stack.onStatus(listener);

    await stack.resolutionApplication.execute({
      requestId: "request:delivery-resolution",
      principal: {
        surfacePrincipal: "surface:user-1",
        deviceId: "device-1",
        connectionId: "connection-1",
      },
      itemId,
      attempt: uncertain!.currentAttempt,
      resolutionFence: createDeliveryResolutionFence(1),
      openFactDigest: uncertain!.openFact!.openFactDigest,
      decision: "abandon",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { execution: "delivery", itemId },
        state: "delivery-resolved",
        decision: "abandon",
      }),
    );
    const history = await stack.subjectHistory([{ itemId, afterStatusRevision: 0 }]);
    expect(history.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "delivery-resolved" }),
      ]),
    );
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("rebuilds queued delivery authority from the shared durable log", async () => {
    const home = await createTempDir("delivery");
    const secrets = new MemorySecretStore();
    const channels = emptyChannelDelivery();
    let authorityRuntime = await setupAuthorityRuntime({ zhixingHome: home, secretStore: secrets });
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    const itemId = await enqueueControlResponse(authorityRuntime, stack, "conversation-1");
    expect((await stack.authority.get(itemId))?.state).toBe("queued");

    stack.activate();
    const frozen = await stack.lifecycle.capture();
    expect(frozen).toEqual([expect.objectContaining({ id: itemId })]);
    await stack.lifecycle.install({
      operationId: "host-stop-production-binding",
      sources: [],
      deliveries: frozen,
    });
    stack.lifecycle.close();
    await stack.lifecycle.seal("host-stop-production-binding");
    await stack.lifecycle.settle({
      operationId: "host-stop-production-binding",
      strategy: "immediate",
      timeoutMs: 1_000,
    });
    await expect(stack.lifecycle.read("host-stop-production-binding"))
      .resolves.toEqual(frozen);
    await stack.lifecycle.release("host-stop-production-binding");
    await stack.lifecycle.resume();

    await stack.stop();
    stack = null;
    // 先关掉第一个运行时，让同 home 的日志释放；第二个运行时从磁盘重新打开
    await authorityRuntime.startupCleanup.run();
    authorityRuntime = await setupAuthorityRuntime({ zhixingHome: home, secretStore: secrets });
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    expect((await stack.authority.get(itemId))?.state).toBe("queued");
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
