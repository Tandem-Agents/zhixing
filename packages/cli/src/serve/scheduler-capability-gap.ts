/** Recoverable scheduler selection gap with the capability snapshot revision observed. */
export class SchedulerCapabilityGapError extends Error {
  readonly capabilityRevision: number;

  constructor(message: string, capabilityRevision: number) {
    super(message);
    this.name = "SchedulerCapabilityGapError";
    this.capabilityRevision = capabilityRevision;
  }
}
