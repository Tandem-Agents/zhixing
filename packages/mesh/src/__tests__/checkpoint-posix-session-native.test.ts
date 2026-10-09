import { describe, expect, it } from 'vitest';
import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { closeSync, constants, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointDirectoryHandle } from '../checkpoint-child-bridge.js';
import { checkpointBridgeTarget, verifyCheckpointBridgeArtifact } from '../checkpoint-bridge-artifact.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';

interface NativeFixture {
  openPath(path: string, create: boolean): bigint;
  openDirectory(parent: bigint, name: string, create: boolean): bigint;
  identity(handle: bigint): string;
  writeFile(parent: bigint, name: string, bytes: Buffer): void;
  writeRange(parent: bigint, name: string, maximumBytes: number, offset: number, bytes: Buffer, identity: string): number;
  copyRange(parent: bigint, source: string, sourceIdentity: string, sourceBytes: number, sourceOffset: number, target: string, targetIdentity: string, targetOffset: number, length: number): unknown;
  statFile(parent: bigint, name: string): { identity: string; bytes: number };
  renameEntry(parent: bigint, name: string, target: bigint, targetName: string, replace?: boolean): void;
  unlinkEntry(parent: bigint, name: string, directory: boolean, retiredIdentity: string, expectedIdentity: string): void;
  close(handle: bigint): void;
}

function nativeFixture(): NativeFixture {
  return createRequire(import.meta.url)(verifyCheckpointBridgeArtifact(
    fileURLToPath(new URL('../../', import.meta.url)), checkpointBridgeTarget(),
  )) as NativeFixture;
}

// node-gyp already requires Python on the POSIX build host. This finite, local
// fixture holds the same OS lock without adding a production test-only API.
async function holdNamespace(directory: string): Promise<() => Promise<void>> {
  const child = spawn('python3', ['-c', `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('locked', flush=True)
    sys.stdin.buffer.read(1)
finally:
    os.close(fd)
`, directory], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin.on('error', () => { /* A failed fixture may close stdin before cleanup. */ });
  child.stderr.resume();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Namespace fixture did not acquire its lock')), 3000);
      let output = '';
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', finish);
      child.once('close', () => finish(Error('Namespace fixture exited before readiness')));
      child.stdout.on('data', chunk => {
        output += String(chunk);
        if (output === 'locked\n') finish();
        else if (output.length > 64) finish(Error('Invalid namespace fixture reply'));
      });
    });
    return stop;
  } catch (cause) { await stop(); throw cause; }
}

describe.skipIf(!posix)('owned POSIX native filesystem', () => {
  it('rejects different-case names of one inode before copying on a case-insensitive volume', async context => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-case-alias-')));
    const native = nativeFixture(), raw = native.openPath(root, false);
    const session = CheckpointDirectoryHandle.createPosixSession();
    try {
      const original = Buffer.from('0123456789');
      native.writeFile(raw, 'source.bin', original);
      const source = await stat(path.join(root, 'source.bin'));
      const alias = await stat(path.join(root, 'SOURCE.BIN')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!alias) {
        console.info('case-alias guard: not applicable on this case-sensitive fixture volume');
        context.skip(); return;
      }
      expect(alias.dev).toBe(source.dev); expect(alias.ino).toBe(source.ino);
      expect(source.nlink).toBe(1); expect(alias.nlink).toBe(1);
      const info = native.statFile(raw, 'source.bin');
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      const before = digest(original);
      // Distinct strings and nlink=1 reach the actual opened target identity guard.
      expect(() => native.copyRange(raw, 'source.bin', info.identity, 10, 0, 'SOURCE.BIN', info.identity, 10, 3)).toThrow();
      const managed = await session.openPath(root, false);
      await expect(managed.copyRange('source.bin', info.identity, 10, 0, 'SOURCE.BIN', info.identity, 10, 3)).rejects.toThrow();
      for (const name of ['source.bin', 'SOURCE.BIN']) {
        const bytes = await readFile(path.join(root, name));
        expect(bytes).toEqual(original); expect(digest(bytes)).toBe(before);
      }
    } finally { native.close(raw); await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('rejects invalid creation and unsafe replacement before changing names', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-admission-')));
    const native = nativeFixture(), raw = native.openPath(root, false);
    const session = CheckpointDirectoryHandle.createPosixSession();
    try {
      native.writeFile(raw, 'source', Buffer.from('abc'));
      const source = native.statFile(raw, 'source');
      expect(() => native.copyRange(raw, 'source', source.identity, 3, 0, 'bad-copy', '', 1, 1)).toThrow();
      await expect(access(path.join(root, 'bad-copy'))).rejects.toMatchObject({ code: 'ENOENT' });
      const managed = await session.openPath(root, false);
      await expect(managed.copyRange('source', source.identity, 3, 0, 'bad-managed', undefined, 1, 1)).rejects.toThrow();
      await expect(access(path.join(root, 'bad-managed'))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const [name, offset, identity] of [['bad-append', 1, ''], ['bad-identity', 0, 'missing-id']] as const) {
        expect(() => native.writeRange(raw, name, 10, offset, Buffer.from('x'), identity)).toThrow();
        await expect(access(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(managed.writeRange(name, 10, offset, Buffer.from('x'), identity || undefined)).rejects.toThrow();
        await expect(access(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      native.writeFile(raw, 'target', Buffer.from('preserved'));
      await link(path.join(root, 'target'), path.join(root, 'alias'));
      expect(() => native.renameEntry(raw, 'source', raw, 'target', true)).toThrow();
      await expect(managed.renameTo('source', managed, 'target', true)).rejects.toThrow();
      expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('preserved');
      expect(await readFile(path.join(root, 'alias'), 'utf8')).toBe('preserved');
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('abc');
      await symlink(path.join(root, 'target'), path.join(root, 'linked-target'));
      expect(() => native.renameEntry(raw, 'source', raw, 'linked-target', true)).toThrow();
      expect(() => native.renameEntry(raw, 'target', raw, 'unknown-moved', false)).toThrow();
      await expect(access(path.join(root, 'unknown-moved'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Failed admission must also release its namespace lock for valid work.
      expect(native.writeRange(raw, 'valid', 10, 0, Buffer.from('x'), '')).toBe(1);
    } finally { native.close(raw); await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('excludes all namespace mutation entries across sessions and the direct bridge', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-exclusion-')));
    const first = CheckpointDirectoryHandle.createPosixSession(), second = CheckpointDirectoryHandle.createPosixSession();
    const native = nativeFixture(), raw = native.openPath(root, false);
    let unlock: (() => Promise<void>) | undefined;
    try {
      const a = await first.openPath(root, false), b = await second.openPath(root, false);
      await a.writeFile('source', Buffer.from('abc'));
      await a.writeFile('retired', Buffer.alloc(0));
      const source = await a.statFile('source'), retired = await a.statFile('retired');
      unlock = await holdNamespace(root);
      for (const directory of [a, b]) {
        const actions = [
          () => directory.openDirectory('new-directory', true),
          () => directory.writeFile('new-file', Buffer.from('x')),
          () => directory.writeAt('source', 3, 0, Buffer.from('x'), source.identity),
          () => directory.writeAt('new-at', 3, 0, Buffer.from('x')),
          () => directory.writeRange('new-range', 3, 0, Buffer.from('x')),
          () => directory.copyRange('source', source.identity, 3, 0, 'copy', undefined, 0, 3),
          () => directory.renameTo('source', directory, 'renamed'),
          () => directory.unlink('source', false),
          () => directory.removeRetired('retired', retired.identity),
          () => directory.tryLock('writer.lock'),
        ];
        for (const action of actions) await expect(action()).rejects.toMatchObject({ code: 'EBUSY' });
      }
      await expect(first.openPath(path.join(root, 'path-create'), true)).rejects.toMatchObject({ code: 'EBUSY' });
      expect(() => native.writeFile(raw, 'direct', Buffer.from('x'))).toThrow(expect.objectContaining({ code: 'EBUSY' }));
      expect(() => native.unlinkEntry(raw, 'source', false, '', source.identity)).toThrow(expect.objectContaining({ code: 'EBUSY' }));
      expect(await a.listEntries(10)).toEqual(['retired', 'source']);
      expect(await readFile(path.join(root, 'source'), 'utf8')).toBe('abc');
      await unlock(); unlock = undefined;
      const business = await a.tryLock('writer.lock');
      try {
        expect(await b.tryLock('writer.lock')).toBeUndefined();
        // An acquired business lock must not retain its creation namespace lock.
        await b.writeFile('after-business-lock', Buffer.from('x'));
      } finally { await business!(); }
    } finally { await unlock?.(); native.close(raw); await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it('releases partial rename locks on busy and deduplicates aliases of one parent', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-two-parents-')));
    const native = nativeFixture(), rootFd = native.openPath(root, false);
    const left = native.openDirectory(rootFd, 'left', true), right = native.openDirectory(rootFd, 'right', true);
    const parents = [{ fd: left, name: 'left' }, { fd: right, name: 'right' }].sort((a, b) => {
      const aa = native.identity(a.fd).split(':').map(BigInt), bb = native.identity(b.fd).split(':').map(BigInt);
      return aa[0]! < bb[0]! ? -1 : aa[0]! > bb[0]! ? 1 : aa[1]! < bb[1]! ? -1 : aa[1]! > bb[1]! ? 1 : 0;
    });
    let unlock: (() => Promise<void>) | undefined;
    try {
      native.writeFile(parents[0]!.fd, 'source', Buffer.from('low'));
      native.writeFile(parents[1]!.fd, 'source', Buffer.from('high'));
      unlock = await holdNamespace(path.join(root, parents[1]!.name));
      for (const [from, to] of [[parents[0]!, parents[1]!], [parents[1]!, parents[0]!]])
        expect(() => native.renameEntry(from!.fd, 'source', to!.fd, 'target')).toThrow(expect.objectContaining({ code: 'EBUSY' }));
      // Both attempts must have released the lower-identity partial lock.
      native.writeFile(parents[0]!.fd, 'after-busy', Buffer.from('x'));
      await unlock(); unlock = undefined;
      const alias = native.openPath(path.join(root, parents[0]!.name), false);
      try { native.renameEntry(parents[0]!.fd, 'source', alias, 'same-parent'); }
      finally { native.close(alias); }
      native.renameEntry(parents[0]!.fd, 'same-parent', parents[1]!.fd, 'cross-parent');
      expect(await readFile(path.join(root, parents[1]!.name, 'cross-parent'), 'utf8')).toBe('low');
    } finally { await unlock?.(); native.close(left); native.close(right); native.close(rootFd); await rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it('checks kind, links and identity through both public transports under namespace exclusion', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-checked-')));
    const native = nativeFixture(), raw = native.openPath(root, false);
    const session = CheckpointDirectoryHandle.createPosixSession();
    const direct = await CheckpointDirectoryHandle.openPath(root, false);
    try {
      native.writeFile(raw, 'victim', Buffer.from('original'));
      const original = native.statFile(raw, 'victim');
      native.renameEntry(raw, 'victim', raw, 'preserved');
      native.writeFile(raw, 'victim', Buffer.from('replacement'));
      expect(() => native.unlinkEntry(raw, 'victim', false, '', original.identity)).toThrow();
      expect(await readFile(path.join(root, 'victim'), 'utf8')).toBe('replacement');
      await link(path.join(root, 'preserved'), path.join(root, 'hard'));
      expect(() => native.unlinkEntry(raw, 'preserved', false, '', original.identity)).toThrow();
      await symlink(path.join(root, 'victim'), path.join(root, 'link'));
      expect(() => native.unlinkEntry(raw, 'link', false, '', native.statFile(raw, 'victim').identity)).toThrow();
      const folder = native.openDirectory(raw, 'folder', true), identity = native.identity(folder);
      native.close(folder);
      expect(() => native.unlinkEntry(raw, 'folder', false, '', identity)).toThrow();
      expect(() => native.unlinkEntry(raw, 'folder', true, '', 'wrong')).toThrow();
      native.unlinkEntry(raw, 'folder', true, '', identity);
      await expect(access(path.join(root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' });
      const current = native.statFile(raw, 'victim');
      expect(() => native.unlinkEntry(raw, 'victim', false, current.identity, '')).toThrow();
      const managed = await session.openPath(root, false);
      await expect(managed.unlink('victim', false, 'wrong')).rejects.toThrow();
      await expect(direct.unlink('victim', false, 'wrong')).rejects.toThrow();
      await managed.unlink('victim', false, current.identity);
      await expect(access(path.join(root, 'victim'))).rejects.toMatchObject({ code: 'ENOENT' });
      native.writeFile(raw, 'retired', Buffer.alloc(0));
      native.unlinkEntry(raw, 'retired', false, native.statFile(raw, 'retired').identity, '');
      expect(await readFile(path.join(root, 'hard'), 'utf8')).toBe('original');
    } finally { await direct.close(); native.close(raw); await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['write', 'lock-retry'])('does not dispatch %s against a directory fd reused after close', async kind => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-reuse-')));
    const replacement = path.join(root, 'replacement');
    await mkdir(replacement);
    const directory = await CheckpointDirectoryHandle.openPath(root, false);
    const fdKey = Object.getOwnPropertySymbols(directory).find(key => key.description === 'checkpoint-child-handle')!;
    const originalFd = Number((directory as unknown as Record<symbol, bigint>)[fdKey]);
    const reused: number[] = [];
    let release: (() => Promise<void>) | undefined;
    try {
      if (kind === 'lock-retry') release = await directory.tryLock('pending');
      const operation = (kind === 'write'
        ? directory.writeFile('pending', Buffer.from('wrong directory'))
        : directory.waitLock('pending', 2000)).catch(error => error as Error);
      // Let native waitLock enter its contended timer, then close its parent.
      if (kind === 'lock-retry') await new Promise(resolve => setImmediate(resolve));
      const closing = directory.close();
      for (let count = 0; count < 16 && !reused.includes(originalFd); count++)
        reused.push(openSync(replacement, constants.O_RDONLY | constants.O_DIRECTORY));
      expect(reused).toContain(originalFd);
      expect(await operation).toMatchObject({ message: expect.stringContaining('closed') });
      await closing;
      await expect(access(path.join(replacement, 'pending'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await directory.close(); await release?.();
      for (const fd of reused) closeSync(fd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('supports editable writes, bounded append copies, physical inventory and atomic replacement', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-native-')));
    const session = CheckpointDirectoryHandle.createPosixSession();
    try {
      const directory = await session.openPath(root, false);
      expect(await directory.availableDiskBytes()).toBeGreaterThanOrEqual(0);
      const first = await directory.writeAt('source', 100, 0, Buffer.from('abcdef'));
      const changed = await directory.writeAt('source', 100, 2, Buffer.from('XY'), first.identity);
      expect(changed.identity).toBe(first.identity);
      expect(Number.isSafeInteger(changed.allocatedBytes)).toBe(true);
      expect(changed.allocatedBytes).toBeGreaterThanOrEqual(0);
      expect(changed.bytes).toBe(6);
      expect(await directory.readFile('source', 6, 0, 6, first.identity)).toEqual(Buffer.from('abXYef'));
      await expect(directory.writeAt('source', 100, 0, Buffer.from('bad'))).rejects.toThrow();
      await expect(directory.writeAt('source', 100, 0, Buffer.from('bad'), 'wrong')).rejects.toThrow();
      const target = await directory.copyRange('source', first.identity, 6, 1, 'target', undefined, 0, 3);
      await expect(directory.copyRange('source', first.identity, 6, 0, 'target', target.identity, 2, 1)).rejects.toThrow();
      await directory.copyRange('source', first.identity, 6, 4, 'target', target.identity, 3, 2);
      expect(await directory.readFile('target', 5, 0, 5, target.identity)).toEqual(Buffer.from('bXYef'));
      await directory.writeFile('next', Buffer.from('replacement'));
      await expect(directory.renameTo('next', directory, 'target')).rejects.toThrow();
      await directory.renameTo('next', directory, 'target', true);
      expect(await readFile(path.join(root, 'target'), 'utf8')).toBe('replacement');
      await directory.close();
    } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('pins directory handles across rename and rejects links and read-only writes', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-boundary-')));
    const session = CheckpointDirectoryHandle.createPosixSession();
    try {
      const directory = await session.openPath(root, false);
      const original = await directory.openDirectory('original', true);
      await original.writeFile('kept', Buffer.from('old'));
      await rename(path.join(root, 'original'), path.join(root, 'moved'));
      const replacement = await directory.openDirectory('original', true);
      await replacement.writeFile('kept', Buffer.from('new'));
      expect(await original.readFile('kept', 3, 0, 3)).toEqual(Buffer.from('old'));
      await symlink(path.join(root, 'moved'), path.join(root, 'redirect'));
      await expect(directory.openDirectory('redirect', false)).rejects.toThrow();
      await symlink(path.join(root, 'moved', 'kept'), path.join(root, 'link'));
      await expect(directory.statEntry('link')).rejects.toThrow();
      await link(path.join(root, 'moved', 'kept'), path.join(root, 'hard'));
      await expect(directory.statEntry('hard')).rejects.toThrow();
      const readOnly = await session.openPath(root, false, true);
      await expect(readOnly.writeFile('forbidden', Buffer.alloc(0))).rejects.toThrow();
      const child = await readOnly.openDirectory('original', false);
      await expect(child.writeAt('forbidden', 1, 0, Buffer.from('x'))).rejects.toThrow();
    } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('pages without retaining a whole inventory and releases locks on close', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-page-')));
    const first = CheckpointDirectoryHandle.createPosixSession();
    const second = CheckpointDirectoryHandle.createPosixSession();
    try {
      const a = await first.openPath(root, false), b = await second.openPath(root, false);
      for (let index = 0; index < 75; index++) await writeFile(path.join(root, `entry-${index}`), 'x');
      const names: string[] = [];
      while (true) {
        const page = await a.listEntryPage(names.length, 32);
        expect(page.names.length).toBeLessThanOrEqual(32);
        names.push(...page.names);
        if (page.end) break;
      }
      expect(new Set(names).size).toBe(75);
      expect(await a.listEntryPage(75, 32)).toEqual({ names: [], end: true });
      expect(await a.tryLock('owner.lock')).toBeTypeOf('function');
      expect(await b.tryLock('owner.lock')).toBeUndefined();
      await first.close();
      const unlock = await b.tryLock('owner.lock');
      expect(unlock).toBeTypeOf('function'); await unlock!();
      await expect(a.statEntry('entry-0')).rejects.toThrow();
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });
});
