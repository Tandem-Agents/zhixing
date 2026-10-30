import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannelRetiredError } from '@zhixing/terminal-ui/channel';
import type { LogRecordPort } from '@zhixing/core/logging';
const ports = vi.hoisted(() => ({ open: vi.fn(), worker: undefined as undefined | ((...args: unknown[]) => unknown) }));
vi.mock('node:fs/promises', () => ({ open: ports.open }));
// 默认用真实核验线程；个别用例换成可控替身，模拟崩溃、挂起与延迟回报
vi.mock('node:worker_threads', async original => {
  const actual = await original<typeof import('node:worker_threads')>();
  return { ...actual, Worker: function (this: unknown, ...args: unknown[]) {
    return ports.worker ? ports.worker(...args) : new (actual.Worker as unknown as new (...input: unknown[]) => unknown)(...args);
  } };
});
import { EventEmitter } from 'node:events';
import { verifyTerminalAssets } from '../verify-assets.js';
import { deriveTerminalChunkTable, readTerminalChunkTables } from '../chunk-table.js';

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
const CHUNK = 1024 * 1024;
// 每块内容不同：任何错序或漏块都会让摘要失配
function multiChunk(chunks: number, tail = 1234) {
  const bytes = Buffer.alloc(chunks * CHUNK + tail);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + Math.floor(i / CHUNK) * 7) & 0xff;
  return bytes;
}
function artifactOf(name: string, bytes: Buffer) { return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
/** 多块文件由它自己的线程按句柄 fd 读：给真实临时文件的 fd；stat 报清单声明的大小，close 才真正关闭。 */
function fileHandle(bytes: Buffer, declared = bytes.length) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-assets-')), file = path.join(dir, 'artifact');
  fs.writeFileSync(file, bytes);
  const fd = fs.openSync(file, 'r');
  return {
    fd,
    stat: vi.fn(async () => ({ size: declared })),
    read: vi.fn(async () => { throw Error('multi-chunk files are read by their own thread'); }),
    close: vi.fn(async () => { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

/** 可控的核验线程替身：记录 workerData；answer 按真实线程的语义回报 fd 上每个区间的摘要。 */
class FakeFileWorker extends EventEmitter {
  terminated = false; exited = false;
  readonly exit = Promise.withResolvers<number>();
  constructor(readonly workerData: { fd: number; ranges: [number, number][]; chunk: number }, readonly holdExit = false) { super(); }
  answer() {
    const digests = this.workerData.ranges.map(([start, length]) => {
      const bytes = Buffer.alloc(length);
      fs.readSync(this.workerData.fd, bytes, 0, length, start);
      return createHash('sha256').update(bytes).digest('hex');
    });
    this.emit('message', { digests, reads: 1, readMs: 0, hashMs: 0 });
  }
  /** 线程真正退出：先发 exit 事件，terminate 随之兑现。 */
  release() { if (this.exited) return; this.exited = true; this.emit('exit', 1); this.exit.resolve(1); }
  terminate() { this.terminated = true; if (!this.holdExit) queueMicrotask(() => this.release()); return this.exit.promise; }
}
function fakeWorkers(create: (fake: FakeFileWorker) => void, holdExit = false) {
  const created: FakeFileWorker[] = [];
  ports.worker = (_script: unknown, options: unknown) => {
    const fake = new FakeFileWorker((options as { workerData: FakeFileWorker['workerData'] }).workerData, holdExit);
    created.push(fake); create(fake); return fake;
  };
  return created;
}

describe('fixed terminal artifact admission', () => {
  beforeEach(() => { vi.clearAllMocks(); ports.worker = undefined; });
  it('hashes a multi-chunk file on its own thread through the verified handle with the complete SHA-256', async () => {
    const bytes = multiChunk(3), file = fileHandle(bytes), failure = vi.fn(); ports.open.mockResolvedValue(file);
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure)).resolves.toBeUndefined();
    expect(file.read).not.toHaveBeenCalled(); expect(file.close).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
    const wrong = { ...artifactOf('ui', bytes), sha256: createHash('sha256').update(multiChunk(3, 1233)).digest('hex') };
    ports.open.mockResolvedValue(fileHandle(bytes));
    await expect(verifyTerminalAssets('fixture', [wrong], ['ui'], () => {}, failure)).rejects.toThrow('terminal-package-integrity');
    expect(failure).toHaveBeenCalledOnce();
  });
  it('gives each multi-chunk file its own bounded thread on the handle it verified', async () => {
    const first = multiChunk(2), second = multiChunk(3, 77), files = new Map([['ui', fileHandle(first)], ['dll', fileHandle(second)]]);
    ports.open.mockImplementation(async (target: string) => files.get(path.basename(target)));
    const created = fakeWorkers(fake => queueMicrotask(() => fake.answer()));
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', first), artifactOf('dll', second)], ['ui', 'dll'], () => {}, () => {})).resolves.toBeUndefined();
    expect(created.map(fake => fake.workerData).sort((a, b) => a.ranges[0]![1] - b.ranges[0]![1])).toEqual([
      { fd: files.get('ui')!.fd, ranges: [[0, first.length]], chunk: CHUNK }, { fd: files.get('dll')!.fd, ranges: [[0, second.length]], chunk: CHUNK }]);
    expect(created.every(fake => fake.terminated && fake.exited)).toBe(true);
  });
  it('fails a file whose thread exits without a result and still closes its handle', async () => {
    const bytes = multiChunk(2), file = fileHandle(bytes), failure = vi.fn(); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(fake => queueMicrotask(() => fake.release()));
    const result = await verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure).catch(error => error);
    expect(String(result)).toMatch(/terminal-asset-hash-worker-exited/);
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce(); expect(created[0]!.exited).toBe(true);
  });
  it('closes the handle and returns only after the thread has actually exited, not on its result', async () => {
    const bytes = multiChunk(1), file = fileHandle(bytes); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(fake => queueMicrotask(() => fake.answer()), true);
    let settled = false;
    const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, () => {}).finally(() => { settled = true; });
    await vi.waitFor(() => expect(created[0]?.terminated).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 20));
    // 线程仍在读这个 fd 时不得关闭句柄
    expect(file.close).not.toHaveBeenCalled(); expect(settled).toBe(false);
    created[0]!.release(); await expect(result).resolves.toBeUndefined();
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('turns an abort during hashing into cancellation without reporting an integrity failure', async () => {
    const bytes = multiChunk(2), file = fileHandle(bytes), failure = vi.fn(), abort = new AbortController(); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(() => { /* 挂起：不回报 */ });
    const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, abort.signal).catch(error => error);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    abort.abort();
    expect(await result).toBeInstanceOf(TerminalChannelRetiredError);
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled(); expect(created[0]!.terminated).toBe(true);
  });
  it('does not let a pending digest of one file hide another file’s integrity failure', async () => {
    const bytes = multiChunk(2), large = fileHandle(bytes), small = handle(), failure = vi.fn();
    ports.open.mockImplementation(async (target: string) => path.basename(target) === 'ui' ? large : small);
    // 大文件的摘要晚到：小文件的失败先发生
    const created = fakeWorkers(fake => setTimeout(() => fake.answer(), 20));
    const broken = { ...artifact('small'), sha256: '0'.repeat(64) };
    const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes), broken], ['ui', 'small'], () => {}, failure).catch(error => error);
    expect(String(await result)).toMatch(/terminal-package-integrity/);
    expect(large.close).toHaveBeenCalledOnce(); expect(small.close).toHaveBeenCalledOnce(); expect(created[0]!.exited).toBe(true);
  });
  it.each(['worker-error', 'abort'] as const)('settles a thread failure without an unhandled rejection (%s)', async kind => {
    const bytes = multiChunk(2), file = fileHandle(bytes), failure = vi.fn(), abort = new AbortController(); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(() => { /* 挂起：不回报 */ });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, abort.signal).catch(error => error);
      await vi.waitFor(() => expect(created).toHaveLength(1));
      const crash = Error('hash thread crashed');
      if (kind === 'worker-error') { created[0]!.emit('error', crash); created[0]!.release(); } else abort.abort();
      const outcome = await result;
      if (kind === 'worker-error') { expect(outcome).toBe(crash); expect(failure).toHaveBeenCalledExactlyOnceWith(crash); }
      else { expect(outcome).toBeInstanceOf(TerminalChannelRetiredError); expect(failure).not.toHaveBeenCalled(); }
      expect(file.close).toHaveBeenCalledOnce(); expect(created[0]!.terminated || created[0]!.exited).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it.each(['abort', 'completed'] as const)('carries a refused termination (%s) into the file result and closes the handle only after the later actual exit', async kind => {
    const bytes = multiChunk(2), file = fileHandle(bytes), abort = new AbortController(); ports.open.mockResolvedValue(file);
    const stopFailed = Error('terminate failed');
    // 终止请求被拒，线程此刻并未退出：exit 由用例稍后才发
    const created = fakeWorkers(fake => {
      if (kind === 'completed') queueMicrotask(() => fake.answer());
      fake.terminate = () => { fake.terminated = true; return Promise.reject(stopFailed); };
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, () => {}, undefined, abort.signal).catch(error => error);
      await vi.waitFor(() => expect(created).toHaveLength(1));
      if (kind === 'abort') abort.abort();
      expect(await result).toBe(stopFailed);
      // 线程仍可能在读这个 fd：结果已结算，但句柄不得关闭
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(created[0]!.exited).toBe(false); expect(file.close).not.toHaveBeenCalled();
      created[0]!.release();
      await vi.waitFor(() => expect(file.close).toHaveBeenCalledOnce());
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it('rejects a file shorter than its manifest inside its thread without leaking the handle or the thread', async () => {
    const bytes = multiChunk(2), file = fileHandle(bytes.subarray(0, CHUNK + 10), bytes.length), failure = vi.fn(); ports.open.mockResolvedValue(file);
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure)).rejects.toThrow('terminal-package-integrity');
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
  });
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

describe('fixed terminal artifact admission with a chunk table', () => {
  beforeEach(() => { vi.clearAllMocks(); ports.worker = undefined; });
  // 块尺寸取 1 MiB：7 块（含不足一块的尾块）分给至多 4 个线程
  const tableFor = (name: string, bytes: Buffer) => readTerminalChunkTables([deriveTerminalChunkTable(artifactOf(name, bytes), bytes, CHUNK)], [artifactOf(name, bytes)]);
  async function realThreadsRecordingRanges() {
    const actual = await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads');
    const ranges: [number, number][][] = [];
    ports.worker = (script: unknown, options: unknown) => {
      ranges.push((options as { workerData: { ranges: [number, number][] } }).workerData.ranges);
      return new actual.Worker(script as string, options as ConstructorParameters<typeof actual.Worker>[1]);
    };
    return ranges;
  }

  it('covers every byte exactly once with at most four real threads over contiguous chunk ranges', async () => {
    const bytes = multiChunk(6, 999), file = fileHandle(bytes), failure = vi.fn(), record = vi.fn(); ports.open.mockResolvedValue(file);
    const ranges = await realThreadsRecordingRanges();
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure,
      { record } as unknown as LogRecordPort, undefined, tableFor('ui', bytes))).resolves.toBeUndefined();
    expect(ranges).toHaveLength(4);
    // 各线程的区间首尾相接、从 0 起恰好覆盖全部字节
    let next = 0;
    for (const [start, length] of ranges.flat()) { expect(start).toBe(next); next = start + length; }
    expect(next).toBe(bytes.length);
    expect(file.read).not.toHaveBeenCalled(); expect(file.close).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
    const timing = record.mock.calls.find(([item]) => item.event === 'terminalAssetVerification')![0];
    expect(timing.data).toMatchObject({ threads: 4, bytes: bytes.length, reads: 7 });
  });

  it('keeps the whole call within the four-thread budget when a tableless multi-chunk file is verified alongside', async () => {
    const ui = multiChunk(6, 999), dll = multiChunk(2, 55), files = new Map([['ui', fileHandle(ui)], ['dll', fileHandle(dll)]]);
    ports.open.mockImplementation(async (target: string) => files.get(path.basename(target)));
    const ranges = await realThreadsRecordingRanges();
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', ui), artifactOf('dll', dll)], ['ui', 'dll'], () => {}, () => {},
      undefined, undefined, tableFor('ui', ui))).resolves.toBeUndefined();
    // 无表的 dll 一个线程整文件，ui 分到余下三个
    expect(ranges).toHaveLength(4);
    expect(ranges.filter(group => group.length === 1 && group[0]![0] === 0 && group[0]![1] === dll.length)).toHaveLength(1);
    expect(files.get('ui')!.close).toHaveBeenCalledOnce(); expect(files.get('dll')!.close).toHaveBeenCalledOnce();
  });

  it('fails when a single byte inside any chunk differs from its table and still settles every thread and the handle', async () => {
    const bytes = multiChunk(6, 999), tampered = Buffer.from(bytes); tampered[4 * CHUNK + 17]! ^= 1;
    const file = fileHandle(tampered), failure = vi.fn(); ports.open.mockResolvedValue(file);
    await realThreadsRecordingRanges();
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, undefined, tableFor('ui', bytes)))
      .rejects.toThrow('terminal-package-integrity');
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
  });

  it('rejects a short file inside the threads without leaking the handle', async () => {
    const bytes = multiChunk(6, 999), file = fileHandle(bytes.subarray(0, 3 * CHUNK), bytes.length), failure = vi.fn(); ports.open.mockResolvedValue(file);
    await realThreadsRecordingRanges();
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, undefined, tableFor('ui', bytes)))
      .rejects.toThrow('terminal-package-integrity');
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
  });

  it('on abort terminates every thread and closes the handle only after all of them have exited', async () => {
    const bytes = multiChunk(6, 999), file = fileHandle(bytes), failure = vi.fn(), abort = new AbortController(); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(() => { /* 挂起：不回报 */ }, true);
    let settled = false;
    const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, abort.signal, tableFor('ui', bytes))
      .catch(error => error).finally(() => { settled = true; });
    await vi.waitFor(() => expect(created).toHaveLength(4));
    abort.abort();
    await vi.waitFor(() => expect(created.every(fake => fake.terminated)).toBe(true));
    for (const fake of created.slice(0, 3)) fake.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    // 还有一个线程没退出：句柄不得关闭，结果不得兑现
    expect(file.close).not.toHaveBeenCalled(); expect(settled).toBe(false);
    created[3]!.release();
    expect(await result).toBeInstanceOf(TerminalChannelRetiredError);
    expect(file.close).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
  });

  it('reports one crashed thread as the file failure and still stops the other threads before closing', async () => {
    const bytes = multiChunk(6, 999), file = fileHandle(bytes), failure = vi.fn(); ports.open.mockResolvedValue(file);
    const created = fakeWorkers(fake => { if (fake.workerData.ranges[0]![0] !== 0) queueMicrotask(() => fake.answer()); });
    const result = verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, undefined, tableFor('ui', bytes)).catch(error => error);
    await vi.waitFor(() => expect(created).toHaveLength(4));
    const crash = Error('hash thread crashed');
    created[0]!.emit('error', crash); created[0]!.release();
    expect(await result).toBe(crash); expect(failure).toHaveBeenCalledExactlyOnceWith(crash);
    expect(created.every(fake => fake.exited)).toBe(true); expect(file.close).toHaveBeenCalledOnce();
  });

  it('treats a table that does not bind the manifest entry it is applied to as a manifest failure', async () => {
    const bytes = multiChunk(6, 999), file = fileHandle(bytes), failure = vi.fn(); ports.open.mockResolvedValue(file);
    const foreign = tableFor('ui', multiChunk(6, 998));
    await expect(verifyTerminalAssets('fixture', [artifactOf('ui', bytes)], ['ui'], () => {}, failure, undefined, undefined, foreign))
      .rejects.toThrow('terminal-package-manifest');
    expect(ports.open).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledOnce();
    await file.close();
  });
});
