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

  async run<T>(task: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await runHoldingMaintenanceExclusion(task);
    } finally {
      release();
    }
  }
}
