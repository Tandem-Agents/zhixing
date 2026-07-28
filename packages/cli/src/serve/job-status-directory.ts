import type { JobStatusNotice } from "@zhixing/core/contracts";

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

/** Aggregates task-scoped job authorities without owning their lifecycle. */
export class JobStatusDirectory {
  readonly #sources = new Map<
    string,
    { source: JobStatusSource; unsubscribe: () => void }
  >();
  readonly #listeners = new Set<
    (notice: JobStatusNotice) => void | Promise<void>
  >();

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
        if (!source) return [] as readonly JobStatusNotice[];
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
        return notices;
      }),
    );
    return {
      notices: pages
        .flat()
        .sort((left, right) =>
          left.ref.taskId.localeCompare(right.ref.taskId) ||
          left.ref.jobRunId.localeCompare(right.ref.jobRunId) ||
          left.statusRevision - right.statusRevision),
      next: [],
    };
  }

  dispose(): void {
    for (const entry of this.#sources.values()) entry.unsubscribe();
    this.#sources.clear();
    this.#listeners.clear();
  }
}
