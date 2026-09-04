import { describe, expect, it } from "vitest";
import { TaskListService, type TaskListStore } from "../task-list-state.js";
import type { TaskListState } from "../types.js";

interface StubStore extends TaskListStore {
  readonly data: Map<string, TaskListState>;
  readonly deleteCalls: string[];
  readonly loadCalls: string[];
  readonly saveCalls: { id: string; state: TaskListState }[];
  primeSaveFailure(error: Error): void;
}

function createStubStore(): StubStore {
  const data = new Map<string, TaskListState>();
  const deleteCalls: string[] = [];
  const loadCalls: string[] = [];
  const saveCalls: StubStore["saveCalls"] = [];
  let pendingSaveError: Error | undefined;

  return {
    data,
    deleteCalls,
    loadCalls,
    saveCalls,
    primeSaveFailure(error) {
      pendingSaveError = error;
    },
    async load(id) {
      loadCalls.push(id);
      return data.get(id);
    },
    async save(id, state) {
      saveCalls.push({ id, state });
      if (pendingSaveError) {
        const error = pendingSaveError;
        pendingSaveError = undefined;
        throw error;
      }
      data.set(id, state);
    },
    async delete(id) {
      deleteCalls.push(id);
      data.delete(id);
    },
  };
}

describe("TaskListService synchronous queries", () => {
  it("returns an empty projection before a conversation is primed", () => {
    const service = new TaskListService(createStubStore());

    expect(service.getCached("conv-1")).toBeNull();
    expect(service.getInProgressTasks("conv-1")).toEqual([]);
    expect(service.getAllTasks("conv-1")).toEqual([]);
  });

  it("exposes the durable projection after prime", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [{ id: "t1", content: "task", status: "pending" }],
    });
    const service = new TaskListService(store);

    await service.prime("conv-1");

    expect(service.getCached("conv-1")?.items).toHaveLength(1);
  });

  it("selects only in-progress tasks", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [
        { id: "a", content: "pending", status: "pending" },
        { id: "b", content: "first", status: "in_progress" },
        { id: "c", content: "done", status: "completed" },
        { id: "d", content: "second", status: "in_progress" },
      ],
    });
    const service = new TaskListService(store);
    await service.prime("conv-1");

    expect(service.getInProgressTasks("conv-1").map((task) => task.id)).toEqual([
      "b",
      "d",
    ]);
  });
});

describe("TaskListService cache lifecycle", () => {
  it("loads a conversation at most once while its projection is cached", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.prime("conv-1");
    await service.prime("conv-1");
    await service.prime("conv-1");

    expect(store.loadCalls).toEqual(["conv-1"]);
  });

  it("loads again after clear evicts the projection", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.prime("conv-1");
    service.clear("conv-1");
    await service.prime("conv-1");

    expect(store.loadCalls).toEqual(["conv-1", "conv-1"]);
  });

  it("degrades a failed prime to an empty projection", async () => {
    const store: TaskListStore = {
      load: async () => {
        throw new Error("disk error");
      },
      save: async () => {},
      delete: async () => {},
    };
    const service = new TaskListService(store);

    await expect(service.prime("conv-1")).resolves.not.toThrow();
    expect(service.getCached("conv-1")).toEqual({ items: [] });
  });

  it("clear evicts only the process projection and never deletes durable state", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "x", content: "task", status: "pending" },
    ]);

    service.clear("conv-1");

    expect(service.getCached("conv-1")).toBeNull();
    expect(store.deleteCalls).toEqual([]);
  });
});

describe("TaskListService committed replacement", () => {
  it("persists before publishing a successful set", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.set("conv-1", [
      { id: "a", content: "task", status: "pending" },
    ]);

    expect(service.getCached("conv-1")?.items).toHaveLength(1);
    expect(store.data.get("conv-1")?.items).toHaveLength(1);
    expect(store.saveCalls).toHaveLength(1);
  });

  it("keeps the prior projection when a later save fails", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "first", status: "pending" },
    ]);
    const before = service.getCached("conv-1");

    store.primeSaveFailure(new Error("disk full"));
    await expect(
      service.set("conv-1", [
        { id: "b", content: "second", status: "in_progress" },
      ]),
    ).rejects.toThrow("disk full");

    expect(service.getCached("conv-1")).toEqual(before);
  });

  it("leaves no projection when the first save fails", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    store.primeSaveFailure(new Error("disk full"));

    await expect(
      service.set("conv-1", [
        { id: "a", content: "task", status: "pending" },
      ]),
    ).rejects.toThrow("disk full");

    expect(service.getCached("conv-1")).toBeNull();
  });

  it("isolates projections by conversation identity", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);

    await service.set("conv-a", [
      { id: "a", content: "alpha", status: "pending" },
    ]);
    await service.set("conv-b", [
      { id: "b", content: "beta", status: "in_progress" },
    ]);

    expect(service.getAllTasks("conv-a")[0]?.content).toBe("alpha");
    expect(service.getInProgressTasks("conv-a")).toEqual([]);
    expect(service.getInProgressTasks("conv-b")[0]?.content).toBe("beta");
  });

  it("accepts an owner-committed projection without a second durable write", () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const events: TaskListState[] = [];
    service.subscribe((event) => {
      if (event.state) events.push(event.state);
    });
    const committed: TaskListState = {
      items: [{ id: "a", content: "committed", status: "completed" }],
    };

    service.acceptCommitted("conv-1", committed);

    expect(service.getCached("conv-1")).toEqual(committed);
    expect(service.getCached("conv-1")).not.toBe(committed);
    expect(events).toEqual([service.getCached("conv-1")]);
    expect(store.saveCalls).toEqual([]);
  });
});

describe("TaskListService mutation", () => {
  it("applies a mutation through the durable replacement path", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "old", status: "pending" },
    ]);

    await service.mutate("conv-1", (current) => [
      ...current,
      { id: "b", content: "new", status: "pending" },
    ]);

    expect(service.getAllTasks("conv-1")).toHaveLength(2);
    expect(store.data.get("conv-1")?.items).toHaveLength(2);
  });

  it("primes before mutating an uncached durable projection", async () => {
    const store = createStubStore();
    store.data.set("conv-1", {
      items: [
        { id: "a", content: "first", status: "pending" },
        { id: "b", content: "second", status: "completed" },
      ],
    });
    const service = new TaskListService(store);

    await service.mutate("conv-1", (current) => [
      ...current,
      { id: "c", content: "third", status: "pending" },
    ]);

    expect(store.data.get("conv-1")?.items.map((task) => task.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not change the projection when the mutator throws", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "stable", status: "pending" },
    ]);
    const before = service.getCached("conv-1");

    await expect(
      service.mutate("conv-1", () => {
        throw new Error("mutator failed");
      }),
    ).rejects.toThrow("mutator failed");

    expect(service.getCached("conv-1")).toEqual(before);
  });

  it("does not change the projection when mutation persistence fails", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    await service.set("conv-1", [
      { id: "a", content: "stable", status: "pending" },
    ]);
    const before = service.getCached("conv-1");
    store.primeSaveFailure(new Error("disk full"));

    await expect(
      service.mutate("conv-1", (current) => [
        ...current,
        { id: "b", content: "new", status: "pending" },
      ]),
    ).rejects.toThrow("disk full");

    expect(service.getCached("conv-1")).toEqual(before);
  });
});

describe("TaskListService subscription", () => {
  it("publishes the replacement after a successful set", async () => {
    const service = new TaskListService(createStubStore());
    const events: { conversationId: string; state: TaskListState | null }[] = [];
    service.subscribe((event) => events.push(event));

    await service.set("conv-1", [
      { id: "a", content: "task", status: "pending" },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversationId: "conv-1",
      state: { items: [{ content: "task" }] },
    });
  });

  it("publishes a null projection when clear evicts the cache", async () => {
    const service = new TaskListService(createStubStore());
    await service.set("conv-1", [
      { id: "a", content: "task", status: "pending" },
    ]);
    const events: { conversationId: string; state: TaskListState | null }[] = [];
    service.subscribe((event) => events.push(event));

    service.clear("conv-1");

    expect(events).toEqual([{ conversationId: "conv-1", state: null }]);
  });

  it("does not publish a failed durable replacement", async () => {
    const store = createStubStore();
    const service = new TaskListService(store);
    const events: unknown[] = [];
    service.subscribe((event) => events.push(event));
    store.primeSaveFailure(new Error("disk full"));

    await expect(
      service.set("conv-1", [
        { id: "a", content: "task", status: "pending" },
      ]),
    ).rejects.toThrow("disk full");

    expect(events).toEqual([]);
  });

  it("isolates a failing listener from the remaining subscribers", async () => {
    const service = new TaskListService(createStubStore());
    const received: unknown[] = [];
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe((event) => received.push(event));

    await service.set("conv-1", [
      { id: "a", content: "task", status: "pending" },
    ]);

    expect(received).toHaveLength(1);
  });

  it("stops publishing to a subscriber after unsubscribe", async () => {
    const service = new TaskListService(createStubStore());
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => events.push(event));

    await service.set("conv-1", [
      { id: "a", content: "first", status: "pending" },
    ]);
    unsubscribe();
    await service.set("conv-1", [
      { id: "b", content: "second", status: "pending" },
    ]);

    expect(events).toHaveLength(1);
  });

  it("makes unsubscribe idempotent", () => {
    const service = new TaskListService(createStubStore());
    const unsubscribe = service.subscribe(() => {});

    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });
});
