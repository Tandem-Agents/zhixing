import { describe, expect, it, vi } from "vitest";
import {
  ProxyMessageScheduler as PublicProxyMessageScheduler,
  createAdvancementRecoveryMaintenance as publicCreateAdvancementRecoveryMaintenance,
  dispatchAdvancementReviewResult as publicDispatchAdvancementReviewResult,
} from "../../index.js";
import { ProxyMessageScheduler } from "../proxy-scheduler.js";
import { createAdvancementRecoveryMaintenance } from "../recovery-maintenance.js";
import { dispatchAdvancementReviewResult } from "../review-dispatch.js";

describe("advancement review dispatch compatibility", () => {
  it("routes changed public contracts through the server adapters", () => {
    expect(PublicProxyMessageScheduler).toBe(ProxyMessageScheduler);
    expect(publicCreateAdvancementRecoveryMaintenance).toBe(
      createAdvancementRecoveryMaintenance,
    );
    expect(publicDispatchAdvancementReviewResult).toBe(
      dispatchAdvancementReviewResult,
    );
  });

  it("preserves the server broadcast and conversation-manager contract", async () => {
    const broadcast = vi.fn();
    const admitTurn = vi.fn().mockResolvedValue({ status: "not-found" });

    await publicDispatchAdvancementReviewResult(
      {
        sessionBroadcast: () => broadcast,
        conversations: () => ({ admitTurn } as never),
        conversationExists: async () => true,
      },
      {
        conversationId: "conversation-1",
        runId: "run-1",
        result: {
          kind: "proxy-enqueued",
          session: {
            id: "advancement-1",
            conversationId: "conversation-1",
            runs: [],
          },
          review: { id: "review-1" },
          proxyMessage: { id: "proxy-1", content: "继续" },
        } as never,
      },
    );

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(admitTurn).toHaveBeenCalledOnce();
    expect(admitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-1",
        exists: expect.any(Function),
        makeTask: expect.any(Function),
      }),
    );
  });
});
