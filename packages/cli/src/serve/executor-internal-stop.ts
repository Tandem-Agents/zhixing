import type { StopStrategy } from "@zhixing/core/protocol";

export interface ExecutorInternalStopRequest {
  readonly reason: string;
  readonly strategy: StopStrategy;
}

export interface ExecutorInternalStopPort {
  requestStop(request: ExecutorInternalStopRequest): Promise<void>;
}

export interface ExecutorInternalStopGeneration {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prepare: (request: {
    readonly requestId: string;
    readonly reason: string;
    readonly strategy: StopStrategy;
    readonly timeoutMs: number;
  }) => Promise<unknown>;
  readonly shutdown: (reason: string) => void | Promise<void>;
  readonly waitForShutdown: () => Promise<void>;
}

export interface ExecutorInternalStopGenerationLease {
  release(): void;
}

interface InstalledExecutorInternalStopGeneration {
  readonly generation: Readonly<ExecutorInternalStopGeneration>;
  claimed?: Readonly<ExecutorInternalStopRequest>;
  inFlight?: Promise<void>;
  terminal: boolean;
}

/**
 * Joins Executor-internal stop sources at one durable HostStop identity and
 * does not report success until the real Server terminal is observable.
 */
export class ExecutorInternalStopLifecycle {
  readonly port: ExecutorInternalStopPort;
  readonly #notReadyMessage: string;
  #current: InstalledExecutorInternalStopGeneration | undefined;
  #closed = false;

  constructor(options: { readonly notReadyMessage?: string } = {}) {
    this.#notReadyMessage = options.notReadyMessage ?? "Executor internal stop is not ready";
    this.port = Object.freeze({
      requestStop: (request: ExecutorInternalStopRequest) => this.#requestStop(request),
    });
  }

  install(
    generation: ExecutorInternalStopGeneration,
  ): ExecutorInternalStopGenerationLease {
    if (this.#closed) throw new Error("Executor internal stop lifecycle is closed");
    if (this.#current) {
      throw new Error("Executor internal stop generation is already installed");
    }
    const installed: InstalledExecutorInternalStopGeneration = {
      generation: Object.freeze({ ...generation }),
      terminal: false,
    };
    this.#current = installed;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        if (this.#current === installed) this.#current = undefined;
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#current = undefined;
  }

  #requestStop(request: ExecutorInternalStopRequest): Promise<void> {
    const installed = this.#current;
    if (!installed) {
      return Promise.reject(new Error(this.#notReadyMessage));
    }

    const frozen = installed.claimed ?? Object.freeze({ ...request });
    installed.claimed = frozen;
    if (installed.terminal) return Promise.resolve();
    if (installed.inFlight) return installed.inFlight;

    const attempt = (async () => {
      const generation = installed.generation;
      await generation.prepare({
        requestId: generation.requestId,
        reason: frozen.reason,
        strategy: frozen.strategy,
        timeoutMs: generation.timeoutMs,
      });
      await generation.shutdown(frozen.reason);
      await generation.waitForShutdown();
      installed.terminal = true;
    })();
    installed.inFlight = attempt;
    void attempt.then(
      () => {
        if (installed.inFlight === attempt) installed.inFlight = undefined;
      },
      () => {
        if (installed.inFlight === attempt) installed.inFlight = undefined;
      },
    );
    return attempt;
  }
}

export interface ExecutorIdleSnapshot {
  readonly localConnectionCount: number;
  readonly currentAnchorConnected: boolean;
  readonly hasLocalAcceptedWork: boolean;
  readonly hasRemoteAcceptedWork: boolean;
}

/** Executor-only on-demand hosts exit only when every real presence/work source is absent. */
export function shouldExecutorIdleExit(snapshot: ExecutorIdleSnapshot): boolean {
  return snapshot.localConnectionCount === 0 &&
    !snapshot.currentAnchorConnected &&
    !snapshot.hasLocalAcceptedWork &&
    !snapshot.hasRemoteAcceptedWork;
}
