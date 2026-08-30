import { describe, expect, it, vi } from "vitest";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { createAnchorConversationCompactPort } from "../conversation-compact-application.js";

describe("createAnchorConversationCompactPort", () => {
  it("delegates one existing-conversation maintenance and projects applied window data", async () => {
    const exists = vi.fn(async () => true);
    const compactExisting = vi.fn(async (
      _conversationId: string,
      check: () => Promise<boolean>,
    ) => {
      expect(await check()).toBe(true);
      return {
        status: "done" as const,
        outcome: {
          modified: true,
          windowCompact: {
            summary: "摘要",
            pairsCompacted: 2,
            tokensBefore: 1_000,
            tokensAfter: 100,
          },
          emergencyFloor: { droppedTurns: 1, error: "summary degraded" },
        },
      };
    });
    const port = createAnchorConversationCompactPort({
      conversations: { compactExisting } as unknown as ConversationManager,
      exists,
    });

    await expect(port.compactExisting("conversation-1")).resolves.toEqual({
      status: "done",
      outcome: {
        runtimeModified: true,
        windowApplied: true,
        tokensBefore: 1_000,
        tokensAfter: 100,
        emergencyFloor: { droppedTurns: 1, error: "summary degraded" },
      },
    });
    expect(compactExisting).toHaveBeenCalledOnce();
    expect(compactExisting).toHaveBeenCalledWith(
      "conversation-1",
      expect.any(Function),
    );
    expect(exists).toHaveBeenCalledWith("conversation-1");
  });

  it("preserves no-window and non-success mechanism terminals without inventing state", async () => {
    const compactExisting = vi
      .fn()
      .mockResolvedValueOnce({
        status: "done",
        outcome: { modified: true },
      })
      .mockResolvedValueOnce({ status: "busy" })
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValueOnce({ status: "unsupported" });
    const port = createAnchorConversationCompactPort({
      conversations: { compactExisting } as unknown as ConversationManager,
      exists: async () => true,
    });

    await expect(port.compactExisting("conversation-1")).resolves.toEqual({
      status: "done",
      outcome: { runtimeModified: true, windowApplied: false },
    });
    await expect(port.compactExisting("conversation-1")).resolves.toEqual({
      status: "busy",
    });
    await expect(port.compactExisting("conversation-1")).resolves.toEqual({
      status: "not-found",
    });
    await expect(port.compactExisting("conversation-1")).resolves.toEqual({
      status: "unsupported",
    });
  });
});
