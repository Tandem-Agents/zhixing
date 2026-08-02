import type { JobStatusNotice, SchedulerUserNotice } from "@zhixing/core/contracts";

export interface JobStatusSource {
  statusHistory(
    jobRunId: string,
    afterStatusRevision: number,
  ): Promise<readonly JobStatusNotice[]>;
  onStatus(
    listener: (notice: JobStatusNotice) => void | Promise<void>,
  ): () => void;
}

export interface JobStatusCursor {
  readonly taskId: string;
  readonly jobRunId: string;
  readonly afterStatusRevision: number;
}

export interface SchedulerNoticeSource {
  history(afterRevision: number): Promise<readonly SchedulerUserNotice[]>;
  onNotice(listener: (notice: SchedulerUserNotice) => void | Promise<void>): () => void;
}

/** Aggregates task-scoped job authorities without owning their lifecycle. */
export class JobStatusDirectory {
  readonly #sources = new Map<
    string,
    { source: JobStatusSource; unsubscribe: () => void }
  >();
  readonly #listeners = new Set<
    (notice: JobStatusNotice) => void | Promise<void>
  >();
  readonly #schedulerListeners = new Set<
    (notice: SchedulerUserNotice) => void | Promise<void>
  >();
  #schedulerSource:
    | { source: SchedulerNoticeSource; unsubscribe: () => void }
    | undefined;

  registerScheduler(source: SchedulerNoticeSource): () => void {
    if (this.#schedulerSource) throw new Error("Scheduler notice source is already registered");
    const unsubscribe = source.onNotice((notice) => {
      for (const listener of this.#schedulerListeners) void listener(notice);
    });
    const entry = { source, unsubscribe };
    this.#schedulerSource = entry;
    return () => {
      if (this.#schedulerSource !== entry) return;
      this.#schedulerSource = undefined;
      unsubscribe();
    };
  }

  onSchedulerNotice(
    listener: (notice: SchedulerUserNotice) => void | Promise<void>,
  ): () => void {
    this.#schedulerListeners.add(listener);
    return () => this.#schedulerListeners.delete(listener);
  }

  async schedulerHistory(afterRevision: number): Promise<{
    readonly notices: readonly SchedulerUserNotice[];
    readonly nextRevision: number;
  }> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new TypeError("Scheduler notice cursor is invalid");
    }
    const notices = await this.#schedulerSource?.source.history(afterRevision) ?? [];
    return {
      notices,
      nextRevision: notices.at(-1)?.revision ?? afterRevision,
    };
  }

  register(taskId: string, source: JobStatusSource): () => void {
    if (taskId.length === 0 || this.#sources.has(taskId)) {
      throw new TypeError("Job status source task identity is invalid or duplicated");
    }
    const unsubscribe = source.onStatus((notice) => {
      if (notice.ref.taskId !== taskId) {
        throw new TypeError("Job status source emitted a different task identity");
      }
      for (const listener of this.#listeners) void listener(notice);
    });
    const entry = { source, unsubscribe };
    this.#sources.set(taskId, entry);
    return () => {
      if (this.#sources.get(taskId) !== entry) return;
      this.#sources.delete(taskId);
      unsubscribe();
    };
  }

  onStatus(
    listener: (notice: JobStatusNotice) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async statusHistory(cursors: readonly JobStatusCursor[]): Promise<{
    readonly notices: readonly JobStatusNotice[];
    readonly next: readonly JobStatusCursor[];
  }> {
    const seen = new Set<string>();
    const pages = await Promise.all(
      cursors.map(async (cursor) => {
        const key = `${cursor.taskId}\u0000${cursor.jobRunId}`;
        if (
          seen.has(key) ||
          !Number.isSafeInteger(cursor.afterStatusRevision) ||
          cursor.afterStatusRevision < 0
        ) {
          throw new TypeError("Job status cursor is invalid or duplicated");
        }
        seen.add(key);
        const source = this.#sources.get(cursor.taskId)?.source;
        if (!source) {
          // source 未注册不等于义务消失:游标原样保留,注册后续读不丢。
          return { notices: [] as readonly JobStatusNotice[], next: cursor };
        }
        const notices = await source.statusHistory(
          cursor.jobRunId,
          cursor.afterStatusRevision,
        );
        let revision = cursor.afterStatusRevision;
        for (const notice of notices) {
          if (
            notice.ref.taskId !== cursor.taskId ||
            notice.ref.jobRunId !== cursor.jobRunId ||
            notice.statusRevision !== revision + 1
          ) {
            throw new TypeError("Job status history is not a contiguous authority page");
          }
          revision = notice.statusRevision;
        }
        return {
          notices,
          next: { ...cursor, afterStatusRevision: revision },
        };
      }),
    );
    return {
      notices: pages
        .flatMap((page) => page.notices)
        .sort((left, right) =>
          left.ref.taskId.localeCompare(right.ref.taskId) ||
          left.ref.jobRunId.localeCompare(right.ref.jobRunId) ||
          left.statusRevision - right.statusRevision),
      // 真实续读游标:每个入参游标按其权威页尾推进,调用方以此续读、
      // 断线后从游标重建——绝不返回空表把进度谎报为终点。
      next: pages.map((page) => page.next),
    };
  }

  dispose(): void {
    this.#schedulerSource?.unsubscribe();
    this.#schedulerSource = undefined;
    for (const entry of this.#sources.values()) entry.unsubscribe();
    this.#sources.clear();
    this.#listeners.clear();
    this.#schedulerListeners.clear();
  }
}
