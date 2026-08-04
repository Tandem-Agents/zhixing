import fs from "node:fs/promises";
import path from "node:path";
import { isAdvancementControlEvent } from "./event-codec.js";
import { assertAdvancementEventBatchLegal } from "./guards.js";
import {
  advancementConversationDir,
  advancementLogPath,
  getAdvancementRoot,
} from "./paths.js";
import {
  assertTerminalReviewDecision,
  applyAdvancementEvent,
  foldAdvancementEventMap,
  foldAdvancementEvents,
  isOpenAdvancementSession,
  runReviewedEvents,
  type AdvancementFoldMap,
} from "./reducer.js";
import type {
  AdvancementCompletedEvent,
  AdvancementExit,
  AdvancementExitedEvent,
  AdvancementProxyMessage,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementStoreEvent,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  CreateAdvancementSessionInput,
  RubricContractDraftSnapshot,
} from "./types.js";

/** 文件控制日志的容错重放只作结构校验——签名载荷在写入侧已被真实验签。 */
const REPLAY_VERIFIER = { verify: () => {} };

export class AdvancementStore {
  private readonly root: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string = getAdvancementRoot()) {
    this.root = root;
  }

  /**
   * 删除一个对话的全部推进控制数据——控制日志是对话的附属控制面数据，
   * 生命周期跟随对话本体；对话删除时连带调用。幂等（目录不存在即成功）。
   */
  async removeConversation(conversationId: string): Promise<void> {
    await this.withConversationLock(conversationId, async () => {
      await fs.rm(advancementConversationDir(this.root, conversationId), {
        recursive: true,
        force: true,
      });
    });
  }

  /**
   * 孤儿目录清理——枚举控制日志根目录，删除对应对话已不存在的目录
   * （对话侧与本目录同用安全路径投影编码，目录名可直接比对）。
   * 幂等；单点失败跳过并计入 warnings，不拖垮整轮。
   */
  async sweepOrphanDirs(
    isConversationDirAlive: (dirName: string) => Promise<boolean>,
  ): Promise<{ scanned: number; removed: number; warnings: string[] }> {
    const warnings: string[] = [];
    let scanned = 0;
    let removed = 0;
    let dirNames: string[];
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      dirNames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return { scanned, removed, warnings };
    }
    for (const name of dirNames) {
      const entry = { name };
      scanned++;
      try {
        if (await isConversationDirAlive(entry.name)) continue;
        await fs.rm(path.join(this.root, entry.name), {
          recursive: true,
          force: true,
        });
        removed++;
      } catch (err) {
        warnings.push(
          `${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { scanned, removed, warnings };
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
      if (sessions.some(isOpenAdvancementSession)) {
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
    admissionIntent: import("./types.js").AdvancementOriginalTaskAdmissionIntent,
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
        admissionIntent,
      });
      return this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
    });
  }

  async settleOriginalTaskAdmission(
    conversationId: string,
    sessionId: string,
    settlement: { readonly turnId: string; readonly inputDigest: import("../types/distributed.js").Digest; readonly runId: string },
    timestamp = new Date().toISOString(),
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      await this.appendEventInLock(conversationId, {
        type: "original_task_admitted",
        timestamp,
        sessionId,
        ...settlement,
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
    advancementWindow?: AdvancementWindowState,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      await this.appendEventsInLock(
        conversationId,
        runReviewedEvents(sessionId, review, timestamp, advancementWindow),
      );
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
    advancementWindow?: AdvancementWindowState,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      assertTerminalReviewDecision(review, terminal.type);
      await this.appendEventsInLock(conversationId, [
        ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
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

  async appendRunReviewWithProxyMessage(
    conversationId: string,
    sessionId: string,
    review: AdvancementRunReview,
    proxyMessage: AdvancementProxyMessage,
    timestamp = review.reviewedAt,
    advancementWindow?: AdvancementWindowState,
  ): Promise<AdvancementSession> {
    return await this.withConversationLock(conversationId, async () => {
      const session = this.assertActiveSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      if (review.decision !== "failed") {
        throw new Error(
          `AdvancementStore: proxy message requires failed review`,
        );
      }
      if (review.proxyMessageId !== proxyMessage.id) {
        throw new Error(
          `AdvancementStore: review proxyMessageId must match proxy message`,
        );
      }
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
      await this.appendEventsInLock(conversationId, [
        ...runReviewedEvents(sessionId, review, timestamp, advancementWindow),
        {
          type: "proxy_enqueued",
          timestamp: proxyMessage.createdAt,
          sessionId,
          proxyMessage,
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
      const session = this.requireSession(
        await this.loadConversationSessionsInLock(conversationId),
        sessionId,
      );
      const knownProxy = session.proxyMessages.some(
        (message) => message.id === proxyMessageId,
      );
      if (knownProxy && session.outstandingProxyMessageId !== proxyMessageId) {
        return session;
      }
      if (session.status !== "active") {
        throw new Error(
          `AdvancementStore: session "${sessionId}" is not active`,
        );
      }
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
      if (!isOpenAdvancementSession(session)) {
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
      (await this.loadConversationSessions(conversationId)).find(isOpenAdvancementSession) ??
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
    return foldAdvancementEvents(
      await this.readEventsInLock(conversationId),
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
    const fold: AdvancementFoldMap = new Map();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isAdvancementControlEvent(parsed, REPLAY_VERIFIER)) continue;
        assertAdvancementEventBatchLegal(fold, [parsed]);
        applyAdvancementEvent(fold, parsed);
        events.push(parsed);
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
    const persistedEvents: AdvancementStoreEvent[] = [];
    for (const event of events) {
      const eventType = event.type;
      const persisted: unknown = JSON.parse(JSON.stringify(event));
      if (!isAdvancementControlEvent(persisted, REPLAY_VERIFIER)) {
        throw new Error(
          `AdvancementStore: invalid advancement event "${eventType}"`,
        );
      }
      persistedEvents.push(persisted);
    }
    assertAdvancementEventBatchLegal(
      foldAdvancementEventMap(await this.readEventsInLock(conversationId)),
      persistedEvents,
    );
    const file = advancementLogPath(this.root, conversationId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(
      file,
      `${persistedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
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
