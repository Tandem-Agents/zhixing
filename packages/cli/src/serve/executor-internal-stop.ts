import type { StopStrategy } from "@zhixing/core/protocol";

export interface ExecutorInternalStopRequest {
  readonly reason: string;
  readonly strategy: StopStrategy;
}

export interface ExecutorInternalStopPort {
  requestStop(request: ExecutorInternalStopRequest): Promise<void>;
}

export interface ExecutorInternalStopDependencies {
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

/**
 * Joins Executor-internal stop sources at one durable HostStop identity and
 * does not report success until the real Server terminal is observable.
 */
export function createExecutorInternalStopPort(
  dependencies: ExecutorInternalStopDependencies,
): ExecutorInternalStopPort {
  let claimed: Readonly<ExecutorInternalStopRequest> | undefined;
  let inFlight: Promise<void> | undefined;
  let terminal = false;

  return Object.freeze({
    requestStop(request: ExecutorInternalStopRequest): Promise<void> {
      const frozen = claimed ?? Object.freeze({ ...request });
      claimed = frozen;
      if (terminal) return Promise.resolve();
      if (inFlight) return inFlight;

      const attempt = (async () => {
        await dependencies.prepare({
          requestId: dependencies.requestId,
          reason: frozen.reason,
          strategy: frozen.strategy,
          timeoutMs: dependencies.timeoutMs,
        });
        await dependencies.shutdown(frozen.reason);
        await dependencies.waitForShutdown();
        terminal = true;
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
