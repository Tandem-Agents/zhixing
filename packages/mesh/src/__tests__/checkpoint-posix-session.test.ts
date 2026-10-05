import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkpointFilesystemCompletion, ownedPosixFilesystem, POSIX_FILESYSTEM_LIMITS } from '../checkpoint-posix-session.js';

function fixture(autoExit = true) {
  const sent: { id: number; op: string }[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    ref: vi.fn(), unref: vi.fn(),
    kill: vi.fn((_signal?: NodeJS.Signals) => {
      if (autoExit) queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    }),
  });
  child.stdin.on('data', data => sent.push(JSON.parse(data.toString())));
  const factory = vi.fn(() => child);
  return { child, sent, factory, reply: (value: unknown, ok = true) => child.stdout.write(`${JSON.stringify({ id: sent.at(-1)!.id, ok, ...(ok ? { value } : value as object) })}\n`) };
}

afterEach(() => vi.useRealTimers());

describe('owned POSIX filesystem transport (host-independent)', () => {
  it('fences a late artifact verification without creating a late owner', async () => {
    let verified!: (path: string) => void;
    const f = fixture();
    const owner = ownedPosixFilesystem(5000, () => new Promise(resolve => { verified = resolve; }), f.factory);
    const request = owner.request('openPath', { path: '/fixture', create: false, readOnly: false }).catch(error => error);
    let closed = false;
    const closing = owner.stop().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    verified('/fixture/addon.node');
    await closing;
    expect(await request).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_CLOSED' });
    expect(f.factory).not.toHaveBeenCalled();
    expect(owner.failed()).toBe(true);
  });

  it('bounds admission while verification is pending, before any child writes', async () => {
    const f = fixture();
    let verified!: (path: string) => void;
    const owner = ownedPosixFilesystem(5000, () => new Promise(resolve => { verified = resolve; }), f.factory);
    const pending = Array.from({ length: POSIX_FILESYSTEM_LIMITS.requests }, () => owner.request('identity', { handle: 1 }).catch(error => error));
    await expect(owner.request('identity', { handle: 1 })).rejects.toMatchObject({ code: 'ERR_CHECKPOINT_CAPACITY' });
    expect(f.sent).toHaveLength(0);
    const closing = owner.stop(); verified('/fixture/addon.node');
    await closing; await Promise.all(pending);
  });

  it('serializes actual writes and preserves operation errors without retrying', async () => {
    const f = fixture();
    const owner = ownedPosixFilesystem(5000, async () => '/fixture/addon.node', f.factory);
    const first = owner.request('statEntry', { parent: 1, name: 'one' }).catch(error => error);
    const second = owner.request('identity', { handle: 1 });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    f.reply({ code: 'EIO', error: 'unconfirmed write' }, false);
    expect(await first).toMatchObject({ code: 'EIO', message: 'unconfirmed write' });
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    f.reply('1:2');
    expect(await second).toBe('1:2');
    expect(f.factory.mock.calls[0]).toEqual([process.execPath, expect.arrayContaining(['--input-type=commonjs', '--eval', '/fixture/addon.node'])]);
    expect(owner.failed()).toBe(false);
    await owner.stop();
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('limits queued encoded bytes independently of request count', async () => {
    const f = fixture();
    let verified!: (path: string) => void;
    const owner = ownedPosixFilesystem(5000, () => new Promise(resolve => { verified = resolve; }), f.factory);
    const data = Buffer.alloc(800 * 1024).toString('base64');
    const pending = owner.request('writeFile', { parent: 1, name: 'first', data }).catch(error => error);
    await expect(owner.request('writeFile', { parent: 1, name: 'second', data })).rejects.toMatchObject({ code: 'ERR_CHECKPOINT_CAPACITY' });
    expect(f.factory).not.toHaveBeenCalled();
    const closing = owner.stop(); verified('/fixture/addon.node');
    await closing; await pending;
  });

  it('rejects oversized UTF-8 root paths before starting the owner', async () => {
    const f = fixture();
    const owner = ownedPosixFilesystem(5000, async () => '/fixture/addon.node', f.factory);
    await expect(owner.request('openPath', { path: 'x'.repeat(32769), create: false, readOnly: false }))
      .rejects.toMatchObject({ code: 'ERR_CHECKPOINT_CAPACITY' });
    await expect(owner.request('openPath', { path: '\u4e2d'.repeat(12000), create: false, readOnly: false }))
      .rejects.toMatchObject({ code: 'ERR_CHECKPOINT_CAPACITY' });
    expect(f.factory).not.toHaveBeenCalled();
    await owner.stop();
  });

  it('does not report a timeout effect as settled before actual helper close', async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    const owner = ownedPosixFilesystem(50, async () => '/fixture/addon.node', f.factory);
    let settled = false;
    const result = owner.request('writeAt', {}).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(50);
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    f.child.emit('close', null, 'SIGKILL');
    expect(await result).toMatchObject({ code: 'ETIMEDOUT' });
    await owner.stop();
  });

  it('fails bounded close when termination is unconfirmed, keeping late requests fenced', async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    const owner = ownedPosixFilesystem(5000, async () => '/fixture/addon.node', f.factory);
    const pending = owner.request('writeAt', {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const closing = owner.stop().catch(error => error);
    await vi.advanceTimersByTimeAsync(POSIX_FILESYSTEM_LIMITS.closeMs);
    expect(await closing).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    expect(await pending).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    let physicalDone = false;
    const completion = checkpointFilesystemCompletion(await pending)!;
    expect(completion).toBeInstanceOf(Promise);
    void completion.then(() => { physicalDone = true; });
    await Promise.resolve(); expect(physicalDone).toBe(false);
    await expect(owner.request('identity', { handle: 1 })).rejects.toThrow();
    f.child.emit('close', null, 'SIGKILL');
    await completion; expect(physicalDone).toBe(true);
    expect(f.factory).toHaveBeenCalledOnce();
  });

  it.each(['frame', 'identity', 'stderr'])('fences %s protocol violations and waits for actual close', async kind => {
    const f = fixture(false);
    const owner = ownedPosixFilesystem(5000, async () => '/fixture/addon.node', f.factory);
    let settled = false;
    const result = owner.request('identity', { handle: 1 }).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    if (kind === 'frame') f.child.stdout.write(Buffer.alloc(POSIX_FILESYSTEM_LIMITS.frameBytes + 1, 65));
    else if (kind === 'identity') f.child.stdout.write('{"id":999,"ok":true}\n');
    else f.child.stderr.write(Buffer.alloc(64 * 1024 + 1));
    await Promise.resolve();
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    f.child.emit('close', null, 'SIGKILL');
    expect(await result).toMatchObject({ code: 'ERR_CHILD_PROCESS_PROTOCOL' });
    await owner.stop();
  });

  it('clamps repeated close to the containing deadline without renewing it', async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    const owner = ownedPosixFilesystem(5000, async () => '/fixture/addon.node', f.factory);
    const pending = owner.request('writeAt', {}).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const first = owner.stop(500).catch(error => error);
    const second = owner.stop(20).catch(error => error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    expect(await second).toBe(await first);
    expect(f.child.kill).toHaveBeenCalledOnce();
    await pending;
    f.child.emit('close', null, 'SIGKILL');
  });

  it('does not report a still-running artifact verification as successful cleanup', async () => {
    vi.useFakeTimers();
    let verified!: (path: string) => void;
    const f = fixture();
    const owner = ownedPosixFilesystem(5000, () => new Promise(resolve => { verified = resolve; }), f.factory);
    const request = owner.request('identity', { handle: 1 }).catch(error => error);
    const closing = owner.stop(20).catch(error => error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await closing).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    expect(await request).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    let completed = false;
    const physical = checkpointFilesystemCompletion(await request)!;
    void physical.then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    verified('/fixture/addon.node');
    await vi.advanceTimersByTimeAsync(0);
    await physical; expect(completed).toBe(true);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('runs blocking primitive work outside the parent loop and kills its real helper', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-transport-'));
    const addon = path.join(directory, 'fixture.cjs');
    // This is a transport fixture, not native/POSIX filesystem validation.
    await writeFile(addon, `module.exports = {
      openPath() { return 9n; },
      identity() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); return 'late'; },
      close() {}
    };`);
    const owner = ownedPosixFilesystem(5000, async () => addon);
    try {
      const handle = await owner.request<number>('openPath', { path: '/fixture', create: false, readOnly: false });
      const blocked = owner.request('identity', { handle }).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 30));
      await owner.stop();
      expect(await blocked).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_CLOSED' });
      expect(owner.failed()).toBe(true);
    } finally { await owner.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 10_000);

  it('rejects exhausted handle admission before native namespace side effects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'checkpoint-posix-capacity-'));
    const addon = path.join(directory, 'fixture.cjs'), marker = path.join(directory, 'side-effect');
    await writeFile(addon, `const fs = require('node:fs'); let fd = 0n;
      const create = () => { fs.writeFileSync(${JSON.stringify(marker)}, 'created'); return ++fd; };
      module.exports = {
        openPath(path, creating) { return creating ? create() : ++fd; },
        openDirectory: create, tryLock: create, tryReadLock: create, close() {}
      };`);
    const owner = ownedPosixFilesystem(5000, async () => addon);
    try {
      for (let index = 0; index < POSIX_FILESYSTEM_LIMITS.handles; index++)
        await owner.request('openPath', { path: '/fixture', create: false, readOnly: false });
      for (const [op, input] of [
        ['openPath', { path: '/fixture-new', create: true, readOnly: false }],
        ['openDirectory', { parent: 1, name: 'new', create: true }],
        ['tryLock', { parent: 1, name: 'new.lock' }],
        ['waitLock', { parent: 1, name: 'new.lock', waitMs: 10, shared: false }],
      ] as const) await expect(owner.request(op, input)).rejects.toThrow('capacity exhausted');
      // The new native candidate must not implicitly enable public deletion.
      await expect(owner.request('unlinkEntry', { parent: 1, name: 'preserved', directory: false, expectedIdentity: '1:2' }))
        .rejects.toMatchObject({ code: 'ENOTSUP' });
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await owner.request('close', { handle: 1 });
      await owner.request('openPath', { path: '/fixture-new', create: true, readOnly: false });
      await access(marker);
    } finally { await owner.stop(); await rm(directory, { recursive: true, force: true }); }
  }, 10_000);
});
