import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { prepareExclusiveFileClaim } from "./exclusive-file-claim.js";
import {
  createProcessIdentityResolver,
  type ProcessIdentityResolver,
} from "./process-identity.js";

interface LockRecord {
  readonly v: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
  readonly birth: string;
}

type LockOwnerReading =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly pid: number; readonly token: string; readonly createdAt: number; readonly birth: string }
  | { readonly kind: "legacy"; readonly pid: number; readonly token: string; readonly createdAt: number }
  | { readonly kind: "corrupt" };

const activeTokens = new Set<string>();
const defaultProcessIdentityResolver = createProcessIdentityResolver();

export interface FileLockOptions {
  readonly staleMs: number;
  readonly waitMs: number;
  readonly retryMs?: number;
  readonly now?: () => number;
  readonly resourceName?: string;
  /** Narrow platform boundary; omitted in production. */
  readonly processIdentityResolver?: ProcessIdentityResolver;
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
  const resolver = options.processIdentityResolver ?? defaultProcessIdentityResolver;
  const self = await resolver.read(process.pid);
  if (self.kind !== "present") {
    throw new Error(`${resourceName} lock owner identity is unavailable`);
  }
  const token = randomBytes(16).toString("hex");
  const record: LockRecord = {
    v: 1,
    pid: process.pid,
    token,
    createdAt: now(),
    birth: self.birth,
  };
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  await cleanupAbandonedClaims(lockPath, options.staleMs, now, resolver);
  await cleanupAbandonedClaims(`${lockPath}.reclaim`, options.staleMs, now, resolver);

  while (true) {
    if (await tryCreateLockFile(lockPath, JSON.stringify(record))) {
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
    await reclaimDeadLock(lockPath, options.staleMs, now, resourceName, resolver);
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
  resolver: ProcessIdentityResolver,
): Promise<void> {
  const age = await stat(lockPath)
    .then((value) => now() - value.mtimeMs)
    .catch(() => 0);
  const observedOwner = await readLockFile(lockPath);
  if (!(await isReclaimable(observedOwner, age, staleMs, resolver))) return;

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimRecord: LockRecord = {
    v: 1,
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: now(),
    birth: (await requireCurrentIdentity(resolver, resourceName)).birth,
  };
  if (!(await tryCreateLockFile(reclaimPath, JSON.stringify(reclaimRecord)))) {
    const reclaimAge = await stat(reclaimPath)
      .then((value) => now() - value.mtimeMs)
      .catch(() => 0);
    const reclaimOwner = await readLockFile(reclaimPath);
    if (await isReclaimable(reclaimOwner, reclaimAge, staleMs, resolver)) {
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
    const owner = await readLockFile(lockPath);
    const sameOwner =
      observedOwner.kind === "valid" && owner.kind === "valid" &&
      owner.token === observedOwner.token &&
      owner.birth === observedOwner.birth &&
      owner.pid === observedOwner.pid;
    if (sameOwner && await isReclaimable(owner, currentAge, staleMs, resolver)) {
      await rm(lockPath, { force: true });
    }
  } finally {
    stopHeartbeat();
    activeTokens.delete(reclaimRecord.token);
    await releaseLockFile(reclaimPath, reclaimRecord.token, resourceName);
  }
}

async function tryCreateLockFile(lockPath: string, content: string): Promise<boolean> {
  const claim = await prepareExclusiveFileClaim(
    lockPath,
    `${content}\n`,
    JSON.parse(content).token as string,
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
  resolver: ProcessIdentityResolver,
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
    const owner = await readLockFile(claimPath);
    if (await isAbandonedClaimCleanable(owner, age, staleMs, resolver)) {
      await rm(claimPath, { force: true });
    }
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
  const current = await readLockFile(lockPath);
  if (current.kind !== "valid" && current.kind !== "legacy") return;
  if (current.token !== token) return;
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
      const stillOwned = await readLockFile(lockPath);
      if ((stillOwned.kind !== "valid" && stillOwned.kind !== "legacy") || stillOwned.token !== token) return;
    }
  }
  process.emitWarning(
    new Error(
      `${resourceName} lock cleanup failed; the operation result is preserved and the lock remains fail-closed`,
      { cause: lastError },
    ),
  );
}

async function readLockFile(lockPath: string): Promise<LockOwnerReading> {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    return { kind: "corrupt" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "corrupt" };
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
    typeof record.token !== "string" || !/^[a-f0-9]{32}$/u.test(record.token) ||
    !Number.isFinite(record.createdAt)
  ) {
    return { kind: "corrupt" };
  }
  if (record.v === 1) {
    if (
      Object.keys(record).sort().join(",") !== "birth,createdAt,pid,token,v" ||
      typeof record.birth !== "string" || record.birth.length === 0 || record.birth.length > 256
    ) {
      return { kind: "corrupt" };
    }
    return {
      kind: "valid",
      pid: record.pid as number,
      token: record.token as string,
      createdAt: record.createdAt as number,
      birth: record.birth,
    };
  }
  if (record.v === undefined) {
    return {
      kind: "legacy",
      pid: record.pid as number,
      token: record.token as string,
      createdAt: record.createdAt as number,
    };
  }
  return { kind: "corrupt" };
}

/**
 * A stale lock may only be reclaimed when the exact recorded process is proven
 * gone or replaced. A live process with a matching birth is active even when
 * its heartbeat is stale (pause/sleep); legacy, corrupt or unreadable records
 * always stay busy.
 */
async function isReclaimable(
  reading: LockOwnerReading,
  heartbeatAgeMs: number,
  staleMs: number,
  resolver: ProcessIdentityResolver,
): Promise<boolean> {
  if (reading.kind === "missing") return heartbeatAgeMs > staleMs;
  if (reading.kind === "corrupt" || reading.kind === "legacy") return false;
  if (activeTokens.has(reading.token)) return false;
  if (heartbeatAgeMs <= staleMs) return false;
  const identity = await resolver.read(reading.pid);
  if (identity.kind === "unknown") return false;
  if (identity.kind === "absent") return true;
  return identity.birth !== reading.birth;
}

/**
 * `.claim-*` files are pre-publication temp artifacts: they never carry
 * ownership (publication is a same-directory hard link, and the claim file
 * remains a plain temp until disposed). Removing a stale one can at most make
 * a contender retry its publication, never revoke an owner, so corrupt or
 * legacy leftovers are safe to collect once stale.
 */
async function isAbandonedClaimCleanable(
  reading: LockOwnerReading,
  ageMs: number,
  staleMs: number,
  resolver: ProcessIdentityResolver,
): Promise<boolean> {
  if (reading.kind === "missing") return false;
  if (ageMs <= staleMs) return false;
  if (reading.kind === "corrupt" || reading.kind === "legacy") return true;
  if (activeTokens.has(reading.token)) return false;
  const identity = await resolver.read(reading.pid);
  if (identity.kind === "unknown") return false;
  if (identity.kind === "absent") return true;
  return identity.birth !== reading.birth;
}

async function requireCurrentIdentity(
  resolver: ProcessIdentityResolver,
  resourceName: string,
): Promise<{ readonly kind: "present"; readonly birth: string }> {
  const identity = await resolver.read(process.pid);
  if (identity.kind !== "present") {
    throw new Error(`${resourceName} reclaim owner identity is unavailable`);
  }
  return identity;
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
  const current = await readLockFile(lockPath);
  if ((current.kind !== "valid" && current.kind !== "legacy") || current.token !== token) return;
  const timestamp = new Date(now());
  await utimes(lockPath, timestamp, timestamp).catch(() => undefined);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
