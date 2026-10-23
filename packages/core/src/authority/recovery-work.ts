import { authorityWalMaximumFrameBytes } from "./wal-frame.js";
import { StorageMaintenanceAdmissionError } from "../resources/storage-maintenance.js";
import { isHoldingMaintenanceExclusion } from "../resources/maintenance-context.js";
import type { DurableLogCheckpoint } from "./interfaces.js";

/** Physical work limits, independent of the number of business identities. */
export const AUTHORITY_RECOVERY_BUDGET = Object.freeze({
  hardFrames: 256,
  hardBytes: 4 * 1024 * 1024,
  refreshFrames: 64,
  refreshBytes: 1024 * 1024,
  pageFrames: 64,
  pageBytes: 1024 * 1024,
});

export function maximumAuthorityRecoveryTailBytes(format: "legacy" | "versioned" = "versioned"): number {
  return Math.max(AUTHORITY_RECOVERY_BUDGET.hardBytes, authorityWalMaximumFrameBytes(format));
}

export function authorityTailNeedsFlush(published: DurableLogCheckpoint, head: DurableLogCheckpoint,
  nextFrameBytes = 0, hard = true): boolean {
  if (published.logId !== head.logId || published.lsn > head.lsn || published.frameEndOffset > head.frameEndOffset) {
    throw new TypeError("Recovery debt does not bind the verified log prefix");
  }
  const frames = head.lsn - published.lsn, bytes = head.frameEndOffset - published.frameEndOffset;
  const frameLimit = hard ? AUTHORITY_RECOVERY_BUDGET.hardFrames : AUTHORITY_RECOVERY_BUDGET.refreshFrames;
  const byteLimit = hard ? AUTHORITY_RECOVERY_BUDGET.hardBytes : AUTHORITY_RECOVERY_BUDGET.refreshBytes;
  // A legal large frame occupies a single batch only after all prior debt is
  // durable. Its size is still bounded by the WAL format, never a new user cap.
  if (hard && nextFrameBytes > byteLimit) return frames !== 0 || bytes !== 0;
  return hard
    ? frames + Number(nextFrameBytes > 0) > frameLimit || bytes + nextFrameBytes > byteLimit
    : frames >= frameLimit || bytes >= byteLimit;
}

/** 依赖尚未就绪的派生状态，相关决定不得进行。持有日志锁的路径只返回这一信号；日志在释放锁后
 * 分页准备再重跑。若它越出日志边界，调用方按既有容量背压在其互斥区外重试。 */
export class AuthorityPreparationRequired extends StorageMaintenanceAdmissionError {
  readonly code = "authority-preparing";
  /** Bound by the source owner when a caller still holds another exclusion. */
  prepareOutside?: () => Promise<void>;
  /** 整体就绪准备：单个投影的永久故障留在该投影上，不让准备整体失败。 */
  isolateFailures = false;
  /** When isolating maintenance failures, these decision/write dependencies
   * must still complete successfully. Undefined preserves all-isolated mode. */
  requiredProjections?: readonly string[];
  constructor(readonly projections: readonly string[], readonly frameIndex = false,
    readonly coverage: readonly string[] = []) {
    super({ kind: "backpressured", blockedBy: "derived-preparation", retryAfterMs: 25 });
    this.name = "AuthorityPreparationRequired";
    this.message = "Authority derived state is being prepared";
  }
}

/**
 * 互斥区外的重试点：错误带有可在区外完成的准备时等待它完成并返回 true。准备是确定的前进，
 * 不占用容量背压的有限等待窗口；准备失败照常抛出。区内或其他错误返回 false，由调用方按背压处理。
 */
export async function awaitAuthorityPreparation(error: unknown): Promise<boolean> {
  if (!(error instanceof AuthorityPreparationRequired) || !error.prepareOutside || isHoldingMaintenanceExclusion()) return false;
  await error.prepareOutside();
  return true;
}

/** 落后量在硬准入上限之内：首次写入或读取前可在锁内同步，工作量与 C8 同时点、受 K 约束。 */
export function authorityTailWithinInlineBudget(from: DurableLogCheckpoint, head: DurableLogCheckpoint): boolean {
  try {
    return !authorityTailNeedsFlush(from, head, 0, true);
  } catch {
    return false;
  }
}

export class AuthorityProjectionUnavailable extends Error {
  readonly code = "projection-unavailable";
  constructor(readonly projectionId: string, cause: unknown) {
    super("Authority projection is unavailable: " + projectionId, { cause });
    this.name = "AuthorityProjectionUnavailable";
  }
}

export interface AuthorityPreparedWatermark extends DurableLogCheckpoint {
  readonly projections: readonly string[];
}
