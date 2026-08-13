import type { ScheduledTask, TaskStore } from "./types.js";

/**
 * Process-local scheduler storage for embedded runtimes and direct tests.
 * Durable product scheduling is owned by the anchor authority and never uses
 * this store.
 */
export class InMemoryTaskStore implements TaskStore {
  readonly #tasks = new Map<string, ScheduledTask>();

  async load(): Promise<ScheduledTask[]> {
    return this.list();
  }

  async save(tasks?: ScheduledTask[]): Promise<void> {
    if (!tasks) return;
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.id, structuredClone(task));
  }

  async addTask(task: ScheduledTask): Promise<void> {
    this.#tasks.set(task.id, structuredClone(task));
  }

  async updateTask(id: string, patch: Partial<ScheduledTask>): Promise<void> {
    const current = this.#tasks.get(id);
    if (!current) throw new Error(`Task not found: ${id}`);
    this.#tasks.set(id, structuredClone({ ...current, ...patch }));
  }

  async removeTask(id: string): Promise<void> {
    if (!this.#tasks.delete(id)) throw new Error(`Task not found: ${id}`);
  }

  getTask(id: string): ScheduledTask | undefined {
    const task = this.#tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  list(): ScheduledTask[] {
    return [...this.#tasks.values()].map((task) => structuredClone(task));
  }
}
