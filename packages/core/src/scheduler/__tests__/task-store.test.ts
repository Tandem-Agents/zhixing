import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonTaskStore } from "../task-store.js";
import type { ScheduledTask } from "../types.js";

function createTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: `task_${Math.random().toString(36).slice(2, 8)}`,
    name: "test-task",
    enabled: true,
    priority: "normal",
    schedule: { kind: "interval", everyMs: 60_000 },
    action: { kind: "agent-turn", prompt: "hello" },
    state: { consecutiveErrors: 0, runCount: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("JsonTaskStore", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-store-"));
    storePath = join(tempDir, "scheduler.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads empty when file does not exist", async () => {
    const store = new JsonTaskStore(storePath);
    const tasks = await store.load();
    expect(tasks).toEqual([]);
  });

  it("adds and persists tasks", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();

    const task = createTask({ name: "my-task" });
    await store.addTask(task);

    // Reload from disk
    const store2 = new JsonTaskStore(storePath);
    const loaded = await store2.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("my-task");
  });

  it("updates a task", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();

    const task = createTask({ id: "t1", name: "original" });
    await store.addTask(task);
    await store.updateTask("t1", { name: "updated" });

    expect(store.getTask("t1")?.name).toBe("updated");
  });

  it("removes a task", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();

    const task = createTask({ id: "t1" });
    await store.addTask(task);
    await store.removeTask("t1");

    expect(store.getTask("t1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("throws on update/remove of nonexistent task", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();

    await expect(store.updateTask("nope", { name: "x" })).rejects.toThrow("Task not found");
    await expect(store.removeTask("nope")).rejects.toThrow("Task not found");
  });

  it("list() returns current in-memory tasks", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();

    await store.addTask(createTask({ id: "a" }));
    await store.addTask(createTask({ id: "b" }));

    expect(store.list()).toHaveLength(2);
  });
});
