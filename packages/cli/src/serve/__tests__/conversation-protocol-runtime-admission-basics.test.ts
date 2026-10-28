// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：admission-basics。
import { ForegroundActivity, StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { ConfirmationBroker } from "@zhixing/core/confirmation";
import { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import { createServerConfirmationBinding, createServerConversationBinding } from "../server-product-bindings.js";
import { buildConfirmationListMethod, buildConfirmationResolveMethod } from "../../../../server/src/rpc/methods/confirmation.js";
import { userTurnInputFromText, type Message } from "@zhixing/core";
import { TaskListService } from "@zhixing/core/conversation/application";
import { createAnchorConversationTaskListPort } from "../conversation-task-list-application.js";
import { createEventBus } from "@zhixing/core/events";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createAssignmentSkillPorts } from "../../runtime/assignment-skill-adapter.js";
import { skillNameToId } from "@zhixing/core/skills/id";
import { createSignedTrustRuleSnapshot } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { GlobalMutationCommitCoordinator } from "@zhixing/owner-kernel/global-mutation-commit-coordinator";
import { SchedulerConversationMutationPublisher } from "@zhixing/owner-kernel/scheduler-conversation-publisher";
import { ConversationRunJournal, InProcessConversationDispatcher } from "@zhixing/owner-kernel/conversation-assignment";
import { createConversationControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { type SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationAssignmentLedger, DataPlaneTicketRegistry, AssignmentStreamSpool } from "@zhixing/executor";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { ShardedTranscriptStore, readRunsReverse } from "@zhixing/core/transcript";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { SessionAdvancementStore } from "@zhixing/owner-services/advancement";
import { LLMRubricDraftGenerationStrategy, RubricContractBuilder } from "@zhixing/core/advancement";
import { ExtensionApplication } from "@zhixing/core/extensions/application";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionCandidates } from "@zhixing/core/extensions/candidate";
import { ExtensionOnboarding } from "@zhixing/core/extensions/onboarding";
import { createExtensionContinuation, createExtensionStatusObserver, extensionContinuationText } from "../extension-continuation.js";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver, type ConversationLosslessDataPlaneTopology } from "../conversation-protocol-runtime.js";
import { ConversationKernelExecution } from "../conversation-kernel-execution.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_ANCHOR_LOSSLESS_DATA_PLANE, TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, getOrCreateActiveConversation, expectSettled, MemorySecretStore } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
  it("isolates a permanently failed received cancellation from another conversation's recovery", async () => {
    const home = await createTempDir("received-cancel-isolation");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const onFailure = vi.fn();
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager,
      interactions: new DurableConversationInteractionObserver(), onFailure });
    manager = new ConversationManager({ create: vi.fn(async () => { throw Error("not executing queued work"); }) },
      undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const source = { principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } };
    for (const conversationId of ["cancel-isolation-a", "cancel-isolation-b"]) {
      await registerActiveConversation(authority, conversationId, new Date().toISOString());
      const admitted = await protocol.admit({ conversationId, input: "queued",
        invocation: { kind: "agent", source: "interactive" }, options: { source: "interactive", turnContext: { turnId: conversationId } },
        surfacePrincipal: "rpc:owner" });
      const envelope = createConversationControlEnvelope({ requestId: `cancel:${conversationId}`, source,
        body: { t: "cancel", conversationId, runId: admitted.runId, ownerEpoch: 1 } });
      await expect(authority.controlAdmission.applyAuthority({ envelope, source, stream: `run:${conversationId}`,
        initial: null, reducer: () => null, decide: () => { throw Error("received-only"); } }))
        .rejects.toThrow("received-only");
    }
    const pending = (await authority.controlAdmission.pendingCancellations()).envelopes;
    expect(pending).toHaveLength(2);
    const broken = pending[0]!, healthy = pending[1]!, permanent = Error("permanent control source failure");
    if (broken.body.t !== "cancel") throw Error("Expected the seeded single-run cancellation");
    const brokenConversationId = broken.body.conversationId;
    const original = ConversationRunJournal.prototype.applyControl;
    const spy = vi.spyOn(ConversationRunJournal.prototype, "applyControl").mockImplementation(function (input) {
      if (input.envelope.requestId === broken.requestId) return Promise.reject(permanent);
      return original.call(this, input);
    });
    try {
      await expect(protocol.recover()).resolves.toBeGreaterThanOrEqual(1);
      const remaining = (await authority.controlAdmission.pendingCancellations()).envelopes.map(value => value.requestId);
      expect(remaining).toContain(broken.requestId);
      expect(remaining).not.toContain(healthy.requestId);
      expect(onFailure.mock.calls.some(([error, context]) =>
        context.conversationId === brokenConversationId &&
        (error === permanent || error instanceof AggregateError && error.errors.includes(permanent)))).toBe(true);
    } finally { spy.mockRestore(); await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  // 停止请求与运行终结交错：终结之前到达照常取消；终结之后才到达的（例如 Ctrl+C 恰逢运行刚结束）按权威终态答“已结束”，不报失败
  it("answers a cancellation that arrives after the run already finished with that finished state", async () => {
    const home = await createTempDir("conversation-finished-cancel");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    const factory = { create: vi.fn(async () => { throw Error("cancelled queued input must not execute"); }) };
    manager = new ConversationManager(factory, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const conversationId = "finished-cancel";
    await registerActiveConversation(authority, conversationId, new Date().toISOString());
    const admitted = await protocol.admit({ conversationId, input: "queued",
      invocation: { kind: "agent", source: "interactive" }, options: { source: "interactive", turnContext: { turnId: "finished-cancel-input" } },
      surfacePrincipal: "rpc:owner" });
    const principal = { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" };
    try {
      const first = await protocol.cancel({ conversationId, requestId: "cancel:before-finish", runId: admitted.runId, principal });
      expect(first.finished).toBeUndefined();
      expect(first.dispositions.map((item) => item.runState)).toEqual(["cancelled"]);
      expect(await protocol.cancel({ conversationId, requestId: "cancel:after-finish", runId: admitted.runId, principal }))
        .toEqual({ dispositions: [], finished: { runId: admitted.runId, runState: "cancelled" } });
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("recovers a received cancellation after its bounded foreground retry and a cold owner restart", async () => {
    const home = await createTempDir("conversation-received-cancel-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    const factory = { create: vi.fn(async () => { throw Error("cancelled queued input must not execute"); }) };
    manager = new ConversationManager(factory, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const conversationId = "received-cancel";
    await registerActiveConversation(authority, conversationId, new Date().toISOString());
    const admitted = await protocol.admit({ conversationId, input: "queued",
      invocation: { kind: "agent", source: "interactive" }, options: { source: "interactive", turnContext: { turnId: "received-cancel-input" } },
      surfacePrincipal: "rpc:owner" });
    const transact = authority.authorityLog.transactProjection;
    const blocked = vi.spyOn(authority.authorityLog, "transactProjection").mockImplementation(async function (...args) {
      if (args[3]?.streams?.includes(`run:${conversationId}`) && args[3]?.readProjectionIds?.includes("control-admission-v1")) {
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs: 10 });
      }
      return transact.apply(this, args);
    });
    try {
      expect(await protocol.cancel({ conversationId, requestId: "cancel:received", runId: admitted.runId,
        principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } }))
        .toEqual({ dispositions: [], receivedPending: true });
      expect((await authority.controlAdmission.pendingCancellations()).envelopes.map(value => value.requestId)).toEqual(["cancel:received"]);
    } finally { blocked.mockRestore(); await protocol.stopRecoveryLoop(); }
    const coldAuthority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let coldManager!: ConversationManager;
    const cold = createProtocol({ authority: coldAuthority, manager: () => coldManager, interactions: new DurableConversationInteractionObserver() });
    coldManager = new ConversationManager(factory, undefined, { durableTurnExecutor: cold, onTurnCommitted: () => {} });
    try {
      await cold.recover();
      expect((await coldAuthority.controlAdmission.pendingCancellations()).envelopes).toEqual([]);
      const records = (await coldAuthority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; requestId?: string; runId?: string; state?: string });
      expect(records.filter(value => value.t === "received" && value.requestId === "cancel:received")).toHaveLength(1);
      expect(records.filter(value => value.t === "applied" && value.requestId === "cancel:received")).toHaveLength(1);
      expect(records.filter(value => value.t === "state" && value.runId === admitted.runId && value.state === "cancelled")).toHaveLength(1);
      expect(factory.create).not.toHaveBeenCalled();
    } finally { await cold.stopRecoveryLoop(); await manager.disposeAll(); await coldManager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each([
    { mode: "single", settleBetween: false }, { mode: "batch", settleBetween: false },
    { mode: "single", settleBetween: true }, { mode: "batch", settleBetween: true },
  ])("$mode cancellation preserves pending quiescence (between recovery steps: $settleBetween)", async ({ mode, settleBetween }) => {
    const home = await createTempDir("conversation-cancel-meter");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const reserved = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const teardown = Promise.withResolvers<void>();
    const kernelFinished = Promise.withResolvers<void>();
    const finishProof = Promise.withResolvers<void>();
    const originalKernel = ConversationKernelExecution.prototype.run;
    const kernelRun = vi.spyOn(ConversationKernelExecution.prototype, "run").mockImplementation(async function* (...args) {
      try { return yield* originalKernel.apply(this, args); }
      finally { kernelFinished.resolve(); }
    });
    let recoverAssignments: ReturnType<typeof vi.spyOn> | undefined;
    let finishCancellation: ReturnType<typeof vi.spyOn> | undefined;
    const consumed = vi.fn();
    const projection: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "cancel-meter",
      async *run() { throw new Error("projection runtime must not execute"); }, abort: vi.fn(() => false), async dispose() {} };
    const execution: SessionRuntime = { ...projection, abort: vi.fn(() => true),
      async *run(messages, options) {
        const meter = options!.modelCallResourceMeter!;
        const usage = await meter.reserve({ callIndex: 0, tokenUpperBound: 1000 });
        reserved.resolve();
        const signal = options!.abortSignal!;
        if (!signal.aborted) await Promise.race([teardown.promise, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        await cleanup.promise;
        await meter.consume({ usageId: usage.usageId, tokens: 7 });
        consumed();
        return { agentResult: { reason: "aborted", usage: { inputTokens: 5, outputTokens: 2 } },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!], usage: { inputTokens: 5, outputTokens: 2 } }, newMessages: [], durationMs: 1 };
      } };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => execution } } });
    manager = new ConversationManager({ create: async () => projection }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    let running: ReturnType<typeof projectSessionTurn> | undefined;
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "cancel-meter");
      running = projectSessionTurn({ manager, managed, text: "cancel metered call", turnId: "meter", notify: () => {},
        runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "meter" } } });
      await Promise.race([reserved.promise, running.then(result => {
        if (result.kind === "error") throw result.error;
        throw new Error("Execution ended before resource reservation");
      })]);
      const admitted = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; runId?: string }).find(body => body.t === "admitted");
      const runId = admitted!.runId!;
      await protocol.cancel({ conversationId: "cancel-meter", ...(mode === "single" ? { runId } : {}), requestId: `cancel-meter:${mode}`,
        principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "test" } });
      expect(execution.abort).toHaveBeenCalledOnce();
      expect(consumed).not.toHaveBeenCalled();
      const status = () => protocol.statusHistory([{ conversationId: "cancel-meter", runId, afterStatusRevision: 0 }]);
      expect((await status()).notices.at(-1)?.state).toBe("cancel-requested");
      if (settleBetween) {
        const originalFinish = ConversationAssignmentLedger.prototype.finishOwnerCancellation;
        finishCancellation = vi.spyOn(ConversationAssignmentLedger.prototype, "finishOwnerCancellation").mockImplementation(async function (...args) {
          await finishProof.promise;
          return originalFinish.apply(this, args);
        });
        const originalRecover = InProcessConversationDispatcher.prototype.recoverAssignments;
        recoverAssignments = vi.spyOn(InProcessConversationDispatcher.prototype, "recoverAssignments").mockImplementationOnce(async function (...args) {
          cleanup.resolve();
          await kernelFinished.promise;
          return originalRecover.apply(this, args);
        });
      }
      await protocol.recoverConversation("cancel-meter");
      expect((await status()).notices.at(-1)?.state).toBe("cancel-requested");
      expect((await status()).notices.some(notice => notice.state === "uncertain")).toBe(false);
      finishProof.resolve();
      cleanup.resolve();
      expectSettled(await running);
      expect(consumed).toHaveBeenCalledOnce();
      expect((await status()).notices.at(-1)?.state).toBe("cancelled");
    } finally {
      teardown.resolve();
      finishProof.resolve();
      cleanup.resolve();
      await running;
      kernelRun.mockRestore();
      recoverAssignments?.mockRestore();
      finishCancellation?.mockRestore();
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    }
  }, 30000);

  it("establishes a created empty conversation before its first Advancement fact", async () => {
    const home = await createTempDir("advancement-empty-conversation");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const storage = createConversationStorageInfrastructure({ zhixingHome: home, optimalMaxTokens: 1000,
      worksceneConversationStorageRemoval: { removeConversation: async () => {} } });
    const manager = new ConversationManager({ create: async () => { throw new Error("Draft persistence must not start execution"); } });
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      storedIdentityExists: id => storage.directory.exists(id) });
    const store = new SessionAdvancementStore({ port: protocol.sessionState });
    const builder = new RubricContractBuilder({ generationStrategy: new LLMRubricDraftGenerationStrategy({ complete: async () => JSON.stringify({
      title: "离线交互核对", description: "核对离线交互结果", passCriteria: ["说明本次核对结果"],
      evidenceRequirements: [{ kind: "conversation-fact", description: "明确答复", required: false }],
      failureHandling: [{ scenario: "遗漏结果", reply: "请补充结果" }],
    }) }) });
    const input = userTurnInputFromText("核对原任务");
    try {
      const draft = await builder.buildDraft({ originalTurnId: "draft-turn", originalUserTask: input });
      await expect(store.createSession({ id: "adv-absent", conversationId: "conversation-absent", originalUserTask: input, pendingRubricDraft: draft }))
        .rejects.toMatchObject({ code: "not-found" });
      expect(await authority.controlAdmission.listCreatedConversationIds()).not.toContain("conversation-absent");
      const created = await storage.directory.create();
      expect(await protocol.sessionExists(created.conversationId)).toBe(false);
      const beforeRead = await authority.authorityLog.checkpoint();
      await expect(protocol.recoveryPage({ mode: 'body-page', conversationId: created.conversationId }))
        .resolves.toMatchObject({ fragments: [], hasMore: false });
      await expect(protocol.recoveryPage({ mode: 'control-page', conversationId: created.conversationId }))
        .resolves.toMatchObject({ facts: [], hasMore: false });
      expect(await authority.authorityLog.checkpoint()).toEqual(beforeRead);
      await expect(protocol.recoveryPage({ mode: 'body-page', conversationId: 'conversation-absent' }))
        .rejects.toThrow('unavailable');
      await expect(store.createSession({ id: "adv-first-draft", conversationId: created.conversationId, originalUserTask: input, pendingRubricDraft: draft }))
        .resolves.toMatchObject({ id: "adv-first-draft", status: "awaiting-rubric-confirmation", pendingRubricDraft: draft });
      expect(await authority.controlAdmission.listCreatedConversationIds()).toContain(created.conversationId);
      protocol.releaseConversation(created.conversationId);
      expect(await store.loadSession(created.conversationId, "adv-first-draft")).toMatchObject({ id: "adv-first-draft", pendingRubricDraft: draft });
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); await authority.startupCleanup.run(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("establishes a locally created empty conversation before its first task-list control write", async () => {
    const home = await createTempDir("task-list-empty-conversation");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const storage = createConversationStorageInfrastructure({ zhixingHome: home, optimalMaxTokens: 1000,
      worksceneConversationStorageRemoval: { removeConversation: async () => {} } });
    const manager = new ConversationManager({ create: async () => { throw new Error("Task mutation must not start a model"); } });
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      storedIdentityExists: id => storage.directory.exists(id) });
    const cache = new TaskListService({ load: async () => { throw new Error("Legacy task state must not be read"); } });
    const port = createAnchorConversationTaskListPort({ conversations: manager, exists: id => storage.directory.exists(id),
      taskLists: cache, sessionState: protocol.sessionState,
      readMutationBase: (id, requestId) => protocol.taskListBeforeMutation(id, requestId) });
    const request = (conversationId: string) => ({ conversationId, operationId: "task:first-local-write",
      decide: (current: { items: readonly import("@zhixing/core/conversation").TaskItem[] }) => ({
        outcome: "added" as const, taskContent: "first task",
        next: { items: [...current.items, { id: "first-task", content: "first task", status: "pending" as const }] },
      }) });
    try {
      await expect(port.maintain(request("conversation-absent"))).resolves.toEqual({ status: "not-found" });
      expect(await authority.controlAdmission.listCreatedConversationIds()).not.toContain("conversation-absent");
      const created = await storage.directory.create();
      expect(await protocol.sessionExists(created.conversationId)).toBe(false);
      await expect(port.maintain(request(created.conversationId))).resolves.toMatchObject({ status: "done",
        taskList: { items: [{ id: "first-task", content: "first task", status: "pending" }] } });
      expect(await protocol.sessionExists(created.conversationId)).toBe(true);
      await port.maintain(request(created.conversationId));
      protocol.releaseConversation(created.conversationId);
      expect(await port.read(created.conversationId)).toEqual({ items: [{ id: "first-task", content: "first task", status: "pending" }] });
      await protocol.writeSession({ conversationId: created.conversationId, requestId: "task:delete-local",
        mutation: { kind: "conversation-delete" },
        principal: protocol.controlPrincipal({ surfacePrincipal: "rpc:owner", connectionId: "task:delete" }),
        conversationExists: () => storage.directory.exists(created.conversationId) });
      // Local projection may still exist while the durable deletion is final.
      expect(await storage.directory.exists(created.conversationId)).toBe(true);
      await expect(protocol.recoveryPage({ mode: 'body-page', conversationId: created.conversationId }))
        .rejects.toThrow('unavailable');
      await expect(port.maintain({ ...request(created.conversationId), operationId: "task:after-delete" }))
        .rejects.toMatchObject({ code: "not-found" });
      expect(await protocol.sessionExists(created.conversationId)).toBe(false);
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); await authority.startupCleanup.run(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("keeps task-list authority and late retries independent of legacy files and later list order", async () => {
    const home = await createTempDir("owner-task-list-retry");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => { throw new Error("task commands do not start a model"); } });
    const id = "ws:中文验收:primary";
    const context = (requestId: string) => ({ principal: { kind: "host" as const, component: "task-test" }, requestId, deadlineAt: new Date(Date.now() + 30000).toISOString() });
    const cache = new TaskListService({ load: async () => { throw new Error("legacy storage must not be read"); } });
    const port = createAnchorConversationTaskListPort({ conversations: manager, exists: value => protocol.sessionExists(value), taskLists: cache,
      sessionState: protocol.sessionState, readMutationBase: (value, request) => protocol.taskListBeforeMutation(value, request) });
    const add = (task: string) => ({ conversationId: id, operationId: `task:${task}`, decide: (current: { items: readonly import("@zhixing/core/conversation").TaskItem[] }) => ({
      outcome: "added" as const, taskContent: task, next: { items: [...current.items, { id: task, content: task, status: "pending" as const }] },
    }) });
    try {
      await protocol.ensureSession(id);
      const noEffect = { conversationId: id, operationId: "task:initially-empty", decide: (current: { items: readonly import("@zhixing/core/conversation").TaskItem[] }) => current.items.length === 0
        ? { outcome: "not-found" as const, token: "1" }
        : { outcome: "completed" as const, taskContent: current.items[0]!.content, next: { items: current.items.map((item, index) => index === 0 ? { ...item, status: "completed" as const } : item) } } };
      await port.maintain(noEffect);
      await port.maintain(add("a"));
      await port.maintain(add("b"));
      await expect(port.maintain(noEffect)).resolves.toMatchObject({ decision: { outcome: "not-found" }, taskList: { items: [{ status: "pending" }, { status: "pending" }] } });
      protocol.releaseConversation(id);
      await expect(port.maintain(add("a"))).resolves.toMatchObject({ status: "done", taskList: { items: [{ id: "a" }, { id: "b" }] } });
      const done = { conversationId: id, operationId: "task:done-first", decide: (current: { items: readonly import("@zhixing/core/conversation").TaskItem[] }) => ({
        outcome: "completed" as const, taskContent: current.items[0]!.content,
        next: { items: current.items.map((item, index) => index === 0 ? { ...item, status: "completed" as const } : item) },
      }) };
      await port.maintain(done);
      const state = await protocol.sessionState.readTaskList(id, context("read"));
      await protocol.sessionState.mutate(id, { kind: "task-list-op", op: { op: "set", state: { items: [...state.items].reverse() } } }, context("reorder"));
      await port.maintain(done);
      expect(await port.read(id)).toEqual({ items: [{ id: "b", content: "b", status: "pending" }, { id: "a", content: "a", status: "completed" }] });
      await protocol.sessionState.mutate(id, { kind: "task-list-op", op: { op: "set", state: { items: [] } } }, context("replace-empty"));
      await port.maintain(add("a"));
      expect(await port.read(id)).toEqual({ items: [] });
      await expect(port.maintain({ ...add("a"), decide: () => ({ outcome: "added", taskContent: "changed", next: { items: [{ id: "changed", content: "changed", status: "pending" }] } }) })).rejects.toThrow();
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); await authority.startupCleanup.run(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["allow-once", "deny", "cancel", "failure"] as const)("routes %s confirmations to the issued runtime and releases its binding", async ending => {
    const home = await createTempDir("execution-confirmation");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const interactions = new DurableConversationInteractionObserver();
    const hub = new ConfirmationHub();
    const projectionBroker = new ConfirmationBroker();
    const executionBroker = new ConfirmationBroker({ lifecycleObserver: interactions });
    let decision: unknown;
    const projection: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "confirmation",
      confirmationBroker: projectionBroker, async *run() { throw new Error("projection must not execute"); }, abort: () => false, async dispose() {} };
    const execution: SessionRuntime = { ...projection, confirmationBroker: executionBroker,
      async *run(messages, options) {
        const now = Date.now();
        decision = await executionBroker.requestConfirmation({ id: "candidate-confirmation", tool: "extension_connect", toolInput: { candidatePath: "candidate.json" }, workingDirectory: home,
          display: { title: "接入候选", body: { kind: "generic", summary: "执行固定摘要候选" }, cwd: home },
          options: [{ kind: "allow-once", label: "允许一次" }, { kind: "deny", label: "拒绝" }], sessionType: "ci", contextId: { kind: "main" },
          createdAt: now, expiresAt: now + 30000, turnOrigin: options?.turnContext?.turnOrigin });
        if (ending === "failure") throw new Error("candidate execution failed");
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "settled" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage }, newMessages: [assistant], durationMs: 1 };
      },
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions,
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => execution } } });
    manager = new ConversationManager({ create: async () => projection }, undefined,
      { confirmationHub: hub, durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const connection = { id: 1, authenticated: true, loopback: true, closed: false, surfacePrincipal: "rpc:owner", notify: vi.fn() };
    const server = { confirmation: createServerConfirmationBinding(hub), conversation: createServerConversationBinding(manager) };
    let running: ReturnType<typeof projectSessionTurn> | undefined;
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "confirmation");
      manager.addObserver("confirmation", "1");
      running = projectSessionTurn({ manager, managed, text: "提交适配", turnId: "candidate", notify: () => {},
        runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "candidate", turnOrigin: { channel: "rpc", triggeredBy: "1" } } } });
      await vi.waitFor(() => expect(hub.findEntry("candidate-confirmation")).toBeDefined(), { timeout: 10000 });
      expect(decision).toBeUndefined();
      expect(hub.findBrokerByConversation("confirmation")).toBe(executionBroker);
      expect(projectionBroker.listPending()).toHaveLength(0);
      const context = { server, connection } as never;
      expect(await buildConfirmationListMethod().handler({ conversationId: "confirmation" }, context)).toMatchObject({ items: [{ requestId: "candidate-confirmation" }] });
      expect(await buildConfirmationListMethod().handler({ conversationId: "confirmation" }, { server, connection: { ...connection, id: 2 } } as never)).toEqual({ items: [] });
      if (ending === "cancel") hub.findBrokerByConversation("confirmation")!.cancelAll("aborted");
      else await expect(buildConfirmationResolveMethod().handler({ conversationId: "confirmation", requestId: "candidate-confirmation", decision: { kind: ending === "deny" ? "deny" : "allow-once" } }, context)).resolves.toEqual({ ok: true });
      const outcome = await running;
      if (ending === "failure") expect(outcome.kind).toBe("error");
      else expectSettled(outcome);
      expect(decision).toMatchObject({ kind: ending === "cancel" ? "cancelled" : ending === "deny" ? "deny" : "allow-once" });
      expect(hub.findBrokerByConversation("confirmation")).toBe(projectionBroker);
      expect(hub.listAllPending()).toHaveLength(0);
      expect(executionBroker.listPending()).toHaveLength(0);
    } finally {
      executionBroker.cancelAll("aborted");
      await running;
      await protocol.stopRecoveryLoop(); await manager.disposeAll();
    }
  }, 30000);


  it.each([
    { mode: "single", boundary: "ack" }, { mode: "batch", boundary: "ack" },
    { mode: "single", boundary: "ticket" }, { mode: "batch", boundary: "ticket" },
    { mode: "single", boundary: "accept" }, { mode: "batch", boundary: "accept" },
    { mode: "single", boundary: "start" }, { mode: "batch", boundary: "start" },
    { mode: "single", boundary: "report" }, { mode: "batch", boundary: "report" },
  ] as const)("settles cancellation before $boundary for $mode without losing in-flight routing", async ({ mode, boundary }) => {
    const home = await createTempDir("conversation-prestart-cancel");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const conversationId = "prestart-cancel";
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const cancellationBegan = Promise.withResolvers<void>();
    const firstProof = Promise.withResolvers<void>();
    let runId = "";
    let executions = 0;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run() { executions++; throw new Error("Cancelled assignment must not execute"); },
      abort: vi.fn(() => false), async dispose() {} };
    let dispatchedLedger: ConversationAssignmentLedger | undefined;
    const dispatch = ConversationAssignmentLedger.prototype.dispatch;
    const dispatchSpy = vi.spyOn(ConversationAssignmentLedger.prototype, "dispatch").mockImplementation(async function (...args) {
      dispatchedLedger = this; return dispatch.apply(this, args);
    });
    const losslessDataPlane: ConversationLosslessDataPlaneTopology = { kind: "available", port: {
      ...TEST_ANCHOR_LOSSLESS_DATA_PLANE.port,
      async openFirstPartySurfaceSession(input) {
        if (boundary === "accept") {
          reached.resolve(); await proceed.promise;
          const artifacts = new FileArtifactStore(resolve(home, "ticket-test-artifacts"));
          const registry = new DataPlaneTicketRegistry({
            log: new FileAuthorityCommitLog(resolve(home, "ticket-test-authority"), artifacts),
            spool: new AssignmentStreamSpool(resolve(home, "ticket-test-spool"), artifacts),
            executorId: input.executorId, verifier: authority.verifier, assignments: dispatchedLedger!,
          });
          await registry.accept(input.ticket);
        }
        return TEST_ANCHOR_LOSSLESS_DATA_PLANE.port.openFirstPartySurfaceSession();
      },
    } };
    const failures: unknown[] = [];
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      losslessDataPlane, onFailure: error => { failures.push(error); } });
    manager = new ConversationManager({ create: async () => runtime }, undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const ack = ConversationRunJournal.prototype.acknowledgeDispatch;
    const issue = ConversationRunJournal.prototype.issueDataPlaneTicket;
    const ackSpy = vi.spyOn(ConversationRunJournal.prototype, "acknowledgeDispatch").mockImplementationOnce(async function (...args) {
      if (boundary === "ack") { reached.resolve(); await proceed.promise; }
      return ack.apply(this, args);
    });
    const ticketSpy = vi.spyOn(ConversationRunJournal.prototype, "issueDataPlaneTicket").mockImplementationOnce(async function (...args) {
      if (boundary === "ticket") { reached.resolve(); await proceed.promise; }
      return issue.apply(this, args);
    });
    const start = ConversationAssignmentLedger.prototype.start;
    const startSpy = vi.spyOn(ConversationAssignmentLedger.prototype, "start").mockImplementationOnce(async function (...args) {
      if (boundary === "start") { reached.resolve(); await proceed.promise; }
      return start.apply(this, args);
    });
    const report = ConversationRunJournal.prototype.reportStarted;
    const reportSpy = vi.spyOn(ConversationRunJournal.prototype, "reportStarted").mockImplementationOnce(async function (...args) {
      if (boundary === "report") { reached.resolve(); await proceed.promise; }
      return report.apply(this, args);
    });
    const begin = ConversationAssignmentLedger.prototype.beginOwnerCancellation;
    const beginSpy = vi.spyOn(ConversationAssignmentLedger.prototype, "beginOwnerCancellation").mockImplementation(async function (...args) {
      const result = await begin.apply(this, args); cancellationBegan.resolve(); return result;
    });
    const finish = ConversationAssignmentLedger.prototype.finishOwnerCancellation;
    const finishSpy = vi.spyOn(ConversationAssignmentLedger.prototype, "finishOwnerCancellation").mockImplementationOnce(async function (...args) {
      await firstProof.promise; return finish.apply(this, args);
    });
    let running: ReturnType<typeof projectSessionTurn> | undefined;
    let cancelling: ReturnType<typeof protocol.cancel> | undefined;
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, conversationId);
      running = projectSessionTurn({ manager, managed, text: "cancel before model", turnId: "prestart",
        runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "prestart" } }, notify: () => {} });
      await Promise.race([reached.promise, running.then(result => { throw new Error("Run ended before gate: " + result.kind); })]);
      runId = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; runId?: string }).find(body => body.t === "admitted")!.runId!;
      const request = { conversationId, ...(mode === "single" ? { runId } : {}), requestId: "cancel-prestart",
        principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "test" } };
      cancelling = protocol.cancel(request);
      await cancellationBegan.promise;
      proceed.resolve();
      expectSettled(await running);
      firstProof.resolve();
      expect((await cancelling).dispositions).toHaveLength(1);
      await protocol.cancel(request);
      await protocol.recoverConversation(conversationId);
      expect(executions).toBe(0);
      expect(failures).toEqual([]);
      const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries).map(entry => entry.body as { t?: string });
      expect(records.filter(record => record.t === "ticket-issued")).toHaveLength(boundary === "accept" || boundary === "start" || boundary === "report" ? 1 : 0);
      expect((await protocol.statusHistory([{ conversationId, runId, afterStatusRevision: 0 }])).notices.at(-1)?.state).toBe("cancelled");
    } finally {
      proceed.resolve(); firstProof.resolve();
      await Promise.allSettled([running, cancelling]);
      ackSpy.mockRestore(); ticketSpy.mockRestore(); startSpy.mockRestore(); reportSpy.mockRestore(); beginSpy.mockRestore(); finishSpy.mockRestore(); dispatchSpy.mockRestore();
      await protocol.stopRecoveryLoop(); await manager.disposeAll();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("executes the issued assignment once when recovery has already acknowledged its dispatch", async () => {
    const home = await createTempDir("conversation-dispatch-recovery-race");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const conversationId = "dispatch-race";
    let executions = 0;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages) {
        executions++;
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "complete" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
          newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const failures: unknown[] = [];
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      onFailure: (error, context) => { failures.push({ error, context }); },
    });
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const assign = ConversationRunJournal.prototype.assign;
    let acknowledged = false;
    const raced = vi.spyOn(ConversationRunJournal.prototype, "assign").mockImplementationOnce(async function (...args) {
      const issued = await assign.apply(this, args);
      await protocol.recoverConversation(conversationId);
      acknowledged = (await this.pendingDispatches()).length === 0;
      return issued;
    });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, conversationId);
      expectSettled(await projectSessionTurn({ manager, managed, text: "hello", turnId: "race-turn",
        runOptions: { source: "interactive", turnContext: { turnId: "race-turn" } }, notify: () => {} }));
      expect(acknowledged).toBe(true);
      expect(executions).toBe(1);
      expect(failures).toEqual([]);
    } finally { raced.mockRestore(); await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("counts a local assignment as host foreground activity from runtime assembly until its disposal", async () => {
    const home = await createTempDir("conversation-dispatch-foreground");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const conversationId = "dispatch-foreground";
    const foreground = new ForegroundActivity();
    let activeDuringRun: boolean | undefined;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages) {
        // 模型与工具执行期间没有请求在途、也可能没有推送：派发本身就是前台活动。
        activeDuringRun = !foreground.quiet(0);
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "complete" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
          newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => runtime }, foreground } });
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, conversationId);
      expectSettled(await projectSessionTurn({ manager, managed, text: "hello", turnId: "foreground-turn",
        runOptions: { source: "interactive", turnContext: { turnId: "foreground-turn" } }, notify: () => {} }));
      expect(activeDuringRun).toBe(true);
      // 派发结束、运行时释放后不再计为前台。
      for (let n = 0; n < 100 && !foreground.quiet(0); n++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(foreground.quiet(0)).toBe(true);
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("keeps committed transcript identity monotonic after clearing the visible conversation", async () => {
    const home = await createTempDir("conversation-clear-sequence");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const conversationId = "clear-sequence";
    const transcript = new ShardedTranscriptStore(resolve(home, "conversations"));
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: conversationId,
      async *run(messages) {
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "complete" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
          newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const finals: unknown[] = [];
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      onFinal: frame => { finals.push(frame); },
      projectLifecycle: async () => { await manager.clear(conversationId, async () => { await transcript.appendClear(conversationId); return true; }); },
    });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
      appendCommittedRun: (id, record) => transcript.appendCommittedRunRecord(id, record),
    });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, conversationId);
      for (let index = 0; index < 3; index++) {
        expect(managed.turnCount).toBe(0);
        expectSettled(await projectSessionTurn({ manager, managed, text: `message-${index}`, turnId: `clear-turn-${index}`,
          runOptions: { source: "interactive", turnContext: { turnId: `clear-turn-${index}` } }, notify: () => {} }));
        manager.setBusy(conversationId, false);
        await protocol.recoverConversation(conversationId);
        expect(finals).toHaveLength(index + 1);
        const visible = [];
        for await (const item of readRunsReverse(transcript, conversationId)) visible.push(item.record);
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({ runIndex: index });
        if (index < 2) {
          expect(await protocol.writeSession({ conversationId, requestId: `clear-${index}`, mutation: { kind: "window-op", op: "clear" },
            principal: protocol.controlPrincipal({ surfacePrincipal: "rpc:owner", connectionId: "clear-test" }), conversationExists: async () => true })).toMatchObject({ status: "accepted" });
          await protocol.completeLifecycleProjections(conversationId);
        }
      }
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("commits a builtin skill load with no global mutations or bound mutation publisher", async () => {
    const home = await createTempDir("extension-skill-context");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const skills = createAssignmentSkillPorts(authority.artifacts, { admissionLlm: async () => { throw new Error("no admission model needed"); } });
    let issuedAt: string | undefined;
    let loaded: string | undefined;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "extension-skill",
      async *run(messages, options) {
        issuedAt = options?.assignmentIssuedAt;
        const result = await runContextStorage.run({
          bus: createEventBus(), lineage: "main", assignmentMutations: options?.assignmentMutations,
          globalQuery: options?.globalQuery, assignmentIssuedAt: options?.assignmentIssuedAt,
        }, () => skills.loadApplication.load({ id: skillNameToId("外部能力接入"), operationId: "load-extension" }));
        loaded = result.body;
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "loaded" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage },
          newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "extension-skill");
      expectSettled(await projectSessionTurn({ manager, managed, text: "接入外部 APP", turnId: "load-extension", notify: () => {},
        runOptions: { source: "interactive", assignmentIssuedAt: "2000-01-01T00:00:00.000Z" } }));
      expect(loaded).toContain("extension");
      const assigned = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; dispatchRef: Parameters<typeof authority.artifacts.get>[0] })
        .find(record => record.t === "assigned")!;
      const envelope = JSON.parse(Buffer.from(await authority.artifacts.get(assigned.dispatchRef)).toString("utf8"));
      expect(issuedAt).toBe(envelope.issuedAt);
      expect(issuedAt).not.toBe("2000-01-01T00:00:00.000Z");
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, 30000);

  it("commits durable skill usage through the real Host publisher and replays the same submission once", async () => {
    const home = await createTempDir("host-skill-usage");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const context = () => ({ principal: { kind: "host" as const, component: "test" }, requestId: crypto.randomUUID(),
      authority: { domain: "global" as const, anchorEpoch: authority.anchorEpoch }, deadlineAt: new Date(Date.now() + 30000).toISOString() });
    const content = await authority.artifacts.put(Buffer.from("Host skill durable body"));
    await authority.globalState!.mutate({ kind: "skill-create", mode: "main", record: { name: "host-usage", description: "Host usage fixture", content } }, context());
    const coordinator = new GlobalMutationCommitCoordinator({ log: authority.authorityLog, artifacts: authority.artifacts,
      participants: authority.globalMutationParticipants, refreshSchedule: async () => {}, scheduleDefinitionFor: () => undefined });
    const publisher = new SchedulerConversationMutationPublisher({ anchorEpoch: authority.anchorEpoch, coordinator, sourceForAssignment: () => ({}) });
    const skills = createAssignmentSkillPorts(authority.artifacts, { admissionLlm: async () => { throw Error("not needed"); } });
    let loaded: string | undefined;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "host-usage",
      async *run(messages, options) {
        loaded = (await runContextStorage.run({ bus: createEventBus(), lineage: "main", assignmentMutations: options?.assignmentMutations,
          globalQuery: options?.globalQuery, assignmentIssuedAt: options?.assignmentIssuedAt },
        () => skills.loadApplication.load({ id: skillNameToId("host-usage"), operationId: "load-host-usage" }))).body;
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "loaded" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage }, newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    const unbind = protocol.bindMutationPublisher(publisher);
    const submit = vi.spyOn(ConversationRunJournal.prototype, "submitBundle");
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "host-usage");
      expectSettled(await projectSessionTurn({ manager, managed, text: "load", turnId: "host-usage-turn", notify: () => {}, runOptions: { source: "interactive" } }));
      expect(loaded).toBe("Host skill durable body");
      const read = () => authority.globalState!.read({ kind: "skill-get", skillId: skillNameToId("host-usage") }, context());
      expect(await read()).toMatchObject({ kind: "skill-get", entry: { contentRef: content, usage: { hitCount: 1 } } });
      const [bundle, call] = submit.mock.calls.at(-1)!;
      const before = (await authority.authorityLog.readAll()).length;
      const first = await submit.mock.results.at(-1)!.value;
      expect(await protocol.submissionMeshRole().submission.submitBundle(bundle, call)).toEqual(first);
      expect((await authority.authorityLog.readAll()).length).toBe(before);
      expect(await read()).toMatchObject({ kind: "skill-get", entry: { contentRef: content, usage: { hitCount: 1 } } });
    } finally { submit.mockRestore(); unbind(); await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, 30000);

  it.each(["preparing", "ready"] as const)("retains the original APP identity and return target for %s maintenance", async phase => {
    const home = await createTempDir("extension-return");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let manager!: ConversationManager;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "default",
      async *run() { throw new Error("admission-only fixture"); }, abort: () => false, async dispose() {} };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const admitted = vi.spyOn(protocol, "admit");
    try {
      await getOrCreateActiveConversation(authority, manager, "default");
      const continuation = createExtensionContinuation({ manager, communication: { invoke: async () => { throw new Error("not local"); } },
        deviceId: "device", fallbackConversation: async () => "default" });
      const target = { channelId: "app", to: "owner" };
      await continuation.notify({ id: "maintenance", instanceId: "app", revision: 4, phase, purpose: "update",
        source: { conversationId: "default", request: "更新 APP", returnAddress: { channel: "app", triggeredBy: "owner", target } } });
      const result = await admitted.mock.results[0]!.value;
      const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries).map(entry => entry.body as { t: string; runId: string; ingress?: unknown });
      const record = records.find(body => body.t === "admitted" && body.runId === result.runId);
      expect(record?.ingress).toMatchObject({ kind: "channel", replyTarget: target,
        responder: { channelId: "app", platformSubject: "owner" }, ingressId: "extension:maintenance:4" });
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, 30000);

  it.each(["failed", "cancelled"] as const)("settles extension preparation after its run is %s without a later user query", async ending => {
    const home = await createTempDir("extension-terminal");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot({ snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    let manager!: ConversationManager;
    let onboarding!: ExtensionOnboarding;
    const phases: string[] = [];
    const observer = createExtensionStatusObserver({ invoke: async request => ({ snapshot: await onboarding.manage(request), targetDeviceId: "device" }) });
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "prepare-scene",
      async *run() { throw new Error("fixture preparation provider failure"); }, abort: () => false, async dispose() {} };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(), onStatus: observer });
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const managed = await getOrCreateActiveConversation(authority, manager, "prepare-scene");
    const application = new ExtensionApplication({ log: () => authority.authorityLog, assertOwner() {} });
    const continuation = createExtensionContinuation({ manager, communication: { invoke: async () => { throw new Error("not local"); } }, deviceId: "device" });
    onboarding = new ExtensionOnboarding(application, new ExtensionArtifacts(resolve(home, "extensions/artifacts")), new ExtensionCandidates(resolve(home, "extensions/candidates")), {
      validate() {}, configuration: async () => undefined, discard: async () => {}, changed: async () => {},
      notify: async operation => { const receipt = await continuation.notify(operation); phases.push(operation.phase); return receipt; },
      preparationClosed: continuation.preparationClosed, isActive: () => true,
    });
    try {
      await onboarding.manage({ action: "prepare", id: "operation", instanceId: "app", source: { conversationId: "prepare-scene", request: "连接 APP" } });
      const operation = (await application.operation("operation"))!;
      const turnId = "extension:operation:1";
      if (ending === "cancelled") {
        const admitted = (await manager.findDurableRunByIngress("prepare-scene", turnId, "interactive"))!;
        await protocol.cancelAdmitted("prepare-scene", admitted.runId);
      } else {
        await projectSessionTurn({ manager, managed, text: extensionContinuationText(operation, "device"), turnId,
          runOptions: { source: "interactive", surfacePrincipal: "conversation:prepare-scene", turnContext: { turnId } }, notify: () => {} });
      }
      expect((await manager.findDurableRunByIngress("prepare-scene", turnId, "interactive"))?.state).toBe(ending);
      await expect.poll(() => phases, { timeout: 6000 }).toEqual(["preparing", "blocked"]);
      expect((await application.operation("operation"))?.phase).toBe("blocked");
      await expect.poll(async () => (await application.operation("operation"))?.notifiedRevision).toBe(2);
      expect(await manager.findDurableRunByIngress("prepare-scene", "extension:operation:2", "interactive")).toBeTruthy();
      await onboarding.reconcile();
      expect(phases).toEqual(["preparing", "blocked"]);
    } finally { await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, 45000);
});
