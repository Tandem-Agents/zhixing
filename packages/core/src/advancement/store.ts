import fs from "node:fs/promises";
import path from "node:path";
import { advancementLogPath, getAdvancementRoot } from "./paths.js";
import type {
  AdvancementCompletedEvent,
  AdvancementExit,
  AdvancementExitedEvent,
  AdvancementProxyEnqueuedEvent,
  AdvancementProxyMessage,
  AdvancementProxySettledEvent,
  AdvancementRubricDraftRevisedEvent,
  AdvancementRubricConfirmedEvent,
  AdvancementRunReview,
  AdvancementRunReviewedEvent,
  AdvancementSession,
  AdvancementSessionCreatedEvent,
  AdvancementStoreEvent,
  ConfirmedRubricSnapshot,
  CreateAdvancementSessionInput,
  RubricContractDraftSnapshot,
} from "./types.js";

export class AdvancementStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string = getAdvancementRoot()) {
    this.root = root;
  }

  async createSession(
    input: CreateAdvancementSessionInput,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(input.conversationId, async () => {
      const sessions = await this.loadConversationSessionsInLock(
        input.conversationId,
      );
      if (sessions.some((session) => session.id === input.id)) {
        throw new Error(
          `AdvancementStore: session "${input.id}" already exists`,
        );
      }
      if (sessions.some(isOpenSession)) {
        throw new Error(
          `AdvancementStore: conversation "${input.conversationId}" already has an open advancement session`,
        );
      }

      const timestamp = input.createdAt ?? new Date().toISOString();
      await this.appendEventInLock(input.conversationId, {
        type: "session_created",
        timestamp,
        sessionId: input.id,
        conversationId: input.conversationId,
        originalUserTask: input.originalUserTask,
        pendingRubricDraft: input.pendingRubricDraft,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(input.conversationId),
        input.id,
      );
    });
  }

  async confirmRubric(
    conversationId: string,
    sessionId: string,
    confirmedRubric: ConfirmedRubricSnapshot,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (session.status !== "awaiting-rubric-confirmation") {
        throw new Error(
          `AdvancementStore: session "${sessionId}" is not awaiting rubric confirmation`,
        );
      }
      await this.appendEventInLock(conversationId, {
        type: "rubric_confirmed",
        timestamp,
        sessionId,
        confirmedRubric,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async reviseRubricDraft(
    conversationId: string,
    sessionId: string,
    pendingRubricDraft: RubricContractDraftSnapshot,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (session.status !== "awaiting-rubric-confirmation") {
        throw new Error(
          `AdvancementStore: session "${sessionId}" is not awaiting rubric confirmation`,
        );
      }
      if (
        session.pendingRubricDraft &&
        pendingRubricDraft.originalTurnId !==
          session.pendingRubricDraft.originalTurnId
      ) {
        throw new Error(
          `AdvancementStore: revised draft belongs to another turn`,
        );
      }
      await this.appendEventInLock(conversationId, {
        type: "rubric_draft_revised",
        timestamp,
        sessionId,
        pendingRubricDraft,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async appendRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      await this.appendEventInLock(conversationId, {
        type: "run_reviewed",
        timestamp,
        sessionId,
        review,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async appendTerminalRunReview(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    terminal: {
      readonly type: "completed" | "exited";
      readonly exit: AdvancementExit;
      readonly timestamp?: string;
    },
    timestamp = review.reviewedAt,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      assertTerminalReviewDecision(review, terminal.type);
      await this.appendEventsInLock(conversationId, [
        {
          type: "run_reviewed",
          timestamp,
          sessionId,
          review,
        },
        {
          type: terminal.type,
          timestamp: terminal.timestamp ?? terminal.exit.occurredAt,
          sessionId,
          exit: terminal.exit,
        },
      ]);
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async enqueueProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessage: AdvancementProxyMessage,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (session.outstandingProxyMessageId) {
        throw new Error(
          `AdvancementStore: session "${sessionId}" already has an outstanding proxy message`,
        );
      }
      if (proxyMessage.sessionId !== sessionId) {
        throw new Error(
          `AdvancementStore: proxy message "${proxyMessage.id}" belongs to another session`,
        );
      }
      await this.appendEventInLock(conversationId, {
        type: "proxy_enqueued",
        timestamp,
        sessionId,
        proxyMessage,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async settleProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessageId: string,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (session.outstandingProxyMessageId !== proxyMessageId) {
        throw new Error(
          `AdvancementStore: proxy message "${proxyMessageId}" is not outstanding`,
        );
      }
      await this.appendEventInLock(conversationId, {
        type: "proxy_settled",
        timestamp,
        sessionId,
        proxyMessageId,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async completeSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.finishSession(conversationId, sessionId, {
      type: "completed",
      timestamp,
      sessionId,
      exit,
    });
  }

  async exitSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.finishSession(conversationId, sessionId, {
      type: "exited",
      timestamp,
      sessionId,
      exit,
    });
  }

  async cancelSession(
    conversationId: string,
    sessionId: string,
    exit?: AdvancementExit,
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (!isOpenSession(session)) {
        throw new Error(
          `AdvancementStore: session "${sessionId}" is already closed`,
        );
      }
      await this.appendEventInLock(conversationId, {
        type: "cancelled",
        timestamp,
        sessionId,
        exit,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null> {
    return (
      (await this.loadConversationSessions(conversationId)).find(
        (session) => session.id === sessionId,
      ) ?? null
    );
  }

  async loadActiveSession(
    conversationId: string,
  ): Promise<AdvancementSession | null> {
    return (
      (await this.loadConversationSessions(conversationId)).find(isOpenSession) ??
      null
    );
  }

  async loadConversationSessions(
    conversationId: string,
  ): Promise<AdvancementSession[]> {
    return await this.withConversationLock(conversationId, () =>
      this.loadConversationSessionsInLock(conversationId),
    );
  }

  async readEvents(conversationId: string): Promise<AdvancementStoreEvent[]> {
    return await this.withConversationLock(conversationId, () =>
      this.readEventsInLock(conversationId),
    );
  }

  private async finishSession(
    conversationId: string,
    sessionId: string,
    event: AdvancementCompletedEvent | AdvancementExitedEvent,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      await this.appendEventInLock(conversationId, event);
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  private async loadConversationSessionsInLock(
    conversationId: string,
  ): Promise<AdvancementSession[]> {
    const sessions = new Map<string, MutableAdvancementSession>();
    for (const event of await this.readEventsInLock(conversationId)) {
      applyEvent(sessions, event);
    }
    return [...sessions.values()].map(freezeSession).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  private async readEventsInLock(
    conversationId: string,
  ): Promise<AdvancementStoreEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(advancementLogPath(this.root, conversationId), "utf-8");
    } catch {
      return [];
    }

    const events: AdvancementStoreEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAdvancementStoreEvent(parsed)) events.push(parsed);
      } catch {
        continue;
      }
    }
    return events;
  }

  private async appendEventInLock(
    conversationId: string,
    event: AdvancementStoreEvent,
  ): Promise<void> {
    await this.appendEventsInLock(conversationId, [event]);
  }

  private async appendEventsInLock(
    conversationId: string,
    events: readonly AdvancementStoreEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const file = advancementLogPath(this.root, conversationId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }

  private async withConversationLock<T>(
    conversationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.locks.set(conversationId, tail);
    tail.then(() => {
      if (this.locks.get(conversationId) === tail) {
        this.locks.delete(conversationId);
      }
    });
    return result;
  }

  private requireSession(
    sessions: readonly AdvancementSession[],
    sessionId: string,
  ): AdvancementSession {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) {
      throw new Error(`AdvancementStore: session "${sessionId}" not found`);
    }
    return session;
  }

  private assertActiveSession(
    sessions: readonly AdvancementSession[],
    sessionId: string,
  ): AdvancementSession {
    const session = this.requireSession(sessions, sessionId);
    if (session.status !== "active") {
      throw new Error(`AdvancementStore: session "${sessionId}" is not active`);
    }
    return session;
  }
}

function assertTerminalReviewDecision(
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

interface MutableAdvancementSession {
  id: string;
  conversationId: string;
  status: AdvancementSession["status"];
  originalUserTask: AdvancementSession["originalUserTask"];
  createdAt: string;
  updatedAt: string;
  rubricDraftVersion: number;
  pendingRubricDraft?: AdvancementSession["pendingRubricDraft"];
  confirmedRubric?: AdvancementSession["confirmedRubric"];
  runs: AdvancementRunReview[];
  proxyMessages: AdvancementProxyMessage[];
  outstandingProxyMessageId?: string;
  exit?: AdvancementExit;
}

function applyEvent(
  sessions: Map<string, MutableAdvancementSession>,
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
      });
      break;
    case "rubric_confirmed": {
      const session = sessions.get(event.sessionId);
      if (!session) return;
      session.status = "active";
      session.updatedAt = event.timestamp;
      session.confirmedRubric = event.confirmedRubric;
      session.pendingRubricDraft = undefined;
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
      session.exit = event.exit;
      break;
    }
  }
}

function closeSession(
  sessions: Map<string, MutableAdvancementSession>,
  event: AdvancementCompletedEvent | AdvancementExitedEvent,
  status: "completed" | "exited",
): void {
  const session = sessions.get(event.sessionId);
  if (!session) return;
  session.status = status;
  session.updatedAt = event.timestamp;
  session.outstandingProxyMessageId = undefined;
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
    runs: [...session.runs],
    proxyMessages: [...session.proxyMessages],
    outstandingProxyMessageId: session.outstandingProxyMessageId,
    exit: session.exit,
  };
}

function isOpenSession(session: Pick<AdvancementSession, "status">): boolean {
  return (
    session.status === "awaiting-rubric-confirmation" ||
    session.status === "active"
  );
}

function isAdvancementStoreEvent(value: unknown): value is AdvancementStoreEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<AdvancementStoreEvent>;
  if (typeof event.type !== "string") return false;
  if (typeof event.timestamp !== "string") return false;
  if (typeof event.sessionId !== "string") return false;
  switch (event.type) {
    case "session_created":
      return (
        typeof (event as Partial<AdvancementSessionCreatedEvent>)
          .conversationId === "string" &&
        typeof (event as Partial<AdvancementSessionCreatedEvent>)
          .pendingRubricDraft === "object" &&
        typeof (event as Partial<AdvancementSessionCreatedEvent>)
          .originalUserTask === "object"
      );
    case "rubric_confirmed":
      return typeof (event as Partial<AdvancementRubricConfirmedEvent>)
        .confirmedRubric === "object";
    case "rubric_draft_revised":
      return typeof (event as Partial<AdvancementRubricDraftRevisedEvent>)
        .pendingRubricDraft === "object";
    case "run_reviewed":
      return typeof (event as Partial<AdvancementRunReviewedEvent>).review ===
        "object";
    case "proxy_enqueued":
      return typeof (event as Partial<AdvancementProxyEnqueuedEvent>)
        .proxyMessage === "object";
    case "proxy_settled":
      return typeof (event as Partial<AdvancementProxySettledEvent>)
        .proxyMessageId === "string";
    case "completed":
      return typeof (event as Partial<AdvancementCompletedEvent>).exit ===
        "object";
    case "exited":
      return typeof (event as Partial<AdvancementExitedEvent>).exit === "object";
    case "cancelled":
      return true;
    default:
      return false;
  }
}
