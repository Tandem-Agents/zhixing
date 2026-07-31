import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ConfirmationBroker,
  ConversationRepository,
  ShardedTranscriptStore,
  SnapshotStore,
  createEventBus,
  type AgentEventMap,
  type AgentYield,
  type ConfirmationRequest,
  type Message,
  type RunRecordInput,
  type RunResult,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ControlResult } from "@zhixing/core/contracts";
import { assertGolden, createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmationHub,
  ControlAdmissionJournal,
  ConversationManager,
  createInitialControlEnvelope,
} from "@zhixing/owner-kernel";
import { createServerContext } from "../context.js";
import {
  buildBuiltinRegistry,
  captureBuiltinRegistryDescriptor,
} from "../rpc/methods/index.js";
import { buildServerShutdownMethod } from "../rpc/methods/server.js";
import {
  buildSessionNewMethod,
  buildSessionSendMethod,
} from "../rpc/methods/session.js";
import {
  createConfirmationBridge,
  createRunEventForwarder,
  projectSessionTurn,
} from "@zhixing/rpc";
import { toJsonRpcError, type HandlerContext } from "../rpc/handlers.js";
import type { RuntimeFactory, SessionRuntime } from "@zhixing/owner-kernel";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import type { ConversationDirectory } from "../runtime/conversation-directory.js";

const FIXED_NOW = new Date("2026-07-11T12:00:00.000Z");

describe("distributed runtime migration behavior golden", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the normalized pre-migration behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const actual = {
      rpc: await captureRpcCatalog(),
      session: await captureSessionProjection(),
      events: captureSessionEvents(),
      confirmation: await captureConfirmationRoundTrip(),
      controlAdmission: await captureControlAdmissionShadow(),
      persistence: await capturePersistence(),
      shutdown: await captureShutdownStrategies(),
    };

    await assertGolden(
      new URL("./__goldens__/distributed-runtime-behavior.golden.json", import.meta.url),
      actual,
      {
        volatileKeys: [
          "createdAt",
          "estimatedCompleteAt",
          "expiresAt",
          "lastActiveAt",
          "resolvedAt",
          "timestamp",
        ],
      },
    );
  }, 15_000);

  it("exposes immutable registry metadata without handler references", () => {
    const registry = buildBuiltinRegistry();
    const descriptor = registry.list().find((entry) => entry.name === "health")!;

    expect(descriptor).toEqual({ name: "health", requiresAuth: false });
    expect(descriptor).not.toHaveProperty("handler");
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("derives every applicable role golden from the canonical production registry", async () => {
    const golden = JSON.parse(await readFile(new URL(
      "./__goldens__/canonical-registry.golden.json",
      import.meta.url,
    ), "utf8")) as {
      roleConfigurations: Record<string, unknown>;
      retiredMethods: string[];
    };
    const descriptor = captureBuiltinRegistryDescriptor();
    expect(golden.roleConfigurations).toEqual({
      "anchor-executor": descriptor,
      "anchor-surface": descriptor,
      "executor-only": [],
    });
    const registered = new Set(descriptor.map(({ name }) => name));
    for (const retired of golden.retiredMethods) expect(registered.has(retired)).toBe(false);
  });
});

async function captureRpcCatalog() {
  const registry = buildBuiltinRegistry();
  const createContext = (): HandlerContext => ({
    connection: {
      id: 1,
      authenticated: true,
      loopback: true,
      closed: false,
      clientInfo: undefined,
      sendSuccess() {},
      sendError() {},
      notify() {},
      close() {},
      onClose: () => () => {},
    },
    server: createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 18900 },
      version: "golden",
      token: "golden-token",
    }),
  }) as HandlerContext;

  const catalog = [];
  for (const entry of registry.list()) {
    try {
      const result = await registry.dispatch(entry.name, {}, createContext());
      catalog.push({
        method: entry.name,
        requiresAuth: entry.requiresAuth ?? true,
        emptyRequest: {},
        outcome: { kind: "result", shape: describeShape(result) },
      });
    } catch (error) {
      const rpcError = toJsonRpcError(error);
      catalog.push({
        method: entry.name,
        requiresAuth: entry.requiresAuth ?? true,
        emptyRequest: {},
        outcome: {
          kind: "error",
          code: rpcError.code,
          shape: describeShape(rpcError),
        },
      });
    }
  }
  return catalog;
}

async function captureControlAdmissionShadow() {
  const root = await createTempDir("control-admission-golden");
  const artifacts = new FileArtifactStore(join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(join(root, "authority"), artifacts, {
    clock: () => FIXED_NOW.toISOString(),
  });
  const journal = new ControlAdmissionJournal(log, artifacts);
  const conversations = new ConversationManager(createCompletedFactory(), managerOptions());
  const directory = createGoldenConversationDirectory();
  const server = createServerContext({
    config: { ...DEFAULT_SERVER_CONFIG, port: 18900 },
    version: "golden",
    token: "golden-token",
    conversations,
    conversationDirectory: directory,
  });
  const context = {
    connection: {
      id: 1,
      authenticated: true,
      loopback: true,
      closed: false,
      clientInfo: undefined,
      sendSuccess() {},
      sendError() {},
      notify() {},
      close() {},
      onClose: () => () => {},
    },
    server,
  } as HandlerContext;
  const source = {
    principal: {
      surfacePrincipal: "surface:golden",
      deviceId: "device:golden",
      connectionId: "1",
    },
  } as const;

  try {
    const legacyCreated = (await buildSessionNewMethod().handler(
      undefined,
      context,
    )) as { conversationId: string; name: string };
    const createResult: ControlResult = {
      v: 1,
      status: "ok",
      body: { t: "session-create", conversationId: legacyCreated.conversationId },
    };
    const createEnvelope = createInitialControlEnvelope({
      requestId: "request:golden:create",
      source,
      at: FIXED_NOW.toISOString(),
      body: { t: "session-create" },
    });
    const shadowCreated = await journal.apply({
      envelope: createEnvelope,
      source,
      prepare: () => ({ result: createResult, authorityRevision: 0 }),
    });

    const ingress = {
      kind: "first-party" as const,
      surfacePrincipal: source.principal.surfacePrincipal,
      deviceId: source.principal.deviceId,
      ingressId: "ingress:golden:input",
      receivedAt: FIXED_NOW.toISOString(),
      turnOrigin: { channel: "rpc", triggeredBy: source.principal.connectionId },
    };
    const inputSource = { principal: source.principal, ingress };
    const legacySent = (await buildSessionSendMethod().handler(
      {
        conversationId: legacyCreated.conversationId,
        text: "golden shadow input",
        turnId: "run:golden:input",
      },
      context,
    )) as { conversationId: string; turnId: string };
    const inputResult: ControlResult = {
      v: 1,
      status: "ok",
      body: { t: "input", runId: legacySent.turnId, queuedPosition: 0 },
    };
    const inputEnvelope = createInitialControlEnvelope({
      requestId: "request:golden:input",
      source: inputSource,
      at: FIXED_NOW.toISOString(),
      body: {
        t: "input",
        conversationId: legacySent.conversationId,
        ingress: { ingressId: ingress.ingressId, source: ingress.kind },
        input: { parts: [{ type: "text", text: "golden shadow input" }] },
        invocation: { kind: "agent", source: "interactive" },
        ownerEpoch: 0,
      },
    });
    const shadowInput = await journal.apply({
      envelope: inputEnvelope,
      source: inputSource,
      prepare: () => ({ result: inputResult, authorityRevision: 0 }),
    });

    expect(shadowCreated).toMatchObject({ result: createResult });
    expect(shadowInput).toMatchObject({ result: inputResult });
    const commits = await log.readAll();
    expect(new Set(commits.flatMap((commit) => commit.entries.map((entry) => entry.stream)))).toEqual(
      new Set(["control"]),
    );
    return {
      sessionCreate: { legacy: createResult, shadow: shadowCreated.result },
      input: { legacy: inputResult, shadow: shadowInput.result },
      controlStates: commits.flatMap((commit) =>
        commit.entries.map((entry) => (entry.body as { t: string }).t),
      ),
    };
  } finally {
    await conversations.disposeAll();
  }
}

function createGoldenConversationDirectory(): ConversationDirectory {
  const conversations = new Map<string, { id: string; name: string }>();
  let sequence = 0;
  const record = (id: string) => {
    const item = conversations.get(id);
    if (!item) throw new Error(`Unknown golden conversation: ${id}`);
    return {
      ...item,
      createdAt: FIXED_NOW.toISOString(),
      lastActiveAt: FIXED_NOW.toISOString(),
      isDefault: false,
      archived: false,
    };
  };
  return {
    async list() {
      return [...conversations].map(([id]) => record(id));
    },
    async exists(id) {
      return conversations.has(id);
    },
    async create() {
      const id = `conversation-golden-${sequence++}`;
      conversations.set(id, { id, name: id });
      return record(id);
    },
    async ensure(id) {
      if (!conversations.has(id)) conversations.set(id, { id, name: id });
      return record(id);
    },
    async rename(id, name) {
      if (!conversations.has(id)) return null;
      conversations.set(id, { id, name });
      return record(id);
    },
    async touch(id) {
      return conversations.has(id) ? record(id) : null;
    },
    async clear(id) {
      return conversations.has(id);
    },
    async remove(id) {
      return conversations.delete(id);
    },
    async readRunsReverse() {
      return { runs: [], hasMore: false };
    },
  };
}

function describeShape(value: unknown, key?: string): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [describeShape(value[0])];
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([entryKey, item]) => [entryKey, describeShape(item, entryKey)]),
    );
  }
  if (
    typeof value === "string" &&
    ["kind", "phase", "reason", "status", "strategy"].includes(key ?? "")
  ) {
    return value;
  }
  return typeof value;
}

async function captureSessionProjection() {
  const normalManager = new ConversationManager(createCompletedFactory(), managerOptions());
  const normal = await normalManager.getOrCreate("golden-conversation");
  const normalNotifications: Array<{ method: string; params: unknown }> = [];
  await projectSessionTurn({
    manager: normalManager,
    managed: normal,
    text: "hello",
    turnId: "turn-golden",
    notify: (method, params) => normalNotifications.push({ method, params }),
  });
  await normalManager.disposeAll();

  const gate = deferred();
  const yielded = deferred();
  const cancelManager = new ConversationManager(
    createCancelledFactory(gate.promise, yielded.resolve),
    managerOptions(),
  );
  const cancelling = await cancelManager.getOrCreate("cancel-conversation");
  const cancelNotifications: Array<{ method: string; params: unknown }> = [];
  const projected = projectSessionTurn({
    manager: cancelManager,
    managed: cancelling,
    text: "stop",
    turnId: "turn-cancel",
    notify: (method, params) => cancelNotifications.push({ method, params }),
  });
  await yielded.promise;
  const abortResult = cancelManager.abort("cancel-conversation", {
    kind: "user-cancel",
    source: "rpc",
    pressedAt: FIXED_NOW.getTime(),
  });
  gate.resolve();
  await projected;
  await cancelManager.disposeAll();

  return { normal: normalNotifications, cancel: { abortResult, notifications: cancelNotifications } };
}

function managerOptions() {
  return {
    graceTimeoutMs: 60_000,
    idleTimeoutMs: 30 * 60_000,
    idleCheckIntervalMs: 60_000,
  };
}

function createCompletedFactory(): RuntimeFactory {
  return {
    async create(sessionId) {
      return createRuntime(sessionId, async function* (messages) {
        yield { type: "text_delta", text: "hello" };
        yield {
          type: "turn_complete",
          turnCount: 1,
          usage: { inputTokens: 2, outputTokens: 1 },
        };
        return completedRun(messages, "world");
      });
    },
  };
}

function createCancelledFactory(
  gate: Promise<void>,
  onYield: () => void,
): RuntimeFactory {
  return {
    async create(sessionId) {
      let aborted = false;
      const runtime = createRuntime(sessionId, async function* (messages) {
        onYield();
        yield { type: "text_delta", text: "before-cancel" };
        await gate;
        if (aborted) {
          return {
            agentResult: {
              reason: "aborted",
              usage: { inputTokens: 1, outputTokens: 0 },
            },
            runRecord: {
              timestamp: FIXED_NOW.toISOString(),
              messages: [messages.at(-1)!],
              usage: { inputTokens: 1, outputTokens: 0 },
            },
            newMessages: [],
            durationMs: 0,
          };
        }
        return completedRun(messages, "unexpected");
      });
      runtime.abort = () => {
        aborted = true;
        return true;
      };
      return runtime;
    },
  };
}

function createRuntime(
  sessionId: string,
  run: (messages: readonly Message[]) => AsyncGenerator<AgentYield, RunResult>,
): SessionRuntime {
  return {
    sessionId,
    run,
    abort: () => false,
    async dispose() {},
  };
}

function completedRun(messages: readonly Message[], text: string): RunResult {
  const assistant: Message = {
    role: "assistant",
    content: [{ type: "text", text }],
  };
  const runRecord: RunRecordInput = {
    timestamp: FIXED_NOW.toISOString(),
    messages: [messages.at(-1)!, assistant],
    usage: { inputTokens: 2, outputTokens: 1 },
  };
  return {
    agentResult: {
      reason: "completed",
      message: assistant,
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    runRecord,
    newMessages: [assistant],
    durationMs: 0,
  };
}

function captureSessionEvents() {
  const bus = createEventBus<AgentEventMap>({ lineage: "main" });
  const events: unknown[] = [];
  const dispose = createRunEventForwarder((_conversationId, event) => events.push(event))({
    bus,
    conversationId: "golden-conversation",
    turnContext: {
      turnId: "turn-golden",
      turnOrigin: { channel: "rpc", triggeredBy: "1" },
    } as never,
  });
  bus.emit("retry:attempt", {
    attempt: 1,
    maxAttempts: 3,
    delayMs: 100,
    reason: "transient",
  } as never);
  bus.emit("lifecycle:warning", {
    hookId: "golden-hook",
    phase: "onWindowOpen",
    windowIndex: 0,
    runtimeId: "runtime-golden",
    message: "warning",
  });
  dispose();
  return events;
}

async function captureConfirmationRoundTrip() {
  const hub = new ConfirmationHub();
  const broker = new ConfirmationBroker();
  broker.onRequest(() => {});
  hub.attach("golden-broker", broker, { conversationId: "golden-conversation" });
  const notifications: Array<{ method: string; params: unknown }> = [];
  const connection = {
    id: 1,
    authenticated: true,
    loopback: true,
    closed: false,
    notify: (method: string, params: unknown) => notifications.push({ method, params }),
  };
  const bridge = createConfirmationBridge({
    connections: new Set([connection as never]),
    hub,
    conversations: {
      getObserverConnectionIds: () => new Set(["1"]),
    } as never,
  });
  const request: ConfirmationRequest = {
    id: "confirmation-golden",
    tool: "bash",
    toolInput: { command: "pwd" },
    workingDirectory: "/workspace",
    display: {
      title: "Run command",
      body: { kind: "bash", command: "pwd", commandPreview: "pwd" },
      cwd: "/workspace",
    },
    options: [],
    sessionType: "interactive",
    contextId: { kind: "main" },
    createdAt: FIXED_NOW.getTime(),
    expiresAt: FIXED_NOW.getTime() + 60_000,
    turnOrigin: { channel: "rpc", triggeredBy: "1" },
  };
  const pending = broker.requestConfirmation(request);
  broker.resolve(request.id, { kind: "allow-once" });
  await pending;
  bridge.dispose();
  return notifications;
}

async function capturePersistence() {
  const home = await createTempDir("runtime-golden");
  const previousHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = home;
  try {
    const repository = new ConversationRepository({ kind: "user" });
    const conversation = await repository.ensure("golden-conversation", {
      name: "Golden conversation",
    });
    const conversations = join(home, "conversations");
    const transcript = new ShardedTranscriptStore(conversations, { platform: "linux" });
    await transcript.appendRunRecord("golden-conversation", {
      timestamp: FIXED_NOW.toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "world" }] },
      ],
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    const snapshots = new SnapshotStore(conversations, { platform: "linux" });
    await snapshots.write("golden-conversation", {
      coveredThroughRunIndex: 0,
      structuredSummary: { facts: "fact", state: "state", active: "active" },
      tokensBefore: 100,
      tokensAfter: 20,
    });

    const index = await transcript.readIndex("golden-conversation");
    const shard = await transcript.readShardLines("golden-conversation", index!.shards[0]!);
    const snapshot = await snapshots.list("golden-conversation");
    const meta = JSON.parse(
      await readFile(join(conversations, "golden-conversation", "meta.json"), "utf8"),
    );
    return { conversation, meta, transcript: { index, shard }, snapshot };
  } finally {
    if (previousHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = previousHome;
  }
}

async function captureShutdownStrategies() {
  const capture = async (strategy: "immediate" | "drain" | "cancel") => {
    const calls: unknown[] = [];
    const shutdownTriggered = deferred();
    const server = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 18900 },
      version: "golden",
      token: "golden-token",
      runtimeControl: {
        flushDelivery: async () => {
          calls.push({ action: "flush-delivery" });
        },
      },
    });
    server.requestShutdown = (reason) => {
      calls.push({ action: "shutdown", reason });
      shutdownTriggered.resolve();
    };
    server.conversations = {
      list: () => [],
      abortAllAndWait: async (reason: unknown, timeoutMs: number) => {
        calls.push({ action: "abort-conversations", reason, timeoutMs });
        return 1;
      },
    } as never;
    server.runRegistry = {
      size: () => 0,
      abortAllAndWait: async (reason: unknown, timeoutMs: number) => {
        calls.push({ action: "abort-jobs", reason, timeoutMs });
        return 1;
      },
    } as never;
    const context = { connection: { authenticated: true }, server } as HandlerContext;
    const result = buildServerShutdownMethod().handler(
      { reason: "golden-stop", strategy, timeoutMs: 1_000 },
      context,
    );
    await shutdownTriggered.promise;
    return { result, calls };
  };

  return {
    immediate: await capture("immediate"),
    drain: await capture("drain"),
    cancel: await capture("cancel"),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
