import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { describe, expect, it } from "vitest";
import { createConversationAssignmentArtifactAuthorityIndex } from "./conversation-executor-dispatch.js";
import {
  executorIdForDevice,
  MeshConversationExecutorTopologyDirectory,
  MeshExecutorTopologyTrustState,
} from "./mesh-runtime-assembly.js";

describe("MeshConversationExecutorTopologyDirectory", () => {
  it("keeps one immutable directory while trust and connectivity change", async () => {
    const localDeviceId = "device-local";
    const firstDeviceId = "device-a";
    const secondDeviceId = "device-b";
    const connected = new Set([firstDeviceId, secondDeviceId]);
    const client = {};
    const connections = {
      has: (deviceId: string) => connected.has(deviceId),
      client: () => client,
    };
    const trust = new MeshExecutorTopologyTrustState(
      trustRecord(localDeviceId, [secondDeviceId, firstDeviceId]),
    );
    const directory = new MeshConversationExecutorTopologyDirectory({
      trust,
      connections: connections as never,
      localDeviceId,
      artifacts: {} as never,
      receiver: {} as never,
      signer: {} as never,
      verifier: {} as never,
      assignmentArtifacts: createConversationAssignmentArtifactAuthorityIndex(),
    });

    const initial = await directory.candidates();
    expect(initial.map((target) => target.deviceId)).toEqual([
      firstDeviceId,
      secondDeviceId,
    ]);
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial[0])).toBe(true);
    expect(directory.forExecutor(executorIdForDevice(firstDeviceId)))
      .toBe(initial[0]);

    trust.accept(trustRecord(localDeviceId, [secondDeviceId]));
    expect((await directory.candidates()).map((target) => target.deviceId))
      .toEqual([secondDeviceId]);
    expect(directory.forExecutor(executorIdForDevice(firstDeviceId)))
      .toBeUndefined();

    connected.delete(secondDeviceId);
    expect(await directory.candidates()).toEqual([]);
  });
});

function trustRecord(
  localDeviceId: string,
  executorDeviceIds: readonly string[],
): HomeTrustRecord {
  const device = (deviceId: string) => ({
    deviceId,
    displayName: deviceId,
    platform: "headless" as const,
    publicKey: `public-key:${deviceId}`,
    enrolledAt: "2026-08-24T00:00:00.000Z",
  });
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-static-topology",
    trustEpoch: 1,
    issuer: { deviceId: localDeviceId, issuerKeyId: localDeviceId },
    chainHead: { seq: 1, eventDigest: `sha256:${"0".repeat(64)}` },
    members: [
      { device: device(localDeviceId), roles: ["anchor"], state: "active" },
      ...executorDeviceIds.map((deviceId) => ({
        device: device(deviceId),
        roles: ["executor" as const],
        state: "active" as const,
      })),
    ],
    signature: { alg: "ed25519", keyId: localDeviceId, sig: "test" },
  };
}
