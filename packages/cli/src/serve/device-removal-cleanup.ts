import path from "node:path";
import { rm } from "node:fs/promises";
import type { SecretStorePort } from "@zhixing/core/contracts";
import { protocolDigest, type DeviceLifecycleEvidenceRef } from "@zhixing/core/protocol";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { cleanupRemovedDeviceSecrets } from "./device-removal.js";

export async function cleanupExecutorDeviceLocalState(input: {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly deviceKey: DeviceKey;
  readonly storageGovernor?: StorageMaintenanceGovernorPort;
  readonly signal?: AbortSignal;
  readonly unregisterFuture: () => Promise<void>;
}): Promise<readonly DeviceLifecycleEvidenceRef[]> {
  const home = path.resolve(input.zhixingHome);
  const distributed = path.join(home, "distributed-runtime");
  const removable = [
    path.join(home, "runtime"),
    path.join(distributed, "capacity"),
    path.join(distributed, "derived"),
    path.join(distributed, "disaster-recovery-staging"),
    path.join(distributed, "evidence"),
    path.join(distributed, "execution-assets.json"),
    path.join(distributed, "executor-capability-directory.json"),
    path.join(distributed, "executor-snapshot-version.json"),
    path.join(distributed, "mesh-artifact-partials"),
    path.join(distributed, "mesh-bootstrap-completions.json"),
    path.join(distributed, "mesh-endpoints.json"),
    path.join(distributed, "mesh-peers.json"),
    path.join(distributed, "permission-snapshots"),
    path.join(distributed, "recovery-checkpoint-incoming"),
    path.join(distributed, "surface-asset-partials"),
    path.join(distributed, "surface-asset-temporary"),
    path.join(distributed, "workspace-bindings"),
    path.join(distributed, "workspace-probes"),
  ].map((entry) => assertOwnedPath(home, entry));

  await runWithMaintenanceUrgency(
    () => "recovery",
    input.signal ?? new AbortController().signal,
    async () => {
    for (const entry of removable) {
      await runStorageMaintenanceStep(
        input.storageGovernor,
        storageMaintenanceRequest(
          "device-lifecycle-cleanup",
          entry,
          protocolDigest("ExecutorRemovalCleanupPath", 1, { home, entry }),
          { obligation: "pre-commit", maxWaitMs: 5_000 },
        ),
        () => rm(entry, { recursive: true, force: true }),
      );
    }
    },
  );
  await input.unregisterFuture();
  const secretEvidence = await cleanupRemovedDeviceSecrets({
    store: input.secretStore,
    deviceKey: input.deviceKey,
    preserveDeviceKey: true,
  });
  return Object.freeze([
    {
      kind: "cleanup",
      digest: protocolDigest("ExecutorRemovalLocalCleanup", 1, {
        home,
        removed: removable.map((entry) => path.relative(home, entry).replaceAll("\\", "/")),
      }),
    },
    ...secretEvidence,
  ]);
}

function assertOwnedPath(home: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(home, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Device removal cleanup path escapes the current home");
  }
  return resolved;
}
