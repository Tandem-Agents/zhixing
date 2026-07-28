import {
  ExecutionFinalityProjection,
  type ExecutionProjectionSubject,
} from "@zhixing/core/protocol";
import type {
  ExecutionStatusNotice,
  FinalFrame,
  SealedBundle,
  StreamFrame,
} from "@zhixing/core/contracts";

export interface ExecutionStatusCursor {
  readonly subject: ExecutionProjectionSubject;
  readonly afterStatusRevision: number;
}

type ExecutionStatusCursorFor<
  TExecution extends ExecutionProjectionSubject["execution"],
> = ExecutionStatusCursor & {
  readonly subject: Extract<
    ExecutionProjectionSubject,
    { readonly execution: TExecution }
  >;
};

/** 三域权威 live/history 的组合根聚合面:会话只消费,不接触权威存储。 */
export interface ExecutionFinalitySources {
  subscribe(
    listener: (notice: ExecutionStatusNotice) => void | Promise<void>,
  ): () => void;
  statusHistory(cursors: readonly ExecutionStatusCursor[]): Promise<{
    readonly notices: readonly ExecutionStatusNotice[];
    readonly next: readonly ExecutionStatusCursor[];
  }>;
}

export interface FirstPartyFinalitySessionOptions {
  readonly sources: ExecutionFinalitySources;
  /** 调用方 last-seen 游标:断线重连后从这里重建,零跳失。 */
  readonly lastSeen: readonly ExecutionStatusCursor[];
  readonly onStatus: (notice: ExecutionStatusNotice) => void | Promise<void>;
  readonly onConversationFinal?: (frame: FinalFrame) => void | Promise<void>;
  /**
   * 消费者未接管某个权威通知时，当前投影不能再声称连续。调用方必须
   * 终止所属连接/订阅，并让客户端携自己的 last-seen 重新建立会话。
   */
  readonly onResyncRequired?: (
    error: FirstPartyFinalityResyncRequiredError,
  ) => void;
}

export class FirstPartyFinalityResyncRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FirstPartyFinalityResyncRequiredError";
  }
}

/**
 * 单个已认证第一方 RPC/surface 会话的状态与最终性投影。
 *
 * 合并次序是合同:先恢复 live 订阅并让乱序通知进入缓冲,再按权威
 * revision 水位分页补读历史,补读推进使缓冲事件按序释放并转入实时消费。
 * 三域 revision 各自独立推进;本投影只缓存合并状态、不写权威事实,
 * 渠道投递不经过它——渠道语义仍由 DeliveryAuthority/DeliveryOutbox 承载。
 */
export class FirstPartyFinalitySession {
  readonly #sources: ExecutionFinalitySources;
  readonly #projection: ExecutionFinalityProjection;
  readonly #onResyncRequired:
    | FirstPartyFinalitySessionOptions["onResyncRequired"]
    | undefined;
  #cursors: readonly ExecutionStatusCursor[];
  #unsubscribe: (() => void) | undefined;
  #serial: Promise<void> = Promise.resolve();
  #failure: FirstPartyFinalityResyncRequiredError | undefined;
  #closed = false;

  constructor(options: FirstPartyFinalitySessionOptions) {
    this.#sources = options.sources;
    this.#cursors = options.lastSeen;
    this.#onResyncRequired = options.onResyncRequired;
    this.#projection = new ExecutionFinalityProjection({
      afterStatusRevision: new Map(
        options.lastSeen.map((cursor) => [
          ExecutionFinalityProjection.subjectKey(cursor.subject),
          cursor.afterStatusRevision,
        ]),
      ),
      onStatus: options.onStatus,
      ...(options.onConversationFinal
        ? { onConversationFinal: options.onConversationFinal }
        : {}),
    });
  }

  /** 先订阅缓冲,再分页补读至权威水位;完成后即处于实时消费态。 */
  async start(): Promise<void> {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#sources.subscribe((notice) =>
      this.#enqueue(() => this.#projection.acceptStatus(notice).then(() => undefined)),
    );
    await this.#enqueue(async () => {
      let cursors = this.#cursors;
      while (!this.#closed && cursors.length > 0) {
        const page = await this.#sources.statusHistory(cursors);
        const previous = cursorMap(cursors);
        const next = cursorMap(page.next);
        if (
          previous.size !== next.size ||
          [...previous.keys()].some((key) => !next.has(key))
        ) {
          throw new TypeError(
            "Finality history returned a different subject cursor set",
          );
        }
        for (const notice of page.notices) {
          const key = ExecutionFinalityProjection.subjectKey(notice.ref);
          if (!previous.has(key)) {
            throw new TypeError(
              "Finality history returned an unrequested subject",
            );
          }
          await this.#projection.acceptStatus(notice);
        }
        const advanced = [...next].some(
          ([key, revision]) => revision !== previous.get(key),
        );
        this.#cursors = page.next;
        if (!advanced) break;
        cursors = page.next;
      }
    });
  }

  async confirmConversationFinal(input: {
    readonly frame: FinalFrame;
    readonly bundle: SealedBundle;
  }): Promise<void> {
    await this.#enqueue(() =>
      this.#projection.confirmConversationFinal(input).then(() => undefined),
    );
  }

  async acceptProvisionalFinal(frame: StreamFrame): Promise<void> {
    await this.#enqueue(() =>
      this.#projection.acceptProvisionalFinal(frame).then(() => undefined),
    );
  }

  /** 三域真实续读游标:断线后以此重建会话,补读与实时零跳失。 */
  nextCursors(): readonly ExecutionStatusCursor[] {
    return this.#cursors.map((cursor) => ({
      subject: cursor.subject,
      afterStatusRevision: this.#projection.statusRevision(cursor.subject),
    }));
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) {
      return Promise.reject(
        new FirstPartyFinalityResyncRequiredError(
          "First-party finality session is closed",
        ),
      );
    }
    const accepted = this.#serial.then(async () => {
      if (this.#failure) throw this.#failure;
      await operation();
    });
    this.#serial = accepted.catch((error) => {
      const failure =
        error instanceof FirstPartyFinalityResyncRequiredError
          ? error
          : new FirstPartyFinalityResyncRequiredError(
              "First-party finality consumer requires resynchronization",
              { cause: error },
            );
      this.#fail(failure);
    });
    return accepted.catch((error) => {
      if (error instanceof FirstPartyFinalityResyncRequiredError) throw error;
      throw this.#failure ?? error;
    });
  }

  #fail(error: FirstPartyFinalityResyncRequiredError): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#onResyncRequired?.(error);
  }
}

function cursorMap(
  cursors: readonly ExecutionStatusCursor[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const cursor of cursors) {
    const key = ExecutionFinalityProjection.subjectKey(cursor.subject);
    if (result.has(key)) {
      throw new TypeError("Finality cursor subject is duplicated");
    }
    result.set(key, cursor.afterStatusRevision);
  }
  return result;
}

export interface ExecutionStatusHubOptions {
  readonly conversationHistory: (
    requests: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ) => Promise<{
    readonly notices: readonly Extract<
      ExecutionStatusNotice,
      { ref: { execution: "conversation" } }
    >[];
    readonly next: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[];
  }>;
  readonly jobHistory: (
    cursors: readonly {
      readonly taskId: string;
      readonly jobRunId: string;
      readonly afterStatusRevision: number;
    }[],
  ) => Promise<{
    readonly notices: readonly Extract<
      ExecutionStatusNotice,
      { ref: { execution: "job" } }
    >[];
    readonly next: readonly {
      readonly taskId: string;
      readonly jobRunId: string;
      readonly afterStatusRevision: number;
    }[];
  }>;
  readonly deliveryHistory: (
    afterByItem: Readonly<Record<string, number>>,
  ) => Promise<
    readonly Extract<ExecutionStatusNotice, { ref: { execution: "delivery" } }>[]
  >;
}

/**
 * 三域权威 live/history 的组合根聚合面。live 由三域权威在同一进程内
 * tee 入 publish;history 按 subject 分域路由到各自权威补读并拼装真实
 * 续读游标。它只是路由,不缓存、不产生第二事实源。
 */
export class ExecutionStatusHub implements ExecutionFinalitySources {
  readonly #options: ExecutionStatusHubOptions;
  readonly #listeners = new Set<
    (notice: ExecutionStatusNotice) => void | Promise<void>
  >();

  constructor(options: ExecutionStatusHubOptions) {
    this.#options = options;
  }

  publish(notice: ExecutionStatusNotice): void {
    for (const listener of this.#listeners) {
      void Promise.resolve(listener(notice)).catch(() => undefined);
    }
  }

  subscribe(
    listener: (notice: ExecutionStatusNotice) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async statusHistory(cursors: readonly ExecutionStatusCursor[]): Promise<{
    readonly notices: readonly ExecutionStatusNotice[];
    readonly next: readonly ExecutionStatusCursor[];
  }> {
    const conversationCursors = cursors.filter(
      (
        cursor,
      ): cursor is ExecutionStatusCursorFor<"conversation"> =>
        cursor.subject.execution === "conversation",
    );
    const jobCursors = cursors.filter(
      (cursor): cursor is ExecutionStatusCursorFor<"job"> =>
        cursor.subject.execution === "job",
    );
    const deliveryCursors = cursors.filter(
      (cursor): cursor is ExecutionStatusCursorFor<"delivery"> =>
        cursor.subject.execution === "delivery",
    );
    const [conversation, job, delivery] = await Promise.all([
      conversationCursors.length > 0
        ? this.#options.conversationHistory(
            conversationCursors.map((cursor) => ({
              conversationId: cursor.subject.conversationId,
              runId: cursor.subject.runId,
              afterStatusRevision: cursor.afterStatusRevision,
            })),
          )
        : { notices: [], next: [] },
      jobCursors.length > 0
        ? this.#options.jobHistory(
            jobCursors.map((cursor) => ({
              taskId: cursor.subject.taskId,
              jobRunId: cursor.subject.jobRunId,
              afterStatusRevision: cursor.afterStatusRevision,
            })),
          )
        : { notices: [], next: [] },
      deliveryCursors.length > 0
        ? this.#options.deliveryHistory(
            Object.fromEntries(
              deliveryCursors.map((cursor) => [
                cursor.subject.itemId,
                cursor.afterStatusRevision,
              ]),
            ),
          )
        : [],
    ]);
    const deliveryNext = deliveryCursors.map((cursor) => {
      const itemId = cursor.subject.itemId;
      const advanced = delivery
        .filter((notice) => notice.ref.itemId === itemId)
        .reduce(
          (max, notice) => Math.max(max, notice.statusRevision),
          cursor.afterStatusRevision,
        );
      return { subject: cursor.subject, afterStatusRevision: advanced };
    });
    const conversationNext = new Map(
      conversation.next.map((cursor) => [
        conversationCursorKey(cursor.conversationId, cursor.runId),
        cursor.afterStatusRevision,
      ]),
    );
    const jobNext = new Map(
      job.next.map((cursor) => [
        jobCursorKey(cursor.taskId, cursor.jobRunId),
        cursor.afterStatusRevision,
      ]),
    );
    return {
      notices: [...conversation.notices, ...job.notices, ...delivery],
      next: [
        ...conversationCursors.map((cursor) => ({
          subject: cursor.subject,
          afterStatusRevision:
            conversationNext.get(
              conversationCursorKey(
                cursor.subject.conversationId,
                cursor.subject.runId,
              ),
            ) ??
            (() => {
              throw new TypeError(
                "Conversation history omitted a requested subject cursor",
              );
            })(),
        })),
        ...jobCursors.map((cursor) => ({
          subject: cursor.subject,
          afterStatusRevision:
            jobNext.get(
              jobCursorKey(cursor.subject.taskId, cursor.subject.jobRunId),
            ) ??
            (() => {
              throw new TypeError(
                "Job history omitted a requested subject cursor",
              );
            })(),
        })),
        ...deliveryNext,
      ],
    };
  }
}

function conversationCursorKey(conversationId: string, runId: string): string {
  return JSON.stringify([conversationId, runId]);
}

function jobCursorKey(taskId: string, jobRunId: string): string {
  return JSON.stringify([taskId, jobRunId]);
}
