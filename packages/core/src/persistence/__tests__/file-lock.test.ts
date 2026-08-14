import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { prepareExclusiveFileClaim } from "../exclusive-file-claim.js";
import { acquireFileLock } from "../file-lock.js";

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

  it("reclaims a stale heartbeat even when the recorded PID has been reused", async () => {
    const directory = await createTempDir("file-lock-pid-reuse");
    const lockPath = path.join(directory, "resource.lock");
    const staleToken = "d".repeat(32);
    await writeFile(lockPath, lockRecord(staleToken), "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 500,
      retryMs: 5,
    });

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expect(JSON.parse(await readFile(lockPath, "utf8")).token).not.toBe(staleToken);
    await release();
  });
});

function lockRecord(token: string): string {
  return `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`;
}
