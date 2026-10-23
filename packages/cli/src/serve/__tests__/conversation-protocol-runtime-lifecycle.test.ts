// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：lifecycle。
import { userMessageFromTurnInput, type Message } from "@zhixing/core";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { protocolDigest } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, getOrCreateActiveConversation, MemorySecretStore, seedPendingConversation } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
  it.each([true, false])("prepares control admission before readiness without whole-log first-send reads (resumed: %s)", async (resumed) => {
    const home = await createTempDir("conversation-protocol-control-warmup");
    const secretStore = new MemorySecretStore();
    const conversationId = `conversation-control-warmup-${resumed}`;
    const runtimeFactory = { create: vi.fn(async () => { throw new Error("runtime must not be created"); }) };
    const first = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    await registerActiveConversation(first, conversationId, new Date().toISOString());
    // 重启：新的进程内状态，控制准入尚无基线。
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager(runtimeFactory, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    try {
      // 入口真正就绪时即有控制准入基线，不能把必需准备延后到首发。
      await protocol.recoverReadinessProjections();
      expect(authority.controlAdmission.hasRecoveredProjection).toBe(true);
      if (resumed) {
        await protocol.recoverConversation(conversationId);
      }
      expect(authority.controlAdmission.hasRecoveredProjection).toBe(true);
      const snapshots = vi.spyOn(authority.authorityLog, "readSnapshot");
      const admission = await protocol.admit({
        conversationId, input: "first send after resume", invocation: { kind: "agent", source: "interactive" },
        options: { source: "interactive", turnContext: { turnId: `rpc:control-warmup-${resumed}` } }, surfacePrincipal: "rpc:owner",
      });
      expect(admission.shouldSchedule).toBe(true);
      expect(snapshots).not.toHaveBeenCalled();
      snapshots.mockRestore();
    } finally {
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    }
  }, 30000);

  it("recovers first lookup pressure before admitting the exact same input", async () => {
    const home = await createTempDir("conversation-protocol-admission-lookup-pressure");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const resources = await import("@zhixing/core/resources");
    const apply = vi.spyOn(authority.controlAdmission, "lookup").mockImplementationOnce(async () => {
      expect(resources.isHoldingMaintenanceExclusion()).toBe(false);
      throw new resources.StorageMaintenanceAdmissionError({kind:"backpressured",blockedBy:"probe-unavailable",retryAfterMs:1});
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );
    try {
      await registerActiveConversation(
        authority,
        "conversation-admission-lookup-pressure",
        new Date().toISOString(),
      );
      const admission = await protocol.admit({
        conversationId: "conversation-admission-lookup-pressure",
        input: "recover the response",
        invocation: { kind: "agent", source: "interactive" },
        options: {
          source: "interactive",
          turnContext: { turnId: "rpc:admission-lookup-pressure" },
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

  it("recovers control pressure while establishing the input session identity", async () => {
    const home = await createTempDir("conversation-protocol-admission-identity-pressure");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const resources = await import("@zhixing/core/resources");
    const apply = vi.spyOn(authority.controlAdmission, "apply").mockImplementationOnce(async () => {
      expect(resources.isHoldingMaintenanceExclusion()).toBe(false);
      throw new resources.StorageMaintenanceAdmissionError({kind:"backpressured",blockedBy:"probe-unavailable",retryAfterMs:1});
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );
    try {
      const admission = await protocol.admit({
        conversationId: "conversation-admission-identity-pressure",
        input: "recover the response",
        invocation: { kind: "agent", source: "interactive" },
        options: {
          source: "interactive",
          turnContext: { turnId: "rpc:admission-identity-pressure" },
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
      onTurnCommitted: () => {},
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
      onTurnCommitted: () => {},
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: restartedProtocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: writer, onTurnCommitted: () => {} },
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
        onTurnCommitted: () => {},
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
