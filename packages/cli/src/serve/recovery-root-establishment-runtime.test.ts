import path from "node:path";
import type { HomeTrustRecord, SecretStorePort } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { MESH_ENDPOINT_SERVICE_ID } from "@zhixing/mesh/bootstrap";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { createMeshBootstrapProjectionPorts } from "./mesh-bootstrap-projection.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import {
  RecoveryRootEstablishmentRuntime,
  ROOT_ESTABLISHMENT_SERVICE_EXACT_SET,
} from "./recovery-root-establishment-runtime.js";
import { createRecoveryRootPairedCheckpointCommandReceiverInfrastructure } from "./paired-checkpoint-incoming-infrastructure.js";

describe("recovery root establishment runtime", () => {
  it("keeps ordinary business services closed and exposes the strict receiver only on the target", async () => {
    const root = await createTempDir("recovery-root-establishment-runtime");
    const targetHome = path.join(root, "target");
    const targetMesh = bootstrap("target", ["executor"], targetHome);
    const targetMaintenance = maintenance();
    expect(() => new RecoveryRootEstablishmentRuntime({
      mesh: targetMesh,
      secretStore: secretStore(),
      pairedCheckpointReceiver: null,
    })).toThrow("does not match this topology");
    const target = new RecoveryRootEstablishmentRuntime({
      mesh: targetMesh,
      secretStore: secretStore(),
      pairedCheckpointReceiver:
        createRecoveryRootPairedCheckpointCommandReceiverInfrastructure({
          zhixingHome: targetHome,
          trust: targetMesh.trust,
          deviceId: targetMesh.deviceKey.deviceId,
          bootstrapStore: targetMesh.bootstrapStore,
          storageMaintenance: targetMaintenance,
        }),
    });
    expect(target.services.list()).toEqual([...ROOT_ESTABLISHMENT_SERVICE_EXACT_SET]);
    await target.stop();
    await targetMesh.bootstrapStore.stopStorageMaintenance();
    expect(target.services.list()).toEqual([]);

    const issuerHome = path.join(root, "issuer");
    const issuerMesh = bootstrap("issuer", ["anchor"], issuerHome);
    const issuerMaintenance = maintenance();
    expect(() => new RecoveryRootEstablishmentRuntime({
      mesh: issuerMesh,
      secretStore: secretStore(),
      pairedCheckpointReceiver: Object.freeze({
        request: async () => {
          throw new Error("unexpected request");
        },
      }),
    })).toThrow("does not match this topology");
    const issuer = new RecoveryRootEstablishmentRuntime({
      mesh: issuerMesh,
      secretStore: secretStore(),
      pairedCheckpointReceiver:
        createRecoveryRootPairedCheckpointCommandReceiverInfrastructure({
          zhixingHome: issuerHome,
          trust: issuerMesh.trust,
          deviceId: issuerMesh.deviceKey.deviceId,
          bootstrapStore: issuerMesh.bootstrapStore,
          storageMaintenance: issuerMaintenance,
        }),
    });
    expect(issuer.services.list()).toEqual([MESH_ENDPOINT_SERVICE_ID]);
    await issuer.stop();
    await issuerMesh.bootstrapStore.stopStorageMaintenance();
  });
});

function bootstrap(
  localDeviceId: "issuer" | "target",
  roles: readonly ("anchor" | "executor")[],
  root: string,
): Extract<MeshRuntimeBootstrap, { mode: "trusted-home" }> {
  const identity = (deviceId: string) => ({ deviceId, keyId: `key:${deviceId}` });
  const trust = {
    v: 1,
    schemaId: "HomeTrustRecord",
    homeId: "home-root-establishment",
    trustEpoch: 1,
    issuer: identity("issuer"),
    members: [
      { device: identity("issuer"), roles: ["anchor"], state: "active" },
      { device: identity("target"), roles: ["executor"], state: "active" },
    ],
    chainHead: { seq: 1, eventDigest: `sha256:${"1".repeat(64)}` },
    signature: "signature",
  } as unknown as HomeTrustRecord;
  const bootstrapStore = new FileMeshBootstrapStore(root);
  return {
    mode: "trusted-home",
    roles,
    deviceKey: { deviceId: localDeviceId } as never,
    bootstrapStore,
    bootstrapProjection: createMeshBootstrapProjectionPorts(bootstrapStore),
    trust,
    configuration: { enabledRoles: roles } as never,
    endpoints: {} as never,
    transportPeers: [],
    trustedIdentities: trust.members.map((member) => member.device),
    authorizedDeviceIds: trust.members.map((member) => member.device.deviceId),
  };
}

function secretStore(): SecretStorePort {
  return {} as SecretStorePort;
}

function maintenance(): StorageMaintenanceGovernorPort {
  return {} as StorageMaintenanceGovernorPort;
}
