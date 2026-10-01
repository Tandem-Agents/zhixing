import { createTempDir } from "@zhixing/test-utils";
import { realpath, open, link, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freezeCheckpointDirectory } from "../checkpoint-target.js";
import { CheckpointDirectoryHandle } from "../checkpoint-child-bridge.js";
import { setTimeout as delay } from "node:timers/promises";

describe("checkpoint child bridge", () => {
  it.skipIf(process.platform === "win32")("preserves errno when a file obstructs a directory operation", async () => {
    const root = await realpath(await createTempDir("checkpoint-posix-cause"));
    const file = path.join(root, "obstruction");
    await writeFile(file, "owned fixture");
    await expect(CheckpointDirectoryHandle.openPath(file, false)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("shares an existing read-only control lock and excludes writers without modifying the directory", async () => {
    const root = await realpath(await createTempDir("checkpoint-read-lock"));
    const sessions = process.platform === "win32" ? Array.from({ length: 3 }, () => CheckpointDirectoryHandle.createWindowsSession()) : [];
    const writer = await (sessions[0]?.openPath(root, false) ?? CheckpointDirectoryHandle.openPath(root, false));
    const reader = await (sessions[1]?.openPath(root, false, true) ?? CheckpointDirectoryHandle.openPath(root, false, true));
    const other = await (sessions[2]?.openPath(root, false, true) ?? CheckpointDirectoryHandle.openPath(root, false, true));
    let write: (() => Promise<void>) | undefined, read: (() => Promise<void>) | undefined, readOther: (() => Promise<void>) | undefined;
    try {
      await expect(reader.waitLock("missing.lock", 50, "shared")).rejects.toThrow();
      expect(await reader.listEntries(10)).toEqual([]);
      write = await writer.tryLock("writer.lock");
      expect(await reader.waitLock("writer.lock", 50, "shared")).toBeUndefined();
      await write!(); write = undefined;
      read = await reader.waitLock("writer.lock", 500, "shared");
      readOther = await other.waitLock("writer.lock", 500, "shared");
      expect(read).toBeDefined(); expect(readOther).toBeDefined();
      expect(await writer.tryLock("writer.lock")).toBeUndefined();
      await read!(); read = undefined;
      expect(await writer.tryLock("writer.lock")).toBeUndefined();
      await readOther!(); readOther = undefined;
      write = await writer.tryLock("writer.lock"); expect(write).toBeDefined();
      expect(await reader.listEntries(10)).toEqual(["writer.lock"]);
    } finally {
      await write?.(); await read?.(); await readOther?.();
      await Promise.all([writer.close(), reader.close(), other.close()]);
      await Promise.all(sessions.map(session => session.close()));
    }
  }, 15_000);

  it.skipIf(process.platform !== "win32")("hands a released lock to a pending writer and cancels timeout without a ghost lock", async () => {
    const root = await realpath(await createTempDir("checkpoint-queued-lock"));
    const a = CheckpointDirectoryHandle.createWindowsSession(), b = CheckpointDirectoryHandle.createWindowsSession();
    let releaseA: (() => Promise<void>) | undefined, releaseB: (() => Promise<void>) | undefined;
    try {
      const first = await a.openPath(root, false), second = await b.openPath(root, false);
      releaseA = await first.tryLock("writer.lock");
      expect(releaseA).toBeDefined();
      expect(await second.waitLock("writer.lock", 50)).toBeUndefined();
      const waiting = second.waitLock("writer.lock", 2000);
      await delay(100);
      await releaseA!(); releaseA = undefined;
      // The prior writer must not leapfrog the already-pending kernel request.
      releaseA = await first.tryLock("writer.lock");
      expect(releaseA).toBeUndefined();
      releaseB = await waiting;
      expect(releaseB).toBeDefined();
      await releaseB!(); releaseB = undefined;
      releaseA = await first.tryLock("writer.lock");
      expect(releaseA).toBeDefined();
      expect(await first.listEntries(10)).toEqual(["writer.lock"]);
      await expect(second.waitLock("writer.lock", 2001)).rejects.toThrow();
      const interrupted = second.waitLock("writer.lock", 2000).then(
        () => "unexpected-grant", () => "owner-closed",
      );
      await delay(50);
      await b.close();
      expect(await interrupted).toBe("owner-closed");
      await releaseA!(); releaseA = undefined;
      releaseA = await first.tryLock("writer.lock");
      expect(releaseA).toBeDefined();
    } finally { await releaseA?.(); await releaseB?.(); await a.close(); await b.close(); }
  });

  it("batches file inspection without weakening child identity or link checks", async () => {
    const root = await realpath(await createTempDir("checkpoint-batch-stat"));
    const directory = await freezeCheckpointDirectory(root, false);
    try {
      await directory.handle.writeFile("one", Buffer.from("1"));
      await directory.handle.writeFile("two", Buffer.from("22"));
      const one = await directory.handle.statFile("one"), two = await directory.handle.statFile("two");
      expect(await directory.handle.statFiles(["two", "one"])).toEqual([two, one]);
      expect(await directory.handle.statFiles([])).toEqual([]);
      await expect(directory.handle.statFiles(["../one"])).rejects.toThrow();
      await expect(directory.handle.statFiles(Array(4097).fill("one"))).rejects.toThrow();
      await expect(directory.handle.statFiles(["one", "missing"])).rejects.toThrow();
      await link(path.join(root, "one"), path.join(root, "alias"));
      await expect(directory.handle.statFiles(["two", "one"])).rejects.toThrow();
    } finally { await directory.handle.close(); }
  });

  it("opens an existing filesystem root and round-trips bytes through the platform helper", async () => {
    const root = await realpath(await createTempDir("checkpoint-child-bridge"));
    const directory = await freezeCheckpointDirectory(root, false);
    try {
      await directory.handle.writeFile("probe.bin", Buffer.from("node24", "utf8"));
      const bytes = await directory.handle.readFile("probe.bin", -1, 0, 64);
      expect(bytes.toString("utf8")).toBe("node24");
      expect(await directory.handle.listEntries(10)).toEqual(["probe.bin"]);
      expect(await directory.handle.listEntries(10)).toEqual(["probe.bin"]);
      await directory.handle.renameTo("probe.bin", directory.handle, "renamed.bin");
      expect(await directory.handle.listEntries(10)).toEqual(["renamed.bin"]);
      await directory.handle.sync();
      await directory.handle.unlink("renamed.bin", false);
      expect(await directory.handle.listEntries(10)).toEqual([]);
    } finally {
      await directory.handle.close();
    }
  });

  it("uses a fixed OS lock and confirms truncation with an external reader still open", async () => {
    const root = await realpath(await createTempDir("checkpoint-log-primitives"));
    const directory = await freezeCheckpointDirectory(root, false);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await directory.handle.tryLock("writer.lock"); expect(release).toBeDefined();
      expect(await directory.handle.tryLock("writer.lock")).toBeUndefined();
      await directory.handle.writeFile("retired.jsonl", Buffer.alloc(8192)); await directory.handle.sync();
      const identity = await directory.handle.statFile("retired.jsonl");
      const reader = await open(path.join(root, "retired.jsonl"), "r");
      try {
        await directory.handle.truncateFile("retired.jsonl", identity.identity, 0);
        expect((await reader.stat()).size).toBe(0);
        await directory.handle.removeRetired("retired.jsonl", identity.identity); await directory.handle.sync();
        expect(await directory.handle.listEntries(10)).not.toContain("retired.jsonl");
      } finally { await reader.close(); }
      await release(); release = undefined;
      release = await directory.handle.tryLock("writer.lock"); expect(release).toBeDefined();
    } finally { await release?.(); await directory.handle.close(); }
  });
});
