import { describe, expect, it, vi } from "vitest";
import { ConversationCancellationResponseEffect } from "@zhixing/core/conversation/application";
import type { ConversationManager } from "@zhixing/owner-kernel";
import {
  createAnchorConversationRunControlPort,
  createChannelCancellationResponseEffect,
} from "./conversation-run-control-binding.js";

const caller = Object.freeze({
  kind: "surface" as const,
  surfacePrincipal: "rpc:test",
  connectionId: "connection-1",
});

describe("createAnchorConversationRunControlPort", () => {
  it("maps one durable cancellation and principal without owning the decision", async () => {
    const cancelDurableRuns = vi.fn(async () => ({
      dispositions: [
        {
          runId: "run-1",
          runState: "cancelled" as const,
          source: "advancement" as const,
          ingressId: "proxy-1",
          abortedInFlight: true,
          cancelledPending: 2,
        },
      ],
    }));
    const conversations = {
      usesDurableTurnProtocol: () => true,
      cancelDurableRuns,
      durableControlPrincipal: (input: {
        surfacePrincipal: string;
        connectionId: string;
      }) => ({ ...input, deviceId: "device-1" }),
    } as unknown as ConversationManager;
    const port = createAnchorConversationRunControlPort({ conversations });

    await expect(
      port.cancel({
        conversationId: "conversation-1",
        operationId: "cancel-1",
        runId: "run-1",
        caller,
        occurredAt: 123,
      }),
    ).resolves.toEqual({
      matchedDurableRuns: 1,
      abortedInFlight: true,
      cancelledPending: 2,
      dependentLifecycleIngressId: "proxy-1",
    });
    expect(cancelDurableRuns).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      requestId: "cancel-1",
      runId: "run-1",
      reason: { kind: "user-cancel", source: "rpc", pressedAt: 123 },
      principal: {
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
        deviceId: "device-1",
      },
    });
  });

  it("keeps the legacy in-memory abort projection behind the same port", async () => {
    const abort = vi.fn(() => ({
      abortedInFlight: false,
      cancelledPending: 2,
    }));
    const conversations = {
      usesDurableTurnProtocol: () => false,
      abort,
    } as unknown as ConversationManager;
    const port = createAnchorConversationRunControlPort({ conversations });

    expect(port.requiresStableCancellationIdentity).toBe(false);
    expect(port.requiresAuthoritativeRunIdentity).toBe(false);
    await expect(
      port.cancel({
        conversationId: "conversation-1",
        operationId: "generated-1",
        caller,
        occurredAt: 456,
      }),
    ).resolves.toEqual({
      matchedDurableRuns: 0,
      abortedInFlight: false,
      cancelledPending: 2,
    });
    expect(abort).toHaveBeenCalledWith("conversation-1", {
      kind: "user-cancel",
      source: "rpc",
      pressedAt: 456,
    });
  });

  it("keeps the Channel reply target opaque to the domain and rejects a foreign response effect", async () => {
    const cancelDurableRuns = vi.fn(async () => ({ dispositions: [] }));
    const conversations = {
      usesDurableTurnProtocol: () => true,
      cancelDurableRuns,
      durableControlPrincipal: () => ({ deviceId: "device-1" }),
    } as unknown as ConversationManager;
    const port = createAnchorConversationRunControlPort({ conversations });
    const response = createChannelCancellationResponseEffect({
      channelId: "feishu",
      to: "user-1",
      threadId: "thread-1",
    });

    await expect(port.cancel({
      conversationId: "conversation-1",
      operationId: "cancel-1",
      caller,
      occurredAt: 123,
      response,
    })).resolves.toEqual({
      matchedDurableRuns: 0,
      abortedInFlight: false,
      cancelledPending: 0,
      authoritativeResponse: true,
    });
    expect(cancelDurableRuns).toHaveBeenCalledWith(expect.objectContaining({
      response: {
        replyTarget: {
          channelId: "feishu",
          to: "user-1",
          threadId: "thread-1",
        },
      },
    }));

    cancelDurableRuns.mockClear();
    await expect(port.cancel({
      conversationId: "conversation-1",
      operationId: "cancel-2",
      caller,
      occurredAt: 124,
      response: new ForeignCancellationResponseEffect(),
    })).rejects.toThrow(
      "Conversation cancellation response effect is not owned by the Channel binding",
    );
    expect(cancelDurableRuns).not.toHaveBeenCalled();
  });

  it("maps uncertain resolution through the authenticated durable principal", async () => {
    const resolveDurableUncertain = vi.fn(async () => ({
      state: "cancelled" as const,
      factDigest: `sha256:${"b".repeat(64)}`,
    }));
    const conversations = {
      usesDurableTurnProtocol: () => true,
      resolveDurableUncertain,
      durableControlPrincipal: (input: {
        surfacePrincipal: string;
        connectionId: string;
      }) => ({ ...input, deviceId: "device-1" }),
    } as unknown as ConversationManager;
    const port = createAnchorConversationRunControlPort({ conversations });

    await expect(
      port.resolveUncertain({
        conversationId: "conversation-1",
        runId: "run-1",
        operationId: "resolve-1",
        ownerEpoch: 2,
        openFactDigest: `sha256:${"a".repeat(64)}`,
        decision: "user-abandoned",
        caller,
      }),
    ).resolves.toMatchObject({ state: "cancelled" });
    expect(resolveDurableUncertain).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      runId: "run-1",
      requestId: "resolve-1",
      ownerEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "user-abandoned",
      principal: {
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
        deviceId: "device-1",
      },
    });
  });
});

class ForeignCancellationResponseEffect extends ConversationCancellationResponseEffect {
  constructor() {
    super();
    Object.freeze(this);
  }
}
