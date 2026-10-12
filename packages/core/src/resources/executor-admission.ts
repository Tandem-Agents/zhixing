/** Shared admission failures; observing a result must not load the executor runtime. */
export class ExecutorResourceBackpressureError extends Error {
  constructor(readonly maximumActiveRoots: number) {
    super(`Executor resource capacity is limited to ${maximumActiveRoots} active roots`);
    this.name = "ExecutorResourceBackpressureError";
  }
}

export class ExecutorResourceAdmissionPendingError extends Error {
  constructor(readonly reservationId: string) {
    super(`Local resource reservation ${reservationId} is waiting for fair admission`);
    this.name = "ExecutorResourceAdmissionPendingError";
  }
}

export class ExecutorResourceAdmissionExpiredError extends Error {
  constructor(readonly reservationId: string) {
    super(`Local resource reservation ${reservationId} expired while waiting for admission`);
    this.name = "ExecutorResourceAdmissionExpiredError";
  }
}
