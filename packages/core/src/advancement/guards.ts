import type {
  AdvancementRunReview,
  AdvancementStoreEvent,
} from "./types.js";
import {
  applyAdvancementEvent,
  assertTerminalReviewDecision,
  isOpenAdvancementSession,
  type AdvancementFoldMap,
  type AdvancementFoldSession,
} from "./reducer.js";

/**
 * 一次推进写入的批次合法性谓词——权威日志写入侧的唯一领域门禁：与文件
 * 控制日志的写方法守卫同一规则集，按序在折叠副本上逐项验证并应用，
 * 任一事件不合法即整批拒绝，杜绝半组事件成为权威事实。
 */
export function assertAdvancementEventBatchLegal(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  events: readonly AdvancementStoreEvent[],
): void {
  if (events.length === 0) {
    throw new Error("AdvancementStore: write requires at least one event");
  }
  const sessionIds = new Set(events.map((event) => event.sessionId));
  if (sessionIds.size !== 1) {
    throw new Error(
      "AdvancementStore: write events must bind exactly one advancement session",
    );
  }
  const work: AdvancementFoldMap = new Map(
    [...sessions.entries()].map(([id, session]) => [
      id,
      structuredClone(session),
    ]),
  );
  let batchReview: AdvancementRunReview | undefined;
  for (const event of events) {
    switch (event.type) {
      case "session_created": {
        if (work.has(event.sessionId)) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" already exists`,
          );
        }
        if ([...work.values()].some(isOpenAdvancementSession)) {
          throw new Error(
            `AdvancementStore: conversation "${event.conversationId}" already has an open advancement session`,
          );
        }
        break;
      }
      case "rubric_confirmed": {
        requireAwaiting(work, event.sessionId);
        break;
      }
      case "rubric_draft_revised": {
        const session = requireAwaiting(work, event.sessionId);
        if (
          session.pendingRubricDraft &&
          event.pendingRubricDraft.originalTurnId !==
            session.pendingRubricDraft.originalTurnId
        ) {
          throw new Error(
            "AdvancementStore: revised draft belongs to another turn",
          );
        }
        break;
      }
      case "run_reviewed": {
        requireActive(work, event.sessionId);
        if (batchReview) {
          throw new Error(
            "AdvancementStore: write batch carries more than one run review",
          );
        }
        batchReview = event.review;
        break;
      }
      case "window_updated": {
        requireActive(work, event.sessionId);
        break;
      }
      case "proxy_enqueued": {
        const session = requireActive(work, event.sessionId);
        if (session.outstandingProxyMessageId) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" already has an outstanding proxy message`,
          );
        }
        if (event.proxyMessage.sessionId !== event.sessionId) {
          throw new Error(
            `AdvancementStore: proxy message "${event.proxyMessage.id}" belongs to another session`,
          );
        }
        if (batchReview) {
          if (batchReview.decision !== "failed") {
            throw new Error(
              "AdvancementStore: proxy message requires failed review",
            );
          }
          if (batchReview.proxyMessageId !== event.proxyMessage.id) {
            throw new Error(
              "AdvancementStore: review proxyMessageId must match proxy message",
            );
          }
        }
        break;
      }
      case "proxy_settled": {
        const session = requireActive(work, event.sessionId);
        if (session.outstandingProxyMessageId !== event.proxyMessageId) {
          throw new Error(
            `AdvancementStore: proxy message "${event.proxyMessageId}" is not outstanding`,
          );
        }
        break;
      }
      case "completed":
      case "exited": {
        requireActive(work, event.sessionId);
        if (batchReview) {
          assertTerminalReviewDecision(batchReview, event.type);
        }
        break;
      }
      case "cancelled": {
        const session = requireSession(work, event.sessionId);
        if (!isOpenAdvancementSession(session)) {
          throw new Error(
            `AdvancementStore: session "${event.sessionId}" is already closed`,
          );
        }
        break;
      }
      case "evidence_requested":
      case "evidence_result":
      case "evidence_settled": {
        requireActive(work, event.sessionId);
        break;
      }
    }
    applyAdvancementEvent(work, event);
  }
}

function requireSession(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`AdvancementStore: session "${sessionId}" not found`);
  }
  return session;
}

function requireAwaiting(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = requireSession(sessions, sessionId);
  if (session.status !== "awaiting-rubric-confirmation") {
    throw new Error(
      `AdvancementStore: session "${sessionId}" is not awaiting rubric confirmation`,
    );
  }
  return session;
}

function requireActive(
  sessions: ReadonlyMap<string, AdvancementFoldSession>,
  sessionId: string,
): AdvancementFoldSession {
  const session = requireSession(sessions, sessionId);
  if (session.status !== "active") {
    throw new Error(`AdvancementStore: session "${sessionId}" is not active`);
  }
  return session;
}
