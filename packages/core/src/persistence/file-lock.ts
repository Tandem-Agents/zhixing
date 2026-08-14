import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { prepareExclusiveFileClaim } from "./exclusive-file-claim.js";

interface LockRecord {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

const activeTokens = new Set<string>();

export interface FileLockOptions {
  readonly staleMs: number;
  readonly waitMs: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly resourceName?: string;
}

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const resourceName = options.resourceName ?? "File";
  if (
    !Number.isFinite(options.staleMs) ||
    options.staleMs <= 0 ||
    !Number.isFinite(options.waitMs) ||
    options.waitMs < 0 ||
    (options.retryMs !== undefined &&
      (!Number.isFinite(options.retryMs) || options.retryMs <= 0))
  ) {
    throw new TypeError(`${resourceName} lock timing options are invalid`);
  }
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 25;
  const startedAt = performance.now();
  const token = randomBytes(16).toString("hex");
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await cleanupAbandonedClaims(lockPath, options.staleMs, now);
  await cleanupAbandonedClaims(`${lockPath}.reclaim`, options.staleMs, now);

  while (true) {
    const record: LockRecord = { pid: process.pid, token, createdAt: now() };
    if (await tryCreateLockFile(lockPath, record)) {
      activeTokens.add(token);
      const stopHeartbeat = startLockHeartbeat(lockPath, token, options.staleMs, now);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        stopHeartbeat();
        activeTokens.delete(token);
        await releaseLockFile(lockPath, token, resourceName);
      };
    }
    await reclaimDeadLock(lockPath, options.staleMs, now, resourceName);
    if (performance.now() - startedAt >= options.waitMs) {
      throw new Error(`${resourceName} lock is busy`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

async function reclaimDeadLock(
  lockPath: string,
  staleMs: number,
  now: () => number,
  resourceName: string,
): Promise<void> {
  const age = await stat(lockPath)
    .then((value) => now() - value.mtimeMs)
    .catch(() => 0);
  const observedOwner = await readLockRecord(lockPath);
  if (observedOwner ? isLockOwnerActive(observedOwner, age, staleMs) : age <= staleMs) return;

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimRecord: LockRecord = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: now(),
  };
  if (!(await tryCreateLockFile(reclaimPath, reclaimRecord))) {
    const reclaimAge = await stat(reclaimPath)
      .then((value) => now() - value.mtimeMs)
      .catch(() => 0);
    const reclaimOwner = await readLockRecord(reclaimPath);
    if (reclaimOwner ? !isLockOwnerActive(reclaimOwner, reclaimAge, staleMs) : reclaimAge > staleMs) {
      await rm(reclaimPath, { force: true });
    }
    return;
  }
  activeTokens.add(reclaimRecord.token);
  const stopHeartbeat = startLockHeartbeat(reclaimPath, reclaimRecord.token, staleMs, now);
  try {
    const currentAge = await stat(lockPath)
      .then((value) => now() - value.mtimeMs)
      .catch(() => 0);
    const owner = await readLockRecord(lockPath);
    if (owner ? !isLockOwnerActive(owner, currentAge, staleMs) : currentAge > staleMs) {
      await rm(lockPath, { force: true });
    }
  } finally {
    stopHeartbeat();
    activeTokens.delete(reclaimRecord.token);
    await releaseLockFile(reclaimPath, reclaimRecord.token, resourceName);
  }
}

async function tryCreateLockFile(lockPath: string, record: LockRecord): Promise<boolean> {
  const claim = await prepareExclusiveFileClaim(
    lockPath,
    `${JSON.stringify(record)}\n`,
    record.token,
  );
  try {
    return await claim.publish();
  } finally {
    await claim.dispose().catch((error: unknown) => {
      process.emitWarning(
        new Error("Prepared lock claim cleanup failed; later acquisition will retry cleanup", {
          cause: error,
        }),
      );
    });
  }
}

async function cleanupAbandonedClaims(
  targetPath: string,
  staleMs: number,
  now: () => number,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.claim-`;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const token = entry.name.slice(prefix.length);
    if (!/^[a-f0-9]{32}$/u.test(token)) continue;
    const claimPath = path.join(directory, entry.name);
    const age = await pathAge(claimPath, now);
    if (age === null) continue;
    const owner = await readLockRecord(claimPath);
    if (owner ? isLockOwnerActive(owner, age, staleMs) : age <= staleMs) continue;
    await rm(claimPath, { force: true });
  }
}

async function pathAge(filePath: string, now: () => number): Promise<number | null> {
  try {
    return now() - (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function releaseLockFile(
  lockPath: string,
  token: string,
  resourceName: string,
): Promise<void> {
  const current = await readLockRecord(lockPath);
  if (current?.token !== token) return;
  let lastError: unknown;
  for (const delayMs of [0, 10, 50]) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await rm(lockPath, { force: true });
      return;
    } catch (error) {
      lastError = error;
      const stillOwned = await readLockRecord(lockPath);
      if (stillOwned?.token !== token) return;
    }
  }
  process.emitWarning(
    new Error(
      `${resourceName} lock cleanup failed; the operation result is preserved and the lock remains fail-closed`,
      { cause: lastError },
    ),
  );
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{32}$/u.test(value.token) ||
      !Number.isFinite(value.createdAt)
    ) {
      return null;
    }
    return value as LockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isLockOwnerActive(owner: LockRecord, heartbeatAgeMs: number, staleMs: number): boolean {
  return activeTokens.has(owner.token) ||
    (heartbeatAgeMs <= staleMs && isProcessAlive(owner.pid));
}

function startLockHeartbeat(
  lockPath: string,
  token: string,
  staleMs: number,
  now: () => number,
): () => void {
  const interval = setInterval(() => {
    void refreshOwnedLock(lockPath, token, now);
  }, Math.max(25, Math.floor(staleMs / 3)));
  interval.unref();
  return () => clearInterval(interval);
}

async function refreshOwnedLock(
  lockPath: string,
  token: string,
  now: () => number,
): Promise<void> {
  const current = await readLockRecord(lockPath);
  if (current?.token !== token) return;
  const timestamp = new Date(now());
  await utimes(lockPath, timestamp, timestamp).catch(() => undefined);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
