import { createTempDir } from "@zhixing-ai/test-utils";
import { assistantMessage, emptyUsage, userTurnInputFromText, type Message } from "@zhixing-ai/core";
import {
  ConversationRepository,
  conversationsDir,
  localConversationId,
  parseConversationId,
} from "@zhixing-ai/core/conversation";
import {
  ConversationApplicationError,
  ConversationCommittedLifecyclePendingError,
  ConversationDirectoryApplicationService,
  projectConversationClear,
  projectConversationDelete,
  runCommittedConversationLifecycleProjection,
  type ConversationClearedFact,
  type ConversationDeletedFact,
} from "@zhixing-ai/core/conversation/application";
import {
  runWithMaintenanceUrgency,
  StorageMaintenanceCancelledError,
} from "@zhixing-ai/core/resources";
import { ShardedTranscriptStore } from "@zhixing-ai/core/transcript";
import { createConversationAgentTurnAdmissionPort } from "@zhixing-ai/owner-kernel/conversation-agent-turn-admission";
import { ConversationRunJournal } from "@zhixing-ai/owner-kernel/conversation-assignment";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type { SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { RPC_ERROR_CODES, RpcAppError, toJsonRpcError } from "@zhixing-ai/server";
import { describe, expect, it, vi } from "vitest";
import { createAnchorConversationClearCommitPort } from "../conversation-clear-binding.js";
import {
  createAnchorConversationDeleteCommitPort,
  createAnchorConversationDeleteProjectionPort,
} from "../conversation-delete-binding.js";
import { createConversationDirectory } from "../conversation-directory.js";
import { LocalConversationRpcRouter } from "../local-conversation-rpc.js";
import type { LocalConversationOwnerPort } from "../local-conversation-owner.js";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { createWorksceneStorageCleanupInfrastructure } from "../workscene-storage-cleanup.js";
import {
  createProtocol,
  MemorySecretStore,
  setupAuthorityRuntime,
  TEST_RUNTIME_AUTHORITY_FACTS,
} from "./conversation-protocol-runtime-fixture.js";

const SURFACE_CALLER = {
  kind: "surface" as const,
  surfacePrincipal: "rpc:owner",
  connectionId: "conn-b501",
};

function makeFakeSessionRuntime(sessionId: string): SessionRuntime & {
  clearedCount: number;
  messages: Message[];
} {
  const messages: Message[] = [];
  let clearedCount = 0;
  return {
    ...TEST_RUNTIME_AUTHORITY_FACTS,
    sessionId,
    get clearedCount() {
      return clearedCount;
    },
    messages,
    getMessages: () => [...messages],
    onAttentionWindowChange: async (reason: string) => {
      if (reason === "clear") {
        clearedCount += 1;
        messages.length = 0;
      }
    },
    abort: () => false,
    dispose: async () => undefined,
    async *run() {
      const reply = assistantMessage("ok");
      messages.push(reply);
      return {
        status: "completed" as const,
        message: reply,
        messages: [reply],
        usage: emptyUsage(),
        iterations: 1,
      };
    },
  } as unknown as SessionRuntime & { clearedCount: number; messages: Message[] };
}

async function createB501AnchorHarness() {
  const home = await createTempDir("b501-anchor-clear-projection");
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
  });
  const repo = new ConversationRepository({ kind: "user" }, home);
  const transcript = new ShardedTranscriptStore(
    conversationsDir({ kind: "user" }, home),
  );
  const directory = createConversationDirectory({
    user: { repo, transcript },
    routeConversation: (conversationId) => ({
      repo,
      transcript,
      localId: parseConversationId(conversationId).localId,
    }),
    worksceneConversationStorageRemoval:
      createWorksceneStorageCleanupInfrastructure({ zhixingHome: home })
        .conversations,
  });

  const runtimes = new Map<string, ReturnType<typeof makeFakeSessionRuntime>>();
  const clearedFacts: ConversationClearedFact[] = [];
  const deletedFacts: ConversationDeletedFact[] = [];
  let clearProjectionAttempts = 0;

  let manager!: ConversationManager;
  const protocol = createProtocol({
    authority,
    manager: () => manager,
    storedIdentityExists: (id) => directory.exists(id),
    interactions: new DurableConversationInteractionObserver(),
    projectLifecycle: async (input) => {
      if (input.mutation === "clear") {
        clearProjectionAttempts += 1;
        await projectConversationClear({
          conversationId: input.conversationId,
          operationId: input.requestId,
          projection: {
            clearStoredView: (id) => directory.clearStoredView(id),
            clearRuntimeView: (id, persist) => manager.clear(id, persist),
          },
          publishFact: (fact) => {
            clearedFacts.push(fact);
          },
        });
        return;
      }
      await projectConversationDelete({
        conversationId: input.conversationId,
        operationId: input.requestId,
        deletionAlreadyCommitted: true,
        dependentFailure: "propagate",
        projection: createAnchorConversationDeleteProjectionPort({
          conversations: manager,
          storage: {
            exists: (id) => directory.exists(id),
            deleteStoredConversation: (id) =>
              directory.deleteStoredConversation(id),
          },
        }),
        publishFact: (fact) => {
          deletedFacts.push(fact);
        },
      });
    },
  });

  manager = new ConversationManager(
    {
      create: async (conversationId) => {
        let rt = runtimes.get(conversationId);
        if (!rt) {
          rt = makeFakeSessionRuntime(conversationId);
          runtimes.set(conversationId, rt);
        }
        return rt;
      },
    },
    { idleCheckIntervalMs: 999_999, graceTimeoutMs: 60_000 },
    { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
  );

  const application = new ConversationDirectoryApplicationService({
    storage: directory,
    agentTurnIdentity: {
      exists: (id) => directory.exists(id),
      create: async () => (await directory.create()).conversationId,
      ensure: async (id) => {
        await directory.ensure(id);
      },
    },
    agentTurns: createConversationAgentTurnAdmissionPort({
      manager,
    }),
    clear: createAnchorConversationClearCommitPort({
      conversations: manager,
      directory,
      publishFact: (fact) => {
        clearedFacts.push(fact);
      },
    }),
    delete: createAnchorConversationDeleteCommitPort({
      conversations: manager,
      storage: directory,
      publishFact: (fact) => {
        deletedFacts.push(fact);
      },
    }),
  });

  await protocol.recoverReadinessProjections();

  return {
    authority,
    directory,
    transcript,
    protocol,
    manager,
    application,
    runtimes,
    clearedFacts,
    deletedFacts,
    get clearProjectionAttempts() {
      return clearProjectionAttempts;
    },
    close: async () => {
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    },
  };
}

describe("B5-01 durable clear/delete post-commit lifecycle projection convergence", () => {
  it("waitForSessionIdle checks signal.throwIfAborted first and wakes across setBusy(false), delete, quiescePrefix, and disposeAll without listener leaks", async () => {
    const manager = new ConversationManager(
      { create: async (id) => makeFakeSessionRuntime(id) },
      { idleCheckIntervalMs: 999_999, graceTimeoutMs: 60_000 },
    );
    try {
      const preAborted = new AbortController();
      const reason = new Error("pre-aborted-reason");
      preAborted.abort(reason);
      await expect(
        manager.waitForSessionIdle("non-existent", preAborted.signal),
      ).rejects.toBe(reason);

      await manager.getOrCreate("conv-idle-check");
      await expect(
        manager.waitForSessionIdle("conv-idle-check", preAborted.signal),
      ).rejects.toBe(reason);
      await expect(
        manager.waitForSessionIdle("conv-idle-check"),
      ).resolves.toBeUndefined();

      // Wake via setBusy(false)
      manager.setBusy("conv-idle-check", true);
      let wokeBusy = false;
      const wait1 = manager.waitForSessionIdle("conv-idle-check").then(() => {
        wokeBusy = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(wokeBusy).toBe(false);
      manager.setBusy("conv-idle-check", false);
      await wait1;
      expect(wokeBusy).toBe(true);

      // Abort mid-wait removes waiter cleanly
      manager.setBusy("conv-idle-check", true);
      const midAbort = new AbortController();
      const midReason = new Error("mid-abort");
      const waitAbort = manager.waitForSessionIdle("conv-idle-check", midAbort.signal);
      midAbort.abort(midReason);
      await expect(waitAbort).rejects.toBe(midReason);
      manager.setBusy("conv-idle-check", false);

      // Wake via delete(id) when session is removed without setBusy(false)
      await manager.getOrCreate("conv-del-wake");
      const waitDel = manager.waitForSessionIdle("conv-del-wake");
      await expect(waitDel).resolves.toBeUndefined();

      // Wake via disposeAll() when session is busy
      await manager.getOrCreate("conv-dispose-wake");
      manager.setBusy("conv-dispose-wake", true);
      const waitDispose = manager.waitForSessionIdle("conv-dispose-wake");
      await manager.disposeAll();
      await expect(waitDispose).resolves.toBeUndefined();
    } finally {
      await manager.disposeAll();
    }
  });

  it("waits out post-commit session.busy tail, keeps input fence closed until projection completes, and converges in one fact without BUSY error", async () => {
    const h = await createB501AnchorHarness();
    try {
      const created = await h.directory.create();
      const id = created.conversationId;
      await h.protocol.ensureSession(id);
      const managed = await h.manager.getOrCreate(id);
      (managed.runtime as ReturnType<typeof makeFakeSessionRuntime>).messages.push(
        assistantMessage("turn-before-clear"),
      );

      // Simulate the exact B5-01 window: durable turn has already committed (no open run),
      // while runManagedTurn's post-commit tail still holds session.busy = true.
      h.manager.setBusy(id, true);

      let settled = false;
      const clearPromise = h.application
        .clear({
          kind: "clear",
          conversationId: id,
          operationId: "session.clear:b501-tail-1",
          caller: SURFACE_CALLER,
        })
        .then((res) => {
          settled = true;
          return res;
        });

      // Wait until the first projection attempt hit session.busy and entered waitForSessionIdle
      const deadline = Date.now() + 2_000;
      while (h.clearProjectionAttempts === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(h.clearProjectionAttempts).toBe(1);
      expect(settled).toBe(false);

      // Safety fence: while clear projection is still pending, new input MUST be blocked
      const turnIdentity = h.application.prepareAgentTurnIdentity({
        kind: "prepare-agent-turn-identity",
        turnId: "turn-during-pending-clear",
        identitySource: "provided",
        caller: SURFACE_CALLER,
      });
      await expect(
        h.application.admitAgentTurn({
          kind: "admit-agent-turn",
          conversationId: id,
          input: userTurnInputFromText("must-not-slip-before-clear"),
          turnIdentity,
          caller: SURFACE_CALLER,
          execution: {
            execute: async () => undefined,
            cancelPending: () => undefined,
          },
        }),
      ).rejects.toThrow("Conversation lifecycle projection must finish before new input");

      // Release post-commit busy tail: clear wakes immediately via event signal and finishes!
      h.manager.setBusy(id, false);
      const result = await clearPromise;
      expect(result).toEqual({
        cleared: true,
        fact: {
          kind: "conversation-cleared",
          conversationId: id,
          operationId: "session.clear:b501-tail-1",
        },
      });
      expect(h.clearProjectionAttempts).toBe(2);
      expect(h.clearedFacts).toEqual([
        {
          kind: "conversation-cleared",
          conversationId: id,
          operationId: "session.clear:b501-tail-1",
        },
      ]);
      expect(h.runtimes.get(id)?.clearedCount).toBe(1);
      expect(h.runtimes.get(id)?.getMessages()).toEqual([]);

      // Only one session-lifecycle and one session-lifecycle-projected record in authority log
      const commits = await h.authority.authorityLog.readAll();
      const entries = commits.flatMap((c) => c.entries).map((e) => e.body as { t?: string; requestId?: string });
      expect(
        entries.filter((e) => e.t === "session-lifecycle" && e.requestId === "session.clear:b501-tail-1"),
      ).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("rejects pre-commit clear/delete immediately when an authoritative run is open, without writing clear fact or delayed clearing", async () => {
    const h = await createB501AnchorHarness();
    try {
      const created = await h.directory.create();
      const id = created.conversationId;
      await h.protocol.ensureSession(id);

      // Admit a durable run via application.admitAgentTurn (deferring start) so hasOpenRun === true ("queued") in authority
      const turnIdentity = h.application.prepareAgentTurnIdentity({
        kind: "prepare-agent-turn-identity",
        turnId: "turn-open-run",
        identitySource: "provided",
        caller: SURFACE_CALLER,
      });
      // Hold session.busy so manager queues the admitted task instead of running immediately, keeping durable run in "queued" state!
      await h.manager.getOrCreate(id);
      h.manager.setBusy(id, true);
      const admitted = await h.application.admitAgentTurn({
        kind: "admit-agent-turn",
        conversationId: id,
        input: userTurnInputFromText("hello"),
        turnIdentity,
        caller: SURFACE_CALLER,
        execution: {
          execute: async () => undefined,
          cancelPending: () => undefined,
        },
      });
      expect(admitted.status).toBe("queued");

      let clearErr: unknown;
      try {
        await h.application.clear({
          kind: "clear",
          conversationId: id,
          operationId: "session.clear:precommit-busy",
          caller: SURFACE_CALLER,
        });
      } catch (err) {
        clearErr = err;
      }
      expect(clearErr).toBeInstanceOf(ConversationApplicationError);
      expect(clearErr).toMatchObject({
        code: "busy",
        reason: "pending-lifecycle",
      });
      expect(clearErr).not.toBeInstanceOf(ConversationCommittedLifecyclePendingError);

      let deleteErr: unknown;
      try {
        await h.application.delete({
          kind: "delete",
          conversationId: id,
          operationId: "session.delete:precommit-busy",
          caller: SURFACE_CALLER,
        });
      } catch (err) {
        deleteErr = err;
      }
      expect(deleteErr).toBeInstanceOf(ConversationApplicationError);
      expect(deleteErr).toMatchObject({
        code: "busy",
        reason: "pending-lifecycle",
      });

      // Cancel the queued run, release busy, and run recovery: conversation must NOT be cleared or deleted!
      if (admitted.runId) {
        await h.protocol.cancelAdmitted(id, admitted.runId);
      }
      h.manager.abort(id);
      h.manager.setBusy(id, false);
      await h.protocol.recoverConversation(id);
      expect(h.clearedFacts).toHaveLength(0);
      expect(h.deletedFacts).toHaveLength(0);
      expect(await h.directory.exists(id)).toBe(true);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("wraps post-commit failures (including pre-fact-read failure, external cancellation, scope turnover, and >5s busy timeout) as ConversationCommittedLifecyclePendingError, maps to non-BUSY RPC pending response, and converges idempotently without clearing post-clear history", async () => {
    const h = await createB501AnchorHarness();
    try {
      // 1) Direct uncommitted requestId on protocol.projectSession still throws raw unbound fact Error
      const c0 = await h.directory.create();
      await h.protocol.ensureSession(c0.conversationId);
      await expect(
        h.protocol.projectSession({
          conversationId: c0.conversationId,
          requestId: "uncommitted-request-id",
          mutation: "clear",
          domainRevision: 99,
        }),
      ).rejects.toThrow("Lifecycle projection does not bind its durable authority fact");

      // 2) Failure BEFORE lifecycleRequest is verified (e.g. adopt throws right after writeSession committed)
      //    at the post-commit binding boundary STILL produces ConversationCommittedLifecyclePendingError!
      const cPreRead = await h.directory.create();
      const adoptFault = new Error("adopt-failed-before-fact-read");
      const origProjectDurable = h.manager.projectDurableSession.bind(h.manager);
      const preReadSpy = vi
        .spyOn(h.manager, "projectDurableSession")
        .mockImplementationOnce(async () => {
          throw adoptFault;
        });
      let preReadCaught: unknown;
      try {
        await h.application.clear({
          kind: "clear",
          conversationId: cPreRead.conversationId,
          operationId: "session.clear:pre-fact-read-fault",
          caller: SURFACE_CALLER,
        });
      } catch (err) {
        preReadCaught = err;
      } finally {
        preReadSpy.mockRestore();
      }
      expect(preReadCaught).toBeInstanceOf(ConversationCommittedLifecyclePendingError);
      expect((preReadCaught as ConversationCommittedLifecyclePendingError).cause).toBe(adoptFault);
      expect((preReadCaught as ConversationCommittedLifecyclePendingError).pending).toEqual({
        stage: "committed-projection-pending",
        mutation: "clear",
        conversationId: cPreRead.conversationId,
        operationId: "session.clear:pre-fact-read-fault",
      });
      expect(Object.isFrozen((preReadCaught as ConversationCommittedLifecyclePendingError).pending)).toBe(true);
      await origProjectDurable({
        conversationId: cPreRead.conversationId,
        requestId: "session.clear:pre-fact-read-fault",
        mutation: "clear",
        domainRevision: 1,
      });

      // 2b) Controlled fact-read hang -> recoverInstalledAuthority() scope turnover -> old read resolves:
      //     must reject with scope-changed cause and NEVER touch new-generation runtime!
      const cTurnover = await h.directory.create();
      await h.protocol.ensureSession(cTurnover.conversationId);
      let releaseFactRead!: () => void;
      const factReadGate = new Promise<void>((r) => {
        releaseFactRead = r;
      });
      let enteredFactRead!: () => void;
      const factReadStarted = new Promise<void>((r) => {
        enteredFactRead = r;
      });
      const origLifecycleRequest = ConversationRunJournal.prototype.lifecycleRequest;
      let interceptedTurnoverRead = false;
      const factReadSpy = vi
        .spyOn(ConversationRunJournal.prototype, "lifecycleRequest")
        .mockImplementation(async function (this: ConversationRunJournal, reqId: string) {
          const fact = await origLifecycleRequest.call(this, reqId);
          // Only intercept AFTER writeSession committed the lifecycle fact (the read inside projectSession!)
          if (!interceptedTurnoverRead && reqId === "session.clear:turnover-during-fact-read" && fact !== undefined) {
            interceptedTurnoverRead = true;
            enteredFactRead();
            await factReadGate;
          }
          return fact;
        });
      const staleClearPromise = h.application
        .clear({
          kind: "clear",
          conversationId: cTurnover.conversationId,
          operationId: "session.clear:turnover-during-fact-read",
          caller: SURFACE_CALLER,
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (e) => ({ ok: false as const, error: e }),
        );
      await factReadStarted;
      // Swap authority generation while old projectSession is suspended inside lifecycleRequest!
      // recoverInstalledAuthority on the new generation completes the committed clear once;
      // then we seed a post-turnover message on the new-generation runtime and release old factReadGate
      // to prove the stale old-scope call NEVER touches the new-generation runtime!
      await h.protocol.recoverInstalledAuthority();
      const newManaged = await h.manager.getOrCreate(cTurnover.conversationId);
      const newRuntime = newManaged.runtime as ReturnType<typeof makeFakeSessionRuntime>;
      newRuntime.messages.push(assistantMessage("new-generation-message-must-survive"));
      const clearedBeforeStaleWake = newRuntime.clearedCount;
      releaseFactRead();
      const staleOutcome = await staleClearPromise;
      factReadSpy.mockRestore();
      expect(staleOutcome.ok).toBe(false);
      if (!staleOutcome.ok) {
        expect(staleOutcome.error).toBeInstanceOf(ConversationCommittedLifecyclePendingError);
        expect(
          ((staleOutcome.error as ConversationCommittedLifecyclePendingError).cause as Error).message,
        ).toContain("Conversation authority scope changed");
      }
      expect(newRuntime.clearedCount).toBe(clearedBeforeStaleWake);
      expect(newRuntime.getMessages()).toHaveLength(1);

      // 3) External abort while waiting on session.busy -> ConversationCommittedLifecyclePendingError (cause = StorageMaintenanceCancelledError)
      const cCancel = await h.directory.create();
      await h.manager.getOrCreate(cCancel.conversationId);
      h.manager.setBusy(cCancel.conversationId, true);
      const extAbort = new AbortController();
      setTimeout(() => extAbort.abort(), 40);
      let cancelCaught: unknown;
      try {
        await runWithMaintenanceUrgency(
          () => "foreground",
          extAbort.signal,
          () =>
            h.application.clear({
              kind: "clear",
              conversationId: cCancel.conversationId,
              operationId: "session.clear:ext-cancel",
              caller: SURFACE_CALLER,
            }),
        );
      } catch (err) {
        cancelCaught = err;
      }
      expect(cancelCaught).toBeInstanceOf(ConversationCommittedLifecyclePendingError);
      expect((cancelCaught as ConversationCommittedLifecyclePendingError).cause).toBeInstanceOf(
        StorageMaintenanceCancelledError,
      );
      // While still pending, a DIFFERENT clear requestId gets pre-commit busy with reason "pending-lifecycle"
      await expect(
        h.application.clear({
          kind: "clear",
          conversationId: cCancel.conversationId,
          operationId: "session.clear:second-while-pending",
          caller: SURFACE_CALLER,
        }),
      ).rejects.toMatchObject({
        code: "busy",
        reason: "pending-lifecycle",
      });
      // Release busy and concurrently replay the SAME operationId + background recovery:
      // must coalesce and clear exactly once!
      h.manager.setBusy(cCancel.conversationId, false);
      const beforeCount = h.clearedFacts.filter((f) => f.conversationId === cCancel.conversationId).length;
      const [replayRes] = await Promise.all([
        h.application.clear({
          kind: "clear",
          conversationId: cCancel.conversationId,
          operationId: "session.clear:ext-cancel",
          caller: SURFACE_CALLER,
        }),
        h.protocol.recoverConversation(cCancel.conversationId),
      ]);
      expect(replayRes.cleared).toBe(true);
      expect(
        h.clearedFacts.filter((f) => f.conversationId === cCancel.conversationId).length - beforeCount,
      ).toBe(1);
      // Post-clear runtime message added AFTER completion is NOT wiped by a subsequent recovery pass
      (h.runtimes.get(cCancel.conversationId)?.messages ?? []).push(
        assistantMessage("post-clear-turn"),
      );
      await h.protocol.recoverConversation(cCancel.conversationId);
      expect(h.runtimes.get(cCancel.conversationId)?.getMessages()).toHaveLength(1);

      // 4) Sustained >5s session.busy exhausts finite window without false cleared=true and without BUSY RPC code
      const cTimeout = await h.directory.create();
      await h.manager.getOrCreate(cTimeout.conversationId);
      h.manager.setBusy(cTimeout.conversationId, true);
      let timeoutCaught: unknown;
      try {
        await h.application.clear({
          kind: "clear",
          conversationId: cTimeout.conversationId,
          operationId: "session.clear:5s-timeout",
          caller: SURFACE_CALLER,
        });
      } catch (err) {
        timeoutCaught = err;
      }
      expect(timeoutCaught).toBeInstanceOf(ConversationCommittedLifecyclePendingError);
      expect((timeoutCaught as ConversationCommittedLifecyclePendingError).cause).toMatchObject({
        code: "busy",
        reason: "pending-lifecycle",
      });
      expect(toJsonRpcError(timeoutCaught).code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
      h.manager.setBusy(cTimeout.conversationId, false);
      await h.protocol.recoverConversation(cTimeout.conversationId);
      expect(
        h.clearedFacts.some((f) => f.operationId === "session.clear:5s-timeout"),
      ).toBe(true);
    } finally {
      await h.close();
    }
  }, 25_000);

  it("maps LocalConversationRpcRouter clear/delete pre-commit busy and post-commit pending errors accurately", async () => {
    const deviceId = "device-b50100";
    const convId = localConversationId(deviceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    let clearImpl: LocalConversationOwnerPort["commitConversationClear"] = async () => ({
      status: "cleared",
    });
    let deleteImpl: LocalConversationOwnerPort["commitConversationDelete"] = async () => ({
      status: "deleted",
    });

    const owner = {
      listConversations: async () => [convId],
      listConversationAuthorities: async () => [
        {
          conversationId: convId,
          authority: { deviceId, ownerEpoch: 1, state: "current" as const },
        },
      ],
      currentAuthority: async () => ({
        deviceId,
        ownerEpoch: 1,
        state: "current" as const,
      }),
      runtimeState: () => ({ active: true, busy: false, pendingCount: 0 }),
      commitConversationClear: (input: Parameters<LocalConversationOwnerPort["commitConversationClear"]>[0]) =>
        clearImpl(input),
      commitConversationDelete: (input: Parameters<LocalConversationOwnerPort["commitConversationDelete"]>[0]) =>
        deleteImpl(input),
      subscribeConversationFacts: () => () => undefined,
      subscribeRunNotifications: () => () => undefined,
    } as unknown as LocalConversationOwnerPort;

    const router = new LocalConversationRpcRouter({
      deviceId,
      owner,
      remoteFor: () => {
        throw new Error("unexpected remote");
      },
    });
    const connection = {
      id: 1,
      authenticated: true,
      surfacePrincipal: "rpc:owner",
      notify: vi.fn(),
      onClose: () => () => undefined,
    } as never;

    // 1) Pre-commit active-turn busy -> BUSY with specific Chinese message;
    //    durable pre-commit busy ("pending-lifecycle") -> truthful general Chinese message without falsely claiming an active turn
    clearImpl = async () => ({ status: "busy", reason: "active-turn" });
    await expect(
      router.dispatch({
        method: "session.clear",
        params: {
          conversationId: convId,
          requestId: "local-clear-active-turn",
          acceptLimitedCapabilities: true,
        },
        connection,
      }),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.BUSY,
      message: "当前对话仍有运行中的工作，请先中止或等待完成后再清空。",
    });

    clearImpl = async () => ({ status: "busy", reason: "pending-lifecycle" });
    await expect(
      router.dispatch({
        method: "session.clear",
        params: {
          conversationId: convId,
          requestId: "local-clear-general-busy",
          acceptLimitedCapabilities: true,
        },
        connection,
      }),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.BUSY,
      message: "当前对话正在处理其他操作或同步状态，请稍后重试，或先停止当前运行后再清空。",
    });

    // 2) Post-commit pending projection -> INTERNAL_ERROR with structured lifecycleStage data (never BUSY)
    clearImpl = async ({ conversationId, operationId }) =>
      runCommittedConversationLifecycleProjection(
        { mutation: "clear", conversationId, operationId },
        async () => {
          throw new ConversationApplicationError(
            "busy",
            "Conversation lifecycle projection is busy",
            "pending-lifecycle",
          );
        },
      );
    let localPendingErr: unknown;
    try {
      await router.dispatch({
        method: "session.clear",
        params: {
          conversationId: convId,
          requestId: "local-clear-pending-proj",
          acceptLimitedCapabilities: true,
        },
        connection,
      });
    } catch (err) {
      localPendingErr = err;
    }
    expect(localPendingErr).toBeInstanceOf(RpcAppError);
    expect(localPendingErr).toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "清空对话请求已记录，尚未完成同步；完成前暂不接纳新消息，可稍后核对状态。",
      data: {
        lifecycleStage: "committed-projection-pending",
        mutation: "clear",
        conversationId: convId,
        operationId: "local-clear-pending-proj",
      },
    });

    deleteImpl = async ({ conversationId, operationId }) =>
      runCommittedConversationLifecycleProjection(
        { mutation: "delete", conversationId, operationId },
        async () => {
          throw new Error("post-commit-delete-projection-fault");
        },
      );
    await expect(
      router.dispatch({
        method: "session.delete",
        params: {
          conversationId: convId,
          requestId: "local-delete-pending-proj",
          acceptLimitedCapabilities: true,
        },
        connection,
      }),
    ).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "删除对话请求已记录，尚未完成同步；可稍后核对状态。",
      data: {
        lifecycleStage: "committed-projection-pending",
        mutation: "delete",
        conversationId: convId,
        operationId: "local-delete-pending-proj",
      },
    });
  });
});
