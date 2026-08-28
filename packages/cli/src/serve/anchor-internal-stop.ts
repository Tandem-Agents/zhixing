import type { StopStrategy } from "@zhixing/core/protocol";

export interface AnchorInternalStopRequest {
  readonly reason: string;
  readonly strategy: StopStrategy;
}

export interface AnchorInternalStopPort {
  requestStop(request: AnchorInternalStopRequest): Promise<void>;
}

export interface AnchorInternalStopDependencies {
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

/**
 * Joins all Anchor-internal stop sources at one durable HostStop identity.
 * The first request freezes the reason/strategy; a failed attempt can only
 * replay that exact request, while a successful attempt triggers shutdown once.
 */
export function createAnchorInternalStopPort(
  dependencies: AnchorInternalStopDependencies,
): AnchorInternalStopPort {
  let claimed: Readonly<AnchorInternalStopRequest> | undefined;
  let inFlight: Promise<void> | undefined;
  let shutdownTriggered = false;

  return Object.freeze({
    requestStop(request: AnchorInternalStopRequest): Promise<void> {
      const frozen = claimed ?? Object.freeze({ ...request });
      claimed = frozen;
      if (shutdownTriggered) return Promise.resolve();
      if (inFlight) return inFlight;

      const attempt = (async () => {
        await dependencies.prepare({
          requestId: dependencies.requestId,
          reason: frozen.reason,
          strategy: frozen.strategy,
          timeoutMs: dependencies.timeoutMs,
        });
        if (shutdownTriggered) return;
        await dependencies.requestShutdown(frozen.reason);
        shutdownTriggered = true;
      })();
      inFlight = attempt;
      void attempt.then(
        () => {
          if (inFlight === attempt) inFlight = undefined;
        },
        () => {
          if (inFlight === attempt) inFlight = undefined;
        },
      );
      return attempt;
    },
  });
}
