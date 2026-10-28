// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：execution。
import { StorageMaintenanceAdmissionError, isHoldingMaintenanceExclusion } from "@zhixing/core/resources";
import { FileArtifactStore } from "@zhixing/core/authority";
import { ConfirmationBroker } from "@zhixing/core/confirmation";
import { type Message } from "@zhixing/core";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { StreamDigestChain } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { ConversationRunJournal, ConversationPendingCancellationError } from "@zhixing/owner-kernel/conversation-assignment";
import { createInitialControlEnvelope, createConversationControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationAssignmentLedger, AssignmentStreamSpool, AssignmentStreamWriter } from "@zhixing/executor";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { resolve } from "node:path";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_ANCHOR_LOSSLESS_DATA_PLANE, TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, getOrCreateActiveConversation, expectSettled, MemorySecretStore } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
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
      onTurnCommitted: () => {},
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
      onTurnCommitted: () => {},
    });
    // A cold Host must restore resource evidence through the journal's own
    // replay contract; callers must not prewarm a projection to make it valid.
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

    // Input admission is also a full journal replay entry, independently of
    // startup recovery. Give it a fresh resource owner over the same history.
    const inputAuthority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    const coordinate = vi.fn(inputAuthority.resourceGovernor.coordinate.bind(inputAuthority.resourceGovernor));
    const recoveryResources = new Proxy(inputAuthority.resourceGovernor, { get(target, key) {
      if (key === "coordinate") return coordinate;
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const inputJournal = new ConversationRunJournal({
      conversationId: "conversation-1", ownerEpoch: inputAuthority.anchorEpoch,
      log: inputAuthority.authorityLog, artifacts: inputAuthority.artifacts,
      signer: inputAuthority.signer, verifier: inputAuthority.verifier,
      submission: { authenticate() {}, authorize() {} },
      authority: { decideAtPrefix() { throw new Error("admission must not commit a turn"); } },
      projection: { async project() { throw new Error("admission must not project a turn"); } },
      resources: recoveryResources,
    });
    // Preserve real governor checks across post-check pressure without folding
    // artifacts twice; scanner slices without checks do not synchronize it.
    const recoverySnapshot = await inputAuthority.authorityLog.readSnapshot();
    const artifactReads = vi.spyOn(inputAuthority.artifacts, 'get');
    const realCoordinate = inputAuthority.resourceGovernor.coordinate.bind(inputAuthority.resourceGovernor);
    let readsAfterFirstCheck = 0;
    coordinate.mockImplementationOnce(async operation => {
      await realCoordinate(operation);
      readsAfterFirstCheck = artifactReads.mock.calls.length;
      throw new StorageMaintenanceAdmissionError({kind: 'backpressured', blockedBy: 'probe-unavailable', retryAfterMs: 1});
    });
    await inputJournal.primeRecoverySnapshot(recoverySnapshot);
    expect(coordinate).toHaveBeenCalledTimes(2);
    expect(artifactReads.mock.calls.length).toBe(readsAfterFirstCheck);
    expect(inputJournal.hasRecoveredInputProjection).toBe(true);
    coordinate.mockClear(); artifactReads.mockRestore();
    const at = new Date().toISOString();
    const source = {
      principal: { surfacePrincipal: "rpc:owner", deviceId: inputAuthority.deviceId, connectionId: "cold-input" },
      ingress: { kind: "first-party" as const, surfacePrincipal: "rpc:owner", deviceId: inputAuthority.deviceId, ingressId: "cold-input", receivedAt: at, turnOrigin: { channel: "rpc", triggeredBy: "cold-input" } },
    };
    const input = { admission: inputAuthority.controlAdmission, source, runId: "cold-input-run",
      envelope: createInitialControlEnvelope({ requestId: "cold-input", source, at, body: {
        t: "input", conversationId: "conversation-1", ingress: { ingressId: "cold-input", source: "first-party" },
        input: { parts: [{ type: "text", text: "next" }] }, invocation: { kind: "agent", source: "interactive" }, ownerEpoch: inputAuthority.anchorEpoch,
      } }),
    };
    await expect(inputJournal.applyInputControl(input)).resolves.toMatchObject({ result: { status: "ok" } });
    await expect(inputJournal.currentState("cold-input-run")).resolves.toBe("queued");
    await expect(inputJournal.applyInputControl(input)).resolves.toMatchObject({ kind: "replayed" });
    expect(executions).toBe(1);
    await inputAuthority.startupCleanup.run();
    await restartedProtocol.stopRecoveryLoop(); await restartedManager.disposeAll();
    await restartedAuthority.startupCleanup.run();
    await protocol.stopRecoveryLoop(); await manager.disposeAll();
    await authority.startupCleanup.run();
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
      onTurnCommitted: () => {},
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

  it("stops the local kernel once cancellation is durable without waiting for the executor cancellation chain", async () => {
    const home = await createTempDir("conversation-local-stop");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const started = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const projection: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "local-stop",
      async *run() { throw new Error("projection runtime must not execute"); }, abort: vi.fn(() => false), async dispose() {} };
    const execution: SessionRuntime = { ...projection, abort: vi.fn(() => true),
      async *run(messages, options) {
        const signal = options!.abortSignal!;
        started.resolve();
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve();
        return { agentResult: { reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!], usage: { inputTokens: 0, outputTokens: 0 } }, newMessages: [], durationMs: 1 };
      } };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => execution } } });
    manager = new ConversationManager({ create: async () => projection }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    // 执行器侧的取消开始被阻塞：本机止损不能依赖它。
    const originalBegin = ConversationAssignmentLedger.prototype.beginOwnerCancellation;
    const begin = vi.spyOn(ConversationAssignmentLedger.prototype, "beginOwnerCancellation").mockImplementation(async function (...args) {
      await gate.promise;
      return originalBegin.apply(this, args);
    });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "local-stop");
      const running = projectSessionTurn({ manager, managed, text: "stop me", turnId: "local-stop", notify: () => {},
        runOptions: { source: "interactive", surfacePrincipal: "rpc:owner", turnContext: { turnId: "local-stop" } } });
      await started.promise;
      const runId = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; runId?: string }).find(body => body.t === "admitted")!.runId!;
      const cancelling = protocol.cancel({ conversationId: "local-stop", runId, requestId: "cancel:local-stop",
        principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "test" } });
      const stoppedBeforeExecutorCancellation = await Promise.race([
        aborted.promise.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3_000)),
      ]);
      expect(stoppedBeforeExecutorCancellation).toBe(true);
      expect(execution.abort).toHaveBeenCalledOnce();
      gate.resolve();
      await cancelling;
      await running;
      const status = () => protocol.statusHistory([{ conversationId: "local-stop", runId, afterStatusRevision: 0 }]);
      await vi.waitFor(async () => expect((await status()).notices.at(-1)?.state).toBe("cancelled"), { timeout: 10_000 });
      expect((await status()).notices.some(notice => notice.state === "uncertain")).toBe(false);
    } finally {
      gate.resolve();
      begin.mockRestore();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["absent", "available"] as const)("drains the $0 first-party stream boundary after durable cancellation", async topology => {
    const home = await createTempDir("conversation-cancel-stream-tail");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const reached = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
    const tail = Promise.withResolvers<void>();
    const close = vi.fn(async () => {});
    const waitForSeq = vi.fn(async (_seq: number, signal?: AbortSignal) => {
      expect(signal).toBeDefined();
      await tail.promise;
    });
    const streamEnd = vi.fn();
    const spool = new AssignmentStreamSpool(resolve(home, "tail-spool"), new FileArtifactStore(resolve(home, "tail-artifacts")));
    onTestFinished(() => spool.stopStorageMaintenance());
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "cancel-stream",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        yield { type: "text_delta", text: "verified prefix" };
        reached.resolve(); await stopped.promise;
        throw Object.assign(new Error("cancelled test execution"), { name: "AbortError" });
      },
      abort: () => { stopped.resolve(); return true; }, async dispose() {} };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      onFirstPartyFrame: async () => {}, onFirstPartyStreamEnd: streamEnd,
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => runtime },
        createStream: input => AssignmentStreamWriter.open(spool, input.assignmentId, input.ref) },
      losslessDataPlane: topology === "absent" ? { kind: "absent", reason: "executor-only" } : { kind: "available", port: {
        ...TEST_ANCHOR_LOSSLESS_DATA_PLANE.port,
        openFirstPartySurfaceSession: async () => ({
          ...await TEST_ANCHOR_LOSSLESS_DATA_PLANE.port.openFirstPartySurfaceSession(), waitForSeq, close,
        }),
      } },
    });
    manager = new ConversationManager({ create: async () => runtime }, undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const conversationId = "cancel-stream";
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const input = { conversationId, input: "stream then cancel",
      invocation: { kind: "agent", source: "interactive" } as const,
      options: { source: "interactive" as const, turnContext: { turnId: "stream-cancel" } }, surfacePrincipal: "rpc:owner" };
    const admitted = await protocol.admit(input);
    const applyLocal = vi.spyOn(manager, "applyDurableCancellation");
    if (topology === "available") applyLocal.mockReturnValueOnce({ abortedInFlight: true, cancelledPending: 2 });
    const pending = ConversationRunJournal.prototype.pendingCancellations;
    let continuationPressured = false;
    const pendingSpy = vi.spyOn(ConversationRunJournal.prototype, "pendingCancellations").mockImplementation(async function (...args) {
      if (topology === "available" && applyLocal.mock.calls.length > 0 && !continuationPressured) {
        continuationPressured = true;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      }
      return pending.apply(this, args);
    });
    onTestFinished(() => { applyLocal.mockRestore(); pendingSpy.mockRestore(); });
    const generator = protocol.run({ ...input, messages: [], baseRevision: 0, runtime });
    const running = (async () => { try { for await (const _ of generator) {} } catch (error) { return error; } })();
    try {
      await Promise.race([reached.promise, running.then(error => { throw error ?? Error("execution ended before the first frame"); })]);
      const cancellation = await protocol.cancel({ conversationId, runId: admitted.runId, requestId: "cancel:stream-tail",
        principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } });
      stopped.resolve(); await running;
      if (topology === "absent") {
        expect(streamEnd).toHaveBeenCalledWith(expect.objectContaining({ conversationId, runId: admitted.runId, finalSeq: expect.any(Number) }));
      } else {
        expect(continuationPressured).toBe(true);
        expect(applyLocal).toHaveBeenCalledOnce();
        expect(cancellation.dispositions).toMatchObject([{ abortedInFlight: true, cancelledPending: 2 }]);
        expect(waitForSeq).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        tail.resolve(); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      }
    } finally { stopped.resolve(); tail.resolve(); await running; await generator.return(undefined as never); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  function cancellableStreamFixture(name: string) {
    const reached = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
    const tail = Promise.withResolvers<void>();
    const close = vi.fn(async () => {});
    const waitForSeq = vi.fn(async () => { await tail.promise; });
    const streamEnd = vi.fn();
    let kernelRuns = 0;
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: name,
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        kernelRuns += 1;
        yield { type: "text_delta", text: "verified prefix" };
        reached.resolve(); await stopped.promise;
        throw Object.assign(new Error("cancelled test execution"), { name: "AbortError" });
      },
      // The kernel keeps running after the cancel request; the test decides when it stops.
      abort: () => true, async dispose() {} };
    return { reached, stopped, tail, close, waitForSeq, streamEnd, runtime, kernelRuns: () => kernelRuns };
  }

  async function startCancellableRun(topology: "absent" | "available", name: string,
    onFailure?: (error: unknown) => void) {
    const home = await createTempDir(name);
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const f = cancellableStreamFixture(name);
    const spool = new AssignmentStreamSpool(resolve(home, "tail-spool"), new FileArtifactStore(resolve(home, "tail-artifacts")));
    onTestFinished(() => spool.stopStorageMaintenance());
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager,
      interactions: new DurableConversationInteractionObserver(), ...(onFailure ? { onFailure } : {}),
      onFirstPartyFrame: async () => {}, onFirstPartyStreamEnd: f.streamEnd,
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => f.runtime },
        createStream: input => AssignmentStreamWriter.open(spool, input.assignmentId, input.ref) },
      losslessDataPlane: topology === "absent" ? { kind: "absent", reason: "executor-only" } : { kind: "available", port: {
        ...TEST_ANCHOR_LOSSLESS_DATA_PLANE.port,
        openFirstPartySurfaceSession: async () => ({
          ...await TEST_ANCHOR_LOSSLESS_DATA_PLANE.port.openFirstPartySurfaceSession(), waitForSeq: f.waitForSeq, close: f.close,
        }),
      } },
    });
    manager = new ConversationManager({ create: async () => f.runtime }, undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const conversationId = name;
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const input = { conversationId, input: "stream then cancel",
      invocation: { kind: "agent", source: "interactive" } as const,
      options: { source: "interactive" as const, turnContext: { turnId: `${name}-turn` } }, surfacePrincipal: "rpc:owner" };
    const admitted = await protocol.admit(input);
    // Local abort is acknowledged without stopping the kernel, so the run is still
    // inside its frame when cancellation returns: the window E33 is about.
    const applyLocal = vi.spyOn(manager, "applyDurableCancellation").mockReturnValue({ abortedInFlight: true, cancelledPending: 0 });
    onTestFinished(() => applyLocal.mockRestore());
    const generator = protocol.run({ ...input, messages: [], baseRevision: 0, runtime: f.runtime });
    const running = (async () => { try { for await (const _ of generator) {} return undefined; } catch (error) { return error; } })();
    await Promise.race([f.reached.promise, running.then(error => { throw error ?? Error("execution ended before the first frame"); })]);
    const cancel = () => protocol.cancel({ conversationId, runId: admitted.runId, requestId: `cancel:${name}`,
      principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } });
    const records = async () => (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
      .map(entry => entry.body as { t?: string; state?: string });
    const finish = async () => { f.stopped.resolve(); f.tail.resolve(); await running; await generator.return(undefined as never); };
    return { ...f, protocol, authority, admitted, running, cancel, records, finish };
  }

  it.each(["absent", "available"] as const)("retries one settlement backpressure after cancellation and still drains the $0 stream tail", async topology => {
    const run = await startCancellableRun(topology, `cancel-settle-pressure-${topology}`);
    const runState = ConversationRunJournal.prototype.runState;
    let armed = false, pressured = 0;
    const stateSpy = vi.spyOn(ConversationRunJournal.prototype, "runState").mockImplementation(async function (...args) {
      if (armed && pressured === 0) {
        pressured += 1;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      }
      return runState.apply(this, args);
    });
    onTestFinished(() => stateSpy.mockRestore());
    try {
      await run.cancel();
      // The kernel stops only now, so the injected pressure hits the run's own settlement.
      armed = true; run.stopped.resolve();
      const outcome = await run.running;
      expect(pressured).toBe(1);
      expect(String(outcome ?? "")).not.toMatch(/backpressure|settlement failed|maintenance/i);
      expect(run.kernelRuns()).toBe(1);
      if (topology === "absent") {
        expect(run.streamEnd).toHaveBeenCalledWith(expect.objectContaining({ runId: run.admitted.runId, finalSeq: expect.any(Number) }));
      } else {
        await vi.waitFor(() => expect(run.waitForSeq).toHaveBeenCalledOnce());
        expect(run.close).not.toHaveBeenCalled();
        run.tail.resolve(); await vi.waitFor(() => expect(run.close).toHaveBeenCalledOnce());
      }
      expect((await run.records()).some(record => record.t === "state" && record.state === "cancelled")).toBe(true);
    } finally { await run.finish(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["absent", "available"] as const)("does not report a user cancellation as the $0 conversation failure cause", async topology => {
    const failures: unknown[] = [];
    const run = await startCancellableRun(topology, `cancel-not-failure-${topology}`, error => { failures.push(error); });
    try {
      await run.cancel();
      // 取消已耐久后执行体才以 AbortError 结束：这是用户中止，不是会话执行失败的首因
      run.stopped.resolve();
      await run.running;
      run.tail.resolve();
      await vi.waitFor(async () => expect((await run.records()).some(record => record.t === "state" && record.state === "cancelled")).toBe(true));
      expect(failures.filter(error => (error as Error).name === "AbortError")).toEqual([]);
    } finally { await run.finish(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("still reports an abort that no cancellation requested", async () => {
    const failures: unknown[] = [];
    const run = await startCancellableRun("absent", "abort-without-cancel", error => { failures.push(error); });
    try {
      // 没有取消请求时执行体以 AbortError 结束（例如宿主停止），仍是需要排查的首因
      run.stopped.resolve();
      await run.running;
      await vi.waitFor(() => expect(failures.some(error => (error as Error).name === "AbortError")).toBe(true));
    } finally { await run.finish(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("re-derives an expired resource candidate before execution without preparing a second runtime", async () => {
    const { AnchorResourceGovernor, ResourceCandidateStaleError } = await import("@zhixing/owner-kernel/resource-governor");
    const activate = AnchorResourceGovernor.prototype.prepareActivation;
    let rejected = false;
    const spy = vi.spyOn(AnchorResourceGovernor.prototype, "prepareActivation").mockImplementation(function (lease) {
      if (!rejected) { rejected = true; throw new ResourceCandidateStaleError(lease.reservationId, "expired"); }
      return activate.call(this, lease);
    });
    try {
      const run = await startCancellableRun("absent", "expired-resource-candidate");
      try {
        expect(rejected).toBe(true);
        expect(run.kernelRuns()).toBe(1);
        await run.cancel();
      } finally { await run.finish(); }
    } finally { spy.mockRestore(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("does not assign when a received cancellation arrives during runtime preparation", async () => {
    const home = await createTempDir("cancellation-dispatch-fence");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const f = cancellableStreamFixture("dispatch-fence");
    let manager!: ConversationManager, runId = "";
    const conversationId = "dispatch-fence";
    const source = { principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } };
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      localExecutor: { ...TEST_LOCAL_EXECUTOR, runtimeFactory: { create: async () => {
        const envelope = createConversationControlEnvelope({ requestId: "cancel:dispatch-fence", source,
          body: { t: "cancel", conversationId, runId, ownerEpoch: 1 } });
        await expect(authority.controlAdmission.applyAuthority({ envelope, source, stream: `run:${conversationId}`,
          initial: null, reducer: () => null, decide: () => { throw Error("received-only"); } })).rejects.toThrow("received-only");
        return f.runtime;
      } } } });
    manager = new ConversationManager({ create: async () => f.runtime }, undefined, { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const input = { conversationId, input: "queued", invocation: { kind: "agent", source: "interactive" } as const,
      options: { source: "interactive" as const, turnContext: { turnId: "dispatch-fence-turn" } }, surfacePrincipal: "rpc:owner" };
    runId = (await protocol.admit(input)).runId;
    const generator = protocol.run({ ...input, messages: [], baseRevision: 0, runtime: f.runtime });
    try {
      await expect(generator.next()).rejects.toBeInstanceOf(ConversationPendingCancellationError);
      expect(f.kernelRuns()).toBe(0);
      const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries);
      expect(records.some(entry => (entry.body as { t?: string; runId?: string }).t === "assigned" &&
        (entry.body as { runId?: string }).runId === runId)).toBe(false);
      await protocol.recover();
      expect((await authority.controlAdmission.pendingCancellations(undefined, { conversationId, runId })).envelopes).toEqual([]);
    } finally { f.stopped.resolve(); f.tail.resolve(); await generator.return(undefined as never); await protocol.stopRecoveryLoop(); await manager.disposeAll(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["absent", "available"] as const)("keeps recovery off a cancelled $0 run until its local execution leaves the frame", async topology => {
    const run = await startCancellableRun(topology, `cancel-recovery-interleave-${topology}`);
    const uncertain = vi.spyOn(ConversationRunJournal.prototype, "markAssignmentUncertain");
    onTestFinished(() => uncertain.mockRestore());
    try {
      await run.cancel();
      // Deterministic interleave: the recovery scan runs after cancellation cleared
      // the scheduler claims but while the kernel is still inside the run.
      await run.protocol.recover();
      expect(uncertain).not.toHaveBeenCalled();
      expect(run.kernelRuns()).toBe(1);
      run.stopped.resolve();
      await run.running;
      await run.protocol.recover();
      expect(uncertain).not.toHaveBeenCalled();
      expect(run.kernelRuns()).toBe(1);
      expect((await run.records()).some(record => record.t === "state" && record.state === "cancelled")).toBe(true);
    } finally { await run.finish(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["retirement", "usage", "sealed"] as const)("keeps a completed run through transient %s pressure without repeating the model", async phase => {
    const home = await createTempDir("conversation-retire-pressure");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-retire-pressure",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
        return {
          agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } },
          runRecord: { timestamp: "2026-09-24T00:00:00.000Z", messages: [messages.at(-1)!, assistant], usage: { inputTokens: 1, outputTokens: 1 } },
          newMessages: [assistant], durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const failures: unknown[] = [];
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      onFailure: error => { failures.push(error); } });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "durable", appended: true }),
    });
    const conversationId = "conversation-retire-pressure";
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const awaiting = ConversationRunJournal.prototype.assignmentsAwaitingRecovery;
    const finalize = authority.executorResourceGovernor.flushAssignment.bind(authority.executorResourceGovernor);
    const seal = ConversationAssignmentLedger.prototype.sealConversationBundle;
    let pressured = 0;
    const spy = phase === "retirement" ? vi.spyOn(ConversationRunJournal.prototype, "assignmentsAwaitingRecovery").mockImplementation(async function (...args) {
      const committed = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .some(entry => (entry.body as { t?: string }).t === "committed");
      if (executions > 0 && committed && pressured === 0) {
        pressured += 1;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      }
      return awaiting.apply(this, args);
    }) : phase === "usage" ? vi.spyOn(authority.executorResourceGovernor, "flushAssignment").mockImplementation(async (...args) => {
      if (executions > 0 && pressured === 0) {
        pressured += 1;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      }
      return finalize(...args);
    }) : vi.spyOn(ConversationAssignmentLedger.prototype, "sealConversationBundle").mockImplementation(async function (...args) {
      const bundle = await seal.apply(this, args);
      if (pressured === 0) {
        pressured += 1;
        throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      }
      return bundle;
    });
    try {
      const execution = protocol.run({ conversationId, input: "check", messages: [{ role: "user", content: [{ type: "text", text: "check" }] }], baseRevision: 0,
        runtime, invocation: { kind: "agent", source: "interactive" }, options: { turnContext: { turnId: "rpc:retire-pressure" }, source: "interactive" } });
      let step = await execution.next();
      while (!step.done) step = await execution.next();
      expect(step.value.agentResult.reason).toBe("completed");
    } finally { spy.mockRestore(); }
    expect(pressured).toBe(1);
    expect(failures.some(error => error instanceof StorageMaintenanceAdmissionError)).toBe(phase === "retirement");
    // The retained route is retired by the next recovery pass instead of being lost.
    await protocol.recover();
    expect(executions).toBe(1);
    const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries);
    expect(records.some(entry => (entry.body as { state?: string }).state === "uncertain")).toBe(false);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("releases the execution plan when an earlier session close fails and keeps the run's first error", async () => {
    const home = await createTempDir("conversation-cleanup-close-failure");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let disposed = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-cleanup-close-failure",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("model failed");
      },
      abort: () => false,
      async dispose() { disposed += 1; },
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver(),
      losslessDataPlane: { kind: "available", port: {
        ...TEST_ANCHOR_LOSSLESS_DATA_PLANE.port,
        openFirstPartySurfaceSession: async () => ({
          ...await TEST_ANCHOR_LOSSLESS_DATA_PLANE.port.openFirstPartySurfaceSession(),
          close: async () => { throw new Error("surface close failed"); },
        }),
      } } });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
    });
    const conversationId = "conversation-cleanup-close-failure";
    await getOrCreateActiveConversation(authority, manager, conversationId);
    // An open side effect leaves the run uncertain without a stream final, so the
    // surface remains for the generic release path instead of the tail drain.
    const openEffects = vi.spyOn(ConversationAssignmentLedger.prototype, "hasOpenSideEffects").mockResolvedValue(true);
    const execution = protocol.run({ conversationId, input: "check", messages: [{ role: "user", content: [{ type: "text", text: "check" }] }], baseRevision: 0,
      runtime, invocation: { kind: "agent", source: "interactive" }, options: { turnContext: { turnId: "rpc:cleanup-close-failure" }, source: "interactive" } });
    const failure = await (async () => {
      try { let step = await execution.next(); while (!step.done) step = await execution.next(); }
      catch (error) { return error; }
      finally { openEffects.mockRestore(); }
    })();
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors.map(error => (error as Error).message);
    expect(errors[0]).toContain("model failed");
    expect(errors).toContain("surface close failed");
    expect(disposed).toBe(1);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
  it("closes the executor iterator and control heartbeat before releasing a returned run", async () => {
    const home = await createTempDir("conversation-protocol-return-cleanup");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let closed = false;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-return-cleanup",
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        try {
          yield { type: "text_delta", text: "in-flight" };
          throw new Error("returned execution must not continue");
        } finally { closed = true; }
      },
      abort: () => false,
      async dispose() { expect(closed).toBe(true); },
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
    });
    await getOrCreateActiveConversation(authority, manager, "conversation-return-cleanup");
    // 持有文件锁期间创建的是写者锁心跳，归提交日志而非本次运行：日志空闲片刻后才放锁。
    const lockHeartbeats = new Set<unknown>();
    const createInterval = globalThis.setInterval;
    const intervals = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = createInterval(...args);
      if (isHoldingMaintenanceExclusion()) lockHeartbeats.add(timer);
      return timer;
    }) as typeof setInterval);
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const generator = protocol.run({ conversationId: "conversation-return-cleanup", input: "check", messages: [], baseRevision: 0,
      runtime, invocation: { kind: "agent", source: "interactive" },
      options: { turnContext: { turnId: "rpc:return-cleanup" }, source: "interactive" } });
    try {
      expect((await generator.next()).done).toBe(false);
      const timers = intervals.mock.results.filter(result => result.type === "return").map(result => result.value);
      const owned = timers.filter(timer => !lockHeartbeats.has(timer));
      expect(owned.length).toBeGreaterThan(0);
      await generator.return(undefined as never);
      expect(closed).toBe(true);
      for (const timer of owned) expect(cleared).toHaveBeenCalledWith(timer);
      // 写者锁的心跳随锁释放而清理，不会残留。
      await vi.waitFor(() => { for (const timer of timers) expect(cleared).toHaveBeenCalledWith(timer); }, { timeout: 5_000 });
    } finally {
      await generator.return(undefined as never).catch(() => undefined);
      for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
      intervals.mockRestore(); cleared.mockRestore();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["invalid-transcript", "lost-seal-ack"] as const)("settles completion failures without replaying execution: %s", async (fault) => {
    const home = await createTempDir("conversation-completion-failure");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-completion-failure",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
        return {
          agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } },
          runRecord: { timestamp: "2026-09-24T00:00:00.000Z", messages: [messages.at(-1)!, assistant], usage: { inputTokens: 1, outputTokens: 1 },
            ...(fault === "invalid-transcript" ? { perspectives: undefined } : {}) },
          newMessages: [assistant], durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager({ create: async () => runtime }, undefined, {
      durableTurnExecutor: protocol, onTurnCommitted: () => {},
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "durable", appended: true }),
    });
    const conversationId = "conversation-completion-failure";
    await getOrCreateActiveConversation(authority, manager, conversationId);
    const originalSeal = ConversationAssignmentLedger.prototype.sealConversationBundle;
    const lostAck = fault === "lost-seal-ack" ? vi.spyOn(ConversationAssignmentLedger.prototype, "sealConversationBundle")
      .mockImplementationOnce(async function (...args) {
        await originalSeal.apply(this, args);
        throw new Error("seal acknowledgement lost");
      }) : undefined;
    try {
      const execution = protocol.run({ conversationId, input: "check", messages: [{ role: "user", content: [{ type: "text", text: "check" }] }], baseRevision: 0,
        runtime, invocation: { kind: "agent", source: "interactive" }, options: { turnContext: { turnId: "rpc:completion-failure" }, source: "interactive" } });
      await expect(execution.next()).rejects.toThrow(fault === "invalid-transcript" ? "canonical JSON" : "seal acknowledgement lost");
    } finally { lostAck?.mockRestore(); }
    await protocol.recover();
    const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries).map(entry => entry.body as { t?: string; state?: string });
    expect(records.some(record => record.t === "state" && record.state === "failed")).toBe(fault === "invalid-transcript");
    expect(records.some(record => record.t === "committed")).toBe(fault === "lost-seal-ack");
    expect(executions).toBe(1);
    const next = await protocol.admit({ conversationId, input: "next", invocation: { kind: "agent", source: "interactive" },
      options: { turnContext: { turnId: "rpc:after-completion-failure" }, source: "interactive" }, surfacePrincipal: "rpc:owner" });
    expect(next.shouldSchedule).toBe(true);
    await protocol.cancelAdmitted(conversationId, next.runId);
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
