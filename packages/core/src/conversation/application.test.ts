import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  CONVERSATION_ABORT_COMMAND,
  CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
  CONVERSATION_CREATE_COMMAND,
  CONVERSATION_CLEAR_COMMAND,
  CONVERSATION_DELETE_COMMAND,
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  CONVERSATION_HISTORY_QUERY,
  CONVERSATION_LIST_QUERY,
  CONVERSATION_RENAME_COMMAND,
  CONVERSATION_RESUME_COMMAND,
  CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
  CONVERSATION_TASK_LIST_QUERY,
  CONVERSATION_UPDATE_TASK_LIST_COMMAND,
  ConversationApplicationError,
  ConversationDirectoryApplicationService,
  createConversationDirectoryProductApiContribution,
  mergeConversationDirectoryViews,
  projectConversationClear,
  projectConversationDelete,
  type ConversationDirectoryRecord,
  type ConversationDirectoryStorage,
  type ConversationAgentTurnAdmissionPort,
  type ConversationTaskListPort,
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
  return { application, dispatcher, history, storage };
}

function taskListFixture(input?: Readonly<{
  requiresStableOperationIdentity?: boolean;
}>) {
  let state = { items: [] } as {
    items: Array<{
      id: string;
      content: string;
      status: "pending" | "in_progress" | "completed";
    }>;
  };
  let terminal: "done" | "busy" | "not-found" = "done";
  const writes: typeof state[] = [];
  const port: ConversationTaskListPort = {
    requiresStableOperationIdentity:
      input?.requiresStableOperationIdentity ?? false,
    createOperationIdentity: () => "task-list-operation-1",
    createTaskIdentity: () => "task-1",
    read: async () => state,
    maintain: async (request) => {
      if (terminal !== "done") return { status: terminal };
      const decision = request.decide(state);
      if ("next" in decision) {
        state = { items: [...decision.next.items] };
        writes.push(state);
      }
      return { status: "done", decision, taskList: state };
    },
  };
  const application = new ConversationDirectoryApplicationService({
    storage: fixture().storage,
    taskLists: port,
  });
  const dispatcher = new ProductApiDispatcher(
    CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
    [createConversationDirectoryProductApiContribution(application)],
  );
  return {
    application,
    dispatcher,
    writes,
    set state(value: typeof state) {
      state = value;
    },
    set terminal(value: typeof terminal) {
      terminal = value;
    },
  };
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

  it("owns task-list query, write decision, committed snapshot and fact", async () => {
    const harness = taskListFixture();
    await expect(
      harness.dispatcher.query(CONVERSATION_TASK_LIST_QUERY, {
        kind: "task-list",
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual({ taskList: { items: [] } });

    const dispatched = await harness.dispatcher.command(
      CONVERSATION_UPDATE_TASK_LIST_COMMAND,
      {
        kind: "update-task-list",
        conversationId: "conversation-1",
        action: { kind: "add", content: "  写周报  " },
      },
    );
    expect(dispatched).toEqual({
      result: {
        ok: true,
        message: '✓ 添加：“写周报”',
        taskList: {
          items: [{ id: "task-1", content: "写周报", status: "pending" }],
        },
      },
      facts: [
        {
          kind: "conversation-task-list-changed",
          conversationId: "conversation-1",
          taskList: {
            items: [{ id: "task-1", content: "写周报", status: "pending" }],
          },
        },
      ],
    });
    expect(harness.writes).toHaveLength(1);
  });

  it("keeps invalid, missing and already-completed task updates read-only", async () => {
    const harness = taskListFixture();
    harness.state = {
      items: [{ id: "task-1", content: "已做", status: "completed" }],
    };
    for (const action of [
      { kind: "add" as const, content: "   " },
      { kind: "done" as const, token: "" },
      { kind: "done" as const, token: "missing" },
      { kind: "done" as const, token: "1" },
    ]) {
      const dispatch = await harness.dispatcher.command(
        CONVERSATION_UPDATE_TASK_LIST_COMMAND,
        {
          kind: "update-task-list",
          conversationId: "conversation-1",
          action,
        },
      );
      expect(dispatch.result.ok).toBe(false);
      expect(dispatch.facts).toEqual([]);
    }
    expect(harness.writes).toEqual([]);
  });

  it("maps task-list maintenance busy/not-found before any write", async () => {
    const harness = taskListFixture();
    harness.terminal = "busy";
    await expect(
      harness.application.updateTaskList({
        kind: "update-task-list",
        conversationId: "conversation-1",
        action: { kind: "add", content: "x" },
      }),
    ).rejects.toMatchObject({ code: "busy", reason: "task-list-busy" });
    harness.terminal = "not-found";
    await expect(
      harness.application.updateTaskList({
        kind: "update-task-list",
        conversationId: "conversation-1",
        action: { kind: "add", content: "x" },
      }),
    ).rejects.toMatchObject({
      code: "not-found",
      reason: "task-list-conversation-not-found",
    });
    expect(harness.writes).toEqual([]);
  });

  it("requires stable task-list operation identity when the mechanism does", async () => {
    const harness = taskListFixture({ requiresStableOperationIdentity: true });
    await expect(
      harness.application.updateTaskList({
        kind: "update-task-list",
        conversationId: "conversation-1",
        action: { kind: "add", content: "x" },
      }),
    ).rejects.toMatchObject({
      code: "invalid-input",
      reason: "task-list-operation-required",
    });
    expect(harness.writes).toEqual([]);
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

  it("owns resume identity restoration, dependent recovery, runtime and review projection", async () => {
    const calls: string[] = [];
    const storage: ConversationDirectoryStorage = {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      rename: async () => null,
      readHistory: async () => ({ runs: [], hasMore: false }),
    };
    const application = new ConversationDirectoryApplicationService({
      storage,
      resume: {
        restoreIdentity: async (conversationId) => {
          calls.push("restore");
          return conversationId === "c-resume"
            ? {
                conversationId: "storage-local-id",
                name: "恢复的对话",
                createdAt: "2026-01-01T00:00:00.000Z",
                lastActiveAt: "2026-01-02T00:00:00.000Z",
              }
            : null;
        },
        recoverDependentLifecycle: async () => {
          calls.push("recover");
        },
        reviewAdoption: async ({ caller }) => {
          calls.push("review");
          expect(caller).toEqual({
            kind: "surface",
            surfacePrincipal: "rpc:test",
            connectionId: "7",
          });
          return {
            status: "ready",
            mergedConversationCount: 1,
            appliedRuleCount: 2,
            pendingScheduleCount: 0,
            pendingRuleCount: 0,
            message: "ready",
          };
        },
      },
      runtime: {
        read: () => {
          calls.push("runtime");
          return {
            active: true,
            busy: true,
            observerCount: 1,
            pendingCount: 0,
          };
        },
      },
      advancement: {
        read: async () => {
          calls.push("advancement");
          return { advancementSessionId: "adv-1", status: "active" };
        },
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );

    await expect(
      dispatcher.command(CONVERSATION_RESUME_COMMAND, {
        kind: "resume",
        conversationId: "c-resume",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "7",
        },
      }),
    ).resolves.toEqual({
      result: {
        conversationId: "c-resume",
        name: "恢复的对话",
        active: true,
        busy: true,
        advancement: { advancementSessionId: "adv-1", status: "active" },
        adoptionReview: {
          status: "ready",
          mergedConversationCount: 1,
          appliedRuleCount: 2,
          pendingScheduleCount: 0,
          pendingRuleCount: 0,
          message: "ready",
        },
      },
      facts: [],
    });
    expect(calls).toEqual([
      "restore",
      "recover",
      "runtime",
      "review",
      "advancement",
    ]);
    await expect(
      dispatcher.command(CONVERSATION_RESUME_COMMAND, {
        kind: "resume",
        conversationId: "missing",
        caller: { kind: "host", component: "test" },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(calls.at(-1)).toBe("restore");
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

  it("owns durable abort identity, cancellation terminal, and dependent settlement order", async () => {
    const steps: string[] = [];
    const cancel = vi.fn(async () => {
      steps.push("cancel");
      return {
        matchedDurableRuns: 1,
        abortedInFlight: true,
        cancelledPending: 0,
        dependentLifecycleIngressId: "proxy-1",
      };
    });
    const settle = vi.fn(async () => {
      steps.push("settle");
    });
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      clock: () => 123,
      runControl: {
        requiresStableCancellationIdentity: true,
        requiresAuthoritativeRunIdentity: true,
        emptyCancellationIsSuccess: false,
        createCancellationIdentity: () => {
          throw new Error("must not generate");
        },
        cancel,
        settleDependentCancellation: settle,
        recoverDependentCancellation: vi.fn(async () => {}),
        resolveUncertain: vi.fn(async () => ({
          state: "cancelled",
          factDigest: `sha256:${"b".repeat(64)}`,
        })),
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );
    await expect(
      dispatcher.command(CONVERSATION_ABORT_COMMAND, {
        kind: "abort",
        conversationId: "conversation-1",
        operationId: "abort-operation-1",
        runId: "run-1",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "connection-1",
        },
      }),
    ).resolves.toEqual({ result: { cancelled: true }, facts: [] });
    expect(steps).toEqual(["cancel", "settle"]);
    expect(cancel).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      operationId: "abort-operation-1",
      runId: "run-1",
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
      occurredAt: 123,
    });
  });

  it("fails closed on incomplete abort identities and empty cancellation", async () => {
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      runControl: {
        requiresStableCancellationIdentity: true,
        requiresAuthoritativeRunIdentity: true,
        emptyCancellationIsSuccess: false,
        createCancellationIdentity: () => "unused",
        cancel: async () => ({
          matchedDurableRuns: 0,
          abortedInFlight: false,
          cancelledPending: 0,
        }),
        resolveUncertain: vi.fn(async () => ({
          state: "cancelled",
          factDigest: `sha256:${"b".repeat(64)}`,
        })),
      },
    });
    const caller = {
      kind: "surface" as const,
      surfacePrincipal: "rpc:test",
      connectionId: "connection-1",
    };
    await expect(
      application.abort({
        kind: "abort",
        conversationId: "conversation-1",
        runId: "run-1",
        caller,
      }),
    ).rejects.toMatchObject({ reason: "abort-run-without-operation" });
    await expect(
      application.abort({
        kind: "abort",
        conversationId: "conversation-1",
        operationId: "abort-operation-1",
        caller,
      }),
    ).rejects.toMatchObject({ reason: "abort-run-required" });
    await expect(
      application.abort({
        kind: "abort",
        conversationId: "conversation-1",
        operationId: "abort-operation-1",
        runId: "run-1",
        caller,
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("keeps an authoritative cancellation successful and starts dependent recovery after settlement failure", async () => {
    const recover = vi.fn(async () => {});
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      runControl: {
        requiresStableCancellationIdentity: true,
        requiresAuthoritativeRunIdentity: true,
        emptyCancellationIsSuccess: false,
        createCancellationIdentity: () => "unused",
        cancel: async () => ({
          matchedDurableRuns: 1,
          abortedInFlight: true,
          cancelledPending: 0,
          dependentLifecycleIngressId: "proxy-1",
        }),
        settleDependentCancellation: async () => {
          throw new Error("projection unavailable");
        },
        recoverDependentCancellation: recover,
        resolveUncertain: vi.fn(async () => ({
          state: "cancelled",
          factDigest: `sha256:${"b".repeat(64)}`,
        })),
      },
    });
    await expect(
      application.abort({
        kind: "abort",
        conversationId: "conversation-1",
        operationId: "abort-operation-1",
        runId: "run-1",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "connection-1",
        },
      }),
    ).resolves.toEqual({ cancelled: true });
    await vi.waitFor(() => {
      expect(recover).toHaveBeenCalledWith("conversation-1");
    });
  });

  it("owns uncertain-resolution validation and returns the correctness result unchanged", async () => {
    const resolveUncertain = vi.fn(async () => ({
      state: "cancelled" as const,
      factDigest: `sha256:${"b".repeat(64)}`,
    }));
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      runControl: {
        requiresStableCancellationIdentity: true,
        requiresAuthoritativeRunIdentity: true,
        emptyCancellationIsSuccess: false,
        createCancellationIdentity: () => "unused",
        cancel: vi.fn(async () => ({
          matchedDurableRuns: 0,
          abortedInFlight: false,
          cancelledPending: 0,
        })),
        resolveUncertain,
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );
    await expect(
      dispatcher.command(CONVERSATION_RESOLVE_UNCERTAIN_COMMAND, {
        kind: "resolve-uncertain",
        conversationId: "conversation-1",
        runId: "run-1",
        operationId: "resolve-operation-1",
        ownerEpoch: 1,
        openFactDigest: `sha256:${"a".repeat(64)}`,
        decision: "user-abandoned",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "connection-1",
        },
      }),
    ).resolves.toEqual({
      result: {
        state: "cancelled",
        factDigest: `sha256:${"b".repeat(64)}`,
      },
      facts: [],
    });
    await expect(
      application.resolveUncertain({
        kind: "resolve-uncertain",
        conversationId: "conversation-1",
        runId: "run-1",
        operationId: "resolve-operation-1",
        ownerEpoch: -1,
        openFactDigest: `sha256:${"a".repeat(64)}`,
        decision: "user-abandoned",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "connection-1",
        },
      }),
    ).rejects.toMatchObject({ reason: "uncertain-resolution-invalid" });
  });

  it("owns stable turn identity and refuses durable admission before any mechanism effect", async () => {
    const admit = vi.fn<ConversationAgentTurnAdmissionPort["admit"]>();
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurns: {
        requiresStableTurnIdentity: true,
        createTurnIdentity: () => "legacy-generated",
        admit,
      },
      agentTurnIdentity: {
        exists: async () => true,
        create: async () => "created-1",
        ensure: async () => {},
      },
    });
    let rejection: unknown;
    try {
      application.prepareAgentTurnIdentity({
        kind: "prepare-agent-turn-identity",
        identitySource: "legacy-generated",
        caller: {
          kind: "surface",
          surfacePrincipal: "rpc:test",
          connectionId: "connection-1",
        },
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ reason: "turn-identity-required" });
    expect(admit).not.toHaveBeenCalled();
  });

  it("rejects a fabricated prepared turn identity before admission", async () => {
    const admit = vi.fn<ConversationAgentTurnAdmissionPort["admit"]>();
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurns: {
        requiresStableTurnIdentity: false,
        createTurnIdentity: () => "turn-generated",
        admit,
      },
      agentTurnIdentity: {
        exists: async () => true,
        create: async () => "created-1",
        ensure: async () => {},
      },
    });
    await expect(application.admitAgentTurn({
      kind: "admit-agent-turn",
      conversationId: "conversation-1",
      input: { parts: [{ type: "text", text: "hello" }] },
      turnIdentity: { turnId: "turn-1" },
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
      execution: { execute: async () => {}, cancelPending: () => {} },
    } as never)).rejects.toMatchObject({ reason: "turn-identity-invalid" });
    expect(admit).not.toHaveBeenCalled();
  });

  it("keeps existence inside admission and starts one immediate task after projection", async () => {
    const order: string[] = [];
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurns: {
        requiresStableTurnIdentity: true,
        createTurnIdentity: () => "unused",
        admit: async (input) => {
          expect(input.identity.kind).toBe("existing");
          if (input.identity.kind === "existing") {
            expect(await input.identity.exists()).toBe(true);
          }
          order.push("durable-admission");
          return {
            status: "immediate",
            conversationId: "conversation-1",
            runId: "run-1",
            start: async () => { order.push("start"); },
          };
        },
      },
      agentTurnIdentity: {
        exists: async () => {
          order.push("exists");
          return true;
        },
        create: async () => "created-1",
        ensure: async () => {},
      },
    });
    const turnIdentity = application.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity",
      turnId: "turn-1",
      identitySource: "provided",
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
    });
    await expect(application.admitAgentTurn({
      kind: "admit-agent-turn",
      conversationId: "conversation-1",
      input: { parts: [{ type: "text", text: "hello" }] },
      turnIdentity,
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
      execution: {
        execute: async () => {},
        cancelPending: () => {},
        onAdmitted: () => { order.push("admitted"); },
      },
    })).resolves.toEqual({
      conversationId: "conversation-1",
      turnId: "turn-1",
      runId: "run-1",
      status: "immediate",
    });
    await vi.waitFor(() => expect(order).toContain("start"));
    expect(order).toEqual(["exists", "durable-admission", "admitted", "start"]);
  });

  it("preserves preallocated identity and queued/replayed Product API results", async () => {
    const starts = vi.fn();
    const ensure = vi.fn(async () => {});
    let status: "queued" | "replayed" = "queued";
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurns: {
        requiresStableTurnIdentity: true,
        createTurnIdentity: () => "unused",
        admit: async (input) => {
          expect(input.identity.kind).toBe("create");
          const conversationId = input.identity.kind === "create"
            ? await input.identity.create()
            : "unexpected";
          return { status, conversationId, runId: "run-1" };
        },
      },
      agentTurnIdentity: {
        exists: async () => false,
        create: async () => "created-1",
        ensure,
      },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );
    const turnIdentity = application.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity",
      turnId: "turn-1",
      identitySource: "provided",
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
    });
    const command = {
      kind: "admit-agent-turn" as const,
      preallocatedConversationId: "conversation-preallocated",
      input: { parts: [{ type: "text" as const, text: "hello" }] },
      turnIdentity,
      caller: {
        kind: "surface" as const,
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
      execution: {
        execute: async () => { starts(); },
        cancelPending: () => {},
      },
    };
    await expect(
      dispatcher.command(CONVERSATION_ADMIT_AGENT_TURN_COMMAND, command),
    ).resolves.toMatchObject({
      result: {
        status: "queued",
        conversationId: "conversation-preallocated",
      },
      facts: [],
    });
    status = "replayed";
    await expect(application.admitAgentTurn(command)).resolves.toMatchObject({
      status: "replayed",
      conversationId: "conversation-preallocated",
    });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(starts).not.toHaveBeenCalled();
  });

  it.each([
    ["not-found", "turn-conversation-not-found", "not-found"],
    ["full", "turn-queue-full", "busy"],
    ["lifecycle-busy", "turn-lifecycle-busy", "busy"],
  ] as const)("maps %s admission to one stable domain failure", async (
    status,
    reason,
    code,
  ) => {
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurns: {
        requiresStableTurnIdentity: true,
        createTurnIdentity: () => "unused",
        admit: async () => ({ status, conversationId: "conversation-1" }),
      },
      agentTurnIdentity: {
        exists: async () => true,
        create: async () => "created-1",
        ensure: async () => {},
      },
    });
    const turnIdentity = application.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity",
      turnId: "turn-1",
      identitySource: "provided",
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
    });
    await expect(application.admitAgentTurn({
      kind: "admit-agent-turn",
      conversationId: "conversation-1",
      input: { parts: [{ type: "text", text: "hello" }] },
      turnIdentity,
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:test",
        connectionId: "connection-1",
      },
      execution: { execute: async () => {}, cancelPending: () => {} },
    })).rejects.toMatchObject({ code, reason });
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
