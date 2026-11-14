import { createTempDir } from "@zhixing-ai/test-utils";
import {
  ConversationRepository,
  conversationsDir,
  parseConversationId,
} from "@zhixing-ai/core/conversation";
import {
  ConversationDirectoryApplicationService,
  projectConversationDelete,
} from "@zhixing-ai/core/conversation/application";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  isHoldingMaintenanceExclusion,
  runWithMaintenanceUrgency,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
  type DeviceCapacityArbiterPort,
} from "@zhixing-ai/core/resources";
import { ShardedTranscriptStore } from "@zhixing-ai/core/transcript";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { RPC_ERROR_CODES, toJsonRpcError } from "@zhixing-ai/server";
import { describe, expect, it, vi } from "vitest";
import {
  createAnchorConversationDeleteCommitPort,
  createAnchorConversationDeleteProjectionPort,
} from "../conversation-delete-binding.js";
import { createConversationDirectory } from "../conversation-directory.js";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { createWorksceneStorageCleanupInfrastructure } from "../workscene-storage-cleanup.js";
import {
  createProtocol,
  MemorySecretStore,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

const GIB = 1024 ** 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createRealAnchorDeleteHarness() {
  const home = await createTempDir("b402-anchor-delete-repro");
  const policy = createDefaultDeviceCapacityPolicy();
  const rawCapacity = new DefaultDeviceCapacityArbiter({
    policy,
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: 8 * GIB,
      processRssBytes: 64 * 1024 ** 2,
      temporaryBytesAvailable: 8 * GIB,
    }),
  });
  let onBeforeAcquire:
    | ((request: Parameters<DeviceCapacityArbiterPort["acquire"]>[0]) => Promise<void> | void)
    | undefined;
  const capacity: DeviceCapacityArbiterPort = {
    snapshot: () => rawCapacity.snapshot(),
    acquire: async (request, abort) => {
      await onBeforeAcquire?.(request);
      return rawCapacity.acquire(request, abort);
    },
  };
  const storageMaintenance = new DefaultStorageMaintenanceGovernor({
    capacity,
  });
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
    deviceCapacity: capacity,
    storageMaintenance,
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

  let manager!: ConversationManager;
  const protocol = createProtocol({
    authority,
    manager: () => manager,
    interactions: new DurableConversationInteractionObserver(),
    projectLifecycle: async (input) => {
      if (input.mutation !== "delete") return;
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
      });
    },
  });
  manager = new ConversationManager(
    {
      create: vi.fn(async () => {
        throw new Error("runtime must not be created during delete");
      }),
    },
    { idleCheckIntervalMs: 999_999 },
    { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
  );
  const application = new ConversationDirectoryApplicationService({
    storage: directory,
    delete: createAnchorConversationDeleteCommitPort({
      conversations: manager,
      storage: directory,
    }),
  });

  await protocol.recoverReadinessProjections();

  const holdAllOccupancySlotsBriefly = async (holdMs: number) => {
    const slots = rawCapacity.snapshot().occupancyCapacity.slots;
    const budget = {
      occupancy: { memoryReservationBytes: 0, temporaryBytes: 0, slots },
      quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
    };
    const granted = await rawCapacity.acquire(
      {
        admissionId: "concurrent-storage-burst",
        serviceClass: "storage-foreground",
        atomic: budget,
        preferred: budget,
        maxWaitMs: 250,
      },
      new AbortController().signal,
    );
    if (granted.kind !== "granted") {
      throw new Error(`Expected test slot hold to be granted, got ${granted.kind}`);
    }
    setTimeout(() => granted.permit.release(), holdMs);
  };

  return {
    authority,
    directory,
    protocol,
    manager,
    application,
    setOnBeforeAcquire: (
      fn:
        | ((request: Parameters<DeviceCapacityArbiterPort["acquire"]>[0]) => Promise<void> | void)
        | undefined,
    ) => {
      onBeforeAcquire = fn;
    },
    holdAllOccupancySlotsBriefly,
    close: async () => {
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
    },
  };
}

describe("B4-02 minimal real-assembly delete backpressure reproduction", () => {
  it("completes foreground delete without Internal error or stale list entry when transient capacity pressure hits projectSession after writeSession commits", async () => {
    const harness = await createRealAnchorDeleteHarness();
    try {
      const created = await harness.directory.create();
      // Warm surfaceAssets initial recovery so revokeConversation enters task body directly, as in a running daemon.
      await harness.authority.surfaceAssets?.revokeConversation("warmup-nonexistent");

      let inProjectSession = false;
      let burstAdmissionId: string | undefined;
      const origProject = harness.protocol.projectSession.bind(harness.protocol);
      const projectSpy = vi
        .spyOn(harness.protocol, "projectSession")
        .mockImplementation(async (input) => {
          inProjectSession = true;
          return origProject(input);
        });
      harness.setOnBeforeAcquire(async (request) => {
        if (
          inProjectSession &&
          burstAdmissionId === undefined &&
          request.admissionId !== "concurrent-storage-burst" &&
          request.maxWaitMs === 0
        ) {
          burstAdmissionId = request.admissionId;
          await harness.holdAllOccupancySlotsBriefly(40);
        }
      });

      let deleteError: unknown;
      try {
        await harness.application.delete({
          kind: "delete",
          conversationId: created.conversationId,
          operationId: "delete:b402-project-pressure",
          caller: {
            kind: "surface",
            surfacePrincipal: "rpc:owner",
            connectionId: "conn-b402",
          },
        });
      } catch (err) {
        deleteError = err;
      } finally {
        harness.setOnBeforeAcquire(undefined);
        projectSpy.mockRestore();
      }

      expect(burstAdmissionId).toBeDefined();

      if (deleteError !== undefined) {
        // Observe the exact 4-part symptom chain on unmodified production code before failing red:
        const rpcError = toJsonRpcError(deleteError);
        const immediateListAfterFailure = await harness.directory.list();
        const commitsBeforeRecovery = (
          await harness.authority.authorityLog.readAll()
        ).flatMap((c) => c.entries.map((e) => e.body));
        await sleep(55);
        await harness.protocol.recover();
        const listAfterBackgroundRecovery = await harness.directory.list();

        console.error(
          "B402_OBSERVED_PROJECT_PRESSURE",
          JSON.stringify({
            burstAdmissionId,
            errorName:
              deleteError instanceof Error ? deleteError.name : typeof deleteError,
            errorMessage:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
            rpcError: { code: rpcError.code, message: rpcError.message },
            hasCommittedDeleteFact: commitsBeforeRecovery.some(
              (b) =>
                (b as { t?: string; requestId?: string })?.t ===
                  "session-lifecycle" &&
                (b as { requestId?: string })?.requestId ===
                  "delete:b402-project-pressure",
            ),
            hasProjectionBeforeRecovery: commitsBeforeRecovery.some(
              (b) =>
                (b as { kind?: string; requestId?: string })?.kind ===
                  "conversation-lifecycle-projection" &&
                (b as { requestId?: string })?.requestId ===
                  "delete:b402-project-pressure",
            ),
            stillInImmediateSessionList: immediateListAfterFailure.some(
              (item) => item.conversationId === created.conversationId,
            ),
            inSessionListAfterRecoverOnce: listAfterBackgroundRecovery.some(
              (item) => item.conversationId === created.conversationId,
            ),
            internalErrorCodeMatches:
              rpcError.code === RPC_ERROR_CODES.INTERNAL_ERROR,
          }),
        );
      }

      expect(deleteError).toBeUndefined();
      expect(
        (await harness.directory.list()).some(
          (item) => item.conversationId === created.conversationId,
        ),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("completes foreground delete without AggregateError / Internal error when transient capacity pressure hits writeSession", async () => {
    const harness = await createRealAnchorDeleteHarness();
    try {
      const created = await harness.directory.create();
      let inWriteSession = false;
      let burstAdmissionId: string | undefined;
      const origWrite = harness.protocol.writeSession.bind(harness.protocol);
      const writeSpy = vi
        .spyOn(harness.protocol, "writeSession")
        .mockImplementation(async (input) => {
          inWriteSession = true;
          return origWrite(input);
        });
      harness.setOnBeforeAcquire(async (request) => {
        if (
          inWriteSession &&
          burstAdmissionId === undefined &&
          request.admissionId !== "concurrent-storage-burst" &&
          request.maxWaitMs === 0
        ) {
          burstAdmissionId = request.admissionId;
          await harness.holdAllOccupancySlotsBriefly(40);
        }
      });

      let deleteError: unknown;
      try {
        await harness.application.delete({
          kind: "delete",
          conversationId: created.conversationId,
          operationId: "delete:b402-write-pressure",
          caller: {
            kind: "surface",
            surfacePrincipal: "rpc:owner",
            connectionId: "conn-b402",
          },
        });
      } catch (err) {
        deleteError = err;
      } finally {
        harness.setOnBeforeAcquire(undefined);
        writeSpy.mockRestore();
      }

      expect(burstAdmissionId).toBeDefined();

      if (deleteError !== undefined) {
        const rpcError = toJsonRpcError(deleteError);
        console.error(
          "B402_OBSERVED_WRITE_PRESSURE",
          JSON.stringify({
            burstAdmissionId,
            errorName:
              deleteError instanceof Error ? deleteError.name : typeof deleteError,
            errorMessage:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
            rpcError: { code: rpcError.code, message: rpcError.message },
          }),
        );
      }

      expect(deleteError).toBeUndefined();
      expect(
        (await harness.directory.list()).some(
          (item) => item.conversationId === created.conversationId,
        ),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("projects deletion at most once across transient pressure, concurrent background recovery, and same-request re-entry", async () => {
    const harness = await createRealAnchorDeleteHarness();
    try {
      const created = await harness.directory.create();
      await harness.authority.surfaceAssets?.revokeConversation("warmup-nonexistent");

      const deleteStoredSpy = vi.spyOn(
        harness.directory,
        "deleteStoredConversation",
      );
      const revokeSpy = vi.spyOn(
        harness.authority.surfaceAssets!,
        "revokeConversation",
      );
      let inProjectSession = false;
      let triggered = false;
      let notifyFirstPressure!: () => void;
      const firstPressureBarrier = new Promise<void>((resolve) => {
        notifyFirstPressure = resolve;
      });
      // Spawn concurrent recovery from the outer test context after the barrier so it
      // does not inherit FileAuthorityCommitLog's AsyncLocalStorage exclusion context.
      const recoveryConcurrentPromise = firstPressureBarrier.then(async () => {
        expect(isHoldingMaintenanceExclusion()).toBe(false);
        await sleep(40);
        return harness.protocol.recover();
      });
      const origProject = harness.protocol.projectSession.bind(harness.protocol);
      const projectSpy = vi
        .spyOn(harness.protocol, "projectSession")
        .mockImplementation(async (input) => {
          inProjectSession = true;
          expect(isHoldingMaintenanceExclusion()).toBe(false);
          return origProject(input);
        });
      harness.setOnBeforeAcquire(async (request) => {
        if (
          inProjectSession &&
          !triggered &&
          request.admissionId !== "concurrent-storage-burst" &&
          request.maxWaitMs === 0
        ) {
          triggered = true;
          await harness.holdAllOccupancySlotsBriefly(35);
          notifyFirstPressure();
        }
      });

      try {
        const result = await harness.application.delete({
          kind: "delete",
          conversationId: created.conversationId,
          operationId: "delete:b402-concurrent-idempotent",
          caller: {
            kind: "surface",
            surfacePrincipal: "rpc:owner",
            connectionId: "conn-b402",
          },
        });
        expect(result).toMatchObject({ deleted: true });
        await recoveryConcurrentPromise;

        // Re-enter projectSession with the exact same committed requestId after completion:
        const lifecycleEntries = (
          await harness.authority.authorityLog.readStream(
            `run:${created.conversationId}`,
          )
        ).map((entry) => entry.body as { t?: string; kind?: string; domainRevision?: number; requestId?: string });
        const committedFact = lifecycleEntries.find(
          (b) =>
            b.t === "session-lifecycle" &&
            b.requestId === "delete:b402-concurrent-idempotent",
        );
        expect(committedFact?.domainRevision).toBeDefined();

        await harness.protocol.projectSession({
          conversationId: created.conversationId,
          requestId: "delete:b402-concurrent-idempotent",
          mutation: "delete",
          domainRevision: committedFact!.domainRevision!,
        });

        const afterEntries = (
          await harness.authority.authorityLog.readStream(
            `run:${created.conversationId}`,
          )
        ).map((entry) => entry.body as { kind?: string; requestId?: string });
        const projectionCommits = afterEntries.filter(
          (b) =>
            b.kind === "conversation-lifecycle-projection" &&
            b.requestId === "delete:b402-concurrent-idempotent",
        );
        expect(
          revokeSpy.mock.calls.filter(([id]) => id === created.conversationId)
            .length,
        ).toBeGreaterThanOrEqual(2);
        expect(projectionCommits).toHaveLength(1);
        expect(deleteStoredSpy).toHaveBeenCalledTimes(1);
        expect(
          (await harness.directory.list()).some(
            (item) => item.conversationId === created.conversationId,
          ),
        ).toBe(false);
      } finally {
        harness.setOnBeforeAcquire(undefined);
        projectSpy.mockRestore();
        revokeSpy.mockRestore();
        deleteStoredSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("does not retry or swallow parent cancellation, capacity-gap, or permanent projection faults", async () => {
    const harness = await createRealAnchorDeleteHarness();
    try {
      await harness.authority.surfaceAssets?.revokeConversation("warmup-nonexistent");

      // 1) Parent cancellation during backoff aborts immediately without another attempt:
      const cancelledConv = await harness.directory.create();
      const parentAbort = new AbortController();
      const revoke = harness.authority.surfaceAssets!.revokeConversation.bind(
        harness.authority.surfaceAssets!,
      );
      let cancelCalls = 0;
      const revokeCancelSpy = vi
        .spyOn(harness.authority.surfaceAssets!, "revokeConversation")
        .mockImplementation(async (id) => {
          if (id === cancelledConv.conversationId && ++cancelCalls === 1) {
            setTimeout(() => parentAbort.abort(), 5);
            throw new StorageMaintenanceAdmissionError({
              kind: "backpressured",
              blockedBy: "slots",
              retryAfterMs: 200,
            });
          }
          return revoke(id);
        });
      try {
        await expect(
          runWithMaintenanceUrgency(
            () => "foreground",
            parentAbort.signal,
            () =>
              harness.application.delete({
                kind: "delete",
                conversationId: cancelledConv.conversationId,
                operationId: "delete:b402-parent-cancel",
                caller: {
                  kind: "surface",
                  surfacePrincipal: "rpc:owner",
                  connectionId: "conn-b402",
                },
              }),
          ),
        ).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
        expect(cancelCalls).toBe(1);
      } finally {
        revokeCancelSpy.mockRestore();
      }
      // Existing recovery still completes the committed deletion cleanly:
      await harness.protocol.recover();
      expect(await harness.directory.exists(cancelledConv.conversationId)).toBe(
        false,
      );

      // 2) capacity-gap is NOT retryable backpressure and is never retried or swallowed:
      const gapConv = await harness.directory.create();
      const gapError = new StorageMaintenanceAdmissionError({
        kind: "capacity-gap",
        blockedBy: "temporaryBytes",
        required: 2,
        available: 1,
      });
      let gapCalls = 0;
      const revokeGapSpy = vi
        .spyOn(harness.authority.surfaceAssets!, "revokeConversation")
        .mockImplementation(async (id) => {
          if (id === gapConv.conversationId && ++gapCalls === 1) {
            throw gapError;
          }
          return revoke(id);
        });
      try {
        await expect(
          harness.application.delete({
            kind: "delete",
            conversationId: gapConv.conversationId,
            operationId: "delete:b402-capacity-gap",
            caller: {
              kind: "surface",
              surfacePrincipal: "rpc:owner",
              connectionId: "conn-b402",
            },
          }),
        ).rejects.toBe(gapError);
        expect(gapCalls).toBe(1);
      } finally {
        revokeGapSpy.mockRestore();
      }
      await harness.protocol.recover();
      expect(await harness.directory.exists(gapConv.conversationId)).toBe(false);

      // 3) Permanent storage fault is NOT retried and NOT swallowed as deleted=true:
      const permConv = await harness.directory.create();
      const permFault = new Error("permanent-storage-delete-fault");
      let permCalls = 0;
      const deleteFaultSpy = vi
        .spyOn(harness.directory, "deleteStoredConversation")
        .mockImplementationOnce(async () => {
          permCalls += 1;
          throw permFault;
        });
      try {
        await expect(
          harness.application.delete({
            kind: "delete",
            conversationId: permConv.conversationId,
            operationId: "delete:b402-perm-fault",
            caller: {
              kind: "surface",
              surfacePrincipal: "rpc:owner",
              connectionId: "conn-b402",
            },
          }),
        ).rejects.toBe(permFault);
        expect(permCalls).toBe(1);
        expect(await harness.directory.exists(permConv.conversationId)).toBe(true);
      } finally {
        deleteFaultSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("does not report false success or BUSY on sustained >5s backpressure, and existing recovery finishes the accepted delete once pressure clears", async () => {
    const harness = await createRealAnchorDeleteHarness();
    try {
      const created = await harness.directory.create();
      await harness.authority.surfaceAssets?.revokeConversation("warmup-nonexistent");

      let inProjectSession = false;
      let triggered = false;
      const origProject = harness.protocol.projectSession.bind(harness.protocol);
      const projectSpy = vi
        .spyOn(harness.protocol, "projectSession")
        .mockImplementation(async (input) => {
          inProjectSession = true;
          return origProject(input);
        });
      harness.setOnBeforeAcquire(async (request) => {
        if (
          inProjectSession &&
          !triggered &&
          request.admissionId !== "concurrent-storage-burst" &&
          request.maxWaitMs === 0
        ) {
          triggered = true;
          await harness.holdAllOccupancySlotsBriefly(5_250);
        }
      });

      let exhaustedError: unknown;
      try {
        await harness.application.delete({
          kind: "delete",
          conversationId: created.conversationId,
          operationId: "delete:b402-sustained-pressure",
          caller: {
            kind: "surface",
            surfacePrincipal: "rpc:owner",
            connectionId: "conn-b402",
          },
        });
      } catch (err) {
        exhaustedError = err;
      } finally {
        harness.setOnBeforeAcquire(undefined);
        projectSpy.mockRestore();
      }

      expect(exhaustedError).toBeInstanceOf(StorageMaintenanceAdmissionError);
      const rpcError = toJsonRpcError(exhaustedError);
      expect(rpcError.code).not.toBe(RPC_ERROR_CODES.BUSY);
      expect(rpcError.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
      expect(await harness.directory.exists(created.conversationId)).toBe(true);

      // Wait for the 5.25s sustained slot burst to clear, then let existing recovery run:
      await sleep(350);
      await harness.protocol.recover();
      expect(await harness.directory.exists(created.conversationId)).toBe(false);
      expect(
        (await harness.directory.list()).some(
          (item) => item.conversationId === created.conversationId,
        ),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
