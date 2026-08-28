import { localConversationId } from "@zhixing/core";
import { DeferredGlobalIntentRepository } from "@zhixing/owner-kernel";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime } from "../conversation-protocol-runtime.js";
import type { LocalConversationOwnerPort } from "../local-conversation-owner.js";
import {
  createLocalOwnerAssemblyFixture,
  type LocalOwnerAssemblyFixture,
} from "./local-owner-assembly-fixture.js";

const LIFECYCLE_TIMEOUT_MS = 60_000;

describe("closed lifecycle startup", () => {
  it("defers readiness and accepted-work recovery until the exact lifecycle resumes", async () => {
    const readiness = vi.spyOn(
      ConversationProtocolRuntime.prototype,
      "recoverReadinessProjections",
    );
    const intents = vi.spyOn(DeferredGlobalIntentRepository.prototype, "recover");
    const accepted = vi.spyOn(ConversationProtocolRuntime.prototype, "recover");
    const fixture = await createLocalOwnerAssemblyFixture({ profile: "executor-only" });
    try {
      await fixture.assembly.start({
        lifecycle: {
          operationId: "stop-closed-startup",
          kind: "stop",
          recoverAcceptedWork: false,
        },
      });
      expect(intents).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();

      await fixture.assembly.recoverAcceptedWorkForLifecycle();
      expect(intents).toHaveBeenCalledTimes(1);
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.assembly.close();
      intents.mockRestore();
      readiness.mockRestore();
      accepted.mockRestore();
    }
  }, LIFECYCLE_TIMEOUT_MS);
});

function hostContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "local-owner-lifecycle" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function expectWritesFenced(
  port: LocalConversationOwnerPort,
  conversationId: string,
): Promise<void> {
  await expect(port.createConversation()).rejects.toThrow(/not ready/);
  await expect(port.ensureSession(conversationId)).rejects.toThrow(/not ready/);
  await expect(
    port.mutateSession(
      conversationId,
      { kind: "session-meta", patch: { name: "fenced" } },
      hostContext("fence-meta"),
    ),
  ).rejects.toThrow(/not ready/);
  await expect(
    port.runTurn({ conversationId, text: "fenced", turnId: "fence-turn" }),
  ).rejects.toThrow(/not ready/);
  await expect(
    port.cancelTurns({ conversationId, requestId: "fence-cancel" }),
  ).rejects.toThrow(/not ready/);
  await expect(
    port.answerInteractionWithTicket({
      assignmentId: "asg-fence",
      requestId: "req-fence",
      ticketId: "tkt-fence",
      surfacePrincipal: "surface-fence",
      decision: { kind: "deny" },
    }),
  ).rejects.toThrow(/not ready/);
  await expect(
    port.resolveNoInteractiveSurface({
      assignmentId: "asg-fence",
      requestId: "req-fence",
    }),
  ).rejects.toThrow(/not ready/);
}

describe("local conversation owner lifecycle", () => {
  it(
    "freezes one exact device-removal operation and restores admission only for its authenticated release",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({ profile: "anchor-executor" });
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      await fixture.port.mutateSession(
        conversationId,
        { kind: "session-meta", patch: { name: "待处理对话" } },
        hostContext("name-before-removal"),
      );
      const snapshot = await fixture.assembly.freezeForDeviceRemoval("remove-1");
      expect(snapshot.conversations).toEqual([expect.objectContaining({
        conversationId,
        displayName: "待处理对话",
        state: "current",
      })]);
      await expect(fixture.assembly.freezeForDeviceRemoval("remove-1")).resolves.toBe(snapshot);
      await expect(fixture.assembly.freezeForDeviceRemoval("remove-2"))
        .rejects.toThrow("Another device-removal operation");
      await expect(fixture.port.createConversation()).rejects.toThrow(/being removed/);
      expect(() => fixture.assembly.releaseDeviceRemovalFreeze("remove-2"))
        .toThrow("identity does not match");
      fixture.assembly.releaseDeviceRemovalFreeze("remove-1");
      await expect(fixture.port.createConversation()).resolves.toContain("local-");
      await fixture.assembly.close();
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "deletes exactly the frozen local-owner set through the authority mutation path",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({ profile: "anchor-executor" });
      await fixture.assembly.start();
      const first = await fixture.port.createConversation();
      const second = await fixture.port.createConversation();
      const snapshot = await fixture.assembly.freezeForDeviceRemoval("remove-destroy");
      const ids = snapshot.conversations.map((item) => item.conversationId);
      expect(ids).toEqual([first, second].sort());
      await expect(fixture.assembly.destroyFrozenConversations(
        "remove-destroy",
        [first],
      )).rejects.toThrow("does not match the frozen conversation set");
      await fixture.assembly.destroyFrozenConversations("remove-destroy", ids);
      await expect(fixture.assembly.assertDeviceRemovalSettled(
        "remove-destroy",
        "destroy",
        snapshot.ownerItems,
      ))
        .resolves.toBeUndefined();
      await fixture.assembly.close();
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "settles one frozen host-stop exact-set across all local owner ports",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({ profile: "anchor-executor" });
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      await fixture.assembly.closeHostStopAdmission("stop-local-owner");
      const conversation = fixture.assembly.hostStopAcceptedWorkItems(
        "stop-local-owner",
        "conversation",
      );
      expect(conversation).toEqual([
        expect.objectContaining({ id: conversationId }),
      ]);
      await fixture.assembly.settleHostStopAcceptedWork(
        "stop-local-owner",
        "immediate",
        10_000,
      );
      for (const owner of [
        "conversation",
        "intent",
        "final",
        "assignment",
        "lease",
        "permit",
      ] as const) {
        const frozen = fixture.assembly.hostStopAcceptedWorkItems("stop-local-owner", owner);
        await expect(fixture.assembly.assertHostStopAcceptedWorkSettled(
          "stop-local-owner",
          owner,
          "immediate",
          frozen,
        )).resolves.toBeUndefined();
      }
      await fixture.assembly.close();
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "keeps only the frozen durable local subset for immediate stop",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({ profile: "anchor-executor" });
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      await fixture.port.deferSchedule({
        conversationId,
        requestId: "host-stop-durable-intent",
        mutation: {
          kind: "schedule-create",
          spec: {
            name: "Host stop durable intent",
            enabled: true,
            priority: "normal",
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
            action: { kind: "agent-turn", prompt: "resume after restart" },
          },
        },
      });
      await fixture.assembly.closeHostStopAdmission("stop-durable-subset");
      const frozenIntent = fixture.assembly.hostStopAcceptedWorkItems(
        "stop-durable-subset",
        "intent",
      );
      expect(frozenIntent).toHaveLength(1);

      await fixture.assembly.settleHostStopAcceptedWork(
        "stop-durable-subset",
        "immediate",
        10_000,
      );
      await expect(fixture.assembly.assertHostStopAcceptedWorkSettled(
        "stop-durable-subset",
        "intent",
        "immediate",
        frozenIntent,
      )).resolves.toBeUndefined();
      await expect(fixture.assembly.assertHostStopAcceptedWorkSettled(
        "stop-durable-subset",
        "intent",
        "drain",
        frozenIntent,
      )).rejects.toThrow("intent accepted work is not settled");
      const currentIntent = (await fixture.assembly.preflightForDeviceRemoval(
        "stop-durable-subset",
      )).ownerItems
        .filter((item) => item.owner === "intent")
        .map(({ id, revision }) => ({ id, revision }));
      expect(currentIntent).toEqual(frozenIntent);

      await expect(fixture.assembly.releaseHostStopAdmission("stop-successor"))
        .rejects.toThrow("does not own");
      await expect(fixture.assembly.releaseHostStopAdmission("stop-durable-subset"))
        .resolves.toBeUndefined();
      await expect(fixture.port.createConversation()).resolves.toEqual(expect.any(String));
      await expect(fixture.assembly.releaseHostStopAdmission("stop-durable-subset"))
        .resolves.toBeUndefined();

      await fixture.assembly.close();
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "waits for an active local turn to reach its durable safe point without cancelling it",
    async () => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
        run: async function* (messages) {
          await released;
          const assistant = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "safe point reached" }],
          };
          return {
            agentResult: {
              reason: "completed" as const,
              message: assistant,
              usage: { inputTokens: 1, outputTokens: 1 },
            },
            runRecord: {
              timestamp: new Date().toISOString(),
              messages: [messages.at(-1)!, assistant],
              usage: { inputTokens: 1, outputTokens: 1 },
              source: "interactive" as const,
            },
            newMessages: [assistant],
            durationMs: 1,
          };
        },
      });
      await fixture.assembly.start();
      await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(false);
      const conversationId = await fixture.port.createConversation();
      const turn = fixture.port.runTurn({
        conversationId,
        text: "finish current work",
        turnId: "host-stop-active-turn",
      });
      await waitFor(() => fixture.runtime.executions() === 1, "active host-stop turn");
      await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(true);
      await fixture.assembly.closeHostStopAdmission("stop-active-turn");
      const frozenByOwner = Object.fromEntries(
        (["conversation", "intent", "final", "assignment", "lease", "permit"] as const)
          .map((owner) => [
            owner,
            fixture.assembly.hostStopAcceptedWorkItems("stop-active-turn", owner),
          ]),
      );

      let settled = false;
      const settlement = fixture.assembly.settleHostStopAcceptedWork(
        "stop-active-turn",
        "immediate",
        10_000,
      ).then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(fixture.runtime.aborts()).toBe(0);
      release();
      await expect(turn).resolves.toMatchObject({ kind: "settled" });
      await expect(settlement).resolves.toBeUndefined();
      expect(fixture.runtime.aborts()).toBe(0);
      // Immediate stop may leave a durable final for the next recovery owner;
      // an on-demand Host must not classify that unresolved obligation as idle.
      await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(true);
      for (const owner of [
        "conversation",
        "intent",
        "final",
        "assignment",
        "lease",
        "permit",
      ] as const) {
        await expect(fixture.assembly.assertHostStopAcceptedWorkSettled(
          "stop-active-turn",
          owner,
          "immediate",
          frozenByOwner[owner]!,
        )).resolves.toBeUndefined();
      }

      await fixture.assembly.close();
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "keeps a pending deferred intent active until its normal terminal decision",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({ profile: "executor-only" });
      try {
        await fixture.assembly.start();
        const conversationId = await fixture.port.createConversation();
        await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(false);

        const deferred = await fixture.port.deferSchedule({
          conversationId,
          requestId: "executor-idle-deferred-intent",
          mutation: {
            kind: "schedule-create",
            spec: {
              name: "Executor idle deferred intent",
              enabled: true,
              priority: "normal",
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
              action: { kind: "agent-turn", prompt: "resume after idle" },
            },
          },
        });
        await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(true);

        await fixture.port.discardDeferredIntent(deferred.intentId);
        await expect(fixture.port.listDeferredIntents(conversationId)).resolves.toEqual([
          expect.objectContaining({ intentId: deferred.intentId, status: "discarded" }),
        ]);
        await expect(fixture.assembly.hasIdleBlockingWork()).resolves.toBe(false);
      } finally {
        await fixture.assembly.close();
        await fixture.authority.stopStorageMaintenance();
      }
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "fences every port write before start and after close while reads stay available",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
      });
      const probe = localConversationId(
        fixture.authority.deviceId,
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      await expectWritesFenced(fixture.port, probe);

      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      expect(conversationId).toContain("local-");

      await fixture.assembly.close();
      await expectWritesFenced(fixture.port, conversationId);
      await expect(fixture.port.listConversations()).resolves.toEqual([
        conversationId,
      ]);
      await expect(
        fixture.port.sessionState.readSessionMeta(
          conversationId,
          hostContext("read-after-close"),
        ),
      ).resolves.toMatchObject({});
      await expect(fixture.port.pendingInteractions()).resolves.toEqual([]);
      await expect(fixture.port.rubricCatalog.listForMatching()).resolves.toBeDefined();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "concurrent and repeated close calls share exactly one result",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
      });
      await fixture.assembly.start();
      const first = fixture.assembly.close();
      const second = fixture.assembly.close();
      expect(second).toBe(first);
      await first;
      expect(fixture.assembly.close()).toBe(first);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "close issued during start linearizes into closing and never hangs",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
      });
      const startOutcome = fixture.assembly.start().then(
        () => "started" as const,
        () => "fenced" as const,
      );
      await fixture.assembly.close();
      await expect(startOutcome).resolves.toBeDefined();
      const probe = localConversationId(
        fixture.authority.deviceId,
        "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      );
      await expectWritesFenced(fixture.port, probe);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "close settles cleanly after a naturally completed turn",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
      });
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const outcome = await fixture.port.runTurn({
        conversationId,
        text: "complete me",
        turnId: "complete-turn",
      });
      expect(outcome.kind).toBe("settled");
      await fixture.assembly.close();
      await expect(fixture.port.listConversations()).resolves.toEqual([
        conversationId,
      ]);
      await expectWritesFenced(fixture.port, conversationId);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "close drains active and queued turns through one durable cancellation fence (C30-R05)",
    async () => {
      let control: LocalOwnerAssemblyFixture["runtime"];
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
        closeDrainBudgetMs: 5_000,
        run: async function* (messages) {
          while (control.aborts() === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return {
            agentResult: {
              reason: "aborted" as const,
              usage: { inputTokens: 0, outputTokens: 0 },
            },
            runRecord: {
              timestamp: new Date().toISOString(),
              messages: [messages.at(-1)!],
              usage: { inputTokens: 0, outputTokens: 0 },
              source: "interactive" as const,
            },
            newMessages: [],
            durationMs: 1,
          };
        },
      });
      control = fixture.runtime;
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const activeTurn = fixture.port
        .runTurn({ conversationId, text: "active", turnId: "drain-active" })
        .then(
          (outcome) => ({ kind: "settled" as const, outcome }),
          (error) => ({ kind: "rejected" as const, error }),
        );
      await waitFor(
        () => fixture.runtime.executions() === 1,
        "active turn to start",
      );
      const queuedTurn = fixture.port
        .runTurn({ conversationId, text: "queued", turnId: "drain-queued" })
        .then(
          (outcome) => ({ kind: "settled" as const, outcome }),
          (error) => ({ kind: "rejected" as const, error }),
        );

      const closing = fixture.assembly.close();
      await expect(closing).resolves.toBeUndefined();
      expect(fixture.assembly.close()).toBe(closing);
      expect(fixture.runtime.aborts()).toBeGreaterThanOrEqual(1);
      expect(fixture.runtime.executions()).toBe(1);
      const [activeOutcome, queuedOutcome] = await Promise.all([
        activeTurn,
        queuedTurn,
      ]);
      expect(activeOutcome.kind).toBe("settled");
      expect(queuedOutcome.kind).toBe("settled");
      if (activeOutcome.kind === "settled") {
        expect(activeOutcome.outcome).toMatchObject({
          kind: "settled",
          runResult: { agentResult: { reason: "aborted" } },
        });
      }
      if (queuedOutcome.kind === "settled") {
        expect(queuedOutcome.outcome.kind).toBe("aborted");
      }
      await expectWritesFenced(fixture.port, conversationId);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "close durably resolves a pending confirmation before reporting success",
    async () => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
        pendingConfirmation: true,
      });
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const turn = fixture.port.runTurn({
        conversationId,
        text: "needs confirmation",
        turnId: "pending-confirmation-turn",
      });
      await waitForAsync(
        async () => (await fixture.port.pendingInteractions()).length === 1,
        "pending interaction to become durable",
        30_000,
      );

      await expect(fixture.assembly.close()).resolves.toBeUndefined();
      const outcome = await turn;
      if (outcome.kind === "error") throw outcome.error;
      expect(outcome).toMatchObject({
        kind: "settled",
        runResult: { agentResult: { reason: "aborted" } },
      });
      await expect(fixture.port.pendingInteractions()).resolves.toEqual([]);
      expect(fixture.runtime.executions()).toBe(1);
      await fixture.authority.stopStorageMaintenance();
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    "fails close when settlement is unprovable and the next start re-drives durable pending without re-execution",
    async () => {
      let control: LocalOwnerAssemblyFixture["runtime"];
      const fixture = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
        closeDrainBudgetMs: 10,
        run: async function* (messages) {
          while (control.aborts() === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          // 模拟 provider 已收到 abort、但未能在关闭预算内返回。close 必须
          // 诚实失败；迟到结果仍只能让位给已耐久的取消事实。
          await new Promise((resolve) => setTimeout(resolve, 75));
          return {
            agentResult: {
              reason: "aborted" as const,
              usage: { inputTokens: 0, outputTokens: 0 },
            },
            runRecord: {
              timestamp: new Date().toISOString(),
              messages: [messages.at(-1)!],
              usage: { inputTokens: 0, outputTokens: 0 },
              source: "interactive" as const,
            },
            newMessages: [],
            durationMs: 75,
          };
        },
      });
      control = fixture.runtime;
      await fixture.assembly.start();
      const conversationId = await fixture.port.createConversation();
      const stuckTurn = fixture.port
        .runTurn({ conversationId, text: "stuck", turnId: "stuck-turn" })
        .then(
          () => "settled" as const,
          () => "rejected" as const,
        );
      void stuckTurn;
      await waitFor(
        () => fixture.runtime.executions() === 1,
        "stuck turn to start",
      );

      const closing = fixture.assembly.close();
      await expect(closing).rejects.toThrow(/not provably settled/);
      expect(fixture.assembly.close()).toBe(closing);
      await expectWritesFenced(fixture.port, conversationId);
      await expect(stuckTurn).resolves.toBe("settled");
      expect(fixture.runtime.executions()).toBe(1);
      await fixture.authority.stopStorageMaintenance();

      const restarted = await createLocalOwnerAssemblyFixture({
        profile: "anchor-executor",
        home: fixture.home,
      });
      try {
        await restarted.assembly.start();
        expect(restarted.runtime.executions()).toBe(0);
        expect(await restarted.port.listConversations()).toEqual([
          conversationId,
        ]);
        const tail = await restarted.port.sessionState.readTranscriptTail(
          conversationId,
          hostContext("restart-tail"),
          undefined,
          10,
        );
        expect(tail.records).toEqual([]);
        await expect(
          restarted.port.finalHistory(conversationId, 0),
        ).resolves.toEqual([]);
      } finally {
        await restarted.assembly.close();
        await restarted.authority.stopStorageMaintenance();
      }
    },
    LIFECYCLE_TIMEOUT_MS,
  );
});
