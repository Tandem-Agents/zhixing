import type { AdvancementReviewRootContract } from "@zhixing/core";
import {
  AdvancementReviewAttemptApplicationService,
  type AdvancementClosureSynthesizer,
  type AdvancementReviewAttemptApplication,
  type AdvancementReviewAttemptMechanismPort,
  type AdvancementReviewAttemptStatePort,
  type AdvancementReviewRootLifecyclePort,
} from "@zhixing/core/advancement/application";
import type {
  AuthorityCallContext,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import type { AdvancementSessionStore } from "./session-store.js";

export interface AdvancementReviewAttemptCorrectnessOptions {
  readonly store: AdvancementSessionStore;
  readonly resources: ResourceReservationPort;
  readonly mechanism: AdvancementReviewAttemptMechanismPort;
  readonly reviewerAvailable: boolean;
  readonly sessionTokenBudget?: number;
  readonly closureSynthesizer?: AdvancementClosureSynthesizer;
  readonly now?: () => string;
  readonly reviewIdGenerator?: () => string;
  readonly proxyIdGenerator?: () => string;
}

/**
 * Correctness binding for the Advancement-owned attempt state machine.
 * It exposes persistence and immediate-root mechanics without owning phase,
 * generation, winner or cleanup decisions.
 */
export function createAdvancementReviewAttemptApplication(
  options: AdvancementReviewAttemptCorrectnessOptions,
): AdvancementReviewAttemptApplication {
  const state: AdvancementReviewAttemptStatePort = {
    loadActiveSession: (conversationId) =>
      options.store.loadActiveSession(conversationId),
    loadSession: (conversationId, sessionId) =>
      options.store.loadSession(conversationId, sessionId),
    loadConversationSessions: (conversationId) =>
      options.store.loadConversationSessions(conversationId),
    transitionReviewAttempt: (
      conversationId,
      sessionId,
      attempt,
      timestamp,
    ) =>
      options.store.transitionReviewAttempt(
        conversationId,
        sessionId,
        attempt,
        timestamp,
      ),
    cancelSession: (conversationId, sessionId, exit, timestamp) =>
      options.store.cancelSession(conversationId, sessionId, exit, timestamp),
    settleProxyMessage: (conversationId, sessionId, proxyMessageId, timestamp) =>
      options.store.settleProxyMessage(
        conversationId,
        sessionId,
        proxyMessageId,
        timestamp,
      ),
    enqueueProxyMessage: (conversationId, sessionId, proxyMessage, timestamp) =>
      options.store.enqueueProxyMessage(
        conversationId,
        sessionId,
        proxyMessage,
        timestamp,
      ),
    commitReviewOutcome: (decision) =>
      decision.kind === "terminal"
        ? options.store.appendTerminalRunReview(
            decision.conversationId,
            decision.sessionId,
            decision.review,
            decision.terminal,
            decision.timestamp,
            decision.advancementWindow,
            decision.evidenceRequestId,
            decision.reviewAttempt,
          )
        : options.store.appendRunReviewWithProxyMessage(
            decision.conversationId,
            decision.sessionId,
            decision.review,
            decision.proxyMessage,
            decision.timestamp,
            decision.advancementWindow,
            decision.evidenceRequestId,
            decision.reviewAttempt,
          ),
  };
  const roots: AdvancementReviewRootLifecyclePort = {
    inspect: (root) => options.resources.inspectImmediateRoot(root.workload),
    acquire: (root, deadlineMs) =>
      options.resources.acquireRoot(
        root.workload,
        root.budget,
        { admissionClass: "advancement", entry: "advancement-control" },
        rootContext(root, deadlineMs),
        root.audience,
        root.scopeBinding,
      ),
    settle: (root, lease) =>
      options.resources.settle(lease, rootContext(root)),
    release: (root, lease) =>
      options.resources.release(lease, rootContext(root)),
  };
  return new AdvancementReviewAttemptApplicationService({
    state,
    roots,
    mechanism: options.mechanism,
    reviewerAvailable: options.reviewerAvailable,
    ...(options.sessionTokenBudget !== undefined
      ? { sessionTokenBudget: options.sessionTokenBudget }
      : {}),
    ...(options.closureSynthesizer
      ? { closureSynthesizer: options.closureSynthesizer }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.reviewIdGenerator
      ? { reviewIdGenerator: options.reviewIdGenerator }
      : {}),
    ...(options.proxyIdGenerator
      ? { proxyIdGenerator: options.proxyIdGenerator }
      : {}),
  });
}

function rootContext(
  root: AdvancementReviewRootContract,
  deadlineMs = 120_000,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "advancement-review" },
    requestId: root.requestId,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  };
}
