import type {
  AdvancementAcceptedTurnReviewMechanismPort,
  AdvancementReviewProxySchedulePort,
} from "@zhixing/core/advancement/application";
import type { AdvancementController } from "./controller.js";
import type { AdvancementProxyTurnPort } from "./ports.js";
import { ProxyMessageScheduler } from "./proxy-scheduler.js";

/** A5-ADVANCEMENT-REVIEW-01: path-free delegation to the existing review mechanism. */
export function createAdvancementAcceptedTurnReviewMechanism(
  controller: Pick<AdvancementController, "afterTurnCommitted">,
): AdvancementAcceptedTurnReviewMechanismPort {
  return {
    reviewAcceptedTurn: (input) => controller.afterTurnCommitted(input),
  };
}

/** Keeps the existing proxy scheduling mechanics behind the Domain application port. */
export function createAdvancementReviewProxySchedulePort(
  proxyTurns: AdvancementProxyTurnPort,
): AdvancementReviewProxySchedulePort {
  return {
    async schedule(input) {
      await new ProxyMessageScheduler({ proxyTurns }).schedule(input);
    },
  };
}
