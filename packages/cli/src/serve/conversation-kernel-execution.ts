import type { SessionRuntime } from "@zhixing/owner-kernel/types";

/** Process-local execution lifetime, distinct from owner commit/cancellation. */
export class ConversationKernelExecution {
  readonly #abort = new AbortController();
  #running = false;
  #started = false;

  constructor(private readonly runtime: SessionRuntime) {}

  async *run(...[messages, options]: Parameters<SessionRuntime["run"]>): ReturnType<SessionRuntime["run"]> {
    if (this.#started) throw new Error("Conversation assignment kernel already started");
    this.#started = true;
    const signal = options?.abortSignal
      ? AbortSignal.any([this.#abort.signal, options.abortSignal])
      : this.#abort.signal;
    // Cancellation may arrive while the assignment is still being prepared.
    signal.throwIfAborted();
    this.#running = true;
    let kernel: ReturnType<SessionRuntime['run']> | undefined;
    try {
      kernel = this.runtime.run(messages, { ...options, abortSignal: signal });
      for (;;) {
        signal.throwIfAborted();
        const item = await kernel.next();
        // A pending model/runtime step can return after cancellation. Join its
        // real cleanup, but never publish that late value to the surface.
        signal.throwIfAborted();
        if (item.done) return item.value;
        yield item.value;
      }
    } finally {
      try { await kernel?.return(undefined as never); }
      finally { this.#running = false; }
    }
  }

  /** False means the existing durable cancellation must be continued later. */
  stop(): boolean {
    if (!this.#abort.signal.aborted) {
      this.#abort.abort(new DOMException("Conversation assignment cancelled", "AbortError"));
      if (this.#running) this.runtime.abort({ kind: "external", origin: "assignment-cancellation" });
    }
    return !this.#running;
  }
}
