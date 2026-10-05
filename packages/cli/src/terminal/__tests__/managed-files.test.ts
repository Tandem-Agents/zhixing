import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DeviceCapacityStepPermit } from '@zhixing/core/resources';
import { TerminalManagedFiles } from '../managed-files.js';
import type { CheckpointFilesystemSession } from '@zhixing/mesh/filesystem';

const fixtures: { root: string; files: TerminalManagedFiles }[] = [];
const step: DeviceCapacityStepPermit = { claim() {}, complete() {} };
afterEach(async () => {
  for (const { root, files } of fixtures.splice(0)) {
    await files.close();
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('zhixing-terminal-file-race-')) throw Error('Invalid fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zhixing-terminal-file-race-'));
  await mkdir(path.join(root, 'input')); await mkdir(path.join(root, 'outside'));
  const files = new TerminalManagedFiles(root); fixtures.push({ root, files });
  return { root, files };
}
describe.skipIf(process.platform !== 'win32')('terminal pinned input and display files', () => {
  it('keeps writes, reads and removal on the owned directory after its path becomes a junction', async () => {
    const { root, files } = await setup();
    const first = await files.write('input/owned', Buffer.from('first'), 0, 5, step);
    await rename(path.join(root, 'input'), path.join(root, 'held-input'));
    await writeFile(path.join(root, 'outside', 'owned'), 'outside-preserved');
    await symlink(path.join(root, 'outside'), path.join(root, 'input'), 'junction');
    await files.write('input/owned', Buffer.from('-second'), 5, 12, step, first.identity);
    expect((await files.read('input/owned', 12, 0, 12, first.identity, step)).toString()).toBe('first-second');
    await files.unlink('input/owned', first.identity, step);
    expect(await readFile(path.join(root, 'outside', 'owned'), 'utf8')).toBe('outside-preserved');
    await expect(readFile(path.join(root, 'held-input', 'owned'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a substituted leaf for reads, writes and deletion without changing either file', async () => {
    const { root, files } = await setup();
    const original = await files.write('input/owned', Buffer.from('original'), 0, 8, step);
    await rename(path.join(root, 'input', 'owned'), path.join(root, 'input', 'retired'));
    await writeFile(path.join(root, 'input', 'owned'), 'unknown!');
    await expect(files.write('input/owned', Buffer.from('changed!'), 0, 8, step, original.identity)).rejects.toThrow();
    await expect(files.read('input/owned', 8, 0, 8, original.identity, step)).rejects.toThrow();
    await expect(files.unlink('input/owned', original.identity, step)).rejects.toThrow();
    expect(await readFile(path.join(root, 'input', 'owned'), 'utf8')).toBe('unknown!');
    expect(await readFile(path.join(root, 'input', 'retired'), 'utf8')).toBe('original');
  });
});

describe('terminal complete file-operation queue', () => {
  it('keeps reserve, physical work and settlement in one shared queue and drains before close', async () => {
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const close = vi.fn(async (_remaining: number) => { events.push('closed'); });
    const files = new TerminalManagedFiles('/unused', undefined, { close } as unknown as CheckpointFilesystemSession);
    const first = files.runOperation(async () => {
      events.push('first-reserve'); await blocked; events.push('first-write'); events.push('first-settle');
      await expect(files.runOperation(async () => {})).rejects.toThrow('admission');
    });
    const second = files.runOperation(async () => { events.push('second-reserve'); events.push('second-settle'); });
    await Promise.resolve(); expect(events).toEqual(['first-reserve']);
    const closing = files.close(Date.now() + 1000);
    await expect(files.runOperation(async () => {})).rejects.toThrow('admission');
    expect(close).not.toHaveBeenCalled(); release();
    await Promise.all([first, second, closing]);
    expect(events).toEqual(['first-reserve', 'first-write', 'first-settle', 'second-reserve', 'second-settle', 'closed']);
    expect(close.mock.calls[0]![0]).toBeLessThanOrEqual(1000);
  });

  it('reports deadline expiry without pretending pending business settlement completed', async () => {
    let release!: () => void;
    const close = vi.fn(async (_remaining: number) => {});
    const files = new TerminalManagedFiles('/unused', undefined, { close } as unknown as CheckpointFilesystemSession);
    let settled = false;
    const work = files.runOperation(async () => { await new Promise<void>(resolve => { release = resolve; }); settled = true; });
    await Promise.resolve();
    await expect(files.close(Date.now() + 10)).rejects.toThrow('unconfirmed');
    expect(close).toHaveBeenCalledWith(0); expect(settled).toBe(false);
    release(); await work;
  });

  it('revokes an operation scope even when its callback throws synchronously', async () => {
    const close = vi.fn(async () => {});
    const files = new TerminalManagedFiles('/unused', undefined, { close } as unknown as CheckpointFilesystemSession);
    let late!: () => void;
    const attempted = new Promise<unknown>(resolve => {
      void files.runOperation(() => {
        const resume = new Promise<void>(done => { late = done; });
        void resume.then(async () => {
          try { await files.read('input/owned', 1, 0, 1, 'fixture', step); resolve('unexpected read'); }
          catch (error) { resolve(error); }
        });
        throw Error('synchronous owner failure');
      }).catch(() => {});
    });
    await Promise.resolve();
    await files.close(); late();
    expect(await attempted).toMatchObject({ message: 'terminal-files-closed' });
    expect(close).toHaveBeenCalledOnce();
  });
});
