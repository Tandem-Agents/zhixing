import { describe, expect, it, vi } from "vitest";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { createAnchorConversationUsageProjectionPort } from "../conversation-usage-application.js";

describe("createAnchorConversationUsageProjectionPort", () => {
  it("keeps context-budget and full usage mechanisms distinct", async () => {
    const budget = {
      contextWindow: 100,
      effectiveWindow: 90,
      currentTokens: 10,
      usageRatio: 1 / 9,
      status: "normal" as const,
    };
    const exists = vi.fn(async () => true);
    const inspectContextBudgetExisting = vi.fn(async (
      _conversationId: string,
      check: () => Promise<boolean>,
    ) => {
      expect(await check()).toBe(true);
      return {
        status: "done" as const,
        budget,
        turnCount: 2,
        calibrationFactor: 1.1,
      };
    });
    const inspectUsageExisting = vi.fn(async (
      _conversationId: string,
      check: () => Promise<boolean>,
    ) => {
      expect(await check()).toBe(true);
      return {
        status: "done" as const,
        budget,
        turnCount: 2,
        calibrationFactor: 1.1,
        subUsages: [{
          index: 0,
          description: "delegate",
          tokens: 7,
          toolUses: 1,
          status: "succeeded" as const,
        }],
      };
    });
    const port = createAnchorConversationUsageProjectionPort({
      conversations: {
        inspectContextBudgetExisting,
        inspectUsageExisting,
      } as unknown as ConversationManager,
      exists,
    });

    await expect(
      port.inspectContextBudgetExisting("conversation-1"),
    ).resolves.toEqual({
      status: "done",
      outcome: { budget, turnCount: 2, calibrationFactor: 1.1 },
    });
    expect(inspectUsageExisting).not.toHaveBeenCalled();

    await expect(port.inspectUsageExisting("conversation-1")).resolves.toEqual({
      status: "done",
      outcome: {
        budget,
        turnCount: 2,
        calibrationFactor: 1.1,
        subUsages: [{
          index: 0,
          description: "delegate",
          tokens: 7,
          toolUses: 1,
          status: "succeeded",
        }],
      },
    });
    expect(inspectContextBudgetExisting).toHaveBeenCalledOnce();
    expect(inspectUsageExisting).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenNthCalledWith(1, "conversation-1");
    expect(exists).toHaveBeenNthCalledWith(2, "conversation-1");
  });

  it("preserves all non-success mechanism terminals", async () => {
    const inspectContextBudgetExisting = vi
      .fn()
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValueOnce({ status: "unsupported" });
    const inspectUsageExisting = vi
      .fn()
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValueOnce({ status: "unsupported" });
    const port = createAnchorConversationUsageProjectionPort({
      conversations: {
        inspectContextBudgetExisting,
        inspectUsageExisting,
      } as unknown as ConversationManager,
      exists: async () => true,
    });

    await expect(port.inspectContextBudgetExisting("missing")).resolves.toEqual({
      status: "not-found",
    });
    await expect(port.inspectContextBudgetExisting("unsupported")).resolves.toEqual({
      status: "unsupported",
    });
    await expect(port.inspectUsageExisting("missing")).resolves.toEqual({
      status: "not-found",
    });
    await expect(port.inspectUsageExisting("unsupported")).resolves.toEqual({
      status: "unsupported",
    });
  });
});
