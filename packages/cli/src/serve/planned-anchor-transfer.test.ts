import { rm } from "node:fs/promises";
import path from "node:path";
import type {
  DeviceIdentity,
  SecretRef,
  SecretStorePort,
  Signature,
} from "@zhixing/core/contracts";
import {
  createSignedAnchorTransferAbort,
  createSignedAnchorTransferCommand,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import {
  currentMaintenanceAbortSignal,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
  type DeviceCapacityPolicy,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type {
  MeshServiceDefinition,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import { DeviceKey, enrollDeviceIdentity, verifyDeviceSignature } from "@zhixing/mesh/device-identity";
import {
  loadActiveAnchorIssuerKey,
  loadAnchorIssuerKey,
} from "@zhixing/mesh/device-key-store";
import { createSignedTrustEvent } from "@zhixing/mesh/trust-chain";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import {
  FilePlannedAnchorTransferJournal,
  PlannedAnchorTransferOwner,
  PlannedAnchorTransferRuntimeLifecycle,
  PlannedAnchorTransferTarget,
  completePlannedAnchorInstallationBeforeBootstrap,
  type PlannedAnchorTransferTargetPort,
  type PlannedAnchorCandidateRelease,
} from "./planned-anchor-transfer.js";
import {
  PlannedAnchorTransferMeshClient,
  reconcilePlannedAnchorTrustFromPeer,
  registerPlannedAnchorTrustReconciliationService,
  registerPlannedAnchorTransferMeshServices,
} from "./planned-anchor-transfer-mesh.js";
import {
  createPlannedAnchorReadinessCoordinator,
  type PlannedAnchorReadySnapshot,
} from "../setup-delivery.js";

const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const TRANSFER_ID = "xfer-01J00000000000000000000001";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("planned anchor transfer prepared phase", {
  timeout: DURABLE_IO_TEST_TIMEOUT_MS,
}, () => {
  it("durably binds one ready target and one transfer-local issuer key on both logs", async () => {
    const fixture = await createFixture();
    const first = await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    const replay = await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });

    expect(first.phase).toBe("prepared");
    expect(replay.readyProof.targetIssuerKeyId).toBe(first.readyProof.targetIssuerKeyId);
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect((await fixture.targetJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect(first.trustTransition.body.toIssuerPublicKey)
      .toBe(first.readyProof.targetIssuerPublicKey);
    expect(await fixture.sourceStore.loadTrustProjection()).toEqual(fixture.sourceTrust);
    expect(await fixture.targetStore.loadTrustProjection()).toEqual(fixture.sourceTrust);
  });

  it("rejects an overlapping migration before closing source admission", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-1",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await expect(fixture.owner.prepare({
      requestId: "request-2",
      transferId: "xfer-01J00000000000000000000002",
      targetDeviceId: fixture.targetKey.deviceId,
    })).rejects.toThrow("already in progress");
  });

  it("claims one candidate durably across concurrent source and target transfers", async () => {
    const fixture = await createFixture();
    const transferA = TRANSFER_ID;
    const transferB = "xfer-01J00000000000000000000002";
    const sourceResults = await Promise.allSettled([
      fixture.owner.prepare({
        requestId: "request-source-a",
        transferId: transferA,
        targetDeviceId: fixture.targetKey.deviceId,
      }),
      fixture.createOwner().prepare({
        requestId: "request-source-b",
        transferId: transferB,
        targetDeviceId: fixture.targetKey.deviceId,
      }),
    ]);
    expect(sourceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sourceResults.filter((result) => result.status === "rejected")).toHaveLength(1);

    const isolated = await createFixture();
    const candidate = (requestId: string, transferId: string) => ({
      homeId: isolated.sourceTrust.homeId,
      requestId,
      transferId,
      sourceDeviceId: isolated.sourceKey.deviceId,
      targetDeviceId: isolated.targetKey.deviceId,
      trustEpoch: isolated.sourceTrust.trustEpoch,
      trustChainHead: isolated.sourceTrust.chainHead,
      sourceAnchorEpoch: 1,
    });
    const targetResults = await Promise.allSettled([
      isolated.target.ready({ candidate: candidate("request-target-a", transferA) }),
      isolated.target.ready({ candidate: candidate("request-target-b", transferB) }),
    ]);
    expect(targetResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(targetResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const loser = targetResults[0]!.status === "rejected" ? transferA : transferB;
    expect(await loadAnchorIssuerKey(isolated.secrets, loser)).toBeNull();
  });

  it("durably releases a claim-only candidate after a lost ready response", async () => {
    const fixture = await createFixture();
    let loseReady = true;
    const lossyTarget: PlannedAnchorTransferTargetPort = {
      summary: () => fixture.target.summary(),
      ready: async (input) => {
        const proof = await fixture.target.ready(input);
        if (loseReady) {
          loseReady = false;
          throw new Error("simulated ready response loss");
        }
        return proof;
      },
      releaseCandidate: (input) => fixture.target.releaseCandidate(input),
      apply: (command) => fixture.target.apply(command),
    };
    const owner = fixture.createOwner(lossyTarget);
    await expect(owner.prepare({
      requestId: "request-claim-only",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    })).rejects.toThrow("simulated ready response loss");
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).not.toBeNull();

    await expect(owner.abort({
      requestId: "request-claim-only",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).resolves.toBeUndefined();
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).toBeNull();
    await expect(owner.abort({
      requestId: "request-claim-only",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).resolves.toBeUndefined();
  });

  it("orders claim-only cancellation before the first prepared record in one source transaction", async () => {
    const fixture = await createFixture();
    let releaseReady!: () => void;
    let readyReached!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      readyReached = resolve;
    });
    const delayedTarget: PlannedAnchorTransferTargetPort = {
      summary: () => fixture.target.summary(),
      ready: async (input) => {
        const proof = await fixture.target.ready(input);
        readyReached();
        await readyGate;
        return proof;
      },
      releaseCandidate: (input) => fixture.target.releaseCandidate(input),
      apply: (command) => fixture.target.apply(command),
    };
    const owner = fixture.createOwner(delayedTarget);
    const preparing = owner.prepare({
      requestId: "request-cancel-wins",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await reached;
    await expect(owner.abort({
      requestId: "request-cancel-wins",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).resolves.toBeUndefined();
    releaseReady();
    await expect(preparing).rejects.toThrow("Terminal migration candidate cannot be prepared");
    expect(await fixture.sourceJournal.state(TRANSFER_ID)).toBeUndefined();
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).toBeNull();
  });

  it("rejects a delayed claim-only release after target restart once prepare is durable", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-prepared-wins",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    const identity = {
      homeId: fixture.sourceTrust.homeId,
      requestId: "request-prepared-wins",
      transferId: TRANSFER_ID,
      sourceDeviceId: fixture.sourceKey.deviceId,
      targetDeviceId: fixture.targetKey.deviceId,
      trustEpoch: fixture.sourceTrust.trustEpoch,
      trustChainHead: fixture.sourceTrust.chainHead,
      sourceAnchorEpoch: 1,
    };
    const payload = {
      v: 1 as const,
      t: "planned-anchor-candidate-release" as const,
      identity,
      reason: "operator-cancelled" as const,
    };
    const release: PlannedAnchorCandidateRelease = {
      ...payload,
      signature: fixture.sourceKey.sign("PlannedAnchorCandidateRelease", 1, payload),
    };
    const restartedTarget = fixture.createTarget();
    await expect(restartedTarget.releaseCandidate(release)).rejects.toThrow(
      "Prepared migration candidate requires a signed transfer abort",
    );
    expect((await fixture.targetJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).not.toBeNull();
  });

  it("durably aborts source-prepared target-claim-only state before cleanup and across restarts", async () => {
    const fixture = await createFixture();
    let activeTarget = fixture.target;
    let blockRemotePrepare = true;
    let loseAbortResponse = true;
    const interruptedTarget: PlannedAnchorTransferTargetPort = {
      summary: () => activeTarget.summary(),
      ready: (input) => activeTarget.ready(input),
      releaseCandidate: (input) => activeTarget.releaseCandidate(input),
      apply: async (command) => {
        if (command.op === "prepare" && blockRemotePrepare) {
          blockRemotePrepare = false;
          throw new Error("simulated remote prepare effect failure");
        }
        const result = await activeTarget.apply(command);
        if (command.op === "abort" && loseAbortResponse) {
          loseAbortResponse = false;
          throw new Error("simulated abort response loss");
        }
        return result;
      },
    };
    const owner = fixture.createOwner(interruptedTarget);
    await expect(owner.prepare({
      requestId: "request-claim-abort",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    })).rejects.toThrow("simulated remote prepare effect failure");
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("prepared");
    expect(await fixture.targetJournal.state(TRANSFER_ID)).toBeUndefined();
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).not.toBeNull();

    const wrongAbort = createSignedAnchorTransferAbort({
      v: 1,
      requestId: "request-wrong",
      transferId: TRANSFER_ID,
      sourceDeviceId: fixture.sourceKey.deviceId,
      targetDeviceId: fixture.targetKey.deviceId,
      sourceAnchorEpoch: 1,
      reason: "operator-cancelled",
      at: AT,
    }, fixture.sourceKey);
    const wrongCommand = createSignedAnchorTransferCommand({
      v: 1,
      op: "abort",
      requestId: "request-wrong",
      transferId: TRANSFER_ID,
      abort: wrongAbort,
    }, fixture.sourceKey);
    await expect(activeTarget.apply(wrongCommand)).rejects.toThrow(
      "changes its durable candidate identity",
    );
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).not.toBeNull();

    activeTarget = fixture.createTarget(
      fixture.readiness.port,
      () => NOW + 24 * 60 * 60 * 1_000,
    );
    await expect(owner.abort({
      requestId: "request-claim-abort",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).rejects.toThrow("simulated abort response loss");
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("aborted");
    expect(await fixture.targetJournal.state(TRANSFER_ID)).toBeUndefined();
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).toBeNull();

    activeTarget = fixture.createTarget(
      fixture.readiness.port,
      () => NOW + 24 * 60 * 60 * 1_000,
    );
    await activeTarget.recoverBeforeAdmission();
    await fixture.createTarget(
      fixture.readiness.port,
      () => NOW + 48 * 60 * 60 * 1_000,
    ).recoverBeforeAdmission();
    const restartedOwner = fixture.createOwner(interruptedTarget);
    await restartedOwner.recoverBeforeAdmission();
    await expect(restartedOwner.abort({
      requestId: "request-claim-abort",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).resolves.toMatchObject({ phase: "aborted" });

    activeTarget = fixture.createTarget();
    await expect(restartedOwner.prepare({
      requestId: "request-next",
      transferId: "xfer-01J00000000000000000000002",
      targetDeviceId: fixture.targetKey.deviceId,
    })).resolves.toMatchObject({ phase: "prepared" });
  }, 10_000);

  it("crosses the strict mesh service and authorizes only the current source", async () => {
    const fixture = await createFixture();
    const definitions = new Map<string, MeshServiceDefinition>();
    const registry = {
      register(serviceId: string, definition: MeshServiceDefinition) {
        definitions.set(serviceId, definition);
        return () => definitions.delete(serviceId);
      },
    } as MeshServiceRegistry;
    registerPlannedAnchorTransferMeshServices(registry, {
      target: () => fixture.target,
      targetDeviceId: fixture.targetKey.deviceId,
      currentSourceDeviceId: () => fixture.sourceKey.deviceId,
      verifier: fixture.verifier,
    });
    const sourceConnection = {
      peer: { deviceId: fixture.sourceKey.deviceId },
    } as unknown as SecureMeshConnection;
    const client = new PlannedAnchorTransferMeshClient({
      request: async (serviceId, payload, signal) => {
        const service = definitions.get(serviceId);
        if (!service || service.authorize?.(sourceConnection) === false) {
          throw new Error("unauthorized test service");
        }
        return service.handler(
          payload,
          sourceConnection,
          signal ?? new AbortController().signal,
        );
      },
    }, fixture.sourceKey.deviceId, fixture.targetKey.deviceId, fixture.verifier);
    const owner = new PlannedAnchorTransferOwner({
      deviceId: fixture.sourceKey.deviceId,
      anchorEpoch: () => 1,
      identityKey: fixture.sourceKey,
      bootstrapStore: fixture.sourceStore,
      log: fixture.sourceStore.authorityLog(),
      signer: fixture.sourceKey,
      verifier: fixture.verifier,
      targetFor: () => client,
      artifacts: fixture.sourceStore.artifactStore(),
      retention: fixture.sourceStore.checkpointRetention(),
      ensureRecoveryCheckpoint: async () => digest("mesh-recovery"),
      lifecycle: noOpLifecycle(),
    });

    expect((await owner.prepare({
      requestId: "request-mesh",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    })).phase).toBe("prepared");
    const ready = definitions.get("anchor.transfer.ready")!;
    expect(ready.authorize?.({
      peer: { deviceId: fixture.targetKey.deviceId },
    } as unknown as SecureMeshConnection)).toBe(false);
  });

  it("drains accepted work before freezing one durable source prefix and reinstalls the fence", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-fence",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    fixture.onDrain.current = async () => {
      await fixture.sourceStore.authorityLog().append([
        {
          stream: "assignment:assignment-accepted",
          body: { t: "received" },
        },
        {
          stream: "assignment:assignment-accepted",
          body: { t: "interaction-requested", requestId: "interaction-accepted" },
        },
        {
          stream: "control",
          body: { t: "confirmation-requested", requestId: "confirm-accepted" },
        },
        {
          stream: "intent:intent-accepted",
          body: {
            t: "intent",
            intent: { intentId: "intent-accepted", status: "pending" },
          },
        },
        {
          stream: "final-outbox",
          body: {
            t: "final",
            conversationId: "conversation-accepted",
            runId: "run-accepted",
            commitRevision: 1,
            state: "pending",
          },
        },
        {
          stream: "delivery",
          body: { t: "enqueued", itemId: "delivery-accepted" },
        },
      ]);
    };

    const checkpoint = await fixture.owner.fence({
      requestId: "request-fence",
      transferId: TRANSFER_ID,
    });

    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("fenced");
    expect(checkpoint).toEqual(await fixture.sourceStore.authorityLog().checkpoint());
    const closureRecord = (await fixture.sourceStore.authorityLog()
      .readStream<Record<string, unknown>>("transfer:anchor-closure")).at(-1)?.body;
    const closureRef = closureRecord?.closure as { digest: string; bytes: number };
    const closure = JSON.parse(Buffer.from(
      await fixture.sourceStore.artifactStore().get(closureRef),
    ).toString("utf8")) as {
      acceptedTokens: unknown[];
      pendingObligations: unknown[];
    };
    expect(closure.pendingObligations).toEqual([
      { kind: "assignment", id: "assignment-accepted" },
      { kind: "confirmation", id: "confirm-accepted" },
      { kind: "delivery", id: "delivery-accepted" },
      {
        kind: "final",
        id: "conversation-accepted:run-accepted:1",
      },
      { kind: "intent", id: "intent-accepted" },
      { kind: "interaction", id: "interaction-accepted" },
    ]);
    expect(closure.acceptedTokens).toEqual(
      closure.pendingObligations.map((obligation: { kind: string; id: string }) => ({
        transferId: TRANSFER_ID,
        kind: obligation.kind,
        id: obligation.id,
        requestId: `planned-accepted:${obligation.kind}:${obligation.id}`,
      })),
    );
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "run:test", body: { fresh: true } },
    ])).rejects.toThrow("frozen authority writes");

    const restarted = fixture.createOwner();
    await restarted.recoverBeforeAdmission();
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { fresh: true } },
    ])).rejects.toThrow("frozen authority writes");
  }, 10_000);

  it("linearizes the source append fence after accepted writes and before fresh writes", async () => {
    const fixture = await createFixture();
    const log = fixture.sourceStore.authorityLog();
    const accepted = log.append([
      { stream: "control", body: { requestId: "accepted-before-fence" } },
    ]);
    const install = log.installAppendAdmissionGuard(() => {
      throw new Error("planned source fence rejects fresh authority writes");
    });
    const fresh = log.append([
      { stream: "control", body: { requestId: "fresh-after-fence" } },
    ]);

    await expect(accepted).resolves.toBeDefined();
    const dispose = await install;
    await expect(fresh).rejects.toThrow("rejects fresh authority writes");
    expect((await log.readStream<{ requestId: string }>("control")).map((entry) =>
      entry.body.requestId)).toContain("accepted-before-fence");
    dispose();
  });

  it("exports one catalog-bound prefix and imports it only into target-private staging", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-import",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });

    const imported = await fixture.owner.freeze({
      requestId: "request-import",
      transferId: TRANSFER_ID,
    });

    expect(imported.phase).toBe("imported");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("imported");
    expect(imported.catalog?.coverage).toEqual([
      "conversation-authority",
      "conversation-content",
      "execution-assets",
      "global-authority",
      "pending-obligations",
      "trust-and-anchor",
    ]);
    expect(await fixture.targetStore.artifactStore().has(imported.checkpoint!)).toBe(false);
    expect(await fixture.targetStore.artifactStore().has(imported.catalogRef!)).toBe(false);
  }, 10_000);

  it("commits once on the source and atomically installs the migrated authority on the target", async () => {
    const fixture = await createFixture();
    const retainedBytes = Buffer.from("shared-retained-authority", "utf8");
    const retainedRef = await fixture.sourceStore.artifactStore().put(retainedBytes);
    await fixture.targetStore.artifactStore().put(retainedBytes);
    await fixture.sourceStore.authorityLog().append([
      {
        stream: "control",
        body: { t: "test-authority-base", value: "preserved", retainedRef },
      },
    ]);
    await fixture.owner.prepare({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    const imported = await fixture.owner.freeze({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });

    const committed = await fixture.owner.commit({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });
    const replay = await fixture.owner.commit({
      requestId: "request-commit",
      transferId: TRANSFER_ID,
    });

    expect(committed.phase).toBe("committed");
    expect(replay.commit).toEqual(committed.commit);
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("committed");
    const targetTrust = await fixture.targetStore.loadTrustRecord();
    expect(targetTrust?.issuer.deviceId).toBe(fixture.targetKey.deviceId);
    expect(targetTrust?.issuer.issuerKeyId).toBe(committed.readyProof.targetIssuerKeyId);
    expect(targetTrust?.trustEpoch).toBe(fixture.sourceTrust.trustEpoch + 1);
    expect((await loadActiveAnchorIssuerKey(
      fixture.secrets,
      committed.readyProof.targetIssuerKeyId,
    ))?.publicKey).toBe(committed.readyProof.targetIssuerPublicKey);
    expect(await fixture.targetStore.artifactStore().has(imported.checkpoint!)).toBe(true);
    expect(await fixture.targetStore.artifactStore().has(imported.catalogRef!)).toBe(true);
    expect(imported.catalog?.retainedArtifacts).toContainEqual(retainedRef);
    expect(await fixture.targetStore.artifactStore().has(retainedRef)).toBe(true);
    expect((await fixture.targetStore.authorityLog().readStream("control"))
      .some((entry) => (entry.body as { t?: string }).t === "test-authority-base"))
      .toBe(true);
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { staleSource: true } },
    ])).rejects.toThrow("frozen authority writes");
  }, 120_000);

  it("holds the target readiness revision across the source commit window", async () => {
    const fixture = await createFixture();
    const prepared = await fixture.owner.prepare({
      requestId: "request-reservation",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await fixture.owner.freeze({
      requestId: "request-reservation",
      transferId: TRANSFER_ID,
    });
    await fixture.target.ready({
      candidate: {
        homeId: prepared.readyProof.homeId,
        requestId: prepared.identity.requestId,
        transferId: prepared.identity.transferId,
        sourceDeviceId: prepared.identity.sourceDeviceId,
        targetDeviceId: prepared.identity.targetDeviceId,
        trustEpoch: prepared.readyProof.trustEpoch,
        trustChainHead: prepared.readyProof.trustChainHead,
        sourceAnchorEpoch: prepared.identity.sourceAnchorEpoch,
      },
    });

    const restartedReadiness = createPlannedAnchorReadinessCoordinator(async () =>
      fixture.readinessSnapshot.current);
    const restartedTarget = fixture.createTarget(restartedReadiness.port);
    await restartedTarget.recoverBeforeAdmission();
    await expect(restartedReadiness.runRevisionChange(async () => {}))
      .rejects.toThrow("reserved by a duty-device migration");

    await expect(fixture.readiness.runRevisionChange(async () => {
      fixture.readinessSnapshot.current = {
        ...fixture.readinessSnapshot.current,
        assetRevision: "assets-v2",
      };
    })).rejects.toThrow("reserved by a duty-device migration");
    expect(fixture.readinessSnapshot.current.assetRevision).toBe("assets-v1");

    await fixture.owner.commit({
      requestId: "request-reservation",
      transferId: TRANSFER_ID,
    });
    await fixture.readiness.runRevisionChange(async () => {
      fixture.readinessSnapshot.current = {
        ...fixture.readinessSnapshot.current,
        assetRevision: "assets-v2",
      };
    });
    expect(fixture.readinessSnapshot.current.assetRevision).toBe("assets-v2");
  }, 10_000);

  it("checks ready-proof expiry inside the source commit transaction", async () => {
    const fixture = await createFixture();
    let sourceNow = AT;
    const expiringTarget: PlannedAnchorTransferTargetPort = {
      summary: () => fixture.target.summary(),
      ready: async (input) => {
        const proof = await fixture.target.ready(input);
        sourceNow = proof.expiresAt;
        return proof;
      },
      releaseCandidate: (input) => fixture.target.releaseCandidate(input),
      apply: (command) => fixture.target.apply(command),
    };
    const owner = fixture.createOwner(expiringTarget, () => sourceNow);
    await owner.prepare({
      requestId: "request-expiry",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await owner.freeze({ requestId: "request-expiry", transferId: TRANSFER_ID });

    await expect(owner.commit({
      requestId: "request-expiry",
      transferId: TRANSFER_ID,
    })).rejects.toThrow("expired before source commit");
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("imported");
    await expect(owner.abort({
      requestId: "request-expiry",
      transferId: TRANSFER_ID,
      reason: "target-rejected",
    })).resolves.toMatchObject({ phase: "aborted" });
  }, 10_000);

  it("durably cancels before commit, clears private state, and reopens the source", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-abort",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await fixture.owner.freeze({ requestId: "request-abort", transferId: TRANSFER_ID });

    const aborted = await fixture.owner.abort({
      requestId: "request-abort",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    });

    expect(aborted.phase).toBe("aborted");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("aborted");
    expect(await loadAnchorIssuerKey(fixture.secrets, TRANSFER_ID)).toBeNull();
    await expect(fixture.sourceStore.authorityLog().append([
      { stream: "control", body: { sourceResumed: true } },
    ])).resolves.toBeDefined();
  }, 10_000);

  it("keeps the source fenced and replays forward after a lost target commit response", async () => {
    const fixture = await createFixture();
    const committedTargets: string[] = [];
    let loseCommitResponse = true;
    const lossyTarget: PlannedAnchorTransferTargetPort = {
      summary: () => fixture.target.summary(),
      ready: (input) => fixture.target.ready(input),
      releaseCandidate: (input) => fixture.target.releaseCandidate(input),
      apply: async (command) => {
        const result = await fixture.target.apply(command);
        if (command.op === "commit" && loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error("simulated response loss");
        }
        return result;
      },
    };
    const owner = fixture.createOwner(
      lossyTarget,
      undefined,
      (targetDeviceId) => committedTargets.push(targetDeviceId),
    );
    await owner.prepare({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await owner.freeze({ requestId: "request-recover", transferId: TRANSFER_ID });
    await expect(owner.commit({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
    })).rejects.toThrow("simulated response loss");
    expect((await fixture.sourceJournal.state(TRANSFER_ID))?.phase).toBe("committed");
    expect((await fixture.target.state(TRANSFER_ID))?.phase).toBe("committed");
    expect(committedTargets).toEqual([fixture.targetKey.deviceId]);

    const recoveredTargets: string[] = [];
    const restarted = fixture.createOwner(
      fixture.target,
      undefined,
      (targetDeviceId) => recoveredTargets.push(targetDeviceId),
    );
    await restarted.recoverBeforeAdmission();
    expect(recoveredTargets).toContain(fixture.targetKey.deviceId);
    await expect(restarted.commit({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
    })).resolves.toMatchObject({ phase: "committed" });
    await expect(restarted.abort({
      requestId: "request-recover",
      transferId: TRANSFER_ID,
      reason: "operator-cancelled",
    })).rejects.toThrow("only move forward");
  }, 10_000);

  it("does not hold target capacity while a fixed artifact range waits on the network", async () => {
    const targetGovernor = governor();
    const fixture = await createFixture({ targetStorageMaintenance: targetGovernor });
    await fixture.owner.prepare({
      requestId: "request-capacity",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    let releaseNetwork!: () => void;
    const network = new Promise<void>((resolve) => {
      releaseNetwork = resolve;
    });
    let enteredNetwork!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredNetwork = resolve;
    });
    fixture.sourceArtifactCommand.current = async (command) => {
      enteredNetwork();
      await network;
      return fixture.owner.applyArtifactCommand(command);
    };

    const freezing = fixture.owner.freeze({
      requestId: "request-capacity",
      transferId: TRANSFER_ID,
    });
    await entered;
    expect(targetGovernor.snapshot().inFlight["authority-checkpoint"] ?? 0).toBe(0);
    releaseNetwork();
    await freezing;
    expect(targetGovernor.snapshot().inFlight["authority-checkpoint"] ?? 0).toBe(0);
  }, 10_000);

  it("closes the planned runtime once, cancels in-flight I/O and rejects later work", async () => {
    const lifecycle = new PlannedAnchorTransferRuntimeLifecycle();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const running = lifecycle.run(async () => {
      const signal = currentMaintenanceAbortSignal();
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await started;
    const first = lifecycle.close();
    const replay = lifecycle.close();
    expect(replay).toBe(first);
    await expect(running).rejects.toThrow("stopping");
    await expect(first).resolves.toBeUndefined();
    await expect(lifecycle.run(async () => undefined)).rejects.toThrow("stopping");
  });

  it("reconciles one missed planned issuer transition to a stale active peer", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-peer",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await fixture.owner.freeze({ requestId: "request-peer", transferId: TRANSFER_ID });
    await fixture.owner.commit({ requestId: "request-peer", transferId: TRANSFER_ID });

    const definitions = new Map<string, MeshServiceDefinition>();
    const registry = {
      register(serviceId: string, definition: MeshServiceDefinition) {
        definitions.set(serviceId, definition);
        return () => definitions.delete(serviceId);
      },
    } as MeshServiceRegistry;
    registerPlannedAnchorTrustReconciliationService(registry, {
      store: fixture.targetStore,
      authorizePeer: (deviceId) => deviceId === fixture.peerKey.deviceId,
    });
    const connection = {
      peer: { deviceId: fixture.peerKey.deviceId },
    } as unknown as SecureMeshConnection;
    const client = {
      request: async (serviceId: string, payload: Uint8Array) => {
        const service = definitions.get(serviceId);
        if (!service || service.authorize?.(connection) === false) {
          throw new Error("unauthorized test service");
        }
        return service.handler(payload, connection, new AbortController().signal);
      },
    };

    const first = await reconcilePlannedAnchorTrustFromPeer(client, {
      store: fixture.peerStore,
      localDeviceId: fixture.peerKey.deviceId,
    });
    const replay = await reconcilePlannedAnchorTrustFromPeer(client, {
      store: fixture.peerStore,
      localDeviceId: fixture.peerKey.deviceId,
    });
    expect(first.issuer.deviceId).toBe(fixture.targetKey.deviceId);
    expect(replay).toEqual(first);
    expect((await fixture.peerStore.loadTrustEvents()).at(-1)?.body).toMatchObject({
      t: "issuer-transition",
      reason: "migration",
      toDeviceId: fixture.targetKey.deviceId,
    });
  }, 120_000);

  it("replays an installed target before bootstrap after active-key activation fails", async () => {
    const fixture = await createFixture();
    await fixture.owner.prepare({
      requestId: "request-pre-bootstrap",
      transferId: TRANSFER_ID,
      targetDeviceId: fixture.targetKey.deviceId,
    });
    await fixture.owner.freeze({
      requestId: "request-pre-bootstrap",
      transferId: TRANSFER_ID,
    });
    fixture.secrets.failActivePutOnce = true;

    await expect(fixture.owner.commit({
      requestId: "request-pre-bootstrap",
      transferId: TRANSFER_ID,
    })).rejects.toThrow("simulated active issuer activation failure");
    const imported = await fixture.target.state(TRANSFER_ID);
    const issuerKeyId = imported?.readyProof.targetIssuerKeyId;
    if (!issuerKeyId) throw new Error("expected imported target issuer identity");
    expect(await loadActiveAnchorIssuerKey(fixture.secrets, issuerKeyId)).toBeNull();
    expect(await fixture.targetStore.authorityLog().readStream(
      "transfer:anchor-current",
    )).toHaveLength(1);
    expect(imported?.phase).toBe("imported");

    const complete = () => completePlannedAnchorInstallationBeforeBootstrap({
      zhixingHome: fixture.targetRoot,
      deviceId: fixture.targetKey.deviceId,
      secretStore: fixture.secrets,
      bootstrapStore: fixture.targetStore,
      verifier: fixture.verifier,
      stagingRoot: path.join(fixture.targetRoot, "anchor-transfer-staging"),
    });
    const recovered = await complete();
    const replay = await complete();
    expect(recovered?.installation.transferId).toBe(TRANSFER_ID);
    expect(recovered?.state.phase).toBe("committed");
    expect(recovered?.requiresPostInstallCompletion).toBe(true);
    expect(recovered?.installedGeneration).toMatchObject({
      transferId: TRANSFER_ID,
      anchorEpoch: 2,
      trustEpoch: recovered?.installation.trustRecord.trustEpoch,
      targetLogId: (await fixture.targetStore.authorityLog().originCheckpoint()).logId,
    });
    expect(replay).toEqual(recovered);
    await rm(path.join(
      fixture.targetRoot,
      "anchor-transfer-staging",
      "transfers",
      TRANSFER_ID,
    ), { recursive: true, force: true });
    const afterPrivateCleanup = await complete();
    expect(afterPrivateCleanup?.requiresPostInstallCompletion).toBe(false);
    expect(afterPrivateCleanup?.installedGeneration).toEqual(recovered?.installedGeneration);
    expect((await loadActiveAnchorIssuerKey(
      fixture.secrets,
      issuerKeyId,
    ))?.deviceId).toBe(issuerKeyId);
  }, 120_000);
});

async function createFixture(options: {
  readonly sourceStorageMaintenance?: StorageMaintenanceGovernorPort;
  readonly targetStorageMaintenance?: StorageMaintenanceGovernorPort;
} = {}) {
  const targets = new Set<PlannedAnchorTransferTarget>();
  const stores: FileMeshBootstrapStore[] = [];
  const sourceRoot = await temporary("anchor-source");
  const targetRoot = await temporary("anchor-target");
  const sourceKey = await DeviceKey.generate();
  const targetKey = await DeviceKey.generate();
  const peerKey = await DeviceKey.generate();
  const identities = new Map<string, DeviceIdentity>();
  const sourceIdentity = enroll(sourceKey, "source");
  const targetIdentity = enroll(targetKey, "target");
  const peerIdentity = enroll(peerKey, "peer");
  identities.set(sourceIdentity.deviceId, sourceIdentity);
  identities.set(targetIdentity.deviceId, targetIdentity);
  identities.set(peerIdentity.deviceId, peerIdentity);
  const verifier: ProtocolSignatureVerifier = {
    verify: (schemaId: string, version: number, payload: unknown, signature: Signature) => {
      const identity = identities.get(signature.keyId);
      if (!identity) throw new TypeError("Unknown test signer");
      verifyDeviceSignature(identity, schemaId, version, payload, signature);
    },
  };
  const sourceStore = new FileMeshBootstrapStore(sourceRoot, sourceKey);
  const targetStore = new FileMeshBootstrapStore(targetRoot, targetKey);
  const peerRoot = await temporary("anchor-peer");
  onTestFinished(async () => {
    const settled = await Promise.allSettled([
      ...[...targets].map((target) => target.close()),
      ...stores.map((store) => store.stopStorageMaintenance()),
    ]);
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  const peerStore = new FileMeshBootstrapStore(peerRoot, peerKey);
  stores.push(sourceStore, targetStore, peerStore);
  let initialized = await sourceStore.initializeLocalHome({
    key: sourceKey,
    identity: sourceIdentity,
    roles: ["anchor"],
    at: AT,
    homeId: "home-1",
  });
  const enrollTarget = createSignedTrustEvent({
    current: initialized.projection,
    signer: sourceKey,
    at: AT,
    body: { t: "enroll", device: targetIdentity, roles: ["anchor"] },
  });
  let sourceTrust = await sourceStore.appendTrustEvent({
    event: enrollTarget,
    issuerKey: sourceKey,
  });
  const enrollPeer = createSignedTrustEvent({
    current: sourceTrust,
    signer: sourceKey,
    at: AT,
    body: { t: "enroll", device: peerIdentity, roles: ["executor"] },
  });
  sourceTrust = await sourceStore.appendTrustEvent({
    event: enrollPeer,
    issuerKey: sourceKey,
  });
  await targetStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: (await sourceStore.loadTrustRecord())!,
    localDeviceId: targetKey.deviceId,
  });
  await peerStore.importTrustBootstrap({
    events: await sourceStore.loadTrustEvents(),
    record: (await sourceStore.loadTrustRecord())!,
    localDeviceId: peerKey.deviceId,
  });
  const secrets = new MemoryStore();
  const readinessSnapshot: { current: PlannedAnchorReadySnapshot } = {
    current: {
      configuredCapabilities: { providers: [], mcpServers: [], channels: [] },
      protocolRevision: "protocol-v1",
      assetRevision: "assets-v1",
      serviceRevision: "services-v1",
      credentialRevision: "credentials-v1",
    },
  };
  const readiness = createPlannedAnchorReadinessCoordinator(async () =>
    readinessSnapshot.current);
  let owner!: PlannedAnchorTransferOwner;
  const sourceArtifactCommand = {
    current: (command: Parameters<PlannedAnchorTransferOwner["applyArtifactCommand"]>[0]) =>
      owner.applyArtifactCommand(command),
  };
  const createTarget = (
    readinessPort: import("../setup-delivery.js").PlannedAnchorReadinessPort = readiness.port,
    now: () => number = () => NOW,
  ) => {
    const target = new PlannedAnchorTransferTarget({
      deviceId: targetKey.deviceId,
      identityKey: targetKey,
      secretStore: secrets,
      bootstrapStore: targetStore,
      authorityLog: targetStore.authorityLog(),
      artifacts: targetStore.artifactStore(),
      stagingRoot: path.join(targetRoot, "anchor-transfer-staging"),
      sourceFor: () => ({
        applyArtifactCommand: (command) => sourceArtifactCommand.current(command),
      }),
      storageMaintenance: options.targetStorageMaintenance,
      signer: targetKey,
      verifier,
      readiness: readinessPort,
      now,
    });
    targets.add(target);
    return target;
  };
  const target = createTarget();
  const onDrain = { current: async () => {} };
  const createOwner = (
    targetPort: PlannedAnchorTransferTargetPort = target,
    now?: () => string,
    onSourceCommitted?: (targetDeviceId: string) => void,
  ) => new PlannedAnchorTransferOwner({
      deviceId: sourceKey.deviceId,
      anchorEpoch: () => 1,
      identityKey: sourceKey,
      bootstrapStore: sourceStore,
      log: sourceStore.authorityLog(),
      signer: sourceKey,
      verifier,
      targetFor: () => targetPort,
      artifacts: sourceStore.artifactStore(),
      retention: sourceStore.checkpointRetention(),
      storageMaintenance: options.sourceStorageMaintenance,
      ensureRecoveryCheckpoint: async () => digest("verified-recovery"),
      lifecycle: {
        stopAccepting: () => {},
        drainAccepted: () => onDrain.current(),
        resumeAfterAbort: () => {},
      },
      onSourceCommitted,
      now,
    });
  owner = createOwner();
  return {
    sourceRoot, targetRoot,
    sourceKey, targetKey, peerKey, sourceStore, targetStore, peerStore, sourceTrust, secrets,
    owner, createOwner, onDrain, readiness, readinessSnapshot, sourceArtifactCommand,
    target, createTarget,
    verifier,
    sourceJournal: new FilePlannedAnchorTransferJournal(sourceStore.authorityLog(), verifier),
    targetJournal: { state: (transferId: string) => target.state(transferId) },
  };
}

function enroll(key: DeviceKey, displayName: string) {
  return enrollDeviceIdentity(key, { displayName, platform: "linux", enrolledAt: AT });
}

async function temporary(label: string) {
  return createTempDir(label);
}

class MemoryStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  failActivePutOnce = false;
  async put(ref: SecretRef, value: string) {
    if (
      this.failActivePutOnce &&
      ref.kind === "device-key" &&
      ref.bindingId.startsWith("anchor-issuer-active/v1/")
    ) {
      this.failActivePutOnce = false;
      throw new Error("simulated active issuer activation failure");
    }
    this.values.set(id(ref), value);
  }
  async get(ref: SecretRef) { return this.values.get(id(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(id(ref)); }
  async list() { return []; }
  async unlockState() { return "unlocked" as const; }
}

function id(ref: SecretRef) { return `${ref.kind}/${ref.bindingId}`; }

function noOpLifecycle() {
  return {
    stopAccepting: () => {},
    drainAccepted: async () => {},
    resumeAfterAbort: () => {},
  };
}

function digest(seed: string) {
  return `sha256:${Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

function governor(): DefaultStorageMaintenanceGovernor {
  const classWeights = {
    "workload-interactive": 1,
    "workload-advancement": 1,
    "workload-scheduler": 1,
    "workload-orchestration": 1,
    "storage-foreground": 1,
    "storage-recovery": 1,
    "storage-background": 1,
  } satisfies DeviceCapacityPolicy["classWeights"];
  const mib = 1024 * 1024;
  return new DefaultStorageMaintenanceGovernor({
    capacity: new DefaultDeviceCapacityArbiter({
      policy: {
        version: 1,
        occupancy: {
          memoryReservationBytes: 256 * mib,
          temporaryBytes: 256 * mib,
          slots: 8,
          memorySafetyReserveBytes: 0,
          temporarySafetyReserveBytes: 0,
        },
        quantum: {
          readBytes: 1024 * mib,
          writeBytes: 1024 * mib,
          ioOperations: 1_000_000,
        },
        quantumRefillPerSecond: {
          readBytes: 1024 * mib,
          writeBytes: 1024 * mib,
          ioOperations: 1_000_000,
        },
        pressure: {
          maxCpuBusyRatio: 1,
          minimumAvailableMemoryBytes: 0,
        },
        retryAfterMs: 1,
        classWeights,
      },
      probe: () => ({
        cpuBusyRatio: 0,
        availableMemoryBytes: 256 * mib,
        processRssBytes: 0,
        temporaryBytesAvailable: 256 * mib,
      }),
    }),
  });
}
