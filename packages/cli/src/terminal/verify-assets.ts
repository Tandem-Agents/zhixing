import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { TerminalChannelRetiredError } from '@zhixing/terminal-ui/channel';
import { beginLogPhase, type LogRecordPort } from '@zhixing/core/logging';
import type { TerminalChunk, TerminalChunkTable } from './chunk-table.js';

interface Artifact { readonly name: string; readonly bytes: number; readonly sha256: string }

const CHUNK = 1024 * 1024;
/**
 * S 的固定制品核验线程总上限，每个线程只持有一个 1 MiB 缓冲。同一次调用内按文件分配：没有块表的多块文件各一个，
 * 有块表的文件平分余下的（每个至少一个）。S 并行调用的两组里只有界面组含多块文件（恢复组的文件都在 1 MiB 内），
 * 生产组合为 ui.exe 三个、opentui.dll 一个。
 */
const VERIFY_THREADS = 4;

// 多块文件的核验线程：经主线程已打开并核过大小的同一句柄（fd），按给定区间（[起点, 长度]）依次顺序读完、
// 每个区间各算一个 SHA-256，一次回报全部摘要。不按路径打开文件，不接触 home、秘密或业务；短读按完整性失败回报。
// 时刻一律取 timeOrigin + now（跨线程可比的绝对时刻），只作观测：线程开始、读算就绪、完成，以及线程自身累计 CPU。
const FILE_HASH_WORKER = `
const startedAt = performance.timeOrigin + performance.now();
const { parentPort, workerData } = require('node:worker_threads');
const { readSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { fd, ranges, chunk } = workerData;
try {
  const readyAt = performance.timeOrigin + performance.now();
  const buffer = Buffer.allocUnsafe(chunk), digests = [];
  let reads = 0, readMs = 0, hashMs = 0;
  for (const [start, length] of ranges) {
    const hash = createHash('sha256'), end = start + length;
    for (let offset = start; offset < end;) {
      let at = performance.now();
      const read = readSync(fd, buffer, 0, Math.min(chunk, end - offset), offset);
      readMs += performance.now() - at; reads++;
      if (!read) throw Error('terminal-package-integrity');
      at = performance.now(); hash.update(buffer.subarray(0, read)); hashMs += performance.now() - at;
      offset += read;
    }
    digests.push(hash.digest('hex'));
  }
  const cpu = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : undefined;
  parentPort.postMessage({ digests, reads, readMs, hashMs, startedAt, readyAt, finishedAt: performance.timeOrigin + performance.now(),
    cpuMs: cpu ? (cpu.user + cpu.system) / 1000 : undefined });
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message || error) });
}
`;

/** 线程的观测分段（毫秒）：创建到线程开始、开始到读算就绪、完成到主线程收到回报、线程累计 CPU；缺失记 0。 */
interface FileThreadTiming { readonly startMs: number; readonly setupMs: number; readonly returnMs: number; readonly cpuMs: number }
interface RangeDigests { readonly digests: readonly string[]; readonly reads: number; readonly readMs: number; readonly hashMs: number; readonly thread: FileThreadTiming }

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const now = () => performance.timeOrigin + performance.now();

/** 一个核验线程，负责一组区间。线程报错、无结果退出或被关闭时 result 失败；close 返回时线程已真正退出。 */
class FileArtifactHasher {
  readonly result: Promise<RangeDigests>;
  readonly #worker: Worker;
  readonly #exited: Promise<void>;
  /** 线程实际退出时兑现（从不拒绝）；读它句柄的寿命以此为准，而不是以终止请求是否成功为准。 */
  get exited(): Promise<void> { return this.#exited; }
  #settle!: { resolve(value: RangeDigests): void; reject(error: Error): void };
  #closing: Promise<void> | undefined;

  constructor(fd: number, ranges: readonly (readonly [number, number])[]) {
    this.result = new Promise<RangeDigests>((resolve, reject) => { this.#settle = { resolve, reject }; });
    this.result.catch(() => {});
    const createdAt = now();
    this.#worker = new Worker(FILE_HASH_WORKER, { eval: true, workerData: { fd, ranges, chunk: CHUNK } });
    this.#exited = new Promise(resolve => this.#worker.once('exit', () => { this.#settle.reject(Error('terminal-asset-hash-worker-exited')); resolve(); }));
    this.#worker.on('error', error => this.#settle.reject(error));
    this.#worker.once('message', (message: { digests?: unknown; error?: string; reads?: number; readMs?: number; hashMs?: number;
      startedAt?: number; readyAt?: number; finishedAt?: number; cpuMs?: number }) => {
      const receivedAt = now();
      const digests = message.digests;
      if (message.error !== undefined || !Array.isArray(digests) || digests.length !== ranges.length || digests.some(hex => typeof hex !== 'string')) {
        this.#settle.reject(Error(message.error ?? 'terminal-asset-hash-digest')); return;
      }
      const startedAt = finite(message.startedAt), readyAt = finite(message.readyAt), finishedAt = finite(message.finishedAt);
      this.#settle.resolve({ digests: digests as string[], reads: message.reads ?? 0, readMs: message.readMs ?? 0, hashMs: message.hashMs ?? 0, thread: {
        startMs: startedAt === undefined ? 0 : startedAt - createdAt,
        setupMs: startedAt === undefined || readyAt === undefined ? 0 : readyAt - startedAt,
        returnMs: finishedAt === undefined ? 0 : receivedAt - finishedAt,
        cpuMs: finite(message.cpuMs) ?? 0,
      } });
    });
  }

  /** reason 交给尚未兑现的结果：S 关闭时是取消；正常收尾时结果已兑现，只等线程真正退出。 */
  close(reason: Error = Error('terminal-asset-hash-worker-closed')): Promise<void> {
    return this.#closing ??= (async () => {
      this.#settle.reject(reason);
      await this.#worker.terminate();
      await this.#exited;
    })();
  }
}

/** 把连续的块分成至多 parts 组连续的块（各组块数相差至多一）。 */
function partition(chunks: readonly TerminalChunk[], parts: number): TerminalChunk[][] {
  const count = Math.min(parts, chunks.length), groups: TerminalChunk[][] = [];
  for (let index = 0; index < count; index++) {
    groups.push(chunks.slice(Math.floor(index * chunks.length / count), Math.floor((index + 1) * chunks.length / count)));
  }
  return groups;
}

/** Only S's fixed artifact groups call this. Memory: a single-chunk file uses one
 * 1MiB buffer hashed on this thread; a multi-chunk file without a chunk table is
 * read through its verified handle by one thread with one 1MiB buffer; a file with
 * a validated chunk table is covered by its share of the VERIFY_THREADS budget over
 * disjoint, contiguous chunk ranges of that same handle, each with one 1MiB buffer.
 * Failure closes admission promptly; settlement still owns every open handle and
 * thread. A handle is closed only after every thread reading it has actually
 * exited; when a termination request itself fails, that close follows the later
 * exit instead of blocking this result. */
export async function verifyTerminalAssets(
  distribution: string, artifacts: readonly Artifact[], names: readonly string[],
  assertLive: () => void, onFailure: (error: unknown) => void,
  records?: LogRecordPort, signal?: AbortSignal, chunkTables?: ReadonlyMap<string, TerminalChunkTable>,
): Promise<void> {
  const multiChunk = (name: string) => (artifacts.find(value => value.name === name)?.bytes ?? 0) > CHUNK;
  const tabled = names.filter(name => chunkTables?.has(name)).length;
  const untabledThreads = names.filter(name => !chunkTables?.has(name) && multiChunk(name)).length;
  const tableThreads = Math.max(1, Math.floor((VERIFY_THREADS - untabledThreads) / Math.max(1, tabled)));
  const results = await Promise.allSettled(names.map(async name => {
    const phase = records ? beginLogPhase(records, `terminal.verify.${name}`, { waitFor: 'fixed-artifact-io-and-hash' }) : undefined;
    const start = performance.now();
    const timing = { asset: name, durationMs: 0, openMs: 0, statMs: 0, readMs: 0, hashMs: 0, closeMs: 0, bytes: 0, reads: 0,
      threads: 0, threadStartMs: 0, threadSetupMs: 0, threadHashMs: 0, threadReturnMs: 0, threadCpuMs: 0 };
    let result: 'success' | 'failure' | 'cancelled' = 'success';
    let reported = false;
    const report = (error: unknown) => {
      if (!reported && !(error instanceof TerminalChannelRetiredError)) { reported = true; onFailure(error); }
    };
    try {
      assertLive();
      const item = artifacts.find(value => value.name === name);
      if (!item || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw Error('terminal-package-manifest');
      // 块表已由 readTerminalChunkTables 核过：绑定本制品、从 0 起连续覆盖全部字节
      const table = chunkTables?.get(name);
      if (table && (table.bytes !== item.bytes || table.sha256 !== item.sha256)) throw Error('terminal-package-manifest');
      // Multi-chunk files are read and hashed by their own threads; hashMs then records only the wait for their results.
      const local = !table && item.bytes <= CHUNK ? createHash('sha256') : undefined;
      const hashers: FileArtifactHasher[] = [];
      // S 关闭即取消：线程按取消收束，不冒充完整性失败；终止失败由本文件收尾时的同一次 close 承接，这里不逸出。
      const cancel = () => { for (const hasher of hashers) void hasher.close(new TerminalChannelRetiredError()).catch(() => {}); };
      let at = performance.now();
      const handle = await open(path.join(distribution, name), 'r').finally(() => { timing.openMs = performance.now() - at; });
      try {
        assertLive();
        at = performance.now();
        const initial = await handle.stat().finally(() => { timing.statMs += performance.now() - at; });
        if (initial.size !== item.bytes) throw Error('terminal-package-integrity');
        let matched: boolean;
        if (local) {
          const view = Buffer.alloc(CHUNK);
          let offset = 0;
          while (offset < item.bytes) {
            assertLive();
            at = performance.now(); timing.reads++;
            const { bytesRead } = await handle.read(view, 0, Math.min(CHUNK, item.bytes - offset), offset)
              .finally(() => { timing.readMs += performance.now() - at; });
            if (!bytesRead) throw Error('terminal-package-integrity');
            at = performance.now();
            local.update(view.subarray(0, bytesRead));
            timing.hashMs += performance.now() - at;
            timing.bytes += bytesRead; offset += bytesRead;
          }
          matched = local.digest('hex') === item.sha256;
        } else {
          if (signal?.aborted) throw new TerminalChannelRetiredError();
          // 有块表：按总预算分到的线程各取一段连续的块，合起来恰好覆盖全部字节；没有表：一个线程算整文件摘要
          const groups = table ? partition(table.chunks, tableThreads) : [[{ index: 0, offset: 0, length: item.bytes, sha256: item.sha256 }]];
          // 交给线程之前再核一次：全部区间从 0 起首尾相接、恰好覆盖全部字节，没有哪一段字节免于核验
          let covered = 0;
          for (const chunk of groups.flat()) {
            if (chunk.offset !== covered) throw Error('terminal-package-manifest');
            covered += chunk.length;
          }
          if (covered !== item.bytes) throw Error('terminal-package-manifest');
          for (const group of groups) hashers.push(new FileArtifactHasher(handle.fd, group.map(chunk => [chunk.offset, chunk.length] as const)));
          signal?.addEventListener('abort', cancel, { once: true });
          at = performance.now();
          const outcomes = await Promise.all(hashers.map(hasher => hasher.result)).finally(() => { timing.hashMs += performance.now() - at; });
          timing.threads = outcomes.length; timing.bytes += item.bytes;
          for (const outcome of outcomes) {
            timing.reads += outcome.reads; timing.readMs += outcome.readMs; timing.threadCpuMs += outcome.thread.cpuMs;
            timing.threadStartMs = Math.max(timing.threadStartMs, outcome.thread.startMs);
            timing.threadSetupMs = Math.max(timing.threadSetupMs, outcome.thread.setupMs);
            timing.threadHashMs = Math.max(timing.threadHashMs, outcome.hashMs);
            timing.threadReturnMs = Math.max(timing.threadReturnMs, outcome.thread.returnMs);
          }
          matched = groups.every((group, index) => group.every((chunk, position) => outcomes[index]!.digests[position] === chunk.sha256));
        }
        at = performance.now();
        const final = await handle.stat().finally(() => { timing.statMs += performance.now() - at; });
        if (final.size !== item.bytes) throw Error('terminal-package-integrity');
        if (!matched) throw Error('terminal-package-integrity');
      } catch (error) {
        report(error); throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        // 线程读的就是这个句柄：先等全部线程真正退出再关闭，fd 不会在读的途中被关闭或复用。
        const stopped = await Promise.allSettled(hashers.map(hasher => hasher.close()));
        const stopFailure = stopped.find(outcome => outcome.status === 'rejected');
        if (stopFailure?.status === 'rejected') {
          // 终止请求被拒不等于线程已退出，它可能仍在读这个 fd：本文件结果立即按终止错误结算，句柄关闭挂到全部线程
          // 实际退出之后；线程若始终不退出，fd 随 S 进程一起回收（S 原有的总关闭期限与进程树兜底），不在这里无期限等待
          void Promise.all(hashers.map(hasher => hasher.exited)).then(() => handle.close()).catch(() => {});
          throw stopFailure.reason;
        }
        at = performance.now();
        await handle.close().finally(() => { timing.closeMs = performance.now() - at; });
      }
      phase?.finish();
    } catch (error) {
      result = error instanceof TerminalChannelRetiredError ? 'cancelled' : 'failure';
      phase?.finish(result === 'cancelled' ? new DOMException('terminal-retired', 'AbortError') : error);
      report(error);
      throw error;
    } finally {
      timing.durationMs = performance.now() - start;
      try { records?.record({ event: 'terminalAssetVerification', result, data: timing }); }
      catch { /* Observation cannot change integrity or handle ownership. */ }
    }
  }));
  // Every file settled only after its own threads had actually exited and its handle had closed,
  // except a failed termination request, whose handle closes after the later actual exit.
  // Cancellation must not hide a different file's read/close/integrity failure.
  const failed = results.find(result => result.status === 'rejected' && !(result.reason instanceof TerminalChannelRetiredError))
    ?? results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
