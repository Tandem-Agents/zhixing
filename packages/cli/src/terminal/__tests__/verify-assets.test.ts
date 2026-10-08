import { createHash } from 'node:crypto';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannelRetiredError } from '@zhixing/terminal-ui/channel';
import type { LogRecordPort } from '@zhixing/core/logging';
const ports = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: ports.open }));
import { verifyTerminalAssets } from '../verify-assets.js';

const payload = Buffer.from('complete fixed artifact');
const sha256 = createHash('sha256').update(payload).digest('hex');
function artifact(name: string) { return { name, bytes: payload.length, sha256 }; }
function handle(bytes = payload) {
  return {
    stat: vi.fn(async () => ({ size: bytes.length })),
    read: vi.fn(async (buffer: Buffer, _from: number, length: number, offset: number) => {
      expect(buffer.length).toBe(1024 * 1024);
      const bytesRead = Math.min(length, bytes.length - offset);
      bytes.copy(buffer, 0, offset, offset + bytesRead); return { bytesRead };
    }),
    close: vi.fn(async () => {}),
  };
}
describe('fixed terminal artifact admission', () => {
  beforeEach(() => vi.clearAllMocks());
  it('starts every independent file before any file completes', async () => {
    const names = ['recovery', 'foreground', 'gate'], ready = Promise.withResolvers<void>();
    const contents = names.map(name => Buffer.from(name)), handles = contents.map(bytes => handle(bytes));
    const expected = names.map((name, i) => ({ name, bytes: contents[i]!.length, sha256: createHash('sha256').update(contents[i]!).digest('hex') }));
    ports.open.mockImplementation(async (file: string) => { await ready.promise; return handles[names.indexOf(path.basename(file))]; });
    const failure = vi.fn(), verifying = verifyTerminalAssets('fixture', expected, names, () => {}, failure);
    expect(ports.open).toHaveBeenCalledTimes(3);
    ready.resolve(); await verifying;
    for (const file of handles) { expect(file.read).toHaveBeenCalledOnce(); expect(file.close).toHaveBeenCalledOnce(); }
    expect(new Set(handles.map(file => file.read.mock.calls[0]![0])).size).toBe(3);
    expect(failure).not.toHaveBeenCalled();
  });
  it('reports failure promptly but waits for every actual close before settling', async () => {
    const close = Promise.withResolvers<void>(), failed = handle(), pending = handle(), failure = vi.fn();
    const error = Error('read failed'); failed.read.mockRejectedValue(error); pending.close.mockImplementation(() => close.promise);
    ports.open.mockResolvedValueOnce(failed).mockResolvedValueOnce(pending);
    let settled = false;
    const result = verifyTerminalAssets('fixture', ['a', 'b'].map(artifact), ['a', 'b'], () => {}, failure).catch(e => e).finally(() => { settled = true; });
    await vi.waitFor(() => expect(pending.close).toHaveBeenCalledOnce());
    expect(failure).toHaveBeenCalledExactlyOnceWith(error); expect(settled).toBe(false);
    close.resolve(); expect(await result).toBe(error); expect(failed.close).toHaveBeenCalledOnce();
  });
  it('does not hide a later file close failure behind earlier cancellation', async () => {
    const close = Promise.withResolvers<void>(), first = handle(), second = handle(), failure = vi.fn();
    first.read.mockRejectedValue(new TerminalChannelRetiredError()); second.close.mockImplementation(() => close.promise);
    ports.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const result = verifyTerminalAssets('fixture', ['a', 'b'].map(artifact), ['a', 'b'], () => {}, failure).catch(e => e);
    await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    const error = Error('close failed'); close.reject(error);
    expect(await result).toBe(error); expect(failure).toHaveBeenCalledExactlyOnceWith(error);
  });
  it('closes an acquired file after cancellation without reporting a new failure', async () => {
    const file = handle(), failure = vi.fn(), cancelled = new TerminalChannelRetiredError();
    const opened = Promise.withResolvers<ReturnType<typeof handle>>(); ports.open.mockReturnValue(opened.promise);
    let retired = false, settled = false;
    const verifying = verifyTerminalAssets('fixture', [artifact('a')], ['a'], () => { if (retired) throw cancelled; }, failure).catch(e => e).finally(() => { settled = true; });
    retired = true; await Promise.resolve(); expect(settled).toBe(false);
    opened.resolve(file); expect(await verifying).toBe(cancelled);
    expect(file.close).toHaveBeenCalledOnce(); expect(file.read).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  });
  it('keeps pure cancellation distinct from artifact failure', async () => {
    const cancelled = new TerminalChannelRetiredError(), failure = vi.fn();
    await expect(verifyTerminalAssets('fixture', ['a', 'b'].map(artifact), ['a', 'b'], () => { throw cancelled; }, failure)).rejects.toBe(cancelled);
    expect(ports.open).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  });
  it.each(['size', 'hash', 'short-read', 'close'] as const)('rejects %s failure without leaking the handle', async kind => {
    const file = handle(), failure = vi.fn(); ports.open.mockResolvedValue(file);
    if (kind === 'size') file.stat.mockResolvedValue({ size: payload.length + 1 });
    if (kind === 'short-read') file.read.mockResolvedValue({ bytesRead: 0 });
    if (kind === 'close') file.close.mockRejectedValue(Error('close failed'));
    const expected = artifact('a'); if (kind === 'hash') expected.sha256 = '0'.repeat(64);
    await expect(verifyTerminalAssets('fixture', [expected], ['a'], () => {}, failure)).rejects.toThrow();
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
  });
  it('records before a slow operation and keeps the actual failed close and processed bytes', async () => {
    const file = handle(), close = Promise.withResolvers<void>(), record = vi.fn();
    file.close.mockImplementation(() => close.promise); ports.open.mockResolvedValue(file);
    const result = verifyTerminalAssets('fixture', [artifact('a')], ['a'], () => {}, () => {}, { record } as unknown as LogRecordPort).catch(error => error);
    expect(record.mock.calls[0]![0].event).toBe('phaseStarted');
    await vi.waitFor(() => expect(file.close).toHaveBeenCalledOnce());
    expect(record.mock.calls.some(([item]) => item.event === 'phaseFinished')).toBe(false);
    const failed = Error('close failed'); close.reject(failed); expect(await result).toBe(failed);
    const end = record.mock.calls.find(([item]) => item.event === 'phaseFinished')![0];
    expect(end.result).toBe('failure'); expect(end.refs).toEqual(record.mock.calls[0]![0].refs);
    const timing = record.mock.calls.find(([item]) => item.event === 'terminalAssetVerification')![0];
    expect(timing.result).toBe('failure'); expect(timing.data.bytes).toBe(payload.length); expect(timing.data.reads).toBe(1);
    expect(JSON.stringify(timing)).not.toContain('fixture');
  });
  it('does not let an observation failure alter complete verification or handle closing', async () => {
    const file = handle(); ports.open.mockResolvedValue(file);
    await expect(verifyTerminalAssets('fixture', [artifact('a')], ['a'], () => {}, () => {}, {
      record() { throw Error('observer failed'); },
    } as unknown as LogRecordPort)).resolves.toBeUndefined();
    expect(file.close).toHaveBeenCalledOnce();
  });
});
