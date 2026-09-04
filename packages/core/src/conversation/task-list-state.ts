import type { TaskItem, TaskListState } from "./types.js";

/**
 * Conversation-owned persistence port for the task-list projection.
 *
 * `load` returns undefined when no durable projection exists, `save` throws on
 * failure, and `delete` is idempotent. Implementations own serialization.
 */
export interface TaskListStore {
  load(conversationId: string): Promise<TaskListState | undefined>;
  save(conversationId: string, state: TaskListState): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

/** State change emitted after a committed replacement or cache eviction. */
export interface TaskListStateEvent {
  readonly conversationId: string;
  readonly state: TaskListState | null;
}

export type TaskListStateListener = (event: TaskListStateEvent) => void;

/**
 * Conversation task-list state owner.
 *
 * The process-wide instance keeps a per-conversation cache. Durable writes are
 * save-before-publish so a failed repository write cannot advance the cache.
 */
export class TaskListService {
  private readonly cache = new Map<string, TaskListState>();
  private readonly subscribers = new Set<TaskListStateListener>();

  constructor(private readonly store: TaskListStore) {}

  getCached(conversationId: string): TaskListState | null {
    return this.cache.get(conversationId) ?? null;
  }

  getInProgressTasks(conversationId: string): readonly TaskItem[] {
    const state = this.cache.get(conversationId);
    if (!state) return [];
    return state.items.filter((task) => task.status === "in_progress");
  }

  getAllTasks(conversationId: string): readonly TaskItem[] {
    return this.cache.get(conversationId)?.items ?? [];
  }

  async prime(conversationId: string): Promise<void> {
    if (this.cache.has(conversationId)) return;
    try {
      const loaded = await this.store.load(conversationId);
      this.cache.set(conversationId, loaded ?? { items: [] });
    } catch {
      this.cache.set(conversationId, { items: [] });
    }
  }

  clear(conversationId: string): void {
    this.cache.delete(conversationId);
    this.emit(conversationId, null);
  }

  /** Accept an owner-committed projection without performing a second write. */
  acceptCommitted(conversationId: string, state: TaskListState): void {
    const committed: TaskListState = { items: [...state.items] };
    this.cache.set(conversationId, committed);
    this.emit(conversationId, committed);
  }

  async set(
    conversationId: string,
    items: readonly TaskItem[],
  ): Promise<TaskListState> {
    const next: TaskListState = { items: [...items] };
    await this.store.save(conversationId, next);
    this.cache.set(conversationId, next);
    this.emit(conversationId, next);
    return next;
  }

  async mutate(
    conversationId: string,
    mutator: (current: readonly TaskItem[]) => readonly TaskItem[],
  ): Promise<TaskListState> {
    await this.prime(conversationId);
    const current = this.cache.get(conversationId)?.items ?? [];
    return this.set(conversationId, mutator(current));
  }

  subscribe(listener: TaskListStateListener): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(conversationId: string, state: TaskListState | null): void {
    for (const listener of this.subscribers) {
      try {
        listener({ conversationId, state });
      } catch {
        // A Surface listener cannot break state publication to other consumers.
      }
    }
  }
}
