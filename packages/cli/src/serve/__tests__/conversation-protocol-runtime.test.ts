import type {
  ConversationStatusNotice,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  ConfirmationBroker,
  userMessageFromTurnInput,
  type AgentYield,
  type Message,
  type PermissionRule,
  type RunResult,
} from "@zhixing/core";
import { StreamDigestChain } from "@zhixing/core/protocol";
import {
  ConversationManager,
  ConversationRunJournal,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import { InProcessAssignmentSubmission } from "@zhixing/executor";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  setupAuthorityRuntime as setupAuthorityRuntimeProduction,
  type SetupAuthorityRuntimeOptions,
} from "../../setup-delivery.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const TEST_RUNTIME_AUTHORITY_FACTS = {
  executionPermissionRules: () => [],
  securitySnapshot: () => ({
    contextId: { kind: "main" as const },
    workspacePath: null,
    permissionRules: [],
    builtinRules: [],
    rateLimits: [],
    confirmations: [],
  }),
  executionProfile: () => ({
    tools: [],
    mcpServers: [],
    providerIds: [],
  }),
} satisfies Pick<
  SessionRuntime,
  "executionPermissionRules" | "securitySnapshot" | "executionProfile"
>;

function setupAuthorityRuntime(
  options: Omit<SetupAuthorityRuntimeOptions, "executorReadiness"> & {
    readonly executorReadiness?: SetupAuthorityRuntimeOptions["executorReadiness"];
  },
) {
  return setupAuthorityRuntimeProduction({
    ...options,
    executorReadiness: options.executorReadiness ?? TEST_EXECUTOR_READINESS,
  });
}

function expectSettled(
  result: Awaited<ReturnType<typeof projectSessionTurn>>,
): asserts result is Extract<typeof result, { kind: "settled" }> {
  if (result.kind === "error") throw result.error;
  expect(result.kind).toBe("settled");
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(secretKey(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(secretKey(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(secretKey(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

async function seedPendingConversation(label: string) {
  const home = await createTempDir(`conversation-protocol-${label}`);
  const secretStore = new MemorySecretStore();
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
  const runtime: SessionRuntime = {
    ...TEST_RUNTIME_AUTHORITY_FACTS,
    sessionId: `seed-${label}`,
    async *run(): AsyncGenerator<AgentYield, RunResult> {
      throw new Error("seeded input must not execute before restart");
    },
    abort: () => false,
    async dispose() {},
  };
  let manager!: ConversationManager;
  const protocol = new ConversationProtocolRuntime({
    authority,
    manager: () => manager,
    interactions: new DurableConversationInteractionObserver(),
  });
  manager = new ConversationManager(
    { create: vi.fn(async () => runtime) },
    undefined,
    { durableTurnExecutor: protocol },
  );
  const conversationId = `conversation-${label}`;
  await manager.getOrCreate(conversationId);
  const admission = await protocol.admit({
    conversationId,
    input: `pending ${label}`,
    invocation: { kind: "agent", source: "interactive" },
    options: {
      source: "interactive",
      turnContext: { turnId: `rpc:${label}` },
    },
    surfacePrincipal: "rpc:owner",
  });
  return { home, secretStore, conversationId, runId: admission.runId };
}

describe("ConversationProtocolRuntime", () => {
  it("binds exact runtime facts and rejects readiness drift before received", async () => {
    const home = await createTempDir("conversation-protocol-runtime-binding");
    const secretStore = new MemorySecretStore();
    let readiness = {
      ...TEST_EXECUTOR_READINESS,
      tools: ["bash"],
      mcpServers: ["server-a"],
    };
    const readinessReads: string[][] = [];
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: () => {
        readinessReads.push([...readiness.tools]);
        return readiness;
      },
    });
    const rule: PermissionRule = {
      id: "rule-runtime-binding",
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "global",
      createdAt: 1,
      lastMatchedAt: 2,
      matchCount: 3,
    };
    const runtime: SessionRuntime = {
      sessionId: "runtime-binding",
      executionPermissionRules: () => [rule],
      securitySnapshot: () => ({
        contextId: { kind: "main" },
        workspacePath: null,
        permissionRules: [],
        builtinRules: [],
        rateLimits: [],
        confirmations: [],
      }),
      executionProfile: () => ({
        tools: ["bash"],
        mcpServers: ["server-a"],
        providerIds: [],
      }),
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("runtime must not start after readiness drift");
      },
      abort: () => false,
      async dispose() {},
    };
    const prepare = authority.prepareConversationAssignment;
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    const validateBinding = authority.validateConversationRuntimeBinding;
    const bindingResults: Array<ReturnType<typeof validateBinding>> = [];
    const validateBindingSpy = vi
      .spyOn(authority, "validateConversationRuntimeBinding")
      .mockImplementation((input) => {
        const result = validateBinding(input);
        bindingResults.push(result);
        return result;
      });
    const prepareSpy = vi
      .spyOn(authority, "prepareConversationAssignment")
      .mockImplementation(async (input) => {
        prepared = await prepare(input);
        readiness = { ...readiness, tools: [] };
        return prepared;
      });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    const managed = await manager.getOrCreate("conversation-runtime-binding");
    const execution = protocol.run({
      conversationId: managed.conversationId,
      input: "check binding",
      messages: [userMessageFromTurnInput("check binding")],
      baseRevision: managed.turnCount,
      runtime,
      invocation: { kind: "agent", source: "interactive" },
      options: {
        source: "interactive",
        turnContext: { turnId: "rpc:runtime-binding" },
      },
    });
    try {
      await expect(execution.next()).rejects.toThrow(
        "Local executor rejected a freshly issued assignment",
      );
      expect(validateBindingSpy).toHaveBeenCalledOnce();
      expect(readinessReads).toEqual([["bash"], []]);
      expect(bindingResults).toMatchObject([
        { code: "capability-gap", retryable: true },
      ]);
      expect(prepared?.policy.manifestCapabilities).toMatchObject({
        tools: ["bash"],
        mcpServers: ["server-a"],
      });
      expect(prepared?.policy.permissionSnapshot.rules).toEqual([
        {
          id: rule.id,
          pattern: rule.pattern,
          decision: rule.decision,
          scope: rule.scope,
          createdAt: rule.createdAt,
        },
      ]);
      const entries = (await authority.authorityLog.readAll()).flatMap(
        (commit) => commit.entries,
      );
      expect(entries.map((entry) => (entry.body as { t?: string }).t)).toContain(
        "assigned",
      );
      const assignmentEntries = await Promise.all(
        entries
          .filter((entry) => entry.stream.startsWith("assignment:"))
          .map(async (entry) => {
            const body = entry.body as {
              readonly recordSeq?: number;
              readonly body?: { readonly t?: string };
              readonly ref?: Parameters<typeof authority.artifacts.get>[0];
            };
            if (body.ref === undefined) return body;
            return JSON.parse(
              Buffer.from(await authority.artifacts.get(body.ref)).toString("utf8"),
            ) as {
              readonly recordSeq: number;
              readonly body: { readonly t?: string };
            };
          }),
      );
      expect(assignmentEntries.map((entry) => entry.body?.t)).toEqual([
        "control-lease-renewed",
        "dispatch-rejected",
      ]);
    } finally {
      validateBindingSpy.mockRestore();
      prepareSpy.mockRestore();
    }
  }, 30_000);

  it("commits one durable channel turn, mirrors confirmation, and replays the same ingress without execution", async () => {
    const confirmationTtlMs = 300_000;
    const home = await createTempDir("conversation-protocol");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const interactions = new DurableConversationInteractionObserver();
    const broker = new ConfirmationBroker({ lifecycleObserver: interactions });
    broker.onRequest((request) => {
      queueMicrotask(() => broker.resolve(request.id, { kind: "allow-once" }));
    });
    let executions = 0;
    let interactionCreatedAt = 0;
    const interactionBody = {
      kind: "bash" as const,
      command: "x".repeat(9_000),
      commandPreview: "x".repeat(9_000),
    };
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-1",
      confirmationBroker: broker,
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const now = Date.now();
        interactionCreatedAt = now;
        await broker.requestConfirmation({
          id: `confirmation-${executions}`,
          tool: "bash",
          toolInput: { command: "pwd" },
          workingDirectory: home,
           display: {
             title: "Bash",
             body: interactionBody,
            cwd: home,
          },
          options: [{ kind: "allow-once", label: "Allow" }],
          sessionType: "interactive",
          contextId: { kind: "main" },
          createdAt: now,
          expiresAt: now + confirmationTtlMs,
        });
        yield { type: "text_delta", text: "done" };
        const user = messages.at(-1)!;
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 3, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [user, assistant],
            usage: { inputTokens: 3, outputTokens: 1 },
            source: "channel",
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    const finals: unknown[] = [];
    let finalAttempts = 0;
    const statuses: unknown[] = [];
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions,
      onFinal: (frame) => {
        finalAttempts += 1;
        if (finalAttempts === 1) throw new Error("observer temporarily unavailable");
        finals.push(frame);
      },
      onStatus: (notice) => {
        statuses.push(notice);
      },
    });
    const drainDelivery = vi.fn(async () => {});
    protocol.bindDeliveryDrain(drainDelivery);
    manager = new ConversationManager(factory, undefined, {
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_conversationId, record) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
      durableTurnExecutor: protocol,
    });
    const managed = await manager.getOrCreate("conversation-1");
    const runOptions = {
      source: "channel" as const,
      turnContext: {
        turnId: "channel:test:message-1",
        emissionTarget: { channelId: "test", to: "user-1" },
        turnOrigin: {
          channel: "test",
          target: { channelId: "test", to: "user-1" },
          triggeredBy: "user-1",
        },
      },
    };

    const first = await projectSessionTurn({
      manager,
      managed,
      text: "hello",
      turnId: "channel:test:message-1",
      runOptions,
      notify: () => {},
    });
    expectSettled(first);
    expect(executions).toBe(1);
    expect(managed.turnCount).toBe(1);
    expect(finalAttempts).toBe(1);
    expect(finals).toHaveLength(0);
    await protocol.recover();
    expect(finalAttempts).toBe(2);
    expect(finals).toHaveLength(1);
    expect(statuses.length).toBeGreaterThan(0);
    expect(drainDelivery).toHaveBeenCalledOnce();

    const records = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as {
        t?: string;
        assignmentId?: string;
        bundle?: { ref: { digest: string; bytes: number } };
      });
    expect(records.some((record) => record.t === "interaction-mirror")).toBe(true);
    expect(records.some((record) => record.t === "committed")).toBe(true);
    expect(records.some((record) => record.t === "enqueued")).toBe(true);
    const assignmentId = records.find((record) => record.t === "assigned")
      ?.assignmentId;
    const bundleRef = records.find((record) => record.t === "committed")?.bundle?.ref;
    if (!assignmentId || !bundleRef) throw new Error("committed bundle identity is missing");
    const bundle = JSON.parse(
      Buffer.from(await authority.artifacts.get(bundleRef)).toString("utf8"),
    ) as { streamFinal: { finalSeq: number; streamDigest: string } };
    const durableInteraction = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as {
        body?: { t?: string; display?: { ref?: { digest: string; bytes: number } } };
      })
      .find((entry) => entry.body?.t === "interaction-requested")?.body;
    expect(durableInteraction?.display).toMatchObject({
      ref: { digest: expect.stringMatching(/^sha256:/u), bytes: expect.any(Number) },
    });
    const expectedStream = new StreamDigestChain(assignmentId);
    const streamMeta = { turnOrigin: runOptions.turnContext.turnOrigin };
    expectedStream.append({
      kind: "interaction",
      event: {
        t: "requested",
        requestId: "confirmation-1",
        toolName: "bash",
        display: durableInteraction?.display as {
          ref: { digest: `sha256:${string}`; bytes: number };
        },
        issuedAt: new Date(interactionCreatedAt).toISOString(),
        ttlMs: confirmationTtlMs,
        expiresAt: new Date(interactionCreatedAt + confirmationTtlMs).toISOString(),
      },
    }, streamMeta);
    expectedStream.append({
      kind: "interaction",
      event: {
        t: "finished",
        requestId: "confirmation-1",
        outcome: "allowed",
      },
    }, streamMeta);
    expectedStream.append(
      { kind: "agent-yield", yield: { type: "text_delta", text: "done" } },
      streamMeta,
    );
    expect(bundle.streamFinal).toEqual(expectedStream.final());

    const replay = await projectSessionTurn({
      manager,
      managed,
      text: "hello",
      turnId: "channel:test:message-1",
      runOptions,
      notify: () => {},
    });
    expectSettled(replay);
    expect(executions).toBe(1);
    expect(managed.turnCount).toBe(1);
    expect(finals).toHaveLength(1);

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const restartedInteractions = new DurableConversationInteractionObserver();
    let restartedManager!: ConversationManager;
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: restartedInteractions,
    });
    restartedManager = new ConversationManager(factory, undefined, {
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_conversationId, record) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
      durableTurnExecutor: restartedProtocol,
    });
    await restartedProtocol.recover();
    const restartedManaged = await restartedManager.getOrCreate("conversation-1");
    const restartedReplay = await projectSessionTurn({
      manager: restartedManager,
      managed: restartedManaged,
      text: "hello",
      turnId: "channel:test:message-1",
      runOptions,
      notify: () => {},
    });
    expectSettled(restartedReplay);
    expect(executions).toBe(1);
  }, 90_000);

  it("applies one interaction backlog across parent and child brokers", async () => {
    const home = await createTempDir("conversation-protocol-shared-backpressure");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const interactions = new DurableConversationInteractionObserver();
    const brokers = Array.from(
      { length: 3 },
      (_, index) => new ConfirmationBroker({
        id: index === 0 ? "parent" : `child-${index}`,
        ...(index === 0 ? {} : { parentBrokerId: "parent" }),
        lifecycleObserver: interactions,
      }),
    );
    const parent = brokers[0]!;
    const shown = new Set<string>();
    for (const broker of brokers) {
      broker.onRequest((request) => shown.add(request.id));
    }
    let decisions: Awaited<ReturnType<ConfirmationBroker["requestConfirmation"]>>[] = [];
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-shared-backpressure",
      confirmationBroker: parent,
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        const now = Date.now();
        const requests = brokers.map((broker, index) => {
          return broker.requestConfirmation({
            id: `shared-${index}`,
            tool: "write",
            toolInput: { path: `file-${index}` },
            workingDirectory: home,
            display: {
              title: "Write",
              body: { kind: "generic", summary: `file-${index}` },
              cwd: home,
            },
            options: [{ kind: "allow-once", label: "Allow" }],
            sessionType: "interactive",
            contextId: { kind: "main" },
            createdAt: now,
            expiresAt: now + 300_000,
          });
        });
        await vi.waitFor(() => {
          expect(
            brokers.reduce((total, broker) => total + broker.listPending().length, 0),
          ).toBe(2);
        }, { timeout: 15_000 });
        await vi.waitFor(() => {
          expect(
            brokers.some((broker) =>
              broker.snapshot().resolvedRecently.some(
                (entry) => entry.decision.kind === "cancelled",
              ),
            ),
          ).toBe(true);
        }, { timeout: 15_000 });
        for (const broker of brokers) {
          for (const pending of broker.listPending()) {
            await broker.resolveDurably(pending.request.id, { kind: "allow-once" });
          }
        }
        decisions = await Promise.all(requests);
        const user = messages.at(-1)!;
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [user, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions,
      maxPendingInteractions: 2,
    });
    manager = new ConversationManager(factory, undefined, {
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_conversationId, record) => ({
        runIndex: record.runIndex,
        shardId: "durable",
        appended: true,
      }),
      durableTurnExecutor: protocol,
    });
    const managed = await manager.getOrCreate("conversation-shared-backpressure");

    const result = await projectSessionTurn({
      manager,
      managed,
      text: "exercise shared interaction budget",
      turnId: "shared-backpressure-turn",
      runOptions: { source: "interactive" },
      notify: () => {},
    });
    expectSettled(result);

    await vi.waitFor(() => expect(decisions).toHaveLength(3), { timeout: 120_000 });
    expect(
      decisions.reduce<Record<string, number>>((counts, decision) => {
        counts[decision.kind] = (counts[decision.kind] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ "allow-once": 2, cancelled: 1 });
    const rejectedId = `shared-${decisions.findIndex((decision) => decision.kind === "cancelled")}`;
    expect(shown.has(rejectedId)).toBe(false);
  }, 180_000);

  it("retains an admitted execution claim when durable cancellation fails", async () => {
    const home = await createTempDir("conversation-protocol-cancel-claim");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      interactions: new DurableConversationInteractionObserver(),
    });
    const input = {
      conversationId: "conversation-cancel-claim",
      input: "hold claim",
      invocation: { kind: "agent", source: "interactive" } as const,
      options: {
        turnContext: { turnId: "rpc:cancel-claim" },
        source: "interactive" as const,
      },
      surfacePrincipal: "rpc:owner",
    };
    const admitted = await protocol.admit(input);
    expect(admitted.shouldSchedule).toBe(true);

    const failure = vi
      .spyOn(ConversationRunJournal.prototype, "cancelRun")
      .mockRejectedValueOnce(new Error("authority unavailable"))
      .mockRejectedValueOnce(new Error("authority still unavailable"));
    await expect(
      protocol.cancelAdmitted(input.conversationId, admitted.runId),
    ).rejects.toThrow(
      "Conversation scheduler cancellation could not determine its durable disposition",
    );
    expect(failure).toHaveBeenCalledTimes(2);
    failure.mockRestore();

    await expect(protocol.admit(input)).resolves.toEqual({
      runId: admitted.runId,
      shouldSchedule: false,
    });
    const originalCancel = ConversationRunJournal.prototype.cancelRun;
    const responseLoss = vi
      .spyOn(ConversationRunJournal.prototype, "cancelRun")
      .mockImplementationOnce(async function (...args) {
        await originalCancel.apply(this, args);
        throw new Error("cancellation response lost after fsync");
      });
    try {
      await expect(
        protocol.cancelAdmitted(input.conversationId, admitted.runId),
      ).resolves.toBeUndefined();
    } finally {
      responseLoss.mockRestore();
    }
  }, 30_000);

  it("moves a locally abandoned assignment to uncertain and schedules an acknowledged retry", async () => {
    const home = await createTempDir("conversation-protocol-started-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    const interactions = new DurableConversationInteractionObserver();
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-started",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        yield { type: "text_delta", text: "in-flight" };
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    const managerOptions = () => ({
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_conversationId: string, record: { runId: string; runIndex: number }) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions,
    });
    manager = new ConversationManager(factory, undefined, {
      ...managerOptions(),
      durableTurnExecutor: protocol,
    });
    const managed = await manager.getOrCreate("conversation-started");
    const generator = protocol.run({
      conversationId: managed.conversationId,
      input: "hello",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      baseRevision: 0,
      runtime,
      invocation: { kind: "agent", source: "interactive" },
      options: {
        turnContext: { turnId: "rpc:started-1" },
        source: "interactive",
      },
    });
    expect((await generator.next()).done).toBe(false);

    const recordsBefore = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string; state?: string });
    const runId = recordsBefore.find((record) => record.t === "admitted")?.runId;
    expect(runId).toBeTruthy();

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedStatuses: ConversationStatusNotice[] = [];
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      onStatus: (notice) => {
        restartedStatuses.push(notice);
      },
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ...managerOptions(),
      durableTurnExecutor: restartedProtocol,
    });
    await restartedProtocol.recover();

    const recordsAfter = (await restartedAuthority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string; state?: string });
    expect(
      recordsAfter.some(
        (record) =>
          record.t === "state" && record.runId === runId && record.state === "uncertain",
      ),
    ).toBe(true);
    const uncertain = restartedStatuses.find(
      (notice) => notice.state === "uncertain" && notice.ref.runId === runId,
    );
    expect(uncertain?.state).toBe("uncertain");
    if (!uncertain || uncertain.state !== "uncertain" || !runId) {
      throw new Error("recovery did not publish the uncertain fact");
    }
    const schedule = vi
      .spyOn(restartedManager, "admitTurn")
      .mockRejectedValueOnce(new Error("scheduler temporarily unavailable"));
    const originalApply = ConversationRunJournal.prototype.applyControl;
    const responseLoss = vi
      .spyOn(ConversationRunJournal.prototype, "applyControl")
      .mockImplementationOnce(async function (...args) {
        await originalApply.apply(this, args);
        throw new Error("resolution response lost after fsync");
      });
    const resolveInput = {
      conversationId: "conversation-started",
      runId,
      requestId: "resolve:conversation-started",
      ownerEpoch: restartedAuthority.anchorEpoch,
      openFactDigest: uncertain.openFactDigest,
      decision: "user-retry-acknowledged",
      principal: {
        surfacePrincipal: "rpc:owner",
        deviceId: restartedAuthority.deviceId,
        connectionId: "connection:desktop",
      },
    } as const;
    let resolved!: Awaited<ReturnType<typeof restartedProtocol.resolveUncertain>>;
    try {
      resolved = await restartedProtocol.resolveUncertain(resolveInput);
    } finally {
      responseLoss.mockRestore();
      schedule.mockRestore();
    }
    expect(resolved.state).toBe("queued");
    await restartedProtocol.recover();
    await expect(
      restartedProtocol.resolveUncertain({
        conversationId: "conversation-started",
        runId,
        requestId: "resolve:conversation-started",
        ownerEpoch: restartedAuthority.anchorEpoch,
        openFactDigest: uncertain.openFactDigest,
        decision: "user-retry-acknowledged",
        principal: {
          surfacePrincipal: "rpc:owner",
          deviceId: restartedAuthority.deviceId,
          connectionId: "connection:desktop-2",
        },
      }),
    ).resolves.toEqual(resolved);
    await vi.waitFor(
      () => {
        expect(
          restartedManager
            .list()
            .find((entry) => entry.conversationId === "conversation-started")?.busy,
        ).toBe(false);
      },
      { timeout: 10_000 },
    );
    const retriedRecords = (await restartedAuthority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string });
    expect(
      retriedRecords.some(
        (record) => record.t === "committed" && record.runId === runId,
      ),
    ).toBe(true);
    expect(executions).toBe(2);
  }, 90_000);

  it("admits queued cancellation through the durable control plane and replays it exactly", async () => {
    const home = await createTempDir("conversation-protocol-cancel-control");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-cancel-control",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("cancelled queued input must not execute");
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const recoverAuxiliary = vi.fn(async () => {});
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      recoverAuxiliary,
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await manager.getOrCreate("conversation-cancel");
    const admitted = await protocol.admit({
      conversationId: "conversation-cancel",
      input: "cancel me",
      invocation: { kind: "agent", source: "interactive" },
      options: {
        turnContext: { turnId: "rpc:cancel-before-schedule" },
        source: "interactive",
      },
      surfacePrincipal: "rpc:owner",
    });
    const control = {
      conversationId: "conversation-cancel",
      runId: admitted.runId,
      requestId: "cancel:queued-control",
      principal: {
        surfacePrincipal: "rpc:owner",
        deviceId: authority.deviceId,
        connectionId: "connection:desktop",
      },
    } as const;
    let releaseDelivery!: () => void;
    let deliveryKicked = false;
    const blockedDelivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    protocol.bindDeliveryDrain(() => {
      deliveryKicked = true;
      return blockedDelivery;
    });
    const originalApply = ConversationRunJournal.prototype.applyControl;
    const responseLoss = vi
      .spyOn(ConversationRunJournal.prototype, "applyControl")
      .mockImplementationOnce(async function (...args) {
        await originalApply.apply(this, args);
        throw new Error("authority response lost after fsync");
      });
    try {
      await expect(protocol.cancel(control)).resolves.toMatchObject({
        dispositions: [
          {
            runId: admitted.runId,
            runState: "cancelled",
            source: "interactive",
          },
        ],
      });
    } finally {
      responseLoss.mockRestore();
    }
    expect(deliveryKicked).toBe(true);
    await protocol.recover();
    expect(recoverAuxiliary).toHaveBeenCalledWith("conversation-cancel");
    await expect(
      protocol.cancel({
        ...control,
        principal: { ...control.principal, connectionId: "connection:desktop-2" },
      }),
    ).resolves.toMatchObject({
      dispositions: [{ runId: admitted.runId, runState: "cancelled" }],
    });
    releaseDelivery();
    const states = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string; state?: string })
      .filter(
        (record) =>
          record.t === "state" &&
          record.runId === admitted.runId &&
          record.state === "cancelled",
      );
    expect(states).toHaveLength(1);
    const snapshotRead = vi.spyOn(authority.authorityLog, "readSnapshot");
    const history = await protocol.statusHistory([{
      conversationId: "conversation-cancel",
      runId: admitted.runId,
      afterStatusRevision: 0,
    }]);
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(history.notices.some((notice) => notice.state === "cancelled")).toBe(true);
    expect(history.next).toEqual([]);
  }, 90_000);

  it("freezes batch cancellation on the surface request id and replays the original batch", async () => {
    const home = await createTempDir("conversation-protocol-cancel-batch");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-cancel-batch",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("cancelled queued input must not execute");
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await manager.getOrCreate("conversation-batch");
    const admitted = await protocol.admit({
      conversationId: "conversation-batch",
      input: "cancel us all",
      invocation: { kind: "agent", source: "interactive" },
      options: {
        turnContext: { turnId: "rpc:batch-cancel-target" },
        source: "interactive",
      },
      surfacePrincipal: "rpc:owner",
    });
    protocol.bindDeliveryDrain(async () => {});
    const principal = {
      surfacePrincipal: "rpc:owner",
      deviceId: authority.deviceId,
      connectionId: "connection:desktop",
    };
    const replyTarget = { channelId: "feishu", to: "chat-1" };

    // 首个批量:候选(1 个 queued run)在权威决定内冻结并终态 cancelled
    const first = await protocol.cancel({
      conversationId: "conversation-batch",
      requestId: "cancel:batch-populated",
      principal,
      response: { replyTarget },
    });
    expect(first.dispositions).toMatchObject([
      { runId: admitted.runId, runState: "cancelled", source: "interactive" },
    ]);

    // 渠道重投同一消息:exact replay 返回原批次,不是重新枚举后的空集
    const replay = await protocol.cancel({
      conversationId: "conversation-batch",
      requestId: "cancel:batch-populated",
      principal,
      response: { replyTarget },
    });
    expect(replay.dispositions).toMatchObject([
      { runId: admitted.runId, runState: "cancelled" },
    ]);

    // 新批量命中零候选:同一权威决定产出唯一 control-response 回执 item
    const empty = await protocol.cancel({
      conversationId: "conversation-batch",
      requestId: "cancel:batch-empty",
      principal,
      response: { replyTarget },
    });
    expect(empty.dispositions).toEqual([]);
    const countResponseEnqueues = async () =>
      (await authority.authorityLog.readAll())
        .flatMap((commit) => commit.entries)
        .filter((entry) => {
          const body = entry.body as { t?: string; keyBody?: { kind?: string } };
          return (
            body.t === "enqueued" &&
            body.keyBody?.kind === "conversation-control-response-delivery"
          );
        }).length;
    expect(await countResponseEnqueues()).toBe(1);

    // 空批次重投:原空批次 + 回执 item 零重复
    const emptyReplay = await protocol.cancel({
      conversationId: "conversation-batch",
      requestId: "cancel:batch-empty",
      principal,
      response: { replyTarget },
    });
    expect(emptyReplay.dispositions).toEqual([]);
    expect(await countResponseEnqueues()).toBe(1);
  }, 90_000);

  it("fences and resumes a locally abandoned received assignment with the next attempt", async () => {
    const home = await createTempDir("conversation-protocol-received-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-received",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    const callbacks = () => ({
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_conversationId: string, record: { runId: string; runIndex: number }) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    const managed = await manager.getOrCreate("conversation-received");
    const crash = vi
      .spyOn(InProcessAssignmentSubmission.prototype, "startAndReport")
      .mockRejectedValueOnce(new Error("simulated process loss after received"));
    const failed = await projectSessionTurn({
      manager,
      managed,
      text: "recover me",
      turnId: "rpc:received-1",
      runOptions: {
        turnContext: { turnId: "rpc:received-1" },
        source: "interactive",
      },
      notify: () => {},
    });
    crash.mockRestore();
    expect(failed.kind).toBe("error");
    expect(executions).toBe(0);

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: restartedProtocol,
    });
    const snapshotRead = vi.spyOn(restartedAuthority.authorityLog, "readSnapshot");
    const fullRead = vi.spyOn(restartedAuthority.authorityLog, "readAll");
    await restartedProtocol.recover();
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(fullRead).not.toHaveBeenCalled();

    await vi.waitFor(async () => {
      expect(executions).toBe(1);
      expect(
        (await restartedAuthority.authorityLog.readAll())
          .flatMap((commit) => commit.entries)
          .some((entry) => (entry.body as { t?: string }).t === "committed"),
      ).toBe(true);
      expect(
        restartedManager.list().find(
          (entry) => entry.conversationId === "conversation-received",
        )?.busy,
      ).toBe(false);
    }, { timeout: 10_000 });
    const assigned = (await restartedAuthority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as {
        t?: string;
        reservation?: { attempt?: number };
      })
      .filter((record) => record.t === "assigned");
    expect(assigned.map((record) => record.reservation?.attempt)).toEqual([1, 2]);
    expect(
      (await restartedAuthority.authorityLog.readAll())
        .flatMap((commit) => commit.entries)
        .some((entry) => (entry.body as { t?: string }).t === "committed"),
    ).toBe(true);
  }, 90_000);

  it("recovers an input durably admitted before the in-memory scheduler executes it", async () => {
    const home = await createTempDir("conversation-protocol-admission-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let executions = 0;
    let recoveredOptions: Parameters<SessionRuntime["run"]>[1];
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-admission-recovery",
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        recoveredOptions = options;
        await options?.authorizeToolExecution?.({
          toolName: "read",
          toolInput: { path: "README.md" },
        });
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    const callbacks = () => ({
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (
        _conversationId: string,
        record: { runId: string; runIndex: number },
      ) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    const managed = await manager.getOrCreate("conversation-admitted");
    const admitted = await protocol.admit({
      conversationId: "conversation-admitted",
      input: "survive restart",
      invocation: {
        kind: "agent",
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
      },
      options: {
        turnContext: {
          turnId: "rpc:admitted-before-schedule",
          turnOrigin: { channel: "rpc", triggeredBy: "connection-1" },
        },
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
      },
      surfacePrincipal: "rpc:owner",
    });
    expect(admitted.shouldSchedule).toBe(true);
    expect(executions).toBe(0);
    await expect(
      protocol.findRunByIngress(
        "conversation-admitted",
        "rpc:admitted-before-schedule",
        "advancement",
      ),
    ).resolves.toEqual({ runId: admitted.runId, state: "queued" });
    await expect(
      protocol.findRunByIngress(
        "conversation-admitted",
        "rpc:admitted-before-schedule",
        "interactive",
      ),
    ).resolves.toBeUndefined();
    const duplicate = await protocol.admit({
      conversationId: "conversation-admitted",
      input: "survive restart",
      invocation: {
        kind: "agent",
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
      },
      options: {
        turnContext: {
          turnId: "rpc:admitted-before-schedule",
          turnOrigin: { channel: "rpc", triggeredBy: "connection-2" },
        },
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
      },
      surfacePrincipal: "rpc:owner",
    });
    expect(duplicate).toEqual({ runId: admitted.runId, shouldSchedule: false });
    await expect(
      protocol.admit({
        conversationId: "conversation-admitted",
        input: "survive restart",
        invocation: {
          kind: "agent",
          source: "advancement",
          advancement: {
            sessionId: "advancement-session-1",
            proxyMessageId: "proxy-message-1",
          },
        },
        options: {
          turnContext: {
            turnId: "rpc:admitted-before-schedule",
            turnOrigin: { channel: "rpc", triggeredBy: "connection-3" },
          },
          source: "advancement",
          advancement: {
            sessionId: "advancement-session-1",
            proxyMessageId: "proxy-message-1",
          },
        },
        surfacePrincipal: "rpc:owner",
      }),
    ).resolves.toEqual({ runId: admitted.runId, shouldSchedule: false });

    const mismatchedExecution = protocol.run({
      conversationId: "conversation-admitted",
      input: "different input",
      messages: [
        ...managed.window.getMessages(),
        userMessageFromTurnInput("different input"),
      ],
      baseRevision: managed.turnCount,
      runtime,
      invocation: {
        kind: "agent",
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
      },
      options: {
        turnContext: { turnId: "rpc:admitted-before-schedule" },
        source: "advancement",
        advancement: {
          sessionId: "advancement-session-1",
          proxyMessageId: "proxy-message-1",
        },
        surfacePrincipal: "rpc:owner",
      },
    });
    await expect(mismatchedExecution.next()).rejects.toThrow(
      "Prepared conversation admission does not bind this invocation",
    );

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: restartedProtocol,
    });
    await restartedProtocol.recoverReadinessProjections();
    expect(executions).toBe(0);
    expect(restartedManager.pendingCount("conversation-admitted")).toBe(0);
    await restartedProtocol.recover();

    await vi.waitFor(() => {
      expect(executions).toBe(1);
      expect(recoveredOptions?.authorizeToolExecution).toBeTypeOf("function");
      expect(committed.has(admitted.runId)).toBe(true);
      expect(
        restartedManager.list().find(
          (entry) => entry.conversationId === "conversation-admitted",
        )?.busy,
      ).toBe(false);
    }, { timeout: 10_000 });
    expect(recoveredOptions).toMatchObject({
      source: "advancement",
      advancement: {
        sessionId: "advancement-session-1",
        proxyMessageId: "proxy-message-1",
      },
    });
  }, 90_000);

  it("recovers the stable admission result when the first authority response is lost", async () => {
    const home = await createTempDir("conversation-protocol-admission-response-loss");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const originalApply = ConversationRunJournal.prototype.applyInputControl;
    const apply = vi
      .spyOn(ConversationRunJournal.prototype, "applyInputControl")
      .mockImplementationOnce(async function (...args) {
        await originalApply.apply(this, args);
        throw new Error("authority response lost after fsync");
      });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    try {
      const admission = await protocol.admit({
        conversationId: "conversation-admission-response-loss",
        input: "recover the response",
        invocation: { kind: "agent", source: "interactive" },
        options: {
          source: "interactive",
          turnContext: { turnId: "rpc:admission-response-loss" },
        },
        surfacePrincipal: "rpc:owner",
      });
      expect(admission.shouldSchedule).toBe(true);
      expect(admission.runId).toMatch(/^run:/u);
      const admitted = (await authority.authorityLog.readAll())
        .flatMap((commit) => commit.entries)
        .map((entry) => entry.body as { t?: string; runId?: string })
        .filter((record) => record.t === "admitted");
      expect(admitted).toEqual([
        expect.objectContaining({ runId: admission.runId }),
      ]);
    } finally {
      apply.mockRestore();
    }
  }, 90_000);

  it("recovers a queued perspective with its durable question and execution kind", async () => {
    const home = await createTempDir("conversation-protocol-perspective-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let directExecutions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-perspective-recovery",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        directExecutions += 1;
        throw new Error("Perspective recovery must not execute the ordinary runtime");
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    const callbacks = () => ({
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (
        _conversationId: string,
        record: { runId: string; runIndex: number },
      ) => {
        const existing = committed.get(record.runId);
        if (existing) return { ...existing, appended: false };
        const accepted = { runIndex: record.runIndex, shardId: "durable" };
        committed.set(record.runId, accepted);
        return { ...accepted, appended: true };
      },
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    await manager.getOrCreate("conversation-perspective");
    const admitted = await protocol.admit({
      conversationId: "conversation-perspective",
      input: "compare the options",
      invocation: {
        kind: "perspectives",
        source: "channel",
        question: "Which option best preserves user intent?",
      },
      options: {
        source: "channel",
        turnContext: { turnId: "rpc:perspective-before-schedule" },
      },
      surfacePrincipal: "rpc:owner",
    });

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const recovered: Array<{
      question: string;
      source: string;
      turnId: string;
    }> = [];
    let restartedManager!: ConversationManager;
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      executeRecoveredPerspective: async (input) => {
        recovered.push({
          question: input.question,
          source: input.source,
          turnId: input.turnContext.turnId,
        });
        const user = userMessageFromTurnInput(input.originalInput);
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "perspective result" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 2, outputTokens: 2 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [user, assistant],
            usage: { inputTokens: 2, outputTokens: 2 },
            source: input.source,
            perspectives: {
              definitionId: "perspectives-deliberation-v1",
              perspectiveCount: 3,
            },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: restartedProtocol,
    });
    await restartedProtocol.recover();

    await vi.waitFor(() => {
      expect(recovered).toEqual([
        {
          question: "Which option best preserves user intent?",
          source: "channel",
          turnId: "rpc:perspective-before-schedule",
        },
      ]);
      expect(committed.has(admitted.runId)).toBe(true);
      expect(
        restartedManager.list().find(
          (entry) => entry.conversationId === "conversation-perspective",
        )?.busy,
      ).toBe(false);
    }, { timeout: 10_000 });
    expect(directExecutions).toBe(0);
  }, 90_000);

  it("awaits durable cancellation before removing a recovered queued task", async () => {
    const seeded = await seedPendingConversation("recovered-cancel");
    const authority = await setupAuthorityRuntime({
      zhixingHome: seeded.home,
      secretStore: seeded.secretStore,
    });
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "recovered-cancel-runtime",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        throw new Error("cancelled recovered task must not execute");
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await manager.getOrCreate(seeded.conversationId);
    manager.setBusy(seeded.conversationId, true, "interactive");
    await protocol.recoverReadinessProjections();
    await protocol.recover();
    expect(manager.pendingCount(seeded.conversationId)).toBe(1);

    const originalCancel = protocol.cancelAdmitted.bind(protocol);
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(protocol, "cancelAdmitted").mockImplementation(async (...args) => {
      entered();
      await cancellationGate;
      await originalCancel(...args);
    });

    const cancelling = manager.cancelPendingBySource(
      seeded.conversationId,
      "interactive",
    );
    await enteredGate;
    expect(manager.pendingCount(seeded.conversationId)).toBe(0);
    release();
    await expect(cancelling).resolves.toBe(1);
    expect(manager.pendingCount(seeded.conversationId)).toBe(0);
    expect(executions).toBe(0);
    const cancelled = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string; state?: string })
      .filter(
        (record) =>
          record.t === "state" &&
          record.runId === seeded.runId &&
          record.state === "cancelled",
      );
    expect(cancelled).toHaveLength(1);
    manager.setBusy(seeded.conversationId, false);
  }, 90_000);

  it("waits for the active recovery pass and never schedules another pass after stop", async () => {
    const home = await createTempDir("conversation-protocol-stop-recovery");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => {
        throw new Error("runtime must not be created");
      }) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recover = vi.spyOn(protocol, "recover").mockImplementation(async () => {
      entered();
      await recoveryGate;
      return 0;
    });

    protocol.startRecoveryLoop(1);
    await enteredGate;
    let stopped = false;
    const stopping = protocol.stopRecoveryLoop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recover).toHaveBeenCalledOnce();
  });

  it("retains a newer recovery generation created during an active pass", async () => {
    const seeded = await seedPendingConversation("recovery-generation");
    const authority = await setupAuthorityRuntime({
      zhixingHome: seeded.home,
      secretStore: seeded.secretStore,
    });
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "recovery-generation-runtime",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("cancelled input must not execute");
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    let calls = 0;
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = vi
      .spyOn(ConversationRunJournal.prototype, "resumePendingPublishing")
      .mockImplementation(async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await recoveryGate;
        }
        return 0;
      });
    try {
      const firstPass = protocol.recover();
      await enteredGate;
      await protocol.cancel({
        conversationId: seeded.conversationId,
        runId: seeded.runId,
        requestId: "cancel:during-recovery",
        principal: {
          surfacePrincipal: "rpc:owner",
          deviceId: authority.deviceId,
          connectionId: "connection:recovery-generation",
        },
      });
      release();
      await firstPass;
      await protocol.recover();
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      publish.mockRestore();
    }
  }, 90_000);

  it("keeps lifecycle projection claimed until one idempotent consumer acknowledges it", async () => {
    const home = await createTempDir("conversation-protocol-lifecycle-handoff");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    let manager!: ConversationManager;
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const projectLifecycle = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        entered();
        await projectionGate;
      }
      if (attempts === 1) {
        throw new Error("legacy lifecycle projection unavailable");
      }
    });
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle,
    });
    manager = new ConversationManager(
      {
        create: vi.fn(async () => {
          throw new Error("lifecycle projection must not create a runtime");
        }),
      },
      undefined,
      { durableTurnExecutor: protocol },
    );
    const principal = protocol.controlPrincipal({
      surfacePrincipal: "rpc:owner",
      connectionId: "connection:lifecycle",
    });
    const originalApply = ConversationRunJournal.prototype.applyControl;
    const responseLoss = vi
      .spyOn(ConversationRunJournal.prototype, "applyControl")
      .mockImplementationOnce(async function (...args) {
        await originalApply.apply(this, args);
        throw new Error("lifecycle response lost after fsync");
      });
    let write!: Awaited<ReturnType<typeof protocol.writeSession>>;
    try {
      write = await protocol.writeSession({
        conversationId: "conversation-lifecycle",
        requestId: "lifecycle:clear:1",
        mutation: { kind: "window-op", op: "clear" },
        principal,
        conversationExists: async () => true,
      });
    } finally {
      responseLoss.mockRestore();
    }
    expect(write).toEqual({ status: "accepted", domainRevision: 1 });
    if (write.status !== "accepted") throw new Error("lifecycle write was rejected");
    const projection = {
      conversationId: "conversation-lifecycle",
      requestId: "lifecycle:clear:1",
      mutation: "clear" as const,
      domainRevision: write.domainRevision,
    };

    const first = protocol.projectSession(projection);
    const replay = protocol.projectSession(projection);
    await enteredGate;
    expect(projectLifecycle).toHaveBeenCalledOnce();
    protocol.releaseConversation(projection.conversationId);
    release();
    const failed = await Promise.allSettled([first, replay]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);

    await protocol.recover();
    expect(projectLifecycle).toHaveBeenCalledTimes(2);
    await protocol.projectSession(projection);
    expect(projectLifecycle).toHaveBeenCalledTimes(2);
    const projectionRecords = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { kind?: string; requestId?: string })
      .filter(
        (record) =>
          record.kind === "conversation-lifecycle-projection" &&
          record.requestId === projection.requestId,
      );
    expect(projectionRecords).toHaveLength(1);
    const lifecycleRecords = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; requestId?: string })
      .filter(
        (record) =>
          record.t === "session-lifecycle" &&
          record.requestId === projection.requestId,
      );
    expect(lifecycleRecords).toHaveLength(1);
  }, 90_000);

  it("recovers an unprojected delete before readiness and preserves exact replay", async () => {
    const home = await createTempDir("conversation-protocol-lifecycle-restart");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle: async () => {
        throw new Error("first process must stop before materialization");
      },
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    const principal = protocol.controlPrincipal({
      surfacePrincipal: "rpc:owner",
      connectionId: "connection:lifecycle-restart",
    });
    const write = await protocol.writeSession({
      conversationId: "conversation-delete-restart",
      requestId: "lifecycle:delete:1",
      mutation: { kind: "conversation-delete" },
      principal,
      conversationExists: async () => true,
    });
    expect(write).toEqual({ status: "accepted", domainRevision: 1 });

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const projected = vi.fn(async () => {});
    let restartedManager!: ConversationManager;
    const restartedProtocol = new ConversationProtocolRuntime({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle: projected,
    });
    restartedManager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: restartedProtocol },
    );
    await restartedProtocol.recoverReadinessProjections();
    expect(projected).toHaveBeenCalledWith({
      conversationId: "conversation-delete-restart",
      requestId: "lifecycle:delete:1",
      mutation: "delete",
      domainRevision: 1,
    });
    await expect(
      restartedProtocol.writeSession({
        conversationId: "conversation-delete-restart",
        requestId: "lifecycle:delete:1",
        mutation: { kind: "conversation-delete" },
        principal,
        conversationExists: async () => false,
      }),
    ).resolves.toEqual({ status: "accepted", domainRevision: 1 });
    await expect(
      restartedProtocol.writeSession({
        conversationId: "conversation-delete-restart",
        requestId: "lifecycle:delete:2",
        mutation: { kind: "conversation-delete" },
        principal,
        conversationExists: async () => false,
      }),
    ).resolves.toEqual({ status: "not-found" });
  }, 90_000);

  it("rejects a new lifecycle request for an unknown conversation before authority append", async () => {
    const home = await createTempDir("conversation-protocol-lifecycle-identity");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle: async () => {
        throw new Error("unknown conversation must not be projected");
      },
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    const result = await protocol.writeSession({
      conversationId: "conversation-missing",
      requestId: "lifecycle:missing:1",
      mutation: { kind: "conversation-delete" },
      principal: protocol.controlPrincipal({
        surfacePrincipal: "rpc:owner",
        connectionId: "connection:lifecycle-missing",
      }),
      conversationExists: async () => false,
    });
    expect(result).toEqual({ status: "not-found" });
    const lifecycleRecords = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string })
      .filter((record) => record.t === "session-lifecycle");
    expect(lifecycleRecords).toHaveLength(0);
  }, 90_000);

  it("keeps a committed run final while transcript projection is temporarily unavailable", async () => {
    const home = await createTempDir("conversation-protocol-post-commit-recovery");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const assistant: Message = {
      role: "assistant",
      content: [{ type: "text", text: "committed result" }],
    };
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "post-commit-runtime",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: "2026-07-18T00:00:00.000Z",
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const committed = new Map<string, { runIndex: number; shardId: string }>();
    let projectionAttempts = 0;
    const finals: unknown[] = [];
    let manager!: ConversationManager;
    const protocol = new ConversationProtocolRuntime({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      onFinal: async (frame) => {
        finals.push(frame);
      },
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      {
        loadHistory: async () => undefined,
        initTranscript: async () => {},
        appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
        appendCommittedRun: async (_conversationId, record) => {
          projectionAttempts += 1;
          if (projectionAttempts === 1) {
            throw new Error("transcript store temporarily unavailable");
          }
          const existing = committed.get(record.runId);
          if (existing) return { ...existing, appended: false };
          const accepted = { runIndex: record.runIndex, shardId: "durable" };
          committed.set(record.runId, accepted);
          return { ...accepted, appended: true };
        },
        durableTurnExecutor: protocol,
      },
    );
    const managed = await manager.getOrCreate("conversation-post-commit");
    const result = await projectSessionTurn({
      manager,
      managed,
      text: "commit despite projection outage",
      turnId: "rpc:post-commit",
      runOptions: {
        source: "interactive",
        turnContext: { turnId: "rpc:post-commit" },
      },
      notify: () => {},
    });
    expect(result.kind).toBe("settled");
    const committedRecord = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string })
      .find((record) => record.t === "committed");
    expect(committedRecord?.runId).toBeTruthy();
    expect(committed.has(committedRecord!.runId!)).toBe(false);
    expect(finals).toHaveLength(0);

    await protocol.recover();
    expect(committed.has(committedRecord!.runId!)).toBe(true);
    expect(finals).toHaveLength(1);
  }, 90_000);
});

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
