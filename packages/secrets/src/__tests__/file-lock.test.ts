import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { acquireFileLock } from "../file-lock.js";

describe("SecretStore file lock", () => {
  it("reclaims an expired lock only when its process is gone", async () => {
    const directory = await createTempDir("secret-lock-dead");
    const lockPath = path.join(directory, "vault.lock");
    const deadPid = 2_147_483_647;
    await writeVersionedLock(
      lockPath,
      deadPid,
      "a".repeat(32),
      "test:dead-process",
    );
    await makeStale(lockPath);

    const release = await acquireFileLock(lockPath, {
      staleMs: 100,
      waitMs: 500,
      retryMs: 5,
      processIdentityResolver: {
        read: async (pid) => pid === deadPid
          ? { kind: "absent" }
          : { kind: "present", birth: "test:self" },
      },
    });
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    expect(owner.pid).toBe(process.pid);
    await release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never steals a fresh lock from a live process", async () => {
    const directory = await createTempDir("secret-lock-live");
    const lockPath = path.join(directory, "vault.lock");
    const token = "b".repeat(32);
    await writeLock(lockPath, process.ppid, token);
    await expect(
      acquireFileLock(lockPath, {
        staleMs: 100,
        waitMs: 30,
        retryMs: 5,
      }),
    ).rejects.toThrow("lock is busy");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token });
  });

  it("never steals a stale lock while its recorded process is still alive", async () => {
    const directory = await createTempDir("secret-lock-reused-pid");
    const lockPath = path.join(directory, "vault.lock");
    await writeLock(lockPath, process.ppid, "e".repeat(32));
    await makeStale(lockPath);

    await expect(
      acquireFileLock(lockPath, {
        staleMs: 100,
        waitMs: 30,
        retryMs: 5,
      }),
    ).rejects.toThrow("lock is busy");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.ppid,
      token: "e".repeat(32),
    });
  });

  it("fails closed for a stale unknown generation owned by the current process", async () => {
    const directory = await createTempDir("secret-lock-self-orphan");
    const lockPath = path.join(directory, "vault.lock");
    await writeLock(lockPath, process.pid, "d".repeat(32));
    await makeStale(lockPath);

    await expect(
      acquireFileLock(lockPath, {
        staleMs: 100,
        waitMs: 30,
        retryMs: 5,
      }),
    ).rejects.toThrow("lock is busy");
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      pid: process.pid,
      token: "d".repeat(32),
    });
  });

  it("releases only the lock generation it acquired", async () => {
    const directory = await createTempDir("secret-lock-owner");
    const lockPath = path.join(directory, "vault.lock");
    const release = await acquireFileLock(lockPath, {
      staleMs: 1_000,
      waitMs: 100,
    });
    const replacementToken = "c".repeat(32);
    await writeLock(lockPath, process.pid, replacementToken);

    await release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({
      token: replacementToken,
    });
  });
});

async function writeLock(lockPath: string, pid: number, token: string): Promise<void> {
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid, token, createdAt: Date.now() - 60_000 })}\n`,
    "utf8",
  );
}

async function writeVersionedLock(
  lockPath: string,
  pid: number,
  token: string,
  birth: string,
): Promise<void> {
  await writeFile(
    lockPath,
    `${JSON.stringify({ v: 1, pid, token, createdAt: Date.now() - 60_000, birth })}\n`,
    "utf8",
  );
}

async function makeStale(lockPath: string): Promise<void> {
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);
}
