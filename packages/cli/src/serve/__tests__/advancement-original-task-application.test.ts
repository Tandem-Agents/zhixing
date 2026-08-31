import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDirectoryApplication,
  ConversationPreparedAgentTurnIdentity,
} from "@zhixing/core/conversation/application";
import type { AdvancementOriginalTaskSurfacePort } from "@zhixing/core/advancement/application";
import { createAnchorAdvancementOriginalTaskExecutionPort } from "../advancement-original-task-application.js";

describe("Anchor Advancement original-task execution adapter", () => {
  it("uses the Conversation application once with the original identity and surface effects", async () => {
    const prepared = { turnId: "turn-1" } as ConversationPreparedAgentTurnIdentity;
    const prepareAgentTurnIdentity = vi.fn(() => prepared);
    const surfaceExecute = vi.fn(async () => undefined);
    const surface = testSurface({ execute: surfaceExecute });
    const admitAgentTurn = vi.fn(async (command) => {
      await command.execution.execute({
        conversationId: "conv-1",
        turnId: "turn-1",
      });
      command.execution.onAdmitted?.({
        conversationId: "conv-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "replayed",
      });
      return {
        conversationId: "conv-1",
        turnId: "turn-1",
        runId: "run-1",
        status: "replayed" as const,
      };
    });
    const application = {
      prepareAgentTurnIdentity,
      admitAgentTurn,
    } as unknown as ConversationDirectoryApplication;
    const adapter = createAnchorAdvancementOriginalTaskExecutionPort(application);
    const originalUserTask = {
      parts: [{ type: "text" as const, text: "继续原任务" }],
    };

    await expect(adapter.execute({
      conversationId: "conv-1",
      originalTurnId: "turn-1",
      originalUserTask,
      surface,
    })).resolves.toEqual({
      conversationId: "conv-1",
      turnId: "turn-1",
      runId: "run-1",
      runStatus: "queued",
    });
    expect(prepareAgentTurnIdentity).toHaveBeenCalledOnce();
    expect(prepareAgentTurnIdentity).toHaveBeenCalledWith({
      kind: "prepare-agent-turn-identity",
      turnId: "turn-1",
      identitySource: "provided",
      caller: {
        kind: "surface",
        surfacePrincipal: "surface-1",
        connectionId: "connection-1",
      },
    });
    expect(admitAgentTurn).toHaveBeenCalledOnce();
    expect(admitAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      kind: "admit-agent-turn",
      conversationId: "conv-1",
      input: originalUserTask,
      turnIdentity: prepared,
      turnOrigin: { channel: "rpc", triggeredBy: "connection-1" },
    }));
    expect(surfaceExecute).toHaveBeenCalledWith({
      conversationId: "conv-1",
      turnId: "turn-1",
      originalUserTask,
    });
    expect(surface.onAdmitted).toHaveBeenCalledOnce();
  });

  it("propagates Conversation admission failure without starting the surface effect", async () => {
    const surface = testSurface();
    const application = {
      prepareAgentTurnIdentity: () => ({
        turnId: "turn-1",
      }) as ConversationPreparedAgentTurnIdentity,
      admitAgentTurn: async () => {
        throw new Error("conversation admission failed");
      },
    } as unknown as ConversationDirectoryApplication;
    const adapter = createAnchorAdvancementOriginalTaskExecutionPort(application);

    await expect(adapter.execute({
      conversationId: "conv-1",
      originalTurnId: "turn-1",
      originalUserTask: {
        parts: [{ type: "text", text: "继续原任务" }],
      },
      surface,
    })).rejects.toThrow("conversation admission failed");
    expect(surface.execute).not.toHaveBeenCalled();
  });
});

function testSurface(
  overrides: Partial<AdvancementOriginalTaskSurfacePort> = {},
): AdvancementOriginalTaskSurfacePort {
  return Object.freeze({
    caller: Object.freeze({
      surfacePrincipal: "surface-1",
      connectionId: "connection-1",
    }),
    turnOrigin: Object.freeze({
      channel: "rpc",
      triggeredBy: "connection-1",
    }),
    execute: vi.fn(async () => undefined),
    cancelPending: vi.fn(),
    onAdmitted: vi.fn(),
    ...overrides,
  });
}
