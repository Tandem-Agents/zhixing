import { spawn } from "node:child_process";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { prepareExclusiveFileClaim } from "../exclusive-file-claim.js";
import { acquireFileLock } from "../file-lock.js";
import {
  createProcessIdentityResolver,
  type ProcessIdentityReading,
  type ProcessIdentityResolver,
} from "../process-identity.js";

describe("file lock atomic publication", () => {
  it("publishes only one complete owner when prepared contenders interleave", async () => {
    const directory = await createTempDir("file-lock-publication");
    const lockPath = path.join(directory, "resource.lock");
    const firstToken = "a".repeat(32);
    const secondToken = "b".repeat(32);
    const firstRecord = lockRecord(firstToken);
    const secondRecord = lockRecord(secondToken);
    const first = await prepareExclusiveFileClaim(lockPath, firstRecord, firstToken);

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await prepareExclusiveFileClaim(lockPath, secondRecord, secondToken);
    await expect(second.publish()).resolves.toBe(true);
    await expect(first.publish()).resolves.toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(secondRecord);

    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("removes stale incomplete claims without exposing them as the lock", async () => {
    const directory = await createTempDir("file-lock-orphan-claim");
    const lockPath = path.join(directory, "resource.lock");
    const claimPath = `${lockPath}.claim-${"c".repeat(32)}`;
    await writeFile(claimPath, "{", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(claimPath, stale, stale);

    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 500,
      retryMs: 5,
    });

    await expect(stat(claimPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    await release();
  });

  it("keeps a stale heartbeat busy while the exact process identity is still alive", async () => {
    const directory = await createTempDir("file-lock-pid-reuse");
    const lockPath = path.join(directory, "resource.lock");
    const staleToken = "d".repeat(32);
    await writeFile(lockPath, versionedLockRecord(staleToken, "same-process", 424_242), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await expect(acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 30,
      retryMs: 5,
      processIdentityResolver: fixedResolver({ kind: "present", birth: "same-process" }),
    })).rejects.toThrow(/busy/u);
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe(staleToken);
  });

  it.each([
    [{ kind: "absent" } as const, "owner disappeared"],
    [{ kind: "present", birth: "successor" } as const, "PID was reused"],
  ])("reclaims only when the recorded process is proven replaced: %s", async (owner) => {
    const directory = await createTempDir("file-lock-reclaim");
    const lockPath = path.join(directory, "resource.lock");
    const staleToken = "d".repeat(32);
    await writeFile(lockPath, versionedLockRecord(staleToken, "old-process", 424_242), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 500,
      retryMs: 5,
      processIdentityResolver: fixedResolver(owner),
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).not.toBe(staleToken);
    await release();
  });

  it("fails closed when process identity cannot be proved", async () => {
    const directory = await createTempDir("file-lock-unknown-owner");
    const lockPath = path.join(directory, "resource.lock");
    await writeFile(lockPath, versionedLockRecord("e".repeat(32), "owner", 424_242), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await expect(acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 30,
      retryMs: 5,
      processIdentityResolver: fixedResolver({ kind: "unknown" }),
    })).rejects.toThrow(/busy/u);
  });

  it("keeps a paused-style stale child lock busy, then reclaims it after the child crashes", async () => {
    const directory = await createTempDir("file-lock-real-child");
    const lockPath = path.join(directory, "resource.lock");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const resolver = createProcessIdentityResolver();
    const live = await resolver.read(child.pid!);
    if (live.kind !== "present") throw new Error("child process identity was not observable");
    await writeFile(lockPath, versionedLockRecord("f".repeat(32), live.birth, child.pid), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    try {
      await expect(acquireFileLock(lockPath, {
        staleMs: 100,
        waitMs: 30,
        retryMs: 5,
        processIdentityResolver: resolver,
      })).rejects.toThrow(/busy/u);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 5_000,
      retryMs: 5,
      processIdentityResolver: resolver,
    });
    expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
    await release();
  }, 120_000);
});

describe("platform process identity projection", () => {
  it("uses the Linux boot identity and raw start ticks without a clock-rate guess", async () => {
    const fields = Array.from({ length: 20 }, (_, index) => index === 19 ? "98765" : "0");
    const resolver = createProcessIdentityResolver({
      platform: "linux",
      probe: () => "present",
      readFile: (async (file: unknown) => String(file).includes("/stat")
        ? `42 (worker name) ${fields.join(" ")}`
        : "12345678-1234-1234-1234-123456789abc\n") as never,
    });
    await expect(resolver.read(42)).resolves.toEqual({
      kind: "present",
      birth: "linux:12345678-1234-1234-1234-123456789abc:98765",
    });
  });

  it.each([
    ["darwin", "Mon Aug 14 10:20:30 2026", "darwin:Mon Aug 14 10:20:30 2026"],
    ["win32", "638907060300000000", "win32:638907060300000000"],
  ] as const)("projects a stable %s birth identity", async (platform, output, birth) => {
    const resolver = createProcessIdentityResolver({
      platform,
      probe: () => "present",
      execFileSync: (() => output) as never,
    });
    await expect(resolver.read(42)).resolves.toEqual({ kind: "present", birth });
  });

  it("distinguishes confirmed absence from an unreadable live identity", async () => {
    const absent = createProcessIdentityResolver({
      platform: "linux",
      probe: () => "absent",
    });
    await expect(absent.read(42)).resolves.toEqual({ kind: "absent" });
    const unknown = createProcessIdentityResolver({
      platform: "linux",
      probe: () => "present",
      readFile: (async () => { throw new Error("denied"); }) as never,
    });
    await expect(unknown.read(42)).resolves.toEqual({ kind: "unknown" });
  });
});

function lockRecord(token: string): string {
  return `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`;
}

function versionedLockRecord(token: string, birth: string, pid = process.pid): string {
  return `${JSON.stringify({ v: 1, pid, token, createdAt: Date.now(), birth })}\n`;
}

function fixedResolver(owner: ProcessIdentityReading): ProcessIdentityResolver {
  return {
    read: async (pid) => pid === process.pid
      ? { kind: "present", birth: "self" }
      : owner,
  };
}
