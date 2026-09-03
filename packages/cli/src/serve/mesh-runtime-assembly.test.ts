import { Buffer } from "node:buffer";
import { canonicalize } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  DeviceAdministrationDutyMigrationAdmissionAdapter,
  DeviceRemovalTargetEffectAdapter,
  finalizeCommittedPairingBootstrapContinuation,
  partitionPlannedAnchorPostInstall,
  resolveDeviceRemovalStatus,
} from "./mesh-runtime-assembly.js";
import type { PairingContinuation } from "./mesh-pairing-continuation-repository.js";

describe("planned anchor post-install consumer closure", () => {
  it("partitions every durable pending kind into exactly one fixed consumer", () => {
    const groups = partitionPlannedAnchorPostInstall([
      { kind: "assignment", id: "assignment-1" },
      { kind: "intent", id: "intent-1" },
      { kind: "interaction", id: "interaction-1" },
      { kind: "confirmation", id: "confirmation-1" },
      { kind: "final", id: "final-1" },
      { kind: "delivery", id: "delivery-1" },
    ]);

    expect(groups).toEqual({
      scheduler: [
        { kind: "assignment", id: "assignment-1" },
        { kind: "intent", id: "intent-1" },
      ],
      conversation: [
        { kind: "interaction", id: "interaction-1" },
        { kind: "confirmation", id: "confirmation-1" },
        { kind: "final", id: "final-1" },
      ],
      delivery: [{ kind: "delivery", id: "delivery-1" }],
    });
    expect(Object.isFrozen(groups)).toBe(true);
    expect(new Set([
      ...groups.scheduler,
      ...groups.conversation,
      ...groups.delivery,
    ].map(({ kind }) => kind))).toEqual(new Set([
      "assignment",
      "intent",
      "interaction",
      "confirmation",
      "final",
      "delivery",
    ]));
  });
});

describe("device removal status projection", () => {
  it("prefers the target state and falls back to the issuer when target status fails", async () => {
    const issuer = vi.fn(async () => removalState("needs-conversation-decision"));
    const target = vi.fn(async () => removalState("moving-conversations"));
    await expect(resolveDeviceRemovalStatus({
      targetStatus: target,
      issuerStatus: issuer,
    })).resolves.toEqual(removalState("moving-conversations"));
    expect(issuer).not.toHaveBeenCalled();

    target.mockRejectedValueOnce(new Error("target went offline"));
    await expect(resolveDeviceRemovalStatus({
      targetStatus: target,
      issuerStatus: issuer,
    })).resolves.toEqual(removalState("needs-conversation-decision"));
    expect(issuer).toHaveBeenCalledOnce();
  });
});

describe("device removal target effect adapter", () => {
  it("returns unavailable without resolving a physical target client", async () => {
    const client = vi.fn(() => {
      throw new Error("offline target client must not be resolved");
    });
    const adapter = new DeviceRemovalTargetEffectAdapter({
      has: vi.fn(() => false),
      client,
    });

    await expect(adapter.accept({
      targetDeviceId: "device-target",
      accepted: {} as never,
    })).resolves.toEqual({ kind: "unavailable" });
    await expect(adapter.abort({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      abort: {} as never,
    })).resolves.toEqual({ kind: "unavailable" });
    await expect(adapter.decide({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      mode: "destroy",
      currentDutyDeviceId: "device-duty",
    })).resolves.toEqual({ kind: "unavailable" });
    expect(client).not.toHaveBeenCalled();
  });

  it("returns completed results from the same selected target client", async () => {
    const state = {
      phase: "cancelled",
      conversations: [],
      localData: "known",
      credentialActions: [],
    } as const;
    const request = vi.fn<MeshServiceClient["request"]>(async (_serviceId, payload) => {
      const command = JSON.parse(payload.toString("utf8")) as { readonly op: string };
      return Buffer.from(canonicalize(command.op === "accept"
        ? { v: 1, conversations: ["conv-main"], hasAcceptedWork: true }
        : { v: 1, state }), "utf8");
    });
    const adapter = new DeviceRemovalTargetEffectAdapter({
      has: vi.fn(() => true),
      client: vi.fn(() => ({ request })),
    });

    const accepted = await adapter.accept({
      targetDeviceId: "device-target",
      accepted: {} as never,
    });
    const aborted = await adapter.abort({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      abort: {} as never,
    });
    const decided = await adapter.decide({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      mode: "transfer",
      currentDutyDeviceId: "device-duty",
    });

    expect(accepted).toEqual({
      kind: "completed",
      result: { conversations: ["conv-main"], hasAcceptedWork: true },
    });
    expect(aborted).toEqual({ kind: "completed", result: state });
    expect(decided).toEqual({ kind: "completed", result: state });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(aborted)).toBe(true);
    expect(Object.isFrozen(decided)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("preserves a selected target client failure", async () => {
    const failure = new Error("target disconnected during removal effect");
    const adapter = new DeviceRemovalTargetEffectAdapter({
      has: vi.fn(() => true),
      client: vi.fn(() => ({ request: vi.fn(async () => Promise.reject(failure)) })),
    });

    await expect(adapter.decide({
      targetDeviceId: "device-target",
      operationId: "operation-1",
      mode: "destroy",
      currentDutyDeviceId: "device-duty",
    })).rejects.toBe(failure);
  });
});

describe("duty migration admission adapter", () => {
  it("projects current physical state on every read without leaking raw flags", () => {
    let currentOwnerReady = true;
    let deviceRemovalInProgress = false;
    const readPhysicalSnapshot = vi.fn(() => ({
      context: {
        localDeviceId: "device-duty",
        currentDutyDeviceId: "device-duty",
        members: [{ deviceId: "device-target", state: "active" as const, dutyCapable: true }],
      },
      currentOwnerReady,
      deviceRemovalInProgress,
    }));
    const adapter = new DeviceAdministrationDutyMigrationAdmissionAdapter(readPhysicalSnapshot);

    const allowed = adapter.read();
    expect(allowed.outcome).toEqual({ kind: "allowed" });
    expect(Object.keys(allowed.context).sort()).toEqual([
      "currentDutyDeviceId",
      "localDeviceId",
      "members",
    ]);

    deviceRemovalInProgress = true;
    expect(adapter.read().outcome).toEqual({ kind: "paired-device-removal" });

    currentOwnerReady = false;
    expect(adapter.read().outcome).toEqual({ kind: "current-owner-transition" });

    currentOwnerReady = true;
    deviceRemovalInProgress = false;
    expect(adapter.read().outcome).toEqual({ kind: "allowed" });
    expect(readPhysicalSnapshot).toHaveBeenCalledTimes(4);
  });
});

describe("pairing continuation startup catch-up", () => {
  it("retires the matching committed issuer continuation only after completion and secret cleanup", async () => {
    const order: string[] = [];
    const clear = vi.fn(async () => {
      order.push("continuation");
    });
    await finalizeCommittedPairingBootstrapContinuation({
      peerDeviceId: "peer-device",
      continuations: {
        load: async () => committedIssuerContinuation("peer-device", "offer-catch-up"),
        save: async () => undefined,
        clear,
      },
      completions: {
        markBootstrapComplete: async () => {
          order.push("completion");
        },
        bootstrapCompleted: async () => false,
      },
      secretStore: memorySecretStore(async (ref) => {
        expect(ref).toEqual({
          kind: "rendezvous",
          bindingId: "pairing:offer-catch-up",
        });
        order.push("secret");
      }),
    });

    expect(order).toEqual(["completion", "secret", "continuation"]);
    expect(clear).toHaveBeenCalledWith("offer-catch-up");
  });

  it("keeps the continuation when catch-up has not completed and ignores another peer", async () => {
    const clear = vi.fn(async () => undefined);
    const secretDelete = vi.fn(async () => undefined);
    const completion = vi.fn(async () => {
      throw new Error("completion publication failed");
    });
    const continuations = {
      load: async () => committedIssuerContinuation("peer-device", "offer-retry"),
      save: async () => undefined,
      clear,
    };
    const completions = {
      markBootstrapComplete: completion,
      bootstrapCompleted: async () => false,
    };
    const secretStore = memorySecretStore(secretDelete);

    await expect(finalizeCommittedPairingBootstrapContinuation({
      peerDeviceId: "peer-device",
      continuations,
      completions,
      secretStore,
    })).rejects.toThrow("completion publication failed");
    expect(secretDelete).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    await finalizeCommittedPairingBootstrapContinuation({
      peerDeviceId: "another-peer",
      continuations,
      completions,
      secretStore,
    });
    expect(completion).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });
});

function removalState(phase: "needs-conversation-decision" | "moving-conversations") {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}

function committedIssuerContinuation(
  peerDeviceId: string,
  offerId: string,
): PairingContinuation {
  return {
    v: 1,
    side: "issuer",
    phase: "commit-ready",
    invitation: { offer: { offerId } },
    join: { device: { deviceId: peerDeviceId } },
  } as unknown as PairingContinuation;
}

function memorySecretStore(
  deleteSecret: (ref: SecretRef) => Promise<void>,
): SecretStorePort {
  return {
    put: async () => undefined,
    get: async () => null,
    delete: deleteSecret,
    list: async () => [],
    unlockState: async () => "unlocked",
  };
}
