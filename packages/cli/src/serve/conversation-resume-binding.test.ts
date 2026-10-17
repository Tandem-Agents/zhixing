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
      runReadiness: {
        prepareConversationReadiness: async (conversationId) => {
          calls.push(`ready:${conversationId}`);
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
    expect(calls).toEqual(["touch:global-id", "ready:global-id", "recover:global-id"]);
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

  it("keeps resume pending until selected run readiness is complete", async () => {
    let finish!: () => void;
    const readiness = new Promise<void>(resolve => { finish = resolve; });
    const recoverConversation = vi.fn(async () => undefined);
    const port = createAnchorConversationResumePort({
      identity: { touch: async () => null },
      runReadiness: { prepareConversationReadiness: async () => readiness },
      recovery: { recoverConversation },
      adoptionReview: { reviewForSurface: async () => undefined },
    });
    let settled = false;
    const pending = port.recoverDependentLifecycle("restored").then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(recoverConversation).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(recoverConversation).toHaveBeenCalledWith("restored");
  });
});
