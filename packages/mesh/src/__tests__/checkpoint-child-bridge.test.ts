import { createTempDir } from "@zhixing/test-utils";
import { realpath, open, link, writeFile, readFile, readdir, stat, mkdir, symlink, lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freezeCheckpointDirectory } from "../checkpoint-target.js";
import { CheckpointDirectoryHandle } from "../checkpoint-child-bridge.js";
import { setTimeout as delay } from "node:timers/promises";

describe("checkpoint child bridge", () => {
  it.skipIf(process.platform !== "win32")("reads finite ordinal directory pages across native buffers and fresh handles", async () => {
    const root = await realpath(await createTempDir('checkpoint-directory-pages'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const names = Array.from({ length: 193 }, (_, index) => `${'x'.repeat(156)}-${index}`);
    try {
      const writer = await session.openPath(root, false);
      try { for (const name of names) await writer.writeFile(name, Buffer.from('page')); }
      finally { await writer.close(); }
      const found: string[] = [];
      for (;;) {
        const directory = await session.openPath(root, false);
        try {
          const page = await directory.listEntryPage(found.length, 32);
          expect(page.names.length).toBeLessThanOrEqual(32);
          found.push(...page.names);
          if (page.end) break;
        } finally { await directory.close(); }
      }
      expect([...found].sort()).toEqual([...names].sort());
      expect(new Set(found).size).toBe(names.length);
      const directory = await session.openPath(root, false);
      try {
        await expect(directory.listEntryPage(0, 33)).rejects.toThrow();
        await expect(directory.listEntryPage(4097, 1)).rejects.toThrow();
        expect(await directory.listEntryPage(names.length, 32)).toEqual({ names: [], end: true });
      } finally { await directory.close(); }
    } finally { await session.close(); }
  }, 15_000);

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

  it.skipIf(process.platform !== 'win32')('copies bounded ranges between pinned identities and rejects substitutions before appending', async () => {
    const root = await realpath(await createTempDir('checkpoint-copy-range'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      const content = Buffer.from('0123456789'.repeat(20000));
      await directory.writeFile('source', content);
      const source = await directory.statFile('source');
      const first = await directory.copyRange('source', source.identity, content.length, 7, 'target', undefined, 0, 100000);
      expect(await directory.readFile('target', 100000, 0, 100000, first.identity)).toEqual(content.subarray(7, 100007));
      await expect(directory.copyRange('source', 'wrong-source', content.length, 0, 'target', first.identity, 100000, 8)).rejects.toThrow();
      await expect(directory.copyRange('source', source.identity, content.length, 0, 'target', 'wrong-target', 100000, 8)).rejects.toThrow();
      expect(await directory.statFile('target')).toEqual({ bytes: 100000, identity: first.identity });
      await expect(directory.copyRange('source', source.identity, content.length, 0, 'target', first.identity, 99999, 8)).rejects.toThrow();
      await expect(directory.copyRange('source', source.identity, content.length, 0, 'oversized', undefined, 0, 1024 * 1024 + 1)).rejects.toThrow();
      const second = await directory.copyRange('source', source.identity, content.length, 100007, 'target', first.identity, 100000, 80000);
      expect(second.identity).toBe(first.identity);
      expect(await directory.readFile('target', 180000, 0, 180000, second.identity)).toEqual(content.subarray(7, 180007));
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('rejects an incompatible new-copy offset without creating a target and permits a corrected retry', async () => {
    const root = await realpath(await createTempDir('checkpoint-copy-admission'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await directory.writeFile('source', Buffer.from('0123456789'));
      const source = await directory.statFile('source');
      await expect(directory.copyRange('source', source.identity, source.bytes, 0, 'target', undefined, 1, 3)).rejects.toThrow('Invalid bounded file copy');
      expect(await readdir(root)).toEqual(['source']);
      expect(await directory.statFile('source')).toEqual(source);
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('0123456789');
      const target = await directory.copyRange('source', source.identity, source.bytes, 0, 'target', undefined, 0, 3);
      expect(target.bytes).toBe(3);
      expect(await directory.readFile('target', 3, 0, 3, target.identity)).toEqual(Buffer.from('012'));
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('rejects self-copy through case aliases by actual identity before writing and preserves distinct-file copies', async () => {
    const root = await realpath(await createTempDir('checkpoint-copy-alias'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await directory.writeFile('source.bin', Buffer.from('0123456789'));
      const source = await directory.statFile('source.bin');
      for (const [from, to] of [['source.bin', 'SOURCE.BIN'], ['SOURCE.BIN', 'source.bin']] as const) {
        expect(await directory.statFile(to)).toEqual(source);
        await expect(directory.copyRange(from, source.identity, source.bytes, 0, to, source.identity, source.bytes, 3)).rejects.toThrow('Cannot copy a checkpoint file into itself');
        expect(await directory.statFile('source.bin')).toEqual(source);
        expect(await readFile(path.join(root, 'source.bin'), 'utf8')).toBe('0123456789');
      }
      await expect(directory.copyRange('source.bin', source.identity, source.bytes, 0, 'SOURCE.BIN', undefined, 0, 3)).rejects.toThrow();
      expect(await readdir(root)).toEqual(['source.bin']);
      await directory.writeFile('distinct.bin', Buffer.from('0123456789'));
      const distinct = await directory.statFile('distinct.bin');
      expect(distinct.identity).not.toBe(source.identity);
      const result = await directory.copyRange('SOURCE.BIN', source.identity, source.bytes, 0, 'DISTINCT.BIN', distinct.identity, distinct.bytes, 3);
      expect(result.identity).toBe(distinct.identity);
      expect(result.bytes).toBe(13);
      expect(await readFile(path.join(root, 'distinct.bin'), 'utf8')).toBe('0123456789012');
      expect(await directory.statFile('source.bin')).toEqual(source);
      expect(await readFile(path.join(root, 'source.bin'), 'utf8')).toBe('0123456789');
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('preserves both names on a default rename collision and atomically replaces an ordinary target', async () => {
    const root = await realpath(await createTempDir('checkpoint-rename-replace'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await directory.writeFile('source', Buffer.from('new'));
      await directory.writeFile('target', Buffer.from('old'));
      const source = await directory.statFile('source'), target = await directory.statFile('target');
      await expect(directory.renameTo('source', directory, 'target')).rejects.toThrow();
      expect(await directory.statFile('source')).toEqual(source);
      expect(await directory.statFile('target')).toEqual(target);
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('new');
      expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('old');
      await directory.renameTo('source', directory, 'target', true);
      expect(await directory.statFile('target')).toEqual(source);
      expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('new');
      expect(await readdir(root)).toEqual(['target']);
      await directory.renameTo('target', directory, 'absent', true);
      expect(await directory.statFile('absent')).toEqual(source);
      const child = await directory.openDirectory('source-dir', true);
      const identity = child.identity; await child.close();
      await directory.renameTo('source-dir', directory, 'target-dir', true);
      expect(await directory.statEntry('target-dir')).toMatchObject({ kind: 'directory', identity });
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('does not create a missing resumed or identity-bound durable prefix and preserves valid append and replay', async () => {
    const root = await realpath(await createTempDir('checkpoint-prefix-admission'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await expect(directory.writeRange('missing-offset', 16, 1, Buffer.from('x'))).rejects.toThrow();
      await expect(directory.writeRange('missing-identity', 16, 0, Buffer.from('x'), 'expected-existing-identity')).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
      for (const name of ['missing-offset', 'missing-identity']) {
        expect(await directory.writeRange(name, 16, 0, Buffer.from('x'))).toBe(1);
        const initial = await directory.statFile(name);
        expect(await directory.writeRange(name, 16, 1, Buffer.from('y'), initial.identity)).toBe(2);
        expect(await directory.writeRange(name, 16, 2, Buffer.from('z'))).toBe(3);
        expect(await directory.writeRange(name, 16, 0, Buffer.from('xy'))).toBe(3);
        await expect(directory.writeRange(name, 16, 3, Buffer.from('!'), 'wrong-identity')).rejects.toThrow();
        await expect(directory.writeRange(name, 16, 0, Buffer.from('changed'))).rejects.toThrow();
        expect(await directory.statFile(name)).toEqual({ bytes: 3, identity: initial.identity });
        expect(await readFile(path.join(root, name), 'utf8')).toBe('xyz');
      }
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a pre-existing hardlinked rename or copy target before changing either name or contents', async () => {
    const root = await realpath(await createTempDir('checkpoint-unsafe-replacement'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await directory.writeFile('source', Buffer.from('replacement'));
      const source = await directory.statFile('source');
      await directory.writeFile('target', Buffer.from('original'));
      const target = await directory.statFile('target');
      await link(path.join(root, 'target'), path.join(root, 'alias'));
      const before = await stat(path.join(root, 'target'));
      expect(before.nlink).toBe(2);
      await expect(directory.renameTo('source', directory, 'target', true)).rejects.toThrow('multiple links');
      await expect(directory.copyRange('source', source.identity, source.bytes, 0, 'target', target.identity, target.bytes, 3)).rejects.toThrow();
      await expect(directory.writeRange('target', 16, target.bytes, Buffer.from('x'), target.identity)).rejects.toThrow();
      expect(await directory.statFile('source')).toEqual(source);
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('replacement');
      for (const name of ['target', 'alias']) {
        const after = await stat(path.join(root, name));
        expect({ ino: after.ino, nlink: after.nlink, size: after.size }).toEqual({ ino: before.ino, nlink: 2, size: before.size });
        expect(await readFile(path.join(root, name), 'utf8')).toBe('original');
      }
      await expect(directory.renameTo('target', directory, 'new-name', true)).rejects.toThrow('Unsafe rename source identity');
      expect((await readdir(root)).sort()).toEqual(['alias', 'source', 'target']);
    } finally { await directory.close(); await session.close(); }
  });

  it.skipIf(process.platform !== 'win32')('preserves a reparse replacement target and its referent when rename is rejected', async () => {
    const root = await realpath(await createTempDir('checkpoint-reparse-replacement'));
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const directory = await session.openPath(root, false);
    try {
      await directory.writeFile('source', Buffer.from('replacement'));
      const source = await directory.statFile('source');
      await mkdir(path.join(root, 'referent'));
      await writeFile(path.join(root, 'referent', 'marker'), 'owned fixture');
      await symlink(path.join(root, 'referent'), path.join(root, 'target'), 'junction');
      const before = await lstat(path.join(root, 'target')), destination = await readlink(path.join(root, 'target'));
      await expect(directory.renameTo('source', directory, 'target', true)).rejects.toThrow();
      expect(await directory.statFile('source')).toEqual(source);
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('replacement');
      expect((await lstat(path.join(root, 'target'))).ino).toBe(before.ino);
      expect(await readlink(path.join(root, 'target'))).toBe(destination);
      expect(await readFile(path.join(root, 'referent', 'marker'), 'utf8')).toBe('owned fixture');
    } finally { await directory.close(); await session.close(); }
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
