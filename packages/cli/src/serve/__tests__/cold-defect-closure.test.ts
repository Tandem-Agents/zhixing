import { createEventBus } from "@zhixing-ai/core";
import type { SchedulerEventMap } from "@zhixing-ai/core/scheduler";
import { type AgentYield, type RunResult } from "@zhixing-ai/core/loop";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  ConversationAssignmentLedger,
  DataPlaneTicketRegistry,
  InProcessAssignmentSubmission,
} from "@zhixing-ai/executor";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createExecutorJobOwner } from "../access-surfaces.js";
import { AnchorSchedulerRuntime } from "../anchor-scheduler-runtime.js";
import { JobRelayObligationDirectory } from "../channel-interaction-coordinator.js";
import {
  NO_REMOTE_CONVERSATION_EXECUTORS,
  createConversationExecutorHostBoundary,
} from "../conversation-executor-dispatch.js";
import { anchorConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import {
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";
import { createExecutorDataPlaneAssignmentPair } from "../executor-data-plane-runtime.js";
import { JobStatusDirectory } from "../job-status-directory.js";
import {
  MemorySecretStore,
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  getOrCreateActiveConversation,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

describe("Cold execution real defect closure (F1 / F2 / F3 / F4-1)", () => {
  it("F3: advances session.statusHistory cursor to consumed watermark on non-empty final pages and retains watermark on empty reads", async () => {
    const home = await createTempDir("f3-status-watermark");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    const interactions = new DurableConversationInteractionObserver();
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-f3",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        yield { type: "text_delta", text: "ok" };
        const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
        return {
          agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 1, outputTokens: 1 } },
          runRecord: { timestamp: "2026-11-16T00:00:00.000Z", messages: [messages.at(-1)!, assistant], usage: { inputTokens: 1, outputTokens: 1 } },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions });
    manager = new ConversationManager(factory, undefined, {
      loadHistory: async () => undefined,
      initTranscript: async () => {},
      appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "durable", appended: true }),
      durableTurnExecutor: protocol,
      onTurnCommitted: () => {},
    });
    try {
      const managed = await getOrCreateActiveConversation(authority, manager, "conv-f3");
      const gen = protocol.run({
        conversationId: managed.conversationId,
        input: "hello",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        baseRevision: 0,
        runtime,
        invocation: { kind: "agent", source: "interactive" },
        options: { turnContext: { turnId: "turn-f3-1" }, surfacePrincipal: "surface:local:first-party" },
      });
      let step = await gen.next();
      while (!step.done) step = await gen.next();
      const committed = await authority.authorityLog.readAll();
      const runId = committed
        .flatMap((env) => env.entries)
        .map((e) => e.body as { t?: string; runId?: string })
        .find((b) => b.t === "admitted" && b.runId)?.runId;
      expect(runId).toBeDefined();

      // 1. First query from afterStatusRevision = 0: non-empty final page (< 64 items: queued(1), dispatched(2), running(3), committed(4))
      const first = await protocol.statusHistory([
        { conversationId: managed.conversationId, runId: runId!, afterStatusRevision: 0 },
      ]);
      expect(first.notices.map((n) => n.state)).toEqual(["queued", "dispatched", "running"]);
      const lastDisplayableRevision = first.notices.at(-1)!.statusRevision;
      expect(lastDisplayableRevision).toBe(3);
      // Consumed watermark includes the filtered final `committed(4)` entry:
      expect(first.next).toEqual([
        {
          conversationId: managed.conversationId,
          runId: runId!,
          afterStatusRevision: 4,
        },
      ]);

      // 2. Subsequent query using returned `next` cursor: empty page, watermark retained without regression or duplicate replay
      const second = await protocol.statusHistory(first.next);
      expect(second.notices).toEqual([]);
      expect(second.next).toEqual(first.next);

      // 3. Non-displayable ("committed"-only) status page advances watermark from 3 -> 4 without empty-page loop:
      const committedOnlyPage = await protocol.statusHistory([
        { conversationId: managed.conversationId, runId: runId!, afterStatusRevision: 3 },
      ]);
      expect(committedOnlyPage.notices).toEqual([]);
      expect(committedOnlyPage.next).toEqual([
        { conversationId: managed.conversationId, runId: runId!, afterStatusRevision: 4 },
      ]);

      // 4. Unknown run empty page retains caller cursor without regression:
      const emptyUnknown = await protocol.statusHistory([
        { conversationId: managed.conversationId, runId: "run:non-existent", afterStatusRevision: 7 },
      ]);
      expect(emptyUnknown.notices).toEqual([]);
      expect(emptyUnknown.next).toEqual([
        { conversationId: managed.conversationId, runId: "run:non-existent", afterStatusRevision: 7 },
      ]);
    } finally {
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    }
  }, 60_000);

  it("F1 + F2 + F4-1: settles in-flight deleted jobs (including abort-then-delete and paused owner), prevents overlap backfill, and drains cleanly on stop", async () => {
    const home = await createTempDir("f1-f2-f4-scheduler-closure");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    await authority.executorLog.prepareProjections();
    const interactions = new DurableConversationInteractionObserver();
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions });
    manager = new ConversationManager(
      { create: async () => { throw new Error("unused"); } },
      undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );

    const { dataPlane, assignment: ledger } = createExecutorDataPlaneAssignmentPair(
      {
        zhixingHome: home,
        authority,
        module: {
          AssignmentStreamSpool,
          AssignmentStreamWriter,
          DataPlaneTicketRegistry,
        },
        clock: () => new Date().toISOString(),
      },
      (assembly) => {
        const boundary = createConversationExecutorHostBoundary({
          authority: anchorConversationOwnerRuntime(authority),
          directory: NO_REMOTE_CONVERSATION_EXECUTORS,
          clock: () => new Date().toISOString(),
          local: {
            ConversationAssignmentLedger,
            InProcessAssignmentSubmission,
            dataPlaneTickets: assembly.assignmentTickets,
            createStream: assembly.createStream,
            runtimeFactory: {
              create: async () => {
                throw new Error("unused");
              },
            },
          },
        });
        if (!boundary.localLedger) throw new Error("Local ledger is unavailable");
        return Object.freeze({
          assignment: boundary.localLedger,
          authority: boundary.localLedger,
        });
      },
    );

    const gates = new Map<string, () => void>();
    const startedMarkers = new Set<string>();
    const schedulerErrors: Error[] = [];
    let schedulerRuntime!: AnchorSchedulerRuntime;
    const jobStatus = new JobStatusDirectory();
    const jobRelays = new JobRelayObligationDirectory();

    const jobOwnerAssembly = await createExecutorJobOwner({
      authorityRuntime: authority,
      executorRoleModule: { InProcessAssignmentSubmission } as never,
      conversationExecutorLedger: ledger,
      executorDataPlane: dataPlane,
      jobRelayObligations: jobRelays,
      jobRuntime: {
        async create(input) {
          return {
            async *run(instruction, options) {
              startedMarkers.add(`${input.taskId}:${input.jobRunId}`);
              if (instruction.prompt.includes("HOLD:")) {
                const gateName = instruction.prompt.split("HOLD:")[1]!.trim();
                await new Promise<void>((resolve) => {
                  if (options.abortSignal.aborted) return resolve();
                  options.abortSignal.addEventListener("abort", () => resolve(), { once: true });
                  gates.set(gateName, resolve);
                });
                if (options.abortSignal.aborted) {
                  throw options.abortSignal.reason ?? new Error("aborted");
                }
              }
              yield { type: "text_delta", text: "job-done" };
              return {
                status: "completed" as const,
                summary: `done:${instruction.prompt}`,
                contentAssets: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
            async dispose() {},
          };
        },
      },
    });
    await jobOwnerAssembly.start();

    const eventBus = createEventBus<SchedulerEventMap>();
    schedulerRuntime = await AnchorSchedulerRuntime.create({
      authority,
      protocol,
      localExecutor: ledger,
      createLocalCancellationSubmission: (journal) => {
        const submission = new InProcessAssignmentSubmission({
          ledger,
          owner: journal,
        });
        return {
          submitCancellation: (assignmentId, ctx) =>
            submission.submitCancellation(assignmentId, ctx),
        };
      },
      localJobOwner: jobOwnerAssembly.owner,
      mesh: undefined,
      capabilities: () => ({ tools: [], mcpServers: [] }),
      systemHandlers: new Map(),
      systemTasks: new Map(),
      eventBus,
      jobStatus,
      jobRelays,
      openManualJobSurface: async () => ({ close: async () => {} }),
      onError: (err) => schedulerErrors.push(err),
    });
    const unbind = schedulerRuntime.bindGeneration();
    await authority.authorityLog.prepareProjections();
    await schedulerRuntime.start();
    const { product, globalState } = schedulerRuntime.createProductBoundary();
    const releaseGlobalState = authority.installSchedulerGlobalState(globalState);
    schedulerRuntime.activate();
    await schedulerRuntime.resumeManualSurfaces();

    try {
      // 1. F2 + F4-1a: In-flight schedule delete settles CancelProof to "cancelled" without AggregateError
      const delTask = await product.commitCreate({
        operation: { operationId: "create-del-1" },
        spec: {
          name: "del-in-flight",
          enabled: true,
          priority: "normal",
          schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
          action: { kind: "agent-turn", prompt: "HOLD:del-1" },
          delivery: { kind: "none" },
        },
      });
      const runningDel = product
        .run({ taskId: delTask.id, operation: { operationId: "run-del-1" } })
        .then((v) => ({ value: v }), (e: Error) => ({ error: e.message }));
      await vi.waitFor(
        () => {
          if (schedulerErrors.length > 0) throw schedulerErrors[0]!;
          expect(gates.has("del-1")).toBe(true);
        },
        { timeout: 10_000 },
      );

      // First delete MUST succeed cleanly (no AggregateError) and replay idempotently
      await expect(
        product.commitDelete({
          taskId: delTask.id,
          operation: {
            operationId: "delete-del-1",
            expectedRevision: delTask.taskRevision,
          },
        }),
      ).resolves.toBeUndefined();
      await expect(
        product.commitDelete({
          taskId: delTask.id,
          operation: {
            operationId: "delete-del-1",
            expectedRevision: delTask.taskRevision,
          },
        }),
      ).resolves.toBeUndefined();

      // Wait for cancelled manual run to settle all the way to terminal on owner!
      const delOutcome = await runningDel;
      expect(delOutcome).toEqual({
        value: expect.objectContaining({ status: "error" }),
      });
      await vi.waitFor(() => expect(schedulerRuntime.listInProcessWork()).toEqual([]), { timeout: 10_000 });
      expect(await schedulerRuntime.listAcceptedWork()).toEqual([]);

      // 2. F2 + F4-1b: Abort FIRST (creating earlier fence), THEN delete (must preserve earlier fence without conflict!)
      const abortThenDel = await product.commitCreate({
        operation: { operationId: "create-abort-del" },
        spec: {
          name: "abort-then-delete",
          enabled: true,
          priority: "normal",
          schedule: { kind: "once", at: new Date(Date.now() + 3_600_000).toISOString() },
          action: { kind: "agent-turn", prompt: "HOLD:abort-del" },
          delivery: { kind: "none" },
        },
      });
      const runningAbortDel = product
        .run({ taskId: abortThenDel.id, operation: { operationId: "run-abort-del" } })
        .then((v) => ({ value: v }), (e: Error) => ({ error: e.message }));
      await vi.waitFor(
        () => {
          if (schedulerErrors.length > 0) throw schedulerErrors[0]!;
          expect(gates.has("abort-del")).toBe(true);
        },
        { timeout: 10_000 },
      );
      const openBeforeAbort = await schedulerRuntime.listAcceptedWork();
      expect(openBeforeAbort).toHaveLength(1);
      await expect(
        product.abort({
          runId: openBeforeAbort[0]!.id,
          operation: { operationId: "abort-first-req" },
        }),
      ).resolves.toBe(true);
      await expect(
        product.commitDelete({
          taskId: abortThenDel.id,
          operation: {
            operationId: "delete-after-abort-req",
            expectedRevision: abortThenDel.taskRevision,
          },
        }),
      ).resolves.toBeUndefined();
      await runningAbortDel;
      await vi.waitFor(() => expect(schedulerRuntime.listInProcessWork()).toEqual([]), { timeout: 10_000 });

      // 3. F1: Online once due trigger while manual run is in-flight records missed and NEVER backfills
      const dueAt = new Date(Date.now() + 1_200).toISOString();
      const overlapTask = await product.commitCreate({
        operation: { operationId: "create-overlap-once" },
        spec: {
          name: "overlap-once",
          enabled: true,
          priority: "normal",
          schedule: { kind: "once", at: dueAt },
          action: { kind: "agent-turn", prompt: "HOLD:overlap-once" },
          delivery: { kind: "none" },
        },
      });
      const manualOverlap = product.run({
        taskId: overlapTask.id,
        operation: { operationId: "run-overlap-once" },
      });
      await vi.waitFor(
        () => {
          if (schedulerErrors.length > 0) throw schedulerErrors[0]!;
          expect(gates.has("overlap-once")).toBe(true);
        },
        { timeout: 10_000 },
      );
      // Hold across dueAt + 1.5s so scheduler tick fires while online and occupied
      await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(dueAt) - Date.now()) + 1_500));
      const duringOverlap = await product.find(overlapTask.id);
      expect(duringOverlap?.state.lastMissed?.scheduledFor).toBe(dueAt);

      gates.get("overlap-once")!();
      await expect(manualOverlap).resolves.toMatchObject({ status: "ok" });
      await new Promise((r) => setTimeout(r, 1_300));
      const afterOverlap = await product.find(overlapTask.id);
      expect(afterOverlap?.state.runCount).toBe(1);
      expect(
        [...startedMarkers].filter((m) => m.startsWith(`${overlapTask.id}:`)),
      ).toHaveLength(1);

      // 4. F4-1c: Paused admission (HostStop sequence: pauseAccepting + closeAdmission + reconcileExecutionTerminals + pauseAndSettle)
      jobOwnerAssembly.pauseAccepting();
      schedulerRuntime.closeAdmission();
      await jobOwnerAssembly.drain();
      await schedulerRuntime.reconcileExecutionTerminals();
      await schedulerRuntime.pauseAndSettle();
      expect(schedulerRuntime.listInProcessWork()).toEqual([]);
      expect(
        schedulerErrors.filter((e) => e.name !== "AuthorityPreparationRequired"),
      ).toEqual([]);
    } finally {
      for (const release of gates.values()) release();
      releaseGlobalState();
      unbind();
      await schedulerRuntime.stop();
      await jobOwnerAssembly.close();
      await dataPlane.close();
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    }
  }, 45_000);
});
