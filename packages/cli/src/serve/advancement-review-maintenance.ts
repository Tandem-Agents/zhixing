import {
  SESSION_NOTIFICATIONS,
  ProxyMessageScheduler,
  createControlSessionEventEnvelope,
  type AdvancementController,
  type AdvancementTurnReviewResult,
  type ConversationManager,
  type SessionBroadcast,
  type TurnCommittedInfo,
} from "@zhixing/server";

export interface AdvancementReviewMaintenanceDeps {
  readonly advancement?: AdvancementController;
  readonly sessionBroadcast: () => SessionBroadcast | null;
  readonly conversations?: () => ConversationManager | null;
}

export function createAdvancementReviewMaintenance(
  deps: AdvancementReviewMaintenanceDeps,
): (info: TurnCommittedInfo) => void {
  const chains = new Map<string, Promise<void>>();

  return (info) => {
    if (!deps.advancement) return;
    if (info.ephemeral) return;
    const previous = chains.get(info.conversationId) ?? Promise.resolve();
    const current = previous.then(() => reviewAcceptedTurn(deps, info));
    const tail = current.catch(() => {});
    chains.set(info.conversationId, tail);
    void tail.finally(() => {
      if (chains.get(info.conversationId) === tail) {
        chains.delete(info.conversationId);
      }
    });
  };
}

async function reviewAcceptedTurn(
  deps: AdvancementReviewMaintenanceDeps,
  info: TurnCommittedInfo,
): Promise<void> {
  const advancement = deps.advancement;
  if (!advancement) return;
  const result = await advancement.afterTurnCommitted({
    conversationId: info.conversationId,
    runIndex: info.runIndex,
    runRecord: info.runRecord,
    runRecordRef: info.runRecordRef,
  });
  emitReviewEvents(deps, info, result);
  await scheduleProxyMessage(deps, result);
}

function emitReviewEvents(
  deps: AdvancementReviewMaintenanceDeps,
  info: TurnCommittedInfo,
  result: AdvancementTurnReviewResult,
): void {
  if (result.kind === "skipped") return;
  const broadcast = deps.sessionBroadcast();
  if (!broadcast) return;
  const runId = info.turnId;
  broadcast(
    info.conversationId,
    SESSION_NOTIFICATIONS.event,
    createControlSessionEventEnvelope({
      conversationId: info.conversationId,
      runId,
      seq: 0,
      event: "advancement:run_reviewed",
      payload: {
        advancementSessionId: result.session.id,
        review: result.review,
      },
    }),
  );

  if (result.kind === "proxy-enqueued") {
    broadcast(
      info.conversationId,
      SESSION_NOTIFICATIONS.event,
      createControlSessionEventEnvelope({
        conversationId: info.conversationId,
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
    info.conversationId,
    SESSION_NOTIFICATIONS.event,
    createControlSessionEventEnvelope({
      conversationId: info.conversationId,
      runId,
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
  deps: AdvancementReviewMaintenanceDeps,
  result: AdvancementTurnReviewResult,
): Promise<void> {
  if (result.kind !== "proxy-enqueued") return;
  const manager = deps.conversations?.();
  if (!manager) return;
  await new ProxyMessageScheduler({
    manager,
    sessionBroadcast: deps.sessionBroadcast,
  }).schedule({
    session: result.session,
    proxyMessage: result.proxyMessage,
  });
}
