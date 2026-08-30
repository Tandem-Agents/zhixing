import { describe, expect, it, vi } from "vitest";
import { createAnchorConversationResumePort } from "./conversation-resume-binding.js";

describe("createAnchorConversationResumePort", () => {
  it("projects the persisted identity and binds recovery/adoption to one surface caller", async () => {
    const calls: string[] = [];
    const reviewForSurface = vi.fn(async () => ({
      status: "ready" as const,
      mergedConversationCount: 1,
      appliedRuleCount: 0,
      pendingScheduleCount: 1,
      pendingRuleCount: 0,
      message: "等待确认",
    }));
    const port = createAnchorConversationResumePort({
      identity: {
        touch: async (conversationId) => {
          calls.push(`touch:${conversationId}`);
          return {
            id: "local-id",
            name: "已恢复",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActiveAt: "2026-01-02T00:00:00.000Z",
          };
        },
      },
      recovery: {
        recoverConversation: async (conversationId) => {
          calls.push(`recover:${conversationId}`);
        },
      },
      adoptionReview: { reviewForSurface },
    });

    await expect(port.restoreIdentity("global-id")).resolves.toEqual({
      conversationId: "global-id",
      name: "已恢复",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-02T00:00:00.000Z",
    });
    await port.recoverDependentLifecycle("global-id");
    await expect(
      port.reviewAdoption?.({
        conversationId: "global-id",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:cli",
          connectionId: "7",
        },
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(calls).toEqual(["touch:global-id", "recover:global-id"]);
    expect(reviewForSurface).toHaveBeenCalledWith({
      conversationId: "global-id",
      surfacePrincipal: "rpc:cli",
      connectionId: "7",
    });
    await expect(
      port.reviewAdoption?.({
        conversationId: "global-id",
        caller: { kind: "host", component: "recovery" },
      }),
    ).resolves.toBeUndefined();
    expect(reviewForSurface).toHaveBeenCalledTimes(1);
  });
});
