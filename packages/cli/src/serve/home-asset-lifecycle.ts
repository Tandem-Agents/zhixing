import path from "node:path";
import {
  ArtifactLifecycleIndex,
  type FileArtifactStore,
  type FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  createSurfaceAssetStagingInfrastructure,
  type SurfaceAssetStagingInfrastructure,
} from "./surface-asset-staging-infrastructure.js";

/**
 * 一个 home 的资产生命周期索引及其临时件 staging。同一进程只有一份，资产权威与检查点保留共用：
 * 源集合固定为两本权威日志，源集合不同的实例交替打开同一目录会互相判失配、整段重放。
 */
export interface HomeAssetLifecycle {
  readonly lifecycle: ArtifactLifecycleIndex;
  readonly staging: SurfaceAssetStagingInfrastructure;
  close(): Promise<void>;
}

export function createHomeAssetLifecycle(input: {
  readonly distributedRoot: string;
  readonly authority: FileAuthorityCommitLog;
  readonly executor: FileAuthorityCommitLog;
  readonly artifacts: FileArtifactStore;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}): HomeAssetLifecycle {
  const staging = createSurfaceAssetStagingInfrastructure({
    distributedRoot: input.distributedRoot,
    storageMaintenance: input.storageMaintenance,
  });
  const lifecycle = new ArtifactLifecycleIndex({
    rootDir: path.join(input.distributedRoot, "derived"),
    logs: [input.authority, input.executor],
    artifacts: input.artifacts,
    temporaryArtifacts: staging.temporaryArtifacts,
    temporaryPresence: staging.presence,
    receiver: staging.recovery,
    storageMaintenance: input.storageMaintenance,
    maintenanceResourceId: input.artifacts.rootDir,
    // 日志由统一 home 入口持有并停止。
    ownsSourceLogs: false,
  });
  // 首次写入前登记：任何写者的追加都按日志恢复欠账预算核本索引落后的量。
  const unregister = lifecycle.registerTailAdmission();
  return {
    lifecycle,
    staging,
    async close() {
      unregister();
      await lifecycle.stopStorageMaintenance();
    },
  };
}
