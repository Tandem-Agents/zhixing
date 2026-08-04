import type {
  AdvancementEvidenceProjection,
  AdvancementEvidenceGeneration,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementStoreEvent,
  AdvancementWindowState,
} from "./types.js";
import { MAX_ADVANCEMENT_PENDING_EVIDENCE } from "./types.js";

/** 折叠过程的可变会话形态——权威日志投影与纯折叠共用。 */
export interface MutableAdvancementSession {
  id: string;
  conversationId: string;
  status: AdvancementSession["status"];
  originalUserTask: AdvancementSession["originalUserTask"];
  createdAt: string;
  updatedAt: string;
  rubricDraftVersion: number;
  pendingRubricDraft?: AdvancementSession["pendingRubricDraft"];
  confirmedRubric?: AdvancementSession["confirmedRubric"];
  originalTaskAdmission?: AdvancementSession["originalTaskAdmission"];
  runs: AdvancementSession["runs"][number][];
  proxyMessages: AdvancementSession["proxyMessages"][number][];
  outstandingProxyMessageId?: string;
  advancementWindow?: AdvancementWindowState;
  evidencePending: AdvancementEvidenceProjection["pending"][number][];
  evidenceGenerations: AdvancementEvidenceGeneration[];
  exit?: AdvancementSession["exit"];
}

export type AdvancementFoldSession = MutableAdvancementSession;
export type AdvancementFoldMap = Map<string, AdvancementFoldSession>;

/** 事件序列折叠为按创建时间排序的会话列表——文件控制日志与权威日志共用。 */
export function foldAdvancementEvents(
  events: readonly AdvancementStoreEvent[],
): AdvancementSession[] {
  return freezeAdvancementSessions(foldAdvancementEventMap(events));
}

/** 事件序列折叠为可供批次门禁继续推演的内部地图。 */
export function foldAdvancementEventMap(
  events: readonly AdvancementStoreEvent[],
): AdvancementFoldMap {
  const sessions: AdvancementFoldMap = new Map();
  for (const event of events) {
    applyAdvancementEvent(sessions, event);
  }
  return sessions;
}

/** 折叠地图冻结为按创建时间排序的会话列表。 */
export function freezeAdvancementSessions(
  sessions: ReadonlyMap<string, MutableAdvancementSession>,
): AdvancementSession[] {
  return [...sessions.values()].map(freezeSession).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function applyAdvancementEvent(
  sessions: AdvancementFoldMap,
  event: AdvancementStoreEvent,
): void {
  switch (event.type) {
    case "session_created":
      sessions.set(event.sessionId, {
        id: event.sessionId,
        conversationId: event.conversationId,
        status: "awaiting-rubric-confirmation",
        originalUserTask: event.originalUserTask,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        rubricDraftVersion: 0,
        pendingRubricDraft: event.pendingRubricDraft,
        runs: [],
        proxyMessages: [],
        evidencePending: [],
        evidenceGenerations: [],
      });
      break;
    case "rubric_confirmed": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.status = "active";
      session.updatedAt = event.timestamp;
      session.confirmedRubric = event.confirmedRubric;
      session.originalTaskAdmission = {
        status: "pending",
        intent: event.admissionIntent,
      };
      session.pendingRubricDraft = undefined;
      break;
    }
    case "original_task_admitted": {
      const session = sessions.get(event.sessionId);
      const pending = session?.originalTaskAdmission;
      if (!session || !pending) return;
      session.updatedAt = event.timestamp;
      session.originalTaskAdmission = {
        status: "admitted",
        intent: pending.intent,
        runId: event.runId,
      };
      break;
    }
    case "rubric_draft_revised": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      session.rubricDraftVersion += 1;
      session.pendingRubricDraft = event.pendingRubricDraft;
      break;
    }
    case "run_reviewed": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      session.runs.push(event.review);
      break;
    }
    case "window_updated": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      session.advancementWindow = event.advancementWindow;
      break;
    }
    case "proxy_enqueued": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      session.proxyMessages.push(event.proxyMessage);
      session.outstandingProxyMessageId = event.proxyMessage.id;
      break;
    }
    case "proxy_settled": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      if (session.outstandingProxyMessageId === event.proxyMessageId) {
        session.outstandingProxyMessageId = undefined;
      }
      break;
    }
    case "evidence_requested": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      // 同一 review 的新 attempt 取代旧的未关闭请求——旧 attempt 的结果零推进。
      session.evidencePending = session.evidencePending.filter(
        (pending) => pending.reviewId !== event.attempt.reviewId,
      );
      if (session.evidencePending.length >= MAX_ADVANCEMENT_PENDING_EVIDENCE) {
        return;
      }
      session.evidencePending.push({ ...event.attempt });
      session.evidenceGenerations = [
        ...session.evidenceGenerations.filter(
          (entry) => entry.runId !== event.attempt.request.runId,
        ),
        {
          runId: event.attempt.request.runId,
          reviewId: event.attempt.reviewId,
          generation: event.attempt.generation,
          lastAttempt: event.attempt.attempt,
        },
      ];
      break;
    }
    case "evidence_result": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      const pending = session.evidencePending.find(
        (entry) => entry.requestId === event.requestId,
      );
      if (!pending) return;
      session.updatedAt = event.timestamp;
      session.evidencePending = session.evidencePending.map((entry) =>
        entry.requestId === event.requestId
          ? { ...entry, outcome: event.outcome }
          : entry,
      );
      break;
    }
    case "evidence_settled": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.updatedAt = event.timestamp;
      session.evidencePending = session.evidencePending.filter(
        (entry) => entry.requestId !== event.requestId,
      );
      break;
    }
    case "completed": {
      closeSession(sessions, event, "completed");
      break;
    }
    case "exited": {
      closeSession(sessions, event, "exited");
      break;
    }
    case "cancelled": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.status = "cancelled";
      session.updatedAt = event.timestamp;
      session.outstandingProxyMessageId = undefined;
      session.evidencePending = [];
      session.exit = event.exit;
      break;
    }
  }
}

function closeSession(
  sessions: AdvancementFoldMap,
  event: Extract<AdvancementStoreEvent, { type: "completed" | "exited" }>,
  status: "completed" | "exited",
): void {
  const session = sessions.get(event.sessionId);
  if (!session) return;
  session.status = status;
  session.updatedAt = event.timestamp;
  session.outstandingProxyMessageId = undefined;
  session.evidencePending = [];
  session.exit = event.exit;
}

function freezeSession(session: MutableAdvancementSession): AdvancementSession {
  return {
    id: session.id,
    conversationId: session.conversationId,
    status: session.status,
    originalUserTask: session.originalUserTask,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    rubricDraftVersion: session.rubricDraftVersion,
    pendingRubricDraft: session.pendingRubricDraft,
    confirmedRubric: session.confirmedRubric,
    originalTaskAdmission: session.originalTaskAdmission,
    runs: [...session.runs],
    proxyMessages: [...session.proxyMessages],
    outstandingProxyMessageId: session.outstandingProxyMessageId,
    advancementWindow: session.advancementWindow,
    ...(session.evidencePending.length > 0 || session.evidenceGenerations.length > 0
      ? {
          evidence: {
            pending: [...session.evidencePending],
            generations: [...session.evidenceGenerations],
          },
        }
      : {}),
    exit: session.exit,
  };
}

export function isOpenAdvancementSession(
  session: Pick<AdvancementSession, "status">,
): boolean {
  return (
    session.status === "awaiting-rubric-confirmation" ||
    session.status === "active"
  );
}

/** 会话的推进头状态：open 会话优先，否则最新终态会话。 */
export function advancementHeadSession(
  sessions: readonly AdvancementSession[],
): AdvancementSession | null {
  if (sessions.length === 0) return null;
  return sessions.find(isOpenAdvancementSession) ?? sessions[sessions.length - 1]!;
}

export function runReviewedEvents(
  sessionId: string,
  review: AdvancementRunReview,
  timestamp: string,
  advancementWindow: AdvancementWindowState | undefined,
): AdvancementStoreEvent[] {
  return [
    {
      type: "run_reviewed",
      timestamp,
      sessionId,
      review,
    },
    ...(advancementWindow
      ? [
          {
            type: "window_updated" as const,
            timestamp: advancementWindow.updatedAt,
            sessionId,
            advancementWindow,
          },
        ]
      : []),
  ];
}

export function assertTerminalReviewDecision(
  review: AdvancementRunReview,
  terminalType: "completed" | "exited",
): void {
  if (terminalType === "completed" && review.decision !== "passed") {
    throw new Error(
      `AdvancementStore: completed review must have decision "passed"`,
    );
  }
  if (terminalType === "exited" && review.decision !== "exit") {
    throw new Error(
      `AdvancementStore: exited review must have decision "exit"`,
    );
  }
}
