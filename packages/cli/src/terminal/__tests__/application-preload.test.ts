import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const transports = vi.hoisted(() => ({ created: [] as EventEmitter[] }));
vi.mock('@zhixing/terminal-ui/parent-transport', () => ({
  consumeTerminalParentEndpoint: () => 3,
  TerminalParentTransport: class extends EventEmitter {
    connected = true;
    constructor() { super(); transports.created.push(this); }
    close() { this.connected = false; }
  },
}));

import { awaitTerminalPreloadRelease } from '../application-preload.js';

const INSTANCE = '00000000-0000-4000-8000-000000000001';
const directory = path.resolve('fixture-instance');
const directoryId = process.platform === 'win32' ? 'abc:0123456789abcdef' : '12:34';

function start() {
  const preload = awaitTerminalPreloadRelease(INSTANCE);
  return { ...preload, parent: transports.created.at(-1)! };
}

describe('N 受管预加载的放行', () => {
  it('只接受携带本实例目录与目录身份的放行帧', async () => {
    const { release, parent } = start();
    parent.emit('message', { type: 'terminal-preload-release', instance: INSTANCE, directory, directoryId });
    await expect(release).resolves.toEqual({ directory, directoryIdentity: directoryId });
  });

  it.each([
    ['其他帧', { type: 'hello', role: 'application' }],
    ['他人实例', { type: 'terminal-preload-release', instance: '00000000-0000-4000-8000-000000000002', directory, directoryId }],
    ['相对目录', { type: 'terminal-preload-release', instance: INSTANCE, directory: 'relative', directoryId }],
    ['身份格式不符', { type: 'terminal-preload-release', instance: INSTANCE, directory, directoryId: 'x' }],
  ])('拒绝%s，不进入应用', async (_name, message) => {
    const { release, parent } = start();
    parent.emit('message', message);
    await expect(release).rejects.toThrow('terminal-preload-release-invalid');
  });

  it('父通道在放行前断开即失败', async () => {
    const { release, parent } = start();
    parent.emit('disconnect');
    await expect(release).rejects.toThrow('terminal-preload-parent-closed');
  });

  it('入口只在放行之后才发布写者声明', () => {
    const entry = readFileSync(new URL('../../entry.ts', import.meta.url), 'utf8');
    const branch = entry.slice(entry.indexOf("process.env.ZHIXING_TERMINAL_PRELOAD === '1'"), entry.indexOf('} else if'));
    expect(branch).toContain('await preload.release');
    expect(branch.indexOf('await preload.release')).toBeLessThan(branch.indexOf('beginTerminalWriterDeclaration'));
    expect(branch.indexOf("awaitTerminalPreloadRelease")).toBeLessThan(branch.indexOf("import('./terminal/application.js')"));
  });
});
