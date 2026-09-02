import path from "node:path";
import {
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileResumableArtifactReceiver,
  projectSurfaceAssetStagingPorts,
  type MutableArtifactStore,
  type SurfaceAssetStagingPorts,
} from "@zhixing/core/authority";
import { MAX_SURFACE_ASSET_BYTES } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";

export interface SurfaceAssetStagingInfrastructure
  extends SurfaceAssetStagingPorts {
  readonly temporaryArtifacts: MutableArtifactStore;
}

/** The sole physical composition of the P09 Surface temporary/partial family. */
export function createSurfaceAssetStagingInfrastructure(options: {
  readonly distributedRoot: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}): SurfaceAssetStagingInfrastructure {
  const temporaryArtifacts = new FileArtifactStore(
    path.join(options.distributedRoot, "surface-asset-temporary"),
  );
  const receiver = new FileResumableArtifactReceiver(
    temporaryArtifacts,
    path.join(options.distributedRoot, "surface-asset-partials"),
    { maxArtifactBytes: MAX_SURFACE_ASSET_BYTES },
  );
  const presence = new FileArtifactTemporaryPresenceStore(
    path.join(temporaryArtifacts.rootDir, ".presence"),
    { storageMaintenance: options.storageMaintenance },
  );
  return Object.freeze({
    temporaryArtifacts,
    ...projectSurfaceAssetStagingPorts(receiver, presence),
  });
}
