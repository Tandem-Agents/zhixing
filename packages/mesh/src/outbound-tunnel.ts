import {
  assertSecureMeshConnection,
  type SecureMeshConnection,
} from "./session.js";
import { assertRuntimeTimerDelay } from "./runtime-time.js";

export interface OutboundTunnelRetryPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

export interface OutboundMeshTunnelOptions {
  readonly open: (signal: AbortSignal) => Promise<SecureMeshConnection>;
  readonly onConnection: (
    session: SecureMeshConnection,
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly retry?: Partial<OutboundTunnelRetryPolicy>;
  readonly stableConnectionMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/** Device-side reconnect loop; every reconnect must return a newly authenticated session. */
export class OutboundMeshTunnel {
  private readonly retry: OutboundTunnelRetryPolicy;
  private readonly stableConnectionMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: OutboundMeshTunnelOptions) {
    this.retry = {
      initialDelayMs: options.retry?.initialDelayMs ?? 250,
      maxDelayMs: options.retry?.maxDelayMs ?? 30_000,
      multiplier: options.retry?.multiplier ?? 2,
    };
    assertRuntimeTimerDelay(
      this.retry.initialDelayMs,
      "Outbound tunnel initial retry delay",
      true,
    );
    assertRuntimeTimerDelay(
      this.retry.maxDelayMs,
      "Outbound tunnel maximum retry delay",
      true,
    );
    this.stableConnectionMs = options.stableConnectionMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    if (
      this.retry.maxDelayMs < this.retry.initialDelayMs ||
      !Number.isFinite(this.retry.multiplier) ||
      this.retry.multiplier < 1
    ) {
      throw new TypeError("Invalid outbound tunnel retry policy");
    }
    if (!Number.isSafeInteger(this.stableConnectionMs) || this.stableConnectionMs < 0) {
      throw new TypeError("Stable connection interval must be a non-negative integer");
    }
    this.sleep = options.sleep ?? abortableDelay;
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let session: SecureMeshConnection | undefined;
      let connectedAt: number | undefined;
      try {
        const opened = await this.options.open(signal);
        assertSecureMeshConnection(opened);
        session = opened;
        connectedAt = this.now();
        await this.options.onConnection(session, signal);
        const aborted = await waitForCloseOrAbort(session, signal);
        if (aborted) {
          await session.close();
          break;
        }
        failures =
          this.now() - connectedAt >= this.stableConnectionMs ? 0 : failures + 1;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        if (session) await session.close(error instanceof Error ? error : undefined);
      }
      if (signal.aborted) break;
      const delayCap = Math.min(
        this.retry.maxDelayMs,
        this.retry.initialDelayMs * this.retry.multiplier ** Math.max(0, failures - 1),
      );
      const sample = this.random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
        throw new TypeError("Outbound tunnel random source must return a value in [0, 1)");
      }
      const delay = Math.floor(delayCap * sample);
      await this.sleep(delay, signal);
    }
  }
}

function waitForCloseOrAbort(
  session: SecureMeshConnection,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(aborted);
    };
    const onAbort = () => finish(true);
    signal.addEventListener("abort", onAbort, { once: true });
    void session.closed.then(() => finish(false));
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  assertRuntimeTimerDelay(delayMs, "Outbound tunnel retry delay", true);
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
