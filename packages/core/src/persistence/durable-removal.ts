import { rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { claimDeviceCapacity } from "../resources/device-capacity.js";
import { syncDirectory } from "./durable-directory.js";

/**
 * 耐久删除原语:文件系统删除的唯一执行形态。
 *
 * 合同:删除结论被任何下游状态消费之前,该删除必须已经耐久。因此无论本次真正
 * 删掉了目标,还是发现目标已经不存在,都必须同步其所在目录后才返回。重试时观察
 * 到的"已不存在"只能说明前一次 unlink 在页缓存中生效,不能证明目录条目变化已
 * 落盘——把它当作"前次删除已完成"正是本模块要消除的写序缺陷。
 *
 * 目录同步失败一律抛出:调用方不得推进配额、生命周期、回收状态或删除计数。
 */

/** 删除单个文件并完成耐久屏障。返回本次是否真正删掉了目标。 */
export async function durablyRemoveFile(file: string): Promise<boolean> {
  const removed = await unlinkEntry(file);
  await syncContainingDirectory(path.dirname(file));
  return removed;
}

/**
 * 批量删除文件并按所在目录归并屏障,每个目录至多同步一次。
 *
 * 中途出错时仍会为已经发生的删除补完全部目录同步,再抛出首个错误——否则失败路径
 * 会留下比单文件形态更宽的未耐久窗口。
 */
export async function durablyRemoveFiles(
  files: readonly string[],
): Promise<number> {
  if (files.length === 0) return 0;
  const directories = new Set<string>();
  let removed = 0;
  let failure: unknown;
  let failed = false;
  for (const file of files) {
    directories.add(path.dirname(file));
    try {
      if (await unlinkEntry(file)) removed += 1;
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  for (const directory of directories) {
    await syncContainingDirectory(directory);
  }
  if (failed) throw failure;
  return removed;
}

export type DurableDirectoryRemoval = "removed" | "absent" | "not-empty";

/**
 * 删除空目录并同步其父目录。目录非空时不构成删除,不需要屏障。
 */
export async function durablyRemoveDirectory(
  directory: string,
): Promise<DurableDirectoryRemoval> {
  let outcome: DurableDirectoryRemoval;
  try {
    claimDeviceCapacity("ioOperations", 1);
    await rmdir(directory);
    outcome = "removed";
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      outcome = "absent";
    } else if (isNodeError(error, "ENOTEMPTY") || isNodeError(error, "EEXIST")) {
      return "not-empty";
    } else {
      throw error;
    }
  }
  await syncContainingDirectory(path.dirname(directory));
  return outcome;
}

/** 递归删除目录树并同步其父目录。 */
export async function durablyRemoveDirectoryTree(
  directory: string,
): Promise<void> {
  claimDeviceCapacity("ioOperations", 1);
  await rm(directory, { recursive: true, force: true });
  await syncContainingDirectory(path.dirname(directory));
}

async function unlinkEntry(file: string): Promise<boolean> {
  try {
    claimDeviceCapacity("ioOperations", 1);
    await unlink(file);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncContainingDirectory(directory: string): Promise<void> {
  try {
    claimDeviceCapacity("ioOperations", 1);
    await syncDirectory(directory);
  } catch (error) {
    // 目录本身已经不存在:其条目变化必然随删除该目录的操作一并耐久,无需再同步。
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
