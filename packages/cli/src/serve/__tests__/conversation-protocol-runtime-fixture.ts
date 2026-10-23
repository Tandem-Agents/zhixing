// conversation-protocol-runtime.test.ts 拆分后的共享常量与助手。
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { userTurnInputFromText, type Message } from "@zhixing/core";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { protocolDigest } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { type ConversationMutationPublisher } from "@zhixing/owner-kernel/conversation-assignment";
import { createInitialControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationAssignmentLedger, AssignmentStreamWriter, InProcessAssignmentSubmission } from "@zhixing/executor";
import { projectSessionTurn } from "@zhixing/rpc";
import { WorksceneContinuationApplication, type WorksceneApplication, type WorksceneTaskReference } from "@zhixing/core/workscene/application";
import type { PostTurnControlOutcome } from "@zhixing/core/types";
import { createWorksceneContinuationPort } from "../workscene-continuation-adapter.js";
import { createTempDir } from "@zhixing/test-utils";
import { resolve } from "node:path";
import { createDeviceCapacityRuntime } from "../../__tests__/device-capacity-fixture.js";
import { expect, vi, onTestFinished } from "vitest";
import { setupAuthorityRuntime as setupAuthorityRuntimeProduction, type SetupAuthorityRuntimeOptions } from "../../setup-delivery.js";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver, type ConversationLosslessDataPlaneTopology } from "../conversation-protocol-runtime.js";
import { anchorConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import { createConversationAssignmentArtifactAuthorityIndex, createConversationExecutorHostBoundary, NO_REMOTE_CONVERSATION_EXECUTORS, type ConversationExecutorDispatchApplication } from "../conversation-executor-dispatch.js";

export const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

export const TEST_RESOURCE_CANDIDATE_TTL_MS = 60_000;

export const TEST_DURABLE_IO_TIMEOUT_MS = 120_000;

export const TEST_ANCHOR_LOSSLESS_DATA_PLANE = Object.freeze({
  kind: "available" as const,
  port: Object.freeze({
    openConversationChannel: async () => ({ close: async () => undefined }),
    openFirstPartySurfaceSession: async () => ({
      path: undefined,
      start: () => undefined,
      poll: async () => {
        throw new Error("Test surface session does not poll");
      },
      restoreDirect: async () => undefined,
      checkpoint: () => {
        throw new Error("Test surface session has no checkpoint");
      },
      waitForSeq: async () => undefined,
      close: async () => undefined,
    }),
    recoverConversationChannels: async () => 0,
  }),
}) satisfies ConversationLosslessDataPlaneTopology;

export const TEST_LOCAL_EXECUTOR = {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
};

export const TEST_RUNTIME_AUTHORITY_FACTS = {
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

export function setupAuthorityRuntime(
  options: Omit<SetupAuthorityRuntimeOptions, "executorReadiness"> & {
    readonly executorReadiness?: SetupAuthorityRuntimeOptions["executorReadiness"];
  },
) {
  const runtime = setupAuthorityRuntimeProduction({
    ...options,
    executorReadiness: options.executorReadiness ?? TEST_EXECUTOR_READINESS,
    resourceCandidateTtlMs:
      options.resourceCandidateTtlMs ?? TEST_RESOURCE_CANDIDATE_TTL_MS,
  });
  onTestFinished(async () => { await (await runtime).startupCleanup.run(); });
  return runtime;
}

export function createProtocol(
  options: Omit<
    ConstructorParameters<typeof ConversationProtocolRuntime>[0],
    | "assignmentArtifactAuthority"
    | "executorDispatch"
    | "losslessDataPlane"
    | "recoverAuxiliary"
  > & {
    readonly losslessDataPlane?: ConversationLosslessDataPlaneTopology;
    readonly recoverAuxiliary?: (conversationId: string) => Promise<void>;
    readonly executorDispatch?: ConversationExecutorDispatchApplication;
    readonly maxPendingInteractions?: number;
    readonly localExecutor?: {
      readonly ledger?: ConversationAssignmentLedger;
      readonly ConversationAssignmentLedger: typeof ConversationAssignmentLedger;
      readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
      readonly runtimeFactory: RuntimeFactory;
      readonly createStream?: (input: { readonly assignmentId: string; readonly ref: import("@zhixing/core/contracts").ExecutionRef }) => Promise<AssignmentStreamWriter>;
      readonly foreground?: import("@zhixing/core/resources").ForegroundActivityPort;
    };
  },
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
  const owner = options.owner ?? anchorConversationOwnerRuntime(options.authority!);
  const executorBoundary = options.executorDispatch
    ? undefined
    : createConversationExecutorHostBoundary({
      authority: owner,
      directory: NO_REMOTE_CONVERSATION_EXECUTORS,
      clock: () => new Date().toISOString(),
      ...(options.maxPendingInteractions === undefined
        ? {}
        : { maxPendingInteractions: options.maxPendingInteractions }),
      local: localExecutor,
    });
  const {
    localExecutor: _localExecutor,
    maxPendingInteractions: _maxPendingInteractions,
    ...protocolOptions
  } = options;
  return new ConversationProtocolRuntime({
    ...protocolOptions,
    recoverAuxiliary: options.recoverAuxiliary ?? (async () => {}),
    losslessDataPlane: options.losslessDataPlane ?? TEST_ANCHOR_LOSSLESS_DATA_PLANE,
    assignmentArtifactAuthority: createConversationAssignmentArtifactAuthorityIndex(),
    executorDispatch: options.executorDispatch ?? executorBoundary!.application,
    ...(executorBoundary?.staging
      ? { assignmentStaging: executorBoundary.staging }
      : {}),
  });
}

export async function registerActiveConversation(
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

export async function getOrCreateActiveConversation(
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

export function expectSettled(
  result: Awaited<ReturnType<typeof projectSessionTurn>>,
): asserts result is Extract<typeof result, { kind: "settled" }> {
  if (result.kind === "error") throw result.error;
  expect(result.kind).toBe("settled");
}

export class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(secretKey(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(secretKey(ref)) ?? null;
  }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = secretKey(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
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

export async function seedPendingConversation(label: string) {
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
    { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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

export function mutationPublisher(label: string): ConversationMutationPublisher {
  return {
    readProjectionIds: [label],
    decideGlobalBatchAtPrefix: vi.fn(() => []),
    apply: vi.fn(async () => undefined),
  };
}

export async function worksceneContinuationHarness(nextControl?: (tasks: readonly WorksceneTaskReference[], executionIndex: number) => PostTurnControlOutcome | undefined, probe?: {
  initialConversationId: string;
  firstControl: PostTurnControlOutcome;
  canRunIsolatedMain?: boolean;
  withWorkspace?: boolean;
  withAdvancement?: boolean;
  beforeRun?: (conversationId: string, origin: import("@zhixing/core").TurnOrigin | undefined) => Promise<void>;
}) {
  const home = await createTempDir("workscene-continuation");
  const capacity = probe?.withWorkspace ? createDeviceCapacityRuntime(resolve(home, "capacity")) : undefined;
  const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore(), ...(capacity ? { deviceCapacity: capacity.arbiter, storageMaintenance: capacity.storage } : {}) });
  let environment: import("@zhixing/core/contracts").ExplicitEnvironmentSelection | undefined;
  if (probe?.withWorkspace) {
    const migration = authority.workspaceBindingMigration!;
    const binding = await migration.importLegacy({ migrationId: "continuation-workspace", sourceSnapshotToken: "initial", displayName: "Original project", absolutePath: resolve(home, "project") }, new AbortController().signal);
    await migration.activateLegacy({ migrationId: "continuation-workspace", sourceSnapshotToken: "initial" }, new AbortController().signal);
    environment = { workspace: { deviceId: authority.deviceId, bindingRef: binding.bindingRef } };
  }
  const executions: string[] = [];
  const control = { intent: { kind: "enter" as const, sceneId: "reports", handoff: { goal: "交付报告", constraints: ["不发布"], completed: [], remaining: ["生成报告"] } } };
  const factory: RuntimeFactory = {
    create: async (conversationId) => ({
      ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
        executions.push(conversationId);
        await probe?.beforeRun?.(conversationId, options?.turnContext?.turnOrigin);
        const meter = options?.modelCallResourceMeter;
        if (!meter) throw new Error("missing governed model call");
        const reserved = await meter.reserve({ callIndex: 1, tokenUpperBound: 8 });
        await meter.consume({ usageId: reserved.usageId, tokens: 2 });
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: conversationId.startsWith("ws:") ? "报告已生成，未发布" : "原任务回复" }] };
        const proposal = executions.length === 1 ? (probe?.firstControl ?? control) : nextControl?.(options?.turnContext?.worksceneTasks ?? [], executions.length);
        return { agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } }, runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], ...(proposal ? { postTurnControl: proposal } : {}) }, newMessages: [assistant], durationMs: 1, ...(proposal ? { pendingPostTurnControl: proposal } : {}) };
      },
      abort: () => false, async dispose() {},
    }),
  };
  let manager!: ConversationManager;
  let application!: WorksceneContinuationApplication;
  const prepare = probe?.withWorkspace ? vi.spyOn(authority, "prepareConversationAssignment") : undefined;
  const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(), recoverAuxiliary: (id) => application.recover(id), projectLifecycle: async () => {} });
  const committed = new Set<string>();
  manager = new ConversationManager(factory, undefined, {
    durableTurnExecutor: protocol, onTurnCommitted: () => {}, loadHistory: async () => undefined, initTranscript: async () => {}, appendRun: async () => { throw new Error("durable handoff must not use legacy append"); },
    appendCommittedRun: async (_id, record) => { const appended = !committed.has(record.runId); committed.add(record.runId); return { runIndex: record.runIndex, shardId: "owner-log", appended }; },
  });
  const workscene: WorksceneApplication = {
    query: vi.fn(), projectConversationRuntime: vi.fn(),
    execute: async (command) => {
      if (command.kind !== "enter") throw new Error("unexpected workscene command");
      const conversationId = `ws:${command.sceneId}:primary`;
      await protocol.ensureSession(conversationId);
      await manager.getOrCreate(conversationId);
      return { kind: "entered", conversationId, scene: { sceneId: command.sceneId, name: command.sceneId, revision: 1 } };
    },
  };
  const advanceContext = () => ({ principal: { kind: 'host' as const, component: 'continuation-advancement-fixture' }, requestId: 'advance-read', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
  const cancelAdvancement = vi.fn(async ({ conversationId, advancementSessionId: sessionId }: { conversationId: string; advancementSessionId: string }) => {
    await protocol.sessionState.mutate(conversationId, { kind: 'advancement-event', events: [{ type: 'cancelled', sessionId, timestamp: new Date().toISOString() }] },
      { principal: { kind: 'host', component: 'continuation-advancement-fixture' }, requestId: 'cancel-advancement', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    return (await protocol.sessionState.readAdvancementState(conversationId, advanceContext()))!;
  });
  application = new WorksceneContinuationApplication(createWorksceneContinuationPort({ manager, protocol, workscene, canRunIsolatedMain: probe?.canRunIsolatedMain ?? true,
    advancement: { queryActiveState: async id => {
      if (!probe?.withAdvancement) return null;
      const state = await protocol.sessionState.readAdvancementState(id, advanceContext());
      return state?.status === 'active' ? { advancementSessionId: state.id, status: state.status } : null;
    }, cancelSession: probe?.withAdvancement ? cancelAdvancement : vi.fn() } }));
  // Assertions inspect named historical runs explicitly. Production discovery
  // now returns only unconsumed obligations and must not retain these rows.
  const historySources = async (id: string) => {
    const runs = (await authority.authorityLog.readStream(`run:${id}`)).flatMap(({ body }) => {
      const record = body as { t?: string; runId?: string };
      return record.t === 'admitted' && record.runId ? [record.runId] : [];
    });
    return (await Promise.all(runs.map(runId => protocol.worksceneContinuationSources(id, { runId })))).flat();
  };
  return { authority, protocol, manager, application, executions, environment, prepare, historySources, cancelAdvancement, start: async () => {
    const managed = await getOrCreateActiveConversation(authority, manager, probe?.initialConversationId ?? "main-handoff");
    if (probe?.withAdvancement) {
      const timestamp = new Date().toISOString(), input = userTurnInputFromText('report');
      const evidence = [{ id: 'evidence', kind: 'test-result' as const, description: 'verified', required: true }];
      await protocol.sessionState.mutate('main-handoff', { kind: 'advancement-event', events: [
        { type: 'session_created', timestamp, sessionId: 'adv-continuation', conversationId: 'main-handoff', originalUserTask: input,
          pendingRubricDraft: { draftId: 'draft-continuation', originalTurnId: 'original-task', source: 'generated', candidateRubricIds: [], title: 'report', description: 'finish',
            content: { passCriteria: ['verified'], evidenceRequirements: evidence, failureHandling: [] }, createdAt: timestamp } },
        { type: 'rubric_confirmed', timestamp, sessionId: 'adv-continuation', confirmedRubric: { source: { kind: 'library', rubricId: 'fixture-rubric', rubricVersion: 'v1' }, title: 'report', description: 'finish',
          content: { passCriteria: [{ id: 'criterion', text: 'verified' }], evidenceRequirements: evidence, failureHandling: [] }, confirmedAt: timestamp, confirmedBy: 'user' },
          admissionIntent: { turnId: 'original-task', surfacePrincipal: 'rpc:owner', turnOrigin: { channel: 'rpc', triggeredBy: 'rpc:owner' }, inputDigest: protocolDigest('AdvancementOriginalTaskInput', 1, input) } },
      ] }, { principal: { kind: 'host', component: 'continuation-advancement-fixture' }, requestId: 'activate-advancement', deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    }

    expectSettled(await projectSessionTurn({ manager, managed, ...(environment ? { environment } : {}), text: "报告整理", turnId: "handoff-start", runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "handoff-start", ...(probe ? { turnOrigin: { channel: "rpc", triggeredBy: "rpc:owner" } } : {}) } }, notify: () => {} }));
  } };
}

export function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
