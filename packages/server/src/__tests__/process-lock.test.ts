import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  releaseLock,
  readLock,
  isProcessAlive,
  ProcessLockError,
} from "../process-lock.js";

describe("ProcessLock", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-lock-"));
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("acquires lock and writes pid + port files", async () => {
    await acquireLock(18900, { pidPath, portPath });

    const pid = await readLock({ pidPath, portPath });
    expect(pid?.pid).toBe(process.pid);
    expect(pid?.port).toBe(18900);
    expect(pid?.startedAt).toBeTruthy();

    const portContent = await readFile(portPath, "utf-8");
    expect(portContent).toBe("18900");
  });

  it("releaseLock removes files", async () => {
    await acquireLock(18900, { pidPath, portPath });
    await releaseLock({ pidPath, portPath });
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("releaseLock is idempotent (no error when files missing)", async () => {
    await releaseLock({ pidPath, portPath });
    await releaseLock({ pidPath, portPath });
  });

  it("acquireLock fails when another live process holds the lock", async () => {
    // Write pid file pointing to current process (definitely alive)
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    await expect(acquireLock(18901, { pidPath, portPath })).rejects.toBeInstanceOf(
      ProcessLockError,
    );
  });

  it("acquireLock recovers from stale pid file (process not alive)", async () => {
    // Write pid file pointing to clearly invalid PID
    await writeFile(
      pidPath,
      JSON.stringify({ pid: 999999999, port: 18900, startedAt: "2020-01-01T00:00:00Z" }),
      "utf-8",
    );

    await acquireLock(18901, { pidPath, portPath });

    const pid = await readLock({ pidPath, portPath });
    expect(pid?.pid).toBe(process.pid);
    expect(pid?.port).toBe(18901);
  });

  it("readLock returns null when file missing", async () => {
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("readLock returns null on corrupted file", async () => {
    await writeFile(pidPath, "{ not json", "utf-8");
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for impossibly large pid", () => {
    expect(isProcessAlive(999999999)).toBe(false);
  });
});
