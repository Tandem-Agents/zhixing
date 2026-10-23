// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：recovery。
import { StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import type { ConversationStatusNotice } from "@zhixing/core/contracts";
import { userMessageFromTurnInput, type Message } from "@zhixing/core";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { ConversationRunJournal } from "@zhixing/owner-kernel/conversation-assignment";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { InProcessAssignmentSubmission } from "@zhixing/executor";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { TEST_DURABLE_IO_TIMEOUT_MS, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, getOrCreateActiveConversation, MemorySecretStore } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
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
      onTurnCommitted: () => {},
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
      onTurnCommitted: () => {},
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
    expect((await restartedProtocol.messageInputsOutsideHistory("conversation-started")).inputs).toContainEqual(expect.objectContaining({
      runId, state: "uncertain", message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }));
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
    // The journal already exists; subscriptions bound by Host composition must
    // still observe its subsequent terminal publication.
    const receivedStatuses: ConversationStatusNotice[] = [];
    const unsubscribe = protocol.onStatus((notice) => { receivedStatuses.push(notice); });
    const removedListener = vi.fn();
    protocol.onStatus(removedListener)();
    const finalityFactory = vi.fn();
    protocol.bindFirstPartyFinality(finalityFactory);
    expect(() => protocol.bindFirstPartyFinality(vi.fn())).toThrow("already bound");
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
    expect(receivedStatuses.some((notice) => notice.state === "cancelled")).toBe(true);
    expect(removedListener).not.toHaveBeenCalled();
    unsubscribe();
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
    expect(snapshotRead).not.toHaveBeenCalled();
    expect(history.notices.some((notice) => notice.state === "cancelled")).toBe(true);
    // Authenticated imported-prefix status/tail coverage lives in
    // owner-kernel conversation-base-integration.test.ts, using production transfer.
    expect(history.next).toEqual([{
      conversationId: "conversation-cancel",
      runId: admitted.runId,
      afterStatusRevision: 0,
    }]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("does not start a cancelled control after waiting for the terminal owner", async () => {
    const { runWithMaintenanceUrgency } = await import("@zhixing/core/resources");
    const home = await createTempDir("conversation-cancel-queue-signal");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    const protocol = createProtocol({ authority, manager: () => { throw Error("unused"); },
      interactions: new DurableConversationInteractionObserver() });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const descriptor = vi.spyOn(ConversationRunJournal.prototype, "runControlDescriptor").mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return undefined;
    });
    const input = { conversationId: "queued-control", runId: "run:missing", requestId: "cancel:first",
      principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } };
    const first = protocol.cancel(input);
    try {
      await entered.promise;
      const abort = new AbortController();
      const second = runWithMaintenanceUrgency(() => "foreground", abort.signal,
        () => protocol.cancel({ ...input, requestId: "cancel:queued" }));
      const rejected = expect(second).rejects.toThrow("cancelled");
      abort.abort(); release.resolve(); await first; await rejected;
      expect(descriptor).toHaveBeenCalledOnce();
    } finally { release.resolve(); await first; descriptor.mockRestore(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each(["success", "permanent-main", "permanent-cleanup"] as const)("preserves the $0 result across recovery-claim cleanup pressure", async fault => {
    const home = await createTempDir("conversation-cancel-cleanup-pressure");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let manager!: ConversationManager;
    const observed = vi.fn();
    const protocol = createProtocol({ authority, manager: () => manager,
      interactions: new DurableConversationInteractionObserver(), onFailure: observed });
    manager = new ConversationManager({ create: vi.fn(async () => { throw Error("unused"); }) }, undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} });
    const input = { conversationId: "cancel-cleanup", runId: "run:missing", requestId: "cancel:cleanup",
      principal: { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" } };
    await registerActiveConversation(authority, input.conversationId, new Date().toISOString());
    const permanent = new Error("verified control integrity failed");
    const pressure = new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
    const cleanupFailure = fault === "permanent-cleanup" ? permanent : pressure;
    const cleanup = vi.spyOn(ConversationRunJournal.prototype, "assignmentsAwaitingRecovery").mockRejectedValueOnce(cleanupFailure);
    const descriptor = vi.spyOn(ConversationRunJournal.prototype, "runControlDescriptor");
    if (fault === "permanent-main") descriptor.mockRejectedValueOnce(permanent);
    if (fault === "permanent-cleanup") descriptor.mockRejectedValueOnce(pressure);
    try {
      if (fault === "success") await expect(protocol.cancel(input)).resolves.toEqual({ dispositions: [] });
      else if (fault === "permanent-main") await expect(protocol.cancel(input)).rejects.toBe(permanent);
      else await expect(protocol.cancel(input)).rejects.toMatchObject({ errors: [pressure, permanent] });
      expect(descriptor).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledWith(cleanupFailure, { phase: "recovery", conversationId: input.conversationId });
      cleanup.mockRestore(); descriptor.mockRestore();
      await expect(protocol.cancel({ ...input, requestId: "cancel:after-cleanup" })).resolves.toEqual({ dispositions: [] });
    } finally { cleanup.mockRestore(); descriptor.mockRestore(); }
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it.each([
    { kind: "single", committed: false }, { kind: "single", committed: true },
    { kind: "batch", committed: false }, { kind: "batch", committed: true },
  ] as const)("retries $kind cancellation outside its queue after pressure (committed=$committed)", async ({ kind, committed }) => {
    const home = await createTempDir("conversation-cancel-capacity");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager,
      interactions: new DurableConversationInteractionObserver() });
    manager = new ConversationManager(
      { create: vi.fn(async () => { throw Error("queued input must not execute"); }) }, undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );
    const conversationId = "cancel-capacity";
    await registerActiveConversation(authority, conversationId, new Date().toISOString());
    const admit = (id: string) => protocol.admit({ conversationId, input: id,
      invocation: { kind: "agent", source: "interactive" },
      options: { source: "interactive", turnContext: { turnId: id } }, surfacePrincipal: "rpc:owner" });
    const admitted = await admit("before-cancel");
    const principal = { surfacePrincipal: "rpc:owner", deviceId: authority.deviceId, connectionId: "desktop" };
    const pressureReached = Promise.withResolvers<void>();
    let capacityAvailable = false, tried = false;
    const envelopes: unknown[] = [];
    const apply = ConversationRunJournal.prototype.applyControl;
    const spy = vi.spyOn(ConversationRunJournal.prototype, "applyControl").mockImplementation(async function (...args) {
      if (args[0].envelope.requestId !== "cancel:capacity") return apply.apply(this, args);
      envelopes.push(structuredClone(args[0].envelope));
      if (!tried) {
        tried = true;
        if (committed) await apply.apply(this, args);
        pressureReached.resolve();
      }
      if (!capacityAvailable) throw new StorageMaintenanceAdmissionError({
        kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 10,
      });
      return apply.apply(this, args);
    });
    try {
      const cancelling = protocol.cancel({ conversationId, requestId: "cancel:capacity", principal,
        ...(kind === "single" ? { runId: admitted.runId } : {}) });
      // Attach the failure handler while another command proves the serial owner is released.
      const settled = cancelling.then(value => ({ value }), error => ({ error }));
      await pressureReached.promise;
      await expect(protocol.cancel({ conversationId, requestId: "cancel:queue-probe", principal,
        runId: "run:not-present" })).resolves.toEqual({ dispositions: [] });
      // A new input after a durable batch decision must survive its exact replay.
      const later = committed && kind === "batch" ? await admit("after-cancel") : undefined;
      capacityAvailable = true;
      const result = await settled;
      if ("error" in result) throw result.error;
      expect(result.value.dispositions).toMatchObject([{ runId: admitted.runId, runState: "cancelled" }]);
      expect(envelopes.length).toBeGreaterThan(1);
      expect(envelopes.every(envelope => JSON.stringify(envelope) === JSON.stringify(envelopes[0]))).toBe(true);
      const records = (await authority.authorityLog.readAll()).flatMap(commit => commit.entries)
        .map(entry => entry.body as { t?: string; runId?: string; state?: string; requestId?: string });
      expect(records.filter(record => record.t === "state" && record.runId === admitted.runId && record.state === "cancelled")).toHaveLength(1);
      expect(records.filter(record => record.t === "received" && record.requestId === "cancel:capacity")).toHaveLength(1);
      if (later) expect(records.some(record => record.t === "state" && record.runId === later.runId && record.state === "cancelled")).toBe(false);
    } finally { capacityAvailable = true; spy.mockRestore(); }
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
      onTurnCommitted: () => {},
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
      onTurnCommitted: () => {},
    });
    const snapshotRead = vi.spyOn(restartedAuthority.authorityLog, "readSnapshot");
    const fullRead = vi.spyOn(restartedAuthority.authorityLog, "readAll");
    await restartedProtocol.recover();
    expect(snapshotRead).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
    // 续跑的输入重放复用恢复时已校验的快照，不再追加一次全量读取。
    await vi.waitFor(() => expect(executions).toBe(1), { timeout: 10_000 });
    expect(snapshotRead).not.toHaveBeenCalled();
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
      onTurnCommitted: () => {},
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
      onTurnCommitted: () => {},
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
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
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
});
