import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  CONVERSATION_CREATE_COMMAND,
  CONVERSATION_CLEAR_COMMAND,
  CONVERSATION_DELETE_COMMAND,
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  CONVERSATION_HISTORY_QUERY,
  CONVERSATION_LIST_QUERY,
  CONVERSATION_RENAME_COMMAND,
  ConversationApplicationError,
  ConversationDirectoryApplicationService,
  createConversationDirectoryProductApiContribution,
  mergeConversationDirectoryViews,
  projectConversationClear,
  projectConversationDelete,
  type ConversationDirectoryRecord,
  type ConversationDirectoryStorage,
} from "./application.js";

function fixture(records: ConversationDirectoryRecord[] = []) {
  const state = new Map(records.map((record) => [record.conversationId, record]));
  let created = 0;
  const history = vi.fn<ConversationDirectoryStorage["readHistory"]>(
    async () => ({ runs: [], hasMore: false }),
  );
  const storage: ConversationDirectoryStorage = {
    list: async () => [...state.values()],
    create: async () => {
      const conversationId = `created-${++created}`;
      const record = {
        conversationId,
        name: conversationId,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
      };
      state.set(conversationId, record);
      return record;
    },
    rename: async (conversationId, name) => {
      const prior = state.get(conversationId);
      if (!prior) return null;
      const renamed = { ...prior, name };
      state.set(conversationId, renamed);
      return renamed;
    },
    readHistory: history,
  };
  const application = new ConversationDirectoryApplicationService({ storage });
  const dispatcher = new ProductApiDispatcher(
    CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
    [createConversationDirectoryProductApiContribution(application)],
  );
  return { application, dispatcher, history };
}

describe("ConversationDirectoryApplicationService", () => {
  it("preserves durable ordering while overlaying read-only runtime/Advancement projections", async () => {
    const older = {
      conversationId: "older",
      name: "旧",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:01.000Z",
    };
    const newer = {
      conversationId: "newer",
      name: "新",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:02.000Z",
    };
    const storage: ConversationDirectoryStorage = {
      list: async () => [older, newer],
      create: async () => older,
      rename: async () => older,
      readHistory: async () => ({ runs: [], hasMore: false }),
    };
    const projected = new ConversationDirectoryApplicationService({
      storage,
      runtime: {
        read: (id) =>
          id === "older"
            ? {
                lastActiveAt: "2026-01-01T00:00:03.000Z",
                active: true,
                busy: true,
                observerCount: 2,
                pendingCount: 1,
              }
            : undefined,
      },
      advancement: {
        read: async (id) =>
          id === "older"
            ? { advancementSessionId: "adv-1", status: "active" }
            : undefined,
      },
    });
    await expect(projected.queryList()).resolves.toEqual({
      conversations: [
        expect.objectContaining({ conversationId: "newer", active: false }),
        expect.objectContaining({
          conversationId: "older",
          lastActiveAt: "2026-01-01T00:00:03.000Z",
          active: true,
          busy: true,
          observerCount: 2,
          pendingCount: 1,
          advancement: { advancementSessionId: "adv-1", status: "active" },
        }),
      ],
    });
  });

  it("applies history defaults/cap and rejects invalid pagination", async () => {
    const { dispatcher, history } = fixture();
    await dispatcher.query(CONVERSATION_HISTORY_QUERY, {
      kind: "history",
      conversationId: "missing",
    });
    await dispatcher.query(CONVERSATION_HISTORY_QUERY, {
      kind: "history",
      conversationId: "c-1",
      limit: 999,
    });
    expect(history.mock.calls.map((call) => call[1].limit)).toEqual([20, 200]);
    await expect(
      dispatcher.query(CONVERSATION_HISTORY_QUERY, {
        kind: "history",
        conversationId: "c-1",
        limit: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("uses one dispatcher for list/create/rename and emits rename fact after storage", async () => {
    const initial = {
      conversationId: "c-1",
      name: "原名",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    };
    const { dispatcher } = fixture([initial]);
    await expect(
      dispatcher.query(CONVERSATION_LIST_QUERY, { kind: "list" }),
    ).resolves.toMatchObject({ conversations: [{ conversationId: "c-1" }] });
    await expect(
      dispatcher.command(CONVERSATION_CREATE_COMMAND, { kind: "create" }),
    ).resolves.toMatchObject({ facts: [], result: { conversationId: "created-1" } });
    await expect(
      dispatcher.command(CONVERSATION_RENAME_COMMAND, {
        kind: "rename",
        conversationId: "c-1",
        name: "  新名  ",
      }),
    ).resolves.toEqual({
      result: {
        conversationId: "c-1",
        name: "新名",
        fact: {
          kind: "conversation-renamed",
          conversationId: "c-1",
          name: "新名",
        },
      },
      facts: [
        {
          kind: "conversation-renamed",
          conversationId: "c-1",
          name: "新名",
        },
      ],
    });
    await expect(
      dispatcher.command(CONVERSATION_RENAME_COMMAND, {
        kind: "rename",
        conversationId: "missing",
        name: "x",
      }),
    ).rejects.toBeInstanceOf(ConversationApplicationError);
  });

  it("owns stable clear admission and emits its fact only after the commit boundary", async () => {
    const committed: string[] = [];
    const application = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => [],
        create: async () => { throw new Error("unused"); },
        rename: async () => null,
        readHistory: async () => ({ runs: [], hasMore: false }),
      },
      clear: {
        requiresStableOperationIdentity: true,
        createOperationIdentity: () => { throw new Error("must not generate"); },
        commit: async (input) => {
          committed.push(input.operationId);
          return { status: "cleared" };
        },
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );
    await expect(dispatcher.command(CONVERSATION_CLEAR_COMMAND, {
      kind: "clear",
      conversationId: "conversation-1",
      operationId: "clear-operation-1",
      caller: { kind: "host", component: "test" },
    })).resolves.toEqual({
      result: {
        cleared: true,
        fact: {
          kind: "conversation-cleared",
          conversationId: "conversation-1",
          operationId: "clear-operation-1",
        },
      },
      facts: [{
        kind: "conversation-cleared",
        conversationId: "conversation-1",
        operationId: "clear-operation-1",
      }],
    });
    expect(committed).toEqual(["clear-operation-1"]);
    await expect(application.clear({
      kind: "clear",
      conversationId: "conversation-1",
      caller: { kind: "host", component: "test" },
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("owns clear busy and not-found terminals", async () => {
    let outcome:
      | { readonly status: "busy"; readonly reason: "active-turn" }
      | { readonly status: "not-found" } = {
        status: "busy",
        reason: "active-turn",
      };
    const application = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => [],
        create: async () => { throw new Error("unused"); },
        rename: async () => null,
        readHistory: async () => ({ runs: [], hasMore: false }),
      },
      clear: {
        requiresStableOperationIdentity: true,
        createOperationIdentity: () => { throw new Error("must not generate"); },
        commit: async () => outcome,
      },
    });
    const command = {
      kind: "clear" as const,
      conversationId: "conversation-1",
      operationId: "clear-operation-1",
      caller: { kind: "host" as const, component: "test" },
    };

    await expect(application.clear(command)).rejects.toMatchObject({
      code: "busy",
      reason: "active-turn",
    });
    outcome = { status: "not-found" };
    await expect(application.clear(command)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("owns stable delete admission and its busy/not-found terminals", async () => {
    let outcome:
      | { readonly status: "deleted" }
      | { readonly status: "busy"; readonly reason: "active-turn" }
      | { readonly status: "not-found" } = { status: "deleted" };
    const application = new ConversationDirectoryApplicationService({
      storage: {
        list: async () => [],
        create: async () => { throw new Error("unused"); },
        rename: async () => null,
        readHistory: async () => ({ runs: [], hasMore: false }),
      },
      delete: {
        requiresStableOperationIdentity: true,
        createOperationIdentity: () => { throw new Error("must not generate"); },
        commit: async () => outcome,
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );
    const command = {
      kind: "delete" as const,
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      caller: { kind: "host" as const, component: "test" },
    };
    await expect(
      dispatcher.command(CONVERSATION_DELETE_COMMAND, command),
    ).resolves.toEqual({
      result: {
        deleted: true,
        fact: {
          kind: "conversation-deleted",
          conversationId: "conversation-1",
          operationId: "delete-operation-1",
        },
      },
      facts: [{
        kind: "conversation-deleted",
        conversationId: "conversation-1",
        operationId: "delete-operation-1",
      }],
    });
    await expect(application.delete({
      kind: "delete",
      conversationId: "conversation-1",
      caller: { kind: "host", component: "test" },
    })).rejects.toMatchObject({ code: "invalid-input" });
    outcome = { status: "busy", reason: "active-turn" };
    await expect(application.delete(command)).rejects.toMatchObject({
      code: "busy",
      reason: "active-turn",
    });
    outcome = { status: "not-found" };
    await expect(application.delete(command)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("projects storage before runtime reset and publishes only a cleared result", async () => {
    const steps: string[] = [];
    const fact = await projectConversationClear({
      conversationId: "conversation-1",
      operationId: "clear-operation-1",
      projection: {
        clearStoredView: async () => {
          steps.push("storage");
          return true;
        },
        clearRuntimeView: async (_conversationId, persist) => {
          expect(await persist()).toBe(true);
          steps.push("runtime");
          return "cleared";
        },
      },
      publishFact: () => { steps.push("fact"); },
    });
    expect(fact.kind).toBe("conversation-cleared");
    expect(steps).toEqual(["storage", "runtime", "fact"]);
  });

  it("projects delete fact before dependent lifecycle and preserves strict/best-effort failure", async () => {
    const steps: string[] = [];
    const projection = {
      deleteRuntimeAndStorage: async (input: { readonly onDeleted: () => void }) => {
        steps.push("delete");
        input.onDeleted();
        return "deleted" as const;
      },
      cancelDependentLifecycle: async () => {
        steps.push("cancel");
        throw new Error("cancel failed");
      },
      removeDependentData: async () => { steps.push("remove"); },
    };
    await expect(projectConversationDelete({
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      deletionAlreadyCommitted: false,
      dependentFailure: "propagate",
      projection,
      publishFact: () => { steps.push("fact"); },
    })).rejects.toThrow("cancel failed");
    expect(steps).toEqual(["delete", "fact", "cancel"]);

    steps.length = 0;
    const failed: string[] = [];
    await expect(projectConversationDelete({
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      deletionAlreadyCommitted: false,
      dependentFailure: "best-effort",
      projection,
      publishFact: () => { steps.push("fact"); },
      onDependentFailure: (step) => { failed.push(step); },
    })).resolves.toMatchObject({ kind: "conversation-deleted" });
    expect(steps).toEqual(["delete", "fact", "cancel", "remove"]);
    expect(failed).toEqual(["cancel-lifecycle"]);
  });

  it("owns cross-owner list merge ordering without changing local availability", () => {
    const entry = (conversationId: string, lastActiveAt: string) => ({
      conversationId,
      name: conversationId,
      createdAt: lastActiveAt,
      lastActiveAt,
      active: false,
      busy: false,
      observerCount: 0,
      pendingCount: 0,
    });
    expect(
      mergeConversationDirectoryViews(
        {
          conversations: [entry("local", "2026-01-01T00:00:01.000Z")],
          availability: {
            mode: "local-only",
            unavailableCapabilities: ["排程暂不可用"],
          },
        },
        [entry("remote", "2026-01-01T00:00:02.000Z")],
      ),
    ).toMatchObject({
      conversations: [
        { conversationId: "remote" },
        { conversationId: "local" },
      ],
      availability: { mode: "local-only" },
    });
  });
});
