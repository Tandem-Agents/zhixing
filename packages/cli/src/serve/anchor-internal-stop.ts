import type { StopStrategy } from "@zhixing/core/protocol";

export interface AnchorInternalStopRequest {
  readonly reason: string;
  readonly strategy: StopStrategy;
}

export interface AnchorInternalStopPort {
  requestStop(request: AnchorInternalStopRequest): Promise<void>;
}

export interface AnchorInternalStopGeneration {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prepare: (request: {
    readonly requestId: string;
    readonly reason: string;
    readonly strategy: StopStrategy;
    readonly timeoutMs: number;
  }) => Promise<unknown>;
  readonly requestShutdown: (reason: string) => void | Promise<void>;
}

export interface AnchorInternalStopGenerationLease {
  release(): void;
}

interface InstalledAnchorInternalStopGeneration {
  readonly generation: Readonly<AnchorInternalStopGeneration>;
  claimed?: Readonly<AnchorInternalStopRequest>;
  inFlight?: Promise<void>;
  shutdownTriggered: boolean;
}

/**
 * Joins all Anchor-internal stop sources at one durable HostStop identity.
 * The first request freezes the reason/strategy; a failed attempt can only
 * replay that exact request, while a successful attempt triggers shutdown once.
 */
export class AnchorInternalStopLifecycle {
  readonly port: AnchorInternalStopPort;
  #current: InstalledAnchorInternalStopGeneration | undefined;
  #closed = false;
  #retiredBeforeActivation = false;

  constructor() {
    this.port = Object.freeze({
      requestStop: (request: AnchorInternalStopRequest) => this.#requestStop(request),
    });
  }

  install(
    generation: AnchorInternalStopGeneration,
  ): AnchorInternalStopGenerationLease {
    if (this.#closed) throw new Error("Anchor internal stop lifecycle is closed");
    if (this.#retiredBeforeActivation) {
      throw new Error("This device has completed local retirement and cannot start normally");
    }
    if (this.#current) {
      throw new Error("Anchor internal stop generation is already installed");
    }
    const installed: InstalledAnchorInternalStopGeneration = {
      generation: Object.freeze({ ...generation }),
      shutdownTriggered: false,
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

  assertServerStartAllowed(): void {
    if (this.#retiredBeforeActivation) {
      throw new Error("This device has completed local retirement and cannot start normally");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#current = undefined;
  }

  #requestStop(request: AnchorInternalStopRequest): Promise<void> {
    const installed = this.#current;
    if (!installed) {
      if (
        !this.#closed &&
        request.reason === "device-removed" &&
        request.strategy === "immediate"
      ) {
        // Device retirement can complete while Mesh startup recovery is still
        // ahead of Server binding. This is a terminal pre-activation outcome,
        // not a deferred stop request: the caller later refuses Server startup.
        this.#retiredBeforeActivation = true;
        return Promise.resolve();
      }
      return Promise.reject(new Error("Anchor internal stop is not ready"));
    }

    const frozen = installed.claimed ?? Object.freeze({ ...request });
    installed.claimed = frozen;
    if (installed.shutdownTriggered) return Promise.resolve();
    if (installed.inFlight) return installed.inFlight;

    const attempt = (async () => {
      const generation = installed.generation;
      await generation.prepare({
        requestId: generation.requestId,
        reason: frozen.reason,
        strategy: frozen.strategy,
        timeoutMs: generation.timeoutMs,
      });
      if (installed.shutdownTriggered) return;
      await generation.requestShutdown(frozen.reason);
      installed.shutdownTriggered = true;
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
