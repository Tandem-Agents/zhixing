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
