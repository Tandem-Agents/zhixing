import { describe, expect, it, vi } from "vitest";
import type { TaskListState } from "@zhixing/core";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { TaskListService, type TaskListStore } from "@zhixing/tools-builtin";
import { createAnchorConversationTaskListPort } from "../conversation-task-list-application.js";

function memoryStore() {
  const states = new Map<string, TaskListState>();
  const store: TaskListStore = {
    load: vi.fn(async (conversationId) => states.get(conversationId)),
    save: vi.fn(async (conversationId, state) => {
      states.set(conversationId, { items: [...state.items] });
    }),
    delete: vi.fn(async (conversationId) => {
      states.delete(conversationId);
    }),
  };
  return { store, states };
}

describe("createAnchorConversationTaskListPort", () => {
  it("holds the existing maintenance boundary through the committed snapshot", async () => {
    const storage = memoryStore();
    const manager = {
      runMaintenanceExisting: vi.fn(async (_id, exists, run) =>
        (await exists())
          ? { status: "done" as const, value: await run() }
          : { status: "not-found" as const }),
    } as unknown as ConversationManager;
    const port = createAnchorConversationTaskListPort({
      conversations: manager,
      exists: vi.fn(async () => true),
      taskLists: new TaskListService(storage.store),
    });

    await expect(port.maintain({
      conversationId: "conversation-1",
      operationId: "task-operation-1",
      decide: (current) => ({
        outcome: "added",
        taskContent: "写周报",
        next: {
          items: [
            ...current.items,
            { id: "task-1", content: "写周报", status: "pending" },
          ],
        },
      }),
    })).resolves.toMatchObject({
      status: "done",
      taskList: {
        items: [{ id: "task-1", content: "写周报", status: "pending" }],
      },
    });
    expect(manager.runMaintenanceExisting).toHaveBeenCalledOnce();
    expect(storage.store.save).toHaveBeenCalledOnce();
  });

  it("does not read or write the task list when maintenance is busy", async () => {
    const storage = memoryStore();
    const manager = {
      runMaintenanceExisting: vi.fn(async () => ({ status: "busy" as const })),
    } as unknown as ConversationManager;
    const taskLists = new TaskListService(storage.store);
    const port = createAnchorConversationTaskListPort({
      conversations: manager,
      exists: vi.fn(async () => true),
      taskLists,
    });

    await expect(port.maintain({
      conversationId: "conversation-1",
      operationId: "task-operation-1",
      decide: () => {
        throw new Error("decision must remain behind maintenance");
      },
    })).resolves.toEqual({ status: "busy" });
    expect(storage.store.load).not.toHaveBeenCalled();
    expect(storage.store.save).not.toHaveBeenCalled();
  });
});
