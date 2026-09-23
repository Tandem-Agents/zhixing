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
  ])("reclaims without waiting only when the recorded process is proven replaced: %s", async (owner) => {
    const directory = await createTempDir("file-lock-reclaim");
    const lockPath = path.join(directory, "resource.lock");
    const staleToken = "d".repeat(32);
    await writeFile(lockPath, versionedLockRecord(staleToken, "old-process", 424_242), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 0,
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

  it.each([
    ["dead", "acquired"],
    ["alive", "busy"],
    ["unknown", "busy"],
  ] as const)("recovers a dead owner with a %s reclaimer without waiting", async (reclaimer, outcome) => {
    const directory = await createTempDir("file-lock-reclaimer");
    const lockPath = path.join(directory, "resource.lock");
    await writeFile(lockPath, versionedLockRecord("a".repeat(32), "old-owner", 424_242));
    await writeFile(`${lockPath}.reclaim`, versionedLockRecord("b".repeat(32), "reclaimer", 424_243));
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await utimes(`${lockPath}.reclaim`, stale, stale);
    const acquire = acquireFileLock(lockPath, {
      staleMs: 100, waitMs: 0,
      processIdentityResolver: { read: async pid => pid === process.pid
        ? { kind: "present", birth: "current" }
        : pid === 424_242 || reclaimer === "dead" ? { kind: "absent" }
        : reclaimer === "alive" ? { kind: "present", birth: "reclaimer" } : { kind: "unknown" } },
    });
    if (outcome === "acquired") {
      const release = await acquire;
      expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
      await expect(stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
      await release();
    } else {
      await expect(acquire).rejects.toThrow(/busy/u);
      expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(424_242);
      expect(JSON.parse(await readFile(`${lockPath}.reclaim`, "utf8")).pid).toBe(424_243);
    }
  });

  it.each([1, 2])("preserves exclusion when two contenders saw a dead guard (%s dead guard levels)", async depth => {
    const directory = await createTempDir("file-lock-reclaim-race");
    const lockPath = path.join(directory, "resource.lock");
    const stale = new Date(Date.now() - 60_000);
    for (let level = 0; level <= depth; level++) {
      const file = lockPath + ".reclaim".repeat(level);
      await writeFile(file, versionedLockRecord(String.fromCharCode(97 + level).repeat(32), "dead", 424_242 + level));
      await utimes(file, stale, stale);
    }
    const gate = () => {
      let resolve!: () => void;
      return { promise: new Promise<void>(done => { resolve = done; }), open: () => resolve() };
    };
    const bSawDeadGuard = gate(), resumeBStaleRead = gate(), aInsideGuard = gate(), resumeA = gate();
    const bInsideGuard = gate(), resumeBDeletion = gate();
    const resolver = (name: "A" | "B"): ProcessIdentityResolver => {
      let heldGuardOnce = false, guardReadOnce = false;
      return { read: async pid => {
        if (pid === process.pid) return { kind: "present", birth: "current" };
        if (pid === 424_243 && name === "B" && !guardReadOnce) {
          guardReadOnce = true; bSawDeadGuard.open(); await resumeBStaleRead.promise;
        }
        if (pid === 424_242 && !heldGuardOnce) {
          const guard = await readFile(`${lockPath}.reclaim`, "utf8").then(JSON.parse).catch(() => undefined);
          if (guard?.pid === process.pid) {
            heldGuardOnce = true;
            if (name === "A") { aInsideGuard.open(); await resumeA.promise; }
            else { bInsideGuard.open(); await resumeBDeletion.promise; }
          }
        }
        return { kind: "absent" };
      } };
    };
    const acquire = (name: "A" | "B") => acquireFileLock(lockPath, {
      staleMs: 100, waitMs: 0, processIdentityResolver: resolver(name),
    }).then(release => ({ kind: "acquired" as const, release }), error => ({ kind: "busy" as const, error }));
    const second = acquire("B");
    await bSawDeadGuard.promise;
    const first = acquire("A");
    try {
      await aInsideGuard.promise;
      // B's read predates A's live guard. It must not delete that successor.
      resumeBStaleRead.open();
      const next = await Promise.race([second.then(() => "settled"), bInsideGuard.promise.then(() => "entered")]);
      resumeA.open();
      const a = await first;
      // Under the old implementation B reached deletion and acquired before
      // A released. Let that trace finish so the assertion catches the breach.
      if (next === "entered") resumeBDeletion.open();
      const b = await second;
      expect(a.kind).toBe("acquired");
      expect(b.kind).toBe("busy");
      if (b.kind === "busy") expect(b.error.message).toMatch(/busy/u);
      if (a.kind === "acquired") await a.release();
      const retry = await acquire("B");
      expect(retry.kind).toBe("acquired");
      if (retry.kind === "acquired") await retry.release();
    } finally {
      resumeA.open(); resumeBStaleRead.open(); resumeBDeletion.open();
      for (const result of await Promise.all([first, second])) if (result.kind === "acquired") await result.release();
    }
  }, 20_000);

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
