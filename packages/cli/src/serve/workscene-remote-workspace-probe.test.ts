import type {
  HomeTrustRecord,
  ImmediateRootResourceLease,
  ResourceLease,
  WorkspaceProbeRequest,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  createSignedEnvironmentControlGrant,
  createSignedWorkspaceProbeResult,
  protocolDigest,
} from "@zhixing/core/protocol";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { describe, expect, it, vi } from "vitest";
import { MeshExecutorTopologyTrustState } from "./mesh-runtime-assembly.js";
import {
  MeshWorksceneRemoteWorkspaceProbe,
  REJECT_REMOTE_WORKSPACE_PROBE,
} from "./workscene-remote-workspace-probe.js";

const NOW = "2026-09-03T00:00:00.000Z";
const EXPIRY = "2026-09-03T00:05:00.000Z";

describe("Workscene remote workspace probe topology", () => {
  it("uses fixed ports while current trust and connectivity remain live", async () => {
    const anchor = await DeviceKey.generate({ now: () => Date.parse(NOW) });
    const executor = await DeviceKey.generate({ now: () => Date.parse(NOW) });
    const trust = new MeshExecutorTopologyTrustState(
      trustRecord(anchor, executor, "active"),
    );
    let connected = true;
    const request = probeRequest(anchor, executor.deviceId);
    const meshRequest = vi.fn(async () =>
      Buffer.from(canonicalize(createSignedWorkspaceProbeResult({
        v: 1,
        requestId: request.requestId,
        bindingRef: request.bindingRef,
        workspaceBindingRevision: 3,
        probe: "directory",
        executorId: "executor-a",
      }, executor)), "utf8")
    );
    const port = new MeshWorksceneRemoteWorkspaceProbe({
      trust,
      connections: {
        has: (deviceId) => connected && deviceId === executor.deviceId,
        client: () => ({ request: meshRequest }),
      },
    });

    await expect(port.probe(executor.deviceId, request)).resolves.toMatchObject({
      requestId: "probe-a",
      probe: "directory",
    });
    expect(meshRequest).toHaveBeenCalledOnce();

    connected = false;
    await expect(port.probe(executor.deviceId, request)).rejects.toThrow(
      `Workspace probe executor is unavailable: ${executor.deviceId}`,
    );
    expect(meshRequest).toHaveBeenCalledOnce();

    connected = true;
    trust.accept(trustRecord(anchor, executor, "revoked"));
    await expect(port.probe(executor.deviceId, request)).rejects.toThrow(
      `Workspace probe executor is unavailable: ${executor.deviceId}`,
    );
    expect(meshRequest).toHaveBeenCalledOnce();
  });

  it("rejects remote probing explicitly in single-machine topology", async () => {
    await expect(REJECT_REMOTE_WORKSPACE_PROBE.probe(
      "device-remote",
      {} as WorkspaceProbeRequest,
    )).rejects.toThrow("目标设备当前不可达，无法确认工作区状态");
  });
});

function probeRequest(
  anchor: DeviceKey,
  executorDeviceId: string,
): WorkspaceProbeRequest {
  const leasePayload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: "reservation-probe-a",
    admissionClass: "interactive",
    workload: { kind: "control", id: "probe-a", attempt: 1 },
    scopeBinding: { kind: "control", subject: "probe-a" },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: anchor.deviceId, localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const leaseWithDigest = {
    ...leasePayload,
    digest: protocolDigest("ResourceLease", 1, leasePayload),
  };
  const resourceLease = {
    ...leaseWithDigest,
    signature: anchor.sign("ResourceLease", 1, leaseWithDigest),
  } as ImmediateRootResourceLease;
  const grant = createSignedEnvironmentControlGrant({
    v: 1,
    grantId: "environment-grant-a",
    deviceId: executorDeviceId,
    bindingRef: "workspace-a",
    methods: ["environment.probe"],
    requestId: "probe-a",
    resourceLeaseDigest: resourceLease.digest,
    issuedAt: NOW,
    expiry: EXPIRY,
  }, anchor);
  return {
    v: 1,
    requestId: "probe-a",
    deviceId: executorDeviceId,
    bindingRef: "workspace-a",
    grant,
    resourceLease,
    at: NOW,
  };
}

function trustRecord(
  anchor: DeviceKey,
  executor: DeviceKey,
  executorState: "active" | "revoked",
): HomeTrustRecord {
  const identity = (key: DeviceKey) => enrollDeviceIdentity(key, {
    displayName: key.deviceId,
    platform: "headless",
    enrolledAt: NOW,
  });
  return {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-workscene-probe",
    trustEpoch: executorState === "active" ? 1 : 2,
    issuer: { deviceId: anchor.deviceId, issuerKeyId: anchor.deviceId },
    chainHead: { seq: 1, eventDigest: `sha256:${"0".repeat(64)}` },
    members: [
      { device: identity(anchor), roles: ["anchor"], state: "active" },
      { device: identity(executor), roles: ["executor"], state: executorState },
    ],
    signature: anchor.sign("HomeTrustRecord", 1, {}),
  };
}
