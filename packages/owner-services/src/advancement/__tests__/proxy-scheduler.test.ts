import { describe, expect, it, vi } from "vitest";
import type { AdvancementProxyMessage, AdvancementSession } from "@zhixing-ai/core/advancement";
import { createAdvancementReviewProxySchedulePort } from "../proxy-scheduler.js";
import type { AdvancementProxyTurnPort } from "../ports.js";

describe("ProxyMessageScheduler · advancement-proxy messageIdentity", () => {
  it("attaches advancement-proxy MessageInputIdentity onto proxy turnContext", async () => {
    const schedule = vi.fn<AdvancementProxyTurnPort["schedule"]>(async () => ({
      accepted: true,
    }));
    const port = createAdvancementReviewProxySchedulePort({ schedule });
    const session = {
      id: "adv-session-1",
      conversationId: "conv-adv-1",
    } as AdvancementSession;
    const proxyMessage = {
      id: "proxy-msg-1",
      content: "继续推进下一步检查",
      reviewId: "review-1",
      rubricFailureHandlingId: "rfh-1",
    } as AdvancementProxyMessage;

    await port.schedule({ session, proxyMessage });

    expect(schedule).toHaveBeenCalledTimes(1);
    const arg = schedule.mock.calls[0]?.[0];
    expect(arg?.turnContext).toEqual({
      turnId: "proxy-msg-1",
      turnOrigin: {
        channel: "advancement",
        triggeredBy: "proxy-msg-1",
        messageIdentity: {
          id: "proxy-msg-1",
          source: { kind: "system", subsystem: "advancement-proxy" },
        },
      },
    });
  });
});
