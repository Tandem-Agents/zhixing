import { recordingFixture } from "../../../core/src/logging/__tests__/recording.js";
import { describe, expect, it, vi } from "vitest";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { type Message } from "@zhixing/core";
import {
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  ConversationDirectoryApplicationService,
  createConversationDirectoryProductApiContribution,
} from "@zhixing/core/conversation/application";
import {
  defineProductApiExactSet,
  ProductApiDispatcher,
} from "@zhixing/core/product-api";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import {
  createConversationAgentTurnAdmissionPort,
} from "@zhixing/owner-kernel/conversation-agent-turn-admission";
import { ChannelConversationProductBinding } from "./channel-conversation-product-binding.js";
import { createAnchorConversationRunControlPort } from "./conversation-run-control-binding.js";

describe("ChannelConversationProductBinding", () => {
  it("requires binding before consumption and uses the one sealed Product API dispatcher", async () => {
    const logs = recordingFixture();
    const manager = managerWithResult("channel answer");
    const admitTurn = vi.spyOn(manager, "admitTurn");
    const binding = new ChannelConversationProductBinding(manager, logs.bind);
    expect(() => binding.assertBound()).toThrow("not bound");
    await expect(binding.prepareAgentTurn({
      channelId: "feishu",
      platformSubject: "user-1",
    })).rejects.toThrow("not bound");
    binding.bind(conversationProductApi(manager));
    binding.assertBound();
    expect(() => binding.bind(conversationProductApi(manager))).toThrow("already bound");
    const turnIdentity = await binding.prepareAgentTurn({
      channelId: "feishu",
      platformSubject: "user-1", messageId: "message-1",
    });
    const outcomes: unknown[] = [];
    const started = vi.fn();
    const released = vi.fn();
    const result = await binding.admitAgentTurn({
      conversationId: "channel:feishu:user:user-1",
      text: "hello",
      turnIdentity,
      turnContext: { turnId: turnIdentity.turnId },
      channelId: "feishu",
      platformSubject: "user-1",
      onStarted: started,
      onPendingCancelled: vi.fn(),
      onProtocolEvent: vi.fn(),
      onCommitFailure: vi.fn(),
      onFinalPublishFailure: vi.fn(),
      onOutcome: async (outcome, delivery) => {
        outcomes.push({ outcome, delivery });
      },
      onSettled: released,
    });

    expect(result.status).toBe("immediate");
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
    expect(started).toHaveBeenCalledOnce();
    expect(admitTurn).toHaveBeenCalledWith(expect.objectContaining({
      source: "channel",
    }));
    expect(outcomes).toEqual([
      {
        outcome: expect.objectContaining({
          kind: "settled",
          result: expect.objectContaining({ reason: "completed" }),
        }),
        delivery: "surface",
      },
    ]);
    expect(manager.getSession(result.conversationId)?.busy).toBe(false);
    await logs.finish();
    expect(logs.recorder.health().captureFailures).toBe(0);
    expect(logs.records()).toContainEqual(expect.objectContaining({ event: "prepared", refs: expect.arrayContaining([{ kind: "message", id: "message-1" }, { kind: "turn", id: turnIdentity.turnId }]) }));
    expect(logs.records()).toContainEqual(expect.objectContaining({ event: "admitted", access: { scope: `conversation:${result.conversationId}` }, refs: expect.arrayContaining([{ kind: "conversation", id: result.conversationId }, { kind: "turn", id: turnIdentity.turnId }]) }));
  });

  it("routes stable Channel cancellation through Product API and preserves authoritative response ownership", async () => {
    const manager = managerWithResult("unused");
    vi.spyOn(manager, "usesDurableTurnProtocol").mockReturnValue(true);
    vi.spyOn(manager, "durableControlPrincipal").mockReturnValue({
      surfacePrincipal: "channel:feishu:user-1",
      connectionId: "channel:feishu",
      deviceId: "device-1",
    });
    const cancel = vi.spyOn(manager, "cancelDurableRuns").mockResolvedValue({
      dispositions: [],
    });
    const binding = new ChannelConversationProductBinding(manager);
    binding.bind(conversationProductApi(manager));

    await expect(binding.abort({
      conversationId: "channel:feishu:user:user-1",
      channelId: "feishu",
      platformSubject: "user-1",
      messageId: "message-1",
      replyTarget: { channelId: "feishu", to: "user-1" },
    })).resolves.toEqual({
      cancelled: true,
      feedback: { kind: "authoritative" },
    });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(/^cancel:sha256:/u),
      response: {
        replyTarget: { channelId: "feishu", to: "user-1" },
      },
    }));
  });

  it("rejects a dispatcher without the complete Conversation contribution", () => {
    const binding = new ChannelConversationProductBinding(managerWithResult("unused"));
    expect(() => binding.bind(new ProductApiDispatcher(
      defineProductApiExactSet({ operations: [], factEvents: [] }),
      [],
    ))).toThrow("Conversation Product API contribution is missing");
  });

  it("rejects consumption and rebinding after the Channel lifecycle closes", async () => {
    const binding = new ChannelConversationProductBinding(managerWithResult("unused"));
    binding.close();
    expect(() => binding.assertBound()).toThrow("closed");
    await expect(binding.admitAgentTurn({} as never)).rejects.toThrow("closed");
    await expect(binding.abort({} as never)).rejects.toThrow("closed");
    await expect(binding.prepareAgentTurn({
      channelId: "feishu",
      platformSubject: "user-1",
    })).rejects.toThrow("Channel Conversation Product API binding is closed");
    expect(() => binding.bind(conversationProductApi(managerWithResult("unused"))))
      .toThrow("Channel Conversation Product API binding is closed");
  });
});

function conversationProductApi(manager: ConversationManager): ProductApiDispatcher {
  const application = new ConversationDirectoryApplicationService({
    storage: {
      list: async () => [],
      create: async () => ({
        conversationId: "unused",
        name: "unused",
        createdAt: "2026-09-01T00:00:00.000Z",
        lastActiveAt: "2026-09-01T00:00:00.000Z",
      }),
      rename: async () => null,
      readHistory: async () => ({ entries: [] }),
    },
    agentTurnIdentity: {
      exists: async () => true,
      create: async () => "conversation-created",
      ensure: async () => {},
    },
    agentTurns: createConversationAgentTurnAdmissionPort({ manager }),
    runControl: createAnchorConversationRunControlPort({ conversations: manager }),
  });
  return new ProductApiDispatcher(
    CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
    [createConversationDirectoryProductApiContribution(application)],
  );
}

function managerWithResult(text: string): ConversationManager {
  const runtime: SessionRuntime = {
    sessionId: "runtime-1",
    run: vi.fn(async function* (): AsyncGenerator<AgentYield, RunResult> {
      const assistant: Message = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      return {
        agentResult: {
          reason: "completed",
          message: assistant,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        runRecord: {
          timestamp: "2026-09-01T00:00:00.000Z",
          messages: [assistant],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        newMessages: [assistant],
        durationMs: 1,
      };
    }),
    getHistory: () => [],
    acceptRun: () => ({}),
    abort: () => false,
    dispose: () => {},
  };
  const factory: RuntimeFactory = { create: async () => runtime };
  return new ConversationManager(factory, {
    graceTimeoutMs: 100_000,
    idleTimeoutMs: 100_000,
    idleCheckIntervalMs: 100_000,
  });
}
