import { runHoldingMaintenanceExclusion } from "../resources/maintenance-context.js";

/**
 * 串行执行队列。
 *
 * 队列体是互斥区:在里面等待任何外部资源,这段等待会原样加到后面每一个排队者
 * 身上。维护准入的"处于互斥区必须零等待"因此由建立互斥的这里单点标记,不由
 * 各调用点各自声明——每个调用点自己判断,就会分叉成已标记、硬编码零等待、
 * 完全没标记三种写法。背压由各自的队列外重试承担。
 */
export class SerialTaskQueue {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    if (signal) {
      let abort!: () => void;
      try {
        await Promise.race([predecessor, new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new DOMException("Queue wait cancelled", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        })]);
        signal.throwIfAborted();
      } catch (error) {
        // Leave a cancelled placeholder behind the predecessor. Releasing it
        // immediately would let a later operation overtake the current owner.
        void predecessor.then(release, release);
        throw error;
      } finally { signal.removeEventListener("abort", abort); }
    } else await predecessor;
    try {
      return await runHoldingMaintenanceExclusion(task);
    } finally {
      release();
    }
  }
}
