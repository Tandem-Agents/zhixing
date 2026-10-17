import path from "node:path";
import { stat } from "node:fs/promises";
import { durableProjectionDirectoryName, durableProjectionVersionDirectoryName, type FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { LogRecordPort } from "@zhixing/core/logging";
import type { StopEndpointLock } from "@zhixing/core/protocol";
import { SCHEDULE_AUTHORITY_PROJECTION_ID } from "@zhixing/owner-kernel/startup-definitions";
import { readLock, type ProcessLockPaths } from "@zhixing/server";
import { recordedHostMayBeAlive, type RecordedHostProbes } from "./startup-server-owner.js";

/**
 * 被替代后仍保存着可删除 CAS 内容副本的派生版本。旧调度投影（版本 1）把每个任务定义整份
 * 写进派生段；当前版本只存 CAS 引用或源 WAL 定位与必要元数据。版本 1 目录只由候选8/B1 的
 * 旧 Host 打开，新入口一律使用当前版本，因此回收只需证明旧 Host 已经退出。
 * 其他被替代版本目录默认保留，不在这里回收。
 */
export const RETIRED_CONTENT_COPIES: readonly { readonly projectionId: string; readonly version: number }[] =
  Object.freeze([Object.freeze({ projectionId: SCHEDULE_AUTHORITY_PROJECTION_ID, version: 1 })]);

/**
 * 前一宿主的原生退出证明，只在本宿主刚以端口取得 home 单例、尚未覆盖发现文件时当场取得：
 * 残留的发现记录（PID 与出生身份）所指的进程经平台出生身份核实已不存在。发现文件已被
 * 正常删除时没有可绑定的交接依据——删除标记不是退出证明——此时不成立。
 */
export async function provePriorHostExited(
  lockPaths: ProcessLockPaths,
  probes: RecordedHostProbes = {},
  currentPid = process.pid,
): Promise<boolean> {
  const prior = await readLock(lockPaths).catch(() => null);
  if (!prior || prior.pid === currentPid) return false;
  const record: StopEndpointLock = {
    pid: prior.pid,
    port: prior.port,
    startTime: prior.startTime,
    startedAt: prior.startedAt,
  };
  return !await recordedHostMayBeAlive(record, probes);
}

/**
 * 每次启动复核：副本目录存在且前一宿主退出已证明时，按页耐久删除（可接续，目录消失即完成）；
 * 证明不足时保留目录，并如实记录清理义务仍未完成。降级后的旧二进制重新产生副本时，
 * 下一次有证明的启动再次处理。
 */
export async function reclaimRetiredContentCopies(input: {
  readonly log: FileAuthorityCommitLog;
  readonly priorHostExitProven: boolean;
  readonly records?: LogRecordPort;
}): Promise<void> {
  for (const copy of RETIRED_CONTENT_COPIES) {
    for (const layout of ["legacy", "versioned"] as const) {
    const directory = path.join(input.log.rootDir, "projections", layout === "legacy"
      ? durableProjectionDirectoryName(copy.projectionId) : durableProjectionVersionDirectoryName(copy.projectionId, copy.version));
    const present = await stat(directory).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!present) continue;
    const record = (outcome: string, reason: string) => {
      try {
        input.records?.record({ event: "retired", data: { projection: copy.projectionId, version: copy.version, layout, outcome, reason } });
      } catch { /* 观测不改变回收结论。 */ }
    };
    if (!input.priorHostExitProven) {
      record("pending", "prior-host-exit-unproven");
      continue;
    }
    try {
      const outcome = await input.log.reclaimRetiredProjectionVersion(copy.projectionId, copy.version, layout);
      record(outcome === "stopped" ? "pending" : outcome, outcome === "stopped" ? "maintenance-stopped" : "prior-host-exited");
    } catch (error) {
      record("pending", error instanceof Error ? error.name : "reclaim-failed");
    }
    }
  }
}
