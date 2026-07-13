import {
  acquireFileLock as acquireSharedFileLock,
  type FileLockOptions as SharedFileLockOptions,
} from "@zhixing/core/persistence";

export type FileLockOptions = Omit<SharedFileLockOptions, "resourceName">;

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  return acquireSharedFileLock(lockPath, { ...options, resourceName: "SecretStore" });
}
