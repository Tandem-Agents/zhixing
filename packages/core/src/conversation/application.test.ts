import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  CONVERSATION_ABORT_COMMAND,
  CONVERSATION_ADMIT_AGENT_TURN_COMMAND,
  CONVERSATION_CREATE_COMMAND,
  CONVERSATION_CLEAR_COMMAND,
  CONVERSATION_COMPACT_COMMAND,
  CONVERSATION_CONTEXT_BUDGET_QUERY,
  CONVERSATION_DELETE_COMMAND,
  CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
  CONVERSATION_HISTORY_QUERY,
  CONVERSATION_IDENTITY_EXISTS_QUERY,
  CONVERSATION_LIST_QUERY,
  CONVERSATION_ENSURE_SHELL_COMMAND,
  CONVERSATION_RENAME_COMMAND,
  CONVERSATION_RESUME_COMMAND,
  CONVERSATION_RESOLVE_UNCERTAIN_COMMAND,
  CONVERSATION_SECURITY_QUERY,
  CONVERSATION_TASK_LIST_QUERY,
  CONVERSATION_UPDATE_TASK_LIST_COMMAND,
  CONVERSATION_USAGE_QUERY,
  ConversationApplicationError,
  ConversationDirectoryApplicationService,
  ConversationTaskListToolApplicationService,
  createConversationIdentityLifecycleApplication,
  createConversationDirectoryProductApiContribution,
  mergeConversationDirectoryViews,
  projectConversationClear,
  projectConversationDelete,
  type ConversationDirectoryRecord,
  ConversationCancellationResponseEffect,
  type ConversationDirectoryStorage,
  type ConversationAgentTurnAdmissionPort,
  type ConversationCompactPort,
  type ConversationTaskListPort,
  type ConversationTaskListToolStagePort,
  type ConversationUsageProjectionPort,
  type ConversationSecurityProjectionPort,
} from "./application.js";

class TestCancellationResponseEffect extends ConversationCancellationResponseEffect {
  constructor() {
    super();
    Object.freeze(this);
  }
}

describe("Conversation task-list tool application", () => {
  it("owns deterministic replacement identity and stages through one finite port", async () => {
    const staged: Parameters<ConversationTaskListToolStagePort["stage"]>[0][] = [];
    const application = new ConversationTaskListToolApplicationService({
      stage: async (input) => staged.push(input),
    });
    const command = {
      conversationId: "conversation-1",
      toolCallId: "tool-call-1",
      items: [
        { content: "first", status: "pending" as const },
        { id: "stable", content: "second", status: "in_progress" as const },
      ],
    };

    const first = await application.replace(command);
    const replay = await application.replace(command);

    expect(first).toEqual(replay);
    expect(first.operationId).toBe("task-list:tool-call-1");
    expect(first.taskList.items[0]?.id).toMatch(/^task-/u);
    expect(first.taskList.items[1]?.id).toBe("stable");
    expect(Object.isFrozen(first.taskList.items)).toBe(true);
    expect(staged[1]).toEqual(staged[0]);
  });

  it("rejects missing durable identity before staging", async () => {
    const stage: ConversationTaskListToolStagePort["stage"] = vi.fn(async () => {});
    const application = new ConversationTaskListToolApplicationService({ stage });
    await expect(application.replace({
      conversationId: "conversation-1",
      items: [{ content: "blocked", status: "pending" }],
    })).rejects.toMatchObject({ reason: "task-list-operation-required" });
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("Conversation identity lifecycle application", () => {
  it("owns shell and scope-sensitive runtime storage initialization", async () => {
    const exists = vi.fn(async (conversationId: string) =>
      conversationId.endsWith("present"),
    );
    const create = vi.fn(async () => "created-conversation");
    const ensure = vi.fn(async () => {});
    const ensureTranscript = vi.fn(async () => {});
    const application = createConversationIdentityLifecycleApplication({
      exists,
      create,
      ensure,
      ensureTranscript,
    });

    expect(Object.isFrozen(application)).toBe(true);
    await expect(application.identityExists("conversation-present")).resolves.toBe(
      true,
    );
    await expect(application.createIdentity()).resolves.toBe(
      "created-conversation",
    );

    await application.ensureShell("ws:scene-a:conversation-shell");
    await application.initializeRuntimeStorage("conversation-user");
    await application.initializeRuntimeStorage(
      "ws:scene-a:conversation-workscene",
    );
    await application.initializeRuntimeStorage(
      "ws:scene-a:conversation-workscene",
    );

    expect(ensure).toHaveBeenNthCalledWith(
      1,
      "ws:scene-a:conversation-shell",
    );
    expect(ensure).toHaveBeenNthCalledWith(2, "conversation-user");
    expect(ensureTranscript).toHaveBeenCalledTimes(2);
    expect(ensureTranscript).toHaveBeenCalledWith(
      "ws:scene-a:conversation-workscene",
    );
  });

  it("rejects invalid identities before invoking storage mechanisms", async () => {
    const exists = vi.fn(async () => false);
    const ensure = vi.fn(async () => {});
    const ensureTranscript = vi.fn(async () => {});
    const application = createConversationIdentityLifecycleApplication({
      exists,
      create: async () => "created-conversation",
      ensure,
      ensureTranscript,
    });

    await expect(application.identityExists("")).rejects.toThrow(
      "identity lifecycle query",
    );
    await expect(application.ensureShell("")).rejects.toThrow(
      "identity lifecycle shell",
    );
    await expect(application.initializeRuntimeStorage("")).rejects.toThrow(
      "runtime storage initialization",
    );
    expect(exists).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(ensureTranscript).not.toHaveBeenCalled();
  });

  it("propagates storage failures without manufacturing a successful shell", async () => {
    const failure = new Error("storage unavailable");
    const application = createConversationIdentityLifecycleApplication({
      exists: async () => {
        throw failure;
      },
      create: async () => {
        throw failure;
      },
      ensure: async () => {
        throw failure;
      },
      ensureTranscript: async () => {
        throw failure;
      },
    });

    await expect(application.identityExists("conversation-user")).rejects.toBe(
      failure,
    );
    await expect(application.createIdentity()).rejects.toBe(failure);
    await expect(application.ensureShell("conversation-user")).rejects.toBe(
      failure,
    );
    await expect(
      application.initializeRuntimeStorage(
        "ws:scene-a:conversation-workscene",
      ),
    ).rejects.toBe(failure);
  });
});

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
  it("owns durable identity existence and idempotent shell establishment through Product API", async () => {
    const present = new Set(["conversation-1", "ws:scene-1:conversation-2"]);
    const exists = vi.fn(async (conversationId: string) =>
      present.has(conversationId),
    );
    const ensure = vi.fn(async (conversationId: string) => {
      present.add(conversationId);
    });
    const create = vi.fn(async () => "unused");
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      agentTurnIdentity: { exists, create, ensure },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );

    await expect(
      dispatcher.query(CONVERSATION_IDENTITY_EXISTS_QUERY, {
        kind: "identity-exists",
        conversationId: "conversation-1",
      }),
    ).resolves.toEqual({ exists: true });
    await expect(
      dispatcher.query(CONVERSATION_IDENTITY_EXISTS_QUERY, {
        kind: "identity-exists",
        conversationId: "ws:scene-1:conversation-2",
      }),
    ).resolves.toEqual({ exists: true });
    const ensured = await dispatcher.command(CONVERSATION_ENSURE_SHELL_COMMAND, {
      kind: "ensure-shell",
      conversationId: "ws:scene-1:new-conversation",
    });
    expect(ensured.result).toEqual({
      conversationId: "ws:scene-1:new-conversation",
    });
    expect(Object.isFrozen(ensured.result)).toBe(true);
    await dispatcher.command(CONVERSATION_ENSURE_SHELL_COMMAND, {
      kind: "ensure-shell",
      conversationId: "ws:scene-1:new-conversation",
    });
    await expect(
      dispatcher.query(CONVERSATION_IDENTITY_EXISTS_QUERY, {
        kind: "identity-exists",
        conversationId: "ws:scene-1:new-conversation",
      }),
    ).resolves.toEqual({ exists: true });
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();

    await expect(
      application.queryIdentityExists({
        kind: "identity-exists",
        conversationId: "",
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      application.ensureShell({
        kind: "ensure-shell",
        conversationId: "x".repeat(481),
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

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

  it("owns compact result semantics and emits no Product API fact", async () => {
    const compactExisting = vi.fn<ConversationCompactPort["compactExisting"]>(
      async () => ({
        status: "done",
        outcome: {
          runtimeModified: true,
          windowApplied: true,
          tokensBefore: 1_000,
          tokensAfter: 100,
          emergencyFloor: { droppedTurns: 2, error: "summary failed" },
        },
      }),
    );
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      compact: { compactExisting },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );

    await expect(dispatcher.command(CONVERSATION_COMPACT_COMMAND, {
      kind: "compact",
      conversationId: "conversation-1",
    })).resolves.toEqual({
      result: {
        modified: true,
        tokensBefore: 1_000,
        tokensAfter: 100,
        emergencyFloor: { droppedTurns: 2, error: "summary failed" },
      },
      facts: [],
    });
    expect(compactExisting).toHaveBeenCalledWith("conversation-1");

    compactExisting.mockResolvedValueOnce({
      status: "done",
      outcome: { runtimeModified: true, windowApplied: false },
    });
    await expect(application.compact({
      kind: "compact",
      conversationId: "conversation-1",
    })).resolves.toEqual({ modified: false });
  });

  it("owns compact busy/not-found/unsupported/local-unavailable terminals", async () => {
    const compactExisting = vi.fn<ConversationCompactPort["compactExisting"]>();
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      compact: { compactExisting },
    });
    const cases = [
      ["busy", "busy", "compact-busy"],
      ["not-found", "not-found", "compact-conversation-not-found"],
      ["unsupported", "unsupported", "compact-unsupported"],
      ["unavailable", "busy", "compact-unavailable"],
    ] as const;
    for (const [status, code, reason] of cases) {
      compactExisting.mockResolvedValueOnce({ status });
      await expect(application.compact({
        kind: "compact",
        conversationId: "conversation-1",
      })).rejects.toMatchObject({ code, reason });
    }
    await expect(application.compact({
      kind: "compact",
      conversationId: "",
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("owns distinct context-budget and usage projections with zero Product API facts", async () => {
    const budget = {
      contextWindow: 200_000,
      effectiveWindow: 180_000,
      currentTokens: 9_000,
      usageRatio: 0.05,
      status: "normal" as const,
    };
    const inspectContextBudgetExisting = vi.fn<
      ConversationUsageProjectionPort["inspectContextBudgetExisting"]
    >(async () => ({
      status: "done",
      outcome: { budget, turnCount: 3, calibrationFactor: 1.25 },
    }));
    const inspectUsageExisting = vi.fn<
      ConversationUsageProjectionPort["inspectUsageExisting"]
    >(async () => ({
      status: "done",
      outcome: {
        budget,
        turnCount: 3,
        calibrationFactor: 1.25,
        subUsages: [{
          index: 0,
          description: "research",
          tokens: 42,
          toolUses: 2,
          durationMs: 100,
          subId: "sub-1",
          status: "succeeded",
        }],
      },
    }));
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      usage: { inspectContextBudgetExisting, inspectUsageExisting },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );

    await expect(dispatcher.query(CONVERSATION_CONTEXT_BUDGET_QUERY, {
      kind: "context-budget",
      conversationId: "conversation-1",
    })).resolves.toEqual({
      budget,
      turnCount: 3,
      calibrationFactor: 1.25,
    });
    expect(inspectContextBudgetExisting).toHaveBeenCalledOnce();
    expect(inspectUsageExisting).not.toHaveBeenCalled();

    await expect(dispatcher.query(CONVERSATION_USAGE_QUERY, {
      kind: "usage",
      conversationId: "conversation-1",
    })).resolves.toEqual({
      budget,
      turnCount: 3,
      calibrationFactor: 1.25,
      subUsages: [{
        index: 0,
        description: "research",
        tokens: 42,
        toolUses: 2,
        durationMs: 100,
        subId: "sub-1",
        status: "succeeded",
      }],
    });
    expect(inspectUsageExisting).toHaveBeenCalledOnce();
  });

  it("owns usage-query not-found, unsupported, unavailable, and invalid terminals", async () => {
    const inspectContextBudgetExisting = vi.fn<
      ConversationUsageProjectionPort["inspectContextBudgetExisting"]
    >();
    const inspectUsageExisting = vi.fn<
      ConversationUsageProjectionPort["inspectUsageExisting"]
    >();
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      usage: { inspectContextBudgetExisting, inspectUsageExisting },
    });
    for (const [method, kind, status, code, reason] of [
      ["context", "context-budget", "not-found", "not-found", "context-budget-conversation-not-found"],
      ["context", "context-budget", "unsupported", "unsupported", "context-budget-unsupported"],
      ["context", "context-budget", "unavailable", "busy", "context-budget-unavailable"],
      ["usage", "usage", "not-found", "not-found", "usage-conversation-not-found"],
      ["usage", "usage", "unsupported", "unsupported", "usage-unsupported"],
      ["usage", "usage", "unavailable", "busy", "usage-unavailable"],
    ] as const) {
      const port = method === "context"
        ? inspectContextBudgetExisting
        : inspectUsageExisting;
      port.mockResolvedValueOnce({ status });
      const call = kind === "context-budget"
        ? application.queryContextBudget({ kind, conversationId: "conversation-1" })
        : application.queryUsage({ kind, conversationId: "conversation-1" });
      await expect(call).rejects.toMatchObject({ code, reason });
    }
    await expect(application.queryContextBudget({
      kind: "context-budget",
      conversationId: "",
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(application.queryUsage({
      kind: "usage",
      conversationId: " ",
    })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("owns a fresh deeply immutable security projection with zero Product API facts", async () => {
    const snapshot = {
      contextId: { kind: "scene" as const, sceneId: "review" },
      workspacePath: "C:/workspace",
      permissionRules: [{
        id: "permission-1",
        pattern: { tool: "bash", argument: "pnpm *" },
        decision: "allow" as const,
        scope: "context" as const,
        createdAt: 1,
        lastMatchedAt: 2,
        matchCount: 3,
        contextId: { kind: "workspace" as const, hash: "workspace-hash" },
        contextPath: "C:/workspace",
        contributors: [{ origin: "user" as const, timestamp: 4 }],
      }],
      builtinRules: [{
        id: "builtin-1",
        name: "Protect hosts",
        description: "Blocks protected network targets",
        enabled: true,
        match: {
          type: "composite" as const,
          op: "or" as const,
          specs: [{
            type: "network" as const,
            hosts: ["127.0.0.1"],
            ports: [22],
            direction: "outbound" as const,
          }],
        },
        action: "block" as const,
        bypassImmune: true,
        severity: "critical" as const,
        category: "network_abuse" as const,
        source: "builtin" as const,
        message: "blocked",
        suggestion: "choose another target",
      }],
      rateLimits: [{ key: "bash", used: 1, limit: 5 }],
      confirmations: [{ key: "bash::pnpm", count: 2, highestRisk: "high" as const }],
    };
    const inspectSecurityExisting = vi.fn<
      ConversationSecurityProjectionPort["inspectSecurityExisting"]
    >(async () => ({ status: "done", snapshot }));
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      security: { inspectSecurityExisting },
    });
    const dispatcher = new ProductApiDispatcher(
      CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET,
      [createConversationDirectoryProductApiContribution(application)],
    );

    const result = await dispatcher.query(CONVERSATION_SECURITY_QUERY, {
      kind: "security",
      conversationId: "conversation-1",
    });
    expect(result).toEqual(snapshot);
    expect(inspectSecurityExisting).toHaveBeenCalledWith("conversation-1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.contextId)).toBe(true);
    expect(Object.isFrozen(result.permissionRules[0]?.pattern)).toBe(true);
    expect(Object.isFrozen(result.permissionRules[0]?.contributors)).toBe(true);
    expect(Object.isFrozen(result.builtinRules[0]?.match)).toBe(true);
    expect(Object.isFrozen(
      result.builtinRules[0]?.match.type === "composite"
        ? result.builtinRules[0].match.specs[0]
        : undefined,
    )).toBe(true);

    snapshot.permissionRules[0]!.pattern.argument = "changed";
    snapshot.permissionRules[0]!.contributors![0]!.timestamp = 99;
    snapshot.builtinRules[0]!.match.specs[0]!.hosts![0] = "changed";
    snapshot.rateLimits[0]!.used = 99;
    expect(result.permissionRules[0]?.pattern.argument).toBe("pnpm *");
    expect(result.permissionRules[0]?.contributors?.[0]?.timestamp).toBe(4);
    const projectedMatch = result.builtinRules[0]?.match;
    expect(projectedMatch?.type === "composite"
      ? projectedMatch.specs[0]?.type === "network"
        ? projectedMatch.specs[0].hosts?.[0]
        : undefined
      : undefined).toBe("127.0.0.1");
    expect(result.rateLimits[0]?.used).toBe(1);
  });

  it("owns security-query not-found, unsupported, unavailable, and invalid terminals", async () => {
    const inspectSecurityExisting = vi.fn<
      ConversationSecurityProjectionPort["inspectSecurityExisting"]
    >();
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      security: { inspectSecurityExisting },
    });
    for (const [status, code, reason] of [
      ["not-found", "not-found", "security-conversation-not-found"],
      ["unsupported", "unsupported", "security-unsupported"],
      ["unavailable", "busy", "security-unavailable"],
    ] as const) {
      inspectSecurityExisting.mockResolvedValueOnce({ status });
      await expect(application.querySecurity({
        kind: "security",
        conversationId: "conversation-1",
      })).rejects.toMatchObject({ code, reason });
    }
    await expect(application.querySecurity({
      kind: "security",
      conversationId: " ",
    })).rejects.toMatchObject({ code: "invalid-input" });
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
    ).resolves.toEqual({
      result: { cancelled: true, feedback: { kind: "in-flight" } },
      facts: [],
    });
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

  it("admits a stable conversation-wide cancellation only when the mechanism owns the durable response", async () => {
    const cancel = vi.fn(async () => ({
      matchedDurableRuns: 0,
      abortedInFlight: false,
      cancelledPending: 0,
      authoritativeResponse: true,
    }));
    const application = new ConversationDirectoryApplicationService({
      storage: fixture().storage,
      runControl: {
        requiresStableCancellationIdentity: true,
        requiresAuthoritativeRunIdentity: true,
        emptyCancellationIsSuccess: false,
        createCancellationIdentity: () => "unused",
        cancel,
        resolveUncertain: vi.fn(async () => ({
          state: "cancelled",
          factDigest: `sha256:${"b".repeat(64)}`,
        })),
      },
    });
    const caller = {
      kind: "surface" as const,
      surfacePrincipal: "channel:feishu:user-1",
      connectionId: "channel:feishu",
    };
    const response = new TestCancellationResponseEffect();

    await expect(application.abort({
      kind: "abort",
      conversationId: "conversation-1",
      operationId: "abort-operation-1",
      caller,
      response,
    })).resolves.toEqual({
      cancelled: true,
      feedback: { kind: "authoritative" },
    });
    expect(cancel).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      operationId: "abort-operation-1",
      caller,
      occurredAt: expect.any(Number),
      response,
    });
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
    ).resolves.toEqual({
      cancelled: true,
      feedback: { kind: "in-flight" },
    });
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

  it("projects delete before dependent lifecycle and preserves strict/best-effort failures", async () => {
    const steps: string[] = [];
    const projection = {
      deleteRuntimeAndStorage: async (input: { readonly onDeleted: () => void }) => {
        steps.push("delete");
        input.onDeleted();
        return "deleted" as const;
      },
      cancelDependentLifecycle: async () => {
        steps.push("cancel");
      },
      removeDependentData: async () => {
        steps.push("remove");
        throw new Error("remove failed");
      },
    };
    await expect(projectConversationDelete({
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      deletionAlreadyCommitted: false,
      dependentFailure: "propagate",
      projection,
      publishFact: () => { steps.push("fact"); },
    })).rejects.toThrow("remove failed");
    expect(steps).toEqual(["delete", "fact", "cancel", "remove"]);

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
    expect(failed).toEqual(["remove-data"]);

    steps.length = 0;
    failed.length = 0;
    await expect(projectConversationDelete({
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      deletionAlreadyCommitted: false,
      dependentFailure: "best-effort",
      projection: {
        ...projection,
        cancelDependentLifecycle: async () => {
          steps.push("cancel");
          throw new Error("cancel failed");
        },
      },
      publishFact: () => { steps.push("fact"); },
      onDependentFailure: (step) => { failed.push(step); },
    })).resolves.toMatchObject({ kind: "conversation-deleted" });
    expect(steps).toEqual(["delete", "fact", "cancel", "remove"]);
    expect(failed).toEqual(["cancel-lifecycle", "remove-data"]);

    steps.length = 0;
    await expect(projectConversationDelete({
      conversationId: "conversation-1",
      operationId: "delete-operation-1",
      deletionAlreadyCommitted: false,
      dependentFailure: "propagate",
      projection: {
        ...projection,
        cancelDependentLifecycle: async () => {
          steps.push("cancel");
          throw new Error("cancel failed");
        },
      },
      publishFact: () => { steps.push("fact"); },
    })).rejects.toThrow("cancel failed");
    expect(steps).toEqual(["delete", "fact", "cancel"]);
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
            capabilitySet: "limited",
            continuationConfirmation: "required",
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
      availability: {
        capabilitySet: "limited",
        continuationConfirmation: "required",
      },
    });
  });
});
