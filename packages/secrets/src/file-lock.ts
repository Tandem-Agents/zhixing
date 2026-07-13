import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

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
}

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  if (
    !Number.isFinite(options.staleMs) ||
    options.staleMs <= 0 ||
    !Number.isFinite(options.waitMs) ||
    options.waitMs < 0 ||
    (options.retryMs !== undefined &&
      (!Number.isFinite(options.retryMs) || options.retryMs <= 0))
  ) {
    throw new TypeError("SecretStore lock timing options are invalid");
  }
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? 25;
  const startedAt = performance.now();
  const token = randomBytes(16).toString("hex");
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

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
        await releaseLockFile(lockPath, token);
      };
    }
    await reclaimDeadLock(lockPath, options.staleMs, now);
    if (performance.now() - startedAt >= options.waitMs) {
      throw new Error("SecretStore lock is busy");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

async function reclaimDeadLock(
  lockPath: string,
  staleMs: number,
  now: () => number,
): Promise<void> {
  const age = await stat(lockPath)
    .then((value) => now() - value.mtimeMs)
    .catch(() => 0);
  const observedOwner = await readLockRecord(lockPath);
  if (observedOwner ? isLockOwnerActive(observedOwner) : age <= staleMs) return;

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
    if (reclaimOwner ? !isLockOwnerActive(reclaimOwner) : reclaimAge > staleMs) {
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
    if (owner ? !isLockOwnerActive(owner) : currentAge > staleMs) {
      await rm(lockPath, { force: true });
    }
  } finally {
    stopHeartbeat();
    activeTokens.delete(reclaimRecord.token);
    await releaseLockFile(reclaimPath, reclaimRecord.token);
  }
}

async function tryCreateLockFile(lockPath: string, record: LockRecord): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

async function releaseLockFile(lockPath: string, token: string): Promise<void> {
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
      "SecretStore lock cleanup failed; the operation result is preserved and the lock remains fail-closed",
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
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
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

function isLockOwnerActive(owner: LockRecord): boolean {
  return activeTokens.has(owner.token) || isProcessAlive(owner.pid);
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
