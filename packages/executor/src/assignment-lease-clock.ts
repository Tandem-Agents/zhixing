import {
  AuthorityStorageError,
  type AuthorityCommitLog,
  type DurableProjectionMutation,
  type DurableProjectionReadContext,
} from "@zhixing/core/authority";
import { assertProtocolIdentifier } from "@zhixing/core/protocol";

/** Executor-owned time; projections may be discarded, elapsed time may not. */
export class AssignmentLeaseClock {
  #time: number;
  #monotonic: number;

  constructor(readonly wall: () => string, readonly monotonic: () => number) {
    this.#time = leaseTime(wall());
    this.#monotonic = this.#readMonotonic();
  }

  now(durableFloor: number): number {
    const monotonic = this.#readMonotonic();
    if (monotonic < this.#monotonic) throw new TypeError("Lease monotonic clock regressed");
    this.#time = Math.max(leaseTime(this.wall()), durableFloor,
      this.#time + monotonic - this.#monotonic);
    this.#monotonic = monotonic;
    // Preserve sub-millisecond elapsed time internally across frequent guards.
    return Math.floor(this.#time);
  }

  #readMonotonic(): number {
    const value = this.monotonic();
    if (!Number.isFinite(value) || value < 0) throw new TypeError("Lease monotonic clock is invalid");
    return value;
  }
}

export function leaseTime(value: unknown): number {
  if (typeof value !== "string") throw new TypeError("Lease time must be canonical ISO time");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError("Lease time must be canonical ISO time");
  }
  return time;
}

export function leaseClockStream(executorId: string): string {
  return `executor:${executorId}:assignment-lease-clock`;
}

export function leaseClockRecord(executorId: string, time: number) {
  return { stream: leaseClockStream(executorId), body: {
    v: 1 as const, t: "assignment-lease-time-frontier" as const,
    executorId, frontier: new Date(time).toISOString(),
  } };
}

export function readLeaseClockRecord(body: unknown, executorId: string): number {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("Executor lease time frontier is invalid");
  }
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "executorId,frontier,t,v" ||
      value.v !== 1 || value.t !== "assignment-lease-time-frontier" || value.executorId !== executorId) {
    throw new TypeError("Executor lease time frontier identity is invalid");
  }
  return leaseTime(value.frontier);
}

const LEASE_CLOCK_KEY = "c";
const LEASE_CLOCK_REDUCER_VERSION = 1;

/** 执行端当前的租约时钟：只前进的前沿，以及是否已启用生效时间写法。 */
export interface LeaseClockSummary {
  readonly frontier: number;
  readonly activated: boolean;
}

export function leaseClockProjectionId(executorId: string): string {
  assertProtocolIdentifier(executorId, "Lease clock executor id");
  return `executor-lease-clock-v1:${executorId}`;
}

/**
 * 当前租约时钟的持久投影，按执行端各一份。时钟记录贯穿整段历史，单个分派的重放不再读它：
 * 前沿只前进、启用生效时间写法之后不再接受旧写法，这两条跨分派的规则在写入时由这里校验，
 * 决定时按同一位置读出当前前沿。
 */
export function registerLeaseClockProjection(log: AuthorityCommitLog, executorId: string) {
  const clock = leaseClockStream(executorId);
  return log.durableProjection({
    projectionId: leaseClockProjectionId(executorId),
    reducerVersion: LEASE_CLOCK_REDUCER_VERSION,
    authenticated: true,
    inputs: { families: ["assignment:"], streams: [clock] },
    reduce: async (envelope, current): Promise<readonly DurableProjectionMutation[]> => {
      const before = await readLeaseClockSummary(current);
      let summary = before;
      // 与分派重放相同的顺序：同一信封里时钟记录在分派记录之前
      for (const entry of envelope.entries) {
        if (entry.stream === clock) {
          const next = readLeaseClockRecord(entry.body, executorId);
          if (next < summary.frontier) throw invalidLeaseClock("Executor lease time frontier regressed");
          summary = { frontier: next, activated: true };
        } else if (entry.stream.startsWith("assignment:")) {
          const body = (entry.body as { readonly body?: { readonly t?: unknown; readonly v?: unknown } } | null)?.body;
          if ((body?.t === "received" || body?.t === "control-lease-renewed") && body.v !== 3 && summary.activated) {
            throw invalidLeaseClock("Legacy lease writer cannot append after effective-time activation");
          }
        }
      }
      return summary === before ? [] : [{ kind: "put", key: LEASE_CLOCK_KEY, value: { ...summary } }];
    },
  });
}

export async function readLeaseClockSummary(view: Pick<DurableProjectionReadContext, "get">): Promise<LeaseClockSummary> {
  const value = await view.get(LEASE_CLOCK_KEY) as { readonly frontier?: unknown; readonly activated?: unknown } | undefined;
  if (value === undefined) return { frontier: 0, activated: false };
  if (typeof value.frontier !== "number" || !Number.isSafeInteger(value.frontier) || value.frontier < 0 || value.activated !== true) {
    throw invalidLeaseClock("Executor lease clock summary is invalid");
  }
  return { frontier: value.frontier, activated: true };
}

function invalidLeaseClock(message: string): AuthorityStorageError {
  return new AuthorityStorageError("invalid-authority-record", message);
}
