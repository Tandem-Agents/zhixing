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
import { assertGolden, createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationHub, ConversationManager } from "@zhixing/owner-kernel";
import { createServerContext } from "../context.js";
import { buildBuiltinRegistry } from "../rpc/methods/index.js";
import { buildServerShutdownMethod } from "../rpc/methods/server.js";
import {
  createConfirmationBridge,
  createRunEventForwarder,
  projectSessionTurn,
} from "@zhixing/rpc";
import { toJsonRpcError, type HandlerContext } from "../rpc/handlers.js";
import type { RuntimeFactory, SessionRuntime } from "@zhixing/owner-kernel";
import { DEFAULT_SERVER_CONFIG } from "../types.js";

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
  });

  it("exposes immutable registry metadata without handler references", () => {
    const registry = buildBuiltinRegistry();
    const descriptor = registry.list().find((entry) => entry.name === "health")!;

    expect(descriptor).toEqual({ name: "health", requiresAuth: false });
    expect(descriptor).not.toHaveProperty("handler");
    expect(Object.isFrozen(descriptor)).toBe(true);
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
