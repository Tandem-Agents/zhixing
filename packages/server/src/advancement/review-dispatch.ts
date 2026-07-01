import type { SessionBroadcast } from "../rpc/session-broadcast.js";
import { createControlSessionEventEnvelope } from "../rpc/session-events.js";
import { SESSION_NOTIFICATIONS } from "../rpc/session-wire.js";
import type { ConversationManager } from "../runtime/conversation-manager.js";
import type { AdvancementTurnReviewResult } from "./controller.js";
import { ProxyMessageScheduler } from "./proxy-scheduler.js";

export interface AdvancementReviewDispatchDeps {
  readonly sessionBroadcast: () => SessionBroadcast | null;
  readonly conversations?: () => ConversationManager | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export interface AdvancementReviewDispatchInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly result: AdvancementTurnReviewResult;
  readonly emitProxyEnqueued?: boolean;
  readonly scheduleProxy?: boolean;
}

export async function dispatchAdvancementReviewResult(
  deps: AdvancementReviewDispatchDeps,
  input: AdvancementReviewDispatchInput,
): Promise<void> {
  emitReviewEvents(deps, input);
  if (input.scheduleProxy === false) return;
  await scheduleProxyMessage(deps, input.result);
}

function emitReviewEvents(
  deps: AdvancementReviewDispatchDeps,
  input: AdvancementReviewDispatchInput,
): void {
  const result = input.result;
  if (result.kind === "skipped") return;
  const broadcast = deps.sessionBroadcast();
  if (!broadcast) return;

  broadcast(
    input.conversationId,
    SESSION_NOTIFICATIONS.event,
    createControlSessionEventEnvelope({
      conversationId: input.conversationId,
      runId: input.runId,
      seq: 0,
      event: "advancement:run_reviewed",
      payload: {
        advancementSessionId: result.session.id,
        review: result.review,
      },
    }),
  );

  if (result.kind === "proxy-enqueued") {
    if (input.emitProxyEnqueued === false) return;
    broadcast(
      input.conversationId,
      SESSION_NOTIFICATIONS.event,
      createControlSessionEventEnvelope({
        conversationId: input.conversationId,
        runId: result.proxyMessage.id,
        seq: 1,
        event: "advancement:proxy_enqueued",
        payload: {
          advancementSessionId: result.session.id,
          proxyMessageId: result.proxyMessage.id,
          reviewId: result.review.id,
        },
      }),
    );
    return;
  }

  if (result.kind !== "completed" && result.kind !== "exited") return;
  broadcast(
    input.conversationId,
    SESSION_NOTIFICATIONS.event,
    createControlSessionEventEnvelope({
      conversationId: input.conversationId,
      runId: input.runId,
      seq: 1,
      event:
        result.kind === "completed"
          ? "advancement:completed"
          : "advancement:exited",
      payload: {
        advancementSessionId: result.session.id,
        reviewId: result.review.id,
        exit: result.exit,
      },
    }),
  );
}

async function scheduleProxyMessage(
  deps: AdvancementReviewDispatchDeps,
  result: AdvancementTurnReviewResult,
): Promise<void> {
  if (result.kind !== "proxy-enqueued") return;
  const manager = deps.conversations?.();
  if (!manager) return;
  await new ProxyMessageScheduler({
    manager,
    sessionBroadcast: deps.sessionBroadcast,
    conversationExists: deps.conversationExists,
  }).schedule({
    session: result.session,
    proxyMessage: result.proxyMessage,
  });
}
