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
      return await task();
    } finally {
      release();
    }
  }
}
