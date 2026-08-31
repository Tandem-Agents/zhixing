import { describe, expect, it, vi } from "vitest";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { createAnchorConversationSecurityProjectionPort } from "../conversation-security-application.js";

describe("createAnchorConversationSecurityProjectionPort", () => {
  it("adapts the existing-only owner mechanism without defining result semantics", async () => {
    const snapshot = {
      contextId: { kind: "main" as const },
      workspacePath: null,
      permissionRules: [],
      builtinRules: [],
      rateLimits: [{ key: "bash", used: 1, limit: 5 }],
      confirmations: [{ key: "bash::pnpm", count: 2, highestRisk: "high" as const }],
    };
    const exists = vi.fn(async () => true);
    const inspectSecurityExisting = vi.fn(async (
      _conversationId: string,
      check: () => Promise<boolean>,
    ) => {
      expect(await check()).toBe(true);
      return { status: "done" as const, snapshot };
    });
    const port = createAnchorConversationSecurityProjectionPort({
      conversations: { inspectSecurityExisting } as unknown as ConversationManager,
      exists,
    });

    await expect(port.inspectSecurityExisting("conversation-1")).resolves.toEqual({
      status: "done",
      snapshot,
    });
    expect(inspectSecurityExisting).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenCalledWith("conversation-1");
  });

  it("preserves not-found and unsupported mechanism terminals", async () => {
    const inspectSecurityExisting = vi
      .fn()
      .mockResolvedValueOnce({ status: "not-found" })
      .mockResolvedValueOnce({ status: "unsupported" });
    const port = createAnchorConversationSecurityProjectionPort({
      conversations: { inspectSecurityExisting } as unknown as ConversationManager,
      exists: async () => true,
    });

    await expect(port.inspectSecurityExisting("missing")).resolves.toEqual({
      status: "not-found",
    });
    await expect(port.inspectSecurityExisting("unsupported")).resolves.toEqual({
      status: "unsupported",
    });
  });
});
