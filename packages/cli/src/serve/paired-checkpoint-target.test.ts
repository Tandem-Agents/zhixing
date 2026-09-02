import { canonicalize } from "@zhixing/core/protocol";
import type { HomeTrustEvent, HomeTrustRecord } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import type { CheckpointPackage } from "@zhixing/mesh/checkpoint";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { describe, expect, it, vi } from "vitest";
import {
  createBorrowedMeshPairedCheckpointTargetSessions,
  createOwnedMeshPairedCheckpointInventorySession,
  createOwnedMeshPairedCheckpointTargetSession,
  createPairingSocketPublishedCheckpointTarget,
} from "./paired-checkpoint-target-infrastructure.js";

const binding = Object.freeze({
  homeId: "home-1",
  sourceDeviceId: "source",
  targetDeviceId: "target",
  recipientKeyId: "recipient-1",
});

describe("paired checkpoint target infrastructure boundary", () => {
  it("projects owned Mesh sessions into finite target, activation and inventory roles", async () => {
    const commands: unknown[] = [];
    const connections = respondingConnections(commands);
    const stop = vi.fn(async () => undefined);
    const session = createOwnedMeshPairedCheckpointTargetSession({
      binding,
      connections,
      storageMaintenance: allowMaintenance(),
      closeControlPlane: stop,
    });

    expect(Object.keys(session).sort()).toEqual(["close", "rootActivation", "target"]);
    expect(Object.keys(session.target).sort()).toEqual([
      "independenceDomain",
      "read",
      "retire",
      "targetId",
      "writeDurable",
    ]);
    expect(Object.keys(session.rootActivation)).toEqual(["activateRoot"]);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.target)).toBe(true);
    expect(Object.isFrozen(session.rootActivation)).toBe(true);

    await session.rootActivation.activateRoot({
      checkpointId: "checkpoint-1",
      event: {} as HomeTrustEvent,
      record: {
        chainHead: { seq: 1, eventDigest: "sha256:head" },
      } as HomeTrustRecord,
    });
    expect(commands).toMatchObject([
      {
        t: "checkpoint.activate-root",
        homeId: "home-1",
        sourceDeviceId: "source",
        targetDeviceId: "target",
      },
    ]);
    await session.close();
    await session.close();
    expect(stop).toHaveBeenCalledTimes(1);

    const inventorySession = createOwnedMeshPairedCheckpointInventorySession({
      binding,
      connections,
      storageMaintenance: allowMaintenance(),
      closeControlPlane: async () => undefined,
    });
    expect(Object.keys(inventorySession.target).sort()).toEqual([
      "independenceDomain",
      "inventory",
      "read",
      "retire",
      "targetId",
      "writeDurable",
    ]);
    await expect(inventorySession.target.inventory("inventory-1")).resolves.toEqual([]);
  });

  it("makes the Host-borrowed connection role required while preserving unavailable topology", async () => {
    const unavailable = createBorrowedMeshPairedCheckpointTargetSessions({
      kind: "runtime-unavailable",
      storageMaintenance: allowMaintenance(),
    });
    expect(Object.keys(unavailable)).toEqual(["open"]);
    expect(Object.isFrozen(unavailable)).toBe(true);
    await expect(unavailable.open(binding)).resolves.toEqual({
      kind: "runtime-unavailable",
    });

    const available = await createBorrowedMeshPairedCheckpointTargetSessions({
      kind: "available",
      connections: respondingConnections([]),
      storageMaintenance: allowMaintenance(),
    }).open(binding);
    expect(available.kind).toBe("available");
    if (available.kind !== "available") return;
    expect(Object.keys(available.session.target).sort()).toEqual([
      "independenceDomain",
      "read",
      "retire",
      "targetId",
      "writeDurable",
    ]);
    await expect(available.session.close()).resolves.toBeUndefined();
  });

  it("keeps pairing command framing inside the adapter and exposes only a basic target", async () => {
    const sent: unknown[] = [];
    const responses: unknown[] = [
      {
        t: "recovery-onboarding-result",
        result: { t: "checkpoint.begun", checkpointId: "checkpoint-1" },
      },
      {
        t: "recovery-onboarding-result",
        result: { t: "checkpoint.stored", checkpointId: "checkpoint-1" },
      },
    ];
    const target = createPairingSocketPublishedCheckpointTarget({
      binding,
      storageMaintenance: allowMaintenance(),
      exchange: {
        send: async (frame) => {
          sent.push(frame);
        },
        receive: async () => responses.shift(),
      },
    });
    expect(Object.keys(target).sort()).toEqual([
      "independenceDomain",
      "read",
      "targetId",
      "writeDurable",
    ]);
    await target.writeDurable({
      envelope: {
        checkpointId: "checkpoint-1",
        recipientKeyId: "recipient-1",
        chunks: [],
      } as CheckpointPackage["envelope"],
      chunks: [],
    });
    expect(sent).toEqual([
      {
        t: "recovery-onboarding-command",
        command: expect.objectContaining({
          t: "checkpoint.begin",
          envelope: expect.objectContaining({ checkpointId: "checkpoint-1" }),
        }),
      },
      {
        t: "recovery-onboarding-command",
        command: expect.objectContaining({
          t: "checkpoint.commit",
          checkpointId: "checkpoint-1",
        }),
      },
    ]);

    const malformed = createPairingSocketPublishedCheckpointTarget({
      binding,
      storageMaintenance: allowMaintenance(),
      exchange: {
        send: async () => undefined,
        receive: async () => ({
          t: "recovery-onboarding-result",
          result: {
            t: "checkpoint.retired",
            checkpointId: "checkpoint-1",
            supersededBy: "next",
          },
          extra: true,
        }),
      },
    });
    await expect(malformed.read("checkpoint-1")).rejects.toThrow("unexpected fields");
  });
});

function respondingConnections(commands: unknown[]): {
  readonly client: (deviceId: string) => MeshServiceClient;
} {
  return {
    client: (deviceId) => ({
      request: async (service, payload) => {
        expect(deviceId).toBe("target");
        expect(service).toBe("recovery.checkpoint");
        const text = Buffer.from(payload).toString("utf8");
        const command = JSON.parse(text) as Record<string, unknown>;
        expect(canonicalize(command)).toBe(text);
        commands.push(command);
        let result: unknown;
        if (command.t === "checkpoint.activate-root") {
          result = {
            t: "checkpoint.root-activated",
            checkpointId: command.checkpointId,
            chainHead: (command.record as HomeTrustRecord).chainHead,
          };
        } else if (command.t === "checkpoint.inventory") {
          result = {
            t: "checkpoint.inventory",
            requestId: command.requestId,
            targetId: "backup-device:target",
            recipientKeyId: "recipient-1",
            entries: [],
          };
        } else {
          throw new Error(`unexpected command ${String(command.t)}`);
        }
        return Buffer.from(canonicalize(result), "utf8");
      },
    }),
  };
}

function allowMaintenance(): StorageMaintenanceGovernorPort {
  return {
    acquire: async () => ({
      kind: "granted",
      permit: {
        granted: {
          memoryReservationBytes: 0,
          temporaryBytes: 0,
          slots: 0,
          readBytes: Number.MAX_SAFE_INTEGER,
          writeBytes: Number.MAX_SAFE_INTEGER,
          ioOperations: Number.MAX_SAFE_INTEGER,
        },
        tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
        release: () => undefined,
      },
    }),
    snapshot: () => ({ queued: {}, inFlight: {} }),
  };
}
