import type {
  ConversationStatusNotice,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  ConfirmationBroker,
  localConversationId,
  userMessageFromTurnInput,
  type AgentYield,
  type Message,
  type PermissionRule,
  type RunResult,
} from "@zhixing/core";
import {
  createSignedTrustRuleSnapshot,
  StreamDigestChain,
  protocolDigest,
} from "@zhixing/core/protocol";
import {
  ConversationManager,
  ConversationRunJournal,
  createInitialControlEnvelope,
  DurableConversationAdmissionRejectedError,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
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
import { localConversationOwnerRuntime } from "../conversation-owner-runtime.js";

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const TEST_RESOURCE_CANDIDATE_TTL_MS = 60_000;
const TEST_DURABLE_IO_TIMEOUT_MS = 120_000;

const TEST_LOCAL_EXECUTOR = {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
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
    resourceCandidateTtlMs:
      options.resourceCandidateTtlMs ?? TEST_RESOURCE_CANDIDATE_TTL_MS,
  });
}

function createProtocol(
  options: ConstructorParameters<typeof ConversationProtocolRuntime>[0],
): ConversationProtocolRuntime {
  const localExecutor = options.localExecutor ?? {
    ...TEST_LOCAL_EXECUTOR,
    runtimeFactory: {
      create: async (conversationId: string) => {
        const runtime = options.manager().getSession(conversationId)?.runtime;
        if (!runtime) {
          throw new Error(`Missing test conversation runtime: ${conversationId}`);
        }
        return runtime;
      },
    },
  };
  return new ConversationProtocolRuntime({
    ...options,
    localExecutor,
  });
}

async function registerActiveConversation(
  authority: Awaited<ReturnType<typeof setupAuthorityRuntime>>,
  conversationId: string,
  at: string,
  surfacePrincipal = "rpc:owner",
): Promise<void> {
  const source = {
    principal: {
      surfacePrincipal,
      deviceId: authority.deviceId,
      connectionId: `connection:create:${conversationId}`,
    },
  };
  const envelope = createInitialControlEnvelope({
    requestId: `session-create:${conversationId}`,
    source,
    at,
    body: { t: "session-create", requestedName: conversationId },
  });
  await authority.controlAdmission.apply({
    envelope,
    source,
    prepare: () => ({
      result: {
        v: 1,
        status: "ok",
        body: { t: "session-create", conversationId },
      },
      authorityRevision: 1,
    }),
  });
}

async function getOrCreateActiveConversation(
  authority: Awaited<ReturnType<typeof setupAuthorityRuntime>>,
  manager: ConversationManager,
  conversationId: string,
  at = new Date().toISOString(),
) {
  const managed = await manager.getOrCreate(conversationId);
  await registerActiveConversation(
    authority,
    managed.conversationId,
    at,
  );
  return managed;
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
  const protocol = createProtocol({
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
  await getOrCreateActiveConversation(authority, manager, conversationId);
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
  it("runs and recovers a device-local conversation entirely on the executor authority domain", async () => {
    const home = await createTempDir("conversation-protocol-local-owner");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    await authority.installPermissionSnapshot(
      createSignedTrustRuleSnapshot(
        {
          snapshotVersion: 1,
          rules: [],
          generatedAt: new Date().toISOString(),
        },
        authority.signer,
      ),
    );
    const conversationId = localConversationId(
      authority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-local-owner",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "local done" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 2, outputTokens: 2 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 2, outputTokens: 2 },
            source: "interactive",
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
    const protocol = createProtocol({
      owner: localConversationOwnerRuntime(authority),
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      localExecutor: {
        ...TEST_LOCAL_EXECUTOR,
        runtimeFactory: factory,
      },
    });
    manager = new ConversationManager(factory, undefined, {
      ensureConversation: (id) => protocol.ensureSession(id),
      initTranscript: (id) => protocol.ensureSession(id),
      appendRun: async () => {
        throw new Error("local owner must not use legacy transcript persistence");
      },
      appendCommittedRun: async (_id, record) => ({
        runIndex: record.runIndex,
        shardId: "owner-log",
        appended: true,
      }),
      durableTurnExecutor: protocol,
    });
    await protocol.ensureSession(conversationId);
    const managed = await manager.getOrCreate(conversationId);
    const first = await projectSessionTurn({
      manager,
      managed,
      text: "run locally",
      turnId: "local:turn:1",
      runOptions: {
        source: "interactive",
        turnContext: { turnId: "local:turn:1" },
      },
      notify: () => {},
    });
    expectSettled(first);
    expect(executions).toBe(1);

    const executorEntries = (await authority.executorLog.readAll()).flatMap(
      (commit) => commit.entries,
    );
    expect(
      executorEntries.some((entry) => entry.stream === `run:${conversationId}`),
    ).toBe(true);
    expect(
      executorEntries.some((entry) => entry.stream.includes(conversationId)),
    ).toBe(true);
    expect(
      (await authority.authorityLog.readAll())
        .flatMap((commit) => commit.entries)
        .some((entry) => entry.stream.includes(conversationId)),
    ).toBe(false);
    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedProtocol = createProtocol({
      owner: localConversationOwnerRuntime(restartedAuthority),
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      localExecutor: {
        ...TEST_LOCAL_EXECUTOR,
        runtimeFactory: factory,
      },
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ensureConversation: (id) => restartedProtocol.ensureSession(id),
      initTranscript: (id) => restartedProtocol.ensureSession(id),
      appendRun: async () => {
        throw new Error("local owner must not use legacy transcript persistence");
      },
      appendCommittedRun: async (_id, record) => ({
        runIndex: record.runIndex,
        shardId: "owner-log",
        appended: false,
      }),
      durableTurnExecutor: restartedProtocol,
    });
    await restartedProtocol.recover();
    expect(await restartedProtocol.listSessions()).toEqual([conversationId]);
    const meta = await restartedProtocol.sessionState.readSessionMeta(
      conversationId,
      {
        principal: { kind: "host", component: "local-owner-test" },
        requestId: "local-owner-test:meta",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      },
    );
    expect(meta.turnCount).toBe(1);
    expect(executions).toBe(1);

    const ownerContext = (requestId: string) => ({
      principal: { kind: "host" as const, component: "local-owner-test" },
      requestId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await restartedProtocol.sessionState.mutate(
      conversationId,
      {
        kind: "task-list-op",
        op: {
          op: "set",
          state: {
            items: [
              { id: "local-task", content: "finish locally", status: "in_progress" },
            ],
          },
        },
      },
      ownerContext("local-owner-test:task-list"),
    );
    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "session-meta", patch: { name: "Local durable session" } },
      ownerContext("local-owner-test:rename"),
    );
    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "window-op", op: "compact" },
      ownerContext("local-owner-test:compact"),
    );
    expect(
      await restartedProtocol.sessionState.readTaskList(
        conversationId,
        ownerContext("local-owner-test:read-task-list"),
      ),
    ).toEqual({
      items: [
        { id: "local-task", content: "finish locally", status: "in_progress" },
      ],
    });
    const transcript = await restartedProtocol.sessionState.readTranscriptTail(
      conversationId,
      ownerContext("local-owner-test:read-transcript"),
      undefined,
      10,
    );
    expect(transcript.records).toHaveLength(1);
    expect(
      await restartedProtocol.sessionState.readSessionMeta(
        conversationId,
        ownerContext("local-owner-test:read-renamed-meta"),
      ),
    ).toMatchObject({ name: "Local durable session", turnCount: 1 });

    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "window-op", op: "clear" },
      ownerContext("local-owner-test:clear"),
    );
    expect(
      await restartedProtocol.sessionState.readTaskList(
        conversationId,
        ownerContext("local-owner-test:read-cleared-task-list"),
      ),
    ).toEqual({ items: [] });
    expect(
      await restartedProtocol.sessionState.readSessionMeta(
        conversationId,
        ownerContext("local-owner-test:read-cleared-meta"),
      ),
    ).toMatchObject({ turnCount: 0 });
    const deleteConversationId = localConversationId(
      restartedAuthority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
    await restartedProtocol.ensureSession(deleteConversationId);
    await restartedProtocol.sessionState.mutate(
      deleteConversationId,
      { kind: "conversation-delete" },
      ownerContext("local-owner-test:delete"),
    );
    await expect(restartedProtocol.sessionExists(deleteConversationId)).resolves.toBe(false);
    await expect(
      restartedProtocol.sessionState.mutate(
        deleteConversationId,
        { kind: "conversation-delete" },
        ownerContext("local-owner-test:delete"),
      ),
    ).resolves.toEqual({ revision: 1 });
    await expect(
      restartedProtocol.sessionState.mutate(
        deleteConversationId,
        { kind: "session-meta", patch: { name: "must not resurrect" } },
        ownerContext("local-owner-test:after-delete"),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    const missingConversationId = localConversationId(
      restartedAuthority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    );
    await expect(
      restartedProtocol.sessionState.mutate(
        missingConversationId,
        { kind: "window-op", op: "compact" },
        ownerContext("local-owner-test:missing"),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(restartedProtocol.ensureSession("conversation-anchor")).rejects.toThrow(
      "does not belong to this owner domain",
    );
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("establishes the owner session identity before the first input and workscene activity", async () => {
    const home = await createTempDir("conversation-protocol-session-identity");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      interactions: new DurableConversationInteractionObserver(),
    });

    const conversationId = "conversation-first-input";
    await expect(protocol.admit({
      conversationId,
      input: "first input",
      invocation: { kind: "agent", source: "interactive" },
      options: {
        source: "interactive",
        turnContext: { turnId: "rpc:first-input" },
      },
      surfacePrincipal: "rpc:owner",
    })).resolves.toMatchObject({ shouldSchedule: true });

    const worksceneConversation = "ws:scene-first-activity:primary";
    await expect(protocol.touchWorksceneSession({
      conversationId: worksceneConversation,
      sceneId: "scene-first-activity",
      requestId: "workscene-enter:scene-first-activity",
      at: new Date().toISOString(),
    })).resolves.toMatchObject({ revision: 1 });

    const creations = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as {
        t?: string;
        envelope?: { body?: { t?: string; sceneId?: string } };
      })
      .filter((body) =>
        body.t === "received" && body.envelope?.body?.t === "session-create"
      );
    expect(creations.map((body) => body.envelope.body)).toEqual([
      { t: "session-create" },
      { t: "session-create", sceneId: "scene-first-activity" },
    ]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("durably binds first-party environment selection to admission and rejects channel construction", async () => {
    const home = await createTempDir("conversation-protocol-environment-selection");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const conversationId = "conversation-environment-selection";
    let manager!: ConversationManager;
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      {
        create: vi.fn(async () => ({
          ...TEST_RUNTIME_AUTHORITY_FACTS,
          sessionId: conversationId,
          async *run(): AsyncGenerator<AgentYield, RunResult> {
            throw new Error("environment admission must not execute");
          },
          abort: () => false,
          async dispose() {},
        })),
      },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await getOrCreateActiveConversation(authority, manager, conversationId);

    const firstParty = {
      conversationId,
      input: "use selected workspace",
      invocation: { kind: "agent" as const, source: "interactive" as const },
      environment: {
        workspace: { deviceId: authority.deviceId, bindingRef: "workspace-a" },
      },
      options: {
        source: "interactive" as const,
        turnContext: {
          turnId: "rpc:environment-selection",
          turnOrigin: { channel: "rpc", triggeredBy: "connection-1" },
        },
      },
      surfacePrincipal: "rpc:owner",
    };
    const admitted = await protocol.admit(firstParty);

    const replayProtocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    await expect(replayProtocol.admit(firstParty)).resolves.toEqual({
      runId: admitted.runId,
      shouldSchedule: true,
    });
    replayProtocol.deferScheduling(conversationId, admitted.runId);
    const conflictingReplay = replayProtocol.admit({
        ...firstParty,
        environment: {
          workspace: { deviceId: authority.deviceId, bindingRef: "workspace-b" },
        },
      });
    await expect(conflictingReplay).rejects.toBeInstanceOf(
      DurableConversationAdmissionRejectedError,
    );
    await expect(conflictingReplay).rejects.toThrow(/payload|bound|conflict/iu);

    await expect(
      protocol.admit({
        ...firstParty,
        options: {
          source: "channel",
          turnContext: {
            turnId: "feishu:environment-selection",
            turnOrigin: {
              channel: "feishu",
              triggeredBy: "user-a",
              target: { channelId: "feishu", to: "chat-a", threadId: "thread-a" },
            },
          },
        },
      }),
    ).rejects.toThrow("Only first-party");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("requires the matching upload grant before admitting attachments", async () => {
    let now = new Date().toISOString();
    const home = await createTempDir("conversation-protocol-attachments");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      clock: () => now,
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      clock: () => now,
      interactions: new DurableConversationInteractionObserver(),
    });
    const stored = await authority.artifacts.put(
      Buffer.from("surface attachment"),
    );
    const attachment = { ...stored, kind: "file" as const };
    const conversationId = "conversation-attachments";
    const turnId = "rpc:attachment";
    const surfacePrincipal = "rpc:owner";
    const ingress = {
      kind: "first-party" as const,
      surfacePrincipal,
      deviceId: authority.deviceId,
      ingressId: turnId,
      receivedAt: now,
    };
    const requestId = `input:${protocolDigest("ConversationInputIdentity", 1, {
      surfacePrincipal,
      ingressId: turnId,
    })}`;
    const invocation = { kind: "agent" as const, source: "interactive" as const };
    const envelope = createInitialControlEnvelope({
      requestId,
      source: {
        principal: {
          surfacePrincipal,
          deviceId: authority.deviceId,
          connectionId: "connection:local",
        },
        ingress,
      },
      at: now,
      body: {
        t: "input",
        conversationId,
        ingress: { ingressId: turnId, source: "first-party" },
        input: { parts: [{ type: "text", text: "inspect attachment" }] },
        attachments: [attachment],
        invocation,
        ownerEpoch: authority.anchorEpoch,
      },
    });
    const issueRequest = {
      kind: "asset-upload" as const,
      scope: {
        domain: "conversation" as const,
        conversationId,
        ownerEpoch: authority.anchorEpoch,
      },
      surfacePrincipal,
      requestId,
      assets: [stored],
      payloadDigest: envelope.payloadDigest,
    };
    await expect(authority.surfaceAssets.issue(issueRequest)).rejects.toThrow(
      "not owned",
    );
    await registerActiveConversation(authority, conversationId, now);
    await expect(
      authority.surfaceAssets.issue({
        ...issueRequest,
        scope: {
          ...issueRequest.scope,
          ownerEpoch: authority.anchorEpoch + 1,
        },
      }),
    ).rejects.toThrow("not owned");
    await authority.surfaceAssets.issue({
      ...issueRequest,
    });
    const input = {
      conversationId,
      input: "inspect attachment",
      attachments: [attachment],
      invocation,
      options: {
        source: "interactive" as const,
        turnContext: { turnId },
      },
      surfacePrincipal,
    };

    const first = await protocol.admit(input);
    expect(first).toMatchObject({
      shouldSchedule: true,
    });
    await expect(
      authority.surfaceAssets.issue({
        kind: "asset-download",
        scope: {
          domain: "conversation",
          conversationId,
          ownerEpoch: authority.anchorEpoch,
        },
        surfacePrincipal,
        requestId: "request-download-adopted",
        assets: [stored],
      }),
    ).resolves.toMatchObject({ kind: "asset-download" });
    now = new Date(Date.parse(now) + 2 * 60 * 60 * 1_000).toISOString();
    await expect(protocol.admit(input)).resolves.toMatchObject({
      runId: first.runId,
      shouldSchedule: false,
    });
    await expect(
      protocol.admit({
        ...input,
        options: {
          ...input.options,
          turnContext: { turnId: "rpc:attachment-without-grant" },
        },
      }),
    ).rejects.toThrow(/upload grant is unknown/);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("continues a durable receipt after its upload grant expires", async () => {
    let now = new Date().toISOString();
    const home = await createTempDir("conversation-protocol-pending-attachment");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      clock: () => now,
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      clock: () => now,
      interactions: new DurableConversationInteractionObserver(),
    });
    const stored = await authority.artifacts.put(Buffer.from("pending attachment"));
    const attachment = { ...stored, kind: "file" as const };
    const conversationId = "conversation-pending-attachment";
    const turnId = "rpc:pending-attachment";
    const surfacePrincipal = "rpc:owner";
    const ingress = {
      kind: "first-party" as const,
      surfacePrincipal,
      deviceId: authority.deviceId,
      ingressId: turnId,
      receivedAt: now,
    };
    const requestId = `input:${protocolDigest("ConversationInputIdentity", 1, {
      surfacePrincipal,
      ingressId: turnId,
    })}`;
    const invocation = { kind: "agent" as const, source: "interactive" as const };
    const source = {
      principal: {
        surfacePrincipal,
        deviceId: authority.deviceId,
        connectionId: "connection:local",
      },
      ingress,
    };
    const envelope = createInitialControlEnvelope({
      requestId,
      source,
      at: now,
      body: {
        t: "input",
        conversationId,
        ingress: { ingressId: turnId, source: "first-party" },
        input: { parts: [{ type: "text", text: "resume pending attachment" }] },
        attachments: [attachment],
        invocation,
        ownerEpoch: authority.anchorEpoch,
      },
    });
    await registerActiveConversation(authority, conversationId, now);
    await authority.surfaceAssets.issue({
      kind: "asset-upload",
      scope: {
        domain: "conversation",
        conversationId,
        ownerEpoch: authority.anchorEpoch,
      },
      surfacePrincipal,
      requestId,
      assets: [stored],
      payloadDigest: envelope.payloadDigest,
    });
    await authority.authorityLog.append([
      {
        stream: "control",
        body: { t: "received", requestId, envelope, ingress },
      },
    ]);
    const adoption = vi.spyOn(authority.surfaceAssets, "assertUploadAdoption");
    now = new Date(Date.parse(now) + 2 * 60 * 60 * 1_000).toISOString();

    await expect(
      protocol.admit({
        conversationId,
        input: "resume pending attachment",
        attachments: [attachment],
        invocation,
        options: {
          source: "interactive",
          turnContext: { turnId },
        },
        surfacePrincipal,
      }),
    ).resolves.toMatchObject({ shouldSchedule: true });
    expect(adoption).not.toHaveBeenCalled();
    const records = (await authority.authorityLog.readStream("control"))
      .map((entry) => entry.body as { t?: string; requestId?: string })
      .filter((record) => record.requestId === requestId);
    expect(records.map((record) => record.t)).toEqual(["received", "applied"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("recovers expired reservations on both resource-governor halves", async () => {
    const home = await createTempDir("conversation-protocol-resource-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    const anchorRecovery = vi.spyOn(authority.resourceGovernor, "reclaimExpired");
    const executorRecovery = vi.spyOn(
      authority.executorResourceGovernor,
      "reclaimExpired",
    );
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("empty recovery must not load a conversation manager");
      },
      interactions: new DurableConversationInteractionObserver(),
    });

    await protocol.recover();

    expect(anchorRecovery).toHaveBeenCalledOnce();
    expect(executorRecovery).toHaveBeenCalledOnce();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("binds exact runtime facts and rejects readiness drift before received", async () => {
    const home = await createTempDir("conversation-protocol-runtime-binding");
    const secretStore = new MemorySecretStore();
    let readiness = {
      ...TEST_EXECUTOR_READINESS,
      tools: ["memory"],
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
        tools: ["memory"],
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
    const bindingResults: Array<Awaited<ReturnType<typeof validateBinding>>> = [];
    const validateBindingSpy = vi
      .spyOn(authority, "validateConversationRuntimeBinding")
      .mockImplementation(async (input) => {
        const result = await validateBinding(input);
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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-runtime-binding",
    );
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
      expect(readinessReads).toEqual([["memory"], ["memory"], []]);
      expect(bindingResults).toMatchObject([
        { code: "capability-gap", retryable: true },
      ]);
      expect(prepared?.policy.manifestCapabilities).toMatchObject({
        tools: ["memory"],
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
        (await authority.executorLog.readAll())
          .flatMap((commit) => commit.entries)
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("commits one durable channel turn, mirrors confirmation, and replays the same ingress without execution", async () => {
    const confirmationTtlMs = 300_000;
    const home = await createTempDir("conversation-protocol");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const interactions = new DurableConversationInteractionObserver();
    const originalDrain = interactions.drainAssignment.bind(interactions);
    let drainAttempts = 0;
    vi.spyOn(interactions, "drainAssignment").mockImplementation(
      async (binding) => {
        drainAttempts += 1;
        if (drainAttempts === 3) {
          throw new Error("temporary stream projection failure");
        }
        await originalDrain(binding);
      },
    );
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
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const meter = options?.modelCallResourceMeter;
        if (!meter) throw new Error("durable runtime did not inject model-call metering");
        const reserved = await meter.reserve({ callIndex: 1, tokenUpperBound: 8 });
        await meter.consume({ usageId: reserved.usageId, tokens: 4 });
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
            timestamp: new Date(now).toISOString(),
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
    const protocol = createProtocol({
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
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-1",
    );
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
    expect(drainAttempts).toBe(4);

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
    ) as {
      streamFinal: { finalSeq: number; streamDigest: string };
      usageFinal: { upToUsageSeq: number };
    };
    expect(bundle.usageFinal.upToUsageSeq).toBe(1);
    const durableInteraction = (await authority.executorLog.readAll())
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
    const restartedProtocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-shared-backpressure",
    );

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
    const protocol = createProtocol({
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
    await registerActiveConversation(
      authority,
      input.conversationId,
      new Date().toISOString(),
    );
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions,
    });
    manager = new ConversationManager(factory, undefined, {
      ...managerOptions(),
      durableTurnExecutor: protocol,
    });
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-started",
    );
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

    await protocol.recover();
    const recordsWhileOwned = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; runId?: string; state?: string });
    expect(
      recordsWhileOwned.some(
        (record) =>
          record.t === "state" &&
          record.runId === runId &&
          record.state === "uncertain",
      ),
    ).toBe(false);

    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedStatuses: ConversationStatusNotice[] = [];
    const restartedProtocol = createProtocol({
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
      async () => {
        expect(executions).toBe(2);
        expect(
          (await restartedAuthority.authorityLog.readAll())
            .flatMap((commit) => commit.entries)
            .some(
              (entry) =>
                (entry.body as { t?: string; runId?: string }).t === "committed" &&
                (entry.body as { runId?: string }).runId === runId,
            ),
        ).toBe(true);
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
    await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-cancel",
    );
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
    expect(history.next).toEqual([{
      conversationId: "conversation-cancel",
      runId: admitted.runId,
      afterStatusRevision: 0,
    }]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-batch",
    );
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-received",
    );
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
    const restartedProtocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-admitted",
    );
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
    const restartedProtocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
      await registerActiveConversation(
        authority,
        "conversation-admission-response-loss",
        new Date().toISOString(),
      );
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(factory, undefined, {
      ...callbacks(),
      durableTurnExecutor: protocol,
    });
    await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-perspective",
    );
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
      metered: boolean;
    }> = [];
    let restartedManager!: ConversationManager;
    const restartedProtocol = createProtocol({
      authority: restartedAuthority,
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      executeRecoveredPerspective: async (input) => {
        recovered.push({
          question: input.question,
          source: input.source,
          turnId: input.turnContext.turnId,
          // 恢复执行必须携带 assignment 计量序列——恢复路径外调与正常 durable 同构计费
          metered: input.modelCallMetering !== undefined &&
            typeof input.modelCallMetering.nextCallIndex === "function",
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
          metered: true,
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("waits for the active recovery pass and never schedules another pass after stop", async () => {
    const home = await createTempDir("conversation-protocol-stop-recovery");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    let manager!: ConversationManager;
    const protocol = createProtocol({
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
    const protocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("recovers an unprojected delete before readiness and preserves exact replay", async () => {
    const home = await createTempDir("conversation-protocol-lifecycle-restart");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let manager!: ConversationManager;
    const protocol = createProtocol({
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
    const lifecycleAsset = await authority.artifacts.put(
      Buffer.from("lifecycle attachment"),
    );
    const lifecyclePayload = protocolDigest("LifecycleSurfacePayload", 1, {
      conversationId: "conversation-delete-restart",
    });
    await registerActiveConversation(
      authority,
      "conversation-delete-restart",
      "2026-07-24T00:00:00.000Z",
    );
    const lifecycleGrant = await authority.surfaceAssets.issue({
      kind: "asset-upload",
      scope: {
        domain: "conversation",
        conversationId: "conversation-delete-restart",
        ownerEpoch: authority.anchorEpoch,
      },
      surfacePrincipal: "rpc:owner",
      requestId: "lifecycle:asset:1",
      assets: [lifecycleAsset],
      payloadDigest: lifecyclePayload,
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
    const restartedProtocol = createProtocol({
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
      restartedAuthority.surfaceAssets.assertUploadAdoption({
        scope: {
          domain: "conversation",
          conversationId: "conversation-delete-restart",
          ownerEpoch: restartedAuthority.anchorEpoch,
        },
        surfacePrincipal: "rpc:owner",
        requestId: "lifecycle:asset:1",
        assets: [lifecycleAsset],
        payloadDigest: lifecyclePayload,
      }),
    ).rejects.toThrow("unknown or revoked");
    await expect(
      restartedAuthority.surfaceAssets.issue({
        kind: "asset-upload",
        scope: {
          domain: "conversation",
          conversationId: "conversation-delete-restart",
          ownerEpoch: restartedAuthority.anchorEpoch,
        },
        surfacePrincipal: "rpc:owner",
        requestId: "lifecycle:asset:1",
        assets: [lifecycleAsset],
        payloadDigest: lifecyclePayload,
      }),
    ).resolves.toEqual(lifecycleGrant);
    await expect(
      restartedAuthority.surfaceAssets.issue({
        kind: "asset-upload",
        scope: {
          domain: "conversation",
          conversationId: "conversation-delete-restart",
          ownerEpoch: restartedAuthority.anchorEpoch,
        },
        surfacePrincipal: "rpc:owner",
        requestId: "lifecycle:asset:after-delete",
        assets: [lifecycleAsset],
        payloadDigest: lifecyclePayload,
      }),
    ).rejects.toThrow("not owned");
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("rediscovers a newly installed authority generation after prior live discovery", async () => {
    const home = await createTempDir("conversation-protocol-installed-generation");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const projected = vi.fn(async () => {});
    let manager!: ConversationManager;
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle: projected,
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: protocol },
    );
    await protocol.recoverReadinessProjections();

    const conversationId = "conversation-installed-generation";
    await registerActiveConversation(
      authority,
      conversationId,
      "2026-07-24T00:00:00.000Z",
    );
    let writerManager!: ConversationManager;
    const writer = createProtocol({
      authority,
      manager: () => writerManager,
      interactions: new DurableConversationInteractionObserver(),
      projectLifecycle: async () => {
        throw new Error("writer must not consume the installed projection");
      },
    });
    writerManager = new ConversationManager(
      { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) },
      undefined,
      { durableTurnExecutor: writer },
    );
    await writer.writeSession({
      conversationId,
      requestId: "lifecycle:installed-generation:1",
      mutation: { kind: "conversation-delete" },
      principal: writer.controlPrincipal({
        surfacePrincipal: "rpc:owner",
        connectionId: "connection:installed-generation",
      }),
      conversationExists: async () => true,
    });
    expect(projected).not.toHaveBeenCalled();

    await protocol.recoverInstalledAuthority();
    expect(projected).toHaveBeenCalledWith({
      conversationId,
      requestId: "lifecycle:installed-generation:1",
      mutation: "delete",
      domainRevision: 1,
    });
    await protocol.stopRecoveryLoop();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("rejects a new lifecycle request for an unknown conversation before authority append", async () => {
    const home = await createTempDir("conversation-protocol-lifecycle-identity");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    let manager!: ConversationManager;
    const protocol = createProtocol({
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);

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
    const protocol = createProtocol({
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
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-post-commit",
    );
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
    expect(
      result.kind,
      result.kind === "error" ? String(result.error) : undefined,
    ).toBe("settled");
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
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
