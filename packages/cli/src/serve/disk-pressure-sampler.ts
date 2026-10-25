import { Worker } from "node:worker_threads";

/**
 * 磁盘余量样本由独立线程同步采样，写进共享内存，主线程在准入时同步读取。
 * 样本新鲜度因此只取决于采样线程：主线程被占满、事件循环延迟或共享 I/O 线程池排队时，
 * 样本照样按周期更新；文件系统无响应也只卡住采样线程，从不阻塞主线程。
 * 采样线程只访问运行目录所在的文件系统，权威日志也依赖它；关闭时通知它停下。
 */

/**
 * 共享单元的位置：写入期间序号为奇数；完成时刻取进程内单调时钟（纳秒）；状态 0 无样本、1 有样本、2 失败；
 * 等待者为正时，采样线程每次写入后发一条消息唤醒主线程。
 */
const SEQUENCE = 0, STAMP = 1, AVAILABLE_BLOCKS = 2, BLOCK_SIZE = 3, STATE = 4, ACTIVITIES = 5, STOP = 6, WAITERS = 7;
const CELLS = 8;

export interface DiskSamplerOptions {
  readonly root: string;
  readonly activityDriven: boolean;
  readonly periodMs: number;
}

/** 启动一份采样，持续写入给定的共享单元；有等待者时每次写入后调用 sampled。返回的 stop 让它停下。 */
export type DiskSamplerStarter = (cells: BigInt64Array, options: DiskSamplerOptions, sampled: () => void) => { stop(): void };

export interface DiskSample { readonly bavail: number; readonly bsize: number }

/** 写入一次采样结果（undefined 表示这次采样失败）。采样线程与测试中的替身共用这一布局。 */
export function writeDiskSample(cells: BigInt64Array, sample: DiskSample | undefined): void {
  Atomics.add(cells, SEQUENCE, 1n);
  if (sample) {
    Atomics.store(cells, AVAILABLE_BLOCKS, BigInt(sample.bavail));
    Atomics.store(cells, BLOCK_SIZE, BigInt(sample.bsize));
  }
  Atomics.store(cells, STATE, sample ? 1n : 2n);
  Atomics.store(cells, STAMP, process.hrtime.bigint());
  Atomics.add(cells, SEQUENCE, 1n);
}

/** 已完成的采样次数（每次写入序号加 2）。 */
export function diskSampleCount(cells: BigInt64Array): number {
  return Number(Atomics.load(cells, SEQUENCE) / 2n);
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { statfsSync } = require("node:fs");
const path = require("node:path");
const { cells, root, activityDriven, periodMs } = workerData;
const write = (sample) => {
  Atomics.add(cells, ${SEQUENCE}, 1n);
  if (sample) { Atomics.store(cells, ${AVAILABLE_BLOCKS}, BigInt(sample.bavail)); Atomics.store(cells, ${BLOCK_SIZE}, BigInt(sample.bsize)); }
  Atomics.store(cells, ${STATE}, sample ? 1n : 2n);
  Atomics.store(cells, ${STAMP}, process.hrtime.bigint());
  Atomics.add(cells, ${SEQUENCE}, 1n);
  if (Atomics.load(cells, ${WAITERS}) > 0n) parentPort.postMessage(0);
};
const sample = () => {
  let current = path.resolve(root);
  for (;;) {
    try { return statfsSync(current); } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== "ENOENT" || parent === current) return undefined;
      current = parent;
    }
  }
};
while (Atomics.load(cells, ${STOP}) === 0n) {
  if (activityDriven && Atomics.load(cells, ${ACTIVITIES}) === 0n) { Atomics.wait(cells, ${ACTIVITIES}, 0n, 1000); continue; }
  write(sample());
  Atomics.wait(cells, ${STOP}, 0n, periodMs);
}
`;

/** 采样线程意外退出或起不来之后，隔这么久再起一次。 */
const RESTART_DELAY_MS = 1_000;

/**
 * 生产采样：一个独立线程。线程起不来或意外退出时样本停止更新，过期后准入按不可用处理；
 * 随后重新起线程，不留下永久不可用。
 */
export const threadDiskSampler: DiskSamplerStarter = (cells, options, sampled) => {
  let stopped = false;
  let worker: Worker | undefined;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const later = (): void => {
    if (stopped) return;
    restart = setTimeout(spawn, RESTART_DELAY_MS);
    restart.unref();
  };
  const spawn = (): void => {
    restart = undefined;
    if (stopped) return;
    let current: Worker;
    try {
      current = new Worker(WORKER_SOURCE, { eval: true, workerData: { cells, ...options } });
    } catch {
      later();
      return;
    }
    worker = current;
    current.unref();
    current.on("message", sampled);
    current.on("error", () => { /* 退出事件里重启 */ });
    current.on("exit", () => { if (worker === current) { worker = undefined; later(); } });
  };
  spawn();
  return {
    stop() {
      stopped = true;
      clearTimeout(restart);
      Atomics.store(cells, STOP, 1n);
      Atomics.notify(cells, STOP);
      Atomics.notify(cells, ACTIVITIES);
      void worker?.terminate().catch(() => undefined);
      worker = undefined;
    },
  };
};

/** 同步仲裁所用的磁盘余量来源：样本超过 250ms 即视为不可用。 */
export function diskPressure(root: string, activityDriven: boolean, starter: DiskSamplerStarter = threadDiskSampler) {
  const maxAgeNs = 250_000_000n, periodMs = 50;
  const cells = new BigInt64Array(new SharedArrayBuffer(CELLS * BigInt64Array.BYTES_PER_ELEMENT));
  const listeners = new Set<() => void>();
  let sampler: { stop(): void } | undefined;
  let closed = false;
  let activities = 0;
  const sampled = (): void => { for (const listener of [...listeners]) listener(); };
  const start = (): void => {
    if (sampler || closed) return;
    try { sampler = starter(cells, { root, activityDriven, periodMs }, sampled); } catch { /* 采样起不来：临时空间一直不可用 */ }
  };
  const setActivities = (value: number): void => {
    activities = value;
    Atomics.store(cells, ACTIVITIES, BigInt(value));
    Atomics.notify(cells, ACTIVITIES);
  };
  const current = (): DiskSample | undefined => {
    if (closed) return undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = Atomics.load(cells, SEQUENCE);
      if (before % 2n !== 0n) continue;
      const state = Atomics.load(cells, STATE), stamp = Atomics.load(cells, STAMP);
      const bavail = Atomics.load(cells, AVAILABLE_BLOCKS), bsize = Atomics.load(cells, BLOCK_SIZE);
      if (Atomics.load(cells, SEQUENCE) !== before) continue;
      if (state !== 1n || process.hrtime.bigint() - stamp >= maxAgeNs) return undefined;
      return { bavail: Number(bavail), bsize: Number(bsize) };
    }
    return undefined;
  };
  if (!activityDriven) start();
  return {
    cells,
    retainActivity: (): (() => void) => {
      if (closed) return () => {};
      setActivities(activities + 1);
      start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        setActivities(activities - 1);
      };
    },
    close: (): void => {
      closed = true;
      sampler?.stop();
      sampler = undefined;
      sampled();
    },
    read: (): DiskSample => {
      const sample = current();
      if (!sample) throw Error("设备磁盘探测尚未就绪");
      return sample;
    },
    /** 有等待额度时，至多等 250ms 让下一次采样落定，样本一到即返回；零等待只看此刻。 */
    prepare: (maxWaitMs: number, abort: AbortSignal): Promise<void> => {
      if (current() || abort.aborted || closed || maxWaitMs === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          abort.removeEventListener("abort", done);
          if (listeners.delete(check)) Atomics.sub(cells, WAITERS, 1n);
          resolve();
        };
        const check = (): void => { if (closed || current()) done(); };
        const timer = setTimeout(done, Math.min(250, maxWaitMs));
        abort.addEventListener("abort", done, { once: true });
        listeners.add(check);
        Atomics.add(cells, WAITERS, 1n);
        check();
      });
    },
  };
}
